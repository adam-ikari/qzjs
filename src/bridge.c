/*
 * qzjs C Bridge Layer (执行模型 A)
 *
 * Creates the internal 'pal' JS object whose primitives map directly onto the
 * qzjs thread's libuv loop and the host message boundary. All libuv callbacks
 * run on the qzjs thread, so JS_Call happens directly — the PAL-era deferred
 * callback queue is gone.
 *
 *   timeNow / hrtime / log / randomBytes — sync, inlined to uv_now / uv_hrtime
 *       / stderr / /dev/urandom (no PAL backend in this model).
 *   timerStart / timerStop — malloc'd uv_timer_t on rt->loop; the uv timer
 *       callback resolves the polyfill's one-shot promise (polyfill only ever
 *       passes repeat=0; setInterval re-schedules setTimeout per tick).
 *   http / fs / storage — direct uv_io_* calls. Each builds a promise
 *       capability, calls the uv_io entry (whose done callback JS_Calls
 *       resolve/reject on the qzjs thread), and hands ownership of the
 *       resolving funcs to a qz_cb_data_t. The streaming HTTP path
 *       (uv_io_http_request_stream) JS_Calls on_headers/on_data/on_end.
 *   postMessage — host boundary: JSON out (qz_post_to_host → mailbox /
 *       main-RT uplink); __qz_dispatch__ handles inbound host JSON (source 0).
 */

#include "qz_internal.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <sys/stat.h>
#include <errno.h>
/* ipc_envelope.h 是纯 C99（无 uv 依赖），mock 构建也要它——THREAD 路径的
 * msgq flags 与 kind 常量同源（bridge_kind_arg / QZ_MSG_FLAG_PORT_TRANSFER）。 */
#include "ipc_envelope.h"
#ifndef QZ_USE_MOCK_LIBUV
#include "ipc_process.h"
#endif

/* ================================================================
 * Forward declarations
 * ================================================================ */

static JSValue js_pal_time_now(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_hrtime(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_log(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_native_eval_script(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_timer_stop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_timer_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_http_request(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_http_request_stream(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_http_request_abort(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_fs_read(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_fs_read_binary(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_fs_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_fs_exists(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_fs_remove(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_fs_list(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_storage_get(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_storage_set(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_storage_del(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_random_bytes(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_post_message(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_fs_read_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_fs_write_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_local_storage_path(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_port_create(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_spawn_worker(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_worker_post(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_worker_terminate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_worker_emit(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_worker_close(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_context_spawn(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_context_suspend(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_context_resume(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
#ifndef QZ_USE_MOCK_LIBUV
static JSValue js_pal_process_spawn(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_process_post(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_process_on_message(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_process_terminate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_process_ping(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
#endif
static JSValue js_pal_worker_backend(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue js_pal_context_destroy(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);

/* TCP socket PAL (for JS-level protocol implementations) */
void qz_tcp_io_init(JSContext *ctx, JSValue pal);

/* ================================================================
 * Helper: get qz_t from JSContext / JSRuntime.
 * qz_get_rt_from_ctx is also used by extensions (declared in qz_internal.h).
 * ================================================================ */

qz_t *qz_get_rt_from_ctx(JSContext *ctx)
{
    if (!ctx) {
        return NULL;
    }
    return qz_get_rt_from_jsrt(JS_GetRuntime(ctx));
}

qz_t *qz_get_rt_from_jsrt(JSRuntime *jsrt)
{
    qz_t *rt = (qz_t *)JS_GetRuntimeOpaque(jsrt);
    if (!rt || rt->magic != QZ_MAGIC) {
        return NULL;
    }
    return rt;
}

/* ================================================================
 * Helper: get qz_ctx_t from JSContext — iterate rt->contexts
 * to find the one matching jsctx
 * ================================================================ */

static qz_ctx_t *get_ctx_from_jsctx(qz_t *rt, JSContext *jsctx)
{
    if (!rt || !jsctx) {
        return NULL;
    }
    for (int i = 0; i < QZ_MAX_CONTEXTS; i++) {
        if (rt->contexts[i] && rt->contexts[i]->jsctx == jsctx) {
            return rt->contexts[i];
        }
    }
    return NULL;
}

/* ================================================================
 * Helper: allocate and init callback data
 * ================================================================ */

static qz_cb_data_t *alloc_cb_data(qz_ctx_t *cctx, JSValue resolve, JSValue reject, qz_t *rt)
{
    qz_cb_data_t *cbd = (qz_cb_data_t *)js_malloc(cctx->jsctx, sizeof(qz_cb_data_t));
    if (!cbd) {
        return NULL;
    }
    cbd->ctx = cctx;
    cbd->resolve = resolve;  /* takes ownership */
    cbd->reject = reject;    /* takes ownership */
    cbd->rt = rt;
    cbd->repeat = 0;
    cbd->handle_idx = -1;
    return cbd;
}

/* 调用 fn(this_val, argv) 并丢弃返回值；若 JS_Call 抛异常，用 JS_GetException
 * 取出并释放 pending exception（否则异常对象悬挂在异常槽里，污染后续调用 /
 * 泄漏）。用于 resolve/reject 回调、流式 on_headers/on_data/on_end、消息派发
 * 等"调用后不检查返回值"的异步回调。args 由调用方自行释放。 */
static void qz_js_call_cleanup(JSContext *ctx, JSValueConst fn,
                                 JSValueConst this_val, int argc,
                                 JSValueConst *argv)
{
    JSValue ret = JS_Call(ctx, fn, this_val, argc, argv);
    if (JS_IsException(ret))
        JS_GetException(ctx);
    JS_FreeValue(ctx, ret);
}

/* ================================================================
 * Free callback data — shared with context.c for cleanup
 * ================================================================ */

void qz_free_cb_data(JSContext *ctx, void *cbd_)
{
    if (!cbd_) {
        return;
    }
    qz_cb_data_t *cbd = (qz_cb_data_t *)cbd_;
    JS_FreeValue(ctx, cbd->resolve);
    JS_FreeValue(ctx, cbd->reject);
    js_free(ctx, cbd);
}

/* ================================================================
 * Timer machinery — malloc'd uv_timer_t on rt->loop
 *
 * t->data = cbd (qz_cb_data_t holding resolve/reject). The uv close
 * callback frees the timer struct, so the memory stays valid until libuv
 * finishes closing (close callbacks run on the qzjs thread).
 * ================================================================ */

static void qz_timer_close_cb(uv_handle_t *h)
{
    free(h);
}

static void qz_timer_cb(uv_timer_t *t)
{
    qz_cb_data_t *cbd = (qz_cb_data_t *)t->data;
    JSContext *jsctx = cbd->ctx->jsctx;

    JSValue arg = JS_UNDEFINED;
    qz_js_call_cleanup(jsctx, cbd->resolve, JS_UNDEFINED, 1, &arg);

    if (cbd->repeat) {
        /* repeating: stays armed via the uv repeat interval; resolve is a
         * settled-promise no-op on subsequent fires. */
        return;
    }

    /* one-shot: settle and release the slot + cbd + handle struct */
    qz_ctx_t *cctx = cbd->ctx;
    if (cbd->handle_idx >= 0 && cbd->handle_idx < QZ_MAX_HANDLES) {
        if (!JS_IsUndefined(cctx->timer_resolves[cbd->handle_idx])) {
            JS_FreeValue(jsctx, cctx->timer_resolves[cbd->handle_idx]);
            cctx->timer_resolves[cbd->handle_idx] = JS_UNDEFINED;
        }
        cctx->handles[cbd->handle_idx] = NULL;
        cctx->timer_cbds[cbd->handle_idx] = NULL;   /* cbd freed below */
    }
    JS_FreeValue(jsctx, cbd->resolve);
    JS_FreeValue(jsctx, cbd->reject);
    js_free(jsctx, cbd);
    uv_close((uv_handle_t *)t, qz_timer_close_cb);
}

/* Cancel a live timer slot: stop + uv_close (struct freed by the close
 * callback) + free resolve/cbd. Used by js_pal_timer_stop and by context.c
 * cleanup. Safe when the handle slot is NULL. */
void qz_timer_cancel(qz_ctx_t *cctx, int idx)
{
    JSContext *jsctx = cctx->jsctx;
    if (cctx->handles[idx]) {
        uv_timer_stop((uv_timer_t *)cctx->handles[idx]);
        uv_close((uv_handle_t *)cctx->handles[idx], qz_timer_close_cb);
        cctx->handles[idx] = NULL;
    }
    if (!JS_IsUndefined(cctx->timer_resolves[idx])) {
        JS_FreeValue(jsctx, cctx->timer_resolves[idx]);
        cctx->timer_resolves[idx] = JS_UNDEFINED;
    }
    if (cctx->timer_cbds[idx]) {
        qz_free_cb_data(jsctx, cctx->timer_cbds[idx]);
        cctx->timer_cbds[idx] = NULL;
    }
}

/* ================================================================
 * Sync primitives
 * ================================================================ */

/* pal.nativeEvalScript(code, filename) → value
 *
 * 用显式源名执行一段源码。JS 里的 eval 无法给自己的源码命名（quickjs-ng 把
 * 间接 eval 的源名固定成 "<input>"），所以宿主拿到"某个文件的内容"当字符串
 * 再送进运行时时——CLI 的 {"cmd":"eval"} 通道——栈帧 / Error().stack / 调试器
 * 断点都会记成 <input>。而断点是拿 JS_Eval 的源名做精确 strcmp 匹配的
 * （qz_debug.h："the host must eval with the real source path"），于是按真实
 * 路径设的断点永远不命中。把字符串来源的文件名一起送进来，引擎就用它命名
 * 这次求值。
 *
 * - filename 省略 / undefined / null → "<input>"（与原来的 (0, eval) 一致）。
 * - 按 *脚本* 语义执行（JS_EVAL_TYPE_GLOBAL，顶层 var/函数进全局），与 node
 *   跑一个文件一致；间接 eval 对 strict 代码会另开变量环境，那条语义留在
 *   无文件名的调用（-e / REPL）里不变。
 * - 抛出的异常原样向上传播（调用方 try/catch 拿到同一个 Error）。 */
static JSValue js_pal_native_eval_script(JSContext *ctx, JSValueConst this_val,
                                          int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "nativeEvalScript requires at least 1 argument: code");

    size_t len = 0;
    const char *code = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!code)
        return JS_EXCEPTION;

    const char *file = NULL;
    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        file = JS_ToCString(ctx, argv[1]);
        if (!file) {
            JS_FreeCString(ctx, code);
            return JS_EXCEPTION;
        }
    }

    JSValue ret = JS_Eval(ctx, code, len, file ? file : "<input>",
                          JS_EVAL_TYPE_GLOBAL);
    JS_FreeCString(ctx, code);
    if (file) JS_FreeCString(ctx, file);
    return ret;   /* JS_EXCEPTION 原样上抛：调用方 try/catch 拿到同一个 Error */
}

static JSValue js_pal_time_now(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val); QZ_UNUSED(argc); QZ_UNUSED(argv);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) {
        return JS_ThrowTypeError(ctx, "pal.time_now not available");
    }
    return JS_NewFloat64(ctx, (double)uv_now(&rt->loop));
}

static JSValue js_pal_hrtime(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val); QZ_UNUSED(argc); QZ_UNUSED(argv);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) {
        return JS_ThrowTypeError(ctx, "pal.hrtime not available");
    }
    return JS_NewFloat64(ctx, (double)uv_hrtime());
}

static JSValue js_pal_log(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    int32_t level = 0; /* default: info */
    const char *msg = "";
    int msg_needs_free = 0;

    if (argc >= 1) {
        if (JS_ToInt32(ctx, &level, argv[0]) < 0) {
            return JS_EXCEPTION;
        }
    }
    if (argc >= 2) {
        msg = JS_ToCString(ctx, argv[1]);
        if (!msg) {
            return JS_EXCEPTION;
        }
        msg_needs_free = 1;
    }

    /* Web 运行时 console 行为：log/info/debug → stdout；warn/error → stderr。
     * 去掉 [qzjs:N] 前缀，对齐 node/deno 的 console 输出形态。
     * fflush 保证输出即使在全缓冲的管道/重定向场景下也即时可见——否则 server
     * 常驻进程（listener 活跃、loop 不空）的输出会滞留缓冲直到退出才 flush。 */
    FILE *out = (level >= 2) ? stderr : stdout;
    fprintf(out, "%s\n", msg);
    fflush(out);

    if (msg_needs_free) {
        JS_FreeCString(ctx, msg);
    }

    return JS_UNDEFINED;
}

/* ================================================================
 * Timer start / stop
 * ================================================================ */

static JSValue js_pal_timer_stop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) {
        return JS_ThrowTypeError(ctx, "pal.timer_stop not available");
    }
    qz_ctx_t *cctx = get_ctx_from_jsctx(rt, ctx);
    if (!cctx) {
        return JS_ThrowTypeError(ctx, "pal.timer_stop not available");
    }

    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "timer_stop requires handle argument");
    }

    int32_t handle_idx;
    if (JS_ToInt32(ctx, &handle_idx, argv[0]) < 0) {
        return JS_EXCEPTION;
    }

    /* Validate handle index */
    if (handle_idx < 0 || handle_idx >= cctx->handle_count) {
        return JS_ThrowRangeError(ctx, "invalid timer handle");
    }

    if (cctx->handles[handle_idx]) {
        qz_timer_cancel(cctx, handle_idx);
    }

    return JS_UNDEFINED;
}

static JSValue js_pal_timer_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) {
        return JS_ThrowTypeError(ctx, "pal.timer_start not available");
    }
    qz_ctx_t *cctx = get_ctx_from_jsctx(rt, ctx);
    if (!cctx) {
        return JS_ThrowTypeError(ctx, "pal.timer_start not available");
    }

    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "timer_start requires delay_ms and repeat arguments");
    }

    double delay_ms;
    int32_t repeat;

    if (JS_ToFloat64(ctx, &delay_ms, argv[0]) < 0) {
        return JS_EXCEPTION;
    }
    if (JS_ToInt32(ctx, &repeat, argv[1]) < 0) {
        return JS_EXCEPTION;
    }

    /* Create promise capability */
    JSValue resolving_funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving_funcs);
    if (JS_IsException(promise)) {
        return JS_EXCEPTION;
    }

    /* Dup resolve for timer_resolves; alloc_cb_data takes ownership of originals */
    JSValue resolve_dup = JS_DupValue(ctx, resolving_funcs[0]);

    /* Allocate callback data — takes ownership of resolving_funcs */
    qz_cb_data_t *cbd = alloc_cb_data(cctx, resolving_funcs[0], resolving_funcs[1], rt);
    if (!cbd) {
        JS_FreeValue(ctx, resolve_dup);
        JS_FreeValue(ctx, resolving_funcs[0]);
        JS_FreeValue(ctx, resolving_funcs[1]);
        return JS_ThrowOutOfMemory(ctx);
    }
    cbd->repeat = repeat;

    /* Allocate + arm the uv timer on the qzjs thread's loop */
    uv_timer_t *t = (uv_timer_t *)malloc(sizeof *t);
    if (!t) {
        JS_FreeValue(ctx, resolve_dup);
        qz_free_cb_data(ctx, cbd);
        return JS_ThrowOutOfMemory(ctx);
    }
    memset(t, 0, sizeof *t);
    t->data = cbd;
    if (uv_timer_init(&rt->loop, t) != 0) {
        free(t);
        JS_FreeValue(ctx, resolve_dup);
        qz_free_cb_data(ctx, cbd);
        return JS_ThrowOutOfMemory(ctx);
    }
    uint64_t timeout = (uint64_t)delay_ms;
    uint64_t interval = repeat ? timeout : 0;
    if (uv_timer_start(t, qz_timer_cb, timeout, interval) != 0) {
        uv_close((uv_handle_t *)t, qz_timer_close_cb);
        JS_FreeValue(ctx, resolve_dup);
        qz_free_cb_data(ctx, cbd);
        return JS_ThrowTypeError(ctx, "failed to start timer");
    }

    /* Find a free handle slot (reuse NULL slots) */
    int idx = -1;
    for (int i = 0; i < cctx->handle_count; i++) {
        if (cctx->handles[i] == NULL) {
            idx = i;
            break;
        }
    }
    if (idx < 0) {
        if (cctx->handle_count >= QZ_MAX_HANDLES) {
            uv_close((uv_handle_t *)t, qz_timer_close_cb);
            JS_FreeValue(ctx, resolve_dup);
            qz_free_cb_data(ctx, cbd);
            return JS_ThrowRangeError(ctx, "too many timers");
        }
        idx = cctx->handle_count;
        cctx->handle_count++;
    }

    cctx->handles[idx] = t;
    cctx->timer_resolves[idx] = resolve_dup;
    cctx->timer_cbds[idx] = cbd;
    cbd->handle_idx = idx;

    /* Return {handle: number, promise: Promise} so polyfill can both
     * call timerStop(handle) and await the promise. */
    JSValue obj = JS_NewObject(ctx);
    if (JS_IsException(obj)) {
        qz_timer_cancel(cctx, idx);
        JS_FreeValue(ctx, promise);
        return JS_EXCEPTION;
    }
    JS_SetPropertyStr(ctx, obj, "handle", JS_NewInt32(ctx, idx));
    JS_SetPropertyStr(ctx, obj, "promise", promise);

    return obj;
}

/* ================================================================
 * Path traversal guard
 * ================================================================ */

/*
 * Validate that a file path does not contain path traversal sequences.
 * Returns true if the path is safe, false if it contains traversal.
 *
 * Blocks:
 *   - ".." path components (parent directory escape)
 *   - Null bytes (path truncation attacks)
 *   - Leading "/" is allowed (absolute paths)
 */
static bool bridge_validate_path(const char *path)
{
    if (!path || !*path) return false;

    /*
     * Note: a literal null-byte scan (strchr(path, '\0')) is pointless here —
     * it always finds the C-string terminator and would reject every path.
     * An embedded NUL is impossible to receive through JS_ToCString (it stops
     * at the first NUL), so there is nothing to reject on that axis; the
     * meaningful protection is the ".." component check below.
     */

    /* Reject "../" and "..\" and trailing ".." */
    const char *p = path;
    while (*p) {
        /* Check for ".." as a path component */
        if (p[0] == '.' && p[1] == '.') {
            char next = p[2];
            /* End of string, or followed by path separator */
            if (next == '\0' || next == '/' || next == '\\') {
                return false;
            }
        }
        p++;
    }

    return true;
}
/* ================================================================
 * Async primitives — direct uv_io_* calls (执行模型 A)
 *
 * Each wrapper: JS_ToCString args → JS_NewPromiseCapability → alloc_cb_data
 * (takes ownership of resolve/reject) → call the uv_io entry, then free the
 * C strings. The uv_io done callback fires on the qzjs thread's loop and
 * JS_Calls resolve/reject directly — no deferred-queue relay. Defaults,
 * validation and level mapping stay in the polyfill JS or the uv_io
 * implementation (thin-bridge rule).
 * ================================================================ */

/* Shared done callback for the non-streaming ops. status==0 resolves with the
 * payload string (or an empty string when there is no payload); status<0
 * rejects with the payload, or "unknown error" when there is none. Frees the
 * qz_cb_data_t and releases resolve/reject. */
static void bridge_io_done(void *opaque, int status, const char *data, size_t len)
{
    qz_cb_data_t *cd = (qz_cb_data_t *)opaque;
    JSContext *ctx = cd->ctx->jsctx;
    JSValue fn = (status == 0) ? cd->resolve : cd->reject;
    JSValue result;

    if (status == 0) {
        result = JS_NewStringLen(ctx, data ? data : "", data ? len : 0);
    } else if (data) {
        result = JS_NewStringLen(ctx, data, len);
    } else {
        result = JS_NewString(ctx, "unknown error");
    }

    if (!JS_IsException(result)) {
        qz_js_call_cleanup(ctx, fn, JS_UNDEFINED, 1, &result);
    }
    JS_FreeValue(ctx, result);

    qz_free_cb_data(ctx, cd);
}


/* Zero-copy fsReadBinary: uv_io provisions the destination buffer after open
 * (with the file size) and libuv reads straight into a JS ArrayBuffer's
 * backing store — the resolved promise hands out that same buffer, no copy.
 * The zc state carries the stashed JSValue; it is malloc'd (not js_malloc)
 * because its lifetime is owned by the async op, and all JS touchpoints
 * (alloc/free_fn/done) run on the qzjs loop thread. */
typedef struct {
    JSContext *ctx;
    qz_cb_data_t *cbd;
    JSValue ab;      /* stashed ArrayBuffer; consumed on success */
    int zc_valid;    /* cleared when uv_io releases the backing */
} bridge_zc_t;

/* JSReallocArrayBufferDataFunc shim: size==0 frees the backing (engine
 * finalizer / detach); otherwise resize via QuickJS allocator. */
static void *bridge_zc_ab_realloc(JSRuntime *rt, void *opaque, void *ptr, size_t size)
{
    (void)rt;
    (void)opaque;
    if (size == 0) {
        free(ptr);
        return NULL;
    }
    return realloc(ptr, size);
}

static void *bridge_zc_alloc(void *ud, size_t size, void **owner)
{
    bridge_zc_t *zc = (bridge_zc_t *)ud;
    /* Plain malloc + JS_NewArrayBuffer(realloc_func=bridge_zc_ab_realloc):
     * the engine's finalizer releases the backing once the JSValue is
     * collected. Fixed-size: max_len=0. */
    uint8_t *buf = (uint8_t *)malloc(size);
    if (!buf)
        return NULL;
    JSValue ab = JS_NewArrayBuffer(zc->ctx, buf, size, 0, bridge_zc_ab_realloc, NULL, false);
    if (JS_IsException(ab)) {
        free(buf);
        return NULL;
    }
    zc->ab = ab;
    zc->zc_valid = 1;
    *owner = zc;
    return buf;
}

static void bridge_zc_free(void *ud, void *owner)
{
    (void)owner;
    bridge_zc_t *zc = (bridge_zc_t *)ud;
    JS_FreeValue(zc->ctx, zc->ab);
    zc->ab = JS_UNDEFINED;
    zc->zc_valid = 0;
}

static void bridge_io_done_binary_zc(void *opaque, int status, const char *data, size_t len)
{
    bridge_zc_t *zc = (bridge_zc_t *)opaque;
    qz_cb_data_t *cd = zc->cbd;
    JSContext *ctx = zc->ctx;
    JSValue fn = (status == 0) ? cd->resolve : cd->reject;
    JSValue result;

    if (status == 0 && zc->zc_valid) {
        result = zc->ab;         /* hand the backing to the promise */
        zc->ab = JS_UNDEFINED;
    } else if (status == 0) {
        result = JS_NewArrayBufferCopy(ctx, (const uint8_t *)(data ? data : ""), data ? len : 0);
    } else if (data) {
        result = JS_NewStringLen(ctx, data, len);
    } else {
        result = JS_NewString(ctx, "unknown error");
    }

    if (!JS_IsException(result)) {
        qz_js_call_cleanup(ctx, fn, JS_UNDEFINED, 1, &result);
    }
    JS_FreeValue(ctx, result);
    qz_free_cb_data(ctx, cd);
    free(zc);
}

/* storage_get done callback: found → resolve the stored string; not-found →
 * resolve null (storage.js contract: a miss is a normal result, not a
 * rejection); other errors → reject. */
static void storage_get_done(void *opaque, int status, const char *data, size_t len)
{
    qz_cb_data_t *cd = (qz_cb_data_t *)opaque;
    JSContext *ctx = cd->ctx->jsctx;
    JSValue fn = cd->resolve;
    JSValue result;

    if (status == QZ_ERR_NOT_FOUND) {
        result = JS_NULL;
    } else if (status == 0) {
        result = JS_NewStringLen(ctx, data ? data : "", data ? len : 0);
    } else {
        fn = cd->reject;
        result = JS_NewStringLen(ctx, data ? data : "storage error",
                                 data ? len : 13);
    }

    if (!JS_IsException(result)) {
        qz_js_call_cleanup(ctx, fn, JS_UNDEFINED, 1, &result);
    }
    JS_FreeValue(ctx, result);

    qz_free_cb_data(ctx, cd);
}

/* Streaming HTTP — the ops->user_data passed to uv_io_http_request_stream.
 * bridge_stream_on_end frees bs; uv_io guarantees on_end fires exactly once
 * per op (every completion / error / abort path terminates in on_end). */
typedef struct bridge_stream_ctx_s {
    JSContext *ctx;
    JSValue on_headers;
    JSValue on_data;
    JSValue on_end;
} bridge_stream_ctx_t;

static void bridge_stream_on_headers(void *ud, int status, const char *headers_json)
{
    bridge_stream_ctx_t *bs = (bridge_stream_ctx_t *)ud;
    if (!JS_IsFunction(bs->ctx, bs->on_headers)) {
        return;
    }
    JSValue args[2];
    args[0] = JS_NewInt32(bs->ctx, status);
    args[1] = JS_NewString(bs->ctx, headers_json ? headers_json : "{}");
    if (JS_IsException(args[1])) {
        JS_FreeValue(bs->ctx, args[0]);
        JS_FreeValue(bs->ctx, args[1]);
        return;
    }
    qz_js_call_cleanup(bs->ctx, bs->on_headers, JS_UNDEFINED, 2, args);
    JS_FreeValue(bs->ctx, args[0]);
    JS_FreeValue(bs->ctx, args[1]);
}

static void bridge_stream_on_data(void *ud, const char *data, size_t len)
{
    bridge_stream_ctx_t *bs = (bridge_stream_ctx_t *)ud;
    if (!JS_IsFunction(bs->ctx, bs->on_data)) {
        return;
    }
    JSValue buf = JS_NewArrayBufferCopy(bs->ctx, (const uint8_t *)data, len);
    if (JS_IsException(buf)) {
        JS_FreeValue(bs->ctx, buf);
        return;
    }
    qz_js_call_cleanup(bs->ctx, bs->on_data, JS_UNDEFINED, 1, &buf);
    JS_FreeValue(bs->ctx, buf);
}

static void bridge_stream_on_end(void *ud, int error_status)
{
    bridge_stream_ctx_t *bs = (bridge_stream_ctx_t *)ud;
    if (JS_IsFunction(bs->ctx, bs->on_end)) {
        JSValue arg = JS_NewInt32(bs->ctx, error_status);
        qz_js_call_cleanup(bs->ctx, bs->on_end, JS_UNDEFINED, 1, &arg);
        JS_FreeValue(bs->ctx, arg);
    }
    JS_FreeValue(bs->ctx, bs->on_headers);
    JS_FreeValue(bs->ctx, bs->on_data);
    JS_FreeValue(bs->ctx, bs->on_end);
    js_free(bs->ctx, bs);
}

static JSValue js_pal_http_request(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) {
        return JS_ThrowTypeError(ctx, "pal.http_request not available");
    }
    qz_ctx_t *cctx = get_ctx_from_jsctx(rt, ctx);
    if (!cctx) {
        return JS_ThrowTypeError(ctx, "pal.http_request not available");
    }
    if (argc < 4) {
        return JS_ThrowTypeError(ctx, "http_request requires url, method, headers, body arguments");
    }

    const char *url = JS_ToCString(ctx, argv[0]);
    const char *method = JS_ToCString(ctx, argv[1]);
    const char *headers = JS_ToCString(ctx, argv[2]);
    if (!url || !method || !headers) {
        if (url) JS_FreeCString(ctx, url);
        if (method) JS_FreeCString(ctx, method);
        if (headers) JS_FreeCString(ctx, headers);
        return JS_EXCEPTION;
    }

    const char *body = NULL;
    size_t body_len = 0;
    if (!JS_IsUndefined(argv[3]) && !JS_IsNull(argv[3])) {
        body = JS_ToCStringLen(ctx, &body_len, argv[3]);
        if (!body) {
            JS_FreeCString(ctx, url);
            JS_FreeCString(ctx, method);
            JS_FreeCString(ctx, headers);
            return JS_EXCEPTION;
        }
    }

    JSValue resolving_funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving_funcs);
    if (JS_IsException(promise)) {
        JS_FreeCString(ctx, url);
        JS_FreeCString(ctx, method);
        JS_FreeCString(ctx, headers);
        if (body) JS_FreeCString(ctx, body);
        return JS_EXCEPTION;
    }

    qz_cb_data_t *cbd = alloc_cb_data(cctx, resolving_funcs[0], resolving_funcs[1], rt);
    if (!cbd) {
        JS_FreeValue(ctx, resolving_funcs[0]);
        JS_FreeValue(ctx, resolving_funcs[1]);
        JS_FreeCString(ctx, url);
        JS_FreeCString(ctx, method);
        JS_FreeCString(ctx, headers);
        if (body) JS_FreeCString(ctx, body);
        return JS_ThrowOutOfMemory(ctx);
    }

    uv_io_http_request(rt, url, method, headers, body, body_len, bridge_io_done, cbd);

    JS_FreeCString(ctx, url);
    JS_FreeCString(ctx, method);
    JS_FreeCString(ctx, headers);
    if (body) JS_FreeCString(ctx, body);

    return promise;
}

static JSValue js_pal_http_request_stream(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) {
        return JS_ThrowTypeError(ctx, "pal.http_request_stream not available");
    }
    if (argc < 7) {
        return JS_ThrowTypeError(ctx, "http_request_stream requires url, method, headers, body, onHeaders, onData, onEnd arguments");
    }

    const char *url = JS_ToCString(ctx, argv[0]);
    const char *method = JS_ToCString(ctx, argv[1]);
    const char *headers = JS_ToCString(ctx, argv[2]);
    if (!url || !method || !headers) {
        if (url) JS_FreeCString(ctx, url);
        if (method) JS_FreeCString(ctx, method);
        if (headers) JS_FreeCString(ctx, headers);
        return JS_EXCEPTION;
    }

    const char *body = NULL;
    size_t body_len = 0;
    int body_is_cstr = 0;
    if (!JS_IsUndefined(argv[3]) && !JS_IsNull(argv[3])) {
        body = (const char *)JS_GetUint8Array(ctx, &body_len, argv[3]);
        if (!body) {
            body = (const char *)JS_GetArrayBuffer(ctx, &body_len, argv[3]);
        }
        if (!body) {
            body = JS_ToCStringLen(ctx, &body_len, argv[3]);
            body_is_cstr = 1;
        }
        if (!body) {
            JS_FreeCString(ctx, url);
            JS_FreeCString(ctx, method);
            JS_FreeCString(ctx, headers);
            return JS_EXCEPTION;
        }
    }

    bridge_stream_ctx_t *bs = (bridge_stream_ctx_t *)js_malloc(ctx, sizeof *bs);
    if (!bs) {
        JS_FreeCString(ctx, url);
        JS_FreeCString(ctx, method);
        JS_FreeCString(ctx, headers);
        if (body_is_cstr) JS_FreeCString(ctx, body);
        return JS_ThrowOutOfMemory(ctx);
    }
    bs->ctx = ctx;
    bs->on_headers = JS_DupValue(ctx, argv[4]);
    bs->on_data = JS_DupValue(ctx, argv[5]);
    bs->on_end = JS_DupValue(ctx, argv[6]);

    qz_io_stream_ops_t ops;
    memset(&ops, 0, sizeof ops);
    ops.on_headers = bridge_stream_on_headers;
    ops.on_data = bridge_stream_on_data;
    ops.on_end = bridge_stream_on_end;
    ops.user_data = bs;

    uint64_t op_id = uv_io_http_request_stream(rt, url, method, headers,
                                               body, body_len, &ops);

    JS_FreeCString(ctx, url);
    JS_FreeCString(ctx, method);
    JS_FreeCString(ctx, headers);
    if (body_is_cstr) JS_FreeCString(ctx, body);

    /* Returns the op id — the abort handle for pal.httpRequestAbort.
     * 0 means the request failed synchronously (no op was created). */
    return JS_NewInt64(ctx, (int64_t)op_id);
}

/* pal.httpRequestAbort(opId): abort a specific in-flight streaming HTTP op.
 * No-op for an unknown/stale id. Runs on the loop thread (JS). */
static JSValue js_pal_http_request_abort(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) {
        return JS_ThrowTypeError(ctx, "pal.http_request_abort not available");
    }
    if (argc < 1 || JS_IsUndefined(argv[0]) || JS_IsNull(argv[0])) {
        return JS_UNDEFINED;
    }
    int64_t op_id = 0;
    if (JS_ToInt64(ctx, &op_id, argv[0]) != 0 || op_id <= 0) {
        return JS_UNDEFINED;
    }
    uv_io_http_abort_by_id(rt, (uint64_t)op_id);
    return JS_UNDEFINED;
 }

/* 6 个单参数 path/key 异步操作（fs_read/exists/remove/list + storage_get/del）
 * 骨架逐字节相同：rt/cctx 查找 → argc 检查 → ToCString →（可选）path 校验 →
 * PromiseCapability → alloc_cb_data → launch → 释放 → return promise。唯一差异
 * 是错误串 (opname/argname)、是否做 path 校验、末尾那个 uv_io_* launch 与其
 * done 回调。launch/done 分开传，避免为每个 op 写一个闭包。storage_get 用
 * storage_get_done（返回字符串带引号处理），其余用 bridge_io_done。 */
typedef void (*pal_io_launch_t)(qz_t *rt, const char *arg,
                                qz_io_done_t done, void *cbd);
static JSValue pal_path_promise_op(JSContext *ctx, int argc, JSValueConst *argv,
                                   const char *opname, const char *argname,
                                   int validate_path, pal_io_launch_t launch,
                                   qz_io_done_t done)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) {
        return JS_ThrowTypeError(ctx, "pal.%s not available", opname);
    }
    qz_ctx_t *cctx = get_ctx_from_jsctx(rt, ctx);
    if (!cctx) {
        return JS_ThrowTypeError(ctx, "pal.%s not available", opname);
    }
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "%s requires %s argument", opname, argname);
    }

    const char *arg = JS_ToCString(ctx, argv[0]);
    if (!arg) {
        return JS_EXCEPTION;
    }
    if (validate_path && !bridge_validate_path(arg)) {
        JS_FreeCString(ctx, arg);
        return JS_ThrowTypeError(ctx, "Path traversal detected");
    }

    JSValue resolving_funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving_funcs);
    if (JS_IsException(promise)) {
        JS_FreeCString(ctx, arg);
        return JS_EXCEPTION;
    }

    qz_cb_data_t *cbd = alloc_cb_data(cctx, resolving_funcs[0], resolving_funcs[1], rt);
    if (!cbd) {
        JS_FreeValue(ctx, resolving_funcs[0]);
        JS_FreeValue(ctx, resolving_funcs[1]);
        JS_FreeCString(ctx, arg);
        return JS_ThrowOutOfMemory(ctx);
    }

    launch(rt, arg, done, cbd);

    JS_FreeCString(ctx, arg);
    return promise;
}

static JSValue js_pal_fs_read(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    return pal_path_promise_op(ctx, argc, argv, "fs_read", "path", 1,
                               uv_io_fs_read, bridge_io_done);
}

/* fsReadBinary(path) -> Promise<ArrayBuffer>
 * Async via uv_io_fs_read; resolves with an ArrayBuffer of the raw bytes
 * (binary-safe, unlike the string-returning fsRead). */
static JSValue js_pal_fs_read_binary(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) {
        return JS_ThrowTypeError(ctx, "pal.fs_read_binary not available");
    }
    qz_ctx_t *cctx = get_ctx_from_jsctx(rt, ctx);
    if (!cctx) {
        return JS_ThrowTypeError(ctx, "pal.fs_read_binary not available");
    }
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "fs_read_binary requires path argument");
    }

    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) {
        return JS_EXCEPTION;
    }
    if (!bridge_validate_path(path)) {
        JS_FreeCString(ctx, path);
        return JS_ThrowTypeError(ctx, "Path traversal detected");
    }

    JSValue resolving_funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving_funcs);
    if (JS_IsException(promise)) {
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }

    bridge_zc_t *zc = (bridge_zc_t *)malloc(sizeof(*zc));
    if (!zc) {
        JS_FreeValue(ctx, resolving_funcs[0]);
        JS_FreeValue(ctx, resolving_funcs[1]);
        JS_FreeCString(ctx, path);
        return JS_ThrowOutOfMemory(ctx);
    }
    qz_cb_data_t *cbd = alloc_cb_data(cctx, resolving_funcs[0], resolving_funcs[1], rt);
    if (!cbd) {
        free(zc);
        JS_FreeValue(ctx, resolving_funcs[0]);
        JS_FreeValue(ctx, resolving_funcs[1]);
        JS_FreeCString(ctx, path);
        return JS_ThrowOutOfMemory(ctx);
    }
    zc->ctx = ctx;
    zc->cbd = cbd;
    zc->ab = JS_UNDEFINED;
    zc->zc_valid = 0;

    uv_io_fs_read_ex(rt, path, bridge_io_done_binary_zc, zc,
                     bridge_zc_alloc, bridge_zc_free, zc);

    JS_FreeCString(ctx, path);
    return promise;
}

static JSValue js_pal_fs_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) {
        return JS_ThrowTypeError(ctx, "pal.fs_write not available");
    }
    qz_ctx_t *cctx = get_ctx_from_jsctx(rt, ctx);
    if (!cctx) {
        return JS_ThrowTypeError(ctx, "pal.fs_write not available");
    }
    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "fs_write requires path and data arguments");
    }

    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) {
        return JS_EXCEPTION;
    }
    if (!bridge_validate_path(path)) {
        JS_FreeCString(ctx, path);
        return JS_ThrowTypeError(ctx, "Path traversal detected");
    }

    const char *data = NULL;
    size_t data_len = 0;
    if (!JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        data = JS_ToCStringLen(ctx, &data_len, argv[1]);
        if (!data) {
            JS_FreeCString(ctx, path);
            return JS_EXCEPTION;
        }
    }

    JSValue resolving_funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving_funcs);
    if (JS_IsException(promise)) {
        JS_FreeCString(ctx, path);
        if (data) JS_FreeCString(ctx, data);
        return JS_EXCEPTION;
    }

    qz_cb_data_t *cbd = alloc_cb_data(cctx, resolving_funcs[0], resolving_funcs[1], rt);
    if (!cbd) {
        JS_FreeValue(ctx, resolving_funcs[0]);
        JS_FreeValue(ctx, resolving_funcs[1]);
        JS_FreeCString(ctx, path);
        if (data) JS_FreeCString(ctx, data);
        return JS_ThrowOutOfMemory(ctx);
    }

    uv_io_fs_write(rt, path, data ? data : "", data ? data_len : 0,
                   bridge_io_done, cbd);

    JS_FreeCString(ctx, path);
    if (data) JS_FreeCString(ctx, data);

    return promise;
}

static JSValue js_pal_fs_exists(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    return pal_path_promise_op(ctx, argc, argv, "fs_exists", "path", 1,
                               uv_io_fs_exists, bridge_io_done);
}

static JSValue js_pal_fs_remove(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    return pal_path_promise_op(ctx, argc, argv, "fs_remove", "path", 1,
                               uv_io_fs_remove, bridge_io_done);
}

static JSValue js_pal_fs_list(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    return pal_path_promise_op(ctx, argc, argv, "fs_list", "path", 1,
                               uv_io_fs_list, bridge_io_done);
}

static JSValue js_pal_storage_get(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    return pal_path_promise_op(ctx, argc, argv, "storage_get", "key", 0,
                               uv_io_storage_get, storage_get_done);
}

static JSValue js_pal_storage_set(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) {
        return JS_ThrowTypeError(ctx, "pal.storage_set not available");
    }
    qz_ctx_t *cctx = get_ctx_from_jsctx(rt, ctx);
    if (!cctx) {
        return JS_ThrowTypeError(ctx, "pal.storage_set not available");
    }
    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "storage_set requires key and value arguments");
    }

    const char *key = JS_ToCString(ctx, argv[0]);
    if (!key) {
        return JS_EXCEPTION;
    }

    const char *value = NULL;
    size_t value_len = 0;
    if (!JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        value = JS_ToCStringLen(ctx, &value_len, argv[1]);
        if (!value) {
            JS_FreeCString(ctx, key);
            return JS_EXCEPTION;
        }
    }

    JSValue resolving_funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, resolving_funcs);
    if (JS_IsException(promise)) {
        JS_FreeCString(ctx, key);
        if (value) JS_FreeCString(ctx, value);
        return JS_EXCEPTION;
    }

    qz_cb_data_t *cbd = alloc_cb_data(cctx, resolving_funcs[0], resolving_funcs[1], rt);
    if (!cbd) {
        JS_FreeValue(ctx, resolving_funcs[0]);
        JS_FreeValue(ctx, resolving_funcs[1]);
        JS_FreeCString(ctx, key);
        if (value) JS_FreeCString(ctx, value);
        return JS_ThrowOutOfMemory(ctx);
    }

    uv_io_storage_set(rt, key, value ? value : "", value ? value_len : 0,
                      bridge_io_done, cbd);

    JS_FreeCString(ctx, key);
    if (value) JS_FreeCString(ctx, value);

    return promise;
}

static JSValue js_pal_storage_del(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    return pal_path_promise_op(ctx, argc, argv, "storage_del", "key", 0,
                               uv_io_storage_del, bridge_io_done);
}

/* ================================================================
 * randomBytes(len) — synchronous CSPRNG
 * Returns an ArrayBuffer filled with len random bytes.
 * ================================================================ */

static JSValue js_pal_random_bytes(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);

    int64_t len = 0;
    if (argc >= 1 && JS_ToInt64(ctx, &len, argv[0])) {
        return JS_EXCEPTION;
    }

    /* Bridge does only JSValue↔C conversion + the byte fill. Input
     * validation (positive length, the 65536-byte cap from the Web Crypto
     * spec) lives in the JS polyfill, not here. */
    if (len <= 0) {
        return JS_ThrowRangeError(ctx, "randomBytes: length must be positive");
    }

    size_t ulen = (size_t)len;
    uint8_t *buf = js_malloc(ctx, ulen);
    if (!buf) {
        return JS_ThrowOutOfMemory(ctx);
    }

    /* Inline: fill from /dev/urandom (no PAL backend in this model) */
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f) {
        js_free(ctx, buf);
        return JS_ThrowTypeError(ctx, "randomBytes: /dev/urandom unavailable");
    }
    size_t got = fread(buf, 1, ulen, f);
    fclose(f);
    if (got != ulen) {
        js_free(ctx, buf);
        return JS_ThrowTypeError(ctx, "randomBytes: short read");
    }

    /* Copy into ArrayBuffer (QuickJS owns the copy) */
    JSValue ab = JS_NewArrayBufferCopy(ctx, buf, ulen);
    js_free(ctx, buf);
    return ab;
}

/* ================================================================
 * MessagePort transfer — global port id allocator (Task: transferable)
 * ================================================================ */

/* 全局递增 port id 池（跨线程原子分配；0 保留给无效 id）。每个
 * MessageChannel 分配一对连续 id（id1=port1, id2=port2，纠缠对）。
 * id 只用于跨线程路由标记，具体路由在 JS 层 polyfill 完成。
 * 项目严格 -std=c99 + CMAKE_C_EXTENSIONS OFF：不能裸用 C11 _Atomic
 * （libuv/quickjs 都靠补丁把 _Atomic 换成 __atomic_* 宏）。这里用普通
 * uint32_t + 内建原子操作（__atomic_fetch_add），见 js_pal_port_create。 */
static uint32_t g_qz_next_port_id = 1;

/* portCreate() -> {id1, id2}：分配一对全局唯一纠缠 port id。 */
static JSValue js_pal_port_create(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val); QZ_UNUSED(argc); QZ_UNUSED(argv);
    uint32_t id1 = __atomic_fetch_add(&g_qz_next_port_id, 1, __ATOMIC_RELAXED) + 1;
    uint32_t id2 = __atomic_fetch_add(&g_qz_next_port_id, 1, __ATOMIC_RELAXED) + 1;
    JSValue obj = JS_NewObject(ctx);
    if (JS_IsException(obj)) return JS_EXCEPTION;
    JS_SetPropertyStr(ctx, obj, "id1", JS_NewUint32(ctx, id1));
    JS_SetPropertyStr(ctx, obj, "id2", JS_NewUint32(ctx, id2));
    return obj;
}

/* ================================================================
 * Host message boundary
 * ================================================================ */

static JSValue js_pal_post_message(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    if (argc < 1) return JS_UNDEFINED;

    /* JSON 序列化 JS 值 → C 字符串，再交出站漏斗（M-P7：宿主 rt = 邮箱，
     * 主RT 子进程 = 上行通道；库不调用宿主函数，无「宿主没接回调就丢弃」
     * 的分支——没人消费也只是箱内滞留，free 时统一回收）。 */
    JSValue str = JS_JSONStringify(ctx, argv[0], JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsException(str)) return JS_EXCEPTION;
    size_t len = 0;
    const char *json = JS_ToCStringLen(ctx, &len, str);
    if (!json) {
        JS_FreeValue(ctx, str);
        return JS_EXCEPTION;
    }

    qz_post_to_host(rt, json, len);
    JS_FreeCString(ctx, json);
    JS_FreeValue(ctx, str);
    return JS_UNDEFINED;
}

/* ================================================================
 * Web Worker (Task 4) — parent/worker pal primitives
 * ================================================================ */

/* 同步整文件读取（worker.js 的 new Worker(file://) 需要同步加载脚本；
 * polyfill 的 fs.js readFileSync 不可用，故补这一个同步原语）。 */
static JSValue js_pal_fs_read_sync(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    if (argc < 1) return JS_EXCEPTION;
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    /* Same ".." traversal guard as the async fs ops — sync reads (worker
     * script loader) must not bypass it. */
    if (!bridge_validate_path(path)) {
        JS_FreeCString(ctx, path);
        return JS_ThrowTypeError(ctx, "Path traversal detected");
    }

    FILE *f = fopen(path, "rb");
    if (!f) {
        JSValue e = JS_ThrowTypeError(ctx, "fsReadSync: cannot open %s", path);
        JS_FreeCString(ctx, path);
        return e;
    }
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        JS_FreeCString(ctx, path);
        return JS_ThrowTypeError(ctx, "fsReadSync: seek failed");
    }
    long sz = ftell(f);
    if (sz < 0) {
        fclose(f);
        JS_FreeCString(ctx, path);
        return JS_ThrowTypeError(ctx, "fsReadSync: ftell failed");
    }
    rewind(f);
    char *buf = (char *)js_malloc(ctx, (size_t)sz + 1);
    if (!buf) {
        fclose(f);
        JS_FreeCString(ctx, path);
        return JS_EXCEPTION;
    }
    size_t got = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[got] = '\0';
    JS_FreeCString(ctx, path);
    JSValue ret = JS_NewStringLen(ctx, buf, got);
    js_free(ctx, buf);
    return ret;
}

/* 递归创建目录链（mkdir -p），含最终目录组件。仅用于 fsWriteSync 的父目录
 * 预建（localStorage 首次写入 ~/.qzjs/ 时该目录可能尚不存在）。 */
static int bridge_mkdir_p(const char *dir)
{
    size_t len = strlen(dir);
    if (len == 0) return -1;
    char *tmp = (char *)malloc(len + 2);
    if (!tmp) return -1;
    memcpy(tmp, dir, len + 1);
    /* 末尾补 '/', 使下方循环也创建最终目录组件（否则只建祖先目录） */
    if (tmp[len - 1] != '/') {
        tmp[len] = '/';
        tmp[len + 1] = '\0';
    }
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            if (mkdir(tmp, 0755) != 0 && errno != EEXIST) {
                free(tmp);
                return -1;
            }
            *p = '/';
        }
    }
    free(tmp);
    return 0;
}

/* 同步写文件原语（localStorage 持久化用）：原子写 —— 先写临时文件再 rename。
 * polyfill 的异步 fs.writeFile 无法在 setItem 返回前完成落盘，故补此同步原语。
 * 返回 void；失败抛 TypeError（调用方按需回滚内存态）。 */
static JSValue js_pal_fs_write_sync(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    if (argc < 1) return JS_EXCEPTION;
    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    if (!bridge_validate_path(path)) {
        JS_FreeCString(ctx, path);
        return JS_ThrowTypeError(ctx, "Path traversal detected");
    }

    const char *data = NULL;
    size_t data_len = 0;
    if (argc >= 2 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        data = JS_ToCStringLen(ctx, &data_len, argv[1]);
        if (!data) {
            JS_FreeCString(ctx, path);
            return JS_EXCEPTION;
        }
    }

    /* 父目录 mkdir -p（首次写入 ~/.qzjs/ 时目录不存在） */
    const char *slash = strrchr(path, '/');
    if (slash && slash != path) {
        size_t dlen = (size_t)(slash - path);
        char *dir = (char *)malloc(dlen + 1);
        if (!dir) {
            JS_FreeCString(ctx, path);
            if (data) JS_FreeCString(ctx, data);
            return JS_ThrowOutOfMemory(ctx);
        }
        memcpy(dir, path, dlen);
        dir[dlen] = '\0';
        int rc = bridge_mkdir_p(dir);
        free(dir);
        if (rc != 0) {
            JS_FreeCString(ctx, path);
            if (data) JS_FreeCString(ctx, data);
            return JS_ThrowTypeError(ctx, "fsWriteSync: cannot create parent dir for %s", path);
        }
    }

    /* 原子写：写 path.tmp 再 rename 到 path */
    size_t path_len = strlen(path);
    char *tmp_path = (char *)malloc(path_len + 8);
    if (!tmp_path) {
        JS_FreeCString(ctx, path);
        if (data) JS_FreeCString(ctx, data);
        return JS_ThrowOutOfMemory(ctx);
    }
    memcpy(tmp_path, path, path_len);
    memcpy(tmp_path + path_len, ".tmp", 5);   /* 含 '\0' */

    FILE *f = fopen(tmp_path, "wb");
    if (!f) {
        JSValue err = JS_ThrowTypeError(ctx, "fsWriteSync: cannot open %s", tmp_path);
        free(tmp_path);
        JS_FreeCString(ctx, path);
        if (data) JS_FreeCString(ctx, data);
        return err;
    }
    size_t n = fwrite(data ? data : "", 1, data ? data_len : 0, f);
    int ferr = fclose(f);
    if (n != (data ? data_len : 0) || ferr != 0) {
        JSValue err = JS_ThrowTypeError(ctx, "fsWriteSync: write failed for %s", tmp_path);
        remove(tmp_path);
        free(tmp_path);
        JS_FreeCString(ctx, path);
        if (data) JS_FreeCString(ctx, data);
        return err;
    }
    if (rename(tmp_path, path) != 0) {
        JSValue err = JS_ThrowTypeError(ctx, "fsWriteSync: rename failed for %s", path);
        remove(tmp_path);
        free(tmp_path);
        JS_FreeCString(ctx, path);
        if (data) JS_FreeCString(ctx, data);
        return err;
    }
    free(tmp_path);
    JS_FreeCString(ctx, path);
    if (data) JS_FreeCString(ctx, data);
    return JS_UNDEFINED;
}

/* pal.localStoragePath() -> string
 * localStorage 持久化文件路径：环境变量 QZ_LOCALSTORAGE_FILE 优先，否则
 * 默认 ~/.qzjs/localstorage.json（跨项目持久化；HOME 不可用回退当前目录
 * .qzjs-localstorage.json）。 */
static JSValue js_pal_local_storage_path(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val); QZ_UNUSED(argc); QZ_UNUSED(argv);
    const char *env = getenv("QZ_LOCALSTORAGE_FILE");
    if (env && *env) {
        return JS_NewString(ctx, env);
    }
    const char *home = getenv("HOME");
    if (home && *home) {
        size_t n = strlen(home) + strlen("/.qzjs/localstorage.json") + 1;
        char *buf = (char *)malloc(n);
        if (!buf) return JS_ThrowOutOfMemory(ctx);
        snprintf(buf, n, "%s/.qzjs/localstorage.json", home);
        JSValue ret = JS_NewString(ctx, buf);
        free(buf);
        return ret;
    }
    return JS_NewString(ctx, ".qzjs-localstorage.json");
}

/* 父侧 pal.spawnWorker：脚本字符串 → 阻塞创建 worker 线程，返回 worker id */
static JSValue js_pal_spawn_worker(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    if (argc < 1) return JS_EXCEPTION;
    const char *script = JS_ToCString(ctx, argv[0]);
    if (!script) return JS_EXCEPTION;

    int err = 0;
    qz_worker_t *w = qz_worker_create(rt, script, &err);
    JS_FreeCString(ctx, script);
    if (!w) {
        return JS_ThrowTypeError(ctx, "spawnWorker failed (err %d)", err);
    }
    return JS_NewInt32(ctx, w->id);
}

/* pal 发送原语的可选 kind 参数（M-P3/M-P4）：argv[idx] 缺失/undefined →
 * MESSAGE。放行 PORT_TRANSFER（port 帧）与 STORAGE（M-P4 单所有者 storage
 * 代理回复）——CONTROL 是 C 侧协议面，不经 JS pal 发送路径。 */
static int bridge_kind_arg(JSContext *ctx, int argc, JSValueConst *argv, int idx)
{
    if (argc <= idx || JS_IsUndefined(argv[idx]))
        return IPC_ENV_KIND_MESSAGE;
    int32_t k = IPC_ENV_KIND_MESSAGE;
    if (JS_ToInt32(ctx, &k, argv[idx]) != 0) {
        JS_GetException(ctx);   /* 非法实参：退回 MESSAGE，不炸发送路径 */
        return IPC_ENV_KIND_MESSAGE;
    }
    return k == IPC_ENV_KIND_PORT_TRANSFER ? IPC_ENV_KIND_PORT_TRANSFER
         : k == IPC_ENV_KIND_STORAGE      ? IPC_ENV_KIND_STORAGE
                                          : IPC_ENV_KIND_MESSAGE;
}

/* 父侧 pal.workerPost：结构化克隆字节 → worker 入站队列 */
static JSValue js_pal_worker_post(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    if (argc < 2) return JS_EXCEPTION;
    int32_t id;
    if (JS_ToInt32(ctx, &id, argv[0]) != 0) return JS_EXCEPTION;
    size_t len = 0;
    const uint8_t *bytes = JS_GetUint8Array(ctx, &len, argv[1]);
    if (!bytes) bytes = JS_GetArrayBuffer(ctx, &len, argv[1]);
    if (!bytes) return JS_ThrowTypeError(ctx, "workerPost: expected bytes");

    qz_worker_t *w = qz_worker_get(rt, id);
    if (!w) return JS_ThrowTypeError(ctx, "workerPost: no worker %d", id);
    qz_worker_post(rt, w, bytes, len,
                     bridge_kind_arg(ctx, argc, argv, 2) == IPC_ENV_KIND_PORT_TRANSFER
                         ? QZ_MSG_FLAG_PORT_TRANSFER : 0);
    return JS_UNDEFINED;
}

/* 父侧 pal.workerTerminate：请求 worker 退出（异步，父 teardown 时 join） */
static JSValue js_pal_worker_terminate(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    if (argc < 1) return JS_EXCEPTION;
    int32_t id;
    if (JS_ToInt32(ctx, &id, argv[0]) != 0) return JS_EXCEPTION;
    qz_worker_t *w = qz_worker_get(rt, id);
    if (!w) return JS_UNDEFINED;   /* 已终止/不存在：幂等 */
    qz_worker_terminate(rt, w);
    return JS_UNDEFINED;
}

#ifndef QZ_USE_MOCK_LIBUV
/* ================================================================
 * 通用进程原语（spawn 分层化, Phase B）
 *
 * C 层只给"启动任意可执行文件 + 信封字节通道（编解码仍在 C）"原语；
 * Worker 语义由 JS 层（polyfill/src/worker.js）封装。进程句柄是整数 id，
 * 注册在 rt->proc_handles[]，显式 processTerminate 释放（无 GC finalizer）。
 * ================================================================ */

/* JS 字符串数组 → C argv（calloc 数组 + 每元素 strdup；argv[n]=NULL）。
 * 返回 NULL 表示非数组 / 超长 / OOM；*out_n 为已填充元素数（失败时已
 * 释放，调用方按 0 处理）。上限防御任意大数组的 calloc 滥用。 */
static char **bridge_js_to_argv(JSContext *ctx, JSValueConst arr, int *out_n)
{
    *out_n = 0;
    JSValue jlen = JS_GetPropertyStr(ctx, arr, "length");
    if (JS_IsException(jlen)) return NULL;
    int32_t n = 0;
    if (JS_ToInt32(ctx, &n, jlen) != 0) {
        JS_FreeValue(ctx, jlen);
        return NULL;
    }
    JS_FreeValue(ctx, jlen);
    if (n <= 0 || n > 4096) return NULL;
    char **argv = (char **)calloc((size_t)n + 1, sizeof(char *));
    if (!argv) return NULL;
    for (int32_t i = 0; i < n; i++) {
        JSValue s = JS_GetPropertyUint32(ctx, arr, (uint32_t)i);
        const char *cs = JS_ToCString(ctx, s);
        JS_FreeValue(ctx, s);
        if (!cs) {
            for (int k = 0; k < i; k++) free(argv[k]);
            free(argv);
            return NULL;
        }
        argv[i] = strdup(cs);
        JS_FreeCString(ctx, cs);
        if (!argv[i]) {
            for (int k = 0; k < i; k++) free(argv[k]);
            free(argv);
            return NULL;
        }
    }
    argv[n] = NULL;
    *out_n = (int)n;
    return argv;
}

static void bridge_free_argv(char **argv, int n)
{
    for (int i = 0; i < n; i++) free(argv[i]);
    free(argv);
}

static qz_proc_handle_t *bridge_proc_handle_get(qz_t *rt, int id)
{
    for (int i = 0; i < QZ_MAX_PROC_HANDLES; i++) {
        qz_proc_handle_t *h = &rt->proc_handles[i];
        if (h->live && h->id == id) return h;
    }
    return NULL;
}

/* 读回调（父 loop 线程 = JS 线程，可直接 JS_Call）：信封 payload → JS
 * 回调(Uint8Array, kind, corr)；payload=NULL → peer-death/EOF，JS 回调(null,
 * kind, 0)。kind（M-P3）原样透传：PORT_TRANSFER 帧让 JS port 层走端点路由，
 * 普通帧交各消费者的应用派发；corr = STORAGE 中继关联 id（非 STORAGE 帧恒
 * 0），owner 的 __qz_storage_dispatch__ 按它原样回显回复。h 指向 qz_t
 * 内嵌数组元素，指针恒有效（terminate 只清字段不释放数组）。JS 回调内部可能
 * terminate 本句柄（proc 的释放是 uv_close 异步），回调返回后我们不再 touch
 * h，故无 UAF。source 对本消费者无意义。 */
static void bridge_proc_msg_cb(void *user, int8_t kind, int32_t source,
                               int32_t corr,
                               const uint8_t *payload, uint32_t len)
{
    qz_proc_handle_t *h = (qz_proc_handle_t *)user;
    QZ_UNUSED(source);
    if (!h->live || !h->ctx || !h->ctx->jsctx) return;
    JSContext *ctx = h->ctx->jsctx;
    if (!JS_IsFunction(ctx, h->onmsg)) return;
    /* JS_Call 期间必须持有一份引用：回调内部可能 processTerminate 本句柄
     * （JS_FreeValue h->onmsg 使引用计数归零）。若直接传 h->onmsg，函数会在
     * 调用栈帧内被 GC 释放 → UAF/堆损坏。dup 后回调返回再释放。 */
    JSValue fn = JS_DupValue(ctx, h->onmsg);
    JSValue arg = payload ? JS_NewArrayBufferCopy(ctx, payload, len)
                          : JS_NULL;
    JSValue jkind = JS_NewInt32(ctx, kind);
    JSValue jcorr = JS_NewInt32(ctx, corr);
    if (JS_IsException(arg) || JS_IsException(jkind) ||
        JS_IsException(jcorr)) {
        /* OOM 建 ArrayBuffer：跳过本帧。必须 JS_GetException 清掉挂起异常，
         * 否则该异常会污染 context——后续每一帧的 JS_NewArrayBufferCopy /
         * JS_Call 都立即返回同一个异常，读回调在 C 层照常解码但 JS 侧从此
         * 收不到任何消息（洪水下 rcvd 卡死）。 */
        JS_GetException(ctx);
        JS_FreeValue(ctx, arg);
        JS_FreeValue(ctx, jkind);
        JS_FreeValue(ctx, jcorr);
        JS_FreeValue(ctx, fn);
        return;
    }
    JSValue args[3] = { arg, jkind, jcorr };
    qz_js_call_cleanup(ctx, fn, JS_UNDEFINED, 3, args);
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, arg);
    JS_FreeValue(ctx, jkind);
    JS_FreeValue(ctx, jcorr);
}

/* pal.processSpawn(exe, argv, opts) → int handle id（>0）。
 * exe: 任意可执行文件路径；""/null → C 端 auto-resolve qzjs-rt。
 * argv: JS 字符串数组（argv[0]=程序名；含 --parent-fd 3 等子进程参数）。
 * opts: { role?: int（缺省 QZ_IPC_ROLE_WORKER）, id?: int（缺省 1）,
 *         handshake?: bool（缺省 true）}。
 * 失败抛 InternalError。 */
static JSValue js_pal_process_spawn(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_ThrowInternalError(ctx, "processSpawn: no runtime");
    /* §1.1 树形拓扑：worker 进程亦可 spawn 子 worker（嵌套 spawn）。进程后端
     * 原语（socketpair/fork+exec/握手/读回调）不依赖「本 runtime 是主RT」，
     * worker runtime 同样持有 proc_handles[] 与 uv loop，故不再按 worker_self
     * 拒绝（THREAD 编译由下方 ISOLATED 守卫拒绝）。 */

#ifndef QZ_PROCESS_MODEL_ISOLATED
    /* THREAD 编译未启用进程后端（§1.4：不静默降级——显式选 PROCESS 在求值点
     * 报错，而不是悄悄退回线程后端）。mock 测试构建走不到此处（无 ipc 后端）。 */
    return JS_ThrowInternalError(ctx,
        "processSpawn: QZ_PROCESS_MODEL=THREAD build has no process backend");
#endif

    const char *exe = NULL;
    if (argc >= 1 && !JS_IsNull(argv[0]) && !JS_IsUndefined(argv[0]))
        exe = JS_ToCString(ctx, argv[0]);

    int nargv = 0;
    char **cargv = NULL;
    if (argc >= 2)
        cargv = bridge_js_to_argv(ctx, argv[1], &nargv);
    if (!cargv || nargv <= 0) {
        if (exe) JS_FreeCString(ctx, exe);
        return JS_ThrowTypeError(ctx,
            "processSpawn: argv must be a non-empty string array");
    }

    int role = QZ_IPC_ROLE_WORKER;
    int id = 1;
    int require_handshake = 1;
    /* opts.source → 启动源码，经管道传给子进程（零落盘）。见 spawn 注释。 */
    const char *script_src = NULL;
    size_t script_len = 0;
    if (argc >= 3 && JS_IsObject(argv[2])) {
        JSValue jr = JS_GetPropertyStr(ctx, argv[2], "role");
        if (!JS_IsUndefined(jr)) { JS_ToInt32(ctx, &role, jr); }
        JS_FreeValue(ctx, jr);
        JSValue ji = JS_GetPropertyStr(ctx, argv[2], "id");
        if (!JS_IsUndefined(ji)) { JS_ToInt32(ctx, &id, ji); }
        JS_FreeValue(ctx, ji);
        JSValue jh = JS_GetPropertyStr(ctx, argv[2], "handshake");
        if (!JS_IsUndefined(jh)) require_handshake = JS_ToBool(ctx, jh);
        /* opts.source: 启动源码字符串。worker.js 用它替代「写临时文件 +
         * 传 --script PATH」——源码经管道传给子进程，零落盘。非字符串/
         * 缺失 → NULL（子进程走 --script PATH）。 */
        JSValue jsrc = JS_GetPropertyStr(ctx, argv[2], "source");
        if (!JS_IsUndefined(jsrc) && !JS_IsNull(jsrc)
            && JS_IsString(jsrc)) {
            script_src = JS_ToCStringLen(ctx, &script_len, jsrc);
        }
        JS_FreeValue(ctx, jsrc);
    }

    qz_proc_t *proc = qz_proc_new();
    if (!proc) {
        bridge_free_argv(cargv, nargv);
        if (exe) JS_FreeCString(ctx, exe);
        return JS_ThrowOutOfMemory(ctx);
    }
    int rc = qz_proc_spawn(rt, proc, exe, cargv, role, id,
                            require_handshake, script_src, script_len,
                            NULL, 0);   /* worker 路径只送源码，不送字节码 */
    if (script_src) JS_FreeCString(ctx, script_src);
    /* fork+exec 在 spawn 内同步完成，cargv 仅在调用期间需要 */
    bridge_free_argv(cargv, nargv);
    if (exe) JS_FreeCString(ctx, exe);

    if (rc != 0) {
        qz_proc_free(proc);
        return JS_ThrowInternalError(ctx, "processSpawn: spawn failed (%d)",
                                     rc);
    }

    qz_proc_handle_t *h = NULL;
    for (int i = 0; i < QZ_MAX_PROC_HANDLES; i++) {
        if (!rt->proc_handles[i].live) { h = &rt->proc_handles[i]; break; }
    }
    if (!h) {
        qz_proc_terminate(proc, 0);
        qz_proc_free(proc);
        return JS_ThrowInternalError(ctx,
            "processSpawn: too many process handles");
    }
    h->live = 1;
    h->proc = proc;
    h->ctx = get_ctx_from_jsctx(rt, ctx);
    h->onmsg = JS_UNDEFINED;
    h->id = (int)(++rt->proc_handle_seq);
    /* CTL-1：本进程是 runtime（主RT 或父 worker）——本通道到达的命令类
     * CONTROL（worker 回执上行 / 子命令）在 C 层树路由，不进 JS 层。 */
    proc->ctl_route_id = qz_ctl_local_id(rt);

    qz_proc_start_read_cb(proc, bridge_proc_msg_cb, h);
    return JS_NewInt32(ctx, h->id);
}

/* pal.processPost(handle, bytes[, kind[, corr]]) → bool（I6 语义：false = 写
 * 失败 / 已死）。kind 缺省 MESSAGE；PORT_TRANSFER 让信封带 kind=1（M-P3）；
 * corr = STORAGE 中继关联 id（owner 回复回显请求 corr，缺省 0）。 */
static JSValue js_pal_process_post(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt || argc < 2) return JS_NewBool(ctx, 0);
    int32_t hid = 0;
    if (JS_ToInt32(ctx, &hid, argv[0]) != 0) return JS_NewBool(ctx, 0);
    qz_proc_handle_t *h = bridge_proc_handle_get(rt, hid);
    if (!h || !h->proc) return JS_NewBool(ctx, 0);

    size_t len = 0;
    const uint8_t *data = JS_GetUint8Array(ctx, &len, argv[1]);
    if (!data) data = JS_GetArrayBuffer(ctx, &len, argv[1]);
    if (!data) return JS_ThrowTypeError(ctx, "processPost: expected bytes");

    int32_t corr = 0;
    if (argc > 3 && !JS_IsUndefined(argv[3]))
        JS_ToInt32(ctx, &corr, argv[3]);
    int rc = qz_proc_post(h->proc, 0, h->proc->id,
                            bridge_kind_arg(ctx, argc, argv, 2),
                            corr,
                            data, (uint32_t)len);
    return JS_NewBool(ctx, rc == 0);
}

/* pal.processOnMessage(handle, callback) → void（callback(Uint8Array, kind)
 * 收消息；callback(null, kind) 表示 peer-death/EOF）。重复注册替换旧回调。 */
static JSValue js_pal_process_on_message(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt || argc < 2) return JS_UNDEFINED;
    int32_t hid = 0;
    if (JS_ToInt32(ctx, &hid, argv[0]) != 0) return JS_UNDEFINED;
    qz_proc_handle_t *h = bridge_proc_handle_get(rt, hid);
    if (!h) return JS_UNDEFINED;
    if (!JS_IsFunction(ctx, argv[1]))
        return JS_ThrowTypeError(ctx,
            "processOnMessage: callback must be a function");
    JSValue old = h->onmsg;
    h->onmsg = JS_DupValue(ctx, argv[1]);
    JS_FreeValue(ctx, old);
    return JS_UNDEFINED;
}

/* pal.processTerminate(handle) → void（3-tier terminate + 释放句柄，幂等） */
static JSValue js_pal_process_terminate(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt || argc < 1) return JS_UNDEFINED;
    int32_t hid = 0;
    if (JS_ToInt32(ctx, &hid, argv[0]) != 0) return JS_UNDEFINED;
    qz_proc_handle_t *h = bridge_proc_handle_get(rt, hid);
    if (!h) return JS_UNDEFINED;
    if (h->proc) {
        qz_proc_terminate(h->proc, 0);
        qz_proc_free(h->proc);
        h->proc = NULL;
    }
    JS_FreeValue(ctx, h->onmsg);
    h->onmsg = JS_UNDEFINED;
    h->ctx = NULL;
    h->live = 0;
    return JS_UNDEFINED;
}

/* pal.processPing(handle, timeoutMs) → int（liveness：检测 sub worker 事件
 * 循环阻塞。仅显式调用触发，无后台心跳。镜像 rt_host.c qz_ping：发
 * CONTROL{"qzjs":1,"ping":seq}（corr=seq）→ 阻塞等 sub worker 读回调 C 层直
 * 回的 PONG → 0=通畅 / 1=超时（对端 loop 阻塞）/ -1=通道死（EOF/状态错）。
 * 单飞行：JS 同步调用同一 handle 同时至多一个在途 ping。 */
static JSValue js_pal_process_ping(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt || argc < 1) return JS_NewInt32(ctx, -1);
    int32_t hid = 0;
    if (JS_ToInt32(ctx, &hid, argv[0]) != 0) return JS_NewInt32(ctx, -1);
    int32_t timeout_ms = 1000;
    if (argc >= 2 && JS_ToInt32(ctx, &timeout_ms, argv[1]) != 0)
        return JS_NewInt32(ctx, -1);
    qz_proc_handle_t *h = bridge_proc_handle_get(rt, hid);
    if (!h || !h->proc) return JS_NewInt32(ctx, -1);
    return JS_NewInt32(ctx, qz_proc_ping(h->proc, timeout_ms));
}
#endif /* !QZ_USE_MOCK_LIBUV */

/* pal.workerBackend → 'thread' | 'process'（当前 worker 后端，JS 层查询用）。
 * mock 构建（QZ_USE_MOCK_LIBUV）无 ipc_process.c → 恒 'thread'：JS 层据
 * 此走 pal.spawnWorker（线程）路径；若宿主在 mock 下仍设 PROCESS，spawnWorker
 * 照旧报 NOT_SUPPORTED（worker.c I4），与现状一致，无静默降级。 */
static JSValue js_pal_worker_backend(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val); QZ_UNUSED(argc); QZ_UNUSED(argv);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
#ifdef QZ_USE_MOCK_LIBUV
    QZ_UNUSED(rt);
    return JS_NewString(ctx, "thread");
#else
    if (rt && rt->config.worker_backend == QZ_WORKER_BACKEND_PROCESS)
        return JS_NewString(ctx, "process");
    return JS_NewString(ctx, "thread");
#endif
}

/* Worker 侧 pal.postMessage(bytes[, kind])：克隆字节 → 父入站队列
 * （source=worker id）。kind 缺省 MESSAGE；PORT_TRANSFER（M-P3）在进程后端
 * 让信封带 kind=1，线程后端落成 msgq flags（应用派发路径不变）。 */
static JSValue js_pal_worker_emit(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    if (argc < 1) return JS_EXCEPTION;
    size_t len = 0;
    const uint8_t *bytes = JS_GetUint8Array(ctx, &len, argv[0]);
    if (!bytes) bytes = JS_GetArrayBuffer(ctx, &len, argv[0]);
    if (!bytes) return JS_ThrowTypeError(ctx, "worker postMessage: expected bytes");

    qz_worker_t *w = (qz_worker_t *)rt->worker_self;
    int kind = bridge_kind_arg(ctx, argc, argv, 1);
    /* I6: propagate the write result to JS instead of swallowing it. The
     * child's emit fd is non-blocking (uv_pipe_open set it), so under parent
     * backpressure the frame write can fail (EAGAIN) rather than block the
     * worker's JS thread; the thread backend likewise only drops on msgq OOM.
     * Returning the boolean lets the caller detect a dropped postMessage —
     * the old code discarded both return values, hiding real message loss. */
    int rc = -1;
    /* Thread backend: push to parent's msgq (source = worker id).
     * Process backend: parent is NULL, send via IPC child channel. */
    if (w->parent) {
        rc = qz_msg_push(w->parent, (const char *)bytes, len, w->id,
                           kind == IPC_ENV_KIND_PORT_TRANSFER
                               ? QZ_MSG_FLAG_PORT_TRANSFER : 0);
        /* 唤醒与容器解耦（M-P7）：入站调用点显式 wake 父 qzjs 线程。 */
        if (rc == 0) uv_async_send(&w->parent->wake);
    }
#ifndef QZ_USE_MOCK_LIBUV
    else if (qz_ipc_child_channel() >= 0) {
        rc = qz_ipc_child_emit((int32_t)w->id, 0, (int8_t)kind,
                                 0,
                                 bytes, (uint32_t)len);
    }
#endif
    return JS_NewBool(ctx, rc == 0);
}

/* Worker 侧 pal.workerClose：请求终止自身（不 join；父 teardown 时 join） */
static JSValue js_pal_worker_close(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val); QZ_UNUSED(argc); QZ_UNUSED(argv);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    qz_worker_t *w = (qz_worker_t *)rt->worker_self;
    /* Thread backend: terminate via parent. Process backend: parent is NULL,
     * set shutting_down + wake the loop to exit (rt_main.c checks it). */
    if (w && w->parent) {
        qz_worker_terminate(w->parent, w);
    } else if (rt) {
#ifndef QZ_USE_MOCK_LIBUV
        /* M-P4 §9.3：进程后端先发 CONTROL{closing} 通知父「自愿退出」——父侧
         * 收到后随后的 fd EOF 不再当作崩溃触发 Worker.onerror。 */
            qz_ipc_child_emit((int32_t)(w ? w->id : 0), 0,
                                IPC_ENV_KIND_CONTROL,
                                0,
                                (const uint8_t *)QZ_IPC_CTL_CLOSING,
                                (uint32_t)strlen(QZ_IPC_CTL_CLOSING));
#endif
        __atomic_store_n(&rt->shutting_down, 1, __ATOMIC_RELEASE);
        uv_async_send(&rt->wake);
    }
    return JS_UNDEFINED;
}

#ifndef QZ_USE_MOCK_LIBUV
/* pal.storageSync(bytes) → Uint8Array（M-P4 §10.2 单所有者代理的 worker 半边）。
 * bytes = structured clone{op,key,value?,storageDomain} 请求；同步阻塞等待
 * 主RT 所有者执行后回的结果字节（C 层 child_storage_sync：poll/recv 等待，
 * 期间不派发任何 JS——同步 API 语义保持；父进程死亡 → EOF → 抛错，worker
 * 走 §9.4 孤儿自杀链）。仅 worker 进程可达；所有者/宿主调用报错（storage
 * 归主RT 独占执行，无代理场景）。 */
static JSValue js_pal_storage_sync(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    if (!rt->worker_self)
        return JS_ThrowInternalError(ctx,
            "storageSync: owner runtime executes storage directly");
    if (argc < 1) return JS_EXCEPTION;
    size_t len = 0;
    const uint8_t *bytes = JS_GetUint8Array(ctx, &len, argv[0]);
    if (!bytes) bytes = JS_GetArrayBuffer(ctx, &len, argv[0]);
    if (!bytes) return JS_ThrowTypeError(ctx, "storageSync: expected bytes");

    uint8_t *reply = NULL;
    uint32_t reply_len = 0;
    if (qz_ipc_child_storage_sync(rt, bytes, (uint32_t)len,
                                    &reply, &reply_len) != 0)
        return JS_ThrowInternalError(ctx,
            "storageSync: owner unreachable (runtime terminated)");
    JSValue ret = JS_NewArrayBufferCopy(ctx, reply, reply_len);
    free(reply);
    return ret;
}

/* pal.storageRelay(bytes, childId, corr) → bool（N-P4：非根 runtime 的 storage
 * 中继上游半边）。worker 收到子树发来的 kind=STORAGE 请求时调本函数：把请求
 * 原样上行给父（逐跳直到根/所有者），并登记「上行 corr → 发起子槽位 + 下行
 * corr（= 子进程帧携带的 corr，回复原样回传）」。owner 的回复沿父通道回来时
 * 由 process_rx 按 corr 配对下投（rt->storage_relays 表）。corr 由本节点
 * storage_corr_seq 单调分配（与自身同步 RPC 共用计数，杜绝撞号）。表满 → 返回
 * false（§10.2 单飞行兜底：并发子树请求超过槽位数时新请求不排队）。 */
static JSValue js_pal_storage_relay(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    if (!rt->worker_self)
        return JS_ThrowInternalError(ctx,
            "storageRelay: root runtime is the storage owner");
    if (argc < 2) return JS_EXCEPTION;
    size_t len = 0;
    const uint8_t *bytes = JS_GetUint8Array(ctx, &len, argv[0]);
    if (!bytes) bytes = JS_GetArrayBuffer(ctx, &len, argv[0]);
    if (!bytes) return JS_ThrowTypeError(ctx, "storageRelay: expected bytes");
    int32_t child = 0;
    if (JS_ToInt32(ctx, &child, argv[1]) != 0) return JS_EXCEPTION;
    int32_t down_corr = 0;
    if (argc > 2 && !JS_IsUndefined(argv[2]))
        JS_ToInt32(ctx, &down_corr, argv[2]);

    int slot = -1;
    for (int i = 0; i < QZ_MAX_PROC_HANDLES; i++) {
        if (rt->storage_relays[i].up_corr == 0) { slot = i; break; }
    }
    if (slot < 0)
        return JS_FALSE;    /* 表满：并发子树请求超槽位数，不排队（§10.2） */
    int32_t up_corr;
    do { up_corr = ++rt->storage_corr_seq; } while (up_corr == 0);
    rt->storage_relays[slot].up_corr = up_corr;
    rt->storage_relays[slot].down_corr = down_corr;
    rt->storage_relays[slot].child = child;
    if (qz_ipc_child_emit((int32_t)((qz_worker_t *)rt->worker_self)->id,
                            QZ_IPC_HOST_ID, IPC_ENV_KIND_STORAGE,
                            up_corr,
                            bytes, (uint32_t)len) != 0) {
        rt->storage_relays[slot].up_corr = 0;
        return JS_FALSE;
    }
    return JS_TRUE;
}
#endif /* !QZ_USE_MOCK_LIBUV */

/* Worker 侧 pal.workerId：返回自身 worker id（>0）。worker 把 MessagePort
 * transfer 给父线程时，父侧需要真实 workerId 才能经 pal.workerPost 把消息
 * 路由回留在 worker 的对端 port——故此处必须暴露，不能用 'parent' 占位。 */
static JSValue js_pal_worker_id(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val); QZ_UNUSED(argc); QZ_UNUSED(argv);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    qz_worker_t *w = (qz_worker_t *)rt->worker_self;
    if (!w) return JS_NewInt32(ctx, 0);
    return JS_NewInt32(ctx, w->id);
}

/* ================================================================
 * Multi-context JS API (Task 5) — 父 runtime 上运行，宿主只见主 context。
 * spawn/suspend/resume/destroy 全部由 qzContext（context.js）经这里驱动；
 * C 只做边界转换 + 调用 context.c 的辅助函数，序列化逻辑在 JS 侧。
 * ================================================================ */

/* pal.selfPath() → int[]（本 runtime 的 §8.2 path 链）。
 * 根 runtime（主RT/宿主）= []；子 = 父 path ++ [本节点槽位 id]。
 * ISOLATED 下 worker 的完整 path 由 spawn argv --path 传入（rt_main.c 写入
 * rt->self_path）；THREAD worker 无 argv 路径 → 退化为单元素 [workerId]
 * （THREAD 树恒为深度 1，语义与扁平一致）。 */
static JSValue js_pal_self_path(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val); QZ_UNUSED(argc); QZ_UNUSED(argv);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    JSValue arr = JS_NewArray(ctx);
    uint32_t n = 0;
    for (uint32_t i = 0; i < rt->self_path_len; i++)
        JS_SetPropertyUint32(ctx, arr, n++, JS_NewInt32(ctx, rt->self_path[i]));
    if (n == 0 && rt->worker_self) {
        qz_worker_t *w = (qz_worker_t *)rt->worker_self;
        JS_SetPropertyUint32(ctx, arr, n++, JS_NewInt32(ctx, w->id));
    }
    return arr;
}

/* pal.contextSpawn(initScript)：新子 context，返回 ctx id */
static JSValue js_pal_context_spawn(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    if (argc < 1) return JS_EXCEPTION;
    const char *script = JS_ToCString(ctx, argv[0]);
    if (!script) return JS_EXCEPTION;
    int id = qz_ctx_spawn(rt, script);
    JS_FreeCString(ctx, script);
    if (id < 0) return JS_ThrowTypeError(ctx, "contextSpawn failed (err %d)", id);
    return JS_NewInt32(ctx, id);
}

/* pal.contextSuspend(ctxId, statePath)：挂起 = 序列化全局克隆字节写盘 + 销毁 ctx */
static JSValue js_pal_context_suspend(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    if (argc < 2) return JS_EXCEPTION;
    int32_t id;
    if (JS_ToInt32(ctx, &id, argv[0]) != 0) return JS_EXCEPTION;
    const char *path = JS_ToCString(ctx, argv[1]);
    if (!path) return JS_EXCEPTION;
    int rc = qz_ctx_serialize(rt, id, path);
    JS_FreeCString(ctx, path);
    if (rc != QZ_OK) return JS_ThrowTypeError(ctx, "contextSuspend failed (err %d)", rc);
    return JS_UNDEFINED;
}

/* pal.contextResume(ctxId, scriptRef, statePath)：在原槽位重建 ctx + 恢复状态 */
static JSValue js_pal_context_resume(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    if (argc < 3) return JS_EXCEPTION;
    int32_t id;
    if (JS_ToInt32(ctx, &id, argv[0]) != 0) return JS_EXCEPTION;
    const char *script = JS_ToCString(ctx, argv[1]);
    if (!script) return JS_EXCEPTION;
    const char *path = JS_ToCString(ctx, argv[2]);
    if (!path) { JS_FreeCString(ctx, script); return JS_EXCEPTION; }
    int rc = qz_ctx_rebuild(rt, id, script, path);
    JS_FreeCString(ctx, script);
    JS_FreeCString(ctx, path);
    if (rc < 0) return JS_ThrowTypeError(ctx, "contextResume failed (err %d)", rc);
    return JS_NewInt32(ctx, rc);
}

/* pal.contextDestroy(ctxId)：销毁子 context（active 的返回 BUSY） */
static JSValue js_pal_context_destroy(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    QZ_UNUSED(this_val);
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    if (argc < 1) return JS_EXCEPTION;
    int32_t id;
    if (JS_ToInt32(ctx, &id, argv[0]) != 0) return JS_EXCEPTION;
    int rc = qz_ctx_destroy_id(rt, id);
    if (rc != QZ_OK) return JS_ThrowTypeError(ctx, "contextDestroy failed (err %d)", rc);
    return JS_UNDEFINED;
}

/* 主 context 入站派发：宿主 JSON 已解析成值；source0=host。 */
void qz_dispatch_message(qz_t *rt, qz_msg_t *m)
{
    /* 主 context（第一个 context）上找 __qz_dispatch__ 并调用 */
    qz_ctx_t *cctx = rt->contexts[0];
    if (!cctx || !cctx->jsctx) return;
    JSContext *ctx = cctx->jsctx;
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, g, "__qz_dispatch__");
    JS_FreeValue(ctx, g);
    if (JS_IsFunction(ctx, fn)) {
        JSValue src = JS_NewInt32(ctx, m->source);
        JSValue data;
        /* 非宿主来源 = 进程/线程 worker 的克隆字节；kind 由 msgq flags 投影
         * （PORT_TRANSFER 的 port 帧据此走端点路由）。宿主来源是 JSON 文本，
         * 恒为 MESSAGE。 */
        JSValue kind = JS_NewInt32(ctx, m->source == QZ_MSG_SRC_HOST
                                        ? 0 : qz_msg_kind(m->flags));
        if (m->source == QZ_MSG_SRC_HOST) {
            /* msgq 保证 m->data 以 '\0' 结尾（data[len]=='\0'），可直接喂
             * JS_ParseJSON（quickjs-ng 无 JS_JSONParse）。 */
            data = JS_ParseJSON(ctx, m->data, m->len, "<qzjs-msg>");
            if (JS_IsException(data)) {
                /* spec §5: bad JSON → error envelope */
                JS_FreeValue(ctx, data);
                JS_FreeValue(ctx, kind);
                JS_FreeValue(ctx, fn);
                static const char *bad = "{\"type\":\"error\",\"error\":\"bad-json\"}";
                qz_post_to_host(rt, bad, strlen(bad));
                return;
            }
        } else {
            data = JS_NewArrayBufferCopy(ctx, (const uint8_t *)m->data, m->len);
        }
        JSValue args[3] = { data, src, kind };
        qz_js_call_cleanup(ctx, fn, JS_UNDEFINED, 3, args);
        JS_FreeValue(ctx, data);
        JS_FreeValue(ctx, src);
        JS_FreeValue(ctx, kind);
    }
    JS_FreeValue(ctx, fn);
}

/* ================================================================
 * Create the internal pal JS object (per-context version)
 * ================================================================ */



JSValue qz_create_pal_object_ctx(qz_t *rt, qz_ctx_t *ctx)
{
    JSContext *jsctx = ctx->jsctx;
    JSValue pal = JS_NewObject(jsctx);
    if (JS_IsException(pal)) {
        return JS_EXCEPTION;
    }

    /* Sync functions */
    JS_SetPropertyStr(jsctx, pal, "timeNow", JS_NewCFunction(jsctx, js_pal_time_now, "timeNow", 0));
    JS_SetPropertyStr(jsctx, pal, "hrtime", JS_NewCFunction(jsctx, js_pal_hrtime, "hrtime", 0));
    /* 带源名的 eval（栈帧 / 断点匹配用，见 js_pal_native_eval_script） */
    JS_SetPropertyStr(jsctx, pal, "nativeEvalScript",
                      JS_NewCFunction(jsctx, js_pal_native_eval_script, "nativeEvalScript", 2));
    JS_SetPropertyStr(jsctx, pal, "log", JS_NewCFunction(jsctx, js_pal_log, "log", 2));
    JS_SetPropertyStr(jsctx, pal, "timerStop", JS_NewCFunction(jsctx, js_pal_timer_stop, "timerStop", 1));

    /* Timer start (returns {handle, promise}) */
    JS_SetPropertyStr(jsctx, pal, "timerStart", JS_NewCFunction(jsctx, js_pal_timer_start, "timerStart", 2));

    /* Async functions (return Promises) — stubs until Task 3 */
    JS_SetPropertyStr(jsctx, pal, "httpRequest", JS_NewCFunction(jsctx, js_pal_http_request, "httpRequest", 4));
    JS_SetPropertyStr(jsctx, pal, "httpRequestStream", JS_NewCFunction(jsctx, js_pal_http_request_stream, "httpRequestStream", 7));
    JS_SetPropertyStr(jsctx, pal, "httpRequestAbort", JS_NewCFunction(jsctx, js_pal_http_request_abort, "httpRequestAbort", 1));
    JS_SetPropertyStr(jsctx, pal, "fsRead", JS_NewCFunction(jsctx, js_pal_fs_read, "fsRead", 1));
    JS_SetPropertyStr(jsctx, pal, "fsReadBinary", JS_NewCFunction(jsctx, js_pal_fs_read_binary, "fsReadBinary", 1));
    JS_SetPropertyStr(jsctx, pal, "fsReadSync", JS_NewCFunction(jsctx, js_pal_fs_read_sync, "fsReadSync", 1));
    JS_SetPropertyStr(jsctx, pal, "fsWriteSync", JS_NewCFunction(jsctx, js_pal_fs_write_sync, "fsWriteSync", 2));
    JS_SetPropertyStr(jsctx, pal, "fsWrite", JS_NewCFunction(jsctx, js_pal_fs_write, "fsWrite", 2));
    JS_SetPropertyStr(jsctx, pal, "fsExists", JS_NewCFunction(jsctx, js_pal_fs_exists, "fsExists", 1));
    JS_SetPropertyStr(jsctx, pal, "fsRemove", JS_NewCFunction(jsctx, js_pal_fs_remove, "fsRemove", 1));
    JS_SetPropertyStr(jsctx, pal, "fsList", JS_NewCFunction(jsctx, js_pal_fs_list, "fsList", 1));
    JS_SetPropertyStr(jsctx, pal, "storageGet", JS_NewCFunction(jsctx, js_pal_storage_get, "storageGet", 1));
    JS_SetPropertyStr(jsctx, pal, "storageSet", JS_NewCFunction(jsctx, js_pal_storage_set, "storageSet", 2));
    JS_SetPropertyStr(jsctx, pal, "storageDel", JS_NewCFunction(jsctx, js_pal_storage_del, "storageDel", 1));
    JS_SetPropertyStr(jsctx, pal, "localStoragePath", JS_NewCFunction(jsctx, js_pal_local_storage_path, "localStoragePath", 0));

    /* Sync CSPRNG */
    JS_SetPropertyStr(jsctx, pal, "randomBytes", JS_NewCFunction(jsctx, js_pal_random_bytes, "randomBytes", 1));

    /* MessagePort transfer: 全局唯一 port id 对分配（worker/父都可用） */
    JS_SetPropertyStr(jsctx, pal, "portCreate", JS_NewCFunction(jsctx, js_pal_port_create, "portCreate", 0));

    /* 当前 worker 后端（'thread' | 'process'）——父/worker runtime 都可查 */
    JS_SetPropertyStr(jsctx, pal, "workerBackend", JS_NewCFunction(jsctx, js_pal_worker_backend, "workerBackend", 0));

    /* Host message boundary / Web Worker (Task 4).
     * worker runtime（rt->worker_self 非 NULL）：postMessage → 父入站（克隆
     * 字节），另有 workerClose；worker 无宿主邮箱可见性（qz_post_to_host 丢弃），
     * 但持有进程原语以支持
     * §1.1 嵌套 spawn（worker 内 new Worker 起子进程）。父 runtime：
     * postMessage → 宿主 JSON，另有 spawnWorker / workerPost / workerTerminate。 */
    /* §8.2 path 链（父/worker runtime 都可查；JS port 层的端点身份来源） */
    JS_SetPropertyStr(jsctx, pal, "selfPath", JS_NewCFunction(jsctx, js_pal_self_path, "selfPath", 0));
    if (rt->worker_self) {
        JS_SetPropertyStr(jsctx, pal, "postMessage", JS_NewCFunction(jsctx, js_pal_worker_emit, "postMessage", 1));
        JS_SetPropertyStr(jsctx, pal, "workerClose", JS_NewCFunction(jsctx, js_pal_worker_close, "workerClose", 0));
        JS_SetPropertyStr(jsctx, pal, "workerId", JS_NewCFunction(jsctx, js_pal_worker_id, "workerId", 0));
#ifndef QZ_USE_MOCK_LIBUV
        /* M-P4 §10.2：同步 storage RPC（worker 进程 localStorage 代理 →
         * 主RT 所有者）。mock 构建（无 ipc_process.c）不注册——THREAD worker
         * 不挂 localStorage（基线不回归），workerBackend()==='thread' 时
         * setupLocalStorage 直接 return，storageSync 不可达。 */
        JS_SetPropertyStr(jsctx, pal, "storageSync", JS_NewCFunction(jsctx, js_pal_storage_sync, "storageSync", 1));
        /* N-P4：storage 中继 —— 非根 runtime 把子树的 kind=STORAGE 请求上行，
         * owner（根）的回复由 process_rx 按登记下投（§10.2 单所有者代理的
         * 嵌套延伸：孙的 localStorage 经各级到达主RT 所有者）。 */
        JS_SetPropertyStr(jsctx, pal, "storageRelay", JS_NewCFunction(jsctx, js_pal_storage_relay, "storageRelay", 2));
        /* §1.1 嵌套 spawn：worker 进程同样注册通用进程原语，JS 层 Worker
         * 封装（worker.js）据此在 worker 内 new Worker 起子 worker 进程。
         * 与父 runtime 同签名；读回调/槽位登记复用 bridge 既有实现。 */
        JS_SetPropertyStr(jsctx, pal, "processSpawn", JS_NewCFunction(jsctx, js_pal_process_spawn, "processSpawn", 3));
        JS_SetPropertyStr(jsctx, pal, "processPost", JS_NewCFunction(jsctx, js_pal_process_post, "processPost", 2));
        JS_SetPropertyStr(jsctx, pal, "processOnMessage", JS_NewCFunction(jsctx, js_pal_process_on_message, "processOnMessage", 2));
        JS_SetPropertyStr(jsctx, pal, "processTerminate", JS_NewCFunction(jsctx, js_pal_process_terminate, "processTerminate", 1));
        JS_SetPropertyStr(jsctx, pal, "processPing", JS_NewCFunction(jsctx, js_pal_process_ping, "processPing", 2));
#endif
    } else {
        JS_SetPropertyStr(jsctx, pal, "postMessage", JS_NewCFunction(jsctx, js_pal_post_message, "postMessage", 1));
        JS_SetPropertyStr(jsctx, pal, "spawnWorker", JS_NewCFunction(jsctx, js_pal_spawn_worker, "spawnWorker", 1));
        JS_SetPropertyStr(jsctx, pal, "workerPost", JS_NewCFunction(jsctx, js_pal_worker_post, "workerPost", 2));
        JS_SetPropertyStr(jsctx, pal, "workerTerminate", JS_NewCFunction(jsctx, js_pal_worker_terminate, "workerTerminate", 1));
#ifndef QZ_USE_MOCK_LIBUV
        /* 通用进程原语（spawn 分层化, Phase B）——JS 层 Worker 封装用 */
        JS_SetPropertyStr(jsctx, pal, "processSpawn", JS_NewCFunction(jsctx, js_pal_process_spawn, "processSpawn", 3));
        JS_SetPropertyStr(jsctx, pal, "processPost", JS_NewCFunction(jsctx, js_pal_process_post, "processPost", 2));
        JS_SetPropertyStr(jsctx, pal, "processOnMessage", JS_NewCFunction(jsctx, js_pal_process_on_message, "processOnMessage", 2));
        JS_SetPropertyStr(jsctx, pal, "processTerminate", JS_NewCFunction(jsctx, js_pal_process_terminate, "processTerminate", 1));
        JS_SetPropertyStr(jsctx, pal, "processPing", JS_NewCFunction(jsctx, js_pal_process_ping, "processPing", 2));
#endif
        /* Multi-context (Task 5) — 父 runtime 专属 */
        JS_SetPropertyStr(jsctx, pal, "contextSpawn", JS_NewCFunction(jsctx, js_pal_context_spawn, "contextSpawn", 1));
        JS_SetPropertyStr(jsctx, pal, "contextSuspend", JS_NewCFunction(jsctx, js_pal_context_suspend, "contextSuspend", 2));
        JS_SetPropertyStr(jsctx, pal, "contextResume", JS_NewCFunction(jsctx, js_pal_context_resume, "contextResume", 3));
        JS_SetPropertyStr(jsctx, pal, "contextDestroy", JS_NewCFunction(jsctx, js_pal_context_destroy, "contextDestroy", 1));
#ifndef QZ_USE_MOCK_LIBUV
        /* TCP socket PAL — excluded from mock-libuv test builds */
        qz_tcp_io_init(jsctx, pal);
#endif
    }

    return pal;
}

/* ================================================================
 * Inject polyfill via __native_inject__ temp global (per-context version)
 * ================================================================ */

int qz_inject_polyfill_ctx(qz_t *rt, qz_ctx_t *ctx, const uint8_t *code, size_t code_len)
{
    JSContext *jsctx = ctx->jsctx;
    JSValue global = JS_GetGlobalObject(jsctx);

    /* Create the pal object */
    JSValue pal = qz_create_pal_object_ctx(rt, ctx);
    if (JS_IsException(pal)) {
        JS_FreeValue(jsctx, global);
        return -1;
    }

    /* Set __native_inject__ as a global temp var */
    JS_SetPropertyStr(jsctx, global, "__native_inject__", pal);

    JS_FreeValue(jsctx, global);

    /* Evaluate the polyfill code.
     * Expected format: (function(pal){ ... })(__native_inject__);
     */
    JSValue result = JS_Eval(jsctx, (const char *)code, code_len, "<polyfill>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
        JSValue exc = JS_GetException(jsctx);
        if (rt->debug) {
            const char *err_str = JS_ToCString(jsctx, exc);
            if (err_str) {
                fprintf(stderr, "[qzjs] polyfill eval error: %s\n", err_str);
                JS_FreeCString(jsctx, err_str);
            }
        }
        JS_FreeValue(jsctx, exc);
        return -1;
    }
    JS_FreeValue(jsctx, result);

    /* Post-polyfill fixup: set ReadableStream[Symbol.asyncIterator]
     * if not already set. The polyfill may not set it if Symbol.asyncIterator
     * was not available during evaluation (QuickJS IIFE loading order). */
    {
        JSValue global2 = JS_GetGlobalObject(jsctx);
        JSValue rs_ctor = JS_GetPropertyStr(jsctx, global2, "ReadableStream");
        JS_FreeValue(jsctx, global2);
        if (JS_IsFunction(jsctx, rs_ctor)) {
            /* Set asyncIterator on ReadableStream.prototype if not already set.
             * Using JS_Eval since Symbol.asyncIterator is awkward to construct from C.
             * The `if` guard prevents overwriting if the polyfill already set it. */
            const char *iter_code =
                "if(!ReadableStream.prototype[Symbol.asyncIterator])"
                "ReadableStream.prototype[Symbol.asyncIterator]=function(){"
                "var r=this.getReader();"
                "return{next:function(){return r.read();},"
                "return:function(v){r.releaseLock();return{done:true,value:v};}};"
                "}";
            JSValue iter_result = JS_Eval(jsctx, iter_code, strlen(iter_code),
                                            "<asyncIterator>", JS_EVAL_TYPE_GLOBAL);
            JS_FreeValue(jsctx, iter_result);
        }
        JS_FreeValue(jsctx, rs_ctor);
    }

    /* After polyfill runs, move __native_inject__ to __native__ so extension init
     * hooks can register functions on the same pal object that the polyfill's
     * closures reference. */
    global = JS_GetGlobalObject(jsctx);
    JSAtom inject_atom = JS_NewAtom(jsctx, "__native_inject__");
    JSValue pal_ref = JS_GetProperty(jsctx, global, inject_atom);
    JS_DeleteProperty(jsctx, global, inject_atom, 0);
    JS_FreeAtom(jsctx, inject_atom);
    if (!JS_IsUndefined(pal_ref) && !JS_IsException(pal_ref)) {
        JS_SetPropertyStr(jsctx, global, "__native__", pal_ref);
    } else {
        JS_FreeValue(jsctx, pal_ref);
    }
    JS_FreeValue(jsctx, global);

    return 0;
}
