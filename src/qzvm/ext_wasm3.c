/*
 * qzjs wasm3 Extension
 *
 * WASM runtime using wasm3 engine — pure sandbox model.
 * WASM modules have NO access to system APIs: no filesystem,
 * no network, no host functions. Only pure computation + linear memory.
 * When QZ_WITH_WASM3 is defined, uses real wasm3 engine.
 * Otherwise, provides stub JS API surface that throws on use.
 */

#include "qz_internal.h"
#include <string.h>

/* QuickJS registers getter/setter functions via JS_NewCFunction2, which takes
 * a JSCFunction* — requiring a cast from the typed getter (ctx,this_val) /
 * setter (ctx,this_val,val) signatures. The cast is safe: QuickJS dispatches
 * by the cfunc_type arg (JS_CFUNC_getter/setter), not the pointer type. */
#if defined(__GNUC__) && !defined(__clang__)
#pragma GCC diagnostic ignored "-Wcast-function-type"
#endif
#if QZ_WITH_WASM3
#include "wasm3.h"
#include "m3_env.h"
#include "m3_function.h"
#include <stdarg.h>

/* Forward declarations for error thrower helpers */
static JSValue wasm3_throw_compile_error(JSContext *ctx, const char *fmt, ...);
static JSValue wasm3_throw_link_error(JSContext *ctx, const char *fmt, ...);

/* ================================================================
 * wasm3 per-runtime state
 *
 * No file-scope mutable state: the wasm3 environment and QuickJS class IDs
 * live on qz_t (per-runtime), reached via qz_get_rt_from_ctx(ctx) or
 * qz_get_rt_from_jsrt(jsrt). See qz_internal.h.
 * ================================================================ */

/* ================================================================
 * Opaque JS object helpers — wrap wasm3 handles for GC
 * ================================================================ */

typedef struct wasm3_module_wrap_t {
    IM3Module module;
    uint8_t *wasm_buf;   /* kept alive for module lifetime */
    uint32_t wasm_buf_size;
    int loaded;          /* 1 once m3_LoadModule transferred ownership to an
                          * instance runtime; the runtime then frees the module
                          * (m3_FreeRuntime). The module finalizer frees it only
                          * when !loaded, else it would double-free/UAF. */
    /* Once loaded, the module memory is owned by the instance runtime; hold
     * a JS reference to that instance so Module.exports()/imports()/… cannot
     * dereference freed module memory after the instance is collected. */
    JSValue instance_ref;
} wasm3_module_wrap_t;

typedef struct wasm3_instance_wrap_t {
    IM3Runtime runtime;
    IM3Module module;
    JSValue module_obj;  /* keep module alive — its wasm_bytes must outlive the instance */
    JSValue import_closures;  /* array of import closure JS objects, to keep them alive */
} wasm3_instance_wrap_t;

/* Closure for a WASM exported function call — stored as CFunction opaque data */
typedef struct wasm3_func_closure_t {
    IM3Runtime runtime;
    IM3Module module;
    const char *name;
    u16 num_args;
    u16 num_rets;
    u8 *arg_types;   /* types[i]: wasm3 type for arg i */
    u8 *ret_types;   /* types[i]: wasm3 type for ret i */
    /* Keeps the instance (and its runtime) alive while the exported function
     * is referenced — calling it after the instance was collected would UAF. */
    JSValue instance_ref;
} wasm3_func_closure_t;

/* Closure for a WASM imported function — dispatches WASM calls to JS */
typedef struct wasm3_import_closure_t {
    JSContext *ctx;
    JSValue js_func;     /* the JS function to call */
    u16 num_args;
    u16 num_rets;
    u8 *arg_types;       /* WASM types for args */
    u8 *ret_types;       /* WASM types for returns */
} wasm3_import_closure_t;

/* Memory object wrap — tracks wasm3 runtime for grow() and live buffer */
typedef struct wasm3_memory_wrap_t {
    IM3Runtime runtime;
    u32 current_pages;
    u32 maximum_pages;  /* 0 = no limit */
    uint8_t *js_mem;    /* for standalone Memory (runtime==NULL), JS-owned buffer */
    size_t js_mem_size;
    /* Keeps the instance alive while the Memory object (which wraps the
     * instance's linear memory) is referenced. */
    JSValue instance_ref;
} wasm3_memory_wrap_t;

typedef struct wasm3_table_wrap_t {
    JSContext *ctx;
    u32 current_size;
    u32 maximum_size;  /* 0 = no limit */
    JSValue *elements;  /* array of JSValue, one per table slot */
} wasm3_table_wrap_t;

typedef struct wasm3_global_wrap_t {
    u8 type;           /* c_m3Type_i32, c_m3Type_i64, c_m3Type_f32, c_m3Type_f64 */
    bool is_mutable;
    M3Global *live_global;  /* for instance exports: points into wasm3 module, read live */
    /* Keeps the instance alive while the Global wrapper (whose getter reads
     * the live module global) is referenced. */
    JSValue instance_ref;
    union {
        int32_t i32;
        int64_t i64;
        float f32;
        double f64;
    } value;
} wasm3_global_wrap_t;

static void wasm3_func_closure_free(JSRuntime *rt, JSValue val);
static void wasm3_import_closure_free(JSRuntime *rt, JSValue val);
static void wasm3_memory_finalizer(JSRuntime *rt, JSValue val);
static void wasm3_table_finalizer(JSRuntime *rt, JSValue val);
static void wasm3_global_finalizer(JSRuntime *rt, JSValue val);

/* gc_mark：向 QuickJS 循环收集器暴露 opaque 内 JSValue 强边（quickjs-ng
 * mark_children 走 class gc_mark）。缺失时 module↔instance 互持环、
 * exports 闭包→instance、import closure→js_func、table elements 等边对
 * GC 不可见 → 引用环不可回收 → JS_FreeRuntime 断言 gc_obj_list 非空。
 * JS_GetOpaque 需正确 class_id（finalizer 同款）。 */
static void wasm3_module_gc_mark(JSRuntime *rt, JSValue val, JS_MarkFunc *mark_cb)
{
    qz_t *q = qz_get_rt_from_jsrt(rt);
    wasm3_module_wrap_t *w = q ? (wasm3_module_wrap_t *)JS_GetOpaque(val, q->wasm3_module_class_id) : NULL;
    if (w) JS_MarkValue(rt, w->instance_ref, mark_cb);
}

static void wasm3_instance_gc_mark(JSRuntime *rt, JSValue val, JS_MarkFunc *mark_cb)
{
    qz_t *q = qz_get_rt_from_jsrt(rt);
    wasm3_instance_wrap_t *w = q ? (wasm3_instance_wrap_t *)JS_GetOpaque(val, q->wasm3_instance_class_id) : NULL;
    if (w) {
        JS_MarkValue(rt, w->module_obj, mark_cb);
        JS_MarkValue(rt, w->import_closures, mark_cb);
    }
}

static void wasm3_func_closure_gc_mark(JSRuntime *rt, JSValue val, JS_MarkFunc *mark_cb)
{
    qz_t *q = qz_get_rt_from_jsrt(rt);
    wasm3_func_closure_t *w = q ? (wasm3_func_closure_t *)JS_GetOpaque(val, q->wasm3_func_closure_class_id) : NULL;
    if (w) JS_MarkValue(rt, w->instance_ref, mark_cb);
}

static void wasm3_import_closure_gc_mark(JSRuntime *rt, JSValue val, JS_MarkFunc *mark_cb)
{
    qz_t *q = qz_get_rt_from_jsrt(rt);
    wasm3_import_closure_t *w = q ? (wasm3_import_closure_t *)JS_GetOpaque(val, q->wasm3_import_closure_class_id) : NULL;
    if (w) JS_MarkValue(rt, w->js_func, mark_cb);
}

static void wasm3_memory_gc_mark(JSRuntime *rt, JSValue val, JS_MarkFunc *mark_cb)
{
    qz_t *q = qz_get_rt_from_jsrt(rt);
    wasm3_memory_wrap_t *w = q ? (wasm3_memory_wrap_t *)JS_GetOpaque(val, q->wasm3_memory_class_id) : NULL;
    if (w) JS_MarkValue(rt, w->instance_ref, mark_cb);
}

static void wasm3_table_gc_mark(JSRuntime *rt, JSValue val, JS_MarkFunc *mark_cb)
{
    qz_t *q = qz_get_rt_from_jsrt(rt);
    wasm3_table_wrap_t *w = q ? (wasm3_table_wrap_t *)JS_GetOpaque(val, q->wasm3_table_class_id) : NULL;
    if (w && w->elements) {
        for (u32 i = 0; i < w->current_size; i++)
            JS_MarkValue(rt, w->elements[i], mark_cb);
    }
}

static void wasm3_global_gc_mark(JSRuntime *rt, JSValue val, JS_MarkFunc *mark_cb)
{
    qz_t *q = qz_get_rt_from_jsrt(rt);
    wasm3_global_wrap_t *w = q ? (wasm3_global_wrap_t *)JS_GetOpaque(val, q->wasm3_global_class_id) : NULL;
    if (w) JS_MarkValue(rt, w->instance_ref, mark_cb);
}

static JSValue wasm3_table_length_get(JSContext *ctx, JSValueConst this_val);
static JSValue wasm3_table_get(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv);
static JSValue wasm3_table_set(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv);
static JSValue wasm3_table_grow(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv);

static JSValue wasm3_global_value_get(JSContext *ctx, JSValueConst this_val);
static JSValue wasm3_global_value_set(JSContext *ctx, JSValueConst this_val,
                                       JSValueConst val);
static JSValue wasm3_global_valueOf(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv);

static void wasm3_module_finalizer(JSRuntime *jsrt, JSValue val)
{
    qz_t *rt = qz_get_rt_from_jsrt(jsrt);
    if (!rt) return;
    wasm3_module_wrap_t *wrap = (wasm3_module_wrap_t *)JS_GetOpaque(val, rt->wasm3_module_class_id);
    if (wrap) {
        /* Free the parsed module only if it was never loaded into an instance
         * runtime. Once loaded, m3_LoadModule links it into the runtime's
         * module list and m3_FreeRuntime (instance finalizer) frees it; calling
         * m3_FreeModule here then would double-free. After a load, wrap->module
         * may already point to freed memory, so don't dereference it. */
        if (!wrap->loaded && wrap->module) {
            m3_FreeModule(wrap->module);
        }
        if (wrap->wasm_buf) {
            js_free_rt(jsrt, wrap->wasm_buf);
            wrap->wasm_buf = NULL;
        }
        wrap->module = NULL;
        JS_FreeValueRT(jsrt, wrap->instance_ref);
        js_free_rt(jsrt, wrap);
    }
}

static void wasm3_instance_finalizer(JSRuntime *jsrt, JSValue val)
{
    qz_t *rt = qz_get_rt_from_jsrt(jsrt);
    if (!rt) return;
    wasm3_instance_wrap_t *wrap = (wasm3_instance_wrap_t *)JS_GetOpaque(val, rt->wasm3_instance_class_id);
    if (wrap) {
        if (wrap->runtime) {
            m3_FreeRuntime(wrap->runtime);
            wrap->runtime = NULL;
        }
        JS_FreeValueRT(jsrt, wrap->module_obj);
        JS_FreeValueRT(jsrt, wrap->import_closures);
        js_free_rt(jsrt, wrap);
    }
}

/* ================================================================
 * Helper: build wasm3 signature string from IM3FuncType
 * Format: "return_type(arg_types)" where v=void, i=i32, I=i64, f=f32, F=f64
 * ================================================================ */

static char wasm3_type_to_sig_char(u8 type)
{
    switch (type) {
    case c_m3Type_i32: return 'i';
    case c_m3Type_i64: return 'I';
    case c_m3Type_f32: return 'f';
    case c_m3Type_f64: return 'F';
    default: return 'v';
    }
}

static char *wasm3_build_signature(IM3FuncType ftype)
{
    u16 n = ftype->numRets + ftype->numArgs + 3; /* ret + '(' + args + ')' + '\0' */
    char *sig = (char *)malloc(n);
    if (!sig) return NULL;
    int pos = 0;
    if (ftype->numRets == 0) {
        sig[pos++] = 'v';
    } else {
        for (u16 i = 0; i < ftype->numRets; i++)
            sig[pos++] = wasm3_type_to_sig_char(ftype->types[i]);
    }
    sig[pos++] = '(';
    for (u16 i = 0; i < ftype->numArgs; i++)
        sig[pos++] = wasm3_type_to_sig_char(ftype->types[ftype->numRets + i]);
    sig[pos++] = ')';
    sig[pos] = '\0';
    return sig;
}

static void wasm3_register_classes(qz_t *rt, JSContext *ctx)
{
    JSRuntime *jsrt = JS_GetRuntime(ctx);

    JS_NewClassID(jsrt, &rt->wasm3_module_class_id);
    JSClassDef module_class = {
        .class_name = "WebAssembly.Module",
        .finalizer = wasm3_module_finalizer,
        .gc_mark = wasm3_module_gc_mark,
    };
    JS_NewClass(jsrt, rt->wasm3_module_class_id, &module_class);

    JS_NewClassID(jsrt, &rt->wasm3_instance_class_id);
    JSClassDef instance_class = {
        .class_name = "WebAssembly.Instance",
        .finalizer = wasm3_instance_finalizer,
        .gc_mark = wasm3_instance_gc_mark,
    };
    JS_NewClass(jsrt, rt->wasm3_instance_class_id, &instance_class);

    JS_NewClassID(jsrt, &rt->wasm3_func_closure_class_id);
    JSClassDef func_closure_class = {
        .class_name = "WASMFuncClosure",
        .finalizer = wasm3_func_closure_free,
        .gc_mark = wasm3_func_closure_gc_mark,
    };
    JS_NewClass(jsrt, rt->wasm3_func_closure_class_id, &func_closure_class);

    JS_NewClassID(jsrt, &rt->wasm3_import_closure_class_id);
    JSClassDef import_closure_class = {
        .class_name = "WASMImportClosure",
        .finalizer = wasm3_import_closure_free,
        .gc_mark = wasm3_import_closure_gc_mark,
    };
    JS_NewClass(jsrt, rt->wasm3_import_closure_class_id, &import_closure_class);

    JS_NewClassID(jsrt, &rt->wasm3_memory_class_id);
    JSClassDef memory_class = {
        .class_name = "WebAssembly.Memory",
        .finalizer = wasm3_memory_finalizer,
        .gc_mark = wasm3_memory_gc_mark,
    };
    JS_NewClass(jsrt, rt->wasm3_memory_class_id, &memory_class);

    JS_NewClassID(jsrt, &rt->wasm3_table_class_id);
    JSClassDef table_class = {
        .class_name = "WebAssembly.Table",
        .finalizer = wasm3_table_finalizer,
        .gc_mark = wasm3_table_gc_mark,
    };
    JS_NewClass(jsrt, rt->wasm3_table_class_id, &table_class);

    JS_NewClassID(jsrt, &rt->wasm3_global_class_id);
    JSClassDef global_class = {
        .class_name = "WebAssembly.Global",
        .finalizer = wasm3_global_finalizer,
        .gc_mark = wasm3_global_gc_mark,
    };
    JS_NewClass(jsrt, rt->wasm3_global_class_id, &global_class);
}

/* ================================================================
 * Helper: extract byte buffer from ArrayBuffer or TypedArray
 * ================================================================ */

static int wasm3_extract_buffer(JSContext *ctx, JSValueConst val,
                                uint8_t **out_bytes, size_t *out_len)
{
    size_t byte_len = 0;
    uint8_t *bytes = NULL;

    if (JS_IsArrayBuffer(val)) {
        bytes = JS_GetArrayBuffer(ctx, &byte_len, val);
    } else {
        JSValue ab = JS_GetPropertyStr(ctx, val, "buffer");
        if (JS_IsException(ab) || !JS_IsArrayBuffer(ab)) {
            JS_FreeValue(ctx, ab);
            return -1;
        }
        size_t ab_len;
        uint8_t *ab_bytes = JS_GetArrayBuffer(ctx, &ab_len, ab);
        JS_FreeValue(ctx, ab);

        int64_t byte_offset = 0;
        JSValue offset_val = JS_GetPropertyStr(ctx, val, "byteOffset");
        if (!JS_IsException(offset_val)) {
            JS_ToInt64(ctx, &byte_offset, offset_val);
        }
        JS_FreeValue(ctx, offset_val);

        int64_t view_len = 0;
        JSValue len_val = JS_GetPropertyStr(ctx, val, "byteLength");
        if (!JS_IsException(len_val)) {
            JS_ToInt64(ctx, &view_len, len_val);
        }
        JS_FreeValue(ctx, len_val);

        if (byte_offset < 0 || (size_t)byte_offset + (size_t)view_len > ab_len) {
            return -1;
        }

        bytes = ab_bytes + byte_offset;
        byte_len = (size_t)view_len;
    }

    if (!bytes) return -1;
    *out_bytes = bytes;
    *out_len = byte_len;
    return 0;
}

/* ================================================================
 * WebAssembly.validate(bufferSource) -> bool
 * ================================================================ */

static JSValue wasm3_wasm_validate(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "WebAssembly.validate requires at least 1 argument");
    }

    uint8_t *bytes;
    size_t byte_len;
    if (wasm3_extract_buffer(ctx, argv[0], &bytes, &byte_len) < 0) {
        return JS_ThrowTypeError(ctx, "WebAssembly.validate: argument must be ArrayBuffer or TypedArray");
    }

    /* Validate by parsing — wasm3 doesn't have a separate validate API */
    IM3Module module = NULL;
    M3Result result = m3_ParseModule((IM3Environment)rt->wasm3_env, &module, bytes, (uint32_t)byte_len);
    if (!result && module) {
        m3_FreeModule(module);
        return JS_TRUE;
    }
    return JS_FALSE;
}

/* ================================================================
 * WebAssembly.compile(bufferSource) -> Promise<Module>
 * ================================================================ */

static JSValue wasm3_wasm_compile(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "WebAssembly.compile requires at least 1 argument");
    }

    JSValue module_ctor = JS_GetPropertyStr(ctx, this_val, "Module");
    JSValue result = JS_CallConstructor(ctx, module_ctor, 1, argv);
    JS_FreeValue(ctx, module_ctor);

    if (JS_IsException(result)) {
        return result;
    }

    JSValue resolving_funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving_funcs);
    if (JS_IsException(promise)) {
        JS_FreeValue(ctx, result);
        return JS_EXCEPTION;
    }

    JS_Call(ctx, resolving_funcs[0], JS_UNDEFINED, 1, &result);
    JS_FreeValue(ctx, result);
    JS_FreeValue(ctx, resolving_funcs[0]);
    JS_FreeValue(ctx, resolving_funcs[1]);

    return promise;
}

/* ================================================================
 * WebAssembly.instantiate(bufferSource|Module, importObject) -> Promise
 * ================================================================ */

static JSValue wasm3_wasm_instantiate(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "WebAssembly.instantiate requires at least 1 argument");
    }

    JSValue instance_ctor = JS_GetPropertyStr(ctx, this_val, "Instance");
    int is_module_arg = (JS_GetOpaque(argv[0], rt->wasm3_module_class_id) != NULL);

    JSValue instance_result;
    JSValue module_result = JS_UNDEFINED;

    if (is_module_arg) {
        JSValue inst_args[2] = { argv[0], argc >= 2 ? argv[1] : JS_UNDEFINED };
        instance_result = JS_CallConstructor(ctx, instance_ctor, argc >= 2 ? 2 : 1, inst_args);
    } else {
        JSValue module_ctor = JS_GetPropertyStr(ctx, this_val, "Module");
        module_result = JS_CallConstructor(ctx, module_ctor, 1, argv);
        JS_FreeValue(ctx, module_ctor);

        if (JS_IsException(module_result)) {
            JS_FreeValue(ctx, instance_ctor);
            return module_result;
        }

        JSValue inst_args[2] = { module_result, argc >= 2 ? argv[1] : JS_UNDEFINED };
        instance_result = JS_CallConstructor(ctx, instance_ctor, argc >= 2 ? 2 : 1, inst_args);
    }

    JS_FreeValue(ctx, instance_ctor);

    if (JS_IsException(instance_result)) {
        JS_FreeValue(ctx, module_result);
        return instance_result;
    }

    JSValue resolving_funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving_funcs);
    if (JS_IsException(promise)) {
        JS_FreeValue(ctx, instance_result);
        JS_FreeValue(ctx, module_result);
        return JS_EXCEPTION;
    }

    if (is_module_arg) {
        JS_Call(ctx, resolving_funcs[0], JS_UNDEFINED, 1, &instance_result);
        JS_FreeValue(ctx, instance_result);
    } else {
        JSValue obj = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, obj, "module", module_result);
        JS_SetPropertyStr(ctx, obj, "instance", instance_result);
        JS_Call(ctx, resolving_funcs[0], JS_UNDEFINED, 1, &obj);
        JS_FreeValue(ctx, obj);
        /* module_result and instance_result were consumed by JS_SetPropertyStr,
         * which transferred ownership to the obj. Do not free them again. */
    }

    JS_FreeValue(ctx, resolving_funcs[0]);
    JS_FreeValue(ctx, resolving_funcs[1]);

    return promise;
}

/* WebAssembly.compileStreaming / instantiateStreaming
 *
 * v1 语义等价实现：接受 Promise<Response> 或含 arrayBuffer() 方法的对象，
 * 取完整字节后交给 compile / instantiate（不要求真·逐块流式编译）。
 * magic: 0 = compileStreaming, 1 = instantiateStreaming。
 */
static JSValue wasm3_wasm_streaming(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv, int magic)
{
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx,
            "WebAssembly.*Streaming requires at least 1 argument");
    }
    /* async IIFE：resolve source → arrayBuffer() → compile / instantiate */
    const char *compile_prog =
        "(async function(src) {                                           "
        "  var r = (src && typeof src.then === 'function') ? await src : src;"
        "  if (!r || typeof r.arrayBuffer !== 'function')                 "
        "    throw new TypeError('streaming source must provide arrayBuffer()');"
        "  var buf = await r.arrayBuffer();                               "
        "  return WebAssembly.compile(buf);                               "
        "})";
    const char *instantiate_prog =
        "(async function(src, imports) {                                  "
        "  var r = (src && typeof src.then === 'function') ? await src : src;"
        "  if (!r || typeof r.arrayBuffer !== 'function')                 "
        "    throw new TypeError('streaming source must provide arrayBuffer()');"
        "  var buf = await r.arrayBuffer();                               "
        "  return WebAssembly.instantiate(buf, imports);                  "
        "})";
    const char *prog = magic ? instantiate_prog : compile_prog;
    JSValue fn = JS_Eval(ctx, prog, strlen(prog), "<wasm-streaming>",
                         JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(fn)) return fn;
    JSValue imports = (argc >= 2) ? argv[1] : JS_UNDEFINED;
    JSValue args[2] = { argv[0], imports };
    JSValue result = JS_Call(ctx, fn, JS_UNDEFINED, 2, args);
    JS_FreeValue(ctx, fn);
    return result;
}

/* ================================================================
 * WebAssembly.Module constructor
 * ================================================================ */

static JSValue wasm3_module_constructor(JSContext *ctx, JSValueConst new_target,
                                        int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    (void)new_target;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "WebAssembly.Module requires at least 1 argument");
    }

    wasm3_module_wrap_t *existing = (wasm3_module_wrap_t *)JS_GetOpaque(argv[0], rt->wasm3_module_class_id);
    if (existing) {
        return JS_DupValue(ctx, argv[0]);
    }

    uint8_t *bytes;
    size_t byte_len;
    if (wasm3_extract_buffer(ctx, argv[0], &bytes, &byte_len) < 0) {
        return JS_ThrowTypeError(ctx, "WebAssembly.Module: argument must be ArrayBuffer or TypedArray");
    }

    if (byte_len == 0) {
        return JS_ThrowTypeError(ctx, "WebAssembly.Module: empty buffer");
    }

    /* Copy the wasm binary — wasm3 needs it to remain valid for module lifetime */
    uint8_t *wasm_buf = (uint8_t *)js_malloc(ctx, byte_len);
    if (!wasm_buf) {
        return JS_ThrowOutOfMemory(ctx);
    }
    memcpy(wasm_buf, bytes, byte_len);

    /* Parse the module */
    IM3Module module = NULL;
    M3Result result = m3_ParseModule((IM3Environment)rt->wasm3_env, &module, wasm_buf, (uint32_t)byte_len);
    if (result || !module) {
        js_free(ctx, wasm_buf);
        return wasm3_throw_compile_error(ctx, "WebAssembly.Module: %s", result ? result : "parse failed");
    }

    wasm3_module_wrap_t *wrap = (wasm3_module_wrap_t *)js_malloc(ctx, sizeof(wasm3_module_wrap_t));
    if (!wrap) {
        m3_FreeModule(module);
        js_free(ctx, wasm_buf);
        return JS_ThrowOutOfMemory(ctx);
    }
    wrap->module = module;
    wrap->wasm_buf = wasm_buf;
    wrap->wasm_buf_size = (uint32_t)byte_len;
    wrap->loaded = 0;
    wrap->instance_ref = JS_UNDEFINED;

    JSValue obj = JS_NewObjectClass(ctx, rt->wasm3_module_class_id);
    if (JS_IsException(obj)) {
        m3_FreeModule(module);
        js_free(ctx, wasm_buf);
        js_free(ctx, wrap);
        return JS_EXCEPTION;
    }
    JS_SetOpaque(obj, wrap);

    return obj;
}

/* ================================================================
 * WebAssembly.Module.exports(module) — static introspection
 * ================================================================ */

static JSValue wasm3_module_exports(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "Module.exports requires 1 argument");

    wasm3_module_wrap_t *wrap = (wasm3_module_wrap_t *)JS_GetOpaque(argv[0], rt->wasm3_module_class_id);
    if (!wrap || !wrap->module) return JS_ThrowTypeError(ctx, "argument must be a WebAssembly.Module");

    JSValue arr = JS_NewArray(ctx);
    u32 idx = 0;

    /* Memory export */
    if (wrap->module->memoryExportName) {
        JSValue entry = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, entry, "name", JS_NewString(ctx, wrap->module->memoryExportName));
        JS_SetPropertyStr(ctx, entry, "kind", JS_NewString(ctx, "memory"));
        JS_SetPropertyInt64(ctx, arr, idx++, entry);
    }

    /* Table export */
    if (wrap->module->table0ExportName) {
        JSValue entry = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, entry, "name", JS_NewString(ctx, wrap->module->table0ExportName));
        JS_SetPropertyStr(ctx, entry, "kind", JS_NewString(ctx, "table"));
        JS_SetPropertyInt64(ctx, arr, idx++, entry);
    }

    /* Global exports */
    for (u32 i = 0; i < wrap->module->numGlobals; i++) {
        M3Global *g = &wrap->module->globals[i];
        if (g->imported || !g->name) continue;
        JSValue entry = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, entry, "name", JS_NewString(ctx, g->name));
        JS_SetPropertyStr(ctx, entry, "kind", JS_NewString(ctx, "global"));
        JS_SetPropertyInt64(ctx, arr, idx++, entry);
    }

    /* Function exports */
    for (u32 i = 0; i < wrap->module->numFunctions; i++) {
        M3Function *f = &wrap->module->functions[i];
        if (!f->export_name || f->import.moduleUtf8) continue;
        JSValue entry = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, entry, "name", JS_NewString(ctx, f->export_name));
        JS_SetPropertyStr(ctx, entry, "kind", JS_NewString(ctx, "function"));
        JS_SetPropertyInt64(ctx, arr, idx++, entry);
    }

    return arr;
}

/* ================================================================
 * WebAssembly.Module.imports(module) — static introspection
 * ================================================================ */

static JSValue wasm3_module_imports(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "Module.imports requires 1 argument");

    wasm3_module_wrap_t *wrap = (wasm3_module_wrap_t *)JS_GetOpaque(argv[0], rt->wasm3_module_class_id);
    if (!wrap || !wrap->module) return JS_ThrowTypeError(ctx, "argument must be a WebAssembly.Module");

    JSValue arr = JS_NewArray(ctx);
    u32 idx = 0;

    /* Memory import */
    if (wrap->module->memoryImported && wrap->module->memoryImport.moduleUtf8) {
        JSValue entry = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, entry, "module", JS_NewString(ctx, wrap->module->memoryImport.moduleUtf8));
        JS_SetPropertyStr(ctx, entry, "name", JS_NewString(ctx, wrap->module->memoryImport.fieldUtf8));
        JS_SetPropertyStr(ctx, entry, "kind", JS_NewString(ctx, "memory"));
        JS_SetPropertyInt64(ctx, arr, idx++, entry);
    }

    /* Global imports */
    for (u32 i = 0; i < wrap->module->numGlobals; i++) {
        M3Global *g = &wrap->module->globals[i];
        if (!g->imported || !g->import.moduleUtf8) continue;
        JSValue entry = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, entry, "module", JS_NewString(ctx, g->import.moduleUtf8));
        JS_SetPropertyStr(ctx, entry, "name", JS_NewString(ctx, g->import.fieldUtf8));
        JS_SetPropertyStr(ctx, entry, "kind", JS_NewString(ctx, "global"));
        JS_SetPropertyInt64(ctx, arr, idx++, entry);
    }

    /* Function imports */
    for (u32 i = 0; i < wrap->module->numFunctions; i++) {
        M3Function *f = &wrap->module->functions[i];
        if (!f->import.moduleUtf8) continue;
        JSValue entry = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, entry, "module", JS_NewString(ctx, f->import.moduleUtf8));
        JS_SetPropertyStr(ctx, entry, "name", JS_NewString(ctx, f->import.fieldUtf8));
        JS_SetPropertyStr(ctx, entry, "kind", JS_NewString(ctx, "function"));
        JS_SetPropertyInt64(ctx, arr, idx++, entry);
    }

    return arr;
}

/* WebAssembly.Module.customSections(module, name) -> ArrayBuffer[] */
static JSValue wasm3_module_custom_sections(JSContext *ctx, JSValueConst this_val,
                                             int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    (void)this_val;
    if (argc < 2) return JS_ThrowTypeError(ctx, "Module.customSections requires 2 arguments");

    wasm3_module_wrap_t *wrap = (wasm3_module_wrap_t *)JS_GetOpaque(argv[0], rt->wasm3_module_class_id);
    if (!wrap || !wrap->module) return JS_ThrowTypeError(ctx, "first argument must be a WebAssembly.Module");

    const char *section_name = JS_ToCString(ctx, argv[1]);
    if (!section_name) return JS_EXCEPTION;

    size_t name_len = strlen(section_name);
    JSValue arr = JS_NewArray(ctx);
    u32 idx = 0;

    /* Scan the raw WASM binary for custom sections (section id = 0) */
    const uint8_t *p = wrap->wasm_buf;
    const uint8_t *end = p + wrap->wasm_buf_size;

    /* Skip the magic number and version (8 bytes) */
    if (p + 8 > end) goto done;
    p += 8;

    while (p < end) {
        if (p + 2 > end) break;
        uint8_t section_id = *p++;
        /* Decode LEB128 section size */
        uint32_t section_size = 0;
        uint32_t shift = 0;
        do {
            if (p >= end) goto done;
            uint8_t byte = *p++;
            section_size |= (uint32_t)(byte & 0x7f) << shift;
            shift += 7;
            /* Cap the shift so a malicious oversized LEB128 cannot reach
             * shift >= 32 (undefined behavior for the << below). */
            if (shift > 28) break;
            if (!(byte & 0x80)) break;
        } while (1);

        if (p + section_size > end) break;

        if (section_id == 0) {
            /* Custom section: first bytes are the name (UTF-8, LEB128 length-prefixed) */
            const uint8_t *sec_start = p;
            const uint8_t *sec_end = p + section_size;

            /* Decode name length (LEB128) */
            uint32_t sn_len = 0;
            uint32_t sn_shift = 0;
            const uint8_t *np = sec_start;
            do {
                if (np >= sec_end) break;
                uint8_t byte = *np++;
                sn_len |= (uint32_t)(byte & 0x7f) << sn_shift;
                sn_shift += 7;
                if (sn_shift > 28) break;
                if (!(byte & 0x80)) break;
            } while (1);

            /* Compare name */
            if (sn_len == name_len && np + sn_len <= sec_end &&
                memcmp(np, section_name, sn_len) == 0) {
                /* Calculate content offset and size (after name) */
                size_t content_offset = (size_t)(np + sn_len - sec_start);
                size_t content_size = section_size - content_offset;
                JSValue ab = JS_NewArrayBufferCopy(ctx, sec_start + content_offset, content_size);
                JS_SetPropertyInt64(ctx, arr, idx++, ab);
            }
        }

        p += section_size;
    }

done:
    JS_FreeCString(ctx, section_name);
    return arr;
}

/* ================================================================
 * WASM function call: invoke a wasm3 exported function from JS
 * ================================================================ */

static void wasm3_func_closure_free(JSRuntime *jsrt, JSValue val)
{
    qz_t *rt = qz_get_rt_from_jsrt(jsrt);
    if (!rt) return;
    wasm3_func_closure_t *closure = (wasm3_func_closure_t *)JS_GetOpaque(val, rt->wasm3_func_closure_class_id);
    if (closure) {
        js_free_rt(jsrt, closure->arg_types);
        js_free_rt(jsrt, closure->ret_types);
        JS_FreeValueRT(jsrt, closure->instance_ref);
        js_free_rt(jsrt, closure);
    }
}

static void wasm3_import_closure_free(JSRuntime *jsrt, JSValue val)
{
    qz_t *rt = qz_get_rt_from_jsrt(jsrt);
    if (!rt) return;
    wasm3_import_closure_t *closure = (wasm3_import_closure_t *)JS_GetOpaque(val, rt->wasm3_import_closure_class_id);
    if (closure) {
        JS_FreeValueRT(jsrt, closure->js_func);
        js_free_rt(jsrt, closure->arg_types);
        js_free_rt(jsrt, closure->ret_types);
        js_free_rt(jsrt, closure);
    }
}

/* Generic M3RawCall that dispatches WASM calls to a JS function */
static const void *wasm3_import_dispatch(IM3Runtime runtime, IM3ImportContext ctx,
                                          uint64_t *sp, void *mem)
{
    (void)runtime;
    (void)mem;
    wasm3_import_closure_t *closure = (wasm3_import_closure_t *)ctx->userdata;
    if (!closure) return "import closure lost";

    JSContext *jsctx = closure->ctx;
    JSValueConst argv[16];

    for (u16 i = 0; i < closure->num_args && i < 16; i++) {
        uint64_t val = sp[closure->num_rets + i];
        switch (closure->arg_types[i]) {
        case c_m3Type_i32: argv[i] = JS_NewInt32(jsctx, (int32_t)(uint32_t)val); break;
        case c_m3Type_i64: argv[i] = JS_NewBigInt64(jsctx, (int64_t)val); break;
        case c_m3Type_f32: { float f; memcpy(&f, &val, sizeof(float)); argv[i] = JS_NewFloat64(jsctx, (double)f); break; }
        case c_m3Type_f64: { double d; memcpy(&d, &val, sizeof(double)); argv[i] = JS_NewFloat64(jsctx, d); break; }
        default: argv[i] = JS_UNDEFINED; break;
        }
    }

    JSValue result = JS_Call(jsctx, closure->js_func, JS_UNDEFINED, closure->num_args, argv);

    for (u16 i = 0; i < closure->num_args && i < 16; i++) {
        JS_FreeValue(jsctx, argv[i]);
    }

    if (JS_IsException(result)) {
        JS_FreeValue(jsctx, result);
        return "JS import function threw";
    }

    if (closure->num_rets == 0) {
        JS_FreeValue(jsctx, result);
    } else if (closure->num_rets == 1) {
        switch (closure->ret_types[0]) {
        case c_m3Type_i32: { int32_t v; JS_ToInt32(jsctx, &v, result); sp[0] = (uint64_t)(uint32_t)v; break; }
        case c_m3Type_i64: { int64_t v; JS_ToInt64(jsctx, &v, result); sp[0] = (uint64_t)v; break; }
        case c_m3Type_f32: { double v; JS_ToFloat64(jsctx, &v, result); float f = (float)v; memcpy(&sp[0], &f, sizeof(float)); break; }
        case c_m3Type_f64: { double v; JS_ToFloat64(jsctx, &v, result); memcpy(&sp[0], &v, sizeof(double)); break; }
        default: break;
        }
        JS_FreeValue(jsctx, result);
    } else {
        /* Multiple returns — result should be an array */
        for (u16 i = 0; i < closure->num_rets; i++) {
            JSValue elem = JS_GetPropertyInt64(jsctx, result, i);
            switch (closure->ret_types[i]) {
            case c_m3Type_i32: { int32_t v; JS_ToInt32(jsctx, &v, elem); sp[i] = (uint64_t)(uint32_t)v; break; }
            case c_m3Type_i64: { int64_t v; JS_ToInt64(jsctx, &v, elem); sp[i] = (uint64_t)v; break; }
            case c_m3Type_f32: { double v; JS_ToFloat64(jsctx, &v, elem); float f = (float)v; memcpy(&sp[i], &f, sizeof(float)); break; }
            case c_m3Type_f64: { double v; JS_ToFloat64(jsctx, &v, elem); memcpy(&sp[i], &v, sizeof(double)); break; }
            default: break;
            }
            JS_FreeValue(jsctx, elem);
        }
        JS_FreeValue(jsctx, result);
    }

    return m3Err_none;
}

/* ================================================================
 * Memory object: finalizer + grow() + live buffer refresh
 * ================================================================ */

static void wasm3_memory_finalizer(JSRuntime *jsrt, JSValue val)
{
    qz_t *rt = qz_get_rt_from_jsrt(jsrt);
    if (!rt) return;
    wasm3_memory_wrap_t *wrap = (wasm3_memory_wrap_t *)JS_GetOpaque(val, rt->wasm3_memory_class_id);
    if (wrap) {
        if (wrap->js_mem) {
            js_free_rt(jsrt, wrap->js_mem);
        }
        JS_FreeValueRT(jsrt, wrap->instance_ref);
        js_free_rt(jsrt, wrap);
    }
}

static void wasm3_table_finalizer(JSRuntime *jsrt, JSValue val)
{
    qz_t *rt = qz_get_rt_from_jsrt(jsrt);
    if (!rt) return;
    wasm3_table_wrap_t *wrap = (wasm3_table_wrap_t *)JS_GetOpaque(val, rt->wasm3_table_class_id);
    if (wrap) {
        if (wrap->elements) {
            for (u32 i = 0; i < wrap->current_size; i++) {
                JS_FreeValueRT(jsrt, wrap->elements[i]);
            }
            js_free_rt(jsrt, wrap->elements);
        }
        js_free_rt(jsrt, wrap);
    }
}

static void wasm3_global_finalizer(JSRuntime *jsrt, JSValue val)
{
    qz_t *rt = qz_get_rt_from_jsrt(jsrt);
    if (!rt) return;
    wasm3_global_wrap_t *wrap = (wasm3_global_wrap_t *)JS_GetOpaque(val, rt->wasm3_global_class_id);
    if (wrap) {
        JS_FreeValueRT(jsrt, wrap->instance_ref);
        js_free_rt(jsrt, wrap);
    }
}

/* Refresh the buffer property on a Memory object to point to current wasm3 memory */
static void wasm3_memory_refresh_buffer(JSContext *ctx, JSValue mem_obj, wasm3_memory_wrap_t *wrap)
{
    uint32_t mem_size = 0;
    uint8_t *mem_data = NULL;

    if (wrap->runtime) {
        mem_data = m3_GetMemory(wrap->runtime, &mem_size, 0);
        wrap->current_pages = mem_size / 65536;
    } else {
        mem_data = wrap->js_mem;
        mem_size = (uint32_t)wrap->js_mem_size;
    }

    /* Detach old buffer (makes existing views neutered, matching browser behavior) */
    JSValue old_ab = JS_GetPropertyStr(ctx, mem_obj, "buffer");
    if (JS_IsArrayBuffer(old_ab)) {
        JS_DetachArrayBuffer(ctx, old_ab);
    }
    JS_FreeValue(ctx, old_ab);

    /* Create new live buffer */
    JSValue new_ab;
    if (mem_data && mem_size > 0) {
        new_ab = JS_NewArrayBuffer(ctx, mem_data, mem_size, 0, NULL, NULL, 0);
    } else {
        new_ab = JS_NewArrayBuffer(ctx, NULL, 0, 0, NULL, NULL, 0);
    }
    JS_SetPropertyStr(ctx, mem_obj, "buffer", new_ab);
}

static JSValue wasm3_memory_grow(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    wasm3_memory_wrap_t *wrap = (wasm3_memory_wrap_t *)JS_GetOpaque(this_val, rt->wasm3_memory_class_id);
    if (!wrap) {
        return JS_ThrowTypeError(ctx, "Memory.grow: invalid memory object");
    }

    int32_t delta = 1;
    if (argc >= 1 && !JS_IsUndefined(argv[0])) {
        if (JS_ToInt32(ctx, &delta, argv[0]) < 0) return JS_EXCEPTION;
    }
    if (delta < 0) {
        return JS_ThrowRangeError(ctx, "Memory.grow: delta must be non-negative");
    }

    u32 old_pages = wrap->current_pages;
    u32 new_pages = old_pages + (u32)delta;

    if (wrap->maximum_pages > 0 && new_pages > wrap->maximum_pages) {
        return JS_NewInt32(ctx, -1);
    }

    if (wrap->runtime) {
        /* Instance memory — use wasm3 ResizeMemory */
        M3Result result = ResizeMemory(wrap->runtime, new_pages);
        if (result) {
            return JS_NewInt32(ctx, -1);
        }
    } else {
        /* Standalone Memory — realloc JS-managed buffer */
        size_t new_size = (size_t)new_pages * 65536;
        uint8_t *new_mem = (uint8_t *)js_realloc(ctx, wrap->js_mem, new_size);
        if (!new_mem) {
            return JS_ThrowOutOfMemory(ctx);
        }
        /* Zero new pages */
        memset(new_mem + wrap->js_mem_size, 0, new_size - wrap->js_mem_size);
        wrap->js_mem = new_mem;
        wrap->js_mem_size = new_size;
    }

    wrap->current_pages = new_pages;
    wasm3_memory_refresh_buffer(ctx, this_val, wrap);

    return JS_NewInt32(ctx, (int32_t)old_pages);
}

static JSValue wasm3_call_func(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv, int magic,
                                JSValue *func_data)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    (void)this_val;
    (void)magic;

    wasm3_func_closure_t *closure = (wasm3_func_closure_t *)JS_GetOpaque(*func_data, rt->wasm3_func_closure_class_id);
    if (!closure) {
        return JS_ThrowTypeError(ctx, "WASM function closure lost");
    }

    /* Validate argument count */
    if ((u16)argc != closure->num_args) {
        return JS_ThrowTypeError(ctx, "WASM function '%s' expects %d args, got %d",
                                 closure->name, closure->num_args, argc);
    }

    /* Find the function in the runtime */
    IM3Function func = NULL;
    M3Result res = m3_FindFunction(&func, closure->runtime, closure->name);
    if (res || !func) {
        return JS_ThrowTypeError(ctx, "WASM function '%s' not found: %s",
                                 closure->name, res ? res : "null");
    }

    /* Convert JS args to wasm3 stack values */
    /* wasm3 uses m3_CallArgv which takes char* argv — simpler to use m3_Call with void* ptrs */
    uint64_t arg_vals[16];  /* max 16 args, each up to 64-bit */
    const void *arg_ptrs[16];

    for (u16 i = 0; i < closure->num_args && i < 16; i++) {
        u8 type = closure->arg_types[i];
        switch (type) {
        case c_m3Type_i32: {
            int32_t v;
            if (JS_ToInt32(ctx, &v, argv[i]) < 0) return JS_EXCEPTION;
            arg_vals[i] = (uint64_t)(uint32_t)v;
            arg_ptrs[i] = &arg_vals[i];
            break;
        }
        case c_m3Type_i64: {
            int64_t v;
            if (JS_ToInt64(ctx, &v, argv[i]) < 0) return JS_EXCEPTION;
            arg_vals[i] = (uint64_t)v;
            arg_ptrs[i] = &arg_vals[i];
            break;
        }
        case c_m3Type_f32: {
            double v;
            if (JS_ToFloat64(ctx, &v, argv[i]) < 0) return JS_EXCEPTION;
            float fv = (float)v;
            memcpy(&arg_vals[i], &fv, sizeof(float));
            arg_ptrs[i] = &arg_vals[i];
            break;
        }
        case c_m3Type_f64: {
            double v;
            if (JS_ToFloat64(ctx, &v, argv[i]) < 0) return JS_EXCEPTION;
            memcpy(&arg_vals[i], &v, sizeof(double));
            arg_ptrs[i] = &arg_vals[i];
            break;
        }
        default:
            return JS_ThrowTypeError(ctx, "WASM function '%s': unsupported arg type %d at index %d",
                                     closure->name, type, i);
        }
    }

    res = m3_Call(func, closure->num_args, arg_ptrs);
    if (res) {
        return JS_ThrowTypeError(ctx, "WASM call '%s' failed: %s", closure->name, res);
    }

    /* Extract return values */
    uint64_t ret_vals[4];
    const void *ret_ptrs[4];
    for (u16 i = 0; i < closure->num_rets && i < 4; i++) {
        ret_ptrs[i] = &ret_vals[i];
    }

    res = m3_GetResults(func, closure->num_rets, ret_ptrs);
    if (res) {
        return JS_ThrowTypeError(ctx, "WASM get results '%s' failed: %s", closure->name, res);
    }

    /* Convert WASM return values to JS */
    if (closure->num_rets == 0) {
        return JS_UNDEFINED;
    } else if (closure->num_rets == 1) {
        u8 type = closure->ret_types[0];
        switch (type) {
        case c_m3Type_i32: return JS_NewInt32(ctx, (int32_t)(uint32_t)ret_vals[0]);
        case c_m3Type_i64: return JS_NewBigInt64(ctx, (int64_t)ret_vals[0]);
        case c_m3Type_f32: { float f; memcpy(&f, &ret_vals[0], sizeof(float)); return JS_NewFloat64(ctx, (double)f); }
        case c_m3Type_f64: { double d; memcpy(&d, &ret_vals[0], sizeof(double)); return JS_NewFloat64(ctx, d); }
        default: return JS_UNDEFINED;
        }
    } else {
        /* Multiple return values — return as array */
        JSValue arr = JS_NewArray(ctx);
        for (u16 i = 0; i < closure->num_rets; i++) {
            JSValue val;
            switch (closure->ret_types[i]) {
            case c_m3Type_i32: val = JS_NewInt32(ctx, (int32_t)(uint32_t)ret_vals[i]); break;
            case c_m3Type_i64: val = JS_NewBigInt64(ctx, (int64_t)ret_vals[i]); break;
            case c_m3Type_f32: { float f; memcpy(&f, &ret_vals[i], sizeof(float)); val = JS_NewFloat64(ctx, (double)f); break; }
            case c_m3Type_f64: { double d; memcpy(&d, &ret_vals[i], sizeof(double)); val = JS_NewFloat64(ctx, d); break; }
            default: val = JS_UNDEFINED; break;
            }
            JS_SetPropertyInt64(ctx, arr, i, val);
        }
        return arr;
    }
}

/* ================================================================
 * WebAssembly.Instance constructor
 * ================================================================ */

static JSValue wasm3_instance_constructor(JSContext *ctx, JSValueConst new_target,
                                          int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    (void)new_target;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "WebAssembly.Instance requires at least 1 argument");
    }

    wasm3_module_wrap_t *mod_wrap = (wasm3_module_wrap_t *)JS_GetOpaque(argv[0], rt->wasm3_module_class_id);
    if (!mod_wrap || !mod_wrap->module) {
        return JS_ThrowTypeError(ctx, "WebAssembly.Instance: first argument must be a WebAssembly.Module");
    }

    /* Create a new runtime for this instance */
    IM3Runtime runtime = m3_NewRuntime((IM3Environment)rt->wasm3_env, 64 * 1024, NULL);
    if (!runtime) {
        return JS_ThrowOutOfMemory(ctx);
    }
    /* Load module into the runtime — this transfers ownership */
    M3Result result = m3_LoadModule(runtime, mod_wrap->module);
    if (result) {
        m3_FreeRuntime(runtime);
        if (mod_wrap->module->memoryImported) {
            return JS_ThrowTypeError(ctx,
                "WebAssembly.Instance: memory import requires an imported "
                "Memory object (wasm3 memory import not yet supported)");
        }
        return JS_ThrowTypeError(ctx, "WebAssembly.Instance: %s", result);
    }
    /* The instance runtime now owns the parsed module; mark it so the module
     * finalizer won't free it (would double-free once the runtime frees it). */
    mod_wrap->loaded = 1;

    /* Process import object (argv[1]) */
    JSValue import_closures_arr = JS_NewArray(ctx);
    int import_idx = 0;
    int missing_imports = 0;
    int declared_imports = 0;

    /* Count declared function imports so a missing importObject is reported as
     * a link error instead of silently linking trap stubs. */
    for (u32 i = 0; i < mod_wrap->module->numFunctions; i++) {
        M3Function *f = &mod_wrap->module->functions[i];
        if (f->import.moduleUtf8 && f->import.fieldUtf8) declared_imports++;
    }

    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsObject(argv[1])) {
        JS_FreeValue(ctx, import_closures_arr);
        return JS_ThrowTypeError(ctx,
            "WebAssembly.Instance: importObject must be an object");
    }

    if (argc >= 2 && JS_IsObject(argv[1])) {
        for (u32 i = 0; i < mod_wrap->module->numFunctions; i++) {
            M3Function *f = &mod_wrap->module->functions[i];
            if (!f->import.moduleUtf8 || !f->import.fieldUtf8) continue;

            const char *mod_name = f->import.moduleUtf8;
            const char *field_name = f->import.fieldUtf8;

            /* Look up module in importObject */
            JSValue mod_val = JS_GetPropertyStr(ctx, argv[1], mod_name);
            if (JS_IsException(mod_val) || JS_IsUndefined(mod_val)) {
                JS_FreeValue(ctx, mod_val);
                missing_imports++;
                continue;
            }

            /* Look up field in module */
            JSValue field_val = JS_GetPropertyStr(ctx, mod_val, field_name);
            JS_FreeValue(ctx, mod_val);

            if (JS_IsException(field_val) || JS_IsUndefined(field_val)) {
                JS_FreeValue(ctx, field_val);
                missing_imports++;
                continue;
            }

            if (!JS_IsFunction(ctx, field_val)) {
                JS_FreeValue(ctx, field_val);
                missing_imports++;
                continue;
            }

            IM3FuncType ftype = f->funcType;
            if (!ftype) {
                JS_FreeValue(ctx, field_val);
                missing_imports++;
                continue;
            }

            /* Build signature string */
            char *sig = wasm3_build_signature(ftype);
            if (!sig) {
                JS_FreeValue(ctx, field_val);
                continue;
            }

            /* Create import closure */
            wasm3_import_closure_t *ic = (wasm3_import_closure_t *)js_mallocz(ctx, sizeof(*ic));
            if (!ic) {
                free(sig);
                JS_FreeValue(ctx, field_val);
                continue;
            }

            ic->ctx = ctx;
            ic->js_func = JS_DupValue(ctx, field_val);
            ic->num_args = ftype->numArgs;
            ic->num_rets = ftype->numRets;

            if (ftype->numArgs > 0) {
                ic->arg_types = (u8 *)js_malloc(ctx, ftype->numArgs);
                if (ic->arg_types)
                    memcpy(ic->arg_types, &ftype->types[ftype->numRets], ftype->numArgs);
            }
            if (ftype->numRets > 0) {
                ic->ret_types = (u8 *)js_malloc(ctx, ftype->numRets);
                if (ic->ret_types)
                    memcpy(ic->ret_types, ftype->types, ftype->numRets);
            }

            /* Wrap in a JS opaque object so GC can free the closure */
            JSValue ic_obj = JS_NewObjectClass(ctx, rt->wasm3_import_closure_class_id);
            JS_SetOpaque(ic_obj, ic);

            /* Keep closure alive via the instance */
            JS_SetPropertyInt64(ctx, import_closures_arr, import_idx++, ic_obj);

            /* Link the function */
            result = m3_LinkRawFunctionEx(mod_wrap->module, mod_name, field_name,
                                           sig, wasm3_import_dispatch, ic);
            free(sig);

            JS_FreeValue(ctx, field_val);

            if (result) {
                missing_imports++;
            }
        }
    } else if (declared_imports > 0) {
        missing_imports = declared_imports;
    }

    if (missing_imports > 0) {
        JS_FreeValue(ctx, import_closures_arr);
        m3_FreeRuntime(runtime);
        return wasm3_throw_link_error(ctx,
            "WebAssembly.Instance: %d missing import(s)", missing_imports);
    }

    /* Compile all functions */
    result = m3_CompileModule(mod_wrap->module);
    if (result) {
        m3_FreeRuntime(runtime);
        return JS_ThrowTypeError(ctx, "WebAssembly.Instance: %s", result);
    }

    wasm3_instance_wrap_t *wrap = (wasm3_instance_wrap_t *)js_mallocz(ctx, sizeof(*wrap));
    if (!wrap) {
        m3_FreeRuntime(runtime);
        return JS_ThrowOutOfMemory(ctx);
    }
    wrap->runtime = runtime;
    wrap->module = mod_wrap->module;
    wrap->module_obj = JS_DupValue(ctx, argv[0]);  /* keep module alive until instance dies */
    wrap->import_closures = import_closures_arr;    /* keep import closures alive */

    JSValue obj = JS_NewObjectClass(ctx, rt->wasm3_instance_class_id);
    if (JS_IsException(obj)) {
        m3_FreeRuntime(runtime);
        js_free(ctx, wrap);
        return JS_EXCEPTION;
    }
    JS_SetOpaque(obj, wrap);
    /* Once the module is loaded into this instance runtime, the module's
     * parsed data is owned by the runtime. Holding a reference to the instance
     * keeps the module memory valid while the Module object is alive
     * (Module.exports()/imports() must not dereference freed memory). */
    mod_wrap->instance_ref = JS_DupValue(ctx, obj);

    /* Build exports object */
    JSValue exports = JS_NewObject(ctx);

    /* Export memory under its declared export name (or "memory" as fallback) */
    uint32_t mem_size = 0;
    uint8_t *mem_data = m3_GetMemory(runtime, &mem_size, 0);
    if (mem_data && mem_size > 0) {
        const char *mem_name = mod_wrap->module->memoryExportName;
        if (!mem_name) mem_name = "memory";

        wasm3_memory_wrap_t *mwrap = (wasm3_memory_wrap_t *)js_mallocz(ctx, sizeof(*mwrap));
        if (mwrap) {
            mwrap->runtime = runtime;
            mwrap->current_pages = mem_size / 65536;
            mwrap->maximum_pages = mod_wrap->module->memoryInfo.maxPages;
            mwrap->instance_ref = JS_DupValue(ctx, obj);

            JSValue mem_obj = JS_NewObjectClass(ctx, rt->wasm3_memory_class_id);
            JS_SetOpaque(mem_obj, mwrap);

            JSValue ab = JS_NewArrayBuffer(ctx, mem_data, mem_size, 0, NULL, NULL, 0);
            JS_SetPropertyStr(ctx, mem_obj, "buffer", ab);
            JS_SetPropertyStr(ctx, mem_obj, "grow",
                JS_NewCFunction(ctx, wasm3_memory_grow, "grow", 1));
            JS_SetPropertyStr(ctx, exports, mem_name, mem_obj);
        }
    }

    /* Export tables */
    if (mod_wrap->module->table0 && mod_wrap->module->table0Size > 0) {
        const char *tbl_name = mod_wrap->module->table0ExportName;
        if (!tbl_name) tbl_name = "__indirect_function_table";

        wasm3_table_wrap_t *twrap = (wasm3_table_wrap_t *)js_mallocz(ctx, sizeof(*twrap));
        if (twrap) {
            twrap->ctx = ctx;
            twrap->current_size = mod_wrap->module->table0Size;
            twrap->maximum_size = 0;
            twrap->elements = (JSValue *)js_mallocz(ctx, twrap->current_size * sizeof(JSValue));
            if (twrap->elements) {
                for (u32 i = 0; i < twrap->current_size; i++) {
                    twrap->elements[i] = JS_NULL;
                }

                JSValue tbl_obj = JS_NewObjectClass(ctx, rt->wasm3_table_class_id);
                JS_SetOpaque(tbl_obj, twrap);

                JSAtom len_atom = JS_NewAtom(ctx, "length");
                JS_DefinePropertyGetSet(ctx, tbl_obj, len_atom,
                    JS_NewCFunction2(ctx, (JSCFunction *)wasm3_table_length_get, "get length", 0, JS_CFUNC_getter, 0),
                    JS_UNDEFINED, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
                JS_FreeAtom(ctx, len_atom);

                JS_SetPropertyStr(ctx, tbl_obj, "get",
                    JS_NewCFunction(ctx, wasm3_table_get, "get", 1));
                JS_SetPropertyStr(ctx, tbl_obj, "set",
                    JS_NewCFunction(ctx, wasm3_table_set, "set", 2));
                JS_SetPropertyStr(ctx, tbl_obj, "grow",
                    JS_NewCFunction(ctx, wasm3_table_grow, "grow", 1));

                JS_SetPropertyStr(ctx, exports, tbl_name, tbl_obj);
            } else {
                js_free(ctx, twrap);
            }
        }
    }

    /* Export globals */
    for (u32 i = 0; i < mod_wrap->module->numGlobals; i++) {
        M3Global *g = &mod_wrap->module->globals[i];
        if (g->imported || !g->name) continue;

        wasm3_global_wrap_t *gwrap = (wasm3_global_wrap_t *)js_mallocz(ctx, sizeof(*gwrap));
        if (!gwrap) continue;
        gwrap->type = g->type;
        gwrap->is_mutable = g->isMutable;
        gwrap->live_global = g;  /* point to live wasm3 global for live reads/writes */
        gwrap->instance_ref = JS_DupValue(ctx, obj);
        switch (g->type) {
        case c_m3Type_i32: gwrap->value.i32 = g->i32Value; break;
        case c_m3Type_i64: gwrap->value.i64 = g->i64Value; break;
        case c_m3Type_f32: gwrap->value.f32 = g->f32Value; break;
        case c_m3Type_f64: gwrap->value.f64 = g->f64Value; break;
        default: break;
        }

        JSValue gobj = JS_NewObjectClass(ctx, rt->wasm3_global_class_id);
        JS_SetOpaque(gobj, gwrap);

        JSAtom val_atom = JS_NewAtom(ctx, "value");
        JS_DefinePropertyGetSet(ctx, gobj, val_atom,
            JS_NewCFunction2(ctx, (JSCFunction *)wasm3_global_value_get, "get value", 0, JS_CFUNC_getter, 0),
            JS_NewCFunction2(ctx, (JSCFunction *)wasm3_global_value_set, "set value", 0, JS_CFUNC_setter, 0),
            JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
        JS_FreeAtom(ctx, val_atom);

        JS_SetPropertyStr(ctx, gobj, "valueOf",
            JS_NewCFunction(ctx, wasm3_global_valueOf, "valueOf", 0));
        JS_SetPropertyStr(ctx, gobj, "mutable", JS_NewBool(ctx, g->isMutable));
        JS_SetPropertyStr(ctx, exports, g->name, gobj);
    }

    /* Export functions */
    for (u32 i = 0; i < mod_wrap->module->numFunctions; i++) {
        M3Function *f = &mod_wrap->module->functions[i];
        const char *fname = f->export_name;
        if (!fname || f->import.moduleUtf8) continue;  /* skip unexported and imported */

        IM3FuncType ftype = f->funcType;
        if (!ftype) continue;

        wasm3_func_closure_t *closure = (wasm3_func_closure_t *)js_mallocz(ctx, sizeof(*closure));
        if (!closure) continue;

        closure->runtime = runtime;
        closure->module = mod_wrap->module;
        closure->name = fname;
        closure->num_args = ftype->numArgs;
        closure->num_rets = ftype->numRets;
        closure->instance_ref = JS_DupValue(ctx, obj);

        /* Copy arg types (after return types in the types array) */
        if (ftype->numArgs > 0) {
            closure->arg_types = (u8 *)js_malloc(ctx, ftype->numArgs);
            if (closure->arg_types) {
                memcpy(closure->arg_types, &ftype->types[ftype->numRets], ftype->numArgs);
            }
        }
        /* Copy return types (first in the types array) */
        if (ftype->numRets > 0) {
            closure->ret_types = (u8 *)js_malloc(ctx, ftype->numRets);
            if (closure->ret_types) {
                memcpy(closure->ret_types, ftype->types, ftype->numRets);
            }
        }

        /* Create JS function with closure as opaque data */
        JSValue func_data_obj = JS_NewObjectClass(ctx, rt->wasm3_func_closure_class_id);
        JS_SetOpaque(func_data_obj, closure);

        JSValue func = JS_NewCFunctionData(ctx, wasm3_call_func, ftype->numArgs, 0, 1, &func_data_obj);
        JS_FreeValue(ctx, func_data_obj);

        JS_SetPropertyStr(ctx, exports, fname, func);
    }

    JS_SetPropertyStr(ctx, obj, "exports", exports);

    return obj;
}

/* ================================================================
 * WebAssembly.Memory constructor
 * ================================================================ */

static JSValue wasm3_memory_constructor(JSContext *ctx, JSValueConst new_target,
                                        int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    (void)new_target;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "WebAssembly.Memory requires a descriptor");
    }

    JSValue initial_val = JS_GetPropertyStr(ctx, argv[0], "initial");
    int32_t initial_pages = 1;
    if (!JS_IsException(initial_val)) {
        JS_ToInt32(ctx, &initial_pages, initial_val);
    }
    if (initial_pages < 1) {
        JS_FreeValue(ctx, initial_val);
        return JS_ThrowRangeError(ctx, "WebAssembly.Memory: initial must be >= 1");
    }
    JS_FreeValue(ctx, initial_val);

    JSValue maximum_val = JS_GetPropertyStr(ctx, argv[0], "maximum");
    int32_t maximum_pages = -1;
    if (!JS_IsUndefined(maximum_val) && !JS_IsException(maximum_val)) {
        JS_ToInt32(ctx, &maximum_pages, maximum_val);
    }
    JS_FreeValue(ctx, maximum_val);

    if (maximum_pages >= 0 && maximum_pages < initial_pages) {
        return JS_ThrowRangeError(ctx, "WebAssembly.Memory: maximum must be >= initial");
    }

    size_t byte_len = (size_t)initial_pages * 65536;
    uint8_t *mem = (uint8_t *)js_mallocz(ctx, byte_len);
    if (!mem) {
        return JS_ThrowOutOfMemory(ctx);
    }

    wasm3_memory_wrap_t *mwrap = (wasm3_memory_wrap_t *)js_mallocz(ctx, sizeof(*mwrap));
    if (!mwrap) {
        js_free(ctx, mem);
        return JS_ThrowOutOfMemory(ctx);
    }
    mwrap->runtime = NULL;  /* standalone, not backed by wasm3 instance */
    mwrap->current_pages = (u32)initial_pages;
    mwrap->maximum_pages = maximum_pages >= 0 ? (u32)maximum_pages : 0;
    mwrap->js_mem = mem;
    mwrap->js_mem_size = byte_len;
    mwrap->instance_ref = JS_UNDEFINED;

    JSValue obj = JS_NewObjectClass(ctx, rt->wasm3_memory_class_id);
    JS_SetOpaque(obj, mwrap);

    JSValue ab = JS_NewArrayBuffer(ctx, mem, byte_len, 0, NULL, NULL, 0);
    JS_SetPropertyStr(ctx, obj, "buffer", ab);
    JS_SetPropertyStr(ctx, obj, "grow",
        JS_NewCFunction(ctx, wasm3_memory_grow, "grow", 1));

    return obj;
}

/* ================================================================
 * WebAssembly.Table methods
 * ================================================================ */

static JSValue wasm3_table_length_get(JSContext *ctx, JSValueConst this_val)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    wasm3_table_wrap_t *wrap = (wasm3_table_wrap_t *)JS_GetOpaque(this_val, rt->wasm3_table_class_id);
    if (!wrap) return JS_NewInt32(ctx, 0);
    return JS_NewInt32(ctx, (int32_t)wrap->current_size);
}

static JSValue wasm3_table_get(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    wasm3_table_wrap_t *wrap = (wasm3_table_wrap_t *)JS_GetOpaque(this_val, rt->wasm3_table_class_id);
    if (!wrap) return JS_ThrowTypeError(ctx, "Table.get: invalid table object");
    int32_t index = 0;
    if (argc >= 1 && JS_ToInt32(ctx, &index, argv[0]) < 0) return JS_EXCEPTION;
    if (index < 0 || (u32)index >= wrap->current_size)
        return JS_ThrowRangeError(ctx, "Table.get: index out of bounds");
    return JS_DupValue(ctx, wrap->elements[index]);
}

static JSValue wasm3_table_set(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    wasm3_table_wrap_t *wrap = (wasm3_table_wrap_t *)JS_GetOpaque(this_val, rt->wasm3_table_class_id);
    if (!wrap) return JS_ThrowTypeError(ctx, "Table.set: invalid table object");
    int32_t index = 0;
    if (argc >= 1 && JS_ToInt32(ctx, &index, argv[0]) < 0) return JS_EXCEPTION;
    if (index < 0 || (u32)index >= wrap->current_size)
        return JS_ThrowRangeError(ctx, "Table.set: index out of bounds");
    JSValue value = (argc >= 2) ? argv[1] : JS_NULL;
    JS_FreeValue(ctx, wrap->elements[index]);
    wrap->elements[index] = JS_DupValue(ctx, value);
    return JS_UNDEFINED;
}

static JSValue wasm3_table_grow(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    wasm3_table_wrap_t *wrap = (wasm3_table_wrap_t *)JS_GetOpaque(this_val, rt->wasm3_table_class_id);
    if (!wrap) return JS_ThrowTypeError(ctx, "Table.grow: invalid table object");
    int32_t delta = 1;
    if (argc >= 1 && !JS_IsUndefined(argv[0])) {
        if (JS_ToInt32(ctx, &delta, argv[0]) < 0) return JS_EXCEPTION;
    }
    if (delta < 0) return JS_ThrowRangeError(ctx, "Table.grow: delta must be non-negative");
    u32 old_size = wrap->current_size;
    u32 new_size = old_size + (u32)delta;
    if (new_size < old_size)  /* overflow */
        return JS_ThrowRangeError(ctx, "Table.grow: size overflow");
    if (wrap->maximum_size > 0 && new_size > wrap->maximum_size)
        return JS_ThrowRangeError(ctx, "Table.grow: exceeded maximum size");
    size_t alloc_size = (size_t)new_size * sizeof(JSValue);
    if (alloc_size / sizeof(JSValue) != new_size)  /* overflow */
        return JS_ThrowOutOfMemory(ctx);
    JSValue *new_elements = (JSValue *)js_realloc(ctx, wrap->elements, alloc_size);
    if (!new_elements) return JS_ThrowOutOfMemory(ctx);
    JSValue fill = (argc >= 2) ? argv[1] : JS_NULL;
    for (u32 i = old_size; i < new_size; i++) {
        new_elements[i] = JS_DupValue(ctx, fill);
    }
    wrap->elements = new_elements;
    wrap->current_size = new_size;
    return JS_NewInt32(ctx, (int32_t)old_size);
}

/* ================================================================
 * WebAssembly.Table constructor
 * ================================================================ */

static JSValue wasm3_table_constructor(JSContext *ctx, JSValueConst new_target,
                                       int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    (void)new_target;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "WebAssembly.Table requires a descriptor");
    }

    JSValue initial_val = JS_GetPropertyStr(ctx, argv[0], "initial");
    int32_t initial = 0;
    if (!JS_IsException(initial_val)) {
        JS_ToInt32(ctx, &initial, initial_val);
    }
    if (initial < 0) initial = 0;
    JS_FreeValue(ctx, initial_val);

    JSValue maximum_val = JS_GetPropertyStr(ctx, argv[0], "maximum");
    int32_t maximum = -1;
    if (!JS_IsUndefined(maximum_val) && !JS_IsException(maximum_val)) {
        JS_ToInt32(ctx, &maximum, maximum_val);
    }
    JS_FreeValue(ctx, maximum_val);

    JSValue element_val = JS_GetPropertyStr(ctx, argv[0], "element");
    JS_FreeValue(ctx, element_val);

    wasm3_table_wrap_t *wrap = (wasm3_table_wrap_t *)js_mallocz(ctx, sizeof(*wrap));
    if (!wrap) return JS_ThrowOutOfMemory(ctx);
    wrap->ctx = ctx;
    wrap->current_size = (u32)initial;
    wrap->maximum_size = maximum >= 0 ? (u32)maximum : 0;

    if (initial > 0) {
        wrap->elements = (JSValue *)js_mallocz(ctx, (u32)initial * sizeof(JSValue));
        if (!wrap->elements) {
            js_free(ctx, wrap);
            return JS_ThrowOutOfMemory(ctx);
        }
        for (int32_t i = 0; i < initial; i++) {
            wrap->elements[i] = JS_NULL;
        }
    }

    JSValue obj = JS_NewObjectClass(ctx, rt->wasm3_table_class_id);
    if (JS_IsException(obj)) {
        if (wrap->elements) js_free(ctx, wrap->elements);
        js_free(ctx, wrap);
        return JS_EXCEPTION;
    }
    JS_SetOpaque(obj, wrap);

    JSAtom length_atom = JS_NewAtom(ctx, "length");
    JS_DefinePropertyGetSet(ctx, obj, length_atom,
        JS_NewCFunction2(ctx, (JSCFunction *)wasm3_table_length_get, "get length", 0, JS_CFUNC_getter, 0),
        JS_UNDEFINED, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    JS_FreeAtom(ctx, length_atom);

    JS_SetPropertyStr(ctx, obj, "get",
        JS_NewCFunction(ctx, wasm3_table_get, "get", 1));
    JS_SetPropertyStr(ctx, obj, "set",
        JS_NewCFunction(ctx, wasm3_table_set, "set", 2));
    JS_SetPropertyStr(ctx, obj, "grow",
        JS_NewCFunction(ctx, wasm3_table_grow, "grow", 1));

    return obj;
}

/* ================================================================
 * WebAssembly.Global value getter/setter/valueOf
 * ================================================================ */

static JSValue wasm3_global_value_get(JSContext *ctx, JSValueConst this_val)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    wasm3_global_wrap_t *wrap = (wasm3_global_wrap_t *)JS_GetOpaque(this_val, rt->wasm3_global_class_id);
    if (!wrap) return JS_UNDEFINED;
    /* Read live value from wasm3 module if available */
    M3Global *g = wrap->live_global;
    if (g) {
        switch (g->type) {
        case c_m3Type_i32: return JS_NewInt32(ctx, g->i32Value);
        case c_m3Type_i64: return JS_NewBigInt64(ctx, g->i64Value);
        case c_m3Type_f32: return JS_NewFloat64(ctx, (double)g->f32Value);
        case c_m3Type_f64: return JS_NewFloat64(ctx, g->f64Value);
        default: return JS_UNDEFINED;
        }
    }
    switch (wrap->type) {
    case c_m3Type_i32: return JS_NewInt32(ctx, wrap->value.i32);
    case c_m3Type_i64: return JS_NewBigInt64(ctx, wrap->value.i64);
    case c_m3Type_f32: return JS_NewFloat64(ctx, (double)wrap->value.f32);
    case c_m3Type_f64: return JS_NewFloat64(ctx, wrap->value.f64);
    default: return JS_UNDEFINED;
    }
}

static JSValue wasm3_global_value_set(JSContext *ctx, JSValueConst this_val,
                                      JSValueConst val)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    wasm3_global_wrap_t *wrap = (wasm3_global_wrap_t *)JS_GetOpaque(this_val, rt->wasm3_global_class_id);
    if (!wrap) return JS_UNDEFINED;
    if (!wrap->is_mutable) {
        return JS_ThrowTypeError(ctx, "Global is immutable");
    }
    /* Write to live wasm3 global if available */
    M3Global *g = wrap->live_global;
    if (g) {
        switch (g->type) {
        case c_m3Type_i32: JS_ToInt32(ctx, &g->i32Value, val); break;
        case c_m3Type_i64: JS_ToInt64(ctx, &g->i64Value, val); break;
        case c_m3Type_f32: { double v; JS_ToFloat64(ctx, &v, val); g->f32Value = (float)v; break; }
        case c_m3Type_f64: JS_ToFloat64(ctx, &g->f64Value, val); break;
        default: break;
        }
        return JS_UNDEFINED;
    }
    switch (wrap->type) {
    case c_m3Type_i32: JS_ToInt32(ctx, &wrap->value.i32, val); break;
    case c_m3Type_i64: JS_ToInt64(ctx, &wrap->value.i64, val); break;
    case c_m3Type_f32: { double v; JS_ToFloat64(ctx, &v, val); wrap->value.f32 = (float)v; break; }
    case c_m3Type_f64: JS_ToFloat64(ctx, &wrap->value.f64, val); break;
    default: break;
    }
    return JS_UNDEFINED;
}

static JSValue wasm3_global_valueOf(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    (void)argc; (void)argv;
    return wasm3_global_value_get(ctx, this_val);
}

/* ================================================================
 * WebAssembly.Global constructor
 * ================================================================ */

static JSValue wasm3_global_constructor(JSContext *ctx, JSValueConst new_target,
                                        int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    (void)new_target;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "WebAssembly.Global requires a descriptor");
    }

    JSValue mutable_val = JS_GetPropertyStr(ctx, argv[0], "mutable");
    bool is_mutable = JS_IsBool(mutable_val) && JS_ToBool(ctx, mutable_val);
    JS_FreeValue(ctx, mutable_val);

    u8 type = c_m3Type_i32;
    JSValue value_type = JS_GetPropertyStr(ctx, argv[0], "value");
    if (JS_IsString(value_type)) {
        const char *type_str = JS_ToCString(ctx, value_type);
        if (type_str) {
            if (strcmp(type_str, "i32") == 0) type = c_m3Type_i32;
            else if (strcmp(type_str, "i64") == 0) type = c_m3Type_i64;
            else if (strcmp(type_str, "f32") == 0) type = c_m3Type_f32;
            else if (strcmp(type_str, "f64") == 0) type = c_m3Type_f64;
            JS_FreeCString(ctx, type_str);
        }
    }
    JS_FreeValue(ctx, value_type);

    wasm3_global_wrap_t *wrap = (wasm3_global_wrap_t *)js_mallocz(ctx, sizeof(*wrap));
    if (!wrap) return JS_ThrowOutOfMemory(ctx);
    wrap->type = type;
    wrap->is_mutable = is_mutable;
    wrap->instance_ref = JS_UNDEFINED;

    if (argc >= 2 && !JS_IsUndefined(argv[1])) {
        switch (type) {
        case c_m3Type_i32: JS_ToInt32(ctx, &wrap->value.i32, argv[1]); break;
        case c_m3Type_i64: JS_ToInt64(ctx, &wrap->value.i64, argv[1]); break;
        case c_m3Type_f32: { double v; JS_ToFloat64(ctx, &v, argv[1]); wrap->value.f32 = (float)v; break; }
        case c_m3Type_f64: JS_ToFloat64(ctx, &wrap->value.f64, argv[1]); break;
        default: break;
        }
    }

    JSValue obj = JS_NewObjectClass(ctx, rt->wasm3_global_class_id);
    if (JS_IsException(obj)) { js_free(ctx, wrap); return JS_EXCEPTION; }
    JS_SetOpaque(obj, wrap);

    JSAtom value_atom = JS_NewAtom(ctx, "value");
    JS_DefinePropertyGetSet(ctx, obj, value_atom,
        JS_NewCFunction2(ctx, (JSCFunction *)wasm3_global_value_get, "get value", 0, JS_CFUNC_getter, 0),
        JS_NewCFunction2(ctx, (JSCFunction *)wasm3_global_value_set, "set value", 0, JS_CFUNC_setter, 0),
        JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    JS_FreeAtom(ctx, value_atom);

    JS_SetPropertyStr(ctx, obj, "valueOf",
        JS_NewCFunction(ctx, wasm3_global_valueOf, "valueOf", 0));
    JS_SetPropertyStr(ctx, obj, "mutable", JS_NewBool(ctx, is_mutable));

    return obj;
}

/* ================================================================
 * Error subclass helpers — CompileError, LinkError, RuntimeError
 * ================================================================ */

static JSValue wasm3_error_constructor(JSContext *ctx, JSValueConst new_target,
                                       int argc, JSValueConst *argv)
{
    JSValue msg = (argc >= 1 && JS_IsString(argv[0])) ? JS_DupValue(ctx, argv[0])
                                                       : JS_NewString(ctx, "");
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "message", msg);
    JS_SetPropertyStr(ctx, obj, "name",
        JS_GetPropertyStr(ctx, new_target, "name"));
    return obj;
}

static JSValue wasm3_throw_compile_error(JSContext *ctx, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    char buf[256];
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue wasm_obj = JS_GetPropertyStr(ctx, global, "WebAssembly");
    JS_FreeValue(ctx, global);
    JSValue ctor = JS_GetPropertyStr(ctx, wasm_obj, "CompileError");
    JS_FreeValue(ctx, wasm_obj);

    JSValue msg = JS_NewString(ctx, buf);
    JSValue err = JS_CallConstructor(ctx, ctor, 1, &msg);
    JS_FreeValue(ctx, msg);
    JS_FreeValue(ctx, ctor);
    return JS_Throw(ctx, err);
}

static JSValue wasm3_throw_link_error(JSContext *ctx, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    char buf[256];
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue wasm_obj = JS_GetPropertyStr(ctx, global, "WebAssembly");
    JS_FreeValue(ctx, global);
    JSValue ctor = JS_GetPropertyStr(ctx, wasm_obj, "LinkError");
    JS_FreeValue(ctx, wasm_obj);

    JSValue msg = JS_NewString(ctx, buf);
    JSValue err = JS_CallConstructor(ctx, ctor, 1, &msg);
    JS_FreeValue(ctx, msg);
    JS_FreeValue(ctx, ctor);
    return JS_Throw(ctx, err);
}

/* ================================================================
 * Extension hooks
 * ================================================================ */

static int wasm3_ext_init(qz_ext_t *ext, qz_t *rt)
{
    (void)ext;
    JSContext *ctx = qz_get_active_jsctx(rt);
    if (!ctx) return -1;

    /* Initialize wasm3 environment (per-runtime, once) */
    if (!rt->wasm3_env) {
        rt->wasm3_env = m3_NewEnvironment();
        if (!rt->wasm3_env) {
            return -1;
        }
    }

    wasm3_register_classes(rt, ctx);

    JSValue global = JS_GetGlobalObject(ctx);

    JSAtom wasm_atom = JS_NewAtom(ctx, "WebAssembly");
    int has_wasm = JS_HasProperty(ctx, global, wasm_atom);
    JS_FreeAtom(ctx, wasm_atom);

    if (has_wasm) {
        JS_FreeValue(ctx, global);
        return 0;
    }

    JSValue wasm_obj = JS_NewObject(ctx);
    if (JS_IsException(wasm_obj)) {
        JS_FreeValue(ctx, global);
        return -1;
    }

    JS_SetPropertyStr(ctx, wasm_obj, "validate",
        JS_NewCFunction(ctx, wasm3_wasm_validate, "validate", 1));
    JS_SetPropertyStr(ctx, wasm_obj, "compile",
        JS_NewCFunction(ctx, wasm3_wasm_compile, "compile", 1));
    JS_SetPropertyStr(ctx, wasm_obj, "instantiate",
        JS_NewCFunction(ctx, wasm3_wasm_instantiate, "instantiate", 2));
    JS_SetPropertyStr(ctx, wasm_obj, "compileStreaming",
        JS_NewCFunctionMagic(ctx, wasm3_wasm_streaming, "compileStreaming", 1, JS_CFUNC_generic_magic, 0));
    JS_SetPropertyStr(ctx, wasm_obj, "instantiateStreaming",
        JS_NewCFunctionMagic(ctx, wasm3_wasm_streaming, "instantiateStreaming", 1, JS_CFUNC_generic_magic, 1));

    JSValue module_ctor = JS_NewCFunction2(ctx, wasm3_module_constructor,
                                           "Module", 1, JS_CFUNC_constructor, 0);
    JSValue instance_ctor = JS_NewCFunction2(ctx, wasm3_instance_constructor,
                                             "Instance", 1, JS_CFUNC_constructor, 0);
    JSValue memory_ctor = JS_NewCFunction2(ctx, wasm3_memory_constructor,
                                           "Memory", 1, JS_CFUNC_constructor, 0);
    JSValue table_ctor = JS_NewCFunction2(ctx, wasm3_table_constructor,
                                          "Table", 1, JS_CFUNC_constructor, 0);
    JSValue global_ctor = JS_NewCFunction2(ctx, wasm3_global_constructor,
                                           "Global", 1, JS_CFUNC_constructor, 0);

    JS_SetPropertyStr(ctx, module_ctor, "exports",
        JS_NewCFunction(ctx, wasm3_module_exports, "exports", 1));
    JS_SetPropertyStr(ctx, module_ctor, "imports",
        JS_NewCFunction(ctx, wasm3_module_imports, "imports", 1));
    JS_SetPropertyStr(ctx, module_ctor, "customSections",
        JS_NewCFunction(ctx, wasm3_module_custom_sections, "customSections", 2));

    JS_SetPropertyStr(ctx, wasm_obj, "Module", module_ctor);
    JS_SetPropertyStr(ctx, wasm_obj, "Instance", instance_ctor);
    JS_SetPropertyStr(ctx, wasm_obj, "Memory", memory_ctor);
    JS_SetPropertyStr(ctx, wasm_obj, "Table", table_ctor);
    JS_SetPropertyStr(ctx, wasm_obj, "Global", global_ctor);

    /* CompileError — proper subclass of Error */
    JSValue compile_error_proto = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, compile_error_proto, "name", JS_NewString(ctx, "CompileError"));
    JS_SetPropertyStr(ctx, compile_error_proto, "message", JS_NewString(ctx, ""));
    JSValue compile_error = JS_NewCFunction2(ctx, wasm3_error_constructor,
                                              "CompileError", 1, JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, compile_error, compile_error_proto);
    JS_SetPropertyStr(ctx, wasm_obj, "CompileError", compile_error);
    JS_FreeValue(ctx, compile_error_proto);

    /* LinkError — proper subclass of Error */
    JSValue link_error_proto = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, link_error_proto, "name", JS_NewString(ctx, "LinkError"));
    JS_SetPropertyStr(ctx, link_error_proto, "message", JS_NewString(ctx, ""));
    JSValue link_error = JS_NewCFunction2(ctx, wasm3_error_constructor,
                                           "LinkError", 1, JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, link_error, link_error_proto);
    JS_SetPropertyStr(ctx, wasm_obj, "LinkError", link_error);
    JS_FreeValue(ctx, link_error_proto);

    /* RuntimeError — proper subclass of Error */
    JSValue runtime_error_proto = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, runtime_error_proto, "name", JS_NewString(ctx, "RuntimeError"));
    JS_SetPropertyStr(ctx, runtime_error_proto, "message", JS_NewString(ctx, ""));
    JSValue runtime_error = JS_NewCFunction2(ctx, wasm3_error_constructor,
                                              "RuntimeError", 1, JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, runtime_error, runtime_error_proto);
    JS_SetPropertyStr(ctx, wasm_obj, "RuntimeError", runtime_error);
    JS_FreeValue(ctx, runtime_error_proto);

    JS_SetPropertyStr(ctx, global, "WebAssembly", wasm_obj);

    JS_FreeValue(ctx, global);

    (void)ext;
    return 0;
}

static void wasm3_ext_destroy(qz_ext_t *ext, qz_t *rt)
{
    (void)ext;
    /* 注意：不能在这里清空 wasm3_*_class_id——qzjs teardown 顺序是
     * ctx_destroy（含本 destroy）→ JS_FreeRuntime，而 JS_FreeRuntime 内部
     * 的 JS_RunGC 依赖 gc_mark 用 class_id 经 JS_GetOpaque 取 wrap；清零后
     * gc_mark 全部失效 → module↔instance 环不可收集 → 断言 gc_obj_list
     * 非空。每个 runtime 是全新 qz_t（calloc，字段天然 0），JS_NewClassID
     * 在 register_classes 里重新分配，无需手动重置。 */
    /* Free the wasm3 environment (was previously leaked) */
    if (rt->wasm3_env) {
        m3_FreeEnvironment((IM3Environment)rt->wasm3_env);
        rt->wasm3_env = NULL;
    }
}

static int wasm3_ext_suspend(qz_ext_t *ext, qz_t *rt)
{
    (void)ext;
    (void)rt;
    return 0;
}

static int wasm3_ext_resume(qz_ext_t *ext, qz_t *rt)
{
    (void)ext;
    (void)rt;
    return 0;
}
#else /* !QZ_WITH_WASM3 — stub implementation */

/* ================================================================
 * Stub WebAssembly implementation — throws "engine not linked"
 * ================================================================ */

static JSValue wasm3_throw_not_linked(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    (void)this_val;
    (void)argc;
    (void)argv;
    return JS_ThrowTypeError(ctx, "WebAssembly wasm3 engine not linked");
}

static const JSCFunctionListEntry wasm3_module_funcs[] = {
    JS_CFUNC_DEF("validate", 1, wasm3_throw_not_linked),
    JS_CFUNC_DEF("compile", 1, wasm3_throw_not_linked),
    JS_CFUNC_DEF("instantiate", 1, wasm3_throw_not_linked),
};

static JSValue wasm3_stub_constructor(JSContext *ctx, JSValueConst new_target,
                                      int argc, JSValueConst *argv)
{
    (void)new_target;
    (void)argc;
    (void)argv;
    return JS_ThrowTypeError(ctx, "WebAssembly: wasm3 engine not linked");
}

static int wasm3_ext_init(qz_ext_t *ext, qz_t *rt)
{
    JSContext *ctx = qz_get_active_jsctx(rt);
    if (!ctx) return -1;

    JSValue global = JS_GetGlobalObject(ctx);

    JSAtom wasm_atom = JS_NewAtom(ctx, "WebAssembly");
    int has_wasm = JS_HasProperty(ctx, global, wasm_atom);
    JS_FreeAtom(ctx, wasm_atom);

    if (has_wasm) {
        JS_FreeValue(ctx, global);
        return 0;
    }

    JSValue wasm_obj = JS_NewObject(ctx);
    if (JS_IsException(wasm_obj)) {
        JS_FreeValue(ctx, global);
        return -1;
    }

    JS_SetPropertyFunctionList(ctx, wasm_obj, wasm3_module_funcs,
                               sizeof(wasm3_module_funcs) / sizeof(wasm3_module_funcs[0]));

    JSValue module_ctor = JS_NewCFunction2(ctx, wasm3_stub_constructor,
                                           "Module", 1, JS_CFUNC_constructor, 0);
    JSValue instance_ctor = JS_NewCFunction2(ctx, wasm3_stub_constructor,
                                             "Instance", 1, JS_CFUNC_constructor, 0);
    JSValue memory_ctor = JS_NewCFunction2(ctx, wasm3_stub_constructor,
                                           "Memory", 1, JS_CFUNC_constructor, 0);
    JSValue table_ctor = JS_NewCFunction2(ctx, wasm3_stub_constructor,
                                          "Table", 1, JS_CFUNC_constructor, 0);
    JSValue global_ctor = JS_NewCFunction2(ctx, wasm3_stub_constructor,
                                           "Global", 1, JS_CFUNC_constructor, 0);

    JS_SetPropertyStr(ctx, wasm_obj, "Module", module_ctor);
    JS_SetPropertyStr(ctx, wasm_obj, "Instance", instance_ctor);
    JS_SetPropertyStr(ctx, wasm_obj, "Memory", memory_ctor);
    JS_SetPropertyStr(ctx, wasm_obj, "Table", table_ctor);
    JS_SetPropertyStr(ctx, wasm_obj, "Global", global_ctor);

    JSValue compile_error = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, wasm_obj, "CompileError", compile_error);

    JSValue link_error = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, wasm_obj, "LinkError", link_error);

    JSValue runtime_error = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, wasm_obj, "RuntimeError", runtime_error);

    JS_SetPropertyStr(ctx, global, "WebAssembly", wasm_obj);

    JS_FreeValue(ctx, global);

    (void)ext;
    return 0;
}

static void wasm3_ext_destroy(qz_ext_t *ext, qz_t *rt)
{
    (void)ext;
    (void)rt;
}

static int wasm3_ext_suspend(qz_ext_t *ext, qz_t *rt)
{
    (void)ext;
    (void)rt;
    return 0;
}

static int wasm3_ext_resume(qz_ext_t *ext, qz_t *rt)
{
    (void)ext;
    (void)rt;
    return 0;
}
#endif /* QZ_WITH_WASM3 */

/* ================================================================
 * Extension definition
 * ================================================================ */

const qz_ext_t qz_wasm3_ext = {
    .name = "wasm3",
    .init = wasm3_ext_init,
    .destroy = wasm3_ext_destroy,
    .suspend = wasm3_ext_suspend,
    .resume = wasm3_ext_resume,
    .user_data = NULL,
};
