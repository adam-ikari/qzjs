// 出站邮箱 OOM 可见性测试（src/msgq.c 的 qz_out_report_oom 与故障注入器）
//
// 出站邮箱是无界的：宿主不排干就一直涨，涨到 malloc 失败为止。这一路**不能
// 静默**——静默丢会在宿主看到的流上留一个无标记的洞，宿主既不知道少了消息、
// 也不知道缺的是哪一条，更无从补取。所以 qz_out_push 分配失败时要往流里塞一条
// 固定大小的标记帧（{"type":"error","error":"mailbox-alloc-failed",…}）。
//
// 真把内存吃光不是可复现的测试手段，故用 per-rt 测试钩子 qz_test_mailbox_fault：
// 让接下来 N 次 push 的**主**分配失败，标记帧自己的分配不受影响。刻意不用 env
// 开关——那会在生产库里留一个静默丢消息的总开关，同进程多个 rt 还会共享额度
// （同一进程就只能注入一次，第二个注入用例会静默地一个都不生效）。
//
// 本文件覆盖三件事，缺一不可：
//   1. 注入点确实失败、且标记帧进了邮箱（不是静默洞）；
//   2. 注入**恰好 N 次**。这一条是补上的：只测 N=1 时，一个把「未初始化哨兵」
//      和「剩余额度」混用同一个变量、fetch_sub 把 0 减成 -1 后被误读成哨兵的
//      无限丢消息 bug 完全看不出来（它表现为每 N+1 次丢一条，静默）。N=3 才
//      暴露：修前得到 888888468888884…，修后是 XXX………。
//   3. 注入耗尽后恢复正常——不是「一失败就永久坏」。
//
// 收干一律直接用 qz_recv_message，**不走** test_host.h 的 host_wait_msg：那个
// shim 带 eval 配对语义，超时清理时会丢掉所有以 `{"type":"error` 开头的帧
// ——而那正是标记帧的字面量。走 shim 的话，只要回执晚于预算到达，测试会报
// 「OOM 未在流上留标记」并附上一段空串：帧明明在流里，诊断却说它不在。

#include "test_host.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <string>
#include <vector>

static int64_t now_ms() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

namespace {

const char kEcho[] = "onmessage = function (e) { postMessage(e.data); };";

HostCtx *host_create_echo() {
    auto *h = new HostCtx();
    qz_config_t cfg = {};
    cfg.initial_script = kEcho;
    h->rt = qz_create(&cfg);
    if (!h->rt) { delete h; return nullptr; }
    return h;
}

// 收干邮箱：直接 qz_recv_message（不走 host_wait_msg，见文件头说明）。
// per_wait_ms 是**每条**的等待，不是只对第一条：JS 侧是异步回声，连发多条后
// 第一两条先到，若只给第一条预算、其后转纯轮询，后面几条会因 JS 线程还没回完
// 而永远收不到（表现为「只收到 2/8」——分不清是投递丢了还是没等够）。
// budget_ms 是总上限，防止失败路径无限收。
std::string drain(qz_t *rt, int per_wait_ms, int budget_ms = 5000) {
    std::string all;
    int64_t deadline = now_ms() + budget_ms;
    for (;;) {
        char *json = nullptr;
        size_t len = 0;
        int wait = (int)(deadline - now_ms());
        if (wait <= 0) break;
        if (wait > per_wait_ms) wait = per_wait_ms;
        if (qz_recv_message(rt, &json, &len, wait) != 0) break;
        all.append(json, len);
        qz_free_message(json);
        if (all.size() > (1u << 20)) break;   // 兜底：别让失败路径无限收
    }
    return all;
}

long count_of(const std::string &s, const char *needle) {
    long n = 0;
    for (size_t at = s.find(needle); at != std::string::npos;
         at = s.find(needle, at + 1))
        n++;
    return n;
}

// 注入的额度必须无条件清掉：ASSERT_* 提前 return 时不会走到后面的清理，
// 残留额度会让后续 case 以误导性的症状失败。作用域是 per-rt，所以多个注入
// 用例可以同进程共存——这正是当初做成进程级全局+env 时做不到的。
//
// **析构必须早于 host_destroy**：guard 持有裸 qz_t*，而 host_destroy 里的
// qz_destroy 最后一步是 free(rt)。guard 若声明在函数体上层，析构就在 free
// 之后跑，析构里那次 qz_test_mailbox_fault(rt, 0) 就是一次写已释放内存
// （ASAN: heap-use-after-free @ qz_test_mailbox_fault ← ~FaultGuard）。
// 所以下面每个用例都把 guard 放进一个内层 {}，让它一定先于 host_destroy 死。
// 别为了「少一层大括号」把它提上去——那正是这个 bug 的原形。
struct FaultGuard {
    FaultGuard(qz_t *rt, int n) : rt_(rt) { qz_test_mailbox_fault(rt_, n); }
    ~FaultGuard() { qz_test_mailbox_fault(rt_, 0); }
    qz_t *rt_;
};

}  // namespace

// 1. 注入 1 次 → 那一条 postMessage 的出站帧丢失，但邮箱里必须出现标记帧；
//    随后消息照常抵达（不是「一失败就永久坏」）。
TEST(mailbox_oom, dropped_message_is_marked_not_silent) {
    HostCtx *h = host_create_echo();
    ASSERT_NE(nullptr, h);
    {
        FaultGuard g(h->rt, 1);

        // 这条回声帧的 qz_out_push 会被注入打掉。
        ASSERT_EQ(0, qz_post_message(h->rt, "{\"n\":1}", 7));
        std::string seen = drain(h->rt, 200);

        EXPECT_NE(std::string::npos, seen.find("mailbox-alloc-failed"))
            << "OOM 未在流上留标记（宿主会看到一个无标记的洞）: " << seen;
        EXPECT_NE(std::string::npos, seen.find("\"type\":\"error\"")) << seen;
        // 被丢的是回声帧本身——标记帧不冒充它。
        EXPECT_EQ(std::string::npos, seen.find("{\"n\":1}")) << seen;

        ASSERT_EQ(0, qz_post_message(h->rt, "{\"n\":2}", 7));
        std::string after = drain(h->rt, 200);
        EXPECT_NE(std::string::npos, after.find("{\"n\":2}"))
            << "注入耗尽后消息仍应正常投递: " << after;
    }   // ← guard 必须在此死掉，早于下面的 host_destroy（见 FaultGuard 注释）
    host_destroy(h);
}

// 2. 注入**恰好 N 次**。修前「哨兵与额度共用一个变量」时这里是无限丢消息，
//    现在必须正好 N 条标记、之后全正常。
TEST(mailbox_oom, injects_exactly_n_times) {
    const int kN = 3;
    HostCtx *h = host_create_echo();
    ASSERT_NE(nullptr, h);
    {
        FaultGuard g(h->rt, kN);

        // 多打几条：注入额度是 3，无论如何都不该有第 4 条标记。
        for (int i = 1; i <= 8; i++) {
            char m[32];
            int n = snprintf(m, sizeof m, "{\"n\":%d}", i);
            ASSERT_EQ(0, qz_post_message(h->rt, m, (size_t)n));
        }
        std::string seen = drain(h->rt, 200);

        EXPECT_EQ(kN, count_of(seen, "mailbox-alloc-failed"))
            << "注入 3 次应正好留下 3 条标记（多于 3 = 额度复位成无限丢消息，"
               "少于 3 = 额度被别的路径提前消耗）: " << seen;
        // 额度用尽后其余 5 条必须正常抵达。
        EXPECT_NE(std::string::npos, seen.find("{\"n\":8}"))
            << "注入耗尽后消息应恢复投递: " << seen;
    }   // ← guard 先于 host_destroy 死（见 FaultGuard 注释）
    host_destroy(h);
}

// 4. **文档承诺的消费契约**——这一条验的是 docs/{,zh/}c-api/runtime.md「邮箱」节里
//    那段消费循环的**行为**，而不只是它能编译（文档门只保证能编）。
//
//    文档承诺了三件事，缺一不可：
//      a) 库的错误帧（`{"type":"error"}`）必须被**识别并跳过**，不能当自己的协议；
//      b) 遇到它**不能 break**——后面可能还有正常消息；
//      c) `qz_recv_message` 的三态要分开判（0 取到 / 1 超时 / -1 错误），
//         把 -1 当「没消息了」就是安静地少处理消息。
//    这三条此前没有任何测试执行过，而它们正是宿主会照抄的东西。
TEST(mailbox_oom, documented_consumption_loop_holds) {
    HostCtx *h = host_create_echo();
    ASSERT_NE(nullptr, h);
    {
        // 注入 1 次：第一条回声帧被换成标记帧。
        FaultGuard g(h->rt, 1);
        for (int i = 1; i <= 3; i++) {
            char m[32];
            int n = snprintf(m, sizeof m, "{\"n\":%d}", i);
            ASSERT_EQ(0, qz_post_message(h->rt, m, (size_t)n));
        }

        // 下面是文档给宿主的那段消费循环，形状逐条对应文档里的三件事 (a)(b)(c)。
        std::vector<std::string> normal;
        int errors = 0;
        int64_t deadline = now_ms() + 3000;
        for (;;) {
            char *json = nullptr;
            size_t len = 0;
            int rr = qz_recv_message(h->rt, &json, &len, (int)(deadline - now_ms()) > 0
                                                      ? (int)(deadline - now_ms()) : 1);
            if (rr < 0) {                    // (c) 错误：不是「没消息」
                free(json);
                FAIL() << "文档循环把 -1（错误）当成了「没消息」——这正是要防的";
            }
            if (rr == 1) break;              // 超时：正常退出条件
            std::string f(json, len);
            qz_free_message(json);
            if (f.find("\"type\":\"error\"") != std::string::npos) {
                errors++;                    // (a)(b) 识别并跳过，**不 break**
                continue;
            }
            normal.push_back(f);
            if (now_ms() >= deadline) break;
        }

        EXPECT_EQ(1, errors) << "应恰好看到 1 帧库的错误帧: " << normal.size();
        // (b) 的实质：标记帧**之后**的正常消息必须照样到达，且顺序不乱。
        ASSERT_GE(normal.size(), 2u)
            << "标记帧之后的消息必须继续到达（文档承诺不要 break）";
        EXPECT_EQ(std::string("{\"n\":2}"), normal[0]) << normal[0];
        EXPECT_EQ(std::string("{\"n\":3}"), normal[1]) << normal[1];
    }   // guard 先于 host_destroy 死
    host_destroy(h);
}

// 3. 无注入时标记帧一条都不该出现（否则标记逻辑误触发，正常流被污染）。
TEST(mailbox_oom, no_marker_without_injection) {
    HostCtx *h = host_create_echo();
    ASSERT_NE(nullptr, h);
    ASSERT_EQ(0, qz_post_message(h->rt, "{\"n\":7}", 7));
    std::string seen = drain(h->rt, 200);
    EXPECT_NE(std::string::npos, seen.find("{\"n\":7}")) << seen;
    EXPECT_EQ(std::string::npos, seen.find("mailbox-alloc-failed")) << seen;
    host_destroy(h);
}
