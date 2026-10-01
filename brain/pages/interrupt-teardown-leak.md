---
id: interrupt-teardown-leak
title: "interrupt 打断后残留有根 JS 对象：qz_destroy 命中 quickjs 断言（NDEBUG 下静默泄漏）"
category: project
status: active
tags: [quickjs-ng, ctl, interrupt, teardown, leak]
created: "2026-09-30T00:42:01"
updated: "2026-10-01T16:50:23"
---

<!-- compiled_truth -->
## 结论（2026-10-01 第二轮，根因已锁定）

打断正在执行的脚本会留下 3474 个有根 JS 对象，`qz_destroy` 命���
`JS_FreeRuntime: Assertion 'list_empty(&rt->gc_obj_list)'`。

### 根因：quickjs 的 JSContext 内部引用环

```
rt → context_list → ctx
ctx → class_proto[] / native_error_proto[] / function_ctor / error_ctor / global_obj …
     → 这些对象的属性链上的 JSFunction
     → 每个函数持有 b->realm = JS_DupContext(ctx)，ctx->ref_count++
```

**ctx 自己持有引用自己的对象。** `JS_FreeContext` 要求 `ref_count == 1` 才释放
这些 slot，但 slot 内的函数持有 ctx，于是 ref_count 恒为 143–2466 > 1，
每次调用都在第一行 `if (--JS_REF_COUNT(ctx) > 0) return;` 提前返回，
slot 永不释放，ctx 与其全部对象（含 polyfill 的数千个对象）泄漏。

qzjs 因此**一直依赖 `JS_FreeRuntime` 的 GC 兜底**回收 ctx——正常路径碰巧能收
（残留 3472 属循环垃圾，cycle collector 一次 GC 清空），interrupt 使残留变成
3474，差出的 2 个对象改变了引用图形状，cycle collector 收不动，断言炸掉。

**interrupt 不是根因**，只是把「一直靠兜底且碰巧兜得住」推成「兜不住」。

### 已实证排除（勿重复走）

1. 解释器操作数栈未展开（两版修复均失败且引入新问题）
2. ctx refcount 异常（不 interrupt 路径同样 143–208 且干净）
3. `rt->current_exception` / `ctx->error_back_trace` 残留（二分清理后 rc 不降）
4. global 上的属性持有者：**teardown 时 eval 删除 global 全部属性后 rc 一丝未变**
   （143→373 与删除前完全一致），故持有者不在 global 上
5. 嵌套深度 / Promise / async / 闭包密度 / interrupt 后继续执行 —— vanilla 全干净
6. 三个 patch（vanilla 实验用的就是打过 patch 的库）
7. 强制 `ref_count = 1` 后释放 —— 立刻 UAF 崩溃（持有者是活对象）
8. 快照 diff 路线（只能给类型，给不出引用者）

### 两处此前的错误结论（已推翻，勿再引用）

- ❌「`ctx->global_obj` 已被释放 / 被 qzjs 侧置空」——**误读 tag 编码**。
  `JS_VALUE_GET_TAG` 中 `JS_TAG_OBJECT = -1`、`JS_TAG_UNDEFINED = 3`，
  我把 `-1` 当成了 UNDEFINED。实际 global_obj 始终是正常对象。
- ❌「根因在 qzjs 集成层」——见上，根因是 quickjs 的 ctx 生命周期设计。

### 修复选项

- **A（qzjs 侧，不可行）**：qzjs 无法访问 ctx 内部 slot；打破环需改 quickjs。
- **B（改 quickjs）**：给 `JS_FreeContext` 增加「无视 refcount 强制释放 slot」的
  路径，或在 JS_NewContext 时让 slot 内的 realm 引用不计入 ctx refcount。
  属改动 quickjs 生命周期语义的上游级修改。
- **C（上游）**：向 quickjs-ng 报告该缺陷（ctx 内部环导致 ctx 永不释放）。


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
