---
id: qzjs-aot
title: "qzjs AOT 路线决策"
category: decision
status: active
tags: [qzjs, aot, wamr, performance]
created: "2026-11-14T18:43:41"
updated: "2026-11-14T18:47:39"
---

<!-- compiled_truth -->
## 决策：AOT = AST 算术子树拆分加速

### 证据（M6 终态，N=50k，commit 732b4d3d）
- computeWork AOT **7.92×**（G1 ✓）— 纯 i32/f32 算术
- jsonWork AOT **0.51×** / validationWork **0.54×**（G2 N/A）— tagged 跨边界
- host bridge 死路：wasm 内嵌独立 QuickJS

### AOT 目标识别 = AST 算术子树拆分（非比例判定，非手动标注）
1. **直接拆分算术子树** — 从函数 AST 中识别纯数值计算的子树（i32/f32 BinaryExpression/UpdateExpression 链 + 包裹它们的循环/条件），拆成独立函数编译为 wasm AOT
2. **不看比例** — 不需要判断"这个函数算术占比够不够高"，而是直接把能拆的算术部分拆出来
3. **tagged 部分原样留解释器** — 属性读写、字符串、JSON、host API 调用不动
4. **粒度=代码片段** — 一个函数可以部分进 AOT（算术片段）、部分留解释器（tagged 片段）
5. **开发者无感** — 编译器自动拆分，不需标注

### 原则
- AOT 是算术子树提取器，不是函数级判定器
- 不关心函数整体特征，只关心其中有没有可提取的纯算术片段
- tagged 路径瓶颈 = JS↔wasm 边界，拆分后算术片段内部无跨界
- 跨引擎比较必须通过 WAMR


## Timeline

- time: 2026-11-14T18:43:41
  kind: decision
  summary: "Created this page: qzjs AOT 路线决策"
  source: created via brain create-page
  affects: [qzjs-aot]

- time: 2026-11-14T18:43:50
  kind: decision
  summary: "AOT 范围收缩为热点计算专用；tagged 操作不走 AOT"
  source: brain update-truth
  affects: [qzjs-aot]

- time: 2026-11-14T18:43:55
  kind: decision
  summary: "M6 终态确认 AOT 收缩为热点计算专用。computeWork 7.92× G1✓，jsonWork/validationWork N/A。commit 732b4d3d"
  source: "qzjs agent done report + WAMR bench"
  affects: [qzjs, aot-roadmap]

- time: 2026-11-14T18:44:51
  kind: decision
  summary: "AOT 范围=热点计算专用；用 AST 自动识别计算密集函数，不需手动标注"
  source: brain update-truth
  affects: [qzjs-aot]

- time: 2026-11-14T18:47:39
  kind: decision
  summary: "AOT=AST拆分算术子树单独编译；不看比例，不标注，直接拆"
  source: brain update-truth
  affects: [qzjs-aot]
