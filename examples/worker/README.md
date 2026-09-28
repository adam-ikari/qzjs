# worker — 真线程 Web Worker

父 runtime 通过 `new Worker('file://.../worker.js')` 创建独立线程的 worker，
双向 `postMessage` 通信（结构化克隆）。

## 构建与运行

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release -DQZ_BUILD_EXAMPLES=ON
cmake --build build --target qz_worker
./build/examples/worker/qz_worker
```

worker 脚本路径是构建期注入的 `file://` 绝对路径（`QZ_WORKER_SCRIPT`），
程序无需关心 cwd。

## 期望输出

```
worker 已创建
父线程收到 worker 回显: ping from parent
[host] 收到: {"from":"parent","got":"ping from parent"}
[host] done.
```

## 要点

- `Worker` 只接受 `file://` URL；不支持 http(s) 脚本地址。
- `postMessage` 走结构化克隆——对象按值传递，不共享引用。
- worker 是**真线程**：并行计算不阻塞父线程的事件循环。
- 父脚本跑在主RT 进程里；ISOLATED 下宿主侧 `message_cb` 在泵宿主注入
  `cfg.uv_loop` 的线程触发（THREAD 编译则是 qzjs 线程）。示例用「闹钟
  定时器 + `uv_run(UV_RUN_ONCE)`」泵 loop 等往返完成，THREAD 编译退回
  `usleep(500ms)`。
- 多 worker 并行编排见 [`worker-orchestrate`](../worker-orchestrate)。

## 相关文档

- [JS API: worker](/js-api/worker) — `Worker` 完整 API
- [Multi-Context](/guide/multi-context) — worker 与上下文隔离
