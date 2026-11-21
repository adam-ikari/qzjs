---
id: aot-host-builtin-carrier
title: "AOT 内建类宿主承载：construct/call 分道 + 0x7FFD + require-new"
category: decision
status: active
tags: [aot, builtin, quickjs]
created: "2026-11-04T10:27:39"
updated: "2026-11-09T19:00:15"
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

- time: 2026-11-09T08:18:14
  kind: decision
  summary: "内建子类承载（JS 档）：class extends 内建（Map/Set/Date/RegExp/Error，合成 ctor + 无自有字段）→ 宿主真内建实例。新原语 qz.new_builtin_sub(clsId,parentNameId,n,a0..a3,ovf)：Reflect.construct(Bp,args,classObjImpl(clsId)) 作 newTarget → proto 链含类 prototype（instanceof 双路天然成立）。method_call isHostH 分支加类方法派发：沿 obj 原型链查 constructor.__qzClsId → classMeta 方法链 → 命中调 wasm 蹦床（self=宿主句柄），否则落真 JS 方法（继承的内建方法）。buildInstance 同改（动态路径）。classMeta 加 hostBacked 标志。emit: _emitNewCall 静态路径 hostBacked 走 new_builtin_sub，否则回落 bump 近似（Error 族 message/name 写回，既有行为）。排除 Array（ret 把数组转 wasm 0x7FFB 句柄丢类 identity）。test_aot runTagged 内建子类.* 三项（Map/Set/Date）钉住。C 档留账：clsmeta 二进制定长不传 hostBacked，需序列化扩展 + new_builtin_sub/method_call 宿主派发/buildInstance 平行实现。"
  source: "emitter.js collectClasses(hostBacked) / tagged.js _emitNewCall / qzvm.js new_builtin_sub+method_call+buildInstance / consts.js"
  affects: [aot-host-builtin-carrier, aot-roadmap]

- time: 2026-11-09T14:00:38
  kind: decision
  summary: "Array 子类承载（JS 档）：去除 hostBacked 的 bpName!=='Array' 排除 → class extends Array（合成 ctor + 无自有字段）走宿主承载。关键：new_builtin_sub/buildInstance 对 Reflect.construct 结果为数组时用 tagHandle（0x7FFD 宿主句柄）而非 ret（ret 的 Array.isArray 分支会 arrWriteback 扁平为 0x7FFB 丢类 prototype）。宿主句柄保留真 Array + A.prototype → instanceof A/Array 双路（0x7FFD 走 o0 instanceof cP）、继承方法原生（push/map…经 isHostH→真数组方法）、自有方法走 wasm（classMeta）、索引/length/for-of 经 get_index/prop_get/宿主迭代。既有 wasm 数组（0x7FFB）不受影响；普通 new Array() 走 new_builtin 仍 0x7FFB。test_aot 加内建子类.Array 四项（继承+自有+for-of+instanceof）。"
  source: "emitter.js collectClasses(hostBacked) / qzvm.js new_builtin_sub+buildInstance"
  affects: [aot-host-builtin-carrier, aot-roadmap]

- time: 2026-11-09T14:43:47
  kind: decision
  summary: "内建子类承载扩展（JS 档）：允许自有实例字段（hostBacked 放宽为 !!bpName && !ctor，仍要求合成 ctor）。带字段时：① new_builtin_sub/Reflect.construct 完成基类构造（真 Map/Set/Date/Array/Error + 类 prototype）② 其后调用合成 ctor 只补本类字段默认值——_emitSuperCallForward 对 hostBacked 跳过 super（基类已造）、直接 _emitFieldDefaults；_emitFieldDefaults 对 hostBacked 走 qz.object_set（字段存宿主属性，绝不 i64Store 到 0x7FFD 句柄索引越界写内存）③ 方法内 this.x 读写经 _emitPropReadFromLocal/_emitStorePropValue 运行期派发（0x7FFD→prop_get/object_set）天然正确 ④ class_env_get 补 HOST_HI（经实例 constructor.__qzClsId 取类 env），字段初值捕获外层变量可用。buildInstance 同步（动态路径 Reflect.construct 后调 ctor 补字段）。验证：test_aot 内建子类.* 六项（Map/Array 带字段 this 引用+写+捕获）；全 46 corpus 差分审计 0 diff；glue 5/5。同时清理 corpus44 两处陈旧 unsupported 标记（builtin-subclass-array/map 已实现）。"
  source: "emitter.js hostBacked+_emitFieldDefaults / tagged.js _emitSuperCallForward+_emitNewCall / qzvm.js buildInstance+class_env_get"
  affects: [aot-host-builtin-carrier, aot-roadmap]

- time: 2026-11-09T15:17:29
  kind: decision
  summary: "内建子类承载（C 档 / in-module）结案：免改 clsmeta 二进制格式——new_builtin_sub 的 clsId/parentNameId 全由 emitter 实参传入，字段初值由 emitter 随后调 __m_<C> ctor 完成（qz.object_set 写宿主属性）。guest_entry.c 增：① qz_guest_new_builtin_sub(clsId,parentNameId,n,a0..a3,ovf)：JS_CallConstructor(内建) 造真实例 + JS_SetPropertyStr(__qzClsId, clsId) 标记，返 0x7FFD 宿主句柄（proto=内建原型，继承方法原生可用）② method_call 宿主对象（0x7FFD）分支：读 __qzClsId → qz_clsmeta_method_chain → 蹦床；未命中落原生内建方法 ③ instanceof_op/instanceof_dyn 宿主（0x7FFD）分支：__qzClsId → classMeta.parent 链比对 ④ prop_get 宿主实例 .constructor 按 __qzClsId 回 class_value（否则原生取到 Map/Array）。验证：新 test/m6b-poc/e2e_bsub.mjs（Map/Array/Error：继承方法 get/set/push/索引/length + 自有方法 + 字段默认值 + instanceof 双路 + .constructor）4 项 PASS；libqzvm 增量构建（cmake --build build-inmod --target qzvm-guest）；全部 m6b e2e 无回归。"
  source: "src/qzvm/guest_entry.c new_builtin_sub+method_call+instanceof_op/dyn+prop_get / test/m6b-poc/e2e_bsub.mjs"
  affects: [aot-host-builtin-carrier, aot-roadmap]

- time: 2026-11-09T16:03:31
  kind: note
  summary: "显式 ctor 内建子类不能宿主承载（两档）：尝试把 hostBacked 放宽到「首句 super 原样转发形参」的显式 ctor，echte 但引入回归——class E1 extends Error { constructor(m){super(m); this.name=\"E1\"} } 一旦 hostBacked，则用户子类 class E2 extends E1（E2 的 builtinParentName=null → 走 bump）在 E2 的 bump 路径调 E1 ctor(self=E2 的 wasm POJO) 时，E1 的 hostBacked ctor 假定基类已由 new_builtin_sub 构造 → 真实 Error 基类缺失（message undefined、instanceof 失败）。audit_corpus31 error-handling-matrix / corpus38 error-cause-chain 立即抓出。结论：hostBacked 必须维持 !ctor——宿主承载类一旦被用户子类继承（bump 调其 ctor）即失效；要安全放宽需二次扫描「该类有无用户子类」（跨文件不可靠）。显式 ctor 内建子类保持 bump 近似（Error 族写 message/name，其余 loud）。"
  source: "src/qzvm/aot/emit/{emitter.js,tagged.js}, audit_corpus31/38"
  affects: [aot-host-builtin-carrier, aot-roadmap]

- time: 2026-11-09T18:07:10
  kind: decision
  summary: "内建子类 super.method()（两档）：放行 class M extends Map { m(){ super.set(...) } }——父链走到内建父类时发 qz.super_method(self, mid, args)（此前 loud 拒绝）。关键正确性：类 ObjImpl 把实例方法装到 prototype（JS 语义），super_method 直接用 Object.getPrototypeOf(o) 会命中本类覆写 → 覆盖+super 递归；改为 classObjImpl 用 WeakMap protoCls 记录用户类 proto，super_method 沿原型链跳过 protoCls.has(sp) 的 proto → 落到内建原型方法（past 本类 wasm 覆写）。用 WeakMap 而非属性标记：后者出现在 Object.getOwnPropertyNames(C.prototype) → audit_corpus30/34/35 回归（getter-setter-pairs/class-accessor-inherit/class-instance-delete），WeakMap 无痕。仅 hostBacked（根内建子类）放行；用户类 N extends O extends Map 的病理混合（N bump 调 O host 方法）仍属既知不兼容。JS: protoCls WeakMap + super_method 跳过；C: super_method 对宿主对象走 JS_GetPrototype（实例 proto=内建原型，本就正确，无需改）。验证：test_aot 两项（super.set/get + 覆盖后越过覆写）；e2e_bsub 两项；corpus30/34/35 恢复 0 diff；全 46 corpus 0 diff；全 e2e 绿。"
  source: "src/qzvm/aot/{emit/tagged.js,qzvm.js}, test_aot.js, test/m6b-poc/e2e_bsub.mjs"
  affects: [aot-host-builtin-carrier, aot-roadmap]

- time: 2026-11-09T18:34:39
  kind: evidence
  summary: "加固发现并修复：内建子类带静态字段（class S extends Map { static n = 0 }）编译崩溃——静态字段继承链遍历 for (x=cn; x; x=classes.get(x).parent) 把内建父类（Map）也当用户类，classes.get('Map')=undefined → 读 .parent 崩（tagged.js:1024）。修：链遍历条件加 this.classes.has(x)（内建父处停，静态字段只沿用户类链查）。回归：test_aot「内建子类.静态字段+for-of 条目」=2:1:1、e2e_bsub smTest=2。全 46 corpus 0 diff（静态字段继承未回归）。"
  source: "src/qzvm/aot/emit/tagged.js:1024, test_aot.js, test/m6b-poc/e2e_bsub.mjs"
  affects: [aot-host-builtin-carrier]

- time: 2026-11-09T19:00:15
  kind: evidence
  summary: "加固发现并修复：class A extends Array { twice(){ return this.map(x=>x*2) } } 结果 length=0/join 空（引擎 Array.prototype.map 的 species new A(len)）——classObjImpl 的 ctor 返回 tagged BigInt，JS new 视原始值丢弃 → 得到带 A.prototype 的 plain object 而非真数组。修：ctor 对各 buildInstance 返回的宿主句柄（HOST_HI 0x7FFD）返回 handles[idx] 真对象；非宿主（0x7FFE POJO 等）原样返 BigInt。修后 map 结果为可用真数组（length/索引/join/instanceof Array 全对）。残留（更深，已登记）：ret 对数组一律扁平成 0x7FFB → map/filter/slice 等返回的子类实例丢 A 身份（instanceof A false）。验证：test_aot「内建子类.Array map（species 结果可用）」=2:2:4:true:2,4；全 46 corpus 0 diff（ctor 改动无回归）。"
  source: src/qzvm/aot/qzvm.js classObjImpl.ctor
  affects: [aot-host-builtin-carrier]
