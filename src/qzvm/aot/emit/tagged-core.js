/* tagged-core.js — tagged 模式公共方法（属性名折叠、arena 释放、字符串 id 等）。
 * 以副作用挂到 Emitter.prototype：tagged.js 与 compile-ts.js 都 require 它。
 * emitter.js 拆分件；模块图见 ../emitter.js 顶部注释。 */
"use strict";
const ts = require("typescript");
const { SCRATCH, STR_BASE } = require("./layout.js");
const { Emitter } = require("./emitter.js");

// ================= tagged 模式公共件 =================
// 值恒 i64：数值 = 原始 f64 位型（NaN-box 的数值侧），句柄 = 高16位0x7FF9|低32 offset；
// 字段 8 字节。与宿主字长无关，32/64 位设备共用。
// f64Bits 在 layout.js（Emitter 核心也要用，放叶子层避免依赖环）。
// 计算属性名（类字段）编译期折叠：字面量 / 字面量拼接 / 模块级字面量 const / 括号 / as 断言。
// 无法求值 → null（调用点 loud，避免静默错名）。
Emitter.prototype._foldPropName = function (n) {
    const self = this;
    const fold = (x) => {
        if (x === undefined || x === null) return null;
        if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text;
        if (ts.isNumericLiteral(x)) return String(Number(x.text.replace(/_/g, "")));
        if (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isTypeAssertionExpression(x) || ts.isSatisfiesExpression(x)) return fold(x.expression);
        if (ts.isIdentifier(x)) { const v = self.modConstLit && self.modConstLit.get(x.text); return v === undefined ? null : String(v); }
        if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            const l = fold(x.left), r = fold(x.right);
            return (l === null || r === null) ? null : l + r;
        }
        return null;
    };
    return fold(n);
};
Emitter.prototype._fieldIndex = function (name) {
    if (!this.fieldMap) this.fieldMap = new Map();
    let i = this.fieldMap.get(name);
    if (i === undefined) { i = this.fieldMap.size; this.fieldMap.set(name, i); }
    return (i + 1) * 8;   // 字节偏移；偏移 0 保留给实例 __cls 头（类实例），字段从 8 起
};
// 程序内是否存在名为 name 的属性访问器（getter/setter）——决定属性读/写是否走宿主访问器分派。
// 名字是否为程序内某类的方法名（属性读命中时走宿主：实例原型方法 → 绑定函数；字段仍优先）
Emitter.prototype._hasMethodName = function (name) {
    if (!this._methodNames) {
        this._methodNames = new Set();
        for (const cname of this._classList) {
            const c = this.classes.get(cname);
            if (!c || !c.methods) continue;
            for (const m of c.methods) this._methodNames.add(m.name);
        }
    }
    return this._methodNames.has(name);
};
Emitter.prototype._hasAccessor = function (name, kind) {
    if (!this._accessorNames) {          // 惰性：首次使用时由已收集类汇总（编译期一次）
        this._accessorNames = { get: new Set(), set: new Set() };
        for (const cname of this._classList) {
            const c = this.classes.get(cname);
            if (!c || !c.methods) continue;
            for (const mth of c.methods) {
                if (mth.accessor === "get") this._accessorNames.get.add(mth.name);
                else if (mth.accessor === "set") this._accessorNames.set.add(mth.name);
            }
        }
    }
    return this._accessorNames[kind].has(name);
};
Emitter.prototype._strId = function (text) {
    let i = this.strings.indexOf(text);
    if (i < 0) { i = this.strings.length; this.strings.push(text); }
    return i;
};
/* 静态字段的「类键」：两档键空间不同，必须与各自的读取端一致。
 * - in-module（C 侧）：clsId（与 static_get_dyn / class_env_get / classMeta 表索引同一空间）。
 *   此前传类名 strId，只有 strId(cname)==clsId 时碰巧成立；一般情况 this.x 静默读 0。
 * - 独立档（JS 宿主）：类名 strId（宿主 statics 表以类名为键，static_get_dyn 沿 ctor 名查找）。*/
Emitter.prototype._staticClassKey = function (cname) {
    const c = this.classes.get(cname);
    if (this._inModuleLink && c) return c.id;
    return this._strId(cname);
};
// 可重入表达式临时槽：v/w（i64 受保护值）+ a/b/c（i32）+ x/y（i64 附加），按嵌套深度分层，
// 避免内层表达式（含 .length / 下标 / 拼接）覆盖外层正在使用的接收者/值。
Emitter.prototype._expEnter = function () {
    const d = this._expDepth || 0; this._expDepth = d + 1;
    if (!this.sT) return { v: 0, w: 0, x: 0, y: 0, z: 0, a: 0, b: 0, c: 0, d: 0 };
    return { v: this.objBase + 8 + d, w: this.objBase + 16 + d, x: this.objBase + 24 + d, y: this.objBase + 32 + d, z: this.objBase + 40 + d,   // 各 8 层（objPool 48 槽）
             a: this.sT[8 + 4 * d], b: this.sT[9 + 4 * d], c: this.sT[10 + 4 * d], d: this.sT[11 + 4 * d] };   // 各 8 层（sT 共 40 槽）
};
Emitter.prototype._expLeave = function () { this._expDepth--; };
// 类静态字段：C.x 前确保静态已初始化（lazy 内联初始值 → 宿主表 qz.static_set / statics_mark）。
Emitter.prototype._emitStaticsGuard = function (cname) {
    const c = this.classes.get(cname);
    const needsDynLink = !!(c && this._dynParentExpr(c));   // 动态父（mixin）即便无静态成员也须发链接
    if (!c || (!needsDynLink && !(c.staticFields || []).length && !(c.staticBlocks || []).length)) return;
    if (this._inStaticsGuard) return;                     // 守卫体内再访问同类静态 → 不再嵌套（避免无限展开）
    this._inStaticsGuard = true;
    try { this._emitStaticsGuardBody(c); } finally { this._inStaticsGuard = false; }
};
/* 整条父链的静态守卫（基类在前）。静态方法/访问器内 `this.x` 的接收者可能是派生类，
 * 读到的字段可能来自任一层父类 → 只初始化接收者本身会漏掉父类静态（静默 0/undefined）。 */
Emitter.prototype._emitStaticsChainGuard = function (cname) {
    const chain = [];
    for (let x = cname; x && this.classes.has(x); x = this.classes.get(x).parent) chain.push(x);
    for (let i = chain.length - 1; i >= 0; i--) this._emitStaticsGuard(chain[i]);
};
Emitter.prototype._emitStaticsGuardBody = function (c) {
    const cname = c.name;
    const M = this.m;
    const savedCCO = this._curClassObj, savedSM2 = this._inStaticMethod, savedSI2 = this._inStaticInit;
    this._curClassObj = c; this._inStaticMethod = true; this._inStaticInit = true;   // static{} 内 this ≡ 定义类（非运行时代）   // static{} 内 this ≡ 定义类（_classOfExpr/_isClassName）
    { const dynN = this._dynParentExpr(c);              // 动态父（声明式类）：先链接运行时父链（宿主缓存，幂等）
      if (dynN) { this._emitClassValue(c); M.drop(); } }
    M.i32Const(this._staticClassKey(cname)); M.call("qz.statics_ready");
    M.i32Eqz();
    M.ifBlock("void");
    /* 类方法捕获 env 在**首次类初始化**时建立（声明式类的 `new A()` 经 new_dynamic
     * 不触发 class_value，这里补上）。此后 statics_ready 标记 → 不再重复。 */
    { const ci0 = c.captured && c.captured.length ? c : null;
      if (ci0) this._emitClassCaptureEnv(c); }
    // 静态初始化按**源码序**（字段与 static 块交错；JS 语义：类定义时按序求值一次）
    for (const it of (c.staticInits || c.staticFields.map(f2 => ({ kind: "field", ...f2 })))) {
        if (it.kind === "field") {
            M.i32Const(this._staticClassKey(cname)); M.i32Const(this._strId(it.name));
            if (it.init) this.emitTaggedExpr(it.init); else this._emitUndefined();
            M.call("qz.static_set");
        } else {
            const savedSM = this._inStaticMethod; this._inStaticMethod = true;   // static {} 内 this ≡ 定义类（JS 语义）
            for (const st of it.blk.body.statements) this.emitTaggedStmt(st);
            this._inStaticMethod = savedSM;
        }
    }
    M.i32Const(this._staticClassKey(cname)); M.call("qz.statics_mark");
    M.end();
    this._curClassObj = savedCCO; this._inStaticMethod = savedSM2; this._inStaticInit = savedSI2;
};
// 类名（标识符）是否为已收集的类
// 沿继承链找静态访问器（kind: "get"|"set"）→ { cname, acc }（静态属性读/写分派）
Emitter.prototype._findStaticAccessor = function (cn, name, kind) {
    let c = this.classes.get(cn);
    while (c) {
        const acc = (c.staticMethods || []).find(sm => sm.accessor === kind && sm.name === name);
        if (acc) return { cname: c.name, acc };
        c = c.parent ? this.classes.get(c.parent) : null;
    }
    return null;
};
// 类名判定：跳过括号 / as / 非空断言 / satisfies（(C as any).st ≡ C.st）；类名**作值**仍 loud
// 类名（含继承别名）解析：跳过括号/as/非空断言/satisfies；非类名 → null
Emitter.prototype._classOfExpr = function (node) {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
        || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
    if (node && ts.isThis(node) && this._inStaticMethod && this._curClassObj) return this._curClassObj.name;   // 静态方法内 this ≡ 类
    if (!node || !ts.isIdentifier(node)) return null;
    const cn = this._className(node.text);            // 类表达式别名（const C = class {…}）：typeof/静态访问要按别名解析
    return this.classes.has(cn) ? cn : null;
};
Emitter.prototype._isClassName = function (node) {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
        || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
    if (node && ts.isThis(node) && this._inStaticMethod && this._curClassObj) return true;   // 静态方法内 this ≡ 类
    return !!node && ts.isIdentifier(node) && this.classes.has(this._className(node.text));   // 与 _classOfExpr 一致：类表达式绑定名/导入别名 → 真实类名
};
// 字符串句柄 tag 测试：栈顶 i64 → i32（是字符串?）
Emitter.prototype._emitIsStr = function () {
    this.m.i64Const(48n); this.m.i64ShrU(); this.m.i64Const(0x7ffan); this.m.i64Eq();
};
// 字面量 → data 段 [len:i32][utf8]，返回偏移（句柄低32位）
Emitter.prototype._litOffset = function (text) {
    let off = this._litOff.get(text);
    if (off !== undefined) return off;
    off = (this._litCursor === undefined) ? (this._strBase || STR_BASE) : this._litCursor;
    const bytes = Buffer.from(text, "utf8");
    const head = Buffer.alloc(4); head.writeInt32LE(bytes.length, 0);
    this.m.addData(off, Buffer.concat([head, bytes]));
    this._litCursor = off + 4 + bytes.length;
    this._litOff.set(text, off);
    return off;
};
// 字面量句柄：0x7FFA<<48 | offset
Emitter.prototype._emitStrLitHandle = function (text) {
    this.m.i64ConstBits(this._litOffset(text), 0x7ffa0000);
};
// 字符串拼接：栈顶 [a, b]（i64）→ 结果句柄。
// a 字符串 → qzs_append(a, bytesOf(b))（b 数→numstr 到 SCRATCH；b 串→其字节）——热路径原地追加。
// a 数 + b 串 → qz.string_concat 回退（少见）；双数 → 原生 f64 add。
// 字符串累加器判定：x 的每次出现都只可能是 自身赋值目标 / 自身拼接左侧 / 只读属性访问（x.length、x.m()…）／
// 被追加的源（"a" + x）；此时其缓冲不会被别名引用 ⇒ 允许原地追加（累加循环 O(n)）。否则强制拷贝。
// 被闭包捕获的名字一律不算（可能别名）。
Emitter.prototype._strAccSetOf = function (body) {
    if (!body) return new Set();
    this._strAccCache = this._strAccCache || new WeakMap();
    if (this._strAccCache.has(body)) return this._strAccCache.get(body);
    const cand = new Set(), unsafe = new Set();
    const assignTarget = (n) => {                       // 该标识符所在（最近的）赋值语句的目标名
        let p = n;
        while (p) {
            if (ts.isBinaryExpression(p)) {
                const op = p.operatorToken.kind;
                if (op === ts.SyntaxKind.EqualsToken
                    || (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment)) {
                    return p.left && ts.isIdentifier(p.left) ? p.left.text : null;
                }
            }
            if (ts.isVariableDeclaration(p)) return ts.isIdentifier(p.name) ? p.name.text : null;
            if (ts.isStatement(p) || ts.isFunctionLike(p)) return null;
            p = p.parent;
        }
        return null;
    };
    // 某变量在「某个 return 之后」是否还会被赋值。用于放宽 return 逃逸：
    // 只有函数末尾的纯返回（返回后不再改写）才能安全地让它走原地追加。
    // 保守策略：任何 return 语句之后（含 else 分支、循环体内提前 return 之后）还能到达的赋值，
    // 都把该变量记入 accAfterReturn → 该变量不得原地追加。
    const accAfterReturn = new Set();
    // 注意：ts.forEachChild 的回调若返回真值会提前终止遍历，故回调必须返回 undefined。
    const assignedNames = (n, out) => {              // 子树内所有赋值目标名
        if (!n) return;
        if (ts.isBinaryExpression(n) && n.left && ts.isIdentifier(n.left)) {
            const op = n.operatorToken.kind;
            if (op === ts.SyntaxKind.EqualsToken
                || (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment))
                out.add(n.left.text);
        }
        ts.forEachChild(n, c => { assignedNames(c, out); });
    };
    const reachableAfter = (n) => {                  // n 之后同一语句列表中仍能执行到的语句
        const out = [];
        if (!n || !n.parent || !n.parent.statements) return out;
        const stmts = n.parent.statements, i = stmts.indexOf(n);
        for (let k = i + 1; k < stmts.length; k++) out.push(stmts[k]);
        return out;
    };
    const scanReturns = (n) => {
        if (ts.isReturnStatement(n)) {
            const after = new Set();
            // 循环体内的 return → 后续迭代仍会赋值（改到已返回的缓冲区）→ 整函数赋值目标一律不安全。
            let inLoop = false;
            for (let p = n.parent; p && !ts.isFunctionLike(p); p = p.parent)
                if (ts.isIterationStatement(p, true)) { inLoop = true; break; }
            if (inLoop) {
                for (const st of body.statements) assignedNames(st, after);
            } else {
                for (const st of reachableAfter(n)) assignedNames(st, after);
                // 分支/try 内的 return：该分支之后同层的语句仍可能赋值
                for (let p = n.parent; p && !ts.isFunctionLike(p); p = p.parent)
                    if (ts.isIfStatement(p) || ts.isBlock(p) || ts.isTryStatement(p))
                        for (const st of reachableAfter(p)) assignedNames(st, after);
            }
            for (const nm of after) accAfterReturn.add(nm);
        }
        ts.forEachChild(n, scanReturns);
    };
    scanReturns(body);
    const walk = (n) => {
        if (ts.isIdentifier(n)) {
            const nm = n.text, p = n.parent;
            if (p && ts.isBinaryExpression(p) && p.left === n) {
                const op = p.operatorToken.kind;
                if (op === ts.SyntaxKind.EqualsToken
                    || (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment)) {
                    cand.add(nm);                                   // x = … / x += …
                    return ts.forEachChild(n, walk);
                }
            }
            if (p && (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n) {
                /* 只读访问：x.length / x.charAt() → 安全 */
            } else if (p && ts.isVariableDeclaration(p) && p.name === n) {
                /* 声明 → 安全 */
            } else if (assignTarget(n) === nm) {
                /* 出现在「赋值给 x 的右侧」→ 安全（x = x + y 的累加模式） */
            } else if (p && ts.isReturnStatement(p) && !accAfterReturn.has(nm)) {
                /* 纯返回（函数末尾 escape）→ 安全：追加都发生在 return 之前，
                 * 返回后调用方持有的是最终缓冲区，没人再改写它。
                 * 但若 return 之后还有赋值（循环内提前 return、多 return 分支），
                 * 后续原地追加会改到已返回的缓冲区 → 仍判 unsafe。 */
            } else {
                unsafe.add(nm);
            }
        }
        ts.forEachChild(n, walk);
    };
    walk(body);
    const out = new Set();
    for (const nm of cand) if (!unsafe.has(nm)) out.add(nm);
    this._strAccCache.set(body, out);
    return out;
};
// 拼接左操作数是否可原地追加
Emitter.prototype._concatSafe = function (leftNode) {
    if (!leftNode || !ts.isIdentifier(leftNode)) return true;              // 临时量（字面量/调用/嵌套拼接）→ 无别名
    const nm = leftNode.text;
    if (this.capMap && this.capMap.has(nm)) return false;                  // 闭包捕获 → 可能别名
    if (this._local(nm) === undefined) return true;                        // 非本层局部（如类静态表）→ 保守给 true? 否：未知来源按不安全处理
    const body = this._curBody;
    return body ? this._strAccSetOf(body).has(nm) : false;
};
Emitter.prototype._emitConcat = function (inPlace) {
    const saved = this._concatInPlace;
    if (inPlace !== undefined) this._concatInPlace = !!inPlace;   // GUARD 调用（无参）→ 沿用调用点已设的标志
    const M = this.m;
    M.localSet(this.scratchA); M.localSet(this.scratchB);   // a=scratchB, b=scratchA
    // 测试 pureNum：b 纯数 → numstr；否则宿主
    M.localGet(this.scratchB); this._emitIsStr();
    M.ifBlock("i64");
      M.localGet(this.scratchA); this._emitIsStr();
      M.ifBlock("i64");
        M.localGet(this.scratchA); this._emitStrParts();
        // 左操作数可能被别名引用（非私有累加器）→ 先复制一份再原地追加（JS 字符串不可变）
        M.localGet(this.scratchB); if (!this._concatInPlace) M.call("qz.str_dup"); M.i32WrapI64();
        M.localGet(this.sT[2]); M.localGet(this.sT[0]); M.call("qzs_append");
        this._strTag();
      M.else_();
        this._emitIsPureNum(this.scratchA);
        M.ifBlock("i64");
          // 整数（x==trunc(x)）且 |x|<2^53 → wasm qzs_numstr 快路径；
          // 否则（小数 0.5 / NaN / Infinity / 大数）→ 宿主 String 精确（numstr 仅整数，会截断 0.5→"0"）
          M.localGet(this.scratchA); M.f64ReinterpretI64(); M.localSet(this.scratchFA);
          M.localGet(this.scratchFA); M.f64Trunc(); M.localGet(this.scratchFA); M.f64Eq();
          M.localGet(this.scratchFA); M.f64Neg(); M.localGet(this.scratchFA); M.f64Max();
          M.f64Const(9007199254740992); M.f64Lt();
          M.i32And();
          M.ifBlock("i64");
            M.i32Const(this._scratch || SCRATCH); M.localGet(this.scratchA); M.f64ReinterpretI64(); M.i64TruncF64S(); M.call("qzs_numstr");
            M.drop();
            M.i32Const(this._scratch || SCRATCH); M.i32Load(2, 0); M.localSet(this.sT[0]);
            M.i32Const((this._scratch || SCRATCH) + 4); M.localSet(this.sT[2]);
            M.localGet(this.scratchB); if (!this._concatInPlace) M.call("qz.str_dup"); M.i32WrapI64();   // 左操作数可能被别名引用 → 先私有副本（此前缺失 → 静默改到他处）
            M.localGet(this.sT[2]); M.localGet(this.sT[0]); M.call("qzs_append");
            this._strTag();
          M.else_();
            M.localGet(this.scratchB); M.localGet(this.scratchA); M.call("qz.string_concat");
          M.end();
        M.else_();
          M.localGet(this.scratchB); M.localGet(this.scratchA); M.call("qz.string_concat");
        M.end();
      M.end();
    M.else_();
      M.localGet(this.scratchA); this._emitIsStr();
      M.ifBlock("i64");
        M.localGet(this.scratchB); M.localGet(this.scratchA); M.call("qz.string_concat");
      M.else_();
        // 双纯数 → f64Add 内联（零跨界）；否则宿主 qz.add（ToPrimitive：bool/null/handle 拼接语义）
        this._emitIsPureNum(this.scratchA); this._emitIsPureNum(this.scratchB); M.i32And();
        M.ifBlock("i64");
          M.localGet(this.scratchB); M.f64ReinterpretI64();
          M.localGet(this.scratchA); M.f64ReinterpretI64();
          M.f64Add(); M.i64ReinterpretF64();
        M.else_();
          M.localGet(this.scratchB); M.localGet(this.scratchA); M.call("qz.add");
        M.end();
      M.end();
    M.end();
    this._concatInPlace = saved;
};
// 栈顶 i32 结构偏移 → i64 字符串句柄
Emitter.prototype._strTag = function () {
    this.m.i64ExtendI32U(); this.m.i64ConstBits(0, 0x7ffa0000); this.m.i64Or();
};
// 栈顶 i64（字符串句柄）→ 拆 sT0=len, sT1=off, sT2=bytesPtr
Emitter.prototype._emitStrParts = function () {
    this.m.i32WrapI64(); this.m.localSet(this.sT[1]);
    this.m.localGet(this.sT[1]); this.m.i32Load(2, 0); this.m.localSet(this.sT[0]);
    this.m.localGet(this.sT[1]); this.m.i32Const(4); this.m.i32Add(); this.m.localSet(this.sT[2]);
};
// 初始化表达式是否在 bump arena 上分配，且分配物只由该变量持有？
// 对象字面量 / 数组字面量 / new 都落到 bump 堆；其余（标量、字符串拼接、调用）
// 要么不分配、要么分配物不归本变量所有，不在此判定范围。
Emitter.prototype._allocInitName = function (d) {
    if (!d.initializer || !ts.isIdentifier(d.name)) return null;
    const i = d.initializer;
    if (ts.isObjectLiteralExpression(i) || ts.isArrayLiteralExpression(i) || ts.isNewExpression(i)) return d.name.text;
    return null;
};
// 循环体内分配的对象能否在每轮迭代后整体回滚（bump 复位到循环入口）？
// 判据严格保守，任一不满足即放弃：循环体里每个「对象字面量初始化」的 let/const 变量 x
//   ① 只以 x.<field> / x[..] 形式出现（读或写自身字段），从不作为值被传递/返回/存入容器；
//   ② 循环体内没有 return/throw（中途退出会带走活引用）；
//   ③ 循环体不含闭包（闭包可能把 x 存到外面）。
// 满足 → 对象生命周期不越过当前迭代，迭代末尾复位 bump 安全，分配量 O(n) → O(1)。
Emitter.prototype._loopArenaFree = function (body) {
    if (!body) return false;
    const cand = new Set(), bad = new Set();
    let hasNonLocalExit = false, hasClosure = false;
    // 收集候选（第一遍：只认对象字面量初始化）
    const collect = (n) => {
        if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) { hasClosure = true; return; }
        if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) { hasNonLocalExit = true; return; }
        if (ts.isVariableDeclaration(n)) { const nm = this._allocInitName(n); if (nm) cand.add(nm); }
        ts.forEachChild(n, c => { collect(c); });
    };
    collect(body);
    if (hasNonLocalExit || hasClosure || !cand.size) return false;
    // 检查（第二遍：候选标识符只允许作为属性/元素访问的接收者）
    const check = (n) => {
        if (ts.isIdentifier(n) && cand.has(n.text)) {
            const p = n.parent;
            const ok = (p && ((ts.isPropertyAccessExpression(p) && p.expression === n)
                           || (ts.isElementAccessExpression(p) && p.expression === n)))
                    || (p && ts.isVariableDeclaration(p) && p.name === n);   // 声明处自身
            if (!ok) bad.add(n.text);
        }
        ts.forEachChild(n, c => { check(c); });
    };
    check(body);
    return bad.size === 0;
};
// 循环 arena 回滚的入口/出口：进入时保存 bump 到当前深度的槽，离开时复位。
// 判定不通过或槽位耗尽时返回 undefined，两个函数都退化为空操作。
Emitter.prototype._arenaLoopEnter = function (body) {
    if (this._loopSaveBase === undefined || this.scratchObj === undefined) return undefined;
    if (this._loopSaveDepth >= (this._loopSaveCount || 0)) return undefined;
    if (!this._loopArenaFree(body)) return undefined;
    const slot = this._loopSaveBase + this._loopSaveDepth;
    this.m.globalGet(0); this.m.localSet(slot); this._loopSaveDepth++;
    return slot;
};
Emitter.prototype._arenaLoopLeave = function (slot) {
    if (slot === undefined) return;
    this.m.localGet(slot); this.m.globalSet(0); this._loopSaveDepth--;
};
// 函数级 arena 回滚：函数返回时把 bump 复位到入口，本次调用内的分配一并回收。
// 适用于「函数内造临时对象、只读字段、返回标量」的形态——被循环反复调用时，否则每次调用
// 泄漏 40 字节，41.9 万次后 arena 耗尽崩溃。
// 前提是能**证明返回值不指向 arena**，否则复位让返回值悬空（静默内存 corruption，比崩溃更糟）。
// 判据（任一不满足即放弃，宁可泄漏也不误判）：
//   ① 返回类型标注必须是 number/boolean/void/undefined —— 编译期即可证明返回值不是句柄；
//   ② 函数体内确有对象字面量分配（否则无回收收益）；
//   ③ 无 try/throw（finally 可能在复位后访问对象）、无闭包（可能把局部存进 env）、
//      无 new（构造分配不在此分析范围，逃逸性不可证）；
//   ④ 每个对象字面量局部只以 x.field / x[..] 出现；且 return 表达式里不出现这些名字。
Emitter.prototype._fnArenaFree = function (f) {
    if (this.mode !== "tagged") return false;
    const ty = f.type;
    if (!ty) return false;
    const k = ty.kind;
    if (!(k === ts.SyntaxKind.NumberKeyword || k === ts.SyntaxKind.BooleanKeyword
       || k === ts.SyntaxKind.VoidKeyword || k === ts.SyntaxKind.UndefinedKeyword)) return false;
    const cand = new Set(), bad = new Set();
    const collect = (n) => {
        if (ts.isTryStatement(n) || ts.isThrowStatement(n)) bad.add("\u0000fn");
        if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) bad.add("\u0000fn");
        if (ts.isVariableDeclaration(n)) {
            const nm = this._allocInitName(n);
            if (nm) {
                cand.add(nm);
                // new C(…)：构造体若把 this 存到外部，复位会让那个引用悬空 → 拒绝。
                if (ts.isNewExpression(n.initializer) && !this._ctorKeepsThis(n.initializer)) bad.add("\u0000ctor");
            }
        }
        ts.forEachChild(n, c => { collect(c); });
    };
    collect(f.body);
    if (bad.size || !cand.size) return false;
    const check = (n) => {
        if (ts.isIdentifier(n) && cand.has(n.text)) {
            const p = n.parent;
            const ok = (p && ((ts.isPropertyAccessExpression(p) && p.expression === n)
                           || (ts.isElementAccessExpression(p) && p.expression === n)))
                    || (p && ts.isVariableDeclaration(p) && p.name === n);   // 声明处自身
            if (!ok) bad.add(n.text);
        }
        // `return p` 这类整体逃逸由上面的 ok 判定兜住（返回位置的标识符不是属性访问基址）。
        ts.forEachChild(n, c => { check(c); });
    };
    check(f.body);
    return bad.size === 0;
};
// new C(…) 的实例能否在返回时回收？构造体本身（含继承链）若把 `this` 交给外部
// （return this、存容器、赋给自由变量、传给调用、被闭包捕获），复位会让那个引用悬空。
// 只在构造体对本实例只做字段写/读时判定安全。找不到类定义 → 一律拒绝。
Emitter.prototype._ctorKeepsThis = function (newExpr) {
    const clsNode = newExpr.expression;
    if (!ts.isIdentifier(clsNode)) return true;                      // 动态表达式 → 不可证
    let c = this.classes.get(clsNode.text);
    if (!c || !c.ctor) return true;                                  // 无显式构造 → 字段初始化可能逃逸，保守拒绝
    let leak = false;
    const walk = (n) => {
        if (leak) return;
        if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) { leak = true; return; }   // 闭包可能捕获 this
        if (ts.isReturnStatement(n) && n.expression) { leak = true; return; }             // return this
        if (ts.isThis(n)) {
            const p = n.parent;
            // 只允许 this.field（读写）与本构造链的 super(…) 转发
            const okField = p && (ts.isPropertyAccessExpression(p) && p.expression === n);
            const okCall = p && ts.isCallExpression(p)
                && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === "super";
            if (!okField && !okCall) leak = true;
            if (leak) return;
        }
        ts.forEachChild(n, walk);
    };
    walk(c.ctor);
    return leak;
};


