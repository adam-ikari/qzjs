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
#include <uv.h>
#include <stdio.h>

static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    printf("received: %.*s\n", (int)len, json);
}

int main(void) {
    uv_loop_t loop;
    uv_loop_init(&loop);

    // 创建运行时 — ISOLATED（默认）下 JS 跑在独立主RT 进程里，
    // 宿主注入并泵动自己的 loop；THREAD 构建不需要 cfg.uv_loop
    qz_config_t cfg = {0};
    cfg.initial_script = "console.log('Hello from qzjs!'); postMessage(1 + 1);";
    cfg.message_cb = on_message;
    cfg.uv_loop    = &loop;           // 宿主 loop 注入（ISOLATED 必填）
    qz_t *rt = qz_create(&cfg);
    if (!rt) {
        fprintf(stderr, "Failed to create runtime\n");
        return 1;
    }

    // 通过发送 JSON 消息驱动运行时
    qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);

    // 泵宿主 loop：回复到达时 on_message 在本线程触发
    while (uv_run(&loop, UV_RUN_ONCE)) { /* until done */ }

    // 清理 — 优雅关闭（库句柄已随 teardown 关闭）
    qz_destroy(rt);
    uv_loop_close(&loop);
    return 0;
}
```

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