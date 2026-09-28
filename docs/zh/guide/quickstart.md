---
title: 快速开始
description: 在 5 分钟内让 qzjs 跑起来 — 克隆、构建并运行你的第一个 JavaScript 程序。
---

# 快速开始

在 5 分钟内让 qzjs 跑起来。

## 前置条件

- **C 编译器** — GCC 8+ 或 Clang 10+（POSIX；Windows/MSVC 尚不支持）
- **CMake** 3.10+
- **Git**（用于子模块）

## 克隆与构建

```bash
# 克隆仓库及所有子模块
git clone --recursive https://github.com/adam-ikari/qzjs.git
cd qzjs

# 配置并构建（Release 模式）
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

尺寸敏感的构建：加 `-DQZ_PROFILE=minimal`（仍满足 WinterTC 兼容，
2.45 MiB strip 后）。见[构建选项](/zh/guide/build-options)。

构建产物 `libqzjs.a`（静态核心）和 `libqz_full.a`（供 CMake 消费方使用的链接接口聚合库）位于 `build/` 目录，另有 `build/qzjs.pc` 供 pkg-config 使用。

## 你的第一个程序

创建 `hello.c`：

```c
#include <qzjs/qzjs.h>
#include <stdio.h>

int main(void) {
    // qzjs 完全自主管理自己的线程与 loop——宿主不注入任何事件循环，
    // 也不会被回调。JS 的一切出站消息（postMessage、崩溃上报）都进入
    // 每个运行时一条的 FIFO 邮箱，宿主在自己的线程上、自选时机经
    // qz_recv_message 消费。

    // 创建运行时 — 阻塞直到 JS 就绪（求值 initial_script）
    qz_config_t cfg = {0};
    cfg.initial_script = "console.log('Hello from qzjs!'); postMessage(1 + 1);";
    qz_t *rt = qz_create(&cfg);
    if (!rt) {
        fprintf(stderr, "Failed to create runtime\n");
        return 1;
    }

    // 通过发送 JSON 消息驱动运行时
    qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);

    // 从邮箱消费回复：首条最多等 1 秒，之后转纯轮询直到排干。
    char *json;
    size_t len;
    int timeout_ms = 1000;
    while (qz_recv_message(rt, &json, &len, timeout_ms) == 0) {
        printf("received: %.*s\n", (int)len, json);
        qz_free_message(json);
        timeout_ms = 0;
    }

    // 请求无异步工作时自动退出并等待主脚本体结束，再做一次纯轮询终排——
    // 等待期间到达的消息（含崩溃 {"type":"error"} 上报）仍在邮箱里可取。
    qz_wait_idle(rt);
    while (qz_recv_message(rt, &json, &len, 0) == 0) {
        printf("received: %.*s\n", (int)len, json);
        qz_free_message(json);
    }

    // 清理 — 释放邮箱、关闭唤醒 fd、回收 rt
    qz_free(rt);
    return 0;
}
```

宿主可以把 qzjs 嵌进任何事件系统：`qz_message_fd(rt)` 返回该运行时的唤醒
fd（Linux `eventfd`）——可读即表示至少有一条消息待取，可与自己的 fd 一起
`poll()`/`epoll`/`select`。消费时先排干邮箱、再清该 fd 计数（消费协议见
[主机集成](/zh/guide/host-integration)）。`THREAD` 构建
（`-DQZ_PROCESS_MODEL=THREAD`）下这段程序一字不改：JS 跑在 qzjs 的内部
线程上，宿主依旧只消费邮箱。

使用 pkg-config 编译并链接（自动带出完整静态链接行 — 全部 vendored 归档）：

```bash
cc -std=c99 -o hello hello.c $(pkg-config --cflags --libs qzjs)
```

树内构建时，先把 pkg-config 指向构建目录：

```bash
export PKG_CONFIG_PATH="$PWD/build"
```

## 带测试构建

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Debug -DQZ_BUILD_TESTS=ON
cmake --build build -j$(nproc)
cd build && ctest --output-on-failure
```

测试带有标签，方便定向运行：

```bash
ctest -L offline   # 本地确定性测试（CI 默认）
ctest -L dap       # DAP 协议测试
ctest -L test262   # ECMA-262 一致性测试套件
```

## 下一步

- [构建](/zh/guide/building) — 所有 CMake 选项详解
- [运行时生命周期](/zh/guide/lifecycle) — 创建、使用、销毁
- [嵌入模式](/zh/guide/embedding) — 基于消息的宿主模式