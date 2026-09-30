---
id: dap-feature-completion
title: "DAP 功能面补全：logpoints + verified:false + 异常断点"
category: decision
status: active
tags: [dap, vscode, debugger]
created: "2026-09-28T01:38:49"
updated: "2026-09-29T02:27:42"
---

<!-- compiled_truth -->
## Phase 1（已完成，e2e + ctest 绿）

### logpoints = 纯适配器（src/adapter/qzjsDebugSession.ts）
- setBreakPointsRequest 记 `logpoints: Map<path, Map<line, logMessage>>`（按文件整体替换，镜像 C 侧作用域）；logpoint 像普通断点注册给 C（引擎必须停）。
- 拦截 `stopped`（仅 reason=breakpoint）→ stackTrace 顶帧 → 命中则 renderLogMessage：按 `{expr}` 正则拆分，逐洞走 child evaluate（frameId，支持 locals.*），`unwrapForDisplay` 去 JSON 引号 → OutputEvent(console) → child continue → 吞掉 stopped。**失败一律 fail-open**（转发原 stopped，宁可多停不可丢停）。
- 能力 `supportsLogPoints: true` 只加在 TS initialize（C 的 initialize body 被适配器丢弃）。
- 无 `continued` 事件要吞：C 从不发它。

### verified:false = 纯适配器
- applyVerified：readFileSync 数行数（missing/目录/不可读 → 判 false）；响应与请求 1:1 对齐才覆写（C 跳过非法行时保持 C 的答案）。C 回答"已注册"，只有适配器看得到文件。
- 推论：**测试 fixture 的源文件必须真实落盘**（breakpoint-scope 的 HELPER 曾是合成路径 → 被正确判 unverified）。

### last_stop_line 重击守卫重设计（既有 bug，logpoints 暴露）
- 旧行为：只比行号且永不清除 → **循环行断点/logpoint 首次命中后永久抑制**（line-coverage 因多断点交替停顿而从未踩中）。
- 新语义（深度感知，src/debugger.c on_dispatch）：停顿时记 `last_stop_line + last_stop_depth + last_stop_file`；每次 dispatch：深度更深=在 callee 中守卫保留；更浅=停顿帧已返回，清除；同深且文件/行变了=语句已前进，清除。
- 栈回收恒先被观测：caller 必先在浅一层 dispatch（DEBUGGER_CHECK 每 opcode）才可能新建同深帧 → 帧地址复用不会误判。
- 深度 n 复用既有每次 dispatch 的 JS_GetCallFrames 调用（零新增热路径成本）；仅守卫活跃窗口做比较；`last_stop_file` 在 qz_debug_detach 释放。

### 程序 stdout 转发修复（既有 bug）
- 旧解析器只在文本含 \r\n\r\n 时转发：尾部输出永留 buffer，夹在帧头前的输出被 header 吞掉 → **程序 console 输出静默丢失**（无人断言过）。
- 新逻辑：扫描 `Content-Length:` 标记，标记前一切=程序输出即刻转发；`partialMarkerSuffix` 扣住跨 chunk 半截标记；JSON.parse 失败输出 stderr 并重扫描。

## Phase 2 异常断点（已完成，gtest + e2e 全绿）

### 引擎侧：JS_Throw 单漏斗钩子（deps/quickjs-ng/quickjs.c/h）
- `JS_Throw` 是唯一抛出入口（OP_throw / 全部 JS_ThrowError* / 宿主函数 / async reject），`JSDebuggerHooks.on_throw(ctx, exception, opaque)` 在**存入 pending 槽之前**触发（字段加在 opaque 前）；持 `JS_DupValue` 引用跨回调；门控 `#ifdef QZ_DEBUG_SUPPORT` + `!rt->in_build_stack_trace` + 非 UNINITIALIZED。
- 恢复性 rethrow 走新内部函数 `js_throw_restored`（不通知）：JS_IteratorClose（~17323）、OP_using_dispose_end（~19692）两处转换；build_backtrace 的存/取恢复由 `in_build_stack_trace` 标志覆盖 → **一次逻辑抛出恰好一次通知**。
- 非调试构建零开销：全部 hook 代码 #ifdef，`build/`（QZ_DEBUG_SUPPORT 未定义）编译通过。

### debugger.c：qz_debug_on_throw 处理器
- `exc_break_mode` 门 + `dbg->stopped` 重入保护（先占位 stopped=1 再 JS_ToString，防用户 toString 抛错嵌套重入）→ step_mode=STEP_NONE + pause_requested=0 + 顶帧 eager step_line → 消息字符串化（失败用 `<exception>` 兜底，JS_FreeValue(JS_GetException) 清 stray 槽）→ free 旧帧快照 + generation++（暂停处理期惰性取抛点栈）→ on_stopped("exception", 1) → stopped=0。**不碰 last_stop_* 守卫**。
- 新 API：`qz_debug_set_exception_break(dbg, mode)` / `qz_debug_last_exception(dbg)`（qz_debug.h 声明）；attach 接线 `hooks.on_throw`；`exc_message` 在 detach 释放。

### DAP 层 + TS
- `dap_on_stopped` exception body（cJSON，reason/description:"Exception" + text=错误消息 + threadId + allThreadsStopped）；`dap_handle_set_exception_breakpoints`（filter "all"→arm，未知→verified:false，回 breakpoints[]；filters:[] = 解除）进**全部三条处理分支**（paused / mid-run / configure）。
- 同轮顺带修：paused 分支 `setBreakpoints` 此前只回 `{}` 通用 ack（断点编辑丢失 + VS Code 置灰该文件）→ 补同 handler。
- TS：`exceptionBreakpointFilters` 能力（只申报 all）+ 中继。**方法名必须是 `setExceptionBreakPointsRequest`（大写 B）**——`@vscode/debugadapter` 基类硬编码 if/else 分发，小写 b 静默落到默认空成功响应（调试代价大）；测试必须断言响应体全文防此坑。

### 语义边界（docs Limitations 记载）
- catch 的 throw 也停（JS_Throw 在展开判定 catch 之前已触发）；Uncaught-only 过滤器不申报（需 unwind 路径 catch 检测）；async reject = throw 照停；日志点洞只在栈顶帧求值。

### 护栏与镜像
- gtest `ExceptionBreakpointArmed`（armed→reason=exception + text gboom + 抛点行 2 + 一次抛出一次停）/ `ExceptionBreakpointDisarmed`（filters:[] 不停）；e2e `exception-bp.mjs`（caught/disarmed 两会话）。
- 引擎补丁重镜像 **522→591 行 / 20→24 hunks**：GOLD（干净 HEAD+4 补丁 == worktree 四文件一致）+ hunkcheck 0 MISMATCH + reverse dry-run 通过。


## Timeline

- time: 2026-09-28T01:38:49
  kind: decision
  summary: "Created this page: DAP 功能面补全：logpoints + verified:false + 异常断点"
  source: created via brain create-page
  affects: [dap-feature-completion]

- time: 2026-09-28T01:38:49
  kind: decision
  summary: "Phase 1 完成（logpoints/verified:false + 两个修复）；Phase 2 异常断点未开始"
  source: brain update-truth
  affects: [dap-feature-completion]

- time: 2026-09-28T02:23:21
  kind: decision
  summary: "Phase 1+2 全部完成：logpoints/verified:false/异常断点 + 三修复 + 文档/CHANGELOG/ROADMAP 同步"
  source: brain update-truth
  affects: [dap-feature-completion]

- time: 2026-09-28T02:23:42
  kind: decision
  summary: "Phase 2 验证全绿：ctest 26/26（dap gtest 6/6 含 ExceptionBreakpointArmed/Disarmed）+ npm e2e 7/7 + tsc + 非调试 build/ 编译；补丁镜像 GOLD/hunkcheck/reverse 三校验通过；docs en+zh（What works/Limitations/Test）、CHANGELOG（1 Added + 3 Fixed）、ROADMAP A4（6/6 + 7/7）已同步；未提交待'提交'指令"
  source: brain append-timeline
  affects: [dap-feature-completion]

- time: 2026-09-29T02:27:42
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [dap-feature-completion]
