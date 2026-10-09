# AOT 实验目录

qzjs 的 AOT（完整 TS → wasm）实验。当前推荐路线是**自研 TS→wasm 编译器**（`emitter.js` + `wasm-encoder.js` + `qzrt.js`），已被评估（`ASSESSMENT.md`）验证：计算密集 ~70x、对象计算 ~70x、字符串慢 14x。

## 核心组件（推荐，当前有效）

|文件|职责|状态|
|---|---|---|
|`wasm-encoder.js`|wasm 二进制生成（type/import/function/memory/global/export/code 段 + LEB128 + 指令集）|✅ 生产级（经 wasm-validate + WAMR AOT）|
|`emitter.js`|tsc AST → wasm 栈式发射。**双模式**：参数全 `number` 注解 → 裸 i32 快路径（原生指令零跨界）；含 `any`/对象/字符串 → tagged 动态路径（guard 特化 + qz.\* import）|✅ 生产级（correctness 全规模）|
|`qzrt.js`|`qz.*` 运行时（JS 侧）：tagged 编解码 + handle 表 + 20 符号（对象/字符串/算术/比较/truthy/log/alloc/bindMem）|✅ 自检通过|
|`ASSESSMENT.md`|全部实验数据消化：性能画像/限制/方法论教训/后续优先级|✅ 评估权威|
|`bridge_test.as.ts` + `bridge_test.js`|wasm↔qzjs 能力对接验证（host import 机制实证）|参考|

## 使用

```bash
# 编 TS → wasm（写 out.wasm + 返回 strings 表）
node -e "const {compileTS}=require('./aot/emitter.js');
         const fs=require('fs');
         const r=compileTS('src.ts','out.wasm',{});
         fs.writeFileSync('out.strings.json', JSON.stringify(r.strings));"

# AOT 编译（WAMR，须本地 memory + 无 max + 导出索引 0）
wamrc -o out.aot out.wasm

# qzjs 跑（glue：makeQz(strings) + instantiate{ qz }, {aot} + 调导出）
```

## 性能画像（qzjs 内 AOT vs 解释器）

|负载|倍率|机制|
|---|---|---|
|纯数值（fib/sum）|68.6x|裸 i32 原生指令|
|对象计算（guard 命中 number）|~70x|guard 特化原生|
|混合计算|68-74x|guard 全命中|
|字符串拼接|0.07x|guard 回退 qz.add 跨界|

## 已知限制
- **tagged i32 31 位有效**（`i32<<1`）：`sum > 2^30` 溢出，大数需 f64 tagged 或 handle 降级
- 字符串拼接跨界慢 14x → 设计见 `STR_BACKEND_DESIGN.md`（独立实现计划）
- `qzrt` 20 符号（对象方法/数组方法未覆盖）
- wasm 解释模式无意义，必须 AOT（wamrc）或 JIT

## 历史路线（已被取代，保留作参考/对比）

|路线|产物|为何被取代|
|---|---|---|
|**ts2c → C99**（so 路线）|`ts2c.py`/`gen_ts2c.py` + `*.c` + `host*.c` + `build_ts2c.sh`|TS→wasm 统一产物 + 双分发（wasm/so 派生）；TS 直编 C99 不再主路径|
|**AS 切分器**（strict 类型子集）|`splitter.js` + `*.as.ts` + `qzrt.c`(C 版 native-lib)|真实代码 AS 化率 0%（bigint/对象/字符串）；完整 TS→wasm 无此限制|
|**wasm2c 中间产物**|`ab3k.c`/`as_fib.c`/`wrap_*.c`/`bench_re.wat` 等|so 由 wasm 派生的早期实验|

## 设计文档
- `SPLITTER_DESIGN.md` — AS 切分器设计（历史路线）
- `STR_BACKEND_DESIGN.md` — 字符串后端优化设计（独立实现计划）

## 测试
- `mix.ts` — 混合负载（数值 + 对象计算），实测 ~70x
- `strwork.ts` — 字符串拼接，实测慢 14x
- `algo.ts`/`strproc.ts`/`objbiz.ts` — AS 化率抽样样本（历史）
