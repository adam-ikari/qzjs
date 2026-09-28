---
title: 嵌入模式
description: 在 C 应用程序中嵌入 qzjs 的模式 — 邮箱消费、自定义扩展、基于消息的通信以及多实例设置。
---

# 嵌入模式

在 C 应用程序中嵌入 qzjs 的常见模式。

## 基本嵌入

任何构建形态下，库都**自主管理线程与 loop，从不执行宿主代码**：没有回调可装，也没有 loop 可注入。所有发往宿主的消息 — JS 的 `postMessage`、崩溃上报 `{"type":"error"}`、CONTROL 回执 — 都进入每运行时的 FIFO **邮箱**，由宿主**自选线程、自选时机**通过 `qz_recv_message` 消费。

```c
#include <qzjs/qzjs.h>
#include <stdio.h>

int main(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = "postMessage({hello: 'world'});";
    qz_t *rt = qz_create(&cfg);          // 无回调、无 loop 注入
    if (!rt) return 1;

    // 你的应用程序逻辑：通过发送 JSON 消息驱动运行时
    qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);

    // 在本线程上按自己的节奏消费邮箱
    for (;;) {
        char *json = NULL; size_t len = 0;
        int r = qz_recv_message(rt, &json, &len, 5000);  // 最多等 5 秒
        if (r != 0) break;              // 1 = 超时，-1 = 参数/状态错误
        printf("received: %.*s\n", (int)len, json);
        qz_free_message(json);          // 缓冲归你释放
    }

    qz_destroy(rt);
    return 0;
}
```

`qz_create` 会阻塞，直到运行时就绪且 `initial_script` 已求值。ISOLATED 下库 spawn 主RT 进程，并启动**库自己的**宿主侧泵线程与 loop（从不用宿主的）；ready 握手前到达的帧已被重放进邮箱，宿主第一次 `qz_recv_message` 即可取到。THREAD 构建下所有 JS 跑在库的内部线程上。宿主通过 `qz_post_message`（两模型下均线程安全）发送消息，一切输出都从邮箱收取：`qz_recv_message` 返回 `0` 时 `*json` 是 malloc 的、NUL 结尾的 UTF-8 JSON 缓冲（`len` 不含结尾符），必须用 `qz_free_message` 释放；`timeout_ms` 为 `0` 纯轮询、`>0` 最多等待该毫秒数、`-1` 无限阻塞。`qz_destroy` 执行优雅关闭。

若想在邮箱上有消息时被唤醒而不是空轮询，把 `qz_message_fd(rt)`（运行时持有的唤醒 fd，一个 `eventfd`）接入你自己的 poll/epoll/select；可读即表示至少有一条消息待取。按以下消费协议操作可确保不丢唤醒（消息先链入邮箱，之后才写 eventfd）：

1. `qz_recv_message(rt, &json, &len, 0)` — 循环取出并**处理**，直到返回非 0；
2. `read(qz_message_fd(rt), ...)` — 清空 eventfd 计数直到 `EAGAIN`；
3. 再探一次 `qz_recv_message(..., 0)` — 若取到消息则回到步骤 1；只有探空后才可 `poll()` 阻塞。

fd 归运行时所有：宿主不得 close，`qz_free` 之后即失效。允许多个线程并发对同一 rt 调 `qz_recv_message`，但等待 fd 的线程最多只能有一个。

## 从 JS 调用 C 函数

将 C 函数注册为 JS 全局对象：

```c
#include <quickjs.h>
#include "qz_internal.h"   // qz_get_active_jsctx（内部辅助）

static JSValue greet(JSContext *ctx, JSValue this_val,
                     int argc, JSValue *argv) {
    QZ_UNUSED(this_val);
    const char *name = "World";
    if (argc > 0) name = JS_ToCString(ctx, argv[0]);
    printf("Hello, %s!\n", name);
    if (argc > 0) JS_FreeCString(ctx, name);
    return JS_UNDEFINED;
}

// 在自定义扩展的 init 钩子中注册：
static int my_ext_init(qz_ext_t *ext, qz_t *rt) {
    QZ_UNUSED(ext);
    JSContext *ctx = qz_get_active_jsctx(rt);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "greet",
        JS_NewCFunction(ctx, greet, "greet", 1));
    JS_FreeValue(ctx, global);
    return 0;
}
```

`init` 钩子在 `qz_create` 期间、宿主收到运行时之前于 qzjs 的内部线程上运行 — 因此在此注册全局对象是安全的。`qz_get_active_jsctx` 是内部辅助函数（声明于 `src/qz_internal.h`），仅供扩展钩子使用。

## 从 C 调用 JS 并传递结构化数据

从 C 调用 JS 意味着发送一条 JSON 消息，并让 JS 侧通过 `postMessage` 回复；回复会落入邮箱。在 `initial_script` 中安装处理器：

```c
// 引导一个处理结构化数据的 onmessage 处理器
qz_config_t cfg = {0};
cfg.initial_script =
    "globalThis.onmessage = function (e) {"
    "  var d = e.data;"
    "  if (d.cmd === 'process')"
    "    postMessage({ doubled: d.value * 2, ok: true });"
    "};";
qz_t *rt = qz_create(&cfg);

// 将输入作为 JSON 消息发送；回复落入邮箱，由你随时取用
qz_post_message(rt, "{\"cmd\":\"process\",\"value\":21}", 28);

char *json = NULL; size_t len = 0;
if (qz_recv_message(rt, &json, &len, 5000) == 0) {
    printf("JS returned: %.*s\n", (int)len, json);  // {"doubled":42,"ok":true}
    qz_free_message(json);
}
```

JSON 会被 `qz_post_message` 拷贝（两模型下均线程安全，可从任何线程调用）。没有同步的 `qz_call` — 结果一律以邮箱消息的形式到达。

## 按请求隔离上下文

上下文在**运行时内部**管理（`src/context.c`）；宿主不能通过公共 C API 操作它们。宿主只看到一个运行时，并通过 JSON 消息（`qz_post_message` / `qz_recv_message`）通信。如需按请求隔离，可以每个请求创建一个全新的 `qz_t`（每个实例完全独立 — 拥有自己的线程、循环和 JS 状态），或者通过消息将请求路由进一个正在运行的运行时，并打上标签以便 JS 侧维护按请求的状态。

## 使用 mock_libuv 进行测试

要获得确定性的离线测试，可以用 `mock_libuv`（`test/mock_libuv.{c,h}`）替换 libuv — 这是一个假的 `uv_*` API，不涉及网络或系统调用。gtest 套件链接 `qzjs + mock_libuv`（使用 `-DQZ_USE_MOCK_LIBUV`），并通过 `test/test_host.h` 中的 `HostCtx` 测试桩驱动运行时：

- `host_create(script)` / `host_destroy(h)` — 启动/停止一个运行时，附带一个引导脚本，该脚本安装 `globalThis.onmessage` 来处理 `{cmd:'eval', code}` 和 `{cmd:'echo'}`
- `host_eval(h, code, &out)` / `host_value(h, code, &out)` — 通过命令通道求值 JS
- `host_poll_until_value(h, expr, sub, &out)` — 轮询直到条件成立（用于异步结果：promise、定时器、存储）

详见[测试](/zh/dev/testing)。

## 多个独立运行时

由于 qzjs 具有零全局状态，你可以运行多个 `qz_t` 实例 — 每个实例拥有自己的运行时（JS 状态、自己的线程/loop 或主RT 进程，以及**自己独立的邮箱**）：

```c
static void host_drain(qz_t *rt, const char *label, int timeout_ms) {
    for (;;) {
        char *json = NULL; size_t len = 0;
        int r = qz_recv_message(rt, &json, &len, timeout_ms);
        if (r != 0) break;
        printf("%s: %.*s\n", label, (int)len, json);
        qz_free_message(json);
        timeout_ms = 0;   // 首条到达后转纯轮询排干其余
    }
}

qz_config_t cfg1 = { .initial_script = "postMessage('rt1');" };
qz_config_t cfg2 = { .initial_script = "postMessage('rt2');" };

qz_t *rt1 = qz_create(&cfg1);
qz_t *rt2 = qz_create(&cfg2);

// 分别向每个实例发送消息；每个运行时各自排队自己的邮箱
qz_post_message(rt1, "{\"cmd\":\"echo\",\"data\":\"a\"}", 26);
qz_post_message(rt2, "{\"cmd\":\"echo\",\"data\":\"b\"}", 26);

host_drain(rt1, "rt1", 5000);
host_drain(rt2, "rt2", 5000);

qz_destroy(rt1);
qz_destroy(rt2);
```

每个运行时完全自驱运行，两种模型下宿主都没有需要泵动的 loop。`qz_message_fd(rt)` 为每个运行时返回各自独立的唤醒 fd，因此一个宿主线程可以用同一组 poll/epoll 同时照看多个邮箱（对每个等待的 fd 都要套用「排干 → 清计数 → 复查」协议）。

## 错误处理模式

没有同步的求值，因此错误以消息而非返回码的形式呈现：

- 如果 `initial_script` 抛出异常，`qz_create` 返回 `NULL`。
- 运行时中，JS 可以显式报告失败 — 例如 `onmessage` 处理器回复 `postMessage({ ok: false, e: String(err) })`，宿主从邮箱中读取：

```c
char *json = NULL; size_t len = 0;
if (qz_recv_message(rt, &json, &len, 5000) == 0) {
    printf("%.*s\n", (int)len, json);  // 例如 {"ok":false,"e":"TypeError: ..."}
    qz_free_message(json);
}
```

消息处理器内部未捕获的异常不会让运行时崩溃；运行时级别的失败则作为一条普通的 `{"type":"error"}` 消息进入邮箱。

## 内存管理

- `qz_recv_message` 每次返回 `0` 都交给你一块 malloc 缓冲 — 用完必须 `qz_free_message` 释放（NULL-safe）
- `qz_free` 是双角色的：传入已被 `qz_wait_idle` 收束的运行时 → 排干邮箱、关闭唤醒 fd、释放 config 缓冲与 rt 本身；传入普通的 malloc 块（如来自 `qz_compile`）→ 就是普通 free。`qz_free(NULL)` 是安全的 — 不再有 `qz_eval`/`qz_call` 的结果需要释放
- 运行时拥有其所有内部资源（进程或线程、库自有的 loop、上下文、邮箱）— `qz_destroy` 在优雅关闭时释放一切，包括你始终没有消费的消息：若还需要它们，请先行排干邮箱
- 公共 API 中不再有 `host_data` / runtime_data 槽位 — 库从不执行宿主代码，每运行时的宿主侧状态请自行保存在以 `qz_t*` 句柄为键的表里（`qz_ext_t.user_data` 位于共享的编译期扩展结构体上，在各运行时之间共享）
