---
id: aot-performance-model
title: "AOT 性能模型与数值表示裁决：f64 维持、跨界税是唯一大杠杆"
category: decision
status: active
tags: [decision, aot, performance, f64, wasm, numeric]
created: "2026-10-13T06:22:46"
updated: "2026-10-13T06:31:11"
---

<!-- compiled_truth -->
## 结论

**AOT 形态 = 单一 wasm 模块**（非"两条并行路线"）：TS 编译为 wasm ⇒ 模块内**静态部分已是 wasm**（emitter 发射的原生指令），**动态部分在同模块内的 qzvm 中运行**（与静态 wasm 同 isolate / 同线性内存）。模块对外**两条可选 import 面**：

1. **qzjs 的 JS import** —— 宿主 qzjs 运行时兑现（`qz.*` = 引擎↔宿主阻抗匹配绑定：对象/字符串/数组/平台 API 走它）。
2. **WASI 的 import** —— 「wasm 运行时」自己兑现（qzjs 不介入；工具链 lowering target 之一）。

### qzvm 的准确边界（勿简化为 QuickJS-ng）

**模块内跑的 qzvm ≠ 单纯 QuickJS-ng**。qzvm = **纯 VM 构建单元**（`src/qzvm/CMakeLists.txt:35-44`），源集：

- `context.c` —— realm/ctx 生命周期
- `vm_core.c` —— eval / 字节码编译 / rt 查询（2026-10-09 从宿主层移入，消除 VM→宿主反向依赖）
- `ext_lifecycle.c` —— 扩展 init/destroy/suspend/resume
- （可选）`ext_wamr.c` / `ext_wasm3.c` —— wasm 引擎扩展
- （可选）`debugger.c` / `debugger_dap.c` —— DAP

in-module 档关掉 wasm 引擎（`_prof_wamr`/`_prof_wasm3` OFF）⇒ **模块内 qzvm 源集 = context.c + vm_core.c + ext_lifecycle.c**，不含 wasm 引擎、不含 debugger、不含宿主 I/O。QuickJS-ng 是其底层引擎（外部依赖），二者不等同。

- **性能天花板架构性、已实测**：纯数值 ~130x 解释器 / 快 V8 ~2.1x；对象循环 ~38–50x 解释器 / 慢 V8 4–12x；字符串慢 V8 ~248x（唯一系统性劣势）。
- **「整体实现」收益 = 覆盖率，非峰值**（qzvm.js 现 20–33 符号）。
- **最大性能杠杆 = `qz.*` 跨界税 4.9µs → 45–66ns（~100x）**：把 `qz.*` import 从 JS 函数改为 WAMR raw native（`ext_wamr.c:1071` `wasm_runtime_register_natives_raw`）。
- **数值表示裁决：维持 f64 NaN-box；num 快路径已是裸 f64**。原生整数 i32/i64 实测仅快 12–18%，被三约束否决。

## 实测锚点（本机 2026-10-11/12，`README.md:48-52`）

| 负载 | AOT(qzjs) | 解释器(qzjs) | V8(node) | vs 解释器 | vs V8 |
|---|---|---|---|---|---|
| numWork(3000) 纯数值递归 | 361ms | 48.4s | 758ms | 快 ~134x | 快 ~2.1x |
| objWork(30000) 对象循环 | 1.3ms | 50ms | 0.11–0.36ms | 快 ~38x | 慢 ~4–12x |
| strWork(8000) 字符串拼接 | 30ms | 5ms | 0.12ms | 慢 ~6x | 慢 ~248x |

## 跨界税：唯一的大杠杆

- 现状 `qz.*` import = **JS 函数**（glue 里 `qz.add`/`qz.str_len`…）→ **~4.9µs/次**（`ASSESSMENT.md:391`）。
- 改走 `ext_wamr.c:1071` **raw native 注册**（wasm import → native C 函数，WAMR 直跳 C 无 JS glue/无 importObject 闭包/无 BigInt 装箱）→ **~45ns/次（空）/ ~66ns/次（32B 负载）**（`inmod-abi-proto` C 段实测）。
- 效果：**循环内跨界不再必成悬崖**。命门 = guard 化率——objWork 曾因 60001 次跨界从 1ms 劣化到 292ms（`ASSESSMENT.md:26`）。

## 数值表示：f64 vs 原生整数（本轮新决策）

### 前提纠正

num 快路径**已是原生裸 f64**（`emitter.js:4`、`:245`：`mode==="num"` → `f64` local，原生指令，零跨界），**不是 NaN-box**。NaN-box 只用于 tagged 路径（i64）。真问题 = f64 换 i32/i64 能否更快。

### 实测（手写 WAT，V8 TurboFan JIT ≈ LLVM O3）

| 负载 | f64 | i32 | i64 | i32 相对 |
|---|---|---|---|---|
| 累加循环 5e7（`(i*3+7)%1000` 求和） | 72.4ms | 59.6ms | 62.0ms | 快 18% |
| fib(40) 递归 | 520.1ms | 458.9ms | 454.3ms | 快 12% |

### 三条硬约束（否决 i32 作 number 表示）

1. **精度**：TS `number` = f64 53 位；i32 仅 31 位 → `Date.now()`(~1.7e12)、`i*i` 求和等**静默错值无 trap**。实测 objWork(3000) i32 得 `410064408` vs 正确 `8999999000`（`PORTABILITY_32BIT.md:58`）。一票否决。
2. **跨 int/float `<=` 语义**：整数表示须双 tag，每算术点重新判类型+分派 → 抵消 12–18%。
3. **32 位宿主**：i64 在 wasm32 是双寄存器 pair（拆装开销）；实测 i64 比 f64 还慢（`PORTABILITY_32BIT.md:13`）。

### 已否决方向

「整数特化快路径」（显式 `: number` + 静态证明全整数时用 i32，溢出 trap）能拿 12–18%，但代价 = 第三路径复杂度 + 溢出证明不可靠。`PORTABILITY_32BIT.md:75` 已否决「编译期大数探测」。净判：不值得（数值已快 V8 2.1x，12–18% 是小头）。

## 次要指标

| 指标 | 值 | 依据 |
|---|---|---|
| 对象内存 | ~2x native（f64 字段 8B） | `ASSESSMENT.md:65` |
| 32 位软浮点目标 | 算术 10–30x 回退 | `ASSESSMENT.md:65`（i386 数值一致已验） |
| 冷启 | wamrc 离线编译，运行时仅 WAMR instantiate | `[INFERENCE]` 无实测，M4 补 |
| wasm 解释模式 | 1.74x，无意义 → 必须 wamrc AOT | `ASSESSMENT.md:56` |

## 与 in-module / WASI 的关系（校正）

- **单模块统一形态**：in-module 档（`QZ_PROFILE=in-module`，`CMakeLists.txt:41-45`）= 把 qzvm 编到 wasm32 与该模块的静态 wasm **共存于同一 wasm 模块**。故 in-module 与 AOT **不是两条并行路线**——是同一模块的静态/动态两面。（校正本页 2026-10-13 早先"两条并行路线"的错误记录。）
- **为何单模块可成立**：in-module profile 关掉 qzjs 自己的 wasm 引擎（`_prof_wamr OFF` / `_prof_wasm3 OFF`），模块内不套第二层 wasm 引擎 ⇒ **无 wasm 嵌套**。
- **两条 import 面互斥可选**：`qz.*`（qzjs 兑现）与 WASI（wasm 运行时兑现）。qzjs 内置 WAMR 的 `WAMR_BUILD_LIBC_WASI 0`（`CMakeLists.txt:582`）、wasm3 `BUILD_WASI=none` ⇒ **qzjs 当前不解 WASI**；WASI 目标模块供其它 wasm 运行时。工具链可发多 target（`build.js:128` `--target` 是 CPU 架构交叉编译，与 lowering target 不同轴）。
- **`qz.*` 归属**：`02:36` 记为「工具链自带 JS shim」（`build.js:36/82/91`），`02:42` 记为「引擎↔宿主阻抗匹配绑定」。二者统一：shim 实现该绑定，跑在任意 JS 引擎（Node/浏览器/qzjs）；qzjs 只是其中一个兑现者。
- **待决点（M4）**：单模块如何合并——`IN_MODULE_DESIGN.md §6` 只说产独立 guest 产物（qzvm 编出的 .wasm），未写与 AOT 静态 wasm 的合并步骤。wasm-merge/wasm-ld 链接成单模块（契合"零 marshalling"）vs 并列加载？


## Timeline

- time: 2026-10-13T06:22:46
  kind: decision
  summary: "Created this page: AOT 性能模型与数值表示裁决：f64 维持、跨界税是唯一大杠杆"
  source: "讨论 2026-13 + ASSESSMENT.md + README.md + PORTABILITY_32BIT.md + emitter.js 实测"
  affects: [aot-performance-model]

- time: 2026-10-13T06:22:46
  kind: decision
  summary: "AOT 整体实现性能画像 + f64 vs i32 数值表示裁决：维持 f64（原生整数实测仅快 12-18%，被精度/语义/32位三条硬约束否决）；最大杠杆是 qz.* 跨界税 4.9µs→45ns（raw native 注册）。"
  source: "本机实测 + 手写 WAT 微基准"
  affects: [aot-performance-model]

- time: 2026-10-13T06:22:53
  kind: evidence
  summary: "手写 WAT 微基准（V8 TurboFan ≈ LLVM O3）：累加循环 5e7 f64 72.4ms / i32 59.6ms / i64 62.0ms（i32 快 18%）；fib(40) f64 520.1ms / i32 458.9ms / i64 454.3ms（i32 快 12%）。原生整数确实快，但被精度（31 位静默错值，objWork(3000) i32=410064408 vs 正确 8999999000）+ 跨 int/float <= 语义 + 32 位 i64 双寄存器三约束否决。"
  source: "eval 实测 /tmp/nb/bench.mjs bench2.mjs"
  affects: [aot-performance-model]

- time: 2026-10-13T06:22:58
  kind: note
  summary: "边界澄清：in-module（qzvm 编 wasm32 作 guest）保留，与 AOT 是两条并行路线，非嵌套。用户 AOT 模块由宿主 WAMR 直接加载，不套进 guest。qz.*（值原语，guest 内 AOT 用）与 qz_host.*（宿主能力，in-module 用）不同 import module 名，互不冲突。"
  source: "用户澄清 + IN_MODULE_DESIGN.md:412"
  affects: [aot-performance-model]

- time: 2026-10-13T06:27:03
  kind: decision
  summary: "校正形态框架：AOT = 单一 wasm 模块（静态 wasm + 模块内 qzvm 跑动态，同 isolate），非两条并行路线。两条可选 import 面：qzjs 的 JS import（宿主兑现）+ WASI（wasm 运行时兑现，qzjs 当前 WAMR_BUILD_LIBC_WASI=0 不解）。性能画像 + f64 裁决不变。"
  source: "用户本轮架构声明 + CMakeLists:41-45/582 + build.js:128 + 手写 WAT 实测"
  affects: [aot-performance-model]

- time: 2026-10-13T06:27:11
  kind: reversal
  summary: "反转本页早先错误框架：此前记「in-module 与 AOT 是两条并行路线，非嵌套」——错。正确：单一 wasm 模块内，静态部分已是 wasm（emitter 发射），动态部分在同模块内 qzvm（QuickJS-ng 编 wasm32）中运行，同 isolate/同线性内存。in-module 档 = 该模块的构建形态（关 qzjs 自己的 wasm 引擎 ⇒ 无第二层 wasm ⇒ 无嵌套）。对外两条 import 面：qzjs 的 JS import（qz.* 阻抗匹配，宿主兑现）与 WASI import（wasm 运行时兑现）。"
  source: "用户本轮架构声明 + CMakeLists:41-45(_prof_wamr/wasm3 OFF)/582(WAMR_BUILD_LIBC_WASI 0) + build.js:36/82/91"
  affects: [aot-performance-model]

- time: 2026-10-13T06:30:39
  kind: note
  summary: "术语精确化（用户纠正）：模块内跑的不是「简单 QuickJS-ng」，而是 qzvm。qzvm = 纯 VM 构建单元（src/qzvm/CMakeLists.txt:35-44），源集 = context.c（realm 生命周期）+ vm_core.c（eval/字节码编译/rt 查询，2026-10-09 从宿主层移入以消除 VM→宿主反向依赖）+ ext_lifecycle.c（扩展 init/destroy/suspend/resume）+【可选】ext_wamr.c/ext_wasm3.c（wasm 引擎扩展）+【可选】debugger.c/debugger_dap.c。in-module 档关掉 wasm 引擎（_prof_wamr/_prof_wasm3 OFF）⇒ 模块内 qzvm 源集 = context.c + vm_core.c + ext_lifecycle.c，不含 wasm 引擎、不含 debugger、不含宿主 I/O。故正确表述：模块内 = qzvm（引擎核心语义 + 扩展生命周期），底层是 QuickJS-ng 引擎，二者不等同。"
  source: "用户纠正 + src/qzvm/CMakeLists.txt:1-44 + vm_core.c:1-12 + CMakeLists.txt:41-46"
  affects: [aot-performance-model]

- time: 2026-10-13T06:31:11
  kind: decision
  summary: "补 qzvm 准确边界（用户纠正）：模块内跑的是 qzvm（纯 VM 构建单元），非单纯 QuickJS-ng。in-module 档 qzvm 源集 = context.c + vm_core.c + ext_lifecycle.c（不含 wasm 引擎/debugger/宿主 I/O），底层引擎是 QuickJS-ng。其余（性能画像、f64 裁决、单模块形态、双 import 面）不变。"
  source: "用户纠正 + src/qzvm/CMakeLists.txt:35-44 + CMakeLists.txt:41-45"
  affects: [aot-performance-model]
