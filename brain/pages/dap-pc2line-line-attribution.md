---
id: dap-pc2line-line-attribution
title: "DAP 断点行归属修复：pc2line 表早一个语句（quickjs-ng resolve_labels peephole）"
category: decision
status: active
tags: [dap, debugger, quickjs, bytecode, pc2line]
created: "2026-09-26T21:17:27"
updated: "2026-09-27T04:13:22"
---

<!-- compiled_truth -->
## 决策：pc2line 行归属 + 行覆盖（DAP 断点行正确性，两轮修复）

### 第一轮：行归属（条目早一个语句）

**根因**（字节码 dump 证实）：quickjs-ng `resolve_labels` 的 peephole 通过 `code_match` 前瞻时会跳过 `OP_source_loc` marker 并返回*最后一个被跳过的 marker* 的行（即下一语句的行），随后在 `add_pc2line_info(bc_out.size, …)`（当前输出位置）之前先采纳该行 → 行表条目整体早一个语句。测试程序 `f` 的表曾是 (1,3),(2,4),(4,5)：行 3 断点在 PC1（上一语句 `var x=1` 的 store 尚未执行）命中 → `locals.x` 为 undefined → evaluate 返回 result:"error"。

**修复**（3 处，全部在 `deps/quickjs-ng/quickjs.c`，镜像进 `deps/quickjs-ng-debugger.patch`）。不变量：条目必须用"被合并 opcode 起始处的行"，lookahead 消费的 marker 在 emit 之后才生效。
1. 语句入口 `emit_source_loc`（首轮只做了 `case TOK_VAR`，第二轮上移为通用入口，见下——TOK_VAR 专用 emit 已删）。
2. `OP_put_loc` fold（put_x+get_x→set_x）：先 add 再采纳 cc.line/col。
3. `OP_post_inc` fold（第二次 `code_match` 可跨语句吞掉下一句的 get_x）：引入 `bool fold`，先 add+emit 再在 `if (fold)` 内采纳。

**第一轮结果**：`f` 表 = (0,2),(2,3),(4,4),(6,5)；行 3 断点在 PC2 命中，evaluate `locals.x==1`、stackTrace 行 3 均正确。

### 第二轮：行覆盖（语句行根本没有条目 → 断点静默不触发）

**根因**（覆盖探针逐行验证）：pc2line 表只在少数位置有条目——`return 1;`、`break;`、`continue;`、`case`/`default:`、`try`/`catch`/`finally` 头、`do {`、`else`、空语句 `;`、多声明 `var` 的后续行**全都没有条目**，断点设在那里永远不触发（verified 但不命中）。

**录制模型关键事实**：`add_pc2line_info` 在 phase-3 `resolve_labels` 的 **opcode 输出时刻**以"最后见到的 marker"记账；marker 若在任何 opcode 之前被覆盖（相邻 marker 链、`OP_label`、phase-2 已消费的 `OP_enter_scope`、`skip_dead_code` 跳过的 marker），其行号**永远不会被记录**。阶段管线：parse 发 `OP_source_loc` → phase-2 `resolve_variables` 消费 scope/nop、只计数 → phase-3 `resolve_labels` 记 pc2line 并剥 marker。

**修复**（4 组，全在 quickjs.c）：
1. `js_parse_statement_or_decl` 入口统一 `emit_source_loc(s)`（先于 label 处理）——取代并包含首轮的 TOK_VAR 专用 emit（已删）。
2. 非语句的子句位置补 marker：switch 的 `case`（子句循环内）、`default:`、`catch`/`finally`（next_token 前）、TOK_IF 的 `else`（`emit_goto(OP_goto)` 之后）、`js_parse_var` 声明符循环。
3. **录制面修复**（phase-3 `case OP_source_loc`）：`new_line != line_num && line_num != s->line_number_last` 时，在**当前输出位置** `add_pc2line_info(bc_out.size, line_num, col_num)` + `dbuf_putc(&bc_out, OP_nop)` 占位。位置无关、天然覆盖被跳过/跳死的行；仅列号不同不记（bp 按行匹配）。**勿走回头路**：解析侧塞 nop 无效——phase-2 `resolve_variables` 会剥掉所有 `OP_nop`（`case OP_nop: /* remove erased code */`）。
4. switch 收尾（`js_parse_expect('}')` 之后、`emit_label(label_break)`/`OP_drop` 之前）补 marker：让 break 落点挂到下一语句行，否则继承最后子句行——实测假停在行 12（drop 被记成 default 体行）；marker 落点必须在 `OP_drop` **之前**，否则条目记在 drop 之后一格，`find(26)` 仍返回旧行。

**已知并接受的怪癖**：右花括号行（无语句字节码）不可断点（测试程序行 4/13/20/22）；try/finally 出口的 gosub 续段物理位于 catch 体行区域 → 该行断点再触发一次（改挂未来行会破坏单步语义）；do-while 回跳每轮重新触发 `do {` 行（行入口语义，正确）。

**第二轮验证**：覆盖探针——33 行测试程序全部语句行（2..31 除收尾括号）都有条目，toplevel = `(14,33,1)` + 行 1 靠 `b->line_num` fallback；`vscode/qzjs-debug/test/line-coverage.mjs` 17 个断点断言精确停顿序列 `2,5,6,7,5,6,7,5,6,7,8,9,10,14,15,16,17,18,19,17,21`（5×3 = do-while 三轮，17×2 = finally 续段怪癖，均有注释）；ctest 26/26、npm 3/3（SMOKE/DEBUGGER-STMT/LINE-COVERAGE）、tsc --noEmit 干净；patch 522 行 20 hunks，gold 4 文件 cmp 全同、reverse dry-run OK、hunk 计数 0 mismatch。

**推论（勿走回头路）**：只加 TOK_VAR marker 不足以修好该测试——fold 仍会把行 3 记到 PC1；DAP 侧行匹配/换行约定也无解，必须修表。语句行不触发同理：必须修引擎侧 marker/录制面，DAP 侧无解。

## 工作流 gotcha：子模块 patch 镜像

- `git -C deps/quickjs-ng diff` 是 4 个 configure-time patch 的**超集**（c99-atomics → drain-jobs → bc-reader-hardening → debugger，见 CMakeLists.txt:333-486）。debugger-only delta 必须 diff(worktree, HEAD+atomics+drain+bc)，基线副本在 `/tmp/opencode/base_patched`（已核对：与 fresh HEAD+3patch 逐字节相同，c-atomics.h 同步过）。
- 镜像流程：`git diff --no-index --src-prefix= --dst-prefix= base_patched/quickjs.c <worktree>/quickjs.c > /tmp/opencode/qjs_debugger_only.diff` → `python3 /tmp/opencode/assemble_patch.py`（保留 header/opcode/quickjs.h 三段字节相同，只换 quickjs.c 段）→ 覆盖 `deps/quickjs-ng-debugger.patch`。
- 金标准校验：把 4 个 patch 依 CMake 顺序应用到 clean HEAD 副本 → `cmp` 四文件（quickjs.c / quickjs.h / quickjs-opcode.h / quickjs-c-atomics.h）与工作树逐一相同；再加 hunk 计数校验（/tmp/opencode/hunkcheck.py）+ 对已 patch 树的 reverse dry-run。
- 旧 patch 的 a-side 基线是 stale 的 v0.16.2（HEAD 已是 0.17.0）——靠 offset 也能应用，但重建时已刷新为 configure 时基线。
- **构建时序 gotcha**：改 quickjs.c 后必须真正 `cmake --build build_dbg`（`libqjs.a` mtime 要新于源文件）；一次被过滤掉输出的构建命令可能实际没重编，导致"改了但行为没变"的假阴性——用探针/测试验证前先查 `stat libqjs.a`。

## 验证状态

- ctest 26/26；vscode/qzjs-debug npm test 3/3（SMOKE、DEBUGGER-STMT、LINE-COVERAGE）；tsc --noEmit 干净；patch 522 行 20 hunks，hunk 计数 0 mismatch，reverse/forward/gold 全过。
- 构建再生产物随之变化（预期内、已测试通过）：`dist/polyfill.bytecode`、`dist/worker-boot.bytecode`、`src/polyfill_default.c`、`src/worker_boot_default.c`——引擎字节码里的 pc2line 表变了，rebuild 会重新生成；勿手工回滚。
- 文档已同步：`docs/dev/debugging.md` + zh 版 What works（全语句种类命中）/ Limitations（右花括号不可断点、finally 续段怪癖）/ 测试清单（line-coverage.mjs）。


## Timeline

- time: 2026-09-26T21:17:27
  kind: decision
  summary: "Created this page: DAP 断点行归属修复：pc2line 表早一个语句（quickjs-ng resolve_labels peephole）"
  source: "2026-09-26 pc2line 修复定案会话"
  affects: [dap-pc2line-line-attribution]

- time: 2026-09-26T21:17:42
  kind: decision
  summary: "pc2line 行归属修复定案：根因（resolve_labels peephole 跨语句取 marker 行）+ 3 处修复 + patch 镜像工作流 + 验证状态"
  source: "2026-09-26 pc2line 修复定案会话"
  affects: [dap-pc2line-line-attribution]

- time: 2026-09-27T04:12:43
  kind: decision
  summary: "第二轮定案：语句入口 marker + phase-3 录制面修复（被跳过 marker 就地补条目）+ switch 收尾 marker；pc2line 行覆盖全绿，patch 522 行重镜像，gold/hunk/reverse 全过"
  source: "2026-09-27 断点行覆盖修复会话"
  affects: [dap-pc2line-line-attribution]

- time: 2026-09-27T04:13:22
  kind: decision
  summary: "修正上一条：移除误入 compiled_truth 的重复 '## Timeline' 标题（结构修复，内容不变）"
  source: "2026-09-27 断点行覆盖修复会话"
  affects: [dap-pc2line-line-attribution]
