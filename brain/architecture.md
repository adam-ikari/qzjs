---
slug: architecture
title: System architecture
role: system architecture
updated: "2026-09-28T17:19:04"
---

# System architecture

## Overview

qzjs 是 C99 编写的嵌入式 JS 运行时包装层：宿主通过 C API（qz_create/destroy/post_message/recv_message 等）
与 qzjs 交互；事件循环内置于运行时——缺省 ISOLATED 进程模型下 JS 跑在独立主RT 进程
（qzjs-rt，库自有 loop+线程）；主权原则（M-P7 裁决，2026-09-28 落地）：qzjs 完全自主管理自己的
线程和进程、不干涉宿主形态、不跨线程调用宿主任何函数——宿主侧由库自管泵线程+loop，host 方向
消息入邮箱（qz_recv_message 阻塞/超时/非阻塞三态 + qz_message_fd 唤醒 fd），宿主在自选线程上
自行消费，postMessage/邮箱是唯一通讯面（M-P6 的 cfg.uv_loop 注入契约与 message_cb 回调已整体废除）。
THREAD 模型下为库内部线程 + 嵌入式 libuv 循环，出站消息同样入邮箱由宿主消费。polyfill（ES module 经
esbuild 打包）提供 WinterTC Web API 层；原生扩展通过 PAL 桥接暴露给 JS。

## Module graph

```mermaid
graph TD
  H[Host C application] -->|qz_* C API + mailbox drain| R[qzjs core<br/>src/qzjs.c + bridge.c]
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

- 严格 C99；事件循环归属（M-P7 现状）：一切 loop/线程归 qzjs 自管（ISOLATED 宿主侧泵线程 + 主RT 进程 + THREAD/worker 内部线程），宿主只消费邮箱、零泵义务、零回调；qzjs 从不执行宿主代码，公共 API 无函数指针字段，宿主无 libuv 同链接义务
- 确定性离线测试:mock_libuv 替换真实 libuv，无网络/无真实时间依赖
- 子模块策略:deps/ 全部 pin 版本(quickjs-ng/wamr/mbedtls/...)
- polyfill 产物(disting/polyfill.js + src/polyfill_default.c)纳入 git(git add -f)
