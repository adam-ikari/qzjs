---
id: aot-cross-tier-semantics
title: "AOT 跨档语义一致性：闭包/数组/动态类的两档对齐"
category: decision
status: active
created: "2026-10-19T18:41:21"
updated: "2026-11-04T10:27:49"
---

<!-- compiled_truth -->
## 结论

AOT 两档（in-module = C 侧 libqzvm；独立档 = JS 宿主 qzvm.js）必须**语义等价**，差异只允许在「实现载体」。判据是 `audit_corpus*.js` 的 wasm-vs-js 输出对比：**任何 diff 都是缺陷**，除非是 loud 报错（显式抛错）。静默错值不可接受。

## 本轮修的静默错值类别

1. **闭包值（0x7FFF）不是 JS 对象** → 属性读写 / `new` / `instanceof` 全失效。C 侧曾让 `qz_tojs(0x7FFF)` 返回 undefined，`ctor.prototype.m = f` 于是静默写坏线性内存。
2. **数组句柄（0x7FFB）在 C 侧 `qz_tojs` 无映射** → `a.join()` / `indexOf` 收到 undefined 实参，内建静默返回 +0。

## 硬约束（推导得出，非风格选择）

- **C 侧不能把 wasm 闭包物化成 JS 函数**。QuickJS 在 wasm 内运行，JS 回调再进 wasm 蹦床会 "null function or function signature mismatch"（栈/表上下文破坏）。闭包调用统一走 `closure_call` 的 `call_indirect`。
- 数组高阶方法（map/filter/reduce/find/some/every/forEach/findIndex）在 C 侧**必须自己遍历**，回调经 `closure_call` 派发，实参与结果全程 tagged。交给 JS 内建 = 静默错值。
- 数组原地变异（reverse/sort/splice/push/pop/shift/unshift/fill/copyWithin）改的是 JS 侧副本 → **必须写回 wasm 内存**。独立档靠 `arrOf` WeakMap 保持别名；C 侧靠「句柄 → JS 数组」缓存 + 写回。
- 声明式类的动态 extends 用 `class_value_dyn` **就地**改写 `classMeta.parent`：紧随其后的 `super()` 按 clsId 查父构造器，返回克隆 id 会查不到。工厂式类表达式（`class_expr_value`）相反——每次求值必须克隆出新 clsId，否则 `new A() instanceof B` 误判。
- emitter 给部分方法名加 in-module 特化后缀（`"reduce$i"`）。C 侧 strcmp 前必须按 `$` 截断，否则整段回调路径被跳过。
- **静态成员捕获的 env 必须用 `class_env_get_static` 读取**：静态方法/getter/setter 的 self 是**类值**（宿主档 ctor 句柄带 `__qzClsId`；C 档 `0x7FFE|clsId`，低 32 位即 clsId、无实例内存），不能复用按实例内存首 4 字节取 clsId 的 `class_env_get`。宿主档把静态访问器装到类对象上（`const C = mk(); C.g` / `C.g = v` 可动态读写）；C 档动态类值成员访问未实现 → `qz_dyncls_loud` 统一抛 TypeError（只拦 `g_dyncls[]` 里的克隆 id，静态类值的静态发射路径不受影响）。
- **`super.v` 走原型语义**：数据字段只存在实例上、不在原型链 → 读为 undefined；父 getter 照常调用；父方法作值 loud。动态父（运行期解析的 `class extends B`）的 `super.v` 读/写 loud，`super.m()` 走 `super_method_dyn` 按 home 的运行时父链派发。
- **静态字段的「类键」按档取**（`_staticClassKey`）：C 档键 = clsId（与 `static_get_dyn`/classMeta 同空间），独立档键 = 类名 strId。静态读写、`statics_ready`/`statics_mark`/`statics_has` 必须统一经该 helper；混用（如用 strId 写、clsId 读）在 strId≠clsId 时静默读 0。
- **静态方法/访问器内 `this` = 运行期接收者类**：`B.getX()` 调继承自 A 的静态方法时 `this === B`。读 `this.x` 沿运行期父链（C 档 classMeta parent 链 / 宿主 ctor `__proto__` 链）；写 `this.x` 写**接收者自有**静态（`static_set_dyn`），不是定义类；`this.x++/--`、复合赋值同理；私有静态 `this.#n` 的键 = `#定义类#名`（词法归属，不走接收者类）。惰性静态守卫必须覆盖接收者的整条父链（`_emitStaticsChainGuard`），只初始化接收者自身会让父链字段读到 undefined。
- **void 方法没有 wasm 返回值**：直调点与类方法蹦床都按**登记签名**判定（`wasm-encoder.funcResults`），不得按名字猜（`$ctor/$set` 规则漏掉 `: void` 静态/实例方法 → 调用点 `local.set` 栈失衡、产物校验失败）。C 侧蹦床 ABI 恒为 `(self,a0..a3) → i64`，被调 void 时补 undefined 占位。
- **类表达式/嵌套 class 声明的静态字段/静态块**：静态表按类名共享且只初始化一次，无法重放「每次求值重建静态状态」的 JS 语义 → 仅模块顶层 `const/let C = class {…}`（求值一次、类名稳定）受支持，其余编译期 loud 并给出改法。


- **未声明标识符读一律经 `qz.ref_get`（strId）运行期查全局**：globalThis 有 → 宿主句柄；无 → ReferenceError（loud、可 catch）。发射期静默 undefined 兜底已废除（违「静默错值 > loud」裁决）；唯一例外是 `typeof x` 规范特例——未声明标识符仍编译期常量 "undefined"。该原语三处必须同步：consts.js QZ 签名表 + 两档宿主面（qzvm.js `ref_get` / guest_entry.c `qz_guest_ref_get`），且每个调用点后紧跟 `_emitErrCheck`。
- **方法/构造器形参默认值与解构形参的 prologue 只在 `_mEnter` 内发射一次**，位置在 capMap/env 就绪之后、env 种子写入之前（与 emitFunc 同序）。提前发射（capMap 空）会让默认式中的捕获名落 ref_get 误抛 ReferenceError；发射两次则默认式重复执行、且 env 种子停留在形参原始值（被捕获的默认值进不了 env）。c44 即此双发射回归。
- **提取的类方法 strict this 语义**：类体恒 strict，`C.prototype.m` 读出的 HOST_HI wrapper 以调用点 thisArg 为 `this`，undefined/null **不**回填原实例——`c.m.call(null)` 抛 TypeError（与 V8 一致）；`method_call` 的 POJO/实例字段派发同时接受 HOST_HI 可调用体。
- **跨函数 throw 取回优先 `__take_err()`**：i64 **返回值**经 qzjs 的 WAMR 绑定是 BigInt（精确）；读 `__err` 全局则经 JS_NewInt64 落 Number，>2^53 的 tagged 句柄被舍成垃圾。旧产物无该导出时才退回全局读取。
- **P4 装配路径结案**：build.js 实参补齐 + take_err 后，glue_audit 与 compileTS 直连档对齐；剩余 9 条差异（c2/c3/c7/c11/c20/c22/c28/c29/c33 各 1 条）全是**宿主引擎差异**——oracle=V8(node) vs 生产档=qzjs(quickjs-ng)：Math.cbrt 精度（4 条）、Intl 千分位/排序 collation（c2/c11）、非严格弱序 comparator 下 sort 实现细节（c22/c29）、WAMR/qzjs 栈深度（c7）。非编译器/glue 缺陷。glue_audit 基线对导出函数须**裸调用**（`g(...args)`）——`exp[fn](...)` 会把 exports 泄进顶层函数的 this。


## Timeline

- time: 2026-10-19T18:41:21
  kind: decision
  summary: "Created this page: AOT 跨档语义一致性：闭包/数组/动态类的两档对齐"
  source: created via brain create-page
  affects: [aot-cross-tier-semantics]

- time: 2026-10-19T18:41:58
  kind: decision
  summary: "两档语义必须等价；闭包不可物化、数组方法 C 侧自派发并写回、动态类父链就地改写"
  source: brain update-truth
  affects: [aot-cross-tier-semantics]

- time: 2026-10-19T23:27:44
  kind: note
  summary: "已知静默错值缺口：类表达式的类方法捕获外层**局部**变量（get label(){return lab}）两档都返回 undefined——类 env 建立时机依赖 statics guard/class_value，局部变量捕获未覆盖。改动前后一致，非本轮回归。loud 化需重构 statics 键。"
  affects: [aot-cross-tier-semantics]

- time: 2026-10-20T12:56:07
  kind: decision
  summary: "差分审计引入 unsupported 登记：corpus 条目标 unsupported 后，AOT 必须 loud 报错才算通过（静默错值仍判失败，已用返回 42 的桩验证）。当前登记 3 项固有未实现：generator-function（yield→状态机）、async-function（需 Promise/微任务）、object-fromentries-iter（generator 参与迭代）。AOT 侧无协程/微任务基础设施，属 P2 级工程，不在当前路线。"
  source: "src/qzvm/aot/audit_diff.js:52-57 + audit_corpus7/38 标注"
  affects: [aot-cross-tier-semantics]

- time: 2026-10-21T01:45:51
  kind: note
  summary: "补齐 C 侧可捕获异常通道：新增 qz.take_err（C 侧 g_throw_val 槽 → handle 表 → 产物 __err）。reduce 空数组无初值、冻结对象写入改抛真 TypeError（此前静默返回 undefined），emitter _emitErrCheck 在 in-module 档先轮询 take_err（仅 __err==0 时，避免覆盖用户 throw）。已验：a.reduce(fn) 空数组、throw new TypeError 均被 catch 捕获且 name/message 正确；两档回归 13 项全 PASS。遗留：POJO（wasm 内存布局对象）在 C 侧 qz_tojs 无映射 → Object.keys(freeze 对象) 返回空、冻结写入对 POJO 无效，属既有架构边界，非本轮引入。"
  affects: [aot-cross-tier-semantics]

- time: 2026-10-31T16:59:15
  kind: reversal
  summary: "推翻 2026-10-19 note：类表达式捕获外层局部变量的静默 undefined 缺口已消除。工厂返回的 class 表达式每次求值经 class_expr_value 克隆类元并各建一份 env（class_env_get 按实例 clsId 取），字段初值/方法/构造器共享该 env；方法自有同名局部/形参遮蔽时建子 env（类 env 作 __parent），种子写入用 env_def 落本层，写回不污染共享类 env。剩余形状改为编译期 loud 并给出改法：函数/块内 class 声明（提升到模块级）、const C = class 别名（类值不物化）、静态字段初值/静态块引用非模块级局部（首次静态访问才执行）。附带修 _collectLocals/_collectScopeFnDecls 下探进类体/对象方法体致外层参数槽被同名 let 顶掉（静默读 0）、_capturesOf 类型注解误捕获与嵌套作用域缺失。验证：test_aot ALL PASS、audit_diff 43 批 949/949、glue_audit c43 20/20、stress 3 轮 2847 例 0 diff（峰值 rss 453MiB）、zod 125/125 wasm 5945/21111 基线不变。"
  source: "src/qzvm/aot/audit_corpus43.js + emit/emitter.js collectClasses/_mEnter + emit/compile-ts.js declaredNames"
  affects: [aot-cross-tier-semantics]

- time: 2026-10-31T18:37:17
  kind: decision
  summary: "追加两条硬约束：静态成员捕获 env 必须走 class_env_get_static（self=类值）；super.v 走原型语义 + 动态父 super.m 经 super_method_dyn"
  source: "src/qzvm/aot/audit_corpus44.js + emit/emitter.js/emit/tagged.js + qzvm.js/guest_entry.c"
  affects: [aot-cross-tier-semantics]

- time: 2026-10-31T18:37:22
  kind: decision
  summary: "P4 第 44 批收敛：① 静态方法/getter/setter 捕获工厂局部——self 是类值，env 改由新原语 class_env_get_static 读取（宿主 __qzClsId / C 档类值低 32 位）；_inStaticMethod 须在 _mEnter 前置位/复位；clsMetaBuild 补 staticGetters/staticSetters，宿主档 defineProperty 装到类对象，C.g / C.g=v 动态读写与 JS 一致。② C 档动态类值（class_expr_value 克隆）成员访问统一 loud（qz_dyncls_loud，仅 g_dyncls 克隆 id；静态类值不变）——低 32 位是 clsId 不是实例 offset，此前静默读垃圾。③ super.v 改原型语义（数据字段 undefined，父方法作值 loud），动态父 super.m 新增 super_method_dyn 两档按运行时父链派发。④ 箭头继承 arguments（外层函数把实参数组种进 env）；对象字面量方法/访问器/函数表达式合成闭包沿用原始形参节点（默认值/解构/rest 不再丢）。已知缺口仅剩类表达式静态字段/静态块（不初始化、动态读 NaN）与 const K = class 别名（编译期 loud）。验证：test_aot ALL PASS、audit_diff c44 41/41、glue_audit c44 41/41（C 档 9 例 loud 全按预期报错）、in-module e2e 14 套全 PASS、stress_aot 44 批 990 例 2 轮 1980 例 0 diff（429s，峰值 rss 497MiB）。"
  source: "src/qzvm/aot/audit_corpus44.js + emit/emitter.js _synthArrowWithParams/_inStaticMethod + emit/tagged.js super/arguments + qzvm.js/guest_entry.c class_env_get_static/super_method_dyn/qz_dyncls_loud"
  affects: [aot-cross-tier-semantics]

- time: 2026-10-31T20:08:31
  kind: decision
  summary: "追加静态字段类键/静态 this 接收者/void 方法签名/类表达式静态 loud 四条硬约束"
  source: "src/qzvm/aot/audit_corpus45.js + emit/tagged-core.js _staticClassKey + emit/tagged.js static this + wasm-encoder funcResults"
  affects: [aot-cross-tier-semantics]

- time: 2026-10-31T20:15:45
  kind: decision
  summary: "P4 第 45 批：静态字段类键按档统一（_staticClassKey：C=clsId / 宿主=类名strId），静态方法/访问器内 this=运行期接收者类（读沿父链、写接收者自有 static_set_dyn、私有静态#定义类#名、守卫整条父链），void 方法调用点/蹦床按登记签名（funcResults）补 undefined，类表达式/嵌套类静态 loud（仅模块顶层 const C=class 支持）。验证：test_aot ALL PASS；audit_diff 45 批 1014 例全量 0 diff（c45 23/23）；glue_audit c41–c45 全绿；in-module e2e 14 套+concat 全 PASS；stress_aot 45 批 1014 例 2 轮 2028 例 0 diff（445s，峰值 rss 499MiB）。附带发现：全量 glue_audit 扫 c1–c40 暴露既有 glue 装配路径差异（HEAD 抽样一致，非本批回归），留作后续 P4 目标。"
  source: "src/qzvm/aot/audit_corpus45.js + emit/tagged-core.js/emit/tagged.js + wasm-encoder.js funcResults + e2e_statics"
  affects: [aot-cross-tier-semantics]

- time: 2026-11-03T11:50:47
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "P4 glue 装配对齐批次（c14/c28/c44 修复 + 环境差分类）"
  affects: [aot-cross-tier-semantics]

- time: 2026-11-03T11:50:53
  kind: note
  summary: "旧注（2026-10-19）的类表达式方法捕获外层局部静默 undefined 缺口已变编译期 loud（[tagged] const K = class 捕获外层局部…），仍未实现、未登记 unsupported；c44 修复的是声明期默认值捕获（工厂/类 env 路径），两者不同机制"
  source: "/tmp/labelgap 探针 + emitter 报错文案"
  affects: [aot-cross-tier-semantics]

- time: 2026-11-04T08:52:02
  kind: decision
  summary: "glue_audit 引入 envdiff 登记机制：V8-oracle 与 qzjs/quickjs-ng 生产档的实现相关差（Math.cbrt 精度、Intl 缺失、矛盾 comparator 的 sort 细节、栈容量）仅逐条登记后按 ENV 通过（容量类允许产物抛/基线出值），构建 error 仍 FAIL——登记面=已裁决面，不掩盖装配回归；不引入引擎 polyfill（会破坏 C 档对齐）。c44 补登 cls-alias 方法体/访问器捕获模块顶层局部（编译期 loud，现已入门禁）"
  source: "src/qzvm/aot/glue_audit.js + audit_corpus2/3/7/11/20/22/28/29/33/44"
  affects: [aot-cross-tier-semantics]

- time: 2026-11-04T10:27:49
  kind: decision
  summary: "内建类两档对齐结案：new 走独立原语 qz.new_builtin(nameId,n,a0..a3,ovf)（construct 与 call 在 ABI 上必须可分 + 需要 n），构造结果两档统一 0x7FFD 宿主承载，Map/Set/WeakMap/WeakSet/Proxy 普通调用两档一律可捕获 TypeError（文案对齐 V8）。详见 [[aot-host-builtin-carrier]]。"
  source: "c44 内建宿主承载批次"
  affects: [aot-cross-tier-semantics, aot-host-builtin-carrier]
