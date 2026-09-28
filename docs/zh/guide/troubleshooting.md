---
title: 常见问题排查
description: 诊断 qzjs 常见故障 — 构建错误、创建失败、Worker 派生问题、serve() 与 WebSocket 报错，以及 CLI 问题。
---

# 常见问题排查

按失败出现的阶段分组：现象 → 原因 → 修复。错误字符串逐字引用，便于与你的
输出对照。

## 构建与配置

### `QZ_WITH_WAMR=ON and QZ_WITH_WASM3=ON are mutually exclusive`

两个 WASM 引擎注册同一个 `WebAssembly` 全局，只能开一个。

```bash
# 只选一个（WAMR 为默认，Fast Interp + AOT）
cmake -B build -DQZ_WITH_WAMR=ON -DQZ_WITH_WASM3=OFF
```

### `QZ_WITH_TLS=ON but mbedTLS source not found` / `QZ_WITH_CRYPTO_EXT=ON but mbedTLS source not found`

依赖子模块未检出。

```bash
git submodule update --init --recursive
```

### `QZ_POLYFILL_MODE=compressed requires vendored lz4`

同上：缺少 lz4 子模块。

```bash
git submodule update --init deps/lz4
```

### `QZ_PROFILE` / `QZ_PROCESS_MODEL` / `QZ_POLYFILL_MODE` 值非法

这三项在 configure 阶段校验，接受集合之外的值直接报错。取值见
[构建选项](/zh/guide/build-options)：

- `QZ_PROFILE` — `minimal`、`standard` 或空
- `QZ_PROCESS_MODEL` — `ISOLATED` 或 `THREAD`
- `QZ_POLYFILL_MODE` — `rodata`、`compressed`、`external`、`host`

切换 `QZ_PROFILE` 会重算 `QZ_WITH_*` 缓存默认值，并打印
`QZ_PROFILE changed:` 状态行。

### profile 关掉了你需要的 API

profile 会翻转 `QZ_WITH_*` 功能开关。`minimal` 保留 WebAssembly、
`crypto.subtle`、`atob`/`btoa` 和压缩；`standard` 补齐其余。若某个 profile 的
默认不符合你的需要，显式设置对应的 `QZ_WITH_*` 选项。见
[构建](/zh/guide/building#cmake-选项)。

## 运行时创建

### `qz_create` 返回 `NULL`

`qz_create` 会阻塞到运行时就绪且 `initial_script` 执行完毕（ISOLATED 下握手走同步
raw-fd 读，握手期间不泵宿主 loop；THREAD 下等内部线程就绪）；任一环节失败即
返回 `NULL`。原因：

1. **`initial_script` 抛异常。** 初始脚本中的任何异常都会中止创建——运行时
   不会降级启动。
2. **线程或 loop 初始化失败**（资源耗尽）。
3. **ISOLATED 下 `cfg.uv_loop` 为 `NULL`。** 宿主 loop 注入是必填项，缺失则显式失败——库绝不回退到内部宿主线程。主RT 进程（`qzjs-rt`）spawn 失败同样返回 `NULL`。

CLI 在同一条件下打印 `qzjs: runtime init failed`。

```c
qz_t *rt = qz_create(&cfg);
if (!rt) {
    /* initial_script 抛异常，或线程/loop 初始化失败；
       ISOLATED 下 cfg.uv_loop 为 NULL 也会显式失败 */
    return 1;
}
```

定位方法：把 `initial_script` 置空重跑；若创建成功，则是脚本抛错。

### `initial_script_path` 被忽略

同时设置 `initial_script` 与 `initial_script_path` 时，**以路径为准**。只设
其中一个。路径不可读同样会让 `qz_create` 返回 `NULL`。

### 异步回调还没触发，运行时已退出

这是设计行为。顶层脚本结束后，运行时继续运行，直到所有待处理异步工作
（定时器、fetch、流）完成才退出。若需要工作在脚本结束后继续存活，由宿主保持
运行时存活——不要指望脚本结束是屏障。待处理的 50ms `setTimeout` 会在退出前
触发。

### `message_cb` 从不被调用

`message_cb` 是**出站**（JS → 宿主）通道，必须在 `qz_create` 之前于
`qz_config_t` 中设置。`message_cb` 为 null 时宿主收不到任何消息。出站发送只在
脚本确实调用 `postMessage(...)` 时发生。**ISOLATED 下还有一个常见原因：宿主没有泵
`cfg.uv_loop`**——读泵挂在你的 loop 上，不泵就不会有回调到达（阻塞宿主 API 会在内部
就地泵，但常规收消息依赖你自己的泵循环）。见
[事件循环](/zh/guide/event-loop) 与
[主机集成](/zh/guide/host-integration)。

## Worker 与进程模型

### `spawnWorker failed` / `spawn failed` / `binary not found`

默认 `ISOLATED` 进程模型下，`new Worker(...)` 派生一个子进程运行伴随二进制
`qzjs-rt`。找不到该二进制则派生失败。

解析链依次尝试：

1. 显式二进制路径，
2. `QZ_RT_SERVER` 环境变量，
3. `/proc/self/exe` 所在目录下的 `qzjs-rt`，
4. 编译期 `QZ_RT_PATH`。

修复：构建伴随二进制（`QZ_BUILD_CLI=ON`，默认开启，一并构建 `qzjs`、
`qzjs-rt`、`qzjs-ctl`），或用 `QZ_RT_SERVER` 指向它。

```bash
export QZ_RT_SERVER=/path/to/build/qzjs-rt
```

### `worker boot failed` / `worker script error`

worker 的启动垫片或其脚本在求值时抛错。消息即 worker 侧错误；检查传给
`new Worker(url)` 的脚本。

### `Worker: only file:// URLs are supported in v1`

`new Worker()` 仅接受 `file://` URL。

### Worker 之间无法共享内存

主运行时是单线程的；worker——无论是线程（THREAD 模型）还是子进程（ISOLATED
模型）——交换的是**结构化克隆消息**，不是共享内存。用 `postMessage` /
`MessageChannel`。

### 选择 worker 后端

`qz_config_t.worker_backend` 选择后端，但枚举值是**条件编译**的：

- `ISOLATED` 构建：`0` = `PROCESS`（默认）、`1` = `THREAD`
- `THREAD` 构建：`0` = `THREAD`、`1` = `PROCESS`（未启用——求值报错）

只用符号常量（`QZ_WORKER_BACKEND_PROCESS` / `QZ_WORKER_BACKEND_THREAD`），
勿硬编码字面量。零初始化的配置落到你所编译模型的默认后端。

## serve() / HTTP / WebSocket

### `serve: a server is already running (call srv.close() first)`

同一时刻只允许一个服务器。先关闭上一个。

```js
let srv = serve({ port: 8080 }, handler);
srv.close();
srv = serve({ port: 8081 }, handler);
```

### `WebSocket accept unavailable: rebuild with QZ_WITH_CRYPTO_EXT=ON and QZ_WITH_TEXTCODEC=ON`

WebSocket 升级路径需要 crypto 与 textcodec 扩展。你的构建关掉了其中之一或
两者。

```bash
cmake -B build -DQZ_WITH_CRYPTO_EXT=ON -DQZ_WITH_TEXTCODEC=ON
```

注意 `QZ_WITH_TLS=ON` 会自动强制 `QZ_WITH_CRYPTO_EXT=ON`。

### 不支持 `wss://`

WebSocket 客户端支持 `ws://`；`wss://` 抛 `wss:// not supported yet`。请在前置
代理处终结 TLS。

### 端口已被占用

端口被占用时 `serve({ port: N })` 绑定失败。用 `port: 0` 让操作系统分配。

### 绑定到回环之外

`serve()` 默认绑定 `127.0.0.1`，且**没有认证中间件**。传
`hostname: '0.0.0.0'` 会把服务器暴露到网络——请在前方放置你自己的认证。见
[安全模型](/zh/guide/security)。

## CLI

### `qzjs` 打印用法并以退出码 `2` 结束

未知 flag，或 `-e` 用法错误。退出码：

| 退出码 | 含义 |
|------|------|
| `0` | 成功 |
| `1` | 脚本抛错（消息打到 stderr），或文件不可读 |
| `2` | 未知 flag / `-e` 用法错误 |

### `qzjs: cannot open '<file>'` / `qzjs: cannot size '<file>'` / `qzjs: read error`

脚本路径不存在、不可读，或读取过程中发生变化。确认路径与权限。

### 脚本里没有 `process`、`require`、`Buffer`

这是设计行为——CLI 不暴露任何 Node 风格的全局。脚本改用 WinterTC Web API
面。见 [独立 CLI](/zh/guide/cli#无-node-js-api)。

### `qzjs-ctl` 命令失败

核对五件事：

1. 运行时以 `--control-plane=local` 启动。
2. `--pipe` 与运行时的 `--control-pipe` 一致（默认
   `/tmp/qzjs-<pid>-<n>.ctl`）。
3. 对端 uid 一致——端点权限 `0600`，经 `SO_PEERCRED` 校验。
4. `--target N` 指向真实槽位（`1` = 主运行时；`>1` = 该节点的子 worker
   槽位）。
5. `control_plane = OFF`（默认）时，`qz_control` 恒返回 `-1`。

## 字节码

### 「怎么把预编译字节码喂给 qzjs？」

`qz_compile()` 把 JS 源码编译为字节码；经 `qz_config_t.initial_bytecode`
或 `qzjs --bytecode file.bc` 运行（`qzc` 产出文件）。字节码与
qzjs 的具体构建绑定——不兼容的字节码会让 `qz_create` 显式失败（stderr 打
`SyntaxError: invalid version`），绝不静默回退到源码。请在部署环境按目标
构建编译。见[字节码编译](/zh/guide/bytecode)。

## 仍未解决

- [FAQ](/zh/guide/faq) — 看起来像 bug、实为设计的问题
- [安全模型](/zh/guide/security) — 哪些被防护、哪些不防护
- [调试](/zh/dev/debugging) — 内置 DAP 调试器
- [GitHub Issues](https://github.com/adam-ikari/qzjs/issues) — 提交报告
