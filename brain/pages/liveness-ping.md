---
id: liveness-ping
title: "Liveness ping 机制家族 + 边界（健康度非运行时职责）"
category: decision
status: active
tags: [liveness, ping, pong, host, worker]
created: "2026-09-18T10:51:48"
updated: "2026-09-18T10:52:00"
---

<!-- compiled_truth -->
<current best understanding — replace this with the real content>

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
