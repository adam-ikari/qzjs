---
title: 嵌入模式
description: 在 C 应用程序中嵌入 qzjs 的模式 — 宿主数据、自定义扩展、基于消息的通信以及多实例设置。
---

# 嵌入模式

在 C 应用程序中嵌入 qzjs 的常见模式。

## 基本嵌入

ISOLATED（默认）下 JS 跑在独立的主RT 进程里（库自有 loop/线程）；库的宿主侧不拥有线程，宿主经 `cfg.uv_loop` 注入并泵动自己的 loop，`message_cb` 在泵 loop 的线程上触发。THREAD 构建下 qzjs 拥有自己的内部线程和 libuv 事件循环，所有 JS 都运行在该线程上，宿主什么都不用泵。两种形态下宿主都通过 JSON 消息与运行时通信。

```c
#include <qzjs/qzjs.h>
#include <uv.h>
#include <stdio.h>

static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    printf("received: %.*s\n", (int)len, json);
}

int main(void) {
    uv_loop_t loop;
    uv_loop_init(&loop);

    qz_config_t cfg = {0};
    cfg.initial_script = "postMessage({hello: 'world'});";
    cfg.message_cb = on_message;
    cfg.uv_loop    = &loop;           // 宿主 loop 注入（ISOLATED 必填）
    qz_t *rt = qz_create(&cfg);
    if (!rt) return 1;

    // 你的应用程序逻辑：通过发送 JSON 消息驱动运行时
    qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);

    while (uv_run(&loop, UV_RUN_ONCE)) { /* 泵宿主 loop，直到回复到齐 */ }

    qz_destroy(rt);
    uv_loop_close(&loop);
    return 0;
}
```

`qz_create` 会阻塞，直到运行时就绪且 `initial_script` 已求值（ISOLATED 下握手走同步
raw-fd 读，create 期间不泵循环、不触发回调）。宿主通过
`qz_post_message`（两模型下均线程安全）发送消息，并通过 `message_cb` 接收回复——
ISOLATED 下该回调在泵 `cfg.uv_loop` 的宿主线程上触发；THREAD 下在 qzjs 线程上触发
（因此你的回调必须线程安全）。`qz_destroy` 执行优雅关闭。

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

从 C 调用 JS 意味着发送一条 JSON 消息，并让 JS 侧通过 `postMessage` 回复。在 `initial_script` 中安装处理器：

```c
static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    printf("JS returned: %.*s\n", (int)len, json);
}

// 引导一个处理结构化数据的 onmessage 处理器
qz_config_t cfg = {0};
cfg.initial_script =
    "globalThis.onmessage = function (e) {"
    "  var d = e.data;"
    "  if (d.cmd === 'process')"
    "    postMessage({ doubled: d.value * 2, ok: true });"
    "};";
cfg.message_cb = on_message;
cfg.uv_loop = &loop;   // 宿主 loop 注入（ISOLATED 必填）
qz_t *rt = qz_create(&cfg);

// 将输入作为 JSON 消息发送；回复通过 message_cb 到达
// （ISOLATED 下需泵宿主 loop 才会到达）
qz_post_message(rt, "{\"cmd\":\"process\",\"value\":21}", 28);
// on_message 打印：JS returned: {"doubled":42,"ok":true}
```

JSON 会被 `qz_post_message` 拷贝（两模型下均线程安全，可从任何线程调用）。没有同步的 `qz_call` — 结果总是以消息的形式回流。

## 按请求隔离上下文

上下文在**运行时内部**管理（`src/context.c`）；宿主不能通过公共 C API 操作它们。宿主只看到一个运行时，并通过 JSON 消息（`qz_post_message` / `message_cb`）通信。如需按请求隔离，可以每个请求创建一个全新的 `qz_t`（每个实例完全独立 — 拥有自己的线程、循环和 JS 状态），或者通过消息将请求路由进一个正在运行的运行时，并打上标签以便 JS 侧维护按请求的状态。

## 使用 mock_libuv 进行测试

要获得确定性的离线测试，可以用 `mock_libuv`（`test/mock_libuv.{c,h}`）替换 libuv — 这是一个假的 `uv_*` API，不涉及网络或系统调用。gtest 套件链接 `qzjs + mock_libuv`（使用 `-DQZ_USE_MOCK_LIBUV`），并通过 `test/test_host.h` 中的 `HostCtx` 测试桩驱动运行时：

- `host_create(script)` / `host_destroy(h)` — 启动/停止一个运行时，附带一个引导脚本，该脚本安装 `globalThis.onmessage` 来处理 `{cmd:'eval', code}` 和 `{cmd:'echo'}`
- `host_eval(h, code, &out)` / `host_value(h, code, &out)` — 通过命令通道求值 JS
- `host_poll_until_value(h, expr, sub, &out)` — 轮询直到条件成立（用于异步结果：promise、定时器、存储）

详见[测试](/zh/dev/testing)。

## 多个独立运行时

由于 qzjs 具有零全局状态，你可以运行多个 `qz_t` 实例 — 每个实例拥有自己的内部线程、libuv 循环和 JS 状态：

```c
uv_loop_t loop;
uv_loop_init(&loop);                  // 一个宿主 loop 可被多个实例共享

static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt;
    printf("%s: %.*s\n", (const char *)data, (int)len, json);
}

qz_config_t cfg1 = { .initial_script = "postMessage('rt1');",
                       .message_cb = on_message, .host_data = "rt1",
                       .uv_loop = &loop };
qz_config_t cfg2 = { .initial_script = "postMessage('rt2');",
                       .message_cb = on_message, .host_data = "rt2",
                       .uv_loop = &loop };

qz_t *rt1 = qz_create(&cfg1);
qz_t *rt2 = qz_create(&cfg2);

// 分别向每个实例发送消息；回复在每个运行时的 message_cb 上到达
qz_post_message(rt1, "{\"cmd\":\"echo\",\"data\":\"a\"}", 26);
qz_post_message(rt2, "{\"cmd\":\"echo\",\"data\":\"b\"}", 26);

while (uv_run(&loop, UV_RUN_ONCE)) { /* ISOLATED：泵宿主 loop 直到回复到齐 */ }

qz_destroy(rt1);
qz_destroy(rt2);
uv_loop_close(&loop);
```

每个运行时自驱运行自己的 JS；ISOLATED 下宿主仍要泵注入的 `cfg.uv_loop` 才能收到各实例的回复（THREAD 构建无需泵）。

## 错误处理模式

没有同步的求值，因此错误以消息而非返回码的形式呈现：

- 如果 `initial_script` 抛出异常，`qz_create` 返回 `NULL`。
- 运行时中，JS 可以显式报告失败 — 例如 `onmessage` 处理器回复 `postMessage({ ok: false, e: String(err) })`，宿主在 `message_cb` 中读取：

```c
static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    printf("%.*s\n", (int)len, json);  // 例如 {"ok":false,"e":"TypeError: ..."}
}
```

消息处理器内部未捕获的异常不会让运行时崩溃。

## 内存管理

- `qz_free` 仍然存在，用于释放 qzjs 返回的 malloc 块（`qz_free(NULL)` 是安全的）— 不再有 `qz_eval`/`qz_call` 的结果需要释放
- 运行时拥有其所有内部资源（线程、libuv 循环、上下文）— `qz_destroy` 在优雅关闭时释放一切；ISOLATED 下挂在宿主 `cfg.uv_loop` 上的库侧通道句柄也随 teardown 全部关闭，宿主 loop 之后可干净 `uv_loop_close`
- 每个运行时的宿主数据：在 `qz_create` 之前设置 `config.host_data`；扩展的 `init` 钩子在创建期间通过 `qz_get_runtime_data(rt)` 读取它（rt 在 init 内部有效，在宿主接收到之前）。注意：`qz_ext_t.user_data` 位于共享的编译期扩展结构体上 — 对于每个实例的数据，请使用 `qz_get_runtime_data`/`qz_set_runtime_data`，而非 `user_data`（它在运行时之间共享）。
