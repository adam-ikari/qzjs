/*
 * qzjs — M-P7 mailbox e2e（宿主契约翻转正后的直接覆盖门）
 *
 * 真 qz_full 链接、真 ISOLATED 后端：本 harness 就是宿主——零回调、零
 * libuv 依赖，出站消息全部从 per-rt 邮箱用 qz_recv_message 消费。
 * 覆盖断言（模式 → 编号）：
 *   basic   ① 属主线程 qz_ping 免驱动（宿主不驱动任何东西）
 *           ② 2000 帧洪泛（含 16KB 大帧逼 spill）邮箱 FIFO 无损
 *           ③ qz_wait_idle 后箱净（排干后 recv(0) 无残留）+ wait_idle 幂等
 *   crash   ④ kill -9 主RT：wait_idle 返回后、free 前 recv 首帧即错误帧
 *           （时序 = mp4 CLI stderr 门的 harness 级复证）
 *   hung    ⑤ SIGSTOP 冻结主RT：qz_destroy 墙钟 ≤3000ms（库内 graceful 档
 *   2000ms；旧预算 6000 是它的 3 倍、等于放任一整个档位退化而仍绿）——三级终止冻结
 *           跑在库宿主侧线程上，调用线程只 join（I5② 复活条款）
 *   replay  ⑥ pre-ready 顶层帧于 qz_create 返回前已入箱（首排干即得、
 *           FIFO 保序）；create 线程内 qz_post_message 回发安全
 *           （H1 绊线：wake 必须先于读回调初始化——顺序颠倒即崩溃）
 *   fd      ⑦ qz_message_fd 可读提示 + 三步消费协议终止性 +
 *           publish-before-signal 丢唤醒免疫（200 帧并发压力全收）
 *   dual    ⑧ 双实例邮箱/fd 独立：交错洪泛各自 FIFO、无跨箱串扰、
 *           双实例 ping 免驱动、先后拆除
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
/* ⑥：顶层 postMessage 先于 ready 落通道（pre-ready 帧），onmessage 回声 ack。
 * 连发 3 条：只发 1 条时「重放倒序」与正确实现完全等价，检不出 FIFO 反转。 */
static const char *kScriptReplay =
    "onmessage = function (e) { postMessage({ ack: e.data.n }); };\n"
    "postMessage({ pre: 1 });\n"
    "postMessage({ pre: 2 });\n"
    "postMessage({ pre: 3 });\n";
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

/* 投递必须看返回值。qz_post_message 失败只有两个原因（OOM / 长度非法），
 * 都不该被吞掉：消息压根没发出去时，本 harness 的症状是「收不齐 N 条」或
 * 「poll 没变可读」——会被读成 FIFO / spill / 丢唤醒的问题，而真因是投递失败。
 * 与其让人从症状猜，不如当场指名。返回 0 成功，-1 失败（已打印诊断）。 */
static int post(qz_t *rt, const char *json, size_t len) {
    if (qz_post_message(rt, json, len) == 0) return 0;
    fprintf(stderr, "[harness] qz_post_message failed (len=%zu, OOM or bad length)\n",
            len);
    return -1;
}

static long parse_field(const char *json, const char *key) {
    const char *p = strstr(json, key);
    return p ? strtol(p + strlen(key), NULL, 10) : -1;
}

/* 弹一条消息并按期望字段记账。返回 0 = 取到，1 = 箱空。
 * 帧里根本没有期望字段（v < 0）同样计 bad——把它静默 free 掉等于把「箱净」
 * 这道门拆了：本该在 C 层消费掉的内容一旦泄漏进宿主邮箱，测试必须红，
 * 而不是无感通过。 */
static int account_take(qz_t *rt, const char *key, long *expected,
                        long *got, long *bad, int timeout_ms) {
    char *json = NULL; size_t len = 0;
    if (take(rt, &json, &len, timeout_ms) != 0) return 1;
    long v = parse_field(json, key);
    if (v < 0) (*bad)++;
    else if (v != (*expected)++) (*bad)++;
    (*got)++;
    qz_free_message(json);
    return 0;
}

/* ── kill helper 线程：pgrep -P <host pid> -x qzjs-rt 逐个 kill <sig> ── */
typedef struct { int sig; } killer_arg_t;

static void *killer_thread(void *arg) {
    killer_arg_t *ka = (killer_arg_t *)arg;
    /* 等子进程**真的**出现，而不是假定睡固定时长就够。固定睡眠在 ASAN runner 或
     * /proc 慢的容器里可能落在 spawn 之前，于是 kill 空转、三级终止路径根本没被
     * 触发——dt 变小是空过而非通过。
     * 注意 pid 必须用 getpid() 拼进命令：早先写成 system("... -P $$ ...")，而 $$
     * 在 system() 起的那个 /bin/sh 里是**子 shell 自己**的 pid，永远匹配不到本
     * 进程的子节点，于是这个等待每次都烧满整个上界（3s），把 kill 拖到主线程
     * 取证预算的边缘——实测直接让 hung 模式判红。
     * 也不需要「等主线程进入 destroy」：现在的次序是主线程先等 T 取证、取证成立
     * 才开始计时 destroy，所以 killer 越早 kill 越好。 */
    char waitcmd[128];
    snprintf(waitcmd, sizeof waitcmd, "pgrep -P %d -x qzjs-rt >/dev/null 2>&1",
             (int)getpid());
    for (int i = 0; i < 300; i++) {          /* 最多 3s */
        if (system(waitcmd) == 0) break;
        nap_ms(10);
    }
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

/* procfs 可用性：容器里可能没挂 /proc。缺了不是「断言失败」，是「这条断言测不了」，
 * 必须能区分，否则 mode_hung 会以「主RT 未处于 T（state=?）」红——那个红跟被测
 * 逻辑毫无关系，纯属环境。（pgrep 同样依赖 procfs。） */
static int procfs_available(void) {
    return access("/proc/self/stat", R_OK) == 0;
}

/* 主RT 子进程当前状态（/proc/<pid>/stat 第 3 字段）；取不到返回 0。 */
static int child_rt_state(char *out_state) {
    char cmd[128];
    snprintf(cmd, sizeof cmd, "pgrep -P %d -x qzjs-rt", (int)getpid());
    FILE *fp = popen(cmd, "r");
    if (!fp) return 0;
    int pid = 0;
    if (fscanf(fp, "%d", &pid) != 1) pid = 0;
    pclose(fp);
    if (pid <= 0) return 0;
    char path[64];
    snprintf(path, sizeof path, "/proc/%d/stat", pid);
    FILE *f = fopen(path, "r");
    if (!f) return 0;
    char buf[512];
    size_t n = fread(buf, 1, sizeof buf - 1, f);
    fclose(f);
    if (!n) return 0;
    buf[n] = '\0';
    char *rp = strrchr(buf, ')');   /* comm 可含空格，须取最后一个 ')' 之后的字段 */
    if (!rp || rp[1] != ' ' || !rp[2]) return 0;
    *out_state = rp[2];
    return 1;
}

/* 等待主RT 进入 T（停止）态，有上界。返回 1 = 已确认，0 = 超时未确认。
 * 用等待而不是固定睡眠：固定 500ms 的余量全在 fork/system 的 IO 上，ASAN
 * runner 上很容易归零，那时会以环境之名红。 */
static int await_child_stopped(char *out_state, int budget_ms) {
    uint64_t deadline = now_ms() + (uint64_t)budget_ms;
    char st = '?';
    for (;;) {
        if (child_rt_state(&st) && st == 'T') { *out_state = st; return 1; }
        if (now_ms() >= deadline) { *out_state = st; return 0; }
        nap_ms(20);
    }
}

/* ── ①②③ basic ── */
static int mode_basic(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = kScriptEcho;
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "[basic] qz_create failed\n"); return 1; }

    /* ① 属主线程直接 ping：宿主侧无任何驱动，纯等待库线程回 PONG */
    if (qz_ping(rt, 2000) != 0) {
        fprintf(stderr, "[basic] ① qz_ping 免驱动失败（库宿主侧线程未响应？）\n");
        return 1;
    }
    printf("[basic] ok ①: qz_ping 在零驱动宿主线程返回 0（库线程自驱动）\n");

    /* ①b 箱净：ping 的回执必须在 C 层就地消费，绝不能泄漏进宿主邮箱
     * （泄漏即证明系统级 CONTROL 没被拦在 rt_main 读回调里）。 */
    {
        char *j = NULL; size_t l = 0;
        if (take(rt, &j, &l, 0) == 0) {
            fprintf(stderr, "[basic] ①b ping 后邮箱非空（回执泄漏进箱）: %s\n", j);
            qz_free_message(j);
            return 1;
        }
    }
    printf("[basic] ok ①b: ping 回执未进宿主邮箱（箱净）\n");

    /* ② 洪泛 2000：每 100 条一条 ~16KB 大帧逼 tx spill */
    static char big[16 * 1024 + 64];
    for (int i = 0; i < 2000; i++) {
        if (i % 100 == 99) {
            char *p = big;
            p += sprintf(p, "{\"n\":%d,\"pad\":\"", i);
            memset(p, 'x', 16 * 1024); p += 16 * 1024;
            *p++ = '"'; *p++ = '}'; *p = '\0';
            if (post(rt, big, strlen(big)) != 0) return 1;
        } else {
            char small[64];
            int n = sprintf(small, "{\"n\":%d}", i);
            if (post(rt, small, (size_t)n) != 0) return 1;
        }
    }
    long expected = 0, got = 0, bad = 0;
    uint64_t deadline = now_ms() + 20000;
    while (got < 2000 && now_ms() < deadline) {
        if (account_take(rt, "\"seq\":", &expected, &got, &bad,
                         (int)(deadline - now_ms())) != 0)
            break;
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
    if (post(rt2, "{\"n\":1}", 7) != 0) return 1;
    if (post(rt2, "{\"n\":2}", 7) != 0) return 1;
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
    if (post(rt, "{\"n\":1}", 7) != 0) return 1;
    char *json = NULL; size_t len = 0;
    if (take(rt, &json, &len, 2000) != 0) {
        fprintf(stderr, "[crash] 预热往返失败（通道未活？）\n");
        return 1;
    }
    qz_free_message(json);

    pthread_t t = killer_start(9);
    qz_wait_idle(rt);            /* EOF → 宿主侧线程自收主RT；调用线程只等收束 */
    pthread_join(t, NULL);

    /* I4 时序门：wait_idle 返回后、free 前，错误帧必须已在箱内。
     * 用 timeout=0 断言这个确定性：wait_idle 的 join 已与宿主侧线程终止同步，
     * 入箱（时序 G：先入箱、后置 shutting_down）必然发生在返回之前。写成
     * 2000ms 只能证明「2 秒内会到」，会放过任何把入箱推迟到 wait_idle 之后
     * 的重构（异步/timer 投递）。 */
    json = NULL;
    if (take(rt, &json, &len, 0) != 0 ||
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

/* ── ⑤ hung：SIGSTOP 冻结主RT，destroy 墙钟预算（冻结在库宿主侧线程）── */
static int mode_hung(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = kScriptEchoAlive;
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "[hung] qz_create failed\n"); return 1; }

    if (!procfs_available()) {
        fprintf(stderr, "[hung] SKIP ⑤: /proc 不可用，无法验证 SIGSTOP 是否生效"
                        "（不是断言失败，是这条断言在本环境测不了）\n");
        qz_destroy(rt);
        return 77;
    }

    pthread_t t = killer_start(19);   /* SIGSTOP：graceful 无响应 → 三级升级 */

    /* 见证 SIGSTOP 真的生效：killer 是「有界等待子进程出现 + system(pgrep)」，
     * 仍可能落到 destroy 之后——那样三级终止路径根本没被触发，dt 小是空过而非
     * 通过。**取证必须先成立，再开始计时**：原来这里是「睡 500ms + 查一次」，
     * 固定睡眠的余量全在 fork/system 的 IO 上，ASAN runner 上容易归零。 */
    char st = '?';
    int stopped = await_child_stopped(&st, 3000);
    if (!stopped)
        fprintf(stderr, "[hung] ⑤ 主RT 未进入 T（停止）态（最后一次读到 state=%c，"
                        "或子进程不可见）：SIGSTOP 未生效，本模式不算通过\n", st);

    uint64_t t0 = now_ms();
    qz_destroy(rt);                    /* 调用线程只置位+join；冻结在库线程 */
    uint64_t dt = now_ms() - t0;
    pthread_join(t, NULL);

    if (!stopped) return 1;
    /* 预算从 6000 收到 3000：库内三级终止的 graceful 档是
     * QZ_IPC_TERMINATE_TIMEOUT_MS = 2000ms（ipc_process.h），6000 是它的 3 倍，
     * 意味着阶梯退化到 ~5.5s 依然绿——这条断言证明的是「不会挂死」，不是「阶梯
     * 完整」。3000 = 2000 + 50% 余量：既给 Python/信号转发的调度留了余量，又不再
     * 能掩盖一整个档位的退化。 */
    if (dt > 3000) {
        fprintf(stderr, "[hung] ⑤ destroy 耗时 %llu ms（预算 3000；库内 graceful "
                        "档是 2000ms，6000 的旧预算等于放任 3 倍退化）\n",
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

    /* 首排干（timeout 0 纯轮询）即得三条 pre-ready 帧 = create 内已入箱，
     * 且按 1→2→3 顺序（单条断言检不出重放把 FIFO 倒过来）。 */
    char *json = NULL; size_t len = 0;
    for (long want = 1; want <= 3; want++) {
        json = NULL;
        if (take(rt, &json, &len, 0) != 0 ||
            parse_field(json, "\"pre\":") != want) {
            fprintf(stderr, "[replay] ⑥a pre-ready 第 %ld 条缺失/乱序（got=%s）\n",
                    want, json ? json : "<none>");
            if (json) qz_free_message(json);
            return 1;
        }
        qz_free_message(json);
    }

    /* create 线程侧（此处为主线程，pre 帧入箱发生在 create 内部重放）回发：
     * wake 若未先于读回调初始化，回发/重放路径直接崩溃（H1 绊线）。 */
    if (post(rt, "{\"n\":4242}", 10) != 0) return 1;
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
        if (post(rt, m, (size_t)n) != 0) return (void *)1;
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
    if (post(rt, "{\"n\":7}", 7) != 0) return 1;
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
    void *poster_err = NULL;
    if (pthread_create(&th, NULL, stress_poster, rt) != 0) {
        fprintf(stderr, "[fd] ⑦c pthread_create failed\n");
        return 1;
    }
    long got = 0, bad = 0, expected = 1000;
    uint64_t deadline = now_ms() + 10000;
    while (got < FD_STRESS && now_ms() < deadline) {
        /* ① 排干 */
        int drained = 1;
        while (drained) {
            drained = 0;
            while (account_take(rt, "\"seq\":", &expected, &got, &bad, 0) == 0)
                drained = 1;
            if (got >= FD_STRESS) break;
            /* ② 清 fd */
            fd_clear(fd);
            /* ③ 复核：①/② 之间到达的消息（链先于计数）必须在这里被看见并
             *    处理——这一步就是丢唤醒免疫的来源 */
            if (account_take(rt, "\"seq\":", &expected, &got, &bad, 0) == 0)
                continue;
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
    pthread_join(th, &poster_err);
    if (poster_err) {
        fprintf(stderr, "[fd] ⑦c poster 线程投递失败——收数断言会误导，指名到这里\n");
        return 1;
    }
    /* 尾排干：poll 超时也可能有已入链未取的 */
    while (account_take(rt, "\"seq\":", &expected, &got, &bad, 0) == 0) {}
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
        if (post(rt1, m, (size_t)n) != 0) return 1;
        n = sprintf(m, "{\"id\":%d}", 1000 + i);
        if (post(rt2, m, (size_t)n) != 0) return 1;
        if (i % 50 == 49) {
            char *p = big;
            p += sprintf(p, "{\"pong\":%d,\"pad\":\"", i);
            memset(p, 'y', 16 * 1024); p += 16 * 1024;
            *p++ = '"'; *p++ = '}'; *p = '\0';
            if (post(rt1, big, strlen(big)) != 0) return 1;
            n = sprintf(m, "{\"pong\":%d}", 2000 + i);
            if (post(rt2, m, (size_t)n) != 0) return 1;
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
                if (v < 0 || v != exp1++) bad1++;   /* v<0 = 非期望帧，照样计坏 */
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
                if (v < 0 || v != exp2++) bad2++;
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

    /* ⑧c 复核箱净：洪泛已排干，ping 回执若落箱即证明它没被拦在 C 层 */
    {
        char *j = NULL; size_t l = 0;
        if (take(rt1, &j, &l, 0) == 0) {
            fprintf(stderr, "[dual] ⑧c ping 后 rt1 邮箱非空（回执泄漏）: %s\n", j);
            qz_free_message(j);
            return 1;
        }
        if (take(rt2, &j, &l, 0) == 0) {
            fprintf(stderr, "[dual] ⑧c ping 后 rt2 邮箱非空（回执泄漏）: %s\n", j);
            qz_free_message(j);
            return 1;
        }
    }
    printf("[dual] ok ⑧c': 双实例 ping 后邮箱皆净（回执未泄漏进箱）\n");

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
    int rc;
    if (strcmp(mode, "basic") == 0)       rc = mode_basic();
    else if (strcmp(mode, "crash") == 0)  rc = mode_crash();
    else if (strcmp(mode, "hung") == 0)   rc = mode_hung();
    else if (strcmp(mode, "replay") == 0) rc = mode_replay();
    else if (strcmp(mode, "fd") == 0)     rc = mode_fd();
    else if (strcmp(mode, "dual") == 0)   rc = mode_dual();
    else {
        fprintf(stderr, "usage: %s <basic|crash|hung|replay|fd|dual>\n", argv[0]);
        return 2;
    }

    /* 子进程残留自查——**限定在本进程的子树上**。原先这条检查在 shell 脚本里，
     * 口径是 `pgrep -x qzjs-rt | wc -l`，数的是**整台机器**上所有 qzjs-rt：
     * 共享 runner 上别的 job 起一个就 AFTER > BEFORE 假红；反过来 pgrep 缺失时
     * 两边都是 0，这条检查静默变成永真。正确的口径只能是「我自己的孩子」，
     * 而那个信息只有本进程有（harness 内部本来就用 pgrep -P <own pid>）。
     * 77 = skip（环境测不了），不算残留。 */
    if (rc != 77) {
        char cmd[128];
        snprintf(cmd, sizeof cmd, "pgrep -P %d -x qzjs-rt", (int)getpid());
        FILE *fp = popen(cmd, "r");
        int leftover = 0;
        if (fp) {
            int p2;
            if (fscanf(fp, "%d", &p2) == 1) leftover = 1;
            pclose(fp);
        }
        if (leftover) {
            fprintf(stderr, "[%s] 残留未回收的 qzjs-rt 子进程（本进程子树内）\n",
                    mode);
            if (rc == 0) rc = 1;   /* 断言都过了也不能放过：真泄漏比断言更严重 */
        }
    }
    return rc;
}
