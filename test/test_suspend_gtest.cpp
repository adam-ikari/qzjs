// test_suspend_gtest.cpp — Task 5: 软挂起/恢复（qzContext.suspend/resume）
//
// 挂起 = 捕获子 context 的可克隆全局属性 → 结构化克隆字节 → 写盘 → 销毁 ctx。
// 恢复 = 在原槽位重建 ctx + 反序列化状态回 globalThis。
//
// 往返一致性：suspend → a.bin；resume（空 init 脚本，状态完全来自 a.bin）→
// suspend → b.bin；字节级比较 a == b。restore 若丢属性，第二次捕获会缺键，
// 字节必然不同——这个测试真实验证了反序列化回写。
#include "test_host.h"
#include <string>
#include <cstdio>
TEST(qz_suspend_, child_state_roundtrip) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    std::string out;

    // 子 context：init 脚本定义用户状态（foo / marker）
    const char *childScript =
        "globalThis.foo = {n: 42, s: 'x'}; globalThis.marker = 'state';";
    std::string spawnCode =
        "JSON.stringify(qzContext.spawn(" + JSON_string(childScript) + "))";
    ASSERT_TRUE(host_value(h, spawnCode.c_str(), &out));
    ASSERT_EQ("1", out) << "spawn id: " << out;

    // 挂起 → a.bin
    std::string suspendA =
        "qzContext.suspend(1, '" TEST_DIR "/state_a.bin'); 'ok'";
    ASSERT_TRUE(host_eval(h, suspendA.c_str(), &out));
    ASSERT_NE(std::string::npos, out.find("ok")) << "got: " << out;

    // 恢复：空 init 脚本，状态完全来自 a.bin（验证 restore 而非重 eval）
    std::string resumeCode =
        "JSON.stringify(qzContext.resume(1, '', '" TEST_DIR "/state_a.bin'))";
    ASSERT_TRUE(host_value(h, resumeCode.c_str(), &out));
    ASSERT_EQ("1", out) << "resume id: " << out;

    // 再挂起 → b.bin；两次捕获必须字节级一致
    std::string suspendB =
        "qzContext.suspend(1, '" TEST_DIR "/state_b.bin'); 'ok'";
    ASSERT_TRUE(host_eval(h, suspendB.c_str(), &out));
    ASSERT_NE(std::string::npos, out.find("ok")) << "got: " << out;

    std::string a, b;
    ASSERT_TRUE(host_read_file(TEST_DIR "/state_a.bin", &a));
    ASSERT_TRUE(host_read_file(TEST_DIR "/state_b.bin", &b));
    EXPECT_FALSE(a.empty());
    EXPECT_EQ(a, b) << "suspend→resume→suspend 状态不一致（restore 可能丢属性）";

    // 子 context 的状态始终不泄漏到主 context
    ASSERT_TRUE(host_value(h, "typeof globalThis.foo", &out));
    EXPECT_EQ("undefined", out) << "got: " << out;
    ASSERT_TRUE(host_value(h, "1 + 1", &out));
    EXPECT_NE(std::string::npos, out.find("2")) << "got: " << out;

    host_destroy(h);
    remove(TEST_DIR "/state_a.bin");
    remove(TEST_DIR "/state_b.bin");
}

// 不存在的 context id 挂起 → 报错（NOT_FOUND），主 context 不受影响。
TEST(qz_suspend_, unknown_ctx_id) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    std::string out;

    ASSERT_TRUE(host_eval(h,
        "var rejected = false;"
        "try { qzContext.suspend(99, ''); } catch (e) { rejected = true; }"
        "JSON.stringify(rejected)", &out));
    ASSERT_NE(std::string::npos, out.find("true")) << "got: " << out;

    ASSERT_TRUE(host_value(h, "2 + 2", &out));
    EXPECT_NE(std::string::npos, out.find("4")) << "got: " << out;
    host_destroy(h);
}

/* ================================================================
 * A2 健壮性：软挂起/恢复边界
 * ================================================================ */

// destroy 已挂起槽位后 resume 回同槽：状态完全来自 state 文件；恢复后再次
// suspend 字节一致（restore 真实回写）。主 context 不受影响。
TEST(qz_suspend_, resume_into_fresh_slot) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    std::string out;

    /* 借子 context 造一份状态盘 */
    ASSERT_TRUE(host_value(h,
        "JSON.stringify(qzContext.spawn(\"globalThis.k = 'v-fresh'\"))", &out));
    ASSERT_EQ("1", out);
    ASSERT_TRUE(host_eval(h,
        "qzContext.suspend(1, '" TEST_DIR "/state_fresh.bin'); 'ok'", &out));
    ASSERT_NE(std::string::npos, out.find("ok")) << "got: " << out;

    /* G1：suspend 成功即销毁 ctx（槽位空）→ resume 从盘重建 */
    ASSERT_TRUE(host_value(h,
        "JSON.stringify(qzContext.resume(1, '', '" TEST_DIR "/state_fresh.bin'))", &out));
    ASSERT_EQ("1", out) << "resume id: " << out;

    /* 显式 destroy 后再 resume 回同槽：occupied → empty → resume 路径 */
    ASSERT_TRUE(host_value(h, "qzContext.destroy(1); 'ok'", &out));
    ASSERT_TRUE(host_value(h,
        "JSON.stringify(qzContext.resume(1, '', '" TEST_DIR "/state_fresh.bin'))", &out));
    ASSERT_EQ("1", out) << "resume id: " << out;

    /* 恢复的 context 状态可校验：再挂起一次，读字节验证 k 在盘上 */
    ASSERT_TRUE(host_eval(h,
        "qzContext.suspend(1, '" TEST_DIR "/state_fresh2.bin'); 'ok'", &out));
    ASSERT_NE(std::string::npos, out.find("ok")) << "got: " << out;
    std::string a, b;
    ASSERT_TRUE(host_read_file(TEST_DIR "/state_fresh.bin", &a));
    ASSERT_TRUE(host_read_file(TEST_DIR "/state_fresh2.bin", &b));
    EXPECT_FALSE(a.empty());
    EXPECT_EQ(a, b) << "resume 后再 suspend 状态不一致";

    ASSERT_TRUE(host_value(h, "typeof globalThis.k", &out));
    EXPECT_EQ("undefined", out) << "子状态泄漏到主 context";
    host_destroy(h);
    remove(TEST_DIR "/state_fresh.bin");
    remove(TEST_DIR "/state_fresh2.bin");
}

// 坏 state 文件：路径不存在 → suspend/resume 报错（TypeError，C 返回 IO 失败），
// 主 context 不受影响。
TEST(qz_suspend_, resume_bad_state_path) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    std::string out;

    ASSERT_TRUE(host_value(h,
        "JSON.stringify(qzContext.spawn(\"globalThis.a = 1\"))", &out));
    ASSERT_EQ("1", out);

    /* suspend 写盘成功后把文件删掉，再 resume：读文件失败 */
    ASSERT_TRUE(host_eval(h,
        "qzContext.suspend(1, '" TEST_DIR "/state_gone.bin'); 'ok'", &out));
    ASSERT_NE(std::string::npos, out.find("ok")) << "got: " << out;
    ASSERT_EQ(0, remove(TEST_DIR "/state_gone.bin"));
    /* G1：suspend 已销毁 ctx（槽位空），无需再 destroy */

    ASSERT_TRUE(host_value(h,
        "var caught = '';\n"
        "try { qzContext.resume(1, '', '" TEST_DIR "/state_gone.bin'); } catch (e) { caught = e.name; }\n"
        "caught", &out));
    EXPECT_NE(std::string::npos, out.find("Error")) << "got: " << out;

    /* 主 context 正常 */
    ASSERT_TRUE(host_value(h, "40 + 2", &out));
    EXPECT_NE(std::string::npos, out.find("42")) << "got: " << out;
    host_destroy(h);
}

// 挂起含"不可克隆"属性（函数）的 context：函数记入 skipped 并在首次 restore
// 后永久丢失（不可克隆 → restore 无从重建，设计行为）；可克隆状态完整往返。
TEST(qz_suspend_, skipped_uncloneable_stable) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    std::string out;

    const char *child =
        "globalThis.data = {n: 7}; globalThis.fn = function () {};";
    std::string spawnSk = "JSON.stringify(qzContext.spawn(" + JSON_string(child) + "))";
    ASSERT_TRUE(host_value(h, spawnSk.c_str(), &out));
    ASSERT_EQ("1", out);

    ASSERT_TRUE(host_eval(h,
        "qzContext.suspend(1, '" TEST_DIR "/state_sk1.bin'); 'ok'", &out));
    ASSERT_NE(std::string::npos, out.find("ok")) << "suspend#1: " << out;
    ASSERT_TRUE(host_value(h,
        "JSON.stringify(qzContext.resume(1, '', '" TEST_DIR "/state_sk1.bin'))", &out));
    ASSERT_EQ("1", out) << "resume: " << out;

    /* 第二次 suspend：restore 后的 ctx 快照 */
    ASSERT_TRUE(host_eval(h,
        "qzContext.suspend(1, '" TEST_DIR "/state_sk2.bin'); 'ok'", &out));
    ASSERT_NE(std::string::npos, out.find("ok")) << "suspend#2: " << out;
    /* skipped 属性（fn）在首次 restore 后**永久丢失**（不可克隆，restore 无从
       重建）——这是设计行为：第二次捕获的 skipped 少 fn，可克隆的 data 完整
       往返。断言：两次快照都含 data；第二次 skipped ⊆ 第一次 skipped，且
       第一次确实记录了 fn。 */
    std::string a, b;
    ASSERT_TRUE(host_read_file(TEST_DIR "/state_sk1.bin", &a));
    ASSERT_TRUE(host_read_file(TEST_DIR "/state_sk2.bin", &b));
    EXPECT_NE(std::string::npos, a.find("data")) << "第一次快照缺 data";
    EXPECT_NE(std::string::npos, b.find("data")) << "第二次快照缺 data（往返丢数据）";
    EXPECT_NE(std::string::npos, a.find("fn")) << "第一次快照未把 fn 记入 skipped";
    EXPECT_EQ(std::string::npos, b.find("fn")) << "fn 不应出现在 restore 后的快照";
    /* skipped 基础项：__native__ 恒在（polyfill 基础设施，两次快照共同前缀）。
       CryptoKey/SubtleCrypto/WebAssembly 随构建扩展集变化（如 ASan 构建可
       无 wasm 扩展），不硬编码。 */
    EXPECT_NE(std::string::npos, a.find("__native__")) << "第一次快照缺 __native__";
    EXPECT_NE(std::string::npos, b.find("__native__")) << "第二次快照缺 __native__";
    ASSERT_TRUE(host_value(h, "typeof globalThis.data", &out));
    EXPECT_EQ("undefined", out);
    host_destroy(h);
    remove(TEST_DIR "/state_sk1.bin");
    remove(TEST_DIR "/state_sk2.bin");
}

// 压力：suspend → resume(init) 循环 10 轮。restore 只写回捕获的键、不删除
// init 新增键，所以每轮 init 写下的 round=i 在 restore 后保留，下一轮
// suspend 字节必须含该轮标记——验证槽位稳定复用、状态逐轮无损、init 与
// restore 协同不互相破坏。主 context 全程可用。
TEST(qz_suspend_, stress_cycle_10_rounds) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    std::string out;

    ASSERT_TRUE(host_value(h,
        "JSON.stringify(qzContext.spawn(\"globalThis.ctr = 0\"))", &out));
    ASSERT_EQ("1", out);

    for (int i = 1; i <= 10; i++) {
        std::string suspend =
            "qzContext.suspend(1, '" TEST_DIR "/state_cyc.bin'); 'ok'";
        ASSERT_TRUE(host_eval(h, suspend.c_str(), &out)) << "round " << i;
        ASSERT_NE(std::string::npos, out.find("ok")) << "round " << i;

        /* init 写独有键 round=i（restore 只写回捕获键、不删 init 新键，
           所以 round 每轮保留更新）；restore 是否真把 ctr 带回来，由末轮
           字节检查验证 */
        std::string init = "globalThis.round = " + std::to_string(i) + ";";
        std::string resume =
            "JSON.stringify(qzContext.resume(1, " + JSON_string(init.c_str()) +
            ", '" TEST_DIR "/state_cyc.bin'))";
        ASSERT_TRUE(host_value(h, resume.c_str(), &out)) << "round " << i;
        ASSERT_EQ("1", out) << "round " << i << " init threw: " << out;
    }

    /* 末轮 suspend 字节必须同时含 round=10（init 新键保留到最后一轮）与
       ctr:0（捕获状态每轮无损带回） */
    ASSERT_TRUE(host_eval(h,
        "qzContext.suspend(1, '" TEST_DIR "/state_cyc_end.bin'); 'ok'", &out));
    std::string bytes;
    ASSERT_TRUE(host_read_file(TEST_DIR "/state_cyc_end.bin", &bytes));
    EXPECT_NE(std::string::npos, bytes.find("round")) << "init 键未被保留";
    EXPECT_NE(std::string::npos, bytes.find("ctr")) << "捕获状态丢失";

    ASSERT_TRUE(host_value(h, "1 + 1", &out));
    EXPECT_NE(std::string::npos, out.find("2"));
    host_destroy(h);
    remove(TEST_DIR "/state_cyc.bin");
    remove(TEST_DIR "/state_cyc_end.bin");
}

// G2 回归：销毁带 pending job 的 context 不得 UAF。JS_FreeContext 不清
// rt->job_list 中属于该 ctx 的 entry——修复前残留悬垂 e->ctx，下一轮
// qz_tick（每次 eval 后主循环都会跑）执行 JS_ExecutePendingJob
// 即访问已释放内存。修复 = qz_ctx_destroy 在 JS_FreeContext 前调
// JS_DrainPendingJobsForContext（quickjs-ng drain-jobs patch）摘除该 ctx 的
// pending job。
//
// 关键：spawn 与 destroy 必须在**同一次 eval**内完成——两次 eval 之间主循环
// 会 flush 微任务，把子 ctx 的 pending job 先执行掉（ctx 尚存活，无 UAF），
// bug 无法复现。compound eval 保证 destroy 时刻 job 队列里确有该 ctx 的
// pending job；destroy 后的下一次 eval 触发 flush，修复前此处崩溃。
TEST(qz_suspend_, destroy_with_pending_job_no_uaf) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    std::string out;

    // 同一 eval：spawn（init 脚本留一个未执行的 Promise 反应）→ 立即 destroy
    std::string code =
        "var id = qzContext.spawn('Promise.resolve().then(function(){});');"
        "qzContext.destroy(id); 'ok'";
    ASSERT_TRUE(host_eval(h, code.c_str(), &out));
    // 精确匹配 ok:true（find("ok") 会放过 {"ok":false,...} 的失败响应）
    ASSERT_NE(std::string::npos, out.find("\"ok\":true")) << "got: " << out;

    // 下一轮 eval：uv_run + flush。修复前：悬垂 e->ctx → UAF/crash；
    // 修复后：job 已 drain，主 context 一切正常。
    ASSERT_TRUE(host_value(h, "1 + 1", &out));
    ASSERT_EQ("2", out) << "destroy 后主 context 异常: " << out;

    // 再 spawn/destroy 一轮（槽位 1 已释放，spawn 复用），确认运行时健康
    ASSERT_TRUE(host_value(h,
        "JSON.stringify(qzContext.spawn('globalThis.x = 5;'))", &out));
    ASSERT_EQ("1", out) << "spawn 复用槽位: " << out;
    ASSERT_TRUE(host_value(h, "qzContext.destroy(1); 'ok'", &out));
    ASSERT_NE(std::string::npos, out.find("ok")) << "got: " << out;

    host_destroy(h);
}

// G1+G2 变体（suspend 路径）：同一次 eval 内 spawn（含用户全局 + pending
// Promise 反应）→ suspend。G1 使 suspend 真销毁 ctx，销毁前 G2 的 drain 摘除
// 该 ctx 的 pending job；下一轮 eval 触发 flush，修复前此处 UAF。
TEST(qz_suspend_, suspend_with_pending_job_no_uaf) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    std::string out;

    // 同一 eval：spawn（用户状态 + pending Promise 反应）→ suspend 写盘。
    // capture 同步执行不 flush，suspend 时刻 job 队列确有该 ctx 的 job。
    std::string code =
        "var id = qzContext.spawn('globalThis.pj = 7;"
        "Promise.resolve().then(function(){});');"
        "qzContext.suspend(id, '" TEST_DIR "/state_pj.bin'); 'ok'";
    ASSERT_TRUE(host_eval(h, code.c_str(), &out));
    ASSERT_NE(std::string::npos, out.find("\"ok\":true")) << "got: " << out;

    // flush：job 已被 drain（G2），修复前此处悬垂 e->ctx → UAF/crash。
    // 主 context 正常。
    ASSERT_TRUE(host_value(h, "1 + 1", &out));
    ASSERT_EQ("2", out) << "suspend 后主 context 异常: " << out;
    // resume 重建（G1 后槽位已空）→ 再 suspend 验证用户状态完整往返；
    // pending 的 Promise 反应不复活（G5 边界：挂起不保存运行时异步状态）。
    ASSERT_TRUE(host_value(h,
        "JSON.stringify(qzContext.resume(1, '', '" TEST_DIR "/state_pj.bin'))", &out));
    ASSERT_EQ("1", out) << "resume id: " << out;
    ASSERT_TRUE(host_eval(h,
        "qzContext.suspend(1, '" TEST_DIR "/state_pj2.bin'); 'ok'", &out));
    ASSERT_NE(std::string::npos, out.find("ok")) << "got: " << out;
    std::string a, b;
    ASSERT_TRUE(host_read_file(TEST_DIR "/state_pj.bin", &a));
    ASSERT_TRUE(host_read_file(TEST_DIR "/state_pj2.bin", &b));
    EXPECT_FALSE(a.empty());
    EXPECT_NE(std::string::npos, b.find("pj")) << "用户状态未恢复";
    EXPECT_EQ(a, b) << "resume 后再 suspend 状态不一致";

    host_destroy(h);
    remove(TEST_DIR "/state_pj.bin");
    remove(TEST_DIR "/state_pj2.bin");
}

// G1 回归（设计 §8.2 suspend_releases_slot）：suspend 成功后槽位空出（ctx 已
// 销毁、内存已释放），resume 在原槽位重建且状态完整。主 context 不受影响。
TEST(qz_suspend_, suspend_releases_slot) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    std::string out;

    ASSERT_TRUE(host_value(h,
        "JSON.stringify(qzContext.spawn(\"globalThis.k = 'slot'\"))", &out));
    ASSERT_EQ("1", out);

    // suspend 成功 → G1 销毁 ctx，槽位空
    ASSERT_TRUE(host_eval(h,
        "qzContext.suspend(1, '" TEST_DIR "/state_slot.bin'); 'ok'", &out));
    ASSERT_NE(std::string::npos, out.find("ok")) << "got: " << out;

    // resume 回同槽：重建成功，状态完整（k 回到盘上）
    ASSERT_TRUE(host_value(h,
        "JSON.stringify(qzContext.resume(1, '', '" TEST_DIR "/state_slot.bin'))", &out));
    ASSERT_EQ("1", out) << "resume id: " << out;
    ASSERT_TRUE(host_eval(h,
        "qzContext.suspend(1, '" TEST_DIR "/state_slot3.bin'); 'ok'", &out));
    ASSERT_NE(std::string::npos, out.find("ok")) << "got: " << out;
    std::string a, b;
    ASSERT_TRUE(host_read_file(TEST_DIR "/state_slot.bin", &a));
    ASSERT_TRUE(host_read_file(TEST_DIR "/state_slot3.bin", &b));
    EXPECT_FALSE(a.empty());
    EXPECT_EQ(a, b) << "resume 后再 suspend 状态不一致";

    // 主 context 正常
    ASSERT_TRUE(host_value(h, "21 * 2", &out));
    EXPECT_NE(std::string::npos, out.find("42")) << "got: " << out;

    host_destroy(h);
    remove(TEST_DIR "/state_slot.bin");
    remove(TEST_DIR "/state_slot3.bin");
}

// G1 回归（设计 §8.2 suspend_then_double_suspend）：suspend 即销毁 ctx，同 id
// 第二次 suspend 必须报 NOT_FOUND（TypeError），失败路径不写半成品文件，主
// context 不受影响。
TEST(qz_suspend_, suspend_then_double_suspend) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);
    std::string out;

    ASSERT_TRUE(host_value(h,
        "JSON.stringify(qzContext.spawn(\"globalThis.a = 1\"))", &out));
    ASSERT_EQ("1", out);

    ASSERT_TRUE(host_eval(h,
        "qzContext.suspend(1, '" TEST_DIR "/state_dbl.bin'); 'ok'", &out));
    ASSERT_NE(std::string::npos, out.find("ok")) << "got: " << out;

    // 第二次 suspend：槽位已空（G1 销毁）→ NOT_FOUND → TypeError
    ASSERT_TRUE(host_value(h,
        "var thrown = '';\n"
        "try { qzContext.suspend(1, '" TEST_DIR "/state_dbl2.bin'); }"
        "catch (e) { thrown = e.name; }\n"
        "thrown", &out));
    EXPECT_NE(std::string::npos, out.find("Error")) << "got: " << out;
    EXPECT_FALSE(host_read_file(TEST_DIR "/state_dbl2.bin", &out))
        << "第二次 suspend 失败却写了文件";

    ASSERT_TRUE(host_value(h, "2 + 2", &out));
    EXPECT_NE(std::string::npos, out.find("4")) << "got: " << out;
    host_destroy(h);
    remove(TEST_DIR "/state_dbl.bin");
}
