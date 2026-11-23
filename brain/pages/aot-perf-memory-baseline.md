---
id: aot-perf-memory-baseline
title: "AOT 性能与内存基线（CI 权威）"
category: reference
status: active
tags: [aot, performance, memory, baseline, ci]
created: "2026-11-23T17:32:36"
updated: "2026-11-23T17:32:36"
---

<!-- compiled_truth -->
## 结论

唯一权威基线来自 CI job `aot-perf-baseline`（ubuntu-latest，Release qzjs，Node 22.23.5，wamrc 2.4.5，zod 4.6.5）。本地测量只用于开发验证，不写回基线。基线文件 `test/perf_baselines/aot.json`，采集脚本 `bench/aot-product/baseline_ci.mjs`。

## 首次基线（commit 23d621f5，CI run 45139911795）

- 构建：aotp 920 ms、mix 1230 ms、str 738 ms、zodbench AOT 60.5 s / interp 4.8 s。
- 产物：zodbench wasm 4.77 MB、aot 6.57 MB、glue 1.80 MB、interpJs 0.83 MB。
- p50（AOT / interp / speedup）：computeWork 2.22/10.40 ms 4.68×；jsonWork 652/38.1 ms 0.058×；validationWork 3627/44.6 ms 0.012×。
- 微基准：numWork 238/5155 ms 21.7×；objWork 37.2/4.11 ms 0.11×；strWork 15.3/16.5 ms 1.08×。
- zodbench bench(100)：114.2/0.508 ms 0.004×。AOT 当前瓶颈是 tagged/宿主跨界，纯数值快路径保留 4.7–21.7×。
- 峰值 RSS：空 qzjs 8.6 MiB；产品 AOT 18.2–59.2 MiB；zodbench AOT 62.6 MiB、interp 21.5 MiB。

## 复用

CI 每次发布 artifact；后续 PR 调用 `test/compare_perf.py --baseline test/perf_baselines/aot.json --out /tmp/aot-baseline.out --section aot` 只报 Δ%，不设硬门槛。换 runner/工具链必须重建基线。


## Timeline

- time: 2026-11-23T17:32:36
  kind: decision
  summary: "Created this page: AOT 性能与内存基线（CI 权威）"
  source: CI run 45139911795
  affects: [aot-perf-memory-baseline]

- time: 2026-11-23T17:32:36
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: CI run 45139911795
  affects: [aot-perf-memory-baseline]

- time: 2026-11-23T17:32:36
  kind: evidence
  summary: "首次 CI 基线：commit 23d621f5，run 45139911795；纯数值 AOT 4.7–21.7×，tagged 路径 0.01–0.11×；峰值 RSS zodbench AOT 62.6 MiB/interp 21.5 MiB。"
  source: CI artifact aot-perf-baseline-23d621f539cfc34bbb91bb2070197d7cd2db5c4d
  affects: [aot-perf-memory-baseline]
