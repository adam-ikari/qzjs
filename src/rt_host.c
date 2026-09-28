/*
 * qzjs Host-side main-RT channel backend (M-P2, QZ_PROCESS_MODEL=ISOLATED)
 *
 * 宿主进程侧实现：qz_create 内部 spawn 主RT 进程（qzjs-rt --qzjs-rt-server）
 * 并完成 M-P1 握手 + CONTROL{ready} 同步读取；此后宿主与主RT 之间只有一条
 * uv_pipe 通道（socketpair）。宿主 C API 的签名与线程后端逐一对应：
 *
 *   qz_post_message  → 宿主入站 FIFO（MPSC，宿主线程推）→ 泵 loop 时装信封写通道
 *   message_cb       → 通道读泵解信封 → 回调解出 payload（JSON 文本）
 *   qz_wait_idle     → 发 CONTROL{idle} → 主RT 排空后回 ack 并自身退出 → 拆除
 *   qz_destroy       → 三级终止（§9.2）→ 收尸 → 拆除 → 释放
 *
 * 线程模型（用户裁决，翻转 M-P2 原「库自带宿主 loop 线程」设计）：库在宿主
 * 侧**不自带线程、不自带 loop**——全部通道句柄（pipe 读泵、tx spill timer、
 * wake async）挂在宿主注入的 cfg->uv_loop（RT_LOOP 取环）上，message_cb 跑
 * 在泵该 loop 的宿主线程。阻塞 API（ping/wait_idle/destroy）等待期间就地
 * NOWAIT 泵该 loop：message_cb 可能在阻塞调用内部重入触发；message_cb 内
 * 不得再调阻塞宿主 API。库绝不以 DEFAULT 模式跑、也绝不 close 宿主 loop。
 *
 * Design: docs/plans/2026-09-04-multi-process-model.md §3.3, §6, §9.2, M-P2.
 */

#include "qz_internal.h"
#include "ipc_process.h"
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdio.h>
#include <errno.h>
#include <sched.h>
#include <cJSON.h>

/* ── 就地泵宿主 loop（等待阻塞标志时用）──
 * 无库侧宿主线程后，「等某标志被读泵回填」的自旋必须自己推进 loop：
 * NOWAIT 处理已就绪事件（pipe 帧、spill timer、wake async）即返回，
 * 未命中再 sched_yield 让位（与原线程后端自旋的 CPU 形态一致）。
 * 绝不用 UV_RUN_DEFAULT——loop 属宿主。 */
static void host_pump(qz_t *rt)
{
    uv_run(rt->host_loop, UV_RUN_NOWAIT);
    sched_yield();
}

/* ── 跨层 liveness ping/pong（宿主→树中任意 worker，§8.2 path 寻址）──
 *
 * payload 格式（PING）：{"qzjs":1,"ping":N,"tp":[...]}——"tp" = root-relative
 * 槽位链（与命令面 target_path 同一 §8.2 范式）；PONG 回显 "tp" 作过境标记：
 * 中间节点读泵见 tp 沿父通道上行转发（corr 保持），不吃进自身 ping_seq/pong_seq
 * 配对槽；转发失败回 {"qzjs":1,"pfail":1,"corr":N}，宿主快速 -1。 */

int qz_ping_path(qz_t *rt, const int32_t *path, int path_len,
                   int32_t timeout_ms)
{
    if (!rt || rt->magic != QZ_MAGIC || !path || path_len <= 0 ||
        path_len > QZ_SELF_PATH_MAX)
        return -1;
    if (!rt->proc || rt->proc->state != QZ_PROC_RUN) return -1;
    if (__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE)) return -1;

    /* 组 PING payload：{"qzjs":1,"ping":seq,"tp":[p0,p1,...]}。corr 复用
     * §4.1 既定槽位（同 qz_ping），tp 是 payload 扩展字段——信封 schema
     * 零改动。tp[0] 作信封 target（根的直接子槽位，N-P3 同款）。 */
    int32_t seq = __atomic_add_fetch(&rt->ping_seq, 1, __ATOMIC_ACQ_REL);
    char msg[64];
    int off = snprintf(msg, sizeof msg, "{\"qzjs\":1,\"ping\":%d,\"tp\":[",
                       seq);
    if (off < 0 || off >= (int)sizeof msg) return -1;
    for (int i = 0; i < path_len; i++) {
        int n = snprintf(msg + off, (size_t)((int)sizeof msg - off),
                         "%s%d", i ? "," : "", path[i]);
        if (n < 0 || off + n >= (int)sizeof msg) return -1;
        off += n;
    }
    if (off + 2 >= (int)sizeof msg) return -1;
    msg[off++] = ']';
    msg[off++] = '}';
    msg[off] = '\0';

    if (qz_proc_post(rt->proc, QZ_IPC_HOST_ID, path[0],
                       IPC_ENV_KIND_CONTROL, seq,
                       (const uint8_t *)msg, (uint32_t)off) < 0)
        return -1;

    int64_t deadline = qz_now_ms() + timeout_ms;
    for (;;) {
        if (__atomic_load_n(&rt->pong_seq, __ATOMIC_ACQUIRE) >= seq)
            return 0;   /* deadline 内 PONG 命中 = 目标 loop 通畅 */
        if (__atomic_load_n(&rt->ping_fail, __ATOMIC_ACQUIRE) >= seq)
            return -1;  /* pfail：转发失败/路径不存在/通道死 */
        if (qz_now_ms() >= deadline) return 1;   /* 超时 = 目标 loop 阻塞 */
        if (__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE)) return -1;
        host_pump(rt);   /* PONG/pfail 经宿主 loop 读泵回填，须就地泵 */
    }
}


/* ── 初始脚本临时文件 ──
 * 与 M-P1 worker 脚本同机制：mkstemp 原子创建（无 TOCTOU），子进程读毕 unlink；
 * 本函数只负责写盘并交回路径，最后路径由调用方兜底 unlink（幂等）。 */
static char *host_write_blob(const void *data, size_t len)
{
    if (!data || !len) return NULL;

    char tmpl[] = "/tmp/qzjs-rt-script-XXXXXX";
    int fd = mkstemp(tmpl);
    if (fd < 0) return NULL;

    const char *p = (const char *)data;
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, p + off, len - off);
        if (n < 0) {
            if (errno == EINTR) continue;
            close(fd);
            unlink(tmpl);
            return NULL;
        }
        off += (size_t)n;
    }
    if (close(fd) != 0) {
        unlink(tmpl);
        return NULL;
    }
    return strdup(tmpl);
}

static char *host_write_script(const char *code)
{
    if (!code) return NULL;
    return host_write_blob(code, strlen(code));
}

/* ── 入站回调（宿主 loop 线程，读泵内）──
 * 信封解码结果 → 宿主语义：
 *   payload == NULL → 主RT 已退出/死亡（EOF，proc 已收尸）；
 *   kind == MESSAGE → message_cb；
 *   kind == CONTROL → M-P2 协议（idle ack）就地消化；其余 CONTROL
 *   （控制面回执等）同样交 message_cb，与线程后端一致。
 * READY 不在此列：create 期已由 qz_proc_wait_ready_raw 同步吃掉。 */
static void host_proc_msg_cb(void *user, int8_t kind, int32_t source,
                             int32_t corr,
                             const uint8_t *payload, uint32_t len)
{
    qz_t *rt = (qz_t *)user;
    QZ_UNUSED(source);
    QZ_UNUSED(corr);

    if (!payload) {
        /* 主RT 退出：宿主 loop 收束，wait_idle/destroy 的 join 随之返回。
         * 未 ready 即死 → ready_err（qz_create 显式失败，不静默降级 §5.3）。
         * M-P4 §9.3 崩溃检测：已 ready 且属非预期退出（既非 idle 自退 ack、
         * 又非宿主主动 shutdown）→ message_cb 收 {"type":"error",...}，宿主
         * 据此决定重启还是报错退出；qz_wait_idle 随之立即返回。 */
        int was_ready = __atomic_load_n(&rt->thread_ready, __ATOMIC_ACQUIRE);
        int expected = __atomic_load_n(&rt->idle_ack, __ATOMIC_ACQUIRE) ||
                       __atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE);
        if (!was_ready) {
            rt->ready_err = -1;
            __atomic_store_n(&rt->thread_ready, 1, __ATOMIC_RELEASE);
        }
        __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
        if (was_ready && !expected && rt->config.message_cb) {
            static const char *kExitErr =
                "{\"type\":\"error\",\"error\":\"main-runtime-process-exited-unexpectedly\"}";
            rt->config.message_cb(rt, kExitErr, strlen(kExitErr), rt->host_data);
        }
        return;
    }

    if (kind == IPC_ENV_KIND_CONTROL) {
        int val = 0;
        qz_ipc_ctl_kind_t k = qz_ipc_ctl_classify(payload, len, &val);
        if (k == QZ_IPC_CTL_IDLE && val == 1) {
            __atomic_store_n(&rt->idle_ack, 1, __ATOMIC_RELEASE);
            return;
        }
        if (k == QZ_IPC_CTL_PONG) {
            /* 读泵 C 层直回/树中继的 liveness 应答：跨层形态（带 tp）回填
             * pong_seq 供 qz_ping_path 配对——单跳 qz_ping 的 seq 与跨层
             * seq 同源单调，两 API 都按「pong_seq >= seq」判定，无需第二槽
             * 位。无 tp 的 PONG 不可能是过境帧（tp 只由 qz_ping_path 下
             * 发），语义不变。PONG 不进 message_cb。 */
            __atomic_store_n(&rt->pong_seq, (int32_t)corr, __ATOMIC_RELEASE);
            return;
        }
        if (k == QZ_IPC_CTL_PFAIL) {
            /* 中间节点转发失败回执（corr = 原始 seq）：qz_ping_path 快速
             * 判 -1（路径不存在/无对应子槽位），不白等 timeout。 */
            __atomic_store_n(&rt->ping_fail, (int32_t)corr, __ATOMIC_RELEASE);
            return;
        }
    }

    if (rt->config.message_cb) {
        /* 与 THREAD 后端（qz_msg_push 的 len+1 拷贝）同语义：message_cb 收到
         * NUL 终止的 JSON（len 不含终止符）。信封 payload 是 rbuf 视图，
         * 不可就地终止，做一次拷贝。 */
        char *copy = (char *)malloc((size_t)len + 1);
        if (!copy) return;
        memcpy(copy, payload, len);
        copy[len] = '\0';
        rt->config.message_cb(rt, copy, len, rt->host_data);
        free(copy);
    }
}

/* ── 出站唤醒（宿主 loop 线程）──
 * 排空宿主入站 FIFO → 装信封写通道。FIFO 有序性是 idle 协议的基础：CONTROL{idle}
 * 与宿主消息同队列同序，主RT 收到 idle 请求时其前面的宿主消息必然已入通道
 * （§6.1 的「未决写计数 W」由单通道有序性保证，无需显式计数）。 */
static void host_wake_cb(uv_async_t *a)
{
    qz_t *rt = (qz_t *)a->data;
    if (__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE)) return;

    qz_msg_t *m;
    while ((m = qz_msg_pop(rt)) != NULL) {
        if (!rt->proc) break;
        /* CTL-1：控制命令的信封 target 取自命令 JSON 的 "target" 字段
         * （缺省 1 = 主RT）。ISOLATED 下宿主只有到主RT 的一条通道，
         * target>1 由主RT 按本地槽位表下行（§2.2 逐跳相对寻址）。
         * 写失败（peer 已死/通道异常）不额外终止：读泵侧的 EOF 同样会
         * 收束本循环；线程后端的 post 也只是「入队即返回」。 */
        int32_t target = m->flags
                             ? qz_ctl_cmd_target(m->data, m->len)
                             : QZ_IPC_MAIN_ID;
        qz_proc_post(rt->proc, QZ_IPC_HOST_ID, target,
                       m->flags ? IPC_ENV_KIND_CONTROL : IPC_ENV_KIND_MESSAGE,
                       0,
                       (const uint8_t *)m->data, (uint32_t)m->len);
    }
}

/* ── 宿主侧拆除（wait_idle / destroy / create 失败共用，thread_joined 幂等）──
 * 无库侧线程后不再「通知线程退出 + join」，改为在调用线程上收束：
 *   shutting_down（host_wake_cb/qz_host_post 短路，EOF 路径同置此标志）
 *   → 关 wake → 三级终止主RT（§9.2；挂死主RT 最坏 ≤2s 冻结落在调用线程，
 *   I5 已知偏差的宿主侧形态）→ qz_proc_free（uv_close pipe+tx timer，proc
 *   内存在最后一个 close 回调里释放）→ 两轮 NOWAIT 排干收 close 回调。
 * 绝不 UV_RUN_DEFAULT / uv_loop_close——loop 属宿主。 */
static void host_teardown(qz_t *rt)
{
    if (__atomic_load_n(&rt->thread_joined, __ATOMIC_ACQUIRE)) return;

    __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
    if (rt->wake.loop && !uv_is_closing((uv_handle_t *)&rt->wake))
        uv_close((uv_handle_t *)&rt->wake, NULL);
    /* msgq 约定：pop 只释放上一个 head，最后被消费（或未消费）的节点恒挂
     * msg_head——与 qz_thread_teardown 步 1 同款收尾：排干入站队列并释放尾
     * 挂节点，否则最后一条 CONTROL{idle} 随 rt 一起漏出。消费线程即调用
     * 线程（宿主泵），shutting_down 已置，无并发消费者。 */
    qz_msg_t *m;
    while ((m = qz_msg_pop(rt)) != NULL) {}
    if (rt->msg_head != &rt->msg_stub) qz_msg_free(rt->msg_head);
    rt->msg_head = &rt->msg_stub;
    if (rt->proc) {
        qz_proc_terminate(rt->proc, QZ_IPC_TERMINATE_TIMEOUT_MS);
        qz_proc_free(rt->proc);
        rt->proc = NULL;
    }
    /* libuv 保证 uv_close 回调在下一轮 uv_run 内处理；两轮封顶。 */
    uv_run(rt->host_loop, UV_RUN_NOWAIT);
    uv_run(rt->host_loop, UV_RUN_NOWAIT);

    __atomic_store_n(&rt->thread_joined, 1, __ATOMIC_RELEASE);
}

int qz_host_start(qz_t *rt)
{
    /* 宿主注入 loop（M-P6 裁决）：ISOLATED 下缺失 = 显式失败，不降级（§5.3）。 */
    rt->host_loop = (uv_loop_t *)(uintptr_t)rt->config.uv_loop;
    rt->host_data = rt->config.host_data;
    if (!rt->host_loop) {
        fprintf(stderr,
                "qzjs: cfg->uv_loop must be a host-owned uv_loop_t under "
                "QZ_PROCESS_MODEL=ISOLATED (no library-owned host thread)\n");
        return -1;
    }

    char *tmp = host_write_script(rt->config.initial_script);
    if (rt->config.initial_script && !tmp)
        return -1;
    /* 字节码与脚本独立叠加（先脚本后字节码，同 qzjs.h 语义）：各自写
     * 临时文件，经 --script / --bytecode 传给主RT。 */
    char *bc_tmp = NULL;
    if (rt->config.initial_bytecode && rt->config.initial_bytecode_len) {
        bc_tmp = host_write_blob(rt->config.initial_bytecode,
                                 rt->config.initial_bytecode_len);
        if (!bc_tmp) {
            if (tmp) { unlink(tmp); free(tmp); }
            return -1;
        }
    }

    char fd_arg[16];
    snprintf(fd_arg, sizeof fd_arg, "%d", QZ_IPC_CHANNEL_FD);
    char *argv[16];
    int n = 0;
    argv[n++] = (char *)"qzjs-rt";
    argv[n++] = (char *)"--qzjs-rt-server";
    argv[n++] = (char *)"--parent-fd";
    argv[n++] = fd_arg;
    argv[n++] = (char *)"--worker-backend";
    argv[n++] = (char *)(rt->config.worker_backend == QZ_WORKER_BACKEND_PROCESS
                             ? "process" : "thread");
    if (tmp) {
        argv[n++] = (char *)"--script";
        argv[n++] = tmp;
    }
    if (bc_tmp) {
        argv[n++] = (char *)"--bytecode";
        argv[n++] = bc_tmp;
    }
    /* CTL-2：控制面档位 + 端点路径传给主RT（runtime 在主RT 进程；宿主进程
     * 只有通道桩，不监听端点）。argv 仅在 spawn 期间需要（同步 fork+exec）。 */
    if (rt->config.control_plane == QZ_CONTROL_IN_PROC ||
        rt->config.control_plane == QZ_CONTROL_LOCAL) {
        argv[n++] = (char *)"--control-plane";
        argv[n++] = (char *)(rt->config.control_plane == QZ_CONTROL_LOCAL
                                 ? "local" : "in-proc");
        if (rt->config.control_pipe_path) {
            argv[n++] = (char *)"--control-pipe";
            argv[n++] = (char *)rt->config.control_pipe_path;
        }
    }
    argv[n] = NULL;

    rt->proc = qz_proc_new();
    if (!rt->proc) {
        if (tmp) { unlink(tmp); free(tmp); }
        if (bc_tmp) { unlink(bc_tmp); free(bc_tmp); }
        return -1;
    }

    /* 伴随二进制 qzjs-rt 由 M-P1 的解析链定位（显式路径 → QZ_RT_SERVER →
     * /proc/self/exe 同目录 → 编译期 QZ_RT_PATH）；找不到 = 显式失败。 */
    int rc = qz_proc_spawn(rt, rt->proc, NULL, argv,
                             QZ_IPC_ROLE_MAIN, QZ_IPC_MAIN_ID, 1);
    if (tmp) { unlink(tmp); free(tmp); }     /* 子已读毕并 unlink；幂等兜底 */
    if (bc_tmp) { unlink(bc_tmp); free(bc_tmp); }
    if (rc != 0) {
        qz_proc_free(rt->proc);
        rt->proc = NULL;
        return -1;
    }

    /* ready 握手：主RT 的第一帧恒为 CONTROL{ready}（spawn 握手 ack 之后、
     * 进 server loop 之前发出）。在读泵注册之前用阻塞 raw-fd 帧读吃掉——
     * 不泵宿主 loop、不触发 message_cb，create 期间宿主 loop 完全归宿主。
     * ready:0 / EOF / 超时 / 协议错误 = 显式失败（§5.3，不静默降级）。 */
    int ready_ok = 0;
    int rw = qz_proc_wait_ready_raw(rt->proc,
                                      qz_now_ms() + QZ_IPC_HANDSHAKE_TIMEOUT_MS,
                                      &ready_ok);
    if (rw < 0 || !ready_ok) {
        fprintf(stderr, "qzjs: mainRT ready handshake failed (%s)\n",
                rw < 0 ? "read error / EOF / timeout" : "ready reported error");
        rt->ready_err = -1;
        host_teardown(rt);
        return -1;
    }
    __atomic_store_n(&rt->thread_ready, 1, __ATOMIC_RELEASE);

    /* 入站：信封 → host_proc_msg_cb（读泵跑在泵宿主 loop 的线程）。 */
    qz_proc_start_read_cb(rt->proc, host_proc_msg_cb, rt);

    rt->wake.data = rt;
    if (uv_async_init(rt->host_loop, &rt->wake, host_wake_cb) != 0) {
        rt->ready_err = -1;
        host_teardown(rt);
        return -1;
    }
    return 0;
}

int qz_host_post(qz_t *rt, const char *json, size_t len)
{
    if (!rt || rt->magic != QZ_MAGIC || !json) return -1;
    if (__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE)) return -1;
    int rc = qz_msg_push(rt, json, len, QZ_MSG_SRC_HOST, 0);
    if (rc == 0) uv_async_send(&rt->wake);
    return rc;
}

void qz_host_wait_idle(qz_t *rt)
{
    if (!rt || rt->magic != QZ_MAGIC) return;
    __atomic_store_n(&rt->wait_idle, 1, __ATOMIC_RELEASE);
    /* CONTROL{idle} 走同一 FIFO：排在所有已投递宿主消息之后。 */
    if (qz_msg_push(rt, QZ_IPC_CTL_IDLE_REQ,
                      strlen(QZ_IPC_CTL_IDLE_REQ),
                      QZ_MSG_SRC_HOST, 1) == 0)
        uv_async_send(&rt->wake);

    /* 阻塞至 ack 或 EOF（§6.1）。无库线程后由本调用就地泵宿主 loop：
     * host_wake_cb 排空 FIFO 把 idle 请求发出去、读泵收 ack/EOF 回填标志；
     * 崩溃 EOF 的 message_cb {"type":"error"} 上报也随之在本调用内触发
     * （CLI/宿主依赖此时序）。 */
    while (!__atomic_load_n(&rt->idle_ack, __ATOMIC_ACQUIRE) &&
           !__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE))
        host_pump(rt);
    host_teardown(rt);
}

/* ── Liveness ping（宿主→主RT,检测对端 uv loop 是否阻塞）──
 * 发 CONTROL{"qzjs":1,"ping":1}（corr = 单调 seq）→ 阻塞等待 PONG（对端
 * C 层读泵就地直回,不经 JS/msgq）→ 回显 seq 命中 = loop 通畅;deadline 内
 * 未命中 = 对端 loop 阻塞（或死亡——死亡另有 EOF 路径）。单飞行:同一 rt
 * 同时只有一个 ping 在途（宿主线程 API,线程不安全由调用方保证）。 */
int qz_ping(qz_t *rt, int32_t timeout_ms)
{
    if (!rt || rt->magic != QZ_MAGIC) return -1;
    if (!rt->proc || rt->proc->state != QZ_PROC_RUN) return -1;
    if (__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE)) return -1;

    int32_t seq = __atomic_add_fetch(&rt->ping_seq, 1, __ATOMIC_ACQ_REL);
    if (qz_proc_post(rt->proc, QZ_IPC_HOST_ID, QZ_IPC_MAIN_ID,
                       IPC_ENV_KIND_CONTROL, seq,
                       (const uint8_t *)QZ_IPC_CTL_PING_MSG,
                       (uint32_t)(sizeof QZ_IPC_CTL_PING_MSG - 1)) < 0)
        return -1;

    int64_t deadline = qz_now_ms() + timeout_ms;
    while (__atomic_load_n(&rt->pong_seq, __ATOMIC_ACQUIRE) < seq) {
        if (qz_now_ms() >= deadline) return 1;   /* 超时 = 对端 loop 阻塞 */
        if (__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE)) return -1;
        host_pump(rt);   /* PONG 经宿主 loop 读泵回填，须就地泵 */
    }
    return 0;   /* deadline 内 PONG 命中 = 对端 loop 通畅 */
}

void qz_host_destroy(qz_t *rt)
{
    if (!rt || rt->magic != QZ_MAGIC) return;
    host_teardown(rt);   /* 终止主RT + 收尸 + close 排干（幂等，wait_idle 已做则立即返回） */
    free((void *)rt->config.initial_script);
    free((void *)rt->config.initial_bytecode);
    free(rt);
}
