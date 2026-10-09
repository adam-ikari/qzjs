---
id: dap-setbreakpoints-scope
title: "DAP setBreakpoints 按文件作用域替换（不再清整表）"
category: decision
status: active
tags: [dap, debugger]
created: "2026-09-27T05:21:34"
updated: "2026-09-27T05:21:34"
---

<!-- compiled_truth -->
## 决策：setBreakpoints 按文件作用域替换

**背景**：DAP 客户端（VS Code）每个源文件各发一个 setBreakpoints 请求，只表达「这个文件的断点集合」。旧实现 `dap_handle_set_breakpoints` 先 `qz_debug_clear_breakpoints()` 清空**整张表**再登记请求里的断点 → 用户在任何其他文件上增删断点都会静默清掉本文件的断点（响应仍 `verified: true`，断点却永不命中）。

**修复**（2026-09-27，全部在 qzjs 层，不改引擎补丁 → 无需重镜像 debugger patch）：
1. `qz_debug_clear_breakpoints_in_file(dbg, filename)`（`src/debugger.c` + `include/qzjs/qz_debug.h`）：只移除 filename 匹配的条目，保留其他文件的断点。
2. `dap_handle_set_breakpoints`（`src/debugger_dap.c`）：有 `source.path` → 先按文件清除再登记；**无 path（DAP 规范要求 source，属畸形请求）→ 表完全不动**——旧行为是清空全部，同样属于「清掉无法归属的文件」的误伤；响应回空 breakpoints 数组。
3. 断点表多文件共存本来就支持（`bp_find` 按 filename+line 线性匹配），无需引擎侧改动。

**语义保持**：`verified: true` = 「已登记」而非「会命中」——命中还要求该文件以完全相同的路径字符串被求值（精确 strcmp；行能否命中见 [[dap-pc2line-line-attribution]]）。文档中该条已从「整表替换」限制改为「verified 语义」限制。

**验证**：
- e2e `vscode/qzjs-debug/test/breakpoint-scope.mjs`：两个真实源（入口脚本 + `__native__.nativeEvalScript(helper代码, /tmp/dap_scope_helper.js)` 产生的第二真实文件名）+ 对第三文件的 set 与 clear 请求。**修复前 FAIL**（"SRC breakpoint wiped by another file's setBreakpoints"，stops=1），修复后三停全对（entry → SRC:3 → HELPER:1）→ terminated。
- gtest `DapDebugger.PerFileBreakpointScope`（test/test_dap_gtest.cpp，复用 child_main）：`<initial>` 断点在 `<second>` 的 set+clear 之后仍命中 line 3；清空响应回 `"breakpoints":[]`。
- 全量：ctest 26/26、npm 4/4（SMOKE / DEBUGGER-STMT / LINE-COVERAGE / BREAKPOINT-SCOPE）、tsc 干净；非调试器 `build/` 亦编译通过。

**gotcha**：qzjs 没有文件模块 loader（`import()` 报 "could not load module"），测试想拿到第二个真实文件名只能用 `__native__.nativeEvalScript(code, filename)`（`src/host/bridge.c`；注释写 `pal.nativeEvalScript`，实际 CLI 全局名是 `__native__`，bootstrap cli.c:196-198 也是这么用的）。


## Timeline

- time: 2026-09-27T05:21:34
  kind: decision
  summary: "Created this page: DAP setBreakpoints 按文件作用域替换（不再清整表）"
  source: "2026-09-27 setBreakpoints 作用域修复会话"
  affects: [dap-setbreakpoints-scope]

- time: 2026-09-27T05:21:34
  kind: decision
  summary: "定案：setBreakpoints 按 source.path 作用域替换 + 无 path 请求不碰表；qz_debug_clear_breakpoints_in_file；e2e/gTest 双验证全绿"
  source: "2026-09-27 setBreakpoints 作用域修复会话"
  affects: [dap-setbreakpoints-scope]
