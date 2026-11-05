---
id: wpt-runner-removed
title: "WPT runner 移除：WinterTC 覆盖转向 gtest"
category: decision
status: active
tags: [wpt, wintertc, testing, libuv-native]
created: "2026-08-18T08:11:31"
updated: "2026-10-13T08:18:12"
---

<!-- compiled_truth -->
## 决策
WinterTC Web API 合规测试不再使用 WPT runner（vendored .any.js + testharness.js），改为 gtest 套件覆盖。

## 背景
- test/wpt_runner.c（依赖 pal_mock）在 libuv-native 重构（commit 207e0b7e，移除整个 PAL 抽象）时被删除。
- wpt_runner 当时是 wip 骨架，未接入 CMake；build 里的旧产物仍可跑旧数据但已过时。
- test/wpt/ 目录（vendored .any.js + testharness.js）保留作参考，但不在构建/CI 中。`wpt_shell_report.js`（自定义 shell report）在 `test/` 下（非 `test/wpt/`），随 runner 保留。

## 原因
1. mock_libuv（新模型）是确定性离线测试，与 gtest 统一（crypto-subtle-gtest 决策同源）
2. wpt_runner 依赖已删除的 pal_mock API（pal_mock_create + qz_eval）
3. 项目 gtest 套件已覆盖 WinterTC API（URL/URLPattern/FormData/Event/Blob/console/timers/crypto.subtle）——当时（2026-08-19）为 13 个套件；现（2026-10）test/CMakeLists.txt 已注册 31 个 `add_qz_gtest`。

## 现状（2026-08-19，Phase 3 完成后）
- WinterTC API 覆盖位于 offline gtest：test_polyfill_gtest（Console/Timer/Encoding/URL/URLPattern/FormData/Event/EventTarget/Abort/Storage/Fetch/streams/BYOB/structuredClone）、test_crypto_subtle_gtest、test_fetch_stream_gtest、test_bridge_*_gtest、test_worker_gtest
- Phase 3（2026-08-19）新增边界用例套件：TextDecoderEdgeCases、UrlSearchParamsEdgeCases、StreamEdgeCases、EventTargetEdgeCases（含 AbortSignal）。现 test_polyfill_gtest.cpp 中 *EdgeCases/*Boundary 测试共 11 个（上述 4 个之外另有 BlobEdgeCases、BtoaAtobEdgeCases、CacheStorageEdgeCases、EncodeIntoEdgeCases、EventSourceParserFieldEdgeCases、HeadersEdgeCases、UrlSearchParamsBoundary）。
- Phase 3 暴露并修复 3 个真实 bug：
  1. TextDecoder fatal:true 不抛错（补 4 处非法字节分支 TypeError）
  2. UTF-8 BOM 未剥离（新增 _BOMSeen 状态，ignoreBOM:false 时跳过 EF BB BF）
  3. AbortSignal abort 后 addEventListener 新监听器不自动调度（重写 addEventListener，微任务调度）
- Phase 2 多跳 MessagePort 转移已完成（worker multihop，纯 JS 路由，C 层无需新表）
- Phase 4 HTTPServer gzip LRU 缓存已完成（uvhttp 97bd21a，/gzip +2.25x，大响应决策不改）。**历史注**：uvhttp 子模块其后被移除，HTTPServer 改为纯 JS 实现（见 httpserver-perf-* 页）。
- 若未来要恢复 WPT，需按新模型重写 runner：HostCtx（test_host.h）+ kTestBootstrap eval 通道，处理 promise_test 的异步（host_poll_until_value）

## 参考
- [[crypto-subtle-gtest]] 同方向的 gtest 决策
- [[urlpattern-modifier-fix]] 记录了本次 WPT 基准验证（urlpattern-polyfill npm 包）


## Timeline

- time: 2026-08-18T08:11:31
  kind: decision
  summary: "Created this page: WPT runner 移除：WinterTC 覆盖转向 gtest"
  source: session 2026-08-18
  affects: [wpt-runner-removed]

- time: 2026-08-18T08:11:46
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [wpt-runner-removed]

- time: 2026-08-19T15:06:12
  kind: decision
  summary: "Phase3 gtest 覆盖扩展完成：TextDecoder/URLSearchParams/streams/EventTarget/Abort 边界补齐"
  source: session 2026-08-19 phase3
  affects: [wpt-runner-removed]

- time: 2026-10-13T08:18:12
  kind: decision
  summary: "修正失效引用与计数：①wpt_shell_report.js 实际在 test/ 下非 test/wpt/；②当时 13 套件 → 现 31 个 add_qz_gtest；③Phase3 边界套件 4 个 → 现存 11 个 *EdgeCases/*Boundary；④uvhttp 条目加历史注（子模块已移除）。"
  source: "test/CMakeLists.txt + test/test_polyfill_gtest.cpp + find test/ 实测"
  affects: [wpt-runner-removed]
