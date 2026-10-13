# in-module 跨界 ABI 原型（§10 实测验证）

对应 `../IN_MODULE_DESIGN.md` §10。把「pal 面如何跨 wasm」从**设计推断**变为**实测**。

## 一句话

`sh build.sh` → 验证 guest 经 wasm import 调宿主两条路径：**同步**（log）+ **回流**（宿主值写回 wasm 内存，宿主读回）。**无 JSValue 跨界**。

## 结构

| 文件 | 角色 |
| --- | --- |
| `guest.wat` → `guest.wasm` | wasm guest，import `qz_host.log` / `qz_host.now` |
| `host.c` | 宿主驱动（vendored WAMR 加载 + 注册 natives） |
| `build.sh` | 一键：wat2wasm + wasm-validate + cc 链接 + 跑 |

## 验证的主张（§10）

| # | 主张 | 证据 |
| --- | --- | --- |
| 1 | import module 名隔离 `qz_host.*`（§10.6） | `wasm-objdump -x` → `func <qz_host.log>` / `<qz_host.now>` |
| 2 | guest 同步跨界调宿主（§10.3） | `greet` → stderr `[qz_host.log] hello from wasm guest` |
| 3 | 内存按 ptr+len 传字节，无 JSValue（§10.1） | `host_log(level, ptr, len)` 从 wasm 内存 `addr_app_to_native` 读 |
| 4 | 回流形态：宿主值 → wasm 内存 → 宿主读回（§10.4） | `pull_now` 调 `qz_host.now`、`i64.store` 写回，宿主读 i64 |

## 结论

§10 的跨界 ABI 骨架**成立**。此原型是 M4/M5 的最小起点：

- M4：把 `guest.wat` 换成 `clang --target=wasm32` 编译的 qzvm 内核源。
- M5：`qz_host.log` 换成 §10.3 的完整 import 面；`pull_now` 的写回扩为 §10.4 的完成队列。
- 未覆盖：**异步**（真正的 promise 回流，需 tick）、**内存增长**、**AOT/wasmi 变体**——留待 M5。

## 复现

```sh
sh src/qzvm/aot/inmod-abi-proto/build.sh
# 依赖：wat2wasm (wabt) + cc + build/deps/wamr/libiwasm.a
```
