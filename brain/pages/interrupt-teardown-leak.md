---
id: interrupt-teardown-leak
title: "interrupt 打断后残留有根 JS 对象：qz_destroy 命中 quickjs 断言（NDEBUG 下静默泄漏）"
category: project
status: active
tags: [quickjs-ng, ctl, interrupt, teardown, leak]
created: "2026-09-30T00:42:01"
updated: "2026-10-02T23:27:31"
---

<!-- compiled_truth -->
## 结论（2026-10-02 已修复，valgrind 实测零泄漏；根因第一性收敛到 1 个 bytecode 引用）

打断（uncatchable InterruptedError）会让部分 GC 对象残留 **GC 不可见的外部引用**，refcount>0 留在 `rt->gc_obj_list`。`gc_free_cycles` 只处理 `tmp_obj_list` 里 refcount==0 的对象，故逃过回收，arena 内存（含 polyfill bytecode）真泄漏。

### 第一性原理：正确的度量是 gc_decref 之后的 refcount
此前排查全部徒劳，因为一直在测 **GC 完成后** 的 refcount——那是"外部引用 + gc_scan incref 回来的子引用"的**混合值**，其中大部分来自 GC 自己刚加的边。`top_rc=2466/1552` 全是假的。

正确度量 = `gc_decref` 之后、`gc_scan` 之前 的 refcount（= 纯外部引用，因为 gc_decref 已减掉所有对象间引用）。换上这个度量，**3474 → 3**：

```
DECREF-EXT survivors=3   hist[bcode=1, shape=1, ctx=1]
```

- `ctx` (rc=1) —— 正常根，`rt->context_list` 持有
- **`FUNCTION_BYTECODE` (rc=1)** ★ 幽灵，撑住 3471 个对象（polyfill 整个函数树）
- **`SHAPE` (rc=1)** ★ 幽灵（bytecode 的一部分）
- 对照组全程 `survivors=0`（干净）

已逐层验证 GC 遍历是完整的：`func_obj → js_bytecode_function_mark → bytecode` ✓、`FUNCTION_BYTECODE → b->realm` ✓、`JS_MarkContext` 遍历 ctx 全部字段 ✓。qzjs 侧无字段持有它。故打断执行期间存在一次**引用转移遗漏**（`JS_ReadObject2` 建 bytecode 时 refcount=1，转交后未归零的那一个）。

**被实验推翻的假设**：uncatchable 时操作数栈不释放（`quickjs.c:20996`，那个 while 循环把"释放引用"和"匹配 catch handler"耦合在同一条件）看起来像 bug，但 `done:` 标签（`quickjs.c:21028`）已有兜底循环覆盖操作数栈。实验否定了它。**代码看起来像错的地方，未必是错的地方**——只有实验能裁决。

### 实测证据（valgrind，Release/NDEBUG）
- 修前：`definitely lost: 88,003 B / 74 blocks` + `indirectly lost: 70,629 B`
- 修后：`in use at exit: 0 bytes`，`1,357 allocs / 1,357 frees` 完全平衡

**重要纠正**：此前「仅 ISOLATED 受影响、Release 静默通过」的判断是错的。Debug 的 `assert` abort 掩盖了泄漏。valgrind 证明 Release 下同样泄漏 ~158KB/次，THREAD 模型反复 create/destroy 必然累积。

### 修法
`deps/quickjs-ng-teardown-sweep.patch`：`JS_FreeRuntime` 中 `JS_RunGC()` 之后调 `gc_force_sweep()`，把 `gc_obj_list` 里残留的 `JS_OBJECT`/`FUNCTION_BYTECODE` 移入 `tmp_obj_list`，再调 `gc_free_cycles` 走标准 `free_object` 路径释放。复用 `gc_phase==REMOVE_CYCLES` 保护。剩余无主 shape/proto 不强释（避免 double-free），仅报告。**清扫是兜底**——治的是"teardown 时仍有存活对象"（teardown 是 rt 生命周期终点，此刻任何 GC 对象都不该存活），不是"引用泄漏"本身。

### 门禁（两层，各司其职）
1. `control_.interrupt_actually_aborts_running_script`（Debug）—— 从 `DISABLED_` 转正为常规回归，Debug 下命中 `gc_obj_list` 断言即红。
2. `control_.interrupt_then_destroy_does_not_accumulate_across_cycles`（Release/仅 NDEBUG）—— RSS 累积判据，Debug 下 GTEST_SKIP（同阈值跨构建复用会恒红）。反复 create→打断→destroy 8 轮看 RSS 是否单调累积。**不用 metrics 的 heap_bytes**：实测它在有无修复时完全相同（5329 字节一字不差）——它量的是 rt 存活期间的引擎占用，泄漏发生在 destroy 之后。双向验证：修复在→8轮零增长；修复移除→第2轮起逐轮报警，160/332/496…每轮正好 160KB 且线性，与 valgrind 158KB/次吻合。阈值 128KB。

### 影响评估（2026-10-02 补充实测）
**运行时零累积，销毁期已修，遗留无已知故障场景。** 用探针实测单 runtime 存活期间反复 interrupt 20 轮：RSS **恒定 7104 KB，零累积**。原因：打断残留只在那一批打断发生时产生，撑住的是那一次执行的对象图；后续打断产生独立一组，不叠加。

剩余"引用来源未定位"的实际影响：
- **不影响正确性**——无 UAF/崩溃/数据损坏；sweep 在 teardown 安全释放
- **不影响性能**——一次打断约 160KB 残留，对真实 runtime 规模可忽略
- **理论风险（无证据）**——若这条不对称在**其他触发条件下**也以更大规模存在，可能出问题；但至今所有测试全绿（Debug 29/29 + Release 16/16 + test262）

结论：遗留的价值在"知道引擎里有个不对称"这个排查结论本身（将来遇"打断后行为诡异"能省 16 轮无效排查），不在它现在能造成什么损害。消除它需打断瞬间的引用图快照，投入产出比低，无对应故障场景等着。

### patch 应用幂等性（踩坑记录）
该 patch 的 hunk 上下文（`void JS_FreeRuntime(JSRuntime *rt)\n{`）在应用后**仍匹配**，`patch -p1 -f` 会 fuzz 重复应用 → `redefinition of 'gc_force_sweep'`。且 `execute_process(... RESULT_VARIABLE)` 配 `OUTPUT_QUIET` 的 grep 退出码探测在此不可靠。最终用纯 CMake `file(READ)` + `string(FIND)` 判定——连跑 3 次 configure 稳定 1 份定义。


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

- time: 2026-10-02T15:16:30
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [interrupt-teardown-leak]

- time: 2026-10-02T23:27:31
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [interrupt-teardown-leak]
