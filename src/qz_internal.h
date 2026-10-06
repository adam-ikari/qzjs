#ifndef QZ_INTERNAL_H
#define QZ_INTERNAL_H

#include "qzjs/qzjs.h"
/* qz_proc_t 前置声明（ipc_process.h 全量 include 仅 worker.c 进程后端代码
 * 需要；这里只用指针。直接 include 会把 uv_pipe_t 拉进 mock 测试构建——
 * mock_libuv.h 无该类型。与 ipc_process.h 共用 guard：重复 typedef 在
 * -Wpedantic 下是错误。 */
#ifndef QZ_PROC_T_DEFINED
#define QZ_PROC_T_DEFINED
typedef struct qz_proc_s qz_proc_t;
#endif
typedef struct qz_ctx_s qz_ctx_t;   /* 前置声明：qz_proc_handle_t 用指针 */
#include <quickjs.h>

/* libuv include switch: qzjs embeds uv types (uv_loop_t etc.) BY VALUE in
 * qz_t, so the compiled struct layout must match the uv implementation
 * that the host links against. Test builds compile against mock_libuv.h
 * (deterministic offline scheduler); production builds use real libuv's
 * uv.h. The public qzjs.h stays uv-free — this switch is internal only. */
#ifdef QZ_USE_MOCK_LIBUV
#include "mock_libuv.h"
#else
#include <uv.h>
#endif

/* 句柄统一挂 rt 内嵌自持 loop（M-P7 主权裁决：库自管全部线程与 loop，
 * 宿主不注入任何东西，qzjs.h 保持 uv-free）。 */
#define RT_LOOP(rt) (&(rt)->loop)

/* C 层 JSON 一律用 vendored cJSON（<cjson.h>，deps/cjson/）——使用方
 * （control.c / ipc_process.c / debugger_dap.c）各自 include。 */
#include <stdint.h>
#include <time.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>   /* qz_close_loop 的诊断输出 */

/* libuv's intrusive queue primitives (uv__queue). Used by msgq.c as the
 * lock-free MPSC container; also needed for the qz_msg_t layout above. */
#include "queue.h"

/* Maximum concurrent timer/PAL-async handles. 256 slots balances memory
 * (qz_t grows by ~8 KB per 128 slots) against the rare case of
 * hundreds of overlapping timers or I/O operations.  When the table is
 * full, timer_start returns a RangeError. */
#define QZ_MAX_HANDLES 256

/* Maximum number of concurrent contexts per runtime. */
#define QZ_MAX_CONTEXTS 64

/* Maximum concurrent Web Workers per runtime (Task 4). A worker's id is its
 * slot index + 1 (id 0 is reserved for the host source), and tags inbound
 * messages (source = worker id, so source > 0 always means "from a worker"). */
#define QZ_MAX_WORKERS 16

/* Magic sentinel for qz_t validation — "AM" in ASCII */
#define QZ_MAGIC 0x51575254U

/* Polyfill embedding mode constants (QZ_POLYFILL_MODE compile definition).
 * 0 = rodata (const array in .rodata, default) | 1 = compressed (zlib array
 * → heap decompress at load) | 2 = external (external .polyfill file) |
 * 3 = host (host provides bytecode via qz_polyfill_load_custom()). */
#define QZ_POLYFILL_MODE_RODATA     0
#define QZ_POLYFILL_MODE_COMPRESSED 1
#define QZ_POLYFILL_MODE_EXTERNAL   2
#define QZ_POLYFILL_MODE_HOST       3
#ifndef QZ_POLYFILL_MODE
#define QZ_POLYFILL_MODE QZ_POLYFILL_MODE_RODATA
#endif

/* Silence -Wunused-parameter for fixed-signature callbacks (e.g. QuickJS
 * JSCFunction prototypes require this_val/argc/argv even when unused). */
#define QZ_UNUSED(x) ((void)(x))


/* ── I/O error codes (used by uv_io.c / bridge) ── */

typedef enum {
    QZ_OK                 =  0,
    QZ_ERR_GENERIC        = -1,
    QZ_ERR_NOT_FOUND      = -2,
    QZ_ERR_IO             = -3,
    QZ_ERR_PERMISSION     = -4,
    QZ_ERR_NETWORK        = -5,
    QZ_ERR_INVALID_ARG    = -6,
    QZ_ERR_CANCELLED      = -7,
    QZ_ERR_BUSY           = -8,
    QZ_ERR_NOT_SUPPORTED  = -9,
    QZ_ERR_TIMEOUT        = -10,
    QZ_ERR_NO_MEMORY      = -11,
} qz_err_t;

/* Async I/O completion callback: status is 0 (OK) or a qz_err_t,
 * result/len hold an optional JSON/C-string payload. */
typedef void (*qz_io_done_t)(void *opaque, int status,
                               const char *result, size_t len);

/* Streaming HTTP response callbacks (uv_io_http_request_stream). */
typedef struct qz_io_stream_ops_s {
    void (*on_headers)(void *user_data, int status, const char *headers_json);
    void (*on_data)(void *user_data, const char *data, size_t len);
    /* error_msg: human-readable diagnostic for error_status != 0 (e.g.
     * "TLS certificate verification failed", mbedtls_strerror text). Owned by
     * the callee — the pointer is only valid for the duration of the call, so
     * consumers must copy it if they keep it. NULL when there is no message
     * (success path, or a site that has nothing better than the code).
     *
     * Why this exists: error_status alone collapses every distinct failure
     * into the same opaque number. fetch's JS layer only ever saw -5
     * (QZ_ERR_NETWORK) for "connection refused", "TLS init failed",
     * "certificate verification failed" and "mbedtls handshake error
     * -0x7880" alike — making these undiagnosable from outside the library. */
    void (*on_end)(void *user_data, int error_status, const char *error_msg);
    void *user_data;
} qz_io_stream_ops_t;

/* Forward declarations */
struct qz_ext_t;

/* Web Worker (Task 4): worker = 独立 qz_t（自己的线程 + JSRuntime + loop）。
 * id = 槽位索引 + 1（0 保留给宿主 source，source>0 恒为 worker），所以
 * 入站消息用 source 标签即可区分宿主 / worker，无需额外字段。定义放这里：
 * bridge.c / qzjs.c（teardown）都要解引用 w->parent / w->id / w->thread。 */
typedef struct qz_worker_s {
    qz_t *parent;            /* 父 runtime（worker 的 JS 线程就是父线程） */
    int id;                    /* 槽位索引 + 1 = 消息 source 标签 */
    uv_thread_t thread;        /* worker 线程句柄（父 teardown 时 join） */
    qz_t *self;              /* worker 自己的 runtime（线程后端） */
    char *script;              /* worker 脚本源码 */
    int shutting_down;         /* 非 0 = 已请求退出：父线程回收槽位（worker.c
                               * qz_worker_reap：join→释放 runtime→清槽）的判据 */
    /* 注：进程后端（M-P1 的 qz_proc_t proc / script_path 字段）已随 spawn
     * 分层化移除（Phase C）——PROCESS worker 由 JS 层经 pal.processSpawn 封装，
     * C 层 qz_worker_t 仅服务线程后端。 */
} qz_worker_t;

#ifndef QZ_USE_MOCK_LIBUV
/* pal.processSpawn 句柄注册表（spawn 分层化, Phase B）。processSpawn 返回
 * 整数 handle id，JS 侧用它驱动 processPost / processOnMessage /
 * processTerminate；显式生命周期（terminate 释放），无需 GC finalizer。
 * 注册表内嵌在 qz_t（每个 runtime 至多 QZ_MAX_PROC_HANDLES 个并发
 * 进程句柄）；mock 构建无 ipc_process.c，此类型不编入。 */
typedef struct qz_proc_handle_s {
    int          id;        /* opaque handle id (>0) */
    qz_proc_t *proc;      /* IPC 通道句柄 */
    qz_ctx_t  *ctx;       /* 注册回调所在 context（JS_Call 用） */
    JSValue      onmsg;     /* JS 回调函数，未注册 = JS_UNDEFINED */
    uint8_t      live;      /* 1 = 已分配 */
} qz_proc_handle_t;
#define QZ_MAX_PROC_HANDLES 64
#endif
/* §8.2 path 链最大深度（rt 树层级上限；u16 元素，超出 65535 升 u32）。 */
#define QZ_SELF_PATH_MAX 8

/* ── Polyfill bytecode source (mode-dependent) ──
 * The symbols a polyfill_load.c expects are decided by QZ_POLYFILL_MODE.
 * The matching definitions live in the mode's generated file
 * (src/polyfill_default.c for rodata, src/polyfill_<mode>.c otherwise). */

/* C++ 测试（gtest）直接调用 qz_polyfill_load/_unload，须保持 C 链接，
 * 否则被 name-mangling 而链接失败（下方 internal helper 段同款处理）。 */
#ifdef __cplusplus
extern "C" {
#endif
#if QZ_POLYFILL_MODE == QZ_POLYFILL_MODE_RODATA
/* rodata: const array baked into .rodata (default) */
extern const uint8_t qz_default_polyfill[];
extern const size_t qz_default_polyfill_len;
#elif QZ_POLYFILL_MODE == QZ_POLYFILL_MODE_COMPRESSED
/* compressed: lz4-block-compressed array in .rodata; decompressed to heap at
 * load (block produced by build-time tool qz_lz4_compress, same vendored
 * lz4 as the LZ4_decompress_safe decoder) */
extern const uint8_t qz_default_polyfill_compressed[];
extern const size_t qz_default_polyfill_compressed_len;
extern const size_t qz_default_polyfill_orig_len;
#elif QZ_POLYFILL_MODE == QZ_POLYFILL_MODE_EXTERNAL
/* Mode B: no embedded bytecode — loaded from external .polyfill file. The
 * expected SHA-256 of the official bytecode is generated into
 * src/polyfill_external.c by polyfill/build.js (each mode emits its own file,
 * so switching modes never leaves a stale hash behind). Strong symbol on
 * purpose: a weak reference would not pull polyfill_external.o out of the
 * static archive and would bind to address 0 at load. Missing definition →
 * link error that tells the builder to (re)run build.js with this mode. */
extern const uint8_t qz_polyfill_external_sha256[32];
#endif

/* Unified polyfill bytecode loader. Returns 0 on success and sets *out
 * (bytecode pointer), *out_len, *owner (opaque handle for unload;
 * NULL in mode C). Returns a negative qz_err_t on failure. */
int qz_polyfill_load(const uint8_t **out, size_t *out_len, void **owner);
void qz_polyfill_unload(void *owner);

/* Mode D: weak hooks the host may override. Defaults return an error /
 * no-op, so the host must provide them. */
int qz_polyfill_load_custom(const uint8_t **out, size_t *out_len, void **owner);
void qz_polyfill_unload_custom(void *owner);

/* (end polyfill decls) */
#ifdef __cplusplus
}
#endif

/* Worker boot shim bytecode (compiled in from worker_boot_default.c) */
extern const uint8_t qz_default_worker_boot[];
extern const size_t qz_default_worker_boot_len;
/* Inbound message source: 0 = host; >0 = worker id (Task 4). */
typedef enum { QZ_MSG_SRC_HOST = 0 } qz_msg_src_t;

/* Inbound message FIFO flags — the queue-side projection of the envelope
 * `kind` (ipc_envelope.h §4.1). CONTROL is intercepted at the wake split point
 * (control_dispatch); PORT_TRANSFER still takes the application path but JS
 * receives kind as __qz_dispatch__'s third argument, so the port layer routes
 * by the PORT_TRANSFER header instead of guessing the payload shape (M-P3). */
#define QZ_MSG_FLAG_CONTROL       1   /* kind=CONTROL(3) */
#define QZ_MSG_FLAG_PORT_TRANSFER 2   /* kind=PORT_TRANSFER(1) */

/* flags -> envelope kind for the JS dispatch boundary (control never reaches
 * __qz_dispatch__: the wake split point consumes it). */
static inline int qz_msg_kind(uint8_t flags)
{
    return flags == QZ_MSG_FLAG_PORT_TRANSFER ? 1 /* IPC_ENV_KIND_PORT_TRANSFER */
                                                : 0 /* IPC_ENV_KIND_MESSAGE */;
}

/* Inbound message FIFO node. The queue is lock-free MPSC built on libuv's
 * uv__queue (single-linked via q.next; see msgq.c). data points into the
 * same allocation (char array after the struct header). */
typedef struct qz_msg_s {
    struct uv__queue q;   /* libuv intrusive queue node (q.next = lock-free link) */
    char *data;
    size_t len;
    int source;
    uint8_t flags;        /* QZ_MSG_FLAG_* */
} qz_msg_t;

/* Lock-free MPSC 容器（msgq.c 算法逐字复用）：tail 由生产者 ACQ_REL
 * exchange，head 恒为消费者独占，stub 为常驻哨兵。入站队列沿用 rt 内
 * 历史散装字段（msg_head/msg_tail/msg_stub），本容器用于出站邮箱。 */
typedef struct qz_mq_s {
    qz_msg_t *head;
    qz_msg_t *tail;
    qz_msg_t stub;
} qz_mq_t;

/* Per-context state — holds JSContext*, handle tables, timer data,
 * extensions, and polyfill config for reset re-injection. */
struct qz_ctx_s {
    JSContext *jsctx;
    int context_id;
    int suspended;       /* vestigial：G1 后 suspend 即销毁 ctx（槽位 NULL 即挂起态），字段保留 ABI 兼容，恒为 0 */

    void *handles[QZ_MAX_HANDLES];
    JSValue timer_resolves[QZ_MAX_HANDLES];
    void *timer_cbds[QZ_MAX_HANDLES];  /* qz_cb_data_t* for cleanup on timerStop */
    int handle_count;

    const qz_ext_t * const *extensions;  /* compile-time table (QZ_EXTENSIONS), read-only */
    int extensions_count;                    /* table length; iterate by count, skip NULL slots */

    /* Polyfill config saved for reset re-injection */
    const uint8_t *polyfill;
    size_t polyfill_len;
};

/* Callback data shared between bridge.c and qzjs.c for async operations.
 * Allocated with js_malloc, freed with js_free (or qz_free_cb_data). */
typedef struct qz_cb_data_s {
    struct qz_ctx_s *ctx;
    JSValue resolve;
    JSValue reject;
    qz_t *rt;
    int repeat;          /* 1 if this is a repeating timer */
    int handle_idx;      /* timer handle index */
} qz_cb_data_t;

/* uv_io.c in-memory storage entry (per-runtime key-value store). */
typedef struct uv_io_store_entry_t {
    char *key;
    char *value;
    size_t value_len;
} uv_io_store_entry_t;

/* Forward decl: uv_io_http_op_t is defined in uv_io.c; qz_t only holds
 * pointers into the registration list, so only the struct tag is needed
 * here. */
struct uv_io_http_op_t;

/* ================================================================
 * M-R1 §13.2 全局状态审计表（多实例安全清单）
 *
 * 一个宿主进程内 N 个 qz_t 并存（各自 qz_create/destroy 独立生命周期）。
 * per-rt 字段以下全部按 rt 归属，多实例安全；进程级全局状态逐项裁定如下
 * （docs/plans/2026-09-04-multi-process-model.md §13.2，修改全局状态时必须
 * 回到该表复核）：
 *
 * | 全局项                          | 归属           | 多实例判定 |
 * |---------------------------------|----------------|------------|
 * | polyfill 模式 C/A（.rodata）     | 进程只读共享   | 安全；各 rt 独立 lazily 缓存指针 |
 * | polyfill 模式 B（外部文件）      | per-load       | 安全；各 rt 独立读 |
 * | polyfill 模式 D（weak 符号）     | 进程级符号     | 约束：多实例共用同一宿主实现，无 per-instance 分发钩子 |
 * | JSClassID 计数器（JS_NewClassID）| 进程原子计数器 | 安全；多 runtime 自动错开（ext_* 释放时清零重分配） |
 * | bridge.c g_qz_next_port_id    | 进程原子计数器 | 安全；__atomic_fetch_add 分配，id 全局唯一即可 |
 * | ext_wamr.c g_wamr_state         | 进程单例       | 约束：原子 CAS 首次初始化（wasm_runtime_init 只跑一次）；per-thread env 按 rt 对称 init/destroy |
 * | DAP stdio 单通道                | 进程单例       | 约束：仅一个实例可缺省 stdio attach（debugger_dap.c 原子认领，冲突 -2 显式报错）；其余实例注入独立 FILE* |
 * | env / cwd / locale / malloc     | 进程共享       | 安全：常规 C 语义（qz_create 只以 overwrite=0 setenv UV_USE_IO_URING） |
 * | 信号 handler                    | qzjs 不安装    | 安全：生命周期全靠 fd/loop 语义，无信号依赖（cli.c 的 SIGPIPE ignore 属宿主进程语义） |
 * | storage（localStorage 文件）     | per-rt 独立    | v6 约束：多实例独立 store ≠ Web「同源共享」；单所有者收敛随 M-P4 kind=STORAGE 落地（§10.2） |
 * ================================================================ */
struct qz_t {
    uint32_t magic;      /* QZ_MAGIC — set in qz_create, validates opaque ptr */
    JSRuntime *jsrt;

    /* thread + loop (execution model A: qzjs owns a thread running the libuv
     * loop)。ISOLATED 宿主 rt 同样自带线程与 loop——该线程即库宿主侧线程
     * （M-P7 主权裁决：库自管一切线程/loop，宿主零注入零回调）。 */
    uv_loop_t loop;
    uv_thread_t thread;
    uv_async_t wake;         /* host post_message wakeup; data = rt */

    /* inbound FIFO (lock-free MPSC: many producers push, the qzjs thread
     * exclusively consumes). msg_tail is the atomic tail (producers exchange),
     * msg_head is consumer-only. msg_stub is the resident sentinel: after
     * init, msg_head == msg_tail == &msg_stub. */
    qz_msg_t *msg_head;
    qz_msg_t *msg_tail;
    qz_msg_t msg_stub;

    /* outbound mailbox（M-P7）：库 → 宿主方向消息的 per-rt FIFO。生产者 =
     * 库宿主侧线程/JS 线程（读回调解帧、CONTROL 回执、崩溃上报），单消费者 = 宿主
     * recv 线程（qzjs.h 消费协议）。out_efd = eventfd 唤醒计数（push 先入链
     * 后 write）；free 时未消费节点连同 stub 排干释放。 */
    qz_mq_t mq_out;
    int out_efd;             /* eventfd；-1 = 未创建/已关闭 */
    int out_claim;           /* atomic: qz_recv_message 的「消费者在场」标记。
                              * 抢不到的一方直接报错返回 -1，而不是并发弹一个
                              * lock-free MPSC 队列。per-call（进抢出放），所以
                              * 「A 排干完交给 B」这种顺序移交仍然合法。
                              * 生产恒 0（rt 由 calloc 分配）。*/
    int out_fault;           /* atomic: 测试注入——让接下来这么多次 qz_out_push
                              * 的主分配强制失败（走 OOM 标记路径）。生产恒 0
                              * （rt 由 calloc 分配）。写者有两个：qz_test_mailbox_fault
                              *（设值）与 msgq.c 的 qz_out_push（饱和递减），两边都是
                              * 原子访问，不要加非原子读。*/

    int shutting_down;   /* atomic: set by destroy -> thread leaves main loop */
    int wait_idle;       /* atomic: qz_wait_idle requested: auto-exit when idle */
    int thread_ready;    /* atomic: ready handshake: thread init complete */
    int ready_err;       /* init failure code (0 ok; non-zero -> qz_create returns NULL) */
    int thread_joined;   /* atomic: 拆除已完成（线程后端 = uv_thread_join 已做，双 join 是 UB；ISOLATED 宿主 = 库宿主侧线程已收尸，幂等门） */

    /* config copy (initial_script strdup'd by qz_create, freed by destroy) */
    qz_config_t config;
    /* strict mode 深拷贝（config.sandbox_root/env_allowlist 是宿主缓冲指针，
     * qz_create strdup/深拷贝到这里由 rt 拥有，destroy 释放）。
     * strict_mode==0 时均为 NULL，检查代码直接判 rt->config.strict_mode。 */
    char *strict_root;          /* sandbox_root 深拷贝 */
    char **strict_env_allow;    /* env 白名单深拷贝（NULL 结尾 char* 数组）*/
    /* 内部出站钩子（非公共 API）：仅主RT 子进程由 rt_main.c 挂
     * server_emit_cb → qz_post_to_host 走进程上行；宿主 rt 恒 NULL → 入邮箱。 */
    void (*host_emit)(qz_t *rt, const char *json, size_t len);
    int debug;

    /* uv_io.c in-memory storage（storage_get/set/del 的键值区，destroy 回收） */
    uv_io_store_entry_t *store;
    int storage_max;     /* 存储条目上限（uv_io 用 PAL_UV_STORAGE_DEFAULT） */
    int store_count;

    /* 活跃流式 HTTP op 注册表：per-op abort（pal.httpRequestAbort(opId)）
     * 与 teardown（uv_io_http_abort）都按它遍历，支持任意数量的并发
     * in-flight 请求各自被精确中止。op 终结（uv_io_http_cleanup）时从
     * 链表摘除，故 abort 永远只命中存活 op。空链表时 abort 是 no-op。 */
    struct uv_io_http_op_t *http_ops;
    uint64_t http_op_seq;   /* 单调递增 op id 分配器（0 = 无效 id） */

    /* Proxy-Authorization 缓存：同一代理 URL（含 user:pass userinfo）的
     * "Basic base64(user:pass)" 头在整个 runtime 生命周期只计算一次。
     * qzjs.c teardown 释放。op 持有借用指针（op->proxy_auth），teardown 前
     * 所有 in-flight op 已中止清理，故无悬垂。 */
    char *proxy_auth_url;    /* 已计算缓存的代理 URL（含凭据），NULL = 未缓存 */
    char *proxy_auth_value;  /* "Basic <b64>" 头值，NULL = 代理无凭据 */

    /* 运行时 CA 信任库：宿主经 qz_add_ca_pem() 追加的 PEM 证书，多次追加以
     * '\n' 分隔，末尾保留 NUL（mbedtls_x509_crt_parse 要 NUL 终止缓冲）。
     * ca_pem_len **不含**末尾 NUL，故 parse 时传 ca_pem_len + 1。
     *
     * TLS op 建连时在系统 CA **之后**追加解析进自己的 op->ca_certs ——追加
     * 信任根，不替换系统根（mbedtls_x509_crt_parse 追加到已有链）。
     * 这里只存 PEM 字节、不存 mbedtls_x509_crt：那份结构随 op 生命周期创建/
     * 释放，跨 op 共享会引入悬垂；各 op 各自解析是唯一无共享的做法。
     *
     * 非 TLS 构建（QZ_WITH_TLS=OFF）下 qz_add_ca_pem 仍可写（定义不在 TLS
     * 条件编译内，公共头无条件声明），只是没有消费点。qzjs.c teardown 释放。 */
    char   *ca_pem;
    size_t  ca_pem_len;      /* 已用字节数，不含末尾 NUL */
    size_t  ca_pem_cap;      /* 已分配容量（含末尾 NUL） */
    qz_ctx_t *contexts[QZ_MAX_CONTEXTS];  /* array of context pointers */
    int context_count;
    int active_ctx_id;   /* -1 if no active context */

    /* Polyfill bytecode cache: loaded once (lazily at first context creation),
     * shared by all contexts, unloaded at runtime teardown. polyfill_owner is
     * the opaque handle to free (NULL in mode C; heap ptr in modes A/B). */
    const uint8_t *polyfill;
    size_t polyfill_len;
    void *polyfill_owner;

    /* Web Worker (Task 4): worker_self is set on a worker's own qz_t (points
     * back to its qz_worker_t, non-NULL → this runtime is a worker); the
     * parent runtime keeps its workers table (worker id = slot index). Both
     * are only touched by the owning qzjs thread. */
    void *worker_self;
    qz_worker_t *workers[QZ_MAX_WORKERS];

    /* §8.2 端点身份 = path 链（自 rt 树根起逐级的父槽位 id）。根（主RT/宿主
     * runtime）= 空 path；子 = 父 path ++ [父分配的槽位 id]。IPC 路由按 path
     * 前缀比较决定「上转 / 本地投递 / 下投」，LCA 中继由此自然涌现。元素 u16
     * （PROCESS worker id 现为 1000+；超出 65535 时升 u32，见 ipc_envelope.h）。 */
    uint16_t self_path[QZ_SELF_PATH_MAX];
    uint8_t  self_path_len;

#ifndef QZ_USE_MOCK_LIBUV
    /* §8.2/§10.2 STORAGE 中继（N-P4 + 并发关联 id）：非根 runtime 收到子树
     * 发来的 storage 请求时向上转发，登记「上行 corr → 发起子槽位 + 下行
     * corr」；owner（根 runtime）的回复沿父通道回来时按 corr 配对下投（不再
     * 靠到达序，自身同步 RPC × 子树在途请求可并发而不错配）。corr 由
     * storage_corr_seq 单调分配（0 恒无效 = 信封缺省）；表满（并发子树请求
     * 超过槽位数）→ 新请求拒绝，维持 §10.2 单飞行兜底语义。 */
    struct qz_storage_relay_s {
        int32_t up_corr;    /* 本节点分配、上行帧携带的关联 id（>0） */
        int32_t down_corr;  /* 发起子进程帧携带的关联 id（回复原样回传） */
        int child;          /* 发起子进程槽位 id */
    } storage_relays[QZ_MAX_PROC_HANDLES];
    int32_t storage_corr_seq;   /* 本节点全部出站 storage 帧共用计数器 */
    /* pal.processSpawn 句柄注册表（spawn 分层化, Phase B）+ id 分配器。
     * 仅父 runtime（worker_self == NULL）使用；teardown 统一清理残留句柄。 */
    qz_proc_handle_t proc_handles[QZ_MAX_PROC_HANDLES];
    uint32_t proc_handle_seq;   /* handle id 单调分配器（0 = 无效） */

    /* ── M-P2 宿主↔主RT 通道（QZ_PROCESS_MODEL=ISOLATED）──
     * 宿主进程：proc = 主RT 子进程通道（句柄挂宿主注入 loop，由驱动该 loop 的
     * 宿主线程独占读写）；主RT 进程：ipc_channel_pipe = parent-fd 读管道。后者恒活动（duplex 读回调），必须被
     * wait_idle 的 idle 判定豁免，否则主RT 永不判 idle（与 JS-managed worker
     * pipe 同因，见 qz_proc_handle_is_pipe）。进程自身只有一个对端通道，指针
     * 级判定即足够。THREAD 编译下恒为 NULL（宿主走线程后端）。 */
    qz_proc_t *proc;              /* ISOLATED 宿主：主RT 通道句柄 */
    uv_pipe_t   *ipc_channel_pipe;  /* 主RT 进程：宿主通道读管道（idle 豁免） */
    int          idle_ack;          /* atomic: 主RT 已回 CONTROL{idle} ack */
    /* liveness ping/pong（宿主↔主RT C 层直回，检测对端 uv loop 阻塞）：
     * ping_seq = 发起方分配的单调序号（宿主线程写）；pong_seq = 最近收到
     * 的 PONG 回显序号（宿主 loop 线程读回调写）。compare 判定 loop 通畅。 */
    int32_t      ping_seq;          /* atomic: 宿主线程写的探测序号 */
    int32_t      pong_seq;          /* atomic: 宿主读回调回填的应答序号 */
    int32_t      ping_fail;         /* atomic: 跨层 ping 转发失败回执的 seq
                                     * （pfail corr，qz_ping_path 快速 -1） */
#endif


    /* Per-runtime extension state. QuickJS registers classes per-JSRuntime,
     * and one qz_t owns one JSRuntime, so these live here (not per-context).
     * void* for engine types (e.g. wasm3 IM3Environment) to keep this header
     * free of third-party includes; ext_*.c cast as needed. */
#if QZ_WITH_WASM3
    JSClassID wasm3_module_class_id;
    JSClassID wasm3_instance_class_id;
    JSClassID wasm3_func_closure_class_id;
    JSClassID wasm3_import_closure_class_id;
    JSClassID wasm3_memory_class_id;
    JSClassID wasm3_table_class_id;
    JSClassID wasm3_global_class_id;
    void *wasm3_env;   /* IM3Environment */
#endif
#if QZ_WITH_WAMR
    JSClassID wamr_module_class_id;
    JSClassID wamr_instance_class_id;
    JSClassID wamr_global_class_id;
#endif
#if QZ_WITH_COMPRESS
    JSClassID compress_deflate_class_id;
    JSClassID compress_inflate_class_id;
#endif
#if QZ_WITH_CRYPTO_EXT
    /* Per-runtime EC RNG (mbedtls_entropy_context / mbedtls_ctr_drbg_context).
     * Lazy-seeded on first EC op; one DRBG per runtime so concurrent
     * runtimes (workers on their own threads) never share a CTR_DRBG
     * without synchronization. Freed in crypto_ext_destroy. */
    void *ec_entropy;
    void *ec_drbg;
    int ec_rng_ready;
#endif

    /* tcp_io.c TCP client/listener handle classes (production builds only;
     * tcp_io.c is excluded from mock-libuv test builds). */
    JSClassID tcp_client_class_id;
    JSClassID tcp_listener_class_id;

    /* http-server ext-level state (serve() teardown) */
    void *http_server_state;

#ifdef QZ_DEBUG_SUPPORT
    /* DAP debugger session (NULL when no debugger attached). Opaque here to
     * keep this header free of qz_debug.h; src/debugger.c casts. Named
     * dbg_session to avoid clashing with the legacy `int debug` log flag. */
    void *dbg_session;
    /* DAP protocol layer (NULL when no DAP attached). Opaque here; owned by
     * src/debugger_dap.c. Per-runtime, so multiple runtimes (e.g. a worker)
     * each get their own DAP state. */
    void *dap;
    /* Periodic timer that keeps uv_run bounded while a DAP session is open:
     * DAP messages arrive on stdin, which is NOT a libuv event source, so an
     * idle loop would otherwise block forever in poll and never service
     * pause/setBreakpoints/disconnect. The timer wakes uv_run every 50 ms; its
     * callback (qz_dap_service) non-blockingly drains stdin. dap_timer_active
     * marks it running so the wait_idle walk can exclude it from "busy". */
    uv_timer_t dap_timer;
    int dap_timer_active;
#endif

    /* ── Control plane (CTL-0) ──
     * ctl_interrupt: atomic flag read by the QuickJS interrupt handler
     *   (JS_SetInterruptHandler, installed in qz_runtime_init). Set by
     *   qz_control on the producer thread — §1.1 例外：单方向写、引擎
     *   线程只读，不破坏 JSRuntime 单线程所有权。
     * ctl_lock: receipt table lock (insert = producer, remove/reap = qzjs
     *   thread exclusive；§1.2 一把表内锁，竞争面 = 命令入队频率)。
     * ctl_pending: correl → receipt 条目链表 {correl, deadline_ns, next}。 */
    int ctl_interrupt;
    uv_mutex_t ctl_lock;
    struct qz_ctl_recept_s *ctl_pending;
    /* ── Control plane 本地端点（CTL-2, §2.3）──
     * ctl_listener/ctl_listener_active：LOCAL 档的 AF_UNIX 监听（loop 线程
     *   独占；active 时被 idle 判定豁免——监听是基础设施句柄，不算"忙"）。
     * ctl_conns：活跃连接链表（loop 线程独占；连接关闭时清理其名下回执条目）。
     * ctl_pipe_path：端点实际路径（strdup；teardown 时 unlink + free）。
     * mock 构建（QZ_USE_MOCK_LIBUV）无 uv_pipe，整块不编入。 */
#ifndef QZ_USE_MOCK_LIBUV
    uv_pipe_t ctl_listener;
    int       ctl_listener_active;
    struct qz_ctl_conn_s *ctl_conns;
    char     *ctl_pipe_path;
#endif
};

/* ================================================================
 * Internal helper functions
 * ================================================================ */
/* 内部函数为 C 链接;C++ 测试(如 gtest)直接调用时须保持 C 符号,
 * 否则被 name-mangling 而无法解析(测试构建才 include 本头)。 */
#ifdef __cplusplus
extern "C" {
#endif

/* msgq.c — thread-safe inbound FIFO + outbound mailbox（同一 MPSC 算法两实例） */
int qz_msg_push(qz_t *rt, const char *data, size_t len, int source, int flags);
qz_msg_t *qz_msg_pop(qz_t *rt);
int qz_msg_has_pending(qz_t *rt);   /* 消费者线程内检查队列非空（无锁读） */
void qz_msg_free(qz_msg_t *m);

void qz_out_mq_init(qz_t *rt);                  /* create 期初始化邮箱 */
int  qz_out_push(qz_t *rt, const char *json, size_t len); /* 入箱 + eventfd 写 */
/* 测试钩子：让 rt 接下来 N 次 qz_out_push 的主分配强制失败（N=0 关），用于直接
 * 验「OOM 时宿主能在流上看见标记帧」。生产恒 0，因此分支恒不成立。
 * per-rt 作用域——刻意不做成 env/全局：那等于在生产库里留一个静默丢消息的
 * 总开关，且同进程多个 rt 会共享额度。详见 src/msgq.c 的形态说明。
 * 用例见 test/test_mailbox_oom_gtest.cpp。 */
void qz_test_mailbox_fault(qz_t *rt, int n);
qz_msg_t *qz_out_pop(qz_t *rt);                 /* 宿主 recv 线程（单消费者） */
int  qz_out_has_pending(qz_t *rt);
void qz_post_to_host(qz_t *rt, const char *json, size_t len); /* 出站唯一漏斗 */
void qz_mailbox_teardown(qz_t *rt); /* 排干邮箱+关 out_efd（幂等；qzjs.c，join 后调用） */

/* thread.c — the qzjs thread: uv loop + wake dispatch + microtask flush */
void qz_thread_main(void *arg);
/* idle 判定（thread.c）：除内部 wake async / 恒活动 IPC pipe 外无活动 handle
 * 且入站队列空 → 1。thread 后端主循环与 M-P2 主RT 进程共用。 */
int qz_loop_idle(qz_t *rt);

/* M-P2：宿主↔主RT 进程分离路径已编入（ISOLATED 非 mock 构建）。 */
#if defined(QZ_PROCESS_MODEL_ISOLATED) && !defined(QZ_USE_MOCK_LIBUV)
#define QZ_HOST_SPLIT 1
/* rt_host.c — 宿主侧主RT 通道后端 + 库自管宿主侧线程（M-P7 主权回归）：
 * loop_init → blob 落盘 → spawn 主RT → raw-fd 同步等 CONTROL{ready}
 * （pre-ready 帧暂存）→ wake init → 读回调注册（pre-ready 帧重放入邮箱）→
 * 起库宿主侧线程（uv_run ONCE 循环 + EOF/DEAD 检测 + 退出路径上自收主RT：
 * ≤2s 三级终止预算冻结在宿主侧线程内，调用线程只 join）。通道句柄挂 rt 内嵌
 * loop；出站消息一律入邮箱，qzjs 不调用任何宿主函数。
 * qz_host_start 返回 0 = 已就绪；非 0 = 显式失败（不降级，§5.3）。
 * qz_host_destroy 释放 rt 本身。 */
int  qz_host_start(qz_t *rt);
int  qz_host_post(qz_t *rt, const char *json, size_t len);
void qz_host_wait_idle(qz_t *rt);
void qz_host_destroy(qz_t *rt);
#endif

/* qzjs.c — runtime init / eval / teardown (called from thread.c) */
int  qz_runtime_init(qz_t *rt);
int  qz_eval_internal(qz_t *rt, const char *script, char **err);
int  qz_eval_bytecode_internal(qz_t *rt, const uint8_t *code, size_t len,
                                 char **err);
void qz_thread_teardown(qz_t *rt);
#ifdef QZ_DEBUG_SUPPORT
/* debugger_dap.c — service the DAP stdin channel from the qzjs thread while
 * the debuggee is NOT paused (the paused loop runs inside on_stopped).
 * Called by the DAP poll timer so an idle uv_run never blocks forever on a
 * DAP pause/setBreakpoints/disconnect that arrived on stdin. */
void qz_dap_service(qz_t *rt);
#endif

/* thread.c — flush pending JS microtasks (worker.c calls this on its loop) */
int qz_flush_microtasks(qz_t *rt);
/* worker.c — worker-runtime inbound dispatch: raw cloned bytes →
 * __qz_dispatch__(bytes, 0, kind). Used by the worker thread loop AND by the
 * process-backend child (rt_main.c) — same shim semantics. kind is projected
 * from the msgq flags (qz_msg_kind) so the port layer can tell a
 * PORT_TRANSFER frame from a plain MESSAGE. */
void qz_worker_dispatch(qz_t *rt, qz_msg_t *m);

/* worker.c — real-thread Web Workers. Parent-thread-only API (the parent qzjs
 * thread is the only one touching the workers table). qz_worker_create blocks
 * until the worker thread is ready; on failure sets *out_err (qz_err_t) and
 * returns NULL. */
qz_worker_t *qz_worker_create(qz_t *parent, const char *script, int *out_err);
void qz_worker_post(qz_t *parent, qz_worker_t *w,
                      const uint8_t *bytes, size_t len, uint8_t flags);
void qz_worker_terminate(qz_t *parent, qz_worker_t *w);
qz_worker_t *qz_worker_get(qz_t *parent, int id);
void qz_worker_free(qz_worker_t *w);
/* JS-managed 进程句柄（pal.processSpawn）的 IPC pipe 豁免检查 —— 替代已
 * 移除的 qz_worker_is_proc_handle（C 层进程 worker 分流, Phase C）。
 * ipc_process.c 定义，thread.c 在 wait_idle 豁免这些恒活动 pipe。 */
int qz_proc_handle_is_pipe(qz_t *rt, uv_handle_t *h);

/* context.c — context lifecycle helpers */
qz_ctx_t *qz_get_active_ctx(qz_t *rt);
JSContext *qz_get_active_jsctx(qz_t *rt);
qz_ctx_t *qz_get_ctx_by_id(qz_t *rt, int context_id);
qz_ctx_t *qz_ctx_create(qz_t *rt, const qz_config_t *config);
void qz_ctx_destroy(qz_t *rt, qz_ctx_t *ctx);

/* context.c — multi-context + soft suspend/resume (Task 5). 全部由父（主
 * context）线程调用；宿主只见主 context，spawn/suspend/resume/destroy 由
 * polyfill 的 qzContext 经 bridge 驱动。目标 ctx_id 若 == active（正在执行
 * JS 的 ctx）返回 QZ_ERR_BUSY——不能挂起/销毁/重建自己正在运行的 context。 */
int qz_ctx_spawn(qz_t *rt, const char *init_script);   /* 返回 ctx id 或 <0 */
int qz_ctx_serialize(qz_t *rt, int ctx_id, const char *state_path);
int qz_ctx_rebuild(qz_t *rt, int ctx_id, const char *script_ref, const char *state_path);
int qz_ctx_destroy_id(qz_t *rt, int ctx_id);

/* bridge.c — recover qz_t* from a JSRuntime* (finalizers get JSRuntime*).
 * Returns NULL if the runtime was not created by qzjs (magic check). */
qz_t *qz_get_rt_from_jsrt(JSRuntime *jsrt);

/* bridge.c — recover qz_t* from a JSContext* (non-static so extensions
 * with a JSContext* can use it). Equivalent to qz_get_rt_from_jsrt. */
qz_t *qz_get_rt_from_ctx(JSContext *ctx);
void qz_ctx_cleanup_resources(qz_t *rt, qz_ctx_t *ctx);

/* extension.c — extension lifecycle hooks */
int qz_ext_init_all(qz_t *rt, qz_ctx_t *ctx);
void qz_ext_destroy_all(qz_t *rt, qz_ctx_t *ctx);
int qz_ext_suspend_all(qz_t *rt, qz_ctx_t *ctx);
int qz_ext_resume_all(qz_t *rt, qz_ctx_t *ctx);

/* bridge.c — creates the internal pal JS object (per-context version) */
JSValue qz_create_pal_object_ctx(qz_t *rt, qz_ctx_t *ctx);

/* bridge.c — inject polyfill via __native_inject__ temp global (per-context version) */
int qz_inject_polyfill_ctx(qz_t *rt, qz_ctx_t *ctx, const uint8_t *code, size_t code_len);

/* bridge.c — dispatch an inbound message to the main context's
 * __qz_dispatch__ (source 0 = host JSON, parsed; >0 = worker bytes). */
void qz_dispatch_message(qz_t *rt, qz_msg_t *m);

/* bridge.c — free a qz_cb_data_t: releases resolve/reject JSValues and
 * calls js_free on the allocation.  Safe to call with NULL. */
void qz_free_cb_data(JSContext *ctx, void *cbd);

/* bridge.c — cancel a live timer slot: uv_stop + uv_close (struct freed by
 * the close callback) + free resolve/cbd.  Used by js_pal_timer_stop and by
 * qz_ctx_cleanup_resources (context.c).  Safe when the slot is NULL. */
void qz_timer_cancel(qz_ctx_t *cctx, int idx);

/* uv_io.c — async I/O entry points.  Done callbacks fire on the qzjs
 * thread's loop (执行模型 A), so the bridge JS_Calls resolve/reject directly.
 * rt->loop / rt->store are owned here; qzjs.c frees rt->store at teardown. */
void uv_io_storage_get(qz_t *rt, const char *key,
                       qz_io_done_t cb, void *cb_data);
void uv_io_storage_set(qz_t *rt, const char *key,
                       const char *value, size_t value_len,
                       qz_io_done_t cb, void *cb_data);
void uv_io_storage_del(qz_t *rt, const char *key,
                       qz_io_done_t cb, void *cb_data);
/* Zero-copy fs_read: alloc_fn runs on the qzjs loop thread right after open,
 * with the file size from fstat; it returns a backing store that receives the
 * bytes directly (no intermediate copy). On success the backing is handed to
 * the done callback and NOT freed by uv_io; on read error free_fn releases it
 * before the done callback fires. If alloc_fn returns NULL (or the file grows
 * past the backing store) uv_io falls back to a plain malloc buffer and the
 * done callback must synthesize the result. */
typedef void *(*qz_fs_alloc_fn)(void *ud, size_t size, void **owner);
typedef void (*qz_fs_free_fn)(void *ud, void *owner);
void uv_io_fs_read_ex(qz_t *rt, const char *path,
                      qz_io_done_t cb, void *cb_data,
                      qz_fs_alloc_fn alloc_fn, qz_fs_free_fn free_fn,
                      void *alloc_ud);
void uv_io_fs_read(qz_t *rt, const char *path,
                   qz_io_done_t cb, void *cb_data);
void uv_io_fs_write(qz_t *rt, const char *path,
                    const char *data, size_t data_len,
                    qz_io_done_t cb, void *cb_data);
void uv_io_fs_exists(qz_t *rt, const char *path,
                     qz_io_done_t cb, void *cb_data);
void uv_io_http_abort(qz_t *rt);

/* 把 rt->ca_pem（qz_add_ca_pem 追加的信任根）解析进 chain，追加语义。
 * 内部函数（仅 TLS 构建存在），暴露给回归测试直接验证 —— 见 uv_io.c 处的
 * 说明：测试须调生产代码，不能自己复现 mbedtls parse。 */
#if QZ_WITH_TLS
/* mbedtls_x509_crt 的前向声明（本头不 include mbedtls 头，同 struct
 * uv_io_http_op_t 的做法）；实现在 uv_io.c 里用真类型。 */
struct mbedtls_x509_crt;
int uv_io_tls_load_host_ca(qz_t *rt, struct mbedtls_x509_crt *chain);
#endif
/* Abort a specific in-flight streaming HTTP op by id (pal.httpRequestAbort).
 * Safe to call with a stale/unknown id: no-op. */
void uv_io_http_abort_by_id(qz_t *rt, uint64_t op_id);
void uv_io_http_request(qz_t *rt, const char *url, const char *method,
                        const char *headers, const char *body, size_t body_len,
                        qz_io_done_t cb, void *cb_data);
/* Returns the op id (uint64) of the started streaming request, or 0 if it
 * failed synchronously (invalid args / OOM / bad proxy URL / no TLS). */
uint64_t uv_io_http_request_stream(qz_t *rt, const char *url, const char *method,
                                   const char *headers, const char *body,
                                   size_t body_len, qz_io_stream_ops_t *ops);
void uv_io_fs_remove(qz_t *rt, const char *path,
                     qz_io_done_t cb, void *cb_data);
void uv_io_fs_list(qz_t *rt, const char *path,
                   qz_io_done_t cb, void *cb_data);

/* uv_io.c — synchronous helpers the bridge inlines (time_now uses uv_now on
 * rt->loop; hrtime/log/random_bytes are standalone). */
/* control.c — CTL-0 控制面：命令入队 + wake 分流点派发 + 回执表。
 * 设计：docs/plans/2026-09-04-control-plane-design.md §1-§3。 */
struct qz_ctl_recept_s;
/* 入队控制命令（producer 线程）。OFF 时恒 -1。 */
int qz_control(qz_t *rt, const char *bytes, size_t len);
/* wake 分流点派发（qzjs 线程独占）：解析 JSON、按 op 执行、组回执。
 * WAKE_SAFEPOINT 类就地执行（eval/inspect/metrics/interrupt/events.subscribe）。
 * IDLE_SAFEPOINT 类（ctx.suspend/ctx.destroy/worker.terminate/runtime.shutdown）
 * 转 wait_idle 通道——CTL-0 仅执行 WAKE 类四命令，IDLE 类返回 NOT_SUPPORTED。 */
void qz_control_dispatch(qz_t *rt, qz_msg_t *m);
/* 主循环每轮调用：扫描过期回执条目，发 TIMEOUT 回执并回收（qzjs 线程独占）。 */
void qz_ctl_reap_timeouts(qz_t *rt);
/* teardown 时回收所有未完成回执条目（无回执发出，发起方靠 timeout 侧超时）。 */
void qz_ctl_teardown(qz_t *rt);
/* interrupt handler（QuickJS 回调）：读 ctl_interrupt 原子标志。 */
int qz_ctl_interrupt_handler(JSRuntime *jsrt, void *opaque);
/* 本节点在父树中的槽位 id（宿主 0 / 主RT 1 / worker --worker-id）。 */
int32_t qz_ctl_local_id(qz_t *rt);
/* 回执表：登记 correl 条目（producer 线程，锁内插入）。reply_dir 为
 * 跨进程回程方向（CTL-1）：-1 = 本地邮箱；>=0 = 回执信封 target
 * （命令来源地址，逐跳相对寻址语义，见 control.c qz_control_route）。
 * sink 为 CTL-2 端点连接（非 NULL 时回执写回该连接，优先于 reply_dir）。 */
void qz_ctl_register(qz_t *rt, const char *correl, uint64_t deadline_ns,
                       int32_t reply_dir, void *sink);

/* ── CTL-1：信封 CONTROL 命令的树路由（§2.2 / 多进程 §4.3、§7.2）──
 *
 * 逐跳相对寻址（接收方视角）：target == 本地槽位 id → 命中本地（入 msgq
 * flags=CONTROL）；target ∈ {0,1} 且非本地 → 上行（父/宿主方向）；target > 1
 * → 下行到本地子槽位 target；无对应通道 → 丢弃。source 全程保持（承载回程
 * 方向），只有 target 逐跳改写。
 *
 * local_id：本节点在父树中的槽位 id（宿主 0 / 主RT QZ_IPC_MAIN_ID / worker
 *   --worker-id）。仅 qzjs 线程调用（信封读回调中）。 */
typedef enum {
    QZ_CTL_ROUTE_LOCAL = 0,   /* 命中本地：入 msgq 交 dispatch */
    QZ_CTL_ROUTE_UP    = 1,   /* 上行：发父通道（改写 target 后） */
    QZ_CTL_ROUTE_DOWN  = 2,   /* 下行：发本地子槽位 target */
    QZ_CTL_ROUTE_DROP  = 3,   /* 无对应通道 */
} qz_ctl_route_t;

/* 纯函数：路由决策（无副作用，便于单测）。 */
qz_ctl_route_t qz_ctl_route_decide(int32_t local_id, int32_t target);

/* 路由一条 CONTROL 命令信封（读回调调用；OFF 档丢弃，§4.1）。返回 0 = 已处理。 */
int qz_control_route(qz_t *rt, int32_t local_id, int32_t source,
                       int32_t target, const uint8_t *payload, uint32_t len);

/* 命令 JSON 的可选 "target" 字段（C 层提取；缺省 1 = 接收方自身）。
 * 生产者/路由路径用，无需 JSContext。 */
int32_t qz_ctl_cmd_target(const char *json, size_t len);

/* ── CTL-2：本地端点 + 端点回执 sink（§2.3）──
 *
 * 端点只做生产者：连接上的每行 JSON 走 qz_control_sink 同一入口（不引入
 * 第二执行路径），回执按条目 sink 写回该连接；无 sink 则走邮箱/信封。
 * control_endpoint.c 仅在真实 libuv 构建编入（mock 构建无 uv_pipe）；mock 下
 * qz_ctl_endpoint_* 由 control.c 提供 no-op stub。 */
int  qz_ctl_endpoint_init(qz_t *rt);    /* 0 = 已监听（bind+listen+0600） */
void qz_ctl_endpoint_close(qz_t *rt);   /* 关监听+连接，unlink 端点文件 */
int  qz_ctl_endpoint_owns(qz_t *rt, void *h);   /* idle 豁免判据 */
/* 端点连接关闭：清理回执表里 sink 指向该连接的条目（防悬垂）。 */
void qz_ctl_conn_drop(qz_t *rt, void *conn);
/* 端点连接回写（一行一条回执；loop 线程独占）。 */
void qz_ctl_conn_write(void *conn, const char *json, size_t len);
/* 入站 CONTROL 回执投递（target 命中本地）：按回执表条目把回执交给端点
 * 连接 / 继续沿树上行/邮箱，并消费条目。 */
int qz_ctl_deliver_receipt(qz_t *rt, const uint8_t *payload, uint32_t len);
/* 端点命令入口：命令 JSON 的 target 决定本地执行还是树转发；回执一律写回
 * sink 连接（CTL-2 §2.3：端点只是生产者，执行路径与 qz_control 同一套）。
 *
 * **返回码是契约，端点按它决定回不回帧**（control_endpoint.c 的分帧循环）：
 *    0   命令已被接受（本地执行或已前投）。path 前投成功时**没有**同步回执，
 *        回执稍后沿树回来。
 *   -2   **拒收**：缺 correl。端点回一帧 ok:false / code=INVALID_ARG，
 *        correl 字段显式为 null（无从回显，所以写 null 而不是省略）。
 *   -3   **拒收**：顶层带数字 "qzjs" 键（通道层保留命名空间）。code=INVALID_ARG，
 *        且**回显 correl**（这条命令的 correl 是拿得到的：先校验它非空、再判命名
 *        空间）——与 -2 相反，-2 才是 correl:null。
 *   -4   命令没能进队列（qz_msg_push 失败）。**不会有回执**，所以端点必须当场
 *        回一帧 ok:false / code=INTERNAL，否则客户端干等到超时。
 *   -5   前投失败，但 NOT_FOUND 帧已由本函数当场写出（已 ctl_unregister）——端点
 *        **不得**为它再发一帧。两条远端前投路径（§8.2 的 target_path 早返回、以及
 *        非 path 的远端 target）都归到这个码。
 *   -1   其余（rt/magic 非法、control_plane 非 LOCAL、malloc 失败）。端点回
 *        ok:false / code=INTERNAL。
 *
 * 也就是说：除 0 与 -5 外，端点对**每一个**非零都回帧。判据是「客户端能不能只靠
 * 连接上的帧判断这条命令的结局」——不能，就该说话。
 *
 * correl_out（可为 NULL）：提取到 correl 时写入 strdup 副本，调用方 free；没有则
 * 写 NULL。端点用它给 -3 的帧回显 correl——协议按 correl 配对，而 -3 的 correl
 * 是拿得到的，一帧不带 correl 的回执对客户端毫无用处。
 *
 * **已知残留**：-2（缺 correl）的帧按协议无法带 correl，而拒收帧是**同步**写的、
 * 正常回执是**异步**写的，所以一次写多条命令时，客户端按**位置**配对会错位
 * （第 2 条的拒收帧可能先于第 1 条的回执到达）。按 correl 配对可解决 -3 那种，
 * -2 只能靠顺序。要彻底解决需把拒收也走异步回执路径（届时它也受回执表与超时
 * 回收约束），那是另一次改动，暂未做。
 *
 * 帧级判据见 test/probe_ctl_reject_frames.c（逐帧用 cJSON 真解析；用 strstr
 * 写断言抓不到「JSON 非法」这一类，而这里第一版就踩过）。 */
int qz_control_endpoint_cmd(qz_t *rt, const char *bytes, size_t len,
                              void *sink, char **correl_out);
/* 命令入队 + 指定回执 sink（NULL = 进程内邮箱 / 跨进程信封路径）。 */
int qz_control_sink(qz_t *rt, const char *bytes, size_t len, void *sink);

/* Monotonic clock in milliseconds. Ignores clock_gettime failure (same
 * behavior the former per-file copies had): CLOCK_MONOTONIC cannot fail with
 * EINVAL, so worst case the caller sees a stale/zero timestamp. */
static inline int64_t qz_now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
/* ── Cross-file small helpers (shared, header-inline in C99) ── */

/* 关 loop，并把返回值说出来。uv_loop_close 非 0 = EBUSY，还有 handle 没关
 * （stop 过但没 close、或 close 回调没跑完）——此时 loop 内部结构仍被这些
 * handle 引用，绝不能 free 回收，泄漏是唯一安全选择。静默忽略返回值等于把
 * 「句柄泄漏」变成一个只在 ASAN 跑出来才显形的洞：正常构建全程无声。header
 * inline 而非另起一个 .c：mock_libuv 没有 uv_err_name/uv_loop_alive_handles，
 * 所以只能报数字码；也省得为一个诊断函数给构建加 TU。 */
static inline int qz_close_loop(uv_loop_t *loop)
{
    int rc = uv_loop_close(loop);
    if (rc != 0) {
        /* 这里的取舍要写清楚，因为曾经被写成「loop 内存绝不能回收、泄漏是唯一安全
         * 选择」而实现恰好相反（所有调用点下一行就 free rt）。实际权衡是：
         * libuv 的 handle 是**独立分配**的，所以 free 掉含 loop 的 rt 并不会 free
         * 掉那批 handle——它们各自变成泄漏（malloc 块 + 指向已释放 loop 的指针）。
         * 于是两种选择的代价：
         *   · 不 free rt → 在**可重试的 setup 失败路径**上每次泄漏一个 rt，无界；
         *   · free rt   → 只泄漏那批 handle，rt 本身回收。
         * 后者更可控，所以调用点一律仍 free rt（各调用点有 // close-failed 注释标注
         * 这个取舍）。要真正做到「一个都不漏」得在 close 失败后 uv_walk + uv_close
         * 逐个收尾再重试——那在 setup 半初始化的路径上会碰到未就绪的 handle，风险
         * 高于它解决的问题，故不做。
         * 诊断本身是必须的：静默忽略才会把句柄泄漏变成只在 ASAN 下才显形的洞。 */
        fprintf(stderr,
                "qzjs: uv_loop_close failed (rc=%d) — handles still open. "
                "uv_loop_t is embedded by value in qz_t, and the caller still frees "
                "rt: those handles are separately allocated, so they leak rather "
                "than being freed (see the trade-off note above).\n",
                rc);
    }
    return rc;
}

/* Little-endian accessors live in le_bytes.h (dependency-free; ipc_envelope.c
 * must stay buildable without libuv/quickjs), pulled in below. */
#include "le_bytes.h"

/* Borrow a byte view from a JS Uint8Array or ArrayBuffer (used by the
 * compress and crypto extensions, which each had a private copy).
 * `*out_bytes` points into the JS-owned buffer — no copy — so it stays
 * valid only while `val` lives. Returns 0, or -1 if `val` is neither. */
static inline int qz_js_extract_bytes(JSContext *ctx, JSValueConst val,
                                        const uint8_t **out_bytes,
                                        size_t *out_len)
{
    size_t byte_len = 0;
    const uint8_t *bytes = JS_GetUint8Array(ctx, &byte_len, val);
    if (bytes) {
        *out_bytes = bytes;
        *out_len = byte_len;
        return 0;
    }
    bytes = JS_GetArrayBuffer(ctx, &byte_len, val);
    if (bytes) {
        *out_bytes = bytes;
        *out_len = byte_len;
        return 0;
    }
    return -1;
}

#ifdef __cplusplus
}
#endif
 

#endif /* QZ_INTERNAL_H */
