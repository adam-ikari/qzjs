---
id: wasm-engine-integration
title: "WAMR 引擎集成要点"
category: decision
status: active
tags: [wasm, wamr, threading]
created: "2026-08-15T01:32:50"
updated: "2026-10-11T02:16:51"
---

<!-- compiled_truth -->
# WAMR 线程环境（关键坑）

- WAMR 的 `thread_signal_inited` 是**线程局部**（`os_thread_local_attribute`）状态，
  而 `wasm_runtime_init()` 是进程级单例（ext_wamr 的 `g_wamr_state` 保证只 init 一次）。
- 每个 qzjs 实例跑在自己的 worker 线程（`qz_create` → `uv_thread_create`）。第二个
  及以后的实例（新线程）直接调 wasm 函数会报 "thread signal env not inited"。
- **必须**在每个实例初始化时调 `wasm_runtime_init_thread_env()`（幂等）；销毁时调
  `wasm_runtime_destroy_thread_env()` —— 后者卸载 SIGSEGV/SIGBUS handler、恢复栈
  guard pages 的 mprotect、恢复 sigaltstack。不销毁的话，下一个实例在
  `os_thread_signal_init` 的 `touch_pages` 里撞上遗留的 PROT_NONE 页直接 SIGSEGV
  （gdb 确认 SEGV_ACCERR）。
- 对称位置：`wamr_ext_init`（worker 线程内，context 创建时）/ `wamr_ext_destroy`
  （`qz_thread_teardown` → `qz_ctx_destroy`，同一线程）。

# Streaming API（v1 语义等价）

- `WebAssembly.compileStreaming(source)` / `instantiateStreaming(source, imports)`
  实现为：async IIFE（`JS_Eval` 构造）→ resolve source（Promise 或对象）→
  `source.arrayBuffer()` → 完整字节交 `WebAssembly.compile` / `instantiate`。
- 不做真·逐块流式编译（WAMR 编译前需要完整字节）；语义上对调用方等价。
- **不要用 "imports === undefined" 判断走 compile 还是 instantiate** ——
  instantiateStreaming 也可能不传 imports。用 C 侧 magic 区分两条 prog。
- source 不满足 `typeof .arrayBuffer === 'function'` 时抛 TypeError
  （与 spec 一致，reject promise）。


## Timeline

- time: 2026-08-15T01:32:50
  kind: decision
  summary: "Created this page: WAMR 引擎集成要点"
  source: created via brain create-page
  affects: [wasm-engine-integration]

- time: 2026-08-15T01:33:01
  kind: decision
  summary: "WAMR 线程环境与 streaming API 实现决策"
  source: "Task 3: compileStreaming/instantiateStreaming"
  affects: [wasm-engine-integration]

- time: 2026-08-27T08:16:16
  kind: decision
  summary: "wasm3 streaming 对等 + 引擎注册根因修复（C1）：ext_wasm3.c 补 compileStreaming/instantiateStreaming（镜像 WAMR 的 JS_Eval async IIFE，magic 0/1 区分）；修复 QZ_DEFAULT_EXTENSIONS 从不注册 wasm3 的 bug（wasm3 构建下 WebAssembly 全局缺失），新增 QZ_EXT_IF_WITH(WASM3) 槽位（CMake 已保证 WAMR/WASM3 互斥）；streaming 测试门控 WAMR OR WASM3。验证：wasm3 3/3 + WAMR 回归 3/3 + 真实 libuv CLI 端到端 instantiateStreaming add(20,22)=42。"
  source: "C1: wasm3 streaming parity + registration fix"
  affects: [wasm-engine-integration]

- time: 2026-10-11T02:16:51
  kind: evidence
  summary: "WASM i64 导出桥接修复（2026-10-11）：导出函数 i64 参数/返回值此前经 JS_ToInt64/JS_NewInt64，导致①宿主传 BigInt（规范要求的 i64 表示）被 JS_ToInt64 拒收，报 'invalid i64 argument'；②返回值 >2^31 经 JS_NewInt64 转 float64，毁掉 NaN-box 位型。改为参数 JS_ToInt64Ext（接受 BigInt）+ 返回 JS_NewBigInt64（保 64 位整数）。修后真 qzjs 可跑 AOT tagged 负载：strWork(8)=001234567、objWork(5)=40、bigAcc(3000)=3e12（>2^32 精度保持）。import 侧（wasm→JS 传 BigInt / JS→wasm 用 JS_ToInt64Ext）原本已正确，无需改。加回归门 test_wasm_aot_gtest export_i64_bigint_roundtrip（wat2wasm fixture id64/add64/hi），反向验证旧代码必失败。"
  source: "2026-10-11 ext_wamr.c i64 桥 + gtest 实测"
  affects: [wasm-engine-integration, aot-experiment-verification]
