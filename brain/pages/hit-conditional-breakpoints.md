---
id: hit-conditional-breakpoints
title: "DAP hitCondition 命中次数断点（设点解析 + edge-triggered 计数）"
category: decision
status: active
tags: [dap, debugger, breakpoints]
created: "2026-09-28T04:38:33"
updated: "2026-09-28T04:39:08"
---

<!-- compiled_truth -->
## 现状（已实现，合入 d0a94fed）

### C 层（src/debugger.c）
- `hit_condition_parse` 设点时一次性解析 DAP hitCondition：`"N"`/`"==N"`→HIT_EQ、`"%N"`→HIT_MOD、`> >= < <= !=` 关系式；拒绝 %0、负数、无操作数、尾随垃圾（返回 -2 → 未注册任何东西）。
- `qz_bp_t` 新增 `hit_op`(-1=无条件)/`hit_n`/`hit`/访问跟踪三元组 `reach_file/line/depth`。
- 命中计数 **edge-triggered**：新访问才 `hit++`（`!bp->reach_file` 时）；访问结束转移与 re-hit guard 一致（同深度换行/换文件、或返回出更浅帧 = 离开；**进 callee 不算离开**——调用属于本语句，返回不得重计）。`bps_visit_advance` 每次派发无条件调用，防其他断点停顿留下脏访问态。
- `bp_hit_true` 在条件求值前门控；`qz_debug_add_breakpoint` 第 5 参 `hit_condition`，-2 = 解析失败且未注册。

### DAP 层（src/debugger_dap.c）
- setBreakpoints 注册与响应一体：rc<0 → `verified:false`（-2 附 `invalid hitCondition: …`）→ VS Code 显示灰色未安装 glyph。

### 适配器（qzjsDebugSession.ts）
- `supportsHitConditionalBreakpoints = true`；`applyVerified` 中 C 的 `false` 是权威——不再被行号检查复活（适配器只收窄不放宽）。

### 测试
- gtest `test_dap_gtest` 全绿；e2e `vscode/qzjs-debug/test/hit-condition.mjs`：循环 6 次、`%2` 恰停 2/4/6 三次（re-hit guard 不虚增计数），无效 hitCondition verified:false 不复活，`s 15` 断言跑完。


## Timeline

- time: 2026-09-28T04:38:33
  kind: decision
  summary: "Created this page: DAP hitCondition 命中次数断点（设点解析 + edge-triggered 计数）"
  source: created via brain create-page
  affects: [hit-conditional-breakpoints]

- time: 2026-09-28T04:39:08
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [hit-conditional-breakpoints]
