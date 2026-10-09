---
id: console-output-routing
title: "console 输出分流（stdout/stderr）"
category: decision
status: active
tags: [console, cli, behavior]
created: "2026-08-15T08:25:40"
updated: "2026-08-15T08:25:44"
---

<!-- compiled_truth -->
## compiled_truth
### console 输出分流（2026-08-15 实现，Task 1 完成）
- `js_pal_log`（src/host/bridge.c）按 level 分流：**level < 2（debug/info/log）→ stdout；level >= 2（warn/error）→ stderr**；不再输出 `[qzjs:%d]` 前缀。polyfill console.js 的 level 映射：0=debug, 1=log/info, 2=warn, 3=error。
- 对齐 node/deno 等 Web 运行时 console 形态；对齐依据见 docs/archive/superpowers/plans/2026-08-15-qzjs-cli.md Task 1。
- **行为变更**：嵌入者若依赖 `[qzjs:N]` 前缀或全 stderr 输出会被影响；该提交独立可回滚（commit 3c64d125）。
- 输出流验证方式：CLI fork 测试（Task 8 test_cli_gtest）断言 stdout/stderr 分离。


## Timeline

- time: 2026-08-15T08:25:40
  kind: decision
  summary: "Created this page: console 输出分流（stdout/stderr）"
  source: docs/archive/superpowers/plans/2026-08-15-qzjs-cli.md Task 1
  affects: [console-output-routing]

- time: 2026-08-15T08:25:44
  kind: decision
  summary: "console 分流决策定案（Task 1 实现完成）"
  source: "Task 1 implementation (commit 3c64d125)"
  affects: [console-output-routing]
