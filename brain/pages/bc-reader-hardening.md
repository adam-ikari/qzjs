---
id: bc-reader-hardening
title: "字节码读取器加固（untrusted stream 防御）"
category: decision
status: active
tags: [fuzz, quickjs, bytecode, security]
created: "2026-09-19T14:33:30"
updated: "2026-09-29T11:03:29"
---

<!-- compiled_truth -->
## 字节码读取器加固（untrusted stream 防御）

**结论**：quickjs-ng 字节码读取器（JS_ReadFunctionTag 等）按 untrusted 输入防御，加固以 `deps/quickjs-ng-bc-reader-hardening.patch` 分层注入（c99-atomics → drain-jobs → hardening 三补丁链）。

**硬性不变量**（2026-09-19 定稿，CI run 35448802113 全绿验证）：
1. `local_count` 必须**严格等于** `arg_count + var_count`，且校验在 `function_size` 计算/`js_mallocz` **之前**。free 路径按 arg+var 走 vardefs，任何上界/钳制版本都会留下"分配 < 遍历量"的 OOB 窗口（fuzzer 实证两次）。
2. `byte_code_len` 安全前置：`b->byte_code_len = 0` 先写，流值只在字节确实读入后才赋给 b；否则 fail 路径 free 走流值长度越界。
3. 各 count 校验必须在分配之前；`opcode < OP_COUNT` 前置；`source_len`/`pc2line_len` 必须真在剩余流字节内（字节级界，不是乘积界）。
4. hardening patch 文件导出时必须剔除 drain hunk（三补丁链会重复定义 `JS_DrainPendingJobsForContext`）——patch 文件按"对上游 git 基线的 diff"生成时天然包含前序补丁内容，需过滤。

**corpus gate**：`test/fuzz-corpus/` 20 seeds + CI 重放门。seed `crash-73a0` 曾暴露 cpool 嵌套函数失败路径，随 byte_code_len 前置修复后可回归 gate**——此前它只存在于工作区、未入库，而本行早就写着「可回归 gate」，入库才是兑现。

**语料对齐不变式（已固化为门）**：`seed-polyfill-head{4k,8k,64k}.bc` 与 `seed-workerboot.bc` 的定义是「仓库自己那份字节码的头 N 字节」——真实字节码在 tracked 的 `src/polyfill_default.c` / `src/worker_boot_default.c` 的 .rodata 里。字节码会随 quickjs patch 与 polyfill 改动而变，而语料不会自动跟着变；漂移之后它们仍然能喂给 JS_ReadObject、CI 重放门也不会报错，但 fuzz 那 60 秒预算会在一个**已经不存在的字节码形态**附近做变异。核对时发现已经漂移过（头 4 字节是 1b99c2fa / 1bbc192a，而仓库真实的是 1cb7bf5b / 1c7ae3a5），重新生成才对得上。判据取「整个文件等于真实字节码的同长前缀」，比 4 字节强得多也不含魔数，由 `test/fuzz_corpus_align_check.py` 守住，已接进 `make gates` 与 CI。
**教训**：每轮"放宽/收紧"校验必须本地 CI-Debug 等效构建（/tmp/ci_dbg）验证全 corpus + polyfill/workerboot 加载，避免 Release-only 绿假象。


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
