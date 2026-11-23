# qzvm / qzjs 分层设计（Layering）

> 状态：架构级 DESIGN（active）
> 日期：2026-10-14
> 范围：界定「宿主 / qzjs 运行时 / qzvm」三层，并确立 qzvm 的三条硬约束。
> 依据：用户裁决（2026-10-14）；`src/qzvm/` 实况；`docs/architecture/c-js-layering.md`（C/JS 分层，另一维度）；brain `[[qzjs-positioning]]` `[[release-artifact-topology]]`。
> 冲突处置：本文为 qzvm/qzjs 边界的 SSOT。与旧文档（含 `IN_MODULE_DESIGN.md` 初版措辞）冲突时，以本文为准并回改旧文档。

---

## 0. 术语（先定，避免歧义——这是初版设计出错之源）

| 术语 | 定义 | **不含** |
| --- | --- | --- |
| **宿主（host）** | **qzjs 的使用者**：链接 `libqzjs` / 加载 qzjs wasm 的应用——用户 C 程序、node 进程、设备固件 | ❌ libuv、❌ WAMR/wasm3、❌ QuickJS |
| **qzjs 运行时** | qzjs 项目交付的**全部**实现：引擎托管 + IO 原语 + 进程编排 + polyfill + 控制面。**含 libuv、含 wasm 引擎后端** | ❌ 应用业务逻辑 |
| **qzvm** | qzjs 内部的**VM 库**：JS 引擎 + `qz.*` 原语 + 调试核（引擎 hook）+ 扩展注册机制 + wasm 引擎绑定（构建形态而定，见 §3.3） | ❌ libuv、❌ 宿主 IO 编排、❌ DAP 传输层（stdio/timer） |

**关键更正**：libuv 与 wasm 后端是 **qzjs 自己的责任**，不是宿主提供的。初版 `IN_MODULE_DESIGN.md` 说「宿主只剩 libuv + WAMR」「host 不链 QuickJS」，把 qzjs 自身的 C 层误称为"宿主"，并暗示"运行时没有 JS"——概念错误，已废。

---

## 1. 三层结构

```
宿主（使用者：C 程序 / node / 固件）
   │  公开 API：include/qzjs/qzjs.h（qz_create / qz_destroy / qz_post_message /
   │           qz_recv_message / qz_compile / qz_control / qz_wait_idle …）
┌──▼──────────────────────────────────────────────────────┐
│ qzjs 运行时（交付物）                                       │
│   ├─ IO 原语层      uv_io_* / qz_proc_* / qz_ipc_*        │
│   ├─ 事件循环宿主    libuv（loop / thread / 消息队列）       │
│   ├─ 进程/控制面     spawn / DAP attach / control / storage │
│   ├─ polyfill 注入   WinterTC 面 + pal.* 接线                │
│   └─ wasm 引擎后端   WAMR / wasm3（AOT 执行后端）            │
│  ┌──▼────────────────────────────────────────────────┐   │
│  │ qzvm（VM 库，独立可用）                              │   │
│  │   引擎(QuickJS-ng) + qz.* 原语 + realm 生命周期      │   │
│  │   + 调试核(引擎 hook) + 扩展注册机制                 │
│  │   ⟂ 零 libuv（硬约束 ①）                            │   │
│  │   ⟂ 可独立使用（硬约束 ②）                           │   │
│  │   ⟂ GC 确定性（硬约束 ③）                            │   │
│  └───────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

**依赖方向单向**：宿主 → qzjs → qzvm。qzvm **不得**反向依赖 qzjs 或 libuv。

---

## 2. qzvm 的三条硬约束

### 约束 ①：qzvm 零 libuv

**含义**：qzvm 的编译单元内，`uv_*` 类型与函数**在编译期不可达**（不是 stub，是可以不存在）。

**根因（已核实）**：`qz_t`（`src/base/qz_core.h:82`）**按值内嵌** `uv_loop_t loop` / `uv_thread_t thread` / `uv_async_t wake` / `uv_timer_t dap_timer`，且 `qz_types.h:26-30` 无条件 `#include <uv.h>`。引擎态与宿主线程/loop **结构混装**是 libuv 泄漏的唯一根因。

**残留清单（qzvm 内触 libuv 处）**：

| 文件 | `uv_` 处数 | 性质 | 处置 |
| --- | --- | --- | --- |
| `debugger_dap.c` | 10 | `dap_timer`（`uv_timer_*`）驱动 DAP 轮询 | **整文件移出 qzvm** → host（见下） |
| `vm_core.c` | 1 | 注释 | 无 |
| 其余 qzvm 源 | 0 | — | — |

→ **唯一实质残留是 DAP 传输层**。裁决（2026-10-14 二次收窄 + 第一性收束）：

**DAP 不是需求，是协议载体。** 真实需求 = ① 位置映射（执行点 ↔ 源码 file:line）② 停止控制（断点/单步/暂停）③ 状态检查（栈帧/变量/eval）。**stdio / timer / poll / Content-Length 帧全是载体，且全是 OS 依赖**——既然 timer 是 OS 依赖被逐出 qzvm，同一逻辑必然把 **stdio 也逐出**：不是"搬 timer"，是**整条传输层出 qzvm**。

二分现状（已核实）：

| 单元 | 内容 | OS 依赖 | 引擎依赖 |
| --- | --- | --- | --- |
| `qzvm/debugger.c` | `qz_debug_*`：断点表/步进/暂停，回调驱动 | **零**（仅 `snprintf`） | **强绑 QuickJS**（qzjs 打的 debugger patch） |
| `qzvm/debugger_dap.c` | DAP 协议 + stdin/stdout + poll + `uv_timer` | **全是** | 无 |

**处置**：

- **qzvm 只留 `debugger.c`**（回调驱动、零 OS；in-module 下引擎在 guest 内，调试核也可进 guest）。
- **`debugger_dap.c` 整体归 host（qzjs）**——stdio 与 timer 同为 OS 依赖，**不拆**。
- `qz_t.dap_timer`/`dap_timer_active` 字段随传输层移出 qzvm 核心。
- DAP 仅 `#ifdef QZ_DEBUG_SUPPORT`（debug 编译模式）存在。

**AOT 执行形态（跑 WAMR）的调试**：**没有** QuickJS 调试 hook，TS 行号编译时丢失 → `qz_debug_*` **完全不适用**。调试信息是**需求驱动的产物契约**（同 AOT import 面原则）——编译器（通用工具）把位置映射编进 wasm 标准 **DWARF** custom section（`.debug_line`/`.debug_info`），任何支持 DWARF 的 wasm 引擎 + 任何 DAP 前端即可调试，**不绑 qzjs**。AOT 调试**不经过 qzvm**，是编译器 + 标准 wasm 工具链的问题。详见 brain `[[debugging-layering]]`。

**原则**：qzvm 只持有 **CPU/内存**（可跨任何宿主）；**一切 OS 能力（timer、文件、网络、线程、进程、stdio）由宿主注入或驱动**。debug 形态不豁免。

### 约束 ②：qzvm 可独立使用

**含义**：qzvm 能脱离 qzjs（无 polyfill、无 IO 编排、无控制面）被第三方 C 程序直接使用——建 runtime、跑脚本、取 tick。

**现状缺口（已核实）**：qzvm **不是独立构建单元**——`src/qzvm/CMakeLists.txt` 把 `QZVM_SOURCES` 交回顶层，并入 `libqzjs`（避免循环链接）。无独立 `libqzvm` target、无独立公开头。

**需补**：
1. 独立构建单元 `libqzvm`（native 形态），qzjs 链接它。
2. 独立公开头（VM 层 API：建/拆 realm、eval/compile、tick、扩展注册）——**与 `qzjs.h` 分离**。
3. 卸载所有对 qzjs 的隐式依赖：扩展注册内容、polyfill 注入、pal 接线（这些属 qzjs，见 §3.2）。

### 约束 ③：qzvm GC 确定性（用户裁决 2026-10-15）

**含义**：给定相同输入与相同显式驱动序列，qzvm 的 GC 行为（**何时触发、回收什么、暂停多久**）必须可复现——同一脚本跑两遍，内存轨迹与 GC 触发点一致。这是嵌入式/边缘目标的**确定性护城河**在 qzvm 内的落点。

**为什么落在 qzvm 而非 qzjs 的 C 层**：确定性曾以「宿主主导权（C 层可脱离 JS 独立跑）」之名记在 C/JS 分层约束①（`docs/architecture/c-js-layering.md` §1.2）。该表述**已废**——qzjs 永远持有 JS 引擎（见 §4），context 创建**必经** polyfill 注入（`ctx_orchestrate.c:66` 失败即 `goto fail`）。故"确定性"不能靠"C 不带 JS"获得，只能作为**引擎（qzvm）自身**的属性要求。

**现状缺口（已核实，`deps/quickjs-ng/quickjs.c`）**：

1. ✅ **随机源时钟播种（已解决，见「落地状态」④）**：原先 `random_state = js__gettimeofday_us()`（`:2942`，附上游 `TODO use getrandom()`），`hash_seed` 由它派生（`:2946`）→ `Math.random()`（`:49550`）与对象属性枚举序（`hash_seed` 参与 hash）逐次运行不同。现由 `qz_config_t.random_seed` + 引擎 patch 的 `JS_SetRandomSeed` 注入。
2. ✅ **GC 触发依分配压力（已解决，见「落地状态」①）**：阈值初值 `malloc_gc_threshold = 256*1024`（`:2343`），`js_trigger_gc`（`:1689`）在 `malloc_size > threshold` 时 `JS_RunGC` 并把阈值抬到 1.5×。→ 默认关掉这条路径（`JS_SetGCThreshold((size_t)-1)`），环改在宿主显式驱动点回收。
3. ✅ **确定性控制面（已补齐）**：`qz_config_t` 现有 `gc_threshold`/`random_seed`/`memory_limit` 三个字段（见「落地状态」①/④/⑤）。引擎公有面本无种子 API（`quickjs.h` 只导出 `JS_SetGCThreshold`/`JS_GetGCThreshold`/`JS_RunGC`/`JS_SetMemoryLimit`），故 `JS_SetRandomSeed` 由引擎 patch 提供——**这正是「须走 patch」的判据落点**。

**落地状态**：
1. ✅ **显式 GC 驱动点（已完成 2026-10-15）**：默认（`qz_config_t.gc_threshold == 0`）**关掉阈值隐式 GC**（`JS_SetGCThreshold(rt, (size_t)-1)`），环只在两个确定点回收——宿主 `qz_gc()` 或控制面 `{"op":"gc"}`。两处都落 **WAKE_SAFEPOINT**（`rt_main.c` child_wake_cb / `thread.c` qz_wake_cb 的 `QZ_MSG_FLAG_GC_RUN` 分支）就地 `JS_RunGC`，位置与时机由宿主驱动序列唯一决定。跨进程（ISOLATED）形式：宿主发 CONTROL `{"qzjs":1,"gc":1}` → 主RT 读回调转 msgq（**不经控制面路由**，故与 `control_plane` 档位正交，OFF 档下仍生效）。`gc_threshold > 0` 保留阈值路径作安全网（显式选择即接受非确定触发点）。
2. ✅ **接线阈值 API**：`JS_SetGCThreshold` 从 `qz_config_t.gc_threshold` 透传（`qzjs.c` runtime_init）；ISOLATED 下经 `rt_host.c` 的 `--gc-threshold` argv 传给主RT 子进程（否则宿主经 config 设的值静默失效，同 debug 那一路的缺口）。
3. ✅ **可观测性**：控制面 `"gc"` op 回执带 `reclaimed_bytes`/`heap_bytes`（`control.c` ctl_gc：`JS_ComputeMemoryUsage` 差值）；`metrics` op 已有 `heap_bytes`。宿主要校验复现性可对比同一驱动序列下的前后堆值。
4. ✅ **种子注入（已完成 2026-10-15，须打引擎 patch）**：quickjs-ng 公有面无 seed API，故新增引擎 patch `src/qzvm/patches/engine-seed.patch`（`src/qzvm/patches/*` 与 DAP/bc-reader 同套路；CMake 在 `QZVM_PATCHES` 里排 #3，上下文依赖前两者）：`struct JSRuntime` 加 `random_seed` 字段 + 导出 `JS_SetRandomSeed(rt, uint64_t)`；`JS_NewContextRaw` 里 `random_seed != 0` 则用它作 `ctx->random_state`（`hash_seed` 随之派生），否则维持上游时钟播种。`qz_config_t` 尾加 `random_seed`（0 = 时钟，兼容旧行为）+ `QZ_ABI_VERSION` 1→2。宿主链：`qz_runtime_init` 在建 context **之前**调 `JS_SetRandomSeed`；ISOLATED 下经 `rt_host.c` 的 `--seed` argv 传给主RT（否则静默失效，同 gc/debug 那一路的缺口）；worker 是独立 `qz_t`（config 清零），按槽位派生 `parent_seed + slot + 1`——不继承则 worker 的随机流不可复现，属**部分**确定。CLI：`qzjs --seed=<u64>`。守门：`test/test_qzjs_gtest.cpp` 的 `qz_config.random_seed_makes_math_random_reproducible`（同/异种子，THREAD 直传）+ `test/test_seed_determinism_e2e.sh`（**ISOLATED 跨进程 argv 链**，含负控）。实测：`--seed=12345` 两跑 `Math.random()` 序列逐位相同、`--seed=99999` 不同、无 `--seed` 两次不同。
5. ✅ **接线硬上限 API（已完成 2026-10-15）**：`JS_SetMemoryLimit` 从 `qz_config_t.memory_limit` 透传（`qzjs.c` runtime_init）；ISOLATED 下经 `rt_host.c` 的 `--memory-limit` argv 传给主RT 子进程。与 `gc_threshold` 正交：阈值是「惰性触发点」，硬上限是分配直接失败。**超限错误是 uncatchable**（quickjs-ng `is_uncatchable_error`，与栈溢出同类）——脚本 try/catch 捕不到，异常径直穿到 `qz_dispatch_message` 的 `JS_Call`。**入站派发不再静默吞**：`qz_dispatch_message` 在 `JS_Call` 后检测 `JS_IsException` → 取异常的 `toString()` → 投递 `{"type":"error","error":"dispatch-failed","detail":"..."}` 错误帧到宿主邮箱（bad-json 先例）；OOM 双重失败（envelope 对象建不起来）退静态 `{"type":"error","error":"out-of-memory"}` 帧。worker 继承父的同一绝对值（每 runtime 各自的上限）。
6. ✅ **GC 驱动计数/暂停时长（已完成 2026-10-15）**：所有显式驱动点收口到唯一入口 `qz_gc_drive()`（`qzjs.c`，JS_RunGC + 记账），三个调用点——`rt_main.c child_wake_cb`（`qz_gc()` 的 msgq GC_RUN 落点）/ `thread.c qz_wake_cb` / 控制面 `ctl_gc`——都走它。计数挂在 `rt->gc_runs/gc_last_us/gc_total_us`（host-only），`"gc"` op 回执与 `metrics` op 都带这三个字段。**语义边界**：`gc_runs` **只计显式驱动**，引擎自发的隐式 GC（`gc_threshold > 0` / OOM 路径）不经 `qz_gc_drive`，所以它**不是**「引擎有没有偷偷 GC」的检测器（要检那个得加引擎侧 GC hook）；它的真实用处是跨进程核对（宿主驱动 N 次 → RT 实际执行几次，驱动在途丢失会露出来）。暂停时长是 wall-clock 诊断量，不参与复现性断言。

**实测（2026-10-15，`build-dbg` ISOLATED + `build-thread` THREAD）**：控制面造 3000 个自引用环 → `heap_bytes` 809KB→13.67MB → `{"op":"gc"}` 回 `reclaimed_bytes:12864088` → `heap_bytes` 回落 809KB；宿主 `qz_gc(rt)` 返回 0 且主RT 子进程 RSS 26084→5448 kB（`qz_gc(NULL)` = -1）。默认档无宿主驱动时堆稳定在 13.67MB 不回落（隐式 GC 确已关闭），对照组由此确认。
**随机源实测（2026-10-15，`build-dbg` ISOLATED）**：`qzjs --seed=12345 <script>` 连跑两遍，`Math.random()` 8 连序列**逐位相同**；`--seed=99999` 序列不同；不带 `--seed` 两次不同（缺省仍时钟播种）。e2e 另含负控：把 `rt_host.c` 的 `--seed` argv 透传临时断掉 → 同种子两跑立刻不同（证明该 e2e 真的在守这条链，不是恒绿）。
**GC 计数实测（2026-10-15，`build-dbg` ISOLATED）**：空脚本 rt（`--control-plane=local`）连发 `metrics` → `{"op":"gc"}`×2 → `metrics`：`gc_runs` 0→1→2，`gc_last_us` 160/155，`gc_total_us` 160→315（=160+155），metrics 与 gc 回执同源一致。gtest `control_.gc_counters_track_explicit_drives` 另验证 `qz_gc()`（C API，msgq GC_RUN 路径）同样过账，三条显式驱动路径计数无洞。

**边界**：确定性是 qzvm 的**机制**（引擎内可否复现）；「用不用、播什么种子」是宿主 **policy**（`qz_config_t` 注入）。与 `[[c-js-layering]]` 同款分工。

---

## 3. 边界归属

### 3.1 qzvm 包含（用户裁决）

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| JS 引擎 | QuickJS-ng（子模块） | 无引擎无 JS |
| realm 生命周期 + eval/compile + tick | `context.c` `vm_core.c` `ext_lifecycle.c` | 内核 |
| `qz.*` 原语 | `src/qzvm/aot/qzvm.js`（AOT runtime）+ `emitter.js`/`wasm-encoder.js` | AOT 值原语（f64 NaN-box；i64/BigInt 跨界），编译产物 import 的表面 |
| 调试核 | `debugger.c`（1145 行，`qz_debug_*`） | **引擎调试能力**：断点/步进/暂停，回调驱动，零 OS，强绑 QuickJS 引擎 hook |
| 扩展注册**机制** | `ext_lifecycle.c` + `qz_ext_registry.h` | 遍历常表调钩子 = 机制 |
| 引擎 patches | `src/qzvm/patches/*.patch`（DAP debugger + bc-reader 加固） | 对 QuickJS-ng 的改动，随 VM 绑定 |
| wasm 引擎绑定 | `ext_wamr.c`（2083 行）`ext_wasm3.c`（2170 行） | **构建形态而定**，见 §3.3 |

### 3.2 qzjs 包含（不在 qzvm）

| 内容 | 位置 | 为何不属 qzvm |
| --- | --- | --- |
| palette 接线（`js_pal_*` 43 个） | `host/bridge.c` | 收 `JSValue` 的包装；**服务宿主 IO**，属 qzjs 边界 |
| polyfill 注入 | `host/polyfill_load.c` | 宿主加载器 + WinterTC bundle |
| Web API 扩展内容 | `src/ext/ext_compress.c` `ext_crypto.c` `ext_textcodec.c` | **Web API 能力**（CompressionStream/SubtleCrypto/TextCodec），非 VM 能力——经注册机制装入，但**内容不属 qzvm** |
| IO 原语 | `io/uv_io.c` | OS 能力 |
| 进程编排 | `host/worker.c` `ctx_orchestrate.c` | 宿主边界 |
| 控制面 / DAP 传输层 | `control/control.c` `host/qzjs.c` `debugger_dap.c` | 宿主基础设施；**stdio + timer 皆 OS 依赖**，见约束① |
| libuv 事件循环 | `host/thread.c` | 宿主线程/loop |

**更正 §2.2 旧说法**：旧文档称「`ext_*` 零 uv，可无痛进 guest」——**错**。它们不在 qzvm，且是 Web API 能力，不应混入 VM 内核。它们通过 `qz_ext_registry` **注册机制**（属 qzvm）被装入。

### 3.3 构建形态 × wasm 引擎绑定

用户裁决：**in-module profile 下 qzvm 不含 wasm**。

| 形态 | wasm 引擎绑定（`ext_wamr`/`ext_wasm3`） | 理由 |
| --- | --- | --- |
| native（standard/minimal） | **含** | AOT 后端：qzjs 需在 native 侧执行 wasm 产物 |
| **in-module** | **不含** | qzvm 自身即 wasm（`libqzvm.wasm`）；宿主已在 wasm 外，无法再嵌 wasm 引擎 |

即 `QZ_PROFILE=in-module` 时 `QZ_WITH_WAMR=QZ_WITH_WASM3=OFF`（已在 `CMakeLists.txt:43-48` 落地），且 `ext_wamr.c`/`ext_wasm3.c` **不进 guest 源集**。

---

## 4. in-module 档的正确定性

**in-module = 把 qzvm 编成 wasm32 模块（`libqzvm.wasm`）的 qzjs 构建形态。**

**关键更正**：in-module **不是**「qzjs 与外部宿主分层」，而是 **qzjs 内部两半的分层**：

```
qzjs 运行时
  ├─ wasm 外的 C 层：libuv 事件循环 + IO 原语 + 控制面 + 进程编排
  │                  （qzjs 的 native 部分，仍是 qzjs 的责任）
  └─ wasm 内的 qzvm：引擎 + qz.*（无 wasm 引擎，无 libuv，无 DAP 传输层）
```

**DAP 不在 in-module 的 wasm 内**（已核实）：guest 源集 = `context.c`/`vm_core.c`/`ext_lifecycle.c`/`guest_entry.c` 四源，**不含 `debugger.c`/`debugger_dap.c`**；且 `QZ_BUILD_DEBUGGER` 默认 OFF。故 in-module 形态（乃至 native 缺省）**无调试能力**——调试核 `debugger.c` 零 OS、本可进 guest，属待补（§6 待办 #6）。

- qzjs **仍持有 JS 运行时**——就是那块 `libqzvm.wasm`。运行时必然有 JS 引擎，永不"没有 JS"。
- wasm 外的 C 层**不直接**持 `JSContext`（JSContext 在 wasm 内），但它通过 `libqzvm.wasm` 的导出驱动 JS——JS 运行时**属于**这个进程。
- 分界桥：wasm 外的原生 IO 完成 → `qz_host.*` import → wasm 内 qzvm 的 `qz_tick` 拉取 → `JS_Call` resolve（回流模型）。

---

## 5. 与其它文档的关系

| 文档 | 维度 | 关系 |
| --- | --- | --- |
| `docs/architecture/c-js-layering.md` | **C vs JS**（哪些进 C、哪些进 JS） | 正交；本文管 **qzvm vs qzjs**（都在 C 侧） |
| `src/qzvm/aot/IN_MODULE_DESIGN.md` | in-module 构建细节 | 本文是其**基础框架**；旧措辞须按本文回改 |
| `docs/qwrt-architecture-design.md` | 旧 PAL 架构 | **已废弃**（2026-08-12 libuv-native 迁移后） |
| brain `[[release-artifact-topology]]` | 发行产物拓扑 | 本文是「qzvm 独立可库」的基础 |

---

## 6. 待办（由本文派生）

1. **DAP 传输层出 qzvm**（约束①唯一实质残留）：`debugger_dap.c` → `src/host/`；qzvm 只留 `debugger.c`；`qz_t.dap_timer*` 随传输层移出核心。
2. **立独立 qzvm 构建单元**（约束②）：`libqzvm` target + 独立公开头。
3. **回改旧文档**（已做）：`IN_MODULE_DESIGN.md` 术语/标题/§2.2/§10.5；brain `in-module-design` 增 reversal。
4. **qz_t 结构切分**：核心字段（magic/jsrt/config/contexts）与宿主字段（loop/thread/msgq/proc/ctl）分离，使 uv 类型对 qzvm 编译期不可达。
5. **AOT 调试能力（已落地，2026-10-15）**：① 编译器侧——emitter 产 wasm **DWARF** 行表（`.debug_abbrev/.debug_info/.debug_line/.debug_str`，`aot/wasm-dwarf.js`，`--debug` 同时开 name 段）。② 消费侧——WAMR 启用 `WASM_ENABLE_DEBUG_INTERP`（GDB RSP，CMake `QZ_WITH_WAMR_DEBUG_INTERP`，默认 OFF）。**DWARF 消费方是打了 `lldb_wasm.patch` 的定制 lldb，不是 WAMR**——debug-engine 全库无 DWARF 解析器，只报 wasm 偏移 PC。纯 qzvm 调试核（`qz_debug_*`）对 AOT **完全不适用**。编译器侧是通用工具职责，非 qzvm 职责。详见 brain `[[debugging-layering]]`。
6. **in-module 调试核**：guest 源集（context/vm_core/ext_lifecycle/guest_entry）**不含 `debugger.c`** → in-module 形态无任何调试能力；调试核零 OS，本可进 guest。
7. **wasm 执行侧调试**（qzjs 跑 wasm 时调试谁）：qzjs 有**三个**可执行体——native QuickJS、guest 内 QuickJS（in-module）、WAMR **wasm 模块**（AOT/interp）。三者调试通道**互不通用**：
   - **guest 内 JS**（in-module，调试对象=wasm 里的 JS）：**唯一可行**通道 = 调试核进 guest 源集 + 命令经 `qz_host.*` import 面回流到 host 接 DAP（与现有 `qz_host_drain` 回流同构）。**不可**用 WAMR debug-interp——那调试的是 wasm **指令**，不是 guest 内的 JS。
   - **wasm 模块本身**（TS→wasm，调试对象=wasm 指令）：WAMR `WASM_ENABLE_DEBUG_INTERP`（debug-engine/gdbserver，GDB RSP）——CMake `QZ_WITH_WAMR_DEBUG_INTERP`（默认 OFF）已接通；debug-engine **不解 DWARF**（全库无解析器，只报 PC 偏移），行映射由编译器产 DWARF、由定制 lldb 消费。
   - **native 内 JS**：走 `debugger.c` + DAP（现状）。
8. **AOT 不可源码级调试**：WAMR `WASM_ENABLE_DEBUG_AOT`（`aot/debug/jit_debug.c`）**只产 jitdump/perf map**（`perf record` 用），**无行表、无源码映射** → **AOT 执行形态**不可步进。源码级调试须走 **bytecode/interp 形态** + 上面 #5 的 DWARF 段 + debug-interp（AOT 实例被 WAMR 直接拒绝绑调试实例）。
9. **GC 确定性落地（约束③派生，全部完成）**：① 随机种子注入 ✅（引擎 patch `engine-seed.patch` + `qz_config_t.random_seed` + `QZ_ABI_VERSION` 2 + 宿主 argv/CLI 接线 + worker 派生）、② 显式 GC 驱动点 ✅、③ 接线 `JS_SetGCThreshold` ✅、④ 可观测（`reclaimed_bytes`/`heap_bytes`）✅、⑤ 接线 `JS_SetMemoryLimit` ✅（`qz_config_t.memory_limit` + `rt_host` argv + worker 继承 + e2e `test/test_mem_limit_e2e.sh`，`QZ_ABI_VERSION` 2→3）、⑥ GC 驱动计数/暂停时长 ✅（唯一入口 `qz_gc_drive` 收口三处调用点；`rt->gc_runs/gc_last_us/gc_total_us` 经 `"gc"` op 回执与 `metrics` 暴露）—— 详见 §2 约束③「落地状态」。**附带发现（已修）**：引擎 OOM 是 uncatchable error（脚本捕不到），此前 `qz_js_call_cleanup` 会静默吞掉入站派发里未处理的异常 → 超限时宿主只见超时。现 `qz_dispatch_message` 在 `JS_Call` 后检测 `JS_IsException` → 投递 `{"type":"error","error":"dispatch-failed","detail":"..."}` 帧（OOM 双重失败退静态 `out-of-memory` 帧）。
