/* emitter.js — Emitter 核心：AST → wasm 指令发射
 * emitter.js 拆分件；模块图见 ../emitter.js 顶部注释。 */
"use strict";
const ts = require("typescript");
const { BUILTIN_GLOBALS, usesArguments, ctorName, symbolNameOf, methName, staticMethName } = require("./consts.js");
const { INMOD_TABLE_CAP, emitBumpAlloc, numArrNames, funcMode, f64Bits } = require("./layout.js");

class Emitter {
    constructor(mod) { this.m = mod; this.varMap = new Map(); this.depth = 0; this.labels = []; this._labelStack = []; this._tryStack = []; this.strings = []; this._litOff = new Map(); this._strVars = new Set();
        this.capMap = new Map();      // 捕获变量名 → blk 内偏移（i64 槽序号），闭包体内有效
        this.capList = [];            // 当前闭包的捕获名列表（顺序 = 槽序）
        this.blkLocal = null;         // 当前闭包体的 blk 指针 local（i32）
        this.fnNames = new Set();     // 顶层函数名（闭包捕获分析排除）
        this.lambdas = [];            // 全部 lambda（箭头/函数表达式）：{id,node,captures}
        this._lamById = new Map();    // lambda node → {id,fname,caps}
        this.classes = new Map();     // class name → {id, parent, fields:Map, methods:Map(name→meta)}
        this._classList = [];         // 按声明序的类（发射顺序稳定）
        // 字段名 → 字节偏移。槽 0 保留给类实例的 `__cls` 标记（类 id），用户字段从 8 起。
        this.fieldMap = new Map([["__cls", 0]]);
        this._curClass = null;        // 当前正在发射的方法所属类（this 字段读写用）
        this._curClassObj = null;     // 当前类元数据
        this._staticVars = new Map(); // 变量名 → 类名：静态精确接收者（当前函数/方法体有效）
        this._leafClasses = new Set();// 无子类的类：其方法/构造器内 `this` 静态精确
        this._pendingLambdas = [];    // 已登记待发射的 lambda 体
        this.sf = null;               // 当前 SourceFile（行号查询；compileTS 设置）
        this.importAlias = null;      // { 本地导入名 → 目标顶层函数名 }；compileTS 多文件时设置
        this.nsAlias = null;          // { 命名空间本地名 → Map(成员名 → 目标顶层名) }（`import * as ns`）
        this.classAlias = null;       // { 本地类名 → 目标类名 }（默认/命名导入的类）
    }
    // 源码行号（1-based）。DWARF 行标记用；无 sf 时返回 0（该 mark 被忽略）。
    _line(node) { return (this.sf && node && node.pos !== undefined) ? this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf)).line + 1 : 0; }
    /* 跨文件内联：把 `import { x as y }` 的本地别名 y 折回目标模块的导出名 x。
     * 非导入名原样返回（本模块顶层函数 / 闭包变量）。 */
    _fnName(name) { return (this.importAlias && this.importAlias.get(name)) || name; }
    // 导入的类本地名 → 目标类名（默认/具名导入的类）；非导入类原样返回。
    _className(name) { return (this.classAlias && this.classAlias.get(name)) || name; }
    // 静态成员键：私有名需类名限定（与收集期一致：#类名#名；PrivateIdentifier.text 自带 #）
    _staticKey(cn, nameNode) { return ts.isPrivateIdentifier(nameNode) ? "#" + cn + "#" + nameNode.text : nameNode.text; }
    // 命名空间成员访问 `ns.member` → 目标顶层名；非命名空间访问返回 undefined。
    _nsMember(nsName, member) {
        if (!this.nsAlias) return undefined;
        // 优先按当前源文件查：同名 `import * as ns` 在不同文件可指向不同模块
        // （zod：core/api.ts 的 checks=core/checks.js，classic/schemas.ts 的 checks=classic/checks.js）。
        const byFile = this.nsAliasByFile && this.sf && this.nsAliasByFile[this.sf.fileName];
        if (byFile) {
            const m0 = byFile.get(nsName);
            const r0 = m0 && m0.get(member);
            if (r0 !== undefined) return r0;
        }
        const g = this.nsAlias.get(nsName);
        const rg = g && g.get(member);
        if (rg !== undefined) return rg;
        // 模块初始化体是**跨文件合并**的合成函数（fnSf 只有入口文件一个条目），当前 sf 未必是
        // 语句真正所属的文件。成员名即目标顶层函数名且全局唯一 → 任一同名 namespace 表里
        // 有这个成员就是它（zod：parse.ts 的 `_parse(errors.$ZodRealError)` 在 api.ts 的 sf 下发射）。
        if (this.nsAliasByFile) {
            for (const k in this.nsAliasByFile) {
                const mm = this.nsAliasByFile[k].get(nsName);
                const r = mm && mm.get(member);
                if (r !== undefined) return r;
            }
        }
        return undefined;
    }
    // namespace 的完整成员表（`{ ...ns }` 展开用）：优先按当前文件，其次全表，
    // 多个同名 namespace 时合并（成员名唯一即目标顶层名）。
    _nsMembers(nsName) {
        if (!this.nsAlias) return null;
        const out = new Map();
        const byFile = this.nsAliasByFile && this.sf && this.nsAliasByFile[this.sf.fileName];
        const m0 = byFile && byFile.get(nsName);
        if (m0) for (const [k, v] of m0) out.set(k, v);
        if (this.nsAliasByFile) for (const k in this.nsAliasByFile) {
            const mm = this.nsAliasByFile[k].get(nsName);
            if (mm) for (const [kk, vv] of mm) if (!out.has(kk)) out.set(kk, vv);
        }
        if (out.size) return out;
        const g = this.nsAlias.get(nsName);
        return g && g.size ? g : null;
    }
    /* 跨模式调用 ABI：num 值 = f64，tagged 值 = i64（数值侧 = 原始 f64 位型，见文件尾注释）。
     * 故跨模式边界只要按位重解释（精确无损），无需装箱。fnMode: {名 → {mode, void}}。 */
    _calleeInfo(fn) { return this.fnMode ? this.fnMode.get(this._fnName(fn)) : undefined; }
    // 实参发射后调用：把值从本函数模式转到被调函数模式（相等则空操作）。
    _argToCallee(fn) {
        const ci = this._calleeInfo(fn);
        if (!ci || ci.mode === this.mode) return;
        if (ci.mode === "num") this.m.f64ReinterpretI64();   // tagged(i64) → num(f64)
        else this.m.i64ReinterpretF64();                      // num(f64) → tagged(i64)
    }
    // call 之后调用：把返回值从被调函数模式转回本函数模式（void / 相等则空操作）。
    _retFromCallee(fn) {
        const ci = this._calleeInfo(fn);
        if (!ci || ci.void || ci.mode === this.mode) return;
        if (ci.mode === "num") this.m.i64ReinterpretF64();   // num(f64) → tagged(i64)
        else this.m.f64ReinterpretI64();                      // tagged(i64) → num(f64)
    }
    _local(name) { return this.varMap.get(name); }
    // 取出并消费栈顶 label：一个 label 只修饰其直接子循环。嵌套循环 push 时各取各的。
    _curLabel() { return this._labelStack.length ? this._labelStack.pop() : null; }

    // 收集函数体里的 let/const（分配 local 索引）；支持解构绑定（数组/对象，含嵌套）。
    _collectLocals(node) {
        const skip = this._inModInit ? this._modInitNames : null;   // 模块初始化函数：模块级名归全局，不建局部
        const names = [];
        const bindName = (bn) => {
            if (ts.isIdentifier(bn)) { names.push(bn.text); return; }
            if (ts.isArrayBindingPattern(bn) || ts.isObjectBindingPattern(bn)) {
                for (const el of bn.elements) {
                    if (ts.isOmittedExpression(el)) continue;
                    if (ts.isBindingElement(el)) bindName(el.name);
                }
            }
        };
        const walk = (n) => {
            if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) return;   // 类体（方法/访问器/字段/静态块）是独立作用域：其 let/const 不属外层函数（否则同名会顶掉外层参数槽）
            if (ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)
                || ts.isConstructorDeclaration(n)) return;                     // 对象字面量方法/访问器同理（各自编译为独立闭包）
            if (ts.isVariableDeclaration(n)) bindName(n.name);
            else if (ts.isFunctionDeclaration(n) && n.name && n.body && !(this.hoistedFns && this.hoistedFns.has(n))) { names.push(n.name.text); return; }   // 嵌套函数名是本层局部，但其体属另一作用域；无 body = 重载签名，不引入绑定
            else if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;   // 不深入嵌套函数体
            ts.forEachChild(n, walk);
        };
        walk(node);
        if (skip) { for (let i = names.length - 1; i >= 0; i--) if (skip.has(names[i])) names.splice(i, 1); }   // 模块初始化函数：模块级名归全局
        for (let i = 0; i < 32; i++) names.push("$sh" + i);            // 块级遮蔽保存槽（i64 值局部区，索引可经 _local 取得）
        // 精确检测：嵌套块里声明的名字若已在外层可见 → 记为「遮蔽块」（进入该块前后保存/恢复外层同名局部）
        if (node && node.statements) {
            this._shadowBlocks = this._shadowBlocks || new WeakMap();
            const base = new Set(names);
            const scan = (n, visible) => {
                if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) return;   // 类体不属本函数语句流
                if (ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)
                    || ts.isConstructorDeclaration(n)) return;                    // 对象字面量方法体同理
                if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
                if (ts.isBlock(n)) {
                    const inner = new Set(visible);
                    for (const st of n.statements) {
                        if (!ts.isVariableStatement(st)) continue;
                        for (const d of st.declarationList.declarations) {
                            const dn = [];
                            const bn = (x) => { if (ts.isIdentifier(x)) dn.push(x.text); else if (ts.isArrayBindingPattern(x) || ts.isObjectBindingPattern(x)) for (const el of x.elements) if (ts.isBindingElement(el)) bn(el.name); };
                            bn(d.name);
                            for (const nm of dn) { if (visible.has(nm)) this._shadowBlocks.set(n, nm); inner.add(nm); }
                        }
                    }
                    for (const st of n.statements) scan(st, inner);
                    return;
                }
                ts.forEachChild(n, (c) => scan(c, visible));
            };
            for (const st of node.statements) scan(st, base);
        }
        return names;
    }

    // 变量声明（含解构）：`const a = e` / `const [a,b] = e` / `const {x,y} = e`（含嵌套）。
    // 解构基值求值一次存 scratch；数组元素 = base[i]，对象属性 = base.field（wasm POJO，零跨界）。
    _emitBindingDecl(d) {
        const M = this.m;
        const name = d.name;
        if (ts.isIdentifier(name)) {
            if (d.initializer) {
                if (ts.isClassExpression(d.initializer) && this.clsExprMap && this.clsExprMap.has(d.initializer)) {
                    this._emitUndefined(); this._emitVarStore(name.text, this.scratchB); this.m.drop(); return;   // const C = class {…}：C 仅作 new/instanceof 的类名
                }
                if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
                    this._fnVars = this._fnVars || new Set(); this._fnVars.add(name.text);
                    this._fnNodes = this._fnNodes || new Map(); this._fnNodes.set(name.text, d.initializer);
                }
                if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
                    this._emitLambdaNew(d.initializer, name.text);   // 传绑定名 → 自递归可直调 wasm 函数
                    this._emitVarStore(name.text, this.scratchB); this.m.drop();
                    return;
                }
                this.emitTaggedExpr(d.initializer); this._emitVarStore(name.text, this.scratchB); this.m.drop();
                if (this._inModInit && this.usesKeyOrder && this._modObjKeys && this._modObjKeys.has(name.text)) {
                    for (const k2 of this._modObjKeys.get(name.text)) {   // 模块级对象键序（start 段 mem 未绑定 → 用 order_note）
                        this._emitVarGet(name.text); this.m.i32Const(this._strId(k2)); this.m.call("qz.order_note");
                    }
                }
            }
            return;
        }
        if (!d.initializer) return;
        this.emitTaggedExpr(d.initializer); M.localSet(this.scratch);
        if (ts.isArrayBindingPattern(name)) {
            // 非 wasm 数组/字符串的可迭代（Set/Map/自定义 @@iterator/类实例）→ 迭代协议收集为数组
            // （JS 数组解构走 Iterator；此前直接按索引读 → 静默 undefined）
            { const Mt = this.m;
              Mt.localGet(this.scratch); Mt.i64Const(48n); Mt.i64ShrU(); Mt.i64Const(0x7ffbn); Mt.i64Eq();
              Mt.localGet(this.scratch); Mt.i64Const(48n); Mt.i64ShrU(); Mt.i64Const(0x7ffan); Mt.i64Eq();
              Mt.i32Or(); Mt.i32Eqz();
              Mt.ifBlock("void");
              Mt.localGet(this.scratch); Mt.call("qz.iter_array"); Mt.localSet(this.scratch);
              Mt.end(); }
            let i = 0;
            for (const el of name.elements) {
                if (ts.isOmittedExpression(el)) { i++; continue; }
                if (ts.isBindingElement(el) && el.dotDotDotToken) {     // [...rest] → 宿主 arr.slice(i)
                    M.localGet(this.scratch); M.i32Const(this._strId("slice"));
                    M.i64ConstBits(...f64Bits(i));
                    this._emitUndefined(); this._emitUndefined(); this._emitUndefined();
                    this._emitUndefined();   // ovf（实参 4..；当前恒 undefined，>4 形参支持后由调用点传入）
                    M.call("qz.method_call");
                    this._emitBindingTarget(el.name);
                    i++;
                    continue;
                }
                this._emitElemOf(this.scratch, ts.factory.createNumericLiteral(i));
                if (ts.isBindingElement(el) && el.initializer) this._emitDefaultIfUndef(el.initializer);
                this._emitBindingTarget(el.name);
                i++;
            }
        } else {   // ObjectBindingPattern
            // 基值另存可重入临时槽：计算键/默认值表达式内部可能用 this.scratch（如 a && b），
            // 继续拿 scratch 当基值会被覆盖。
            const b = this._expEnter();
            M.localGet(this.scratch); M.localSet(b.v);
            const hasRest = name.elements.some(el => ts.isBindingElement(el) && el.dotDotDotToken);
            // {...rest} 的静态排除键；计算键不进 object_rest，建出 rest 后按保存的键值删除（最多 8 个静态键）。
            const restExcl = [];
            if (hasRest) {
                for (const el of name.elements) {
                    if (!ts.isBindingElement(el) || el.dotDotDotToken) continue;
                    const k = el.propertyName
                        ? ((ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) || ts.isNumericLiteral(el.propertyName)) ? el.propertyName.text : null)
                        : (ts.isIdentifier(el.name) ? el.name.text : null);
                    if (k !== null) restExcl.push(k);
                }
            }
            const nComputed = hasRest
                ? name.elements.filter(el => ts.isBindingElement(el) && !el.dotDotDotToken && el.propertyName && ts.isComputedPropertyName(el.propertyName)).length
                : 0;
            const keyBase = hasRest ? this._reserveRestKeys(nComputed) : 0;
            let ci = 0;
            for (const el of name.elements) {
                if (!ts.isBindingElement(el)) continue;
                if (el.dotDotDotToken) {                               // {...rest} → 宿主 object_rest + 删计算键
                    if (restExcl.length > 8) throw new Error("[tagged] 对象 rest 解构最多排除 8 个键");
                    const t = this._expEnter();
                    M.localGet(b.v);
                    for (let i = 0; i < 8; i++) M.i32Const(i < restExcl.length ? this._strId(restExcl[i]) : -1);
                    M.call("qz.object_rest");
                    M.localSet(t.v);
                    for (let i = 0; i < ci; i++) {
                        M.localGet(t.v); M.localGet(this._restKeyBase + keyBase + i);
                        M.call("qz.delete_index"); M.drop();
                    }
                    M.localGet(t.v);
                    this._emitBindingTarget(el.name);
                    this._expLeave();
                    continue;
                }
                const key = el.propertyName
                    ? ((ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) || ts.isNumericLiteral(el.propertyName)) ? el.propertyName.text : null)
                    : (ts.isIdentifier(el.name) ? el.name.text : null);
                if (key === null) {
                    if (el.propertyName && ts.isComputedPropertyName(el.propertyName)) {   // 计算键名：o[expr]（运行期键；rest 需复用同一键值）
                        if (hasRest) {
                            const keyLocal = this._restKeyBase + keyBase + ci++;
                            this.emitTaggedExpr(el.propertyName.expression); M.localSet(keyLocal);
                            this._emitElemOf(b.v, null, keyLocal);
                        } else {
                            this._emitElemOf(b.v, el.propertyName.expression);
                        }
                        if (el.initializer) this._emitDefaultIfUndef(el.initializer);
                        this._emitBindingTarget(el.name);
                        continue;
                    }
                    throw new Error("[tagged] 暂不支持该形式的解构属性名: " + ts.SyntaxKind[el.propertyName ? el.propertyName.kind : el.name.kind]);
                }
                this._emitPropReadFromLocal(b.v, key);        // 越界 → undefined（不再裸读内存）
                if (el.initializer) this._emitDefaultIfUndef(el.initializer);
                this._emitBindingTarget(el.name);
            }
            if (hasRest) this._releaseRestKeys(keyBase);
            this._expLeave();
        }
    }
    // 栈顶值 → 绑定目标。Identifier 直落 local；嵌套 pattern 入临时槽后递归析构。
    _emitBindingTarget(name) {
        if (ts.isIdentifier(name)) { this.m.localSet(this._local(name.text)); return; }
        const t = this._expEnter();
        this.m.localSet(t.v);
        this._emitDestructurePattern(name, t.v);
        this._expLeave();
    }

    // 收集函数体内所有箭头函数/函数表达式（含嵌套），按源序。返回节点列表。
    _collectLambdas(node, out = []) {
        const walk = (n) => {
            if (ts.isArrowFunction(n)) { out.push(n); }
            else if (ts.isFunctionExpression(n)) {
                // 对象属性值位置且体内用 `this`（`parse: function _parse(){ …this… }`）：
                // 运行时 this = receiver，须走合成 self 形参的闭包，否则无 `this` 槽位。
                const isPropVal = ts.isPropertyAssignment(n.parent) && n.parent.initializer === n;
                if (isPropVal && this._usesThis(n.body)) out.push(this._synthSelfFn(n));
                else { out.push(n); }
            }
            else if (ts.isFunctionDeclaration(n) && n.name && n.body && !(this.hoistedFns && this.hoistedFns.has(n))) { out.push(n); }   // 无 body = 重载签名，不是 lambda
            else if ((ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n))
                     && ts.isObjectLiteralExpression(n.parent)) out.push(this._memberLambda(n));
            ts.forEachChild(n, walk);
        };
        walk(node);
        return out;
    }
    // 体内是否引用 `this`（不深入嵌套的普通函数体，但箭头函数继承 this → 继续找）。
    _usesThis(n) {
        let hit = false;
        const w = (x) => {
            if (hit) return;
            if (x.kind === ts.SyntaxKind.ThisKeyword) { hit = true; return; }
            if (ts.isFunctionDeclaration(x) || ts.isFunctionExpression(x)) return;   // 自有 this，不继承
            ts.forEachChild(x, w);
        };
        w(n);
        return hit;
    }
    // 具名函数表达式 → 合成「首形参 = this」的箭头（复用具名方法与 _qzSynthThis 通路）。
    _synthSelfFn(fe) {
        this._synthLambdas = this._synthLambdas || new WeakMap();
        let f = this._synthLambdas.get(fe);
        if (f) return f;
        f = this._synthArrowWithParams("this", fe.parameters, fe.body);
        const lp = fe.parameters[fe.parameters.length - 1];
        if (lp && lp.dotDotDotToken) f._qzRest = true;
        if (fe.name) f._qzSelfName = fe.name.text;    // 具名：体内自递归可直调
        this._synthLambdas.set(fe, f);
        return f;
    }
    // 闭包捕获分析：找 lambda 体内的自由标识符（非其参数/局部、非字符串/数字/对象属性名）。
    // 捕获的变量来自创建处（外层函数局部）。返回有序捕获名列表。
    _capturesOf(lam) {
        const lambdaIsArrow = ts.isArrowFunction(lam);   // 箭头继承 this；function 表达式有自己的 this
        const fnLike = (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)
            || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)
            || ts.isConstructorDeclaration(n) || ts.isClassStaticBlockDeclaration(n);
        const local = new Set();
        for (const p of lam.parameters) for (const n of this._patternNames(p.name)) local.add(n);
        this._collectLocals(lam.body).forEach(n => local.add(n));
        const scopes = [local];                          // 嵌套函数/方法各自的参数+局部：它们不是外层自由变量
        const isLocal = (name) => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return true; return false; };
        const out = [];
        const seen = new Set();
        const walk = (n) => {
            if (ts.isTypeNode(n)) return;   // 类型注解里的标识符（interface 名/类型参数）不是运行期引用
            if (fnLike(n)) {                 // 嵌套函数/方法体：压入其作用域，继续收集其自由引用
                const s = new Set();
                for (const p of n.parameters || []) for (const pn of this._patternNames(p.name)) s.add(pn);
                if (n.body) this._collectLocals(n.body).forEach(x => s.add(x));
                scopes.push(s);
                for (const p of n.parameters || []) { walk(p.name); if (p.initializer) walk(p.initializer); }
                if (n.body) walk(n.body);
                scopes.pop();
                return;
            }
            if (n.kind === ts.SyntaxKind.SuperKeyword) {   // super 引用需要 receiver（home object 的 this）→ 箭头视作捕获 "this"
                if (!isLocal("this") && lambdaIsArrow && !seen.has("this")) { seen.add("this"); out.push("this"); }
                ts.forEachChild(n, walk); return;
            }
            // 不能用 ts.isThis：它对 Identifier 会读 n.parent.kind，而合成箭头（对象字面量方法）
            // 的 "this" 形参名是脱离 parent 链的新节点 → TypeError。
            const thisRef = n.kind === ts.SyntaxKind.ThisKeyword
                || (ts.isIdentifier(n) && n.text === "this"
                    && (!n.parent || n.parent.kind === ts.SyntaxKind.Parameter));
            if (thisRef) {   // 箭头函数继承 this → 视作捕获 "this"
                // 合成的访问器/方法闭包把 self 作为名为 "this" 的**形参** → 不作捕获
                if (!isLocal("this") && (lambdaIsArrow && !seen.has("this"))) { seen.add("this"); out.push("this"); }
                ts.forEachChild(n, walk); return;
            }
            if (ts.isIdentifier(n)) {
                // 跳过成员表达式右侧（obj.prop 的 prop 不是变量）
                if (n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) return;
                if (n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name === n) return;
                if (n.parent && ts.isBindingElement(n.parent) && n.parent.propertyName === n) return;   // 解构属性名不是变量
                const name = n.text;
                if (!isLocal(name) && !seen.has(name) && !this.fnNames.has(name)
                    && !(this.classes.has(this._className(name) || name))   // 类名不是自由变量（闭包内须走类对象路径）
                    && !(this.moduleGlobals && this.moduleGlobals.has(name))   // 模块级全局：闭包内改为调用时读全局（否则按创建时值捕获 → 自递归箭头 const 拿到 undefined）
                    && !/^(undefined|null|NaN|Infinity)$/.test(name)) { seen.add(name); out.push(name); }
                return;
            }
            ts.forEachChild(n, walk);
        };
        // 形参解构的计算键/默认值也在闭包体内求值，须按自由变量捕获（此前只扫 body，
        // 箭头 `({ [k]: v, ...r }) => …` 里的外层 k 会读成 undefined）。
        for (const p of lam.parameters) {
            walk(p.name);
            if (p.initializer) walk(p.initializer);
        }
        walk(lam.body);
        return out;
    }
    // 把非函数节点（字段初值/静态块）包成合成箭头，复用 _capturesOf 的自由变量分析。
    _synthCaptureArrow(body) {
        return ts.factory.createArrowFunction(undefined, undefined, [], undefined, undefined, body);
    }
    // 静态接收者分析：返回 Map(变量名 → 类名)，仅收录静态类精确可判的变量——
    // `let/const x = new C(...)` 且 x 在全函数体内从未被写、也未被任何嵌套闭包引用（保守）。
    // 依据：new C 只会产出类 C 的实例（本编译器无跨类原型改写），故 x 的动态类恒为 C。
    _computeStaticVars(body, paramNames) {
        const declaredClass = new Map();   // 名字 → 类名（仅直接 new C 初始化）
        // 作用域安全：同名被多处绑定（内层遮蔽/重复声明/与参数重名）→ 名字整体不可判。
        const bound = new Set(paramNames || []), dup = new Set();
        const addBind = (nm) => { if (bound.has(nm)) dup.add(nm); else bound.add(nm); };
        const collectBinding = (bn) => {
            if (ts.isIdentifier(bn)) addBind(bn.text);
            else if (ts.isObjectBindingPattern(bn) || ts.isArrayBindingPattern(bn))
                for (const el of bn.elements) if (ts.isBindingElement(el)) collectBinding(el.name);
        };
        const isNewIdent = (n) => ts.isNewExpression(n) && ts.isIdentifier(n.expression);
        const walkDecl = (n) => {
            if (ts.isVariableDeclaration(n)) {
                collectBinding(n.name);
                if (ts.isIdentifier(n.name) && n.initializer && isNewIdent(n.initializer)) {
                    const cls = this._className(n.initializer.expression.text);
                    if (this.classes.has(cls)) {
                        const name = n.name.text;
                        if (declaredClass.has(name) && declaredClass.get(name) !== cls) declaredClass.set(name, null);
                        else declaredClass.set(name, cls);
                    }
                }
            }
            ts.forEachChild(n, walkDecl);
        };
        walkDecl(body);
        if (!declaredClass.size) return new Map();
        // 有潜在写/捕获的名字 → 取消追踪。注意：compileTS 的 TS transformer 会重建节点，
        // 不能依赖 child.parent 回链，故在遍历到写节点（赋值/自增/for-of）时主动取其目标。
        const mutated = new Set();
        const markNamesIn = (t) => {   // 收集子树内所有与追踪同名的标识符（含解构目标；多标不误）
            if (ts.isIdentifier(t)) { if (declaredClass.has(t.text)) mutated.add(t.text); return; }
            ts.forEachChild(t, markNamesIn);
        };
        const ASSIGN_LO = ts.SyntaxKind.FirstAssignment, ASSIGN_HI = ts.SyntaxKind.LastAssignment;
        const walkUse = (n, nest) => {
            const deeper = nest || ts.isArrowFunction(n) || ts.isFunctionExpression(n);
            if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ASSIGN_LO && n.operatorToken.kind <= ASSIGN_HI) {
                markNamesIn(n.left);
            } else if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
                markNamesIn(n.operand);
            } else if ((ts.isForOfStatement(n) || ts.isForInStatement(n))) {
                markNamesIn(n.initializer);
            } else if (ts.isIdentifier(n) && deeper && declaredClass.has(n.text)) {
                mutated.add(n.text);   // 出现在嵌套闭包内 → 保守作废
            }
            ts.forEachChild(n, (c) => walkUse(c, deeper));
        };
        walkUse(body, false);
        const out = new Map();
        for (const [name, cls] of declaredClass) if (cls && !mutated.has(name) && !dup.has(name)) out.set(name, cls);
        return out;
    }
    // 沿继承链解析方法所属类：从 cname 起向上找第一个声明了 method 的类；无则 null。
    _methodOwner(cname, method) {
        let cur = cname;
        while (cur) {
            const c = this.classes.get(cur);
            if (!c) return null;
            for (const m of c.methods) if (m.name === method) return cur;
            if (this._dynParentExpr(c)) return null;      // 动态父（mixin）：运行时父链不可静态解析 → 退回动态派发
            cur = c.parent && this.classes.has(c.parent) ? c.parent : null;
        }
        return null;
    }
    // 接收者静态类：标识符 → _staticVars；叶类方法体/构造器内的 `this` → _curClass。否则 null。
    // 静态方法/getter/setter 内 `this` 在本实现中按**定义类**解析。仅当调用类到定义类之间某层**自有**静态成员
    // 命中体内 `this.<name>` 访问集时才可能偏差（JS 的 this = 调用类）→ 此时 loud（避免静默错值）。
    _checkStaticThis(owner, callCls, sm, label) {
        if (!sm || !sm.thisNames || !sm.thisNames.size || owner === callCls) return;
        let x = callCls, hop = 0;
        while (x && x !== owner && hop++ < 100) {
            const c = this.classes.get(x);
            if (!c) break;
            const own = (arr2, nm) => (arr2 || []).some(k => k.name === nm);
            for (const nm of sm.thisNames) {
                if (own(c.staticFields, nm) || own(c.staticMethods, nm)) {
                    throw new Error(`[tagged] 静态成员 ${owner}.${label} 体内 \`this.${nm}\` 经派生类 ${callCls} 调用：this 应为派生类对象，未实现`);
                }
            }
            x = c.parent;
        }
    }
    _staticRecvClass(rx) {
        if (ts.isIdentifier(rx) && this._staticVars && this._staticVars.has(rx.text)) return this._staticVars.get(rx.text);
        if (rx.kind === ts.SyntaxKind.ThisKeyword && this._curClass && this._leafClasses.has(this._curClass)) return this._curClass;
        return null;
    }
    // owner 类声明的 method 元数据（含 accessor）；无则 null。
    _classMethodMeta(cname, method) {
        const c = this.classes.get(cname);
        if (!c) return null;
        for (const m of c.methods) if (m.name === method) return m;
        return null;
    }
    // 给定自由名，是否本函数可见（在 varMap / capMap 中）——决定闭包创建时是否真的捕获。
    _isCapturable(name) { return this.varMap.has(name) || this.capMap.has(name); }
    // 闭包体内的捕获读：name 在 capMap → [blk + slot*8]；否则本函数局部（经 varMap）。
    _emitCapturedRead(name) {
        const M = this.m;
        if (this.capMap.has(name)) { M.localGet(this.capMap.get(name)); M.i32Const(this._strId(name)); M.call("qz.env_get"); return; }
        const idx = this._local(name);
        if (idx === undefined) {
            const g = this.moduleGlobals && this.moduleGlobals.get(name);
            if (g !== undefined) { M.globalGet(g); return; }   // 模块级变量
            // 跨文件导入的模块级变量（`import defaultErrorMap from './locales/en.js'` 指向
            // 目标文件的 `const errorMap`）：importAlias 记的是目标名，值在 moduleGlobals 里。
            // 此前只查本名 → 「未定义捕获变量」（zod v3 errors.ts / parseUtil.ts 7 例）。
            if (this.importAlias) {
                const tgt = this.importAlias.get(name);
                const g2 = tgt === undefined ? undefined
                    : (this.moduleGlobals ? this.moduleGlobals.get(tgt) : undefined);
                if (g2 !== undefined) { M.globalGet(g2); return; }
            }
            if (this.fnNames && this.fnNames.has(name) && this.m._funcIdx[this._fnName(name)] !== undefined) {
                // 顶层函数作值（回调/别名/属性宿主）→ 包装为宿主函数句柄（此前 loud：未定义捕获变量）
                M.i32Const(this._strId(this._fnName(name))); M.i32Const((this._fnParams && this._fnParams.get(this._fnName(name))) || 0);
                M.i32Const(this._fnHasThis && this._fnHasThis.get(this._fnName(name)) ? 1 : 0); M.call("qz.fn_value");
                return;
            }
            if (BUILTIN_GLOBALS.has(name)) { M.i32Const(this._strId(name)); M.call("qz.builtin_member"); return; }   // 内建全局作值（Symbol/Math/JSON…）
            // 未声明标识符（宿主侧的 lib 全局如 `URL`/`Object`，内联模块内无绑定）→ undefined。
            // 抛错会中断发射并留下不平衡的栈（zod：`URL.canParse(x)` 等）。
            this._emitUndefined();
            return;
        }
        M.localGet(idx);
    }

    // 变量读（含闭包捕获）：栈 += 值。
    _emitVarGet(name) {
        if (this.capMap.has(name)) { this.m.localGet(this.capMap.get(name)); this.m.i32Const(this._strId(name)); this.m.call("qz.env_get"); return; }
        const idx = this._local(name);
        if (idx === undefined) {
            const g = this.moduleGlobals && this.moduleGlobals.get(name);
            if (g !== undefined) { this.m.globalGet(g); return; }   // 模块级变量
            if (this.importAlias) {                                 // 导入的模块级变量（同 _emitCapturedRead）
                const tgt = this.importAlias.get(name);
                const g2 = tgt === undefined ? undefined
                    : (this.moduleGlobals ? this.moduleGlobals.get(tgt) : undefined);
                if (g2 !== undefined) { this.m.globalGet(g2); return; }
            }
            if (this.fnNames && this.fnNames.has(name) && this.m._funcIdx[this._fnName(name)] !== undefined) {
                this.m.i32Const(this._strId(this._fnName(name))); this.m.i32Const((this._fnParams && this._fnParams.get(this._fnName(name))) || 0);
                this.m.i32Const(this._fnHasThis && this._fnHasThis.get(this._fnName(name)) ? 1 : 0); this.m.call("qz.fn_value");
                return;
            }
            if (BUILTIN_GLOBALS.has(name)) { this.m.i32Const(this._strId(name)); this.m.call("qz.builtin_member"); return; }
            this._emitUndefined(); return;   // 未声明（宿主 lib 全局）→ undefined，勿抛断栈
        }
        this.m.localGet(idx);
    }
    // 变量写（含闭包捕获）：栈顶值 → 变量，并保留该值（赋值表达式结果）。
    // tmp 为捕获路径的暂存 local（默认 scratch）；调用点须保证其空闲。
    _emitVarStore(name, tmp) {
        const M = this.m;
        if (this.capMap.has(name)) {
            const t = tmp === undefined ? this.scratch : tmp;
            M.localSet(t);
            M.localGet(this.capMap.get(name)); M.i32Const(this._strId(name)); M.localGet(t); M.call("qz.env_set");
            M.localGet(t);
            return;
        }
        const idx = this._local(name);
        if (idx === undefined) {
            const g = this.moduleGlobals && this.moduleGlobals.get(name);
            if (g !== undefined) {                 // 模块级变量：写全局并保留值（赋值表达式结果，无需临时槽）
                M.globalSet(g); M.globalGet(g);
                return;
            }
            throw new Error("未定义变量: " + name);
        }
        M.localTee(idx);
    }
    // .length 计算（base 句柄在 local `base`）：字符串(0x7FFA) → qzs_utf16len（UTF-16 码元数）；
    // 数组(0x7FFB) → 结构首 i32（元素数）；其余 → qz.str_len（跨界）。
    _emitLengthOf(base) {
        const M = this.m;
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffan); M.i64Eq();
        M.ifBlock("i64");
        M.localGet(base); M.i32WrapI64(); M.call("qzs_utf16len"); M.f64ConvertI32U(); M.i64ReinterpretF64();
        M.else_();
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
        M.ifBlock("i64");
        M.localGet(base); M.i32WrapI64(); M.i32Load(2, 0); M.f64ConvertI32U(); M.i64ReinterpretF64();
        M.else_();
        M.localGet(base); M.call("qz.length_of");    // 宿主数组/宿主字符串句柄/POJO（物化 → JS .length）
        M.end(); M.end();
    }
    // 下标读 base[i]（base 句柄在 local `base`）：字符串键或非 wasm 数组 → 宿主 qz.get_index；
    // wasm 数组(0x7FFB) + 数值键 → 内存 dataOff + i*8（快路径）。
    _emitElemOf(base, idxExpr, keyLocal) {
        const M = this.m, t = this._expEnter();
        if (keyLocal !== undefined) { M.localGet(keyLocal); M.localSet(t.w); }   // 键已求值（rest 排除需复用同一值）
        else { this.emitTaggedExpr(idxExpr); M.localSet(t.w); }                 // 键
        M.localGet(t.w); this._emitIsStr();
        M.ifBlock("i64");
        M.localGet(base); M.localGet(t.w); M.call("qz.get_index");  // 字符串键 → 宿主
        M.else_();
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
        M.ifBlock("i64");                                           // wasm 数组 + 数值键
        this._emitInt32Safe(t.w);
        M.ifBlock("i64");
        M.localGet(t.w); M.f64ReinterpretI64(); M.i32TruncF64S(); M.localSet(t.a);
        M.localGet(t.a); M.localGet(base); M.i32WrapI64(); M.i32Load(2, 0); M.i32LtU();   // idx <u len（负数→巨大→假）
        M.ifBlock("i64");
        M.localGet(base); M.i32WrapI64(); M.i32Load(2, 8);
        M.localGet(t.a); M.i32Const(8); M.i32Mul(); M.i32Add(); M.i64Load(3, 0);
        { const th = this._expEnter(); M.localSet(th.v);                 // 洞 → undefined
          M.localGet(th.v); M.i64ConstBits(2, 0x7ff90000); M.i64Eq();
          M.ifBlock("i64"); this._emitUndefined(); M.else_(); M.localGet(th.v); M.end();
          this._expLeave(); }
        M.else_();
        this._emitUndefined();                                      // 越界 → undefined（JS 语义）
        M.end();
        M.else_();
        M.localGet(base); M.localGet(t.w); M.call("qz.get_index");   // NaN/超范围索引 → 宿主
        M.end();
        M.else_();
        M.localGet(base); M.localGet(t.w); M.call("qz.get_index");   // 非 wasm 数组（宿主数组/字符串/POJO/实例）
        M.end();
        M.end();
        this._expLeave();
    }
    // 属性读 base.a（接收者已求值于 local `base`）：宿主对象(0x7FFD) → object_get；
    // POJO(0x7FF9|off≥8)/类实例(0x7FFE|off) → 内存 load 且**越界（无此字段）→ undefined**；
    // 其余（数组/字符串/数字上的普通属性）→ undefined。
    // 当前函数的 this（i64）。方法体：local 0 = this；lambda（箭头继承）→ 捕获的 this 或 synthThis 形参槽。
    _emitThisReceiver() {
        const M = this.m;
        if (this.capMap && this.capMap.has("this")) { M.localGet(this.capMap.get("this")); M.i32Const(this._strId("this")); M.call("qz.env_get"); return; }
        const idx = this._local("this");
        if (idx !== undefined) { M.localGet(idx); return; }
        M.localGet(0);
    }

    _emitPropReadFromLocal(base, name) {
        const M = this.m;
        if (name === "stack") { M.localGet(base); M.call("qz.err_stack"); return; }   // Error 族 .stack → 宿主合成
        if (name === "constructor") {                    // 实例 .constructor → 类对象（JS 语义）；非实例退回宿主 prop_get
            M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffen); M.i64Eq();
            M.ifBlock("i64");
            M.localGet(base); M.i32WrapI64(); M.i32Load(2, 0); M.call("qz.class_value");   // 实例内存[0] = __cls
            M.else_();
            M.localGet(base); M.i32Const(this._strId(name)); M.call("qz.prop_get");
            M.end();
            return;
        }
        if (this._hasAccessor(name, "get") || this._hasMethodName(name)
            || /^(hasOwnProperty|isPrototypeOf|propertyIsEnumerable|toLocaleString|valueOf)$/.test(name)) {   // 含 Object.prototype 方法

            M.localGet(base); M.i32Const(this._strId(name)); M.call("qz.prop_get");
            this._emitErrCheck();        // getter 抛错 → 转入本函数 catch
            return;
        }
        const foff = this._fieldIndex(name);
        // 字符串/数组/纯数值：属性读 → 宿主（方法名返回绑定函数：truthy + 可调用；(1).toLocaleString 亦是函数）
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffan); M.i64Eq();
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
        M.i32Or();
        this._emitIsHandle(base); M.i32Eqz();
        M.i32Or();
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffdn); M.i64Eq();   // 宿主对象（类值/内建实例/Map/Set…）→ 走 prop_get
        M.i32Or();
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7fffn); M.i64Eq();   // 闭包值（函数）→ 自身属性 length/name/toString/call…
        M.i32Or();
        M.ifBlock("i64");
        M.localGet(base); M.i32Const(this._strId(name)); M.call("qz.prop_get");
        M.else_();
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffdn); M.i64Eq();
        M.ifBlock("i64");
        M.localGet(base); M.i32Const(this._strId(name)); M.call("qz.object_get");
        M.else_();
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ff9n); M.i64Eq();
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffEn); M.i64Eq();
        M.i32Or();
        M.ifBlock("i64");
        const t = this._expEnter();
        M.localGet(base); M.i32WrapI64(); M.localSet(t.a);
        M.localGet(t.a); M.i32Const(8); M.i32GeU();
        M.localGet(t.a); M.i32Load(2, 4); M.i32Const(foff + 8); M.i32GeU();
        M.i32And();
        M.ifBlock("i64");
        if (this.usesDynAcc || this.usesProto) { M.localGet(base); M.i32Const(this._strId(name)); M.call("qz.prop_get"); }   // usesProto：需原型链回落   // 访问器表（运行时 defineProperty）
        else { M.localGet(t.a); M.i64Load(3, foff); }
        M.else_();
        // 未赋值/越界/undefined|null：交宿主（POJO 未赋值 → undefined；undefined/null → TypeError）
        M.localGet(base); M.i32Const(this._strId(name)); M.call("qz.prop_get");
        M.end();
        this._expLeave();
        M.else_();
        this._emitUndefined();
        M.end();
        M.end();
        M.end();   // 关「str/arr 方法读取」外层 if
    }
    _countForOf(node) {
        let n = 0;
        const walk = (x) => { if (ts.isForOfStatement(x) || ts.isForInStatement(x)) n++; ts.forEachChild(x, walk); };
        walk(node);
        return n;
    }
    _countLoops(node) {
        let n = 0;
        const walk = (x) => {
            if (ts.isIterationStatement(x, false)) n++;
            ts.forEachChild(x, walk);
        };
        walk(node);
        return n;
    }
    /* 对象 rest + 计算键需要跨「读属性」与「建 rest」保存键值（键表达式只能求值一次）。
     * 这里按函数体静态数出最多需要多少个 i64 槽；发射期用 _reserveRestKeys 按嵌套层分配。 */
    _countRestComputedKeys(node) {
        if (!node) return 0;
        let n = 0;
        // 赋值式解构目标：`= 左侧`，或嵌套在另一个解构目标的属性值里。
        const isAssignTarget = (x) => {
            const p = x.parent;
            if (!p) return false;
            if (ts.isBinaryExpression(p) && p.left === x && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true;
            if (ts.isPropertyAssignment(p) && p.initializer === x) return isAssignTarget(p.parent);
            if (ts.isArrayLiteralExpression(p) && p.elements.includes(x)) return isAssignTarget(p);
            if (ts.isParenthesizedExpression(p) && p.expression === x) return isAssignTarget(p);
            return false;
        };
        const walk = (x) => {
            if (ts.isObjectBindingPattern(x) && x.elements.some(e => ts.isBindingElement(e) && e.dotDotDotToken)) {
                for (const e of x.elements) {
                    if (ts.isBindingElement(e) && !e.dotDotDotToken && e.propertyName && ts.isComputedPropertyName(e.propertyName)) n++;
                }
            }
            if (ts.isObjectLiteralExpression(x) && x.properties.some(p => ts.isSpreadAssignment(p)) && isAssignTarget(x)) {
                for (const p of x.properties) if (ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name)) n++;
            }
            ts.forEachChild(x, walk);
        };
        walk(node);
        return n;
    }
    // 形参解构也在函数体内发射，但节点不在 body 上；一并统计。
    _countRestComputedKeysIn(params, body) {
        let n = this._countRestComputedKeys(body);
        for (const p of (params || [])) if (p && p.name) n += this._countRestComputedKeys(p.name);
        return n;
    }
    _reserveRestKeys(n) {
        if (!n) return 0;
        const base = this._restKeyNext || 0;
        if (base + n > (this._restKeyCount || 0)) {
            throw new Error(`[tagged] 解构计算键嵌套超过预留槽（需要 ${base + n}，预留 ${this._restKeyCount || 0}）`);
        }
        this._restKeyNext = base + n;
        return base;
    }
    _releaseRestKeys(base) { this._restKeyNext = base; }


    // ++obj.a / obj.a-- / this.#v++：接收者求值一次 → 属性读 ±1 → 属性写回（宿主/POJO/访问器统一分派）。
    // prefix：表达式结果 = 新值；postfix：结果 = 旧值。
    _emitIncDecProp(operand, inc, kind) {
        const M = this.m, t = this._expEnter();
        const pname = ts.isPrivateIdentifier(operand.name) && this._curClass
            ? "#" + this._curClass + "#" + operand.name.text : operand.name.text;
        this.emitTaggedExpr(operand.expression); M.localSet(t.v);              // 接收者（一次求值）
        M.localGet(t.v); this._emitPropReadFromLocal(t.v, pname); M.localSet(t.w);   // 旧值
        M.localGet(t.w); M.i64ConstBits(...f64Bits(1));
        this.emitGuardedOp(inc ? "qz.add" : "qz.sub", inc ? M.f64Add : M.f64Sub);
        M.localSet(t.x);                                                       // 新值
        M.localGet(t.x);                                                       // 供存储
        this._emitStorePropValue(operand, t.v);                                // 写回（消费值、留新值）
        M.drop();
        if (kind === "prefix") M.localGet(t.x); else M.localGet(t.w);           // 结果
        this._expLeave();
        return true;
    }
    // 值在栈顶 → 写到 left.expression（接收者已在 local recvLocal）
    _emitStorePropValue(left, recvLocal) {
        const M = this.m, t = this._expEnter();
        M.localSet(t.w);                                    // 值
        const pname = ts.isPrivateIdentifier(left.name) && this._curClass
            ? "#" + this._curClass + "#" + left.name.text : left.name.text;
        M.localGet(recvLocal); M.localSet(t.v);             // 接收者
        // POJO(0x7FF9|off) / 类实例(0x7FFE|off) 且字段在实例尺寸内 → 直接内存 store。
        // 走宿主 qz.set_index 是每次 ~1µs 的跨界，`new C(); b.v = 1` 的热路径慢 300 倍的主因。
        // 越界或别的 tag（宿主对象/数组/字符串）仍回落宿主，语义不变。
        const foff = this._fieldIndex(pname);
        M.localGet(t.v); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ff9n); M.i64Eq();
        M.localGet(t.v); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffen); M.i64Eq();
        M.i32Or();
        M.localGet(t.v); M.i32WrapI64(); M.i32Const(8); M.i32GeU();
        M.i32And();
        M.localGet(t.v); M.i32WrapI64(); M.i32Load(2, 4); M.i32Const(foff + 8); M.i32GeU();
        M.i32And();
        M.ifBlock("void");
        M.localGet(t.v); M.i32WrapI64(); M.localGet(t.w); M.i64Store(3, foff);
        M.else_();
        M.localGet(t.v); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffdn); M.i64Eq();
        M.ifBlock("void");
        M.localGet(t.v); M.i32Const(this._strId(pname)); M.localGet(t.w); M.call("qz.object_set");
        M.else_();
        M.localGet(t.v); this._emitStrLitHandle(pname); M.localGet(t.w); M.call("qz.set_index");
        this._emitErrCheck(false);   // 冻结/不可扩展对象写入 → 抛 TypeError（转入 catch）
        M.end();
        M.end();
        M.localGet(t.w);
        this._expLeave();
    }
    // 调用点错误检查（try 内）：栈顶是调用结果 → 存入临时槽，__err≠0 则跳到最近的 $err；否则恢复结果。
    // 跨函数 throw 的落地点：被调函数设 __err 并正常返回，调用方在此转成异常路径。
    _emitErrCheck(keepValue = true) {
        const M = this.m, t = this._expEnter();
        if (keepValue) M.localSet(t.v);
        if (this._inModuleLink) {
            // C 侧原语抛的可捕获异常（reduce 空数组/冻结写入）存 g_throw_val，
            // 经 qz.take_err 取回写入 __err(global1)。仅在 __err 尚未被用户 throw
            // 设定时轮询——否则会覆盖用户已抛的值（user throw 直接 globalSet(1)）。
            M.globalGet(1); M.i64Eqz();
            M.ifBlock("void");
            M.call("qz.take_err"); M.globalSet(1);
            M.end();
        }
        M.globalGet(1); M.i64Eqz(); M.i32Eqz();                  // __err != 0 ?
        M.ifBlock("void");
        if (this._tryStack.length) {
            M.br((this.depth + 1) - this._tryStack[this._tryStack.length - 1].errBrk);   // +1：本 if 自身多一层 block
        } else {
            this._emitPendingFinally(true, false);                // 无 try → 跑完 finally 后立即向上返回
            if (!this._fnVoid) this._emitUndefined();
            M.return_();
        }
        M.end();
        if (keepValue) M.localGet(t.v);
        this._expLeave();
    }
    // 值调用：被调值求值到可重入槽 → 参数压栈 → qz.call_value（闭包 → closure_call；宿主函数 → 调用）
    // 第 6 参 = 溢出实参数组（args[3..]）：闭包形参 >4 时宿主按 meta.n 展开（本 ABI 仅 4 个实参槽）
    // o[Symbol.<wellknown>] ≡ o["@@<name>"]：类/对象字面量的 [Symbol.x] 成员在 this.classes 里登记为 @@<x>（物化时挂真 Symbol）。
    _symKeyName(expr) {
        if (!expr || !ts.isPropertyAccessExpression(expr) || !ts.isIdentifier(expr.expression) || expr.expression.text !== "Symbol") return null;
        const n = expr.name.text;
        return /^(iterator|asyncIterator|toPrimitive|toStringTag|hasInstance|isConcatSpreadable|species|match|replace|search|split|matchAll)$/.test(n) ? "@@" + n : null;
    };
    _emitValueCall(calleeExpr, args, recvExpr) {
        const M = this.m, t = this._expEnter();
        this.emitTaggedExpr(calleeExpr); M.localSet(t.v);
        M.localGet(t.v);
        for (let i = 0; i < 4; i++) {
            if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
        }
        if (args.length > 4) {
            const ovfNodes = args.slice(3);
            if (ovfNodes.some(a2 => ts.isSpreadElement(a2))) throw new Error("[tagged] 值调用的溢出实参与展开混用暂不支持");
            const litV = ts.factory.createArrayLiteralExpression(ovfNodes);
            litV.pos = args[0].pos; litV.end = args[args.length - 1].end;
            this.emitTaggedExpr(litV);
        } else this._emitUndefined();
        if (recvExpr) this.emitTaggedExpr(recvExpr); else this._emitUndefined();   // recv（普通调用 = undefined；字段/访问器取值调用 = receiver）
        M.call("qz.call_value");
        this._emitErrCheck();
        this._expLeave();
    }

    // 展开实参调用：实参合成一个数组（复用数组字面量展开路径），宿主按 callee 动态调用。
    _emitSpreadCall(e) {
        const M = this.m, t = this._expEnter();
        // 实参数组：createArrayLiteralExpression(e.arguments)（含 SpreadElement → 走 concat 折叠）
        const isStaticSpread = ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression) && this._isClassName(e.expression.expression);
        // 静态方法 ABI 为 (self, a0..a3)：实参数组前置 undefined 占位 self
        const elems = isStaticSpread ? [ts.factory.createIdentifier("undefined"), ...e.arguments] : e.arguments;
        const lit = ts.factory.createArrayLiteralExpression(elems);
        lit.pos = e.pos; lit.end = e.end;
        this.emitTaggedExpr(lit); M.localSet(t.v);
        // 剥掉纯语法包裹：(expr) / expr as T —— 只影响类型层，让分派看到真 callee
        // （zod：`(checks.regex as any)(...args)`）。
        let cx = e.expression;
        for (;;) {
            if (ts.isParenthesizedExpression(cx)) { cx = cx.expression; continue; }
            if (ts.isAsExpression(cx) || ts.isTypeAssertionExpression(cx) || ts.isNonNullExpression(cx)) { cx = cx.expression; continue; }
            break;
        }
        if (ts.isPropertyAccessExpression(cx) && ts.isIdentifier(cx.expression) && this._isClassName(cx.expression)) {
            // C.m(...args)：静态方法直调（导出名静态可知）
            let owner = this._className(cx.expression.text);
            const method = ts.isPrivateIdentifier(cx.name) ? "#" + this._className(cx.expression.text) + "#" + cx.name.text : cx.name.text;
            while (owner && !(this.classes.get(owner).staticMethods || []).some(s2 => s2.name === method)) owner = this.classes.get(owner).parent;
            if (!owner) {
                // 静态**字段**持函数（`static create = createZodEnum`）：属性值是闭包 →
                // 取类对象上的该属性后走 method_spread（实参数组已求值在 t.v）。
                let fo = this._className(cx.expression.text);
                while (fo && !(this.classes.get(fo).staticFields || []).some(s2 => s2.name === method)) fo = this.classes.get(fo).parent;
                if (!fo) throw new Error(`[tagged] 静态方法 ${cx.expression.text}.${method}() 未定义`);
                this._emitStaticsGuard(cx.expression.text);
                this.emitTaggedExpr(cx.expression); M.localSet(t.w);
                M.localGet(t.w); M.i32Const(this._strId(method)); M.localGet(t.v);
                M.call("qz.method_spread");
                this._emitErrCheck();
                this._expLeave();
                return;
            }
            this._emitStaticsGuard(cx.expression.text);
            M.i32Const(this._strId(staticMethName(owner, method))); M.localGet(t.v); M.i32Const(0);
            M.call("qz.call_named");
            this._expLeave();
            return;
        }
        if (ts.isPropertyAccessExpression(cx) && ts.isIdentifier(cx.expression) && BUILTIN_GLOBALS.has(cx.expression.text)) {
            M.i32Const(this._strId(cx.expression.text + "." + cx.name.text)); M.localGet(t.v);
            M.call("qz.builtin_spread");
            this._expLeave();
            return;
        }
        if (ts.isPropertyAccessExpression(cx)) {     // 动态接收者方法：obj.m(...args) → 宿主 method_spread（复用 method_call 分派）
            this.emitTaggedExpr(cx.expression); M.localSet(t.w);
            M.localGet(t.w); M.i32Const(this._strId(cx.name.text)); M.localGet(t.v);
            M.call("qz.method_spread");
            this._emitErrCheck();
            this._expLeave();
            return;
        }
        if (!ts.isIdentifier(cx)) throw new Error("[tagged] 展开实参仅支持顶层函数/闭包/静态方法/内建调用");
        const name = this._fnName(cx.text);
        if (this.m._funcIdx[name] !== undefined || this.fnNames.has(name)) {
            const isNum = !!(this._calleeInfo(cx.text) && this._calleeInfo(cx.text).mode === "num");
            const cp2 = this._calleeParams(cx.text) || this._calleeParams(name);
            const hasRest2 = !!(cp2 && cp2.length > 0 && cp2[cp2.length - 1].dotDotDotToken);
            if (hasRest2) {
                // rest 收尾：按形参表拆包（固定形参取元素、rest 取 slice）→ 直调（元数天然匹配）
                const nFix = cp2.length - 1;
                for (let i = 0; i < nFix; i++) this._emitElemOf(t.v, ts.factory.createNumericLiteral(i));
                M.localGet(t.v); M.i32Const(this._strId("slice"));
                M.i64ConstBits(...f64Bits(nFix)); this._emitUndefined(); this._emitUndefined(); this._emitUndefined();
                this._emitUndefined();   // ovf（实参 4..；当前恒 undefined，>4 形参支持后由调用点传入）
                M.call("qz.method_call");
                M.call(this._fnName(name));
                this._retFromCallee(cx.text);
                this._expLeave();
                return;
            }
            M.i32Const(this._strId(name)); M.localGet(t.v); M.i32Const(isNum ? 1 : 0);
            M.call("qz.call_named");
            this._expLeave();
            return;
        }
        // 闭包：句柄（局部或 env_get）→ closure_call_spread
        if (this.capMap.has(cx.text)) { M.localGet(this.capMap.get(cx.text)); M.i32Const(this._strId(cx.text)); M.call("qz.env_get"); M.localSet(t.w); }
        else if (this.moduleGlobals && this.moduleGlobals.get(cx.text) !== undefined) {
            M.globalGet(this.moduleGlobals.get(cx.text)); M.localSet(t.w);   // 模块级 const 持有闭包（展开调用此前漏查 → 未定义函数）
        }
        else {
            const hIdx = this._local(cx.text);
            if (hIdx === undefined) throw new Error("未定义函数: " + cx.text);
            M.localGet(hIdx); M.localSet(t.w);
        }
        // rest 收尾的闭包：实参数组即其唯一形参（其余槽 undefined）
        const cp3 = this._calleeParams(cx.text);
        const hasRest3 = !!(cp3 && cp3.length > 0 && cp3[cp3.length - 1].dotDotDotToken);
        M.localGet(t.w);
        if (hasRest3) {
            const nFix3 = cp3.length - 1;
            for (let i = 0; i < nFix3; i++) this._emitElemOf(t.v, ts.factory.createNumericLiteral(i));
            M.localGet(t.v); M.i32Const(this._strId("slice"));
            M.i64ConstBits(...f64Bits(nFix3)); this._emitUndefined(); this._emitUndefined(); this._emitUndefined();
            this._emitUndefined();   // ovf（实参 4..；当前恒 undefined，>4 形参支持后由调用点传入）
            M.call("qz.method_call");
            for (let i = cp3.length; i < 4; i++) this._emitUndefined();
            this._emitUndefined();                                    // recv（展开/可变调用：普通调用 = undefined）
            M.call("qz.closure_call");
        }
        else { M.localGet(t.v); M.call("qz.closure_call_spread"); }
        this._expLeave();
    }
    // 被调函数（已解析到 AST）是否以 rest 形参收尾 → 返回其形参数组，否则 null。
    _calleeParams(name) {
        const node = (this._fnNodes && this._fnNodes.get(name)) || null;
        return node ? node.parameters : null;
    }
    // 落栈实参：rest 收尾 → 固定参 + 打包数组；否则按元数补 undefined / 截断。
    _emitCallArgs(params, args, fnName, allowOverflow) {
        const M = this.m;
        const nPar = params.length;
        const hasRest = nPar > 0 && !!params[nPar - 1].dotDotDotToken;
        if (allowOverflow && nPar > 4) {
            for (let i = 0; i < 3; i++) {
                if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
            }
            const nFix = hasRest ? nPar - 1 : nPar;
            const ovfA = args.slice(3, nFix);
            while (ovfA.length < nFix - 3) ovfA.push(ts.factory.createVoidZero());
            if (hasRest) {
                const restArgs = args.slice(nFix);
                if (restArgs.some(a2 => ts.isSpreadElement(a2))) throw new Error(`[tagged] ${fnName} 的 rest 实参与展开混用暂不支持`);
                const rl = ts.factory.createArrayLiteralExpression(restArgs);
                rl.pos = args.length ? args[0].pos : 0; rl.end = args.length ? args[args.length - 1].end : 0;
                ovfA.push(rl);
            }
            if (ovfA.some(a2 => ts.isSpreadElement(a2))) throw new Error(`[tagged] ${fnName} 的溢出实参与展开混用暂不支持`);
            const litA = ts.factory.createArrayLiteralExpression(ovfA);
            litA.pos = args.length ? args[0].pos : 0; litA.end = args.length ? args[args.length - 1].end : 0;
            this.emitTaggedExpr(litA);
            return;
        }
        if (!hasRest) {
            for (let i = 0; i < nPar; i++) {
                if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
            }
            return;
        }
        const nFix = nPar - 1;
        for (let i = 0; i < nFix; i++) {
            if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
        }
        const rest = args.slice(nFix);
        if (rest.some(a2 => ts.isSpreadElement(a2))) throw new Error(`[tagged] ${fnName} 的 rest 实参与展开混用暂不支持`);
        const lit = ts.factory.createArrayLiteralExpression(rest);
        lit.pos = args.length ? args[0].pos : 0; lit.end = args.length ? args[args.length - 1].end : 0;
        this.emitTaggedExpr(lit);
    }

    // 闭包调用：closure_call(handle, a0..a3)。句柄先入可重入槽（参数求值可能嵌套闭包调用），
    // 再按「句柄在前、4 参压栈」顺序调用（参数求值用栈深度隔离，无需逐参临时）。
    _emitClosureCall(fn, args) {
        const M = this.m, t = this._expEnter();
        if (this.capMap.has(fn)) { M.localGet(this.capMap.get(fn)); M.i32Const(this._strId(fn)); M.call("qz.env_get"); M.localSet(t.v); }
        else {
            const hIdx = this._local(fn);
            // 导入的模块级闭包（`import { makeIssue } from './parseUtil.js'`，目标是
            // `export const makeIssue = (...) => ...`）：importAlias 指向目标名，值在 moduleGlobals。
            const aliasTgt = this.importAlias && this.importAlias.get(fn);
            const gKey = (this.moduleGlobals && this.moduleGlobals.get(fn) !== undefined) ? fn
                       : (aliasTgt !== undefined && this.moduleGlobals && this.moduleGlobals.get(aliasTgt) !== undefined) ? aliasTgt
                       : undefined;
            const gIdx = gKey !== undefined ? this.moduleGlobals.get(gKey) : undefined;
            if (hIdx === undefined && gIdx === undefined) throw new Error(BUILTIN_GLOBALS.has(fn)
                ? `[tagged] 内建 ${fn}() 未实现（AOT 仅编译用户代码 + qz.* 契约面）`
                : "未定义函数: " + fn);
            if (hIdx !== undefined) M.localGet(hIdx); else M.globalGet(gIdx);   // 模块级变量持闭包值
            M.localSet(t.v);
        }
        M.localGet(t.v);
        const cp0raw = this._calleeParams(fn) || (this.importAlias && this._calleeParams(this.importAlias.get(fn)));
        // 带 `this` 形参的被调：receiver 由宿主按 `synthThis` 约定前置（本处不占实参槽）
        const cp = (cp0raw && cp0raw.length && ts.isIdentifier(cp0raw[0].name) && cp0raw[0].name.text === "this") ? cp0raw.slice(1) : cp0raw;
        const needOvf = (cp === null && args.length > 3) || (cp !== null && cp.length > 4);   // >4 形参（含 rest）恒用溢出约定
        if (needOvf) {
            // 形参未知（变量/参数持闭包）或 >4 形参：a0..a3 = 实参 0..3，第 6 参 = 实参 3.. 数组（宿主按 meta.n 还原）
            for (let i = 0; i < 4; i++) {
                if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
            }
            const cpRest = cp !== null && cp.length > 0 && !!cp[cp.length - 1].dotDotDotToken;
            let ovfN;
            if (cpRest) {
                const nFixR = cp.length - 1;
                ovfN = args.slice(3, nFixR);
                while (ovfN.length < nFixR - 3) ovfN.push(ts.factory.createVoidZero());
                const restArgs = args.slice(nFixR);
                if (restArgs.some(a2 => ts.isSpreadElement(a2))) throw new Error("[tagged] 闭包调用的 rest 实参与展开混用暂不支持");
                const rl = ts.factory.createArrayLiteralExpression(restArgs);
                rl.pos = args.length ? args[0].pos : 0; rl.end = args.length ? args[args.length - 1].end : 0;
                ovfN.push(rl);
            } else {
                ovfN = args.slice(3);
            }
            if (ovfN.some(a2 => ts.isSpreadElement(a2))) throw new Error("[tagged] 闭包调用的溢出实参与展开混用暂不支持");
            const litK = ts.factory.createArrayLiteralExpression(ovfN);
            litK.pos = args.length ? args[0].pos : 0; litK.end = args.length ? args[args.length - 1].end : 0;
            this.emitTaggedExpr(litK);
            this._emitUndefined();                                    // recv（普通调用 = undefined）
            M.call("qz.call_value");
            this._emitErrCheck();
            this._expLeave();
            return;
        }
        if (cp) {
            this._emitMethodArgs(cp, args);        // 已知形参表：4 槽（含 rest 打包；>4 的 ovf 分支在上方 call_value 路径已处理）
        } else {
            for (let i = 0; i < 4; i++) {
                if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
            }
        }
        this._emitUndefined();                                        // recv（普通调用 = undefined）
        M.call("qz.closure_call");
        this._emitErrCheck();
        this._expLeave();
    }
    // JS `let`/`const` 循环绑定：闭包捕获循环变量时**每次迭代**一个新绑定。
    // 机制：迭代体开头 envRef = env_new(旧 env)，把（被捕获的）循环头变量按当前值 env_def 进新层；
    // 体内的 let/const 捕获名先 env_def 为 undefined（使声明写入本层而非上层）。
    _emitPerIterEnv(headerNames, bodyNames) {
        const M = this.m;
        if (this.envLocal === undefined) return;                 // 本函数无 env（未捕获）
        const t = this._expEnter();                                // t.a/t.b 为 i32（env 索引），t.v.. 为 i64
        M.localGet(this.envLocal); M.localSet(t.a);                // oldEnv 索引（保留，供读取旧值）
        M.localGet(t.a); M.call("qz.env_new"); M.i32WrapI64(); M.localSet(this.envLocal);   // 新一层（parent = oldEnv）
        for (const n of headerNames) {
            M.localGet(this.envLocal); M.i32Const(this._strId(n));
            M.localGet(t.a); M.i32Const(this._strId(n)); M.call("qz.env_get");
            M.call("qz.env_def");
        }
        for (const n of bodyNames) {
            M.localGet(this.envLocal); M.i32Const(this._strId(n)); this._emitUndefined(); M.call("qz.env_def");
        }
        this._expLeave();
    }
    // 循环体（含嵌套 lambda）捕获的、属于该循环作用域的变量名 → 需要每迭代新绑定。
    _loopCaptured(headerNames, body) {
        if (this.envLocal === undefined) return null;
        const lams = this._collectLambdas(body);
        if (!lams.length) return null;
        const bodyNames = this._collectLocals(body);
        const headerSet = new Set(headerNames), bodySet = new Set(bodyNames);
        const outH = [], outB = [];
        for (const lam of lams) for (const c of this._capturesOf(lam)) {
            if (headerSet.has(c) && !outH.includes(c)) outH.push(c);
            else if (bodySet.has(c) && !outB.includes(c)) outB.push(c);
        }
        if (!outH.length && !outB.length) return null;
        return { headerNames: outH, bodyNames: outB };
    }
    // 循环头声明的 let/const 名（for / for-of / for-in）；var 不参与每迭代绑定。
    _headerNames(node) {
        const out = [];
        const add = (l) => {
            if (!ts.isVariableDeclarationList(l)) return;
            if (l.flags & ts.NodeFlags.Let || l.flags & ts.NodeFlags.Const) {
                for (const d of l.declarations) for (const n of this._patternNames(d.name)) out.push(n);
            }
        };
        if (ts.isForStatement(node)) add(node.initializer);
        else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) add(node.initializer);
        return out;
    }

    // 绑定模式（含嵌套）里绑定的所有名字。
    _patternNames(pat, out = []) {
        if (ts.isIdentifier(pat)) { out.push(pat.text); return out; }
        if (ts.isArrayBindingPattern(pat) || ts.isObjectBindingPattern(pat)) {
            for (const el of pat.elements) {
                if (ts.isOmittedExpression(el)) continue;
                if (ts.isBindingElement(el)) this._patternNames(el.name, out);
            }
        }
        return out;
    }
    // 把 local `valLocal`(i64) 按绑定模式 pat 析构到各目标变量（含 rest / 默认值）。
    _emitDestructurePattern(pat, valLocal) {
        const M = this.m;
        if (ts.isArrayBindingPattern(pat)) {
            // 非 wasm 数组/字符串的可迭代（Set/Map/自定义 @@iterator/类实例）→ 迭代协议收集为数组
            // （JS 数组解构走 Iterator；此前直接按索引读 → 静默 undefined）
            M.localGet(valLocal); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
            M.localGet(valLocal); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffan); M.i64Eq();
            M.i32Or(); M.i32Eqz();
            M.ifBlock("void");
            M.localGet(valLocal); M.call("qz.iter_array"); M.localSet(valLocal);
            M.end();
            let i = 0;
            for (const el of pat.elements) {
                if (ts.isOmittedExpression(el)) { i++; continue; }
                if (!ts.isBindingElement(el)) continue;
                if (el.dotDotDotToken) {
                    M.localGet(valLocal); M.i32Const(this._strId("slice"));
                    M.i64ConstBits(...f64Bits(i)); this._emitUndefined(); this._emitUndefined(); this._emitUndefined();
                    this._emitUndefined();   // ovf（实参 4..；当前恒 undefined，>4 形参支持后由调用点传入）
                    M.call("qz.method_call");
                    this._emitBindingTarget(el.name);
                    i++; continue;
                }
                this._emitElemOf(valLocal, ts.factory.createNumericLiteral(i));
                if (el.initializer) this._emitDefaultIfUndef(el.initializer);
                this._emitBindingTarget(el.name);
                i++;
            }
            return;
        }
        if (ts.isObjectBindingPattern(pat)) {
            const hasRest = pat.elements.some(el => ts.isBindingElement(el) && el.dotDotDotToken);
            const restExcl = [];
            if (hasRest) {   // 仅含 rest 时需静态键名；计算键在 rest 建出后按保存的键值删除
                for (const el of pat.elements) {
                    if (!ts.isBindingElement(el) || el.dotDotDotToken) continue;
                    const nm = el.propertyName;
                    const k = nm
                        ? ((ts.isIdentifier(nm) || ts.isStringLiteral(nm) || ts.isNumericLiteral(nm)) ? nm.text : null)
                        : (ts.isIdentifier(el.name) ? el.name.text : null);
                    if (k !== null) restExcl.push(k);
                }
            }
            const nComputed = hasRest
                ? pat.elements.filter(el => ts.isBindingElement(el) && !el.dotDotDotToken && el.propertyName && ts.isComputedPropertyName(el.propertyName)).length
                : 0;
            const keyBase = hasRest ? this._reserveRestKeys(nComputed) : 0;
            let ci = 0;
            for (const el of pat.elements) {
                if (!ts.isBindingElement(el)) continue;
                if (el.dotDotDotToken) {
                    if (restExcl.length > 8) throw new Error("[tagged] 对象 rest 解构最多排除 8 个键");
                    const t = this._expEnter();
                    M.localGet(valLocal);
                    for (let i = 0; i < 8; i++) M.i32Const(i < restExcl.length ? this._strId(restExcl[i]) : -1);
                    M.call("qz.object_rest");
                    M.localSet(t.v);
                    for (let i = 0; i < ci; i++) {
                        M.localGet(t.v); M.localGet(this._restKeyBase + keyBase + i);
                        M.call("qz.delete_index"); M.drop();
                    }
                    M.localGet(t.v);
                    this._emitBindingTarget(el.name);
                    this._expLeave();
                    continue;
                }
                const key = el.propertyName
                    ? ((ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) || ts.isNumericLiteral(el.propertyName)) ? el.propertyName.text : null)
                    : (ts.isIdentifier(el.name) ? el.name.text : null);
                if (key === null) {
                    if (el.propertyName && ts.isComputedPropertyName(el.propertyName)) {   // 计算键名：o[expr]（运行期键）
                        if (hasRest) {
                            const keyLocal = this._restKeyBase + keyBase + ci++;
                            this.emitTaggedExpr(el.propertyName.expression); M.localSet(keyLocal);
                            this._emitElemOf(valLocal, null, keyLocal);
                        } else {
                            this._emitElemOf(valLocal, el.propertyName.expression);
                        }
                        if (el.initializer) this._emitDefaultIfUndef(el.initializer);
                        this._emitBindingTarget(el.name);
                        continue;
                    }
                    throw new Error("[tagged] 暂不支持该形式的解构属性名: " + ts.SyntaxKind[el.propertyName ? el.propertyName.kind : el.name.kind]);
                }
                this._emitPropReadFromLocal(valLocal, key);
                if (el.initializer) this._emitDefaultIfUndef(el.initializer);
                this._emitBindingTarget(el.name);
            }
            if (hasRest) this._releaseRestKeys(keyBase);
            return;
        }
        throw new Error("[tagged] 不支持的绑定模式");
    }
    // 形参序言：默认值（仅 undefined 触发，左→右）+ 解构形参。params[i] 原值在 local (base+i)。
    // 必须在「被捕获参数写 env」之前执行，使 env 见到最终值。
    _emitParamPrologue(params, base) {
        const M = this.m;
        for (let i = 0; i < params.length; i++) {
            const p = params[i];
            const idx = base + i;
            if (p.dotDotDotToken) {                       // rest 形参：调用方打包实参数组（未传 → 空数组）
                if (this.mode !== "tagged") throw new Error("[num] rest 形参不支持");
                M.localGet(idx); M.call("qz.is_undef");
                M.ifBlock("void");
                M.call("qz.empty_array"); M.localSet(idx);
                M.end();
            }
            if (p.initializer) {
                if (this.mode !== "tagged") throw new Error("[num] 形参默认值不支持（f64 ABI 无 undefined）");
                M.localGet(idx); M.call("qz.is_undef");
                M.ifBlock("void");
                this.emitTaggedExpr(p.initializer); M.localSet(idx);
                M.end();
            }
            if (!ts.isIdentifier(p.name)) {
                const t = this._expEnter();
                M.localGet(idx); M.localSet(t.v);
                this._emitDestructurePattern(p.name, t.v);
                this._expLeave();
            }
        }
    }

    // 由访问器/方法声明合成箭头函数节点（其体即闭包体 → 得到闭包句柄，供宿主 defineProperty 回调）。
    // 对象字面量 方法/访问器 → 合成箭头（缓存：捕获分析与发射必须用同一节点实例）
    _memberLambda(member) {
        this._synthLambdas = this._synthLambdas || new WeakMap();
        let f = this._synthLambdas.get(member);
        if (f) return f;
        const nm = member.name && member.name.text;
        if (ts.isMethodDeclaration(member)) {
            f = this._synthArrowWithParams("this", member.parameters, member.body);
            // 合成的形参表带原节点（默认值/解构/rest 均保留）；显式标出 rest 供 lamMeta.rest 与 ABI 打包使用
            const lp = member.parameters[member.parameters.length - 1];
            if (lp && lp.dotDotDotToken) f._qzRest = true;
        }
        else if (ts.isGetAccessorDeclaration(member)) f = this._synthArrow(["this"], member.body);
        else f = this._synthArrowWithParams("this", member.parameters, member.body);
        f._qzLitMethod = true;   // 对象字面量方法：super 指向字面量的 home object（运行时按 receiver 原型链解析）
        this._synthLambdas.set(member, f);
        return f;
    }
    _synthArrow(paramNames, body) {
        const ps = paramNames.map(n => ts.factory.createParameterDeclaration(undefined, undefined, ts.factory.createIdentifier(n), undefined, undefined, undefined));
        const ar = ts.factory.createArrowFunction(undefined, undefined, ps, undefined,
            ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), body);
        ar.pos = body.pos; ar.end = body.end;
        ar._qzSynthThis = paramNames.length > 0 && paramNames[0] === "this";   // 合成 self 形参（真实槽位）
        return ar;
    }
    // 同 _synthArrow，但形参沿用**原始** ParameterDeclaration 节点（保留默认值/解构/rest）。
    _synthArrowWithParams(selfName, params, body) {
        const self = ts.factory.createParameterDeclaration(undefined, undefined, ts.factory.createIdentifier(selfName), undefined, undefined, undefined);
        const ar = ts.factory.createArrowFunction(undefined, undefined, [self].concat(params), undefined,
            ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), body);
        ar.pos = body.pos; ar.end = body.end;
        ar._qzSynthThis = true;
        return ar;
    }

    // 解构默认值：栈顶值 === undefined 则替换为 init（JS 语义：仅 undefined 触发，null 不触发）。
    _emitDefaultIfUndef(init) {
        const M = this.m, t = this._expEnter();
        M.localSet(t.v);
        M.localGet(t.v); M.call("qz.is_undef");
        M.ifBlock("i64");
        this.emitTaggedExpr(init);
        M.else_();
        M.localGet(t.v);
        M.end();
        this._expLeave();
    }
    // 函数体内的**嵌套函数声明**（未提升）在该函数入口先建闭包存入其变量（JS 函数声明提升语义：
    // 声明前可调用、可相互递归）。返回闭包句柄逐个写入变量（含经 env 的捕获写）。
    // 本作用域（含块/if/for/try 内，JS 提升到函数作用域）的函数声明；不深入嵌套函数体。
    _collectScopeFnDecls(body, out = []) {
        const walk = (n) => {
            if (ts.isFunctionDeclaration(n)) { if (n.name && n.body && !(this.hoistedFns && this.hoistedFns.has(n))) out.push(n); return; }   // 无 body = TS 重载签名，无闭包可建
            if (ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)) return;
            if (ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)
                || ts.isConstructorDeclaration(n)) return;                    // 对象字面量方法体是独立作用域：其函数声明归该闭包，不属本函数
            ts.forEachChild(n, walk);
        };
        walk(body);
        return out;
    }
    _emitFnDeclClosures(body) {
        const M = this.m;
        this._fnVars = this._fnVars || new Set();
        for (const lam of this._collectScopeFnDecls(body)) {
            if (!lam.name) continue;
            this._fnVars.add(lam.name.text);
            this._fnNodes = this._fnNodes || new Map();
            this._fnNodes.set(lam.name.text, lam);
            this._emitLambdaNew(lam);                       // 栈：闭包句柄
            this._emitVarStore(lam.name.text, this.scratchB);
            M.drop();
        }
    }
    // 本函数体（含嵌套）所有 lambda 捕获的、属于本函数参数/局部的变量名（去重，稳定序）。
    _probeCaptured(body, paramNames, localNames) {
        const roots = Array.isArray(body) ? body : [body];
        const lams = [];
        for (const r2 of roots) if (r2) for (const l of this._collectLambdas(r2)) if (lams.indexOf(l) < 0) lams.push(l);
        if (!lams.length) return [];
        const own = new Set([...paramNames, ...localNames, "this"]);   // 方法的 this 亦可被箭头闭包捕获
        const out = [], seen = new Set();
        for (const lam of lams) for (const c of this._capturesOf(lam)) if (own.has(c) && !seen.has(c)) { seen.add(c); out.push(c); }
        return out;
    }
    // 填充 this._numArr（name → {base, len}）——用 standalone numArrNames(f)。
    _probeNumArrs(f) {
        for (const name of numArrNames(f)) this._numArr.set(name, {});
    }
    // 填充 this._inlineArrows（name → ArrowFunction）——零参数、返回 number、num-safe body。
    // funcMode 已验证安全；此处只扫描声明，不做重复安全检查。
    _probeInlineArrows(f) {
        this._inlineArrows = new Map();
        const walk = (n) => {
            if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)
                && n.initializer && ts.isArrowFunction(n.initializer)
                && n.initializer.parameters.length === 0
                && n.initializer.type && n.initializer.type.kind === ts.SyntaxKind.NumberKeyword)
                this._inlineArrows.set(n.name.text, n.initializer);
            if (ts.isArrowFunction(n) || ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) return;
            ts.forEachChild(n, walk);
        };
        if (f.body) walk(f.body);
    }
    emitFunc(f) {
        // 多文件编译：em.sf 由 compileTS 按「本函数所属源文件」设置（行号/DWARF 用）。
        const savedCurClass = this._curClass, savedCapActive = this.capListActive, savedStatic = this._staticVars;
        const savedFnVars = this._fnVars; this._fnVars = new Set();   // 本函数的「持有闭包的变量」集合
        const savedFnNodes = this._fnNodes; this._fnNodes = new Map(savedFnNodes || []);
        const savedBody = this._curBody; this._curBody = f.body;
        const savedVoid = this._fnVoid;
        this._assertNotAsync(f, `顶层函数 ${f.name.text}`);
        if (f.body) this._assertNoTDZ(f.body, f.parameters);
        const isVoid = !!f.type && f.type.kind === ts.SyntaxKind.VoidKeyword;
        this._fnVoid = isVoid;
        this._inModInit = f.name !== undefined && f.name.text === "__module_init";
        this.mode = this._inModInit ? "tagged" : funcMode(f);   // 模块初始化：值恒 tagged（模块级名字是 i64 全局）
        // num 值 = f64；tagged 值 = i64（NaN-box，32/64 位统一）
        const vt = this.mode === "num" ? "f64" : "i64";
        const locals = this._collectLocals(f.body);
        for (const p of f.parameters) {                                  // 解构形参的绑定名也要有 local
            if (ts.isIdentifier(p.name)) continue;
            for (const n of this._patternNames(p.name)) if (!locals.includes(n)) locals.push(n);
        }
        this._inStaticMethod = false;
        this._lamThisParam = f.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === "this");   // 顶层函数：`this` 形参是 TS 注解（不占实参槽）
        const nLoc = f.parameters.length + locals.length;
        this.scratch = nLoc;                                 // scratch（后缀 ++/--）
        this.scratchA = nLoc + 1;                            // 暂存 a
        this.scratchB = nLoc + 2;                            // 暂存 b
        // tagged guard 快路径需 f64 浮点临时（值 local 是 i64）；num 模式 scratchA/B 本就是 f64
        // num 数组：const a: number[] = []，用 bump 堆连续块 + i32 base/len local，
        // push/[i]/[i]=/.length 全内联 f64.load/store，零宿主往返。
        // 只在 num 模式启用；分析器找声明 + 仅用于 push/下标/length 的变量。
        this._numArr = new Map();
        if (this.mode === "num") { this._probeNumArrs(f); this._probeInlineArrows(f); }
        const numArrDecls = [];
        for (const [name] of this._numArr) numArrDecls.push("i32", "i32");
        const extra = this.mode === "tagged" ? ["f64", "f64"] : [];
        this.scratchFA = nLoc + 3; this.scratchFB = nLoc + 4;
        // 字符串逻辑临时（仅 tagged）：sT0..sT7 共 8 个 i32
        const sT = this.mode === "tagged" ? Array.from({ length: 40 }, () => "i32") : [];
        this.sT = this.mode === "tagged" ? Array.from({ length: 40 }, (_, i) => nLoc + 5 + i) : null;
        // 嵌套对象字面量的句柄临时槽（i64）：每层独立，避免内层覆盖外层句柄。
        const objPool = this.mode === "tagged" ? Array.from({ length: 48 }, () => "i64") : [];
        this.objBase = nLoc + 3 + extra.length + sT.length;
        this._objDepth = 0;
        // 对象 rest + 计算键的键值槽（i64，仅 tagged）：按函数体内最大并发数静态分配。
        const nRestKeys = this.mode === "tagged" ? this._countRestComputedKeysIn(f.parameters, f.body) : 0;
        const restKeyPool = Array.from({ length: nRestKeys }, () => "i64");
        this._restKeyBase = this.objBase + objPool.length;
        this._restKeyCount = nRestKeys;
        this._restKeyNext = 0;
        // 尾部追加：sT(8×i32，tagged) + swIdx(i32) + forOf 对×(vt,i32)（每嵌套层独立）。
        this.swIdx = this.objBase + objPool.length + nRestKeys;
        const nForOf = this._countForOf(f.body);
        this.forOfBase = this.swIdx + 1;
        this.forOfCount = 0;
        const forOfLocals = [];
        for (let i = 0; i < nForOf; i++) forOfLocals.push(vt, "i32", "i32");
        // 闭包保留槽（仅 tagged）：cloHandle(i64 存闭包句柄) + cloOff/cloBlk/cloFn(3×i32)。
        const cloSlots = this.mode === "tagged" ? ["i64", "i32", "i32", "i32", "i64", "i64", "i64", "i64"] : [];
        this.cloHandle = this.swIdx + 1 + nForOf * 3;
        this.cloOff = this.cloHandle + 1; this.cloBlk = this.cloHandle + 2; this.cloFn = this.cloHandle + 3;
        this.cloArgs = [this.cloHandle + 4, this.cloHandle + 5, this.cloHandle + 6, this.cloHandle + 7];
        this.scratchObj = this.cloArgs[3] + 1;                 // ++/-- 成员接收者句柄临时（i64）
        // 循环 arena 回滚槽（仅 tagged）：每个嵌套循环层一个 i32，存循环入口的 bump 值。
        // 深度按最外层循环嵌套数静态上界；不足时（极少见）退回不复位。
        const nLoopSave = this.mode === "tagged" ? this._countLoops(f.body) + 1 : 0;
        const loopSaveDecls = new Array(nLoopSave).fill("i32");
        this._loopSaveBase = this.scratchObj + 1;
        this._loopSaveCount = nLoopSave;
        this._loopSaveDepth = 0;
        // 函数级 arena 回滚槽（仅 tagged）：一个 i32 存函数入口的 bump；返回类型是标量且
        // 函数体内分配不逃逸时，在每个 return 前复位（见 _fnArenaFree）。
        this._fnArenaFreeThis = this.mode === "tagged" && this._fnArenaFree(f);
        const fnArenaDecls = this._fnArenaFreeThis ? ["i32"] : [];
        this._fnArenaSlot = this.scratchObj + 1 + nLoopSave;
        this.cloSlotsLen = cloSlots.length;
        // debug：局部名数组（参数在前、局部在后，与 wasm local 序号一致）；仅命名可见变量，合成槽留空。
        const localNames = this.m.debug
            ? f.parameters.map(p => p.name.text).concat(locals)   // locals 是名字数组
            : null;
        // 闭包共享环境：本函数被（直接/嵌套）lambda 捕获的局部/参数 → 统一住宿主对象（env），闭包与本体共享。
        // `arguments`（本函数自有）也可能被嵌套箭头捕获 → 视作可捕获名（JS：箭头继承外层 arguments）。
        const needsArgs0 = this.mode === "tagged" && !!(this._fnArgs && f.name && this._fnArgs.has(f.name.text));
        const ownCapNames = f.parameters.map(p => p.name.text).concat(needsArgs0 ? ["arguments"] : []);
        const capNames = this.mode === "tagged"
            ? this._probeCaptured(f.body, ownCapNames, locals) : [];
        const envDecls = capNames.length ? ["i32"] : [];
        const decls = locals.map(() => vt).concat([vt, vt, vt]).concat(extra).concat(sT).concat(objPool).concat(restKeyPool)
            .concat(["i32"]).concat(forOfLocals).concat(cloSlots).concat(["i64"]).concat(loopSaveDecls).concat(fnArenaDecls).concat(needsArgs0 ? ["i64"] : []).concat(envDecls).concat(numArrDecls);
        // num 数组的 base/len local 索引（一对 i32/名字）
        {
            let base = f.parameters.length + decls.length - numArrDecls.length;
            for (const [name] of this._numArr) { this._numArr.get(name).base = base; this._numArr.get(name).len = base + 1; base += 2; }
        }
        this._argsLocal = needsArgs0 ? f.parameters.length + decls.length - 1 - envDecls.length : undefined;
        this.m.startBody(f.name.text, decls, localNames, this._line(f));
        this.envLocal = capNames.length ? f.parameters.length + decls.length - 1 : undefined;   // 参数在 local 0..n-1 之后
        this.capMap = new Map(capNames.map(n => [n, this.envLocal]));   // 捕获名 → 所在 env 的 i32 local
        this.envRef = this.envLocal;
        if (needsArgs0) { const MA = this.m; MA.globalGet(this._argGlobal); MA.localSet(this._argsLocal); this.varMap.set("arguments", this._argsLocal); }
        if (capNames.length) {
            const M = this.m;
            M.i32Const(-1); M.call("qz.env_new"); M.i32WrapI64(); M.localSet(this.envLocal);   // 根环境（parentIdx=-1）
        }
        // 参数 → local 0..n-1；局部 → n..
        f.parameters.forEach((p, i) => this.varMap.set(p.name.text, i));
        locals.forEach((n, i) => this.varMap.set(n, f.parameters.length + i));
        if (this.mode === "tagged") { this.m.i64Const(0n); this.m.globalSet(1); }   // 入口清 __err（跨函数 throw 标志）
        this._emitParamPrologue(f.parameters, 0);                        // 默认值 / 解构形参（先于写 env）
        if (capNames.length) {
            // 被捕获的参数初值写入 env（局部由声明语句经 _emitVarStore 写入）
            for (const pn of capNames) {                        // 仅形参（含解构形参绑定名）：局部由声明语句写
                const idx = this._local(pn);
                if (idx !== undefined && idx < f.parameters.length) {
                    this.m.localGet(this.envLocal); this.m.i32Const(this._strId(pn)); this.m.localGet(idx); this.m.call("qz.env_set");
                }
            }
            if (needsArgs0 && capNames.includes("arguments")) {   // 嵌套箭头读 arguments → 从本函数 env 取全量实参数组
                this.m.localGet(this.envLocal); this.m.i32Const(this._strId("arguments")); this.m.localGet(this._argsLocal); this.m.call("qz.env_set");
            }
        }
        this.depth = 0; this.labels = [];
        this._staticVars = this.mode === "tagged" ? this._computeStaticVars(f.body, f.parameters.map(p => p.name.text)) : new Map();
        if (this._fnArenaFreeThis) { this.m.globalGet(0); this.m.localSet(this._fnArenaSlot); }
        if (this.mode === "tagged") { this._emitFnDeclClosures(f.body); this.emitTaggedBlock(f.body); }
        else this.emitBlock(f.body);
        // 末尾非 return 且函数有返回值 → fallthrough 路径缺值（穷尽 switch/if-else 全 return）。
        // 合法代码不会到达；补 unreachable 满足 wasm 验证。
        // tagged：落空函数体 → return undefined（JS 语义；此前补 unreachable，合法代码 function f(){} 直接 trap）。
        const fLast = f.body.statements[f.body.statements.length - 1];
        if (this.mode === "tagged") { this._emitUndefined(); this.m.return_(); }
        else if (!isVoid && !(fLast && ts.isReturnStatement(fLast))) this.m.unreachable();
        this.m.endBody();
        this.m.exportFn(f.name.text, f.name.text);
        this.varMap.clear();
        this._curClass = savedCurClass; this.capListActive = savedCapActive; this._staticVars = savedStatic;
        this._fnVars = savedFnVars; this._fnNodes = savedFnNodes; this._curBody = savedBody; this._fnVoid = savedVoid;
    }


    // async 函数/箭头/方法在 wasm 里无法表达「挂起 → 恢复」（需 CPS 或状态机）。顶层 async 函数已由
    // compileTS 自动转 interp（原生 async/await 由宿主 Promise 提供）；其余形态无 interp 通道 →
    // 编译期显式报错，绝不静默 strip 成同步函数（await 作 identity 会把 Promise 句柄当值传出）。
    _assertNotAsync(node, what) {
        if (node && node.modifiers && node.modifiers.some(x => x.kind === ts.SyntaxKind.AsyncKeyword)) {
            throw new Error(`[tagged] ${what} 为 async：wasm 无法表达挂起/恢复（仅顶层 async 函数可自动转 interp 运行）`);
        }
    }
    // TDZ（let/const 声明前的读）无运行期表示：值只是普通 local/全局，前置读得 undefined
    // 或上一轮残留值 —— 静默错值。TDZ 只在控制流真能到达时抛，静态可达性判定要整条 CFG，
    // 这里用保守判据：**同一函数体内、声明之前的语句里**出现对该名的裸读就报错。
    // 合法的「函数声明提升后再引用 let」不受影响（引用位于函数体内 = 未在收集范围）。
    _assertNoTDZ(body, params) {
        const seen = new Set((params || []).map(p => p.name && p.name.text).filter(Boolean));
        const refs = (st) => {                       // 语句内对该层的裸名引用（不下探嵌套函数体）
            const out = [];
            const w = (n) => {
                if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
                if (ts.isIdentifier(n)) { out.push(n); return; }
                ts.forEachChild(n, w);
            };
            w(st);
            return out;
        };
        // 声明语句索引：符号 → 所在语句序号（同一个 let/const 绑定只认它自己的符号；
        // 同名遮蔽/属性名/getter 名各有不同符号，按文本比会误报）
        const ck = this.checker;
        const declAt = new Map();
        const stmts = (body && body.statements) || [];
        stmts.forEach((st, i) => {
            if (!ts.isVariableStatement(st)) return;
            if ((st.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) return;
            for (const d of st.declarationList.declarations) {
                const sym = ck && ck.getSymbolAtLocation(d.name);
                if (sym && !declAt.has(sym)) declAt.set(sym, i);
            }
        });
        if (!declAt.size) return;
        const check = (ids, limit) => {
            for (const id of ids) {
                const sym = ck && ck.getSymbolAtLocation(id);
                if (!sym) continue;
                const at = declAt.get(sym);
                if (at === undefined || at < limit) continue;      // 不是本层这个 let/const 绑定，或已声明
                const pos = this.sf && this.sf.getLineAndCharacterOfPosition
                    ? this.sf.getLineAndCharacterOfPosition(id.getStart ? id.getStart() : (id.pos || 0)) : null;
                throw new Error(`[tagged] TDZ：'${id.text}' 在 let/const 声明前被读取${pos ? `（第 ${pos.line + 1} 行）` : ""} —— 暂存死区（声明前访问）未实现`);
            }
        };
        stmts.forEach((st, i) => {
            if (ts.isVariableStatement(st)) {
                for (const d of st.declarationList.declarations) {
                    if (d.initializer) check(refs(d.initializer), i);   // 同句内自引用 `const a = a` 在此报
                }
            } else check(refs(st), i);
        });
    }

    // ---------- 闭包（lambda 提升 + 捕获 cell）----------
    // 每个箭头/函数表达式提升为一个 wasm 函数 __lam_N。签名 = (blk:i32, 参数…i64) -> i64。
    // 捕获变量存在堆 cell 块（blk 指向 [i64 × captures]，对象布局），读经 capMap、写回 store。
    emitLambda(lam, id) {
        const fname = "__lam_" + id;
        this._assertNotAsync(lam, `闭包 ${fname}`);
        // 带 `this` 形参的用户函数表达式：`this` 走**真实槽位**（local 1，紧接 blk），receiver 由调用方
        // 按 `synthThis` 约定传入（普通调用 = undefined，与 JS 一致）。
        const hasThisParam0 = lam.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === "this");
        const thisSlot = !!lam._qzSynthThis || hasThisParam0;
        const skipThis = !thisSlot;
        const astParams = lam.parameters.filter(p => !(skipThis && ts.isIdentifier(p.name) && p.name.text === "this"));
        const params = astParams.map(p => p.name.text);
        // 捕获名先分析并记录（emitLambdaBody 内 identifier 读写用 capMap 路由）
        const caps = this._capturesOf(lam);
        // 所属类（箭头内的 super = 继承外层方法的 super 绑定）：按 pos/end 包含判定，不依赖 parent 指针。
        // 合成箭头（对象字面量方法，synthThis）不参与：其 super 指向字面量的 home object，不是外层类。
        let supCtx = null;
        if (!thisSlot) {
            for (const cn0 of this._classList) {
                const c0 = this.classes.get(cn0);
                if (!c0) continue;
                const nodes0 = [c0.ctor].concat((c0.methods || []).map(m => m.node)).concat(((c0.staticMethods || []).map(m => m.node)));
                if (nodes0.some(n0 => n0 && n0.pos <= lam.pos && lam.end <= n0.end)) { supCtx = cn0; break; }
            }
        }
        lam._qzSupCtx = supCtx;
        /* 表槽提前分配：闭包值在**调用方**函数体发射时就要写入槽号，而蹦床
         * 是在被调 lambda 的函数体发射末尾才生成——顺序上更晚。故此处先占号，
         * 蹦床生成时复用同一槽。 */
        /* 蹦床表槽仅为 in-module 档分配：共享 funcref 表由 libqzvm 导出。
         * 独立档（JS 宿主）没有表，闭包值按原路径写 funcidx（见 _emitLambdaNew
         * 的 tableSlot===undefined 回退）。*/
        let slot0;
        if (this._inModuleLink) {
            this._trampSlots = this._trampSlots || new Map();
            const tn0 = fname + "$t";
            slot0 = this._trampSlots.get(tn0);
            if (slot0 === undefined) { slot0 = INMOD_TABLE_CAP + this._trampSlots.size; this._trampSlots.set(tn0, slot0); }
        }
        this._lamById.set(lam, { id, fname, caps, n: params.length, tableSlot: slot0,
                                 rest: !!(lam._qzRest || (astParams.length && astParams[astParams.length - 1].dotDotDotToken)), synthThis: thisSlot });
        /* body 签名封顶 4 形参 + 可选 ovf 槽（>4 形参时第 6 槽 = 实参 3.. 数组），
         * 与类方法 _mEnter 同模式：body 内 _emitOvfParamUnpack 解包到预留 local。
         * 蹦床签名对齐 body，避免 arity 不匹配的 wasm 验证失败。 */
        this.m.declareFunc(fname, ["i32"].concat(Array.from({ length: Math.min(params.length, 4) }, () => "i64"))
            .concat(params.length > 4 ? ["i64"] : []), ["i64"]);
        this._pendingLambdas.push({ lam, fname, params, caps, astParams });
        return { fname, caps };
    }

    // 静态检测：lambda 写捕获变量且外层也访问 → 未实现共享环境会静默错值 → 编译期报错（loud）。
    // 外层「访问」= f.body 中非 lambda 内对 cap 名的读/写标识符；lambda「写」= body 内赋值/自增/复合/||=/??= 的左值为 cap。
    _closureWriteConflict(f, lams) {
        if (!lams.length) return null;
        const paramSet = new Set(f.parameters.map(p => p.name.text));
        const locSet = new Set(this._collectLocals(f.body));
        const isOuterVar = (n) => paramSet.has(n) || locSet.has(n);
        const capSet = new Set();
        for (const lam of lams) for (const c of this._capturesOf(lam)) if (isOuterVar(c)) capSet.add(c);
        if (!capSet.size) return null;
        const outerRefs = new Set();
        const walkOuter = (n, inLambda) => {
            if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) { ts.forEachChild(n, (c) => walkOuter(c, true)); return; }
            if (!inLambda && ts.isIdentifier(n)) {
                if (n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) return;
                if (n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name === n) return;
                if (n.parent && ts.isVariableDeclaration(n.parent) && n.parent.name === n) return;   // 声明绑定非「访问」
                if (n.parent && ts.isParameter(n.parent) && n.parent.name === n) return;
                if (capSet.has(n.text)) outerRefs.add(n.text);
                return;
            }
            ts.forEachChild(n, (c) => walkOuter(c, inLambda));
        };
        walkOuter(f.body, false);
        const lamWrites = new Set();
        const WRITE_OPS = [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
            ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
            ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
            ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
            ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken];
        for (const lam of lams) {
            const w = (n) => {
                if (ts.isBinaryExpression(n) && ts.isIdentifier(n.left) && WRITE_OPS.indexOf(n.operatorToken.kind) >= 0
                    && capSet.has(n.left.text)) lamWrites.add(n.left.text);
                if ((ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) && ts.isIdentifier(n.operand)
                    && capSet.has(n.operand.text)) lamWrites.add(n.operand.text);
                ts.forEachChild(n, w);
            };
            w(lam.body);
        }
        for (const name of lamWrites) if (outerRefs.has(name)) return name;
        return null;
    }
    // 发射已登记的 lambda 体（阶段2，在所有顶层函数之后；签名已登记）
    emitLambdaBodies() {
        for (const p of this._pendingLambdas) this._emitLambdaBody(p);
        this._pendingLambdas = [];
    }
    _emitLambdaBody({ lam, fname, params, caps, astParams }) {
        const M = this.m;
        const savedMap = this.varMap, savedCap = this.capMap, savedBlk = this.blkLocal;
        const savedMode = this.mode, savedDepth = this.depth, savedStatic = this._staticVars;
        const savedEnvRef = this.envRef;
        const savedCCO3 = this._curClassObj, savedCC3 = this._curClass;   // 箭头内 super/私有名需外层类上下文
        const savedLitM = this._inLitMethod;
        this._inLitMethod = !!lam._qzLitMethod;
        this._curClassObj = (lam._qzSupCtx && this.classes.get(lam._qzSupCtx)) || null;
        this._curClass = lam._qzSupCtx || null;   // 私有名限定（this.#x）在嵌套闭包内也需所属类名
        const savedFnVars2 = this._fnVars; this._fnVars = new Set();
        this.mode = "tagged";
        this._fnVoid = false;                                  // lambda 恒返回 i64
        // locals：用户局部（i64）+ scratch 系列同 emitFunc tagged 布局
        this._inStaticMethod = false;
        const thisSlotB = lam.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === "this");
        this._lamThisParam = !(lam._qzSynthThis || thisSlotB) && thisSlotB;   // 用**原始**形参表（astParams 已剔除 this 注解）   // 仅**用户**写的 this 注解形参 → 运行时 this = undefined
        const locals = this._collectLocals(lam.body);
        for (const p of lam.parameters) if (!ts.isIdentifier(p.name)) for (const n of this._patternNames(p.name)) if (!locals.includes(n)) locals.push(n);
        const wasmParams = params.slice(0, 4).concat(params.length > 4 ? ["$ovf"] : []);
        for (let i2 = 4; i2 < params.length; i2++) locals.unshift("$ovfArg" + (i2 - 4));
        const nParams = 1 + wasmParams.length;                 // blk + 封顶 4 参 + 可选 ovf
        const nLoc = nParams + locals.length;
        this.varMap = new Map();
        (astParams || lam.parameters).forEach((p, i) => { if (ts.isIdentifier(p.name)) this.varMap.set(p.name.text, i < 4 ? 1 + i : nParams + (i - 4)); });   // 已剔除 TS `this` 注解形参
        locals.forEach((n, i) => this.varMap.set(n, nParams + i));
        this.capMap = new Map();
        for (const n of caps) this.capMap.set(n, 0);        // 外层捕获名 → 创建方 env 索引（= blk 参数 local 0）
        this._lamSelf = (!lam._qzSynthThis && lam._qzSelfName)
            ? { name: lam._qzSelfName, fname, n: params.length, rest: !!(lam._qzRest || (astParams.length && astParams[astParams.length - 1].dotDotDotToken)) } : null;   // 自递归直调（blk:i32 + n×i64）
        this.blkLocal = 0;                                 // local 0 = env 索引（创建方环境）
        this.scratch = nLoc;
        this.scratchA = nLoc + 1;
        this.scratchB = nLoc + 2;
        const extra = ["f64", "f64"];
        this.scratchFA = nLoc + 3; this.scratchFB = nLoc + 4;
        const sT = Array.from({ length: 40 }, () => "i32");
        this.sT = Array.from({ length: 40 }, (_, i) => nLoc + 5 + i);
        const objPool = Array.from({ length: 48 }, () => "i64");
        this.objBase = nLoc + 3 + extra.length + sT.length;
        this._objDepth = 0;
        const nRestKeys = this._countRestComputedKeysIn(lam.parameters, lam.body);
        const restKeyPool = Array.from({ length: nRestKeys }, () => "i64");
        this._restKeyBase = this.objBase + objPool.length;
        this._restKeyCount = nRestKeys;
        this._restKeyNext = 0;
        this.swIdx = this.objBase + objPool.length + nRestKeys;
        const nForOf = this._countForOf(lam.body);
        this.forOfBase = this.swIdx + 1;
        this.forOfCount = 0;
        const forOfLocals = [];
        for (let i = 0; i < nForOf; i++) forOfLocals.push("i64", "i32", "i32");
        const cloSlots = ["i64", "i32", "i32", "i32", "i64", "i64", "i64", "i64"];
        this.cloHandle = this.swIdx + 1 + nForOf * 3;
        this.cloOff = this.cloHandle + 1; this.cloBlk = this.cloHandle + 2; this.cloFn = this.cloHandle + 3;
        this.cloArgs = [this.cloHandle + 4, this.cloHandle + 5, this.cloHandle + 6, this.cloHandle + 7];
        this.scratchObj = this.cloArgs[3] + 1;
        this._fnArenaFreeThis = false;      // lambda 体布局与 emitFunc 不同，不复位
        this._loopSaveBase = this.scratchObj + 1; this._loopSaveCount = this._countLoops(lam.body) + 1; this._loopSaveDepth = 0;
        const lamLoopSaveDecls = new Array(this._loopSaveCount).fill("i32");
        // 本 lambda 的局部若被（嵌套）lambda 捕获 → 建自身 env（__parent 链到 blk）
        // 箭头不自建 arguments（JS：继承外层函数的）；合成 self 形参的箭头源自方法/函数表达式 → 自有。
        const lamNeedsArgs = (!ts.isArrowFunction(lam) || !!lam._qzSynthThis) && usesArguments(lam.body);
        lam._qzNeedsArgs = lamNeedsArgs;
        const ownCap = this._probeCaptured(lam.body, lamNeedsArgs ? params.concat(["arguments"]) : params, locals);
        const envDecls = ownCap.length ? ["i32"] : [];
        const bodyLocals = locals.map(() => "i64").concat(["i64", "i64", "i64"]).concat(extra).concat(sT).concat(objPool).concat(restKeyPool)
            .concat(["i32"]).concat(forOfLocals).concat(cloSlots).concat(["i64"]).concat(lamLoopSaveDecls).concat(lamNeedsArgs ? ["i64"] : []).concat(envDecls);
        this._argsLocal = lamNeedsArgs ? (1 + params.length) + bodyLocals.length - 1 - envDecls.length : undefined;
        const localNames = this.m.debug ? ["blk"].concat(params).concat(locals) : null;
        M.startBody(fname, bodyLocals, localNames);
        this.envLocal = ownCap.length ? (1 + params.length) + bodyLocals.length - 1 : undefined;   // blk+参数之后
        this.envRef = ownCap.length ? this.envLocal : this.blkLocal;   // 嵌套 lambda 的 env：自身 env（链到 blk）或直接 blk
        M.i64Const(0n); M.globalSet(1);                     // 入口清 __err
        if (lamNeedsArgs) { M.globalGet(this._argGlobal); M.localSet(this._argsLocal); this.varMap.set("arguments", this._argsLocal); }
        /* 形参 0..3 走 wasm 参数槽；形参 4.. 由 _emitOvfParamUnpack 从 $ovf 槽解包
         * 到 $ovfArg* local（>4 形参时前 4 个按 prologue 处理，其余走 ovf）。 */
        const ap = astParams || lam.parameters;
        this._emitParamPrologue(ap.slice(0, 4), 1);
        const thisParamOff = (lam._qzSynthThis || lam.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === "this")) ? 1 : 0;
        this._emitOvfParamUnpack(ap, wasmParams, thisParamOff);
        if (ownCap.length) {
            M.localGet(0); M.call("qz.env_new"); M.i32WrapI64(); M.localSet(this.envLocal);   // parent = blk(0)
            for (const n of ownCap) this.capMap.set(n, this.envLocal);
            for (const n of ownCap) {                            // 仅形参（解构形参绑定名由序言析构后再写）
                const idx = this._local(n);
                if (idx !== undefined && idx < 1 + params.length) { M.localGet(this.envLocal); M.i32Const(this._strId(n)); M.localGet(idx); M.call("qz.env_set"); }
            }
            if (lamNeedsArgs && ownCap.includes("arguments")) {  // 本 lambda 自有 arguments → 供嵌套箭头捕获
                M.localGet(this.envLocal); M.i32Const(this._strId("arguments")); M.localGet(this._argsLocal); M.call("qz.env_set");
            }
        }
        this.depth = 0; this.labels = []; this._tryStack = []; this._labelStack = [];
        this._staticVars = this._computeStaticVars(lam.body, params);
        // 箭头表达式体：表达式即返回值；块体：语句
        if (ts.isExpression(lam.body)) { this.emitTaggedExpr(lam.body); M.return_(); }
        else { this._emitFnDeclClosures(lam.body); this.emitTaggedBlock(lam.body); }
        const last = ts.isBlock(lam.body) ? lam.body.statements[lam.body.statements.length - 1] : null;
        this._fnVars = savedFnVars2;
        if (!(last && ts.isReturnStatement(last))) this._emitUndefined();   // 无显式 return → undefined（JS 语义；不是 unreachable）
        M.endBody();
        this._curClassObj = savedCCO3;
        this._curClass = savedCC3;
        this._inLitMethod = savedLitM;
        this.varMap = savedMap; this.capMap = savedCap; this.blkLocal = savedBlk;
        this.envLocal = undefined; this.envRef = savedEnvRef;
        this.mode = savedMode; this.depth = savedDepth; this._staticVars = savedStatic;
        const tramp = this._emitLambdaTrampoline(fname, params.length);
        const m0 = this._lamById.get(lam);
        if (m0) { m0.tableSlot = tramp.slot; m0.trampFunc = tramp.func; }
        /* meta.tableSlot 已就绪 → 后续 _emitLambdaNew 写闭包值时可用。 */
    }
    /* 闭包体蹦床：统一签名 (env:i32, a0..a4:i64) → i64，供 C 侧 call_indirect 按
     * 一个固定函数类型分派（闭包体自身签名随形参个数变化，无法直接进表）。
     * 超出形参个数的槽补 undefined 句柄，与直调路径语义一致。 */
    _emitLambdaTrampoline(fname, nParams) {
        const M = this.m, tn = fname + "$t";
        const hasOvf = nParams > 4;
        M.declareFunc(tn, ["i32", "i64", "i64", "i64", "i64"].concat(hasOvf ? ["i64"] : []), ["i64"]);
        M.startBody(tn, []);
        /* 蹦床接收 5 个实参槽（i32 env + 4×i64），闭包体只声明它自己的形参个数 →
         * 按 nParams 精确转发，多出的槽直接丢弃（wasm 调用参数必须严格匹配）。 */
        M.localGet(0);
        for (let i = 0; i < Math.min(nParams, 4); i++) M.localGet(1 + i);
        if (hasOvf) M.localGet(5);   // ovf 槽透传
        M.call(fname);
        M.return_();
        M.endBody();
        const f = this.m._funcIdx[tn];
        /* 表槽分配：0 起留给「无此表项」哨兵，实际槽从 1 开始；product 侧表由
         * libqzvm 导出共享（见 wasm-encoder.addTableImport）。 */
        this._trampSlots = this._trampSlots || new Map();
        return { slot: this._trampSlots.get(tn), func: f };
    }
    // ---------- 语句 ----------
    // ---------- 类（method lifting）----------
    // 类方法/构造器提升为独立 wasm 函数 __m_<C>$<m>(self:i64, a0..a3:i64) → i64。
    // self = 实例句柄（i64 tagged）；实例字段驻 wasm 内存（与 POJO 同 _fieldIndex 布局），
    // `this` 映射 local 0（self），`this.x` 复用 POJO 字段 load/store（零跨界）。
    // 静态分派：receiver 静态类型已知 → 沿父链直调导出 __m_<C>$<m>；动态 → qz.method_call。
    collectClasses(clsNodes) {   // clsNodes: 已收集的 ClassDeclaration 列表（含嵌套，见 collectDecls）
        const firstNew = this._classList.length;
        const allClsNames = new Set();   // 本次收集的全部类名：捕获过滤须一次到位（逐个 classes.set 时后续类尚未登记 → 类名被误判为自由变量 → 方法内 return M 走 env_get 得 undefined）
        for (const st0 of clsNodes) if (ts.isClassDeclaration(st0) && st0.name) allClsNames.add(st0.name.text);
        for (const st of clsNodes) {
            if (!ts.isClassDeclaration(st)) continue;
            if (!st.name) throw new Error("[tagged] 匿名类不支持");
            const cname = st.name.text;
            // 只认 `extends`：`implements` 是纯类型子句（token = ImplementsKeyword），
            // 取 heritageClauses[0] 在「只有 implements 没有 extends」的类上会把它当父类
            // → 父类名解析成类型名（zod v3 `class ParseInputLazyPath implements ParseInput`）。
            const extClause = st.heritageClauses && st.heritageClauses.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
            const parent = extClause && extClause.types.length ? extClause.types[0] : null;
            const parentName = parent ? this._className(parent.expression.text) : null;   // 类表达式绑定名/导入别名 → 真实类名（此前取原文 → ctorName 落空）
            const fields = [], methods = [], staticMethods = [], staticFields = [], staticBlocks = [], staticInits = [];
            let ctor = null;
            const isStatic = (mem) => !!mem.modifiers && mem.modifiers.some(m => m.kind === ts.SyntaxKind.StaticKeyword);
            for (const mem of st.members) {
                // TS 重载签名（`write(fn: F): void;` / `write(line: string): void;`）只有类型、没有
                // 实现体：不进 methods（否则 emitAll 取 mth.node.body 得 undefined → 崩溃）。
                // 实现体是后面那个同名的带 body 声明，正常入列。
                if (ts.isMethodDeclaration(mem) && !mem.body) continue;
                if (ts.isPropertyDeclaration(mem) && (ts.isIdentifier(mem.name) || ts.isStringLiteral(mem.name) || ts.isNumericLiteral(mem.name))) {
                    // 字符串/数字字面量属性名（`"~standard": T` / `0: T`）与标识符同处理：名字即键。
                    const nm = mem.name.text;
                    if (isStatic(mem)) { staticFields.push({ name: nm, init: mem.initializer || null }); staticInits.push({ kind: "field", name: nm, init: mem.initializer || null }); }
                    else fields.push({ name: nm, init: mem.initializer || null });
                } else if (ts.isClassStaticBlockDeclaration(mem)) {
                    staticBlocks.push(mem); staticInits.push({ kind: "block", blk: mem });   // static { … }：首次访问静态时执行（保持源码序）
                } else if (ts.isConstructorDeclaration(mem)) {
                    if (mem.body) ctor = mem;   // 无 body（重载签名/declare）→ 忽略，实现在后
                } else if (ts.isPropertyDeclaration(mem) && ts.isComputedPropertyName(mem.name)) {
                    // ["d"+"yn"] / [KEY+"2"]：常量折叠为静态字段名（无法折叠 → loud，避免静默错名）
                    const nm = this._foldPropName(mem.name.expression);
                    if (nm === null) throw new Error("[tagged] 计算属性类字段名无法编译期求值（需字面量、字面量拼接或模块级字面量 const）");
                    if (isStatic(mem)) { staticFields.push({ name: nm, init: mem.initializer || null }); staticInits.push({ kind: "field", name: nm, init: mem.initializer || null }); }
                    else fields.push({ name: nm, init: mem.initializer || null });
                } else if (ts.isPropertyDeclaration(mem) && ts.isPrivateIdentifier(mem.name)) {
                    if (isStatic(mem)) {   // 私有静态字段：#类名#名（与访问点一致）
                        const pn = "#" + cname + "#" + mem.name.text;
                        staticFields.push({ name: pn, init: mem.initializer || null });
                        staticInits.push({ kind: "field", name: pn, init: mem.initializer || null });
                    } else fields.push({ name: "#" + cname + "#" + mem.name.text, init: mem.initializer || null });   // 私有字段：类名限定
                } else if (ts.isMethodDeclaration(mem) && ts.isPrivateIdentifier(mem.name)) {
                    (isStatic(mem) ? staticMethods : methods).push({ name: "#" + cname + "#" + mem.name.text, node: mem });   // 私有方法/私有静态方法
                } else if (ts.isMethodDeclaration(mem) && (ts.isIdentifier(mem.name) || ts.isStringLiteral(mem.name) || ts.isNumericLiteral(mem.name))) {
                    (isStatic(mem) ? staticMethods : methods).push({ name: mem.name.text, node: mem });
                } else if (ts.isMethodDeclaration(mem) && ts.isComputedPropertyName(mem.name)) {
                    // [Symbol.iterator] / [Symbol.toPrimitive] …：编译为 @@<symbol 名> 方法；物化时挂到真 Symbol 上
                    const sx = symbolNameOf(mem.name.expression) || (ts.isIdentifier(mem.name.expression) && this._modSymLit && this._modSymLit.get(mem.name.expression.text)) || null;   // Symbol.x 或持有它的模块级常量
                    if (!sx) throw new Error("[tagged] 类计算属性名方法仅支持 Symbol.<well-known>（如 [Symbol.iterator]）或持有它的模块级常量");
                    (isStatic(mem) ? staticMethods : methods).push({ name: "@@" + sx, node: mem });
                } else if ((ts.isGetAccessorDeclaration(mem) || ts.isSetAccessorDeclaration(mem)) && !mem.body) {
                    continue;   // 无 body 的访问器声明（declare/抽象）→ 忽略
                } else if ((ts.isGetAccessorDeclaration(mem) || ts.isSetAccessorDeclaration(mem)) && ts.isComputedPropertyName(mem.name)) {
                    const sx = symbolNameOf(mem.name.expression) || (ts.isIdentifier(mem.name.expression) && this._modSymLit && this._modSymLit.get(mem.name.expression.text)) || null;   // Symbol.x 或持有它的模块级常量
                    if (!sx) throw new Error("[tagged] 类计算属性名访问器仅支持 Symbol.<well-known>（如 [Symbol.toStringTag]）或持有它的模块级常量");
                    (isStatic(mem) ? staticMethods : methods).push({ name: "@@" + sx, node: mem, accessor: ts.isSetAccessorDeclaration(mem) ? "set" : "get" });
                } else if ((ts.isGetAccessorDeclaration(mem) || ts.isSetAccessorDeclaration(mem)) && ts.isIdentifier(mem.name)) {
                    if (isStatic(mem)) { staticMethods.push({ name: mem.name.text, node: mem, accessor: ts.isSetAccessorDeclaration(mem) ? "set" : "get" }); }
                    else
                    methods.push({ name: mem.name.text, node: mem, accessor: ts.isSetAccessorDeclaration(mem) ? "set" : "get" });
                } else {
                    throw new Error("[tagged] 不支持的类成员: " + ts.SyntaxKind[mem.kind]);
                }
            }
            if (ctor) {   // TS 参数属性 constructor(public x: any) → 隐式字段「this.x = x」（初值 = 形参局部读）
                const props = [];
                for (const p of ctor.parameters) {
                    if (!ts.isIdentifier(p.name)) continue;
                    const isProp = (p.modifiers || []).some(mm => mm.kind === ts.SyntaxKind.PublicKeyword || mm.kind === ts.SyntaxKind.PrivateKeyword
                        || mm.kind === ts.SyntaxKind.ProtectedKeyword || mm.kind === ts.SyntaxKind.ReadonlyKeyword);
                    if (!isProp) continue;
                    const pnm = ts.isPrivateIdentifier(p.name) ? "#" + cname + "#" + p.name.text : p.name.text;
                    if (fields.some(f2 => f2.name === pnm)) continue;
                    props.push({ name: pnm, init: p.name });
                }
                fields.unshift.apply(fields, props);             // TS：参数属性先于字段初值赋值
            }
            {   // 静态方法/getter/setter 体内是否出现 `this`（≡ 类）：派生类经类名调用时 `this` 应为**派生类**对象，
                // 本实现按定义类解析 → 静默偏差；此处标记以便调用点 loud。
                const usesThis = (node) => {
                    let hit = false;
                    const walk = (n2) => {
                        if (hit) return;
                        if (ts.isThis(n2)) { hit = true; return; }
                        if (n2 !== node && (ts.isFunctionDeclaration(n2) || ts.isFunctionExpression(n2) || ts.isArrowFunction(n2))) return;   // 内层函数的 this 另算
                        ts.forEachChild(n2, walk);
                    };
                    if (node) walk(node);
                    return hit;
                };
                const thisNames = (node) => {
                    const names = new Set();
                    const walk = (n2) => {
                        if (ts.isPropertyAccessExpression(n2) && ts.isThis(n2.expression)) {
                            if (ts.isIdentifier(n2.name)) names.add(n2.name.text);   // 私有名不参与（私有静态不继承）
                        } else if (ts.isElementAccessExpression(n2) && ts.isThis(n2.expression)
                            && (ts.isStringLiteral(n2.argumentExpression) || ts.isNumericLiteral(n2.argumentExpression))) {
                            names.add(n2.argumentExpression.text);
                        }
                        if (n2 !== node && (ts.isFunctionDeclaration(n2) || ts.isFunctionExpression(n2) || ts.isArrowFunction(n2))) return;
                        ts.forEachChild(n2, walk);
                    };
                    if (node) walk(node);
                    for (let x = this.classes.get(cname) && this.classes.get(cname).parent; x; x = this.classes.get(x) && this.classes.get(x).parent) {
                        const cl2 = this.classes.get(x);   // 基类链上的静态名 → 若派生类覆写才可能偏差（扫描时统一记入，调用点再判）
                        if (!cl2) break;
                    }
                    return names;
                };
                for (const sm of staticMethods) { sm.usesThis = usesThis(sm.node && sm.node.body); sm.thisNames = thisNames(sm.node && sm.node.body); }
            }
            const capSetC = new Set();                      // 方法/构造器/实例字段初值的外围引用 → 类 env 捕获（**单一来源**，两处共用）
            const staticRefsC = new Set();                  // 静态字段初值/静态块的外围引用：首次访问才执行 → 仅用于 loud 校验
            {
                const addRefs = (set, node) => {
                    if (!node) return;
                    const nestedParams = new Set();         // 嵌套函数（含箭头）的形参：不是外层自由变量（_collectLocals 不下探）
                    const walkN = (n2) => {
                        if (ts.isArrowFunction(n2) || ts.isFunctionExpression(n2) || ts.isFunctionDeclaration(n2)
                            || ts.isMethodDeclaration(n2) || ts.isGetAccessorDeclaration(n2) || ts.isSetAccessorDeclaration(n2)
                            || ts.isConstructorDeclaration(n2))
                          for (const p2 of n2.parameters) for (const np2 of this._patternNames(p2.name)) nestedParams.add(np2);
                        ts.forEachChild(n2, walkN);
                    };
                    walkN(node);
                    for (const nm2 of this._capturesOf(node)) {
                        if (nm2 === "this" || nm2 === "arguments") continue;   // 蹦床/宿主补，不是类 env 捕获
                        if (nestedParams.has(nm2)) continue;
                        if (BUILTIN_GLOBALS.has(nm2)) continue;
                        if (/^(undefined|null|NaN|Infinity)$/.test(nm2)) continue;
                        if (this.classes.has(this._className(nm2))) continue;
                        if (allClsNames.has(this._className(nm2)) || allClsNames.has(nm2)) continue;   // 类名（含尚未登记的本类/后续类）不是捕获
                        if (this.fnNames && this.fnNames.has(nm2)) continue;
                        set.add(nm2);
                    }
                };
                for (const mth of methods.concat(staticMethods)) if (mth && mth.node && mth.node.body) addRefs(capSetC, mth.node);
                if (ctor) addRefs(capSetC, ctor);
                for (const f of fields) if (f.init) addRefs(capSetC, this._synthCaptureArrow(f.init));
                for (const f of staticFields) if (f.init) addRefs(staticRefsC, this._synthCaptureArrow(f.init));
                for (const blk of staticBlocks) addRefs(staticRefsC, this._synthCaptureArrow(blk));
            }
            /* 提升后的类读不到定义点外层绑定：函数/块内 class 声明、以及 `const C = class` 形式的
             * 类表达式（该形式只把 C 当类名别名、类值不物化），若其实现体引用了非模块级局部名，
             * 运行时没有 env 槽 → 此前静默 undefined，改为 loud。 */
            if (this.declaredNames) {
                const isAlias = !!(this.aliasClsExprDecls && this.aliasClsExprDecls.has(st));
                const lostDecl = isAlias || !!(this.nestedClsDecls && this.nestedClsDecls.has(st));
                if (lostDecl) {
                    const lost = [];
                    for (const nm2 of capSetC) if (this.declaredNames.has(nm2)) lost.push(nm2);
                    if (lost.length) {
                        const form = isAlias
                            ? "const " + st.name.text + " = class 形式（只作类名别名，类值不物化）"
                            : "函数/块内 class 声明（类被提升到模块级）";
                        throw new Error("[tagged] " + form + "捕获了外层局部变量（" + lost.join(", ") + "），方法/构造器/字段初值运行时读不到该绑定；请把变量提升到模块级，或改用工厂函数返回类表达式");
                    }
                }
                /* 静态初始化在**首次静态访问点**执行（lazy statics guard）→ 定义点外层局部同样不可见。 */
                const lostStatic = [];
                for (const nm2 of staticRefsC) if (this.declaredNames.has(nm2)) lostStatic.push(nm2);
                if (lostStatic.length) {
                    throw new Error("[tagged] class " + cname + " 的静态初始化捕获了非模块级变量（" + lostStatic.join(", ") + "）：静态初始化在首次静态访问点执行，读不到 class 定义点的局部绑定；请把变量提升到模块级，或改用实例字段/构造器参数");
                }
            }
            this.classes.set(cname, { id: this._classList.length, name: cname, parent: parentName, captured: [...capSetC], dynParentNode: parent ? parent.expression : null, fields, methods, staticMethods, staticFields, staticBlocks, staticInits, ctor });
            this._classList.push(cname);
        }
        // 预登记所有类字段到 fieldMap（发射阶段任意时刻 _instSize 都要覆盖全部类字段）；
        // POJO 字面量字段在其自身发射时登记，可能后于类字段 → 仅使实例 size 偏大，无害。
        for (const cname of this._classList) {
            const c = this.classes.get(cname);
            for (const f of c.fields) this._fieldIndex(f.name);
            if (c.parent && !this.classes.has(c.parent)) { this._fieldIndex("message"); this._fieldIndex("name"); }   // 内建父类（extends Error）：super() 写 message/name，须在所有 new 分配前登记（否则实例 size 偏小 → 物化时越界丢弃）
        }
        // 叶类 = 无子类的类。其方法/构造器内 `this` 静态类精确（new C 永不产 C 之外的实例）。
        this._leafClasses = new Set(this._classList);
        for (const cname of this._classList) {
            const c = this.classes.get(cname);
            if (c.parent && this.classes.has(c.parent)) this._leafClasses.delete(c.parent);
        }
        // 仅为本文件新增类登记签名——collectClasses 每文件调用一次；若遍历整个 _classList
        // 会重复 declareFunc 早前文件的类（codes 占位未填 → 编码时崩）。
        for (let i = firstNew; i < this._classList.length; i++) {
            const cname = this._classList[i];
            const c = this.classes.get(cname);
            for (const mth of c.methods) {
                const voidRet = !!mth.node.type && mth.node.type.kind === ts.SyntaxKind.VoidKeyword;
                this.m.declareFunc(methName(cname, mth.accessor === "set" ? mth.name + "$set" : mth.name),
                                   ["i64", "i64", "i64", "i64", "i64"].concat(mth.node.parameters.length > 4 ? ["i64"] : []),   // >4 形参 → 第 6 槽 = 实参 4.. 数组
                                   mth.accessor === "set" || voidRet ? [] : ["i64"]);
            }
            this.m.declareFunc(ctorName(cname), ["i64", "i64", "i64", "i64", "i64"], []);
            for (const sm of c.staticMethods) {
                const voidRet = !!sm.node.type && sm.node.type.kind === ts.SyntaxKind.VoidKeyword;
                this.m.declareFunc(staticMethName(cname, sm.name + (sm.accessor === "set" ? "$set" : "")),
                                   ["i64", "i64", "i64", "i64", "i64"].concat(sm.node.parameters.length > 4 ? ["i64"] : []),   // >4 形参 → 第 6 槽 voidRet ? [] : ["i64"]);
                                   voidRet ? [] : ["i64"]);
            }
        }
    }
    emitClassBodies() {
        for (const cname of this._classList) {
            const c = this.classes.get(cname);
            this._emitCtorBody(c, c.ctor);
            for (const mth of c.methods) this._emitMethodBody(cname, mth);
            for (const sm of c.staticMethods) this._emitStaticMethodBody(cname, sm);
        }
    }
    // 静态方法 __sm_<C>$<m>(self占位:i64, a0..a3:i64)：无 this（local0 占位 undefined）。
    _emitStaticMethodBody(cname, sm) {
        const M = this.m;
        const isVoid = !!sm.node.type && sm.node.type.kind === ts.SyntaxKind.VoidKeyword;
        const realParams = sm.node.parameters.map(p => p.name.text);
        const params = realParams.slice(0, 4).concat(["$p1", "$p2", "$p3", "$p4"].slice(0, Math.max(0, 4 - realParams.length)))
            .concat(realParams.length > 4 ? ["$ovf"] : []);
        // 先置位再 _mEnter：静态方法的类捕获 env 要按**类值** self 取（class_env_get_static）
        this._inStaticMethod = true;                       // 静态方法体内 this ≡ 类（_classOfExpr）
        this._mEnter(staticMethName(cname, sm.name + (sm.accessor === "set" ? "$set" : "")), cname, params, sm.node.body, isVoid, sm.node.parameters);
        this._emitParamPrologue(sm.node.parameters, 1);    // 静态方法形参同上
        this._emitOvfParamUnpack(sm.node.parameters, params);
        this._curClassObj = this.classes.get(cname);
        this._emitFnDeclClosures(sm.node.body);
        this.emitTaggedBlock(sm.node.body);
        { const stmts = sm.node.body.statements; const last = stmts[stmts.length - 1];   // tagged：落空 → undefined
          if (!(last && ts.isReturnStatement(last))) { this._emitUndefined(); M.return_(); } }
        M.endBody();
        this._mExit();
    }
    // 构造器 __m_<C>$ctor(self:i64, a0..a3:i64) → 无返回：self 由调用方 _emitNewCall 内联 bump 分配后传入
    // 方法/静态方法 >4 形参：从第 6 槽（$ovf 数组）解包实参 4.. 到各自 local（含默认值/解构/rest 语义）。
    _emitOvfParamUnpack(astParams, params, paramOff) {
        if (!astParams || astParams.length <= 4) return;
        const M = this.m;
        const off = paramOff || 0;
        const ovfLocal = 1 + params.length - 1;                  // $ovf 槽（最后一个 wasm 形参）
        for (let i = 4; i < astParams.length; i++) {
            const p = astParams[i];
            const dst = 1 + params.length + (i - 4);             // 与 body varMap / _mEnter 一致（params.length 含 $ovf）
            this._emitElemOf(ovfLocal, ts.factory.createNumericLiteral(i - 3 - off)); M.localSet(dst);   // ovf[i] → 形参 local
            if (p.dotDotDotToken) {                              // rest：调用方已打包为数组（未传 → 空数组）
                M.localGet(dst); M.call("qz.is_undef");
                M.ifBlock("void"); M.call("qz.empty_array"); M.localSet(dst); M.end();
            }
            if (p.initializer) {
                M.localGet(dst); M.call("qz.is_undef");
                M.ifBlock("void"); this.emitTaggedExpr(p.initializer); M.localSet(dst); M.end();
            }
            if (!ts.isIdentifier(p.name)) {
                const t = this._expEnter();
                M.localGet(dst); M.localSet(t.v);
                this._emitDestructurePattern(p.name, t.v);
                this._expLeave();
            }
        }
    }
    _emitCtorBody(c, ctor) {
        const M = this.m;
        const realParams = ctor ? ctor.parameters.map(p => p.name.text) : [];
        const params = realParams.concat(["$p1", "$p2", "$p3", "$p4"].slice(0, Math.max(0, 4 - realParams.length)));
        const body = ctor ? ctor.body : { statements: [] };
        this._inStaticMethod = false;                      // 须在 _mEnter 前复位：实例 env 取法依赖此标志
        this._mEnter(ctorName(c.name), c.name, params, body, true, ctor ? ctor.parameters : [],
            c.fields.filter(f2 => f2.init).map(f2 => f2.init));   // 字段初值在 ctor 内联发射 → 其闭包（如 = () => this.x）须捕获 this
        this._curClassObj = c;
        // 派生类：字段默认值须在 super(...) 之后写（同名遮蔽字段父写后子覆写）；
        // super 语句处 _emitSuperCall 负责调用父 ctor 后回写本类默认值。基类：此处直接写。
        if (!c.parent) this._emitFieldDefaults(c);
        if (ctor) { this._emitFnDeclClosures(ctor.body); this.emitTaggedBlock(ctor.body); }
        else if (c.parent || this._dynParentExpr(c)) this._emitSuperCallForward(c);   // 合成 ctor：constructor(...a){ super(...a) }（动态父同样须转发，否则父类字段默认值不执行）
        this._curClassObj = null;
        M.endBody();
        this._mExit();
    }
    // 写本类字段默认初值（now: 当前 self=local0 在栈/无；用局部 self 直接存）。
    // 若 ctor 首句为 `super(...)`，则字段默认值改在 super 调用点写（子类字段不得覆写父类构造设置的字段）。
    _emitFieldDefaults(c) {
        const M = this.m;
        if (this.usesKeyOrder && c.fields.length) {   // 实例字段插入序 = 类字段声明序（派生类在 super 之后登记）
            M.localGet(0); M.i32Const(this._strId(c.fields.map(f2 => f2.name).join("\u0000"))); M.call("qz.field_order_lit");
        }
        for (const f of c.fields) {
            M.localGet(0); M.i32WrapI64();
            if (f.init) this.emitTaggedExpr(f.init);
            else this._emitUndefined();
            M.i64Store(3, this._fieldIndex(f.name));
        }
    }
    _emitMethodBody(cname, mth) {
        const M = this.m;
        this._assertNotAsync(mth.node, `方法 ${cname}.${mth.name}`);
        const isVoid = !!mth.node.type && mth.node.type.kind === ts.SyntaxKind.VoidKeyword;
        const realParams = mth.node.parameters.map(p => p.name.text);
        const params = realParams.slice(0, 4).concat(["$p1", "$p2", "$p3", "$p4"].slice(0, Math.max(0, 4 - realParams.length)))
            .concat(realParams.length > 4 ? ["$ovf"] : []);            // 前 4 槽 + 可选 $ovf（实参 4.. 数组）
        this._inStaticMethod = false;                      // 须在 _mEnter 前复位：实例 env 取法依赖此标志
        this._mEnter(methName(cname, mth.accessor === "set" ? mth.name + "$set" : mth.name), cname, params, mth.node.body, isVoid, mth.node.parameters);
        this._emitParamPrologue(mth.node.parameters, 1);   // 方法形参：默认值/解构
        this._emitOvfParamUnpack(mth.node.parameters, params);   // >4 形参：从 $ovf 数组解包到各自 local
        this._emitFnDeclClosures(mth.node.body);
        this.emitTaggedBlock(mth.node.body);
        { const stmts = mth.node.body.statements; const last = stmts[stmts.length - 1];   // tagged：落空 → undefined
          if (!(last && ts.isReturnStatement(last))) { this._emitUndefined(); M.return_(); } }
        M.endBody();
        this._mExit();
    }
    // 方法/构造器发射作用域：this=local0，参数 1..，完整 scratch/sT/obj/forOf/clo 槽布局。
    // 与 emitFunc(tagged) 同构；额外 _curClass 供静态方法分派解析继承链。
    _mEnter(fname, cname, params, body, isVoid, astParams, extraNodes) {
        this._mSaved = {
            mode: this.mode, varMap: this.varMap, capMap: this.capMap, capList: this.capList, capListActive: this.capListActive,
            blkLocal: this.blkLocal, depth: this.depth, labels: this.labels, labelStack: this._labelStack, curClass: this._curClass, curClassObj: this._curClassObj, staticVars: this._staticVars, envLocal: this.envLocal, envRef: this.envRef, fnVars: this._fnVars,
        };
        this.mode = "tagged";
        this._fnVoid = !!isVoid;
        const nParams = 1 + params.length;
        const locals = this._collectLocals(body);
        for (const p of (astParams || [])) if (!ts.isIdentifier(p.name)) for (const n of this._patternNames(p.name)) if (!locals.includes(n)) locals.push(n);
        for (let i2 = 4; i2 < (astParams ? astParams.length : 0); i2++) locals.unshift("$ovfArg" + (i2 - 4));   // 实参 4.. 的 local（由 _emitOvfParamUnpack 写入）
        const nLoc = nParams + locals.length;
        this._lamThisParam = false;                       // 类方法/构造器：this 走 local 0（不受上一个 lambda 标记影响）
        this.varMap = new Map();
        this.varMap.set("this", 0);
        // 实参 0..3 → local 1..4；实参 4.. → local 1+params.length+(i-4)（= $ovf 槽之后的预留槽）
        if (astParams) astParams.forEach((p, i) => { if (ts.isIdentifier(p.name)) this.varMap.set(p.name.text, i < 4 ? 1 + i : 1 + params.length + (i - 4)); });
        else params.forEach((p, i) => this.varMap.set(p, 1 + i));
        locals.forEach((n, i) => this.varMap.set(n, nParams + i));
        this.capMap = new Map(); this.blkLocal = null;
        this._lamSelf = null;   // 方法体内不得沿用上一个 lambda 的自递归标记（blk 类型不同）
        this.scratch = nLoc; this.scratchA = nLoc + 1; this.scratchB = nLoc + 2;
        const extra = ["f64", "f64"];
        this.scratchFA = nLoc + 3; this.scratchFB = nLoc + 4;
        const sT = Array.from({ length: 40 }, () => "i32");
        this.sT = Array.from({ length: 40 }, (_, i) => nLoc + 5 + i);
        const objPool = Array.from({ length: 48 }, () => "i64");
        this.objBase = nLoc + 3 + extra.length + sT.length;
        this._objDepth = 0;
        const nRestKeys = this._countRestComputedKeysIn(astParams, body);
        const restKeyPool = Array.from({ length: nRestKeys }, () => "i64");
        this._restKeyBase = this.objBase + objPool.length;
        this._restKeyCount = nRestKeys;
        this._restKeyNext = 0;
        this.swIdx = this.objBase + objPool.length + nRestKeys;
        const nForOf = this._countForOf(body);
        this.forOfBase = this.swIdx + 1;
        this.forOfCount = 0;
        const forOfLocals = [];
        for (let i = 0; i < nForOf; i++) forOfLocals.push("i64", "i32", "i32");
        const cloSlots = ["i64", "i32", "i32", "i32", "i64", "i64", "i64", "i64"];
        this.cloHandle = this.swIdx + 1 + nForOf * 3;
        this.cloOff = this.cloHandle + 1; this.cloBlk = this.cloHandle + 2; this.cloFn = this.cloHandle + 3;
        this.cloArgs = [this.cloHandle + 4, this.cloHandle + 5, this.cloHandle + 6, this.cloHandle + 7];
        this.scratchObj = this.cloArgs[3] + 1;
        this._fnArenaFreeThis = false;      // 方法体不复位（布局同上，槽位号不同）
        this._loopSaveBase = this.scratchObj + 1; this._loopSaveCount = this._countLoops(body) + 1; this._loopSaveDepth = 0;
        const mthLoopSaveDecls = new Array(this._loopSaveCount).fill("i32");
        this.cloSlotsLen = cloSlots.length;
        // 方法体内被（嵌套）lambda 捕获的 this/参数/局部 → 共享环境（同 emitFunc）
        const capNames = this._probeCaptured(extraNodes ? [body].concat(extraNodes) : body, params, locals);
        { const ciC = this.classes.get(cname);
          /* 类捕获名一律并入 capMap：方法体内裸引用外层捕获也须走 env（而非 undefined 兜底），
           * 嵌套 lambda 才能沿环境链看到它们。 */
          if (ciC && ciC.captured) for (const n0 of ciC.captured) if (!capNames.includes(n0)) capNames.push(n0); }
        const envDecls = capNames.length ? ["i32"] : [];
        const bodyLocals = locals.map(() => "i64").concat(["i64", "i64", "i64"]).concat(extra)
            .concat(sT).concat(objPool).concat(restKeyPool).concat(["i32"]).concat(forOfLocals).concat(cloSlots).concat(["i64"]).concat(mthLoopSaveDecls).concat(envDecls);
        const localNames = this.m.debug ? ["this"].concat(params).concat(locals) : null;
        this.m.startBody(fname, bodyLocals, localNames);
        this.m.i64Const(0n); this.m.globalSet(1);           // 入口清 __err
        this._emitParamPrologue(astParams || [], 1);        // 默认值 / 解构形参（先于写 env）
        this.envLocal = capNames.length ? (1 + params.length) + bodyLocals.length - 1 : undefined;
        this.capMap = new Map(capNames.map(n => [n, this.envLocal]));
        this.envRef = this.envLocal;
        if (capNames.length) {
            const M = this.m;
            { const ciE = this.classes.get(cname);
              const capArr = (ciE && ciE.captured) || [];
              /* 直接用类 env 的前提：本方法没有同名形参/局部遮蔽（否则写回会污染共享类 env，
               * 或读到外层值而非局部值）。 */
              const covered = capNames.every(n0 => capArr.includes(n0)) && capNames.every(n0 => this._local(n0) === undefined);
              /* 实例方法的 self 是实例句柄；静态方法的 self 是类值 → 取 env 的原语不同
               * （前者按实例内存的运行时 clsId，后者按类值句柄的低 32 位/__qzClsId）。*/
              const envGet = this._inStaticMethod ? "qz.class_env_get_static" : "qz.class_env_get";
              if (covered) {                                     // 方法捕获 ⊆ 类捕获 → 直接用类 env
                /* 按实例的**运行时 clsId** 取 env：class_expr_value 克隆出的每个类
                 * 各持一份捕获副本，按类名查会撞车（A/B 共读同一 label）。*/
                M.localGet(0); M.i32Const(this._strId("@@qzEnv")); M.call(envGet);
                M.i32WrapI64(); M.i32Const(1); M.i32Sub();   /* env 已 +1（0=无捕获哨兵）→ 还原 */
                M.localSet(this.envLocal);
              } else if (capArr.some(n0 => capNames.includes(n0))) {
                /* 方法自身还要捕获形参/局部，同时引用类外层捕获 → 建子环境挂到类 env 下：
                 * 只写方法自身的名字，类捕获名沿 __parent 链读（否则空环境遮蔽类 env → 静默 undefined）。 */
                M.localGet(0); M.i32Const(this._strId("@@qzEnv")); M.call(envGet);
                M.i32WrapI64(); M.i32Const(1); M.i32Sub();   /* 父 env 索引（-1 = 无） */
                M.call("qz.env_new");
                M.i32WrapI64(); M.localSet(this.envLocal);
              } else { M.i32Const(-1); M.call("qz.env_new"); M.i32WrapI64(); M.localSet(this.envLocal); } }
            /* 种子写入一律落在**本层**（env_def）：形参写当前值；与类捕获同名的局部先占位
             * undefined（否则后续 env_set 沿 __parent 链写进共享类 env，污染其它方法）。
             * 与类捕获同名的形参同理不能 env_set，否则覆盖类 env 的捕获副本。 */
            for (const n of capNames) {
                const li = this._local(n);
                if (n === "this") { M.localGet(this.envLocal); M.i32Const(this._strId("this")); M.localGet(0); M.call("qz.env_def"); }
                else if (li !== undefined) {
                    M.localGet(this.envLocal); M.i32Const(this._strId(n));
                    if (li < 1 + params.length) M.localGet(li); else this._emitUndefined();
                    M.call("qz.env_def");
                }
            }
        }
        this.depth = 0; this.labels = []; this._tryStack = []; this._labelStack = [];
        this._curClass = cname;
        this._curClassObj = this.classes.get(cname) || null;   // super.m()/静态分派需类元数据（继承链编译期已知）
        this._staticVars = this._computeStaticVars(body, params);
    }
    _mExit() {
        const s = this._mSaved;
        this.mode = s.mode; this.varMap = s.varMap; this.capMap = s.capMap; this.capList = s.capList; this.capListActive = s.capListActive;
        this.blkLocal = s.blkLocal; this.depth = s.depth; this.labels = s.labels;
        this._labelStack = s.labelStack; this._curClass = s.curClass; this._curClassObj = s.curClassObj;
        this._staticVars = s.staticVars; this.envLocal = s.envLocal; this.envRef = s.envRef;
        this._fnVars = new Set();   // 方法体自身作用域（内层 lambda 各自再包一层）
    }
    emitBlock(node) { for (const s of node.statements) this.emitStmt(s); }

    emitStmt(s) {
        this.m.markLine(this._line(s));
        if (ts.isVariableStatement(s)) {
            for (const d of s.declarationList.declarations) {
                if (!ts.isIdentifier(d.name)) { if (d.initializer) { this.emitExpr(d.initializer); this.m.localSet(this._local(d.name.text)); } continue; }
                const nm = d.name.text, na = this._numArr.get(nm);
                if (na) {
                    // num 数组：分配 8 字节头 [cap=0][pad]，base = headerOff+8（数据起始）。
                    emitBumpAlloc(this.m, () => this.m.i32Const(8));   // headerOff on stack
                    this.m.i32Const(8); this.m.i32Add(); this.m.localSet(na.base);   // base = headerOff+8
                    this.m.localGet(na.base); this.m.i32Const(8); this.m.i32Sub();
                    this.m.i32Const(0); this.m.i32Store(2, 0);       // [base-8] = cap = 0
                    this.m.i32Const(0); this.m.localSet(na.len);     // len = 0
                    continue;   // 不调 emitExpr(initializer)
                }
                if (this._inlineArrows && this._inlineArrows.has(nm)) continue;   // 内联箭头函数：跳过声明
                if (d.initializer) { this.emitExpr(d.initializer); this.m.localSet(this._local(nm)); }
            }
            return;
        }
        if (ts.isReturnStatement(s)) {
            if (s.expression) this.emitExpr(s.expression);
            this.m.return_();
            return;
        }
        if (ts.isIfStatement(s)) {
            this.emitExpr(s.expression !== undefined ? s.expression : s.condition); this.emitCond();
            this.m.ifBlock();          // 语句 if 无返回值
            this.depth++;
            this.emitStmt(s.thenStatement);
            if (s.elseStatement) { this.m.else_(); this.emitStmt(s.elseStatement); }
            this.depth--;
            this.m.end();
            return;
        }
        if (ts.isBreakStatement(s)) { this._jumpOut(s.label && s.label.text, true); return; }
        if (ts.isDoStatement(s)) { this.emitDoWhile(s, false); return; }
        if (ts.isContinueStatement(s)) { this._jumpOut(s.label && s.label.text, false); return; }
        if (ts.isWhileStatement(s)) { this.emitWhile(s); return; }
        if (ts.isForStatement(s)) { this.emitFor(s); return; }
        if (ts.isSwitchStatement(s)) { this.emitSwitch(s, false); return; }
        if (ts.isLabeledStatement(s)) { if (ts.isIterationStatement(s.statement, false)) this._labelStack.push(s.label.text); this.emitStmt(s.statement); return; }
        if (ts.isBlock(s)) { this.emitBlock(s); return; }
        if (ts.isExpressionStatement(s)) { this.emitExpr(s.expression); this.m.drop(); return; }
        if (ts.isEmptyStatement(s)) return;
        if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isModuleDeclaration(s)
            || s.kind === ts.SyntaxKind.ImportDeclaration) return;      // TS 类型层/导入：擦除（无运行期语义）
        throw new Error("不支持的语句: " + ts.SyntaxKind[s.kind]);
    }

    // break → 最近可 break 的 label（循环或 switch；带 label 名则精确匹配）；continue → 最近的循环 label。
    // break/continue 跨 try-finally：被退出循环内层的 finally 必须先执行（JS 语义）。
    _jumpOut(label, isBreak) {
        const st = this._finallyStack;
        if (st && st.length && this.labels.length) {
            let idx = -1;
            for (let i = this.labels.length - 1; i >= 0; i--) {
                const ok2 = label ? (this.labels[i].label === label && (isBreak ? this.labels[i].brk != null : this.labels[i].cont != null))
                                  : (isBreak ? this.labels[i].brk != null : this.labels[i].cont != null);
                if (ok2) { idx = i; break; }
            }
            for (let i = st.length - 1; i >= 0; i--) {
                if (st[i].labelsLen <= idx) break;                           // 该 finally 在目标循环之外
                const keep = this._finallyStack;
                this._finallyStack = st.slice(0, i);
                this.emitTaggedBlock(st[i].node);
                this._finallyStack = keep;
            }
        }
        this.m.br(isBreak ? this._breakRel(label) : this._contRel(label));
    }
    _breakRel(label) {
        for (let i = this.labels.length - 1; i >= 0; i--)
            if (label ? (this.labels[i].label === label && this.labels[i].brk != null) : this.labels[i].brk != null)
                return this.depth - this.labels[i].brk;
        throw new Error("break 不在循环/switch 内");
    }
    _contRel(label) {
        for (let i = this.labels.length - 1; i >= 0; i--)
            if (label ? (this.labels[i].label === label && this.labels[i].cont != null) : this.labels[i].cont != null)
                return this.depth - this.labels[i].cont;
        throw new Error("continue 不在循环内");
    }

    emitWhile(s) {
        this.m.block(); this.depth++;
        this.m.loop(); this.depth++;
        this.labels.push({ brk: this.depth - 1, cont: this.depth, label: this._curLabel() });
        this.emitExpr(s.expression !== undefined ? s.expression : s.condition);
        this.emitCond();
        this.m.i32Eqz();
        this.m.brIf(1);                     // 退出外层 block（条件为假）
        this.emitStmt(s.statement);
        this.m.br(0);                        // 继续 loop
        this.labels.pop();
        this.depth--; this.m.end();           // loop end
        this.depth--; this.m.end();           // block end
    }

    emitFor(s) {
        if (s.initializer) {
            if (ts.isVariableDeclarationList(s.initializer)) { for (const d of s.initializer.declarations) { if (d.initializer) { this.emitExpr(d.initializer); this.m.localSet(this._local(d.name.text)); } } }
            else { this.emitExpr(s.initializer); this.m.drop(); }
        }
        // 结构：block(brk) loop block(cont) body end; incrementor; br 0 end end
        // continue 跳到 incrementor 前（cont block 末尾），否则会跳过 incrementor → 死循环。
        this.m.block(); this.depth++;
        this.m.loop(); this.depth++;
        if (s.condition) { this.emitExpr(s.condition); this.emitCond(); this.m.i32Eqz(); this.m.brIf(1); }
        this.m.block(); this.depth++;
        this.labels.push({ brk: this.depth - 2, cont: this.depth, label: this._curLabel() });
        if (s.statement) this.emitStmt(s.statement);
        this.labels.pop();
        this.depth--; this.m.end();                       // end cont block
        if (s.incrementor) { this.emitExpr(s.incrementor); this.m.drop(); }
        this.m.br(0);
        this.depth--; this.m.end();                       // end loop
        this.depth--; this.m.end();                       // end brk block
    }

    // do { body } while (cond)：continue 跳条件判断（不跳 body 顶）。
    // 结构：block(brk) loop block(cont) body end; cond ? br 0 : 落 end end
    emitDoWhile(s, tagged) {
        const M = this.m;
        const saveSlot = tagged ? this._arenaLoopEnter(s.statement || s) : undefined;
        M.block(); this.depth++;
        M.loop(); this.depth++;
        M.block(); this.depth++;
        this.labels.push({ brk: this.depth - 2, cont: this.depth, label: this._curLabel() });
        if (tagged) { const cap = this._loopCaptured([], s.statement || s);   // do-while 体内 let/const 被闭包捕获 → 每迭代新绑定
            if (cap) this._emitPerIterEnv(cap.headerNames, cap.bodyNames);
            this.emitTaggedStmt(s.statement); } else this.emitStmt(s.statement);
        this.labels.pop();
        this.depth--; M.end();                             // end cont block
        this._arenaLoopLeave(saveSlot);                    // continue 也经过此处
        if (tagged) this.emitCondI32(s.expression !== undefined ? s.expression : s.condition);
        else { this.emitExpr(s.expression !== undefined ? s.expression : s.condition); this.emitCond(); }
        M.brIf(0);                                         // 条件真 → 回 loop 顶
        this.depth--; M.end();                             // end loop
        this.depth--; M.end();                             // end brk block
    }

    // ---------- 表达式（number 域） ----------
    emitExpr(e) {
        if (ts.isNumericLiteral(e)) { this.m.f64Const(Number(e.text)); return; }
        // num 模式 bool 值就是 f64 0/1（boolean[] 用 f64 存，见 numArrNames）。
        if (e.kind === ts.SyntaxKind.TrueKeyword) { this.m.f64Const(1); return; }
        if (e.kind === ts.SyntaxKind.FalseKeyword) { this.m.f64Const(0); return; }
        if (ts.isIdentifier(e)) {
            const idx = this._local(e.text);
            if (idx !== undefined) { this.m.localGet(idx); return; }
            /* 模块级变量存在 i64 tagged 全局里（无独立 f64 全局）。num 模式读 number 型模块级
             * 变量按位重解释：tagged number 的 i64 位型就是 f64 本身。 */
            const g = this.moduleGlobals && this.moduleGlobals.get(e.text);
            if (g !== undefined) { this.m.globalGet(g); this.m.f64ReinterpretI64(); return; }
            throw new Error("未定义变量: " + e.text);
        }
        if (ts.isParenthesizedExpression(e)) { this.emitExpr(e.expression); return; }
        // 纯类型层构造（运行时恒等，TS 会在 emit 前擦除）→ 直接透传表达式：
        // `as T` / `x!` / `e satisfies T` / 尖括号断言 `<T>e`（≡ as）。
        if (ts.isAsExpression(e) || ts.isNonNullExpression(e)
            || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) { this.emitExpr(e.expression); return; }
        if (ts.isPrefixUnaryExpression(e)) {
            // ++/-- 需先判是否自增自减
            if (ts.isIdentifier(e.operand) && (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken)) {
                const idx = this._local(e.operand.text);
                const g = idx === undefined ? (this.moduleGlobals && this.moduleGlobals.get(e.operand.text)) : undefined;
                if (idx === undefined && g === undefined) throw new Error("未定义变量: " + e.operand.text);
                const dec = e.operator === ts.SyntaxKind.MinusMinusToken;
                if (g !== undefined) { this.m.globalGet(g); this.m.f64ReinterpretI64(); }
                else this.m.localGet(idx);
                this.m.f64Const(1); dec ? this.m.f64Sub() : this.m.f64Add();
                if (g !== undefined) {
                    this.m.localSet(this.scratchA);
                    this.m.localGet(this.scratchA); this.m.i64ReinterpretF64(); this.m.globalSet(g);
                    this.m.localGet(this.scratchA);
                } else this.m.localTee(idx);
                return;
            }
            this.emitExpr(e.operand);
            if (e.operator === ts.SyntaxKind.MinusToken) { this.m.f64Neg(); }
            else if (e.operator === ts.SyntaxKind.PlusToken) { /* noop: +number 恒等 */ }
            else if (e.operator === ts.SyntaxKind.ExclamationToken) { this.emitCond(); this.m.i32Eqz(); this.m.f64ConvertI32S(); }   // !x = !ToBoolean(x)：NaN/0/-0 为假（emitCond 已排除 NaN）
            else if (e.operator === ts.SyntaxKind.TildeToken) { this.m.i32TruncF64S(); this.m.i32Const(-1); this.m.i32Xor(); this.m.f64ConvertI32S(); }   // ~x = ~ToInt32(x)，32 位语义
            else throw new Error("不支持的一元运算符: " + ts.SyntaxKind[e.operator]);
            return;
        }
        if (ts.isPostfixUnaryExpression(e)) {
            const idx = this._local(e.operand.text);
            const g = idx === undefined ? (this.moduleGlobals && this.moduleGlobals.get(e.operand.text)) : undefined;
            if (idx === undefined && g === undefined) throw new Error("未定义变量: " + e.operand.text);
            const dec = e.operator === ts.SyntaxKind.MinusMinusToken;
            if (g !== undefined) {                       // x++ 的表达式值是**旧值**（先压旧值再更新）
                this.m.globalGet(g); this.m.f64ReinterpretI64(); this.m.localTee(this.scratchA);
                this.m.f64Const(1); dec ? this.m.f64Sub() : this.m.f64Add();
                this.m.i64ReinterpretF64(); this.m.globalSet(g);
                this.m.localGet(this.scratchA);
                return;
            }
            // x++：栈留旧值（localTee scratch），x 更新
            this.m.localGet(idx); this.m.localTee(this.scratch);
            this.m.localGet(idx); this.m.f64Const(1); dec ? this.m.f64Sub() : this.m.f64Add(); this.m.localSet(idx);
            return;
        }
        if (ts.isBinaryExpression(e)) { this.emitBinary(e); return; }
        if (ts.isConditionalExpression(e)) {
            this.emitExpr(e.condition); this.emitCond();
            this.m.ifBlock("f64"); this.depth++;
            this.emitExpr(e.whenTrue);
            this.m.else_(); this.emitExpr(e.whenFalse);
            this.m.end(); this.depth--;
            return;
        }
        if (ts.isCallExpression(e)) {
            // Math.* 单参内建 → 直接映射 wasm f64 指令（无宿主往返）。
            // 必须在 _nsMember 之前：Math 是宿主全局对象，不在 import 命名空间表里。
            // 缺这一段时 Math.sqrt(x) 只能走 tagged（属性访问）→ 整个函数掉出快路径。
            if (ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)
                && e.expression.expression.text === "Math") {
                const f64Op = {
                    sqrt: "f64Sqrt", abs: "f64Abs", floor: "f64Floor", ceil: "f64Ceil",
                    trunc: "f64Trunc", round: "f64Nearest",
                }[e.expression.name.text];
                if (!f64Op) throw new Error("不支持的 Math 成员: " + e.expression.name.text);
                this.emitExpr(e.arguments[0]); this.m[f64Op](); return;
            }
            // num 数组 a.push(v)：bump 扩容（len==cap 时 qz_numarr_grow）+ f64Store + len++。
            if (ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)
                && e.expression.name.text === "push") {
                const na = this._numArr.get(e.expression.expression.text);
                if (na) {
                    this.emitExpr(e.arguments[0]); this.m.localSet(this.scratchA);   // 保存 val
                    // if len == cap: base = qz_numarr_grow(base, len)
                    this.m.localGet(na.len);
                    this.m.localGet(na.base); this.m.i32Const(8); this.m.i32Sub(); this.m.i32Load(2, 0);
                    this.m.i32Eq(); this.m.ifBlock("void");
                        this.m.localGet(na.base); this.m.localGet(na.len); this.m.call("qz_numarr_grow");
                        this.m.localSet(na.base);
                    this.m.end();
                    // store val at base + len*8
                    this.m.localGet(na.base); this.m.localGet(na.len); this.m.i32Const(3); this.m.i32Shl(); this.m.i32Add();
                    this.m.localGet(this.scratchA); this.m.f64Store(3, 0);
                    // len++
                    this.m.localGet(na.len); this.m.i32Const(1); this.m.i32Add(); this.m.localSet(na.len);
                    // push 返回新长度（f64）
                    this.m.localGet(na.len); this.m.f64ConvertI32S();
                    return;
                }
            }
            // 内联零参箭头函数：rnd() → 直接 emit body（funcMode 已验证安全）。
            if (ts.isIdentifier(e.expression) && this._inlineArrows && this._inlineArrows.has(e.expression.text)) {
                const arrow = this._inlineArrows.get(e.expression.text);
                if (ts.isBlock(arrow.body)) {
                    const stmts = arrow.body.statements;
                    for (let i = 0; i < stmts.length - 1; i++) this.emitStmt(stmts[i]);
                    const last = stmts[stmts.length - 1];
                    this.emitExpr(last.expression);   // return expr → 栈顶
                } else {
                    this.emitExpr(arrow.body);   // 表达式体
                }
                return;
            }
            let fn;
            if (ts.isIdentifier(e.expression)) fn = e.expression.text;
            else if (ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)) {
                const resolved = this._nsMember(e.expression.expression.text, e.expression.name.text);
                if (resolved === undefined) throw new Error("不支持的调用目标");
                fn = resolved;
            } else throw new Error("不支持的调用目标");
            const ciNum = this._calleeInfo(fn);
            const xNum = ciNum && ciNum.mode !== this.mode;
            for (const a of e.arguments) { this.emitExpr(a); if (xNum) this._argToCallee(fn); }
            this.m.call(this._fnName(fn));
            this._retFromCallee(fn);
            return;
        }
        // num 数组 a[i] 读 → f64Load(base + i*8)
        if (ts.isElementAccessExpression(e) && ts.isIdentifier(e.expression)) {
            const na = this._numArr.get(e.expression.text);
            if (na) {
                this.m.localGet(na.base);
                this.emitExpr(e.argumentExpression); this.m.i32TruncF64S();
                this.m.i32Const(3); this.m.i32Shl(); this.m.i32Add();
                this.m.f64Load(3, 0);
                return;
            }
        }
        // num 数组 a.length → len（f64）
        if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)
            && e.name.text === "length") {
            const na = this._numArr.get(e.expression.text);
            if (na) { this.m.localGet(na.len); this.m.f64ConvertI32S(); return; }
        }
        if (ts.isAwaitExpression(e)) throw new Error("[tagged] await 出现在非 async 编译路径：wasm 无挂起/恢复（顶层 async 已转 interp）");
        throw new Error("不支持的表达式: " + ts.SyntaxKind[e.kind]);
    }

    emitBinary(e) {
        const op = e.operatorToken.kind;
        // 赋值：x = rhs → localTee（保留值供表达式上下文）；x op= rhs → 读-算-写
        const assignOps = { [ts.SyntaxKind.EqualsToken]: null, [ts.SyntaxKind.AsteriskAsteriskEqualsToken]: ts.SyntaxKind.AsteriskAsteriskToken, [ts.SyntaxKind.PlusEqualsToken]: ts.SyntaxKind.PlusToken, [ts.SyntaxKind.MinusEqualsToken]: ts.SyntaxKind.MinusToken, [ts.SyntaxKind.AsteriskEqualsToken]: ts.SyntaxKind.AsteriskToken, [ts.SyntaxKind.SlashEqualsToken]: ts.SyntaxKind.SlashToken, [ts.SyntaxKind.PercentEqualsToken]: ts.SyntaxKind.PercentToken, [ts.SyntaxKind.LessThanLessThanEqualsToken]: ts.SyntaxKind.LessThanLessThanToken, [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanToken, [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, [ts.SyntaxKind.AmpersandEqualsToken]: ts.SyntaxKind.AmpersandToken, [ts.SyntaxKind.BarEqualsToken]: ts.SyntaxKind.BarToken, [ts.SyntaxKind.CaretEqualsToken]: ts.SyntaxKind.CaretToken };
        if (Object.prototype.hasOwnProperty.call(assignOps, op)) {
            // num 数组 a[i] = v / a[i] op= v → f64Store(base + i*8, val)
            if (ts.isElementAccessExpression(e.left) && ts.isIdentifier(e.left.expression)) {
                const na = this._numArr.get(e.left.expression.text);
                if (na) {
                    const binop = assignOps[op];
                    // f64Store 需要 [addr:i32, val:f64]（addr 在底，val 在顶）。
                    // 保存值到 scratchA(f64)，地址到 swIdx(i32)，再 store + 留结果。
                    if (binop !== null) {
                        // a[i] op= v：存地址 → 读旧值 → 算 → 存结果
                        this.m.localGet(na.base);
                        this.emitExpr(e.left.argumentExpression); this.m.i32TruncF64S();
                        this.m.i32Const(3); this.m.i32Shl(); this.m.i32Add();
                        this.m.localSet(this.swIdx);                        // addr → i32 temp
                        this.m.localGet(this.swIdx); this.m.f64Load(3, 0);  // old a[i]
                        this.emitExpr(e.right);
                        this.emitBinaryOp(binop);
                    } else {
                        // a[i] = v：存值 → 算地址 → store
                        this.emitExpr(e.right);
                    }
                    this.m.localSet(this.scratchA);                        // val → f64 temp
                    this.m.localGet(na.base);
                    this.emitExpr(e.left.argumentExpression); this.m.i32TruncF64S();
                    this.m.i32Const(3); this.m.i32Shl(); this.m.i32Add();  // addr
                    this.m.localGet(this.scratchA); this.m.f64Store(3, 0);
                    this.m.localGet(this.scratchA);                        // 表达式结果
                    return;
                }
            }
            if (!ts.isIdentifier(e.left)) throw new Error("赋值左值必须是标识符");
            const idx = this._local(e.left.text);
            /* 模块级变量（num 模式）：读旧值（binop）→ 算 → f64→i64 位型写回全局。
             * 此前只查 _local → 直接抛「未定义变量」（let g = 0; g = 5 编译失败）。 */
            const gidx = idx === undefined ? (this.moduleGlobals && this.moduleGlobals.get(e.left.text)) : undefined;
            if (idx === undefined && gidx === undefined) throw new Error("未定义变量: " + e.left.text);
            const binop = assignOps[op];
            if (binop !== null) {
                if (gidx !== undefined) { this.m.globalGet(gidx); this.m.f64ReinterpretI64(); }
                else this.m.localGet(idx);
                this.emitExpr(e.right);
                this.emitBinaryOp(binop);
            } else {
                this.emitExpr(e.right);
            }
            /* globalSet 消耗栈顶 → 先存临时 local，写全局后再压回（赋值表达式结果为 f64）。 */
            if (gidx !== undefined) {
                this.m.localSet(this.scratchA);                      // f64 暂存（赋值表达式结果）
                this.m.localGet(this.scratchA); this.m.i64ReinterpretF64(); this.m.globalSet(gidx);
                this.m.localGet(this.scratchA);
            } else this.m.localTee(idx);
            return;
        }
        // ?? / ??=：num 模式值恒为 f64（永非 null/undefined）→ a ?? b = a、a ??= b 不变。
        // 右操作数不求值（JS：a 非空则 b 不求值）——短路语义精确。
        if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
            this.emitExpr(e.left);
            return;
        }
        // / truthy(a) ? b : a（&&）。左侧仅求值一次（左值恒为标识符，cache local 即可）。
        if (op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
            if (!ts.isIdentifier(e.left)) throw new Error("赋值左值必须是标识符");
            const idx = this._local(e.left.text);
            const g = idx === undefined ? (this.moduleGlobals && this.moduleGlobals.get(e.left.text)) : undefined;
            if (idx === undefined && g === undefined) throw new Error("未定义变量: " + e.left.text);
            const isAnd = op === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
            // 全局路径经 i64↔f64 位型重解释；局部路径保持 localTee 一步到位。
            const pushA = () => { if (g !== undefined) { this.m.globalGet(g); this.m.f64ReinterpretI64(); } else this.m.localGet(idx); };
            const popA = () => { if (g !== undefined) { this.m.i64ReinterpretF64(); this.m.globalSet(g); } else this.m.localSet(idx); };
            const popAKeep = () => {
                if (g !== undefined) {
                    this.m.localSet(this.scratchA);
                    this.m.localGet(this.scratchA); this.m.i64ReinterpretF64(); this.m.globalSet(g);
                    this.m.localGet(this.scratchA);
                } else this.m.localTee(idx);
            };
            this.m.block("f64");                              // block(result f64)
            pushA();                                          // [a]
            this.m.localTee(this.scratch);                    // scratch=a；栈 [a]（短路时作块结果）
            this.m.localGet(this.scratch); this.emitCond();   // [a, truthy(a)]
            if (isAnd) this.m.i32Eqz();                       // && : falsy(a) → 跳出（返回 a）
            this.m.brIf(0);                                   // 条件真（|| 的 a 真 / && 的 a 假）→ 返回 a
            this.m.drop();                                    // 落下路径丢弃 a
            this.emitBinaryOperandValue(e.right);             // 仅此路径求值 b
            this.m.localSet(this.scratchA);                   // b → 暂存（下一句写回会消耗栈顶）
            this.m.localGet(this.scratchA); popA();           // 副作用：a = b
            this.m.localGet(this.scratchA);                   // 块结果 = b
            this.m.end(); popAKeep();                         // 写回 a，栈留结果值
            return;
        }

        // 短路逻辑（**真短路 + 值语义**，JS 精确）：
        //  a && b ≡ truthy(a) ? b : a   a || b ≡ truthy(a) ? a : b
        // 关键：b 只在短路决策需要时才求值（副作用语义）；结果保留操作数原值而非 0/1。
        if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
            const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
            this.m.block("f64");                              // block(result f64)
            this.emitBinaryOperandValue(e.left);              // [a]
            this.m.localTee(this.scratch);                    // scratch=a；栈 [a]（短路时作块结果）
            this.m.localGet(this.scratch); this.emitCond();   // [a, truthy(a)]
            if (isAnd) this.m.i32Eqz();                       // && : falsy(a) → 跳出（返回 a）
            this.m.brIf(0);                                   // 短路条件真 → 返回 a
            this.m.drop();                                    // 落下路径丢弃 a
            this.emitBinaryOperandValue(e.right);             // 仅此路径求值 b
            this.m.end();                                     // 块结果 = b
            return;
        }
        this.emitBinaryOperandValue(e.left);
        this.emitBinaryOperandValue(e.right);
        this.emitBinaryOp(op);
    }
    // 条件求值：栈顶 f64 → i32（truthy）。JS ToBoolean(number): false iff 0/-0/NaN。
    // (x != 0) 排除 0/-0（IEEE: -0==0）；(x == x) 排除 NaN（IEEE: NaN≠NaN → eq=false）。AND = truthy。
    // 此前仅 `x != 0` → NaN 误判 truthy（NaN≠0 为 true）→ `NaN ? 1 : 7` 得 1 而非 7。
    emitCond() {
        this.m.localSet(this.scratchA);
        this.m.localGet(this.scratchA); this.m.f64Const(0); this.m.f64Ne();        // x != 0
        this.m.localGet(this.scratchA); this.m.localGet(this.scratchA); this.m.f64Eq();  // x == x
        this.m.i32And();
    }
    emitBinaryOperandValue(e) { if (ts.isBinaryExpression(e)) this.emitBinary(e); else this.emitExpr(e); }
    emitBinaryOp(op) {
        switch (op) {
            case ts.SyntaxKind.PlusToken: this.m.f64Add(); break;
            case ts.SyntaxKind.MinusToken: this.m.f64Sub(); break;
            case ts.SyntaxKind.AsteriskToken: this.m.f64Mul(); break;
            case ts.SyntaxKind.SlashToken: this.m.f64Div(); break;
            case ts.SyntaxKind.PercentToken: this.emitRem(); break;
            case ts.SyntaxKind.LessThanToken: this.m.f64Lt(); this.m.f64ConvertI32S(); break;
            case ts.SyntaxKind.GreaterThanToken: this.m.f64Gt(); this.m.f64ConvertI32S(); break;
            case ts.SyntaxKind.LessThanEqualsToken: this.m.f64Le(); this.m.f64ConvertI32S(); break;
            case ts.SyntaxKind.GreaterThanEqualsToken: this.m.f64Ge(); this.m.f64ConvertI32S(); break;
            case ts.SyntaxKind.EqualsEqualsToken: case ts.SyntaxKind.EqualsEqualsEqualsToken: this.m.f64Eq(); this.m.f64ConvertI32S(); break;
            case ts.SyntaxKind.ExclamationEqualsToken: case ts.SyntaxKind.ExclamationEqualsEqualsToken: this.m.f64Ne(); this.m.f64ConvertI32S(); break;
            // 位运算：JS 语义 32 位整数 → i32 截断、运算、回 f64（>>> 无符号）
            case ts.SyntaxKind.AmpersandToken: this.emitBitI32(() => this.m.i32And(), false); break;
            case ts.SyntaxKind.BarToken: this.emitBitI32(() => this.m.i32Or(), false); break;
            case ts.SyntaxKind.CaretToken: this.emitBitI32(() => this.m.i32Xor(), false); break;
            case ts.SyntaxKind.LessThanLessThanToken: this.emitBitI32(() => this.m.i32Shl(), false); break;
            case ts.SyntaxKind.GreaterThanGreaterThanToken: this.emitBitI32(() => this.m.i32ShrS(), false); break;
            case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: this.emitBitI32(() => this.m.i32ShrU(), true); break;
            // **：wasm 无原生 f64.pow → 宿主 import（Math.pow 语义含 NaN/0 幂特例）
            case ts.SyntaxKind.AsteriskAsteriskToken: this.m.call("qz.math_pow"); break;
            default: throw new Error("不支持的二元运算符: " + ts.SyntaxKind[op]);
        }
    }
    // 栈: a b（f64 f64）→ i32 op → f64。unsigned: >>> 结果按无符号回 f64。
    emitBitI32(opFn, unsigned) {
        // 栈: a b（f64 f64）→ 存 b、a（各自 trunc 到 i32 再存）→ 取 a、b → op → f64
        this.m.i32TruncF64S(); this.m.f64ConvertI32S(); this.m.localSet(this.scratchB);
        this.m.i32TruncF64S(); this.m.f64ConvertI32S(); this.m.localSet(this.scratchA);
        this.m.localGet(this.scratchA); this.m.i32TruncF64S();
        this.m.localGet(this.scratchB); this.m.i32TruncF64S();
        opFn();
        unsigned ? this.m.f64ConvertI32U() : this.m.f64ConvertI32S();
    }

    // f64 取模：JS Number::remainder 语义（wasm 无 f64.rem）。路径：
    //   |b|==Inf → a（JS: x % ±Inf = x）
    //   q=a/b 非有限（NaN/±Inf：0 除、差溢出如 1e308%1e-308、NaN 输入）→ 宿主 qz.math_rem
    //     （唯一全精度途径：fmod 处理差溢出、subnormal 余数）
    //   否则 r = a - b*trunc(q)；r==0 时符号随 a（JS -2%2=-0、2%2=+0）→ a*0（copysign）
    //   a 压缩底保号：先压 a 后 b*trunc 再 sub —— 不经 f64Neg（它会把 +0 翻成 -0）。
    emitRem() {
        const M = this.m;
        // 弹入 local（栈不残留）：入口 [a b] → []（A=a, B=b）
        M.localSet(this.scratchB);             // 弹 b
        M.localSet(this.scratchA);             // 弹 a
        M.localGet(this.scratchB); M.f64Neg(); M.localGet(this.scratchB); M.f64Max();   // |b|
        M.f64Const(Infinity); M.f64Eq();
        M.ifBlock("f64");
        M.localGet(this.scratchA);             // |b|==Inf → a
        M.else_();
        M.localGet(this.scratchA); M.localGet(this.scratchB); M.f64Div();
        M.localSet(this.scratch);              // T=q
        // q 非有限 → 宿主（除零、NaN、差溢出）
        M.localGet(this.scratch); M.localGet(this.scratch); M.f64Ne();                  // qNaN
        M.localGet(this.scratch); M.f64Neg(); M.localGet(this.scratch); M.f64Max();
        M.f64Const(Infinity); M.f64Eq();       // |q|==Inf
        M.i32Or();
        M.ifBlock("f64");
        M.localGet(this.scratchA); M.localGet(this.scratchB); M.call("qz.math_rem");
        M.else_();
        M.localGet(this.scratchA);             // [a]（保底给最终 sub）
        M.localGet(this.scratchB);             // [a b]
        M.localGet(this.scratch); M.f64Trunc();// [a b trunc(q)]
        M.f64Mul();                            // [a b*trunc]
        M.f64Sub();                            // [a - b*trunc] = r
        // 零余数符号随被除数：r==0 → a*0
        M.localSet(this.scratch);              // T=r
        M.localGet(this.scratchA); M.f64Const(0); M.f64Mul();   // [a*0]
        M.localGet(this.scratch);              // [a*0 r]
        M.localGet(this.scratch); M.f64Const(0); M.f64Eq();     // [a*0 r r==0]
        M.select();                            // r==0 ? a*0 : r
        M.end();
        M.end();
    }
}

module.exports = { Emitter };
