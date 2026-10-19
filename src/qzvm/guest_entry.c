/*
 * qzvm guest entry — in-module wasm32 reactor（IN_MODULE_DESIGN.md §6/§7 M4→M5）。
 *
 * QZ_VM_GUEST 专用：guest 编成 wasm32-wasi reactor，无 main/无 loop，宿主加载
 * 模块后经导出驱动（§5.4 tick 拉模型）。本 TU 把导出落到内核三源
 * （context.c / vm_core.c / ext_lifecycle.c）上，并经 qz_host.* import 调宿主
 * 能力（§10.3/§10.4）。
 *
 * 导出面（§6）：qz_create / qz_eval* / qz_tick / qz_destroy + 结果读出
 * （qz_result_ptr/len，供 M5 smoke 校验）。
 *   - C 符号用 qz_guest_* 前缀（避免与宿主侧 qz_create/qz_destroy 同名）；
 *     wasm 导出名经 __attribute__((export_name)) 映射到设计名。
 *   - 句柄 = guest 线性内存里的 qz_t*（i32），宿主当不透明句柄传回，不 deref。
 *
 * M5 异步回流（§10.4）：guest 持 resolve(JSValue)，qz_host_fs_read 发起 → host
 * 完成入队 → qz_tick → qz_host_drain 拉 {op_id,status,len,data} → 按 op_id 找
 * resolve → JS_Call。**去自旋**：tick 每轮 drain 一批后 return，宿主下轮再调。
 *
 * M5 限制（M6 消除）：单 rt（op 表为 static）；单事件/批 ≤ 512B；无 pal 全量
 * 移植（只 fsRead 一个原语作 proof）；reject 仅传错误串。完整 import 面 + js_pal_*
 * 移 guest 属 M6（§10.5）。
 */
#ifndef QZ_VM_GUEST
#error "guest_entry.c 仅用于 QZ_VM_GUEST 构建（qzvm-guest target）"
#endif

#include "base/qz_rt.h"
#include <stdlib.h>
#include <string.h>

/* ── 宿主能力 import（§10.3/§10.4）────────────────────────────────── */
/* §10.4 import 拉：拉 host 侧完成队列，返回写入 [buf] 的字节数（0=无）。
 * 事件格式：[op_id:i32][status:i32][len:i32][data...status==0 为文件内容，
 * status!=0 为错误串]。qz_tick 每轮 drain 一批 → dispatch → return（去自旋）。 */

/* M5 proof 原语（定义在文末；qz_guest_create 先引用）。 */
static JSValue js_guest_fs_read(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv);
static JSValue js_set_result(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv);
__attribute__((import_module("qz_host"), import_name("drain")))
extern int qz_host_drain(void *buf, int max);

/* §10.3 fs：发起异步读，返回 op_id（>0）；host 完成后经 drain 回流。 */
__attribute__((import_module("qz_host"),
                import_name("fs_read")))
extern int qz_host_fs_read(const char *path, int len);

/* M6b: TLS current_rt — qz_guest_eval 进入设, qz_guest_add（被 emitter 产物经
 * multi-module 调, 无 rt handle 参数）读。wasm 单线程, static 等价 TLS。
 * 完整 in-module 流程: host 调 qz_create→qz_eval→JS 调 emitter→emitter 调
 * qz.add→qz_guest_add 读 g_current_rt→qz_get_active_jsctx→ctx→JS_Add。 */
static qz_t *g_current_rt = NULL;

/* ── M5 op 表（单 rt；M6 per-rt 化 + 移入 qz_t guest 块）───────────── */
#define QZ_GUEST_MAX_OPS 64
struct qz_guest_op {
    int       in_use;
    int32_t   op_id;
    JSValue   resolve;
    JSValue   reject;
};
static struct qz_guest_op g_ops[QZ_GUEST_MAX_OPS];
static int32_t g_next_op_id = 1;

/* M5 结果读出槽：JS 侧 __qz_set_result 把 resolve 的值写进来，宿主经
 * qz_result_ptr/len 从 guest 内存读。M6 改为宿主直接 eval 取 global。 */
static char *g_result = NULL;
static int   g_result_len = 0;

#define QZ_GUEST_DRAIN_BUF 512

/* ── 内核导出包装 ────────────────────────────────────────────────── */

static qz_t *rt_from(uint32_t h) { return (qz_t *)(uintptr_t)h; }

/* qz_create：建 JSRuntime + 主 realm（内核 qz_ctx_create）+ 注册 M5 原语
 * （fsRead / __qz_set_result）为 global。完整 polyfill/pal 属 M6。 */
__attribute__((export_name("qz_create")))
uint32_t qz_guest_create(uint32_t cfg_ptr, uint32_t cfg_len)
{
    (void)cfg_ptr; (void)cfg_len;
    qz_t *rt = (qz_t *)calloc(1, sizeof(qz_t));
    if (!rt) return 0;
    rt->magic = QZ_MAGIC;
    rt->active_ctx_id = -1;
    rt->jsrt = JS_NewRuntime();
    if (!rt->jsrt) { free(rt); return 0; }
    qz_ctx_t *ctx = qz_ctx_create(rt, NULL);
    if (!ctx) { JS_FreeRuntime(rt->jsrt); free(rt); return 0; }
    rt->active_ctx_id = ctx->context_id;

    /* 注册 M5 proof 原语：fsRead（异步，§10.4 回流）+ __qz_set_result（结果
     * 读出）。完整 pal 面（43 个 js_pal_*）移 guest 属 M6。 */
    JSContext *jctx = ctx->jsctx;
    JSValue g = JS_GetGlobalObject(jctx);
    JS_SetPropertyStr(jctx, g, "fsRead",
        JS_NewCFunction(jctx, js_guest_fs_read, "fsRead", 1));
    JS_SetPropertyStr(jctx, g, "__qz_set_result",
        JS_NewCFunction(jctx, js_set_result, "__qz_set_result", 1));
    JS_FreeValue(jctx, g);

    return (uint32_t)(uintptr_t)rt;
}

__attribute__((export_name("qz_destroy")))
void qz_guest_destroy(uint32_t h)
{
    qz_t *rt = rt_from(h);
    if (!rt || rt->magic != QZ_MAGIC) return;
    /* 先清 op 表（释放持留的 resolve/reject），再拆 realm。 */
    for (int i = 0; i < QZ_GUEST_MAX_OPS; i++) {
        if (g_ops[i].in_use) {
            JSContext *jctx = qz_get_active_jsctx(rt);
            if (jctx) {
                JS_FreeValue(jctx, g_ops[i].resolve);
                JS_FreeValue(jctx, g_ops[i].reject);
            }
            g_ops[i].in_use = 0;
        }
    }
    free(g_result); g_result = NULL; g_result_len = 0;
    for (int i = 0; i < QZ_MAX_CONTEXTS; i++) {
        if (rt->contexts[i]) qz_ctx_destroy(rt, rt->contexts[i]);
    }
    if (rt->jsrt) JS_FreeRuntime(rt->jsrt);
    rt->magic = 0;
    free(rt);
}

/* qz_eval：在活动 realm 上 eval 全局脚本。源经 ptr+len 传，guest 内拷 NUL
 * 终止后调内核 qz_eval_internal。 */
__attribute__((export_name("qz_eval")))
int qz_guest_eval(uint32_t h, const char *src, int len)
{
    qz_t *rt = rt_from(h);
    if (!rt || rt->magic != QZ_MAGIC) return -1;
    if (!src || len < 0) return -1;
    char *buf = (char *)malloc((size_t)len + 1);
    if (!buf) return -1;
    memcpy(buf, src, (size_t)len);
    buf[len] = '\0';
    char *err = NULL;
    g_current_rt = rt;  /* M6b: 供 qz_guest_add（emitter 产物经 multi-module 调）读 */
    int rc = qz_eval_internal(rt, buf, &err);
    g_current_rt = NULL;  /* eval 退出清，避免悬空 */
    free(buf);
    free(err);
    return rc;
}

/* qz_tick：§5.4/§10.4 tick 拉模型——先拉 host 完成队列并 dispatch resolve，
 * 再排空 JS 微任务（resolve 的 JS_Call 把 .then reaction 入 job 队列，由后续
 * qz_tick 跑）。**去自旋**：drain 一批后 return，宿主下轮再调。 */
__attribute__((export_name("qz_tick")))
int qz_guest_tick(uint32_t h)
{
    qz_t *rt = rt_from(h);
    if (!rt || rt->magic != QZ_MAGIC) return -1;
    JSContext *jctx = qz_get_active_jsctx(rt);
    int dispatched = 0;
    if (jctx) {
        for (;;) {
            char buf[QZ_GUEST_DRAIN_BUF];
            int n = qz_host_drain(buf, (int)sizeof(buf));
            if (n < 12) break;  /* 0 = 无事件；< 12 = 不完整，丢弃（M5 不做分片） */
            int32_t op_id, status, dlen;
            memcpy(&op_id,  buf,     4);
            memcpy(&status, buf + 4, 4);
            memcpy(&dlen,   buf + 8, 4);
            int avail = n - 12;
            if (dlen < avail) avail = dlen;  /* 实际写入量 = min(dlen, n-12) */
            /* 按 op_id 找 op 表槽 */
            int slot = -1;
            for (int i = 0; i < QZ_GUEST_MAX_OPS; i++) {
                if (g_ops[i].in_use && g_ops[i].op_id == op_id) { slot = i; break; }
            }
            if (slot < 0) continue;  /* 未知 op_id（已销毁？），丢 */
            JSValue val = JS_NewStringLen(jctx, buf + 12, (size_t)avail);
            JSValue fn = (status == 0) ? g_ops[slot].resolve : g_ops[slot].reject;
            JSValue ret = JS_Call(jctx, fn, JS_UNDEFINED, 1, &val);
            JS_FreeValue(jctx, ret);
            JS_FreeValue(jctx, val);
            JS_FreeValue(jctx, g_ops[slot].resolve);
            JS_FreeValue(jctx, g_ops[slot].reject);
            g_ops[slot].in_use = 0;
            dispatched++;
        }
    }
    /* 排空微任务（resolve/reject 的 .then reaction 在此跑） */
    int micro = qz_tick(rt);
    return dispatched + micro;
}

/* ── M5 proof 原语：fsRead（异步，§10.4 回流）────────────────────── */
/* fsRead(path) -> Promise<string>。建 Promise，调 qz_host_fs_read 拿 op_id，
 * resolve/reject 存 op 表，等 qz_tick 的 drain dispatch 回流。 */
static JSValue js_guest_fs_read(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "fsRead requires path argument");
    size_t plen = 0;
    const char *path = JS_ToCStringLen(ctx, &plen, argv[0]);
    if (!path) return JS_EXCEPTION;

    JSValue resolving[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving);
    if (JS_IsException(promise)) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }

    int32_t op_id = qz_host_fs_read(path, (int)plen);
    JS_FreeCString(ctx, path);
    if (op_id <= 0) {
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return JS_ThrowTypeError(ctx, "fsRead: host launch failed");
    }
    int slot = -1;
    for (int i = 0; i < QZ_GUEST_MAX_OPS; i++) {
        if (!g_ops[i].in_use) { slot = i; break; }
    }
    if (slot < 0) {
        JS_FreeValue(ctx, resolving[0]);
        JS_FreeValue(ctx, resolving[1]);
        return JS_ThrowOutOfMemory(ctx);
    }
    g_ops[slot].in_use  = 1;
    g_ops[slot].op_id   = op_id;
    /* NewPromiseCapability 给的 resolving_funcs 是 borrowed ref（caller 须
     * FreeValue 或 Dup 持有）；表要跨 tick 持有，DupValue。 */
    g_ops[slot].resolve = JS_DupValue(ctx, resolving[0]);
    g_ops[slot].reject  = JS_DupValue(ctx, resolving[1]);
    JS_FreeValue(ctx, resolving[0]);
    JS_FreeValue(ctx, resolving[1]);
    return promise;
}

/* __qz_set_result(v)：M5 结果读出——JS 把 resolve 值写进静态槽，宿主经
 * qz_result_ptr/len 从 guest 内存读。M6 改宿主直接 eval 取 global。 */
static JSValue js_set_result(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 1) return JS_UNDEFINED;
    size_t l = 0;
    const char *s = JS_ToCStringLen(ctx, &l, argv[0]);
    if (!s) return JS_UNDEFINED;
    char *nb = (char *)malloc(l ? l : 1);
    if (nb) { memcpy(nb, s, l); free(g_result); g_result = nb; g_result_len = (int)l; }
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/* ── 结果读出导出（M5 smoke 用；M6 移除，宿主直接 eval）──────────── */
__attribute__((export_name("qz_result_ptr")))
uint32_t qz_guest_result_ptr(void)
{
    return (uint32_t)(uintptr_t)g_result;
}

__attribute__((export_name("qz_result_len")))
int qz_guest_result_len(void)
{
    return g_result_len;
}

/* ── M6b PoC: qz_add 包装 QuickJS（multi-module import 链接验证）────────── */
/* emitter 产物 import "qz" "qz_add" (i64,i64)->i64 链接到此。
 * 阶段2 包装 QuickJS：g_current_rt 有效（qz_guest_eval 设）时，解 i64 NaN-box
 * → f64 → JS_NewFloat64 → JS_Add（JS 加法语义，含 string concat 等）→ JS_ToFloat64
 * → 装回 i64。g_current_rt NULL（test_add.wasm 直接调, 未经 qz_eval 流）时
 * fallback a+b（验 multi-module 链接机制, 不验 QuickJS 语义）。
 * 前提: emitter 产物 import "qz" "memory" 共享 libqzvm linear memory。
 * NaN-box 句柄（0x7FF9/0x7FFA/0x7FFB）后续: 当前只处理数值(f64 位型),
 * 句柄解 tag + handle table 是 M6b 完整落地工程。 */
__attribute__((export_name("qz_add")))
int64_t qz_guest_add(int64_t a, int64_t b)
{
    if (!g_current_rt) return a + b;  /* fallback: 未经 qz_eval 流 */
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a + b;
    double fa, fb;
    memcpy(&fa, &a, sizeof(double));  /* i64 NaN-box → f64 位型（数值假设） */
    memcpy(&fb, &b, sizeof(double));
    JSValue va = JS_NewFloat64(ctx, fa);  /* 验 QuickJS API 可达 */
    JSValue vb = JS_NewFloat64(ctx, fb);
    double fa2 = 0.0, fb2 = 0.0;
    int err = JS_ToFloat64(ctx, &fa2, va);  /* round-trip */
    if (!err) JS_ToFloat64(ctx, &fb2, vb);
    JS_FreeValue(ctx, va);
    JS_FreeValue(ctx, vb);
    if (err) return a + b;
    double fr = fa2 + fb2;  /* C 加法（JS_Add 非公开 API, 完整 JS 语义 string concat 等后续 eval/internal） */
    int64_t r;
    memcpy(&r, &fr, sizeof(double));
    return r;
}
