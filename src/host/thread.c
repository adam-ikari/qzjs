/*
 * qzjs Thread Main Loop (执行模型 A)
 *
 * qz_t 自持一个内部线程：uv_loop_init + wake async 注册，JS 运行时由
 * qz_runtime_init 建好（含 polyfill 注入 / 扩展 init / DAP attach），然后
 * 用 mutex+cond 与宿主握手（qz_create 阻塞到 thread_ready）。此后线程在
 * uv_run(UV_RUN_ONCE) 里处理事件（wake 回调排空入站 FIFO 并派发 onmessage），
 * 事件间 flush 微任务。destroy 置 shutting_down 并 wake → 线程退出主循环 →
 * qz_thread_teardown 清理。
 *
 * PAL 时代"回调在线程上排队、qz_tick 回放"的 deferred 队列已删除：现在所有
 * libuv 回调（timer/io/wake）本来就跑在 qzjs 线程，直接 JS_Call 即可。
 */

#include "base/qz_rt.h"
#include <stdlib.h>
#include <string.h>


/* 在安全点排空 JS 微任务/待执行 job。返回本轮处理数。worker.c 也调用（其
 * 自己的线程主循环）。 */
int qz_flush_microtasks(qz_t *rt)
{
    int total = 0, n;
    JSContext *job_ctx = NULL;
    while ((n = JS_ExecutePendingJob(rt->jsrt, &job_ctx)) > 0) total += n;
    return total;
}

/* ── idle detection (qz_wait_idle support) ── */

/* uv_walk callback: any active handle other than the internal wake async → busy */
typedef struct {
    qz_t *rt;
    int busy;
} qz_idle_state_t;

static void qz_idle_walk_cb(uv_handle_t *h, void *arg)
{
    qz_idle_state_t *st = (qz_idle_state_t *)arg;
    if (h == (uv_handle_t *)&st->rt->wake) return;   /* exclude the internal wake async */
    /* CTL-2 §2.3：本地控制端点（监听 + 活跃连接）是基础设施句柄，不参与
     * idle 判定——否则开了端点的 runtime（尤其 qzjs-ctl 连接期间）永不判
     * idle，wait_idle/destroy 卡死。与 wake async / IPC pipe / DAP timer
     * 同款豁免。 */
    if (qz_ctl_endpoint_owns(st->rt, h)) return;
    /* M-P1 + spawn 分层化: JS-managed 进程 worker 的 IPC pipe 恒活动（duplex
     * 通道随 child 生命周期保持打开）——wait_idle 须豁免，否则宿主脚本在进程
     * worker 存活时永不 idle 退出，镜像 DAP timer 的豁免。 */
#ifndef QZ_USE_MOCK_LIBUV
    if (qz_proc_handle_is_pipe(st->rt, h)) return;
#endif
#ifdef QZ_DEBUG_SUPPORT
    /* 调试器附着的周期 DAP 轮询 timer 不算"忙"——wait_idle 应照常退出，
     * 不能被它（一个恒活动的 50ms timer）永远判为 busy。 */
    if (st->rt->dap_timer_active && h == (uv_handle_t *)&st->rt->dap_timer)
        return;
#endif
    if (!uv_is_closing(h) && uv_is_active(h)) st->busy = 1;
}

/* no active handle besides wake async and an empty message queue → idle。
 * 非 static：M-P2 主RT 进程（rt_main.c 的 serve 形态）复用同一 idle 判定。 */
int qz_loop_idle(qz_t *rt)
{
    if (qz_msg_has_pending(rt)) return 0;   /* inbound queue non-empty */
    /* 先排空 JS 微任务/待执行 job：promise 回调可能在上一轮事件里排了 job，
     * 且 job 执行本身又能排新 job（.then 链）。flush 后若仍有残留 job
     * （JS_IsJobPending），必须判 busy —— 否则 wait_idle 会提前 teardown，
     * promise 回调（bridge_io_done 的 JS_Call resolve 等）访问已释放的
     * JSRuntime → UAF/回调丢失。 */
    qz_flush_microtasks(rt);
    if (JS_IsJobPending(rt->jsrt)) return 0;
    qz_idle_state_t st;
    st.rt = rt;
    st.busy = 0;
    uv_walk(&rt->loop, qz_idle_walk_cb, &st);
    if (st.busy) return 0;
    /* fs/http 等 request 不是 handle，uv_walk 看不到。若线程池 work 在途或
     * 完成回调（work_done）仍在 loop 队列排队，idle 判定必须算"忙"，否则
     * wait_idle 会在 work_done 处理前进入 teardown，其回调（bridge_io_done）
     * 访问已释放的 JSRuntime → UAF。 */
    if (rt->loop.active_reqs.count != 0) return 0;

    /* worker 各自有**独立的 uv_loop**（worker.c 里 uv_loop_init(&w->self->loop)），
     * 上面那些检查只看本 rt 的 loop —— 父空闲完全说明不了 worker 空闲。
     * worker 内发起的 fetch/timer 挂在 worker 自己的 loop 上，父却看不到，
     * 于是 wait_idle 提前 teardown，worker 的异步结果被静默丢弃
     * （现象：worker 脚本里只有 fetch 时父收不到任何消息）。
     *
     * 这里只做**原子读**：busy 位由 worker 在自己线程上算出并发布
     * （见 qz_worker_thread_main）。绝不跨线程遍历 worker 的 loop 或调用其 JS
     * —— 那是 worker 线程的独占所有权。
     *
     * shutting_down 的 worker 不再等待：它正在退出，等它没有意义，且它线程
     * 即将结束、busy 会由 worker 自己清零，但父不该在此期间卡住。 */
    for (int i = 0; i < QZ_MAX_WORKERS; i++) {
        qz_worker_t *w = rt->workers[i];
        if (!w) continue;
        if (__atomic_load_n(&w->shutting_down, __ATOMIC_ACQUIRE)) continue;
        if (__atomic_load_n(&w->busy, __ATOMIC_ACQUIRE)) return 0;
    }
    return 1;
}

/* uv_async callback: runs on the qzjs thread; drains the inbound queue and dispatches onmessage */
static void qz_wake_cb(uv_async_t *a)
{
    qz_t *rt = (qz_t *)a->data;
    if (__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE)) return;
    qz_msg_t *m;
    while ((m = qz_msg_pop(rt)) != NULL) {
        /* CTL-0 §1.2：CONTROL 命令交 control_dispatch（WAKE_SAFEPOINT 类就地
         * 执行）；其余（含 M-P3 的 PORT_TRANSFER）走 __qz_dispatch__，kind
         * 作为第三参传给 JS。注意判等而非真值判定：flags 现在有 CONTROL 之外
         * 的非零取值。 */
        if (m->flags == QZ_MSG_FLAG_CONTROL)
            qz_control_dispatch(rt, m);
        else
            qz_dispatch_message(rt, m);
        /* 节点不 free：pop 内部已释放旧 head；m 成为下次 pop 的 head */

        /* 每个消息派发后立即排空微任务：宿主常在消息回调（dispatch 内联的
         * JS onmessage）里立即回发下一条消息，若攒到 uv_run 返回后再统一冲刷，
         * 下一条消息的 JS 会在本消息 promise 副作用落定之前被派发（读到旧
         * 状态）。逐条冲刷保持"每条消息 = 一个任务，任务后微任务先跑完"的
         * 事件循环语义。 */
        qz_flush_microtasks(rt);
    }
}

void qz_thread_main(void *arg)
{
    qz_t *rt = (qz_t *)arg;
    int loop_inited = 0;
    rt->debug = rt->config.debug;

    if (uv_loop_init(&rt->loop) != 0) {        rt->ready_err = -1;
    } else {
        loop_inited = 1;
        rt->wake.data = rt;
        if (uv_async_init(&rt->loop, &rt->wake, qz_wake_cb) != 0) {            rt->ready_err = -1;
        } else if (rt->config.control_plane == QZ_CONTROL_LOCAL &&
                   qz_ctl_endpoint_init(rt) != 0) {
            /* LOCAL 档端点 bind/listen 失败 → 显式失败（不静默降级为
             * IN_PROC；§5.3 同款：能力缺失就报错，不伪造）。 */
            rt->ready_err = -1;
        } else if (qz_runtime_init(rt) != 0) {            rt->ready_err = -1;
        } else if (rt->config.initial_script) {
            char *err = NULL;
            if (qz_eval_internal(rt, rt->config.initial_script, &err) != 0) {
                /* 异常：记录 ready_err，握手后线程退出；qz_create 返回 NULL */
                free(err);
                rt->ready_err = -1;
            }
        }
        /* 字节码在脚本之后 eval（initial_bytecode 独立叠加，见 qzjs.h）：
         * 脚本可装 bootstrap/全局，预编译主程序随后执行。 */
        if (rt->ready_err == 0 && rt->config.initial_bytecode &&
            rt->config.initial_bytecode_len) {
            char *err = NULL;
            int rc = qz_eval_bytecode_internal(rt, rt->config.initial_bytecode,
                                               rt->config.initial_bytecode_len,
                                               &err);
            if (rc != 0) {
                free(err);
                rt->ready_err = -1;
            }
        }
    }

    /* ready handshake: atomic store (host qz_create spins until it reads 1).
     * No mutex/cond: on PVE 6.17 kernels pthread_cond wakeups fail after an
     * fd is created. */
    __atomic_store_n(&rt->thread_ready, 1, __ATOMIC_RELEASE);

    if (rt->ready_err) {
        /* init 失败：清理后线程自己退出 */
        if (loop_inited) qz_thread_teardown(rt);
        return;
    }
    /* ==== 主循环 ==== */
    while (!__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE)) {
        uv_run(&rt->loop, UV_RUN_ONCE);  /* 阻塞等事件；wake_cb 期间派发消息 */
        /* CTL-0 §1.2：每轮顺带扫描过期回执条目，发 TIMEOUT 回执。 */
        qz_ctl_reap_timeouts(rt);
        if (__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE)) break;
        qz_flush_microtasks(rt);
        if (__atomic_load_n(&rt->wait_idle, __ATOMIC_ACQUIRE) && qz_loop_idle(rt)) {
            __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
            break;
        }
    }
    qz_thread_teardown(rt);
}
