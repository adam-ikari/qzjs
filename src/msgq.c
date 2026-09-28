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
 *   - outbound mailbox (rt->mq_out): the library's pump/JS threads produce,
 *     the host consumes via qz_recv_message (single-consumer rule, see
 *     qzjs.h). Push writes the eventfd AFTER linking (publish-before-signal:
 *     丢唤醒免疫，只要宿主遵守三步消费协议)。
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

int qz_out_push(qz_t *rt, const char *json, size_t len)
{
    if (len > (size_t)-1 - sizeof(qz_msg_t) - 1) return -1;
    qz_msg_t *m = (qz_msg_t *)malloc(sizeof *m + len + 1);
    if (!m) return -1;
    m->data = (char *)(m + 1);
    memcpy(m->data, json, len);
    m->data[len] = '\0';
    m->len = len;
    m->source = 0;
    m->flags = 0;

    __atomic_store_n(&m->q.next, (struct uv__queue *)NULL, __ATOMIC_RELAXED);
    qz_msg_t *prev = __atomic_exchange_n(&rt->mq_out.tail, m, __ATOMIC_ACQ_REL);
    __atomic_store_n(&prev->q.next, &m->q, __ATOMIC_RELEASE);

    /* Publish-before-signal：先入链后写计数，配合宿主三步消费协议（先清箱、
     * 再清 fd、复核）保证不丢唤醒。efd 写失败（EMFILE 外几乎不可能）不影响
     * 消息本体——recv 轮询仍能取到。 */
    if (rt->out_efd >= 0) {
        uint64_t one = 1;
        ssize_t rc = write(rt->out_efd, &one, sizeof one);
        (void)rc;
    }
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
