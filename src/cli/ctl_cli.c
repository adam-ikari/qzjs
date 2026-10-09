/*
 * qzjs-ctl — 控制面本地端点客户端（CTL-2, §2.3）
 *
 * 连上运行中 qzjs 的 AF_UNIX 控制端点，按「一行一条命令」发 JSON，读回一行
 * 回执并打印。命令面与 CTL-0 相同：eval / inspect / metrics / interrupt；
 * 也支持 --json 直发任意命令 JSON（含 "target" 寻址字段，CTL-1 树路由）。
 *
 * Usage:
 *   qzjs-ctl --pipe <path> [--target N] [--timeout-ms N] eval '<script>'
 *   qzjs-ctl --pipe <path> [--target N] [--timeout-ms N] inspect '<expr>'
 *   qzjs-ctl --pipe <path> metrics
 *   qzjs-ctl --pipe <path> interrupt
 *   qzjs-ctl --pipe <path> [--target N] --json '<command JSON>'
 *
 * 退出码：0 = 收到 ok:true 回执；1 = 连接/写读失败或回执 ok:false；2 = 用法错。
 * 设计：docs/plans/2026-09-04-control-plane-design.md §2.3、§6 CTL-2。
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <poll.h>
#include <time.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/un.h>

#define CTL_RESP_MAX (1u << 20)

static void usage(FILE *out)
{
    fprintf(out,
        "Usage: qzjs-ctl --pipe <path> [options] <command>\n"
        "       qzjs-ctl --pipe <path> [options] --json '<command JSON>'\n"
        "\n"
        "Options:\n"
        "  --pipe <path>        control endpoint path (required)\n"
        "  --target <n>         tree-routing target (default 1 = main runtime;\n"
        "                       >1 = that node's local child slot, i.e. a worker)\n"
        "  --timeout-ms <n>     command timeout (default 5000)\n"
        "  --correl <id>        correlation id (default auto: ctl-<pid>-<n>)\n"
        "  -h, --help           show this help\n"
        "\n"
        "Commands:\n"
        "  eval <script>        evaluate in the target runtime\n"
        "  inspect <expr>       JSON-serialize an expression\n"
        "  metrics              runtime statistics\n"
        "  interrupt            stop a running script (uncatchable)\n");
}

/* JSON 字符串转义（"、\\、控制字符）。返回 malloc 串，失败 NULL。 */
static char *json_escape(const char *s)
{
    size_t n = strlen(s);
    char *out = (char *)malloc(n * 6 + 3);
    if (!out) return NULL;
    size_t o = 0;
    out[o++] = '"';
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        switch (*p) {
        case '"':  out[o++] = '\\'; out[o++] = '"'; break;
        case '\\': out[o++] = '\\'; out[o++] = '\\'; break;
        case '\n': out[o++] = '\\'; out[o++] = 'n'; break;
        case '\r': out[o++] = '\\'; out[o++] = 'r'; break;
        case '\t': out[o++] = '\\'; out[o++] = 't'; break;
        default:
            if (*p < 0x20) {
                static const char hex[] = "0123456789abcdef";
                out[o++] = '\\'; out[o++] = 'u'; out[o++] = '0'; out[o++] = '0';
                out[o++] = hex[(*p >> 4) & 0xf];
                out[o++] = hex[*p & 0xf];
            } else {
                out[o++] = (char)*p;
            }
        }
    }
    out[o++] = '"';
    out[o] = '\0';
    return out;
}

static int connect_endpoint(const char *path)
{
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof addr);
    addr.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof addr.sun_path) {
        fprintf(stderr, "qzjs-ctl: endpoint path too long\n");
        close(fd);
        return -1;
    }
    memcpy(addr.sun_path, path, strlen(path) + 1);
    if (connect(fd, (struct sockaddr *)&addr, sizeof addr) != 0) {
        fprintf(stderr, "qzjs-ctl: connect '%s' failed: %s\n", path,
                strerror(errno));
        close(fd);
        return -1;
    }
    return fd;
}

static int write_all(int fd, const char *buf, size_t len)
{
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, buf + off, len - off);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        off += (size_t)n;
    }
    return 0;
}

/* 读一行回执（换行分帧）；返回 0 成功并把整行写进 out（不含换行）。
 * budget_ms 为总预算：用尽即失败——控制命令在目标 runtime 不可达安全点
 * （脚本死循环、DAP 暂停在 configuration 等）时不会有回执，客户端必须
 * 自己收束，不能永久阻塞（§1.3「不可达 safepoint」）。 */
static int read_line(int fd, char *out, size_t cap, int budget_ms)
{
    size_t o = 0;
    long long start = 0;
    for (;;) {
        int remain = budget_ms;
        if (start) {
            struct timespec ts;
            clock_gettime(CLOCK_MONOTONIC, &ts);
            long long now = (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
            remain = budget_ms - (int)(now - start);
            if (remain <= 0) return -1;
        } else {
            struct timespec ts;
            clock_gettime(CLOCK_MONOTONIC, &ts);
            start = (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
        }
        struct pollfd pfd;
        pfd.fd = fd;
        pfd.events = POLLIN;
        pfd.revents = 0;
        int pr = poll(&pfd, 1, remain);
        if (pr == 0) return -1;                 /* 预算用尽 */
        if (pr < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (o + 1 >= cap) return -1;            /* 回执超长 */
        ssize_t n = read(fd, out + o, 1);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) return o > 0 ? 0 : -1;      /* EOF */
        if (out[o] == '\n') { out[o] = '\0'; return 0; }
        o++;
    }
}

int main(int argc, char **argv)
{
    const char *pipe_path = NULL;
    const char *json_cmd = NULL;
    const char *op = NULL;
    const char *arg = NULL;
    long target = -1;
    long timeout_ms = 5000;
    char correl[64];
    const char *target_path = NULL;   /* "k1,k2,..." → JSON target_path 数组 */

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-h") || !strcmp(argv[i], "--help")) {
            usage(stdout);
            return 0;
        } else if (!strcmp(argv[i], "--pipe") && i + 1 < argc) {
            pipe_path = argv[++i];
        } else if (!strcmp(argv[i], "--target") && i + 1 < argc) {
            target = strtol(argv[++i], NULL, 10);
        } else if (!strcmp(argv[i], "--timeout-ms") && i + 1 < argc) {
            timeout_ms = strtol(argv[++i], NULL, 10);
        } else if (!strcmp(argv[i], "--target-path") && i + 1 < argc) {
            target_path = argv[++i];
        } else if (!strcmp(argv[i], "--correl") && i + 1 < argc) {
            snprintf(correl, sizeof correl, "%s", argv[++i]);
        } else if (!strcmp(argv[i], "--json") && i + 1 < argc) {
            json_cmd = argv[++i];
        } else if (!op) {
            op = argv[i];
        } else if (!arg) {
            arg = argv[i];
        } else {
            usage(stderr);
            return 2;
        }
    }

    if (!pipe_path) { usage(stderr); return 2; }
    if (!json_cmd && !op) { usage(stderr); return 2; }
    if (correl[0] == '\0')
        snprintf(correl, sizeof correl, "ctl-%ld-%ld", (long)getpid(),
                 (long)(timeout_ms % 100000));

    /* 组装命令行 JSON（控制面通用字段：op/correl/timeout_ms；CTL-1 寻址
     * 字段 target 由 C 层提取，路由器不解 payload）。 */
    char *line = NULL;
    if (json_cmd) {
        line = strdup(json_cmd);
    } else {
        const char *field = NULL;
        if (!strcmp(op, "eval")) field = "script";
        else if (!strcmp(op, "inspect")) field = "expr";
        else if (strcmp(op, "metrics") != 0 && strcmp(op, "interrupt") != 0) {
            usage(stderr);
            return 2;
        }
        char *esc = NULL;
        if (field) {
            if (!arg) { usage(stderr); return 2; }
            esc = json_escape(arg);
            if (!esc) return 1;
        }
        size_t cap = (esc ? strlen(esc) : 0) + 192;
        line = (char *)malloc(cap);
        if (line) {
            int n = snprintf(line, cap,
                             "{\"op\":\"%s\",\"correl\":\"%s\",\"timeout_ms\":%ld",
                             op, correl, timeout_ms);
            if (target > 0 && n > 0 && (size_t)n < cap)
                n += snprintf(line + n, cap - (size_t)n,
                              ",\"target\":%ld", target);
            if (target_path && n > 0 && (size_t)n < cap)
                n += snprintf(line + n, cap - (size_t)n,
                              ",\"target_path\":[%s]", target_path);
            if (field && n > 0 && (size_t)n < cap)
                n += snprintf(line + n, cap - (size_t)n, ",\"%s\":%s",
                              field, esc);
            if (n > 0 && (size_t)n < cap)
                snprintf(line + n, cap - (size_t)n, "}");
            else
                line[cap - 1] = '\0';
        }
        free(esc);
    }

    if (!line) {
        fprintf(stderr, "qzjs-ctl: out of memory\n");
        return 1;
    }

    int fd = connect_endpoint(pipe_path);
    if (fd < 0) { free(line); return 1; }

    int rc = 1;
    size_t llen = strlen(line);
    if (write_all(fd, line, llen) != 0 || write_all(fd, "\n", 1) != 0) {
        fprintf(stderr, "qzjs-ctl: write failed: %s\n", strerror(errno));
        goto done;
    }

    char resp[CTL_RESP_MAX];
    if (read_line(fd, resp, sizeof resp, (int)timeout_ms + 2000) != 0) {
        fprintf(stderr,
                "qzjs-ctl: no receipt within %ldms (command timeout, target "
                "not at a safepoint, or endpoint closed)\n",
                timeout_ms + 2000);
        goto done;
    }
    printf("%s\n", resp);
    rc = (strstr(resp, "\"ok\":true") != NULL) ? 0 : 1;

done:
    close(fd);
    free(line);
    return rc;
}
