---
title: Architecture Design
description: qzjs architecture design document — C99 runtime layering, component relationships, data flow, and extension model (Chinese).
---

# qzjs 架构设计文档 (Architecture Design — 中文)

> **Note**: This document is in Chinese. For English documentation, see the [Guide](/guide/) section.
>
> **状态**：已废弃（2026-08-12 libuv-native 迁移后）
>
> **本文件描述的是 2026-08-12 迁移前的 PAL 架构（0.1.0），已过时。** 迁移后 qzjs
> 放弃 PAL，仅基于 libuv（Linux/macOS）：qzjs 自建内部线程运行 libuv 事件循环，
> 公开 API 精简为 6 个函数（`qz_create`/`qz_destroy`/`qz_post_message`/
> `qz_get_runtime_data`/`qz_set_runtime_data`/`qz_free`），宿主与运行时通过
> JSON 消息通信；`platform/` 树、`qz_pal.h`、`QZ_PAL_*` 选项与
> `qz_eval`/`qz_tick` 等旧 API 全部删除。当前设计见
> `docs/archive/superpowers/specs/2026-08-12-qzjs-libuv-native-design.md`，测试用 mock_libuv。
> 下文 §3、§4、§7、§8、§9、§12 均为旧架构内容，仅作历史参考。

## 1. 概述

qzjs 是一个轻量级 QuickJS-ng 运行时封装，提供平台抽象层（PAL）和 WinterTC 兼容的 JS polyfill，用于在 C 应用中嵌入 JavaScript 运行时。

### 设计目标

- **最小依赖**：核心只依赖 QuickJS-ng + C11；PAL 和扩展按需启用
- **平台可移植**：通过 PAL 接口抽象 I/O，支持 libuv（Linux/macOS）、FreeRTOS（ESP32）、mock（测试）
- **WinterTC 兼容**：JS polyfill 提供 fetch、console、crypto、streams、timers 等 Web API
- **可扩展**：通过 qz_ext_t 钩子注册原生扩展（压缩、加密、WASM 等）
- **单线程模型**：JSContext 绑定创建线程，事件循环通过 PAL `run_cycle` 驱动

### 不包含

- LLM/Agent 逻辑
- 上层应用框架（qzjs 只提供运行时，不提供业务逻辑）

## 2. 架构

```
┌─────────────────────────────────────────────────────┐
│                    qzjs                              │
│                                                      │
│  ┌─────────────┐  ┌───────────┐  ┌───────────────┐ │
│  │  qzjs.c     │  │ context.c │  │ extension.c   │ │
│  │  (核心 API) │  │ (多上下文)│  │ (扩展注册)    │ │
│  └──────┬──────┘  └─────┬─────┘  └───────┬───────┘ │
│         │               │                │          │
│  ┌──────┴───────────────┴────────────────┴───────┐  │
│  │              bridge.c (JS↔PAL 桥接)            │  │
│  └──────────────────────┬────────────────────────┘  │
│                         │                            │
│  ┌──────────────────────┴────────────────────────┐  │
│  │              qz_pal_t (PAL 接口)             │  │
│  │  http | fs | storage | timer | time | run_cycle│  │
│  └──────────────────────┬────────────────────────┘  │
│                         │                            │
│  ┌──────────┬───────────┼───────────┬──────────────┐│
│  │ pal_uv   │pal_freertos│ pal_mock │  (新 PAL)    ││
│  │ (libuv)  │(ESP-IDF)   │ (测试)   │              ││
│  └──────────┴───────────┴───────────┴──────────────┘│
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  JS Polyfill (WinterTC)                      │   │
│  │  fetch | console | crypto | streams | timers │   │
│  │  fs | storage | url | encoding | ...         │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  扩展 (qz_ext_t)                           │   │
│  │  compress | crypto | textcodec | WAMR  │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘

依赖：
  QuickJS-ng (JS 引擎)
  mbedTLS (TLS/加密, 可选)
  miniz (压缩, 可选)
```

## 3. 核心 API

### 3.1 生命周期

```c
// 配置
typedef struct qz_config_t {
    const qz_pal_t *pal;          // PAL 实例（必须）
    int debug;                       // 调试输出
    const qz_ext_t **extensions;  // 扩展数组（NULL 结尾，可为 NULL）
} qz_config_t;

// 创建/销毁
qz_t *qz_create(const qz_config_t *config);
void qz_destroy(qz_t *rt);

// 重置（保留 PAL，重建 JS 运行时）
int qz_reset(qz_t *rt, const qz_config_t *config);
```

### 3.2 JS 执行

```c
// 执行 JS 代码，返回结果字符串（caller 用 qz_free 释放）
int qz_eval(qz_t *rt, const char *code, char **result);

// 执行 QuickJS 字节码（用于预编译的 bundle）
int qz_eval_bytecode(qz_t *rt, const uint8_t *bytecode, size_t len, char **result);

// 调用全局函数
int qz_call(qz_t *rt, const char *func, const char *args_json, char **result);

// 处理待处理的 JS 微任务（Promise 回调等）
int qz_tick(qz_t *rt);

// 释放 qz_eval/qz_call 返回的内存
void qz_free(void *ptr);
```

### 3.3 多上下文

qzjs 支持在一个运行时中创建多个 JS 上下文，用于隔离执行环境：

```c
// 从当前上下文派生新上下文，返回 context_id
int qz_spawn(qz_t *rt, const qz_config_t *config);

// 挂起当前上下文，切换到指定上下文
int qz_suspend(qz_t *rt);
int qz_resume(qz_t *rt, int context_id);

// 销毁指定上下文
int qz_destroy_ctx(qz_t *rt, int context_id);

// 获取当前活跃上下文 ID
int qz_get_active_ctx_id(qz_t *rt);
```

### 3.4 扩展注册

```c
// 运行时注册扩展（在已创建的运行时上）
int qz_register_ext(qz_t *rt, const qz_ext_t *ext);
```

## 4. PAL 接口

PAL（Platform Abstraction Layer）是 qzjs 与平台 I/O 之间的抽象层。所有异步操作通过回调通知。

### 4.1 PAL vtable

```c
struct qz_pal_t {
    void *user_data;

    // HTTP
    void (*http_request)(qz_pal_t*, const char *url, const char *method,
                         const char *headers, const char *body, size_t body_len,
                         qz_pal_cb_t cb, void *cb_data);
    void (*http_request_stream)(qz_pal_t*, const char *url, const char *method,
                                const char *headers, const char *body, size_t body_len,
                                qz_pal_stream_ops_t *ops);
    void (*http_abort)(qz_pal_t*);                    // 可选：取消活跃流

    // 文件系统
    void (*fs_read)(qz_pal_t*, const char *path, qz_pal_cb_t, void*);
    void (*fs_write)(qz_pal_t*, const char *path, const char *data, size_t, qz_pal_cb_t, void*);
    void (*fs_exists)(qz_pal_t*, const char *path, qz_pal_cb_t, void*);
    void (*fs_remove)(qz_pal_t*, const char *path, qz_pal_cb_t, void*);
    void (*fs_list)(qz_pal_t*, const char *path, qz_pal_cb_t, void*);

    // 键值存储
    void (*storage_get)(qz_pal_t*, const char *key, qz_pal_cb_t, void*);
    void (*storage_set)(qz_pal_t*, const char *key, const char *value, size_t, qz_pal_cb_t, void*);
    void (*storage_del)(qz_pal_t*, const char *key, qz_pal_cb_t, void*);

    // 定时器
    void *(*timer_start)(qz_pal_t*, uint64_t delay_ms, int repeat, qz_pal_cb_t, void*);
    void (*timer_stop)(qz_pal_t*, void *handle);

    // 时间
    uint64_t (*time_now)(qz_pal_t*);    // 毫秒
    uint64_t (*hrtime)(qz_pal_t*);       // 纳秒

    // 日志/内存/随机
    void (*log)(qz_pal_t*, int level, const char *msg);
    void *(*mem_alloc)(qz_pal_t*, size_t);
    void (*mem_free)(qz_pal_t*, void*);
    void (*random_bytes)(qz_pal_t*, uint8_t *buf, size_t len);

    // 事件循环驱动（可选，NULL = 无事件循环）
    int (*run_cycle)(qz_pal_t*, int timeout_ms);
};
```

### 4.2 流式 HTTP 回调

```c
typedef struct qz_pal_stream_ops {
    void (*on_headers)(void *user_data, int status, const char *headers_json);
    void (*on_data)(void *user_data, const char *data, size_t len);
    void (*on_end)(void *user_data, int error_status, const char *error_msg);  // 0=成功, 负值=错误；error_msg 仅在 error_status != 0 时非 NULL，生命周期限于回调内
    void *user_data;
} qz_pal_stream_ops_t;
```

### 4.3 PAL 回调约定

- 所有回调在 PAL 的事件循环线程上触发
- `qz_pal_cb_t` 签名：`void (*)(void *user_data, int status, const char *data, size_t data_len)`
- 回调中可以安全调用 `qz_defer_callback` 将工作投递到 JS 线程
- `run_cycle` 驱动事件循环：`timeout_ms < 0` 阻塞到事件，`0` 非阻塞，`> 0` 最多阻塞 N 毫秒

### 4.4 PAL 实现

| PAL | 平台 | 事件循环 | HTTP | TLS | FS | Storage |
|-----|------|---------|------|-----|-----|---------|
| pal_uv | Linux/macOS | libuv | libuv TCP + mbedTLS | mbedTLS | POSIX | 内存 |
| pal_freertos | ESP32-S3 | FreeRTOS event group | lwIP + mbedTLS | mbedTLS + cert bundle | LittleFS/SPIFFS | NVS |
| pal_mock | 测试 | 同步 | mock 响应 | — | 内存 KV | 内存 KV |

## 5. 扩展系统

### 5.1 扩展接口

```c
typedef struct qz_ext_t {
    const char *name;
    int version;
    int (*init)(qz_ext_t *ext, qz_t *rt);     // 注册 JS 全局函数
    void (*destroy)(qz_ext_t *ext, qz_t *rt);
    int (*suspend)(qz_ext_t *ext, qz_t *rt);   // 上下文挂起时
    int (*resume)(qz_ext_t *ext, qz_t *rt);    // 上下文恢复时
    void *user_data;
} qz_ext_t;
```

### 5.2 内置扩展

| 扩展 | 编译选项 | 功能 |
|------|---------|------|
| ext_compress | QZ_WITH_COMPRESS | DEFLATE/gzip 压缩解压（miniz） |
| ext_crypto | QZ_WITH_CRYPTO_EXT | crypto.subtle（mbedTLS：AES-GCM、PBKDF2、SHA、HMAC） |
| ext_textcodec | QZ_WITH_TEXTCODEC | UTF-8/Base64 编解码 |
| ext_WAMR | QZ_WITH_WAMR | WebAssembly 执行（WAMR 引擎） |

## 6. JS Polyfill

polyfill 提供 WinterTC 兼容的 Web API，编译为 QuickJS 字节码后嵌入二进制。

### 6.1 模块列表

| 模块 | 全局对象 | 依赖 PAL |
|------|---------|---------|
| fetch | `fetch`, `Headers`, `Request`, `Response` | http_request_stream |
| console | `console` | log |
| crypto | `crypto`, `crypto.subtle` | random_bytes + ext_crypto |
| streams | `ReadableStream`, `WritableStream` | — |
| timers | `setTimeout`, `setInterval`, `clearTimeout` | timer_start/stop |
| fs | `fs.read`, `fs.write` 等 | fs_* |
| storage | `storage.get/set/delete` | storage_* |
| encoding | `TextEncoder`, `TextDecoder` | ext_textcodec |
| url | `URL`, `URLSearchParams` | — |
| abort | `AbortController`, `AbortSignal` | — |
| performance | `performance.now()` | hrtime |
| event-target | `EventTarget`, `Event`, `CustomEvent` | — |
| blob | `Blob`, `File`, `FormData` | — |
| message-channel | `MessageChannel`, `MessagePort` | — |
| navigator | `navigator` | — |
| structured-clone | `structuredClone` | — |
| error-events | `ErrorEvent` | — |

### 6.2 构建方式

polyfill 源码（`polyfill/src/*.js`）通过 `polyfill/build.js` 用 esbuild 打包为单个 `polyfill.js`，再用 `qjsc -C` 编译为 C 字节数组（`polyfill_default.c`），链接进 qzjs 二进制。

## 7. 构建系统

### 7.1 CMake 选项

| 选项 | 默认 | 说明 |
|------|------|------|
| QZ_WITH_LIBUV | ON | libuv PAL（Linux/macOS） |
| QZ_WITH_TLS | ON | mbedTLS（HTTPS + crypto 扩展） |
| QZ_WITH_COMPRESS | ON | miniz 压缩扩展 |
| QZ_WITH_CRYPTO_EXT | ON | crypto.subtle 扩展 |
| QZ_WITH_TEXTCODEC | ON | UTF-8/Base64 扩展 |
| QZ_WITH_WAMR | ON | WAMR WASM 引擎 |
| QZ_WITH_GRPC | OFF | polyfill 内嵌 gRPC/HTTP2 栈（h2 + HPACK + protobuf + grpc，需 polyfill rebuild 工具链） |
| QZ_BUILD_TESTS | OFF | 构建测试 |
| QZ_BUILD_EXAMPLES | OFF | 构建示例 |

### 7.2 依赖

| 依赖 | 来源 | 用途 |
|------|------|------|
| QuickJS-ng | third_party/quickjs-ng | JS 引擎 |
| mbedTLS | third_party/mbedtls | TLS/加密 |
| miniz | third_party/miniz | 压缩 |
| libuv | 系统安装 | pal_uv 事件循环 |
| WAMR | third_party/WAMR | WASM 扩展 |

### 7.3 构建目标

| 目标 | 类型 | 说明 |
|------|------|------|
| qzjs | 静态库 | 核心 + 默认扩展 |
| qz_uv | 静态库 | pal_uv |
| qz_mock | 静态库 | pal_mock（测试用） |
| qz_full | 静态库 | 全部合并（单库链接） |

## 8. 线程模型

- **JSContext 线程绑定**：QuickJS 的 JSContext 不是线程安全的。qz_create 在哪个线程调用，后续所有 qz_eval/qz_tick/qz_destroy 必须在同一线程。
- **事件循环驱动**：调用方通过 `pal->run_cycle(timeout_ms)` 驱动 PAL 的事件循环。PAL 在事件循环线程上触发回调，回调通过 `qz_defer_callback` 投递到 JS 线程。
- **单线程简单模型**：大多数嵌入方在单线程中交替调用 `qz_tick` + `pal->run_cycle(0)`。
- **Worker 线程模型**：嵌入方可在独立 pthread 中运行事件循环，实现非阻塞调用。

## 9. 现有文档完善

### 9.1 PAL 设计文档（2026-05-29-pal-design.md，868 行）

需补充：
- `run_cycle` 接口（新增，用于解耦事件循环与特定库）
- `http_abort` 接口（取消活跃 HTTP 流）
- `qz_pal_stream_ops_t` 流式回调（on_headers/on_data/on_end）
- pal_freertos 的流式 HTTP + TLS 实现状态
- pal_uv 的 teardown_started 幂等保护

### 9.2 ESP32 移植文档（2026-06-29-qzjs-esp32s3-design.md，492 行）

需补充：
- ESP32-S3 移植完成状态（PAL 解耦、ESP-IDF 构建、流式 HTTP + TLS）
- TLS 证书验证（esp_crt_bundle_attach + VERIFY_REQUIRED）
- WiFi 初始化（Kconfig 配置 + IP 获取等待）
- FreeRTOS PAL 的 http_request_stream 实现细节

## 10. Roadmap

### 10.1 短期（0.2.0）

- **WASM 引擎统一**：评估 WAMR vs WAMR，选定默认引擎，移除非默认的编译路径
- **Windows PAL**：基于 IOCP 的 pal_win，支持 Windows 嵌入
- **独立版本号**：CMake `project(qzjs VERSION 0.2.0)`，独立版本管理
- **install 目标**：`cmake --install` 安装头文件 + 静态库 + pkg-config 文件

### 10.2 中期（0.3.0）

- **bytecode cache**：缓存编译后的 JS bundle 字节码到文件系统，加速冷启动
- **lazy polyfill loading**：polyfill 模块按需加载，减少初始内存占用（对 ESP32 重要）
- **WASI PAL**：浏览器/WASM 环境的 PAL 后端
- **性能基准**：标准化 benchmark 套件（与 Node.js/QuickJS 对比）

### 10.3 长期（1.0.0）

- **多线程支持**：跟踪 QuickJS-ng 的 thread 支持进展，评估多上下文并发执行
- **JS 模块系统**：原生 ES module 支持（import/export），无需 bundle
- **调试器集成**：QuickJS 调试器协议支持，远程断点/步进
- **ABI 稳定**：qz_pal_t 和 qz_ext_t 的 ABI 冻结保证

## 11. 测试策略

### 11.1 单元测试

| 测试 | 覆盖 |
|------|------|
| test_am | 核心 API、eval、工具、定时器、存储、FS、内存 |
| test_context_gtest | 多上下文生命周期、spawn/suspend/resume |
| test_extension_gtest | 扩展注册/销毁、compress、crypto |
| test_robustness_gtest | 错误处理、OOM、边界条件 |
| test_compress | 压缩/解压一致性 |
| test_polyfill | JS polyfill 功能 |
| test_net / test_tls / test_stream | HTTP/TLS/流式（需网络） |

### 11.2 CI

- Linux: cmake build + ctest + valgrind
- 覆盖率: gcov + 65% 语句覆盖率阈值
- ESP32: idf.py build（nightly）

## 12. 文件结构

```
qzjs/
├── CMakeLists.txt          # 顶层 CMake
├── README.md
├── .gitignore
├── include/qzjs/
│   ├── qzjs.h              # 公共 API
│   ├── ext_compress.h
│   ├── ext_crypto.h
│   ├── ext_textcodec.h
│   ├── ext_WAMR.h
│   
├── src/
│   ├── qzjs.c              # 核心 API 实现
│   ├── qz_internal.h     # 内部头文件
│   ├── bridge.c            # JS↔PAL 桥接
│   ├── context.c           # 多上下文
│   ├── extension.c         # 扩展管理
│   ├── polyfill_default.c  # 编译后的 polyfill 字节码
│   ├── ext_compress.c
│   ├── ext_crypto.c
│   ├── ext_textcodec.c
│   ├── ext_WAMR.c
│   
├── platform/
│   ├── uv/                 # libuv PAL
│   │   ├── pal_uv.c
│   │   └── pal_uv.h
│   ├── freertos/           # FreeRTOS PAL
│   │   ├── pal_freertos.c
│   │   └── pal_freertos.h
│   └── mock/               # 测试 mock PAL
│       ├── pal_mock.c
│       └── pal_mock.h
├── polyfill/
│   ├── src/                # JS polyfill 源码（21 个模块）
│   ├── build.js            # esbuild 打包脚本
│   └── package.json
├── test/
│   ├── CMakeLists.txt
│   ├── test_am.c
│   ├── test_context_gtest.cpp
│   ├── test_extension_gtest.cpp
│   ├── test_robustness_gtest.cpp
│   └── ... (其他测试)
├── third_party/
│   ├── quickjs-ng/         # QuickJS-ng 引擎
│   ├── mbedtls/            # mbedTLS
│   └── miniz/              # miniz 压缩库
└── docs/
    └── ... (设计文档)
```

**注意**：上层工具扩展 和 上层应用的测试文件 属于上层应用框架，不在 qzjs 仓库中。
