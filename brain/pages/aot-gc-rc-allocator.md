---
id: aot-gc-rc-allocator
title: "AOT 堆回收：RC 块头 + 根集 + mark-sweep（bump 复位是 UAF）"
category: decision
status: active
tags: [aot, gc, memory, emitter, qzvm]
created: "2026-10-22T17:00:48"
updated: "2026-10-22T18:08:10"
---

<!-- compiled_truth -->
- **GC 性能基线（2026-10-22）**：3MB 堆 23ms / 11MB 堆 61ms，吞吐 ~185 MB/s 且线性扩展。关键优化是**不建块索引**——size/kind/nslots 都在块头里，`DataView` 直读即可；原 `Map<hdr,{rc,size,kind,nslots}>` 让 GC 自身成为分配源（86ms→23ms）。句柄解析避开 `BigInt` 比较（hi/low 分开算）。
- **空闲链两个破坏性 bug（已修）**：① size 比较求值顺序错——`globalGet(cur); total(); i32Load(2,4)` 把 total 这个大小当地址读，匹配错节点并把块头 size 写成垃圾（`size=2147155968` 直接断链）；② 复用节点未重置 `kind/nslots`，旧 `kind=K_ARR/nslots=2` 让 GC 遍历已覆盖数据区当幽灵根 → 整轮 `freed=0`。两者叠加使空闲链完全失效（bump 只增不减）。修复后 `{id,name,tags}`×30000×5 轮 bump 恒定 3.12MB。


## Timeline

- time: 2026-10-22T17:00:48
  kind: decision
  summary: "Created this page: AOT 堆回收：RC 块头 + 根集 + mark-sweep（bump 复位是 UAF）"
  source: "本会话实证"
  affects: [aot-gc-rc-allocator]

- time: 2026-10-22T17:01:30
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [aot-gc-rc-allocator]

- time: 2026-10-22T17:04:47
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [aot-gc-rc-allocator]

- time: 2026-10-22T17:08:27
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [aot-gc-rc-allocator]

- time: 2026-10-22T17:23:17
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [aot-gc-rc-allocator]

- time: 2026-10-22T17:57:12
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [aot-gc-rc-allocator]

- time: 2026-10-22T18:08:10
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [aot-gc-rc-allocator]
