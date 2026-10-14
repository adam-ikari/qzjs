---
id: qzvm-qzjs-layering
title: "qzvm / qzjs 分层：宿主定义、qzvm 两条硬约束、in-module 定位"
category: decision
status: active
tags: [decision, architecture, qzvm, in-module, boundary]
created: "2026-10-14T06:35:48"
updated: "2026-10-14T06:46:20"
---

<!-- compiled_truth -->
## 结论

qzjs 分三层，**依赖单向**：宿主 → qzjs 运行时 → qzvm。

| 层 | 定义 | 不含 |
| --- | --- | --- |
| **宿主** | qzjs 的**使用者**：用户 C 程序 / node / 固件 | libuv、WAMR/wasm3、QuickJS（那些是 qzjs 的责任） |
| **qzjs 运行时** | qzjs 交付的**全部**实现：IO 原语(uv_io_*)、libuv 事件循环、进程/控制面、polyfill、wasm 引擎后端 | 应用业务逻辑 |
| **qzvm** | qzjs 内的 **VM 库**（独立可用）：QuickJS-ng 引擎 + `qz.*` 原语 + realm 生命周期 + DAP 调试器 + 扩展注册机制 + 引擎 patches | libuv、宿主 IO 编排、Web API 扩展内容 |

## qzvm 两条硬约束

1. **零 libuv**：`uv_*` 在 qzvm 编译期不可达（非 stub）。唯一实质残留 = `debugger_dap.c` 的 `uv_timer_t dap_timer`（10 处）→ 须改**注入式定时源**。根因：`qz_t`（`qz_core.h:82`）值内嵌 `uv_loop_t/thread/wake` + `qz_types.h:26-30` 无条件 `#include <uv.h>`。
2. **可独立使用**：脱离 qzjs 被第三方 C 直接使用。现状缺口：qzvm **非独立构建单元**（`QZVM_SOURCES` 并入 `libqzjs`，避循环链接），无独立 target/公开头。需补 `libqzvm` target + 独立 VM 头。

## 边界归属

- **属 qzvm**：引擎、realm/eval/compile/tick（context.c/vm_core.c/ext_lifecycle.c）、`qz.*`（`src/qzvm/aot/qzvm.js`）、DAP（debugger.c/debugger_dap.c）、扩展注册**机制**、引擎 patches（`src/qzvm/patches/*`）、wasm 引擎绑定（ext_wamr/ext_wasm3，**仅 native 形态**）。
- **属 qzjs**：pal 接线（bridge.c 43 个 `js_pal_*`）、polyfill 注入、Web API 扩展**内容**（`src/ext/ext_compress|crypto|textcodec`）、IO 原语（uv_io.c）、进程编排、控制面、libuv 循环。

## in-module 正确定性

**in-module = 把 qzvm 编成 wasm32 模块（`libqzvm.wasm`）的 qzjs 构建形态**，是 **qzjs 内部两半**的分层（wasm 外 qzjs-native IO 层 ↔ wasm 内 qzvm），**不是** qzjs 与外部分层。

- qzjs **永远持有 JS 运行时**（即 libqzvm.wasm 内引擎），永不"没有 JS"。"宿主不再链 QuickJS"是初版措辞错误。
- **in-module 下 qzvm 不含 wasm 引擎绑定**（`ext_wamr/ext_wasm3` 不进 guest；`CMakeLists.txt:43-48` 已落 `QZ_WITH_WAMR=WASM3=OFF`）——qzvm 自身即 wasm，无法再嵌引擎。


## Timeline

- time: 2026-10-14T06:35:48
  kind: decision
  summary: "Created this page: qzvm / qzjs 分层：宿主定义、qzvm 两条硬约束、in-module 定位"
  source: docs/architecture/qzvm-qzjs-layering.md
  affects: [qzvm-qzjs-layering]

- time: 2026-10-14T06:36:16
  kind: decision
  summary: "立 qzvm/qzjs 边界 SSOT：术语 + 两硬约束 + in-module 正确定性"
  source: docs/architecture/qzvm-qzjs-layering.md
  affects: [qzvm-qzjs-layering]

- time: 2026-10-14T06:46:20
  kind: decision
  summary: "二次收窄：timer 是 OS 依赖，qzvm 一律不得持有。DAP（debug 编译形态）属 qzvm 但只用非阻塞 qz_dap_service()；周期轮询 timer 归宿主 host/thread.c 驱动；qz_t.dap_timer/dap_timer_active 移出 qzvm 核心。原则：qzvm 只持 CPU/内存，一切 OS 能力（timer/文件/网络/线程/进程）由宿主注入或驱动，debug 形态不豁免。"
  source: "用户裁定 2026-10-14"
  affects: [qzvm-qzjs-layering]
