---
title: 常见问题
description: qzjs 常见问题 — Node.js 兼容性、进程模型、内存、API 可用性与设计意图。
---

# 常见问题

看起来像 bug、实为设计的问题，以及诚实的边界。每题都链到完整说明所在页面。

## 定位

### qzjs 是 Node.js 的替代品吗？

不是。qzjs 是**面向可信脚本的可嵌入运行时**，不是 Node.js 的替代。没有
`require`，不能 `import` Node 内置模块，没有 `process`、`Buffer`、CommonJS。
许多纯 JS npm 包可以原样运行，因为它们只用到标准 Web API 面；只依赖 Node 的
则不行。用 `python3 test/compat_check.py <pkg>` 测试具体包——见
[兼容包](/zh/guide/compatible-packages)。

### qzjs 是浏览器吗？

不是。它实现 Web API 的 **WinterTC** 子集（fetch、WebSocket、流、crypto、
定时器……），但没有 DOM：没有 `document`、没有 `window`、不做渲染。它是
服务端/边缘侧运行时。

### qzjs 是运行不可信代码的沙箱吗？

**不是。** qzjs 运行可信脚本。脚本可以读写宿主进程能访问的任意路径、派生
进程、读取完整环境——这些是合法能力，不是逃逸。完整威胁模型见
[安全模型](/zh/guide/security)。

### 体积多大、启动多快？

`minimal` profile strip 后约 **2.45 MiB**，启动 **<5 ms**，峰值 RSS 接近
3 MB。它面向 Node.js / bun 无法覆盖的嵌入式与边缘目标。数据来自项目自身的
基准测试——见[性能基准](/zh/guide/benchmarking)。

## 并发与进程模型

### 是多线程的吗？JS 能并行吗？

**主运行时是单线程的。** 所有 JS 在 qzjs 自有的内部线程上运行（ISOLATED 下这是
主RT 进程内库自有的线程/loop；THREAD 下是库的内部线程），该线程同时驱动内嵌的
libuv loop；宿主线程从不执行 JS，也不会被回调——qzjs 从不执行宿主代码，发往
宿主的消息（JS `postMessage`、崩溃上报、CONTROL 回执）一律进入每运行时一条的
FIFO 邮箱，等宿主在自己的线程上用 `qz_recv_message` 消费。并发来自异步 I/O，
不是主上下文中的并行 JS。

Web Worker **确实**并行——按后端不同以线程或子进程形式——但通过结构化克隆
消息通信。

### `THREAD` 与 `ISOLATED` 有何区别？

`QZ_PROCESS_MODEL` 选择默认的 worker 后端：

- **`ISOLATED`**（默认）——每个 `new Worker(...)` 经 fork+exec 在专用子进程
  （`qzjs-rt`）中运行。隔离性更强，有 IPC 开销。宿主侧形态也随之改变：JS 跑在
  主RT 进程里，库自持宿主侧泵线程与 loop，发往宿主的消息全部进入 FIFO 邮箱，
  由宿主经 `qz_recv_message` 消费——无需注入、也无需泵动任何循环。见
  [事件循环](/zh/guide/event-loop)。
- **`THREAD`**——worker 是同一进程内的线程。开销更低，共享地址空间。库自带内部
  qzjs 线程跑一切，宿主同样只需消费邮箱。

两者都不是针对恶意脚本的安全边界。见
[多上下文与 Web Worker](/zh/guide/multi-context)。

### 为什么 Worker 需要伴随二进制？

`ISOLATED` 下 worker 是独立进程，需要可执行文件来启动：`qzjs-rt`。它与 CLI
一并构建（`QZ_BUILD_CLI=ON`）。找不到即派生失败——见
[常见问题排查](/zh/guide/troubleshooting#worker-与进程模型)。

### Worker 能共享内存吗？

不能。消息是结构化克隆的，不共享。用 `postMessage` / `MessageChannel`。

## API

### 有哪些 Web API 可用？

21 个模块以全局形式暴露：`fetch`、`console`、`crypto.subtle`、`streams`、
`timers`、`URL`、`TextEncoder`/`TextDecoder`、`AbortController`、
`WebSocket`、`BroadcastChannel`、`EventSource`、`CacheStorage`、
`Service Worker`、`Worker`、`fs`、`storage`、`navigator`、`serve()`、`grpc`、
`compress`、`structuredClone` 等。含全局名的完整列表见
[JS API 参考](/zh/js-api/)。

### 为什么 `serve()` 不基于 `node:http`？

`serve()` 是 qzjs 自有的 HTTP/WS/gRPC 服务器，不是 Express 或 `node:http` 的
移植。它是单服务器、回调驱动的 API，同一时刻只允许一个服务器运行。见
[serve()](/zh/js-api/serve)。

### 有公开的字节码 API 吗？

**有。** `qz_compile()` 把 JS 源码编译为字节码，宿主在启动时经
`qz_config_t.initial_bytecode` 运行（CLI：`qzc` /
`qzjs --bytecode`）。注意：字节码与 qzjs 的具体构建绑定，**不**保证跨版本
可移植——运行时会显式拒绝不兼容的字节码。请在部署环境按目标构建编译。
见[字节码编译](/zh/guide/bytecode)。

### 宿主能直接调用 JS，比如 `qz_eval` 吗？

不能。公开 C API 上**没有 `qz_eval`**。宿主与运行时只通过 JSON 消息通信——
`qz_post_message` 入站；出站（JS `postMessage`、崩溃上报、CONTROL 回执）进入
每运行时一条的 FIFO **邮箱**，宿主在自己的线程上用 `qz_recv_message` /
`qz_free_message` 消费——qzjs 从不执行宿主代码。这让 JS 执行边界保持显式，宿主
无需 eval 通道。见[主机集成](/zh/guide/host-integration)。

### 为什么测试里定时器表现怪异？

GoogleTest 测试框架链接了 **`mock_libuv`**——一个确定性的进程内 libuv API
仿真。在其下定时器被量化为 1 秒刻度，以便测试确定性地推进时间。这是测试
专属产物，不是运行时行为。见[测试](/zh/dev/testing)。

## 构建与 profile

### `minimal` 与 `standard` 有何区别？

`QZ_PROFILE=minimal` 保留 WebAssembly、`crypto.subtle`、`atob`/`btoa` 和
压缩——仍满足 WinterTC 全量必选集的最小构建。`standard` 补齐其余
`QZ_WITH_*` 功能。单个 `QZ_WITH_*` 选项可覆盖任一 profile。见
[构建选项](/zh/guide/build-options)。

### 能同时启用两个 WASM 引擎吗？

不能——WAMR 与 wasm3 都注册 `WebAssembly` 全局，因此互斥。默认是 WAMR
（Fast Interp + AOT）。

### qzjs 需要系统库吗？

不需要。所有依赖——libuv、mbedTLS、miniz、WAMR、cJSON 等——都经 CMake 从
`deps/` 下固定的子模块源码构建。递归检出子模块，否则 configure 阶段会以
明确消息失败。

### 为什么用 C99？

qzjs 要能嵌入 C99 宿主应用——设备固件与边缘服务——并与依赖一起按 C99 构建。
该约束让运行时能构建于尚不支持 C11 原子操作的工具链上。

## 错误与调试

### `qz_create` 为什么返回 NULL？

初始脚本抛异常，或线程/loop 初始化失败；ISOLATED 下主RT 进程（`qzjs-rt`）
spawn 失败同样返回 `NULL`——库不依赖宿主注入任何循环。见
[常见问题排查](/zh/guide/troubleshooting#运行时创建)。

### 怎么调试 JS？

以调试模式构建，qzjs 会自动通过 stdio 挂接 **DAP** 调试适配器——断点、
单步、变量查看、暂停期间的异步。不支持 CDP / Chrome DevTools。见
[调试](/zh/dev/debugging)。

### 网络栈有问题

先检查代理环境变量：`fetch` 在 C 层透明遵循 `HTTP_PROXY` / `HTTPS_PROXY` /
`NO_PROXY`。不支持的代理 scheme（如 `socks5://`）会让请求 **fail closed**，
而不是静默绕过代理。

## 另见

- [常见问题排查](/zh/guide/troubleshooting) — 现象 → 原因 → 修复
- [安全模型](/zh/guide/security) — 威胁模型与不在范围内的项
- [用例](/zh/guide/use-cases) — qzjs 适用与不适用的场景
