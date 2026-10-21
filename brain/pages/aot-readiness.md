---
id: aot-readiness
title: "AOT 生产级就绪度：6.4% 真实库覆盖 + Map 静默错误两项独立致命"
category: decision
status: active
tags: [aot, readiness, wamr]
created: "2026-10-21T07:15:23"
updated: "2026-10-21T07:33:29"
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

- time: 2026-10-21T07:33:29
  kind: reversal
  summary: "Map 静默错误已修复（推翻「根因在 Map set/get 句柄装箱」的初判）。真实根因：build.js 两处丢弃 compileTS 返回的 fields 字段偏移表——(1) 写 .meta.json 时未带 fields，(2) makeQzvm(strings,{arenaEnd}) 未传 fields。glue 里 fieldEntries 恒空 → qzvm 的 toJS 判据 (mem && fieldEntries.length) 为假 → POJO 句柄走 handles[idx]（undefined）而非 materialize()。影响面是全局性而非 Map 专属：任何跨宿主边界的对象字面量都会退化。验证：修复前 glue_audit 1/5，修复后 5/5；audit_diff 全量 corpus1..41 零 diff。关键教训：audit_diff.js 直调 compileTS 后手动 makeQzvm(r.strings,{fields:r.fields}) 自己补了字段表，绕开 build.js glue 装配路径，故 889 例全绿仍漏检——测试路径与产物路径不一致使缺陷不可见。新增 glue_audit.js 走真实 build.js→glue→qzjs 链路，唯一能捕获装配层缺陷的测试。"
  source: "commit fix(aot): 宿主容器持有对象字面量退化成 undefined"
  affects: [aot-readiness]
