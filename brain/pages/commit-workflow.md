---
id: commit-workflow
title: "提交工作流：功能完成即自主提交（无需授权）"
category: decision
status: active
tags: [git, workflow, commit]
created: "2026-09-28T02:44:59"
updated: "2026-09-28T02:45:16"
---

<!-- compiled_truth -->
## 规则
- **一个完整功能实现并验证通过 → 自主 `git commit`，无需等用户授权。**（2026-09-28 用户明示："实现一个完整的功能就自主提交 无需我授权"）
- 推翻旧规则：「work autonomously on 继续；commit only when user says 提交」——旧规则作废，无需等待提交指令。
- 仍然保留的边界：
  - **用户手动 push**（自主提交不等于自主推送）。
  - **绝不暂存子模块**（`deps/quickjs-ng`、`deps/libuv` 维持设计性脏工作树；不 stage、不产生指针变更）。
  - 提交前验证门槛不变：相关测试全绿（gtest/e2e/tsc/构建）才提交；一个 commit = 一个完整功能/收尾单元。
  - CHANGELOG 条目随功能提交一起写入并提交；Brain 决策随功能落地即写。
- 提交粒度：功能（含其测试/文档/CHANGELOG）为一个 commit；跨功能的收尾件可并入该功能 commit。


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
