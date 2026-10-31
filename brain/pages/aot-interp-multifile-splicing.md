---
id: aot-interp-multifile-splicing
title: "AOT interp 多文件拼接：复用 prog1 AST + 私有重名改名 + 依赖拓扑序"
category: decision
status: active
tags: [aot, interp, typescript]
created: "2026-10-29T20:23:58"
updated: "2026-10-30T11:45:32"
---

<!-- compiled_truth -->
## 结论

interp 回退路径的 `interpJs` 把每个源文件的 tsc 产物拼进**同一个 JS 作用域**里求值。这个「单作用域拼接」决定了五条不可让步的约束，任一条破了都是编译期崩溃或运行期静默错值。

## 五条约束

1. **必须复用 prog1 的 SourceFile 对象**（自定义 CompilerHost 返回旧节点，不是重新解析）。
   `collectDecls` 会给匿名 `export default function(){}` 就地补合成名 `__default_N`，重解析丢掉合成名 → tsc transform 直接 `Debug Failure. False expression.`。且 import 改名依赖同一符号表。

2. **emit 前必须清 SourceFile 的模块标记**：`externalModuleIndicator` / `commonJsModuleIndicator` / `impliedNodeFormat` / `transformFlags` 的 `ContainsES2015Module`。
   只设 `module: None` 不够——NodeJs 解析会置 impliedNodeFormat，emit 仍走 CommonJS transform，产出 `exports.X = …` + `require("./x.js")`（实测 zod parse.ts 189 处 `exports.*`）。清掉后才是干净 ESM。

3. **各文件私有的同名顶层声明必须按文件改名**（`name$f<sfIdx>`）。
   实测 zod：61 个 locale 各有一份 `const error` → 拼接后 `Identifier 'error' has already been declared`。
   - 导出名不能改：宿主按原名取 interp 函数（`{ name: typeof name === "function" ? name : undefined }`）。
   - 同名「导出 + 私有」并存（api.ts 导出 `_emoji`，regexes.ts 私有 `_emoji`）时只改私有那份，两者本就是不同符号。
   - **坑**：tsc 对部分引用点（`return error();` 的调用位）不建符号绑定，`checker.getSymbolAtLocation` 返回 undefined。必须加「文件名 + 名字」兜底表，并排除属性名/声明名位置。

4. **拼接顺序必须依赖在前**（按 import 图 DFS 后序）。
   模块级 `const` 初值按拼接后出现顺序求值。zod `parse.ts` 的 `const parse = _parse($ZodRealError)` 依赖 `errors.ts` 的 `$ZodRealError` → 顺序错就是 `Cannot access '$ZodRealError' before initialization`（TDZ）。

5. **发射文件集 = 运行时导入闭包，不是 `program.getSourceFiles()`**（2026-10-30 补）。
   tsc 为类型检查把 `import type` 的传递依赖也收进 program；这些文件运行时被完全擦除。
   内联它们会污染名字域、把无关 async 拖进 interp 判定（zod `util.ts`：83 个 program 文件里
   运行时只依赖 2 个）。沿值导入 / 副作用导入 / 值 re-export 求闭包；`export type` 校验同步跳过。
   prog2 的 emit 也必须**逐运行时文件**调用——整 program emit 会把类型依赖重新拼回来。

## 验收

- zod 全量非测试文件 **125/125 编译通过**；函数 48639→21111（类型依赖剪枝后），
  整模块 interp 文件 115→38，wasm 函数占比 0%→28.6%（2026-10-30）。
- `test_aot.js` 门禁：多文件跨文件函数进 interpJs、多文件私有重名不撞车、依赖顺序 TDZ、
  类构造器调用 interp 函数、type-only 依赖不进发射集。


## Timeline

- time: 2026-10-29T20:23:58
  kind: decision
  summary: "Created this page: AOT interp 多文件拼接：复用 prog1 AST + 私有重名改名 + 依赖拓扑序"
  source: created via brain create-page
  affects: [aot-interp-multifile-splicing]

- time: 2026-10-29T20:24:04
  kind: decision
  summary: "interpJs 多文件拼接四条硬约束"
  source: "zod 全量 125/125 覆盖率修复"
  affects: [aot-interp-multifile-splicing]

- time: 2026-10-29T20:24:08
  kind: decision
  summary: "interpJs 拼接四条约束：复用 prog1 AST / 清模块标记 / 私有重名按文件改名 / 依赖拓扑序"
  affects: [aot-interp-multifile-splicing, aot-roadmap]

- time: 2026-10-30T11:45:32
  kind: decision
  summary: "补第五条：发射文件集 = 运行时导入闭包（类型依赖不得内联）"
  source: "2026-10-30 type-only 剪枝 + zod 实测"
  affects: [aot-interp-multifile-splicing]
