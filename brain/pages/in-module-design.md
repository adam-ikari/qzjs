---
id: in-module-design
title: "in-module 档设计：按能力切分 qz_t（非 stub uv）"
category: decision
status: active
tags: [decision, build, wasm, in-module, aot]
created: "2026-10-13T03:49:29"
updated: "2026-10-14T01:15:21"
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

- time: 2026-10-13T05:33:37
  kind: evidence
  summary: "§10.4 异步回流原型实测通过（inmod-abi-proto/ B 段）。guest_async.wat import qz_host.fs_read(ptr,len)->op_id + qz_host.drain(ptr,max)->n；host_async.c pthread 延迟读文件→队列；guest drain 自旋取回（~76k 轮，24 字节负载）。确认'import 拉'模型成立：host 无 JSValue，事件纯字节，resolve 由 guest 内完成。§10 现验同步/写回/异步三条。未覆盖：guest 侧 JSValue 生命周期/memory.grow/AOT 变体/多 op 并发/drain 去自旋。"
  source: "inmod-abi-proto/build.sh B 段"
  affects: [in-module-design]

- time: 2026-10-13T05:55:32
  kind: evidence
  summary: "§10 跨界税 bench 实测（inmod-abi-proto/ C 段）。WAMR 经典解释器：guest→host 空 import ~45 ns/次、带 32B 负载 ~66 ns/次；基线 wasm 纯循环 ~5.6、C 直调空 ~0.3。含义：跨界税 ~2200 万次/秒，pal 面每 tick 几十次=纳秒级非瓶颈；仍把跨界降到最低但不必为省跨界牺牲结构。对比 AOT 的 qz.* import（JS 函数 ~4.9µs/次）→ in-module qz_host.* 直落 native C 快 ~100x，是 in-module 关键性能优势。踩坑：i64 返回值经 wasm_runtime_call_wasm 卡死（argv slot 约定），bench 改 i32 返回+宿主侧计时。"
  source: "inmod-abi-proto/build.sh C 段"
  affects: [in-module-design]

- time: 2026-10-13T06:11:13
  kind: decision
  summary: "M1 完成：qz_t/qz_ctx_t 能力切分，QZ_VM_GUEST 编译期 uv 隔离。`#ifndef QZ_VM_GUEST` 守卫全部 uv-typed 字段/原型（native 布局零改变，同 QZ_USE_MOCK_LIBUV 先例）。改 4 头：qz_types.h（uv include 条件化 + RT_LOOP/queue.h/qz_worker_t/qz_proc_handle_t 守卫）、qz_core.h（loop/thread/wake+消息队列+线程标志+worker/self_path+store/http_ops/proc/ipc/dap/ctl+qz_close_loop 入守卫）、qz_msg.h（整文件 guest 不编）、qz_rt.h（qz_msg_t/qz_worker_t/uv_handle_t 原型簇守卫）。验收：native ninja qzjs 17/17 链接通过 + ctest 31/31 全绿；guest -DQZ_VM_GUEST -fsyntax-only 内核三源全 OK，探针证 uv_loop_t/uv_thread_t/uv__queue 编译期不可达（3 错 vs native 0）。关键：切分**不重排**字段（逐簇加 guard），native 零波及。commit 59091ff1。"
  source: "src/base/{qz_types,qz_core,qz_rt}.h + src/msg/qz_msg.h"
  affects: [in-module-design]

- time: 2026-10-13T06:23:06
  kind: note
  summary: "交叉引用：AOT 整体性能预估 + f64 vs 原生整数数值表示裁决已记入新页 aot-performance-model。要点：in-module 与 AOT 是两条并行路线非嵌套；AOT 最大杠杆是 qz.* 跨界税 4.9µs→45ns（raw native 注册，ext_wamr.c:105 已具备路径）。"
  source: "讨论 2026-13"
  affects: [in-module-design]

- time: 2026-10-13T06:27:11
  kind: note
  summary: "形态校正（重要）：in-module 与 AOT **不是两条并行路线**——是同一 wasm 模块的静态/动态两面。TS→wasm 编译后，静态部分已是 wasm，动态部分在同模块内 qzvm（QuickJS-ng 编 wasm32）运行，同 isolate。in-module 档（QZ_PROFILE=in-module, CMakeLists:41-45 关 _prof_wamr/_prof_wasm3）= 该形态构建设置，因模块内不套第二层 wasm 引擎 ⇒ 无 wasm 嵌套。对外两条 import 面：qzjs 的 JS import（宿主兑现，qz.*）+ WASI（wasm 运行时兑现；qzjs 当前 WAMR_BUILD_LIBC_WASI=0 不解）。性能模型见 aot-performance-model。"
  source: "用户本轮架构声明 + CMakeLists 证据"
  affects: [in-module-design]

- time: 2026-10-13T06:27:58
  kind: note
  summary: "待决点（本轮暴露）：用户形态 = 单一 wasm 模块（静态 wasm + 模块内 qzvm 动态）。但本设计 §6(行233/238) 只说产独立 （guest 产物），未写【如何与 AOT emitter 发射的静态 wasm 合并为单一模块】。行222 已隐含『单一 wasm 产物的内部实现』措辞。补问：最终 artifact = wasm-merge/wasm-ld 链接成单模块？还是 qzvm.wasm 与静态 wasm 并列加载（导入/导出对接）？前者才契合用户『同 isolate 同内存、零 marshalling』。M4 定。"
  source: "用户单模块声明 vs IN_MODULE_DESIGN.md:233/238/222"
  affects: [in-module-design]

- time: 2026-10-13T06:28:09
  kind: reversal
  summary: "更正上一条（shell 反引号吞词）：待决点 = 用户形态是单一 wasm 模块（静态 wasm + 模块内 qzvm 动态），但设计 §6 只说产独立 guest 产物（qzvm 编出的 .wasm），未写【如何与 AOT emitter 发射的静态 wasm 合并为单一模块】。补问：最终 artifact 是 wasm-merge/wasm-ld 链接成单模块？还是 guest .wasm 与静态 wasm 并列加载（导入导出对接）？前者才契合用户「同 isolate 同内存、零 marshalling」。M4 定。"
  source: "用户单模块声明 vs IN_MODULE_DESIGN.md §6"
  affects: [in-module-design]

- time: 2026-10-13T06:31:22
  kind: note
  summary: "术语修正（用户纠正）：前条「动态部分在同模块内 qzvm（QuickJS-ng 编 wasm32）运行」中括号缩窄了 qzvm。准确：模块内跑的是 qzvm = 纯 VM 构建单元，in-module 档源集 = context.c（realm 生命周期）+ vm_core.c（eval/字节码编译/rt 查询）+ ext_lifecycle.c（扩展生命周期），不含 wasm 引擎（档内 _prof_wamr/_prof_wasm3 OFF）、不含 debugger、不含宿主 I/O。QuickJS-ng 只是其底层引擎（外部依赖），qzvm ≠ QuickJS-ng。"
  source: "用户纠正 + src/qzvm/CMakeLists.txt:35-44"
  affects: [in-module-design]

- time: 2026-10-13T13:33:03
  kind: decision
  summary: "M2 落地：context.c 拆分完成。内核只留 realm（qz_ctx_create/_at/_destroy，导出 _at 供宿主恢复指定槽位）；边界接线 + 编排移入新文件 src/host/ctx_orchestrate.c（qz_ctx_wire_up / qz_ctx_create_host / qz_ctx_destroy_host / qz_ctx_cleanup_resources / spawn/serialize/rebuild/destroy_id）。死码 qz_inject_polyfill_ctx（bridge.c + qz_rt.h 声明）已删。qzjs.c 建/拆改用 host 包装。qtz 内核 destroy 只做 job 排水 + JS_FreeContext + 注销，扩展钩子/句柄清理由 destroy_host 先跑。CMake core 源加 ctx_orchestrate.c。验证：全 32 ctest 绿（含 context/suspend/composition gtest）。"
  source: "IN_MODULE_DESIGN.md §5.2 + git diff"
  affects: [in-module-design, c-js-layering]

- time: 2026-10-13T13:52:30
  kind: decision
  summary: "M3 落地：tick 原语上移内核。qz_flush_microtasks（原 src/host/thread.c）→ qz_tick（src/qzvm/vm_core.c），纯 quickjs 零 libuv，属 guest 最小内核集。旧名/旧定义删除，声明移入 qz_rt.h 内核段（QZ_VM_GUEST 可见）。全部调用点统一：thread.c（qz_loop_idle/消息派发/主循环）、worker.c 主循环、rt_main.c 主循环、qzjs.c teardown 两处内联 JS_ExecutePendingJob 循环（§5.4 文档所指复用点）。验证：32/32 ctest 绿 + 微任务冒烟 + QZ_VM_GUEST 内核三源照编。"
  source: "IN_MODULE_DESIGN.md §2.4/§5.3/§5.4/§7 M3 + git diff"
  affects: [in-module-design]

- time: 2026-10-13T14:02:11
  kind: reversal
  summary: "M2 回归修复：M2 搬迁 qz_ctx_rebuild 到 ctx_orchestrate.c 时漏掉失败路径 return rc，致 resume 读盘失败静默成功（test_suspend_gtest.resume_bad_state_path 红）；同批 qz_ctx_spawn 漏 free(err) 泄漏。已在 M3 提交一并补回。教训：搬函数时用「返回语句/清理路径」逐条比对旧实现，别只比 happy path。"
  source: "git a11cf35c 对比 e62b9324:src/qzvm/context.c；ctest 32/32"
  affects: [in-module-design]

- time: 2026-10-13T15:30:34
  kind: decision
  summary: "M4 落地：wasm32-wasi guest target。新增 cmake/wasm32.cmake（clang -target wasm32-wasi --sysroot，Debian wasi-libc/wasi-sdk；-nodefaultlibs -lc -lm 绕 Debian 缺 libgcc；reactor -mexec-model=reactor 无 main）+ qzvm-guest CMake target（src/qzvm/CMakeLists.txt if QZ_IN_MODULE）。源集=内核三源（context.c/vm_core.c/ext_lifecycle.c）+ 新增 guest_entry.c + quickjs-ng qjs target，宿主源/扩展/polyfill 不进；QZ_VM_GUEST + QZ_WITH_*=0 由 target 下发，uv 类型对 guest 不可达，qz_default_exts 全 NULL 槽不引扩展符号。产物 libqzvm.wasm 导出 qz_create/qz_eval/qz_tick/qz_destroy（export_name 映射 qz_guest_* C 符号，避免与宿主侧 qz_create/qz_destroy 同名）+ memory/malloc/free；import 段含 qz_host.drain——guest_entry 的 qz_tick = 内核 qz_tick + qz_host_drain（§10.4 tick 拉模型真实引用非占位）。pal/polyfill/扩展接线留 M5/M6。裁决（M4 定）：M4 产独立 guest .wasm；与 AOT 静态 wasm 合并成单模块延后（等 M5 真跑通）。验证：cmake --build build-inmod --target qzvm-guest → libqzvm.wasm 链接成功（wasm-objdump 验导出/导入段）；native 32/32 ctest 绿；-DQZ_VM_GUEST -fsyntax-only 内核源+guest_entry 零 error。"
  source: "cmake/wasm32.cmake + src/qzvm/{CMakeLists.txt,guest_entry.c} + IN_MODULE_DESIGN.md §6/§7 M4 + git 1dba005c"
  affects: [in-module-design]

- time: 2026-10-13T15:33:38
  kind: evidence
  summary: "M4 运行验证（超出链接验收）：用 node v24 WASI preview1 + qz_host.drain shim 实例化 libqzvm.wasm（reactor）并驱动导出——qz_create→rt 句柄、qz_eval(\"1+2*3…\")→0、qz_tick→0 且 drain 被调 1 次、qz_eval(\"throw…\")→-1、qz_destroy ok。证明 guest 真在 wasm 内跑 QuickJS（非仅可链接），qz_host.* import 生效。脚本为一次性 /tmp 冒烟，未入仓（M5 接 C 宿主驱动）。"
  source: "node runqz.mjs + libqzvm.wasm（27542529）"
  affects: [in-module-design]

- time: 2026-10-14T01:15:21
  kind: evidence
  summary: "M5 落地：guest 异步回流跑通（§10.4「import 拉」选型真机验证）。guest_entry.c 加 fsRead(path) 原语（建 Promise，qz_host_fs_read 发起异步读，resolve/reject 存 guest 内 op 表持 JSValue——host 无 JSContext）；qz_tick 去自旋（每轮 qz_host_drain 拉 {op_id,status,len,data} → 找 op 槽 → JS_Call(resolve|reject) → return）；结果读出导出 qz_result_ptr/len。导出名 libqzvm.wasm（CMake SUFFIX .wasm/PREFIX lib）。验证：node WASI 宿主 shim（真异步 fs_read+drain 队列）fsRead(data.txt)→tick×2→\"OK len=33 head=hello from host file\"；reject fsRead(NOPE)→tick×1→\"ERR ENOENT…\"；native 32/32 ctest 绿。限制（M6 消除）：单 rt（op 表 static）、单事件≤512B、仅 1 原语（43 js_pal_* 全量移 guest 属 M6 §10.5）。"
  source: "src/qzvm/guest_entry.c + src/qzvm/CMakeLists.txt + IN_MODULE_DESIGN.md §6/§7 M5 + git dd52fbf5"
  affects: [in-module-design]
