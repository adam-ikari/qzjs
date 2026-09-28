---
layout: home

hero:
  name: "Qz.js"
  text: "可嵌入 WinterTC 运行时"
  tagline: 严格 C99 · 双形态事件循环 · JSON 宿主边界
  image:
    light: /logo.svg
    dark: /logo-dark.svg
    alt: Qz.js
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/quickstart
    - theme: alt
      text: JS API
      link: /zh/js-api/

features:
  - icon: 🔌
    title: 邮箱式宿主边界
    details: 库从不执行宿主代码——没有回调可装，也没有 loop 可注入。所有发往宿主的消息（JS `postMessage`、崩溃上报、控制回执）都进入每运行时的 FIFO 邮箱，宿主在自己的线程上用 `qz_recv_message` / `qz_free_message` 消费（唤醒 fd `qz_message_fd`）。入站经 `qz_post_message` 保持线程安全。没有 eval，也没有 tick。
  - icon: 🧵
    title: 双形态事件循环
    details: ISOLATED（默认）下 JS 跑在独立主RT 进程里，库另起自己的宿主侧泵线程与 loop；THREAD 下 qzjs 运行自己的内部线程、内嵌 libuv 循环。两种形态库都自主管理线程与 loop，从不回调宿主，宿主也不泵动任何事件循环——只消费邮箱。
  - icon: 📦
    title: 零系统依赖
    details: 运行时及其全部依赖均通过 CMake 从源码构建。最小配置 strip 后约 2.45 MiB。
  - icon: ⚡
    title: 严格 C99
    details: 与依赖一起按 C99 编译。Release 下 `qzjs -e 'console.log(1)'` 启动不到 5 ms，峰值 RSS 约 3 MB。
  - icon: 🌐
    title: WinterTC 兼容运行时
    details: 30 个注册模块——fetch、crypto.subtle、streams、WebSocket、BroadcastChannel、EventSource、timers、fs、serve() 等。预编译为字节码，作为全局可用。
  - icon: 🔒
    title: 无全局状态
    details: 通过不透明的 `qz_t` 实现每运行时隔离。同一进程可运行多个独立实例。
---

## 快速开始

```bash
# Clone with all submodules
git clone --recursive https://github.com/adam-ikari/qzjs.git
cd qzjs

# Configure and build
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

```c
#include <qzjs/qzjs.h>
#include <stdio.h>

int main(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = "postMessage({hello: 'world'});";
    qz_t *rt = qz_create(&cfg);   // 无回调、无 loop 注入
    if (!rt) return 1;
    qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);
    for (;;) {
        char *json = NULL; size_t len = 0;
        if (qz_recv_message(rt, &json, &len, 5000) != 0) break;  // 消费邮箱
        printf("received: %.*s\n", (int)len, json);
        qz_free_message(json);
    }
    qz_destroy(rt);
    return 0;
}
```

完整步骤见[快速开始](/zh/guide/quickstart)。

## 架构

```mermaid
flowchart TB
    subgraph AM["qzjs"]
        direction TB
        Core["qzjs.c (core API)"]
        Thread["thread.c — 运行时线程 + libuv loop<br/>（ISOLATED：主RT 进程内；THREAD：宿主进程内）"]
        Msgq["msgq.c — message queue"]
        Worker["worker.c — dispatch (onmessage/postMessage)"]
        UvIO["uv_io.c — libuv I/O"]
        Core --> Thread
        Thread --> Msgq
        Msgq --> Worker
        Thread --> UvIO
        JS["WinterTC modules: fetch · console · crypto · streams · timers · …"]
        ExtList["Extensions: compress · crypto · textcodec · wamr"]
        Worker -.injects.-> JS
    end
    HOST["Host（自选线程、自选时机消费邮箱）"] -->|"qz_post_message: JSON in"| Msgq
    Worker -->|"JSON out → 邮箱（qz_recv_message / qz_free_message；唤醒 fd qz_message_fd）<br/>库从不执行宿主代码"| HOST
    UvIO --> LIBUV["libuv"]
```
