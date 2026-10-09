/* 运行时核心对象层：struct qz_t / qz_ctx_t / qz_cb_data_t 与 header-inline 助手。
 * 依赖 qz_types.h（基础类型）与 msg/qz_msg.h（qz_t 内嵌 qz_mq_t）。 */
#ifndef QZ_CORE_H
#define QZ_CORE_H

#include "qz_types.h"
#include "msg/qz_msg.h"

#ifdef __cplusplus
extern "C" {
#endif



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

#endif /* QZ_CORE_H */
