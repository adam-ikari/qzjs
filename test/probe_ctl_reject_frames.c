/*
 * CTL-2 端点**拒收路径**的帧级探针：每一条收到的帧都用真 JSON 解析器解析。
 *
 * 为什么必须用真解析器：这一批给端点加了两条拒收回帧（缺 correl / 保留命名
 * 空间），而第一版写出来的 -3 帧是**非法 JSON**——C 源码里写 \"qzjs\" 只让字符
 * 串里出现一个裸引号，拼进 JSON 就在第 53 列截断 error 串。整帧不可机读，客户端
 * 拿到的是解析异常而不是诊断。而 `qzjs-ctl` 一直没能发现它：ctl_cli.c 用
 * `strstr(resp, "\"ok\":true")` 判断成败，压根不解析 JSON。用 strstr 写的断言
 * 永远抓不到「JSON 非法」这一类——所以这里逐帧 cJSON_Parse，解析失败即红。
 *
 * 顺带锁住同源的另外三条（第一版都踩了）：
 *   · 帧尾**不能**自带 \n：qz_ctl_conn_write 无条件再补一个，于是多出一个**空
 *     帧**，按行分帧的客户端会读成零长帧然后 json.loads("") 抛异常。→ 断言
 *     读完预期帧之后连接上不再有多余字节。
 *   · path 前投到不存在的槽位必须**当场**回 NOT_FOUND：第一版直接 return rc，
 *     既没 ctl_unregister（回执条目赖到超时 reap）也没任何回执，客户端干等到超时。
 *   · `interrupt` 不带 correl 必须仍然生效：它是唯一不依赖回执配对的命令，早先
 *     correl 守卫排在原子标志置位之前，等于「不传 correl 连标志都置不上」。
 *
 * 判据用「一连接一条命令」，这也让「读完没有多余字节」这件事可判定。
 * 仅诊断用，不参与 ctest（需要真实 ISOLATED/THREAD 运行时才有端点）。
 */

#include <qzjs/qzjs.h>

#include "cJSON.h"

#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

/* 缓冲必须 ≤ sizeof(sun.sun_path)（108），否则 snprintf 到 sun_path 会触发
 * -Werror=format-truncation。 */
#define ENDPOINT_FMT "/tmp/qzjs-ctlreject-%d.sock"

static int g_fail;

static void nap_ms(int ms) {
    struct timespec ts = { ms / 1000, (long)(ms % 1000) * 1000000L };
    nanosleep(&ts, NULL);
}

static void fail(const char *what, const char *detail) {
    fprintf(stderr, "FAIL %s: %s\n", what, detail);
    g_fail = 1;
}

static int connect_endpoint(const char *path) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_un sa;
    memset(&sa, 0, sizeof sa);
    sa.sun_family = AF_UNIX;
    snprintf(sa.sun_path, sizeof sa.sun_path, "%s", path);
    if (connect(fd, (struct sockaddr *)&sa, sizeof sa) != 0) {
        close(fd);
        return -1;
    }
    return fd;
}

static int send_all(int fd, const char *s) {
    size_t len = strlen(s), done = 0;
    while (done < len) {
        ssize_t w = write(fd, s + done, len - done);
        if (w < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        done += (size_t)w;
    }
    return 0;
}

/* 读一帧（到 \n 为止），顺带把 out 后面可能存在的多余字节数量报出来。 */
static int read_frame(int fd, char *out, size_t cap, int wait_ms,
                      int *extra_bytes) {
    size_t used = 0;
    *extra_bytes = -1;
    for (;;) {
        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        int pr = poll(&pfd, 1, wait_ms);
        if (pr <= 0 || !(pfd.revents & POLLIN)) return used ? 0 : -1;
        if (used + 1 >= cap) return -1;
        /* 必须**逐字节**读。原来是一次 read() 一把取走、在第一个 \n 处返回：同一个
         * tick 里写出的两帧（NOT_FOUND + INTERNAL）会被一次读完放进缓冲区，返回时
         * 缓冲区里其实已经有第二帧，而调用方只看到 strlen 到第一个 \n —— 尾部被
         * 消费掉了，后面那个「读完还有没有多余字节」的检查于是**永远看不到第二帧**。
         * 这就是为什么「非 path 远端返回两帧」那个负控一度是绿的。 */
        ssize_t n = read(fd, out + used, 1);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) return used ? 0 : -1;      /* 对端关闭 */
        used += 1;
        out[used] = '\0';
        if (memchr(out, '\n', used)) return 0;   /* 一帧齐了 */
    }
}

/* 发一条命令、读一帧、逐项核对。label 只用于报错定位。 */
/* want_correl 非 NULL = 该帧必须回显**这个** correl（比对具体值，不只是「非空」：
 * 客户端是按 correl 配对的，回一个错的 correl 和没有一样无用——第一版只验非空，
 * 于是把回显换成任意字符串的负控照样绿）。NULL = 该帧不该有可用 correl。 */
static void expect_frame(const char *path, const char *label, const char *cmd,
                         const char *want_code, const char *want_correl,
                         int allow_extra_bytes) {
    char raw[1024];
    int extra = -1;
    int fd = connect_endpoint(path);
    if (fd < 0) { fail(label, "connect 失败"); return; }
    if (send_all(fd, cmd) != 0) { fail(label, "write 失败"); close(fd); return; }
    if (read_frame(fd, raw, sizeof raw, 3000, &extra) != 0) {
        fail(label, "3s 内没收到任何帧（静默失败——正是要消灭的形态）");
        close(fd);
        return;
    }
    /* 注意：close 必须在下面「多余字节」检查**之后**。原来它排在前面，于是那个检查
     * 作用在一个已关闭的 fd 上——poll 只回 POLLNVAL、`revents & POLLIN` 恒假，
     * `fd >= 0` 也恒真，整块是死代码：把帧尾的 \n 加回去探针照样全绿。而它恰恰是
     * 「帧尾多带 \n 会多出空帧」这条的唯一断言。 */
    if (raw[0] == '\0' || raw[0] == '\n') {
        fail(label, "收到**空帧**（帧尾多带了一个 \\n，qz_ctl_conn_write 会再补一个）");
        close(fd);
        return;
    }

    /* 关键：必须能被真解析器吃下去。 */
    cJSON *j = cJSON_Parse(raw);
    if (!j) {
        char why[256];
        snprintf(why, sizeof why, "非法 JSON，客户端拿到的是解析异常而非诊断: %.180s",
                 raw);
        fail(label, why);
        close(fd);
        return;
    }
    cJSON *code = cJSON_GetObjectItemCaseSensitive(j, "code");
    cJSON *ok = cJSON_GetObjectItemCaseSensitive(j, "ok");
    if (!cJSON_IsString(code) || !code->valuestring) {
        fail(label, "帧里没有字符串 code 字段");
        cJSON_Delete(j);
        close(fd);
        return;
    }
    if (strcmp(code->valuestring, want_code) != 0) {
        char why[256];
        snprintf(why, sizeof why, "code 期望 %s，实得 %s: %.140s", want_code,
                 code->valuestring, raw);
        fail(label, why);
        cJSON_Delete(j);
        close(fd);
        return;
    }
    if (!cJSON_IsFalse(ok)) {
        fail(label, "ok 字段不是 false（拒收/失败的帧必须显式 ok:false）");
        cJSON_Delete(j);
        close(fd);
        return;
    }
    if (want_correl) {
        cJSON *co = cJSON_GetObjectItemCaseSensitive(j, "correl");
        if (!cJSON_IsString(co) || !co->valuestring) {
            fail(label, "帧里没有字符串 correl 字段（客户端无从配对）");
        } else if (strcmp(co->valuestring, want_correl) != 0) {
            char why[256];
            snprintf(why, sizeof why, "correl 期望 %s，实得 %s", want_correl,
                     co->valuestring);
            fail(label, why);
        }
    } else {
        /* 缺 correl 的那条：字段应显式为 null，而不是省略——省略会让客户端分不清
         * 「这帧没有配对键」与「这帧格式坏了」。 */
        cJSON *co = cJSON_GetObjectItemCaseSensitive(j, "correl");
        if (!cJSON_IsNull(co)) {
            fail(label, "缺 correl 的帧应带 \"correl\":null，实际不是");
        }
    }
    cJSON_Delete(j);

    if (!allow_extra_bytes) {
        /* 再等一会儿看还有没有别的字节。空帧就是靠这条抓到的。 */
        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        if (poll(&pfd, 1, 200) > 0 && (pfd.revents & POLLIN)) {
            char junk[512];
            ssize_t n = read(fd, junk, sizeof junk);
            if (n > 0) {
                char why[320];
                snprintf(why, sizeof why,
                         "读完预期帧后连接上还有 %zd 字节（同一命令收到多帧，或帧尾多余"
                         "的 \\n 造成的空帧）: %.180s", n, junk);
                fail(label, why);
            }
        }
    }
    close(fd);
    printf("  ok  %-22s code=%s\n", label, want_code);
}

int main(void) {
    char path[108];
    snprintf(path, sizeof path, ENDPOINT_FMT, (int)getpid());
    unlink(path);

    /* setInterval 保住主RT，否则 idle 自退、端点随之消失。 */
    qz_config_t cfg = {0};
    cfg.initial_script = "setInterval(function () {}, 1000);";
    cfg.control_plane = QZ_CONTROL_LOCAL;
    cfg.control_pipe_path = path;
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "FAIL: qz_create 失败\n"); return 1; }

    for (int i = 0; i < 100 && access(path, F_OK) != 0; i++) nap_ms(20);
    if (access(path, F_OK) != 0) {
        fprintf(stderr, "FAIL: 端点没在 %s 建起来\n", path);
        qz_destroy(rt);
        return 1;
    }

    /* 1. 缺 correl → -2 → INVALID_ARG，correl 显式为 null（无从回显）。 */
    expect_frame(path, "缺 correl", "{\"op\":\"eval\",\"script\":\"'x'\"}\n",
                 "INVALID_ARG", NULL, 0);

    /* 2. 带 correl 但用了保留的数字 qzjs 命名空间 → -3 → INVALID_ARG。
     *    这一帧第一版是**非法 JSON**（裸引号截断 error 串），所以这里必须靠
     *    cJSON_Parse 才抓得到。 */
    /* 2. 带 correl 但用了保留的数字 qzjs 命名空间 → -3 → INVALID_ARG。
     *    这一帧第一版是**非法 JSON**（裸引号截断 error 串），所以这里必须靠
     *    cJSON_Parse 才抓得到。
     *    want_correl_echo=1：这条命令的 correl 是拿得到的（先校验它非空、再判命名
     *    空间），而协议按 correl 配对——一帧不带 correl 的拒收回执对客户端毫无用处。 */
    expect_frame(path, "保留命名空间",
                 "{\"op\":\"eval\",\"correl\":\"rev3\",\"qzjs\":1,"
                 "\"script\":\"'x'\"}\n",
                 "INVALID_ARG", "rev3", 0);

    /* 3. target_path 指向不存在的槽位 → 当场 NOT_FOUND（带 correl 可配对），
     *    而不是干等到 5s 后的 TIMEOUT。 */
    expect_frame(path, "前投无此槽位",
                 "{\"op\":\"eval\",\"correl\":\"nf1\","
                 "\"target_path\":[1001,1001],\"script\":\"'x'\"}\n",
                 "NOT_FOUND", "nf1", 0);

    /* 3b. 非 path 的远端 target（不是 target_path）指向不存在的槽位：同样当场
     * NOT_FOUND，且**只此一帧**。这里锁的是 S2：那个分支原先在写了 NOT_FOUND 之后
     * `return rc`（= -1），端点的兜底分支于是再发一帧 INTERNAL——客户端对同一条
     * 命令收到两帧，而契约表里 -5 写的是「已写出、别再发」。 */
    expect_frame(path, "非 path 远端无此槽位",
                 "{\"op\":\"eval\",\"correl\":\"np1\",\"target\":9999,"
                 "\"script\":\"'x'\"}\n",
                 "NOT_FOUND", "np1", 0);

    /* 4. interrupt 不带 correl：不得被拒，而且**自己不得产出任何帧**。
     *
     *    这条断言分两半，缺一不可：
     *      (a) 不被拒 —— 随后的正常命令要能回 ok:true。
     *      (b) 不产 correl="" 的孤儿回执 —— 「correl 必填」那道守卫存在的全部
     *          理由。interrupt 无 correl 时若继续往下走（登记空键条目 + 入队），
     *          dispatch 的 interrupt 分支会产一条 correl="" 的回执投进宿主邮箱。
     *          早先只验了 (a)：那时 (b) 其实是坏的，探针却绿着。
     *    判据 (b)：把邮箱彻底读干净，再等一会儿（跨过 reaper 的 reap 周期），
     *    期间**一帧都不该出现**。 */
    {
        char raw[1024];
        int extra = -1;
        int fd = connect_endpoint(path);
        if (fd < 0) {
            fail("interrupt 无 correl", "connect 失败");
        } else {
            if (send_all(fd, "{\"op\":\"interrupt\"}\n") != 0)
                fail("interrupt 无 correl", "write 失败");
            /* interrupt 不该回任何东西；留 800ms 窗口就是为了把它的帧等出来。 */
            if (read_frame(fd, raw, sizeof raw, 800, &extra) == 0) {
                char why[256];
                snprintf(why, sizeof why,
                         "interrupt 不该产出回执，却收到一帧: %.140s", raw);
                fail("interrupt 无 correl", why);
            }
            close(fd);

            /* 后续正常命令照常回执 → 运行时没被 interrupt 搞坏。 */
            fd = connect_endpoint(path);
            if (fd < 0) {
                fail("interrupt 无 correl", "第二次 connect 失败");
            } else {
                if (send_all(fd, "{\"op\":\"eval\",\"correl\":\"ok1\","
                                  "\"script\":\"'fine'\"}\n") != 0 ||
                    read_frame(fd, raw, sizeof raw, 3000, &extra) != 0) {
                    fail("interrupt 无 correl",
                         "后续正常命令没回执（interrupt 把连接/运行时搞坏了？）");
                } else {
                    cJSON *j = cJSON_Parse(raw);
                    cJSON *ok = j ? cJSON_GetObjectItemCaseSensitive(j, "ok") : NULL;
                    if (!j || !cJSON_IsTrue(ok))
                        fail("interrupt 无 correl",
                             "后续命令回的不是 ok:true（说明 interrupt 被当成拒收）");
                    else
                        printf("  ok  %-22s 未被拒收、未产孤儿回执\n",
                               "interrupt 无 correl");
                    if (j) cJSON_Delete(j);
                }
                close(fd);
            }
        }
    }

    unlink(path);
    qz_destroy(rt);
    if (g_fail) {
        fprintf(stderr, "probe: 有 %d 项不符\n", g_fail);
        return 1;
    }
    printf("probe: 拒收路径的帧全部合法且可配对\n");
    return 0;
}
