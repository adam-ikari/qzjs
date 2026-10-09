/* 消息队列（msgq）类型 + 进程内 FIFO/邮箱 API。
 * qz_msg_t/qz_mq_t 被 qz_t 内嵌引用，故 msg 层是 qz_core.h 的下游依赖。 */
#ifndef QZ_MSG_H
#define QZ_MSG_H

#include "base/qz_types.h"

#ifdef __cplusplus
extern "C" {
#endif

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

#ifdef __cplusplus
}
#endif

#endif /* QZ_MSG_H */
