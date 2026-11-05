---
id: aot-host-builtin-carrier
title: "AOT 内建类宿主承载：construct/call 分道 + 0x7FFD + require-new"
category: decision
status: active
tags: [aot, builtin, quickjs]
created: "2026-11-04T10:27:39"
updated: "2026-11-04T11:21:42"
---

<!-- compiled_truth -->
## 结论

内建类（Map/Set/Date/RegExp/Error 族/Array/…）在 AOT 两档都由**宿主对象承载**（tag 0x7FFD），且 `construct` 与 `call` 在 import 面上**必须可分**——这是 ES 规范（require-object-constructor）落地的前提，不是风格选择。

## 硬约束

- **`new 内建类` 走独立原语 `qz.new_builtin(nameId, n, a0..a3, ovf)`**（不是 `qz.builtin`）。理由两条：① `Map()` 与 `new Map()` 在 `qz.builtin(name, args.length, …)` 形状上完全相同，两档无从区分，而规范里 Map/Set/WeakMap/WeakSet/Proxy **无 [[Call]]**，普通调用必须 TypeError；② construct 语义需要 `n`（见下条）。
- **`qz.builtin` 里 BUILTIN_REQUIRE_NEW 名字一律抛 TypeError，不按实参形状猜测调用形态**。错误必须两档同形：真 TypeError **对象**（有 name/message/原型链，`catch(e)` 后 `e.message`、`e instanceof TypeError` 才可用），文案对齐 oracle(V8) `Constructor X requires 'new'`（裸字符串抛射会让 C 档与宿主档、与真 JS 三方都不同）。
- **普通调用严格按该内建自己的 `[[Call]]` 语义，不得为「两档一致」归一化成 construct**：`Date(x)` 产**字符串**（不是 Date 对象），`Error`/`TypeError`/`RegExp`/`Array`/TypedArray 的 `[[Call]]` 本就等价 construct。C 档 `JS_Call(fn, undefined, …)`、宿主档 `fn.apply(null, args)`——两侧都是「照规范调」。曾一度把构造器名单内的名字连普通调用也 construct（理由是「与 V8 的 `Date()` 偏差保持一致比规范重要」），该结论已被推翻：与 oracle(V8) 的差异恰恰是偏差源，归一化会让 `typeof Date(0)` 静默错。
- **`n` 是必须的**：4 槽 ABI 的未用槽位也是 undefined 句柄，与「显式传入 undefined」不可分。语义依赖实参个数的内建（`new Array(undefined)` → length 1 vs `new Array()` → 0；`new Date(undefined)` → Invalid Date vs `new Date()` → now）只能按 n 判定。C 档 `qz_collect_args` 会**丢弃 undefined 槽**（压缩），所以任何走它的新路径都会把显式 undefined 变成「未提供」——`new_builtin` 因此自己按 n 逐槽取舍，不经 `qz_collect_args`。
- **无 n 的动态路径（`builtin_fn` + `new_dynamic`，即别名 new：`const C = Map; new C()`）只能近似**：丢弃 undefined 句柄槽位。显式 undefined 实参与缺省实参在该路径不可分（已登记偏差，c44 `host-array-undef-slot` 用 n 路径已修，动态路径仍是 0）。
- **内建构造结果登记为 0x7FFD 宿主对象句柄**（C 档 `qz_host_obj_handle` **取所有权**，调用方不得再 free；JS 档 `tagHandle`）：方法调用（`method_call`/`method_spread`）、属性读写、`instanceof` 全走真 JS 对象路径，不走 POJO 内存解释。`builtin_value`/`builtin_member`/`builtin_fn` 同标，否则别名 new 与内建作值在两档分叉。
- **`instanceof 内建类` 走 ES OrdinaryHasInstance**：`Symbol.hasInstance` 是 **symbol 值、不可调**（旧 C 实现当函数 `JS_Call` → 恒 0 的静默错判）。quickjs-ng 公开头没有 `JS_ATOM_Symbol_hasInstance`/`JS_GetPrototypeOfVal`/`JS_StrictEqual`，故：symbol 值经 `JS_ValueToAtom` 转内部 atom 再 `JS_GetProperty`；原型链回退用 `JS_Call(Object.getPrototypeOf, …)` + `JS_IsSameValue`。nan-boxing（wasm32 构建带 JS_NAN_BOXING）下取 tag 必须用 `JS_VALUE_GET_NORM_TAG`，`JS_VALUE_GET_TAG` 对 NaN 位型给错值。
- **构造/查找失败一律 loud 且可捕获**：C 档经 `qz_set_throw` → 产物 `take_err` → `__err` → `_emitErrCheck` 转入本函数 catch；宿主档 `throwValue(e)` 同效。`builtin_fn` 对非函数（如 `Math.PI`）必须抛，不得静默 undefined 句柄。

## 已推迟（独立工程项）：内建子类承载

`class M extends Map` 的**静态**形式两档都静默（实例是空壳、`m.set` 无声失败），因为静态 `new UserClass()` 由产物内联 bump 分配（`i32Store` + global bump），**不经任何宿主原语** → 宿主镜像无处挂钩。补齐需要：classMeta 携带 `builtinParent` 为 strId（现 C 档只有 JS 档 meta 有该字段）、实例承载改为宿主对象 + 方法蹦床回指 wasm。当前处置：C 档**动态** extends 宿主基类（`class_value_dyn`）loud；`cls-sub-map`/`cls-sub-array` 在 c44 登记 unsupported。见 [[aot-cross-tier-semantics]]。


## Timeline

- time: 2026-11-04T10:27:39
  kind: decision
  summary: "Created this page: AOT 内建类宿主承载：construct/call 分道 + 0x7FFD + require-new"
  source: "c44 内建宿主承载批次"
  affects: [aot-host-builtin-carrier]

- time: 2026-11-04T10:27:39
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "src/qzvm/aot/{emit/consts.js,emit/tagged.js,qzvm.js} + src/qzvm/guest_entry.c"
  affects: [aot-host-builtin-carrier]

- time: 2026-11-04T11:21:33
  kind: decision
  summary: "补充：普通调用严格按各内建自己的 [[Call]] 语义（Date→字符串，Error/RegExp/Array→等价 construct），禁止为跨档一致而归一化"
  source: "本轮 c44 内建宿主承载批次 + oracle 对照"
  affects: [aot-host-builtin-carrier]

- time: 2026-11-04T11:21:42
  kind: reversal
  summary: "推翻中间结论「构造器名单内连普通调用也 construct，两档一致优先于 V8 的 Date() 返回字符串偏差」：改回各内建自身 [[Call]] 语义（Date(x)→字符串），new 形态改由发射端走独立原语 qz.new_builtin(nameId,n,…)；C 档死代码 qz_is_builtin_ctor_name 删除"
  source: "src/qzvm/{guest_entry.c,aot/qzvm.js,aot/emit/tagged.js} + c44 host-date-plain-call / host-array-undef-slot"
  affects: [aot-host-builtin-carrier, aot-cross-tier-semantics]
