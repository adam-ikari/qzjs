---
id: aot-performance-model
title: "AOT 性能模型与数值表示裁决：f64 维持、跨界税是唯一大杠杆"
category: decision
status: active
tags: [decision, aot, performance, f64, wasm, numeric]
created: "2026-10-13T06:22:46"
updated: "2026-10-13T06:22:58"
---

<!-- compiled_truth -->
## 结论

AOT（用户 TS→wasm，宿主 native qzjs + WAMR 直跑 `.aot`，**无 wasm 嵌套**）整体实现后的性能画像：

- **天花板是架构性的、已实测**：纯数值 ~130x 解释器 / 快 V8 ~2.1x；对象循环 ~38–50x 解释器 / 慢 V8 4–12x；字符串慢 V8 ~248x（唯一系统性劣势）。
- **「整体实现」的收益 = 覆盖率，非峰值**。qzvm.js 现仅 20–33 符号（Perry 211）；覆盖率只决定「多少真实代码吃到 50–130x 带」，不改架构倍率。
- **最大性能杠杆 = `qz.*` 跨界税从 ~4.9µs/次 降到 ~45–66ns/次（~100x）**：把 `qz.*` import 从 JS 函数改为 WAMR raw native（C 函数，`ext_wamr.c:105` 已具备注册路径）。这是唯一能改变架构性倍率的动作。
- **数值表示裁决：维持 f64 NaN-box + num 快路径已是裸 f64**。改用 i32/i64 原生整数实测只快 12–18%，被三条硬约束一票否决。

## 实测锚点（本机 2026-10-11/12，`README.md:48-52`）

| 负载 | AOT(qzjs) | 解释器(qzjs) | V8(node) | vs 解释器 | vs V8 |
|---|---|---|---|---|---|
| numWork(3000) 纯数值递归 | 361ms | 48.4s | 758ms | 快 ~134x | 快 ~2.1x |
| objWork(30000) 对象循环 | 1.3ms | 50ms | 0.11–0.36ms | 快 ~38x | 慢 ~4–12x |
| strWork(8000) 字符串拼接 | 30ms | 5ms | 0.12ms | 慢 ~6x | 慢 ~248x |

## 跨界税：唯一的大杠杆

- 现状 `qz.*` import = **JS 函数**（glue 里 `qz.add`/`qz.str_len`…）→ **~4.9µs/次**（`ASSESSMENT.md:391`）。
- 改走 `ext_wamr.c:105` 的 **raw native 注册**（wasm import → native C 函数）→ **~45ns/次（空）/ ~66ns/次（32B 负载）**（`inmod-abi-proto` C 段实测，WAMR 经典解释器，宿主侧计时多轮取 min）。
- 效果：**循环内跨界不再必成悬崖**。当前命门是 guard 化率——objWork 曾因 60001 次跨界从 1ms 劣化到 292ms（`ASSESSMENT.md:26`），修 `emitCondI32` + tagged `++` guard 化后回归 1ms。

## 数值表示：f64 vs 原生整数（本轮新决策）

### 前提纠正

num 快路径**已经是原生裸 f64**（`emitter.js:4`、`:245`：`mode==="num"` → `f64` local，原生 wasm 指令，零跨界），**不是 NaN-box**。NaN-box 只用于 tagged 动态路径（i64）。故不存在「NaN-box 拖慢数值热点」问题。真问题 = f64 换 i32/i64 能否更快。

### 实测（手写 WAT，V8 TurboFan JIT ≈ LLVM O3 代码质量）

| 负载 | f64 | i32 | i64 | i32 相对 |
|---|---|---|---|---|
| 累加循环 5e7（`(i*3+7)%1000` 求和） | 72.4ms | 59.6ms | 62.0ms | 快 18% |
| fib(40) 递归 | 520.1ms | 458.9ms | 454.3ms | 快 12% |

**原生整数确实快 ~12–18%**，但——

### 三条硬约束（否决 i32 作 number 表示）

1. **精度**：TS `number` = f64 53 位；i32 仅 31 位 → `Date.now()`(~1.7e12)、`i*i` 求和等**静默错值、无 trap**。实测 objWork(3000) i32 得 `410064408` vs 正确 `8999999000`（`PORTABILITY_32BIT.md:58`）。一票否决。
2. **`<=` 跨 int/float 语义**：整数表示须区分 `int|float` 双 tag，每个算术点重新判类型 + 分派 → 抵消 12–18%。
3. **32 位宿主**：i64 在 wasm32 是双寄存器 pair（拆装开销、无对齐）；实测 i64 比 f64 还慢（`PORTABILITY_32BIT.md:13`）。

### 可行但已否决的方向

「整数特化快路径」（第三条 `int` 路径：显式 `: number` + 静态证明全整数时用 i32，溢出 trap 而非静默）能拿 12–18%，但代价 = 第三条编译路径复杂度 + 溢出证明不可靠。`PORTABILITY_32BIT.md:75` 已否决「编译期大数探测 + 模块降级」。净判：**不值得**，12–18% 是小头（数值已快 V8 2.1x），与第三路径复杂度 + 静默出值风险不成比例。

## 次要指标

| 指标 | 值 | 依据 |
|---|---|---|
| 对象内存 | ~2x native（f64 字段 8B） | `ASSESSMENT.md:65` |
| 32 位软浮点目标 | 算术 10–30x 回退 | `ASSESSMENT.md:65`（i386 数值一致已验） |
| 冷启 | wamrc 离线编译，运行时仅 WAMR instantiate | `[INFERENCE]` 无实测，M4 补 |
| wasm 解释模式 | 1.74x，无意义 → 必须 wamrc AOT | `ASSESSMENT.md:56` |

## 与 in-module 的关系（勿混）

- in-module（qzvm 编到 wasm32 作 guest）**保留**，与 AOT 是**两条并行路线**，非嵌套。
- 「不要 wasm 嵌套」= 用户 AOT 模块由宿主 WAMR 直接加载，**不套进 guest 内**。
- AOT 的 `qz.*` import（值原语）与 in-module 的 `qz_host.*`（宿主能力）是**不同 import module 名**，互不冲突（`IN_MODULE_DESIGN.md:412`）。


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
