/*
 * CTL-2 本地端点 + target_path 前投的泄漏探针（ASAN/LSan 专用）
 *
 * 为什么需要它：test_nested_e2e.sh 里 `ctl --target-path` 走的正是
 * qz_control_endpoint_cmd 的 path 前投早返回，而那条路径曾经不 free(buf) /
 * free(correl)。它一直没被 ASAN 报出来，原因是 e2e 脚本用 kill -TERM 收
 * 宿主——LSan 只在正常退出的 atexit 里跑检查，收信号直接死就一封报告都不出。
 * 「测试没报」不等于「没漏」。本探针自己建运行时、当客户端、**正常 return**，
 * 让泄漏检查真的跑。
 *
 * 怎么证明探针真的走到了要验的那条分支（否则「什么都没跑到」也是绿的）：
 * 判据是**同一条命令在两条路径上结果不同**——
 *   A 不带 target_path → 命中本地，JS 求值成功 → 回执 ok:true；
 *   B 带 target_path=[1001,1001]（比本节点深）→ 走 §8.2 前投、投给不存在的
 *     槽位 → 谁都不执行 → 回执 TIMEOUT。
 * A 成功而 B 超时，就证明 target_path 确实把命令引离了本地，也就是走进了那条
 * 早返回。只断言「回执里有我的 correl」是不够的：本地路径也会登记回执、也会
 * 产出带 correl 的 TIMEOUT——那种断言下撤掉 target_path 探针照样绿。
 *
 * 另外两个必要条件：
 *   · socket 路径带 pid 并在 create 前 unlink（显式路径库不负责 unlink，
 *     固定全局名会与同机并发 job 互撞）；
 *   · 等回执用 poll 带 10s 上界，不用裸 read——回执靠 5s 后的 reaper 补，
 *     那条链断了裸 read 就永久阻塞，而 asan job 里这步没有外层 timeout 包裹。
 */
#include <qzjs/qzjs.h>

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
#define ENDPOINT_FMT "/tmp/qzjs-ctlprobe-%d.sock"

static void nap_ms(int ms) {
    struct timespec ts = { ms / 1000, (long)(ms % 1000) * 1000000L };
    nanosleep(&ts, NULL);
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
        done += (size_t)w;   /* 短写要继续写完，只判 < 0 是不对的 */
    }
    return 0;
}

/* 读一条换行分帧的回执；无上界地读是错的（见文件头）。 */
static int read_receipt(int fd, char *out, size_t cap) {
    struct pollfd pfd = { .fd = fd, .events = POLLIN };
    int pr = poll(&pfd, 1, 10000);
    if (pr <= 0 || !(pfd.revents & POLLIN)) return -1;
    ssize_t n = read(fd, out, cap - 1);
    if (n <= 0) return -1;
    out[n] = '\0';
    return 0;
}

int main(void) {
    char path[108];
    snprintf(path, sizeof path, ENDPOINT_FMT, (int)getpid());
    unlink(path);   /* 上一次被杀/崩溃留下的 socket 文件 */

    /* setInterval 让主RT 保持存活，否则 idle 自退、端点随之消失。 */
    qz_config_t cfg;
    qz_config_init(&cfg);
    cfg.initial_script = "setInterval(function () {}, 1000);";
    cfg.control_plane = QZ_CONTROL_LOCAL;
    cfg.control_pipe_path = path;
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "probe: qz_create failed\n"); return 1; }

    for (int i = 0; i < 100 && access(path, F_OK) != 0; i++) nap_ms(20);
    if (access(path, F_OK) != 0) {
        fprintf(stderr, "probe: endpoint not created at %s\n", path);
        qz_destroy(rt);
        return 1;
    }

    char buf[512];
    int rc = 0;

    /* A：本地命中 —— 应当成功执行。 */
    {
        int fd = connect_endpoint(path);
        if (fd < 0) { perror("connect"); rc = 1; goto out; }
        const char *cmd =
            "{\"op\":\"eval\",\"correl\":\"probe-local\",\"script\":\"'local-ok'\"}\n";
        if (send_all(fd, cmd) != 0 || read_receipt(fd, buf, sizeof buf) != 0) {
            fprintf(stderr, "probe: local command got no receipt\n");
            close(fd); rc = 1; goto out;
        }
        close(fd);
        if (!strstr(buf, "\"ok\":true") || !strstr(buf, "probe-local")) {
            fprintf(stderr, "probe: local command should have succeeded, got: %s\n", buf);
            rc = 1; goto out;
        }
        printf("[A] 本地命中 → ok:true（基线成立）\n");
    }

    /* B：带 target_path → 走 §8.2 前投，投给不存在的槽位 → 谁都不执行 → TIMEOUT。
     * A 成功而 B 超时，就是「命令确实被引离了本地」的正面证据。 */
    {
        int fd = connect_endpoint(path);
        if (fd < 0) { perror("connect"); rc = 1; goto out; }
        const char *cmd =
            "{\"op\":\"eval\",\"correl\":\"probe-1\",\"target_path\":[1001,1001],"
            "\"script\":\"'probe'\"}\n";
        if (send_all(fd, cmd) != 0 || read_receipt(fd, buf, sizeof buf) != 0) {
            fprintf(stderr,
                    "probe: forwarded command got no receipt within 10s — "
                    "path-forward path not exercised, leak check proves nothing\n");
            close(fd); rc = 1; goto out;
        }
        close(fd);
        if (!strstr(buf, "probe-1")) {
            fprintf(stderr, "probe: receipt does not carry our correl: %s\n", buf);
            rc = 1; goto out;
        }
        if (strstr(buf, "\"ok\":true")) {
            fprintf(stderr,
                    "probe: forwarded command succeeded — target_path did NOT divert "
                    "it, so the forward path was not exercised: %s\n", buf);
            rc = 1; goto out;
        }
        printf("[B] 带 target_path → %s（已引离本地，前投分支确实走到了）\n", buf);
    }

out:
    unlink(path);
    qz_destroy(rt);
    if (rc == 0) printf("probe: 前投分支已证实走到，下面是 LSan 的检查\n");
    return rc;   /* 正常退出 → LSan 的 atexit 检查会跑 */
}
