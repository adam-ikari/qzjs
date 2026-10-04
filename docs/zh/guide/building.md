---
title: 构建
description: qzjs 的 CMake 构建选项 — 功能开关、C99 工具链，以及开发和生产环境的示例配置。
---

# 构建

qzjs 使用 CMake 并通过功能开关进行配置。所有依赖从源码构建 — 无需系统包。

::: warning 平台支持
**qzjs 仅支持 Linux。**macOS、Windows 与各 BSD 不在支持范围内——是范围之外，
不是"还没移植"。库中大量使用 Linux 专有原语：`eventfd`（`qz_message_fd`）、
`AF_UNIX` 端点配 `SO_PEERCRED`，以及显式的 `UV_USE_IO_URING=0`（某些内核上
io_uring_setup 会破坏 futex/pthread_cond 唤醒，导致 `cond_wait` 永不返回）。
在其他平台构建不受支持，且会以本文档未记录的方式失败。
:::

## 基本构建

`make` 是命令入口——封装 CMake/Ninja：

```bash
make build          # 配置 + 编译 Release（含 examples）→ build/qzjs qzc qzjs-rt
make qzjs ARGS='-e "console.log(1)"'   # 运行 CLI
make qzc SRC=app.js [OUT=app.bc]       # JS 编译为字节码
make bc SRC=app.js [ARGS='a b']        # 编译 + 运行字节码
make example NAME=fs                   # 运行某个示例
make test-offline                      # 构建 + 跑 offline 测试
make docs                              # 构建文档站
make clean
```

直接用 CMake 等价，下文逐项列出全部选项：

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

构建类型：`Release`（优化）、`Debug`（带符号和断言）、`RelWithDebInfo`、`MinSizeRel`。

## CMake 选项

### 功能开关（`QZ_WITH_*`）

| 选项 | 默认值 | 描述 |
|--------|---------|-------------|
| `QZ_WITH_TLS` | ON | 用于 HTTPS 和加密原语的 mbedTLS |
| `QZ_WITH_COMPRESS` | ON | miniz 压缩/解压扩展 |
| `QZ_WITH_CRYPTO_EXT` | ON | `crypto.subtle`（SHA、HMAC、PBKDF2、AES-GCM） |
| `QZ_WITH_TEXTCODEC` | ON | UTF-8 / Base64 编解码器 |
| `QZ_WITH_WAMR` | ON | WAMR WebAssembly 引擎（Fast Interp + AOT，默认） |
| `QZ_WITH_WASM3` | OFF | wasm3 WebAssembly 引擎（替代方案，更轻量） |

**注意：** `QZ_WITH_WAMR` 和 `QZ_WITH_WASM3` 互斥 — 一次只能启用一个 WASM 引擎。libuv 是硬依赖，始终从源码构建。

### 构建目标

| 选项 | 默认值 | 描述 |
|--------|---------|-------------|
| `QZ_BUILD_TESTS` | OFF | 构建测试套件（25 个测试目标） |
| `QZ_BUILD_EXAMPLES` | OFF | 构建 `examples/` 中的示例 |
| `QZ_BUILD_CLI` | ON | 构建 `qzjs` CLI 以及 `qzjs-rt` worker 与 `qzjs-ctl` 控制面二进制 |
| `QZ_PROCESS_MODEL` | ISOLATED | `THREAD`（单进程多线程）或 `ISOLATED`（经 fork+exec 的独立子进程，自 M-P2 里程碑起为默认） |

## 示例配置

### 最小构建（仍满足 WinterTC）

```bash
cmake -B build -DQZ_PROFILE=minimal
cmake --build build -j$(nproc)
```

`minimal` 保留 WebAssembly、`crypto.subtle`、`atob`/`btoa` 和压缩
（2.45 MiB，strip 后 Release）——满足 WinterTC 全量必选集的最小档位。
档案表与 `QZ_WITH_GRPC` CMake option 见
[构建选项](/zh/guide/build-options)。

### 完整开发构建

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Debug \
      -DQZ_BUILD_TESTS=ON

cmake --build build -j$(nproc)
cd build && ctest --output-on-failure
```

完整选项参考（含构建档位 `QZ_PROFILE` 与 gRPC 栈 `QZ_WITH_GRPC`）：
[构建选项](/zh/guide/build-options)。

### wasm3 替代引擎

```bash
cmake -B build -DQZ_WITH_WAMR=OFF -DQZ_WITH_WASM3=ON
cmake --build build -j$(nproc)
```

## C 标准隔离

qzjs 及其所有依赖均在**严格 C99**（`-std=c99`）下构建。

## 构建产物

| 产物 | 路径 |
|----------|------|
| `libqzjs.a` | `build/`（静态核心 — 刻意不链接 libuv） |
| `libqz_full.a` | `build/`（CMake 链接接口聚合库：qzjs + libuv + mbedTLS + miniz + WAMR） |
| `qzjs.pc` | `build/`（pkg-config — `pkg-config --cflags --libs qzjs` 列出全部 vendored 归档） |
| 测试二进制文件 | `build/test/` |
| `qzjs` | `build/`（CLI — `qzjs -e 'console.log(1)'`） |
| `qzjs-rt` | `build/`（worker 进程二进制，由 `qz_proc_spawn` 经 fork+exec 派生） |
| `qzjs-ctl` | `build/`（控制面端点客户端） |