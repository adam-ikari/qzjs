/*
 * qzjs — messages: host ↔ JS JSON 消息往返
 *
 * 演示 qzjs 的核心架构：宿主与运行时只经 JSON 消息通信。
 *  - 宿主 → JS：qz_post_message(rt, json, len)（线程安全，可任意线程调用）
 *  - JS → 宿主：postMessage 落进 per-rt 邮箱，宿主用 qz_recv_message 消费
 *    （库不调用宿主回调；消费线程完全自选）
 *
 * 本示例跑一轮"请求-响应"状态机：宿主发 echo / add / date 三条命令，
 * JS 的 onmessage 处理器分别回复，宿主逐条打印。
 *
 * 构建：
 *   cd build
 *   cmake -DQZ_BUILD_EXAMPLES=ON ..
 *   cmake --build . --target qz_messages
 * 运行：
 *   ./examples/messages/qz_messages
 */
#include <qzjs/qzjs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* 排干 timeout_ms 窗口内到达的消息（recv 内部 poll 唤醒，不烧 CPU）。
 * 若宿主有自己的事件系统，可改用 qz_message_fd(rt) 拿可读 fd 挂进去，
 * 按头文件注释的三步消费协议取件——本示例以最简的定时 recv 演示。 */
static void host_drain(qz_t *rt, int timeout_ms) {
    for (;;) {
        char *json = NULL;
        size_t len = 0;
        int r = qz_recv_message(rt, &json, &len, timeout_ms);
        /* 三态必须分开看：0 = 取到；1 = 窗口内无消息（正常收工）；
         * -1 = 参数/状态错误。把 -1 和 1 一起 break 等于把错误当「没消息了」，
         * 宿主会安静地少处理消息却以为一切正常。 */
        if (r < 0) {
            fprintf(stderr, "[host] qz_recv_message 失败（参数或状态错误）\n");
            break;
        }
        if (r == 1) break;           /* 窗口内无消息 */
        printf("[host]  收到: %.*s\n", (int)len, json);
        qz_free_message(json);
        timeout_ms = 0;             /* 首条已到 → 余下的纯排干 */
    }
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);   /* 行缓冲：消息立即可见 */
#ifdef QZ_RT_SERVER_PATH
    setenv("QZ_RT_SERVER", QZ_RT_SERVER_PATH, 0);
#endif
    qz_config_t cfg;
    qz_config_init(&cfg);

    /* JS 侧：一个 onmessage 命令分发器，按 cmd 字段分派 */
    cfg.initial_script =
        "globalThis.onmessage = function (e) {\n"
        "  var d = e.data;\n"
        "  if (d.cmd === 'echo') {\n"
        "    postMessage({ ok: true, echo: d.text });\n"
        "  } else if (d.cmd === 'add') {\n"
        "    postMessage({ ok: true, sum: d.a + d.b });\n"
        "  } else if (d.cmd === 'date') {\n"
        "    postMessage({ ok: true, date: new Date().toISOString() });\n"
        "  } else {\n"
        "    postMessage({ ok: false, error: 'unknown cmd: ' + d.cmd });\n"
        "  }\n"
        "};\n"
        "postMessage({ ready: true });\n";

    qz_t *rt = qz_create(&cfg);
    if (!rt) {
        fprintf(stderr, "Failed to create qzjs runtime\n");
        return 1;
    }

    /* 等 JS 的 ready 消息落箱 */
    host_drain(rt, 1000);

    const char *reqs[] = {
        "{\"cmd\":\"echo\",\"text\":\"hello from host\"}",
        "{\"cmd\":\"add\",\"a\":20,\"b\":22}",
        "{\"cmd\":\"date\"}",
        "{\"cmd\":\"bogus\"}",
    };
    for (size_t i = 0; i < sizeof(reqs) / sizeof(reqs[0]); i++) {
        printf("[host]  发:  %s\n", reqs[i]);
        if (qz_post_message(rt, reqs[i], strlen(reqs[i])) != 0) {
            fprintf(stderr, "[host] qz_post_message 失败（OOM 或长度非法）\n");
            qz_destroy(rt);
            return 1;
        }
        host_drain(rt, 1000);        /* 等 JS 处理 + 回复落箱 */
    }

    qz_destroy(rt);
    printf("[host]  已销毁 runtime\n");
    return 0;
}
