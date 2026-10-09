/*
 * qzjs — extension: C 扩展把原生函数注册为 JS 全局
 *
 * 扩展机制：编译期把自定义 qz_ext_t 加入 QZ_EXTENSIONS 表，init 钩子在
 * 上下文创建时运行，可用 QuickJS API 注册全局（qz_get_active_jsctx 是
 * 内部辅助，声明于 src/base/qz_rt.h，仅编译进 qzjs 的扩展可用）。
 *
 * 构建（扩展必须编译进 qzjs 库，非独立可执行；在仓库根执行）：
 *   cmake -B build_ext -DCMAKE_BUILD_TYPE=Release \
 *         -DQZ_EXTRA_SOURCES="$(pwd)/examples/extension/extension.c" \
 *         -DQZ_EXTRA_HEADERS="$(pwd)/examples/extension/greet_ext.h" \
 *         -DQZ_EXTENSIONS="QZ_DEFAULT_EXTENSIONS &greet_ext"
 *   cmake --build build_ext --parallel
 * 运行（-e 丢弃表达式值，需自行 console.log）：
 *   ./build_ext/qzjs -e 'console.log(greet("qzjs"), greet(42))'
 *   # → Hello, qzjs! Hello, 42!
 */
#include <qzjs/qzjs.h>
#include <quickjs.h>
#include "../../src/base/qz_rt.h"

/* 原生函数：greet(name) → 返回字符串 */
static JSValue js_greet(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv) {
    (void)this_val;
    const char *name = argc > 0 ? JS_ToCString(ctx, argv[0]) : "world";
    char buf[128];
    snprintf(buf, sizeof buf, "Hello, %s!", name ? name : "?");
    if (name) JS_FreeCString(ctx, name);
    return JS_NewString(ctx, buf);
}

/* 扩展 init：在活动上下文上把 greet 挂为全局 */
static int greet_init(qz_ext_t *ext, qz_t *rt) {
    (void)ext;
    JSContext *ctx = qz_get_active_jsctx(rt);
    if (!ctx) return -1;
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "greet",
                      JS_NewCFunction(ctx, js_greet, "greet", 1));
    JS_FreeValue(ctx, global);
    return 0;
}

qz_ext_t greet_ext = {
    .name   = "greet",
    .init   = greet_init,
    .destroy = NULL,
    .suspend = NULL,
    .resume  = NULL,
};
