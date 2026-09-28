/*
 * qzjs — messages: host ↔ JS JSON 消息往返
 *
 * 演示 qzjs 的核心架构：宿主与运行时只经 JSON 消息通信。
 *  - 宿主 → JS：qz_post_message(rt, json, len)（线程安全，可任意线程调用）
 *  - JS → 宿主：postMessage 触发 message_cb（ISOLATED：跑在泵宿主注入
 *    uv loop 的线程上；THREAD：跑在库的 qzjs 线程上）
 *
 * 本示例跑一轮"请求-响应"状态机：宿主发 echo / add / date 三条命令，
 * JS 的 onmessage 处理器分别回复，message_cb 打印结果。
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
#include <string.h>
#include <unistd.h>

/* ISOLATED（真 libuv 构建）：宿主侧通道句柄挂在宿主注入的 uv loop 上，
 * 等待 = 泵该 loop（usleep 不泵 loop 就收不到消息）。THREAD 编译走原 usleep。 */
#if defined(QZ_PROCESS_MODEL_ISOLATED) && !defined(QZ_USE_MOCK_LIBUV)
#define QZ_EXAMPLE_PUMPS_LOOP 1
#include <uv.h>

static uv_timer_t g_alarm;
static int g_alarm_fired;

static void alarm_cb(uv_timer_t *t) {
    g_alarm_fired = 1;
    uv_timer_stop(t);
}

/* 泵宿主 loop ms 毫秒：期间处理入站消息（message_cb 在本线程触发）。 */
static void host_pump_ms(uv_loop_t *loop, uint64_t ms) {
    g_alarm_fired = 0;
    uv_timer_start(&g_alarm, alarm_cb, ms, 0);
    while (!g_alarm_fired)
        uv_run(loop, UV_RUN_ONCE);
    uv_run(loop, UV_RUN_NOWAIT);
}

static void host_loop_close(uv_loop_t *loop) {
    uv_close((uv_handle_t *)&g_alarm, NULL);
    uv_run(loop, UV_RUN_NOWAIT);
    uv_run(loop, UV_RUN_NOWAIT);
    uv_loop_close(loop);
}
#endif

/* 宿主侧回调：JS 的 postMessage 落在这里（泵宿主 loop 的线程，保持快 + 无阻塞 API） */
static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    printf("[host]  收到: %.*s\n", (int)len, json);
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);   /* 行缓冲：消息立即可见 */
#ifdef QZ_RT_SERVER_PATH
    setenv("QZ_RT_SERVER", QZ_RT_SERVER_PATH, 0);
#endif
#ifdef QZ_EXAMPLE_PUMPS_LOOP
    uv_loop_t loop;
    uv_loop_init(&loop);
#endif
    qz_config_t cfg = {0};
    cfg.message_cb  = on_message;
#ifdef QZ_EXAMPLE_PUMPS_LOOP
    cfg.uv_loop     = &loop;
    uv_timer_init(&loop, &g_alarm);
#endif

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

    /* 等 ready（ISOLATED：qz_create 已完成握手，泵 loop 收 JS 首条消息） */
#ifdef QZ_EXAMPLE_PUMPS_LOOP
    host_pump_ms(&loop, 200);
#else
    usleep(200 * 1000);
#endif

    const char *reqs[] = {
        "{\"cmd\":\"echo\",\"text\":\"hello from host\"}",
        "{\"cmd\":\"add\",\"a\":20,\"b\":22}",
        "{\"cmd\":\"date\"}",
        "{\"cmd\":\"bogus\"}",
    };
    for (size_t i = 0; i < sizeof(reqs) / sizeof(reqs[0]); i++) {
        printf("[host]  发:  %s\n", reqs[i]);
        qz_post_message(rt, reqs[i], strlen(reqs[i]));
#ifdef QZ_EXAMPLE_PUMPS_LOOP
        host_pump_ms(&loop, 200);   /* 泵 loop：等 JS 处理 + 回复 */
#else
        usleep(200 * 1000);         /* 等 JS 处理 + 回复 */
#endif
    }

    qz_destroy(rt);
#ifdef QZ_EXAMPLE_PUMPS_LOOP
    host_loop_close(&loop);
#endif
    printf("[host]  已销毁 runtime\n");
    return 0;
}
