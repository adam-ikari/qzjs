/*
 * qzjs Host-side main-RT channel backend (M-P7, QZ_PROCESS_MODEL=ISOLATED)
 *
 * 宿主进程侧实现：qz_create 内部 spawn 主RT 进程（qzjs-rt --qzjs-rt-server），
 * 完成 M-P1 握手 + CONTROL{ready} raw-fd 同步读取，再起**库自有的宿主侧泵线
 * 程**跑 rt->loop。此后宿主与主RT 之间只有一条 uv_pipe 通道（socketpair），
 * 宿主与库之间只有一组入站 API + 一个 FIFO 邮箱——qzjs 不调用任何宿主代码：
 *
 *   qz_post_message  → 宿主入站 FIFO（MPSC，宿主线程推）→ 泵线程装信封写通道
 *   通道读泵解信封   → 出站消息入 rt->mq_out 邮箱 → 宿主 qz_recv_message 取
 *   qz_wait_idle     → 发 CONTROL{idle} → 主RT 排空后回 ack 并自身退出 → join 泵线程
 *   qz_destroy       → 唤泵线程自收主RT（§9.2 三级终止，≤2s 冻结在泵线程）→ join → 释放
 *
 * 线程模型（M-P7 主权裁决，翻转 M-P6 的 cfg.uv_loop 注入契约）：库完全自管
 * 线程与 loop——宿主侧句柄（pipe 读泵、tx spill timer、wake async）挂库内
 * rt->loop，由库泵线程独占泵；阻塞 API（ping/wait_idle/destroy）在调用线程
 * 自旋等泵线程回填的原子标志，绝不触碰 loop。主RT 挂死时三级终止的墙钟冻结
 * 落在**泵线程**（I5②：调用线程只等 join），宿主事件系统不受牵连。邮箱写入
 * 用 MPSC + eventfd（msgq.c），与泵线程无竞争。
 *
 * Design: docs/plans/2026-09-04-multi-process-model.md §3.3, §6, §9.2, M-P2/M-P7.
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
    /* 预算：前缀 ~27B + 8 槽位 ×6B（u16 最坏 5 位+逗号）+ 尾 2B ≈ 77B，
     * 64 会把合法深路径在 snprintf 守卫处误拒成 -1。 */
    char msg[128];
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
        /* PONG/pfail 由库泵线程的读泵回填；调用线程只自旋（M-P7：不泵环）。 */
        sched_yield();
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

/* ── 入站分发（泵线程，读泵内）──
 * 信封解码结果 → 宿主语义（全部入邮箱，库不调用任何宿主函数）：
 *   payload == NULL → 主RT 已退出/死亡（EOF，proc 已收尸）；
 *   kind == MESSAGE → 邮箱；
 *   kind == CONTROL → M-P2 协议（idle ack / pong / pfail）就地消化；其余
 *   CONTROL（控制面回执等）同样入邮箱，与线程后端一致。
 * READY 不在此列：create 期已由 qz_proc_wait_ready_raw 同步吃掉；pre-ready
 *   帧由 start_read_cb 重放路径入邮箱（qz_create 返回前即就位）。 */
static void host_proc_msg_cb(void *user, int8_t kind, int32_t source,
                             int32_t corr,
                             const uint8_t *payload, uint32_t len)
{
    qz_t *rt = (qz_t *)user;
    QZ_UNUSED(source);
    QZ_UNUSED(corr);

    if (!payload) {
        /* 主RT 退出：泵线程收束（DEAD 检测/flag），wait_idle/destroy 的
         * join 随之返回。未 ready 即死 → ready_err（qz_create 显式失败，
         * 不静默降级 §5.3）。
         * M-P4 §9.3 崩溃检测：已 ready 且属非预期退出（既非 idle 自退 ack、
         * 又非宿主主动 shutdown）→ 错误帧入邮箱，宿主 wait_idle 后首条
         * recv 即得。时序（G）：先入箱、后置 shutting_down——wait_idle 的
         * acquire 自旋退出时帧必然已在箱内。 */
        int was_ready = __atomic_load_n(&rt->thread_ready, __ATOMIC_ACQUIRE);
        int expected = __atomic_load_n(&rt->idle_ack, __ATOMIC_ACQUIRE) ||
                       __atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE);
        if (!was_ready) {
            rt->ready_err = -1;
            __atomic_store_n(&rt->thread_ready, 1, __ATOMIC_RELEASE);
        }
        if (was_ready && !expected) {
            static const char *kExitErr =
                "{\"type\":\"error\",\"error\":\"main-runtime-process-exited-unexpectedly\"}";
            qz_out_push(rt, kExitErr, strlen(kExitErr));
        }
        __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
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
             * 发），语义不变。PONG 不入邮箱。 */
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

    /* 与线程后端同语义的 payload 拷贝在 qz_out_push 内完成（len+1、NUL）。 */
    qz_out_push(rt, (const char *)payload, len);
}

/* ── 入站唤醒（泵线程）──
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

/* ── 库宿主侧泵线程（M-P2 形态回归）──
 * 只做通道 I/O（JS 在主RT 进程里跑）+ 出站入邮箱。退出路径上由本线程
 * 独占收束：三级终止主RT（§9.2，挂死主RT 的 ≤2s 墙钟冻结落在这里，调用
 * 线程只 join——I5② clause 复活）→ 关句柄 → 排干 close 回调 → 收 loop。 */
static void host_thread_main(void *arg)
{
    qz_t *rt = (qz_t *)arg;

    while (!__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE)) {
        uv_run(&rt->loop, UV_RUN_ONCE);
        if (__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE)) break;
        /* 主RT 退出（idle 自退 / 崩溃）→ 通道 EOF → proc DEAD → 泵线程收束。 */
        if (rt->proc && rt->proc->state == QZ_PROC_DEAD) {
            __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
            break;
        }
    }

    /* msgq 约定：pop 只释放上一个 head，最后被消费（或未消费）的节点恒挂
     * msg_head——排干入站队列并释放尾挂节点（否则最后一条 CONTROL{idle}
     * 随 rt 一起漏出）。本线程是入站 FIFO 的最后消费者，shutting_down 已置。 */
    qz_msg_t *m;
    while ((m = qz_msg_pop(rt)) != NULL) {}
    if (rt->msg_head != &rt->msg_stub) qz_msg_free(rt->msg_head);
    rt->msg_head = &rt->msg_stub;

    /* 主RT 若仍活着（destroy 路径）：三级终止（§9.2）——CONTROL{shutdown} →
     * 超时 → SIGKILL + waitpid 收尸。等价于线程后端的 join：destroy 阻塞到
     * 主RT 真正退出（最坏 = 终止超时），但冻结在本线程。 */
    if (rt->proc) {
        qz_proc_terminate(rt->proc, QZ_IPC_TERMINATE_TIMEOUT_MS);
        qz_proc_free(rt->proc);
        rt->proc = NULL;
    }
    if (!uv_is_closing((uv_handle_t *)&rt->wake))
        uv_close((uv_handle_t *)&rt->wake, NULL);
    uv_run(&rt->loop, UV_RUN_DEFAULT);   /* close 回调（含 proc reclaim）跑完 */
    uv_loop_close(&rt->loop);

    if (!__atomic_load_n(&rt->thread_ready, __ATOMIC_ACQUIRE)) {
        rt->ready_err = -1;
        __atomic_store_n(&rt->thread_ready, 1, __ATOMIC_RELEASE);
    }
}

/* 停泵线程并收尾（不释放 rt —— 调用方决定是 create 失败清理还是 destroy）。
 * thread_joined 幂等门：双 join 是 UB。 */
static void host_stop_thread(qz_t *rt)
{
    if (!__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE)) {
        __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
        uv_async_send(&rt->wake);
    }
    if (!__atomic_load_n(&rt->thread_joined, __ATOMIC_ACQUIRE)) {
        uv_thread_join(&rt->thread);
        __atomic_store_n(&rt->thread_joined, 1, __ATOMIC_RELEASE);
    }
}

int qz_host_start(qz_t *rt)
{
    /* loop 必须先 init：qz_proc_spawn 用 parent->loop 做 uv_pipe_init。 */
    if (uv_loop_init(&rt->loop) != 0) return -1;

    char *tmp = host_write_script(rt->config.initial_script);
    if (rt->config.initial_script && !tmp) {
        uv_loop_close(&rt->loop);
        return -1;
    }
    /* 字节码与脚本独立叠加（先脚本后字节码，同 qzjs.h 语义）：各自写
     * 临时文件，经 --script / --bytecode 传给主RT。 */
    char *bc_tmp = NULL;
    if (rt->config.initial_bytecode && rt->config.initial_bytecode_len) {
        bc_tmp = host_write_blob(rt->config.initial_bytecode,
                                 rt->config.initial_bytecode_len);
        if (!bc_tmp) {
            if (tmp) { unlink(tmp); free(tmp); }
            uv_loop_close(&rt->loop);
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
        uv_loop_close(&rt->loop);
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
        uv_loop_close(&rt->loop);
        return -1;
    }

    /* ready 握手：主RT 先 eval 初始脚本再 emit ready（rt_main.c），顶层
     * postMessage 帧可先于 CONTROL{ready} 落通道。在读泵注册之前用阻塞
     * raw-fd 帧读逐帧吃到 ready——ready 前的帧暂存（超上限 = 协议异常，
     * 显式失败 §5.3），随后由 start_read_cb 重放路径直接入邮箱（发生在
     * qz_create 返回前，仍在调用线程上；邮箱是 MPSC + fd 信号，与泵线程
     * 启动后的写入无竞争，也无需 wake async——pre-ready 重放不回发唤醒）。
     * ready:0 / EOF / 超时 / 解码失败 = 显式失败（§5.3，不静默降级）。 */
    int ready_ok = 0;
    int rw = qz_proc_wait_ready_raw(rt->proc,
                                      qz_now_ms() + QZ_IPC_HANDSHAKE_TIMEOUT_MS,
                                      &ready_ok);
    if (rw < 0 || !ready_ok) {
        fprintf(stderr, "qzjs: mainRT ready handshake failed (%s)\n",
                rw < 0 ? "read error / EOF / timeout" : "ready reported error");
        rt->ready_err = -1;
        if (rt->proc) { qz_proc_free(rt->proc); rt->proc = NULL; }
        uv_run(&rt->loop, UV_RUN_DEFAULT);
        uv_loop_close(&rt->loop);
        return -1;
    }
    __atomic_store_n(&rt->thread_ready, 1, __ATOMIC_RELEASE);

    /* wake 必须先于 start_read_cb 初始化（H1 不变量，M-P6 教训保留）：
     * start_read_cb 注册读泵后立即同步重放 pre-ready 帧——重放消息若触发
     * 任何 uv 路径或后续调用方 post，wake 未 init（loop==NULL）即空指针
     * 崩溃；泵线程启动同样以 wake 就绪为前提。 */
    rt->wake.data = rt;
    if (uv_async_init(&rt->loop, &rt->wake, host_wake_cb) != 0) {
        rt->ready_err = -1;
        if (rt->proc) { qz_proc_free(rt->proc); rt->proc = NULL; }
        uv_run(&rt->loop, UV_RUN_DEFAULT);
        uv_loop_close(&rt->loop);
        return -1;
    }

    /* 入站：信封 → host_proc_msg_cb（读泵在库泵线程）+ pre-ready 帧同步
     * 重放入邮箱（见上）。 */
    qz_proc_start_read_cb(rt->proc, host_proc_msg_cb, rt);

    if (uv_thread_create(&rt->thread, host_thread_main, rt) != 0) {
        rt->ready_err = -1;
        __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
        if (rt->proc) { qz_proc_free(rt->proc); rt->proc = NULL; }
        if (!uv_is_closing((uv_handle_t *)&rt->wake))
            uv_close((uv_handle_t *)&rt->wake, NULL);
        uv_run(&rt->loop, UV_RUN_DEFAULT);
        uv_loop_close(&rt->loop);
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
    /* 幂等：已拆除（wait_idle 二次调用/destroy 之后）绝不再 push——
     * wake 已 close 且回调已跑（loop==NULL），uv_async_send 即 UB。 */
    if (__atomic_load_n(&rt->thread_joined, __ATOMIC_ACQUIRE)) return;
    __atomic_store_n(&rt->wait_idle, 1, __ATOMIC_RELEASE);
    /* CONTROL{idle} 走同一 FIFO：排在所有已投递宿主消息之后。 */
    if (qz_msg_push(rt, QZ_IPC_CTL_IDLE_REQ,
                      strlen(QZ_IPC_CTL_IDLE_REQ),
                      QZ_MSG_SRC_HOST, 1) == 0)
        uv_async_send(&rt->wake);

    /* 阻塞至 ack 或 EOF（§6.1），再 join：主RT 排空后回 ack 并自身退出，
     * 泵线程见 EOF/DEAD 收束 → join 返回（对应线程后端 join RT 线程）。
     * 崩溃 EOF 的错误帧先于 shutting_down 入箱（host_proc_msg_cb 时序 G），
     * 自旋退出时帧必然已在邮箱——wait_idle 返回后、free 前 recv 即得。 */
    while (!__atomic_load_n(&rt->idle_ack, __ATOMIC_ACQUIRE) &&
           !__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE))
        sched_yield();
    uv_thread_join(&rt->thread);
    __atomic_store_n(&rt->thread_joined, 1, __ATOMIC_RELEASE);
}

/* ── Liveness ping（宿主→主RT，检测对端 uv loop 是否阻塞）──
 * 发 CONTROL{"qzjs":1,"ping":1}（corr = 单调 seq）→ 自旋等待 PONG（对端
 * C 层读泵就地直回,不经 JS/msgq；回填由库泵线程完成）→ 回显 seq 命中 =
 * loop 通畅;deadline 内未命中 = 对端 loop 阻塞（或死亡——死亡另有 EOF
 * 路径）。单飞行:同一 rt 同时只有一个 ping 在途（宿主线程 API,线程不安全
 * 由调用方保证）。 */
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
        sched_yield();
    }
    return 0;   /* deadline 内 PONG 命中 = 对端 loop 通畅 */
}

void qz_host_destroy(qz_t *rt)
{
    if (!rt || rt->magic != QZ_MAGIC) return;
    host_stop_thread(rt);   /* 主RT 终止+收尸在泵线程内完成，这里只 join */
    qz_mailbox_teardown(rt);
    free((void *)rt->config.initial_script);
    free((void *)rt->config.initial_bytecode);
    free(rt);
}
