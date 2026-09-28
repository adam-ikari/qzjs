---
title: 运行时生命周期
description: qzjs 运行时生命周期 — 创建、配置、使用和销毁。了解 qz_create、邮箱、qz_wait_idle、qz_destroy 与 qz_free。
---

# 运行时生命周期

每个 qzjs 程序都遵循相同的生命周期：**创建 → 使用 → 销毁**。

## 创建运行时

```c
qz_config_t config = {
    .initial_script = "postMessage('ready');",  // 在创建时于运行时线程上求值
    .debug = 0,                                 // 启用调试输出（0 或 1）
};
qz_t *rt = qz_create(&config);
if (!rt) {
    // 创建失败 — initial_script 抛出异常，或进程/线程初始化失败
}
```

`qz_create` 执行以下操作：
1. ISOLATED（默认）：spawn 主RT 进程（`qzjs-rt`），随后**库启动自己的宿主侧泵线程与 loop**（绝不用宿主的），并阻塞等待主RT 的 `CONTROL{ready}`。THREAD：一切在库的内部 qzjs 线程上运行。失败返回 `NULL`
2. 创建 JSRuntime 和初始上下文
3. 注册构建时扩展集（`QZ_EXTENSIONS` 表 —
   内置扩展如 compress/crypto/textcodec/wamr，当其 `QZ_WITH_*` 选项开启时生效，
   以及通过 `QZ_EXTRA_SOURCES` 添加的任何用户扩展）
4. 将 WinterTC 兼容的运行时注入到初始上下文中
5. 求值 `initial_script` — ISOLATED 下在主RT 进程内，THREAD 下在库的内部线程上；抛出异常会使 `qz_create` 返回 `NULL`

`qz_create` 会阻塞，直到运行时就绪且 `initial_script` 已求值。ready 握手之前到达的帧已被重放进每运行时的**邮箱**，宿主第一次 `qz_recv_message` 即可取到。宿主可以把 qzjs 嵌入任何事件系统（poll/epoll/select、自己的线程）：库自主管理线程与 loop，从不执行宿主代码 — 宿主没有任何 loop 要运行或泵动，也没有任何回调打进宿主代码。

## 收发消息：post 与 recv

请求经 `qz_post_message` 送入；一切输出的内容 — JS 的 `postMessage`、崩溃上报 `{"type":"error"}`、CONTROL 回执 — 都排入邮箱，由你自选的宿主线程排干：

```c
qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);

char *json = NULL; size_t len = 0;
int r = qz_recv_message(rt, &json, &len, 5000);  // 0=纯轮询，>0=至多等 N 毫秒，-1=无限阻塞
if (r == 0) {
    printf("%.*s\n", (int)len, json);            // NUL 结尾的 UTF-8 JSON
    qz_free_message(json);                       // 缓冲必须由你释放
}                                                // r==1：超时；r==-1：参数/状态错误
```

想阻塞等待消息而非空轮询，把 `qz_message_fd(rt)`（唤醒 fd，一个 eventfd）接入你自己的 poll/epoll/select，并遵循「排干 → 清计数 → 复查」协议：先用 `qz_recv_message(..., 0)` 把邮箱取空，再 read fd 直到 `EAGAIN`，然后复查一次邮箱 — 确认全空之后才可 poll 阻塞。fd 归运行时所有：宿主不得 close，`qz_free` 之后即失效。

## 等待：qz_ping 与 qz_wait_idle

- `qz_ping` / `qz_ping_path`：存活探测。其阻塞等待发生在**库的泵线程**上；邮箱不受影响
- `qz_wait_idle`：请求在无挂起异步工作时自动退出，然后阻塞直到主体退出。等待期间出站消息（包括崩溃上报 `{"type":"error"}`）照常进入邮箱；返回之后、`qz_free` 之前，仍可 `qz_recv_message` 取净。它与 `qz_destroy` 互斥（二选一，绝不同时调用）

## 销毁运行时

```c
qz_destroy(rt);  // 优雅强制终止，仅宿主线程，NULL 安全
```

`qz_destroy` 会：
1. 请求优雅关停；ISOLATED 下若主RT 始终冻结，库自己的线程会在内部执行最多 2 秒的三级强制终止 — 调用方只需等待子进程被回收。THREAD：请求内部线程退出并 join 它
2. 销毁所有上下文（调用扩展的 `destroy` 钩子）
3. 释放 JSRuntime、库自有的 loop/线程，以及你**始终未消费的邮箱消息** — 若还需要它们，请先行排干邮箱
4. 释放运行时

`qz_destroy(NULL)` 是安全的（无操作）。

另一条收束路径是 `qz_wait_idle` 之后接 `qz_free`，让你在运行时退出后仍能消费最后的消息：

```c
qz_wait_idle(rt);
char *json = NULL; size_t len = 0;
while (qz_recv_message(rt, &json, &len, 0) == 0) {
    printf("%.*s\n", (int)len, json);   // 最后的输出，含 {"type":"error"}
    qz_free_message(json);
}
qz_free(rt);                            // 排干邮箱、关闭唤醒 fd、释放 rt
```

`qz_free(void*)` 是双角色的：传入已被 `qz_wait_idle` 收束的 rt → 排干邮箱、关闭唤醒 fd、释放 config 缓冲与 rt 本身；传入普通的 malloc 块（如来自 `qz_compile`）→ 就是普通 free。内部 magic 标记区分两者。`qz_free(NULL)` 是安全的。

## 线程安全

- **JS 从不在宿主线程上运行，宿主代码也从不进库里运行** — 库拥有其全部线程/loop；两侧之间唯一的桥梁是数据（消息），因此不存在回调重入之类的规则
- **`qz_post_message` 是线程安全的** — 两模型下均可从任何线程调用；JSON 会被拷贝
- **`qz_recv_message` 可从任何线程调用** — 允许多线程并发对同一 rt 调用（无锁 pop 互斥排空），但等待 fd 的线程最多一个；收到消息的跨线程移交由宿主自行负责
- **阻塞等待不影响邮箱** — `qz_ping`、`qz_ping_path`、`qz_wait_idle` 的等待本体在库泵线程上执行；消息（含崩溃上报）照常入队，随你何时排干
- **`qz_destroy` 仅限宿主线程** — 从调用 `qz_create` 的线程调用

## 内存模型

- 所有每运行时状态存储在 `qz_t` 上 — **零可变文件作用域状态**
- 类 ID 是运行时作用域的（在一个 `qz_t` 内的各上下文之间共享）
- 通过 `qz_get_rt_from_ctx(ctx)`（内部 API）从 `JSContext*` 恢复 `qz_t*`
