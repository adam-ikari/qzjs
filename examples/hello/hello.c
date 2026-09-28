/*
 * qzjs — hello: 最简示例
 *
 * 流程：创建运行时 → 执行 JS（console.log + postMessage）→ 宿主收消息 →
 * 宿主发消息给 JS → 销毁。
 *
 * M-P7 宿主契约（邮箱模型）：库不调用宿主任何函数。JS 的 postMessage
 * 落进 per-rt 邮箱，宿主自选时机/线程用 qz_recv_message 消费（内部经
 * poll 唤醒，不烧 CPU）。
 *
 * 构建：
 *   cd build
 *   cmake -DQZ_BUILD_EXAMPLES=ON ..
 *   cmake --build . --target qz_hello
 * 运行：
 *   ./examples/hello/qz_hello
 */
#include <qzjs/qzjs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* 消费窗口内到达的所有消息：每条至多等 timeout_ms；超时（返回 1）即结束。 */
static void host_drain(qz_t *rt, int timeout_ms) {
    for (;;) {
        char *json = NULL;
        size_t len = 0;
        int r = qz_recv_message(rt, &json, &len, timeout_ms);
        if (r != 0) break;          /* 1 = 窗口内无消息；-1 = 错误 */
        printf("[host] 收到 JS 消息: %.*s\n", (int)len, json);
        qz_free_message(json);
        timeout_ms = 0;             /* 首条已到 → 余下的纯排干 */
    }
}

int main(void) {
#ifdef QZ_RT_SERVER_PATH
    setenv("QZ_RT_SERVER", QZ_RT_SERVER_PATH, 0);
#endif
    qz_config_t cfg = {0};
    /* JS 侧：console.log 走原生 console；postMessage 进宿主邮箱 */
    cfg.initial_script =
        "console.log('hello from qzjs!');\n"
        "postMessage({ greeting: 'hello from JS', ts: Date.now() });\n"
        "onmessage = function (e) {\n"
        "  console.log('JS 收到宿主消息: ' + JSON.stringify(e.data));\n"
        "  postMessage({ reply: 'pong' });\n"
        "};\n";

    qz_t *rt = qz_create(&cfg);
    if (!rt) {
        fprintf(stderr, "Failed to create qzjs runtime\n");
        return 1;
    }

    /* 等初始脚本的 postMessage 落箱 */
    host_drain(rt, 1000);

    /* 宿主 → JS */
    const char *ping = "{\"cmd\":\"ping\"}";
    printf("[host] 发消息给 JS: %s\n", ping);
    qz_post_message(rt, ping, strlen(ping));

    /* 等 JS 回包 */
    host_drain(rt, 1000);

    qz_destroy(rt);
    printf("[host] 已销毁 runtime\n");
    return 0;
}
