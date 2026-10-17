# Changelog

All notable changes to qzjs.

## [Unreleased]
- 
### `reduce`/`reduceRight` 显式 `undefined` 初值（2026-10-17）
- 症状：`[].reduce((a,b)=>a+b, undefined)` → 抛 `TypeError`（应返回 `undefined`）；`[1].reduce(fn, undefined)` 的 `undefined` 被当作「未提供初值」。
- 真因：ABI 无法区分「未传实参」与「显式传 `undefined` 实参」（两者都是 TAG）。
- 修（局部而精确）：发射器在 `_emitDynMethod` 中，对 `reduce`/`reduceRight` 且**实参 ≥2** 时改用 `reduce$i`/`reduceRight$i`；宿主这两个 case 把 `toJS(a1)`（可能为 undefined）**作为初值传入**（空数组 → 返回 undefined，非空 → 以 undefined 为累加器调用回调）。
- 验证：`[].reduce(fn, undefined)` = undefined、`[1].reduce(fn)` = 1、`[].reduce(fn, 10)` = 10；corpus24 20→21/21。
- 结果：**816/820（99.5%）**（36 批）；ctest 32/32 零回归。

### `arguments` 对象（2026-10-17，第五次尝试成功）
- 症状：`function g() { return arguments.length + ":" + arguments[0]; } … g(9, 8)` → 编译期 loud（`arguments` 未实现）。
- 实现（全局 scratch 通道，避免改 ABI 局部索引）：
  1. `usesArguments(node)` 静态检测（箭头继承外层；嵌套 `function`/方法有自己的绑定 → 不下探）；顶层函数记入 `_fnArgs`，闭包在 `_emitLambdaBody` 记 `lam._qzNeedsArgs` → `lamMeta.needsArgs`。
  2. 新全局 `__args`（排在模块全局之后）作通道 + 导出 `qzs_setargs(i64)`（宿主/发射器写入）。
  3. `emitFunc`/`_emitLambdaBody`：末尾（env 之前）插 i64 本地，入口 `globalGet(__args) → localSet` 并 `varMap.set("arguments", …)`；`arguments` 标识符解析该本地。
  4. 写入点：**宿主 API `closure_call`**（wasm 直接调用该层，内部 `closureCall` 未必进入）按句柄 funcidx 查 `lamMeta.needsArgs` 后 `qzs_setargs(arrWriteback(全量实参))`（synthThis 时剔除 receiver）；顶层函数直调点由发射器写全局。
- 关键调试结论：机制本身可用（手动 `qzs_setargs([7,8])` 后结果正确）；写入钩子必须挂在**API `closure_call` 层**（内部 `closureCall` 未被进入）。
- 验证：`g(9,8)` → `2:9`；corpus3 38→39/39（该批全绿）。
- 结果：**815/820（99.4%）**（36 批）；ctest 32/32 零回归。

### `finally` 重复执行（2026-10-17）
- 症状：`try { return X } finally { throw Y }` → `finally` **执行两次**（日志 `t,f1,f1,c`）。
- 真因：`return` 触发 `_emitPendingFinally` 跑一次 finally；finally 内抛错置 `__err` 并经 `br` 跳到**该 try 的 `$err` 块**（throw 发射时的动态 try 范围仍含本 try）→ 落回 `emitTry` **正常路径** finally → 第二次。
- 修：`_emitPendingFinally` 发射 finally 体时把 `_tryStack` 同步切到 `slice(0, entry.tryDepth)`（本 try 已退出 → 体内 throw 归向外层 try），发射后还原。
- 验证：`t,f1,c` ✓；`try{return}` + 无 throw 的 finally 行为不变；corpus36 16→17/17（该批三项残余全部修复）。
- 结果：**814/820（99.3%）**（36 批）；ctest 32/32 零回归。

### 嵌套闭包内的私有名限定（2026-10-17）
- 症状：`class Factory { #base = 100; get builder() { return (x) => this.#base + x; } }` → `fac.builder(1)` = NaN（应为 101）。
- 真因：私有名（`this.#x`）按「当前类名」限定，而 `_curClass` 只在类方法体内设置；访问器**返回的闭包**在 `_emitLambdaBody` 中发射时 `_curClass` 为空 → 私有名限定失效。
- 修：`_emitLambdaBody` 复用已有的 `lam._qzSupCtx`（所属类，上一轮箭头 `super` 修复引入）同时设置 `_curClass`（并保存/还原）。
- 验证：`fac.builder(1)`=101、`fac.builder(2)`=102；corpus36 15→16/17。
- 结果：**813/820（99.1%）**（36 批）；ctest 32/32 零回归。

### 对象展开与运行时访问器（2026-10-17）
- 症状：`const s: any = {}; Object.defineProperty(s, "lazy", { get(){…}, enumerable: true }); const c: any = { ...s };` → `c.lazy` = undefined、`Object.keys(c)` = ""（**键值全部静默丢失**）。
- 真因：对象字面量的展开分支对 POJO/实例源走**内存槽级浅拷贝**（`0x7FF9`/`0x7FFE` 分支），而访问器键只存在于宿主 `dynAcc` 表（不在内存槽）→ 无槽可拷 → 静默丢键。
- 修：程序内存在运行时访问器（`usesDynAcc`）时，展开段一律走宿主 `qz.obj_merge`（物化源对象 → `Object.keys` + 逐键取值 → 自然触发访问器 getter 并保留键序）。
- 验证：`c.lazy`=7、`Object.keys(c)`=`lazy`；corpus36 14→15/17。
- 结果：**812/820（99.0%）**（36 批）；ctest 32/32 零回归。

### 第三十六批语料（2026-10-17）
- 新增 `audit_corpus36.js`（17 例）：类内聚（`valueOf`/`toString` 强制转换、字段箭头函数、私有+静态 getter）、迭代器视图（Map/Set/Array entries/keys/values）、递归数据结构、`finally` 抛错、标签跳转、`==`/`===` 边界、`JSON.parse` reviver、闭包 getter、模块级 IIFE、可选链方法调用、数组迭代器方法、getter 返回闭包、深层标签、`replace` 函数替换、展开与 getter、数值边界、mixin 类工厂。**首跑 14/17**。
- 新暴露 3 项残余（已定位）：
  1. `{ ...src }`（src 的键由 `Object.defineProperty` 定义）**未触发访问器 getter**（结果空值、读取计数 0）→ 展开路径未取物化对象的访问器值；
  2. `try { return X } finally { throw Y }` → `finally` **执行两次**（多打一条日志）；
  3. **getter 返回闭包**（`get builder() { return (x) => this.#base + x }`）→ 调用结果为 NaN（闭包 `this`/私有字段捕获在访问器返回闭包时失效）。
- 结果：**811/820（98.9%）**（36 批）；ctest 32/32 零回归。

### `call_value` 宿主函数分支的溢出实参（2026-10-17）
- 症状：`class C { m(a,b,c,d,e) {…} }` 后 `const f = c.m.bind(c); f(2,2,2,2,2)` → `Cannot convert undefined to a BigInt`（提取包装器只收到 4 个实参，第 5 个丢失）。
- 真因：宿主 `call_value` 的**宿主函数句柄**分支只用 `a0..a3`、未使用 `ovf` 溢出数组（此前只修了 `closure_call` 的对应分支）。
- 修：`as3.concat(exA.slice(1))`（ovf[0] = 实参 3，已在 a3）。corpus12 15→16/16。
- 结果：**797/803（99.3%）**（35 批）；ctest 32/32 零回归。

### 类计算属性名经模块级常量解析（2026-10-17）
- 症状：`const _iter: any = Symbol.iterator; class Range { [_iter]() { … } }` → 编译期 loud「类计算属性名方法仅支持 Symbol.<well-known>」（`symbolNameOf` 只认 `Symbol.x` 属性访问）。
- 修：新增 `modSymLit`（模块级 const 持有 `Symbol.<well-known>` → `"@@<sym>"`），在类成员收集处对**标识符**键名回退查表（方法与访问器两处）。corpus27 20→21/21。
- 结果：**796/803（99.1%）**（35 批）；ctest 32/32 零回归。

### 原型上的运行时访问器（2026-10-17）
- 症状：`Object.defineProperty(proto, "computed", {get(){return this._v*2}, set(x){this._v=x+1}})` + `Object.create(proto)` → `o.computed` = NaN、`o._v` 未更新、`getOwnPropertyNames(proto)` 缺 `computed`。
- 两处修复（corpus35 16→17/17，全批首次全绿）：
  1. **物化的运行时访问器以「实际 `this`」为 receiver**：`materializeUncached` 生成 `get`/`set` 时此前把创建时的 POJO 句柄固定传入（`TAG | off`）→ 原型上的访问器经派生对象调用时 receiver 丢失（`this._v` 读到 undefined → NaN）。改为 `function () { … bitsOf(this) … }`（closure 走合成 this 槽、宿主函数走 `.call(this)`；`this` 为 null/undefined 时回退捕获句柄）。
  2. `Object.getOwnPropertyNames` 补入 `dynAcc`（`defineProperty` 访问器）键 —— 访问器也是自有属性。
- 结果：**795/803（99.0%）**（35 批）；ctest 32/32 零回归。

### 静态方法内 `this` 的运行时代（2026-10-17）
- 症状：`class B extends A { static describe() { return "B+" + super.describe(); } }` → `B.describe()` 得 `"B+A:A"`（应 `"B+A:B"`）——静态方法内 `this` 恒为**定义类**。
- 四处修复（corpus35 15→16/17）：
  1. 静态方法体 `this` → 读 **self 槽**（local 0，调用点传接收者类）；未传（TAG/undefined/null）→ 回退定义类（保持既有调用者兼容）。
  2. 静态**直调**调用点：self 由占位 `undefined` 改为 `class_value(接收者类)`（`B.describe()` 继承自 A 时 this = B）。
  3. `super.<静态方法>`：self = 当前 self 槽（保持原接收者）。
  4. 宿主静态方法包装器：self = `classValueImpl(clsId)`（而非 TAG 占位）；静态 getter 读路径同样传接收者类。
  5. `this.x` 于静态方法内新增宿主 `qz.static_get_dyn(self, fieldId)`：按句柄 `__qzClsId` 沿 ctor 的 `__proto__` 链查静态字段（派生类遮蔽/继承）。
- 期间发现并修复两处回归（`static{}` 块内 `this` 应仍为定义类 → 新增 `_inStaticInit` 标记排除；静态 getter 路径未传接收者）→ c20/c34 恢复全绿。
- 结果：**794/803（98.9%）**；ctest 32/32 零回归。

### do-while 每迭代绑定（2026-10-17）
- 症状：`do { const k = i; fns.push(() => k * 10); i++; } while (i < 3)` → 三个闭包同值 20（应 0,10,20）。
- 真因：`emitDoWhile` 缺 `_loopCaptured`/`_emitPerIterEnv` 调用（`while`/`for`/`for-of` 均有）。修：tagged 路径下先建每迭代 env 再发射体。
- 结果：**793/803（98.8%）**；corpus35 14→15/17；ctest 32/32 零回归。

### 批 35 残余修复（2026-10-17）
- **synthThis 无溢出分支的 rest 切片基准错误**（上一批引入的回归）：`vals` = `[receiver, 实参 0..2]`，固定参（含 receiver）占 0..nV-1 → rest 应为 `vals.slice(nV)`，此前写成 `slice(nV - 1)` → **receiver 混入 rest 数组**（`o.j("a","b")` 的 `xs` = `[obj,"a","b"]`）。corpus35 13→14/17。
- **`instanceof` 右值为宿主对象**（如 `B.prototype`）：`instanceof_op` 此前对非 `0x7FFE` 句柄一律 false → 增加 `HOST_HI` 分支，按 JS `instanceof`（对 `classObjImpl(clsId)` 构造器）判定。
- 结果：**792/803（98.6%）**（35 批）；ctest 32/32 零回归。

### 第三十五批语料（2026-10-17）
- 新增 `audit_corpus35.js`（17 例）：原型访问器（defineProperty on prototype）、静态继承 + `super` 静态、解构形参（默认值/rest/嵌套）、`catch` 解构、自定义迭代器类、`JSON.toJSON`、Date 确定性操作、排序边界值、类实例属性描述符、`delete`/`in`/`typeof` 组合、类实例删字段、do-while 闭包、互递归、Map/Set 转换、标签模板 raw、getter/setter 副作用、展开调用。**首跑 12/17**。
- 修复：私有字段名（`#C#name`）此前出现在 `Object.getOwnPropertyNames`（JS 私有槽不可见）→ 过滤；`method_call` 的 POJO 闭包字段 rest 分支的 `nFix` 未扣 synthThis 的 receiver 槽 → 修正基准。
- 新暴露 4 项残余（已定位）：
  1. `Object.defineProperty(proto, k, {get/set})` 于 POJO 原型 + `Object.create(proto)` 的访问器读（`o.computed` → NaN）；
  2. 静态方法内 `this` 恒为**定义类**（`B.describe()` 里 `super.describe()` 的 `this.tag` 应为 B）→ 需静态方法接收者运行时化；`B.prototype instanceof A` = false（原型对象的 instanceof）；
  3. do-while 体内 `const` 未被闭包**每迭代**绑定（三个闭包同值）；
  4. 对象字面量方法（synthThis + rest）调用时 receiver 进入 rest 数组（`o.j("a","b")` → `xs=[obj,"a","b"]`）。
- 结果：**791/803（98.5%）**（35 批）；ctest 32/32 零回归。

### 函数 `toString` 剥离 TS 类型注解（2026-10-17）
- 症状：`String(fn)` 返回含类型标注的 **TS 源文本**（`(x: any) => x instanceof Function`），而 oracle 是 tsc **转译后的 JS**（`(x) => x instanceof Function`）→ 窄面 diff。
- 修：新增 `stripTsTypes(node, sf)` —— 遍历 AST 收集「参数/函数返回/属性/变量声明的类型节点」与「`as`/`<T>`/`satisfies` 断言」，在源码文本上按位置**降序删除**（类型节点的 `pos` 不含前导冒号 → 一并剥掉冒号与空白）。`lamMeta.src` 改用该函数。
- 验证：`String((x: any) => x instanceof Function)` = `(x) => x instanceof Function`，corpus27 19→20/21。
- 结果：**778/786（99.0%）**；ctest 32/32 零回归。

### POJO 原型链（`__proto__` 字面量 / `setPrototypeOf`）+ `Array.prototype` 句柄（2026-10-17）
- 症状：`Reflect.getPrototypeOf([]) === Array.prototype` 恒 false；`Reflect.setPrototypeOf(o, {y:2}); o.y` 读不到继承的数据属性。
- 三处修复（corpus28 20→21/21）：
  1. **`ret()` 特判 `Array.prototype`**：`Array.isArray(Array.prototype) === true`（ES 规范如此）→ 此前走 `arrWriteback` 把它变成 wasm 数组句柄 → 与 `builtin_member("Array.prototype")` 得到的宿主句柄不相等。
  2. **发射器新增 `usesProto` 检测**（`__proto__` 字面量键 / `Object|Reflect.setPrototypeOf`）：命中时 POJO/实例属性读改走宿主 `qz.prop_get`（与 `usesDynAcc` 同路径），从而具备原型链回落。
  3. 宿主 `prop_get` 对 POJO/实例本就以「物化对象取属性」收尾（含原型链），无需额外改动。
- 验证：`Reflect.getPrototypeOf([]) === Array.prototype`=1；`Reflect.setPrototypeOf(o,{y:2})`=`true`、`o.y`=`2`、`getPrototypeOf(o) !== Object.prototype`=1。
- 结果：**777/786（98.9%）**；ctest 32/32 零回归。

### 第三十四批语料 + 展开实参调动态方法（2026-10-17）
- 新增 `audit_corpus34.js`（18 例）：强制转换（Symbol.toPrimitive/valueOf/toString）、数值格式化、数组进阶（splice/fill/copyWithin/at/findLast）、RegExp 状态与 lastIndex、Map/Set 迭代中修改、getter 抛错传播、稀疏数组、Object.is/getOwnPropertyDescriptors、类访问器继承 + super 访问器、delete/void/逗号、标签模板与 raw、for-in 键序（含原型链/数组）、String 构建、嵌套闭包状态、类静态块顺序、try/finally 顺序、对象展开深拷贝。**首跑即 17/18 → 18/18**。
- 新修 2 项：
  1. **展开实参传给动态接收者方法**：`out.push(...[1,2,3].slice(1))` / `obj.m(...args)` 此前 loud「展开实参仅支持顶层函数/闭包/静态方法/内建调用」。新增宿主 `qz.method_spread(recv, mid, argsArr)`（`makeQzvm` 返回对象改为 `const api = {…}` + 挂载后 `return api`），发射器对 PropertyAccess 接收者动态分派，内部复用 `method_call` 分派。
  2. **宿主数组 `push`**：`doArrMethod` 缺 `push` 且不收溢出实参 → 增加 `ex` 形参（`ovf[1..]`）与 `push` 分支（返回新长度，`arrSetInPlace` 写回）。
- 结果：**776/786（98.7%）**（34 批）；ctest 32/32 零回归。

### 句柄直通与宿主函数溢出实参（2026-10-17）
- `bitsOf(x)`：输入已是 **tagged bigint 句柄**（实例/POJO/数组）时直通，不再被 `tagHandle` 再包一层宿主句柄（此前会把实例句柄当 self 传回 wasm → 类方法内 `this.k` 读到宿主包装对象）。
- 宿主 `closure_call` 的**宿主函数句柄**分支此前只传 4 个实参槽、忽略溢出实参数组 → 经 `.bind`/`.call` 调用 >4 形参的函数时第 5+ 实参丢失。改为 `slots.filter(givenSlot) ++ ovf[1..]`。
- 结果：**758/768（98.7%）** 不变（c12 `class-method-many-params` 的 `.bind`+>4 参仍为残余）；ctest 32/32 零回归。

### 计算属性名解构（2026-10-17）
- 症状：`const { ["k" + 1]: dyn } = obj` → 编译期 loud「暂不支持计算属性名的解构」（两处：`{...rest}` 键名汇总预检 + 元素发射）。
- 两处修复（corpus33 17→18/18）：
  1. `{...rest}` 的静态键名汇总仅在**确实存在 rest** 时执行（无 rest 时计算键名合法）；存在 rest 时的计算键仍 loud。
  2. 元素发射：`name` 为 `ComputedPropertyName` → `o[expr]`（`_emitElemOf` 运行期键）而非报错；两处解构发射点均已支持。
- 结果：**758/768（98.7%）**（33 批）；ctest 32/32 零回归。

### 第三十三批语料 + 4 项新修（2026-10-17）
- 新增 `audit_corpus33.js`（18 例）：Object/Array 组合方法、defineProperty、sort 比较器、String 方法、JSON replacer、标签循环、try/finally、switch、解构、Map/Set、数值与位运算、Math、freeze/seal、私有字段、Symbol、可选链/逻辑赋值、Array.from、闭包循环变量、正则组。首跑 14/18 → **17/18**。
- 新修 4 项：
  1. **物化非枚举自有属性**：`Object.defineProperty(o,k,{enumerable:false})` 的属性此前在物化时被**完全跳过**（只记 nonEnum）→ `hasOwnProperty`/`getOwnPropertyDescriptor` 读不到。改为 `Object.defineProperty(o,k,{value,enumerable:false,configurable:true})`（`Object.keys` 仍不含）。
  2. **JS 键序**：`Object.getOwnPropertyNames`/键枚举须「整数键在前（升序），其余插入序」。
  3. **内建调用 >4 实参**：`Object.assign({}, a, b, c, d, e)` 直接路径只有 4 个实参槽 → 第 5+ 源静默丢失。发射器改为「内建全局/成员 + >4 实参」走展开路径（宿主 `builtin_spread` 全量透传；`Object.assign` 分支合并语义）。
  4. **私有名 `in`（品牌检查）**：`#x in o` 此前 loud「不支持的表达式: PrivateIdentifier」。新增宿主 `qz.brand_check(obj, clsId)`：非对象 → `TypeError("Cannot use 'in' operator on non-object")`（与 JS 同文案）；对象 → 是否该类实例。
  5. **静态/实例方法直调路径补 `_emitErrCheck`**：被调内 throw（跨函数 `__err`）此前被**静默吞掉**（如 `#x in null` 抛错后调用方继续执行）。
- 结果：**757/768（98.6%）**（33 批）；32 批 + ctest 32/32 零回归。

### 类名作值（类方法内 return M）+ 静态方法包装器参数补齐（2026-10-17）
- 症状 A：`class M { static inc() { return M; } }` → `M.inc()` 返回 **undefined**（静默错值）；进而 `M.inc().inc()` 报「method_call: 无方法 inc」。
  真因：`collectClasses` 逐个 `classes.set` 期间，**尚未登记的类名**（含本类自身、后续声明的类）被 `_capturesOf` 误判为自由变量 → 进类 env 捕获表 → 方法体内标识符走 `env_get` 得 TAG。
  修：`collectClasses` 开头一次性收集**本次全部类名**（`allClsNames`），捕获过滤增加该类名判定（含 `_className` 别名）。
- 症状 B：静态方法包装器 `(...as) => exportsRef[...](TAG, ...as.slice(0,4).map(bitsOf), TAG)` 在实参不足 4 个时**少传 wasm 参数** → `Cannot convert undefined to a BigInt`。修：补齐 4 个槽（不足补 TAG，与实例方法包装器 `mkMeth` 一致）。
- 验证：`M.inc()`=`typeof function`；`M.inc().inc().get()`=`2`、`M.n`=`2`。
- 结果：**740/750（98.7%）**；corpus7 23→24/27；32 批 + ctest 32/32 零回归。

### 对象字面量方法内的 `super`（2026-10-17）
- 症状：`const d = { __proto__: base, greet() { return "d+" + super.greet(); } }` → 编译期 loud「super.greet() 在父类链上未定义」（对象字面量方法没有类上下文）。
- 三处修复（corpus29 18→19/20）：
  1. `_memberLambda` 给对象字面量方法的合成箭头标记 `_qzLitMethod`；`_emitLambdaBody` 据此设 `_inLitMethod`（保存/还原）；
  2. `super.m(args)` 发射：`_curClassObj` 为空且处于对象字面量方法内时 → 走宿主 `qz.super_method(recv, mid, a0..a3, ovf)`（receiver 由 `_emitThisReceiver()` 取）；
  3. 宿主 `super_method`：`this` 物化 → `Object.getPrototypeOf(o)`（`__proto__` 字面量在物化时已设真原型）→ 原型上取 `m`（POJO 原型的**字段槽闭包值**直调 `closureCall`，宿主原型走 `fn.apply`）→ **this = receiver**。
- 验证：`derived.greet()`=`derived+base`；`derived.kind`（继承 getter）=`B`；`"greet" in derived`=true；`Object.getPrototypeOf(derived) === base`=true。
- 结果：**739/750（98.5%）**；32 批 + ctest 32/32 零回归。

### `Object.create(Array.prototype)` 的 `length`（2026-10-17）
- 症状：`const arr = Object.create(Array.prototype); arr[0]=1; arr[1]=2; arr.length=2;` → `arr.length` 恒 0、`arr.join(",")` 恒空串（静默错值）。
- 两处修复（corpus27 18→19/21）：
  1. 发射器 `_emitStoreLength` 的「非 wasm 数组」分支把值写进 **POJO 字段槽**（对宿主对象 = 写 wasm 内存垃圾）→ 增加 `HOST_HI(0x7FFD)` 子分支走 `qz.set_index(recv, "length", v)`（宿主对象属性写）。
  2. 宿主 `arr_set_len` 增加宿主对象回落：`0x7FFD` 句柄 → 直接写 JS 属性 `o.length`（此前按 wasm 数组头解析内存 → 返回 0）。
- 验证：`arr.length`=2、`arr.join(",")`=`1,2`、`Array.isArray(arr)`=false。
- 结果：**738/750（98.4%）**；32 批 + ctest 32/32 零回归。

### function 作类族（`Animal.prototype.x = …` / `new (Dog as any)()`）（2026-10-17）
- 症状：`new (Dog as any)("Rex")` → 编译期 loud「new 未知类: Dog」（顶层函数不是类）；`d instanceof (Animal as any)` → loud「instanceof 右操作数须为用户类」。
- 六处修复（corpus22 18→19/19 全绿）：
  1. `fn_value` 契约新增 `hasThis`（`["i32","i32"]` → 三参）：带 TS `this` 形参的顶层函数作值时，宿主包装器把 receiver **前置**到第一形参（与 ABI `(blk?/this, 实参…)` 一致）；发射器新增 `_fnHasThis` 表（按 `st.parameters` 是否有名为 `this` 的形参）。
  2. `_emitNewCall`：`resolvable` 增加 `fnNames.has(tgt)` —— 顶层函数亦可作 `new` 目标。
  3. `new_dynamic`：用户类构造器（有 `__qzClsId`）仍直调（`Reflect.construct` 会**丢弃**其返回的实例句柄 bigint）；普通函数改走 `Reflect.construct`（JS new 语义：prototype 链、构造器返回对象则用之）。
  4. `instanceof` 右值先**去括号/as/非空断言**（`d instanceof (Animal as any)`）；动态右值判定补 `fnNames`；宿主 `instanceof_dyn` 对「非内建名的普通函数」直接用 JS `instanceof`。
  5. `this` 读取：声明了 `this` 形参的函数不再硬编码返回 undefined（`_lamThisParam`），改为读 receiver 槽 —— 无 receiver 时该槽即 undefined，与 JS 严格模式等价；有 receiver（`.call`/`new`）时正确绑定。
  6. 宿主对象属性上存放的**闭包值**：`method_call` 遇 `CLO_HI` 属性 → `closureCall(..., recv)`（传 receiver）；`cloWrap` 包装器转发 JS `this` → `closureCall` 的 recv（此前对象属性上的闭包作方法调用时 `this` 恒 undefined）。
- 验证：`new (Animal as any)("Rex").name`=`Rex`；`Animal.call(this,name)` 链（Dog 继承）=`Rex`；`Animal.prototype.speak = function(this){…}` → `d.speak()`=`Rex makes a sound`；`d instanceof (Animal as any)`=1；`Object.getPrototypeOf(d) === Dog.prototype`=1。
- 结果：**737/750（98.3%）**；32 批 + ctest 32/32 零回归。

### 箭头函数内的 super（2026-10-17）
- 症状：`class B extends A { arrow() { const f = () => "a" + super.m(); return f(); } }` → 编译期 loud「super.m() 在父类链上未定义」（lambda 发射期无类上下文）。
- 三处修复（corpus13 19→20/20 全绿）：
  1. `emitLambda` 记录 lambda 的**所属类**（按 pos/end 包含判定 method/ctor 节点，不依赖 parent 指针；合成箭头 `_qzSynthThis` 除外——对象字面量方法的 super 指向其 home object）；
  2. `_emitLambdaBody` 用该上下文设置 `_curClassObj`（并在恢复处还原），使 lambda 体内 super 可解析；
  3. `_capturesOf` 把 **`super` 关键字**视同 `this`：箭头引用 super 时捕获 `this`（`_probeCaptured` 随之让外层方法把 `this` 写入 env，`_mEnter` 已有 `env_set("this", local 0)` 路径）。
- 新增 `_emitThisReceiver()`：super 的 receiver 取值统一走「捕获 this / this 形参槽 / local 0」，修 lambda 内 `localGet(0)`（i32 blk）当 this 的 wasm 校验失败（`call[0] expected i64, found i32`）。
- 验证：`b.m()`=`BA`、`b.arrow()`=`aA`、`b.arrowG()`=`GA`。
- 结果：**736/750（98.1%）**；32 批 + ctest 32/32 零回归。

### 多参数（>4 形参）调用完整性（2026-10-17）
- 症状：对象字面量方法 `o.m(a,b,c,d)` 第 4+ 实参**静默变 undefined**（`[a,b,c,d].join()` → `a,b,c,`）；类方法 `.bind` 后带 5 参调用抛 `Cannot convert undefined to a BigInt`。
- 四处修复（corpus12 14→15/16）：
  1. **发射器** `_memberLambda`：对象字面量方法的合成形参被 `.slice(0, 4)` 截断 → 第 4+ 形参从 lambda ABI（`lamMeta.n`）消失，`closureCall` 永远不向宿主索要这些实参。去掉截断（ABI 本已支持任意形参数：`["i32"] + n×i64`）。
  2. 宿主 `closureCall` 的 `meta.n > 4` 分支：把 `a3` **一律**当作「溢出实参数组」（`toJS(a3).length`）→ 标量 `a3` 时 `length` 为 undefined → 实参 3/4 变 undefined。改为仅当 `a3` 是 wasm 数组（0x7FFB）时才解包（旧约定），否则它就是实参 3。
  3. 宿主 `closureCall` 的 `synthThis` 路径：右移 `a3 = a2; a2 = a1; a1 = a0` **丢弃实参 3**；且 `hasEx` 收尾从 `ex[1]` 起（synthThis 时 `ex[0]` = 实参 3 并未进 slots）。修：右移前保存实参 3、新增「无溢出数组 + synthThis」分支按 `[this, 实参…]` 重排、`hasEx` 收尾按 synthThis 从 `ex[0]` 起。
  4. 宿主 `prop_get` / `method_call` 的 `call`/`apply`/`bind` 与「提取的类方法包装器」：一律只传 3-4 个实参槽。改为按调用点约定补**溢出数组**（`ovf[0]` = 实参 3）+ 过滤未传槽（TAG 填充）。
- 验证：`o.m(a,b,c,d)`=`a,b,c,d`；`o.m(1..5)`=`1,2,3,4,5`；`o.add5(1..5)`（用 `this.base`）=15；`c.m.call(c,1,2)`/`c.m.apply(c,[3,4])` 正确；`g.call(null,1..5)`（普通闭包）=`12345`。
- 已知残余：`class C { m(a,b,c,d,e){} }` 的 **`.bind` 后再以 5 参调用**仍抛错（提取包装器的 `this` 物化回传链路，另案）。
- 结果：**735/750（98.0%）**；32 批 + ctest 32/32 零回归。

### extends 内建（Error 族）语义（2026-10-17）
- 症状：`class AppError extends Error` 实例 `String(e)`/`e.toString()` = `[object Object]`（应 `"AppError: bad"`）。
- 四处修复（corpus30 19→20/20 全绿）：
  1. `_instSize()` 偏小：内建父类 `super(msg)` 写的 `message`/`name` 槽在**分配之后**才登记到 fieldMap → 实例 `[4]=size` 不含该槽 → 宿主物化时 `idx >= size` 被丢弃（`Error.prototype.toString` 读不到 `message`）。修：`collectClasses` 预登记阶段，对「父类非本程序类」的类先登记 `message`/`name`。
  2. 宿主 `classObjImpl` 未接内建父类原型：`pc` 对 `extends Error` 为 null → `proto = Object.create(Object.prototype)` → 实例拿不到 `Error.prototype.toString`。修：引入 `bp = globalThis[builtinParent]`，ctor 的原型链与 `proto` 的父原型都接上真内建（`Error` 族/Array/Map…）；`instanceof Error` 语义随之天然正确。
  3. 宿主 `method_call` 的 `toString`/`valueOf`/`toLocaleString` 分支在「类无自定义同名方法」时**硬编码**返回 `[object Object]`（静默错值）。修：回落物化对象的真实原型链实现（`Error.prototype.toString` → `"Name: msg"`；带 `Symbol.toStringTag` → `[object Tag]`）。
  4. 伴随：`materializeUncached` 的 `idx >= size` 边界（见 1）。
- 验证：`String(e)`/`e.toString()`=`AppError: bad`（子类 `NotFound: missing`）；`e instanceof Error/NotFound`=true；`{}`.toString()/`{a:1}`.toString() 仍 `[object Object]`；`Object.keys(err)` 不含 `message`（JS 语义：非枚举）。
- 结果：**734/750（97.9%）**；32 批 + ctest 32/32 零回归。

### 类计算 Symbol 访问器 + Symbol.toStringTag 物化（2026-10-17）
- 现状：`class C { get [Symbol.toStringTag]() { return "C"; } }` → 编译期 loud「不支持的类成员: GetAccessor」（只有**方法**形式 `[Symbol.iterator]()` 被支持）。
- 三处修复：
  1. 发射器类成员收集：新增「计算属性名**访问器**」分支 → `@@<symbol>` 名（与计算方法同路径）；
  2. 宿主 `materializeUncached` 的 `hook()` 只查 `meta.methods` → 补查 `meta.getters`（访问器形式的 `@@toStringTag` 才能物化）；
  3. 宿主 `classObjImpl` 的实例方法/访问器挂载：`@@<symbol>` 名 → **真 `Symbol`**（`@@toStringTag` → `Symbol.toStringTag`），此前按字面量字符串挂 → `Object.prototype.toString.call(inst)` 得 `[object Object]`。
- 验证：`Object.prototype.toString.call(new Tagged())`=`[object Tagged]`；`new Tagged()[Symbol.toStringTag]`=`Tagged`；内建标签 `[object Array]/Object/Number/String/Boolean/Null/Undefined/Function/Map/Set/RegExp/Date` 全对。
- 结果：**733/750（97.7%）**；corpus29 17→18/20；32 批 + ctest 32/32 零回归。

### 类表达式命名/继承解析（2026-10-17）
- 三处修复（`class-expression-names` 由编译期 loud「call 未定义: __m_Named$ctor」→ 仅剩 1 个子句 diff）：
  1. `extends` 父类名取原文（`parent.expression.text`）→ 现经 `_className()` 解析（类表达式绑定名/导入别名 → 真实类名），否则 `ctorName` 落空；
  2. `_isClassName()` 用 `classes.has(node.text)` 未做别名解析（与 `_classOfExpr()` 不一致）→ 补 `_className()`，`const Named = class Inner{}; Named.name` 由此走类静态访问路径；
  3. 匿名/带超类的类表达式作名：`const Anon = class {}` 现有 `Anon.name === "Anon"`、`const Ext = class extends Named {}` → `Ext.name === "Ext"`（JS 名推断）。实现用 **walkCls 绑定名下传**（`VariableDeclaration`/`PropertyAssignment`/`BindingElement` 的名字），**不依赖 `n.parent`** —— collectDecls 阶段 program 尚未类型绑定，parent 为空。
- 已知残余：**函数返回类表达式**（`const make = (l) => class { get x() { return l; } }`）每次调用应产生**新类**（各自闭包/独立 `instanceof`）；AOT 按单一提升类处理 → 两次调用的实例同为该类。
- 结果：**732/750（97.6%）**；32 批 + ctest 32/32 零回归。

### 类的 .name 属性 + Function 作值（2026-10-17）
- 症状：`A.name` 恒 `undefined`（`class A {}` + `A.name`）；且 `Function` 不在内建全局表 → `Object.getPrototypeOf(A) === Function.prototype` 报 loud「未定义捕获变量: Function」。
- 两处修复：
  1. `BUILTIN_GLOBALS` 补 `Function`（宿主 `builtin_member`/`qzBuiltinValue` 早已支持 `globalThis['Function']`，仅发射器白名单缺）；
  2. `C.prop` 的类静态访问路径（`ClassName.property`）**初值**由 `undefined` 改为 `class_value(cn)` + `prop_get(name)`（类对象属性：`.name`/`.toString`/`.prototype`/继承属性），静态字段仍按父→子叠加上覆（遮蔽语义不变）。
- 验证：`A.name`=`A`；`A.name|B.name|C.name`=`A|B|C`（三层继承）；`Foo.x`(静态字段)=`42` 且 `Foo.name`=`Foo`；`typeof A.name`=`string`。
- 结果：**732/750（97.6%）**；corpus29 16→17/20（`class-value-proto-deep` 转绿）；32 批 + ctest 32/32 零回归。

### 自递归直调（闭包深递归不再吃宿主栈）（第三轮成功，2026-10-17）
- 现状：`const sumTo = (n) => n <= 0 ? 0 : n + sumTo(n-1)` 每层递归都经 `qz.closure_call`（宿主 JS 帧）→ 约数百层即 `Maximum call stack size exceeded`。
- 修复：lambda 体内调用自身时改为直调自己的 wasm 函数（`blk:i32` + n 个 i64，不经 `closure_call`）。三处要点：
  1. `_emitBindingDecl` 的 `const f = () => …` 绑定点把绑定名传给 `_emitLambdaNew`（此前只有函数声明点传名）；
  2. `_emitLambdaBody` 记录 `_lamSelf = {name, fname, n, rest}`（仅非 synthThis）；
  3. `_mEnter`（方法/构造器体）与顶层函数体内清空 `_lamSelf` —— 这是上一轮 corpus4 校验失败的真因：标记泄漏到方法体，方法里 `localGet(0)` 是 i64 `this`，而 lambda 的 blk 是 i32，类型不符。
- 验证：`sumTo(500)` = 125250（原溢出）；`fib(20)`/`fact(10)` 不变；corpus4 `closure-this-arrow-method` = `5|5` 正常；`sumTo(2000)` 仍溢出（wasm 栈上限，窄面）。
- 结果：**731/750（97.5%）**；corpus29 15→16/20；32 批 + ctest 32/32 零回归。

### `Function.prototype.toString` 返回源码原文（2026-10-17）
- `lamMeta` 每条新增 `src`（lambda 源码原文，取自 `node.getText(sourceFile)`）；宿主 `cloWrap` 在包装闭包为 JS 函数时覆写 `toString` → 返回该源码。
- 此前闭包物化后的 `String(fn)`/`[fn].join()` 返回**物化包装器**的源（`(...args) => toJS(closureCall(b, ...))`）。
- 验证：`const fn = (x:any) => x*2; [fn].join()` = `(x: any) => x * 2`；`String(function(a){return a;})` = `function (a: any) { return a; }`。
- **已知残余**：返回的是 **TS 源码**（含类型标注），而 oracle 是 tsc **转译后的 JS**（`(x) => x * 2`）→ 相关窄面用例（如 corpus27 `instanceof-custom-hasinstance` 的最后一列）仍按 diff 计；要完全一致需为每个 lambda 生成转译后文本。
- 结果：**730/750（97.3%）**；32 批 + ctest 32/32 零回归。

### 内建全局作值 + 原始值 `.constructor`（2026-10-17）
- **内建全局作值**：标识符路径新增分支——`BUILTIN_GLOBALS` 名字作值 → `qz.builtin_value(strId)`（宿主句柄**缓存**，保证 `String === String`）；此前落到 `_emitCapturedRead` 的 loud「未定义捕获变量」。
- **原始值 `.constructor`**：宿主 `prop_get` 对字符串/数字/布尔的 `constructor` → 返回对应内建句柄（`"x".constructor === String` 现为 true）。
- 验证：`"x".constructor === String`、`5 .constructor === Number`、`true.constructor === Boolean` 均 true；`typeof String/Array` = function、`T === Array` true、`a instanceof T` true。
- 结果：**730/750（97.3%）**（语料计数未变——相关窄面用例另有其它断言）；32 批 + ctest 32/32 零回归。

### 含方法/访问器的对象字面量 + 展开 + 计算键（2026-10-17）
- **展开**：此前该分支直接 loud「含方法/访问器的对象字面量暂不支持展开」→ 现按源码序用 `qz.obj_merge` 就地并入；宿主 `obj_merge` 新增**宿主对象目标**分支（`Object.assign` 语义，值已是 JS 值**勿再 `toJS`**——这正是上一次尝试 `Cannot convert 2 to a BigInt` 的原因）。
- **计算键**：该分支此前只认 `p.name.text` → `[key]` 落成 `"undefined"`；现计算键改走 `qz.set_index(target, 求值键, 值)`。
- 验证：`{ m(){return 1}, ...{a:2,b:3}, g:4 }` = `1,234,m/a/b/g`；`{ ...base, get d(){return 9}, y:2 }` = `12,{"x":1,"d":9,"y":2}`；`{ ...{a:1}, m(){return 2} }` = 3；corpus32 `object-literal-patterns` 全通。
- 结果：**730/750（97.3%）**；corpus32 18→19/19；32 批 + ctest 32/32 零回归。

### 闭包内类名被误当自由变量捕获（silent 错值修复，2026-10-17）
- **根因**：`_capturesOf` 的自由变量扫描把**类名**（如 `Circle`）当作闭包的自由变量 → 闭包内 `s.constructor === Circle` 的 `Circle` 走 `env_get` → env 中并无该名 → 得 TAG(undefined) → 比较恒 **false**（而同层函数体内正常）。
- 探针证据：`qz.seq` 收到 `0x7FFD|2`（类句柄）与 `0x7FF9|0`（TAG）→ 左侧对、右侧是 undefined；`typeof s.constructor` 为 `function`、`s instanceof Circle` 为 `true`，仅 `===` 错。
- **修复**：`_capturesOf` 的标识符过滤补一条「类名不算自由变量」（`this.classes.has(this._className(name) || name)`）；另外把标识符值的类解析兜底为 `_className(text) || (classes.has(text) ? text : undefined)`（闭包内 `_className` 可能失配）。
- 验证：闭包内 `(s) => s.constructor === Circle` 由 false → **true**；`[new Circle()].map(...)` 同步修好；corpus32 `class-hierarchy-shapes` 由 `RRR` → `CRQ`。
- 结果：**729/750（97.2%）**；corpus32 17→18/19；32 批 + ctest 32/32 零回归。

### 第三十二批差分审计（2026-10-17）
- 新增 `audit_corpus32.js`（19 例：模块级初始化模式（闭包调用/IIFE/计数器——start-段修复后新解锁的面）、模块级状态机、迭代协议（Map/Set/Array 的 keys/values/entries + for-of）、字符串格式化算法、数值算法（素数/阶乘/gcd/斐波那契/Collatz/数位和）、类层次（面积/instanceof/constructor 比较）、错误恢复（tryParse/withRetry/嵌套 try）、闭包循环捕获（var/let/for-of/while）、对象字面量全形态、数组迭代进阶、switch 控制流、JSON 往返、Map/Set 重度使用、高阶管线、字符串解析、bigint/symbol 探针、深层嵌套数据、混合程序 v2、数值精度运算）。
- 结果：**728/750（97.1%）**；corpus32 17/19。ctest 32/32。
- 新增 2 项残余：
  - **silent（待查）**：`s.constructor === Circle` 在**嵌套闭包（如 `shapes.map(s => …)`）**内恒为 false（直接在同层函数体内读 `b.constructor === B` 是对的）。插桩显示两侧**句柄完全相同**（`class_value(1)` 两次都返回 `0x7FFD|2`），故问题在比较发射路径（该上下文下的 `===`），需 dump 该表达式的发射。
  - **loud**：含方法/访问器的对象字面量 + 展开（`{ m(){}, ...x }`）→「含方法/访问器的对象字面量暂不支持展开」。

### 模块初始化移出 start 段（2026-10-17，重大修复）
- **根因**：`emitter.js` 用 `m.setStart("__module_init")` 把模块初始化放进 **start 段**，而 start 段在 `WebAssembly.instantiate` 时执行——此时宿主尚未 `bindMem`。于是**任何模块级闭包/值调用**（`const y = f(2)`、`const x = makeThing()`、mixin 工厂调用）都会在 `qz.closure_call` 读闭包头（`new DataView(mem.buffer)…`）时崩 `Cannot read properties of null (reading buffer)`。
- **修复（两处，极简）**：
  - 发射器：**去掉 `setStart`**，`__module_init` 保持普通导出（原样）。
  - 宿主：新增 `tryRunModuleInit()`（幂等一次），在**最后一次 bind**（`bindClasses`，两个 harness 均最后调用）内触发；未绑定的错误经 `throwValue` 转成产物侧异常。
- **连带收益**：类捕获特性对**模块级 mixin**（`const Mid = withVersion("1.0")(Root)`）的限制同时解除。
- 验证：`const f = (x) => x+1; const y = f(2)` = 3；`withVersion("1.0")` 模块级 mixin = `r,1.0`。
- 结果：**711/731（97.3%）**；corpus22 17→18/19、corpus30 18→19/20；31 批 + ctest 32/32 零回归。

### 类表达式方法捕获外围变量（2026-10-17，第六轮落地）
- **能力**：`const withV = (v) => class { v() { return v; } }`、`(v) => (Base) => class extends Base { version() { return v; } }` 等方法内自由变量可直接读取（此前 loud「未定义捕获变量」）。
- **实现（零新 import）**：`collectClasses` 一次性算出 `c.captured`（`_capturesOf(methodNode)`，排除内建/类名/`fnNames`/字面量 **以及嵌套函数形参**）；`_emitClassValue` 在创建点**总是**建 env（`env_new(-1)` + 逐名 `env_def(envIdx, strId(name), 值)`）并 `static_set(cname, "@@qzEnv", env)`；`_mEnter` 在唯一锚点把 `c.captured` 并入 `capNames`，无嵌套 lambda 捕获时 `envLocal = static_get(cname, "@@qzEnv")`（`i32WrapI64`），`capMap` 随之映射，方法体自由变量经既有 `_emitCapturedRead`(`env_get`) 读取。
- **两个关键 bug（本轮定位）**：① `qz.env_def` 首参是 handles **索引(i32)**，传句柄(i64) → V8 `call[0] expected type i32, found local.get of type i64`；② `_capturesOf` 会把**嵌套箭头/函数的形参**当作自由变量（`_collectLocals` 不下探）→ 如 `render(){ arr.map((t) => …) }` 的 `t` 被误捕获 → 方法侧 env 索引非法 → `env_set` 崩（`Cannot set properties of undefined (setting "t")`）。修：`_mEnter` 与 `_emitClassValue` **共用同一过滤集**，并排除嵌套形参。
- **已知限制**：模块级创建的 mixin（`const Mid = withVersion("1.0")(…)`，类值在 `__module_init`/start 段产生）仍失败——start 段宿主 `mem` 未绑定，`env_def` 写**字符串**捕获值会触发 `strWriteback`（下一次把类 env 构建延后到 mem 绑定之后即可）。
- 结果：**709/731（97.0%）**（语料未变——`curried-class-factory` 属上述模块级限制）；31 批 + ctest 32/32 零回归。

### mixin 类字段默认值（2026-10-17）
- **根因**：动态父类（`class Final extends Counted(Root) {}`）在编译期 `c.parent = null` → 合成 ctor 的 super 转发条件 `else if (c.parent)` **不成立** → **父类 ctor 从不执行** → mixin 类（`class extends B { count = 0; … }`）的字段默认值未应用（`++this.count` → NaN）。
- **修复**：条件放宽为 `else if (c.parent || this._dynParentExpr(c))`（动态父同样须转发 super）。
- 验证：`new Final()` 后 `x.count, x.inc(), x.inc()` = `0,1,2`（原 `undefined,NaN,NaN`）；三层 mixin（`Counted(Tagged(Base))`）= `base,tagged,1,2,2`（与 JS 一致）。
- 结果：**709/731（97.0%）**；corpus30 17→18/20。31 批 + ctest 32/32 零回归。

### 动态 instanceof（运行时类值 / 内建值）（2026-10-17，第三轮后成功）
- **判定**：`instanceof` 右值为**非已知类名**且为属性访问/调用式/可解析标识符（局部/捕获/模块全局）时 → `qz.instanceof_dyn(左, 右)`；**关键修正**：`dynR` 须排除**已知类名**（模块级类亦登记为 moduleGlobals，先前误判为动态 → corpus11/14/15/22 四例回归）。
- **宿主**：`instanceById(obj, clsId)`（抽出 `instanceof_op` 的 @@hasInstance 优先 + 原型链，含**运行时父链** `classRuntimeParent`）；`instanceof_dyn` = 用户类值（`__qzClsId`）→ 运行时链判定；内建函数值 → 按名回退（Array/Object/Function/String/Number/Boolean/Map/Set/WeakMap/WeakSet/Promise/RegExp/Date/Error 族）；两者皆非 → loud（不静默 false）。
- 验证：`const T=Array; [] instanceof T` = true；`{} instanceof Object` = true；`"s" instanceof Object` = false；`const T=P; p instanceof T` = true；`new Final() instanceof Root/Final/A(Root)` = 1/1/1；mixin 结果 `y instanceof T` = true。
- 结果：**708/731（96.9%）**（语料未变——mixin 语料用例另有阻塞：mixin 类字段默认值、类表达式方法捕获外围变量）；31 批 + ctest 32/32 **零回归**。

### 链式 mixin 全通（2026-10-17）
- **根因**：`_emitStaticsGuard` 在类**无静态字段/块**时提前返回 → 声明式类（如 `class Final extends B2(A(Root)) {}`）的动态父链链接（写在 guard body 内）从未发射。
- **修复**：guard 的提前返回条件放宽——`needsDynLink = !!_dynParentExpr(c)` 时即便无静态成员也发射 guard（body 内 `class_value_dyn` 幂等）。
- **验证**：`mixin_chain`（三层链）`x.r()+x.a()+x.b()` = `rab` ✓；`mixin_inst`（声明式动态父类）`(x instanceof Root)+(x instanceof Final)` = `true,true` ✓ + `ra` ✓；`mixin1` = `base,tagged` ✓；普通继承 `pn` ✓。
- 结果：**708/731（96.9%）**（语料未变——mixin 语料用例的 `instanceof <mixin 结果>` 属动态类值判定，仍缺）；全语料 + ctest 32/32 零回归。

### 动态父类构造前建立运行时父链（2026-10-17）
- `new C()`（C 为动态父类）时先发 `_emitStaticsGuard(cname)`，使 statics guard 内的 `class_value_dyn` 链接在构造前执行（此前声明式类从未链接 → 继承方法派发失败）。
- 关键批次回归 + ctest 全绿（零回归）。链式 mixin 仍未通（`class Final extends B2(A(Root))` → `x.r()` loud），下一步需插桩 `class_value_dyn` 确认声明式类 guard 的发射/执行时机。

### 动态 extends（mixin）——运行时父链（2026-10-17）
- **实现**（4 处，零回归）：
  - 发射器：类条目记录 `dynParentNode`（extends 表达式）；`_emitClassValue(c)` 统一类值发射（动态父 → `qz.class_value_dyn(id, 父表达式)`）；两处 super 调用（显式 super / 合成转发）在动态父时改发 `qz.super_ctor(clsId, self, a0..a3)`；`_dynParentExpr(c)` 判定「父非已知类/内建」；`_methodOwner` 遇动态父**不做静态解析** → 退回动态派发。
  - 宿主：`classRuntimeParent: Map<clsId, baseCid>`、`class_value_dyn`（记录 + 以父构造器建原型链，缓存保证 `===`）、`super_ctor`（按 baseCid 转发 `classMeta[baseCid].ctor`）、`chainNext(cc)`（优先运行时父）并替换 **5 处**类链遍历（含 `method_call` 的类方法派发 + `instanceof_op`）。
- **验证**：`class Base{hello()}` + `const Tagged=(B)=>class extends B {tag()}` → `const T=Tagged(Base); new T()` → `y.hello()+y.tag()` = `base,tagged` ✓（继承方法 + 自有方法 + ctor 转发 + 运行时父链全通）。
- **已知缺口**：链式 mixin（`class Final extends B2(A(Root)) {}`）→ `x.r()` 仍 loud「类 3 无方法 r」：`Final` 是**声明式类**，其 statics guard 内的动态链接未执行（插桩显示 `class_value_dyn` 未触发）；单层（类表达式直接作值）已通。另：动态 `instanceof <类值>` 仍 loud（判定需限定「确知类对象」）。
- 结果：**708/731（96.9%）**（语料未变——mixin 用例的 `instanceof` 断言仍缺）；31 批全绿 + ctest 32/32，**零回归**。

### 恢复 `qz.new_dynamic` 宿主方法（2026-10-17）
- **缺陷**：`new_dynamic` 在 QZ 契约表中、发射器亦会发射（类表达式工厂 `const A = maker(); new A()`），但**宿主缺少该方法** → `WebAssembly.instantiate` 报 `function import requires a callable`（该特性此前实际不可用）。
- **修复**：补齐宿主 `new_dynamic(obj, a0..a3)`（类对象句柄 → 经 `__qzClsId` 的 `buildInstance`）。验证：`const mk = () => class { v(){return 7;} }; const A = mk(); new A().v()` = 7。
- **动态 `instanceof` 再次尝试后回退**：按「右操作数可解析为局部/捕获/模块全局/属性访问」过于宽泛（内建/非类值场景被误判）→ 4 例回归（corpus11/14/15/22）→ 已回退（保留 `new_dynamic`）。重做要点：判定需限定为**确知的类对象**（如仅有 `__qzClsId` 的宿主类值），并保留 loud 兜底。
- 结果：**708/731（96.9%）**；无回归。ctest 32/32。

### 属性赋值含副作用接收者（放宽 loud，2026-10-17）
- **根因**：`o.f = v` 当接收者带副作用（`(deep.a ??= {}).b = 1` / `(o.a = {}).b = 2`）时一律 loud「求值顺序未实现」；但 JS 顺序差异**仅当 RHS 也带副作用时**才可观察。
- **修复**：改为**仅当接收者与 RHS 都带副作用**才 loud（保守保留真顺序依赖场景）；RHS 无副作用时按现有顺序（RHS → 接收者求值 + 写）——语义等价。
- 验证：`(deep.a ??= {}).b = 1` = `{"a":{"b":1}}`；`(o.a = {}).b = 2` = `{"a":{"b":2}}`；`(o.a = {})[n++] = 3` = `{"a":{"0":3}}1`（元素访问走既有 obj→key→v 顺序）；`o.a.b = 1` 不变。
- 结果：**708/731（96.9%）**；corpus30 16→17/20。ctest 32/32。

### 可迭代对象解构（静默错值修复，2026-10-17）
- **根因**：数组解构（`const [p, q] = …`）只处理 wasm 数组(0x7FFB)与字符串(0x7FFA)，其它可迭代（Set/Map/自定义 `[Symbol.iterator]`/类实例）直接按索引读 → **静默 undefined**。
- **修复**：两处数组解构路径（`_emitBindingDecl` 的绑定声明 + `_emitDestructurePattern`）在解构前按 tag 归一化——非 wasm 数组/字符串 → `qz.iter_array`（宿主手写迭代协议）收集为数组，再按索引/`slice` 解构（与 JS「解构走 Iterator」一致）。
- 验证：`const [p,q] = new R(5)`（自定义 @@iterator）= `0,1`；`= new Set([7,8])` = `7,8`；`const [[k,v]] = new Map([["a",1]])` = `a:1`；字符串/数组/对象解构不变。
- 结果：**707/731（96.7%）**；corpus30 15→16/20。ctest 32/32。

### 展开调用指向闭包（模块级 const 箭头）（2026-10-17）
- **根因**：`_emitSpreadCall` 的闭包回退分支只查 `capMap`（捕获）/ `_local`（局部）→ 模块级 `const sum = (...a) => …` 的 `sum(...n)` 报 loud「未定义函数: sum」。
- **修复两处**：
  - 发射器：闭包回退分支补查 `moduleGlobals`（`M.globalGet`）→ 句柄入槽 → `qz.closure_call_spread`。
  - 宿主 `closure_call_spread`：`meta.rest` 时按惯例打包为 `[固定参…, rest 数组]`（此前把数组**摊平**成位置实参 → 形参拿到单值 → `a.reduce` 报「数值无方法 reduce」）。
- 验证：`sum(...[1,2,3])` = 6、`sum(1,2)` = 3、`sum()` = 0；`const g=(x,...a)=>x+":"+a.join("-")` 的 `g(1,...[2,3])` = `1:2-3`、`g(...[9])` = `9:`；非 rest 的 `g(...[3,4])` = 7（不变）。
- 结果：**706/731（96.6%）**（isolated 修复，语料未新增覆盖）；ctest 32/32。

### rest 闭包形参（箭头 const）+ `fn(...restArr)`（2026-10-17）
- **惯例（实测确立）**：rest 闭包的调用方传 `[固定参…, rest 数组, 余参…]`（`function g(first, ...rest)` 实测 a0=固定参、a1=rest 数组）。
- **根因**：`closureCall` 的简单分支（≤4 实参）用 `slice(0, 1+meta.n)` 只传固定参 → `const c = (...a) => a.length` 得 `undefined`（形参拿到单值而非数组）；`fn(...a)`（a 为 rest 形参）报 `toJS(...) is not iterable`。
- **修复**：新增 `else if (meta.rest)` 分支，按「`a[nFix]`（nFix = meta.n-1）是否为 wasm 数组(0x7FFB)」精确判定是否**已打包**：已打包 → `[blk, 固定参…, rest 数组]` 透传；未打包（箭头 const 被直接调用）→ 固定参 + 剩余打包 `arrWriteback`。
- **前两轮失败原因**（记录留档）：用 `meta.n === 1` + 全部槽为空判定（过窄，含固定参的场景漏判）→ 回归；用 `a0` 是数组判定（未对齐 nFix 位置）→ 回归。正确判据是**按 nFix 定位槽位**。
- 验证：`const c=(...a)=>a.length` = 3（原 undefined）；`(x,...a)=>x+":"+a.join("-")` = `1:2-3|9:`；`fn(...restArr)` = 7；`function c(...a)` 不变。
- 结果：**706/731（96.6%）**；corpus29 14→15/20、corpus30 14→15/20。ctest 32/32。
- 已知窄面（新）：rest-only 闭包被单个**数组实参**调用（`c([1,2])` → 得 `2:number`，JS 为 `1:object`）——与「已打包」不可区分；另 `sum(...arr)`（模块级 const 箭头 + 数组变量展开）仍 loud「未定义函数: sum」。

### 对象字面量计算属性名插入序（静默错值修复，2026-10-17）
- **根因**：属性循环中计算键**先**逐个登记序（`qz.field_order`），而静态键的批量登记（`field_order_lit`，编译期常量）在循环**之后**执行 → 计算键被挤到键序最前。
- **修复**：`hasComputedKey` 时改为**逐属性按源码序**登记（静态键在自身槽位写完后 `field_order`；计算键沿用原路径），并跳过批量 `field_order_lit`（避免重复）。
- 最小复现（已修）：`const key = "dyn"; const o: any = { a: 1, [key]: 2, z: 3 };` → 现为 `{"a":1,"dyn":2,"z":3}` / `a,dyn,z`（此前 `{"dyn":2,"a":1,"z":3}` / `dyn,a,z`）。
- 结果：**704/731（96.3%）**；corpus31 17→18/18。ctest 32/32。

### 第三十一批差分审计（2026-10-17）
- 新增 `audit_corpus31.js`（18 例：嵌套矩阵/转置/三维 flat、正则进阶（量化/捕获/exec 循环/回调替换）、错误处理矩阵（多级 Error 子类/非 Error 抛出/finally）、数值边界 2、Unicode 与编码（encodeURIComponent/代理对/codePointAt）、类静态进阶（静态方法 super/静态 getter/static 继承）、函数参数边界（默认值/5 参/spread 应用）、可迭代类模式、getter 与计算键混合、sort 比较器边界、闭包递归（factorial/gcd/flatten/pow）、Map/Set 进阶（构造自 Map/Unicode）、字符串管线（slugify/titleCase/pad）、稀疏数组进阶、对象工具实现（pick/omit/invert/groupBy/uniqBy/countBy）、真值强制转换矩阵、高阶函数（pipe/compose/curry/partial/memoize/once）。
- 结果：**703/731（96.2%）**；corpus31 17/18。ctest 32/32。
- **新增 1 项残余（真 silent 错值）**：**对象字面量中计算属性名的插入序排在静态键之前**（JS 保持源码序）。最小复现：`const key = "dyn"; const o: any = { a: 1, [key]: 2, z: 3 };` → 本实现 `JSON.stringify(o)` 得 `{"dyn":2,"a":1,"z":3}`、`Object.keys(o)` 得 `dyn,a,z`；JS 为 `a,dyn,z`。线索：`fields` 表无 `dyn` → 计算键走**先于静态字段写**的独立发射路径（疑似预遍历里先发射计算键）。

### 第三十批差分审计（2026-10-17）
- 新增 `audit_corpus30.js`（20 例：mixin 类工厂、ES2023 数组方法（toSorted/toReversed/with）、Object.getOwnPropertyDescriptors/冻结深、私有品牌检查（`#x in obj`）、自定义迭代器协议（含 return()）、嵌套箭头 this、静态初始化序、Error 子类 instanceof、JSON 边界（`__proto__`/循环/日期）、柯里化类工厂、可选链与逻辑赋值混合、稀疏洞 vs undefined、getter/setter 对、展开求值顺序、闭包计数器/memoize、字符串方法矩阵、数值格式化、四层继承链、真实数据管线、try-finally 实战）。
- 结果：**686/713（96.2%）**；corpus30 14/20。ctest 32/32。
- 新增 6 项残余（多为真 bug）：
  - **箭头 const 的 rest 形参不解包**（真 bug，高价值）：`const c = (...a:any) => a.length` → `undefined`（`function c(...a)` 正常 3）；`collect(1,2,3)` 内 `a.join` 报「数值无方法 join」→ `_emitOvfParamUnpack` 只在方法/构造器/静态方法处调用，**未在 `_emitLambdaBody` 调用**（`$ovfArg` 预留 local 亦缺）。
  - **`fn(...restArr)` 展开展开**：`fn(...a)`（a 为 rest 形参）报 `toJS(...) is not iterable`（真 bug）。
  - **动态 extends（mixin）**：`class Final extends Counted(Tagged(Base))` → `call 未定义: __m_Base2$ctor`（把 extends 的**运行时表达式/形参名**当类名）。
  - **`instanceof <动态类值>`**：`m instanceof Mid`（Mid 由 mixin 得到）→ loud「instanceof 右操作数须为用户类」。
  - **可迭代对象解构**：`const [p, q] = new Range(10, 20)` → 未走迭代器协议（空）。
  - **副作用接收者的复合赋值**：`(deep.a ??= {}).b = 1` → loud「属性赋值中 o 带副作用：求值顺序未实现」；另 Error 子类 `Error.prototype.toString` 文本（窄面）。

### 类表达式作值 + 动态 new（2026-10-17）
- **类表达式作值**（此前 loud「不支持的表达式: ClassExpression」）：`emitTaggedExpr` 新增 ClassExpression 分支 → 经 `clsExprMap` 取合成类名 → `qz.class_value(id)`；`const C = class {...}; typeof C` 得 `function`。
- **动态 new**（此前 loud「new 未知类: A」）：`new X()` 当 X 非编译期已知类但可解析为局部/捕获/模块全局/属性访问时 → 求值出**类对象**（类表达式工厂 `const A = makeClass(); new A()`）→ `qz.new_dynamic(classObj, a0..a3)`（宿主按 `__qzClsId` → `buildInstance`）。参数序 `obj, a0..a3`（obj 先求值入槽）。
- **已知限制**：类表达式**方法体捕获外围局部变量**（`const make = (label) => class { get label() { return label; } }`）→ loud「未定义捕获变量: label」（类方法未接外围 env）。`instanceof <动态类>` 亦未支持（loud）。
- 结果：**672/693（96.9%）**（本批未改变语料计数，属能力扩展；无捕获的类表达式工厂 + 动态 new 已通）。ctest 32/32。

### 类原型方法挂载与提取语义（2026-10-17）
- **`C.prototype.m`**（此前 undefined，`Object.getOwnPropertyNames(C.prototype)` 漏报）：`class_value` 构造类对象时把**实例方法**（含 `>4` 形参的 4 槽 ABI）与**访问器**（get/set → `__m_<C>$<name>` / `$set`）挂到 prototype 对象上；方法体内 `this` 经 `bitsOf(this)` 还原为 wasm 句柄。
- **实例物化对象的原型**指向类 prototype（`Object.getPrototypeOf(new C()) === C.prototype`，此前为 `Object.prototype`）。
- **提取的类方法尊重 `.call/.apply` 的 thisArg**：包装器优先用 JS `this`（`bitsOf(this)`），仅当 `this` 为 undefined/null 时回退到提取时的接收者 → `const g = m.get; g.call({v:7})` 得 7（此前 42）。
  - 注：`(...args, _t)` 非法（rest 必须是最后形参），改用 `function (...args)` + JS `this`。
- 结果：**672/693（96.9%）**；corpus29 13→14/20。ctest 32/32。

### 模块全局在闭包内按调用时读取（修复自递归/互递归箭头 const，2026-10-17）
- **根因**：模块级 `const f = (n) => … f(n-1) …` 的闭包把 `f` 按**创建时值**捕获（`f` 此时未赋值 → undefined）→ 运行时 `closure_call` 拿到 undefined 句柄 → `未知 funcidx 0`。
- **修复**：`_capturesOf` 排除**模块级全局**（`moduleGlobals`）→ 闭包体内对 `f` 的引用改走 `_emitCapturedRead` 的全局分支（`globalGet`）→ 调用时读取 → 自递归/互递归箭头 const 正确。
- 结果：**671/693（96.8%）**；corpus29 12→13/20。ctest 32/32。
- 已知窄面：箭头 const 深递归经 `closure_call` 走宿主 JS 栈 → `sumTo(500)`/`depth(200)` 触发「Maximum call stack size exceeded」（`function` 声明版走 wasm 直递归 → 正常）。

### 第二十九批差分审计（2026-10-17）
- 新增 `audit_corpus29.js`（20 例：类值/原型链深化、闭包捕获 this、高阶函数与互递归、sort 稳定性、浮点累加、Object.prototype.toString 与 Symbol.toStringTag、String.raw、Array.from 与迭代器、原型 getter/setter 继承、delete 语义、JSON toJSON、递归深度、trampoline/柯里化、对象字面量 super、类表达式名、私有静态 + static 块、原型方法提取、模板字符串进阶、位运算边界、端到端真实程序）。
- **修复（静默错值）**：类自定义 `toString`/`toLocaleString`/`valueOf` 此前被 `method_call` 的 Object.prototype 默认快捷分支遮蔽（类方法从不执行，返回 `[object Object]`）→ 先沿类原型链查自有方法，命中则直接派发 wasm 方法。
- 结果：**670/693（96.7%）**；corpus29 12/20。ctest 32/32。
- 新增 8 项残余（1 例修复后仍存 8 项）：
  - **真 bug（2 项）**：自递归/互递归**箭头 const**（`const f = (n) => n ? f(n-1) : 0`）走 interp 路径报 `closure_call 未知 funcidx 0`（`function` 声明版本正常）；提取的原型方法 `.call/.apply`（`const g = m.get; g.call(m)`）报「无方法 call」。
  - **loud（4 项）**：类计算属性名访问器（`get [Symbol.toStringTag]()`）；对象字面量内 `super`；类表达式工厂（`const A = makeClass(); new A()`）；标签模板 `strings.raw`。
  - **窄面（2 项）**：内建类作值（`Object.getPrototypeOf(A) === Function.prototype`）。

### Reflect.construct + 类 static {} 块内 this（2026-10-17）
- **`Reflect.construct(用户类, args)`**：宿主 builtin 特殊化——识别类对象（`__qzClsId` 标记）→ `buildInstance` 分配 wasm 实例（`[0]=__cls`、`[4]=size`、字段槽填 undefined）+ 调 `__m_<C>$ctor`；`classMeta` 补 `ctor`/`size` 字段（size 与 `_instSize` 一致）。**初版漏写 `[4]=size` 与字段槽清空 → 字段读 undefined，已修**。
- **类 `static { }` 初始化块内 `this` ≡ 定义类**（此前 loud「this 仅在类方法/构造器内可用」）：`_emitStaticsGuardBody` 期间设定类上下文（`_curClassObj` + `_inStaticMethod`）→ `this.x = v` 走 `qz.static_set`、`this.x` 读走静态路径、`this` 作值 → `qz.class_value`（类对象）。
- 结果：**658/673（97.8%）**；corpus28 19→20/21。ctest 32/32。

### 类名作值 + 静态 super 调用（2026-10-17）
- **类名作值**（此前 loud「类名作值未实现」）：新增宿主 `qz.class_value(clsId)` —— 惰性构造并**缓存** JS 构造器对象（clsId 键，保证 `===` 同一）；`Object.setPrototypeOf(ctor, 父类对象)` 复刻静态继承链；`ctor.prototype = Object.create(父类.prototype)` + `constructor` 非枚举属性（复刻实例原型链）；静态方法（含 `@@hasInstance` → 挂真 `Symbol.hasInstance`）与 `name` 一并挂载；`classMeta` 补 `name` 字段。
- **`C.prototype`**：静态成员访问路径新增 `prototype` 分流 → `class_value(C)` 后宿主取 `prototype`（此前按静态字段查 → undefined）。
- **实例 `.constructor`**：属性读新增 tag 守卫分支（0x7FFE 实例 → 类对象；否则退回宿主 `prop_get`），JS 语义 `new B().constructor === B`。
- **静态 `super.m()`**：`super` 调用解析此前只查实例方法表（父类仅有静态方法 → loud「在父类链上未定义」）→ 改为先查实例方法、再查 `staticMethods`，命中静态则 `_emitStaticsGuard` + self 占位直调 `__sm_<Owner>$<m>`。
- 结果：**657/673（97.6%）**；corpus23 19→20/20、corpus27 17→18/21、corpus28 18→19/21。ctest 32/32。
- 已知窄面：内建类作值（`"x".constructor === String`）未支持（仅用户类）。

### 数组自定义字符串键属性（最后一项 silent 错值修复，2026-10-17）
- **根因**：`a["k0"] = v`（wasm 数组 + 非数字键）在 `setIndexImpl` 落到兜底 `toJS(o)[toJS(k)] = v`——写的是**物化副本**，原件丢失；`a.k0` 亦读不到；`Object.keys` 漏报。
- **修复**（复用既有 `arrMeta` 旁表，与正则 `exec`/`match` 的 `index`/`input` 读取路径一致）：
  - `setIndexImpl`：wasm 数组 + 非索引字符串键 → `arrMeta[off][k] = v` + 插入序表 `orderMap`（`Object.keys`/`for-in` 用）；数字形态字符串键仍按索引写（`a["0"] ≡ a[0]`）。
  - 宿主 `builtin`：`Object.keys`/`values`/`entries`/`getOwnPropertyNames`（接收者为 wasm 数组）→ 索引键 + 自定义键；**稀疏洞不计入** `keys/values/entries`（`getOwnPropertyNames` 含洞与 `length`，均与 JS 一致）。
  - 初版误加 `prop_get` 数组分支屏蔽了既有 `arrMeta` 读取 → 正则 `index`/`input` 回归，已撤回。
- 结果：**654/673（97.2%）**；corpus28 17→18/21。ctest 32/32。
- **至此无已知 silent 错值**：残余 19 例全部为 loud（编译期显式报错）或已知窄面（文本表示/外质对象等），见 ASSESSMENT.md。

### 数组 push/pop 快路径误命中同名方法（静默错值修复，2026-10-17）
- **根因**：`x.push(单个实参)` / `x.pop()` 的编译期快路径（`_emitArrayPush`/`_emitArrayPop`）**无条件命中**，未校验接收者是否为 wasm 数组——对象字面量/类实例上的同名方法 `o.push(x)` 被当作数组直写：把 POJO 句柄当数组头写入（`i32WrapI64` 后按 header 结构读写），**方法体从未执行**，另一闭包读到的数组不变（最小复现 `{push:(x)=>a.push(x), get:()=>a}` → `o.get().length` 得 0，应为 2）。
- **修复**：快路径加**运行时 tag 守卫**——接收者只求值一次存入局部，`hi==0x7FFB`（wasm 数组）才走内存直写，否则退回 `_emitDynMethod` 通用派发；守卫的 `if` 块计入 `this.depth`（分支内含 errCheck/短路等 br 标签，否则 wasm 校验失败）。
- `_emitArrayPush`/`_emitArrayPop` 新增可选 `hv` 形参（调用点已求值的句柄 local），避免接收者二次求值。
- 结果：**653/673（97.0%）**；corpus28 16→17/21（`closure-memory-leak-safe` 由 silent 错值转为通过）。ctest 32/32。
- 残余仅余 1 项 silent：数组自定义字符串键属性（`arr["k0"]=v` 不存不读、Object.keys 漏报）。

### 第二十八批差分审计（2026-10-17）
- 新增 `audit_corpus28.js`（21 例：Map/Set 全方法、Object freeze/seal/preventExtensions、Reflect construct/ownKeys/getPrototypeOf、String matchAll/substring/substr/slice/localeCompare、Math 三角与常量、JSON replacer/reviver、Symbol for/keyFor/description、catch 无绑定、数组 reduceRight/keys/values/entries、动态键赋值、类 extends + super 构造、嵌套 try-catch-finally-throw、Number 常量与强制转换、数组 concat/spread/flat 嵌套、RegExp sticky/advance flags、String repeat/pad/compare、闭包栈/计数器/memoize、对象方法链深、类 static block、三元链与短路）。
- 结果：**652/673（97.0%）**（新增 16 例 match，5 diff）。ctest 32/32。
- 新增 5 项残余：
  - **loud**：类名作值（Reflect.construct / Object.getPrototypeOf(Dog.prototype)）×2。
  - **loud**：类 `static { }` 初始化块内 `this`（当前报「this 仅在类方法/构造器内可用」）。
  - **silent（待修）**：数组自定义字符串键属性（`arr["k0"]=v` 不存不读；Object.keys 漏报）。
  - **silent（待修）**：**对象字面量方法闭包不共享 env**——`{ push: ()=>items.push(x), size: ()=>items.length }` 各方法得独立 env 快照，push 的变异 size 不可见（顶层独立闭包共享正常；对象字面量方法不共享）。

### Symbol.hasInstance 修复（2026-10-17）
- **修复：`x instanceof C` 当 C 有 `static [Symbol.hasInstance]` 此前仅查原型链 → 静默错值**（`4 instanceof Even` 返 false 而非 true）。
  - emitter `classMeta` 新增 `staticMethods` 字段（与 `methods` 同构：`{name: 导出名, n: 参数量}`，仅普通方法，不含 accessor）。
  - 宿主 `instanceof_op` 在原型链检查**前**沿继承链查 `staticMethods["@@hasInstance"]` → 调 wasm 静态方法 `__sm_<C>$@@hasInstance(TAG, obj, TAG, TAG, TAG)` → tagged bool。
  - JS `[[HasInstance]]` 语义：`@@hasInstance` 优先于 `OrdinaryHasInstance`（原型链查）。
- 差分审计数字不变（636/652，97.5%）——`instanceof-custom-hasinstance` 案仍按 fn-toString 窄面计为 diff（instanceof 行为已正确，仅函数入数组 join 的 toString 取物化包装器源）。ctest 32/32。
- **消除全部已知静默错值**（for-of 急切快照 + Symbol.hasInstance 均已修；残余 16 例全部 loud 或已知窄面）。

### 第二十七批差分审计（2026-10-17）
- 新增 `audit_corpus27.js`（21 例：类 super 方法/静态继承/getter-setter 副作用/计算属性 Symbol/私有字段、JSON 边界值（undefined/NaN/Infinity/函数）、RegExp 标志与捕获、运算符边角（**=/复合赋值/链式比较/0.1+0.2）、Error 子类 cause、解构默认值与 rest、spread 混用调用、Object.create 原型链、getter 链、try-finally-return 交互、Symbol.hasInstance instanceof、数组方法链、模板字符串强制转换、闭包捕获变异、in 运算符类型、Number 方法边界、Object.keys/entries/values 往返）。
- 结果：**636/652（97.5%）**；ctest 32/32。
- 新增 4 项残余（按语料案例）：
  - **loud**：类名作值（静态 getter 跨类继承 `Derived.val` / `Object.getPrototypeOf(Derived) === Base`）——已知边界。
  - **loud**：类实例上 `[Symbol.iterator]()` 计算属性方法访问（类收集为 @@iterator 但运行时实例访问未通）。
  - **narrow**：`Object.create(Array.prototype)` 后手动设 `.length` —— 非数组外质对象，物化副本不回读手动 length（Array.isArray 仍正确返回 false）。
  - **silent（待修）**：`x instanceof C` 当 C 有 `static [Symbol.hasInstance]` —— `instanceof_op` 仅查原型链，未调 `Symbol.hasInstance` 静态方法；同例函数入数组 join 的 toString 取物化包装器源（窄面）。

### 第二十六批差分审计（2026-10-17）
- 新增 `audit_corpus26.js`（21 例：字符串搜索方法（startsWith/endsWith/includes + 第 2 实参）、pad/repeat/trim、replace/replaceAll 回调、at/charCodeAt/codePointAt、数组 at/flat/flatMap、splice/reverse/fill/slice、findLast/includes(NaN)/sort 比较器、Object.fromEntries/getOwnPropertyDescriptor/defineProperty(s)/getOwnPropertyNames（含非枚举）、Object.assign 源 getter、Reflect 基础、运算符强制转换矩阵、可选链调用、delete/void/逗号、标签 break/continue、switch(true) 模式、数值边界（EPSILON/MAX_SAFE/0.1+0.2/取整）、Math.hypot/atan2/展开 max/min、toString/join 链、copyWithin、Symbol.toPrimitive 强制转换）。
- **修复 3 项（均为静默错值）**：
  - **String `startsWith`/`endsWith`/`includes` 第 2 实参**（fromIndex/endPosition）此前被丢弃 → 静默错值；补 `givenSlot(a1)` 分支传 `Number(arg(a1))`。
  - **`Object.defineProperties` 对 POJO/实例**此前走原生 `Object.defineProperties`（物化副本）→ `getOwnPropertyNames`/`Object.keys` 静默漏报新键 → 改为就地注册（与 `Object.defineProperty` 同路径：内存槽/extras + nonEnum + propFlags）。
- 结果：**619/631（98.1%）**；ctest 32/32。残余 12 例（全部 loud 或已知窄面）。

### for…of 惰性迭代（2026-10-17）
- **修复：`for…of` 此前急切快照（`iter_array` 一次性收集为 wasm 数组）→ 与 JS 惰性语义不符**（迭代期间 `push`/`delete` 不可见；自定义迭代器的 `next()` 一次性消费）。改为逐次 `next()` 驱动：
  - wasm 数组（0x7FFB）：按索引直读，**长度每轮重读**（迭代期间 `push`/`delete` 可见）。
  - 字符串：经 `str_chars` 转码点数组后走数组路径。
  - 宿主可迭代（Set/Map/自定义 `[Symbol.iterator]`/迭代器对象）：新宿主 `qz.iter_new`/`iter_pull`/`iter_val`/`iter_close`——`iter_new` 建立 `{it, val}` 状态句柄，`iter_pull` 调 `it.next()` 返回 done-flag（BigInt），`iter_val` 取当前值；**正常完成与 break 时调用 `iter_close`→`it.return?.()`**（JS 迭代协议要求关闭）。
  - 条件/元素加载按句柄 tag（0x7FFB vs 其它）分支；`if/else` 统一为 i32 done-flag 后单一 `brIf`（避免 br-in-if 的深度错位）。
- **消除最后一项已知静默错值**（for-of 急切快照）；差分审计 **598/610（98.0%）**；ctest 32/32。
- 已知窄面（非静默）：`for…of` 中 `break` 调 `it.return()` 在「对象字面量 `[Symbol.iterator]` 返回带 `return` 的迭代器」场景下 `closed` 未记录（迭代器物化丢失 `return`）；`Array.prototype[Symbol.iterator]()` 直接取用未支持（loud）。

### 第二十五批差分审计（2026-10-17）
- 新增 `audit_corpus25.js`（20 例：Math 扩展（imul/clz32/fround/sign/trunc/exp/log 系列）、数字判型（isInteger/isNaN/isSafeInteger）、正则 lastIndex 显式设置与捕获组、split 捕获组、展开字符串与 Set、整数键对象键序、稀疏数组方法、concat 与展开混用、switch let 作用域、for-comma 与嵌套三元、Object.is vs ===、parseInt/parseFloat/Number 异常输入、getter 返回函数被调用、throw 非错误值、嵌套对象 getter 链、Array.from 字符串/类数组、字符串索引与 charAt、提取方法经 .call/.apply/.map、布尔/数值装箱方法、for-in vs for-of 对象）。
- **修复 6 项（含 2 项静默错值）**：
  - **Number.prototype 方法**（toString/toFixed/valueOf/…）此前「无方法 toString」→ 顶层 method_call 新增数值分支。
  - **Boolean.prototype toString/valueOf**：布尔句柄经 bitsToNum 得 NaN → 新增 BOOL_HI 前置分支。
  - **提取的类方法经 .call/.apply/.map(thisArg)**：包装器 args.map(bitsOf) 遇 undefined 抛 Cannot convert BigInt → 过滤 undefined/null + TAG 补位。
  - **closureCall 宿主函数分支**此前丢弃 receiver：[1].map(obj.m, obj) 中 this 为 undefined → hf.apply(toJS(recv), args)（静默错值修复）。
  - **for...in 此前仅自有键**（Object.keys）→ JS 含继承可枚举键；改走 Object.keysIn（宿主原生 for-in 收集）。静默错值修复。
  - **类 getter 作被调目标 x.p()**：静态快路径直接调 getter（返回其返回值未再调用）→ 静默错值；getter/setter 走动态路径 + 新增 _hasAccessor(get) 分支：prop_get + _emitValueCall(..., recv=rx)。
- **_emitValueCall 新增 recvExpr 形参**（getter 返回值/方法值调用时把 receiver 传给闭包）。
- 结果：**598/610（98.0%）**；ctest 32/32。残余 12 例（11 loud + 1 窄面静默 for-of 急切快照，待惰性迭代改造）。

### 第二十四批差分审计（2026-10-16）
- 新增 `audit_corpus24.js`（21 例：Math 特殊值（无参 min/max、字符串/布尔参与）、数组方法链、**泛化数组方法**（Array.prototype.join/map/push/slice.call 于 array-like）、位运算边界、typeof 矩阵、解构进阶、in 运算符边界、展开实参 + rest、switch default 非尾、void/一元边界、类私有跨方法、matchAll/替换回调、对象键序与数组索引、JSON 嵌套转义、reduce 无初值、默认参数闭包、数组解构返回、字符串 Unicode 比较、方法链 fluent、对象展开字面量序、复合循环）。
- **修复：`typeof <类表达式>` → "function"**（此前 loud「不支持的表达式: ClassExpression」）。
- **已知窄面差异（已记录）**：`[].reduce(f, undefined)`（显式 undefined 初值）——ABI 无法区分「显式 undefined」与「缺参」，本实现按缺参处理抛 TypeError（JS 返回 undefined）；仅显式-undefined 场景偏差。
- 结果：**577/590（97.8%）**；残余 13 例 = 12 loud + 1 窄面静默（for...of 快照）。

### 第二十三批差分审计（2026-10-16）
- 新增 `audit_corpus23.js`（20 例：新数组方法 at/findLast/toReversed/toSorted/toSpliced/with、Object.fromEntries 与可迭代、**Map/Set 迭代期间并发修改**、getter 抛错传播、原型遮蔽、delete 与稀疏数组、深可选链/空值合并、字符串+数字混合运算、模板标签求值顺序、JSON 格式化细节、instanceof 边界、switch 表达式 case、Object.create 变体、Number 方法矩阵、复合 while、循环变量闭包、嵌套展开与修改、字符串转义、可变闭包单元格）。
- **新发现静默差异（已记录）**：`for...of` 走 `qz.iter_array` 的**急切快照**（一次性转 wasm 数组）→ 迭代期间对 Map 的增删作用于快照；JS 迭代器惰性（删除项被跳过）。仅「迭代+并发修改」模式偏差（`map-mutate-during-iter`）。
- 结果：**557/569（97.9%）**；残余按语料案例 12 例（含 1 项新建静默差异、其余 loud）。

### 顶层函数作值 —— 收尾（2026-10-16）
- `fn.prop = 5` 读回 0 的根因：`_emitStoreProp` 的顶层函数分支读取值槽 `t.w` 前**未先 `localSet(t.w)`**（值入槽只发生在其它分支）→ 写入宿主属性的值是残留的 0/undefined。补一行后探针 `corpus_fv.js` **3/3**（`arr.map(namedFn)` / 别名 / `fn.prop` 全一致）。

### 顶层函数作值 + 模块级语句执行（2026-10-16）
- **顶层函数作值**：`[1,2,3].map(namedFn)`、`const h = fn; h()`、`fn.call/apply/bind` 与 JS 一致。`qz.fn_value(nameId, arity)` 把顶层函数包装为宿主函数句柄（按 arity 补 TAG、同名缓存）；`closureCall` 支持宿主函数句柄（只传真传实参）；函数名接收者的属性写走 `qz.prop_set`（此前内存快路径把句柄低 32 位当地址 → 静默越界）。探针 `corpus_fv.js` 2/3（`fn.prop` 再读回得 0，待查）。
- **模块级非声明语句执行（静默 bug 修复）**：`__module_init` 此前只收集变量语句 → 模块级副作用（`fx.extra = 5`、表达式/if/for/try 语句）被**静默丢弃**；现纳入 init（排除 function/class/interface/type/module/import/export/enum 声明）。
- 分项验证：`test_aot` 233 ALL PASS；corpus13/7/21/10 无回归。

### 第二十二批差分审计（2026-10-16）
- 新增 `audit_corpus22.js`（19 例：默认参数间依赖、原型链 + `Object.create`、类字段/静态块顺序、正则分组与标志、错误链与 finally、Map/Set 对象键、迭代协议（Map/Set/entries/解构循环）、描述符与原型、字符串比较与排序、模块模式闭包、Math 取整与浮点、**逻辑赋值 `||= &&= ??=`（字段/索引）**、类继承覆写与 `super`、数组聚合、复杂 switch、循环内 try/finally+continue、`toJSON`/replacer、多键排序、函数形参嵌套解构）。
- **修复：`||=` / `&&=` 支持字段/索引目标**（此前按标识符处理 → `_emitVarStore(undefined)` → loud `未定义变量: undefined`）；与 `??=` 同款（接收者读+写各求值一次，带副作用则 loud）。探针 `corpus_la.js` **4/4**。
- **新暴露 loud（已记录）**：① 顶层函数作值（`arr.map(namedFn)` / `fn.prop` / `const h = fn`）——原型已写并验证别名场景，剩回调约定与属性身份两处；② 模块级对象含访问器/方法（start 段 `mem` 未绑定）。
- 结果：**539/549（98.2%）**；残余按语料案例 10 例，**全部 loud（零已知静默）**。

### 内建调用 >4 实参（2026-10-16）
- `qz.builtin` 增第 7 参 `ovf`（实参 3..，与 `call_value`/`method_call` 同款约定）；`_emitBuiltinCall` 统一「4 槽 + ovf」；宿主按 `[a0..a3].concat(ovf.slice(1))` 重建实参后按 `arity || n` 截断。
- 移除「内建调用超过 4 个实参」loud：`Math.max(1,9,3,4,5)`、6 实参等与 JS 一致（探针 `corpus_b5.js` **3/3**）。
- 结果：**522/530（98.5%）**；残余按**语料案例**计 8 例，全部 loud（零已知静默）。

### 键序（Key order）修复 —— 已知静默清零（2026-10-16）
- **根因**：宿主 `qz.builtin` 的 `Object.assign` 专用**就地合并**分支逐个写槽/`extras`，但**从不登记键序** → 目标对象物化时键序退化为槽序（fieldMap 序）→ `Object.assign({}, {d:4}, over)` 得 `a,b,c,d`（JS `a,b,d,c`）。
- **修复**：合并时按 JS 规则登记键序（已存在键保持原位、**新键追加**）。
- **配套（同类问题闭环）**：① 新增 `qz.order_note(i64 off, i32 strId)` —— 键取 `strings[sid]`，**不触内存**，故 start 段（`__module_init` 期间宿主 `mem` 尚未 `bindMem`）也能登记模块级对象键序；emitter 编译期计算模块级 const 的**静态键序**（`modObjKeys`，对象字面量 + 对已知 const 的展开；无法静态定序则跳过）；② 展开路径补 `qz.spread_order(dst, src)`（按源键序表/物化视图补登记）+ 对**显式属性**发 `qz.field_order`（此前只写槽不登记序）；③ `qz.field_order`/`spread_order` 在 `!mem` 时安全 return。
- 验证：`corpus_oa3.js` **3/3**、`audit_corpus21.js` **18/18**；`test_aot` 233 ALL PASS。
- 结果：**522/530（98.5%）**，残余 7 项**全部 loud** —— **零已知静默差异**。

### 方法 >4 形参 / rest（对象字面量方法，2026-10-16）
- **宿主对象方法分支**：`method_call` 的宿主对象路径把 `ovf` 的实参 4.. 接在 4 槽之后（`fn.apply(obj, as)`）——此前只传 4 槽，第 5 个实参丢失（rest 求和少一项）。
- **物化方法包装器**：`object_set_method` 的 `obj[k] = function(...args)` 现转发 `ovf`（`args.slice(3)` → 第 6 参）→ 否则 `closureCall` 收到 `hasEx=false`，rest 数组缺失、`for...of` 报「该值不可迭代」。
- 验证：探针 `corpus_rest.js` **4/4**；`test_aot` 233 ALL PASS；21 批语料无回归。
- 残余 loud 由 8 项降为 **7 项**（类与方法 >4 形参已支持）。

### 方法 >4 形参 / rest 形参（类路径，2026-10-16）
- **方法签名**：类方法与静态方法在形参 >4 时追加第 6 槽 `ovf`（实参 3.. 数组，与闭包 ABI 同款约定）；`_emitMethodArgs` 统一「前 4 槽 + ovf + rest 打包」。
- **关键修复**：`params` 计算须为「前 4 个实参形参 + 补位 + `$ovf`」（此前把实参 4.. 的名字也留在参数表 → `nParams` 多 1 → scratch/sT/objPool 全体错位，wasm 校验报 `expected [f64] but got [i64]`）。
- **宿主**：类方法路径按 `m.n`/`m.rest` 重建平坦实参并把 ovf 交回第 6 槽；`flat` 统一 tagged，`arrWriteback` 只收 JS 值；rest 数组落在其形参槽（`[recv].concat(head,[restArray])` 补足 5 槽）；`classMeta.methods[name]` 增 `rest`。
- **合成方法箭头**：`_memberLambda` 显式标 `_qzRest`（合成形参表丢 `dotDotDotToken`）→ `lamMeta.rest` 用上。
- 效果：类方法 **5 形参**、类方法 **rest + 5 实参** 与 JS 一致（探针 `corpus_rest.js` 3/4；仅对象字面量方法的 rest 未通）。
- 结果：**521/530（98.3%）**（本次为能力新增，21 批语料无回归）。

### 宿主数组句柄统一（2026-10-16）
- **宿主数组保持宿主句柄**：`object_get` / `prop_get` 对宿主对象的数组字段改返回 `tagHandle(jsArray)`（此前经 `ret` → `arrWriteback` 转 wasm box）→ 元素读/写经 `get_index`/`set_index` **就地**作用于真实 JS 数组。
- **宿主来源数组的句柄别名**：`ret` 对宿主数组按 `WeakMap`+bump 世代缓存（`arrOfHost`）→ 同一 JS 数组在同一 bump 世代恒同一句柄（此前每次读新建 box → 写入丢失）。
- 效果：`const h = JSON.parse(...); const c = h.c; c[0] = 99;` → `c[0]`、`h.c[0]`、`h.c.join()`、`JSON.stringify(h)` 全部一致（此前三处不一致）；`deep-clone-and-compare` 转一致。
- 结果：**521/530（98.3%）**；残余 9 项 = 8 loud + 1 已知静默（`Object.assign` 多源键序）。

### 第二十一批差分审计（2026-10-16）
- 新增 `audit_corpus21.js`（18 例：构造器 super 参数链 / 闭包柯里化·记忆化·组合 / 高阶数组管道 / 对象展开与覆盖 / valueOf·toString 协议参与比较与算术 / 描述符 getter-setter 与自有属性判定 / 短路副作用 / 分发表与状态机 switch / 嵌套 try-catch-finally 与 return / 计数器闭包 / 模板字符串方法 / Map·Set 操作 / 整数与浮点边界 / 类字段箭头函数 this / 继承访问器在构造器内读 / 深拷贝比较 / for-in 与 Object.keys·entries）。
- **一元 `-` 的 ToNumber**：`-a` 对对象/字符串此前直接翻转 f64 符号位 → **静默 NaN**；新增 `qz.neg` 与一元 guard（句柄走宿主 `-ToJS(a)`，纯数值内联 `f64.neg`）。
- **`finally` 执行范围**：抛异常时只运行「目标 catch 所属 try **内部**」的 finally（finally 条目记录入栈时的 `_tryStack` 深度并按深度过滤）→ 修掉两处顺序错误（本 try 的 finally 提前执行 / catch 内 rethrow 时外层 finally 提前执行）。
- **类字段初始化器中的箭头函数 `this`**：字段初值内的闭包改在**构造器上下文**登记（`_mEnter` 新增 `extraNodes`），使 `this`（ctor 的 local 0）进入捕获集 → 此前 `getV = () => this.v` 运行期报错。
- **`hasOwnProperty` 漏报**：`defineProperty` 定义的访问器键与插入序表键现计入自有属性（此前只查内存槽 → 静默 false）。
- **宿主 `arr_set_index` 防御**：非 wasm 数组 tag 一律转 `set_index`（此前按 wasm 数组写 → 静默丢失）。
- 已知静默（新增，架构级，已记录于 ASSESSMENT）：宿主数组字段的表示转换导致写入丢失；`Object.assign` 多源键序。
- 结果：**520/530（98.1%）**；残余 10 项 = 8 项 loud + 2 项已知静默（架构级）。

### 第二十批补充 2（2026-10-16）
- **静态私有字段写 `C.#n = v`**：`_emitStoreProp` 顶部新增类名接收者 + 私有名分支（`qz.static_set(cn, "#类名#名")`，与读路径 `_staticKey` 一致）——此前落到实例私有分支 → 把 `C` 当值 → 编译期 loud。
- **静态方法/getter/setter 内 `this` ≡ 定义类**：`_isClassName`/`_classOfExpr` 在静态方法体内把 `this` 解析为当前类，`_inStaticMethod` 逐函数显式复位（顶层函数/方法/构造器/lambda 均置 false）；**静态方法直调**（`_emitDynMethod`）改用 `_isClassName(rx)` 识别接收者，支持 `(C as any).m()`、括号、静态方法内的 `this.m()`。
- **精确 loud（避免静默错值）**：静态成员体内 `this.<name>` 经**派生类**调用、且该派生类链上**自有**覆写 `name` 时 → 编译期 loud（此前静默按定义类解析得错值）；未覆写时与 JS 一致，不报错。
- 结果：**503/512（98.2%）**；残余 9 项全部 loud（零静默错值）。

### 第二十批补充（2026-10-16）
- **`Symbol.<wellknown>` 元素访问规范化**：`o[Symbol.iterator]` / `o[Symbol.iterator]()` ≡ `o["@@iterator"]`（读走 `_emitPropReadFromLocal`、调用走 `_emitDynMethod`）——此前按运行期 symbol 句柄查表 → 取到 undefined → 调用报 `call_value: 被调值不是函数`。
- **`@@<Symbol>` 物化回调参数补位**：物化对象上挂的 `[Symbol.x]` 包装器恒按 wasm 方法签名 `(self, a0..a3)` 传 5 个实参（不足补 TAG）——此前实参不足 5 个 → `Cannot convert undefined to a BigInt`。
- 结果：**502/512（98.0%）**；残余 10 项全部 loud（零静默错值）。

### 第二十批差分审计（2026-10-16）
- 新增 `audit_corpus20.js`（19 例：Error 子类与 instanceof、**自定义 `[Symbol.iterator]`**（对象/类）、位运算负数与移位、Math 方法矩阵、字符串负索引切片（slice/substring/substr）、splice 变体、NaN 与 includes/indexOf、toString/valueOf 覆盖、私有方法/私有静态字段、defineProperty 描述符、seal/isSealed、提升与块作用域、IIFE 与互递归、字段初始化顺序、静态继承、嵌套解构默认值、do/while+continue、逗号与嵌套三元、JSON 深/Unicode 转义、**TS 参数属性**）。
- **TS 参数属性**（`constructor(public x: any, private y: any)`）：`collectClasses` 把带修饰符的构造器形参登记为隐式字段（初值 = 形参局部读，置于字段表首位，符合 TS「参数属性先于字段初值赋值」）→ 此前 `this.x` 静默 undefined（**静默错值，已修**）。
- **for-of 迭代协议**：`qz.iter_array` 改为手写迭代协议（`x[Symbol.iterator]()` + `next()` 循环），不再用 `Array.from`（后者要求迭代器自带 `Symbol.iterator`，自定义类的 `{ next }` 会被当 array-like）。
- 已知 loud（新增）：静态私有字段经类名写；静态方法内 `this`（类名作值）；类 `[Symbol.iterator]` 的物化路径。
- 结果：**501/512（97.9%）**；残余 11 项全部 loud（零静默错值）。

### 第十九批差分审计（2026-10-16）
- 新增 `audit_corpus19.js`（19 例：数值/字符串格式化、数组边角（flat·flatMap·fill·reduceRight·findLast·默认字典序 sort）、对象工具（fromEntries·is·values·entries）、Date 细节、RegExp（exec·lastIndex·全局循环·split）、JSON 细节、**函数标签模板（含 rest 形参）**、类继承访问器 + `super`、try/finally 与 return 交互、while/for-of 每迭代绑定闭包、`new` + 展开、可选链/空值合并组合、parseInt/parseFloat/Number 边界、switch fallthrough、对象字面量嵌套方法的 `this`、稀疏数组、字符串迭代/码点、getter/setter 副作用顺序）。
- **函数标签模板 → 顶层函数直调**：`tag\`…\`` 中标签为顶层函数声明时改为直接 wasm 调用（此前按闭包值求值 → 编译期 loud「未定义捕获变量」）；rest 形参按形参表打包。
- **`new (C as any)(…)` / `new (C)()`**：`new` 目标跳过括号/as/非空断言后解析类名（此前 loud「new 目标必须是标识符」）。
- 结果：**485/493（98.4%）**；残余 8 项全部 loud（零静默错值）。

### receiver 通道（2026-10-16）
- **闭包 receiver 槽**：`qz.closure_call` 增第 6 参 `recv`、`qz.call_value` 增第 7 参 `recv`；宿主 `closureCall(handle, a0..a3, ovfArr, recv)` 对 `synthThis` 闭包把 `recv` 前置为槽 0（`hasEx` 路径归一为「ovf[0] = 实参 3」同形）。
- **发射器**：`lamMeta` 对带 `this` 形参的闭包同样标 `synthThis: true`（`this` ↦ local 1）；`_calleeParams` 首参为 `this` 时 `slice(1)`（receiver 不占实参槽）；9 处调用点（`closure_call` ×3、`call_value` ×6）末尾补 `recv = undefined`。
- **宿主三类调用方**：wasm 侧调用 / 物化包装器（`object_set_method`、`obj_accessor` 的 `opt.get`·`opt.set`）/ `call`·`apply`·`bind`（`callIt`、`cm`）全部改为经 `recv` 传 receiver。
- 效果：`fn-call-apply-bind`、`callback-this-binding`、`this-arrow-vs-fn`、`closure-captures-this-method` 转为一致；**466/474（98.3%）**，残余 8 项全部 loud（零静默错值）。

### 修复（2026-10-16）
- **类表达式别名解析**：`const C = class { … }` 后 `typeof C` / `C.x` 经 `_classOfExpr` 按 `_className` 别名解析 → 此前 `typeof C` 静默给 `undefined`（应 `"function"`）。
- 结果：**464/474（97.9%）**；残余 10 项全部 loud。
- 记录：receiver 通道重构方案与三类调用方站点清单写入 `ASSESSMENT.md`（一次尝试因宿主/发射器补丁不同步而回退）。

### 第十八批补充（2026-10-16）
- **计算属性类字段**（`["d"+"yn"]: any = 1` / `[KEY + "2"]`）：编译期常量折叠为静态字段名（字面量 / 字面量拼接 / 模块级字面量 const / 括号 / as 断言）；无法折叠 → loud。
- **类名解析跳过断言**：`(C as any).st` ≡ `C.st`（静态读/写/`typeof C` 一致）；类名**作值**仍 loud。
- 结果：**464/474（97.9%）**；**残余 10 项全部为 loud（零静默错值）**。

### 第十八批差分审计（2026-10-16）
- 新增 `audit_corpus18.js`（19 例：ToPrimitive 优先级 / spread 触发 getter / Map·Set 身份（NaN、-0、对象）/ JSON 与 Date·Symbol / RegExp 替换模式（`$&`、`$1`、`` $` ``、`$'`、`$$`、回调）/ 计算属性类成员 / 求值顺序 / 类型擦除边界 / 解构 spread getter / 嵌套闭包循环 / Array.from 空洞 / String.raw / JSON reviver / 标签跳转 / catch 解构 / 数值分隔符 / 数组解构交换 / super 方法链 / 描述符批量）。
- **模块级 const/let → wasm 全局**（`__module_init` + start 段）：模块级 const/let（含对象/数组/类实例/闭包/`as`/类型注解）此前一律 loud「未定义捕获变量」，现改为分配 i64 全局、由合成的 `__module_init` 在实例化时（start 段）按源序初始化一次；读取/写入/闭包调用解析都优先局部、再全局（保持遮蔽语义）。
- **catch 解构**（`catch ({code, msg})` / `catch ([a, b])`）：此前静默不绑定（分量恒 0）→ 现从 `__err` 读出各分量绑定；默认值/嵌套/rest 仍 loud。
- **元素赋值求值顺序**：`o[带副作用] = v` 现按 JS 顺序（obj → key → v）求值（此前先求 v → 静默错序）。
- 已知 loud（新增）：计算属性类字段（`["d"+"yn"]: any = 1`）；`o[带副作用] op= v` / `o[带副作用] ??= v`（重复求值风险）；`o(带副作用).f = v`。
- 结果：**463/474（97.7%）**；**残余 11 项全部为 loud（零静默错值）**；test_aot 233 ALL PASS。

### 第十七批差分审计（2026-10-16）
- 新增 `audit_corpus17.js`（18 例：数组全方法矩阵 / 字符串全方法矩阵 / seal·freeze 与描述符交互 / 错误形态 / WeakMap·WeakSet / 私有字段继承遮蔽 / 日期时区无关量 / 数字形态字符串索引 / 箭头 this 词法 / switch 复杂流 / 对象数组变异 / 数值边界 / 冻结键序 / 解构交换默认值 / 回调 this / 排序数值串 / Map 对象键 / 字符迭代）。
- **`includes(v, fromIndex)`**：补 `fromIndex`（未传必须省略实参）。
- **`Object.seal`/`freeze` 与描述符**：既有属性的 `configurable`/`writable` 同步写入标志表（`markAllProps`）→ `getOwnPropertyDescriptor` 报告正确 + 写保护生效。
- **数组的「数字形态字符串」索引**：`a["0"] = x` 与 `a[0] = x` 等价（此前写到物化副本 → 静默丢失）。
- **内建调用 >4 实参 → loud**：内建 ABI 仅 4 槽（`n > 4` 时显式报错），避免静默丢参（如 `Date.UTC(2024,0,15,12,30,45,123)`）。
- 已知 loud（新增）：函数表达式带 `this` 形参作为**回调实参**传递时（`h.runWith(function (this) {...})`）仍报「this 仅在类方法/构造器内可用」。
- 结果：**445/455（97.8%）**；**残余 10 项全部为 loud（零静默错值）**；test_aot 233 ALL PASS；ctest 32/32 全绿。

### 第十六批差分审计（2026-10-16）
- 新增 `audit_corpus16.js`（19 例：属性描述符全矩阵 / Date 方法矩阵 / RegExp lastIndex·sticky / 命名空间对象 / 私有静态跨类 / 排序稳定性 / 数值格式矩阵 / Unicode normalize / getOwnPropertyDescriptor / 数组拷贝语义 / entries·values 深水 / 闭包性能形态 / try-finally 值路径 / switch 穿透 / 数组方法返回类型 / 嵌套解构 / 布尔·数字强转 / 访问器继承混合 / JSON 嵌套）。
- **`super.v = x`（父类属性写）**：此前未实现（`SuperKeyword` 表达式报错）→ 现优先调父类 setter，否则按父类字段槽直写（与 `super.v` 读对称）。
- **属性描述符标志**：`Object.defineProperty` 的 `writable`/`configurable` 记入旁表（`propFlags`，bump 失效）；`Object.getOwnPropertyDescriptor` 对 POJO/实例组装完整描述符；写入非 `writable` 属性 → TypeError（strict 语义，经 `protGuard`）。
- 结果：**428/437（97.9%）**；**残余 9 项全部为 loud（零静默错值）**；test_aot 233 ALL PASS；ctest 32/32 全绿。

### 用户标签模板 strings.raw（2026-10-16）
- 新增 `qz.tagged_strings(cooked, raw)`：把标签模板的 strings 参数由 wasm 数组换成**带 `.raw` 的宿主数组**（cooked 索引 + 非枚举 `raw`）→ 用户标签里的 `strings.raw` 可用（此前 undefined → `.raw.join` 抛错）。
- 发射：raw 文本用与 `String.raw` 相同的「源码原文去定界符」提取（`rawOf` 提升为分支级 helper）；已知形参标签按形参表落栈（`strings` 手工压入 + 其余走 `_emitCallArgs`，rest 仍打包）；通用标签走 `tagged_strings` + 第 6 参 ovf。
- 结果：**409/418（97.8%）**；**残余 9 项全部为 loud（零静默错值）**；test_aot 233 ALL PASS；ctest 32/32 全绿。

### 第十五批差分审计 + 内建全局/Symbol/Reflect/可选调用（2026-10-16）
- 新增 audit_corpus15.js（20 例：Symbol 值/Reflect/Map·Set 深水/Date/RegExp 命名组/Array.from 迭代/String.raw 变体/类表达式继承/switch TDZ/标签 break/数组 delete/Number·String 静态/JSON replacer·reviver/Error 子类链/自定义迭代器/getter 返回对象/WeakMap 身份/可选链调用）。
- 内建全局作值（Symbol/BigInt/Reflect/Math/JSON）：builtin_member + builtin + builtin_spread 补 globalThis 回退与点号路径解析（Symbol.for / Reflect.has / Number.isInteger）。
- Symbol 句柄去重（symOf Map）-> Symbol.for 同一符号恒等同一句柄。
- typeof symbol（is_symbol_host）-> 宿主 symbol 返回 symbol。
- 可选链调用 o.f?.(x)：nullish 短路（求值一次）；否则走 call_value。
- Reflect.set/deleteProperty 对 POJO/实例就地改（物化副本无效 -> 此前静默不生效）。
- delete a[i] 对 wasm 数组写 HOLE（Object.keys 跳过洞）。
- ret 还原物化句柄（find/pop/at 返回元素保持身份与方法）。
- 已知 loud：用户标签模板 strings.raw（wasm 数组无附加属性）。
- 结果：408/418（97.1%）；残余 10 项全部为 loud（零静默错值）；test_aot 233 ALL PASS；ctest 32/32 全绿。

### 第十四批的 3 项静默差异已修（2026-10-16）
- **`undefined/null` 写属性 → TypeError**：`_emitStoreProp` 先用「TAG|0/1」判定接收者 → 走宿主 `prop_set`（host 抛 TypeError）；err 检查放在整条 if 链**之外**（链内插入会破坏嵌套深度/平衡）。
- **块级 `let/const` 遮蔽外层同名变量**：`_collectLocals` 按作用域精确扫描遮蔽块（`_shadowBlocks`）；进入遮蔽块前把外层同名局部保存进 `$shN`（i64 值局部），退出后恢复 → `{ let x = 10 }` 不再污染外层 `x`。
- **返回元素的方法保持身份**：`ret` 对「已物化的 POJO/实例」依据 `pojoOf` 还原原句柄（实例还原为 `0x7FFE|off`）→ `find/pop/at/slice` 等返回的元素仍具方法与身份（此前是物化快照 → 调用报「无方法」）。
- 结果：**389/398（97.7%）**；**残余 9 项全部为 loud（零静默错值）**；test_aot 233 ALL PASS；ctest 32/32 全绿。

### 第十四批差分审计（2026-10-16）
- 新增 `audit_corpus14.js`（17 例：`this` 绑定矩阵 / undefined·null 访问 / 继承·原型 / 别名与共享 / ES2023 数组 / 字符串快照 / 数组方法于实例 / 键序 / try/catch 语义 / 闭包循环捕获 / 解构 / getter·setter 原型链 / typeof·instanceof / JSON 往返 / 数值边界 / 数组洞 / IIFE·作用域）。
- 新发现的静默差异（已记 ASSESSMENT 待修）：(1) `undefined/null` **写属性**（读已抛 TypeError，写未接线）；(2) 块级 `let/const` 遮蔽（wasm 局部按名唯一 → 内层覆盖外层绑定）；(3) `Array.indexOf` 以实例句柄查找（物化副本身份不同）。
- 结论：本轮未引入功能改动（块级遮蔽实现与 loud 检测尝试均因结构/假阳性风险回退），仅新增语料以**定位下一批修复目标**。
- 结果：**386/398（97.0%）**；残余 = 9 loud + 3 新发现的静默差异；test_aot 233 ALL PASS；ctest 32/32 全绿。

### undefined 属性读抛错 + this 形参模型（2026-10-16）
- **属性访问 undefined/null → TypeError**：内存快路径「未赋值/越界」分支改走宿主 `prop_get`（POJO 未赋值 → undefined；undefined/null → TypeError）；调用点在链外统一 `_emitErrCheck`（此前尝试在嵌套 if 内插入会破坏 else/end 平衡）。提取方法 `const f = o.m; f()` 因此与 JS 一致抛错。
- **`this` 形参是注解（不占实参槽）**：`function (this: any, k)` 的 `k` 现映射到正确槽位（此前 `this` 占槽 → `k` 错位得 NaN）；`this` 在该函数内按 JS 为 undefined（访问属性抛 TypeError，loud）。
- **对象字面量方法/访问器的合成箭头**：首个 `this` 参数是**真实 receiver 槽**（`lamMeta.synthThis`）→ `.call/.apply/.bind` 对合成方法传 receiver，对用户注解形参不传。
- 结果：**372/381（97.6%）**；残余 9 项**全部为 loud**；test_aot 233 ALL PASS；ctest 32/32 全绿。

### 数组迭代器惰性化（2026-10-16）
- `values()` / `keys()` / `entries()` 改为**惰性读 wasm 内存**（`liveIter`）：每次 `next()` 读当前长度与元素 → 迭代期间的 `push`/长度变化可见（JS 迭代的是活数组；此前取的是取值时刻的副本快照），洞按 `undefined` 贡献。
- 结果：**371/381（97.4%）**；残余 10 项 = 7 loud + 3 已知静默差异（提取方法不抛错、`this` 捕获 NaN、…）；test_aot 233 ALL PASS；ctest 32/32 全绿。

### 提取方法的 this 与 undefined 属性读（2026-10-16）
- 对象字面量方法/访问器包装：`this` 非对象时传 **undefined**（JS 语义；此前回落定义时对象 → 提取后调用误读到定义对象的字段）。
- `prop_get`：接收者为 undefined/null 时抛 `TypeError: Cannot read properties of …`（JS 语义；此前静默 undefined）。注：wasm 内存快路径仍直接返回 undefined，故该错误只在经宿主分派的读取上生效。
- 结果：**370/381（97.1%）**（本轮语料新增 20 例，17→16 差异为「提取方法」用例语义更接近 JS 但未抛错，仍记为待修）。

### 第十三批差分审计（2026-10-16）
- 新增 `audit_corpus13.js`（20 例：别名/共享、原型链、键序（整数键）、`this` 绑定、shallow 语义、迭代器、提取方法）。
- **字符串 `+=` 数字快路径缺 `str_dup`（静默错值）**：`s += n` 的数字分支直接 `qzs_append` 原地追加 → 被容器快照的同一字符串被改写（如 `parts.push(r)` 后所有元素变成最终值）。现按 `_concatInPlace` 先取私有副本。
- **对象字面量方法/访问器的 `this`**：改为**实际接收者**（`tagHandle(this)`）——此前绑定义时对象 → 原型链调用（`Object.create` 继承）读到错误字段。
- **`delete` 语义**：宿主对象真删（原型可继续透出，此前写成自有 undefined 遮蔽原型）；POJO/实例槽置 undefined；插入序名单同步移除。
- **对象元素在回调中的身份**：`map/filter/...` 回调收到的实例/POJO 现为**原句柄**（此前物化成快照 → 方法调用报「无方法」、身份丢失）；`bytesOf` 还原实例 tag。
- **`==` / `===` 引用同一性**：数组（0x7FFB）纳入对象句柄判定（此前物化成不同 JS 数组 → 恒 false）；`eq` 对「双方皆对象」走句柄同一性，其余仍走 JS 宽松相等。
- 结果：**370/381（97.1%）**；残余 11 项 = 7 loud + 4 已知静默差异（见 ASSESSMENT）；test_aot 233 checks ALL PASS；ctest 32/32 全绿。

### 私有成员修正（2026-10-16）
- **私有字段不参与枚举**：物化时跳过 `#类名#名`（JS 私有槽不是自有可枚举属性）→ `Object.keys(instance)`/`JSON.stringify` 与 JS 一致。
- **静态私有字段**：`static #s` 的存储键与读路径统一为 `#类名#名`（`statics_has`/`static_get` 此前用裸名 → 读为 undefined）；`P.#s` 的属性读改走静态路径（私有名 + 类名接收者不再当实例私有读）。
- **私有方法调用**：`this.#m()` 按 `_curClass` 限定键（此前只有类名接收者会限定）。
- **符号键**：`defineProperty` 的符号键不进插入序表（避免非字符串键混入 `Object.keys` 路径）。
- 结果：**354/361（98.1%）**；**残余 7 项全部为 loud（零静默错值）**；test_aot 233 checks ALL PASS；ctest 32/32 全绿。

### 闭包 >4 形参（2026-10-16）
- 新增 `audit_corpus12.js`（16 例：>4 形参的嵌套函数声明/箭头函数表达式/IIFE/rest 组合/默认值/值传递/高阶回调/递归/类与对象方法）。
- **统一溢出实参约定**：闭包调用与值调用一律 `a0..a3 = 实参 0..3`（未传补 undefined）+ 第 6 参 `ovf = 实参 3.. 的数组`；宿主 `closureCall` 依 `lamMeta.n` 与 `lamMeta.rest` 还原形参槽（rest 形参把尾部实参打包为数组）。
- 覆盖：嵌套函数声明、箭头/函数表达式、IIFE、`fn(...)` 值传递（变量/参数持闭包）、高阶回调（回调形参数未知）、递归、rest+固定参混用、默认值、调用元数（少传补 undefined / 多传截断）。
- `lamMeta` 增加 `rest` 标志；`call_value`/标签模板调用点补齐第 6 参。
- 已知 loud：**类方法与对象字面量方法 >4 形参**（方法 ABI 为 `self + 4` 槽）。
- 结果：**353/361（97.8%）**；**残余 8 项全部为 loud（零静默错值）**；test_aot 233 checks ALL PASS；ctest 32/32 全绿。

### 运行时访问器（Object.defineProperty get/set）（2026-10-16）
- **运行时访问器表**：`Object.defineProperty(o, k, {get, set})` 在 POJO/实例上 → 记入宿主访问器表（`dynAcc`，bump 失效），读/写经宿主分派调用闭包（`this` = 接收者）→ `o.v` / `o.v = x` 与 JS 一致；数据描述符路径不变。
- **物化**：访问器按插入序定义到物化对象上（`Object.keys` 含该键、`JSON.stringify` 调 getter、`enumerable:false` 记入非枚举表）。
- **发射策略**：程序内出现 `Object.defineProperty`/`defineProperties` 时，POJO/实例的属性读/写改走宿主（`prop_get`/`prop_set`）；否则仍走内存快路径（零开销）。
- 顺带补齐 `prop_get`/`prop_set` 的 **POJO 分支**（此前只处理实例 → 该模式下 POJO 字段读写会静默丢）。
- 结果：**338/345（98.0%）**；**残余 7 项全部为 loud（零静默错值）**；test_aot 233 checks ALL PASS；ctest 32/32 全绿。

### String.raw + 类名作值报错（2026-10-16）
- **`String.raw` 标签**：编译期按源码原文取 raw 段（去模板定界符）+ `ToString(插值)` 拼接 → 与 JS 一致（此前因 strings 数组无 `.raw` 表而运行时 loud）。
- **类名作值**：给出明确编译期报错（此前为「未定义捕获变量: C」）；`new C()` / `c instanceof C` / `C.m()` / `C.x` 仍正常。
- 结果：**337/345（97.7%）**；**残余 8 项全部为 loud**；test_aot 233 ALL PASS；ctest 32/32 全绿。

### 类表达式 / 私有静态成员（2026-10-16）
- **类表达式**（`const C = class {…}`、`class Named {…}`、`{ K: class {…} }`）：收集期合成类名并登记绑定别名 → `new C(...)`、`c instanceof C`、`C.staticMethod()` 按普通类处理；作为**值**使用仍编译期 loud（无类值表示）。
- **私有静态字段/方法**：`static #n` / `static #m()`（此前私有字段分支忽略 `static` → 变成实例字段，读取静默 NaN）；键统一为 `#类名#名`，静态读/写/`++`/复合赋值与动态分派均按此键（修复 `#name` 二次限定）。
- **`typeof <类名>`** → `"function"`（class 是函数对象）。
- 结果：**336/345（97.4%）**；**残余 9 项全部为 loud（零静默错值）**；test_aot 233 checks ALL PASS；ctest 32/32 全绿。

### 第十一批差分审计（2026-10-16）
- 新增 `audit_corpus11.js`（24 例：类表达式 / IIFE·逗号·void / 标签循环 / switch 边界 / Map·Set 边界 / 运行期键序 / 访问器定义 / 模板标签函数 / 解构默认值 / rest·spread / 私有静态方法 / 排序稳定性…）。
- **对象恒等（物化缓存）**：同一次 bump 生命周期内同 offset → 同一 JS 对象（按需刷新、自引用直接复用）→ `o === o`、`Map`/`Set` 以对象为键、`===` 语义正确（此前每次物化新对象 → Map.get 对象键静默失效）。
- **物化刷新**：按「本轮实际写入的键」集合删除陈旧属性（`delete o.k` 后 `Object.keys`/JSON 不再列出）。
- **`in`**：实例先查类链（getter/setter/方法，原型成员）→ `"v" in obj` 与 JS 一致。
- **`call_value` 省略尾随未传实参**：`(0, Math.max)(1, 2)` 此前 → NaN。
- **标签模板**：标签为已知形参的函数时按形参表落栈（rest 形参打包、元数补齐），此前 rest 形参拿到非数组。
- **POJO 上的 `defineProperty` 访问器** → 编译期/运行期 loud（不能静默丢访问器）。
- 结果：**333/345（96.5%）**；**残余 12 项全部为 loud（零静默错值）**；test_aot 233 checks ALL PASS；ctest 32/32 全绿。

### 稀疏数组洞（2026-10-16）
- 新增洞哨兵 `HOLE`(0x7FF9|2)：`arrWriteback`/`arrSetInPlace` 保留 JS 空洞、数组按下标越界增长与 `delete a[i]` 写洞、`arrRead` 还原为**真稀疏 JS 数组** → `map/filter/reduce/indexOf/join/flat/Object.keys/JSON.stringify/for-of` 与 JS 语义一致；`Array.prototype.includes` 不跳洞（`[,].includes(undefined) === true`）。
- 元素读快路径（下标 / for-of）对洞归一化为 `undefined`（此前 `typeof a[0]` 会得 `object`）；数组字面量 `[1,,3]` 的省略元素写洞。
- `arguments` 对象改为**编译期 loud**（此前静默 undefined，`.length` 处宿主崩溃）。
- 结果：**313/321（97.5%）**；**残余差异全部为 loud（无静默错值）**。

### 对象键序（插入序）支持（2026-10-16）
- **插入序跟踪**：POJO/实例写属性时登记 `field_order`/`field_order_lit`（对象字面量按编译期名序一次登记、运行期下标写与 `delete` 同步移除），物化时按插入序建对象 → `Object.keys`/`values`/`entries`、`for-in`、`JSON.stringify`、对象展开的键序与 JS 一致（此前为「预登记字段序 + 运行期新键」）。
- 代价：仅当程序出现顺序敏感 API（`Object.keys|values|entries|assign|fromEntries|getOwnPropertyNames`、`JSON.stringify`、`for-in`、对象展开）时才发射写前登记调用；常见程序零额外开销。
- `Object.keys` 现包含「已赋值为 undefined」的键（插入序名单即写入记录）。
- 结果：**311/321（96.9%）**；**仅剩 1 项静默差异**（稀疏数组 holes），其余 9 项均为 loud。

### 第十批差分审计（2026-10-16）
- 新增 `audit_corpus10.js`（24 例：this 绑定 / Function.prototype 三件套 / 原型 / 访问器边界 / 数组洞 / 正则 / 异常边界 / 访问器抛错）。
- **原型污染修复（classMeta 自有键）**：`methods["valueOf"]`/`["toString"]` 会命中原型链 → 宿主 `m.name` 失效、崩溃/错值（`own()` 查询）。
- **`.length` 属性读取**：字符串/数组之外的接收者此前一律走 `qz.str_len`（把内存当字符串读 → 静默错值）；现走宿主属性读取（闭包值 `fn.length`、POJO/实例字段、宿主对象皆正确）。
- **闭包值内省**：闭包块扩为 `[funcidx][envIdx][arity][nameStrId]` → `fn.length` / `fn.name` / `fn.toString()` 正确（此前读内存垃圾值）；`cloWrap` 包装同步带上。
- **`Function.prototype.call/apply/bind`**（闭包句柄与宿主函数皆可），`call`/`apply` 的 thisArg 会物化 POJO/实例（此前传 undefined → `Object.prototype.toString.call(o)` 得 `[object Undefined]`）。
- **`closure_call` 兼容宿主函数句柄**（bind 结果、宿主回调）：调用点无法静态区分闭包与宿主函数。
- **`String.prototype.replace/replaceAll` 接受回调**（此前 `String(cb)` 把回调源码当替换串 → 静默错值）。
- **宿主数组附加属性**：`RegExp.exec`/`String.match` 结果的 `index`/`input`/`groups` 经 `arrMeta` 保留（wasm 数组本体仍走 `.length`/索飞快路径）。
- **宿主对象内省不再物化**：`Object.getPrototypeOf`/`setPrototypeOf`/`getOwnPropertyDescriptor(s)`/`create` 直接作用于真身；`tagHandle` 去重（同一 JS 对象 → 同一句柄 → `===` 语义正确）。
- **getter 抛错可 catch**：属性读取后检查 `__err`（此前 getter 内 throw 逃逸出函数）。
- **静态初始化保源码序**：字段与 `static { … }` 按源码顺序惰性执行一次（此前「先全部字段、后全部块」→ 跨引用得 NaN）。
- **类方法/静态方法形参序言**：补默认值/解构形参处理（此前缺失）。
- 已知 loud：闭包/lambda >4 形参；宿主↔wasm 递归约 300 层（`--stack-size` 可提高）。
- 结果：**310/321（96.6%）**；test_aot 233 checks ALL PASS；ctest 32/32 全绿。

### 第九批差分审计（2026-10-16）
- 新增 `audit_corpus9.js`（25 例：ES2023/2024 新 API / `super` / ToPrimitive 强制转换 / `delete`·`in` / 迭代器·Map·Set / TS 类型擦除 / enum）。
- **原型污染修复（重要）**：`classMeta` 的 `methods`/`getters`/`setters` 是对象字面量，`methods["valueOf"]`/`["toString"]` 会命中原型链上的 `Object.prototype` 方法 → `m.name` 失效、宿主崩溃/错值。改用自有键查询（`own()`）。
- **TS 类型层擦除**：`interface` / `type` / `declare` 命名空间 / `import`·`export` 声明不再报「不支持的语句」。
- **模板字符串插值 = ToString（string hint）**：此前走 `+`（ToPrimitive default）→ 有 `valueOf` 的对象插值结果错误（静默）。
- **标签模板**：改走 `qz.call_value`（闭包/宿主函数皆可作 tag）；修复无替换模板（`` tag`a` ``）编译期崩溃。
- **`Object.prototype` 方法名的属性读取**：`typeof o.hasOwnProperty === "function"`（此前静默 undefined）；`hasOwnProperty`/`valueOf`/`toString`/`toLocaleString` 走宿主分派。
- **ES2023/2024 API**：`Array.prototype.toSorted`（含比较器）/`toReversed`/`toSpliced`（原数组不变、`deleteCount` 省略 = 到末尾）/`with`；`Object.hasOwn`、`Object.groupBy`、`Map.groupBy`。
- **字符串**：`toLocaleUpperCase`/`toLocaleLowerCase`/`localeCompare`/`normalize`/`replaceAll`/`search`/`match`。
- **类 `[Symbol.*]` 成员**：`[Symbol.iterator]` / `[Symbol.toPrimitive]` / `[Symbol.toStringTag]` 等编译为 `@@<name>` 方法，物化时挂真 Symbol → 实例可迭代、可参与强制转换（如 `t + 0` 走 `[Symbol.toPrimitive]`）。
- **TS enum**：数字/字符串成员、隐式递增、常量折叠（四则/位运算/一元）；`Color.Red` → 编译期值，`Color[0]` → 反向映射名。
- 已知 loud：`String.raw`（strings 数组无 `.raw` 表）。
- 结果：**289/297（97.3%）**；test_aot 233 checks ALL PASS；ctest 32/32 全绿（含 test262）。

### 第八批差分审计（2026-10-16）
- 新增 `audit_corpus8.js`（24 例：Date / JSON 深水 / String 扩展 / Array 扩展 / 描述符 / Error 子类 / 数字边界）。
- **宿主方法实参**：尾随「未传」实参必须省略 —— `setFullYear(2021)` ≠ `setFullYear(2021, undefined)`（此前静默 Invalid Date / NaN）。
- **循环引用物化**：同一次物化树内同 offset 复用同一 JS 对象（此前 `o.self = o` → 栈溢出；现 `JSON.stringify` 抛真实 TypeError 且可被 catch）。
- **宿主异常可 catch**：`qz.method_call` / `qz.builtin` 的宿主语义错误（RangeError / TypeError）经 `throwValue` 置 `__err`，调用点 err 检查转入本函数 catch（如 `String.prototype.repeat(-1)`）；catch 入口即清 `__err`（否则 catch 体内调用点会重复触发）。
- **符号键属性**：POJO/实例的符号键（`Symbol.iterator` / `Symbol.toStringTag` …）存旁表，物化时按 own enumerable symbol 定义 → 不进 `Object.keys` / JSON，但 `Object.prototype.toString` 可见；`Object.prototype` 等原型对象可作为值读取（`Object.prototype.toString.call(o)`）。
- **写保护**：`Object.freeze` / `seal` / `preventExtensions` 就地作用于 POJO/实例（旁表），`isFrozen` / `isSealed` / `isExtensible` 如实；**strict 语义**：冻结/不可扩展对象写入抛 TypeError（仅当程序内出现 freeze/seal 时才发射写前检查 → 常见程序零额外开销）。
- **`extends Error`**：类元数据记录 `builtinParent` → `x instanceof Error` 及错误族判定正确；`.stack` 读取经宿主按当前 name/message 合成（栈文本实现定义）。
- **Date**：补 `Date.now` / `Date.parse` / `Date.UTC`。
- 结果：**265/272（97.4%）**；test_aot 233 checks ALL PASS；ctest 32/32 全绿（含 test262）。

### 第七批差分审计（2026-10-16）
- 新增 `audit_corpus7.js`（27 例，迭代协议 / 描述符 / 数字字符串深水区 / 控制流收尾）。
- **展开走迭代协议**：`[...x]` 经宿主 `qz.spread_into`（替换 `[].concat(x)` 语义），支持数组/字符串/迭代器/Map/Set。
- **well-known Symbol**：`Symbol.iterator` 等计算键名 → 真符号值；对象字面量计算键名方法经 `qz.object_set_method_key`（宿主对象支持符号键）。
- **数组迭代器**：`entries()`/`keys()`/`values()` 返回 JS 迭代器（for-of/展开经 `iter_array`）。
- **内建展开调用**：`Math.max(...a)` 等经宿主 `qz.builtin_spread`。
- **Object.defineProperty**：POJO/实例/宿主就地定义；`enumerable:false` 记入 `nonEnum` 表（物化/`Object.keys` 跳过）；`Object.getOwnPropertyNames` 列已赋值字段 + extras（含非枚举）。
- **async 函数显式 loud**：编译期 `throw`（此前被当同步函数编译 → 静默返回非 Promise 值）。
- 结果：**241/248（97.2%）**；test_aot 233 ALL PASS；ctest 全绿。
**feat(aot): 第六批语料 + 标准库边界修复**（语料 6 = 29/29）。
  - 字符串 `split(sep, limit)`、`indexOf/lastIndexOf(v, fromIndex)`（**未传 fromIndex 必须省略实参**：传 undefined 语义不同）。
  - 数组 `fill(v, start, end)` 区间、`includes` 用 SameValueZero（`[NaN].includes(NaN)`）、`findLast/findLastIndex`。
  - `Object.assign(target, ...src)` **就地**写 POJO/实例/宿主对象并返回目标（此前返回物化副本）；恢复被误吞的 `Object.freeze/seal/isFrozen/...` 表项。
  - 宿主侧「抛出」机制：导出 `__set_err`，宿主 `throwValue`（如空数组 reduce）设 `__err` → 调用点检查转异常路径（JS 可 catch）；每个 tagged 函数入口清 `__err`。
  差分：语料 1~6 = 46/47、40/40、37/39、38/38、28/28、29/29（**218/221**；余 3 项为已记录限制：POJO 键序、`arguments`、稀疏数组 `Object.keys`）。
- **feat(aot): 跨函数 throw 传播 + try-finally 重抛 + 对象字面量成员闭包捕获**（语料 3/5 全部对齐）。
  - `throw` 在本函数无 try → 跑完待执行 finally（若函数为 void 则不压值）后 `return`，`__err` 全局置位；调用点（直调/闭包调用/值调用/构造器）检查 `__err` 并跳到最近 `$err`（无 try 则立即向上返回）→ 跨函数抛出（含构造器内 throw）语义完整。导出 `__err` 全局 + 宿主 `qz.take_err()`：glue 调用导出后检查并抛出，模拟 JS 异常。
  - `try {…} finally {…}`（无 catch）在 finally 后**重新抛出**（此前静默吞掉）。
  - 对象字面量 方法/访问器 的合成箭头现纳入捕获分析（`_collectLambdas` + 缓存同一节点实例）→ 成员闭包捕获外层局部（`log.push` / `log +=`）不再丢 env 而崩/丢副作用。
  差分：语料 5 = **28/28**、语料 4 = 38/38、语料 2 = 40/40、语料 1/3 = 46/47、37/39（余 3 项为已记录限制：POJO 键序、`arguments` 对象、稀疏数组 `Object.keys`）。
- **fix(aot): 展开实参 + rest 形参（拆包调用）**：`g(1, ...a)` / `g(...a)` 现按形参表拆包（固定形参取数组元素、rest 取 `slice`）后直调/闭包调用，元数天然匹配；此前把整个实参数组塞给第一个形参。
- **fix(aot): `++obj.a`/`obj.a++` 遇宿主对象**（对象字面量方法里的 `this.x++`）→ 走 `qz.prop_get/prop_set`（运行时按 tag 分派），不再误写内存偏移。
  差分：语料 5 = 25/28。
- **feat(aot): 第五批语料 + 值调用/嵌套解构/静态继承/数组句柄往返/纯数值属性读**。
  - 值调用 `(a.b[c])(…)`、`(cond ? f : g)(…)` → `qz.call_value`（闭包 → closure_call；宿主函数 → 调用）。
  - 嵌套解构 `[[a],[b]]` / `{a:{b}}`（`_emitBindingTarget` 递归）。
  - 静态字段**继承/遮蔽**：读按父→子运行时查表（`qz.statics_has`），写落接收者类。
  - 数组句柄往返：`arrRead` 记下来源句柄、`bitsOf`/`ret` 还原 → 取出再改（`m.get(k).push(3)`）保持同一数组。
  - 纯数值/布尔的属性读走宿主（`(1).toLocaleString` 为函数）。
  - 对象展开槽级合并（只覆盖自有键）；POJO/实例 clsId 撞号修复（见上条）。
  差分：语料 5 = 24/28；语料 1/2/3/4 = 46/47、40/40、37/39、**38/38**。
- **feat(aot): 静态块 / extends 内建 / for-of 解构与可迭代 / POJO-instance clsId 混淆修复（语料 4 满分 38/38）**。
  - `static { … }`：与静态字段同批**惰性一次执行**（守卫内执行；守卫体重入已抑制）。
  - `class X extends Error`：父类为内建时 `super(m)` → 写 `message`/`name` 字段（子类仍为内存实例）。
  - for-of：支持解构模式 `for (const [k,v] of …)`；非数组可迭代值（Map/Set/迭代器）经 `qz.iter_array`（Array.from）→ 数组。
  - **POJO 与实例的 clsId 混淆修复**：POJO 头 `[0]=0` 与「第一个类的 id」撞号 → 物化时被误挂该类的 toJSON/valueOf/toString 钩子（`JSON.stringify({p: instance})` 得 `{}`）；现 `materialize(off, isInst)` 仅对实例挂钩子，`method_call` 仅对 0x7FFE 实例走类方法派发。
  差分：语料 4 = **38/38**；语料 1/2/3 = 46/47、40/40、37/39。
- **fix(aot): 字符串不可变语义（此前原地追加会改写左操作数缓冲）+ 累加器逃逸分析**。
  - 原 `qzs_append` 在缓冲位于 bump 顶时**原地追加** → `out += "a"` 会改写 `out` 旧值所在缓冲，随后再读 `out` 得到被改写内容（`out + "|" + out` 得 `a|a|`）。
  - 现按**逃逸分析**分派：`x` 的每次出现都只是自身赋值目标 / 赋值给 x 的右侧 / 只读访问 → 视为**私有累加器**，走无条件原地追加 `qzs_append_ip`（`x += y` 累加仍 O(n)：70k 次追加实测 bump 70 KB）；否则先 `qz.str_dup` 复制再原地追加（不可变 ✓）。
  - 修重复 `qzs_append` 声明（同名前向声明两次 → 函数索引错位）。
- **feat(aot): 第四批差分语料** `audit_corpus4.js`（38 例，容器/类细节/可选调用/强制转换/数字字符串边界）：Map/Set/Date、toJSON/valueOf/toString 钩子（物化对象挂非枚举回调）、实例原型方法读（`typeof c.get` → function）、`super.v`（父类 getter/字段）、`new C(...args)`、标签块 break、Error 族 instanceof。当前 29/38。
- **fix(aot): 内建类 instanceof 的原始值语义**（`"s" instanceof String` / `1 instanceof Number` 此前误判为 true；JS 语义为 false——原始值非装箱对象）。改按**物化后的 JS 语义**判定（`j instanceof C` / `Array.isArray` / `typeof`）。守门：`test_aot.js` 233 checks ALL PASS。
- **test(aot): 语义回归入快速门**（`test_aot.js` +9：finally 穿透 / 字面量访问器 / 展开别名 / for-of 字符串 / 解构赋值 / 位运算混合 / 嵌套 new / 数组越界）。
- **feat(aot): 对象字面量方法/访问器（宿主对象 + 闭包回调）**。
  - `{ get v(){...}, set v(x){...}, m(){...}, k: v }` 现编译为**宿主对象**（0x7FFD）：访问器经 `Object.defineProperty` 回调 wasm 闭包（`qz.obj_accessor`），方法经 `qz.object_set_method`（调用时转发接收者作为 self）；字段经 `qz.object_set`。宿主 JS 侧同样按 JS 语义可用（JSON/`Object.keys` 等）。
  - 合成箭头把 self 作为名为 `this` 的形参 → 体内 `this.x` 解析到该参数（`_capturesOf` 对已具名 `this` 形参不再视为捕获）。
  - `typeof <宿主函数>` → "function"（新 `qz.typeof_host`）。
  差分：语料 1 = 46/47（余 1 为 POJO 键序差异），语料 2 = 40/40。
- **feat(aot): 对象展开改内存级浅拷贝（JS 别名语义）+ `for...of` 支持字符串**。
  - `{...o}`：新对象分配同容量后按槽 memcpy → **嵌套对象保持同一引用**（此前经宿主物化 → 深拷贝，`b.y.z=9` 不影响 `a.y.z`，静默违背 JS 别名语义）；宿主对象源退化为 `qz.obj_merge`（物化逐键写，未知键入 extras）。
  - `for (const ch of "abc")`：字符串按 UTF-16 码元经宿主 `charAt` 迭代（此前按数组语义读内存 → 越界 trap）。
  差分：语料 1 = 44/47（余为 loud：对象字面量访问器/函数 rest 形参；及键序差异），语料 2 = **40/40**。
- **feat(aot): POJO/实例统一容量（支持运行期新增字段）+ 解构赋值 + 宿主 extras 旁表**。
  - **预登记字段表**：编译期先扫描全程序属性名冻结 `fieldMap`，POJO/实例一律按**统一容量**分配并把槽全写为 undefined 句柄 → `o.newField = v`、`memo[k] = v`（k 运行期决定）不再越界写/错位读；未赋值字段读 = undefined（JS 语义）。
  - **运行期新键旁表**：未预登记的名字存宿主 `extras`（key = 内存偏移|名字），`bump` 复位即失效；`get/set_index`、`prop_get/set`、`delete_index`、物化（Object.keys/JSON）全链可见。
  - **解构赋值** `[a,b]=[b,a]` / `({m:x} = o)`（结果 = RHS）。
  - **可重入槽扩展**（8 层 × i64×5 + i32×3）：`new` 的 self/实参、`sT[0]` 等此前会被嵌套 `new`/表达式覆盖。
  差分：语料 1 = 44/47，语料 2 = 38/40。
- **fix(aot): try/finally 语义完备**（此前 finally 只在正常路径执行 → 静默漏副作用）。
  - `return` 穿过 try → 先求返回值表达式（JS 顺序）再跑 finally；`throw` 穿出 try → 跑该异常路径经过的 finally（同一 try 的 finally 仍由自然流负责，避免重复执行）；`break`/`continue` 退出含 try 的循环 → 先跑退出范围内的 finally。
  差分：语料 2 = 34/40。
- **feat(aot): 闭包值独立 tag 0x7FFF（函数作对象属性/模块模式）+ delete 下标 + 两批差分**。
  - 闭包句柄由 0x7FF9（与 POJO 同 tag，运行时不可区分）改为 **0x7FFF**：`typeof f`→"function"、宿主 `method_call` 对 POJO/实例字段持有闭包时直接调用（对象字面量方法 / IIFE 模块模式）、`===` 按 (tag|off) 身份比较（toJS 每次新建包装函数会恒不等）、`toJS` 还原为可调用包装。
  - `delete a[i]` / `delete o[k]`（宿主 `qz.delete_index`）；`delete o.k` 改经宿主（越界即报错，不再静默越界写）。
  - 宿主返回 i64 的 `arr_delete_index`/`delete_index` 曾返回 JS number → wasm 边界报 `Cannot convert 1 to a BigInt`。
  - 差分：语料 1 = 44/47，语料 2 = 33/40。
- **fix(aot): 位运算守卫栈失衡（虚留 i32 → 产物类型非法）+ 下标越界/类型分派 + 内建元数表项**。
  - `emitGuardedBit` 守卫条件此前少一次 `i32.or` 合并 → 栈上遗留 i32 → `(3.9|0)+(2.1&3)` 之类产物 `local.set` 类型非法（wasm2wat 报错、实例化失败）。现累进合并为单条件。
  - `a[i]` 越界/NaN/负数 → undefined（此前裸读内存 → trap 或静默错值）；接收者非 wasm 数组（宿主数组/字符串/POJO）→ 宿主 `qz.get_index`。
  - `a[i] = v` 越界 → 宿主 `qz.arr_set_index`（JS 扩容补 undefined）；新增 `qz.arr_delete_index`。
  - 内建表 `[fn, arity]` 元组项此前被当函数调用（`Math.hypot`/`log2`/`atan2` 报 `fn.apply is not a function`）。
  - 第二批差分语料 `audit_corpus2.js`（40 例）：30 一致。
- **feat(aot): 调用实参展开 `f(...args)`**（宿主 `qz.call_named` 按名动态调用 / `qz.closure_call_spread` 闭包动态调用 / 静态方法经数组前置 `self` 占位；目标按导出函数实际参数个数补齐 ABI 槽）；**`typeof` 内建全局**（Math/JSON/Reflect → "object"，其余内建函数 → "function"）。差分审计 43/47。
- **test(aot): 差分审计工具入库** `src/qzvm/aot/audit_diff.js` + `audit_corpus.js`（oracle = 同一 TS 源经 tsc 剥类型在 node 跑真 JS；逐例独立编译比对；当前 41/47，余为 loud 未实现）。`node src/qzvm/aot/audit_diff.js`。
- **feat(aot): 嵌套函数声明按闭包处理 + 类访问器 + 解构完备 + 内建 instanceof/super 分派**。
  - **嵌套函数声明 → 闭包**：此前整树提升到模块级，丢失对外层局部的捕获（`function inner(){ total += 1 }` 编译期报「未定义变量」）。现仅在文件顶层提升，嵌套声明在所属函数入口先建闭包写入变量（保持声明提升/相互递归语义）。
  - **闭包调用**：句柄来源支持「捕获」（env_get）+ 参数直接压栈（不再用会被嵌套调用覆盖的 `cloArgs`）；支持 IIFE `(() => 42)()`。
  - **类访问器**：get/set 此前同名 → 重复 declareFunc → 编码期 `codes` 占位 null 崩溃；现 setter 独立名 `$set`，`classMeta` 分 `getters`/`setters`，属性读/写命中访问器名时走宿主 `qz.prop_get`/`qz.prop_set`（实例沿继承链，未命中退化为字段读写）。修对象解构裸读内存（越界 → undefined）。
  - **`super.m()`**：继承链编译期已知 → 静态直调父类方法（self=this），语义与 JS super 一致。
  - **元数语义**：实参多于形参 → 被调函数只见前 n 个；少于 → 余下 undefined（仅 tagged；num 模式少传显式报错）。
  - **解构完备**：数组/对象 rest（`[...rest]`/`{...others}` → 宿主 `method_call slice` / `object_rest`）、元素默认值（仅 undefined 触发，新增 `qz.is_undef`）。
  - **内建类 `instanceof`**（Array/Object/String/Number/Boolean/Function/Error/RegExp/Date）→ 宿主 `qz.instanceof_builtin`；`typeof` 顶层函数名/持有闭包的变量 → `"function"`。
  差分审计 41/47（余 6 项为已记录 loud 未实现：对象字面量访问器、Symbol、函数 rest 形参、调用实参展开、POJO 动态新键、函数作对象属性值）。`test_aot.js` 223 checks ALL PASS。
- **fix(aot): 差分审计扫出的一批静默错值/合法代码 trap（可重入表达式临时槽重构）**。
  - **可重入表达式临时槽**（`_expEnter/_expLeave`，8 层 × 2×i64 + 3×i32）：此前接收者/值存在 `scratch`/`sT` 被内层表达式（`.length`/下标/拼接/嵌套字面量）覆盖 → `out.push(x.length)` 丢元素、`[[1,2],[3,4]][1][1]` 读错、`o.a.b.c` 越界读对象头。受影响点全部改专用可重入槽：数组字面量、`push/pop`、`a[i]` 读写、`o.a` 读写。
  - **属性读越界 → undefined**（POJO/类实例按 `[4]=size` 边界检查）：此前读到对象外内存 → 静默错值；非对象（数组/字符串/数字）上的普通属性 → undefined。
  - **下标读按接收者 tag 分派**：字符串键或非 wasm 数组（宿主数组/字符串/POJO/实例）→ 宿主 `qz.get_index`，wasm 数组 + 数值键 → 内存快路径（修 `"abc"[1]` / `json.a[2]` 的 trap 与错值）。
  - **`NaN`/`Infinity` 全局常量**；**`.length` 宿主回退** `qz.length_of`。
  - **位运算 ToInt32 语义**：`i32.trunc_f64_s` 对 NaN/越界会 trap → 只在安全域（非 NaN、|x|<2^31）内联，否则宿主 `qz.bor/band/...`（JS 环绕语义）。修 `NaN|0`、`1e18|0` trap。
  - **空对象**（`{}`）尺寸曾为 `Math.max()`=-Infinity → 哨兵句柄撞车（`{} === {}` 曾为 true）→ size ≥ 8。
  - **函数落空/裸 `return;` → 返回 undefined**（此前补 `unreachable` → 合法代码 `function f(){}` 直接 trap）。
  - **数值方法**（`(255).toString(16)`/`toFixed`/`toPrecision`/`toExponential`）：回退分支 + 免对齐 `clsId` 读取。
  - **变参 `concat`**（字符串/数组）取全部实参（此前只取第一个 → 静默丢参）。
  审计脚本：`/tmp/qzaux/diffrun.js` + `corpus.js`（同源 tsc 剥类型跑 JS 作 oracle，47 例独立编译差分；本轮 34/47 一致，余为已记录 loud 未实现）。`test_aot.js` 223 checks ALL PASS。
- **feat(aot): 类静态字段**（`static x = v`）。宿主表 `statics`（nameId → fieldId → tagged 值）+ `qz.statics_ready/statics_mark/static_get/static_set`；访问点 lazy 内联初始值（`_emitStaticsGuard`）。覆盖读 `C.x`、写 `C.x = v`、`++C.x`/`C.x++`/`C.x += v`、静态方法内经 `C.x` 读写、继承链静态方法（`D.bump()` 调 `C.bump` 语义）。同名于数组方法名（`C.push`）时静态方法优先于数组快路径。守门：`test_aot.js` +1（223 checks ALL PASS）。
- **feat(aot): `for...in` + 动态字符串键 `o[k]` / 修 for-of 长度被复用槽覆盖**。
  - **for-of 修复（既有静默 bug）**：循环长度原先存在 `sT[0]`，会被循环体内的字符串拼接/数组操作复用覆盖 → 第二次迭代条件读垃圾值 → 循环体只执行一次或零次（`for (const v of [1,2,3]) s+=v` 得 0）。现每层 for-of 用 3 个专用 local（句柄/索引/长度）。
  - **`for...in`**：改写为 `for (const k of Object.keys(o))` 复用 for-of 机制。
  - **动态字符串键**：`o[k]`（k 为字符串）→ 宿主 `qz.get_index`/`qz.set_index`（POJO/实例按字段名表定位、宿主对象按索引、数组/字符串走 toJS）；数值键仍走 wasm 内存快路径。
  守门：`test_aot.js` +6（222 checks ALL PASS）。
- **feat(aot): 函数内 `class`/`function` 声明提升**。声明收集改为**递归**（任意深度），嵌套类/函数提升到模块级编译；`collectClasses` 改用收集到的 ClassDeclaration 列表（不再只看文件顶层）；语句发射跳过已提升的声明。守门：`test_aot.js` +2（216 checks ALL PASS）。
- **feat(aot): 闭包共享环境实现 —— 消除「值快照」限制（`let z=5; const f=()=>z--; f(); z` 现得 4）**。此前闭包捕获是**值快照**（创建时拷贝进 cell），闭包写回对外层不可见 → 曾以编译期报错规避静默错值。现改为**链式共享环境**：每个含被捕获变量的函数/方法/lambda 建宿主对象 `env = {__parent, <var>: tagged值}`（`qz.env_new/env_get/env_set`），外层本体与其闭包共享同一 env（`__parent` 链支持嵌套闭包），写回互相可见且沿链写到「定义该变量」的层（内层不遮蔽）。lambda 值布局改为 `[funcidx][envIdx]`（捕获值不再拷贝）；箭头函数继承的 `this` 也纳入捕获（`_capturesOf` 认 ThisKeyword）。方法体（`_mEnter`）同样建 env。守门：`test_aot.js` +6（214 checks ALL PASS：z-- 可见/赋值可见/两闭包共享/嵌套链 a+=b/参数捕获 ++n/方法内 this 捕获）。
- **feat(aot): `in` 运算符 + `delete`**。`k in o` → `qz.in_op`（宿主语义；POJO/实例经物化后判定）；`delete obj.k` → 宿主对象真删（`qz.object_delete`）、POJO 槽写 undefined sentinel（等价删除），均返回 `true`（JS 语义）。守门：`test_aot.js` +5（210 checks ALL PASS）。
- **fix(aot): POJO/闭包句柄标签错位（重大静默错）+ 宿主对象 tag `0x7FFD` + POJO 物化 + 展开/void/**=/字段 ??=**。
  - **标签错位**：POJO 字面量与 lambda cell 的句柄常量写成 `i64ConstBits(0, 0x7ff9)`（= `0x7FF9<<32`，标签落在 48 位以下）而非 `0x7ff90000`（= `0x7FF9<<48`）→ 所有 hi16 判定（`typeof`/`_emitIsHandle`/`_emitIsPureNum`）对 POJO/闭包全部失效：`typeof {a:1}` 得 `"number"`、POJO 参与 `+` 走 f64 加法得垃圾。修后一致。
  - **宿主对象 tag `0x7FFD`**：`tagHandle` 值（`JSON.parse` 结果/函数/内建类实例）与 POJO `0x7FF9` 分离 → 字段读/写按 tag 分派（宿主走 `qz.object_get/set`）；`method_call` 支持宿主对象方法。
  - **POJO 物化**：POJO/实例头 `[0]=clsId`、`[4]=size`，槽 [8,size) 清零为 undefined sentinel；`toJS` 在宿主边界按字段表物化为 JS 对象（`makeQzvm(strings, { fields })`）→ 修 `JSON.stringify({a:1})` 得垃圾数值、`Object.keys/values(POJO)` 错。`==`/`===` 对对象类句柄改按 (tag|off) 身份比较（物化对象每次新建）。
  - **展开**：`[...a, x]`（wasm 内 `concat` 折叠）、`{...o, a:1}`（`qz.obj_assign` → `Object.assign`）。**`void x`**（求值丢弃）、**`x **= y`**、**字段/索引 `??=`**。
  - `is_nullish` 改按 tag 判定（不依赖字段表）；`qf.add` 用 `ret`（JS `+` 可为字符串）；`object_get`/`string_concat` 走 `ret`（字符串 → 0x7FFA）。
  守门：`test_aot.js` +14（205 checks ALL PASS）。
- **feat(aot): 宿主对象 tag `0x7FFD` + 内建类（`new Error/Map/Set/Date/Array/RegExp`）**。此前 `tagHandle` 与 POJO 共用 `0x7FF9`，宿主对象（`JSON.parse` 结果、函数值等）字段访问会**静默**读 wasm 内存得 0（`JSON.parse('{"a":1}').a` 得 0 应 1）。现宿主句柄用专用 tag `0x7FFD|handles索引`：字段读/写按 tag 分派（宿主 → `qz.object_get`/`qz.object_set`，POJO → wasm 内存），`method_call` 支持宿主对象方法（Map.get/set、RegExp.test 等），`typeof`/`truthy`/`toJS`/`_emitIsHandle`/`_emitIsPureNum` 认新 tag。连带修 `qz.add` 用 `ret`（JS `+` 可为字符串结果，原先 `box` 致 NaN）、`object_get`/`string_concat` 走 `ret`（字符串 → 0x7FFA）。内建类经 `qz.builtin` 宿主构造（`Reflect.construct`）→ 返回宿主句柄，`new Error("x")` + throw/catch + `.message`、`new Map()` set/get、`new Date(0).getTime()`、`new Array(3).length`、`new RegExp("a+").test()` 均正确。守门：`test_aot.js` +9（191 checks ALL PASS）。
- **feat(aot): `instanceof` 支持 —— 类实例引入专用 tag `0x7FFE`**。此前类实例与 POJO 共用 `0x7FF9|memoff`，无法与 POJO/宿主对象句柄区分 → `instanceof` 无从判定。现实例句柄用 `0x7FFE|memoff`（`[off:i32]=clsId`），`qz.instanceof_op(a, clsId)` 沿「实例类 → 父链」查目标 clsId（含自身）；非实例（数字/字符串/bool/null/数组/POJO/宿主对象）一律 false。连带：`_emitIsHandle`/`_emitIsPureNum`/`typeof`/`truthy`/`toJS` 认新 tag（`toJS` 按 offset 缓存稳定占位对象，保证同实例 `===` 自身）。守门：`test_aot.js` +9 instanceof 项（182 checks ALL PASS）。
- **feat(aot): 内建全局支持 —— `Math.*`/`String`/`Number`/`JSON`/`Object`/`Array` 等经通用宿主入口 `qz.builtin`**。此前 `Math.floor(x)`/`String(x)`/`JSON.stringify(x)` 一律编译报「内建 X 未实现」（AOT 只编译用户代码）。现新增单一通用 import `qz.builtin(nameId:i32, n:i32, a0..a3:i64) → i64`：宿主按名分派 JS 内建，`n` = 实际参数个数（变参函数如 `Math.max(1,2,3)` 按 n 取参，不传 undefined 占位 → 否则 NaN）。覆盖：`Math.*`（floor/ceil/round/trunc/sign/abs/sqrt/cbrt/exp/log/log2/log10/三角/atan2/pow/hypot/max/min）+ 常量（PI/E/LN2/…）、`String`/`Number`/`Boolean`/`parseInt`/`parseFloat`/`isNaN`/`isFinite`、`JSON.stringify`/`parse`、`Object.keys`/`values`/`entries`/`assign`/`freeze`/`is`/`fromEntries`、`Array.isArray`/`from`/`of`、`Number.isInteger`/`isNaN`/`isFinite`、`String.fromCharCode`/`fromCodePoint`、`Number.MAX_SAFE_INTEGER` 等常量。返回值经统一 `ret`（number/bool/string/array/句柄）。未列出者仍报「未实现」。守门：`test_aot.js` +18 内建项（164 checks ALL PASS）。
- **fix(aot): 差分审计第三批 —— 可选链 `?.`、数组方法默认参数、`sort()` 字典序、`.length` UTF-16、数字转串小数、闭包写捕获检测、内建/未实现显式报错**。续修静默语义错：
  - **可选链 `o?.x` / `o?.[i]` / `o?.length`**：此前静默返回 0（当普通访问，读 null 句柄偏移 0 → 内存 0）。现 base 求值一次，null/undefined 短路返回 undefined（不计算 index）。
  - **数组方法默认参数**：`a0/a1` 是 tagged 句柄（非 JS undefined），`a0 === undefined` 恒假 → `join()` 得 "1undefined2"、`concat()` 掺 undefined、`splice(i)` 删 0 个、`sort()` 无比较器崩。改判 `toJS(a0) === undefined`。
  - **`sort()` 无比较器**：改用引擎默认（字典序）——`[3,1,2,10]` 得 `[1,10,2,3]`（此前数值序 `[1,2,3,10]`）。
  - **`.length` UTF-16**：字符串 `.length` 曾返回 UTF-8 字节数（`"你好".length` 得 6 应 2）。新增 wasm helper `qzs_utf16len`。
  - **数字→字符串小数**：`"" + 0.5` 得 "0"（numstr 仅整数、截断）；现整数（`|x|<2^53`）走 wasm numstr，小数/NaN/Infinity 走宿主（JS String 精确）。
  - **闭包写捕获变量**：值快照语义致外层读不到（`let z=5; const f=()=>z--; f(); z` 得 5 应 4）。新增静态检测：lambda 写且外层访问 → 编译期显式报错（loud 优于静默错值）；外层不访问仍正确。
  - **未实现特性显式报错**：静态方法 `C.m()`、数组/对象解构、字段/索引 `??=`、内建全局（`Math`/`JSON`/`String`/… ）此前抛误导性「未定义捕获变量: C」或静默错值，现报明确「未实现」并指出能力边界。
  守门：`test_aot.js` 146 checks ALL PASS。
- **fix(aot): 语义精度一批 —— bool 独立 tag、null/undefined 区分、宽松 `==`/`!=`、`**`/`??`/`~`/`+`、`%` 精确、`+` 拼接 ToPrimitive、NaN truthy**。差分审计（编译 TS→wasm 对照 `new Function` 语义）发现多处**静默语义错**，逐项修复：
  - **bool 独立 tag（0x7FFC）**：tagged 曾把 boolean 编码为 f64 0/1（与 number 混淆）→ `"s"+true` 得 `"s1"`（应 `"strue"`）、`typeof true` 得 `"number"`（应 `"boolean"`）、`1==true` 得 false（应 true）。现 bool 用 NaN-box 新 tag `0x7FFC|0/1`（与字符串/数组同族 arith-inert NaN），宿主 `toJS`/`truthy` 还原真布尔。
  - **null/undefined 区分**：曾统一为 `0x7FF9|0` → `typeof null` 得 `"undefined"`、`null+1` 得 NaN（应 1，`Number(null)=0`）。现 null 用固定句柄槽 `handles[1]`（`0x7FF9|1`）、undefined 用 `handles[0]`（`0x7FF9|0`），全链路区分。
  - **宽松 `==`/`!=`**：曾与 `===`/`!==` 同走严格比较 → `1=="1"` 得 false、`null==undefined` 得 false（JS 均 true）。现 `==`/`!=` 走宿主 `qz.eq`/`qz.ne`（JS ToPrimitive/ToNumber 强制转换），`===`/`!==` 仍严格。
  - **`**`（指数）**：wasm 无原生 `f64.pow` → 新增宿主 import `qz.math_pow`（num 模式 f64→f64）/ `qz.pow`（tagged，经 toJS 解引用）；右结合语义由 TS AST 保证。
  - **`??`（nullish 合并）**：新增 host `qz.is_nullish` 判 null/undefined（不靠 tag 比对，因 null 是独立句柄）；num 模式值恒非 null/undefined → 结果恒为左操作数。
  - **`~`（按位取反）/ `+`（一元正号）**：num 模式 `~` 走原生 i32（`i32TruncF64S` + xor -1）；tagged 新增宿主 `qz.bnot`（`~(ToInt32(ToNumber(a)))`）/ `qz.to_num`（`+a`）。
  - **`%` 精确到 JS Number::remainder**：原 `a - b*trunc(a/b)` 再 `f64Neg` 把零余数 `+0` 翻成 `-0`（`2%2` JS=+0）；且除法溢出（`1e308%1e-308`）得 NaN。新实现：零余数符号随被除数（copysign via `a*0` select）、差溢出/除零/NaN 走宿主 `qz.math_rem`（fmod 全精度）、`|b|==Inf → a`。
  - **`+` 拼接 ToPrimitive/ToNumber**：`_emitConcat` 区分「纯数字」「字符串」「bool/句柄/数组」——双纯数走原生 f64 add，否则走宿主（`qz.add` / `qz.string_concat`），实现 JS `+` 的 ToPrimitive 分支（`"s"+true="strue"`、`null+1=1`、`undefined+5=NaN`）。
  - **NaN truthy**：num `emitCond` 曾用 `x != 0` → NaN 误判 truthy（`NaN?1:7` 得 1，应 7）；改 `(x!=0)&&(x==x)`。`!x` 同源修复。
  - **数组句柄标签 0x7FF8→0x7FFB**：0x7FF8 是 canonical quiet NaN（宿主 `box(NaN)` 恰产此位型）→ 任何 NaN 返回值被误判为数组 → 静默返回 `[]`。
  - **字符串入参 writeback**：`_fromJS` 曾仅处理 number、其余一律 `tagHandle` → 字符串入参得假句柄，wasm 侧 `.length`/`concat` 读垃圾。改 `_fromJS = bitsOf`。
  - **`_emitIsHandle` 收紧为「非纯 f64 数值」判定**（+ bool）；`_emitIsPureNum` 供拼接/算术区分。
  守门：`src/qzvm/aot/test_aot.js` 135 checks ALL PASS（+18 语义项：pow/`??`/`~`/`+`/`==`/typeof null/undefined/add 分支/rem 符号）。
  **已知限制（本轮未改，均 loud crash 非静默错；`?.` 已在下一批实现）**：位运算遇 NaN/Infinity 走 `i32TruncF64S` trap（JS ToInt32 应给 0/回绕）；`instanceof`/`in`/`void`/`delete`/`**=` 未实现；`typeof` 对 function 值报 `"object"`（0x7FF9 低 32 位对宿主 handles 索引与 POJO 内存 offset 同空间，无法内联区分）。
- **fix(bridge): 入站派发异常不再静默吞 —— `qz_dispatch_message` 检测 `JS_IsException` 后投递 error 帧**。此前 `qz_dispatch_message` 用 `qz_js_call_cleanup`（`JS_Call` + `JS_GetException` + `JS_FreeValue`）调用 `__qz_dispatch__`，**静默丢弃**所有未处理的分发异常——经 `qz_post_message` 触发的 eval 里如果 `__qz_dispatch__`（或其调用的 onmessage）抛异常，宿主邮箱**无任何回执**，只见超时。**触发场景**：引擎 OOM 是 quickjs-ng 的 uncatchable error（`is_uncatchable_error`，与栈溢出同类），脚本 try/catch **捕不到**，异常径直穿到 `qz_dispatch_message` 的 `JS_Call`——`memory_limit` 超限时正是此路径。现改为 `JS_Call` 后显式检测 `JS_IsException`：取异常的 `toString()`（Error 的 message/stack 非可枚举，`JSON.stringify(err) → "{}"`，须先 toString），投递 `{"type":"error","error":"dispatch-failed","detail":"Error: ..."}` 错误帧到宿主邮箱（bad-json 先例 `{"type":"error","error":"bad-json"}`）；OOM 双重失败（envelope 对象建不起来 / stringify 失败）退静态 `{"type":"error","error":"out-of-memory"}` 帧。**这是行为契约变更**：此前静默 → 现有 error 帧；消费方须能识别 `{"type":"error"}` 帧（与 bad-json / mailbox-alloc-failed 同一族，已有先例）。`qzjs.h` 的 `memory_limit` 字段注释已同步更新。守门：`test/test_host_messaging_gtest.cpp` 的 `DispatchThrowYieldsErrorEnvelope`（`__qz_dispatch__` 直接抛 → 验 detail 含异常消息）+ `OomPunchesThroughTryCatchYieldsErrorEnvelope`（`memory_limit` 限堆 → 大分配 OOM → 验 `out of memory`/`out-of-memory`）；`test/mem_limit_e2e.c` 断言从「无回执」升级为「收到 error 帧」。负控：断掉 `JS_IsException` 检测两 gtest + e2e 立刻红。
- **feat(qzvm): GC 驱动计数/暂停时长 —— 唯一入口 `qz_gc_drive` 收口三处显式驱动点（约束③ ⑥）**。此前 `"gc"` op 回执只有 `reclaimed_bytes`/`heap_bytes`，`metrics` 只有 `heap_bytes`——**没有「回收被驱动了几次、各次暂停多久」**。现把全部显式驱动点（`rt_main.c child_wake_cb` 的 `qz_gc()` msgq GC_RUN 落点 / `thread.c qz_wake_cb` / 控制面 `ctl_gc`）收口到唯一入口 `qz_gc_drive()`（`qzjs.c`：`JS_RunGC` + `uv_hrtime` 计时 + 记账），挂 `rt->gc_runs/gc_last_us/gc_total_us`（host-only）。`"gc"` op 回执与 `metrics` op 都带这三个字段。**语义边界（刻意不踩坑）**：`gc_runs` **只计显式驱动**——引擎自发的隐式 GC（`gc_threshold > 0` 的阈值路径、OOM 路径）不经 `qz_gc_drive`，故它**不是**「引擎有没有偷偷 GC」的检测器（要检那个得加引擎侧 GC hook，未做），真实用处是**跨进程核对**：宿主驱动 N 次 → RT 实际执行几次（驱动在途丢失 / 被 shutdown 丢弃会露出来）。暂停时长是 wall-clock 诊断量，不参与复现性断言。守门：`test/test_control_gtest.cpp` 的 `control_.gc_counters_track_explicit_drives`（驱动 N 次→N、单次后 total==last、两次后 total≥last、`qz_gc()` C API 同样过账、metrics 与 gc 回执同源；**负控已实测**：把 `qz_gc_drive` 的 `gc_runs++` 注释掉该用例立刻红）。实测（`build-dbg` ISOLATED，`--control-plane=local`）：空脚本 rt 连发 metrics→gc×2→metrics，`gc_runs` 0→1→2、`gc_last_us` 160/155、`gc_total_us` 160→315（=160+155），metrics 与 gc 回执一致。无 ABI 变化（`qz_config_t` 不动）。
- **feat(qzvm): 堆硬上限 —— `qz_config_t.memory_limit` 透传 `JS_SetMemoryLimit`（约束③ ⑤）**（**`QZ_ABI_VERSION` 2→3**：`qz_config_t` 尾追加字段）。此前 `qz_config_t` 只有 `gc_threshold`（**惰性触发点**：`malloc_size` 超过阈值即 `JS_RunGC`，且触发后阈值 ×1.5），**没有硬上限**——宿主无法把「不可信 JS 把进程撑爆」变成一个确定性的失败点。现透传引擎的 `JS_SetMemoryLimit`（`quickjs.h:515`，公有 API，无需 patch）：分配使堆超过上限时 `js_malloc_rt`/`js_calloc_rt`/`js_realloc_rt` 直接返回 NULL → `InternalError: out of memory`。与 `gc_threshold` 正交（一个是触发点，一个是上限），检查点在 `rt->malloc_state`（非 per-context），故首次分配前设置即可，`qz_runtime_init` 在建 context 之前接线。宿主链：ISOLATED 下经 `rt_host.c` 的 `--memory-limit` argv 传给主RT 子进程（不走 argv = 静默失效，同 gc/seed/debug 那一路的缺口，`argv[24]` 计数已相应更新为 6+16≤24）；worker 是独立 `qz_t`（config 清零），**按同一绝对值继承**——父声明上限的动机是资源约束/确定性内存包络，worker 不受限等于上限静默失效。**实测发现（未修，已在 `qzjs.h` 与 `docs/architecture/qzvm-qzjs-layering.md` 记录）**：引擎的 OOM 是 quickjs-ng 的 **uncatchable error**（`quickjs.c:1147` `is_uncatchable_error`，与栈溢出同类，实证：纯引擎下 `try{new ArrayBuffer(256MiB)}catch(e){}` 的异常照样穿出，`JS_IsException` 为真）→ 脚本捕不到；而 qzjs 的入站派发 `qz_js_call_cleanup`（`bridge.c:136`）会 `JS_GetException` + `JS_FreeValue` **静默吞掉** `__qz_dispatch__` 抛出的异常 → 超限时邮箱里没有任何回执，宿主只能看到超时。守门：`test/test_qzjs_gtest.cpp` 的 `qz_config.memory_limit_fails_oversized_allocation`（64MiB 上限下 256MiB 分配拿不到 + RT 仍存活 + 不设上限时同一分配成功作负控；**负控已实测**：注释掉 `qzjs.c` 的 `JS_SetMemoryLimit` 调用该用例立刻变红）+ 新 e2e `test/test_mem_limit_e2e.sh`/`test/mem_limit_e2e.c`（**跨 ISOLATED 进程边界**值级断言，含负控：把 `rt_host.c` 的 `--memory-limit` argv 透传断掉后立刻变红，报「竟然成功——上限没穿到主RT」）。断言刻意写成「没有成功」而非「收到 OOM 回执」，故对「今天静默」与「将来 qzjs 改成回错误帧」两种情形都成立。
- **feat(qzvm): 确定性随机源 —— 引擎 patch `JS_SetRandomSeed` + `qz_config_t.random_seed`（约束③ ①）**（**`QZ_ABI_VERSION` 1→2**：`qz_config_t` 尾追加字段）。此前 `ctx->random_state` 由时钟播种（`quickjs.c:2942` `js__gettimeofday_us()`，附上游 `TODO use getrandom()`），`hash_seed` 由它派生（`:2946`）→ `Math.random()` 与**对象属性枚举序**（哈希表支撑的对象）逐次运行不同，「相同输入 → 逐位相同输出」不成立。quickjs-ng 公有面无 seed API（`quickjs.h` 只有 `JS_SetGCThreshold`/`JS_GetGCThreshold`/`JS_RunGC`/`JS_SetMemoryLimit`），故走引擎 patch 路线（`src/qzvm/patches/engine-seed.patch`，与 DAP/bc-reader 同套路，CMake `QZVM_PATCHES` 排 #3——上下文依赖前两者）：`struct JSRuntime` 加 `random_seed` 字段 + 导出 `JS_SetRandomSeed(rt, uint64_t)`；`JS_NewContextRaw` 里 `random_seed != 0` 用它作 `ctx->random_state`，否则维持时钟播种。宿主链：`qz_runtime_init` 在建 context **之前**调 `JS_SetRandomSeed`（晚于 context 创建即无效——`hash_seed` 已派生）；ISOLATED 下经 `rt_host.c` 的 `--seed` argv 传给主RT（否则宿主设的值静默失效，同 gc/debug 那一路的缺口）；worker 是独立 `qz_t`（config 清零），按槽位派生 `parent_seed + slot + 1`——不继承则 worker 随机流不可复现（**部分**确定），全用父种子又会让各 worker 产生同一序列。CLI：`qzjs --seed=<u64>`（0 = 时钟，缺省）。实测（`build-dbg` ISOLATED）：`--seed=12345` 两跑 `Math.random()` 8 连序列**逐位相同**、`--seed=99999` 不同、无 `--seed` 两次不同。守门：`test/test_qzjs_gtest.cpp` 新增 `qz_config.random_seed_makes_math_random_reproducible`（同/异种子，THREAD 直传）+ 新 e2e `test/test_seed_determinism_e2e.sh`（**跨 ISOLATED 进程边界**，含负控：临时断掉 `--seed` argv 透传后同种子两跑立刻不同，证明该 e2e 不是恒绿）。**另发现文档/实现不一致**：`docs/api-versioning.md` 原称「追加字段不提升 ABI」，但 `qz_create` 对 `struct_size` 是**精确相等**比较（`src/host/qzjs.c:117`），追加必然使新旧头文件互斥——文档已按实现更正（en+zh）。
- **feat(aot): `--interp` —— 字符串密集型函数退解释器（str 放弃 wasm 化）**。字符串拼接/方法调用在 wasm 里每一轮都要跨 `qz.string_concat` / `qz.method_call` 调宿主 JS，跨界税吃掉全部 AOT 收益。**A/B 交替实测**（best-of-10 × 6 轮，strWork(200000)，同机）：AOT wasm 中位 **28.18ms** vs interp 回退 **26.50ms** —— wasm 零收益、回退省 ~6%，故 `bench_mix.js` 的 `str` 负载放弃 wasm 化。实现：`compileTS(…, { interp: [names] })` 把列出的函数**从 wasm 摘出去**（不 `declareFunc`/不 `emitFunc`，`funcMeta.mode = "interp"`），**调用者经传递闭包一并退**（wasm 内没有该函数索引）；`program.emit` 复用同一 AST 产出可内联的 JS（`getTypeChecker` 精确定位 `import { x as y }` 引用并重写成目标顶层函数名、剥 export 修饰符、清 `externalModuleIndicator` 以免 tsc 生成 `require`/`exports` 包装），glue 闭包内求值后 `__call` 按 mode 分派——**与 wasm 路径同一份源码，语义等价**。守门：`test_aot.js` 新增 `runInterp`（7 项：mode 标记 / 传递闭包 / 无关函数仍 num / wasm 导出表不含 interp 函数 / 产物无模块语法残留）。**不做自动推断**（用户裁决：不用太复杂），由使用者显式列名。
- **fix(aot): funcMode 判据收紧——含非 num 安全表达式的函数退 tagged（编译器崩溃预防）**。此前 `funcMode` 只看参数/返回类型注解 + 有无箭头/`new`，**漏了** body 里的属性访问、对象/数组/字符串字面量、模板表达式、类型断言等 num emitExpr **不支持**的表达式。一个 `: number` 参数函数若 body 里 `const o = makeObj(n); return o.value;`（`makeObj` 返回 `any`），funcMode 误判 `num` → emitExpr 崩溃 `不支持的表达式: PropertyAccessExpression`。现 walk 扫描 body 全部节点，任一非 num 安全表达式即退 tagged。**不是性能换语义**——是崩溃预防（不降级 = 硬错误，不是运行时慢）。num 快路径未误伤：`fib:num`、`numWork:num` 保持。守门：`test_aot.js` 全绿 + 新增 `runMultiFile` 里含 `o.value` 的 tagged 跨文件调用验证。
- **feat(aot): 多文件 TS 内联 —— 用 tsc 现成模块解析编多模块（不自己实现内联器）**。此前编译器只吃**单文件**，`import` 语句一律失败。现 `compileTS` 用 `ts.createProgram`（**tsc 自带的模块解析器**）取 `program.getSourceFiles()` 里的全部 `.ts`，把各模块顶层函数/类编进**同一个** wasm 模块——跨文件引用经解析后是同模块内的普通 `call`，无跨模块边界、无需链接器。`import { x as y }` 的本地别名折回目标导出名（新增 `Emitter._fnName`，两处 call 解析点接入）；顶层同名冲突**显式报错**（`[inline] 顶层函数名冲突: "dup" 同时出现在 a.ts 与 b.ts`），不静默覆盖（覆盖 = 调错函数，属语义错误）。逐函数设置 `em.sf` 为所属源文件，DWARF 行号不串文件。实测：`mathx.ts`（导出 `inc`）+ `mainx.ts`（`import { inc as bump }`）→ `run(40)=42`、import 面 **0**；含对象的跨文件调用 `makeObj(n)` → `o.value` 正确返回。守门：`test_aot.js` 新增 `runMultiFile`（5 项：funcs 计数 / 导出名含目标模块函数 / 别名跨文件调用 / import 面为空 / 同名冲突显式报错）。**未做**：默认导入、命名空间导入（`import * as ns`）、重导出（`export { x } from`）——显式报错而非静默降级。
- **feat(aot): 产物 import 面改为按需最小契约面（两趟发射）**（用户裁决：通用工具定位必须保证；判据 = 内联 / 外部）。此前 `registerQz` **全量注册**——只要有任一 tagged 函数或一个 class，`QZ` 表的 30 个 `qz.*` import 全进产物，`{a:1}; console.log(n)` 这种小程序也要 30 个。现 `compileTS` 两趟发射：① `Module({collectImports:true})` 采集模式，`call()`/`importFn()` 只记录实际触及的 `qz.*` 名（不登记不产字节，module 丢弃）；② 按采集子集 `registerQz(m, contract)` 后真发。（必须两趟：import 索引要在 `declareFunc` 前定妥——`funcidx = codeIdx + imports.length`，无法边发射边补登记。）实测收缩：纯数值 `fib` **0 import**（自洽 wasm，仅 `export "fib"`，任何 wasm 引擎可跑）；`tagx` 30→**1**（只 `log`；对象字面量已内联进 wasm）；`mix.ts` 30→**10**；`strwork.ts` 30→**4**；`cls.ts` 30→**8**。这正是 brain `[[aot-generic-compiler-target]]`「产物 wasm 只 import 那部分符号」的落地，使 qzjs 回到「能提供这些符号的运行时之一」而非唯一宿主。守门：`test_aot.js` 全绿（漏注册会立刻抛 `call 未定义`）；`bench_mix.js` 三负载经真实 glue 跑通。（多文件 `import` 已于同日支持，见上一条。）
- **fix(aot): 逻辑运算值语义收口 —— `&&`/`||`/`||=`/`&&=` 在 num 快路径上曾违反 JS 语义**（用户裁决：语义精度必须保证，不可用性能换）。`emitter.js` 的 num 快速路径把 `a && b`/`a || b` 编译成「两侧无条件求值 + 结果强制 0/1」，且 `a ||= b` 同理——实测 `5 && 3` 得 `1`（应 `3`）、`0 || 7` 得 `1`（应 `7`）、`let x=5; x ||= 9` 得 `1`（应 `5`）、`let x=0; x ||= 9` 得 `1`（应 `9`）。除值错误外还破坏了**短路副作用语义**（右侧本不该求值却求值了）。现两模式统一为真短路 + 值语义：`a && b ≡ truthy(a) ? b : a`，`a || b ≡ truthy(a) ? a : b`；num 路径用 `block(f64)` + `brIf` 实现（零 import、零跨界，性能不退化），tagged 路径沿用既有正确的 `emitShortCircuit`；两处逻辑复合赋值同样改为「写回 + 值语义」。守门：`test_aot.js` 新增 `and_val`/`or_val`/`or_assign`/`and_assign` 四组断言（`node src/qzvm/aot/test_aot.js`）。**原则**：此后任何「简化掉 JS 语义以换快路径」按缺陷处理，不按 tradeoff 记录。
- **feat(qzvm): 确定性 GC —— 显式回收驱动 `qz_gc()` + 控制面 `"gc"` op，默认关掉引擎阈值隐式 GC**（约束③首批落地，docs/architecture/qzvm-qzjs-layering.md §2）。此前 GC 触发点由分配压力决定（quickjs-ng `malloc_gc_threshold` 256KB 初值，`js_trigger_gc` 超阈即回收并抬到 1.5×）→ 触发时机随分配历史漂移，同一脚本两遍运行的堆峰值不同。现在默认 `qz_config_t.gc_threshold == 0` 时 `JS_SetGCThreshold(rt, (size_t)-1)` **关掉阈值隐式 GC**：引用环只在两个确定点回收——C API `qz_gc(rt)` 或控制面 `{"op":"gc"}`，二者均落事件循环 **WAKE_SAFEPOINT** 就地 `JS_RunGC`（新增 msgq `QZ_MSG_FLAG_GC_RUN`，由 `rt_main.c` child_wake_cb / `thread.c` qz_wake_cb 的 flags 分割点消费，不入 JS、不回执）。ISOLATED 下驱动跨进程：宿主发 CONTROL `{"qzjs":1,"gc":1}`（`QZ_IPC_CTL_GC_MSG`，`qz_ipc_ctl_classify` 新 kind `QZ_IPC_CTL_GC`）→ 主RT 读回调转 msgq。**刻意不经控制面路由**（`qz_control_route` 受 `control_plane` 档位门控，OFF 档静默丢），使 GC 驱动与「暴露不暴露控制面」正交——OFF 档下 `qz_gc()` 仍生效。可观测：控制面 `"gc"` op 回执带 `reclaimed_bytes`（`JS_ComputeMemoryUsage` 进/出差值）与 `heap_bytes`；`qz_gc()` 只保证「已入队到确定点」（返回 0），回收量须经控制面读。`gc_threshold > 0` 是显式选择的阈值安全网（接受非确定触发点），ISOLATED 下由 `rt_host.c` 经 `--gc-threshold` 透传主RT 子进程（否则宿主经 `qz_config_t` 设的值静默失效，同 debug 那一路的缺口）。实测（`build-dbg` ISOLATED + `build-thread` THREAD）：造 3000 个自引用环 → `heap_bytes` 809KB→13.67MB → `{"op":"gc"}` 回 `reclaimed_bytes:12864088` → 回落 809KB；宿主 `qz_gc(rt)` 后主RT 子进程 RSS 26084→5448 kB（`qz_gc(NULL)`=-1）。默认档无宿主驱动时堆不回落（隐式 GC 确已关闭）。未做：种子注入（`Math.random()`/Map-Set 迭代序仍不确定）、GC 触发/暂停计数、`JS_SetMemoryLimit` 透传。
- **feat(qzvm): WAMR 源码级调试通道（debug-interp / GDB RSP）接通**。此前 qzjs 跑 wasm 模块无任何调试手段——`WASM_ENABLE_DEBUG_INTERP` 默认 0，宿主侧既无启用开关也无接线。新增 CMake 选项 `QZ_WITH_WAMR_DEBUG_INTERP`（默认 OFF）：开启后 qzjs 传 `WAMR_BUILD_DEBUG_INTERP=1` 并**提前**把 `WAMR_BUILD_FAST_INTERP` 置 0（WAMR 上游 `runtime_lib.cmake` 的降级发生在按 FAST_INTERP 选好 interp 源之后，属顺序 bug，会在 debug 构建里编进 fast-interp 源而结构体缺字段编译失败——已在 qzjs 侧规避，未改 submodule）。宿主侧 `src/qzvm/ext_wamr.c`：`wamr_ensure_runtime` 在调试构建下改走 `wamr_runtime_full_init` 并填 `ip_addr`（debug-engine 只在 full_init 的 ip_addr 非空时初始化，否则 `wasm_runtime_start_debug_instance*` 因 `g_debug_engine==NULL` 恒返 0），每个 bytecode `WebAssembly.Instance` 构造后调 `wasm_runtime_start_debug_instance_with_port` 绑定 cluster 的调试实例；端口/宿主由 `QZ_WAMR_DEBUG_PORT`（0=自动，启动时打印到 stderr）/`QZ_WAMR_DEBUG_HOST`（默认 127.0.0.1）控制。**边界**：WAMR 对 AOT 实例直接拒绝（实测打印 `Attempt to create a debug instance for an AOT module` 并返回 0）——glue 默认优先 `.aot`，故调试须走纯 `.wasm`/bytecode 路径；源码级行映射由编译器产 DWARF 提供（见下条）。验证：`build-dbg`（`-DQZ_WITH_WAMR_DEBUG_INTERP=ON`）下裸 GDB-RSP 客户端跑通全链——`qSupported` 应答 → 首停 `T05`（`reason:trace`）→ `Z0` 断点设成功 → `c` continue → 命中 `T05 ...reason:breakpoint`；另实测 AOT 模块拒绝路径。文档见 `docs/dev/debugging.md`「Debugging a WebAssembly module」。
- **feat(aot): TS→wasm 编译器产 DWARF 调试段（源码级断点/行映射）**。此前 `--debug` 只产 name 段，AOT/源码级调试缺位置映射——WAMR debug-engine 只报 wasm 偏移 PC，无 DWARF 则 `break file.ts:N` 无从对应。新增 `src/qzvm/aot/wasm-dwarf.js`（纯 JS，产 `.debug_abbrev/.debug_info/.debug_line/.debug_str`，DWARF4、addr_size=4）+ `emitter.js` 语句级 `markLine` 累积（`compileTS` 传 `em.sf`）。**地址约定（实证）**：DWARF 地址 = code 段 payload 起始的相对偏移（与 clang wasm 后端一致：`low_pc 0x2`↔file 65，code-content 63）；WAMR GDB server 报的 PC 是文件绝对偏移，lldb 侧加 code 段文件偏移重定位。端到端：`strWork`（code-content @542）DWARF 行 `0x216`(L4)/`0x34d`(L5) → 断点地址 `0x434`/`0x56b` → 均命中 `T05 reason:breakpoint`。验证：`llvm-dwarfdump-14` 干净解析；`test_aot.js` 新增 `runDwarf` 回归门；无 `--debug` 时零调试段。
- **test(qzvm): WAMR debug-interp（GDB RSP）全链回归门入仓 + CI**。源码级调试通道此前仅 `/tmp` 手验、CI 不跑：`ext_wamr.c` 接线 / RSP 帧 / DWARF 地址约定一改无人发现。新增 `test/test_wamr_debug_rsp.sh`（debug 构建 → 编译 `strw --debug` → 纯 `.wasm` 加载 → 从 DWARF 行表取行地址 → 裸 RSP 断点 → 断言 `reason:breakpoint`）+ `test/wamr-debug-e2e/rsp_break.py`（GDB-RSP 客户端）。守「DWARF 地址（code 段 payload 相对）+ code 基址 = WAMR 文件绝对 PC」约定：任一侧漂移则断点不命中。`build.js` 增 `--no-aot`（glue 只加载 `.wasm`）——WAMR debug-interp **拒绝 AOT 实例**（「设备现场 wamrc 编译」的 AOT 产物不受影响，仅调试运行走 bytecode；AOT 路径默认不变）。CI 新增 job `wamr-debug-rsp`。验证：本地全链 PASS（17 个 DWARF 行地址，code 基址 `0x21e`，命中 `T05 reason:breakpoint`）；`test_aot.js` ALL PASS；默认 glue 仍引用 `.aot`。
- **test(qzvm): WAMR 源码级调试端到端实证（lldb 消费 DWARF → `b file:line` 命中）**。补上此前唯一未验环：定制 lldb 是否真能消费我们产的 DWARF。用 WAMR 官方**预编译** `wamr-lldb`（`WAMR-2.2.0`，Ubuntu 22.04 资产，lldb 13.0.0）连 GDB-RSP：`process connect -p wasm connect://…` → `b strwork.ts:4` → lldb 从远端模块读 DWARF 解析出 `address = 0x4000000000000434` → **`stop reason = breakpoint`**，与 RSP 层手算地址一致。新增 `test/test_wamr_debug_source.sh`（lldb **非依赖**：缺则 SKIP exit 0）。**lldb 须 patch**：stock lldb 无 wasm 调试能力，需 `deps/wamr/build-scripts/lldb_wasm.patch`（5906 行/61 文件，源自 LLVM D78801 `WasmProcess` 插件，基线 LLVM `release/13.x`）——预编译版已含，免自编。`.tools/` 加 gitignore（下载物不入库）。
- **fix(qzvm): 导出 `WebAssembly.Memory.buffer` 改为活 getter（非快照）**。此前 instantiate 时缓存一个固定 ArrayBuffer，WAMR 增长/搬迁线性内存后（guest `malloc`、`memory.grow`）其 `byteLength` 卡死 → 宿主越界读写静默出错。现 `exports.memory` 为 `wamr_memory_class` 对象，`buffer` 是 getter：每次重查 WAMR 当前 base/size；页数与 base 未变时返回同一 buffer（`mem.buffer === mem.buffer` 稳定），变化时 `JS_DetachArrayBuffer` 旧 buffer（浏览器 neuter 语义，旧视图 `byteLength` 变 0）再建新的。顺带删除死的 `wamr_mem_owner_t`/realloc shim、修 `buffer` atom 泄漏、getter 改用 `JS_NewCFunction2(JS_CFUNC_getter)`。**不提供** host 侧 `Memory.grow()`：WAMR 折页表示下 `cur_page_count` 含折入的 app heap（实测 `(memory 1 4)` 报 129 页），旧页数返回不合约语义；guest 侧 `memory.grow` 照常工作。验证：新增 `test_wasm_aot.memory_buffer_is_live_across_grow`（已证伪旧快照行为：快照实现下 `grew=false detached=false`）；ctest 32/32 绿；qzjs 作宿主跑 guest malloc 增长 3→9 页、旧视图 byteLength=0、高位可写。
- **test(qzvm): in-module guest 回流 harness 入仓 + CI**。M4/M5 的运行验证此前只是 `/tmp` 一次性脚本（不入仓、CI 不跑），guest 导入面或回流协议一改无人发现。新增 `test/test_inmodule_guest_e2e.sh`（配置 + 构建 `qzvm-guest` → node WASI 宿主 shim 实例化 `libqzvm.wasm` → 断言）+ `test/inmodule-e2e/host.mjs`（实现 `qz_host.fs_read`/`drain`，宿主无 JSContext，仅 ptr+len 搬字节）覆盖三条路径：异步读成功回流、ENOENT 拒绝、两个并发 op 按 `op_id` 派发（顺序无关）。CI 新增独立 job `in-module`（clang/lld/wasi-libc + node）。验证：全新 build 目录 `bash test/test_inmodule_guest_e2e.sh` 自包含跑通（~30s）。
- **feat(qzvm): guest 异步回流跑通——`fsRead` + tick 拉模型（M5）**。`src/qzvm/guest_entry.c` 加 M5 proof：`fsRead(path)` 原语（建 Promise，`qz_host_fs_read` 发起异步读，resolve/reject 存 guest 内 op 表持 JSValue）+ `qz_tick` 去自旋（每轮 `qz_host_drain` 拉一批完成事件 `{op_id,status,len,data}` → 按 op_id 找 op 槽 → `JS_Call(resolve|reject)` → return，宿主下轮再调）+ 结果读出导出 `qz_result_ptr`/`qz_result_len`。这是 §10.4「import 拉」选型的真机验证：**host 无 JSContext，JSValue 只存 guest**，host 经队列回流。导出名 `libqzvm.wasm`（`SUFFIX .wasm`/`PREFIX lib`）。验证：node WASI 宿主 shim（真异步 `fs_read` + drain 队列）跑 `fsRead('/tmp/qzm5/data.txt').then(...)` → tick×2 → 结果 `"OK len=33 head=hello from host file"`；reject 路径 `fsRead(NOPE.txt)` → tick×1 → `"ERR ENOENT…"`；native 32/32 ctest 绿。限制（M6 消除）：单 rt（op 表 static）、单事件 ≤512B、仅 1 个原语（43 个 `js_pal_*` 全量移 guest 属 M6）。
- **feat(qzvm): wasm32-wasi guest target——`qzvm-guest` / `libqzvm.wasm`（M4）**。新增 `cmake/wasm32.cmake` 工具链（clang `-target wasm32-wasi --sysroot`，Debian wasi-libc 或 wasi-sdk；`-nodefaultlibs -lc -lm` 绕 Debian 缺 libgcc；reactor `-mexec-model=reactor` 无 main）+ `qzvm-guest` CMake target（`src/qzvm/CMakeLists.txt` 内 `if(QZ_IN_MODULE)`）。源集 = 内核三源（`context.c`/`vm_core.c`/`ext_lifecycle.c`）+ 新增 `guest_entry.c` + quickjs-ng（`qjs`），宿主源/扩展/polyfill 不进；`QZ_VM_GUEST` + `QZ_WITH_*=0` 由 target 下发。产物 `libqzvm.wasm` 导出 `qz_create`/`qz_eval`/`qz_tick`/`qz_destroy`（经 `__attribute__((export_name))` 映射 `qz_guest_*` C 符号，避免与宿主侧 `qz_create`/`qz_destroy` 同名）+ `memory`/`malloc`/`free`；import 段含 `qz_host.drain`（§10.4 tick 拉模型真实引用，非占位）。`guest_entry.c` 的 `qz_tick` = 内核 `qz_tick`（排空微任务）+ `qz_host_drain`（拉 host 完成队列）；pal/polyfill/扩展接线留 M5/M6。裁决：M4 产独立 guest `.wasm`，与 AOT 静态 wasm 合并延后（等 M5 真跑通）。验证：`cmake --build build-inmod --target qzvm-guest` → `libqzvm.wasm` 链接成功（wasm-objdump 验导出/导入段）；native 32/32 ctest 绿；`-DQZ_VM_GUEST -fsyntax-only` 内核源+guest_entry 零 error。

- **fix(host): 补回 M2 重构丢失的 `qz_ctx_rebuild` 错误码返回与 `qz_ctx_spawn` 的 `free(err)`**。M2 把 `qz_ctx_rebuild` 从 `context.c` 搬入 `ctx_orchestrate.c` 时漏掉失败路径的 `return rc;`，函数在 resume 读盘失败时错误返回正数 `ctx_id`，导致 `qzContext.resume` 静默"成功"、不抛错（`test_suspend_gtest.resume_bad_state_path` 回归红）；同批 `qz_ctx_spawn` 的 `qz_eval_internal` 失败路径漏掉 `free(err)`，泄漏错误串。两处已补回，语义与 M2 前一致。验证：`test_suspend_gtest` 12/12 绿，全 32 ctest 绿。
- **refactor(qzvm): tick 原语上移内核——`qz_flush_microtasks` → `qz_tick`（M3）**。`while (JS_ExecutePendingJob) > 0` 的排空原语从 `src/host/thread.c` 上移 `src/qzvm/vm_core.c`，更名 `qz_tick`（纯 quickjs、零 libuv，是 in-module guest 最小内核集的一部分，§5.3/§5.4），旧名与旧定义删除。全部调用点统一：`thread.c`（`qz_loop_idle`/消息派发/主循环）、`worker.c` 主循环、`rt_main.c` 主循环，以及 `qzjs.c` teardown 两处内联的 `JS_ExecutePendingJob` 循环（原文档指为复用点，已收敛到 `qz_tick`）。验证：32/32 ctest 绿，微任务冒烟（`Promise.resolve().then`）通过，`QZ_VM_GUEST` 下内核三源照编。
- **refactor(qzvm): context.c 拆分——边界接线移出内核，新增 `host/ctx_orchestrate.c`（M2）**。内核 `src/qzvm/context.c` 现只做 realm 生命周期（`qz_ctx_create`/`qz_ctx_create_at`/`qz_ctx_destroy`，均零 pal/polyfill/ext 调用）；pal 构建、polyfill 装载+注入、扩展 init、timer 句柄清理与多 context 编排（spawn/serialize/rebuild/destroy_id + 文件 I/O）全部移入新文件 `src/host/ctx_orchestrate.c`，暴露 `qz_ctx_wire_up`（边界接线，失败回滚）、`qz_ctx_create_host`（create + wire_up）、`qz_ctx_destroy_host`（扩展 destroy + 资源清理 + 内核拆 realm）；宿主（`qzjs.c` 建/拆、`bridge.c` spawn/serialize/rebuild/destroy）改走 host 包装。删死码 `qz_inject_polyfill_ctx`（`bridge.c` 零调用者，仅 `qz_rt.h` 声明）。验证：全 32 ctest 绿（含 context/suspend/composition gtest），`qzjs -e` 冒烟通过。
- **perf(aot): 字符串性能根因是 wasm→JS 串转换（`qzvm._utf8`），非 WAMR AOT codegen——1MB 串 100ms→30ms**。定位：`strWork(200000)` 循环本体仅 4.7ms，其余 ~90ms 全在返回值的 wasm 串→JS 串转换。旧 `_utf8` 逐字节 `r += String.fromCharCode(c)`，每字符一次 JS_ConcatString（QuickJS 无 rope）→ 1MB ≈ 100ms+。改为：① ASCII 快路径（绝大多数场景）——`Uint32Array` 4 字节批量测高位，命中则 `String.fromCharCode.apply(null, u8.subarray(...))` 直接构造，免逐字节解码；② 非 ASCII——逐字节解 UTF-8 → UTF-16 code unit 到定长缓冲，每 65535（`apply` 参数上限）一次 `fromCharCode.apply`。实测：`o1(400k)` 73ms→**12.5ms**（~6x，1 字节追加 400k 次建 400KB 串）；`strWork(200000)` 93ms→**30ms**（~3x，1.09MB 串）。回归 `test_aot.js` 增 `mix.utf8Str()`（非 ASCII/代理对）与 `mix.bigAscii()`（>65535B 走分块路径）。附带更正：此前误判「WAMR AOT 比 V8 慢 12x」——同 wasm 在 node(V8) 快是因 V8 的 `+=` 有 rope 优化，瓶颈在 JS 侧转换而非 wasm 执行。
- **fix(aot): `qzs_numstr` 负数产出垃圾 + 补齐 6 个缺失的 i64 比较 opcode**。①`qzs_numstr` 用无符号 `i64DivU`/`i64RemU` 且不处理符号 → `s + (-42)` 得 `"18446744073709551574"`；改为按符号取绝对值、负数前置 `-`，并加 i32 快路径（值 ≤ `0xFFFFFFFF` 走硬件 i32 div/rem，大值回退 i64）。②`OP` 表缺 `i64_gt_s`/`i64_gt_u`/`i64_le_s`/`i64_le_u`/`i64_ge_s`/`i64_ge_u`（0x55–0x5A）→ 这些方法 emit `undefined`，`_emit` 把 `undefined` 写进 code 段变成 `0x00`（unreachable）字节，属静默地雷；补齐。③补 `i32LtU`/`i32GtU`/`i32LeU`/`i32GeU` encoder API（此前缺失）。④`qzs_memcpy` 逐字节 → 8 字节块 + 尾字节。回归 `test_aot.js` 增 `mix.negNumStr()`（`-42|-7|5000000000`）。
- **feat(aot): `qzvm` 数组方法 + tagged 字面量 + 数组 `.length=`**。①`split` 由返 JS 句柄（`0x7FF9`）改为返 wasm 原生数组（`0x7FF8`）——此前 wasm 侧 `.length`/索引落到 `qz.str_len` 读垃圾，`"a,b,c".split(",").length` 静默返回 0；`toJS` 加 `0x7FF8` 解码；宿主 `method_call` 加数组分派 `doArrMethod`，覆盖 `indexOf`/`lastIndexOf`/`includes`/`join`/`slice`/`concat`/`reverse`/`shift`/`unshift`/`map`/`filter`/`reduce`/`forEach`/`find`/`findIndex`/`some`/`every`/`sort`/`splice`/`fill`，回调经 `qz.closure_call` 调 wasm 箭头函数，原地改写类方法保句柄别名。②tagged 路径补 `true`/`false`（f64 0/1 位型）、`null`/`undefined`（句柄 `0x7FF9|0`）；此前抛「不支持的表达式」。③数组 `.length=` 赋值经新宿主 import `qz.arr_set_len`（截断/扩容补 undefined）。回归：`mix.arrMethods/arrAlias/splitIndex/literals/arrLengthSet`。
- **feat(aot): 类实例分配内联到 wasm（构造热路径 ~73x）+ fix: 成员自增/自减（`++this.n` / `this.n--`）**。①此前 `new C()` 经宿主 `qz.newobj` 跨界分配（JS↔wasm + BigInt 装箱），构造热路径税盖过一切；改为 `_emitNewCall` 内联 bump 分配（`off=(bump+7)&~7`，写 `[off]=clsId`，句柄 `0x7ff9<<48|off`），与 POJO/数组同款零跨界。clsbench（50000 次 new+方法调用）实测 **34.4ms → 0.47ms ≈ 73x**。死代码 `qz.newobj`（import 声明 + 宿主实现 + 导出）一并删除。②tagged 更新表达式（`++`/`--`）原只认同标识符操作数（`this._local(e.operand.text)` 对属性访问取到 `undefined`）→ `++this.n` 产 NaN、`this.n++` 产 undefined；新增 `scratchObj`（i64）槽存接收者句柄，成员目标时接收者求值一次→读字段→`emitGuardedOp` ±1→写回，前置返新值、后置返旧值；三处局部槽布局（`emitFunc`/lambda/`_mEnter`）同步追加。回归 `test_aot.js` 增 5 断言（前置/后置自增自减字段 + 字段自增循环），旧代码下全 FAIL、修后 40/40 全 PASS。
- **feat(aot): 类方法静态分派优化 + 修 3 个随之暴露的既有缺陷**。识别静态精确接收者的方法调用（`let/const x = new C(...)` 且 x 全程未被写、未被闭包捕获；或叶类内 `this`），沿父链解析方法 owner 后直调导出 `__m_<Owner>$<m>`，跳过 `qz.method_call` 跨界。修 3 个缺陷：①`qz.truthy` 经 `toJS` 判定——类实例/POJO 句柄（`0x7FF9|偏移`）不在 JS handles 表中，`toJS` 取到 `undefined` 误判 falsy，`if(obj)`/`&&`/`||`/`&&=`/`||=` 全反；改为按 tag 直接判。②`_emitDynMethod` 用固定局部槽 `scratch`/`cloArgs[i]` 暂存 self+实参——嵌套调用（实参本身是方法调用）互相覆盖致接收者取错；改纯 wasm 值栈（按深度天然隔离）。③`_computeStaticVars` 依赖 `child.parent` 回链判断赋值目标——`compileTS` 走 TS transformer 重建节点后回链失效，`x &&= d` 的 `x` 漏剔、仍走静态直调；改为遍历到写节点时主动取 `n.left`/`n.operand`/`n.initializer`。回归 `test_aot.js` 增 3 断言（实例真值 / 逻辑赋值动态化 / 嵌套实参），旧代码下全 FAIL、修后全 PASS。
- **fix(wasm): WAMR SHRUNK_MEMORY 下 memory 导出长度按真实页大小推导（此前硬编码 64 KiB 规范常量导致 undershoot）**。WAMR 的 SHRUNK_MEMORY 优化把声明的页数折进 `num_bytes_per_page`、`init_page_count` 塌缩为 1；导出 shim 原用 `num_pages * 65536` 算 buffer 长度，整数倍 undershoot，暴露的 ArrayBuffer 短于实际线性内存。改用 `wasm_memory_get_bytes_per_page(mem)` 推导。新增回归门 `test_wasm_aot_gtest.shrunk_memory_export_length`（内联 wasm fixture：声明并导出 memory 32 页、无 `memory.size`/`memory.grow`，poke/peek 验证最后页仍可读写）。
- **feat(aot): 字符串 wasm 内原生表示 + 原地追加（AOT 编译器字符串后端落地）**。此前 tagged 路径的 `s = s + i` 每轮经 `qz.add` 跨 wasm↔JS 边界（JS 拼接 → 新 handle），实测慢解释器 14x（0.07x），跨界税盖过执行收益。改为 wasm 内原生字符串：句柄高 16 位 `0x7FFA`（区分对象 `0x7FF9`），低 32 位 = data 段/堆 offset，内存布局 `[len:i32 LE][utf8 字节]`。字符串字面量编译进 wasm data 段（去重，零跨界）；`s+x` 经 `qzs_append`——缓冲在 bump 顶则**原地追加**（零拷贝），否则新建拷贝；数字→十进制走 `qzs_numstr`（wasm 内 i64 div/rem 循环 + 反转）；`+` 运算运行时按 `(v>>48)==0x7FFA` 判别，a 数 + b 串回退 `qz.string_concat`。qzvm `_toJS` 读线性内存解 `0x7FFA` 句柄，UTF-8 手写解码 + `DataView` 位型（去 `Buffer`/`TextDecoder` 依赖，真 qzjs 运行时无这些全局）；glue 调 `qz.bindMem(exports.memory)`。顺带支持复合赋值 `+= -= *= /= %=`（原仅 `=`，`+=` 走字符串/数值拼接）。修 4 个既有编码缺陷：`i64.shr_u` 移位量误写 `0x7FF9`/`0x7FFA`（应 48）、`qzs_numstr` 返回值残留栈致 if 分支类型不匹配、`i64.trunc_f64_s` 误用 `0xAF`（实为 `0xB0`）、拼接数字操作数缺 f64→i64 转换。`test_aot.js` 加 4 条字符串断言，全 23 检查 ALL PASS；`strWork(200000)`=80ms/1.08MB（真字节写 vs node V8 rope 惰性 10ms）。
- **fix(wasm): 修复 i64 导出桥接（BigInt 参数/返回值）——AOT tagged 负载此前在真 qzjs 下必崩**。曾观察到「真 qzjs 跑 AOT tagged 报 `WebAssembly function: invalid i64 argument 0`」，根因在 `ext_wamr.c` 导出调用边界：参数用 `JS_ToInt64`（**拒收 BigInt**，而规范要求 wasm i64 在 JS 侧就是 BigInt），返回值用 `JS_NewInt64`（>2^31 转 float64，**毁掉 NaN-box 位型**——句柄高 16 位 `0x7FF9`/`0x7FFA` 恰在 int64 高位）。改为参数 `JS_ToInt64Ext`（接受 BigInt）+ 返回 `JS_NewBigInt64`（保 64 位整数）。修后真 qzjs 可跑 AOT tagged：`strWork(8)=001234567`、`objWork(5)=40`、`bigAcc(3000)=3e12`（>2^32 精度保持）。import 侧（wasm→JS 传 BigInt、JS→wasm 用 `JS_ToInt64Ext`）原本已正确。新增回归门 `test_wasm_aot_gtest.export_i64_bigint_roundtrip`（wat2wasm fixture `id64`/`add64`/`hi`，断言参数到 JS 为 bigint、结果回 BigInt、超 2^31 值精确）；反向验证旧代码该门必失败。
- **feat(aot): 类支持（继承 / `super()` / 字段默认值 / 方法动态分派）**。AOT tagged 路径此前只有函数与闭包，`class`/`new`/`extends` 一律 `不支持的表达式`。新增：`_emitNewCall`（`qz.newobj(size, clsId)` bump 分配实例，内存 `[0]=__cls`，再调 `__m_<C>$ctor`）；`_emitSuperCall`（self=local0，调父 ctor 后回写本类字段默认值，模拟 JS 派生字段初始化序）；`_emitDynMethod`（统一走 `qz.method_call(recv, mid, a0..a3)`，qz 侧按 recv 类型派发：字符串→`str_method`，类实例→`classMeta[clsId]` 沿父链查方法名调 wasm 导出）。字段表 `fieldMap` 在 `collectClasses` 阶段预登记全部类字段（发射期任意时刻 `_instSize` 均覆盖），POJO 与类共用一个全局字段表。ctor 与方法统一 `self+4` 固定实参签名（原按参数个数变化，导致 `super()`/跨参调用签名不匹配、wasm 校验失败），独立方法上限 4 参；合成派生 ctor 转发全部参数槽到父 ctor（此前丢参，`new Puppy("bit")` 名字丢失）。`funcMode` 遇 `new` 自动降级 tagged（num 快路径不支持）。导出 `memory` 与 `__bump` 供 glue `bindMem`/`bindBump`；glue 注入 `classMeta` 并调 `bindClasses`。修两处既有缺陷：`_emitFieldDefaults` 缺 `i32.wrap_i64`（self 句柄直接当 i32 地址，wasm 类型不匹配）；`qz.newobj` bump 偏移未 8 字节对齐（`Int32Array` 视图抛 offset 非 4 倍数）。回归门 `test_aot.js` 加 `runClasses`（`cls.ts`：继承+super、遮蔽字段、多参动态分派、合成 ctor 转发参）。
## [0.4.0] — 2026-10-06

> 发版清积压：自 0.3.0（2026-10-02）以来 16 个 PR，无 breaking（ABI v1 未动）。
> 本轮以「补覆盖」逼出并修复 4 类缺陷：CA 信任库跨进程失效、worker 两后端不一致、
> worker 异步工作被截断、`free_port()` 名不副实；另加两道测试门（mock 构建警告、
> qz_config_t 跨进程传递门）。

- **build: 撤掉 `QZ_QJSC_HOST` / `QZ_LZ4_HOST` 交叉构建出口**。这两个 cache 变量是给交叉构建用的宿主工具出口（polyfill 字节码生成器 `qjsc` 与压缩器 `qz_lz4_compress` 在交叉构建里是目标架构二进制，宿主跑不了）。但项目范围已定为 **Linux-only**（`brain/pages/platform-support.md`，2026-10-03 用户拍板）：`qz_message_fd()` 返回 Linux 特有的 `eventfd`、控制面用 `AF_UNIX` + `SO_PEERCRED`、io_uring 须显式禁用——交叉构建本就无消费者，而该页明写「不需要抽象层或条件编译去兼容别的平台（YAGNI）」。为一个已声明不支持的场景留 54 行构建分支，属净负债：删优于加。故整块移除（`CMakeLists.txt` 完全还原到该 PR 之前的状态）。
- **feat(tls): 新增运行时 CA 信任库 `qz_add_ca_pem()`**。TLS 客户端此前只从四个固定系统路径（Debian/RHEL/OpenSUSE/FreeBSD）加载 CA，宿主无法为自建 CA / 私有 PKI 增补信任根。`qz_add_ca_pem(rt, pem)` 让宿主追加 PEM 证书；TLS op 建连时把它**追加**进系统 CA 之后——只增加信任根，**不替换系统信任**（自建 CA 与公有 CA 同时有效）。证书校验本身不变：恒为 `VERIFY_REQUIRED` + 主机名校验，验证失败一律握手失败；本函数**不提供**跳过校验的开关（那会扩大攻击面）。可重复调用；定义刻意不在 `QZ_WITH_TLS` 条件编译内（公共头无条件声明，`test/api_surface_check.py` 要求两个编译模型都有符号）。线程约束：须在 JS 开始执行前调用（无锁）。回归测试 `test/test_tls_ca_gtest.cpp` 调用**生产函数** `uv_io_tls_load_host_ca()` 而非复现 parse——长度约定（`ca_pem_len` 不含末尾 NUL、传参 +1）是这里唯一的 off-by-one 风险点，负控已验证：去掉 `+1` 测试立即变红。

- **test: 新增 `test/config_propagation_check.py`——qz_config_t 跨进程传递门**。ISOLATED（默认进程模型）下 runtime 只存在于 spawn 出的 `qzjs-rt` 子进程（宿主进程只有通道桩），宿主经 `qz_config_t` 设的任何值若没被显式传递就**静默失效**：没报错、没降级提示。`config.debug` 就这么丢的（宿主设 `cfg.debug` 启用 DAP，子进程曾硬编码 0），而 CLI 一直没暴露——它走 `QZ_DEBUG` 环境变量，受损的是库宿主。本门强制「加字段必须接线」：`qz_config_t` 每个字段要么出现在 `rt_host.c` 的 argv/env 组装或 `rt_main.c` 的 argv 还原路径上，要么进白名单并写明理由。当前 13 个字段中 8 个已接线、5 个在白名单（`struct_size`/`abi_version` 是宿主侧本地 ABI 门控；`initial_script_path` 在 `qz_create` 期已折叠为 `initial_script`；`sandbox_root`/`env_allowlist` 经 `QZ_STRICT_SANDBOX`/`QZ_STRICT_ENV` 传递但存入不同名的 `rt->strict_root`/`rt->strict_env_allow`，故判据看不见）。负控已验证：注入一个未接线字段即变红并指名该字段与修法。
- **fix(cli): mock-libuv 构建的 `qzjs` 启动时打警告——堵住「看起来正常却没网络」的陷阱**。`-DQZ_BUILD_TESTS=ON` 构建出的 `qzjs` 链接 `mock_libuv`：`uv_tcp_connect` 同步返回成功但没有真实套接字，`uv_read_start` 等预注册的 canned 响应——没有就永不完成。于是 `fetch`/TCP/`fs` **静默挂起**，无任何报错。这个二进制只供 gtest 链接与本地跑纯计算脚本用，真实 I/O / 进程 / ISOLATED 路径全不工作。但此前没有任何东西提示这一点——#9 就被它骗过：proxy e2e 全挂，以为是 TLS 问题，实际是那台二进制根本没网络能力。修法：`main()` 入口在 `#ifdef QZ_USE_MOCK_LIBUV` 下向 stderr 打一条说明，让人跑 `./qzjs ... fetch ...` 的瞬间就知道该换 `QZ_BUILD_TESTS=OFF` 构建。真实构建无该宏，零输出。警告走 stderr 不污染 `console.log`；gtest 直接链 `libqzjs.a` 不调 `qz_cli` 二进制，自动化零影响。
- **fix(dap): 宿主的 `qz_config_t.debug` 在 ISOLATED（默认进程模型）下静默失效**。`debug` 是公共 API 字段（"沿用 DAP bit 语义"），`qz_runtime_init` 的 DAP 自动 attach 判定读 `rt->config.debug & 0x2`——但 runtime 只存在于 `qzjs-rt` 主RT 进程（宿主进程只有通道桩），而 `rt_main.c` 此前把子进程的 `rt->config.debug` **硬编码为 0**。于是库宿主设 `config.debug` 启用 DAP，在默认构建下毫无效果且无任何诊断。CLI 一直没暴露这个缺口，因为它走 `QZ_DEBUG` 环境变量（子进程 exec 继承 environ）；**受害者是库宿主**，而那正是 qzjs 的主要使用场景。修法沿用既有 argv 协议（`--worker-backend` / `--control-plane` / `--control-pipe` 同款）：宿主在 `config.debug != 0` 时传 `--debug <真实值>`，子进程解析后取代硬编码的 0。传真实值而非布尔——判定是位运算，压缩成 1/2 会让 `debug=3` 变成「不 attach」。argv 数组 `char *argv[16]` 最坏占用 15 槽，仍安全。
- **fix(worker): `qz_wait_idle` 计入 worker 的在途异步工作——修 worker 内 fetch 结果被静默丢弃**。worker 有**独立的 `uv_loop`**（`worker.c` 里 `uv_loop_init(&w->self->loop)`），而 `qz_loop_idle()` 只判定 `rt` 自己的 loop（inbound 队列 / JS job / `uv_walk` 本 loop / `loop.active_reqs`）。于是 worker 内发起的 fetch/timer 对父完全不可见，`wait_idle` 提前 teardown，worker 的异步结果被丢弃：现象是「worker 脚本里只有 fetch 时，父收不到任何消息」，且**无任何报错**。顶层 fetch 正常（父 loop 看得到），所以这是个不一致而非普遍失效。跨两个后端（`thread.c` 与 `rt_main.c` 共用 `qz_loop_idle`），库宿主同样受影响，非 CLI 专属。修法三处：①`qz_worker_t` 加 atomic `busy`，worker **在自己的线程上**算 `qz_loop_idle(w->self)` 并发布——父只做原子读，绝不跨线程遍历 worker 的 loop 或碰它的 JS（那是 worker 线程的独占所有权）；②`qz_worker_create` 在 spawn 时置 `busy=1`，否则父会在 worker boot 完成前就判 idle，截断首次输出；③**worker 由忙转空闲时 `uv_async_send(&parent->wake)` 叫醒父的 loop**——`qz_wait_idle` 只发一次唤醒，而父的 `uv_run` 在无活动句柄时会阻塞，没有这次通知，父会永远停在「看到 worker 忙」那次判定上（实测 worker 有 `setTimeout` + fetch 时必挂）。回归测试 `test_worker_gtest` 新增两条：`parent_stays_busy_while_worker_has_pending_async_work`（负控：去掉 spawn 期 `busy=1` 即变红）、`inherits_ca_trust_store_from_parent`。真实 libuv 下实测：修复前 A/C 变体分别表现为「空输出」与「挂死」，修复后均正常（挂死变体从 25s 超时降到 0.1s 完成），两 worker 并发亦正确。
- **fix(tls): worker 继承父 runtime 的 CA 信任库——消除两后端行为不一致**。`worker.c` 里 worker 是 `calloc` 出来的**独立 `qz_t`**，不共享父 runtime 任何状态，所以父进程经 `qz_add_ca_pem()` 装入的信任根不会自动到达 worker：worker 里的 fetch 访问私有 CA 站点报 `X509 - Certificate verification failed`。而 PROCESS 后端的 worker 是独立进程、经 `QZ_CA_FILE` **拿得到** —— 同一功能一个后端有效、另一个静默失效，属项目明确要消灭的静默降级（症状指向证书，真因是信任库没传过去，排查会往证书方向跑偏）。修法：建 `self` 后逐字节 `strdup` 父的 `ca_pem`（**不用** `qz_add_ca_pem`——那是追加语义，会多补一个 `'\n'` 分隔符，"继承"不该改变缓冲形状）。分配失败不中止 worker 创建但出声诊断。回归测试 `test_worker_gtest` 新增 `inherits_ca_trust_store_from_parent`：断言 worker rt 的 `ca_pem` 内容与父逐字节相同，并先用 `worker_echo.js` 确认 worker 确实跑过（否则"worker 没起来"会伪装成"继承失败"）。负控已验证：移除继承即变红。
- **feat(tls): `qzjs --ca <file.pem>` + `QZ_CA_FILE`——把运行时 CA 信任库接到真实进程模型上**。`qz_add_ca_pem()` 只写**当前进程**的 `rt->ca_pem`，而 ISOLATED 模型下跑 JS、做 TLS 握手的是 `qzjs-rt` **子进程**（独立 `qz_t`）。于是宿主在 `qz_create()` 之后调 `qz_add_ca_pem()` 对 fetch 实际**静默无效**：握手照常走系统 CA，私有 CA 的站点报 `X509 - Certificate verification failed`——症状指向证书，实际是信任库从没跨过进程边界。gtest 查不出来：它跑在 mock_libuv 的进程内，天然没有这个边界。修法沿用 strict 模式**既有**的跨进程通道（`QZ_STRICT_SANDBOX` 同款）：CLI 解析 `--ca` 时 `setenv("QZ_CA_FILE", ...)`（早于 `qz_create` 内部 exec 子进程），`rt_main.c` 启动时 `getenv` 并装入信任库；读不到即 exit 2，不静默继续。`qzjs.h` 补上该陷阱的说明与两条路径的分工（THREAD 用函数，ISOLATED 用 `QZ_CA_FILE`）。
- **test(tls): 新增 `test/test_tls_ca_e2e.py`——真实 mbedTLS 握手的端到端覆盖**。此前「握手成功后换读回调」（#1 的核心修复）只能靠人肉验证：gtest 跑在 `mock_libuv` 上没有真实套接字，永远到不了那条路径。现在驱动真实 `qzjs`（真实 libuv + 真实 mbedTLS）访问**本地私有 CA 签发的 HTTPS 服务器**，三关：无 `--ca` → 必须因**证书原因**拒绝；无关 CA → 仍拒绝（证明信任取决于真实链而非「传了个 CA」）；正确 `--ca` → 真实握手成功、响应体逐字节匹配。拒绝断言刻意要求输出含 cert/tls/x509 等字样——超���或连接失败同样会让 promise reject，只查「没拿到响应体」的话，连 TLS 都没开始的**环境性失败**也会被判成通过（正是本机 `QZ_BUILD_TESTS=ON` 构建的实际情况：那种构建的 `qz_cli` 链接 mock_libuv，没有真实网络）。证书在测试内现生成两级 PKI：`test/fixtures/test.crt` 已于 2026-08-18 过期，用它会在**过期**而非**信任**上失败。服务器必须双栈监听 `[::]`：`localhost` 先解析到 `::1` 而 qzjs 不回退 IPv4，只听 `127.0.0.1` 会得到「连接失败」。负控已验证：断开 `QZ_CA_FILE` 传递后第三关立即变红。
- **fix(http): HTTPS fetch 对所有 URL 失败 + `qz_destroy` 在请求在途时崩溃**。三个独立根因，全部在 `src/io/uv_io.c`：**①握手完成路径不换读回调**——`tls_handshake_read_cb` 在 `mbedtls_ssl_handshake()` 返回 0 后只置 `tls_handshake_done` 就返回，读循环仍注册在握手回调上；服务器发来的响应字节会再次进入该回调并重跑 `mbedtls_ssl_handshake()`（此时已非握手阶段），轻则多跑一次握手状态机、重则把响应数据当作握手记录吞掉，最终以 "TLS handshake read error"(EOF) 收场。**②缺 ALPN**——`tls_init_op` 此前没有 `mbedtls_ssl_conf_alpn_protocols`，现代服务器（Cloudflare / Google / Fastly）在收到不含 ALPN 扩展的 ClientHello 时按 RFC 7301 直接以握手 alert 关闭连接；`tcp_io.c` 早已默认声明 `http/1.1`，`uv_io.c` 这条客户端路径一直缺失。**③二次触发 `on_end`**——`uv_io_http_abort()` 原先假设每次 abort 同步 unlink op（`while (rt->http_ops) { op = rt->http_ops; ... }`），但 unlink 只在 `uv_io_http_cleanup`（close 回调的下一次 loop 迭代）发生，`rt->http_ops` 在循环内不变，于是每轮重复 abort 同一个 head op；`bridge_stream_on_end` 首次调用即 `js_free(bs)` 并 `JS_FreeValue` 其 JSValues，第二次调用对已释放值再 `JS_FreeValue` → SIGSEGV。改为单次遍历 + 先快照 `->next`；同时 `uv_io_http_abort_op` 的幂等 guard 从只看 `teardown_started`（`stream_cleanup` 置位）扩为并列检查 `tearing_down`（`finish_error` 置位）——`finish_error` 调完 `on_end` 后 op 仍留在链表直到 close 回调回收，后续 abort 仍会二次触发。
- **fix(http): `on_end` 回调新增第三参 `error_msg`**（`qz_io_stream_ops_t`）。此前 C 层的具体失败原因（`mbedtls_strerror` 文本、"TLS certificate verification failed"、DNS 失败等）在到达 JS 前被压成同一个 `error_status`，完全不同的失败在 `fetch` 侧无法区分。新增的诊断串只透传不解码，`fetch.js` 侧拼进 `TypeError` 消息；`error_msg` 仅在 `error_status != 0` 时非 NULL，生命周期限于回调内。旧的一参 JS 回调保持兼容（多余参数被忽略）。`docs/qwrt-architecture-design.md` 4.2 节的签名示例同步更新。
- **fix(http): 补齐非流式路径的 teardown 泄漏与 read-idle 超时**。`c1425f9` 的 teardown 修复只覆盖流式一半：非流式（`uv_io_http_request`，即 polyfill fetch 在 streaming 不可用时的回退路径）此前不注册进 `rt->http_ops`、不设 `rt->active_stream`，故销毁时对 teardown 不可见 → `op->cb` 不触发 → `qz_free_cb_data` 不执行 → promise 的 JSValue 泄漏 → `JS_FreeRuntime` 在非空 `gc_obj_list` 上断言。三处修：非流式在 `uv_getaddrinfo` 成功后同样注册进 registry；`abort_op` 与 `idle_timer_cb` 补 `op->cb` 分支；`finish_success` / `finish_error` 显式 `uv_close` 内嵌的 `idle_timer`（不关会在 loop 句柄表留下悬垂槽，之后派发到野函数指针）。另外响应头 realloc 失败（OOM）原先报 "socket connect failed"，改为 "out of memory growing response headers"；read-idle 超时消息由 "unspecified network error" 改为 "read idle timeout"。回归测试 `test/test_http_inflight_teardown_gtest.cpp`（mock_libuv 离线），含对照组确保测的是在途路径而非 harness。
- **fix(http): 移除 `active_stream` 单槽 teardown 守卫，删除该字段**。上述修复让非流式 op 也写 `rt->active_stream`，而它是**单槽**：多个 op 并发时只有最后持有者，后一个先完成时 cleanup 清零，而前一个仍在途 —— teardown 守卫 `if (rt->active_stream)` 于是为假、`uv_io_http_abort` 不被调用、在途 op 的回调永不触发，正是要修的那条泄漏链。权威的「有没有在途」指示器是 `rt->http_ops` 链表头，`uv_io_http_abort` 遍历它，空链表天然 no-op，守卫纯属多余且有害。字段失去唯一读取点后成为只写状态，留着等于埋雷（`qz_internal.h` 注释写着「http_abort 借它触达 in-flight 句柄」，任何人读到都会重新引入同一 bug），故整个删除（声明 + 2 处写 + 3 处清 + 引用注释）。

## [0.3.0] — 2026-10-02

> **Breaking**：`QZ_PROFILE=bare` 档移除；JS 层 flatbuffers 退役（gRPC 改 protobuf-only）；
> 宿主通讯改 per-rt 邮箱，库不再调用宿主任何回调（M-P7）。公共 C API 已版本化，
> 见 `docs/api-versioning.md`。升级请对照本节 Removed / Replaced 逐条核对。

### Added
- **DAP hitCondition 命中次数断点（C 层解析门控 + 访问级计数）**：`qz_debug_add_breakpoint` 新增第 5 参 `hit_condition`，`hit_condition_parse` 在设点时一次性解析（VS Code「命中次数」菜单写法：`N`/`==N` 恰停第 N 次、`%N` 每 N 次、`>N >=N <N <=N !=N` 关系式；拒绝 `%0`/负数/无操作数/尾随垃圾，返 -2 且不注册任何东西 → DAP setBreakpoints 该条回 `verified:false` + `invalid hitCondition: …` 消息，VS Code 显示灰色未安装 glyph，适配器 `applyVerified` 中 C 的 false 为权威、不被行号检查复活，`supportsHitConditionalBreakpoints: true` 能力申报）。命中计数**访问级 edge-triggered**：`qz_bp_t` 新增 `hit/hit_op/hit_n` + 访问跟踪三元组 `reach_file/reach_line/reach_depth`——同语句的多个 opcode、调用进入 callee 都属同一次访问（返回不重计），同深度换行/换文件或返回出更浅帧才结束访问（转移规则与 re-hit guard 一致）；`bps_visit_advance` 每次派发无条件推进所有断点访问态，防其他断点停顿留脏状态；断点被重新登记时计数清零。`qz_debug_detach`/`remove_breakpoint`/`clear_breakpoints[_in_file]` 全路径释放 `reach_file`。护栏：gtest（dap 全绿）+ e2e `hit-condition.mjs`——循环行 6 次到达、`%2` 恰停 2/4/6（continue 后 resume dispatch 不虚增计数）、无效 hitCondition verified:false 不复活、程序 stdout（`s 15`）断言跑完。docs en+zh（What works + Limitations「命中计数按登记生效」+ 测试清单）同步。
- **VS Code DAP 调试扩展（vscode/qzjs-debug，仓库首个编辑器集成）**：内联 DAP 适配器——TypeScript 实现（esbuild 打包 `out/`，`npm run compile`），`QZ_DEBUG=1` 启动 qzjs 子进程、stdio DAP 帧收发，无需外部调试适配器。真实路径断点链路：CLI eval 通道带 `file` 字段 → `__native__.nativeEvalScript`（src/host/bridge.c 新增、src/cli/cli.c 透传）——栈帧/断点按 JS_Eval 源名精确匹配真实路径（此前 `(0, eval)` 恒名 `<input>`，按真实路径设的断点永不命中）。e2e 4 用例（`node --test`，真 `build_dbg/qzjs` 为被调试端，`QZJS_RUNTIME` 覆盖路径）：smoke（入口停→断点停→栈/作用域/变量/求值/单步/继续→terminated）、debugger-stmt（debugger; 命中）、line-coverage（全语句种类断点命中）、breakpoint-scope（多文件断点作用域）。**扩展 e2e 接入 CI debugger job**（setup-node 22 + `npm ci` + compile + `QZJS_RUNTIME=$PWD/build/qzjs`）；lockfile 按 CI 复现性加入 gitignore 例外（同 `docs/package-lock.json` 先例）。
- **DAP 变量展开层级（`variablesReference` 下钻：Locals / hover / evaluate 全链路）**：C 层新增槽位表（`qz_debug_t.var_slots`，JSValue DupValue 持有）——每个可展开值（对象/数组局部变量、`evaluate` 结果）分配一个引用 id，编码为 `(frame_generation << 16) | (0x1000 + slot)`：低半区 0x1000 偏移让帧索引（调用栈远小于 4096）永不落入该区间，帧解码与槽位解码双向互不误判；代际半区让上一停顿的引用像过期帧 id 一样自然失效。槽位随 `frame_generation++`（on_dispatch 停顿 / on_throw / detach 三处）与帧快照一同释放（不跨停顿持有 JSValue）。`qz_debug_get_variables` 双路分派：帧 id → Locals（每项填真 `variables_reference` + 真类型 + 有界预览）；槽位 id → `JS_GetOwnPropertyNames(STRING|ENUM_ONLY)` 枚举自身可枚举属性（数组按下标序），每层至多 100 项 + `<...>` 折叠行，getter/Proxy 抛错回空列表而非半成品。值预览从「无界 JSON.stringify（循环引用→NULL→显示 undefined）」改为 **200 字节有界预览**（字符串保持 JSON 转义语义；对象 stringify 失败/函数回退受保护 ToString；UTF-8 安全截断防坏 JSON）；类型字段从恒 `"object"` 改为真 typeof（array/function/number/…，TDZ 经 `JS_IsUninitialized` 归 undefined）。`qz_debug_evaluate` 新增出参 `out_variables_reference`——对象结果可下钻（Debug Console hover/watch 同路径），DAP 层 `variables`/`evaluate` 两处 `variablesReference` 从硬编码 0 改为真引用（`qz_debug_var.variables_reference` 字段本就预留、首次填充）。语义边界（docs Limitations 同步）：仅自身可枚举属性（无原型链）、Map/Set 内部条目不暴露（打开为空）、函数为叶子、symbol 键跳过、引用随下一停顿失效、TDZ 局部变量显示 `[uninitialized]`（断点停在语句入口，初始化式尚未执行——测试踩过：断点行必须放在被测局部变量初始化**之后**）。护栏：gtest `DapDebugger.VariableExpansion`（dap gtest 6→7：嵌套链 o→nested→b[0,1]、evaluate 引用、跨停顿失效回空 `{"variables":[]}`）+ e2e `variables-expand.mjs`（npm e2e 7→8，附程序 stdout 中继回归断言 `r 5`）。纯 C 层实现，引擎公开 API 够用，**未动 deps/quickjs-ng 补丁**。
- **DAP 功能面补全：logpoints + 异常断点 + `verified:false`（扩展 / C 层 / 引擎钩子三层）**：(1) **日志点**——`supportsLogPoints: true` 能力声明加在 TS `initialize`（C 的 initialize body 不外发，能力只在适配器）；`setBreakPointsRequest` 按文件记录 `logMessage`（`Map<path, Map<line, msg>>`，与 C 侧按文件作用域对称），logpoint 照常注册给引擎（引擎必须停）；拦截 `stopped(reason=breakpoint)` → stackTrace 顶帧匹配 → `renderLogMessage` 按 `{expr}` 洞逐个走 child `evaluate`（frameId，`locals.` 可用）→ `OutputEvent(console)` → 自动 continue 并吞掉该次停顿——任何一步失败一律 fail-open 转发原停顿（宁可多停不丢停）。C 从不发 `continued` 事件，无事件可吞。(2) **异常断点**——引擎 `JS_Throw`（OP_throw / 全部 JS_ThrowError* / 宿主函数 / async reject 的单一漏斗）新增 `JSDebuggerHooks.on_throw`：存入 pending 槽**之前**触发（持 `JS_DupValue` 引用跨回调，`#ifdef QZ_DEBUG_SUPPORT` + `!in_build_stack_trace` + 非 UNINITIALIZED 门控）；恢复性 rethrow 改走内部 `js_throw_restored`（JS_IteratorClose、using-dispose 复活点；build_backtrace 存取恢复被标志位覆盖）→ **一次逻辑抛出恰好通知一次**（gtest 断言「一次抛出一次停顿」）。debugger.c `qz_debug_on_throw`：exc_break_mode 门 + `dbg->stopped` 重入保护（先占位再字符串化，防用户 `toString()` 再抛嵌套）+ 消息兜底（Symbol/抛错 toString → 清槽后用 `<exception>`）+ 暂停帧快照失效（暂停态处理期惰性取抛点栈）；新公共 API `qz_debug_set_exception_break` / `qz_debug_last_exception`。DAP 层：`dap_on_stopped` exception body（cJSON 转义，`reason=exception` + `text`=错误消息 + `description`）；`setExceptionBreakpoints` handler 进**全部三条处理分支**（paused / mid-run / configure），按请求逐过滤器回 `verified:false`（未知过滤器）、`filters:[]` = 解除武装；TS `exceptionBreakpointFilters` 能力只申报 `all`（Uncaught 需 unwind 路径 catch 检测，不虚报）+ 中继。(3) **`verified:false`**——纯适配器 `applyVerified`：readFileSync 对照行号（文件缺失 / 行号超末尾 → false，VS Code 灰显），响应与请求非 1:1 对齐时保留 C 的回答（C 跳过非法行的场景不误改）。护栏：e2e `logpoints.mjs` / `exception-bp.mjs` / `verified.mjs` 入库（npm e2e 4→7 全绿）+ gtest `ExceptionBreakpointArmed`/`ExceptionBreakpointDisarmed`（dap 5→6）；引擎补丁重镜像 **522→591 行 / 20→24 hunks**（GOLD：干净 HEAD+4 补丁 == worktree 四文件一致；hunkcheck 0 MISMATCH；reverse dry-run 通过）。
- **宿主字节码 API（`qz_compile` + `initial_bytecode` + CLI `--compile`/`--bytecode`）**：反转「无公开字节码 API」策略。新增：(1) `qz_compile(source, len, filename, &out, &out_len, &err)`——独立函数（无需 `qz_t`，内部一次性 JSRuntime/JSContext），恒按全局脚本编译（与 `qz_eval_internal` 的 `JS_EVAL_TYPE_GLOBAL` 对齐；`JS_DetectModule` 会把含 import 的普通脚本误判为 module，module 求值返回 promise、顶层 throw 不触发 ready_err，故不自动探测）；`JS_WriteObject` 缓冲拷入宿主 malloc 块（`qz_free` 可安全释放）。(2) `qz_config_t.initial_bytecode`/`initial_bytecode_len`——与 `initial_script` 独立叠加：先脚本（宿主 bootstrap）后字节码（预编译主程序）；`qz_create` 拷入自有缓冲（create 失败路径×2、`qz_destroy`、`qz_free`、`qz_host_destroy` 全部补释放）。(3) ISOLATED 传输：`host_write_script` 泛化为二进制安全 `host_write_blob`，字节码写独立临时文件经 `--bytecode PATH` 传给 `qzjs-rt`，`rt_main` 二进制读回、脚本之后 `qz_eval_bytecode_internal`，成功/失败路径均释放。(4) CLI：`qzjs --compile in.js [-o out.bc]`（缺省 `<in.js>.bc`）、`qzjs --bytecode file.bc [args...]`（走 bootstrap，脚本参数照常）。(5) 独立编译工具 **`qzc`**（src/qzc.c，`qzc <in.js> [-o out.bc]`，qz_compile 的 CLI 形态；链接真 libuv，mock 测试构建不产出）——`qzjs --compile` 保留为别名。**兼容性不保证（已告知）**：字节码与 qzjs 具体构建强绑定（引擎版本 + BC_VERSION + 校验和 + 编译选项），跨构建不保证可加载；运行时显式拒绝（`SyntaxError: invalid version`），绝不静默回退源码；docs（bytecode/faq/troubleshooting/host-integration/c-api/cli，en+zh）全部改写为「分发源码、部署环境按目标构建重编译」。实测：两编译模型端到端 编译→运行→参数透传 ✅；throwing 字节码 → `qz_create` 返回 NULL、CLI 非零退出 ✅；篡改字节码显式拒绝 ✅；`qjsc -b` 同引擎产物可加载 ✅。
  场景加固（更多测试中发现）：空字节码文件曾触发 double-free——`qz_create` 仅在 `initial_bytecode && initial_bytecode_len` 时拷贝，`len==0` 时 `rt->config.initial_bytecode` 悬挂在宿主缓冲上、destroy 二次释放（valgrind 定位：Invalid free in qz_free via run_bytecode）。修复：指针一旦设置即归 rt 所有（`malloc(n?:1)` 恒拷贝，len==0 不例外）；CLI 侧空文件前置报错 `'x' is empty (not bytecode)`。篡改字节校验和 → `SyntaxError: checksum error` 显式拒绝 ✅。
- **quickjs-ng 字节码读取器加固（deps/quickjs-ng-bc-reader-hardening.patch，根因修复 fuzz-smoke 偶发 flake）**：`JS_ReadObject(JS_READ_OBJ_BYTECODE)` 是非可信字节码的加载路径（内嵌 polyfill、worker boot shim），也是 fuzz-smoke job 的目标——vendored reader 此前完全信任流内数值：越界 opcode 直接索引 `opcode_info[]`（global-buffer-overflow）；`cpool_count`/`byte_code_len`/`closure_var_count`/`local_count`/`req_module_entries_count`/`pc2line_len`/`source_len` 无界 → 多 GB 分配（OOM）或 int 溢出（allocation-size-too-big）；`req_module_entries_count` 超过已分配数组时失败路径 `js_free_module_def()` 遍历未分配内存（SEGV in `__JS_FreeAtom`）；`JS_ReadFunctionBytecode` 失败时 `b->byte_code_len` 保留流值 → free 走出分配块（heap-buffer-overflow）；`JS_ReadString` 先分配后查流界（LEN_MAX 级字符串 = 2 GB 分配 flaky OOM）。加固：opcode 上界校验、全部计数字段硬上限/剩余流字节界、fail 路径 count 钳制到已分配 size、`byte_code_len` 先置安全值、`JS_ReadString` 分配前置流界检查、module_name atom 失败前置 `JS_ATOM_NULL` 防双释放。上游 master 同样未修（本 patch 按 deps/*.patch 模式 working-tree-only 应用，替代原 bc-localcount 严格相等校验——其误拒 vardefs==NULL 的合法字节码致 polyfill 拒载，已由上界钳制取代）。验证：8 个 fuzz crash/oom artifact 全部重放走错误路径不再崩溃；20 万轮随机字节码自驱 fuzz 干净退出；polyfill/worker-boot 字节码正常加载；ctest offline 23/23 + mp1/nested e2e 全绿。 后续修正：①校验段曾引入 `local_count` 非严格上界（free 路径按 arg+var 走，分配小于遍历量 → OOB）与 `source_len`/`closure_var_count` 过严假设（误拒合法 polyfill），已回退到经验证的初始加固集（opcode 越界 + 各 count 硬上限/流字节界 + fail 钳制 + byte_code_len 安全前置）；②seed `crash-73a0` 在 CI Debug 构建下暴露另一条失败路径（cpool 嵌套函数失败时外层 free 走流值 byte_code_len），该路径需独立修复（byte_code_buf/len 安全前置在 cpool 递归之前），seed 暂移出重放门待修后回归。
- **gRPC 四形态 example（examples/grpc-hello）**：单进程自连演示——`serve({port, grpc})` 起 h2c 明文 gRPC 服务端，`grpc.createInsecureChannel()` 客户端连自己，unary（Echo 回显）+ 服务端流式（CountUp 3 帧）+ 客户端流式（Collect 3→1 求和）+ 双向流式（Chat 3↔3）各跑一遍并断言输出。内置最小 proto（`grpc.loadProto` 解析）；按既有模式收编进 `examples/CMakeLists.txt` 的 qjsc 编译校验（不编入任何二进制，运行需 `QZ_WITH_GRPC=ON` 构建：`./build_grpc/qzjs examples/grpc-hello/grpc-hello.js`）。
- **gRPC 服务端 TLS e2e 闭合（QZ_WITH_GRPC=ON 真实二进制 + 流式家族 TLS 覆盖）**：`test/grpc_server_tls_e2e.mjs` 此前只在 H4 本地口头验证过、CI 从不构建 ON bundle——本轮补上真实二进制验证：unary over TLS（grpc-js 客户端 ALPN h2 ↔ qzjs serve({tls, grpc})）之上新增服务端流式（CountUp 3 帧按序）、客户端流式（Collect 3→1 收全数组）、双向流式（Chat 3↔3）三形态 TLS 用例（各 1+ 断言，含计数/顺序/载荷完整性），并自举测试证书（缺失时 openssl 现造，镜像 test_httpserver_e2e.py）。CI 新增 `grpc-e2e` job（CMake `-DQZ_WITH_GRPC=ON` + polyfill 重建 → `grpc_server_tls_e2e.mjs` + `grpc_server_harness.mjs`），唯一跑 ON bundle 的 CI 入口。验证：ON 构建（Release/ISOLATED，BC27 0x1b 字节码）8/8；默认 OFF 构建零回归（ctest offline 17/17 + mp1/mp2/nested e2e + grpc harness 31/31 + grpc server harness 23/23）。
- **gRPC 客户端流式 + 双向流式（polyfill gRPC 层流式家族补全）**：客户端新增 `Channel.invokeClientStream(method, reqs, opts)`（`(stream T) returns R`，reqs=数组/(async)生成器逐项一帧，收全后单响应，`Promise<Message>`）与 `Channel.invokeBidi(method, reqs, opts)`（`(stream A) returns (stream B)`，请求流逐帧发、响应流收全数组，`Promise<Message[]>`）——均为 Promise 风格「发完整请求流 → 收完整响应流」，与既有 invokeStream 对称（qzjs 无事件式 API，区别于 grpc-js 的 `call.write()/on('data')`）。服务端 `addService` 放行 clientStreaming/bidiStreaming：handler 收全请求数组（`call.request` 为解码对象数组）——clientStreaming 返回单值走 `_respondOk`，bidi 返回响应数组/(async)生成器走 `_respondStreamOk`；空请求流 → `[]`、空响应流合法。非匹配方法调新 API → INVALID_ARGUMENT（与 invoke 拒流式对称）。零 wire 改动（http2 write 已支持多 DATA + end trailers）。验证：test/grpc_harness.mjs（qzjs 客户端 ↔ grpc-js 服务端：客户端流式 3→1、双向 3↔3、空流、拒绝）+ test/grpc_server_harness.mjs（grpc-js 客户端 ↔ qzjs 服务端同场景）+ 既有 unary/serverStreaming 零回归，两 harness 全绿。
- **宿主→树中任意 worker liveness ping（§8.2 path 寻址，ping 家族最后一块）**：`qz_ping_path(rt, path, len, timeout_ms)` 宿主 C API（仅显式调用触发，无后台心跳）——PING payload 带 `"tp":[u16 槽位链]`（与命令面 target_path 同 §8.2 root-relative 范式，信封 schema 零改动），逐跳经各中间节点读回调 C 层下投（不消费不进 JS），目标 worker 读回调直回 PONG 并**回显 tp 作过境标记**（中间节点见 tp 沿父通道上行转发，不吃进自身 ping_seq 配对槽；转发失败/无对应子槽位回 `pfail` corr=seq）；宿主按 corr 配对。返回 0=通畅 / 1=超时(目标 loop 阻塞) / -1=参数错/路径不存在/通道死（pfail 快速回执，不白等 timeout）。实测：宿主→孙（3 层）健康 0ms；孙 JS 自旋 → 恰 timeout(400ms) rc=1；孙 SIGKILL → 快速 rc=-1（1ms）；路径不存在 → 快速 rc=-1。宿主→主RT qz_ping / worker→sub Worker.prototype.ping 零回归。回归：ctest offline 23/23 + mp1 + nested + ctl e2e 全绿。
- **sessionStorage（Web Storage）**：与 localStorage 同接口的独立存储域——`polyfill/src/local-storage.js` 参数化 `createArea(persistPath)`：localStorage 沿用文件持久化（行为/数据不变），sessionStorage 为纯内存区（生命周期 = runtime 会话，不落盘、不触碰 localStorage 持久文件）；`__qz_storage_dispatch__` 按 `storageDomain` 路由；PROCESS worker 代理 `request`/`buildStorageObject` 带 domain，超限本地预检同 QUOTA（5 MiB）。两域同 key 完全隔离。
- **宿主 liveness ping/pong（检测主RT 事件循环阻塞）**：`qz_ping(rt, timeout_ms)` 宿主 C API——发 CONTROL{"qzjs":1,"ping":seq}（复用 corr 槽，§4.1 schema 零破坏），主RT 读回调 C 层就地直回 PONG（不经 msgq/JS——pong 延迟纯反映 uv loop 健康度）；返回 0=通畅 / 1=超时(loop 阻塞) / -1=通道死(EOF)；单飞行 seq 配对。量化：健康 ping 0-6ms；JS 自旋 3s 时恰 timeout(1500ms) 超时 rc=1；SIGKILL 快速 rc=-1（EOF 路径）——三种形态可区分。
- **worker→sub worker liveness ping（检测 sub worker 事件循环阻塞）**：`Worker.prototype.ping(timeoutMs)` JS API（仅显式调用触发，无后台心跳）——父 worker 发 CONTROL{"qzjs":1,"ping":seq}（corr 复用）到 sub worker 通道，sub worker 读回调 C 层就地直回 PONG（不经 JS/msgq）；`qz_proc_ping`（src/ipc/ipc_process.c）自 poll+recv 驱动等待，PONG 按 corr 配对，非 PONG 帧留 rbuf 零丢失。返回 0=通畅 / 1=超时(sub worker loop 阻塞) / -1=通道死(EOF)。THREAD 后端恒 0（同进程 loop 无独立事件循环）。实测三形态：健康 0ms / sub 自旋 3s 时 ping(500) 恰 500ms 超时 rc=1 / sub close 后快速 rc=-1。回归：ctest 23/23 + mp1 + nested e2e 全绿。
### Fixed
- **循环行断点/日志点只命中一次（`last_stop_line` 重击守卫永不过期，真 bug，logpoints 首测暴露）**：守卫原逻辑只比行号、从不自清——断点停顿后回到同一行（循环）的每次重访都被永久抑制，直到另一个停顿发生在**不同**行才解除（line-coverage 因多断点交替停顿从未踩中；logpoints 首测即暴露：循环行日志点只记 1 次而非 3 次）。重设计为**深度感知**：停顿时记 `last_stop_line + last_stop_depth + last_stop_file`，每次 dispatch（复用既有 `JS_GetCallFrames` 调用，零新增热路径成本）——同深且文件/行未变 = 同一语句的 resume dispatch，抑制；同深但前进 = 清除；更浅 = 停顿帧已返回，清除；更深 = 在 callee 中保留（返回后不得重触发）。栈回收恒先被观测（caller 必先在浅一层 dispatch，同深帧重建前已有清除机会）→ 帧地址复用不会误判。既修断点也修日志点的循环重访；`last_stop_file` 在 `qz_debug_detach` 释放。护栏：e2e `logpoints.mjs`（循环行 3 次命中 + 相邻真实断点照常 2 次）。
- **程序 stdout 静默丢失（适配器 relay 解析器，真 bug）**：旧 `onChildData` 解析器只在文本含 `\r\n\r\n` 时转发——尾部输出永留 buffer（子进程退出即丢），夹在帧头之前的输出被 header 吞掉（marker 正则不锚定，`done\nContent-Length:…` 整段当帧头解析后前缀丢弃）。重写为标记扫描：`Content-Length:` 标记之前的一切即时转发为程序输出 OutputEvent，`partialMarkerSuffix` 扣住跨 chunk 半截标记（防把半截 marker 当输出发出去），JSON 解析失败输出 stderr 并重扫描重同步。此前无人断言程序输出（`logpoints.mjs` 的 `done` 断言首次覆盖）。
- **暂停期间 setBreakpoints 落入通用 ack（断点编辑静默丢失，DAP 语义修复）**：paused 分支此前对 `setBreakpoints` 只回 `{}` 通用应答——暂停时的断点编辑不生效，且 VS Code 收到非 `SetBreakpointsResponse` 形状会把该文件断点全部置灰。paused 分支（`dap_handle_request`）补 `setBreakpoints` + `setExceptionBreakpoints` 分支（与 configure / mid-run 分支共用同一 handler），暂停时 set/clear 正常回 `verified` 并更新断点表。
- **pc2line 行归属与断点行覆盖（deps/quickjs-ng-debugger.patch 重镜像 352→522 行 / 20 hunks，两轮根因修复）**：(1) 行归属——resolve_labels 的 peephole 跨语句取 marker 行，pc2line 条目记成下一个语句的行（断点落上一语句）：put_loc/post_inc fold 改为先 add 再采纳行；(2) 行覆盖——语句入口（js_parse_statement_or_decl 顶部）+ case/default/catch/finally/else/var 声明符子句统一发 OP_source_loc，phase-3 resolve_labels 对被跳过的 marker 在当前输出位置就地补 pc2line 条目 + OP_nop 占位（phase-2 会剥掉解析侧 nop，解析侧补录无效），switch 收尾（`}` 之后、label_break/OP_drop 之前）补 marker 防 break 落点继承最后子句行。修复前 return/break/continue/case/catch/空语句等整类语句行漏记或记错；修复后语句行全覆盖，e2e `line-coverage.mjs` 入库为护栏。已知怪癖（docs Limitations 记载）：右花括号行不可断点、finally 续段可能重触发 catch 体行、do-while 每轮回跳重报 `do {` 行（语义正确）。
- **setBreakpoints 按文件作用域（DAP 语义修复）**：`dap_handle_set_breakpoints` 此前调 `qz_debug_clear_breakpoints()` 清空整张断点表再重建请求条目——其他源文件增删断点会静默清掉本文件断点（e2e 修前复现：SRC 断点被后续请求抹掉，SRC:3 不再命中）。新增 `qz_debug_clear_breakpoints_in_file()`（qz_debug.h + debugger.c），handler 只替换 `source.path` 命名文件的条目；无 `source.path` 的畸形请求不碰表（DAP 规范 source.path 必填）。`verified: true` 语义 = 已登记（非保证命中），docs Limitations 同步改写。护栏：e2e `breakpoint-scope.mjs`（修前 FAIL）+ gtest `DapDebugger.PerFileBreakpointScope`（test_dap_gtest 达 5/5）。
- **跨进程 storage quota 白传 RPC（perf）**：PROCESS worker `localStorage.setItem` 超配额（>5 MiB）时，payload 整帧跨进程 RPC 传到 owner 后才检查抛 `QuotaExceededError`——6 MB 单次 ~7.5 s（同步 RPC 线性 ~1.1 ms/KB），超限数据全额白传。修复：`polyfill/src/local-storage.js` worker `setItem` 在发 `storageSync` RPC **之前**本地判 `key.length + value.length > QUOTA` → 直接抛 `QuotaExceededError`（同步 API 语义不变，异常形状与 owner 侧一致），不走 RPC。按 code units 计（与 owner `total` 口径一致；不按序列化字节预拒，避免误拒多字节字符值）。6 MB `setItem`：~7500 ms → 44 ms；4 MB（quota 内）仍正常走 RPC、值一致。
- **64KB worker 消息往返挂死（真回归，M-P4 446d7ea3 引入）**：`src/host/rt_main.c` 的 `process_rx` 帧累加器丢失「帧体未收齐就返回」的判定（`if (g_rx.len < g_rx.frame_len) return;`，只剩注释 `Need frame body`）。任何大于一个管道读块（`QZ_IPC_READ_BUF_SIZE` = libuv `UV__IO_MAX_BYTES` = 64KB）的帧会被拆成多次 read 回调，第二次回调里 `g_rx.len -= g_rx.frame_len` 在 `size_t` 上下溢 → `memmove` 巨量越界 → 堆破坏（`double free or corruption (!prev)`）/挂死。修复：恢复该判定。实测触发阈值 = payload + 44（帧头 4B + 信封 40B）> 65536，即 payload > 65492；`r3 65536` 由挂死恢复为 THREAD 54ms / PROCESS 51ms，`r4` 恢复 13.8k msg/s。回归护栏：`test/test_mp1_process_e2e.sh` 新增 phase 1b（128KB payload 往返，修前 FAIL / 修后 PASS）。
- **mp4 storage 同步 RPC 大 payload 调查收尾（结论：无低成本优化）**：4MB（quota 内）跨进程同步 RPC 慢的主因定位 = polyfill JS 自有 ABI 序列化层（`polyfill/src/structured-clone.js` 的 `__qz_serialize__`/`__qz_deserialize__`，非 quickjs-ng 内置 structured clone 引擎）。量化（Release -O3）：4MB 字符串值 `serialize`（encode）≈20ms（原生 TextEncoder / JS utf8Encode），`deserialize`（decode）≈460-510ms（逐字符 JS `utf8Decode`，占总 RPC 时间 ~90%）；4MB `setItem` 同步 RPC 实测 ≈0.5s。可优化性：低成本 JS 快速路径全部实测无收益——增量 Uint8Array ByteWriter + ASCII 批量 `fromCharCode` + `encodeString` 走 TextEncoder（deserialize 458→507ms，噪声内）、TextDecoder polyfill decode（2464ms，更慢）；C 层 writev/SO_SNDBUF 经 strace 证伪无效（4MB 帧 syscall CPU 仅 8ms）。剩余 decode 成本为逐字符 JS 解释固有成本；C 层 native decode 属新 C 扩展，超出低成本/收尾范围，不强改。历史「4MB ≈6.5s / 6MB ≈7.5s」数字不可复现于当前干净 master：溯源为 Debug（-O0）构建 ~40x 解释慢（同 fixture 实测 4MB set≈21.7s）与/或当时实验中间树+并行负载。超限白传已由 e3da7d9c 消除；新增 4MB 同步 RPC 基准 fixture `test/bench/mp4_sync_storage_{main,worker}.js`。
- **STORAGE 中继并发关联 id（真 bug，N-P4）**：中继节点自身同步 `storageSync` RPC × 子树在途请求并发错配——中继节点自身用 localStorage 触发同步 RPC 的同时，子树（子 worker 后代）的 storage 请求正由中继节点下投，两者复用同一「在途槽」配对时互相串扰，中继节点自身 RPC 的回复可能被当作子树请求的回复（或反之），导致错误返回值/挂起。修复：信封新增 `corr` 槽（field id 4，纯增量字段，旧解码器按 vtable 槽 0-3 读、忽略新槽，`IPC_ENVELOPE_FIXED_SIZE` 40→48），请求方分配单调 id、owner 回复原样回显（`polyfill/src/local-storage.js`）、中继节点按 `storage_relays[]` 登记 + `g_sync_corr` 匹配配对下投（`src/host/rt_main.c`）、`bridge.c` 登记 `js_pal_storage_relay`。触发条件：节点有子 worker 且自身用 localStorage。容量兜底：中继表满时拒绝新中继，维持单飞行语义不串扰。
- **tier-2 超时异步化调查收尾（§9.2/I5，结论：不实施）**：`qz_proc_terminate`（src/ipc/ipc_process.c:453）同步三级终止——Tier 1 CONTROL{shutdown} → Tier 2 `waitpid(WNOHANG)` + 10ms `nanosleep` 轮询至 `QZ_IPC_TERMINATE_TIMEOUT_MS`=2000ms（ipc_process.h:52）→ Tier 3 SIGKILL + 阻塞收尸，最坏冻结调用线程 2s/每个挂死 worker。调用点：①`js_pal_process_terminate`（bridge.c:1927，JS 运行时路径，可随时由脚本触发）；②`qz_thread_teardown` 残留句柄循环（qzjs.c:321，逐句柄累计）；③`rt_host` 宿主 destroy（rt_host.c:160，ISOLATED 专用 loop 线程）；④processSpawn 句柄溢出（bridge.c:1847，罕见）。判定「非真问题」：2s 冻结只在**已损坏**（无视 shutdown）的挂死子进程上兑现，正常退出路径 ~1ms；嵌入宿主自身**从不阻塞**——宿主侧 terminate 仅 destroy 路径且跑专用线程，JS 侧冻结发生在主RT 自己的 loop（ISOLATED 缺省下是独立进程），不碰宿主主线程。异步化（uv_timer WNOHANG + 升级 + 完成回调）须把 pid 属权与 proc 生命周期跨 loop tick 迁移，而 4 个调用点全部紧跟 `qz_proc_free`（假设「terminate 返回即已收尸」）——UAF/双释放风险大于收益，与 M-P4（2026-09-14）revisit 结论一致，维持 DEFERRED。
- **path 元素 u16→u32 调查收尾（§8.2，结论：YAGNI 不实施）**：端点身份 path 链元素维持 u16。判定依据：当前规模 `QZ_MAX_PROC_HANDLES`=64 并发进程句柄/rt（src/base/qz_rt.h:135）+ path 深度上限 `QZ_SELF_PATH_MAX`=8；path 元素 = 各 runtime **本地**单调 worker id（`polyfill/src/worker.js` `procWorkerSeq`，1000 起，非全局计数器），溢出需**单个 runtime 累积 >6.45 万次** PROCESS spawn，现实不可达；`src/host/rt_main.c:600` 解析已有 `v <= 0xFFFF` 守卫；非 path 字段 `key_port` 本为 u32（`message-channel.js` `wrU32`），无中间值溢出点。升 u32 须改 PORT_TRANSFER 头变长公式（`8 + 2*(dest_len+key_len)` → `8 + 4*(…)`，polyfill/src/message-channel.js:118-123），破坏 §4.1 冻结 schema / §7.2 字节不动 wire 兼容 → 超出低成本，维持延后（代码注释已记录该续集，qz_internal.h:137/354、ipc_envelope.h:82）。
- **§10.2 所有者死亡降级调查收尾（结论：不实施，孤儿自杀即设计终点）**：owner（storage 所有者 / 主RT）死亡时孤儿**自杀**而非存活降级，语义定格。现状：主RT 死亡 → worker/孙 的 parent-fd 读 EOF → `pipe_read_cb` nread<0 → 置 `shutting_down` → teardown → exit（src/host/rt_main.c:348-353，§6.4/§9.4 孤儿回收）；storage 代理路径：owner 死亡 → `child_storage_sync` 收 EOF → 返回 -1 → `pal.storageSync` 抛 `InternalError`（src/host/bridge.c:2053）→ worker 连锁自杀（polyfill/src/local-storage.js:27-28 已文档化）。判定降级不实施，三条理由：① §9.4 明言「连锁死亡是预期行为，避免半死进程互相等」，§6.4 跨进程通道**不重连**——孤儿存活即成不可达死进程；② **降级态结构上不可达**：storage owner 恒为树根主RT（§10.2 + N-P4「owner 恒为根」），owner 死 ⇒ 路径上所有祖先（含直接父）同时 EOF ⇒ 任何孤儿必经 §9.4 自杀，不存在「owner 死但父活」的中间态；③ 计划 §10.2 的降级兜底（本地快照只读 + 原子 rename LWW 独立写）违反单所有者不变量（storage 恰有一个所有者），主RT 重启后孤儿 LWW 写入丢失/冲突，且会破坏现有级联 e2e 断言（test_nested_e2e.sh 5b 断言孙必须自杀）。验证：nested e2e（5a 收尸 / 5b 孤儿自杀 / 5c 全链连锁零 zombie）+ mp3 + mp4 storage crash e2e + ctest -L offline 23/23 全绿。
- **`QZ_EXTENSIONS` 追加分隔符文档错误（真 bug：照抄即编译失败）**：`include/qzjs/qz_ext_registry.h`、`CMakeLists.txt` 注释、`docs/{,zh/}guide/extensions.md`、`docs/{,zh/}c-api/extensions.md`、`examples/extension/README.md` 与 `extension.c` 头注释此前一致推荐 `QZ_EXTENSIONS "QZ_DEFAULT_EXTENSIONS, &my_extension"`。但 `QZ_DEFAULT_EXTENSIONS` 宏本身以尾随逗号结尾（每个 `QZ_EXT_IF_WITH(...)` 槽位都带逗号），再加逗号展开成 `ptr, , &my_extension`——空数组元素在 C99 下是硬编译错误（`error: expected expression before ','`，context.c.o 直接挂）。全部站点改为空格分隔 `"QZ_DEFAULT_EXTENSIONS &my_extension"`（宏展开 `ptr, &my_extension`，合法），并在 registry 头、两版指南、两版 C API 页补一句"用空格不用逗号"的原因说明。验证：按修正后的命令全新 configure+build 扩展示例（`-DQZ_EXTRA_SOURCES` + `-DQZ_EXTRA_HEADERS` + `-DQZ_EXTENSIONS='QZ_DEFAULT_EXTENSIONS &greet_ext'`）→ 编译通过，`./build_ext/qzjs -e 'console.log(greet("qzjs"), greet(42))'` 输出 `Hello, qzjs! Hello, 42!`。
- **`examples/httpserver` 静态响应泄漏调试打印（`src/io/uv_io.c`）**：零拷贝 EOF 探针命中路径残留一行 `fprintf(stderr, "DIAG ZC-EOF: backing=%p len=%zu\n", ...)`——每个静态文件响应都在 stderr 打一行内部指针/长度。删除该行；行为不变（仍走 `uv_fs_close` → `uv_io_fs_read_close_cb` 交付零拷贝 backing）。验证：httpserver 起服务后 `curl /` 返回 200 且日志干净无 DIAG，offline 套件 24/24 绿。
- **`examples/fs` 未清理自身临时文件**：示例把 `/tmp/qzfs_a.txt`、`/tmp/qzfs_b.log` 写进共享 `/tmp`，只删了 `b.log` 就退出，README 却声称"跑完自清理"——残留 `qzfs_a.txt` 污染下次运行的 readdir 输出。补第 6 步 `unlink(base + 'a.txt')`。验证：运行后 `ls /tmp/qzfs_*` 无匹配，输出与 README 一致。
- **示例文档引用不存在的构建目录**：`examples/{httpserver/server.js,stream-pipeline/pipeline.js,worker-orchestrate/orchestrate.js}` 头注释与 `httpserver/README.md` 写 `./build-ws/qzjs`（该目录不存在），`grpc-hello.js` 写 `./build_grpc/qzjs`（非规范名）。统一为文档约定名 `./build/qzjs`（README 另注 Release 构建要求）。
- **`examples/httpserver/README.md` 端口与实测不符**：README 的"运行/测试"节写 `PORT = 8080` 与 `curl …:8080/…`，但 `server.js` 里是 `var PORT = 18080`——照抄 curl 命令打到宿主 nginx（8080 已被占用），得到 404 而非示例响应。统一改为 18080；"路径穿越防护"用例补 `--path-as-is`（curl 会本地规范化 `../`，原命令根本到不了服务器）。

### Added
- **示例 README 覆盖补齐**：15 个示例目录此前只有 `extension/`、`httpserver/` 等少数带 `README.md`；本轮为缺的全部补上（hello/messages/worker/wasm/crypto/fs/timers/broadcast/stream-pipeline/websocket/grpc-hello/worker-orchestrate），每个含精确运行命令与实跑核对过的期望输出。两版 `docs/{,zh/}guide/examples.md` 补"每个示例目录带 README"与 Release 构建提示（`QZ_BUILD_TESTS=ON` 链 `mock_libuv`，其空闲路径固定 1 秒轮询兜底会把定时器量化到整秒——`timers` 会打印错误耗时）。
- 嵌套 spawn 验证门与文档（N-P6）：新增 `test/test_nested_e2e.sh`（5 phase：三级进程树 PID 证据 / worker↔孙 postMessage / §8.2 port path 跨两级经 LCA + 改指转发 / CTL `--target-path` 到孙 + 隔离证明 + 回执配对 / §10.2 STORAGE 两级中继 / §9.4 两级死亡级联——kill 孙→子收尸、kill 子→孙孤儿自杀 + 主RT `onerror`、kill 宿主→全树连锁，全程零 zombie 零残留）；CI e2e job 新增该步骤；`test_ctl_route_gtest` 新增两用例（`qz_ctl_cmd_target` 的 `target_path` 首跳提取 + 无 path 时旧语义回退）；计划文档 §11 新增 M-P5 落地状态节（含缺口：深度上限 8、storage 中继单飞行、fixture 绝对路径风格）。
- STORAGE 单所有者代理的**嵌套延伸**（N-P4，§10.2）：owner 恒为根 runtime（主RT），非根 runtime 成为**中继节点**——worker 收到子树发来的 `kind=STORAGE(4)` 请求时不再当自己是 owner，而是 `pal.storageRelay(bytes, childId)` 原样上行给父并登记发起子槽位（`qz_t.storage_relay_child`）；owner 的回复沿父通道回来时由 `process_rx` 按登记下投到该子进程通道（payload 字节原样，C 层只转发）。单飞行语义保持不变（已有在途中继时新请求不排队，§10.2 既有约束）。验证：`test/test_nested_e2e.sh` phase 4 —— 孙 worker `localStorage.getItem` 读到主RT owner 先写的值、孙 `setItem` 的值主RT 可见（往返经主RT→worker→孙 两级）。
- 控制面 CTL-1 扩展：**path 链寻址到孙及更深**（N-P3）。命令 JSON 新增可选 `target_path`（root-relative path 链）；`qzjs-ctl` 新增 `--target-path k1,k2`。路由按「本节点 §8.2 自身深度 + 路径前缀比较」决策：深度 == 路径长且前缀吻合 → 目的地即本节点（入 msgq 交 dispatch）；本节点是目的地严格祖先 → 下投路径中本层那座槽位（信封 `target` 逐跳重写）；否则上行。信封 target 仍为单 int32（首跳由 `qz_ctl_cmd_target` 取 `target_path[0]`），§4.1 冻结 schema 零改动；无 `target_path` 时旧单跳相对语义完全不变（扁平 CTL 零回归）。回执沿树回程（`source` 全程保持）配对不变。验证：`test/test_nested_e2e.sh` phase 3 —— `--target-path 1001,1001` 的 eval 在孙 runtime 执行（孙设的全局在主RT 与 worker 均不可见）、回执 correl 配对、孙 metrics `worker_count:0`；`test_ctl_e2e.sh` 扁平全绿。
- 多进程模型 §8.2 path 链路由（N-P2）：端点身份从单 int32 升为 **path 链**（`u16[]`，rt 树根起逐级父分配槽位 id；根 = 空 path）。C 侧新增 `qz_t.self_path` + `pal.selfPath()`，worker 的完整链经 spawn argv `--path` 由直接父传入（父知自身 path + 本地槽位 id）。PORT_TRANSFER 载荷路由头由定长 16B 改为**变长**（`op/dest_len/key_len/pad` + `u16 dest_path[]` + `u16 key_path[]` + `u32 key_port` + 不透明 SC 字节），信封 `source/target(int32)` 与 §4.1 冻结 schema **零改动**。逐跳路由 = path 前缀比较（`dest == self` → 本地投递；`self` 是 `dest` 严格前缀 → 下投 `dest[len(self)]`；否则上转父）——**LCA 中继由此自然涌现，无需全网路由表**；另按 §8.2 在「port 被本 runtime 再转移走」处登记**改指表项**（port 身份 → 新端点 path），命中本地却已 detached 时重封头改指转发（payload 字节原样、不解码）。修复一处被嵌套暴露的既有 bug：`worker.js` 重载 `__qz_dispatch__` 时 `source===0` 分支把 `kind` 丢弃 → 加载了 Worker polyfill 的 worker 收到 port 帧会被当普通消息反序列化。验证：`test/nested-e2e/main-nested-port.js`（main 建 channel → port1 经 worker 再转移给孙 → main↔孙 跨两级往返经 LCA，改指转发生效）出 `G2M:echo:hello`；扁平 mp1/mp2/mp3/mp4/mr2 e2e 全绿（path 化未破扁平语义）。
- 多进程模型嵌套 spawn（N-P1 能力打通，§1.1 树形拓扑）：worker 进程内亦可 spawn 子 worker 进程。`pal.processSpawn` / `processPost` / `processOnMessage` / `processTerminate` 现在 worker runtime 同样注册（此前仅父 runtime 注册，且 `js_pal_process_spawn` 对 `rt->worker_self` 硬拒 `parent runtime only`），JS 层 `new Worker()` 无需改动即能在 worker 内起子进程——进程原语（socketpair/fork+exec/握手/读回调）本就不依赖「本 runtime 是主RT」，worker runtime 同样持有 `proc_handles[]` 与 uv loop。实测：三级进程树 host→主RT→worker→孙（PID 各异、父子关系正确）+ worker↔孙 postMessage 往返（`nested:child-grand:ping`）；kill 孙→worker 收尸、kill worker→主RT 存活、kill 主RT/host→全树级联退出，全程零 zombie（fixtures `test/nested-e2e/`）。
- 控制面 CTL-2（本地端点 + `qzjs-ctl`）：`config.control_plane=LOCAL` 时 runtime 在本机监听 AF_UNIX `uv_pipe`（路径 `config.control_pipe_path`，缺省 `/tmp/qzjs-<pid>-<n>.ctl`，权限 0600；连接方以 `SO_PEERCRED` 校验 uid，异 uid 直接断——§2.3/§4.2 的「unix pipe 权限即认证」）。端点按换行分帧收 JSON 命令，走与 `qz_control` 同一执行路径（不引入第二执行路径），回执按 correl 写回该连接。新增 `qzjs-ctl` 可执行（`src/cli/ctl_cli.c`，CMake target `qz_ctl`）：`--pipe <path> [--target N] [--timeout-ms N] eval|inspect|metrics|interrupt`，或 `--json` 直发任意命令 JSON，打印回执并按 `ok` 定退出码。CLI 新增 `--control-plane=<off|in-proc|local>` / `--control-pipe=<path>`；ISOLATED 下端点由主RT 监听（宿主经 argv 把档位/路径传给主RT）。THREAD 编译下端点在宿主 runtime 的 loop（thread.c）——两模型各 e2e 实测。
- 控制面 CTL-1（信封 CONTROL 命令树路由）：CTL-0 的 eval/inspect/metrics/interrupt 命令面经 `kind=CONTROL` 信封在进程树内逐跳路由——命令 JSON 新增可选 `target`（C 层提取，路由器不解 payload；缺省 1 = 接收方自身），接收方按「target == 自身槽位 id → 本地执行；0/1 → 朝根上行；>1 → 下行本地子槽位」决定投递，`source` 全程保持以承载回程方向；回执沿树反向回程（worker → 主RT → 宿主/端点连接），correl 原样透传配对。路由点为各 runtime 的信封读回调（`src/host/rt_main.c` 的 `process_rx`、`src/ipc/ipc_process.c` 的父侧 worker 通道读回调），命中本地的回执由 `qz_ctl_deliver_receipt` 投递、命令交既有 dispatch——OFF 档信封命令入站即丢弃（§4.1）。无对应槽位回 `NOT_FOUND` 回执（不留无应答）。系统级 CONTROL（握手/idle/shutdown/closing）经 `qz_ipc_ctl_classify` 保持通道层消费、不进命令路由（新增 `QZ_IPC_CTL_SYSTEM` 归类 M-P4 closing）。回归护栏：`test/test_ctl_route_gtest.cpp`（路由决策/三层逐跳/信封透传/OFF/本地命中）+ `test/test_ctl_e2e.sh`（端点四命令 + 树路由到 worker 的隔离与 id 映射 + NOT_FOUND + OFF 恒拒）。
- 多进程模型 M-P4（崩溃恢复/孤儿回收 + `kind=STORAGE` 单所有者 storage 代理）：storage 所有权归主RT，PROCESS worker 内 `localStorage.*` 经信封 `kind=STORAGE(4)`（§4.1 冻结 schema，只加枚举值、无新字段）同步路由到所有者执行——payload = `{op,key,value?,storageDomain}` 的 structured-clone 字节（复用现有序列化，C 层只透传信封，op 编排在 `polyfill/src/local-storage.js`）。同步语义：worker 侧 `pal.storageSync` 阻塞往返（C 侧 `child_storage_sync` poll/recv 等待，期间**不跑 uv_run** → 无 timer/async 回调 → 无 JS 重入；大 payload 走阻塞整帧发送 `qz_ipc_child_emit_sync`），`getItem/setItem/removeItem/clear/key/length` 与同进程语义一致，配额异常原样跨进程传播为 `DOMException('QuotaExceededError')`。THREAD worker 仍不挂 localStorage（基线零改动）；`flock` 未引入（§10.2 v6 裁决）。崩溃检测（§9.3）：worker 侧 fd EOF → 主RT dispatch `Worker.onerror`（自愿 `close()` 经 CONTROL{closing} 区分，不误报；显式 terminate 不误报）；主RT 死亡 → 宿主 `message_cb` 收 `{"type":"error","error":"main-runtime-process-exited-unexpectedly"}` + `qz_wait_idle` 立即返回（CLI 补报并退出码 1）。孤儿回收（§6.4/§9.4）复核达成：parent-fd EOF → 自杀，主RT 死亡时 worker 连锁自杀，SIGKILL 后 waitpid 收尸无 zombie。验证：`test/test_mp4_storage_crash_e2e.sh`（跨进程 storage 一致性/配额 × worker kill -9 onerror/自关静默 × 主RT kill 宿主感知+连锁死亡 × 宿主 kill 孤儿回收 × 2000 条洪泛无丢失）+ `PolyfillTest.StorageOwnerDispatch` + envelope kind 全枚举往返 gtest；M-P1/M-P2/M-P3 e2e 与 ctest offline 21/21 无回归。已知延后：tier-2 终止超时轮询仍同步阻塞（I5，见 plan §9.2）。
- 多进程模型 M-P3（MessagePort 跨进程路由 + transfer 语义）：信封 `kind=PORT_TRANSFER(1)` 落地（§4.1 冻结 schema），payload 加 16B LE 路由头 `op/dest_owner/key_owner/key_port` + 原样 structured-clone 字节——中继节点读固定头即可判「本地投递 vs 转发」，不必解码 payload（§8.2 的可实现化，§7.2 字节不动）。C 层把 kind 一路透传到 JS（`__qz_dispatch__(data, source, kind)`、`pal.processOnMessage` 回调第二参、发送侧 `pal.workerPost/processPost/postMessage` 可选 kind），port 帧与普通消息自此可区分。JS 侧 port 身份改为 `(owner, id)` 组合（§8.2 直接父本地分配）：进程隔离下各进程本地 id 都从 1 起，此前 worker 自建 `MessageChannel` 会覆盖父转移来的 port 表项、echo 丢失——`(owner,id)` 消歧修复。跨端点消息经主RT（LCA）按帧头 `dest_owner` 接力转发（sibling 两端分属两个 worker 进程亦可往返）。端点死亡（fd EOF / terminate）清路由表并给对端 port 派发一次 `error`，此后 `postMessage` 静默（规范语义）。
- 多进程模型 M-P2（宿主↔主RT 进程分离 + C API 透明切换）：新增 `QZ_PROCESS_MODEL` 编译开关（`ISOLATED` 缺省 / `THREAD` 回退）。ISOLATED 下 `qz_create` spawn `qzjs-rt --qzjs-rt-server --parent-fd N`（复用 M-P1 socketpair + 握手 + FlatBuffers 信封），`qz_post_message` / `message_cb` / `qz_wait_idle` / `qz_destroy` 签名与语义不变——`wait_idle` = CONTROL{idle} → 主RT 排空后回 ack 并自身退出；`destroy` = 三级终止（shutdown → 超时 → SIGKILL）+ waitpid 收尸。宿主进程死亡 → 主RT 经 parent-fd EOF 自杀（孤儿回收）。worker 后端缺省随编译模型（ISOLATED→PROCESS）；`qz_config_t.worker_backend` 枚举值随宏条件编译（只用符号常量）。THREAD 编译保持单进程基线，显式 PROCESS 在 `pal.processSpawn` 求值点报错。已知缺口：ISOLATED 下 DAP 与 CTL-0 IN_PROC 未接通；§2.1「THREAD 不编入 ipc_*.c」源级排除延后（语义门先达成）。SSOT：`docs/archive/plans/2026-09-04-multi-process-model.md` §1.4 / §6 / §9.2 / §11。
### Removed
- `QZ_PROFILE=bare` 档（五宏全 OFF，不满足 ECMA-429 WinterTC）。
- JS flatbuffers 退役：flatbuffers 重新定位为纯 C 层内部格式（当前无 C 消费者，不实现 C 代码）。JS 层退役理由：① JS 急切 decode 无性能优势（encode 两趟 vtable 回填+对齐，decode 遍历整表物化对象），zero-copy 随机字段访问优势仅在 C 层成立；② Worker 间为同进程共享内存通信，非 IPC 场景，无需跨进程序列化协议，flatbuffers 的跨界序列化价值在 qzjs 中不存在。gRPC 序列化改为 protobuf-only（标准互操作：grpc-go/grpc-js/grpcurl/Envoy）。删除 flatbuffers.js（1219 行）、loadFlatbuffers API、flatbuffers harness、`application/grpc+flatbuffers` content-type。纯 C 层定位：未来出现真实 C 层序列化需求时按 `docs/archive/plans/2026-09-03-flatbuffers-runtime-builtin.md` 方案 B（惰性访问器）实施。

### Replaced
- polyfill OSS 化（批2，用户 2026-09-13 裁决「能用开源库的用开源库替代」）：`url-pattern.js` → `urlpattern-polyfill@10.1.0`（MIT 零依赖，自研 3.1KB → 库 21.2KB minified，官方 WHATWG 语义，含完整 `:x?`/`+`/`*` modifier；相对字符串 pattern 无 base 的 qzjs 语义经 wrapper 适配为对象形式）；`structured-clone.js` 深拷贝委托 `@ungap/structured-clone@1.4.0`（ISC 零依赖，11.4KB → 3.0KB minified），qzjs 扩展语义保留自研分支（MessagePort transfer、ArrayBuffer transfer、DataView offset/len、Blob/File、DOMException）。字节 ABI `__qz_serialize__/__qz_deserialize__` 原样保留。bytecode：139,105B → 192,328B（+53,223B）。gtest 89/89 PASS。
- polyfill OSS 化（批3，streams）：`streams.js` 三大流类（ReadableStream/WritableStream/TransformStream + 控制器/读者/写者 + 两个 QueuingStrategy）委托 `web-streams-polyfill@4.3.0`（MIT 零依赖，18.2KB → 62.1KB minified），WHATWG 规范实现（BYOB、tee、pipeTo({signal})、背压/取消全补全）；保留自研 CompressionStream/DecompressionStream（pal.nativeCompress/nativeDecompress C 扩展 miniz 委托）+ TextEncoderStream/TextDecoderStream（Encoding 规范，wsp 不含）。http-server.js feedBody 用公开 API `controller.desiredSize` 替代 `_stream._queue`（wsp 无此内部字段）；abort.js 加 `AbortSignal.prototype[Symbol.toStringTag]="AbortSignal"`（spec 要求 + wsp webidl brand-check）。bytecode：203,299B → 264,512B（+61,213B）。gtest 89/89 + compress 25/25 + compress-consistency 18/18 + lazy 16/16 + fetch-stream 9/9 + e2e httpserver 30/30 PASS。
- polyfill url.js 评估保留（2026-09-13 裁决）：whatwg-url@16.0.1（MIT，whatwg-url 全规范实现 + tr46 IDNA 表）不可引入。两重阻断：① 体积 — whatwg-url 含 tr46 Unicode 属性表 ~485KB minified，bytecode 923KB（baseline 7×），违反 ES2020 可读性约束；② 加载时序 — whatwg-url 依赖链 @exodus/bytes 在模块顶层执行 `new TextEncoder()` 检查，esbuild IIFE 模式将全部代码静态内联到 IIFE 入口（函数体前），导致 TextEncoder 在 polyfill setupTextEncoding() 注册前被引用，QuickJS IIFE 内无动态 `import()` 延迟加载能力，无法实现有序加载。自研实现含已知 IDNA 降级（punycode 返回 NaN），是规范行为（非 bug），触发条件：若 IDN hostname 解析在实际使用中造成 bug → 再评估修复路径（可考虑分包 lazy 加载方案）。

### Added
- Build Profiles（`QZ_PROFILE` 两档，feat(build) 59fb8f2e 收编）：`minimal`=保留全部 ECMA-429 必选集仅裁 TLS（fetch 降 http-only）；`standard`=全 ON（与空 profile 等效）。空值（默认）行为与历史逐位一致；显式 `-DQZ_WITH_X` 覆盖预设；非法值 configure FATAL_ERROR。同 build 目录换档自动重算五项 cache（显式 `-D` 值换档后不保留，建议新 build 目录）。实测 strip 尺寸：minimal Release 2.45 MiB / MinSizeRel 1.81 MiB。
- `QZ_WITH_GRPC` 收编为 CMake option（原为裸 env）：ON 时 polyfill rebuild 传 `QZ_WITH_GRPC=1`，把 gRPC/HTTP2 栈（h2 + HPACK + protobuf + grpc，约 3.5k 行 JS）编进当前 QZ_POLYFILL_MODE 的生成文件（rodata 默认写 `src/polyfill_default.c`，其余模式写 `src/polyfill_<mode>.c`）；工具链缺失时告警跳过；手工路径 `QZ_WITH_GRPC=1 node polyfill/build.js` 不变。
- External polyfill 模式完整性锚定（`QZ_POLYFILL_MODE=external`，纵深防御非安全边界）：build.js 构建时将官方 bytecode（`dist/polyfill_default.polyfill`）的 SHA-256 内嵌进 `src/polyfill_external.c`（`qz_polyfill_external_sha256`），运行时加载器校验磁盘文件哈希，不一致即拒绝加载（返回 `QZ_ERR_PERMISSION`）——防部署后数据文件被篡改/替换；自定义自建 polyfill 需用 build.js 重新生成以更新期望 hash。SHA-256 为自包含 C99 实现，仅 external 分支编译，不引入新依赖。
- Polyfill lazy 初始化（`polyfill/src/lazy.js` 新增 + `polyfill/src/index.js` 注册面 + `grpc-stack.js` G 单元注册式）：setup 顺序执行 → 14 eager + 17 lazy 单元分裂。核心/薄模块（console/timers/event-target/abort/error-events/url/encoding/text-encoding/performance/navigator/host-messaging/structured-clone/context/crypto 壳）注入即 setup；重量级/场景专属 API（fetch/streams/blob/worker/message-channel/service-worker/caches/websocket/eventsource/broadcast/url-pattern/serve/localStorage/fs/storage/crypto.subtle/grpc 栈）首次访问才 setup——`lazyUnit` 注册 enumerable+configurable accessor，首访先清整单元 accessor 面再跑原 setupXxx，产物退化为与 eager 逐位一致的数据属性；setter 先 ensure 再落值（monkey-patch 与 eager 同语义）。非属性面 API（qzjs.fs/qzjs.storage、navigator.serviceWorker、crypto.subtle）用「宿主 eager 空壳 + 子属性 getter」；级联 F→S→B、W→M、SW→W、WS→CS、serve→G 共享 ensure（done 前置位，重入短路）。`QZ_WITH_GRPC` 保持构建期门控（OFF 引 stub → G 单元零 getter、API 面与字节均不产生）。透明性契约（§2.5 消费者无感：首访前 in/keys 可见、首访后 descriptor 位相等、删除不复活、级联无中间态泄漏）由新增 `test/test_polyfill_lazy_gtest.cpp` 14 用例钉住；既有 polyfill 81 + context + fetch_stream 回归无破坏，build_citest offline ctest 20/20。设计见 `docs/archive/plans/2026-09-09-polyfill-lazy-init.md`。性能量化：未用 API 不再 setup（省实例/闭包/路由表），启动/内存权威基线以 CI runtime-perf 为准。
- 控制面 CTL-0（进程内基线）：`qz_control(rt, json, len)` 线程安全命令入口 + 回执经 `message_cb` 异步下发（顶层 `"ctl":true` 标记、`correl` 原样透传配对）。四命令：`eval`（跨 context 求值，回执 `result`）、`inspect`（表达式 JSON 序列化回执 `json`，不可序列化报 INVALID_ARG）、`metrics`（heap_bytes/handle_count/pending_jobs/ctx_count/worker_count 即时统计）、`interrupt`（生产者线程置原子标志，引擎指令边界触发，eval 被打断回执 code:INTERRUPTED）。安全模型：三档配置 `control_plane`（OFF 默认恒拒 -1 / IN_PROC / LOCAL 预留）；correl 回执表登记先于入队（dispatch 必命中），命令超时 fail-closed——主循环每轮 reap 过期条目发 TIMEOUT 回执、dispatch 前 ctl_claim 复核（已过期命令作废绝不迟执行），入队失败自动注销；中断异常不可捕获（uncatchable error）不污染宿主 try/catch。配套 `test/test_control_gtest.cpp` 7 用例（eval 成功/异常、inspect、metrics、OFF 拒绝、未知 op、超时回收），`test_host.h` 增控制面 helpers（host_control/host_wait_ctl/ctl_eval_json，回执按 `"ctl":true` 前缀+correl 分流配对）。设计依据 `docs/archive/plans/2026-09-04-control-plane-design.md` §1-§6。
- 多进程模型 M-P0 信封编解码器：`src/ipc/ipc_envelope.c/.h` —— 手写 FlatBuffers wire-format 编解码（固定 `Envelope{source:int32, target:int32, kind:int8, payload:[ubyte]}` schema，零依赖零生成步骤，~130 行 C99）。encode 产出规范布局（vtable 12B + 表 + 向量，40+payload 字节）；decode 布局无关（读任意合法 fb Envelope：短 vtable 缺字段回退默认值、恶意长度全部边界检查拒绝），payload 零拷贝片引用。配套：`test/test_ipc_envelope_gtest.cpp`（8 用例：字节布局冻结/往返/短 vtable 缺省/全字节变异/截断前缀）、`test/ipc_envelope_cli.c` + `test/ipc_envelope_fbcheck.py`（与 Python `flatbuffers` 官方库双向交叉验证 5 用例——C 编码→Python 解码、Python 编码→C 解码，字节级 wire 兼容硬证据）、ASan+UBSan 20 万随机 buffer 模糊通过；ctest 注册 `test_ipc_envelope_gtest` + `ipc_envelope_fbcheck`（offline 标签，flatbuffers 包缺失时自动跳过后者）。设计依据 `docs/archive/plans/2026-09-04-multi-process-model.md` §4/§11。
- 多实例生命周期 M-R1（§13）：一个宿主进程 N 个 `qz_t` 并存审计 + 约束落地。①全局状态审计表落入 `src/base/qz_rt.h`（§13.2 清单：polyfill 四模式、JSClassID 原子计数器、port id 原子计数器、WAMR 单例、DAP stdio、env/信号、storage——修改全局状态必须回表复核）；②修复 `qz_wait_idle` → `qz_destroy` 双重 join（裸 `pthread_join` 对已 join 句柄是 UB）——`thread_joined` 原子跟踪，`qz_destroy` 跳过已完成的 join；③WAMR 进程单例 `g_wamr_state.initialized` 原子 CAS 状态机（0=未初始化/1=就绪/2=进行中）：多实例并发 init 只跑一次 `wasm_runtime_init`，非报主者 spin 等待，失败回滚可重试；④DAP stdio 单通道约束（开放点 #8）：缺省 attach（cfg 缺省或 in/out 均 NULL）原子认领进程级 stdio，第二实例显式报错拒绝（`qz_dap_attach` 返回 -2，auto-attach 路径 → `qz_create` 返回 NULL，不静默降级成无调试器运行），`qz_dap_detach` 释放认领；⑤回归测试：`test_multi_instance_gtest`（双实例交错 eval/destroy 无串扰、wait_idle→destroy 单次 join、port id 跨实例唯一）+ `DapDebugger.StdioConflictSecondInstanceRejected`（fork 双实例：第二实例拒绝、detach 后重 attach 成功）。storage 单所有者同进程收敛（§10.2）随 M-P4 `kind=STORAGE` 落地。
- gRPC/HTTP2 Phase 3a（C 服务端 ALPN）：`tcpListen` 第5参 `tlsOpts` 新增可选 `alpn` 字段（字符串数组，如 `['h2','http/1.1']`），经 `mbedtls_ssl_conf_alpn_protocols` 在 TLS 握手时协商协议；缺省 `['http/1.1']`（向后兼容，现有 `serve()` HTTP/1.1 行为不变）。`serve()` 的 `tls` 选项现在透传 `alpn`/`sni` 等全部字段到 `tcpListen`（此前只取 `cert`+`key`，丢弃其余）。TLS 握手完成后，服务端连接句柄暴露 `conn.alpn` 属性（协商的协议字符串，如 `"h2"` 或 `"http/1.1"`；未协商时为 `null`），供 JS 层嗅探协议（服务端 gRPC 路由依据）。新增 e2e 测试 3 用例（`test_tcplisten_tls_alpn_h2` / `test_tcplisten_tls_alpn_http11` / `test_tcplisten_tls_default_no_alpn`），Python `ssl.set_alpn_protocols` 为对端验证协商结果。
- CI: HTTP/2 客户端栈性能基准 h2-client-perf job（Node http2 对端 + 纯 JS 栈，阈值=基线50%）
- gRPC/HTTP2 Phase 2（polyfill 客户端）：`polyfill/src/grpc.js` 实现 unary gRPC 客户端——5 字节帧头编解码、content-type 区隔（`application/grpc+proto` / `application/grpc+flatbuffers`）、`te:trailers`、trailers 解析（`grpc-status` / `grpc-message` percent-decoded / `grpc-status-details-bin` base64）、`StatusError`（携带 code + metadata + details）、`FrameSplitter`（`maxRecvMsgSize` 防 OOM）、连接级透明重试一次、方法解析（字符串路径 + registry 或预绑定方法对象）、序列化类型推断（`kind==='message'` → protobuf，`'table'` → flatbuffers）。`QZ_WITH_GRPC` 编译开关：esbuild alias 门控（`@qzjs/grpc-stack` → stub 模块），OFF 态 tree-shake 消除全部 gRPC/HTTP2/HPACK 模块（polyfill.js 268KB→OFF，411KB→ON；bytecode 145KB→OFF，238KB→ON）。`flatbuffers.js` 扩展：`parseService()` 解析 RPC 方法签名、`Schema.prototype.service(name)` 返回带 `method(name)` 访问器的 service 对象。`protobuf.js` 扩展：`Registry.prototype.service(name)` + `svc.method(name)`。e2e 测试 24/24（手写 Node http2 对端 + @grpc/grpc-js 标准对端），C 侧 offline 15/15 无回归。flatbuffers 适用场景：qzjs↔qzjs 内部快路径（零拷贝 schema-driven），对外互操作默认 protobuf
- gRPC/HTTP2 Phase 0（C 传输原语）：`pal.tcpConnect(host, port, callbacks[, opts])` 新增可选第 4 参，`opts.tls` truthy 即把该连接变成 mbedTLS **TLS 客户端**（此前 `tcpConnect` 只有裸 TCP，TLS 仅存在于 `tcpListen` 服务端路径）。`opts` 接受扁平形状 `{tls:true, servername, alpn:[…], ca}` 与设计文档形状 `{tls:{…}}`；`servername` 缺省取 host（空串明确拒绝，不给「零长度主机名可能跳过校验」留口子），`ca` 缺省用系统 CA 束（PEM 路径或内联 PEM 均可）。信任策略与 `uv_io.c` 的 HTTPS 客户端同纪律：**恒 `MBEDTLS_SSL_VERIFY_REQUIRED`**（无可用 CA 时握手必失败，绝不静默降级为不验证），`mbedtls_ssl_set_hostname` 提供 SNI + 证书主机名校验，握手后再查一次 `mbedtls_ssl_get_verify_result` 作纵深防御；`tls` 为真但构建时 `QZ_WITH_TLS=OFF` 直接抛错（fail closed，不假装明文可用）。**ALPN**：`mbedtls_ssl_conf_alpn_protocols` 首次接线（mbedTLS 早已编入 `MBEDTLS_SSL_ALPN` 但全仓从未调用），缺省 `['h2','http/1.1']`，显式 `alpn: []` = 不提供 ALPN，非数组/含非字符串/超 7 项同步抛 TypeError（不静默改用缺省）；协商结果暴露在连接句柄的 `conn.alpn`（未协商成功时为 `null`；裸 TCP 连接不设该属性，零回归）。时序修正：TLS 客户端的 `onconnect` 延迟到握手完成之后才触发，因此 JS 在 `onconnect` 里写出的字节一定是明文（h2 连接前导/SETTINGS 由 mbedTLS 加密），不会出现明文协议前导打到 TLS 端口的静默错误；握手失败走既有 `onerror` + 清理 TLS 上下文 + 关 TCP。这是 h2-over-TLS gRPC 客户端（Phase 1+）的唯一 C 前置。测试：test_httpserver_e2e.py 新增 6 例（ALPN `h2` 协商 + 明文字节往返、对端无 ALPN→`alpn:null`、`alpn:[]` 关闭 ALPN + 非法 alpn 抛错矩阵、自签名证书被系统 CA 拒、servername 不匹配被拒、嵌套 opts 形状等价），对端用 Python stdlib `ssl` 起（`tlsListen` 服务端 ALPN 属 Phase 3/G4，故不用 qzjs 自己当对端）；30/30 e2e 全绿（含全部裸 TCP WebSocket 用例零回归），另 300 次 TLS 握手/关闭同进程压力无崩溃，`QZ_WITH_TLS=OFF` 构建通过且 `tls:true` 正确抛错
- 打包：polyfill 字节码加载四种可选模式（`QZ_POLYFILL_MODE`，CMake 选项，默认 `C`）。C（默认）= const 数组直接嵌入 .rodata（现状，进程常驻 ≈137KB）；A（压缩嵌入）= build.js 构建时用 zlib 压缩字节码为更小 const 数组（本仓 145,265B→72,186B，-50%），`qz_create` 首次建 context 时用 miniz（tinfl）解压到堆、各 context 共享一份、runtime teardown 释放；B（外部文件）= 字节码不嵌入，构建时输出独立 `dist/polyfill_default.polyfill`，运行时经统一接口读入堆（路径 = `QZ_POLYFILL_FILE` 环境变量或同名编译宏，文件缺失/打不开给出明确错误并拒绝启动，进程常驻 ≈0 但需随程序分发文件）；D（自定义来源）= 不内嵌数据，暴露弱符号 `qz_polyfill_load_custom`/`qz_polyfill_unload_custom`（缺省实现返回错误），宿主可覆盖以从任意来源（外部 flash 映射、自定义存储等）提供字节码。统一加载接口 `qz_polyfill_load`/`qz_polyfill_unload`（qz_internal.h 声明，polyfill_load.c 按 mode 各自实现），context 创建改经该接口获取 polyfill（runtime 级缓存、单次加载多 context 共享；worker/多 runtime 各自加载一份），A/B/D 堆缓冲在 runtime teardown 释放（ASan 无泄漏）。权衡：A 省 .rodata、启动多一次解压；B 常驻内存最低、需分发文件；D 最灵活、由使用者自担来源与生命周期
- WAMR AOT Tier 0/1：`WebAssembly.compile(bytes, options?)` / `instantiate(bytes, importObject?, options?)` / `compileStreaming(src, options?)` / `instantiateStreaming(src, importObject?, options?)` 接受非标准可选 options `{aot: aotBytes, aotFail?: fn}`——提供 `.aot` 字节时 AOT 优先（`wasm_runtime_load` 按 `\0aot` 魔数自动分派到 AOT 加载器，Tier 0 直传 `.aot` 字节本就可用）；AOT 加载失败（版本/arch/ABI/损坏）静默回退解释器（fail-open，用可移植 `.wasm` 字节）+ 可选 `aotFail` 回调接收失败原因，不抛 JS 异常；仅提供 `.aot` 字节（无 `.wasm` 保底）时失败照抛 TypeError。实现为 ext_wamr.c 内嵌 JS shim（捕获并复用既有 C compile/instantiate 入口），streaming 两条 C 入口透传 options，无新 pal 原语、C 构造器零改动。注：真实 `.aot` 端到端（wamrc+LLVM 生成、AOT 模块 + imports 双加载）需 LLVM 主机验证；本机 gtest（test_wasm_aot_gtest 7/7）用伪造 `\0aot`（版本不符）确定性覆盖 fail-open 回退、aotFail、纯 .aot 抛错、module-arg 忽略 aot、streaming 透传与无 options 回归。
- WASM imports（importObject）：`WebAssembly.Instance(module, importObject)` / `WebAssembly.instantiate(buf|module, importObject)` 现支持函数导入——按 importObject 逐项解析（`importObject[module][field]` 取 JS 函数，缺模块/字段/非函数抛清晰 TypeError），按导入模块名分组注册为 WAMR raw native（`wasm_runtime_register_natives_raw`），WAMR 在加载期解析 import，故 Module 构造在注册后重载字节码使导入链接生效；native 调用时 JS ↔ WASM 双向类型转换（i32→Number、i64→BigInt、f32/f64→Number，导出 i64 结果用 `JS_ToInt64Ext` 兼容 BigInt），导出函数可回调宿主函数，宿主函数抛出的 JS 异常原样传播回导出调用方（pending-exception 槽挂在实例 wrap 上经 custom_data 关联）。限制（文档标注）：内存/全局/表导入不支持（实例化时明确 TypeError）、单导入单结果、>16 参数拒绝、同 import 模块名+字段跨模块以最近注册的签名为准（WAMR 全局 native 注册语义）。wasm3 同步对齐：缺失导入按 LinkError 计数报错、非对象 importObject 抛 TypeError、导入字段非函数计入缺失。新增 gtest test_wasm_imports_gtest 10/10（宿主回调 i32/i64/f64/void、instantiate 路径、缺导入/非对象/内存导入报错、宿主异常传播），ctest -L offline 14/14 全绿。
- fetch 出站代理：支持 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`（含小写、`*`/后缀匹配）环境变量。C 层透明实现：http 走绝对式请求行（RFC 7230 5.3.2），https 走 CONNECT 隧道后 TLS 端到端（主机名校验仍对源站）；非法/不支持 scheme 的代理 URL 立即失败（fail closed），不静默回退直连。流式与非流式 fetch 均生效，新增 e2e test_fetch_proxy_e2e.py 7/7。
- HTTPServer perf：修复 TextEncoder 大字符串编码走 JS 慢路径的存量 bug（nativeEncodeUtf8 由 C extension 在 polyfill 求值后注册，顶层一次性 `typeof` 检测恒 false），改为惰性探测；C 侧改用 `JS_ToCStringLen`（顺带修复含 NUL 字符串 encode 截断）。wrk -t2 -c64 /medium(16KB) 240→5100 rps（+21x），/small 2897→11174（+3.9x），/tiny +31%，/post +32%，错误归零
- HTTPServer perf：缓存 handler + Request 构造器引用，Headers._map 直写（绕过正则 normalize），wrk -t4 -c100 /hello +37% /gzip +49% /big +13%
- HTTPServer WebSocket：服务端消息分片重组（FIN=0 + Continuation 帧拼为完整消息）+ 子协议协商（ws 路由支持 `{handler, protocols}` 对象形式，回显首个双方支持的 `Sec-WebSocket-Protocol`）
- HTTPServer 请求体流式：`req.body` 变 ReadableStream（header 一到即调 handler，body 增量 enqueue，二进制安全），新增 `req.text()`/`req.arrayBuffer()`；连接缓冲改字节级（修复二进制 body 经字符串往返膨胀的存量 bug）
- HTTPServer WebSocket：permessage-deflate（RFC 7692）——协商、RSV1 收发、上下文 takeover；C 层新增流式 deflate/inflate 原语（`pal.deflateCreate/Push/Free`、`inflateCreate/Push/Free`，miniz 流式上下文）
- fetch 客户端请求体字节化：`fetch(url, {body})` 的 body 统一序列化为 `Uint8Array` 传给 `pal.httpRequestStream`（支持 string / Uint8Array / ArrayBuffer / ReadableStream，流式 body 异步读取全部 chunk 后再发请求，读取失败 reject）；C 桥接层 `http_request_stream` 直接接受字节 body（不再强制 C string）
- SSE（EventSource）与 WebSocket 补齐 WHATWG 完整语义：EventSource 继承 EventTarget（addEventListener/removeEventListener/dispatchEvent + onopen/onmessage/onerror 处理器属性桥接）；text/event-stream 解析规范完整化（BOM 剥离、LF/CRLF/CR 行尾归一、多 `data:` 行 LF 连接、空 `data:` 分发空串消息、注释行、`event:`/`id:`/`retry:` 字段、跨 chunk 字段缓冲、流式 UTF-8 TextDecoder）；重连语义（网络错误/正文结束按 `retry:` 延时重连并回传 `Last-Event-ID`，非 200 按规范 fail 不重连，`close()` 停止）；WebSocket 继承 EventTarget、binaryType（`blob`/`arraybuffer` 校验）、`_fail` 触发 onerror + onclose(1006, '')、`close(code,reason)` 校验与 code 传播、send 类型映射（string→TEXT、ArrayBuffer/Blob/TypedArray→BINARY）、客户端发送强制 mask、收到服务端 masked 帧/RSV 置位/非法控制帧按协议错误 fail

- WASM 引擎：wasm3 补齐 `WebAssembly.compileStreaming`/`instantiateStreaming`（与 WAMR 语义等价：取完整字节后交 compile/instantiate）；修复 `QZ_DEFAULT_EXTENSIONS` 从未注册 wasm3 的根因（wasm3 构建下 `WebAssembly` 全局缺失），streaming 测试门控改为 WAMR OR WASM3
- WinterTC/ECMA-429 覆盖盘点（B4）：对照 ECMA-429（Minimum common web API）全接口逐项勾选，补齐 9 个缺口 gtest（CustomEvent / PromiseRejectionEvent / 全局 onerror+onunhandledrejection+onrejectionhandled+reportError / TextEncoderStream / ByteLength+CountQueuingStrategy / TransformStream / BroadcastChannel 克隆隔离 / CacheStorage 扩展 / MessageChannel 消息往返），polyfill gtest 60/60
- A2 多上下文/Worker 健壮性（gtest + 压力）：软挂起边界 4 例（destroy 后 resume 同槽字节一致、坏 state 路径报错隔离、不可克隆属性 skipped 语义、suspend→resume 循环 10 轮槽位稳定复用）；Worker 错误路径 6 例（transfer 重复/不可转移/detached buffer 抛 DataCloneError 且无副作用、非法 URL 构造失败不占槽位、terminate 后 postMessage 静默、父侧 handler 抛错 worker 存活、timer 回调异步抛错进 self.onerror 且 worker 存活）；压力 2 例（4 worker×20 消息洪泛内容校验、30 轮 ArrayBuffer transfer 往返链）
- HTTPServer 示例 C3：静态文件 gzip 结果缓存进 LRU entry（`entry.gz`），重复请求不再每请求重跑 CompressionStream/miniz——wrk 16KB gzip 响应吞吐与未压缩持平（压缩开销从每请求摊销为首次）
- 打包：polyfill 字节码剥离源码——build.js 改用 `qjsc -s`（单 `-s` 仅剥 source、保留 debug 文件名/行号；`-ss` 才连 debug 一起剥）。此前 90.5% 的字节码字节为字符串、含完整 polyfill 源码明文（可反编译还原全部实现），剥离后源码归零；`dist/polyfill.bytecode` 1,078,047B→137,886B（-87.2%），`dist/worker-boot.bytecode` 5,910B→1,522B，内嵌二进制（src/polyfill_default.c）与启动内存同步下降
- localStorage（Web Storage `Storage` 接口，同步 + 跨重启持久化）：`getItem`/`setItem`/`removeItem`/`clear`/`key(n)`/`length`，键/值强制 String，5 MiB 配额超限抛 `DOMException('QuotaExceededError')`。持久化路径 = 环境变量 `QZ_LOCALSTORAGE_FILE`，否则默认 `~/.qzjs/localstorage.json`（HOME 缺失回退当前目录 `.qzjs-localstorage.json`）；每次变更后原子写回（临时文件 + rename，C 侧新增 `pal.fsWriteSync`，父目录自动 mkdir），启动时同步加载（文件缺失/损坏 → 空）。仅在父 runtime 挂载 `globalThis.localStorage`，Worker 内不挂（无 DOM 场景）；与异步 `qzjs.storage` 共存
- crypto.subtle RSA：RSA-OAEP 加解密与 RSASSA-PKCS1-v1_5 签名/验证完整接线（C 层 mbedTLS 原语 `nativeRsaGenerateKey`/`nativeRsaOaepEncrypt`/`Decrypt`/`nativeRsaSign`/`Verify` + polyfill SubtleCrypto 方法分支）。generateKey 支持 2048/3072/4096 位（publicExponent 默认 65537）、importKey/exportKey 支持 spki/pkcs8（公钥 SPKI DER、私钥 PKCS#8 DER——PKCS#1 内层按 RFC 5208 包装，mbedTLS 无 PKCS#8 writer 故 C 层手写）、RSA-OAEP 支持 label 与 MGF1=hash（SHA-1/256/384/512）、RSASSA 支持 SHA-1/256/384/512；key.usages 按 WebCrypto 校验（OAEP→encrypt/decrypt/wrapKey/unwrapKey；RSASSA→sign/verify）。测试：OAEP encrypt→decrypt 字节往返、RSASSA sign→verify 与篡改拒绝、spki/pkcs8 import/export 往返、1024 位拒绝、3072 位往返（test_crypto_subtle_gtest 30/30，ctest -L offline 12/12 全绿）。jwk 格式未实现（spki/pkcs8 之外抛 NotSupportedError，文档标注）
- CI fuzz-smoke job（新增）：libFuzzer 直 fuzz `JS_ReadObject` 的字节码加载路径（`JS_READ_OBJ_BYTECODE`）——即内嵌 polyfill 与 worker boot shim 消费非受信字节的入口；无 corpus 60s ASan 冒烟，定位为崩溃门禁而非安全性证明，harness 暂内联在 workflow 中。
- CI coverage job 加行覆盖率门禁：首期基线 50%（2026-09-12 实测 53.7%），低于阈值 `::error::` 失败并中止 job，随覆盖率提升再收紧。
- examples 全量收编：`httpserver` / `stream-pipeline` / `fetch-proxy` / `worker-orchestrate` 纳入 `QZ_BUILD_EXAMPLES` 统一构建。
- gRPC 服务端流式（server streaming）：wire 层（http2-server.js 的 `write()` 多 DATA + `end()` trailers）本就支持多帧，本次补齐 gRPC 层语义——`grpc.createServer().addService` 放行 `returns (stream T)` 方法；流式 handler 返回数组/（async）生成器，每项编成一帧消息，OK trailers 收尾，中途错误走 trailers 态 `grpc-status`（`polyfill/src/grpc-server.js` 新增 `_respondStreamOk`，unary 路径不变）。客户端新增 `channel.invokeStream(method, req, opts) → Promise<Message[]>`（复用 `_once` 已收全消息的 wire 路径，空流合法；`invoke` 对流式方法改拒 `INVALID_ARGUMENT` 并提示用 invokeStream，不再报 UNIMPLEMENTED）。测试：grpc-js 客户端收 3 条消息 + OK 结束、qzjs 客户端对 grpc-js 服务端流式收 3 条、空流、数组/异步生成器两种 handler 契约、`test/grpc_harness.mjs` 22/22、`test/grpc_server_harness.mjs` 19/19 全绿（顺带修复 server harness 在 lazy 重构后缺 `globalThis.qzjs` 的崩溃）。
### Changed
- **feat(runtime)!: 启动脚本与字节码改经管道传递、零落盘（第一性原理：磁盘不是必需的传输介质）**——worker 与主RT 的启动源码、宿主 `initial_bytecode` 都不再经 `/tmp` 临时文件（`/tmp/qzjs-worker-<id>.js`、`/tmp/qzjs-rt-script-*`）中转。**旧机制的四条缺陷**：明文落盘（worker 脚本可含密钥/内嵌字面量，本机其他用户可直接读取）；靠子进程 `unlink` 清理（崩溃/读失败路径必然泄漏）；文件名靠进程内自增 id（`/tmp/qzjs-worker-1001.js` 每个实例首个 worker 都是 1001，跨进程必撞）；与 `argv` 长度限制赛跑。**新机制**：父端在 `qz_proc_spawn` 中、握手**之前**按固定顺序用 `qz_ipc_write_frame` 把源码、字节码各以长度前缀帧写入已 fork 的 socketpair（复用 `--parent-fd` 已有通道，不新增 fd）；子端 `rt_main.c` 以新形态 `--script-stdin` / `--bytecode-stdin` 从同一管道各读一帧。时序为全双工 socketpair，无死锁：父 write(源码[,字节码])→子 read→子 write(握手)→父 read(握手)→父 write(ack)。数据全程只在内存与 socketpair 中流动。**保留** `--script PATH` / `--bytecode PATH` 形态（手动运行 `qzjs-rt --script foo.js`、`qzjs --bytecode x.bc` 等既有调用不变）；新增 `pal.processSpawn` 的 `opts.source` 字段。`host_write_blob`（唯一的 /tmp 临时文件写盘函数）已删除，启动脚本/字节码传输不再有任何落盘路径。契约锁：mp1 e2e 断言两个前缀零残留（`compgen -G` 逐 glob 判定——`ls g1 g2` 缺一即非零会吞掉真实回归；注入临时文件即验证为红）。验证：nested/mp1/mp2/mr2 四套多进程 e2e 全绿、THREAD 编译过、`-e`/`--script PATH`/`--bytecode` 旧路径均正常、字节码经管道实跑（`qzjs --bytecode` 输出正确且零临时文件）。
### Fixed
- Polyfill 模式产物分家（fix(build)）：`polyfill/build.js` 原先四种 `QZ_POLYFILL_MODE` 都覆写同一个 tracked 文件 `src/polyfill_default.c`，切模式构建会污染 rodata 基线、并把上一模式的符号/哈希残留在产物里——现按模式落盘：rodata 仍写 tracked 基线 `src/polyfill_default.c`，compressed / external / host 各写 untracked `src/polyfill_<mode>.c`（`CMakeLists.txt` 的 `_polyfill_gen_c` 用同一映射，生成规则改由 `add_custom_command(OUTPUT)` 声明，非 rodata 缺产物时 configure 报错并提示跑 build.js）；external 的 SHA-256 锚定符号 `qz_polyfill_external_sha256` 随 `src/polyfill_external.c` 落盘。三模式运行时行为不变。
- standard 档修复（fix(build)）：`QZ_PROFILE=standard` 缺 `_prof_tls` 定义导致 configure 直接报变量未定义——`minimal OR standard` 组补 `TLS=ON`，修后 standard 首配 TLS/WAMR 均 ON。
- 同 build 目录换档修复（fix(build)）：CMake option() 只在首配填 cache，换 `QZ_PROFILE` 重配时旧 `QZ_WITH_*` 值静默残留——新增 `QZ_PROFILE_LAST` 检测，换档时五项 cache FORCE 重算为新档默认（`QZ_WITH_WASM3` 一并管理，恒 OFF），并保持 TLS→CRYPTO_EXT 联动不变。
- 挂起/恢复修复批次（fix(runtime)）：**G2** `qzContext.destroy` 销毁带 pending job 的子 context → UAF——`JS_FreeContext` 不清 `rt->job_list` 中属于该 ctx 的 entry，残留悬垂 `e->ctx` 在下一次 `JS_ExecutePendingJob`（每次 eval 后微任务冲刷）即访问已释放内存。修复：quickjs-ng 补丁新增公开 API `JS_DrainPendingJobsForContext`（`deps/quickjs-ng-drain-jobs.patch`，CMake 无条件应用，工作树补丁机制同 C99 atomics），`qz_ctx_destroy` 在 `JS_FreeContext` 前排空该 ctx 的 pending job。**G1** `qzContext.suspend` 只写盘不销毁 ctx——挂起后内存不释放，与注释"销毁该 JSContext"不符。修复：`qz_ctx_serialize` 写盘成功后调 `qz_ctx_destroy`（槽位置 NULL，resume 从空槽重建；写盘失败保留 ctx 供宿主重试）。**G3** 扩展 suspend/resume 钩子零调用方（死代码）：接线 `qz_ext_suspend_all`（capture 前）与 `qz_ext_resume_all`（restore 后，active 切回主 ctx 前）——当前扩展全 no-op，零行为变更，为扩展状态持久化铺路。设计边界文档化（G4 非枚举/Symbol 键全局不捕获、G5 pending Promise/定时器不随挂起保存）：`polyfill/src/context.js` 注释 + `docs/archive/plans/2026-09-04-suspend-restore-design.md`。测试：`test_suspend_gtest` 10/10——新增 `suspend_releases_slot`（G1 槽位空出 + resume 重建状态完整）、`suspend_then_double_suspend`（同 id 重挂起报 TypeError，失败不写半成品文件）、`suspend_with_pending_job_no_uaf` 升级为 G1+G2 联合场景（同 eval spawn→suspend 不 flush，恢复后用户状态完整往返）；`resume_into_fresh_slot`/`resume_bad_state_path` 适配 suspend 即销毁语义（保留 destroy→resume 兜底路径覆盖）；Debug 与 ASan+LSan 双构建通过。
- fetch NO_PROXY（fix(core)）：NO_PROXY 条目为方括号 IPv6 字面量（如 `[::1]`、`[::1]:8080`）时不生效——`uv_io_parse_url` 产出的请求 host 为裸形式（`::1`，不带方括号），后缀比较带着方括号恒不匹配 → 本应直连的 origin 被错误送经 proxy。修复：`uv_io_no_proxy_entry_match` 在拆出可选 `:port` 后剥离一对包裹方括号再比较。新增 e2e 2 用例（方括号条目 bypass 直连、未命中条目仍走 proxy），`test_fetch_proxy_e2e.py` 9/9。
- C核心（fix(core)）：CLI/HTTP 请求缓冲越界写（json_escape 信封按转义后实际长度分配 + snprintf 截断检查、ftell 失败/SIZE_MAX 缓冲）、chunked 解码 realloc UAF、fs_read OOM 双回调（先置 cb=NULL 再 close）、libuv handle 关闭引用计数误计数（mid-life close 独立计数，防 teardown 期间回调提前释放 op）、wait_idle 先 flush 微任务再判 JS 残留 job、teardown abort in-flight 流式 HTTP op、JS_Call 后取走并释放 pending exception；`_Atomic` 统一改 `__atomic_*`（C99 一致性）
- C扩展（fix(ext)）：raw_inflate 截断/空 DEFLATE 无限循环 DoS（补 MZ_BUF_ERROR 分支 + 10 万次迭代上限）、WAMR 栈数组越界（>16 参数/4 结果抛 RangeError，参数按真实 wasm 类型转换，不再一律 I32）、WAMR/wasm3 导出 Memory/Global/Module/Function 实例 UAF（instance_ref 持有实例引用 + finalizer 释放）、TLS 读循环回调后未查关闭（回调内关闭连接 → 继续读已释放 TLS 上下文）、JS TCP 句柄裸指针 UAF（finalizer 包装 + 关闭后置 NULL）、EC RNG 进程级静态 CTR_DRBG 竞争 → per-runtime DRBG（随 runtime 释放）、btoa/atob 二进制与内嵌 NUL 字节安全（JS_ToCStringLen + 高字节 UTF-8 重编码）
- polyfill（fix(polyfill)）：fetch 契约（Headers.get 空值语义——命中空串返回 `''`、Request.arrayBuffer() 返回真实 ArrayBuffer、Request/Response.blob() 返回 Blob、method 全 token/URL 绝对化/status 200-599 校验、abort reason 透传）、WebSocket 二进制帧/分片重组/掩码与 binaryType、streams 语义（ReadableStream 异步 pull 背压与 enqueue 后 close 抛错、WritableStream 串行写 + close 排队在写之后、pipeTo options.signal 中止、pipeThrough 错误传播到 readable）、crypto 校验（key.usages 白名单/tagLength 合法值/deriveBits 长度）、URL IPv6/host/port 校验、FormData 迭代与 Blob.slice 规范化、structuredClone 自定义类实例抛 DataCloneError
- CLI：test 构建（`QZ_BUILD_TESTS=ON`，mock libuv）下 qz_cli 链接 `qz_full`（真实 libuv）→ 核心按 mock 布局、libuv 按真实布局操作同一结构体，`uv_async_init` 越过 mock 大小的 wake 写坏紧随其后的队列字段，任何脚本（连 `console.log(1+1)`）都 `free(): invalid pointer`。修复：test 构建下 CLI 改链 `qzjs mock_libuv`（结构体一致，mock 的 poll 循环驱动 timers/asyncs/threads，基础脚本可正常求值；真实网络需 `QZ_BUILD_TESTS=OFF`）；并把 CLI 目标定义移到 `add_subdirectory(test)` 之后。
- 编译：`QZ_WITH_TLS=OFF` 时 `tcp_io.c` 的 `js_pal_tcp_reload_tls` 在 `#if QZ_WITH_TLS` 之外引用 `l->tls_ctx`（该字段仅在 TLS=ON 时存在）→ 生产 minimal 构建（`QZ_BUILD_TESTS=OFF` + 全扩展 OFF）编译失败。修复：把 `!l->tls_ctx` 检查移入 `#if QZ_WITH_TLS` 分支。
- 运行时事件循环：`qz_wake_cb` 一次 `uv_run` 派发多条入站消息，但微任务冲刷在 `uv_run` 返回后才统一进行——宿主在消息回调（dispatch 内联的 message_cb）里立即回发下一条消息时，下一条消息的 JS 会在本条消息的 promise 副作用落定之前被派发（读到旧状态）。ASan 构建下 `test_compress_gtest` 因此稳定失败/卡死（DeflateRaw 等 roundtrip 的 `_rok` 永不置位、部分测试直接挂起、GzipMagicBytes 即时读 `_gch` 落空）。修复：每条消息派发后立即 `qz_flush_microtasks`，保持"每条消息 = 一个任务，任务后微任务先跑完"的事件循环语义。ASan 该套件 5×18/18 全绿。
- 测试桩 flaky（`test_compress_gtest`）：Debug/非 WAMR 构建下 Gzip1MB / GzipMagicBytes / DeflateRaw 等 roundtrip 用例偶发 5s 轮询超时或整进程卡死。根因在 `test_host.h` 的 poll 语义：`host_poll_until_value`/`host_poll_until` 把整个 poll 的总预算（5s）当作单次 eval 的超时——qzjs 线程在 Debug 高负载下处理 1MB 压缩/解压消息队列（含 JS 层 1MB 比较循环，~1-2s）时，一次慢的 eval 会直接耗尽预算令 poll 一击即败；且该次 eval 超时后其响应稍后到达残留在 inbox，污染后续 host_eval 的"发一条/等一条"配对（错位雪崩，表现为后续测试连环失败/挂起）。修复：单次 eval 改用短超时（3000ms，min 剩余预算）+ 超时重试，poll 持续轮询直到条件满足或总预算耗尽（不再单次一击）；`host_wait_msg` 超时后丢弃堆积的 eval 响应残留（保留 worker/异步回调等非 eval 消息，不误删其他测试依赖），防止残留消息错位。
- HTTPServer：`sendResponse` 对象分支末尾缺 `return`，每个对象（Response）响应后在原连接上额外发一个 `500`——pipelining 客户端收到 `200+500` 双响应，wrk 全部计入 Non-2xx；补 return（合法响应只发一次）
- CLI/TCP 服务：写已关闭的对端连接触发 `SIGPIPE` 直接杀进程（wrk 压测客户端中断连即崩，exit 141）——`main()` 入口 `signal(SIGPIPE, SIG_IGN)`
- timers：setTimeout/setInterval 回调抛错只 `console.error`，不进错误事件流（worker 内 `self.onerror`/全局 `error` 监听收不到异步异常）——catch 后调 `reportError(err)`（存在性守卫，navigator.js 晚于 timers 挂载）再打日志，runtime 不中断
- structuredClone/Worker.postMessage：已 detach 的 ArrayBuffer 再进 transfer 列表不报错、静默无副作用（Web 规范应抛 DataCloneError）——两处 transfer 校验补 `detached` 检查，抛 `DOMException('ArrayBuffer has already been detached', 'DataCloneError')`
- TransformStream：存在 `flush` 时 close 后不调用 `terminate()`（readable 侧永不关闭，队列 drain 后第三次 `read()` 永久挂起）——await flush 结果后再 terminate，兼容异步 flush
- Blob：blobParts 非迭代对象抛 TypeError、type 规范化只去 0x09/0x0A/0x0D、字符串元素 UTF-8 编码
- Headers：new Headers(null) 与 3+ 元素 pair 抛 TypeError
- TextEncoder.encodeInto：代理对感知增量编码 + read/written 精确语义 + 非法目标类型抛错
- CLI/运行时内存泄漏：run_code 的 `json_escape` 返回值未 free；`qz_free` 未释放 `config.initial_script`（ASan 回归触发，e2e 16/16 + ASan 0 泄漏）
- Streams：pipeTo 收尾释放 dest writer 锁（正常/出错路径，之后 `dest.getWriter()` 可用）；`reader.releaseLock` reject 未决 pending read 与未 settle 的 closed promise、释放后 `read()` 抛 TypeError（BYOB 同）；tee 单分支 cancel 关闭该分支流（pending read 以 done 结束，另一分支继续）；pipeThrough 校验 `{readable, writable}` 结构与三流 locked 状态
- 运行时 teardown UAF：`qz_wait_idle`/`qz_destroy` 在 libuv 线程池 request（fs / getaddrinfo / queue_work）在途时进入 teardown，其 done 回调（`bridge_io_done`）在 JSRuntime 释放后 JS_Call → 崩溃（QuickJS `gc_obj_list` 断言 / UAF）。修复：`qz_loop_idle` 将 `loop.active_reqs != 0` 判为忙（wait_idle 等全部线程池 work 完成后才退出）；teardown 在销毁 contexts / 释放 runtime 前限轮排空已排队的 work_done 并 flush 微任务（兜底 destroy 瞬时窗口）。ASan 复现：无修复崩溃，有修复干净退出
- 打包（M5-G3）：`cmake --install` 现在同时安装全部 vendored 依赖归档（libuv/libqjs/libiwasm/libminiz/libmbedtls*/libmbedx509/libmbedcrypto）；`libqzjs.pc` 更名 `qzjs.pc` 并补全 Libs（按 `QZ_WITH_*` 列出所有扩展归档），`pkg-config --cflags --libs qzjs` 即可编译链接消费方（此前 `-lam` 链接缺 qjs/wasm/扩展符号）。WAMR fast-jit/lazy-jit 关闭（asmjit 为 C++，会把 C++ 运行时依赖带进 libiwasm.a；qzjs 仅需 Fast Interpreter + AOT，纯 C 可链接）
- DAP 调试器（A4）：运行中（非暂停）DAP 请求得不到服务——调试会话开着时事件循环一旦空闲，`uv_run(UV_RUN_ONCE)` 无限阻塞在 poll，而 DAP 消息走 stdin（非 libuv 事件源），pause/setBreakpoints/disconnect 永不生效（如 VS Code 点击暂停后调试器卡死）。修复：attach 时注册 50ms 周期轮询 timer（`qz_dap_service` 非阻塞排空 stdin：pause 武装下个 dispatch 检查点、setBreakpoints 立即替换断点表、disconnect 停轮询），使 uv_run 有界且每次醒来服务 DAP；`qz_loop_idle` 排除该 timer（wait_idle 照常退出）。worker 运行时不再 auto-attach DAP（stdio 单通道无法同时服务两个 runtime，原 QZ_DEBUG=1 下 worker 会与父竞争读 stdin → 死锁/协议错乱）；断点作用域 = attach 的 runtime，父断点不影响 worker。新增 test_dap_gtest `PauseWhileRunning`（运行中 pause → stopped）2/2 绿。
- 测试桩遗留超时（`test_compress_gtest`）：`CompressTestBase.GzipBinary1MB` 在 Debug 构建（含 ASan/UBSan）下单次 `host_eval` 超 5s 超时。根因是 JS 层 O(n) 循环在 unoptimized QuickJS 解释器下极慢——1MB 二进制数据的逐字节填充循环 ~5.8s、roundtrip 逐字节比较循环 ~2.6s（压缩/解压本身 C 侧仅 ~300ms）。修复：① 大 payload 二进制数据改用 4096 字节模板 + `Uint8Array.set` 块复制生成（原生 memcpy 级，保留原字节序列，5.8s→~30ms）；② 新增 `pal.nativeBytesEqual(a,b)`（C 侧 memcmp）作为 roundtrip 确定性校验（2.6s→~1ms）。`GzipBinary1MB` Debug 下 6249ms→~180ms；Debug `--gtest_repeat=3` 18/18、ASan（含 leak 检测）、Release ctest offline 13/13 全绿。
- 测试桩 poll 预算记账缺陷（`test_compress_gtest` 偶发挂起 >120s）：`host_poll_until`/`host_poll_until_value` 单次 eval 超时最多烧 3s 真实时间却只计 25ms 预算——5s 名义预算在 qzjs 线程真卡住时放大成 ~200 次重试 × 3s ≈ 10 分钟（brain 记录的"单跑偶发挂起 >120s"）。修复：改用 `CLOCK_MONOTONIC` 真实墙钟预算（`mono_ms` 截止时间），单次超时烧多少扣多少，最坏 ≈ timeout_ms + 一次在途 eval（3s），彻底消除挂起。Debug/Release 各 60 次单跑 + 12 核满载 308 次 + 单核饱和 91 次全绿。
- polyfill 消息层三规范偏差（fix(polyfill)）：① `EventTarget` 的 `once` listener 未在 invoke 前移除，嵌套 dispatch 会重复触发（改为调用前移除）；② `MessagePort` 本地 structuredClone 失败应按发送方抛 `DataCloneError`，此前误派到对端 `messageerror`；③ `BroadcastChannel` postMessage 的一次 clone 结果被所有 peer 共享，应每 peer 独立副本。

## [0.2.0] — 2026-08-19

### Added
- fetch redirect semantics: `Request` stores `redirect`/`keepalive`/`cache`/`mode`/`credentials` options; `fetch()` follows 3xx by default, `redirect:'error'` rejects, `redirect:'manual'` returns status-0 opaque response
- Worker MessagePort multihop transfer: port transferred parent→worker→parent routes through entanglement re-link (pure JS, no C changes)
- HTTPServer gzip LRU cache: per-body content hash (xxhash64+len) LRU cache, `/gzip` +2.25x (4811→10809 rps), module-ized `uvhttp_gzip_cache` (LRU + memory budget + TTL + same-key replace)
- crypto.subtle `wrapKey`/`unwrapKey` (raw + jwk formats, AES-GCM/CBC wrapping) — completes the SubtleCrypto method set; AES-CBC/GCM/CTR encrypt/decrypt round-trips now covered by gtest (algorithm correctness verified)
- ECMA-429 WEBCRYPTO/HR-TIME: `Crypto` / `SubtleCrypto` / `Performance` constructors now exposed on `globalThis` (the existing `crypto` / `performance` instances are unchanged) — completes the ECMA-429 common-interface set
- BYOB (Bring Your Own Buffer) streams per ECMA-429: `ReadableByteStreamController`, `ReadableStreamBYOBReader`, `ReadableStreamBYOBRequest` exposed globally; `ReadableStream({type:'bytes'})` + `getReader({mode:'byob'})`, `read(view)` fills caller-supplied views (partial-fill supported), `controller.byobRequest`/`respond`/`respondWithNewView` pull path
- `structuredClone(value, {transfer})` and `Worker.postMessage(value, transfer)` support transferable objects: ArrayBuffer (detached, `byteLength → 0`) and MessagePort (cross-thread transfer to Workers, bidirectional messaging; same-thread `structuredClone` returns a new usable port, original detached) per the structured-clone spec
- Standalone CLI (`qzjs`): script / `-e` / REPL modes, WinterCG `arguments`/`env` bridge, async-exit (waits for pending timers/fetch/streams); no Node.js APIs
- HTTPServer extension (`serve`): HTTP/1.1 + HTTPS (mbedTLS) + WebSocket + static files + gzip compression, uvhttp-backed
- Worker top-level exceptions now dispatch `ErrorEvent` on the worker (`self.onerror`) and on the parent (`w.onerror`)
- `importScripts('file://...')` in Workers (synchronous extra-script loading)
- `WebAssembly.compileStreaming` / `instantiateStreaming`
- `examples/` tree with runnable samples: `hello` (host↔JS messaging) and `worker` (real-thread Web Worker); built via `QZ_BUILD_EXAMPLES=ON`
- qz_tick encapsulates run_cycle — single unified call with timeout_ms
- qz_tick non-blocking design (returns 1/0/-1, no internal loop)
- pal_uv_create requires explicit loop injection (no NULL)
- QZ_WITH_NONUTF_ENCODINGS compile-time option (Latin-1 support)
- Promise resolution in qz_eval (async/await returns resolved value)
- JS exception messages captured in qz_eval result
- Runtime-verified npm packages: lodash, dayjs, semver, ms, pako, mitt, clsx, dequal
- WASM playground (qzjs compiled to WebAssembly via Emscripten)
- npm compatibility checker (compat_check tool)
- test262 CI job (prevents QuickJS-ng patch regression)
- ESP32 FreeRTOS PAL timer UAF fix (build-verified with ESP-IDF v5.5.4)
- CONTRIBUTING.md
- Website: Chinese translations, C API reference, examples page, compatible packages

### Changed
- WAMR-2.4.5 as default WASM engine with Fast JIT (wasm3 optional)
- QuickJS-ng ES support: ES2020 (not ES2023 — website corrected)
- uvhttp submodule updated to v2.6.1-59-g449f0ec (PR #348 qzjs embedding fixes + gzip LRU cache, PR #349 router_cache ABI fix)

### Fixed
- streams: `tee()` propagates cancel to underlying source (only when both branches are cancelled)
- streams: `pipeTo()` backpressure serialization + `preventAbort`/`preventClose`/`preventCancel` propagation
- TextDecoder fatal mode: `new TextDecoder('utf-8', {fatal:true})` now throws `TypeError` on invalid UTF-8 (4 branches: lead byte, overlong/out-of-range, truncated, continuation format)
- TextDecoder BOM stripping: `EF BB BF` at start of input is skipped by default; `ignoreBOM:true` preserves `U+FEFF`
- AbortSignal post-abort listener: `signal.addEventListener('abort', cb)` after `ac.abort()` now schedules `cb` via microtask
- URLPattern `:name+` / `:name*` modifiers emitted a literal `:` (never matched multi-segment paths); now emit `(.+)` / `(.*)` per the spec
- META: script= parsing off-by-one (16 chars not 15)
- Blob.slice edge cases (start/end handling, normalizeType spec compliance)
- pal_uv chunk-size cap for non-streaming chunked decode
- pal_uv_destroy in-flight op leak (proper close callbacks)
- Missing self=globalThis injection in WPT runner
- WPT: 0 ERRORs (down from 5), 165 PASS

## [0.1.0] — Initial

- Core runtime: qz_create/destroy/tick/eval/call
- Multi-context: spawn/suspend/resume/destroy_ctx
- WinterTC runtime: fetch, console, crypto, streams, timers, URL, encoding, Blob, EventTarget, AbortController, structuredClone
- PAL: libuv (Linux/macOS), mock (testing), FreeRTOS (ESP32-S3)
- Extensions: compress, crypto, textcodec, WAMR, wasm3
- DAP debugger (VS Code)
- WPT runner
- test262 integration
- VitePress documentation (en + zh)
- **test：修掉两个自己写出来的无效断言，并给端到端补上顺序与不重不漏**①`test/host_contract_e2e.c` 的顺序检查曾是**死代码**：`if (!contains(got, n, want) && strcmp(got[i], want) != 0)`——`contains` 扫的是整个数组，而上面已断言过 40 条一条不少，于是每条 want 都「存在」、`!contains` 恒假、`&&` 短路，失败分支**永不执行**；它唯一该抓的「顺序错乱但内容齐全」恰恰抓不到。顺序就是拿位置比，没有更间接的写法；另补一条正交的「每个期望值恰好出现一次」（不重不漏），并删掉因此不再使用的 `contains`。负控：期望顺序错位一格 → 红；制造重复 → 红。②interrupt 效果那条测试自己踩了两个坑才站住：把 8 字符的 `{"go":1}` 手写成长度 9，多读一个字节让 JSON 非法、消息根本没被处理，对照组于是假红（长度字面量这一类本轮已栽多次）；实验组预算 1500ms 又小于脚本 3000ms 的自然耗时，于是「没收到 done」既可能是被打断也可能只是没跑完，负控（摘掉 `JS_SetInterruptHandler`）照样绿。最终形态是「同一预算、两个相反结论」+ 忙等而非 sleep。③`DISABLED_TEST` 这个宏并不存在（gtest 用 `DISABLED_` 名字前缀），首次写成它导致编译失败；而当时我过滤了构建输出、只看 `ctest` 结果，把陈旧二进制的「100% passed」当成了真通过——本会话同类事故已第六次。此后凡带负控的验证一律不滤构建输出。

- **fix/test：补 interrupt 效果覆盖时挖出一个既存缺陷——打断正在执行的脚本会留下有根 JS 对象，之后销毁该运行时在 quickjs 断言上终止**。`qz_ctl_interrupt_handler` 返回 1 → quickjs 抛一个 **uncatchable** 的 InternalError 并 longjmp 展开，展开点上的解释器临时值就此无人回收；于是 `qz_destroy` 走到 `JS_FreeRuntime` 时命中 `quickjs.c:2762: Assertion 'list_empty(&rt->gc_obj_list)' failed`。**影响面不是「只在测试里」**：任何带断言的构建（所有 Debug 构建，含 CI 的 asan / ubsan 两个 job）里，对**被打断过**的运行时调 `qz_destroy` 会 abort；NDEBUG 构建里断言被编掉，那批对象**静默泄漏**。本项目已经知道这一类问题（`qzjs.c` 拆除里专门有一步「排空 pending JS jobs BEFORE freeing contexts/runtime」，理由写的就是这个断言），但打断这种情况救不回来。最小复现不依赖任何测试框架：建一个 `onmessage` 里 `while (Date.now()-t<3000){x++;}` 的运行时 → postMessage → 150ms 后发 `{"op":"interrupt"}`（不带 correl）→ 排干邮箱 → `qz_destroy`，就在此断言；**不发 interrupt 时同一脚本销毁干净**，所以与脚本本身无关。根因在 vendored quickjs-ng 的不可捕获中断展开路径，不在本仓库代码里，因此本轮只记录不修。对应的效果测试保留为 `DISABLED_interrupt_actually_aborts_running_script`（**不是删掉**——删掉等于把「interrupt 的效果从未被验证过」重新藏起来，而那正是要补的洞），注释里写清缺陷、机制、复现与归属；启用前必须先修掉它，否则 asan / ubsan 会一直红。

- **test：补上 interrupt 的**效果**覆盖（此前只验回执），并修掉两个自己写出来的无效断言**。①**interrupt 一直只验回执**：唯一的覆盖是 `test_ctl_e2e.sh` 那条「回执里有没有 `interrupted:true`」——而那张回执是 dispatch 路径**无条件**产出的，与引擎有没有真被打断毫无关系。也就是说中断处理器从没装上、标志读错、JS 侧不检查它，现有全部测试照样绿，而 §3.9「投递即生效」的实质恰恰是引擎指令边界上那个处理器把长任务掐掉。新增 `interrupt_actually_aborts_running_script`，用**对照组**设计：同一预算（5000ms，大于脚本 3s 忙等的自然耗时）下，对照组无 interrupt **必须**跑完并回 done，实验组发 interrupt（**不带 correl**，本轮刚把这条改成「照收 + 不登记不入队」，它必须仍然生效）则 done **始终**不出现。忙等而非 sleep：sleep 主动让出，标志只在指令边界被检查，测不到那件事。负控两则：摘掉 `JS_SetInterruptHandler` → 红；把处理器的判据改成恒假 → 红。②端到端那条**顺序检查是死代码**：`if (!contains(got, n, want) && strcmp(got[i], want) != 0)`——`contains` 扫的是整个数组，而上面已经断言过 40 条一条不少，于是每条 want 都「存在」，`!contains` 恒假、`&&` 短路，失败分支**永不执行**。它唯一该抓的「顺序错乱但内容齐全」恰恰抓不到。顺序就是拿位置比，没有更间接的写法；另补一条正交的「每个期望值恰好出现一次」（不重不漏），并删掉因此不再使用的 `contains`。负控：把期望顺序错位一格 → 红；制造重复 → 红。

- **test：按单元 / 集成 / 端到端三层补齐——补的都是「此前无人验」而非覆盖率数字**。①**单元**层新 `test/test_queue_gtest`（5 例）：`qz_out_push` / `qz_out_pop` / `qz_out_has_pending` 在 `qz_internal.h` 里可见，但此前**没有任何测试直接碰过它们**——M-P7 的承重结构一直只被整运行时间接测（发消息 → JS 回声 → 收），测不出属于「队列」而不是「运行时」的性质。补的五条：FIFO 逐条内容与顺序、空队列 pop 返回 NULL（宿主「没消息也照调」的前提）、has_pending 的状态迁移、**teardown 幂等**（本轮把实现从「靠调用次数门控」改成「排干后复位 head/tail/stub」，因为排干循环只把 head 推到尾节点、`stub.q.next` 仍指向早已 free 的节点，不重置就是悬垂指针——这条性质此前无人锁住）、多生产者计数完整性（跨生产者顺序不确定所以不断言顺序，但一条不多一条不少、内容不丢不重）。负控两则：破坏 FIFO → 红；撤掉 teardown 复位 → 红，且 **ASAN 精确报出 `heap-use-after-free ... in qz_out_has_pending`**，与实现注释里写的后果一字不差。②**集成**层给 `test_mailbox_oom_gtest` 加 1 例（`documented_consumption_loop_holds`）：验的是 `docs/{,zh/}c-api/runtime.md` 邮箱节那段消费循环的**行为**而不只是它能编译——文档门只保证那段代码能编。三条承诺逐一锁：库错误帧要认出来并跳过、遇到它**不能 break**（后面可能还有正常消息）、三态要分开判（把 -1 当「没消息」就是安静地少处理消息）。负控：把「不 break」改成 break → 红。写第一版时我留了一段没用的占位循环（先写空的再重写），已清掉。③**端到端**层新 `test/host_contract_e2e.c` + `test/test_host_contract_e2e.sh`：既有 8 支 e2e 的 harness 都是**测试专用**宿主、各自验一条断言，而宿主真正会做的事——照文档那段循环收发——此前没有任何一支在验。跑三条路径：文档循环原样、宿主自己的 eventfd（`qz_message_fd`）+ poll 驱动的循环（这是 M-P7「宿主什么都不用驱动，但可以用自己的 fd 等待」的直接验证）、`qz_wait_idle` 之后仍可排干。脚本末尾另有一道**防漂移检查**：文档与程序对库错误帧必须用同一条判别式——两边各写一次又没有检查的话，迟早文档说 A 程序做 B，而宿主照文档抄。这道检查第一版也是**空转**的：它对三者一律 grep 纯文本形式，于是程序侧匹配到的是文件顶部**注释**里那句说明、而不是代码，负控改了代码它照样绿。已改成文档侧匹配纯文本、程序侧匹配**转义后**的形式并加反向检查；现在改代码必红、改注释不红。

- **feat(runtime)!：单消费者契约从「只写在文档里」变成有运行时判据**（`qz_recv_message` 是公开 API，属破坏性行为变更）。出站队列是 lock-free MPSC，而 `qz_out_pop` 的 head 是**非原子**读写的——头注释写着 「consumer owns head, so no lock is needed」，这在单消费者前提下成立。两个线程并发弹出时：两者读到同一个 head、各自 `free(head)` 同一个节点（**double free**），并各自返回同一个 `next` → 同一条消息投递两次、另一条**静默丢失**。头注释里早就把这个危险写清楚了，库却没有任何东西会拦住违反它的人。现在 `qz_t` 上多一个原子标记：抢不到的一方直接 **返回 -1** 并在 stderr 收到说明（写明「放行就是 double free」），把静默的内存破坏变成 §5.3 式的可诊断错误。
**为什么是 per-call 而非永久归属**：契约的措辞是「**同一时刻**只允许一个线程」。永久归属（第一个调用者永久拥有）会把「A 排干完、顺序交给 B」这种合法交接也判成违规，对某些宿主是破坏性的。所以标记是**进出各一次**：阻塞等待期间持有（这正是单一消费者该有的样子——另一个线程此时拿到 -1 而不是并发弹队列），返回时释放。测试同时锁这两半。
一次 CAS 不是锁，不违反无锁这条。`test_control_gtest` 新增 `mailbox_single_consumer_is_enforced`：线程 A 持锁阻塞，线程 B 必须在 2s 内观察到 -1，A 退出后 B 必须拿到正常结果（顺序移交仍可用）。负控（把 CAS 换成恒成功）如期变红。
**测试锁的是「阻止」而不是「复现损坏」**：负控在 ASAN 下并没有报 double free——因为测试会先排空邮箱好让 A 阻塞，两个消费者都拿到 NULL，没真正撞上同一个节点。故意撞坏堆的用例不该入库；这里锁的是那道门本身。

- **fix：设计哲学对照——三处「代码与项目自己的成文原则相抵」**（按宿主主权 / §5.3 不静默降级 / 无锁逐条对照代码，并用真实宿主场景压）①**`qz_free` 拒收路径上我做了一个不安全的「优化」**：那条分支原本只报错不动任何东西，我改成「先做能安全做的部分」——排干邮箱 + 关唤醒 fd，理由是怕白扔宿主一个 fd 槽位和整箱消息。**两部分都不安全**：`qz_mailbox_teardown` 的契约是「join 后调用」（`qz_destroy` 的调用点注释也写着「join 后无并发生产者，排干安全」），而这条分支存在的全部前提就是线程从未 join。它做的 `qz_out_pop` 会与生产者的 `__atomic_exchange_n(&tail)` + `store_n(&prev->q.next)` 并发：pop 到 NULL 后还会 `free(prev)`，生产者手里那个 `prev` 成为已释放内存，同时那条消息**静默丢失**——恰好是「不静默降级」最该避免的结果。关 `out_efd` 更糟：生产者的 `qz_out_link` 里 `write(rt->out_efd, …)`，关掉后要么吃 EBADF，要么在 fd 号被宿主复用时**把 8 字节写进宿主的不相关文件描述符**——那是库伸手损坏宿主拥有的东西，比泄漏坏得多，也直接违反「宿主形态不是 qzjs 能干涉的」。已改回「什么都不碰，只把话说清楚」，诊断文案与 `qzjs.h` 注释同步（不再声称已排干/已关 fd）。教训是通用的：**「先做能安全做的那部分」这句话本身需要证明**；我当时只是断言了「这时排干是安全的」，而恰好缺的就是这个证明。②CHANGELOG 里「`EBUSY` 时 loop 内存绝不能回收、泄漏是唯一安全选择」是一句**我写下但没被实现**的策略——10 个调用点全部在 `qz_close_loop` 之后立刻 `free(rt)`。按实际权衡定案：libuv 的 handle 是**独立分配**的，所以 free rt 并不会 free 掉那批 handle，它们各自变成泄漏。于是「不 free rt」在**可重试的 setup 失败路径**上每次泄漏一个 rt、无界；「free rt」只泄漏那批 handle 且 rt 本身回收。后者更可控，所以代码的选择保留，原则那句话改成如实描述这个权衡，并在 `qz_close_loop` 的注释里写明「要真正一个都不漏得 uv_walk + uv_close 逐个收尾再重试，那在 setup 半初始化路径上会碰到未就绪的 handle，风险高于它解决的问题，故不做」。③**出站 OOM 标记帧在宿主侧文档里一次都没出现**——`mailbox-alloc-failed` 只存在于 `src/msg/msgq.c`、CHANGELOG 和 brain。§5.3 要求「可诊断」，而一个宿主完全不知道其形状的帧只做到「可见」而没做到「可行动」：严格的宿主循环要么崩、要么把它当自己的协议。已在 `docs/{,zh/}c-api/runtime.md` 的邮箱节补上**错误帧契约**（不是一个具体帧，而是一条宿主必须实现的判别式），并说明两种现有成员、`mailbox-alloc-failed` 的真实含义（出站邮箱无界、不排干就涨到分配失败，所以它出现几乎总是「宿主排干太慢」）、以及消费循环**不要 break**（后面可能还有正常消息）。新增的两段示例立刻被文档门判为编不过（引用了虚构的 `handle_my_protocol`、用了未声明的 `json`），改写成自洽的完整消费循环后 101/101，棘轮顺势抬到 101。

- **fix：fuzz 语料与仓库真实字节码的对齐（原语料早已漂移，本轮重新生成 + 固化为门）**——`test/fuzz-corpus/seed-polyfill-head{4k,8k,64k}.bc` 与 `seed-workerboot.bc` 的定义是「**仓库自己那份**字节码的头 N 字节」：真实字节码在 tracked 的 `src/polyfill_default.c` / `src/worker_boot_default.c` 的 .rodata 里。字节码会随 quickjs patch 与 polyfill 改动而变，而语料不会自动跟着变。核对结果是**已经漂移过**：HEAD 上那四个的头 4 字节是 `1b99c2fa` / `1bbc192a`，而仓库真实的是 `1cb7bf5b` / `1c7ae3a5`；`polyfill/` 与 `deps/quickjs-ng` 指针都没动，所以漂移不是这轮引入的。漂移的后果很隐蔽：这些 seed 仍然能喂给 `JS_ReadObject`、CI 的重放门也**不会报错**（解析失败不算崩），但 fuzz 那 60 秒预算会在一个已经不存在的字节码形态附近做变异——而 CI 注释自己写着 seeded run 的意义正是「spends its time mutating around known-interesting shapes rather than rediscovering the container format from scratch」。四个文件已按「真实字节码的同长前缀」重新生成。新增 `test/fuzz_corpus_align_check.py`：判据是**整个文件等于真实字节码的同长前缀**（比 4 字节强得多、不含魔数），已接进 `make gates`（成为第五个门）与 CI 的 e2e job；负控用 HEAD 那版跑，四个全部报 DRIFT 并给出第一处不同的偏移。
同时 `test/fuzz-corpus/seed-crash-73a0.bin` **入库**：它是历史 crash repro，`bc-reader-hardening` 页早写着「可回归 gate」，而 CI 注释也写明约定是「promote interesting ones into test/fuzz-corpus/ as seeds」——它此前只存在于工作区。语料数 19 → 20，brain 该页 compiled_truth 已同步。

- **fix：第五轮跨文件一致性审查（专找「文字与最终代码状态相互矛盾」）——22 条全部处理完**，其中两条是真缺陷而不是文字问题。①**非 path 远端前投失败会发两帧**：那条分支（`target` 指向不存在的槽位、且不带 `target_path`）在本地写了 NOT_FOUND 帧并 `ctl_unregister` 之后 `return rc`，而 `ctl_forward` 对「无此槽位」返回 -1 —— 端点的兜底分支（`else if (r != 0)`）于是**再发一帧 INTERNAL**，客户端对同一条命令收到两帧。契约表里 `-5`（前投失败、NOT_FOUND 已写出、端点别再发）只有 `target_path` 那条分支兑现了。已让两条远端路径都归到 -5，并给探针补上非 path 覆盖。②**探针的「读完一帧后还有没有多余字节」检查是死代码**：`close(fd)` 排在检查之前，于是 poll 作用在已关闭的 fd 上（只回 `POLLNVAL`、`revents & POLLIN` 恒假、`fd >= 0` 恒真）；更隐蔽的是 `read_frame` 一次 `read()` 会把**两帧一起**取进缓冲区、在第一个 `\n` 处返回，尾部那帧已被消费掉——所以同一个 tick 里写出的双帧它永远看不见。两个缺陷叠在一起，使「帧尾多带 `\n` 会多出空帧」这条我上一轮声称锁住的断言**从来没真正生效过**。已把 `close` 移到检查之后、把 `read_frame` 改成逐字节读，并在 FAIL 消息里带上多余字节的实际内容；两个负控（把非 path 分支改回 `return rc`、把帧尾 `\n` 加回去）现在都能精确命中。③公共头 `qzjs.h` 与 `docs/{,zh/}c-api/runtime.md` 讲 `qz_control` 两条硬拒时**都没提 interrupt 豁免**，而代码里 `interrupt` 缺 correl 是**照收并返回 0** 的；zh 文档那句「不需要等回执就传一个 correl 忽略回执」恰好把唯一不需要 correl 的那条命令排除在外。三处都补上例外说明。④ping 退避封顶：`if (*step_us <= 500)` 的实际收敛值是 **800µs**（400 翻倍到 800 后越线），注释写「收敛到 1000」是错的；已改为 800（仍在「回执延迟 ≤1ms」那个上界内）。⑤`qz_free` 诊断里的 `\\n` 是 C 记法的**字面量**反斜杠+n，stderr 上那行不断行、下一条输出会粘上来。⑥mp7 harness 与 e2e 脚本的**文件头**仍写「≤6000ms / ≤6s」，而代码已收到 3000（改数字的人只搜了函数体附近）。⑦e2e 脚本的 `grep -q "ok ①"` 与 `grep -q "ok ⑧c"` 都被**子串**满足——harness 里同时有 `ok ①`/`ok ①b` 与 `ok ⑧c`/`ok ⑧c'`，于是删掉 ① 或 ⑧c 那条 printf 门照样绿；已改成 grep 到冒号，并把 `⑧c`（ping 均返回 0）与 `⑧c'`（ping 后箱净）分开锁、fail 文案对齐各自标记。⑧ci.yml 的「当前 87/87 全过」与 CHANGELOG/brain 里的「87 块」「四种姿势」都已过期（现 99 块、三种姿势，姿势 C 实测独占 0 块已删）；ci.yml 与 CHANGELOG 里「16 个示例」实际是 14 个目标，且 `examples/extension/extension.c` 与 `worker-orchestrate/task-worker.js` 不在 CMake 列表内，故「全量编译」名不副实，已按事实表述。⑨brain 两页 timeline 里那三处（「87/87」「四种姿势」「env 保留为进程级入口」「16 个示例」）按契约不能手改 timeline，已各追加一条订正 note（形态已改为 per-rt `out_fault` + `qz_test_mailbox_fault`）。⑩零散：`out_fault` 字段注释补上「写者有两个且都走原子访问」；契约表 -3 那条不再用「同上」（字面会把 -2 的「correl:null」也继承过来，而 -3 实际回显 correl）；`msgq.c` 里「176B 的节点」改为实测的 ~183B；删掉 e2e 脚本里两行描述改动前代码的残留注释；ci.yml 那个 API 面步骤名叫「三档」实际只跑两档，已如实改名（第三档 mock 在 asan job）。另核实**无问题**的：10 个新增文件全部被 CMake/CI 引用、无死文件；Makefile 五个新目标的目录名与脚本路径逐一对得上；「`rt_host.c` 只在 ISOLATED && !mock 下编入」在 CMakeLists.txt 里成立；两个新探针 CI 与 Makefile 双双接线。

- **fix：上一轮的 `interrupt` 豁免自己引入了一个回归——它把「correl 必填」这道守卫当初要消灭的孤儿回执原样放了回来**。豁免 correl 之后，sink 入口（公共 `qz_control`）会让 `interrupt` 一路走到 `qz_ctl_register(rt, NULL, …)`——那里 `r->correl = strdup("")`，登记一个**空键条目**——然后入队；dispatch 的 interrupt 分支里 `ctl_claim(rt, NULL)` 第一行就是 `if (!correl) return 1`（压根不查表），于是照样产出一条 `{"ctl":true,"correl":"","ok":true,"interrupted":true}` 投进宿主邮箱，而那个空键条目谁也 claim 不掉，只能等超时回收。实测把负控打开确实能看到这一帧。正确形态是**置位之后立刻收手**：interrupt 无 correl 时不登记、不入队、不产回执——效果（原子标志）已经达成，而没有 correl 本来就没有可配对的回执。（收口的 `ctl_local_command` 一直是对的，只有 sink 入口漏了。）配套加了两条判据，过程本身是这轮最值得记的：①`test/probe_ctl_reject_frames.c` 第 4 项加严成两半（不被拒 **且** 自己不产任何帧）——但**负控实测：撤掉修复，探针依然全绿**，因为它走端点路径、经的是那处本来就对的 `ctl_local_command`，够不到 sink。②于是补了 gtest `interrupt_without_correl_emits_no_orphan_receipt`，走公共 `qz_control`；**它第一版也抓不到**——断言写在 `host_wait_ctl` 的结果里，而那个 eval 配对 shim 只放行匹配所等 correl 的帧，`correl=""` 的孤儿在到达断言前就被它丢了。改成直接用 `qz_recv_message` 原始排干，负控才如期变红。教训是成对的：**判据必须落在被测改动真正所在的那条路径上，且中间不能有会丢弃被观测对象的过滤层**。两层都踩了，且两次都是「负控绿了」才暴露的。③`-3` 拒收帧现在回显 correl（此前不带，而协议按 correl 配对，回一个**不带** correl 的回执对客户端毫无用处；这条命令的 correl 是拿得到的——先校验它非空、再判保留命名空间）。`qz_control_endpoint_cmd` 加了 `char **correl_out` 出参（内部函数，仅一个调用点）。探针的断言也从「correl 字段非空」改成**比对具体值**——第一版只验非空，于是把回显换成任意字符串的负控照样绿；现在两个负控（回显错的 correl、省略 `"correl":null`）都给出精确诊断。④`M2`（拒收帧同步写、回执异步写，流水客户端按位置配对会错位）**未修**，已在 `qz_internal.h` 的契约注释里写明残留范围与彻底修法（把拒收也走异步回执路径）——按 correl 配对能解决 `-3` 那种，`-2` 只能靠顺序。⑤`L1`（每条命令 cJSON 解析两次：classify 一次 + ctl_extract 一次）**未修**，理由是：合并要改动 `ipc_ctl.c` 里那个安全敏感的判据函数，收益（控制命令不是热路径）与风险不成比例。记下来而不是顺手改。

- **fix：把此前标记为「已知但未修」的缺口全部收掉**（mp7 harness 四处假红 + CTL 返回码分类 + 判据分叉 + 验证矩阵入 Makefile + 文档门收窄）。①`test/test_mp7_mailbox_e2e.sh` 的残留检查口径是 `pgrep -x qzjs-rt | wc -l`，数的是**整台机器**：共享 runner 上别的 job 起一个 `qzjs-rt` 就 `AFTER > BEFORE` 假红，而 `pgrep` 缺失时两边都是 0、这条检查静默变成永真。正确口径「我自己的孩子」只有 harness 知道（它内部本来就用 `pgrep -P <own pid>`），已把检查移入 `mailbox_e2e.c` 的 `main`（退出前自查子树，断言都过了也不放过真泄漏），脚本改为对 `pgrep` 做存在性硬要求。②SIGSTOP 取证原是「睡 300ms + system(pgrep)」「睡 500ms + 查一次」，余量全在 fork/IO 上，ASAN runner 上容易归零、以环境之名红。改为有上界的等待（等子进程出现、等 `state=='T'`），**取证成立之后才开始计时** destroy；缺 `/proc` 时返回 77 = SKIP 而不是硬红。修这条时踩到一个坑：等待循环写成 `system("pgrep -P $$ ...")`，而 `$$` 在 `system()` 起的 `/bin/sh` 里是**子 shell 自己**的 pid，永远匹配不到本进程的子节点，于是每次烧满整个上界、把 kill 拖到取证预算边缘，hung 模式直接判红——这类「在 shell 里写 pid」的错，症状离真因很远。③destroy 预算从 6000ms 收到 3000ms：库内三级终止的 graceful 档是 `QZ_IPC_TERMINATE_TIMEOUT_MS = 2000`，6000 是它的 3 倍，意味着阶梯退化到 ~5.5s 依然绿——那条断言证明的是「不会挂死」而不是「阶梯完整」。④补上脚本漏掉的两个 grep（`①b` / `⑧c`），此前它们只靠 harness 退出码兜住。⑤CTL 侧：`qz_control_sink` 与 `qz_control_endpoint_cmd` 的拒收判据抽成共用的 `ctl_check_accept`——早先两个入口**顺序相反**（sink 是「保留命名空间 → correl」，端点是「correl → 保留命名空间」），同一份字节（既没 correl 又用了保留键）在两个入口得到两种诊断，而两处注释都写着「两处必须同步」。内部 sink 改用专用码 -2/-3 并由公共 `qz_control` 归一化回 -1（**公共契约不许外泄内部码**，否则按 `== -1` 判断的宿主会突然看到 -2/-3）；新增 gtest 两例把这条锁住。⑥`-1` 的分类补全：`ctl_local_command` 原来把「入队失败」与「参数非法」压成同一个 -1，端点再一映射就彻底分辨不出，只能静默——而同一函数里转发失败是会回 NOT_FOUND 的。现细分出 -4（入队失败，**不会有回执**，端点必须当场回帧）与 -5（前投失败，NOT_FOUND 已写出、端点别再写），端点对除 0 与 -5 外的**每一个**非零都回帧；判据是「客户端能不能只靠连接上的帧判断这条命令的结局」。⑦`Makefile` 新增 `asan` / `asan-rt` / `ubsan` / `gates` / `verify` 五个目标。这些构建配置此前**只存在于 CI yaml 里**，本地验证全靠手敲 cmake、配置对不对全凭记忆——代价是已经付过的：我按「我本地跑过 ASAN」的说法放过一次堆 use-after-free，因为手上的 `build-asan` 是 `tests=OFF`（压根不编译 gtest），而唯一带 `tests=ON` 的那个是 UBSAN。三套刻意分开：`asan` 覆盖 gtest 路径、`asan-rt` 覆盖**真实 ISOLATED 并发路径**（`rt_host.c` 只在 ISOLATED && !mock 下编入，tests=ON 那一套里整文件是不编的）、`ubsan` 覆盖未定义行为。⑧文档门 `docs_c_snippet_check.py` 收窄到实际覆盖：它的 docstring 宣称能抓「少个 include」，而预置头无条件 include 了一切，零 include 的合法片段照样编得过（实测确认）。同时删掉 40 行 bespoke 启发式「姿势 C」——实测 99 块里**独占 0 块**（姿势 A 独占 2、D 独占 6），而它的说明自称是「混合片段的唯一解」，那实际是 D 在干的事；未闭合的 ```c 围栏原来会把整块**静默丢掉**，现在显式报错。⑨`src/control/control.c` 删掉一处失效的 `#ifndef QZ_USE_MOCK_LIBUV` 条件 include（`ipc_process.h` 早已在顶部无条件 include），并把字面量 `1` 换成具名的 `QZ_IPC_MAIN_ID`——那条注释声称「mock 构建不编入 ipc_process.h，用字面量」，前提早已不成立。⑩新加的两条 gtest 里我手写了长度字面量（16 字符的 `{"op":"metrics"}` 写成 20），被 `make asan` 当场抓住 `global-buffer-overflow in __interceptor_memcpy`——与本轮修的 `qz_post_message` 长度 26（应 29）是同一类，注释里已写明「不要手写字面量」。

- **fix：第四轮审查（对象是第三轮修完、还没人看过的代码）——子审查在 CTL 拒收路径上找出 3 个严重 + 6 个中等问题，全部已修**。①`-3` 拒收帧是**非法 JSON**：C 源码里写 `\"qzjs\"` 只让字符串里出现一个裸引号，拼进 JSON 在第 53 列截断 `error` 串，整帧不可机读——而客户端拿到的是解析异常而不是诊断，恰好违背这批改动「失败必须可诊断」的目标。`qzjs-ctl` 一直没能发现它：`ctl_cli.c` 用 `strstr(resp, "\"ok\":true")` 判断成败，**从不解析 JSON**。用 strstr 写的断言天生抓不到「JSON 非法」这一类。②两条帧字面量都自带尾 `\n`，而 `qz_ctl_conn_write` 无条件再补一个，于是每条拒收后面多出一个**空帧**；按行分帧的客户端会把它读成零长帧然后 `json.loads("")` 抛异常（同文件 `control.c` 的 NOT_FOUND 帧用 snprintf、不带尾换行，本就该对齐它）。③`control.c` 的 path 前投早返回直接 `return rc`，既没 `ctl_unregister`（回执条目赖到超时 reap）也没任何回执，客户端干等到 5s 后的 TIMEOUT——**正是这批改动声称要消灭的静默失败，只是换了个入口**；我写在 `control_endpoint.c` 的注释（「那条路函数内部已自行回过 NOT_FOUND」）本身就是错的，我自己的探针输出就是反证。现补 `ctl_unregister` + NOT_FOUND 帧，与非 path 远端分支一致。④`interrupt` 不带 correl 现在会被拒——correl 守卫排在原子标志置位**之前**，于是「不传 correl 的 interrupt 连标志都置不上」，那是对**公共 API** 的静默破坏，而 interrupt 恰恰是唯一不依赖回执配对的命令（入队只为回执）。已在 sink、收口、**端点**三处豁免；端点那条原先 `ctl_extract` 传的是 `op_out=NULL`，压根不知道 op 是什么，所以要连 `op` 一起取（并补齐三条 return 上漏掉的 `free(op)`）。⑤`-2`/`-3` 这条新契约原先只存在于一行 `if` 里，`qz_internal.h` 的声明注释只字未提，测试覆盖为零（全仓 grep 不到任何断言，`test_ctl_e2e.sh` 的 ctl helper 总是自动生成 correl，两条路都不可达）——所以①那种非法 JSON 不可能被任何现有门抓到。新增 `test/probe_ctl_reject_frames.c`：**逐帧用 cJSON 真解析**，并锁住「帧尾多带 `\n` 会多出空帧」「前投无此槽位要当场 NOT_FOUND 且带 correl」「interrupt 不带 correl 不得被拒」三条，已接进 `asan` job。该探针当场又抓出一处：端点的 -2 守卫在到达收口前就拒了 interrupt，说明④的修复漏了第三个入口。⑥`-1` 的分类仍不完整且与兄弟分支矛盾（`control.c:474` 把 malloc 失败 / push 失败压成一个码，端点全都不回）——**已知缺口**，已在 `qz_internal.h` 的返回码契约里逐条写明，没在这一轮修。另：`api_surface_check.py` 的反向检查把数据符号也算进去导致成功行永远打不出来（见上条）。

- **fix：per-rt 注入改造后自查出的两处问题**——①`test/test_mailbox_oom_gtest.cpp` 的 `FaultGuard` 声明在 `host_destroy` 之前，析构却在 `qz_destroy` 的 `free(rt)` **之后**跑，析构里那次 `qz_test_mailbox_fault(rt, 0)` 是**写已释放内存**（ASAN 报 `heap-use-after-free @ qz_test_mailbox_fault ← ~FaultGuard`，已用 ASAN+tests 构建复现并验证修掉）。改成把 guard 放进内层 `{}`，存活期严格嵌套在 runtime 之内。②`test/api_surface_check.py` 的「有实现无声明」检查把**数据符号**也算进去（`extern const qz_ext_t qz_compress_ext;` 这类声明没有括号，`declared_functions()` 按定义看不见，必然误报），于是该集合恒非空——而成功行「OK 声明面与链接面一致」以它为空为前提，**那行永远打不出来**，门只剩一串 WARN 加 rc=0，等于没有通过信号。现按符号类型分开（`defined_symbols` 返回全部/代码两类），反方向降级为标注清楚的参考信息、不参与判定（逼人把非 static 的模块内部函数公开是错的），成功行只由硬门 `missing` 决定。噪声 9 条降到 1 条（`qz_tcp_io_init`，确系模块内部函数），硬门负控（往头里塞一个不存在的声明）实测仍 rc=1。

- **fix：第三轮并行审查查出并修掉的 22 条问题（多为本批自身引入的缺陷）**——①`test/api_surface_check.py` 的判定靠正则匹配编译器诊断里的引号，只认 gcc + UTF-8 locale 打的 U+2018/U+2019；clang 与 C locale 打的 ASCII 引号匹配不到，于是 `declared_here` 恒空、守卫函数被算成「可见」、THREAD 档**恒红**——它在 CI 里一直绿只是因为 ubuntu-latest 默认 C.UTF-8 恰好让 gcc 打了弯引号。改用 `-Werror=implicit-function-declaration` + 词根匹配（`undeclared` / `implicit declaration`）+ 两种引号都认 + 子进程钉死 `LC_ALL`，并加「探针自身失败则直接失败」检查（探针若因与未声明无关的原因失败，空集会让门看起来没问题）。gcc/clang × C/C.UTF-8 四种组合实测全绿。②ping 家族守卫写的是 `#if defined(QZ_PROCESS_MODEL_ISOLATED) && !defined(QZ_USE_MOCK_LIBUV)`，而 `QZ_PROCESS_MODEL_ISOLATED` 是 PUBLIC、`QZ_USE_MOCK_LIBUV` 是 PRIVATE——消费者看不到 mock 宏，**守卫的 mock 那半边是死的**，mock 测试构建里「头里声明 `qz_ping`、库里没有」原样复现（上一批只修了真实 THREAD 构建那一半）。`QZ_USE_MOCK_LIBUV` 改 PUBLIC，并给门加第三档 `mock` 配置（挂进 `asan` job，那儿本就有 tests=ON 的库）。③本批新增的 OOM 故障注入器（`src/msg/msgq.c`）有真缺陷：`g_out_fault_budget` 同时兼任「未读 env」哨兵（-1）与计数器，而 `fetch_sub` 会把 0 自然减成 -1，两者撞车 → 额度用尽后被读成未初始化 → 每 N+1 次 push 静默丢一条且永不自愈（复现：N=3 得 `888888468888884…`）；同一对象混用原子与非原子访问是 UB；无 env 时每两次 push 调一次 `getenv`。最终**整个进程级全局与 env 入口都删掉了**：注入额度改为 `qz_t` 上的 `out_fault` 字段，由 `qz_test_mailbox_fault(rt, n)` 写。中间试过「init 用 CAS 抢一次性读 env + budget 饱和递减」两变量方案，但那只是把撞车往后推——真正的问题是作用域：进程级全局等于在生产库里留一个**静默丢消息**的总开关（谁在 shell profile 或 CI 全局 env 里手滑留一行，运行时就开始丢、日志里一个症状都没有），且同进程多个 rt 共享额度，压根不匹配「注入 N 次出站分配失败」这件事本身——当初为了「一个进程只能注入一次」才被迫加的 `init` latch，正是这个形态选错的证据。per-rt 一个 int 字段，以上全部消失。`test_mailbox_oom_gtest` 补「注入恰好 N 次」用例（修前 8 条标记 / 修后 3 条，已验非空转），并改直接用 `qz_recv_message` 收干：原来走 `host_wait_msg`，而那个 shim 超时清理时会丢掉所有以 `{"type":"error` 开头的帧——正是标记帧的字面量，于是回执晚于预算就会报「OOM 未在流上留标记」并附空串（帧在流里、诊断说它不在）。④`test/probe_ctl_endpoint_leak.c` 三处：不断言自己走到了目标路径（什么都没跑到也绿）、裸 `read()` 无上界（`asan` job 没有外层 timeout，整 job 能挂到上限）、固定 socket 名而库对显式路径不 unlink（同机之后每次跑都红）。重写为「同一条命令本地 `ok:true`、带 `target_path` 则 TIMEOUT」——只断言回执里有 correl 是不够的（本地路径也登记回执、也出 TIMEOUT，撤掉 `target_path` 照样绿）。⑤端点拒收回执把 `ctl_forward` 的 -1（无此槽位）误判成拒收，发出误导性的「保留命名空间」错误帧（由探针抓到）——改用专用返回码 -2（缺 correl）/-3（保留命名空间）。⑥`correl` 必填的判据只在两个生产者入口，wire 路径（`ctl_local_command`）没拦，子进程发来的帧照样能造 `correl=""` 孤儿回执——判据下沉到收口。⑦`qz_close_loop` 的诊断文案承诺「loop 内存有意不回收」，而每个调用点下一行就 `free(rt)`——改成如实描述、函数返回 `int`，各调用点标注该取舍。⑧ping 退避封顶注释写 1ms、实际 1.6ms（翻倍发生在判封顶之前，序列 100→200→400→800→1600）。⑨`qz_free` 守卫在「主RT 自行 idle 自退、宿主随后 free」这条真实路径上会拒绝（该路上 `thread_joined` 恒为 0），且连 eventfd 都不关——改为先做安全部分（排干邮箱 + 关 fd），只对 rt 本身 declines。⑩brain 三处术语错（`dap-feature-completion.md` 残留英文 pump；`a2-worker-robustness.md` 「读泵停/死锁」被换成读不出得通的「读回调停/死锁」，应为「读侧」；`multi-process-model.md` 第 5 处语义反转）；`compiled_truth:17` 的等待机制描述过时（改经 `update-truth` 重写：等待在调用线程、ping=短睡退避、wait_idle=join）。⑪docs 既有事实错误：首页 `qz_recv_message` 三态（EN+zh）、`faq.md` 把 `qzjs.fs` / `localStorage` / `navigator.serviceWorker` / `CompressionStream` 当全局（且中英两版各写一个都不存在的名字）、模块数 21 与全站 30 矛盾、`c-js-layering.md` 引用不存在的 `ext_web_wasm.c` 与「3 用例」（实为 9）。⑫新增 `test/docs_link_check.py`：站内链接指向已改名/已删章节时 VitePress **不报错**，只是那个锚点永远滚不到；修 5 条断链（`&` 产生双连字符那类），并立刻抓到我自己引入的 1 条（`qz_control` 段的 control-plane 链接指向不存在的页面）。
