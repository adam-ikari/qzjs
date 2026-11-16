# zod 整模块 interp 缺口排序（37 个，2026-11-16）
# corpus: 134 src + 198 test .ts；impact = ownFuncs × (tests + entries + deps + 1)

> 分析脚本：`src/qzvm/aot/interp_gaps.js`；数据日期 2026-11-16；corpus = zod src/v4+v3。
> **只排序+说明，不改代码。**

## 判据

- **自有函数**：该文件自身定义的函数数（FunctionDeclaration/MethodDeclaration/ArrowFunction，TS AST 计数，非传递闭包）。
- **拦截原因**：compileTS dbgInterp 归因——`module-suspend`（模块级 async/generator）、`shared-state`（模块级可变状态双侧触碰后整模块回退）、`async-self`（函数体 async/generator）。
- **直接依赖 / 影响入口 / 挡测试**：import 图与传递导入链的统计。
- **impact** = 自有函数 × (挡测试 + 影响入口 + 直接依赖 + 1)。

## 结论（2026-11-16 重测）

1. **shared-state 才是当前主约束**（33 文件）。wasm→interp 直调通道（`interp_fn_value` + `call_value`）
   落地后，`class-calls` 不再导致回退，也不再做 `calls` 传递闭包；每个文件只剩 1 个 `async-self`
   （`validateAsync`），随后双域守卫因**只读的模块级 `const`**（`version`、`parse`、`parseAsync`、
   `ZodParsedType`、`dateRegexSource` 等）判定 clash → 整模块回退。
2. **module-suspend 只剩 4 个文件**：`v3/types.ts`（×20）、`v3/helpers/parseUtil.ts`（×7）、
   `v3/external.ts`、`v3/index.ts`。它们是 v3 遗留线，impact 低（除 types.ts 排 7）。
3. **schemas.ts 双版本仍是最大收益**：v4/core/schemas.ts（304 函数，挡 25 测试）+ v4/classic/schemas.ts（413）。
   翻它们必须解决 shared-state 判定（只读绑定共享 / 单一事实源），不是 async。
4. **下一步杠杆**：shared-state 的「只读 const 绑定也算双域静态错值」判据——需要语义裁决
   （对象身份跨域可比性 / 初值副作用的双执行），见 brain [[aot-shared-state-clash-design]]。


| # | 模块 | 自有函数 | 拦截原因 | 直接依赖 | 影响入口 | 挡测试 | impact |
|---|------|---------|----------|---------|---------|--------|--------|
| 1 | v4/core/schemas.ts | 304 | async-self×1, shared-state×141 | 14 | 11 | 25 | 15504 |
| 2 | v4/classic/schemas.ts | 413 | async-self×1, shared-state×526 | 7 | 4 | 14 | 10738 |
| 3 | v4/core/api.ts | 141 | async-self×1, shared-state×260 | 1 | 11 | 25 | 5358 |
| 4 | v4/core/compile.ts | 127 | async-self×1, shared-state×223 | 5 | 11 | 25 | 5334 |
| 5 | v4/core/json-schema-processors.ts | 87 | async-self×1, shared-state×160 | 5 | 11 | 25 | 3654 |
| 6 | v4/mini/schemas.ts | 212 | async-self×1, shared-state×531 | 6 | 4 | 5 | 3392 |
| 7 | v3/types.ts | 336 | module-suspend×20 | 2 | 2 | 4 | 3024 |
| 8 | v4/classic/from-json-schema.ts | 30 | async-self×1, shared-state×543 | 2 | 4 | 13 | 600 |
| 9 | v4/classic/errors.ts | 13 | async-self×1, shared-state×429 | 2 | 4 | 14 | 273 |
| 10 | v4/core/visit.ts | 8 | async-self×1, shared-state×142 | 5 | 8 | 19 | 264 |
| 11 | v4/classic/in-out.ts | 10 | async-self×1, shared-state×532 | 1 | 4 | 13 | 190 |
| 12 | v3/helpers/parseUtil.ts | 15 | module-suspend×7 | 3 | 2 | 4 | 150 |
| 13 | v4/mini/in-out.ts | 10 | async-self×1, shared-state×537 | 1 | 4 | 5 | 110 |
| 14 | v4/classic/coerce.ts | 5 | async-self×1, shared-state×531 | 1 | 4 | 13 | 95 |
| 15 | v4/mini/iso.ts | 8 | async-self×1, shared-state×535 | 1 | 4 | 5 | 88 |
| 16 | v4/classic/iso.ts | 4 | async-self×1, shared-state×530 | 2 | 4 | 13 | 80 |
| 17 | v4/core/json-schema-generator.ts | 2 | async-self×1, shared-state×160 | 1 | 11 | 25 | 76 |
| 18 | v4/classic/deep-partial.ts | 3 | async-self×1, shared-state×528 | 2 | 4 | 14 | 63 |
| 19 | v4/mini/coerce.ts | 5 | async-self×1, shared-state×536 | 1 | 4 | 5 | 55 |
| 20 | v4/classic/compat.ts | 2 | async-self×1, shared-state×430 | 1 | 4 | 13 | 38 |
| 21 | v4/mini/deep-partial.ts | 3 | async-self×1, shared-state×533 | 1 | 4 | 5 | 33 |
| 22 | compile.ts | 2 | async-self×1, shared-state×428 | 0 | 0 | 0 | 2 |
| 23 | index.ts | 0 | async-self×1, shared-state×557 | 6 | 0 | 6 | 0 |
| 24 | mini/index.ts | 0 | async-self×1, shared-state×547 | 0 | 0 | 0 | 0 |
| 25 | v3/external.ts | 0 | module-suspend×20 | 1 | 1 | 4 | 0 |
| 26 | v3/index.ts | 0 | module-suspend×20 | 1 | 1 | 4 | 0 |
| 27 | v4/classic/checks.ts | 0 | async-self×1, shared-state×428 | 3 | 4 | 14 | 0 |
| 28 | v4/classic/external.ts | 0 | async-self×1, shared-state×557 | 3 | 3 | 13 | 0 |
| 29 | v4/classic/index.ts | 0 | async-self×1, shared-state×557 | 3 | 1 | 7 | 0 |
| 30 | v4/classic/parse.ts | 0 | async-self×1, shared-state×429 | 2 | 4 | 14 | 0 |
| 31 | v4/core/index.ts | 0 | async-self×1, shared-state×428 | 21 | 10 | 25 | 0 |
| 32 | v4/index.ts | 0 | async-self×1, shared-state×557 | 5 | 0 | 5 | 0 |
| 33 | v4/mini/checks.ts | 0 | async-self×1, shared-state×428 | 1 | 4 | 5 | 0 |
| 34 | v4/mini/external.ts | 0 | async-self×1, shared-state×547 | 3 | 3 | 5 | 0 |
| 35 | v4/mini/index.ts | 0 | async-self×1, shared-state×547 | 5 | 0 | 5 | 0 |
| 36 | v4/mini/parse.ts | 0 | async-self×1, shared-state×428 | 2 | 4 | 5 | 0 |
| 37 | v4-mini/index.ts | 0 | async-self×1, shared-state×547 | 0 | 0 | 0 | 0 |

## Top 10 详情

### v4/core/schemas.ts
  自有函数: 304；拦截: async-self×1, shared-state×141
  影响入口: v4/core/index, v4/classic/external, index, v4/classic/index, v4/index
  挡测试: 25 个（el.test, es.test, fr.test…）
  直接依赖: 14；传递覆盖: 131

### v4/classic/schemas.ts
  自有函数: 413；拦截: async-self×1, shared-state×526
  影响入口: v4/classic/external, index, v4/classic/index, v4/index
  挡测试: 14 个（el.test, es.test, fr.test…）
  直接依赖: 7；传递覆盖: 24

### v4/core/api.ts
  自有函数: 141；拦截: async-self×1, shared-state×260
  影响入口: v4/core/index, v4/classic/external, index, v4/classic/index, v4/index
  挡测试: 25 个（el.test, es.test, fr.test…）
  直接依赖: 1；传递覆盖: 131

### v4/core/compile.ts
  自有函数: 127；拦截: async-self×1, shared-state×223
  影响入口: v4/core/index, v4/classic/external, index, v4/classic/index, v4/index
  挡测试: 25 个（el.test, es.test, fr.test…）
  直接依赖: 5；传递覆盖: 131

### v4/core/json-schema-processors.ts
  自有函数: 87；拦截: async-self×1, shared-state×160
  影响入口: v4/classic/external, index, v4/classic/index, v4/index, v4/core/index
  挡测试: 25 个（el.test, es.test, fr.test…）
  直接依赖: 5；传递覆盖: 131

### v4/mini/schemas.ts
  自有函数: 212；拦截: async-self×1, shared-state×531
  影响入口: v4/mini/external, mini/index, v4/mini/index, v4-mini/index
  挡测试: 5 个（fix-json-issue.test, apply.test, brand.test…）
  直接依赖: 6；传递覆盖: 13

### v3/types.ts
  自有函数: 336；拦截: module-suspend×20
  影响入口: v3/external, v3/index
  挡测试: 4 个（parseUtil.test, error.test, refine.test…）
  直接依赖: 2；传递覆盖: 11

### v4/classic/from-json-schema.ts
  自有函数: 30；拦截: async-self×1, shared-state×543
  影响入口: v4/classic/external, index, v4/classic/index, v4/index
  挡测试: 13 个（el.test, es.test, fr.test…）
  直接依赖: 2；传递覆盖: 17

### v4/classic/errors.ts
  自有函数: 13；拦截: async-self×1, shared-state×429
  影响入口: v4/classic/external, index, v4/classic/index, v4/index
  挡测试: 14 个（el.test, es.test, fr.test…）
  直接依赖: 2；传递覆盖: 26

### v4/core/visit.ts
  自有函数: 8；拦截: async-self×1, shared-state×142
  影响入口: v4/classic/external, index, v4/classic/index, v4/index, v4/mini/external
  挡测试: 19 个（el.test, es.test, fr.test…）
  直接依赖: 5；传递覆盖: 31
