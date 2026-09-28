/*
 * qzjs — worker: 真线程 Web Worker 示例
 *
 * 父 runtime 通过 new Worker('file://.../worker.js') 创建独立线程的 worker，
 * 双向 postMessage 通信（结构化克隆）。
 *
 * 构建：
 *   cd build
 *   cmake -DQZ_BUILD_EXAMPLES=ON ..
 *   cmake --build . --target qz_worker
 * 运行：
 *   ./examples/worker/qz_worker
 *   （程序内 worker 脚本路径为编译期注入的 file:// 绝对路径）
 */
#include <qzjs/qzjs.h>
#include <stdio.h>
#include <unistd.h>

#ifndef QZ_WORKER_SCRIPT
#error "QZ_WORKER_SCRIPT must be defined by CMake (file:// absolute path)"
#endif

/* ISOLATED（真 libuv 构建）：宿主侧通道句柄挂在宿主注入的 uv loop 上，
 * 等待 = 泵该 loop。THREAD 编译走原 usleep。 */
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
    printf("[host] 收到: %.*s\n", (int)len, json);
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
    cfg.message_cb = on_message;
#ifdef QZ_EXAMPLE_PUMPS_LOOP
    cfg.uv_loop    = &loop;
    uv_timer_init(&loop, &g_alarm);
#endif
    /* 父脚本：建 worker、发消息、收回显 */
    cfg.initial_script =
        "var w = new Worker('" QZ_WORKER_SCRIPT "');\n"
        "w.onmessage = function (e) {\n"
        "  console.log('父线程收到 worker 回显: ' + e.data);\n"
        "  postMessage({ from: 'parent', got: e.data });\n"
        "};\n"
        "w.postMessage('ping from parent');\n"
        "console.log('worker 已创建');\n";

    qz_t *rt = qz_create(&cfg);
    if (!rt) {
        fprintf(stderr, "Failed to create qzjs runtime\n");
        return 1;
    }

#ifdef QZ_EXAMPLE_PUMPS_LOOP
    host_pump_ms(&loop, 500);   /* 泵 loop：等 worker 往返完成 */
#else
    usleep(500 * 1000);         /* 等 worker 往返完成 */
#endif
    qz_destroy(rt);
#ifdef QZ_EXAMPLE_PUMPS_LOOP
    host_loop_close(&loop);
#endif
    printf("[host] done.\n");
    return 0;
}
