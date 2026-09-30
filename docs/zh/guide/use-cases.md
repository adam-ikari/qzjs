---
title: 用例
description: qzjs 适合的场景——在 C 应用中嵌入 JS + Wasm、边缘节点、设备与可扩展运行时，低开销。
---

# 用例

qzjs 是一个 **WinterTC 兼容运行时**，用于在 C 应用内嵌入 JS（与 WebAssembly），
提供线程安全的 JSON 消息边界与极低开销。凡是想把逻辑推给 JavaScript 而又不
想背起重进程或完整浏览器引擎的场景，qzjs 都很合适。

## 嵌入式与边缘节点

最典型场景：在资源受限的目标上运行 JS。

- **边缘网关** — 需要以 JS 解释规则、过滤或协议胶水，无需重编译 C 固件即可热更。
- **嵌入式设备** — qzjs 零依赖构建（剥离 2.45 MiB、约 5 ms 启动）可跑在 Node/Deno
  无法承载的目标上。
- **低开销脚本** — 一个 `initial_script` 或消息驱动处理器取代手写 C 状态机。

宿主留在 C。qzjs 完全自主管理自己的线程与 loop，从不执行宿主代码：ISOLATED 下
JS 跑在独立的主RT 进程里、库自持宿主侧线程；THREAD 下 JS 跑在库的内部线程上。
一切发往宿主的内容——JS 的 `postMessage` 输出——都进入 FIFO 邮箱，由宿主在
自己的线程上经 `qz_recv_message` 消费、自选时机。

## 给 C 应用加脚本能力

无需完整解释器集成，就给 C 应用一个脚本接口。

- 用 `initial_script` 承载逻辑，运行时即可更新逻辑。
- 宿主和 JS 之间用 JSON 消息通信：宿主发 JSON（数据或命令）给 JS，JS 的 `onmessage` 处理后用 `postMessage` 把结果 JSON 发进邮箱，宿主经 `qz_recv_message` 取回。
- 通过编译进的扩展把 C 函数暴露给 JS（[示例](/zh/guide/examples)，`extension/`）。

## 原生上的 WinterTC Web API

按标准 Web API 写的代码原样运行：

- `fetch`、`WebSocket`、`EventSource`、流、定时器、`crypto.subtle`、
  `BroadcastChannel`、`serve()`（HTTP/WS/gRPC）——都作为全局对象可用。

## 边缘并行

- `new Worker(url)` 运行隔离上下文——并行线程，或默认
  `-DQZ_PROCESS_MODEL=ISOLATED` 下的独立子进程。
- 把 CPU 密集或阻塞工作从主运行时线程卸下。
