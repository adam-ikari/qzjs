---
id: aot-class-method-arguments-provider
title: "AOT 类方法 arguments provider：只有静态直调点能给实参个数"
category: decision
status: active
tags: [aot, arguments, class, abi]
created: "2026-11-06T01:12:13"
updated: "2026-11-06T01:39:09"
---

<!-- compiled_truth -->
## 结论

类方法/静态方法体内的 `arguments` **由静态直调点在产物 wasm 里提供**，不改 ABI。此前它是登记过的缺口（callee 无 provider → loud），根因是两条硬事实：

1. 方法调用 ABI 是 `qz.method_call(recv, mid, a0..a3, ovf)`，未用槽位以 undefined 句柄补齐 ⇒ 宿主 `givenSlot` **分不清「补占位」与「显式 undefined」** ⇒ 实参个数在 ABI 层面不可得。
2. in-module 档与产物是**单向导入**（libqzvm 先实例化，产物 import `qz.*`）⇒ C 宿主既不能给方法加参数，也不能写产物的全局 `__args`。加参数须改每个 `__m_C$m` / `__sm_C$m` / ctor / class-method trampoline 的函数类型，而 `call_indirect` 要求表项类型一致 ⇒ 逐方法变类型直接撞表。

裁决：**provider 建在发射的 wasm 里**——直调点把全量实参构造成数组写进产物全局 `__args`，callee 入口读入专属本地。两档跑同一段 wasm ⇒ 档间等价由构造成立，不靠宿主对齐（这是本裁决相对「宿主补 n 参数」方案（B/B′）的决定性优势：后者要改两侧宿主 + C 侧 ~9 个调用点 + 表 ABI）。

同一裁决随后也用于顶层函数直调点（见「实参只求值一次」）。

## 语义根据

类体恒严格模式 ⇒ 方法的 `arguments` 是**非映射**对象：只有 `length`/下标/迭代，与形参无联动；默认值与解构形参不进入数组。⇒ 用「调用点全量实参数组」承载即等价（逐条对齐 V8：`length`、越界读 undefined、`for-of`、>4 实参、继承 owner 的直调、`this` 兄弟派发、静态方法、箭头经 env 捕获）。

## 硬约束

- **实参只求值一次**：provider **先**发射数组字面量到本地，**再**从数组回读值槽（`_emitElemOf` 越界 → undefined，与补占位等价）。反序（先发槽、再重发一遍数组）会让参数副作用执行两次——静默错。类方法侧 `argswork.ts:argsEvalOnce`、函数侧 `audit_corpus46.js` 钉住这条；顶层函数曾犯此错，已按同形修好（`fn-args-*` 7 例 + 跨档 `fnArgs*` 3 例）。
- **rest 收尾形参的 rest 段必须是新数组**：对全量数组 `slice(nFix)` 取得，**不与 `arguments` 同句柄**——JS 里 `function f(a, ...r)` 的 `arguments === r` 恒 false。`argswork.ts:fnArgsRestDistinct` 钉住。
- **消费即清**（类方法）：callee 读走 `__args` 后立即把全局清回 0，否则残留会喂给下一个无 provider 的 callee（静默错值）。
- **哨兵 loud**（类方法）：callee 入口读到 0 → `unreachable`。宁可 trap，绝不静默给错值。顶层函数路径沿用旧约定（复制全局→本地，不清不 trap），是遗留面。
- **`this.m()` 形态只在叶子类可直调**（`_leafClasses`），内联 `new C().m(…)` 与 `const c = new C()` 走静态接收者判定（`_staticRecvClass`）。
- **拒绝按方法名、编译期生效**（比运行期 trap 早，且两档同消息）：宿主动态派发、成员取成值再调用（`closure_call`/`call_value`）、展开实参调用、`: void` 方法（退动态派发）、对象字面量 super 派发、动态父类下 super 派发；构造器与访问器内 `arguments` 无 provider；rest 形参或 >4 形参与 `arguments` 混用（rest 打包尾部实参、>4 形参的溢出实参只经 `$ovf` ⇒ 无逐槽值可读）。按名拒绝是保守的：同名数据成员也会被拒。
- **箭头继承**：`arguments` 作为可捕获名种进 env（`qz.env_def`），env 播种的特殊分支必须排在通用「局部名」分支之前，否则写进 env 的是 undefined。

## 验证面

`src/qzvm/aot/argswork.ts` 16 例经 `test/m6b-poc/e2e_cross_tier.mjs` 跨档对比（两档逐位相同，含 eval-once 与 rest 独立性探针）；`audit_corpus44.js` 11 例支持形状 + 8 例必须 loud、`audit_corpus46.js` 7 例（函数侧 eval-once + 对照组）同时过 `audit_diff`（V8 oracle）与 `glue_audit`。相关：[[aot-cross-tier-semantics]]、[[aot-wasm-tagged-backend]]、[[aot-sort-deterministic-merge]]。

## 欠账（仍开放）

- **C 档闭包 `arguments`**：`__args` 在闭包调用时只由独立档宿主写（`lamMeta.needsArgs` → `closure_call` 层），C 宿主写不了产物全局 ⇒ 闭包内 `arguments` 在 in-module 档不可靠。同一单向导入约束，解法方向与本页一致（把写入点移进产物）。
- **顶层函数路径不消费即清、不哨兵 trap**：无 provider 的调用点（如实参含展开）会读到上一个调用留下的 `__args` 残留。类方法侧已改成清 + trap；函数侧待同样收口。


## Timeline

- time: 2026-11-06T01:12:13
  kind: decision
  summary: "Created this page: AOT 类方法 arguments provider：只有静态直调点能给实参个数"
  source: "类方法内 arguments provider 批次（两档一致）"
  affects: [aot-class-method-arguments-provider]

- time: 2026-11-06T01:12:31
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "emit/{emitter.js,tagged.js} + audit_corpus44.js + argswork.ts"
  affects: [aot-class-method-arguments-provider]

- time: 2026-11-06T01:33:03
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "emit/{emitter.js,tagged.js} + audit_corpus44/46.js + argswork.ts"
  affects: [aot-class-method-arguments-provider]

- time: 2026-11-06T01:39:09
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "错字订正（调用量→调用点）"
  affects: [aot-class-method-arguments-provider]
