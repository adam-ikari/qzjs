---
id: worker-error-events
title: "Worker 错误事件流设计"
category: decision
status: active
tags: [worker, error-events, w3c]
created: "2026-08-14T09:22:43"
updated: "2026-08-28T15:53:31"
---

<!-- compiled_truth -->
## compiled_truth

### Worker 脚本顶层异常的错误事件流（2026-08-14 实现，Task 1 完成）
- worker 侧：`qz_worker_notify_error`（src/host/worker.c）在 worker 自己的 JSRuntime 内构造 `new ErrorEvent('error', {message, filename:'', lineno:0, colno:0, error:<Error>})` 并 `globalThis.dispatchEvent` → 触发 `self.onerror` / `addEventListener('error')`。
- 父侧：C 层仍经 postMessage 发 `{type:'error', error:<msg>}`（结构化克隆字节）；polyfill worker.js 的 `__qz_dispatch__` 按 `d.type === 'error'` 路由到 `w._onerror`。**注意：父侧收到的是 MessageEvent，`e.data = {type:'error', error:<msg>}`，不是 ErrorEvent 实例**（计划目标文本说"均收到 ErrorEvent"，但计划代码片段与测试用 `e.data`，实现以片段+测试为准）。
- ErrorEvent 构造失败时回退为仅父通知；worker 继续存活（后续 postMessage 往返不受影响）。
- 新增 Worker 实例 `onerror` 存取器（与 onmessage 同款）；路由特判对 worker 主动发送的合法 `{type:'error'}` 消息有误伤风险（已接受，见计划）。


## Timeline

- time: 2026-08-14T09:22:43
  kind: decision
  summary: "Created this page: Worker 错误事件流设计"
  source: docs/archive/superpowers/plans/2026-08-14-standard-compliance.md Task 1
  affects: [worker-error-events]

- time: 2026-08-14T09:22:48
  kind: decision
  summary: "Worker 错误事件流设计定案（Task 1 实现完成）"
  source: Task 1 implementation
  affects: [worker-error-events]

- time: 2026-08-28T15:53:31
  kind: decision
  summary: "A2 修复：timers.js setTimeout/setInterval 回调抛错接入 reportError 错误事件流（原只 console.error，worker 内 self.onerror 收不到异步异常）；async_error_self_onerror_survives gtest 覆盖"
  source: 2026-08-28 A2 session
  affects: [worker-error-events]
