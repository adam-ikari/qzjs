/*
 * qzjs — DAP (Debug Adapter Protocol) front-end implementation
 *
 * PAL-agnostic. Provides the DAP callback set + base-protocol I/O + a minimal
 * JSON parser/serializer that qz_create installs when debugging is enabled.
 * The DAP stdin pump runs inside on_stopped when JS pauses.
 *
 * Threading: single-threaded. on_stopped blocks reading DAP requests until a
 * flow command (continue/step) sets the step mode and returns, unblocking the
 * interrupt handler → JS resumes.
 *
 * Compiled in only when QZ_DEBUG_SUPPORT is defined (QZ_BUILD_DEBUGGER=ON).
 */
#include "qz_internal.h"

#ifdef QZ_DEBUG_SUPPORT

#include "qzjs/qz_debug.h"
#include "qzjs/qz_debug_dap.h"
#include <quickjs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <poll.h>
#include <unistd.h>

/* ================================================================
 * JSON（vendored cJSON）
 *
 * 协议 I/O 用 vendored cJSON（deps/cjson/，v1.7.19，MIT）——用户指令：
 * C 层 JSON 不手写。帧重组（dap_read_message）按 Content-Length 读完整
 * 一帧后才解析，无增量解析需求，cJSON_Parse 直接可用。
 *
 * 为何必须在 C 层（勿删/勿改走 JS_ParseJSON）：解析点 dap_on_stopped 暂停泵
 * 运行在 JS 断点内——世界冻结（async JS/PAL 回调不前进，debugger.c 有
 * 重入门），JS 引擎栈在断点现场，此时调 JS_ParseJSON 属引擎重入。
 * 裁决留痕：docs/architecture/c-js-layering.md §6.6。
 * ================================================================ */

#include <cJSON.h>

/* ================================================================
 * DAP session state
 * ================================================================ */

typedef struct qz_dap {
    qz_t *rt;
    qz_debug_t *dbg;
    FILE *in;
    FILE *out;
    int seq;             /* outbound message sequence counter */
    int configured;      /* 1 after configurationDone */
    int claimed_stdio;   /* 1 when this session owns the process-wide stdio
                          * claim (M-R1 §13.2: one stdio DAP per process);
                          * qz_dap_detach releases it. */
} qz_dap_t;

/* ================================================================
 * DAP message sending
 * ================================================================ */

static void dap_send(qz_dap_t *d, const char *json)
{
    size_t n = strlen(json);
    fprintf(d->out, "Content-Length: %zu\r\n\r\n%s", n, json);
    fflush(d->out);
}

/* Build & send an event: {"type":"event","event":name,"body":body,...} */
static void dap_send_event(qz_dap_t *d, const char *event, const char *body_json)
{
    cJSON *msg = cJSON_CreateObject();
    if (!msg) return;
    cJSON_AddStringToObject(msg, "type", "event");
    cJSON_AddNumberToObject(msg, "seq", ++d->seq);
    cJSON_AddStringToObject(msg, "event", event);
    if (body_json && body_json[0]) {
        cJSON *body = cJSON_Parse(body_json);
        if (body)
            cJSON_AddItemToObject(msg, "body", body);
    }
    char *buf = cJSON_PrintUnformatted(msg);
    cJSON_Delete(msg);
    if (buf) {
        dap_send(d, buf);
        free(buf);   /* cJSON_PrintUnformatted uses malloc — free, not cJSON_Free */
    }
}

/* Build & send a response: type "response", success, command, body, message. */
static void dap_send_response(qz_dap_t *d, int request_seq, const char *command,
                              int success, const char *body_json, const char *error_msg)
{
    cJSON *msg = cJSON_CreateObject();
    if (!msg) return;
    cJSON_AddStringToObject(msg, "type", "response");
    cJSON_AddNumberToObject(msg, "request_seq", request_seq);
    cJSON_AddNumberToObject(msg, "seq", ++d->seq);
    cJSON_AddStringToObject(msg, "command", command);
    cJSON_AddBoolToObject(msg, "success", success ? 1 : 0);
    if (body_json && body_json[0]) {
        cJSON *body = cJSON_Parse(body_json);
        if (body)
            cJSON_AddItemToObject(msg, "body", body);
    }
    if (error_msg)
        cJSON_AddStringToObject(msg, "message", error_msg);
    char *buf = cJSON_PrintUnformatted(msg);
    cJSON_Delete(msg);
    if (buf) {
        dap_send(d, buf);
        free(buf);
    }
}

/* ================================================================
 * DAP base protocol read
 * ================================================================ */

/* Read one DAP message (Content-Length header + JSON body). Returns malloc'd
 * JSON string (caller frees), or NULL on EOF/error. Sets *out_seq to the
 * request seq, *out_command to a malloc'd command string. */
static char *dap_read_message(qz_dap_t *d, int *out_seq, char **out_command,
                              char **out_arguments)
{
    *out_seq = 0;
    *out_command = NULL;
    *out_arguments = NULL;
    /* Read headers until blank line. */
    long content_length = -1;
    char line[1024];
    while (fgets(line, sizeof(line), d->in)) {
        /* strip CRLF */
        size_t L = strlen(line);
        while (L > 0 && (line[L-1] == '\n' || line[L-1] == '\r')) line[--L] = '\0';
        if (L == 0) break;  /* end of headers */
        if (strncmp(line, "Content-Length:", 15) == 0) {
            content_length = strtol(line + 15, NULL, 10);
        }
    }
    if (feof(d->in)) return NULL;
    if (content_length < 0) return NULL;
    char *body = malloc((size_t)content_length + 1);
    if (!body) return NULL;
    if (fread(body, 1, (size_t)content_length, d->in) != (size_t)content_length) {
        free(body);
        return NULL;
    }
    body[content_length] = '\0';

    {
        cJSON *j = cJSON_Parse(body);
        if (j) {
            const cJSON *seqv = cJSON_GetObjectItemCaseSensitive(j, "seq");
            if (cJSON_IsNumber(seqv))
                *out_seq = seqv->valueint;
            const cJSON *cmdv = cJSON_GetObjectItemCaseSensitive(j, "command");
            if (cJSON_IsString(cmdv) && cmdv->valuestring)
                *out_command = strdup(cmdv->valuestring);
            /* arguments：保持既有接口——malloc'd JSON 子串（嵌套对象），
             * 由各 handler 再解析。 */
            const cJSON *argsv = cJSON_GetObjectItemCaseSensitive(j, "arguments");
            if (argsv) {
                char *raw = cJSON_PrintUnformatted(argsv);
                if (raw) {
                    *out_arguments = strdup(raw);
                    free(raw);
                }
            }
            cJSON_Delete(j);
        }
    }
    return body;
}

/* ================================================================
 * on_stopped pump — the paused DAP request loop
 * ================================================================ */

/* Poll stdin for a DAP message with a timeout. Returns:
 *   1 = message available (call dap_read_message to get it)
 *   0 = timeout (no message yet — caller can pump PAL)
 *  -1 = EOF / error */
static int dap_poll_message(qz_dap_t *d, int timeout_ms)
{
    if (!d || !d->in) return -1;
    int fd = fileno(d->in);
    if (fd < 0) return -1;
    struct pollfd pfd = { fd, POLLIN, 0 };
    int rc = poll(&pfd, 1, timeout_ms);
    if (rc < 0) return -1;
    if (rc == 0) return 0;  /* timeout */
    if (pfd.revents & (POLLERR | POLLNVAL | POLLHUP)) return -1;
    return 1;  /* readable */
}

/* Forward: handle a single DAP request; returns 1 if it was a flow command
 * (continue/step/stop) that should end the paused pump, 0 otherwise. */
static int dap_handle_request(qz_dap_t *d, const char *command,
                              const char *args, int req_seq);
/* Request handlers shared across the three pumps (paused / mid-run /
 * configure) — defined with the other handlers below. */
static void dap_handle_set_breakpoints(qz_dap_t *d, const char *args, int req_seq);
static void dap_handle_set_exception_breakpoints(qz_dap_t *d, const char *args,
                                                 int req_seq);

/* The DAP callback for on_stopped. Pumps DAP requests until a flow command.
 * Design note: while paused the world is frozen by design — async JS (timers,
 * PAL callbacks) does not advance, and the re-entrancy guard in debugger.c
 * suppresses PAL-driven re-entry. This matches standard debugger semantics
 * (freeze on break). */
static void dap_on_stopped(qz_debug_t *dbg, const char *reason, int thread_id)
{
    (void)thread_id;
    /* Recover the per-runtime DAP layer from the debug session — no global. */
    qz_t *rt = qz_debug_get_runtime(dbg);
    qz_dap_t *d = rt ? (qz_dap_t *)rt->dap : NULL;
    if (!d) return;

    /* emit stopped event — for an exception stop, carry the message so the
     * client can show "Exception: <text>" at the throw site. cJSON escapes
     * the (user-controlled) message; the snprintf path stays for the
     * fixed-shape bodies. */
    if (strcmp(reason, "exception") == 0) {
        const char *msg = qz_debug_last_exception(dbg);
        cJSON *body = cJSON_CreateObject();
        if (body) {
            cJSON_AddStringToObject(body, "reason", reason);
            cJSON_AddStringToObject(body, "description", "Exception");
            cJSON_AddStringToObject(body, "text", msg ? msg : "exception");
            cJSON_AddNumberToObject(body, "threadId", 1);
            cJSON_AddBoolToObject(body, "allThreadsStopped", 1);
            char *buf = cJSON_PrintUnformatted(body);
            dap_send_event(d, "stopped",
                           buf ? buf : "{\"reason\":\"exception\"}");
            free(buf);
            cJSON_Delete(body);
        }
    } else {
        char body[256];
        snprintf(body, sizeof(body),
            "{\"reason\":\"%s\",\"threadId\":1,\"allThreadsStopped\":true}",
            reason);
        dap_send_event(d, "stopped", body);
    }

    /* pump until a flow command */
    for (;;) {
        int pr = dap_poll_message(d, 50);  /* 50ms poll */
        if (pr < 0) break;                 /* EOF */
        if (pr == 0) {
            /* no DAP message yet — keep waiting */
            continue;
        }
        int req_seq = 0; char *cmd = NULL, *args = NULL;
        char *msg = dap_read_message(d, &req_seq, &cmd, &args);
        if (!msg) break;
        if (cmd) {
            if (dap_handle_request(d, cmd, args, req_seq)) {
                free(msg); free(cmd); free(args);
                break;
            }
        }
        free(msg); free(cmd); free(args);
    }
}

/* ================================================================
 * Request handlers
 * ================================================================ */

/* Each returns 1 if it's a flow command (continue/step/stop) that ends the
 * paused pump, 0 otherwise. */

static int dap_handle_request(qz_dap_t *d, const char *command,
                              const char *args, int req_seq)
{
    if (strcmp(command, "continue") == 0) {
        qz_debug_continue(d->dbg);
        dap_send_response(d, req_seq, "continue", 1, "{\"allThreadsContinued\":true}", NULL);
        return 1;
    }
    if (strcmp(command, "next") == 0) {
        qz_debug_step_over(d->dbg);
        dap_send_response(d, req_seq, "next", 1, "{}", NULL);
        return 1;
    }
    if (strcmp(command, "stepIn") == 0) {
        qz_debug_step_into(d->dbg);
        dap_send_response(d, req_seq, "stepIn", 1, "{}", NULL);
        return 1;
    }
    if (strcmp(command, "stepOut") == 0) {
        qz_debug_step_out(d->dbg);
        dap_send_response(d, req_seq, "stepOut", 1, "{}", NULL);
        return 1;
    }
    if (strcmp(command, "pause") == 0) {
        qz_debug_pause(d->dbg);
        dap_send_response(d, req_seq, "pause", 1, "{}", NULL);
        return 0;
    }
    if (strcmp(command, "threads") == 0) {
        dap_send_response(d, req_seq, "threads", 1,
            "{\"threads\":[{\"id\":1,\"name\":\"main\"}]}", NULL);
        return 0;
    }
    if (strcmp(command, "stackTrace") == 0) {
        qz_debug_frame *frames = NULL; int n = 0;
        qz_debug_get_call_frames(d->dbg, &frames, &n);
        cJSON *body = cJSON_CreateObject();
        cJSON *arr = cJSON_AddArrayToObject(body, "stackFrames");
        int i;
        for (i = 0; arr && i < n; i++) {
            cJSON *f = cJSON_CreateObject();
            if (!f) break;
            cJSON_AddNumberToObject(f, "id", frames[i].id);
            cJSON_AddStringToObject(f, "name",
                frames[i].name ? frames[i].name : "<anonymous>");
            cJSON_AddNumberToObject(f, "line", frames[i].line);
            cJSON_AddNumberToObject(f, "column", frames[i].column);
            cJSON *src = cJSON_AddObjectToObject(f, "source");
            if (src)
                cJSON_AddStringToObject(src, "path",
                    frames[i].source_path ? frames[i].source_path : "");
            cJSON_AddItemToArray(arr, f);
        }
        cJSON_AddNumberToObject(body, "totalFrames", n);
        char *buf = body ? cJSON_PrintUnformatted(body) : NULL;
        cJSON_Delete(body);
        dap_send_response(d, req_seq, "stackTrace", 1, buf ? buf : "", NULL);
        free(buf);
        qz_debug_free_frames(frames, n);
        return 0;
    }
    if (strcmp(command, "scopes") == 0) {
        long fid = 0;
        if (args) {
            cJSON *ja = cJSON_Parse(args);
            if (ja) {
                const cJSON *fv = cJSON_GetObjectItemCaseSensitive(ja, "frameId");
                if (cJSON_IsNumber(fv))
                    fid = fv->valueint;
                cJSON_Delete(ja);
            }
        }
        qz_debug_scope *scopes = NULL; int n = 0;
        int rc = qz_debug_get_scopes(d->dbg, (int)fid, &scopes, &n);
        if (rc < 0) {
            dap_send_response(d, req_seq, "scopes", 1, "{\"scopes\":[]}", NULL);
            return 0;
        }
        cJSON *body = cJSON_CreateObject();
        cJSON *arr = cJSON_AddArrayToObject(body, "scopes");
        int i;
        for (i = 0; arr && i < n; i++) {
            cJSON *s = cJSON_CreateObject();
            if (!s) break;
            cJSON_AddStringToObject(s, "name", scopes[i].name);
            cJSON_AddNumberToObject(s, "variablesReference",
                                    scopes[i].variables_reference);
            cJSON_AddBoolToObject(s, "expensive", scopes[i].expensive ? 1 : 0);
            cJSON_AddItemToArray(arr, s);
        }
        char *buf = body ? cJSON_PrintUnformatted(body) : NULL;
        cJSON_Delete(body);
        dap_send_response(d, req_seq, "scopes", 1, buf ? buf : "", NULL);
        free(buf);
        qz_debug_free_scopes(scopes, n);
        return 0;
    }
    if (strcmp(command, "variables") == 0) {
        long vr = 0;
        if (args) {
            cJSON *ja = cJSON_Parse(args);
            if (ja) {
                const cJSON *rv = cJSON_GetObjectItemCaseSensitive(ja,
                    "variablesReference");
                if (cJSON_IsNumber(rv))
                    vr = rv->valueint;
                cJSON_Delete(ja);
            }
        }
        qz_debug_var *vars = NULL; int n = 0;
        int rc = qz_debug_get_variables(d->dbg, (int)vr, &vars, &n);
        if (rc < 0) {
            dap_send_response(d, req_seq, "variables", 1, "{\"variables\":[]}", NULL);
            return 0;
        }
        cJSON *body = cJSON_CreateObject();
        cJSON *arr = cJSON_AddArrayToObject(body, "variables");
        int i;
        for (i = 0; arr && i < n; i++) {
            cJSON *v = cJSON_CreateObject();
            if (!v) break;
            cJSON_AddStringToObject(v, "name",
                vars[i].name ? vars[i].name : "");
            cJSON_AddStringToObject(v, "value",
                vars[i].value_json ? vars[i].value_json : "undefined");
            /* Real expandable reference: objects/arrays hand back a slot id
             * that the `variables` command drills into (0 = leaf). */
            cJSON_AddNumberToObject(v, "variablesReference",
                                    vars[i].variables_reference);
            cJSON_AddStringToObject(v, "type",
                vars[i].type ? vars[i].type : "object");
            cJSON_AddItemToArray(arr, v);
        }
        char *buf = body ? cJSON_PrintUnformatted(body) : NULL;
        cJSON_Delete(body);
        dap_send_response(d, req_seq, "variables", 1, buf ? buf : "", NULL);
        free(buf);
        qz_debug_free_vars(vars, n);
        return 0;
    }
    if (strcmp(command, "evaluate") == 0) {
        char *expr = NULL;
        long fid = 0;
        if (args) {
            cJSON *ja = cJSON_Parse(args);
            if (ja) {
                const cJSON *ev = cJSON_GetObjectItemCaseSensitive(ja, "expression");
                if (cJSON_IsString(ev) && ev->valuestring)
                    expr = strdup(ev->valuestring);
                const cJSON *fv = cJSON_GetObjectItemCaseSensitive(ja, "frameId");
                if (cJSON_IsNumber(fv))
                    fid = fv->valueint;
                cJSON_Delete(ja);
            }
        }
        char *val = NULL, *err = NULL;
        int vref = 0;
        int rc = qz_debug_evaluate(d->dbg, (int)fid, expr ? expr : "", &val, &err,
                                   &vref);
        cJSON *body = cJSON_CreateObject();
        if (body) {
            cJSON_AddStringToObject(body, "result",
                (rc == 0 && val) ? val : (err ? err : "error"));
            /* Object results are expandable (hover drill-in). */
            cJSON_AddNumberToObject(body, "variablesReference", rc == 0 ? vref : 0);
            char *buf = cJSON_PrintUnformatted(body);
            cJSON_Delete(body);
            dap_send_response(d, req_seq, "evaluate", rc == 0 ? 1 : 0, buf ? buf : "",
                              rc == 0 ? NULL : (err ? err : "evaluate failed"));
            free(buf);
        }
        free(expr); free(val); free(err);
        return 0;
    }
    if (strcmp(command, "disconnect") == 0) {
        dap_send_response(d, req_seq, "disconnect", 1, "{}", NULL);
        qz_debug_continue(d->dbg);  /* unblock so JS can exit */
        return 1;
    }
    if (strcmp(command, "setExceptionBreakpoints") == 0) {
        /* Toggling the exception filter while paused must take effect for
         * the very next throw, not silently fall through to the generic ack. */
        dap_handle_set_exception_breakpoints(d, args, req_seq);
        return 0;
    }
    if (strcmp(command, "setBreakpoints") == 0) {
        /* Editing breakpoints while paused: without this branch the paused
         * pump fell through to the generic `{}` ack and the edit was lost
         * (VS Code would even un-verify the file's breakpoints). */
        dap_handle_set_breakpoints(d, args, req_seq);
        return 0;
    }
    /* unknown / unsupported (setFunctionBreakpoints, source, etc.) —
     * acknowledge success to keep VS Code happy. */
    dap_send_response(d, req_seq, command, 1, "{}", NULL);
    return 0;
}

/* ================================================================
 * Attach / main loop
 * ================================================================ */

/* DAP stdin poll cadence. Also used by the paused pump (dap_on_stopped) as
 * its poll timeout; the periodic run-time timer reuses the same value so an
 * idle uv_run never sleeps longer than this between DAP services. */
#define DAP_POLL_MS 50
/* forward decl — defined with the other request handlers below; shared by the
 * configuration phase and the run-time service pump. */
static void dap_handle_set_breakpoints(qz_dap_t *d, const char *args, int req_seq);


/* Timer callback: fires on the qzjs thread while the debuggee is running.
 * Non-blockingly drains any DAP request that arrived on stdin. */
static void qz_dap_timer_cb(uv_timer_t *t)
{
    qz_t *rt = (qz_t *)t->data;
    if (rt) qz_dap_service(rt);
}

/* Service the DAP stdin channel while the debuggee is NOT paused. Called
 * from the periodic poll timer (see qz_dap_attach); never blocks. Handles
 * the requests that are meaningful mid-run: pause (arm the next dispatch
 * checkpoint to stop), setBreakpoints (replace the named source's breakpoints
 * so new breakpoints take effect immediately) and disconnect (stop polling). All
 * other requests are acknowledged so the VS Code client stays happy; their
 * real work (stackTrace/scopes/variables/evaluate) happens in the paused
 * pump (dap_on_stopped), which runs on the same thread and therefore cannot
 * race with this function. */
void qz_dap_service(qz_t *rt)
{
    qz_dap_t *d = rt ? (qz_dap_t *)rt->dap : NULL;
    if (!d || !d->in) return;

    int pr = dap_poll_message(d, 0);  /* non-blocking */
    if (pr < 0) {
        /* EOF / error on stdin — the client is gone; stop polling. */
        if (rt->dap_timer_active) {
            uv_timer_stop(&rt->dap_timer);
            rt->dap_timer_active = 0;
        }
        return;
    }
    if (pr == 0) return;  /* no message yet */

    int req_seq = 0; char *cmd = NULL, *args = NULL;
    char *msg = dap_read_message(d, &req_seq, &cmd, &args);
    if (!msg) return;
    if (cmd) {
        if (strcmp(cmd, "pause") == 0) {
            qz_debug_pause(d->dbg);
            dap_send_response(d, req_seq, "pause", 1, "{}", NULL);
        } else if (strcmp(cmd, "setBreakpoints") == 0) {
            dap_handle_set_breakpoints(d, args, req_seq);
        } else if (strcmp(cmd, "setExceptionBreakpoints") == 0) {
            /* mid-run toggles of the exception dropdown */
            dap_handle_set_exception_breakpoints(d, args, req_seq);
        } else if (strcmp(cmd, "disconnect") == 0) {
            dap_send_response(d, req_seq, "disconnect", 1, "{}", NULL);
            if (rt->dap_timer_active) {
                uv_timer_stop(&rt->dap_timer);
                rt->dap_timer_active = 0;
            }
        } else {
            /* acknowledge unsupported mid-run requests */
            dap_send_response(d, req_seq, cmd, 1, "{}", NULL);
        }
    }
    free(msg); free(cmd); free(args);
}

/* Attach / main loop.
 * M-R1 §13.2（开放点 #8）：stdio 是进程单通道——一个进程只有一份
 * stdin/stdout，无法同时服务两个 runtime 的 DAP 会话。缺省 attach（cfg
 * 缺省或 in/out 均为 NULL）必须原子认领 stdio，第二实例显式报错拒绝，
 * 不做自动仲裁/通道复用。注入独立 FILE* 的实例不受此约束。
 * -std=c99：plain int + __atomic 内建（与 g_wamr_state 同款）。 */
static int g_dap_stdio_claimed = 0;

int qz_dap_attach(qz_t *rt, const qz_dap_config_t *cfg)
{
    if (!rt) return -1;
    int use_stdio = (!cfg || (!cfg->in && !cfg->out));
    if (use_stdio &&
        __atomic_exchange_n(&g_dap_stdio_claimed, 1, __ATOMIC_ACQ_REL) != 0) {
        fprintf(stderr, "[qzjs] DAP: stdio already attached by another "
                "runtime — pass explicit qz_dap_config_t.in/out fds "
                "for this instance (M-R1 §13.2)\n");
        return -2;   /* explicit reject: no silent arbitration */
    }
    qz_dap_t *d = calloc(1, sizeof(*d));
    if (!d) return -1;
    d->rt = rt;
    d->in = (cfg && cfg->in) ? cfg->in : stdin;
    d->out = (cfg && cfg->out) ? cfg->out : stdout;
    d->seq = 0;
    d->claimed_stdio = use_stdio;

    qz_debug_cbs cbs;
    memset(&cbs, 0, sizeof(cbs));
    cbs.on_stopped = dap_on_stopped;
    d->dbg = qz_debug_attach(rt, &cbs);
    if (!d->dbg) { free(d); return -1; }

    if (cfg && cfg->stop_on_entry)
        qz_debug_stop_on_entry(d->dbg);

    rt->dap = d;

    /* Send initialized event so VS Code knows it can configure breakpoints. */
    dap_send_event(d, "initialized", NULL);

    /* 注册周期轮询 timer：DAP 走 stdin，不是 libuv 事件源。没有它，事件
     * 循环空闲（无 pending work）时 uv_run(UV_RUN_ONCE) 无限阻塞在 poll，
     * 运行中的 pause/setBreakpoints/disconnect 请求永远不被读取。active
     * timer 同时让真 libuv 的 uv_run 有界（backend timeout ≤ DAP_POLL_MS），
     * 每次醒来回调 qz_dap_service 非阻塞服务 stdin。loop 在调用本函数
     * 前已由 thread_main/worker_thread_main 完成 uv_loop_init。 */
    if (!rt->dap_timer_active) {
        uv_timer_init(&rt->loop, &rt->dap_timer);
        rt->dap_timer.data = rt;
        uv_timer_start(&rt->dap_timer, qz_dap_timer_cb,
                       DAP_POLL_MS, DAP_POLL_MS);
        rt->dap_timer_active = 1;
    }
    return 0;
}

void qz_dap_detach(qz_t *rt)
{
    qz_dap_t *d = rt ? (qz_dap_t *)rt->dap : NULL;
    if (!d) return;
    /* stop the periodic stdin poll timer (it keeps the loop alive + waking) */
    if (rt->dap_timer_active) {
        uv_timer_stop(&rt->dap_timer);
        rt->dap_timer_active = 0;
    }
    /* release the process-wide stdio claim so a later attach can take it */
    if (d->claimed_stdio)
        __atomic_store_n(&g_dap_stdio_claimed, 0, __ATOMIC_RELEASE);
    rt->dap = NULL;
    if (d->dbg)
        qz_debug_detach(d->rt, d->dbg);
    free(d);
}

/* Process DAP requests that arrive BEFORE the program starts running (the
 * configuration phase: initialize, setBreakpoints, attach, configurationDone).
 * Called by the host (qz_create auto-attach path) after qz_dap_attach.
 * Returns when configurationDone is received. */
/* Handle setExceptionBreakpoints: DAP sends the FULL set of checked filters
 * each time (during configuration and whenever the user toggles the
 * exception dropdown). MVP supports the "all" filter only — stop on every
 * throw, caught or not (uncaught-only would need catch-detection on the
 * unwind path and is not advertised, so clients won't send it; a client
 * that asks anyway gets verified:false for that filter). Responds with one
 * breakpoint entry per requested filter. Shared by all three pumps. */
static void dap_handle_set_exception_breakpoints(qz_dap_t *d, const char *args,
                                                 int req_seq)
{
    int arm = 0;
    cJSON *resp_bp = cJSON_CreateArray();
    cJSON *ja = args ? cJSON_Parse(args) : NULL;
    const cJSON *filters = ja ?
        cJSON_GetObjectItemCaseSensitive(ja, "filters") : NULL;
    if (cJSON_IsArray(filters)) {
        const cJSON *f;
        cJSON_ArrayForEach(f, filters) {
            int supported = cJSON_IsString(f) && f->valuestring &&
                            strcmp(f->valuestring, "all") == 0;
            if (supported)
                arm = 1;
            cJSON *e = cJSON_CreateObject();
            if (e) {
                cJSON_AddBoolToObject(e, "verified", supported);
                cJSON_AddItemToArray(resp_bp, e);
            }
        }
    }
    qz_debug_set_exception_break(d->dbg, arm);

    cJSON *body = cJSON_CreateObject();
    if (body) {
        cJSON_AddItemToObject(body, "breakpoints", resp_bp);
        char *buf = cJSON_PrintUnformatted(body);
        dap_send_response(d, req_seq, "setExceptionBreakpoints", 1,
                          buf ? buf : "", NULL);
        free(buf);
        cJSON_Delete(body);
    } else {
        cJSON_Delete(resp_bp);
        dap_send_response(d, req_seq, "setExceptionBreakpoints", 1, "{}", NULL);
    }
    cJSON_Delete(ja);
}

/* Handle a setBreakpoints request: replace the breakpoints of the source in
 * `args` (source.path + breakpoints[].line, optional condition) with the ones
 * in the request, then respond with the verified lines. Scoped per source —
 * DAP sends one request per file, so other files' breakpoints must survive;
 * a request without source.path (malformed: DAP requires source) registers
 * nothing and leaves the table untouched rather than wiping files we cannot
 * attribute. Shared by the configuration phase (qz_dap_configure) and the
 * run-time pump (qz_dap_service) so breakpoints added mid-run take effect
 * immediately. */
static void dap_handle_set_breakpoints(qz_dap_t *d, const char *args, int req_seq)
{
    /* args.source.path + args.breakpoints[].line（+ 可选 condition） */
    cJSON *ja = cJSON_Parse(args ? args : "");
    cJSON *bps = ja ? cJSON_GetObjectItemCaseSensitive(ja, "breakpoints") : NULL;
    const cJSON *src = ja ? cJSON_GetObjectItemCaseSensitive(ja, "source") : NULL;
    const char *path = (cJSON_IsObject(src) &&
                        cJSON_IsString(cJSON_GetObjectItemCaseSensitive(src, "path")))
        ? cJSON_GetObjectItemCaseSensitive(src, "path")->valuestring : NULL;

    if (path) {
        qz_debug_clear_breakpoints_in_file(d->dbg, path);
        if (cJSON_IsArray(bps)) {
            const cJSON *bp = NULL;
            cJSON_ArrayForEach(bp, bps) {
                const cJSON *ln = cJSON_GetObjectItemCaseSensitive(bp, "line");
                if (!cJSON_IsNumber(ln) || ln->valueint <= 0)
                    continue;
                const cJSON *cond = cJSON_GetObjectItemCaseSensitive(bp, "condition");
                const char *condstr = (cJSON_IsString(cond) && cond->valuestring)
                    ? cond->valuestring : NULL;
                qz_debug_add_breakpoint(d->dbg, path, ln->valueint, condstr);
            }
        }
    }

    /* respond with verified breakpoints (echo lines) */
    cJSON *body = cJSON_CreateObject();
    cJSON *arr = cJSON_AddArrayToObject(body, "breakpoints");
    if (path && cJSON_IsArray(bps)) {
        const cJSON *bp = NULL;
        cJSON_ArrayForEach(bp, bps) {
            const cJSON *ln = cJSON_GetObjectItemCaseSensitive(bp, "line");
            if (!cJSON_IsNumber(ln) || ln->valueint <= 0)
                continue;
            cJSON *v = cJSON_CreateObject();
            if (!v) break;
            cJSON_AddBoolToObject(v, "verified", 1);
            cJSON_AddNumberToObject(v, "line", ln->valueint);
            cJSON_AddItemToArray(arr, v);
        }
    }
    char *buf = body ? cJSON_PrintUnformatted(body) : NULL;
    cJSON_Delete(body);
    cJSON_Delete(ja);
    dap_send_response(d, req_seq, "setBreakpoints", 1, buf ? buf : "", NULL);
    free(buf);
}

int qz_dap_configure(qz_t *rt)
{
    qz_dap_t *d = rt ? (qz_dap_t *)rt->dap : NULL;
    if (!d) return -1;
    for (;;) {
        int req_seq = 0; char *cmd = NULL, *args = NULL;
        char *msg = dap_read_message(d, &req_seq, &cmd, &args);
        if (!msg) return -1;
        if (!cmd) { free(msg); continue; }

        if (strcmp(cmd, "initialize") == 0) {
            dap_send_response(d, req_seq, "initialize", 1,
                "{\"supportsConfigurationDoneRequest\":true,"
                "\"supportsEvaluateForHovers\":true,"
                "\"supportsStepBack\":false,"
                "\"supportsSetVariable\":false}", NULL);
        } else if (strcmp(cmd, "attach") == 0) {
            dap_send_response(d, req_seq, "attach", 1, "{}", NULL);
        } else if (strcmp(cmd, "setBreakpoints") == 0) {
            dap_handle_set_breakpoints(d, args, req_seq);
        } else if (strcmp(cmd, "setExceptionBreakpoints") == 0) {
            /* armed before the program runs — VS Code sends this during
             * configuration even when nothing is checked (filters:[]) */
            dap_handle_set_exception_breakpoints(d, args, req_seq);
        } else if (strcmp(cmd, "configurationDone") == 0) {
            dap_send_response(d, req_seq, "configurationDone", 1, "{}", NULL);
            free(msg); free(cmd); free(args);
            return 0;
        } else if (strcmp(cmd, "disconnect") == 0) {
            dap_send_response(d, req_seq, "disconnect", 1, "{}", NULL);
            free(msg); free(cmd); free(args);
            return 1;  /* aborted */
        } else {
            /* acknowledge unknown pre-run requests */
            dap_send_response(d, req_seq, cmd, 1, "{}", NULL);
        }
        free(msg); free(cmd); free(args);
    }
}

#endif /* QZ_DEBUG_SUPPORT */
