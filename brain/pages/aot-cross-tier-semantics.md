---
id: aot-cross-tier-semantics
title: "AOT 跨档语义一致性：闭包/数组/动态类的两档对齐"
category: decision
status: active
created: "2026-10-19T18:41:21"
updated: "2026-10-20T12:56:07"
---

<!-- compiled_truth -->
## 结论

AOT 两档（in-module = C 侧 libqzvm；独立档 = JS 宿主 qzvm.js）必须**语义等价**，差异只允许在「实现载体」。判据是 `audit_corpus*.js` 的 wasm-vs-js 输出对比：**任何 diff 都是缺陷**，除非是 loud 报错（显式抛错）。静默错值不可接受。

## 本轮修的静默错值类别

1. **闭包值（0x7FFF）不是 JS 对象** → 属性读写 / `new` / `instanceof` 全失效。C 侧曾让 `qz_tojs(0x7FFF)` 返回 undefined，`ctor.prototype.m = f` 于是静默写坏线性内存。
2. **数组句柄（0x7FFB）在 C 侧 `qz_tojs` 无映射** → `a.join()` / `indexOf` 收到 undefined 实参，内建静默返回 +0。

## 硬约束（推导得出，非风格选择）

- **C 侧不能把 wasm 闭包物化成 JS 函数**。QuickJS 在 wasm 内运行，JS 回调再进 wasm 蹦床会 "null function or function signature mismatch"（栈/表上下文破坏）。闭包调用统一走 `closure_call` 的 `call_indirect`。
- 数组高阶方法（map/filter/reduce/find/some/every/forEach/findIndex）在 C 侧**必须自己遍历**，回调经 `closure_call` 派发，实参与结果全程 tagged。交给 JS 内建 = 静默错值。
- 数组原地变异（reverse/sort/splice/push/pop/shift/unshift/fill/copyWithin）改的是 JS 侧副本 → **必须写回 wasm 内存**。独立档靠 `arrOf` WeakMap 保持别名；C 侧靠「句柄 → JS 数组」缓存 + 写回。
- 声明式类的动态 extends 用 `class_value_dyn` **就地**改写 `classMeta.parent`：紧随其后的 `super()` 按 clsId 查父构造器，返回克隆 id 会查不到。工厂式类表达式（`class_expr_value`）相反——每次求值必须克隆出新 clsId，否则 `new A() instanceof B` 误判。
- emitter 给部分方法名加 in-module 特化后缀（`"reduce$i"`）。C 侧 strcmp 前必须按 `$` 截断，否则整段回调路径被跳过。


## Timeline

- time: 2026-10-19T18:41:21
  kind: decision
  summary: "Created this page: AOT 跨档语义一致性：闭包/数组/动态类的两档对齐"
  source: created via brain create-page
  affects: [aot-cross-tier-semantics]

- time: 2026-10-19T18:41:58
  kind: decision
  summary: "两档语义必须等价；闭包不可物化、数组方法 C 侧自派发并写回、动态类父链就地改写"
  source: brain update-truth
  affects: [aot-cross-tier-semantics]

- time: 2026-10-19T23:27:44
  kind: note
  summary: "已知静默错值缺口：类表达式的类方法捕获外层**局部**变量（get label(){return lab}）两档都返回 undefined——类 env 建立时机依赖 statics guard/class_value，局部变量捕获未覆盖。改动前后一致，非本轮回归。loud 化需重构 statics 键。"
  affects: [aot-cross-tier-semantics]

- time: 2026-10-20T12:56:07
  kind: decision
  summary: "差分审计引入 unsupported 登记：corpus 条目标 unsupported 后，AOT 必须 loud 报错才算通过（静默错值仍判失败，已用返回 42 的桩验证）。当前登记 3 项固有未实现：generator-function（yield→状态机）、async-function（需 Promise/微任务）、object-fromentries-iter（generator 参与迭代）。AOT 侧无协程/微任务基础设施，属 P2 级工程，不在当前路线。"
  source: "src/qzvm/aot/audit_diff.js:52-57 + audit_corpus7/38 标注"
  affects: [aot-cross-tier-semantics]
