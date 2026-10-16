---
id: aot-wasm-tagged-backend
title: "AOT tagged 后端（emitter.js→wasm）：热路径零宿主跨界原则"
category: decision
status: active
tags: [aot, wasm, emitter, qzvm, perf]
created: "2026-10-12T15:51:52"
updated: "2026-10-16T19:36:57"
---

<!-- compiled_truth -->
# AOT tagged 后端（emitter.js → wasm）

`src/qzvm/aot/emitter.js` 把 TS 子集编译为 wasm（tagged 值 = NaN-box i64，高 16 位 tag）。
`qzvm.js` 是宿主运行时（JS import，`qz.*`）。区分两类通道：

## 原则：热路径零宿主跨界

宿主 import（`qz.*`，JS 实现）每次调用 = JS↔wasm 跨界 + BigInt/句柄装箱，成本高。
**凡能在 wasm 内联完成的操作用力内联，宿主只留不可内联者**（字符串 UTF-8 语义、动态分派兜底）。

已内联（零跨界）：
- **POJO 字面量** `{x:v}`：bump 分配 + `i64.store` 字段。
- **数组字面量**：header(16B)+data 块，句柄稳定。
- **类实例分配** `new C()`：`_emitNewCall` 内联 bump（`off=(bump+7)&~7`，写 `[off]=clsId`），
  句柄 `0x7ff9<<48 | off`。**原走 `qz.newobj` 宿主 → 构造热路径 ~73x 慢**（clsbench 50000×:
  34.4ms → 0.47ms）。`qz.newobj` 已删（死代码）。
- **类方法调用**：静态可判 owner 时直调 `__m_<C>$<m>`（LLVM O3 可内联），
  仅不可判时走 `qz.method_call`（动态派发 212x 慢）。

仍走宿主（不可内联）：字符串方法（UTF-8/UTF-16 语义）、`qz.method_call` 兜底、
数组 push 增长（`qz.alloc` 裸偏移）。

## bump arena 边界与生命周期（静态部分无 GC）

静态编译出的 wasm 不做 GC；动态部分（qzjs 解释器）才有 qzvm 的 GC。故 bump 堆需显式边界与生命周期：
- **布局**：内存 256 页 = 16 MiB。bump arena `[SCRATCH, STR_BASE)`，`STR_BASE = 8 MiB`；
  字符串字面量 data 段在 `[8 MiB, 16 MiB)`。
- **守卫**：所有 bump 增长点（append/POJO/数组字面量/push 扩容/new/lambda 闭包）统一经 wasm 内
  `qzs_ckmem(newBump)` —— 越过 `STR_BASE` 即 `unreachable` trap；宿主 `qzvm.bumpAlloc` 同界抛错。
  杜绝静默覆盖字面量段 / OOB 崩溃。
- **重置**：导出 `__bump_reset()`；glue 的 `__call` 与 `test_aot` 每次调用前调用，
  使一次调用的 arena 占用与调用时长解耦（否则长循环累加耗尽 arena）。

## 判定与验证

- 局部槽布局随内联新增而变化：`emitFunc`/lambda/`_mEnter` **三处**同步追加 wasm local 声明
  （`startBody` 的 types 数组），漏一处则槽号错位。
- 回归门：`src/qzvm/aot/test_aot.js`（node WebAssembly 直跑，无需 wamrc）。
- 性能门：`clsbench.ts`（new/方法分派）经 `build.js` + qzjs 跑。


## Timeline

- time: 2026-10-12T15:51:52
  kind: decision
  summary: "Created this page: AOT tagged 后端（emitter.js→wasm）：热路径零宿主跨界原则"
  source: "会话：修构造开销 + 字段自增"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-12T15:51:58
  kind: decision
  summary: "AOT tagged 后端：热路径零宿主跨界（分配/分派内联 wasm）"
  source: "会话 2026-10-12"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-13T06:23:06
  kind: note
  summary: "交叉引用：数值表示维持 f64 NaN-box（num 快路径已是裸 f64，非 NaN-box）；原生整数 i32/i64 实测仅快 12-18%，被精度/语义/32位三约束否决。性能模型记入 aot-performance-model。最大杠杆 = qz.* import 从 JS 函数改 WAMR raw native（跨界税 4.9µs→45ns）。"
  source: "讨论 2026-13"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-15T00:41:34
  kind: decision
  summary: "bump arena 生命周期裁决（静态部分无 GC）：STR_BASE 1MiB→8MiB 为 arena 上限；wasm 侧所有 bump 增长点统一经 qzs_ckmem(newBump) 守卫（越界 unreachable trap，杜绝静默覆盖字面量段 / OOB）；宿主 qzvm bumpAlloc 同界 8MiB 抛错；新增 __bump_reset 导出，glue/test_aot 每次 __call 前重置 bump 到起点（一次调用 arena 占用与时长解耦）。内存 128→256 页（16MiB）。原 bug：bump 永不重置且无边界检查——跨调用累加耗尽 arena、静默覆盖字面量或 OOB 崩溃。"
  source: "会话 2026-10-14：修 bump 边界"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-15T00:41:42
  kind: decision
  summary: "补充 bump arena 边界与生命周期"
  source: "会话 2026-10-14"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-15T04:05:49
  kind: decision
  summary: "语义精度原则（用户裁决 2026-10-15）：**不可用性能换语义精度**，任何『简化掉 JS 语义以换快路径』按缺陷处理而非 tradeoff。依据：num 快路径把 &&/||/||=/&&= 编译成『两侧求值 + 结果强制 0/1』，实测 5&&3=1（应 3）、0||7=1（应 7）、x=5;x||=9=1（应 5），并破坏短路副作用语义。已修为真短路+值语义（num 用 block(f64)+brIf，零 import；tagged 沿用 emitShortCircuit），test_aot.js 加 and_val/or_val/or_assign/and_assign 四组守门。"
  source: "用户裁决 2026-10-15 + emitter.js 修复"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-15T13:30:21
  kind: decision
  summary: "跨模式调用 ABI 修复：num 值=f64 / tagged 值=i64（数值侧=原始 f64 位型），同模块内跨模式直调（tagged↔num）原不插转换 → 产非法 wasm（call 参数类型不符）实例化即崩。修：fnMode 表 + 三处调用点逐实参按位重解释（f64ReinterpretI64/i64ReinterpretF64），返回后逆转换；按位无损。回归门 test_aot.js runMultiFile 跨模式两向。"
  source: "会话 2026-10-15 修跨模式 ABI bug"
  affects: [aot-wasm-tagged-backend, aot-generic-compiler-target]

- time: 2026-10-15T15:33:54
  kind: decision
  summary: "三处静默语义错误修复：①数组句柄标签 0x7FF8=canonical quiet NaN（宿主 box(NaN) 恰产此位型）→ NaN 返回值被误判为数组→[]；改 0x7FFB。②_fromJS 原仅 number→numToBits、其余 tagHandle → 字符串入参得 0x7FF9 假句柄（非 0x7FFA 写回）→ .length/concat 静默 0；改 _fromJS=bitsOf。③num emitCond 原 x!=0 → NaN 误判 truthy（IEEE NaN≠0=true，JS Boolean(NaN)=false）；改 (x!=0)&&(x==x)。回归门 test_aot.js +7 项，101 ALL PASS。"
  source: "会话 2026-10-15：差分测试发现静默语义偏差"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T00:46:08
  kind: decision
  summary: "AOT 语义精度第二批（差分审计驱动）：①bool 独立 tag 0x7FFC（此前 tagged bool = f64 0/1，与 number 混淆 → 's'+true 得 's1'、typeof true 得 'number'、1==true 得 false）。②null/undefined 区分：null 用固定槽 handles[1]（0x7FF9|1）、undefined handles[0]（0x7FF9|0），此前统一 0x7FF9|0 → typeof null 得 'undefined'。③宽松 ==/!= 走宿主 qz.eq/qz.ne（此前与 === 同走严格 → 1=='1' 得 false）。④**（宿主 qz.math_pow/qz.pow）、??（qz.is_nullish）、~/+（qz.bnot/qz.to_num）。⑤% 精确到 JS Number::remainder（零余数符号随被除数——原 f64Neg 把 2%2 的 +0 翻成 -0；差溢出走宿主 fmod）。⑥+ 拼接 ToPrimitive（区分纯数/串/bool/句柄，双纯数走原生 f64 add 否则宿主）。⑦NaN truthy（num emitCond 从 x!=0 改 (x!=0)&&(x==x)，!x 同源）。守门 test_aot.js 135 ALL PASS。已知限制（loud 非静默）：位运算 NaN/Inf trap、instanceof/in/?./void/delete/**=/??= 未实现、typeof function 报 'object'。"
  source: "会话 2026-10-15：完成aot 目标下的差分审计"
  affects: [aot-wasm-tagged-backend, aot-generic-compiler-target]

- time: 2026-10-16T01:39:28
  kind: decision
  summary: "AOT 差分审计第三批（静默错修复 + 未实现显式报错）：①可选链 o?.x / o?.[i] / o?.length 静默返回 0 → 现 base 求值一次、nullish 短路 undefined（不求 index）。②数组方法默认参数：a0/a1 是 tagged 句柄非 JS undefined，'a0===undefined' 恒假 → join()/concat()/splice(i)/sort() 全错；改判 toJS(a0)。③sort() 无比较器改引擎默认字典序。④.length 返回 UTF-8 字节数应 UTF-16 码元数 → 新增 wasm helper qzs_utf16len。⑤numstr 截断小数（''+0.5 得 '0'）→ 整数走 wasm、小数/NaN/Inf 走宿主 String。⑥闭包写捕获变量值快照语义致外层读不到（静默错值）→ 新增静态检测 _closureWriteConflict，lambda 写+外层访问 → 编译期报错（loud 优于静默错；共享环境待实现）。⑦未实现特性显式报错：静态方法/解构/字段??=/内建全局(Math/JSON/String…)/instanceof/in/**=。守门 test_aot.js 146 ALL PASS。"
  source: "会话 2026-10-15：完成aot 目标下的多轮差分审计"
  affects: [aot-wasm-tagged-backend, aot-generic-compiler-target]

- time: 2026-10-16T02:14:56
  kind: decision
  summary: "AOT 差分审计第四批（通用性补全）：①内建全局支持（Math/String/Number/JSON/Object/Array… 经单一通用宿主入口 qz.builtin(nameId,n,a0..a3)；n=实际参数数避免 Math.max 传 undefined 占位得 NaN；含 Math.PI 等常量）。②解构声明单层支持（const [a,b]=arr / const {x,y}=obj / {a:z} / [,b]；嵌套报错）。③未实现特性显式报错（静态方法 C.m()/展开/内建类 new Map|Set|Date|Error/instanceof/in/**=/字段??=）。守门 test_aot.js 170 ALL PASS。"
  source: "会话 2026-10-15：完成aot 目标下的第四轮审计与补全"
  affects: [aot-wasm-tagged-backend, aot-generic-compiler-target]

- time: 2026-10-16T04:31:10
  kind: decision
  summary: "类静态字段与 for-in/动态键落地"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T05:17:40
  kind: decision
  summary: "差分审计驱动的一轮修复：可重入临时槽/闭包/访问器"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T06:53:37
  kind: decision
  summary: "差分审计第二轮：闭包 tag/容量/访问器/展开/错误语义"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T10:26:24
  kind: decision
  summary: "第三轮差分审计：参数/循环绑定/容器/私有字段等"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T10:42:35
  kind: evidence
  summary: "第五轮差分审计：189/192 一致"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T11:00:01
  kind: evidence
  summary: "第六批语料后：218/221 一致"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T11:11:50
  kind: evidence
  summary: "第七批差分审计：241/248（97.2%），7 项均为已记录限制"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T11:29:46
  kind: evidence
  summary: "第八批差分审计：265/272（97.4%），新增语料 24 例全通过"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T11:44:53
  kind: evidence
  summary: "第九批差分审计：289/297（97.3%）；修复 classMeta 原型污染等 2 个崩溃/静默错值"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T12:17:48
  kind: evidence
  summary: "第十批差分审计：310/321（96.6%）；修复 classMeta 原型污染、.length 静默错值、闭包内省等"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T12:27:18
  kind: evidence
  summary: "插入序跟踪落地：311/321（96.9%），仅剩 1 项静默差异（稀疏数组 holes）"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T12:32:53
  kind: evidence
  summary: "稀疏数组洞修复：313/321（97.5%），残余 8 项全部 loud——差分审计已无静默错值"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T12:46:44
  kind: evidence
  summary: "第十一批：333/345（96.5%），残余 12 项全部 loud——零静默错值"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T13:06:42
  kind: evidence
  summary: "类表达式+私有静态成员落地：336/345（97.4%），残余 9 项全部 loud"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T13:10:41
  kind: evidence
  summary: "String.raw 落地：337/345（97.7%），残余 8 项全部 loud"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T13:32:55
  kind: evidence
  summary: "运行时访问器落地：338/345（98.0%），残余 7 项全部 loud"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T13:48:23
  kind: evidence
  summary: "闭包>4形参落地：353/361（97.8%），残余 8 项全部 loud"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T14:04:02
  kind: evidence
  summary: "私有成员修正：354/361（98.1%），残余 7 项全部 loud"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T14:41:03
  kind: evidence
  summary: "第十三批（370/381）：修字符串+=静默错值、方法 this、delete、句柄身份"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T14:53:08
  kind: evidence
  summary: "提取方法 this + undefined 属性读：370/381（97.1%）"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T15:01:01
  kind: evidence
  summary: "数组迭代器惰性化：371/381（97.4%）"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T15:17:52
  kind: evidence
  summary: "undefined 属性读抛错 + this 形参注解模型：372/381（97.6%），残余 9 项全部 loud"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T15:43:18
  kind: evidence
  summary: "第十四批差分审计（定位）：386/398（97.0%），3 项新发现的静默差异已记录待修"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T15:58:12
  kind: evidence
  summary: "第14批 3 项静默差异全修：389/398（97.7%），残余 9 项全部 loud（零静默错值）"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T16:25:58
  kind: evidence
  summary: "第十五批：408/418（97.1%），残余 10 项全 loud（零静默错值）"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T16:55:09
  kind: evidence
  summary: "用户标签模板 strings.raw：409/418（97.8%），残余 9 项全 loud（零静默错值）"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T17:07:33
  kind: evidence
  summary: "第十六批：428/437（97.9%），残余 9 项全 loud（零静默错值）"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T17:16:05
  kind: evidence
  summary: "第十七批：445/455（97.8%），残余 10 项全 loud（零静默错值）"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T17:21:38
  kind: evidence
  summary: "this 形参作用域标记修复：_lamThisParam 按函数复位"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T17:35:58
  kind: evidence
  summary: "第十八批：463/474（97.7%），模块级变量/ catch 解构/ 求值顺序修复，残余 11 项全 loud"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T17:40:35
  kind: evidence
  summary: "第十八批补充：464/474（97.9%），计算属性类字段与 (C as any).st 支持"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T18:00:29
  kind: evidence
  summary: "类表达式别名修复 + receiver 通道重构方案落档（464/474）"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T18:05:20
  kind: evidence
  summary: "receiver 通道完成：466/474（98.3%），fn-call-apply-bind / callback-this-binding / this-arrow-vs-fn / closure-captures-this-method 转为一致"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T18:09:56
  kind: evidence
  summary: "第十九批语料：485/493（98.4%），函数标签模板与 new (C as any) 修复"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T18:19:19
  kind: evidence
  summary: "第二十批语料：501/512（97.9%）；修复 TS 参数属性（静默 undefined）与 for-of 迭代协议"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T18:24:16
  kind: evidence
  summary: "Symbol 元素访问/物化修复：502/512（98.0%）"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T18:31:09
  kind: evidence
  summary: "静态成员三修：静态私有写 / 静态 this≡定义类 / 派生类覆写 loud（503/512）"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T18:47:34
  kind: evidence
  summary: "第二十一批：520/530（98.1%）；修 4 处（一元负 ToNumber、finally 范围、类字段箭头 this、hasOwnProperty）+ 记录 2 项架构级静默"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T18:57:50
  kind: evidence
  summary: "宿主数组句柄统一：JSON.parse 数组写丢失修复（521/530）"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T19:19:08
  kind: evidence
  summary: "类方法 >4 形参与 rest 形参打通（局部布局 bug 修复）"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T19:26:20
  kind: evidence
  summary: "方法 >4 形参 / rest 形参 完整支持（探针 4/4，残余 loud 8→7）"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T19:29:49
  kind: evidence
  summary: "Object.assign/展开键序根因定位：start 段 mem 未绑定，键序登记不可用"
  affects: [aot-wasm-tagged-backend]

- time: 2026-10-16T19:36:57
  kind: evidence
  summary: "键序类问题闭环：Object.assign 登记键序 + order_note（start 段可用）→ 零已知静默（522/530）"
  affects: [aot-wasm-tagged-backend]
