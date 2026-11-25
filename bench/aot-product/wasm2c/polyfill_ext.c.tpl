/* wasm2c → qzjs extension wrapper: 把 wasm2c 生成的 C 函数注册为 JS 全局。
 * 由 bench/aot-product/run_wasm2c_polyfill.mjs 填充 TOKEN 并编译进 qzjs。
 * 目的：实验「无 wasm 运行时设备的 polyfill 加速」——polyfill 的纯计算函数
 * 直接调用 wasm2c 原生实现，不经 wasm 引擎。 */
#include <math.h>
#include <stdint.h>
#include <qzjs/qzjs.h>
#include <quickjs.h>
#include "../../src/base/qz_rt.h"
#include "W2C_HDR"

/* qz.math_rem 唯一 import 的 C 实现 */
f64 IMPORT_IMPL
void TAIL_IMPL

static %INST% g_inst;
static int g_ready = 0;

/* hpackIntBatch(n: number): number — 与 polyfill 同算法 */
static JSValue js_hpack_batch(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    (void)this_val;
    double n = 0;
    if (argc > 0) JS_ToFloat64(ctx, &n, argv[0]);
    if (!g_ready) return JS_ThrowInternalError(ctx, "wasm2c polyfill not initialized");
    double r = %FN%( &g_inst, n);
    return JS_NewFloat64(ctx, r);
}

static int w2c_polyfill_init(qz_ext_t *ext, qz_t *rt) {
    (void)ext;
    JSContext *ctx = qz_get_active_jsctx(rt);
    if (!ctx) return -1;
    wasm_rt_init();
    %INST%_instantiate(&g_inst, NULL);   /* TOKEN: 生成名 instantiate */
    g_ready = 1;
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "hpackBatch",
                      JS_NewCFunction(ctx, js_hpack_batch, "hpackBatch", 1));
    JS_FreeValue(ctx, global);
    return 0;
}

static void w2c_polyfill_destroy(qz_ext_t *ext, qz_t *rt) {
    (void)ext; (void)rt;
    if (g_ready) { %FREE%(&g_inst); wasm_rt_free(); g_ready = 0; }
}

const qz_ext_t w2c_polyfill_ext = {
    .name = "w2c_polyfill",
    .init = w2c_polyfill_init,
    .destroy = w2c_polyfill_destroy,
    .suspend = NULL,
    .resume = NULL,
};
