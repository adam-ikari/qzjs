---
id: rename-argparser-regression
title: "改名漏改类回归：argparse 定义名与读取名不匹配"
category: decision
status: active
tags: [test, regression, rename]
created: "2026-09-23T05:50:05"
updated: "2026-10-13T08:05:40"
---

<!-- compiled_truth -->
## 结论

**改名漏改类回归**：`8ac7ed7c`（amoib→qzjs 改名）把 argparse 的**定义名**改成 `--qzjs-bin`（`dest=qzjs_bin`），但**读取处**仍写 `args.qz_bin` → `AttributeError` 立即崩溃。

- **影响面**：6 个测试/基准脚本全中，CI 有 6 处调用长期红——`test_httpserver_e2e` / `test_fetch_proxy_e2e` / `bench_httpserver` / `bench_runtime` / `bench_tls_server` / `bench_grpc_unary`（另 `compat_check` 同类）。
- **修复**：`ef982e08` 全维度评审 P0 一并修（读取处 `args.qz_bin` → `args.qzjs_bin`）。

## 教训（可复用的判据）

1. **改名须机械核对「定义名 ↔ 读取名」**：argparse `add_argument("--foo-bar", dest="foo_bar")` 的定义与 `args.foo_bar` 读取是两处，改名工具只改一处即静默失配（前者报 AttributeError 立即崩；若用 `getattr(args, k, None)` 则会静默取默认值，更险）。
2. **回归防护 = 任何 `--foo-bar` 参数跑一次 `--help`**：`--help` 会实例化 parser 并对每个定义名做 dest 解析，能廉价捕获定义/读取不一致类缺陷。

## 残留（无害，仅内部命名）

`AmoibServer` 类、`find_amoib()`、`vs_amoib` JSON 键、`amoibBin` 变量——纯内部命名，未随改名清理，不影响行为。


## Timeline

- time: 2026-09-23T05:50:05
  kind: decision
  summary: "Created this page: 改名漏改类回归：argparse 定义名与读取名不匹配"
  source: created via brain create-page
  affects: [rename-argparser-regression]

- time: 2026-10-13T08:05:40
  kind: decision
  summary: "补真内容：改名漏改类回归（8ac7ed7c amoib→qzjs：argparse 定义名 --qzjs-bin/dest=qzjs_bin 但读取处 args.qz_bin → AttributeError）。6 脚本 + CI 长期红，ef982e08 修复。教训：改名须机械核对定义名↔读取名；回归防护 = 任意 --foo-bar 参数跑一次 --help。"
  source: "git ef982e08 提交正文 + 全维度评审 P0 记录"
  affects: [rename-argparser-regression]
