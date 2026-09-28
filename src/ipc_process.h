/*
 * qzjs IPC Process — parent-side spawn / handshake / terminate (M-P1)
 *
 * Tree-edge duplex channel between a parent runtime and a child process.
 * Parent spawns child via fork+exec of qzjs-rt; child inherits one end of
 * a socketpair via --parent-fd. Both sides exchange a CONTROL handshake
 * envelope (FlatBuffers wire format) before any application messages flow.
 *
 * Frame format (on the wire): 4-byte LE length prefix + envelope bytes.
 *
 * Design: docs/plans/2026-09-04-multi-process-model.md §3, §5, §9.2, M-P1.
 */

#ifndef QZ_IPC_PROCESS_H
#define QZ_IPC_PROCESS_H

#include "qzjs/qzjs.h"
#include "ipc_envelope.h"
#include <stdint.h>
#include <sys/types.h>   /* pid_t */

#ifdef QZ_USE_MOCK_LIBUV
#include "mock_libuv.h"
#else
#include <uv.h>
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* ── Opaque handle — declared up front so the framing/terminate prototypes
 * below can use qz_proc_t without pulling in uv types (review: the typedef
 * used to sit mid-declaration list). Guarded: qz_internal.h forward-declares
 * the same name (it must not include this header under mock libuv), and a
 * repeated typedef is an error under -Wpedantic. */
#ifndef QZ_PROC_T_DEFINED
#define QZ_PROC_T_DEFINED
typedef struct qz_proc_s qz_proc_t;
#endif

/* ── Constants ── */

#define QZ_IPC_PROTO_VERSION    1
#define QZ_IPC_ROLE_WORKER      0
#define QZ_IPC_ROLE_MAIN        1   /* M-P2：主RT 进程（宿主↔主RT 通道） */

/* 主RT 通道的本地标签（§4.3 逐跳相对寻址）：宿主=0，主RT=1。 */
#define QZ_IPC_HOST_ID          0
#define QZ_IPC_MAIN_ID          1
#define QZ_IPC_HANDSHAKE_TIMEOUT_MS  5000
#define QZ_IPC_TERMINATE_TIMEOUT_MS  2000
#define QZ_IPC_READ_BUF_SIZE    65536

/* 子进程通道 fd 固定值（spawn 分层化）：调用方拼 argv 时 --parent-fd 一律
 * 写 3；qz_proc_spawn 内部 socketpair 后，fork 出的 child 把子端
 * dup2 到这个固定 fd 再 execv。固定值让调用方在运行时 fd 未知时也能拼
 * argv（POSIX 约定 0/1/2 为 stdio，3 是第一个可自由使用的 fd；child 拥有
 * 自己的 fd 表，dup2 无条件覆盖 3）。JS 侧（polyfill/src/worker.js）拼 argv
 * 时硬编码 "--parent-fd" "3"，与本常量同步维护。 */
#define QZ_IPC_CHANNEL_FD    3


/* ── Framing (length-prefixed, blocking I/O for handshake) ── */

/* Write a 4-byte LE length prefix + data to fd (blocking, full write).
 * Returns 0 on success, -1 on error. */
int qz_ipc_write_frame(int fd, const uint8_t *data, size_t len);

/* Read one length-prefixed frame from fd (blocking).
 * deadline_ms: ABSOLUTE monotonic deadline (now_ms() + timeout) — the frame
 * must complete before it. Same convention as the spawn/terminate callers. */
int qz_ipc_read_frame(int fd, uint8_t **out_frame, size_t *out_len,
                        int64_t deadline_ms);

/* ── Handshake JSON helpers ── */

/* Build handshake payload: {"v":V,"role":R,"id":I}
 * Returns string length (excl NUL). cap must be >= 40. */
size_t qz_ipc_build_handshake(char *out, size_t cap, int role, int id);

/* Build ack payload: {"ok":O,"v":V}
 * Returns string length (excl NUL). cap must be >= 24. */
size_t qz_ipc_build_ack(char *out, size_t cap, int ok);

/* ── M-P2 主RT 通道 CONTROL 协议（§6.1）──
 * payload = 带 "qzjs" 标记的 JSON（cJSON 解析，与握手同裁决：不手写）：
 *   {"qzjs":1,"ready":V}      V=1 初始化就绪 / 0 失败（宿主据此决定 qz_create）
 *   {"qzjs":1,"idle":V}       V=0 宿主请求 idle / 1 主RT 已排空并判 idle（ack）
 *   {"qzjs":1,"shutdown":1}   优雅关停（与 M-P1 的 {"cmd":"shutdown"} 并存）
 * 无 "qzjs" 标记的 CONTROL payload 归上层（控制面消息/应用），classify 返回 NONE。 */
#define QZ_IPC_CTL_READY_OK   "{\"qzjs\":1,\"ready\":1}"
#define QZ_IPC_CTL_READY_ERR  "{\"qzjs\":1,\"ready\":0}"
#define QZ_IPC_CTL_IDLE_REQ   "{\"qzjs\":1,\"idle\":0}"
#define QZ_IPC_CTL_IDLE_ACK   "{\"qzjs\":1,\"idle\":1}"
#define QZ_IPC_CTL_SHUTDOWN_MSG "{\"qzjs\":1,\"shutdown\":1}"
#define QZ_IPC_CTL_CLOSING      "{\"qzjs\":1,\"closing\":1}"   /* M-P4 §9.3：
                                         * worker 自 close 前通知父（EOF 不再
                                         * 当作崩溃触发 onerror） */
#define QZ_IPC_CTL_PING_MSG   "{\"qzjs\":1,\"ping\":1}"   /* liveness 探测：
                                         * 宿主→对端；对端 C 层读泵就地直回。
                                         * 跨层形态加 "tp":[u16 链]（§8.2
                                         * root-relative 槽位链，宿主→任意
                                         * worker）：中间节点按链下投（读泵
                                         * 转发，不消费），目标读泵直回。 */
#define QZ_IPC_CTL_PONG_MSG   "{\"qzjs\":1,\"pong\":1}"   /* liveness 应答：
                                         * 对端读泵回显 corr（= ping seq）。
                                         * 跨层 PONG 回显 "tp"（过境标记：
                                         * 中间节点见 tp 沿父通道上行转发，
                                         * 不吃进自身 ping_seq 配对槽）。 */
#define QZ_IPC_CTL_PFAIL_FMT  "{\"qzjs\":1,\"pfail\":1,\"corr\":%d}"  /* 跨层
                                         * ping 转发失败（无对应子槽位/通道
                                         * 死）：中间节点回 corr=seq，宿主
                                         * 快速 -1（不白等 timeout）。 */
typedef enum {
    QZ_IPC_CTL_NONE = 0,   /* 非 M-P2 协议 CONTROL payload */
    QZ_IPC_CTL_READY,
    QZ_IPC_CTL_IDLE,
    QZ_IPC_CTL_SHUTDOWN,
    QZ_IPC_CTL_SYSTEM,     /* 带 "qzjs" 标记的其他系统消息（M-P4 closing 等）：
                              * 通道级，不进控制面命令路由器（CTL-1） */
    QZ_IPC_CTL_PING,       /* liveness 探测（payload {"qzjs":1,"ping":1}，
                              * 跨层加 "tp"） */
    QZ_IPC_CTL_PONG,       /* liveness 应答（payload {"qzjs":1,"pong":1}，
                              * 跨层回显 "tp"） */
    QZ_IPC_CTL_PFAIL,      /* 跨层 ping 转发失败（{"qzjs":1,"pfail":1,
                              * "corr":seq}） */
} qz_ipc_ctl_kind_t;

/* 跨层 ping/pong payload 的 "tp" 数组提取（u16 槽位链，§8.2 root-relative）。
 * 返回元素数（0 = 无 tp = 单跳形态）。 */
int qz_ipc_ping_tp(const uint8_t *payload, uint32_t len,
                     int32_t *out, int cap);

/* 判定 CONTROL payload 是否为 M-P2 协议消息；命中时 *out_val = 对应键的数值
 * （ready: 1=ok/0=fail；idle: 0=请求/1=ack；shutdown: 1）。非协议返回 NONE
 * （*out_val 不写）。 */
qz_ipc_ctl_kind_t qz_ipc_ctl_classify(const uint8_t *payload,
                                          uint32_t len, int *out_val);

/* 主RT 进程侧：发一条 M-P2 CONTROL 协议消息（source=1, target=0, kind=CONTROL）。 */
int qz_ipc_child_emit_ctl(const char *json);

/* 宿主侧：经主RT 通道发一条 M-P2 CONTROL 协议消息（source=0, target=1）。 */
int qz_proc_post_ctl(qz_proc_t *proc, const char *json);
/* Channel handle — see typedef above (qz_proc_t), defined at the top of
 * this header so declarations can reference it. */

#ifndef QZ_USE_MOCK_LIBUV
/* Full struct body is private to ipc_process.c (real-libuv pipe APIs).
 * Mock test builds (QZ_USE_MOCK_LIBUV) only see the opaque typedef. */
/* Outbound spill buffer (lossless backpressure): frames append here when
 * send() hits EAGAIN; a 1ms uv_timer flushes while non-empty. */
typedef struct qz_tx_s {
    uint8_t    *buf;
    size_t      len;
    size_t      cap;
    uv_timer_t  timer;
    int         fd;             /* socket fd to send on, -1 until first use */
    int         timer_active;
} qz_tx_t;

/* 读泵回调（qz_proc_start_read_cb）：cb(user, kind, source, corr, payload, len)。
 * payload == NULL 表示 peer-death/EOF（回调后不再调用，kind/source/corr 无意义）；
 * kind = IPC_ENV_KIND_*、source = 信封源标签、corr = STORAGE 中继关联 id（非
 * STORAGE 帧恒 0），接收方据此分流（如 M-P2 宿主侧区分 CONTROL 协议消息与
 * MESSAGE 数据；STORAGE owner 按 corr 原样回显回复）。 */
typedef void (*qz_proc_msg_cb_t)(void *user, int8_t kind, int32_t source,
                                   int32_t corr,
                                   const uint8_t *payload, uint32_t len);

/* pre-ready 帧暂存硬上限：超过 = 协议异常，create 显式失败（§5.3）。 */
#define QZ_PROC_PRE_FRAMES_MAX 256

struct qz_proc_s {
    uv_pipe_t pipe;           /* duplex pipe to child (parent end) */
    pid_t     pid;            /* child PID */
    int       id;             /* local slot id (source label / handshake 预期) */
    int       role;           /* QZ_IPC_ROLE_* */
    int       state;          /* qz_proc_state_t */
    void     *parent_rt;      /* parent qz_t* (for callbacks) */
    /* CTL-1：>0 时本通道上到达的命令类 CONTROL 信封交 qz_control_route
     * 树路由（值为本节点槽位 id）；0 = 不路由（宿主侧读泵交 msg_cb）。 */
    int32_t   ctl_route_id;
    /* Read accumulator: frames = [4-byte LE len][envelope]; async reads via
     * qz_proc_start_read / qz_proc_start_read_cb. */
    uint8_t  *rbuf;
    size_t    rbuf_cap;
    size_t    rbuf_len;
    uint32_t  frame_len;      /* 0 = need 4-byte header */
    int       pipe_inited;    /* uv_pipe_init done (close via uv_close) */
    qz_tx_t tx;             /* outbound spill buffer + flush timer */
    /* JS-managed delivery mode (spawn 分层化, Phase B): 非 NULL 时信封解码后
     * 直接交给 msg_cb（bridge.c 的 pal.processOnMessage），不 push 父 msgq、
     * 也不做 worker-slot reap。EOF/peer-death 时以 payload=NULL 回调一次并
     * 标记 DEAD。 */
    void              *msg_user;
    qz_proc_msg_cb_t msg_cb;
    /* create 期 pre-ready 帧缓冲（M-P6）：主RT 形态初始脚本的顶层
     * postMessage 可先于 CONTROL{ready} 落通道。qz_proc_wait_ready_raw 把
     * ready 之前的非-ready 帧暂存到这里，qz_proc_start_read_cb 注册读泵后
     * 按 FIFO 序重放给 msg_cb。payload 逐帧 malloc，重放后/proc 回收时释放。 */
    struct qz_proc_pre_frame {
        int8_t   kind;
        int32_t  source;
        int32_t  corr;
        uint32_t len;
        uint8_t *payload;
    } *pre_frames;
    int   n_pre_frames;
    int   cap_pre_frames;
    /* libuv-idiomatic multi-handle reclaim: proc 内嵌两个 handle（pipe +
     * tx flush timer），qz_proc_free 对两者都 uv_close，proc 内存在
     * 最后一个 close 回调里释放（close_pending 统计未完成的 close 数）。
     * freed 保证 qz_proc_free 幂等（防重复 free / 二次 uv_close）。 */
    int       close_pending;
    int       freed;
    /* ── Liveness ping/pong（父 → sub worker，镜像 rt->ping_seq/pong_seq）──
     * ping_seq = 发起方分配的单调序号（JS 线程写）；pong_seq = 最近收到的
     * PONG 回显序号（读泵线程或 qz_proc_ping 同步扫帧回填）。compare 判定
     * 对端 loop 通畅。单飞行：JS 同步调用，同一 proc 同时至多一个 ping。 */
    int32_t   ping_seq;       /* atomic */
    int32_t   pong_seq;       /* atomic */
};
#endif /* !QZ_USE_MOCK_LIBUV */

/* Parse handshake JSON → version/role/id. Returns 0 ok, -1 fail. */
int qz_ipc_parse_handshake(const char *json, int *out_v,
                             int *out_role, int *out_id);

/* Parse ack JSON → ok/version. Returns 0 ok, -1 fail. */
int qz_ipc_parse_ack(const char *json, int *out_ok, int *out_v);


typedef enum {
    QZ_PROC_BUILD = 0,   /* pipe opened, awaiting handshake */
    QZ_PROC_RUN   = 1,   /* handshake done, application messages flow */
    QZ_PROC_DEAD  = 2    /* peer EOF or killed */
} qz_proc_state_t;
/* ── Parent-side channel handle ── */
/* Spawn a child process over a socketpair channel (spawn 分层化原语).
 * Creates socketpair, fork+exec; the child's channel end is dup2'd to
 * QZ_IPC_CHANNEL_FD (3), so caller-built argv references --parent-fd 3.
 *
 * exe:  任意可执行文件路径；NULL/空串 → auto-detect qzjs-rt (QZ_RT_SERVER
 *       env / /proc/self/exe dir + "qzjs-rt" / QZ_RT_PATH).
 * argv: 调用方拼好的 argv（argv[0] = 程序名），含 --parent-fd 3 等子进程
 *       参数；执行的是 exe 路径（argv[0] 只是显示名）。
 * role/id:  握手预期（child 发 {"v":V,"role":role,"id":id}）；role<0 →
 *           跳过握手。
 * require_handshake: 0 → spawn 后直接 QZ_PROC_RUN，不做握手（用于任意
 *           可执行文件，child 不 speak qzjs 信封协议）。
 * Returns 0 on success, qz_err_t (<0) on failure. */
int qz_proc_spawn(qz_t *parent, qz_proc_t *proc,
                    const char *exe,
                    char *const argv[],
                    int role, int id,
                    int require_handshake);
/* 3-tier termination (§9.2):
 *  1. Send CONTROL{shutdown} envelope
 *  2. Poll for child exit up to timeout_ms (default 2000ms)
 *  3. If still alive: kill(SIGKILL) + waitpid (reap)
 * Returns 0 if child exited (graceful or killed), -1 on error. */
int qz_proc_terminate(qz_proc_t *proc, int timeout_ms);
/* Install async reads on the channel: inbound envelopes decode → parent's
 * msgq push (source = child slot id) + wake. Called by the process-backend
 * worker create after a successful handshake. EOF → state DEAD. */
void qz_proc_start_read(qz_proc_t *proc);

/* JS-managed delivery mode (spawn 分层化): 同 qz_proc_start_read，但信封
 * 解码后不 push 父 msgq，而是调用 cb(user, payload, len)；payload=NULL 表示
 * peer-death/EOF（回调后不再调用）。proc 须已 RUN。cb 运行在读泵所在线程
 * （父 loop 线程 = JS 线程，可直接 JS_Call）。cb 传 NULL 恢复 msgq 模式。 */
void qz_proc_start_read_cb(qz_proc_t *proc, qz_proc_msg_cb_t cb,
                             void *user);

/* 宿主 create 握手后半（ISOLATED）：spawn 的 M-P1 握手 ack 之后，主RT 先
 * eval 初始脚本再 emit CONTROL{ready}——顶层 postMessage 帧可先于 ready 落
 * 通道。在 uv_read_start 注册之前用阻塞 raw-fd 帧读逐帧吃到 ready（字节
 * 精确，不与读泵抢字节）；ready 前的非-ready 帧暂存 pre_frames，由
 * qz_proc_start_read_cb 注册读泵后同步 FIFO 重放给 msg_cb。
 * 返回 0 = ready 已到（*out_ok：1 成功 / 0 主RT 初始化失败）；
 * -1 = EOF/超时/解码失败/pre-ready 帧超 QZ_PROC_PRE_FRAMES_MAX/分配失败
 *      （显式失败语义，§5.3）。 */
int qz_proc_wait_ready_raw(qz_proc_t *proc, int64_t deadline_ms, int *out_ok);

/* Opaque handle lifecycle — worker.c (compiled in mock test builds too)
 * only sees the pointer; the uv_pipe_t body stays private to ipc_process.c
 * (mock_libuv.h has no uv_pipe_t). */
qz_proc_t *qz_proc_new(void);
void qz_proc_free(qz_proc_t *proc);   /* destroy + free struct */
/* ── Liveness ping（worker 进程→sub worker，镜像 rt_host.c 的 qz_ping）──
 * 发 CONTROL{"qzjs":1,"ping":seq}（corr = seq）并阻塞等待 sub worker C 层
 * 读泵直回的 PONG（不经 JS/msgq）。等待期间 uv 读泵不跑（JS 同步调用），
 * 由本函数自 poll+recv 驱动帧解析：PONG 按 corr 配对唤醒；其它帧缓存进
 * rbuf 待读泵下次活动正常消费（无 JS 重入）。返回 0 = 通畅；1 = 超时
 * （对端 loop 阻塞）；-1 = 参数/状态错误或通道死（EOF/POLLHUP）。 */
int qz_proc_ping(qz_proc_t *proc, int32_t timeout_ms);

/* ── Child-side emit channel ──
 * The child process (qzjs-rt) registers its inherited --parent-fd here so
 * bridge.c's js_pal_worker_emit can send envelopes upstream without a
 * qz_proc_t (parent-side handle). Single channel per process. */
void qz_ipc_child_set_channel(int fd);
/* Child-side outbound queue init (spill buffer + flush timer on the child's
 * loop). fd is the inherited --parent-fd. */
void qz_ipc_child_tx_init(uv_loop_t *loop, int fd);
/* Child channel fd, -1 if unset. */
int qz_ipc_child_channel(void);
int qz_ipc_child_emit(int32_t source, int32_t target, int8_t kind,
                        int32_t corr,
                        const uint8_t *payload, uint32_t payload_len);
/* 阻塞整帧发送（M-P4 同步 storage RPC 用）：先排空 spill buffer 再 poll+send；
 * 父死亡 → -1。corr 语义同 qz_ipc_child_emit。 */
int qz_ipc_child_emit_sync(int32_t source, int32_t target, int8_t kind,
                             int32_t corr,
                             const uint8_t *payload, uint32_t payload_len);
/* M-P4 同步 storage RPC 用：同步排空出站 spill buffer；查询是否仍有未发帧。 */
void qz_ipc_child_tx_flush(void);
int qz_ipc_child_tx_pending(void);

/* ── M-P4 同步 storage RPC（§10.2 单所有者代理的传输半边）──
 * worker 进程的 localStorage 代理需要「发请求 → 阻塞等回复」的同步原语。
 * 实现（帧累加 + poll/recv 等待 + STORAGE 回复捕获）在 rt_main.c（它独占
 * 子进程管道读状态 g_rx / g_server_mode），libqzjs 侧经函数指针注册访问——
 * 与 qz_ipc_child_set_channel 同构：CLI/宿主进程不注册，pal.storageSync
 * 求值报错（worker 进程之外不可达）。
 *
 * 语义：发一条 kind=STORAGE 信封上行（target=父），阻塞等待匹配回复
 * （单飞行：JS 同步调用期间无并发——本节点自身；子树中继请求经 corr 区分，
 * 见 ipc_envelope.h field id 4）。期间到达的其它帧照常进 msgq（wake 未消费，
 * 主循环 uv_run 时统一派发，不丢帧）；父进程死亡（fd EOF）→ 置 shutting_down
 * 走孤儿自杀路径并返回 -1。 */
typedef int (*qz_ipc_storage_sync_fn)(
    qz_t *rt, const uint8_t *payload, uint32_t payload_len,
    uint8_t **out_reply, uint32_t *out_reply_len);
void qz_ipc_child_set_storage_sync(qz_ipc_storage_sync_fn fn);
int qz_ipc_child_storage_sync(qz_t *rt, const uint8_t *payload,
                                uint32_t payload_len,
                                uint8_t **out_reply, uint32_t *out_reply_len);

/* Post an envelope to child (async; 0 = queued/sent, -1 = failed). */
int qz_proc_post(qz_proc_t *proc,
                   int32_t source, int32_t target, int8_t kind,
                   int32_t corr,
                   const uint8_t *payload, uint32_t payload_len);


/* Close pipe and reap child if still alive. NULL-safe on pipe. */
void qz_proc_destroy(qz_proc_t *proc);

#ifdef __cplusplus
}
#endif

#endif /* QZ_IPC_PROCESS_H */
