---
id: bc-reader-hardening
title: "字节码读取器加固（untrusted stream 防御）"
category: decision
status: active
tags: [fuzz, quickjs, bytecode, security]
created: "2026-09-19T14:33:30"
updated: "2026-10-06T14:25:58"
---

<!-- compiled_truth -->
<!-- compiled_truth -->
## 字节码读取器加固（untrusted stream 防御）

qzjs 对不可信字节码流做防御（JS_ReadObject 等）。

## 2026-10-06：CI 崩溃根因定位 + 源码级修复（运行时验证待定）

**CI 崩溃（js_mark_module_def SEGV @ 0x10）根因已确证**，与栈精确吻合：

1. `js_new_module_def()`（quickjs.c:30345）创建模块时即 `list_add_tail` 到
   `ctx->loaded_modules`——模块从诞生起就对 GC 可见。
2. `JS_ReadModule()`（:40078）读入攻击者控制的 `X_entries_count`（leb128），
   此刻对应 entries 数组**尚未分配**（仍 NULL）。
3. 校验 `count < 0 || count > buf_end - ptr` 失败 → `JS_ThrowSyntaxError()` →
   构造 Error 对象 → **可能触发 GC**（`JS_MakeError→JS_NewObjectFromShape→
   js_trigger_gc→JS_RunGC`）。
4. GC → `JS_MarkContext()` 遍历 `loaded_modules` 找到该半成品模块 →
   `js_mark_module_def()` 按 `count` 遍历 `NULL` entries 数组 →
   `me = &m->export_entries[i]` = NULL → `me->export_type`（结构体偏移 0x10）
   → **SEGV @ 0x10**。精确对上 CI 栈 `js_mark_module_def:30361` + `SEGV 0x10`。

**为何既有 `qwrt fix (2/2)` 漏了**：`fail:` 处把 count 夹到 size，但那只在
`goto fail` 之后跑；**GC 发生在 `JS_ThrowSyntaxError` 内、`goto fail` 之前**，夹晚了。

**修复**（已应用，源码级正确）：4 处校验抛错点（req/export/star_export/import）
在 `JS_ThrowSyntaxError` **之前**把对应 count 置 0，使 GC mark 跳过（count=0 +
NULL 数组 = 一致的空模块）。合法输入永不进校验抛错路径，故**不可能回归**。遵循
既有「qwrt fix」本地补丁模式（patch 位于子模块工作区未提交处，与既有 184 行同）。

**验证状态——诚实标注为「运行时未定」**：
- 引擎重建无错，补丁后 20 个精选种子回放 4 崩 vs 基线（无补丁）5 崩 → **不是回归**
  （在噪声内），但也**未能证明修复消除了 CI 那个崩溃**。
- **本地复现不可靠**：该 bug 是 GC 时序/内存压力依赖的——240s fuzz 未复现；
  同一输入在「循环批量拉起」下崩、在「隔离单跑」下不崩（ASan 影子内存下 GC 触发
  时机随进程拉起频率变）。我的 loop 测量与隔离测量互相矛盾 → **观测手段本身不可信**。
- 正确的验证路径：CI fuzz job（现已有 artifact 上传）下次捕获复现输入 → 提升为
  `test/fuzz-corpus/` 种子 → **确定性种子回放门**在每次 CI 上验证该修复。

**新发现（预存问题，非本补丁解决）**：20 个**精选**种子中约 5 个（~25%）在「循环
批量拉起、GC 有压力」条件下崩溃，**基线（无补丁）即如此**。这些是精心策划的回归
种子，却在内存压力下成为「地雷」——说明语料里存在触发 GC 窗口 bug 的输入。这是独立
于本补丁的、更深的问题：种子回放门若在 CI 上以低内存/单进程方式跑，可能漏掉这批。
值得单独立项。

**过程中的一次自身失误（教训）**：240s fuzz 把第一个 corpus 参数当读写目录，
**往 `test/fuzz-corpus/` 写回 545 个生成输入**（20→565），污染了精选语料。已
`git clean` 还原（20 个 tracked 种子复原）。教训：libFuzzer 第一位置参数是
输入+输出语料目录；只想写输出必须把输出目录作为第二位置参数且输入目录只读对待，
或每次事后核对语料被改。**又一次「观测/操作手段本身有毒」**。

## 与既有结论的关系

不推翻既有加固。本条确立：CI 那次崩溃是**已定位、可源码级修复**的 GC 窗口 bug；
但其运行时验证依赖 CI fuzz 捕获复现，而捕获能力正是本轮刚修复的流水线缺陷
（无 artifact 上传）。**「发现即丢失」的流水线缺陷，与「修复待验证」的引擎 bug，
是同一根因链的两端。**


## Timeline

- time: 2026-09-19T14:33:30
  kind: decision
  summary: "Created this page: 字节码读取器加固（untrusted stream 防御）"
  source: created via brain create-page
  affects: [bc-reader-hardening]

- time: 2026-09-19T14:36:02
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [bc-reader-hardening]

- time: 2026-09-29T11:03:14
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "brain update-truth: 语料数 19→20 + 语料对齐不变式"
  affects: [bc-reader-hardening]

- time: 2026-09-29T11:03:29
  kind: note
  summary: "本轮最值钱的发现是一个**已经发生过、但因为没有判据所以没人发现**的漂移：test/fuzz-corpus/ 里那几个 seed-polyfill-head*.bc / seed-workerboot.bc 的定义是「仓库自己那份字节码的头 N 字节」，而真实字节码在 tracked 的 src/polyfill_default.c 与 src/worker_boot_default.c 里。字节码会随 quickjs patch 与 polyfill 改动而变，语料不会自动跟着变——核对发现 HEAD 上那四个的头 4 字节是 1b99c2fa / 1bbc192a，而仓库真实的是 1cb7bf5b / 1c7ae3a5，polyfill/ 与 deps/quickjs-ng 指针都没动，所以漂移不是最近引入的。漂移的后果隐蔽在于它不产生任何错误信号：这些 seed 仍然能喂给 JS_ReadObject，解析失败不算崩，CI 的重放门照绿，但 fuzz 那 60 秒预算是在一个已经不存在的字节码形态附近做变异——而 CI 注释自己写着 seeded run 的全部意义就是「spends its time mutating around known-interesting shapes rather than rediscovering the container format from scratch」。判据取「整个文件等于真实字节码的同长前缀」，比 4 字节强、不含魔数，已固化成 test/fuzz_corpus_align_check.py 并接进 make gates 与 CI。
由此可复用的判据：当某个「样本/快照/基线」被声明为「从某个源生成的」，就要有一条机械可验的等式把两者绑住，否则漂移永远不会被发现——尤其是当消费端**不校验**来源的时候（本例是解析失败不算错误）。更一般的说法是：**一类缺陷之所以长期存在，通常不是因为难，而是因为没有任何东西会为它变红**。这与之前那条「判据/示例一旦没有执行器就等于不存在」是同一件事的另一个面向——上次的例子是文档示例没人编译，这次的例子是语料没人比对。"
  source: "2026-09-29 语料对齐不变式与新门"
  affects: [bc-reader-hardening, code-quality-requirements]

- time: 2026-10-06T13:43:42
  kind: decision
  summary: "记录 fuzz 随机段新发现的潜在引擎 SEGV（js_mark_module_def，quickjs-ng），崩溃输入丢失；并指出 CI fuzz 段缺 artifact 上传"
  source: "2026-10-06 v0.4.0 发版时 fuzz-smoke job 红"
  affects: [bc-reader-hardening]

- time: 2026-10-06T14:25:58
  kind: decision
  summary: "定位 CI 崩溃根因（GC 在 count 校验抛错时遍历半初始化模块）+ 源码级补丁；诚实标注本地验证不可靠，并记录 20 个精选种子在 GC 压力下 ~25% 崩溃的预存问题"
  source: "2026-10-06 v0.4.0 发版后深挖；四轮本地复现尝试"
  affects: [bc-reader-hardening]
