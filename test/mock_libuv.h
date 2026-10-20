#ifndef QZ_TEST_MOCK_LIBUV_H
#define QZ_TEST_MOCK_LIBUV_H

#include <pthread.h>
#include <stddef.h>
#include <stdint.h>

/* uv_io.c does not include the socket/net headers itself (they arrive
 * transitively from real libuv's uv.h), so the mock header must supply the
 * addrinfo / sockaddr types and the AF_UNSPEC / SOCK_STREAM / IPPROTO_TCP
 * constants that uv_io.c's getaddrinfo hints and connect calls reference. */
#include <netdb.h>        /* struct addrinfo, struct sockaddr */
#include <sys/socket.h>   /* AF_UNSPEC, SOCK_STREAM, IPPROTO_TCP */
#include <arpa/inet.h>    /* htons */
#include <fcntl.h>        /* O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC */
#include <unistd.h>       /* ssize_t, read/write/close/unlink */
#include <sys/stat.h>     /* struct stat, stat() */
#include <dirent.h>       /* DIR, struct dirent, opendir/readdir/closedir */

#ifdef __cplusplus
extern "C" {
#endif

/* ---- types ----
 * Full struct definitions (like real libuv's uv.h): tests instantiate handles
 * on the stack and the mock must match libuv's "handle at offset 0" layout.
 * Callback types are forward-declared via struct tags first, since the
 * structs reference them and they reference the structs (circular). */
#define MOCK_UV_MAX_HANDLES 64
#define MOCK_UV_MAX_CLOSES  128
#define MOCK_UV_MAX_PENDING 8    /* canned HTTP responses per loop */

/* Run modes match the mock's internal uv_run convention (0=NOWAIT 1=ONCE),
 * mirroring real libuv's UV_RUN_NOWAIT/UV_RUN_ONCE names. */
#define UV_RUN_NOWAIT 0
#define UV_RUN_ONCE   1

/* uv_fs error codes — negative errno is surface as-is (mock real fs),
 * UV_EOF terminates uv_fs_scandir_next iteration (like real libuv). */
#define UV_EOF       (-4095)
#define UV_ENOENT    (-2)
#define UV_ECANCELED (-125)
#define UV_EINVAL    (-22)

struct uv_loop_s;
struct uv_handle_s;
struct uv_timer_s;
struct uv_async_s;
struct uv_mutex_s;
struct uv_cond_s;
struct uv_thread_s;
struct uv_stream_s;
struct uv_tcp_s;
struct uv_connect_s;
struct uv_write_s;
struct uv_getaddrinfo_s;
struct uv_fs_s;

/* type aliases usable before the struct bodies are defined (the callback and
 * fs types below reference uv_buf_t and uv_loop_t by name; C99 forbids
 * re-typedef'ing them later, so the aliases live here and the struct bodies
 * below use `struct uv_*_s` names only) */
typedef struct uv_loop_s uv_loop_t;
typedef struct uv_buf_s { char *base; size_t len; } uv_buf_t;

/* libuv-compatible intrusive queue node (matches uv.h); qz_msg_t embeds it. */
struct uv__queue {
    struct uv__queue *next;
    struct uv__queue *prev;
};

typedef void (*uv_timer_cb)(struct uv_timer_s *handle);
typedef void (*uv_async_cb)(struct uv_async_s *handle);
typedef void (*uv_close_cb)(struct uv_handle_s *handle);
/* walk/thread callback types match real libuv (uv_walk_cb takes uv_handle_t*,
 * uv_thread_cb returns void) so qzjs core source compiles against either header. */
typedef void (*uv_walk_cb)(struct uv_handle_s *handle, void *arg);
typedef void (*uv_thread_cb)(void *arg);

/* network / fs callback types (signatures match real libuv uv.h) */
typedef void (*uv_alloc_cb)(struct uv_handle_s *handle, size_t suggested_size, uv_buf_t *buf);
typedef void (*uv_read_cb)(struct uv_stream_s *stream, ssize_t nread, const uv_buf_t *buf);
typedef void (*uv_write_cb)(struct uv_write_s *req, int status);
typedef void (*uv_connect_cb)(struct uv_connect_s *req, int status);
typedef void (*uv_getaddrinfo_cb)(struct uv_getaddrinfo_s *req, int status, struct addrinfo *res);
typedef void (*uv_fs_cb)(struct uv_fs_s *req);

/* Common handle header. data sits at offset 0 (like real libuv's uv_handle_s),
 * followed by loop/active/closed. Real libuv flattens these fields into every
 * concrete handle struct via UV_HANDLE_FIELDS; the mock mirrors that so shared
 * source (bridge.c, thread.c) compiles against either header and `handle->data`
 * works on both. Callers may set handle->data before init; the mock's *_init
 * must preserve it (real libuv's init does not touch data). */
#define UV_MOCK_HANDLE_FIELDS \
    void *data;                 \
    struct uv_loop_s *loop;     \
    int active;                 \
    int closed

typedef struct uv_handle_s { UV_MOCK_HANDLE_FIELDS; } uv_handle_s;
typedef struct uv_handle_s uv_handle_t;   /* real-libuv name for shared source */

typedef struct uv_timer_s { UV_MOCK_HANDLE_FIELDS; uv_timer_cb cb; uint64_t due_ms; uint64_t repeat_ms; } uv_timer_t;
typedef struct uv_async_s { UV_MOCK_HANDLE_FIELDS; uv_async_cb cb; volatile int pending; } uv_async_t;
typedef struct uv_mutex_s { pthread_mutex_t m; } uv_mutex_t;
typedef struct uv_cond_s   { pthread_cond_t c; } uv_cond_t;
typedef struct uv_thread_s { pthread_t t; } uv_thread_t;

typedef int uv_file;

/* stream/tcp share UV_MOCK_HANDLE_FIELDS at offset 0 so the
 * (uv_stream_t *)&op->tcp cast in uv_io.c is layout-safe. */
typedef struct uv_stream_s {
    UV_MOCK_HANDLE_FIELDS;
    uv_alloc_cb alloc_cb;    /* set by uv_read_start */
    uv_read_cb read_cb;
    int reading;
} uv_stream_t;

typedef struct uv_tcp_s {
    UV_MOCK_HANDLE_FIELDS;
    uv_alloc_cb alloc_cb;
    uv_read_cb read_cb;
    int reading;
} uv_tcp_t;

typedef struct uv_req_s { void *data; } uv_req_t;
typedef struct uv_connect_s { void *data; } uv_connect_t;
typedef struct uv_write_s { void *data; } uv_write_t;
typedef struct uv_getaddrinfo_s { void *data; } uv_getaddrinfo_t;

typedef struct uv_dirent_s { const char *name; int type; } uv_dirent_t;

/* fs request. bufsml is the inline single-iov buffer — real libuv's nbufs==1
 * fast path copies the caller's iov into bufsml and uv_fs_req_cleanup never
 * frees it. uv_io.c depends on this exact behavior: uv_io_fs_read_cb calls
 * uv_fs_req_cleanup(req) then reads req->bufs[0].base (uv_io.c:719/761), so
 * the mock MUST route reads through bufsml or that read is a use-after-free. */
typedef struct uv_fs_s {
    uv_loop_t *loop;
    uv_fs_cb cb;
    void *data;
    uv_file file;
    char *path;            /* strdup'd by path-taking ops; freed in cleanup */
    ssize_t result;
    uv_buf_t *bufs;        /* points at bufsml for nbufs==1 (never freed), else heap */
    unsigned int nbufs;
    uv_buf_t bufsml[1];    /* inline single-iov fast path */
    char **dent_names;     /* scandir: collected entry names */
    int dent_count;
    int dent_idx;
} uv_fs_t;

/* Canned HTTP response, pre-registered via mock_tcp_respond BEFORE the test
 * runs host_eval. Claimed by the first stream that calls uv_read_start;
 * delivered by uv_run's network section (see mock_libuv.c). */
typedef struct mock_uv_pending_s {
    struct uv_tcp_s *tcp;  /* claiming stream, NULL until read_start */
    char *bytes;
    size_t len;
    int data_delivered;
    int eof_delivered;
    int used;
} mock_uv_pending_t;

struct uv_loop_s {
    uv_timer_t *timers[MOCK_UV_MAX_HANDLES]; int timer_count;
    uv_async_t *asyncs[MOCK_UV_MAX_HANDLES]; int async_count;
    uv_tcp_t   *tcps[MOCK_UV_MAX_HANDLES];   int tcp_count;
    uv_close_cb close_cbs[MOCK_UV_MAX_CLOSES]; void *close_handles[MOCK_UV_MAX_CLOSES]; int close_count;
    mock_uv_pending_t pendings[MOCK_UV_MAX_PENDING]; int pending_count;
    uint64_t now_ms;
    int stopping;
    int active_handle_count;
    /* 活跃 request 计数（对齐真实 libuv 的 uv_loop_t.active_reqs，union 结构）。
     * mock 的 fs/tcp 请求同步完成，故 uv_loop_init 的 memset 后恒为 0；仅需
     * 该字段与真实 libuv 对齐，供 qz_loop_idle 编译并保持一致语义。 */
    union { void *unused[2]; unsigned int count; } active_reqs;
    /* test-only: every byte handed to uv_write (HTTP request / CONNECT /
     * TLS records), NUL-terminated for convenience. Accumulated across
     * writes; freed and reset in uv_loop_close. */
    char *written;
    size_t written_len;
    size_t written_cap;
};

static inline uv_buf_t uv_buf_init(char *base, unsigned int len)
{
    uv_buf_t b;
    b.base = base;
    b.len = len;
    return b;
}

/* ---- loop ---- */
uv_loop_t *uv_default_loop(void);
int uv_loop_init(uv_loop_t *loop);
int uv_run(uv_loop_t *loop, int mode);      /* mode: 0=NOWAIT 1=ONCE */
void uv_stop(uv_loop_t *loop);
int uv_loop_close(uv_loop_t *loop);
void uv_walk(uv_loop_t *loop, uv_walk_cb cb, void *arg);
void uv_close(struct uv_handle_s *handle, uv_close_cb cb);
int uv_is_closing(struct uv_handle_s *handle);
int uv_is_active(struct uv_handle_s *handle);
uint64_t uv_now(const uv_loop_t *loop);
uint64_t uv_hrtime(void);

/* ---- timer ---- */
int uv_timer_init(uv_loop_t *loop, uv_timer_t *t);
int uv_timer_start(uv_timer_t *t, uv_timer_cb cb, uint64_t timeout_ms, uint64_t repeat_ms);
int uv_timer_stop(uv_timer_t *t);
int uv_timer_again(uv_timer_t *t);

/* ---- async ---- */
int uv_async_init(uv_loop_t *loop, uv_async_t *a, uv_async_cb cb);
int uv_async_send(uv_async_t *a);

/* ---- mutex / cond ---- */
int uv_mutex_init(uv_mutex_t *m);
void uv_mutex_lock(uv_mutex_t *m);
void uv_mutex_unlock(uv_mutex_t *m);
void uv_mutex_destroy(uv_mutex_t *m);
int uv_cond_init(uv_cond_t *c);
void uv_cond_wait(uv_cond_t *c, uv_mutex_t *m);
int uv_cond_timedwait(uv_cond_t *c, uv_mutex_t *m, uint64_t timeout_ms);
void uv_cond_signal(uv_cond_t *c);
void uv_cond_broadcast(uv_cond_t *c);
void uv_cond_destroy(uv_cond_t *c);

/* ---- thread ---- */
int uv_thread_create(uv_thread_t *t, uv_thread_cb cb, void *arg);
int uv_thread_join(uv_thread_t *t);
int uv_thread_equal(const uv_thread_t *a, const uv_thread_t *b);
uv_thread_t uv_thread_self(void);

/* ---- network (mock) ----
 * uv_tcp_init/connect/write/read_start/read_stop, uv_getaddrinfo: no real
 * sockets. The synchronous connect/write chain fires callbacks immediately;
 * response bytes come from a canned response pre-registered by the test
 * (mock_tcp_respond), delivered by uv_run's network section. */
int uv_tcp_init(uv_loop_t *loop, uv_tcp_t *tcp);
int uv_tcp_connect(uv_connect_t *req, uv_tcp_t *tcp,
                   const struct sockaddr *addr, uv_connect_cb cb);
int uv_write(uv_write_t *req, uv_stream_t *stream,
             const uv_buf_t bufs[], unsigned int nbufs, uv_write_cb cb);
int uv_read_start(uv_stream_t *stream, uv_alloc_cb alloc_cb, uv_read_cb read_cb);
int uv_read_stop(uv_stream_t *stream);
int uv_getaddrinfo(uv_loop_t *loop, uv_getaddrinfo_t *req,
                   uv_getaddrinfo_cb cb, const char *node, const char *service,
                   const struct addrinfo *hints);
void uv_freeaddrinfo(struct addrinfo *res);
int uv_cancel(uv_req_t *req);

/* test-only: pre-register a canned response before host_eval. The first
 * stream to call uv_read_start claims it; uv_run delivers the bytes then
 * (unless the stream closed meanwhile) a UV_EOF read. Returns 0 on success. */
int mock_tcp_respond(uv_loop_t *loop, const char *bytes, size_t len);

/* test-only: view of all bytes written via uv_write on this loop
 * (accumulated in order). The buffer MAY contain embedded NUL bytes
 * (e.g. TLS handshake records whose length fields are big-endian and
 * therefore include 0x00) — strlen() on the returned pointer truncates
 * at the first NUL. Pair with mock_tcp_written_len() for the true byte
 * count. Caller must not free. */
const char *mock_tcp_written(uv_loop_t *loop);

/* test-only: true byte count of the mock_tcp_written buffer (use this
 * instead of strlen when the captured traffic is binary, e.g. TLS). */
size_t mock_tcp_written_len(uv_loop_t *loop);

/* ---- fs (mock) ---- */
int uv_fs_open(uv_loop_t *loop, uv_fs_t *req, const char *path, int flags, int mode, uv_fs_cb cb);
int uv_fs_read(uv_loop_t *loop, uv_fs_t *req, uv_file file,
               const uv_buf_t bufs[], unsigned int nbufs, int64_t offs, uv_fs_cb cb);
int uv_fs_write(uv_loop_t *loop, uv_fs_t *req, uv_file file,
                const uv_buf_t bufs[], unsigned int nbufs, int64_t offs, uv_fs_cb cb);
int uv_fs_close(uv_loop_t *loop, uv_fs_t *req, uv_file file, uv_fs_cb cb);
int uv_fs_stat(uv_loop_t *loop, uv_fs_t *req, const char *path, uv_fs_cb cb);
int uv_fs_unlink(uv_loop_t *loop, uv_fs_t *req, const char *path, uv_fs_cb cb);
int uv_fs_scandir(uv_loop_t *loop, uv_fs_t *req, const char *path, int flags, uv_fs_cb cb);
int uv_fs_scandir_next(uv_fs_t *req, uv_dirent_t *ent);
void uv_fs_req_cleanup(uv_fs_t *req);

#ifdef __cplusplus
}
#endif

#endif
