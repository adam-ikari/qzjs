---
id: aot-shared-state-clash-design
title: "AOT：wasm 与 interp 共享模块状态的三条路 + 决定（只在无状态模块翻转）"
category: decision
status: active
tags: [aot, interp, clash, design]
created: "2026-11-13T22:28:21"
updated: "2026-11-16T18:10:48"
---

<!-- compiled_truth -->
## 问题

interp 函数跑在 `new Function(interpJs)` 的独立 JS 副本；wasm 侧模块级绑定是 wasm 全局。
同一模块级绑定被两侧触碰 → 两份状态/两个值 → 静默错值。现行守卫：**整模块退 interp**
（把全部顶层函数 + `__module_init` 拉进 interpSet，wasm 侧不再承载函数 → 单域）。

## 三条路

1. **只在无状态模块翻转**（当前决定）：clash 即整模块回退。安全、简单。
   代价：任何被两侧触碰的模块级绑定都挡——**包括只读 `const`**（对象/函数/call 初值）。
2. **只读共享**：认为 `const` 两副本值等价，允许双域各自读。风险（未验证）：
   对象/函数身份跨域不等（`===`/Map 键可观察）、初值副作用双执行、导出面身份不统一。
3. **单一事实源**：interp 侧的模块级读/写经宿主转发到 wasm 全局（getters/setters），或反向。
   彻底无双份；工程大，需物化/回写与 reentrancy 语义。

## 2026-11-16 现状（决定仍为 1）

wasm→interp 直调通道（`interp_fn_value` + `call_value`）落地后，`calls`/`class-calls`
回退取消，但 zod 重测仍 37 个整模块 interp（wasm 28.9%）：
- 33 文件原因变为 `async-self`（只剩 `validateAsync`）+ `shared-state`；
- clash 变量是只读绑定：`version`（const 对象字面量）、`parse`/`parseAsync`/`decode`/`encode`
  （`const x = f(...)` 初值）、`ZodParsedType`（enum 对象）、`dateRegexSource`；
- 4 文件是 v3 的 `module-suspend`（模块级 async/generator），与本题无关。

→ **下一步要翻 schemas.ts 双版本，必须先裁决路径 2 或 3**，而不是继续做 async。
裁决前保持路径 1（宁可不翻，不可双份静默错值）。


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
