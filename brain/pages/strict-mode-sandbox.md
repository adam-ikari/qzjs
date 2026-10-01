---
id: strict-mode-sandbox
title: "严格模式（strict mode）——安全运行第三方代码"
category: decision
status: active
tags: [security, sandbox, P2]
created: "2026-10-01T06:59:16"
updated: "2026-10-01T07:54:46"
---

<!-- compiled_truth -->
## 定位裁决

qzjs 是**引擎，不是沙箱**（qwrt-positioning：机制非政策）。严格模式是**引擎层 mechanism**——一个预设的安全边界开关，启用后可安全跑第三方/不可信 JS 代码。宿主选择是否启用（policy 在宿主），引擎不判断"该用哪档"。

这与评审 P2「权限模型（capability 档位）立项」的第一性推导结论：完整 capability 档位体系（应用权限模型）会违背定位（policy 硬编码进引擎）。真实需求是单一"严格模式"开关——堵住跑第三方代码时的宿主沦陷风险，而非应用层权限。

## 三个代码实证缺口

现状（bridge.c / ipc_process.c / cli.c）：

1. **fs 绝对路径放行**：`bridge_validate_path` 只拒 `..` 逃逸，`/etc/passwd`、`~/.ssh/id_rsa` 完全可读——无根目录/白名单概念。
2. **processSpawn 任意 execv**：`resolve_binary`（ipc_process.c:197）对 JS 传入的 `binary_path` 直接 strdup 放行 → `execv(path, argv)` 执行任意二进制。
3. **env 全量注入**：cli.c bootstrap `globalThis.env = %s` 填 `ENV_JSON`，全量 environ 暴露给 JS（含密钥/凭据）。

三者叠加 = 跑半可信 JS 等价宿主沦陷（评审 09-23 §安全）。

## 严格模式行为（启用后）

| 缺口 | strict 行为 |
|---|---|
|fs|限根：`sandbox_root` 配置，所有 fs 路径 realpath 解析后必须在前缀内；拒符号链接逃逸；相对路径相对 root 解析|
|processSpawn|仅允许 qzjs-rt：strict 下忽略 JS 传的任意 binary_path，强制走 `resolve_binary(NULL)`（/proc/self/exe 或 QZ_RT_SERVER）解析 qzjs-rt；保留嵌套 worker 能力，堵任意 execv|
|env|白名单：只注入 `env_allowlist` 列出的 env 变量，非全量 environ|
|localStorage|限到 sandbox_root 内：`QZ_LOCALSTORAGE_FILE` 若配置须在 root 下，否则拒|

不开 strict = 现状全开（兼容 trusted 场景）。

## 配置接口（qz_config_t 扩展）

```c
typedef struct qz_config_s {
    /* ... 现有字段 ... */
    int strict_mode;              /* 0 = off（默认，现状全开）| 1 = on */
    const char *sandbox_root;     /* strict 下 fs 限根绝对路径；NULL+strict → 拒所有 fs */
    const char *const *env_allowlist; /* strict 下 env 注入白名单（NULL 结尾）；NULL+strict → 不注入任何 env */
} qz_config_t;
```

- 一次性配置于 `qz_create`，**运行期不可降级**（防 JS 自关闭）。
- `rt->config` 持有副本（sandbox_root strdup，allowlist 拷贝）。

## 范围（首轮）

- **纳入**：fs 限根、processSpawn 仅 qzjs-rt、env 白名单、localStorage 限根。
- **不纳入**（YAGNI，后续扩展）：网络出站（tcp/http）限制——先防宿主沦陷，数据外泄另立项。
- CTL 控制面：已有三档安全模型（OFF/IN_PROC/LOCAL + SO_PEERCRED），不重叠。

## Timeline

- time: 2026-10-01T06:59:16
  kind: decision
  summary: "Created this page: 严格模式（strict mode）——安全运行第三方代码"
  source: created via brain create-page
  affects: [strict-mode-sandbox]

- time: 2026-10-01T07:33:40
  kind: decision
  summary: "严格模式实施完成。两个实施决策（偏离原 spec）：1) strict 下拒绝相对路径，只接受 sandbox_root 内绝对路径——下游 uv_io_* 按进程 CWD 解析相对路径，若校验层脑补 root-relative 放行会导致「校验过、读不到」的语义不一致；绝对路径契约显式无歧义。2) ISOLATED 模型下 strict 配置经环境变量 QZ_STRICT_SANDBOX/QZ_STRICT_ENV 从父进程传给 qzjs-rt 子进程（子进程 exec 自己重建 rt，不继承父 cfg；exec 保留 environ，无需改 argv 协议）。验证：strict 下 root 内绝对路径读写 OK / 越界绝对 DENY / 相对 DENY / env 白名单 3 变量（对照非 strict 全量 92）；ctest 28/28 全绿。processSpawn strict（exe=NULL→默认 qzjs-rt 解析）已编译+审查，JS 层不暴露 Worker 无法触发冒烟"
  affects: [strict-mode-sandbox]

- time: 2026-10-01T07:54:46
  kind: decision
  summary: "CI 实证踩坑并修复：strict 限根用的 realpath()/dirname() 属 XSI 非纯 POSIX，CMakeLists 给 target 加 _POSIX_C_SOURCE=200809L 时 stdlib.h/libgen.h 不声明它们，-Werror=implicit-function-declaration 下首次 CI 20 个 job 红。本地 build 目录无该宏故隐式通过（本地测不出）。修：bridge.c 头部 #define _XOPEN_SOURCE 700（XSI+POSIX.1-2008 超集），须在任何头文件之前。教训：特性测试宏相关的编译问题只在带该宏的构建（test 目标/CI）暴露，本地默认构建测不出来——改用 C99+POSIX 特性时必须验 CI 配置。修复后 CI 29/29 全绿（含 asan/ubsan/feature-matrix/wamr/wasm3/polyfill-* 等全部配置）"
  affects: [strict-mode-sandbox]
