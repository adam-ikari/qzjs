// test_http_inflight_teardown_gtest.cpp — 非流式 HTTP 在途请求销毁回归
//
// 背景:c1425f9「qz_destroy 在有 in-flight 请求时崩溃」只覆盖了流式一半。
// 非流式路径(uv_io_http_request,即 polyfill fetch 在 streaming 不可用时的
// 回退路径)此前:
//   1. 不把自己注册进 rt->http_ops、不设 rt->active_stream;
//   2. teardown 的守卫是 `if (rt->active_stream)`,故 uv_io_http_abort 根本
//      不会被调用;
//   3. 于是 op->cb(bridge_io_done) 不触发 → qz_free_cb_data 不执行 →
//      alloc_cb_data 持有的 promise resolve/reject 两个 JSValue 泄漏 →
//      JS_FreeRuntime 在非空 gc_obj_list 上断言
//      `list_empty(&rt->gc_obj_list)' failed。
//
// 断言就是「不崩」。配套的 DestroyAfterCompletedRequestBaseline 是必需的:
// 若对照组(请求正常完成后再销毁)也崩,那说明问题在 harness 而非在途路径,
// 本文件就测不到它声称的东西。

#include "test_host.h"
#include "mock_libuv.h"
#include <cstring>
#include <string>

namespace {

/* 发起请求。url_resp 为预注册的 canned 响应;传 nullptr 则请求永远停在
   in-flight(没有任何对端数据)。 */
static void launch_http(HostCtx *h, const char *url) {
    std::string code = std::string("var _r=null;\n"
                                   "__native__.httpRequest('") + url +
                        "','GET','{}',null)\n"
                        "  .then(function(d){_r=d;})"
                        "  .catch(function(e){_r='error';});0";
    std::string out;
    host_eval(h, code.c_str(), &out);
}

}  // namespace

class InflightTeardownTest : public ::testing::Test {
protected:
    HostCtx *h = nullptr;
    void SetUp() override { h = host_create(); ASSERT_NE(nullptr, h); }
    /* 用例自己在需要时提前销毁并置空;否则这里兜底。 */
    void TearDown() override { if (h) { host_destroy(h); h = nullptr; } }
};

TEST_F(InflightTeardownTest, DestroyWithInflightPlainRequestDoesNotCrash) {
    /* 不预注册响应 → 请求停在 in-flight。 */
    launch_http(h, "http://example.test/hang");
    for (int i = 0; i < 30; i++) host_poll_sleep();

    host_destroy(h);
    h = nullptr;
    SUCCEED() << "destroy with in-flight plain request survived";
}

TEST_F(InflightTeardownTest, DestroyWithInflightTlsRequestDoesNotCrash) {
    launch_http(h, "https://example.test/hang");
    for (int i = 0; i < 30; i++) host_poll_sleep();

    host_destroy(h);
    h = nullptr;
    SUCCEED() << "destroy with in-flight TLS request survived";
}

TEST_F(InflightTeardownTest, DestroyAfterCompletedRequestBaseline) {
    const char *resp =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/plain\r\n"
        "Content-Length: 5\r\n"
        "\r\n"
        "hello";
    ASSERT_EQ(0, mock_tcp_respond(&h->rt->loop, resp, strlen(resp)));

    launch_http(h, "http://example.test/done");
    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "_r", "\"status\":200", &v))
        << "baseline: 请求未正常完成,后续断言无意义";

    host_destroy(h);
    h = nullptr;
    SUCCEED() << "baseline: destroy after completed request survived";
}