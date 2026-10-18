---
id: aot-bigint-tagged-backend
title: "AOT BigInt tagged 后端：BIG_HI 句柄 + 双 BIG 前置路由 + canonical NaN 排除"
category: decision
status: active
tags: [aot, wasm, bigint, qzvm, emitter]
created: "2026-10-18T02:26:43"
updated: "2026-10-18T02:41:17"
---

<!-- compiled_truth -->
# AOT BigInt tagged 后端（批 39，2026-10-18）

## 表示
- 新 tag **`BIG_HI = 0x7FF8`**：`0x7FF8|低32=handles 槽`，`handles[槽] = 真实 JS BigInt`。qzvm.js 侧 `isBigH` / `toJS`（BIG→BigInt）/ `ret`（裸 BigInt→BIG 句柄）三个口。
- 字面量：`10n/0xffn/1_000n` → `qz.bigint_lit(sid)`（strings 表，去 `_` / 尾 `n`）。BigInt(string) 自解十六进制。
- **canonical NaN 硬约束（批 38 回归教训）**：`0x7FF8|0` 恰为 `box(NaN)` 位型。`handles` 固定首槽 `[undefined,null]` → BIG 槽位恒 ≥2（低32≠0），且 `_emitIsBig`/`isBigH`/`typeof` 三处一律带 `低32≠0` 判定。漏判会导致 `parseInt("99",8)=NaN` 之类真 NaN 经 toJS 被误读成 `handles[0]=undefined`（corpus38 `json-undefined-nan`、`number-tostring-precision` 双双变空串）。

## 路由（emitter.js）
- `_emitBinOp` 双目（+ - * / %，=== !== == != < <= > >=）：**双 BIG 运行时前置路由** → `qz.bigint_binop(opId, a, b)`（opId 0..10）；非双 BIG 落原 guard。`==/!=` 与 `===/!==
` 对两 BigInt 同义 → 共用 opId 5/6。复合赋值 `a += 2n` 经同一路径。
- 一元负号：BIG → `bigint_binop(1, 0n, x)`（临时槽存 0n 句柄，注意 call 参数序 op 在前）；其余原 `qz.neg`/f64Neg。
- `typeof`：`0x7FF8|低32≠0 → "bigint"`（插在 string 分支后、object 组前）。
- `method_call`：BIG 接收者 → `toString([radix])` / `valueOf`，其余 TypeError。
- BIG **不入** `_emitIsHandle`（宿主通用 qz.* 运算不认识 BIG，不能让它们走兜底）。

## 已知限制（有意搁置，非缺陷）
- BIG×number 混合算术：JS 应 TypeError，现走 f64 快路径得垃圾值。
- `BigInt(x)` 构造器未入 `BUILTIN_FNS`；`&`/`|`/`<<` 等位运算、一元 `+`/`~` 未路由。

## 验证
- 批 39 语料 7 例 7/7（audit_corpus39.js）；全量 857/862（99.4%，余 5 均既有已知：generator/async/class-expression-names/fromentries/prototype-chain）；ctest 32/32 零回归。


## Timeline

- time: 2026-10-18T02:26:43
  kind: decision
  summary: "Created this page: AOT BigInt tagged 后端：BIG_HI 句柄 + 双 BIG 前置路由 + canonical NaN 排除"
  source: session-work
  affects: [aot-bigint-tagged-backend]

- time: 2026-10-18T02:26:59
  kind: decision
  summary: "BigInt 进 tagged 后端：BIG_HI=0x7FF8 句柄（槽位从 2 起、低32≠0 判定），双目/一元负号前置路由 qz.bigint_binop，typeof/method_call/toJS/ret 四口互通；canonical NaN 排除是硬约束"
  source: batch-39
  affects: [aot-bigint-tagged-backend]

- time: 2026-10-18T02:27:13
  kind: decision
  summary: "BigInt tagged 后端落地（批 39）：BIG_HI=0x7FF8 三处低32≠0 判定排 canonical NaN；双 BIG 前置路由 qz.bigint_binop；857/862"
  affects: [aot-bigint-tagged-backend, aot-wasm-tagged-backend]

- time: 2026-10-18T02:41:17
  kind: decision
  summary: "门面收尾（批 40）：BIG 入 _emitIsHandle → 混合走宿主原生 JS 语义（TypeError/宽松==精确）；位运算/~/pow BIG 分支去截断；bigint_binop op 11~17；+ 三路拼接；BigInt() ctor 零改动即通；865/870"
  source: batch-40
  affects: [aot-bigint-tagged-backend]
