---
id: aot-cross-tier-semantics
title: "AOT 跨档语义一致性：闭包/数组/动态类的两档对齐"
category: decision
status: active
created: "2026-10-19T18:41:21"
updated: "2026-10-31T18:37:22"
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
