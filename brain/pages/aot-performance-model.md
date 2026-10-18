---
id: aot-performance-model
title: "AOT 性能模型与数值表示裁决：f64 维持、跨界税是唯一大杠杆"
category: decision
status: active
tags: [decision, aot, performance, f64, wasm, numeric]
created: "2026-10-13T06:22:46"
updated: "2026-10-18T09:03:34"
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

- **性能天花板架构性**：纯数值 ~27x 解释器（numWork(3000)：AOT 367ms vs 解释器 10.1s）/ 快 V8 ~2.0x；对象循环 ~9x 解释器 / 慢 V8 ~8x；字符串**在 wasm 里零收益**（≈解释器），慢 V8 ~3.9x。
- **「整体实现」收益 = 覆盖率，非峰值**（qzvm.js 现 20–33 符号）。
- **数值表示裁决：维持 f64 NaN-box；num 快路径已是裸 f64**。原生整数 i32/i64 实测仅快 12–18%，被三约束否决。

## 实测锚点（本机实测，`README.md` 性能画像 + 2026-10-18 复测修正）

| 负载 | AOT(qzjs) | 解释器(qzjs) | V8(node) | vs 解释器 | vs V8 |
|---|---|---|---|---|---|
| numWork(3000) 纯数值递归 | 367ms | 10.1s | 748ms | 快 ~27x | 快 ~2.0x |
| objWork(30000) 对象循环 | **2.88ms（fix 后，见下）** | 7.0ms | 0.10ms | 快 ~2.4x | 慢 ~29x |
| strWork(200000) 字符串拼接 | 26.3ms | 26.6ms | 6.7ms | **~1.0x（无收益）** | 慢 ~3.9x |

**⚠️ objWork 表行修正（2026-10-18）**：旧表记 `objWork AOT=0.8ms 快 ~9x`。该 0.8ms/1ms 锚点来自 `28835e96`（2026-10-11）引入的 `_emitConcat` num+num→`f64Add` 内联支（零跨界）。**`7af9e98c`（2026-10-16 08:45，"+ 拼接 ToPrimitive"）删了该 f64Add 内联支、num+num 改走宿主 `qz.add`**（提交信息称"双纯数走原生"但 diff 实删 f64Add，信息不准）⇒ objWork 回归至 **186–213ms**（60000 次 `qz.add` 跨界 × 3.55µs/次）。**2026-10-18 修复**：`_emitConcat`（emitter.js:3257-3266）「两非串」else 支加双纯数运行时 guard——纯数+纯数→`f64Add` 内联（零跨界），否则→`qz.add`（保留 ToPrimitive 正确性）⇒ objWork=**2.88ms**、跨界 60006→6、check=8999999990000 正确，14 个 ToPrimitive 边界 + test_aot.js ALL PASS。

- **str 的裁决（2026-10-15）**：字符串负载在 wasm 里既非收益也无系统性劣势，**≈解释器持平**。独立 A/B 交替实测（strWork(200000)）：AOT wasm 中位 28.18ms vs interp 回退 26.50ms —— 每轮 `s = s + i` 跨一次 `qz.string_concat` 边界，跨界税吃掉全部 AOT 收益。**故 str 放弃 wasm 化**，走 `--interp` 退解释器（`compileTS(opts.interp)`）。

## 跨界税：唯一的大杠杆（2026-10-18 复测修正）

**关键修正：raw native ≠ qz.* 的 C 实现，只压派发；且 glue 路径未走 raw native。**

- **现状（glue / `WebAssembly.instantiate` 路径）**：`qz.*` import = glue 里 `makeQzvm()` 返回的 JS 函数。实测 `qz.add` **~3.55µs/次**（objWork 213ms ÷ 60000 跨界）—— 走 WAMR 标准 import callback（慢路径），**不**走 raw native。
- **raw native（`ext_wamr.c:893-907` + `wasm_runtime_register_natives_raw`）= 派发蹦床**：wasm→C 蹦床→查 importObject 的 JS 函数→BigInt 解 tag→调 JS。**JS shim 工作仍在**（~195ns/次）。
- **C 宿主实测（`inmod-abi-proto/host_bench3`，纯派发无 JS 工作）**：noop **43.01ns/次**、32B 负载 60.73ns/次、纯 wasm 循环 5.23ns/次、C 直调 0.28ns/次。该 43–66ns 是 raw native **派发税下界**，但仅在 C 宿主直跑时达成；**glue 路径不触发它**（仍 3.55µs）。
- **objWork 跨界分解（实测，计数器隔离）**：objWork(30000) 实际运行时跨界 = `qz.add`×60000（2/轮 × 30000），**零** prop_get/object_get/string_concat/str_dup 运行时跨界。即：
  - POJO 对象字面量 `{id,sq,tag}` = bump 内联 alloc（emitter.js:3917+，零跨界）✓
  - POJO 属性读 `r.id`/`r.sq` = 内联 i32Load（`_emitPropReadFromLocal` 0x7FF9 支，emitter.js:752-761，零跨界）✓ —— **旧脑页/早期推断"POJO 属性读走 prop_get 跨界"是错的**。
  - 唯一跨界 = `total + r.id + r.sq` 的 `+`：tagged 模式经 `_emitBinOp`→`_emitConcat`，旧代码 num+num 无内联支→`qz.add`（宿主）。fix 后双纯数 guard→`f64Add` 内联（零跨界）。
- **效果**：循环内跨界不再必成悬崖——但前提是 guard 化率（num+num 内联）+ 走 raw native 路径（glue 当前不走，需 in-module/M4 或原生 Module 构造路径才触发）。

## 数值表示：f64 vs 原生整数

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
- **两条 import 面互斥可选**：`qz.*`（qzjs 兑现）与 WASI（wasm 运行时兑现）。qzjs 内置 WAMR 的 `WAMR_BUILD_LIBC_WASI 0`、wasm3 `BUILD_WASI=none` ⇒ **qzjs 当前不解 WASI**；WASI 目标模块供其它 wasm 运行时。
- **`qz.*` 归属**：工具链自带 JS shim（`build.js:36/82/91`）。shim 实现该绑定，跑在任意 JS 引擎（Node/浏览器/qzjs）；qzjs 只是其中一个兑现者。
- **待决点（M4）**：单模块如何合并——`IN_MODULE_DESIGN.md §6`。`build-inmod/src/qzvm/libqzvm.wasm`（in-module guest）已编出，但静态 wasm + qzvm 合并到同模块的步骤未实现，跑不了 objWork in-module 形态。


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

- time: 2026-10-13T08:24:44
  kind: decision
  summary: "消解页内数字矛盾：结论段「纯数值 ~130x」与同页实测表「~134x」不一致，统一为 ~134x 并标注负载/规模（numWork(3000)：AOT 361ms vs 解释器 48.4s）。"
  source: "48.4s/361ms=134.1 核算 + 同页表格"
  affects: [aot-performance-model]

- time: 2026-10-15T07:11:31
  kind: reversal
  summary: "字符串负载放弃 wasm 化：A/B 交替实测（best-of-10 × 6 轮）strWork(200000) AOT wasm 中位 28.18ms vs interp 回退 26.50ms —— wasm 零收益（每轮 s=s+i 跨一次 qz.string_concat 边界，跨界税吃掉全部 AOT 收益）。实现 --interp：compileTS(opts.interp) 把指定函数从 wasm 摘出去（不 declareFunc/不 emitFunc，funcMeta.mode=interp），调用者经传递闭包一并退；program.emit 复用同一 AST 产出可内联 JS（checker 重写 import 引用、剥 export 修饰符、清 externalModuleIndicator 防 require/exports 包装），glue 闭包内求值 + __call 按 mode 分派（与 wasm 同一份源码，语义等价）。bench_mix 的 str 负载即此配置。不做自动推断（用户裁决：不用太复杂），显式列名。守门 test_aot.js runInterp（7 项）。"
  source: "用户裁决 2026-10-15：不用太复杂，测量 wasm 性能确实不如模块内 qzvm 就放弃 str 的 wasm 化加速"
  affects: [aot-performance-model]

- time: 2026-10-15T07:12:13
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [aot-performance-model]

- time: 2026-10-18T05:42:04
  kind: decision
  summary: "2026-10-18 复测修正：objWork 0.8ms 锚点来自 28835e96 的 _emitConcat num+num→f64Add 内联；7af9e98c(10-16) 删该支致回归 186-213ms；fix 双纯数 guard 恢复 2.88ms。raw native 43-66ns 仅 C 宿主 bench3 路径，glue 路径 qz.add=3.55µs 不走 raw native。POJO 属性读实为内联(0 跨界)，旧'POJO 走 prop_get'说法错。"
  source: "实测: bench_mix 计数器隔离 objWork 跨界 + inmod bench3 C 宿主 + test_aot.js ALL PASS + 14 ToPrimitive 边界 ALL OK"
  affects: [aot-performance-model]

- time: 2026-10-18T05:42:43
  kind: evidence
  summary: "objWork 跨界税实测裁决 + 回归定位 + fix。计数器隔离 objWork(30000): 60006 跨界全 qz.add(2/轮×30000), 零 prop_get/object_get/string_concat 运行时跨界→POJO 字面量 bump 内联 alloc + POJO 属性读内联 i32Load(均零跨界)确认; 旧'POJO 走 prop_get 跨界'推断错。qz.add=3.55µs/次(glue/WASM.instantiate 走 WAMR import callback 慢路径, 非 raw native)。回归: 28835e96(10-11) 引入 _emitConcat num+num→f64Add 内联(=旧 0.8ms/1ms 锚点来源); 7af9e98c(10-16 08:45 '+ 拼接 ToPrimitive')删该 f64Add 改 qz.add(信息称双纯数走原生但 diff 实删, 不准)→objWork 回归 186-213ms。fix(2026-10-18): _emitConcat(emitter.js:3257-3266)两非串 else 加双纯数运行时 guard→纯数+纯数 f64Add 内联零跨界, 否则 qz.add 保 ToPrimitive。结果 objWork=2.88ms(213ms→74x), 跨界 60006→6, check=8999999990000 正确, 14 ToPrimitive 边界 ALL OK, test_aot.js ALL PASS。inmod bench3 C 宿主: noop 43.01ns/32B 60.73ns/纯循环 5.23ns(raw native 派发税下界, 仅 C 宿主达成, glue 不触发)。"
  source: "bench_mix.js 计数器实测 + inmod-abi-proto/host_bench3 + git log -L _emitConcat + test_aot.js + ToPrimitive 烟测"
  affects: [emitter.js, aot-performance-model]

- time: 2026-10-18T09:03:34
  kind: evidence
  summary: "noop AOT 跨界微基准修正: qzjs ext_wamr noop=133.8ns/次, V8=17.7ns/次。证明 raw-native 蹦床已生效(非'glue 不走 raw native')。qz.add 3.55µs = 蹦床 133.8ns + JS shim 工作 ~3.4µs(BigInt 解 tag+add)。旧'glue 路径不走 raw native, 派发税 3.55µs'推断修正: 派发已最小(133.8ns), 瓶颈是 JS shim 工作非派发。"
  source: "noop_imp.wat(wat2wasm)+wamrc AOT+qzjs/V8 对照"
  affects: [aot-performance-model, aot-roadmap]
