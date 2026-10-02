// test_control_gtest.cpp — CTL-0 控制面进程内基线测试
// 验证 qz_control / qz_control_dispatch 的核心契约：
// eval/inspect/metrics 操作、异常处理、OFF 档拒绝、未知 op、超时回收。
#include "test_host.h"

#include <atomic>
#include <cstring>
#include <thread>

// 启用控制面的 host 工厂（control_plane=IN_PROC）。
// 与 host_create 相同，但 cfg.control_plane = QZ_CONTROL_IN_PROC。
static HostCtx *host_create_ctl() {
    auto *h = new HostCtx();
    qz_config_t cfg;
    qz_config_init(&cfg);
    cfg.initial_script = kTestBootstrap;
    cfg.control_plane = QZ_CONTROL_IN_PROC;
    h->rt = qz_create(&cfg);
    if (!h->rt) { delete h; return nullptr; }
    return h;
}

// 带自定义 initial_script 的 control 档运行时（interrupt 效果那组要忙等脚本）
static HostCtx *host_create_ctl_with_script(const char *script) {
    auto *h = new HostCtx();
    qz_config_t cfg;
    qz_config_init(&cfg);
    cfg.initial_script = script;
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

// 6b. 保留命名空间拒收：顶层带数字 "qzjs" 的用户命令在入口就被拒（-1），
// 不入队。没有这道守卫时它会被 rt_main 判成系统级 CONTROL 就地消费——
// 命令静默消失，没有回执、没有错误，调用方永远等不到 correl。
TEST(control_, reserved_qzjs_namespace_rejected) {
    HostCtx *h = host_create_ctl();
    ASSERT_NE(nullptr, h);
    EXPECT_EQ(-1, host_control(h, R"({"op":"eval","correl":"c6b","qzjs":1,"code":"1+1"})"));
    EXPECT_EQ(-1, host_control(h, R"({"op":"eval","correl":"c6c","qzjs":1})"));
    // 拒收 = 未入队 ⇒ 没有回执可等；且不影响后续正常命令（同 correl 也安全，
    // 因为 ctl_unregister 在 push 失败路径上已清干净）。
    EXPECT_EQ(0, host_control(h, ctl_eval_json("c6d", "6*7")));
    std::string out;
    ASSERT_TRUE(host_wait_ctl(h, "c6d", &out)) << out;
    EXPECT_NE(std::string::npos, out.find("\"result\":42")) << out;
    host_destroy(h);
}

// 6c. qzjs 键非数字时不属保留命名空间，仍按用户命令受理（判据是「数字」，
// 不是「有这个键」——否则正常命令里带个字符串字段就被误拒）。
TEST(control_, non_numeric_qzjs_key_still_accepted) {
    HostCtx *h = host_create_ctl();
    ASSERT_NE(nullptr, h);
    std::string cmd = std::string(R"({"op":"eval","correl":"c6e","qzjs":"x","script":)") +
                      JSON_string("1+2") + "}";
    EXPECT_EQ(0, host_control(h, cmd));
    std::string out;
    ASSERT_TRUE(host_wait_ctl(h, "c6e", &out)) << out;
    EXPECT_NE(std::string::npos, out.find("\"result\":3")) << out;
    host_destroy(h);
}

// 6d. correl 必填：回执异步入邮箱，唯一配对依据是 correl。缺 correl 时若照收，
// 会往宿主邮箱投一条 correl="" 的回执——对不上是哪条命令、也没法丢弃，只能
// 等超时回收。入口拒收（-1）而不是产出配不上的输出。
TEST(control_, missing_correl_rejected) {
    HostCtx *h = host_create_ctl();
    ASSERT_NE(nullptr, h);
    EXPECT_EQ(-1, host_control(h, R"({"op":"metrics"})"));
    EXPECT_EQ(-1, host_control(h, R"({"op":"metrics","correl":""})"));
    EXPECT_EQ(-1, host_control(h, R"({"op":"metrics","correl":123})"));  // 非字符串
    // 拒收不得留下「邮箱里多出一条 correl="" 回执」这类残渣：后续正常命令的
    // 配对与内容必须不受影响。
    EXPECT_EQ(0, host_control(h, ctl_eval_json("c6f", "1+1")));
    std::string out;
    ASSERT_TRUE(host_wait_ctl(h, "c6f", &out)) << out;
    EXPECT_EQ(std::string::npos, out.find("\"correl\":\"\"")) << out;
    EXPECT_NE(std::string::npos, out.find("\"correl\":\"c6f\"")) << out;
    host_destroy(h);
}

// 6e. **内部**返回码与判据顺序也必须被锁住，否则「两处必须同步」只是一句注释。
//
// 公共 qz_control 把非 0 一律归一化成 -1（那是公共契约，按 == -1 判断的宿主不能
// 突然看到 -2/-3），所以两种拒收的区别在公共面上看不见。端点却要靠这个区别回不同
// 的帧，于是它只能活在内部——而内部此前没有任何断言，全仓 grep 不到一处。
// 早先两个入口的判据**顺序还相反**：同一份字节（既没 correl 又用了保留键）在 sink
// 被报成「保留命名空间」、在端点被报成「缺 correl」。
static const char kBothOffenses[] =
    R"({"op":"eval","qzjs":1,"script":"1+1"})";

TEST(control_, internal_codes_distinguish_rejections) {
    HostCtx *h = host_create_ctl();
    ASSERT_NE(nullptr, h);
    // 内部 sink：两种拒收必须给出**不同**的码，端点据此回不同的帧。
    // 长度一律用 strlen，**不要手写字面量**：写错了就是一次读越界，而 ASAN 报的是
    // "global-buffer-overflow in __interceptor_memcpy"——离「长度算错」很远。第一版
    // 这里就把 16 字符的 {"op":"metrics"} 写成了 20，被 ASAN 当场抓住。这与本轮修的
    // qz_post_message 长度字面量 26（应 29）是同一类。
    static const char kNoCorrel[] = R"({"op":"metrics"})";
    static const char kReserved[] = R"({"op":"eval","correl":"z1","qzjs":1})";
    EXPECT_EQ(-2, qz_control_sink(h->rt, kNoCorrel, strlen(kNoCorrel), NULL));
    EXPECT_EQ(-3, qz_control_sink(h->rt, kReserved, strlen(kReserved), NULL));
    // 公共面：两种拒收都是 -1（公共契约不许外泄内部码）。
    EXPECT_EQ(-1, host_control(h, R"({"op":"metrics"})"));
    host_destroy(h);
}

TEST(control_, both_entries_agree_on_verdict_order) {
    HostCtx *h = host_create_ctl();
    ASSERT_NE(nullptr, h);
    const size_t n = strlen(kBothOffenses);
    // 端点入口头一句就要求 control_plane == QZ_CONTROL_LOCAL，而这个 harness 建的是
    // IN_PROC 档，不改的话它会先返回 -1、根本走不到判据，比出来的只是「档位不对」。
    // 这里只需要函数通过那道门（不需要真的 listen），所以直接改字段即可。
    h->rt->config.control_plane = QZ_CONTROL_LOCAL;
    // 同一份字节，两个入口必须给出同一个码。判据共用（ctl_check_accept）之后
    // 这条恒成立；它是「顺序也必须共用」的回归锁——早先两个入口顺序相反，
    // 这份字节会得到 -3 与 -2 两个不同的答案。
    EXPECT_EQ(qz_control_sink(h->rt, kBothOffenses, n, NULL),
              qz_control_endpoint_cmd(h->rt, kBothOffenses, n, NULL, NULL));
    // 公共面同样只给 -1。
    EXPECT_EQ(-1, host_control(h, kBothOffenses));
    host_destroy(h);
}

// 6f. interrupt 不带 correl：**必须不产任何回执**，一个都不能。
//
// 「correl 必填」这道守卫存在的全部理由就是：缺 correl 时若照收，会往宿主邮箱投一条
// correl="" 的回执——对不上是哪条命令、也没法丢弃，只能等超时回收。
//
// interrupt 是唯一不依赖回执配对的命令（效果 = 原子标志，投递即生效），所以守卫对它
// 豁免。但**豁免不等于放行到底**：早先我只把守卫挪到标志置位之后，interrupt 于是继续
// 往下走到 qz_ctl_register(rt, NULL, …)（登记一个 strdup("") 的空键条目）并入队；
// dispatch 的 interrupt 分支里 ctl_claim(rt, NULL) 第一行就是 `if (!correl) return 1`
// （压根不查表），照样产出一条 correl="" 的回执。守卫被绕过的同时，守卫要防的东西
// 原样回来了。正确形态是「置位之后立刻收手」：不登记、不入队、不产回执。
//
// 这条断言只能走**公共 qz_control**（= sink 入口）：端点那条路经 ctl_local_command，
// 它一直是对的，所以 test/probe_ctl_reject_frames.c 第 4 项抓不到这个回归（实测：撤掉
// 修复，探针全绿）。而且必须用原始 qz_recv_message 排干——host_wait_ctl 那个 eval
// 配对 shim 会先把 correl="" 的孤儿丢掉。负控实测：撤掉修复后本测试报 orphan=true。
TEST(control_, interrupt_without_correl_emits_no_orphan_receipt) {
    HostCtx *h = host_create_ctl();
    ASSERT_NE(nullptr, h);

    static const char kInt[] = R"({"op":"interrupt"})";
    // 不得被拒（那是对公共 API 的静默破坏：interrupt 恰恰最不该被 correl 缺失拖住）。
    EXPECT_EQ(0, host_control(h, kInt));

    // 必须用**原始排干**看邮箱，不能用 host_wait_ctl：那个 shim 带 eval 配对语义，
    // 只放行匹配所等 correl 的帧，correl="" 的孤儿在到达断言前就被它丢掉了。
    // 踩过这个坑——第一版断言写在 host_wait_ctl 的结果里，负控（撤掉修复）下它照样绿。
    bool orphan = false;
    for (int round = 0; round < 4 && !orphan; round++) {
        char *json = nullptr;
        size_t len = 0;
        if (qz_recv_message(h->rt, &json, &len, round == 0 ? 600 : 200) != 0)
            continue;
        std::string f(json, len);
        qz_free_message(json);
        if (f.find("\"correl\":\"\"") != std::string::npos) orphan = true;
    }
    EXPECT_FALSE(orphan)
        << "interrupt 无 correl 产出了 correl=\"\" 的孤儿回执"
           "（对不上是哪条命令、丢不掉，只能等超时回收）";

    // 顺带确认运行时没被 interrupt 搞坏：正常命令照常回执。
    EXPECT_EQ(0, host_control(h, ctl_eval_json("k1", "1+1")));
    std::string out;
    ASSERT_TRUE(host_wait_ctl(h, "k1", &out)) << out;
    EXPECT_NE(std::string::npos, out.find("\"result\":2")) << out;
    host_destroy(h);
}

static int64_t now_ms() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void nap_ms(int ms) {
    struct timespec ts = { ms / 1000, (long)(ms % 1000) * 1000000L };
    nanosleep(&ts, nullptr);
}

// 6g. 单消费者契约是**承重墙**，必须有运行时判据。
//
// qz_out_pop 的 head 是**非原子**读写的，注释写着「consumer owns head, so no
// lock is needed」——这在单消费者前提下成立。两个线程并发弹出时：两者读到同一
// 个 head、各自 free(head) 同一个节点（double free），并各自返回同一个 next
// → 同一条消息投递两次、另一条静默丢失。而头注释里早就把这条危险写清楚了，
// 库却**没有任何东西会拦住违反它的人**——静默的内存破坏。
//
// 判据刻意做成 per-call（进抢出放）而不是永久归属：契约的措辞是「**同一时刻**
// 只允许一个线程」，永久归属会把「A 排干完、顺序交给 B」也判成违规。所以这条
// 同时锁两半：并发时必须被拒绝，**顺序移交必须仍然可用**。
TEST(control_, mailbox_single_consumer_is_enforced) {
    HostCtx *h = host_create_ctl();
    ASSERT_NE(nullptr, h);
    // 先把启动期可能产生的帧排干净，保证下面那个阻塞调用真的会阻塞。
    host_fill(h, 300);

    // 线程 A 持锁阻塞（邮箱空 + 长 timeout）。
    std::atomic<bool> a_in{false};
    std::thread a([&] {
        a_in.store(true, std::memory_order_release);
        char *j = nullptr;
        size_t l = 0;
        qz_recv_message(h->rt, &j, &l, 5000);   // 会阻塞 5s
        if (j) qz_free_message(j);
    });
    for (int i = 0; i < 200 && !a_in.load(std::memory_order_acquire); i++)
        nap_ms(10);

    // B 在 A 阻塞期间调用：必须拿到 -1，而不是并发弹队列。
    bool refused = false;
    for (int i = 0; i < 200 && !refused; i++) {
        char *j = nullptr;
        size_t l = 0;
        int r = qz_recv_message(h->rt, &j, &l, 0);
        if (j) qz_free_message(j);
        if (r < 0) refused = true;
        if (!refused) nap_ms(10);
    }
    EXPECT_TRUE(refused)
        << "已有线程在消费时，第二个线程的 qz_recv_message 必须被拒绝（-1）；"
           "放行就是并发弹一个 lock-free MPSC 队列 → double free";

    a.join();

    // 顺序移交仍然合法：A 退出后 B 一定能拿到「正常结果」（邮箱空 → 1 超时，
    // 而不是 -1）。这条锁住 per-call 而非永久归属那个选择。
    {
        char *j = nullptr;
        size_t l = 0;
        int r = qz_recv_message(h->rt, &j, &l, 0);
        if (j) qz_free_message(j);
        EXPECT_GE(r, 0) << "A 退出后消费权应已交还（顺序移交必须可用）: r=" << r;
    }
    host_destroy(h);
}

// 6h. interrupt 的**效果**（而不只是它的回执）。
//
// 此前唯一的 interrupt 覆盖是 test_ctl_e2e.sh 那条「回执里有没有
// `"interrupted":true`」——而那张回执是 dispatch 路径**无条件**产出的，与引擎有没有
// 真的被打断毫无关系。也就是说：中断处理器从没装上、或者标志读错、或者 JS 侧根本
// 没检查它，现有全部测试照样绿。而 §3.9「投递即生效」的实质正是引擎指令边界上的
// 那个处理器把长任务掐掉。
//
// 判据用**对照组**，否则「没收到 done」什么都不能证明（可能脚本自己报错了）：
//   · 对照组：不发 interrupt → 忙等 3s 的脚本**必须**跑完并回 done（证明脚本本身能跑完）
//   · 实验组：发 interrupt  → 同样的脚本在 1.5s 内**不该**出现 done（证明被打断）
// 忙等而不是 sleep：sleep 会主动让出，标志只在指令边界被检查，测不到那件事。
//
// interrupt 走**不带 correl** 的路径，因为本轮刚把这条改成「照收 + 不登记不���队」，
// 它必须仍然生效——这正是最容易被「顺手加个 correl 守卫」改坏的地方。
static const char kBusyScript[] =
    "onmessage = function (e) {\n"
    "  var t = Date.now(), x = 0;\n"
    "  while (Date.now() - t < 3000) { x++; }\n"     /* 忙等 3s，不释放 */
    "  postMessage('done:' + x);\n"
    "};\n";

/* 长度一律 strlen：手写字面量已经栽过一次（把 8 字符的 {"go":1} 写成 9，多读一个字节
 * 让 JSON 非法、消息根本没被处理，对照组于是假红）。 */
static void post_go(qz_t *rt) {
    static const char kGo[] = "{\"go\":1}";
    qz_post_message(rt, kGo, strlen(kGo));
}

/* 只等，不发。**发与等必须分开**：第一版把它们合在一个 helper 里，而实验组需要在
 * 发完、等 interrupt 送达之后再开始等——于是实验组把消息发了两次，第二次在标志被
 * 消费之后跑满 3s 正常产出 done，测试误报「interrupt 没打断」。 */
static bool wait_done(qz_t *rt, int budget_ms) {
    int64_t deadline = now_ms() + budget_ms;
    for (;;) {
        int wait = (int)(deadline - now_ms());
        if (wait <= 0) break;
        char *json = nullptr;
        size_t len = 0;
        if (qz_recv_message(rt, &json, &len, wait) != 0) break;
        bool done = strstr(json, "done:") != nullptr;
        qz_free_message(json);
        if (done) return true;
    }
    return false;
}

// ⚠ DISABLED_ 而不是删掉：覆盖已经写好，被一个**既存缺陷**挡住，理由与复现见下。
// 删掉等于把「interrupt 的效果从未被验证过」这件事重新藏起来，而那正是本轮要补的洞。
// 启用前必须先修掉那个缺陷，否则 asan / ubsan 两个 job 会一直红——一个常红的门等于没有门。
//
// 【既存缺陷】打断正在执行的脚本会留下**有根**的 JS 对象，于是销毁该运行时会在
// quickjs 的断言上终止：
//     quickjs.c:2762: JS_FreeRuntime: Assertion `list_empty(&rt->gc_obj_list)' failed
// 机制：`qz_ctl_interrupt_handler` 返回 1 → quickjs 抛一个 **uncatchable** 的
// InternalError 并 longjmp 展开，展开点上的解释器临时值就此无人回收。本项目已经知道
// 这一类问题（qzjs.c 的拆除里专门有一步「排空 pending JS jobs BEFORE freeing
// contexts/runtime」，理由写的就是这个断言），但打断这种情况它救不回来。
// 影响面：任何带断言的构建（所有 Debug 构建，含 asan / ubsan 两个 CI job）里，
// 对**被打断过**的运行时调 qz_destroy 会 abort；NDEBUG 构建里断言被编掉，那批对象
// 静默泄漏——所以这不是「只在测试里出现」的问题。
// 最小复现（不依赖本 gtest）：建一个 onmessage 里 `while (Date.now()-t<3000){x++;}`
// 的运行时 → postMessage → 150ms 后发 `{"op":"interrupt"}`（不带 correl）→
// 等邮箱排干 → qz_destroy，就在此断言。对照：不发 interrupt 时同一脚本销毁干净，
// 所以与脚本本身无关。
// 归属：打断的展开语义在 vendored quickjs-ng；打断后的**销毁**泄漏由
// deps/quickjs-ng-teardown-sweep.patch 修掉（残留 GC 对象带 GC 不可见的外部引用，
// refcount>0 留在 gc_obj_list，逃过 gc_free_cycles，其 arena 内存泄漏）。
// 该 patch 落地前本测试是 DISABLED_：host_destroy 命中 JS_FreeRuntime 的
// gc_obj_list 断言（Debug 下 abort / Release 下静默泄漏 158KB/次）。
// 现在转正为常规门禁，防该泄漏回归。
TEST(control_, interrupt_actually_aborts_running_script) {
    /* 预算必须**大于**脚本的自然耗时（3s 忙等），否则「没收到 done」既可能是被打断、
     * 也可能只是还没跑完——第一版把实验组预算设成 1500ms < 3000ms，负控（摘掉中断
     * 处理器）因此照样绿。同一个预算、两个相反的结论，没有刀锋时刻。 */
    const int kBudget = 5000;
    // 对照组：没有 interrupt，同一预算内脚本**必须**跑完 —— 它同时钉住了「自然耗时
    // 落在预算之内」这件事，实验组的「始终不出现 done」才有意义。
    {
        HostCtx *h = host_create_ctl_with_script(kBusyScript);
        ASSERT_NE(nullptr, h);
        post_go(h->rt);
        EXPECT_TRUE(wait_done(h->rt, kBudget))
            << "对照组：3s 忙等脚本在同一预算内没跑完 —— 实验组判据失去意义"
               "（要么脚本坏了，要么预算不够）";
        host_destroy(h);
    }
    // 实验组：发 interrupt（不带 correl），同一预算内 done **始终**不出现
    {
        HostCtx *h = host_create_ctl_with_script(kBusyScript);
        ASSERT_NE(nullptr, h);
        post_go(h->rt);
        nap_ms(150);                      /* 让 JS 线程真的进循环 */
        static const char kInt[] = R"({"op":"interrupt"})";
        EXPECT_EQ(0, host_control(h, kInt)) << "不带 correl 的 interrupt 不得被拒";
        EXPECT_FALSE(wait_done(h->rt, kBudget))
            << "interrupt 没有打断忙等脚本：引擎指令边界上的中断处理器没起作用"
               "（回执仍然会照发，所以只查回执是查不出来的；而且预算已大于脚本的"
               "自然耗时，所以「没出现 done」只能是被打断）";
        /* 打断之后运行时还要能用：interrupt 是「暂停」不是「弄坏」 */
        EXPECT_EQ(0, host_control(h, ctl_eval_json("k2", "6*7")))
            << "interrupt 之后运行时不可用了";
        std::string out;
        if (host_wait_ctl(h, "k2", &out))
            EXPECT_NE(std::string::npos, out.find("\"result\":42")) << out;
        else
            ADD_FAILURE() << "interrupt 之后正常命令没有回执: " << out;
        host_destroy(h);
    }
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
