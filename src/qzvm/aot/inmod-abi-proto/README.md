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
| `bench3.wat` → `bench3.wasm` + `host_bench3.c` | 性能 C 段：空/带负载 import vs 纯 wasm vs C 直调基线 |
| `build.sh` | 一键：wat2wasm + wasm-validate + cc + 跑 A/B/C |

## 验证的主张（§10）

| # | 主张 | 证据 |
| --- | --- | --- |
| 1 | import module 名隔离 `qz_host.*`（§10.6） | `wasm-objdump -x` → `func <qz_host.log>` / `<qz_host.now>` |
| 2 | guest 同步跨界调宿主（§10.3） | `greet` → stderr `[qz_host.log] hello from wasm guest` |
| 3 | 内存按 ptr+len 传字节，无 JSValue（§10.1） | `host_log(level, ptr, len)` 从 wasm 内存 `addr_app_to_native` 读 |
| 4 | 回流写回：宿主值 → wasm 内存 → 宿主读回（§10.4） | `pull_now` 调 `qz_host.now`、`i64.store` 写回，宿主读 i64 |
| 5 | **异步回流**：guest 发起 → 宿主线程完成 → 队列 → guest drain（§10.4 import 拉） | `run_async`：`fs_read`→op_id=1，drain ~76k 轮后取回 24 字节负载 |
| 6 | **跨界税可测**：空 import ~45 ns/次、带负载 ~66 ns/次 | C 段 `bench3`（宿主侧计时，多轮取 min） |

## 结论

§10 跨界 ABI 骨架**成立**（含异步）。此原型是 M4/M5 的最小起点：

- M4：把 `guest.wat` 换成 `clang --target=wasm32` 编译的 qzvm 内核源。
- M5：`qz_host.log` 等换成 §10.3 的完整 import 面；`qz_host.drain` 扩为真实完成队列。
- 深化：guest 侧 `resolve` 持真实 `JSValue`（此原型用整型 op_id + 内存回传替代）；
  `run_async` 的 **drain 自旋**在真实版应改为 **return 让 tick 让出**（§5.4 拉模型）。

## 性能（§10 实测）

WAMR 经典解释器，宿主侧计时，多轮取 min（机器负载 ~6.5/12 核）：

| 路径 | ns/次 | 说明 |
| --- | --- | --- |
| wasm 空 import（`noop`） | **~45** | 纯跨界税（guest→host 往返） |
| wasm 带负载 import（`sink`，读 32B 内存） | **~66** | 含 `addr_app_to_native` + 内存读 |
| wasm 纯循环 | ~5.6 | 迭代基线（无跨界） |
| C 直调空函数 | ~0.3 | 无 wasm 的基线 |
| C 直调带负载 | ~11 | 同上 + 32B 读 |

**结论**：跨界税 ≈ **45 ns/次**（空）、**66 ns/次**（32B 负载）。即：
- 相对 C 直调高 ~150x，但绝对值极低——**每秒 ~2200 万次跨界**。
- 对比 AOT（`qz.*` import = **JS 函数**，~4.9µs/次，见 `ASSESSMENT.md`）：in-module 的
  `qz_host.*` 直落 **native C**，**快 ~100x**。这是 in-module 的关键性能优势。

**含义**：pal 面每轮 tick 的跨界调用（几十次量级）**纳秒级总开销**，非瓶颈。
设计上仍应遵循 §10「收 JSValue 的包装留 guest、跨界的只在原语层」——把跨界次数降到最低，
但**不必**为省跨界牺牲结构（税太便宜）。

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
