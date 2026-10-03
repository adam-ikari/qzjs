---
id: interrupt-teardown-leak
title: "interrupt 打断后残留有根 JS 对象：qz_destroy 命中 quickjs 断言（NDEBUG 下静默泄漏）"
category: project
status: active
tags: [quickjs-ng, ctl, interrupt, teardown, leak]
created: "2026-09-30T00:42:01"
updated: "2026-10-03T02:48:10"
---

<!-- compiled_truth -->
## 结论（2026-10-03 根因定案并根治：qzjs 侧漏释放 JS_GetException 的返回值）

打断后销毁泄漏的真根因**在本仓库，不在 vendored quickjs-ng**。

### 根因

打断必然抛 uncatchable InternalError。本仓库 5 处写成 `JS_GetException(ctx);` —— **丢掉了返回值**。
`JS_GetException` 是**转移**语义（把 `current_exception` 的所有权交给调用方并清空槽），丢弃返回值
= 丢掉一次引用的所有权。那个 Error 对象 refcount 永远回不到 0，而它经 error backtrace 撑住整棵
解释器栈帧图，于是 `gc_obj_list` 永远非空。

修法：补上 `JS_FreeValue(ctx, JS_GetException(ctx));`
- `src/bridge.c:164`（`qz_js_call_cleanup` —— 打断路径必经）
- `src/bridge.c:1551`（非法实参退回 MESSAGE）
- `src/bridge.c:1692`（OOM 建 ArrayBuffer 跳过帧）
- `src/worker.c:108`、`src/worker.c:114`（error 事件派发）

### 验证

撤掉 `deps/quickjs-ng-teardown-sweep.patch`（整个 patch 已删除），仅靠上述 5 行：
- Debug：`control_.interrupt_actually_aborts_running_script` 通过（修前 abort）
- Release valgrind：`in use at exit: 0 bytes in 0 blocks`、`All heap blocks were freed`
- Debug ctest 29/29；Release test_control_gtest 16/16

### 被推翻的结论（此前记录于此，现作废）

1. **「引擎在打断路径上存在引用转移不对称」——错误。** 没有任何引擎缺陷。
2. **`deps/quickjs-ng-teardown-sweep.patch`（teardown 时强清 `gc_obj_list`）——已删除。**
   它确实让泄漏归零（valgrind 0 bytes），但那是**兜底不是根治**：把「销毁期还有存活对象」压下去，
   没解释「它们为何被引用」。撤掉它后仅靠 5 行修复同样零泄漏——所以它从一开始就是多余的。
3. **`mark_children` 不 mark `b->shape` 是 bug——错误。** `JSFunctionBytecode` 根本没有 shape 字段，
   bytecode 不持 shape。
4. **「uncatchable 时操作数栈不释放是根因」——错误。** `done:` 标签（`quickjs.c:21028`）已有兜底循环
   覆盖操作数栈，实验否定。

### 定位方法（这次为什么终于找到）

之前 16 轮徒劳的关键是**度量错了**：一直测 GC **完成后** 的 refcount，那是"外部引用 + gc_scan incref
回来的子引用"的混合值，信号被 GC 自己加的边淹没（`top_rc=2466/1552` 全是假的）。

换上正确的度量后一路收敛：
1. **`gc_decref` 之后**的 refcount = 纯外部引用 → 幸存者 3474 收敛到 3
2. 排除 ctx（2008 条 GC 边，正常根）→ 只剩 1 个 `JS_OBJECT`，`gc_edges=0`
3. 打印身份 → `class_id=3 (Error)` —— **打断抛出的那个 InternalError**
4. 扫 `JSRuntime`/`JSContext` 找持有者 → 全无（须排除 `list_head` 字段，其 next/prev 天然指向链表成员，
   会产生误报；`rt+1152/1160` 就是 `gc_obj_list.next/prev`）
5. 追踪该 Error 的 refcount 生命周期 → `rc=1 → dup 2 → free 1`，**停在 1**
6. 净剩的那 1 次 = `current_exception` 的原始引用 → 顺着找谁 `JS_GetException` 后没 free → 命中 qzjs

**教训**：Debug 断言触发时，先怀疑「谁的引用没释放」，别急着改引擎。teardown 兜底能消掉症状，
但会把「为什么会这样」这个问题永久埋掉。

### 门禁（两层，各司其职，均已就位）

1. `control_.interrupt_actually_aborts_running_script`（Debug）—— 转正为常规回归，命中 `gc_obj_list` 断言即红。
2. `control_.interrupt_then_destroy_does_not_accumulate_across_cycles`（仅 NDEBUG）—— RSS 累积判据，
   Debug 下 GTEST_SKIP（同阈值跨构建复用会恒红：实测 Debug 每轮涨 6.5MB 而 Release 零增长）。
   反复 create→打断→destroy 8 轮看 RSS 是否单调累积。**不用 metrics 的 `heap_bytes`**：它在有无修复时
   完全相同（5329 字节一字不差）——它量的是 rt 存活期间的引擎占用，泄漏发生在 destroy 之后。
   双向验证过：修前第 2 轮起逐轮报警 160/332/496…每轮正好 160KB 线性，与 valgrind 158KB/次吻合；修后零增长。


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

- time: 2026-10-03T01:14:48
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [interrupt-teardown-leak]

- time: 2026-10-03T02:40:54
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [interrupt-teardown-leak]

- time: 2026-10-03T02:41:16
  kind: reversal
  summary: "推翻『引擎在打断路径上存在引用转移不对称』：真根因是 qzjs 侧 5 处 `JS_GetException(ctx);` 丢弃返回值（转移语义，丢一次引用所有权），打断抛出的 Error 因此 refcount 永不归零、经 backtrace 撑住整棵栈帧图。依赖该结论的 `quickjs-ng-teardown-sweep.patch`（teardown 强清 gc_obj_list）作为多余兜底一并删除——撤掉它后仅靠 5 行修复，Debug 断言通过 + valgrind 0 bytes。qzjs 侧无引擎缺陷。"
  affects: [interrupt-teardown-leak]

- time: 2026-10-03T02:42:02
  kind: reversal
  summary: "推翻『需改 quickjs 生命周期语义，qzjs 侧无修法』（该前提是错的）：根因全程在 qzjs 自己的代码里（漏 free 一个 JSValue），不需要碰引擎。此前基于此前提在 quickjs-upstream-merge-strategy 页把 vendored quickjs 升级为『独立 fork』的决策仍然有效（理由独立于本 bug），但其对本 bug 的那段论证作废。同时作废：①『ctx 内部环是根因』；②『uncatchable 时操作数栈不释放是根因』（done: 标签已有兜底循环，实验否定）。教训：Debug 断言触发时先查『谁的引用没释放』，别急着改引擎——teardown 兜底能消症状，但会把『为什么会这样』永久埋掉。"
  affects: [quickjs-upstream-merge-strategy]

- time: 2026-10-03T02:47:22
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [interrupt-teardown-leak]

- time: 2026-10-03T02:48:10
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [interrupt-teardown-leak]
