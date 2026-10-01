# hello — 最简嵌入示例

创建运行时 → 执行 JS → 宿主与 JS 双向收发消息 → 销毁。整个示例只有一个
C 文件，是把 qzjs 嵌进宿主程序的最小可运行形态。

演示的核心契约：**宿主与运行时只经 JSON 消息通信**。

- 宿主 → JS：`qz_post_message(rt, json, len)`（线程安全）
- JS → 宿主：`postMessage(value)` 落进 per-rt **邮箱**（FIFO），宿主用
  `qz_recv_message(rt, &json, &len, timeout_ms)` 消费——库不调用宿主任何
  回调，消费线程与时机完全由宿主自选（两个进程模型同一契约）

## 构建与运行

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release -DQZ_BUILD_EXAMPLES=ON
cmake --build build --target qz_hello
./build/examples/hello/qz_hello
```

## 期望输出

```
hello from qzjs!
JS 收到宿主消息: {"cmd":"ping"}
[host] 收到 JS 消息: {"greeting":"hello from JS","ts":...}
[host] 发消息给 JS: {"cmd":"ping"}
[host] 收到 JS 消息: {"reply":"pong"}
[host] 已销毁 runtime
```

## 要点

- `qz_config_init(&cfg)` 初始化（它填 ABI 门控字段 `struct_size` /
  `abi_version`，零初始化 `= {0}` 会被 `qz_create` 以 ABI mismatch 拒绝——
  让「忘了声明版本」在开发期立即暴露）；配置里没有任何回调字段——出站消息走
  邮箱，`qz_recv_message` 是唯一消费入口（配套 `qz_free_message` 释放、
  `qz_message_fd` 拿唤醒 fd）。
- `cfg.initial_script` 是启动即执行的 JS；`onmessage` 是 JS 侧的收信入口。
- 示例以最简的「定时 `qz_recv_message`」排干邮箱（内部经 poll 唤醒，不烧
  CPU）。宿主若本就有事件循环，把 `qz_message_fd(rt)` 返回的 fd 挂进去、
  按头文件注释的三步消费协议取件即可，无需额外线程。
- `qz_create` 失败返回 `NULL`；示例按契约检查。
- 用 `QZ_RT_SERVER_PATH`（构建系统注入）告诉示例去哪找 `qzjs-rt`；默认
  进程模型是 ISOLATED，运行时跑在独立进程里。

## 相关文档

- [Quick Start](/guide/quickstart) — 从零构建并嵌入
- [Host Integration](/guide/host-integration) — 消息契约与双端事件分发
- [Runtime Lifecycle](/guide/lifecycle) — `qz_create` / `qz_destroy` 语义
