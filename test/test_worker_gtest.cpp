// test_worker_gtest.cpp — Task 4: 真线程 Web Worker
#include "test_host.h"

// worker 回显往返：父 → worker 'hello' → worker 回显 → 父 onmessage → 宿主。
// 事件顺序确定：eval ack 先到（父线程派发 eval 命令时 postMessage），worker
// 回显随后（worker 线程异步处理 + 父线程下一次 wake 派发），两者都经父线程
// 顺序写入宿主 inbox。
TEST(worker_, message_roundtrip) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_echo.js');\n"
        "w.onmessage = function(e){ postMessage({v: e.data}); };\n"
        "w.postMessage('hello');\n"
        "'started'", &out));

    ASSERT_TRUE(host_wait_msg(h, &out));   /* 等 worker 回显 */
    EXPECT_NE(std::string::npos, out.find("hello")) << "got: " << out;
    host_destroy(h);
}

// terminate：worker 退出后父 runtime 仍能正常 eval（worker 线程在父 teardown
// 时 join）。
TEST(worker_, terminate) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_idle.js');"
        "w.terminate(); 'ok'", &out));
    EXPECT_NE(std::string::npos, out.find("ok")) << "got: " << out;

    ASSERT_TRUE(host_value(h, "2 + 3", &out));
    EXPECT_NE(std::string::npos, out.find("5")) << "got: " << out;
    host_destroy(h);
}

// 回归：terminate 后槽位必须在 worker 线程真正结束后回收。槽位 id = 槽位索引
// +1，不回收则宿主反复 spawn/terminate 会累积到 QZ_MAX_WORKERS(16)，第 17 次
// spawn 抛 "spawnWorker failed (err -8)"(BUSY)。20 轮全在一个 eval 里完成：
// 轮次之间父 loop 没有派发机会，槽位只能靠下一次 spawn 时回收复用。
TEST(worker_, terminate_recycles_slot) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var n = 0;\n"
        "for (var i = 0; i < 20; i++) {\n"
        "  var w = new Worker('file://" TEST_DIR "/worker_idle.js');\n"
        "  w.terminate();\n"
        "  n++;\n"
        "}\n"
        "n", &out, 30000));
    /* 第 17 次 spawn 失败 → new Worker 抛错 → 回执是 {"ok":false,...}(无 v) */
    EXPECT_NE(std::string::npos, out.find("\"v\":\"20\""))
        << "20 轮 spawn/terminate 未全部成功（槽位未回收）: " << out;
    host_destroy(h);
}

// Task 1: 脚本顶层异常 → 父侧 w.onerror 收到 {type:'error', error:<msg>}
// （事件 data），且 worker 继续存活（之后父→worker 往返仍通）。
TEST(worker_, error_notifies_parent) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_throw.js');\n"
        "w.onmessage = function(e){ postMessage({v: e.data}); };\n"
        "w.onerror = function(e){ postMessage({err: e.data}); };\n"
        "'started'", &out));

    ASSERT_TRUE(host_wait_msg(h, &out));   /* w.onerror → {err: e.data} */
    /* 断言 "err" 键：若路由损坏、错误消息落到 w.onmessage，载荷为 {v: {...}}
     * （键 "v" 而非 "err"），仅断言 "error"/"boom" 无法区分两条路径。 */
    EXPECT_NE(std::string::npos, out.find("\"err\"")) << "got: " << out;
    EXPECT_EQ(std::string::npos, out.find("\"v\"")) << "got: " << out;
    EXPECT_NE(std::string::npos, out.find("boom")) << "got: " << out;

    /* worker 存活：父 → worker 往返仍通 */
    ASSERT_TRUE(host_eval(h, "w.postMessage('ping'); 'ok'", &out));
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("ping")) << "got: " << out;
    host_destroy(h);
}

// Task 1: 脚本顶层异常 → worker 侧 self.onerror 收到 ErrorEvent（其 message
// 含异常文本），并可通过 postMessage 回报父。
TEST(worker_, error_fires_self_onerror) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_self_error.js');\n"
        "w.onmessage = function(e){ postMessage({v: e.data}); };\n"
        "'started'", &out));

    /* worker 的 self.onerror → postMessage({workerErr: e.message}) → 父 onmessage */
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("workerErr")) << "got: " << out;
    EXPECT_NE(std::string::npos, out.find("boom")) << "got: " << out;
    host_destroy(h);
}

// Task 2: importScripts 同步加载 file:// 附加脚本（worker 侧通过 onmessage
// 接收路径，同步调用 importScripts，再回传 EXTRA 全局）。
TEST(worker_, import_scripts) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_import.js');\n"
        "w.onmessage = function(e){ postMessage({v: e.data}); };\n"
        "w.postMessage('file://" TEST_DIR "/worker_extra.js');\n"
        "'started'", &out));
    ASSERT_TRUE(host_wait_msg(h, &out));   /* worker 回传 EXTRA */
    EXPECT_NE(std::string::npos, out.find("42")) << "got: " << out;
    host_destroy(h);
}

// transferable：父 → worker 传 ArrayBuffer + transfer 列表，worker 回显内容，
// 父侧原 buffer 被 detach（byteLength → 0）。
TEST(worker_, transfer_arraybuffer_parent_to_worker) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var ab = new ArrayBuffer(4);\n"
        "new Uint8Array(ab).set([10, 20, 30, 40]);\n"
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_echo.js');\n"
        "w.onmessage = function(e){ postMessage({v: Array.prototype.join.call(new Uint8Array(e.data), ','), src: ab.byteLength}); };\n"
        "w.postMessage(ab, [ab]);\n"
        "'started'", &out));

    ASSERT_TRUE(host_wait_msg(h, &out));   /* worker 回显内容 */
    EXPECT_NE(std::string::npos, out.find("\"v\":\"10,20,30,40\"")) << "got: " << out;
    EXPECT_NE(std::string::npos, out.find("\"src\":0")) << "got: " << out;   /* 父侧原 buffer detached */
    host_destroy(h);
}

// transferable：worker → 父 传 ArrayBuffer + transfer 列表，父侧收到内容，
// worker 侧原 buffer 被 detach（byteLength → 0）。
TEST(worker_, transfer_arraybuffer_worker_to_parent) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_transfer.js');\n"
        "w.onmessage = function(e){ var d = e.data; if (d.buf !== undefined) { postMessage({bufc: Array.prototype.join.call(new Uint8Array(d.buf), ',')}); } else { postMessage({after: d.after, c: d.contents}); } };\n"
        "w.postMessage('go');\n"
        "'started'", &out));

    /* 第一条：父侧收到转移的 ArrayBuffer，内容完整 */
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("\"bufc\":\"7,8,9,10\"")) << "got: " << out;
    /* 第二条：worker 侧 detached 后的 byteLength === 0，且内容一致 */
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("\"after\":0")) << "got: " << out;
    EXPECT_NE(std::string::npos, out.find("\"c\":\"7,8,9,10\"")) << "got: " << out;
    host_destroy(h);
}

// transferable: 父 → worker 转移一个 MessagePort（w.postMessage(..., [port1])），
// worker 侧 event.ports[0] 收到该端口，发 'ready' 经端口回传；父侧 port2.onmessage 收到。
// 之后父侧 port2 → worker 侧 port1 双向 echo。
TEST(worker_, transfer_messageport) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var ch = new MessageChannel();\n"
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_port.js');\n"
        "ch.port2.onmessage = function(e){ postMessage({port: e.data}); };\n"
        "w.postMessage('init', [ch.port1]);\n"
        "'started'", &out));

    /* worker 经转移的端口回传 'ready' → 父侧 port2.onmessage → 宿主 */
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("\"port\":\"ready\"")) << "got: " << out;
    host_destroy(h);
}

// transferable: 转移后双向通信——父侧 port2 → worker 侧 port1（worker_port.js
// echo 回 'echo:<msg>'）；同时父侧原 port1 已 detached。
TEST(worker_, transfer_messageport_bidirectional) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var ch = new MessageChannel();\n"
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_port.js');\n"
        "ch.port2.onmessage = function(e){ postMessage({port: e.data}); };\n"
        "w.postMessage('init', [ch.port1]);\n"
        "globalThis.p2 = ch.port2;\n"
        "globalThis.p1 = ch.port1;\n"
        "'started'", &out));

    /* 第一条：worker 收到 port 后回传 'ready' → 父侧 port2.onmessage → 宿主 */
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("\"port\":\"ready\"")) << "got: " << out;

    /* 父侧 port2.postMessage('ping') → worker 侧 port echo 'echo:ping' → 父侧 */
    ASSERT_TRUE(host_eval(h, "p2.postMessage('ping'); 'sent'", &out));
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("\"port\":\"echo:ping\"")) << "got: " << out;

    /* 父侧原 port1 已 detached（被转移） */
    ASSERT_TRUE(host_value(h, "p1._detached ? 'detached' : 'active'", &out));
    EXPECT_NE(std::string::npos, out.find("detached")) << "got: " << out;
    host_destroy(h);
}

// transferable: worker → 父 转移一个 MessagePort。worker 侧创建 channel，
// postMessage(data, [port1]) 把 port1 转移给父；父侧 event.ports[0] 收到
// 端口代理，经它发 'ping' → worker 侧对端 port2 echo 'echo:ping' 返回；
// worker 侧原 port1 已 detached。该方向在 v1 曾未支持（父侧无 workerId
// 路由信息——worker 侧硬编码 peerThread 'parent'，父侧代理 port 无法路由
// 回 worker），本用例验证补齐（worker 侧 pal.workerId）后的双向通信。
TEST(worker_, transfer_messageport_worker_to_parent) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_to_parent.js');\n"
        "w.onmessage = function(e){ if (e.ports && e.ports[0]) globalThis.p = e.ports[0]; postMessage({got: e.data}); };\n"
        "w.postMessage('init');\n"
        "'started'", &out));

    /* 第一条：worker 转移 port 给父 → event.ports[0] 可用，payload {ready:true} */
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("\"got\"")) << "got: " << out;
    EXPECT_NE(std::string::npos, out.find("ready")) << "got: " << out;

    /* 第二条：worker 侧原 port1 已 detached（转移语义） */
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("detached")) << "got: " << out;

    /* 父侧经转移端口 p 发 'ping' → worker 侧 port2 echo 'echo:ping' → p.onmessage */
    ASSERT_TRUE(host_eval(h,
        "globalThis.p.onmessage = function(e){ postMessage({back: e.data}); };\n"
        "p.postMessage('ping'); 'sent'", &out));
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("\"back\":\"echo:ping\"")) << "got: " << out;
    host_destroy(h);
}

// transferable: 多 worker 并发各自创建 channel 转移给父。每个 worker 转移的
// port 在父侧形成独立代理，路由必须回到「正确的」worker（workerId 不混淆）：
// p1 回包必须来自 w1、p2 回包必须来自 w2；且 p1/p2 的 _peerThread 应分别等于
// w1/w2 的 workerId（1/2）。这验证 worker→父 转移的 workerId 路由在并发下的
// 正确性。
TEST(worker_, transfer_messageport_multi_worker) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w1 = new Worker('file://" TEST_DIR "/worker_to_parent.js');\n"
        "globalThis.w2 = new Worker('file://" TEST_DIR "/worker_to_parent.js');\n"
        "w1.onmessage = function(e){ if (e.ports && e.ports[0]) globalThis.p1 = e.ports[0]; };\n"
        "w2.onmessage = function(e){ if (e.ports && e.ports[0]) globalThis.p2 = e.ports[0]; };\n"
        "w1.postMessage('init'); w2.postMessage('init');\n"
        "'started'", &out));

    /* 轮询直到两个代理 port 都已就位（各自 worker 转移成功） */
    ASSERT_TRUE(host_poll_until_value(h,
        "(globalThis.p1 && globalThis.p2) ? 'both-ports-ready' : 'waiting'",
        "both-ports-ready", &out));

    /* 断言 p1/p2 路由到各自 workerId（w1=1、w2=2），不混淆 */
    ASSERT_TRUE(host_value(h, "p1._peerThread + ':' + p2._peerThread", &out));
    EXPECT_EQ(std::string("1:2"), out) << "got: " << out;

    /* p1/p2 并发发消息，回包带来源标签 */
    ASSERT_TRUE(host_eval(h,
        "globalThis.p1.onmessage = function(e){ postMessage({from:'p1', data:e.data}); };\n"
        "globalThis.p2.onmessage = function(e){ postMessage({from:'p2', data:e.data}); };\n"
        "p1.postMessage('ping-A'); p2.postMessage('ping-B');\n"
        "'sent'", &out));

    /* 等两条回包：p1 回 'echo:ping-A'（来自 w1），p2 回 'echo:ping-B'（来自 w2） */
    bool got1 = false, got2 = false;
    for (int i = 0; i < 2; i++) {
        ASSERT_TRUE(host_wait_msg(h, &out));
        if (out.find("\"from\":\"p1\"") != std::string::npos &&
            out.find("echo:ping-A") != std::string::npos) got1 = true;
        if (out.find("\"from\":\"p2\"") != std::string::npos &&
            out.find("echo:ping-B") != std::string::npos) got2 = true;
    }
    EXPECT_TRUE(got1) << "p1 未收到来自 w1 的回包（路由混淆？）last: " << out;
    EXPECT_TRUE(got2) << "p2 未收到来自 w2 的回包（路由混淆？）last: " << out;
    host_destroy(h);
}

// transferable: worker 转移 port 给父后，terminate worker。父侧代理 port 再
// 发消息不应抛错/崩溃——qz_worker_post 检查 worker shutting_down 后静默丢弃，
// 消息不投递（优雅失败）。
TEST(worker_, transfer_messageport_terminate_worker) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_to_parent.js');\n"
        "w.onmessage = function(e){ if (e.ports && e.ports[0]) globalThis.p = e.ports[0]; };\n"
        "w.postMessage('init');\n"
        "'started'", &out));

    /* 等父侧收到转移的代理 port */
    ASSERT_TRUE(host_poll_until_value(h,
        "globalThis.p ? 'port-ready' : 'waiting'", "port-ready", &out));

    /* terminate worker */
    ASSERT_TRUE(host_value(h, "w.terminate(); 'terminated'", &out));
    EXPECT_NE(std::string::npos, out.find("terminated")) << "got: " << out;

    /* 代理 port 发消息：不抛错（worker 已 shutting_down，静默丢弃） */
    ASSERT_TRUE(host_value(h,
        "try { p.postMessage('after-terminate'); 'no-throw'; } catch (e) { 'throw:' + e.message; }",
        &out));
    EXPECT_NE(std::string::npos, out.find("no-throw")) << "got: " << out;
    host_destroy(h);
}

// transferable: 多跳转移——父→worker 转移 port1（w.postMessage('init',[port1])）；
// worker 收到后把同一 port 再 postMessage 回父（worker_multihop.js，第二跳）；父侧
// event.ports[0] 收到经多跳回来的 port，应与其本地 port2 重建同线程纠缠（_peerThread
// === 'local'），可同线程 echo 通信。v1 只支持单次跨线程转移（父→worker 或 worker→父），
// 多跳（父→worker→父）依赖纠缠关系重建——boot shim 的转移 ref 必须保留原 port 的对端
// 线程信息（而非硬编码 pal.workerId()），接收侧 __qz_port_from_ref__ 须重建本地纠缠。
TEST(worker_, transfer_messageport_multihop) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var ch = new MessageChannel();\n"
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_multihop.js');\n"
        "globalThis.p2 = ch.port2;\n"
        "p2.onmessage = function(e){ postMessage({p2: e.data}); };\n"
        "w.onmessage = function(e){ if (e.ports && e.ports[0]) { globalThis.p = e.ports[0]; postMessage({fwd: e.data, p1detached: ch.port1._detached}); } };\n"
        "w.postMessage('init', [ch.port1]);\n"
        "'started'", &out));

    /* 第一条：worker 把收到的 port 转回父 → 父侧 event.ports[0] 收到多跳 port；
       父侧原 port1 已 detached（首次转移语义） */
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("\"fwd\"")) << "got: " << out;
    EXPECT_NE(std::string::npos, out.find("forwarding")) << "got: " << out;
    EXPECT_NE(std::string::npos, out.find("\"p1detached\":true")) << "got: " << out;

    /* 多跳 port 与父侧 port2 同线程纠缠：p.postMessage('ping') 同步分发到
       p2.onmessage → 宿主 {p2:'ping'}（先于 eval 响应到达 inbox） */
    ASSERT_TRUE(host_eval(h, "p.postMessage('ping'); 'sent'", &out));
    EXPECT_NE(std::string::npos, out.find("\"p2\":\"ping\"")) << "got: " << out;
    /* 清掉残留的 eval 响应 {ok,v:'"sent"'} */
    ASSERT_TRUE(host_wait_msg(h, &out));

    /* 反向：p2.postMessage('pong') → p.onmessage → 宿主 {back:'pong'} */
    ASSERT_TRUE(host_eval(h,
        "globalThis.p.onmessage = function(e){ postMessage({back: e.data}); };\n"
        "p2.postMessage('pong'); 'sent'", &out));
    EXPECT_NE(std::string::npos, out.find("\"back\":\"pong\"")) << "got: " << out;
    ASSERT_TRUE(host_wait_msg(h, &out));   /* 清掉 eval 响应残留 */

    /* 多跳 port 应与 port2 重建同线程纠缠（_peerThread === 'local'） */
    ASSERT_TRUE(host_value(h,
        "p._peerThread === 'local' ? 'entangled' : String(p._peerThread)", &out));
    EXPECT_NE(std::string::npos, out.find("entangled")) << "got: " << out;
    host_destroy(h);
}

// worker 自关（脚本内 close()）：请求终止自身线程（pal.workerClose →
// qz_worker_terminate），父 runtime 不受影响；自关后父侧 w.terminate()
//（对已退出的 worker）静默安全，父 teardown join 不崩溃/不双重释放。
TEST(worker_, self_close) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    /* worker 先回报一条消息，随后 close() 终止自身 */
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_selfclose.js');\n"
        "w.onmessage = function(e){ postMessage({v: e.data}); };\n"
        "'started'", &out));

    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("\"v\"")) << "got: " << out;
    EXPECT_NE(std::string::npos, out.find("before-close")) << "got: " << out;

    /* 自关后父侧 terminate 不抛错（worker 已 shutting_down，静默丢弃） */
    ASSERT_TRUE(host_value(h, "w.terminate(); 'ok'", &out));
    EXPECT_NE(std::string::npos, out.find("ok")) << "got: " << out;
    host_destroy(h);
}

/* ================================================================
 * A2 健壮性：transferable 错误路径
 * ================================================================ */

// transfer 列表含重复对象 → DataCloneError；异常时原 buffer 不被 detach
//（Web 语义：抛错的 postMessage 不产生副作用）。
TEST(worker_, transfer_duplicate_throws_no_detach) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_echo.js');\n"
        "'started'", &out));

    ASSERT_TRUE(host_value(h,
        "var ab = new ArrayBuffer(4); var caught = '';\n"
        "try { w.postMessage(ab, [ab, ab]); } catch (e) { caught = e.name; }\n"
        "JSON.stringify([caught, ab.byteLength])", &out));
    EXPECT_NE(std::string::npos, out.find("[\"DataCloneError\",4]")) << "got: " << out;
    host_destroy(h);
}

// 不可转移对象（普通对象）进 transfer 列表 → DataCloneError，消息不发出。
TEST(worker_, transfer_nontransferable_throws) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_echo.js');\n"
        "var got = 'none';\n"
        "w.onmessage = function(e){ got = e.data; };\n"
        "'started'", &out));

    ASSERT_TRUE(host_value(h,
        "var caught = ''; var sent = true;\n"
        "try { w.postMessage({a:1}, [{}]); } catch (e) { caught = e.name; sent = false; }\n"
        "JSON.stringify([caught, sent, got])", &out));
    EXPECT_NE(std::string::npos, out.find("[\"DataCloneError\",false,\"none\"]")) << "got: " << out;
    host_destroy(h);
}

// 已 detach 的 ArrayBuffer 再进 transfer 列表 → DataCloneError（原引用
// 已不可转移），buffer 保持 detached。
TEST(worker_, transfer_detached_buffer_throws) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_echo.js');\n"
        "'started'", &out));

    ASSERT_TRUE(host_value(h,
        "var ab = new ArrayBuffer(4);\n"
        "w.postMessage(ab, [ab]);\n"
        "var caught = '';\n"
        "try { w.postMessage('x', [ab]); } catch (e) { caught = e.name; }\n"
        "JSON.stringify([caught, ab.byteLength])", &out));
    EXPECT_NE(std::string::npos, out.find("[\"DataCloneError\",0]")) << "got: " << out;
    host_destroy(h);
}

/* ================================================================
 * A2 健壮性：Worker 生命周期错误路径
 * ================================================================ */

// 非法 URL（非 file://）与不存在的文件 → new Worker 抛错；失败构造不占
// 槽位，后续正常 spawn 的 worker 通信无碍。
TEST(worker_, constructor_bad_url_then_recovery) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_value(h,
        "var e1 = ''; var e2 = '';\n"
        "try { new Worker('http://x/y.js'); } catch (err) { e1 = err.name; }\n"
        "try { new Worker('file:///nonexistent-qzjs-a2.js'); } catch (err) { e2 = err.name; }\n"
        "JSON.stringify([e1, e2])", &out));
    /* http:// 非法 URL → Error（loadScript 校验）；不存在的文件 → TypeError
       （fsReadSync 底层错误透传）。两者都中断构造、不占槽位。 */
    EXPECT_NE(std::string::npos, out.find("[\"Error\",\"TypeError\"]")) << "got: " << out;

    /* 失败构造后 runtime 仍正常：spawn echo worker 往返 */
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_echo.js');\n"
        "w.onmessage = function(e){ postMessage({v: e.data}); };\n"
        "w.postMessage('recover');\n"
        "'started'", &out));
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("\"v\":\"recover\"")) << "got: " << out;
    host_destroy(h);
}

// terminate 后 postMessage 静默丢弃（不抛错、不崩溃）；重复 terminate 亦安全；
// 父 runtime 继续正常求值。
TEST(worker_, post_after_terminate_safe) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_idle.js');\n"
        "'started'", &out));

    ASSERT_TRUE(host_value(h,
        "w.postMessage('x'); w.terminate();\n"
        "var caught = '';\n"
        "try { w.postMessage('y'); w.terminate(); } catch (err) { caught = err.name; }\n"
        "JSON.stringify([caught, 2 + 2])", &out));
    EXPECT_NE(std::string::npos, out.find("[\"\",4]")) << "got: " << out;
    host_destroy(h);
}

// 父侧 onmessage 处理器抛错：worker 存活，替换处理器后后续消息仍正常处理。
TEST(worker_, handler_throw_worker_survives) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_echo.js');\n"
        "w.onmessage = function(e){ throw new Error('handler-boom'); };\n"
        "w.postMessage('a');\n"
        "'started'", &out));

    /* 处理器抛错不杀 worker：换处理器后 'b' 正常回显。注意 'a' 的回显可能
       恰在替换后才到达父侧（跨线程竞态），被新 handler 回传 {v:'a'} ——
       跳过它，断言 'b' 到达即证明 worker 存活。 */
    ASSERT_TRUE(host_eval(h,
        "w.onmessage = function(e){ postMessage({v: e.data}); };\n"
        "w.postMessage('b');\n"
        "'swapped'", &out));
    bool gotB = false;
    for (int i = 0; i < 4 && !gotB; i++) {
        if (!host_wait_msg(h, &out, 5000)) break;
        gotB = out.find("\"v\":\"b\"") != std::string::npos;
    }
    ASSERT_TRUE(gotB) << "worker 未存活或回显缺失, last: " << out;
    host_destroy(h);
}

// worker 运行中（定时器回调）抛错：self.onerror 捕获并回报父；worker 不死，
// 后续消息仍处理。覆盖异步错误路径（非脚本顶层 throw）。
TEST(worker_, async_error_self_onerror_survives) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_async_error.js');\n"
        "w.onmessage = function(e){ postMessage(e.data); };\n"
        "w.postMessage('boom-later');\n"
        "'started'", &out));

    /* 先到 'scheduled'，随后定时器抛错 → self.onerror 回报 */
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("scheduled")) << "got: " << out;
    /* 先到 'scheduled'，随后定时器抛错 → self.onerror 回报 {workerErr:...}
       （经父侧 w.onmessage 转发 postMessage(e.data)） */
    ASSERT_TRUE(host_wait_msg(h, &out, 10000));
    EXPECT_NE(std::string::npos, out.find("\"workerErr\":\"async-boom\"")) << "got: " << out;

    /* worker 不死：后续消息仍回显 */
    ASSERT_TRUE(host_poll_until_value(h,
        "(function(){ w.postMessage('ping'); return 'sent'; })()",
        "sent", &out));
    ASSERT_TRUE(host_wait_msg(h, &out, 10000));
    EXPECT_NE(std::string::npos, out.find("alive:ping")) << "got: " << out;
    host_destroy(h);
}

/* ================================================================
 * A2 压力
 * ================================================================ */

// 压力：4 个 worker × 20 条消息洪泛，全部回显且内容不错乱。
TEST(worker_, stress_multi_worker_flood) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.seen = []; globalThis.n = 0;\n"
        "globalThis.ws = [];\n"
        "for (var i = 0; i < 4; i++) {\n"
        "  var wi = new Worker('file://" TEST_DIR "/worker_echo.js');\n"
        "  wi.onmessage = function(e){ n++; seen.push(e.data); };\n"
        "  ws.push(wi);\n"
        "}\n"
        "for (var r = 0; r < 20; r++)\n"
        "  for (var k = 0; k < 4; k++)\n"
        "    ws[k].postMessage('w' + k + '-m' + r);\n"
        "'flooded'", &out));

    ASSERT_TRUE(host_poll_until_value(h, "String(n)", "80", &out));
    ASSERT_TRUE(host_value(h,
        "var exp = [];\n"
        "for (var r = 0; r < 20; r++) for (var k = 0; k < 4; k++) exp.push('w' + k + '-m' + r);\n"
        "JSON.stringify(exp.sort().join('|') === seen.sort().join('|'))", &out));
    EXPECT_NE(std::string::npos, out.find("true")) << "got: " << out;
    host_destroy(h);
}

// 压力：30 轮 ArrayBuffer transfer 往返链。父侧发送后立即 detach；worker
// echo 克隆回传；内容逐轮校验不错乱。
TEST(worker_, stress_transfer_roundtrip_chain) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.wt = new Worker('file://" TEST_DIR "/worker_echo.js');\n"
        "globalThis.tn = 0; globalThis.tbad = '';\n"
        "globalThis.sendNext = function () {\n"
        "  var ab = new ArrayBuffer(4);\n"
        "  new Uint8Array(ab).set([tn + 1, 0, 0, 0]);\n"
        "  wt.postMessage(ab, [ab]);\n"
        "  if (ab.byteLength !== 0) tbad = 'not-detached-' + tn;\n"
        "};\n"
        "wt.onmessage = function(e){\n"
        "  tn++;\n"
        "  if (!(e.data instanceof ArrayBuffer) || e.data.byteLength !== 4) { tbad = 'shape-' + tn; return; }\n"
        "  if (new Uint8Array(e.data)[0] !== tn) { tbad = 'content-' + tn; return; }\n"
        "  if (tn < 30) sendNext();\n"
        "};\n"
        "sendNext();\n"
        "'chained'", &out));

    ASSERT_TRUE(host_poll_until_value(h,
        "tn + ':' + (tbad || 'ok')", "30:ok", &out));
    host_destroy(h);
}

// localStorage 只在父 runtime 挂载，worker 内不挂（Web Storage 保守默认：
// worker 无 DOM 场景，且每个 worker 是独立 JSRuntime 独立 state）。
TEST(worker_, localStorage_not_mounted) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    std::string out;
    ASSERT_TRUE(host_eval(h,
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_localstorage.js');\n"
        "w.onmessage = function(e){ postMessage({ls: e.data.ls}); };\n"
        "'started'", &out));
    ASSERT_TRUE(host_wait_msg(h, &out));   /* 等 worker 回报 */
    EXPECT_NE(std::string::npos, out.find("\"ls\":\"undefined\"")) << "got: " << out;
    host_destroy(h);
}

// ── M-P3：MessagePort 跨端点路由 ───────────────────────────────────────────
// sibling 接力：ch.port1 → w1、ch.port2 → w2（两 worker 各持一端）。w1 经 port
// 发的消息目标是 w2 里的 port2 —— 主RT 是两者的 LCA，须按帧头 dest 端点把消息
// 从 w1 转发到 w2（§8.2 路由表语义；THREAD 后端同一套 JS 路由逻辑）。
TEST(worker_, port_sibling_relay) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var ch = new MessageChannel();\n"
        "globalThis.w1 = new Worker('file://" TEST_DIR "/worker_port_sibling_send.js');\n"
        "globalThis.w2 = new Worker('file://" TEST_DIR "/worker_port_sibling_recv.js');\n"
        "w2.onmessage = function(e){ postMessage({relay: e.data}); };\n"
        "w2.postMessage('init', [ch.port2]);\n"
        "w1.postMessage('init', [ch.port1]);\n"
        "'started'", &out));

    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("recv:sib-hello")) << "got: " << out;
    host_destroy(h);
}

// id 撞车回归（§8.2）：worker 自建 MessageChannel 与父转移来的 port 共存时，
// 只按本地 id 建表会互相覆盖（进程隔离下各进程 id 都从 1 起）。断言两侧都能
// 收发：转移来的 port echo 正常，且 worker 自建 channel 也收到自己的消息。
TEST(worker_, port_endpoint_identity_no_collision) {
    HostCtx *h = host_create();
    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var ch = new MessageChannel();\n"
        "globalThis.log = [];\n"
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_port_own_channel.js');\n"
        "ch.port2.onmessage = function(e){\n"
        "  log.push(String(e.data));\n"
        "  if (String(e.data).indexOf('echo:') !== 0) ch.port2.postMessage('ping');\n"
        "};\n"
        "w.postMessage('init', [ch.port1]);\n"
        "'started'", &out));

    /* 期望序列：转移来的 port 上先收 'ready'，再完成一次往返（自建 channel 若
     * 覆盖了表项，第二轮收不到回包，poll 超时失败）。 */
    ASSERT_TRUE(host_poll_until_value(h, "log.join('|')",
        "ready|echo:ping|own=self", &out)) << "got: " << out;
    host_destroy(h);
}
// 端点死亡清表（§8.2 失败语义）：worker 终止后，父侧对端 port 收到一次 error
// 事件；此后 postMessage 静默丢弃（terminate 后的规范语义），不抛错。
TEST(worker_, port_endpoint_dead_notifies_peer) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var ch = new MessageChannel();\n"
        "globalThis.errs = 0; globalThis.ready = 0;\n"
        "ch.port2.addEventListener('error', function(){ errs++; });\n"
        "ch.port2.onmessage = function(){ ready = 1; };\n"
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_port.js');\n"
        "w.postMessage('init', [ch.port1]);\n"
        "'started'", &out));

    /* worker 收到 port 后经 port 回 'ready' → 确认端点已建立再终止 */
    ASSERT_TRUE(host_poll_until_value(h, "String(ready)", "1", &out));
    ASSERT_TRUE(host_value(h, "w.terminate(); 'errs=' + errs", &out));
    EXPECT_NE(std::string::npos, out.find("errs=1")) << "got: " << out;

    ASSERT_TRUE(host_value(h,
        "try { ch.port2.postMessage('after-death'); 'no-throw'; }\n"
        "catch (e) { 'throw:' + e.message; }", &out));
    EXPECT_NE(std::string::npos, out.find("no-throw")) << "got: " << out;
    host_destroy(h);
}

// ── worker 继承父 runtime 的 CA 信任库（qz_add_ca_pem）──────────────────
// worker 是独立 calloc 出来的 qz_t，不共享父 runtime 状态；不显式继承的话
// worker 里的 fetch 访问私有 CA 站点会报 X509 verification failed，而 PROCESS
// 后端的 worker 经 QZ_CA_FILE 拿得到 —— 两后端行为不一致（静默降级）。
//
// 这里断言继承后的**内容**而非"调用过"：把 PEM 塞进父 rt，再让 worker 起来，
// 然后检查 worker 自己 rt 的 ca_pem 真的带着那份 PEM。worker_echo.js 会回一条
// 消息，用它确认 worker 确实跑过（否则"worker 没起来"会伪装成"继承失败"）。
TEST(worker_, inherits_ca_trust_store_from_parent)
{
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    /* 父 runtime 装一份 CA（内容用夹具证书；本用例只关心"内容是否传下去"，
     * 解析正确性由 test_tls_ca_gtest 负责）。 */
    const char *pem =
        "-----BEGIN CERTIFICATE-----\n"
        "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest\n"
        "-----END CERTIFICATE-----\n";
    ASSERT_EQ(0, qz_add_ca_pem(h->rt, pem));
    ASSERT_GT(h->rt->ca_pem_len, 0u);

    /* 起一个 worker：它会 postMessage 回来，证明确实跑起来了。 */
    std::string out;
    const char *spawn_js =
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_echo.js');\n"
        "w.onmessage = function(e){ globalThis.__got = e.data; };\n"
        "0";
    host_eval(h, spawn_js, &out);
    for (int i = 0; i < 30 && !h->rt->workers[0]; i++) host_poll_sleep();
    for (int i = 0; i < 30; i++) host_poll_sleep();

    ASSERT_NE(nullptr, h->rt->workers[0]) << "worker 未创建，继承无从验证";
    qz_worker_t *w = h->rt->workers[0];
    ASSERT_NE(nullptr, w->self);

    /* 核心断言：worker 的 rt 真的带着父的 CA 内容。 */
    ASSERT_NE(nullptr, w->self->ca_pem) << "worker rt 没有继承 CA 信任库";
    ASSERT_GT(w->self->ca_pem_len, 0u);
    EXPECT_EQ(h->rt->ca_pem_len, w->self->ca_pem_len);
    EXPECT_STREQ(h->rt->ca_pem, w->self->ca_pem);

    host_destroy(h);
}

// ── wait_idle 计入 worker 的在途异步工作 ─────────────────────────────────
// worker 有**独立的 uv_loop**：父的 qz_loop_idle() 只看 rt 自己的 loop，worker 内
// 发起的 fetch/timer 挂在 worker 自己的 loop 上，父完全看不到 → wait_idle 提前
// teardown，worker 的异步结果被静默丢弃（现象：worker 脚本里只有 fetch 时，
// 父收不到任何消息）。
//
// 修法：worker 在自己线程上算 busy 并发布原子位，父的 qz_loop_idle 读它；
// worker 由忙转空闲时 uv_async_send 叫醒父的 loop（父的 uv_run 在无活动句柄时
// 会阻塞，只靠 wait_idle 那一次唤醒不足以让它重新判定）。
//
// 本用例断言父在 worker 仍有在途异步工作时**不判 idle**。
TEST(worker_, parent_stays_busy_while_worker_has_pending_async_work)
{
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    /* worker 起一个 40ms 定时器：在它到期前，父必须判忙。
     * 用 host_poll_sleep 推进若干轮，每轮检查 busy 位。 */
    const char *spawn_js =
        "globalThis.w = new Worker('file://" TEST_DIR "/worker_idle_probe.js');\n"
        "0";
    std::string out;
    host_eval(h, spawn_js, &out);

    int saw_busy = 0;
    for (int i = 0; i < 200 && !saw_busy; i++) {
        host_poll_sleep();
        qz_worker_t *w = h->rt->workers[0];
        if (w && __atomic_load_n(&w->busy, __ATOMIC_ACQUIRE)) saw_busy = 1;
    }
    EXPECT_TRUE(saw_busy) << "worker 的定时器在途期间，busy 位从未置 1——"
                            "父会提前判 idle 并丢弃 worker 的异步结果";

    host_destroy(h);
}
