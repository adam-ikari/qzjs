---
id: decision-authority-tiers
title: "决策权限分级（Tier 1/2/3）：agent 自主边界 + decision 日志 + notify"
category: decision
status: active
tags: [process, decision, management]
created: "2026-11-13T23:20:05"
updated: "2026-11-13T23:47:10"
---

<!-- compiled_truth -->
<current best understanding — replace this with the real content>

## Timeline

- time: 2026-11-13T23:20:05
  kind: decision
  summary: "Created this page: 决策权限分级（Tier 1/2/3）：agent 自主边界 + decision 日志 + notify"
  source: chat/AGENTS.md 2026-11-13
  affects: [decision-authority-tiers]

- time: 2026-11-13T23:47:10
  kind: decision
  summary: "判级补丁：qzos 依赖上游 qzjs 且未大规模开发。experiment/aot-v2 分支内可 revert 改动= Tier 1/2（不碰 qzos、不碰 qzjs master/发布线）；任何并入 qzjs master/release 的改动会流入下游 qzos = 跨项目影响 = Tier 3（记 pending + blocked 等一字）。AOT 收益是 qzos 未来规模化的上游准备。"
  source: user interjection 2026-11-13
  affects: [decision-authority-tiers]
