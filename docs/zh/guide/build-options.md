---
title: 构建选项
description: qzjs CMake 选项完整参考 — QZ_WITH_* 功能开关和 QZ_BUILD_* 构建目标。
---

# 构建选项

qzjs 的 CMake 选项分为**两个独立的层级**：`QZ_WITH_*` 控制**可选功能**（构建在运行时之上的原生扩展），而 `QZ_BUILD_*` 控制构建目标（测试、示例、调试器）。libuv 是**硬依赖** — 它承载 qzjs 的内部事件循环，始终从源码构建，没有可关闭它的选项。默认值适用于功能完整的 Linux/macOS 构建。

## 功能开关（`QZ_WITH_*`）

这些开关控制 WinterTC 兼容运行时之上的可选原生扩展。

| 选项 | 默认值 | 描述 |
|--------|---------|-------------|
| `QZ_WITH_TLS` | ON | mbedTLS，用于 HTTPS。强制开启 `QZ_WITH_CRYPTO_EXT=ON`——一个没有 `crypto.subtle`（无证书哈希、无 WebCrypto 密钥派生）的 TLS 客户端不是完整的 WinterTC 运行时。关闭可完全移除 mbedTLS。 |
| `QZ_WITH_COMPRESS` | ON | miniz 压缩扩展。为 JS API 添加 gzip/zlib/deflate。 |
| `QZ_WITH_CRYPTO_EXT` | ON | `crypto.subtle` 扩展：通过 mbedTLS 提供 SHA-256/384/512、HMAC、PBKDF2、AES-GCM。可在无 TLS 的情况下使用（纯 HTTP）；`QZ_WITH_TLS` 依赖此项。关闭时，`crypto.subtle` 为 `undefined`（无 JS 回退）。 |
| `QZ_WITH_TEXTCODEC` | ON | UTF-8 和 Base64 的 TextEncoder/TextDecoder。 |
| `QZ_WITH_WAMR` | ON | WAMR WebAssembly 引擎（快速解释器 + AOT）。默认 WASM 引擎。 |
| `QZ_WITH_WASM3` | OFF | wasm3 WebAssembly 解释器（备选，更便携）。 |

**注意：** `QZ_WITH_WAMR` 和 `QZ_WITH_WASM3` 互斥——两者都注册 `WebAssembly` 全局对象。

## 构建档位（`QZ_PROFILE`）

`QZ_PROFILE` 是 `QZ_WITH_*` 各项的预设包，**只改未显式指定的项**：
`-DQZ_PROFILE=minimal -DQZ_WITH_TLS=ON` 中显式的 `TLS=ON` 赢。空值
（默认）时各项行为与历史默认逐位一致。其他取值 configure 报错。

| 档位 | 宏效果 | qzjs 尺寸（strip 后，实测） | ECMA-429 WinterTC |
|------|--------|---------------------------|-------------------|
| `standard`（与空 profile 等效） | 与历史默认相同：WAMR/TLS/COMPRESS/CRYPTO_EXT/TEXTCODEC=ON | 同默认构建 | ✅ 全量必选满足 |
| `minimal` | 同 standard 但 **TLS=OFF**（fetch 降级 http-only；ECMA-429 不含 HTTPS） | **2.45 MiB**（Release/-O3）；1.81 MiB（MinSizeRel/-Os） | ✅ 全量必选仍满足：atob/btoa、WebAssembly（WAMR）、crypto.subtle、CompressionStream 全部在 |

在**同一 build 目录**下换用不同 `QZ_PROFILE` 重新 configure 时，五个
`QZ_WITH_*` cache 项会自动重算为新档默认值（状态消息
`QZ_PROFILE changed: ...`）。显式 `-DQZ_WITH_X` 的值在换档后**不会**
保留——混用预设与显式覆盖时建议使用新的 build 目录。

## gRPC 栈（`QZ_WITH_GRPC`）

| 选项 | 默认值 | 描述 |
|------|--------|------|
| `QZ_WITH_GRPC` | OFF | 把 gRPC/HTTP2 栈（h2 + HPACK + protobuf + grpc，约 3.5k 行 JS）编进 polyfill bundle。依赖 npm + esbuild + qjsc（与 polyfill rebuild 相同前提）；工具链缺失时告警并跳过。手工路径：`QZ_WITH_GRPC=1 node src/polyfill/build.js`。 |

## 构建目标（`QZ_BUILD_*`）

| 选项 | 默认值 | 描述 |
|--------|---------|-------------|
| `QZ_BUILD_TESTS` | OFF | 构建测试套件。启用 FetchContent 以获取 GoogleTest。 |
| `QZ_BUILD_EXAMPLES` | OFF | 构建 `examples/` 中的示例程序。 |
| `QZ_BUILD_DEBUGGER` | OFF | DAP 步进调试器。打补丁以添加断点/步进原语，并将 `src/debugger.c` + `src/debugger_dap.c` 编译进 `libqzjs.a`。关闭时零开销（不应用补丁，不编译源文件）。运行时通过 `QZ_DEBUG=1` 启用。详见[调试](../dev/debugging.md)。 |

## 常见配置

### 开发环境（完整调试，全部功能）

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Debug \
      -DQZ_BUILD_TESTS=ON -DQZ_WITH_TLS=ON \
      -DQZ_WITH_COMPRESS=ON -DQZ_WITH_CRYPTO_EXT=ON \
      -DQZ_WITH_TEXTCODEC=ON -DQZ_WITH_WAMR=ON
```

### 最小构建（嵌入式，无网络）

```bash
cmake -B build -DCMAKE_BUILD_TYPE=MinSizeRel \
      -DQZ_WITH_TLS=OFF -DQZ_WITH_COMPRESS=OFF \
      -DQZ_WITH_CRYPTO_EXT=OFF -DQZ_WITH_TEXTCODEC=OFF \
      -DQZ_WITH_WAMR=OFF
```

### 发布构建（生产环境，全部功能）

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release \
      -DQZ_WITH_TLS=ON -DQZ_WITH_COMPRESS=ON \
      -DQZ_WITH_CRYPTO_EXT=ON -DQZ_WITH_TEXTCODEC=ON \
      -DQZ_WITH_WAMR=ON
```

## 编译器标志

qzjs 及其所有依赖项在 `-std=c99 -Wall -Wextra -Werror` 下编译（通过 `qz_enable_warnings` 强制启用）。

### 消除未使用参数警告

引擎回调具有固定签名，可能包含未使用的参数。使用 `QZ_UNUSED(x)`：

```c
#include <quickjs.h>
#include "qz_internal.h"   /* QZ_UNUSED 定义在此（内部头） */

static JSValue my_callback(JSContext *ctx, JSValue this_val,
                           int argc, JSValue *argv) {
    QZ_UNUSED(this_val);  // 消除 -Wunused-parameter
    return JS_UNDEFINED;
}
```

## 输出

| 文件 | 描述 |
|------|-------------|
| `build/libqzjs.a` | 核心运行时库（静态核心 — 刻意不链接 libuv） |
| `build/libqz_full.a` | CMake 链接接口聚合库（qzjs + libuv + mbedTLS + miniz + WAMR） |
| `build/lib/pkgconfig/qzjs.pc` | pkg-config 文件（`pkg-config --cflags --libs qzjs` 输出完整静态链接行） |
| `build/test/test_*` | 测试二进制文件（当 `QZ_BUILD_TESTS=ON` 时） |