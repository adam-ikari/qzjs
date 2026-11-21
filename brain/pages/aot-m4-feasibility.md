---
id: aot-m4-feasibility
title: "P2/M4 单模块合并可行性评估（可行，M6b PoC 边界税 66×）"
category: decision
status: active
tags: [aot, m4, p2, feasibility]
created: "2026-11-14T00:26:21"
updated: "2026-11-14T10:11:56"
---

<!-- compiled_truth -->
<current best understanding — replace this with the real content>

## Timeline

- time: 2026-11-14T00:26:21
  kind: decision
  summary: "Created this page: P2/M4 单模块合并可行性评估（可行，M6b PoC 边界税 66×）"
  source: 2026-11-14 assessment
  affects: [aot-m4-feasibility]

- time: 2026-11-14T10:07:56
  kind: reversal
  summary: "约束更正(主agent 2026-11-14): emitter 产物必须绑定 qzvm 到 wasm 内(静态单模块合并), NOT 通用/不绑定/multi-module dynamic linking. 终态=单 wasm: qzvm-guest 与 emitter 产物静态合并, qz.* 成模块内调用(编译期合并/静态链接, 不依赖 WAMR multi-module dynamic linking). multi-module(test/m6b-poc 53.6ns)只作量税中间里程碑, 非交付形态. 旧约束'emitter 通用不绑定 qzjs/qzvm'作废. 工作顺序: M6a→multi-module量税(已完成)→静态单模块合并→bench 在单模块终态出数(验收口径)."
  source: main Tier2 correction 2026-11-14
  affects: [aot-m4-feasibility]

- time: 2026-11-14T10:11:56
  kind: decision
  summary: "静态单模块合并落地(wasm-merge/Binaryen 编译期合并, 非 dynamic linking): emitter产物+libqzvm 合并单 wasm, qz.* 内化(合并后 import 仅 qz_host.*+WASI). 终态bench: computeWork 6.19x(G1✓), validationWork 1.44x(G2✗, 比 multi-module 1.2x 好-内化消import编解码), tagLoop 15.1ns/op, 合并wasm 1.26MiB. bench/aot-product/run_inmod.mjs --merge 跑通."
  source: 2026-11-14 wasm-merge terminal
  affects: [aot-m4-feasibility]
