---
id: aot-zod-hotspot-measurement
title: "zod 热点度量：按模块执行时间/调用次数 + 翻转可行性（顶模块翻不了）"
category: reference
status: active
tags: [aot, hotspot, benchmark, zod]
created: "2026-11-13T23:03:38"
updated: "2026-11-14T00:25:09"
---

<!-- compiled_truth -->
# zod 热点度量（按模块耗时/调用数/占比 top-N + 翻转可行性 + async/generator 标注）

> 口径：zod v4 core（`report_mcp/node_modules/zod/src/v4/core/`），`inspector Profiler` 采样 + `callCount` 精确覆盖，归一化到 zod 代码（zod 占全部样本 59%）。度量日期 2026-11-13。

## 模块耗时占比（top，累计）

| 模块 | 时间% | 累计 | async/generator | 翻转可行性（interp/wasm） | AOT 适用性 |
|---|---|---|---|---|---|
| schemas.ts | 54.30 | 54.30 | 有（`async` 命中 23） | 142/142 → 整模块退 interp | **不可翻**：含挂起语义 + 模块级可变状态（`EVALUATING/globalConfig/installing/broke/breaker/_zodDesc/_E/_emoji/dateSource` 双侧触碰）|
| checks.ts | 24.16 | 78.46 | 有（命中 3） | 88/88 → 整模块退 interp | **不可翻**：同上，共享状态真冲突 |
| util.ts | 11.08 | 89.54 | 无（0） | 79/0 → 可翻 | 可翻（含挂起语义代码 0）|
| parse.ts | 7.47 | 97.01 | 有（命中 16）| 90/0 → 可翻 | 同步热点可翻；异步路径留 interp。**实测 tagged wasm 慢于 interp → 已回退** |

## 模块调用占比（top，累计）

| 模块 | 调用% | 累计 |
|---|---|---|
| schemas.ts | 41.3 | 41.3 |
| util.ts | 34.9 | 76.2 |
| checks.ts | 14.8 | 91.0 |
| memoizer.ts | 3.2 | 94.2 |

## 最热函数（时间%）

| 函数 | 时间% |
|---|---|
| `_zod.run` | 26.5 |
| `_zod.parse` | 13.8 |
| `check._a.check` | 12.3 |
| `runChecks` | 12.0 |
| `_zod.check` | 11.8 |
| `finalizeIssue` | 9.8 |
| `failure` | 7.2 |

前 7 个函数 = **93.5%** 时间。

## 关键结论

1. **78.5% 时间在 schemas+checks，二者均不可翻**（挂起语义 + 模块级可变状态真冲突）。这是覆盖率天花板：翻其余模块最多触及 ~21% 时间。
2. **util/parse/core 可翻**（interp=0），但 `bench/aot-product` 实测 tagged wasm 比 interp 慢 25–92×（每次对象/宿主内建跨 JS↔wasm 边界）。同步热点翻成 wasm 反而更慢。
3. **async/generator 标注**：schemas(23)/checks(3)/parse(16)/memoizer(2) 含 async 函数——这些挂起语义函数 AOT 无法编译，永久留 interp；其中 schemas/checks 的**同步**热点（`_zod.run`/`check`/`runChecks`）也被共享状态 clash 挡住。
4. 因此 AOT 提升天花板在 **P2（M4 单模块合并）**：先消除跨界，否则翻再多模块 G1（≥3×）都达不到。

## 复现

- 耗时/调用：`/tmp/bench_cov.mjs`（`Profiler.startPreciseCoverage({callCount:true})`）+ `agg_zod.mjs`/`agg_fn.mjs`。
- 翻转可行性：`/tmp/feas.js`（各模块 interp/wasm 计数）。


## Timeline

- time: 2026-11-13T23:03:38
  kind: decision
  summary: "Created this page: zod 热点度量：按模块执行时间/调用次数 + 翻转可行性（顶模块翻不了）"
  source: session 2026-11-13
  affects: [aot-zod-hotspot-measurement]

- time: 2026-11-14T00:25:09
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: bench/aot-product host run 2026-11-14
  affects: [aot-zod-hotspot-measurement]
