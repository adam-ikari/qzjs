---
id: cross-process-config-audit
title: "跨进程配置传递审计：qjs 配置字段/env/单槽 tracker 的扫描判据与结论"
category: decision
status: active
tags: [audit, cross-process, ipc, methodology]
created: "2026-10-06T10:04:34"
updated: "2026-10-06T10:04:50"
---

<!-- compiled_truth -->
<!-- compiled_truth -->
## 背景

#9~#16 一连串缺陷的共同形态：**一个值设在一处、真正用它的在另一个进程边界之后，
且跨过去时无声无息**。本页把这类缺陷固化成**可复现的扫描判据**，并记录
2026-10 全库扫描的结论（含否定项——避免下一个人重复劳动）。

## 四条扫描判据

### 1. `qz_config_t` 每个字段 → 是否都出现在 `rt_host.c` 的 argv 组装里？
逐一核对，**缺的即跨进程丢失**。ISOLATED（默认进程模型，`CMakeLists:72`）
下 runtime 只存在于 `qzjs-rt` 子进程（宿主进程只有通道桩）。

### 2. 子进程里 `rt->config.*` 有没有被**硬编码覆盖**？
本次命中 `rt_main.c` 的 `rt->config.debug = 0`。

### 3. 只有 `getenv` 无对应 `setenv` 的外部配置 → 在哪个进程读？跨边界吗？
子进程 exec 继承 `environ`，所以 `getenv` 类配置天然跨进程（strict 模式与
CA 都走这条）；`argv` 类配置必须显式加进协议。

### 4. 公共 API 字段的行为是否依赖 `QZ_PROCESS_MODEL`？
**CLI 走 env 路径往往掩盖库宿主的失效路径**——`config.debug` 就是这样：
CLI 用 `QZ_DEBUG` 一直正常，库宿主设 `config.debug` 全程无效。

**判据的价值来自对照**：「CLI 正常 + 库失效」=跨进程边界丢配置。

## 2026-10 全库扫描结论

| 检查项 | 结论 |
|---|---|
| `qz_config_t` → argv | **命中**：`debug` 缺失（已修 #16，`--debug <真实值>`） |
| 子进程 `config.*` 硬编码 | **命中**：仅 `debug = 0` 一处（已修） |
| env 通道配对 | 干净：`QZ_LOCALSTORAGE_FILE`/`QZ_POLYFILL_FILE`/`QZ_DEBUG` 均在 RT 进程读、经 exec 继承，正常 |
| `qz_t` 只写不读的僵尸字段 | **无**（`active_stream` 确为唯一，已随 #12 前身删除） |
| 单槽 tracker（覆盖并发） | **无**（同上） |
| `free_port()` 名不副实 | 5 处定义中**仅 1 处**是计数器（`test_fetch_proxy_e2e.py`，已修 #13），其余 4 处均为正确的 `bind(0)` 探测 |
| `bench_tls_server.ensure_cert()` 2 天证书缓存 | **假阳性**：证书是服务端用，`mbedtls_x509_crt_parse_file` 解析不校验有效期（见 `tls-ca-trust-store` 页），wrk 亦不做 TLS → 过期不致失败 |

## 已知取舍：PROCESS worker 的异步工作被截断（**不是 bug**）

`qz_idle_walk_cb` 豁免 PROCESS worker 的 IPC pipe（`qz_proc_handle_is_pipe`），
因此父的 idle 判定**不把 PROCESS worker 的在途工作算作忙**。

**这是显式权衡，代码注释写明**（`ipc_process.c:1110`）：
pipe 随 child 生命周期恒活动，*不豁免则父永不判 idle → 宿主卡死*。
即拿「正确性」换「可退出性」。

对比 THREAD worker（#14 已修）：

| | 跨边界信号 | 能否记账 |
|---|---|---|
| THREAD worker | 共享进程 → 原子位可传 | 能 → 已修 |
| PROCESS worker | 唯一信号是恒活动 pipe | 不能，除非新增 worker→父忙闲协议 |

IPC 控制帧只有 READY/IDLE/SHUTDOWN/CLOSING/PING/PONG/PFAIL，**IDLE 仅存在于
宿主↔主RT之间**，worker 与父之间无忙闲协议。故修它需协议设计决策，
属独立事项（与 CI 记录的 worker drop-out bug 同一根因）。


## Timeline

- time: 2026-10-06T10:04:34
  kind: decision
  summary: "Created this page: 跨进程配置传递审计：qjs 配置字段/env/单槽 tracker 的扫描判据与结论"
  source: "2026-10 用 #9~#16 沉淀的判据全库扫描"
  affects: [cross-process-config-audit]

- time: 2026-10-06T10:04:50
  kind: decision
  summary: "跨进程配置传递审计：可复用的四条扫描判据 + 2026-10 全库扫描结论（含否定项）"
  source: "2026-10 以 #9~#16 沉淀的失效模式扫全库"
  affects: [cross-process-config-audit]
