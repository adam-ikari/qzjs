/*
 * qzjs-rt — standalone child-process binary for the multi-process model.
 *
 * 两种形态（由 argv 选择）：
 *   1) worker 进程（M-P1）：--qzjs-worker --parent-fd N --worker-id K [--script PATH]
 *      worker 自己的 JSRuntime + worker-boot 垫片，服务一个 worker JS。
 *   2) 主RT 进程（M-P2）：--qzjs-rt-server --parent-fd N [--script PATH]
 *                            [--worker-backend 0|1]
 *      父运行时语义（无 worker_self）：跑宿主 initial_script，与宿主一条 IPC
 *      通道（信封 payload = JSON 文本；宿主 post_message 的 json 原样透传）；
 *      自身可经 JS 层 spawn worker 进程（树形拓扑的主RT 层，§1.1）。
 *
 * Lifecycle:
 *   1. Parse argv
 *   2. Handshake on raw parent-fd (child sends first, waits for ack, 5s)
 *   3. Init qz_t (loop + wake + runtime + polyfill)
 *   4. uv_pipe_open(parent-fd) + uv_read_start (frame accumulator → msgq)
 *   5. worker: eval worker boot bytecode + script / server: eval initial script,
 *      然后回 CONTROL{ready}（宿主 qz_create 据此判定成功）
 *   6. Main loop (uv_run(ONCE) + flush microtasks; server 形态含 idle 检测)
 *   7. EOF on parent-fd → shutting_down → teardown → exit(0)
 *
 * Design: docs/plans/2026-09-04-multi-process-model.md §5, §6.2, §9.2, M-P1/M-P2.
 */

#include "qz_internal.h"
#include "ipc_process.h"
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdio.h>
#include <poll.h>
#include <errno.h>
#include <cJSON.h>
#include <sys/socket.h>   /* recv：M-P4 同步 storage RPC 的 poll/recv 等待 */

/* ── Pipe read state (one pipe per child process — static is fine) ── */

static uv_pipe_t g_parent_pipe;

static struct {
    uint8_t *buf;       /* accumulation buffer */
    size_t   cap;
    size_t   len;       /* bytes accumulated so far */
    uint32_t frame_len; /* expected frame body length (0 = need 4-byte hdr) */
} g_rx;

/* Hand-rolled substring match — replaces glibc memmem, a GNU extension that
 * would force _GNU_SOURCE (violates the project's C99 discipline). */
static int has_substring(const uint8_t *hay, size_t hlen, const char *needle)
{
    size_t nlen = strlen(needle);
    if (nlen == 0 || nlen > hlen) return 0;
    for (size_t i = 0; i + nlen <= hlen; i++) {
        if (memcmp(hay + i, needle, nlen) == 0) return 1;
    }
    return 0;
}


/* ── Wake callback: drain msgq and dispatch ──
 * worker 形态走 qz_worker_dispatch（worker-boot 垫片语义）；主RT 形态（M-P2）
 * 走 qz_dispatch_message + 逐条微任务冲刷——与 thread.c 的 qz_wake_cb 完全
 * 同构（宿主消息即主 runtime 的 onmessage）。 */

static int g_server_mode;   /* 1 = --qzjs-rt-server（主RT 进程，M-P2） */
static int32_t g_local_id;  /* CTL-1：本节点槽位 id（主RT=1 / worker=--worker-id） */

static void process_rx(qz_t *rt);   /* 帧累加器解码；child_storage_sync 在其前定义 */

static void child_wake_cb(uv_async_t *a)
{
    qz_t *rt = (qz_t *)a->data;
    if (__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE)) return;
    qz_msg_t *m;
    while ((m = qz_msg_pop(rt)) != NULL) {
        /* CONTROL（flags==1）→ control dispatch；其余（含 PORT_TRANSFER 的
         * flags==2）走运行时的应用消息派发，kind 作为第三参交给 JS。 */
        if (m->flags == QZ_MSG_FLAG_CONTROL) {
            qz_control_dispatch(rt, m);
        } else if (g_server_mode) {
            qz_dispatch_message(rt, m);
            qz_flush_microtasks(rt);
        } else {
            qz_worker_dispatch(rt, m);
        }
    }
}

/* ── 主RT 形态：宿主边界出站（§6.2）──
 * bridge.c / control.c 的出站路径走 qz_post_to_host 漏斗，主RT 子进程把
 * rt->host_emit 挂成本函数（JSON 文本），装成 MESSAGE 信封上行给宿主。
 * 跑在 JS 线程 = loop 线程，tx 写路径单线程独占。 */
static void server_emit_cb(qz_t *rt, const char *json, size_t len)
{
    QZ_UNUSED(rt);
    qz_ipc_child_emit(QZ_IPC_MAIN_ID, QZ_IPC_HOST_ID,
                        IPC_ENV_KIND_MESSAGE,
                        0,
                        (const uint8_t *)json, (uint32_t)len);
}

/* 主RT 形态的 CONTROL 分流（§6.1）：M-P2 协议消息在管道读路径就地消化；
 * 其余 CONTROL（控制面消息等）照 worker 形态推入 msgq flags=1。 */
static void server_handle_control(qz_t *rt, const ipc_envelope_view_t *view)
{
    int val = 0;
    qz_ipc_ctl_kind_t kind =
        qz_ipc_ctl_classify(view->payload, view->payload_len, &val);
    if (kind == QZ_IPC_CTL_IDLE && val == 0) {
        /* 宿主请求 idle：置标志，主循环在排空后回 ack 并自身退出。 */
        __atomic_store_n(&rt->wait_idle, 1, __ATOMIC_RELEASE);
        uv_async_send(&rt->wake);
    }
    /* READY / IDLE ack / SHUTDOWN 由宿主→主RT 方向不出现；shutdown 的两种
     * payload 形态（{"qzjs":1,"shutdown":1} 与 M-P1 的 {"cmd":"shutdown"}）统一
     * 在下方 substring 判定里处理。 */
}

/* ── M-P4 同步 storage RPC（§10.2 单所有者代理的传输半边）──
 * worker 进程的 localStorage 代理调用 pal.storageSync → 本函数：发一条
 * kind=STORAGE 信封上行（target=父，主RT 所有者），然后在**不跑 uv_run**
 * 的前提下 poll/recv 驱动管道读。帧照常进 g_rx 累加器（process_rx 统一
 * 处理：STORAGE 回复捕获；其它帧 push msgq——wake 的 uv_async 挂起标志
 * 仍在，主循环下一个 uv_run 会派发它们，不丢帧）。等待期间无 uv_run →
 * 无 timer/async 回调 → 无 JS 重入，同步 API 语义不被破坏。
 * 父进程死亡（fd EOF/POLLHUP）→ 置 shutting_down 走 §9.4 孤儿自杀路径，
 * 返回 -1（JS 抛错；worker 随之退出，连锁死亡是预期行为）。
 * 本节点自身请求单飞行（JS 同步调用期间无并发）——但父通道上的 STORAGE
 * 帧不必然是本节点回复：子树中继请求（storage_relays）与自身请求可同时在
 * 途。每个出站请求分配唯一 corr（rt->storage_corr_seq），回复按 corr 配对
 * （g_sync_corr = 自身在途请求的 corr），不再靠到达序。 */
static int g_sync_waiting = 0;
static int g_sync_done = 0;
static int g_sync_err = 0;
static int32_t g_sync_corr = 0;   /* 自身在途同步请求的关联 id（0 = 无） */
static uint8_t *g_sync_reply = NULL;
static uint32_t g_sync_reply_len = 0;

static int child_storage_sync(qz_t *rt, const uint8_t *payload,
                              uint32_t payload_len,
                              uint8_t **out_reply, uint32_t *out_reply_len)
{
    qz_worker_t *w = (qz_worker_t *)rt->worker_self;
    int fd = qz_ipc_child_channel();
    *out_reply = NULL;
    *out_reply_len = 0;
    if (!w || fd < 0) return -1;
    /* 阻塞发送整帧（含 FIFO 排空 spill buffer）：大 payload（quota 内可达
     * ~5MB）远超 socket 缓冲，poll(POLLOUT) 等待父侧排空；父死 → -1。 */
    int32_t corr;
    do { corr = ++rt->storage_corr_seq; } while (corr == 0);
    if (qz_ipc_child_emit_sync((int32_t)w->id, 0, IPC_ENV_KIND_STORAGE,
                                 corr,
                                 payload, payload_len) != 0)
        return -1;

    g_sync_corr = corr;
    g_sync_waiting = 1;
    g_sync_done = 0;
    g_sync_err = 0;
    g_sync_reply = NULL;
    g_sync_reply_len = 0;

    for (;;) {
        if (__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE)) break;
        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        int pr = poll(&pfd, 1, 200);   /* 200ms 节拍复查 shutting_down */
        if (pr < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (pr == 0) continue;
        if (pfd.revents & (POLLIN | POLLHUP | POLLERR)) {
            uint8_t tmp[QZ_IPC_READ_BUF_SIZE];
            ssize_t n = recv(fd, tmp, sizeof tmp, 0);
            if (n == 0) {
                /* EOF：父进程死亡 → §9.4 孤儿自杀 */
                __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
                uv_async_send(&rt->wake);
                break;
            }
            if (n < 0) {
                if (errno == EINTR || errno == EAGAIN) continue;
                if (errno == ECONNRESET) {
                    __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
                    uv_async_send(&rt->wake);
                }
                break;
            }
            /* 喂累加器 → process_rx 统一帧处理（回复捕获 / msgq push） */
            size_t need = g_rx.len + (size_t)n;
            if (need > g_rx.cap) {
                size_t ncap = g_rx.cap ? g_rx.cap : 4096;
                while (ncap < need) ncap *= 2;
                uint8_t *nb = (uint8_t *)realloc(g_rx.buf, ncap);
                if (!nb) break;   /* OOM：按失败返回 */
                g_rx.buf = nb;
                g_rx.cap = ncap;
            }
            memcpy(g_rx.buf + g_rx.len, tmp, (size_t)n);
            g_rx.len += (size_t)n;
            process_rx(rt);
            if (g_sync_done) break;
        }
    }

    g_sync_waiting = 0;
    if (g_sync_done && !g_sync_err && g_sync_reply) {
        *out_reply = g_sync_reply;
        *out_reply_len = g_sync_reply_len;
        g_sync_reply = NULL;
        return 0;
    }
    free(g_sync_reply);
    g_sync_reply = NULL;
    return -1;
}

/* ── Pipe read: frame accumulator → envelope decode → msgq push ── */

static void pipe_alloc_cb(uv_handle_t *h, size_t suggested, uv_buf_t *buf)
{
    (void)h; (void)suggested;
    /* Allocate a fixed chunk; libuv reuses it per read */
    buf->base = (char *)malloc(QZ_IPC_READ_BUF_SIZE);
    buf->len = buf->base ? QZ_IPC_READ_BUF_SIZE : 0;
}

/* ── 跨层 liveness ping（§8.2 path 寻址，宿主→任意 worker）──
 * PING 过境下投：payload 字节零改写（"tp" 保留作回程过境标记），corr 保持；
 * 下一跳 = 链上第 self_path_len+1 个元素（本节点深度即已走跳数）。无对应
 * 子槽位/写失败 → 回 pfail（corr=seq）沿上行直接回宿主，不白等。 */
static void ping_forward_down(qz_t *rt, int32_t source, int32_t child_slot,
                              int32_t corr, const uint8_t *payload,
                              uint32_t len)
{
    for (int i = 0; i < QZ_MAX_PROC_HANDLES; i++) {
        qz_proc_handle_t *h = &rt->proc_handles[i];
        if (h->live && h->proc && h->proc->id == (int)child_slot) {
            if (qz_proc_post(h->proc, source, child_slot,
                               IPC_ENV_KIND_CONTROL, corr,
                               payload, len) == 0)
                return;
            break;
        }
    }
    char msg[48];
    int n = snprintf(msg, sizeof msg, QZ_IPC_CTL_PFAIL_FMT, corr);
    if (n > 0 && n < (int)sizeof msg)
        qz_ipc_child_emit(g_local_id, QZ_IPC_HOST_ID,
                            IPC_ENV_KIND_CONTROL, corr,
                            (const uint8_t *)msg, (uint32_t)n);
}

/* Process accumulated bytes: extract complete frames, decode, push to msgq */
static void process_rx(qz_t *rt)
{
    for (;;) {
        if (g_rx.frame_len == 0) {
            /* Need 4-byte header */
            if (g_rx.len < 4) return;
            g_rx.frame_len = ((uint32_t)g_rx.buf[0]) |
                             ((uint32_t)g_rx.buf[1] << 8) |
                             ((uint32_t)g_rx.buf[2] << 16) |
                             ((uint32_t)g_rx.buf[3] << 24);
            /* Consume header */
            g_rx.len -= 4;
            if (g_rx.len > 0)
                memmove(g_rx.buf, g_rx.buf + 4, g_rx.len);
            if (g_rx.frame_len > 16u * 1024 * 1024) {
                /* Oversized frame — protocol error, self-terminate. Wake the
                 * loop: uv_run(ONCE) may be blocked in pipe poll (I2). */
                __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
                uv_async_send(&rt->wake);
                return;
            }

        }
        /* Need frame body */
        if (g_rx.len < g_rx.frame_len) return;

        /* Complete frame available */
        if (g_rx.frame_len > 0) {
            ipc_envelope_view_t view;
            if (ipc_envelope_decode(g_rx.buf, g_rx.frame_len, &view) == 0) {
                int is_ctl = (view.kind == IPC_ENV_KIND_CONTROL);
                int ctl_val = 0;    /* CTL-1：CONTROL 命令类判定 */
                if (is_ctl && g_server_mode)
                    server_handle_control(rt, &view);
                /* Liveness ping（{"qzjs":1,"ping":1}）：读回调 C 层就地直回
                 * PONG（corr = ping seq 原样回显），不经 msgq/JS——pong 延迟
                 * 反映 uv loop 健康度（loop 阻塞在读回调 poll 里就回不了）。
                 * 跨层形态（带 "tp"，宿主→任意 worker）：本节点非目的地时
                 * 按链下投（读回调转发，不消费），仅目的地直回。 */
                if (is_ctl && view.payload_len > 0 &&
                    qz_ipc_ctl_classify(view.payload, view.payload_len,
                                          &ctl_val) == QZ_IPC_CTL_PING) {
                    int32_t tp[QZ_SELF_PATH_MAX];
                    int tpn = qz_ipc_ping_tp(view.payload, view.payload_len,
                                               tp, QZ_SELF_PATH_MAX);
                    int hop = (int)rt->self_path_len;   /* 深度 = 已走跳数 */
                    if (tpn > hop) {
                        /* 过境：tp[hop] 是本节点的下投子槽位（根=宿主直发
                         * 主RT 时 self_path 空，tp[0] 即子槽位）。 */
                        ping_forward_down(rt, view.source, tp[hop],
                                          view.corr, view.payload,
                                          view.payload_len);
                    } else if (tpn > 0) {
                        /* 跨层目的地（本节点深度 == 链长）：直回 PONG 并
                         * 回显 "tp" 作过境标记——中间节点读回调凭 tp 识别
                         * 上行中继（corr 保持）。（不经 JS/msgq：pong 延迟
                         * 反映本节点 uv loop 健康度。） */
                        char msg[160];
                        int off = snprintf(msg, sizeof msg,
                                           "{\"qzjs\":1,\"pong\":1,\"tp\":[");
                        int ok = off > 0 && off < (int)sizeof msg;
                        for (int i = 0; ok && i < tpn; i++) {
                            int n = snprintf(msg + off,
                                             (size_t)((int)sizeof msg - off),
                                             "%s%d", i ? "," : "", tp[i]);
                            if (n < 0 || off + n >= (int)sizeof msg) ok = 0;
                            else off += n;
                        }
                        if (ok) {
                            msg[off++] = ']';
                            msg[off++] = '}';
                            qz_ipc_child_emit(g_local_id, QZ_IPC_HOST_ID,
                                                IPC_ENV_KIND_CONTROL,
                                                view.corr,
                                                (const uint8_t *)msg,
                                                (uint32_t)off);
                        }
                    } else {
                        /* 单跳目的地（无 tp 的 qz_ping）：原样直回。 */
                        qz_ipc_child_emit(g_local_id, QZ_IPC_HOST_ID,
                                            IPC_ENV_KIND_CONTROL,
                                            view.corr,
                                            (const uint8_t *)QZ_IPC_CTL_PONG_MSG,
                                            (uint32_t)(sizeof QZ_IPC_CTL_PONG_MSG
                                                       - 1));
                    }
                } else {
                    int pong_val = 0;
                    qz_ipc_ctl_kind_t ck =
                        qz_ipc_ctl_classify(view.payload, view.payload_len,
                                              &pong_val);
                    /* 跨层 PONG/pfail 过境（宿主 ping_path 发起的帧沿上行回
                     * 来）：沿父通道转发给宿主（corr/payload 保持）。本节点
                     * 自身的单跳 PONG 不会到达这里——那类帧已在子通道读回调
                     * （proc_process_rx）按 pong_seq 槽拦截。 */
                    if (ck == QZ_IPC_CTL_PONG || ck == QZ_IPC_CTL_PFAIL) {
                        qz_ipc_child_emit(g_local_id, QZ_IPC_HOST_ID,
                                            IPC_ENV_KIND_CONTROL,
                                            view.corr,
                                            view.payload,
                                            view.payload_len);
                    }
                }
                /* CONTROL{shutdown} → graceful exit (§9.2 tier 1)。两种 payload
                 * 形态都认：M-P2 的 {"qzjs":1,"shutdown":1} 与 M-P1 三级终止
                 * tier-1 的 {"cmd":"shutdown"}（qz_proc_terminate 发出）。 */
                if (is_ctl && view.payload_len > 0 &&
                    has_substring(view.payload, view.payload_len, "shutdown")) {
                    __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
                    uv_async_send(&rt->wake);
                } else if (view.kind == IPC_ENV_KIND_STORAGE) {
                    /* M-P4 §10.2：父通道上的 STORAGE 帧 = 本节点自己同步 RPC
                     * 的回复（corr == g_sync_corr）或子树中继请求的回复（corr
                     * 命中 storage_relays → 按登记下投发起子进程）。两者都匹配
                     * 不到 = 协议外（所有者从不主动发起），丢弃。所有者（主RT）
                     * 侧的请求帧不经过本管道——worker 通道是 proc 句柄读回调，
                     * JS 层 processOnMessage 按 kind=4 分流（worker.js）。 */
                    if (g_sync_waiting && view.corr == g_sync_corr) {
                        g_sync_reply = (uint8_t *)malloc(view.payload_len);
                        if (g_sync_reply || view.payload_len == 0) {
                            if (view.payload_len > 0)
                                memcpy(g_sync_reply, view.payload,
                                       view.payload_len);
                            g_sync_reply_len = view.payload_len;
                        } else {
                            g_sync_err = 1;   /* OOM：等待方按失败返回 */
                        }
                        g_sync_done = 1;
                    } else {
                        /* N-P4：本节点是中继 —— owner（根）的回复按 corr 配对
                         * 下投；转发帧把下行 corr（发起子进程帧携带的原值）带回，
                         * 让子进程侧按它匹配自己的同步等待。 */
                        for (int i = 0; i < QZ_MAX_PROC_HANDLES; i++) {
                            if (rt->storage_relays[i].up_corr != view.corr)
                                continue;
                            for (int j = 0; j < QZ_MAX_PROC_HANDLES; j++) {
                                qz_proc_handle_t *h = &rt->proc_handles[j];
                                if (h->live && h->proc &&
                                    h->proc->id == rt->storage_relays[i].child) {
                                    qz_proc_post(h->proc, g_local_id,
                                                   rt->storage_relays[i].child,
                                                   IPC_ENV_KIND_STORAGE,
                                                   rt->storage_relays[i].down_corr,
                                                   view.payload,
                                                   view.payload_len);
                                    break;
                                }
                            }
                            rt->storage_relays[i].up_corr = 0;  /* 释放槽 */
                            break;
                        }
                    }
                }
                else if (is_ctl) {
                    /* classify 一次定去向（同一 payload 调两次 = 两次 cJSON
                     * 解析，且两个分支的条件一旦各自演进就会互相矛盾——
                     * 上次就是「双调用 + 谓词过宽」让 M-P7 的门形同虚设）。 */
                    qz_ipc_ctl_kind_t ck2 =
                        qz_ipc_ctl_classify(view.payload, view.payload_len,
                                            &ctl_val);
                    if (ck2 == QZ_IPC_CTL_NONE) {
                        /* CTL-1（§2.2）：命令类 CONTROL 信封在本节点树路由——命中
                         * 本地则入 msgq（flags=CONTROL）交 dispatch，否则逐跳向上/
                         * 向下转发。系统级 CONTROL 已由上方分支消化，不受影响。 */
                        qz_control_route(rt, g_local_id, view.source,
                                         view.target, view.payload,
                                         view.payload_len);
                    } else if (ck2 == QZ_IPC_CTL_SYSTEM) {
                        /* 带 "qzjs" 数字标记但不在已知系统家族内（M-P4 closing
                         * 等）：通道 C 层就地消费，不入 msgq/JS，否则控制面会
                         * 当命令回 UNKNOWN_CMD 回执泄漏进宿主邮箱（M-P7 箱净门捕获）。
                         * 刻意静默——「qzjs」是保留命名空间，宿主往这个键发东西
                         * 本就不该被当用户命令受理；qz_control() 侧已有守卫
                         * 拒收（见 control.c），这里只兜住直连通道的帧。 */
                    }
                    /* 其余（READY/IDLE/SHUTDOWN/PING/PONG/PFAIL）：上方各
                     * 分支已就地消费并 continue，落到这里只是防御性兜底。 */
                } else {
                    /* kind → msgq flags：CONTROL 交控制面；PORT_TRANSFER 走
                     * 应用派发但 JS 拿到 kind=1，据此走 port 端点路由（M-P3）。 */
                    int flags = view.kind == IPC_ENV_KIND_CONTROL
                                    ? QZ_MSG_FLAG_CONTROL
                                    : (view.kind == IPC_ENV_KIND_PORT_TRANSFER
                                           ? QZ_MSG_FLAG_PORT_TRANSFER : 0);
                    qz_msg_push(rt, (const char *)view.payload,
                                  view.payload_len, view.source, flags);
                    uv_async_send(&rt->wake);
                }
            }
        }

        /* Consume frame body */
        g_rx.len -= g_rx.frame_len;
        if (g_rx.len > 0)
            memmove(g_rx.buf, g_rx.buf + g_rx.frame_len, g_rx.len);
        g_rx.frame_len = 0;
    }
}

static void pipe_read_cb(uv_stream_t *s, ssize_t nread, const uv_buf_t *buf)
{
    qz_t *rt = (qz_t *)s->data;

    if (nread < 0) {
        /* EOF or error → parent gone → self-terminate (§6.4) */
        free(buf->base);
        __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
        uv_async_send(&rt->wake);
        return;
    }

    if (nread > 0) {
        /* Grow buffer if needed */
        size_t need = g_rx.len + (size_t)nread;
        if (need > g_rx.cap) {
            size_t ncap = g_rx.cap ? g_rx.cap : 4096;
            while (ncap < need) ncap *= 2;
            uint8_t *nb = (uint8_t *)realloc(g_rx.buf, ncap);
            if (nb) {
                g_rx.buf = nb;
                g_rx.cap = ncap;
            } else {
                free(buf->base);
                /* OOM — self-terminate; wake the loop so uv_run(ONCE) does
                 * not stay blocked in pipe poll (I2). */
                __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
                uv_async_send(&rt->wake);
                return;
            }
        }
        memcpy(g_rx.buf + g_rx.len, buf->base, (size_t)nread);
        g_rx.len += (size_t)nread;
        process_rx(rt);
    }
    free(buf->base);
}

/* ── Main ── */

int rt_main_entry(int argc, char **argv)
{
    int parent_fd = -1;
    int worker_id = 0;
    const char *script_path = NULL;
    int script_stdin = 0;   /* --script-stdin：源码来自管道（--parent-fd），零落盘 */
    const char *bytecode_path = NULL;   /* --bytecode：预编译初始字节码 */
    int bytecode_stdin = 0;  /* --bytecode-stdin：字节码来自管道，零落盘 */
    int is_server = 0;          /* M-P2：主RT serve 形态 */
    int is_worker = 0;
    int worker_backend = -1;    /* --worker-backend；-1 = 编译缺省 */
    int control_plane = -1;     /* --control-plane；-1 = 缺省（OFF） */
    int debug_arg = 0;          /* --debug；父进程经 argv 传递（见 rt_host.c） */
    const char *control_pipe = NULL;   /* --control-pipe 路径（NULL = 缺省） */
    const char *path_arg = NULL;       /* §8.2 path 链 "k1,k2,..."（父经 argv 传） */

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--qzjs-worker") == 0) {
            is_worker = 1;
        } else if (strcmp(argv[i], "--qzjs-rt-server") == 0) {
            is_server = 1;
        } else if (strcmp(argv[i], "--parent-fd") == 0 && i + 1 < argc) {
            parent_fd = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--worker-id") == 0 && i + 1 < argc) {
            worker_id = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--worker-backend") == 0 && i + 1 < argc) {
            /* 传符号名（非数值）：宿主与主RT 必须对枚举取值理解一致，符号名
             * 免去「同构建内数值排列相同」这一隐含前提。 */
            const char *wb = argv[++i];
            if (strcmp(wb, "process") == 0)
                worker_backend = QZ_WORKER_BACKEND_PROCESS;
            else if (strcmp(wb, "thread") == 0)
                worker_backend = QZ_WORKER_BACKEND_THREAD;
            else {
                fprintf(stderr, "qzjs-rt: bad --worker-backend: %s\n", wb);
                return 1;
            }
        } else if (strcmp(argv[i], "--script-stdin") == 0) {
            script_stdin = 1;
        } else if (strcmp(argv[i], "--script") == 0 && i + 1 < argc) {
            script_path = argv[++i];
        } else if (strcmp(argv[i], "--bytecode-stdin") == 0) {
            bytecode_stdin = 1;
        } else if (strcmp(argv[i], "--bytecode") == 0 && i + 1 < argc) {
            bytecode_path = argv[++i];
        } else if (strcmp(argv[i], "--path") == 0 && i + 1 < argc) {
            /* §8.2：完整 path 链（逗号分隔），由直接父在 spawn 时拼好传入——
             * 父知自身 path 与本节点本地槽位 id。 */
            path_arg = argv[++i];
        } else if (strcmp(argv[i], "--debug") == 0 && i + 1 < argc) {
            debug_arg = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--control-plane") == 0 && i + 1 < argc) {
            const char *cp = argv[++i];
            if (strcmp(cp, "off") == 0) control_plane = QZ_CONTROL_OFF;
            else if (strcmp(cp, "in-proc") == 0) control_plane = QZ_CONTROL_IN_PROC;
            else if (strcmp(cp, "local") == 0) control_plane = QZ_CONTROL_LOCAL;
            else {
                fprintf(stderr, "qzjs-rt: bad --control-plane: %s\n", cp);
                return 1;
            }
        } else if (strcmp(argv[i], "--control-pipe") == 0 && i + 1 < argc) {
            control_pipe = argv[++i];
        }
    }

    g_server_mode = is_server;
    /* CTL-1 本地标签：主RT 在宿主通道上恒为 1（QZ_IPC_MAIN_ID）；worker 用
     * --worker-id（与父侧 spawn 时登记的子槽位 id 同值）。 */
    g_local_id = is_server ? QZ_IPC_MAIN_ID : (int32_t)worker_id;

    if ((!is_worker && !is_server) || (is_worker && is_server) || parent_fd < 0) {
        fprintf(stderr,
                "qzjs-rt: usage:\n"
                "  qzjs-rt --qzjs-worker    --parent-fd N --worker-id K [--script-stdin | --script PATH]\n"
                "  qzjs-rt --qzjs-rt-server --parent-fd N [--script-stdin | --script PATH]"
                " [--bytecode-stdin | --bytecode PATH] [--worker-backend process|thread]\n");
        return 1;
    }

    /* ── Read script ──
     * 两种形态互斥：--script PATH 读文件（保留手动用法）；
     * --script-stdin 从 --parent-fd 读首帧（parent 在 spawn 后、握手前已把
     * 源码以长度前缀帧写入同一 socketpair，零落盘）。 */
    char *script = NULL;
    if (script_stdin) {
        int64_t deadline = qz_now_ms() + QZ_IPC_HANDSHAKE_TIMEOUT_MS;
        uint8_t *frame = NULL;
        size_t flen = 0;
        if (qz_ipc_read_frame(parent_fd, &frame, &flen, deadline) < 0) {
            fprintf(stderr, "qzjs-rt: --script-stdin read failed\n");
            return 1;
        }
        script = (char *)malloc(flen + 1);
        if (!script) { free(frame); return 1; }
        memcpy(script, frame, flen);
        script[flen] = '\0';
        free(frame);
    } else if (script_path) {
        FILE *f = fopen(script_path, "r");
        if (!f) {
            fprintf(stderr, "qzjs-rt: cannot open script: %s\n", script_path);
            return 1;
        }
        fseek(f, 0, SEEK_END);
        long sz = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (sz < 0) { fclose(f); return 1; }
        script = (char *)malloc((size_t)sz + 1);
        if (!script) { fclose(f); return 1; }
        size_t rd = fread(script, 1, (size_t)sz, f);
        script[rd] = '\0';
        fclose(f);
        /* --script PATH 是用户/调用方自有的文件（手动运行
         * `qzjs-rt --script foo.js`），**不删除**——旧版在此 unlink 是
         * 因为父进程写的是 mkstemp 临时文件、子读毕负责清理；启动源码改
         * 走管道（--script-stdin）后，PATH 形态只用于用户文件，删它会
         * 误删用户的真实脚本。 */
    }

    /* 字节码（二进制）：--bytecode-stdin 从管道读（零落盘）；否则读
     * --bytecode PATH 用户文件（手动形态，不删除）。源码帧先于字节码帧
     *（父按「源码→字节码」固定顺序写）。 */
    uint8_t *bytecode = NULL;
    size_t bytecode_len = 0;
    if (bytecode_stdin) {
        int64_t deadline = qz_now_ms() + QZ_IPC_HANDSHAKE_TIMEOUT_MS;
        uint8_t *frame = NULL;
        size_t flen = 0;
        if (qz_ipc_read_frame(parent_fd, &frame, &flen, deadline) < 0) {
            fprintf(stderr, "qzjs-rt: --bytecode-stdin read failed\n");
            free(script);
            return 1;
        }
        bytecode = frame;   /* 已是 malloc 的裸字节 */
        bytecode_len = flen;
    } else if (bytecode_path) {
        FILE *f = fopen(bytecode_path, "rb");
        if (!f) {
            fprintf(stderr, "qzjs-rt: cannot open bytecode: %s\n", bytecode_path);
            free(script);
            return 1;
        }
        fseek(f, 0, SEEK_END);
        long sz = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (sz < 0) { fclose(f); free(script); return 1; }
        bytecode = (uint8_t *)malloc((size_t)sz);
        if (!bytecode) { fclose(f); free(script); return 1; }
        if (fread(bytecode, 1, (size_t)sz, f) != (size_t)sz) {
            fprintf(stderr, "qzjs-rt: bytecode read error\n");
            fclose(f); free(bytecode); free(script);
            return 1;
        }
        fclose(f);
        bytecode_len = (size_t)sz;
        /* --bytecode PATH 同 --script PATH：用户自有 .bc 文件，不删除
         *（理由见上面 script_path 注释）。 */
    }

    /* ── Handshake (child sends first, §3.3) ── */
    {
        char hs_json[40];
        /* 握手身份：worker 形态 = 本地槽位 id（相对直接父）；主RT 形态 =
         * 固定本地标签 1（宿主为 0，§4.3 主RT 通道上的相对寻址）。 */
        int hs_role = is_server ? QZ_IPC_ROLE_MAIN : QZ_IPC_ROLE_WORKER;
        int hs_id = is_server ? QZ_IPC_MAIN_ID : worker_id;
        size_t hs_len = qz_ipc_build_handshake(hs_json, sizeof hs_json,
                                                  hs_role, hs_id);
        if (hs_len == 0) {
            fprintf(stderr, "qzjs-rt: handshake build failed\n");
            free(script);
            return 1;
        }
        size_t env_cap = IPC_ENVELOPE_ENCODED_SIZE(hs_len);
        uint8_t *env_buf = (uint8_t *)malloc(env_cap);
        if (!env_buf) { free(script); return 1; }
        size_t env_len = ipc_envelope_encode(env_buf, env_cap,
                                            (int32_t)hs_id,
                                            is_server ? QZ_IPC_HOST_ID : 1,
                                            IPC_ENV_KIND_CONTROL,
                                            0,
                                            (const uint8_t *)hs_json,
                                            (uint32_t)hs_len);
        if (env_len == 0) {
            fprintf(stderr, "qzjs-rt: envelope encode failed\n");
            free(env_buf); free(script);
            return 1;
        }
        if (qz_ipc_write_frame(parent_fd, env_buf, env_len) < 0) {
            fprintf(stderr, "qzjs-rt: handshake write failed\n");
            free(env_buf); free(script);
            return 1;
        }
        free(env_buf);

        /* Read ack (5s deadline) */
        int64_t deadline = qz_now_ms() + QZ_IPC_HANDSHAKE_TIMEOUT_MS;
        uint8_t *ack_frame = NULL;
        size_t ack_flen = 0;
        if (qz_ipc_read_frame(parent_fd, &ack_frame, &ack_flen, deadline) < 0) {
            fprintf(stderr, "qzjs-rt: handshake ack timeout/EOF\n");
            free(script);
            return 1;
        }
        ipc_envelope_view_t view;
        if (ipc_envelope_decode(ack_frame, ack_flen, &view) < 0) {
            fprintf(stderr, "qzjs-rt: ack decode failed\n");
            free(ack_frame); free(script);
            return 1;
        }
        char ack_json[40];
        size_t cp = view.payload_len < sizeof(ack_json) - 1
                      ? view.payload_len : sizeof(ack_json) - 1;
        memcpy(ack_json, view.payload, cp);
        ack_json[cp] = '\0';
        free(ack_frame);

        int ok = 0, ver = 0;
        if (qz_ipc_parse_ack(ack_json, &ok, &ver) < 0 || !ok ||
            ver != QZ_IPC_PROTO_VERSION) {
            fprintf(stderr, "qzjs-rt: handshake rejected (ok=%d v=%d)\n", ok, ver);
            free(script);
            return 1;
        }
    }

    /* Register the emit channel for bridge.c (child → parent envelopes). */
    qz_ipc_child_set_channel(parent_fd);

    /* ── Init qz_t ── */
    qz_t *rt = (qz_t *)calloc(1, sizeof(qz_t));
    if (!rt) { free(script); return 1; }
    rt->magic = QZ_MAGIC;
    rt->config.initial_script = NULL;
    /* 宿主经 qz_config_t.debug 设的 DAP 位。此前硬编码 0，使宿主设的 debug
     * 在 ISOLATED（默认）下静默失效——runtime 只在主RT 进程，而 qz_runtime_init
     * 的自动 attach 判定读的正是这个字段。父进程现经 --debug 传入。 */
    rt->config.debug = debug_arg;
    rt->config.control_plane = 0;
    /* strict 模式：父进程（qzjs --strict-sandbox）经环境变量传递——子进程 exec
     * 后继承 environ，无需改 argv 协议。深拷贝语义同 qz_create（rt 拥有）。 */
    {
        const char *sroot = getenv("QZ_STRICT_SANDBOX");
        if (sroot && sroot[0]) {
            rt->config.strict_mode = 1;
            rt->strict_root = strdup(sroot);
            const char *spec = getenv("QZ_STRICT_ENV");
            if (!spec || !*spec) spec = "PATH,HOME,LANG";
            size_t n = 1;
            for (const char *c = spec; *c; c++) if (*c == ',') n++;
            rt->strict_env_allow = (char **)calloc(n + 1, sizeof(char *));
            if (rt->strict_env_allow) {
                size_t i = 0; const char *start = spec;
                for (;;) {
                    const char *comma = strchr(start, ',');
                    size_t len = comma ? (size_t)(comma - start) : strlen(start);
                    if (len) {
                        char *tok = (char *)malloc(len + 1);
                        if (tok) { memcpy(tok, start, len); tok[len] = '\0';
                                   rt->strict_env_allow[i++] = tok; }
                    }
                    if (!comma) break;
                    start = comma + 1;
                }
            }
        }
    }
    /* 运行时 CA 信任库：父进程（qzjs --ca）经环境变量传递 —— 与 strict 模式
     * 同一条路（子进程 exec 后继承 environ，无需改 argv 协议）。
     *
     * 为什么必须走 env：ISOLATED 模型下宿主与主 RT 是**两个进程**，各自持有
     * 独立的 qz_t。父进程 qz_create 之后调 qz_add_ca_pem() 写的是父进程的
     * rt->ca_pem，跑 JS 的是子进程、它的 ca_pem 恒为空 —— 不经这条传递，
     * --ca 会静默无效（fetch 报 X509 verification failed，看起来像证书问题，
     * 实际是信任库从没到达真正做握手的那一侧）。 */
    {
        const char *cafile = getenv("QZ_CA_FILE");
        if (cafile && cafile[0]) {
            FILE *f = fopen(cafile, "rb");
            if (!f) {
                fprintf(stderr, "qzjs-rt: QZ_CA_FILE unreadable: %s\n", cafile);
                exit(2);
            }
            if (fseek(f, 0, SEEK_END) == 0) {
                long sz = ftell(f);
                if (sz > 0) {
                    rewind(f);
                    char *buf = (char *)malloc((size_t)sz + 1);
                    if (buf) {
                        size_t rd = fread(buf, 1, (size_t)sz, f);
                        buf[rd] = '\0';
                        if (qz_add_ca_pem(rt, buf) != 0) {
                            fprintf(stderr, "qzjs-rt: QZ_CA_FILE load failed\n");
                            free(buf); fclose(f); exit(2);
                        }
                        free(buf);
                    }
                }
            }
            fclose(f);
        }
    }
    rt->msg_head = &rt->msg_stub;
    rt->msg_tail = &rt->msg_stub;
    /* 子进程不消费邮箱（出站经 host_emit 上行 / worker 丢弃）：out_efd
     * 显式 -1，防 calloc 的 0 被误当 fd 写（= stdin）。 */
    qz_out_mq_init(rt);
    rt->out_efd = -1;

    qz_worker_t *w = NULL;

    /* 运行时角色：worker 形态标记 worker_self（bridge.c 的 pal 按 worker 绑定）；
     * 主RT 形态保持 worker_self == NULL = 父运行时语义（可自行 spawn worker
     * 进程 = §1.1 树形拓扑的主RT 层），并把宿主边界出站钩子接成信封上行
     * （M-P7：内部钩子，非公共回调）。 */
    if (is_server) {
        if (worker_backend >= 0) rt->config.worker_backend = worker_backend;
        rt->host_emit = server_emit_cb;
    } else {
        /* qzjs-rt --qzjs-worker 进程按构造即 PROCESS 后端 worker（THREAD
         * worker 是同进程线程，不 exec 本二进制）。强制置位让 worker 侧
         * pal.workerBackend() 返回 'process'——local-storage.js 据此挂
         * §10.2 单所有者代理（M-P4）。 */
        rt->config.worker_backend = QZ_WORKER_BACKEND_PROCESS;
        w = (qz_worker_t *)calloc(1, sizeof(qz_worker_t));
        if (!w) { free(rt); free(script); return 1; }
        w->self = rt;
        w->id = worker_id;
        w->parent = NULL;  /* no in-process parent — IPC pipe is the channel */
        rt->worker_self = w;
    }

    /* CTL-2：控制面档位与端点路径由宿主经 argv 传入（ISOLATED 下 runtime
     * 在本进程，宿主进程只有通道桩）。只有主RT 监听端点——worker 经父路由
     * （§2.2 树形拓扑）。 */
    if (control_plane >= 0) {
        rt->config.control_plane = control_plane;
    } else if (is_worker) {
        /* worker 形态缺省 IN_PROC：worker 没有任何外部面（唯一入站是父通道，
         * 且父受自身档位门控——父 OFF 时命令在父侧就丢了，§4.1），而 CTL-1
         * 要求「target 指向 worker 槽位 → 沿树下发 → worker 自己 safepoint
         * 执行」（§2.2）。若父未显式传档位，OFF 会让 worker 静默丢弃所有
         * 命令、回执退化为 TIMEOUT——故 worker 缺省取可执行档。 */
        rt->config.control_plane = QZ_CONTROL_IN_PROC;
    }
    rt->config.control_pipe_path = control_pipe;

    /* §8.2：本节点 path 链。父经 --path 传完整链；缺省（无 --path 的 worker）
     * 退化为单元素 [worker_id]（深度 1 的旧扁平语义）。主RT/宿主形态为空 path。 */
    if (path_arg) {
        const char *p = path_arg;
        while (*p && rt->self_path_len < QZ_SELF_PATH_MAX) {
            char *end = NULL;
            long v = strtol(p, &end, 10);
            if (end == p) break;
            if (v > 0 && v <= 0xFFFF) rt->self_path[rt->self_path_len++] = (uint16_t)v;
            p = (*end == ',') ? end + 1 : end;
        }
    } else if (is_worker && worker_id > 0 && worker_id <= 0xFFFF) {
        rt->self_path[rt->self_path_len++] = (uint16_t)worker_id;
    }

    int loop_inited = 0;
    if (uv_loop_init(&rt->loop) != 0) {
        fprintf(stderr, "qzjs-rt: loop init failed\n");
        free(w); free(rt); free(script);
        return 1;
    }
    loop_inited = 1;

    rt->wake.data = rt;
    if (uv_async_init(&rt->loop, &rt->wake, child_wake_cb) != 0) {
        fprintf(stderr, "qzjs-rt: async init failed\n");
        goto fail;
    }

    /* CTL-2 §2.3：LOCAL 档在主RT 打开本地端点（qzjs-ctl 连入）。必须在
     * qz_runtime_init 之前——runtime_init 会 attach DAP 并阻塞在
     * configuration（debug 模式），端点若排在其后则调试会话期间完全不可用。
     * 端点与 DAP stdio 是两个分离通道（§2.3「与 DAP 并存规则」），互不抢占。
     * bind/listen 失败即显式失败，不静默降级为 in-proc。 */
    if (is_server && rt->config.control_plane == QZ_CONTROL_LOCAL &&
        qz_ctl_endpoint_init(rt) != 0) {
        fprintf(stderr, "qzjs-rt: control endpoint init failed\n");
        goto fail;
    }

    if (qz_runtime_init(rt) != 0) {
        fprintf(stderr, "qzjs-rt: runtime init failed\n");
        goto fail;
    }

    /* ── Open pipe on loop for async reads ── */
    if (uv_pipe_init(&rt->loop, &g_parent_pipe, 0) != 0) {
        fprintf(stderr, "qzjs-rt: pipe init failed\n");
        goto fail;
    }
    if (uv_pipe_open(&g_parent_pipe, parent_fd) != 0) {
        fprintf(stderr, "qzjs-rt: pipe open failed\n");
        goto fail;
    }
    g_parent_pipe.data = rt;
    if (uv_read_start((uv_stream_t *)&g_parent_pipe,
                      pipe_alloc_cb, (uv_read_cb)pipe_read_cb) != 0) {
        fprintf(stderr, "qzjs-rt: read_start failed\n");
        goto fail;
    }
    /* emit 写路径走 spill buffer（非阻塞 send + 1ms flush timer，背压不丢帧） */
    qz_ipc_child_tx_init(&rt->loop, parent_fd);
    /* M-P4：worker 进程注册同步 storage RPC 实现（pal.storageSync 的传输
     * 半边；主RT/宿主进程不注册，调用即 -1 = 不可达）。 */
    qz_ipc_child_set_storage_sync(child_storage_sync);

    /* 主RT 形态：登记宿主通道管道 —— 读管道恒活动（duplex 读回调），wait_idle 的
     * idle 判定须豁免它，否则主RT 永不判 idle（qz_proc_handle_is_pipe）。 */
    if (is_server) rt->ipc_channel_pipe = &g_parent_pipe;

    if (is_server) {
        /* ── 主RT 形态：eval 初始程序（宿主 initial_bytecode 或
         * initial_script，经临时文件传入）→ 回 CONTROL{ready}。旧 thread 后端
         * 的 ready_err 语义搬到这里：初始程序抛异常 = 运行时起不来，宿主
         * qz_create 必须返回失败（不静默降级，§5.3）。 */
        int ready_ok = 1;
        if (script) {
            char *err = NULL;
            if (qz_eval_internal(rt, script, &err) != 0) {
                fprintf(stderr, "qzjs-rt: initial script error: %s\n",
                        err ? err : "?");
                free(err);
                ready_ok = 0;
            }
            free(script);
            script = NULL;
        }
        /* 字节码在脚本之后 eval（同 qzjs.h 语义：脚本装 bootstrap，
         * 字节码跑主程序）。 */
        if (ready_ok && bytecode) {
            char *err = NULL;
            if (qz_eval_bytecode_internal(rt, bytecode, bytecode_len, &err) != 0) {
                fprintf(stderr, "qzjs-rt: initial bytecode error: %s\n",
                        err ? err : "?");
                free(err);
                ready_ok = 0;
            }
            free(bytecode);
            bytecode = NULL;
        }
        if (qz_ipc_child_emit_ctl(ready_ok ? QZ_IPC_CTL_READY_OK
                                             : QZ_IPC_CTL_READY_ERR) < 0) {
            fprintf(stderr, "qzjs-rt: ready emit failed\n");
            goto fail;
        }
        if (!ready_ok) {
            qz_thread_teardown(rt);
            free(g_rx.buf);
            g_rx.buf = NULL;
            free(rt);
            return 1;
        }
    } else {
        /* ── Eval worker boot bytecode ── */
        {
            char *err = NULL;
            if (qz_eval_bytecode_internal(rt, qz_default_worker_boot,
                                             qz_default_worker_boot_len,
                                             &err) != 0) {
                fprintf(stderr, "qzjs-rt: boot failed: %s\n", err ? err : "?");
                free(err);
                goto fail;
            }
        }

        /* ── Eval worker script ── */
        if (script) {
            char *err = NULL;
            if (qz_eval_internal(rt, script, &err) != 0) {
                fprintf(stderr, "qzjs-rt: script error: %s\n", err ? err : "?");
                free(err);
                /* Worker continues (per spec: error event, not crash) */
            }
            free(script);
            script = NULL;
        }
    }

    /* ── Main loop ──
     * worker 形态镜像 qz_worker_thread_main；主RT 形态镜像 qz_thread_main
     * （多一层 idle 检测：排空且自身 idle → 回 CONTROL{idle} ack → 自身退出，
     * 与 thread 后端的「idle 即退」语义一致，§6.1）。 */
    while (!__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE) &&
           !(w && __atomic_load_n(&w->shutting_down, __ATOMIC_ACQUIRE))) {
        uv_run(&rt->loop, UV_RUN_ONCE);
        if (is_server) qz_ctl_reap_timeouts(rt);
        if (__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE) ||
            (w && __atomic_load_n(&w->shutting_down, __ATOMIC_ACQUIRE))) break;
        qz_flush_microtasks(rt);
        if (is_server &&
            __atomic_load_n(&rt->wait_idle, __ATOMIC_ACQUIRE) &&
            qz_loop_idle(rt)) {
            qz_ipc_child_emit_ctl(QZ_IPC_CTL_IDLE_ACK);
            __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
            break;
        }
    }

    /* ── Teardown ── */
    qz_thread_teardown(rt);
    free(g_rx.buf);
    g_rx.buf = NULL;
    free(w);
    free(rt->strict_root);
    if (rt->strict_env_allow) {
        for (char **p = rt->strict_env_allow; *p; p++) free(*p);
        free(rt->strict_env_allow);
    }
    free(rt);
    free(bytecode);
    free(script);
    return 0;

fail:
    free(bytecode);
    free(script);
    if (g_rx.buf) { free(g_rx.buf); g_rx.buf = NULL; }
    free(w);
    if (loop_inited) {
        qz_close_loop(&rt->loop);
        /* close-failed: 仍 free rt（uv_loop_t 按值内嵌其中）——见 qz_close_loop 的取舍说明。 */
    }
    free(rt->strict_root);
    if (rt->strict_env_allow) {
        for (char **p = rt->strict_env_allow; *p; p++) free(*p);
        free(rt->strict_env_allow);
    }
    free(rt);
    return 1;
}
