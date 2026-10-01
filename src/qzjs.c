/*
 * qzjs Core Runtime (执行模型 A)
 *
 * 宿主侧生命周期：qz_create（阻塞到内部线程/宿主侧线程 ready）/ qz_destroy
 * （请求主执行体退出 → join）/ qz_post_message（线程安全入站）/
 * qz_recv_message + qz_message_fd（出站邮箱消费）/ qz_free。
 * 主权原则（M-P7）：库不调用任何宿主代码——出站消息入 per-rt FIFO 邮箱，
 * 宿主自选线程与时机消费。
 *
 * qzjs 线程侧内部函数（thread.c 调用）：qz_runtime_init 建 JSRuntime + 主
 * context（含 polyfill 注入 / 扩展 init / DAP attach）；qz_eval_internal 在
 * 活动 context 上 eval；qz_thread_teardown 回收（排空 jobs → 销毁 contexts
 * → JS_FreeRuntime → 关闭 loop）。
 */

#include "qz_internal.h"
#include <sched.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <poll.h>
#include <unistd.h>
#include <errno.h>
#ifdef __linux__
#include <sys/eventfd.h>
#endif

/* mailbox 唤醒 fd = eventfd(0, EFD_NONBLOCK|EFD_CLOEXEC)（Linux-only，CI
 * 平台即 Linux）。创建失败/非 Linux → 返回 -1，宿主退化为纯轮询语义（recv
 * 的 `out_efd < 0` 分支已存在，CLI/示例均处理 fd<0）。这里绝不回退 pipe：
 * pipe 读写端不同号，msgq.c 对 out_efd 的 write 是对读端写、根本不生效，
 * 宿主拿到的是一个永远不会可读的「唤醒 fd」——按三步协议 poll 就死等且无
 * 任何诊断。返回 -1 是降级但正确，假 fd 是挂死（§5.3 不静默降级）。 */
#ifdef __linux__
#define QZ_HAS_EVENTFD 1
#endif

static int qz_efd_create(void)
{
#ifdef QZ_HAS_EVENTFD
    return eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
#else
    return -1;
#endif
}

#ifdef QZ_DEBUG_SUPPORT
#include "qzjs/qz_debug_dap.h"
#endif

#ifndef QZ_USE_MOCK_LIBUV
#include "ipc_process.h"
#endif

/* ================================================================
 * 宿主侧 API
 * ================================================================ */

/* 读整个文件到 malloc 缓冲区（NUL 结尾）。失败返回 NULL。 */
static char *qz_read_file(const char *path, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long sz = ftell(f);
    if (sz < 0) { fclose(f); return NULL; }
    rewind(f);
    char *buf = (char *)malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t rd = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[rd] = '\0';
    if (out_len) *out_len = rd;
    return buf;
}

/* 邮箱回收：排干未消费节点 + 关闭唤醒 fd（幂等，双角色路径共用）。 */
void qz_mailbox_teardown(qz_t *rt)
{
    qz_msg_t *m;
    while ((m = qz_out_pop(rt)) != NULL) {}
    if (rt->mq_out.head != &rt->mq_out.stub) qz_msg_free(rt->mq_out.head);
    /* 回到 init 后的初始态（head=tail=stub 且 stub.q.next=NULL）——排干循环
     * 只把 head 推到了尾节点，stub.q.next 仍指向链上第一个节点，而它早在
     * 第二次 pop 时就被 free 了。不重置就是悬垂指针，二次 teardown 或任何
     * 复检都会踩已释放内存。幂等靠状态复位，不靠调用次数门控。 */
    qz_out_mq_init(rt);
    if (rt->out_efd >= 0) { close(rt->out_efd); rt->out_efd = -1; }
}

qz_t *qz_create(const qz_config_t *config)
{
    /* 禁用 libuv 的 io_uring：部分内核（如 PVE 6.17）在 io_uring_setup 后
     * 会破坏 futex/pthread_cond 唤醒，导致宿主线程的 cond_wait 永不返回。
     * 不覆盖宿主显式设置的 UV_USE_IO_URING。 */
    setenv("UV_USE_IO_URING", "0", 0);
    if (!config) return NULL;
    qz_t *rt = (qz_t *)calloc(1, sizeof *rt);
    if (!rt) return NULL;
    rt->magic = QZ_MAGIC;
    rt->config = *config;
    /* 初始化：initial_script / initial_script_path 二选一（path 优先）；
     * initial_bytecode 独立叠加——运行顺序为先脚本（宿主 bootstrap 等）后
     * 字节码。全部拷入 malloc 缓冲（destroy 释放），宿主缓冲可提前释放。 */
    if (config->initial_script_path) {
        rt->config.initial_script = qz_read_file(config->initial_script_path, NULL);
        if (!rt->config.initial_script) {
            free(rt);
            return NULL;
        }
    } else if (config->initial_script) {
        rt->config.initial_script = strdup(config->initial_script);
    }
    if (config->initial_bytecode) {
        /* 指针一旦设置即归 rt 所有（拷贝），len==0 也不例外——否则
         * rt->config.initial_bytecode 悬挂在宿主缓冲上，destroy 的 free
         * 会 double-free（实测空文件 → glibc abort）。 */
        size_t n = config->initial_bytecode_len;
        uint8_t *bc = (uint8_t *)malloc(n ? n : 1);
        if (!bc) {
            free((void *)rt->config.initial_script);
            free(rt);
            return NULL;
        }
        if (n) memcpy(bc, config->initial_bytecode, n);
        rt->config.initial_bytecode = bc;
        rt->config.initial_bytecode_len = n;
    }
    /* strict mode 深拷贝：sandbox_root strdup，env_allowlist 数组+各元素 strdup。
     * 失败走 OOM 清理（与 initial_* 同模式：free 已分配，返 NULL）。 */
    if (config->strict_mode) {
        if (config->sandbox_root && config->sandbox_root[0]) {
            rt->strict_root = strdup(config->sandbox_root);
            if (!rt->strict_root) {
                free((void *)rt->config.initial_script);
                free((void *)rt->config.initial_bytecode);
                free(rt);
                return NULL;
            }
        }
        if (config->env_allowlist) {
            int n = 0;
            while (config->env_allowlist[n]) n++;
            rt->strict_env_allow = (char **)calloc((size_t)n + 1, sizeof(char *));
            if (!rt->strict_env_allow) {
                free(rt->strict_root);
                free((void *)rt->config.initial_script);
                free((void *)rt->config.initial_bytecode);
                free(rt);
                return NULL;
            }
            for (int i = 0; i < n; i++) {
                rt->strict_env_allow[i] = strdup(config->env_allowlist[i]);
                if (!rt->strict_env_allow[i]) {
                    for (int j = 0; j < i; j++) free(rt->strict_env_allow[j]);
                    free(rt->strict_env_allow);
                    free(rt->strict_root);
                    free((void *)rt->config.initial_script);
                    free((void *)rt->config.initial_bytecode);
                    free(rt);
                    return NULL;
                }
            }
        }
    }
    /* lock-free MPSC queue: head == tail == sentinel (calloc zeroed stub's q.next) */
    rt->msg_head = &rt->msg_stub;
    rt->msg_tail = &rt->msg_stub;
    /* M-P7 邮箱：出站 FIFO + eventfd 唤醒计数。先于 qz_host_start 建好
     * （pre-ready 帧重放即在 create 返回前入箱）。创建失败非致命：
     * out_efd = -1 → 宿主只有轮询语义（fd 等待不可用）。 */
    qz_out_mq_init(rt);
    rt->out_efd = qz_efd_create();
    /* CTL-0：控制面回执表锁（生产者登记，qzjs 线程消费）。 */
    uv_mutex_init(&rt->ctl_lock);

#ifdef QZ_HOST_SPLIT
    /* ── ISOLATED（M-P2/M-P7）：宿主↔主RT 进程分离 + 库自管宿主侧线程 ──
     * spawn 主RT 进程 + 握手 + 阻塞 raw-fd 等 CONTROL{ready} + pre-ready 帧
     * 入箱 + 起宿主侧线程；失败显式返回 NULL，不降级到线程后端（§5.3）。
     * C API 签名不变：宿主见到的仍是一个 qz_t。 */
    if (qz_host_start(rt) != 0) {
        qz_mailbox_teardown(rt);
        free((void *)rt->config.initial_script);
        free((void *)rt->config.initial_bytecode);
        free(rt);
        return NULL;
    }
    return rt;
#else
    if (uv_thread_create(&rt->thread, qz_thread_main, rt) != 0) {
        qz_mailbox_teardown(rt);
        free((void *)rt->config.initial_script);
        free((void *)rt->config.initial_bytecode);
        free(rt);
        return NULL;
    }

    /* Block until the internal thread is ready (atomically set at the end of
     * thread_main; spin + yield here, no futex/pthread_cond wakeup — on some
     * kernels (PVE 6.17) cond wakeups break after an fd is created). */
    while (!__atomic_load_n(&rt->thread_ready, __ATOMIC_ACQUIRE))
        sched_yield();
    if (rt->ready_err) {
        qz_destroy(rt);
        return NULL;
    }
    return rt;
#endif
}

int qz_post_message(qz_t *rt, const char *json, size_t len)
{
#ifdef QZ_HOST_SPLIT
    /* 入队即返回（与线程后端同语义）；宿主侧线程装信封写通道。 */
    return qz_host_post(rt, json, len);
#else
    if (!rt || rt->magic != QZ_MAGIC || !json) return -1;
    /* 唤醒与容器解耦（M-P7）：push 不再自带 async，入站调用点显式发。 */
    int rc = qz_msg_push(rt, json, len, QZ_MSG_SRC_HOST, 0);
    if (rc == 0) uv_async_send(&rt->wake);
    return rc;
#endif
}

void qz_wait_idle(qz_t *rt)
{
#ifdef QZ_HOST_SPLIT
    qz_host_wait_idle(rt);
    return;
#else
    if (!rt || rt->magic != QZ_MAGIC) return;
    __atomic_store_n(&rt->wait_idle, 1, __ATOMIC_RELEASE);
    uv_async_send(&rt->wake);          /* wake a blocked uv_run for idle detection */
    /* Block until the thread auto-exits on idle (loop empty of work).
     * qz_destroy must not be called before this returns — it would force
     * shutdown and cancel pending async work (e.g. a live timer). */
    uv_thread_join(&rt->thread);
    /* M-R1: record the join so a following qz_destroy skips it — bare
     * pthread_join on an already-joined handle is UB. */
    __atomic_store_n(&rt->thread_joined, 1, __ATOMIC_RELEASE);
#endif
}

void qz_destroy(qz_t *rt)
{
#ifdef QZ_HOST_SPLIT
    qz_host_destroy(rt);   /* 唤醒宿主侧线程自收主RT → join → 释放（含邮箱回收） */
    return;
#else
    if (!rt) return;
    if (rt->magic != QZ_MAGIC) return;
    __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
    uv_async_send(&rt->wake);          /* wake a blocked uv_run */
    /* wait_idle already joined the (exited) thread — re-joining is UB. The
     * thread is gone at that point, so nothing to wait for. */
    if (!__atomic_load_n(&rt->thread_joined, __ATOMIC_ACQUIRE))
        uv_thread_join(&rt->thread);   /* 等线程 teardown 完成 */
    __atomic_store_n(&rt->thread_joined, 1, __ATOMIC_RELEASE);
    qz_mailbox_teardown(rt);           /* join 后无并发生产者，排干安全 */
    free((void *)rt->config.initial_script);
    free((void *)rt->config.initial_bytecode);
    free(rt->strict_root);
    if (rt->strict_env_allow) {
        for (char **p = rt->strict_env_allow; *p; p++) free(*p);
        free(rt->strict_env_allow);
    }
    free(rt);
#endif
}

/* ================================================================
 * Mailbox 消费 API（M-P7）——见 qzjs.h 消费协议注释
 * ================================================================ */

static int qz_recv_message_inner(qz_t *rt, char **json, size_t *len,
                                 int timeout_ms)
{
    int64_t deadline = timeout_ms > 0 ? qz_now_ms() + timeout_ms : 0;
    for (;;) {
        qz_msg_t *m = qz_out_pop(rt);
        if (m) {
            /* MPSC 语义：pop 返回的节点已成为新 head（生产者可能已把链尾
             * 接在它后面），绝不能在这里 free——下一次 pop 释放旧 head。
             * 摘出独立 malloc 块移交宿主（qz_free_message 释放）。 */
            char *copy = (char *)malloc(m->len + 1);
            if (copy) {
                memcpy(copy, m->data, m->len + 1);
                *json = copy;
                if (len) *len = m->len;
            }
            return copy ? 0 : -1;
        }
        if (timeout_ms == 0) return 1;   /* 纯轮询 */
        if (rt->out_efd < 0) return 1;   /* 无 fd（非 Linux/创建失败）：不阻塞 */
        struct pollfd pfd = { .fd = rt->out_efd, .events = POLLIN };
        int wait = timeout_ms > 0
                       ? (int)(deadline - qz_now_ms())
                       : -1;              /* -1 = 无限等待 */
        if (wait <= 0) wait = 1;          /* 已过期仍给最后一次极短 poll 复查竞态 */
        int rc = poll(&pfd, 1, wait);
        if (rc > 0) {
            /* 清 eventfd 计数（非阻塞读到 EAGAIN；eventfd 单次 8B 即清空）。 */
            uint64_t drain;
            while (read(rt->out_efd, &drain, sizeof drain) == (ssize_t)sizeof drain) {}
            if (pfd.revents & (POLLERR | POLLNVAL)) return -1;
            continue;                      /* 复核邮箱：可能已又被 pop 空 */
        }
        if (rc == 0) return 1;             /* 超时 */
        if (errno == EINTR) {
            if (timeout_ms > 0 && qz_now_ms() >= deadline) return 1;
            continue;                      /* 重算 deadline 续睡 */
        }
        return -1;
    }
}

/* 单消费者守卫。出站队列是 lock-free MPSC，而 qz_out_pop 的 head 是**非原子**
 * 读写的——它成立的前提就是「只有一个消费者拥有 head」。两个线程并发弹出时，
 * 两者会读到同一个 head、各自 free(head) 同一个节点（double free），并各自
 * 返回同一个 next（同一条消息投递两次、另一条静默丢失）。
 *
 * 原来这份契约只写在头注释里，违反它没有任何东西会变红——静默的内存破坏。
 * §5.3 要求失败可诊断，所以这里加一个 per-rt 的原子标记把它变成可诊断的 -1。
 *
 * per-call（进抢出放）而不是永久归属，理由是契约的措辞是「**同一时刻**只允许
 * 一个线程」：永久归属会把「A 排干完、顺序交给 B」这种合法交接也判成违规。
 * 一次 CAS 不是锁，不违反无锁这条。
 *
 * 阻塞等待期间标记是持有的——这正是「单一消费者」该有的样子：另一个线程这时
 * 调用的结果是 -1 而不是并发弹队列。 */
int qz_recv_message(qz_t *rt, char **json, size_t *len, int timeout_ms)
{
    if (!rt || rt->magic != QZ_MAGIC || !json) return -1;
    int expected = 0;
    if (!__atomic_compare_exchange_n(&rt->out_claim, &expected, 1, 0,
                                     __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) {
        fprintf(stderr,
                "qz_recv_message: another thread is already consuming this "
                "runtime's mailbox — returning -1 instead of corrupting it "
                "(the outbound queue is lock-free MPSC with a single consumer; "
                "two concurrent pops double-free the same node). Serialize "
                "consumption in the host, or hand the mailbox over between "
                "threads rather than sharing it.\n");
        return -1;
    }
    int rc = qz_recv_message_inner(rt, json, len, timeout_ms);
    __atomic_store_n(&rt->out_claim, 0, __ATOMIC_RELEASE);
    return rc;
}

void qz_free_message(void *json)
{
    free(json);
}

int qz_message_fd(qz_t *rt)
{
    if (!rt || rt->magic != QZ_MAGIC) return -1;
    return rt->out_efd;
}

/* 跨模型 liveness 入口（声明在 qzjs.h，两种模型都在）。THREAD 分支恒报
 * 「不可测」而不是谎报 0——见 qzjs.h 里 QZ_PING_UNAVAILABLE 的说明。 */
#ifndef QZ_HOST_SPLIT
int qz_ping_if_available(qz_t *rt, int32_t timeout_ms)
{
    QZ_UNUSED(rt);
    QZ_UNUSED(timeout_ms);
    return QZ_PING_UNAVAILABLE;
}

int qz_ping_path_if_available(qz_t *rt, const int32_t *path, int path_len,
                             int32_t timeout_ms)
{
    QZ_UNUSED(rt);
    QZ_UNUSED(path);
    QZ_UNUSED(path_len);
    QZ_UNUSED(timeout_ms);
    return QZ_PING_UNAVAILABLE;
}
#endif

void  qz_free(void *ptr) {
    if (!ptr) return;
    qz_t *rt = (qz_t *)ptr;
    /* 双角色：qz_wait_idle 收束后的 rt 走完整回收——邮箱排干 + 唤醒 fd 关闭
     * + config 缓冲；其余（qz_compile 等产出的裸 malloc 块）直接 free。
     * blob 无 magic，绝不 deref config。 */
    if (rt->magic == QZ_MAGIC) {
        if (!__atomic_load_n(&rt->thread_joined, __ATOMIC_ACQUIRE)) {
            /* 是 rt 但线程没被 join 过。直接 free 等于把仍在跑的线程脚下的结构体
             * 抽走（UAF），比泄漏严重得多，故**什么都不碰**，只把话说清楚。
             *
             * 这里曾经「先做能做的部分」——排干邮箱 + 关掉 eventfd——理由是怕白扔
             * 一个宿主 fd 槽位和整箱消息。**那是错的，两部分都不安全**：
             *   · qz_mailbox_teardown 的契约是「join 后调用」（qz_destroy 的调用点
             *     注释也写着「join 后无并发生产者，排干安全」），而本分支存在的全部
             *     前提就是线程从未 join。它做的 qz_out_pop 会与生产者的
             *     __atomic_exchange_n(&tail) + store_n(&prev->q.next) 并发：pop 到
             *     NULL 之后还会 free(prev)，生产者手里那个 prev 就成了已释放内存，
             *     而那条消息同时**静默丢失**——恰好是「不静默降级」最该避免的结果。
             *   · 关 out_efd 更糟：生产者的 qz_out_link 里 write(rt->out_efd, …)。
             *     关掉之后要么吃 EBADF，要么在 fd 号被宿主复用的情况下，**把 8 字节
             *     写进宿主的不相关文件描述符**。那是库伸手损坏宿主拥有的东西，比泄漏
             *     坏得多，也直接违反「宿主形态不是 qzjs 能干涉的」。
             * 无法从 magic 之外的字段证明线程真的退出了（shutting_down 置位早于线程
             * return），所以「线程可能还在跑」必须当成默认假设。要真正回收，宿主得
             * 走 qz_destroy（它会 join）或先 qz_wait_idle。 */
            fprintf(stderr,
                    "qz_free: runtime's thread was never joined — the runtime, its "
                    "mailbox and its wake fd are all left untouched (freeing them "
                    "would race with a still-running thread; that is a use-after-free "
                    "at best and could write into an unrelated host fd at worst). "
                    "Call qz_wait_idle(rt) then qz_free(rt), or qz_destroy(rt), to "
                    "release it.\n");
            return;
        }
        qz_mailbox_teardown(rt);
        free((void *)rt->config.initial_script);
        free((void *)rt->config.initial_bytecode);
    }
    free(ptr);
}
/* ================================================================
 * qz_compile — 宿主侧字节码编译（独立，无需运行时实例）
 * ================================================================ */

int qz_compile(const char *source, size_t len, const char *filename,
               uint8_t **out, size_t *out_len, char **err)
{
    if (err) *err = NULL;
    if (out) *out = NULL;
    if (out_len) *out_len = 0;
    if (!source || !out || !out_len) {
        if (err) *err = strdup("qz_compile: bad arguments");
        return -1;
    }

    /* 一次性 JSRuntime/JSContext：与运行实例同引擎构建（同一份链接的
     * quickjs-ng），字节码格式天然匹配；编译后即弃，不触碰任何 qz_t。 */
    JSRuntime *jsrt = JS_NewRuntime();
    if (!jsrt) {
        if (err) *err = strdup("qz_compile: out of memory");
        return -1;
    }
    JSContext *ctx = JS_NewContext(jsrt);
    if (!ctx) {
        JS_FreeRuntime(jsrt);
        if (err) *err = strdup("qz_compile: out of memory");
        return -1;
    }

    /* 与 qz_eval_internal 对齐：恒为全局脚本（qzjs 的初始程序不支持
     * ES module —— 含 import/export 的源请走源码路径自带报错）。 */
    JSValue obj = JS_Eval(ctx, source, len,
                          filename ? filename : "<compile>",
                          JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(obj)) {
        if (err) {
            JSValue exc = JS_GetException(ctx);
            const char *msg = JS_ToCString(ctx, exc);
            *err = msg ? strdup(msg) : NULL;
            if (msg) JS_FreeCString(ctx, msg);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeContext(ctx);
        JS_FreeRuntime(jsrt);
        return -1;
    }

    size_t sz = 0;
    uint8_t *bc = JS_WriteObject(ctx, &sz, obj, JS_WRITE_OBJ_BYTECODE);
    JS_FreeValue(ctx, obj);
    if (!bc) {
        if (err) {
            JSValue exc = JS_GetException(ctx);
            const char *msg = JS_ToCString(ctx, exc);
            *err = msg ? strdup(msg) : NULL;
            if (msg) JS_FreeCString(ctx, msg);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeContext(ctx);
        JS_FreeRuntime(jsrt);
        return -1;
    }

    /* JS_WriteObject 缓冲走 js_malloc（引擎分配器）；拷到宿主 malloc 块，
     * 让 qz_free（普通 free）安全释放，避免分配器语义耦合。 */
    uint8_t *copy = (uint8_t *)malloc(sz ? sz : 1);
    if (!copy) {
        js_free(ctx, bc);
        JS_FreeContext(ctx);
        JS_FreeRuntime(jsrt);
        if (err) *err = strdup("qz_compile: out of memory");
        return -1;
    }
    memcpy(copy, bc, sz);
    js_free(ctx, bc);
    JS_FreeContext(ctx);
    JS_FreeRuntime(jsrt);

    *out = copy;
    *out_len = sz;
    return 0;
}

/* ================================================================
 * qzjs 线程侧内部函数（thread.c 调用）
 * ================================================================ */

int qz_runtime_init(qz_t *rt)
{
    /* Create JSRuntime (shared across all contexts) */
    rt->jsrt = JS_NewRuntime();
    if (!rt->jsrt) return -1;
#ifdef QZ_SANITIZE_BUILD
    /* sanitizer（ASan/UBSan）插桩使每个 JS 帧的 C 栈开销放大 2-5 倍：
     * QuickJS 默认 1MB JS 栈预算（JS_DEFAULT_STACK_SIZE）在宿主调用链
     * 较深时误报 "stack overflow"（fetch/streams 同步链实测触发）。将预算
     * 放大到 qzjs 线程默认栈的一半（8MB/2），普通构建不受影响（该宏仅
     * sanitizer 构建注入，见 CMakeLists sanitizer 检测）。 */
    JS_SetMaxStackSize(rt->jsrt, 4 * 1024 * 1024);
#endif
    /* CTL-0 §3.9：安装 runtime 级中断处理器——只读 ctl_interrupt 原子标志。 */
    JS_SetInterruptHandler(rt->jsrt, qz_ctl_interrupt_handler, rt);
    JS_SetRuntimeOpaque(rt->jsrt, rt);

    /* Initialize context table */
    rt->context_count = 0;
    rt->active_ctx_id = -1;
    for (int i = 0; i < QZ_MAX_CONTEXTS; i++) rt->contexts[i] = NULL;

    /* Create initial context (ext init / polyfill 注入在 qz_ctx_create 内) */
    qz_ctx_t *ctx = qz_ctx_create(rt, &rt->config);
    if (!ctx) {
        JS_FreeRuntime(rt->jsrt);
        rt->jsrt = NULL;
        return -1;
    }
    rt->active_ctx_id = ctx->context_id;

#ifdef QZ_DEBUG_SUPPORT
    /* Auto-attach the DAP debugger when enabled (env QZ_DEBUG=1 or
     * config->debug bit 1). qz_dap_configure blocks reading the DAP
     * initialize/setBreakpoints/configurationDone exchange, so breakpoints
     * are armed before the host's first message.
     *
     * 作用域语义（A4 多上下文断点）：DAP 走 stdio 单通道，一个进程只有一份
     * stdin/stdout，无法同时服务两个 runtime 的协议会话。因此 worker 运行时
     * （rt->worker_self != NULL，独立线程 + 独立 JSRuntime）不 auto-attach——
     * 否则它会与父 runtime 竞争读同一 stdin（父的 configure/on_stopped 循环
     * 会吞掉 worker 的协议消息 → 死锁/错乱）。结果：断点只作用于 attach 的
     * 那个 runtime 的 source 文件执行；父 runtime 设的断点不影响 worker。 */
    {
        int enable = 0;
        if (rt->worker_self == NULL) {
            const char *env = getenv("QZ_DEBUG");
            if (env && (env[0] == '1' || env[0] == 't' || env[0] == 'T'))
                enable = 1;
            if (rt->config.debug & 0x2)  /* bit 1 = debug-enable */
                enable = 1;
        }
        if (enable) {
            qz_dap_config_t dcfg;
            dcfg.stop_on_entry = 1;
            dcfg.in = NULL;   /* stdin */
            dcfg.out = NULL;  /* stdout */
            int rc = qz_dap_attach(rt, &dcfg);
            if (rc == 0) {
                qz_dap_configure(rt);  /* blocks until configurationDone */
            } else if (rc == -2) {
                /* M-R1 §13.2：stdio 已被同进程另一 runtime 认领。显式失败
                 * （qz_create 返回 NULL），不静默降级成无调试器运行——
                 * 与开放点 #2 的「不静默降级」裁决一致。 */
                rt->ready_err = -2;
            }
            /* rc == -1（qz_debug_attach 失败等其他错误）：维持旧行为，
             * 运行时继续无调试器运行。 */
        }
    }
#endif

    return 0;
}

int qz_eval_internal(qz_t *rt, const char *script, char **err)
{
    JSContext *ctx = qz_get_active_jsctx(rt);
    if (!ctx) return -1;

    JSValue val = JS_Eval(ctx, script, strlen(script), "<initial>",
                          JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(val)) {
        if (err) {
            JSValue exc = JS_GetException(ctx);
            const char *msg = JS_ToCString(ctx, exc);
            *err = msg ? strdup(msg) : NULL;
            if (msg) JS_FreeCString(ctx, msg);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeValue(ctx, val);
        return -1;
    }
    JS_FreeValue(ctx, val);
    return 0;
}

/* 在活动 context 上执行预编译字节码（JS_ReadObject + JS_EvalFunction）。
 * 用于编译期注入的 JS（worker 启动垫片等），与 qz_eval_internal 的
 * 错误提取语义一致。 */
int qz_eval_bytecode_internal(qz_t *rt, const uint8_t *code, size_t len,
                                char **err)
{
    JSContext *ctx = qz_get_active_jsctx(rt);
    if (!ctx) return -1;

    JSValue obj = JS_ReadObject(ctx, code, len, JS_READ_OBJ_BYTECODE);
    if (JS_IsException(obj)) {
        if (err) {
            JSValue exc = JS_GetException(ctx);
            const char *msg = JS_ToCString(ctx, exc);
            *err = msg ? strdup(msg) : NULL;
            if (msg) JS_FreeCString(ctx, msg);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeValue(ctx, obj);
        return -1;
    }
    JSValue val = JS_EvalFunction(ctx, obj);
    if (JS_IsException(val)) {
        if (err) {
            JSValue exc = JS_GetException(ctx);
            const char *msg = JS_ToCString(ctx, exc);
            *err = msg ? strdup(msg) : NULL;
            if (msg) JS_FreeCString(ctx, msg);
            JS_FreeValue(ctx, exc);
        }
        JS_FreeValue(ctx, val);
        return -1;
    }
    JS_FreeValue(ctx, val);
    return 0;
}

static void qz_close_walk_cb(uv_handle_t *h, void *arg)
{
    QZ_UNUSED(arg);
    /* ctx/ext teardown (step 4) may already have closed some handles without
     * their close callbacks running
     * (the loop is not run again); walk still sees those handles in the queue,
     * so skip the ones already closing. */
    if (!uv_is_closing(h)) uv_close(h, NULL);
}

void qz_thread_teardown(qz_t *rt)
{
    /* -1) 关闭本地控制端点（CTL-2 §2.3）：断开外部控制器连接（同时清理其
     * 名下未完成回执条目），unlink 端点文件。uv_close 的回收由下文步骤 2.5
     * 的 uv_run 处理；端点不持有 JSRuntime/context 状态，先关最安全。 */
    qz_ctl_endpoint_close(rt);

    /* 0) 先终止所有 worker（Task 4）。必须在排空队列/JSRuntime 之前：worker
     * 线程可能仍向本队列推消息（join 期间 msg_mutex 必须存活），且 JSRuntime
     * 释放后 worker 自己的 teardown 不再需要父侧任何状态。join 在本线程做，
     * 随后 free 结构。 */
    for (int i = 0; i < QZ_MAX_WORKERS; i++) {
        qz_worker_t *w = rt->workers[i];
        if (w) {
            qz_worker_terminate(rt, w);
            /* 线程后端：join 已请求退出的 worker 线程（进程 worker 由 JS 层
             * processTerminate 管理——C 层 qz_worker_t 仅服务线程后端，
             * spawn 分层化 Phase C）。 */
            if (w->self)
                uv_thread_join(&w->thread);
            rt->workers[i] = NULL;
            qz_worker_free(w);
        }
    }

#ifndef QZ_USE_MOCK_LIBUV
    /* 0.5) 终止残留的 pal.processSpawn 句柄（spawn 分层化, Phase B）：JS
     *      未显式 processTerminate 的句柄在此收尾——3-tier 杀掉子进程 + 释放
     *      proc 结构。onmsg 是 JS 回调函数引用：必须在此 JS_FreeValue（本步
     *      在 contexts 销毁 / JS_FreeRuntime 之前，h->ctx->jsctx 有效），否则
     *      残留引用使 JS_FreeRuntime 的 gc_obj_list 断言失败。 */
    for (int i = 0; i < QZ_MAX_PROC_HANDLES; i++) {
        qz_proc_handle_t *h = &rt->proc_handles[i];
        if (h->live && h->proc) {
            qz_proc_terminate(h->proc, 0);
            qz_proc_free(h->proc);
        }
        if (h->live && h->ctx && h->ctx->jsctx)
            JS_FreeValue(h->ctx->jsctx, h->onmsg);
        h->onmsg = JS_UNDEFINED;
        h->ctx = NULL;
        h->proc = NULL;
        h->live = 0;
    }
#endif
    /* 1) drain any remaining inbound queue (pop already frees passed nodes;
     *    the final node stays on head) */
    qz_msg_t *m;
    while ((m = qz_msg_pop(rt)) != NULL) {}
    if (rt->msg_head != &rt->msg_stub) qz_msg_free(rt->msg_head);
    rt->msg_head = &rt->msg_stub;

    /* 1.5) abort in-flight streaming HTTP op（若存在）。uv_io_http_abort 会
     * 同步触发 on_end（JS_Call，bridge_stream_on_end 释放 bs）并关闭
     * tcp/timer 句柄；必须赶在销毁 contexts / 释放 JSRuntime 之前，否则
     * on_end 访问已释放的 ctx。abort 排的 JS job 由步骤 2 的循环消化。 */
    if (rt->active_stream) {
        uv_io_http_abort(rt);
    }

    /* 2) 排空 pending JS jobs BEFORE freeing contexts/runtime，否则
     * JS_FreeRuntime 会在非空 gc_obj_list 上断言（Promise 反应引用着
     * 尚未执行的闭包/值）。 */
    if (rt->jsrt) {
        JSContext *job_ctx = NULL;
        int ret;
        while ((ret = JS_ExecutePendingJob(rt->jsrt, &job_ctx)) > 0) {}
    }
    /* 2.5) 排空 libuv 已排队但未处理的 request 完成（work_done）。
     * 必须在销毁 contexts / 释放 JSRuntime 之前：完成回调（bridge_io_done）
     * 会 JS_Call resolve，需要活着的 ctx 与 jsrt。wait_idle 路径由
     * qz_loop_idle 的 active_reqs 检查保证 teardown 时无残留；此处兜底
     * 强制 shutdown（qz_destroy）的瞬时窗口。限轮防止在途慢请求
     * 导致 busy-spin（UV_RUN_NOWAIT 的返回值是 loop-alive，不是"处理数"）。 */
    for (int i = 0; i < 16; i++) {
        if (uv_run(&rt->loop, UV_RUN_NOWAIT) == 0) break;
        if (rt->jsrt) {
            JSContext *job_ctx = NULL;
            while (JS_ExecutePendingJob(rt->jsrt, &job_ctx) > 0) {}
        }
    }

    /* 3) DAP detach 必须先于 contexts/JSRuntime 释放：qz_debug_detach 会调
     * JS_SetDebuggerHandler(jsrt, NULL)（在已释放的 runtime 上写即 UAF），
     * 并释放缓存的 paused-frame 快照（JS_FreeCallFrames 需要活的 ctx）。 */
#ifdef QZ_DEBUG_SUPPORT
    if (rt->dbg_session) {
        qz_dap_detach(rt);
        rt->dbg_session = NULL;
    }
#endif
    /* CTL-0：回收未完成回执条目 + 销毁 ctl_lock。必须在 loop 关闭前：
     * 条目/锁不依赖 loop/JSRuntime。 */
    qz_ctl_teardown(rt);

    /* 4) 销毁所有 contexts（内含扩展 destroy） */
    for (int i = 0; i < QZ_MAX_CONTEXTS; i++) {
        if (rt->contexts[i]) qz_ctx_destroy(rt, rt->contexts[i]);
    }

    /* 5) 释放 JSRuntime（gc_obj_list 已空） */
    if (rt->jsrt) JS_FreeRuntime(rt->jsrt);

    /* 6) 释放 uv_io in-memory storage（key/value 均为堆分配） */
    for (int i = 0; i < rt->store_count; i++) {
        free(rt->store[i].key);
        free(rt->store[i].value);
    }
    free(rt->store);
    rt->store = NULL;
    rt->store_count = 0;

    /* 6.5) 释放 Proxy-Authorization 缓存（uv_io_http_apply_proxy 分配）。
     * 所有 in-flight op 已在上文步骤 1.5 中止清理，无 op 再借用该指针。 */
    free(rt->proxy_auth_url);
    free(rt->proxy_auth_value);
    rt->proxy_auth_url = NULL;
    rt->proxy_auth_value = NULL;

    /* 6.7) 释放 polyfill 字节码缓存（qz_ctx_create_at 惰性加载，各 context
     * 共享同一份）。C mode 无堆分配（unload 是 no-op）；A/B/D 释放堆缓冲。 */
    qz_polyfill_unload(rt->polyfill_owner);
    rt->polyfill_owner = NULL;
    rt->polyfill = NULL;
    rt->polyfill_len = 0;

    /* 7) 关闭 loop：close 全部 handle → 处理 close 回调 → loop_close
     *（libuv 里 stop 过但仍 open 的 handle 也会让 uv_loop_close EBUSY，
     * 所以必须 walk-close 而非只关 wake）。 */
    uv_walk(&rt->loop, qz_close_walk_cb, NULL);
    uv_run(&rt->loop, UV_RUN_NOWAIT);
    qz_close_loop(&rt->loop);
    /* close-failed: 仍 free rt（uv_loop_t 按值内嵌其中）——见 qz_close_loop 的取舍说明。 */
}
