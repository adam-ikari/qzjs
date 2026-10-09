# AOT 路线评估汇总（2026-10-08，实验数据消化）

## 结论（一句话）

自研 TS→wasm（不依赖 Perry/AssemblyScript）已跑通全链，**计算密集 ~70x、对象计算 ~70x、字符串慢 14x**，但 tagged i32 数值域仅 31 位有效——AOT 是"数值/计算热点加速器"，不是通用 TS 加速。
> **注**：f64 tagged（后续优先级 1）须按 `PORTABILITY_32BIT.md` 的 target-aware 约束实现，不能写死 f64。

## 路线演进（决策链）

| 阶段             | 结论                                                                                    | 证据                        |
| ---------------- | --------------------------------------------------------------------------------------- | --------------------------- |
| 发行拓扑         | AOT = 链路 A（TS→JS+wasm）；so 由 wasm2c 派生                                           | release-artifact-topology   |
| AS 路线          | 数值 68x 但**真实代码 AS 化率 0%**（effect/trpc/noble 全 0，因 bigint/对象/字符串）     | 真实 4 库 241 函数实测      |
| Perry            | **只借鉴不复用**——NaN-box ABI 与 qzjs import 机制（JS 函数 + 参数转 JS 值）结构性不兼容 | bridge_test + ext_wamr 源码 |
| **完整 TS→wasm** | 自研 encoder/emitter/qzvm，覆盖完整 TS（不限严格类型）                                  | 切片1/2 实测                |

## 性能画像（qzjs 内 AOT vs 解释器）

| 负载                        | 倍率                | 机制                             |
| --------------------------- | ------------------- | -------------------------------- |
| 纯数值（fib/sum bench3000） | **68.6x**           | 裸 i32 + 原生指令，零跨界        |
| 对象计算（r.id+r.sq）       | **~70x**            | guard 特化命中 number → 原生     |
| 混合三档（数值/均衡/对象）  | **68-74x**          | guard 全命中                     |
| 字符串拼接（s=s+i, 8000）   | **0.07x（慢 14x）** | guard 回退 qz.add 跨界，每轮边界 |

## 优化演进（动态路径 0.18x → ~70x）

| 步骤           | 机制                              | sumXY(30000) |
| -------------- | --------------------------------- | ------------ |
| 全跨界（起点） | 每运算/属性 qz.\*                 | 74ms(0.135x) |
| POJO           | 对象字段 wasm 内存，属性 i32.load | 71ms         |
| guard 特化     | tagged number 运算原生            | 28ms(0.36x)  |
| 条件去冗余     | wasm eqz 替代 qz.truthy           | 21ms(0.48x)  |
| alloc 内联     | bump 移入 wasm 全局               | 16ms(1.06x)  |

## 已知限制（诚实标注）

1. **tagged i32 31 位有效**（i32<<1）：sum>2^30 溢出（objWork(3000) AOT 410064408 vs 解释器 8999999000）。与 TS number（double 53 位）不对齐。
2. **字符串拼接跨界**（guard 回退 qz.add）：慢 14x，wasm 内拼接是独立工程（见 STR_BACKEND_DESIGN.md）。
3. **qzvm 仅 20 符号**（Perry 规模 211）——对象方法/数组方法/更多 API 未覆盖。
4. **wasm 解释模式无意义**（1.74x）——必须 AOT（wamrc）或 JIT。
5. **WAMR classic AOT 约束**：memory 必须本地定义（不能 import）、不能带 max、导出索引 0（wasm index space 独立）。

## 32 位可移植性（armv7 / riscv32 / i386）

详见 `PORTABILITY_32BIT.md`。裁决：**编译期 target-aware 表示选择**，拒绝运行时双表示。

- **64 位宿主** → f64 NaN-box（对齐 TS number），原优先级 1 方案。
- **32 位宿主** → i32 tagged 保持通用（单寄存器/4 字节字段原生最优），显式标 31 位上限；编译期探测到大数需求的模块降级 f64（仅硬浮点目标）或解释器。
- **快路径按目标位宽原生**：64 位 f64、32 位 i32（emitter 既有 `anyTagged` 分流扩为 target-aware）。
- **既有链路无 i64 污染**（emitter 零 i64、qzvm 全 32 位位运算、wasm 地址空间恒 32 位）；**唯一 64 位硬假设是 `build.js:97` wamrc 未传 `--target`** → 32 位支持的前置修复。
- f64 在软浮点/D16/ilp32f 目标是 10–30x 算术回退 + 对象字段内存翻倍（8B vs 4B）；仅在硬浮点 D32/ilp32d 可接受。

## 方法论教训

1. **常量折叠假数据**：bench 参数须随循环变化（fib(25) 恒定 → LLVM 折叠出荒谬 677x）
2. **幸存者偏差**：自写样本 35% AS 化率 vs 真实库 0%——必须用真实代码验证
3. **wasm 二进制细节**：index space 独立（memory=0 非 imports+funcs）、memory 段 count 字节、export kind（memory=0x02）
4. **host_fn 空转**：未传参 → bench(0)

## 组件（aot/ 最小实现）

| 文件            | 职责                                                        |
| --------------- | ----------------------------------------------------------- |
| wasm-encoder.js | wasm 二进制生成（6 段 + 指令最小集 + 本地 memory + global） |
| emitter.js      | tsc AST → wasm 栈式（双模式：裸 i32 快路径 / tagged 动态）  |
| qzvm.js         | qz.\* 运行时（JS 侧，20 符号 + tagged 编解码 + handle 表）  |
| splitter.js     | AS 切分器（历史，已被完整 TS→wasm 取代）                    |
| bridge_test     | wasm↔qzjs 能力对接验证                                      |

## 后续（按优先级）

1. **f64 tagged**（解决 31 位溢出，对齐 TS number）——**按 `PORTABILITY_32BIT.md` target-aware 实现**：64 位宿主 f64、32 位宿主 i32 tagged + 大数降级；前置修 `build.js` 的 wamrc `--target`。
2. **字符串后端**（wasm 内拼接，STR_BACKEND_DESIGN.md）
3. qzvm 补全（对象方法/数组）
4. 集成 qzjs 构建（编译器进 CMake/npm 流程）

## 设计文档
- `PORTABILITY_32BIT.md` — 32 位可移植性评估与 target-aware 表示裁决
