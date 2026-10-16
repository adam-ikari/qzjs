---
id: aot-wasm-tagged-backend
title: "AOT tagged 后端（emitter.js→wasm）：热路径零宿主跨界原则"
category: decision
status: active
tags: [aot, wasm, emitter, qzvm, perf]
created: "2026-10-12T15:51:52"
updated: "2026-10-16T11:11:50"
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
