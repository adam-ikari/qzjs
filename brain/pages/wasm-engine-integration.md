---
id: wasm-engine-integration
title: "WAMR 引擎集成要点"
category: decision
status: active
tags: [wasm, wamr, threading]
created: "2026-08-15T01:32:50"
updated: "2026-10-14T12:28:34"
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

# 导出 memory 的 buffer 是活 getter（不是快照）

- `exports.memory.buffer` 实现为 getter（`wamr_memory_class`，owner 持 `instance_ref`
  + live `wasm_module_inst`），每次读都重新查 WAMR 当前 base/size。**绝不能**在
  instantiate 时缓存一个固定 ArrayBuffer：WAMR 会因 guest malloc / memory.grow
  增长甚至搬迁线性内存，旧 buffer 的 byteLength 卡死 → 宿主越界读写静默出错。
- identity 语义：页数与 base 未变时返回**同一个** ArrayBuffer（spec：`mem.buffer
  === mem.buffer`）；变化时 `JS_DetachArrayBuffer` 旧 buffer（浏览器 neuter，旧视图
  byteLength 变 0，强制宿主重读）再建新 buffer。
- **不提供 host 侧 `Memory.grow()`**：WAMR 的 SHRUNK_MEMORY/折页表示下
  `wasm_memory_get_cur_page_count` 会把折入的 app heap 算进去（实测声明
  `(memory 1 4)` 的模块报 129 页），返回的"旧页数"不合约语义。guest 自己的
  `memory.grow` 指令照常工作（含 memory.grow 的模块不会被 shrink 折页）。
- 回归：`test_wasm_aot.memory_buffer_is_live_across_grow`（guest 侧 grow 后验证
  buffer 刷新、旧视图 detach、宿主/guest 写入一致、identity 稳定）。旧快照行为已证伪
  （测试在快照实现下 `grew=false detached=false`）。

## Timeline


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

- time: 2026-10-14T03:25:54
  kind: decision
  summary: "导出 memory 的 buffer 改为活 getter（非快照）：WAMR 增长/搬迁线性内存后固定 ArrayBuffer 让宿主越界读写（旧实现 byteLength 卡死）。wamr_memory_class 持有 instance_ref + live wasm_module_inst + 缓存 last_ab/last_len/last_base；页数或基址变化时重建并 JS_DetachArrayBuffer 旧 buffer（浏览器 neuter 语义），否则返回同一 buffer（identity 稳定）。删死的 wamr_mem_owner_t/realloc shim，修 atom 泄漏（JS_FreeAtom）+ getter 用 JS_NewCFunction2(JS_CFUNC_getter)。裁决：不提供 host 侧 Memory.grow()——WAMR 折页表示下 cur_page_count 含折入的 app heap，旧页数返回不合约语义（实测 (memory 1 4) 报 129 页）；guest 侧 memory.grow 照常工作。回归测试 test_wasm_aot.memory_buffer_is_live_across_grow（已证伪旧快照行为）。"
  source: "ext_wamr.c memory 导出修复 + ctest 32/32"
  affects: [wasm-engine-integration]

- time: 2026-10-14T03:26:08
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "ext_wamr.c memory 导出活 getter 修复"
  affects: [wasm-engine-integration]

- time: 2026-10-14T12:28:34
  kind: evidence
  summary: "WAMR teardown GC 回收修复：JS_FreeRuntime 断言 gc_obj_list 非空（test_wasm_aot shrunk_memory_export_length 失败）。根因两处：(1) wamr_ext_destroy 清零 wamr_*_class_id，而 teardown 顺序是 ctx_destroy→JS_FreeRuntime，后者内部 JS_RunGC 的 finalizer/gc_mark 靠 class_id 经 JS_GetOpaque 取 wrap；清零后 finalizer 拿不到 wrap 直接 return → instance wrap 的 module_obj 永不释放（wasm3 后端早写明同款陷阱并避免清零）。(2) WebAssembly.Module/Instance/Global/Memory 顶类缺 gc_mark，opaque 内 JSValue 强边（module_obj、instance_ref、import closure js_func、memory last_ab）对循环收集器不可见 → 引用环不可回收。修：删 destroy 里的 class_id 清零；给 instance/global/memory 三顶类加 gc_mark 回调。两处缺一不可（双向反证：单独去 gc_mark 或单独留清零都仍断言失败）。验证：test_wasm_aot/imports/streaming 三套 23/23 全绿 + qzjs/context/worker/multi_instance/compress/strict_mode 全绿。"
  source: "2026-10-14 ext_wamr.c teardown 修复 + gdb watchpoint 定位"
  affects: [wasm-engine-integration]
