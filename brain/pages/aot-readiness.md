---
id: aot-readiness
title: "AOT 生产级就绪度：6.4% 真实库覆盖 + Map 静默错误两项独立致命"
category: decision
status: active
tags: [aot, readiness, wamr]
created: "2026-10-21T07:15:23"
updated: "2026-10-21T07:15:34"
---

<!-- compiled_truth -->
<current best understanding — replace this with the real content>

## Timeline

- time: 2026-10-21T07:15:23
  kind: decision
  summary: "Created this page: AOT 生产级就绪度：6.4% 真实库覆盖 + Map 静默错误两项独立致命"
  source: "zod 4.6.7 实测 + Map 最小复现"
  affects: [aot-readiness]

- time: 2026-10-21T07:15:34
  kind: evidence
  summary: "真实代码库实测（zod 4.6.7，125 个非测试 .ts）：AOT compileTS 成功 8/125 = 6.4%。阻塞点：104 匿名默认导出、10 export * re-export、1 命名空间导入捕获、1 emitter 崩溃(reading kind)。结构性事实：功能缺口沿 import 图传播——util.ts 自身无匿名导出，因 import 链传到 km.ts 整体失败。静默语义错误（最严重）：Map.set(k,obj) 后 Map.get(k) 取不到 obj；V8 输出 gname=a eq=true，AOT 输出 gname=undefined eq=undefined；m.size=1、m.has(1)=true 正确但值非同一句柄；不抛异常、编译成功、结果错误。已成立：numWork 348ms vs 解释器 9885ms=28.3x，audit_diff 47/47，stress_aot 870例0diff，内存 13.9->5.8MiB。判断：数值场景可用，通用 TS 应用不可用，Map 静默错误必须先修。"
  source: src/qzvm/aot/READINESS.md
  affects: [aot-readiness]
