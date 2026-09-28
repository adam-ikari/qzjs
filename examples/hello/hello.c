/*
 * qzjs — hello: 最简示例
 *
 * 流程：创建运行时 → 执行 JS（console.log + postMessage）→ 宿主收消息 →
 * 宿主发消息给 JS → 销毁。
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
#include <string.h>
#include <unistd.h>

/* ISOLATED（真 libuv 构建）：宿主侧通道句柄挂在宿主注入的 uv loop 上，
 * message_cb 跑在泵该 loop 的线程；usleep 不泵 loop 就收不到消息。
 * THREAD 编译（或 mock 构建）维持库线程模型，走原 usleep。 */
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

static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    printf("[host] 收到 JS 消息: %.*s\n", (int)len, json);
}

int main(void) {
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
    /* JS 侧：console.log 走原生 console；postMessage 发给宿主 */
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

    /* 等初始脚本跑完并投递 JS → 宿主消息（ISOLATED：泵宿主 loop） */
#ifdef QZ_EXAMPLE_PUMPS_LOOP
    host_pump_ms(&loop, 300);
#else
    usleep(300 * 1000);
#endif

    /* 宿主 → JS */
    const char *ping = "{\"cmd\":\"ping\"}";
    printf("[host] 发消息给 JS: %s\n", ping);
    qz_post_message(rt, ping, strlen(ping));

    /* 等 JS 回包 */
#ifdef QZ_EXAMPLE_PUMPS_LOOP
    host_pump_ms(&loop, 300);
#else
    usleep(300 * 1000);
#endif

    qz_destroy(rt);
#ifdef QZ_EXAMPLE_PUMPS_LOOP
    host_loop_close(&loop);
#endif
    printf("[host] 已销毁 runtime\n");
    return 0;
}
