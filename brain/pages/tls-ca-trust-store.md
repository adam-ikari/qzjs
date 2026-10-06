---
id: tls-ca-trust-store
title: "运行时 CA 信任库（qz_add_ca_pem）：追加语义与无跳过开关"
category: decision
status: active
tags: [tls, security, api, mbedtls]
created: "2026-10-06T03:16:13"
updated: "2026-10-06T04:16:28"
---

<!-- compiled_truth -->
<!-- compiled_truth -->
## 是什么

`int qz_add_ca_pem(qz_t *rt, const char *pem)` —— 宿主追加 PEM 证书到 per-rt 的 CA
信任库。TLS op 建连时把它**追加**进系统 CA（四个固定路径：Debian/Ubuntu、RHEL/CentOS、
OpenSUSE、FreeBSD）之后。

消费点在 `uv_io.c` 的 `uv_io_tls_load_host_ca()`（从 `tls_init_op` 抽出的具名函数）。

## ⚠️ ISOLATED 下的跨进程陷阱（最容易再踩一次）

**ISOLATED 模型下宿主与主 RT 是两个进程、各持一个 `qz_t`。**

在 `qz_create()` 之后对**本进程** rt 调 `qz_add_ca_pem()`，写的是**父进程**的
`rt->ca_pem`；而真正跑 JS、做 TLS 握手的是 `qzjs-rt` **子进程**，它自己的 `ca_pem`
恒为空。于是该调用**静默无效**：握手照常走系统 CA，私有 CA 的站点报
`X509 - Certificate verification failed`——**症状指向证书，真因是信任库从没跨过
进程边界**。

**为什么 gtest 查不出来**：gtest 跑在 `mock_libuv` 的**进程内**，天然没有这条边界。
本项目的 mock 测试全绿而真实 CLI 完全不生效，两边都说得通。

**通道**：沿用 strict 模式**既有**的做法（`QZ_STRICT_SANDBOX` 同款，不新造机制）：
`cli.c` 解析 `--ca` 时 `setenv("QZ_CA_FILE", path, 1)`（必须早于 `qz_create`——
它在内部 exec 子进程），`rt_main.c` 启动时 `getenv("QZ_CA_FILE")` 读文件装入信任库，
读不到即 `exit 2` 不静默继续。

**分工**：THREAD 模型 → 直接调 `qz_add_ca_pem()`；ISOLATED → `QZ_CA_FILE`
（`qzjs --ca` 是它的前端）。

## worker 继承（两后端一致性）

worker 是**独立 `qz_t`**（`worker.c` 里 `calloc` 出来），不共享父 runtime 状态 ——
父进程 `qz_add_ca_pem()` 装入的信任根**不会自动到达** worker。

| 后端 | worker 如何拿到 CA |
|---|---|
| PROCESS | 独立进程 → `rt_main.c` 读 `QZ_CA_FILE` → **拿到** |
| THREAD | 进程内独立 `qz_t` → 不继承就是空 → 曾**拿不到** |

THREAD 曾是静默降级：worker 里 fetch 私有 CA 站点报 `X509 verification failed`，
症状指向证书、真因是信任库没传过去。现已在 `worker.c` 建 `self` 后 `strdup`
逐字节继承。

**用 `strdup` 而不是 `qz_add_ca_pem`**：后者是**追加**语义（补 `'\n'` 分隔符），
用来"继承"会让 worker 缓冲比父多一个换行——继承不该改变缓冲形状。

分配失败**不中止** worker 创建但出声诊断：中止太重，但静默继续会让 fetch
以「证书问题」的面貌失败。

## 四条裁决（各自都有否决过的替代方案）

### 1. 追加，不替换系统信任
`mbedtls_x509_crt_parse` 追加到已有链，故自建 CA 与公有 CA 同时有效。
**否决**：替换语义——会让宿主一调就把公有 CA 全灭，而自建 CA 的部署场景恰恰
常需连公有 API。

### 2. 恒 `VERIFY_REQUIRED`，**不提供**跳过校验的开关
**刻意为之**：加「跳过验证」开关能省掉自签证书的麻烦，但极简哲学第 4 条说得很死
——多暴露一个能力就扩大可被触达的攻击表面积。将来真需要（如私有调试环境），
正确做法是**独立构建档**（如 `QZ_PROFILE=bare` 那套），不是往运行时 API 开后门。

### 3. 只存 PEM 字节，不存 `mbedtls_x509_crt`
**否决**：让 runtime 持共享证书链。那份结构随 op 生命周期创建/释放
（`tls_init_op` 建 / `tls_free_op` 释放），跨 op 共享必然悬垂。各 op 各自解析进
自己的 `op->ca_certs` 是唯一无共享的做法。

### 4. 无锁，约束为「JS 开始执行前调用」
**否决**：给信任库加锁——非热路径（启动期调一次），新增锁要多一个字段 + 一套加解锁
+ 一份并发契约，约束写进公共头即可。**代价**：运行中调用会与 in-flight 握手并发
改到别人正在读的信封，不做保护。

## 两个易踩的实现坑

- **长度约定**：`mbedtls_x509_crt_parse` 要 **NUL 终止**缓冲，故传 `ca_pem_len + 1`
  （`ca_pem_len` 不含 NUL）。同 `tcp_io.c` 的 PEM 路径。gtest 的负控就是去掉这个
  `+1`——去掉后测试立即变红。
- **定义位置**：`qz_add_ca_pem` **不可**放进 `#if QZ_WITH_TLS`。公共头无条件声明它，
  而 `test/api_surface_check.py` 要求 isolated/thread 两个模型的静态库都真有该符号。
  只在 TLS 分支定义 → `QZ_WITH_TLS=OFF` 的构建编译通过、链接才炸。

## 测试

- `test/test_tls_ca_gtest.cpp`（mock_libuv）：调**生产函数**
  `uv_io_tls_load_host_ca()`，不复现 parse——复现版只会测到测试自己写对的约定。
  锁的是缓冲契约 + 解析路径。
- `test/test_tls_ca_e2e.py`（真实 libuv + 真实 mbedTLS，CI e2e job）：唯一能覆盖
  「握手成功后换读回调」（#1 核心修复）的手段——该路径要求真实握手成功，而 mock
  gtest 没有真实套接字。三关：无 `--ca` 须因**证书原因**拒绝；无关 CA 仍拒绝；
  正确 `--ca` 握手成功且响应体逐字节匹配。

## e2e 踩过的环境坑（写下来免得重踩）

1. **必须 `QZ_BUILD_TESTS=OFF` 构建**。测试构建的 `qz_cli` 链接 **mock_libuv**，
   没有真实网络（CMakeLists 里 `qz_cli` 处有明文注释）。CI 的 e2e job 正是这个配置。
   用错构建 → 所有 fetch 都超时，且**很容易被误读成 TLS/信任问题**。
2. **拒绝断言必须要求「证书原因」**。超时/连接失败同样让 promise reject，只查
   「没拿到响应体」会把「TLS 根本没开始」的环境性失败判成通过。断言里要匹配
   cert/tls/x509/handshake 等字样。
3. **仓库夹具 `test/fixtures/test.crt` 已于 2026-08-18 过期**。拿它跑会在**过期**
   而非**信任**上失败——测的就不是本功能了。故 e2e 内现生成两级 PKI
   （CA 带 `basicConstraints=CA:TRUE` + 由它签发的叶子）。
4. **服务器必须双栈监听 `[::]`**。`localhost` 在多数系统先解析到 `::1`，而 qzjs
   **不回退 IPv4**；只听 `127.0.0.1` 会得到「连接失败」，同样易被误读。
5. **ISOLATED 还要 `qzjs-rt` 二进制就位**，否则 `qz_create` 直接返回 NULL、
   报 "runtime init failed"（构建时 `--target qz_cli` 不含 `qz_rt`）。


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

- time: 2026-10-06T04:16:28
  kind: decision
  summary: "补记 ISOLATED 跨进程陷阱与 QZ_CA_FILE 通道 + e2e 覆盖的环境陷阱"
  source: "2026-10 真实握手 e2e 落地时发现"
  affects: [tls-ca-trust-store]
