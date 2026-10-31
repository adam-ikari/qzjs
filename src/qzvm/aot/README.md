# AOT 实验目录

qzjs 的 AOT（完整 TS → wasm）实验。当前推荐路线是**自研 TS→wasm 编译器**（`emitter.js` + `wasm-encoder.js` + `qzvm.js`），已被评估（`ASSESSMENT.md`）验证：计算密集 ~130x、对象计算 ~50x、字符串 wasm 内原生表示（原地追加，无跨界）。

## 核心组件（推荐，当前有效）

| 文件              | 职责                                                                                                                                                                                                                                                                                                      | 状态                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `wasm-encoder.js` | wasm 二进制生成（type/import/function/memory/global/export/code 段 + LEB128 + 指令集）                                                                                                                                                                                                                    | ✅ 生产级（经 wasm-validate + WAMR AOT）                                                                           |
| `emitter.js`      | tsc AST → wasm 栈式发射。**双模式**：参数全 `number` 注解 → **裸 f64 快路径**（原生指令零跨界）；含 `unknown`/对象/字符串 → tagged 动态路径（guard 特化 + qz.\* import）。tagged 值 = i64 **f64 NaN-box**（数值=原始 f64 位型→原生 f64 指令零跨界；对象句柄=高16位 `0x7FF9`；**字符串句柄=高16位 `0x7FFA` | 低32 = data段/堆 offset**，内存 `[len:i32 LE][utf8]`；字段 8 字节；精确 53 位）。表示与宿主字长无关，32/64 位共用 | ✅ 生产级 |
| `qzvm.js`         | `qz.*` 运行时（f64 NaN-box；i64/BigInt 跨界）。32/64 位宿主共用                                                                                                                                                                                                                                           | ✅ 自检通过                                                                                                        |
| `ASSESSMENT.md`   | 全部实验数据消化：性能画像/限制/方法论教训/后续优先级                                                                                                                                                                                                                                                     | ✅ 评估权威                                                                                                        |
| `build.js`        | 编译流水线：TS→wasm→wamrc AOT→自包含 glue.js（`--target` 支持 32 位交叉编译）                                                                                                                                                                                                                             | ✅ 一键                                                                                                            |

`emitter.js` 已按职责拆到 `emit/`（薄入口只做转发，`require("./emitter.js")` 调用面不变）：

| 文件                    | 职责                                      | 依赖 |
| ----------------------- | ----------------------------------------- | ---- |
| `emit/consts.js`        | qz.\* 契约面、名字编码、内建全局集、源码文本工具 | — |
| `emit/layout.js`        | 堆/字符串/数组布局常量、mem 辅助发射      | consts |
| `emit/emitter.js`       | Emitter 核心：AST → wasm 指令             | layout |
| `emit/tagged-core.js`   | tagged 公共方法（属性名折叠、arena 释放、字符串 id），副作用挂 prototype | layout, emitter |
| `emit/tagged.js`        | tagged 模式发射：动态值语句/表达式         | 以上全部 |
| `emit/compile-ts.js`    | 多文件收集/契约分析/两趟发射主流程         | 以上全部 |

依赖单向无环；`tagged.js` 以副作用挂 `Emitter.prototype`，故 `compile-ts.js` 顶部 require 它。

## 使用（编译流水线）

```bash
# JS 技术栈主入口：TS → wasm → wamrc AOT → glue（一键）
node src/qzvm/aot/build.js build src.ts [name] [--main "fn(a); fn2(b)"] [--target i386 --target-abi gnu] [--debug]
**多文件**：`compileTS` 用 tsc `createProgram` 解析 import 图，把入口可达的全部 `.ts` 顶层函数/类编进
**同一个** wasm 模块（跨文件调用 = 同模块内 `call`，不引入 import）。支持具名/别名、默认、命名空间
（`import * as M` → `M.member(...)`，含 `M.default`）、`import { C }` + `new C()`、re-export 链穿透；
顶层同名冲突与外部模块导入均**显式报错**。回归门 `test_aot.js` 的 `runMultiFile`。


# 产物（统一到工程 build/aot/，AOT_OUT_DIR 可覆盖）
build/aot/<name>.{wasm,wat,aot,glue.js}   # wat = wasm2wat 反汇编的可读中间产物（审计/调试）

# 仅编译（不经 wamrc）：产出 .wasm + .wat + .strings.json + .meta.json
node src/qzvm/aot/build.js compile src.ts [name] [--debug]

# 运行（glue + wasm + aot 同目录；glue 经 fs.readFileBinary 异步读）
cd build/aot && qzjs <name>.glue.js
```
**主链路直出二进制 wasm**：wamrc 只消费 wasm（不吃 wat），且 wasm↔wat 往返字节一致——
wat 仅作按需旁路中间产物，不进编译链路。
**`--debug`（可选）**：生成 name 段（函数名 + 局部变量名）→ wat/wasm 反汇编显示
`func $fib` / `call $fib` / `param $n` / `local $i` / `local.get $i`，而非编号
`(;29;)` / `call 29` / `local.get 3`；不影响执行，默认关闭。
**DWARF（随 `--debug`）**：额外产 `.debug_abbrev/.debug_info/.debug_line/.debug_str` custom 段
（DWARF4，addr_size=4，`wasm-dwarf.js`），供打了 `lldb_wasm.patch` 的定制 lldb 做源码级断点/步进。
地址约定 = **code 段 payload 起始的相对偏移**（与 clang wasm 后端一致）；WAMR debug-engine 报的 PC 是文件
绝对偏移，lldb 侧负责重定位。行映射由 emitter 在每个语句 `markLine` 累积。回归门：`test_aot.js` 的 `runDwarf`。
**`--no-aot`（可选，调试用）**：`glue` 只加载 `.wasm`（纯 bytecode），不读 `.aot`。WAMR debug-interp
直接拒绝 AOT 实例（`Attempt to create a debug instance for an AOT module`），故 GDB-RSP 调试运行须此模式。
全链回归门：`test/test_wamr_debug_rsp.sh`（debug 构建 + DWARF 行地址断点 + 命中断言）。

**`--interp <fn1,fn2>`（可选）：把指定函数**从 wasm 里摘出去**，退到宿主解释器跑**（同一个
qzjs 进程内的 qzvm），调用者经传递闭包一并退（`.ts` 里没有 wasm 函数索引可指）。glue 内联
transpile 出的 JS（去类型 + 去模块语法），`__call` 对 `mode === "interp"` 直接走它。
**何时用**：`s = s + i` 这类累加器现已能**原地追加**（走 `qzs_append` 的 bump-顶分支），
复杂度 O(n)——实测 strWork(200000) **28ms**（修复前 ∵ 每轮 `qz.str_dup` 复制整串，
是 Θ(n²)，N>2291 直接 arena 溢出崩溃）。原地追加的前提由 `_strAccSetOf` 逃逸分析判定：
仅当变量只作自身赋值目标 / 赋值右侧 / 只读访问 / **函数末尾纯返回**时才安全；
别名（`const a = s` 后再 `s = s + …`）、自拼接（`s = s + s`）、循环内提前 return、
多 return 分支一律回退复制。新增边界语料见 `audit_corpus4.js` 的 `str-acc-*`。
**何时仍用 `--interp`**：单次拼接但字符串不走累加器模式（每次都是不同临时量）、
或依赖 `qz.string_concat` 宿主语义的复杂插值。纯数值/对象循环不要加
（numWork 30x / objWork ~3x 对解释器）。
`compile` 子命令同样支持；产物多一个 `<name>.interp.js`。

- **JS 技术栈**：`build.js` 是唯一主入口（node 编排 compile→wamrc→glue），全部 JS（wamrc 是唯一外部后端）
- **值模型**：tagged 值 = i64 f64 NaN-box（数值=原始 f64 位型，精确 53 位；句柄=高16位 `0x7FF9`|低32 offset；字段 8 字节）。wasm f64 恒为 IEEE-754 double，32 位宿主由 wamrc 降到软/硬浮点，**数值语义含 >2^31 的整数不变**，故 32/64 位设备共用同一表示——不按目标位宽切换
- **产物分离**：`glue.js` + `.wasm` + `.aot` 三文件（不 base64 内嵌防膨胀），全部 gitignore（`build/`）
- **32 位设备交叉编译**：`.aot` 是绑宿主架构的原生 ELF；加 `--target <arch> --target-abi <abi>` 透传 wamrc（`armv7 + gnueabihf` / `riscv32 + ilp32d` / `i386 + gnu`）。表示层不变，f64 语义一致
- wamrc 查找顺序：`WAMRC` 环境变量 > `PATH` 上的 wamrc > 旧 demo 固定路径；质量门 = wamrc 编译成功（隐含 wasm 有效）

## 性能画像（三方对比：AOT vs 解释器 vs 原生 V8，本机实测 2026-10-15）

基准：`node src/qzvm/aot/bench_mix.js`（AOT 经 wamrc O3 编译，qzjs 宿主跑 wasm；
解释器 = qzjs 跑纯 JS；原生 V8 = node v24 JIT 跑同语义 JS）。
**倍速 = 对手耗时 / AOT 耗时**：>1 = AOT 更快，<1 = AOT 更慢。

| 负载                      | AOT(qzjs) | 解释器(qzjs) | 原生 V8(node) | AOT 比解释器  | AOT 比 V8    |
| ------------------------- | --------- | ------------ | ------------- | ------------- | ------------ |
| numWork(3000) 纯数值递归  | 367ms     | 10.1s        | 748ms         | **快 ~27x**   | **快 ~2.0x** |
| objWork(30000) 对象循环   | 0.8ms     | 7.0ms        | 0.10ms        | 快 ~9x        | 慢 ~8x       |
| strWork(200000) 字符串拼接 | 26.3ms    | 26.6ms       | 6.7ms         | **~1.0x（无收益）** | 慢 ~3.9x |

- **numWork（数值热点）AOT 超 V8 ~2x**：wamrc LLVM O3 + 零 JIT 预热 + 裸 f64 原生指令。
- **objWork/strWork AOT 慢于 V8**：V8 隐藏类（IC）+ rope 惰性拼接碾压 wasm bump 分配/逐字节写。
- **strWork 在 wasm 里零收益**（独立 A/B 实测 best-of-10 × 6 轮交替：wasm 中位 28.18ms vs
  interp 回退 26.50ms）——每轮 concat 跨 `qz.string_concat` 边界，跨界税吃掉 AOT 收益。
  **故 str 放弃 wasm 化**，走 `--interp` 回退（见「使用」段）。

## 已知限制
- **tagged 数值精确 53 位**（f64 NaN-box），32/64 位一致；无 31 位上限（旧 i32 模型已删，`test_aot.js` bigAcc=3e12 守此）
- **bump arena（静态部分无 GC），大小可配**：独立档默认线性内存 40 MiB（`build.js --mem <MiB>` / `compileTS(..., {memMiB})` 覆盖），bump 堆 `[STR_BUMP=128, arenaEnd)`，字面量段 `[arenaEnd, 40MiB)`；`arenaEnd` = 总内存 40%（默认 16 MiB，4 KiB 对齐，至少留 4 MiB 给字面量段）。所有 bump 增长点经 wasm 内 `qzs_ckmem` 守卫，越过 `arenaEnd` 先调 `qz.oom` 抛 `RangeError`（宿主未抛则 `unreachable` 兜底）——绝不静默覆盖字面量段，实例存活可继续调用。`compileTS` 返回 `arenaEnd`，`build.js` 写入 `.meta.json` 的 `arena` 并由 glue 传给 `makeQzvm({arenaEnd})`，宿主 `bumpAlloc` 与 wasm 侧同界。in-module 档内存由 `src/qzvm/CMakeLists.txt` 的 `--initial-memory` 决定（64 MiB，布局 libqzvm [0,12MiB) / bumper [12,20MiB) / 字面量 [20,64MiB)），不经 `--mem`。导出 `__bump_reset()`，glue 每次 `__call` 前重置到起点：一次调用的 arena 占用与调用时长解耦。动态部分（解释器）另有 qzvm GC。
- 32 位设备：`build.js --target <arch> --target-abi <abi>` 交叉编译 `.aot`（i386 实测通过），表示层/f64 语义不变 — 详见 `PORTABILITY_32BIT.md`
- **字符串原生表示**：句柄 `0x7FFA`|offset，内存 `[len][utf8]`。字面量编译进 data 段（去重）；`s+x` 经 `qzs_append`（在 bump 顶则原地追加，否则新建拷贝）；数字→十进制 `qzs_numstr`——值 ≤ `0xFFFFFFFF` 走硬件 i32 div/rem，大值回退 i64（软件 libcall），负数前置 `-`。a 数 + b 串回退 `qz.string_concat`。**性能**：构建大串的瓶颈**不在 wasm 执行**，而在返回值/参数穿越时的 wasm 串↔JS 串转换 `qzvm._utf8`/`strWriteback`。实测 wasm 循环本体建 1.09MB 串仅 **4.7ms**，而转换占 ~90ms。旧 `_utf8` 逐字节 `r += fromCharCode` 每字符一次 JS_ConcatString（QuickJS 无 rope）→ 已改为 ASCII 快路径（`Uint32Array` 批量测高位 + `fromCharCode.apply(u8.subarray)`）+ 非 ASCII 分块解码。修后 `strWork(200000)`（1.09MB）**93ms → 30ms**，`o1`（400k 次 1 字节追加，400KB）**73ms → 12.5ms**。对照：node(V8) 跑同 wasm 快，是因 V8 的 `+=` 有 rope 优化——非 WAMR AOT codegen 问题。
- **`qzvm` 数组方法**（2026-10-12）：`split` 返 wasm 原生数组（句柄 `0x7FFB`；旧版用 `0x7FF8` 与 canonical NaN 相撞已改，详情见 ASSESSMENT） → wasm 侧 `.length` 落 `qz.str_len` 读垃圾，静默得 0）。宿主 `method_call` 按数组句柄 tag 分派 `doArrMethod`：`indexOf`/`lastIndexOf`/`includes`/`join`/`slice`/`concat`/`reverse`/`shift`/`unshift`/`map`/`filter`/`reduce`/`forEach`/`find`/`findIndex`/`some`/`every`/`sort`/`splice`/`fill`。回调经 `qz.closure_call` 调 wasm 箭头函数；`reverse`/`sort`/`fill`/`splice`/`shift`/`unshift` 原地改写保句柄别名。`pop`/`push`/索引/`.length` 仍走 wasm 原生（零跨界）。
- **tagged 字面量 + `.length= 赋值**（2026-10-12）：`true`/`false`（→f64 0/1 位型）、`null`/`undefined`（→句柄 `0x7FF9|0`）此前 tagged 路径抛「不支持的表达式」，现补齐。数组 `.length=` 赋值经 `qz.arr_set_len`（宿主截断/扩容，扩容槽补 undefined）；POJO 的 `length` 字段仍走普通字段存储。`closure_call` 读 funcidx 改用 `DataView`（免 4 对齐——bump 偏移可非 4 倍数）。回归：`mix.literals()`=5、`mix.arrLengthSet()`=112。
- **类**（tagged 路径）：`class`/`extends`/`super()`/字段默认值/方法/继承遮蔽；方法经 `qz.method_call` 动态分派（内存 `[0]=__cls` → `classMeta` 沿父链调 wasm 导出方法）。**静态分派优化**：接收者静态精确可判时（`let/const x = new C(...)` 且 x 全程未被写、未被闭包捕获；或叶类内 `this`）沿父链解析方法 owner 后直调 `__m_<Owner>$<m>`，跳过 `qz.method_call` 跨界——仅限有返回值、非 setter 的普通方法。ctor 与方法统一 `self+4` 固定实参签名，独立方法最多 4 参。合成派生 ctor 转发全部参数。POJO 字面量字段与类字段共用一个全局字段表（`fieldMap`），实例 size 取全表最大偏移。num 快路径不支持 `new`（`funcMode` 自动降级 tagged）。**类捕获**：方法/构造器/实例字段初值引用的外层变量经类 env 传递——工厂函数返回的 `class` 表达式在**每次求值点**克隆类元并各建一份 env（`qz.class_expr_value` + `class_env_get`），实例互不串值；方法自身有同名局部/形参遮蔽时挂子 env（类 env 作 `__parent`），写入不污染共享 env。**loud 边界**：函数/块内 `class` 声明（提升到模块级）、`const C = class {…}` 别名形式、静态字段初值/静态块引用非模块级局部，都读不到定义点外层绑定 → 编译期报错（改法：变量提升到模块级或改用工厂返回类表达式）；`test_aot.js` 守此。
- wasm 解释模式无意义，必须 AOT（wamrc）或 JIT

## 历史路线（已被取代并删除，见 git 历史）

> **2026-10-18 用户裁决固化**：上述三条早期路线全部否决删除，不走 AssemblyScript；
> 自研 `emitter.js`（TS→wasm）为唯一 AOT 主线。详见脑页 `release-artifact-topology`（reversal）。

| 路线                                                                    | 为何被取代                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **ts2c → C99**（so 路线，`ts2c.py`/`host*.c` 等）                       | TS→wasm 统一产物 + 双分发；TS 直编 C99 不再主路径                |
| **AS 切分器**（strict 类型子集，`splitter.js`/`*.as.ts`/`qzvm.c` C 版） | 真实代码 AS 化率 0%（bigint/对象/字符串）；完整 TS→wasm 无此限制 |
| **wasm2c 中间产物**（`ab3k.c`/`wrap_*.c` 等）                           | so 由 wasm 派生的早期实验                                        |

## 设计文档
- `STR_BACKEND_DESIGN.md` — 字符串后端优化设计（独立实现计划）
- `PORTABILITY_32BIT.md` — 32 位可移植性评估与「单 f64 表示」裁决（i386 实测通过）

## 测试
- `test_aot.js` — 最小 e2e 回归门：编译 TS→wasm→node WebAssembly 运行→比对期望（不依赖 wamrc）。`node src/qzvm/aot/test_aot.js`，覆盖 num 快路径 f64 语义 + tagged **f64 NaN-box**（含 bigAcc=3e12 精度断言）+ 类/继承
- `cls.ts` — 类回归（继承 + super + 遮蔽字段 + 合成 ctor 转发 + 多参动态分派）
- `mix.ts` — 混合负载（数值 + 对象计算），实测 ~70x
- `strwork.ts` — 字符串拼接（wasm 内原生表示），回归断言 + 性能画像
- （AS 化率抽样样本 algo/strproc/objbiz 已删除，数据见 ASSESSMENT）
