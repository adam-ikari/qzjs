/*
 * qzjs — M-P7 mailbox e2e（宿主契约翻转正后的直接覆盖门）
 *
 * 真 qz_full 链接、真 ISOLATED 后端：本 harness 就是宿主——零回调、零
 * libuv 依赖，出站消息全部从 per-rt 邮箱用 qz_recv_message 消费。
 * 覆盖断言（模式 → 编号）：
 *   basic   ① 属主线程 qz_ping 免泵（宿主不泵任何东西）
 *           ② 2000 帧洪泛（含 16KB 大帧逼 spill）邮箱 FIFO 无损
 *           ③ qz_wait_idle 后箱净（排干后 recv(0) 无残留）+ wait_idle 幂等
 *   crash   ④ kill -9 主RT：wait_idle 返回后、free 前 recv 首帧即错误帧
 *           （时序 = mp4 CLI stderr 门的 harness 级复证）
 *   hung    ⑤ SIGSTOP 冻结主RT：qz_destroy 墙钟 ≤6000ms——三级终止冻结
 *           跑在库泵线程上，调用线程只 join（I5② 复活条款）
 *   replay  ⑥ pre-ready 顶层帧于 qz_create 返回前已入箱（首排干即得、
 *           FIFO 保序）；create 线程内 qz_post_message 回发安全
 *           （H1 绊线：wake 必须先于读泵初始化——顺序颠倒即崩溃）
 *   fd      ⑦ qz_message_fd 可读提示 + 三步消费协议终止性 +
 *           publish-before-signal 丢唤醒免疫（200 帧并发压力全收）
 *   dual    ⑧ 双实例邮箱/fd 独立：交错洪泛各自 FIFO、无跨箱串扰、
 *           双实例 ping 免泵、先后拆除
 *
 * 用法：qz_mp7_mailbox_e2e <basic|crash|hung|replay|fd|dual>
 * 退出码：0 = 该模式全部断言通过；非 0 = 失败（stderr 带诊断）。
 */
#include <qzjs/qzjs.h>

#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static uint64_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void nap_ms(uint64_t ms) {
    struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
    nanosleep(&ts, NULL);
}

/* ── JS 主脚本（回显 seq；alive 版保活供 crash/hung）── */
static const char *kScriptEcho =
    "onmessage = function (e) { postMessage({ seq: e.data.n }); };\n";
static const char *kScriptEchoAlive =
    "onmessage = function (e) { postMessage({ seq: e.data.n }); };\n"
    "setInterval(function () {}, 50);\n";
/* ⑥：顶层 postMessage 先于 ready 落通道（pre-ready 帧），onmessage 回声 ack。 */
static const char *kScriptReplay =
    "onmessage = function (e) { postMessage({ ack: e.data.n }); };\n"
    "postMessage({ pre: 1 });\n";
/* ⑧：pong 旁路帧不回 id，不扰动 FIFO 期望。 */
static const char *kScriptJobEcho =
    "onmessage = function (e) {\n"
    "  if (e.data.pong !== undefined) postMessage({ pong: e.data.pong });\n"
    "  else postMessage({ id: e.data.id });\n"
    "};\n";

/* 取一条消息（recv 内部 poll 唤醒）；返回 0 取到（json/len 出参），1 超时，-1 错。 */
static int take(qz_t *rt, char **json, size_t *len, int timeout_ms) {
    return qz_recv_message(rt, json, len, timeout_ms);
}

static long parse_field(const char *json, const char *key) {
    const char *p = strstr(json, key);
    return p ? strtol(p + strlen(key), NULL, 10) : -1;
}

/* ── kill helper 线程：pgrep -P <host pid> -x qzjs-rt 逐个 kill <sig> ── */
typedef struct { int sig; } killer_arg_t;

static void *killer_thread(void *arg) {
    killer_arg_t *ka = (killer_arg_t *)arg;
    nap_ms(300);   /* 让主线程先进入 wait_idle / destroy */
    char cmd[160];
    snprintf(cmd, sizeof cmd,
             "for p in $(pgrep -P %d -x qzjs-rt); do kill -%d $p; done",
             (int)getpid(), ka->sig);
    int rc = system(cmd);
    (void)rc;
    return NULL;
}

static pthread_t killer_start(int sig) {
    static killer_arg_t ka;   /* 单飞行：每模式一个 killer，生命周期到 join */
    ka.sig = sig;
    pthread_t t;
    pthread_create(&t, NULL, killer_thread, &ka);
    return t;
}

/* ── ①②③ basic ── */
static int mode_basic(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = kScriptEcho;
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "[basic] qz_create failed\n"); return 1; }

    /* ① 属主线程直接 ping：宿主侧无任何泵，纯等待库线程回 PONG */
    if (qz_ping(rt, 2000) != 0) {
        fprintf(stderr, "[basic] ① qz_ping 免泵失败（库泵线程未响应？）\n");
        return 1;
    }
    printf("[basic] ok ①: qz_ping 在零泵宿主线程返回 0（库线程自泵）\n");

    /* ② 洪泛 2000：每 100 条一条 ~16KB 大帧逼 tx spill */
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
    long expected = 0, got = 0, bad = 0;
    uint64_t deadline = now_ms() + 20000;
    while (got < 2000 && now_ms() < deadline) {
        char *json = NULL; size_t len = 0;
        int r = take(rt, &json, &len, (int)(deadline - now_ms()));
        if (r != 0) break;
        long v = parse_field(json, "\"seq\":");
        if (v >= 0) { if (v != expected++) bad++; got++; }
        qz_free_message(json);
    }
    if (got < 2000 || bad) {
        fprintf(stderr, "[basic] ② 洪泛不完/失序: got=%ld bad=%ld\n", got, bad);
        return 1;
    }
    printf("[basic] ok ②: 2000 帧（含大帧 spill）邮箱 FIFO 无损\n");

    /* ③ wait_idle 后箱净 + 幂等 */
    qz_wait_idle(rt);
    qz_wait_idle(rt);
    char *json = NULL; size_t len = 0;
    if (take(rt, &json, &len, 0) == 0) {
        fprintf(stderr, "[basic] ③ wait_idle 后箱内仍有残留消息: %s\n", json);
        qz_free_message(json);
        return 1;
    }
    qz_free(rt);   /* wait_idle 已拆除运行时：只释放实例（契约禁再 qz_destroy） */
    printf("[basic] ok ③: qz_wait_idle（二次幂等）后邮箱无残留\n");

    /* ④ 漏排干 leak 政策（ASAN 门捕获点）：宿主把消息留在箱内不 recv 就
     * 拆除，库必须在 teardown 里自行排干并释放这些未消费节点——漏 recv
     * 不得变成内存泄漏。制造残留：投两条让 JS 回声落箱，用 fd poll 见证
     * 「已到箱」而绝不 recv，随即 qz_destroy（full teardown）。 */
    qz_config_t cfg2 = {0};
    cfg2.initial_script = kScriptEcho;
    qz_t *rt2 = qz_create(&cfg2);
    if (!rt2) { fprintf(stderr, "[basic] ④ qz_create(rt2) failed\n"); return 1; }
    qz_post_message(rt2, "{\"n\":1}", 7);
    qz_post_message(rt2, "{\"n\":2}", 7);
    int fd2 = qz_message_fd(rt2);
    struct pollfd pfd = { .fd = fd2, .events = POLLIN };
    if (fd2 < 0 || poll(&pfd, 1, 2000) <= 0) {
        fprintf(stderr, "[basic] ④ 残留回声未落箱（fd=%d）\n", fd2);
        qz_destroy(rt2);
        return 1;
    }
    /* 绝不 recv——直接拆除，teardown 须释放箱内两条未消费节点 */
    qz_destroy(rt2);
    printf("[basic] ok ④: 未消费残留随 qz_destroy teardown 排干（漏 recv 无泄漏）\n");
    return 0;
}

/* ── ④ crash：kill -9 主RT，wait_idle 后首 recv 即错误帧 ── */
static int mode_crash(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = kScriptEchoAlive;
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "[crash] qz_create failed\n"); return 1; }

    /* 通道先活：一条往返证明 crash 尚未发生 */
    qz_post_message(rt, "{\"n\":1}", 7);
    char *json = NULL; size_t len = 0;
    if (take(rt, &json, &len, 2000) != 0) {
        fprintf(stderr, "[crash] 预热往返失败（通道未活？）\n");
        return 1;
    }
    qz_free_message(json);

    pthread_t t = killer_start(9);
    qz_wait_idle(rt);            /* EOF → 泵线程自收主RT；调用线程只等收束 */
    pthread_join(t, NULL);

    /* I4 时序门：wait_idle 返回后、free 前，错误帧必须已在箱内 */
    json = NULL;
    if (take(rt, &json, &len, 2000) != 0 ||
        !strstr(json, "\"type\":\"error\"") ||
        !strstr(json, "main-runtime-process-exited-unexpectedly")) {
        fprintf(stderr, "[crash] ④ wait_idle 后未 recv 到错误帧（got=%s）\n",
                json ? json : "<none>");
        if (json) qz_free_message(json);
        return 1;
    }
    qz_free_message(json);
    qz_free(rt);
    printf("[crash] ok ④: kill -9 主RT → wait_idle 返回后首条 recv 即错误帧\n");
    return 0;
}

/* ── ⑤ hung：SIGSTOP 冻结主RT，destroy 墙钟预算（冻结在库泵线程）── */
static int mode_hung(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = kScriptEchoAlive;
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "[hung] qz_create failed\n"); return 1; }

    pthread_t t = killer_start(19);   /* SIGSTOP：graceful 无响应 → 三级升级 */
    nap_ms(500);                       /* 确保 STOP 已生效 */

    uint64_t t0 = now_ms();
    qz_destroy(rt);                    /* 调用线程只置位+join；冻结在库线程 */
    uint64_t dt = now_ms() - t0;
    pthread_join(t, NULL);

    if (dt > 6000) {
        fprintf(stderr, "[hung] ⑤ destroy 耗时 %llu ms（预算 6000）\n",
                (unsigned long long)dt);
        return 1;
    }
    printf("[hung] ok ⑤: 冻结主RT 的 destroy 在 %llu ms 内完成（三级终止在库线程）\n",
           (unsigned long long)dt);
    return 0;
}

/* ── ⑥ replay：pre-ready 帧 create 返回前已入箱 + 回发安全（H1）── */
static int mode_replay(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = kScriptReplay;
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "[replay] qz_create failed\n"); return 1; }

    /* 首排干（timeout 0 纯轮询）即得顶层 pre-ready 帧 = create 内已入箱 */
    char *json = NULL; size_t len = 0;
    if (take(rt, &json, &len, 0) != 0 || !strstr(json, "\"pre\":")) {
        fprintf(stderr, "[replay] ⑥a pre-ready 顶层帧未在 create 返回时入箱首排即得\n");
        if (json) qz_free_message(json);
        return 1;
    }
    qz_free_message(json);

    /* create 线程侧（此处为主线程，pre 帧入箱发生在 create 内部重放）回发：
     * wake 若未先于读泵初始化，回发/重放路径直接崩溃（H1 绊线）。 */
    qz_post_message(rt, "{\"n\":4242}", 10);
    json = NULL;
    if (take(rt, &json, &len, 5000) != 0 || !strstr(json, "\"ack\":4242")) {
        fprintf(stderr, "[replay] ⑥b 回发的 post_message 未获 JS 回声（got=%s）\n",
                json ? json : "<none>");
        if (json) qz_free_message(json);
        return 1;
    }
    qz_free_message(json);   /* ⑥c：pre 在前、ack 在后 —— FIFO 保序由取序见证 */

    qz_wait_idle(rt);
    qz_free(rt);
    printf("[replay] ok ⑥: pre-ready 帧首排干即得 + 回发回声到达 + FIFO 保序（H1 绊线过）\n");
    return 0;
}

/* ⑦ 压力线程：向 rt 连发 N 条（主线程按三步协议消费） */
#define FD_STRESS 200
static void *stress_poster(void *arg) {
    qz_t *rt = (qz_t *)arg;
    for (int i = 0; i < FD_STRESS; i++) {
        char m[64];
        /* id 从 1000 起：避开 ⑦a 预热的 n=7 回声，杜绝序号混叠 */
        int n = sprintf(m, "{\"n\":%d}", 1000 + i);
        qz_post_message(rt, m, (size_t)n);
    }
    return NULL;
}

/* eventfd 计数清到 EAGAIN（三步协议第②步）。 */
static void fd_clear(int fd) {
    uint64_t v;
    while (read(fd, &v, sizeof v) == (ssize_t)sizeof v) {}
}

/* ── ⑦ fd：可读提示 + 三步协议终止性 + 丢唤醒免疫 ── */
static int mode_fd(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = kScriptEcho;
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "[fd] qz_create failed\n"); return 1; }
    int fd = qz_message_fd(rt);
    if (fd < 0) { fprintf(stderr, "[fd] qz_message_fd 返回 %d（Linux 应为 eventfd）\n", fd); return 1; }

    /* ⑦a 可读提示：箱空时 poll 超时；入一条并取走后 poll 静默、再入则立即可读 */
    struct pollfd pfd = { .fd = fd, .events = POLLIN };
    char *json = NULL; size_t len = 0;
    fd_clear(fd);
    if (poll(&pfd, 1, 100) != 0) {
        fprintf(stderr, "[fd] ⑦a 箱空时 poll 不应可读\n"); return 1;
    }
    qz_post_message(rt, "{\"n\":7}", 7);
    if (poll(&pfd, 1, 2000) <= 0) {
        fprintf(stderr, "[fd] ⑦a 入箱后 poll 未变可读\n"); return 1;
    }
    if (take(rt, &json, &len, 2000) != 0) {
        fprintf(stderr, "[fd] ⑦a poll 可读但 recv 取不到货\n"); return 1;
    }
    qz_free_message(json);
    printf("[fd] ok ⑦a: qz_message_fd 可读提示随入箱翻转 + recv 配对\n");

    /* ⑦b 三步协议终止性：①排干 → ②清 fd → ③复核空 → 方可阻塞 */
    fd_clear(fd);
    while (take(rt, &json, &len, 0) == 0) qz_free_message(json);
    fd_clear(fd);
    if (take(rt, &json, &len, 0) != 0) { /* 复核：空 */ }
    else { qz_free_message(json); fprintf(stderr, "[fd] ⑦b 复核步漏取消息\n"); return 1; }

    /* ⑦c 丢唤醒免疫压力：poster 线程连发 200，主线程严格按协议消费。
     * publish-before-signal + 复核步保证：poll 超时退出时若箱非空必然被
     * 下一轮①取走——200 条全收即证不丢。 */
    pthread_t th;
    pthread_create(&th, NULL, stress_poster, rt);
    long got = 0, bad = 0, expected = 1000;
    uint64_t deadline = now_ms() + 10000;
    while (got < FD_STRESS && now_ms() < deadline) {
        /* ① 排干 */
        int drained = 1;
        while (drained) {
            drained = 0;
            while (take(rt, &json, &len, 0) == 0) {
                long v = parse_field(json, "\"seq\":");
                if (v >= 0) { if (v != expected++) bad++; got++; }
                qz_free_message(json);
                drained = 1;
            }
            if (got >= FD_STRESS) break;
            /* ② 清 fd */
            fd_clear(fd);
            /* ③ 复核：①/② 之间到达的消息（链先于计数）必须在这里被看见并
             *    处理——这一步就是丢唤醒免疫的来源 */
            if (take(rt, &json, &len, 0) == 0) {
                long v = parse_field(json, "\"seq\":");
                if (v >= 0) { if (v != expected++) bad++; got++; }
                qz_free_message(json);
                continue;
            }
            break;   /* 复核为空：可以阻塞 */
        }
        if (got >= FD_STRESS || now_ms() >= deadline) break;
        /* ④ 有限超时 poll：协议终止性（绝不永挂） */
        pfd.revents = 0;
        int pr = poll(&pfd, 1, 200);
        if (pr < 0 && errno != EINTR) {
            fprintf(stderr, "[fd] poll 错误 errno=%d\n", errno); return 1;
        }
    }
    pthread_join(th, NULL);
    /* 尾排干：poll 超时也可能有已入链未取的 */
    while (take(rt, &json, &len, 0) == 0) {
        long v = parse_field(json, "\"seq\":");
        if (v >= 0) { if (v != expected++) bad++; got++; }
        qz_free_message(json);
    }
    if (got != FD_STRESS || bad) {
        fprintf(stderr, "[fd] ⑦c 压力丢/乱帧: got=%ld bad=%ld\n", got, bad);
        return 1;
    }
    printf("[fd] ok ⑦b+⑦c: 三步协议可终止且 200 帧并发压力全收零丢唤醒\n");

    qz_wait_idle(rt);
    qz_free(rt);
    return 0;
}

/* ── ⑧ dual：双实例邮箱/fd 独立 ── */
static int mode_dual(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = kScriptJobEcho;
    qz_t *rt1 = qz_create(&cfg);
    qz_t *rt2 = qz_create(&cfg);
    if (!rt1 || !rt2) {
        fprintf(stderr, "[dual] qz_create failed（rt1=%p rt2=%p）\n",
                (void *)rt1, (void *)rt2);
        return 1;
    }
    int fd1 = qz_message_fd(rt1), fd2 = qz_message_fd(rt2);
    if (fd1 < 0 || fd2 < 0 || fd1 == fd2) {
        fprintf(stderr, "[dual] ⑧a 双实例 fd 不独立（fd1=%d fd2=%d）\n", fd1, fd2);
        return 1;
    }
    printf("[dual] ok ⑧a: 双实例邮箱 fd 独立（%d vs %d）\n", fd1, fd2);

    /* 交替投递：rt1 流 id 0..299、rt2 流 1000..1299；每 50 条 pong 旁路帧，
     * rt1 侧带 16KB pad 逼 spill（pong 不回 id，不扰动 FIFO 期望）*/
    static char big[16 * 1024 + 64];
    for (int i = 0; i < 300; i++) {
        char m[64];
        int n = sprintf(m, "{\"id\":%d}", i);
        qz_post_message(rt1, m, (size_t)n);
        n = sprintf(m, "{\"id\":%d}", 1000 + i);
        qz_post_message(rt2, m, (size_t)n);
        if (i % 50 == 49) {
            char *p = big;
            p += sprintf(p, "{\"pong\":%d,\"pad\":\"", i);
            memset(p, 'y', 16 * 1024); p += 16 * 1024;
            *p++ = '"'; *p++ = '}'; *p = '\0';
            qz_post_message(rt1, big, strlen(big));
            n = sprintf(m, "{\"pong\":%d}", 2000 + i);
            qz_post_message(rt2, m, (size_t)n);
        }
    }

    /* 主线程轮转消费两箱（timeout 分片，绝不永挂任一箱）。
     * 环条件须覆盖 pong 旁路帧：每 50 条 id 帧后另投 pong（不回 id），
     * 最后一批 pong 可能晚于 id 帧到达，故 got 达标后仍须排干 pong。 */
    long exp1 = 0, exp2 = 1000, got1 = 0, got2 = 0, pongs = 0, bad1 = 0, bad2 = 0;
    uint64_t deadline = now_ms() + 20000;
    while ((got1 < 300 || got2 < 300 || pongs < 12) && now_ms() < deadline) {
        char *json = NULL; size_t len = 0;
        if (take(rt1, &json, &len, 5) == 0) {
            if (strstr(json, "\"pong\":")) pongs++;
            else {
                long v = parse_field(json, "\"id\":");
                if (v != exp1++) bad1++;
                got1++;
            }
            qz_free_message(json);
            continue;
        }
        json = NULL;
        if (take(rt2, &json, &len, 5) == 0) {
            if (strstr(json, "\"pong\":")) pongs++;
            else {
                long v = parse_field(json, "\"id\":");
                if (v != exp2++) bad2++;
                got2++;
            }
            qz_free_message(json);
        }
    }
    if (got1 < 300 || got2 < 300 || bad1 || bad2) {
        fprintf(stderr, "[dual] ⑧b 交错洪泛不完/失序: got1=%ld got2=%ld bad1=%ld bad2=%ld\n",
                got1, got2, bad1, bad2);
        return 1;
    }
    if (pongs != 12) {
        fprintf(stderr, "[dual] ⑧b pong 收数=%ld（期望 12）\n", pongs);
        return 1;
    }
    printf("[dual] ok ⑧b: 双实例交错洪泛 600 帧各自 FIFO 无损、零跨箱串扰\n");

    if (qz_ping(rt1, 2000) != 0 || qz_ping(rt2, 2000) != 0) {
        fprintf(stderr, "[dual] ⑧c 双实例 ping 失败\n");
        return 1;
    }
    printf("[dual] ok ⑧c: 双实例 qz_ping 均返回 0（各自库线程独立响应）\n");

    qz_wait_idle(rt1);
    qz_free(rt1);
    qz_wait_idle(rt2);
    qz_free(rt2);
    printf("[dual] ok ⑧d: 两实例先后 wait_idle+free，互不干扰\n");
    return 0;
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);
#ifdef QZ_RT_SERVER_PATH
    setenv("QZ_RT_SERVER", QZ_RT_SERVER_PATH, 0);
#endif
    const char *mode = argc > 1 ? argv[1] : "basic";
    if (strcmp(mode, "basic") == 0)  return mode_basic();
    if (strcmp(mode, "crash") == 0)  return mode_crash();
    if (strcmp(mode, "hung") == 0)   return mode_hung();
    if (strcmp(mode, "replay") == 0) return mode_replay();
    if (strcmp(mode, "fd") == 0)     return mode_fd();
    if (strcmp(mode, "dual") == 0)   return mode_dual();
    fprintf(stderr, "usage: %s <basic|crash|hung|replay|fd|dual>\n", argv[0]);
    return 2;
}
