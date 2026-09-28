// test_dap_gtest — DAP debugger end-to-end (new message model, gtest).
//
// The test forks a child embedding host (mock_libuv build). The child passes
// its JS program as qz_config.initial_script and sets QZ_DEBUG=1, so
// qz_create auto-attaches the DAP layer and blocks in the configuration
// phase (initialize/setBreakpoints/configurationDone) BEFORE eval'ing the
// initial script. The initial script is eval'd as "<initial>", so the parent
// sets breakpoints on source path "<initial>".
//
// The parent acts as the VS Code client over pipes: initialize →
// setBreakpoints → configurationDone, expects a `stopped` event at entry and
// at the breakpoint, then drives stackTrace/scopes/variables/evaluate and
// continues to exit.
//
// NOTE: async JS (fetch/setTimeout) cannot advance while paused at a
// breakpoint in the new model (the qzjs thread is inside JS_Eval in
// on_stopped) — this test therefore only covers synchronous stepping.
//
// Build: cmake -B build -DQZ_BUILD_DEBUGGER=ON -DQZ_BUILD_TESTS=ON
// Run:   ctest -R test_dap_gtest --output-on-failure
#define _POSIX_C_SOURCE 200809L

#include <gtest/gtest.h>

#include <qzjs/qzjs.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <signal.h>
#include <string>
#include <unistd.h>
#include <sys/wait.h>

#ifdef QZ_DEBUG_SUPPORT

/* The JS program the child runs as initial_script (eval'd as "<initial>").
 * Breakpoint at line 3 (the first x++). Wrapped in a function so x is a LOCAL
 * (appears in the Locals scope). */
static const char *kJsProgram =
    "function f() {\n"  /* line 1 */
    "  var x = 1;\n"    /* line 2 */
    "  x++;\n"          /* line 3 <- breakpoint */
    "  x++;\n"          /* line 4 */
    "  x++;\n"          /* line 5 */
    "}\n"               /* line 6 */
    "f();\n";           /* line 7 */

/* Program for the exception-breakpoint tests: throws exactly ONCE at line 2
 * and CAUGHT at line 6 — a caught throw must stop too (the engine hook fires
 * at JS_Throw, before unwinding decides whether anyone catches). */
static const char *kJsExceptionProgram =
    "function boom() {\n"              /* line 1 */
    "  throw new Error(\"gboom\");\n"  /* line 2 <- throw site */
    "}\n"                              /* line 3 */
    "try {\n"                          /* line 4 */
    "  boom();\n"                      /* line 5 */
    "} catch (e) {\n"                  /* line 6 */
    "  1;\n"                           /* line 7 */
    "}\n"                              /* line 8 */
    "2;\n";                            /* line 9 */

/* ---- DAP framing helpers (parent side) ---- */

static void dap_write(int fd, const char *json) {
    char header[64];
    int n = snprintf(header, sizeof(header), "Content-Length: %zu\r\n\r\n",
                     strlen(json));
    (void)!write(fd, header, (size_t)n);
    (void)!write(fd, json, strlen(json));
}

/* Read one DAP message from the child's stdout into a malloc'd buffer.
 * Returns NULL on EOF. *out points into the JSON body (after the blank line). */
static char *dap_read(FILE *f) {
    long clen = -1;
    char line[512];
    while (fgets(line, sizeof(line), f)) {
        size_t L = strlen(line);
        while (L && (line[L - 1] == '\n' || line[L - 1] == '\r')) line[--L] = '\0';
        if (L == 0) break;
        if (strncmp(line, "Content-Length:", 15) == 0)
            clen = strtol(line + 15, nullptr, 10);
    }
    if (clen < 0) return nullptr;
    char *body = (char *)malloc((size_t)clen + 1);
    if (!body) return nullptr;
    if (fread(body, 1, (size_t)clen, f) != (size_t)clen) { free(body); return nullptr; }
    body[clen] = '\0';
    return body;
}

/* Find a field value in a JSON message (naive, like the DAP layer's helper). */
static char *json_get(const char *json, const char *key) {
    size_t klen = strlen(key);
    const char *p = json;
    while ((p = strstr(p, "\"")) != nullptr) {
        if (strncmp(p + 1, key, klen) == 0 && p[1 + klen] == '"') {
            const char *q = p + 1 + klen + 1;
            while (*q && (*q == ' ' || *q == '\t')) q++;
            if (*q == ':') {
                q++;
                while (*q && (*q == ' ' || *q == '\t')) q++;
                if (*q == '"') {
                    const char *e = q + 1;
                    while (*e && (*e != '"' || e[-1] == '\\')) e++;
                    size_t n = (size_t)(e - q - 1);
                    char *out = (char *)malloc(n + 1);
                    memcpy(out, q + 1, n);
                    out[n] = '\0';
                    return out;
                }
                const char *e = q;
                while (*e && *e != ',' && *e != '}' && *e != ']') e++;
                size_t n = (size_t)(e - q);
                char *out = (char *)malloc(n + 1);
                memcpy(out, q, n);
                out[n] = '\0';
                return out;
            }
        }
        p++;
        while (*p && *p != '"') { if (*p == '\\' && p[1]) p++; p++; }
        if (*p == '"') p++;
    }
    return nullptr;
}

/* ---- child: the embedding host ---- */

static int child_main(int in_fd, int out_fd) {
    /* Redirect stdin/stdout to the pipe so qz_dap (which uses stdin/stdout)
     * talks to the parent. */
    dup2(in_fd, STDIN_FILENO);
    dup2(out_fd, STDOUT_FILENO);
    close(in_fd);
    close(out_fd);

    qz_config_t cfg = {};
    cfg.initial_script = kJsProgram;
    /* QZ_DEBUG env is set by the parent; qz_create auto-attaches DAP and
     * blocks on the configuration phase before eval'ing initial_script. */
    qz_t *rt = qz_create(&cfg);
    if (!rt) return 1;
    qz_destroy(rt);
    return 0;
}

/* ---- parent: the DAP client ---- */

static int parent_main(int child_out_fd, int child_in_fd, pid_t pid) {
    FILE *from_child = fdopen(child_out_fd, "r");
    if (!from_child) return 1;

    int failures = 0;
    char *msg;

    /* 1. initialize — expect the `initialized` event (sent at attach) and the
     * initialize response; order isn't guaranteed, so read up to 4 messages. */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":1,\"command\":\"initialize\","
        "\"arguments\":{\"adapterID\":\"qzjs\",\"clientID\":\"test\"}}");
    int got_event = 0, got_response = 0;
    for (int tries = 0; tries < 4 && !(got_event && got_response); tries++) {
        msg = dap_read(from_child);
        if (!msg) break;
        if (strstr(msg, "\"event\"") && strstr(msg, "\"initialized\"")) got_event = 1;
        if (strstr(msg, "\"response\"") && strstr(msg, "\"initialize\"")) got_response = 1;
        free(msg);
    }
    if (!got_event) { fprintf(stderr, "FAIL: no initialized event\n"); return 1; }
    if (!got_response) { fprintf(stderr, "FAIL: no initialize response\n"); return 1; }
    fprintf(stderr, "ok: initialized\n");

    /* 2. setBreakpoints at line 3 of "<initial>" (the first x++; x is 1 here,
     * before any increment, so the value is deterministic). */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":2,\"command\":\"setBreakpoints\","
        "\"arguments\":{\"source\":{\"path\":\"<initial>\"},"
        "\"breakpoints\":[{\"line\":3}]}}");
    msg = dap_read(from_child);
    if (!msg) { fprintf(stderr, "FAIL: no setBreakpoints response\n"); return 1; }
    if (!strstr(msg, "\"verified\":true")) {
        fprintf(stderr, "FAIL: breakpoint not verified: %s\n", msg);
        failures++;
    }
    free(msg);
    fprintf(stderr, "ok: setBreakpoints\n");

    /* 3. configurationDone — unblocks qz_dap_configure; the child evals
     * initial_script, hits the breakpoint, sends `stopped`. */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":3,\"command\":\"configurationDone\","
        "\"arguments\":{}}");
    msg = dap_read(from_child);
    if (!msg) { fprintf(stderr, "FAIL: no configurationDone response\n"); return 1; }
    free(msg);

    /* 4. expect stopped at entry (stop_on_entry=true). */
    msg = dap_read(from_child);
    if (!msg || !strstr(msg, "\"stopped\"")) {
        fprintf(stderr, "FAIL: no stopped event: %s\n", msg ? msg : "(null)");
        free(msg);
        return 1;
    }
    free(msg);
    fprintf(stderr, "ok: stopped at entry\n");

    /* continue past entry to hit the breakpoint */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":4,\"command\":\"continue\","
        "\"arguments\":{\"threadId\":1}}");
    msg = dap_read(from_child);  /* continue response */
    free(msg);

    msg = dap_read(from_child);
    if (!msg || !strstr(msg, "\"stopped\"") || !strstr(msg, "\"breakpoint\"")) {
        fprintf(stderr, "FAIL: no breakpoint stopped: %s\n", msg ? msg : "(null)");
        free(msg);
        return 1;
    }
    free(msg);
    fprintf(stderr, "ok: stopped at breakpoint\n");

    /* 5. stackTrace — expect a frame at line 3 */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":5,\"command\":\"stackTrace\","
        "\"arguments\":{\"threadId\":1}}");
    msg = dap_read(from_child);
    if (!msg) { fprintf(stderr, "FAIL: no stackTrace response\n"); return 1; }
    char *line = json_get(msg, "line");
    if (!line || atoi(line) != 3) {
        fprintf(stderr, "FAIL: stackTrace line != 3 (got %s)\n", line ? line : "(null)");
        failures++;
    } else {
        fprintf(stderr, "ok: stackTrace at line 3\n");
    }
    free(line);
    char *frame_id = json_get(msg, "id");
    free(msg);

    /* 6. scopes */
    char req[256];
    snprintf(req, sizeof(req),
        "{\"type\":\"request\",\"seq\":6,\"command\":\"scopes\","
        "\"arguments\":{\"frameId\":%s}}", frame_id ? frame_id : "0");
    dap_write(child_in_fd, req);
    msg = dap_read(from_child);
    if (!msg || !strstr(msg, "\"variablesReference\"")) {
        fprintf(stderr, "FAIL: no scopes: %s\n", msg ? msg : "(null)");
        failures++;
    } else {
        fprintf(stderr, "ok: scopes\n");
    }
    char *vr = json_get(msg ? msg : "", "variablesReference");
    free(msg);

    /* 7. variables — expect a local x */
    snprintf(req, sizeof(req),
        "{\"type\":\"request\",\"seq\":7,\"command\":\"variables\","
        "\"arguments\":{\"variablesReference\":%s}}", vr ? vr : "0");
    dap_write(child_in_fd, req);
    msg = dap_read(from_child);
    if (!msg || !strstr(msg, "\"name\":\"x\"")) {
        fprintf(stderr, "FAIL: no local x in variables: %s\n", msg ? msg : "(null)");
        failures++;
    } else {
        fprintf(stderr, "ok: variables has x\n");
    }
    free(msg);

    /* 8. evaluate "locals.x" — expect 1 (breakpoint at line 3, before any
     * increment; x was just initialized to 1). Frame locals are exposed on a
     * `locals` global during evaluate. */
    snprintf(req, sizeof(req),
        "{\"type\":\"request\",\"seq\":8,\"command\":\"evaluate\","
        "\"arguments\":{\"expression\":\"locals.x\",\"frameId\":%s,\"context\":\"watch\"}}",
        frame_id ? frame_id : "0");
    dap_write(child_in_fd, req);
    msg = dap_read(from_child);
    if (!msg || !strstr(msg, "\"result\":\"1\"")) {
        fprintf(stderr, "FAIL: evaluate locals.x != 1: %s\n", msg ? msg : "(null)");
        failures++;
    } else {
        fprintf(stderr, "ok: evaluate locals.x == 1 (frame local)\n");
    }
    free(msg);
    free(frame_id);
    free(vr);

    /* 9. continue to termination — the child evals the rest and exits; there's
     * no explicit `terminated` event in the MVP, so treat child exit (EOF) as
     * termination. */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":9,\"command\":\"continue\","
        "\"arguments\":{\"threadId\":1}}");
    msg = dap_read(from_child);
    free(msg);
    while ((msg = dap_read(from_child)) != nullptr) {
        if (strstr(msg, "\"terminated\"")) { fprintf(stderr, "ok: terminated\n"); }
        free(msg);
    }
    fprintf(stderr, "ok: child terminated (via exit)\n");

    /* 10. disconnect (child may already be gone — ignore SIGPIPE) */
    signal(SIGPIPE, SIG_IGN);
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":10,\"command\":\"disconnect\","
        "\"arguments\":{}}");

    fclose(from_child);
    close(child_in_fd);
    int status = 0;
    waitpid(pid, &status, 0);
    signal(SIGPIPE, SIG_DFL);
    if (failures != 0) return failures;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 100;  /* child failed */
    return 0;
}
/* ---- PauseWhileRunning: the bounded uv_run poll must service DAP requests
 * ---- that arrive while the debuggee is NOT paused ---- */

/* Run-mode child: keeps a setInterval alive so a DAP pause request can land
 * mid-run, then exits after a fixed sleep so the parent's pause/continue
 * sequence has time. The qzjs thread runs the uv loop on its own thread while
 * this process sleeps — exactly the state where the periodic DAP poll timer
 * is needed (an idle uv_run would otherwise block forever and never read the
 * pause off stdin). */
static int child_run_main(int in_fd, int out_fd)
{
    dup2(in_fd, STDIN_FILENO);
    dup2(out_fd, STDOUT_FILENO);
    close(in_fd);
    close(out_fd);

    qz_config_t cfg = {};
    /* setInterval keeps the event loop alive; the qzjs thread services it. */
    cfg.initial_script = "setInterval(() => {}, 200);\n1;\n";
    qz_t *rt = qz_create(&cfg);
    if (!rt) return 1;
    usleep(3 * 1000 * 1000);   /* give the parent time to pause us mid-run */
    qz_destroy(rt);
    return 0;
}

static int pause_parent_main(int child_out_fd, int child_in_fd, pid_t pid)
{
    FILE *from_child = fdopen(child_out_fd, "r");
    if (!from_child) return 1;
    char *msg;

    /* 1. initialize */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":1,\"command\":\"initialize\","
        "\"arguments\":{\"adapterID\":\"qzjs\",\"clientID\":\"test\"}}");
    int got_event = 0, got_response = 0;
    for (int tries = 0; tries < 4 && !(got_event && got_response); tries++) {
        msg = dap_read(from_child);
        if (!msg) break;
        if (strstr(msg, "\"event\"") && strstr(msg, "\"initialized\"")) got_event = 1;
        if (strstr(msg, "\"response\"") && strstr(msg, "\"initialize\"")) got_response = 1;
        free(msg);
    }
    if (!got_event || !got_response) {
        fprintf(stderr, "FAIL: no initialized/response\n");
        return 1;
    }
    fprintf(stderr, "ok: initialized\n");

    /* 2. configurationDone */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":2,\"command\":\"configurationDone\","
        "\"arguments\":{}}");
    msg = dap_read(from_child);
    if (!msg) { fprintf(stderr, "FAIL: no configurationDone response\n"); return 1; }
    free(msg);

    /* 3. stopped at entry (stop_on_entry is on) */
    msg = dap_read(from_child);
    if (!msg || !strstr(msg, "\"stopped\"")) {
        fprintf(stderr, "FAIL: no entry stopped: %s\n", msg ? msg : "(null)");
        free(msg);
        return 1;
    }
    free(msg);
    fprintf(stderr, "ok: stopped at entry\n");

    /* 4. continue past entry — the script finishes evaluating and the qzjs
     * thread settles into uv_run with only the setInterval + DAP poll timers. */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":3,\"command\":\"continue\","
        "\"arguments\":{\"threadId\":1}}");
    msg = dap_read(from_child);
    free(msg);

    /* 5. pause mid-run: nothing is paused, so this request sits on stdin until
     * the periodic DAP poll timer wakes the idle uv_run. It must arm the next
     * dispatch checkpoint and we must get stopped(reason "pause"). */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":4,\"command\":\"pause\","
        "\"arguments\":{\"threadId\":1}}");
    msg = dap_read(from_child);   /* pause response */
    if (!msg || strstr(msg, "\"success\":false")) {
        fprintf(stderr, "FAIL: pause not accepted: %s\n", msg ? msg : "(null)");
        free(msg);
        return 1;
    }
    free(msg);
    msg = dap_read(from_child);
    if (!msg || !strstr(msg, "\"stopped\"") || !strstr(msg, "\"pause\"")) {
        fprintf(stderr, "FAIL: no pause stopped: %s\n", msg ? msg : "(null)");
        free(msg);
        return 1;
    }
    free(msg);
    fprintf(stderr, "ok: paused while running (uv_run bounded poll)\n");

    /* 6. continue to let the child finish (its sleep elapses, then destroy) */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":5,\"command\":\"continue\","
        "\"arguments\":{\"threadId\":1}}");
    msg = dap_read(from_child);
    free(msg);
    while ((msg = dap_read(from_child)) != nullptr) free(msg);
    fprintf(stderr, "ok: child terminated\n");

    fclose(from_child);
    close(child_in_fd);
    signal(SIGPIPE, SIG_IGN);
    int status = 0;
    waitpid(pid, &status, 0);
    signal(SIGPIPE, SIG_DFL);
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 100;
    return 0;
}

TEST(DapDebugger, PauseWhileRunning) {
    int to_child[2], from_child[2];
    ASSERT_EQ(0, pipe(to_child));
    ASSERT_EQ(0, pipe(from_child));

    pid_t pid = fork();
    ASSERT_GE(pid, 0);

    if (pid == 0) {
        close(to_child[1]);
        close(from_child[0]);
        setenv("QZ_DEBUG", "1", 1);
        const char *trace = getenv("QZ_DAP_TRACE");
        if (trace) { freopen(trace, "w", stderr); }
        int rc = child_run_main(to_child[0], from_child[1]);
        _exit(rc);
    }

    close(to_child[0]);
    close(from_child[1]);
    int rc = pause_parent_main(from_child[0], to_child[1], pid);
    if (rc == 100) {
        ADD_FAILURE() << "child exited non-zero";
    } else if (rc != 0) {
        ADD_FAILURE() << rc << " DAP assertion(s) failed";
    }
}


TEST(DapDebugger, BreakpointFlow) {
    int to_child[2], from_child[2];
    ASSERT_EQ(0, pipe(to_child));
    ASSERT_EQ(0, pipe(from_child));

    pid_t pid = fork();
    ASSERT_GE(pid, 0);

    if (pid == 0) {
        /* child: read from to_child[0], write to from_child[1] */
        close(to_child[1]);
        close(from_child[0]);
        setenv("QZ_DEBUG", "1", 1);
        const char *trace = getenv("QZ_DAP_TRACE");
        if (trace) { freopen(trace, "w", stderr); }
        int rc = child_main(to_child[0], from_child[1]);
        _exit(rc);
    }

    /* parent: write to to_child[1], read from from_child[0] */
    close(to_child[0]);
    close(from_child[1]);
    int rc = parent_main(from_child[0], to_child[1], pid);
    if (rc == 100) {
        ADD_FAILURE() << "child exited non-zero";
    } else if (rc != 0) {
        ADD_FAILURE() << rc << " DAP assertion(s) failed";
    }
}

/* ---- PerFileBreakpointScope: setBreakpoints is scoped per source ----
 * VS Code sends one setBreakpoints request per file. The old handler cleared
 * the whole table on every request, so set/clear requests for any other file
 * silently wiped this file's breakpoints (answered verified, never hit).
 * The child runs kJsProgram as "<initial>"; the parent sets a breakpoint
 * there, then issues set + clear requests for a second path ("<second>",
 * never loaded) — the <initial> breakpoint must still fire. */
static int scope_parent_main(int child_out_fd, int child_in_fd, pid_t pid)
{
    FILE *from_child = fdopen(child_out_fd, "r");
    if (!from_child) return 1;

    int failures = 0;
    char *msg;

    /* 1. initialize — up to 4 messages for initialized event + response */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":1,\"command\":\"initialize\","
        "\"arguments\":{\"adapterID\":\"qzjs\",\"clientID\":\"test\"}}");
    int got_event = 0, got_response = 0;
    for (int tries = 0; tries < 4 && !(got_event && got_response); tries++) {
        msg = dap_read(from_child);
        if (!msg) break;
        if (strstr(msg, "\"event\"") && strstr(msg, "\"initialized\"")) got_event = 1;
        if (strstr(msg, "\"response\"") && strstr(msg, "\"initialize\"")) got_response = 1;
        free(msg);
    }
    if (!got_event || !got_response) {
        fprintf(stderr, "FAIL: no initialized event/response\n");
        return 1;
    }
    fprintf(stderr, "ok: initialized\n");

    /* 2. breakpoint on <initial> line 3 */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":2,\"command\":\"setBreakpoints\","
        "\"arguments\":{\"source\":{\"path\":\"<initial>\"},"
        "\"breakpoints\":[{\"line\":3}]}}");
    msg = dap_read(from_child);
    if (!msg) { fprintf(stderr, "FAIL: no setBreakpoints response\n"); return 1; }
    if (!strstr(msg, "\"verified\":true")) {
        fprintf(stderr, "FAIL: <initial> breakpoint not verified: %s\n", msg);
        failures++;
    }
    free(msg);

    /* 3. another file's breakpoints — wipes <initial> under whole-table clear */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":3,\"command\":\"setBreakpoints\","
        "\"arguments\":{\"source\":{\"path\":\"<second>\"},"
        "\"breakpoints\":[{\"line\":1}]}}");
    msg = dap_read(from_child);
    if (!msg) { fprintf(stderr, "FAIL: no setBreakpoints(<second>) response\n"); return 1; }
    free(msg);

    /* 4. clear <second> — must leave <initial> untouched */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":4,\"command\":\"setBreakpoints\","
        "\"arguments\":{\"source\":{\"path\":\"<second>\"},"
        "\"breakpoints\":[]}}");
    msg = dap_read(from_child);
    if (!msg) { fprintf(stderr, "FAIL: no clear response\n"); return 1; }
    if (!strstr(msg, "\"breakpoints\":[]")) {
        fprintf(stderr, "FAIL: clearing <second> echoed breakpoints: %s\n", msg);
        failures++;
    }
    free(msg);
    fprintf(stderr, "ok: per-file set/clear\n");

    /* 5. configurationDone */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":5,\"command\":\"configurationDone\","
        "\"arguments\":{}}");
    msg = dap_read(from_child);
    if (!msg) { fprintf(stderr, "FAIL: no configurationDone response\n"); return 1; }
    free(msg);

    /* 6. stopped at entry */
    msg = dap_read(from_child);
    if (!msg || !strstr(msg, "\"stopped\"")) {
        fprintf(stderr, "FAIL: no entry stopped: %s\n", msg ? msg : "(null)");
        free(msg);
        return 1;
    }
    free(msg);
    fprintf(stderr, "ok: stopped at entry\n");

    /* 7. continue — the <initial> breakpoint must have survived the
     * <second> set/clear requests */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":6,\"command\":\"continue\","
        "\"arguments\":{\"threadId\":1}}");
    msg = dap_read(from_child);  /* continue response */
    free(msg);

    msg = dap_read(from_child);
    if (!msg || !strstr(msg, "\"stopped\"") || !strstr(msg, "\"breakpoint\"")) {
        fprintf(stderr, "FAIL: <initial> breakpoint wiped by another file's "
                        "setBreakpoints: %s\n", msg ? msg : "(null)");
        free(msg);
        failures++;
        msg = nullptr;   /* no frame to inspect — skip to teardown */
    }
    if (msg) {
        free(msg);
        /* 8. stackTrace — expect the top frame at line 3 */
        dap_write(child_in_fd,
            "{\"type\":\"request\",\"seq\":7,\"command\":\"stackTrace\","
            "\"arguments\":{\"threadId\":1}}");
        msg = dap_read(from_child);
        if (!msg) { fprintf(stderr, "FAIL: no stackTrace response\n"); failures++; }
        else {
            char *line = json_get(msg, "line");
            if (!line || atoi(line) != 3) {
                fprintf(stderr, "FAIL: stackTrace line != 3 (got %s)\n",
                        line ? line : "(null)");
                failures++;
            } else {
                fprintf(stderr, "ok: stopped at <initial>:3 after other-file set/clear\n");
            }
            free(line);
            free(msg);
        }
    }

    /* 9. continue to termination, then disconnect */
    signal(SIGPIPE, SIG_IGN);
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":8,\"command\":\"continue\","
        "\"arguments\":{\"threadId\":1}}");
    while ((msg = dap_read(from_child)) != nullptr) free(msg);
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":9,\"command\":\"disconnect\","
        "\"arguments\":{}}");

    fclose(from_child);
    close(child_in_fd);
    int status = 0;
    waitpid(pid, &status, 0);
    signal(SIGPIPE, SIG_DFL);
    if (failures != 0) return failures;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 100;
    return 0;
}

TEST(DapDebugger, PerFileBreakpointScope) {
    int to_child[2], from_child[2];
    ASSERT_EQ(0, pipe(to_child));
    ASSERT_EQ(0, pipe(from_child));

    pid_t pid = fork();
    ASSERT_GE(pid, 0);

    if (pid == 0) {
        close(to_child[1]);
        close(from_child[0]);
        setenv("QZ_DEBUG", "1", 1);
        const char *trace = getenv("QZ_DAP_TRACE");
        if (trace) { freopen(trace, "w", stderr); }
        int rc = child_main(to_child[0], from_child[1]);
        _exit(rc);
    }

    close(to_child[0]);
    close(from_child[1]);
    int rc = scope_parent_main(from_child[0], to_child[1], pid);
    if (rc == 100) {
        ADD_FAILURE() << "child exited non-zero";
    } else if (rc != 0) {
        ADD_FAILURE() << rc << " DAP assertion(s) failed";
    }
}

/* ---- M-R1 §13.2/§13.4：DAP stdio 单通道约束 ----
 * 同进程第二个 runtime 缺省 stdio attach（QZ_DEBUG=1 auto-attach）必须
 * 显式失败（qz_dap_attach -2 → ready_err → qz_create NULL），不静默
 * 共享 stdin/stdout。attach 冲突释放后（第一实例 detach）再 attach 成功。
 *
 * child 编排（单线程，阻塞点即握手点）：
 *   rt1 = qz_create   ← 等父 configurationDone(1)
 *   rt2 = qz_create   ← stdio 已被 rt1 认领 → NULL（断言！rc=2 表明守卫失效）
 *   qz_destroy(rt1)   ← 等父 continue(1)（rt1 停在 entry）→ detach 释放认领
 *   rt3 = qz_create   ← 重新认领成功 → 等父 configurationDone(2)
 *   _exit(0)            ← rt3 留活（进程退出收尾）
 *
 * 父端驱动两轮 configure（rt1 / rt3），每轮 initialize → configurationDone
 * → stopped(entry) → continue。 */
static const char *kJsTrivial = "1;\n";

static int child_conflict_main(int in_fd, int out_fd) {
    dup2(in_fd, STDIN_FILENO);
    dup2(out_fd, STDOUT_FILENO);
    close(in_fd);
    close(out_fd);

    qz_config_t cfg = {};
    cfg.initial_script = kJsTrivial;

    qz_t *rt1 = qz_create(&cfg);
    if (!rt1) return 1;

    /* 第二实例：auto-attach 命中 stdio 认领 → attach -2 → ready_err → NULL。
     * 返回非 NULL = 守卫失效（两 runtime 抢同一 stdin/stdout）。 */
    qz_t *rt2 = qz_create(&cfg);
    if (rt2) return 2;

    /* 释放后可再认领：detach rt1（父已 continue，其线程不在 on_stopped 阻塞）
     * → rt3 缺省 attach 成功。失败 = 认领未随 detach 释放。 */
    qz_destroy(rt1);
    qz_t *rt3 = qz_create(&cfg);
    if (!rt3) return 3;

    return 0;   /* rt3 留活：进程退出收尾 */
}

/* 驱动一轮 configure：initialize → configurationDone → 等 stopped(entry)
 * → continue。返回 0 成功。 */
static int drive_one_session(int child_in_fd, FILE *from_child, int seq_base) {
    char req[256];
    char *msg;
    int got_event = 0, got_response = 0;

    snprintf(req, sizeof(req),
        "{\"type\":\"request\",\"seq\":%d,\"command\":\"initialize\","
        "\"arguments\":{\"adapterID\":\"qzjs\",\"clientID\":\"test\"}}", seq_base);
    dap_write(child_in_fd, req);
    for (int tries = 0; tries < 4 && !(got_event && got_response); tries++) {
        msg = dap_read(from_child);
        if (!msg) { fprintf(stderr, "FAIL[%d]: EOF during initialize\n", seq_base); return 1; }
        if (strstr(msg, "\"event\"") && strstr(msg, "\"initialized\"")) got_event = 1;
        if (strstr(msg, "\"response\"") && strstr(msg, "\"initialize\"")) got_response = 1;
        free(msg);
    }
    if (!got_event || !got_response) {
        fprintf(stderr, "FAIL[%d]: missing initialized event/response\n", seq_base);
        return 1;
    }

    snprintf(req, sizeof(req),
        "{\"type\":\"request\",\"seq\":%d,\"command\":\"configurationDone\","
        "\"arguments\":{}}", seq_base + 1);
    dap_write(child_in_fd, req);
    /* configurationDone 响应之后等 entry stopped */
    int got_cfgdone = 0, got_stopped = 0;
    for (int tries = 0; tries < 6 && !(got_cfgdone && got_stopped); tries++) {
        msg = dap_read(from_child);
        if (!msg) { fprintf(stderr, "FAIL[%d]: EOF before stopped\n", seq_base); return 1; }
        if (strstr(msg, "\"response\"") && strstr(msg, "\"configurationDone\"")) got_cfgdone = 1;
        if (strstr(msg, "\"stopped\"")) got_stopped = 1;
        free(msg);
    }
    if (!got_cfgdone || !got_stopped) {
        fprintf(stderr, "FAIL[%d]: missing configurationDone/stopped\n", seq_base);
        return 1;
    }

    snprintf(req, sizeof(req),
        "{\"type\":\"request\",\"seq\":%d,\"command\":\"continue\","
        "\"arguments\":{\"threadId\":1}}", seq_base + 2);
    dap_write(child_in_fd, req);
    msg = dap_read(from_child);   /* continue response */
    if (!msg) { fprintf(stderr, "FAIL[%d]: EOF on continue\n", seq_base); return 1; }
    free(msg);
    return 0;
}

static int conflict_parent_main(int child_out_fd, int child_in_fd, pid_t pid) {
    FILE *from_child = fdopen(child_out_fd, "r");
    if (!from_child) return 1;

    int rc = drive_one_session(child_in_fd, from_child, 1);   /* rt1 */
    if (rc == 0) rc = drive_one_session(child_in_fd, from_child, 10);  /* rt3 */
    if (rc != 0) {
        fclose(from_child);
        close(child_in_fd);
        (void)!kill(pid, SIGKILL);
        int st; waitpid(pid, &st, 0);
        return rc;
    }

    /* rt3 仍在跑（child _exit 前不 destroy）——排空到 EOF */
    char *msg;
    while ((msg = dap_read(from_child)) != nullptr) free(msg);
    fclose(from_child);
    close(child_in_fd);
    signal(SIGPIPE, SIG_IGN);
    int status = 0;
    waitpid(pid, &status, 0);
    signal(SIGPIPE, SIG_DFL);
    if (!WIFEXITED(status)) return 100;
    int crc = WEXITSTATUS(status);
    if (crc == 2) { fprintf(stderr, "FAIL: second stdio attach NOT rejected\n"); return 2; }
    if (crc == 3) { fprintf(stderr, "FAIL: re-attach after detach failed\n"); return 3; }
    if (crc != 0) return 100;
    return 0;
}

TEST(DapDebugger, StdioConflictSecondInstanceRejected) {
    int to_child[2], from_child[2];
    ASSERT_EQ(0, pipe(to_child));
    ASSERT_EQ(0, pipe(from_child));

    pid_t pid = fork();
    ASSERT_GE(pid, 0);

    if (pid == 0) {
        close(to_child[1]);
        close(from_child[0]);
        setenv("QZ_DEBUG", "1", 1);
        int rc = child_conflict_main(to_child[0], from_child[1]);
        _exit(rc);
    }

    close(to_child[0]);
    close(from_child[1]);
    int rc = conflict_parent_main(from_child[0], to_child[1], pid);
    if (rc == 100) {
        ADD_FAILURE() << "child exited non-zero";
    } else if (rc != 0) {
        ADD_FAILURE() << "stdio constraint violated (rc=" << rc << ")";
    }
}

/* ---- Exception breakpoints (DAP setExceptionBreakpoints, filter "all") ---- */

static int child_exc_main(int in_fd, int out_fd) {
    dup2(in_fd, STDIN_FILENO);
    dup2(out_fd, STDOUT_FILENO);
    close(in_fd);
    close(out_fd);

    qz_config_t cfg = {};
    cfg.initial_script = kJsExceptionProgram;
    qz_t *rt = qz_create(&cfg);
    if (!rt) return 1;
    qz_destroy(rt);
    return 0;
}

/* Drives one exception-breakpoint session. arm=1: filter "all" checked →
 * the caught throw at line 2 must stop with reason=exception (message
 * carried, throw-site line 2, exactly ONE stop for one throw). arm=0: the
 * DAP-empty filters:[] (what VS Code sends with nothing checked) must DISARM
 * → the same throw runs through with no stop at all. */
static int parent_exc_main(int child_out_fd, int child_in_fd, pid_t pid, int arm)
{
    FILE *from_child = fdopen(child_out_fd, "r");
    if (!from_child) return 1;
    int failures = 0;
    char *msg;

    /* 1. initialize — event + response, order not guaranteed */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":1,\"command\":\"initialize\","
        "\"arguments\":{\"adapterID\":\"qzjs\",\"clientID\":\"test\"}}");
    int got_event = 0, got_response = 0;
    for (int tries = 0; tries < 4 && !(got_event && got_response); tries++) {
        msg = dap_read(from_child);
        if (!msg) break;
        if (strstr(msg, "\"event\"") && strstr(msg, "\"initialized\"")) got_event = 1;
        if (strstr(msg, "\"response\"") && strstr(msg, "\"initialize\"")) got_response = 1;
        free(msg);
    }
    if (!got_event || !got_response) {
        fprintf(stderr, "FAIL: no initialize handshake\n");
        return 1;
    }

    /* 2. setExceptionBreakpoints with the full checked-filter set */
    if (arm)
        dap_write(child_in_fd,
            "{\"type\":\"request\",\"seq\":2,\"command\":\"setExceptionBreakpoints\","
            "\"arguments\":{\"filters\":[\"all\"]}}");
    else
        dap_write(child_in_fd,
            "{\"type\":\"request\",\"seq\":2,\"command\":\"setExceptionBreakpoints\","
            "\"arguments\":{\"filters\":[]}}");
    msg = dap_read(from_child);
    if (!msg) { fprintf(stderr, "FAIL: no setExceptionBreakpoints response\n"); return 1; }
    if (arm) {
        if (!strstr(msg, "\"verified\":true")) {
            fprintf(stderr, "FAIL: armed filter not verified: %s\n", msg);
            failures++;
        }
    } else if (!strstr(msg, "\"breakpoints\":[]")) {
        fprintf(stderr, "FAIL: empty filters should echo empty breakpoints: %s\n", msg);
        failures++;
    }
    free(msg);
    fprintf(stderr, "ok: setExceptionBreakpoints (arm=%d)\n", arm);

    /* 3. configurationDone */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":3,\"command\":\"configurationDone\","
        "\"arguments\":{}}");
    msg = dap_read(from_child);  /* response */
    free(msg);

    /* 4. entry stop (stop_on_entry) */
    msg = dap_read(from_child);
    if (!msg || !strstr(msg, "\"stopped\"")) {
        fprintf(stderr, "FAIL: no entry stop: %s\n", msg ? msg : "(null)");
        free(msg);
        return 1;
    }
    free(msg);
    fprintf(stderr, "ok: stopped at entry\n");

    /* 5. continue into the program */
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":4,\"command\":\"continue\","
        "\"arguments\":{\"threadId\":1}}");
    msg = dap_read(from_child);  /* continue response */
    free(msg);

    if (arm) {
        /* 6. the throw must stop with reason=exception + the message */
        msg = dap_read(from_child);
        if (!msg || !strstr(msg, "\"stopped\"") || !strstr(msg, "\"exception\"")) {
            fprintf(stderr, "FAIL: no exception stop: %s\n", msg ? msg : "(null)");
            free(msg);
            failures++;
        } else {
            char *text = json_get(msg, "text");
            if (!text || !strstr(text, "gboom")) {
                fprintf(stderr, "FAIL: stop text lacks gboom: %s\n",
                        text ? text : "(null)");
                failures++;
            } else {
                fprintf(stderr, "ok: exception stop carries the message\n");
            }
            free(text);
        }
        free(msg);

        /* 7. stackTrace — top frame is boom() at line 2: the snapshot must be
         * the throw site (pre-unwind), not the catch handler. */
        dap_write(child_in_fd,
            "{\"type\":\"request\",\"seq\":5,\"command\":\"stackTrace\","
            "\"arguments\":{\"threadId\":1}}");
        msg = dap_read(from_child);
        char *line = msg ? json_get(msg, "line") : nullptr;
        if (!line || atoi(line) != 2) {
            fprintf(stderr, "FAIL: throw-site line != 2 (got %s)\n",
                    line ? line : "(null)");
            failures++;
        } else {
            fprintf(stderr, "ok: throw-site line 2\n");
        }
        free(line);
        free(msg);

        /* 8. continue — the catch runs and the script finishes; ONE throw must
         * yield exactly ONE stop (engine-side restorations are suppressed). */
        dap_write(child_in_fd,
            "{\"type\":\"request\",\"seq\":6,\"command\":\"continue\","
            "\"arguments\":{\"threadId\":1}}");
        msg = dap_read(from_child);  /* continue response */
        free(msg);
        while ((msg = dap_read(from_child)) != nullptr) {
            if (strstr(msg, "\"stopped\"")) {
                fprintf(stderr, "FAIL: extra stop after one throw: %s\n", msg);
                failures++;
            }
            free(msg);
        }
        fprintf(stderr, "ok: single stop per throw, child drained\n");
    } else {
        /* disarmed: drain to EOF; only the entry stop (already consumed) */
        while ((msg = dap_read(from_child)) != nullptr) {
            if (strstr(msg, "\"stopped\"")) {
                fprintf(stderr, "FAIL: disarm failed, stop seen: %s\n", msg);
                failures++;
            }
            free(msg);
        }
        fprintf(stderr, "ok: disarmed throw ran through\n");
    }

    signal(SIGPIPE, SIG_IGN);
    dap_write(child_in_fd,
        "{\"type\":\"request\",\"seq\":99,\"command\":\"disconnect\","
        "\"arguments\":{}}");
    fclose(from_child);
    close(child_in_fd);
    int status = 0;
    waitpid(pid, &status, 0);
    signal(SIGPIPE, SIG_DFL);
    if (failures != 0) return failures;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 100;
    return 0;
}

TEST(DapDebugger, ExceptionBreakpointArmed) {
    int to_child[2], from_child[2];
    ASSERT_EQ(0, pipe(to_child));
    ASSERT_EQ(0, pipe(from_child));

    pid_t pid = fork();
    ASSERT_GE(pid, 0);

    if (pid == 0) {
        close(to_child[1]);
        close(from_child[0]);
        setenv("QZ_DEBUG", "1", 1);
        const char *trace = getenv("QZ_DAP_TRACE");
        if (trace) { freopen(trace, "w", stderr); }
        int rc = child_exc_main(to_child[0], from_child[1]);
        _exit(rc);
    }

    close(to_child[0]);
    close(from_child[1]);
    int rc = parent_exc_main(from_child[0], to_child[1], pid, 1);
    if (rc == 100) {
        ADD_FAILURE() << "child exited non-zero";
    } else if (rc != 0) {
        ADD_FAILURE() << rc << " DAP assertion(s) failed";
    }
}

TEST(DapDebugger, ExceptionBreakpointDisarmed) {
    int to_child[2], from_child[2];
    ASSERT_EQ(0, pipe(to_child));
    ASSERT_EQ(0, pipe(from_child));

    pid_t pid = fork();
    ASSERT_GE(pid, 0);

    if (pid == 0) {
        close(to_child[1]);
        close(from_child[0]);
        setenv("QZ_DEBUG", "1", 1);
        int rc = child_exc_main(to_child[0], from_child[1]);
        _exit(rc);
    }

    close(to_child[0]);
    close(from_child[1]);
    int rc = parent_exc_main(from_child[0], to_child[1], pid, 0);
    if (rc == 100) {
        ADD_FAILURE() << "child exited non-zero";
    } else if (rc != 0) {
        ADD_FAILURE() << rc << " DAP assertion(s) failed";
    }
}

#else /* !QZ_DEBUG_SUPPORT */

TEST(DapDebugger, DisabledWithoutDebuggerBuild) {
    GTEST_SKIP() << "QZ_BUILD_DEBUGGER=OFF — DAP tests not built";
}

#endif /* QZ_DEBUG_SUPPORT */
