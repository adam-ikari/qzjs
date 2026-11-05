/*
 * 堆硬上限（qz_config_t.memory_limit → JS_SetMemoryLimit）的跨进程端到端验证。
 *
 * 为什么要有这个：memory_limit 只在**主RT 进程**生效（context 在那里创建），
 * 而 ISOLATED（默认进程模型）下宿主进程只有通道桩——宿主经公开结构体设的上限
 * 若没被 rt_host.c 组装进 argv、再被 rt_main.c 还原，就**静默失效**：JS 照常
 * 无限分配，没有任何报错、没有任何降级提示。这与 debug/gc_threshold/random_seed
 * 是同一类跨进程缺口（brain/pages/cross-process-config-audit.md）。
 *
 * 静态门（test/config_propagation_check.py）只保证字段**名**出现在两侧，捕不到
 * 「argv 拼了但子进程没解析」「解析了但没写进 config」这类值级失效。本程序在
 * **真实 ISOLATED 构建**上跑值级断言：
 *
 *   正例：memory_limit = 64MiB → 256MiB 的 ArrayBuffer 必须**分配不到**。
 *   负控：memory_limit = 0（不限）→ 同一表达式必须成功并回 268435456。
 *         两次结果不同即证明正例的拒绝**确由上限导致**。
 *   存活：正例之后 RT 必须仍能回 `1+1`——否则「没回执」可能只是 RT 死了，
 *         正例就失去意义（拒绝 vs 崩溃必须分得开）。
 *
 * ⚠ 正例断言是「收到 error 帧」：引擎的 OOM 是 quickjs-ng 的 **uncatchable
 * error**（`is_uncatchable_error`，与栈溢出同类），脚本 try/catch 捕不到，
 * 异常穿到嵌入方；qzjs 入站派发（`qz_dispatch_message`）在 `JS_Call` 后检测
 * `JS_IsException` → 投递 `{"type":"error","error":"dispatch-failed",
 * "detail":"InternalError: out of memory"}` 帧（OOM 双重失败退静态
 * `{"type":"error","error":"out-of-memory"}` 帧）。本断言验证上限生效 +
 * 异常不再被静默吞掉。
 *
 * 用法：mem_limit_e2e
 *   必须在真实 ISOLATED 构建（QZ_BUILD_TESTS=OFF + QZ_BUILD_CLI=ON）上跑，
 *   QZ_RT_SERVER 指向 qzjs-rt（见 test/test_mem_limit_e2e.sh）。
 */

#include <qzjs/qzjs.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_fail;

static void fail(const char *what, const char *detail) {
    fprintf(stderr, "FAIL %s: %s\n", what, detail ? detail : "");
    g_fail = 1;
}

/* onmessage 里 evals 一段表达式，把结果/异常作为**对象**回给宿主。
 * 两个方向都是 JSON：库拒收非 JSON（回 {"type":"error","error":"bad-json"}），
 * 而宿主收到的 e.data 是**已解析的对象**（不是原始串）。回执回对象而非字符串
 * ——回字符串会被再包一层 JSON 引号，宿主侧看到的就是 \"ok\":true 这种转义形。 */
static const char *kScript =
    "onmessage = function (e) {\n"
    "  var code = e.data.code;\n"
    "  try { postMessage({ok: true, v: String((0, eval)(code))}); }\n"
    "  catch (err) { postMessage({ok: false, e: String(err)}); }\n"
    "};\n";

/* 投一条表达式、收一条回执（跳过库错误帧，不 break）。0 = 取到，-1 = 无回执/超时。
 * 两个用例的表达式都不含 " 与 \，JSON 转义免了（要加含引号的表达式的话，得先补
 * 转义）。timeout_ms 给足：要区分「没有回执」与「回执慢」。 */
static int eval1(qz_t *rt, const char *code, char *buf, size_t bufsz, int timeout_ms) {
    char msg[256];
    int n = snprintf(msg, sizeof msg, "{\"code\":\"%s\"}", code);
    if (n <= 0 || (size_t)n >= sizeof msg) return -1;
    if (qz_post_message(rt, msg, (size_t)n) != 0) return -1;
    buf[0] = '\0';
    for (;;) {
        char *json = NULL;
        size_t len = 0;
        int r = qz_recv_message(rt, &json, &len, timeout_ms);
        if (r == 1 || r < 0) { qz_free_message(json); return -1; }   /* 超时 / 错误 */
        if (strstr(json, "\"type\":\"error\"")) {                    /* 库错误帧：跳过、继续排干 */
            qz_free_message(json);
            continue;
        }
        snprintf(buf, bufsz, "%.*s", (int)len, json);
        qz_free_message(json);
        return 0;
    }
}

/* 投一条 code 消息（与 eval1 同格式，但不收回执——只投）。 */
static int post_code(qz_t *rt, const char *code) {
    char msg[256];
    int n = snprintf(msg, sizeof msg, "{\"code\":\"%s\"}", code);
    if (n <= 0 || (size_t)n >= sizeof msg) return -1;
    return qz_post_message(rt, msg, (size_t)n);
}

/* 收一条原始消息（不跳过 error 帧）。0 = 取到，-1 = 超时/错误。 */
static int recv_raw(qz_t *rt, char *buf, size_t bufsz, int timeout_ms) {
    char *json = NULL;
    size_t len = 0;
    int r = qz_recv_message(rt, &json, &len, timeout_ms);
    if (r == 1 || r < 0) { qz_free_message(json); return -1; }
    snprintf(buf, bufsz, "%.*s", (int)len, json);
    qz_free_message(json);
    return 0;
}

static qz_t *make_rt(size_t limit) {
    qz_config_t cfg;
    qz_config_init(&cfg);
    cfg.initial_script = kScript;
    cfg.memory_limit = limit;
    return qz_create(&cfg);
}

/* 256MiB —— 远超 64MiB 上限，且在负控里能真的分配成功。 */
static const char *kBig = "new ArrayBuffer(256*1024*1024).byteLength";

int main(void) {
    const size_t kLimit = 64u << 20;      /* 64 MiB */
    char a[512];

    /* ── 正例：设了上限 → 大分配必须拿不到 ── */
    {
        qz_t *rt = make_rt(kLimit);
        if (!rt) { fail("qz_create(limit=64MiB)", "创建失败"); return 1; }

        if (eval1(rt, "1+1", a, sizeof a, 10000) != 0 ||
            !strstr(a, "\"ok\":true") || !strstr(a, "\"v\":\"2\"")) {
            fail("boot", a[0] ? a : "上限下的小求值无回执/超时");
            /* 上限小到 runtime 起不来 → 测试自身配置错误；后面再断言没意义 */
            qz_destroy(rt);
            return 1;
        }

        /* OOM 是 uncatchable → 穿过 onmessage 的 try/catch → 冒泡到
         * qz_dispatch_message 的 JS_Call → error envelope。此前静默吞
         * （qz_js_call_cleanup），现改为投递 error 帧。 */
        if (post_code(rt, kBig) != 0)
            fail("big-alloc(limited) post 失败", "");
        else if (recv_raw(rt, a, sizeof a, 5000) != 0)
            fail("big-alloc(limited) 无回执——应收到 error 帧", a);
        else if (!strstr(a, "\"type\":\"error\""))
            fail("big-alloc(limited) 回执不是 error 帧", a);
        else if (!strstr(a, "out of memory") && !strstr(a, "out-of-memory"))
            fail("big-alloc(limited) error 帧不含 OOM 信息", a);

        /* 存活：没回执必须真的是「被拒」而不是「RT 死了」。 */
        if (eval1(rt, "1+1", a, sizeof a, 10000) != 0 || !strstr(a, "\"v\":\"2\""))
            fail("big-alloc(limited) 之后 RT 无响应（拒绝 vs 崩溃没分开）", a);
        qz_destroy(rt);
    }

    /* ── 负控：不设上限 → 同一表达式必须成功 ── */
    {
        qz_t *rt = make_rt(0);
        if (!rt) { fail("qz_create(no limit)", "创建失败"); return 1; }

        if (eval1(rt, kBig, a, sizeof a, 10000) != 0)
            fail("big-alloc(unlimited)", "无回执/超时");
        else if (!strstr(a, "\"ok\":true") || !strstr(a, "\"v\":\"268435456\""))
            fail("big-alloc(unlimited) 应成功（负控——正例的拒绝须确由上限导致）", a);
        qz_destroy(rt);
    }

    if (g_fail) return 1;
    printf("PASS: 堆硬上限 —— memory_limit=64MiB 穿 ISOLATED 进程边界生效"
           "（256MiB 分配被拒且 RT 存活），不设上限时同一分配成功\n");
    return 0;
}
