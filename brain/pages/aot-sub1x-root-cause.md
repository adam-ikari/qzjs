---
id: aot-sub1x-root-cause
title: "AOT 低于 1× 负载根因"
category: reference
status: active
tags: [aot, performance, analysis, cross-boundary]
created: "2026-11-23T19:00:34"
updated: "2026-11-23T23:31:04"
---

<!-- compiled_truth -->
## 结论

CI 基线中四个低于 1× 负载（jsonWork 0.058×、validationWork 0.012×、objWork 0.110×、zodbench.bench 0.004×）的共同根因是 tagged 值的 `qz.*` 宿主跨界税，不是算法回退。报告：`docs/dev/aot-sub1x-analysis.md`。

- `jsonWork`：30k 次 `JSON.parse` 返回 HOST_HI 宿主对象；每 iter 12 次调用（builtin 1、prop_get 6、get_index 4、restore_handles 1）。
- `validationWork`：每 iter 8.5 次调用；四处 `typeof !==` 经 `qz.sne`，字符串 `indexOf` 经 `qz.method_call`，另有 rem/truthy/seq。
- `objWork`：每 iter 2 次；不再是属性读，而是 `field_order_lit` + `restore_handles`。
- `zodbench`：每 iter 4 次，其中 `safeParse` 是 0x7FFD HOST_HI 上的宿主方法；zod 实际逻辑在宿主 JS 执行，AOT 只增加包装/转换成本。558/559 函数为 tagged，1 个 interp；全 interp 对照 559/559，8 B wasm。

## 优化优先级

降低单次跨界 JS shim 成本 > 宿主内建结果 wasm 落地/批量接口 > 静态类型收窄消除已知 tag 的 sne/truthy/seq/rem > 缓存 field_order_lit 并跳过纯 POJO 循环句柄维护 > zod 批量宿主调用。不得撤销 host-backed 类语义。


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
