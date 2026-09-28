/*
 * qzjs Control Plane — CTL-0 进程内基线
 *
 * 控制命令消息（入队，flags=CONTROL）→ qzjs 线程 wake 分流点自主执行。
 * 外部只发「求」，运行时自主完成——与 idle safepoint 同哲学。
 *
 * 命令集（CTL-0 四命令）：eval / inspect / metrics / interrupt。
 * interrupt 唯一无安全点：原子标志投递即生效（§3.9）。
 *
 * 回执表（§1.2）：登记先于入队（dispatch 必能命中）；消费与超时回收 qzjs
 * 线程独占，一把表内锁串行化（竞争面 = 命令入队频率）。过期条目两个回收点：
 * 主循环 reap（惰性扫描）与 dispatch 前 claim（fail-closed：到期未执行 →
 * 作废，发 TIMEOUT，绝不迟执行）。
 *
 * 设计：docs/plans/2026-09-04-control-plane-design.md §1-§3、§6。
 */

#include "qz_internal.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* ── Receipt table ── */

struct qz_ctl_recept_s {
    char *correl;           /* strdup'd correl（简单 id：无转义字符） */
    uint64_t deadline_ns;   /* uv_hrtime() + timeout_ms * 1e6 */
    int32_t  reply_dir;     /* CTL-1 回程方向：-1 = 本地邮箱（qz_recv_message）；
                             * >=0 = 回执信封 target（命令来源地址） */
    void    *sink;          /* CTL-2 端点连接：非 NULL 时回执写回该连接 */
    struct qz_ctl_recept_s *next;
};
/* ── 控制命令字段提取（生产者线程，无 JSContext）──
 *
 * 只在 qz_control（生产者线程）用于提取 correl/timeout_ms/op 三个顶层
 * 字段。JSRuntime 归 qzjs 线程所有，生产者线程无 JSContext 可用，且
 * interrupt 命令要求 runtime 暂停/未初始化时也能入队生效——JS_ParseJSON
 * 不可用，必须在 C 层做（裁决：docs/architecture/c-js-layering.md §6.6）。
 * 完整解析在 dispatch（qzjs 线程）用 JS_ParseJSON；此处用 vendored
 * cJSON（用户指令：不手写）。correl 约定为简单 id：无转义/嵌套。 */

#include <cJSON.h>

/* CTL-1 跨进程回执走信封（ipc_process.c 的发送原语）。mock 测试构建无 ipc
 * 后端（QZ_USE_MOCK_LIBUV），回程恒为本地，转发路径不编入。 */
#ifndef QZ_USE_MOCK_LIBUV
#include "ipc_process.h"
#endif

/* ── Receipt helpers (qzjs thread) ── */

/* 本节点在父树中的槽位 id（宿主 0 / 主RT 1 / worker --worker-id）。不依赖
 * ipc 后端（mock 构建亦编入），供 CTL-1 路由与转发复用。 */
int32_t qz_ctl_local_id(qz_t *rt)
{
    if (rt->worker_self)
        return (int32_t)((qz_worker_t *)rt->worker_self)->id;
    return 1;                   /* QZ_IPC_MAIN_ID：主RT 通道上的本地标签 */
}

#ifndef QZ_USE_MOCK_LIBUV
/* 回程发送：把回执 JSON 交给跨进程通道（CTL-1 §2.2「回执沿树回」）。
 * target = 回程地址（命令来源，逐跳相对寻址）：0/1 → 上行（父通道）；
 * >1 → 下行到本地子槽位。source 填本节点槽位 id（父视角的「来源」）。 */

static void ctl_emit_remote(qz_t *rt, int32_t target,
                            const uint8_t *json, size_t len)
{
    int32_t self = qz_ctl_local_id(rt);
    if (target == 0 || target == 1) {
        qz_ipc_child_emit(self, target, IPC_ENV_KIND_CONTROL,
                            0,
                            json, (uint32_t)len);
        return;
    }
    for (int i = 0; i < QZ_MAX_PROC_HANDLES; i++) {
        qz_proc_handle_t *h = &rt->proc_handles[i];
        if (h->live && h->proc && h->proc->id == target) {
            qz_proc_post(h->proc, self, target, IPC_ENV_KIND_CONTROL,
                           0,
                           json, (uint32_t)len);
            return;
        }
    }
    /* 无对应通道：回执丢弃（发起方靠自身 timeout 收束）。 */
}
#else
static void ctl_emit_remote(qz_t *rt, int32_t target,
                            const uint8_t *json, size_t len)
{
    QZ_UNUSED(rt); QZ_UNUSED(target); QZ_UNUSED(json); QZ_UNUSED(len);
}
#endif

/* 查表取条目（回程方向 + 端点 sink）并移除（qzjs 线程独占；回执消费点）。 */
static int32_t ctl_take_reply(qz_t *rt, const char *correl, void **sink_out)
{
    if (sink_out) *sink_out = NULL;
    if (!correl) return -1;
    int32_t dir = -1;
    uv_mutex_lock(&rt->ctl_lock);
    struct qz_ctl_recept_s **pp = &rt->ctl_pending;
    while (*pp) {
        if (strcmp((*pp)->correl, correl) == 0) {
            struct qz_ctl_recept_s *r = *pp;
            *pp = r->next;
            dir = r->reply_dir;
            if (sink_out) *sink_out = r->sink;
            free(r->correl);
            free(r);
            break;
        }
        pp = &(*pp)->next;
    }
    uv_mutex_unlock(&rt->ctl_lock);
    return dir;
}

/* 回执出口：序列化 obj（吞掉），按 sink/reply_dir 分发——端点连接优先
 * （CTL-2），其次跨进程信封（CTL-1），否则入本地邮箱（CTL-0 行为不变）。 */
static void ctl_emit_obj(qz_t *rt, JSContext *ctx, JSValue obj,
                         int32_t reply_dir, void *sink)
{
    JSValue str = JS_JSONStringify(ctx, obj, JS_UNDEFINED, JS_UNDEFINED);
    JS_FreeValue(ctx, obj);
    if (JS_IsException(str)) {
        JS_FreeValue(ctx, str);
        return;
    }
    const char *json = JS_ToCString(ctx, str);
    JS_FreeValue(ctx, str);
    if (!json) return;
    if (sink) {
        qz_ctl_conn_write(sink, json, strlen(json));
    } else if (reply_dir >= 0) {
        ctl_emit_remote(rt, reply_dir, (const uint8_t *)json, strlen(json));
    } else {
        qz_post_to_host(rt, json, strlen(json));   /* 出站漏斗（M-P7） */
    }
    JS_FreeCString(ctx, json);
}

/* 构建 JSValue 回执对象并经回程下发（吞掉 obj）。条目在回执生成时消费
 * （§1.2）：命中端点/跨进程命令 → 连接/信封；否则入宿主邮箱。 */
static void ctl_send_receipt(qz_t *rt, JSContext *ctx, JSValue receipt_obj)
{
    int32_t reply_dir = -1;
    void *sink = NULL;
    JSValue cv = JS_GetPropertyStr(ctx, receipt_obj, "correl");
    const char *correl = JS_ToCString(ctx, cv);
    if (correl) {
        reply_dir = ctl_take_reply(rt, correl, &sink);
        JS_FreeCString(ctx, correl);
    }
    JS_FreeValue(ctx, cv);
    ctl_emit_obj(rt, ctx, receipt_obj, reply_dir, sink);
}

static JSValue ctl_receipt_obj(JSContext *ctx, char *correl, int ok)
{
    JSValue r = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, r, "ctl", JS_TRUE);
    JS_SetPropertyStr(ctx, r, "correl", JS_NewString(ctx, correl ? correl : ""));
    JS_SetPropertyStr(ctx, r, "ok", ok ? JS_TRUE : JS_FALSE);
    free(correl);
    return r;
}

static void ctl_error_receipt(qz_t *rt, JSContext *ctx, char *correl,
                              const char *error, const char *code)
{
    JSValue r = ctl_receipt_obj(ctx, correl, 0);
    JS_SetPropertyStr(ctx, r, "error", JS_NewString(ctx, error));
    JS_SetPropertyStr(ctx, r, "code", JS_NewString(ctx, code));
    ctl_send_receipt(rt, ctx, r);
}

/* 超时回执：条目已在 claim/reap 中移除，回程方向与端点 sink 随参数带入。 */
static void ctl_timeout_receipt(qz_t *rt, JSContext *ctx, const char *correl,
                                int32_t reply_dir, void *sink)
{
    char *dup = correl ? strdup(correl) : NULL;
    JSValue r = ctl_receipt_obj(ctx, dup, 0);
    JS_SetPropertyStr(ctx, r, "error", JS_NewString(ctx, "timeout"));
    JS_SetPropertyStr(ctx, r, "code", JS_NewString(ctx, "TIMEOUT"));
    ctl_emit_obj(rt, ctx, r, reply_dir, sink);
}

/* ── Receipt table operations ── */
void qz_ctl_register(qz_t *rt, const char *correl, uint64_t deadline_ns,
                       int32_t reply_dir, void *sink)
{
    struct qz_ctl_recept_s *r =
        (struct qz_ctl_recept_s *)calloc(1, sizeof *r);
    if (!r) return;             /* OOM：无条目，发起方靠超时（§6） */
    r->correl = strdup(correl ? correl : "");
    if (!r->correl) { free(r); return; }
    r->deadline_ns = deadline_ns;
    r->reply_dir = reply_dir;
    r->sink = sink;
    uv_mutex_lock(&rt->ctl_lock);
    r->next = rt->ctl_pending;
    rt->ctl_pending = r;
    uv_mutex_unlock(&rt->ctl_lock);
}

/* CTL-2：端点连接关闭时清理其名下未完成回执条目（sink 悬垂防护）。 */
void qz_ctl_conn_drop(qz_t *rt, void *conn)
{
    if (!rt || !conn) return;
    uv_mutex_lock(&rt->ctl_lock);
    struct qz_ctl_recept_s **pp = &rt->ctl_pending;
    while (*pp) {
        if ((*pp)->sink == conn) {
            struct qz_ctl_recept_s *r = *pp;
            *pp = r->next;
            free(r->correl);
            free(r);
        } else {
            pp = &(*pp)->next;
        }
    }
    uv_mutex_unlock(&rt->ctl_lock);
}

static void ctl_unregister(qz_t *rt, const char *correl)
{
    /* push 失败时回收刚登记的条目（§6：入队失败 → 表无条目）。 */
    if (!correl) return;
    uv_mutex_lock(&rt->ctl_lock);
    struct qz_ctl_recept_s **pp = &rt->ctl_pending;
    while (*pp) {
        if (strcmp((*pp)->correl, correl) == 0) {
            struct qz_ctl_recept_s *r = *pp;
            *pp = r->next;
            uv_mutex_unlock(&rt->ctl_lock);
            free(r->correl);
            free(r);
            return;
        }
        pp = &(*pp)->next;
    }
    uv_mutex_unlock(&rt->ctl_lock);
}

/* dispatch 前核验（fail-closed，§1.3）：命中且未过期 → 放行（1）；命中但
 * 已过期 → 移除 + TIMEOUT 回执（0，命令作废绝不迟执行）；未命中（已被
 * reap 回收/从未登记）→ 0（TIMEOUT 已由 reap 发出，静默跳过）。 */
static int ctl_claim(qz_t *rt, const char *correl)
{
    if (!correl) return 1;      /* 无 correl：无法核验，放行（回执本就不可配对） */
    uint64_t now = uv_hrtime();
    struct qz_ctl_recept_s *dead = NULL;
    int live = 0;
    uv_mutex_lock(&rt->ctl_lock);
    struct qz_ctl_recept_s **pp = &rt->ctl_pending;
    while (*pp) {
        if (strcmp((*pp)->correl, correl) == 0) {
            if ((*pp)->deadline_ns > now) {
                live = 1;
            } else {
                dead = *pp;
                *pp = dead->next;
            }
            break;
        }
        pp = &(*pp)->next;
    }
    uv_mutex_unlock(&rt->ctl_lock);
    if (dead) {
        JSContext *ctx = qz_get_active_jsctx(rt);
        if (ctx) ctl_timeout_receipt(rt, ctx, dead->correl, dead->reply_dir,
                                    dead->sink);
        free(dead->correl);
        free(dead);
    }
    return live;
}
/* 命令顶层字段提取（生产者/路由路径，无 JSContext；用 vendored cJSON）。
 * buf 须 NUL 结尾。缺失字段留 NULL/缺省；target_out 非 NULL 时提取
 * "target"（CTL-1 寻址字段，缺省 1 = 接收方自身）。 */
static void ctl_extract(const char *buf, char **op_out, char **correl_out,
                        int *timeout_ms_out, int32_t *target_out)
{
    cJSON *j = cJSON_Parse(buf);
    if (!j) return;
    const cJSON *opv = cJSON_GetObjectItemCaseSensitive(j, "op");
    const cJSON *correlv = cJSON_GetObjectItemCaseSensitive(j, "correl");
    const cJSON *tmv = cJSON_GetObjectItemCaseSensitive(j, "timeout_ms");
    const cJSON *tgv = cJSON_GetObjectItemCaseSensitive(j, "target");
    if (op_out && cJSON_IsString(opv) && opv->valuestring)
        *op_out = strdup(opv->valuestring);
    if (correl_out && cJSON_IsString(correlv) && correlv->valuestring)
        *correl_out = strdup(correlv->valuestring);
    if (timeout_ms_out && cJSON_IsNumber(tmv))
        *timeout_ms_out = tmv->valueint;
    if (target_out && cJSON_IsNumber(tgv))
        *target_out = (int32_t)tgv->valueint;
    cJSON_Delete(j);
}

/* §8.2/CTL-1 扩展：命令 JSON 可选 "target_path"（root-relative path 链，元素
 * 为各级父分配的槽位 id）。返回元素数（0 = 无此字段 → 走旧 int32 单跳相对
 * 语义，扁平拓扑不变）。路由器本已解析 JSON（回执判定），此处沿用同一裁决。 */
static int ctl_extract_path(const uint8_t *payload, uint32_t len,
                            int32_t *out, int cap)
{
    if (!payload || len == 0 || len > 65536u) return 0;
    char *buf = (char *)malloc((size_t)len + 1);
    if (!buf) return 0;
    memcpy(buf, payload, len);
    buf[len] = '\0';
    int n = 0;
    cJSON *j = cJSON_Parse(buf);
    if (j) {
        cJSON *tp = cJSON_GetObjectItemCaseSensitive(j, "target_path");
        if (cJSON_IsArray(tp)) {
            cJSON *e = NULL;
            cJSON_ArrayForEach(e, tp) {
                if (n >= cap) break;
                if (cJSON_IsNumber(e)) out[n++] = (int32_t)e->valuedouble;
            }
        }
        cJSON_Delete(j);
    }
    free(buf);
    return n;
}

int32_t qz_ctl_cmd_target(const char *json, size_t len)
{
    QZ_UNUSED(len);
    int32_t target = 1;         /* 缺省：接收方自身（QZ_IPC_MAIN_ID） */
    if (!json) return target;
    ctl_extract(json, NULL, NULL, NULL, &target);
    /* 带 target_path 时，本跳信封 target = 路径首元素（根的直接子槽位）；
     * 后续各跳由 qz_control_route 按各节点自身深度重写。 */
    {
        int32_t p[QZ_SELF_PATH_MAX];
        int pn = ctl_extract_path((const uint8_t *)json, (uint32_t)len, p,
                                  QZ_SELF_PATH_MAX);
        if (pn > 0) return p[0];
    }
    return target;
}

int qz_control(qz_t *rt, const char *bytes, size_t len)
{
    return qz_control_sink(rt, bytes, len, NULL);
}

int qz_control_sink(qz_t *rt, const char *bytes, size_t len, void *sink)
{
    if (!rt || rt->magic != QZ_MAGIC || !bytes)
        return -1;
    /* OFF：控制面恒拒（§4.1 默认档）。 */
    if (rt->config.control_plane == QZ_CONTROL_OFF)
        return -1;
    /* 提取器按 NUL 结尾扫描，而 API 契约只保证 (bytes, len)——先拷贝补
     * NUL（msgq 内部同样要拷，此处多一份短暂副本）。 */
    char *buf = (char *)malloc(len + 1);
    if (!buf) return -1;
    memcpy(buf, bytes, len);
    buf[len] = '\0';

    int timeout_ms = 5000;
    char *op = NULL, *correl = NULL;
    ctl_extract(buf, &op, &correl, &timeout_ms, NULL);

    /* interrupt：投递即生效——原子标志在生产者线程置位（§1.1 唯一例外）。
     * 命令消息照常入队只为 correl 回执。 */
    if (op && strcmp(op, "interrupt") == 0)
        __atomic_store_n(&rt->ctl_interrupt, 1, __ATOMIC_RELEASE);

    /* 登记先于入队（§1.2）：dispatch 必能命中条目。本条命令在本进程产生
     * 回执（进程内 dispatch 或本进程邮箱回执）→ reply_dir = -1。 */
    uint64_t deadline = uv_hrtime() + (uint64_t)timeout_ms * 1000000ULL;
    qz_ctl_register(rt, correl, deadline, -1, sink);

    /* ISOLATED 宿主：入队后由 host_wake_cb 装 CONTROL 信封发主RT（target
     * 取自命令 "target" 字段）；THREAD：由 qz_wake_cb 就地 dispatch。 */
    int rc = qz_msg_push(rt, buf, len, QZ_MSG_SRC_HOST,
                           QZ_MSG_FLAG_CONTROL);
    free(buf);
    if (rc != 0) {
        ctl_unregister(rt, correl);   /* §6：入队失败 → 表无条目 */
        free(op);
        free(correl);
        return -1;
    }
    uv_async_send(&rt->wake);   /* 唤醒与容器解耦（M-P7） */
    free(op);
    free(correl);
    return 0;
}

/* ── CTL-1：信封 CONTROL 命令树路由（§2.2 / 多进程 §4.3、§7.2）──
 *
 * 逐跳相对寻址：target 由当前持有信封的节点相对解释——等于本地槽位 id 即
 * 命中本地（入 msgq flags=CONTROL）；0/1 为朝根方向（上行）；>1 为本地子
 * 槽位（下行）。source 承载回程方向，转发时保持不变（只有 target 逐跳改写）。 */

qz_ctl_route_t qz_ctl_route_decide(int32_t local_id, int32_t target)
{
    if (target == local_id) return QZ_CTL_ROUTE_LOCAL;
    if (target == 0 || target == 1) return QZ_CTL_ROUTE_UP;
    if (target > 1) return QZ_CTL_ROUTE_DOWN;
    return QZ_CTL_ROUTE_DROP;     /* target < 0：无此地址 */
}

/* 本地执行一条命令：登记回执条目（回程 = reply_dir 信封方向 / sink 端点
 * 连接）→ 入 msgq（flags=CONTROL）交 dispatch。interrupt 在入队前置原子
 * 标志（§3.9 投递即生效）。 */
static int ctl_local_command(qz_t *rt, const uint8_t *payload, uint32_t len,
                             int32_t reply_dir, void *sink)
{
    char *buf = (char *)malloc((size_t)len + 1);
    if (!buf) return -1;
    memcpy(buf, payload, len);
    buf[len] = '\0';
    int timeout_ms = 5000;
    char *op = NULL, *correl = NULL;
    ctl_extract(buf, &op, &correl, &timeout_ms, NULL);
    if (op && strcmp(op, "interrupt") == 0)
        __atomic_store_n(&rt->ctl_interrupt, 1, __ATOMIC_RELEASE);
    uint64_t deadline = uv_hrtime() + (uint64_t)timeout_ms * 1000000ULL;
    qz_ctl_register(rt, correl, deadline, reply_dir, sink);
    int rc = qz_msg_push(rt, buf, (size_t)len, QZ_MSG_SRC_HOST,
                           QZ_MSG_FLAG_CONTROL);
    free(buf);
    if (rc != 0) ctl_unregister(rt, correl);
    else uv_async_send(&rt->wake);   /* 唤醒与容器解耦（M-P7） */
    free(op);
    free(correl);
    return rc == 0 ? 0 : -1;
}

/* 逐跳转发一条 CONTROL 信封：target>1 下行到本地子槽位，否则上行；source
 * 保持（承载回程方向），payload 字节原样透传。 */
static int ctl_forward(qz_t *rt, int32_t source, int32_t target,
                       const uint8_t *payload, uint32_t len)
{
#ifndef QZ_USE_MOCK_LIBUV
    if (target > 1) {
        for (int i = 0; i < QZ_MAX_PROC_HANDLES; i++) {
            qz_proc_handle_t *h = &rt->proc_handles[i];
            if (h->live && h->proc && h->proc->id == target) {
                qz_proc_post(h->proc, source, target,
                               IPC_ENV_KIND_CONTROL, 0,
                               payload, len);
                return 0;
            }
        }
        return -1;              /* 无对应子槽位 */
    }
    qz_ipc_child_emit(source, target, IPC_ENV_KIND_CONTROL, 0,
                        payload, len);
    return 0;
#else
    QZ_UNUSED(rt); QZ_UNUSED(source); QZ_UNUSED(target);
    QZ_UNUSED(payload); QZ_UNUSED(len);
    return -1;
#endif
}

/* 回执判定：payload 顶层 "ctl":true（命令 JSON 用 op/correl/…，字段不重叠）。 */
static int ctl_is_receipt(const uint8_t *payload, uint32_t len)
{
    char buf[512];
    if (len == 0 || len >= sizeof buf) return 0;
    memcpy(buf, payload, len);
    buf[len] = '\0';
    cJSON *j = cJSON_Parse(buf);
    if (!j) return 0;
    int is = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(j, "ctl"));
    cJSON_Delete(j);
    return is;
}

int qz_ctl_deliver_receipt(qz_t *rt, const uint8_t *payload, uint32_t len)
{
    if (!rt || !payload) return -1;
    char *buf = (char *)malloc((size_t)len + 1);
    if (!buf) return -1;
    memcpy(buf, payload, len);
    buf[len] = '\0';
    char *correl = NULL;
    ctl_extract(buf, NULL, &correl, NULL, NULL);

    void *sink = NULL;
    int32_t dir = ctl_take_reply(rt, correl, &sink);
    if (sink) {
        qz_ctl_conn_write(sink, buf, len);          /* 端点控制器 */
    } else if (dir >= 0) {
        ctl_emit_remote(rt, dir, payload, len);       /* 沿树继续上行 */
    } else {
        qz_post_to_host(rt, buf, len);               /* 出站漏斗（M-P7） */
    }
    free(correl);
    free(buf);
    return 0;
}

int qz_control_route(qz_t *rt, int32_t local_id, int32_t source,
                       int32_t target, const uint8_t *payload, uint32_t len)
{
    if (!rt || rt->magic != QZ_MAGIC || !payload) return -1;
    /* OFF：信封 CONTROL 命令类入站即丢弃（§4.1）。系统级 CONTROL（握手/
     * idle/shutdown）由调用方先行分流，不受本档影响。 */
    if (rt->config.control_plane == QZ_CONTROL_OFF) return -1;
    /* §8.2 path 链寻址（CTL-1 单跳相对的扩展）：命令 JSON 带 target_path 时，
     * 按「本节点深度 + 前缀比较」决定投递方向——本节点深度 == 路径长度且前缀
     * 吻合 → 目的地即本节点；本节点是目的地严格祖先 → 下投路径中本层那座
     * 槽位（信封 target 重写为该槽位，非本层子槽位）；否则上行（祖先再判）。
     * 无 target_path → 走下方旧 int32 单跳相对语义（扁平拓扑零改动）。 */
    {
        int32_t p[QZ_SELF_PATH_MAX];
        int pn = ctl_extract_path(payload, len, p, QZ_SELF_PATH_MAX);
        if (pn > 0) {
            int d = (int)rt->self_path_len;
            int on_path = (d <= pn);
            for (int i = 0; on_path && i < d; i++)
                if ((int32_t)rt->self_path[i] != p[i]) on_path = 0;
            if (on_path && d == pn) {
                if (ctl_is_receipt(payload, len))
                    return qz_ctl_deliver_receipt(rt, payload, len);
                return ctl_local_command(rt, payload, len, source, NULL);
            }
            if (on_path)
                return ctl_forward(rt, source, p[d], payload, len);
            /* 1 = QZ_IPC_MAIN_ID（mock 构建不编入 ipc_process.h，用字面量） */
            return ctl_forward(rt, source, 1, payload, len);
        }
    }

    switch (qz_ctl_route_decide(local_id, target)) {
    case QZ_CTL_ROUTE_LOCAL:
        /* 命中本地的可能是「命令」（下发执行）或「回执」（沿树回程）。 */
        if (ctl_is_receipt(payload, len))
            return qz_ctl_deliver_receipt(rt, payload, len);
        return ctl_local_command(rt, payload, len, source, NULL);
    case QZ_CTL_ROUTE_UP:
    case QZ_CTL_ROUTE_DOWN:
        return ctl_forward(rt, source, target, payload, len);
    case QZ_CTL_ROUTE_DROP:
    default:
        return -1;
    }
}

int qz_control_endpoint_cmd(qz_t *rt, const char *bytes, size_t len,
                              void *sink)
{
    if (!rt || rt->magic != QZ_MAGIC || !bytes) return -1;
    if (rt->config.control_plane != QZ_CONTROL_LOCAL) return -1;

    char *buf = (char *)malloc(len + 1);
    if (!buf) return -1;
    memcpy(buf, bytes, len);
    buf[len] = '\0';
    int32_t target = 1;
    int timeout_ms = 5000;
    char *correl = NULL;
    ctl_extract(buf, NULL, &correl, &timeout_ms, &target);

    /* §8.2 path 链寻址：target_path 指向孙及更深（本节点 depth 0 = 根）→
     * 登记回执（sink 连接）后按路径首元素下投；回执沿树回来时按 correl 找到
     * sink 写回。 */
    {
        int32_t p[QZ_SELF_PATH_MAX];
        int pn = ctl_extract_path((const uint8_t *)bytes, (uint32_t)len, p,
                                  QZ_SELF_PATH_MAX);
        if (pn > (int)rt->self_path_len) {
            uint64_t dl = uv_hrtime() + (uint64_t)timeout_ms * 1000000ULL;
            qz_ctl_register(rt, correl, dl, -1, sink);
            return ctl_forward(rt, qz_ctl_local_id(rt),
                               p[rt->self_path_len], (const uint8_t *)bytes,
                               (uint32_t)len);
        }
    }
    free(buf);

    int32_t local = qz_ctl_local_id(rt);
    int rc;
    if (target == local) {
        rc = ctl_local_command(rt, (const uint8_t *)bytes, (uint32_t)len,
                               -1, sink);
    } else {
        /* 远端目标：条目留在本节点——回执沿树回来（target == local）时按
         * correl 找回 sink 并写回该连接。 */
        uint64_t deadline = uv_hrtime() + (uint64_t)timeout_ms * 1000000ULL;
        qz_ctl_register(rt, correl, deadline, -1, sink);
        rc = ctl_forward(rt, local, target, (const uint8_t *)bytes,
                         (uint32_t)len);
        if (rc != 0) {
            /* 无对应子槽位：fail-closed 但不留无应答（§1.2「回执或 TIMEOUT
             * 二者其一」）——立刻回 NOT_FOUND。correl 约定为简单 id。 */
            ctl_unregister(rt, correl);
            char err[192];
            int n = snprintf(err, sizeof err,
                             "{\"ctl\":true,\"correl\":\"%s\",\"ok\":false,"
                             "\"error\":\"no such target\","
                             "\"code\":\"NOT_FOUND\"}",
                             correl ? correl : "");
            if (n > 0 && (size_t)n < sizeof err)
                qz_ctl_conn_write(sink, err, (size_t)n);
        }
    }
    free(correl);
    return rc;
}
void qz_ctl_reap_timeouts(qz_t *rt)
{
    uint64_t now = uv_hrtime();
    struct qz_ctl_recept_s *dead = NULL;
    struct qz_ctl_recept_s **dead_tail = &dead;

    uv_mutex_lock(&rt->ctl_lock);
    struct qz_ctl_recept_s **pp = &rt->ctl_pending;
    while (*pp) {
        if ((*pp)->deadline_ns <= now) {
            struct qz_ctl_recept_s *r = *pp;
            *pp = r->next;           /* unlink */
            *dead_tail = r;           /* append to dead chain */
            dead_tail = &r->next;
        } else {
            pp = &(*pp)->next;
        }
    }
    uv_mutex_unlock(&rt->ctl_lock);

    if (!dead) return;
    JSContext *ctx = qz_get_active_jsctx(rt);
    while (dead) {
        struct qz_ctl_recept_s *r = dead;
        dead = r->next;
        if (ctx) ctl_timeout_receipt(rt, ctx, r->correl, r->reply_dir, r->sink);
        free(r->correl);
        free(r);
    }
}

void qz_ctl_teardown(qz_t *rt)
{
    /* 释放所有未完成回执条目（无回执发出——发起方靠自身超时）+ 销毁锁。 */
    struct qz_ctl_recept_s *r = rt->ctl_pending;
    while (r) {
        struct qz_ctl_recept_s *next = r->next;
        free(r->correl);
        free(r);
        r = next;
    }
    rt->ctl_pending = NULL;
    uv_mutex_destroy(&rt->ctl_lock);
}

/* ── Interrupt handler (QuickJS callback) ── */

int qz_ctl_interrupt_handler(JSRuntime *jsrt, void *opaque)
{
    (void)jsrt;
    qz_t *rt = (qz_t *)opaque;
    if (__atomic_load_n(&rt->ctl_interrupt, __ATOMIC_ACQUIRE)) {
        __atomic_store_n(&rt->ctl_interrupt, 0, __ATOMIC_RELEASE);
        return 1;              /* non-zero → JS_ThrowInterrupted（uncatchable） */
    }
    return 0;
}


/* ── Dispatch（qzjs 线程独占，wake safepoint） ── */

/* 目标 ctx：cmd.ctx_id 缺省 → active ctx；提供但不存在 → NULL（NOT_FOUND）。 */
static qz_ctx_t *ctl_target_ctx(qz_t *rt, JSContext *pctx, JSValue cmd)
{
    JSValue cid = JS_GetPropertyStr(pctx, cmd, "ctx_id");
    int has = !(JS_IsUndefined(cid) || JS_IsNull(cid));
    int id = -1;
    if (has && JS_ToInt32(pctx, &id, cid) < 0) id = -1;
    JS_FreeValue(pctx, cid);
    if (!has || id < 0) return qz_get_active_ctx(rt);
    return qz_get_ctx_by_id(rt, id);
}

static void ctl_eval(qz_t *rt, JSContext *rcpt_ctx, JSValue cmd, char *correl)
{
    qz_ctx_t *target = ctl_target_ctx(rt, rcpt_ctx, cmd);
    if (!target || !target->jsctx) {
        ctl_error_receipt(rt, rcpt_ctx, correl, "no such context", "NOT_FOUND");
        return;
    }
    JSContext *ctx = target->jsctx;

    JSValue script = JS_GetPropertyStr(rcpt_ctx, cmd, "script");
    const char *code = JS_ToCString(rcpt_ctx, script);
    JS_FreeValue(rcpt_ctx, script);
    if (!code) {
        ctl_error_receipt(rt, rcpt_ctx, correl, "script must be a string",
                          "INVALID_ARG");
        return;
    }

    JSValue val = JS_Eval(ctx, code, strlen(code), "<control-eval>",
                          JS_EVAL_TYPE_GLOBAL);
    JS_FreeCString(rcpt_ctx, code);

    if (JS_IsException(val)) {
        JSValue exc = JS_GetException(ctx);
        JSValue r = ctl_receipt_obj(ctx, correl, 0);
        if (JS_IsUncatchableError(exc)) {
            /* §3.9：中断异常不可捕获 → 专属回执 */
            JS_SetPropertyStr(ctx, r, "error", JS_NewString(ctx, "interrupted"));
            JS_SetPropertyStr(ctx, r, "code", JS_NewString(ctx, "INTERRUPTED"));
        } else {
            const char *msg = JS_ToCString(ctx, exc);
            JS_SetPropertyStr(ctx, r, "error",
                              JS_NewString(ctx, msg ? msg : "unknown error"));
            JS_SetPropertyStr(ctx, r, "code", JS_NewString(ctx, "JS_EXCEPTION"));
            if (msg) JS_FreeCString(ctx, msg);
        }
        JS_FreeValue(ctx, exc);
        JS_FreeValue(ctx, val);
        ctl_send_receipt(rt, rcpt_ctx, r);
        return;
    }

    JSValue r = ctl_receipt_obj(ctx, correl, 1);
    JS_SetPropertyStr(ctx, r, "result", val);   /* val 移交 */
    ctl_send_receipt(rt, rcpt_ctx, r);
}

static void ctl_inspect(qz_t *rt, JSContext *rcpt_ctx, JSValue cmd, char *correl)
{
    qz_ctx_t *target = ctl_target_ctx(rt, rcpt_ctx, cmd);
    if (!target || !target->jsctx) {
        ctl_error_receipt(rt, rcpt_ctx, correl, "no such context", "NOT_FOUND");
        return;
    }
    JSContext *ctx = target->jsctx;

    JSValue expr = JS_GetPropertyStr(rcpt_ctx, cmd, "expr");
    const char *code = JS_ToCString(rcpt_ctx, expr);
    JS_FreeValue(rcpt_ctx, expr);
    if (!code) {
        ctl_error_receipt(rt, rcpt_ctx, correl, "expr must be a string",
                          "INVALID_ARG");
        return;
    }

    JSValue val = JS_Eval(ctx, code, strlen(code), "<control-inspect>",
                          JS_EVAL_TYPE_GLOBAL);
    JS_FreeCString(rcpt_ctx, code);

    if (JS_IsException(val)) {
        JSValue exc = JS_GetException(ctx);
        const char *msg = JS_ToCString(ctx, exc);
        ctl_error_receipt(rt, rcpt_ctx, correl,
                          msg ? msg : "unknown error", "JS_EXCEPTION");
        if (msg) JS_FreeCString(ctx, msg);
        JS_FreeValue(ctx, exc);
        JS_FreeValue(ctx, val);
        return;
    }

    /* expr 结果必须 JSON 可序列化（§3）：否则 INVALID_ARG */
    JSValue jsonstr = JS_JSONStringify(ctx, val, JS_UNDEFINED, JS_UNDEFINED);
    JS_FreeValue(ctx, val);
    if (JS_IsException(jsonstr) || JS_IsUndefined(jsonstr)) {
        JS_FreeValue(ctx, jsonstr);
        ctl_error_receipt(rt, rcpt_ctx, correl, "not JSON serializable",
                          "INVALID_ARG");
        return;
    }
    JSValue r = ctl_receipt_obj(ctx, correl, 1);
    JS_SetPropertyStr(ctx, r, "json", jsonstr);
    ctl_send_receipt(rt, rcpt_ctx, r);
}

static void ctl_metrics(qz_t *rt, JSContext *ctx, char *correl)
{
    /* 只读原子计数 + 引擎内存统计：即时返回，无安全点依赖（§3）。 */
    JSMemoryUsage mem;
    JS_ComputeMemoryUsage(rt->jsrt, &mem);
    int workers = 0;
    for (int i = 0; i < QZ_MAX_WORKERS; i++)
        if (rt->workers[i]) workers++;

    JSValue r = ctl_receipt_obj(ctx, correl, 1);
    JS_SetPropertyStr(ctx, r, "heap_bytes", JS_NewInt64(ctx, mem.memory_used_size));
    JS_SetPropertyStr(ctx, r, "handle_count",
                      JS_NewInt32(ctx, rt->contexts[0] ? rt->contexts[0]->handle_count : 0));
    JS_SetPropertyStr(ctx, r, "pending_jobs",
                      JS_NewInt32(ctx, JS_IsJobPending(rt->jsrt) ? 1 : 0));
    JS_SetPropertyStr(ctx, r, "ctx_count", JS_NewInt32(ctx, rt->context_count));
    JS_SetPropertyStr(ctx, r, "worker_count", JS_NewInt32(ctx, workers));
    ctl_send_receipt(rt, ctx, r);
}

void qz_control_dispatch(qz_t *rt, qz_msg_t *m)
{
    /* qzjs 线程独占。m->data 为命令 JSON（msgq 保证 NUL 结尾）。 */
    JSContext *ctx = qz_get_active_jsctx(rt);
    if (!ctx) return;

    /* fail-closed（§1.3）：先以登记时的同一提取器核验条目——过期的命令
     * 作废（TIMEOUT），已被 reap 回收的跳过（回执已发）。 */
    char *correl0 = NULL;
    {
        cJSON *j = cJSON_Parse(m->data);
        if (j) {
            const cJSON *cv = cJSON_GetObjectItemCaseSensitive(j, "correl");
            if (cJSON_IsString(cv) && cv->valuestring)
                correl0 = strdup(cv->valuestring);
            cJSON_Delete(j);
        }
    }
    if (!ctl_claim(rt, correl0)) {
        free(correl0);
        return;
    }

    JSValue cmd = JS_ParseJSON(ctx, m->data, m->len, "<control-cmd>");
    if (JS_IsException(cmd)) {
        JS_FreeValue(ctx, cmd);
        ctl_error_receipt(rt, ctx, correl0, "bad json", "BAD_REQUEST");
        return;
    }

    JSValue opv = JS_GetPropertyStr(ctx, cmd, "op");
    const char *op = JS_ToCString(ctx, opv);
    JS_FreeValue(ctx, opv);

    if (op && strcmp(op, "eval") == 0) {
        ctl_eval(rt, ctx, cmd, correl0);
        correl0 = NULL;         /* correl 已被回执吞掉 */
    } else if (op && strcmp(op, "inspect") == 0) {
        ctl_inspect(rt, ctx, cmd, correl0);
        correl0 = NULL;
    } else if (op && strcmp(op, "metrics") == 0) {
        ctl_metrics(rt, ctx, correl0);
        correl0 = NULL;
    } else if (op && strcmp(op, "interrupt") == 0) {
        /* 标志已在 qz_control（生产者线程）置位并会在引擎指令边界触发；
         * 此处只回执（§3.9 投递即生效）。 */
        JSValue r = ctl_receipt_obj(ctx, correl0, 1);
        correl0 = NULL;
        JS_SetPropertyStr(ctx, r, "interrupted", JS_TRUE);
        ctl_send_receipt(rt, ctx, r);
    } else {
        /* 未知 op（含 IDLE_SAFEPOINT 类——CTL-0 不执行，§6 范围外） */
        ctl_error_receipt(rt, ctx, correl0, op ? op : "missing op",
                          "UNKNOWN_CMD");
        correl0 = NULL;
    }

    if (op) JS_FreeCString(ctx, op);
    free(correl0);
    JS_FreeValue(ctx, cmd);
}

#ifdef QZ_USE_MOCK_LIBUV
/* ── CTL-2 端点的 mock stub ──
 * 端点实现（control_endpoint.c）用 uv_pipe/uv_accept/SO_PEERCRED，mock 构建
 * 不编入；mock 下 LOCAL 档退化为 IN_PROC（命令仍可用，无外部端点）。 */
int qz_ctl_endpoint_init(qz_t *rt) { (void)rt; return -1; }
void qz_ctl_endpoint_close(qz_t *rt) { (void)rt; }
int qz_ctl_endpoint_owns(qz_t *rt, void *h) { (void)rt; (void)h; return 0; }
void qz_ctl_conn_write(void *conn, const char *json, size_t len)
{
    (void)conn; (void)json; (void)len;
}
#endif
