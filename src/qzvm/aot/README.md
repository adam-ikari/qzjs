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

## 使用（编译流水线）

```bash
# JS 技术栈主入口：TS → wasm → wamrc AOT → glue（一键）
node src/qzvm/aot/build.js build src.ts [name] [--main "fn(a); fn2(b)"] [--target i386 --target-abi gnu] [--debug]

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

- **JS 技术栈**：`build.js` 是唯一主入口（node 编排 compile→wamrc→glue），全部 JS（wamrc 是唯一外部后端）
- **值模型**：tagged 值 = i64 f64 NaN-box（数值=原始 f64 位型，精确 53 位；句柄=高16位 `0x7FF9`|低32 offset；字段 8 字节）。wasm f64 恒为 IEEE-754 double，32 位宿主由 wamrc 降到软/硬浮点，**数值语义含 >2^31 的整数不变**，故 32/64 位设备共用同一表示——不按目标位宽切换
- **产物分离**：`glue.js` + `.wasm` + `.aot` 三文件（不 base64 内嵌防膨胀），全部 gitignore（`build/`）
- **32 位设备交叉编译**：`.aot` 是绑宿主架构的原生 ELF；加 `--target <arch> --target-abi <abi>` 透传 wamrc（`armv7 + gnueabihf` / `riscv32 + ilp32d` / `i386 + gnu`）。表示层不变，f64 语义一致
- wamrc 查找顺序：`WAMRC` 环境变量 > `PATH` 上的 wamrc > 旧 demo 固定路径；质量门 = wamrc 编译成功（隐含 wasm 有效）

## 性能画像（三方对比：AOT vs 解释器 vs 原生 V8，本机实测 2026-10-12）

基准：`node src/qzvm/aot/bench_mix.js`（AOT 经 wamrc O3 编译，qzjs 宿主跑 wasm；
解释器 = qzjs 跑纯 JS；原生 V8 = node v24 JIT 跑同语义 JS）。
**倍速 = 对手耗时 / AOT 耗时**：>1 = AOT 更快，<1 = AOT 更慢。

| 负载                     | AOT(qzjs) | 解释器(qzjs) | 原生 V8(node) | AOT 比解释器 | AOT 比 V8    |
| ------------------------ | --------- | ------------ | ------------- | ------------ | ------------ |
| numWork(3000) 纯数值递归 | 361ms     | 48.4s        | 758ms         | **快 ~134x** | **快 ~2.1x** |
| objWork(30000) 对象循环  | 1.3ms     | 50ms         | 0.11–0.36ms   | 快 ~38x      | 慢 ~4–12x    |
| strWork(8000) 字符串拼接 | 30ms      | 5ms          | 0.12ms        | 慢 ~6x       | 慢 ~248x     |

- **numWork（数值热点）AOT 超 V8 ~2x**：wamrc LLVM O3 + 零 JIT 预热 + 裸 f64 原生指令。
- **objWork/strWork AOT 慢于 V8**：V8 隐藏类（IC）+ rope 惰性拼接碾压 wasm bump 分配/逐字节写。
- 解释器（QuickJS-ng 无 JIT）在数值负载最慢；AOT 比解释器快 ~135x。

## 已知限制
- **tagged 数值精确 53 位**（f64 NaN-box），32/64 位一致；无 31 位上限（旧 i32 模型已删，`test_aot.js` bigAcc=3e12 守此）
- 32 位设备：`build.js --target <arch> --target-abi <abi>` 交叉编译 `.aot`（i386 实测通过），表示层/f64 语义不变 — 详见 `PORTABILITY_32BIT.md`
- **字符串原生表示**：句柄 `0x7FFA`|offset，内存 `[len][utf8]`。字面量编译进 data 段（去重）；`s+x` 经 `qzs_append`（在 bump 顶则原地追加，否则新建拷贝）；数字→十进制 `qzs_numstr`——值 ≤ `0xFFFFFFFF` 走硬件 i32 div/rem，大值回退 i64（软件 libcall），负数前置 `-`。a 数 + b 串回退 `qz.string_concat`。实测 `strWork(200000)`=80ms/1.08MB（真字节写 vs node V8 rope 10ms）。**注意**：字符串拼接热路径（`s = s + x`）在 WAMR AOT 下比同字节码在 node(V8) 慢 ~12x（400k 次 1 字节追加：WAMR ~75ms / V8 ~6ms / QuickJS 解释器 ~44ms）——非 emitter 结构问题（手写等价 wasm 在 WAMR 下 ~3ns/次），属 WAMR AOT codegen 对含嵌套 block/多 local 的 wasm 的优化不足。
- **`qzvm` 数组方法**（2026-10-12）：`split` 返 wasm 原生数组（`0x7FF8`，此前返 JS 句柄 `0x7FF9` → wasm 侧 `.length` 落 `qz.str_len` 读垃圾，静默得 0）。宿主 `method_call` 加 `0x7FF8` 分派 `doArrMethod`：`indexOf`/`lastIndexOf`/`includes`/`join`/`slice`/`concat`/`reverse`/`shift`/`unshift`/`map`/`filter`/`reduce`/`forEach`/`find`/`findIndex`/`some`/`every`/`sort`/`splice`/`fill`。回调经 `qz.closure_call` 调 wasm 箭头函数；`reverse`/`sort`/`fill`/`splice`/`shift`/`unshift` 原地改写保句柄别名。`pop`/`push`/索引/`.length` 仍走 wasm 原生（零跨界）。
- **tagged 字面量 + `.length= 赋值**（2026-10-12）：`true`/`false`（→f64 0/1 位型）、`null`/`undefined`（→句柄 `0x7FF9|0`）此前 tagged 路径抛「不支持的表达式」，现补齐。数组 `.length=` 赋值经 `qz.arr_set_len`（宿主截断/扩容，扩容槽补 undefined）；POJO 的 `length` 字段仍走普通字段存储。`closure_call` 读 funcidx 改用 `DataView`（免 4 对齐——bump 偏移可非 4 倍数）。回归：`mix.literals()`=5、`mix.arrLengthSet()`=112。
- **类**（tagged 路径）：`class`/`extends`/`super()`/字段默认值/方法/继承遮蔽；方法经 `qz.method_call` 动态分派（内存 `[0]=__cls` → `classMeta` 沿父链调 wasm 导出方法）。**静态分派优化**：接收者静态精确可判时（`let/const x = new C(...)` 且 x 全程未被写、未被闭包捕获；或叶类内 `this`）沿父链解析方法 owner 后直调 `__m_<Owner>$<m>`，跳过 `qz.method_call` 跨界——仅限有返回值、非 setter 的普通方法。ctor 与方法统一 `self+4` 固定实参签名，独立方法最多 4 参。合成派生 ctor 转发全部参数。POJO 字面量字段与类字段共用一个全局字段表（`fieldMap`），实例 size 取全表最大偏移。num 快路径不支持 `new`（`funcMode` 自动降级 tagged）。
- wasm 解释模式无意义，必须 AOT（wamrc）或 JIT

## 历史路线（已被取代并删除，见 git 历史）

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
