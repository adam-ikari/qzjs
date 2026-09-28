// test_control_gtest.cpp — CTL-0 控制面进程内基线测试
// 验证 qz_control / qz_control_dispatch 的核心契约：
// eval/inspect/metrics 操作、异常处理、OFF 档拒绝、未知 op、超时回收。
#include "test_host.h"
#include <cstring>

// 启用控制面的 host 工厂（control_plane=IN_PROC）。
// 与 host_create 相同，但 cfg.control_plane = QZ_CONTROL_IN_PROC。
static HostCtx *host_create_ctl() {
    auto *h = new HostCtx();
    qz_config_t cfg = {};
    cfg.initial_script = kTestBootstrap;
    cfg.control_plane = QZ_CONTROL_IN_PROC;
    h->rt = qz_create(&cfg);
    if (!h->rt) { delete h; return nullptr; }
    return h;
}

// 1. eval 成功 → ok:true + result
TEST(control_, eval_ok) {
    HostCtx *h = host_create_ctl();
    ASSERT_NE(nullptr, h);
    EXPECT_EQ(0, host_control(h, ctl_eval_json("c1", "1+1")));
    std::string out;
    ASSERT_TRUE(host_wait_ctl(h, "c1", &out)) << out;
    EXPECT_NE(std::string::npos, out.find("\"ok\":true")) << out;
    EXPECT_NE(std::string::npos, out.find("\"result\":2")) << out;
    host_destroy(h);
}

// 2. eval 异常 → ok:false + code:JS_EXCEPTION + error 含异常文本
TEST(control_, eval_exception) {
    HostCtx *h = host_create_ctl();
    ASSERT_NE(nullptr, h);
    EXPECT_EQ(0, host_control(h, ctl_eval_json("c2", "throw new Error('boom')")));
    std::string out;
    ASSERT_TRUE(host_wait_ctl(h, "c2", &out)) << out;
    EXPECT_NE(std::string::npos, out.find("\"ok\":false")) << out;
    EXPECT_NE(std::string::npos, out.find("\"code\":\"JS_EXCEPTION\"")) << out;
    EXPECT_NE(std::string::npos, out.find("boom")) << out;
    host_destroy(h);
}

// 3. inspect 成功 → ok:true + json 字段（JSON 序列化结果）
TEST(control_, inspect_ok) {
    HostCtx *h = host_create_ctl();
    ASSERT_NE(nullptr, h);
    std::string cmd = std::string(R"({"op":"inspect","correl":"c3","expr":)") +
                      JSON_string("({a:1,b:'x'})") + "}";
    EXPECT_EQ(0, host_control(h, cmd));
    std::string out;
    ASSERT_TRUE(host_wait_ctl(h, "c3", &out)) << out;
    EXPECT_NE(std::string::npos, out.find("\"ok\":true")) << out;
    EXPECT_NE(std::string::npos, out.find("\"json\"")) << out;
    host_destroy(h);
}

// 4. metrics 成功 → ok:true + 运行时统计字段
TEST(control_, metrics_ok) {
    HostCtx *h = host_create_ctl();
    ASSERT_NE(nullptr, h);
    EXPECT_EQ(0, host_control(h, R"({"op":"metrics","correl":"c4"})"));
    std::string out;
    ASSERT_TRUE(host_wait_ctl(h, "c4", &out)) << out;
    EXPECT_NE(std::string::npos, out.find("\"ok\":true")) << out;
    EXPECT_NE(std::string::npos, out.find("\"heap_bytes\"")) << out;
    EXPECT_NE(std::string::npos, out.find("\"ctx_count\"")) << out;
    EXPECT_NE(std::string::npos, out.find("\"worker_count\"")) << out;
    host_destroy(h);
}

// 5. OFF 档：qz_control 恒返回 -1（不入队、无回执）
TEST(control_, off_rejected) {
    HostCtx *h = host_create();   // 默认 control_plane=OFF
    ASSERT_NE(nullptr, h);
    EXPECT_EQ(-1, host_control(h, R"({"op":"metrics","correl":"c5"})"));
    host_destroy(h);
}

// 6. 未知 op → ok:false + code:UNKNOWN_CMD
TEST(control_, unknown_op) {
    HostCtx *h = host_create_ctl();
    ASSERT_NE(nullptr, h);
    EXPECT_EQ(0, host_control(h, R"({"op":"bogus","correl":"c6"})"));
    std::string out;
    ASSERT_TRUE(host_wait_ctl(h, "c6", &out)) << out;
    EXPECT_NE(std::string::npos, out.find("\"ok\":false")) << out;
    EXPECT_NE(std::string::npos, out.find("\"code\":\"UNKNOWN_CMD\"")) << out;
    host_destroy(h);
}

// 7. 超时：阻塞 JS 线程使后续控制命令过期 → code:TIMEOUT
// 先发普通 eval（post_message）阻塞 JS 线程 ~50-200ms（不走 host_eval 以免
// 等待响应）；紧接着发控制命令 timeout_ms=1。msgq 是 FIFO，控制命令排在
// 阻塞 eval 之后；eval 执行期间控制命令条目过期，dispatch 时 ctl_claim
// 发现 deadline < now → 作废 + TIMEOUT 回执。
TEST(control_, timeout) {
    HostCtx *h = host_create_ctl();
    ASSERT_NE(nullptr, h);
    int id = ++h->eval_id;
    std::string block = "{\"cmd\":\"eval\",\"id\":" + std::to_string(id) +
                        ",\"code\":" + JSON_string("var i=0;while(i<5000000)i++;1") + "}";
    ASSERT_EQ(0, qz_post_message(h->rt, block.data(), block.size()));
    EXPECT_EQ(0, host_control(h, R"({"op":"metrics","correl":"c7","timeout_ms":1})"));
    std::string out;
    ASSERT_TRUE(host_wait_ctl(h, "c7", &out, 10000)) << out;
    EXPECT_NE(std::string::npos, out.find("\"code\":\"TIMEOUT\"")) << out;
    host_destroy(h);
}
