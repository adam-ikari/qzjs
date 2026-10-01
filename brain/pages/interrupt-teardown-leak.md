---
id: interrupt-teardown-leak
title: "interrupt 打断后残留有根 JS 对象：qz_destroy 命中 quickjs 断言（NDEBUG 下静默泄漏）"
category: project
status: active
tags: [quickjs-ng, ctl, interrupt, teardown, leak]
created: "2026-09-30T00:42:01"
updated: "2026-10-01T16:23:54"
---

<!-- compiled_truth -->
## 结论（2026-10-01 复核，前两版结论均已被推翻）

**打断正在执行的脚本会留下有根 JS 对象；`qz_destroy` 命中
`quickjs.c: JS_FreeRuntime: Assertion 'list_empty(&rt->gc_obj_list)'`。**

### 归属修正：不在上游，在 qzjs 集成层（2026-10-01）

原记录断言「根因在 vendored quickjs-ng 的不可捕获中断展开路径，不在本仓库
代码里」——**该归属错误，已被 vanilla 对照实验推翻**。

同一份打了 3 个 patch 的 libqjs，用 vanilla C 程序跑「interrupt + 销毁」，
6 组场景全部干净 teardown：

| 场景 | 结果 |
|---|---|
| 顶层死循环 + interrupt | OK |
| 三层嵌套调用 + interrupt | OK |
| Promise executor / async 函数 + interrupt | OK |
| 500 个全局闭包 + interrupt | OK |
| interrupt 后继续 eval（6*7=42） | OK |
| interrupt 后再新建 200 个闭包 | OK |

故 **patch 不是原因，quickjs 解释器不是原因**。故障在 qzjs 集成层——
qzjs 相比 vanilla 只多两样：① polyfill 字节码（数千对象挂 global）
② 消息投递链（邮箱 → JSON.parse → 调 onmessage）。

两者**单独**都干净（ctest 28/28 无 interrupt 正常销毁；上表 interrupt 无 polyfill），
**组合**才泄漏。组合为何触发，目前无证据，未解释。

### 已被实证排除的方向（勿重复走）

1. **解释器操作数栈未展开**（前版主推结论）：泄漏 3474 个对象 class 0–16 全覆盖，
   量级与类型分布都对不上「栈上临时值」。两版修复均失败——无条件展开栈使 qjsc
   自身泄漏 294 对象（generator 的 `sf->cur_sp = sp` 语义被破坏）；释放栈值但保持
   `sp` 不变则段错误（`done:` 路径本就依赖「uncatchable 时栈未被触碰」的契约）。
2. **ctx refcount 异常**：实测 `JS_FreeContext` 时 rc 高达 142–373，但
   **不 interrupt 的正常测试同样是 143–208 且干净销毁**。rc 高是 polyfill 常态，
   qzjs 本就不靠 `JS_FreeContext` 清理（它提前 return），靠 `JS_FreeRuntime` 最终 GC。
   此线索完全无效。
3. **error_back_trace / current_exception 残留**：二分清理后 rc 不降（142→142）。
4. **嵌套深度 / Promise / async / 闭包密度 / interrupt 后继续执行**：见上表全干净。
5. **三个 patch（c99-atomics / drain-jobs / bc-reader-hardening）**：vanilla 实验用的
   就是打过 patch 的库，全干净。

### 泄漏画像（唯一确定的事实）

`JS_FreeRuntime` 断言前 dump `gc_obj_list`：**3474 个对象**，
`ref0=0`（无「GC 未扫」的悬挂对象，**全部有引用者**），
`ref1=2804`，`maxref=2466` —— 存在一个容器对象持有几乎全部引用。
即：**一整棵仍可达的对象图**，`JS_RunGC` 跑完仍在。锚点身份未定位。

### 下一步

在 qzjs 内做快照 diff：polyfill 加载完成后 dump 一次 `gc_obj_list` 的 class 分布，
interrupt 后再 dump，差出来的即被 interrupt 钉住的对象，可反推引用来源。


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
