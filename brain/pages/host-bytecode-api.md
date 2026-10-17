---
id: host-bytecode-api
title: "宿主字节码 API：策略反转与 JS_DetectModule 陷阱"
category: decision
status: active
tags: [bytecode, host-api, compatibility]
created: "2026-09-25T14:38:43"
updated: "2026-10-13T08:07:02"
---

<!-- compiled_truth -->
## 结论

**宿主字节码 API 策略反转**：从「无公开字节码 API」→ 新增 `qz_compile` + `initial_bytecode` + CLI（`--compile`/`--bytecode`）。

## 三条能力

1. **`qz_compile(source, len, filename, &out, &out_len, &err)`**（`include/qzjs/qzjs.h:98`）——独立函数，**无需 `qz_t`**（内部一次性 JSRuntime/JSContext）。**恒按全局脚本编译**（与 `qz_eval_internal` 的 `JS_EVAL_TYPE_GLOBAL` 对齐）。

   **为何不自动探测 module**：`JS_DetectModule` 会把**含 `import` 的普通脚本误判为 module**；module 求值返回 promise，顶层 throw 不触发 `ready_err` → 错误静默丢失。故不探测。

   `JS_WriteObject` 缓冲拷入宿主 `malloc` 块（`qz_free` 可安全释放）。

2. **`qz_config_t.initial_bytecode` / `initial_bytecode_len`**（`:44-45`）——与 `initial_script` **独立叠加**：先脚本（宿主 bootstrap）后字节码（预编译主程序）。`qz_create` 拷入 qzjs 自有缓冲（create 失败路径×2、`qz_destroy`、`qz_free`、`qz_host_destroy` 全部补释放）。

3. **ISOLATED 传输**：`host_write_script` 泛化为**二进制安全** `host_write_blob`——字节码写独立临时文件经 `--bytecode PATH` 传给 `qzjs-rt`；`rt_main` 二进制读回、在脚本之后 `qz_eval_bytecode_internal`，成功/失败路径均释放。

## CLI / 工具

- `qzjs --compile in.js [-o out.bc]`（缺省 `<in.js>.bc`）
- `qzjs --bytecode file.bc [args...]`（走 bootstrap，脚本参数照常）
- **`qzc`**（`src/qzvm/qzc.c`，`qzc <in.js> [-o out.bc]`，`qz_compile` 的 CLI 形态；链接真 libuv，mock 测试构建不产出）——`qzjs --compile` 保留为别名。

## 兼容性（核心约束，已告知用户）

字节码与 qzjs **具体构建强绑定**（引擎版本 + BC_VERSION + 校验和 + 编译选项），**跨构建不保证可加载**。运行时**显式拒绝**（`SyntaxError: invalid version` / `checksum error`），**绝不静默回退源码**。故文档（bytecode/faq/troubleshooting/host-integration/c-api/cli，en+zh）全部改为「**分发源码、部署环境按目标构建重编译**」。

## 场景加固（测试中发现）

**空字节码文件曾触发 double-free**：`qz_create` 仅在 `initial_bytecode && initial_bytecode_len` 时拷贝，`len==0` 时 `rt->config.initial_bytecode` 悬在宿主缓冲上 → `qz_destroy` 二次释放（valgrind 定位：Invalid free in `qz_free` via `run_bytecode`）。**修复**：指针一旦设置即归 rt 所有（`malloc(n?:1)` **恒拷贝**，`len==0` 不例外）；CLI 侧空文件前置报错 `'x' is empty (not bytecode)`。

## 实测

两编译模型端到端 编译→运行→参数透传 ✅；throwing 字节码 → `qz_create` 返回 NULL、CLI 非零退出 ✅；篡改字节码显式拒绝 ✅；`qjsc -b` 同引擎产物可加载 ✅。

来源：`CHANGELOG.md:49-50`。


## Timeline

- time: 2026-09-25T14:38:43
  kind: decision
  summary: "Created this page: 宿主字节码 API：策略反转与 JS_DetectModule 陷阱"
  source: created via brain create-page
  affects: [host-bytecode-api]

- time: 2026-09-25T15:02:07
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [host-bytecode-api]

- time: 2026-09-25T15:02:14
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [host-bytecode-api]

- time: 2026-09-26T02:13:55
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [host-bytecode-api]

- time: 2026-09-26T14:58:51
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [host-bytecode-api]

- time: 2026-10-13T08:07:02
  kind: decision
  summary: "恢复题文一致的正文（原被 DAP CI 内容覆盖）：宿主字节码 API 三能力（qz_compile 恒 GLOBAL + JS_DetectModule 陷阱 / initial_bytecode 叠加 / ISOLATED 二进制安全传输）+ CLI(qzc) + 跨构建不兼容约束 + 空字节码 double-free 修复。DAP CI 内容迁往 dap-feature-completion。"
  source: "CHANGELOG.md:49-50 + include/qzjs/qzjs.h:38-45/98"
  affects: [host-bytecode-api]
