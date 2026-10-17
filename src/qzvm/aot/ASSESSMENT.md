# AOT 路线评估汇总（2026-10-08，实验数据消化）


### 批 36 三项残余的机理（2026-10-17 记录，待修）

1. **`try { return X } finally { throw Y }` → finally 执行两次**
   - 观测：`log` = `t,f1,f1,c`（finally 跑两次）。
   - 机理（已读通）：`return` 触发 `_emitPendingFinally(true, false)` 跑一次 finally（f1 #1），finally 内抛错置 `__err` 并 `br` 到**该 try 的 `$err` 块**（throw 的发射目标仍在动态 try 范围内）→ 落回 `emitTry` 的**正常路径** finally（`emitter.js:3510-3512`，未加防重入切片）→ f1 #2 → 其后的 `_emitErrCheck(false)` 再向外传播。
   - 候选修法：`_emitPendingFinally` 发射 finally 体时把 `_tryStack` 同步切到 `slice(0, i)`（使体内 throw 归向外层 try）；或给正常路径 finally 加运行时一次性守卫。**风险高（try/finally 是核心路径），需成对验证**。
2. **已修复（见 CHANGELOG「对象展开与运行时访问器」）**：`usesDynAcc` 程序下展开段一律走 `obj_merge`（此前槽级拷贝静默丢访问器键）。
3. **已修复（见 CHANGELOG「嵌套闭包内的私有名限定」）**：`_emitLambdaBody` 现同时设置 `_curClass`（源自 `lam._qzSupCtx`）。

### `arguments` 续作结论（2026-10-17，三次尝试均回退）

- **助手机制**：`qzs_*` 助手在 `emitStringHelpers(m)`（`emitter.js:~2247+`）内 `declareFunc` + `startBody/endBody` 内联；宿主需调用的助手（如新增 `qzs_setargs`）必须补 `exportFn`。
- **已验证可行的设计**（三次尝试中编译均通过）：新全局 `__args`（排在模块全局之后，不影响既有索引）作 scratch 通道 → 函数/lambda 末尾插 i64 本地（env 之前，索引 = `参数数 + decls.length - 1 - envDecls.length`）→ 入口 `globalGet → localSet` + `varMap.set("arguments", …)` → `arguments` 标识符解析该本地 → 调用点（顶层直调点 `this.m.call(this._fnName(fn))` 前）写全局；宿主 `closureCall` 对 `lamMeta.needsArgs` 的闭包经导出 `qzs_setargs` 写入。
- **卡点（第三次实测）**：`function g() { … arguments … }` 声明在 `f` 内（emitter 提升为闭包）时，`g(9,8)` 调用**未经过宿主 `closureCall`**（QZDBG 钩子未触发）→ 宿主写入路径不生效，结果从 loud 退化为**静默错值**（`undefined:undefined`）→ 按判据（静默错值劣于 loud）立即回退。
- **下一步**：先定位该调用的实际发射路径（`_emitClosureCall` 发出的 `qz.closure_call`/`qz.call_value` 之外的分支，或嵌套函数被内联为直调 `__lam_N`），再按上述设计一次完成；`lamMeta.needsArgs` 标记本身已验证正确（探针输出 `[{n:__lam_0, a:true}]`）。
## 结论（一句话）

自研 TS→wasm（不依赖 Perry/AssemblyScript）已跑通全链，**计算密集 ~130x、对象计算 ~50x、字符串 wasm 内原生（无跨界）**。tagged 值采用 f64 NaN-box（精确 53 位，32/64 位宿主统一）；字符串句柄 `0x7FFA`|offset，内存 `[len][utf8]`（2026-10-11 落地）。AOT 是"数值/计算热点加速器"，也是通用 TS 加速。

## 路线演进（决策链）

| 阶段             | 结论                                                                                    | 证据                        |
| ---------------- | --------------------------------------------------------------------------------------- | --------------------------- |
| 发行拓扑         | AOT = 链路 A（TS→JS+wasm）；so 由 wasm2c 派生                                           | release-artifact-topology   |
| AS 路线          | 数值 68x 但**真实代码 AS 化率 0%**（effect/trpc/noble 全 0，因 bigint/对象/字符串）     | 真实 4 库 241 函数实测      |
| Perry            | **只借鉴不复用**——NaN-box ABI 与 qzjs import 机制（JS 函数 + 参数转 JS 值）结构性不兼容 | bridge_test + ext_wamr 源码 |
| **完整 TS→wasm** | 自研 encoder/emitter/qzvm，覆盖完整 TS（不限严格类型）                                  | 切片1/2 实测                |

## 性能画像（qzjs 内 AOT vs 解释器，本机实测 2026-10-11）

基准：`node src/qzvm/aot/bench_mix.js`（负载同 `mixbench.ts`；每负载独立子进程隔离，glue 每次 `__call` 重置 bump）。

| 负载                        | AOT 倍率       | 机制                             |
| --------------------------- | -------------- | -------------------------------- |
| 纯数值 numWork(3000)        | **~130x**      | 裸 f64 + 原生指令，零跨界        |
| 对象计算 objWork(30000)     | **~50x**       | 条件/++ 经 guard 命中 number → 原生，零跨界 |
| 字符串拼接 strWork(8000)    | ~0.2x（vs V8） | wasm 内原生原地追加；V8 rope 惰性更快 |

> 2026-10-11 修复：此前 objWork **慢 5.6x**（AOT 292ms vs 解释器 50ms）——循环条件 `i<n` 与 `i++` 每轮各一次 `qz.truthy`/`qz.add` 跨界（30000 轮 → 60001 次 host 调用，~4.9µs/次）。修 `emitCondI32`（比较走 guard 原生 i32 谓词）+ tagged `++`（guard 化 add）。跨界计数 60001 → 0，objWork 292ms → 1ms。

## 优化演进（早期 i32-rep 时代，动态路径 0.18x → ~70x）

> 下表是 f64 NaN-box 切换**前**的历史快照（i32 rep 的 sumXY 微基准），仅存档。
> 「条件去冗余」一项当时只覆盖 num 快路径；**tagged 路径的条件与 `++` 直到 2026-10-11 才 guard 化**（见前文修复注），此前 tagged 循环每轮跨界。

| 步骤           | 机制                              | sumXY(30000) |
| -------------- | --------------------------------- | ------------ |
| 全跨界（起点） | 每运算/属性 qz.\*                 | 74ms(0.135x) |
| POJO           | 对象字段 wasm 内存，属性 i32.load | 71ms         |
| guard 特化     | tagged number 运算原生            | 28ms(0.36x)  |
| 条件去冗余     | wasm eqz 替代 qz.truthy           | 21ms(0.48x)  |
| alloc 内联     | bump 移入 wasm 全局               | 16ms(1.06x)  |

**2026-10-11 补齐（tagged 路径）**：

| 步骤              | 机制                                     | 效果              |
| ----------------- | ---------------------------------------- | ----------------- |
| 条件 guard 化     | 比较运算符产原生 i32 谓词（`emitCmpI32`） | objWork(30000) 292→1ms |
| tagged `++` guard 化 | `x++` 用 guard add（原无条件 qz.add）  | 同上（同轮跨界）  |

## 已知限制（诚实标注）

1. **数值运算已对齐 TS number**（tagged = f64 NaN-box，53 位；早期 i32 31 位模型已删）：`objWork(30000)` AOT 与解释器一致 = 8999999990000。
2. **字符串已 wasm 内原生**（2026-10-11）：句柄 `0x7FFA`|offset，内存 `[len][utf8]`；字面量 data 段去重、`s+x` bump 顶原地追加、数字→十进制 `qzs_numstr`。原「慢 14x 跨界」已消除。a 数 + b 串仍回退 `qz.string_concat`。
   - 修复（2026-10-11）：guard 谓词原只识别对象句柄 `0x7FF9`，漏字符串 `0x7FFA` → `s == "..."` 等字符串比较回落 f64（两 NaN `f64.eq` 恒 false）。抽 `_emitIsHandle`（识别两种句柄）修 `emitGuardedOp` 与 `emitCmpI32`；`s=="..."` 命中/`!=` 现正确。
3. **tagged 布尔语义收口（2026-10-11 首修，2026-10-15 彻底重做）**：比较/`!`/`&&`/`||` 曾产 tagged bool **f64 位型** 0.0/1.0 —— 与 number 混淆 → `"s"+true` 得 `"s1"`、`typeof true` 得 `"number"`、`1==true` 得 false。现 bool 用**独立 tag `0x7FFC|0/1`**（NaN-box 同族 arith-inert NaN），宿主 `toJS`/`truthy` 还原真布尔；`_emitIsHandle` 纳入 bool（参与算术时回退宿主）。
   - **逻辑运算值语义已收口（2026-10-15）**：`&&`/`||`/`||=`/`&&=` 此前在 **num 快路径**里被简化成「两侧都求值 + 结果强制 0/1」，违反 JS 语义（`5&&3` 应为 `3`，实测得 `1`；`x=5; x||=9` 应为 `5`，实测得 `1`）。现两模式统一为**真短路 + 值语义**：`a&&b ≡ truthy(a)?b:a`，`a||b ≡ truthy(a)?a:b`（右侧仅在短路决策需要时求值，结果保留操作数原值）。tagged 走 `emitShortCircuit`，num 走 `block(f64)` + `brIf`（零 import）。回归门：`test_aot.js` 的 `and_val`/`or_val`/`or_assign`/`and_assign`。
   - **原则（用户裁决 2026-10-15）**：**语义精度必须保证，不可用性能换**。任何「简化掉 JS 语义以换快路径」都按缺陷处理，不按 tradeoff 记录。
4. **`%` 已 wasm 内原生、且精确到 JS Number::remainder（2026-10-15 修）**：原 `a - b*trunc(a/b)` 再 `f64Neg` 把零余数 `+0` 翻成 `-0`（`2%2` JS=+0）、除法溢出（`1e308%1e-308`）得 NaN。新实现：零余数符号随被除数、`|b|==Inf → a`、差溢出/除零/NaN 走宿主 `qz.math_rem`（fmod 全精度）。tagged 同逻辑（guard 命中双 number 走 wasm，句柄回退 `qz.rem`）。
5. **qzvm 契约面按需注册（2026-10-15 落地）**：`QZ` 表定义 30 个符号（Perry 规模 211，对象/数组方法未覆盖），但**产物只 import 实际用到的子集**——满足 brain `[[aot-generic-compiler-target]]` 的「import 面 = 需求驱动的最小契约面」。实现：`compileTS` **两趟发射**——第一趟 `Module({collectImports:true})` 只采集 `call()`/`importFn()` 触及的 `qz.*` 名（不登记、不产字节，产物丢弃），第二趟按该子集 `registerQz(m, contract)` 后真发。必须两趟的理由：import 索引要在 `declareFunc` 之前定妥（`funcidx = codeIdx + imports.length`），无法边发射边补登记。
   - **多文件内联（2026-10-15）**：编译器不再只吃单文件——`compileTS` 用 tsc 的 `createProgram`（**现成的模块解析器**，不自研模块图遍历）拿到 `program.getSourceFiles()` 里的全部 `.ts`，把各模块顶层函数/类编进**同一个** wasm 模块（跨文件调用 = 同模块内普通 `call`）。支持：具名 + 别名导入（`import { x as y }`，本地别名折回目标导出名 `Emitter._fnName`）、默认导入（`import d from './m'` → 目标的命名默认导出；匿名默认导出显式报错）、命名空间导入（`import * as M` → `M.member(...)` 折回目标顶层名，经 `checker.getExportsOfModule` 穿透 re-export，含 `M.default`）、导入类（`import { C }` + `new C()`，`classAlias`→`_className`）、re-export 链穿透；顶层同名冲突**显式报错**（不静默覆盖）。外部模块（import 来自非源码文件）一律**显式报错**。实测：别名 `inc as bump` → `run(40)=42`、0 import；默认导入 → `105`；命名空间 → `18`；导入类 → `9`。回归门 `test_aot.js` 的 `runMultiFile` + `runInterp`（interp 跨文件模块语法重写与执行）。**未做**：`any` 对象字段访问在 num 模式函数里仍不支持（须该函数走 tagged）。
   - **跨模式调用 ABI（2026-10-15 修复）**：num 值 = f64，tagged 值 = i64（NaN-box 数值侧 = 原始 f64 位型）。此前**同模块内跨模式直调**（tagged 调 num / num 调 tagged）不插转换 → 产非法 wasm（`call[0] expected type f64, found local.get of type i64`），**实例化即崩**——凡「`: number` 纯函数」被「含字符串/对象的函数」调用（或反之）即触发，属硬崩溃。修：`fnMode` 表（顶层名 → {mode,void}）+ 三处调用点（`emitExpr` num 直调、tagged 命名空间直调、tagged 直调）逐实参插 `f64ReinterpretI64`/`i64ReinterpretF64`、返回后插逆转换。**按位重解释精确无损**（数值侧本就是同一 f64 位型，无需装箱）。回归门 `test_aot.js` 的 `runMultiFile` 跨模式两向（tagged→num=6、num→tagged=6）。类方法 `__m_*` 恒 i64 且仅 tagged 上下文可达，不涉及。
   - **funcMode 退 tagged 判据收紧（2026-10-15）**：此前 `funcMode` 只检查参数/返回类型注解 + 有无箭头/`new`，**漏了** body 里的属性访问/对象字面量/字符串字面量等 num emitExpr 不支持的表达式——如果 `: number` 参数函数体内用了 `o.value`（返回 `any`），funcMode 误判 num，emitExpr 崩溃 `不支持的表达式: PropertyAccessExpression`。现 walk 扫描 body 全部节点，任一非 num 安全表达式（PropertyAccess/ElementAccess/ObjectLiteral/ArrayLiteral/StringLiteral/Template/New/ArrowFunction/FunctionExpression/ClassExpression/Spread/TaggedTemplate/Await/Yield）→ 退 tagged。**不是「性能换语义」**——是编译器崩溃预防（不降级的后果是硬错误而非慢）。num 快路径未误伤：`fib:num`、`numWork:num` 保持。
   - **纯类型层构造擦除（2026-10-15 修复）**：`as T` / `x!`（NonNull）/ `e satisfies T` / 尖括号断言 `<T>e`（≡ as）**均是纯类型层构造，运行时恒等**（TS 在 emit 前擦除）。此前二者皆不在 emitExpr/emitTaggedExpr 的 case 里 → 出现即编译崩（`不支持的表达式: AsExpression`）；且曾把它们误列入 funcMode 的 unsafe 表 → 无害的 `(x as number)` 硬把纯数值函数推下 num 快路径（既是 bug 又损性能）。修：两 emit 路径统一解包为操作数本身，并从 unsafe 表移除。回归门 `test_aot.js` 的 `asNum`/`angleNum`/`satNum`/`nonNullNum`（各 = 6）。
   - **字符串密集型退解释器（`--interp`，2026-10-15）**：编译器支持把指定函数**从 wasm 摘出去**，退到同进程的解释器跑（`opts.interp` → `funcMeta.mode = "interp"`，wasm 里不 `declareFunc`/不 `emitFunc`；glue 内联 transpile 出的 JS，`__call` 按 mode 分派）。调用者经**传递闭包**一并退（wasm 内没有该函数的索引）。**依据（A/B 交替实测，best-of-10 × 6 轮）**：`strWork(200000)` AOT wasm 中位 **28.18ms** vs interp 回退 **26.50ms** —— wasm **零收益**（每轮 `s = s + i` 跨一次 `qz.string_concat` 边界，跨界税吃掉全部 AOT 收益）。故 `bench_mix.js` 的 `str` 负载直接放弃 wasm 化。num/obj 循环不要加（numWork 27x / objWork ~9x 对解释器）。判据**不做自动推断**（用户裁决：不用太复杂）——由使用者显式列出。
   - **NaN↔数组标签相撞（2026-10-15 修复）**：数组句柄高 16 位原为 `0x7FF8` = **canonical quiet NaN**（宿主 `box(NaN)` 恰产此位型）→ 任何 NaN 返回值（`0/0`、`"abc"-5`、`Math.sqrt(-1)`）被 `toJS`/`isArrH` 误判为数组句柄 → 静默返回 `[]`。改 `0x7FFB`（与 0x7FF9/0x7FFA 同为 arith-inert NaN payload，真实 f64 运算不产）。同步 emitter.js + qzvm.js 全部 0x7FF8 引用。
   - **字符串入参 writeback 缺失（2026-10-15 修复）**：`_fromJS` 原仅 `number→numToBits`、其余一律 `tagHandle` → 字符串入参得 0x7FF9 假句柄（而非 0x7FFA 写回），wasm 侧 `.length`/`concat` 落到 `str_len` 读垃圾，静默返回 0 / 丢操作数。改 `_fromJS = bitsOf`（复用 strWriteback/arrWriteback）。回归门：`strParam.len("abc")=3`、`strParam.cat("a",5)="a5"`、`strParam.typeof="string"`。
   - **NaN truthy（2026-10-15 修复）**：num 模式 `emitCond` 原 `x != 0` → NaN 误判 truthy（IEEE: NaN≠0 = true，但 JS `Boolean(NaN)`=false）→ `NaN ? 1 : 7` 得 1 而非 7、`NaN && 3` 得 3 而非 NaN。改 `(x != 0) && (x == x)`（IEEE: NaN≠NaN → eq=false → falsy）。回归门：`nanTruthy(0,0)=7`、`nanAnd(0,0)=NaN`、`nanOr(0,0)=9`。
6. **wasm 解释模式无意义**（1.74x）——必须 AOT（wamrc）或 JIT。
7. **WAMR classic AOT 约束**：memory 必须本地定义（不能 import）、不能带 max、导出索引 0（wasm index space 独立）。

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
3. qzvm 补全（对象方法/数组）。**数组方法已补**（2026-10-12）：`split` 返 wasm 原生数组（句柄 `0x7FFB`）；宿主 `doArrMethod` 覆盖 20 方法，回调经 `closure_call`。见 README「数组方法」条。
4. 集成 qzjs 构建（编译器进 CMake/npm 流程）
5. **能力边界（2026-10-15 审计；未实现的均显式报错非静默错）**：
   - 运算符：**`instanceof`/`void`/`**=`/`??=`（含字段/索引）已支持**；`in`/`delete`/`for...in`/动态字符串键 `o[k]` 已支持（2026-10-15）。原 `instanceof` 说明：（2026-10-15：类实例用**专用 tag `0x7FFE|memoff`**（`[off:i32]=clsId`）与 POJO `0x7FF9`/宿主句柄区分，`qz.instanceof_op` 沿「实例类 → 父链」查目标 clsId；非实例一律 false）。`in`/`void`/`delete`/`**=` 未实现；`??=` 仅 identifier（字段/索引上报错）。
   - 语法：**展开 `[...a]`/`{...o}` 已支持**（数组 wasm 内 concat 折叠；对象 `Object.assign`）；**解构声明单层已支持**（2026-10-15：`const [a,b]=arr` / `const {x,y}=obj` / `{a:z}` 重命名 / `[,b]` 跳过；数组元素 = wasm 数组索引、对象属性 = wasm POJO 字段）；**静态方法已支持**（含继承链）；**类访问器（get/set）已支持**（2026-10-16：setter 独立名 `$set`，宿主 `qz.prop_get/prop_set` 沿继承链分派，未命中退化为字段读写）；**嵌套函数声明按闭包处理**（保持声明提升/相互递归；此前整树提升丢捕获）；**`super.m()` 已支持**（静态直调父类方法）；**元数语义**（多传截断、少传补 undefined）；**解构 rest/默认值已支持**；**内建类 instanceof 已支持**；**调用实参展开 `f(...args)` 已支持**（宿主按名/闭包动态派发）；**静态字段已支持**（2026-10-16：`static x = v` 存宿主表 nameId→fieldId→tagged 值，访问点 `_emitStaticsGuard` lazy 内联初始值后 `qz.static_get`/`static_set`，含 `++C.x`/`C.x++`/`C.x += v`/继承链静态方法读写；静态字段为模块级共享状态，跨调用持久，与 JS 模块语义一致）；**字符串不可变**：拼接对「非私有累加器」左操作数先复制（`qz.str_dup`）再原地追加；私有累加器（逃逸分析判定）直接原地追加保持 O(n)。**内存开销权衡**：POJO/实例按「全局字段表容量」分配（`(字段名数+1)*8` 字节/对象），以支持运行期新增字段与未赋值字段读为 undefined——字段名极多的程序需注意 arena（8 MiB）用量；**对象字面量方法/访问器已支持**（宿主对象 + 闭包回调，2026-10-16）；**契约注意**：AOT 产物为固定元数 wasm 导出，宿主 glue 调用时须按 `funcMeta.params` 补足实参（JS 少传 = undefined；num 模式补 NaN）；**POJO 键序**：`Object.keys`/`JSON.stringify` 为「预登记字段序 + 运行期新增键」，不保证 JS 插入序；**嵌套解构**（`[[a],[b]]`/`{a:{b}}`）报错；函数内的 `class`/`function` 声明已支持（递归提升至模块级）。
   - 宿主对象 tag `0x7FFD`（2026-10-15）：`tagHandle` 值（`JSON.parse` 结果/函数/内建类实例）与 POJO `0x7FF9` 分离 → 字段读/写按 tag 分派（宿主走 `qz.object_get/set`）。
   - 内建**类**：**已支持**（2026-10-15，宿主构造）——`new Error/TypeError/RangeError/SyntaxError/ReferenceError/Map/Set/WeakMap/WeakSet/Date/Array/Object/RegExp` → 宿主句柄（0x7FFD），方法经 `method_call` 宿主分支。
   - 内建全局：**已支持**（2026-10-15）——`Math.*`（floor/ceil/round/trunc/sign/abs/sqrt/cbrt/exp/log/log2/log10/sin/cos/tan/asin/acos/atan/atan2/pow/hypot/max/min + 常量 PI/E/…）、`String`/`Number`/`Boolean`/`parseInt`/`parseFloat`/`isNaN`/`isFinite`、`JSON.stringify`/`parse`、`Object.keys`/`values`/`entries`/`assign`/`freeze`/`is`/`fromEntries`、`Array.isArray`/`from`/`of`、`Number.isInteger`/`isNaN`/`isFinite`、`String.fromCharCode`/`fromCodePoint`。实现：`qz.builtin(nameId, n, a0..a3)` 通用宿主入口（`n` = 实际参数数，变参函数不传 undefined 占位）；未列出者报「qz.builtin 未实现」。内建**类**（`new Map()`/`Set`/`Date`/`Error` 等）仍需 import 对象，未实现。
   - 位运算遇 NaN/Infinity/超 2^31 走 `i32TruncF64S` trap（JS ToInt32 应给 0/回绕）；`typeof` 对 function 值报 `"object"`（0x7FF9 低 32 位对宿主 handles 索引与 POJO 内存 offset 同空间，wasm 内无法区分）。
   - 闭包共享环境：**已实现**（2026-10-15，链式宿主 env；外层/闭包写回互相可见，含嵌套闭包与方法内 `this` 捕获）。
   - 以上均 **loud**（用户裁决：静默错优先修，loud 可暂留——故未改用 `trunc_sat`，避免引入新的静默饱和误差）。

## 设计文档
- `PORTABILITY_32BIT.md` — 32 位可移植性评估与「单 f64 表示」裁决

### 差分审计状态（2026-10-16，第五轮）

审计法：同一 TS 源 → (a) tsc 剥类型在 node 跑真 JS 作 oracle；(b) AOT 编译 wasm 跑；逐例独立编译比对。
语料：`audit_corpus.js`(47) / `audit_corpus2.js`(40) / `audit_corpus3.js`(39) / `audit_corpus4.js`(38) / `audit_corpus5.js`(28) / `audit_corpus6.js`(29) / `audit_corpus7.js`(27) / `audit_corpus8.js`(24) / `audit_corpus9.js`(25) / `audit_corpus10.js`(24) / `audit_corpus11.js`(24) / `audit_corpus12.js`(16) / `audit_corpus13.js`(20) / `audit_corpus14.js`(17) / `audit_corpus15.js`(20) / `audit_corpus16.js`(19) / `audit_corpus17.js`(18) / `audit_corpus18.js`(19) / `audit_corpus19.js`(19) / `audit_corpus20.js`(19)。
结果：**708/731 一致（96.9%）**；残余 21 项（按语料案例计；for-of 急切快照已消除；Symbol.hasInstance 已修；新增：类名作值×2 + static block（loud）、数组自定义字符串键属性 + 对象字面量方法闭包不共享 env（2 项 silent 待修））：11 项 loud + **1 项新发现静默差异**（`for...of` 急切快照 vs JS 惰性迭代，见「残余 loud 清单」注释）。（编译期/运行期显式报错，明细见「残余 loud 清单」）——**零静默错值**；另注 宿主↔wasm 闭包递归约 300 层（`node --stack-size` 可提高）；`test_aot.js` 233 checks ALL PASS；`ctest`（含 test262）32/32 全绿。

**残余 loud 清单（键序修复后，按类别 7 项 / 按语料案例 8 例，全部 loud）**

**第二十三批新增（2026-10-16）**：
- **新发现静默差异**：`for...of` 经 `qz.iter_array` **急切**快照式转 wasm 数组再迭代 → 迭代期间对 Map 的 `delete`/增删对**快照**生效（JS 迭代器是惰性的：删除项被跳过）。语义差异仅出现在「迭代 + 并发修改」模式（窄）；已记录（`map-mutate-during-iter`：wasm `abc` vs JS `ab`）。
- 其余 19/20 例通过（新数组方法/fromEntries/getter 抛错/原型遮蔽/delete 稀疏/深可选链/混合运算/模板求值序/JSON 格式/instanceof 边界/switch 表达式 case/Object.create/Number 方法/复合 while/循环变量闭包/嵌套展开/转义/可变闭包单元格）。

**第二十二批后新能力/修复（2026-10-16）**
- **顶层函数作值**（已支持，探针 2/3）：`arr.map(namedFn)`、`const h = fn; h()`、`fn.call/apply/bind` 与 JS 一致。实现：`qz.fn_value(nameId, arity)`（包装为宿主函数句柄、按 arity 补 TAG、同名缓存 `fnCacheMap`）+ 值位置发射 + `closureCall` 宿主函数句柄分支（只传真传实参）+ 函数名接收者的属性写走 `qz.prop_set`（内存快路径会把句柄低 32 位当地址 → 静默越界）。**已完成 3/3**：`fn.prop` 读回问题的根因 = `_emitStoreProp` 的 fn-value 分支在读取 `t.w`（值槽）前**未先 `localSet(t.w)`**（该函数的值入槽只发生在其它分支内）→ 写到宿主属性的值是 B 残留的 0/undefined；补一行 `M.localSet(t.w)` 即修复。
- **模块级非声明语句执行**（静默 bug 修复）：`__module_init` 此前只收集变量语句 → 模块级副作用（如 `fx.extra = 5`、任意表达式语句/if/for/try）被**静默丢弃**；现纳入 init（排除 function/class/interface/type/module/import/export/enum 声明）。
**第二十二批新暴露的两类 loud（2026-10-16）**：
- **模块级对象含访问器/方法**（`const M = (function(){ … return { get value(){…}, on(){…} } })()`）：在 start 段物化挂访问器/方法时宿主 `mem` 尚未绑定 → `Cannot read properties of null (reading 'buffer')`（与键序同源：start 段无内存）。

**方法/对象方法 >4 形参 / rest（类路径已通，对象字面量 rest 未通）**：ABI 铺路已提交（`qz.method_call` 增第 7 参 `ovf`=实参 4..，7 处发射点补位，行为中性）。剩余补丁见 `/tmp/qzaux/patch_mo2.js`（方法/静态方法签名 +`i64` 槽、`$ovf` 形参槽、`_mEnter` 的 `$ovfArg` 预留 local 与 varMap `i<4?1+i:1+params.length+(i-4)`、`_emitOvfParamUnpack` 解包、动态分派传真实溢出数组、删「方法最多 4 参」守卫）。**第二轮尝试的结论（重要，可直接复用）**：
- **local 布局 bug 已定位并修复**：`params` 必须是「前 4 个实参形参 + 补位 + `$ovf`」，即 `realParams.slice(0, 4).concat(["$p1"..].slice(0, max(0,4-len))).concat(len>4?["$ovf"]:[])`；此前写成 `realParams.concat(补位)` 导致 `params.length` 比 wasm 形参数多 1 → 之后所有 local（scratch/sT/objPool）错位 → 校验报 `expected [f64] but got [i64]`。修好后 wasm-validate 通过。
- **实参约定**：方法直调/动态分派统一采用**闭包同款**约定 —— `a0..a3` = 实参 0..3，`ovf` = **实参 3..**（`ovf[0]` = 实参 3，已在 a3）；callee 侧解包用 `ovf[i-3]`。`_emitMethodArgs(params, args)`：前 4 槽 +（形参 >4 时）`args.slice(3)` 数组 +（rest 收尾且索引 <4 时）尾部打包数组落在该槽。
- **宿主**：类方法路径需按 `m.n`/`m.rest` 重建平坦实参（`[a0,a1,a2,a3].concat(ex.slice(1))`）后 `fn(recv, ...)`；POJO 闭包方法把 `ovf` 透传 `closureCall(fv, a0..a3, ovf, recv)`（闭包 ABI 已支持 rest/>4）。`classMeta.methods[name]` 需加 `rest` 字段。
- **已通**：类方法/静态方法的 **>4 形参** 与 **rest 形参**（探针 `method-5param`、`method-rest-extra` 与 JS 一致）。关键修复：① `params` 必须「前 4 个实参形参 + 补位 + `$ovf`」（此前多留了实参 4.. 的名字 → local 全错位）；② 宿主类路径 `flat` 统一为 tagged、`arrWriteback` 只收 JS 值（`.map(toJS)`）；③ rest 数组要落在**其形参槽**（`[recv].concat(head,[arrWriteback(tail)])` 再补足 5 槽）；④ 合成方法箭头丢 rest 标记 → `_memberLambda` 显式打 `f._qzRest`，`lamMeta.rest` 认它。
- **仍未通**：**对象字面量方法（POJO 闭包）的 rest**（`objmethod-rest`）——`closureCall` 收到 `hasEx=false`，即动态分派路径的 `ovf` 没有到达该分支；下一步查 `emitter._emitDynMethod` 动态路径的 ovf 发射与宿主**闭包字段分支**的传参（`closureCall(fv, a0..a3, ovf, recv)`）是否同一条。整份 diff 备份：`/tmp/qzaux/method_ovf.patch`（旧版，226 行）。
- 踩坑：`declareFunc(...)` 是**三行**，patch 锚点若含前两行会吞掉第三参 `voidRet ? [] : ["i64"]`（两次踩到，须在替换后校验括号配平）。：
1. `arguments` 对象（建议 rest 形参）
2. generator（`function*` / `yield`）
3. async / await（需 Promise 运行时）
4. BigInt 值语义
5. 类名作值（`const C = class {}` 之外：类标识符当值传递）
7. 箭头函数内的 `super`
8. 宿主↔wasm 闭包递归约 300 层（`node --stack-size` 可提高）
9. 静态成员体内 `this.<name>` 经**派生类**调用且派生类**自有覆写**该名 → loud（本实现 `this` ≡ 定义类；未覆写时与 JS 一致，故不报错）

**已知静默差异：无（2026-10-16 清零）**
- **`Object.assign` 多源键序**：已修。根因 = 宿主 `qz.builtin` 的 `Object.assign` **专用就地合并分支**逐个写槽/extras 但**从不登记键序** → 目标对象物化时退化槽序（fieldMap 序）。修复：合并时按 JS 规则登记（已存在键保持原位、新键追加）。
- 配套（同一类问题的完整闭环）：① `qz.order_note(i64 off, i32 strId)` —— 键取 `strings[sid]`，**不触内存** → start 段（`__module_init`，此时宿主 `mem` 尚未 bindMem）也能登记模块级对象的键序（emitter 编译期已算出模块级 const 的静态键序，见 `modObjKeys`）；② 展开路径补 `qz.spread_order(dst, src)`（按源的键序表/物化视图补登记，已存在保持原位）+ 对**显式属性**发 `qz.field_order`；③ `qz.field_order`/`spread_order` 在 `!mem` 时安全 return。
- 验证：`/tmp/qzaux/corpus_oa3.js` **3/3**、`audit_corpus21.js` **18/18**。

**另：窄面 loud（避免静默错值，非缺陷残留）**：`o[带副作用] op= v` / `o[带副作用] ??= v`（重复求值风险）、`o(带副作用).f = v`、catch 解构的默认值/嵌套/rest、`o.f?.()` 之外的复杂可选链组合。

已支持（本轮新增/完善）：形参默认值·解构形参·rest 形参（调用点按形参表拆包）、let/const **每迭代绑定**（for 在增量处换层，while/for-of 在体首换层）、闭包值独立 tag 0x7FFF、对象字面量方法/访问器（宿主对象 + defineProperty 回调 wasm 闭包，成员闭包纳入捕获分析）、私有字段/方法（`#类名#名`）、静态字段继承/遮蔽与静态块与静态访问器、标签模板、正则字面量、Map/Set/Date、for-of 解构与可迭代、值调用 `qz.call_value`、嵌套解构、**跨函数 throw 传播**（调用点查 `__err`）与 try-finally 重抛、类字段统一容量 + 运行期新键 extras、字符串不可变（逃逸分析决定原地追加 / `qz.str_dup`）、数组/POJO/闭包句柄往返还原、POJO 与实例 clsId 撞号修复。

已知限制（均已记录，loud 或窄面差异）：
- （已修）**POJO/实例键序**：插入序表（`field_order`/`field_order_lit`，写/删同步）→ `Object.keys`/`for-in`/`JSON.stringify` 键序与 JS 一致。
- （已修）**属性访问 undefined/null → TypeError**：内存快路径的「未赋值/越界」分支改走宿主 `prop_get`（POJO 未赋值 → undefined；undefined/null → TypeError），调用点在**链外**统一检查 `__err`（避免破坏嵌套 if 平衡）；提取方法（`const f = o.m; f()`）因此按 JS 抛错。
- （已修）**`this` 形参模型**：TS 的 `this` 形参是**注解**（不占实参槽）→ `function (this: any, k)` 的 `k` 落在正确槽位（此前错位得 NaN）；对象字面量方法/访问器为合成箭头，其首个 `this` 参数是真实 receiver 槽（`lamMeta.synthThis`），`.call/.apply/.bind` 按此决定是否传 receiver。
- **旧**（保留说明）：（2）`Object.create` 之外的原型链方法调用 `this`、`delete` 已按接收者修正，但 `this` 未定义时不抛错；（已修）**数组迭代器**改为**惰性读内存**（`liveIter`）→ 迭代中 `push`/`length` 变化可见（JS 迭代活数组）、洞按 undefined 贡献；（4）方法内经 `this` 捕获的嵌套函数（`function` 表达式带 this 参数）个别场景捕获值为 NaN。
- **`arguments` 对象**未实现（编译期 loud，建议 rest 形参）；**闭包/lambda >4 形参**（wasm 闭包 ABI 仅 4 实参槽；顶层函数直调不限）。
- （已修）**稀疏数组洞**：数据槽以 `HOLE`(0x7FF9|2) 标记，`arrRead` 还原为真 JS 稀疏数组 → `map/filter/reduce/indexOf/join/Object.keys/JSON/for-of` 与 JS 一致（`includes` 不跳洞）。
- （已修）**POJO/实例键序**：插入序跟踪（见下）。
- 跨函数 throw 需 glue 在调用导出后调用 `qz.take_err()` 才会向宿主 JS 抛出（wasm 无法直接抛出 JS 异常）。
- 对象展开段与访问器混用、`with`/`eval`、`new.target`、`Proxy`/`Reflect`、TypedArray、`Intl`、`structuredClone` 等未支持（loud）。
- （已修）**私有成员**：私有字段不再出现在 `Object.keys`/`JSON`（JS 私有槽语义）；`P.#s` 静态私有字段读走静态路径（`statics_has`/`static_get` 键同 `#类名#名`）；`this.#m()` 私有方法调用按 `_curClass` 限定。
- **generator**（`yield`）、**async**（需 Promise 运行时）、**BigInt**（`BigIntLiteral`）→ 编译期 loud；**类对象作值**（静态方法返回类名）→ 编译期 loud。
- （已修）**类表达式**：`const C = class {…}` / `class Named {…}` 作为表达式 → 合成类名（`new C()` / `c instanceof C` 生效）；作为值使用仍 loud。
- （已修）**私有静态字段/方法**：`static #n` / `static #m()`（键 `#类名#名`，访问点同键）+ `typeof <类名>` → `"function"`。
- （已修）**闭包/函数表达式/IIFE >4 形参**：调用点 a0..a3 = 实参 0..3，第 6 参 `ovf` = 实参 3.. 数组 → 宿主按 `lamMeta.n`/`rest` 还原（固定参 + rest 打包）；值调用（变量/参数持闭包）同约定。
- **类方法与对象字面量方法 >4 形参**仍为编译期 loud（方法 ABI 只有 `self + 4` 槽；见 ASSESSMENT 限制）。
- **宿主↔wasm 闭包递归深度**：每层经 `qz.closure_call` 往返，约 300 层触 JS 栈上限（`node --stack-size` 可提高；真解是自递归直调优化）。
- （已修）**`String.raw`**：编译期按源码原文（raw 段）与 `ToString(插值)` 拼接 —— 无需 `strings.raw` 表。
- 标签模板的 **`strings.raw`**（自定义 tag 读取）仍无 `.raw` 表（wasm 数组无附加属性）→ 宿主 TypeError（loud）。

- （已修）**第 14 批发现的三项静默差异**：(1) `undefined/null` **写属性** → 走宿主 `prop_set`（TypeError）+ 链外 `_emitErrCheck`；(2) **块级 `let/const` 遮蔽** → 进入遮蔽块前把外层同名局部存入 `$shN` 槽，退出后恢复（`_collectLocals` 精确扫描遮蔽块）；(3) `find`/`pop`/`at` 等返回**元素**的方法 → `ret` 依据 `pojoOf` 还原原始 POJO/实例句柄（此前返回物化快照 → 方法调用报「无方法」、身份丢失）。**方法/静态方法 >4 形参 + rest 形参（已完整支持，2026-10-16）**：
- **签名**：方法/静态方法形参 >4 时追加第 6 槽 `ovf`（实参 3.. 数组，与闭包 ABI 同款约定：`ovf[0]` = 实参 3）。
- **关键 bug（local 布局）**：`params` 必须「前 4 个实参形参 + 补位 + `$ovf`」（`realParams.slice(0,4).concat(...)`）——此前把实参 4.. 的名字也留下 → `nParams` 多 1 → 其后所有 local（scratch/sT/objPool）错位，校验报 `expected [f64] but got [i64]`。
- **实参装配**：新增 `_emitMethodArgs(params, args)`（4 槽 + rest 打包 + >4 时 `args.slice(3)` 数组）；`_emitClosureCall` 对已知形参表同用它。
- **宿主四处**：① 类方法路径按 `m.n`/`m.rest` 重建平坦实参（`flat` 统一 tagged；`arrWriteback` 只收 JS 值 → `.map(toJS)`）；② rest 数组落在其形参槽（`[recv].concat(head,[restArray])` 补足 5 槽）；③ **宿主对象方法分支**把 `ovf` 的实参 4.. 接在 4 槽之后（`fn.apply(obj, as)`）；④ **物化方法包装器** `object_set_method` 转发 `ovf`（`args.slice(3)`）→ 否则 `closureCall` 收到 `hasEx=false`，rest 数组缺失。
- **合成方法箭头**：`_memberLambda` 显式标 `f._qzRest`（合成形参表丢 `dotDotDotToken`）→ `lamMeta.rest` 认它。
- `classMeta.methods[name]` 增 `rest` 字段。
- 验证：探针 `corpus_rest.js` **4/4**（类方法 5 形参、类方法 rest+5 实参、对象字面量方法 rest、4 形参）。

**已知静默差异（1 项）**：
- **`Object.assign` 多源键序**：多源合并时新键的追加位置与 JS 不同。最小复现（`/tmp/qzaux/corpus_oa3.js`）：
  `const base={a:1,b:2}; const over={...base,b:99,c:3}; Object.assign({}, {d:4}, over)` → JS `{"d":4,"a":1,"b":99,"c":3}`，本实现 `{"a":1,"b":99,"c":3,"d":4}`（**源被按后置优先处理**）。
  已排除：`_emitBuiltinCall` 按序压栈（非逆序）、宿主 `[a0..a3].slice(0, arity || n).map(toJS)` 参数顺序正确、双源/字面量源场景一致。
  指向：emitter 侧对 `Object.assign({}, …)` 的**对象字面量+展开**路径（`emitter.js` 展开分支按**槽序**做内存级合并 → 键序退化为 fieldMap 槽序）；或该路径与 builtin 路径的选择条件。
- 另：`defineProperty(o,k,{enumerable:false})` 的元数据按 bump epoch 存（跨宿主调用可能失效）→ `Object.keys` 可能漏过滤（探针 /tmp/qzaux/corpus_p1.js 的 hasown-nonenum）。

**已修（2026-10-16，第二十一批后）**：`JSON.parse` 结果里的数组字段此前每次读得到不同实例（wasm box 与宿主数组分离）→ 写入丢失；现宿主数组保持**宿主句柄**（`object_get`/`prop_get` 对 `Array.isArray` 值返回 `tagHandle`），元素读/写就地作用于真实 JS 数组 → 读值与 `JSON.stringify` 视图一致（探针 corpus_j1 3/3）。

**另：窄面 loud（避免静默错值，非缺陷残留）**：`o[带副作用] op= v` / `o[带副作用] ??= v`（重复求值风险）、`o(带副作用).f = v`、catch 解构的默认值/嵌套/rest、`o.f?.()` 之外的复杂可选链组合。

已支持（本轮新增/完善）：形参默认值·解构形参·rest 形参（调用点按形参表拆包）、let/const **每迭代绑定**（for 在增量处换层，while/for-of 在体首换层）、闭包值独立 tag 0x7FFF、对象字面量方法/访问器（宿主对象 + defineProperty 回调 wasm 闭包，成员闭包纳入捕获分析）、私有字段/方法（`#类名#名`）、静态字段继承/遮蔽与静态块与静态访问器、标签模板、正则字面量、Map/Set/Date、for-of 解构与可迭代、值调用 `qz.call_value`、嵌套解构、**跨函数 throw 传播**（调用点查 `__err`）与 try-finally 重抛、类字段统一容量 + 运行期新键 extras、字符串不可变（逃逸分析决定原地追加 / `qz.str_dup`）、数组/POJO/闭包句柄往返还原、POJO 与实例 clsId 撞号修复。

已知限制（均已记录，loud 或窄面差异）：
- （已修）**POJO/实例键序**：插入序表（`field_order`/`field_order_lit`，写/删同步）→ `Object.keys`/`for-in`/`JSON.stringify` 键序与 JS 一致。
- （已修）**属性访问 undefined/null → TypeError**：内存快路径的「未赋值/越界」分支改走宿主 `prop_get`（POJO 未赋值 → undefined；undefined/null → TypeError），调用点在**链外**统一检查 `__err`（避免破坏嵌套 if 平衡）；提取方法（`const f = o.m; f()`）因此按 JS 抛错。
- （已修）**`this` 形参模型**：TS 的 `this` 形参是**注解**（不占实参槽）→ `function (this: any, k)` 的 `k` 落在正确槽位（此前错位得 NaN）；对象字面量方法/访问器为合成箭头，其首个 `this` 参数是真实 receiver 槽（`lamMeta.synthThis`），`.call/.apply/.bind` 按此决定是否传 receiver。
- **旧**（保留说明）：（2）`Object.create` 之外的原型链方法调用 `this`、`delete` 已按接收者修正，但 `this` 未定义时不抛错；（已修）**数组迭代器**改为**惰性读内存**（`liveIter`）→ 迭代中 `push`/`length` 变化可见（JS 迭代活数组）、洞按 undefined 贡献；（4）方法内经 `this` 捕获的嵌套函数（`function` 表达式带 this 参数）个别场景捕获值为 NaN。
- **`arguments` 对象**未实现（编译期 loud，建议 rest 形参）；**闭包/lambda >4 形参**（wasm 闭包 ABI 仅 4 实参槽；顶层函数直调不限）。
- （已修）**稀疏数组洞**：数据槽以 `HOLE`(0x7FF9|2) 标记，`arrRead` 还原为真 JS 稀疏数组 → `map/filter/reduce/indexOf/join/Object.keys/JSON/for-of` 与 JS 一致（`includes` 不跳洞）。
- （已修）**POJO/实例键序**：插入序跟踪（见下）。
- 跨函数 throw 需 glue 在调用导出后调用 `qz.take_err()` 才会向宿主 JS 抛出（wasm 无法直接抛出 JS 异常）。
- 对象展开段与访问器混用、`with`/`eval`、`new.target`、`Proxy`/`Reflect`、TypedArray、`Intl`、`structuredClone` 等未支持（loud）。
- （已修）**私有成员**：私有字段不再出现在 `Object.keys`/`JSON`（JS 私有槽语义）；`P.#s` 静态私有字段读走静态路径（`statics_has`/`static_get` 键同 `#类名#名`）；`this.#m()` 私有方法调用按 `_curClass` 限定。
- **generator**（`yield`）、**async**（需 Promise 运行时）、**BigInt**（`BigIntLiteral`）→ 编译期 loud；**类对象作值**（静态方法返回类名）→ 编译期 loud。
- （已修）**类表达式**：`const C = class {…}` / `class Named {…}` 作为表达式 → 合成类名（`new C()` / `c instanceof C` 生效）；作为值使用仍 loud。
- （已修）**私有静态字段/方法**：`static #n` / `static #m()`（键 `#类名#名`，访问点同键）+ `typeof <类名>` → `"function"`。
- （已修）**闭包/函数表达式/IIFE >4 形参**：调用点 a0..a3 = 实参 0..3，第 6 参 `ovf` = 实参 3.. 数组 → 宿主按 `lamMeta.n`/`rest` 还原（固定参 + rest 打包）；值调用（变量/参数持闭包）同约定。
- **类方法与对象字面量方法 >4 形参**仍为编译期 loud（方法 ABI 只有 `self + 4` 槽；见 ASSESSMENT 限制）。
- **宿主↔wasm 闭包递归深度**：每层经 `qz.closure_call` 往返，约 300 层触 JS 栈上限（`node --stack-size` 可提高；真解是自递归直调优化）。
- （已修）**`String.raw`**：编译期按源码原文（raw 段）与 `ToString(插值)` 拼接 —— 无需 `strings.raw` 表。
- 标签模板的 **`strings.raw`**（自定义 tag 读取）仍无 `.raw` 表（wasm 数组无附加属性）→ 宿主 TypeError（loud）。

- （已修）**第 14 批发现的三项静默差异**：(1) `undefined/null` **写属性** → 走宿主 `prop_set`（TypeError）+ 链外 `_emitErrCheck`；(2) **块级 `let/const` 遮蔽** → 进入遮蔽块前把外层同名局部存入 `$shN` 槽，退出后恢复（`_collectLocals` 精确扫描遮蔽块）；(3) `find`/`pop`/`at` 等返回**元素**的方法 → `ret` 依据 `pojoOf` 还原原始 POJO/实例句柄（此前返回物化快照 → 方法调用报「无方法」、身份丢失）。### 已修复：对象字面量方法闭包 + 捕获数组的 push 变异不可见（2026-10-17 深查 → 根因 push/pop 快路径误命中）

最小复现：
```ts
export function f(): any { let a: any = []; const o: any = { push: (x: any) => a.push(x), get: () => a };
  o.push(1); o.push(2); return o.get().length; }   // JS 期望 2；当前得 0
```

隔离结论（均实测）：
- `a[0]=x`（索引写）跨方法可见 ✓；`a = newArr`（重赋值，env_set）跨方法可见 ✓；只读 `a[0]`/`a.length` ✓。
- **同一方法内** `a.push(); a.push(); a.length` → 2 ✓；**顶层两个独立闭包** push/len → 2 ✓。
- **仅对象字面量方法** push + 另一方法读 length → 0 ✗。
- 捕获分析正确：`_capturesOf` 对两个方法都返回 `["a"]`。
- 运行时探针：`env_get` 仅在 `get` 方法内触发（返回 0x7FFB|0x80），**push 方法内未触发** → push 的 `a.push(x)` 走的 `_emitArrayPush` 未经 env（疑似对象字面量方法体在**外围作用域内联发射**，用外围局部 `a`，与闭包 env 中捕获的 `a` 分成两条通道）。
- `_emitArrayPush` 就地增长（更新 header 的 len/cap/dataOff，不改句柄）；`_emitLambdaBody` 先建 capMap 再发射体。

下一步：定位对象字面量方法体的发射路径（是否 `_emitLambdaNew` + 延迟 lambda pass，或在外围内联），使方法体内标识符解析与闭包 env 一致。
### 已修复：rest 闭包 ≤4 实参的打包（2026-10-17，第三轮成功）

判据 = 「`a[nFix]`（nFix = meta.n-1）是 wasm 数组(0x7FFB)」→ 已打包透传；否则打包。前两轮（`meta.n===1`+全槽空判定、`a0` 判定）均因未对齐 nFix 位置而回归。

尝试：在 `closureCall` 的简单分支（`else`，≤4 实参）加 `else if (meta.rest)` —— 按 `nFix = meta.n - 1` 拆固定参 + `arrWriteback(tail)` 打包剩余。
效果：修好 `const c = (...a) => a.length`（`undefined` → `3`）与 `fn(...restArr)`（`toJS(...) is not iterable` → 正确值），但**引入 5 例回归**（corpus3/5/10/11/27：`spread-call-mixed` `many-args-abi` `rest-spread-objects` 等——`(a, ...rest)` 调用后 `rest.length` 少 1）。
根因线索：`hasEx` 分支同样用 `nFix = meta.n - 1` 且工作正常 → 两分支对 `meta.n` 的假设不一致（`lamMeta.n` 对 `(a, ...rest)` 的实际值需实测；可能含 `$ovf`/`blk` 计数差异）。
结论：**已回退**（净收益为负）。下一步用探针打印 `lamMeta.n`/`rest` 实测值再决定拆包位置。
### 已尝试并回退：动态 instanceof（2026-10-17，两次）

第二轮：判定用「可解析为局部/捕获/模块全局/属性访问」→ 仍 4 例回归（内建/非类值误判）→ 回退。重做要点：判定必须限定「确知类对象」（宿主类值/带 `__qzClsId`），并保留 loud 兜底；同时发现并修复了 `new_dynamic` 宿主缺失（HEAD 潜在缺陷）。

尝试：QZ 表加 `instanceof_dyn(x, clsObj)` + 宿主 `instanceById(obj, clsId)`（抽出 `instanceof_op` 的原型链/@@hasInstance 逻辑，二者共用）+ 发射器在 `instanceof` 右操作数非用户类名但可解析为局部/捕获/模块全局/属性访问时改走动态判定。
效果：`WebAssembly.instantiate` 报 `Import #6 qz new_dynamic: function import require…`（**导入签名/调用点不匹配**）；且 `const C = class{…}; new C() instanceof C` 由 loud 变为**静默 false**（比 loud 更差）。
结论：**已回退**。重做要点：(1) 先单独加 host 方法 + 只做发射器改动，逐步 instantiate 验证导入签名（勿一次并入 `new_dynamic` 上下文）；(2) `boxBool(false)` 兜底（`__qzClsId` 缺失时）会把 loud 降级为静默 false → 兜底应 **throw loud**；(3) 需实测 `new C()`（动态 new）产出的实例 clsId 与类对象 `__qzClsId` 是否同一（`dyn_inst` 实测 `c instanceof C` = false，`c instanceof Object` = true）。
### 动态 extends（mixin）实现方案（2026-10-17 勘察，待实现）

现状：`class X extends <运行时表达式>`（mixin：`const Tagged = (B) => class extends B {…}`）→ 发射器把 extends 的**表达式/形参名**当类名 → `call 未定义: __m_<Name>$ctor`（loud）。

关键位置（已定位）：
- 类收集 `collectClasses`：`parentName = parent.expression.text`（1430 行）→ 对 `Counted(Tagged(Base))`（CallExpression）与形参 `Base2`（非已知类）均失效。
- ctor 的 super 调用：`_emitSuperCallForward`（4858）/ 显式 super（4850）→ 静态 `M.call(ctorName(c.parent))`。
- 类值构造：`emitTaggedExpr` 的 ClassExpression 分支（`qz.class_value(id)`）+ 标识符路径（声明式类）。

实现方案（4 处，约 70–100 行）：
1. **发射时刻判定**（勿在收集期判定，避免前向引用误判）：`parentKnown = c.parent && (this.classes.has(c.parent) || BUILTIN_GLOBALS.has(c.parent))`；不已知 → 走动态路径，并保存 `c.dynParentNode = parent.expression`。
2. **ctor super → 宿主**：动态父时改发 `qz.super_ctor(clsId, self, a0..a3)`（QZ: `["i32","i64","i64","i64","i64","i64"] → []`）。
3. **类值 → class_value_dyn**：动态父类的类值构造改发 `qz.class_value_dyn(clsId, <求值父表达式>)`；声明式类在其 **statics guard** 内发一次（幂等：宿主缓存）。
4. **宿主**：新增 `classRuntimeParent: Map<clsId, baseCid>`；`class_value_dyn` 记录 + 以 baseCtor 建原型链；`super_ctor` 按 baseCid 调 `classMeta[baseCid].ctor`；**方法派发与 instanceof 的链遍历**同时走 `classRuntimeParent`（现仅走 `classMeta[c].parent`）。

验证目标：`mixin-class-factory` / `curried-class-factory`（各 1 例）；回归面 = 全语料 + ctest（class 机制用例多，须逐批核对）。

**实现进展（2026-10-17，已落地且零回归）**（4 处改动，详见 CHANGELOG）；单层 mixin 全通；链式 mixin 已修复（2026-10-17）：根因是 `_emitStaticsGuard` 在类无静态成员时提前返回 → 声明式类的动态父链未发射；现 `needsDynLink` 时必发。：4 处改动均已落地且互不冲突——发射器侧：`dynParentNode` 记录、`_emitClassValue` 统一类值发射、两处 super 调用分支、statics guard 内动态链接；宿主侧：`classRuntimeParent`、`class_value_dyn`、`super_ctor`、`chainNext` 替换 4 处类链遍历。`test_aot` 全绿、无编译错误。

- **单层 mixin**（`const T = Tagged(Base); new T()`）：越过了 `call 未定义 __m_*$ctor`，改为卡在 `instanceof T`（动态 instanceof，已回退）→ 说明 ctor 转发 + 运行时父链 + 单级方法继承均已通。
- **链式 mixin**（`class Final extends B2(A(Root)) {}` 后 `x.r()`）：报 `method_call: 类 3 无方法 r` → **运行时父链未逐级记录**。链上每一级类值的创建（`B2(A(Root))` 与 `A(Root)` 的求值）都必须在其自身构造前完成 `class_value_dyn` 记录。
- 下一步：用 `classRuntimeParent` 插桩定位缺失层级（疑点：guard 内链接的发射时机 vs `_dynParentExpr` 的「已知类」判定对链上中间层是否成立），再决定是否需在类表达式**求值点**（而非 statics guard）建立链接。
### 动态 instanceof 的**前置缺口**：局部类表达式 const 的值不是宿主类对象（2026-10-17 三轮尝试后定位）

三轮尝试（判定=可解析标识符 → 加 moduleGlobals → 加内建名回退）均在 corpus11/14/15/22 回归，回归信息完全一致：`instanceof: 右操作数不是类或内建类`。
精确复现（导出回归 DIFF）：
- corpus11 `class-expression`、corpus14 `array-methods-on-instances`、corpus15 `class-expr-heritage`、corpus22 `class-inherit-override-super`：均含**局部** `const C = class {...}` 后 `x instanceof C`。
- 早期探针曾显示 `typeof C === "function"`，但 `qz.class_value` **未被调用**（无日志）→ 该值是别的宿主函数（非构造器对象）→ 无 `__qzClsId` → 动态判定必然 loud / 静态判定必然 loud。

**结论：先修前置缺口**——绑定声明路径对 ClassExpression 初值应发射 `_emitClassValue(c)`（存宿主类对象句柄），而非跳过/存放包装器。位置线索：`_emitBindingDecl` 顶层 `ts.isClassExpression(d.initializer)` 分支现为「声明处跳过初值求值 → 存 undefined」（约 296–300 行），局部绑定另有一处同类处理。修完后再启用动态 `instanceof`（判定 + 内建回退已在 /tmp/qzaux/patch_dyninst3.js、patch_dyninst4.js 中成形且单测全对）。

（其余动态 instanceof 单测均正确：`const T=Array; [] instanceof T`、`{} instanceof Object`、`new Final() instanceof Root/Final/A(Root)`、`const T=P; p instanceof T`。）
### 类表达式作值：模块级绑定与模块初始化期约束（2026-10-17 第四轮定位，全部回退）

尝试 1（已回退）：模块级 `const C = class {…}` 的绑定处现为「跳过初值求值 → 存 undefined」（约 296–300 行）；改为存 `_emitClassValue(c)`（宿主类对象）。
结果：`instanceof <模块级类表达式>` 场景修好 2 例（corpus11/15 仍全绿），但**引入 2 例新错**：
- corpus22 `closures-module-pattern` → 宿主 `Cannot read properties of null (reading 'buffer')`：`_emitClassValue` 位于 **start 段（__module_init）**，此时宿主 **`mem` 尚未 bindMem** → 任何触内存的宿主路径都会炸。结论：模块级类对象的物化**必须延后**（例如惰性到首次取用，或在 `__module_init` 之后单发一个小函数）。
- corpus22 `prototype-chain-call` → 新 loud「`new 未知类: Dog`」：说明该改动同时干扰了类名→静态 new 的解析路径（需一并核对 `classAlias`/`_className` 与绑定初值的关系）。
其余 3 例（corpus11/15 已绿、corpus14/22 仍报 `instanceof: 右操作数不是类或内建类`）表明还有**第二类**类表达式值来源未物化（局部/别名场景）。

结论：此项需**分两步**做——(1) 先把类对象物化从 start 段移出（惰性或延后），(2) 再启用动态 `instanceof`（判定 + 内建回退的补丁已在 `/tmp/qzaux/patch_dyninst3.js`、`patch_dyninst4.js` 成形，单测全对：`const T=Array; [] instanceof T`、`{} instanceof Object`、`new Final() instanceof Root/Final/A(Root)`、`const T=P; p instanceof T`）。**已修复（2026-10-17）**：动态 instanceof 落地（`dynR` 需排除**已知类名**——模块级类亦登记为 moduleGlobals，先前四例回归即此因；宿主 `instanceById` + 内建按名回退 + loud 兜底）。mixin 语料用例的剩余阻塞另有其二：mixin 类**字段默认值**未应用（`x.inc()` → NaN）、类表达式方法**捕获外围变量**（`未定义捕获变量: v`）。
### 已修：mixin 类字段默认值未生效（2026-10-17）

根因：动态父类 `c.parent = null` → 合成 ctor 的 super 转发条件不成立 → 父类 ctor 从不执行（字段默认值在其中）→ `++this.count` 得 NaN。修复：`else if (c.parent || this._dynParentExpr(c))`。验证：`0,1,2` / 三层 mixin `base,tagged,1,2,2`。

复现：`const Counted = (B) => class extends B { count: any = 0; inc() { return ++this.count; } }; class Root {} class Final extends Counted(Root) {}` → `new Final().inc()` 得 `NaN`（`count` 读作 undefined）。
插桩结果（编译期）：`SUPER_FORWARD(__clsExpr_1) dyn=true` + `FIELD_DEFAULTS(__clsExpr_1) fields=["count"]` → **字段默认值确实被发射**，且走的是动态 super 分支（`qz.super_ctor` 之后紧跟 `_emitFieldDefaults`）。
因此问题在**运行期**：默认值写入的槽与读取端不一致，或 `super_ctor` 调用的父构造器在其之后再次清空字段槽。下一步：在 `_emitFieldDefaults` 后打印 self 与字段偏移，并在宿主 `super_ctor` 前后 dump 该实例的字段槽值（定位是「写错槽」还是「被父构造器覆盖」）。

另一相关阻塞：类表达式**方法捕获外围变量**（`const withVersion = (v) => (Base) => class extends Base { version() { return v; } }` → loud「未定义捕获变量: v」）——类方法未接外围 env，需为类表达式的类方法建立捕获通道（工程量较大）。
### 类表达式方法捕获外围变量（设计草案，未实现）

复现：`const withVersion = (v) => (Base) => class extends Base { version() { return v; } };` → loud「未定义捕获变量: v」。类方法被编译为**独立 wasm 函数**，未接外围 env。

两条可行路线：
1. **env 通道（推荐）**：给「**有捕获的类表达式**」的类方法加一个 ABI 槽——类对象/实例携带该 env 句柄；宿主派发（`method_call` / `closure_call` 的类方法分支 / `buildInstance` 的 ctor 调用）在 `self` 之后多传 env；发射器侧：类方法体内的自由变量走 `_emitCapturedRead`（`env_get(blk...)`），并在类值创建点（`class_value_dyn`/`class_value`）记录 `clsId → env`。
2. **闭包化类方法**：把有捕获的类表达式的实例方法编译为闭包（复用对象字面量方法机制），类对象仅作 new/instanceof 的骨架——改动面更大（`_methodOwner`/方法派发/`classMeta.methods` 全需并存闭包形态）。

范围提示：`_capturesOf` 现对类方法无用（方法不是 lambda）；需在 `collectClasses` 阶段对类表达式的方法体做一次自由变量扫描，据此给该 clsid 打 `hasCapture` 标记，其余路径不变。回归面 = 全语料 + ctest（class 用例众多）。

**细化实现步骤（2026-10-17 二次勘察，未实施）**：
1. `collectClasses`：对类（含类表达式）的每个方法用 `_capturesOf(methodNode)` 收集自由名（该方法对 `lam.parameters`/`lam.body` 通用），存 `c.captured`。
2. `_emitClassValue(c)`（创建点，外围作用域仍活动）：若 `c.captured` 非空 → 构造 env：`env_new(parentIdx = this.envLocal ?? -1)` → 对每个**在此处可解析**的名字（`_isCapturable(name) || moduleGlobals.has(name)`）发 `env_def(env, strId(name), <值表达式>)` → 再 `qz.class_env_set(clsId, env)`。未解析到的名字不发（方法侧读到 TAG → 仍是 loud，安全）。
3. `_mEnter`（类方法体）：若该 clsid 有 env → 追加一个 `$qzEnv` local；prologue 发 `i32Const(clsId); call qz.cls_env; localSet($qzEnv)`；`capMap.set(name, $qzEnv)` → 方法体内自由变量自动走既有 `_emitCapturedRead`（`env_get`）。
4. 宿主：`clsEnv: Map<clsId, handle>`、`class_env_set(clsId, env)`、`cls_env(clsId)`（未登记 → throw loud）。
安全性质：漏挂任一名字 → 方法侧 `env_get` 得 TAG → 仍是 **loud「未定义捕获变量」**，不会静默错值。回归面 = 全语料 + ctest。

**首个实现尝试（2026-10-17，已回退）**：按上述 4 步落地（含 `$qzEnv` local + `capMap` + `class_env_set`/`cls_env`），`test_aot` 立即报 `Cannot read properties of null (reading 'body')`。两次修正（把 `$qzEnv` 的 `locals.push` 移到 `nLoc` 计算之前、用 `locals.indexOf("$qzEnv")` 取索引）后仍同错 → 说明 **`_mEnter` 的槽布局与 `locals` 存在额外耦合**（`locals` 还参与 `varMap`/`$ovfArg`/`forOf`/`clo` 计算），改 `locals` 会连带破坏既有布局。
**下次正确做法**：不要动 `locals` 列表——改为在 `_mEnter` 里**独立预留一个专用 local**（例如在 `this.swIdx`/`this.forOfBase` 之后新增 `this.qzEnvLocal = nLoc + …`），或用**现成 scratch 槽**（`sT` 中一个固定槽）保存 env 句柄；`capMap.set(name, thatSlot)` 后 prologue 写入即可。回归面仍为全语料 + ctest。

**第二次尝试（2026-10-17，已回退）——重要发现**：`_mEnter` **本就自带**「方法内被嵌套 lambda 捕获」的 env 机制（`_probeCaptured` → `envDecls = ["i32"]` → `envLocal` = 最后一个 local → `capMap` 映射 → 入口 `env_new(-1)` + 把各 local `env_set` 进去）。因此**无需新增 local**：只要把类方法的**外围自由变量**并进 `capNames`，并在方法入口把「类捕获 env」的条目并入本方法 env，`capMap`/`_emitCapturedRead` 即自动打通。
实施：`collectClasses` 存 `c.captured`（`_capturesOf(methodNode)`，过滤内建/模块全局/类名）；`_emitClassValue` 在创建点 `env_new(-1)` + 逐名 `env_def` + `class_env_set(clsId, env)`；`_mEnter` 把 `c.captured` 并入 `capNames` 并发 `qz.cls_env_into(envLocal, clsId)`；宿主加 `classEnv`/`class_env_set`/`cls_env_into`。
结果：`wasm` 校验失败 `Compiling function #N failed: call[0] expected`（QZ 条目与两侧 i32 签名均已核对一致）。**下次先查编码器**：`Module.call(name)` 对「两趟采集（`collectImports`）后才注册的 import」的索引解析，以及 `call[0] expected` 的确切触发条件（疑似调用点/索引生成问题，而非签名）。

**第三次尝试（2026-10-17，已回退）——换用既有 import 绕开编码器卡点**：把类捕获 env 存进 **statics 表**（键 `@@qzEnv`，用既有的 `env_new`/`env_def`/`static_set`/`static_get`，**零新 import**），并在「类有捕获且方法**无**嵌套 lambda 捕获」时令 `envLocal` 直接指向类 env（避免跨调用污染；混合场景保持 loud）。
结果：踩到两个实现细节——(1) 锚点 `M.i32Const(-1); M.call("qz.env_new"); M.i32WrapI64(); M.localSet(this.envLocal);` 在 **`_mEnter` 与 `_emitLambdaBody` 各出现一次**（替换命中 2 处 → lambda 体内 `cname` 未定义 → `cname is not defined`）；(2) 类捕获名仍未进 `capMap`（分支条件/位置不对），两例仍 loud。
**下次正确做法**：先在 `_mEnter` 内用**唯一锚点**（如 `this.envLocal = capNames.length ? (1 + params.length) + bodyLocals.length - 1 : undefined;` 这一行）插入 env 分支；再紧随其后按「`capNames.length === 0 && c.captured.length > 0`」把类捕获名写入 `capMap`；`_emitLambdaBody` 完全不动。


---

## 类表达式方法捕获——第四轮尝试（2026-10-17，已回退；机制已打通）

**关键 bug（找到）**：`qz.env_def` 的**首参是 handles 索引（i32）**，此前传 env 句柄（i64）→ V8 报
`call[0] expected type i32, found local.get of type i64`。改为 `localGet(envT.v); i32WrapI64();` 后，
四类场景**全部正确**：`withVersion("1.0")` → `r,1.0`；`withV(7)` → `7`；方法内用 `Math` 且捕获 `n` → `5`；双捕获 → `3`。

**可工作组合（下次直接复用）**：
1. `collectClasses` 存 `c.captured`（`_capturesOf(methodNode)`，过滤内建/类名/模块全局/`fnNames`）。
2. `_emitClassValue` 创建点：`env_new(-1)` → 逐名 `env_def(envIdx, strId(name), 值)` → `static_set(strId(cname), strId("@@qzEnv"), env)`（**零新 import**，绕开编码器卡点）。
3. `_mEnter`：在**唯一锚点**（`const capNames = this._probeCaptured(...)` 之后）并入类捕获名；当「无嵌套 lambda 捕获」时 `envLocal = static_get(cname, "@@qzEnv")`（`i32WrapI64`），`capMap` 随之映射；`_emitLambdaBody` 不动。

**未收敛的两处边角**（回退原因）：
- `mixed-realistic-program`（声明式类 `TaskList`，`captured` 含类名 `Task`/`TaskList`）被回归 → 用「仅 `__clsExpr_*` 参与捕获」收窄后回归消失。
- 但随后 `curried-class-factory` 变 `Cannot read properties of null (reading 'buffer')`：**start 段（`__module_init`）mem 未绑定**，而模块级 `class Final extends withVersion("1.0")(Root)` 的 env 构建会 `env_def` 写**字符串**值（触发 `strWriteback` 需 mem）。
- 再加 `!this._inModInit` 守卫后，**函数级**捕获又返回 `undefined` → 说明 `__clsExpr_` / `_inModInit` 两处全局收窄与「函数级创建点」的实际情形不一致。

**下次路径**：只保留上述「可工作组合」三件，**不要**做 `__clsExpr_`/`_inModInit` 全局收窄；单独插桩 `mixed-realistic-program`（打印该类 `captured` 与 `_mEnter` 侧 `capNames`）定位其真实成因；模块级 mixin 的 start 段问题单独处理（延后类 env 构建到 mem 绑定之后，或 start 段只存非字符串捕获）。

### 已修复（第六轮，2026-10-17）：类方法捕获落地

两处关键 bug：① `env_def` 首参为 handles 索引(i32)（此前传句柄 i64）；② `_capturesOf` 把嵌套函数形参误当自由变量（`_collectLocals` 不下探）→ `render(){ items.map((t) => …) }` 的 `t` 被误捕获 → 非法 env 索引 → `env_set` 崩。修：两处**共用同一过滤集** + 排除嵌套形参 + 创建点**总是**存 env。已知限制：模块级 mixin（start 段 mem 未绑定）仍需把 env 构建延后。

（以下为历史记录）### 第五轮补充（2026-10-17，已回退）：`_mEnter` 分支必须与 `_emitClassValue` 的过滤条件**同构**

复现（重落地「可工作组合」后）：`class TaskList { … add(){ const t = new Task(TaskList.nextId++); … } render(){ return this.items.map((t) => t.toString())… } }`
→ `Cannot set properties of undefined (setting 't')`。

要点：
- `TaskList` 的 `captured` 只含**类名**（`Task`/`TaskList`）→ `_emitClassValue` 的 `names` 过滤后为空 → **未存类 env**；而 `_mEnter` 侧若仅按 `probeLenC === 0 && clsC.length` 判断，就会走 `static_get(name,"@@qzEnv")` 拿到 TAG → `i32WrapI64` 得到一个**非法 handles 索引** → 后续 `env_set(envIdx, "t", …)` 写到 `undefined` 上 → 即上述报错（`t` 是 `add()` 的局部名）。
- 因此重落地时必须保证**同一条件**：只有「`_emitClassValue` 确实存了 env（其 `names` 过滤后非空）」的类，`_mEnter` 才允许用 `static_get` 取 env；否则应回退到 `env_new(-1)` 或保持不映射（loud）。
- 建议实现：在 `collectClasses` 阶段就把「可捕获名」定死（用与 `_emitClassValue` 完全相同的谓词，但把 `_isCapturable` 换成「非内建/非类名/非模块全局/非 fnNames」这一保守近似），并把结果同时用于两处 —— 避免两处各自过滤导致条件不一致。
- 另：`render()` 内含嵌套箭头 `(t) => …`，`_probeCaptured` 非空时的混合场景应保持**保守**（不启用类 env），以免与既有 env 机制冲突。

## ✅ 已修复（2026-10-17）：模块级闭包调用在 start 段崩

修法采用**最简版本**：发射器去掉 `setStart`（`__module_init` 保持普通导出）+ 宿主新增 `tryRunModuleInit()` 并在最后一次 bind（`bindClasses`）内触发（幂等）。早期尝试的两条弯路（wasm 全局 `__moddone` + 导出函数序言懒触发）因采集趟 `call` 不可解析、`declareFunc` 槽位重复等问题放弃——宿主触发无需触碰发射器控制流。

（以下为历史分析）## 【重要】模块级闭包调用在 start 段崩溃（先于类捕获特性存在的缺陷，2026-10-17 发现）

**最小复现**（与本轮特性无关，今天仍然如此）：
```
const f = (x: any) => x + 1;
const y = f(2);                 // 模块级：闭包调用发生在 __module_init
export function g(): any { return y; }
```
→ `WebAssembly.instantiate` 报 `Cannot read properties of null (reading 'buffer')`（全方法包装定位到 **`qz.closure_call`**：它要读闭包头 `new DataView(mem.buffer)…`，而 start 段执行时宿主 `mem` 尚未 `bindMem`）。

**根因**：`emitter.js:2785` `if (modStmts.length && anyTagged) m.setStart("__module_init")` —— 模块初始化被放进 **start 段**，而宿主的内存/导出/类元在 `instantiate` **之后**才绑定。

**影响**：任何在模块级执行「闭包/值调用」的程序（极常见：`const a = f(1)`、`const x = makeThing()`、mixin 工厂调用等）都会在实例化阶段崩；此前只有被编译期 loud 挡住的场景才没暴露（例如 `withVersion("1.0")(Root)` 曾因「未定义捕获变量」loud，类捕获落地后编译通过，才露出这个运行期缺陷）。

**修法（建议，二选一）**：
1. **不在 start 段跑**：去掉 `setStart`，把 `__module_init` 作为普通导出，由宿主在所有 bind 之后调用一次（例如新增 `qz.bindReady()`/放在 `bindClasses` 之后，或 harness 显式调用）。
2. **懒初始化**：加一个 wasm 全局 `__moddone`（须加在 `__bump`(0)/`__err`(1) **之后**），在每个导出函数 prologue 里 `if (!__moddone) { __module_init(); __moddone=1; }` —— 首次调用时必然已 bind 完毕。

两条路线都能同时修好「模块级闭包调用」与「模块级 mixin（类 env 在 start 段构建）」；后者是本轮类捕获特性的唯一已知限制。

### 懒模块初始化尝试（2026-10-17，已回退；三处耦合已探明）

按「修法 2」实作（去 `setStart` + 加 `__moddone` 全局 + 导出函数序言懒触发）时踩到三处耦合，均已定位：
1. **采集趟**：`emitAll(mc, null)`（`collectImports: true`）中 `call("__module_init")` 不是 `qz.*` → 编码器直接抛 `call 未定义`（`Module.call` 仅在 `this.collect` 且名字以 `qz.` 开头时记账）。→ 需在采集趟也能解析该名字（例如两趟都先 `declareFunc`，或让 `call()` 在采集模式对已声明名放行）。
2. **`declareFunc` 签名**：`m.declareFunc("__module_init", [], [])` → `Cannot read properties of null (reading 'locals')`（`addFunc(name, params, results, locals)` 需要第 4 参）。→ 传 `[]` 作为 locals。
3. **重复导出**：`m.exportFn("__module_init", "__module_init")` → `Duplicate export name '__module_init'`（该函数已被默认导出）。→ 不要再 exportFn；只需保证**早声明**（在任何 prologue 发射之前）。

顺序要点：早声明必须发生在**导出函数序言发射之前**（`fns` 声明循环之后即可），且 `__module_init` 自身序言要跳过（`_inModInit` 守卫）。

### ✅ 已修（2026-10-17）：闭包内 `obj.constructor === C` 恒为 false

根因：`_capturesOf` 把**类名**当自由变量捕获 → 闭包内 `Circle` 经 `env_get` 得 TAG(undefined)。修：捕获扫描排除类名 + 标识符值的类解析兜底（`_className(text) || classes.has(text)`）。验证：闭包内比较 false→true，corpus32 `RRR`→`CRQ`。

（以下为定位记录）### silent：闭包内 `obj.constructor === C` 恒为 false（2026-10-17 定位）

探针（同一模块内对照，Classes：`class Shape {} class Circle extends Shape {}`）：
| 写法 | 结果 |
|---|---|
| 同层函数体内 `c.constructor === Circle` | **true** ✓ |
| 箭头闭包内 `(s) => s.constructor === Circle` | **false** ✗ |
| `[new Circle()].map((s) => s.constructor === Circle)[0]` | **false** ✗ |
| 闭包内 `typeof s.constructor` | `"function"` ✓ |
| 闭包内 `s instanceof Circle` | `true` ✓ |

插桩结论：两侧的 `qz.class_value(id)` **返回同一句柄**（如 `class_value(1)` 两次都是 `0x7FFD|2`），且 `prop_get` 的兜底分支**未被走到** → 取值正确、`instanceof` 正确，问题在**闭包上下文里 `===` 的比较发射**（疑似该上下文取了 num/f64 路径或两侧其一走了不同解析）。
下一步：dump 该表达式（`~/tmp/qzaux/probe_ctor.js` 的 `arrowType` 例）的发射指令，比较同层与闭包两种上下文下 `===` 的字节差异。

### 自递归直调（窄面：闭包深递归走宿主栈）——尝试记录，已回退（2026-10-17）

目标：`const sumTo = (n) => n <= 0 ? 0 : n + sumTo(n-1)` 目前每次递归都经 `qz.closure_call`（宿主 JS 帧）→ `sumTo(1000)` 触发 `Maximum call stack size exceeded`；拟改为 lambda 体内**直调自身 wasm 函数**（`call __lam_N(blk=local0, a0..a3)`），从而只吃 wasm 栈。

已实现并验证「调用侧」逻辑（`_lamSelf` + 在标识符调用处优先直调，需非 rest、非 synthThis、≤4 实参、无展开）——`fib(20)`/`fact(10)` 均正确，`sumTo(1000)` 仍溢出，说明**直调没有生效**。

卡点（插桩结论）：`lam._qzSelfName` 在 `emitLambda`（预登记趟）与 `_emitLambdaBody`（体发射）时均为 **undefined** —— 我加的「绑定处传名」只落在 `_bind` 的**模块级 const** 分支（约 299–309 行），而模块级 const 的初值实际由**另一条路径**发射（`emitTaggedExpr(d.initializer)` 的箭头分支，无名字），且 `_emitLambdaNew` 的实参在日志中恒为 `selfName=undefined`。

下次做法：先在 `_emitLambdaNew` 里打印调用栈，定位模块级 `const f = () => …` 的 **真实发射点**（是 `emitStmt` 的 var 路径还是 `_emitBindingDecl`），确认后就地传绑定名；再核对 `_emitLambdaBody` 里 `_lamSelf` 的赋值时机（须早于体内调用发射）。

### ✅ 已修复（第三轮，2026-10-17）：自递归直调

真因（上一轮 corpus4 校验失败）：`_lamSelf` 从 lambda 泄漏到方法体，方法里 `localGet(0)` 是 i64 `this` 而 lambda 的 blk 是 i32 → 类型不符。修：`_mEnter`/顶层函数体清空 `_lamSelf`；lambda 签名 = `[i32]+n×[i64] → i64`。

（以下为历史记录）### 自递归直调：第二次尝试（2026-10-17，已回退）

按记录定位到**真实发射点**（栈：`_emitBindingDecl:309` → `emitTaggedExpr:3598` → `_emitLambdaNew`），补齐四处后：`sumTo(500)` **由溢出转为 125250**（corpus29 `recursion-depth-bounded` 通过，残余 5→4），`fib/fact/local/witness` 均正确。

但引入 **corpus4 `closure-this-arrow-method` 的 wasm 校验失败**（`call[0] expected`）——该 lambda（方法内捕获 `this` 的箭头）其**闭包 ABI 有额外槽**（recv/ovf），直调只按「blk + 逻辑形参」推参 → 数目不符。加了两道守卫（`S.n <= 4`、`params.length === astParams.length`）仍未消除 → 说明该 lambda 的 wasm 形参数不等于 `astParams`（`this` 槽/`$ovf` 等）。

净收益为零且失败性质更差（把可编译变成校验失败）→ **回退**。
下次做法：在 `_emitLambdaBody` 里记录**该 lambda 的 wasm 形参数**（`1 + params.length`）而非逻辑形参数，直调时严格按该数目推参（含 recv=local0、ovf=TAG）；并用 corpus4 用例做守门测试。
