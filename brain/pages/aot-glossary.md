---
id: aot-glossary
title: "AOT 术语库（qzvm vs qzjs）"
category: reference
status: active
created: "2026-10-18T10:58:08"
updated: "2026-10-18T10:58:33"
---

<!-- compiled_truth -->
# AOT 术语库

区分 **qzvm**（JS 引擎）vs **qzjs**（完整运行时），避免内联绑定归属混淆。

## 核心区分

- **qzvm**：JS 引擎（`libqzvm.wasm`，guest）。含 QuickJS 字节码引擎 + `qz.*` 原语 + realm 生命周期。纯引擎核心，独立 wasm32 模块。
- **qzjs**：完整运行时。= qzvm + 宿主（host：`bridge.c`/`thread.c`/`io`/`control`）+ pal + libuv + 公开 JS API。**qzjs ⊃ qzvm**（qzvm 是 qzjs 的引擎子模块）。

## AOT 组件

- **emitter**：通用 TS→wasm 编译器（`emitter.js`）。产物 = wasm 原生代码模块，只声明标准 wasm import。**不绑定 qzjs（完整运行时）/qzvm**——任何 wasm 引擎可跑。
- **in-module 合并（M6b）**：把 emitter 产物 + `libqzvm.wasm`（qzvm）合并成单一 wasm 模块（= 扩展的 qzvm）。合并后 emitter 产物的标准 import 变 **qzvm 模块内调用**（字节码引擎↔wasm 原生代码内联绑定）。**这是 qzvm 引擎层行为，不是 qzjs 运行时层行为**。
- **M6b = qzvm 模块合并**（emitter 通用化为前提）。
- **emitter 通用化（M6b 前提）**：emitter 不绑定 qzjs/qzvm 专有特性，产物只带标准 wasm import。

## 内联绑定归属（关键纠正）

- 内联绑定对象 = **qzvm**（字节码引擎 QuickJS 在 qzvm 内）。
- in-module 合并 = emitter 产物 + qzvm 合并 = **qzvm 模块构建行为**，非「qzjs 运行时合并」。
- ❌ 错误框架：「in-module 合并是 qzjs 运行时侧行为」「M6b = qzjs 运行时合并」。
- ✓ 正确：qzvm 引擎层模块合并；emitter 不绑定 qzjs/qzvm（通用）。

## 对外边界（qzjs 运行时 = 正确用法）

- 「emitter 依赖 qzjs JS API」= 对外能力边界：wasm ↔ qzjs 运行时，标准 wasm import（JS 函数服务号）。这里 qzjs 运行时正确（对外 import 由宿主 qzjs 提供）。
- 区分：**对外**边界用 qzjs 运行时（import 由宿主提供，正确）；**对内** in-module 合并归 qzvm 引擎层（非 qzjs 运行时）。


## Timeline

- time: 2026-10-18T10:58:08
  kind: decision
  summary: "Created this page: AOT 术语库（qzvm vs qzjs）"
  source: "用户澄清：qzvm=JS引擎，qzjs=完整运行时"
  affects: [aot-glossary]

- time: 2026-10-18T10:58:33
  kind: decision
  summary: "区分 qzvm(JS引擎) vs qzjs(完整运行时)；内联绑定归 qzvm 引擎层"
  source: "用户澄清"
  affects: [aot-glossary]
