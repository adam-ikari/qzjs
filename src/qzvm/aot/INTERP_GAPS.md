# zod 整模块 interp 缺口排序（4 个，2026-11-17）
# corpus: 134 src + 198 test .ts；impact = ownFuncs × (tests + entries + deps + 1)

> shared-state 已由 host-backed 模块绑定解决（clash const 走 interpJs 单一事实源），33 个 v4 文件已翻回 wasm；剩余 4 个文件为 v3 module-suspend。
> wasm 6053 → 20845 / 20945（28.9% → 99.5%）；详情见 brain [[aot-shared-state-clash-design]]。

| # | 模块 | 自有函数 | 拦截原因 | 直接依赖 | 影响入口 | 挡测试 | impact |
|---|------|---------|----------|---------|---------|--------|--------|
| 1 | v3/types.ts | 336 | module-suspend×20 | 2 | 2 | 4 | 3024 |
| 2 | v3/helpers/parseUtil.ts | 15 | module-suspend×7 | 3 | 2 | 4 | 150 |
| 3 | v3/external.ts | 0 | module-suspend×20 | 1 | 1 | 4 | 0 |
| 4 | v3/index.ts | 0 | module-suspend×20 | 1 | 1 | 4 | 0 |

## Top 10 详情

### v3/types.ts
  自有函数: 336；拦截: module-suspend×20
  影响入口: v3/external, v3/index
  挡测试: 4 个（parseUtil.test, error.test, refine.test…）
  直接依赖: 2；传递覆盖: 11

### v3/helpers/parseUtil.ts
  自有函数: 15；拦截: module-suspend×7
  影响入口: v3/external, v3/index
  挡测试: 4 个（error.test, refine.test, tuple.test…）
  直接依赖: 3；传递覆盖: 11

### v3/external.ts
  自有函数: 0；拦截: module-suspend×20
  影响入口: v3/index
  挡测试: 4 个（parseUtil.test, error.test, refine.test…）
  直接依赖: 1；传递覆盖: 11

### v3/index.ts
  自有函数: 0；拦截: module-suspend×20
  影响入口: v3/external
  挡测试: 4 个（parseUtil.test, error.test, refine.test…）
  直接依赖: 1；传递覆盖: 11
