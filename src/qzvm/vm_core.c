/*
 * qzvm VM 核心语义 —— eval / 字节码编译 / rt 查询。
 *
 * 边界治理（2026-10-09）：这 5 个函数原定义在宿主层（src/qzjs.c 的
 * qz_compile/qz_eval_internal/qz_eval_bytecode_internal，src/bridge.c 的
 * qz_get_rt_from_ctx/qz_get_rt_from_jsrt），但均为 VM 引擎语义（纯 quickjs
 * API + qz_t 结构查询，无宿主 I/O 依赖）。移入 qzvm，消除 VM → 宿主反向依赖：
 *   - 宿主层经 qz_internal.h 声明调用（qz_compile 由 cli.c/qzc.c 用，
 *     qz_get_rt_from_* 由宿主扩展 ext_* 用）
 *   - VM 内（context.c/ext_wamr.c/qzc.c）直接同层调用
 */

#include "qz_internal.h"
#include <string.h>
#include <stdlib.h>

/* ===== 从 src/qzjs.c / src/bridge.c 移入（边界治理：eval/rt 查询是 VM 语义）===== */
int qz_eval_internal(qz_t *rt, const char *script, char **err)
{
    JSContext *ctx = qz_get_active_jsctx(rt);
    if (!ctx) return -1;

    JSValue val = JS_Eval(ctx, script, strlen(script), "<initial>",
                          JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(val)) {
        if (err) {
            JSValue exc = JS_GetException(ctx);
            const char *msg = JS_ToCString(ctx, exc);
            *err = msg ? strdup(msg) : NULL;
            if (msg) JS_FreeCString(ctx, msg);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeValue(ctx, val);
        return -1;
    }
    JS_FreeValue(ctx, val);
    return 0;
}

/* 在活动 context 上执行预编译字节码（JS_ReadObject + JS_EvalFunction）。
 * 用于编译期注入的 JS（worker 启动垫片等），与 qz_eval_internal 的
 * 错误提取语义一致。 */
int qz_eval_bytecode_internal(qz_t *rt, const uint8_t *code, size_t len,
                                char **err)
{
    JSContext *ctx = qz_get_active_jsctx(rt);
    if (!ctx) return -1;

    JSValue obj = JS_ReadObject(ctx, code, len, JS_READ_OBJ_BYTECODE);
    if (JS_IsException(obj)) {
        if (err) {
            JSValue exc = JS_GetException(ctx);
            const char *msg = JS_ToCString(ctx, exc);
            *err = msg ? strdup(msg) : NULL;
            if (msg) JS_FreeCString(ctx, msg);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeValue(ctx, obj);
        return -1;
    }
    JSValue val = JS_EvalFunction(ctx, obj);
    if (JS_IsException(val)) {
        if (err) {
            JSValue exc = JS_GetException(ctx);
            const char *msg = JS_ToCString(ctx, exc);
            *err = msg ? strdup(msg) : NULL;
            if (msg) JS_FreeCString(ctx, msg);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeValue(ctx, val);
        return -1;
    }
    JS_FreeValue(ctx, val);
    return 0;
}

qz_t *qz_get_rt_from_ctx(JSContext *ctx)
{
    if (!ctx) {
        return NULL;
    }
    return qz_get_rt_from_jsrt(JS_GetRuntime(ctx));
}

qz_t *qz_get_rt_from_jsrt(JSRuntime *jsrt)
{
    qz_t *rt = (qz_t *)JS_GetRuntimeOpaque(jsrt);
    if (!rt || rt->magic != QZ_MAGIC) {
        return NULL;
    }
    return rt;
}

/* ================================================================
 * Helper: get qz_ctx_t from JSContext — iterate rt->contexts
 * to find the one matching jsctx
 * ================================================================ */

/* ===== 从 src/qzjs.c 移入（边界治理：编译是 VM 能力）===== */
int qz_compile(const char *source, size_t len, const char *filename,
               uint8_t **out, size_t *out_len, char **err)
{
    if (err) *err = NULL;
    if (out) *out = NULL;
    if (out_len) *out_len = 0;
    if (!source || !out || !out_len) {
        if (err) *err = strdup("qz_compile: bad arguments");
        return -1;
    }

    /* 一次性 JSRuntime/JSContext：与运行实例同引擎构建（同一份链接的
     * quickjs-ng），字节码格式天然匹配；编译后即弃，不触碰任何 qz_t。 */
    JSRuntime *jsrt = JS_NewRuntime();
    if (!jsrt) {
        if (err) *err = strdup("qz_compile: out of memory");
        return -1;
    }
    JSContext *ctx = JS_NewContext(jsrt);
    if (!ctx) {
        JS_FreeRuntime(jsrt);
        if (err) *err = strdup("qz_compile: out of memory");
        return -1;
    }

    /* 与 qz_eval_internal 对齐：恒为全局脚本（qzjs 的初始程序不支持
     * ES module —— 含 import/export 的源请走源码路径自带报错）。 */
    JSValue obj = JS_Eval(ctx, source, len,
                          filename ? filename : "<compile>",
                          JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(obj)) {
        if (err) {
            JSValue exc = JS_GetException(ctx);
            const char *msg = JS_ToCString(ctx, exc);
            *err = msg ? strdup(msg) : NULL;
            if (msg) JS_FreeCString(ctx, msg);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeContext(ctx);
        JS_FreeRuntime(jsrt);
        return -1;
    }

    size_t sz = 0;
    uint8_t *bc = JS_WriteObject(ctx, &sz, obj, JS_WRITE_OBJ_BYTECODE);
    JS_FreeValue(ctx, obj);
    if (!bc) {
        if (err) {
            JSValue exc = JS_GetException(ctx);
            const char *msg = JS_ToCString(ctx, exc);
            *err = msg ? strdup(msg) : NULL;
            if (msg) JS_FreeCString(ctx, msg);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeContext(ctx);
        JS_FreeRuntime(jsrt);
        return -1;
    }

    /* JS_WriteObject 缓冲走 js_malloc（引擎分配器）；拷到宿主 malloc 块，
     * 让 qz_free（普通 free）安全释放，避免分配器语义耦合。 */
    uint8_t *copy = (uint8_t *)malloc(sz ? sz : 1);
    if (!copy) {
        js_free(ctx, bc);
        JS_FreeContext(ctx);
        JS_FreeRuntime(jsrt);
        if (err) *err = strdup("qz_compile: out of memory");
        return -1;
    }
    memcpy(copy, bc, sz);
    js_free(ctx, bc);
    JS_FreeContext(ctx);
    JS_FreeRuntime(jsrt);

    *out = copy;
    *out_len = sz;
    return 0;
}

/* ================================================================
 * qzjs 线程侧内部函数（thread.c 调用）
 * ================================================================ */

