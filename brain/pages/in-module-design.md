---
id: in-module-design
title: "in-module 档设计：按能力切分 qz_t（非 stub uv）"
category: decision
status: active
tags: [decision, build, wasm, in-module, aot]
created: "2026-10-13T03:49:29"
updated: "2026-10-13T03:49:40"
---

<!-- compiled_truth -->
## 结论

in-module（qzvm 编到 wasm32 作模块内 guest）的正确设计是**按能力切分 `qz_t`/`qz_ctx_t`**，让 libuv 类型对 guest 编译单元**不可达**；**不采用 stub uv 头**。

## 第一性推导（问题重述）

初版设计把问题设成「让现有 QZVM_SOURCES 三源（741 行）脱离 libuv 照编」，方案是 stub 头——**错**。三源不是设计出来的单元，是 src/qzvm/ 被切出时"恰好在那"的全部代码，与 guest 的需要无对应。

正确问题：**内嵌 wasm 的 JS 引擎模块运行时最少需要什么？**

答案（能力维）：引擎 + realm 生命周期 + eval/compile + microtask pump(tick) + 扩展登记 + polyfill 注入。**不要**：宿主线程/loop、消息队列/IPC、进程编排(spawn/serialize/rebuild)、文件 I/O、timer 实现、控制面/DAP/storage。

## 关键事实（已核实）

- 内核三源（context.c / vm_core.c / ext_lifecycle.c）**零直接 `uv_` 调用**（grep 计数均为 0）。
- 唯一跨层缝：`context.c:73` 的 `qz_timer_cancel`（定义在 bridge.c，libuv），在 `handle_count` 循环内；guest 无 timer → 恒 0 迭代。
- **根因**：`qz_types.h:26-30` 无条件 `#include <uv.h>`，唯一原因是 `qz_t` **值内嵌** `uv_loop_t`/`uv_thread_t`/`uv_async_t`（`qz_core.h:86-88`）+ `qz_msg_t` 内嵌 `struct uv__queue`（:94-102）。
- `qz_t` 字段**交错**（核心/宿主混排，非前后分块）→ 切分须逐字段归类，不能整块 `#ifndef`。
- `context.c` 混装：realm 生命周期（内核）+ `qz_ctx_spawn/serialize/rebuild/destroy_id`（仅被 bridge.c:2117-2172 调用 = 宿主编排）+ 文件 I/O。
- `ext_*.c`（compress/crypto/textcodec）**零 uv 引用**，纯计算，可无痛进 guest（裁剪是体积/攻击面取舍，非 libuv 阻塞）。
- `tick` 原语已存在：`src/host/thread.c:22` 的 `qz_flush_microtasks`（`JS_ExecutePendingJob` 薄封装，零 libuv），需上移进 qzvm。
- `test/mock_libuv.h` 存在正是为掩盖 qz_t 值内嵌 uv；它是**要真跑的替代实现**（拖 pthread/POSIX），与 guest「不要任何实现」语义错配 → 不复用。

## 奥卡姆裁决

- stub uv 头：❌ 让 guest 编它永不执行的代码（timer/loop/msgq）——违背"删优于加"。
- 复用 mock 类型：❌ 语义错配 + 拖 POSIX。
- **按能力切分 qz_t + 拆 context.c：✅ 采用**——唯一消除根因的方案；切完 uv include 对 guest 不可达。
- **终态即起点**：不设"先 stub 过渡、后切分"两阶段（第一性上不存在"过渡"这个物；两阶段 = 先造负债再拆，纯浪费）。

## 切分设计

- `qz_t`：核心字段（magic/jsrt/config/contexts/context_count/active_ctx_id/polyfill*）+ `#ifndef QZ_VM_GUEST` 宿主块（loop/thread/wake/msgq/proc/ipc/store/http_ops/dap_timer/ctl_*）。
- `qz_ctx_t`：核心（jsctx/context_id/extensions/polyfill*）；宿主（handles[]/timer_resolves[]/timer_cbds[]/handle_count）；`suspended`(vestigial) 可删。
- `context.c` 拆出宿主编排到新文件；`qz_types.h` uv include 移进 `#ifndef QZ_VM_GUEST`。
- 内部接口（VM↔宿主）：建/拆 realm、取活动 ctx、`qz_tick`、eval/compile、扩展登记——极小契约，无 ABI 承诺。
- 构建：`QZ_PROFILE=in-module` 选标志（已落地 d365171e）；新增 `qzvm-guest` target 选源集，产 `libqzvm.wasm`（非 libqzjs.so），宏 `QZ_VM_GUEST` 驱动条件编译。

## 里程碑（native 优先，低风险）

M1 qz_t/qz_ctx_t 切分（native 回归绿 + guest 语法 uv 不可达）→ M2 context.c 拆分 → M3 tick 上移 → M4 wasm32 工具链 + guest target → M5 guest 跑通（eval("1+1")==2）。

未决：工具链 wasi-sdk vs emscripten（倾向 wasi-sdk）；quickjs-ng wasm 可编译性；`qz_ext_suspend/resume_all` 无调用者裁决。


## Timeline

- time: 2026-10-13T03:49:29
  kind: decision
  summary: "Created this page: in-module 档设计：按能力切分 qz_t（非 stub uv）"
  source: "用户第一性+奥卡姆要求 + IN_MODULE_DESIGN.md"
  affects: [in-module-design]

- time: 2026-10-13T03:49:40
  kind: decision
  summary: "in-module 档 = 按能力切分 qz_t/qz_ctx_t，让 uv 类型对 guest 不可达；不设 stub 过渡"
  source: "IN_MODULE_DESIGN.md + 实测内核三源零 uv 调用"
  affects: [in-module-design]

- time: 2026-10-13T03:49:40
  kind: decision
  summary: "设计定稿：按能力切分 qz_t（非 stub uv）。内核三源零 uv 调用实测确认；qz_t 字段交错须逐字段归类。终态即起点，不设两阶段。文档 src/qzvm/aot/IN_MODULE_DESIGN.md。"
  source: "IN_MODULE_DESIGN.md + grep 内核三源"
  affects: [aot-experiment-verification]
