/*
 * mock_libuv — a fake libuv API for deterministic offline tests.
 *
 * Real libuv semantics, driven by a fake
 * scheduler: uv_run(UV_RUN_ONCE) fires all due timers and pending asyncs
 * synchronously, then returns; with no work pending it blocks on a condition
 * variable until woken by uv_async_send / uv_stop (with a 1s poll fallback so
 * newly-added timers are eventually noticed). mutex/cond/thread thinly wrap
 * pthread so tests get real concurrency.
 *
 * This is test infrastructure, not production code: mutable file-scope state
 * (s_default_loop, g_run_cond) is intentional here.
 */

#define _POSIX_C_SOURCE 200809L

#include "mock_libuv.h"
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <errno.h>
#include <netinet/in.h>   /* struct sockaddr_in (arpa/inet.h pulls it in, but be explicit) */

static uv_loop_t s_default_loop;
static uv_cond_t g_run_cond;
static uv_mutex_t g_run_mutex;
static pthread_once_t g_run_once = PTHREAD_ONCE_INIT;

/* g_run_cond must be a CLOCK_MONOTONIC condvar: uv_cond_timedwait builds the
 * absolute deadline from CLOCK_MONOTONIC. A PTHREAD_COND_INITIALIZER (REALTIME)
 * cond + MONOTONIC deadline makes every timedwait return ETIMEDOUT instantly,
 * which turns uv_run's 1s idle poll into a 100% CPU busy-spin. pthread_once
 * guards the one-time init against uv_run / uv_stop / uv_async_send racing. */
static void g_run_init(void)
{
    uv_cond_init(&g_run_cond);   /* uv_cond_init sets CLOCK_MONOTONIC */
    uv_mutex_init(&g_run_mutex);
}

static uint64_t s_clock_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000 + (uint64_t)ts.tv_nsec / 1000000;
}

/* ---- loop ---- */

uv_loop_t *uv_default_loop(void) { return &s_default_loop; }

int uv_loop_init(uv_loop_t *l)
{
    memset(l, 0, sizeof *l);
    l->now_ms = s_clock_ms();
    return 0;
}

uint64_t uv_now(const uv_loop_t *l) { return ((uv_loop_t *)l)->now_ms; }

uint64_t uv_hrtime(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

int uv_run(uv_loop_t *l, int mode)
{
    pthread_once(&g_run_once, g_run_init);
    for (;;) {
        l->now_ms = s_clock_ms();

        /* 1) fire due timers */
        int fired = 0;
        for (int i = 0; i < l->timer_count; i++) {
            uv_timer_t *t = l->timers[i];
            if (t && t->active && t->due_ms <= l->now_ms) {
                uv_timer_cb cb = t->cb;
                t->due_ms = l->now_ms + t->repeat_ms;
                if (t->repeat_ms == 0) uv_timer_stop(t);
                fired = 1;
                cb(t);
            }
        }

        /* 2) fire pending asyncs. pending is written by posting threads
         * (uv_async_send) and consumed here, so the read-and-clear must be a
         * single atomic exchange: a non-atomic read-then-clear could swallow a
         * concurrent store and leave a message stranded in the queue with
         * pending==0 (the idle path only wakes on pending asyncs / due timers,
         * it never checks the queue itself). */
        for (int i = 0; i < l->async_count; i++) {
            uv_async_t *a = l->asyncs[i];
            if (a && a->active && __atomic_exchange_n(&a->pending, 0, __ATOMIC_ACQ_REL)) {
                fired = 1; a->cb(a);
            }
        }

        /* 2.5) deliver canned HTTP responses to reading streams. The request
         * chain (getaddrinfo -> connect -> write -> read_start) runs
         * synchronously inside the wake async above, so the claiming stream is
         * armed by this point and we replay the test's response bytes. EOF is
         * delivered only while the stream is still reading AND open: a complete
         * body closes tcp via finish_success (closed=1), and the non-streaming
         * uv_io_http_read_cb has no teardown guard, so a follow-up EOF would
         * re-enter finish_success (not idempotent) and double-fire. */
        for (int i = 0; i < l->pending_count; i++) {
            mock_uv_pending_t *p = &l->pendings[i];
            if (p->used) continue;
            uv_tcp_t *t = p->tcp;
            if (!t || !t->reading) continue;
            if (!p->data_delivered) {
                uv_buf_t buf = {0};
                t->alloc_cb((uv_handle_t *)t, p->len, &buf);
                size_t n = p->len;
                if (buf.len && buf.len < n) n = buf.len;
                if (buf.base && n) memcpy(buf.base, p->bytes, n);
                t->read_cb((uv_stream_t *)t, (ssize_t)n, &buf);
                p->data_delivered = 1;
                fired = 1;
            }
            if (!p->eof_delivered && p->data_delivered && t->reading && !t->closed) {
                uv_buf_t eb = {0};
                t->read_cb((uv_stream_t *)t, UV_EOF, &eb);
                p->eof_delivered = 1;
                fired = 1;
            }
            /* done whether or not EOF went out (EOF is skipped when the body
             * completed and closed tcp) — never revisit a claimed response.
             * p->bytes was consumed by the read_cb's alloc buffer above, so
             * release it once the response is claimed. */
            if (p->data_delivered) {
                free(p->bytes);
                p->bytes = NULL;
                p->used = 1;
            }
        }

        /* 3) run close callbacks (cb may be NULL, like libuv) */
        for (int i = 0; i < l->close_count; i++) {
            uv_close_cb cb = l->close_cbs[i];
            void *h = l->close_handles[i];
            l->close_cbs[i] = NULL;
            l->close_handles[i] = NULL;
            if (cb) cb(h);
        }
        l->close_count = 0;

        if (mode == 0) return 0;                        /* NOWAIT: one pass */
        if (l->stopping) { l->stopping = 0; return 0; }
        if (fired) return 0;                            /* ONCE: a round of work done */
        {
            if (l->active_handle_count <= 0) return 0;  /* nothing alive -> don't block */
            /* idle: block until woken (async_send / stop) */
            uv_mutex_lock(&g_run_mutex);
            while (!l->stopping) {
                /* re-check for work that arrived just before we blocked */
                l->now_ms = s_clock_ms();
                int due = 0;
                for (int i = 0; i < l->timer_count; i++)
                    if (l->timers[i] && l->timers[i]->active && l->timers[i]->due_ms <= l->now_ms) { due = 1; break; }
                for (int i = 0; i < l->async_count; i++)
                    if (l->asyncs[i] && __atomic_load_n(&l->asyncs[i]->pending, __ATOMIC_ACQUIRE)) { due = 1; break; }
                if (due) break;
                struct timespec ts;
                clock_gettime(CLOCK_MONOTONIC, &ts);
                ts.tv_sec += 1;                         /* 1s poll fallback for new timers */
                uv_cond_timedwait(&g_run_cond, &g_run_mutex, 1000);
            }
            uv_mutex_unlock(&g_run_mutex);
            continue;
        }
    }
}

void uv_stop(uv_loop_t *l)
{
    pthread_once(&g_run_once, g_run_init);
    /* store + broadcast under g_run_mutex: pairs with uv_run's idle wait so a
     * stop arriving between its due-check and cond_timedwait is not lost. */
    uv_mutex_lock(&g_run_mutex);
    l->stopping = 1;
    uv_cond_broadcast(&g_run_cond);
    uv_mutex_unlock(&g_run_mutex);
}

int uv_loop_close(uv_loop_t *l)
{
    if (l->active_handle_count > 0) return -1;          /* EBUSY */
    /* Free any response bytes never claimed by a stream (loop torn down
     * before the pending response was delivered) + the write capture. */
    for (int i = 0; i < l->pending_count; i++) {
        if (l->pendings[i].bytes) {
            free(l->pendings[i].bytes);
            l->pendings[i].bytes = NULL;
        }
    }
    free(l->written);
    l->written = NULL;
    l->written_len = 0;
    l->written_cap = 0;
    return 0;
}

void uv_walk(uv_loop_t *l, uv_walk_cb cb, void *arg)
{
    for (int i = 0; i < l->timer_count; i++) if (l->timers[i]) cb((uv_handle_t *)l->timers[i], arg);
    for (int i = 0; i < l->async_count; i++) if (l->asyncs[i]) cb((uv_handle_t *)l->asyncs[i], arg);
    for (int i = 0; i < l->tcp_count; i++) if (l->tcps[i]) cb((uv_handle_t *)l->tcps[i], arg);
}

void uv_close(uv_handle_t *handle, uv_close_cb cb)
{
    uv_handle_s *h = handle;
    uv_loop_t *l = h->loop;
    if (h->active) {
        h->active = 0;
        l->active_handle_count--;
    }
    /* NULL out the table slot so uv_run/uv_walk never iterate a handle after
     * it is closed (the caller frees it from the close callback — without
     * this, a later pass over a non-NULL slot is a use-after-free). */
    for (int i = 0; i < l->timer_count; i++)
        if ((void *)l->timers[i] == handle) l->timers[i] = NULL;
    for (int i = 0; i < l->async_count; i++)
        if ((void *)l->asyncs[i] == handle) l->asyncs[i] = NULL;
    for (int i = 0; i < l->tcp_count; i++)
        if ((void *)l->tcps[i] == handle) l->tcps[i] = NULL;
    /* uv_is_closing must report 1 from here on (uv_io.c checks it in several
     * teardown paths, e.g. before aborting an in-flight request). */
    h->closed = 1;
    if (l->close_count < MOCK_UV_MAX_CLOSES) {
        l->close_cbs[l->close_count] = cb;
        l->close_handles[l->close_count] = handle;
        l->close_count++;
    }
}

int uv_is_closing(uv_handle_t *handle)
{
    return handle->closed;
}

int uv_is_active(uv_handle_t *handle)
{
    return handle->active;
}

/* ---- timer ---- */

int uv_timer_init(uv_loop_t *l, uv_timer_t *t)
{
    void *data = t->data;              /* preserve caller-set data (libuv init doesn't clear it) */
    memset(t, 0, sizeof *t);
    t->data = data;
    t->loop = l;
    /* reuse a NULL slot (freed by a prior uv_close) before appending */
    for (int i = 0; i < l->timer_count; i++) {
        if (!l->timers[i]) { l->timers[i] = t; return 0; }
    }
    if (l->timer_count >= MOCK_UV_MAX_HANDLES) return -1;
    l->timers[l->timer_count++] = t;
    return 0;
}

int uv_timer_start(uv_timer_t *t, uv_timer_cb cb, uint64_t timeout_ms, uint64_t repeat_ms)
{
    t->cb = cb;
    t->repeat_ms = repeat_ms;
    t->due_ms = uv_now(t->loop) + timeout_ms;
    if (!t->active) {
        t->active = 1;
        t->loop->active_handle_count++;
    }
    return 0;
}

int uv_timer_stop(uv_timer_t *t)
{
    if (t->active) {
        t->active = 0;
        t->loop->active_handle_count--;
    }
    return 0;
}

int uv_timer_again(uv_timer_t *t)
{
    if (t->cb) t->due_ms = uv_now(t->loop) + t->repeat_ms;
    return 0;
}

/* ---- async ---- */

int uv_async_init(uv_loop_t *l, uv_async_t *a, uv_async_cb cb)
{
    void *data = a->data;              /* preserve caller-set data (libuv init doesn't clear it) */
    memset(a, 0, sizeof *a);
    a->data = data;
    a->loop = l;
    a->cb = cb;
    a->pending = 0;
    a->active = 1;
    l->active_handle_count++;
    /* reuse a NULL slot (freed by a prior uv_close) before appending */
    for (int i = 0; i < l->async_count; i++) {
        if (!l->asyncs[i]) { l->asyncs[i] = a; return 0; }
    }
    if (l->async_count >= MOCK_UV_MAX_HANDLES) return -1;
    l->asyncs[l->async_count++] = a;
    return 0;
}

int uv_async_send(uv_async_t *a)
{
    pthread_once(&g_run_once, g_run_init);
    /* RELEASE pairs with the fire loop's ACQ_REL exchange / idle ACQUIRE load:
     * the queue append (msgq.c, under msg_mutex) happens-before this store, so
     * the qzjs thread seeing pending==1 also sees the message in the queue. */
    /* store + broadcast under g_run_mutex: uv_run's idle path holds the mutex
     * across its due-check and cond_timedwait, so a broadcast issued between
     * them would otherwise be dropped (pending async stranded up to 1s). */
    uv_mutex_lock(&g_run_mutex);
    __atomic_store_n(&a->pending, 1, __ATOMIC_RELEASE);
    uv_cond_broadcast(&g_run_cond);
    uv_mutex_unlock(&g_run_mutex);
    return 0;
}

/* ---- mutex / cond ---- */

int uv_mutex_init(uv_mutex_t *m) { return pthread_mutex_init(&m->m, NULL); }
void uv_mutex_lock(uv_mutex_t *m) { pthread_mutex_lock(&m->m); }
void uv_mutex_unlock(uv_mutex_t *m) { pthread_mutex_unlock(&m->m); }
void uv_mutex_destroy(uv_mutex_t *m) { pthread_mutex_destroy(&m->m); }

int uv_cond_init(uv_cond_t *c)
{
    pthread_condattr_t attr;
    pthread_condattr_init(&attr);
    pthread_condattr_setclock(&attr, CLOCK_MONOTONIC);  /* deterministic timedwait */
    int rc = pthread_cond_init(&c->c, &attr);
    pthread_condattr_destroy(&attr);
    return rc;
}

void uv_cond_wait(uv_cond_t *c, uv_mutex_t *m) { pthread_cond_wait(&c->c, &m->m); }

int uv_cond_timedwait(uv_cond_t *c, uv_mutex_t *m, uint64_t timeout_ms)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    ts.tv_sec += (time_t)(timeout_ms / 1000);
    ts.tv_nsec += (long)(timeout_ms % 1000) * 1000000L;
    if (ts.tv_nsec >= 1000000000L) { ts.tv_sec++; ts.tv_nsec -= 1000000000L; }
    return pthread_cond_timedwait(&c->c, &m->m, &ts);
}

void uv_cond_signal(uv_cond_t *c) { pthread_cond_signal(&c->c); }
void uv_cond_broadcast(uv_cond_t *c) { pthread_cond_broadcast(&c->c); }
void uv_cond_destroy(uv_cond_t *c) { pthread_cond_destroy(&c->c); }

/* ---- thread ---- */

/* pthread_create needs void *(*)(void *); uv_thread_cb is void(*)(void*), so
 * marshal cb+arg through a heap trampoline (a direct function-pointer cast
 * trips -Wcast-function-type under -Wextra). */
typedef struct { uv_thread_cb cb; void *arg; } mock_thread_start_t;

static void *mock_thread_start(void *arg)
{
    mock_thread_start_t *s = (mock_thread_start_t *)arg;
    s->cb(s->arg);
    free(s);
    return NULL;
}

int uv_thread_create(uv_thread_t *t, uv_thread_cb cb, void *arg)
{
    mock_thread_start_t *s = (mock_thread_start_t *)malloc(sizeof *s);
    if (!s) return -1;
    s->cb = cb;
    s->arg = arg;
    return pthread_create(&t->t, NULL, mock_thread_start, s);
}
int uv_thread_join(uv_thread_t *t) { return pthread_join(t->t, NULL); }
int uv_thread_equal(const uv_thread_t *a, const uv_thread_t *b) { return pthread_equal(a->t, b->t); }
uv_thread_t uv_thread_self(void) { uv_thread_t t; t.t = pthread_self(); return t; }

/* ---- network (mock) ----
 * No real sockets. The connect/write chain fires callbacks synchronously at
 * the call site (uv_io.c's getaddrinfo -> connect -> write -> read_start all
 * happen inside the wake-async callback, so the stream is armed before uv_run's
 * network section replays the canned response). */

int uv_tcp_init(uv_loop_t *l, uv_tcp_t *t)
{
    void *data = t->data;              /* preserve caller-set data */
    memset(t, 0, sizeof *t);
    t->data = data;
    t->loop = l;
    t->active = 1;
    l->active_handle_count++;
    /* reuse a NULL slot (freed by a prior uv_close) before appending */
    for (int i = 0; i < l->tcp_count; i++) {
        if (!l->tcps[i]) { l->tcps[i] = t; return 0; }
    }
    if (l->tcp_count >= MOCK_UV_MAX_HANDLES) return -1;
    l->tcps[l->tcp_count++] = t;
    return 0;
}

int uv_tcp_connect(uv_connect_t *req, uv_tcp_t *tcp,
                   const struct sockaddr *addr, uv_connect_cb cb)
{
    (void)addr;
    (void)tcp;
    if (cb) cb(req, 0);
    return 0;
}

int mock_tcp_record_write(uv_loop_t *l, const char *bytes, size_t len)
{
    size_t need = l->written_len + len + 1;
    if (need > l->written_cap) {
        size_t cap = l->written_cap ? l->written_cap : 256;
        while (cap < need) cap *= 2;
        char *nb = (char *)realloc(l->written, cap);
        if (!nb) return -1;
        l->written = nb;
        l->written_cap = cap;
    }
    memcpy(l->written + l->written_len, bytes, len);
    l->written_len += len;
    l->written[l->written_len] = '\0';
    return 0;
}

const char *mock_tcp_written(uv_loop_t *loop)
{
    return loop->written ? loop->written : "";
}

size_t mock_tcp_written_len(uv_loop_t *loop)
{
    return loop->written_len;
}

int uv_write(uv_write_t *req, uv_stream_t *stream,
             const uv_buf_t bufs[], unsigned int nbufs, uv_write_cb cb)
{
    uv_loop_t *l = ((uv_handle_t *)stream)->loop;
    for (unsigned i = 0; i < nbufs; i++) {
        if (bufs[i].len && mock_tcp_record_write(l, bufs[i].base, bufs[i].len) < 0) break;
    }
    if (cb) cb(req, 0);
    return 0;
}

int uv_read_start(uv_stream_t *stream, uv_alloc_cb alloc_cb, uv_read_cb read_cb)
{
    uv_tcp_t *t = (uv_tcp_t *)stream;
    t->alloc_cb = alloc_cb;
    t->read_cb = read_cb;
    t->reading = 1;
    /* claim the first unclaimed canned response (mock_tcp_respond) */
    uv_loop_t *l = t->loop;
    for (int i = 0; i < l->pending_count; i++) {
        mock_uv_pending_t *p = &l->pendings[i];
        if (p->used || p->tcp) continue;
        p->tcp = t;
        break;
    }
    return 0;
}

int uv_read_stop(uv_stream_t *stream)
{
    ((uv_tcp_t *)stream)->reading = 0;
    return 0;
}

int uv_getaddrinfo(uv_loop_t *l, uv_getaddrinfo_t *req,
                   uv_getaddrinfo_cb cb, const char *node, const char *service,
                   const struct addrinfo *hints)
{
    (void)l; (void)node; (void)hints;  /* mock always resolves to 127.0.0.1 */
    /* one allocation: addrinfo header + inline sockaddr_in, so a single
     * uv_freeaddrinfo frees both (uv_io reads only res->ai_addr) */
    struct addrinfo *res = (struct addrinfo *)calloc(1,
        sizeof(struct addrinfo) + sizeof(struct sockaddr_in));
    if (!res) { if (cb) cb(req, -12 /* ENOMEM */, NULL); return 0; }
    struct sockaddr_in *sa = (struct sockaddr_in *)(res + 1);
    sa->sin_family = AF_INET;
    sa->sin_port = htons((unsigned short)atoi(service));
    sa->sin_addr.s_addr = htonl(0x7f000001);   /* 127.0.0.1 */
    res->ai_family = AF_INET;
    res->ai_socktype = SOCK_STREAM;
    res->ai_protocol = IPPROTO_TCP;
    res->ai_addrlen = sizeof(struct sockaddr_in);
    res->ai_addr = (struct sockaddr *)sa;
    if (cb) cb(req, 0, res);
    return 0;
}

void uv_freeaddrinfo(struct addrinfo *res) { free(res); }

int uv_cancel(uv_req_t *req)
{
    (void)req;
    return UV_EINVAL;   /* nothing cancellable in the mock */
}

int mock_tcp_respond(uv_loop_t *loop, const char *bytes, size_t len)
{
    if (loop->pending_count >= MOCK_UV_MAX_PENDING) return -1;
    mock_uv_pending_t *p = &loop->pendings[loop->pending_count];
    p->bytes = (char *)malloc(len ? len : 1);
    if (!p->bytes) return -1;
    if (len) memcpy(p->bytes, bytes, len);
    p->len = len;
    p->tcp = NULL;
    p->data_delivered = 0;
    p->eof_delivered = 0;
    p->used = 0;
    loop->pending_count++;
    return 0;
}

/* ---- fs (mock) ----
 * Synchronous real-filesystem execution at the uv_fs_* call site; callbacks
 * fire immediately. req->result carries the outcome (fd / bytes / count / 0 /
 * -errno), mirroring real libuv. uv_fs_read MUST route the single iov through
 * req->bufsml (real libuv's nbufs==1 fast path): uv_io calls
 * uv_fs_req_cleanup(req) then reads req->bufs[0].base (uv_io.c:719/761), so
 * cleanup must never free an inline bufs nor NULL it. req->data is set once by
 * the op and MUST survive every call + cleanup (no memset of req). */

int uv_fs_open(uv_loop_t *l, uv_fs_t *req, const char *path, int flags, int mode, uv_fs_cb cb)
{
    (void)l;
    free(req->path);
    req->path = strdup(path);
    int fd = open(path, flags, (mode_t)mode);
    req->result = fd < 0 ? -errno : fd;
    req->file = fd < 0 ? -1 : fd;
    if (cb) cb(req);
    return 0;
}

int uv_fs_read(uv_loop_t *l, uv_fs_t *req, uv_file file,
               const uv_buf_t bufs[], unsigned int nbufs, int64_t offs, uv_fs_cb cb)
{
    (void)l;
    req->nbufs = nbufs;
    if (nbufs == 1) {
        req->bufs = req->bufsml;
        req->bufsml[0] = bufs[0];
    } else {
        req->bufs = (uv_buf_t *)malloc(sizeof(uv_buf_t) * (size_t)nbufs);
        if (!req->bufs) { req->result = -12; if (cb) cb(req); return 0; }
        memcpy(req->bufs, bufs, sizeof(uv_buf_t) * (size_t)nbufs);
    }
    ssize_t n = (offs < 0)
        ? read(file, req->bufs[0].base, req->bufs[0].len)
        : pread(file, req->bufs[0].base, req->bufs[0].len, offs);
    req->result = n < 0 ? -errno : n;
    if (cb) cb(req);
    return 0;
}

int uv_fs_write(uv_loop_t *l, uv_fs_t *req, uv_file file,
                const uv_buf_t bufs[], unsigned int nbufs, int64_t offs, uv_fs_cb cb)
{
    (void)l;
    req->nbufs = nbufs;
    if (nbufs == 1) {
        req->bufs = req->bufsml;
        req->bufsml[0] = bufs[0];
    } else {
        req->bufs = (uv_buf_t *)malloc(sizeof(uv_buf_t) * (size_t)nbufs);
        if (!req->bufs) { req->result = -12; if (cb) cb(req); return 0; }
        memcpy(req->bufs, bufs, sizeof(uv_buf_t) * (size_t)nbufs);
    }
    ssize_t n = (offs < 0)
        ? write(file, req->bufs[0].base, req->bufs[0].len)
        : pwrite(file, req->bufs[0].base, req->bufs[0].len, offs);
    req->result = n < 0 ? -errno : n;
    if (cb) cb(req);
    return 0;
}

int uv_fs_close(uv_loop_t *l, uv_fs_t *req, uv_file file, uv_fs_cb cb)
{
    (void)l;
    int rc = close(file);
    req->result = rc == 0 ? 0 : -errno;
    if (cb) cb(req);
    return 0;
}

int uv_fs_stat(uv_loop_t *l, uv_fs_t *req, const char *path, uv_fs_cb cb)
{
    (void)l;
    free(req->path);
    req->path = strdup(path);
    struct stat st;
    int rc = stat(path, &st);
    req->result = rc == 0 ? 0 : -errno;
    if (cb) cb(req);
    return 0;
}

int uv_fs_unlink(uv_loop_t *l, uv_fs_t *req, const char *path, uv_fs_cb cb)
{
    (void)l;
    free(req->path);
    req->path = strdup(path);
    int rc = unlink(path);
    req->result = rc == 0 ? 0 : -errno;
    if (cb) cb(req);
    return 0;
}

int uv_fs_scandir(uv_loop_t *l, uv_fs_t *req, const char *path, int flags, uv_fs_cb cb)
{
    (void)l; (void)flags;
    free(req->path);
    req->path = strdup(path);
    req->dent_names = NULL;
    req->dent_count = 0;
    req->dent_idx = 0;
    DIR *d = opendir(path);
    if (!d) {
        req->result = -errno;
        if (cb) cb(req);
        return 0;
    }
    int cap = 16;
    req->dent_names = (char **)malloc(sizeof(char *) * (size_t)cap);
    if (!req->dent_names) { closedir(d); req->result = -12; if (cb) cb(req); return 0; }
    int count = 0;
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
        if (count >= cap) {
            cap *= 2;
            char **nn = (char **)realloc(req->dent_names, sizeof(char *) * (size_t)cap);
            if (!nn) {
                for (int j = 0; j < count; j++) free(req->dent_names[j]);
                free(req->dent_names);
                req->dent_names = NULL;
                closedir(d);
                req->result = -12;
                if (cb) cb(req);
                return 0;
            }
            req->dent_names = nn;
        }
        req->dent_names[count] = strdup(ent->d_name);
        if (!req->dent_names[count]) {
            for (int j = 0; j < count; j++) free(req->dent_names[j]);
            free(req->dent_names);
            req->dent_names = NULL;
            closedir(d);
            req->result = -12;
            if (cb) cb(req);
            return 0;
        }
        count++;
    }
    closedir(d);
    req->dent_count = count;
    req->result = count;
    if (cb) cb(req);
    return 0;
}

int uv_fs_scandir_next(uv_fs_t *req, uv_dirent_t *ent)
{
    if (req->dent_idx >= req->dent_count) return UV_EOF;
    ent->name = req->dent_names[req->dent_idx];
    ent->type = 0;                        /* UV_DIRENT_UNKNOWN; list_cb ignores type */
    req->dent_idx++;
    return 0;
}

void uv_fs_req_cleanup(uv_fs_t *req)
{
    free(req->path);
    req->path = NULL;
    for (int i = 0; i < req->dent_count; i++) free(req->dent_names[i]);
    free(req->dent_names);
    req->dent_names = NULL;
    req->dent_count = 0;
    req->dent_idx = 0;
    /* inline bufsml is never freed, and bufs must keep pointing at it — uv_io
     * reads op->fs_req.bufs[0].base after cleanup (uv_io.c:761). Heap bufs
     * (nbufs>1, unused by uv_io) are freed here. */
    if (req->bufs != req->bufsml) {
        free(req->bufs);
        req->bufs = NULL;
    }
    req->nbufs = 0;
    /* leave req->data and req->result untouched: uv_io reads req->data (op)
     * and req->result in its callbacks AFTER calling this cleanup. */
}
