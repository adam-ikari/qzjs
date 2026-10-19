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
/* M6b: 宿主写入的字符串表基址（0=未设置，此时 i32 id 按偏移直读）。
 * 由宿主经导出 __set_strtab(base:i32) 设定，见 qzvm.js。*/
static uint32_t g_strtab_base = 0;
uint32_t qz_strtab_base_addr(void) { return g_strtab_base; }

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
    g_current_rt = rt;  /* M6b: 宿主驱动原语（emitter 产物经 multi-module 调 qz.*）需活动 rt */

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
    if (g_current_rt == rt) g_current_rt = NULL;
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
    qz_t *prev = g_current_rt;
    g_current_rt = rt;  /* M6b: 供 qz_guest_add（emitter 产物经 multi-module 调）读 */
    int rc = qz_eval_internal(rt, buf, &err);
    g_current_rt = prev;  /* 恢复（qz_create 已设为 rt，宿主驱动原语仍可调；避免悬空） */
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
static int g_handle_count = 2;   /* 槽 0=undefined / 1=null（emitter 固定约定），真实句柄从 2 起 */

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
    /* canonical quiet NaN = 0x7FF8000000000000，高 16 位恰为 0x7FF8（BigInt 句柄标记）。
     * 必须先排除，否则 NaN 会被当成句柄下标 0 → 静默读成 undefined。*/
    if (bits == 0x7FF8000000000000ULL) return JS_NAN;
    /* 其余非句柄位型（|tag| 不在句柄区间）按 f64 位型解释。*/
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
    if (tag == 0x7FF9) {  /* handle table；idx 0=undefined / 1=null 固定槽（emitter 约定）*/
        uint32_t idx = (uint32_t)(b & 0xFFFFFFFF);
        if (idx == 0) return JS_UNDEFINED;
        if (idx == 1) return JS_NULL;
        if (idx < (uint32_t)g_handle_count) return JS_DupValue(ctx, g_handles[idx]);
    }
    if (tag == 0x7FF8) {  /* BigInt 句柄（BIG_HI|idx；idx≠0，0=canonical NaN） */
        uint32_t idx = (uint32_t)(b & 0xFFFFFFFF);
        if (idx != 0 && idx < (uint32_t)g_handle_count) return JS_DupValue(ctx, g_handles[idx]);
    }
    return JS_UNDEFINED;  /* 其他 tag 后续 */
}

static int64_t qz_ret(JSContext *ctx, JSValue r)
{
    /* wasm32 走 JS_NAN_BOXING：JS_VALUE_GET_TAG 对 float64 返回位型高位（如 0x3FF00000），
     * 只有 JS_VALUE_GET_NORM_TAG 才归一为 JS_TAG_* 常量。用错会把数值误判成对象句柄。*/
    int tag = JS_VALUE_GET_NORM_TAG(r);
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
    /* 固定槽：undefined = 0x7FF9|0，null = 0x7FF9|1（emitter 约定，见 _emitUndefined/_emitNull）。*/
    if (JS_IsUndefined(r)) return ((int64_t)0x7FF9 << 48);
    if (JS_IsNull(r))      return ((int64_t)0x7FF9 << 48) | 1;
    int idx = g_handle_count++;
    if (idx >= QZ_MAX_HANDLES) return 0;
    g_handles[idx] = JS_DupValue(ctx, r);
    if (JS_IsBigInt(r)) return ((int64_t)0x7FF8 << 48) | (uint32_t)idx;  /* BigInt 句柄（BIG_HI） */
    /* 对象/闭包/数组等 → handle table 注册（0x7FF9 | idx） */
    return ((int64_t)0x7FF9 << 48) | (uint32_t)idx;
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

/* ── M6b: 位移/幂/比较/类型判定原语 ────────────────────────────────
 * 共用「解包 → JS 运算 → 装箱」形态；与 band/bor 等既有原语一致。*/
#define QZ_BINOP(export_name_, cexpr_)                                        \
    __attribute__((export_name(#export_name_)))                               \
    int64_t qz_guest_##export_name_(int64_t a, int64_t b)                     \
    {                                                                         \
        if (!g_current_rt) return a;                                          \
        JSContext *ctx = qz_get_active_jsctx(g_current_rt);                   \
        if (!ctx) return a;                                                   \
        JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);                   \
        double fa = 0, fb = 0;                                                \
        JS_ToFloat64(ctx, &fa, va);                                           \
        JS_ToFloat64(ctx, &fb, vb);                                           \
        JSValue vr = JS_NewFloat64(ctx, (double)(cexpr_));                    \
        int64_t r = qz_ret(ctx, vr);                                          \
        JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);  \
        return r;                                                             \
    }

/* JS 位移按 32 位：先 ToInt32 再移，结果转 int32（<< 结果按 uint32 位型保序）。
 * 注意 (uint32_t)fa 对负 f64 是未定义行为，必须先 (int32_t)。*/
QZ_BINOP(shl,  ((int32_t)((uint32_t)(int32_t)fa << ((uint32_t)(int32_t)fb & 31))))
QZ_BINOP(shr,  ((int32_t)fa >> ((uint32_t)(int32_t)fb & 31)))
QZ_BINOP(ushr, ((int32_t)((uint32_t)(int32_t)fa >> ((uint32_t)(int32_t)fb & 31))))

__attribute__((export_name("pow")))
int64_t qz_guest_pow(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    double fa = 0, fb = 0;
    JS_ToFloat64(ctx, &fa, va);
    JS_ToFloat64(ctx, &fb, vb);
    JSValue vr = JS_NewFloat64(ctx, pow(fa, fb));   /* math.h pow：与 JS ** 语义一致 */
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

/* math_pow(f64,f64)→f64：编译期常量折叠与裸 f64 路径用（无需装箱）。*/
__attribute__((export_name("math_pow")))
double qz_guest_math_pow(double a, double b) { return pow(a, b); }

__attribute__((export_name("math_rem")))
double qz_guest_math_rem(double a, double b) { return fmod(a, b); }   /* JS % 是 fmod 语义 */

/* to_num(v)→i64：ToNumber。字符串→数值，其余按 JS 语义。NaN 结果即 NaN 位型。*/
__attribute__((export_name("to_num")))
int64_t qz_guest_to_num(int64_t a)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a);
    double f = 0;
    JS_ToFloat64(ctx, &f, va);
    JSValue vr = JS_NewFloat64(ctx, f);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vr);
    return r;
}

/* is_nullish(v)→i32：v == null（undefined 0x7FF9|0 或 null 0x7FF9|1 固定槽）。*/
__attribute__((export_name("is_nullish")))
int32_t qz_guest_is_nullish(int64_t a)
{
    uint64_t bits = (uint64_t)a;
    return ((bits >> 48) == 0x7FF9 && (bits & 0xFFFFFFFF) <= 1) ? 1 : 0;
}

/* is_undef(v)→i32：v === undefined（固定槽 0x7FF9|0）。*/
__attribute__((export_name("is_undef")))
int32_t qz_guest_is_undef(int64_t a)
{
    return ((uint64_t)a == ((uint64_t)0x7FF9 << 48)) ? 1 : 0;
}

/* 比较类：直接落 JS_IsEqual，避免自行判型掩盖 NaN/跨类型语义。*/
__attribute__((export_name("eq")))
int64_t qz_guest_eq(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    JSValue vr = JS_NewBool(ctx, JS_IsEqual(ctx, va, vb));   /* == */
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("ne")))
int64_t qz_guest_ne(int64_t a, int64_t b)
{
    if (!g_current_rt) return a;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return a;
    JSValue va = qz_tojs(ctx, a), vb = qz_tojs(ctx, b);
    JSValue vr = JS_NewBool(ctx, !JS_IsEqual(ctx, va, vb));  /* != */
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, va); JS_FreeValue(ctx, vb); JS_FreeValue(ctx, vr);
    return r;
}

/* in_op(k, o)→tagged bool：k in o（含原型链）。*/
__attribute__((export_name("in_op")))
int64_t qz_guest_in_op(int64_t key, int64_t obj)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue k = qz_tojs(ctx, key), o = qz_tojs(ctx, obj);
    int found = 0;
    if (JS_IsObject(o)) {
        const char *ks = JS_ToCString(ctx, k);      /* Symbol 键返回 NULL，此处按缺失处理 */
        if (ks) {
            JSAtom atom = JS_NewAtom(ctx, ks);
            if (atom != JS_ATOM_NULL) { found = JS_HasProperty(ctx, o, atom); JS_FreeAtom(ctx, atom); }
            JS_FreeCString(ctx, ks);
        }
    }
    JSValue vr = JS_NewBool(ctx, found);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, k); JS_FreeValue(ctx, o); JS_FreeValue(ctx, vr);
    return r;
}

/* typeof_host(v)→i32：宿主值是否为 JS 函数（typeof v === "function"）。*/
__attribute__((export_name("typeof_host")))
int32_t qz_guest_typeof_host(int64_t a)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue va = qz_tojs(ctx, a);
    int32_t r = JS_IsFunction(ctx, va) ? 1 : 0;
    JS_FreeValue(ctx, va);
    return r;
}

__attribute__((export_name("truthy")))
int32_t qz_guest_truthy(int64_t a)
{
    /* 类实例（0x7FFE）是对象 → 恒真。必须先判：qz_tojs 不认识该 tag，
     * 会退到 undefined → 实例被误判 falsy（`if (inst)` 走错分支）。*/
    if ((uint16_t)((uint64_t)a >> 48) == 0x7FFE) return 1;
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue va = qz_tojs(ctx, a);
    int32_t r = JS_ToBool(ctx, va);
    JS_FreeValue(ctx, va);
    return r;
}

/* ── M6b: strId 字符串表（emitter i32 字段名 id → UTF-8）────────────────
 * emitter 的 i32 实参是模块字符串表下标（emitter.strings[]，宿主侧 JS 数组）。
 * in-module 下无 JS 数组，故宿主在调用 __set_strs 前把整张表序列化进共享
 * memory，guest 侧只读解析。格式（由宿主 qzvm.js 写入）：
 *   [count:i32] 紧接 count 个 [off:i32][len:i32]（相对 STRTAB_ENTRIES），
 *   每个 off 指向 [bytes...]（无 NUL）。
 * 地址约定：宿主按 emit 时的 __strtab_base 全局写入；未设置时退化为直读 0
 * （即把 id 当偏移，供手写 wasm/wat 用例）。*/
static const char *qz_str_by_id(int32_t id, size_t *out_len)
{
    extern uint32_t qz_strtab_base_addr(void);
    uint32_t base = qz_strtab_base_addr();
    if (!base) return NULL;
    const unsigned char *p = (const unsigned char *)(uintptr_t)base;
    int32_t count;
    memcpy(&count, p, 4);
    if (id < 0 || id >= count) return NULL;
    int32_t off, len;
    memcpy(&off, p + 4 + id * 8, 4);
    memcpy(&len, p + 8 + id * 8, 4);
    if (out_len) *out_len = (size_t)len;
    return (const char *)(uintptr_t)off;
}

/* qz_guest_str_id → JSValue：id → 共享内存 UTF-8 → 引擎字符串；无表时按偏移直读。*/
static JSValue qz_strval(JSContext *ctx, int32_t id)
{
    size_t len = 0;
    const char *s = qz_str_by_id(id, &len);
    if (!s) {                       /* 回退：id 视为 [len:i32][utf8] 偏移（手写用例） */
        const unsigned char *p = (const unsigned char *)(uintptr_t)(uint32_t)id;
        uint32_t l;
        memcpy(&l, p, 4);
        return JS_NewStringLen(ctx, (const char *)(p + 4), l);
    }
    return JS_NewStringLen(ctx, s, len);
}

/* ── M6b PoC: object_get/object_set（复杂原语，handle table + JS API）────── */
__attribute__((export_name("object_get")))
int64_t qz_guest_object_get(int64_t obj, int32_t keyId)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue o = qz_tojs(ctx, obj);
    JSValue k = qz_strval(ctx, keyId);
    size_t klen = 0;
    const char *kstr = JS_ToCStringLen(ctx, &klen, k);
    JSValue vr = kstr ? JS_GetPropertyStr(ctx, o, kstr) : JS_UNDEFINED;
    JS_FreeCString(ctx, kstr);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, o); JS_FreeValue(ctx, k); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("object_set")))
void qz_guest_object_set(int64_t obj, int32_t keyId, int64_t val)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    JSValue o = qz_tojs(ctx, obj);
    JSValue k = qz_strval(ctx, keyId);
    JSValue v = qz_tojs(ctx, val);
    size_t klen = 0;
    const char *kstr = JS_ToCStringLen(ctx, &klen, k);
    /* JS_SetPropertyStr 接管 v 的所有权（成功/失败均消费）；不可再 JS_FreeValue(v)。*/
    if (kstr) { JS_SetPropertyStr(ctx, o, kstr, v); JS_FreeCString(ctx, kstr); }
    else      { JS_FreeValue(ctx, v); }
    JS_FreeValue(ctx, o); JS_FreeValue(ctx, k);
}

/* ── M6b: 属性写/删、下标访问、长度、对象合并、键序登记 ──────────────
 * 键有两种来源：i32 strId（编译期字符串表）与 i64 字符串句柄（运行期字符串）。
 * 键序登记（field_order 系列）落对象自身的隐藏数组 __qz_keys：AOT 侧只要求
 * 「按插入序枚举」，JS 自身属性枚举即有序，故它是可读的冗余名单。*/

/* 取属性（缺失即 undefined，不抛异常）。*/
static JSValue qz_get_prop_key(JSContext *ctx, JSValue obj, JSValue key)
{
    if (!JS_IsObject(obj) || JS_IsSymbol(key)) return JS_UNDEFINED;
    const char *ks = JS_ToCString(ctx, key);
    if (!ks) return JS_UNDEFINED;
    JSValue v = JS_GetPropertyStr(ctx, obj, ks);
    JS_FreeCString(ctx, ks);
    return v;
}

/* 设属性（失败静默，同非严格模式赋值）。val 所有权被接管。*/
static void qz_set_prop_key(JSContext *ctx, JSValue obj, JSValue key, JSValue val)
{
    if (!JS_IsObject(obj) || JS_IsSymbol(key)) { JS_FreeValue(ctx, val); return; }
    const char *ks = JS_ToCString(ctx, key);
    if (!ks) { JS_FreeValue(ctx, val); return; }
    JS_SetPropertyStr(ctx, obj, ks, val);   /* 接管 val */
    JS_FreeCString(ctx, ks);
}

/* ── 全局字段表：字段名 → 全局槽索引 ─────────────────────────────────────
 * emitter 的 fieldMap 是**全局**的（`_fieldIndex(name) = (idx+1)*8`），所有类的
 * 实例共用同一套偏移。故 C 侧只需一张有序名字表即可定位任意实例的字段，
 * 不必按类存布局。宿主经 __set_fields 注入：[count:i32][strOff:i32][len:i32]×count。*/
static uint32_t g_fields_base = 0;

__attribute__((export_name("__set_fields")))
void qz_guest_set_fields(int32_t base)
{
    g_fields_base = (uint32_t)base;
}

/* 按 nameStrId 查全局字段索引；-1 = 该名不是字段。*/
static int32_t qz_field_index(int32_t nameStrId)
{
    if (!g_fields_base) return -1;
    size_t wlen = 0;
    const char *want = qz_str_by_id(nameStrId, &wlen);
    if (!want || wlen >= 256) return -1;
    const unsigned char *b = (const unsigned char *)(uintptr_t)g_fields_base;
    int32_t count;
    memcpy(&count, b, 4);
    for (int32_t i = 0; i < count; i++) {
        uint32_t off, len;
        memcpy(&off, b + 4 + i * 8, 4);
        memcpy(&len, b + 8 + i * 8, 4);
        if (len == wlen && memcmp((const void *)(uintptr_t)off, want, len) == 0) return i;
    }
    return -1;
}

/* 前向：类访问器链查找（定义于 classMeta 节）+ 类方法蹦床类型。*/
static int32_t qz_clsmeta_accessor_chain(int32_t clsId, int32_t nameStrId, int wantSet, int32_t *found);
typedef int64_t (*qz_cls_fn)(int64_t, int64_t, int64_t, int64_t, int64_t);
/* 前向：闭包分派（定义于 closure_call 节）。*/
int64_t qz_guest_closure_call(int64_t handle, int64_t a0, int64_t a1, int64_t a2,
                              int64_t a3, int64_t recv);

/* ── 运行时访问器表（Object.defineProperty / 对象字面量 getter-setter）──
 * 键 (宿主对象句柄, nameStrId)，值是 getter/setter 闭包句柄（0x7FFF|off，0=无）。
 * prop_get/prop_set 命中则经 closure_call 分派到 wasm 蹦床——C 侧无法把 wasm
 * 函数包成 JSFunction，故访问器必须由本层自己维护并分派。*/
#define QZ_ACC_CAP 128
static struct { int64_t obj; int32_t nameId; int64_t getClo, setClo; } g_accs[QZ_ACC_CAP];
static int32_t g_acc_n = 0;

static int32_t qz_acc_find(int64_t obj, int32_t nameStrId)
{
    for (int32_t i = 0; i < g_acc_n; i++)
        if (g_accs[i].obj == obj && g_accs[i].nameId == nameStrId) return i;
    return -1;
}

__attribute__((export_name("prop_set")))
void qz_guest_prop_set(int64_t obj, int32_t keyId, int64_t val)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    JSValue o = qz_tojs(ctx, obj);
    JSValue k = qz_strval(ctx, keyId);
    /* 访问器优先：命中且有 setter → 调 setter(val)，不写底层属性 */
    { int32_t ai = qz_acc_find(obj, keyId);
      if (ai >= 0 && g_accs[ai].setClo) {
          qz_guest_closure_call(g_accs[ai].setClo, val, 0, 0, 0, obj);
          JS_FreeValue(ctx, k); JS_FreeValue(ctx, o);
          return;
      } }
    /* 类实例 setter：classMeta.accessors → 表槽 → 蹦床(self, val) */
    if ((uint16_t)((uint64_t)obj >> 48) == 0x7FFE) {
        int32_t clsId; memcpy(&clsId, (const unsigned char *)(uintptr_t)(uint32_t)(uint64_t)obj, 4);
        int32_t found = 0;
        int32_t slot = qz_clsmeta_accessor_chain(clsId, keyId, 1, &found);
        if (found) {
            JS_FreeValue(ctx, k); JS_FreeValue(ctx, o);
            if (slot > 0) ((qz_cls_fn)(uintptr_t)(uint32_t)slot)(obj, val, 0, 0, 0);
            return;
        }
        /* 字段写：与 prop_get 对称。越界写静默丢弃（实例 size 是编译期定值）。*/
        int32_t fi = qz_field_index(keyId);
        if (fi >= 0) {
            uint32_t inst = (uint32_t)((uint64_t)obj & 0xFFFFFFFFu);
            int32_t sz = 0;
            if (inst >= 8) memcpy(&sz, (const void *)(uintptr_t)(inst + 4), 4);
            uint32_t foff = (uint32_t)(fi + 1) * 8;
            if (inst >= 8 && foff + 8 <= (uint32_t)sz) memcpy((void *)(uintptr_t)(inst + foff), &val, 8);
            JS_FreeValue(ctx, k); JS_FreeValue(ctx, o);
            return;
        }
    }
    qz_set_prop_key(ctx, o, k, qz_tojs(ctx, val));
    JS_FreeValue(ctx, o); JS_FreeValue(ctx, k);
}

__attribute__((export_name("prop_delete")))
void qz_guest_prop_delete(int64_t obj, int32_t keyId)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    JSValue o = qz_tojs(ctx, obj);
    JSValue k = qz_strval(ctx, keyId);
    if (JS_IsObject(o) && !JS_IsSymbol(k)) {
        const char *ks = JS_ToCString(ctx, k);
        if (ks) {
            JSAtom atom = JS_NewAtom(ctx, ks);
            if (atom != JS_ATOM_NULL) { JS_DeleteProperty(ctx, o, atom, 0); JS_FreeAtom(ctx, atom); }
            JS_FreeCString(ctx, ks);
        }
    }
    JS_FreeValue(ctx, o); JS_FreeValue(ctx, k);
}

/* length_of(v)→i64：.length（字符串码元数 / 数组长度）。*/
__attribute__((export_name("length_of")))
int64_t qz_guest_length_of(int64_t v)
{
    if (!g_current_rt) return v;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return v;
    JSValue o = qz_tojs(ctx, v);
    JSValue lv = JS_GetPropertyStr(ctx, o, "length");
    double f = 0; JS_ToFloat64(ctx, &f, lv);
    JSValue vr = JS_NewFloat64(ctx, f);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, o); JS_FreeValue(ctx, lv); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("get_index")))
int64_t qz_guest_get_index(int64_t obj, int64_t key)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue o = qz_tojs(ctx, obj), k = qz_tojs(ctx, key);
    JSValue vr = qz_get_prop_key(ctx, o, k);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, o); JS_FreeValue(ctx, k); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("set_index")))
void qz_guest_set_index(int64_t obj, int64_t key, int64_t val)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    JSValue o = qz_tojs(ctx, obj), k = qz_tojs(ctx, key);
    qz_set_prop_key(ctx, o, k, qz_tojs(ctx, val));
    JS_FreeValue(ctx, o); JS_FreeValue(ctx, k);
}

/* delete_index(o,k)→tagged bool。arr_delete_index 同语义（JS 数组 delete 即留洞）。*/
__attribute__((export_name("delete_index")))
int64_t qz_guest_delete_index(int64_t obj, int64_t key)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue o = qz_tojs(ctx, obj), k = qz_tojs(ctx, key);
    int ok = 1;
    if (JS_IsObject(o) && !JS_IsSymbol(k)) {
        const char *ks = JS_ToCString(ctx, k);
        if (ks) {
            JSAtom atom = JS_NewAtom(ctx, ks);
            if (atom != JS_ATOM_NULL) { ok = JS_DeleteProperty(ctx, o, atom, 0) >= 0; JS_FreeAtom(ctx, atom); }
            JS_FreeCString(ctx, ks);
        }
    }
    JSValue vr = JS_NewBool(ctx, ok);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, o); JS_FreeValue(ctx, k); JS_FreeValue(ctx, vr);
    return r;
}

__attribute__((export_name("arr_delete_index")))
int64_t qz_guest_arr_delete_index(int64_t arr, int64_t key)
{
    return qz_guest_delete_index(arr, key);
}

__attribute__((export_name("elem_get_guard")))
int64_t qz_guest_elem_get_guard(int64_t obj, int64_t key)
{
    return qz_guest_get_index(obj, key);
}

__attribute__((export_name("obj_new")))
int64_t qz_guest_obj_new(void)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue o = JS_NewObject(ctx);
    int64_t r = qz_ret(ctx, o);
    JS_FreeValue(ctx, o);
    return r;
}

/* obj_merge(dst, src)：{...src}——自有可枚举字符串键，后者覆盖。*/
__attribute__((export_name("obj_merge")))
void qz_guest_obj_merge(int64_t dst, int64_t src)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    JSValue d = qz_tojs(ctx, dst), s = qz_tojs(ctx, src);
    JSPropertyEnum *tab = NULL;
    uint32_t n = 0;
    if (JS_IsObject(d) && JS_IsObject(s) &&
        JS_GetOwnPropertyNames(ctx, &tab, &n, s, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
        for (uint32_t i = 0; i < n; i++) {
            JSValue v = JS_GetProperty(ctx, s, tab[i].atom);
            JS_SetProperty(ctx, d, tab[i].atom, v);   /* 接管 v */
            JS_FreeAtom(ctx, tab[i].atom);
        }
        js_free(ctx, tab);
    }
    JS_FreeValue(ctx, d); JS_FreeValue(ctx, s);
}

/* arr_set_len(a,n)→i64：设 length（截断/扩容）。*/
__attribute__((export_name("arr_set_len")))
int64_t qz_guest_arr_set_len(int64_t arr, int64_t n)
{
    if (!g_current_rt) return arr;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return arr;
    JSValue a = qz_tojs(ctx, arr), nv = qz_tojs(ctx, n);
    double f = 0; JS_ToFloat64(ctx, &f, nv);
    if (JS_IsObject(a)) JS_SetPropertyStr(ctx, a, "length", JS_NewFloat64(ctx, f));
    JSValue vr = JS_NewFloat64(ctx, f);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, a); JS_FreeValue(ctx, nv); JS_FreeValue(ctx, vr);
    return r;
}

/* arr_set_index(a,k,v)→i64：a[k]=v（越界由数组语义扩容）。*/
__attribute__((export_name("arr_set_index")))
int64_t qz_guest_arr_set_index(int64_t arr, int64_t key, int64_t val)
{
    if (!g_current_rt) return val;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return val;
    JSValue a = qz_tojs(ctx, arr), k = qz_tojs(ctx, key);
    double fk = 0; JS_ToFloat64(ctx, &fk, k);
    JS_SetPropertyUint32(ctx, a, (uint32_t)fk, qz_tojs(ctx, val));   /* 接管 v */
    JSValue vr = JS_NewFloat64(ctx, fk);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, a); JS_FreeValue(ctx, k); JS_FreeValue(ctx, vr);
    return r;
}

/* ── 键序登记：隐藏数组 __qz_keys（非枚举，不污染 for..in）── */
#define QZ_KEYS "__qz_keys"

static void qz_note_key(JSContext *ctx, JSValue obj, const char *name, size_t len)
{
    if (!JS_IsObject(obj) || !name) return;
    JSValue arr = JS_GetPropertyStr(ctx, obj, QZ_KEYS);
    if (!JS_IsArray(arr)) {
        JS_FreeValue(ctx, arr);
        arr = JS_NewArray(ctx);
        if (JS_IsException(arr)) { JS_FreeValue(ctx, arr); return; }
        JS_DefinePropertyValueStr(ctx, obj, QZ_KEYS, JS_DupValue(ctx, arr), 0);  /* 不可枚举/不可写 */
    }
    JSValue lv = JS_GetPropertyStr(ctx, arr, "length");
    double f = 0; JS_ToFloat64(ctx, &f, lv);
    JS_FreeValue(ctx, lv);
    JS_SetPropertyUint32(ctx, arr, (uint32_t)f, JS_NewStringLen(ctx, name, len));
    JS_FreeValue(ctx, arr);
}

__attribute__((export_name("field_order")))
void qz_guest_field_order(int64_t obj, int64_t keyStr)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    JSValue o = qz_tojs(ctx, obj), k = qz_tojs(ctx, keyStr);
    size_t len = 0;
    const char *s = JS_ToCStringLen(ctx, &len, k);
    qz_note_key(ctx, o, s, len);
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, o); JS_FreeValue(ctx, k);
}

__attribute__((export_name("order_note")))
void qz_guest_order_note(int64_t obj, int32_t strId)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    JSValue o = qz_tojs(ctx, obj);
    size_t len = 0;
    const char *s = qz_str_by_id(strId, &len);
    if (s) qz_note_key(ctx, o, s, len);
    JS_FreeValue(ctx, o);
}

/* field_order_lit(obj,strId)：批量登记，名单以 \0 分隔。*/
__attribute__((export_name("field_order_lit")))
void qz_guest_field_order_lit(int64_t obj, int32_t strId)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    JSValue o = qz_tojs(ctx, obj);
    size_t len = 0;
    const char *s = qz_str_by_id(strId, &len);
    if (s) {
        size_t start = 0;
        for (size_t i = 0; i <= len; i++) {
            if (i == len || s[i] == '\0') {
                if (i > start) qz_note_key(ctx, o, s + start, i - start);
                start = i + 1;
            }
        }
    }
    JS_FreeValue(ctx, o);
}

__attribute__((export_name("field_order_del")))
void qz_guest_field_order_del(int64_t obj, int64_t keyStr)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    JSValue o = qz_tojs(ctx, obj), k = qz_tojs(ctx, keyStr);
    size_t klen = 0;
    const char *ks = JS_ToCStringLen(ctx, &klen, k);
    if (ks && JS_IsObject(o)) {
        JSValue arr = JS_GetPropertyStr(ctx, o, QZ_KEYS);
        if (JS_IsArray(arr)) {
            JSValue lv = JS_GetPropertyStr(ctx, arr, "length");
            double f = 0; JS_ToFloat64(ctx, &f, lv);
            JS_FreeValue(ctx, lv);
            uint32_t n = (uint32_t)f, w = 0;
            for (uint32_t i = 0; i < n; i++) {
                JSValue e = JS_GetPropertyUint32(ctx, arr, i);
                size_t elen = 0;
                const char *es = JS_ToCStringLen(ctx, &elen, e);
                int same = es && elen == klen && memcmp(es, ks, klen) == 0;
                JS_FreeCString(ctx, es);
                if (!same) { if (w != i) JS_SetPropertyUint32(ctx, arr, w, JS_DupValue(ctx, e)); w++; }
                JS_FreeValue(ctx, e);
            }
            JS_SetPropertyStr(ctx, arr, "length", JS_NewFloat64(ctx, (double)w));
        }
        JS_FreeValue(ctx, arr);
    }
    JS_FreeCString(ctx, ks);
    JS_FreeValue(ctx, o); JS_FreeValue(ctx, k);
}

/* spread_order(dst,src)：把 src 的键序补登记到 dst。*/
__attribute__((export_name("spread_order")))
void qz_guest_spread_order(int64_t dst, int64_t src)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    JSValue d = qz_tojs(ctx, dst), s = qz_tojs(ctx, src);
    if (JS_IsObject(d) && JS_IsObject(s)) {
        JSValue arr = JS_GetPropertyStr(ctx, s, QZ_KEYS);
        if (JS_IsArray(arr)) {
            JSValue lv = JS_GetPropertyStr(ctx, arr, "length");
            double f = 0; JS_ToFloat64(ctx, &f, lv);
            JS_FreeValue(ctx, lv);
            uint32_t n = (uint32_t)f;
            for (uint32_t i = 0; i < n; i++) {
                JSValue e = JS_GetPropertyUint32(ctx, arr, i);
                size_t elen = 0;
                const char *es = JS_ToCStringLen(ctx, &elen, e);
                qz_note_key(ctx, d, es, elen);
                JS_FreeCString(ctx, es);
                JS_FreeValue(ctx, e);
            }
        }
        JS_FreeValue(ctx, arr);
    }
    JS_FreeValue(ctx, d); JS_FreeValue(ctx, s);
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

/* string_new(off:i32) → 句柄：off 指向 [len:i32][utf8]（emitter 字面量布局）。*/
__attribute__((export_name("string_new")))
int64_t qz_guest_string_new(int32_t off)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    const unsigned char *p = (const unsigned char *)(uintptr_t)(uint32_t)off;
    uint32_t l;
    memcpy(&l, p, 4);
    JSValue vr = JS_NewStringLen(ctx, (const char *)(p + 4), l);
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
/* alloc(i32) → i32：bump 分配。in-module 下 emitter 产物用的是自己的 bump arena，
 * 本导出仅供宿主/测试向共享内存申请临时区；返回 wasi-libc malloc 指针。*/
__attribute__((export_name("alloc")))
int32_t qz_guest_alloc(int32_t size)
{
    void *p = malloc((size_t)(uint32_t)size);
    return (int32_t)(uintptr_t)p;
}


__attribute__((export_name("object_delete")))
void qz_guest_object_delete(int64_t obj, int32_t keyId)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    JSValue o = qz_tojs(ctx, obj);
    JSValue k = qz_strval(ctx, keyId);
    size_t klen = 0;
    const char *kstr = JS_ToCStringLen(ctx, &klen, k);
    if (kstr) {
        JSAtom atom = JS_NewAtomLen(ctx, kstr, klen);
        JS_DeleteProperty(ctx, o, atom, 0);
        JS_FreeAtom(ctx, atom);
    }
    JS_FreeCString(ctx, kstr);
    JS_FreeValue(ctx, o); JS_FreeValue(ctx, k);
}

/* __set_strtab(base:i32)：宿主在首次调用原语前写入字符串表基址。
 * 表格式见 qz_str_by_id 注释（count + [off,len] 表 + 字节块）。*/
__attribute__((export_name("__set_strtab")))
void qz_guest_set_strtab(int32_t base)
{
    g_strtab_base = (uint32_t)base;
}

/* prop_get(recv:i64, keyId:i32) → i64：通用属性读（原型链/getter/装箱）。
 * 接收者为 null/undefined → undefined，由调用点 _emitErrCheck 转 TypeError。*/
__attribute__((export_name("prop_get")))
int64_t qz_guest_prop_get(int64_t recv, int32_t keyId)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue o = qz_tojs(ctx, recv);
    JSValue k = qz_strval(ctx, keyId);
    /* 访问器优先：命中则调 getter（无 getter → undefined，与 JS 语义一致） */
    { int32_t ai = qz_acc_find(recv, keyId);
      if (ai >= 0) {
          int64_t g = g_accs[ai].getClo;
          JS_FreeValue(ctx, k); JS_FreeValue(ctx, o);
          return g ? qz_guest_closure_call(g, 0, 0, 0, 0, recv) : 0;
      } }
    /* 类实例 getter：classMeta.accessors → 表槽 → 蹦床(self) */
    if ((uint16_t)((uint64_t)recv >> 48) == 0x7FFE) {
        int32_t clsId; memcpy(&clsId, (const unsigned char *)(uintptr_t)(uint32_t)(uint64_t)recv, 4);
        int32_t found = 0;
        int32_t slot = qz_clsmeta_accessor_chain(clsId, keyId, 0, &found);
        if (found) {
            JS_FreeValue(ctx, k); JS_FreeValue(ctx, o);
            return slot > 0 ? ((qz_cls_fn)(uintptr_t)(uint32_t)slot)(recv, 0, 0, 0, 0) : 0;
        }
        /* 字段读：全局字段表给索引 → 偏移 (idx+1)*8；越界（未赋值/无此字段）→ undefined。*/
        int32_t fi = qz_field_index(keyId);
        if (fi >= 0) {
            uint32_t inst = (uint32_t)((uint64_t)recv & 0xFFFFFFFFu);
            int32_t sz = 0;
            if (inst >= 8) memcpy(&sz, (const void *)(uintptr_t)(inst + 4), 4);
            uint32_t foff = (uint32_t)(fi + 1) * 8;
            if (inst >= 8 && foff + 8 <= (uint32_t)sz) {
                int64_t v; memcpy(&v, (const void *)(uintptr_t)(inst + foff), 8);
                JS_FreeValue(ctx, k); JS_FreeValue(ctx, o);
                return v;
            }
            JS_FreeValue(ctx, k); JS_FreeValue(ctx, o);
            return (int64_t)((uint64_t)0x7FF9 << 48);   /* undefined 句柄 */
        }
    }
    JSValue vr = JS_UNDEFINED;
    if (!JS_IsNull(o) && !JS_IsUndefined(o)) {
        size_t klen = 0;
        const char *kstr = JS_ToCStringLen(ctx, &klen, k);
        if (kstr) { vr = JS_GetPropertyStr(ctx, o, kstr); JS_FreeCString(ctx, kstr); }
    }
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, o); JS_FreeValue(ctx, k); JS_FreeValue(ctx, vr);
    return r;
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

/* ── M6b PoC: math_floor（i32 域，Math.floor 常用 op）────────── */
__attribute__((export_name("math_floor")))
int32_t qz_guest_math_floor(int32_t x)
{
    return x;  /* i32 域 Math.floor 恒等（emitter 用 i32 数组索引场景，x 已整数） */
}

/* ── M6b PoC: bigint_binop（0x7FF8 BigInt 句柄，op+i64×2）────────── */
/* op: 0+ 1- 2* 3/ 4% 5=== 6!== 7< 8<= 9> 10>= 11~ 12& 13| 14^ 15<< 16>> 17** */
__attribute__((export_name("bigint_binop")))
int64_t qz_guest_bigint_binop(int32_t op, int64_t a, int64_t b)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue x = qz_tojs(ctx, a);
    JSValue y = qz_tojs(ctx, b);
    int64_t xi = 0, yi = 0;
    JS_ToBigInt64(ctx, &xi, x);
    JS_ToBigInt64(ctx, &yi, y);
    int64_t zi = 0;
    int is_cmp = 0, cmp_r = 0;
    switch (op) {
    case 0: zi = xi + yi; break;
    case 1: zi = xi - yi; break;
    case 2: zi = xi * yi; break;
    case 3: zi = yi ? xi / yi : 0; break;
    case 4: zi = yi ? xi % yi : 0; break;
    case 5: is_cmp = 1; cmp_r = (xi == yi); break;
    case 6: is_cmp = 1; cmp_r = (xi != yi); break;
    case 7: is_cmp = 1; cmp_r = (xi <  yi); break;
    case 8: is_cmp = 1; cmp_r = (xi <= yi); break;
    case 9: is_cmp = 1; cmp_r = (xi >  yi); break;
    case 10: is_cmp = 1; cmp_r = (xi >= yi); break;
    case 11: zi = ~xi; break;
    case 12: zi = xi & yi; break;
    case 13: zi = xi | yi; break;
    case 14: zi = xi ^ yi; break;
    case 15: zi = xi << yi; break;
    case 16: zi = xi >> yi; break;
    case 17: { int64_t acc = 1; for (int64_t i = 0; i < yi; i++) acc *= xi; zi = acc; break; }
    default: JS_FreeValue(ctx, x); JS_FreeValue(ctx, y); return 0;
    }
    JSValue vr;
    if (is_cmp) vr = JS_NewBool(ctx, cmp_r);
    else vr = JS_NewBigInt64(ctx, zi);
    int64_t r = qz_ret(ctx, vr);
    JS_FreeValue(ctx, x); JS_FreeValue(ctx, y); JS_FreeValue(ctx, vr);
    return r;
}

/* ── M6b: 闭包环境层链 ────────────────────────────────────────────
 * emitter 约定：env 句柄是 i32 索引（-1 = 根，0 = 无捕获），闭包值 = 0x7FFF|off
 * 指向 bump arena 的 [funcidx][envIdx][arity][nameStrId]。
 * 宿主维护一张层表；层内按 strId 存值，读取沿 parent 链上溯。*/
typedef struct QzEnv {
    int32_t parent;
    uint32_t count;
    uint32_t cap;
    struct { int32_t nameId; JSValue val; } *slots;
} QzEnv;

static QzEnv *g_envs = NULL;
static uint32_t g_envCount = 0, g_envCap = 0;

static void qz_env_release(void)
{
    for (uint32_t i = 0; i < g_envCount; i++) {
        QzEnv *e = &g_envs[i];
        if (e->slots) {
            JSContext *ctx = g_current_rt ? qz_get_active_jsctx(g_current_rt) : NULL;
            if (ctx) for (uint32_t k = 0; k < e->count; k++) JS_FreeValue(ctx, e->slots[k].val);
            free(e->slots);
        }
    }
    free(g_envs); g_envs = NULL; g_envCount = g_envCap = 0;
}

/* 取（必要时创建）层 i；索引越界返回 NULL。*/
static QzEnv *qz_env_at(uint32_t i, int create)
{
    if (i >= g_envCount) {
        if (!create || i > g_envCount + 1024) return NULL;
        if (g_envCount == 0) return NULL;                 /* 必须先 env_new 建根（索引 0） */
        while (g_envCount <= i) {
            if (g_envCount == g_envCap) {
                uint32_t ncap = g_envCap ? g_envCap * 2 : 64;
                QzEnv *n = (QzEnv *)realloc(g_envs, (size_t)ncap * sizeof(QzEnv));
                if (!n) return NULL;
                memset(n + g_envCap, 0, (size_t)(ncap - g_envCap) * sizeof(QzEnv));
                g_envs = n; g_envCap = ncap;
            }
            g_envs[g_envCount].parent = -1;
            g_envCount++;
        }
    }
    return i < g_envCount ? &g_envs[i] : NULL;
}

__attribute__((export_name("env_new")))
int64_t qz_guest_env_new(int32_t parent)
{
    if (!g_current_rt) return 0;
    if (g_envCount == g_envCap) {
        uint32_t ncap = g_envCap ? g_envCap * 2 : 64;
        QzEnv *n = (QzEnv *)realloc(g_envs, (size_t)ncap * sizeof(QzEnv));
        if (!n) return 0;
        memset(n + g_envCap, 0, (size_t)(ncap - g_envCap) * sizeof(QzEnv));
        g_envs = n; g_envCap = ncap;
    }
    uint32_t idx = g_envCount++;
    g_envs[idx].parent = parent;
    g_envs[idx].count = 0;
    return (int64_t)idx;
}

__attribute__((export_name("env_def")))
void qz_guest_env_def(int32_t envIdx, int32_t nameId, int64_t val)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    QzEnv *e = qz_env_at((uint32_t)envIdx, 0);
    if (!e) return;
    JSValue v = qz_tojs(ctx, val);
    for (uint32_t k = 0; k < e->count; k++) {
        if (e->slots[k].nameId == nameId) { JS_FreeValue(ctx, e->slots[k].val); e->slots[k].val = v; return; }
    }
    if (e->count == e->cap) {
        uint32_t ncap = e->cap ? e->cap * 2 : 8;
        void *n = realloc(e->slots, (size_t)ncap * sizeof(*e->slots));
        if (!n) { JS_FreeValue(ctx, v); return; }
        e->slots = n; e->cap = ncap;
    }
    e->slots[e->count].nameId = nameId;
    e->slots[e->count].val = v;
    e->count++;
}

/* 沿 parent 链查名字；找到返回 1 并写出值。*/
static int qz_env_lookup(JSContext *ctx, int32_t envIdx, int32_t nameId, JSValue *out)
{
    int32_t i = envIdx;
    int guard = 0;
    while (i >= 0 && (uint32_t)i < g_envCount && guard++ < 4096) {
        QzEnv *e = &g_envs[i];
        for (uint32_t k = 0; k < e->count; k++) {
            if (e->slots[k].nameId == nameId) { *out = JS_DupValue(ctx, e->slots[k].val); return 1; }
        }
        i = e->parent;
    }
    return 0;
}

__attribute__((export_name("env_get")))
int64_t qz_guest_env_get(int32_t envIdx, int32_t nameId)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue v = JS_UNDEFINED;
    if (!qz_env_lookup(ctx, envIdx, nameId, &v)) return (int64_t)0x7FF9000000000000LL;
    int64_t r = qz_ret(ctx, v);
    JS_FreeValue(ctx, v);
    return r;
}

__attribute__((export_name("env_set")))
void qz_guest_env_set(int32_t envIdx, int32_t nameId, int64_t val)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    int32_t i = envIdx, guard = 0;
    JSValue v = qz_tojs(ctx, val);
    while (i >= 0 && (uint32_t)i < g_envCount && guard++ < 4096) {
        QzEnv *e = &g_envs[i];
        for (uint32_t k = 0; k < e->count; k++) {
            if (e->slots[k].nameId == nameId) { JS_FreeValue(ctx, e->slots[k].val); e->slots[k].val = v; return; }
        }
        i = e->parent;
    }
    /* 未找到：写进最内层（JS 语义上的隐式全局在 AOT 中即当前层）*/
    JS_FreeValue(ctx, v);
    qz_guest_env_def(envIdx, nameId, val);
}

/* ── M6b: 迭代协议、字符串/正则/对象杂项 ───────────────────────────
 * 迭代器状态存宿主句柄表（0x7FF9 低 32 位 = 索引）：每项持有 iterator 对象
 * 与其 next 方法，pull 一次调 next，val 取当前结果。*/
typedef struct QzIter {
    JSValue iter;      /* 迭代器对象 */
    JSValue next;      /* 其 next 方法 */
    JSValue cur;       /* 最近一次 next 的 result.value */
    int done;
} QzIter;

static QzIter *g_iters = NULL;
static uint32_t g_iterCount = 0, g_iterCap = 0;

static int qz_iter_slot(uint32_t idx, QzIter **out)
{
    if (idx >= g_iterCount) return 0;
    *out = &g_iters[idx];
    return 1;
}

/* 取迭代器方法：v[Symbol.iterator]() → iterator 对象。*/
static JSValue qz_get_iterator(JSContext *ctx, JSValueConst v)
{
    /* quickjs.h 不导出 atom 枚举：取全局 Symbol.iterator 值，再用 JS_GetProperty 查
     * symbol 键（JS_GetProperty 接受 JSValue atom 形式，Symbol atom 由 JS_ValueToAtom 得到）。*/
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue symC = JS_GetPropertyStr(ctx, g, "Symbol");
    JSValue symIt = JS_GetPropertyStr(ctx, symC, "iterator");
    JS_FreeValue(ctx, symC); JS_FreeValue(ctx, g);
    if (!JS_IsSymbol(symIt)) { JS_FreeValue(ctx, symIt); return JS_EXCEPTION; }
    JSAtom atom = JS_ValueToAtom(ctx, symIt);
    JSValue method = JS_UNDEFINED;
    if (atom != JS_ATOM_NULL) {
        method = JS_GetProperty(ctx, v, atom);
        JS_FreeAtom(ctx, atom);
    }
    JS_FreeValue(ctx, symIt);
    if (JS_IsException(method) || !JS_IsFunction(ctx, method)) {
        JS_FreeValue(ctx, method);
        return JS_EXCEPTION;
    }
    JSValue iter = JS_Call(ctx, method, v, 0, NULL);
    JS_FreeValue(ctx, method);
    return iter;
}

__attribute__((export_name("iter_new")))
int64_t qz_guest_iter_new(int64_t target)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue t = qz_tojs(ctx, target);
    JSValue iter = qz_get_iterator(ctx, t);
    JS_FreeValue(ctx, t);
    if (JS_IsException(iter)) { JS_FreeValue(ctx, iter); return 0; }
    JSValue next = JS_GetPropertyStr(ctx, iter, "next");
    if (g_iterCount == g_iterCap) {
        uint32_t ncap = g_iterCap ? g_iterCap * 2 : 32;
        QzIter *n = (QzIter *)realloc(g_iters, (size_t)ncap * sizeof(QzIter));
        if (!n) { JS_FreeValue(ctx, iter); JS_FreeValue(ctx, next); return 0; }
        memset(n + g_iterCap, 0, (size_t)(ncap - g_iterCap) * sizeof(QzIter));
        g_iters = n; g_iterCap = ncap;
    }
    uint32_t idx = g_iterCount++;
    g_iters[idx].iter = iter;
    g_iters[idx].next = next;
    g_iters[idx].cur = JS_UNDEFINED;
    g_iters[idx].done = 0;
    return (int64_t)(((uint64_t)0x7FF9 << 48) | (uint64_t)idx);
}

/* iter_pull→i64（BigInt 语义：0 = continue，1 = done）。*/
__attribute__((export_name("iter_pull")))
int64_t qz_guest_iter_pull(int64_t handle)
{
    if (!g_current_rt) return 1;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 1;
    QzIter *it = NULL;
    if (!qz_iter_slot((uint32_t)((uint64_t)handle & 0xFFFFFFFFu), &it) || it->done) return 1;
    JSValue res = JS_Call(ctx, it->next, it->iter, 0, NULL);
    if (JS_IsException(res)) { JS_FreeValue(ctx, res); it->done = 1; return 1; }
    JSValue done = JS_GetPropertyStr(ctx, res, "done");
    int isDone = JS_ToBool(ctx, done);
    JS_FreeValue(ctx, done);
    JS_FreeValue(ctx, it->cur);
    it->cur = JS_GetPropertyStr(ctx, res, "value");
    JS_FreeValue(ctx, res);
    if (isDone) { it->done = 1; return 1; }
    return 0;
}

__attribute__((export_name("iter_val")))
int64_t qz_guest_iter_val(int64_t handle)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    QzIter *it = NULL;
    if (!qz_iter_slot((uint32_t)((uint64_t)handle & 0xFFFFFFFFu), &it)) return 0;
    int64_t r = qz_ret(ctx, it->cur);
    return r;
}

__attribute__((export_name("iter_close")))
void qz_guest_iter_close(int64_t handle)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    uint32_t idx = (uint32_t)((uint64_t)handle & 0xFFFFFFFFu);
    QzIter *it = NULL;
    if (!qz_iter_slot(idx, &it)) return;
    if (!it->done) {
        JSValue ret = JS_GetPropertyStr(ctx, it->iter, "return");
        if (JS_IsFunction(ctx, ret)) {
            JSValue r = JS_Call(ctx, ret, it->iter, 0, NULL);
            JS_FreeValue(ctx, r);
        }
        JS_FreeValue(ctx, ret);
        it->done = 1;
    }
    JS_FreeValue(ctx, it->cur);
    it->cur = JS_UNDEFINED;
}

/* iter_array(v)→i64：可迭代物 → 宿主数组（展开用）。*/
__attribute__((export_name("iter_array")))
int64_t qz_guest_iter_array(int64_t v)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue t = qz_tojs(ctx, v);
    JSValue out = JS_NewArray(ctx);
    JSValue iter = qz_get_iterator(ctx, t);
    if (!JS_IsException(iter)) {
        JSValue next = JS_GetPropertyStr(ctx, iter, "next");
        uint32_t n = 0;
        for (;;) {
            JSValue res = JS_Call(ctx, next, iter, 0, NULL);
            if (JS_IsException(res)) { JS_FreeValue(ctx, res); break; }
            JSValue done = JS_GetPropertyStr(ctx, res, "done");
            int isDone = JS_ToBool(ctx, done);
            JS_FreeValue(ctx, done);
            if (isDone) { JS_FreeValue(ctx, res); break; }
            JSValue val = JS_GetPropertyStr(ctx, res, "value");
            JS_SetPropertyUint32(ctx, out, n++, val);   /* 接管 val */
            JS_FreeValue(ctx, res);
        }
        JS_FreeValue(ctx, next);
    }
    JS_FreeValue(ctx, iter);
    JS_FreeValue(ctx, t);
    int64_t r = qz_ret(ctx, out);
    JS_FreeValue(ctx, out);
    return r;
}

/* spread_into(dstArr, src)→i64：[...src] 按迭代协议并入数组。*/
__attribute__((export_name("spread_into")))
int64_t qz_guest_spread_into(int64_t dst, int64_t src)
{
    if (!g_current_rt) return dst;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return dst;
    JSValue d = qz_tojs(ctx, dst), s = qz_tojs(ctx, src);
    if (JS_IsObject(d)) {
        JSValue lv = JS_GetPropertyStr(ctx, d, "length");
        double f = 0; JS_ToFloat64(ctx, &f, lv);
        JS_FreeValue(ctx, lv);
        uint32_t n = (uint32_t)f;
        JSValue iter = qz_get_iterator(ctx, s);
        if (!JS_IsException(iter)) {
            JSValue next = JS_GetPropertyStr(ctx, iter, "next");
            for (;;) {
                JSValue res = JS_Call(ctx, next, iter, 0, NULL);
                if (JS_IsException(res)) { JS_FreeValue(ctx, res); break; }
                JSValue done = JS_GetPropertyStr(ctx, res, "done");
                int isDone = JS_ToBool(ctx, done);
                JS_FreeValue(ctx, done);
                if (isDone) { JS_FreeValue(ctx, res); break; }
                JSValue val = JS_GetPropertyStr(ctx, res, "value");
                JS_SetPropertyUint32(ctx, d, n++, val);
                JS_FreeValue(ctx, res);
            }
            JS_FreeValue(ctx, next);
        }
        JS_FreeValue(ctx, iter);
    }
    int64_t r = qz_ret(ctx, d);
    JS_FreeValue(ctx, d); JS_FreeValue(ctx, s);
    return r;
}

/* empty_array()→i64：rest 形参缺省 / 空数组。*/
__attribute__((export_name("empty_array")))
int64_t qz_guest_empty_array(void)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue a = JS_NewArray(ctx);
    int64_t r = qz_ret(ctx, a);
    JS_FreeValue(ctx, a);
    return r;
}

/* str_chars(s)→i64：字符串 → 码点字符数组（按码点切，非 UTF-16 单元）。*/
__attribute__((export_name("str_chars")))
int64_t qz_guest_str_chars(int64_t v)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue s = qz_tojs(ctx, v);
    JSValue out = JS_NewArray(ctx);
    if (JS_IsString(s)) {
        size_t len = 0;
        const char *p = JS_ToCStringLen(ctx, &len, s);
        if (p) {
            uint32_t n = 0;
            size_t i = 0;
            while (i < len) {
                unsigned char c = (unsigned char)p[i];
                size_t cl = (c < 0x80) ? 1 : (c < 0xE0) ? 2 : (c < 0xF0) ? 3 : 4;
                if (i + cl > len) cl = len - i;
                JS_SetPropertyUint32(ctx, out, n++, JS_NewStringLen(ctx, p + i, cl));
                i += cl;
            }
            JS_FreeCString(ctx, p);
        }
    }
    int64_t r = qz_ret(ctx, out);
    JS_FreeValue(ctx, s); JS_FreeValue(ctx, out);
    return r;
}

/* regex(strId)→i64：编译期正则字面量 → 宿主 RegExp。*/
__attribute__((export_name("regex")))
int64_t qz_guest_regex(int32_t strId)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    size_t len = 0;
    const char *s = qz_str_by_id(strId, &len);
    if (!s) return 0;
    /* 无公开 RegExp 构造 API：走全局 RegExp（字面量 /re/ 由 QuickJS 侧解析字面量文本）*/
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue ctor = JS_GetPropertyStr(ctx, g, "RegExp");
    JSValue re = JS_EXCEPTION;
    if (JS_IsFunction(ctx, ctor)) {
        JSValue arg = JS_NewStringLen(ctx, s, len);
        re = JS_Call(ctx, ctor, g, 1, &arg);
        JS_FreeValue(ctx, arg);
    }
    JS_FreeValue(ctx, ctor); JS_FreeValue(ctx, g);
    int64_t r = qz_ret(ctx, re);
    JS_FreeValue(ctx, re);
    return r;
}

/* log(v)：调试输出到 stderr。*/
__attribute__((export_name("log")))
void qz_guest_log(int64_t v)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    JSValue s = qz_tojs(ctx, v);
    size_t len = 0;
    const char *p = JS_ToCStringLen(ctx, &len, s);
    if (p) { fwrite(p, 1, len, stderr); fputc('\n', stderr); JS_FreeCString(ctx, p); }
    JS_FreeValue(ctx, s);
}

/* is_symbol_host(v)→i32：宿主值是否 JS symbol。*/
__attribute__((export_name("is_symbol_host")))
int32_t qz_guest_is_symbol_host(int64_t a)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue v = qz_tojs(ctx, a);
    int32_t r = JS_IsSymbol(v) ? 1 : 0;
    JS_FreeValue(ctx, v);
    return r;
}

/* err_stack(e)→i64：Error 实例的 .stack 字符串（缺失即 undefined）。*/
__attribute__((export_name("err_stack")))
int64_t qz_guest_err_stack(int64_t v)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue e = qz_tojs(ctx, v);
    JSValue st = JS_GetPropertyStr(ctx, e, "stack");
    int64_t r = qz_ret(ctx, st);
    JS_FreeValue(ctx, e); JS_FreeValue(ctx, st);
    return r;
}

/* object_rest(src, nExcl, excl0, excl1, excl2)→i64：{...rest}——去掉已绑定键。*/
__attribute__((export_name("object_rest")))
int64_t qz_guest_object_rest(int64_t src, int32_t nExcl, int32_t e0, int32_t e1, int32_t e2)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue s = qz_tojs(ctx, src);
    JSValue out = JS_NewObject(ctx);
    int32_t excl[3] = { e0, e1, e2 };
    JSPropertyEnum *tab = NULL;
    uint32_t n = 0;
    if (JS_IsObject(s) &&
        JS_GetOwnPropertyNames(ctx, &tab, &n, s, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
        for (uint32_t i = 0; i < n; i++) {
            const char *k = JS_AtomToCString(ctx, tab[i].atom);
            int skip = 0;
            if (k) {
                for (int32_t e = 0; e < nExcl && e < 3; e++) {
                    size_t el = 0;
                    const char *es = qz_str_by_id(excl[e], &el);
                    if (es && el == strlen(k) && memcmp(es, k, el) == 0) { skip = 1; break; }
                }
                JS_FreeCString(ctx, k);
            }
            if (!skip) {
                JSValue v = JS_GetProperty(ctx, s, tab[i].atom);
                JS_SetProperty(ctx, out, tab[i].atom, v);
            }
            JS_FreeAtom(ctx, tab[i].atom);
        }
        js_free(ctx, tab);
    }
    int64_t r = qz_ret(ctx, out);
    JS_FreeValue(ctx, s); JS_FreeValue(ctx, out);
    return r;
}

/* prot_check(v, op)：写保护检查（freeze/seal 后写应失败）。
 * AOT 侧用它在写入点提前 trap；这里把不可写属性检出为异常。*/
__attribute__((export_name("prot_check")))
void qz_guest_prot_check(int64_t v, int32_t op)
{
    if (!g_current_rt) return;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return;
    /* 冻结对象不可扩展；seal/freeze 的差异（属性可写性）由 JS_SetProperty 自身拒绝，
     * 故此处以「不可扩展」作为写保护信号。op: 0=写属性 1=读（读不拦截）。*/
    JSValue o = qz_tojs(ctx, v);
    int sealed_ = JS_IsObject(o) ? !JS_IsExtensible(ctx, o) : 0;
    JS_FreeValue(ctx, o);
    if (sealed_ && op == 0) JS_ThrowTypeError(ctx, "cannot assign to non-extensible object");
}

/* obj_assign(id, dst, a0, a1, a2)：Object.assign(dst, ...srcs)（最多 3 源）。*/
__attribute__((export_name("obj_assign")))
int64_t qz_guest_obj_assign(int32_t id, int64_t dst, int64_t a0, int64_t a1, int64_t a2)
{
    (void)id;
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue d = qz_tojs(ctx, dst);
    int64_t srcs[3] = { a0, a1, a2 };
    JSValue undef = JS_UNDEFINED;
    for (int i = 0; i < 3; i++) {
        JSValue s = qz_tojs(ctx, srcs[i]);
        /* undefined/null 源按 JS 语义跳过 */
        if (!JS_IsUndefined(s) && !JS_IsNull(s) && JS_IsObject(s)) {
            JSPropertyEnum *tab = NULL;
            uint32_t n = 0;
            if (JS_GetOwnPropertyNames(ctx, &tab, &n, s, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
                for (uint32_t k = 0; k < n; k++) {
                    JSValue v = JS_GetProperty(ctx, s, tab[k].atom);
                    JS_SetProperty(ctx, d, tab[k].atom, v);
                    JS_FreeAtom(ctx, tab[k].atom);
                }
                js_free(ctx, tab);
            }
        }
        JS_FreeValue(ctx, s);
    }
    (void)undef;
    int64_t r = qz_ret(ctx, d);
    JS_FreeValue(ctx, d);
    return r;
}

/* tagged_strings(cookedId, rawId)→i64：用户标签模板 strings 对象（含 .raw）。*/
__attribute__((export_name("tagged_strings")))
int64_t qz_guest_tagged_strings(int64_t cooked, int64_t raw)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue c = qz_tojs(ctx, cooked), r0 = qz_tojs(ctx, raw);
    JSValue out = JS_NewArray(ctx);
    if (JS_IsArray(c)) {
        JSValue lv = JS_GetPropertyStr(ctx, c, "length");
        double f = 0; JS_ToFloat64(ctx, &f, lv);
        JS_FreeValue(ctx, lv);
        uint32_t n = (uint32_t)f;
        for (uint32_t i = 0; i < n; i++)
            JS_SetPropertyUint32(ctx, out, i, JS_GetPropertyUint32(ctx, c, i));
        /* strings.raw：不可枚举但可读，按 ECMA-262 定义 */
        JS_DefinePropertyValueStr(ctx, out, "raw", JS_DupValue(ctx, r0),
                                  JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    }
    int64_t r = qz_ret(ctx, out);
    JS_FreeValue(ctx, c); JS_FreeValue(ctx, r0); JS_FreeValue(ctx, out);
    return r;
}

/* bigint_lit(strId)→i64：BigInt 字面量（十进制串）→ 值。*/
__attribute__((export_name("bigint_lit")))
int64_t qz_guest_bigint_lit(int32_t strId)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    size_t len = 0;
    const char *s = qz_str_by_id(strId, &len);
    if (!s) return 0;
    JSValue b = JS_NewBigInt64(ctx, 0);
    /* 走字符串→BigInt 的通用路径，避免自行解析超 64 位 */
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, g, "BigInt");
    if (JS_IsFunction(ctx, fn)) {
        JSValue arg = JS_NewStringLen(ctx, s, len);
        JSValue r0 = JS_Call(ctx, fn, g, 1, &arg);
        JS_FreeValue(ctx, arg);
        if (!JS_IsException(r0)) { JS_FreeValue(ctx, b); b = r0; }
        else JS_FreeValue(ctx, r0);
    }
    JS_FreeValue(ctx, fn); JS_FreeValue(ctx, g);
    int64_t r = qz_ret(ctx, b);
    JS_FreeValue(ctx, b);
    return r;
}

/* str_method(recv, mid, a0, a1)→i64：字符串方法回退（按名调用）。*/
__attribute__((export_name("str_method")))
int64_t qz_guest_str_method(int64_t recv, int32_t mid, int64_t a0, int64_t a1)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    size_t nlen = 0;
    const char *name = qz_str_by_id(mid, &nlen);
    if (!name) return 0;
    char nm[64];
    if (nlen >= sizeof(nm)) return 0;
    memcpy(nm, name, nlen); nm[nlen] = '\0';
    JSValue r0 = qz_tojs(ctx, recv);
    JSValue fn = JS_GetPropertyStr(ctx, r0, nm);
    int64_t r = 0;
    if (JS_IsFunction(ctx, fn)) {
        JSValue argv[2];
        int argc = 0;
        JSValue p0 = qz_tojs(ctx, a0);
        if (!JS_IsUndefined(p0)) argv[argc++] = p0;
        else JS_FreeValue(ctx, p0);
        JSValue p1 = qz_tojs(ctx, a1);
        if (!JS_IsUndefined(p1)) argv[argc++] = p1;
        else JS_FreeValue(ctx, p1);
        JSValue res = JS_Call(ctx, fn, r0, argc, argv);
        for (int i = 0; i < argc; i++) JS_FreeValue(ctx, argv[i]);
        if (!JS_IsException(res)) { r = qz_ret(ctx, res); JS_FreeValue(ctx, res); }
        else JS_FreeValue(ctx, res);
    }
    JS_FreeValue(ctx, fn); JS_FreeValue(ctx, r0);
    return r;
}

/* ── M6b: method_call（recv, mid, a0..a3, ovf）→ i64 ───────────────
 * 纯宿主可达的部分：字符串 / 数组 / BigInt / 布尔 / 函数三件套 / POJO 与宿主对象
 * 方法（走 QuickJS 属性查找）。类实例方法需回调 wasm 导出，本层不处理（返回 undefined）。*/

/* 收集实参：a0..a3 中「已给」的槽 + ovf 数组（其 [0] 是实参 3，已含于 a3）。*/
static int qz_collect_args(JSContext *ctx, JSValue *out, int cap,
                           JSValue a0, JSValue a1, JSValue a2, JSValue a3, JSValue ovf)
{
    int n = 0;
    JSValue slots[4] = { a0, a1, a2, a3 };
    int given[4];
    for (int i = 0; i < 4; i++) given[i] = !JS_IsUndefined(slots[i]);
    for (int i = 0; i < 4 && n < cap; i++)
        if (given[i]) out[n++] = slots[i];
    if (!JS_IsUndefined(ovf) && JS_IsArray(ovf)) {
        JSValue lv = JS_GetPropertyStr(ctx, ovf, "length");
        double f = 0; JS_ToFloat64(ctx, &f, lv);
        JS_FreeValue(ctx, lv);
        uint32_t len = (uint32_t)f;
        /* ovf[0] 是实参 3：a3 已收则从 1 开始，否则从 0 开始（emitter 约定）*/
        for (uint32_t i = given[3] ? 1 : 0; i < len && n < cap; i++)
            out[n++] = JS_GetPropertyUint32(ctx, ovf, i);
    }
    return n;
}
/* 前向：类方法蹦床类型，定义于下方 closure 节。*/
typedef int64_t (*qz_cls_fn)(int64_t, int64_t, int64_t, int64_t, int64_t);

/* classMeta 表基址（宿主经 __set_clsmeta 注入）。表格式见 qz_clsmeta 注释。*/
static uint32_t g_clsmeta_base = 0;
/* classMeta 项格式（与 emitter 序列化对齐）：
 *   [clsId:i32][parent:i32(-1)][nameStrId:i32][ctorSlot:i32(-1)]
 *   [nMethods:i32][nStatics:i32][nAccessors:i32]
 *   methods  × nMethods  : [nameStrId:i32][slot:i32][n:i32][rest:i8][pad:3]
 *   statics  × nStatics  : [nameStrId:i32][slot:i32][n:i32]
 *   accessors× nAccessors: [nameStrId:i32][getSlot:i32][setSlot:i32]
 * 项按 clsId 顺序紧密排列；索引表 = [count:i32][clsId0_itemOff:i32]×count，随后是项数据。*/

/* __set_clsmeta(base:i32)：宿主注入 classMeta 表。*/
__attribute__((export_name("__set_clsmeta")))
void qz_guest_set_clsmeta(int32_t base)
{
    g_clsmeta_base = (uint32_t)base;
}

/* 按 clsId 取 classMeta 项偏移（字节）。无表或 clsId 越界 → 0。*/
/* 动态类（类表达式工厂：每次求值一个新类）的旁路项表。动态 clsId 从静态
 * count 起递增；项由本层 malloc 克隆，不动宿主注入的原表。*/
#define QZ_DYNCLS_CAP 64
static struct { int32_t clsId; uint32_t off; int32_t nbytes; } g_dyncls[QZ_DYNCLS_CAP];
static int32_t g_dyncls_n = 0;
static int32_t g_dyncls_next = -1;

static uint32_t qz_clsmeta_item_off(int32_t clsId)
{
    for (int32_t i = 0; i < g_dyncls_n; i++)
        if (g_dyncls[i].clsId == clsId) return g_dyncls[i].off;
    if (!g_clsmeta_base) return 0;
    const unsigned char *base = (const unsigned char *)(uintptr_t)g_clsmeta_base;
    int32_t count; memcpy(&count, base, 4);
    if (clsId < 0 || clsId >= count) return 0;
    uint32_t off;
    memcpy(&off, base + 4 + (uint32_t)clsId * 4, 4);
    return off;
}

/* 克隆一个类项为新动态类：新 clsId 的 parent 指向原类（语义 = 派生），返回新 clsId。
 * 方法/静态/访问器项按字节复制，故表槽（蹦床）共享——这正是工厂语义所需。*/
static int32_t qz_clsmeta_clone(int32_t srcClsId)
{
    uint32_t srcOff = qz_clsmeta_item_off(srcClsId);
    if (!srcOff) return -1;
    if (g_dyncls_n >= QZ_DYNCLS_CAP) return -1;
    const unsigned char *p = (const unsigned char *)(uintptr_t)srcOff;
    int32_t nMethods, nStatics, nAccessors;
    memcpy(&nMethods, p + 16, 4); memcpy(&nStatics, p + 20, 4); memcpy(&nAccessors, p + 24, 4);
    int32_t nbytes = 28 + nMethods * 16 + nStatics * 12 + nAccessors * 12;
    unsigned char *dst = (unsigned char *)malloc((size_t)nbytes);
    if (!dst) return -1;
    memcpy(dst, p, (size_t)nbytes);
    if (g_dyncls_next < 0) {
        int32_t count = 0;
        if (g_clsmeta_base) memcpy(&count, (const unsigned char *)(uintptr_t)g_clsmeta_base, 4);
        g_dyncls_next = count > 0 ? count : 0;
    }
    int32_t newId = g_dyncls_next++;
    memcpy(dst, &newId, 4);                    /* [0] = 新 clsId */
    memcpy(dst + 4, &srcClsId, 4);             /* parent = 原类 */
    g_dyncls[g_dyncls_n].clsId = newId;
    g_dyncls[g_dyncls_n].off = (uint32_t)(uintptr_t)dst;
    g_dyncls[g_dyncls_n].nbytes = nbytes;
    g_dyncls_n++;
    return newId;
}

/* 在 classMeta 项里按方法名找表槽。返回 0=未找到，>0=表槽。*/
static int32_t qz_clsmeta_method_slot(int32_t clsId, int32_t nameStrId, int32_t *n_out)
{
    uint32_t off = qz_clsmeta_item_off(clsId);
    if (!off) return 0;
    const unsigned char *p = (const unsigned char *)(uintptr_t)off;
    int32_t cid, parent, nameId, ctorSlot, nMethods, nStatics, nAccessors;
    memcpy(&cid, p, 4); memcpy(&parent, p+4, 4); memcpy(&nameId, p+8, 4);
    memcpy(&ctorSlot, p+12, 4); memcpy(&nMethods, p+16, 4);
    memcpy(&nStatics, p+20, 4); memcpy(&nAccessors, p+24, 4);
    const unsigned char *q = p + 28;
    for (int32_t i = 0; i < nMethods; i++) {
        int32_t nid, slot, n; int8_t rest;
        memcpy(&nid, q, 4); memcpy(&slot, q+4, 4); memcpy(&n, q+8, 4); memcpy(&rest, q+12, 1);
        if (nid == nameStrId) { if (n_out) *n_out = n; return slot; }
        q += 16;
    }
    return 0;
}

/* 在 classMeta 项里按名字找 getter 槽（getSlot 在 accessors 段）。*/
static int32_t qz_clsmeta_accessor_slot(int32_t clsId, int32_t nameStrId, int wantSet)
{
    uint32_t off = qz_clsmeta_item_off(clsId);
    if (!off) return 0;
    const unsigned char *p = (const unsigned char *)(uintptr_t)off;
    int32_t nMethods, nStatics, nAccessors;
    memcpy(&nMethods, p + 16, 4); memcpy(&nStatics, p + 20, 4); memcpy(&nAccessors, p + 24, 4);
    const unsigned char *q = p + 28 + nMethods * 16 + nStatics * 12;
    for (int32_t i = 0; i < nAccessors; i++) {
        int32_t nid, g, st;
        memcpy(&nid, q, 4); memcpy(&g, q+4, 4); memcpy(&st, q+8, 4);
        if (nid == nameStrId) return wantSet ? st : g;
        q += 12;
    }
    return 0;
}

/* 沿继承链找 getter/setter 槽（-1 表示缺该方向）。found=0 表示整条链都没有。*/
static int32_t qz_clsmeta_accessor_chain(int32_t clsId, int32_t nameStrId, int wantSet, int32_t *found)
{
    int32_t cur = clsId, guard = 0;
    if (found) *found = 0;
    while (cur >= 0 && guard++ < 64) {
        int32_t slot = qz_clsmeta_accessor_slot(cur, nameStrId, wantSet);
        uint32_t off = qz_clsmeta_item_off(cur);
        if (!off) break;
        /* 命中的方向也可能是 -1（只有 getter 无 setter）→ 需区分「有项无槽」与「无项」 */
        const unsigned char *p = (const unsigned char *)(uintptr_t)off;
        int32_t nMethods, nStatics, nAccessors;
        memcpy(&nMethods, p + 16, 4); memcpy(&nStatics, p + 20, 4); memcpy(&nAccessors, p + 24, 4);
        const unsigned char *q = p + 28 + nMethods * 16 + nStatics * 12;
        for (int32_t i = 0; i < nAccessors; i++) {
            int32_t nid; memcpy(&nid, q, 4);
            if (nid == nameStrId) { if (found) *found = 1; return slot; }
            q += 12;
        }
        int32_t parent; memcpy(&parent, p + 4, 4);
        cur = parent;
    }
    return -1;
}

/* 沿继承链找方法槽（含父类）。*/
static int32_t qz_clsmeta_method_chain(int32_t clsId, int32_t nameStrId, int32_t *n_out, int32_t *foundCls)
{
    int32_t cur = clsId, guard = 0;
    while (cur >= 0 && guard++ < 64) {
        int32_t slot = qz_clsmeta_method_slot(cur, nameStrId, n_out);
        if (slot) { if (foundCls) *foundCls = cur; return slot; }
        uint32_t off = qz_clsmeta_item_off(cur);
        if (!off) break;
        int32_t parent; memcpy(&parent, (const unsigned char *)(uintptr_t)off + 4, 4);
        cur = parent;
    }
    return 0;
}
__attribute__((export_name("method_call")))
int64_t qz_guest_method_call(int64_t recv, int32_t mid, int64_t a0, int64_t a1,
                             int64_t a2, int64_t a3, int64_t ovf)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    size_t nlen = 0;
    const char *mname = qz_str_by_id(mid, &nlen);
    if (!mname) return 0;
    char nm[64];
    if (nlen >= sizeof(nm)) return 0;
    memcpy(nm, mname, nlen); nm[nlen] = '\0';
    /* 用户类实例（0x7FFE|off）：recv 内存 [off]=clsId → 沿 classMeta 继承链查
     * 方法槽，调蹦床。emitter 静态分派的类方法已蹦床化进共享表。 */
    uint64_t ru = (uint64_t)recv;
    if ((uint16_t)(ru >> 48) == 0x7FFE) {
        uint32_t ioff = (uint32_t)(ru & 0xFFFFFFFFu);
        int32_t clsId; memcpy(&clsId, (const unsigned char *)(uintptr_t)ioff, 4);
        /* mid 是 strId，classMeta 里 nameStrId 也是 strId（同表）→ 直接比对 */
        int32_t n; int32_t slot = qz_clsmeta_method_chain(clsId, mid, &n, NULL);
        if (slot) {
            qz_cls_fn f = (qz_cls_fn)(uintptr_t)(uint32_t)slot;
            return f(recv, a0, a1, a2, a3);
        }
    }
    JSValue r = qz_tojs(ctx, recv);
    JSValue fn = JS_GetPropertyStr(ctx, r, nm);
    int64_t out = 0;
    if (JS_IsFunction(ctx, fn)) {
        JSValue argv[16];
        int argc = qz_collect_args(ctx, argv, 16,
                                   qz_tojs(ctx, a0), qz_tojs(ctx, a1),
                                   qz_tojs(ctx, a2), qz_tojs(ctx, a3),
                                   qz_tojs(ctx, ovf));
        JSValue res = JS_Call(ctx, fn, r, argc, argv);
        for (int i = 0; i < argc; i++) JS_FreeValue(ctx, argv[i]);
        if (!JS_IsException(res)) { out = qz_ret(ctx, res); JS_FreeValue(ctx, res); }
        else JS_FreeValue(ctx, res);
    }
    JS_FreeValue(ctx, fn); JS_FreeValue(ctx, r);
    return out;
}

/* 撑大 funcref 表：wasm-ld 按「被取地址的函数数 + 1」定表大小，无法直接指定
 * 容量。产物要把自己的蹦床装进同一张表的 [QZ_TABLE_CAP, +N) 槽，故此处保留
 * 一段函数指针占位数组，让表至少覆盖 QZ_TABLE_CAP + QZ_TABLE_RESERVE 项。
 * 占位项从不被调用（全 NULL），仅用于定表尺寸。*/
#define QZ_TABLE_CAP     514
#define QZ_TABLE_RESERVE 4096
__attribute__((used)) static void *qz_table_pad[QZ_TABLE_CAP + QZ_TABLE_RESERVE];

/* 闭包调用：闭包值 [off]=蹦床表槽 [off+4]=envIdx [off+8]=arity [off+12]=nameStrId。
 *
 * 分派的是一张**共享 funcref 表**（产物 import qz.__indirect_function_table，
 * 由本模块 --export-table --growable-table 导出）。表项是产物里的蹦床，签名固定
 * (i32 env, i64 a0..a3) → i64，故这里只需一种函数指针类型。
 * 蹦床内部按自己的形参个数精确转发，并自行处理 synthThis/rest 的槽位重排——
 * 这些语义在 emit 期就已确定，C 侧不需要知道。*/
/* 闭包蹦床：(i32 env, i64 a0..a3) — emitter 统一 5 参；env 是 i32。 */
typedef int64_t (*qz_lam_fn)(int32_t, int64_t, int64_t, int64_t, int64_t);
/* 类方法蹦床：(i64 self, i64 a0..a3) — self 是 tagged 实例句柄。 */
typedef int64_t (*qz_cls_fn)(int64_t, int64_t, int64_t, int64_t, int64_t);

/* 表槽号 → 函数指针：clang 把它编成 call_indirect。槽号来自产物蹦床分配
 * （emitter: INMOD_TABLE_CAP + i），与本模块导出的同一张 funcref 表对齐。*/
static int64_t qz_lam_dispatch(int32_t slot, int32_t env, int64_t a0, int64_t a1,
                               int64_t a2, int64_t a3)
{
    qz_lam_fn f = (qz_lam_fn)(uintptr_t)(uint32_t)slot;
    return f(env, a0, a1, a2, a3);
}

/* closure_call(handle, a0..a3, recv) → i64
 * handle 是闭包值句柄（0x7FFF|off）；宿主函数句柄（0x7FF9|idx）走 JS 调用。*/
__attribute__((export_name("closure_call")))
int64_t qz_guest_closure_call(int64_t handle, int64_t a0, int64_t a1, int64_t a2,
                              int64_t a3, int64_t recv)
{
    if (!g_current_rt) return 0;
    uint64_t u = (uint64_t)handle;
    uint16_t tag = (uint16_t)(u >> 48);

    if (tag == 0x7FF9) {          /* 宿主函数句柄 → 取 JS 函数直接调 */
        JSContext *ctx = qz_get_active_jsctx(g_current_rt);
        if (!ctx) return 0;
        JSValue fn = qz_tojs(ctx, handle);
        if (!JS_IsFunction(ctx, fn)) { JS_FreeValue(ctx, fn); return 0; }
        JSValue argv[4];
        int argc = qz_collect_args(ctx, argv, 4, qz_tojs(ctx, a0), qz_tojs(ctx, a1),
                                   qz_tojs(ctx, a2), qz_tojs(ctx, a3), JS_UNDEFINED);
        JSValue self = qz_tojs(ctx, recv);
        int64_t out = 0;
        JSValue res = JS_Call(ctx, fn, self, argc, argv);
        for (int i = 0; i < argc; i++) JS_FreeValue(ctx, argv[i]);
        if (!JS_IsException(res)) { out = qz_ret(ctx, res); JS_FreeValue(ctx, res); }
        else JS_FreeValue(ctx, res);
        JS_FreeValue(ctx, self); JS_FreeValue(ctx, fn);
        return out;
    }
    if (tag != 0x7FFF && tag != 0x7FFB) return 0;   /* 非闭包值 */

    uint32_t off = (uint32_t)(u & 0xFFFFFFFFu);
    extern uint32_t qz_bump_base_addr(void);
    /* 闭包值可能与切换前 arena 布局一致；直接读当前线性内存。*/
    const unsigned char *p = (const unsigned char *)(uintptr_t)0;
    (void)p;
    int32_t slot, env;
    memcpy(&slot, (const void *)(uintptr_t)off, 4);
    memcpy(&env, (const void *)(uintptr_t)(off + 4), 4);
    return qz_lam_dispatch(slot, env, a0, a1, a2, a3);
}

/* closure_call_spread(handle, arr) → i64：实参数组摊平后调用（≤4 参）。*/
__attribute__((export_name("closure_call_spread")))
int64_t qz_guest_closure_call_spread(int64_t handle, int64_t arr)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    JSValue a = qz_tojs(ctx, arr);
    if (!JS_IsArray(a)) { JS_FreeValue(ctx, a); return 0; }
    JSValue v0 = JS_GetPropertyUint32(ctx, a, 0);
    JSValue v1 = JS_GetPropertyUint32(ctx, a, 1);
    JSValue v2 = JS_GetPropertyUint32(ctx, a, 2);
    JSValue v3 = JS_GetPropertyUint32(ctx, a, 3);
    int64_t r = qz_guest_closure_call(handle, qz_ret(ctx, v0), qz_ret(ctx, v1),
                                      qz_ret(ctx, v2), qz_ret(ctx, v3), 0);
    JS_FreeValue(ctx, v0); JS_FreeValue(ctx, v1);
    JS_FreeValue(ctx, v2); JS_FreeValue(ctx, v3);
    JS_FreeValue(ctx, a);
    return r;
}

/* ── M6b: 通用调用族（call_value / call_named / fn_value / *_spread / arr_apply） ───
 * 闭包分支复用 closure_call 的表分派；宿主函数分支走 JS_Call。call_named
 * 按 nameStrId 在 globalThis 查找（宿主侧命名函数/类静态方法/内建）。
 *
 * 前向声明：qz_global_path / qz_builtin_lookup 定义于下方内建分派节。*/
static JSValue qz_global_path(JSContext *ctx, const char *name);
static JSValue qz_builtin_lookup(JSContext *ctx, const char *name);

/* call_value(v, a0..a3, ovf, recv) → i64：被调值是闭包(0x7FFF) 或宿主函数(0x7FF9)。*/
__attribute__((export_name("call_value")))
int64_t qz_guest_call_value(int64_t v, int64_t a0, int64_t a1, int64_t a2,
                            int64_t a3, int64_t ovf, int64_t recv)
{
    uint64_t u = (uint64_t)v;
    uint16_t h = (uint16_t)(u >> 48);
    if (h == 0x7FFF || h == 0x7FFB) return qz_guest_closure_call(v, a0, a1, a2, a3, recv);
    if (h == 0x7FF9) {
        if (!g_current_rt) return 0;
        JSContext *ctx = qz_get_active_jsctx(g_current_rt);
        if (!ctx) return 0;
        JSValue fn = qz_tojs(ctx, v);
        if (!JS_IsFunction(ctx, fn)) { JS_FreeValue(ctx, fn); return 0; }
        JSValue argv[16];
        int argc = qz_collect_args(ctx, argv, 16, qz_tojs(ctx, a0), qz_tojs(ctx, a1),
                                   qz_tojs(ctx, a2), qz_tojs(ctx, a3), qz_tojs(ctx, ovf));
        JSValue self = qz_tojs(ctx, recv);
        int64_t out = 0;
        JSValue res = JS_Call(ctx, fn, self, argc, argv);
        for (int i = 0; i < argc; i++) JS_FreeValue(ctx, argv[i]);
        if (!JS_IsException(res)) { out = qz_ret(ctx, res); JS_FreeValue(ctx, res); }
        else JS_FreeValue(ctx, res);
        JS_FreeValue(ctx, self); JS_FreeValue(ctx, fn);
        return out;
    }
    return 0;
}

/* call_named(nameId, argsArr, isNum) → i64：调 globalThis 上的命名函数。
 * argsArr 是实参数组句柄；isNum 非 0 表示目标 f64 ABI（结果按 f64 装 box）。*/
__attribute__((export_name("call_named")))
int64_t qz_guest_call_named(int32_t id, int64_t arr, int32_t isNum)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    size_t nlen = 0;
    const char *nm = qz_str_by_id(id, &nlen);
    if (!nm || nlen >= 128) return 0;
    char name[128];
    memcpy(name, nm, nlen); name[nlen] = '\0';
    JSValue fn = qz_global_path(ctx, name);
    if (!JS_IsFunction(ctx, fn)) { JS_FreeValue(ctx, fn); return 0; }
    JSValue a = qz_tojs(ctx, arr);
    JSValue argv[16]; int argc = 0;
    if (JS_IsArray(a)) {
        JSValue lv = JS_GetPropertyStr(ctx, a, "length");
        double f = 0; JS_ToFloat64(ctx, &f, lv); JS_FreeValue(ctx, lv);
        uint32_t len = (uint32_t)f;
        for (uint32_t i = 0; i < len && argc < 16; i++) argv[argc++] = JS_GetPropertyUint32(ctx, a, i);
    }
    int64_t out = 0;
    JSValue res = JS_Call(ctx, fn, JS_UNDEFINED, argc, argv);
    for (int i = 0; i < argc; i++) JS_FreeValue(ctx, argv[i]);
    JS_FreeValue(ctx, a); JS_FreeValue(ctx, fn);
    if (!JS_IsException(res)) {
        if (isNum) {           /* f64 ABI → box */
            double d = 0; JS_ToFloat64(ctx, &d, res);
            uint64_t bits; memcpy(&bits, &d, 8);
            out = (int64_t)bits;
        } else out = qz_ret(ctx, res);
        JS_FreeValue(ctx, res);
    } else JS_FreeValue(ctx, res);
    return out;
}

/* call_named_rest(nameId, a0..a3, ovf) → i64：命名函数 + 前缀 + 溢出实参。*/
__attribute__((export_name("call_named_rest")))
int64_t qz_guest_call_named_rest(int32_t id, int64_t restArr, int32_t n)
{
    /* 展开实参 + rest 收尾：实参已由 emitter 收进数组 → 走 call_named 的数组摊平路径。*/
    (void)n;
    return qz_guest_call_named(id, restArr, 0);
}

/* fn_value(nameId) → i64：取命名函数作为值（用于赋值/作实参）。*/
__attribute__((export_name("fn_value")))
int64_t qz_guest_fn_value(int32_t id, int32_t arity, int32_t pad)
{
    (void)arity; (void)pad;   /* 契约保留位：arity 供宿主包装时定形参数 */
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    size_t nlen = 0;
    const char *nm = qz_str_by_id(id, &nlen);
    if (!nm || nlen >= 128) return 0;
    char name[128];
    memcpy(name, nm, nlen); name[nlen] = '\0';
    JSValue fn = qz_global_path(ctx, name);
    if (!JS_IsFunction(ctx, fn)) { JS_FreeValue(ctx, fn); return 0; }
    int64_t out = qz_ret(ctx, fn);
    JS_FreeValue(ctx, fn);
    return out;
}

/* method_spread(recv, nameId, argsArr) → i64：方法调用 + 实参数组摊平。*/
__attribute__((export_name("method_spread")))
int64_t qz_guest_method_spread(int64_t recv, int32_t mid, int64_t arr)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    size_t nlen = 0;
    const char *mname = qz_str_by_id(mid, &nlen);
    if (!mname || nlen >= 64) return 0;
    char nm[64];
    memcpy(nm, mname, nlen); nm[nlen] = '\0';
    JSValue r = qz_tojs(ctx, recv);
    JSValue fn = JS_GetPropertyStr(ctx, r, nm);
    int64_t out = 0;
    if (JS_IsFunction(ctx, fn)) {
        JSValue a = qz_tojs(ctx, arr);
        JSValue argv[16]; int argc = 0;
        if (JS_IsArray(a)) {
            JSValue lv = JS_GetPropertyStr(ctx, a, "length");
            double f = 0; JS_ToFloat64(ctx, &f, lv); JS_FreeValue(ctx, lv);
            uint32_t len = (uint32_t)f;
            for (uint32_t i = 0; i < len && argc < 16; i++) argv[argc++] = JS_GetPropertyUint32(ctx, a, i);
        }
        JSValue res = JS_Call(ctx, fn, r, argc, argv);
        for (int i = 0; i < argc; i++) JS_FreeValue(ctx, argv[i]);
        JS_FreeValue(ctx, a);
        if (!JS_IsException(res)) { out = qz_ret(ctx, res); JS_FreeValue(ctx, res); }
        else JS_FreeValue(ctx, res);
    }
    JS_FreeValue(ctx, fn); JS_FreeValue(ctx, r);
    return out;
}

/* builtin_spread(nameId, argsArr) → i64：内建函数 + 实参数组摊平。*/
__attribute__((export_name("builtin_spread")))
int64_t qz_guest_builtin_spread(int32_t id, int64_t arr)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    size_t nlen = 0;
    const char *nm = qz_str_by_id(id, &nlen);
    if (!nm || nlen >= 128) return 0;
    char name[128];
    memcpy(name, nm, nlen); name[nlen] = '\0';
    JSValue fn = qz_builtin_lookup(ctx, name);
    if (!JS_IsFunction(ctx, fn)) { JS_FreeValue(ctx, fn); return 0; }
    JSValue a = qz_tojs(ctx, arr);
    JSValue argv[16]; int argc = 0;
    if (JS_IsArray(a)) {
        JSValue lv = JS_GetPropertyStr(ctx, a, "length");
        double f = 0; JS_ToFloat64(ctx, &f, lv); JS_FreeValue(ctx, lv);
        uint32_t len = (uint32_t)f;
        for (uint32_t i = 0; i < len && argc < 16; i++) argv[argc++] = JS_GetPropertyUint32(ctx, a, i);
    }
    int64_t out = 0;
    JSValue res = JS_Call(ctx, fn, JS_UNDEFINED, argc, argv);
    for (int i = 0; i < argc; i++) JS_FreeValue(ctx, argv[i]);
    JS_FreeValue(ctx, a); JS_FreeValue(ctx, fn);
    if (!JS_IsException(res)) { out = qz_ret(ctx, res); JS_FreeValue(ctx, res); }
    else JS_FreeValue(ctx, res);
    return out;
}

/* arr_apply(nameId, arr) → i64：以数组实参调命名函数。*/
__attribute__((export_name("arr_apply")))
int64_t qz_guest_arr_apply(int32_t id, int64_t arr, int64_t ovf)
{
    (void)ovf;   /* 契约保留位 */
    return qz_guest_call_named(id, arr, 0);
}

/* ── M6b: 类元数据族（class_value / new_dynamic / super_method / super_ctor /
 *   instanceof_dyn / brand_check / static_get / static_get_dyn / static_set /
 *   statics_ready / statics_has / statics_mark / obj_accessor /
 *   object_set_method / object_set_method_key） ───────────────────────────
 * 共同前置：emitter 把 classMeta 序列化进共享内存 + 宿主经 __set_clsmeta 注入；
 * 类方法（含 ctor/static/getter/setter）已蹦床化进同一张 funcref 表。*/

/* class_value(clsId) → i64：返回类值（句柄 0x7FFE|clsId）。供 instanceof_dyn 等。*/
__attribute__((export_name("class_value")))
int64_t qz_guest_class_value(int32_t clsId)
{
    if (clsId < 0) return 0;
    /* 类值本身不需要在内存里建对象，只在句柄高位编码 clsId；C 侧按此回查 classMeta。*/
    return (int64_t)((uint64_t)0x7FFE << 48 | (uint32_t)clsId);
}

/* class_value_dyn(clsId, baseObj) → i64：动态父类（extends 一个运行时值）。
 * baseObj 是类值句柄(0x7FFE|baseClsId) → 记录运行时父链到 classMeta 的 parent 槽，
 * 让 method_call/super_method 的继承链查找能覆盖动态父类。*/
__attribute__((export_name("class_value_dyn")))
int64_t qz_guest_class_value_dyn(int32_t clsId, int64_t baseObj)
{
    uint64_t bu = (uint64_t)baseObj;
    if ((uint16_t)(bu >> 48) != 0x7FFE) return 0;   /* 父类值不是类对象 */
    int32_t baseClsId = (int32_t)(bu & 0xFFFFFFFFu);
    /* 把 classMeta 项 clsId 的 parent 字段改写为 baseClsId（parent 在 off+4）。*/
    uint32_t off = qz_clsmeta_item_off(clsId);
    if (off) memcpy((void *)(uintptr_t)(off + 4), &baseClsId, 4);
    return qz_guest_class_value(clsId);
}

/* new_dynamic(clsId, a0..a3, ovf) → i64：实例化用户类。*/
__attribute__((export_name("new_dynamic")))
int64_t qz_guest_new_dynamic(int64_t clsVal, int64_t a0, int64_t a1, int64_t a2,
                             int64_t a3)
{
    /* 类值是句柄 0x7FFE|clsId（class_value/class_expr_value 的产物）。*/
    uint64_t cu = (uint64_t)clsVal;
    if ((uint16_t)(cu >> 48) != 0x7FFE) return 0;
    int32_t clsId = (int32_t)(cu & 0xFFFFFFFFu);
    uint32_t off = qz_clsmeta_item_off(clsId);
    if (!off) return 0;
    const unsigned char *p = (const unsigned char *)(uintptr_t)off;
    int32_t instSize, ctorSlot;
    memcpy(&instSize, p + 8, 4);
    memcpy(&ctorSlot, p + 12, 4);
    if (instSize < 16) instSize = 16;

    /* 实例内存布局必须与 emitter 内联分配**逐字节一致**，否则字段读
     * （内联 i64Load(off+foff)）取到错位数据：
     *   [0]=clsId(i32)  [4]=size(i32)  [8, size) 槽全写 undefined 句柄
     *   句柄 = 0x7FFE | offset（专用 tag，与 POJO 0x7FF9 区分）。
     * bump arena 是产物模块的 global，C 侧不可达 → 用本模块堆；实例不回收
     * （与 bump 语义一致）。*/
    unsigned char *inst = (unsigned char *)calloc(1, (size_t)instSize);
    if (!inst) return 0;
    memcpy(inst, &clsId, 4);
    memcpy(inst + 4, &instSize, 4);
    for (int32_t k = 8; k + 8 <= instSize; k += 8) {
        int64_t undef = (int64_t)((uint64_t)0x7FF9 << 48);   /* undefined 句柄 */
        memcpy(inst + k, &undef, 8);
    }
    int64_t selfH = (int64_t)(((uint64_t)0x7FFE << 48) | (uint32_t)(uintptr_t)inst);
    if (ctorSlot >= 0) {
        qz_cls_fn f = (qz_cls_fn)(uintptr_t)(uint32_t)ctorSlot;
        f(selfH, a0, a1, a2, a3);      /* 返回值即 self（构造器语义） */
    }
    return selfH;
}

/* super_method(recv, mid, a0..a3, ovf) → i64：调父类方法。*/
__attribute__((export_name("super_method")))
int64_t qz_guest_super_method(int64_t recv, int32_t mid, int64_t a0, int64_t a1,
                              int64_t a2, int64_t a3, int64_t ovf)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    /* recv 是实例句柄 0x7FFE|off；off 处 [0]=clsId。父类 clsId 从 classMeta 取。*/
    uint64_t u = (uint64_t)recv;
    if ((uint16_t)(u >> 48) != 0x7FFE) {
        /* 宿主对象：super 走 JS 原型链 */
        JSValue r = qz_tojs(ctx, recv);
        size_t nlen = 0; const char *mn = qz_str_by_id(mid, &nlen);
        if (!mn) return 0;
        char nm[64]; if (nlen >= 64) return 0; memcpy(nm, mn, nlen); nm[nlen] = '\0';
        JSValue proto = JS_GetPrototype(ctx, r);
        JSValue fn = JS_GetPropertyStr(ctx, proto, nm);
        JS_FreeValue(ctx, proto);
        int64_t out = 0;
        if (JS_IsFunction(ctx, fn)) {
            JSValue argv[16];
            int argc = qz_collect_args(ctx, argv, 16, qz_tojs(ctx, a0), qz_tojs(ctx, a1),
                                       qz_tojs(ctx, a2), qz_tojs(ctx, a3), qz_tojs(ctx, ovf));
            JSValue res = JS_Call(ctx, fn, r, argc, argv);
            for (int i = 0; i < argc; i++) JS_FreeValue(ctx, argv[i]);
            if (!JS_IsException(res)) { out = qz_ret(ctx, res); JS_FreeValue(ctx, res); }
            else JS_FreeValue(ctx, res);
        }
        JS_FreeValue(ctx, fn); JS_FreeValue(ctx, r);
        return out;
    }
    /* 用户类实例：从对象内存读 clsId，跳到父类的 method 槽 */
    uint32_t off = (uint32_t)(u & 0xFFFFFFFFu);
    int32_t selfCls; memcpy(&selfCls, (const unsigned char *)(uintptr_t)off, 4);
    uint32_t metaOff = qz_clsmeta_item_off(selfCls);
    if (!metaOff) return 0;
    int32_t parent; memcpy(&parent, (const unsigned char *)(uintptr_t)metaOff + 4, 4);
    if (parent < 0) return 0;
    int32_t n; int32_t slot = qz_clsmeta_method_chain(parent, mid, &n, NULL);
    if (!slot) return 0;
    qz_cls_fn f = (qz_cls_fn)(uintptr_t)(uint32_t)slot;
    return f(recv, a0, a1, a2, a3);
}

/* super_ctor(clsId, a0..a3, ovf) → i64：子类 ctor 调父类 ctor。*/
__attribute__((export_name("super_ctor")))
int64_t qz_guest_super_ctor(int32_t clsId, int64_t self, int64_t a0, int64_t a1,
                            int64_t a2, int64_t a3)
{
    uint32_t off = qz_clsmeta_item_off(clsId);
    if (!off) return 0;
    int32_t parent; memcpy(&parent, (const unsigned char *)(uintptr_t)off + 4, 4);
    if (parent < 0) return 0;
    uint32_t poff = qz_clsmeta_item_off(parent);
    if (!poff) return 0;
    int32_t ctorSlot; memcpy(&ctorSlot, (const unsigned char *)(uintptr_t)poff + 12, 4);
    if (ctorSlot < 0) return 0;
    qz_cls_fn f = (qz_cls_fn)(uintptr_t)(uint32_t)ctorSlot;
    return f(self, a0, a1, a2, a3);
}

/* class_expr_value(clsId) → i64：类表达式作值求值（每次调用一个新类）。
 * JS 语义：`const C = class {...}` 每次求值产生独立类对象——clsId 必须唯一，
 * 否则 `new A() instanceof B` 会误判 true。故克隆原项为新动态类（parent=原类，
 * 方法槽共享），返回新 clsId 的类值句柄。*/
__attribute__((export_name("class_expr_value")))
int64_t qz_guest_class_expr_value(int32_t clsId)
{
    int32_t nid = qz_clsmeta_clone(clsId);
    return qz_guest_class_value(nid >= 0 ? nid : clsId);
}

/* instanceof_dyn(x, rhs) → i64：动态右值 instanceof。rhs 是类值(0x7FFE|clsId)。*/
__attribute__((export_name("instanceof_dyn")))
int64_t qz_guest_instanceof_dyn(int64_t x, int64_t rhs)
{
    uint64_t r = (uint64_t)rhs;
    if ((uint16_t)(r >> 48) != 0x7FFE) return (int64_t)((uint64_t)0x7FFC << 48);  /* 不是类值 → false */
    int32_t targetCls = (int32_t)(r & 0xFFFFFFFFu);
    uint64_t xu = (uint64_t)x;
    if ((uint16_t)(xu >> 48) != 0x7FFE) return (int64_t)((uint64_t)0x7FFC << 48);
    uint32_t off = (uint32_t)(xu & 0xFFFFFFFFu);
    int32_t selfCls; memcpy(&selfCls, (const unsigned char *)(uintptr_t)off, 4);
    /* 沿父链比对 */
    int32_t cur = selfCls, guard = 0;
    while (cur >= 0 && guard++ < 64) {
        if (cur == targetCls) return (int64_t)((uint64_t)0x7FFC << 48 | 1);
        uint32_t moff = qz_clsmeta_item_off(cur);
        if (!moff) break;
        int32_t p; memcpy(&p, (const unsigned char *)(uintptr_t)moff + 4, 4);
        cur = p;
    }
    return (int64_t)((uint64_t)0x7FFC << 48);
}

/* brand_check(x, clsId) → i64：实例 brand 校验（x 是 clsId 或其后代实例）。*/
__attribute__((export_name("brand_check")))
int64_t qz_guest_brand_check(int64_t x, int32_t clsId)
{
    int64_t r = qz_guest_instanceof_dyn(x, (int64_t)((uint64_t)0x7FFE << 48 | (uint32_t)clsId));
    return r;
}

/* ── 静态字段存储：(clsId, nameStrId) → tagged 值 ────────────────────────
 * classMeta 只描述方法表；静态**字段**的值是运行期状态，存这里。开放寻址，
 * 键空间小（每个类的静态字段数 × 类数），容量 256 够用；满则静默丢弃（不崩）。*/
#define QZ_STATIC_CAP 256
static uint8_t g_static_ready[QZ_STATIC_CAP];
static struct { int32_t clsId, nameId; int64_t val; } g_statics[QZ_STATIC_CAP];
static int32_t g_static_n = 0;

static int32_t qz_static_find(int32_t clsId, int32_t nameStrId)
{
    for (int32_t i = 0; i < g_static_n; i++)
        if (g_statics[i].clsId == clsId && g_statics[i].nameId == nameStrId) return i;
    return -1;
}

/* static_get(clsId, nameStrId) → i64：读静态字段值；未命中则调静态方法蹦床。*/
__attribute__((export_name("static_get")))
int64_t qz_guest_static_get(int32_t clsId, int32_t nameStrId)
{
    /* 先查静态字段值表（已赋值的字段优先于方法） */
    { int32_t k = qz_static_find(clsId, nameStrId); if (k >= 0) return g_statics[k].val; }
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    uint32_t off = qz_clsmeta_item_off(clsId);
    if (!off) return 0;
    int32_t nStatics; memcpy(&nStatics, (const unsigned char *)(uintptr_t)off + 20, 4);
    const unsigned char *q = (const unsigned char *)(uintptr_t)off + 28;
    /* 跳过 methods */
    int32_t nMethods; memcpy(&nMethods, (const unsigned char *)(uintptr_t)off + 16, 4);
    q += nMethods * 16;
    for (int32_t i = 0; i < nStatics; i++) {
        int32_t nid, slot, n;
        memcpy(&nid, q, 4); memcpy(&slot, q+4, 4); memcpy(&n, q+8, 4);
        if (nid == nameStrId) {
            qz_cls_fn f = (qz_cls_fn)(uintptr_t)(uint32_t)slot;
            return f(0, 0, 0, 0, 0);   /* 静态方法无 self */
        }
        q += 12;
    }
    return 0;
}

__attribute__((export_name("static_get_dyn")))
int64_t qz_guest_static_get_dyn(int64_t clsVal, int32_t nameStrId)
{
    uint64_t u = (uint64_t)clsVal;
    if ((uint16_t)(u >> 48) != 0x7FFE) return 0;
    return qz_guest_static_get((int32_t)(u & 0xFFFFFFFFu), nameStrId);
}

__attribute__((export_name("static_set")))
void qz_guest_static_set(int32_t clsId, int32_t nameStrId, int64_t val)
{
    int32_t k = qz_static_find(clsId, nameStrId);
    if (k < 0) {
        if (g_static_n >= QZ_STATIC_CAP) return;   /* 满：静默丢弃，不崩 */
        k = g_static_n++;
        g_statics[k].clsId = clsId;
        g_statics[k].nameId = nameStrId;
    }
    g_statics[k].val = val;
}

__attribute__((export_name("statics_ready")))
int32_t qz_guest_statics_ready(int32_t clsId)
{
    if (clsId >= 0 && clsId < QZ_STATIC_CAP && g_static_ready[clsId]) return 1;
    return 0;
}

__attribute__((export_name("statics_has")))
int32_t qz_guest_statics_has(int32_t clsId, int32_t nameStrId)
{
    if (qz_static_find(clsId, nameStrId) >= 0) return 1;
    uint32_t off = qz_clsmeta_item_off(clsId);
    if (!off) return 0;
    int32_t nStatics; memcpy(&nStatics, (const unsigned char *)(uintptr_t)off + 20, 4);
    const unsigned char *q = (const unsigned char *)(uintptr_t)off + 28;
    int32_t nMethods; memcpy(&nMethods, (const unsigned char *)(uintptr_t)off + 16, 4);
    q += nMethods * 16;
    for (int32_t i = 0; i < nStatics; i++) {
        int32_t nid; memcpy(&nid, q, 4);
        if (nid == nameStrId) return 1;
        q += 12;
    }
    return 0;
}

/* statics_mark(clsId)：标记该类静态已初始化。emitter 的 lazy 初始化序列是
 * 「statics_ready → 内联初始值 → static_set → statics_mark」，故本函数只需记
 * 已初始化位，供 statics_ready 回报。 */
__attribute__((export_name("statics_mark")))
void qz_guest_statics_mark(int32_t clsId)
{
    if (clsId >= 0 && clsId < QZ_STATIC_CAP) g_static_ready[clsId] = 1;
}

/* obj_accessor(obj, nameStrId, getClo, setClo)：defineProperty / 字面量访问器。
 * 参数是闭包**句柄**（0x7FFF|off），不是表槽——闭包值由 emitter 在字面量处生成。
 * C 侧无法把 wasm 函数包成 JSFunction，故登记到 g_accs 由 prop_get/prop_set
 * 自行分派。*/
__attribute__((export_name("obj_accessor")))
int64_t qz_guest_obj_accessor(int64_t obj, int32_t nameStrId, int64_t getClo, int64_t setClo)
{
    int32_t k = qz_acc_find(obj, nameStrId);
    if (k < 0) {
        if (g_acc_n >= QZ_ACC_CAP) return obj;
        k = g_acc_n++;
        g_accs[k].obj = obj;
        g_accs[k].nameId = nameStrId;
    }
    g_accs[k].getClo = getClo;
    g_accs[k].setClo = setClo;
    return obj;
}

__attribute__((export_name("object_set_method")))
int64_t qz_guest_object_set_method(int64_t obj, int32_t nameStrId, int32_t slot)
{
    (void)obj; (void)nameStrId; (void)slot;
    return obj;   /* 占位 */
}

__attribute__((export_name("object_set_method_key")))
int64_t qz_guest_object_set_method_key(int64_t obj, int64_t key, int32_t slot)
{
    (void)obj; (void)key; (void)slot;
    return obj;   /* 占位 */
}

/* ── M6b: 内建全局分派（builtin 系列 + instanceof 内建） ─────────────
 * 名字 → globalThis 上的值。点号名（Math.floor / Symbol.for / JSON.stringify）
 * 沿 globalThis 逐段解析；构造函数名直接取 globalThis。*/

/* 内建常量表：非全局对象的常量值（与 qzvm.js BUILTIN_CONSTS 对齐）。*/
static const struct { const char *name; const char *lit; } QZ_CONSTS[] = {
    { "NaN", "NaN" }, { "Infinity", "Infinity" }, { "undefined", "undefined" },
    { "Number.MAX_SAFE_INTEGER", "9007199254740991" },
    { "Number.MIN_SAFE_INTEGER", "-9007199254740991" },
    { "Number.MAX_VALUE", "1.7976931348623157e308" },
    { "Number.MIN_VALUE", "5e-324" },
    { "Number.EPSILON", "2.220446049250313e-16" },
    { "Number.POSITIVE_INFINITY", "Infinity" },
    { "Number.NEGATIVE_INFINITY", "-Infinity" },
    { "Number.NaN", "NaN" },
    { "Math.PI", "3.141592653589793" },
    { "Math.E", "2.718281828459045" },
    { "Math.LN2", "0.6931471805599453" },
    { "Math.LN10", "2.302585092994046" },
    { "Math.LOG2E", "1.4426950408889634" },
    { "Math.LOG10E", "0.4342944819032518" },
    { "Math.SQRT2", "1.4142135623730951" },
    { "Math.SQRT1_2", "0.7071067811865476" },
};

/* 固定元数的内建函数：调用点按此裁剪实参（其余按调用点给的 n）。*/
static const struct { const char *name; int arity; } QZ_ARITY[] = {
    { "Math.log2", 1 }, { "Math.log10", 1 }, { "Math.atan2", 2 },
    { "Date.now", 0 }, { "Date.parse", 1 },
};

static JSValue qz_global_path(JSContext *ctx, const char *name)
{
    JSValue cur = JS_GetGlobalObject(ctx);
    const char *p = name;
    while (*p) {
        const char *dot = strchr(p, '.');
        size_t len = dot ? (size_t)(dot - p) : strlen(p);
        char seg[128];
        if (len >= sizeof(seg)) { JS_FreeValue(ctx, cur); return JS_UNDEFINED; }
        memcpy(seg, p, len); seg[len] = '\0';
        JSValue nxt = JS_GetPropertyStr(ctx, cur, seg);
        JS_FreeValue(ctx, cur);
        if (JS_IsUndefined(nxt) || JS_IsException(nxt)) return nxt;
        cur = nxt;
        if (!dot) break;
        p = dot + 1;
    }
    return cur;
}

static int qz_arity_of(const char *name)
{
    for (size_t i = 0; i < sizeof(QZ_ARITY) / sizeof(QZ_ARITY[0]); i++)
        if (strcmp(QZ_ARITY[i].name, name) == 0) return QZ_ARITY[i].arity;
    return -1;
}

static JSValue qz_const_lookup(JSContext *ctx, const char *name, int *found)
{
    for (size_t i = 0; i < sizeof(QZ_CONSTS) / sizeof(QZ_CONSTS[0]); i++) {
        if (strcmp(QZ_CONSTS[i].name, name) != 0) continue;
        *found = 1;
        return JS_Eval(ctx, QZ_CONSTS[i].lit, strlen(QZ_CONSTS[i].lit), "<const>", JS_EVAL_TYPE_GLOBAL);
    }
    *found = 0;
    return JS_UNDEFINED;
}

/* 名字 → 内建值（含符号/原型对象等）。未知名返回 JS_UNDEFINED。*/
static JSValue qz_builtin_lookup(JSContext *ctx, const char *name)
{
    int found = 0;
    JSValue v = qz_const_lookup(ctx, name, &found);
    if (found) return v;
    v = qz_global_path(ctx, name);
    return v;
}

__attribute__((export_name("builtin_value")))
int64_t qz_guest_builtin_value(int32_t id)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    size_t len = 0;
    const char *name = qz_str_by_id(id, &len);
    if (!name || len >= 128) return 0;
    char nm[128];
    memcpy(nm, name, len); nm[len] = '\0';
    JSValue v = qz_builtin_lookup(ctx, nm);
    if (JS_IsUndefined(v) || JS_IsException(v)) { JS_FreeValue(ctx, v); return 0; }
    int64_t out = qz_ret(ctx, v);
    JS_FreeValue(ctx, v);
    return out;
}

__attribute__((export_name("builtin_fn")))
int64_t qz_guest_builtin_fn(int32_t id)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    size_t len = 0;
    const char *name = qz_str_by_id(id, &len);
    if (!name || len >= 128) return 0;
    char nm[128];
    memcpy(nm, name, len); nm[len] = '\0';
    JSValue v = qz_builtin_lookup(ctx, nm);
    if (!JS_IsFunction(ctx, v)) { JS_FreeValue(ctx, v); return 0; }
    int64_t out = qz_ret(ctx, v);
    JS_FreeValue(ctx, v);
    return out;
}

__attribute__((export_name("builtin_member")))
int64_t qz_guest_builtin_member(int32_t id)
{
    return qz_guest_builtin_value(id);   /* 成员当作值读：同一查找路径 */
}

__attribute__((export_name("builtin")))
int64_t qz_guest_builtin(int32_t id, int32_t n, int64_t a0, int64_t a1,
                         int64_t a2, int64_t a3, int64_t ovf)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    size_t len = 0;
    const char *name = qz_str_by_id(id, &len);
    if (!name || len >= 128) return 0;
    char nm[128];
    memcpy(nm, name, len); nm[len] = '\0';

    JSValue fn = qz_builtin_lookup(ctx, nm);
    if (JS_IsException(fn)) { JS_FreeValue(ctx, fn); return 0; }
    /* 非函数（常量 / 原型对象）：直接作为调用结果 */
    if (!JS_IsFunction(ctx, fn)) {
        int64_t out = qz_ret(ctx, fn);
        JS_FreeValue(ctx, fn);
        return out;
    }

    JSValue argv[16];
    int argc = qz_collect_args(ctx, argv, 16,
                               qz_tojs(ctx, a0), qz_tojs(ctx, a1),
                               qz_tojs(ctx, a2), qz_tojs(ctx, a3),
                               qz_tojs(ctx, ovf));
    int arity = qz_arity_of(nm);
    if (arity >= 0 && arity < argc) argc = arity;
    if (n >= 0 && n < argc) argc = n;

    JSValue res = JS_Call(ctx, fn, JS_UNDEFINED, argc, argv);
    for (int i = 0; i < argc; i++) JS_FreeValue(ctx, argv[i]);
    JS_FreeValue(ctx, fn);
    if (JS_IsException(res)) { JS_FreeValue(ctx, res); return 0; }
    int64_t out = qz_ret(ctx, res);
    JS_FreeValue(ctx, res);
    return out;
}

/* x instanceof 内建类：按名字走 JS instanceof（宿主值）/ 按原型链前缀判定 */
__attribute__((export_name("instanceof_builtin")))
int32_t qz_guest_instanceof_builtin(int64_t x, int32_t id)
{
    if (!g_current_rt) return 0;
    JSContext *ctx = qz_get_active_jsctx(g_current_rt);
    if (!ctx) return 0;
    size_t len = 0;
    const char *name = qz_str_by_id(id, &len);
    if (!name || len >= 128) return 0;
    char nm[128];
    memcpy(nm, name, len); nm[len] = '\0';

    JSValue v = qz_builtin_lookup(ctx, nm);
    if (JS_IsException(v) || !JS_IsFunction(ctx, v)) { JS_FreeValue(ctx, v); return 0; }

    JSValue val = qz_tojs(ctx, x);
    JSValue glob = JS_GetGlobalObject(ctx);
    JSValue instf = JS_GetPropertyStr(ctx, glob, "Symbol");
    JS_FreeValue(ctx, glob);
    JSValue ctor = JS_UNDEFINED;
    if (!JS_IsException(instf) && !JS_IsUndefined(instf))
        ctor = JS_GetPropertyStr(ctx, instf, "hasInstance");
    JS_FreeValue(ctx, instf);
    int result = 0;
    if (JS_IsFunction(ctx, ctor)) {
        JSValue arg = v, r = JS_Call(ctx, ctor, arg, 1, &val);
        if (!JS_IsException(r)) {
            result = JS_ToBool(ctx, r) > 0;
            JS_FreeValue(ctx, r);
        }
    }
    JS_FreeValue(ctx, ctor);
    JS_FreeValue(ctx, v);
    return result;
}

/* 实例 instanceof 用户类：实例头 [off:i32] = clsId。类元数据（父链）本层不可达
 * （emitter 未向产物传 classMeta），故只做自反/直接相等判定。*/
__attribute__((export_name("instanceof_op")))
int64_t qz_guest_instanceof_op(int64_t obj, int32_t clsId)
{
    uint64_t u = (uint64_t)obj;
    if ((u >> 48) != 0x7FFE) return (int64_t)((uint64_t)0x7FFC << 48) | 0;
    int32_t cid = *(int32_t *)(uintptr_t)(uint32_t)(u & 0xFFFFFFFFu);
    return (int64_t)((uint64_t)0x7FFC << 48) | (cid == clsId ? 1 : 0);
}
