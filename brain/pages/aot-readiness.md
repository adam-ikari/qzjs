---
id: aot-readiness
title: "AOT 生产级就绪度：6.4% 真实库覆盖 + Map 静默错误两项独立致命"
category: decision
status: active
tags: [aot, readiness, wamr]
created: "2026-10-21T07:15:23"
updated: "2026-10-22T22:46:15"
---

<!-- compiled_truth -->
## 当前状态（2026-10-22）

AOT 编译覆盖率实测（zod 4.6.7，332 个 .ts 含测试）：成功 10（3.0%）。

**本日累计修复四类阻塞**（原合计 498 例 → 19 例）：
- #3 匿名默认导出（131→0）：collectDecls 就地补合成名 `__default_N`。
- #4 `export *` re-export（145→0）：不产生绑定，只校验目标在源码内。
- TS 重载签名（115→0）：collectDecls + 4 处嵌套收集统一加 `n.body` 过滤。
- 跨文件同名私有函数（107→19）：非导出函数按文件前缀改名 `__m_<stem>_<name>`，用 checker 符号身份重写声明+调用点。剩余 19 例是导出函数同名（外部契约，不能改名）。

**当前头号阻塞**：`[tagged] new 目标必须是标识符`（86 例）。`new A.B()` 属性访问式构造未实现。属已登记未实现路径。

**未修复**：#5 命名空间导入捕获、#6 generator/async、#7 corpus 与 V8 对拍。

## 结构性事实（未变）

功能缺口沿 import 图传播：一个阻塞点连带其整个传递依赖树失败。修复 498 例阻塞后总成功数仍 10，因剩余文件被 new 属性访问连带。


## Timeline

- time: 2026-10-21T07:15:23
  kind: decision
  summary: "Created this page: AOT 生产级就绪度：6.4% 真实库覆盖 + Map 静默错误两项独立致命"
  source: "zod 4.6.7 实测 + Map 最小复现"
  affects: [aot-readiness]

- time: 2026-10-21T07:15:34
  kind: evidence
  summary: "真实代码库实测（zod 4.6.7，125 个非测试 .ts）：AOT compileTS 成功 8/125 = 6.4%。阻塞点：104 匿名默认导出、10 export * re-export、1 命名空间导入捕获、1 emitter 崩溃(reading kind)。结构性事实：功能缺口沿 import 图传播——util.ts 自身无匿名导出，因 import 链传到 km.ts 整体失败。静默语义错误（最严重）：Map.set(k,obj) 后 Map.get(k) 取不到 obj；V8 输出 gname=a eq=true，AOT 输出 gname=undefined eq=undefined；m.size=1、m.has(1)=true 正确但值非同一句柄；不抛异常、编译成功、结果错误。已成立：numWork 348ms vs 解释器 9885ms=28.3x，audit_diff 47/47，stress_aot 870例0diff，内存 13.9->5.8MiB。判断：数值场景可用，通用 TS 应用不可用，Map 静默错误必须先修。"
  source: src/qzvm/aot/READINESS.md
  affects: [aot-readiness]

- time: 2026-10-21T07:33:29
  kind: reversal
  summary: "Map 静默错误已修复（推翻「根因在 Map set/get 句柄装箱」的初判）。真实根因：build.js 两处丢弃 compileTS 返回的 fields 字段偏移表——(1) 写 .meta.json 时未带 fields，(2) makeQzvm(strings,{arenaEnd}) 未传 fields。glue 里 fieldEntries 恒空 → qzvm 的 toJS 判据 (mem && fieldEntries.length) 为假 → POJO 句柄走 handles[idx]（undefined）而非 materialize()。影响面是全局性而非 Map 专属：任何跨宿主边界的对象字面量都会退化。验证：修复前 glue_audit 1/5，修复后 5/5；audit_diff 全量 corpus1..41 零 diff。关键教训：audit_diff.js 直调 compileTS 后手动 makeQzvm(r.strings,{fields:r.fields}) 自己补了字段表，绕开 build.js glue 装配路径，故 889 例全绿仍漏检——测试路径与产物路径不一致使缺陷不可见。新增 glue_audit.js 走真实 build.js→glue→qzjs 链路，唯一能捕获装配层缺陷的测试。"
  source: "commit fix(aot): 宿主容器持有对象字面量退化成 undefined"
  affects: [aot-readiness]

- time: 2026-10-21T07:51:55
  kind: reversal
  summary: "READINESS 第 2 项（emitter 崩溃 reading 'kind'）已修复。根因：collectClasses 收集类方法时不过滤 mem.body，TS 重载签名（无实现体）被当成方法入列，emitAll 取 mth.node.body 得 undefined。修复：成员循环跳过 !body 的 MethodDeclaration；ctor 仅在 body 存在时赋值；无 body 访问器跳过。附带修复 qzvm.js 两处 process.env.QZDBG 调试残留（qzjs 无 process 全局，命中即崩）。新发现独立缺陷（未修）：audit_diff 的 pure-wasm 路径（instantiate 两参无 AOT）在类字段为数组字面量时崩 Cannot convert undefined to a BigInt，同一 wasm 经 AOT 执行正确。最小复现 class C { content: string[] = []; add(s){this.content.push(s)} }。这是 WAMR AOT 与 wasm 解释器语义差异，优先级待定。验证：glue_corpus_overload 修复前 1/4 → 修复后 4/4；audit_diff 全量零 diff。"
  source: commit f549313f
  affects: [aot-readiness]

- time: 2026-10-21T08:05:37
  kind: evidence
  summary: "科学计算基准（BENCH_SCIN.md，11 负载）。num 快路径比解释器快 10-42×、与 V8 同档（0.40-2.76×）。tagged 路径比解释器慢 5-30×。决定性对照：同一 N 体算法，局部数组写法(tagged) 426ms vs 标量写法(num) 1.77ms，差 241 倍。funcMode 判定（emitter.js:2548）要求函数体无数组字面量/箭头函数/属性访问才编 num。结论：READINESS 的「数值场景可用」前提比原判断更严——不是「无对象 I/O」而是「完全不用数组」。真实科学计算库几乎必用数组，故现状无法提速。下一步：把 num 路径扩展到数值型数组（Float64Array 或编译期可推断长度的 number[]）。同时修了 pure-wasm void 方法返回值未归一（commit 050681c5）：methods 派发 fn(...) 返回 undefined 而导入签名是 result i64，V8 严格检查崩溃、WAMR AOT 宽容，故只有 audit_diff 路径崩；修法 callM 归一 undefined→TAG。"
  source: "commit 370070ef, 050681c5"
  affects: [aot-readiness]

- time: 2026-10-22T02:54:52
  kind: evidence
  summary: "NaN-box 判定折叠：_emitIsHandle 24→5 指令、_emitIsBig 11→5，标签连续故退化为无符号区间测试（下界 0x7FF8…0001 避开 canonical NaN）。mix.wasm 35471→30959B(-12.7%)，scin.wasm 11453→10533B(-8.0%)。objWork 对 V8 从 58.4x 慢改善到 19.3-27x。实测 objWork 剩余差距 80% 来自每轮对象分配而非数值运算（去分配后 200k轮 5ms→1ms）——静态 bump 堆无 GC/逃逸分析，属结构性差距。另修全 --interp 产物编译崩溃（emitNumArrHelpers 依赖 emitStringHelpers 内的 qzs_ckmem，抽出 emitMemHelpers）。回归：audit_diff corpus1-41 全 0 diff，scin 11/11 数值一致。"
  source: "bench_mix + bench_scin 实测；audit_diff 全量语料"
  affects: [aot-readiness]

- time: 2026-10-22T03:05:17
  kind: reversal
  summary: "推翻此前结论「strWork 走 --interp 回退、字符串拼接放弃 wasm 化」。真因是 bug：逃逸分析 _strAccSetOf 把 return s 判为逃逸 → 累加器从未识别 → 每轮 qz.str_dup 复制整串 → Θ(n²)，200000 次直接 bump arena 溢出崩溃（N>2291 即崩）。修法：放宽为「函数末尾纯返回也可原地追加」（纯返回后没人再改写该缓冲区；循环内提前 return / 多 return 分支 / 别名 / 自拼接仍保守回退复制）。效果：200000 次从崩溃→26.7ms（解释器 27.0ms），复杂度 O(n)。bench_mix.js 的 strWork 已去掉 interp 名单，重新纳入 AOT 覆盖。新增 7 条 str-acc-* 边界语料到 audit_corpus4.js（38→45 例）。同时踩坑记录：ts.forEachChild 回调返回真值会提前终止遍历——assignedNames 里返回 out 导致只扫第一个子节点，全部漏判。"
  source: "strWork 实测 + audit_diff corpus4 45/45"
  affects: [aot-readiness]

- time: 2026-10-22T03:51:22
  kind: evidence
  summary: "对象分配填充展开：_emitFillUndef 原用运行时 loop 逐 8 字节写 undefined（比较/分支/指针自增）。size 是编译期常量（_instSize = 全局字段表大小+8），<=8 槽时改为定长 i64.store 展开，省掉循环控制。实测 300k 轮 objReal 5ms→3ms（每轮 17ns→10ns，分配路径提速 40%），wasm 3613B→3006B(-17%)。踩坑1：调用点 4470/4527 传的是运行时变量 cap/size，须 typeof size==='number' 才展开。踩坑2：展开的 store 地址要 localGet+i32Const+i32Add 三步，漏 i32Add 直接 wasm 编译失败（栈不平衡）——原循环版把地址算在 local.set(t.c) 里所以看不出。踩坑3：判断展开是否生效不能 grep 'loop'，外层 for 循环也叫 loop，要看 undefined 常量的连续 store 偏移(8/16/24/32)。"
  source: "objReal 300k best-of-11 对照（stash 前后）"
  affects: [aot-readiness]

- time: 2026-10-22T04:02:57
  kind: evidence
  summary: "循环级 arena 回滚（解决 bump 堆只增不减的硬天花板）。真问题：任何分配循环 419427 轮后必然 'qz arena exhausted' 崩溃（每实例 40B × 419427 ≈ 16.8MB arena）。方案：_loopArenaFree 逃逸判定 + tagged for 循环入口存 bump、每轮末尾复位。效果：300 万轮 26ms（此前 40 万轮即崩），1000 万轮 91ms 仍正确。逃逸判定严格保守——循环体内对象字面量变量必须只以 x.field/x[..] 出现，且体内无 return/throw、无闭包、无跳转；不满足就完全不复位。已验证 4 个危险场景（存数组/赋外部变量/中途 return/闭包捕获）全部正确不触发回滚，与 V8 逐值一致。新增 6 条 loop-alloc-* 语料（corpus4 45→51 例全过）。布局：每个嵌套循环层一个 i32 保存槽，_loopSaveBase/_loopSaveCount/_loopSaveDepth 由 _countLoops 静态定界。"
  source: "3000万轮实测 + corpus4 51/51 + 6 逃逸场景 V8 对照"
  affects: [aot-readiness]

- time: 2026-10-22T04:40:15
  kind: evidence
  summary: "循环 arena 回滚扩展到 while / do-while。此前只为 tagged for 接线，等价写法 while(i<n){const r={...};...} 仍会在 41.9 万轮崩溃——同一语义三种循环形态行为不一致是隐藏的坑。现抽出 _arenaLoopEnter(body)/_arenaLoopLeave(slot) 两个辅助，for / while / do-while 统一调用。实测 200 万轮：for 18ms、while 17ms、do-while 22ms，数值与 V8 精确一致。已知无损边界：while 的 continue 直接跳回条件、没有独立 cont 块，会跳过该轮复位——只少回收不影响正确性（for/do-while 的 continue 经过 cont 块，正常复位）。逃逸仍不触发回滚：whileEscape 每轮 keep.push(r) 200 万轮照旧 arena 耗尽，符合预期。新增 3 条 loop-alloc-{while-safe,do-safe,while-escape} 语料，corpus4 51→54。"
  source: "三形态 200 万轮实测 + corpus4 54/54 + V8 数值对照"
  affects: [aot-readiness]

- time: 2026-10-22T05:49:42
  kind: decision
  summary: "函数级 arena 回滚 + 修掉 lambda/方法体的 loopSaveBase 状态残留。新缺口：循环回滚看不到「循环体不分配、被调函数内分配」——for(…)t=t+mk(i)，mk 每次造临时对象返回标量，41.9 万次调用后 arena 耗尽。方案 _fnArenaFree：判据必须能证明返回值不指向 arena，否则复位让返回值悬空（静默 corruption 比崩溃更糟）。①返回类型标注 number/boolean/void/undefined；②体内确有对象字面量分配；③无 try/throw/闭包/new；④对象局部只以 x.field/x[..] 出现，return p 整体逃逸被拒。在每个 return 前复位（返回值求值之后）。实测 manyCalls 200 万轮 20ms、1000 万轮 106ms；manyRetObj 返回对象照旧耗尽——正确拒绝。顺带发现并修掉两个真实缺陷：lambda 体(_emitLambdaBody)和类方法体的 scratchObj 站点从未设置 _loopSaveBase/_loopSaveCount，会继承上一个函数的值 → 用错误槽号存/取 bump。现在两处都显式重置并按各自 body 的 _countLoops 声明槽位。踩坑：第一版在 check() 之外又加了一段 return 遍历、没做属性访问过滤，把 return p.x+p.sq 里的 p 误判逃逸，判定恒 false（与之前 _loopArenaFree 的自反 bug 同类）。新增 5 条 fn-alloc-* 语料（2 接受 + 3 保守拒绝）。全量 corpus2..42 全过。"
  source: "manyCalls 1000万轮实测 + corpus4 63/63 + 全量 41 库 0 失败 + bench_scin 数值一致"
  affects: [aot-readiness]

- time: 2026-10-22T05:54:48
  kind: decision
  summary: "把 arena 回滚的分配识别从「仅对象字面量」扩展到 数组字面量 + new C()。抽了共享谓词 _allocInitName，循环级和函数级都复用它。new 需要额外保护：新增 _ctorKeepsThis 检查构造体是否把 this 交给外部（return this / 存容器 / 传参 / 闭包捕获 / 非 this.field 用法）→ 泄漏则拒绝，否则复位会让那个外部引用悬空。找不到类定义或无显式构造 → 一律拒绝（字段初始化可能逃逸）。实测 loopNew 200 万轮此前 arena 耗尽崩溃 → 现 14s 不崩且数值与 V8 一致；loopArr 20ms。重要发现：new C() 实例化要走 ~3.4µs/次，而对象字面量 ~10ns，差 300 倍。已用 git stash 验证回归前同为 349ms（100k 轮），属既有独立性能缺陷、与本次回滚改动无关，已记入 BENCH_SCIN.md 待查。"
  source: "loopNew/loopArr 200万轮实测 + 术前术后 loopBox 对比 349ms vs 348ms + corpus4 66/66"
  affects: [aot-readiness]

- time: 2026-10-22T06:31:55
  kind: reversal
  summary: "类实例字段写慢 300 倍的根因：_emitStoreProp 把 0x7FFE（类实例）和 0x7FFF（闭包值）一起排除出内存快路径，统统走 qz.prop_set 宿主跨界（每次 ~1µs）。原注释担心「闭包值偏移当基址做 i64Store 会静默写坏内存」，对闭包值成立，但对类实例不成立——二者布局一致（[off]=clsId [off+4]=size [off+8..]=fields）。修正：从拒绝列表移除 0x7FFE，让类实例字段写走内联 i64Store。同时修了 buildInstance（宿主侧 Reflect.construct 建实例）的潜伏缺陷：它此前不设 [off+4]=size，导致 prop_set/prop_get 的越界检查恒失败、读写分流到 extras 映射而非内存——内联 store 后就会读写不一致。现与 _emitNewCall 统一设 [off+4]=size。效果：loopBox 10 万轮 348ms → 1ms（348×），1000 万轮从崩溃 → 127ms。全量 41 库 0 失败。"
  source: "loopBox 三档实测 + c28 reflect-construct-ownkeys 复现修复 + 全量 41 库"
  affects: [aot-readiness]

- time: 2026-10-22T06:49:18
  kind: decision
  summary: "arena 容量从 16MiB 提到 34MiB：独立档布局 [scratch][bump arena][字面量段]，原先 arena 只占总内存 40%（40MiB→16MiB），字面量段独吞 60%。但字面量段用量是编译期常量、留 24MiB 纯浪费，实测绝大多数模块远低于 4MiB。改为 arena 占 85%，字面量段保留下限仍 4MiB。纯编译期常量改动，分配路径零开销。效果：100 万元素数组/20 万次字符串追加/10 万存活对象从 arena 耗尽崩溃 → 11ms/2ms/1ms。全量 41 库 0 失败。注意：仍无真正回收器，也只是把天花板推高约 2 倍（100 万→200 万元素级别），不是消除。"
  source: "hugeArr/hugeStr/keepObjs 实测 + 全量 41 库"
  affects: [aot-readiness]

- time: 2026-10-22T07:04:26
  kind: reversal
  summary: "arena 天花板真解决了（推翻上一轮的「推高 2 倍」）。上一轮改比例 40%→85% 只是把死限从 16MiB 提到 34MiB，没解决根因：布局是 [scratch][arena][字面量段]，arena 在字面量**下方**，向上扩会压到字面量。本轮重排成 [scratch][字面量段][arena]——字面量段是编译期常量（第一趟的 _litCursor 即得），摆低地址永不动；arena 接其后，上界从编译期常量改成 global，越界时 memory.grow 抬高，直到 4GiB 物理极限。同时补了 wasm-encoder 缺的 memory.size/grow 指令；宿主 bumpAlloc 原先硬编码 ARENA_END=16MiB 是第二个独立天花板，也改成按需 grow 并重建失效的 Uint8Array 视图。实测 100万/500万/2000万/5000万元素数组：全部从崩溃 → 12/63/248/467ms。全量 41 库 0 失败。in-module 档内存归 libqzvm 管不可 grow，仍走常量上界，未受影响。教训：修容量问题时先看布局能否支撑增长，别只调参数。"
  source: "worker: memory.grow 实测 + corpus2..42 全量 41 库"
  affects: [aot-readiness]

- time: 2026-10-22T22:27:26
  kind: evidence
  summary: "READINESS #3 #4 已修复（commit de528c87）。(#3) 匿名默认导出 export default function(){}/class{}：TS 符号表 valueDeclaration.name 为空 → 无稳定顶层名可折回，此前整条 import 链报错失败。修法：collectDecls 遍历顶层声明时，对带 DefaultKeyword 的匿名函数/类声明就地补合成名 __default_N（节点身份不变，checker 仍指向它，后续 emit/import 解析走 st.name.text 原路径）；已有 __clsExpr_N 先例。interp 回退 stripModuleSyntax 另修：target.name 对匿名默认导出是 \"default\"，改从 valueDeclaration.name 取真名。(#4) export * from './m' 不产生新绑定——内联后模块边界消失，目标文件顶层声明本就在同一 wasm 模块，无需发射任何代码，只校验目标在源码集合内；消费方 import {x} from './relay' 经 checker.getAliasedSymbol 自动穿透 star 链，与具名 re-export 同路径；外部模块仍显式报错。zod 4.6.7 332 文件实测：匿名默认导出 131→0、export * 145→0，两类阻塞归零。总成功数仍 10，因剩余文件被下层阻塞（同名函数跨目录冲突）连带失败——功能缺口沿 import 图传播的结构性事实未变。新头号阻塞：zod v3/v4 各有一份 util.ts/types.ts，内联到同一 wasm 模块后顶层名撞车（101+8+6 例）。"
  source: "src/qzvm/aot/emitter.js, READINESS.md, coverage_real.js"
  affects: [aot-readiness]

- time: 2026-10-22T22:27:29
  kind: decision
  summary: "READINESS #3 #4 已修复，头号阻塞转为同名冲突"
  source: commit de528c87
  affects: [aot-readiness]

- time: 2026-10-22T22:45:26
  kind: evidence
  summary: "READINESS 新增修复（commit 256928be）：① TS 重载签名（export function issue(x:string):R; 无实现体）此前被当独立函数收集 → 顶层名冲突连带 import 树失败（zod v4 core/util.ts 的 issue 三声明占 101 例）。修法：collectDecls + 4 处嵌套函数收集（_collectScopeFnDecls/_collectLambdas/自由变量分析/lambda 收集）统一加 n.body 过滤。无 body = 重载签名，不进 fns/不建闭包/不当 lambda/不入局部名表。② 跨文件同名私有函数自动消解：zod v4 core/compile.ts 与 core/schemas.ts 各一份 getTupleOptStart，都模块私有，内联后顶层名撞车。修法：同名组里非导出函数按文件前缀改名 __m_<stem>_<oldName>，用 checker 符号身份重写该文件内所有指向它的标识符（声明+调用点一并改），emitter 全程只读 .text 故自动跟随。导出函数名是外部契约，保留显式报错（消息改「导出函数名冲突」）。zod 332 文件实测：重载 115→0，同名 107→19。新头号阻塞 [tagged] new 目标必须是标识符（86 例，new A.B() 属性访问式构造，已登记未实现）。READINESS 差距 #3 #4 #5（重载）均已修，#6 generator/async 仍未实现。"
  source: "src/qzvm/aot/emitter.js, coverage_real.js"
  affects: [aot-readiness]

- time: 2026-10-22T22:46:15
  kind: decision
  summary: "重载签名+跨文件同名私有函数已修，头号阻塞转为 new 属性访问"
  source: commit 256928be
  affects: [aot-readiness]
