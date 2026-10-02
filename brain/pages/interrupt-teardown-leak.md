---
id: interrupt-teardown-leak
title: "interrupt 打断后残留有根 JS 对象：qz_destroy 命中 quickjs 断言（NDEBUG 下静默泄漏）"
category: project
status: active
tags: [quickjs-ng, ctl, interrupt, teardown, leak]
created: "2026-09-30T00:42:01"
updated: "2026-10-02T03:07:13"
---

<!-- compiled_truth -->
## 结论（2026-10-02 已修复，valgrind 实测零泄漏）

打断（uncatchable InterruptedError）会让部分 GC 对象残留**GC 不可见的外部引用**，refcount>0 留在 `rt->gc_obj_list`。而 `gc_free_cycles` **只处理 `tmp_obj_list` 里 refcount==0 的对象**，故这些对象逃过回收，其 arena 内存（含 polyfill bytecode）真泄漏。

### 实测证据（valgrind，Release/NDEBUG）
- 修前：`definitely lost: 88,003 bytes in 74 blocks` + `indirectly lost: 70,629 bytes`；栈 `JS_ReadObjectRec → JS_ReadObject2 → qz_ctx_create_at`（polyfill 字节码）
- 修后：`in use at exit: 0 bytes in 0 blocks`，`1,357 allocs / 1,357 frees` 完全平衡

**重要纠正**：此前「仅 ISOLATED 受影响、Release 静默通过」的判断是错的。Debug 的 `assert` abort 掩盖了泄漏。valgrind 证明 **Release 下同样泄漏 ~158KB/次**，THREAD 模型反复 create/destroy 必然累积——必须修。

### 修法
`deps/quickjs-ng-teardown-sweep.patch`：`JS_FreeRuntime` 中 `JS_RunGC()` 之后调 `gc_force_sweep()`，把 `gc_obj_list` 里残留的 `JS_OBJECT`/`FUNCTION_BYTECODE` 移入 `tmp_obj_list`，再调 `gc_free_cycles` 走标准 `free_object` 路径释放。复用 `gc_phase==REMOVE_CYCLES` 保护（refcount≠0 也经 `gc_zero_ref_count_list` 统一 `js_free_rt`）。剩余无主 shape/proto **不强释**（避免 double-free 崩溃），仅 fprintf 报告。

### 遗留：不可见引用的**来源**仍未定位
清扫是**兜底**——泄漏归零，但不解释那 3474 个对象为何被引用。此前排除 16 个方向（全部 C 扩展/WAMR/timer_resolves/current_stack_frame/var_ref（682 个全 detached）/ctx slot/global/promise/job queue/module ns/操作数栈/ctx 内部环等）。作为独立上游议题跟进，不阻塞主线。

### 门禁
`control_.interrupt_actually_aborts_running_script` 已从 `DISABLED_` **转正**为常规回归测试（Debug 下命中 `gc_obj_list` 断言即红），防该泄漏回归。

### patch 应用幂等性（踩坑记录）
该 patch 的 hunk 上下文（`void JS_FreeRuntime(JSRuntime *rt)\n{`）在应用后**仍然匹配**，`patch -p1 -f` 会 fuzz 重复应用，导致 `redefinition of 'gc_force_sweep'`。且 `execute_process(... RESULT_VARIABLE)` 配 `OUTPUT_QUIET` 的 grep 退出码探测在此不可靠。最终用纯 CMake `file(READ)` + `string(FIND)` 判定符号是否存在——连跑 3 次 configure 稳定 1 份定义。


## Timeline

- time: 2026-09-30T00:42:01
  kind: decision
  summary: "Created this page: interrupt 打断后残留有根 JS 对象：qz_destroy 命中 quickjs 断言（NDEBUG 下静默泄漏）"
  source: "2026-09-30 M-P7 评审补 interrupt 效果测试时挖出"
  affects: [interrupt-teardown-leak]

- time: 2026-09-30T00:42:45
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "brain update-truth: interrupt 打断后残留有根 JS 对象"
  affects: [interrupt-teardown-leak]

- time: 2026-10-01T14:03:42
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "2026-10-01 深度诊断（systematic-debugging）"
  affects: [interrupt-teardown-leak]

- time: 2026-10-01T16:01:29
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "2026-10-01 vanilla 对照实验：归属被推翻，根因在 qzjs 集成层"
  affects: [interrupt-teardown-leak]

- time: 2026-10-01T16:23:54
  kind: evidence
  summary: "第二轮深挖：已排除 7 个方向，仍未定位根因，但确立三个架构级事实。①ctx 从未被真正释放：qzjs 的 polyfill 有 143~2466 个函数对象各持一份 realm 引用，ctx->refcount 永不为 0，JS_FreeContext 每次在第一行提前 return——不 interrupt 的正常路径（eval_ok）同样是 rc=143 且残留 3472 个对象，全靠 JS_FreeRuntime 的 GC 兜底。②interrupt 不是根因，只是把「碰巧兜得住」推成「兜不住」：打断/不打断两组 ctx 状态完全相同（rc=2466、global_tag=-1），唯一差别是残留数 3472 vs 3474，而这 2 个对象翻转了 cycle collector 的判定。③ctx->global_obj 在 JS_FreeContext 入口已是 UNDEFINED，而 quickjs 全文只有 JS_NewContext 一处赋值它、JS_FreeContext 只 FreeValue 不置 UNDEFINED——说明 global 是被 qzjs 侧（qz_ext_destroy_all/qz_ctx_cleanup_resources 一带）释放的，但释放后那 2466 个函数对象仍存活，rc 未降。强制 rc 归零会立刻崩溃（持有者是活对象，UAF），所以不能暴力归零。已排除：解释器操作数栈未展开、ctx refcount 异常、error_back_trace/current_exception 残留、嵌套深度、Promise/async、闭包密度、interrupt 后继续执行、三个 patch。剩余未知：谁在 global 之外持有那 2466 个函数对象。下一步应查 qz_ctx_destroy 里 qz_ext_destroy_all/qz_ctx_cleanup_resources 释放了什么 JS 引用"
  source: "2026-10-01 第二轮系统化调查"
  affects: [interrupt-teardown-leak]

- time: 2026-10-01T16:50:23
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "2026-10-01 第二轮收尾：根因锁定为 quickjs ctx 内部引用环，qzjs 侧无法修"
  affects: [interrupt-teardown-leak]

- time: 2026-10-01T23:46:11
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "2026-10-01 第一性复核：推翻 ctx 内部环根因，收敛为 vanilla 靠级联释放归零而 qzjs 打断后函数对象不可达"
  affects: [interrupt-teardown-leak]

- time: 2026-10-02T03:07:13
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [interrupt-teardown-leak]
