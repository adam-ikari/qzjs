---
id: bc-reader-hardening
title: "字节码读取器加固（untrusted stream 防御）"
category: decision
status: active
tags: [fuzz, quickjs, bytecode, security]
created: "2026-09-19T14:33:30"
updated: "2026-10-06T13:43:42"
---

<!-- compiled_truth -->
<!-- compiled_truth -->
## 字节码读取器加固（untrusted stream 防御）

qzjs 对不可信字节码流做防御（JS_ReadObject 等）。此前回归靠固定种子语料。

## 2026-10-06 新发现：随机 fuzz 段命中潜在引擎 SEGV（非确定性）

`fuzz-smoke` job 的**随机 fuzz 段**（非种子回放段）在 v0.4.0 发版 CI 上命中一次
崩溃。完整栈全在 `deps/quickjs-ng/quickjs.c`（引擎，非 qzjs 代码）：

    JS_ReadObject → JS_ReadObjectRec → JS_ReadFunctionTag → JS_ReadModule
      → JS_ThrowSyntaxError → JS_MakeError → JS_NewObjectProtoClass
      → JS_NewObjectFromShape → js_trigger_gc → JS_RunGC → gc_decref
      → mark_children → JS_MarkContext → js_mark_module_def
      → SEGV on address 0x10 (READ, near-null)

特征：
- 读取**格式错误**的字节码时，模块解析抛语法错误 → 构造 Error 对象触发 GC →
  `js_mark_module_def` 解引用近空指针。即「读一半失败的模块」在 GC mark 阶段
  遍历到了未/已失效的 def 指针。
- 同轮日志另有大量 `AddressSanitizer failed to allocate 0xffffffffe0000087 bytes`
  —— 字节码里的大小字段发生整数下溢/上溢，得出巨大的分配尺寸。该 job 的
  `ASAN_OPTIONS` 设了 `allocator_may_return_null=1`，所以分配返回 NULL 而非 abort，
  随后某处未检查 NULL 即解引用，最终以这个 SEGV 收场。

**严重性**：qzjs 读不可信字节码的路径对宿主是可达的（`qzjs --bytecode <file>`、
内嵌 polyfill、worker boot shim）。崩溃点在引擎，但触发输入来自不可信流。

## 两个必须记录的**测试方法缺陷**（与本次崩溃同等重要）

1. **崩溃输入丢失**：该 job 跑 `./fuzz_bc` 但**没有 `--artifact_prefix`、也没有
   `actions/upload-artifact`**，所以这次命中的输入没被保存。下次不一定能重现。
   要复现只能本地重跑 fuzz。这是 fuzz 流水线的硬伤——**发现即丢失，等于没发现**。
2. **随机 fuzz 段挂在 required check 上 = 天然 flaky 门**：60s 随机变异，找不找得到
   崩溃与 PR 内容无关（v0.4.0 只改了版本号 + CHANGELOG，不可能引入引擎崩溃，却
   被它拦下；同一 master tip 上一轮是绿的）。作为合并硬门，它会随机红。

**确定性门（种子回放）本轮是绿的**（16 个种子全部 clean）——真正的回归底线没破。

**给后来者的处置判据**：
- 种子回放红 ⇒ 真回归，必修。
- 仅随机 fuzz 段红 ⇒ 先按「潜在引擎缺陷」记录 + 修流水线（保存输入 / 让随机段非阻塞），
  不要拿它当作「本 PR 引入」而回滚无关改动，也不要只靠「重跑到绿」就放过。

## 与既有结论的关系

本条**未**推翻此前的加固结论；它说明的是——固定种子语料覆盖不到的缺陷面，仍需靠
随机 fuzz 探索，而当前流水线**既留不住发现、又拿随机结果当门**。两处都要修。


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
