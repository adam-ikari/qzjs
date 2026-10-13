# in-module 档设计

**状态**：设计定稿，待实现
**范围**：把 qzvm（QuickJS-ng + qz.\* 原语）编到 wasm32 作**模块内 guest** 的构建形态
**方法**：第一性原理推导 guest 真需要什么 + 奥卡姆剃刀取最小产 —— **不追求最小改动**

---

## 1. 问题重述（第一性）

初版设计把问题设成「如何让现有 `QZVM_SOURCES` 三源（741 行）脱离 libuv 照编」，方案是给 uv 打 stub 头。**这是错的**——它默认"现有三源是 guest 的正确单元"，但事实是：

> 三源不是**设计出来的单元**，是 `src/qzvm/` 被切出来时"恰好在那里"的全部代码。它与 guest 的需要**没有对应关系**。

正确的第一性问题：

> **一个内嵌到 wasm 的 JS 引擎模块，运行时最少需要哪些能力？**

## 2. 事实（已核实）

### 2.1 三源职责拆解

`context.c`（拆分后 149 行；拆前 455 行）各函数归属：

| 函数 | 真实职责 | guest 需要？ |
| --- | --- | --- |
| `qz_get_active_ctx/_jsctx/_by_id` | 查询活动 realm | ✅ 内核 |
| `qz_ctx_create` / `qz_ctx_create_at` | 建 realm（JSContext + 注册进 `rt->contexts`）——**纯内核**（边界接线已移出，见下） | ✅ 内核 |
| `qz_ctx_destroy` | 拆 realm（job 排水 + JS_FreeContext + 注销） | ✅ 内核 |
| `qz_ctx_cleanup_resources`（timer 句柄表循环；**已移 `host/ctx_orchestrate.c`**） | 宿主侧 timer 清理 | ❌ 宿主 |
| `qz_ctx_serialize` | realm 状态**写盘** | ❌ 宿主（`bridge.c:2135`） |
| `qz_ctx_rebuild` | 从盘**重建** realm | ❌ 宿主（`bridge.c:2155`） |
| `qz_ctx_destroy_id` | 按 id 拆 | ❌ 宿主（`bridge.c:2172`） |
| `qz_write_file` / `qz_read_file` | 序列化的文件 I/O | ❌ 宿主 |

`vm_core.c`（182 行）：`qz_eval_internal` / `qz_eval_bytecode_internal` / `qz_get_rt_from_ctx` / `qz_get_rt_from_jsrt` / `qz_compile` —— **全部内核**，guest 全要。

`ext_lifecycle.c`（104 行）：`qz_ext_init/destroy_all`（机制内核，调用时点归边界）+ `qz_ext_suspend/resume_all`（仅 suspend/resume 用 = 宿主编排，**零外部调用者**）。

### 2.2 扩展源可无痛进 guest

`ext_compress.c` / `ext_crypto.c` / `ext_textcodec.c` **均零 `uv_` 引用**（仅链 miniz/mbedtls + 字符串）。故「扩展让在 wasm 里跑吗」的答案是**能**——它们是纯计算，无 OS 依赖。裁剪扩展不是 libuv 问题，是**体积/攻击面**取舍。

### 2.3 libuv 依赖的真实形态

| 依赖 | 位置 | 性质 |
| --- | --- | --- |
| `qz_t` 值内嵌 `uv_loop_t loop` / `uv_thread_t thread` / `uv_async_t wake` | `qz_core.h:86-88` | **结构混装**：引擎态与宿主线程/loop 同结构 |
| `qz_t` 内 `qz_msg_t` → `struct uv__queue q` | `qz_core.h:94-102` + `qz_msg.h:35` | 消息队列 = 宿主 IPC，内嵌 uv 队列节点 |
| `qz_core.h:191-310` `#ifndef QZ_USE_MOCK_LIBUV` 块 | `store`/`http_ops`/`proc`/`ipc_channel_pipe`/`dap_timer`/`ctl_*` | 宿主 I/O、进程、控制面 |
| `qz_close_loop`（header inline，调 `uv_loop_close`） | `qz_core.h:330` | 宿主 loop 诊断，**仅宿主源调用**（`qzjs.c:715` 等） |
| `qz_types.h:26-30` 无条件 `#include <uv.h>` | `qz_types.h` | 因 qz_t 内嵌 uv 而被迫 |
| `qz_timer_cancel` 调用 | `context.c:73` | 在 `handle_count` 循环内；guest 无 timer → 恒 0 迭代 |

**根因**：`qz_types.h` 必须 include uv，唯一原因是 `qz_t` **按值内嵌** uv 类型。`test/mock_libuv.h`（280 行，依赖 `<pthread.h>`/`<sys/socket.h>` 等 POSIX）正是为掩盖这点而存在——它让测试能编过，但**语义上是把宿主实现换成一个假实现**，而 guest 根本不要任何实现。

### 2.4 tick 原语已存在

`qz_tick` = `while (JS_ExecutePendingJob(...)) > 0` 的薄封装，**零 libuv**。原定义在 `src/host/thread.c:22`（名 `qz_flush_microtasks`），**M3 已上移 qzvm（`vm_core.c`）**——位置与职责一致。

### 2.5 分层现状

触 libuv 的源：`src/qzvm/` 仅 `debugger_dap.c`（可选）；`src/host/` 6/8；`src/io/` 2/2；`src/ipc/`、`src/control/`、`src/msg/` 各含。宿主公共头 `qzjs.h`（338 行）**已 uv-free**（`qz_t` 不透明）。

---

## 3. 第一性推导：guest 最小能力集

从「内嵌 wasm 的 JS 引擎模块要跑什么」推导，不引用现有文件边界：

| 能力 | 必要性 | 依据 |
| --- | --- | --- |
| 引擎（QuickJS-ng JSRuntime） | **必须** | 无引擎无 JS |
| realm（JSContext + 全局） | **必须** | 脚本要有全局环境 |
| realm 注册（ctx 进 `rt->contexts`） | **必须** | 跑任何 JS 前，闭包需经 `get_ctx_from_jsctx` 反查（`context.c:152-154`） |
| 字节码加载 / eval | **必须** | 执行入口（已有 `qz_eval_bytecode_internal`） |
| microtask pump（tick） | **必须** | promise/microtask 推进 |
| **宿主线程 / loop** | **不要** | libuv 属宿主（已定约束） |
| **消息队列 / IPC** | **不要** | 宿主边界机制，非引擎能力 |
| **进程编排**（spawn/serialize/rebuild/destroy_id） | **不要** | 仅经 pal/bridge 从宿主到达 |
| **文件 I/O** | **不要** | OS 能力，属宿主 |
| **timer 实现** | **不要** | 同 IO，走 pal 回流宿主 |
| **控制面 / DAP / storage** | **不要** | 宿主基础设施 |
| **polyfill 注入** | **不要**（★修正） | 见 §3.1：是宿主边界接线，非引擎能力 |
| **扩展登记（ext init/destroy）** | **机制留、调用时点归边界**（★修正） | 遍历常表调钩子 = 核心机制；但内容依赖注入产生的 `__native__`，故由宿主在接线后调。见 §3.1 |

**结论**：guest 最小集 = **引擎 + realm 生命周期（含注册）+ eval/compile + tick**。粗估 **~300–350 行**（`vm_core.c` 182 全留 + `context.c` 建拆 realm ~105 + `ext_lifecycle.c` init/destroy ~50），而非 741——差额是混进来的**边界接线**（pal/polyfill/ext 登记）+ 宿主编排 + 文件 I/O + timer 缝合。

### 3.1 为什么 polyfill 注入与扩展登记不属核心（第一性）

初稿把「polyfill 注入」列为必需——**错**。注入**动作**虽在 `context.c:160-215`（56 行），但它的每一环都是宿主需求：

| 注入所需 | 位置 | 性质 |
| --- | --- | --- |
| `qz_create_pal_object_ctx` | `bridge.c:2226` | 注册 **48 个** `pal.*`（`timerStart`/`httpRequest`/`fsRead`/`processSpawn`…）——**全是宿主 I/O** |
| `qz_polyfill_load` / `qz_default_polyfill` | `src/host/polyfill_load.c` | 宿主加载器（rodata/compressed/external/host 四模式） |
| polyfill bundle | `src/polyfill/src/*.js` | `var pal = globalThis.__native_inject__` + fetch/fs/console/url…——**pal 之上的宿主 glue** |

即 `context.c:163` 直接调 `bridge.c` 的函数——**这已是分层违规**（qzvm 调宿主）。

注入块四步拆解：

| 步骤 | 属核心？ |
| --- | --- |
| 建 pal object | ❌ 纯宿主（42 个宿主函数） |
| set `__native_inject__` 全局 | ⚠️ 通用机制，但服务于 pal |
| eval bytecode | ✅ 已有 `qz_eval_bytecode_internal`（重复实现） |
| `__native_inject__`→`__native__` 改名 | ❌ 是 polyfill build 约定（`build.js`），非引擎 |

**连带**：`textcodec_ext_init`（`ext_textcodec.c:225`）读全局 `__native__`——由注入产生。故 `qz_ext_init_all` **硬依赖**注入先跑。

→ **注入 + 扩展登记 = 同一件事：宿主边界接线（pal 面）**。两者都从 `qz_ctx_create_at` 移出。

## 4. 奥卡姆裁决

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| **stub uv 头**（初版 M2） | ❌ 否 | 让 guest 编译它**永不执行**的代码（timer 路径、loop 关闭、消息队列）。奥卡姆：不执行的分支也是分支，是缺陷机会 + 攻击面。极简哲学：**删优于加** |
| **复用 mock_libuv 类型部分** | ❌ 否 | mock 是**要真跑的替代实现**（带 pthread/POSIX），in-module 是**不要实现**——语义错配。且拖 POSIX 头 |
| **profile 换 extends 源集** | ⚠️ 半是 | `QZ_PROFILE` 选**标志**对；但 guest 产物是**另一个 artifact**（.wasm，非 libqzjs），源集是**子集**——profile 语义（同源不同 flag）不贴。需独立 target |
| **按能力切分 qz_t / 拆 context.c** | ✅ 采用 | 唯一消除根因（结构混装）的方案。切完 `qz_types.h` 的 uv include 对 guest 变**不可达**，无需 stub |

**裁决**：**终态即起点**——不设「先 stub 过渡、后切分」的两阶段。第一性上没有"过渡"这个物：若要切分，就切；若不切，就不该编那 741 行。两阶段 = 先制造再拆除负债，纯浪费。

## 5. 结构切分设计

### 5.1 qz_t 按能力分块

**事实**：`qz_t` 字段是**交错**的，不是「核心在前、宿主在后」（`qz_core.h:79-311` 实读）：

| 行段 | 字段 | 归属 |
| --- | --- | --- |
| 80-81 | `magic` / `jsrt` | 核心 |
| 86-88 | `uv_loop_t loop` / `uv_thread_t thread` / `uv_async_t wake` | **uv** |
| 94-102 | `msg_head/msg_tail/msg_stub`、`qz_mq_t mq_out`、`out_efd`/`out_claim`/`out_fault` | **uv**（消息队列） |
| 104-148 | `shutting_down`/`wait_idle`/`thread_*`/`config`/`strict_*`/`host_emit`/`debug` | 混合（`config` 核心，其余宿主） |
| 163-165 | `ca_pem*`（TLS） | 宿主 |
| 166-175 | `contexts[]`/`context_count`/`active_ctx_id`/`polyfill*` | 核心 |
| 181-182 | `worker_self`/`workers[]` | 宿主 |
| 184-305 | self_path/storage_relays/proc_handles/proc/ipc/dap_timer/ctl_* | 宿主 |
| 305-310 | `#ifndef QZ_USE_MOCK_LIBUV` 的 `ctl_listener` 块 | **uv** |

故切分**不能整块加 `#ifndef`**，须逐字段归类（或重排为「核心块 + 宿主块」）。示意：

```c
struct qz_t {
    uint32_t magic; JSRuntime *jsrt;
    qz_config_t config;
    qz_ctx_t *contexts[QZ_MAX_CONTEXTS];
    int context_count, active_ctx_id;
    /* polyfill 缓存归宿主（§3.1）；以下全部宿主专属 */
#ifndef QZ_VM_GUEST
    uv_loop_t loop; uv_thread_t thread; uv_async_t wake;
    qz_msg_t *msg_head, *msg_tail, msg_stub; qz_mq_t mq_out; int out_efd;
    qz_proc_t *proc; uv_pipe_t *ipc_channel_pipe;
    uv_io_store_entry_t *store; struct uv_io_http_op_t *http_ops;
    uv_timer_t dap_timer; uv_mutex_t ctl_lock; uv_pipe_t ctl_listener;
    /* …workers/ctl/self_path 等… */
#endif
};
```

`qz_ctx_t` 字段归属（`qz_core.h:17-33`）：

| 字段 | 归属 |
| --- | --- |
| `jsctx` / `context_id` / `extensions` / `extensions_count` | 核心（`extensions` 表是编译期常表，机制核心；登记动作归边界） |
| `polyfill*`（`qz_ctx_t` 上的缓存） | 边界（见 §3.1：内容属宿主） |
| `handles[]` / `timer_resolves[]` / `timer_cbds[]` / `handle_count` | 宿主（timer 句柄表） |
| `suspended`（vestigial，注释明示恒 0） | 可删（奥卡姆） |

**关键**：`qz_types.h:26-30` 的 uv include 移进 `#ifndef QZ_VM_GUEST`（或按 `qz_core.h` 依赖重排）。guest 编译时 uv 类型**完全不可达**——不是 stub，是**不存在**。

### 5.2 context.c 拆分

`qz_ctx_create_at`（`context.c:101-240`）当前混装三件事，按 §3.1 拆开：

| 步骤 | 去向 |
| --- | --- |
| 分配 ctx + 建 JSContext（`:101-127`） | **留内核**（realm 建立） |
| polyfill **装载**（`qz_polyfill_load`，`:129-143`） | **移边界**（内容属宿主，§3.1） |
| ctx 进 `rt->contexts`（注册，`:152-158`） | **留内核**（跑任何 JS 前需注册，供 `get_ctx_from_jsctx` 反查） |
| 建 pal + 装 polyfill + 改名 `__native__`（`:160-213`） | **移边界**（宿主接线） |
| `qz_ext_init_all`（`:228`） | **移边界原语**（机制可留 VM，调用点归宿主，§5.3） |
| 删 `WebAssembly` 全局（`:215-226`） | 引擎裁剪动作，可留内核 |

| 函数 | 去向 |
| --- | --- |
| `qz_ctx_create/_at/_destroy`、`qz_get_active_*` | 留 `context.c`（内核）；`_at` 去掉边界接线 |
| `qz_ctx_spawn/_serialize/_rebuild/_destroy_id` + `qz_read_file`/`qz_write_file` | 移 `host/ctx_orchestrate.c`（宿主编排） |
| `qz_ctx_cleanup_resources` 的 `qz_timer_cancel` 循环 | 宿主侧 timer 清理 |

**附带发现（奥卡姆）**：`qz_inject_polyfill_ctx`（`bridge.c:2334`）**零调用者**（仅 `qz_rt.h:110` 声明）——是注入逻辑的重复实现（`qz_ctx_create_at` 内联了同一套）。拆分时**删**，不搬。

`ext_lifecycle.c`：`qz_ext_suspend_all`/`qz_ext_resume_all` 无外部调用者 → 随 suspend 机制归宿主或删除（奥卡姆：无消费者的保留 = 负债，需单独裁决）。

### 5.3 内部接口（VM ↔ 宿主）

切分后，宿主源（`qzjs.c`/`thread.c`/`bridge.c`）需要调用 VM 的一小组符号。这**就是**内部接口——**不是"没有接口"**，是一个**极小的内部契约**（初版此处措辞有误）：

| 宿主需要 | VM 提供 |
| --- | --- |
| 建/拆 realm | `qz_ctx_create` / `qz_ctx_destroy`（**内核**：建 JSContext + 注册；不含边界接线） |
| 取活动 ctx | `qz_get_active_*` |
| 推 microtask | `qz_tick`（M3 ✅ 已从 `qz_flush_microtasks` 上移入 `vm_core.c`） |
| eval/compile | `qz_eval_internal` / `qz_compile` |

**边界接线不在此接口内**（§3.1）：建 pal、装 polyfill、`qz_ext_init_*` 在 VM 建完 realm 后运行。**native 形态**下由宿主源调（C 直调）；**in-module 形态**下同属 guest（`js_pal_*` 包装留 guest 内，仅其下层 `uv_io_*` 穿 wasm 边界，见 §10.2）。即初始化序列：

```
【native】                          【in-module】
VM:  qz_ctx_create()                guest: qz_ctx_create()
宿主: build_pal(ctx)                guest: build_pal(ctx)
宿主: inject_polyfill(ctx)          guest: inject_polyfill(ctx)
宿主: qz_ext_init_all(ctx)          guest: qz_ext_init_all(ctx)
宿主: qz_tick()                     host : 每轮 libuv iteration 后调 guest qz_tick()
```

分界线的**实质**不是"哪一段在宿主"，是「**收 JSValue 的包装**（§10.2 的 `js_pal_*`）必须在 guest 内——因为 JSValue 只存在于 guest 的 QuickJS 堆」。native 下 guest==宿主进程，故看起来"宿主调"；in-module 下二者分属 wasm 内外，`js_pal_*` 必须随 QuickJS 留在 wasm 内。

因是**单一 wasm 产物的内部实现**，此接口无 ABI 承诺（宿主 native 形态直接 C 调；guest 形态是模块内部调用）——brain 结论成立，且正因为无承诺，把它**设计紧**是零代价的。

### 5.4 tick 拉模型

`qz_tick(qz_t *)` = `while (JS_ExecutePendingJob) > 0`，**已上移到 qzvm（`vm_core.c`，M3 ✅）**，原 `host/thread.c` 的 `qz_flush_microtasks` 删除。宿主每轮 libuv iteration 调它拉模块推进。模块 reactive，不自带 timer/loop/阻塞。调用点已统一：`qzjs.c` teardown（两处内联排空循环）、`thread.c`（`qz_loop_idle` + 消息派发 + 主循环）、`worker.c` 主循环、`rt_main.c` 主循环。

## 6. 构建形态

`QZ_PROFILE=in-module`（已落地 `d365171e`）职责 = **选标志**（引擎 OFF、扩展 OFF 等）。新增职责 = **选源集 + 定 artifact**（M4 ✅ 已落地）：

- 新增 CMake target `qzvm-guest`（`src/qzvm/CMakeLists.txt` 内 `if(QZ_IN_MODULE)`），源集 = 内核三源（`context.c` / `vm_core.c` / `ext_lifecycle.c`）+ `guest_entry.c` + quickjs-ng（`qjs` target）；宿主源/扩展/polyfill 一律不进。
- 输出 `libqzvm.wasm`（导出 `qz_create`/`qz_eval`/`qz_tick`/`qz_destroy` + `memory`/`malloc`/`free`），**非** `libqzjs.so`。`guest_entry.c` 用 `__attribute__((export_name))` 把 `qz_guest_*` C 符号映射到设计导出名（避免与宿主侧 `qz_create`/`qz_destroy` 同名）。
- 宏 `QZ_VM_GUEST` 由该 target 下发（`target_compile_definitions`），驱动 5.1 的条件编译。`QZ_WITH_*` 全 0 → `qz_default_exts` 全 NULL 槽，不引未编入的扩展符号。
- 工具链 `cmake/wasm32.cmake`：clang `-target wasm32-wasi --sysroot`（Debian wasi-libc 或 wasi-sdk），`-nodefaultlibs -lc -lm`（绕 Debian 缺 libgcc），reactor（`-mexec-model=reactor`，无 main）。
- **合并形态裁决（M4 定）**：M4 产出**独立 guest `.wasm`**（`libqzvm.wasm`）。与 AOT emitter 发射的静态 wasm 合并成单模块（wasm-merge / wasm-ld 链接）延后——等 M5 guest 跑通真 JS 后，静态/动态两面同存才可验。M4 的独立产物已满足「同 isolate 同内存」前提（宿主加载单一模块，内存导出共享）。

```mermaid
flowchart TB
  subgraph wasm["libqzvm.wasm（guest 产物）"]
    QJS["QuickJS-ng"]
    CORE["qzvm 内核<br/>引擎/realm 注册/eval/tick"]
    QJS --> CORE
  end
  subgraph host["宿主 qzjs（原生，既有）"]
    LOOP["libuv loop（唯一）"]
    RT["WAMR / WASM3"]
    HOSTF["qzjs.c / bridge.c / thread.c / io / ipc / control"]
    LOOP --> RT --> wasm
    HOSTF --> LOOP
  end
  CORE ==>|"tick() 宿主每轮拉"| LOOP
```

## 7. 里程碑

| # | 里程碑 | 产物 | 验证 |
| --- | --- | --- | --- |
| M1 | qz_t/qz_ctx_t 能力切分 | `qz_core.h` 加 `#ifndef QZ_VM_GUEST` 块；`qz_types.h` uv include 条件化 | **native 全回归绿**（切分不改宿主行为）；`-DQZ_VM_GUEST -fsyntax-only` 内核源 uv 不可达 |
| M2 ✅ | context.c 拆分（含边界接线移出） | §5.2 已落地：`context.c` 只留 realm 内核（`qz_ctx_create/_at/_destroy`）；边界接线 + 编排 → `host/ctx_orchestrate.c`（`qz_ctx_wire_up`/`qz_ctx_create_host`/`qz_ctx_destroy_host`/`qz_ctx_cleanup_resources`/`spawn`/`serialize`/`rebuild`/`destroy_id`）；死码 `qz_inject_polyfill_ctx` 已删 | native 回归绿（context/suspend/composition gtest 全过）；`context.c` 无 pal/polyfill/ext-init 调用 |
| M3 ✅ | tick 上移 | `qz_tick` 已入 qzvm（`vm_core.c`，原 `host/thread.c` 的 `qz_flush_microtasks`）；宿主全部调用点（thread/worker/rt_main 主循环 + qzjs.c teardown 两处内联排空循环）统一改调 `qz_tick` | native 回归绿（32/32 ctest，tick 语义不变）；`qz_tick` 零 libuv，`QZ_VM_GUEST` 下内核三源照编 |
| M4 ✅ | wasm32 工具链 + guest target | `cmake/wasm32.cmake` + `qzvm-guest` target（`src/qzvm/CMakeLists.txt` if QZ_IN_MODULE）+ `src/qzvm/guest_entry.c`（导出面 + qz_host.drain import） | `libqzvm.wasm` 链接成功，导出 `qz_create`/`qz_eval`/`qz_tick`/`qz_destroy` + `memory`/`malloc`/`free`；import 段含 `qz_host.drain`；native 全回归绿（32/32 ctest）；`-DQZ_VM_GUEST -fsyntax-only` 内核源+guest_entry 零 error |
| M5 | guest 跑通（真 JS + 异步） | §10.3 import 面 + §10.4 回流 | 原型已验同步/写回/异步；M5 接真 QuickJS（resolve 持 JSValue）+ tick 驱动（去自旋）|
| M6 | 宿主去 JS 化（in-module 专属） | §10.5：`bridge.c` 的 `js_pal_*` 移 guest；tcp_io/control/worker 去 JSValue；host 不链 QuickJS | host 目标零 `JS_NewRuntime`；AOT/standard 档不受影响 |

**M1–M3 全部在 native 上验证**（切分是纯重构，宿主行为不变）→ 风险最低、最先做。M4–M5 引入 wasm 工具链 + 跨界 ABI 不确定性。M6 是 in-module 真正落地（前 5 步可先跑通 guest 自包含 + 单原语）。

**相比初版**：删除了「stub uv 头」（负债）；把「native 回归」作为每一步的护栏（而非一次 configure）；最小可验证提前到 M1；**新增 M6**——初版没意识到 pal 面跨界问题（§10）。

## 8. 最小配置

```bash
# guest 产物（新 target）
cmake -S . -B build-inmod -DQZ_PROFILE=in-module \
  -DCMAKE_TOOLCHAIN_FILE=cmake/wasm32.cmake
cmake --build build-inmod --target qzvm-guest
```

- 引擎 flag（`QZ_WITH_WAMR/WASM3=OFF`）由 profile 提供（已落地 gate 逃逸）。
- 扩展：默认全 OFF（最小）；如需标准面可逐个开（`ext_*.c` 零 uv，可进 guest）。
- 源集由 target 决定（内核源），**不再依赖 `QZVM_SOURCES` 全表**。

## 9. 风险与未决

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| qz_t 切分面广 | `qz_t` 被 N 个源引用；搬字段需同步改 `rt->field` | M1 靠编译器逐个暴露；每步 native 回归 |
| 边界接线移出的连带 | pal/polyfill/ext 登记移出 `qz_ctx_create_at` 需重排初始化顺序（注册→边界→ext init） | M2 逐步；native 回归 |
| `qz_ctx_create` 内核部仍有 host 导入 | 当前 `context.c` 调 `qz_create_pal_object_ctx`/`qz_polyfill_load`/`qz_timer_cancel`（全 host） | M2 移出后内核部零宿主导入 |
| 工具链选型 | wasi-sdk vs emscripten | 倾向 wasi-sdk（freestanding，贴合自包含）；M4 定 |
| `qz_ext_suspend/resume_all` 无调用者 | 是死码还是待接 | 单独裁决：无消费者则删（奥卡姆）或随 suspend 归宿主 |
| 扩展内容取舍 | 全 OFF 最小，但 guest 的标准面（如 console/URL）依赖 polyfill 非 C 扩展 | M5 定 polyfill 注入的最小集 |
| 跨界 ABI 已验、深化未验 | §10 骨架（同步/写回/异步）由原型验证（`inmod-abi-proto/`）；**guest 侧 JSValue 生命周期 / 内存增长 / AOT 变体 / 多 op 并发**未验 | M5 扩原型：真实 resolve 持 JSValue、memory.grow、wamrc 路径 |
| host 去 JS 化面大（M6） | `bridge.c` 463 / `tcp_io.c` 229 / `control.c` 72 处 JS_ 调用需处置 | M6 独立，前 5 步不依赖；先判定"移 guest vs 去 JS 化"再动 |
| import 面与 AOT `qz.*` 命名冲突 | 两套 import（`qz.*` 值原语 vs `qz_host.*` 宿主能力） | 不同 import module 名隔离（§10.6） |

## 10. 跨界 ABI（★本轮核心：pal 面如何跨 wasm）

> **实测状态**：核心骨架已由原型验证（`inmod-abi-proto/`，`sh build.sh` 一键复现）——guest 经 import 调宿主：**同步**（log）、**回流写回**（宿主值→wasm 内存）、**异步**（宿主线程完成→队列→guest drain）。无 JSValue 跨界。**跨界税实测 ~45 ns/次（空）/ ~66 ns/次（32B 负载）**，比 AOT 的 JS-import 快 ~100x。未覆盖：guest 侧 JSValue 生命周期 / 内存增长 / AOT 变体 / 多 op 并发（留 M5+）。

前 10 节只解决了「guest 编什么」，**没解决 guest 怎么调宿主**。in-module 下 guest 在 wasm 内、宿主在 wasm 外——native 里 `context.c:164` 直调 `qz_create_pal_object_ctx` 的 C 调用**不存在了**。pal 面（实测 **42 个唯一属性 / 43 个唯一 `js_pal_*` 函数**，`qz_create_pal_object_ctx` 内按条件编译分段注册）必须是 **wasm imports**。

### 10.1 天然边界已存在：`uv_io_*`

实测 `src/io/uv_io.c`（4061 行）**零 `JSValue`**（全文件仅 3 处提及，**全在注释**），接口签名纯原语：

```c
void uv_io_http_request(qz_t *rt, const char *url, const char *method,
                        const char *headers, const char *body, size_t body_len,
                        qz_io_done_t cb, void *cb_data);
```

同理 `uv_io_fs_read/write/remove/exists/list`、`uv_io_storage_*`、`qz_proc_*`、`qz_ipc_child_*`。**这就是跨界线**——不在 bridge.c 的 pal 函数（那些收 `JSValue argv`），而在 pal 之下的 `uv_io_*`（纯原语 + 回调）。

### 10.2 三层重排

现状（native）：

```
JS → polyfill.js → pal.log(level, msg)  [bridge.c js_pal_*，收 JSValue]
                        ↓ JS_ToCString / JS_ToInt32
                   uv_io_* / qz_proc_*  [纯原语]
                        ↓ done_cb(cb_data, err, data, len)
                   JS_Call(resolve)      [回 guest JS]
```

in-module 后 **`js_pal_*` 层留在 guest 内**（它只做 argv→原语 marshalling + Promise 装卸），只有 `uv_io_*` 调用穿过边界：

```
guest (wasm):  JS → polyfill.js → js_pal_log (收 JSValue)
                     ↓ 转原语
               __qz_host_log(level: i32, msg_ptr: i32, msg_len: i32)   ← wasm import
════════════════ wasm 边界 ════════════════
host:          __qz_host_log → fprintf / uv_now / uv_hrtime
```

**关键**：`js_pal_*` 的 43 个包装**不跨界**（纯 JS↔原语转换，guest 内做）；跨界的是其下层原语。**连带**：`js_pal_*` 引用的 `JS_NewPromiseCapability`（建 Promise）——Promise 属 guest (QuickJS)，也在 guest 内。故跨界 import 面 **≈ 12 个 `uv_io_*` 原语**，而非 42。

### 10.3 import 面清单（按 uv_io 原语聚类）

| 类 | import | 签名（原语） |
| --- | --- | --- |
| 时间 | `qz_host_now` / `qz_host_hrtime` | `() -> i64` |
| 日志 | `qz_host_log` | `(i32 level, i32 ptr, i32 len)` |
| 随机 | `qz_host_random` | `(i32 ptr, i32 len)` |
| timer | `qz_host_timer_start` / `qz_host_timer_stop` | `(i32 delay_ms, i32 repeat) -> i32 handle` |
| fs | `qz_host_fs_read/write/remove/exists/list` | `(ptr, len…) -> op_id` |
| http | `qz_host_http_request/stream/abort` | `(ptr…, i32 op_id)` |
| storage | `qz_host_storage_get/set/del` | `(ptr…) -> op_id` |
| proc | `qz_host_proc_spawn/post/terminate/ping` | `(ptr…) -> i32` |
| ipc | `qz_host_ipc_*` | `(ptr…)` |
| 边界消息 | `qz_host_post_message` | `(ptr, len)` |

**内存传递**：wasm 内存按 ptr+len 传字节；不放 JSValue（wasm 外无 JS 堆概念）。`qz_str_len`/`0x7FFA` 句柄（AOT 已有）可复用为 guest 内字符串表示。

### 10.4 异步回流（host → guest）

现状：host 的 `done_cb` 直接 `JS_Call(resolve)`（同线程）。in-module 下 host **无 JSContext**，不能建/调 JSValue。改为**拉模型 + 队列**：

```
host:  uv_io_http_request(..., op_id=N) 完成
       → 写入 host 侧 pending 队列 {op_id, err, ptr, len}
guest: qz_tick()  ← 宿主每轮 libuv iteration 后调
       → __qz_drain__()  [guest import，反向：拉 host 队列]
       → 按 op_id 找到 guest 内持有的 resolve(JSValue) → JS_Call
```

即 §5.4 的 tick 拉模型**一并解决异步回流**：tick = 排空 microtask + 拉 host 完成队列。**无需 host 侧持 JSValue**（这是 in-module 硬约束的必然结论）。

**回流的实现选型**（M4 定）：

| 方案 | 机制 | 取舍 |
| --- | --- | --- |
| **import 拉**（倾向） | guest 调 `qz_host_drain(buf, max)` 取回完成事件 | 无共享内存要求，单向好推理；每 tick 一次跨界 |
| 共享内存环 | host 写环，guest 读 | 零跨界；需 `shared-memory` + 原子，复杂度高 |
| host 调 guest 导出 | host 直接 `qz_guest_dispatch(op_id, …)` | host 需持 wasm instance 调用句柄；WAMR 支持 |

倾向 **import 拉**：契合已有 tick、最易验证（M5 只需一个 fs 读跑通）。

**原型实测**（`inmod-abi-proto/` B 段）：`fs_read`→`drain` 全链跑通——guest 发起、宿主 pthread 完成、guest drain 取回。**选型「import 拉」已验证可行**（共享内存环的复杂度可省）。

**跨界税实测**（`inmod-abi-proto/` C 段，WAMR 经典解释器，宿主侧计时多轮取 min）：

| 路径 | ns/次 |
| --- | --- |
| guest→host 空 import | **~45** |
| guest→host 带 32B 负载 import | **~66** |
| wasm 纯循环（基线） | ~5.6 |
| C 直调空函数（基线） | ~0.3 |

**含义**：
- 跨界税绝对值极低——**~2200 万次/秒**。pal 面每轮 tick 的几十次调用 = 纳秒级，**非瓶颈**。
- 对比 AOT 的 `qz.*` import（**JS 函数**，`ASSESSMENT.md` 记 ~4.9µs/次）：in-module 的 `qz_host.*` 直落 **native C**，**快 ~100x**。这是 in-module 相对 node-hosted AOT 的关键优势。
- 设计取舍：仍应把跨界降到最低（§10.2 分层），但**不必**为省跨界牺牲结构——税便宜。

### 10.5 对宿主源的影响

in-module 下 host **不再链 QuickJS**（`qzjs.c:489` 的 `JS_NewRuntime` 是 guest 的活）。故 host 侧需去 JS 化的源：

| 源 | JS_ 用量 | 处置 |
| --- | --- | --- |
| `bridge.c` | 463 | `js_pal_*` 43 个（收 JSValue）→ **移 guest**；`qz_create_pal_object_ctx` 同理 |
| `io/tcp_io.c` | 229 | 判定：建 JS 值/回调 → 去 JS 化或移 guest |
| `control/control.c` | 72 | CTL 是宿主能力，去 JS 化 |
| `host/worker.c` | 48 | worker 编排，去 JS 化 |
| `host/qzjs.c` | 10 | lifecycle+tick → 改调 guest 导出 |
| `host/thread.c` | 2 | tick → 上移 guest |
| `io/uv_io.c` | **0** | **不动**（已是纯原语层） |

**这不是本轮范围**——记录为 M6，因为 in-module 真正落地才需要；先做 M1–M5（guest 自包含 + 一个 fs 原语跨界跑通）。

### 10.6 与 AOT 的关系（复用点）

AOT（`qzvm.js` + emitter）已有 `qz.*` import 机制（`qz.add`/`qz.str_len`… NaN-box i64）。in-module 的 host import 是**另一套**（`qz_host_*`，host 能力），但**共享 wasm 工具链 + WAMR 加载**。命名区分：`qz.*` = AOT 值原语（guest 内 AOT 代码用）；`qz_host.*` = host 能力（in-module guest 用）。二者不冲突（不同 import module 名）。

## 11. 参考

- 决策原则：brain `decision-principles`（苏格拉底式提问 / 第一性原理 / 奥卡姆剃刀 + 极简哲学）
- 决策链：brain `aot-experiment-verification`（2026-10-13 全部条目）
- 相关设计：`STR_BACKEND_DESIGN.md`、`ASSESSMENT.md`、`PORTABILITY_32BIT.md`
- 已落地：提交 `d365171e`（profile 档 + gate 逃逸）
- 原型：`inmod-abi-proto/`（`guest.wat` + `host.c` + `build.sh`，`sh build.sh` 复现 §10 跨界 ABI 验证）
- 证据点位（§10 跨界 ABI）：`uv_io.c`（4061 行，**0 处 `JS_` 调用**——天然边界）、`qz_rt.h:129-149`（`uv_io_*` 原语签名）、`bridge.c`（463 处 JS_，43 个 `js_pal_*`）、`tcp_io.c`（229）、`control.c`（72）、`worker.c`（48）、`qzjs.c:489`（`JS_NewRuntime`——in-module 后属 guest job）
- 证据点位：`qz_core.h:79-311`（qz_t）、`:17-33`（qz_ctx_t）、`qz_types.h:26-30`、`context.c:101-240`（`qz_ctx_create_at` 混装）、`bridge.c:2117-2172`（编排）、`bridge.c:2226`（pal 面）、`bridge.c:2334`（死码注入）、`src/host/polyfill_load.c`、`textcodec_ext.c:225`（ext 依赖 `__native__`）、`thread.c:22`（tick）
