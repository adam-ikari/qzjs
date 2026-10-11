# AOT 路线评估汇总（2026-10-08，实验数据消化）

## 结论（一句话）

自研 TS→wasm（不依赖 Perry/AssemblyScript）已跑通全链，**计算密集 ~70x、对象计算 ~70x、字符串 wasm 内原生（无跨界）**。tagged 值采用 f64 NaN-box（精确 53 位，32/64 位宿主统一）；字符串句柄 `0x7FFA`|offset，内存 `[len][utf8]`（2026-10-11 落地）。AOT 是"数值/计算热点加速器"，也是通用 TS 加速。

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
| 纯数值（fib/sum bench3000） | **68.6x**           | 裸 f64 + 原生指令，零跨界        |
| 对象计算（r.id+r.sq）       | **~70x**            | guard 特化命中 number → 原生     |
| 混合三档（数值/均衡/对象）  | **68-74x**          | guard 全命中                     |
| 字符串拼接（s=s+i, 200000） | **wasm 原生**（80ms/1.08MB） | data 段字面量 + bump 顶原地追加，零跨界；vs node V8 rope 10ms（惰性） |

## 优化演进（动态路径 0.18x → ~70x）

| 步骤           | 机制                              | sumXY(30000) |
| -------------- | --------------------------------- | ------------ |
| 全跨界（起点） | 每运算/属性 qz.\*                 | 74ms(0.135x) |
| POJO           | 对象字段 wasm 内存，属性 i32.load | 71ms         |
| guard 特化     | tagged number 运算原生            | 28ms(0.36x)  |
| 条件去冗余     | wasm eqz 替代 qz.truthy           | 21ms(0.48x)  |
| alloc 内联     | bump 移入 wasm 全局               | 16ms(1.06x)  |

## 已知限制（诚实标注）

1. **数值运算已对齐 TS number**（tagged = f64 NaN-box，53 位；早期 i32 31 位模型已删）：`objWork(3000)` AOT 与解释器一致 = 8999999000。
2. **字符串已 wasm 内原生**（2026-10-11）：句柄 `0x7FFA`|offset，内存 `[len][utf8]`；字面量 data 段去重、`s+x` bump 顶原地追加、数字→十进制 `qzs_numstr`。原「慢 14x 跨界」已消除。a 数 + b 串仍回退 `qz.string_concat`。
3. **qzvm 仅 20 符号**（Perry 规模 211）——对象方法/数组方法/更多 API 未覆盖。
4. **wasm 解释模式无意义**（1.74x）——必须 AOT（wamrc）或 JIT。
5. **WAMR classic AOT 约束**：memory 必须本地定义（不能 import）、不能带 max、导出索引 0（wasm index space 独立）。

## 32 位可移植性（armv7 / riscv32 / i386）

详见 `PORTABILITY_32BIT.md`。裁决（2026-10-10 修订）：**单一 f64 NaN-box 表示，32/64 位宿主共用**——wasm f64 恒 IEEE-754 double，与宿主字长无关，32 位由 wamrc 降到软/硬浮点，**故 32 位设备也能精确算 >2^31 的大数**。i32 rep 与「编译期 target-aware 切换」已否（31 位静默出错）。

- **所有宿主** → f64 NaN-box（对齐 TS number 53 位），值=i64，字段 8 字节。
- **缺口**：`.aot` 是绑宿主架构的原生 ELF，要在 32 位设备跑须让 `build.js` 给 wamrc 传 `--target`（交叉编译），表示层无需改动。
- f64 在软浮点/D16/ilp32f 目标是 10–30x 算术回退 + 对象字段内存翻倍（8B vs 4B）；硬浮点 D32/ilp32d 可接受。
- **已在真实 i386 宿主实测**（`-m32` libiwasm + 最小 host，`sizeof(void*)=4`）：`big(3000)=3e12`（>2^32）解释器/AOT 两路一致，证明 32 位 f64 NaN-box 精确 —— 详见 `PORTABILITY_32BIT.md` §7。

## 方法论教训

1. **常量折叠假数据**：bench 参数须随循环变化（fib(25) 恒定 → LLVM 折叠出荒谬 677x）
2. **幸存者偏差**：自写样本 35% AS 化率 vs 真实库 0%——必须用真实代码验证
3. **wasm 二进制细节**：index space 独立（memory=0 非 imports+funcs）、memory 段 count 字节、export kind（memory=0x02）
4. **host_fn 空转**：未传参 → bench(0)

## 组件（aot/ 最小实现）

| 文件            | 职责                                                        |
| --------------- | ----------------------------------------------------------- |
| wasm-encoder.js | wasm 二进制生成（6 段 + 指令最小集 + 本地 memory + global） |
| emitter.js      | tsc AST → wasm 栈式（双模式：裸 f64 快路径 / tagged f64 NaN-box 动态） |
| qzvm.js         | qz.\* 运行时（JS 侧，20 符号 + f64 NaN-box 编解码 + handle 表；32/64 位共用） |

## 后续（按优先级）

1. **~~f64 tagged + build.js `--target`~~ 已完成**（tagged = f64 NaN-box，精确 53 位，32/64 位统一；`--target/--target-abi` 交叉编译，i386 实测通过）。
2. **~~字符串后端~~ 已完成**（2026-10-11，wasm 内表示 + 原地追加，无跨界；见 STR_BACKEND_DESIGN.md 状态标记）。
3. qzvm 补全（对象方法/数组）
4. 集成 qzjs 构建（编译器进 CMake/npm 流程）

## 设计文档
- `PORTABILITY_32BIT.md` — 32 位可移植性评估与「单 f64 表示」裁决
