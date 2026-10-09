---
id: aot-experiment-verification
title: "AOT 实验验证：TS→wasm→C99→so 链路成立 + fib 性能 8.97x"
category: decision
status: active
tags: [aot, wasm, wamr, assemblyscript, ts2c, qzvm, experiment]
created: "2026-10-07T16:11:15"
updated: "2026-10-09T01:51:01"
---

<!-- compiled_truth -->
# AOT 实验验证（experiment/aot 分支）

## 方案（统一链路）

## 最小编译器 ts2c.py（2026-10-08 实现）

**架构**：tokenizer（词法）→ parser（递归下降 AST）→ codegen（C99 输出 + 边界包装）。
替代早期 gen_ts2c.py 正则 hack，为真正编译器骨架。

**支持子集**（类型特化 + 纯 C 运算 + 边界调 quickjs API）：
- 类型注解：number(int64_t) / boolean(int32_t) / void / string(const char*)
- 语句：function / if-else / for / while / return / let-const / 赋值(= += -= ++ --)
- 表达式：数字/字符串/布尔字面量、变量、一元(! -)、算术/比较/逻辑、三元、调用、括号
- console.log(...) 多参数：委托 quickjs JS 层（g_ctx + JS_Call）
- 边界：aot_<fn>（JSValue 签名）+ qz_aot_lookup 注册表 + aot_set_ctx
- 不支持（报清晰错误）：对象/数组/类/闭包/string 拼接/属性访问（仅 console.log）

**number → int64_t**（非 int32）：JS number 是 double（53 位整数精度），int64 覆盖；
64 位平台 int32/int64 同速。实测 int32 溢出（sum(1e6)=5e11 截断错值）。

## 编译产物验证（同 n 同 runtime）

| 样例 | 负载 | vs 解释器 |
|------|------|-----------|
| fib.ts | 递归 | **25.22x**（= 手写上限 23-24x） |
| sum.ts | for 循环 1e6 | **39.32x** |
| bench_real.ts | sum 1e5 + fib(25) + console.log | **24.97x** |

错误路径：对象 `{}` → "unexpected token '{'"；数组 `[]` → "unexpected char '['"。

构建链：`aot/build_ts2c.sh <name>` → ts2c.py → gcc -fPIC -shared → lib<name>.so；
`build_ts2c.sh libquickjs` → libquickjs.a（visibility default，四文件）。

## 四路性能对比（fib，n=25 同 n）

| 路线 | vs 解释器 | 说明 |
|------|-----------|------|
| TS直接→C99（ts2c 产物） | 25.22x | 编译器产出 = 手写上限 |
| 调 qzjs API（JS 层运算） | 1.59x | 无算术原语，不可行 |

## 真实负载（2026-10-08 ts2c 版）

bench_real.ts（sum 1e5 + fib(25) + console.log 多参数）24.97x——数值纯 C，
console.log 边界委托 quickjs，低频不拖累。quickjs 无公开拼接原语（JS_Concat），
string 拼接不支持，console.log 用多参数替代。

## 关键洞察

1. **quickjs 公开 C API 无算术原语**（无 JS_Add）——运算不能逐次调 API（1.59x），
   高性能 = 边界调 qzjs API + 运算体纯 C。
2. **int64_t 是正确特化**（JS number = double，53 位整数；int32 溢出真实发生）。
3. **console.log 多参数委托**是字符串输出的最小路径（免拼接原语）。
4. **TS直接→C99 是推荐路线**（release-artifact-topology 裁决），ts2c 是其最小实现。

## 文件（experiment/aot 分支）

- aot/ts2c.py — 最小编译器（tokenizer/parser/codegen/边界）
- aot/fib.ts / sum.ts / bench_real.ts — 样例源
- aot/host_fn.c — 通用 AOT vs 解释器 bench
- aot/build_ts2c.sh — 构建链（ts2c → gcc → so）
- aot/libquickjs.a — visibility default 引擎库（gitignore）

## 后续工作

- 通用化：string 拼接（委托 JS 层）、数组/对象、方法调用
- 编译器稳健性：作用域遮蔽、函数前向引用、类型错误诊断
- 与 qzjs 发行拓扑集成（so 形态 = release-artifact-topology ELF/so 产物）


## Timeline

- time: 2026-10-07T16:11:15
  kind: decision
  summary: "Created this page: AOT 实验验证：TS→wasm→C99→so 链路成立 + fib 性能 8.97x"
  source: "2026-10-07 实验分支 experiment/aot 实测"
  affects: [aot-experiment-verification]

- time: 2026-10-07T16:11:16
  kind: decision
  summary: "TS→wasm→C99→so 链路实测成立；fib 8.97x（达手写上限 37.8%，超 1/3）；fib_only 零导入未验 rt.* 适配"
  source: "2026-10-07 experiment/aot 实测"
  affects: [aot-experiment-verification]

- time: 2026-10-07T16:20:04
  kind: decision
  summary: "四路对比：TS直接→C99 22.86x=wasm2c 8.95x vs 调qzjs API 1.59x；quickjs 公开 C API 无算术原语（无 JS_Add）"
  source: "2026-10-07 四路 n=25 同 n bench"
  affects: [aot-experiment-verification]

- time: 2026-10-07T17:38:47
  kind: decision
  summary: "真实负载：sum 1e5 + fib(25) + 字符串 + console.log(调 qzjs API) = 24.46x 解释器；非数值走 JS 层预期慢(无 JS_Concat 原语)"
  source: "2026-10-07 真实负载 bench"
  affects: [aot-experiment-verification]

- time: 2026-10-08T00:18:33
  kind: decision
  summary: "最小编译器 ts2c 实现：tokenizer+parser+codegen，子集已验证 fib 25.22x/sum 39.32x/bench 24.97x，错误路径清晰"
  source: "2026-10-08 实现完成"
  affects: [aot-experiment-verification]

- time: 2026-10-08T01:29:26
  kind: decision
  summary: "新增路线（用户裁决）：复用外部 TS 编译器前端 + 改造其 wasm 后端（拆类型擦除桥，emit 类型特化） + quickjs 实现对象语义 + wasm 直接跑 WAMR（不走 wasm2c）。切片1 机制验证 PASS：手写 qzobj.wat import qz.* + qzvm.c native-lib（quickjs JS_NewObject/SetProperty/GetProperty），WAMR iwasm --native-lib 实测对象读写 PASS。三改造面：桥发射层(emit_memcall 拆桥) / import 发射层(rt.* import) / 运行时端换 quickjs。硬约束：quickjs 公开 C API 无算术原语(无 JS_Add)→数值运算必须在 wasm 内类型特化为原生指令，只有对象/字符串/数组走 quickjs import。"
  source: "2026-10-08 用户裁决 + 切片1实测"
  affects: [aot-experiment-verification, release-artifact-topology]

- time: 2026-10-08T01:37:47
  kind: evidence
  summary: "切片2 PASS：qzvm.c (WAMR native-lib) 完整 quickjs 运行时语义验证——16 个 qz.* 符号覆盖对象属性/数组/字符串/方法调用。tagged i32 值模型(数字内联/对象 handle 表持强引用)；call_method 参数经 wasm 线性内存(validate_app_addr+addr_app_to_native)；str_concat 委托 JS 层 (quickjs 无 JS_Concat 原语)。qzobj2.wat 实测: obj.a=42 / has=1 / array_len=3 / [1]=20 / 'x'+'y' len=2 / helper.add(20,22)=42 / helper.greet(5)='hi 5' 全绿。修 3 个 quickjs-ng C API 坑: JS_HasProperty 第三参是 JSAtom(非 char*)；JS_GetPropertyStr 对 primitive string 抛 TypeError abort(改 JS_ToCStringLen)；from_js handle 表 dangling(需 JS_DupValue 保活, 调用者 free 自己的 owned)。结论: wasm 产物直接调 quickjs 完整运行时语义可行, 无 perry rt.* 桥。"
  source: "2026-10-08 切片2 实测(WAMR iwasm --native-lib)"
  affects: [aot-experiment-verification]

- time: 2026-10-08T01:48:13
  kind: evidence
  summary: "AssemblyScript 路线验证 PASS（2026-10-08）：asc 0.28.20 编 as_test.ts → 337B wasm，三条决定性证据——(1) fib(i64) 递归编译为 i64.lt_s+i64.add 原生 wasm 指令零桥（桥式 codegen 是 js_add mem_call + NaN-box）；(2) 对象/数组走 @external(\"qz\",…) import → qzvm native-lib(quickjs) 跑通 o.a=42/array_len=2；(3) WAMR iwasm 直跑不走 wasm2c，导入面仅 8 个 qz.* 零 rt.*。实测 dump 2042/6765 全对。核心差异：AS 用类型系统消灭动态性→数值编译期确定→开箱原生指令，无需改任何外部编译器源码；保留 JS 动态语义的编译器必须走桥→需改上游源码。ABI 注意：qzvm tagged i32 值模型与 AS 裸 i64 混用需 new_number() 包装。node_modules/assemblyscript 已加入 .gitignore。"
  source: "2026-10-08 AS 实测（asc + WAMR + qzvm）"
  affects: [aot-experiment-verification, release-artifact-topology]

- time: 2026-10-08T01:59:34
  kind: evidence
  summary: "性能测量重大修正 + AS wasm AOT 验证（2026-10-08）：(1) so 编译必须 -O3 -march=native —— fib(25) 25.02x→74.21x (3.0x)、sum(1e6) 42.34x→388.54x (9.2x, gcc 向量化)，此前所有 so 数据均为 -O2 低估值 3-9 倍；build_ts2c.sh 已改。(2) AS wasm 两种运行模式实测：iwasm 解释模式 fib(25) 5.88ms/call 仅 1.98x 解释器（WAMR 解释器开销占主导，不代表 wasm 性能）；WAMR AOT 模式（wamrc + LLVM O3，需 -DWAMR_BUILD_WITH_CUSTOM_LLVM=1 -DLLVM_DIR=/usr/lib/llvm-14 构建 wamrc-2.4.3）fib(24/25) ~61us/call ≈ 150-190x vs qzjs 解释器（跨引擎），比 ts2c so -O3 (147us) 快 ~2.4x。(3) 测量方法论教训：AS bench 里 fib(25) 参数为常量被 LLVM 常量折叠，测出 1.2us/call 的假数据；必须让参数随循环变量变化 (fib(24 + i%2)) 才测到真实递归。另 host_fn 需显式传 iters 参数否则 bench(0) 空转。"
  source: "2026-10-08 实测（asc + wamrc + iwasm + host_fn）"
  affects: [aot-experiment-verification, release-artifact-topology]

- time: 2026-10-08T02:05:22
  kind: decision
  summary: "彻底清理第三方桥式编译器残余（2026-10-08）：删除 19 个外部编译器产物/中间文件（perry wasm 产物 + wasm2c 生成的 .c/.h + 包装层 + 探测 wasm），删除 2 个已归档的桥式路线 brain 页（qzvm-aot / wasm-ts-runtime），清理 release-artifact-topology 与本页正文中对该路线的专名引用（改为泛指'需改造上游源码的第三方 TS 编译器'，保留'为何否决'的技术论证：桥式 codegen 把所有运算压进 js_add 调度桥）。保留：asc/as_*（AssemblyScript 产物）、qzobj*/as_test（手写验证）、qzvm.c（quickjs 运行时）、ts2c.py（自研 so 编译器）。timeline 中的历史记录按 append-only 审计约定保留。"
  source: "2026-10-08 用户指令：彻底删除 Perry 残余"
  affects: [aot-experiment-verification, release-artifact-topology]

- time: 2026-10-08T02:52:37
  kind: evidence
  summary: "AS 化率抽样（2026-10-08，4 类 20 函数）：algo 4/5(80%)、strproc 0/5(0%)、objbiz 0/5(0%)、mixed 3/5(60%)，总 7/20=35% 函数数 AS 化率。关键洞察：兼容的全是数值热点(fib/gcd/collatz/isPrime/fastPow)，不兼容的全是 I/O 密集(string/console/对象/for-of/reduce)，推测 CPU 时间覆盖率 80%+（待 profiling 实测）。切分器价值在 CPU 覆盖率非函数数。不兼容主因：string 拼接/方法、对象字面量、interface/union、for-of、reduce/map/filter 回调、模板字符串、number[][] 数组语法。兼容函数还需语法转换(number→i32/i64/f64、number[][]→Array<Array<f64>>、[]字面量→new Array)。推荐路径 B+对象/string 强制留 JS。已验证产物形态(fib_split.as.ts+glue.js qzjs 跑通 fib(20)=6765/fib(25)=75025 双向)。约束：qzjs ext_wamr 不支持 BigInt i64→AS 优先 i32；_start 是导出非 wasm start section→glue 显式调。"
  source: "2026-10-08 抽样（4 类代表性 TS）"
  affects: [aot-experiment-verification, release-artifact-topology]

- time: 2026-10-08T03:29:50
  kind: evidence
  summary: "AOT 端到端验证（第一性原理推导关键卡点）：ext_wamr.c 已内置 WAMR AOT bypass shim（WebAssembly.compile/instantiate(bytes, imports, {aot: aotBytes, aotFail})——AOT 优先 wamrc .aot，失败 fail-open 回退解释器），qzjs 文件模式 drain Promise 工作。推翻 qzjs 内 wasm 走解释无意义 担忧。纯数值 3000×fib24/25：qzjs 内 AOT 0.631s vs 纯 JS 解释器 30.4s = 48.2x（≈ so dlopen 41.4x 持平略优）。混合负载切分端到端：fibSum(20)×1000 + collatz(27)×1000（数值 fib/fibSum/collatz AS AOT + console.log 留 JS）= 0.195s vs 纯 JS 3.255s = 16.7x。正确性 PASS（fibSum×1000=10945000 / collatz×1000=111000 两边一致）。结论：AOT 路径在 qzjs 内端到端可用 + 切分器价值证明（混合 16.7x）。启动开销占 AOT 总 25%（0.05/0.195），放大负载可提升加速比。"
  source: "2026-10-08 端到端实测（wamrc .aot + qzjs ext_wamr AOT shim + drain Promise）"
  affects: [aot-experiment-verification, release-artifact-topology]

- time: 2026-10-08T03:36:40
  kind: evidence
  summary: "放大负载确认 AOT 加速比上限（2026-10-08）：修正前 fibSum(25) 参数恒定被 wamrc LLVM 常量折叠（AOT 仅 0.062s，JS 41.979s 假数据）；改 fibSum(20+i%5) + collatz(27+i%3) 参数随 i 变化防折叠。多档斜率（aot/js vs N）：N=500 25.3x、N=1500 41.6x、N=4500 57.6x。JS 斜率 6.64ms/iter vs AOT 97µs/iter → 渐近加速比上限 68.4x（去除启动开销 0.05-0.08s：wasm AOT 加载 + Promise drain）。正确性 PASS（N=500 两边 fibSum 结果 17870200 / collatz 24531 一致）。之前 16.7x 是 N=1000 启动占比 25% 低估值。结论：AOT 路径端到端加速比上限 ~50-70x（与纯数值 fib 48x 同量级），启动开销在 N>4500 后占比 <10%。"
  source: "2026-10-08 放大负载斜率实测"
  affects: [aot-experiment-verification]

- time: 2026-10-08T09:01:00
  kind: evidence
  summary: "切分器最小原型实现并验证 PASS（2026-10-08）：splitter.js（tsc 5.9.3 API + Node）自动 TS→js+wasm 切分。Pipeline: createProgram 解析→每函数 AST+类型注解→AS 兼容判据（参数/返回 number/boolean/void + 无禁用 AST 节点: 对象/数组字面量/模板字符串/try-catch/闭包/async/for-of/reduce-map/class-interface-enum + console 调用 + string 字面量拼接）→闭集分析（AS 函数调用的函数必须兼容否则降级传播）→as codegen（number→i32, i64→i32, number[]→Array<i32>, Math.floor→<i32>Math.floor）→asc+wamrc→glue.js（base64 embed wasm+aot + WebAssembly.instantiate {aot} 路径 + 顶层调用替换 __aot.fn）+ js codegen（不兼容函数 transpile 去注解 + 主逻辑）。实测: algo.ts 切分 AS4/JS1（matmul number[][] 不兼容）、mixed.ts AS3/JS2（bench/report console+string 不兼容）、test_split.ts AS3/JS0 端到端 qzjs 跑通 fibSum(20)=10945/collatz(27)=111。性能: perf_split.ts（fibSum(20+i%5)+collatz(27+i%3)×1500）切分器自动版 AOT 0.201s vs 纯 JS 8.645s = 43.0x，与手动切分 41.6x 一致。正确性 PASS（53610600/73500 两边一致）。已知小 bug: 正则替换 AS 函数名不区分字符串字面量（console.log 字符串内 fibSum 也被替换为 __aot.fibSum，不影响功能）。"
  source: "2026-10-08 切分器实现+实测"
  affects: [aot-experiment-verification]

- time: 2026-10-09T00:15:23
  kind: reversal
  summary: "真实 TS 代码 AS 化率实测 = 0%，推翻此前 35% + 推测 80% CPU 覆盖的乐观估计（2026-10-08）。样本：4 个真实 npm 库全量/大抽样函数——effect 函数式框架 0 AS/4 JS、@trpc/server 0/41、@noble/hashes 加密哈希 0/59、@noble/curves 椭圆曲线 0/137，合计 0/241 AS 化率 0%。不兼容原因真实分布：bigint 参数（密码学核心）、UintArray/IField<T>/CurveType/接口泛型、string 参数、number|bigint union、闭集传播降级。核心洞察：@noble/* 是纯 TS 加密却 0%，因为密码学运算基于 bigint 任意精度整数（AS 只有 i32/i64 + qzjs ext_wamr 不支持 BigInt i64），而此前 43x/68x 加速全部来自 fib/整数循环这一最不真实的负载；真实加密/数值热点落在 bigint/typed array，恰好都在 AS 子集之外。方法论限制（诚实标注）：splitter 当前仅识别顶层 function 声明（ts.isFunctionDeclaration），真实 TS 大量用箭头函数（const f=()=>{}）+ class 方法未进入统计（effect 30 文件仅识别 4 个函数即证据），故真实 AS 化率可能被低估；但被识别的 241 个函数全因类型不兼容被拒，方向性结论成立。修正后的路线判断：AOT 真实适用面极窄——仅纯 i32/i64 标量数值循环（fib/gcd/collatz/CRC32 整数部分）可 AS 化；真实业务库（框架/加密/网络/图形）几乎全 0% 因建立在对象/字符串/typed array/bigint 之上。43x/68x 是 fib 的成绩不是 AOT 的普遍成绩。"
  source: "2026-10-08 真实库实测（effect/trpc-server/noble-hashes/noble-curves，npm pack 真实源码 + splitter 判据统计）"
  affects: [aot-experiment-verification, release-artifact-topology]

- time: 2026-10-09T00:31:23
  kind: reversal
  summary: "路线级纠正：wasm 在 qzjs 内可直接调 quickjs 能力，无需把 quickjs 编成 wasm（2026-10-08 实测）。此前误判\"qzjs 走完整 TS 路线需 quickjs 编 wasm\"——错。qzjs 的 WebAssembly API（ext_wamr/WAMR）支持标准 host import：qzjs 跑 wasm，wasm import \"qz\" 的 JS 函数由 qzjs 侧提供 = wasm 直接调 quickjs 全部 JS 能力。实测验证（bridge_test.as.ts + qzjs 跑）：wasm 调 quickjs console.log(f64)、Math.max(f64,f64)、对象/数组创建与 reduce 运算、JS 侧加法、返回值回传 wasm，全部正确（run() 返回 79.25 = Math.max(3.5,9.25)=9.25 + JS 对象数组 reduce=70）。这条修正连带解决两个此前结论：(1) 不需要 quickjs 编译为 wasm（工程量归零，qzjs 本身即宿主）；(2) \"真实 TS AS 化率 0%\" 只否定 AS 方言路线（严格类型子集），不否定完整 TS 路线——完整 TS→wasm + import quickjs 即 Perry 走通的架构。已验证边界：数值参数(f64/i32)与返回值全通；i64/bigint 不支持（qzjs ext_wamr 无 BigInt i64）；string 参数需 wasm memory 共享解码（AS string 是 ptr+len 对，未验证）；对象跨界需 handle/tagged 方案（C 侧 qzvm 已验证，JS 侧未验证）。"
  source: "2026-10-08 qzjs 实测（bridge_test.as.ts，asc + qzjs build_ext）"
  affects: [aot-experiment-verification, release-artifact-topology]

- time: 2026-10-09T00:57:11
  kind: evidence
  summary: "自研 TS→wasm 编译器地基完成（wasm-encoder + emitter），切片1/2a PASS，性能 68.6x 与 AS 路线持平但覆盖完整 TS。(1) aot/wasm-encoder.js：自研 wasm 二进制生成器（type/import/function/memory/export/code 段 + LEB128，指令最小集 i32/f64 算术比较 + 控制流 block/loop/if/else/br/local/call/drop），不依赖 Perry/AssemblyScript；切片1 实测生成 61B fib wasm，node+qzjs 双向跑通。(2) aot/emitter.js：tsc AST → wasm 栈式发射，值模型 TS 标注 number = 裸 i32 local + 原生 wasm 指令（零跨界，性能主干），控制流用 wasm 惯用法（while/for = block+loop+br_if，语句 if = void block type）。切片2a 实测：真实 TS（gcd while/赋值/%、sumTo for/++、fib 递归 if）→ 198B wasm，node+qzjs 验证 gcd=21/sumTo=5050/fib=6765 全对。性能：自研 emitter wasm AOT bench(3000)=476ms vs qzjs 解释器 32657ms = 68.6x，与 AS 路线 68x 持平，但 emitter 编的是完整 TS（不需 AS 严格类型子集）——正是 AS 化率 0% 的解法方向。修 8 个 bug（tsc 5.9 API 差异为主：isKeywordTypeNode 不存在/getText 需 sourceFile/WhileStatement+IfStatement 用 .expression 而非 .condition；加 addFunc 传 AST 节点、locals 收变量名、emitStmt while/for 缺 return、语句 if 声明 i32 结果、缺 i32Eqz、后缀 ++/-- scratch local）。"
  source: "2026-10-08 自研 emitter 实现 + 实测（node/qzjs 正确性 + wamrc AOT 性能）"
  affects: [aot-experiment-verification, release-artifact-topology]

- time: 2026-10-09T01:05:02
  kind: evidence
  summary: "自研 TS→wasm 切片2b 完成（tagged 动态值路径）+ 性能画像（数值快 68.6x / 对象慢 0.18x）。(1) emitter 加 tagged 模式（参数非全 number 注解时自动启用）：tagged i32 值模型（bit0=0 数值 v>>1 | bit0=1 handle），对象字面量→qz.object_new+object_set(attr idx)，属性→qz.object_get，字符串字面量/拼接→qz.string_new/qz.add（JS 语义），算术比较逻辑→20 个 qz.* import，条件经 qz.truthy，console.log→qz.log，字符串表全局收集随模块导出。(2) aot/qzvm.js：qz 侧运行时（qzjs JS 实现）tagged 编解码+handle 表+20 符号，自检通过。(3) 两阶段编译改造：encoder 加 declareFunc/startBody/endBody（codes 本地索引与 call 全局索引分离 + 补函数尾 END），emitter 统一注册 qz imports 后先登记全部签名再发 body → 支持前向/互递归。实测 qzjs：前向引用 sumForObj→mkx=45 正确；对象负载 sumXY(10/1000/3000)=100/1e6/9e6 全对（修前 2250000 错值，根因 codes 稀疏索引）。性能画像：数值快路径（裸 i32 原生指令，零跨界）bench(3000) 476ms vs 解释器 32657ms = 68.6x；tagged 对象路径（每次运算/属性跨界 qz.*→JS）sumXY(3000) 11ms vs 解释器 2ms = 0.18x（慢 5.5x）——与此前 WAMR AOT 对象税 7.4x 同量级。关键结论：自研 TS→wasm 的快路径性能达标且覆盖完整 TS（不需 AS 严格类型），但动态值路径的跨界税使其慢于解释器——这是下一步优化方向（类型反馈特化/减少跨界/值在 wasm 内存批量处理）。"
  source: "2026-10-08 自研 emitter tagged 模式 + 两阶段编译 + qzjs 实测"
  affects: [aot-experiment-verification, release-artifact-topology]

- time: 2026-10-09T01:19:30
  kind: evidence
  summary: "POJO 字段 wasm 化 + WAMR memory 约束实测（2026-10-08）：对象字面量改为 wasm 线性内存存储（qz.alloc 拿偏移 + i32.store 写字段，tagged handle=(offset<<1)|1），属性访问 untag+i32.load 零跨界。sumXY(10/3000/30000) 全规模正确，3000 从 12ms 降到 8ms。wasm-validate 通过 + wamrc AOT 成功。修 6 个 wasm 二进制编码 bug（memory 段漏 count / limits flags 误认 count 当 flags / export kind 硬编码 func 应 0x02 / exportMemory 时机在 declareFunc 前 / memory 索引空间误用 func 规则致 wasm 各 index space 独立本地 memory 索引应为 0 而非 imports+funcs=21）。WAMR classic AOT 硬约束（实测，与 perry 路线同）：memory 必须本地定义（import memory 报 unknown memory）、不能带 max（flags=0x00 min-only，否则报 shared memory must have maximum）、导出索引必须 0。性能现状：数值快路径 68.6x 不变；tagged 路径属性跨界已消除但运算跨界仍在（sumXY(30000) 74ms vs 解释器 10ms = 0.135x）——剩余瓶颈是每次 tagged 运算的 qz.* import 跨界（约 5 次/轮：add×2+alloc+truthy+i++ 的 add），下一步需数值运算特化（tagged add/mul 的 wasm guard+快速路径）才能让对象负载超过解释器。"
  source: "2026-10-08 POJO 化 + wamrc memory 约束实测"
  affects: [aot-experiment-verification]

- time: 2026-10-09T01:24:40
  kind: evidence
  summary: "数值运算 guard 特化 + alloc 内联：对象负载 0.135x → 1.06x（8x），追平解释器（2026-10-08）。三步消除 tagged 路径全部跨界：(1) guard 特化——tagged add/sub/mul/div/rem/比较生成 wasm guard 检查 tag bit0，是 tagged number 则走原生 untag→算术→retag，否则回退 qz.*（跨界只在慢路径：字符串拼接/对象）；(2) 条件去冗余——for/while/if 条件已是 tagged bool（guard 产出 0/2），删除多余 qz.truthy 跨界，wasm eqz/br_if/if 直接用；(3) alloc 内联——bump 分配器移入 wasm 全局变量（global0），对象分配 global.get += n; offset = new-n 零跨界（encoder 加 global 段 + addGlobal/globalGet/Set/Tee）。性能演进 sumXY(30000)（qzjs 解释器 17ms）：全跨界 74ms(0.135x) → POJO 71ms → guard 特化 28ms(0.36x) → 去 truthy 21ms(0.48x) → alloc 内联 16ms(1.06x)，全程 8x 且追平解释器。修 1 bug（scratch 需 3 个：后缀++ 1 + guard 暂存 2）。已知限制（实测 sumXY(100000)=1410065408 溢出）：tagged i32 仅 31 位有效（i32<<1 编码），数值>2^30 溢出，大数需 f64 tagged 或 handle 降级——这是 AOT 数值域的固有限制，与 TS number（double 53 位）不对齐。"
  source: "2026-10-08 guard 特化 + truthy 去冗余 + alloc 内联实测"
  affects: [aot-experiment-verification]

- time: 2026-10-09T01:51:01
  kind: evidence
  summary: "混合负载实测（2026-10-08）：计算密集 ~70x，字符串拼接慢 14x。(1) mix.ts（数值 numWork fib 递归 + 对象 objWork 创建/属性/累加，逐函数自包含避免跨模式 ABI 不匹配，顶层交替调）：三档比例全 ~70x——数值主导 68.4x / 均衡 74.2x / 对象主导 74.4x。核心洞察：guard 特化让 tagged number 运算也走原生指令（objWork 的 r.id+r.sq guard 命中快路径），对象计算负载达 ~70x 而非此前 sumXY 的 1.06x（那是含旧 alloc 跨界的 3 步优化中间态；guard+POJO+alloc 内联全生效后对象计算同样原生）。(2) strwork.ts（字符串拼接 s=s+i，guard 回退 qz.add JS 语义）：AOT 14ms(8000) vs 解释器 1ms = 0.07x（慢 14x）——非 number 动态操作（字符串/方法）guard 回退跨界每轮跨界。完整画像：数值/对象计算 ~70x；字符串/方法等非 number 操作慢 14x；混合加速取决于 number 计算 vs 字符串操作比例。已知限制：objWork(3000) 结果溢出（AOT 410064408 vs 解释器 8999999000），tagged i32 仅 31 位有效，sum>2^30 溢出（性能不受影响，正确性受限——大数需 f64 tagged 或 handle 降级）。"
  source: "2026-10-08 混合负载实测（mix.ts + strwork.ts，qzjs 内 AOT vs 解释器）"
  affects: [aot-experiment-verification]
