# AOT 32 位可移植性评估（armv7 / riscv32 / i386 / wasm32 宿主）

> 触发背景：ASSESSMENT.md「后续优先级 1」计划把 tagged i32（31 位）升级为 f64 NaN-box。
> 新约束：**AOT 必须兼容 32 位设备**。本文只出结论与约束，不含实现改动。
> 日期 2026-10-08。数据来源：wamrc-2.4.3 `--target=help`、本仓 emitter/encoder/qzvm/build.js 源码、ext_wamr.c dispatch。

## 0. 结论速览（先看这段）

| 问题 | 结论 |
| --- | --- |
| f64 tagged 在 32 位设备成本 | 硬浮点(D32/ilp32d)约 1–3x；**软浮点 / VFPv3-D16 / ilp32f 时 10–30x 算术代价 + 对象字段内存翻倍** |
| i32 tagged 在 32 位 | **天然最优**（单寄存器、无 i64 pair、无对齐）；但 31 位精度在真实 TS 负载里会**静默出错**，不能作唯一 number 表示 |
| 折衷 | **编译期按目标位宽选表示**（target-aware），**不做运行时双表示自适应** |
| 裁决 | 64 位宿主 → f64 NaN-box 单表示；32 位宿主 → i32 tagged 通用 + 大数模块降级 f64/解释器；快路径按目标位宽原生化 |
| 既有链路 64 位假设 | **wasm/emitter/qzvm 均无 i64 污染**；唯一硬编码是 `build.js:97` wamrc 无 `--target`（产物绑宿主架构） |

---

## 1. f64 tagged 在 32 位设备的成本

f64 在 wasm 里恒为 IEEE-754 double（与宿主字长无关）。成本全在 **wamrc AOT 把它降到目标 ISA 的方式**：

| 目标 | f64 降级 | 单次 add/mul 代价 | 备注 |
| --- | --- | --- | --- |
| x86_64 / aarch64 | SSE2 / 标量 FP | 1 条指令 | 基准 |
| armv7 `gnueabihf` + VFPv3-D32 | VFP double（d0–d31） | 1–2 条 | 可接受 |
| **armv7 VFPv3-D16** | 仅 8 组 d 寄存器 | 1–2 条 + **频繁 spill** | 寄存器压力，循环内退化 |
| **armv7 软浮点**（armv4–6、无 `-mfpu`） | `__aeabi_dadd/dsub/dmul/ddiv` 调用 | **~20–50 cycle** vs i32 1–2 | 10–30x，最坏 |
| riscv32 `ilp32d` | 硬件 D 寄存器 | 1–2 条 | 可接受 |
| **riscv32 `ilp32f`** | 仅单精度 F，f64 **必须占一对 F 寄存器** | 1–2 条 + 分配器压力 | 对齐约束，易 spill |
| riscv32 / mips `ilp32`（软浮点） | libgcc 软浮点调用 | 10–30x | 同 armv7 软浮点 |
| i386 默认 | x87 或 SSE2（依 CPU） | 1–3 条 | x87 栈式，寄存器压力 |

**内存代价（结构性，跨所有 32 位目标）**：NaN-box 的 f64 值在 wasm 线性内存里占 **8 字节**，i32 tagged 占 4 字节。
- 对象字段槽步长 `4 → 8`（emitter.js:353 `NF*4`、:366 `i32Store(2, i*4)`）。
- 同样对象数 → **字段内存与访存流量翻倍**。对嵌入式 32 位设备（RAM 常为 MB 级）是实质问题。

**NaN-box 位操作在 32 位上更贵**：判定「是否为数值」在 64 位宿主可一条 `i64.reinterpret_f64` + 比较；在 armv7/riscv32 上 i64 运算要 **双寄存器对**（armv7 无原生 64 位整数 ALU），一次 guard 判定拆成多条。这是 f64 方案的隐藏成本。

**WAMR 解释器 vs AOT**：fast-interp 每个 f64 op 在解释栈上压/弹 64 位（两个 uint32 槽），比 i32 op 恒定更贵；AOT（LLVM）才可能用好硬浮点。ASSESSMENT 已证「wasm 解释模式无意义（1.74x）」→ AOT 是必须，因此**目标 ISA 的浮点能力直接决定 f64 方案能否接受**。

> **1 小结**：f64 tagged 只在 **硬浮点 + D32/ilp32d** 的 32 位设备上可接受；对软浮点、D16、ilp32f 目标是数量级回退 + 内存翻倍，不划算。

---

## 2. i32 tagged（现状 31 位）在 32 位设备反而自然

- **单 32 位寄存器**承载；`<<1` / `>>>1` 是单条移位指令，全 32 位目标 1:1 映射（armv7 `LSL/LSR`、riscv32 `slli/srli`）。
- **无跨 32 位对齐问题**：不像 NaN-box 需要 i64 pair 或 8 字节对齐。
- wasm32 地址空间本身就是 32 位 → i32 handle/offset 与地址天然同宽，无截断。
- 成本：算术=i32 原生（所有目标最优）；对象字段 4 字节（内存最优）。

**31 位精度的真实影响**（结合 objWork 溢出）：

- 有效范围 `[-2^30, 2^30)` ≈ ±1.07e9。
- 安全：循环计数器、数组索引、小 ID、小规模累加（< 1e9）。
- **会静默出错**：`Date.now()`/时间戳（~1.7e12）、文件/缓冲字节偏移、大累加、`i*i` 类求和（objWork(3000) → 8 999 999 000 ≈ 2^33 溢出，AOT 得 410 064 408 vs 解释器 8 999 999 000）、任何 >2^30 的整数。
- 危险点：**溢出无异常、无 trap，直接错值**。ASSESSMENT 第 12 行的教训——AS 路线因真实代码 AS 化率 0% 被否；31 位 tagged 若作唯一表示，会把这类静默错值带进真实负载。
- 因此：**31 位 i32 是优秀的「小整数/动态」表示，但不能作 TS number 的唯一表示。**

> **2 小结**：32 位设备上 i32 tagged 是架构上最自然的表示，但精度不足是语义缺陷，必须与一个「精确大数」表示共存。

---

## 3. 折衷方案：编译期静态分流 vs 运行时双表示

**选项 A — 运行时双表示自适应**（i32 小整数 / NaN-box f64，按值切换）
- 每个算术点先判定表示（guard 分支），再走对应指令；跨表示需转换。
- 32 位上代价叠加：guard 分支 + i64 pair 位操作 + 字段内存 8 字节。
- **否决**：在 32 位设备上是「最差组合」——既付 f64 贵算术，又付 guard 开销。

**选项 B — 编译期静态分流（target-aware）**
- emitter **已具备**该机制雏形：`anyTagged`（emitter.js:253）按模块决定注册 qz.* / 建 memory；`mode==="num"` 裸 i32 快路径 vs tagged 动态路径。
- 把它从「模块级」扩为「**目标位宽感知**」：
  - 全 `number` 注解的函数 → 裸原生路径，**位宽随目标**：64 位宿主用 f64、32 位宿主用 i32（整数热点在 32 位上是 1 条指令，最优）。
  - 动态路径 → 通用 tagged 表示，位宽同样随目标选。
- 无运行时分支，静态可判定，符合 YAGNI。

**选项 C — 全 f64 单表示（原 edit_plan 默认）**
- 只在 64 位宿主成立；32 位软浮点目标不可接受（见 §1）。

**推荐：B 为骨架，按目标选 C 或「i32 tagged + 大数降级」。** 详见 §5 裁决。

---

## 4. 既有 AOT 链路里的 32 位假设（逐项核查）

| 环节 | 结论 | 证据 |
| --- | --- | --- |
| wasm 地址空间 | **32 位，无 64 位污染** | wasm spec memory index 恒 32 位；`addMemory(2)`=2 页=128 KiB（emitter.js:253） |
| emitter i64 使用 | **零**——全 i32 + `i32.load/store` | `grep i64 emitter.js` 无命中；字段访问 `i32Store(2, i*4)`（:366） |
| encoder i64 | 仅 4 处 OP 常量定义，**未被 emitter 调用** | `grep i64 wasm-encoder.js` = 4 |
| 宽度语义假设 | `NF*4` 步长、`offset<<1`、global0 bump、QZ import 全 i32 | emitter.js:353/359/366；QZ 表 :19–39 |
| qzvm.js | 全 32 位位运算（`<<1`/`>>>1`/`>>>0`/`v&1`），天然 32 位 | qzvm.js:13–18,28–29 |
| AOT 产物形态 | `.aot` = **wamrc 目标三元组绑定的原生 ELF**；要 32 位设备必须交叉编译 | build.js:97 调 wamrc；wamrc-2.4.3 支持 i386/riscv32/armv7/thumb/mips |
| **`build.js` 目标** | **缺陷**：`:97` 无 `--target`/`--target-abi` → 默认宿主 CPU 架构，产物不可跨架构分发 | build.js:91,97 |
| wasm2c→C99→.so | 可行：wasm2c（已装 `/usr/bin/wasm2c`）生成 `uint32_t` 地址 + C `double`，32 位 C 编译器可编；但继承 f64 软浮点代价 | README.md:55（历史路线） |
| ext_wamr.c | **I32/I64/F32/F64 参数与返回转换全支持，无阻塞** | :860–877 参数、:908–939 返回（已阅） |

**唯一需要修的 32 位假设在构建脚本**：加显式 `--target=<arch> --target-abi=<abi>` 并透传给 wamrc。wasm 产物本身可移植。

wamrc 可用 ABI：`gnu eabi eabihf gnueabihf msvc ilp32 ilp32f ilp32d lp64 lp64f lp64d`。
32 位常用组合：`armv7 + gnueabihf`、`riscv32 + ilp32d`、`i386 + gnu`。

---

## 5. 裁决

**采用「编译期 target-aware 表示选择」，拒绝运行时双表示。**

1. **64 位宿主（x86_64 / aarch64 / riscv64 lp64）** → f64 NaN-box 单表示（即原 edit_plan）。零额外成本，对齐 TS number 53 位。
2. **32 位宿主（armv7 / riscv32 / i386）** → **i32 tagged 保持为通用动态表示**（单寄存器、4 字节字段、无 i64 pair），**显式标注 31 位上限**；对需要 >2^30 的模块，**编译期检测**（大字面量 / 已知大范围表达式 / 时间戳 API 使用）→ 该模块整体切 f64 tagged（仅在硬浮点目标）或退回解释器执行。
3. **快路径（全 `number` 注解函数）按目标位宽原生**：64 位 → f64；32 位 → i32。emitter 既有 `anyTagged` 模块分流扩为 target-aware 常量即可。
4. **不做运行时双表示自适应**——32 位上是 guard + i64 pair + 内存翻倍的最差组合（§3-A）。

理由：正确性优先于统一性；32 位设备上 i32 是原生最优且内存最省，代价是 31 位语义上限——用「编译期探测 + 模块降级」把代价限制在真正需要大数的代码，而非全局买单。

---

## 6. 对既有 `edit_plan`（wasm-encoder / qzvm / emitter 三文件）的**新增约束项**

原 edit_plan 假设单一 f64 表示、硬编码 i32→f64 替换。加入 32 位约束后必须改为**参数化**：

1. **表示模式常量化**：引入 `NUMBER_MODE ∈ {f64, i32}`（编译期/构建期确定），而非写死 f64。
   - `f64`：字段步长 8、handle 标记 `offset<<3`、bump 增量 `NF*8`、i64 reinterpret 做 NaN-box。
   - `i32`：保持 4 / `<<1` / `NF*4`（现行为）。
   影响：emitter.js:353/359/366、字段访问所有 `i32Store/i32Load` 点。
2. **QZ import 签名参数化**：emitter.js:19–39 的 `QZ` 表 params/results 不能硬编码类型；按 `NUMBER_MODE` 生成 `["f64"]` 或 `["i32"]`。ext_wamr.c 已支持两种，无需改。
3. **qzvm.js 编解码参数化**：`isH/toJS/fromJS/tagHandle/bool/num`（qzvm.js:13–18）需按模式实现，不能只写 f64 版。
4. **guard 判定按模式分派**：f64 模式用 `f64.eq(x,x)`（NaN 判定）；i32 模式保持 `i32.and 1`。两套 fastEmit。
5. **`build.js` 增 `--target` / `--target-abi`**：透传 wamrc（:97），并在文档/产物命名标注目标架构。**否则任何 32 位支持都落不了地。**
6. **编译期大数探测**：新增阶段——扫描字面量/表达式范围，决定模块用 i32 还是降级 f64/解释器（32 位路径）。
7. **内存预算**：f64 模式字段 8 字节，32 位嵌入式需评估 RAM；建议 f64 模式**仅 64 位宿主默认开**。
8. **文档联动**：ASSESSMENT.md 已知限制第 1 条、后续优先级 1；README.md:44 性能画像——均须标注「表示随目标位宽选择」而非单一 f64 升级。

---

## 7. 未验证项（诚实标注）

- 未在真实 32 位设备/交叉编译产物上实测 f64 vs i32 倍率（表中为基于 ISA 特性的推断，标 `[INFERENCE]`）。
- 未跑 wamrc `--target=armv7` / `riscv32` 端到端（仅确认 target 列表与 ABI 可用）。
- 编译期大数探测的具体判定规则未设计。
- wasm2c 32 位 C 构建未实测。
