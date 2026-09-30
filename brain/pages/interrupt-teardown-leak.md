---
id: interrupt-teardown-leak
title: "interrupt 打断后残留有根 JS 对象：qz_destroy 命中 quickjs 断言（NDEBUG 下静默泄漏）"
category: project
status: active
tags: [quickjs-ng, ctl, interrupt, teardown, leak]
created: "2026-09-30T00:42:01"
updated: "2026-09-30T00:42:45"
---

<!-- compiled_truth -->
## 结论

**打断正在执行的脚本会留下有根（rooted）的 JS 对象；之后对该运行时调 `qz_destroy` 会在
quickjs 的断言上终止。** 任何带断言的构建（所有 Debug 构建，含 CI 的 `asan` / `ubsan`
两个 job）里 `qz_destroy` 直接 abort；`NDEBUG` 构建里断言被编掉，那批对象**静默泄漏**。

这不是「只在测试里出现」的问题：宿主只要用过 `interrupt`，再销毁该运行时，就踩得到。

## 断言点与机制

```
quickjs.c:2762: JS_FreeRuntime: Assertion `list_empty(&rt->gc_obj_list)' failed
```

链路：`qz_ctl_interrupt_handler`（`src/control.c`）在 `ctl_interrupt` 原子标志为真时返回 1
→ quickjs `__js_poll_interrupts` 调 `JS_ThrowInterrupted` → 抛一个 **uncatchable** 的
InternalError 并 longjmp 展开 → 展开点上的解释器临时值就此无人回收。拆除流程最终走到
`JS_FreeContext` + `JS_FreeRuntime`，而后者要求 `gc_obj_list` 已空。

本项目**已经知道这一类问题**：`src/qzjs.c` 的拆除里专门有一步「排空 pending JS jobs
BEFORE freeing contexts/runtime」，注释里写的理由就是这个断言（Promise 反应引用着尚未
执行的闭包/值）。但那一步处理的是「我们自己有活儿没干完」，救不回「解释器展开时丢掉的
临时值」这种情况。

## 最小复现（不依赖任何测试框架）

1. 建一个 `onmessage` 里 `while (Date.now() - t < 3000) { x++; }` 的运行时；
2. `qz_post_message` 发一条触发它；
3. 150ms 后发 `{"op":"interrupt"}`（**不带 correl** 即可，见 M-P7 那条 interrupt 豁免）；
4. 排干邮箱；
5. `qz_destroy` → 就在此断言。

**对照组**：同一脚本**不发 interrupt** 时销毁干净 —— 所以与脚本本身无关，与 interrupt 有关。

## 归属

根因在 vendored `deps/quickjs-ng` 的不可捕获中断展开路径（`JS_ThrowInterrupted` +
longjmp），**不在本仓库代码里**。要修只有两条路：向上游提 issue / 换展开方式；或者
qzjs 侧在拆除前主动清点什么——但目前没找到解释器丢掉的那些值有任何可及的引用。

## 当前处置

- **未修**（跨 vendored 依赖的语义问题，不在本轮范围）。
- 对应测试保留为 `test_control_gtest.cpp` 的
  `DISABLED_interrupt_actually_aborts_running_script`（**不是删掉**）：删掉等于把
  「interrupt 的效果从未被验证过」这件事重新藏起来，而那正是补测试要补的洞。注释里有
  缺陷、机制、复现与归属。**启用前必须先修掉本缺陷**，否则 asan / ubsan 两个 job 一直红
  ——一个常红的门等于没有门。
- 宿主侧的处置建议（写在这里供将来参考，尚未进正式文档）：避免在带断言的构建里
  对用过 interrupt 的运行时直接 `qz_destroy`；或先修上游。

## 附带记下的方法论

interrupt 一直只验**回执**（`test_ctl_e2e.sh` 那条「回执里有没有 `interrupted:true`」），
而那张回执是 dispatch 路径**无条件**产出的，与引擎有没有真被打断毫无关系。所以中断
处理器从没装上、标志读错、JS 侧不检查它，全部测试照样绿。

**回执层面的断言不能替代效果层面的断言。** 凡是「机制声称在某个时刻生效」的契约
（interrupt 在指令边界生效、ping 有回执、quiesce 后不再产生新消息……），判据必须落在
那个时刻上，而不是落在「关于它的报告」上。


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
