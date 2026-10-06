---
id: tls-ca-trust-store
title: "运行时 CA 信任库（qz_add_ca_pem）：追加语义与无跳过开关"
category: decision
status: active
tags: [tls, security, api, mbedtls]
created: "2026-10-06T03:16:13"
updated: "2026-10-06T03:16:29"
---

<!-- compiled_truth -->
<!-- compiled_truth -->
## 是什么

`int qz_add_ca_pem(qz_t *rt, const char *pem)` —— 宿主在 **JS 执行前**追加 PEM 证书到
per-rt 的 CA 信任库。TLS op 建连时把它**追加**进系统 CA（四个固定路径：Debian/Ubuntu、
RHEL/CentOS、OpenSUSE、FreeBSD）之后。

消费点在 `uv_io.c` 的 `uv_io_tls_load_host_ca()`（从 `tls_init_op` 抽出的具名函数）。

## 四条裁决（各自都有否决过的替代方案）

### 1. 追加，不替换系统信任
`mbedtls_x509_crt_parse` 追加到已有链，故自建 CA 与公有 CA 同时有效。
**否决**：替换语义。看似"更可控"，实际让宿主一调就把公有 CA 全灭——自建 CA 的部署
场景恰恰常在需要连公有 API 的环境里。

### 2. 恒 `VERIFY_REQUIRED`，**不提供**跳过校验的开关
证书校验语义与引入前完全一致。**这是刻意的**：加一个"跳过验证"开关能省掉自签证书的
麻烦，但极简哲学第 4 条说得很死——多暴露一个能力就扩大可被触达的攻击表面积。
若将来真需要（如私有调试环境），正确做法是**独立的构建档**（如 `QZ_PROFILE=bare`
那套机制），不是往运行时 API 里开后门。

### 3. 只存 PEM 字节，不存 `mbedtls_x509_crt`
runtime 只持有一块 `char *ca_pem`（`ca_pem_len` **不含**末尾 NUL）。**否决**：让 runtime
持有一份共享的 mbedtls 证书链。它看着能省掉每 op 重复解析，但那份结构的生命周期随 op
走（`tls_init_op` 建 / `tls_free_op` 释放），跨 op 共享必然悬垂。各 op 各自解析进自己
的 `op->ca_certs` 是唯一无共享的做法。

### 4. 无锁，约束为「JS 开始执行前调用」
**否决**：给信任库加锁。理由——它不是热路径（启动期调一次），而新增一把锁要多一个
字段 + 一套加解锁 + 一份并发契约。约束写进公共头即可。
**代价要说清**：运行中调用会与 in-flight 握手并发改到别人正在读的信封，不做保护。

## 两个易踩的实现坑

- **长度约定**：`mbedtls_x509_crt_parse` 要 **NUL 终止**缓冲，故传 `ca_pem_len + 1`
  （`ca_pem_len` 不含 NUL）。同 `tcp_io.c` 的 PEM 路径。回归测试的负控就是去掉这个 `+1`
  ——去掉后测试立即变红，确认它锁住了真实约定。
- **定义位置**：`qz_add_ca_pem` **不可**放进 `#if QZ_WITH_TLS`。公共头无条件声明它，
  而 `test/api_surface_check.py` 要求 isolated/thread 两个模型的静态库都真有该符号。
  只在 TLS 分支定义 → `QZ_WITH_TLS=OFF` 的构建编译通过、链接才炸。

## 测试边界（诚实）

`test/test_tls_ca_gtest.cpp` 调**生产函数**，不复现 parse——复现版只会测到测试自己写对
的约定。它锁的是缓冲契约 + 解析路径。

**未覆盖**：真实 mbedtls 握手（自签服务器 + `fetch`）。现有 gtest 跑在 `mock_libuv` 上，
无真实套接字。要覆盖需真实 libuv e2e + TLS 服务器夹具。


## Timeline

- time: 2026-10-06T03:16:13
  kind: decision
  summary: "Created this page: 运行时 CA 信任库（qz_add_ca_pem）：追加语义与无跳过开关"
  source: "2026-10 PR#8 偿还技术债 B"
  affects: [tls-ca-trust-store]

- time: 2026-10-06T03:16:29
  kind: decision
  summary: "运行时 CA 信任库：追加不替换、恒 VERIFY_REQUIRED、不提供跳过开关、启动期无锁"
  source: "2026-10 PR#8 实现时的四条设计裁决"
  affects: [tls-ca-trust-store]
