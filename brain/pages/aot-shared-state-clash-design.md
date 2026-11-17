---
id: aot-shared-state-clash-design
title: "AOT：wasm 与 interp 共享模块状态的三条路 + 决定（只在无状态模块翻转）"
category: decision
status: active
tags: [aot, interp, clash, design]
created: "2026-11-13T22:28:21"
updated: "2026-11-17T17:36:04"
---

<!-- compiled_truth -->
## 问题

interp 函数跑在 `new Function(interpJs)` 的独立 JS 副本；wasm 侧模块级绑定是 wasm 全局。
同一绑定被两侧触碰原本产生双份状态 → 静默错值；实测只读 const 也有 `===`/Map 键失效与
模块级语句双执行。解法不是放宽判据，而是让 interpJs 副本成为唯一事实源。

## 已落地方案（2026-11-17，路径 c）

- `compile-ts.js`：clash 的 **const 模块绑定**提升为 host-backed（`modInterpBindings`），
  从 `mutableModNames` 移除；初值依赖按 fixpoint 继续提升。`let`/类/构造器冲突仍整模块回退。
- `qzvm.js` `interp_fn_value`：从 bindInterp 表取同名绑定，用 `ret()` 包装 tagged 值；
  对象/函数经 hostOf 缓存 → 跨 wasm/interp 身份与 Map 键统一。按名缓存句柄。
- `emitter.js`/`tagged.js`：只触碰 host-backed 绑定的模块级表达式语句，
  wasm `__module_init` 不再发射（按语句文本键匹配），由 interp 侧单独执行 → 初值/副作用不双执行。
- 回归：`test_ss_module_bindings.js`（单源身份/Map/单次执行）+ `test_interp_shared_clash.js`
  （let 冲突仍回退）；`test_aot` ALL PASS；47 corpus 0 diff。

## 实测结果

zod 125 文件：编译 125/125；函数 20945，wasm **20845（99.5%）** / interp 100；
整模块 interp **37 → 4**（仅 v3 module-suspend 67）；shared-state 归因归零。
身份探针：`interp(wasm cfg) === cfg` 由 false → true；Map.get 由 undefined → 7；
模块级副作用计数由 2 → 1。

## 成本/收益

- 收益：AOT 覆盖 28.9% → 99.5%；消除 dual-state 静默错值与初值双执行。
- 成本：4 个核心文件 + 1 个回归测试；工程量约 1 天 [INFERENCE]；风险集中在
  reentrancy/回写——当前 host-backed 只读语义下不做回写，写入仍由 shared object 本身承载。
- 未做：v3 module-suspend（4 文件，67 函数）；zod 运行时 perf 未单独测量。


## Timeline

- time: 2026-11-13T22:28:21
  kind: decision
  summary: "Created this page: AOT：wasm 与 interp 共享模块状态的三条路 + 决定（只在无状态模块翻转）"
  source: session 2026-11-13
  affects: [aot-shared-state-clash-design]

- time: 2026-11-16T18:10:48
  kind: decision
  summary: "shared-state 的三条路 + 2026-11-16 现状：只读 const 是剩余瓶颈"
  source: session 2026-11-16
  affects: [aot-shared-state-clash-design]

- time: 2026-11-17T16:40:17
  kind: decision
  summary: "2026-11-17 裁决：维持路径 1（clash 即整模块回退），不启动 single-source-of-truth"
  source: session 2026-11-17
  affects: [aot-shared-state-clash-design]

- time: 2026-11-17T16:40:17
  kind: decision
  summary: "用户裁决：维持 (a) clash 整模块回退；(b) 身份/副作用实测证伪；(c) 收益 28.9%→99.5% 上限但本轮不投入"
  source: session 2026-11-17
  affects: [aot-shared-state-clash-design]

- time: 2026-11-17T16:49:46
  kind: reversal
  summary: "用户改为启动 (c) single-source-of-truth：先做通用模块绑定宿主转发；原 (a) 决定被反转"
  source: session 2026-11-17
  affects: [aot-shared-state-clash-design]

- time: 2026-11-17T17:36:04
  kind: decision
  summary: "2026-11-17：路径 (c) single-source 已落地，clash const 提升 host-backed；zod wasm 99.5%"
  source: session 2026-11-17
  affects: [aot-shared-state-clash-design]

- time: 2026-11-17T17:36:04
  kind: decision
  summary: "(c) single-source 落地：clash const host-backed + 模块语句单侧执行；zod wasm 28.9%→99.5%，整模块 interp 37→4"
  source: session 2026-11-17
  affects: [aot-shared-state-clash-design]
