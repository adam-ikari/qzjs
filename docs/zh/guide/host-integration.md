---
title: 主机集成
description: 在 C 应用中嵌入 qzjs 的主机集成路径 —— create、JSON 邮箱消息契约、向 JavaScript 出借能力、优雅销毁。
---

# 主机集成

在 C 应用里嵌入 qzjs 分五步。宿主和运行时只通过 JSON 消息通信。且 qzjs 从不执行宿主代码——没有任何回调：所有出站消息进入邮箱，由宿主在自己的线程上自选时机消费。

## 五步

```
┌─────────────────────────────────────────────────────────────┐
│ 1. create      qz_create(&cfg)   — 运行时已活、JS 就绪        │
│ 2. script      initial_script            — JS 先跑什么        │
│ 3. communicate qz_post_message ⇄ qz_recv_message — 邮箱契约  │
│ 4. lend        暴露 C 函数、serve/fs/worker/crypto 给 JS      │
│ 5. destroy     qz_destroy(rt)    — 优雅销毁                 │
└─────────────────────────────────────────────────────────────┘
```

## 1. Create

ISOLATED（默认）下 [`qz_create`](/zh/c-api/runtime) spawn 主RT 进程（`qzjs-rt`），随后
**库自己启动宿主侧线程 + loop**——宿主什么都不用注入、什么都不用驱动。它阻塞等待
mainRT 的 `CONTROL{ready}` 回执；ready 前到达的帧已被重放进邮箱，宿主的第一个
`qz_recv_message` 就能拿到它们。THREAD 构建下则启动 qzjs 内部线程、拉起 libuv 循环。
两种形态下它都阻塞到就绪才返回，这时运行时已活、`initial_script` 已跑完。失败返回 `NULL`。

```c
qz_config_t cfg = {0};
cfg.initial_script = "postMessage({ready: true});";
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

qzjs **从不执行宿主代码**——公共 API 里不存在任何回调。所有发往宿主的消息——JS
`postMessage`、崩溃上报 `{"type":"error"}`、CONTROL 回执——都进入每个 runtime 一条的
FIFO **邮箱**，由宿主在自己的线程上自选时机排干。两种形态下库都自主管理线程与 loop
（ISOLATED：mainRT 子进程 + 库内部宿主侧线程；THREAD：内部 qzjs 线程）；宿主只需读邮箱。

| 方向 | 机制 | 线程 |
|-----------|-----------|--------|
| 主机 → JS | `qz_post_message(rt, json, len)` | 线程安全，任意线程可调 |
| JS → 主机 | 邮箱，经 `qz_recv_message(rt, &json, &len, timeout_ms)` 消费 | 宿主自选线程、自选时机 |

```c
int  qz_recv_message(qz_t *rt, char **json, size_t *len, int timeout_ms);
void qz_free_message(void *json);
int  qz_message_fd(qz_t *rt);
```

- **`qz_recv_message`** —— `timeout_ms`：`0` = 纯轮询（不等待），`>0` = 最多等待该
  毫秒数，`-1` = 永久阻塞。返回 `0` = 取到消息（`*json` 是 malloc 缓冲区，**必须**用
  `qz_free_message` 释放），`1` = 超时（`*json` 不变），`-1` = 参数/状态错误。
  `json` 为 NUL 结尾的 UTF-8；`len` 不含结尾符。
- **`qz_message_fd`** —— 该 runtime 的唤醒 fd（`eventfd`）。可读 ⇒ 至少一条消息待取。
  可接入你自己的 poll/epoll/select。归 rt 所有：宿主不得 close，`qz_free` 后失效。
  仅 Linux。
- **`qz_free_message`** —— 释放 `qz_recv_message` 返回的缓冲区。NULL 安全。

规则：

- **两个方向都是 JSON 字符串。** 不传指针，不共享内存对象，只传可序列化的数据。
- **`qz_post_message` 线程安全。** 可从任意主机线程调用；它入队到运行时的入站队列。同一 runtime 的 FIFO 顺序保持；投递不依赖宿主的调度——库自有线程双向搬运帧。
- **消费完全由宿主掌控。** 任意线程、任意时机，但同一 runtime **同一时刻只允许一个消费者**：无锁 pop 并非互斥，两个线程并发弹出会各自读到同一个 head 节点——同一条消息交付两次、同一节点释放两次。消费须由宿主串行化；跨线程的消息所有权交接由宿主负责。
- **阻塞型宿主 API（`qz_ping`、`qz_ping_path`、`qz_wait_idle`、`qz_destroy`）阻塞的是调用线程**，不依赖你运行任何东西——等待是调用方在等，库自有线程在这期间照常转 loop、产出回执（或执行三级终止）。没有需要保持轻量的回调，也没有嵌套要避免——随时排干邮箱即可，哪怕另一个线程正阻塞在其中某个调用里。
- **未消费的消息在 `qz_destroy`/`qz_free` 时被释放**——不泄漏，但需要就先排干。
- **有界队列。** 运行时忙（或者 JS 一直不读）时，入站消息会在队列边界积压。
  你的主机代码要能接受 `qz_post_message` 不会马上排空。

```c
/* 你自己的消息处理器（按事件类型分发）。 */
static void handle_json(char *json, size_t len) {
    (void)json; (void)len;   /* 真实实现里解析并分发 */
}

static void host_drain(qz_t *rt, int timeout_ms) {
    for (;;) {
        char *json = NULL; size_t len = 0;
        int r = qz_recv_message(rt, &json, &len, timeout_ms);
        /* 三态分开看：0 = 取到；1 = 窗口内无消息（正常收工）；-1 = 参数/状态
         * 错误。把 -1 和 1 一起 break 等于把错误当「没消息了」。 */
        if (r < 0) { fprintf(stderr, "qz_recv_message failed\n"); break; }
        if (r == 1) break;
        handle_json(json, len);
        qz_free_message(json);
        timeout_ms = 0;   // 首条到达后转纯轮询排干
    }
}

// 任意主机线程：
qz_post_message(rt, "{\"cmd\":\"start\",\"n\":42}", 22);
```

反方向（JS 调 C）也一样：JS 里 `postMessage` 会进入邮箱，或者把 C 函数
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
qz_post_message(rt, "{\"cmd\":\"eval\",\"code\":\"2 + 2\"}", 29);
// qz_recv_message 取到：{"result":4}
```

代码片段由运行时的 JS `eval` 执行，结果像任何其他回复一样经邮箱流回。

### 双端事件分发

两端都按事件类型分发。约定一个形状——`{"type": ..., "payload": ...}`——并给**每一端**
各自的转发器：JS 侧在 `onmessage` 里路由入站宿主消息，C 侧在排干邮箱时路由
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

**宿主侧**——在排干邮箱时镜像同样的分发，把每条入站事件（一个 `{type, payload}`
JSON 字符串）路由到对应 C 处理器：

```c
#include <qzjs/qzjs.h>
#include <stdio.h>
#include <string.h>

static void on_ping(const char *json)  { puts("[host] ping:reply"); }
static void on_add(const char *json)   { puts("[host] add:reply"); }

static void dispatch_message(const char *json) {
    /* 用宿主语言的 JSON 库解析 type 再分发；此处为简洁用子串匹配 */
    if (strstr(json, "\"type\":\"ping:reply\"")) on_ping(json);
    else if (strstr(json, "\"type\":\"add:reply\"")) on_add(json);
}

int main(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = "/* 上面的 JS 转发器 */";
    qz_t *rt = qz_create(&cfg);          // 线程与 loop 归库所有

    const char *ping = "{\"type\":\"ping\",\"payload\":{}}";
    qz_post_message(rt, ping, strlen(ping));            // → on_ping
    const char *add  = "{\"type\":\"add\",\"payload\":{\"a\":2,\"b\":3}}";
    qz_post_message(rt, add, strlen(add));              // → on_add

    /* 在本线程消费邮箱：预期两条回复，各最多等 2 秒 */
    for (int i = 0; i < 2; i++) {
        char *json = NULL; size_t len = 0;
        if (qz_recv_message(rt, &json, &len, 2000) != 0) break;
        dispatch_message(json);
        qz_free_message(json);
    }

    qz_destroy(rt);
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

[`qz_destroy`](/zh/c-api/runtime) 执行优雅的强制终止：ISOLATED 下对卡死的 mainRT
最坏是 ≤2 秒的三级终止，全程在库自己的线程内处理——调用方只等待回收；THREAD 下
通知内部线程并 join。两种形态下都会排空待处理工作并释放运行时。**此时尚未消费的
邮箱消息会被释放**，需要就先排干。运行时不再需要时从宿主调用。完整生命周期与内存模型见
[运行时生命周期](/zh/guide/lifecycle)。

---

## 相关页面

| 主题 | 页面 |
|-------|------|
| 线程所有权、就绪、关闭 | [运行时生命周期](/zh/guide/lifecycle) |
| 库自有线程、唤醒 fd、排干邮箱 | [事件循环](/zh/guide/event-loop) |
| 单运行时内多个隔离上下文 | [多上下文](/zh/guide/multi-context) |
| 注册 C 函数 / 结构化数据 | [嵌入模式](/zh/guide/embedding) |
| C API 参考 | [C API](/zh/c-api/) |
