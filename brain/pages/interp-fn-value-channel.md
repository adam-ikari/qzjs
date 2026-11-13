---
id: interp-fn-value-channel
title: "interp 函数作一等值通道（设计决定）"
category: concept
status: draft
tags: [aot, interp, design]
created: "2026-11-13T20:58:55"
updated: "2026-11-13T20:59:17"
---

<!-- compiled_truth -->
# 设计：interp 函数作一等值通道

**状态**：已在 903e2e49（通道）+ 79846e53（模块级挂起闭包 hoist）落地并通过探针/三验。本文档为该实现的设计决定，供审阅；审阅后如需修订按文档对齐。

## 1. closure 句柄结构
复用既有 **HOST 句柄** 0x7FFD|低32=handles 索引（非新 tag、无新 cell 布局、未动 guest_entry.c 的 closure cell/帧）。handles[idx] = interpJs 副本里的裸 JS 函数。identity：interp_fn_value 与 fn_value 共用 fnCacheMap（同名 → 同一句柄）。

## 2. 宿主蹦床调用约定
无显式蹦床——HOST 句柄即函数本身。closure_call 既有 HOST 分支（qzvm.js:519）已做转换：toJS(a0..a3) 过滤空实参 + 溢出数组 exA，hf.apply(selfArg, args)，ret(结果)。interp 函数参数/返回是裸 JS（与 interpJs 求值路径一致），体内不再 bitsOf/toJS。

## 3. interpJs 按名取 fn 表
模块加载时 new Function(interpJs + "return {name: typeof name==='function'?name:undefined}") 求值，名字集 = funcMeta.mode==='interp' ∪ modInterpBindings。经 qz.bindInterp(map) 注入（interpFns）。**必须早于 bindClasses**（其触发 __module_init，__module_init 里 `const g = af` 调 interp_fn_value）。

## 4. qz.interp_fn_value 原语签名
`(nameStrId: i32) → i64`（consts.js QZ 表：{params:["i32"],results:["i64"]}）。interpFns[strings[sid]] 非函数 → throwValue + TAG；否则 tagHandle(fn) 缓存在 fnCacheMap。

## 5. 与现有按名直调路径的兼容边界
- fn_value（wasm 函数作值）：不变，仅当 _funcIdx[name]!==undefined。
- 按名直调（af()）：不变（_emitClosureCall / 直接 _funcIdx call 路径未动）。
- interp_fn_value 只在 ①值位置读 fnNames 名且 _funcIdx undefined（_emitCapturedRead/_emitVarGet）②modInterpBindings 初值（_emitBindingDecl）两处发射。附录证明：emitter.js 仅增分支、_collectLambdas 增 skip 守卫；fn_value/_emitClosureCall 未改。
- 同名恒等同句柄；wasm 与 interp 同名不共存（一名一态）。

## 6. 逃逸边界（整模块仍退 interp）
- 类体/字段初值里 async/generator 方法：通道不覆盖（非模块级 const 绑定）→ 仍触发 hasSuspendOutsideFn → 整模块 interp。经典/schemas 对象字面量 async 方法同此。
- shared-state clash：既有检查（compile-ts ~712）在 interpSet 顶层函数触碰可变 modVars 且 wasm 侧共用 → 整模块 interp。
- **已知开放项**：modInterpBindings 目前绕过 clash 检查——绑定读 wasm 侧可变模块变量时无逃逸保护（漂移风险），运行期需处理；未影响编译期正确性判定。

## 探针三断言（对应边界 2）
return af / const g=af;g() / take(g) 三种形态：fnidx 语义（closure_call HOST 分支）+ shared-state 行为 + 既有直调路径不变。7/7 通过 + 全 corpus sweep 0 diff（直调不回归）。


## Timeline

- time: 2026-11-13T20:58:55
  kind: decision
  summary: "Created this page: interp 函数作一等值通道（设计决定）"
  source: "用户裁决 2026-11-13：设计先行审阅"
  affects: [interp-fn-value-channel]

- time: 2026-11-13T20:59:17
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "实测实现 903e2e49 + 79846e53；用户裁决：设计先行审阅"
  affects: [interp-fn-value-channel]
