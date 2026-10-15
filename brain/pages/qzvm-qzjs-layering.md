---
id: qzvm-qzjs-layering
title: "qzvm / qzjs 分层：宿主定义、qzvm 两条硬约束、in-module 定位"
category: decision
status: active
tags: [decision, architecture, qzvm, in-module, boundary]
created: "2026-10-14T06:35:48"
updated: "2026-10-15T07:54:08"
---

<!-- compiled_truth -->
## 结论

qzjs 分三层，**依赖单向**：宿主 → qzjs 运行时 → qzvm。

| 层 | 定义 | 不含 |
| --- | --- | --- |
| **宿主** | qzjs 的**使用者**：用户 C 程序 / node / 固件 | libuv、WAMR/wasm3、QuickJS（那些是 qzjs 的责任） |
| **qzjs 运行时** | qzjs 交付的**全部**实现：IO 原语(uv_io_*)、libuv 事件循环、进程/控制面、polyfill、wasm 引擎后端 | 应用业务逻辑 |
| **qzvm** | qzjs 内的 **VM 库**（独立可用）：QuickJS-ng 引擎 + `qz.*` 原语 + realm 生命周期 + DAP 调试器 + 扩展注册机制 + 引擎 patches | libuv、宿主 IO 编排、Web API 扩展内容 |

## qzvm 三条硬约束

1. **零 libuv**：`uv_*` 在 qzvm 编译期不可达（非 stub）。唯一实质残留 = `debugger_dap.c` 的 `uv_timer_t dap_timer`（10 处）→ 须改**注入式定时源**。根因：`qz_t`（`qz_core.h:82`）值内嵌 `uv_loop_t/thread/wake` + `qz_types.h:26-30` 无条件 `#include <uv.h>`。
2. **可独立使用**：脱离 qzjs 被第三方 C 直接使用。现状缺口：qzvm **非独立构建单元**（`QZVM_SOURCES` 并入 `libqzjs`，避循环链接），无独立 target/公开头。需补 `libqzvm` target + 独立 VM 头。

3. **GC 确定性（硬约束 ③，用户裁决 2026-10-15）**：相同输入 + 相同显式驱动序列 → GC 行为（何时触发/回收什么）可复现。**已落地**：默认 `qz_config_t.gc_threshold == 0` 关掉引擎阈值隐式 GC（`JS_SetGCThreshold(rt, (size_t)-1)`），环只在两个确定点回收——C API `qz_gc(rt)` 或控制面 `{"op":"gc"}`，两者都落事件循环 WAKE_SAFEPOINT 就地 `JS_RunGC`（`rt_main.c` child_wake_cb / `thread.c` qz_wake_cb 的 `QZ_MSG_FLAG_GC_RUN` 分支）。 **随机源种子（2026-10-15 补齐）**：新增引擎 patch `src/qzvm/patches/engine-seed.patch` 导出 `JS_SetRandomSeed(rt, uint64_t)`（quickjs-ng 公有面无此 API）+ `struct JSRuntime.random_seed` 字段；`qz_config_t` 尾追加 `random_seed`（0 = 时钟播种，兼容旧行为）+ **`QZ_ABI_VERSION` 1→2**。`qz_runtime_init` 在建 context **之前**注入（晚于建 context 无效——`hash_seed` 已派生）。ISOLATED 下经 `rt_host.c` `--seed` argv 过进程边界；worker（独立 qz_t、config 清零）按槽位派生 `parent_seed + slot + 1`。CLI `qzjs --seed=<u64>`。**跨进程缺口与 gc/debug 同型**：不走 argv 就静默失效——e2e `test/test_seed_determinism_e2e.sh` 专守这条链（含负控）。ISOLATED 下驱动形式为 CONTROL `{"qzjs":1,"gc":1}`，**刻意不经控制面路由**（`qz_control_route` 受 `control_plane` 档位门控，OFF 档静默丢）——GC 驱动是内存管理与「暴露不暴露控制面」正交，OFF 档下仍生效。`gc_threshold > 0` = 显式选择阈值安全网（接受非确定触发点），ISOLATED 下由 `rt_host.c` 经 `--gc-threshold` 透传主RT 子进程（否则宿主 config 设的值静默失效）。可观测：控制面 `"gc"` op 回执带 `reclaimed_bytes`/`heap_bytes`；`qz_gc()` 只保证「已入队到确定点」（返回 0）。**实测**：造 3000 自引用环 → heap 809KB→13.67MB → `{"op":"gc"}` 回 `reclaimed_bytes:12864088` → 回落 809KB；`qz_gc(rt)` 后主RT 子进程 RSS 26084→5448 kB；默认档无宿主驱动时堆不回落。**未做**：① 种子注入（quickjs-ng 无公有 `JS_SetRandomSeed`，`random_state = js__gettimeofday_us()` @quickjs.c:2942，`hash_seed` 派生 :2946 → `Math.random()` 与 Map/Set 迭代序仍不确定；须打引擎 patch `src/qzvm/patches/*` + `qz_config_t` 种子字段 + `QZ_ABI_VERSION` 递增）；② GC 触发次数/暂停时长计数；③ `JS_SetMemoryLimit` 透传。

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

- time: 2026-10-15T02:02:50
  kind: decision
  summary: "增硬约束③ qzvm GC 确定性（用户裁决 2026-10-15）+ 回改约束①旧表述：'确定性护城河=宿主主导权/C 可脱离 JS'已废，确定性落在引擎自身。核实 quickjs-ng @c359cac 三处 nondeterminism（random_state 时钟播种 :2942/hash_seed :2946、malloc_gc_threshold 分配压力驱动 :2343/:1689、qz_config_t 无种子字段且引擎无公有种入 API）"
  source: "用户裁定 2026-10-15 + docs/architecture/qzvm-qzjs-layering.md §2 约束③"
  affects: [qzvm-qzjs-layering]

- time: 2026-10-15T02:03:53
  kind: decision
  summary: "修正约束③的种子注入路径：quickjs-ng 公有面无 seed API（无 JS_SetRandomSeed），种子注入须走引擎 patch（src/qzvm/patches/*）；补接线 JS_SetGCThreshold/JS_SetMemoryLimit 待办"
  source: "docs/architecture/qzvm-qzjs-layering.md §2 约束③（用户裁定 2026-10-15）"
  affects: [qzvm-qzjs-layering]

- time: 2026-10-15T03:26:46
  kind: decision
  summary: "GC 确定性约束③落地状态：显式驱动点/阈值接线/可观测已完成（qz_gc + 控制面 gc op；默认关隐式 GC），种子注入仍未做"
  source: "实现 2026-10-15（src/control/control.c ctl_gc / src/host/qzjs.c qz_gc / rt_main.c+thread.c GC_RUN 分割点 / rt_host.c --gc-threshold）"
  affects: [qzvm-qzjs-layering]

- time: 2026-10-15T03:27:29
  kind: decision
  summary: "恢复并扩写 compiled_truth：补回'三条硬约束'全量正文（零 libuv/可独立使用/GC 确定性③）+ 边界归属 + in-module 定位，GC 约束③追加落地状态与未做项"
  source: "实现 2026-10-15"
  affects: [qzvm-qzjs-layering]

- time: 2026-10-15T07:53:58
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [qzvm-qzjs-layering]

- time: 2026-10-15T07:54:08
  kind: decision
  summary: "种子注入落地（约束③ ①）：引擎 patch engine-seed.patch 导出 JS_SetRandomSeed(rt,uint64_t) + JSRuntime.random_seed 字段（quickjs-ng 公有面无 seed API → 必须走 patch）；JS_NewContextRaw 里 seed!=0 用作 ctx->random_state（hash_seed 随之派生），0 维持时钟播种。qz_config_t 尾追加 random_seed + QZ_ABI_VERSION 1→2。宿主链：qz_runtime_init 在建 context 前注入（晚则无效）；ISOLATED 经 rt_host --seed argv 过进程边界（不走 argv = 静默失效，与 gc/debug 同型缺口）；worker（独立 qz_t、config 清零）按槽位派生 parent_seed+slot+1（不继承 = 部分确定；全用父种子 = 各 worker 同序列）。CLI --seed=<u64>。实测 build-dbg ISOLATED：同种子两跑 Math.random 序列逐位相同、异种子不同、无种子两次不同。守门：gtest qz_config.random_seed_makes_math_random_reproducible + 新 e2e test/test_seed_determinism_e2e.sh（跨 ISOLATED 边界，含负控——断开 argv 透传后立刻红）。"
  source: "用户指示：收尾 GC 约束③（种子注入）；handoff Next Steps #3"
  affects: [qzvm-qzjs-layering]
