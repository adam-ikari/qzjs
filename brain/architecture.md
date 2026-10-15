---
slug: architecture
title: System architecture
role: system architecture
updated: "2026-10-15T02:05:47"
---

# System architecture

## Overview

qzjs 是 C99 编写的嵌入式 JS 运行时包装层：宿主通过 C API（qz_create/destroy/post_message/recv_message 等）
与 qzjs 交互；事件循环内置于运行时——缺省 ISOLATED 进程模型下 JS 跑在独立主RT 进程
（qzjs-rt，库自有 loop+线程）；主权原则（M-P7 裁决，2026-09-28 落地）：qzjs 完全自主管理自己的
线程和进程、不干涉宿主形态、不跨线程调用宿主任何函数——宿主侧由库自管宿主侧线程+loop，host 方向
消息入邮箱（qz_recv_message 阻塞/超时/非阻塞三态 + qz_message_fd 唤醒 fd），宿主在自选线程上
自行消费，postMessage/邮箱是唯一通讯面（M-P6 的 cfg.uv_loop 注入契约与 message_cb 回调已整体废除）。
THREAD 模型下为库内部线程 + 嵌入式 libuv 循环，出站消息同样入邮箱由宿主消费。polyfill（ES module 经
esbuild 打包）提供 WinterTC Web API 层；原生扩展通过 PAL 桥接暴露给 JS。

## Module graph

```mermaid
graph TD
  H[Host C application] -->|qz_* C API + mailbox drain| R[qzjs core<br/>src/host/qzjs.c + bridge.c]
  R -->|libuv loop| L[libuv]
  R --> Q[QuickJS-ng runtime]
  Q -->|bundle| P[polyfill ES modules<br/>fetch/streams/worker/crypto/http-server/...]
  Q -->|extensions| E[PAL extensions<br/>compress / crypto / textcodec / wamr]
  P -->|pal.* API| R
  P -->|pal.tcp*/tls*| U[serve(): raw TCP + mbedTLS<br/>HTTP1.1/HTTPS/WS/static/gzip]
  R -->|Worker| W[Worker thread<br/>src/host/worker.c + MessagePort routing]
  T[test/ gtest + mock_libuv] -->|offline| R
```

## qzvm 边界（2026-10-14 立）

qzjs 内部再分层：**qzvm** = 独立可用的 VM 库（`src/qzvm/`），与 qzjs 其余（IO 原语/libuv/编排/控制面）分离。
依赖单向：**宿主 → qzjs → qzvm**。

| 层 | 含 | 不含 |
| --- | --- | --- |
| **宿主** | 使用者：C 程序 / node / 固件 | libuv、WAMR/wasm3、QuickJS（= qzjs 自身责任） |
| **qzjs 运行时** | IO 原语 `uv_io_*`、libuv 循环、进程/控制面、polyfill、wasm 引擎后端 | 应用业务逻辑 |
| **qzvm** | QuickJS-ng + `qz.*` 原语 + realm 生命周期 + DAP + 扩展注册机制 + 引擎 patches | libuv、宿主 IO 编排、Web API 扩展内容 |

**三条硬约束**：① qzvm 零 libuv（`uv_*` 编译期不可达；唯一残留 = `debugger_dap.c` 的 `uv_timer_t`，须改注入式定时源）；② qzvm 可独立使用（现缺独立构建单元/公开头，须补 `libqzvm` target）；③ **qzvm GC 确定性**（用户裁决 2026-10-15）——相同输入 + 相同显式驱动序列 → GC 行为（何时触发/回收什么/暂停多久）可复现。旧表述「确定性护城河 = 宿主主导权（C 可脱离 JS 独立跑）」**已废**（[[qzvm-qzjs-layering]]）；缺口：quickjs-ng `random_state` 时钟播种（`quickjs.c:2942`）/`hash_seed` 派生（`:2946`）、GC 由 `malloc_gc_threshold` 分配压力驱动（`:2343`/`:1689`）、`qz_config_t` 无种子/GC 字段且引擎公有面无 seed API。

**in-module 档** = 把 qzvm 编成 wasm32 模块（`libqzvm.wasm`）的 qzjs 构建形态——**qzjs 内部两半**分层（wasm 外 qzjs-native IO ↔ wasm 内 qzvm），非 qzjs 与外部分层。qzjs **永远持有 JS 运行时**（即 wasm 内引擎）。in-module 下 qzvm **不含** wasm 引擎绑定。

SSOT：`docs/architecture/qzvm-qzjs-layering.md`；brain `[[qzvm-qzjs-layering]]`。

## Constraints

- 严格 C99；事件循环归属（M-P7 现状）：一切 loop/线程归 qzjs 自管（ISOLATED 宿主侧线程 + 主RT 进程；THREAD 编译则单线程；worker 载体随模型而定——ISOLATED=独立进程、THREAD=内部线程，worker_backend 可显式覆盖），宿主只消费邮箱、零驱动义务、零回调；qzjs 从不执行宿主代码，公共 API 无函数指针字段，宿主无 libuv 同链接义务
- 确定性离线测试:mock_libuv 替换真实 libuv，无网络/无真实时间依赖
- 子模块策略:deps/ 全部 pin 版本(quickjs-ng/wamr/mbedtls/...)
- polyfill 产物(disting/polyfill.js + src/polyfill_default.c)纳入 git(git add -f)
- qzvm 分层（2026-10-14）：qzvm 零 libuv + 可独立使用；详见 qzvm 边界节
- qzvm GC 确定性（2026-10-15）：引擎内 GC/随机性须可复现，种子/驱动点由宿主 policy 注入；详见 `[[qzvm-qzjs-layering]]`
