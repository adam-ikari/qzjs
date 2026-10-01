// test_host.h — 新宿主契约测试桩（gtest 用）。
// M-P7：库不调用宿主函数——出站消息经 qz_recv_message 邮箱消费，shim 把
// 箱内消息抽进本地 FIFO（单线程测试宿主 = 天然单消费者，无锁）。
#pragma once
#include "qzjs/qzjs.h"
#ifdef QZ_USE_MOCK_LIBUV
#include "qz_internal.h"   /* mock 构建下拿到完整 qz_t 布局（访问 h->rt->loop） */
#endif
#include "mock_libuv.h"
#include <gtest/gtest.h>
#include <string>
#include <deque>
#include <cstring>
#include <cstdio>
#include <ctime>
#include <atomic>

// C 串 → JSON 字符串字面量（转义反斜杠、引号、控制字符）。
static inline std::string JSON_string(const char *s) {
    std::string out = "\"";
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        unsigned char c = *p;
        switch (c) {
        case '\\': out += "\\\\"; break;
        case '"':  out += "\\\""; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        default:
            if (c < 0x20) {
                char buf[8];
                snprintf(buf, sizeof buf, "\\u%04x", c);
                out += buf;
            } else {
                out += (char)c;
            }
        }
    }
    out += "\"";
    return out;
}

struct HostCtx {
    qz_t *rt = nullptr;
    std::deque<std::string> inbox;   /* 邮箱抽取的本地 FIFO（单线程宿主，无锁） */
    long replies = 0;                /* 累计收到的消息数 */
    int eval_id = 0;                 /* 递增 eval 请求 id，用于响应配对 */
};

// 抽邮箱进本地 inbox（单消费者）；timeout_ms > 0 时首条至多等这么久。
static inline void host_fill(HostCtx *h, int timeout_ms = 0) {
    for (;;) {
        char *json = nullptr; size_t len = 0;
        if (qz_recv_message(h->rt, &json, &len, timeout_ms) != 0) return;
        h->inbox.emplace_back(json, len);
        qz_free_message(json);
        h->replies++;
        timeout_ms = 0;   /* 首条已到 → 其余纯排干 */
    }
}

// 标准测试引导脚本：onmessage 命令通道（eval/echo）。
// 用间接 eval（(0, eval)(...)）在全局作用域求值：直接 eval 会把顶层 var
// 声明限定在 onmessage 函数作用域内，下一次消息就丢了 —— 跨 eval 的状态
// （异步测试里 setup 写入、poll 读取的全局）必须落在 globalThis 上。
static const char *kTestBootstrap = R"JS(
globalThis.onmessage = function (e) {
  var d = e.data;
  if (d && d.cmd === 'eval') {
    try { postMessage({ok: true, id: d.id, v: JSON.stringify((0, eval)(d.code))}); }
    catch (err) { postMessage({ok: false, id: d.id, e: String(err)}); }
  } else if (d && d.cmd === 'echo') {
    postMessage(d.data);
  }
};
)JS";

static inline HostCtx *host_create(const char *script = kTestBootstrap) {
    auto *h = new HostCtx();
    qz_config_t cfg;
    qz_config_init(&cfg);
    cfg.initial_script = script;
    h->rt = qz_create(&cfg);
    if (!h->rt) { delete h; return nullptr; }
    return h;
}

static inline void host_destroy(HostCtx *h) {
    if (!h) return;
    qz_destroy(h->rt);
    delete h;
}

// 单次 eval 的短超时：host_poll_until* 应持续重试直到总预算耗尽，而不是被
// 单次慢的 eval 拖垮——Debug 高负载下 qzjs 线程处理 1MB 压缩/解压消息队列
// 可能数秒，5s 的单次等待会让 poll 退化成一击即败。值取 3000ms：1MB
// roundtrip 的压缩/解压在 C 侧完成、roundtrip 校验走 nativeBytesEqual
// （memcmp），Debug 下单次 eval ~0.2-0.5s；3000ms 单次内完成不引入额外
// 重试；高负载下超时后重试自愈。超时后残留的 eval 响应由 host_wait_msg
// 清理，下一次 eval 从干净状态重试。
#define HOST_POLL_SINGLE_MS 3000

// 等待宿主收到一条消息；返回 true 并把内容写进 out。timeout_ms 内没到则 false。
static inline bool host_wait_msg(HostCtx *h, std::string *out, int timeout_ms = 5000) {
    // 本地 FIFO 空 → 抽邮箱（poll 语义在 recv 内部：首条至多等 timeout_ms）。
    if (h->inbox.empty()) host_fill(h, timeout_ms);
    if (!h->inbox.empty()) {
        *out = std::move(h->inbox.front());
        h->inbox.pop_front();
        return true;
    }
    /* 超时：丢弃堆积的 eval 响应残留，防止下一条 eval 弹出旧响应导致
     * 消息错位（一条 eval 超时后，其响应稍后到达会留在 inbox，污染
     * 后续所有 host_eval 的"发一条/等一条"配对）。只清 eval 响应
     * （{"ok":…} / {"type":"error…}），保留 worker/异步回调等其他
     * 消息，避免误删其他测试依赖的异步消息。 */
    host_fill(h, 0);
    while (!h->inbox.empty()) {
        const std::string &f = h->inbox.front();
        if (f.compare(0, 6, "{\"ok\":") == 0 || f.compare(0, 16, "{\"type\":\"error") == 0)
            h->inbox.pop_front();
        else break;
    }
    return false;
}

// 宿主对 qzjs 求值（经命令通道）；返回 {ok, v|e} 的原始 JSON。
static inline bool host_eval(HostCtx *h, const char *code, std::string *out, int timeout_ms = 5000) {
    int id = ++h->eval_id;
    std::string payload = std::string("{\"cmd\":\"eval\",\"id\":") + std::to_string(id) +
                          ",\"code\":" + JSON_string(code) + "}";
    EXPECT_EQ(0, qz_post_message(h->rt, payload.data(), payload.size()));
    std::string key = "\"id\":" + std::to_string(id);
    for (;;) {
        std::string raw;
        if (!host_wait_msg(h, &raw, timeout_ms)) return false;
        if (raw.compare(0, 6, "{\"ok\":") != 0) {
            /* 非 eval 响应（echo/worker 等）：原样返回，保持旧行为 */
            *out = std::move(raw);
            return true;
        }
        if (raw.find(key) != std::string::npos) {
            *out = std::move(raw);
            return true;
        }
        /* 陈旧 eval 响应（之前超时的 eval 稍后到达）：id 不匹配，丢弃重试 */
    }
}

/* ── CTL-0 控制面 helpers ──
 * 回执经邮箱进 inbox（顶层 "ctl":true 标记），与普通 postMessage 输出分流。
 * 等待时跳过非 ctl 回执（eval 响应等），按 correl 配对。 */

// 发送控制命令。返回 0 成功，-1 失败（OFF 档等）。
static inline int host_control(HostCtx *h, const std::string &json) {
    return qz_control(h->rt, json.data(), json.size());
}

// 等待 correl 匹配的控制回执；跳过非 ctl 消息与不匹配 correl 的回执。
// 返回 true 并写回回执 JSON；timeout 内未到则 false。
/* CLOCK_MONOTONIC 毫秒时钟：poll 预算按真实流逝时间记账。原先"单次 eval
 * 超时最多烧 3s 真实时间却只记 25ms 预算"，5s 名义预算可放大成 ~200 次
 * 重试 ×3s ≈ 10 分钟 —— 即 brain 记录的"单跑偶发挂起 >120s"。 */
static inline long long mono_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
static inline bool host_wait_ctl(HostCtx *h, const char *correl,
                                 std::string *out, int timeout_ms = 5000) {
    std::string key = std::string("\"correl\":\"") + correl + "\"";
    long long deadline = mono_ms() + timeout_ms;
    std::deque<std::string> skip;
    for (;;) {
        int remain = (int)(deadline - mono_ms());
        if (remain <= 0) {
            /* 超时：把跳过的消息放回 inbox，避免污染后续测试 */
            for (auto it = skip.rbegin(); it != skip.rend(); ++it)
                h->inbox.push_front(*it);
            return false;
        }
        std::string raw;
        if (!host_wait_msg(h, &raw, remain)) {
            for (auto it = skip.rbegin(); it != skip.rend(); ++it)
                h->inbox.push_front(*it);
            return false;
        }
        if (raw.compare(0, 11, "{\"ctl\":true") == 0) {
            if (correl == nullptr || raw.find(key) != std::string::npos) {
                *out = std::move(raw);
                return true;
            }
            skip.push_back(std::move(raw));   /* 其他命令的回执：暂存 */
            continue;
        }
        /* 非 ctl 消息（JS onmessage 输出）：暂存等待循环继续 */
        skip.push_back(std::move(raw));
    }
}

// 组 eval 命令 JSON（ctx_id 缺省）。
static inline std::string ctl_eval_json(const char *correl, const char *script,
                                        int timeout_ms = 0) {
    std::string s = "{\"op\":\"eval\",\"correl\":\"";
    s += correl;
    s += "\",\"script\":";
    s += JSON_string(script);
    if (timeout_ms > 0) {
        s += ",\"timeout_ms\":";
        s += std::to_string(timeout_ms);
    }
    s += "}";
    return s;
}


// 轮询直到表达式求值结果包含 expected_substring。每次 host_eval 都会跑一轮
// loop + 冲刷微任务，所以异步结果（promise/timer/storage）在下一次 eval 可见。
// 每次未命中先睡 25ms 再计 25ms 预算：让 timeout_ms 对应真实时间，否则一轮
// 轮询只有 ~0.1ms 真实耗时，100ms 的 timer 永远等不到触发预算就耗尽。
// 返回 true 并把最后一次求值结果写入 out；timeout_ms 内未满足则 false。
static inline void host_poll_sleep(void) {
    struct timespec ts = {0, 25 * 1000000L};
    nanosleep(&ts, NULL);
}


static inline bool host_poll_until(HostCtx *h, const char *expr,
                                   const char *expected_substring,
                                   std::string *out, int timeout_ms = 5000) {
    const long long deadline = mono_ms() + timeout_ms;
    std::string last;
    while (mono_ms() < deadline) {
        long long remain = deadline - mono_ms();
        int single = remain > HOST_POLL_SINGLE_MS ? HOST_POLL_SINGLE_MS : (int)remain;
        if (!host_eval(h, expr, &last, single)) {
            /* 单次 eval 超时/异常：qzjs 线程忙（处理长消息队列）或 eval 读到
             * 中间状态。残留响应已被 host_wait_msg 清理，短暂 sleep 后重试。
             * 预算按真实时间记账：超时烧掉几秒就扣几秒，不再放大。 */
            host_poll_sleep();
            continue;
        }
        if (last.find(expected_substring) != std::string::npos) {
            *out = last;
            return true;
        }
        host_poll_sleep();
    }
    *out = last;
    return false;
}

// 解码一个 JSON 字符串字面量（含首尾引号，如 "\"abc\"" 或 "{\"a\":1}"）
// 的内容；格式不合法则返回 false。只处理 BMP \uXXXX。
static inline bool json_unescape(const std::string &s, std::string *out) {
    if (s.size() < 2 || s.front() != '"' || s.back() != '"') return false;
    std::string r;
    for (size_t i = 1; i + 1 < s.size(); i++) {
        char c = s[i];
        if (c != '\\') { r += c; continue; }
        if (i + 1 >= s.size()) return false;
        char e = s[++i];
        switch (e) {
        case 'n': r += '\n'; break;
        case 'r': r += '\r'; break;
        case 't': r += '\t'; break;
        case 'b': r += '\b'; break;
        case 'f': r += '\f'; break;
        case '/': r += '/'; break;
        case '"': r += '"'; break;
        case '\\': r += '\\'; break;
        case 'u': {
            if (i + 4 >= s.size()) return false;
            unsigned cp = 0;
            for (int k = 1; k <= 4; k++) {
                char h = s[i + k];
                cp <<= 4;
                cp |= (h >= '0' && h <= '9') ? (unsigned)(h - '0') :
                      (h >= 'a' && h <= 'f') ? (unsigned)(h - 'a' + 10) :
                      (h >= 'A' && h <= 'F') ? (unsigned)(h - 'A' + 10) : 0;
            }
            i += 4;
            if (cp < 0x80) r += (char)cp;
            else if (cp < 0x800) {
                r += (char)(0xC0 | (cp >> 6));
                r += (char)(0x80 | (cp & 0x3F));
            } else {
                r += (char)(0xE0 | (cp >> 12));
                r += (char)(0x80 | ((cp >> 6) & 0x3F));
                r += (char)(0x80 | (cp & 0x3F));
            }
            break;
        }
        default: return false;   /* 未知转义 */
        }
    }
    *out = r;
    return true;
}

// 解析 host_eval 的原始 JSON 响应，把 v 字段解码成明文写进 out。
// v 字段是经 JSON.stringify 编码的字符串（bootstrap 先 stringify 一次、
// 桥接层序列化时再转义一次），所以字符串/对象需解码两次：
//   数字/布尔 → 裸值（"3"、"true"）；
//   字符串 → 如 "\"aGVsbG8=\"" 解码为 aGVsbG8=；
//   对象 → 如 "\"{\\\"status\\\":200}\"" 解码为 {"status":200}。
// ok:false 或无 v 字段则返回 false。
static inline bool host_value(HostCtx *h, const char *code, std::string *out,
                              int timeout_ms = 5000) {
    std::string raw;
    if (!host_eval(h, code, &raw, timeout_ms)) return false;
    size_t p = raw.find("\"v\":");
    if (p == std::string::npos) return false;
    p += 4;   /* 跳过 "v": */
    if (p >= raw.size()) return false;
    if (raw[p] != '"') {
        /* 裸值：数字/true/false/null，读到下一个 , 或 } */
        size_t e = raw.find_first_of(",}", p);
        *out = raw.substr(p, (e == std::string::npos ? raw.size() : e) - p);
        return true;
    }
    /* 引号：收集完整 JSON 字符串字面量（处理转义，找配对的闭合引号） */
    std::string lit;
    lit += raw[p++];
    bool in_esc = false;
    for (; p < raw.size(); p++) {
        char c = raw[p];
        lit += c;
        if (in_esc) { in_esc = false; continue; }
        if (c == '\\') { in_esc = true; continue; }
        if (c == '"') break;   /* 闭合引号 */
    }
    std::string t;
    if (!json_unescape(lit, &t)) return false;
    /* 解码一次后仍是带引号的 JSON 字符串（底层值是 string/object），再解一次 */
    if (!t.empty() && t.front() == '"' && t.back() == '"') {
        std::string t2;
        if (json_unescape(t, &t2)) { *out = t2; return true; }
    }
    *out = t;
    return true;
}

// 轮询直到表达式求值结果（解码后的 v 值）包含 expected_substring。
// 预算与 host_poll_until 一样按真实时间记账。
static inline bool host_poll_until_value(HostCtx *h, const char *expr,
                                         const char *expected_substring,
                                         std::string *out, int timeout_ms = 5000) {
    const long long deadline = mono_ms() + timeout_ms;
    std::string last;
    while (mono_ms() < deadline) {
        long long remain = deadline - mono_ms();
        int single = remain > HOST_POLL_SINGLE_MS ? HOST_POLL_SINGLE_MS : (int)remain;
        if (!host_value(h, expr, &last, single)) {
            /* 同 host_poll_until：预算按真实时间记账，超时不放大。 */
            host_poll_sleep();
            continue;
        }
        if (last.find(expected_substring) != std::string::npos) {
            *out = last;
            return true;
        }
        host_poll_sleep();
    }
    *out = last;
    return false;
}

// 整文件读/写：测试读产物与状态快照、写篡改副本共用，避免各文件重复
// fopen/fread/fclose 样板（单一事实来源）。写失败覆盖「打开失败 / 短写 /
// close 未干净退出」三种；读失败覆盖「打开失败 / 读错误」。具体 errno 由
// 调用点的断言消息带路径呈现（helper 不自己打印，免得与 gtest 断言重复）。
static inline bool host_read_file(const std::string &path, std::string *out_bytes) {
    FILE *f = fopen(path.c_str(), "rb");
    if (!f) return false;
    out_bytes->clear();
    char chunk[4096];
    size_t got;
    while ((got = fread(chunk, 1, sizeof(chunk), f)) > 0) out_bytes->append(chunk, got);
    const bool read_failed = ferror(f) != 0;
    fclose(f);
    return !read_failed;
}

static inline bool host_write_file(const std::string &path, const std::string &bytes) {
    FILE *f = fopen(path.c_str(), "wb");
    if (!f) return false;
    const size_t written = fwrite(bytes.data(), 1, bytes.size(), f);
    const bool closed_cleanly = fclose(f) == 0;
    return written == bytes.size() && closed_cleanly;
}
