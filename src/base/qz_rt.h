/* 内部函数原型（各 .c 的交叉调用面）。所有符号 C 链接。 */
#ifndef QZ_RT_H
#define QZ_RT_H

#include "base/qz_core.h"
#include "base/polyfill.h"

#ifdef __cplusplus
extern "C" {
#endif



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

/* ext_lifecycle.c (src/qzvm) — extension lifecycle hooks */
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
int qz_ctl_interrupt_handler(JSContext *ctx, void *opaque);
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

#ifdef __cplusplus
}
#endif

#endif /* QZ_RT_H */
