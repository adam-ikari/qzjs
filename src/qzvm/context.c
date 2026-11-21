/*
 * qzjs Context Lifecycle
 *
 * Context creation, destruction, and helper functions for multi-context support.
 */

#include "base/qz_rt.h"
#include "qzjs/qz_ext_registry.h"   /* QZ_EXTENSIONS table */
#include <stdlib.h>

/* ================================================================
 * Compile-time extension table
 *
 * QZ_EXTENSIONS expands to a list of `const qz_ext_t *` (possibly with
 * NULL slots for built-ins whose QZ_WITH_* is off). Not NULL-terminated
 * (NULL slots would be indistinguishable from a terminator); iterate by count
 * and skip NULL. Trailing comma is legal in a C99 array initializer. */
static const qz_ext_t *qz_default_exts[] = {
    QZ_EXTENSIONS
};
static const int qz_default_exts_count =
    (int)(sizeof(qz_default_exts) / sizeof(qz_default_exts[0]));

/* ================================================================
 * Context getter helpers
 * ================================================================ */

qz_ctx_t *qz_get_active_ctx(qz_t *rt)
{
    if (!rt || rt->magic != QZ_MAGIC) {
        return NULL;
    }
    if (rt->active_ctx_id < 0 || rt->active_ctx_id >= QZ_MAX_CONTEXTS) {
        return NULL;
    }
    return rt->contexts[rt->active_ctx_id];
}

JSContext *qz_get_active_jsctx(qz_t *rt)
{
    qz_ctx_t *ctx = qz_get_active_ctx(rt);
    if (!ctx) {
        return NULL;
    }
    return ctx->jsctx;
}

qz_ctx_t *qz_get_ctx_by_id(qz_t *rt, int context_id)
{
    if (!rt || rt->magic != QZ_MAGIC) {
        return NULL;
    }
    if (context_id < 0 || context_id >= QZ_MAX_CONTEXTS) {
        return NULL;
    }
    return rt->contexts[context_id];
}

/* ================================================================
 * Context creation
 * ================================================================ */

/* 建 realm（内核）：分配 qz_ctx_t + JSContext，指向编译期扩展表，登记进
 * rt->contexts。**不含宿主接线**（polyfill 装载/注入、pal 对象、timer 句柄
 * 表、扩展 init）——那是边界步骤，见 IN_MODULE_DESIGN.md §5.2，由宿主源在
 * realm 建成后调用。调用方保证槽位空闲。 */
qz_ctx_t *qz_ctx_create(qz_t *rt, const qz_config_t *config)
{
    if (!rt || rt->magic != QZ_MAGIC) {
        return NULL;
    }
    (void)config;   /* ctx_create no longer takes a PAL; config lives on rt */
    /* Find a free context slot */
    for (int i = 0; i < QZ_MAX_CONTEXTS; i++) {
        if (rt->contexts[i] == NULL) {
            return qz_ctx_create_at(rt, i);
        }
    }
    return NULL;  /* No free slots */
}

qz_ctx_t *qz_ctx_create_at(qz_t *rt, int slot)
{
    /* Allocate qz_ctx_t */
    qz_ctx_t *ctx = (qz_ctx_t *)calloc(1, sizeof(qz_ctx_t));
    if (!ctx) {
        return NULL;
    }

    /* Create JSContext under shared JSRuntime */
    ctx->jsctx = JS_NewContext(rt->jsrt);
    if (!ctx->jsctx) {
        free(ctx);
        return NULL;
    }

    /* Initialize context fields */
    ctx->context_id = slot;
    /* Extensions: point at the compile-time QZ_EXTENSIONS table (no per-context
     * heap allocation). NULL slots (disabled built-ins) are skipped at init. */
    ctx->extensions = qz_default_exts;
    ctx->extensions_count = qz_default_exts_count;

    /* Register in runtime's context table before any JS runs, so that native
     * functions can find the context via get_ctx_from_jsctx (bridges/PAL). */
    rt->contexts[slot] = ctx;
    rt->context_count++;
    return ctx;
}

/* ================================================================
 * Context destruction
 * ================================================================ */

void qz_ctx_destroy(qz_t *rt, qz_ctx_t *ctx)
{
    if (!rt || !ctx) {
        return;
    }

    int context_id = ctx->context_id;

    /* 扩展 destroy 钩子与句柄/timer 清理属宿主接线（§5.2）：宿主源在调用本
     * 函数前先跑 qz_ctx_cleanup_resources 与 qz_ext_destroy_all。 */

    /* G2：先排空 rt->job_list 中属于本 ctx 的 pending job（如未执行的
     * Promise 反应）。JS_FreeContext 不清 job 队列，残留 entry 会持悬垂
     * ctx 指针，下一轮 JS_ExecutePendingJob 即 UAF。 */
    if (ctx->jsctx && rt->jsrt) {
        JS_DrainPendingJobsForContext(rt->jsrt, ctx->jsctx);
    }
    if (ctx->jsctx) {
        JS_FreeContext(ctx->jsctx);
        ctx->jsctx = NULL;
    }

    /* Remove from runtime table */
    rt->contexts[context_id] = NULL;
    rt->context_count--;

    /* Clear active_ctx_id if this was the active context */
    if (rt->active_ctx_id == context_id) {
        rt->active_ctx_id = -1;
    }

    /* Free the ctx struct */
    free(ctx);
}

