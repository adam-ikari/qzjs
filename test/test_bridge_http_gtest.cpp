// test_bridge_http_gtest.cpp — JS 桥接 HTTP（执行模型 A / mock_libuv）
// 用 host_eval 契约（test_host.h）+ mock_tcp_respond 预注册 canned HTTP
// 响应。非流式 __native__.httpRequest 走 Content-Length 完成路径；流式
// httpRequestStream 在 EOF 触发 on_end。
#include "test_host.h"
#include <cstring>

class BridgeHttpTest : public ::testing::Test {
protected:
    HostCtx *h = nullptr;

    void SetUp() override {
        h = host_create();
        ASSERT_NE(nullptr, h);
    }
    void TearDown() override { host_destroy(h); }
};

TEST_F(BridgeHttpTest, NonStreamingHttpRequest) {
    /* 响应：Content-Length 必须与 body 字节数精确匹配（10）。 */
    const char *resp =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: 10\r\n"
        "\r\n"
        "test_value";
    ASSERT_EQ(0, mock_tcp_respond(&h->rt->loop, resp, strlen(resp)));

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var _result = null;\n"
        "__native__.httpRequest('http://api.example.com/data', 'GET', '{}', null)\n"
        "  .then(function(d){ _result = d; })\n"
        "  .catch(function(e){ _result = 'error:' + e; });\n"
        "0", &out));

    /* resolve 载荷是 raw string：{"status":200,"headers":{...},"body":"..."} */
    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "_result", "\"status\":200", &v));
    EXPECT_NE(std::string::npos, v.find("\"body\":\"test_value\""));
    EXPECT_NE(std::string::npos, v.find("Content-Type"));
}

TEST_F(BridgeHttpTest, StreamingHttpRequestStream) {
    const char *resp =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: 16\r\n"
        "\r\n"
        "stream chunk one";
    ASSERT_EQ(0, mock_tcp_respond(&h->rt->loop, resp, strlen(resp)));

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var _result = null; var _headerStatus = -1; var _dataBytes = 0;\n"
        "__native__.httpRequestStream(\n"
        "  'http://api.example.com/data', 'GET', '{}', null,\n"
        "  function(status, hdrs){ _headerStatus = status; },\n"
        "  function(chunk){ _dataBytes += (chunk instanceof ArrayBuffer) ? chunk.byteLength : chunk.length; },\n"
        "  function(errStatus){ _result = (errStatus === 0) ? 'ok' : 'err:' + errStatus; }\n"
        ");\n"
        "0", &out));

    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "_result", "ok", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_headerStatus", "200", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_dataBytes", "16", &v));
}

TEST_F(BridgeHttpTest, HttpsFetchRejectsUntrustedPeer) {
    /* 用垃圾字节冒充 TLS ServerHello:握手必须失败、fetch 必须 reject。
     * 证明 https 客户端绝不静默接受任意证书/明文(修复前 CA 缺失时降级到
     * VERIFY_OPTIONAL 且无 verify_result 检查)。无 TLS 构建下该路径直接
     * 报 "TLS not supported",同样 reject —— 两种构建行为一致。 */
    const char *garbage = "\x16\x03\x01\x00\x00not-a-real-tls-server-hello";
    ASSERT_EQ(0, mock_tcp_respond(&h->rt->loop, garbage, strlen(garbage)));
    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis._fetchErr='pending';"
        "fetch('https://localhost/').then(function(r){_fetchErr='resolved';},"
        "function(e){_fetchErr='rejected';});'started'", &out));
    ASSERT_TRUE(host_poll_until_value(h, "_fetchErr", "rejected", &out));
}

/* issue #4: mock_tcp_written returns a NUL-terminated C string, but a TLS
 * ClientHello contains embedded 0x00 bytes (the handshake length is
 * big-endian, so the high byte is 0). strlen() therefore truncated the
 * capture at byte 6 (16 03 03 01 cc 01), making protocol-level byte
 * assertions impossible. mock_tcp_written_len returns the true byte count. */
TEST_F(BridgeHttpTest, TlsClientHelloFullyCaptured) {
    const char *garbage = "\x16\x03\x03\x00\x04not-a-real-server-hello";
    ASSERT_EQ(0, mock_tcp_respond(&h->rt->loop, garbage, strlen(garbage)));
    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis._r='pending';"
        "fetch('https://localhost/').then(function(r){_r='resolved';},"
        "function(e){_r='rejected';});'started'", &out));
    ASSERT_TRUE(host_poll_until_value(h, "_r", "rejected", &out));
    size_t wl = mock_tcp_written_len(&h->rt->loop);
    const char *w = mock_tcp_written(&h->rt->loop);
    /* No-TLS builds reject immediately without sending anything; only
     * assert the ClientHello shape when bytes were actually written. */
    if (wl > 0) {
        EXPECT_GE(wl, 40u) << "ClientHello captured only " << wl << " bytes";
        ASSERT_GE(wl, 6u);
        EXPECT_EQ((unsigned char)w[0], 0x16);  /* TLS handshake record */
        EXPECT_EQ((unsigned char)w[5], 0x01);  /* handshake type = ClientHello */
    }
}

/* ---- uv_io_parse_url 回归：userinfo 剥离 / 端口 / fragment / Host 头 ----
 * 断言写上线上的字节（mock uv_write 捕获），而非解析器内部状态。 */

static const char *kUrlResp =
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";

TEST_F(BridgeHttpTest, UrlUserInfoExplicitPortFragmentOnWire) {
    ASSERT_EQ(0, mock_tcp_respond(&h->rt->loop, kUrlResp, strlen(kUrlResp)));
    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var _result = null;\n"
        "__native__.httpRequest("
        "'http://user:pass@api.example.com:8080/data/x?q=1#frag', "
        "'GET', '{}', null)\n"
        "  .then(function(d){ _result = d; })\n"
        "  .catch(function(e){ _result = 'error:' + e; });\n"
        "0", &out));

    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "_result", "ok", &v));
    const char *w = mock_tcp_written(&h->rt->loop);
    /* userinfo 不上线；fragment 不上线；query 保留；Host 带显式端口 */
    EXPECT_NE(std::string::npos,
              std::string(w).find("GET /data/x?q=1 HTTP/1.1\r\n"));
    EXPECT_NE(std::string::npos,
              std::string(w).find("Host: api.example.com:8080\r\n"));
    EXPECT_EQ(std::string::npos, std::string(w).find("user:pass"));
    EXPECT_EQ(std::string::npos, std::string(w).find("#frag"));
}

TEST_F(BridgeHttpTest, UrlIpv6LiteralAuthorityOnWire) {
    ASSERT_EQ(0, mock_tcp_respond(&h->rt->loop, kUrlResp, strlen(kUrlResp)));
    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var _result6 = null;\n"
        "__native__.httpRequest('http://[2001:db8::1]:8443/x', 'GET', '{}', null)\n"
        "  .then(function(d){ _result6 = d; })\n"
        "  .catch(function(e){ _result6 = 'error:' + e; });\n"
        "0", &out));
    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "_result6", "ok", &v));
    std::string w(mock_tcp_written(&h->rt->loop));
    EXPECT_NE(std::string::npos, w.find("GET /x HTTP/1.1\r\n"));
    EXPECT_NE(std::string::npos, w.find("Host: [2001:db8::1]:8443\r\n"));
}

TEST_F(BridgeHttpTest, UrlDefaultPortOmittedInHostHeader) {
    ASSERT_EQ(0, mock_tcp_respond(&h->rt->loop, kUrlResp, strlen(kUrlResp)));
    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var _result = null;\n"
        "__native__.httpRequest('http://api.example.com:80/a', 'GET', '{}', null)\n"
        "  .then(function(d){ _result = d; })\n"
        "  .catch(function(e){ _result = 'error:' + e; });\n"
        "0", &out));

    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "_result", "ok", &v));
    std::string w(mock_tcp_written(&h->rt->loop));
    EXPECT_NE(std::string::npos, w.find("Host: api.example.com\r\n"));
    EXPECT_EQ(std::string::npos, w.find("api.example.com:80"));
    EXPECT_NE(std::string::npos, w.find("GET /a HTTP/1.1\r\n"));
}

TEST_F(BridgeHttpTest, UrlParserRejectsMalformedUrls) {
    std::string out;
    /* 注入/越界/空 host/坏括号/非数字端口 → promise 一律 reject */
    const char *urls[] = {
        "http://x:0/",
        "http://x:99999/",
        "http://x:12a/",
        "http:///a",
        "http://user@/a",
        "http://[::1/x",
        "http://a b/",
        "http://x\r\nInjected: 1/",
        "ftp://x/",
    };
    for (size_t i = 0; i < sizeof(urls) / sizeof(urls[0]); i++) {
        std::string code = std::string("var _r = null;__native__.httpRequest(") +
                           JSON_string(urls[i]) +
                           ", 'GET', '{}', null)"
                           ".then(function(d){_r='resolved';},"
                           "function(e){_r='rejected:'+e;});0";
        ASSERT_TRUE(host_eval(h, code.c_str(), &out)) << "url " << urls[i];
        std::string v;
        ASSERT_TRUE(host_poll_until_value(h, "_r", "rejected:", &v))
            << "url " << urls[i];
        EXPECT_NE(std::string::npos, v.find("invalid url")) << "url " << urls[i];
    }
}
