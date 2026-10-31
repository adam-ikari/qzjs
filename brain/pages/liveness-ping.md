---
id: liveness-ping
title: "Liveness ping 机制家族 + 边界（健康度非运行时职责）"
category: decision
status: active
tags: [liveness, ping, pong, host, worker]
created: "2026-09-18T10:51:48"
updated: "2026-10-13T08:06:03"
---

<!-- compiled_truth -->
## 结论

**Liveness ping 家族 = 宿主跨进程探测对端 uv loop 健康度的机制**（不测 JS 忙不忙）。

- **设计要害**：PING 走 CONTROL 通道，**PONG 由对端 C 层读回调直回、不经 JS/msgq**——故 pong 延迟只反映**对端进程 uv loop 的健康度**；对端 JS 即使忙死也不误报（这是刻意选择：loop 通畅 = 能推进 I/O，正是宿主关心的）。
- **声明与实现同条件编译**（`include/qzjs/qzjs.h:163-210`）：实现住 `src/host/rt_host.c`，该文件只在 `QZ_PROCESS_MODEL=ISOLATED && !QZ_USE_MOCK_LIBUV` 时编译。故 `qz_ping`/`qz_ping_path` 的声明也**同条件**——THREAD 构建下压根不声明，宿主 `#if` 一眼可见「这个编译模型没有跨进程边界可测」。若无条件声明，THREAD 宿主会「编译通过、链接才炸」（`undefined reference to qz_ping`），看起来像构建坏了。

## API

| 函数 | 目标 | 模型可用性 |
|---|---|---|
| `qz_ping(rt, timeout_ms)` | 宿主 → 主RT | 仅 ISOLATED |
| `qz_ping_path(rt, path, path_len, timeout_ms)` | 宿主 → 树中任意 worker（path = root-relative 槽位链，如 `{1001,1002}` = 主RT 的 worker 1001 的 sub 1002） | 仅 ISOLATED |
| `qz_ping_if_available` / `qz_ping_path_if_available` | 转发（ISOLATED）/ 恒返 `QZ_PING_UNAVAILABLE`（THREAD/mock） | 两模型都编 |

**返回值（`qz_ping`/`qz_ping_path`）**：`0` = 对方 loop 通畅（deadline 内 PONG 命中）；`1` = 超时 = 对方 loop 阻塞（或读回调 starvation）；`-1` = 参数/状态错误（未 ready、关停中、通道死——进程死亡另有 EOF 路径）。`timeout_ms` 建议 100–1000。

**`QZ_PING_UNAVAILABLE = -2`**：与 `-1` 刻意分开——把「测不了」混进「参数错了」，宿主就无法区分「我代码写错」与「这个构建压根没有可测边界」，而两者该做的后续完全不同。

## 逐跳语义（`qz_ping_path`）

PING 按链**逐跳下投**（中间节点读回调 C 层转发，**不消费、不进 JS**）；目标读回调直回 PONG（回显路径作过境标记）沿树上行。中间节点**目标级 JS 零参与**。中间通道死 → 转发失败由中间节点回执**快速判 -1**，不白等 timeout。

## `qz_ping_if_available` 为何在 THREAD 下刻意返 `-2` 而非 0

JS 在 THREAD 模式跑在**库自有线程**上，宿主与它之间没有可 ping 的边界——「问自己通不通」不是有意义的探测。**谎报健康（返 0）比明说「测不了」危险得多**：宿主会据此以为 loop 健康，掩盖真实故障。


## Timeline

- time: 2026-09-18T10:51:48
  kind: decision
  summary: "Created this page: Liveness ping 机制家族 + 边界（健康度非运行时职责）"
  source: "2026-09-18 用户拍板"
  affects: [liveness-ping]

- time: 2026-09-18T10:52:00
  kind: decision
  summary: "Liveness ping 机制三块全落地（2026-09-18）：①宿主→主RT qz_ping（c734194d，主RT 读回调 C 层直回 PONG）②worker→sub Worker.prototype.ping（b3d99b41+3e733e12，父 poll+recv 自驱动配对）③宿主→任意 worker qz_ping_path（848c3eb9，§8.2 path 寻址 + PONG tp 过境标记 + pfail 快速失败）。核心：pong 由目标读回调 C 层直回（不经 JS/msgq），延迟纯反映目标 uv loop 健康度，JS 忙不误报。边界（用户 2026-09-18 拍板）：qzjs 只提供 ping 机制（被动 API，显式调用触发），健康度检测/监控是宿主调用方职责——运行时不做自动心跳、不做自动健康监控、不维护健康状态、不上报。"
  source: "2026-09-18 用户拍板"
  affects: [liveness-ping]

- time: 2026-10-13T08:06:03
  kind: decision
  summary: "补真内容：qz_ping 家族（宿主跨进程探测对端 uv loop 健康度，PONG 由对端 C 层读回调直回不经 JS→忽视 JS 忙；声明与实现同条件编译 ISOLATED && !mock；QZ_PING_UNAVAILABLE=-2 与 -1 刻意分开；path 逐跳下投中间节点 JS 零参与）。"
  source: "include/qzjs/qzjs.h:155-215 + src/host/rt_host.c 实现"
  affects: [liveness-ping]
