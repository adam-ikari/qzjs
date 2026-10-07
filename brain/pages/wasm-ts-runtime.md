---
id: wasm-ts-runtime
title: "Perry 式 wasm 化路线（TS 编译 wasm + qzjs 运行时 wasm 化 + WAMR）"
category: decision
status: archived
tags: [wasm, ts, wamr, roadmap]
created: "2026-09-18T06:53:31"
updated: "2026-10-07T15:10:24"
---

<!-- compiled_truth -->
<current best understanding — replace this with the real content>

## Timeline

- time: 2026-09-18T06:53:31
  kind: decision
  summary: "Created this page: Perry 式 wasm 化路线（TS 编译 wasm + qzjs 运行时 wasm 化 + WAMR）"
  source: "2026-09-18 用户拍板"
  affects: [wasm-ts-runtime]

- time: 2026-09-18T06:53:31
  kind: decision
  summary: "Perry 式 wasm 化路线（用户 2026-09-18 拍板，远期）：①原生支持 TS 源码编译成 wasm 模块；②把 qzjs 的 JS 运行时改造成类 perry-js-runtime 的 wasm 模块（JS 运行时本身编译成 wasm）；③用 WAMR 运行编译后的 wasm 模块；④TS 写的模块同样支持 WinterTC（ECMA-429）和当前 qzjs 全部 API。执行约束：独立分支、合适时机才开始实验、**qzjs 成熟之前不要尝试**（延期触发器 = qzjs 主轨道成熟）。现有基础：WAMR 已集成（wasm-engine-integration brain 页，threading 已知坑）、WinterTC API 覆盖已落地。此决策为方向性记录，不改变当前工作排期。"
  source: "2026-09-18 用户拍板"
  affects: [wasm-ts-runtime]

- time: 2026-09-18T06:58:45
  kind: decision
  summary: "补充约束（用户 2026-09-18）：①Perry 已有的成熟工具尽量复用（不重复造轮子——Perry 的 TS→wasm 编译链、wasm runtime 封装等成熟组件直接采纳/适配）；②实验开始时的验收标准 = 以尽可能小的改动跑起来（最小可行切片：先打通一条 TS→wasm→WAMR→跑通 qzjs API 的路径，验证链路成立后再渐进扩展，不一次性重写运行时）。"
  source: "2026-09-18 用户拍板"
  affects: [wasm-ts-runtime]

- time: 2026-10-07T15:10:24
  kind: reversal
  summary: "被 release-artifact-topology 取代/吸收：AOT/发行改用新拓扑路线（TS→wasm+JS胶水调用WinterTC API；三种产物 ELF/Wasm/JS+Wasm）。本页 Perry 式 wasm 化路线中『TS编译wasm』部分已被新拓扑定型，余下『运行时wasm化+WAMR』方向如需保留应另立页。"
  source: brain archive-page
  affects: [wasm-ts-runtime]
