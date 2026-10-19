#include <math.h>
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
__attribute__((export_name("add")))
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

/* ── M6b: handle table（0x7FF9 句柄，复杂原语基础）────────── */
/* qz_tojs(0x7FF9|idx) → g_handles[idx]（JS_DupValue）。
 * qz_ret(对象/闭包等非数值/字符串/布尔) → 注册 handle → 0x7FF9|idx。
 * PoC 简化: static array + 不释放（泄漏接受）；refcount + 生命周期管理完整落地工程。 */
#define QZ_MAX_HANDLES 65536
static JSValue g_handles[QZ_MAX_HANDLES];
static int g_handle_count = 0;

/* ── M6b: toJS/ret C 最小版（112 原语基础——统一 NaN-box 编解码）────────── */
/* toJS(b): i64 NaN-box → JSValue。数值(f64 位型) → JS_NewFloat64;
 *   字符串句柄(0x7FFA|off) → JS_NewStringLen(从共享 memory 读)。
 * ret(r): JSValue → i64 NaN-box。数值 → f64 位型;
 *   字符串 → malloc buffer [len][utf8] → 0x7FFA|off。
 * 其他 tag（0x7FF9 句柄/0x7FFB 数组/0x7FFC 布尔等）+ handle table 后续。
 * 参考 qzvm.js toJS/ret（~300 行 JS）C 移植，M6b 完整落地工程。 */
static JSValue qz_tojs(JSContext *ctx, int64_t b)
{
    uint64_t bits = (uint64_t)b;
    uint64_t tag = bits >> 48;
    if (tag < 0x7FF8 || tag > 0x7FFF) {
        double f;
        memcpy(&f, &b, 8);
        return JS_NewFloat64(ctx, f);
    }
    if (tag == 0x7FFA) {
        uint32_t off = (uint32_t)(b & 0xFFFFFFFF);
        const char *mem = (const char *)(uintptr_t)off;
        uint32_t len;
        memcpy(&len, mem, 4);
        return JS_NewStringLen(ctx, mem + 4, len);
    }
    if (tag == 0x7FFC) return JS_NewBool(ctx, (int)(b & 1));  /* 布尔句柄 */
    if (tag == 0x7FF9) {  /* handle table 句柄（对象/闭包等） */
        uint32_t idx = (uint32_t)(b & 0xFFFFFFFF);
        if (idx < (uint32_t)g_handle_count) return JS_DupValue(ctx, g_handles[idx]);
    }
    return JS_UNDEFINED;  /* 其他 tag 后续 */
}

static int64_t qz_ret(JSContext *ctx, JSValue r)
{
    int tag = JS_VALUE_GET_TAG(r);
    if (tag == JS_TAG_INT || tag == JS_TAG_FLOAT64) {
        double f = 0.0;
        JS_ToFloat64(ctx, &f, r);
        int64_t bits;
        memcpy(&bits, &f, 8);
        return bits;
    }
    if (tag == JS_TAG_STRING) {
        size_t len;
        const char *utf8 = JS_ToCStringLen(ctx, &len, r);
        if (!utf8) return 0;
        char *buf = (char *)malloc(4 + len);
        if (!buf) { JS_FreeCString(ctx, utf8); return 0; }
        uint32_t off = (uint32_t)(uintptr_t)buf;
        memcpy(buf, &len, 4);
        memcpy(buf + 4, utf8, len);
        JS_FreeCString(ctx, utf8);
        return ((int64_t)0x7FFA << 48) | off;
    }
    if (tag == JS_TAG_BOOL) return ((int64_t)0x7FFC << 48) | (JS_VALUE_GET_BOOL(r) ? 1 : 0);
    /* 对象/闭包/数组等 → handle table 注册（0x7FF9 | idx） */
    int idx = g_handle_count++;
    if (idx >= QZ_MAX_HANDLES) return 0;
    g_handles[idx] = JS_DupValue(ctx, r);
    return ((int64_t)0x7FF9 << 48) | (uint32_t)idx;
    /* undefined/null 等后续（0 tag） */
}

/* ── M6b PoC: string_concat C（JS 字符串拼接，handle table 原语）────────── */
/* emitter 产物 import "qz" "string_concat" (i64,i64)->i64。
 * JS_ConcatString 非公开 API → 用 JS_ToCString + C memcpy 拼接 + JS_NewStringLen。
 * qz_tojs 解 a,b（字符串句柄 → JSValue），qz_ret 装回（JSValue → 0x7FFA|off）。
 * g_current_rt NULL 时 fallback 返回 a。 */
__attribute__((export_name("string_concat")))
int64_t qz_guest_string_concat(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;  /* fallback */
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a);
    JSValue vb = qz_tojs(ctx, b);
    size_t la = 0, lb = 0;
    const char *sa = JS_ToCStringLen(ctx, &la, va);
    const char *sb = JS_ToCStringLen(ctx, &lb, vb);
    JSValue vr = JS_UNDEFINED;
    if (sa && sb) {
        char *buf = (char *)malloc(la + lb);
        if (buf) {
            memcpy(buf, sa, la);
            memcpy(buf + la, sb, lb);
            vr = JS_NewStringLen(ctx, buf, la + lb);
            free(buf);
        }
    }
    JS_FreeCString(ctx, sa);
    JS_FreeCString(ctx, sb);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

/* ── M6b PoC: lt/gt/str_len 批量原语（比较+长度，验布尔 tag）────────── */
__attribute__((export_name("lt")))
int64_t qz_guest_lt(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    double fa = 0, fb = 0;
    JS_ToFloat64(ctx, &fa, va);
    JS_ToFloat64(ctx, &fb, vb);
    JSValue vr = JS_NewBool(ctx, fa < fb);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("gt")))
int64_t qz_guest_gt(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    double fa = 0, fb = 0;
    JS_ToFloat64(ctx, &fa, va);
    JS_ToFloat64(ctx, &fb, vb);
    JSValue vr = JS_NewBool(ctx, fa > fb);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("str_len")))
int64_t qz_guest_str_len(int64_t a)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue va = qz_tojs(ctx, a);
    size_t len = 0;
    JS_ToCStringLen(ctx, &len, va);
    JSValue vr = JS_NewFloat64(ctx, (double)len);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vr);
    return r;
}

/* ── M6b PoC: sub/mul/div/rem 算术原语（批量，qz_tojs/ret 模式）────────── */
__attribute__((export_name("sub")))
int64_t qz_guest_sub(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    double fa = 0, fb = 0;
    JS_ToFloat64(ctx, &fa, va);
    JS_ToFloat64(ctx, &fb, vb);
    JSValue vr = JS_NewFloat64(ctx, fa - fb);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("mul")))
int64_t qz_guest_mul(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    double fa = 0, fb = 0;
    JS_ToFloat64(ctx, &fa, va);
    JS_ToFloat64(ctx, &fb, vb);
    JSValue vr = JS_NewFloat64(ctx, fa * fb);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("div")))
int64_t qz_guest_div(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    double fa = 0, fb = 0;
    JS_ToFloat64(ctx, &fa, va);
    JS_ToFloat64(ctx, &fb, vb);
    JSValue vr = JS_NewFloat64(ctx, fa / fb);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("rem")))
int64_t qz_guest_rem(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    double fa = 0, fb = 0;
    JS_ToFloat64(ctx, &fa, va);
    JS_ToFloat64(ctx, &fb, vb);
    JSValue vr = JS_NewFloat64(ctx, fmod(fa, fb));
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

/* ── M6b PoC: le/ge/seq/sne 比较原语（批量，布尔 tag）────────── */
__attribute__((export_name("le")))
int64_t qz_guest_le(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    double fa = 0, fb = 0;
    JS_ToFloat64(ctx, &fa, va);
    JS_ToFloat64(ctx, &fb, vb);
    JSValue vr = JS_NewBool(ctx, fa <= fb);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("ge")))
int64_t qz_guest_ge(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    double fa = 0, fb = 0;
    JS_ToFloat64(ctx, &fa, va);
    JS_ToFloat64(ctx, &fb, vb);
    JSValue vr = JS_NewBool(ctx, fa >= fb);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("seq")))
int64_t qz_guest_seq(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    double fa = 0, fb = 0;
    JS_ToFloat64(ctx, &fa, va);
    JS_ToFloat64(ctx, &fb, vb);
    JSValue vr = JS_NewBool(ctx, fa == fb);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("sne")))
int64_t qz_guest_sne(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    double fa = 0, fb = 0;
    JS_ToFloat64(ctx, &fa, va);
    JS_ToFloat64(ctx, &fb, vb);
    JSValue vr = JS_NewBool(ctx, fa != fb);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

/* ── M6b PoC: neg/bnot/band/bor/bxor/truthy 原语（一元+位+布尔）────────── */
__attribute__((export_name("neg")))
int64_t qz_guest_neg(int64_t a)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a);
    double fa = 0;
    JS_ToFloat64(ctx, &fa, va);
    JSValue vr = JS_NewFloat64(ctx, -fa);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("bnot")))
int64_t qz_guest_bnot(int64_t a)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a);
    double fa = 0;
    JS_ToFloat64(ctx, &fa, va);
    JSValue vr = JS_NewFloat64(ctx, (double)(~(int32_t)fa));
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("band")))
int64_t qz_guest_band(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    double fa = 0, fb = 0;
    JS_ToFloat64(ctx, &fa, va);
    JS_ToFloat64(ctx, &fb, vb);
    JSValue vr = JS_NewFloat64(ctx, (double)((int32_t)fa & (int32_t)fb));
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("bor")))
int64_t qz_guest_bor(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    double fa = 0, fb = 0;
    JS_ToFloat64(ctx, &fa, va);
    JS_ToFloat64(ctx, &fb, vb);
    JSValue vr = JS_NewFloat64(ctx, (double)((int32_t)fa | (int32_t)fb));
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("bxor")))
int64_t qz_guest_bxor(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    double fa = 0, fb = 0;
    JS_ToFloat64(ctx, &fa, va);
    JS_ToFloat64(ctx, &fb, vb);
    JSValue vr = JS_NewFloat64(ctx, (double)((int32_t)fa ^ (int32_t)fb));
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("truthy")))
int64_t qz_guest_truthy(int64_t a)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a);
    JSValue vr = JS_NewBool(ctx, JS_ToBool(ctx, va));
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vr);
    return r;
}

/* ── M6b PoC: object_get/object_set（复杂原语，handle table + JS API）────── */
__attribute__((export_name("object_get")))
int64_t qz_guest_object_get(int64_t obj, int64_t key)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue o = qz_tojs(ctx, obj);
    JSValue k = qz_tojs(ctx, key);
    size_t klen = 0;
    const char *kstr = JS_ToCStringLen(ctx, &klen, k);
    JSValue vr = kstr ? JS_GetPropertyStr(ctx, o, kstr) : JS_UNDEFINED;
    JS_FreeCString(ctx, kstr);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, o); JS_FreeValue(ctx, k); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("object_set")))
int64_t qz_guest_object_set(int64_t obj, int64_t key, int64_t val)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue o = qz_tojs(ctx, obj);
    JSValue k = qz_tojs(ctx, key);
    JSValue v = qz_tojs(ctx, val);
    size_t klen = 0;
    const char *kstr = JS_ToCStringLen(ctx, &klen, k);
    int rc = kstr ? JS_SetPropertyStr(ctx, o, kstr, v) : -1;
    JS_FreeCString(ctx, kstr);
    JS_FreeValue(ctx, o); JS_FreeValue(ctx, k); JS_FreeValue(ctx, v);
    return (int64_t)rc;
}

/* ── M6b PoC: to_string/string_new/object_new（字符串+对象原语）────────── */
__attribute__((export_name("to_string")))
int64_t qz_guest_to_string(int64_t a)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a);
    size_t len = 0;
    const char *s = JS_ToCStringLen(ctx, &len, va);
    JSValue vr = s ? JS_NewStringLen(ctx, s, len) : JS_UNDEFINED;
    JS_FreeCString(ctx, s);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("string_new")))
int64_t qz_guest_string_new(int64_t off, int64_t len)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    const char *mem = (const char *)(uintptr_t)off;
    JSValue vr = JS_NewStringLen(ctx, mem, (size_t)len);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("object_new")))
int64_t qz_guest_object_new(void)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue vr = JS_NewObject(ctx);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, vr);
    return r;
}

/* ── M6b PoC: alloc/object_delete（memory 管理 + 对象操作）────────── */
__attribute__((export_name("alloc")))
int64_t qz_guest_alloc(int64_t size)
{
    void *p = malloc((size_t)size);
    return (int64_t)(uintptr_t)p;
}

__attribute__((export_name("object_delete")))
int64_t qz_guest_object_delete(int64_t obj, int64_t key)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue o = qz_tojs(ctx, obj);
    JSValue k = qz_tojs(ctx, key);
    size_t klen = 0;
    const char *kstr = JS_ToCStringLen(ctx, &klen, k);
    int rc = -1;
    if (kstr) {
        JSAtom atom = JS_NewAtomLen(ctx, kstr, klen);
        rc = JS_DeleteProperty(ctx, o, atom, 0);
        JS_FreeAtom(ctx, atom);
    }
    JS_FreeCString(ctx, kstr);
    JS_FreeValue(ctx, o); JS_FreeValue(ctx, k);
    return (int64_t)rc;
}

/* ── M6b PoC: str_dup 包装 QuickJS（handle table 原语 C 实现模式验证）────── */
/* emitter 产物 import "qz" "str_dup" (i64)->i64 链接到此。
 * strRead: a = 0x7FFA | off（字符串句柄）。off = 共享 memory 偏移。
 *   memory[off..off+4] = len（LE i32），memory[off+4..off+4+len] = UTF-8。
 *   → JS_NewStringLen 创建 JSValue。
 * strWriteback: JSValue → JS_ToCStringLen → UTF-8 → malloc buffer
 *   [len:i32][utf8] → 返回 0x7FFA | new_off。
 * malloc 用 wasi-libc heap（共享 memory 区域），emitter 产物经共享 memory 可访问。
 * PoC 简化: malloc buffer 不 free（字符串句柄持久，泄漏接受）；自管 bump arena +
 * memory 布局协调（emitter STR_BUMP vs wasi-libc heap）是完整落地工程。
 * g_current_rt NULL（未经 qz_eval 流）时 fallback 返回 a（验 multi-module 链接）。 */
__attribute__((export_name("str_dup")))
int64_t qz_guest_str_dup(int64_t a)
{
    if (!g_current_rt) return a;  /* fallback: 未经 qz_eval 流 */
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue jsv = qz_tojs(ctx, a);        /* strRead: 0x7FFA|off → JSValue */
    int64_t r = qz_ret(ctx, jsv);         /* strWriteback: JSValue → 0x7FFA|new_off */
    JS_FreeValue(ctx, jsv);
    return r;
}
