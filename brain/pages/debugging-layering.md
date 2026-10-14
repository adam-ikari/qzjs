---
id: debugging-layering
title: "调试分层：DAP 需求拆解 / qzvm 只留引擎调试核 / AOT 调试=DWARF 契约"
category: decision
status: active
tags: [decision, debug, dap, qzvm, aot, wasm, dwarf, gdb-rsp, debug-interp]
created: "2026-10-14T06:51:35"
updated: "2026-10-14T11:17:15"
---

<!-- compiled_truth -->
## 结论

**DAP 不是需求，是协议载体。** 真实需求只有三件：① 位置映射（执行点 ↔ 源码 file:line）② 停止控制（断点/单步/暂停）③ 状态检查（栈帧/变量/eval）。stdio / timer / poll / Content-Length 帧 **全是载体，且全是 OS 依赖**——按「timer = OS 依赖，禁入 qzvm」同一逻辑，**整条传输层出 qzvm**（不是只搬 timer）。

## 事实分离（已核实）

| 单元 | 内容 | OS 依赖 | 引擎依赖 |
| --- | --- | --- | --- |
| `qzvm/debugger.c` | `qz_debug_*`：断点表/步进/暂停，回调驱动 | **零**（仅 snprintf） | **强绑 QuickJS**（`JS_SetDebuggerHandler`/`JS_GetCallFrames`/`JS_GetFrameVariable`，qzjs 打的 QuickJS-ng debugger patch） |
| `qzvm/debugger_dap.c` | DAP 协议 + stdin/stdout + poll + `uv_timer` | **全是** | 无 |
| `aot/emitter.js` | 产 wasm **name 段** + **DWARF 行表**（语句级 `markLine`） | — | 无 |
| `aot/wasm-dwarf.js` | 自研 wasm 的 DWARF4 段生成（`.debug_abbrev/_info/_line/_str`） | — | 无 |

## 三个可执行体（调试通道互不通用）

| 可执行体 | 调试对象 | 通道 | 现状 |
| --- | --- | --- | --- |
| native QuickJS | native 内 JS | `debugger.c` + DAP 传输层 | ✅ 可用（`QZ_BUILD_DEBUGGER=ON`） |
| guest 内 QuickJS（in-module） | wasm 里的 JS | 调试核进 guest 源集 + 命令经 `qz_host.*` import 面回流出 host 接 DAP（同 `qz_host_drain` 回流） | ❌ guest 源集 4 源不含 `debugger.c` |
| WAMR **wasm 模块**（TS→wasm，仅 bytecode/interp） | wasm 指令 | WAMR `WASM_ENABLE_DEBUG_INTERP`（debug-engine/gdbserver，**GDB RSP** over TCP） | ✅ 已启用（`QZ_WITH_WAMR_DEBUG_INTERP`，默认 OFF）；见下方实现与边界 |

**关键区分**：guest 内 JS 与 wasm 模块是**两个不同调试对象**——WAMR debug-interp 调的是 wasm 指令、断在 wasm 偏移，**不能**调试 guest 内 JS 的 JS 行；guest 内 JS 只能走 qzjs 自己的 `debugger.c`（经 import 面回流）。

## WAMR debug-interp 通道（已实现，2026-10-14）

- **开关**：CMake `QZ_WITH_WAMR_DEBUG_INTERP`（默认 OFF）→ `WAMR_BUILD_DEBUG_INTERP=1`。开启时必须**提前**把 `WAMR_BUILD_FAST_INTERP` 置 0（WAMR 上游 `runtime_lib.cmake` 的降级在按 FAST_INTERP 选好 interp 源之后，属顺序 bug，会编进 fast-interp 源而结构体缺字段编译失败——qzjs 侧规避，未改 submodule）。
- **宿主接线**：`wamr_ensure_runtime` 调试构建下改走 `wasm_runtime_full_init` 并填 `ip_addr`（debug-engine 只在 full_init 的 ip_addr 非空时初始化，否则 start_debug_instance* 因 `g_debug_engine==NULL` 恒返 0）；每个 bytecode 实例构造后调 `wasm_runtime_start_debug_instance_with_port`。env：`QZ_WAMR_DEBUG_PORT`（0=自动，打印到 stderr）/`QZ_WAMR_DEBUG_HOST`。
- **实证**：裸 GDB-RSP 客户端全链跑通——qSupported → 首停 `T05 reason:trace` → `Z0` 断点 → `c` → 命中 `T05 reason:breakpoint`。

## AOT 调试能力边界（已核实）

- WAMR `WASM_ENABLE_DEBUG_AOT`（`aot/debug/jit_debug.c`）**只产 jitdump/perf map**（`perf record` 用），**无行表、无源码映射** → AOT 形态**不可步进**。
- **debug-interp 拒绝 AOT 实例**：`wasm_runtime_start_debug_instance_with_port` 首行判 `module_type != Wasm_Module_Bytecode` → 打印 `Attempt to create a debug instance for an AOT module` 并返回 0（已实测）。glue 默认优先 `.aot`，故调试须走纯 `.wasm`/bytecode 路径。
- **DWARF 解析方不是 WAMR**：debug-engine 全库不含 DWARF 解析器——`handler.c` 里唯一的 "dwarf" 是寄存器描述串 `gcc:16;dwarf:16`。DWARF 的**消费方是打了 `build-scripts/lldb_wasm.patch` 的定制 lldb**（`source_debugging_interpreter.md`）；stock gdb 没有 wasm target，只对指令级 RSP 有用（需忽略其 `vMustReplyEmpty` 探测超时）。
- AOT/源码级调试须：① 编译器（emitter）产 **DWARF** custom section——**已补（2026-10-15，见下）** ② WAMR 启用 debug-interp——**已补**。故 wasm 偏移级指令断点已通；源码级行断点待 lldb 侧消费验证。

## 编译器侧 DWARF（已实现，2026-10-15）

- **落点**：`aot/wasm-dwarf.js`（纯 JS，段编码）+ `aot/emitter.js`（语句级 `markLine` 累积 + `compileTS` 设 `em.sf`）。`--debug` 同时开 name 段与 DWARF 行表。
- **产段**：`.debug_abbrev / .debug_info / .debug_line / .debug_str`，**DWARF 版本 4**，addr_size=4（wasm32 恒定，与宿主字长无关）。
- **地址约定**：DWARF 地址 = **code 段 payload 起始的相对偏移**（与 clang wasm 后端一致，已实证）。WAMR debug-engine 报的 PC 是文件绝对偏移，lldb 侧负责重定位。基址由 encoder 的 `startBody/endBody` 记录函数体在 code 段内的 payload 偏移得出。
- **行映射精度**：**语句级**（每个 `emitStmt`/`emitTaggedStmt` 记一个 mark），非指令级。
- **验证**：`llvm-dwarfdump-14 --debug-line/--debug-info` 干净解析（无 warning），`runDwarf` 回归门守段存在 + 首地址在文件内 + 带段仍可执行。

## 裁决（落点）

- **qzvm 只留 `debugger.c`**（回调驱动、零 OS、可进 guest 源集）。
- **`debugger_dap.c` 整体归 host（qzjs）**——stdio 与 timer 同为 OS 依赖，不拆。
- `qz_t.dap_timer`/`dap_timer_active` 字段随传输层移出 qzvm 核心。
- **AOT 调试 = 编译器 DWARF（已补，wasm-dwarf.js）+ WAMR 侧 debug-interp（已启用）**，源码级行断点仍待 lldb 侧消费验证。

## 暴露的现存缺口

| 缺口 | 后果 |
| --- | --- |
| ~~emitter 无行表/DWARF~~ | ~~AOT/源码级断点不可用~~ → **已补（2026-10-15，wasm-dwarf.js + emitter markLine）** |
| guest 源集不含 `debugger.c` | in-module 形态**无任何调试能力** |
| 源码级行断点未经 lldb 实测 | DWARF 段已产且被 llvm-dwarfdump 干净解析，但 lldb_wasm 侧消费（`break file.ts:N`）未端到端验证 |
| ~~WAMR debug-interp 未启用~~ | ~~wasm 模块不可指令级调试~~ → **已补（2026-10-14）**，但仅 bytecode 实例、仅偏移级 |


## Timeline

- time: 2026-10-14T06:51:35
  kind: decision
  summary: "Created this page: 调试分层：DAP 需求拆解 / qzvm 只留引擎调试核 / AOT 调试=DWARF 契约"
  source: "用户裁定 2026-10-14"
  affects: [debugging-layering]

- time: 2026-10-14T06:51:35
  kind: decision
  summary: "DAP 需求=位置映射+停止+状态；stdio/timer 皆 OS 依赖→传输层出 qzvm；qzvm 只留 debugger.c（绑 QuickJS、零 OS）；AOT 调试靠编译器产 DWARF"
  source: "用户裁定 2026-10-14"
  affects: [debugging-layering]

- time: 2026-10-14T06:59:37
  kind: decision
  summary: "修正为三执行体模型；补 WAMR 取证（debug-interp=GDB RSP 需显式启用；DEBUG_AOT 只产 perf map 无行表）"
  source: "取证 deps/wamr 2026-10-14"
  affects: [debugging-layering]

- time: 2026-10-14T08:03:00
  kind: decision
  summary: "WAMR debug-interp 通道接通（QZ_WITH_WAMR_DEBUG_INTERP）；修正 DWARF 消费方=lldb 非 WAMR；AOT 实例被拒"
  source: "实现+取证 2026-10-14"
  affects: [debugging-layering]

- time: 2026-10-14T08:03:05
  kind: reversal
  summary: "推翻旧记录「handler.c 解 DWARF」：debug-engine 全库无 DWARF 解析器（handler.c 唯一 dwarf 串是寄存器描述）；DWARF 消费方是打了 lldb_wasm.patch 的定制 lldb，stock gdb 无 wasm target"
  source: "取证 deps/wamr 2026-10-14"
  affects: [debugging-layering]

- time: 2026-10-14T09:57:45
  kind: decision
  summary: "AOT 编译器侧 DWARF 已实现（wasm-dwarf.js + emitter 语句级 markLine，DWARF4 / code 段相对地址）；缺口收敛为 lldb 侧消费未端到端验证"
  source: "实现+llvm-dwarfdump 取证 2026-10-15"
  affects: [debugging-layering]

- time: 2026-10-14T10:14:24
  kind: evidence
  summary: "AOT DWARF 端到端实证：qzs 侧地址约定确认=code 段 payload 起始相对偏移（clang 后端一致：low_pc 0x2→file 65，code-content 63）。WAMR GDB server PC = 文件绝对偏移|WasmObj<<62。实测 strWork（code-content 542）：DWARF 行 0x216(L4)/0x34d(L5) → 断点地址 0x434/0x56b → 均命中 T05 reason:breakpoint。lldb 侧=code 段文件偏移 + DWARF 地址。"
  source: "手动实证"
  affects: [debugging-layering]

- time: 2026-10-14T11:17:15
  kind: evidence
  summary: "WAMR debug-interp 全链回归门入仓（commit 8fc6a935）：test/test_wamr_debug_rsp.sh + test/wamr-debug-e2e/rsp_break.py + CI job wamr-debug-rsp，守「DWARF 行地址(code 段 payload 相对) + code 基址 = WAMR 文件绝对 PC」约定。前此仅 /tmp 手验、CI 不跑。build.js 增 --no-aot：WAMR debug-interp 拒绝 AOT 实例，调试运行须纯 bytecode（AOT=设备现场 wamrc 产物，AOT 路径默认不变）。全 DWARF 行地址均设点：首行可能早于入口 reason:trace 停顿 PC（已越过则不命中）。实证 17 行地址、基址 0x21e、命中 T05 reason:breakpoint。"
  affects: [debugging-layering]
