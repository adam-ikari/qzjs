/*
 * qzjs Control Plane — 本地端点（CTL-2, §2.3）
 *
 * config.control_plane=LOCAL 时 runtime 在本机监听一个 uv_pipe（AF_UNIX）：
 * 外部控制器（qzjs-ctl）连上后按「一行一条命令」发 JSON，回执按 correl 配对
 * 写回同一连接。端点只是生产者——收到的字节走 qz_control_sink 同一入口，
 * 不引入第二执行路径（与 qz_control 共用登记/派发/回执机制）。
 *
 * 认证（§4.2）：unix pipe 文件权限即认证——socket 0600 + SO_PEERCRED 校验
 * peer uid 与 owner 一致，异 uid connect 直接断。首版无 token、无 ACL。
 *
 * 设计：docs/plans/2026-09-04-control-plane-design.md §2.3、§4.2、§6 CTL-2。
 * 仅真实 libuv 构建编入（mock 构建无 uv_pipe；见 CMakeLists）。
 */

#include "base/qz_rt.h"

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdio.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/stat.h>

/* struct ucred / SO_PEERCRED 是 Linux 内核 ABI。<sys/socket.h> 只在
 * _GNU_SOURCE 下暴露该结构，而本项目编译带 _POSIX_C_SOURCE（严格 C99），
 * 故此处按内核 ABI 本地声明（layout 稳定；端点本就 Linux-only，§7）。 */
#ifndef SO_PEERCRED
#define SO_PEERCRED 17
#endif
struct qz_peercred {
    pid_t pid;
    uid_t uid;
    gid_t gid;
};

/* 缺省端点路径序号（进程内唯一，供 /tmp/qzjs-<pid>-<n>.ctl）。 */
static unsigned g_ctl_seq;

struct qz_ctl_conn_s {
    uv_pipe_t pipe;
    qz_t   *rt;
    char     *buf;              /* 换行分帧累积缓冲 */
    size_t    len;
    size_t    cap;
    int       closed;
    struct qz_ctl_conn_s *next;
};

/* ── 回执写回（loop 线程独占） ── */

static void conn_write_cb(uv_write_t *req, int status)
{
    QZ_UNUSED(status);
    free(req->data);            /* uv_buf_t.base（malloc 缓冲） */
    free(req);
}

void qz_ctl_conn_write(void *conn_v, const char *json, size_t len)
{
    struct qz_ctl_conn_s *c = (struct qz_ctl_conn_s *)conn_v;
    if (!c || c->closed || !json) return;
    char *out = (char *)malloc(len + 2);
    if (!out) return;
    memcpy(out, json, len);
    out[len] = '\n';            /* 换行分帧：一行一条回执 */
    uv_write_t *req = (uv_write_t *)malloc(sizeof *req);
    if (!req) { free(out); return; }
    req->data = out;
    uv_buf_t b = uv_buf_init(out, (unsigned)(len + 1));
    if (uv_write(req, (uv_stream_t *)&c->pipe, &b, 1, conn_write_cb) != 0) {
        free(out);
        free(req);
    }
}

/* ── 连接生命周期 ── */

static void conn_unlink(qz_t *rt, struct qz_ctl_conn_s *c)
{
    struct qz_ctl_conn_s **pp = &rt->ctl_conns;
    while (*pp) {
        if (*pp == c) { *pp = c->next; return; }
        pp = &(*pp)->next;
    }
}

static void conn_close_cb(uv_handle_t *h)
{
    struct qz_ctl_conn_s *c = (struct qz_ctl_conn_s *)h->data;
    free(c->buf);
    free(c);
}

static void conn_close(struct qz_ctl_conn_s *c)
{
    if (c->closed) return;
    c->closed = 1;
    uv_read_stop((uv_stream_t *)&c->pipe);
    /* 清理其名下未完成回执条目：条目 sink 悬垂会导致回执写 UAF。 */
    qz_ctl_conn_drop(c->rt, c);
    conn_unlink(c->rt, c);
    c->pipe.data = c;
    uv_close((uv_handle_t *)&c->pipe, conn_close_cb);
}

static void conn_alloc_cb(uv_handle_t *h, size_t suggested, uv_buf_t *b)
{
    QZ_UNUSED(h);
    size_t n = suggested > 0 ? suggested : 4096;
    b->base = (char *)malloc(n);
    b->len = b->base ? (unsigned)n : 0;
}

static void conn_read_cb(uv_stream_t *s, ssize_t nread, const uv_buf_t *b)
{
    struct qz_ctl_conn_s *c = (struct qz_ctl_conn_s *)s->data;
    if (nread < 0) {            /* EOF/错误：客户端断开 */
        free(b->base);
        conn_close(c);
        return;
    }
    if (nread == 0) { free(b->base); return; }

    size_t need = c->len + (size_t)nread;
    if (need > c->cap) {
        size_t ncap = c->cap ? c->cap : 4096;
        while (ncap < need) ncap *= 2;
        char *nb = (char *)realloc(c->buf, ncap);
        if (!nb) { free(b->base); conn_close(c); return; }
        c->buf = nb;
        c->cap = ncap;
    }
    memcpy(c->buf + c->len, b->base, (size_t)nread);
    c->len += (size_t)nread;
    free(b->base);

    /* 换行分帧：完整行 → 端点命令入口（同一执行路径 + target 树路由）。 */
    size_t start = 0;
    for (size_t i = 0; i < c->len; i++) {
        if (c->buf[i] != '\n') continue;
        size_t llen = i - start;
        if (llen > 0) {
            /* 拒收（缺 correl / 保留命名空间）必须回一句话，不能默默吞掉。
             * 同一个文件里的兄弟分支对「无此 target」是会写 NOT_FOUND 回执的，
             * 两处自相矛盾；而「没有回执、没有错误帧、连接也不关」正是这批改动
             * 要消灭的静默失败——客户端只会一直等到自己超时。
             *
             * 只为**专用拒收码**回帧（-2 缺 correl / -3 保留命名空间）。别的非零
             * 码不是拒收：path 前投的 ctl_forward 对「无此槽位」也返回 -1，那条
             * 路由 qz_control_endpoint_cmd 内部自己回 NOT_FOUND（见 control.c），
             * 这里再发一条就成了误导。
             *
             * 两条纪律，都是被实测打出来的：
             *  · **不带尾 \n**。qz_ctl_conn_write 无条件在末尾补一个 \n（换行分
             *    帧）。字面量里再带一个就多出一个**空帧**，按行分帧的客户端会把它
             *    读成一条零长帧，然后 json.loads("") 抛异常。同文件 control.c 的
             *    NOT_FOUND 帧用 snprintf、不带尾换行，就是这个约定。
             *  · **纯 ASCII，且 JSON 转义层数要对**。C 源码里写 \" 只让字符串里
             *    出现一个裸 "，拼进 JSON 会在此处截断 error 串——整帧变成非法
             *    JSON，客户端拿到的是解析异常而不是诊断（这正是第一版写错的地方：
             *    json.loads 在第 53 列就失败）。嵌引号在 C 记法里要写 \\\"，
             *    即 JSON 层面的 \"。非 ASCII（em-dash）也换成 ASCII：裸 UTF-8 在
             *    JSON 串里虽合法，但对端按 Latin-1 解码就是乱码。
             *  · -3 的 correl 是拿得到的（control.c 先校验它非空、再判命名空间），
             *    所以经 correl_out 出参取出来、回显在帧里；-2 取不到，帧里写
             *    "correl":null，让客户端分得清「这帧没有配对键」与「这帧格式坏了」。 */
            char *rej_correl = NULL;
            int r = qz_control_endpoint_cmd(c->rt, c->buf + start, llen, c,
                                             &rej_correl);
            if (r == -2) {
                static const char kNoCorrel[] =
                    "{\"ctl\":true,\"ok\":false,"
                    "\"error\":\"missing correl: it is the only key a receipt can "
                    "be paired on, so this command is rejected\","
                    "\"correl\":null,\"code\":\"INVALID_ARG\"}";
                qz_ctl_conn_write(c, kNoCorrel, sizeof kNoCorrel - 1);
            } else if (r == -3) {
                static const char kReserved[] =
                    "{\"ctl\":true,\"ok\":false,"
                    "\"error\":\"rejected: a numeric \\\"qzjs\\\" key is the "
                    "channel layer's reserved namespace for system CONTROL\","
                    "\"correl\":\"%s\",\"code\":\"INVALID_ARG\"}";
                char buf[512];
                int n = snprintf(buf, sizeof buf, kReserved,
                                 rej_correl ? rej_correl : "");
                if (n > 0 && (size_t)n < sizeof buf)
                    qz_ctl_conn_write(c, buf, (size_t)n);
                else
                    fprintf(stderr, "qzjs: reserved-ns receipt does not fit "
                                    "(correl len=%zu)\n",
                            rej_correl ? strlen(rej_correl) : (size_t)0);
            } else if (r == -4) {
                /* 命令没能进队列 ⇒ 不会有回执。不说，客户端就干等到超时。
                 * 这条与「转发失败会回 NOT_FOUND」是同一类问题：早先这里对 -1
                 * 全部静默，于是同一个函数里转发失败有回执、入队失败没回执。 */
                static const char kEnq[] =
                    "{\"ctl\":true,\"ok\":false,"
                    "\"error\":\"command could not be enqueued; no receipt will "
                    "come for it\",\"code\":\"INTERNAL\"}";
                qz_ctl_conn_write(c, kEnq, sizeof kEnq - 1);
            } else if (r == -5) {
                /* 前投失败：NOT_FOUND 帧已由 qz_control_endpoint_cmd 写出。 */
            } else if (r != 0) {
                /* 其余 -1（rt/magic 非法、control_plane 非 LOCAL、malloc 失败）。
                 * 也要说话：同文件兄弟分支从不沉默，没有理由这里例外。 */
                static const char kInternal[] =
                    "{\"ctl\":true,\"ok\":false,"
                    "\"error\":\"control command could not be accepted\","
                    "\"code\":\"INTERNAL\"}";
                qz_ctl_conn_write(c, kInternal, sizeof kInternal - 1);
            }
            free(rej_correl);
        }
        start = i + 1;
    }
    if (start > 0) {
        memmove(c->buf, c->buf + start, c->len - start);
        c->len -= start;
    }
}

/* ── 接受连接（loop 线程） ── */

static int conn_peer_uid(uv_pipe_t *p, uid_t *out)
{
    uv_os_fd_t fd;
    if (uv_fileno((uv_handle_t *)p, &fd) != 0) return -1;
    struct qz_peercred cred;
    socklen_t cl = (socklen_t)sizeof cred;
    if (getsockopt((int)(intptr_t)fd, SOL_SOCKET, SO_PEERCRED, &cred, &cl) != 0)
        return -1;
    *out = cred.uid;
    return 0;
}

static void listener_cb(uv_stream_t *s, int status)
{
    qz_t *rt = (qz_t *)s->data;
    if (status != 0) return;

    struct qz_ctl_conn_s *c =
        (struct qz_ctl_conn_s *)calloc(1, sizeof *c);
    if (!c) return;
    c->rt = rt;
    if (uv_pipe_init(&rt->loop, &c->pipe, 0) != 0) { free(c); return; }
    c->pipe.data = c;

    if (uv_accept(s, (uv_stream_t *)&c->pipe) != 0) {
        uv_close((uv_handle_t *)&c->pipe, conn_close_cb);
        return;
    }
    /* 认证：SO_PEERCRED uid 必须与端点 owner 一致，否则直接断（§4.2）。 */
    uid_t puid = (uid_t)-1;
    if (conn_peer_uid(&c->pipe, &puid) != 0 || puid != getuid()) {
        uv_close((uv_handle_t *)&c->pipe, conn_close_cb);
        return;
    }
    c->next = rt->ctl_conns;
    rt->ctl_conns = c;
    uv_read_start((uv_stream_t *)&c->pipe, conn_alloc_cb, conn_read_cb);
}

/* ── 端点生命周期 ── */

int qz_ctl_endpoint_init(qz_t *rt)
{
    if (!rt) return -1;
    const char *cfg = rt->config.control_pipe_path;
    int defaulted = (!cfg || !cfg[0]);
    char path[256];
    if (defaulted)
        snprintf(path, sizeof path, "/tmp/qzjs-%ld-%u.ctl", (long)getpid(),
                 __atomic_add_fetch(&g_ctl_seq, 1, __ATOMIC_RELAXED));
    else
        snprintf(path, sizeof path, "%s", cfg);

    /* 缺省路径下清理上次崩溃残留的 socket（bind 对已存在路径返回 EADDRINUSE）；
     * 显式路径归调用方管理，自动 unlink 会误删别人的端点。 */
    if (defaulted) unlink(path);

    rt->ctl_pipe_path = strdup(path);
    if (!rt->ctl_pipe_path) return -1;

    if (uv_pipe_init(&rt->loop, &rt->ctl_listener, 0) != 0) {
        free(rt->ctl_pipe_path);
        rt->ctl_pipe_path = NULL;
        return -1;
    }
    rt->ctl_listener.data = rt;
    if (uv_pipe_bind(&rt->ctl_listener, path) != 0) goto fail;
    /* 端点权限 0600：unix pipe 权限即认证（§4.2）。 */
    if (chmod(path, 0600) != 0) goto fail;
    if (uv_listen((uv_stream_t *)&rt->ctl_listener, 16, listener_cb) != 0)
        goto fail;
    rt->ctl_listener_active = 1;
    return 0;

fail:
    uv_close((uv_handle_t *)&rt->ctl_listener, NULL);   /* rt 内嵌，无需释放 */
    unlink(path);
    free(rt->ctl_pipe_path);
    rt->ctl_pipe_path = NULL;
    return -1;
}

void qz_ctl_endpoint_close(qz_t *rt)
{
    if (!rt) return;
    struct qz_ctl_conn_s *c = rt->ctl_conns;
    rt->ctl_conns = NULL;
    while (c) {
        struct qz_ctl_conn_s *next = c->next;
        if (!c->closed) {
            c->closed = 1;
            uv_read_stop((uv_stream_t *)&c->pipe);
            qz_ctl_conn_drop(rt, c);
            c->pipe.data = c;
            uv_close((uv_handle_t *)&c->pipe, conn_close_cb);
        }
        c = next;
    }
    if (rt->ctl_listener_active) {
        rt->ctl_listener_active = 0;
        uv_close((uv_handle_t *)&rt->ctl_listener, NULL);
    }
    if (rt->ctl_pipe_path) {
        unlink(rt->ctl_pipe_path);
        free(rt->ctl_pipe_path);
        rt->ctl_pipe_path = NULL;
    }
}

int qz_ctl_endpoint_owns(qz_t *rt, void *h)
{
    if (!rt || !h) return 0;
    if (rt->ctl_listener_active && h == (void *)&rt->ctl_listener) return 1;
    for (struct qz_ctl_conn_s *c = rt->ctl_conns; c; c = c->next)
        if (h == (void *)&c->pipe) return 1;
    return 0;
}
