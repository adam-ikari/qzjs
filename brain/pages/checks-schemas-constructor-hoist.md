---
id: checks-schemas-constructor-hoist
title: "checks/schemas: $constructor 回调挂起 hoist 设计（this 绑定三选一）"
category: concept
status: draft
tags: [aot, design, this-binding]
created: "2026-11-13T21:28:29"
updated: "2026-11-13T21:28:49"
---

<!-- compiled_truth -->
# 设计：$constructor 回调挂起 hoist（this 绑定三选一）

**状态**：仅设计，不实现（用户明确）。核心待答：`inst` hoist 后如何保持身份。

## 问题形态（实测）
`export const X = core.$constructor("X", (inst, def) => { ... async/generator ... })`
—— 挂起在 **call 的箭头实参**体内，不是 const 绑闭包。modInterpBindings 现有检测「initializer IS arrow/fn-expr」不覆盖 call 表达式 initializer。

三个受阻文件实测（都是**单个** call 表达式 initializer 含挂起）：
- checks.ts: `$ZodCheckProperties`（1 个 call）
- core/schemas.ts: `$ZodType` + `$ZodFunction`（2 个 call）
- classic/schemas.ts: `ZodType`（1 个 call，527 函数全因它 module-suspend）
→ 三文件同形态；`$constructor` 本身是 `function $constructor(name, initializer, proto?, params?)`，initializer 类型 `(inst: T, def: D) => void`，**inst 是显式箭头参数，非 this**。

## 三选一（inst 身份）
**A. 闭包捕获（整表达式 hoist）** — 把整个 `core.$constructor(...)` call 表达式当 module-level 绑定，求值走 interp 副本（wasm 侧拿类的句柄）。`inst` 是箭头形参，嵌套挂起闭包自然捕获它，零额外约定。
- 优点：语义精确（inst 就是那个形参）；无 per-instance bind/传参改造；机制与 modInterpBindings 同构（只是把「闭包 initializer」扩到「call 表达式 initializer」）。
- 代价：整类走 interp（initializer + proto 方法都不编 wasm），该类方法 wasm 覆盖归零；wasm 侧访问该类实例须经句柄（object_get/closure_call）—— 跨边界对象语义需 E2E 验（同 shared-state 漂移所属类别）。

**B. 显式传参** — 每个挂起闭包 hoist 成 module-level interp fn `(inst, def, ...args)=>...`，调用点显式传 inst。
- 代价：闭包是**存在 inst 上**的（`inst._zod.run = closure`），调用时调用方没有 inst —— 无法在调用点传；须改用 per-instance 工厂 `(inst,def)=>closure` 再 bind。等于把问题推给工厂，且丢掉非挂起部分的 wasm 编译。

**C. 绑定对象** — `.bind(inst)`/`.bind(def)` 后经 interp_fn_value 发句柄。
- 代价：每实例一次 bound-function 分配；闭包整体 interp（与 A 相同覆盖损失），但保留了 initializer 其余非挂起部分可 wasm —— 这是相对 A 的唯一优势；复杂度最高。

## 取舍裁决（推荐 A）
选 **A**。理由：
1. `inst` 已是词法箭头形参 → 捕获天然精确，B 的「调用点传参」根本无处传（闭包存实例上），C 的 bind 是多余分配。
2. 挂起闭包本就只能 interp（有 suspend）；「整 $constructor 走 interp」与 modInterpBindings 同构，实现面最小（扩检测谓词，不改发射机制）。
3. A 的代价（该类方法 interp）在三文件上可接受：它们是最后 11 文件，正确性 > 覆盖；且 $constructor 类的实例本就 interp。

## 对 527 函数 classic/schemas 是否同一方案？
**是，同一方案 A**。实测 classic/schemas 仅 1 个 `$constructor` call（`ZodType`）是 module-suspend 源；处理它后，模块内其余 527 函数（非 ZodType 部分）应可翻 wasm。不是「散落 11 个对象字面量 async 方法」，而是「1 个 $constructor call 拖垮整模块」——与 checks/core-schemas 完全同构。
- 但 A 只把 `ZodType` 类本身走 interp；527 函数里若有跨 ZodType 实例的读写，须经句柄（已由 tagged object_get/closure_call 覆盖，待 E2E）。

## 待验证（实现前的闸门，非本轮）
1. 扩 modInterpBindings 检测到 call 表达式 initializer（谓词：initializer IS CallExpression 且任一实参含挂起闭包）→ 整表达式 interp。
2. wasm 侧访问 interp 实例（`schema._zod.run(...)`）经 object_get/closure_call 正确 —— 定向 E2E。
3. shared-state 漂移：$constructor 类的实例字段若 wasm/interp 双份 → 同 test_interp_shared_clash.js 的漂移风险，须同法覆盖。


## Timeline

- time: 2026-11-13T21:28:29
  kind: decision
  summary: "Created this page: checks/schemas: $constructor 回调挂起 hoist 设计（this 绑定三选一）"
  source: "用户裁决 2026-11-13：只做设计，不写实现"
  affects: [checks-schemas-constructor-hoist]

- time: 2026-11-13T21:28:49
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "实测扫描+核心问题分析 2026-11-13"
  affects: [checks-schemas-constructor-hoist]
