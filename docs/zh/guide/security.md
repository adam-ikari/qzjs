---
title: 安全模型
description: qzjs 威胁模型 — 运行时防护什么、脚本被信任做什么，以及如何上报漏洞。
---

# 安全模型

qzjs 是**面向可信脚本的可嵌入运行时**，不是运行不可信代码的沙箱。本页明确
陈述边界，便于你推理部署方式并正确上报问题。

## 上报漏洞

安全漏洞**不要**开公开 GitHub issue。

请通过 [GitHub Security Advisories](https://github.com/adam-ikari/qzjs/security/advisories/new)
私下上报。请包含：

- 受影响版本（commit hash 或 release tag），
- 问题描述与影响，
- 复现步骤或 PoC，
- 已知缓解措施。

你应在 **7 天**内收到确认，**30 天**内收到状态更新。修复就绪后，我们会与你
协调披露，并在 advisory 中致谢（除非你希望匿名）。

## 支持的版本

安全修复应用于**最新 release** 与当前 `master` 分支。旧版本不做回溯移植。

## 威胁模型

### 在范围内

让*数据*跨越运行时自身划定的边界、或让意外输入破坏内存/崩溃进程的缺陷：

- 字节码读取器（`JS_ReadObject`）处理畸形或恶意字节码，
- IPC 信封解码器，以及 HTTP/WS/HTTP2/protobuf 解析器处理来自对端进程或
  网络的畸形输入，
- 经由公开 API 从脚本可达的内存安全缺陷，
- 密码学正确性（`crypto.subtle`、TLS 配置、随机数）。

若你能让*不可信输入*——网络字节、字节码、来自不可信对端的 IPC 帧——导致
内存破坏、逃出解析器边界或绕过显式校验，那就在范围内。

### 按设计不在范围内（除非宿主开启严格模式——见下文）

脚本本就合法拥有的能力。这些不是逃逸：

- **文件系统** — 脚本可读写宿主进程能访问的任意路径。路径校验只拒绝 `..`
  组件；**没有根隔离，也没有权限模型**。见 [fs](/zh/js-api/fs)。
- **派生进程** — 脚本可派生进程（`pal.processSpawn` → `execv`）。
- **环境（仅 CLI）** — 独立 `qzjs` CLI 经 bootstrap 把完整环境注入为 `globalThis.env`。嵌入式宿主（`qz_create`）在默认配置下没有 env 接口——脚本看不到任何环境变量；除非宿主设置 `strict_mode` + `env_allowlist`。
- **与宿主共处** — 脚本与宿主同进程（THREAD 后端）或处于兄弟进程
  （ISOLATED 后端）；**两者都不是针对恶意脚本的安全边界**。
- **网络暴露** — `serve()` 默认绑定 `127.0.0.1`，且**没有认证中间件**。
  传 `hostname: '0.0.0.0'` 会把它暴露到网络——若这么做，请在前方放置你自己的
  认证。

## 严格模式——运行不可信脚本

加载**不可信或第三方**脚本（用户插件、远端下发代码）的工作负载，qzjs 提供宿主侧的**严格模式**开关，收紧默认配置放开的三个能力。它是**引擎层机制**，不是完整沙箱——高风险代码需配合 OS 层隔离（seccomp、容器、chroot）。

| 能力 | 默认（可信脚本） | 严格模式 |
|---|---|---|
| 文件系统 | 宿主可访问的任意路径（仅拒 `..`） | 限根到 `sandbox_root`，`realpath` 前缀校验；符号链接逃逸被拒；相对路径被拒 |
| 派生进程 | `pal.processSpawn` → `execv` JS 指定的任意二进制 | 忽略 JS 传入的 `binary_path`，强制解析自身的 `qzjs-rt`（`/proc/self/exe` 同目录、`QZ_RT_SERVER`、编译期 `QZ_RT_PATH`）；嵌套 worker 照常 |
| 环境 | 全量 `globalThis.env`（CLI）/ 无（嵌入式默认） | 只暴露 `env_allowlist` 列出的 key；空表 → `env = {}` |

在 `qz_create` 时一次性开启（运行期不可降级——JS 无法自关）：

```c
qz_config_t cfg; qz_config_init(&cfg);
cfg.strict_mode   = 1;
cfg.sandbox_root  = "/srv/sandbox";
cfg.env_allowlist = (const char *const[]){"PATH","HOME",NULL};
qz_t *rt = qz_create(&cfg);
```

CLI：`qzjs --strict-sandbox=/srv/sandbox script.js`（白名单默认 `PATH,HOME,LANG`，用 `QZ_STRICT_ENV=KEY1,KEY2` 覆盖）。

**严格模式不覆盖**（仍需 OS 层隔离）：出站网络（tcp/http）、DAP 调试器面、CTL 控制面端点（后者用其自有的 `LOCAL` + `SO_PEERCRED` 档位）。

## 部署指引

由于运行时信任其脚本，qzjs 部署的安全性即你**宿主应用边界**的安全性：

1. **把脚本当作第一方代码。** 若其中任何部分来自不可信来源，在没有你自己的
   隔离（独立 OS 用户、容器、虚拟机或 seccomp 策略）时，不要放进 qzjs 运行时
   执行。
2. **不要把 `serve()` 直接暴露到公网。** 它是个裸服务器。绑定回环，前置一个
   终结 TLS 并强制认证的反向代理。
3. **约束进程可达范围。** 文件系统、环境与派生能力的范围等同于宿主进程自身
   的权限。若工作负载不需要，就在 OS 层降权。
4. **隔离在运维上重要时优先 `ISOLATED`。** 崩溃或卡死的 worker 不会拖垮主
   运行时，进程边界对资源限制也更干净。但它仍不是针对恶意脚本的安全边界。
5. **校验 TLS 对端。** 运行时对出站 TLS 执行 SNI 与证书主机名校验；校验失败
   对该连接是致命的，而非静默忽略。
6. **审计代理配置。** `fetch` 遵循环境中的 `HTTP_PROXY` / `HTTPS_PROXY` /
   `NO_PROXY`。不支持的代理 scheme 会 fail closed，而非静默绕过代理——但任何
   能设置这些变量的进程都能改写出站流量。

## 上游依赖

qzjs 将依赖作为固定的 git 子模块置于 `deps/` 下，外加本地补丁
（`deps/*.patch`）。

上游 quickjs-ng 明确将**字节码读取器加固列为项目外**，因此针对内置读取器的
畸形字节码问题应报给我们，而非上游。

捆绑依赖中的问题请先报给我们，以便评估对本运行时的影响；我们会酌情一并
转交上游。

## 另见

- [常见问题排查](/zh/guide/troubleshooting) — 现象 → 原因 → 修复
- [常见问题](/zh/guide/faq) — 看起来像 bug 的设计问题
- [fs](/zh/js-api/fs) — 无沙箱的文件系统模型
- [serve()](/zh/js-api/serve) — 无认证的 HTTP 服务器
