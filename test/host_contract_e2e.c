/*
 * 宿主形态的端到端验证：按文档写出来的消费循环，在真实 ISOLATED 构建上跑通。
 *
 * 为什么要有这个（已有的 8 支 e2e 都没覆盖它）：
 *   · 既有 e2e 的 harness 是**测试专用**宿主，跑的是各自那一条断言。而宿主真正会做
 *     的事——照 `docs/{,zh/}c-api/runtime.md`「邮箱」节那段循环收发——没有任何一支
 *     e2e 在验。文档门只保证那段代码**能编译**，不保证它**行为正确**。
 *   · 这一支专门验三件宿主一定会遇到、而既有覆盖漏掉的事：
 *       1. 收侧循环在三态（0 取到 / 1 超时 / -1 错误）下不会把 -1 当成「没消息」，
 *          也不会提前 break——收满 N 条就收工，箱必须真的排空。
 *       2. 顺序：N 条消息按投递序到达（FIFO 契约在真进程 + 真 eventfd 下仍然成立）。
 *       3. **交接**：宿主自己的 eventfd（qz_message_fd）+ poll 驱动的循环，
 *          与「阻塞在 qz_recv_message」这条路径**得到同一批消息**。这是 M-P7
 *          「宿主什么都不用驱动，但可以用自己的 fd 等待」的直接验证。
 *
 * 它同时是 docs 里那段示例的 dogfood：两边的判别式（`"type":"error"`）必须一致，
 * 少一侧漂移就会在 `test/docs_e2e_alignment.sh` 的对齐检查里被抓到。
 *
 * 用法：host_contract_e2e <path-to-qzjs>
 *   必须在 QZ_BUILD_TESTS=OFF 的真实 ISOLATED 构建上跑（需要 qzjs-rt）。
 */

#include <qzjs/qzjs.h>

#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>

static int g_fail;

static void fail(const char *what, const char *detail) {
    fprintf(stderr, "FAIL %s: %s\n", what, detail ? detail : "");
    g_fail = 1;
}

/* qz_now_ms 是内部 API（qz_internal.h），宿主程序拿不到——这里用本地单调钟。
 * 顺带说明：这本身就是一条契约事实，公共头里没有暴露任何计时函数。 */
static int64_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* 文档循环的形状：库的错误帧要认出来并跳过，**不 break**；三态分开判。 */
static int collect(qz_t *rt, char want[][32], int want_n, int budget_ms,
                   int *out_errors) {
    int got = 0;
    int64_t deadline = now_ms() + budget_ms;
    for (;;) {
        int wait = (int)(deadline - now_ms());
        if (wait <= 0) break;
        char *json = NULL;
        size_t len = 0;
        int r = qz_recv_message(rt, &json, &len, wait);
        if (r < 0) {                       /* -1 = 参数/状态错误，不是「没消息」 */
            fail("qz_recv_message", "返回 -1（参数/状态错误）被当成没消息处理");
            qz_free_message(json);
            return got;
        }
        if (r == 1) break;                  /* 1 = 超时，本轮收工 */
        if (strstr(json, "\"type\":\"error\"")) {
            /* 库的错误帧：认出来、跳过，**继续排干**（文档承诺不要 break） */
            (*out_errors)++;
            qz_free_message(json);
            continue;
        }
        if (got < want_n) snprintf(want[got], 32, "%.*s", (int)len, json);
        got++;
        qz_free_message(json);
    }
    return got;
}

static void post_n(qz_t *rt, int n) {
    for (int i = 1; i <= n; i++) {
        char m[32];
        int k = snprintf(m, sizeof m, "{\"n\":%d}", i);
        if (qz_post_message(rt, m, (size_t)k) != 0)
            fail("qz_post_message", "投递失败");
    }
}

int main(int argc, char **argv) {
    const int kN = 40;
    const char *am = argc > 1 ? argv[1] : "./build_rt/qzjs";
    (void)am;
    char (*got)[32] = calloc((size_t)kN, 32);
    if (!got) return 1;

    /* ── 路径 1：文档循环，阻塞在 qz_recv_message ── */
    {
        qz_config_t cfg = {0};
        cfg.initial_script = "onmessage = function (e) { postMessage(e.data); };";
        qz_t *rt = qz_create(&cfg);
        if (!rt) { fprintf(stderr, "FAIL: qz_create 失败\n"); return 1; }
        post_n(rt, kN);
        int errors = 0;
        int n = collect(rt, got, kN, 8000, &errors);
        if (n != kN) {
            char b[64];
            snprintf(b, sizeof b, "期望 %d 条，实际 %d 条", kN, n);
            fail("路径 1 收满", b);
        } else {
            /* 顺序：第 i 位**就是** {"n":i+1}。
             * 原写法是 `if (!contains(got, n, want) && strcmp(got[i], want) != 0)`——
             * contains 扫的是整个数组，而上面已经断言过 40 条一条不少，于是每条 want
             * 都「存在」，!contains 恒假、&& 短路，**这个失败分支永远不执行**。也就是
             * 说它唯一该抓的「顺序错乱但内容齐全」恰恰抓不到：真顺序坏了也不会红。
             * 顺序就是拿位置比，没有更间接的写法。 */
            for (int i = 0; i < kN; i++) {
                char want[32];
                snprintf(want, sizeof want, "{\"n\":%d}", i + 1);
                if (strcmp(got[i], want) != 0) {
                    char b[96];
                    snprintf(b, sizeof b, "第 %d 位是 %s，期望 %s", i, got[i], want);
                    fail("路径 1 顺序", b);
                    break;
                }
            }
            /* 正交的一条：每个期望值**恰好出现一次**（不重不漏）。它能抓到
             * 「一条重复、另一条丢失」——那种情况总条数仍对、位置检查也会因错位
             * 而红，但报错会指向顺序而不是重复，定位成本不同。 */
            for (int i = 0; i < kN; i++) {
                char want[32];
                snprintf(want, sizeof want, "{\"n\":%d}", i + 1);
                int hits = 0;
                for (int j = 0; j < n; j++) if (strcmp(got[j], want) == 0) hits++;
                if (hits != 1) {
                    char b[96];
                    snprintf(b, sizeof b, "{\"n\":%d} 出现 %d 次（应为 1）", i + 1, hits);
                    fail("路径 1 不重不漏", b);
                    break;
                }
            }
            printf("  ok  路径1 收满 %d 条、按投递序、不重不漏\n", n);
        }
        /* 箱必须真的排空：再收一轮应当只剩超时 */
        int again = collect(rt, got, 0, 400, &errors);
        (void)errors;
        if (again != 0) {
            char b[64];
            snprintf(b, sizeof b, "收满之后又收到 %d 条（邮箱没排空）", again);
            fail("路径 1 箱净", b);
        } else {
            printf("  ok  路径1 收满后邮箱为空\n");
        }
        qz_destroy(rt);
    }

    /* ── 路径 2：宿主自己的 eventfd + poll（qz_message_fd 契约）── */
    {
        qz_config_t cfg = {0};
        cfg.initial_script = "onmessage = function (e) { postMessage(e.data); };";
        qz_t *rt = qz_create(&cfg);
        if (!rt) { fprintf(stderr, "FAIL: qz_create 失败（路径 2）\n"); return 1; }
        int fd = qz_message_fd(rt);
        if (fd < 0) {
            fail("qz_message_fd", "取不到宿主等待 fd");
        } else {
            post_n(rt, kN);
            int got2 = 0;
            int64_t deadline = now_ms() + 8000;
            for (;;) {
                int wait = (int)(deadline - now_ms());
                if (wait <= 0) break;
                struct pollfd pfd = { .fd = fd, .events = POLLIN };
                int pr = poll(&pfd, 1, wait);
                if (pr < 0) {
                    if (errno == EINTR) continue;
                    fail("poll", "返回负值");
                    break;
                }
                if (pr == 0) break;                    /* 超时 */
                char *json = NULL;
                size_t len = 0;
                /* 可读提示之后**不一定**就有消息（丢唤醒免疫），所以要真去收。 */
                int r = qz_recv_message(rt, &json, &len, 0);
                if (r < 0) { fail("qz_recv_message", "路径 2 返回 -1"); break; }
                while (r == 0) {
                    if (!strstr(json, "\"type\":\"error\"")) got2++;
                    qz_free_message(json);
                    json = NULL;
                    r = qz_recv_message(rt, &json, &len, 0);
                }
                if (r < 0) { fail("qz_recv_message", "路径 2 内层返回 -1"); break; }
                if (got2 >= kN) break;
            }
            if (got2 != kN) {
                char b[64];
                snprintf(b, sizeof b, "期望 %d 条，实际 %d 条", kN, got2);
                fail("路径 2 收满", b);
            } else {
                printf("  ok  路径2（宿主 eventfd + poll）收满 %d 条\n", got2);
            }
        }
        qz_destroy(rt);
    }

    /* ── 路径 3：wait_idle 之后仍可排干（最终排干的位置就在那里）── */
    {
        qz_config_t cfg = {0};
        cfg.initial_script = "onmessage = function (e) { postMessage(e.data); };";
        qz_t *rt = qz_create(&cfg);
        if (!rt) { fprintf(stderr, "FAIL: qz_create 失败（路径 3）\n"); return 1; }
        post_n(rt, 5);
        qz_wait_idle(rt);                 /* 阻塞到主执行体退出 */
        int errors = 0;
        int n = collect(rt, got, 5, 3000, &errors);
        if (n < 5) {
            char b[64];
            snprintf(b, sizeof b, "wait_idle 之后只收到 %d/5 条", n);
            fail("路径 3 wait_idle 后排干", b);
        } else {
            printf("  ok  路径3 wait_idle 之后仍排干到 %d 条\n", n);
        }
        qz_free(rt);
    }

    free(got);
    if (g_fail) { fprintf(stderr, "host_contract_e2e: 有 %d 项不符\n", g_fail); return 1; }
    printf("PASS: 宿主消费契约（文档循环 / eventfd 交接 / wait_idle 后排干）全部成立\n");
    return 0;
}
