/*
 * qzjs — M-P6 host-pump e2e（ISOLATED 宿主契约翻转的直接覆盖）
 *
 * 真 libuv + 真 qz_full 链接（非 mock）：本 harness 就是宿主——自建
 * uv_loop、经 cfg.uv_loop 注入、message_cb 应跑在泵该 loop 的线程。
 * 覆盖计划 C3 的七项断言（basic 模式合并 ①③④⑤，其余模式各一）：
 *   ① cb 线程 == 泵 loop 线程（pthread_self 捕获比对）
 *   ② cfg.uv_loop = NULL → qz_create 显式失败（NULL 返回）
 *   ③ loop 属主线程直接调 qz_ping → 0（内部泵不自死锁）
 *   ④ 洪泛（含大帧逼 spill）FIFO 无损、spill timer 在泵中冲刷
 *   ⑤ qz_wait_idle 后 uv_loop_close(&loop) == 0（库句柄全关，无泄漏进宿主 loop）
 *   ⑥ kill -9 主RT：qz_wait_idle 内收到 {"type":"error"} message_cb
 *   ⑦ SIGSTOP 冻结主RT：qz_destroy 在 terminate 预算内完成（tier 升级）
 *   ⑧ pre-ready 重放语义：初始脚本顶层消息在 create 返回前于调用线程重放，
 *      且重放期 message_cb 内 qz_post_message 回发安全（H1 守卫：wake 先于
 *      start_read_cb 初始化——顺序颠倒即 wake.loop==NULL 崩溃）
 *
 * 用法：qz_mp5_host_pump_e2e <basic|null|crash|hung|replay>
 * 退出码：0 = 该模式全部断言通过；非 0 = 失败（stderr 带诊断）。
 */
#include <qzjs/qzjs.h>
#include <uv.h>

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static uv_loop_t g_loop;
static uv_thread_t g_main_thread;
static int g_cb_calls;          /* message_cb 触发次数 */
static int g_cb_wrong_thread;   /* ① 非泵线程触发计数 */
static pthread_t g_cb_thread;   /* 最后一次 cb 的线程 id（诊断用） */
static long g_expected_seq;     /* ④ FIFO 期望序号 */
static int g_seq_bad;           /* ④ 失序计数 */
static int g_got_total;         /* ④ 收到总数 */
static int g_error_reported;    /* ⑥ 崩溃上报标志 */
static int g_timed_out;
/* ⑧ pre-ready 重放：create 返回标志 + 顶层消息/回发/回声观测 */
static volatile int g_create_returned;
static int g_replay_mode, g_replay_pre_seen, g_replay_in_create, g_replay_ack;

/* 宿主闹钟：绝对 deadline 到点 uv_stop（所有等待共用的看门狗）。 */
static uint64_t g_deadline_ms;
static void watchdog_cb(uv_timer_t *t) {
    (void)t;
    g_timed_out = 1;
    uv_stop(&g_loop);
}
static uv_timer_t g_watchdog;

static uint64_t now_ms(void) {
    return uv_hrtime() / 1000000;
}

static void pump_until(int (*done)(void), uint64_t timeout_ms) {
    g_deadline_ms = now_ms() + timeout_ms;
    uv_timer_start(&g_watchdog, watchdog_cb,
                     (uint64_t)(g_deadline_ms - now_ms()), 0);
    while (!done() && !g_timed_out)
        uv_run(&g_loop, UV_RUN_ONCE);
    uv_timer_stop(&g_watchdog);
}

/* ── message_cb：只数数 + 记线程，绝不调用阻塞宿主 API（契约） ── */
static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    g_cb_calls++;
    g_cb_thread = pthread_self();
    if (!pthread_equal(g_cb_thread, (pthread_t)g_main_thread))
        g_cb_wrong_thread++;

    if (len > 0 && strstr(json, "\"type\":\"error\"") != NULL) {
        g_error_reported = 1;
        return;
    }
    /* ⑧ pre-ready 顶层帧：在 create 内的重放回调里回发 post_message——
     * wake 若未先于重放初始化，这里直接段错误（H1 守卫的活体证明）。 */
    if (g_replay_mode && strstr(json, "\"pre\":") != NULL) {
        g_replay_pre_seen++;
        if (!g_create_returned) g_replay_in_create = 1;
        qz_post_message(rt, "{\"n\":4242}", 10);
        return;
    }
    if (g_replay_mode && strstr(json, "\"ack\":4242") != NULL) {
        g_replay_ack = 1;
        return;
    }
    const char *p = strstr(json, "\"seq\":");
    if (p) {
        long v = strtol(p + 6, NULL, 10);
        if (v != g_expected_seq++) g_seq_bad++;
        g_got_total++;
    }
}

static int flood_done(void) { return g_got_total >= 2000; }

/* JS 主脚本：回显 seq（basic/crash/hung 通用）。interval 保活（crash/hung）。 */
static const char *kScriptEcho =
    "onmessage = function (e) { postMessage({ seq: e.data.n }); };\n";
static const char *kScriptEchoAlive =
    "onmessage = function (e) { postMessage({ seq: e.data.n }); };\n"
    "setInterval(function () {}, 50);\n";
/* ⑧：顶层 postMessage 先于 ready 落通道（pre-ready 帧），onmessage 回声 ack。 */
static const char *kScriptReplay =
    "onmessage = function (e) { postMessage({ ack: e.data.n }); };\n"
    "postMessage({ pre: 1 });\n";

static void loop_setup(void) {
    uv_loop_init(&g_loop);
    uv_timer_init(&g_loop, &g_watchdog);
}

static void loop_close_expect_clean(const char *mode) {
    uv_close((uv_handle_t *)&g_watchdog, NULL);
    while (uv_run(&g_loop, UV_RUN_NOWAIT)) { /* 收 close 回调 */ }
    int rc = uv_loop_close(&g_loop);
    if (rc != 0) {
        fprintf(stderr, "[%s] uv_loop_close returned %d (%s): 库句柄泄漏进宿主 loop\n",
                mode, rc, uv_strerror(rc));
        exit(1);
    }
}

/* ── kill helper 线程（crash/hung）：pgrep -P <host pid> 找 qzjs-rt 子进程 ── */
typedef struct { int sig; } killer_arg_t;

static void killer_thread(void *arg) {
    killer_arg_t *ka = (killer_arg_t *)arg;
    uv_sleep(300);   /* 让主线程先进入 wait_idle / destroy 的泵等待 */
    char cmd[128];
    snprintf(cmd, sizeof cmd,
             "for p in $(pgrep -P %d -x qzjs-rt); do kill -%d $p; done",
             (int)getpid(), ka->sig);
    int rc = system(cmd);
    (void)rc;
}

/* ── ② null-loop ── */
static int mode_null(void) {
    qz_config_t cfg = {0};
    cfg.message_cb = on_message;
    cfg.uv_loop = NULL;           /* ISOLATED 必填，缺失 = 显式失败 */
    cfg.initial_script = "1;";
    qz_t *rt = qz_create(&cfg);
    if (rt != NULL) {
        fprintf(stderr, "[null] qz_create with uv_loop=NULL returned non-NULL\n");
        qz_destroy(rt);
        return 1;
    }
    printf("[null] ok: uv_loop=NULL -> qz_create 显式失败\n");
    return 0;
}

/* ── ①③④⑤ basic ── */
static int mode_basic(void) {
    loop_setup();
    g_main_thread = (uv_thread_t)(uintptr_t)pthread_self();

    qz_config_t cfg = {0};
    cfg.message_cb = on_message;
    cfg.uv_loop = &g_loop;
    cfg.initial_script = kScriptEcho;
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "[basic] qz_create failed\n"); return 1; }

    /* ③ 属主线程直接 ping：内部泵，不得自死锁 */
    if (qz_ping(rt, 2000) != 0) {
        fprintf(stderr, "[basic] qz_ping on loop-owner thread failed\n");
        return 1;
    }
    printf("[basic] ok ③: qz_ping 在 loop 属主线程返回 0（内部泵不死锁）\n");

    /* ④ 洪泛 2000：每 100 条一条 ~16KB 大帧逼 tx spill（spill timer 挂宿主 loop） */
    static char big[16 * 1024 + 64];
    for (int i = 0; i < 2000; i++) {
        if (i % 100 == 99) {
            char *p = big;
            p += sprintf(p, "{\"n\":%d,\"pad\":\"", i);
            memset(p, 'x', 16 * 1024); p += 16 * 1024;
            *p++ = '"'; *p++ = '}'; *p = '\0';
            qz_post_message(rt, big, strlen(big));
        } else {
            char small[64];
            int n = sprintf(small, "{\"n\":%d}", i);
            qz_post_message(rt, small, (size_t)n);
        }
    }
    pump_until(flood_done, 20000);
    if (g_timed_out || !flood_done()) {
        fprintf(stderr, "[basic] ④ flood incomplete: got=%d\n", g_got_total);
        return 1;
    }
    if (g_seq_bad != 0) {
        fprintf(stderr, "[basic] ④ FIFO 失序: %d 处（got=%d）\n", g_seq_bad, g_got_total);
        return 1;
    }
    printf("[basic] ok ④: 2000 帧（含大帧 spill）FIFO 无损，泵中冲刷\n");

    /* ① cb 线程 == 泵线程 */
    if (g_cb_wrong_thread != 0) {
        fprintf(stderr, "[basic] ① %d 次 message_cb 不在泵线程\n", g_cb_wrong_thread);
        return 1;
    }
    printf("[basic] ok ①: %d 次 message_cb 全部在泵 loop 的线程\n", g_cb_calls);

    /* ⑤ wait_idle 后宿主 loop 干净可关 */
    qz_wait_idle(rt);
    qz_wait_idle(rt);  /* 二次调用 = no-op（M4 幂等守卫：不得触已 close 的 wake） */
    qz_free(rt);   /* wait_idle 已拆除运行时：只释放实例（契约禁再 qz_destroy） */
    loop_close_expect_clean("basic");
    printf("[basic] ok ⑤: qz_wait_idle 后 uv_loop_close==0（无库句柄残留）\n");
    return 0;
}

/* ── ⑧ replay：pre-ready 重放 + create 内回调回发（H1 守卫）── */
static int replay_done(void) { return g_replay_ack; }

static int mode_replay(void) {
    loop_setup();
    g_main_thread = (uv_thread_t)(uintptr_t)pthread_self();
    g_replay_mode = 1;

    qz_config_t cfg = {0};
    cfg.message_cb = on_message;
    cfg.uv_loop = &g_loop;
    cfg.initial_script = kScriptReplay;
    qz_t *rt = qz_create(&cfg);
    g_create_returned = 1;
    if (!rt) { fprintf(stderr, "[replay] qz_create failed\n"); return 1; }

    if (g_replay_pre_seen != 1 || !g_replay_in_create) {
        fprintf(stderr, "[replay] ⑧a 顶层 pre-ready 消息未于 create 内重放"
                        "（seen=%d in_create=%d）\n",
                g_replay_pre_seen, g_replay_in_create);
        return 1;
    }
    printf("[replay] ok ⑧a: 顶层消息于 qz_create 返回前在调用线程同步重放\n");

    /* 重放 cb 内已回发 {"n":4242}（wake 须已 init）；JS 回声须经首泵到达 */
    pump_until(replay_done, 5000);
    if (!g_replay_ack) {
        fprintf(stderr, "[replay] ⑧b create 内回发的 post_message 未获 JS 回声"
                        "（timeout=%d）\n", g_timed_out);
        return 1;
    }
    if (g_cb_wrong_thread) {
        fprintf(stderr, "[replay] ① %d 次 message_cb 不在泵线程\n", g_cb_wrong_thread);
        return 1;
    }
    printf("[replay] ok ⑧b: create 内重放回调中 qz_post_message 回发 → JS 回声到达（无崩溃）\n");

    qz_wait_idle(rt);
    qz_free(rt);
    loop_close_expect_clean("replay");
    return 0;
}

/* ── ⑥ crash：kill -9 主RT，wait_idle 内收 {"type":"error"} ── */
static int mode_crash(void) {
    loop_setup();
    g_main_thread = (uv_thread_t)(uintptr_t)pthread_self();

    qz_config_t cfg = {0};
    cfg.message_cb = on_message;
    cfg.uv_loop = &g_loop;
    cfg.initial_script = kScriptEchoAlive;
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "[crash] qz_create failed\n"); return 1; }

    killer_arg_t ka = { .sig = 9 };
    uv_thread_t t;
    if (uv_thread_create(&t, killer_thread, &ka) != 0) {
        fprintf(stderr, "[crash] killer thread failed\n"); return 1;
    }

    /* 保活脚本下 wait_idle 阻塞 → 泵 loop → EOF 到来 → 崩溃上报在本调用内触发 */
    qz_wait_idle(rt);
    uv_thread_join(&t);
    uv_run(&g_loop, UV_RUN_NOWAIT);

    if (!g_error_reported) {
        fprintf(stderr, "[crash] ⑥ wait_idle 未触发 {\"type\":\"error\"} message_cb\n");
        return 1;
    }
    printf("[crash] ok ⑥: kill -9 主RT → wait_idle 内收到崩溃上报\n");
    /* 级联收尾：宿主 loop 仍须能关（库句柄已随 teardown 关闭） */
    qz_free(rt);
    loop_close_expect_clean("crash");
    return 0;
}

/* ── ⑦ hung：SIGSTOP 冻结主RT，destroy 在 terminate 预算内收束 ── */
static int mode_hung(void) {
    loop_setup();
    g_main_thread = (uv_thread_t)(uintptr_t)pthread_self();

    qz_config_t cfg = {0};
    cfg.message_cb = on_message;
    cfg.uv_loop = &g_loop;
    cfg.initial_script = kScriptEchoAlive;
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "[hung] qz_create failed\n"); return 1; }

    killer_arg_t ka = { .sig = 19 };   /* SIGSTOP：loop 冻结，graceful 无响应 */
    uv_thread_t t;
    if (uv_thread_create(&t, killer_thread, &ka) != 0) {
        fprintf(stderr, "[hung] killer thread failed\n"); return 1;
    }
    uv_sleep(500);   /* 确保 STOP 已生效再 destroy */

    uint64_t t0 = now_ms();
    qz_destroy(rt);                    /* tier 升级 → SIGKILL 兜底 + reap */
    uint64_t dt = now_ms() - t0;
    uv_thread_join(&t);

    if (dt > 6000) {
        fprintf(stderr, "[hung] ⑦ destroy 耗时 %llu ms（预算 6000）\n",
                (unsigned long long)dt);
        return 1;
    }
    loop_close_expect_clean("hung");
    printf("[hung] ok ⑦: 冻结主RT 的 destroy 在 %llu ms 内完成，proc 回收干净\n",
           (unsigned long long)dt);
    return 0;
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);
    const char *mode = argc > 1 ? argv[1] : "basic";
    if (strcmp(mode, "null") == 0)  return mode_null();
    if (strcmp(mode, "basic") == 0) return mode_basic();
    if (strcmp(mode, "crash") == 0) return mode_crash();
    if (strcmp(mode, "hung") == 0)  return mode_hung();
    if (strcmp(mode, "replay") == 0) return mode_replay();
    fprintf(stderr, "usage: %s <basic|null|crash|hung|replay>\n", argv[0]);
    return 2;
}
