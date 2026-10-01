---
id: interrupt-teardown-leak
title: "interrupt 打断后残留有根 JS 对象：qz_destroy 命中 quickjs 断言（NDEBUG 下静默泄漏）"
category: project
status: active
tags: [quickjs-ng, ctl, interrupt, teardown, leak]
created: "2026-09-30T00:42:01"
updated: "2026-10-01T14:03:42"
---

<!-- compiled_truth -->
## 结论（2026-10-01 复核，原结论部分修正）

**打断正在执行的脚本会留下有根（rooted）的 JS 对象；之后 `qz_destroy` 命中
`quickjs.c: JS_FreeRuntime: Assertion 'list_empty(&rt->gc_obj_list)'`。**

### 本轮实测的泄漏画像

在断言前 dump `gc_obj_list`：**3474 个对象，class 0–16 全覆盖**，
`ref0=0`（无「GC 未扫」的悬挂对象，全部有引用者），
`ref1=2804`，且存在 `maxref=2466` 的对象——**有一个容器对象持有几乎全部
引用**。这**不是**原结论推测的「解释器操作数栈上的临时值」（量级与类型分布
都对不上），而是**一整棵对象图仍然可达**。

### 原展开点结论已被证伪

原页断言根因在 `JS_CallInternal` 的 exception 展开块因 uncatchable 而跳过
`while (sp > stack_buf)` 栈清理。实测**两版修复均无效**：

1. **无条件展开栈**（保留 sp 减到 stack_buf）→ qjsc 自身在编译 bytecode 时
   泄漏 294 个对象（class 109/110/111）。qjsc 在 CI 一直不泄漏，故这是补丁
   引入的回归（`done_generator:` 会 `sf->cur_sp = sp`，改 sp 破坏 generator 语义）。
2. **释放栈值但保持 sp 不变** → 段错误（exit=139），双重释放/UAF。
   说明 `done:` 后续路径本就依赖「uncatchable 时 sp 与栈未被触碰」的契约。

两版都已回滚，源码树保持 4 补丁基线。

### 已排除的假设

**ctx refcount 异常**：实测 `JS_FreeContext` 时 `JS_REF_COUNT(ctx)-1` 高达
142–269，但这是**基线常态**——未打补丁的干净 quickjs 上数值相同，且对照组
（不发 interrupt，能干净销毁）的 ctx 同样高。故 ctx 引用数与本缺陷无关。

### 现状

**仍未修**，且比原记录更深：泄漏是「一整棵对象图仍然可达」，锚点对象
（refcount≈2466）身份未确定。修复需要继续定位该锚点，或向上游提 issue。
建议诊断方向：interrupt 后立即检查 `ctx->error_back_trace` 与
`rt->current_exception` 是否残留——`build_backtrace` 在 exception 标签无条件被调，
其 backtrace 会引用整条栈帧对象图，是当前最可能的锚点（未验证）。


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
