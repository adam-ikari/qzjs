---
title: 主机集成
description: 在 C 应用中嵌入 qzjs 的主机集成路径 —— create、JSON 消息契约、向 JavaScript 出借能力、优雅销毁。
---

# 主机集成

在 C 应用里嵌入 qzjs 分五步。宿主和运行时只通过 JSON 消息通信。

## 五步

```
┌─────────────────────────────────────────────────────────────┐
│ 1. create      qz_create(&cfg)   — 线程 + 循环 + JS 就绪    │
│ 2. script      initial_script            — JS 先跑什么        │
│ 3. communicate qz_post_message ⇄ message_cb  — JSON 契约   │
│ 4. lend        暴露 C 函数、serve/fs/worker/crypto 给 JS      │
│ 5. destroy     qz_destroy(rt)    — 优雅销毁                 │
└─────────────────────────────────────────────────────────────┘
```

## 1. Create

ISOLATED（默认）下 [`qz_create`](/zh/c-api/runtime) spawn 主RT 进程（`qzjs-rt`）、在同步
raw-fd 读上完成 ready 握手（期间不泵循环、不触发回调），再把宿主侧通道句柄挂到你经
`cfg.uv_loop` 注入的宿主 loop 上——传 NULL 会让 `qz_create` 显式失败。THREAD 构建下则
启动 qzjs 内部线程、拉起 libuv 循环。两种形态下它都阻塞到就绪才返回，这时运行时已活、
`initial_script` 已跑完。

```c
uv_loop_t loop;
uv_loop_init(&loop);

qz_config_t cfg = {0};
cfg.initial_script = "postMessage({ready: true});";
cfg.message_cb = on_message;      // 出站 JS→host
cfg.uv_loop    = &loop;           // 宿主 loop 注入（ISOLATED 必填）
qz_t *rt = qz_create(&cfg);   // 阻塞直到就绪
```

## 2. 选择 JS 先跑什么

喂给运行时初始脚本有三种方式：

- **`initial_script`** —— 小字符串，适合引导逻辑。qzjs 在内部把自身的
  WinterTC polyfill 编译为字节码。预编译字节码也可叠加：设置
  `initial_bytecode` 在脚本之后运行 `qz_compile()` 产物（字节码与构建绑定，
  见 [字节码](/zh/guide/bytecode)）
- **`initial_script_path`** —— 指向磁盘上 JS 文件的路径；qz_create 时读取并求值。适合脚本以文件形式部署的场景。两者都设时 `initial_script_path` 优先；文件不存在则 `qz_create` 返回 `NULL`
- **`qz_post_message`** —— 创建后一切由消息驱动

## 3. 消息契约

宿主和 JS 双向都以 JSON 字符串交换数据：不传指针，不共享内存对象。

ISOLATED 下库不拥有宿主侧线程：宿主经 `cfg.uv_loop` 注入自己的 loop 并负责泵它，
JS 执行在主RT 进程内进行。THREAD 下 qzjs 自己管线程和循环，宿主什么都不用泵。
两种形态下宿主都不调用 JS 让它运行；ISOLATED 下阻塞宿主 API 会在内部就地泵宿主
loop（见下方规则）。

| 方向 | 机制 | 线程 |
|-----------|-----------|--------|
| 主机 → JS | `qz_post_message(rt, json, len)` | 线程安全，任意线程可调 |
| JS → 主机 | `cfg.message_cb(rt, json, len, data)` | ISOLATED：在泵宿主 loop 的线程上触发；THREAD：在 qzjs 线程上触发 |

规则：

- **两个方向都是 JSON 字符串。** 不传指针，不共享内存对象，只传可序列化的数据。
- **`qz_post_message` 线程安全。** 可从任意主机线程调用；它入队到 qzjs 的入站队列。ISOLATED 下投递延迟等于你的泵频；同一 runtime 的 FIFO 顺序保持。
- **`message_cb` 的线程归属看模型。** ISOLATED 下它在泵你 `cfg.uv_loop` 的线程上运行——保持轻量，且**不要在回调内调用阻塞宿主 API**（`qz_ping`、`qz_wait_idle`、`qz_destroy` 会在内部就地泵宿主 loop，回调可能在调用内重入触发）；THREAD 下它与事件循环、所有 JS 共享 qzjs 线程，回调须线程安全。
- **有界队列。** 运行时忙（或者 JS 一直不读）时，入站消息会在队列边界积压。
  你的主机代码要能接受 `qz_post_message` 不会马上排空。

```c
static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    // json 是完整 JSON 字符串；在主机侧解析并分发
    handle_json(json, len);
}

// 任意主机线程：
qz_post_message(rt, "{\"cmd\":\"start\",\"n\":42}", 22);
```

反方向（JS 调 C）也一样：JS 里 `postMessage` 会落到 `message_cb`，或者把 C 函数
注册成 JS 全局。见 [扩展](/zh/guide/extensions) 和 [嵌入模式](/zh/guide/embedding)。

### 发送代码执行

边界承载 JSON，但往 JSON 里放什么由你决定。常见的做法是发一条
`{ cmd: 'eval', code: ... }` 消息，让 JS 侧执行——REPL、动态规则引擎就是这么做的：

```js
// initial_script
globalThis.onmessage = function (e) {
  if (e.data && e.data.cmd === 'eval') {
    let out;
    try { out = eval(e.data.code); }
    catch (err) { out = { error: String(err) }; }
    postMessage({ result: out });
  }
};
```

```c
// 宿主侧——发送要执行的代码
qz_post_message(rt, "{\"cmd\":\"eval\",\"code\":\"2 + 2\"}", 26);
// message_cb 收到：{"result":4}
```

代码片段由运行时的 JS `eval` 执行，结果像任何其他回复一样经 `message_cb` 流回。

### 双端事件分发

两端都按事件类型分发。约定一个形状——`{"type": ..., "payload": ...}`——并给**每一端**
各自的转发器：JS 侧在 `onmessage` 里路由入站宿主消息，C 侧在 `message_cb` 里路由
入站 JS 回复。

**JS 侧**——一个处理事件表并回复的转发器：

```js
// initial_script — JS 事件转发器
const handlers = {
  ping(d)  { return { ok: true, at: Date.now() }; },
  add(d)   { return d.a + d.b; },
};
globalThis.onmessage = function (e) {
  const { type, payload } = e.data || {};
  const h = handlers[type];
  postMessage({ type: type + ':reply', ok: !!h, payload: h ? h(payload) : undefined });
};
```

**宿主侧**——在 `message_cb` 里镜像同样的分发，把每条入站事件（一个 `{type, payload}`
JSON 字符串）路由到对应 C 处理器：

```c
#include <qzjs/qzjs.h>
#include <uv.h>
#include <stdio.h>
#include <string.h>

static void on_ping(const char *json)  { puts("[host] ping:reply"); }
static void on_add(const char *json)   { puts("[host] add:reply"); }

static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    /* 用宿主语言的 JSON 库解析 type 再分发；此处为简洁用子串匹配 */
    if (strstr(json, "\"type\":\"ping:reply\"")) on_ping(json);
    else if (strstr(json, "\"type\":\"add:reply\"")) on_add(json);
}

int main(void) {
    uv_loop_t loop;
    uv_loop_init(&loop);

    qz_config_t cfg = {0};
    cfg.message_cb = on_message;
    cfg.initial_script = "/* 上面的 JS 转发器 */";
    cfg.uv_loop = &loop;                    // ISOLATED 必填（THREAD 构建不需要）
    qz_t *rt = qz_create(&cfg);

    const char *ping = "{\"type\":\"ping\",\"payload\":{}}";
    qz_post_message(rt, ping, strlen(ping));            // → on_ping
    const char *add  = "{\"type\":\"add\",\"payload\":{\"a\":2,\"b\":3}}";
    qz_post_message(rt, add, strlen(add));              // → on_add

    /* ISOLATED：泵宿主 loop 直到回复全部到达；THREAD 下这一步可省略 */
    while (uv_run(&loop, UV_RUN_ONCE)) { /* until done */ }

    qz_destroy(rt);                         // 库句柄已随 teardown 关闭
    uv_loop_close(&loop);
    return 0;
}
```

每端一个转发器让事件契约对称、可读：JS 的事件表与 C 的 `if/else` 链命名同一组事件，
两端对 `type` 的含义保持一致。

## 4. 向 JS 出借能力

运行时里的 JS 以全局对象的形式拿到 WinterTC 接口，不用 import：`fetch`、
`crypto.subtle`、`ReadableStream`、timers、`fs`、`WebSocket`、`Worker`、
`BroadcastChannel`、`serve()`（HTTP/WS/gRPC 服务器）。见 [JS API 参考](/zh/js-api/)。

也可以把自己的 C 函数注册成 JS 全局。见 [扩展](/zh/guide/extensions)。

## 5. Destroy

[`qz_destroy`](/zh/c-api/runtime) 执行优雅关闭：ISOLATED 下它是阻塞宿主 API，在内部就地泵
`cfg.uv_loop` 直到主RT 进程 teardown 完成，结束后挂在宿主 loop 上的库句柄已全部关闭（宿主
loop 可以干净 `uv_loop_close`）；THREAD 下通知内部线程、排空待处理工作、释放运行时。运行时
不再需要时从宿主调用。完整生命周期与内存模型见
[运行时生命周期](/zh/guide/lifecycle)。

---

## 相关页面

| 主题 | 页面 |
|-------|------|
| 线程所有权、就绪、关闭 | [运行时生命周期](/zh/guide/lifecycle) |
| 谁驱动循环、背压 | [事件循环](/zh/guide/event-loop) |
| 单运行时内多个隔离上下文 | [多上下文](/zh/guide/multi-context) |
| 注册 C 函数 / 结构化数据 | [嵌入模式](/zh/guide/embedding) |
| C API 参考 | [C API](/zh/c-api/) |
