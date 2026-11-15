# zod 整模块 interp 缺口排序（39 个）

> 分析脚本：`src/qzvm/aot/interp_gaps.js`；数据日期 2026-11-15；corpus = zod src/v4+v3（134 src + 198 test .ts）。
> **只排序+说明，不改代码。**

## 判据

每个模块标注：
- **自有函数**：该文件自身定义的函数数（FunctionDeclaration/MethodDeclaration/ArrowFunction，TS AST 计数，非传递闭包）。
- **拦截原因**：compileTS dbgInterp 归因——`module-suspend`（模块级 async/generator，整模块退 interp）、`shared-state`（模块级可变状态双侧触碰）、`async-self`（函数体 async）。
- **直接依赖**：多少 src 文件 import 它。
- **影响入口**：传递导入链触及的入口文件数（index.ts / external.ts）。
- **挡测试**：传递导入链触及的 test 文件数（这些测试的受影响函数走 interp 而非 wasm）。
- **impact** = 自有函数 × (挡测试 + 影响入口 + 直接依赖 + 1)。

## 结论

1. **module-suspend 主导**（38/39 文件）：async/generator 出现在模块级（类体/字段初值/模块语句），无函数级通道 → 整模块退 interp。
   唯一例外是 `v4/core/parse.ts`（shared-state×90：模块级可变状态双侧触碰）。
2. **schemas.ts 双版本是最大阻塞**：v4/core/schemas.ts（304 函数，挡 25 测试，影响 11 入口）+ v4/classic/schemas.ts（413 函数，挡 14 测试）。
   两者含 async + 模块级可变状态（EVALUATING/globalConfig 等），不可翻（见 aot-zod-hotspot-measurement）。
3. **checks.ts 依赖面最广**（69 直接依赖，131 传递覆盖）但自有函数少（52），impact 排第 3。
4. **v3/types.ts**（336 函数）是 v3 线最大阻塞，但入口/测试覆盖小（v3 是遗留线）。

## 排名

| # | 模块 | 自有函数 | 拦截原因 | 直接依赖 | 影响入口 | 挡测试 | impact |
|---|------|---------|----------|---------|---------|--------|--------|
| 1 | v4/core/schemas.ts | 304 | async-self×1, module-suspend×141 | 14 | 11 | 25 | 15504 |
| 2 | v4/classic/schemas.ts | 413 | async-self×1, module-suspend×526 | 7 | 4 | 14 | 10738 |
| 3 | v4/core/checks.ts | 52 | module-suspend×88 | 69 | 11 | 25 | 5512 |
| 4 | v4/core/api.ts | 141 | async-self×1, module-suspend×260 | 1 | 11 | 25 | 5358 |
| 5 | v4/core/compile.ts | 127 | async-self×1, module-suspend×223 | 5 | 11 | 25 | 5334 |
| 6 | v4/core/json-schema-processors.ts | 87 | async-self×1, module-suspend×160 | 5 | 11 | 25 | 3654 |
| 7 | v4/mini/schemas.ts | 212 | async-self×1, module-suspend×531 | 6 | 4 | 5 | 3392 |
| 8 | v3/types.ts | 336 | module-suspend×20 | 2 | 2 | 4 | 3024 |
| 9 | v4/core/parse.ts | 32 | shared-state×90 | 2 | 11 | 25 | 1248 |
| 10 | v4/classic/from-json-schema.ts | 30 | async-self×1, module-suspend×543 | 2 | 4 | 13 | 600 |
| 11 | v4/classic/errors.ts | 13 | async-self×1, module-suspend×429 | 2 | 4 | 14 | 273 |
| 12 | v4/core/visit.ts | 8 | async-self×1, module-suspend×142 | 5 | 8 | 19 | 264 |
| 13 | v4/classic/in-out.ts | 10 | async-self×1, module-suspend×532 | 1 | 4 | 13 | 190 |
| 14 | v3/helpers/parseUtil.ts | 15 | module-suspend×7 | 3 | 2 | 4 | 150 |
| 15 | v4/mini/in-out.ts | 10 | async-self×1, module-suspend×537 | 1 | 4 | 5 | 110 |
| 16 | v4/classic/coerce.ts | 5 | async-self×1, module-suspend×531 | 1 | 4 | 13 | 95 |
| 17 | v4/mini/iso.ts | 8 | async-self×1, module-suspend×535 | 1 | 4 | 5 | 88 |
| 18 | v4/classic/iso.ts | 4 | async-self×1, module-suspend×530 | 2 | 4 | 13 | 80 |
| 19 | v4/core/json-schema-generator.ts | 2 | async-self×1, module-suspend×160 | 1 | 11 | 25 | 76 |
| 20 | v4/classic/deep-partial.ts | 3 | async-self×1, module-suspend×528 | 2 | 4 | 14 | 63 |
| 21 | v4/mini/coerce.ts | 5 | async-self×1, module-suspend×536 | 1 | 4 | 5 | 55 |
| 22 | v4/classic/compat.ts | 2 | async-self×1, module-suspend×430 | 1 | 4 | 13 | 38 |
| 23 | v4/mini/deep-partial.ts | 3 | async-self×1, module-suspend×533 | 1 | 4 | 5 | 33 |
| 24 | compile.ts | 2 | async-self×1, module-suspend×428 | 0 | 0 | 0 | 2 |
| 25 | index.ts | 0 | async-self×1, module-suspend×557 | 6 | 0 | 6 | 0 |
| 26 | mini/index.ts | 0 | async-self×1, module-suspend×547 | 0 | 0 | 0 | 0 |
| 27 | v3/external.ts | 0 | module-suspend×20 | 1 | 1 | 4 | 0 |
| 28 | v3/index.ts | 0 | module-suspend×20 | 1 | 1 | 4 | 0 |
| 29 | v4/classic/checks.ts | 0 | async-self×1, module-suspend×428 | 3 | 4 | 14 | 0 |
| 30 | v4/classic/external.ts | 0 | async-self×1, module-suspend×557 | 3 | 3 | 13 | 0 |
| 31 | v4/classic/index.ts | 0 | async-self×1, module-suspend×557 | 3 | 1 | 7 | 0 |
| 32 | v4/classic/parse.ts | 0 | async-self×1, module-suspend×429 | 2 | 4 | 14 | 0 |
| 33 | v4/core/index.ts | 0 | async-self×1, module-suspend×428 | 21 | 10 | 25 | 0 |
| 34 | v4/index.ts | 0 | async-self×1, module-suspend×557 | 5 | 0 | 5 | 0 |
| 35 | v4/mini/checks.ts | 0 | async-self×1, module-suspend×428 | 1 | 4 | 5 | 0 |
| 36 | v4/mini/external.ts | 0 | async-self×1, module-suspend×547 | 3 | 3 | 5 | 0 |
| 37 | v4/mini/index.ts | 0 | async-self×1, module-suspend×547 | 5 | 0 | 5 | 0 |
| 38 | v4/mini/parse.ts | 0 | async-self×1, module-suspend×428 | 2 | 4 | 5 | 0 |
| 39 | v4-mini/index.ts | 0 | async-self×1, module-suspend×547 | 0 | 0 | 0 | 0 |

## Top 10 详情

### v4/core/schemas.ts
  自有函数: 304；拦截: async-self×1, module-suspend×141
  影响入口: v4/core/index, v4/classic/external, index, v4/classic/index, v4/index
  挡测试: 25 个（el.test, es.test, fr.test…）
  直接依赖: 14；传递覆盖: 131

### v4/classic/schemas.ts
  自有函数: 413；拦截: async-self×1, module-suspend×526
  影响入口: v4/classic/external, index, v4/classic/index, v4/index
  挡测试: 14 个（el.test, es.test, fr.test…）
  直接依赖: 7；传递覆盖: 24

### v4/core/checks.ts
  自有函数: 52；拦截: module-suspend×88
  影响入口: v4/classic/external, index, v4/classic/index, v4/index, v4/core/index
  挡测试: 25 个（el.test, es.test, fr.test…）
  直接依赖: 69；传递覆盖: 131

### v4/core/api.ts
  自有函数: 141；拦截: async-self×1, module-suspend×260
  影响入口: v4/core/index, v4/classic/external, index, v4/classic/index, v4/index
  挡测试: 25 个（el.test, es.test, fr.test…）
  直接依赖: 1；传递覆盖: 131

### v4/core/compile.ts
  自有函数: 127；拦截: async-self×1, module-suspend×223
  影响入口: v4/core/index, v4/classic/external, index, v4/classic/index, v4/index
  挡测试: 25 个（el.test, es.test, fr.test…）
  直接依赖: 5；传递覆盖: 131

### v4/core/json-schema-processors.ts
  自有函数: 87；拦截: async-self×1, module-suspend×160
  影响入口: v4/classic/external, index, v4/classic/index, v4/index, v4/core/index
  挡测试: 25 个（el.test, es.test, fr.test…）
  直接依赖: 5；传递覆盖: 131

### v4/mini/schemas.ts
  自有函数: 212；拦截: async-self×1, module-suspend×531
  影响入口: v4/mini/external, mini/index, v4/mini/index, v4-mini/index
  挡测试: 5 个（fix-json-issue.test, apply.test, brand.test…）
  直接依赖: 6；传递覆盖: 13

### v3/types.ts
  自有函数: 336；拦截: module-suspend×20
  影响入口: v3/external, v3/index
  挡测试: 4 个（parseUtil.test, error.test, refine.test…）
  直接依赖: 2；传递覆盖: 11

### v4/core/parse.ts
  自有函数: 32；拦截: shared-state×90
  影响入口: v4/core/index, v4/classic/external, index, v4/classic/index, v4/index
  挡测试: 25 个（el.test, es.test, fr.test…）
  直接依赖: 2；传递覆盖: 131

### v4/classic/from-json-schema.ts
  自有函数: 30；拦截: async-self×1, module-suspend×543
  影响入口: v4/classic/external, index, v4/classic/index, v4/index
  挡测试: 13 个（el.test, es.test, fr.test…）
  直接依赖: 2；传递覆盖: 17
