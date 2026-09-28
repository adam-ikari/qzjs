/*
 * qzjs — worker: 真线程 Web Worker 示例
 *
 * 父 runtime 通过 new Worker('file://.../worker.js') 创建独立线程的 worker，
 * 双向 postMessage 通信（结构化克隆）。worker 的回显经父 JS 的 onmessage
 * 转成宿主的 postMessage，宿主从邮箱消费。
 *
 * M-P7 宿主契约：库不调用宿主回调——出站消息一律入 per-rt 邮箱，宿主用
 * qz_recv_message 消费（内部 poll 唤醒）。
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
#include <stdlib.h>

#ifndef QZ_WORKER_SCRIPT
#error "QZ_WORKER_SCRIPT must be defined by CMake (file:// absolute path)"
#endif

/* 消费窗口内到达的所有消息 */
static void host_drain(qz_t *rt, int timeout_ms) {
    for (;;) {
        char *json = NULL;
        size_t len = 0;
        int r = qz_recv_message(rt, &json, &len, timeout_ms);
        if (r != 0) break;          /* 1 = 窗口内无消息；-1 = 错误 */
        printf("[host] 收到: %.*s\n", (int)len, json);
        qz_free_message(json);
        timeout_ms = 0;
    }
}

int main(void) {
#ifdef QZ_RT_SERVER_PATH
    setenv("QZ_RT_SERVER", QZ_RT_SERVER_PATH, 0);
#endif
    qz_config_t cfg = {0};
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

    host_drain(rt, 2000);            /* 等 worker 往返落箱 */
    qz_destroy(rt);
    printf("[host] done.\n");
    return 0;
}
