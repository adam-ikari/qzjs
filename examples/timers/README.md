# timers — 定时器与异步驱动

演示 qzjs 的事件循环驱动 JS 异步：`setTimeout` / `setInterval` / `Promise`
在 qzjs 内部线程的 libuv 循环上推进，**宿主不需要手动驱动**。

## 运行

```bash
./build/qzjs examples/timers/timers.js
```

## 期望输出

```
setTimeout 50ms 后: 50ms
  interval tick 1
  interval tick 2
  interval tick 3
Promise.all: A B
微任务完成
总计: 181ms
```

（时间随机器波动；关键是各延迟按各自设定值触发，而非被量化到整秒。）

## 要点

- 四种异步形态各一遍：`setTimeout` + Promise 包裹、`setInterval` 计数后
  `clearInterval`、`Promise.all` 并发、`await` 后的微任务。
- **用 Release 构建跑**：`QZ_BUILD_TESTS=ON` 的构建把 qzjs 链到 `mock_libuv`，
  其空闲路径阻塞在固定 1 秒轮询兜底上，定时器被量化到整秒——耗时会显示成
  1000ms 而非 50ms。真 libuv 构建不受影响。
- 脚本跑完自动退出——CLI 在无待处理异步工作时进入 idle 并退出
  （`wait_idle` 语义），无需显式 `process.exit`。
- `performance.now()` 提供毫秒级单调时钟。

## 相关文档

- [JS API: timers](/js-api/timers)
- [Event Loop](/guide/event-loop) — libuv 循环与微任务排空
