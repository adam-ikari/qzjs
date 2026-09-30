// test_host_messaging_gtest.cpp — host-messaging 模块直接测试（P2-10）
//
// 审计缺口：polyfill/src/host-messaging.js（postMessage / __qz_dispatch__ /
// onmessage 三件套）此前零直接测试——只被 worker/bootstrap 间接受测。
//
// 覆盖契约（对宿主可观察的行为，非实现细节）：
//   1. JS → host 出站：postMessage(data) 经 JSON 序列化抵达 message_cb
//      （对象/数组/字符串/数字/null 原样；undefined 退化为裸文本 "undefined"）
//   2. 出站错误路径：不可序列化（BigInt / 循环引用）同步抛 TypeError，
//      且宿主不收到任何信封
//   3. host → JS 入站：bridge 派发的 __qz_dispatch__(data, 0) 变成
//      MessageEvent 'message'（addEventListener 可收，data 原样）
//   4. onmessage 属性语义：setter 替换旧 handler / null 注销 / 与
//      addEventListener 并存不双触发
//   5. handler 抛异常 → reportError → 全局 error 事件；dispatch 本身不中断，
//      后续消息照常投递
//   6. 宿主发坏 JSON → 规范 §5 错误信封 {"type":"error","error":"bad-json"}
//      回到 message_cb（bridge 契约，host-messaging 是其 JS 侧入口）
//
// 基建：与 test_qz_gtest 同款 host_create/host_eval/host_wait_msg
// （mock_libuv，无网络，ctest -L offline）。
#include "test_host.h"
#include <cstring>
#include <string>

namespace {

class HostMessagingTest : public ::testing::Test {
protected:
    HostCtx *h = nullptr;

    void SetUp() override {
        h = host_create();
        ASSERT_NE(nullptr, h);
    }
    void TearDown() override { host_destroy(h); }
};

} /* namespace */

// ================================================================
// 1-2. JS → host 出站：postMessage 序列化契约 + 错误路径
// ================================================================

TEST_F(HostMessagingTest, PostMessageSerializesToHostCb) {
    std::string out;
    /* host_eval 返回的第一条非 eval 消息 = eval 体内同步发出的出站信封，
     * 因此 "postMessage(X)" 的求值直接捕获 X 的序列化结果。 */
    ASSERT_TRUE(host_eval(h, "postMessage({a:1,b:[true,null,'x']})", &out));
    EXPECT_EQ(out, R"({"a":1,"b":[true,null,"x"]})") << out;

    ASSERT_TRUE(host_eval(h, "postMessage(42)", &out));
    EXPECT_EQ(out, "42") << out;

    ASSERT_TRUE(host_eval(h, "postMessage('str')", &out));
    EXPECT_EQ(out, R"("str")") << out;

    ASSERT_TRUE(host_eval(h, "postMessage(null)", &out));
    EXPECT_EQ(out, "null") << out;

    /* 防的 bug：postMessage 不存在/未接线（host-messaging 未 setup）时
     * eval 会抛 "postMessage is not defined"，host_eval 返回 false —— 上面的
     * ASSERT 已挡住。这里再钉序列化路径：bridge 用 JS_JSONStringify，
     * 键序/格式变化即失败。 */
}

TEST_F(HostMessagingTest, PostMessageUndefinedSendsBareText) {
    /* JSON.stringify(undefined) === undefined → ToCString 强转裸文本
     * "undefined"（非 JSON）。宿主契约：能区分"没消息"和"发了 undefined"。 */
    std::string out;
    ASSERT_TRUE(host_eval(h, "postMessage(undefined)", &out));
    EXPECT_EQ(out, "undefined") << out;
}

TEST_F(HostMessagingTest, PostMessageNonSerializableThrowsNothingSent) {
    std::string v;
    /* BigInt：JSON.stringify 禁止 → TypeError 同步抛回调用方 */
    ASSERT_TRUE(host_value(h,
        "var r = 'ok';\n"
        "try { postMessage(1n); } catch (e) { r = 'threw:' + e; }\n"
        "r", &v));
    EXPECT_NE(std::string::npos, v.find("threw:TypeError")) << "got: " << v;

    /* 循环引用：同样抛 TypeError */
    ASSERT_TRUE(host_value(h,
        "var o = {}; o.self = o;\n"
        "var r = 'ok';\n"
        "try { postMessage(o); } catch (e) { r = 'threw:' + e; }\n"
        "r", &v));
    EXPECT_NE(std::string::npos, v.find("threw:TypeError")) << "got: " << v;

    /* 防的 bug：序列化失败被吞掉 → 宿主永远等不到消息还不报错。
     * 抛出后 message_cb 不得收到任何东西（eval 通道之外 inbox 应为空）。
     * 用 echo 命令探测：若错误信封被发送，它会排在 echo 回显之前。 */
    const char *echo = "{\"cmd\":\"echo\",\"data\":\"probe\"}";
    ASSERT_EQ(0, qz_post_message(h->rt, echo, strlen(echo)));
    std::string out;
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_EQ(out, R"("probe")") << "serialization failure leaked a message: " << out;
}

// ================================================================
// 3. host → JS 入站：__qz_dispatch__ → MessageEvent
// ================================================================

TEST_F(HostMessagingTest, DispatchDeliversMessageEventToListener) {
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var _got = [];\n"
        "addEventListener('message', function(ev){ _got.push(ev.data); });\n"
        "__qz_dispatch__({k: [1, 2]}, 0);\n"
        "JSON.stringify(_got)", &v));
    /* 入站 JSON（bridge 解析后派发）原样成为 MessageEvent.data。
     * 防的 bug：__qz_dispatch__ 未定义（模块未 setup）→ 宿主消息全部丢失
     * 只报 bad-json；或 data 传引用未克隆被后续覆盖。 */
    EXPECT_NE(std::string::npos, v.find(R"([{"k":[1,2]}])")) << "got: " << v;

    /* 二次派发独立到达（事件不复用/覆盖） */
    ASSERT_TRUE(host_value(h,
        "__qz_dispatch__('second', 0);\n"
        "JSON.stringify(_got)", &v));
    EXPECT_NE(std::string::npos, v.find(R"([{"k":[1,2]},"second"])")) << "got: " << v;
}

TEST_F(HostMessagingTest, HostInboundJsonRoundTrip) {
    /* 全链路：qz_post_message（宿主线程）→ msgq → bridge JSON 解析 →
     * __qz_dispatch__ → listener。监听器也会收到 eval 命令，故按首条
     * 非 eval 消息断言。 */
    std::string v;
    ASSERT_TRUE(host_value(h,
        "globalThis._inbound = null;\n"
        "addEventListener('message', function(ev){ if (_inbound === null) _inbound = ev.data; });\n"
        "'ok'", &v));
    const char *json = "{\"ping\":{\"n\":3}}";
    ASSERT_EQ(0, qz_post_message(h->rt, json, strlen(json)));
    /* poll：每次 eval 驱动一轮 loop，消息在 wake_cb 派发后 _inbound 非 null。
     * 注意 eval 命令本身也会触发 listener，_inbound 首条可能抢到 eval 命令
     * 或宿主消息——但宿主消息先入队，先派发。 */
    ASSERT_TRUE(host_poll_until_value(h,
        "JSON.stringify(_inbound)", "\"ping\"", &v, 3000)) << "got: " << v;
}

// ================================================================
// 4. onmessage 属性语义（EventTarget 接线）
// ================================================================

TEST_F(HostMessagingTest, OnmessageSetterReplacesAndNulls) {
    std::string v;
    ASSERT_TRUE(host_value(h,
        "globalThis.__seq = [];\n"
        "onmessage = function(e){ __seq.push('A' + JSON.stringify(e.data)); };\n"
        "__qz_dispatch__({n:1}, 0);\n"
        "onmessage = function(e){ __seq.push('B' + JSON.stringify(e.data)); };\n"
        "__qz_dispatch__({n:2}, 0);\n"
        "onmessage = null;\n"
        "__qz_dispatch__({n:3}, 0);\n"
        "JSON.stringify(__seq)", &v));
    /* setter 替换旧 handler（A 只收到 n:1，B 收 n:2）；null 注销（n:3 无人收）。
     * 防的 bug：setter 叠加注册 → 同一消息触发多次；null 不注销 → 关不掉。 */
    EXPECT_NE(std::string::npos,
              v.find(R"(["A{\"n\":1}","B{\"n\":2}"])")) << "got: " << v;
}

TEST_F(HostMessagingTest, OnmessageCoexistsWithAddEventListener) {
    std::string v;
    ASSERT_TRUE(host_value(h,
        "globalThis.__seq = [];\n"
        "addEventListener('message', function(e){ __seq.push('L'); });\n"
        "onmessage = function(e){ __seq.push('H'); };\n"
        "__qz_dispatch__('x', 0);\n"
        "onmessage = null;\n"
        "__qz_dispatch__('y', 0);\n"
        "JSON.stringify(__seq)", &v));
    /* onmessage 与 listener 并存各触发一次；null 后仅剩 listener。
     * 防的 bug：onmessage 挤掉 listener 或双双不触发。 */
    EXPECT_NE(std::string::npos, v.find(R"(["L","H","L"])")) << "got: " << v;
}

// ================================================================
// 5. handler 异常 → reportError，dispatch 不中断
// ================================================================

TEST_F(HostMessagingTest, HandlerErrorReportedNotFatal) {
    std::string v;
    ASSERT_TRUE(host_value(h,
        "globalThis.__errs = []; globalThis.__after = 'no';\n"
        "addEventListener('error', function(e){ __errs.push(e.message); });\n"
        "onmessage = function(){ throw new Error('handler-boom'); };\n"
        "__qz_dispatch__('x', 0);\n"
        "onmessage = null;\n"
        "__qz_dispatch__('y', 0);\n"
        "__after = 'yes';\n"
        "JSON.stringify([__errs, __after])", &v));
    /* 异常进全局 error 事件（reportError 路径），后续派发照常。
     * 防的 bug：handler 异常沿 dispatch 冒泡炸掉 bridge 的派发循环。 */
    EXPECT_NE(std::string::npos, v.find(R"([["handler-boom"],"yes"])")) << "got: " << v;
}

// ================================================================
// 6. 宿主发坏 JSON → 规范 §5 错误信封
// ================================================================

TEST_F(HostMessagingTest, BadJsonHostMessageYieldsErrorEnvelope) {
    ASSERT_EQ(0, qz_post_message(h->rt, "{not json", 9));
    std::string out;
    ASSERT_TRUE(host_wait_msg(h, &out));
    /* 防的 bug：坏 JSON 静默丢弃（宿主无从得知）或把残片喂给 dispatch。 */
    EXPECT_EQ(out, R"({"type":"error","error":"bad-json"})") << out;
}
