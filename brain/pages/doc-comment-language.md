---
id: doc-comment-language
title: "文档与注释语言：代码英文，站点中英双语"
category: decision
status: active
tags: [doc, comments, i18n, convention]
created: "2026-10-12T06:43:13"
updated: "2026-11-13T00:05:19"
---

<!-- compiled_truth -->
## 文档与注释语言规范（项目级，用户 2026-10-12 决策；2026-10-20 追加 commit message）

### 1. 代码内产物与 commit message：英文

- **新写的代码注释**（源码内 `//`、`/* */`、doc comment）：英文。
- **新写的工程文档**（仓库内 README / 设计文档等开发者文档）：英文。
- **git commit message**：英文（2026-10-20 追加；此前误用中文的存量 commit 不回溯）。

### 2. 用户面站点：中英双语

- **网站**（面向用户的站点内容）维护**中英双语**。
- 双语 = 两套并行文案，不是夹杂混写；各自完整、可独立阅读。

### 3. 存量中文不迁移

- 已存在的中文文档、中文注释、中文 commit message **不翻译、不回溯、不迁移**；保持原样。
- 规范只约束**新增**内容，不做 retrofit。

### 边界与例外

- 本页只管**语言选择**，不管文风；文风见 `plain-language`、`code-quality-requirements`。
- 交互对话（与用户沟通）不受此约束；约束的是**入库新增产物**。
- 站点双语的落地机制（i18n 目录结构 / 路由 / 构建）不在本页范围，另行决策。

### 落地方式

- 新增/修改源码注释、工程文档、commit message：写英文。
- 新增/修改站点内容：补中英两版。
- 改动既有中文产物时：新写入部分用英文；未触及的原文不动。


## Timeline

- time: 2026-10-12T06:43:13
  kind: decision
  summary: "Created this page: 文档与注释语言：代码英文，站点中英双语"
  source: "用户 2026-10-12 决策"
  affects: [doc-comment-language]

- time: 2026-10-12T06:43:21
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "用户 2026-10-12 决策"
  affects: [doc-comment-language]

- time: 2026-10-12T06:53:49
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "用户 2026-10-12 决策（含存量不迁移追加）"
  affects: [doc-comment-language]

- time: 2026-10-20T01:51:39
  kind: decision
  summary: "2026-10-20 追加：git commit message 也用英文（非中文）。此前中文 commit 存量不回溯。"
  affects: [doc-comment-language]

- time: 2026-10-20T01:51:49
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [doc-comment-language]

- time: 2026-11-13T00:05:19
  kind: note
  summary: "Enforcement reminder (2026-11-13): this session added new code comments in Chinese, violating the rule below. All newly written comments in src/qzvm/aot/emit/emitter.js, tagged.js, audit_corpus47.js and the two new CHANGELOG entries have been rewritten in English. Going forward: new code comments, engineering docs and commit messages are English; existing Chinese content stays untouched. The brain timeline entries themselves are written in English for this session."
  source: "agent session 2026-11-12/13 (AOT fixes ea4d3bd4, 0e00129f and follow-up)"
  affects: [doc-comment-language]
