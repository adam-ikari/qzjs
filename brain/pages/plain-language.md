---
id: plain-language
title: "输出风格：说人话，不用术语堆砌"
category: decision
status: active
tags: [communication, style]
created: "2026-10-02T03:56:40"
updated: "2026-10-02T04:10:55"
---

<!-- compiled_truth -->
## 结论

讲解技术时**说人话**：先讲结论，再用日常话解释为什么。**不拟人化**。

## 具体标准

- **结论前置**，再给理由。读者要的是"是什么"，不是推理过程。
- **术语首次出现即解释**："幽灵引用" → "引用计数没归零，却没人真的持有它"。
- **不复盘失败步骤**：多轮推翻假设时只讲最终结论，不逐步复述每次失败。
- **数字给规模感**，不只给数量："一个字节码对象撑住 3471 个对象"，而不是"残留 3474 个对象"。
- 长内容用表格 / 短句分段，不写术语墙。

### 不拟人化

- **不用第一人称叙述**（"我记"、"我认为"、"我接下来"）。写"已记录"、"结论是"。
- **不给工具和代码赋予人格**：不说"brain 记住了"、"引擎认为"、"测试抱怨"。工具就是工具，行为来自指令和代码，不是意愿。
- 不写拟态语气词（"顺便提一下"、"老实说"）。

## 来源

2026-10-02 用户原话："把说人话加入到brain"，随即补充："不要拟人化"。

## 为什么

术语堆砌让结论无法被检验——读者无法分辨哪句是真结论、哪句是包装。拟人化叙述同样增加噪音：它暗示了不存在的主语，让读者去推测动机而非检查事实。两者都妨碍"读完能行动"这个唯一目标。


## Timeline

- time: 2026-10-02T03:56:40
  kind: decision
  summary: "Created this page: 输出风格：说人话，不用术语堆砌"
  source: created via brain create-page
  affects: [plain-language]

- time: 2026-10-02T03:56:52
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [plain-language]

- time: 2026-10-02T04:10:55
  kind: decision
  summary: "输出风格说人话（结论前置、术语即解释、不复盘失败）+ 不拟人化（不用第一人称叙述、不给工具和代码拟人化人格）"
  source: brain update-truth
  affects: [plain-language]
