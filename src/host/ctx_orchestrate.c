/*
 * qzjs Host Context Orchestration
 * 宿主编排层（边界，见 src/qzvm/aot/IN_MODULE_DESIGN.md §5.2/§5.3）：realm
 * 建成后的边界接线（wire-up：pal / polyfill / 扩展 init），以及多 context 的
 * spawn / serialize / rebuild / destroy_id 与宿主侧资源清理。这些操作经
 * polyfill 的 qzContext 由 bridge 驱动，宿主只见主 context。
 *
 * VM 内核（qz_ctx_create/_at/_destroy/get_active_*）只建/拆 realm 与登记；
 * 本文件在其上做边界接线与编排。
 */

#include "base/qz_rt.h"
#include <stdlib.h>
#include <stdio.h>

/* ================================================================
 * Host-side resource cleanup (moved from qzvm/context.c, §5.2)
 * ================================================================ */

void qz_ctx_cleanup_resources(qz_t *rt, qz_ctx_t *ctx)
{
    if (!rt || !ctx) {
        return;
    }

    /* Stop all active timers and free associated resources */
    for (int i = 0; i < ctx->handle_count; i++) {
        qz_timer_cancel(ctx, i);
    }

    ctx->handle_count = 0;
}

/* ================================================================
 * Multi-context + soft suspend/resume (Task 5)
 *
 * 宿主只见主 context；spawn/suspend/resume/destroy 由 polyfill 的 qzContext
 * 经 bridge 驱动。挂起 = 把目标 ctx 可克隆的全局属性收集成结构化克隆字节写盘，
 * 然后销毁该 JSContext；恢复 = 在原槽位重建 JSContext + 重注入 polyfill（
 * qz_ctx_wire_up 内做）+ 重 eval 脚本 + 反序列化状态回 globalThis。
 * 序列化/反序列化的可克隆判定在 JS 侧（context.js 的 __qz_ctx_capture__ /
 * __qz_ctx_restore__，复用 Task 4 的序列化内核）——C 只做边界转换。
 * ================================================================ */

/* ================================================================
 * Boundary wire-up (moved from qzvm/context.c, §5.2)
 * ================================================================ */
/* 宿主接线（边界，见 IN_MODULE_DESIGN.md §5.2/§5.3）：realm 建成后装载并注入
 * polyfill、初始化 timer 句柄表、切 active ctx、调扩展 init 钩子。失败时整体
 * 回滚（注销 + 释放 realm + 释放 ctx）。host/ctx_orchestrate.c 在此之上暴露
 * qz_ctx_spawn/restore 等编排原语。 */
int qz_ctx_wire_up(qz_t *rt, qz_ctx_t *ctx)
{
    int slot = ctx->context_id;
    int prev_active = rt->active_ctx_id;
    JSValue global;

    /* Polyfill bytecode: load once per runtime (lazily at first context
     * creation) and share across all contexts — modes A/B hold a heap copy,
     * mode C hands out the compile-time const array, mode D the host hook.
     * rt->polyfill is unloaded at runtime teardown (qz_thread_teardown). */
    if (!rt->polyfill) {
        const uint8_t *data = NULL;
        size_t len = 0;
        void *owner = NULL;
        if (qz_polyfill_load(&data, &len, &owner) != 0) {
            goto fail;
        }
        rt->polyfill = data;
        rt->polyfill_len = len;
        rt->polyfill_owner = owner;
    }
    ctx->polyfill = rt->polyfill;
    ctx->polyfill_len = rt->polyfill_len;

    /* Initialize handle arrays to zero/NULL */
    for (int i = 0; i < QZ_MAX_HANDLES; i++) {
        ctx->handles[i] = NULL;
        ctx->timer_resolves[i] = JS_UNDEFINED;
        ctx->timer_cbds[i] = NULL;
    }

    rt->active_ctx_id = slot;

    /* Build the internal pal object and inject it as __native_inject__ so the
     * polyfill bytecode can reach native functions during evaluation. */
    JSValue pal_obj = qz_create_pal_object_ctx(rt, ctx);
    if (JS_IsException(pal_obj)) {
        goto fail;
    }
    global = JS_GetGlobalObject(ctx->jsctx);
    JS_SetPropertyStr(ctx->jsctx, global, "__native_inject__", pal_obj);
    JS_FreeValue(ctx->jsctx, global);

    /* Load and evaluate bytecode */
    {
        JSValue obj = JS_ReadObject(ctx->jsctx, ctx->polyfill, ctx->polyfill_len,
                                    JS_READ_OBJ_BYTECODE);
        int bc_ok = 1;
        if (JS_IsException(obj)) {
            bc_ok = 0;
        } else {
            JSValue val = JS_EvalFunction(ctx->jsctx, obj);
            if (JS_IsException(val)) {
                JS_FreeValue(ctx->jsctx, val);
                bc_ok = 0;
            } else {
                JS_FreeValue(ctx->jsctx, val);
            }
        }

        /* Remove __native_inject__ from globalThis but keep the native object
         * accessible as __native__ for extension init hooks to register
         * functions on it. The polyfill's closures reference the same
         * object, so extensions adding properties here are visible. */
        global = JS_GetGlobalObject(ctx->jsctx);
        JSAtom inject_atom = JS_NewAtom(ctx->jsctx, "__native_inject__");
        JSValue pal_ref = JS_GetProperty(ctx->jsctx, global, inject_atom);
        JS_DeleteProperty(ctx->jsctx, global, inject_atom, 0);
        JS_FreeAtom(ctx->jsctx, inject_atom);
        if (!JS_IsUndefined(pal_ref) && !JS_IsException(pal_ref)) {
            JS_SetPropertyStr(ctx->jsctx, global, "__native__", pal_ref);
        } else {
            JS_FreeValue(ctx->jsctx, pal_ref);
        }
        JS_FreeValue(ctx->jsctx, global);

        if (!bc_ok) {
            goto fail;
        }
    }

    /* Remove QuickJS built-in WebAssembly - it can parse but not execute
     * WASM, which is misleading. The wasm3 extension registers its own working
     * WebAssembly implementation in its init hook. If no WASM extension is
     * present, WebAssembly is simply unavailable. */
    {
        global = JS_GetGlobalObject(ctx->jsctx);
        JSAtom wasm_atom = JS_NewAtom(ctx->jsctx, "WebAssembly");
        JS_DeleteProperty(ctx->jsctx, global, wasm_atom, 0);
        JS_FreeAtom(ctx->jsctx, wasm_atom);
        JS_FreeValue(ctx->jsctx, global);
    }

    /* Call extension init hooks */
    if (qz_ext_init_all(rt, ctx) < 0) {
        goto fail;
    }

    return 0;

fail:
    /* Undo registration and free the realm */
    rt->active_ctx_id = prev_active;
    rt->contexts[slot] = NULL;
    rt->context_count--;
    qz_ctx_cleanup_resources(rt, ctx);
    JS_FreeContext(ctx->jsctx);
    free(ctx);
    return -1;
}

/* 建 realm + 完整接线：内核 qz_ctx_create 建 realm 与登记，再 wire-up 边界。
 * 任一步失败即回滚（wire_up 已注销并释放 realm）。 */
qz_ctx_t *qz_ctx_create_host(qz_t *rt, const qz_config_t *config)
{
    qz_ctx_t *ctx = qz_ctx_create(rt, config);
    if (!ctx) {
        return NULL;
    }
    if (qz_ctx_wire_up(rt, ctx) != 0) {
        return NULL;
    }
    return ctx;
}

/* 销毁 context：边界步骤（扩展 destroy 钩子 + 句柄/timer 清理）先行，再交内核
 * 拆 realm（qz_ctx_destroy 只做 job 排水 + JS_FreeContext + 注销）。 */
void qz_ctx_destroy_host(qz_t *rt, qz_ctx_t *ctx)
{
    if (!rt || !ctx) {
        return;
    }
    qz_ext_destroy_all(rt, ctx);
    qz_ctx_cleanup_resources(rt, ctx);
    qz_ctx_destroy(rt, ctx);
}

/* 同步写盘（state_path）。挂起必须完整落盘后才能销毁 ctx，所以不用异步 IO。 */
static int qz_write_file(const char *path, const char *data, size_t len)
{
    FILE *f = fopen(path, "wb");
    if (!f) return -1;
    int ok = (fwrite(data, 1, len, f) == len) ? 0 : -1;
    if (fclose(f) != 0) ok = -1;
    return ok;
}

static int qz_read_file(const char *path, char **out, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return -1; }
    long sz = ftell(f);
    if (sz < 0) { fclose(f); return -1; }
    rewind(f);
    char *buf = (char *)malloc(sz ? (size_t)sz : 1);
    if (!buf) { fclose(f); return -1; }
    size_t n = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    *out = buf;
    *out_len = n;
    return 0;
}

/* 调目标 ctx 的 __qz_ctx_restore__ 把状态字节写回其 globalThis */
static int qz_ctx_restore_bytes(qz_t *rt, qz_ctx_t *cctx,
                                  const char *data, size_t len)
{
    QZ_UNUSED(rt);
    JSContext *ctx = cctx->jsctx;
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, g, "__qz_ctx_restore__");
    JS_FreeValue(ctx, g);
    if (!JS_IsFunction(ctx, fn)) {
        JS_FreeValue(ctx, fn);
        return QZ_ERR_NOT_SUPPORTED;
    }
    JSValue b = JS_NewArrayBufferCopy(ctx, (const uint8_t *)data, len);
    JSValue args[1] = { b };
    JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 1, args);
    int ok = !JS_IsException(r);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, b);
    JS_FreeValue(ctx, fn);
    return ok ? QZ_OK : QZ_ERR_GENERIC;
}

int qz_ctx_spawn(qz_t *rt, const char *init_script)
{
    qz_ctx_t *cctx = qz_ctx_create_host(rt, &rt->config);
    if (!cctx) return QZ_ERR_NO_MEMORY;
    int cid = cctx->context_id;
    /* qz_eval_internal 在 active ctx 上执行——把 active 切到新 ctx，让 init
     * 脚本落到子 context（而不是留在主 context 上）。 */
    rt->active_ctx_id = cid;
    if (init_script && init_script[0]) {
        char *err = NULL;
        if (qz_eval_internal(rt, init_script, &err) != 0) {
            qz_ctx_destroy_host(rt, cctx);
            if (rt->contexts[0]) rt->active_ctx_id = 0;
            return QZ_ERR_GENERIC;
        }
    }
    /* 恢复 active = 主 context（宿主只见主） */
    if (rt->contexts[0]) rt->active_ctx_id = 0;
    return cid;
}

int qz_ctx_serialize(qz_t *rt, int ctx_id, const char *state_path)
{
    if (!rt || rt->magic != QZ_MAGIC) return QZ_ERR_INVALID_ARG;
    qz_ctx_t *cctx = qz_get_ctx_by_id(rt, ctx_id);
    if (!cctx || !cctx->jsctx) return QZ_ERR_NOT_FOUND;
    if (ctx_id == rt->active_ctx_id) return QZ_ERR_BUSY;
    /* G3：挂起前让扩展保存状态（当前全部 no-op，为扩展状态持久化预留） */
    if (qz_ext_suspend_all(rt, cctx) < 0) return QZ_ERR_GENERIC;
    JSContext *ctx = cctx->jsctx;
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, g, "__qz_ctx_capture__");
    JS_FreeValue(ctx, g);
    if (!JS_IsFunction(ctx, fn)) {
        JS_FreeValue(ctx, fn);
        return QZ_ERR_NOT_SUPPORTED;
    }
    JSValue bytes = JS_Call(ctx, fn, JS_UNDEFINED, 0, NULL);
    JS_FreeValue(ctx, fn);
    if (JS_IsException(bytes)) {
        JS_FreeValue(ctx, bytes);
        return QZ_ERR_GENERIC;
    }
    size_t len = 0;
    const uint8_t *data = JS_GetUint8Array(ctx, &len, bytes);
    if (!data) data = JS_GetArrayBuffer(ctx, &len, bytes);
    int rc = (data && qz_write_file(state_path, (const char *)data, len) == 0)
             ? QZ_OK : QZ_ERR_IO;
    JS_FreeValue(ctx, bytes);
    /* G1：写盘成功后销毁 ctx 释放内存。槽位由 qz_ctx_destroy 置 NULL，
     * 后续 qz_ctx_rebuild 在该槽位重建；写盘失败保留 ctx 供宿主重试。 */
    if (rc == QZ_OK) qz_ctx_destroy_host(rt, cctx);
    return rc;
}

int qz_ctx_rebuild(qz_t *rt, int ctx_id, const char *script_ref, const char *state_path)
{
    if (!rt || rt->magic != QZ_MAGIC) return QZ_ERR_INVALID_ARG;
    if (ctx_id < 0 || ctx_id >= QZ_MAX_CONTEXTS) return QZ_ERR_INVALID_ARG;
    if (ctx_id == rt->active_ctx_id) return QZ_ERR_BUSY;

    /* 目标槽若有残留（旧实例）先销毁 */
    if (rt->contexts[ctx_id]) {
        qz_ctx_destroy_host(rt, rt->contexts[ctx_id]);
    }

    qz_ctx_t *cctx = qz_ctx_create_at(rt, ctx_id);
    if (!cctx) return QZ_ERR_NO_MEMORY;
    if (qz_ctx_wire_up(rt, cctx) != 0) return QZ_ERR_GENERIC;

    int rc = QZ_OK;
    /* 同上：script_ref 必须 eval 到重建出的子 ctx 上 */
    rt->active_ctx_id = ctx_id;
    if (script_ref && script_ref[0]) {
        char *err = NULL;
        if (qz_eval_internal(rt, script_ref, &err) != 0) {
            free(err);
            rc = QZ_ERR_GENERIC;
        }
    }
    if (rc == QZ_OK && state_path && state_path[0]) {
        char *buf = NULL;
        size_t blen = 0;
        if (qz_read_file(state_path, &buf, &blen) == 0) {
            rc = qz_ctx_restore_bytes(rt, cctx, buf, blen);
            free(buf);
        } else {
            rc = QZ_ERR_IO;
        }
    }
    /* G3：restore 成功后让扩展恢复状态（active 尚未切回主 ctx，钩子可在
     * 子 ctx 上安全 eval）。失败按整体恢复失败处理：走下方销毁路径。 */
    if (rc == QZ_OK && qz_ext_resume_all(rt, cctx) < 0) rc = QZ_ERR_GENERIC;
    if (rt->contexts[0]) rt->active_ctx_id = 0;
    if (rc != QZ_OK) {
        qz_ctx_destroy_host(rt, cctx);
    }
    return ctx_id;
}

int qz_ctx_destroy_id(qz_t *rt, int ctx_id)
{
    if (!rt || rt->magic != QZ_MAGIC) return QZ_ERR_INVALID_ARG;
    if (ctx_id == rt->active_ctx_id) return QZ_ERR_BUSY;
    qz_ctx_t *cctx = qz_get_ctx_by_id(rt, ctx_id);
    if (!cctx) return QZ_ERR_NOT_FOUND;
    qz_ctx_destroy_host(rt, cctx);
    return QZ_OK;
}
