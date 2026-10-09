---
title: JS 执行
description: qzjs 如何执行 JavaScript — initial_script、消息驱动求值、Web Worker 以及扩展注入的全局对象。宿主从不直接求值 JS。
---

# JS 执行

所有 JavaScript 都在 qzjs 的内部线程上运行。宿主从不直接求值或调用 JS —
公开 API **没有** `qz_eval` 和 `qz_call`。代码
通过以下四种方式执行：

1. **`initial_script`** — 运行时启动时求值一次的脚本
2. **消息驱动** — 宿主投递的 JSON 消息触发 JS 中的处理器
3. **Web Worker** — `new Worker(url)` 并行运行独立脚本
4. **扩展全局对象** — 编译进 qzjs 的 C 扩展向 JS 暴露原生函数

## 1. 初始脚本

`qz_create` 在返回前于内部线程上求值 `config.initial_script`。抛错会使
`qz_create` 返回 `NULL`：

```c
qz_config_t cfg = {
    .initial_script =
        "console.log('hello from qzjs');"
        "globalThis.onmessage = function (e) { postMessage('got: ' + e.data); };",
};
qz_t *rt = qz_create(&cfg);   // initial_script 抛错时为 NULL
```

在这里安装消息处理器与顶层状态，然后宿主才开始驱动运行时。

## 2. 消息驱动执行

宿主通过投递 JSON 消息驱动 JS；JS 用 `postMessage` 回复：

```
host  ── qz_post_message(json) ──▶  JS: globalThis.onmessage(e)
host  ◀── qz_recv_message(json) ──  邮箱 ◀── JS: postMessage(value)
```

- `qz_post_message` **线程安全**（JSON 被拷贝），两模型下均可从任意宿主线程调用。
- 消息以 JS 对象/字符串经 `onmessage` 到达；`e.data` 是解析后的负载。
- 从 `postMessage` 序列化的 JSON 进入每运行时一条的 FIFO **邮箱**：宿主用
  `qz_recv_message` 自取（任意线程、任意时机，可限时可纯轮询），每条缓冲用
  `qz_free_message` 释放；`qz_message_fd(rt)` 提供唤醒 fd（`eventfd`），可接入
  宿主自己的 poll/epoll/select 循环。qzjs 从不执行宿主代码——没有回调线程，
  也没有需要提防的重入。

这是宿主 ↔ JS 的唯一数据通道。**没有同步返回值** — 结果总是经邮箱流回。

## 3. Web Worker

`new Worker(url)` 在独立的隔离执行上下文中运行脚本 — 真正的并行工作，而非
共享 `JSRuntime` 的上下文。Worker 通过 `postMessage`/`onmessage` 与其创建者
及彼此通信：

```js
// 主脚本
const w = new Worker("worker.js");
w.onmessage = (e) => console.log("from worker:", e.data);
w.postMessage("start");

// worker.js
globalThis.onmessage = (e) => postMessage("echo: " + e.data.cmd);
```

在 `-DQZ_PROCESS_MODEL=THREAD` 下 worker 运行于并行线程；在默认的
`ISOLATED` 模型下运行于独立子进程。见
[多上下文](/zh/guide/multi-context)。

## 4. 扩展全局对象

原生 C 函数通过把扩展编译进 qzjs（编译期 `QZ_EXTENSIONS` 表）暴露给 JS，
而非由宿主调用 JS。扩展的 `init` 钩子在上下文创建时运行，可用引擎的 C API
注册全局对象：

```c
#include <qzjs/qzjs.h>
#include <quickjs.h>
#include "base/qz_rt.h"    // qz_get_active_jsctx（内部辅助）

static JSValue js_greet(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv) {
    const char *name = argc > 0 ? JS_ToCString(ctx, argv[0]) : "world";
    JSValue v = JS_NewString(ctx, name);
    if (argc > 0) JS_FreeCString(ctx, name);
    return v;
}

static int my_ext_init(qz_ext_t *ext, qz_t *rt) {
    JSContext *ctx = qz_get_active_jsctx(rt);   // 内部辅助
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "greet",
                      JS_NewCFunction(ctx, js_greet, "greet", 1));
    JS_FreeValue(ctx, global);
    return 0;
}
```

在编译期注册扩展（见[扩展](/zh/guide/extensions)）。

## 异步执行

Promise、`async`/`await` 与定时器由内部线程上的嵌入式 libuv 循环驱动。
微任务在循环迭代之间自然刷新。`setTimeout`/
`fetch`/流会持续推进直到 settle；见[事件循环](/zh/guide/event-loop)。
