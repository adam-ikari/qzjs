# in-module 跨界 ABI 原型（§10 实测验证）

对应 `../IN_MODULE_DESIGN.md` §10。把「pal 面如何跨 wasm」从**设计推断**变为**实测**。

## 一句话

`sh build.sh` → 验证 guest 经 wasm import 调宿主 **三条路径**：**同步**（log）、**回流写回**（宿主值写回 wasm 内存）、**异步**（宿主线程完成 → 队列 → guest drain 取回）。**无 JSValue 跨界**。

## 结构

| 文件 | 角色 |
| --- | --- |
| `guest.wat` → `guest.wasm` | wasm guest：import `qz_host.log` / `qz_host.now` |
| `host.c` | 宿主驱动（同步 A：log + 写回） |
| `guest_async.wat` → `guest_async.wasm` | wasm guest：import `qz_host.fs_read` / `qz_host.drain` |
| `host_async.c` | 宿主驱动（异步 B：pthread 完成 → 队列 → drain） |
| `build.sh` | 一键：wat2wasm + wasm-validate + cc + 跑 A/B |

## 验证的主张（§10）

| # | 主张 | 证据 |
| --- | --- | --- |
| 1 | import module 名隔离 `qz_host.*`（§10.6） | `wasm-objdump -x` → `func <qz_host.log>` / `<qz_host.now>` |
| 2 | guest 同步跨界调宿主（§10.3） | `greet` → stderr `[qz_host.log] hello from wasm guest` |
| 3 | 内存按 ptr+len 传字节，无 JSValue（§10.1） | `host_log(level, ptr, len)` 从 wasm 内存 `addr_app_to_native` 读 |
| 4 | 回流写回：宿主值 → wasm 内存 → 宿主读回（§10.4） | `pull_now` 调 `qz_host.now`、`i64.store` 写回，宿主读 i64 |
| 5 | **异步回流**：guest 发起 → 宿主线程完成 → 队列 → guest drain（§10.4 import 拉） | `run_async`：`fs_read`→op_id=1，drain ~76k 轮后取回 24 字节负载 |

## 结论

§10 跨界 ABI 骨架**成立**（含异步）。此原型是 M4/M5 的最小起点：

- M4：把 `guest.wat` 换成 `clang --target=wasm32` 编译的 qzvm 内核源。
- M5：`qz_host.log` 等换成 §10.3 的完整 import 面；`qz_host.drain` 扩为真实完成队列。
- 深化：guest 侧 `resolve` 持真实 `JSValue`（此原型用整型 op_id + 内存回传替代）；
  `run_async` 的 **drain 自旋**在真实版应改为 **return 让 tick 让出**（§5.4 拉模型）。

## 未覆盖（留 M5+）

- guest 侧 **JSValue 生命周期**（promise resolve 的真实持有/释放）
- **内存增长**（`memory.grow` + 宿主侧地址重算）
- **AOT 变体**（wamrc 预编译路径）
- **多 op 并发**（队列深度 > 1 的乱序完成）

## 复现

```sh
sh src/qzvm/aot/inmod-abi-proto/build.sh
# 依赖：wat2wasm (wabt) + cc + build/deps/wamr/libiwasm.a（项目 build 后即有）
```
