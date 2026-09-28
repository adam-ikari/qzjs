---
slug: architecture
title: System architecture
role: system architecture
updated: "2026-09-28T11:28:23"
---

# System architecture

## Overview

qzjs 是 C99 编写的嵌入式 JS 运行时包装层：宿主通过 C API（qz_create/destroy/post_message 等）
与 qzjs 交互；事件循环内置于运行时——缺省 ISOLATED 进程模型下 JS 跑在独立主RT 进程
（qzjs-rt，库自有 loop+线程），宿主侧库不拥有线程：宿主经 cfg.uv_loop 注入 uv_loop_t，
通道句柄全部挂上，message_cb 在泵宿主 loop 的线程触发（M-P6）；THREAD 模型下为库内部线程 +
嵌入式 libuv 循环。polyfill（ES module 经 esbuild 打包）提供 WinterTC Web API 层；
原生扩展通过 PAL 桥接暴露给 JS。

## Module graph

```mermaid
graph TD
  H[Host C application] -->|qz_* C API| R[qzjs core<br/>src/qzjs.c + bridge.c]
  R -->|libuv loop| L[libuv]
  R --> Q[QuickJS-ng runtime]
  Q -->|bundle| P[polyfill ES modules<br/>fetch/streams/worker/crypto/http-server/...]
  Q -->|extensions| E[PAL extensions<br/>compress / crypto / textcodec / wamr]
  P -->|pal.* API| R
  P -->|pal.tcp*/tls*| U[serve(): raw TCP + mbedTLS<br/>HTTP1.1/HTTPS/WS/static/gzip]
  R -->|Worker| W[Worker thread<br/>src/worker.c + MessagePort routing]
  T[test/ gtest + mock_libuv] -->|offline| R
```

## Constraints

- 严格 C99；事件循环归属按模型：ISOLATED 宿主侧 loop 归宿主（注入 cfg.uv_loop，库借用且永不 UV_RUN_DEFAULT/uv_loop_close），THREAD 与主RT 进程内部为 qzjs 自持线程
- 确定性离线测试:mock_libuv 替换真实 libuv，无网络/无真实时间依赖
- 子模块策略:deps/ 全部 pin 版本(quickjs-ng/wamr/mbedtls/...)
- polyfill 产物(disting/polyfill.js + src/polyfill_default.c)纳入 git(git add -f)
