# TS→js+wasm 切分器设计

## 目标

输入：一份 TS 源码（含主逻辑 + 函数集）
输出：
- `out.as.ts` — AS 兼容函数集（数值/控制流，语法转换后）
- `out.js` — JS 函数（不兼容）+ 主逻辑（调 glue）
- `glue.js` — WebAssembly 桥（instantiate + import 对象 + {aot} 路径）
- `out.wasm` / `out.aot` — asc + wamrc 产物

在 qzjs 内端到端跑通（AOT 路径），数值函数获 50-68x 加速，I/O/对象走 JS 解释器。

## Pipeline

```
TS 源码
  │
  ├─[1 parse] tsc API → AST + 类型信息（getTypeAtLocation）
  │
  ├─[2 compat_check] 每函数机械判 AS 兼容 → 兼容标记
  │
  ├─[3 closure_analysis] 图遍历调用闭集 → AS 集 / JS 集（稳定）
  │     AS 函数 A 调 B：B 兼容→B 入 AS 集；B 不兼容→A 降级 JS
  │
  ├─[4 as_codegen] AS 集 → .as.ts（语法转换：number→i32 等）
  │
  ├─[5 asc] → .wasm
  │
  ├─[6 wamrc] → .aot
  │
  ├─[7 scan_wasm] wabt 解析 import/export 段
  │
  ├─[8 glue_codegen] → glue.js（base64 embed wasm+aot + import 对象 + {aot} options）
  │
  └─[9 js_codegen] JS 集 + 主逻辑 → out.js（调 glue 的导出）
```

## AS 兼容判据（机械，逐函数检查）

**类型要求**（参数 + 返回）：
- ✅ `number` / `boolean` / `void`
- ❌ `any`（含 any 传播：`any + number = any`）
- ❌ `string`（AS string 语义不同，留 JS）
- ❌ `union`（`A | null`）、`interface`、`class` 类型、泛型、`keyof`

**语法节点**（AST 检查，出现即不兼容）：
- ❌ 对象字面量 `{...}`
- ❌ 数组字面量 `[...]`（AS 需 `new Array<T>()`）
- ❌ 字符串拼接 `+`（任一操作数 string）、模板字符串 `` `...` ``
- ❌ string 方法（`.charAt/.slice/.split/...`）
- ❌ `try/catch`、`throw`
- ❌ 闭包（函数返回函数 / 回调参数 / 箭头函数作参数）
- ❌ `async/await`、生成器、`for...of`/`for...in`
- ❌ `reduce/map/filter/forEach/sort`（数组方法回调）
- ❌ `console.*` / DOM / WinterTC API 调用（除非已 `@external` 声明）
- ❌ `class` 声明、`interface`、`enum`
- ✅ `Math.floor/ceil/sqrt/...`（AS stdlib 已有，类型 f64）

**调用闭集**：调用的函数必须在 AS 集（或 `@external` 声明）。

## 闭集分析

```
worklist = 顶层调用的函数（main 逻辑直接调的）
as_set = {}
while worklist 非空:
  f = pop
  if f 已标记: continue
  if f 兼容 AND f 调用的所有函数 ∈ as_set ∪ extern:
    as_set.add(f); 被调函数入 worklist
  else:
    f 标记 JS（不 AS 化）
迭代直到稳定（可能多轮：后降级的使前 AS 化的失效）
```

**降级传播**：A 已 AS 化，后 发现 A 调的 B 不兼容 → A 降级 JS → 调 A 的也重评估。

## 语法转换（AS 函数 → .as.ts）

| TS | AS | 说明 |
|----|-----|------|
| `number`（参数/返回） | `i32`（默认）/ `i64`（值超 i32）/ `f64`（浮点用法） | 见 number 映射策略 |
| `boolean` | `bool` | |
| `void` | `void` | |
| `number[]` | `Array<i32>` | |
| `number[][]` | `Array<Array<i32>>` | |
| `[]` 字面量 | `new Array<T>()` 或 `Array.create(n, 0)` | |
| `let x = 0` | `let x: i32 = 0` | 显式类型 |
| `Math.floor(x)` | `Math.floor(x)` | AS stdlib（f64） |
| `a % b` | `a % b` | AS 支持 |
| `!==` / `===` | `!==` / `===` | AS 支持（类型特化后同语义） |
| 数字字面量 | 同 | |

## glue.js 生成

```js
const bytes = Uint8Array.from(atob("WASM_BASE64"), c => c.charCodeAt(0));
const aot   = Uint8Array.from(atob("AOT_BASE64"),   c => c.charCodeAt(0));
WebAssembly.instantiate(bytes, IMPORTS, {aot: aot}).then(({instance}) => {
  const __aot = instance.exports;     // AS 函数导出
  // 用户主逻辑（从 out.js 注入，调 __aot.fibSum(...) 等）
  MAIN_LOGIC
});
```

**import 对象**（从 wasm import 段生成）：
- AS 函数 `@external("env","log")` → `{env: {log: (n)=>console.log(n)}}`
- 若切分策略"对象留 JS"严格执行，AS 函数无对象 import → import 极少（通常只有 log 之类）

**MAIN_LOGIC**：原 TS 的顶层语句，把对 AS 函数的调用替换为 `__aot.fn(...)`，其余 JS 原样。

## number 类型映射策略（分叉，需确认）

AS 无 `number` 泛化，必须选 i32/i64/f64。三个选项：

|策略|规则|代价|
|---|---|---|
|**A 默认 i32**|所有 number→i32（fib/sum/gcd 级够用）|溢出 i32 范围（>2.1e9）错|
|**B 值范围推断**|扫字面量/运算推断（大数→i64，浮点→f64）|推断复杂，可能误判|
|**C 用户标注**|要求 `number` 注解为 `i32`/`i64`/`f64`（`n: i32`）|用户负担，但最准|

**推荐 A（默认 i32）** + 超范围告警——多数算法 i32 够，简单。大数场景用户改标注（C 兜底）。

注意 qzjs ext_wamr 不支持 BigInt i64 参数 → i64 的 wasm 导出经 JS 调用会失败。**i32 是 qzjs 内 wasm 路线的硬约束**（除非修 ext_wamr）。这强化选 A（i32）。

## 工具选择（分叉，需确认）

|工具|类型推断|AST|工作量|推荐|
|---|---|---|---|---|
|**tsc API**（typescript 包）|✅ 完整（any 传播、`obj.value` 推断）|✅|setup 重|✅ 推荐（判据准）|
|swc|❌ 仅注解|✅|轻|❌ 推断弱|
|自写（类 ts2c.py）|手动|可控|大|❌ 重复造轮子|

**推荐 tsc API**：AS 兼容判据需要类型推断（any 传播、未注解变量），tsc checker 完整提供。

## 边界/限制

1. **i32 硬约束**：qzjs ext_wamr 不支持 BigInt i64 → wasm 导出参数/返回限 i32（修 ext_wamr 可解锁 i64）。
2. **对象/string 强制留 JS**：wasm AOT 对象负载 7.4x 税不可接受 → 切分器判据强制。
3. **AS 子集**：AS 是 TS 子集，切分器只处理"纯数值+控制流"函数，业务/I/O 代码全留 JS。
4. **常量折叠陷阱**：bench 负载参数须随循环变化（切分器生成的 bench 代码要注意，或用户负责）。
5. **`_start` 非 wasm start section**：glue 须显式调 `__aot._start()`（若 AS 有顶层代码）。

## 工作量评估

|模块|天数|
|---|---|
|parser（tsc API setup + AST 遍历）|1|
|compat_checker|1|
|closure_analysis|0.5|
|as_codegen（语法转换）|1|
|glue_codegen + scan_wasm|0.5|
|js_codegen|0.5|
|builder（asc/wamrc 编排）|0.5|
|测试调试（algo/mixed 样例）|1-2|
|**总**|**~6-7 天**|

## 分叉汇总（需用户裁决）

1. **解析工具**：tsc API（推荐）vs swc vs 自写
2. **类型要求**：要求用户标注 vs tsc 推断（推荐推断，兼容未注解代码）
3. **number 映射**：默认 i32（推荐，qzjs i64 硬约束）vs 推断 vs 用户标注
4. **不兼容函数被 AS 函数调用时**：降级调用方为 JS（推荐，简单）vs 改被调为 @external 桥接（复杂，引入对象跨边界）
