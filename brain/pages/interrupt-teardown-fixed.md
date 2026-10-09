---
id: interrupt-teardown-fixed
title: "interrupt 打断后销毁泄漏：根因 qzjs 漏释放 JS_GetException 返回值（已根治）"
category: project
status: archived
created: "2026-10-03T10:28:52"
updated: "2026-10-03T10:29:11"
---

<!-- compiled_truth -->
## 本页说明

本页是 interrupt 打断后销毁泄漏的**最终结论**（2026-10-03 根治）。
标题更正了旧页的归属错误（旧页写「残留有根 JS 对象…命中 quickjs 断言」，把根因归给引擎——
那是被推翻的模型）。

**旧页 `interrupt-teardown-leak` 已归档但完整保留**：那里有 16 条 timeline，记录了整轮排查过程
及 2 条显式 reversal。排查方法论的价值在那里，不在本页。

## 结论（2026-10-03 根因定案并根治：qzjs 侧漏释放 JS_GetException 的返回值）

打断后销毁泄漏的真根因**在本仓库，不在 vendored quickjs-ng**。

### 根因

打断必然抛 uncatchable InternalError。本仓库 5 处写成 `JS_GetException(ctx);` —— **丢掉了返回值**。
`JS_GetException` 是**转移**语义（把 `current_exception` 的所有权交给调用方并清空槽），丢弃返回值
= 丢掉一次引用的所有权。那个 Error 对象 refcount 永远回不到 0，而它经 error backtrace 撑住整棵
解释器栈帧图，于是 `gc_obj_list` 永远非空。

修法：补上 `JS_FreeValue(ctx, JS_GetException(ctx));`
- `src/host/bridge.c:164`（`qz_js_call_cleanup` —— 打断路径必经）
- `src/host/bridge.c:1551`（非法实参退回 MESSAGE）
- `src/host/bridge.c:1692`（OOM 建 ArrayBuffer 跳过帧）
- `src/host/worker.c:108`、`src/host/worker.c:114`（error 事件派发）

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

- time: 2026-10-03T10:28:52
  kind: decision
  summary: "Created this page: interrupt 打断后销毁泄漏：根因 qzjs 漏释放 JS_GetException 返回值（已根治）"
  source: "改进自 interrupt-teardown-leak（该页归档保留全部排查历史）"
  affects: [interrupt-teardown-fixed]

- time: 2026-10-03T10:29:11
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [interrupt-teardown-fixed]
