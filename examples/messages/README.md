# messages — JSON 请求/响应状态机

演示 qzjs 的核心架构：宿主与运行时只经 JSON 消息通信。示例跑一轮
"请求-响应"状态机——宿主发 `echo` / `add` / `date` 三条命令，JS 的
`onmessage` 按 `cmd` 字段分派并回复，宿主从邮箱逐条打印。

- 宿主 → JS：`qz_post_message(rt, json, len)`（线程安全，可任意线程调用）
- JS → 宿主：`postMessage(value)` 落进 per-rt **邮箱**（FIFO），宿主用
  `qz_recv_message` 消费——库不调用宿主回调，消费线程自选

## 构建与运行

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release -DQZ_BUILD_EXAMPLES=ON
cmake --build build --target qz_messages
./build/examples/messages/qz_messages
```

## 期望输出

```
[host]  收到: {"ready":true}
[host]  发:  {"cmd":"echo","text":"hello from host"}
[host]  收到: {"ok":true,"echo":"hello from host"}
[host]  发:  {"cmd":"add","a":20,"b":22}
[host]  收到: {"ok":true,"sum":42}
[host]  发:  {"cmd":"date"}
[host]  收到: {"ok":true,"date":"..."}
[host]  发:  {"cmd":"bogus"}
[host]  收到: {"ok":false,"error":"unknown cmd: bogus"}
[host]  已销毁 runtime
```

## 要点

- **事件契约由你定义**：qzjs 只搬运 JSON，`cmd` 字段的语义、回复的
  `ok` 形状都是应用层约定。两端对称维护同一张事件表即可（见
  [Host Integration](/guide/host-integration) 的"双端事件分发"节）。
- **消费是宿主的主权**：`qz_recv_message` 在哪个线程调、什么节奏调完全由
  宿主决定；单消费者规则（同一时刻只一个线程取件）见 `qzjs.h` 邮箱段。
  未消费的消息在 `qz_destroy` 时随邮箱释放。
- 未知命令走 `ok:false` 分支，演示错误路径也是消息。
- 示例用「定时 `qz_recv_message`」窗口排干邮箱等往返（内部 poll 唤醒）。
  真实宿主把 `qz_message_fd(rt)` 的可读 fd 挂进自己的事件循环即可，无需
  额外线程。

## 相关文档

- [Host Integration](/guide/host-integration) — 消息契约、双端分发
- [JS Execution](/guide/execution) — `initial_script` 与 `onmessage`
