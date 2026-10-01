---
id: interrupt-teardown-leak
title: "interrupt 打断后残留有根 JS 对象：qz_destroy 命中 quickjs 断言（NDEBUG 下静默泄漏）"
category: project
status: active
tags: [quickjs-ng, ctl, interrupt, teardown, leak]
created: "2026-09-30T00:42:01"
updated: "2026-10-01T23:46:11"
---

<!-- compiled_truth -->
## 结论（2026-10-01 第一性复核，ctx 内部环根因已被推翻）

打断正在执行的脚本会留下 3474 个有根 JS 对象，`qz_destroy` 命中
`JS_FreeRuntime: Assertion 'list_empty(&rt->gc_obj_list)'`。

### 当前最准确的理解（仍有缺口）

`ctx->ref_count` 高（143–2466）是**常态**，不是 qzjs 特有——vanilla 程序创建
500 个全局闭包后 rc 高达 1552。**ctx 内部环不是根因**（此前结论已被推翻）。

**关键机制（vanilla 实证）**：rc 归零靠**函数对象的级联释放**。每个字节码函数
对象释放时走 `quickjs.c:37218 JS_FreeContext(b->realm)` 释放其 realm 引用，
rc 逐层递减。vanilla 里 500 个函数挂在 K 数组上，`JS_FreeValue(r)` 释放 K →
级联释放所有函数 → 每个函数释放 realm → rc 从 1552 递减到 0 → 真正释放 ctx。

**qzjs 打断后卡住的原因**：3474 个残留对象 `ref0=0`（全部有引用者，是可达的）
→ 函数对象未被级联释放 → realm 引用未释放 → rc 减不到 0。这些可达对象构成的
是 cycle collector **识别不了**的环（C 内部结构如 ctx slot / realm 的环，
collector 只认对象属性环，不认 C 结构环）。

**缺口**：打断后那 3474 个对象的**引用者**究竟是谁，仍未定位。曾假设 ctx slot
（class_proto / function_ctor / global_obj 等）持有——但 vanilla 也有这些 slot
且能归零，故 slot 本身不是充分条件。打断到底改变了哪些对象的引用关系（使
「可回收」变「可达」），仍是未知。

### 已实证排除（勿重复走）

1–8 同前版（操作数栈 / rc 异常 / current_exception / error_back_trace /
global 属性持有者 / vanilla 各场景 / 三个 patch / 强制 rc=1）。
9. **ctx 内部引用环**（上一版锁定的根因）——vanilla rc 同样高（1552）且能递减
   归零，故该环不是「永不释放」的原因。

### 两处此前的错误结论（已推翻）

- ❌「ctx->global_obj 已被释放」——误读 tag 编码（OBJECT=-1 / UNDEFINED=3）。
- ❌「根因是 ctx 内部引用环」——vanilla 同环能归零，非根因。

### 修复评估

这需要定位「打断改变了哪个 C 结构持有函数对象」，属于改 quickjs 生命周期语义
的深度问题。qzjs 侧无可行修法（碰不到 ctx 内部 slot）。合理选项仍是：
上游报给 quickjs-ng / 深度改 quickjs / 暂缓并保留 DISABLED 测试。


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
