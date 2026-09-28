// test_context_worker_composition_gtest.cpp — M-R2 多 RT 组合模型（§14）
//
// 单个 qz_t 内两个正交组合原语并存：
//   context — context.c，同一 JSRuntime 堆内多 JSContext（rt->contexts[]）
//   worker  — rt->workers[] 槽位表 + 独立消息循环执行域
//
// 本套件只测**组合语义**（单轴用例见 test_context_gtest.cpp /
// test_suspend_gtest.cpp / test_worker_gtest.cpp）。规范 SSOT：
// docs/archive/plans/2026-09-04-multi-process-model.md
//
//   14.1 两个正交组合原语：context 与 worker 各自挂 rt（不是 worker 挂 ctx）
//   14.2 正交铁则：worker 归属 rt 不归属 context——同一 rt 的所有 context 共享
//        同一 workers 表；context 挂起/销毁不波及 worker（其入队消息照常派发），
//        worker 生命周期只随 rt；宿主只见主 context
//   14.3 验证门：ctx suspend/resume 与 worker postMessage 交错无死锁；ctx
//        destroy 后 worker 消息照常派发；整树 destroy（rt → workers terminate →
//        contexts 回收）一次干净
//
// worker 后端：THREAD（mock 构建唯一可达后端，bridge.c pal.workerBackend 在
// QZ_USE_MOCK_LIBUV 下恒 'thread'）。PROCESS 后端同场景回归见
// test/test_mr2_composition_e2e.sh（真实进程，QZ_WORKER_BACKEND=process）。
#include "test_host.h"
#include <string>
#include <cstdio>
#include <cstdlib>


/* IN_PROC 控制面宿主：metrics 回执的 ctx_count / worker_count 是「contexts ×N
 * 与 workers ×N 平级挂在同一 rt」的公开可观测入口（§14.1 两张表）。 */
static HostCtx *host_create_ctl_plane(int plane) {
    auto *h = new HostCtx();
    qz_config_t cfg = {};
    cfg.initial_script = kTestBootstrap;
    cfg.control_plane = plane;
    h->rt = qz_create(&cfg);
    if (!h->rt) {
        delete h;
        return nullptr;
    }
    return h;
}

/* metrics 回执里的整数字段（扁平 JSON，形如 "worker_count":2）；失败 -1。 */
static int metrics_int(HostCtx *h, const char *correl, const char *field) {
    char cmd[128];
    snprintf(cmd, sizeof cmd, "{\"op\":\"metrics\",\"correl\":\"%s\"}", correl);
    if (host_control(h, cmd) != 0) return -1;
    std::string out;
    if (!host_wait_ctl(h, correl, &out)) return -1;
    std::string key = std::string("\"") + field + "\":";
    size_t p = out.find(key);
    if (p == std::string::npos) return -1;
    return atoi(out.c_str() + p + key.size());
}

/* 主 context 里建一个 echo worker 并挂 onmessage：回显原样经宿主 message_cb
 * 出站。tag >= 0 时回显包装成 {w:tag, v:data}，供多 worker 并存时分辨来源。 */
static std::string worker_setup(const char *var, int tag) {
    std::string s = std::string("globalThis.") + var +
                    " = new Worker('file://" TEST_DIR "/worker_echo.js');\n";
    s += std::string("globalThis.") + var + ".onmessage = function (e) { postMessage(";
    if (tag < 0) {
        s += "e.data";
    } else {
        s += "{w: " + std::to_string(tag) + ", v: e.data}";
    }
    s += "); };\n";
    return s;
}


/* ── 1. §14.1/§14.2：contexts ×2 与 workers ×2 正交并存 ──
 * 两个组合原语各自成域：子 context 全局互不可见、不外泄到主 context；两个
 * worker 各自消息域不串；rt 级两张表同时记账（ctx_count=3 / worker_count=2）。 */
TEST(composition_, contexts_and_workers_coexist_orthogonally) {
    HostCtx *h = host_create_ctl_plane(QZ_CONTROL_IN_PROC);
    ASSERT_NE(nullptr, h);
    std::string out;

    /* 2 个子 context（同一 JSRuntime 堆内、各自全局） */
    ASSERT_TRUE(host_value(h,
        "JSON.stringify([qzContext.spawn('globalThis.tag = \"c1\";'),"
        " qzContext.spawn('globalThis.tag = \"c2\";')])", &out));
    EXPECT_EQ("[1,2]", out) << out;

    /* 2 个 worker（各自独立消息循环执行域），带上源标记回显 */
    std::string setup = worker_setup("w1", 1) + worker_setup("w2", 2) +
                        "w1.postMessage('one-a'); w2.postMessage('two-b'); 'posted'";
    ASSERT_TRUE(host_eval(h, setup.c_str(), &out));
    EXPECT_NE(std::string::npos, out.find("posted")) << out;

    bool seen1 = false, seen2 = false;
    for (int i = 0; i < 2; i++) {
        ASSERT_TRUE(host_wait_msg(h, &out)) << "worker echo #" << i + 1;
        if (out.find("\"w\":1") != std::string::npos) {
            EXPECT_NE(std::string::npos, out.find("one-a")) << out;
            seen1 = true;
        } else if (out.find("\"w\":2") != std::string::npos) {
            EXPECT_NE(std::string::npos, out.find("two-b")) << out;
            seen2 = true;
        } else {
            FAIL() << "unexpected message: " << out;
        }
    }
    EXPECT_TRUE(seen1) << "worker 1 未回显";
    EXPECT_TRUE(seen2) << "worker 2 未回显";

    /* 宿主只见主 context：子 context 的全局不外泄（§14.2） */
    ASSERT_TRUE(host_value(h, "typeof globalThis.tag", &out));
    EXPECT_EQ("undefined", out) << out;

    /* 两轴同时在 rt 上记账（平级，非嵌套） */
    EXPECT_EQ(3, metrics_int(h, "c1", "ctx_count"));
    EXPECT_EQ(2, metrics_int(h, "c1w", "worker_count"));

    host_destroy(h);   /* 2 ctx + 2 worker 在场时整树销毁 */
}

/* ── 2. §14.2：子 context 挂起/恢复不波及 worker ──
 * 挂起 = ctx 槽位消失（状态落盘），恢复 = 原槽位重建。worker 生命周期只随 rt：
 * 期间照常收发；恢复后 ctx 状态正确（字节级），与 worker 消息互不影响。 */
TEST(composition_, ctx_suspend_resume_leaves_workers_untouched) {
    HostCtx *h = host_create_ctl_plane(QZ_CONTROL_IN_PROC);
    ASSERT_NE(nullptr, h);
    std::string out;
    const char *state_a = TEST_DIR "/state_mr2_a.bin";
    const char *state_b = TEST_DIR "/state_mr2_b.bin";
    remove(state_a);
    remove(state_b);

    std::string setup = worker_setup("w", -1) +
                        "qzContext.spawn('globalThis.keep = 41;'); 'ok'";
    ASSERT_TRUE(host_eval(h, setup.c_str(), &out));
    EXPECT_EQ(2, metrics_int(h, "m1", "ctx_count"));
    EXPECT_EQ(1, metrics_int(h, "m1w", "worker_count"));

    /* 基线往返 */
    ASSERT_TRUE(host_eval(h, "w.postMessage('before'); 'p'", &out));
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("before")) << out;

    /* 挂起子 context：槽位消失，worker 槽位不受影响 */
    std::string suspend_a = "qzContext.suspend(1, '" + std::string(state_a) + "'); 'ok'";
    ASSERT_TRUE(host_eval(h, suspend_a.c_str(), &out));
    EXPECT_NE(std::string::npos, out.find("ok")) << out;
    EXPECT_EQ(1, metrics_int(h, "m2", "ctx_count"));
    EXPECT_EQ(1, metrics_int(h, "m2w", "worker_count")) << "ctx 挂起波及了 worker";

    /* 挂起期间 worker 照常收发 */
    ASSERT_TRUE(host_eval(h, "w.postMessage('during'); 'p'", &out));
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("during")) << out;

    /* 恢复：状态完全来自盘（空 init 脚本） */
    std::string resume = "JSON.stringify(qzContext.resume(1, '', '" +
                         std::string(state_a) + "'))";
    ASSERT_TRUE(host_value(h, resume.c_str(), &out));
    EXPECT_EQ("1", out) << out;
    EXPECT_EQ(2, metrics_int(h, "m3", "ctx_count"));

    /* 恢复后 worker 照常 */
    ASSERT_TRUE(host_eval(h, "w.postMessage('after'); 'p'", &out));
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("after")) << out;

    /* 恢复后 ctx 状态正确：再次挂起 → 两次捕获字节一致（worker 收发不留痕） */
    std::string suspend_b = "qzContext.suspend(1, '" + std::string(state_b) + "'); 'ok'";
    ASSERT_TRUE(host_eval(h, suspend_b.c_str(), &out));
    EXPECT_NE(std::string::npos, out.find("ok")) << out;
    std::string a, b;
    ASSERT_TRUE(host_read_file(state_a, &a));
    ASSERT_TRUE(host_read_file(state_b, &b));
    EXPECT_FALSE(a.empty());
    EXPECT_EQ(a, b) << "挂起/恢复穿越 worker 消息后 ctx 状态不一致";

    remove(state_a);
    remove(state_b);
    host_destroy(h);
}

/* ── 3. §14.3：ctx destroy 后 worker 消息照常派发 ──
 * 子 context 销毁不触及 rt 级 workers 表；worker 早已入队的消息继续派发到
 * 主 context（宿主可见面），主 context 本身也照常工作。 */
TEST(composition_, ctx_destroy_leaves_workers_dispatching) {
    HostCtx *h = host_create_ctl_plane(QZ_CONTROL_IN_PROC);
    ASSERT_NE(nullptr, h);
    std::string out;

    ASSERT_TRUE(host_eval(h, worker_setup("w", -1).c_str(), &out));
    ASSERT_TRUE(host_value(h,
        "JSON.stringify(qzContext.spawn('globalThis.gone = 1;'))", &out));
    EXPECT_EQ("1", out) << out;
    EXPECT_EQ(2, metrics_int(h, "m1", "ctx_count"));
    EXPECT_EQ(1, metrics_int(h, "m1w", "worker_count"));

    ASSERT_TRUE(host_value(h, "qzContext.destroy(1); 'ok'", &out));
    EXPECT_EQ(1, metrics_int(h, "m2", "ctx_count"));
    EXPECT_EQ(1, metrics_int(h, "m2w", "worker_count")) << "ctx 销毁波及了 worker";

    /* 消息在销毁后照常派发（入队 → 回显 → 宿主） */
    ASSERT_TRUE(host_eval(h, "w.postMessage('after-destroy'); 'p'", &out));
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("after-destroy")) << out;

    ASSERT_TRUE(host_value(h, "2 + 3", &out));
    EXPECT_EQ("5", out) << out;

    host_destroy(h);
}

/* ── 4. §14.3：ctx suspend/resume 与 worker postMessage 交错无死锁 ──
 * 同一 eval 内交错：postMessage('seq-1') → suspend → postMessage('seq-2') →
 * resume → postMessage('seq-3')。eval 能返回即无死锁；worker 侧 FIFO 保序
 * （三条回显顺序 = 发送顺序），ctx 状态在交错后仍字节级可复现。 */
TEST(composition_, interleaved_postmessage_across_suspend_resume) {
    HostCtx *h = host_create_ctl_plane(QZ_CONTROL_IN_PROC);
    ASSERT_NE(nullptr, h);
    std::string out;
    const char *state_a = TEST_DIR "/state_mr2_i1.bin";
    const char *state_b = TEST_DIR "/state_mr2_i2.bin";
    remove(state_a);
    remove(state_b);

    std::string code = worker_setup("w", -1);
    code += "qzContext.spawn('globalThis.n = 7;');\n";
    code += "w.postMessage('seq-1');\n";
    code += "qzContext.suspend(1, '" + std::string(state_a) + "');\n";
    code += "w.postMessage('seq-2');\n";
    code += "qzContext.resume(1, '', '" + std::string(state_a) + "');\n";
    code += "w.postMessage('seq-3');\n";
    code += "'interleaved'";
    /* 交错完成即返回：挂住（死锁）会让本 eval 超时失败 */
    ASSERT_TRUE(host_eval(h, code.c_str(), &out, 30000));
    EXPECT_NE(std::string::npos, out.find("interleaved")) << out;

    const char *want[3] = {"seq-1", "seq-2", "seq-3"};
    for (int i = 0; i < 3; i++) {
        ASSERT_TRUE(host_wait_msg(h, &out)) << "echo #" << i + 1;
        EXPECT_NE(std::string::npos, out.find(want[i]))
            << "worker 消息 FIFO 被打乱（期望 " << want[i] << "）：" << out;
    }

    EXPECT_EQ(2, metrics_int(h, "m1", "ctx_count"));
    EXPECT_EQ(1, metrics_int(h, "m1w", "worker_count"));

    /* 交错后 ctx 状态仍正确 */
    std::string suspend_b = "qzContext.suspend(1, '" + std::string(state_b) + "'); 'ok'";
    ASSERT_TRUE(host_eval(h, suspend_b.c_str(), &out));
    EXPECT_NE(std::string::npos, out.find("ok")) << out;
    std::string a, b;
    ASSERT_TRUE(host_read_file(state_a, &a));
    ASSERT_TRUE(host_read_file(state_b, &b));
    EXPECT_FALSE(a.empty());
    EXPECT_EQ(a, b) << "交错挂起/恢复后 ctx 状态不一致";

    remove(state_a);
    remove(state_b);
    host_destroy(h);
}

/* ── 5. §14.2：子 context 里建的 worker 归 rt 不归 ctx ──
 * worker 落 rt 级同一张表：建它的子 context 销毁后槽位仍在（生命周期只随 rt），
 * 主 context 后续建的 worker 与之共用同一张表（计数并列相加）。 */
TEST(composition_, worker_spawned_in_child_ctx_is_rt_owned) {
    HostCtx *h = host_create_ctl_plane(QZ_CONTROL_IN_PROC);
    ASSERT_NE(nullptr, h);
    std::string out;

    /* 子 context 的 init 脚本里建 worker（宿主不见该 ctx，只见主 context） */
    std::string spawn = "JSON.stringify(qzContext.spawn(" +
        JSON_string("globalThis.wc = new Worker('file://" TEST_DIR "/worker_idle.js');") +
        "))";
    ASSERT_TRUE(host_value(h, spawn.c_str(), &out));
    EXPECT_EQ("1", out) << out;
    EXPECT_EQ(2, metrics_int(h, "m1", "ctx_count"));
    EXPECT_EQ(1, metrics_int(h, "m1w", "worker_count"));

    /* 销毁建它的子 context：worker 槽位仍在（不同轴，不回滚） */
    ASSERT_TRUE(host_value(h, "qzContext.destroy(1); 'ok'", &out));
    EXPECT_EQ(1, metrics_int(h, "m2", "ctx_count"));
    EXPECT_EQ(1, metrics_int(h, "m2w", "worker_count"))
        << "子 context 销毁回收了 rt 级 worker 槽位";

    /* 主 context 再建一个 worker：同一张 rt 级表，计数并列 */
    ASSERT_TRUE(host_eval(h, worker_setup("w2", -1).c_str(), &out));
    EXPECT_EQ(2, metrics_int(h, "m3", "worker_count"));
    ASSERT_TRUE(host_eval(h, "w2.postMessage('shared-table'); 'p'", &out));
    ASSERT_TRUE(host_wait_msg(h, &out));
    EXPECT_NE(std::string::npos, out.find("shared-table")) << out;

    /* 子 context 建的 worker 已无人引用 —— 整树销毁负责回收（test 6 细查） */
    host_destroy(h);
}

/* ── 6. §14.3：整树 destroy（rt → workers terminate → contexts 回收）一次干净 ──
 * 2 context + 2 活跃 worker（且销毁时仍有在途消息）→ destroy 不挂死、销毁前
 * workers 确实在场（rt 级记账）、销毁后同一进程能重建完整组合树。worker 执行域
 * 随 rt destroy 回收的硬证据由 ASAN CI（detect_leaks=1）在进程退出给出——本测
 * 只做进程内确定性观测（线程计数受库层懒创建线程干扰、不稳，不在此断言）。 */
TEST(composition_, tree_destroy_with_live_workers_is_clean) {
    std::string out;

    long long t0 = mono_ms();
    {
        HostCtx *h = host_create_ctl_plane(QZ_CONTROL_IN_PROC);
        ASSERT_NE(nullptr, h);

        ASSERT_TRUE(host_value(h,
            "JSON.stringify([qzContext.spawn('globalThis.a = 1;'),"
            " qzContext.spawn('globalThis.b = 2;')])", &out));
        EXPECT_EQ("[1,2]", out) << out;
        ASSERT_TRUE(host_eval(h,
            (worker_setup("w1", -1) + worker_setup("w2", -1)).c_str(), &out));
        EXPECT_EQ(3, metrics_int(h, "m1", "ctx_count"));
        EXPECT_EQ(2, metrics_int(h, "m1w", "worker_count"));

        /* 销毁时有消息在途：两条发出，只等一条，另一条留在队列里 */
        ASSERT_TRUE(host_eval(h, "w1.postMessage('fly-1'); w2.postMessage('fly-2'); 'p'", &out));
        ASSERT_TRUE(host_wait_msg(h, &out));

        host_destroy(h);
    }
    long long dt = mono_ms() - t0;
    EXPECT_LT(dt, 10000) << "整树 destroy 耗时 " << dt << "ms（疑似挂死）";

    /* 组合树销毁后，同一进程能重建完整组合树（无残留全局状态卡住第二个实例） */
    HostCtx *h2 = host_create();
    ASSERT_NE(nullptr, h2);
    ASSERT_TRUE(host_eval(h2, worker_setup("w", -1).c_str(), &out));
    ASSERT_TRUE(host_eval(h2, "w.postMessage('reborn'); 'p'", &out));
    ASSERT_TRUE(host_wait_msg(h2, &out));
    EXPECT_NE(std::string::npos, out.find("reborn")) << out;
    host_destroy(h2);
}
