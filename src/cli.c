/*
 * qzjs CLI — standalone WinterTC runtime
 * 用法: qzjs [options] [script.js [args...]] | qzjs -e 'code'
 *       qzjs（无参数）→ REPL
 */
#define _POSIX_C_SOURCE 200809L

#include <qzjs/qzjs.h>
#include <uv.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>

#define QZ_CLI_VERSION "qzjs 0.2.0"

/* CTL-2：控制面档位 / 端点路径（--control-plane / --control-pipe，main 解析、
 * run_code 应用到 qz_config_t）。-1 = 缺省（OFF）。 */
static int g_control_plane = -1;
static const char *g_control_pipe = NULL;

static void usage(FILE *out) {
    fprintf(out,
        "Usage: qzjs [options] [script.js [args...]]\n"
        "       qzjs --bytecode <file.bc> [args...]\n"
        "       qzjs --compile <in.js> -o <out.bc>\n"
        "       qzjs            (start REPL)\n"
        "\n"
        "Options:\n"
        "  -e, --eval <code>   evaluate <code> and exit\n"
        "  --bytecode <file.bc>\n"
        "                      run a precompiled bytecode file (from --compile or\n"
        "                      qjsc -b; bytecode is NOT portable across qzjs versions)\n"
        "  --compile <in.js>   compile JS source to a bytecode file\n"
        "  -o <out.bc>         output path for --compile (default <in.js>.bc)\n"
        "  --control-plane=<off|in-proc|local>\n"
        "                      control-plane tier (default off); local exposes\n"
        "                      an AF_UNIX endpoint (see qzjs-ctl)\n"
        "  --control-pipe=<path>\n"
        "                      endpoint path (default /tmp/qzjs-<pid>-<n>.ctl)\n"
        "  -h, --help          show this help\n"
        "  -v, --version       show version\n"
        "\n"
        "Runs a WinterTC-compatible JavaScript runtime (fetch, crypto,\n"
        "streams, timers, fs, ...). No Node.js APIs (process, require, ...).\n");
}

/* ── host state and message channel ── */

typedef struct {
    int done;           /* atomic: eval finished (incl. error) — qzjs thread writes, main spins */
    int exit_code;      /* script error → 1 (qzjs thread writes, main reads after done) */
    int reported;       /* main thread: exit_code/result 已打印过（防 wait_idle 崩溃上报重复） */
    char result[8192];  /* eval result: the "v" value (ok) or "e" message (error), decoded */
} cli_host_t;

/* Extract the JSON string literal at *s (which starts with a double quote)
 * into out, decoding escapes (\", \\, \n, \r, \t, \uXXXX). Returns the
 * decoded length, or -1 on malformed input. Used to pull the v/e fields out
 * of the {"ok":...,"v":...,"e":...} eval envelope for the REPL.
 *
 * 为何留在 CLI（不引 cJSON、不走 JS_ParseJSON）：cli.c 刻意
 * 只 include 公共头 qzjs/qzjs.h，是 libqzjs 的 dogfood 宿主（引擎内部
 * API 与库内部依赖均不可见）；message_cb 在宿主回调窗口，不在引擎内。
 * 裁决：docs/architecture/c-js-layering.md §6.6。 */
static int json_unescape(const char *s, char *out, size_t out_cap) {
    if (!s || *s != '"') {
        return -1;
    }
    s++;
    size_t n = 0;
    while (*s && *s != '"' && n + 3 < out_cap) {
        if (*s != '\\') {
            out[n++] = *s++;
            continue;
        }
        s++; /* backslash */
        switch (*s) {
        case '"': out[n++] = '"'; s++; break;
        case '\\': out[n++] = '\\'; s++; break;
        case '/':  out[n++] = '/';  s++; break;
        case 'n':  out[n++] = '\n'; s++; break;
        case 'r':  out[n++] = '\r'; s++; break;
        case 't':  out[n++] = '\t'; s++; break;
        case 'u': {
            unsigned code = 0;
            for (int i = 0; i < 4; i++) {
                char c = s[1 + i];
                unsigned d;
                if (c >= '0' && c <= '9') d = (unsigned)(c - '0');
                else if (c >= 'a' && c <= 'f') d = (unsigned)(c - 'a' + 10);
                else if (c >= 'A' && c <= 'F') d = (unsigned)(c - 'A' + 10);
                else return -1;
                code = (code << 4) | d;
            }
            /* UTF-16 code unit → UTF-8 (only BMP, matching JSON.stringify
             * default for non-surrogate code points) */
            if (code < 0x80) {
                out[n++] = (char)code;
            } else if (code < 0x800) {
                out[n++] = (char)(0xC0 | (code >> 6));
                out[n++] = (char)(0x80 | (code & 0x3F));
            } else {
                out[n++] = (char)(0xE0 | (code >> 12));
                out[n++] = (char)(0x80 | ((code >> 6) & 0x3F));
                out[n++] = (char)(0x80 | (code & 0x3F));
            }
            s += 5;
            break;
        }
        default:
            return -1;
        }
    }
    if (*s != '"') {
        return -1;
    }
    out[n] = '\0';
    return (int)n;
}

/* message_cb: runs on the qzjs thread; CLI receives eval results.
 * json: {"ok":true,"v":"..."} or {"ok":false,"e":"..."}.
 * Decodes the v/e payload into host->result for printing by the caller
 * (script mode prints errors to stderr; the REPL prints every result). */
static void cli_message_cb(qz_t *rt, const char *json, size_t len, void *data) {
    (void)data;
    cli_host_t *h = (cli_host_t *)qz_get_runtime_data(rt);
    if (!h) return;
    /* 精确判断：信封由 JSON.stringify 生成，无空格，恒以 {"ok":true 或
     * {"ok":false 开头。不能用 strstr 子串匹配 —— 错误消息/成功值的正文里
     * 可能含 "ok":false 字样导致误判。
     * M-P4 §9.3：主RT 意外退出时 message_cb 收 {"type":"error","error":<msg>}
     * （rt_host.c 崩溃检测）——同样精确前缀判定，如实上抛（打印 + 退出码 1），
     * 与 bad-json 路径（qz_dispatch_message）同形。 */
    if (strncmp(json, "{\"type\":\"error\"", 14) == 0) {
        const char *ef = strstr(json, "\"error\":");
        if (ef && json_unescape(ef + 8, h->result, sizeof(h->result)) >= 0) {
            h->exit_code = 1;
        } else {
            size_t cap = sizeof(h->result) - 1;
            if (len > cap) len = cap;
            memcpy(h->result, json, len);
            h->result[len] = '\0';
            h->exit_code = 1;
        }
        __atomic_store_n(&h->done, 1, __ATOMIC_RELEASE);
        return;
    }
    int is_error = (strncmp(json, "{\"ok\":false", 11) == 0);
    /* The envelope is {"ok":true,"v":"..."} or {"ok":false,"e":"..."}.
     * v/e hold JSON strings (the bootstrap wraps eval's value in
     * JSON.stringify). The key with its quotes and colon is 4 chars
     * (`"v":`), so the value string literal starts at field + 4.
     * When eval returns undefined, JSON.stringify(undefined) is undefined
     * and the v field is absent — that is a SUCCESS, not an error. */
    const char *field = is_error ? strstr(json, "\"e\":")
                                : strstr(json, "\"v\":");
    if (field && json_unescape(field + 4, h->result, sizeof(h->result)) >= 0) {
        h->exit_code = is_error ? 1 : 0;
    } else if (is_error) {
        /* e field missing or malformed — surface the raw envelope */
        size_t cap = sizeof(h->result) - 1;
        if (len > cap) len = cap;
        memcpy(h->result, json, len);
        h->result[len] = '\0';
        h->exit_code = 1;
    } else {
        /* ok, but no v field (eval returned undefined) — print nothing */
        h->result[0] = '\0';
        h->exit_code = 0;
    }
    __atomic_store_n(&h->done, 1, __ATOMIC_RELEASE);
}

/* ── WinterTC bridge + onmessage command channel ──
 * - globalThis.arguments: script args (no runtime parts; aligned with the
 *   WinterCG proposal-cli-api direction; excludes the executable and path)
 * - globalThis.env: environment key-values (minimal form)
 * - onmessage eval command channel: host posts {"cmd":"eval","code":...,
 *   "file":<source path>|null}
 *   → JS eval → postMessage({ok, v|e})
 *   file 是这段 code 的来源文件。带 file 时走 nativeEvalScript，让引擎用真实
 *   路径命名这次求值——栈帧与断点都按 JS_Eval 的源名精确匹配（qz_debug.h），
 *   少了它按真实路径设的断点永远不命中。没 file（-e / REPL）维持 (0, eval)。
 * ARGS_JSON / ENV_JSON are substituted at runtime by build_bootstrap(). */
static const char *kCliBootstrap =
    "globalThis.arguments = %s;\n"
    "globalThis.env = %s;\n"
    "globalThis.onmessage = function (e) {\n"
    "  var d = e.data;\n"
    "  if (d && d.cmd === 'eval') {\n"
    "    try {\n"
    "      var nat = typeof __native__ !== 'undefined' ? __native__ : null;\n"
    "      var r = d.file && nat && nat.nativeEvalScript\n"
    "        ? nat.nativeEvalScript(d.code, d.file) : (0, eval)(d.code);\n"
    "      postMessage({ok: true, v: JSON.stringify(r)});\n"
    "    }\n"
    "    catch (err) { postMessage({ok: false, e: String(err)}); }\n"
    "  }\n"
    "};\n";
/* C string → JSON string literal (with surrounding quotes; escapes backslash,
 * quotes, control chars). Returns a malloc'd string; same semantics as
 * test_host.h's JSON_string.
 * 留在 C 的原因：调用点 build_bootstrap/run_code/repl 在 qz_create 之前
 * 构造 bootstrap——此刻引擎尚不存在（循环依赖），JS.stringify 不可用；
 * 且 CLI 是不摸引擎内部 API 的 dogfood 宿主——cJSON 是 libqzjs 的内部
 * 依赖（不出公共接口），示例宿主不引它（见 json_unescape 注释、§6.6）。 */
static char *json_escape(const char *s) {
    size_t n = strlen(s) * 6 + 3;
    char *out = malloc(n);
    if (!out) {
        /* 诊断自带定位与上下文：哪个能力、期望 vs 实际 */
        fprintf(stderr, "qzjs: out of memory allocating %zu bytes for JSON-escaped string\n", n);
        return NULL;
    }
    char *p = out;
    *p++ = '"';
    for (const unsigned char *c = (const unsigned char *)s; *c; c++) {
        switch (*c) {
        case '\\': *p++ = '\\'; *p++ = '\\'; break;
        case '"':  *p++ = '\\'; *p++ = '"'; break;
        case '\n': *p++ = '\\'; *p++ = 'n'; break;
        case '\r': *p++ = '\\'; *p++ = 'r'; break;
        case '\t': *p++ = '\\'; *p++ = 't'; break;
        default:
            if (*c < 0x20) p += sprintf(p, "\\u%04x", (unsigned)*c);
            else *p++ = (char)*c;
        }
    }
    *p++ = '"';
    *p = 0;
    return out;
}

/* build the bootstrap, injecting arguments/env (Task 7: per the WinterCG
 * proposal-cli-api direction, globalThis.arguments holds the script args —
 * excluding the executable and script path — and globalThis.env the process
 * environment as a plain object). */
static char *build_bootstrap(const char *const *args, int nargs) {
    /* arguments → JSON array literal [ "a", "b" ] */
    size_t args_cap = 8;
    for (int i = 0; i < nargs; i++) {
        args_cap += strlen(args[i]) * 6 + 3;
    }
    char *args_json = malloc(args_cap + 1);
    if (!args_json) {
        fprintf(stderr, "qzjs: out of memory allocating %zu bytes for arguments JSON\n", args_cap + 1);
        return NULL;
    }
    char *p = args_json;
    *p++ = '[';
    for (int i = 0; i < nargs; i++) {
        if (i) *p++ = ',';
        char *q = json_escape(args[i]);
        if (!q) {
            free(args_json);
            return NULL;
        }
        size_t ql = strlen(q);
        memcpy(p, q, ql);
        p += ql;
        free(q);
    }
    *p++ = ']';
    *p = '\0';

    /* env → JSON object literal { "KEY": "VAL", ... } (minimal form) */
    extern char **environ;
    size_t env_cap = 64;
    for (char **e = environ; e && *e; e++) {
        env_cap += strlen(*e) * 6 + 8;
    }
    char *env_json = malloc(env_cap + 1);
    if (!env_json) {
        fprintf(stderr, "qzjs: out of memory allocating %zu bytes for env JSON\n", env_cap + 1);
        free(args_json);
        return NULL;
    }
    p = env_json;
    *p++ = '{';
    int first = 1;
    for (char **e = environ; e && *e; e++) {
        const char *eq = strchr(*e, '=');
        if (!eq) continue;
        size_t klen = (size_t)(eq - *e);
        char *k = malloc(klen + 1);
        if (!k) {
            fprintf(stderr, "qzjs: out of memory allocating %zu bytes for env key\n", klen + 1);
            free(args_json);
            free(env_json);
            return NULL;
        }
        memcpy(k, *e, klen);
        k[klen] = '\0';
        if (!first) *p++ = ',';
        first = 0;
        char *qk = json_escape(k);
        char *qv = json_escape(eq + 1);
        if (!qk || !qv) {
            /* 带上下文：点名是哪个环境变量、在什么阶段失败 */
            fprintf(stderr, "qzjs: out of memory JSON-escaping env var '%s'\n", k);
            free(k); free(qk); free(qv);
            free(args_json);
            free(env_json);
            return NULL;
        }
        size_t qkl = strlen(qk), qvl = strlen(qv);
        memcpy(p, qk, qkl); p += qkl;
        *p++ = ':'; *p++ = ' ';
        memcpy(p, qv, qvl); p += qvl;
        free(k); free(qk); free(qv);
    }
    *p++ = '}';
    *p = '\0';

    size_t total = strlen(kCliBootstrap) + strlen(args_json) +
                   strlen(env_json) + 32;
    char *bootstrap = malloc(total);
    if (!bootstrap) {
        /* snprintf(NULL, ...) 是 UB —— 必须在解引用前挡住 */
        fprintf(stderr, "qzjs: out of memory allocating %zu bytes for bootstrap\n", total);
        free(args_json);
        free(env_json);
        return NULL;
    }
    snprintf(bootstrap, total, kCliBootstrap, args_json, env_json);
    free(args_json);
    free(env_json);
    return bootstrap;
}

/* shared execution path: create runtime → eval code → wait for result →
 * wait_idle → destroy. host is bound to rt via qz_set_runtime_data;
 * cli_message_cb fetches it with qz_get_runtime_data(rt) (callable
 * repeatedly; host is not shared). */
/* e2e/test hook: QZ_WORKER_BACKEND=process|thread 覆盖 worker 后端（缺省随编译
 * 模型：ISOLATED 编译 = PROCESS，THREAD 编译 = THREAD）。THREAD 覆盖用于 §1.5
 * 双后端 parity：同一脚本两后端跑一遍，stdout 逐行比对。 */
static void apply_worker_backend(qz_config_t *cfg) {
    const char *wb = getenv("QZ_WORKER_BACKEND");
    if (!wb) return;
    if (strcmp(wb, "process") == 0)
        cfg->worker_backend = QZ_WORKER_BACKEND_PROCESS;
    else if (strcmp(wb, "thread") == 0)
        cfg->worker_backend = QZ_WORKER_BACKEND_THREAD;
}

/* CTL-2：把 main 解析到的 --control-plane/--control-pipe 应用到配置。
 * LOCAL 档让 runtime 暴露本地端点（ISOLATED 下由主RT 监听）。 */
static void apply_control_plane(qz_config_t *cfg) {
    if (g_control_plane >= 0) cfg->control_plane = g_control_plane;
    cfg->control_pipe_path = g_control_pipe;
}

/* file: 这段 code 的来源路径（script 模式 = argv 里的脚本路径；-e / REPL 传
 * NULL）。它作为 eval 通道的 "file" 字段送进运行时，引擎用它命名这次求值，
 * 栈帧 / Error().stack / 调试器断点才认得真实文件（否则全是 "<input>"）。 */
static int run_code(const char *code, const char *file,
                    const char *const *args, int nargs) {
    cli_host_t host = {0};

    char *bootstrap = build_bootstrap(args, nargs);
    if (!bootstrap) {
        /* build_bootstrap 已打印带上下文的 OOM 诊断；这里只需失败退出，
         * 不能静默降级成"没有 arguments/env/onmessage 的 bootstrap"。 */
        return 1;
    }
    qz_config_t cfg;
    memset(&cfg, 0, sizeof cfg);
    cfg.message_cb = cli_message_cb;
    cfg.initial_script = bootstrap;
    apply_worker_backend(&cfg);
    apply_control_plane(&cfg);

    qz_t *rt = qz_create(&cfg);
    free(bootstrap);
    if (!rt) {
        fprintf(stderr, "qzjs: runtime init failed\n");
        return 1;
    }
    qz_set_runtime_data(rt, &host);
    char *cmd_json = json_escape(code);
    if (!cmd_json) {
        fprintf(stderr, "qzjs: out of memory\n");
        qz_wait_idle(rt);
        qz_free(rt);
        return 1;
    }
    char *file_json = file ? json_escape(file) : NULL;
    if (file && !file_json) {
        free(cmd_json);
        fprintf(stderr, "qzjs: out of memory\n");
        qz_wait_idle(rt);
        qz_free(rt);
        return 1;
    }
    /* json_escape 上界 strlen*6+3，故按 cmd_json/file_json 实际长度 + 固定信封
     * 开销分配（原 strlen*2+64 会溢出）。snprintf 检查返回值防截断。 */
    size_t cmd_cap = strlen(cmd_json) + (file_json ? strlen(file_json) : 4) + 64;
    char *cmd = malloc(cmd_cap);
    if (!cmd) {
        free(cmd_json);
        free(file_json);
        fprintf(stderr, "qzjs: out of memory\n");
        qz_wait_idle(rt);
        qz_free(rt);
        return 1;
    }
    int wrote = snprintf(cmd, cmd_cap,
                         "{\"cmd\":\"eval\",\"file\":%s,\"code\":%s}",
                         file_json ? file_json : "null", cmd_json);
    free(cmd_json);
    free(file_json);
    if (wrote < 0 || (size_t)wrote >= cmd_cap) {
        free(cmd);
        fprintf(stderr, "qzjs: out of memory\n");
        qz_wait_idle(rt);
        qz_free(rt);
        return 1;
    }
    qz_post_message(rt, cmd, strlen(cmd));
    free(cmd);

    /* lock-free wait: spin on done (qzjs thread release-stores, acquire-load here) */
    while (!__atomic_load_n(&host.done, __ATOMIC_ACQUIRE))
        sched_yield();
    int exit_code = host.exit_code;
    if (exit_code) {
        /* script error — cli_message_cb decoded the "e" payload into result */
        fprintf(stderr, "%s\n", host.result);
        host.reported = 1;
    }

    /* wait for pending async work (fetch/timer) to complete; the runtime
     * auto-exits when the loop is empty and the thread is joined here. Do not
     * call qz_destroy after this (would double-join); free the struct only.
     * M-P4 §9.3：主RT 在此期间崩溃（kill -9 / 段错误）→ 宿主 message_cb 收
     * {type:'error'}（rt_host.c）——此刻补报（脚本自身错误已在上面打过，
     * reported 去重），退出码取最终值（非零，宿主感知崩溃）。 */
    qz_wait_idle(rt);
    if (host.exit_code && !host.reported) {
        fprintf(stderr, "%s\n", host.result);
        host.reported = 1;
    }
    exit_code = host.exit_code;
    qz_free(rt);
    return exit_code;
}

/* ── Task 6: interactive REPL (no script / no -e) ──
 * Banner → read a line → eval over the onmessage channel → print the result
 * (the decoded "v" or "e") → repeat; Ctrl-D/EOF exits. The runtime stays
 * alive for the whole session (no wait_idle); qz_destroy on exit. */
static int repl_loop(void) {
    cli_host_t host = {0};

    char *bootstrap = build_bootstrap(NULL, 0);
    if (!bootstrap) {
        /* 同 run_code：OOM 诊断已由 build_bootstrap 打出，不静默降级 */
        return 1;
    }
    qz_config_t cfg;
    memset(&cfg, 0, sizeof cfg);
    cfg.message_cb = cli_message_cb;
    cfg.initial_script = bootstrap;
    apply_worker_backend(&cfg);
    apply_control_plane(&cfg);

    qz_t *rt = qz_create(&cfg);
    free(bootstrap);
    if (!rt) {
        fprintf(stderr, "qzjs: runtime init failed\n");
        return 1;
    }
    qz_set_runtime_data(rt, &host);
    printf("%s (WinterTC runtime) — type JS, Ctrl-D to exit\n",
           QZ_CLI_VERSION);
    fflush(stdout);

    char line[8192];
    int exit_code = 0;
    while (fgets(line, sizeof line, stdin)) {
        line[strcspn(line, "\n")] = 0;
        if (!line[0]) {
            continue;
        }

        __atomic_store_n(&host.done, 0, __ATOMIC_RELEASE);
        char *escaped = json_escape(line);
        if (!escaped) {
            fprintf(stderr, "qzjs: out of memory\n");
            exit_code = 1;
            continue;
        }
        /* 按转义后实际长度 + 固定信封开销分配（原 strlen*2+64 溢出，
         * 且原内联 json_escape 的返回值从未释放 —— 泄漏）。 */
        size_t cmd_cap = strlen(escaped) + 64;
        char *cmd = malloc(cmd_cap);
        if (!cmd) {
            free(escaped);
            fprintf(stderr, "qzjs: out of memory\n");
            exit_code = 1;
            continue;
        }
        int wrote = snprintf(cmd, cmd_cap, "{\"cmd\":\"eval\",\"code\":%s}",
                             escaped);
        free(escaped);
        if (wrote < 0 || (size_t)wrote >= cmd_cap) {
            free(cmd);
            fprintf(stderr, "qzjs: out of memory\n");
            exit_code = 1;
            continue;
        }
        qz_post_message(rt, cmd, strlen(cmd));
        free(cmd);
        while (!__atomic_load_n(&host.done, __ATOMIC_ACQUIRE))
            sched_yield();

        printf("%s\n", host.result);
        fflush(stdout);
        if (host.exit_code) {
            exit_code = 1;
        }
    }
    printf("\n");

    qz_destroy(rt);
    return exit_code;
}

/* ── --compile：把 JS 源码编译为字节码文件（qz_compile 的 CLI 形态）──
 * 产出文件经 --bytecode 运行。⚠ 字节码与本次 qzjs 构建强绑定，跨版本不保证
 * 可加载（运行时会显式拒绝）；分发请带源码，部署环境重编译。 */
static int compile_to_file(const char *in_path, const char *out_path) {
    FILE *f = fopen(in_path, "rb");
    if (!f) { fprintf(stderr, "qzjs: cannot open '%s'\n", in_path); return 1; }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0) { fprintf(stderr, "qzjs: cannot size '%s'\n", in_path); fclose(f); return 1; }
    char *src = malloc((size_t)sz);
    if (!src) { fprintf(stderr, "qzjs: out of memory\n"); fclose(f); return 1; }
    if (fread(src, 1, (size_t)sz, f) != (size_t)sz) {
        fprintf(stderr, "qzjs: read error '%s'\n", in_path);
        fclose(f); free(src); return 1;
    }
    fclose(f);

    char *err = NULL;
    uint8_t *bc = NULL;
    size_t bc_len = 0;
    int rc = qz_compile(src, (size_t)sz, in_path, &bc, &bc_len, &err);
    free(src);
    if (rc != 0) {
        fprintf(stderr, "qzjs: compile failed: %s\n", err ? err : "?");
        free(err);
        return 1;
    }

    char defout[strlen(in_path) + 8];
    if (!out_path) {
        snprintf(defout, sizeof defout, "%s.bc", in_path);
        out_path = defout;
    }
    FILE *o = fopen(out_path, "wb");
    if (!o) { fprintf(stderr, "qzjs: cannot write '%s'\n", out_path); free(bc); return 1; }
    if (fwrite(bc, 1, bc_len, o) != bc_len) {
        fprintf(stderr, "qzjs: write error '%s'\n", out_path);
        fclose(o); free(bc); return 1;
    }
    fclose(o);
    free(bc);
    printf("%s\n", out_path);
    return 0;
}

/* ── --bytecode：运行预编译字节码。与 script 模式同走 bootstrap（保留
 * arguments/env/onmessage），字节码作为初始程序执行、eval 消息仍可用。 */
static int run_bytecode(const char *bc_path, const char *const *args, int nargs) {
    FILE *f = fopen(bc_path, "rb");
    if (!f) { fprintf(stderr, "qzjs: cannot open '%s'\n", bc_path); return 1; }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0) { fprintf(stderr, "qzjs: cannot size '%s'\n", bc_path); fclose(f); return 1; }
    if (sz == 0) { fprintf(stderr, "qzjs: '%s' is empty (not bytecode)\n", bc_path); fclose(f); return 1; }
    uint8_t *bc = malloc((size_t)sz);
    if (fread(bc, 1, (size_t)sz, f) != (size_t)sz) {
        fprintf(stderr, "qzjs: read error '%s'\n", bc_path);
        fclose(f); free(bc); return 1;
    }
    fclose(f);

    cli_host_t host = {0};
    char *bootstrap = build_bootstrap(args, nargs);
    if (!bootstrap) { free(bc); return 1; }
    qz_config_t cfg;
    memset(&cfg, 0, sizeof cfg);
    cfg.message_cb = cli_message_cb;
    cfg.initial_script = bootstrap;
    cfg.initial_bytecode = bc;
    cfg.initial_bytecode_len = (size_t)sz;
    apply_worker_backend(&cfg);
    apply_control_plane(&cfg);

    qz_t *rt = qz_create(&cfg);
    free(bootstrap);
    if (!rt) {
        fprintf(stderr, "qzjs: bytecode error or runtime init failed\n");
        free(bc);
        return 1;
    }
    qz_set_runtime_data(rt, &host);
    qz_wait_idle(rt);
    int exit_code = host.exit_code;
    if (exit_code && !host.reported) fprintf(stderr, "%s\n", host.result);
    free(bc);
    qz_free(rt);
    return exit_code;
}

 int main(int argc, char **argv) {
    /* HTTP/TCP 服务写已关闭的对端连接会触发 SIGPIPE(默认杀进程,
     * wrk 压测中断连即崩)。libuv 不忽略它;宿主必须显式忽略。 */
    signal(SIGPIPE, SIG_IGN);
    /* parse -h/-v and -e; the first non-flag argument is the script path; the rest are script args */
    const char *script_path = NULL;
    int script_index = 0;    /* argv index where script args start */
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-h") || !strcmp(argv[i], "--help")) {
            usage(stdout);
            return 0;
        }
        if (!strncmp(argv[i], "--control-plane=", 16)) {
            const char *v = argv[i] + 16;
            if (!strcmp(v, "off")) g_control_plane = QZ_CONTROL_OFF;
            else if (!strcmp(v, "in-proc")) g_control_plane = QZ_CONTROL_IN_PROC;
            else if (!strcmp(v, "local")) g_control_plane = QZ_CONTROL_LOCAL;
            else { usage(stderr); return 2; }
            continue;
        }
        if (!strncmp(argv[i], "--control-pipe=", 15)) {
            g_control_pipe = argv[i] + 15;
            continue;
        }
        if (!strcmp(argv[i], "--bytecode")) {
            if (i + 1 >= argc) { usage(stderr); return 2; }
            return run_bytecode(argv[i + 1],
                                (const char *const *)argv + i + 2, argc - i - 2);
        }
        if (!strcmp(argv[i], "--compile")) {
            if (i + 1 >= argc) { usage(stderr); return 2; }
            const char *out = NULL;
            if (i + 3 < argc && !strcmp(argv[i + 2], "-o")) out = argv[i + 3];
            else if (i + 3 <= argc && !strcmp(argv[i + 2], "-o") && i + 3 >= argc) { usage(stderr); return 2; }
            return compile_to_file(argv[i + 1], out);
        }
        if (!strcmp(argv[i], "-v") || !strcmp(argv[i], "--version")) {
            printf("%s\n", QZ_CLI_VERSION);
            return 0;
        }
        if (!strcmp(argv[i], "-e") || !strcmp(argv[i], "--eval")) {
            if (i + 1 >= argc) { usage(stderr); return 2; }
            /* -e mode: eval the code; remaining args become script args.
             * file=NULL：没有来源文件，引擎按 "<input>" 命名（与旧版一致）。 */
            return run_code(argv[i + 1], NULL,
                            (const char *const *)argv + i + 2, argc - i - 2);
        }
        /* 未知 flag */
        if (argv[i][0] == '-') { usage(stderr); return 2; }
        script_path = argv[i];
        script_index = i + 1;
        break;
    }

    if (script_path) {
        /* ── script mode ── */
        FILE *f = fopen(script_path, "rb");
        if (!f) { fprintf(stderr, "qzjs: cannot open '%s'\n", script_path); return 1; }
        fseek(f, 0, SEEK_END);
        long sz = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (sz < 0) {
            /* ftell 失败（如管道/非普通文件）—— sz=-1 转 size_t 后为
             * SIZE_MAX，malloc 巨大缓冲并 fread 崩溃。 */
            fprintf(stderr, "qzjs: cannot size '%s'\n", script_path);
            fclose(f);
            return 1;
        }
        char *code = malloc((size_t)sz + 1);
        if (!code) {
            fprintf(stderr, "qzjs: out of memory\n");
            fclose(f);
            return 1;
        }
        if (fread(code, 1, (size_t)sz, f) != (size_t)sz) {
            fprintf(stderr, "qzjs: read error\n");
            fclose(f);
            free(code);
            return 1;
        }
        code[sz] = 0;
        fclose(f);
        /* file = script_path：按调用方给的路径命名这次 eval（见 run_code） */
        int rc = run_code(code, script_path,
                          (const char *const *)argv + script_index, argc - script_index);
        free(code);
        return rc;
    }

    /* Task 6: REPL (when no args) */
    return repl_loop();
}
