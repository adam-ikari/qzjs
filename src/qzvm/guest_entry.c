/*
 * qzvm guest entry — in-module wasm32 reactor（IN_MODULE_DESIGN.md §6/§7 M4）。
 *
 * QZ_VM_GUEST 专用：guest 编成 wasm32-wasi reactor，无 main/无 loop，宿主加载
 * 模块后经导出驱动（§5.4 tick 拉模型）。本 TU 把四个导出落到内核三源
 * （context.c / vm_core.c / ext_lifecycle.c）上，并经 qz_host.* import 调宿主
 * 能力（§10.3/§10.4）。
 *
 * 导出面（§6）：qz_create / qz_eval* / qz_tick / qz_destroy。
 *   - C 符号用 qz_guest_* 前缀（避免与宿主侧 qz_create/qz_destroy 同名冲突——
 *     guest 不链宿主源，但同名会让内核源交叉引用混乱）；wasm 导出名经
 *     __attribute__((export_name)) 映射到设计名。
 *   - 句柄 = guest 线性内存里的 qz_t*（i32），宿主当不透明句柄传回，不 deref。
 *
 * 宿主能力 import（§10.3/§10.4）：M4 只挂 tick 拉模型必需的 drain（§10.4「tick
 * = 排空 microtask + 拉 host 完成队列」）；完整 import 面（log/fs/http/…）随
 * M5/M6 逐类补齐。drain 在 M4 已被 qz_tick 真实引用（不是占位），故 import 段
 * 含 qz_host.*——这正是 M4 的验收条件。
 */
#ifndef QZ_VM_GUEST
#error "guest_entry.c 仅用于 QZ_VM_GUEST 构建（qzvm-guest target）"
#endif

#include "base/qz_rt.h"
#include <stdlib.h>
#include <string.h>

/* ── 宿主能力 import（§10.3/§10.4）────────────────────────────────── */
/* §10.4 import 拉：拉 host 侧完成队列 {op_id, err, ptr, len}，返回写入字节数
 * （0 = 无待处理）。qz_tick 每轮调一次——这是 tick 拉模型的真实引用点，
 * 也是 M4「import 段含 qz_host.*」的来源。host 侧实现属 M5。 */
__attribute__((import_module("qz_host"), import_name("drain")))
extern int qz_host_drain(void *buf, int max);

/* ── 内核导出包装 ────────────────────────────────────────────────── */

static qz_t *rt_from(uint32_t h) { return (qz_t *)(uintptr_t)h; }

/* qz_create：建 JSRuntime + 主 realm（内核 qz_ctx_create）。
 * config 经 guest 内存 ptr+len 传字节（§10.3 内存传递）；M4 暂不解析 config
 * 字段（M5 接真 polyfill/扩展 init 时再消费 initial_script 等）——只建空 realm
 * 供 eval/tick 跑。 */
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
    /* 主 realm：内核建 JSContext + 登记 rt->contexts。边界接线
     * （pal/polyfill/ext init）属 M5/M6，M4 不接。 */
    qz_ctx_t *ctx = qz_ctx_create(rt, NULL);
    if (!ctx) { JS_FreeRuntime(rt->jsrt); free(rt); return 0; }
    rt->active_ctx_id = ctx->context_id;
    return (uint32_t)(uintptr_t)rt;
}

__attribute__((export_name("qz_destroy")))
void qz_guest_destroy(uint32_t h)
{
    qz_t *rt = rt_from(h);
    if (!rt || rt->magic != QZ_MAGIC) return;
    /* 销毁全部 realm（内核只做 job 排水 + JS_FreeContext + 注销；扩展 destroy
     * 钩子/句柄清理属宿主接线，M4 guest 无）。 */
    for (int i = 0; i < QZ_MAX_CONTEXTS; i++) {
        if (rt->contexts[i]) qz_ctx_destroy(rt, rt->contexts[i]);
    }
    if (rt->jsrt) JS_FreeRuntime(rt->jsrt);
    rt->magic = 0;
    free(rt);
}

/* qz_eval：在活动 realm 上 eval 全局脚本。源经 ptr+len 传，guest 内拷 NUL
 * 终止后调内核 qz_eval_internal（它用 strlen）。err 串由内核 strdup 到 guest
 * 堆，M4 不回传宿主（M5 经 qz_host_log 或回流 ptr 报）。 */
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
    int rc = qz_eval_internal(rt, buf, &err);
    free(buf);
    free(err);
    return rc;
}

/* qz_tick：§5.4/§10.4 tick 拉模型——排空 JS 微任务 + 拉 host 完成队列。
 * drain 引用使 import 段含 qz_host.drain（M4 验收）。host 侧队列实现属 M5。 */
__attribute__((export_name("qz_tick")))
int qz_guest_tick(uint32_t h)
{
    qz_t *rt = rt_from(h);
    if (!rt || rt->magic != QZ_MAGIC) return -1;
    int total = qz_tick(rt);
    /* 拉 host 完成事件：buf 是 guest 栈帧，host 写入 {op_id, err, ptr, len}。
     * M4 host 未实现，drain 返回 0——不影响 link/import 段。 */
    char drain_buf[256];
    (void)qz_host_drain(drain_buf, (int)sizeof(drain_buf));
    return total;
}
