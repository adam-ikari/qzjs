/* 手写 C 对象负载上限：直接调 quickjs C API（JS_NewObject/SetProperty/GetProperty）。
   与 AS/wasm2c 产物相同逻辑，但无 tagged 值转换、无函数指针间接——是上限基准。 */
#include <string.h>
#include <stdint.h>
#include "quickjs.h"

typedef JSValue (*qz_aot_fn)(JSContext *ctx, JSValue *args, int argc);

static int64_t objbench_c(JSContext *ctx, int32_t iters) {
    int64_t last = 0;
    for (int i = 0; i < iters; i++) {
        JSValue o = JS_NewObject(ctx);
        JSValue av = JS_NewInt32(ctx, i);
        JSValue bv = JS_NewInt32(ctx, i * 2);
        JS_SetPropertyStr(ctx, o, "a", av);
        JS_SetPropertyStr(ctx, o, "b", bv);
        JSValue ga = JS_GetPropertyStr(ctx, o, "a");
        int32_t a = 0;
        JS_ToInt32(ctx, &a, ga);
        last = a;
        JS_FreeValue(ctx, ga);
        JS_FreeValue(ctx, o);
    }
    return last;
}

static JSValue aot_objbench(JSContext *ctx, JSValue *args, int argc) {
    (void)args; (void)argc;
    return JS_NewInt64(ctx, objbench_c(ctx, 10000));
}

qz_aot_fn qz_aot_lookup(const char *name) {
    if (strcmp(name, "objbench") == 0) return aot_objbench;
    return NULL;
}
