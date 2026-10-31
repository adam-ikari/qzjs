---
id: aot-experiment-verification
title: "AOT 实验验证：TS→wasm→C99→so 链路成立 + fib 性能 8.97x"
category: decision
status: archived
tags: [aot, wasm, wamr, assemblyscript, ts2c, qzvm, experiment]
created: "2026-10-07T16:11:15"
updated: "2026-10-18T06:02:26"
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

## frontmatter title 数字的说明

title 里的「fib 性能 8.97x」是**首次测量**值（fib_only 零导入原型）；
最小编译器 ts2c 落地后同负载实测 25.22x（见下表）。以正文为准——CLI 无改 title 命令，
故此处记录漂移。

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

- time: 2026-10-10T13:25:42
  kind: decision
  summary: "f64 NaN-box tagged rep 落地（2026-10-10）：emitter tagged 路径原为 i32 位模型（31 位有效，`sum>2^30` 静默溢出）。新增 opts.tagged 选择：默认 f64 NaN-box（值=i64，数值=原始 f64 位型→原生 f64 指令零跨界 guard 快路径；句柄=高16位0x7FF9|低32 offset；POJO 字段 8 字节；精确 53 位），\"i32\" 保留 32 位宿主回退。新增 qzvm-f64.js 运行时（BigInt i64 跨界，truthy 返回裸 i32 0/1）；wasm-encoder 补 i64 指令集。build.js 按产物 meta.rep 自动选 runtime，--tagged i32 回退。test_aot.js 双 rep 回归：f64 bigAcc(3000)=3e12 精确 vs i32 溢出 2112827392——证明 rep 差异。全链 node WebAssembly + wamrc AOT 实测通过。"
  source: "2026-10-10 f64 NaN-box rep 实现 + 双 rep 回归"
  affects: [aot-experiment-verification]

- time: 2026-10-10T14:31:39
  kind: reversal
  summary: "反转 2026-10-08 的 32 位裁决：用户约束「32 位机器也要能计算 64 位」直接否掉 i32 tagged（31 位上限）回退。改为单 f64 NaN-box 表示，32/64 位宿主共用——wasm f64 恒 IEEE-754 double、与宿主字长无关，32 位由 wamrc 降到软/硬浮点，数值语义（含 >2^31 大数）不变。删除 QZ i32 表/全部 rep 分支/qzvm-f64.js（改名回 qzvm.js，makeQzvmF64→makeQzvm），build.js 删 --tagged/parseRep/meta.rep。同时补上 PORTABILITY 记的唯一缺口：build.js 新增 --target/--target-abi 透传 wamrc，实测 wamrc --target=i386/riscv32 交叉编译成功、i386 产物运行 bigAcc(3000)=3e12 正确。代价：软浮点 32 位目标 f64 算术 10–30x + 对象字段内存翻倍（正确性换表示统一）。PORTABILITY_32BIT.md §5 裁决已改写为「单表示」。test_aot.js ALL PASS。"
  source: "2026-10-10 用户裁决 32 位需算 64 位 → 单 f64 rep"
  affects: [aot-experiment-verification, release-artifact-topology]

- time: 2026-10-10T14:39:16
  kind: evidence
  summary: "32 位宿主端到端实测通过（2026-10-10）：-m32 编 WAMR libiwasm 2.4.5 + 最小 WAMR host（sizeof(void*)=4），加载 wamrc --target=i386 --target-abi=gnu 的 AOT 产物。解释器与 AOT 两路结果一致：big(3000)=3000000000000（3e12 > 2^32，证明 32 位 f64 NaN-box 精确表示 64 位量）、div(7,2)=3.5、mod/neg/循环均正确。这为『单 f64 表示，32/64 位共用』裁决提供真实 32 位证据（此前仅交叉编译成功）。未测 armv7/riscv32 真机。复现依赖：gcc-multilib + g++-multilib，编 WAMR 需 -DCMAKE_ASM_FLAGS=-m32（invokeNative_ia32.s）。"
  source: "wamrc --target=i386 + 32位 libiwasm/iwasm 2.4.5"
  affects: [aot-experiment-verification]

- time: 2026-10-10T16:10:33
  kind: note
  summary: "AOT 路径不依赖 quickjs 字节码（第一性原理澄清）。链路：emitter.js(tsc AST)→自研 wasm-encoder→.wasm；wamrc→.aot(原生 ELF)；执行 = WebAssembly.instantiate(wasm,{qz},{aot}) 在 WAMR 引擎内，非 quickjs；边界 = qz.* import + glue.js/qzvm.js(纯 JS)。已 grep 验证 src/ 零 qz_aot/aot_lookup/JS_AddAot/JS_Call 残留——旧 ts2c『C 扩展嵌入 quickjs + console.log 经 JS_Call』耦合已全删（.py/.c/.sh 无）。quickjs 仅作宿主提供 qzjs.fs.readFileBinary 读字节 + 调 WebAssembly.instantiate；换 node/bun/浏览器同样可跑。唯一弱绑定 = glue 用 globalThis.qzjs.fs（便利约定，可换 fs）。结论：wasm/AOT 产物宿主无关。"
  source: "grep src/ 无 aot-quickjs 绑定 + glue 加载路径"
  affects: [aot-experiment-verification]

- time: 2026-10-11T01:47:41
  kind: evidence
  summary: "字符串切片完成：wasm 内原生字符串表示（2026-10-11）。新表示：句柄高16位 0x7FFA（区分对象 0x7FF9），低32位=data段/堆 offset；内存 [len:i32 LE][utf8 字节]。字面量编译进 data 段（emitter 汇总 addData 一次性 emit，不逐条），_litOffset 去重。数字→十进制 qzs_numstr（i64 div/rem 循环 + 倒写）。拼接 s+x：qzs_append 判 buf 是否在 bump 顶（原地追加，零拷贝）否则新建拷贝——实测 strWork(200000) 80ms/1.08MB vs node V8 rope 10ms（真字节写入 vs 惰性 rope，符合预期）。guard 用 (v>>48)==0x7FFA 运行时判别；a 数 + b 串回退 qz.string_concat。qzvm._toJS 读内存解 0x7FFA 句柄；_utf8 手写解码 + DataView 位型（去掉 Buffer/TextDecoder，真 qzjs 运行时无这些全局）。glue 调 qz.bindMem(exports.memory)。修 3 个既有编码 bug：i64.shr_u 移位量误写 0x7FF9/0x7FFA（应为 48）、qzs_memcpy/qzs_numstr local.set on 空栈（应先 local.get 参数）、i64.trunc_f64_s 误用 0xAF（实为 0xB0）。test_aot.js 加字符串用例，全 22 检查 ALL PASS。"
  source: "2026-10-11 自研 emitter 字符串表示 + node/qzjs 实测"
  affects: [aot-experiment-verification]

- time: 2026-10-11T04:39:04
  kind: note
  summary: "tagged 路径循环条件与 i++ 跨界修复（2026-10-11）：emitCondI32 比较走 guard 原生 i32 谓词（新增 emitCmpI32）、tagged x++ 改 guard add（原无条件 qz.add / 条件 qz.truthy）。objWork(30000) 跨界 60001→0，292ms→1ms（~50x 反转）。顺带修 pre-existing guard 缺陷：谓词只认对象句柄 0x7FF9，漏字符串 0x7FFA → s==\"...\" 回落 f64 恒 false；抽 _emitIsHandle 覆盖两路。基准工具 bench_mix.js（复用 mix.ts/strwork.ts）。"
  source: "src/qzvm/aot/{emitter.js,bench_mix.js,ASSESSMENT.md,README.md}"
  affects: [aot-experiment-verification]

- time: 2026-10-11T05:03:20
  kind: note
  summary: "tagged 布尔/自增/逻辑语义修复（2026-10-11，评审跟进）：比较/!/&&/|| 改产 tagged bool f64 位型 0.0/1.0（原 i64ExtendI32U 产整数 1 → 当值得 5e-324）；if(!x) 原编译崩（prefix ! 直调 qz.truthy 产 i32 违 i64 契约，现 i32Eqz 取反+emitBoxBool 装箱）；&&/|| 左操作数误加 i32Eqz（等价 (!a)&b）已删；postfix 按 operator 分派 ++/--；prefix ++x/--x 实现。encoder 补 f64ConvertI32U。test_aot 全绿，objWork 仍 0 跨界。&&/|| 值语义(a&&b→b)仍未精确（简化为布尔）。"
  source: "src/qzvm/aot/{emitter.js,wasm-encoder.js,ASSESSMENT.md}"
  affects: [aot-experiment-verification]

- time: 2026-10-11T05:11:44
  kind: note
  summary: "% 运算符 wasm 内原生（2026-10-11）：tagged 新增 emitTaggedRem，命中 number 走 a - trunc(a/b)*b（= JS 余数，含负数/除零 NaN），回退 qz.rem；接线进 _emitBinOp 的 GUARD。修命名冲突：num 模式已有 emitRem，改名 emitTaggedRem 避免覆盖（否则 num % 崩）。10000 次含 % 的 tagged 循环跨界归零；num/tagged % 负数/NaN 全对。"
  source: "src/qzvm/aot/{emitter.js,ASSESSMENT.md}"
  affects: [aot-experiment-verification]

- time: 2026-10-12T00:58:29
  kind: note
  summary: "M2 语法补齐（2026-10-12，experiment/aot-v2）：switch/do-while/break+continue/三元/数组字面量+索引+length/num 位运算/模板字符串/for-of/tagged 位运算/||=&&=/标签语句/typeof/属性+索引赋值+复合赋值/嵌套对象字面量槽覆盖修复。test_aot 全绿。剩余大项：箭头/函数表达式（需闭包/lambda lifting）、数组方法 push/pop（需容量/增长）、字符串方法（需运行时支持）、try-catch/throw、类。属运行时设施而非语法补齐，超出 M2 范畴。"
  source: "src/qzvm/aot/emitter.js + test_aot.js"
  affects: [aot-experiment-verification]

- time: 2026-10-12T02:26:20
  kind: note
  summary: "三方性能对比（2026-10-12，AOT vs qzjs解释器 vs 原生V8，bench_mix.js 含 node 原生列 + performance.now 高精度）：numWork AOT 361ms = 比解释器快134x、比 V8 快2.1x（数值热点 AOT 超 V8 是核心结论：LLVM O3 + 零 JIT 预热 + 裸 f64）；objWork 1.3ms 比解释器快38x、比 V8 慢4-12x（V8 隐藏类）；strWork 30ms 比解释器慢6x、比 V8 慢248x（V8 rope 惰性拼接）。WAT 中间产物：build.js build/compile 经 wasm2wat 出 <prefix>.wat（审计/调试），工具缺失则跳过。"
  source: src/qzvm/aot/bench_mix.js build.js README.md
  affects: [aot-experiment-verification]

- time: 2026-10-12T02:46:38
  kind: decision
  summary: "TS→wasm 输出格式决策（第一性原理）：直出二进制 wasm，wat 仅按需旁路。理由：(1) wat 与 wasm 是同一 IR 的两种序列化——wasm2wat|wat2wasm 往返字节完全一致、幂等，wat 是 wasm 的 pretty-print；(2) 唯一下游 wamrc 只吃二进制（实测 wamrc mix.wat → Invalid magic header），直出 wat 每产物多一次 wat2wasm 文本转换纯开销 + 增外部依赖；(3) 可读性来自 name section 非 wat 格式——两者都因此可读；(4) 程序化生成二进制（固定 section + LEB128 长度前缀）比嵌套 S-expr 文本 bug 面小；(5) wat 丢字节级确定性（wat2wasm 规范化）+ 体积 9x。改进=给编码器加 name 段，非换格式。已实现：wasm-encoder Module({debug}) + build.js --debug → custom section id=0 函数名子段，反汇编 call 29→call $fib，不影响执行（test_aot ALL PASS）。"
  source: src/qzvm/aot/wasm-encoder.js build.js README.md
  affects: [aot-experiment-verification]

- time: 2026-10-12T02:49:33
  kind: note
  summary: "AOT --debug 调试信息完整：name 段子段1（函数名）+ 子段2（局部名，indrectnamemap vec(funcidx→namemap)）。--debug 下反汇编 param $n/local $i/local.get $i 全可读，合成槽匿名。默认关，不影响执行（test_aot ALL PASS）。build.js build/compile --debug 开关。"
  source: src/qzvm/aot/wasm-encoder.js emitter.js build.js
  affects: [aot-experiment-verification]

- time: 2026-10-12T06:36:47
  kind: note
  summary: "闭包/箭头函数（2026-10-12）：箭头/函数表达式提升为 __lam_N wasm 函数（签名 (blk:i32, 参数…i64)->i64），捕获变量存 bump 堆 cell 块（blk=[i64×captures]），闭包对象=[funcidx:i32][nCaps:i32][cells]。emitLambda 阶段1.5 扫描登记签名，emitLambdaBodies 阶段末发射。读经 capMap（blk+slot*8），调用走 qz.closure_call(handle,a0..a3)→JS 按 lamMeta{funcidx:{name,n}} 派发导出 __lam_N（无 wasm table——JS 分派，避免 function-table 接线）。凡函数体含 lambda 强制 tagged（num 快路径不含闭包）。build.js: .meta.json 增 lams 字段，glue 调 qz.bindClosures。test_aot 加闭包用例全绿。"
  source: "src/qzvm/aot/{emitter.js,qzvm.js,build.js,test_aot.js}"
  affects: [aot-experiment-verification]

- time: 2026-10-12T09:34:58
  kind: decision
  summary: "tagged wasm emitter 类支持落地（继承/super/字段默认值/方法动态分派）。类实例 = bump 分配内存 [0]=__cls(int32)，字段 i64 偏移表 _fieldIndex 与 POJO 共用全局 fieldMap（实例 size 取全表最大偏移）。ctor/方法统一 self+4 固定 5 参签名——原按实参个数变化导致 super()/跨签名调用 wasm 校验失败（类型不匹配）；独立方法上限 4 参。super() 在构造器内调父 ctor 后回写本类字段默认值（模拟 JS 派生字段初始化序）。合成派生 ctor 转发全部 self+4 参数槽（否则 new Puppy('bit') 丢参）。方法调用统一 qz.method_call(recv,mid,a0..a3)：qz 侧按 recv 类型派发，字符串→str_method，类实例→classMeta[clsId] 沿 parent 链查方法名调导出 __m_C$m。funcMode 遇 new 自动降级 tagged。glue 注入 classMeta + bindClasses；导出 memory/__bump 供 bindMem/bindBump。修两处既有缺陷：_emitFieldDefaults 缺 i32.wrap_i64（self 句柄直当 i32 地址）、qz.newobj bump 偏移未 8 字节对齐（Int32Array 视图抛 offset 非 4 倍数）。回归门 test_aot.js runClasses + cls.ts，ALL PASS。"
  source: "2026-10-13 qzvm/aot 类支持实测"
  affects: [aot-experiment-verification]

- time: 2026-10-12T14:20:56
  kind: decision
  summary: "AOT 类方法静态分派（faster dispatch）：识别静态精确接收者的方法调用，沿父链解析方法 owner 后直调导出 __m_<Owner>$<m>，跳过 qz.method_call 跨界。静态精确判据（保守，宁缺勿滥）：(1) 接收者标识符 xxx 由 `let/const x = new C(...)` 直赋，且 x 在全函数体内从未被赋值为其他值（含 for-of/in 绑定）也未出现在任何嵌套闭包内（闭包可延迟写）；(2) 叶类（无子类）方法体/构造器内的 this（new C 永不产 C 之外的实例，无跨类原型改写）。同名变量声明不同类型 → 整体不可判。仅直调「有返回值且非 setter」的普通方法；void/setter 语义与动态路径（动态恒返回 i64）不同，退回动态。实现：_computeStaticVars 按函数/方法体作用域计算，_mEnter/_mExit/emitFunc/_emitLambdaBody 全程保存恢复 _staticVars/_curClass；_staticRecvClass + _methodOwner + _classMethodMeta 解析。验证：cls.ts 回归全绿；探针 cls.ts 4 个调用点动态分派 4→2（子类未覆盖的虚方法仍动态，正确）；leaf.ts 叶类 this.sum() 静态解析到父类 0 次动态。收益：热点实例方法调用去 JS 跨界。"
  source: "src/qzvm/aot/emitter.js + test_aot.js"
  affects: [aot-experiment-verification]

- time: 2026-10-12T18:28:19
  kind: note
  summary: "字符串性能定位（2026-10-13）：修 qzs_numstr 负数 bug（无符号 div/rem → -42 产 '18446744073709551574'；改按符号取绝对值+i32 快路径）与 wasm-encoder OP 表缺 6 个 i64 比较 opcode（i64_gt_s/gt_u/le_s/le_u/ge_s/ge_u 0x55-0x5A；emit undefined → 0x00 unreachable 字节，静默地雷）。关键结论：字符串拼接热路径（s=s+x）在 WAMR AOT 下比同字节码在 node(V8) 慢 ~12x（400k 次 1 字节追加：WAMR ~75ms / V8 ~6.3ms / QuickJS 解释器 ~44ms）——非 emitter 结构问题。手写等价 wasm（原地 append）在 WAMR 下 ~3ns/次，故慢因在 WAMR AOT 对 emitter 产物（嵌套 block + 33 个 local + guarded 分支）的 codegen 质量。emitter 侧尝试均无实测收益：跳过运行时 isStr 检查（编译期类型追踪）、内联 append、memory.copy 替代 memcpy、精简 _emitIsHandle（11→7 指令）——A/B 多次取中位显示全在噪声内（o1 中位：HEAD 73.4ms vs 改后 75.4ms）。故回退编译期类型追踪（零收益的 ~90 行复杂度，YAGNI），仅保留真 bug 修复 + numstr i32 快路径 + memcpy 8 字节块。"
  source: "src/qzvm/aot/{emitter.js,wasm-encoder.js,test_aot.js} + node/qzjs AOT 实测"
  affects: [aot-experiment-verification]

- time: 2026-10-13T01:47:06
  kind: reversal
  summary: "推翻上一条（2026-10-13 晚）：字符串性能根因不是 WAMR AOT codegen，而是 wasm串→JS串转换 qzvm._utf8。决定性证据：strWork(200000) 的 wasm 循环本体（o1len 型，返回长度不返串）仅 4.7ms，返回串则 ~93ms——差异全在 _utf8。node(V8) 跑同一 wasm 快，只因 V8 的 += 有 rope 优化，非 WAMR 慢。旧 _utf8 逐字节 r += fromCharCode（每字符一次 JS_ConcatString，QuickJS 无 rope）= 1MB ~100ms。修复：ASCII 快路径（Uint32Array 每 4 字节批量测高位，命中则 String.fromCharCode.apply(null, u8.subarray(...)) 直接构造，免逐字节解码）+ 非 ASCII 分块解码（65535 apply 上限）。实测 o1(400k/400KB) 73→12.5ms，strWork(200k/1.09MB) 93→30ms。教训：老代码诊断先分离「计算」与「返回值穿越转换」，后者常是宿主语言（QuickJS）的字符串拼接常数成本，而非 wasm 执行。qzjs 的 TextDecoder 是 JS polyfill（比手写分块还慢），勿用。"
  source: "src/qzvm/aot/qzvm.js _utf8 + qzjs AOT 实测 (RETSTR vs RETLEN)"
  affects: [aot-experiment-verification]

- time: 2026-10-13T01:55:51
  kind: evidence
  summary: "分支级元分析（meta-thinking）：AOT 实验「精神 vs 字面」+ 文档数字漂移。【字面】「完整 TS→wasm 通用加速」：64 commit/3661 行只把短数值密集循环做到 V8 平价（numWork AOT:V8 ~2x 快、AOT:解释器 25x），字符串 AOT:V8 仍慢 35x（README 声称 248x，高估 7x）；async/generator 支持=0，单文件编译无模块解析。实测分层：strWork(200000) 循环体建串 ~5ms、wasm→JS 转换 ~24ms（本次已优化到 ~12ms）。【第一性】wasm/classic-AOT 与 TS/JS 本质不同构：①无 GC（bump：多次调用 OOM，实测必挂）②静态类型特化（动态站点=codegen 分支/宿主跨界）③classic AOT memory 须本地定义不可 import（无法共享宿主堆）④微运行时（host import 26 VS Perry 211）。=> 做「完整 TS 加速器」逆着抽象做，注定在『通用性×性能』同时输 V8。正确形态（若有需求）=类型化子集热函数加速器（Perry/shape B）+稳定 ABI。【文档】README/ASSESSMENT 性能表数字本次不可复现（strWork 30→4.6ms；AOT:V8 248x→35x；numWork:解释器 134x→25x，均漂 5–7x），写入时即失真——旧 GPU 驱动给早期 GPU 世界建模式的错。【拍板】qzjs 目标运行时是否无 JIT（嵌入 QuickJS-ng）→ 决定 25x 数值优势是否有意义。"
  source: "bench_mix.js×3 复现 + 分层实测 sN/sS/arrN/arrS + emitter/README/ASSESSMENT 静态审"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:00:04
  kind: evidence
  summary: "结合 qzjs 用例回顾裁决 AOT 分支：【权威定位】qzjs = 嵌入式 WinterTC 运行时，QuickJS-ng 引擎（ES2023，无 JIT，纯解释器）；目标市场=IoT 设备（gRPC/HTTP2 客户端）+云边缘（服务端）；护城河=小内存(2.45MiB stripped)/快启动(~5ms)/确定性+连接性。【用例】①边缘网关 JS 协议胶水(可热更不重编固件)②C 应用脚本面(initial_script+JSON 消息)③原生跑 WinterTC Web API(fetch/WS/serve)④Worker 并行。【负载特性】全部 I/O 密集：字符串/JSON/headers/URL/网络事件，短逻辑重复触发，非计算密集数值循环。【裁决】AOT TS→wasm 的唯一真实收益面=计算密集短数值循环(numWork 对解释器 25x)，与 qzjs 的负载面(字符串/对象协议胶水——恰是 AOT:V8 慢 35x/6x 处)几乎正交。且：快启动/小内存与 AOT(增 wamrc 工具链+.aot 每架构交叉编译+代码膨胀)取向相反；qzjs 已内置 WAMR 供用户自带 Rust/C→wasm 热代码，无需 TS→wasm。结论：AOT 分支的目标负载不是 qzjs 的负载，投入产出比低，倾向归档（保留学习价值）。"
  source: "README/ROADMAP/docs/guide/use-cases.md/brain qzjs-positioning 回顾 + 已实测负载特性"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:01:38
  kind: evidence
  summary: "用例 Taxonomy 修正（用户补充）：qzjs 有两种用法——Mode A「嵌入宿主当 JS 引擎」（C 宿主+稳健，护城河=体积/启动/确定/线程安全/隔离，负载轻=协议胶水；对应 IoT 固件热更、C 应用脚本面）；Mode B「qzjs 当程序核心、逻辑全用 JS」（CLI 或长驻服务，与 node/bun/deno 竞争，护城河=低开销/快启动/小 RSS/WinterTC 可移植；实证 examples/httpserver/server.js=纯 JS 完整 HTTP 服务，qzjs 只给原语；test/bench_cross_runtime.py 已做 qzjs vs node/bun 对比）。【对 AOT 裁决的锐化】——AOT 对两种模式都不服务：Mode A 计算轻，AOT 增 wamrc 工具链+每架构交叉编译+代码膨胀，与体积/启动取向相反；Mode B 的 JS 应用**必须有 async**（HTTP handler/fetch/timers），而 AOT 编译器 async/generator 支持=0、单文件无模块解析 → **根本无法编译一个 qzjs 服务应用**，只能编纯同步计算内核，而内核又缺调用 ABI（Perry/shape B 才有）。=> AOT TS→wasm 在 Mode A 无关紧要、在 Mode B 不可用。唯一出路=Perry 式类型化内核 ABI（另一个更小项目）。【Mode B 才是性能真正重要的地方】：此处 qzjs 与 node/bun 比，解释器数值 ~10x 慢于 V8（numWork 10.7s vs 0.8s）——I/O 密集服务无所谓，但计算密集业务弱；提升路径应是①保持 I/O 密集廉价 ②热内核 ABI ③JIT，而**不是** TS→wasm。"
  source: "examples/httpserver + test/bench_cross_runtime.py + serve() async 实证 + emitter async=0 grep"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:04:01
  kind: reversal
  summary: "修正上一条：Perry 式类型化内核 ABI 已被证不适合（ASSESSMENT.md：NaN-box ABI 与 qzjs import 机制（JS 函数+参数转 JS 值）结构性不兼容；桥式 codegen 把所有运算压进 js_add 调度桥），撤回『Perry/shape B 是出路』的建议。至此三条加速路线全部否决：①AOT TS→wasm（本分支：同构税+bump OOM+async=0，且不服务 qzjs 用例）②Perry 式桥（结构性 ABI 不兼容，已证）③AS（真实代码 AS 化率 0%）。【qzjs 唯一剩下的原生加速路径 = 编译期 C 扩展】（qz_ext_t + QZ_EXTENSIONS 静态链接，见 docs/guide/extensions.md）——热内核写 C 扩展，与 qzjs 自研扩展体系一致，无 ABI 桥。【终局结论】qzjs 性能 = QuickJS-ng 解释器速度（I/O 密集够用，计算密集弱 ~10x vs V8），热点下沉 C 扩展。本 AOT 实验的真价值 = 一个充实的**负结果**：无法在嵌入式解释器上廉价加 JIT 级性能，除非做引擎级工作或破坏性 ABI；否则就保持轻量+下沉 C。分支建议归档。"
  source: "ASSESSMENT.md Perry 裁决 + docs/guide/extensions.md + 用户更正（Perry 已证不适合）"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:06:02
  kind: reversal
  summary: "用户约束升级：『一次发布到处运行』是硬约束 → C 扩展作推荐性能路径被否（扩展是 build-time + 宿主级：QZ_EXTENSIONS 在库编译时固定、每平台一套，见 docs/guide/extensions.md）。撤回上一条『下沉 C 扩展』的建议（C 扩展仍可用于 Mode A 嵌入式本地特化，但不是通用性能架构）。【重排后的核心矛盾轴】可移植性 × 原生性能：①C 扩展=原生但不可移植（宿主构建）②user-authored wasm(Rust/C→.wasm)=可移植（同一 .wasm 在任意平台 qzjs 跑：WAMR Fast Interp，或本地 JIT/AOT 加速；.wasm 是便携件、.aot 是每架构件）+ 原生，但需 wasm 工具链 + 手动 FFI、非纯 JS ③TS→wasm 编译器=可移植 + 原生 + 纯 JS（无缝），但本实验证明其朴素形态（whole-program、无 ABI、async=0、无回退）失败。=> 唯一同时满足『便携+原生+纯 JS 应用』的形态 = 可续编/可互操作的 per-function TS→wasm（typed hot 编 wasm、dynamic 留解释器、共享 heap + jit 可回退）——这正是本实验**从未构建**的 shape A，比已做的 whole-program 难得多，横跨 QuickJS VM 内部。且即便成功也只救数值热循环（动态 string/object 仍不如解释器原生路径/V8）。【今日可用推荐】I/O 密集应用按解释器跑足够；热点用 user-authored wasm（便携、已支持）；TS→wasm 无缝路径是真正的产品野心、但属大工程。【本实验定位】不是『死路』，而是『对整个项目正确的方向、但造出的形态不满足便携诉求』。"
  source: "docs/guide/extensions.md build-time 证据 + QuickJS-ng 无 JIT + WAMR .wasm 便携件事实 + 用户约束"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:08:19
  kind: note
  summary: "重定位（用户澄清）：experiment/aot-v2 的目的是【验证 AOT 可行性 + 试验合适的方法】，不是产品分支。据此撤回我此前『倾向归档/挑 commit 进 master』的建议——实验室在探墙，不该按发布标准裁决。【作为可行性实验的记分卡】✅已验证可行：①全链 TS→自研 encoder/emitter→wasm→WAMR AOT→qzjs 跑通（64 commit、测试绿）②自研 encoder+emitter 不依赖 Perry/AS 可行 ③f64 NaN-box 单表示、32/64 位统一、精度正确（i386 实测 big=3e12）④零跨界内联方法有效（构造 73x、字段/条件/++ native）⑤wasm 内字符串原生表示可行 ⑥类/lambda/try-catch/数组覆盖可行。❌探到的墙（最有价值产出）：①bump 分配→重复调用 OOM，无真内存方案 ②无 async/generator→编不了任何异步应用（Mode B 归零），结构性 ③动态站点不退化为跨界就有性能悬崖，须逐站点内联 ④wasm↔JS 转换是 JS 侧常数成本（非 wasm 慢）——边界税真实存在但与被假设的不同 ⑤whole-program 每架构 .aot 破坏可移植 ⑥无回调解释器/互操作 ABI→无法部分编译（shape A 缺失）。方法✅合适：分层切片 PoC（1/2a/2b）、两阶段编译、guard 化热路径、内联分配、静态分派、每进程单跑（bump）、真实库验证（幸存者偏差）、常量折叠防线。方法❌不合适：whole-program 无 ABI 的形态（对目标死路）、追求覆盖完整动态 TS（async——对 spike 是错方向）、基准数字写入时漂移（134x/248x 今不可复现）。【唯一未答的可行性问题】shape A（per-function 编译 + 共享 heap + 调回解释器 + jit 回退）是否可行？本实验只答了『朴素 whole-program 可建造但不满足便携诉求』。下个实验应聚焦**边界 spike**（共享 heap + 调用约定 + 回退），而非再堆特性。"
  source: "用户澄清分支目的 + ASSESSMENT 方法论教训 + 本会话实测"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:17:26
  kind: decision
  summary: "关键决策（用户提问）：shape A 的『动态部分所需 JS 引擎放在哪』→ 裁决 A = 复用现在的 qzvm/QuickJS（宿主进程内引擎），否决 B = 把 JS 引擎嵌进 wasm。理由：①引擎已在进程内（QuickJS-ng 编进 qzjs 库/二进制），shape A 只需把它暴露为**回退目标**，非新引擎；②方向由 import 决定——ext_wamr 已支持 wasm→host-JS import（importObject，ext_wamr.c:119-140），故 wasm 热函数 import {qz:{callDynamic(sym,args)}} → JS glue → QuickJS 跑动态函数，**零新机械**，无需 wasm 内引擎；③B 架构性错误：wasm 内第二个 JS 引擎（a）翻倍体积/内存，毁 2.45MiB/5ms 护城河（b）正是已否决的高风险 v2 路径（QuickJS→wasm，ASSESSMENT：无 JIT 且需近完整字节码解码后端）（c）'复用 qzvm 中的 wasm 引擎'前提不成立——JS 引擎≠wasm 引擎，qzvm 无 JS 引擎，wasm 内跑 JS 必须把 JS 引擎编成 wasm=v2 路径，且自指（宿主 WAMR 跑模块、模块内再套 WAMR 跑引擎）；④GC/对象真相在宿主（qzvm.js handles 表 + JS 侧分配）——A 保持单一 GC，B 需跨边界 GC 双簿记，重触 OOM/分配墙；⑤性能：回退站点按定义是冷的（否则会被编译），宿主绑定跨界成本对冷路径无所谓；wasm 内引擎只在回退热时才有意义，而那时应编译而非回退。落地：新增一个 import 面（已具备）+ 符号/回退表（AOT 模块把动态调用点声明为 import，宿主解析到原 JS 函数）+ **源码必须保留**（混合模式：编类型化内核，其余留源码；或整体编译成 JS 与 wasm 双份）——体积 +「双份编译须语义一致」才是真风险，非引擎位置。A 不消除 shape A 的墙（共享 heap + 跨界类型保真），只是把难点**局部化到宿主绑定 + 共享 heap**，这是正确位置。"
  source: "ext_wamr importObject 证据 + AOT 目录无 qzvm.c + 本会话边界分析"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:25:55
  kind: reversal
  summary: "用户纠正两条，我此前的判断作废：①【不嵌套 wasm】当 qzjs 嵌入到 wasm 时，关闭 qzjs 自己的 wasm 编译开关（QZ_WITH_WAMR=OFF），改用宿主的 wasm 引擎——所以 B 形态与『模块内自套 WAMR』无关，我此前『B 必自指/双引擎』的反驳不成立。②【术语纠正】qzvm = 引擎（QuickJS-ng + wasm 引擎 + qz.* 原语），qzjs = qzvm + WinterTC/W3C/fs 等 polyfill 的组合；我此前把 src/qzvm/aot/qzvm.js（AOT glue）误当引擎。③【事实纠正】qzjs 内建 WAMR 的 JIT 是【关闭】的（CMakeLists 555-560：WAMR_BUILD_JIT=0、FAST_JIT/LAZY_JIT=0，只留 Fast Interp + AOT，理由=保持纯 C 可链接）；故『.wasm 可本地 JIT 加速』对 qzjs 内置引擎不成立——用户 .wasm 走 Fast Interp，或 wamrc 预编 .aot。④【用户补充约束】AOT 产物『脱离 qzjs 独立分发』只是该 AOT 工具的一种用法；『嵌入 wasm』（可嵌入性）是 qzjs 的重要使用场景。=> 决策轴改写：A=复用宿主 QuickJS（C/固件嵌入，引擎原生）；B=qzjs.wasm（wasm 宿主嵌入，自身 wasm 引擎关、用宿主 wasm）。【关键结论】两者【非互斥】——是同一 AOT 工具的两个嵌入 provider。AOT 工具的正确设计 = 动态调用点只发【可插拔 import 契约】（如 qz.callDynamic(sym,args)），provider 由嵌入目标注入：A 下 provider=宿主 QuickJS native；B 下 provider=qzjs.wasm（与 AOT 模块为宿主引擎内的两个兄弟模块，非嵌套，宿主解析 import 即完成链接——且 wasm→wasm 同级调用可能比 A 的 wasm→JS→BigInt 跨界更省）。这样 AOT 模块只依赖契约、不绑定具体引擎，同时满足『独立分发』与『嵌入 wasm』。【B 的真实门槛】不是引擎位置，而是 qzvm 核心的 WASI 移植：_qz_core_sources 硬依赖 libuv（uv_io.c 在核心，CMakeLists:637）+ thread.c/msgq.c/ipc 多线程 + fs。可行先例：mock_libuv 构建已把核心编到 mock_libuv.h（测试构建，646-648），说明 IO 抽象存在；但 wasm32/WASI 构建路径【完全未开始】（grep 仅 PORTABILITY_32BIT.md 理论枚举）。故 B 需 WASI 事件循环 + 线程/IO 后端，工程量中等偏大但边界清楚。"
  source: "用户纠正 + CMakeLists 555-560/637/646 证据 + grep wasm32 无结果"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:28:26
  kind: decision
  summary: "用户问『A 是否必要？因为如此方式可做到跨界调用零开销』。裁决：**A 不必要**，且 A 不是零开销的来源——「零开销跨界」来自 **WAMR raw-native 直连**机制（wasm_runtime_register_natives_raw，ext_wamr.c:1071/815/825），WAMR 直接从 wasm 跳 C、无 JS glue、无 importObject 闭包、无 BigInt 装箱。**现状 AOT 的 qz.* 恰恰走的是有开销的 JS 桥**：build.js:91  = importObject JS 闭包 → wamr_import_dispatch(ext_wamr.c:815) → 、 装箱。这与自定『热路径零宿主跨界』原则（brain aot-wasm-tagged-backend）矛盾——CX 想当然说『无跨界』时默认的就是 raw native。=> ①A（C 宿主）= 经 JS API 的 wasm→C-JS 边界，**纯度更低**，做不到纯零开销；保留 A 的仅有两个真实好处：引擎原生精确语义（完整 polyfill proto chain）+ 无移植成本。②B（宿主 wasm 内）= qz.* 由 C raw native 直答（同一 WAMR 实例），**这才是零开销跨界**的形态。③B 代价 = WASI 移植 qzvm（libuv/threads/fs），非引擎位置。落地：AOT 工具统一「动态/对象调用点 → import qz.*」契约，provider 二选一；契约本身不关心 provider（A 下 provider 降级为 JS glue，正确但慢；B 下 raw native 直连）。"
  source: "ext_wamr.c:815/1071 raw native 注册 + build.js:91 importObject JS 桥 + 用户零开销诉求"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:28:46
  kind: decision
  summary: "用户问「A 是否必要？因为如此方式可做到跨界调用零开销」。裁决：A 不必要，且 A 不是零开销的来源——零开销跨界来自 WAMR raw-native 直连机制（wasm_runtime_register_natives_raw，ext_wamr.c:1071/815/825），WAMR 直接从 wasm 跳 C、无 JS glue、无 importObject 闭包、无 BigInt 装箱。现状 AOT 的 qz.* 恰恰走有开销的 JS 桥：build.js:91 WebAssembly.instantiate(bytes,{qz},{aot}) = importObject JS 闭包 -> wamr_import_dispatch(ext_wamr.c:815) -> JSValue/BigInt 装箱。这与自定「热路径零宿主跨界」原则（brain aot-wasm-tagged-backend）矛盾——说「无跨界」时默认的就是 raw native。=> ①A（C 宿主）= 经 JS API 的 wasm->C-JS 边界，纯度更低，做不到纯零开销；保留 A 的真实好处只有：引擎原生精确语义（完整 polyfill 原型链）+ 无移植成本。②B（宿主 wasm 内）= qz.* 由 C raw native 直答（同一 WAMR 实例），这才是零开销跨界的形态。③B 代价 = WASI 移植 qzvm（libuv/threads/fs），非引擎位置。④唯一需 A 的场景 = 宿主引擎非 WAMR（Node/V8）：原生 wasm raw-native 直连不可用。落地：AOT 工具统一「动态/对象调用点 -> import qz.*」契约，provider 二选一；契约不关心 provider。"
  source: "ext_wamr.c:815/1071 raw native + build.js:91 importObject JS 桥 + 用户零开销诉求"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:32:20
  kind: decision
  summary: "用户定形态（先探讨，不写码）：qzjs 作为应用运行时，开发者自由二选一——(1) 手写 JS + wasm，或 (2) 写 TS 用工具链编为 wasm；二者都不用 WASI，能力受限于 qzjs 原语。核实结果：ext_wamr 只实现标准 WebAssembly JS API（module/instance/exports/memory/global），无任何内建原语导入命名空间（无 env/qzjs_native/host_import）——故当前手写 wasm 唯一可用的是 importObject JS 桥，零开销路径尚不存在。=> 形态结论：把 qz.* import 命名空间定为【ABI 契约本体】，AOT 编译器只是它的第一个客户；同一 ABI 有两个 binding：(a) JS shim（可移植到任意 JS 宿主含浏览器/Node，走桥，有开销）(b) qzjs 内 raw native（嵌入态，零开销）。同一模块字节两种绑定皆可跑，因为 import 由宿主的 importObject（JS）或 raw native（嵌入）各自解析。开发者两条路径（手写 wasm / TS-AOT）都发同一 ABI，故可互调；原语=raw native 零开销，动态/调用 JS polyfill=JS 桥（冷路径）。由此 A 与 B 不再是对立选项，而是【同一 ABI 的两个 binding】。缺口（今日不存在，需建）：①ext_wamr 暴露内建 native 命名空间（qz.* 直连 C，免 JSValue/BigInt 桥）；②ABI 版本化规范（内存约定+值模型+转义口）；③「无 WASI」的后果 = ABI 必须覆盖 syscall 面（时间/IO/分配）成为 wasm 世界的「最小 libc」，否则手写 wasm 残废。"
  source: "ext_wamr.c grep 无内建命名空间 + 用户形态输入 + 本会话 ABI/provider 结论"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:33:42
  kind: decision
  summary: "用户定形态（再收敛）：TS→wasm 工具链是【独立可复用组件】，可服务非 qzjs 项目；WASI 只是它的一个可选 target（ts 编译出 wasm 的选项之一），但【不是 qzjs 运行时能接受的形态】。=> 架构规则：TS→wasm 编译器 = 与运行时无关的组件，含【可插拔 lowering target】= 模块 import 什么（qz.* / WASI / 裸 none），编译器只发射 import 面，【不捆绑引擎】。qzjs 是【提供其中一个 target（qz.*）】的运行时，因此只接受 qz profile 的模块；WASI 目标模块只是为另一个运行时编译的，非 qzjs 的问题域（qzjs 拒绝它是对的，非缺陷）。同一 TS 源码多目标可移植——正是「工具链独立」的价值点。现状：emitter.js:26-60 的 QZ 表（22 原语）即 qz profile 的全部定义；build.js --target 是 CPU 架构（wamrc），【非】profile → 现工具链硬编码单一 target，无 target 抽象。缺：`targets: {qz, wasi, none}` 抽象（共享前端/降级逻辑，仅 import 面 + ABI 相关位不同）+ 独立分发（npm/CLI，现栖于 src/qzvm/aot/ 且带 node_modules，可分离）+ ABI 版本化。qzjs 侧职责：把 qz.* 做成一等、零开销、版本化路径（raw native 直连），并明确拒绝非 qz profile 模块。"
  source: "用户形态输入 + emitter.js:26-60 QZ 表 + build.js:128 --target=CPU架构"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:36:55
  kind: reversal
  summary: "用户定调（形态收敛，作废我此前的 ABI 框架）：【qzjs 没有任何 ABI 契约和承诺，只提供 WinterTC + W3C + 类 node 的必要 API】。=> 我此前「qzjs 提供 qz.* target」「qzjs raw native 直连 qz.*」「ABI 版本化」等形态全部作废。核实：qz.* 根本不是 qzjs 的东西——build.js:36 读取 qzvm.js（工具链自带 glue）、:82 makeQzvm(...)、:91 WebAssembly.instantiate(bytes,{qz},...) → qz.* 是【TS→wasm 工具链自带的一个 JS 运行期 shim】，随产物分发，跑在任意 JS 引擎（Node/浏览器/qzjs）上，全是标准 JS。故正确形态：①qzjs 的契约 = 标准面本身（WinterTC+W3C+类 node），非私有 ABI；开发者对着标准写 JS。②TS→wasm 工具链独立，其 target 选择的是【shim/target 环境】（今日 qz-glue=自带 qzvm.js；可选 WASI；裸 none），这是工具链的事，与 qzjs 无关。③互操作 = 标准机制：WebAssembly.instantiate(bytes, importObject) + 共享 ArrayBuffer（=qzjs 的 wasm 内存），全部标准 JS API；qzjs 侧零新增接口。④qzjs 唯一的速度杠杆 = 把标准 WebAssembly 实现好（precompile .aot，标准机制，零 ABI）；不承诺任何跨运行时 ABI。⑤零开销结论重述：标准 importObject 路径必然有跨界开销（web 平台固有，Node/浏览器同）——要零开销只有两条：(a) 裸 wasm f64 计算核（无边界），(b) TS→C99→共享库经 qzjs 原生加载器（根本不用 wasm；即 ASSESSMENT 里 C99 native 比 wasm2c 快 6x 的路径）。⑥因此 qzjs 范围反而收缩：不追 WASI、不设 ABI，只保证标准面完整 + 标准 WebAssembly 够快。"
  source: "用户定调 + build.js:36/82/91 证据（qz.* 属工具链 glue）"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:41:43
  kind: decision
  summary: "用户定形态（收敛闭环）：当后端是 qzjs 时，可把动态 JS 部分放进 wasm 内部【作为 qzjs 模块】运行——避免跨界开销（若有）。=> 此形态【闭环】了上一轮 no-ABI 结论：自包含模块 = 零 import = 零边界 = 无需任何 ABI 约定。证据：build.js:91 已是自包含形态（makeQzvm glue 内联注入）。机制：模块内嵌 qzjs（QuickJS 编到 wasm）+ 它自己冻结的 JS 世界；winterTC/W3C/类node 契约在【模块边界】兑现，不在 JS-engine 缝兑现；qzjs 是宿主、无新表面、无 ABI、无 WASI。零边界是【结构性】非优化：动态 JS 与 wasm 同 isolate/同内存 → JS↔wasm 是引擎直调，无 marshalling；仅宿主接触模块一次。诚实边界：模块内【无 OS】→ 纯计算原语可编、libuv/thread/fs 不可（无 wasi 则排 WM/线程/IO）→ 模块内【无 IO】。故自包含模式覆盖【纯计算动态 JS】（=数据变换/算法/对象字符串，正是 AOT 动态回退场景），不覆盖 IO 型 JS（IO 必须留在宿主外侧）。工程缺口（已核实）：QZ_PROFILE 只有 minimal|standard 且都含 WAMR，【无】纯计算内核档 → 需建「qzjs core」= QuickJS + 极薄 C 运行时 + qz.* 纯原语 + JS-host-capture 的 wasm32 target。工具链 target 应改为：qzjs（自包含，捆 qzjs core）/ wasi / none。"
  source: "用户闭环输入 + build.js:91 + CMakeLists:22-46（无纯计算profile）"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:42:32
  kind: reversal
  summary: "用户修正（作废我「qzjs core」措辞）：嵌进 wasm 内部的是【qzvm 模块】（引擎 = QuickJS + wasm引擎 + qz.* 原语），不是 qzjs；强调 qzvm 是因为【JS API 仍须走宿主 qzjs】。=> 分层定形：wasm 模块内 = qzvm（引擎，纯 VM，无平台 API）；宿主 = qzjs（WinterTC+W3C+类node API 面 + IO）。后果：①模块内动态 JS【免费拿引擎内建】（JSON/Math/Array/Object/String）→ 纯计算零边界；②平台 API（fetch/fs/net）在宿主侧 → 这些调用经 qz.* 原语跨界（qz.* 即【引擎↔宿主的阻抗匹配接口】，不是运行时 ABI 承诺，是引擎内建绑定）。故「零边界」精确适用范围 = JS 执行 + 纯计算；API 调用本质跨界（不可避免，因 API/IO 在宿主）。核实：src/qzvm/CMakeLists.txt:1 自述「qzvm —— 纯 VM 构建单元」，:35-42 QZVM_SOURCES 交回顶层并入 libqzjs → qzvm 已是可分离引擎单元，嵌入 wasm 天然。冲突发现：src/qzvm/CMakeLists.txt:15-24 对 QZ_WITH_WAMR 有 FATAL_ERROR「AOT 关键，不允许关闭」，与用户「嵌入 wasm 时关掉 qzjs 的 wasm 开关、用宿主 wasm」矛盾 → 需新增 build 档：in-module qzvm 不带 wasm 引擎（模块本身就是 wasm）。"
  source: "用户修正 + src/qzvm/CMakeLists.txt:1/15-24/35-42 证据"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:46:02
  kind: decision
  summary: "用户拍板：新增 in-module 档（模块内 qzvm 不带 wasm 引擎，模块本身已是 wasm）。且【模块内 qzvm 无需承诺 ABI 稳定】——理由：引擎+字节码+二进制接口已绑定到【一个不可分割的 wasm 模块】，内部接口不是跨单元契约，而是单一编译产物的内部实现。=> 最终形态：qzjs 无 ABI 承诺（只标准面）；wasm 模块自包含（引擎+字节码一体）；qz.* 是引擎↔宿主阻抗匹配接口（实现细节，非承诺）。ABI 辩论终结。待落地（最小改动，已核实触点）：①CMakeLists:25 档校验 regex 加 in-module + 预设 _prof_wamr OFF；②src/qzvm/CMakeLists.txt:17-24 FATAL_ERROR 加逃逸（in-module 允许双引擎 OFF）；③wasm32 工具链文件（现无，需建）；④libuv 依赖核心源（uv_io.c:637 / tcp_io / ipc / control_endpoint / rt_host）在 in-module 下排除或补 wasm32 后端；⑤host-only target（qz_cli / qz_lz4_compress）EXCLUDE_FROM_ALL；⑥deps（QuickJS-ng / mbedTLS / miniz）交叉编译 wasm32（mbedTLS 熵/fs → 疑排除）。关键分叉：模块内 app = (i) QuickJS 字节码作 data 段（无需 wasm 链接，但热路径解释执行）还是 (ii) emitter 产 wasm 与 qzvm wasm 链接（需 wasm 链接器）。用户措辞「字节码」指向 (i)。"
  source: "用户拍板 + CMakeLists:25 + src/qzvm/CMakeLists.txt:17-24 证据"
  affects: [aot-experiment-verification]

- time: 2026-10-13T02:50:23
  kind: decision
  summary: "第一性问题：libuv 归属。裁决：libuv = 宿主 OS 层，不进 wasm 模块。由 A4（OS/IO 只在宿主）强制。核实：src/qzvm 唯一碰 uv_ 的是 debugger_dap.c（可选，QZ_BUILD_DEBUGGER）→ 引擎核心 QZVM_SOURCES【零 libuv】；libuv 集中在宿主层 src/host(6/8)、src/io(2/2)、src/ipc、src/control(2/2)、src/msg(1/1)、src/host/thread.c。=> in-module 编译集 = QZVM_SOURCES + QuickJS + 极薄 C 底座，排除 libuv。libuv 不是公理，是宿主实现选择（A1 无 ABI → 宿主内部可替换为原生 epoll/kqueue）。架构后果（最硬点）：出现【两个事件循环】——模块内 QuickJS job queue（promise/microtask，自带，无 libuv）+ 宿主 libuv loop；timer/IO/DNS/crypto 全在宿主，模块内调用须跨界到宿主 loop（inversion，与现 qzjs「libuv 驱动一切」模型相反）。此桥接比「编到 wasm32」更难。"
  source: "grep uv_ 分层计数 + src/qzvm/CMakeLists QZVM_SOURCES + A4"
  affects: [aot-experiment-verification]

- time: 2026-10-13T03:12:33
  kind: decision
  summary: "用户定架构收尾：qzvm 提供 tick() API 供宿主调用；真实世界 IO 必须走 qzjs。=> 反转问题（两个事件循环）消解——【拉模型】：宿主 libuv loop 唯一；tick() 拉 qzvm 推进（microtask queue）；模块不自带 timer/loop，IO 经 qz.* 回流宿主；模块 reactive 不 proactive。核实：src/qzvm/context.c:262 已用 JS_ExecutePendingJob（QuickJS 内建 microtask pump）→ tick() 是薄封装，非新原语。无两 loop、无反转、libuv 100% 宿主。这是 in-module qzvm【可跑】的最后一环——loop 语义已定，不需要 libuv。剩余语义：IO 完成的续延——宿主 libuv 完成 IO → re-tick 模块 + 结果（回调/续延），这是 qz.* 管道要承载的状态机形态。"
  source: "用户定 + src/qzvm/context.c:262 + A4"
  affects: [aot-experiment-verification]

- time: 2026-10-13T03:14:28
  kind: reversal
  summary: "更正上一条（混淆 qzjs/qzvm）：tick 是【qzvm 的原语】（engine microtask pump，context.c:262 JS_ExecutePendingJob），不是 qzjs 的。qzjs（运行时/宿主）不需要 tick 抽象——native 形态直接调 qzvm 的 C pump；in-module 形态 qzvm 把 pump 导出为 wasm export tick()，host 调 instance.exports.tick()。归属：libuv=qzjs，tick=qzvm。host 驱动 guest，guest 不驱动任何东西。"
  source: "用户纠正 + context.c:262"
  affects: [aot-experiment-verification]

- time: 2026-10-13T06:25:43
  kind: decision
  summary: "用户重申并细化形态（本次）：TS 编译为 wasm ⇒ 模块内【静态部分是 wasm，动态部分在 wasm 内的 qzvm 中运行】（同模块、同 isolate、非嵌套宿主引擎）；与系统交互走两条 import 面——(1) qzjs 的 JS import（宿主 qzjs 运行时兑现，即 qz.* 阻抗匹配绑定），(2) WASI 的 import（wasm 运行时自己兑现，宿主 qzjs 不介入）。=> 校正与既有条目的关系：本声明与 02:41/02:42/02:46【模块内嵌 qzvm、动态 JS 同模块跑、qz.* 为引擎↔宿主阻抗匹配】一致；新增量 = 明确【两条可选 import 面】，其中 WASI 面此前在 02:33 被记为『非 qzjs 运行时接受的形态』——本轮校正为：WASI 是工具链 lowering target 之一（供『wasm 运行时』自己兑现的形态），与 qzjs 面并列而非被拒。"
  source: "用户本次架构声明 + build.js:128 --target(CPU) vs emitter.js QZ import 表"
  affects: [aot-experiment-verification]

- time: 2026-10-13T06:31:42
  kind: note
  summary: "术语精确化（用户纠正 + 源码核实）：02:25 条「qzvm = 引擎（QuickJS-ng + wasm 引擎 + qz.* 原语）」有三处不准。①qzvm 是构建单元（src/qzvm/CMakeLists.txt:35-44），源集 = context.c + vm_core.c + ext_lifecycle.c +【可选】ext_wamr/ext_wasm3 +【可选】debugger；不是「引擎」这个抽象层。②wasm 引擎在 in-module 档是【关掉】的（_prof_wamr/_prof_wasm3 OFF，CMakeLists:41-45），故 in-module 下 qzvm 源集只有前三者。③qz.* 前缀在 C 侧 grep 为空（不存在）——它是 AOT 工具链自带 JS shim（build.js:36/82/91 读 qzvm.js），跑在任意 JS 引擎，不属 qzvm。正确分层：qzvm = VM 构建单元（引擎核心语义 + 扩展生命周期）；QuickJS-ng = 其底层引擎（外部依赖）；qz.* = AOT 工具链 JS shim（02:36 已定性）。"
  source: "用户纠正 + src/qzvm/CMakeLists.txt:35-44 + grep qz.* in C 为空 + CMakeLists:41-45"
  affects: [aot-experiment-verification]

- time: 2026-10-13T08:05:33
  kind: note
  summary: "AOT 调试路径（本机实测，2026-10-13）：四层，中间能看两头断。①wasm 中间产物：node src/qzvm/aot/build.js compile src.ts <prefix> --debug → build/aot/<prefix>.{wat,strings.json,meta.json}；--debug 生成 name 段（wasm-encoder.js:92/103/269），wat 显示 $函数名，不影响执行。②TS→wasm 语义验证：node src/qzvm/aot/test_aot.js（node WebAssembly 直跑 emitter 产物，不依赖 wamrc，改 emitter 后第一道门）。③AOT codegen 审查：wamrc --format=llvmir-opt/-unopt 出 LLVM IR（看 qz.* guard 是否被优化成裸 f64）、--format=object 出原生 ELF（gdb/perf/objdump）；实测 cls.wasm → 503KB IR / ELF x86-64。④运行时 trace：qzjs build/aot/<prefix>.glue.js 运行（glue 经 globalThis.qzjs.fs.readFileBinary 读同目录 .wasm/.aot），在 qzvm.js 的 qz.* 方法包计数/打印抓 guard 未命中类 bug。【缺口】无 sourcemap/DWARF linetable → gdb 无 TS 行号仅有函数边界；WAMR 未编 --enable-dump-call-stack（CMakeLists:571-582）→ wasm trap 无栈回溯；无 qz.* 调用 trace 开关。"
  source: "build.js:57-70/123-158 + wasm-encoder.js:68/92/103/269 + test_aot.js:1-14 + wamrc --help 实测 (llvmir-opt/object)"
  affects: [aot-experiment-verification]

- time: 2026-10-13T08:37:26
  kind: decision
  summary: "标注 frontmatter title 数字漂移：title「fib 8.97x」是 fib_only 原型首次测量值，ts2c 落地后同负载实测 25.22x。CLI 无改 title 命令，故在正文记录，以正文为准。"
  source: "页内 fib 表实测值对照"
  affects: [aot-experiment-verification]

- time: 2026-10-18T06:02:26
  kind: reversal
  summary: "ts2c.py 早期实验（TS→C99→so 链路）工作树已删（refactor 2e43702e）；2026-10-18 用户裁决不走 AS/ts2c/wasm2c 早期路线，emitter.js 为唯一 AOT 主线（见 release-artifact-topology reversal）。本页实验数据作历史参考归档。"
  source: brain archive-page
  affects: [aot-experiment-verification]
