# AOT 路线评估汇总（2026-10-08，实验数据消化）

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
语料：`audit_corpus.js`(47) / `audit_corpus2.js`(40) / `audit_corpus3.js`(39) / `audit_corpus4.js`(38) / `audit_corpus5.js`(28)。
结果：**189/192 一致（98%）**；`test_aot.js` 233 checks ALL PASS；`ctest`（含 test262）全绿。

已支持（本轮新增/完善）：形参默认值·解构形参·rest 形参（调用点按形参表拆包）、let/const **每迭代绑定**（for 在增量处换层，while/for-of 在体首换层）、闭包值独立 tag 0x7FFF、对象字面量方法/访问器（宿主对象 + defineProperty 回调 wasm 闭包，成员闭包纳入捕获分析）、私有字段/方法（`#类名#名`）、静态字段继承/遮蔽与静态块与静态访问器、标签模板、正则字面量、Map/Set/Date、for-of 解构与可迭代、值调用 `qz.call_value`、嵌套解构、**跨函数 throw 传播**（调用点查 `__err`）与 try-finally 重抛、类字段统一容量 + 运行期新键 extras、字符串不可变（逃逸分析决定原地追加 / `qz.str_dup`）、数组/POJO/闭包句柄往返还原、POJO 与实例 clsId 撞号修复。

已知限制（均已记录，loud 或窄面差异）：
- **POJO 键序**：`Object.keys`/`JSON.stringify` 为「预登记字段序 + 运行期新键」，非 JS 插入序。
- **`arguments` 对象**与函数 **rest 形参之外**的变参 ABI 场景；稀疏数组 `Object.keys`（洞与 undefined 不可区分）。
- 跨函数 throw 需 glue 在调用导出后调用 `qz.take_err()` 才会向宿主 JS 抛出（wasm 无法直接抛出 JS 异常）。
- 对象展开段与访问器混用、`with`/`eval`、Symbol 迭代器等未支持（loud）。
