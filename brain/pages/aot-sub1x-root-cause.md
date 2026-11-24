---
id: aot-sub1x-root-cause
title: "AOT 低于 1× 负载根因"
category: reference
status: active
tags: [aot, performance, analysis, cross-boundary]
created: "2026-11-23T19:00:34"
updated: "2026-11-24T16:13:06"
---

<!-- compiled_truth -->
## 结论（2026-11-24 路线更正）

AOT 的加速形态是**单一 wasm 模块**：emitter 产物（静态 wasm）与 qzvm（动态 JS 引擎）在模块内共存；`qz.*` 经 wasm-merge 内化为模块内调用，**不存在 standalone glue/host 跨界**。因此把 `bench/aot-product/run.js` 的 JS glue `qz.*` 调用当“宿主跨界税”并把其调用数当加速目标是路线偏离；该 bench 的结果不能作为 AOT 加速验收。

验收口径：`bench/aot-product/run_inmod.mjs --merge`（emitter 产物 + libqzvm 静态合并，qz.* 内化，仅保留 WASI/qz_host 对外 import）。

2026-11-24 的 `d2de880e`（ASCII indexOf 下推 wasm）与 `f651398a`（有限 number % 零余数保号）确实减少了独立档 `qz.*` 调用并提升 standalone bench；这只能记作编译器层原语调用削减，**不是 AOT 路线收益**，除非在 in-module 合并模块上复测。后续优化必须先问：该行为在 qzvm 内部是否仍有原生 wasm 指令不可表达的动态语义；仅当答案肯定时才保留 qzvm 原语，否则优先编译期为静态 wasm。


## Timeline

- time: 2026-11-23T19:00:34
  kind: decision
  summary: "Created this page: AOT 低于 1× 负载根因"
  source: "CI baseline 45139911795 + local qz.* call profiling 2026-11-23"
  affects: [aot-sub1x-root-cause]

- time: 2026-11-23T19:00:34
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "CI baseline 45139911795 + local qz.* call profiling"
  affects: [aot-sub1x-root-cause]

- time: 2026-11-23T19:00:34
  kind: evidence
  summary: "四个低于 1× 负载均定位到 qz.* 跨界：jsonWork 12 calls/iter、validationWork 8.5、objWork 2（field_order_lit+restore_handles）、zodbench 4（safeParse 在 HOST_HI 宿主方法）。"
  source: docs/dev/aot-sub1x-analysis.md
  affects: [aot-sub1x-root-cause]

- time: 2026-11-23T21:53:49
  kind: evidence
  summary: "field_order_lit static field-name cache: focused A/B 30k calls p50 8.25ms→7.643ms (0.6ms); product benchmark noise dominated. Not a material optimization; keep only as correctness-neutral dedup of per-literal split."
  source: "src/qzvm/aot/test_field_order_cache.js + /tmp/bench_field_order_cache.js"
  affects: [aot-sub1x-root-cause]

- time: 2026-11-23T22:44:26
  kind: evidence
  summary: "typeof v !== \"string\" 严格比较内联为 wasm interned 字符串句柄 i64Eq/i64Ne。validationWork(200000) 现网 qz.* 计数：sne 0（原 800000）、seq 200000、method_call 200000、truthy 400000、rem 100000，总跨界约 1700005→900005；check=300000，test_aot ALL PASS。"
  source: "src/qzvm/aot/test_typeof_strict_eq.js + instrumented aotp glue"
  affects: [aot-sub1x-root-cause]

- time: 2026-11-23T23:31:04
  kind: evidence
  summary: "x === null / !== null 直接比较固定 tagged null 句柄 0x7FF9|1。validationWork(200000) 现网计数：sne 0、seq 0（原 200000）、truthy 400000、method_call 200000、rem 100000；总跨界约 900005→700005；check=300000，test_aot ALL PASS。"
  source: "src/qzvm/aot/test_null_strict_eq.js + instrumented aotp glue"
  affects: [aot-sub1x-root-cause]

- time: 2026-11-24T00:30:05
  kind: evidence
  summary: "strict 比较构成的 &&/|| 短路条件直接发裸 i32 逻辑，表达式位再 box 为 tagged bool。validationWork(200000) 现网计数：qz.truthy 400000→0；剩余 method_call 200000、rem 100000；check=300000，test_aot ALL PASS。"
  source: "src/qzvm/aot/test_bool_shortcircuit.js + instrumented aotp glue"
  affects: [aot-sub1x-root-cause]

- time: 2026-11-24T07:48:19
  kind: evidence
  summary: "同口径本地 A/B（run.js --rebuild, 5 reps, same qzjs, baseline c6797e04 vs optimized 2b2d5fc5): validationWork wasm p50 8633.842ms→3042.792ms = 2.84x；compute 34.238→32.535ms，json 1690.643→1632.605ms；载荷 23514→22986B；CI baseline 未改。"
  source: "docs/dev/aot-sub1x-analysis.md + /tmp/perf_baseline_final.txt + /tmp/perf_optimized_final.txt"
  affects: [aot-sub1x-root-cause]

- time: 2026-11-24T09:34:59
  kind: reversal
  summary: "回退 field_order_lit 静态字段名缓存（原提交 045da477）：专项 A/B 仅 8.25ms→7.643ms/30k 次，低于本机噪声；删除 litNames 与 test_field_order_cache.js。保留 strict 比较/null/typeof/短路内联；回退后 test_aot ALL PASS，validationWork(200000)=2367.801ms（本地噪声大，以跨界计数为准）。"
  source: "docs/dev/aot-sub1x-analysis.md + /tmp/perf_after_cache_revert.txt"
  affects: [aot-sub1x-root-cause]

- time: 2026-11-24T11:21:55
  kind: evidence
  summary: "String.prototype.indexOf(ASCII literal) 在 wasm 内扫描（qzs_indexof_ascii，按 UTF-8 前缀累加 UTF-16 码元；非字符串/多参回退 qz.method_call）。validationWork(200000) p50 从 2367.801ms 降至 601.030ms；test_indexof_inline.js 验证零 method_call、UTF-8 代理对索引、empty needle、非字符串 loud 抛错；test_aot.js ALL PASS。"
  source: "src/qzvm/aot/test_indexof_inline.js + /tmp/perf_indexof_inline.txt"
  affects: [aot-sub1x-root-cause]

- time: 2026-11-24T13:12:43
  kind: evidence
  summary: "tagged 有限 number % 的零余数不再回退 qz.rem：在 wasm 用 r==0 ? a*0 : r 复刻 JS 保号语义。test_numeric_rem_zero_sign.js 验证 ±0/负数/非有限回退，AOT 全绿；validationWork(200000) p50 601.030ms→321.494ms，check 一致。"
  source: "src/qzvm/aot/test_numeric_rem_zero_sign.js + /tmp/perf_rem_inline.txt"
  affects: [aot-sub1x-root-cause]

- time: 2026-11-24T13:18:48
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "user correction 2026-11-24; brain aot-performance-model / aot-m4-feasibility"
  affects: [aot-sub1x-root-cause]

- time: 2026-11-24T13:18:48
  kind: reversal
  summary: "用户纠正路线：AOT 加速 = 单 wasm 内 qzvm + 静态产物，qz.* 内化；不存在 glue/host 跨界。本轮把 standalone run.js 的 qz.* 宿主调用当加速目标属偏离，其 p50 数字不再作为 AOT 验收；改用 run_inmod.mjs --merge。d2de880e/f651398a 暂按编译器层原语削减保留，待 in-module 复测。"
  source: user correction 2026-11-24
  affects: [aot-sub1x-root-cause, aot-performance-model, aot-m4-feasibility]

- time: 2026-11-24T16:13:06
  kind: evidence
  summary: "静态 number + number 在 tagged wasm 内直达 f64.add，跳过 BigInt/字符串/句柄分派；any 拼接保持原路径。合并单模块 VALIDATION_N=200000 为 5.01×；默认 N=500 G2 抖动大。test_numeric_add_static.js + indexOf/rem/test_aot 全绿。"
  source: "bench/aot-product/run_inmod.mjs + docs/dev/aot-sub1x-analysis.md + src/qzvm/aot/test_numeric_add_static.js"
  affects: [aot-sub1x-root-cause]
