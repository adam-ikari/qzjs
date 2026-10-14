---
id: aot-generic-compiler-target
title: "AOT TS→wasm 是通用编译目标：import 面由 TS 源码决定，不绑定 qzjs"
category: decision
status: active
tags: [decision, aot, wasm, architecture, generic]
created: "2026-10-14T06:39:19"
updated: "2026-10-14T06:39:19"
---

<!-- compiled_truth -->
## 结论

**AOT 的 TS→wasm 是通用编译目标，不绑定 qzjs。**

wasm 模块的 **import 面完全由 TS 源码的 `import` 决定**：

- TS 里 import 的内容若**内联**（无外部 OS API 需求）→ 产物 wasm **零 import**，自包含。
- 若 import 外部能力 → 产物 wasm **只 import 那部分符号**（需求驱动的最小契约面）。

因此：**任何带 wasm 引擎、且能提供所需 import 符号的运行时，都能跑 TS 编译出的 wasm**。qzjs 只是"能提供这些符号的运行时之一"，不是唯一宿主。

## 推论（对设计的约束）

1. `qz.*`（AOT 值原语：`qz.add`/`qz.str_len`… f64 NaN-box）是**需求驱动的最小契约**，不是 qzjs 私有 ABI。命名/签名应视为**可复用的 wasm-host 接口面**。
2. in-module 的 `qz_host.*`（宿主能力 import）与 AOT 的 `qz.*`（值原语 import）是**两套独立 import**，各由需求决定；即使都含 `qz` 前缀也仅命名分区，语义不冲突（不同 import module 名）。
3. 通用工具定位 → 设计时**不假设** qzjs 专有特性；wasm 产物应能在裸 wasm 引擎 + 符号提供者上运行。

## 影响

- AOT 文档/README 若暗示"qzjs 专属编译器"，须更正为"通用 TS→wasm 编译器 + qzjs 为符号提供者之一"。
- `IN_MODULE_DESIGN.md` §10.6 应强调：`qz.*` 面是通用契约，未来可被第三方 wasm 宿主实现。


## Timeline

- time: 2026-10-14T06:39:19
  kind: decision
  summary: "Created this page: AOT TS→wasm 是通用编译目标：import 面由 TS 源码决定，不绑定 qzjs"
  source: "用户裁定 2026-10-14"
  affects: [aot-generic-compiler-target]

- time: 2026-10-14T06:39:19
  kind: decision
  summary: "TS→wasm 通用工具：import 面由 TS import 决定，零 OS 需求则零 import；任何能供符号的 wasm 运行时皆可运行"
  source: "用户裁定 2026-10-14"
  affects: [aot-generic-compiler-target]
