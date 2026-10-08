/* wasm2c(AS 对象负载) → so 的 qz.* import 实现：纯 C + quickjs C API。
   tagged i32 值模型（bit0=0 数字 v>>1；bit0=1 handle idx>>1，表持强引用）。
   wasm2c 把 import 声明为函数指针全局变量，这里定义同名指针指向实现。 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "quickjs.h"
#include "as_obj.h"

static JSRuntime *g_rt;
static JSContext *g_ctx;
#define MAX_H 200000
static JSValue g_h[MAX_H];
static int g_n;

static const char *g_keys[] = { "a", "b" };

static int32_t enc_num(int32_t n) { return (int32_t)((uint32_t)n << 1); }
static int32_t enc_handle(int idx) { return (int32_t)(((uint32_t)idx << 1) | 1u); }
static int is_handle(int32_t v) { return v & 1; }
static int new_handle(JSValue o) {
    if (g_n >= MAX_H) { fprintf(stderr, "[qz] handle full\n"); return -1; }
    g_h[g_n] = JS_DupValue(g_ctx, o);
    return g_n++;
}
static JSValue to_js(int32_t v) {
    if (is_handle(v)) {
        int idx = v >> 1;
        if (idx < 0 || idx >= g_n) return JS_UNDEFINED;
        return JS_DupValue(g_ctx, g_h[idx]);
    }
    return JS_NewInt32(g_ctx, v >> 1);
}

static void my_dump(u32 v) {
    JSValue o = to_js((int32_t)v);
    const char *s = JS_ToCString(g_ctx, o);
    fprintf(stderr, "[dump] %s\n", s ? s : "(null)");
    if (s) JS_FreeCString(g_ctx, s);
    JS_FreeValue(g_ctx, o);
}
static u32 my_new_number(u32 n) { return (u32)enc_num((int32_t)n); }
static u32 my_new_object(void) {
    if (!g_rt) { g_rt = JS_NewRuntime(); g_ctx = JS_NewContext(g_rt); }
    return (u32)enc_handle(new_handle(JS_NewObject(g_ctx)));
}
static void my_set_prop(u32 o, u32 k, u32 v) {
    JSValue obj = to_js((int32_t)o), val = to_js((int32_t)v);
    JS_SetPropertyStr(g_ctx, obj, g_keys[k], val);
    JS_FreeValue(g_ctx, obj);
}
static u32 my_get_prop(u32 o, u32 k) {
    JSValue obj = to_js((int32_t)o);
    JSValue v = JS_GetPropertyStr(g_ctx, obj, g_keys[k]);
    int32_t out = 0;
    JS_ToInt32(g_ctx, &out, v);
    JS_FreeValue(g_ctx, v); JS_FreeValue(g_ctx, obj);
    return (u32)enc_num(out);
}

/* wasm2c import 函数指针定义 */
void (*Z_qzZ_set_propZ_viii)(u32, u32, u32) = my_set_prop;
u32 (*Z_qzZ_new_numberZ_ii)(u32) = my_new_number;
u32 (*Z_qzZ_new_objectZ_iv)(void) = my_new_object;
u32 (*Z_qzZ_get_propZ_iii)(u32, u32) = my_get_prop;
void (*Z_qzZ_dumpZ_vi)(u32) = my_dump;

/* 边界包装：导出 objbench */
typedef JSValue (*qz_aot_fn)(JSContext *ctx, JSValue *args, int argc);
static int g_inited;

static JSValue aot_objbench(JSContext *ctx, JSValue *args, int argc) {
    (void)ctx; (void)args; (void)argc;
    if (!g_inited) { init(); g_inited = 1; }
    return JS_NewInt64(ctx, (int64_t)(int32_t)Z_objbenchZ_ii(10000));
}

qz_aot_fn qz_aot_lookup(const char *name) {
    if (strcmp(name, "objbench") == 0) return aot_objbench;
    return NULL;
}
