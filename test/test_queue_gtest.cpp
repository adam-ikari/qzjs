// 出站邮箱队列的**单元**测试（M-P7 的核心数据结构本身）
//
// 为什么要有这一层：qz_out_push / qz_out_pop / qz_out_has_pending 在
// qz_internal.h 里是可见的，但此前**没有任何测试直接碰过它们**——M-P7 的承重结构
// 一直只被整运行时间接测（发消息 → JS 回声 → 收）。那样测不出属于「队列」而不是
// 「运行时」的性质，而恰恰是这些性质在改动时最容易破：
//
//   · FIFO 顺序（单消费者的 head 推进是否真的严格保序）
//   · 空队列 pop 返回 NULL（不是空指针、不是崩）
//   · has_pending 的状态迁移
//   · qz_mailbox_teardown 的**幂等**：本轮把它的实现从「靠调用次数门控」改成
//     「排干后把 head/tail/stub 复位到 init 状态」，因为排干循环只把 head 推到尾节点、
//     stub.q.next 仍指向链上第一个已被 free 的节点——不重置就是悬垂指针，二次 teardown
//     或任何复检都会踩已释放内存。这条性质此前没有任何测试直接锁住。
//   · 多生产者 + 单消费者的**计数完整性**：顺序在跨生产者时不确定（所以不断言顺序），
//     但「一条不多一条不少、内容不丢不重」必须成立。
//
// 这些都是纯队列性质，不需要 JS、不需要事件循环、不需要时间——这正是「单元」的含义。

#include "test_host.h"

#include <atomic>
#include <cstdio>
#include <cstring>
#include <set>
#include <string>
#include <thread>
#include <vector>

namespace {

// 建一个最朴素的运行时：只要 mailbox 在就行，不需要脚本、不需要控制面。
qz_t *make_bare_rt() {
    auto *cfg = new qz_config_t();
    cfg->initial_script = "";
    cfg->control_plane = QZ_CONTROL_OFF;
    qz_t *rt = qz_create(cfg);
    delete cfg;
    return rt;
}

std::string frame_text(size_t i) {
    char b[64];
    int n = snprintf(b, sizeof b, "{\"i\":%zu}", i);
    return std::string(b, (size_t)n);
}

}  // namespace

// 1. FIFO：先进先出，逐条内容与顺序都对。
TEST(mailbox_queue, push_then_pop_is_fifo) {
    qz_t *rt = make_bare_rt();
    ASSERT_NE(nullptr, rt);

    const size_t kN = 64;
    for (size_t i = 0; i < kN; i++) {
        std::string f = frame_text(i);
        ASSERT_EQ(0, qz_out_push(rt, f.c_str(), f.size())) << "第 " << i << " 条入箱失败";
    }
    ASSERT_TRUE(qz_out_has_pending(rt)) << "入箱 " << kN << " 条后 has_pending 必须为真";

    for (size_t i = 0; i < kN; i++) {
        qz_msg_t *m = qz_out_pop(rt);
        ASSERT_NE(nullptr, m) << "第 " << i << " 次 pop 返回 NULL（队列提前空了）";
        EXPECT_EQ(frame_text(i), std::string(m->data, m->len))
            << "第 " << i << " 条内容/顺序不符";
    }
    EXPECT_EQ(nullptr, qz_out_pop(rt)) << "排空后再 pop 必须返回 NULL";
    EXPECT_FALSE(qz_out_has_pending(rt)) << "排空后 has_pending 必须为假";

    qz_destroy(rt);
}

// 2. 空队列：pop 返回 NULL、has_pending 为假——不得崩、不得返回野指针。
//    （这条对「宿主在没消息时也照调」的场景是前提。）
TEST(mailbox_queue, empty_queue_pops_null) {
    qz_t *rt = make_bare_rt();
    ASSERT_NE(nullptr, rt);
    for (int i = 0; i < 5; i++) {
        EXPECT_EQ(nullptr, qz_out_pop(rt)) << "第 " << i << " 次对空队列 pop 必须返回 NULL";
    }
    EXPECT_FALSE(qz_out_has_pending(rt));
    qz_destroy(rt);
}

// 3. has_pending 的状态迁移：入箱 → 真，弹一条 → 仍真（还有剩余），弹到最后一条 → 假。
TEST(mailbox_queue, has_pending_tracks_backlog) {
    qz_t *rt = make_bare_rt();
    ASSERT_NE(nullptr, rt);
    EXPECT_FALSE(qz_out_has_pending(rt)) << "新建后不应有积压";

    std::string a = "{\"a\":1}", b = "{\"b\":2}";
    qz_out_push(rt, a.c_str(), a.size());
    EXPECT_TRUE(qz_out_has_pending(rt));
    qz_out_push(rt, b.c_str(), b.size());
    EXPECT_TRUE(qz_out_has_pending(rt));

    qz_msg_t *m = qz_out_pop(rt);
    ASSERT_NE(nullptr, m);
    EXPECT_EQ(a, std::string(m->data, m->len));
    EXPECT_TRUE(qz_out_has_pending(rt)) << "还剩一条时必须仍为真";

    m = qz_out_pop(rt);
    ASSERT_NE(nullptr, m);
    EXPECT_FALSE(qz_out_has_pending(rt)) << "弹完最后一条必须变假";
    qz_destroy(rt);
}

// 4. **teardown 幂等**（本轮改过的那处）。排干会留下 stub.q.next 指向已释放节点的
//    悬垂指针，实现已改成排干后把 head/tail/stub 复位到 init 状态。这条性质
//    此前无人锁住：二次 teardown 或任何复检都会踩已释放内存。
TEST(mailbox_queue, teardown_is_idempotent_and_resets_state) {
    qz_t *rt = make_bare_rt();
    ASSERT_NE(nullptr, rt);

    std::string a = "{\"a\":1}", b = "{\"b\":2}";
    qz_out_push(rt, a.c_str(), a.size());
    qz_out_push(rt, b.c_str(), b.size());

    qz_mailbox_teardown(rt);                       // 第一次：排干 + 关 fd
    EXPECT_FALSE(qz_out_has_pending(rt)) << "teardown 后不应有积压";
    EXPECT_EQ(nullptr, qz_out_pop(rt)) << "teardown 后 pop 必须干净地返回 NULL";

    // 关键：第二次不能踩第一次留下的悬垂指针。
    qz_mailbox_teardown(rt);
    qz_mailbox_teardown(rt);

    // 复位之后队列必须**还能用**——只保证「不崩」是不够的，还要保证没被废掉。
    std::string c = "{\"c\":3}";
    ASSERT_EQ(0, qz_out_push(rt, c.c_str(), c.size())) << "复位后入箱应可用";
    qz_msg_t *m = qz_out_pop(rt);
    ASSERT_NE(nullptr, m) << "复位后 pop 应可用";
    EXPECT_EQ(c, std::string(m->data, m->len));

    qz_destroy(rt);
}

// 5. 多生产者 + 单消费者：跨生产者的顺序不确定（所以不断言顺序），但
//    **一条不多一条不少、内容不丢不重**必须成立——这是 MPSC 队列的全部意义。
TEST(mailbox_queue, multi_producer_count_and_content_integrity) {
    qz_t *rt = make_bare_rt();
    ASSERT_NE(nullptr, rt);

    const int kThreads = 4, kPer = 250;
    const int kTotal = kThreads * kPer;
    std::atomic<int> pushed{0};
    std::atomic<bool> producers_done{false};
    std::vector<std::thread> producers;
    for (int t = 0; t < kThreads; t++) {
        producers.emplace_back([rt, t, &pushed] {
            for (int i = 0; i < kPer; i++) {
                char b[64];
                int n = snprintf(b, sizeof b, "{\"p\":%d,\"i\":%d}", t, i);
                qz_out_push(rt, b, (size_t)n);
                pushed.fetch_add(1, std::memory_order_release);
            }
        });
    }

    /* qz_out_pop 没有阻塞形态（空就返回 NULL，这是契约），所以消费侧要「弹到收齐
     * 为止、中途空就等生产者」。第一版这里弹固定 kTotal 次就断言非空，直接红在
     * 「pop 返回 NULL」上——那是队列的正确行为，测试写错了。 */
    std::set<std::string> seen;
    int got = 0;
    int idle_spins = 0;
    while (got < kTotal) {
        qz_msg_t *m = qz_out_pop(rt);
        if (m) {
            seen.insert(std::string(m->data, m->len));
            got++;
            idle_spins = 0;
            continue;
        }
        if (producers_done.load(std::memory_order_acquire) &&
            pushed.load(std::memory_order_acquire) >= kTotal) {
            break;                       /* 生产者全退、计数满了，却弹空 → 真的丢了 */
        }
        if (++idle_spins > 200000) break; /* 兜底，别让失败路径死循环 */
        std::this_thread::yield();
    }
    for (auto &p : producers) p.join();
    producers_done.store(true, std::memory_order_release);

    EXPECT_EQ(kThreads * kPer, got) << "弹出总数与推送总数不符";
    EXPECT_EQ((size_t)(kThreads * kPer), seen.size()) << "有内容重复（同一帧被投递两次）";
    EXPECT_EQ(nullptr, qz_out_pop(rt)) << "全部取完后不应再有残留";

    qz_destroy(rt);
}
