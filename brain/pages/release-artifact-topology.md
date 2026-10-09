---
id: release-artifact-topology
title: "发行产物拓扑：字节码永不独立发行，唯一稳定 API = WinterTC"
category: decision
status: active
tags: [bytecode, release, artifact, wasm, wintertc, abi]
created: "2026-10-07T15:07:14"
updated: "2026-10-09T05:41:46"
---

<!-- compiled_truth -->
# 发行产物拓扑（2026-10-07/08 用户拍板）

## 核心约束

1. **字节码永远与引擎实现绑定**：**JS 字节码必须与 JS 引擎绑定**，不存在跨引擎、
   跨版本的稳定字节码格式。字节码是引擎内部表示，随引擎实现一起演进，
   不构成 ABI；升级 = 引擎 + 字节码整体替换。

2. **永不保证二进制 ABI 兼容性**：引擎二进制接口（字节码格式、内部对象布局、
   C/FFI 符号面等）不承诺任何跨版本二进制兼容。**稳定 API 仅限于 qzjs 对外公开
   的 API**——WinterTC（ECMA-429 核心，见 standard-source-policy）是其核心组成，
   但稳定面不限于 WinterTC，以 qzjs 对外公开 API 集合为准；未公开内部面依赖
   = 自负风险。

3. **永不独立发行字节码**：没有「只发字节码、不带引擎」的发行版本。
   字节码总是与其生成它的引擎实现一起打包发行（字节码-引擎配对锁死）。

4. **wasm 独立可执行文件形态的对外保证 = 仅 WASI API**：wasm 产物向宿主/外部
   暴露的稳定接口只有 WASI（wasi_snapshot_preview1 等）；引擎内部接口、字节码
   格式、导入函数面均不构成对外承诺，不保证跨版本兼容。

## AOT 主线路线（2026-10-08 用户裁决，最终）

**TS → js + as → js + wasm**：一份 TS 源码双编译——
- **动态部分** → JS（胶水代码 + 动态类型代码，走 tsc 或等价工具）
- **静态部分** → AssemblyScript 源码 → `asc` → **wasm**（数值运算开箱原生
  i64.add/i64.lt_s，零类型擦除桥；对象/字符串经 `@external("qz", …)` import
  由 qzvm.c（quickjs）提供语义）

**wasm 执行策略（二选一，qzjs 侧决定）**：
- **AOT**：qzjs 加载 wasm 时用 `wamrc` 预编译成原生码（.aot）再执行
- **JIT**：运行 wasm 时用 LLVM ORC 边跑边编译

**so 形态 = wasm 产物经 wasm2c 生成**：wasm → wasm2c → C99 → gcc → `.so`。
so 不是从 TS 直接编译，而是 wasm 中间产物的派生物——保证 JS 路径与 so 路径
**共享同一份 wasm 产物**（一次编译，两种分发形态）。

**明确不再使用 Perry 及任何需改造上游源码的第三方 TS 编译器。**

### 两种打包形态（内容物确定）

| 形态 | 内容 |
|------|------|
| **独立可运行 ELF** | **JS 字节码 + qzjs 运行时 + so**（so = wasm2c(wasm) 派生） |
| **独立 wasm 文件** | **JS 字节码 + qzjs 运行时 + wasm**（qzjs 运行时本身编成 wasm） |

两条形态都含「JS 字节码 + 引擎」，差别只在 AOT 产物形态（so 原生库 / wasm 模块）。

### 推翻的历史裁决（reversal）

- **推翻**：此前"TS 直接 → C99 最适合 quickjs、不经 wasm 中间表示最优"的裁决。
  现改为**统一走 wasm 中间层**——so 由 wasm2c 派生，JS 路径与 so 路径共享同一
  wasm 产物。代价是 wasm2c 的抽象税（call-stack 检查/函数指针/线性内存寻址）；
  收益是单一编译产物 + 两种分发形态 + qzjs 加载期可 AOT/JIT 自由选择。
- **保留**：AssemblyScript 作为 wasm 后端（数值开箱原生指令，无需改上游源码）；
  qzvm.c 作为 wasm 侧 quickjs 运行时（16 符号，对象/数组/字符串/方法调用已实测）。
- **ts2c.py**（TS→C99 直编编译器）：不再是 so 路线主路径（so 改由 wasm2c 派生），
  保留作为实验/参考实现。

### 性能矩阵（2026-10-08 实测，新路线全模式）

负载：`bench(3000)` = 3000 次 `fib(24 + i%2)`（参数随循环变化，防 LLVM 常量折叠）。
基线 = qzjs 解释器同负载 24.56s。

| 模式 | bench(3000) | vs 解释器 | 产物可移植 |
|------|-------------|-----------|-----------|
| 手写 C 等价逻辑 `-O3` | 0.331s | **74.2x** | ✅ |
| 手写 C 等价逻辑 `-O2` | 0.343s | 71.6x | ✅ |
| **AS wasm AOT**（wamrc + LLVM O3） | 0.590s | **41.6x** | 绑 CPU（.aot 需重编译） |
| **wasm → wasm2c → so `-O3`** | 0.593s | **41.4x** | ✅ |
| wasm → wasm2c → so `-O3 -march=native` | 0.585s | 42.0x | ❌ |
| wasm → wasm2c → so `-O2` | 1.468s | 16.7x | ✅ |
| wasm → wasm2c → so `-O2 -march=native` | 1.529s | 16.1x | ❌ |
| AS wasm 解释（iwasm fast-interp） | 14.13s | 1.74x | ✅ |
| qzjs 解释器 | 24.56s | 1x | — |

**四条结论**：

1. **`-O3` 是性能关键（2.47x），`-march=native` 几乎无用（<1%）**：
   -O2→-O3 提升 2.47x（1.468s→0.593s）；`-march=native` 只贡献 0.593→0.585s
   （<1.4%）却让产物绑 CPU 特性（换机器可能 illegal instruction）。
   **采纳 `-O3`，拒绝 `-march=native`**——`-O3` 本身可移植（不启用
   -ffast-math，浮点语义保持；对确定性数值代码安全）。

2. **wasm 路线整体有 1.76x 抽象税**（栈帧/调用约定/线性内存）：wasm2c so（0.583s）
   与 wasm AOT（0.590s）彼此持平，但两者都比手写 C（0.331s）慢 1.76-1.78x。
   即"wasm2c ≈ wasm AOT"正确，但"≈0 抽象税"错——wasm 路线对 C 有固有 1.76x 税。

3. **wasm 解释模式无意义**（1.74x）：qzjs 加载 wasm 必须走 AOT 或 JIT，
   解释执行不可作为部署策略。

4. **`-O3` 对 wasm2c 产物是必需项（2.47x），对手写 C 几乎无意义（1.04x）**：
   wasm2c 产出的 C 代码质量差（函数指针/线性内存寻址），`-O3` 补回代码质量差距；
   手写 C 本身代码形状好，`-O2` 已接近上限。所以 so 路线用 `-O3` 不是可选额外性能，
   而是补回 wasm2c 质量差距的必需。
5. **手写 C 是真正上限（74.2x），不是 wasm AOT（41.6x）**：fib 是最适合 C 优化的纯数值
   递归负载，真实负载（含对象/字符串走 qzvm）的差距会不同。

### 对象负载对比（2026-10-08 实测，修正"持平"结论）

负载：`objbench(10000)` = 10000 次 `new_object + set a/b + get a`（对象操作走 quickjs
JS_NewObject/SetPropertyStr/GetPropertyStr）。

| 模式 | per objbench(10000) | vs 手写 C | vs 解释器 |
|------|---------------------|-----------|----------|
| 手写 C -O3（直接调 quickjs C API） | 2.29ms | 1.0x | 1.22x |
| qzjs 解释器（JS 对象循环） | 1.875ms | 0.82x | 1.0x |
| **wasm→wasm2c→so -O3** | 3.17ms | **1.38x** | 1.69x |
| AS wasm AOT（iwasm + qzvm native-lib） | ~17ms | **7.4x** | 9.1x |
| AS wasm 解释（iwasm） | ~21ms | 9.2x | 11.2x |

**关键修正（推翻"so 与 wasm AOT 持平"结论）**：

1. **wasm2c so 抽象税在对象负载下 1.38x（小于数值 1.76x）**——对象操作主开销在
   quickjs C API（JS_NewObject/SetPropertyStr），wasm2c 的 tagged 值转换 + 函数指针
   间接相对小。
2. **wasm AOT 抽象税在对象负载下 7.4x（远大于数值 1.78x）**——每次对象操作都跨
   wasm↔host 边界（import 调用），边界切换开销巨大。对象操作密集时 wasm AOT
   劣势显现。
3. **对象负载下 wasm2c so 远优于 wasm AOT**（1.38x vs 7.4x 税）。此前"so 与 wasm
   AOT 性能持平"仅对数值负载成立，对象负载 so 显著优。
4. **解释器对象负载接近手写 C**（0.82x）——对象操作主开销在引擎 C 实现
   （JS_NewObject/SetPropertyStr），解释器循环开销相对小；且解释器避免
   JSValue↔int 转换（JS 直接 o.a=i），C 版的 JS_NewInt32/JS_ToInt32 是额外开销。

**对发行路线的含义**：ELF 形态（含 so 打包）在对象密集负载下远优于独立 wasm
形态（含 wasm 模块）——so 直接调 quickjs C API，wasm 要跨 import 边界。
数值密集负载两者持平。混合负载的性能取决于数值/对象比例。

## AOT 真实适用面（2026-10-08 实测修正，负面数据）

**真实 TS 代码 AS 化率 = 0%**——4 个真实 npm 库实测（effect / @trpc/server /
@noble/hashes / @noble-curves），识别到的 241 个函数**无一兼容**：

| 库 | 领域 | AS/JS |
|----|------|-------|
| effect | 函数式框架 | 0/4 |
| @trpc/server | RPC 框架 | 0/41 |
| @noble/hashes | 加密哈希 | 0/59 |
| @noble/curves | 椭圆曲线 | 0/137 |

**不兼容主因**：`bigint` 参数（密码学核心运算）、`UintArray`/接口泛型/string 参数、
`number|bigint` union、闭集传播降级。

**关键洞察**：`@noble/*` 是纯 TS 加密实现却 0%——密码学运算基于 **bigint 任意精度
整数**，而 AS 只有 `i32`/`i64`（且 qzjs ext_wamr 不支持 BigInt i64 跨界）。此前
43x/68x 加速**全部来自 fib/整数循环**这一最不真实的负载；真实加密/数值热点用的
bigint 与 typed array 恰好都落在 AS 子集之外。

**修正后的判断**：AOT 真实适用面**极窄**——仅"纯 i32/i64 标量数值循环"
（fib / gcd / collatz / CRC32 的整数部分）可 AS 化。真实业务库（框架/加密/网络/
图形）几乎全 0%，因其建立在对象/字符串/typed array/bigint 之上，而这些走 JS 解释器
或 wasm import 桥（对象税 7.4x）。**43x/68x 是 fib 的成绩，不是 AOT 的普遍成绩。**

**方法论限制（诚实标注）**：切分器当前仅识别顶层 `function` 声明，真实 TS 大量用
箭头函数（`const f = () => {}`）+ class 方法未进入统计（effect 30 文件仅识别 4 个
函数即证据），故真实 AS 化率可能被低估；但被识别的 241 个函数全部因类型不兼容被拒，
方向性结论成立。


## 真正 AOT 的定义（2026-10-07 用户澄清）

**qzjs 实现真正 AOT 的方式 = 编译 TS 代码为 JS + wasm/so**（链路 A）。
- 输入是 **TS 源码**，不是 JS 字节码。
- 产物 = JS（胶水代码 + 动态类型代码）+ wasm 模块，或 so。
- **与字节码无关**：AOT 链路不经 JS 引擎字节码、不经解释器字节码翻译。

## 两条链路正交

### 链路 A：TS → JS + WASM / so（= 真正 AOT 链路）
- TS 源码编译为 **wasm 模块 + JS 胶水代码**（或 so，so 由 wasm 派生）。
- 产物**不含 JS 字节码**。

### 链路 B：JS → 字节码 → 解释（引擎执行链路）
- 引擎把 **JS（运行时源码/eval）编译成内部字节码**（quickjs 字节码），由解释器执行。
- **JS 字节码必须与 JS 引擎绑定**（约束 1）。
- 本链路**无 AOT**。

**关键**：链路 A 的 wasm（TS 编译产物）≠ 链路 B 的 wasm（引擎+字节码打包）。

## ELF 形态专属约束

- **gcc 编译器可配置**：so 编译（C99→ELF）的 gcc（及 flags）必须是可配置项，
  调用方可指定 gcc 路径/版本/参数，不硬编码单一工具链。
- **编译 flag**：so 产物用 **`-O3`**（性能关键，2.47x）；**禁用 `-march=native`**
  （仅 <1% 收益却绑 CPU 特性，破坏可移植性）。`-O3` 不启用 -ffast-math，
  浮点语义保持。

## 关系与推论

- 与 standard-source-policy 一致但更宽：WinterTC 是 qzjs 对外公开 API 的核心组成。
- AOT = 链路 A；实现 = TS 双编译(tsc + asc) + wasm2c 派生 so + qzvm 运行时。
- 推论（一律拒绝）：把字节码当稳定分发格式；跨引擎/跨版本复用旧字节码；
  依赖引擎二进制 ABI 兼容或任何未公开内部面；把字节码→C99 翻译当作 qzjs 的 AOT；
  使用 Perry 或任何需改造上游源码的第三方 TS 编译器；so 产物用
  `-march=native` 等破坏可移植性的编译 flag。

## 不变量（六个月仍需成立的判据）

- 不存在「standalone bytecode artifact」发行物。
- 外部消费者只能依赖 qzjs 对外公开 API（JS 形态，含 WinterTC）或 WASI（wasm 形态）。
- ELF = JS 字节码 + qzjs 运行时 + so；独立 wasm = JS 字节码 + qzjs 运行时 + wasm。
- so 产物用 `-O3` 编译且不使用 `-march=native`（可移植）。
- 引擎/字节码任何二进制接口均无跨版本兼容承诺。
- 链路 A（AOT）与链路 B（字节码）不相交，不可互相代入。
- AOT 编译器为现成工具（tsc / asc / wasm2c / wamrc），不依赖需改造上游源码的
  第三方编译器。

## 术语澄清

- 「稳定 API」= qzjs 对外公开的 API 集合（以公开文档/公开头/公开导出符号为准），
  WinterTC 是其核心组成但非全部。
- 「字节码」= 链路 B 的 JS 引擎内部字节码；链路 A 的 TS→wasm 产物不含字节码。
- 「AOT」= 链路 A 的实现（TS 双编译 + wasm/so）；字节码 native 翻译不叫 AOT。


## Timeline

- time: 2026-10-07T15:07:14
  kind: decision
  summary: "Created this page: 发行产物拓扑：字节码永不独立发行，唯一稳定 API = WinterTC"
  source: "2026-10-07 用户拍板"
  affects: [release-artifact-topology]

- time: 2026-10-07T15:07:28
  kind: decision
  summary: "发行产物拓扑：字节码永不独立发行，唯一稳定 API = WinterTC；三种产物形态（ELF/Wasm/JS+Wasm）"
  source: "2026-10-07 用户拍板"
  affects: [release-artifact-topology]

- time: 2026-10-07T15:08:46
  kind: decision
  summary: "ELF 产物必须经中间 C99 层、且 gcc 编译器可配置（细化产物拓扑）"
  source: "2026-10-07 用户拍板"
  affects: [release-artifact-topology]

- time: 2026-10-07T15:10:32
  kind: reversal
  summary: "AOT 改用本路线实现：归档 qzvm-aot（Perry 路线 AOT + .jso 格式，与新拓扑『永不独立发行字节码/唯一稳定 API=WinterTC』冲突）与 wasm-ts-runtime（Perry 式 wasm 化路线，TS→wasm 部分已被本拓扑吸收）。AOT 现归入本页 ELF 形态（→C99 中间层 + 可配置 gcc）。"
  source: "2026-10-07 用户拍板"
  affects: [qzvm-aot, wasm-ts-runtime, release-artifact-topology]

- time: 2026-10-07T15:12:35
  kind: decision
  summary: "补充：永不保证二进制 ABI 兼容（JS 稳定 API 仅 WinterTC）；wasm 独立可执行文件仅保证 WASI API；JS 字节码必须与 JS 引擎绑定"
  source: "2026-10-07 用户拍板"
  affects: [release-artifact-topology]

- time: 2026-10-07T15:17:58
  kind: decision
  summary: "修正稳定面定义：稳定 API 不只 WinterTC，= qzjs 对外公开的 API（WinterTC 为其核心组成）"
  source: "2026-10-07 用户纠正"
  affects: [release-artifact-topology]

- time: 2026-10-07T15:37:51
  kind: decision
  summary: "澄清：TS→JS+WASM 链路与 JS 字节码正交，不相交；AOT 针对字节码链路"
  source: "2026-10-07 用户纠正"
  affects: [release-artifact-topology]

- time: 2026-10-07T15:41:31
  kind: decision
  summary: "AOT 定义修正：真正 AOT = 编译 TS 代码为 JS+wasm/so（链路 A）；推翻『AOT=字节码→C99』表述"
  source: "2026-10-07 用户澄清"
  affects: [release-artifact-topology]

- time: 2026-10-07T23:59:25
  kind: decision
  summary: "AOT 实现方式裁决：TS直接→C99（类型特化+纯C运算+边界调 quickjs API）最适合 quickjs；证据 22-24x vs wasm2c 8.95x vs 逐调 API 1.59x"
  source: "2026-10-07 实验四路对比 + 用户裁决"
  affects: [release-artifact-topology]

- time: 2026-10-08T01:43:22
  kind: decision
  summary: "放弃 决策：复用成本高（改上游 Rust + 特化率未知 + f64 vs int64 语义不一致），改走自研 ts2c + 自研 quickjs 运行时（qzvm.c）"
  source: "2026-10-08 用户裁决"
  affects: [release-artifact-topology]

- time: 2026-10-08T01:48:36
  kind: decision
  summary: "wasm 路线编译器选型定案：AssemblyScript（asc 现成，数值开箱原生 i64.add 零桥，@external import qzvm；已实测 PASS）；放弃 perry"
  source: "2026-10-08 AS 验证实测"
  affects: [release-artifact-topology]

- time: 2026-10-08T02:10:36
  kind: decision
  summary: "AOT 主线定案（2026-10-08 用户裁决）：TS → tsc(JS) + asc(wasm) 双编译；so 由 wasm2c(wasm) 派生；qzjs 加载 wasm 时 AOT 或运行时 JIT；ELF = JS 字节码+qzjs 运行时+so；独立 wasm = JS 字节码+qzjs 运行时+wasm。推翻旧'不经 wasm 中间层'裁决。"
  source: "2026-10-08 用户裁决"
  affects: [release-artifact-topology]

- time: 2026-10-09T00:07:11
  kind: decision
  summary: "切分器 parser 选型定案：保留 tsc API，不改造 qzvm 支持 TS（2026-10-08 用户裁决）。理由：(1) tsc 5.9.3 已实测满足切分器全部 6 项需求（TS 类型注解解析/完整 AST/类型推断 getTypeChecker/ts.transform AST 改造/createPrinter 输出/transpileModule 去注解）——端到端 43x 实测通过，非推断；(2) qzvm 改造 TS = 自造不完整的类型剥离器（只做 skip_type，无类型推断；interface/type/enum/泛型还需额外处理），要侵入引擎 parser + 长期维护 fork；(3) qzvm 改造的唯一必要条件是「AOT 工具链零 npm 依赖」，但现工具链 asc(npm)/wasm2c/apt/wamrc(cmake) 全是外部工具，tsc 多一个 npm 包不改变依赖结构。qzvm 的价值定位在执行层（跑产物：WebAssembly AOT via ext_wamr + JS 胶水，已验证 48x/68x），不在解析层。另：qzvm 改造 TS 与 JIT 弱相关——JIT 真正前置是字节码可反汇编/可重写 + 解释器类型反馈插桩 + SSA IR codegen，与 TS 解析无关。"
  source: "2026-10-08 切分器实现后复盘（实测 tsc 满足 + qzvm 不认 TS 类型注解）"
  affects: [release-artifact-topology, aot-experiment-verification]

- time: 2026-10-09T00:38:00
  kind: decision
  summary: "Perry 定位定案：只借鉴不复用（2026-10-08 用户裁决）。硬理由（实测）：qzjs 的 wasm import 机制（ext_wamr wamr_import_dispatch）要求 import 必须是 JS 函数且 wasm 参数先转 JS 值（JSValue js_args[16]）才调用——perry 的 rt.* 值是 f64 NaN-box 位型（64 位 tag 编码 JSValue），转 JS number 按 IEEE754 double 解释导致位型丢失；i64 亦不支持（ext_wamr 无 BigInt i64，实测 invalid i64 argument）。故 perry 现成产物无法在 qzjs 直接跑（bench 已在 iwasm+libqzvm native-lib 验证过 taggd-i32 ABI 路线，但那是 C native 直收 uint64_t args，不经 JS 转接；qzjs 的 import 无 raw-native 通道）。不复用的完整理由：NaN-box ABI 与 qzjs import 机制结构性不兼容 + 改造上游 Rust 成本高 + 特化率未知 + f64/int64 语义与自研路线不一致。可借鉴清单：(1) 完整 TS→wasm 技术可行性已被 perry 实证（interface/对象/数组/字符串→11188B wasm，211 rt.* import）；(2) rt.* 运行时架构（宿主提供运行时语义、业务 wasm 只 import）是 AOT 的正确形态；(3) 类型分析基础设施（proven_local_types: HashMap<u32,HirType> + hir_inferred_static_type 表达式级类型查询）是其 native 后端做类型特化的原因，也是唯一值得移植的代码资产；(4) 双后端教训（wasm 后端类型擦除慢 23-393x vs native 特化 1.2-1.9x 手写 C）——qzjs 只能走 wasm 后端故必须类型特化。路线影响：qzjs 若要支持完整 TS AOT，需自研 TS→wasm 后端且 ABI 采用 i32 tagged（qzjs 兼容，已由 bridge_test 实证 i32/f64 数值 import 全通），而非 Perry 的 NaN-box f64。"
  source: "2026-10-08 perry 完整 TS 编译 + qzjs import 机制源码分析（实测 ABI 不兼容）+ 用户裁决"
  affects: [release-artifact-topology, aot-experiment-verification]

- time: 2026-10-09T03:35:36
  kind: decision
  summary: "工程改 monorepo + 引擎切上游 quickjs-ng（2026-10-08 用户裁决，已实施验证）。(1) 结构：qzjs 单一仓库 monorepo，src/qzvm/ 为引擎定制层目录（含 src/qzvm/patches/），quickjs 保持独立 submodule 直接依赖上游 quickjs-ng（github.com/quickjs-ng/quickjs）。(2) 关键发现：原 qzvm fork（adam-ikari/qzvm）相对上游的 15 commits 中仅 2 个是私有定制——04af3f5（DAP debugger + JS_DrainPendingJobsForContext，411 行）与 82126a5（bc-reader 加固 + GC-window SEGV 防护，197 行），其余 13 个是上游 quickjs-ng 已合入的修复（直接依赖上游自动获得）。(3) 提取 2 定制为构建时 patch：src/qzvm/patches/engine-dap-debugger.patch + engine-bc-reader-harden.patch，CMake 配置时 patch -p1 应用（沿用 c99-atomics patch 机制，working-tree-only 子模块保持干净）。(4) 实施：.gitmodules url 改上游，子模块 HEAD = 上游 master c359cac；2 patch 在上游 master 3way 干净应用（无冲突）。(5) 验证：CMake 配置自动应用 c99+bc+DAP 三 patch，203 目标全量编译成功，qzjs 基础 JS 正常 + AOT 回归 numWork(2000)=44178800 与迁移前一致。DAP 功能长期需要 → patch 保留。风险：上游演进可能致 patch 冲突（维护成本，quickjs-upstream-merge-strategy 脑页有 3way rebase 先例）。"
  source: "2026-10-08 monorepo 迁移实施 + 构建验证"
  affects: [release-artifact-topology]

- time: 2026-10-09T03:41:48
  kind: decision
  summary: "锁定上游 quickjs-ng（2026-10-08）：submodule 固定到具体 commit c359cac（迁移时上游 master HEAD，含 v0.17.0 后的 13 个修复），.gitmodules 无 branch 指令故不自动跟随 master（git submodule update --remote 不会改动，仅显式 checkout 才更新）。锁定原因：上游 master 是开发分支，跟随漂移会破坏稳定性；pin 具体 commit 保证可复现构建。升级流程（未来需要时，遵循 quickjs-upstream-merge-strategy 脑页）：显式 git -C deps/quickjs-ng fetch upstream + checkout 新 commit + 2 个 qzvm patch 3way 重应用（engine-dap-debugger + engine-bc-reader-harden）+ 全量构建 + AOT 回归验证。注意：未 pin 到 v0.17.0 tag 而 pin 到 master HEAD，是因 v0.17.0 不含那 13 个修复（丢失即回归）；当前锁定 = 具体 commit，比 master 漂移稳定，比 tag 保留修复。"
  source: "2026-10-08 用户指令：锁定上游"
  affects: [release-artifact-topology]

- time: 2026-10-09T04:07:01
  kind: decision
  summary: "qzvm 边界定义（2026-10-08 用户裁决）：qzvm 只是 VM——不含 WinterTC、W3C、fs、spawn 等 API。具体：(1) qzvm = 纯 VM 引擎层：quickjs-ng 上游（submodule）+ JS 执行语义（context/debugger/wasm 运行时/字节码编译 qzc/AOT 工具链/引擎定制 patches）+ 事件循环底座（libuv 泵事件循环，属 qzvm）；(2) 不属 qzvm：WinterTC 标准库、W3C Web API、fs/spawn/http 等宿主 I/O API（这些属 qzjs 宿主/标准库层）。修正：bridge.c 移入 qzvm 部分越界——其 http_request/fs_read-write-remove-list/storage_get-set-del（I/O API，WinterTC 宿主层）不属 qzvm；仅 timeNow/hrtime/log/randomBytes/timerStart/timerStop（运行时时钟+事件循环调度）属 qzvm。bridge.c 需拆分：VM 部分（pal 机制+timer/hrtime/log/randomBytes）留 qzvm，I/O 部分（http/fs/storage）归 qzjs 宿主层。拆分成本：pal 对象统一注册 primitives，polyfill 依赖 pal 命名，拆分需重构注册逻辑 + 验证 polyfill 兼容（成本中高）。libuv 定位：作 qzvm 事件循环底座（VM 运行时依赖），但 libuv 之上的 fs/http API 属宿主层。"
  source: "2026-10-08 用户裁决：qzvm 只是 VM 不包含 WinterTC/W3C/fs/spawn"
  affects: [release-artifact-topology]

- time: 2026-10-09T04:30:08
  kind: decision
  summary: "边界修复完成（方案 B，2026-10-08）：bridge.c 移回 src/（宿主层）。原移入 qzvm 的 bridge.c 含 I/O API（http/fs/storage/spawn）不属纯 VM，但函数交错（VM timer/log/randomBytes/postMessage 与 I/O 夹在一起）+ static 可见性 + 依赖迁移使精细拆分风险高，故选整体移回 src/（用户裁决）。timer 事件循环随 bridge 归宿主（pal 由 bridge 建，pal 整体宿主层）。src/qzvm/ 现为纯 VM：aot/ context.c debugger.c debugger_dap.c ext_wamr.c ext_wasm3.c patches qzc.c（不含 fs/http/spawn/WinterTC）。验证：构建通过 + 回归。注：qzvm 引擎 submodule（deps/quickjs-ng）+ src/qzvm/（VM 语义层）为真正独立部分；libuv 事件循环底座原属 qzvm 的考量被 bridge 移回覆盖（timer 归宿主，VM 运行仍依赖 qzjs 泵事件循环——VM 与宿主运行时在单进程内一体）。"
  source: "2026-10-08 边界修复（方案 B 用户裁决）"
  affects: [release-artifact-topology]

- time: 2026-10-09T04:50:27
  kind: decision
  summary: "qzvm 功能完整自洽（2026-10-08 用户裁决）：context 生命周期（含扩展调度）归 qzvm 闭环。src/extension.c（扩展生命周期调度 init/destroy/suspend/resume，context 创建时 qz_ext_init_all 调用的核心依赖）→ src/qzvm/ext_lifecycle.c。命名修正：原 extension.c（框架调度）与 ext_*.c（具体实现 ext_compress/ext_crypto/ext_textcodec）在 src/ 根混名易混淆，改 ext_lifecycle.c 准确描述且不与 ext_* 实现或 qz_ext_registry.h（宏表）混淆。扩展机制分层：接口+注册表（include/qzjs/qz_ext_registry.h）+ 生命周期调度（src/qzvm/ext_lifecycle.c，VM 自洽）+ 扩展对象按语义（wasm 引擎扩展 ext_wamr/ext_wasm3 在 qzvm，标准库 ext_compress/crypto/textcodec 在宿主 src/）。qzvm 扩展机制：编译期注册表 QZ_EXTENSIONS 宏（三层宏展开 QZ_EXT_IF_WITH → QZ_WITH_<feature> 编译开关 → 非 NULL 或 NULL 槽），无运行时注册，QZ_EXT_FOR_EACH 跳过 NULL 槽，WAMR/WASM3 互斥。验证：构建通过 + TextEncoder 扩展回归正常。"
  source: "2026-10-08 qzvm 功能自洽 + 命名修正"
  affects: [release-artifact-topology]

- time: 2026-10-09T05:13:56
  kind: decision
  summary: "工程结构检出到 master（2026-10-09 用户裁决）：experiment/aot 分支的工程结构修改检出到 master，AOT 实验保留在 experiment/aot。master 原落后到分叉点（9ec3e2db，无独立 commit），工程 commit 与 AOT 实验交错演进且深度耦合（monorepo 移动 src/qzvm/aot），无法干净 cherry-pick 分离——采用「master 快进到 HEAD + 从 master 移除 AOT 实验」路径。master 工作树 = 纯工程结构：monorepo（src/qzvm 分层：context/debugger/debugger_dap/ext_lifecycle/ext_wamr/ext_wasm3/qzc/patches）、polyfill 迁移（src/polyfill + src/polyfill.js）、中间产物治理（polyfill 产物进 build/generated/polyfill/）、入口合并（qz_rt+qz_cli 单 ELF，src/qzjs_main.c argv 分发）。AOT 实验（src/qzvm/aot 工具链：emitter/wasm-encoder/qzvm.js/build.js + 实验数据 as_bench + 文档 ASSESSMENT/STR_BACKEND_DESIGN）完整保留在 experiment/aot 分支。master 验证：CMake 配置 + 22/22 编译 + CLI 回归（fetch/计算正常）。分支关系：master 领先 experiment/aot（多一个移除 AOT commit），experiment/aot 保留全部 AOT。"
  source: "2026-10-09 工程结构检出 master"
  affects: [release-artifact-topology]

- time: 2026-10-09T05:41:46
  kind: decision
  summary: "qzvm/qzjs 边界治理（2026-10-09）：消除 3 个 VM→宿主反向依赖。评审发现 qzvm 调宿主层 5 个函数，3 个真渗透（VM 语义实现放宿主文件）：qz_eval_internal/qz_eval_bytecode_internal（eval 核心语义）与 qz_compile（字节码编译能力）原在 src/qzjs.c，qz_get_rt_from_ctx/qz_get_rt_from_jsrt（JSContext/JSRuntime→qz_t 查询）原在 src/bridge.c。治理：新建 src/qzvm/vm_core.c（lib 源）集中这 5 个函数，CMake 加源；声明全在 qz_internal.h 共享头，宿主层经声明调用不受影响（cli.c 用 qz_compile，宿主扩展 ext_* 用 qz_get_rt_from_*）。过程 bug：qz_compile 初移 qzc.c 失败（qzc.c 是独立可执行目标 add_executable 非 libqzjs 源，lib 无定义 → cli 链接 undefined reference），改放 vm_core.c。验证：CLI eval + qzc 编译 + 构建全过。治理后 qzvm 仅剩 3 个合理宿主依赖（方案 B 裁决的桥服务）：qz_create_pal_object_ctx（pal 创建，bridge.c）、qz_polyfill_load（polyfill 字节码加载，polyfill_load.c）、qz_timer_cancel（timer，bridge.c）。依赖方向基本单向：宿主→qzvm 正常，qzvm→宿主仅桥服务。"
  source: "2026-10-09 边界评审 + 治理"
  affects: [release-artifact-topology]
