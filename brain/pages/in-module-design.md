---
id: in-module-design
title: "in-module 档设计：按能力切分 qz_t（非 stub uv）"
category: decision
status: active
tags: [decision, build, wasm, in-module, aot]
created: "2026-10-13T03:49:29"
updated: "2026-10-13T05:30:26"
---

<!-- compiled_truth -->
## 结论

in-module（qzvm 编到 wasm32 作模块内 guest）设计 = **两部分**：

1. **qz_t/qz_ctx_t 按能力切分**，让 libuv 类型对 guest 不可达（非 stub uv 头）。
2. **pal 面跨界 ABI**：guest 在 wasm 内、宿主在外，pal 的 42 属性/43 函数不能 C 直调，必须经 wasm imports。

## 第一性推导

初版把问题设成「让现有 QZVM_SOURCES 三源（741 行）脱离 libuv 照编」→ stub 头。**错**：三源是 `src/qzvm/` 被切出时"恰好在那"的全部代码，与 guest 需要无对应。

正确问题：**内嵌 wasm 的 JS 引擎模块运行时最少需要什么？**

答案：引擎 + realm 生命周期（含注册）+ eval/compile + tick。**不要**：宿主线程/loop、消息队列/IPC、进程编排、文件 I/O、timer、控制面、**polyfill 注入**、**扩展登记调用点**（后两者属宿主边界接线，见 §3.1）。

## 关键事实（已核实）

- 内核三源（context.c/vm_core.c/ext_lifecycle.c）**零直接 `uv_` 调用**。
- `qz_types.h:26-30` 无条件 `#include <uv.h>`，因 `qz_t` 值内嵌 uv 类型（`qz_core.h:86-88`）+ `qz_msg_t` 内嵌 `uv__queue`。`qz_t` 字段**交错**，须逐字段归类。
- **polyfill 注入不属核心**（§3.1）：注入动作在 `context.c:160-215`，但输入全在宿主——`qz_create_pal_object_ctx`（`bridge.c:2226`，注册 42 个 pal.* = 全是宿主 I/O）、`qz_polyfill_load`（`src/host/polyfill_load.c`）、polyfill bundle（`src/polyfill/src/*.js` = pal 之上的宿主 glue）。且 `context.c:164` 直调 bridge.c 函数 = 分层违规。`textcodec_ext_init`（`ext_textcodec.c:225`）读注入产生的 `__native__` → ext 登记硬依赖注入，两者同属边界接线。
- **跨界 ABI**（§10）：`uv_io.c`（4061 行）**0 处 `JS_` 调用**，签名纯原语（`const char*` + `qz_io_done_t cb` + `void* cb_data`）= **天然跨界线**。跨界线不在 pal 函数（收 `JSValue argv`），而在其下 `uv_io_*`。
- host 侧 JS 用量：bridge.c 463、tcp_io.c 229、control.c 72、worker.c 48、qzjs.c 10（lifecycle）、thread.c 2（tick）、uv_io.c 0。
- `qz_inject_polyfill_ctx`（`bridge.c:2334`）**零调用者**死码。

## 切分设计

- `qz_t`/`qz_ctx_t`：核心字段 + `#ifndef QZ_VM_GUEST` 宿主块（loop/thread/msgq/handles/timer…）。
- `qz_types.h` uv include 移进 `#ifndef QZ_VM_GUEST` → guest 编译时 uv 类型**不可达**（不是 stub，是不存在）。
- `context.c` 拆：realm 骨架留内核；pal/polyfill/ext 登记移边界；spawn/serialize/rebuild/file I/O 移宿主。
- **边界实质**（§5.3/§10.2）：收 `JSValue` 的 `js_pal_*` 包装**必须在 guest 内**（JSValue 只存在于 guest 的 QuickJS 堆）；跨界的是其下层原语（pal 直引 12 个 `uv_io_*`）。
- **异步回流**（§10.4）：host 无 JSContext → 拉模型（`qz_tick` 一并排空 host 完成队列，无需 host 持 JSValue）。三方案倾向 import 拉。
- 内部接口（VM↔宿主）极小：建/拆 realm、取活动 ctx、`qz_tick`、eval/compile；无 ABI 承诺。
- 构建：`QZ_PROFILE=in-module`（已落地 d365171e）+ 新 `qzvm-guest` target 产 `libqzvm.wasm`；宏 `QZ_VM_GUEST`。
- import 面与 AOT 的 `qz.*`（值原语）用不同 module 名隔离（`qz_host.*`）。

## 里程碑（native 优先）

M1 qz_t/qz_ctx_t 切分 → M2 context.c 拆分（含边界接线移出）→ M3 tick 上移 → M4 wasm32 工具链 + guest target → M5 guest 跑通（单原语跨界：qz_host_log + fs 读回流）→ M6 宿主去 JS 化（in-module 专属，独立）。

未决：wasi-sdk vs emscripten；quickjs-ng wasm 可编译性；`qz_ext_suspend/resume_all` 无调用者裁决；回流方案选型（M4）。


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

- time: 2026-10-13T05:18:28
  kind: reversal
  summary: "修正 §3：polyfill 注入与扩展登记不属 qzvm 核心，是宿主边界接线。第一性追问「polyfill 注入是 qzvm 需要的吗」→ 答案否。注入动作虽在 context.c:160-215，但输入全在宿主：qz_create_pal_object_ctx(bridge.c:2226, 48 个 pal.* 全宿主 I/O)、qz_polyfill_load(src/host/polyfill_load.c)、polyfill bundle(src/polyfill/src/*.js，pal 之上的宿主 glue)。且 context.c:164 直接调 bridge.c 函数 = 分层违规。textcodec_ext_init(ext_textcodec.c:225) 依赖注入产生的 __native__ → ext 登记硬依赖注入，两者同属边界接线。连带发现 qz_inject_polyfill_ctx(bridge.c:2334) 零调用者死码。内核体量修正 ~337 行。guest 最小集 = 引擎 + realm 生命周期(含注册) + eval/compile + tick。"
  source: "IN_MODULE_DESIGN.md §3.1 + grep 核实行号"
  affects: [in-module-design]

- time: 2026-10-13T05:18:29
  kind: decision
  summary: "初始化序列重排：qz_ctx_create 单体 → VM 建 realm + 宿主接线(build_pal → inject_polyfill → qz_ext_init_all) + qz_tick 拉。边界接线不属 VM↔宿主内部接口。"
  source: "IN_MODULE_DESIGN.md §5.3"
  affects: [in-module-design]

- time: 2026-10-13T05:25:58
  kind: evidence
  summary: "新增 §10 跨界 ABI——前 10 节漏掉的核心问题：in-module 下 pal 面（42 属性/43 函数）如何跨 wasm。关键发现：uv_io.c（4061 行）零 JS_ 调用、签名纯原语（const char* + qz_io_done_t cb + void* cb_data）= 天然跨界线。分层结论：收 JSValue 的 js_pal_* 包装必须留 guest 内（JSValue 只在 guest QuickJS 堆），跨界的是其下层 uv_io_* 原语（pal 直引 12 个）。异步回流：host 无 JSContext → 改拉模型（qz_tick 一并排空 host 完成队列）。新增 M6（宿主去 JS 化：bridge.c 463/tcp_io.c 229/control.c 72 处 JS_ 待处置；uv_io.c 不动）。与 AOT 的 qz.* import 用不同 module 名隔离（qz_host.*）。"
  source: "IN_MODULE_DESIGN.md §10 + 实测 uv_io.c/bridge.c JS_ 计数"
  affects: [in-module-design]

- time: 2026-10-13T05:26:11
  kind: decision
  summary: "in-module：qz_t 按能力切分 + pal 面跨界 ABI（js_pal_* 留 guest，uv_io_* 穿 wasm 边界）"
  source: "IN_MODULE_DESIGN.md §10（本轮）"
  affects: [in-module-design]

- time: 2026-10-13T05:30:26
  kind: evidence
  summary: "§10 跨界 ABI 原型实测通过（inmod-abi-proto/）。4 条主张验证：(1) import module 名 qz_host.* 隔离；(2) guest 同步跨界调宿主 qz_host.log；(3) 内存 ptr+len 传字节无 JSValue；(4) 回流形态 宿主 now()→i64.store→宿主读回。工具链 wat2wasm+clang(wasm32)+vendored WAMR(libiwasm.a)。结论：§10 骨架成立，M5 起点明确。未覆盖：异步 promise 回流/内存增长/AOT 变体。"
  source: "inmod-abi-proto/build.sh 实测"
  affects: [in-module-design]
