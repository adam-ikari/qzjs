/*
 * qzjs Web Worker (执行模型 A — 真线程)
 *
 * Worker = 父 runtime 里的独立 qz_t：独立线程（uv_thread_t）+ 独立
 * JSRuntime + 独立 loop + 独立 wake async。父 runtime 持有 qz_worker_t 表
 * （rt->workers[]，槽位索引 = worker id = 入站消息的 source 标签）。
 *
 * 数据路径：
 *   worker→父   worker 的 pal.postMessage（js_pal_worker_emit，已被垫片换成
 *               结构化克隆字节）push 进父入站队列（source=w->id）→ 父线程
 *               wake_cb 派发 → worker.js 按 source 路由到 Worker 实例。
 *   父→worker   qz_worker_post push 进 worker 自己的入站队列（self 的
 *               msg_head/tail，source=0）→ worker 线程 wake_cb 派发 →
 *               __qz_dispatch__(bytes,0) → 垫片反序列化 → MessageEvent。
 *
 * 生命周期：qz_worker_create 阻塞到 worker ready 握手才返回 id；脚本顶层
 * 异常 → 先在本 runtime 内 dispatch ErrorEvent（触发 self.onerror），再经
 * postMessage 发 {type:'error'} 给父（触发 w.onerror），worker 继续存活。
 * terminate 异步（置 shutting_down + wake，不 join——不能 join 自己）。join +
 * 释放 worker runtime 有两条路径，都在父线程：父 teardown
 * （qz_thread_teardown 第一步）与下一次 spawn 时的 qz_worker_reap——后者
 * 回收槽位（id = 索引+1），否则反复 spawn/terminate 会耗尽 QZ_MAX_WORKERS。
 */

#include "base/qz_rt.h"
#include <sched.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* 父线程调用的 worker API 契约见 qz_internal.h（qz_worker_* 声明；
 * qz_worker_s 定义也在那，bridge.c / qzjs.c 需解引用其字段）。 */

/* worker 启动垫片：由 polyfill/src/worker-boot.js 经 build.js(qjsc) 编译成
 * 字节码注入（src/worker_boot_default.c → qz_default_worker_boot）。垫片
 * 读 __native__，覆盖 postMessage / __qz_dispatch__ / close /
 * importScripts——之后 worker 脚本里的 postMessage()/onmessage/close() 即
 * 按 worker 语义工作。 */

/* worker 入站派发：父发的字节 → __qz_dispatch__(bytes, 0, kind)（垫片反序列化）。
 * kind 由 msgq flags 投影（0=MESSAGE / 1=PORT_TRANSFER）——port 帧据此走端点
 * 路由而不必猜 payload 形状（M-P3）。 */
void qz_worker_dispatch(qz_t *rt, qz_msg_t *m)
{
    qz_ctx_t *cctx = rt->contexts[0];
    if (!cctx || !cctx->jsctx) return;
    JSContext *ctx = cctx->jsctx;
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, g, "__qz_dispatch__");
    JS_FreeValue(ctx, g);
    if (JS_IsFunction(ctx, fn)) {
        JSValue data = JS_NewArrayBufferCopy(ctx, (const uint8_t *)m->data, m->len);
        JSValue src = JS_NewInt32(ctx, QZ_MSG_SRC_HOST);
        JSValue kind = JS_NewInt32(ctx, qz_msg_kind(m->flags));
        JSValue args[3] = { data, src, kind };
        JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 3, args);
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, data);
        JS_FreeValue(ctx, src);
        JS_FreeValue(ctx, kind);
    }
    JS_FreeValue(ctx, fn);
}

/* worker 线程的 wake 回调：排空自己的入站队列并派发 */
static void qz_worker_wake_cb(uv_async_t *a)
{
    qz_t *rt = (qz_t *)a->data;
    if (__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE)) return;
    qz_msg_t *m;
    while ((m = qz_msg_pop(rt)) != NULL) {
        qz_worker_dispatch(rt, m);
        /* node is not freed here: pop already frees the old head; m becomes the next pop's head */
    }
}

/* 脚本顶层异常 → 先在 worker 自己的 JSRuntime 内 dispatch 'error' 事件
 * （构造 ErrorEvent，触发 self.onerror / addEventListener('error')），再经
 * postMessage（已被垫片替换为序列化→父）以 {type:'error', error:<msg>} 通知
 * 父；worker 继续存活。ErrorEvent 构造失败（如 polyfill 未加载）时跳过本地
 * 派发，回退到仅父通知。 */
static void qz_worker_notify_error(qz_t *rt, const char *msg)
{
    qz_ctx_t *cctx = rt->contexts[0];
    if (!cctx || !cctx->jsctx) return;
    JSContext *ctx = cctx->jsctx;
    const char *text = msg ? msg : "";
    JSValue g = JS_GetGlobalObject(ctx);

    /* 1) worker 侧本地派发：new ErrorEvent('error', {message, filename,
     * lineno, colno, error, cancelable}) → globalThis.dispatchEvent(ev)。 */
    JSValue err_cls = JS_GetPropertyStr(ctx, g, "ErrorEvent");
    if (JS_IsFunction(ctx, err_cls)) {
        JSValue opts = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, opts, "message", JS_NewString(ctx, text));
        JS_SetPropertyStr(ctx, opts, "filename", JS_NewString(ctx, ""));
        JS_SetPropertyStr(ctx, opts, "lineno", JS_NewInt32(ctx, 0));
        JS_SetPropertyStr(ctx, opts, "colno", JS_NewInt32(ctx, 0));
        JSValue exc = JS_NewError(ctx);
        JS_SetPropertyStr(ctx, exc, "message", JS_NewString(ctx, text));
        JS_SetPropertyStr(ctx, opts, "error", exc);
        JS_SetPropertyStr(ctx, opts, "cancelable", JS_NewBool(ctx, 1));
        JSValue args[2] = { JS_NewString(ctx, "error"), opts };
        JSValue ev = JS_CallConstructor(ctx, err_cls, 2, args);
        JS_FreeValue(ctx, args[0]);
        JS_FreeValue(ctx, opts);
        if (JS_IsException(ev)) {
            JS_FreeValue(ctx, JS_GetException(ctx));   /* 清 pending，防污染后续调用 */
            JS_FreeValue(ctx, ev);
        } else {
            JSValue dsp = JS_GetPropertyStr(ctx, g, "dispatchEvent");
            if (JS_IsFunction(ctx, dsp)) {
                JSValue r = JS_Call(ctx, dsp, g, 1, &ev);
                if (JS_IsException(r)) JS_FreeValue(ctx, JS_GetException(ctx));
                JS_FreeValue(ctx, r);
            }
            JS_FreeValue(ctx, dsp);
            JS_FreeValue(ctx, ev);
        }
    }
    JS_FreeValue(ctx, err_cls);

    /* 2) 向父通知（父侧 worker.js 路由到 w.onerror） */
    JSValue pm = JS_GetPropertyStr(ctx, g, "postMessage");
    JS_FreeValue(ctx, g);
    if (JS_IsFunction(ctx, pm)) {
        JSValue obj = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, obj, "type", JS_NewString(ctx, "error"));
        JS_SetPropertyStr(ctx, obj, "error", JS_NewString(ctx, text));
        JSValue args[1] = { obj };
        JSValue r = JS_Call(ctx, pm, JS_UNDEFINED, 1, args);
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, obj);
    }
    JS_FreeValue(ctx, pm);
}

static void qz_worker_thread_main(void *arg)
{
    qz_worker_t *w = (qz_worker_t *)arg;
    qz_t *rt = w->self;
    int loop_inited = 0;

    if (uv_loop_init(&rt->loop) != 0) {
        rt->ready_err = -1;
    } else {
        loop_inited = 1;
        rt->wake.data = rt;
        if (uv_async_init(&rt->loop, &rt->wake, qz_worker_wake_cb) != 0) {
            rt->ready_err = -1;
        } else if (qz_runtime_init(rt) != 0) {
            rt->ready_err = -1;
        } else {
            char *err = NULL;
            if (qz_eval_bytecode_internal(rt, qz_default_worker_boot,
                                            qz_default_worker_boot_len, &err) != 0) {
                qz_worker_notify_error(rt, err ? err : "worker boot failed");
                free(err);
            } else if (qz_eval_internal(rt, w->script, &err) != 0) {
                qz_worker_notify_error(rt, err ? err : "worker script error");
                free(err);
            }
        }
    }

    /* ready handshake: atomic store (parent spins until it reads 1) */
    __atomic_store_n(&rt->thread_ready, 1, __ATOMIC_RELEASE);

    if (rt->ready_err) {
        if (loop_inited) qz_thread_teardown(rt);
        return;
    }

    /* ==== 主循环 ==== */
    while (!__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE) &&
           !__atomic_load_n(&w->shutting_down, __ATOMIC_ACQUIRE)) {
        uv_run(&rt->loop, UV_RUN_ONCE);  /* 阻塞等事件；wake_cb 派发消息 */
        if (__atomic_load_n(&rt->shutting_down, __ATOMIC_ACQUIRE) ||
            __atomic_load_n(&w->shutting_down, __ATOMIC_ACQUIRE)) break;
        qz_flush_microtasks(rt);
        /* 发布「本 worker 仍有在途异步工作」给父的 idle 判定。
         * 在本线程上算（qz_loop_idle 对 w->self 是安全的），父只读这个位。 */
        int busy_now = qz_loop_idle(rt) ? 0 : 1;
        int busy_prev = __atomic_exchange_n(&w->busy, busy_now, __ATOMIC_ACQ_REL);
        /* 由忙转空闲时必须叫醒父的 loop。
         *
         * qz_wait_idle 只发**一次** async 唤醒。父在那次唤醒里看到 worker 仍忙
         * 就继续等 —— 而父的 uv_run 在无活动句柄时会阻塞。没有这次通知，worker
         * 后续变空闲不会有任何东西唤醒父重新判定，父永远卡在旧结论上
         * （实测：worker 有 setTimeout + fetch 时必挂）。
         *
         * uv_async_send 是线程安全的，可在 worker 线程上直接调父的 wake。 */
        if (busy_prev != 0 && busy_now == 0 && w->parent) {
            uv_async_send(&w->parent->wake);
        }
    }
    /* 退出前清零：worker 一旦结束就永远不会再发布，若留下 1，父的 wait_idle
     * 会永远等一个已经结束的 worker（死锁）。 */
    __atomic_store_n(&w->busy, 0, __ATOMIC_RELEASE);
    qz_thread_teardown(rt);
}

/* ================================================================
 * 父线程 API
 * ================================================================ */

/* 释放 worker 自己的 runtime（线程已结束、即 join 已返回时才可调用；worker
 * 侧再无人引用它）。self 置 NULL 即"已 join + runtime 已释放"标记。 */
static void qz_worker_release_runtime(qz_worker_t *w)
{
    if (w->self) {
        free(w->self);
        w->self = NULL;
    }
}

/* 父入站队列里是否还有 source == id 的未派发消息。消费端只读遍历（与
 * qz_msg_pop 同样的 acquire 链式读，不改队列）：生产者尚未落链的消息读不到，
 * 但那不可能是本 worker 的——调用前已 join，它的线程不可能再 push。 */
static int qz_worker_msg_queued(qz_t *parent, int id)
{
    struct uv__queue *nq =
        __atomic_load_n(&parent->msg_head->q.next, __ATOMIC_ACQUIRE);
    while (nq) {
        qz_msg_t *m = uv__queue_data(nq, qz_msg_t, q);
        if (m->source == id) return 1;
        nq = __atomic_load_n(&nq->next, __ATOMIC_ACQUIRE);
    }
    return 0;
}

/* 回收已请求退出的 worker 槽位。terminate 只置标志 + 唤醒（协作式，且可能由
 * worker 自己的线程调用——不能 join 自己），所以清槽发生在这里：join 返回即
 * 线程完全结束，此后 self（worker 自己的 loop/JSRuntime）不再被任何线程引用，
 * 可安全释放，槽位（id = 索引+1）也随之可被下一个 worker 复用。否则宿主反复
 * spawn/terminate 会耗尽 QZ_MAX_WORKERS，spawn 恒返回 BUSY。
 *
 * 仅父 runtime 线程调用（parent->workers[] 与父队列消费端的唯一所有者）。
 * 幂等：self == NULL 表示已 join + runtime 已释放，跳过 join。
 * 残留消息：若父队列里还有该 worker 未派发的入站消息（source == id），本次
 * 不复用该槽——复用后 id 会指向新 worker，残留消息会被派发到它身上；留待下一
 * 次 spawn（或父 teardown）回收。 */
static void qz_worker_reap(qz_t *parent)
{
    for (int i = 0; i < QZ_MAX_WORKERS; i++) {
        qz_worker_t *w = parent->workers[i];
        /* 空槽，或未请求退出（线程仍在跑）：不动 */
        if (!w || !__atomic_load_n(&w->shutting_down, __ATOMIC_ACQUIRE))
            continue;
        if (w->self) {
            uv_thread_join(&w->thread);
            qz_worker_release_runtime(w);
        }
        if (qz_worker_msg_queued(parent, w->id)) continue;
        parent->workers[i] = NULL;
        qz_worker_free(w);
    }
}

qz_worker_t *qz_worker_create(qz_t *parent, const char *script, int *out_err)
{
    if (!parent || parent->magic != QZ_MAGIC || !script) {
        if (out_err) *out_err = QZ_ERR_INVALID_ARG;
        return NULL;
    }
#ifdef QZ_USE_MOCK_LIBUV
    /* Test builds compile the core against mock_libuv.h, which has no process
     * backend (ipc_process.c is excluded — design §10.1). qzjs.h documents
     * that a PROCESS request in a test build errors explicitly rather than
     * silently degrading to THREAD (I4). */
    if (parent->config.worker_backend == QZ_WORKER_BACKEND_PROCESS) {
        if (out_err) *out_err = QZ_ERR_NOT_SUPPORTED;
        return NULL;
    }
#endif

    /* 先回收已退出的 worker 槽位（terminate 只置标志，回收点在此，见
     * qz_worker_reap）：否则反复 spawn/terminate 会耗尽槽位，spawn 恒 BUSY。 */
    qz_worker_reap(parent);

    int slot = -1;
    for (int i = 0; i < QZ_MAX_WORKERS; i++) {
        if (!parent->workers[i]) { slot = i; break; }
    }
    if (slot < 0) {
        if (out_err) *out_err = QZ_ERR_BUSY;
        return NULL;
    }

    qz_worker_t *w = (qz_worker_t *)calloc(1, sizeof *w);
    qz_t *self = (qz_t *)calloc(1, sizeof *self);
    if (!w || !self) {
        free(w);
        free(self);
        if (out_err) *out_err = QZ_ERR_NO_MEMORY;
        return NULL;
    }

    self->magic = QZ_MAGIC;
    self->worker_self = w;         /* 标记：这是 worker runtime（pal 绑定用） */
    w->parent = parent;
    /* 从 spawn 起就算忙：worker 要 boot + 跑脚本 + 发首条消息，那段时间父的
     * loop 可能已空闲。不置 1 会让父在 worker boot 完成前就 wait_idle 返回，
     * 把 worker 的首次输出截断（与 busy 发布同源的竞态）。 */
    w->busy = 1;
    w->id = slot + 1;              /* id = 槽位+1；0 保留给宿主 source（不冲突） */
    w->self = self;
    w->script = strdup(script);
    if (!w->script) {
        /* OOM：strdup 失败 → 返回前清理。不能带着 NULL script 继续 ——
         * qz_eval_internal(rt, NULL) 会 strlen(NULL) → UB。 */
        free(self);
        free(w);
        if (out_err) *out_err = QZ_ERR_NO_MEMORY;
        return NULL;
    }
    /* lock-free MPSC: self's inbound queue head == tail == sentinel (calloc zeroed) */
    self->msg_head = &self->msg_stub;
    self->msg_tail = &self->msg_stub;

    /* 继承父 runtime 的 CA 信任库。
     *
     * worker 是独立的 qz_t（上面 calloc 清零），不共享父 runtime 的任何状态，
     * 所以父进程经 qz_add_ca_pem() 装入的信任根不会自动到达 worker —— worker
     * 里的 fetch 访问私有 CA 站点会报 X509 verification failed。
     *
     * 而 PROCESS 后端的 worker 是独立进程、经 rt_main.c 的 QZ_CA_FILE 装载，
     * **拿得到**。不继承就是「同一功能在一个后端有效、另一个静默失效」，属本项目
     * 明确要消灭的静默降级：症状（证书验证失败）与真因（信任库没传过来）毫无
     * 关联，排查时会往证书方向跑偏。
     *
     * 失败（仅 OOM）不中止 worker 创建，但必须出声 —— 静默继续的话，worker 里
     * 的 fetch 会以「证书问题」的面貌失败。 */
    if (parent->ca_pem_len > 0) {
        /* strdup 而非 qz_add_ca_pem：后者是**追加**语义（会补一个 '\\n' 分隔符），
         * 用来"继承"会让 worker 的缓冲比父多一个换行。继承应是逐字节拷贝。 */
        self->ca_pem = strdup(parent->ca_pem);
        if (self->ca_pem) {
            self->ca_pem_len = parent->ca_pem_len;   /* 不含末尾 NUL */
            self->ca_pem_cap = self->ca_pem_len + 1;
        } else {
            fprintf(stderr, "[qzjs] worker: failed to inherit CA trust store (OOM); "
                            "fetch to private-CA hosts inside this worker will fail "
                            "with X509 verification errors\n");
        }
    }
    parent->workers[slot] = w;
    /* ── 线程后端（唯一后端；PROCESS 由 JS 层 processSpawn 封装接管，
     * C 层不再有进程 worker 分流 —— spawn 分层化 Phase C）── */
    if (uv_thread_create(&w->thread, qz_worker_thread_main, w) != 0) {
        parent->workers[slot] = NULL;
        free(w->script);
        free(self);
        free(w);
        if (out_err) *out_err = QZ_ERR_GENERIC;
        return NULL;
    }

    /* block until the worker thread is ready (spin + yield, no cond wakeup) */
    while (!__atomic_load_n(&self->thread_ready, __ATOMIC_ACQUIRE))
        sched_yield();

    if (self->ready_err) {
        uv_thread_join(&w->thread);
        parent->workers[slot] = NULL;
        qz_worker_free(w);
        if (out_err) *out_err = QZ_ERR_GENERIC;
        return NULL;
    }
    return w;
}

void qz_worker_post(qz_t *parent, qz_worker_t *w, const uint8_t *bytes,
                      size_t len, uint8_t flags)
{
    QZ_UNUSED(parent);
    if (!w || __atomic_load_n(&w->shutting_down, __ATOMIC_ACQUIRE)) return;
    if (w->self) {
        qz_msg_push(w->self, (const char *)bytes, len, QZ_MSG_SRC_HOST, flags);
        uv_async_send(&w->self->wake);   /* 唤醒与容器解耦（M-P7） */
    }
}

void qz_worker_terminate(qz_t *parent, qz_worker_t *w)
{
    QZ_UNUSED(parent);
    if (!w) return;
    __atomic_store_n(&w->shutting_down, 1, __ATOMIC_RELEASE);
    if (!w->self) return;
    qz_t *self = w->self;
    __atomic_store_n(&self->shutting_down, 1, __ATOMIC_RELEASE);
    uv_async_send(&self->wake);          /* wake a blocked worker uv_run */
}

qz_worker_t *qz_worker_get(qz_t *parent, int id)
{
    /* id = 槽位 + 1（1..QZ_MAX_WORKERS）；id 0 是宿主 source，不是 worker */
    if (!parent || parent->magic != QZ_MAGIC ||
        id < 1 || id > QZ_MAX_WORKERS) {
        return NULL;
    }
    return parent->workers[id - 1];
}

void qz_worker_free(qz_worker_t *w)
{
    if (!w) return;
    qz_worker_release_runtime(w);
    free(w->script);
    free(w);
}
