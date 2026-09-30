/*
 * qzjs Message Queues — lock-free MPSC on libuv primitives
 *
 * Philosophy: every qzjs runtime/worker is single-threaded; no mutex/cond
 * inside the core (on some kernels futex/pthread_cond wakeups are unreliable,
 * e.g. PVE 6.17 after an fd is created). Cross-thread communication uses only
 * libuv (uv_async_send) for loop-owned wakeups, or a plain eventfd + the
 * mailbox consume protocol for host-side wakeups — never futex/condvar.
 * GCC/Clang atomics carry the memory ordering:
 *
 *   - push (any producer thread): write the node, atomically exchange
 *     tail to claim a unique predecessor, then release-store the link
 *     into the predecessor's q.next. Each producer gets a distinct
 *     predecessor, so there is no write-write race.
 *   - pop / has_pending (the exclusive consumer, per queue): acquire-load
 *     head->q.next. The consumer owns head, so no lock is needed.
 *
 * Ordering: the ACQ_REL exchange pairs with the acquire load of q.next, making
 * the node contents written before the exchange visible to the consumer; FIFO
 * order follows the linked q.next chain.
 *
 * Two instances per runtime:
 *   - inbound  (rt->msg_head/msg_tail/msg_stub): many producers (host API,
 *     workers, control plane) → the qzjs/main-RT thread consumes. Push does
 *     NOT wake the loop; each inbound call site sends uv_async explicitly
 *     (唤醒与容器解耦：邮箱方向的入箱绝不可触发库线程唤醒，反之入站调用点
 *     各自决定何时需要唤醒)。
 *   - outbound mailbox (rt->mq_out): the library's host-side and JS threads
 *     produce, the host consumes via qz_recv_message (single-consumer rule,
 *     see qzjs.h). Push writes the eventfd AFTER linking
 *     (publish-before-signal: 丢唤醒免疫，只要宿主遵守三步消费协议)。
 */

#include "qz_internal.h"
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>

/* Generic MPSC: `tail` is exchanged by producers (ACQ_REL), `head` is owned by
 * the exclusive consumer, `stub` is the resident sentinel (after init
 * head == tail == &stub). Pop frees the OLD head only — the returned node is
 * dispatched by the caller and becomes the next pop's head; head never dangles.
 * Used by the outbound mailbox (rt->mq_out); the inbound queue keeps its
 * long-standing inline fields (msg_head/msg_tail/msg_stub). */

/* ── inbound（现网字段名保持：rt->msg_head/msg_tail/msg_stub）── */

int qz_msg_push(qz_t *rt, const char *data, size_t len, int source, int flags)
{
    /* len+1 与 sizeof(qz_msg_t) 相加不得溢出,否则 malloc 得到小块而
     * memcpy 越界写。len 来自 JS 侧 ArrayBuffer 长度或宿主,理论上可达
     * SIZE_MAX(整数溢出)或极大值(分配炸弹),统一在此拒绝。 */
    if (len > (size_t)-1 - sizeof(qz_msg_t) - 1) return -1;
    qz_msg_t *m = (qz_msg_t *)malloc(sizeof *m + len + 1);
    if (!m) return -1;   /* OOM:拒绝入队而非解引用 NULL */
    m->data = (char *)(m + 1);
    memcpy(m->data, data, len);
    m->data[len] = '\0';
    m->len = len;
    m->source = source;
    m->flags = (uint8_t)flags;

    /* Publish the node, then link it after the previous tail (ACQ_REL so the
     * consumer's acquire sees all fields written before the exchange).
     * 唤醒不在此处：入站调用点各自 uv_async_send(&rt->wake)。 */
    __atomic_store_n(&m->q.next, (struct uv__queue *)NULL, __ATOMIC_RELAXED);
    qz_msg_t *prev = __atomic_exchange_n(&rt->msg_tail, m, __ATOMIC_ACQ_REL);
    __atomic_store_n(&prev->q.next, &m->q, __ATOMIC_RELEASE);
    return 0;
}

qz_msg_t *qz_msg_pop(qz_t *rt)
{
    qz_msg_t *head = rt->msg_head;
    struct uv__queue *nq = __atomic_load_n(&head->q.next, __ATOMIC_ACQUIRE);
    if (nq == NULL) return NULL;
    qz_msg_t *next = uv__queue_data(nq, qz_msg_t, q);
    rt->msg_head = next;
    if (head != &rt->msg_stub) free(head);
    return next;
}

int qz_msg_has_pending(qz_t *rt)
{
    /* Consumer-thread check; head does not migrate across threads, safe
     * without a lock. */
    return __atomic_load_n(&rt->msg_head->q.next, __ATOMIC_ACQUIRE) != NULL;
}

void qz_msg_free(qz_msg_t *m)
{
    free(m);
}

/* ── outbound mailbox ──
 * payload 语义与入站逐字节同构：len+1 拷贝、NUL 终止、宿主 free。 */

void qz_out_mq_init(qz_t *rt)
{
    rt->mq_out.head = rt->mq_out.tail = &rt->mq_out.stub;
    __atomic_store_n(&rt->mq_out.stub.q.next, (struct uv__queue *)NULL,
                     __ATOMIC_RELAXED);
}

/* 已填好的节点入链 + 发唤醒。publish-before-signal：先入链后写计数，配合宿主
 * 三步消费协议（先清箱、再清 fd、复核）保证不丢唤醒。efd 写失败（EMFILE 外
 * 几乎不可能）不影响消息本体——recv 轮询仍能取到。 */
static void qz_out_link(qz_t *rt, qz_msg_t *m)
{
    __atomic_store_n(&m->q.next, (struct uv__queue *)NULL, __ATOMIC_RELAXED);
    qz_msg_t *prev = __atomic_exchange_n(&rt->mq_out.tail, m, __ATOMIC_ACQ_REL);
    __atomic_store_n(&prev->q.next, &m->q, __ATOMIC_RELEASE);

    if (rt->out_efd >= 0) {
        uint64_t one = 1;
        ssize_t rc = write(rt->out_efd, &one, sizeof one);
        (void)rc;
    }
}

/* 分配失败时的标记帧。出站邮箱无界（宿主不排干就一直涨，涨到 malloc 失败为止），
 * 所以这一路必须存在；但它**不能静默**——静默丢会在宿主看到的流上留一个无标记
 * 的洞：宿主既不知道少了消息、也不知道缺的是哪一条，更无从补取。
 * 先试塞一条固定大小的错误帧把洞标出来（OOM 常常是瞬时的/碎片化的，小分配仍
 * 可能成功，标记就能进箱）；连它都分配不出才落 stderr，并按累计量节流
 * （1,2,4,8,…），避免 OOM 风暴把 stderr 本身冲垮。 */
static void qz_out_report_oom(qz_t *rt)
{
    static const char kOom[] =
        "{\"type\":\"error\",\"error\":\"mailbox-alloc-failed\","
        "\"hint\":\"outbound mailbox is unbounded; drain it faster — "
        "this frame marks a dropped message\"}";
    /* 不限流：每次失败都标一条。想过「限流免得每次失败都再挂一个节点、让 OOM
     * 更严重」——但那等于允许「首个 drop 无标记」，直接违背本函数要守的不变量
     *（宿主必须在流上看见洞）。而且真正 OOM 时这枚 ~183B 的节点（sizeof(qz_msg_t)
     * 40 + 标记帧 143）同样分配不出，会落到
     * 下面那条节流的 stderr —— 自限是 malloc 失败这个事实给的，不是我们自己
     * 加的闸。 */
    qz_msg_t *m = (qz_msg_t *)malloc(sizeof *m + sizeof kOom);
    if (!m) {
        static int64_t reported;
        int64_t n = __atomic_add_fetch(&reported, 1, __ATOMIC_RELAXED);
        if (n == 1 || (n & (n - 1)) == 0)
            fprintf(stderr,
                    "qzjs: mailbox alloc failed, message dropped (%lld so far) "
                    "— even the marker frame could not be allocated\n",
                    (long long)n);
        return;
    }
    m->data = (char *)(m + 1);
    memcpy(m->data, kOom, sizeof kOom - 1);
    m->len = sizeof kOom - 1;
    m->source = 0;
    m->flags = 0;
    qz_out_link(rt, m);
}

/* 测试专用钩子：让 rt 接下来 N 次 qz_out_push 的**主**分配强制失败，N=0 关闭。
 * 用来直接验「OOM 时宿主能在流上看见标记帧」这条不变量——真把机器内存吃光不是
 * 可复现的测试手段。标记帧自己的分配不受影响，所以标记一定入箱（除非连它也
 * 分配不出，那正是要验的第二条路径）。rt 由 calloc 分配，缺省 0 = 无注入。
 * 用法见 test/test_mailbox_oom_gtest.cpp。
 *
 * 形态说明：这是 per-rt 字段，**没有** env 入口。曾经做成进程级全局 + 环境变量
 * QZ_MAILBOX_FAULT_INJECT，代价是：
 *   · 生产库里留了一个「静默丢消息」的总开关——谁在 shell profile 或 CI 全局
 *     env 里手滑留一行，运行时就开始静默丢消息，日志里一个症状都没有，没人能从
 *     现象反推回这个变量；
 *   · 进程级意味着同进程内多个 rt 共享额度，与「注入 N 次出站分配失败」要表达
 *     的事根本不是一回事；
 *   · 还得配一个 init latch，因为全局没法重新武装——补 N=3 用例时才发现一个
 *     测试进程只能注入一次。
 * 正确作用域就是 per-rt：一个 int 字段就够，以上三条全部消失。 */
void qz_test_mailbox_fault(qz_t *rt, int n)
{
    __atomic_store_n(&rt->out_fault, n > 0 ? n : 0, __ATOMIC_RELAXED);
}

int qz_out_push(qz_t *rt, const char *json, size_t len)
{
    if (len > (size_t)-1 - sizeof(qz_msg_t) - 1) return -1;
    /* 注入命中时走 OOM 标记路径（rt->out_fault 由 qz_test_mailbox_fault 设，
     * 生产恒为 0，于是这里只是一次 load + 一次分支；push 本来就要 malloc +
     * 原子入链，这点开销可忽略）。饱和递减：到 0 就不再往下减，避免计数变负
     * 之后被误读成别的含义。 */
    int prev = __atomic_load_n(&rt->out_fault, __ATOMIC_RELAXED);
    int inject = 0;
    for (;;) {
        if (prev <= 0) break;
        if (__atomic_compare_exchange_n(&rt->out_fault, &prev, prev - 1, 0,
                                        __ATOMIC_RELAXED, __ATOMIC_RELAXED)) {
            inject = 1;
            break;
        }
    }
    qz_msg_t *m = inject ? NULL : (qz_msg_t *)malloc(sizeof *m + len + 1);
    if (!m) {
        qz_out_report_oom(rt);
        return -1;
    }
    m->data = (char *)(m + 1);
    memcpy(m->data, json, len);
    m->data[len] = '\0';
    m->len = len;
    m->source = 0;
    m->flags = 0;
    qz_out_link(rt, m);
    return 0;
}

qz_msg_t *qz_out_pop(qz_t *rt)
{
    qz_msg_t *head = rt->mq_out.head;
    struct uv__queue *nq = __atomic_load_n(&head->q.next, __ATOMIC_ACQUIRE);
    if (nq == NULL) return NULL;
    qz_msg_t *next = uv__queue_data(nq, qz_msg_t, q);
    rt->mq_out.head = next;
    if (head != &rt->mq_out.stub) free(head);
    return next;
}

int qz_out_has_pending(qz_t *rt)
{
    return __atomic_load_n(&rt->mq_out.head->q.next, __ATOMIC_ACQUIRE) != NULL;
}

/* 出站唯一漏斗。分流三态：
 *   - 主RT 子进程（rt->host_emit = server_emit_cb，rt_main.c 内部挂载）
 *     → 走进程上行通道，行为与旧公共回调时代逐字节一致；
 *   - worker 自有 rt → 丢弃（worker 的消息本就只到父端点，父端点负责转发）；
 *   - 宿主 rt（两编译模型同一邮箱）→ qz_out_push，等宿主 qz_recv_message。
 * 库永不直接调用宿主代码：host_emit 是库自己（子进程内）的内部钩子。 */
void qz_post_to_host(qz_t *rt, const char *json, size_t len)
{
    if (rt->host_emit) { rt->host_emit(rt, json, len); return; }
    if (rt->worker_self) return;   /* worker 无宿主可见性 */
    qz_out_push(rt, json, len);
}
