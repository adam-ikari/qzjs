// test_qz_gtest.cpp — 宿主契约核心套件（执行模型 A）
// 通过新 public API（qz_create / qz_post_message / qz_destroy）驱动
// 真实 qzjs 线程 + mock_libuv loop，消息经 message_cb 回传。
#include "test_host.h"
#include <thread>
#include <vector>
#include <set>
#include <cstdlib>

TEST(qz_create, creates_ready_runtime) {
    HostCtx *h = host_create();       // 无脚本：只验证 create 不阻塞不失败
    ASSERT_NE(nullptr, h);
    host_destroy(h);
}

TEST(qz_create, null_config_rejected) {
    EXPECT_EQ(nullptr, qz_create(nullptr));
}

TEST(qz_create, initial_script_exception_fails_create) {
    qz_config_t cfg; qz_config_init(&cfg); cfg.initial_script = "throw new Error('boom');";
    EXPECT_EQ(nullptr, qz_create(&cfg));   // eval 异常 → ready_err → NULL
}

TEST(qz_post_message, host_message_roundtrip) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    const char *json = "{\"cmd\":\"echo\",\"data\":{\"a\":1}}";
    ASSERT_EQ(0, qz_post_message(h->rt, json, strlen(json)));
    std::string out;
    ASSERT_TRUE(host_wait_msg(h, &out));
    ASSERT_EQ("{\"a\":1}", out);              // echo 原样回
    host_destroy(h);
}

TEST(qz_post_message, eval_via_command_channel) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    std::string out;
    ASSERT_TRUE(host_eval(h, "1 + 2", &out));
    ASSERT_NE(std::string::npos, out.find("\"v\":\"3\""));
    host_destroy(h);
}

TEST(host_, wait_thread_exit) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    host_destroy(h);                        // destroy 阻塞直到线程退出（join 完成即证明）
    SUCCEED();
}

TEST(host_, message_thread_safety) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    const int N = 8, PER = 200;                       // 1600 条 echo, data = 0..1599 唯一
    std::vector<std::thread> ts;
    std::atomic<int> push_fail{0};
    for (int i = 0; i < N; i++) ts.emplace_back([h, i, &push_fail]{
        for (int k = 0; k < PER; k++) {
            std::string s = "{\"cmd\":\"echo\",\"data\":" + std::to_string(i*PER+k) + "}";
            if (qz_post_message(h->rt, s.data(), s.size()) != 0) push_fail++;
        }
    });
    /* 收集所有 echo 回复。多槽 inbox 保证每条都消费；内容校验 = 每个 0..1599
     * 恰好出现一次（无重复、无缺失、无覆盖），这才是"无丢消息"的严格判据。 */
    std::set<int> got;
    std::string out;
    auto t0 = std::chrono::steady_clock::now();
    while ((int)got.size() < N * PER) {
        if (host_wait_msg(h, &out, 2000)) got.insert(std::atoi(out.c_str()));
        else if (std::chrono::steady_clock::now() - t0 > std::chrono::seconds(20)) break;
    }
    for (auto &t : ts) t.join();
    ASSERT_EQ(0, push_fail.load());                   // 所有消息都 push 成功

    /* 排空迟到消息后验证命令通道仍健康（probe 内容必须确实是 40+2 的结果）。 */
    while (host_wait_msg(h, &out, 200)) got.insert(std::atoi(out.c_str()));
    std::string probe;
    ASSERT_TRUE(host_eval(h, "40 + 2", &probe, 2000));
    ASSERT_NE(std::string::npos, probe.find("\"v\":\"42\""));
    host_destroy(h);

    ASSERT_EQ(N * PER, (int)got.size());              // 1600 条全到，无重复
    for (int i = 0; i < N * PER; i++) ASSERT_TRUE(got.count(i)) << "missing echo " << i;
}

TEST(pal_fs, read_sync_rejects_traversal) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    std::string out;

    /* ".." 组件必须在 fopen 前被拒绝（同步读与异步 fs op 走同一守卫） */
    ASSERT_TRUE(host_value(h,
        "(() => { try { __native__.fsReadSync('../etc/passwd'); return 'NO_THROW'; }"
        " catch (e) { return e.message; } })()", &out));
    ASSERT_EQ("Path traversal detected", out);

    /* 普通相对路径不触发守卫（文件不存在时是 open 错误，不是 traversal） */
    ASSERT_TRUE(host_value(h,
        "(() => { try { __native__.fsReadSync('no_such_file_xyz'); return 'NO_THROW'; }"
        " catch (e) { return e.message; } })()", &out));
    ASSERT_NE("Path traversal detected", out);
    host_destroy(h);
}

/* 验证 wait_idle 的 API 存在且与 destroy 共存安全：请求 idle 退出后，线程
 * 在 loop 空时自动 teardown，destroy 侧 join 立即返回（shutting_down 已置位），
 * 无死锁/无双重释放。异步退出语义的端到端断言由 CLI 级 fork 测试覆盖。 */
TEST(qz_wait_idle, api_available_and_teardown_safe) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    qz_wait_idle(h->rt);          /* 请求 idle 退出 */
    host_destroy(h);                /* destroy 与 wait_idle 共存：join 安全 */
    SUCCEED();
}

/* F4 security audit:qz_msg_push 的分配大小 (sizeof + len + 1) 必须拒绝
 * 溢出——len 理论可达 SIZE_MAX,若被接受会 malloc 小块后 memcpy 越界写。 */
TEST(qz_msg_push, rejects_alloc_overflow) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    EXPECT_EQ(-1, qz_msg_push(h->rt, "x", (size_t)-1, 0, 0));
    EXPECT_EQ(-1, qz_msg_push(h->rt, "x", (size_t)-2, 0, 0));
    /* 正常小消息仍入队成功 */
    EXPECT_EQ(0, qz_msg_push(h->rt, "ok", 2, 0, 0));
    host_destroy(h);
}
