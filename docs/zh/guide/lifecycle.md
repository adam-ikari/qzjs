---
title: 运行时生命周期
description: qzjs 运行时生命周期 — 创建、配置、使用和销毁。了解 qz_create、qz_destroy 以及消息循环。
---

# 运行时生命周期

每个 qzjs 程序都遵循相同的生命周期：**创建 → 使用 → 销毁**。

## 创建运行时

```c
qz_config_t config = {
    .initial_script = "postMessage('ready');",  // 在创建时于运行时线程上求值
    .message_cb = on_message,                   // 出站消息
    .uv_loop = &loop,                           // 宿主 loop 注入（ISOLATED 必填）
    .debug = 0,                                 // 启用调试输出（0 或 1）
};
qz_t *rt = qz_create(&config);
if (!rt) {
    // 创建失败 — initial_script 抛出异常，或线程/循环初始化失败（ISOLATED 下还包括 cfg.uv_loop 为 NULL）
}
```

`qz_create` 执行以下操作：
1. ISOLATED（默认）：spawn 主RT 进程（`qzjs-rt`，内含库自有的 loop 与 JS 执行）；THREAD：启动 qzjs 的内部线程并初始化嵌入式 libuv 循环
2. 创建 JSRuntime 和初始上下文
3. 注册构建时扩展集（`QZ_EXTENSIONS` 表 —
   内置扩展如 compress/crypto/textcodec/wamr，当其 `QZ_WITH_*` 选项开启时生效，
   以及通过 `QZ_EXTRA_SOURCES` 添加的任何用户扩展）
4. 将 WinterTC 兼容的运行时注入到初始上下文中
5. 在内部线程上求值 `initial_script` — 抛出异常会使 `qz_create` 返回 `NULL`

`qz_create` 会阻塞，直到运行时就绪且 `initial_script` 已求值。ISOLATED 下 ready 握手走
同步 raw-fd 读——create 期间不泵宿主 loop、不触发回调；ready 前的脚本消息会被缓冲，
读泵注册后按 FIFO 重放。传 `cfg.uv_loop = NULL` 会让 `qz_create` 显式失败，库绝不回退到
内部宿主线程。运行时拥有其全部 JS 侧资源。

## 销毁运行时

```c
qz_destroy(rt);  // 优雅关闭，仅宿主线程，NULL 安全
```

`qz_destroy` 会：
1. THREAD：请求内部线程退出并 join 它；ISOLATED：终止主RT 进程并结束宿主侧通道（它是阻塞宿主 API，在内部就地泵 `cfg.uv_loop`——`message_cb` 可能在调用内重入触发）
2. 销毁所有上下文（调用扩展的 `destroy` 钩子）
3. 释放 JSRuntime 和 libuv 循环（ISOLATED 下在主RT 进程内；宿主 loop 上挂的库句柄全部关闭，库从不对宿主 loop 调 `uv_run(UV_RUN_DEFAULT)` 或 `uv_loop_close`）
4. 释放运行时

`qz_destroy(NULL)` 是安全的（无操作）。

## 线程安全

- **所有 JS 在 qzjs 的内部线程上运行**（ISOLATED 下指主RT 进程内库自有的线程/loop）— 宿主线程从不调用 JS
- **`qz_post_message` 是线程安全的** — 两模型下均可从任何线程调用；JSON 会被拷贝。ISOLATED 下投递延迟等于你的泵频
- **`message_cb` 的触发线程看模型** — ISOLATED：在泵 `cfg.uv_loop` 的宿主线程上触发；THREAD：在 qzjs 线程上触发（回调须线程安全）
- **ISOLATED 下阻塞宿主 API**（`qz_ping`、`qz_ping_path`、`qz_wait_idle`、`qz_destroy`）在内部就地泵宿主 loop（`UV_RUN_NOWAIT` + yield）——`message_cb` 可能在调用内重入触发，因此不要在 `message_cb` 内调用它们
- **`qz_destroy` 仅限宿主线程** — 从调用 `qz_create` 的线程调用

## 内存模型

- 所有每运行时状态存储在 `qz_t` 上 — **零可变文件作用域状态**
- 类 ID 是运行时作用域的（在一个 `qz_t` 内的各上下文之间共享）
- 通过 `qz_get_rt_from_ctx(ctx)`（内部 API）从 `JSContext*` 恢复 `qz_t*`
