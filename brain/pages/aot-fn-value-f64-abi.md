---
id: aot-fn-value-f64-abi
title: "AOT num 函数作值：fn_value 第 4 参 f64 ABI + funcMode knownFns 白名单"
category: decision
status: active
tags: [aot, fn-value, abi, funcmode]
created: "2026-11-09T00:18:07"
updated: "2026-11-09T00:18:19"
---

<!-- compiled_truth -->
## 结论

num 模式顶层函数被**作值**引用（回调/别名/属性宿主/`const h = g`）时，两条机制必须配对，否则两崩：

1. **funcMode 白名单降级**：`funcMode` 里「标识符被调」只有当目标是**静态可知的 num 可直调者**（顶层函数名 + import 别名合成的 `knownFns` 白名单 / 内联零参箭头 / `Math.*` / num 数组 push）才算 num 安全；否则是**函数值调用**（走 `call_value`）→ 必退 tagged。此前不查 → num 路径按名发 `call <标识符>`，编译期硬崩「未定义变量 inc / call 未定义」。
2. **fn_value f64 ABI 选择**：num 目标作值时，宿主包装必须按 **f64 ABI** 调用导出（实参 `Number()` 强转、越界补 `NaN`、返回裸数由调用方 `ret` 装箱），与 tagged 位型进出分开。此前一律 tagged 装箱 → f64 导出收到 tagged 位型，宿主做 BigInt 转换报错。靠 `qz.fn_value` **第 4 参 `isNum = (funcMode === "num")`** 选择。二者（`_emitFnValue` 按 `fnMode.mode==="num"` 置 isNum，宿主按 isNum 分派）由**同一 funcMode 决断**，不会自相矛盾。

## 链路（伪）
- 编译侧 `layout.funcMode(f, argsFns, knownFns)`：
  - `knownFns` = 顶层函数名 ∪ import 别名指向的函数名（compile-ts 合成，set 到 `em._fnKnown`）。
  - `walk` 见 `call <标识符>` 且目标不在 `numArrs/inlineNames/knownFns` → `unsafe = true` → 该函数 tagged。
- 发射侧 `emitter._emitFnValue(name)`：`fn_value(sid, arity, hasThis, ci.mode === "num" ? 1 : 0)`。
- 宿主侧 `qzvm.fn_value(sid, arity, hasThis, isNum)`：`isNum && !hasThis` → f64 通道（`Number()` + 补 NaN + 返裸数）；否则 tagged（`bitsOf` + `toJS`）。

## 硬约束
- **`funcMode` 与 `fn_value` 共用同一 mode 决断**：改其一须同步——`_emitFnValue` 读 `fnMode.mode` 判 isNum，宿主按 isNum 分派；C 档按名查不到产物函数（单向导入）→ 原语设 TypeError，经 `_emitErrCheck` 转入 catch。
- **hasThis 例外**：带 TS `this` 形参的 num 函数作值，宿主仍走 tagged 通道（现 f64 分支排除 `hasThis`）；如未来需要，须另扩张。
- **回归门**：`test_aot.js` runTagged 尾部「fn值.*」三项钉住——别名调用(num)、作回调(num)、tagged 内引用 num。

## 语义根据
- 数值在宿主侧按**原始 f64 位型**存（`box = numToBits`，非 NaN-box 带 tag），`toJS` 按 tag 排除法落 `bitsToNum`。num 目标导出恒 f64 ABI，宿主侧只能按 f64 正确地传/收——这是第 4 参存在的根因。
- 函数作值本身非 num 安全表达式（`fn_value` 返回 tagged i64 句柄），故任何函数值引用都使外层退 tagged；本条只关乎 num 目标作值时的**宿主调用 ABI**。


## Timeline

- time: 2026-11-09T00:18:07
  kind: decision
  summary: "Created this page: AOT num 函数作值：fn_value 第 4 参 f64 ABI + funcMode knownFns 白名单"
  source: "本会话实测"
  affects: [aot-fn-value-f64-abi]

- time: 2026-11-09T00:18:19
  kind: decision
  summary: "num 函数作值两机制配对：funcMode knownFns 白名单降 tagged + fn_value 第 4 参 isNum 选 f64 ABI"
  source: emitter.js _emitFnValue / layout.js funcMode / qzvm.js fn_value
  affects: [aot-fn-value-f64-abi]
