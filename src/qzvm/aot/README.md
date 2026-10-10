# AOT 实验目录

qzjs 的 AOT（完整 TS → wasm）实验。当前推荐路线是**自研 TS→wasm 编译器**（`emitter.js` + `wasm-encoder.js` + `qzvm.js`），已被评估（`ASSESSMENT.md`）验证：计算密集 ~70x、对象计算 ~70x、字符串慢 14x。

## 核心组件（推荐，当前有效）

|文件|职责|状态|
|---|---|---|
|`wasm-encoder.js`|wasm 二进制生成（type/import/function/memory/global/export/code 段 + LEB128 + 指令集）|✅ 生产级（经 wasm-validate + WAMR AOT）|
|`emitter.js`|tsc AST → wasm 栈式发射。**双模式**：参数全 `number` 注解 → **裸 f64 快路径**（原生指令零跨界）；含 `unknown`/对象/字符串 → tagged 动态路径（guard 特化 + qz.\* import）。tagged 值 = i64 **f64 NaN-box**（数值=原始 f64 位型→原生 f64 指令零跨界；句柄=高16位 `0x7FF9`；字段 8 字节；精确 53 位）。表示与宿主字长无关，32/64 位共用|✅ 生产级|
|`qzvm.js`|`qz.*` 运行时（f64 NaN-box；i64/BigInt 跨界）。32/64 位宿主共用|✅ 自检通过|
|`ASSESSMENT.md`|全部实验数据消化：性能画像/限制/方法论教训/后续优先级|✅ 评估权威|
|`build.js`|编译流水线：TS→wasm→wamrc AOT→自包含 glue.js（`--target` 支持 32 位交叉编译）|✅ 一键|

## 使用（编译流水线）

```bash
# JS 技术栈主入口：TS → wasm → wamrc AOT → glue（一键）
node src/qzvm/aot/build.js build src.ts [name] [--main "fn(a); fn2(b)"] [--target i386 --target-abi gnu]

# 产物（统一到工程 build/aot/，AOT_OUT_DIR 可覆盖）
build/aot/<name>.{wasm,aot,glue.js}   # 分离三文件（不 base64 内嵌）

# 运行（glue + wasm + aot 同目录；glue 经 fs.readFileBinary 异步读）
cd build/aot && qzjs <name>.glue.js


- **JS 技术栈**：`build.js` 是唯一主入口（node 编排 compile→wamrc→glue），全部 JS（wamrc 是唯一外部后端）
- **值模型**：tagged 值 = i64 f64 NaN-box（数值=原始 f64 位型，精确 53 位；句柄=高16位 `0x7FF9`|低32 offset；字段 8 字节）。wasm f64 恒为 IEEE-754 double，32 位宿主由 wamrc 降到软/硬浮点，**数值语义含 >2^31 的整数不变**，故 32/64 位设备共用同一表示——不按目标位宽切换
- **产物分离**：`glue.js` + `.wasm` + `.aot` 三文件（不 base64 内嵌防膨胀），全部 gitignore（`build/`）
- **32 位设备交叉编译**：`.aot` 是绑宿主架构的原生 ELF；加 `--target <arch> --target-abi <abi>` 透传 wamrc（`armv7 + gnueabihf` / `riscv32 + ilp32d` / `i386 + gnu`）。表示层不变，f64 语义一致
- wamrc 查找顺序：`WAMRC` 环境变量 > `PATH` 上的 wamrc > 旧 demo 固定路径；质量门 = wamrc 编译成功（隐含 wasm 有效）

## 性能画像（qzjs 内 AOT vs 解释器）

|负载|倍率|机制|
|---|---|---|
|纯数值（fib/sum）|68.6x|裸 f64 原生指令|
|对象计算（guard 命中 number）|~70x|guard 特化原生|
|混合计算|68-74x|guard 全命中|
|字符串拼接|0.07x|guard 回退 qz.add 跨界|

## 已知限制
- **tagged 数值精确 53 位**（f64 NaN-box），32/64 位一致；无 31 位上限（旧 i32 模型已删，`test_aot.js` bigAcc=3e12 守此）
- 32 位设备：`build.js --target <arch> --target-abi <abi>` 交叉编译 `.aot`（i386 实测通过），表示层/f64 语义不变 — 详见 `PORTABILITY_32BIT.md`
- 字符串拼接跨界慢 14x → 设计见 `STR_BACKEND_DESIGN.md`（独立实现计划）
- `qzvm` 20 符号（对象方法/数组方法未覆盖）
- wasm 解释模式无意义，必须 AOT（wamrc）或 JIT

## 历史路线（已被取代并删除，见 git 历史）

|路线|为何被取代|
|---|---|
|**ts2c → C99**（so 路线，`ts2c.py`/`host*.c` 等）|TS→wasm 统一产物 + 双分发；TS 直编 C99 不再主路径|
|**AS 切分器**（strict 类型子集，`splitter.js`/`*.as.ts`/`qzvm.c` C 版）|真实代码 AS 化率 0%（bigint/对象/字符串）；完整 TS→wasm 无此限制|
|**wasm2c 中间产物**（`ab3k.c`/`wrap_*.c` 等）|so 由 wasm 派生的早期实验|

## 设计文档
- `STR_BACKEND_DESIGN.md` — 字符串后端优化设计（独立实现计划）
- `PORTABILITY_32BIT.md` — 32 位可移植性评估与「单 f64 表示」裁决（i386 实测通过）

## 测试
- `test_aot.js` — 最小 e2e 回归门：编译 TS→wasm→node WebAssembly 运行→比对期望（不依赖 wamrc）。`node src/qzvm/aot/test_aot.js`，覆盖 num 快路径 f64 语义 + tagged **f64 NaN-box**（含 bigAcc=3e12 精度断言）
- `mix.ts` — 混合负载（数值 + 对象计算），实测 ~70x
- `strwork.ts` — 字符串拼接，实测慢 14x
- （AS 化率抽样样本 algo/strproc/objbiz 已删除，数据见 ASSESSMENT）
