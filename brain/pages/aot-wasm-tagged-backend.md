---
id: aot-wasm-tagged-backend
title: "AOT tagged 后端（emitter.js→wasm）：热路径零宿主跨界原则"
category: decision
status: active
tags: [aot, wasm, emitter, qzvm, perf]
created: "2026-10-12T15:51:52"
updated: "2026-10-13T06:23:06"
---

<!-- compiled_truth -->
# AOT tagged 后端（emitter.js → wasm）

`src/qzvm/aot/emitter.js` 把 TS 子集编译为 wasm（tagged 值 = NaN-box i64，高 16 位 tag）。
`qzvm.js` 是宿主运行时（JS import，`qz.*`）。区分两类通道：

## 原则：热路径零宿主跨界

宿主 import（`qz.*`，JS 实现）每次调用 = JS↔wasm 跨界 + BigInt/句柄装箱，成本高。
**凡能在 wasm 内联完成的操作用力内联，宿主只留不可内联者**（字符串 UTF-8 语义、动态分派兜底）。

已内联（零跨界）：
- **POJO 字面量** `{x:v}`：bump 分配 + `i64.store` 字段。
- **数组字面量**：header(16B)+data 块，句柄稳定。
- **类实例分配** `new C()`：`_emitNewCall` 内联 bump（`off=(bump+7)&~7`，写 `[off]=clsId`），
  句柄 `0x7ff9<<48 | off`。**原走 `qz.newobj` 宿主 → 构造热路径 ~73x 慢**（clsbench 50000×:
  34.4ms → 0.47ms）。`qz.newobj` 已删（死代码）。
- **类方法调用**：静态可判 owner 时直调 `__m_<C>$<m>`（LLVM O3 可内联），
  仅不可判时走 `qz.method_call`（动态派发 212x 慢）。

仍走宿主（不可内联）：字符串方法（UTF-8/UTF-16 语义）、`qz.method_call` 兜底、
数组 push 增长（`qz.alloc` 裸偏移）。

## 判定与验证

- 局部槽布局随内联新增而变化：`emitFunc`/lambda/`_mEnter` **三处**同步追加 wasm local 声明
  （`startBody` 的 types 数组），漏一处则槽号错位。
- 回归门：`src/qzvm/aot/test_aot.js`（node WebAssembly 直跑，无需 wamrc）。
- 性能门：`clsbench.ts`（new/方法分派）经 `build.js` + qzjs 跑。


## Timeline

- time: 2026-10-12T15:51:52
  kind: decision
  summary: "Created this page: AOT tagged 后端（emitter.js→wasm）：热路径零宿主跨界原则"
  source: "会话：修构造开销 + 字段自增"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-12T15:51:58
  kind: decision
  summary: "AOT tagged 后端：热路径零宿主跨界（分配/分派内联 wasm）"
  source: "会话 2026-10-12"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-13T06:23:06
  kind: note
  summary: "交叉引用：数值表示维持 f64 NaN-box（num 快路径已是裸 f64，非 NaN-box）；原生整数 i32/i64 实测仅快 12-18%，被精度/语义/32位三约束否决。性能模型记入 aot-performance-model。最大杠杆 = qz.* import 从 JS 函数改 WAMR raw native（跨界税 4.9µs→45ns）。"
  source: "讨论 2026-13"
  affects: [aot-wasm-tagged-backend]
