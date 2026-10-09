/*
 * qzjs WAMR Extension
 *
 * WASM runtime using WAMR (WebAssembly Micro Runtime) engine.
 * Pure sandbox model — WASM modules have NO access to system APIs:
 * no filesystem, no network, no host functions. Only pure
 * computation + linear memory.
 * When QZ_WITH_WAMR is enabled, uses real WAMR engine.
 * Otherwise, provides stub JS API surface that throws on use.
 */

#include "qz_internal.h"
#include <string.h>
#include <stdlib.h>
#include <sched.h>   /* sched_yield: WAMR singleton init spin */
#if QZ_WITH_WAMR
#include "wasm_export.h"

/* Suppress cast-function-type warnings for QuickJS getter/setter CFunctions.
 * ext_wasm3.c uses the same pattern — QuickJS dispatches by JSCFunctionEnum,
 * so the function signatures align at runtime despite the cast. */
#if defined(__GNUC__) || defined(__clang__)
#define _QZ_WAMR_DIAG_PUSH _Pragma("GCC diagnostic push")
#define _QZ_WAMR_DIAG_IGNORE_CAST _Pragma("GCC diagnostic ignored \"-Wcast-function-type\"")
/* WAMR's NativeSymbol.func_ptr is `void *`, so registering a raw native means
 * storing a function address in an object pointer. ISO C forbids that
 * conversion; it is nevertheless the documented WAMR ABI. */
#define _QZ_WAMR_DIAG_IGNORE_PEDANTIC _Pragma("GCC diagnostic ignored \"-Wpedantic\"")
#define _QZ_WAMR_DIAG_POP _Pragma("GCC diagnostic pop")
#else
#define _QZ_WAMR_DIAG_PUSH
#define _QZ_WAMR_DIAG_IGNORE_CAST
#define _QZ_WAMR_DIAG_IGNORE_PEDANTIC
#define _QZ_WAMR_DIAG_POP
#endif

/* ================================================================
 * WAMR per-extension state
 * ================================================================ */

typedef struct wamr_state_t {
    uint32_t initialized;   /* CAS state: 0=uninit 1=ready 2=init-in-progress */
} wamr_state_t;
static wamr_state_t g_wamr_state;   /* process singleton, M-R1 §13.2: see CAS state machine in wamr_ensure_runtime */

/* Ensure the WAMR runtime is initialized (process-once) and this thread has
 * its signal env. Called lazily from the JS entry points that actually touch
 * the WAMR API — a runtime that never uses WebAssembly never pays init.
 * Returns 0 on success, -1 on failure. Idempotent: the CAS state machine
 * makes the real init run exactly once per process, and WAMR's
 * wasm_runtime_init_thread_env is a no-op when the thread env exists.
 *
 * Initialize WAMR runtime (once). M-R1 §13.2: 多实例（如并发 worker
 * 线程同时走到这里）必须只让一个线程跑 wasm_runtime_init——WAMR 全局
 * 状态（内存池/函数表）不支持并发 init。CAS 状态机：
 *   0 = 未初始化 → CAS 报主者 → init → 置 1
 *   1 = 已初始化 / 初始化完成 → 直接通过
 *   2 = 初始化进行中（非报主者 spin 等待；报主者失败回滚到 0）
 * 项目严格 -std=c99（无 _Atomic）：uint32_t + __atomic 内建，与
 * bridge.c g_qz_next_port_id 同款。 */
static int wamr_ensure_runtime(void)
{
    {
        uint32_t zero = 0, inprogress = 2;
        if (__atomic_compare_exchange_n(&g_wamr_state.initialized, &zero,
                                        inprogress, 0, __ATOMIC_ACQ_REL,
                                        __ATOMIC_ACQUIRE)) {
            if (!wasm_runtime_init()) {
                __atomic_store_n(&g_wamr_state.initialized, 0,
                                 __ATOMIC_RELEASE);   /* 回滚：后续实例可重试 */
                return -1;
            }
            __atomic_store_n(&g_wamr_state.initialized, 1, __ATOMIC_RELEASE);
        } else {
            while (__atomic_load_n(&g_wamr_state.initialized,
                                   __ATOMIC_ACQUIRE) != 1)
                sched_yield();   /* 并发实例等首次 init 落定 */
        }
    }

    /* Per-thread signal env: 每个 qzjs 实例跑在自己的 worker 线程上，而
     * WAMR 的 thread signal env（thread_signal_inited）是线程局部状态，
     * 仅在首次 runtime init 的线程里被设置。不初始化的话，第二个及以后
     * 的实例（新线程）调用 wasm 函数会报
     * "thread signal env not inited"。该调用幂等（thread_signal_inited
     * 已置位时直接返回成功）。 */
    if (!wasm_runtime_init_thread_env()) {
        return -1;
    }
    return 0;
}

/* ================================================================
 * Opaque JS object helpers — wrap WAMR handles for GC
 * ================================================================ */

typedef struct wamr_import_slot_t wamr_import_slot_t;
typedef struct wamr_import_closure_t wamr_import_closure_t;
typedef struct wamr_import_module_t wamr_import_module_t;

typedef struct wamr_module_wrap_t {
    wasm_module_t module;
    uint8_t *wasm_buf;
    uint32_t wasm_buf_size;
    /* WASM imports: natives are registered at load time because WAMR resolves
     * import symbols during wasm_runtime_load (not instantiate). import_slots
     * are the native attachments (identify each import); import_modules are
     * the per-module-name NativeSymbol groups. Both owned here, released by
     * wamr_free_module_imports in the module finalizer. */
    wamr_import_slot_t **import_slots;
    uint32_t import_slot_count;
    wamr_import_module_t *import_modules;
    uint32_t import_module_count;
} wamr_module_wrap_t;

/* One declared function import of a loaded module, registered as a WAMR raw
 * native at module load time. The NativeSymbol attachment points here; the
 * per-instance dispatch uses (module_name, field_name) to find the JS
 * function supplied by the instance's importObject. Owned by the module wrap. */
struct wamr_import_slot_t {
    char *module_name;   /* js_malloc'd */
    char *field_name;    /* js_malloc'd */
    char *signature;     /* WAMR raw signature "(params)result" (js_malloc'd) */
};

/* Per-instance binding for one WASM imported function, built from the
 * importObject in the Instance constructor and found by the dispatch via the
 * import slot's (module_name, field_name). Owned by the instance wrap. */
struct wamr_import_closure_t {
    JSContext *ctx;
    char *module_name;   /* js_malloc'd */
    char *field_name;    /* js_malloc'd */
    JSValue js_func;     /* the JS function to call */
    uint32_t param_count;    /* <= 16 */
    wasm_valkind_t ptypes[16];
    uint32_t result_count;   /* 0 or 1 */
    wasm_valkind_t rtype;
};

/* NativeSymbol group for one import module name. Registered with WAMR by the
 * module wrap; unregistered + freed in the module finalizer. */
struct wamr_import_module_t {
    char *module_name;       /* js_malloc'd */
    NativeSymbol *symbols;   /* js_malloc'd array (WAMR qsorts it in place) */
    uint32_t count;
};

typedef struct wamr_instance_wrap_t {
    wasm_module_inst_t module_inst;
    wasm_exec_env_t exec_env;
    JSValue module_obj;  /* keep module alive — unload happens after instance dies */
    /* Per-instance WASM import bindings (from the importObject). */
    wamr_import_closure_t **import_closures;  /* js_malloc'd ptr array */
    uint32_t import_closure_count;
    /* JS exception captured when an imported JS function throws, rethrown by
     * the exported-function caller (wamr_call_exported_func). JS_UNDEFINED
     * when none pending. */
    JSValue pending_exception;
} wamr_instance_wrap_t;


/* Release the module wrap's import registration state: unregister each native
 * group (so WAMR's global list stops referencing the symbol arrays) and free
 * the slots (attachments) + groups. Safe on a zeroed wrap. */
static void wamr_free_module_imports(JSRuntime *jsrt, wamr_module_wrap_t *wrap)
{
    uint32_t i;
    for (i = 0; i < wrap->import_slot_count; i++) {
        wamr_import_slot_t *s = wrap->import_slots[i];
        if (!s) continue;
        js_free_rt(jsrt, s->module_name);
        js_free_rt(jsrt, s->field_name);
        js_free_rt(jsrt, s->signature);
        js_free_rt(jsrt, s);
    }
    js_free_rt(jsrt, wrap->import_slots);
    for (i = 0; i < wrap->import_module_count; i++) {
        wamr_import_module_t *m = &wrap->import_modules[i];
        if (m->module_name && m->symbols) {
            wasm_runtime_unregister_natives(m->module_name, m->symbols);
        }
        js_free_rt(jsrt, m->module_name);
        js_free_rt(jsrt, m->symbols);
    }
    js_free_rt(jsrt, wrap->import_modules);
    wrap->import_slots = NULL;
    wrap->import_slot_count = 0;
    wrap->import_modules = NULL;
    wrap->import_module_count = 0;
}

static void wamr_module_finalizer(JSRuntime *jsrt, JSValue val)
{
    qz_t *rt = qz_get_rt_from_jsrt(jsrt);
    if (!rt) return;
    wamr_module_wrap_t *wrap = (wamr_module_wrap_t *)JS_GetOpaque(val, rt->wamr_module_class_id);
    if (wrap) {
        wamr_free_module_imports(jsrt, wrap);
        if (wrap->module) {
            wasm_runtime_unload(wrap->module);
            wrap->module = NULL;
        }
        if (wrap->wasm_buf) {
            wasm_runtime_free(wrap->wasm_buf);
            wrap->wasm_buf = NULL;
        }
        js_free_rt(jsrt, wrap);
    }
}

/* Release the instance wrap's per-instance import bindings (closures own the
 * dup'd JS functions) and the pending-exception value. Safe on a zeroed wrap. */
static void wamr_free_instance_imports(JSRuntime *jsrt, wamr_instance_wrap_t *wrap)
{
    uint32_t i;
    for (i = 0; i < wrap->import_closure_count; i++) {
        wamr_import_closure_t *ic = wrap->import_closures[i];
        if (!ic) continue;
        JS_FreeValueRT(jsrt, ic->js_func);
        js_free_rt(jsrt, ic->module_name);
        js_free_rt(jsrt, ic->field_name);
        js_free_rt(jsrt, ic);
    }
    js_free_rt(jsrt, wrap->import_closures);
    JS_FreeValueRT(jsrt, wrap->pending_exception);
    wrap->import_closures = NULL;
    wrap->import_closure_count = 0;
    wrap->pending_exception = JS_UNDEFINED;
}

static void wamr_instance_finalizer(JSRuntime *jsrt, JSValue val)
{
    qz_t *rt = qz_get_rt_from_jsrt(jsrt);
    if (!rt) return;
    wamr_instance_wrap_t *wrap = (wamr_instance_wrap_t *)JS_GetOpaque(val, rt->wamr_instance_class_id);
    if (wrap) {
        wamr_free_instance_imports(jsrt, wrap);
        if (wrap->exec_env) {
            wasm_runtime_destroy_exec_env(wrap->exec_env);
            wrap->exec_env = NULL;
        }
        if (wrap->module_inst) {
            /* The wrap is reachable from module_inst via custom data; drop it
             * before the instance is deinstantiated. */
            wasm_runtime_set_custom_data(wrap->module_inst, NULL);
            wasm_runtime_deinstantiate(wrap->module_inst);
            wrap->module_inst = NULL;
        }
        JS_FreeValueRT(jsrt, wrap->module_obj);
        js_free_rt(jsrt, wrap);
    }
}

static void wamr_global_class_finalizer(JSRuntime *jsrt, JSValue val);

static void wamr_register_classes(qz_t *rt, JSContext *ctx)
{
    JSRuntime *jsrt = JS_GetRuntime(ctx);

    /* Module class */
    JS_NewClassID(jsrt, &rt->wamr_module_class_id);
    JSClassDef module_class = {
        .class_name = "WebAssembly.Module",
        .finalizer = wamr_module_finalizer,
    };
    JS_NewClass(jsrt, rt->wamr_module_class_id, &module_class);

    /* Instance class */
    JS_NewClassID(jsrt, &rt->wamr_instance_class_id);
    JSClassDef instance_class = {
        .class_name = "WebAssembly.Instance",
        .finalizer = wamr_instance_finalizer,
    };
    JS_NewClass(jsrt, rt->wamr_instance_class_id, &instance_class);

    /* Global class (for live mutable global wrappers) */
    JS_NewClassID(jsrt, &rt->wamr_global_class_id);
    JSClassDef global_class = {
        .class_name = "WebAssembly.Global",
        .finalizer = wamr_global_class_finalizer,
    };
    JS_NewClass(jsrt, rt->wamr_global_class_id, &global_class);
}

/* ================================================================
 * WASM global live getter/setter — wraps a pointer to the
 * WASM module's global data, so reads/writes reflect the live value.
 * Uses QuickJS getter/setter with JS_DefinePropertyGetSet.
 *
 * The global wrapper is a JS object with wamr_global_class_id whose
 * opaque is a wamr_global_closure_t*.
 * ================================================================ */

typedef struct wamr_global_closure_t {
    wasm_module_inst_t mod_inst;
    void *global_data;
    wasm_valkind_t kind;
    /* Keeps the owning WAMR instance alive: the global wrapper reads
     * global_data (memory inside the instance) and must not outlive it. */
    JSValue instance_ref;
} wamr_global_closure_t;

/* Owner of an exported linear-memory ArrayBuffer. The ArrayBuffer wraps
 * WAMR memory owned by the instance; holding a JS reference to the instance
 * (freed when the ArrayBuffer is finalized) prevents the instance from being
 * deinstantiated while exports.memory is still referenced. */
typedef struct wamr_mem_owner_t {
    JSValue instance_ref;
} wamr_mem_owner_t;

/* JSReallocArrayBufferDataFunc shim: holds a JS reference to the WAMR
 * instance while the ArrayBuffer lives. size==0 releases the owner. */
static void *wamr_mem_owner_realloc(JSRuntime *jsrt, void *opaque, void *ptr, size_t size)
{
    wamr_mem_owner_t *owner = (wamr_mem_owner_t *)opaque;
    if (size == 0) {
        if (owner) {
            JS_FreeValueRT(jsrt, owner->instance_ref);
            js_free_rt(jsrt, owner);
        }
        return NULL;
    }
    (void)ptr;
    return ptr; /* fixed-size: nothing to resize */
}

static void wamr_global_class_finalizer(JSRuntime *jsrt, JSValue val)
{
    qz_t *rt = qz_get_rt_from_jsrt(jsrt);
    if (!rt) return;
    wamr_global_closure_t *gc = (wamr_global_closure_t *)
        JS_GetOpaque(val, rt->wamr_global_class_id);
    if (gc) {
        JS_FreeValueRT(jsrt, gc->instance_ref);
        js_free_rt(jsrt, gc);
    }
}

_QZ_WAMR_DIAG_PUSH
_QZ_WAMR_DIAG_IGNORE_CAST

static JSValue wamr_global_value_get(JSContext *ctx, JSValueConst this_val)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_UNDEFINED;
    wamr_global_closure_t *gc = (wamr_global_closure_t *)
        JS_GetOpaque(this_val, rt->wamr_global_class_id);
    if (!gc) return JS_UNDEFINED;
    if (gc->kind == WASM_I32)
        return JS_NewInt32(ctx, *(int32_t *)gc->global_data);
    else if (gc->kind == WASM_I64)
        return JS_NewInt64(ctx, *(int64_t *)gc->global_data);
    else if (gc->kind == WASM_F32)
        return JS_NewFloat64(ctx, (double)*(float *)gc->global_data);
    else if (gc->kind == WASM_F64)
        return JS_NewFloat64(ctx, *(double *)gc->global_data);
    return JS_UNDEFINED;
}

static JSValue wamr_global_value_set(JSContext *ctx, JSValueConst this_val,
                                      JSValueConst val)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_UNDEFINED;
    wamr_global_closure_t *gc = (wamr_global_closure_t *)
        JS_GetOpaque(this_val, rt->wamr_global_class_id);
    if (!gc) return JS_UNDEFINED;
    if (gc->kind == WASM_I32) {
        int32_t iv;
        if (JS_ToInt32(ctx, &iv, val) == 0)
            *(int32_t *)gc->global_data = iv;
    } else if (gc->kind == WASM_I64) {
        int64_t iv;
        if (JS_ToInt64(ctx, &iv, val) == 0)
            *(int64_t *)gc->global_data = iv;
    } else if (gc->kind == WASM_F32) {
        double dv;
        if (JS_ToFloat64(ctx, &dv, val) == 0)
            *(float *)gc->global_data = (float)dv;
    } else if (gc->kind == WASM_F64) {
        double dv;
        if (JS_ToFloat64(ctx, &dv, val) == 0)
            *(double *)gc->global_data = dv;
    }
    return JS_UNDEFINED;
}

_QZ_WAMR_DIAG_POP

/* ================================================================
 * Helper: extract byte buffer from ArrayBuffer or TypedArray
 * ================================================================ */

static int wamr_extract_buffer(JSContext *ctx, JSValueConst val,
                               uint8_t **out_bytes, size_t *out_len)
{
    size_t byte_len = 0;
    uint8_t *bytes = NULL;

    if (JS_IsArrayBuffer(val)) {
        bytes = JS_GetArrayBuffer(ctx, &byte_len, val);
    } else {
        /* Try as TypedArray — get the underlying buffer */
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

static JSValue wamr_wasm_validate(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    (void)this_val;
    if (wamr_ensure_runtime() != 0) {
        return JS_ThrowInternalError(ctx, "WebAssembly: WAMR runtime init failed");
    }
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "WebAssembly.validate requires at least 1 argument");
    }

    uint8_t *bytes;
    size_t byte_len;
    if (wamr_extract_buffer(ctx, argv[0], &bytes, &byte_len) < 0) {
        return JS_ThrowTypeError(ctx, "WebAssembly.validate: argument must be ArrayBuffer or TypedArray");
    }

    char error_buf[128] = {0};
    wasm_module_t module = wasm_runtime_load(bytes, (uint32_t)byte_len,
                                             error_buf, sizeof(error_buf));
    if (module) {
        wasm_runtime_unload(module);
        return JS_TRUE;
    }
    return JS_FALSE;
}

/* ================================================================
 * WebAssembly.compile(bufferSource) -> Promise<Module>
 * ================================================================ */

static JSValue wamr_wasm_compile(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "WebAssembly.compile requires at least 1 argument");
    }

    /* Call new Module(bufferSource) */
    JSValue module_ctor = JS_GetPropertyStr(ctx, this_val, "Module");
    JSValue result = JS_CallConstructor(ctx, module_ctor, 1, argv);
    JS_FreeValue(ctx, module_ctor);

    if (JS_IsException(result)) {
        return result;
    }

    /* Wrap in a resolved promise */
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

static JSValue wamr_wasm_instantiate(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "WebAssembly.instantiate requires at least 1 argument");
    }

    JSValue instance_ctor = JS_GetPropertyStr(ctx, this_val, "Instance");
    int is_module_arg = (JS_GetOpaque(argv[0], rt->wamr_module_class_id) != NULL);

    JSValue instance_result;
    JSValue module_result = JS_UNDEFINED;

    if (is_module_arg) {
        /* Module arg — just instantiate */
        JSValue inst_args[2] = { argv[0], argc >= 2 ? argv[1] : JS_UNDEFINED };
        instance_result = JS_CallConstructor(ctx, instance_ctor, argc >= 2 ? 2 : 1, inst_args);
    } else {
        /* Buffer arg — compile + instantiate */
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

    /* Wrap in a resolved promise */
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
        /* Buffer+instantiate returns {module, instance} */
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
static JSValue wamr_wasm_streaming(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv, int magic)
{
    (void)this_val;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx,
            "WebAssembly.*Streaming requires at least 1 argument");
    }
    /* async IIFE：resolve source → arrayBuffer() → compile / instantiate。
     * options（AOT 旁路 {aot, aotFail}）原样透传给 compile/instantiate。 */
    const char *compile_prog =
        "(async function(src, options) {                                  "
        "  var r = (src && typeof src.then === 'function') ? await src : src;"
        "  if (!r || typeof r.arrayBuffer !== 'function')                 "
        "    throw new TypeError('streaming source must provide arrayBuffer()');"
        "  var buf = await r.arrayBuffer();                               "
        "  return WebAssembly.compile(buf, options);                      "
        "})";
    const char *instantiate_prog =
        "(async function(src, imports, options) {                         "
        "  var r = (src && typeof src.then === 'function') ? await src : src;"
        "  if (!r || typeof r.arrayBuffer !== 'function')                 "
        "    throw new TypeError('streaming source must provide arrayBuffer()');"
        "  var buf = await r.arrayBuffer();                               "
        "  return WebAssembly.instantiate(buf, imports, options);         "
        "})";
    const char *prog = magic ? instantiate_prog : compile_prog;
    JSValue fn = JS_Eval(ctx, prog, strlen(prog), "<wasm-streaming>",
                         JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(fn)) return fn;
    /* 三个位置参数（src, [imports], [options]）按 argc 透传 */
    JSValue args[3];
    args[0] = argv[0];
    args[1] = (argc >= 2) ? argv[1] : JS_UNDEFINED;
    args[2] = (argc >= 3) ? argv[2] : JS_UNDEFINED;
    JSValue result = JS_Call(ctx, fn, JS_UNDEFINED, 3, args);
    JS_FreeValue(ctx, fn);
    return result;
}

/* WASM imports: register a raw native per declared function import at module
 * load time (WAMR links imports during load). Defined below; the Module
 * constructor calls it. */
static int wamr_register_module_imports(JSContext *ctx, wamr_module_wrap_t *wrap);

/* ================================================================
 * WebAssembly.Module constructor
 * ================================================================ */

static JSValue wamr_module_constructor(JSContext *ctx, JSValueConst new_target,
                                       int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    (void)new_target;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "WebAssembly.Module requires at least 1 argument");
    }

    /* If already a Module, return copy */
    wamr_module_wrap_t *existing = (wamr_module_wrap_t *)JS_GetOpaque(argv[0], rt->wamr_module_class_id);
    if (existing) {
        return JS_DupValue(ctx, argv[0]);
    }

    if (wamr_ensure_runtime() != 0) {
        return JS_ThrowInternalError(ctx, "WebAssembly: WAMR runtime init failed");
    }
    uint8_t *bytes;
    size_t byte_len;
    if (wamr_extract_buffer(ctx, argv[0], &bytes, &byte_len) < 0) {
        return JS_ThrowTypeError(ctx, "WebAssembly.Module: argument must be ArrayBuffer or TypedArray");
    }

    if (byte_len == 0) {
        return JS_ThrowTypeError(ctx, "WebAssembly.Module: empty buffer");
    }

    /* Copy the wasm binary — WAMR needs it to remain valid */
    uint8_t *wasm_buf = (uint8_t *)wasm_runtime_malloc((uint32_t)byte_len);
    if (!wasm_buf) {
        return JS_ThrowOutOfMemory(ctx);
    }
    memcpy(wasm_buf, bytes, byte_len);

    char error_buf[128] = {0};
    wasm_module_t module = wasm_runtime_load(wasm_buf, (uint32_t)byte_len,
                                             error_buf, sizeof(error_buf));
    if (!module) {
        wasm_runtime_free(wasm_buf);
        return JS_ThrowTypeError(ctx, "WebAssembly.Module: %s", error_buf);
    }

    wamr_module_wrap_t *wrap = (wamr_module_wrap_t *)js_mallocz(ctx, sizeof(wamr_module_wrap_t));
    if (!wrap) {
        wasm_runtime_unload(module);
        wasm_runtime_free(wasm_buf);
        return JS_ThrowOutOfMemory(ctx);
    }
    wrap->module = module;
    wrap->wasm_buf = wasm_buf;
    wrap->wasm_buf_size = (uint32_t)byte_len;
    /* WASM imports: WAMR resolves import symbols at load time, so register a
     * raw native per declared function import and re-load the module — the
     * second load links the imports into the module used by instances.
     * Note: wasm_runtime_load rewrites its input buffer in place, so the
     * re-load must copy the pristine bytes from the caller's buffer. */
    if (wasm_runtime_get_import_count(module) > 0) {
        if (wamr_register_module_imports(ctx, wrap) != 0) {
            wasm_runtime_unload(module);
            wasm_runtime_free(wasm_buf);
            js_free(ctx, wrap);
            return JS_EXCEPTION;   /* exception already thrown */
        }
        uint8_t *linked_buf = (uint8_t *)wasm_runtime_malloc((uint32_t)byte_len);
        if (!linked_buf) {
            wamr_free_module_imports(JS_GetRuntime(ctx), wrap);
            wasm_runtime_unload(module);
            wasm_runtime_free(wasm_buf);
            js_free(ctx, wrap);
            return JS_ThrowOutOfMemory(ctx);
        }
        memcpy(linked_buf, bytes, byte_len);
        wasm_module_t linked = wasm_runtime_load(linked_buf, (uint32_t)byte_len,
                                                 error_buf, sizeof(error_buf));
        if (!linked) {
            wasm_runtime_free(linked_buf);
            wamr_free_module_imports(JS_GetRuntime(ctx), wrap);
            wasm_runtime_unload(module);
            wasm_runtime_free(wasm_buf);
            js_free(ctx, wrap);
            return JS_ThrowTypeError(ctx, "WebAssembly.Module: %s",
                                     error_buf[0] ? error_buf : "import linking failed");
        }
        wasm_runtime_unload(module);
        wasm_runtime_free(wasm_buf);
        wrap->module = linked;
        wrap->wasm_buf = linked_buf;
        wrap->wasm_buf_size = (uint32_t)byte_len;
    }

    JSValue obj = JS_NewObjectClass(ctx, rt->wamr_module_class_id);
    if (JS_IsException(obj)) {
        wasm_runtime_unload(module);
        wasm_runtime_free(wasm_buf);
        js_free(ctx, wrap);
        return JS_EXCEPTION;
    }
    JS_SetOpaque(obj, wrap);

    return obj;
}

/* ================================================================
 * WASM function call wrapper (C function, called by JS)
 * ================================================================ */

typedef struct wamr_func_closure_t {
    wasm_module_inst_t mod_inst;
    wasm_exec_env_t exec_env;
    wasm_function_inst_t func;
    uint32_t param_count;
    uint32_t result_count;
} wamr_func_closure_t;

static void wamr_func_closure_finalizer(void *opaque)
{
    /* The closure was allocated with malloc() — not js_malloc — because
     * JSCClosureFinalizerFunc has no JSRuntime parameter. Free with free(). */
    wamr_func_closure_t *fc = (wamr_func_closure_t *)opaque;
    free(fc);
}

/* ================================================================
 * WASM imports support — bridge WASM imported functions to JS
 * ================================================================
 *
 * WAMR resolves import symbols during wasm_runtime_load, not instantiate.
 * So the Module constructor registers a raw native for every declared
 * function import (grouped by import module name) and re-loads the module so
 * the resolved pointers are baked in. The Instance constructor then builds a
 * per-instance map from importObject (module+field → JS function) and stashes
 * it on the wrap, which is attached to the module instance via custom_data.
 * At call time the raw-native dispatch reads its attachment (an
 * wamr_import_slot_t identifying the import), looks up the JS function in the
 * current instance's map, converts args/results, and calls it. */

/* Build a WAMR raw-native signature string "(params)result" from a WASM
 * function type. Returns a js_malloc'd string, or NULL on OOM / unsupported
 * types. The result character is omitted when the function returns nothing. */
static char *wamr_build_import_signature(JSContext *ctx, const wasm_func_type_t ft)
{
    uint32_t pc = wasm_func_type_get_param_count(ft);
    uint32_t rc = wasm_func_type_get_result_count(ft);
    size_t len = 2 + (size_t)pc + (size_t)rc + 1; /* '(' params ')' [result] NUL */
    char *sig = (char *)js_malloc(ctx, len);
    if (!sig) return NULL;
    char *p = sig;
    *p++ = '(';
    for (uint32_t i = 0; i < pc; i++) {
        switch (wasm_func_type_get_param_valkind(ft, i)) {
        case WASM_I32: *p++ = 'i'; break;
        case WASM_I64: *p++ = 'I'; break;
        case WASM_F32: *p++ = 'f'; break;
        case WASM_F64: *p++ = 'F'; break;
        default: js_free(ctx, sig); return NULL;
        }
    }
    *p++ = ')';
    if (rc > 0) {
        switch (wasm_func_type_get_result_valkind(ft, 0)) {
        case WASM_I32: *p++ = 'i'; break;
        case WASM_I64: *p++ = 'I'; break;
        case WASM_F32: *p++ = 'f'; break;
        case WASM_F64: *p++ = 'F'; break;
        default: js_free(ctx, sig); return NULL;
        }
    }
    *p = '\0';
    return sig;
}

/* Raw-native entry point for every WASM imported function (registered via
 * wasm_runtime_register_natives_raw, so all signatures share this C shape).
 * WAMR args[] layout: params live in args[0..param_count-1] (i32/f32 occupy
 * the low 32 bits of their uint64 slot, i64/f64 the full slot); the return
 * value, if any, is written back into args[0]. */
static void wamr_import_dispatch(wasm_exec_env_t exec_env, uint64_t *args)
{
    wamr_import_slot_t *slot = (wamr_import_slot_t *)
        wasm_runtime_get_function_attachment(exec_env);
    if (!slot) return;   /* WAMR already reported a missing native */

    wasm_module_inst_t mod_inst = wasm_runtime_get_module_inst(exec_env);
    wamr_instance_wrap_t *wrap = mod_inst
        ? (wamr_instance_wrap_t *)wasm_runtime_get_custom_data(mod_inst)
        : NULL;

    /* Find the JS function this instance supplied for (module, field). */
    wamr_import_closure_t *ic = NULL;
    if (wrap) {
        for (uint32_t i = 0; i < wrap->import_closure_count; i++) {
            wamr_import_closure_t *c = wrap->import_closures[i];
            if (c && strcmp(c->module_name, slot->module_name) == 0
                    && strcmp(c->field_name, slot->field_name) == 0) {
                ic = c;
                break;
            }
        }
    }
    if (!ic) {
        /* Instance not yet reachable (import called from the start function
         * during instantiation) or the importObject lacked this binding. */
        if (mod_inst)
            wasm_runtime_set_exception(mod_inst,
                "missing import function in importObject");
        return;
    }

    JSContext *ctx = ic->ctx;

    /* Convert WASM params to JS values. */
    JSValue js_args[16];
    uint32_t i, n = ic->param_count;
    if (n > 16) n = 16;
    for (i = 0; i < n; i++) {
        uint64_t raw = args[i];
        switch (ic->ptypes[i]) {
        case WASM_I32:
            js_args[i] = JS_NewInt32(ctx, (int32_t)(uint32_t)raw);
            break;
        case WASM_I64:
            js_args[i] = JS_NewBigInt64(ctx, (int64_t)raw);
            break;
        case WASM_F32: {
            float f;
            memcpy(&f, &raw, sizeof(float));
            js_args[i] = JS_NewFloat64(ctx, (double)f);
            break;
        }
        case WASM_F64: {
            double d;
            memcpy(&d, &raw, sizeof(double));
            js_args[i] = JS_NewFloat64(ctx, d);
            break;
        }
        default:
            js_args[i] = JS_UNDEFINED;
            break;
        }
    }

    JSValue result = JS_Call(ctx, ic->js_func, JS_UNDEFINED, n, js_args);
    for (i = 0; i < n; i++)
        JS_FreeValue(ctx, js_args[i]);

    if (JS_IsException(result)) {
        /* Consume the pending JS exception and stash it on the owning instance
         * so the exported-function caller rethrows it (instead of a generic
         * trap message). If the instance isn't reachable yet, drop it and let
         * WAMR surface its own error. */
        JSValue exc = JS_GetException(ctx);
        if (wrap) {
            JS_FreeValue(ctx, wrap->pending_exception);
            wrap->pending_exception = exc;
        } else {
            JS_FreeValue(ctx, exc);
        }
        if (mod_inst)
            wasm_runtime_set_exception(mod_inst, "JS import function threw");
        return;
    }

    if (ic->result_count > 0) {
        int conv_failed = 0;
        switch (ic->rtype) {
        case WASM_I32: {
            int32_t v;
            if (JS_ToInt32(ctx, &v, result) != 0)
                conv_failed = 1;
            else
                args[0] = (uint64_t)(uint32_t)v;
            break;
        }
        case WASM_I64: {
            int64_t v;
            if (JS_ToInt64Ext(ctx, &v, result) != 0)
                conv_failed = 1;
            else
                args[0] = (uint64_t)v;
            break;
        }
        case WASM_F32: {
            double d;
            if (JS_ToFloat64(ctx, &d, result) != 0) {
                conv_failed = 1;
            } else {
                float f = (float)d;
                memcpy(&args[0], &f, sizeof(float));
            }
            break;
        }
        case WASM_F64: {
            double d;
            if (JS_ToFloat64(ctx, &d, result) != 0) {
                conv_failed = 1;
            } else {
                memcpy(&args[0], &d, sizeof(double));
            }
            break;
        }
        default:
            break;
        }
        JS_FreeValue(ctx, result);
        if (conv_failed) {
            JSValue exc = JS_GetException(ctx);
            if (wrap) {
                JS_FreeValue(ctx, wrap->pending_exception);
                wrap->pending_exception = exc;
            } else {
                JS_FreeValue(ctx, exc);
            }
            if (mod_inst)
                wasm_runtime_set_exception(mod_inst, "JS import function threw");
        }
    } else {
        JS_FreeValue(ctx, result);
    }
}

/* Register a raw native for every declared function import of wrap->module,
 * grouped by import module name, so a subsequent wasm_runtime_load resolves
 * the imports. Each NativeSymbol attachment is the import's wamr_import_slot_t
 * (identifies module+field at dispatch time). Non-function imports (memory/
 * global/table) are intentionally not registered — the Instance constructor
 * rejects them with a clear error (documented limitation).
 *
 * On success fills wrap->import_slots / wrap->import_modules (owned by the
 * wrap; released by wamr_free_module_imports). Returns 0, or -1 with a JS
 * exception already thrown. */
static int wamr_register_module_imports(JSContext *ctx, wamr_module_wrap_t *wrap)
{
    int32_t import_count = (int32_t)wasm_runtime_get_import_count(wrap->module);
    if (import_count <= 0) return 0;

    wamr_import_module_t *mods = NULL;
    uint32_t n_mods = 0;
    wamr_import_slot_t **slots = NULL;
    uint32_t n_slots = 0;
    int32_t i;

    for (i = 0; i < import_count; i++) {
        wasm_import_t imp;
        wasm_runtime_get_import_type(wrap->module, i, &imp);
        if (!imp.module_name || !imp.name) continue;
        if (imp.kind != WASM_IMPORT_EXPORT_KIND_FUNC) continue; /* instance-time error */

        wasm_func_type_t ft = imp.u.func_type;
        wamr_import_slot_t *slot = (wamr_import_slot_t *)
            js_mallocz(ctx, sizeof(*slot));
        if (!slot) {
            JS_ThrowOutOfMemory(ctx);
            goto fail;
        }
        size_t mlen = strlen(imp.module_name);
        size_t flen = strlen(imp.name);
        slot->module_name = (char *)js_malloc(ctx, mlen + 1);
        slot->field_name = (char *)js_malloc(ctx, flen + 1);
        slot->signature = wamr_build_import_signature(ctx, ft);
        if (!slot->module_name || !slot->field_name || !slot->signature) {
            if (slot->module_name) js_free(ctx, slot->module_name);
            if (slot->field_name) js_free(ctx, slot->field_name);
            if (slot->signature) js_free(ctx, slot->signature);
            js_free(ctx, slot);
            JS_ThrowOutOfMemory(ctx);
            goto fail;
        }
        memcpy(slot->module_name, imp.module_name, mlen + 1);
        memcpy(slot->field_name, imp.name, flen + 1);

        wamr_import_slot_t **ns = (wamr_import_slot_t **)js_realloc(
            ctx, slots, sizeof(*slots) * (n_slots + 1));
        if (!ns) {
            js_free(ctx, slot->module_name);
            js_free(ctx, slot->field_name);
            js_free(ctx, slot->signature);
            js_free(ctx, slot);
            JS_ThrowOutOfMemory(ctx);
            goto fail;
        }
        slots = ns;
        slots[n_slots++] = slot;

        /* Find (or create) the NativeSymbol group for this module name. */
        wamr_import_module_t *m = NULL;
        for (uint32_t mi = 0; mi < n_mods; mi++) {
            if (strcmp(mods[mi].module_name, imp.module_name) == 0) {
                m = &mods[mi];
                break;
            }
        }
        if (!m) {
            wamr_import_module_t *nm = (wamr_import_module_t *)js_realloc(
                ctx, mods, sizeof(*mods) * (n_mods + 1));
            if (!nm) {
                JS_ThrowOutOfMemory(ctx);
                goto fail;
            }
            mods = nm;
            m = &mods[n_mods];
            n_mods++;
            m->count = 0;
            m->symbols = NULL;
            m->module_name = (char *)js_malloc(ctx, mlen + 1);
            if (!m->module_name) {
                JS_ThrowOutOfMemory(ctx);
                goto fail;
            }
            memcpy(m->module_name, imp.module_name, mlen + 1);
        }
        NativeSymbol *sym = (NativeSymbol *)js_realloc(
            ctx, m->symbols, sizeof(NativeSymbol) * (m->count + 1));
        if (!sym) {
            JS_ThrowOutOfMemory(ctx);
            goto fail;
        }
        m->symbols = sym;
        NativeSymbol *entry = &m->symbols[m->count++];
        entry->symbol = slot->field_name;
        _QZ_WAMR_DIAG_PUSH
        _QZ_WAMR_DIAG_IGNORE_PEDANTIC
        entry->func_ptr = (void *)wamr_import_dispatch;
        _QZ_WAMR_DIAG_POP
        entry->signature = slot->signature;
        entry->attachment = slot;
    }

    for (uint32_t mi = 0; mi < n_mods; mi++) {
        if (!wasm_runtime_register_natives_raw(mods[mi].module_name,
                                               mods[mi].symbols,
                                               mods[mi].count)) {
            JS_ThrowTypeError(ctx,
                "WebAssembly.Module: failed to register native imports for module \"%s\"",
                mods[mi].module_name);
            goto fail;
        }
    }

    wrap->import_slots = slots;
    wrap->import_slot_count = n_slots;
    wrap->import_modules = mods;
    wrap->import_module_count = n_mods;
    return 0;

fail:
    for (uint32_t mi = 0; mi < n_mods; mi++) {
        if (mods[mi].module_name && mods[mi].symbols) {
            wasm_runtime_unregister_natives(mods[mi].module_name, mods[mi].symbols);
        }
        js_free(ctx, mods[mi].module_name);
        js_free(ctx, mods[mi].symbols);
    }
    js_free(ctx, mods);
    for (uint32_t si = 0; si < n_slots; si++) {
        wamr_import_slot_t *s = slots[si];
        if (!s) continue;
        js_free(ctx, s->module_name);
        js_free(ctx, s->field_name);
        js_free(ctx, s->signature);
        js_free(ctx, s);
    }
    js_free(ctx, slots);
    return -1;
}

/* Build the per-instance import bindings: for every declared function import
 * of `module`, look up the JS function in importObject and record a closure.
 * Returns 0 on success (fills wrap->import_closures, owned by the wrap), or
 * -1 with a JS exception already thrown. */
static int wamr_build_instance_imports(JSContext *ctx, wasm_module_t module,
                                       JSValueConst import_obj,
                                       wamr_instance_wrap_t *wrap)
{
    int32_t import_count = (int32_t)wasm_runtime_get_import_count(module);
    if (import_count <= 0) return 0;

    wamr_import_closure_t **closures = NULL;
    uint32_t n_closures = 0;
    int32_t i;

    for (i = 0; i < import_count; i++) {
        wasm_import_t imp;
        wasm_runtime_get_import_type(module, i, &imp);
        if (!imp.module_name || !imp.name) continue;

        /* Only function imports are implemented; memory/global/table imports
         * fail fast with a clear message (documented limitation). */
        if (imp.kind != WASM_IMPORT_EXPORT_KIND_FUNC) {
            JS_ThrowTypeError(ctx,
                "WebAssembly.Instance: WAMR engine does not support %s imports "
                "(import \"%s\" \"%s\"); only function imports are implemented",
                imp.kind == WASM_IMPORT_EXPORT_KIND_MEMORY ? "memory" :
                imp.kind == WASM_IMPORT_EXPORT_KIND_GLOBAL ? "global" : "table",
                imp.module_name, imp.name);
            goto fail;
        }

        /* Look up the JS binding: importObject[module][field]. */
        JSValue mod_val = JS_GetPropertyStr(ctx, import_obj, imp.module_name);
        if (JS_IsException(mod_val) || JS_IsUndefined(mod_val)) {
            JS_FreeValue(ctx, mod_val);
            JS_ThrowTypeError(ctx,
                "WebAssembly.Instance: missing import module \"%s\" in importObject "
                "(module imports \"%s\")", imp.module_name, imp.name);
            goto fail;
        }
        JSValue field_val = JS_GetPropertyStr(ctx, mod_val, imp.name);
        JS_FreeValue(ctx, mod_val);
        if (JS_IsException(field_val) || JS_IsUndefined(field_val)) {
            JS_FreeValue(ctx, field_val);
            JS_ThrowTypeError(ctx,
                "WebAssembly.Instance: missing import \"%s.%s\" in importObject",
                imp.module_name, imp.name);
            goto fail;
        }
        if (!JS_IsFunction(ctx, field_val)) {
            JS_ThrowTypeError(ctx,
                "WebAssembly.Instance: import \"%s.%s\" is not a function",
                imp.module_name, imp.name);
            JS_FreeValue(ctx, field_val);
            goto fail;
        }

        wasm_func_type_t ft = imp.u.func_type;
        uint32_t pc = wasm_func_type_get_param_count(ft);
        uint32_t rc = wasm_func_type_get_result_count(ft);
        if (pc > 16) {
            JS_ThrowTypeError(ctx,
                "WebAssembly.Instance: import \"%s.%s\" has %u parameters (>16 unsupported)",
                imp.module_name, imp.name, pc);
            JS_FreeValue(ctx, field_val);
            goto fail;
        }
        if (rc > 1) {
            JS_ThrowTypeError(ctx,
                "WebAssembly.Instance: import \"%s.%s\" has %u results (>1 unsupported)",
                imp.module_name, imp.name, rc);
            JS_FreeValue(ctx, field_val);
            goto fail;
        }

        wamr_import_closure_t *ic = (wamr_import_closure_t *)
            js_mallocz(ctx, sizeof(*ic));
        if (!ic) {
            JS_ThrowOutOfMemory(ctx);
            JS_FreeValue(ctx, field_val);
            goto fail;
        }
        ic->ctx = ctx;
        ic->js_func = field_val;   /* transfer ownership into the closure */
        ic->param_count = pc;
        ic->result_count = rc;
        if (rc > 0)
            ic->rtype = wasm_func_type_get_result_valkind(ft, 0);
        for (uint32_t k = 0; k < pc; k++)
            ic->ptypes[k] = wasm_func_type_get_param_valkind(ft, k);

        size_t mlen = strlen(imp.module_name);
        size_t flen = strlen(imp.name);
        ic->module_name = (char *)js_malloc(ctx, mlen + 1);
        ic->field_name = (char *)js_malloc(ctx, flen + 1);
        if (!ic->module_name || !ic->field_name) {
            if (ic->module_name) js_free(ctx, ic->module_name);
            if (ic->field_name) js_free(ctx, ic->field_name);
            JS_FreeValue(ctx, ic->js_func);
            js_free(ctx, ic);
            JS_ThrowOutOfMemory(ctx);
            goto fail;
        }
        memcpy(ic->module_name, imp.module_name, mlen + 1);
        memcpy(ic->field_name, imp.name, flen + 1);

        wamr_import_closure_t **nc = (wamr_import_closure_t **)js_realloc(
            ctx, closures, sizeof(*closures) * (n_closures + 1));
        if (!nc) {
            JS_FreeValue(ctx, ic->js_func);
            js_free(ctx, ic->module_name);
            js_free(ctx, ic->field_name);
            js_free(ctx, ic);
            JS_ThrowOutOfMemory(ctx);
            goto fail;
        }
        closures = nc;
        closures[n_closures++] = ic;
    }

    wrap->import_closures = closures;
    wrap->import_closure_count = n_closures;
    return 0;

fail:
    for (uint32_t ci = 0; ci < n_closures; ci++) {
        wamr_import_closure_t *c = closures[ci];
        if (!c) continue;
        JS_FreeValue(ctx, c->js_func);
        js_free(ctx, c->module_name);
        js_free(ctx, c->field_name);
        js_free(ctx, c);
    }
    js_free(ctx, closures);
    return -1;
}

static JSValue wamr_call_exported_func(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv,
                                       int magic, void *opaque)
{
    (void)this_val;
    (void)magic;
    wamr_func_closure_t *fc = (wamr_func_closure_t *)opaque;
    if (!fc) return JS_ThrowTypeError(ctx, "invalid WASM function closure");

    /* wargs[]/results[] are fixed-size stack arrays (16 params, 4 results);
     * WAMR supports larger arities, so reject such signatures up front —
     * otherwise the loops below would write out of bounds. */
    if (fc->param_count > 16 || fc->result_count > 4) {
        return JS_ThrowRangeError(ctx,
            "WebAssembly function: too many parameters (>16) or results (>4)");
    }

    /* Fetch the real parameter types — previously every argument was forced
     * to WASM_I32, corrupting f32/f64/i64 values. */
    wasm_valkind_t ptypes[16];
    wasm_func_get_param_types(fc->func, fc->mod_inst, ptypes);

    uint32_t n = fc->param_count;
    if ((uint32_t)argc < n) n = (uint32_t)argc;

    wasm_val_t wargs[16];
    memset(wargs, 0, sizeof(wargs));
    uint32_t j;
    for (j = 0; j < n; j++) {
        wargs[j].kind = ptypes[j];
        switch (ptypes[j]) {
        case WASM_I32:
            if (JS_ToInt32(ctx, &wargs[j].of.i32, argv[j]) != 0)
                return JS_ThrowTypeError(ctx, "WebAssembly function: invalid i32 argument %u", j);
            break;
        case WASM_I64:
            if (JS_ToInt64(ctx, &wargs[j].of.i64, argv[j]) != 0)
                return JS_ThrowTypeError(ctx, "WebAssembly function: invalid i64 argument %u", j);
            break;
        case WASM_F32: {
            double dv;
            if (JS_ToFloat64(ctx, &dv, argv[j]) != 0)
                return JS_ThrowTypeError(ctx, "WebAssembly function: invalid f32 argument %u", j);
            wargs[j].of.f32 = (float)dv;
            break;
        }
        case WASM_F64:
            if (JS_ToFloat64(ctx, &wargs[j].of.f64, argv[j]) != 0)
                return JS_ThrowTypeError(ctx, "WebAssembly function: invalid f64 argument %u", j);
            break;
        default:
            return JS_ThrowTypeError(ctx,
                "WebAssembly function: unsupported parameter type %d", (int)ptypes[j]);
        }
    }
    /* Missing arguments (argc < param_count) default to zero with the correct kind. */
    for (j = n; j < fc->param_count; j++) {
        wargs[j].kind = ptypes[j];
    }

    wasm_val_t results[4];
    bool ok = wasm_runtime_call_wasm_a(fc->exec_env, fc->func,
        fc->result_count, results, fc->param_count, wargs);
    if (!ok) {
        /* If an imported JS function threw during the call, propagate the
         * original JS exception instead of a generic WASM trap message. */
        wamr_instance_wrap_t *wrap = fc->mod_inst
            ? (wamr_instance_wrap_t *)wasm_runtime_get_custom_data(fc->mod_inst)
            : NULL;
        if (wrap && !JS_IsUndefined(wrap->pending_exception)) {
            JSValue exc = wrap->pending_exception;
            wrap->pending_exception = JS_UNDEFINED;
            wasm_runtime_clear_exception(fc->mod_inst);
            return JS_Throw(ctx, exc);
        }
        const char *err = wasm_runtime_get_exception(fc->mod_inst);
        return JS_ThrowTypeError(ctx, "WebAssembly function: %s",
            err ? err : "trap");
    }

    if (fc->result_count == 0) return JS_UNDEFINED;
    if (results[0].kind == WASM_I32)
        return JS_NewInt32(ctx, results[0].of.i32);
    else if (results[0].kind == WASM_I64)
        return JS_NewInt64(ctx, results[0].of.i64);
    else if (results[0].kind == WASM_F32)
        return JS_NewFloat64(ctx, (double)results[0].of.f32);
    else if (results[0].kind == WASM_F64)
        return JS_NewFloat64(ctx, results[0].of.f64);
    return JS_UNDEFINED;
}

/* ================================================================
 * WebAssembly.Instance constructor
 * ================================================================ */

static JSValue wamr_instance_constructor(JSContext *ctx, JSValueConst new_target,
                                         int argc, JSValueConst *argv)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_NULL;
    (void)new_target;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "WebAssembly.Instance requires at least 1 argument");
    }

    wamr_module_wrap_t *mod_wrap = (wamr_module_wrap_t *)JS_GetOpaque(argv[0], rt->wamr_module_class_id);
    if (!mod_wrap || !mod_wrap->module) {
        return JS_ThrowTypeError(ctx, "WebAssembly.Instance: first argument must be a WebAssembly.Module");
    }

    if (wamr_ensure_runtime() != 0) {
        return JS_ThrowInternalError(ctx, "WebAssembly: WAMR runtime init failed");
    }

    /* Import-object support: resolve every declared import against the
     * importObject (argv[1]) and register the JS functions as WAMR natives
     * before instantiation. A module that declares imports without a usable
     * importObject fails fast with a clear TypeError. */
    int import_count = (int)wasm_runtime_get_import_count(mod_wrap->module);
    if (import_count < 0) import_count = 0;

    wamr_instance_wrap_t *wrap = NULL;
    if (import_count > 0) {
        if (argc < 2 || JS_IsUndefined(argv[1])) {
            return JS_ThrowTypeError(ctx,
                "WebAssembly.Instance: module declares %d import(s) but no "
                "importObject was provided", import_count);
        }
        if (!JS_IsObject(argv[1])) {
            return JS_ThrowTypeError(ctx,
                "WebAssembly.Instance: importObject must be an object");
        }
        wrap = (wamr_instance_wrap_t *)js_mallocz(ctx, sizeof(*wrap));
        if (!wrap) return JS_ThrowOutOfMemory(ctx);
        wrap->pending_exception = JS_UNDEFINED;
        if (wamr_build_instance_imports(ctx, mod_wrap->module, argv[1], wrap) != 0) {
            wamr_free_instance_imports(JS_GetRuntime(ctx), wrap);
            js_free(ctx, wrap);
            return JS_EXCEPTION;   /* exception already thrown */
        }
    }

    /* Instantiate */
    char error_buf[128] = {0};
    wasm_module_inst_t module_inst = wasm_runtime_instantiate(mod_wrap->module,
                                                              64 * 1024,
                                                              8 * 1024 * 1024,
                                                              error_buf, sizeof(error_buf));
    if (!module_inst) {
        if (wrap) {
            wamr_free_instance_imports(JS_GetRuntime(ctx), wrap);
            js_free(ctx, wrap);
        }
        return JS_ThrowTypeError(ctx, "WebAssembly.Instance: %s",
                                 error_buf[0] ? error_buf : "instantiation failed");
    }

    /* Create exec env */
    wasm_exec_env_t exec_env = wasm_runtime_create_exec_env(module_inst, 64 * 1024);
    if (!exec_env) {
        wasm_runtime_deinstantiate(module_inst);
        if (wrap) {
            wamr_free_instance_imports(JS_GetRuntime(ctx), wrap);
            js_free(ctx, wrap);
        }
        return JS_ThrowOutOfMemory(ctx);
    }

    if (!wrap) {
        wrap = (wamr_instance_wrap_t *)js_mallocz(ctx, sizeof(*wrap));
        if (!wrap) {
            wasm_runtime_destroy_exec_env(exec_env);
            wasm_runtime_deinstantiate(module_inst);
            return JS_ThrowOutOfMemory(ctx);
        }
        wrap->pending_exception = JS_UNDEFINED;
    }
    wrap->module_inst = module_inst;
    wrap->exec_env = exec_env;
    wrap->module_obj = JS_DupValue(ctx, argv[0]);  /* keep module alive until instance dies */

    /* Attach the wrap to the module instance so import dispatch can reach the
     * pending-exception slot (and so exported calls can rethrow it). */
    wasm_runtime_set_custom_data(module_inst, wrap);

    JSValue obj = JS_NewObjectClass(ctx, rt->wamr_instance_class_id);
    if (JS_IsException(obj)) {
        wasm_runtime_destroy_exec_env(exec_env);
        wasm_runtime_deinstantiate(module_inst);
        wamr_free_instance_imports(JS_GetRuntime(ctx), wrap);
        js_free(ctx, wrap);
        return JS_EXCEPTION;
    }
    JS_SetOpaque(obj, wrap);

    /* Build the exports object via WAMR-2.4.5 export-enumeration API */
    JSValue exports = JS_NewObject(ctx);
    int export_count = (int)wasm_runtime_get_export_count(mod_wrap->module);
    int i;

    for (i = 0; i < export_count; i++) {
        wasm_export_t exp;
        wasm_runtime_get_export_type(mod_wrap->module, i, &exp);
        /* Validate: name is non-NULL for valid exports */
        if (!exp.name) continue;

        switch (exp.kind) {
        case WASM_IMPORT_EXPORT_KIND_FUNC: {
            wasm_function_inst_t func = wasm_runtime_lookup_function(
                module_inst, exp.name);
            if (!func) continue;

            /* Capture necessary state for the JS function wrapper.
             * Use malloc (not js_malloc) because the JSCClosure finalizer
             * receives no JSRuntime and must free with free(). */
            wamr_func_closure_t *fc = (wamr_func_closure_t *)
                malloc(sizeof(wamr_func_closure_t));
            if (!fc) continue;
            fc->mod_inst = module_inst;
            fc->exec_env = exec_env;
            fc->func = func;
            fc->param_count = wasm_func_get_param_count(func, module_inst);
            fc->result_count = wasm_func_get_result_count(func, module_inst);

            /* Create a JS function via JSCClosure that carries the closure
             * pointer as opaque data. */
            JSValue js_func = JS_NewCClosure(ctx,
                (JSCClosure *)wamr_call_exported_func,
                exp.name,
                wamr_func_closure_finalizer,
                (int)fc->param_count, 0 /* magic */, fc);

            JS_SetPropertyStr(ctx, exports, exp.name, js_func);
            break;
        }
        case WASM_IMPORT_EXPORT_KIND_MEMORY: {
            /* WAMR doesn't have a name-based memory lookup; use the first
             * memory instance. This is correct for the common single-memory
             * case. Multi-memory modules would need an index tracker. */
            wasm_memory_inst_t mem = wasm_runtime_get_memory(module_inst, 0);
            if (!mem) { continue; }

            uint64_t num_pages = wasm_memory_get_cur_page_count(mem);
            uint64_t max_pages = wasm_memory_get_max_page_count(mem);
            size_t byte_len = (size_t)num_pages * 65536;
            uint8_t *base = (uint8_t *)wasm_memory_get_base_address(mem);

            JSValue mem_obj = JS_NewObject(ctx);
            /* The ArrayBuffer wraps WAMR memory owned by the instance. Give
             * it an owner that holds a JS reference to the instance, so the
             * instance cannot be deinstantiated (freeing the memory) while
             * exports.memory is still referenced — fixes a use-after-free. */
            wamr_mem_owner_t *owner = (wamr_mem_owner_t *)js_malloc(ctx, sizeof(*owner));
            if (!owner) continue;
            JSValue ab = JS_NewArrayBuffer(ctx, base, byte_len, 0,
                                           wamr_mem_owner_realloc, owner, 0);
            if (JS_IsException(ab)) {
                wamr_mem_owner_realloc(JS_GetRuntime(ctx), owner, NULL, 0);
                continue;
            }
            JS_SetPropertyStr(ctx, mem_obj, "buffer", ab);
            JS_SetPropertyStr(ctx, mem_obj, "_initial",
                              JS_NewInt32(ctx, (int32_t)num_pages));
            if (max_pages > 0 && max_pages < UINT32_MAX) {
                JS_SetPropertyStr(ctx, mem_obj, "_maximum",
                                  JS_NewInt32(ctx, (int32_t)max_pages));
            }
            JS_SetPropertyStr(ctx, exports, exp.name, mem_obj);
            break;
        }
        case WASM_IMPORT_EXPORT_KIND_GLOBAL: {
            wasm_global_inst_t gi;
            if (!wasm_runtime_get_export_global_inst(module_inst, exp.name,
                                                      &gi)) {
                continue;
            }

            wamr_global_closure_t *gc = (wamr_global_closure_t *)
                js_malloc(ctx, sizeof(wamr_global_closure_t));
            if (!gc) continue;
            gc->mod_inst = module_inst;
            gc->global_data = gi.global_data;
            gc->kind = gi.kind;

            JSValue global_obj;
            if (gi.is_mutable) {
                /* Mutable: use JS_NewObjectClass with opaque, and
                 * JS_DefinePropertyGetSet for live .value access */
                global_obj = JS_NewObjectClass(ctx, rt->wamr_global_class_id);
                /* Hold a reference to the instance: the getter/setter read
                 * global_data (memory inside the instance), which must not be
                 * deinstantiated while this wrapper is alive (UAF fix). */
                gc->instance_ref = JS_DupValue(ctx, obj);
                JS_SetOpaque(global_obj, gc);

                JSAtom value_atom = JS_NewAtom(ctx, "value");
                _QZ_WAMR_DIAG_PUSH
                _QZ_WAMR_DIAG_IGNORE_CAST
                JS_DefinePropertyGetSet(ctx, global_obj,
                    value_atom,
                    JS_NewCFunction2(ctx, (JSCFunction *)wamr_global_value_get,
                        "get value", 0, JS_CFUNC_getter, 0),
                    JS_NewCFunction2(ctx, (JSCFunction *)wamr_global_value_set,
                        "set value", 1, JS_CFUNC_setter, 0),
                    JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
                _QZ_WAMR_DIAG_POP
                JS_FreeAtom(ctx, value_atom);
            } else {
                /* Immutable: plain object with snapshot value */
                global_obj = JS_NewObject(ctx);
                js_free(ctx, gc); /* closure not needed for immutable */
                JSValue val;
                if (gi.kind == WASM_I32) {
                    val = JS_NewInt32(ctx, *(int32_t *)gi.global_data);
                } else if (gi.kind == WASM_I64) {
                    val = JS_NewInt64(ctx, *(int64_t *)gi.global_data);
                } else if (gi.kind == WASM_F32) {
                    val = JS_NewFloat64(ctx, (double)*(float *)gi.global_data);
                } else if (gi.kind == WASM_F64) {
                    val = JS_NewFloat64(ctx, *(double *)gi.global_data);
                } else {
                    val = JS_UNDEFINED;
                }
                JS_SetPropertyStr(ctx, global_obj, "value", val);
            }

            JS_SetPropertyStr(ctx, global_obj, "mutable",
                              JS_NewBool(ctx, gi.is_mutable));
            JS_SetPropertyStr(ctx, exports, exp.name, global_obj);
            break;
        }
        case WASM_IMPORT_EXPORT_KIND_TABLE:
            break;
        }
    }

    JS_SetPropertyStr(ctx, obj, "exports", exports);

    return obj;
}

/* ================================================================
 * WebAssembly.Memory constructor
 * ================================================================ */

/* Finalizer shim for the standalone WebAssembly.Memory ArrayBuffer
 * (js_mallocz'd buffer owned by the array buffer). Frees via the QuickJS
 * allocator when the engine invokes realloc with size==0. */
static void *wamr_arraybuffer_realloc(JSRuntime *rt, void *opaque, void *ptr, size_t size)
{
    (void)opaque;
    if (size == 0) {
        js_free_rt(rt, ptr);
        return NULL;
    }
    return ptr; /* fixed-size: nothing to resize */
}

static JSValue wamr_memory_constructor(JSContext *ctx, JSValueConst new_target,
                                       int argc, JSValueConst *argv)
{
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

    size_t byte_len = (size_t)initial_pages * 65536;
    uint8_t *mem = (uint8_t *)js_mallocz(ctx, byte_len);
    if (!mem) {
        return JS_ThrowOutOfMemory(ctx);
    }
    JSValue obj = JS_NewObject(ctx);
    /* JS_NewArrayBuffer takes ownership of `mem`; the engine releases it via
     * wamr_arraybuffer_realloc(size=0) when the ArrayBuffer is GC'd (without
     * a realloc_func the external buffer is never freed by the engine). */
    JSValue ab = JS_NewArrayBuffer(ctx, mem, byte_len, 0, wamr_arraybuffer_realloc,
                                   NULL, 0);
    JS_SetPropertyStr(ctx, obj, "buffer", ab);

    /* Store initial/maximum for grow() */
    JS_SetPropertyStr(ctx, obj, "_initial", JS_NewInt32(ctx, initial_pages));
    if (maximum_pages >= 0) {
        JS_SetPropertyStr(ctx, obj, "_maximum", JS_NewInt32(ctx, maximum_pages));
    }

    return obj;
}

/* ================================================================
 * WebAssembly.Table constructor
 * ================================================================ */

static JSValue wamr_table_constructor(JSContext *ctx, JSValueConst new_target,
                                      int argc, JSValueConst *argv)
{
    (void)new_target;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "WebAssembly.Table requires a descriptor");
    }

    JSValue initial_val = JS_GetPropertyStr(ctx, argv[0], "initial");
    int32_t initial = 0;
    if (!JS_IsException(initial_val)) {
        JS_ToInt32(ctx, &initial, initial_val);
    }
    JS_FreeValue(ctx, initial_val);

    JSValue element_val = JS_GetPropertyStr(ctx, argv[0], "element");
    const char *element = JS_ToCString(ctx, element_val);
    JS_FreeValue(ctx, element_val);

    JSValue obj = JS_NewObject(ctx);
    JSValue array = JS_NewArray(ctx);
    for (int32_t i = 0; i < initial; i++) {
        JS_SetPropertyInt64(ctx, array, i, JS_NULL);
    }
    JS_SetPropertyStr(ctx, obj, "length", JS_NewInt32(ctx, initial));
    JS_SetPropertyStr(ctx, obj, "_array", array);
    if (element) {
        JS_SetPropertyStr(ctx, obj, "_element", JS_NewString(ctx, element));
        JS_FreeCString(ctx, element);
    }

    return obj;
}

/* ================================================================
 * WebAssembly.Global constructor
 * ================================================================ */

static JSValue wamr_global_constructor(JSContext *ctx, JSValueConst new_target,
                                       int argc, JSValueConst *argv)
{
    (void)new_target;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "WebAssembly.Global requires a descriptor");
    }

    JSValue value_val;
    if (argc >= 2) {
        value_val = JS_DupValue(ctx, argv[1]);
    } else {
        value_val = JS_NewFloat64(ctx, 0);
    }

    JSValue mutable_val = JS_GetPropertyStr(ctx, argv[0], "mutable");
    int is_mutable = 0;
    if (JS_IsBool(mutable_val)) {
        is_mutable = JS_ToBool(ctx, mutable_val);
    }
    JS_FreeValue(ctx, mutable_val);

    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "value", value_val);
    JS_SetPropertyStr(ctx, obj, "mutable", JS_NewBool(ctx, is_mutable));

    return obj;
}

/* WAMR AOT bypass (Tier 0/1): WebAssembly.compile / instantiate /
 * compileStreaming / instantiateStreaming 接受非标准可选 options 参数
 * {aot: aotBytes, aotFail?: fn}。提供 .aot 字节时 AOT 优先（wasm_runtime_load
 * 按 \0aot 魔数自动分派到 AOT 加载器）；AOT 加载失败（版本/arch/ABI/损坏）
 * 则静默回退解释器路径（fail-open，用可移植 .wasm 字节），并调用 aotFail(e)
 *（若有）暴露失败原因；仅提供 .aot 字节（无 .wasm 保底）时失败照抛 TypeError。
 * 基类 C 入口（compile/instantiate）被捕获复用，非 AOT 调用与既有 promise /
 * instance 语义完全一致。instantiate 的模块参数形式用 buffer-source 判定区分
 * （Module 对象不是 ArrayBuffer/TypedArray；不能靠 instanceof——C 构造器未接
 * .prototype，instanceof 会抛 TypeError）。
 */
static const char k_wamr_aot_shim[] =
    "(function(wasm){"
    "  var baseCompile = wasm.compile, baseInstantiate = wasm.instantiate;"
    "  var isBuffer = function(v){"
    "    return v instanceof ArrayBuffer ||"
    "      (typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(v));"
    "  };"
    "  wasm.compile = function(bytes, options){"
    "    if (options && options.aot != null) {"
    "      try { return baseCompile.call(wasm, options.aot); }"
    "      catch (e) {"
    "        if (typeof options.aotFail === 'function') options.aotFail(e);"
    "        return baseCompile.call(wasm, bytes);"
    "      }"
    "    }"
    "    return baseCompile.call(wasm, bytes);"
    "  };"
    "  wasm.instantiate = function(first, imports, options){"
    "    if (options && options.aot != null && isBuffer(first)) {"
    "      try { return Promise.resolve(baseInstantiate.call(wasm, options.aot, imports)); }"
    "      catch (e) {"
    "        if (typeof options.aotFail === 'function') options.aotFail(e);"
    "      }"
    "    }"
    "    return baseInstantiate.call(wasm, first, imports);"
    "  };"
    "})(WebAssembly);";

/* ================================================================
 * Extension hooks
 * ================================================================ */

static int wamr_ext_init(qz_ext_t *ext, qz_t *rt)
{
    JSContext *ctx = qz_get_active_jsctx(rt);
    if (!ctx) return -1;

    /* Register JS classes for Module/Instance */
    wamr_register_classes(rt, ctx);

    JSValue global = JS_GetGlobalObject(ctx);

    /* Check if WebAssembly already exists */
    JSAtom wasm_atom = JS_NewAtom(ctx, "WebAssembly");
    int has_wasm = JS_HasProperty(ctx, global, wasm_atom);
    JS_FreeAtom(ctx, wasm_atom);

    if (has_wasm) {
        JS_FreeValue(ctx, global);
        return 0;
    }

    /* Create WebAssembly object */
    JSValue wasm_obj = JS_NewObject(ctx);
    if (JS_IsException(wasm_obj)) {
        JS_FreeValue(ctx, global);
        return -1;
    }

    /* Add methods */
    JS_SetPropertyStr(ctx, wasm_obj, "validate",
        JS_NewCFunction(ctx, wamr_wasm_validate, "validate", 1));
    JS_SetPropertyStr(ctx, wasm_obj, "compile",
        JS_NewCFunction(ctx, wamr_wasm_compile, "compile", 1));
    JS_SetPropertyStr(ctx, wasm_obj, "instantiate",
        JS_NewCFunction(ctx, wamr_wasm_instantiate, "instantiate", 2));
    JS_SetPropertyStr(ctx, wasm_obj, "compileStreaming",
        JS_NewCFunctionMagic(ctx, wamr_wasm_streaming, "compileStreaming", 1, JS_CFUNC_generic_magic, 0));
    JS_SetPropertyStr(ctx, wasm_obj, "instantiateStreaming",
        JS_NewCFunctionMagic(ctx, wamr_wasm_streaming, "instantiateStreaming", 2, JS_CFUNC_generic_magic, 1));

    /* Create constructors */
    JSValue module_ctor = JS_NewCFunction2(ctx, wamr_module_constructor,
                                           "Module", 1, JS_CFUNC_constructor, 0);
    JSValue instance_ctor = JS_NewCFunction2(ctx, wamr_instance_constructor,
                                             "Instance", 1, JS_CFUNC_constructor, 0);
    JSValue memory_ctor = JS_NewCFunction2(ctx, wamr_memory_constructor,
                                           "Memory", 1, JS_CFUNC_constructor, 0);
    JSValue table_ctor = JS_NewCFunction2(ctx, wamr_table_constructor,
                                          "Table", 1, JS_CFUNC_constructor, 0);
    JSValue global_ctor = JS_NewCFunction2(ctx, wamr_global_constructor,
                                           "Global", 1, JS_CFUNC_constructor, 0);

    JS_SetPropertyStr(ctx, wasm_obj, "Module", module_ctor);
    JS_SetPropertyStr(ctx, wasm_obj, "Instance", instance_ctor);
    JS_SetPropertyStr(ctx, wasm_obj, "Memory", memory_ctor);
    JS_SetPropertyStr(ctx, wasm_obj, "Table", table_ctor);
    JS_SetPropertyStr(ctx, wasm_obj, "Global", global_ctor);

    /* CompileError, LinkError, RuntimeError */
    JSValue compile_error = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, wasm_obj, "CompileError", compile_error);

    JSValue link_error = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, wasm_obj, "LinkError", link_error);

    JSValue runtime_error = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, wasm_obj, "RuntimeError", runtime_error);

    /* Register WebAssembly on global */
    JS_SetPropertyStr(ctx, global, "WebAssembly", wasm_obj);

    /* AOT bypass shim (Tier 0/1)：给 WebAssembly.compile / instantiate 装
     * JS wrapper，接受可选 {aot, aotFail} options（AOT 优先 + fail-open 回退），
     * 基类 C 入口被捕获复用。streaming 两条 C 入口已在 shim 里透传 options。 */
    {
        JSValue shim = JS_Eval(ctx, k_wamr_aot_shim, strlen(k_wamr_aot_shim),
                               "<wasm-aot-shim>", JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(shim)) {
            JS_FreeValue(ctx, global);
            return -1;
        }
        JS_FreeValue(ctx, shim);
    }

    JS_FreeValue(ctx, global);

    (void)ext;
    return 0;
}

static void wamr_ext_destroy(qz_ext_t *ext, qz_t *rt)
{
    (void)ext;
    /* 卸载本线程安装的 WAMR signal 环境（SIGSEGV/SIGBUS handler、栈 guard
     * pages、sigaltstack）。WAMR 的 guard pages 与 signal handler 都是进程
     * 级副作用：不清理的话，下一个实例（新 worker 线程）在 os_thread_signal_init
     * 里 touch_pages 会撞上遗留的 PROT_NONE 页而 SIGSEGV。销毁发生在 worker
     * 线程内（qz_thread_teardown → qz_ctx_destroy），与本线程的
     * wasm_runtime_init_thread_env 对称。 */
    wasm_runtime_destroy_thread_env();
    /* Reset class IDs so JS_NewClassID allocates fresh ones for the next runtime */
    rt->wamr_module_class_id = 0;
    rt->wamr_instance_class_id = 0;
    rt->wamr_global_class_id = 0;
}

static int wamr_ext_suspend(qz_ext_t *ext, qz_t *rt)
{
    (void)ext;
    (void)rt;
    return 0;
}

static int wamr_ext_resume(qz_ext_t *ext, qz_t *rt)
{
    (void)ext;
    (void)rt;
    return 0;
}
#else /* !QZ_WITH_WAMR — stub implementation */

/* ================================================================
 * Stub WebAssembly implementation — throws "engine not linked"
 * ================================================================ */

static JSValue wamr_throw_not_linked(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    (void)this_val;
    (void)argc;
    (void)argv;
    return JS_ThrowTypeError(ctx, "WebAssembly WAMR engine not linked");
}

static const JSCFunctionListEntry wamr_module_funcs[] = {
    JS_CFUNC_DEF("validate", 1, wamr_throw_not_linked),
    JS_CFUNC_DEF("compile", 1, wamr_throw_not_linked),
    JS_CFUNC_DEF("instantiate", 1, wamr_throw_not_linked),
};

static JSValue wamr_stub_constructor(JSContext *ctx, JSValueConst new_target,
                                     int argc, JSValueConst *argv)
{
    (void)new_target;
    (void)argc;
    (void)argv;
    return JS_ThrowTypeError(ctx, "WebAssembly: WAMR engine not linked");
}

static int wamr_ext_init(qz_ext_t *ext, qz_t *rt)
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

    JS_SetPropertyFunctionList(ctx, wasm_obj, wamr_module_funcs,
                               sizeof(wamr_module_funcs) / sizeof(wamr_module_funcs[0]));

    JSValue module_ctor = JS_NewCFunction2(ctx, wamr_stub_constructor,
                                           "Module", 1, JS_CFUNC_constructor, 0);
    JSValue instance_ctor = JS_NewCFunction2(ctx, wamr_stub_constructor,
                                             "Instance", 1, JS_CFUNC_constructor, 0);
    JSValue memory_ctor = JS_NewCFunction2(ctx, wamr_stub_constructor,
                                           "Memory", 1, JS_CFUNC_constructor, 0);
    JSValue table_ctor = JS_NewCFunction2(ctx, wamr_stub_constructor,
                                          "Table", 1, JS_CFUNC_constructor, 0);
    JSValue global_ctor = JS_NewCFunction2(ctx, wamr_stub_constructor,
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

static void wamr_ext_destroy(qz_ext_t *ext, qz_t *rt)
{
    (void)ext;
    (void)rt;
}

static int wamr_ext_suspend(qz_ext_t *ext, qz_t *rt)
{
    (void)ext;
    (void)rt;
    return 0;
}

static int wamr_ext_resume(qz_ext_t *ext, qz_t *rt)
{
    (void)ext;
    (void)rt;
    return 0;
}

#endif /* QZ_WITH_WAMR */

/* ================================================================
 * Extension definition
 * ================================================================ */

const qz_ext_t qz_wamr_ext = {
    .name = "wamr",
    .init = wamr_ext_init,
    .destroy = wamr_ext_destroy,
    .suspend = wamr_ext_suspend,
    .resume = wamr_ext_resume,
    .user_data = NULL,
};
