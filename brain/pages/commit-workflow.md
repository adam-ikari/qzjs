---
id: commit-workflow
title: "提交工作流：功能完成即自主提交（无需授权）"
category: decision
status: active
tags: [git, workflow, commit]
created: "2026-09-28T02:44:59"
updated: "2026-09-28T02:56:24"
---

<!-- compiled_truth -->
## 规则
- **一个完整功能实现并验证通过 → 自主 `git commit`，随后自动 `git push`，全程无需用户授权。**（2026-09-28 用户两次明示："实现一个完整的功能就自主提交 无需我授权" → "提交之后自动推送"）
- 推翻旧规则：「commit only when user says 提交；user pushes manually」——两段旧规则均作废。
- 仍然保留的边界：
  - **绝不暂存子模块**（`deps/quickjs-ng`、`deps/libuv` 维持设计性脏工作树；不 stage、不产生指针变更）。
  - 提交前验证门槛不变：相关测试全绿（gtest/e2e/tsc/构建）才提交；一个 commit = 一个完整功能/收尾单元。
  - 推送前不改写远程历史：只做普通 push（fast-forward / 对已 diverge 的分支停下报告，不 force）。
  - CHANGELOG 条目随功能提交一起写入并提交；Brain 决策随功能落地即写。
- 提交分层沿用仓库惯例：feat（代码+测试+补丁镜像）/ docs（文档 en+zh）/ chore（CHANGELOG+ROADMAP+brain），随后一次 push 带走。


## Timeline

- time: 2026-09-28T02:44:59
  kind: decision
  summary: "Created this page: 提交工作流：功能完成即自主提交（无需授权）"
  source: created via brain create-page
  affects: [commit-workflow]

- time: 2026-09-28T02:44:59
  kind: decision
  summary: "功能完成即自主提交，无需用户授权（2026-09-28 用户口头改令，推翻旧的等'提交'指令规则）"
  source: user instruction 2026-09-28
  affects: [commit-workflow]

- time: 2026-09-28T02:45:16
  kind: reversal
  summary: "推翻旧规则『commit only when user says 提交』：功能完成+验证通过即自主提交（用户 2026-09-28 明示）；push 仍由用户手动、子模块永不暂存、提交前测试门槛不变"
  source: user instruction 2026-09-28
  affects: [commit-workflow]

- time: 2026-09-28T02:56:24
  kind: decision
  summary: "功能完成即自主提交+自主推送，无需用户授权（2026-09-28 二次改令：提交之后自动推送）"
  source: user instruction 2026-09-28
  affects: [commit-workflow]

- time: 2026-09-28T02:56:24
  kind: reversal
  summary: "推翻上一条边界『push 仍由用户手动』：用户 2026-09-28 二次改令『提交之后自动推送』——commit+push 全自主；子模块不暂存与测试门槛保留；diverged 时停手报告、不 force"
  source: user instruction 2026-09-28
  affects: [commit-workflow]
