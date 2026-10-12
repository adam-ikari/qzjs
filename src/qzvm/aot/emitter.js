#!/usr/bin/env node
/* emitter.js — tsc AST → wasm 发射器。
 * 值模型（双模式）：
 *   num 快路径（参数全 number 注解）：值 = 裸 f64 local，算术走原生 wasm 指令（零跨界）。
 *   tagged 动态路径（含 unknown/对象/字符串）：值 = i64，经 qz.* import。
 *     f64 NaN-box：数值=原始 f64 位型，句柄=高16位0x7FF9|低32 offset；字段 8 字节。
 *     与宿主字长无关（wasm f64 恒 double），32/64 位设备共用，见 PORTABILITY_32BIT.md。
 *
 * 控制流用 wasm 栈式惯用法：
 *   if:      <cond> if(t) <then> else <else> end
 *   while:   block loop <cond> i32.eqz br_if(1) <body> br(0) end end
 *   for:     <init> block loop <cond> i32.eqz br_if(1) <body> <update> br(0) end end
 *   break → br(block 深度)；continue → br(loop 深度)
 */
"use strict";
const ts = require("typescript");
const fs = require("fs");
const path = require("path");
const { Module } = require("./wasm-encoder.js");

// ---------- qz.* import 注册（tagged 模式运行时） ----------
// 值恒 i64：数值=原始 f64 位型（NaN-box），句柄=高16位0x7FF9|低32 offset。
// 该表示与宿主字长无关（wasm f64 恒 IEEE-754 double；32 位宿主由 wamrc 降到软/硬浮点），
// 故 32/64 位设备共用，无需按目标位宽换表示。
// alloc 偏移 / 字段名 id 仍 i32；truthy 返回裸 i32（0/1）供 wasm 条件直接用。
const QZ = {
  alloc:  { params: ["i32"],  results: ["i32"] },
  object_new:   { params: [],             results: ["i64"] },
  object_set:   { params: ["i64", "i32", "i64"], results: [] },
  object_get:   { params: ["i64", "i32"], results: ["i64"] },
  string_new:   { params: ["i32"],        results: ["i64"] },
  string_concat:{ params: ["i64", "i64"], results: ["i64"] },
  add:  { params: ["i64", "i64"], results: ["i64"] },
  sub:  { params: ["i64", "i64"], results: ["i64"] },
  mul:  { params: ["i64", "i64"], results: ["i64"] },
  div:  { params: ["i64", "i64"], results: ["i64"] },
  rem:  { params: ["i64", "i64"], results: ["i64"] },
  lt:   { params: ["i64", "i64"], results: ["i64"] },
  gt:   { params: ["i64", "i64"], results: ["i64"] },
  le:   { params: ["i64", "i64"], results: ["i64"] },
  ge:   { params: ["i64", "i64"], results: ["i64"] },
  seq:  { params: ["i64", "i64"], results: ["i64"] },
  sne:  { params: ["i64", "i64"], results: ["i64"] },
  truthy: { params: ["i64"], results: ["i32"] },
  str_len: { params: ["i64"], results: ["i64"] },
  log:  { params: ["i64"], results: [] },
  band: { params: ["i64", "i64"], results: ["i64"] },
  bor:  { params: ["i64", "i64"], results: ["i64"] },
  bxor: { params: ["i64", "i64"], results: ["i64"] },
  shl:  { params: ["i64", "i64"], results: ["i64"] },
  shr:  { params: ["i64", "i64"], results: ["i64"] },
  ushr: { params: ["i64", "i64"], results: ["i64"] },
  // 字符串方法：recv + 方法名 id + 2 参（缺省 = undefined 句柄）→ 结果字符串句柄（0x7FF9）。
  // 走 JS 回退（正确处理 UTF-8/UTF-16 语义）；结果 join handles 表，toJS 还原为 JS string。
  str_method: { params: ["i64", "i32", "i64", "i64"], results: ["i64"] },
  // 闭包调用：closure_call(句柄, a0, a1, a2, a3) → i64。JS 侧按句柄内 funcidx
  // 跳 __lam_N（wasm 导出），最多 4 参（缺省 undefined 句柄）。返回 tagged 值。
  closure_call: { params: ["i64", "i64", "i64", "i64", "i64"], results: ["i64"] },
  // 通用方法调用回退：method_call(recv, mid, a0, a1, a2, a3) → i64。
  // qz 侧按 recv 类型派发：字符串 → str_method 逻辑；类实例（内存 [0]=__cls≠0）→
  // 按 classMeta[clsId].methods[mid]（含继承链）调 wasm 导出 __m_<C>$<m>(recv, a0..a3)。
  // 最多 4 参（缺省 undefined 句柄）。wasm 侧仅在静态可判定 owner 时直调，否则走此回退。
  // 类实例分配：newobj(sizeBytes:i32, clsId:i32) → 实例句柄(i64)。bump 分配，写 [0]=clsId。
  newobj: { params: ["i32", "i32"], results: ["i64"] },
  method_call: { params: ["i64", "i32", "i64", "i64", "i64", "i64"], results: ["i64"] },
};
function registerQz(m) { for (const k of Object.keys(QZ)) m.importFn("qz", k, QZ[k].params, QZ[k].results); return m; }

// 类方法/构造器在函数名中的编码（内部前缀，避免与用户函数名冲突）。
const MTH_PREFIX = "__m_";
function ctorName(cls) { return MTH_PREFIX + cls + "$ctor"; }
function methName(cls, m) { return MTH_PREFIX + cls + "$" + m; }
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
    }
    _local(name) { return this.varMap.get(name); }
    // 取出并消费栈顶 label：一个 label 只修饰其直接子循环。嵌套循环 push 时各取各的。
    _curLabel() { return this._labelStack.length ? this._labelStack.pop() : null; }

    // 收集函数体里的 let/const（分配 local 索引）
    _collectLocals(node) {
        const names = [];
        const walk = (n) => {
            if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) names.push(n.name.text);
            ts.forEachChild(n, walk);
        };
        walk(node);
        return names;
    }

    // 收集函数体内所有箭头函数/函数表达式（含嵌套），按源序。返回节点列表。
    _collectLambdas(node, out = []) {
        const walk = (n) => {
            if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) { out.push(n); }
            ts.forEachChild(n, walk);
        };
        walk(node);
        return out;
    }
    // 闭包捕获分析：找 lambda 体内的自由标识符（非其参数/局部、非字符串/数字/对象属性名）。
    // 捕获的变量来自创建处（外层函数局部）。返回有序捕获名列表。
    _capturesOf(lam) {
        const local = new Set(lam.parameters.map(p => p.name.text));
        this._collectLocals(lam.body).forEach(n => local.add(n));
        const out = [];
        const seen = new Set();
        const walk = (n) => {
            if (ts.isIdentifier(n)) {
                // 跳过成员表达式右侧（obj.prop 的 prop 不是变量）
                if (n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) return;
                if (n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name === n) return;
                const name = n.text;
                if (!local.has(name) && !seen.has(name) && !this.fnNames.has(name)
                    && !/^(undefined|null|NaN|Infinity)$/.test(name)) { seen.add(name); out.push(name); }
                return;
            }
            ts.forEachChild(n, walk);
        };
        walk(lam.body);
        return out;
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
                if (ts.isIdentifier(n.name) && n.initializer
                    && isNewIdent(n.initializer) && this.classes.has(n.initializer.expression.text)) {
                    const name = n.name.text, cls = n.initializer.expression.text;
                    if (declaredClass.has(name) && declaredClass.get(name) !== cls) declaredClass.set(name, null);
                    else declaredClass.set(name, cls);
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
            cur = c.parent && this.classes.has(c.parent) ? c.parent : null;
        }
        return null;
    }
    // 接收者静态类：标识符 → _staticVars；叶类方法体/构造器内的 `this` → _curClass。否则 null。
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
        if (this.capMap.has(name)) {
            M.localGet(this.blkLocal); M.i64Load(3, this.capMap.get(name) * 8);
            return;
        }
        const idx = this._local(name);
        if (idx === undefined) throw new Error("未定义捕获变量: " + name);
        M.localGet(idx);
    }

    // 统计函数体内 for-of 数量（按嵌套层各分配独立 local 对）
    _countForOf(node) {
        let n = 0;
        const walk = (x) => { if (ts.isForOfStatement(x)) n++; ts.forEachChild(x, walk); };
        walk(node);
        return n;
    }

    emitFunc(f) {
        const savedCurClass = this._curClass, savedCapActive = this.capListActive, savedStatic = this._staticVars;
        this._curClass = undefined; this.capListActive = false;
        const isVoid = !!f.type && f.type.kind === ts.SyntaxKind.VoidKeyword;
        this.mode = funcMode(f);
        // num 值 = f64；tagged 值 = i64（NaN-box，32/64 位统一）
        const vt = this.mode === "num" ? "f64" : "i64";
        const locals = this._collectLocals(f.body);
        const nLoc = f.parameters.length + locals.length;
        this.scratch = nLoc;                                 // scratch（后缀 ++/--）
        this.scratchA = nLoc + 1;                            // 暂存 a
        this.scratchB = nLoc + 2;                            // 暂存 b
        // tagged guard 快路径需 f64 浮点临时（值 local 是 i64）；num 模式 scratchA/B 本就是 f64
        const extra = this.mode === "tagged" ? ["f64", "f64"] : [];
        this.scratchFA = nLoc + 3; this.scratchFB = nLoc + 4;
        // 字符串逻辑临时（仅 tagged）：sT0..sT7 共 8 个 i32
        const sT = this.mode === "tagged" ? Array.from({ length: 8 }, () => "i32") : [];
        this.sT = this.mode === "tagged" ? Array.from({ length: 8 }, (_, i) => nLoc + 5 + i) : null;
        // 嵌套对象字面量的句柄临时槽（i64）：每层独立，避免内层覆盖外层句柄。
        const objPool = this.mode === "tagged" ? Array.from({ length: 8 }, () => "i64") : [];
        this.objBase = nLoc + 3 + extra.length + sT.length;
        this._objDepth = 0;
        // 尾部追加：sT(8×i32，tagged) + swIdx(i32) + forOf 对×(vt,i32)（每嵌套层独立）。
        this.swIdx = this.objBase + objPool.length;
        const nForOf = this._countForOf(f.body);
        this.forOfBase = this.swIdx + 1;
        this.forOfCount = 0;
        const forOfLocals = [];
        for (let i = 0; i < nForOf; i++) forOfLocals.push(vt, "i32");
        // 闭包保留槽（仅 tagged）：cloHandle(i64 存闭包句柄) + cloOff/cloBlk/cloFn(3×i32)。
        const cloSlots = this.mode === "tagged" ? ["i64", "i32", "i32", "i32", "i64", "i64", "i64", "i64"] : [];
        this.cloHandle = nLoc + 3 + extra.length + sT.length + objPool.length + 1 + nForOf * 2;
        this.cloOff = this.cloHandle + 1; this.cloBlk = this.cloHandle + 2; this.cloFn = this.cloHandle + 3;
        this.cloArgs = [this.cloHandle + 4, this.cloHandle + 5, this.cloHandle + 6, this.cloHandle + 7];
        this.cloSlotsLen = cloSlots.length;
        // debug：局部名数组（参数在前、局部在后，与 wasm local 序号一致）；仅命名可见变量，合成槽留空。
        const localNames = this.m.debug
            ? f.parameters.map(p => p.name.text).concat(locals)   // locals 是名字数组
            : null;
        this.m.startBody(f.name.text, locals.map(() => vt).concat([vt, vt, vt]).concat(extra).concat(sT).concat(objPool).concat(["i32"]).concat(forOfLocals).concat(cloSlots), localNames);
        // 参数 → local 0..n-1；局部 → n..
        f.parameters.forEach((p, i) => this.varMap.set(p.name.text, i));
        locals.forEach((n, i) => this.varMap.set(n, f.parameters.length + i));
        this.depth = 0; this.labels = [];
        this._staticVars = this.mode === "tagged" ? this._computeStaticVars(f.body, f.parameters.map(p => p.name.text)) : new Map();
        if (this.mode === "tagged") this.emitTaggedBlock(f.body);
        else this.emitBlock(f.body);
        // 末尾非 return 且函数有返回值 → fallthrough 路径缺值（穷尽 switch/if-else 全 return）。
        // 合法代码不会到达；补 unreachable 满足 wasm 验证。
        const last = f.body.statements[f.body.statements.length - 1];
        if (!isVoid && !(last && ts.isReturnStatement(last))) this.m.unreachable();
        this.m.endBody();
        this.m.exportFn(f.name.text, f.name.text);
        this.varMap.clear();
        this._curClass = savedCurClass; this.capListActive = savedCapActive; this._staticVars = savedStatic;
    }


    // ---------- 闭包（lambda 提升 + 捕获 cell）----------
    // 每个箭头/函数表达式提升为一个 wasm 函数 __lam_N。签名 = (blk:i32, 参数…i64) -> i64。
    // 捕获变量存在堆 cell 块（blk 指向 [i64 × captures]，对象布局），读经 capMap、写回 store。
    emitLambda(lam, id) {
        const fname = "__lam_" + id;
        const params = lam.parameters.map(p => p.name.text);
        // 捕获名先分析并记录（emitLambdaBody 内 identifier 读写用 capMap 路由）
        const caps = this._capturesOf(lam);
        this._lamById.set(lam, { id, fname, caps, n: params.length });
        this.m.declareFunc(fname, ["i32"].concat(params.map(() => "i64")), ["i64"]);
        this._pendingLambdas.push({ lam, fname, params, caps });
        return { fname, caps };
    }
    // 发射已登记的 lambda 体（阶段2，在所有顶层函数之后；签名已登记）
    emitLambdaBodies() {
        for (const p of this._pendingLambdas) this._emitLambdaBody(p);
        this._pendingLambdas = [];
    }
    _emitLambdaBody({ lam, fname, params, caps }) {
        const M = this.m;
        const savedMap = this.varMap, savedCap = this.capMap, savedBlk = this.blkLocal;
        const savedMode = this.mode, savedDepth = this.depth, savedStatic = this._staticVars;
        this.mode = "tagged";
        // locals：用户局部（i64）+ scratch 系列同 emitFunc tagged 布局
        const locals = this._collectLocals(lam.body);
        const nParams = 1 + params.length;                 // blk + 参数
        const nLoc = nParams + locals.length;
        this.varMap = new Map();
        lam.parameters.forEach((p, i) => this.varMap.set(p.name.text, 1 + i));
        locals.forEach((n, i) => this.varMap.set(n, nParams + i));
        this.capMap = new Map();
        caps.forEach((n, i) => this.capMap.set(n, i));     // 捕获名 → blk 内 i64 槽序
        this.blkLocal = 0;                                 // local 0 = blk 指针
        this.scratch = nLoc;
        this.scratchA = nLoc + 1;
        this.scratchB = nLoc + 2;
        const extra = ["f64", "f64"];
        this.scratchFA = nLoc + 3; this.scratchFB = nLoc + 4;
        const sT = Array.from({ length: 8 }, () => "i32");
        this.sT = Array.from({ length: 8 }, (_, i) => nLoc + 5 + i);
        const objPool = Array.from({ length: 8 }, () => "i64");
        this.objBase = nLoc + 3 + extra.length + sT.length;
        this._objDepth = 0;
        this.swIdx = this.objBase + objPool.length;
        const nForOf = this._countForOf(lam.body);
        this.forOfBase = this.swIdx + 1;
        this.forOfCount = 0;
        const forOfLocals = [];
        for (let i = 0; i < nForOf; i++) forOfLocals.push("i64", "i32");
        const cloSlots = ["i64", "i32", "i32", "i32", "i64", "i64", "i64", "i64"];
        this.cloHandle = nLoc + 3 + extra.length + sT.length + objPool.length + 1 + nForOf * 2;
        this.cloOff = this.cloHandle + 1; this.cloBlk = this.cloHandle + 2; this.cloFn = this.cloHandle + 3;
        this.cloArgs = [this.cloHandle + 4, this.cloHandle + 5, this.cloHandle + 6, this.cloHandle + 7];
        this.cloSlotsLen = cloSlots.length;
        const bodyLocals = locals.map(() => "i64").concat(["i64", "i64", "i64"]).concat(extra).concat(sT).concat(objPool).concat(["i32"]).concat(forOfLocals).concat(cloSlots);
        const localNames = this.m.debug ? ["blk"].concat(params).concat(locals) : null;
        M.startBody(fname, bodyLocals, localNames);
        this.depth = 0; this.labels = []; this._tryStack = []; this._labelStack = [];
        this._staticVars = this._computeStaticVars(lam.body, params);
        // 箭头表达式体：表达式即返回值；块体：语句
        if (ts.isExpression(lam.body)) { this.emitTaggedExpr(lam.body); M.return_(); }
        else this.emitTaggedBlock(lam.body);
        const last = ts.isBlock(lam.body) ? lam.body.statements[lam.body.statements.length - 1] : null;
        if (!(last && ts.isReturnStatement(last))) M.unreachable();
        M.endBody();
        this.varMap = savedMap; this.capMap = savedCap; this.blkLocal = savedBlk;
        this.mode = savedMode; this.depth = savedDepth; this._staticVars = savedStatic;
    }
    // ---------- 语句 ----------
    // ---------- 类（method lifting）----------
    // 类方法/构造器提升为独立 wasm 函数 __m_<C>$<m>(self:i64, a0..a3:i64) → i64。
    // self = 实例句柄（i64 tagged）；实例字段驻 wasm 内存（与 POJO 同 _fieldIndex 布局），
    // `this` 映射 local 0（self），`this.x` 复用 POJO 字段 load/store（零跨界）。
    // 静态分派：receiver 静态类型已知 → 沿父链直调导出 __m_<C>$<m>；动态 → qz.method_call。
    collectClasses(sf) {
        for (const st of sf.statements) {
            if (!ts.isClassDeclaration(st)) continue;
            if (!st.name) throw new Error("[tagged] 匿名类不支持");
            const cname = st.name.text;
            const parent = st.heritageClauses && st.heritageClauses.length
                ? st.heritageClauses[0].types[0] : null;
            const parentName = parent ? parent.expression.text : null;
            const fields = [], methods = [];
            let ctor = null;
            for (const mem of st.members) {
                if (ts.isPropertyDeclaration(mem) && ts.isIdentifier(mem.name)) {
                    fields.push({ name: mem.name.text, init: mem.initializer || null });
                } else if (ts.isConstructorDeclaration(mem)) {
                    ctor = mem;
                } else if (ts.isMethodDeclaration(mem) && ts.isIdentifier(mem.name)) {
                    methods.push({ name: mem.name.text, node: mem });
                } else if ((ts.isGetAccessorDeclaration(mem) || ts.isSetAccessorDeclaration(mem)) && ts.isIdentifier(mem.name)) {
                    methods.push({ name: mem.name.text, node: mem, accessor: ts.isSetAccessorDeclaration(mem) ? "set" : "get" });
                } else {
                    throw new Error("[tagged] 不支持的类成员: " + ts.SyntaxKind[mem.kind]);
                }
            }
            this.classes.set(cname, { id: this._classList.length, name: cname, parent: parentName, fields, methods, ctor });
            this._classList.push(cname);
        }
        // 预登记所有类字段到 fieldMap（发射阶段任意时刻 _instSize 都要覆盖全部类字段）；
        // POJO 字面量字段在其自身发射时登记，可能后于类字段 → 仅使实例 size 偏大，无害。
        for (const cname of this._classList) {
            const c = this.classes.get(cname);
            for (const f of c.fields) this._fieldIndex(f.name);
        }
        // 叶类 = 无子类的类。其方法/构造器内 `this` 静态类精确（new C 永不产 C 之外的实例）。
        this._leafClasses = new Set(this._classList);
        for (const cname of this._classList) {
            const c = this.classes.get(cname);
            if (c.parent && this.classes.has(c.parent)) this._leafClasses.delete(c.parent);
        }
        for (const cname of this._classList) {
            const c = this.classes.get(cname);
            for (const mth of c.methods) {
                const voidRet = !!mth.node.type && mth.node.type.kind === ts.SyntaxKind.VoidKeyword;
                this.m.declareFunc(methName(cname, mth.name), ["i64", "i64", "i64", "i64", "i64"],
                                   mth.accessor === "set" || voidRet ? [] : ["i64"]);
            }
            this.m.declareFunc(ctorName(cname), ["i64", "i64", "i64", "i64", "i64"], []);
        }
    }
    emitClassBodies() {
        for (const cname of this._classList) {
            const c = this.classes.get(cname);
            if (!c.ctor && c.fields.some(f => !f.init)) throw new Error(`[tagged] 类 ${cname} 字段需初值或显式 constructor`);
            this._emitCtorBody(c, c.ctor);
            for (const mth of c.methods) this._emitMethodBody(cname, mth);
        }
    }
    // 构造器 __m_<C>$ctor(self:i64, a0..a3:i64) → 无返回：self 由调用方 _emitNew 经 qz.newobj
    _emitCtorBody(c, ctor) {
        const M = this.m;
        const realParams = ctor ? ctor.parameters.map(p => p.name.text) : [];
        const params = realParams.concat(["$p1", "$p2", "$p3", "$p4"].slice(0, Math.max(0, 4 - realParams.length)));
        const body = ctor ? ctor.body : { statements: [] };
        this._mEnter(ctorName(c.name), c.name, params, body, true);
        this._curClassObj = c;
        // 派生类：字段默认值须在 super(...) 之后写（同名遮蔽字段父写后子覆写）；
        // super 语句处 _emitSuperCall 负责调用父 ctor 后回写本类默认值。基类：此处直接写。
        if (!c.parent) this._emitFieldDefaults(c);
        if (ctor) this.emitTaggedBlock(ctor.body);
        else if (c.parent) this._emitSuperCallForward(c);   // 合成 ctor：constructor(...a){ super(...a) }
        this._curClassObj = null;
        M.endBody();
        this._mExit();
    }
    // 写本类字段默认初值（now: 当前 self=local0 在栈/无；用局部 self 直接存）。
    // 若 ctor 首句为 `super(...)`，则字段默认值改在 super 调用点写（子类字段不得覆写父类构造设置的字段）。
    _emitFieldDefaults(c) {
        const M = this.m;
        for (const f of c.fields) {
            M.localGet(0); M.i32WrapI64();
            if (f.init) this.emitTaggedExpr(f.init);
            else this._emitUndefined();
            M.i64Store(3, this._fieldIndex(f.name));
        }
    }
    _emitMethodBody(cname, mth) {
        const M = this.m;
        const isVoid = !!mth.node.type && mth.node.type.kind === ts.SyntaxKind.VoidKeyword;
        const realParams = mth.node.parameters.map(p => p.name.text);
        const params = realParams.concat(["$p1", "$p2", "$p3", "$p4"].slice(0, Math.max(0, 4 - realParams.length)));
        this._mEnter(methName(cname, mth.name), cname, params, mth.node.body, isVoid);
        this.emitTaggedBlock(mth.node.body);
        if (!isVoid) {
            const stmts = mth.node.body.statements;
            const last = stmts[stmts.length - 1];
            if (!(last && ts.isReturnStatement(last))) M.unreachable();
        }
        M.endBody();
        this._mExit();
    }
    // 方法/构造器发射作用域：this=local0，参数 1..，完整 scratch/sT/obj/forOf/clo 槽布局。
    // 与 emitFunc(tagged) 同构；额外 _curClass 供静态方法分派解析继承链。
    _mEnter(fname, cname, params, body, isVoid) {
        this._mSaved = {
            mode: this.mode, varMap: this.varMap, capMap: this.capMap, capList: this.capList, capListActive: this.capListActive,
            blkLocal: this.blkLocal, depth: this.depth, labels: this.labels, labelStack: this._labelStack, curClass: this._curClass, curClassObj: this._curClassObj, staticVars: this._staticVars,
        };
        this.mode = "tagged";
        const nParams = 1 + params.length;
        const locals = this._collectLocals(body);
        const nLoc = nParams + locals.length;
        this.varMap = new Map();
        this.varMap.set("this", 0);
        params.forEach((p, i) => this.varMap.set(p, 1 + i));
        locals.forEach((n, i) => this.varMap.set(n, nParams + i));
        this.capMap = new Map(); this.blkLocal = null;
        this.scratch = nLoc; this.scratchA = nLoc + 1; this.scratchB = nLoc + 2;
        const extra = ["f64", "f64"];
        this.scratchFA = nLoc + 3; this.scratchFB = nLoc + 4;
        const sT = Array.from({ length: 8 }, () => "i32");
        this.sT = Array.from({ length: 8 }, (_, i) => nLoc + 5 + i);
        const objPool = Array.from({ length: 8 }, () => "i64");
        this.objBase = nLoc + 3 + extra.length + sT.length;
        this._objDepth = 0;
        this.swIdx = this.objBase + objPool.length;
        const nForOf = this._countForOf(body);
        this.forOfBase = this.swIdx + 1;
        this.forOfCount = 0;
        const forOfLocals = [];
        for (let i = 0; i < nForOf; i++) forOfLocals.push("i64", "i32");
        const cloSlots = ["i64", "i32", "i32", "i32", "i64", "i64", "i64", "i64"];
        this.cloHandle = nLoc + 3 + extra.length + sT.length + objPool.length + 1 + nForOf * 2;
        this.cloOff = this.cloHandle + 1; this.cloBlk = this.cloHandle + 2; this.cloFn = this.cloHandle + 3;
        this.cloArgs = [this.cloHandle + 4, this.cloHandle + 5, this.cloHandle + 6, this.cloHandle + 7];
        this.cloSlotsLen = cloSlots.length;
        const bodyLocals = locals.map(() => "i64").concat(["i64", "i64", "i64"]).concat(extra)
            .concat(sT).concat(objPool).concat(["i32"]).concat(forOfLocals).concat(cloSlots);
        const localNames = this.m.debug ? ["this"].concat(params).concat(locals) : null;
        this.m.startBody(fname, bodyLocals, localNames);
        this.depth = 0; this.labels = []; this._tryStack = []; this._labelStack = [];
        this._curClass = cname;
        this._staticVars = this._computeStaticVars(body, params);
    }
    _mExit() {
        const s = this._mSaved;
        this.mode = s.mode; this.varMap = s.varMap; this.capMap = s.capMap; this.capList = s.capList; this.capListActive = s.capListActive;
        this.blkLocal = s.blkLocal; this.depth = s.depth; this.labels = s.labels;
        this._labelStack = s.labelStack; this._curClass = s.curClass; this._curClassObj = s.curClassObj;
        this._staticVars = s.staticVars;
    }
    emitBlock(node) { for (const s of node.statements) this.emitStmt(s); }

    emitStmt(s) {
        if (ts.isVariableStatement(s)) {
            for (const d of s.declarationList.declarations) {
                if (d.initializer) { this.emitExpr(d.initializer); this.m.localSet(this._local(d.name.text)); }
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
        if (ts.isBreakStatement(s)) { this.m.br(this._breakRel(s.label && s.label.text)); return; }
        if (ts.isDoStatement(s)) { this.emitDoWhile(s, false); return; }
        if (ts.isContinueStatement(s)) { this.m.br(this._contRel(s.label && s.label.text)); return; }
        if (ts.isWhileStatement(s)) { this.emitWhile(s); return; }
        if (ts.isForStatement(s)) { this.emitFor(s); return; }
        if (ts.isSwitchStatement(s)) { this.emitSwitch(s, false); return; }
        if (ts.isLabeledStatement(s)) { if (ts.isIterationStatement(s.statement, false)) this._labelStack.push(s.label.text); this.emitStmt(s.statement); return; }
        if (ts.isBlock(s)) { this.emitBlock(s); return; }
        if (ts.isExpressionStatement(s)) { this.emitExpr(s.expression); this.m.drop(); return; }
        if (ts.isEmptyStatement(s)) return;
        throw new Error("不支持的语句: " + ts.SyntaxKind[s.kind]);
    }

    // break → 最近可 break 的 label（循环或 switch；带 label 名则精确匹配）；continue → 最近的循环 label。
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
        M.block(); this.depth++;
        M.loop(); this.depth++;
        M.block(); this.depth++;
        this.labels.push({ brk: this.depth - 2, cont: this.depth, label: this._curLabel() });
        if (tagged) this.emitTaggedStmt(s.statement); else this.emitStmt(s.statement);
        this.labels.pop();
        this.depth--; M.end();                             // end cont block
        if (tagged) this.emitCondI32(s.expression !== undefined ? s.expression : s.condition);
        else { this.emitExpr(s.expression !== undefined ? s.expression : s.condition); this.emitCond(); }
        M.brIf(0);                                         // 条件真 → 回 loop 顶
        this.depth--; M.end();                             // end loop
        this.depth--; M.end();                             // end brk block
    }

    // ---------- 表达式（number 域） ----------
    emitExpr(e) {
        if (ts.isNumericLiteral(e)) { this.m.f64Const(Number(e.text)); return; }
        if (ts.isIdentifier(e)) {
            const idx = this._local(e.text);
            if (idx === undefined) throw new Error("未定义变量: " + e.text);
            this.m.localGet(idx); return;
        }
        if (ts.isParenthesizedExpression(e)) { this.emitExpr(e.expression); return; }
        if (ts.isPrefixUnaryExpression(e)) {
            // ++/-- 需先判是否自增自减
            if (ts.isIdentifier(e.operand) && (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken)) {
                const idx = this._local(e.operand.text);
                if (idx === undefined) throw new Error("未定义变量: " + e.operand.text);
                const dec = e.operator === ts.SyntaxKind.MinusMinusToken;
                this.m.localGet(idx); this.m.f64Const(1); dec ? this.m.f64Sub() : this.m.f64Add(); this.m.localTee(idx);
                return;
            }
            this.emitExpr(e.operand);
            if (e.operator === ts.SyntaxKind.MinusToken) { this.m.f64Neg(); }
            else if (e.operator === ts.SyntaxKind.PlusToken) { /* noop */ }
            else if (e.operator === ts.SyntaxKind.ExclamationToken) { this.m.f64Const(0); this.m.f64Eq(); this.m.f64ConvertI32S(); }
            else throw new Error("不支持的一元运算符: " + ts.SyntaxKind[e.operator]);
            return;
        }
        if (ts.isPostfixUnaryExpression(e)) {
            const idx = this._local(e.operand.text);
            if (idx === undefined) throw new Error("未定义变量: " + e.operand.text);
            const dec = e.operator === ts.SyntaxKind.MinusMinusToken;
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
            if (!ts.isIdentifier(e.expression)) throw new Error("不支持的调用目标");
            const fn = e.expression.text;
            if (fn === "Math_floor") { this.emitExpr(e.arguments[0]); this.m.f64Floor(); return; }
            for (const a of e.arguments) this.emitExpr(a);
            this.m.call(fn);
            return;
        }
        throw new Error("不支持的表达式: " + ts.SyntaxKind[e.kind]);
    }

    emitBinary(e) {
        const op = e.operatorToken.kind;
        // 赋值：x = rhs → localTee（保留值供表达式上下文）；x op= rhs → 读-算-写
        const assignOps = { [ts.SyntaxKind.EqualsToken]: null, [ts.SyntaxKind.PlusEqualsToken]: ts.SyntaxKind.PlusToken, [ts.SyntaxKind.MinusEqualsToken]: ts.SyntaxKind.MinusToken, [ts.SyntaxKind.AsteriskEqualsToken]: ts.SyntaxKind.AsteriskToken, [ts.SyntaxKind.SlashEqualsToken]: ts.SyntaxKind.SlashToken, [ts.SyntaxKind.PercentEqualsToken]: ts.SyntaxKind.PercentToken, [ts.SyntaxKind.LessThanLessThanEqualsToken]: ts.SyntaxKind.LessThanLessThanToken, [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanToken, [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, [ts.SyntaxKind.AmpersandEqualsToken]: ts.SyntaxKind.AmpersandToken, [ts.SyntaxKind.BarEqualsToken]: ts.SyntaxKind.BarToken, [ts.SyntaxKind.CaretEqualsToken]: ts.SyntaxKind.CaretToken };
        if (Object.prototype.hasOwnProperty.call(assignOps, op)) {
            if (!ts.isIdentifier(e.left)) throw new Error("赋值左值必须是标识符");
            const idx = this._local(e.left.text);
            if (idx === undefined) throw new Error("未定义变量: " + e.left.text);
            const binop = assignOps[op];
            if (binop !== null) {
                this.m.localGet(idx);
                this.emitExpr(e.right);
                this.emitBinaryOp(binop);
            } else {
                this.emitExpr(e.right);
            }
            this.m.localTee(idx);
            return;
        }
        // 逻辑复合赋值：a ||= b → a = a || b（truthy 判）；a &&= b 同理（数值域：非 0 即真）
        if (op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
            if (!ts.isIdentifier(e.left)) throw new Error("赋值左值必须是标识符");
            const idx = this._local(e.left.text);
            if (idx === undefined) throw new Error("未定义变量: " + e.left.text);
            this.m.localGet(idx); this.emitCond();
            this.emitBinaryOperandValue(e.right); this.emitCond();
            if (op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) this.m.i32And(); else this.m.i32Or();
            this.m.f64ConvertI32S(); this.m.localTee(idx);
            return;
        }

        // 短路逻辑（数值域：非 0 即真）
        if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
            // 简化：非短路直接算两边（truthy→0/1 f64）；结果 0/1
            this.emitBinaryOperandValue(e.left); this.emitCond();
            this.emitBinaryOperandValue(e.right); this.emitCond();
            if (op === ts.SyntaxKind.AmpersandAmpersandToken) this.m.i32And(); else this.m.i32Or();
            this.m.f64ConvertI32S();
            return;
        }
        this.emitBinaryOperandValue(e.left);
        this.emitBinaryOperandValue(e.right);
        this.emitBinaryOp(op);
    }
    // 条件求值：栈顶 f64 → i32（!=0 为真）
    emitCond() { this.m.f64Const(0); this.m.f64Ne(); }
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

    // f64 取模：a - b * trunc(a / b)（wasm 无 f64.rem，语义对齐 JS %）
    emitRem() {
        // 栈: a b → 需 (a - b*trunc(a/b))；借用 scratch 保存 a、b
        this.m.localSet(this.scratchB);        // b
        this.m.localTee(this.scratchA);        // a（保留）
        this.m.localGet(this.scratchB);
        this.m.f64Div();                       // a/b
        this.m.f64Trunc();                     // trunc(a/b)
        this.m.localGet(this.scratchB);
        this.m.f64Mul();                       // b*trunc(a/b)
        this.m.localGet(this.scratchA);
        this.m.f64Sub();                       // b*trunc - ... 需 a - that
        // 修正顺序：上面得 (b*trunc) - a，取负
        this.m.f64Neg();
    }
}

// ---------- 主流程 ----------
// ---------- 字符串（wasm 内表示，零跨界）----------
// 句柄 = i64 高16位 0x7FFA | 低32位 = 字符串结构偏移（结构 [len:i32][utf8 bytes]）。
// 字面量驻留 data 段（STR_BASE 起）；动态拼接走 bump 堆（global0 从 STR_BUMP 起）。
// 数字→字符串用固定 scratch 区（SCRATCH 起）。
const STR_TAG_HI = 0x7ffa;                       // 字符串句柄高 16 位标记
const ARR_TAG_HI = 0x7ff8;                       // 数组句柄高 16 位标记（布局 [len:i32][pad:i32][elem:i64×N]，元素 +8 起）
const SCRATCH = 16;                              // numstr 临时区（48 字节，够 20 位 + 负号 + len）
const STR_BASE = 1 << 20;                        // 字面量 data 段基址（1 MiB，heap 不会撞）
const STR_BUMP = 128;                            // bump 堆起始（跳过 scratch）

// 字符串 helper 函数（每模块一份，emitter call 调用）
function emitStringHelpers(m) {
    // qzs_memcpy(dest, src, n) 逐字节拷贝
    m.declareFunc("qzs_memcpy", ["i32", "i32", "i32"], []);
    m.startBody("qzs_memcpy", ["i32", "i32", "i32"]);
    m.localGet(0); m.localSet(5);                        // dest → 5
    m.localGet(1); m.localSet(4);                        // src → 4
    m.localGet(2); m.localSet(3);                        // n → 3
    m.block("void"); m.loop("void");
    m.localGet(3); m.i32Eqz(); m.brIf(1);
    m.localGet(5); m.localGet(4); m.i32Load8U(0, 0); m.i32Store8(0, 0);
    m.localGet(5); m.i32Const(1); m.i32Add(); m.localSet(5);
    m.localGet(4); m.i32Const(1); m.i32Add(); m.localSet(4);
    m.localGet(3); m.i32Const(1); m.i32Sub(); m.localSet(3);
    m.br(0); m.end(); m.end();
    m.endBody();

    // qzs_numstr(dest:i32, n:i64) -> i32（写 [dest]=len, digits@dest+4；返回 dest）
    // locals: 2=pos(i32), 3=nn(i64), 4=count(i32), 5=n(i64)
    m.declareFunc("qzs_numstr", ["i32", "i64"], ["i32"]);
    m.startBody("qzs_numstr", ["i32", "i64", "i32", "i64"]);
    m.localGet(1); m.localSet(5);                       // n
    m.i32Const(0); m.localSet(4);                       // count
    m.localGet(5); m.localSet(3);                       // nn
    m.block("void"); m.loop("void");
    m.localGet(4); m.i32Const(1); m.i32Add(); m.localSet(4);
    m.localGet(3); m.i64Const(10n); m.i64DivU(); m.localSet(3);
    m.localGet(3); m.i64Eqz(); m.brIf(1);
    m.br(0); m.end(); m.end();
    // pos = dest + 4 + count
    m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(4); m.i32Add(); m.localSet(2);
    m.localGet(5); m.localSet(3);                       // nn = n
    m.block("void"); m.loop("void");
    m.localGet(2); m.i32Const(1); m.i32Sub(); m.localSet(2);
    m.localGet(2); m.localGet(3); m.i64Const(10n); m.i64RemU(); m.i32WrapI64(); m.i32Const(0x30); m.i32Add(); m.i32Store8(0, 0);
    m.localGet(3); m.i64Const(10n); m.i64DivU(); m.localSet(3);
    m.localGet(3); m.i64Eqz(); m.brIf(1);
    m.br(0); m.end(); m.end();
    m.localGet(0); m.localGet(4); m.i32Store(0, 0);       // [dest]=len
    m.localGet(0);
    m.endBody();

    // qzs_append(buf, src, addLen) -> i32（top-of-bump 原地追加，否则新建拷贝）
    m.declareFunc("qzs_append", ["i32", "i32", "i32"], ["i32"]);
    m.startBody("qzs_append", ["i32", "i32", "i32", "i32", "i32"]);
    m.localGet(0); m.i32Load(2, 0); m.localSet(3);       // oldLen
    m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(3); m.i32Add();
    m.globalGet(0); m.i32Eq();                            // top?
    m.ifBlock("i32");
    m.globalGet(0); m.localGet(2); m.i32Add(); m.globalSet(0);   // bump+=addLen
    m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(3); m.i32Add();  // dest
    m.localGet(1); m.localGet(2); m.call("qzs_memcpy");
    m.localGet(0); m.localGet(3); m.localGet(2); m.i32Add(); m.i32Store(2, 0);
    m.localGet(0);
    m.else_();
    m.globalGet(0); m.localSet(4);                        // newBuf
    m.globalGet(0); m.i32Const(4); m.i32Add(); m.localGet(3); m.i32Add(); m.localGet(2); m.i32Add(); m.globalSet(0);
    m.localGet(4); m.localGet(3); m.localGet(2); m.i32Add(); m.i32Store(2, 0);
    m.localGet(4); m.i32Const(4); m.i32Add(); m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(3); m.call("qzs_memcpy");
    m.localGet(4); m.i32Const(4); m.i32Add(); m.localGet(3); m.i32Add(); m.localGet(1); m.localGet(2); m.call("qzs_memcpy");
    m.localGet(4);
    m.end();
    m.endBody();
}

// 函数编译模式：参数全 number 且返回 number/void/无标注 → "num"（f64 快路径）。
// 必须同时看返回类型：零参函数 .every() 恒 true，返回 any 的函数须走 tagged。
function funcMode(f) {
    const rt = f.type;
    const rtOk = !rt || rt.kind === ts.SyntaxKind.NumberKeyword || rt.kind === ts.SyntaxKind.VoidKeyword;
    const allNum = f.parameters.every(p => p.type && p.type.kind === ts.SyntaxKind.NumberKeyword);
    // 含箭头/函数表达式/`new` 的函数走 tagged（闭包与类实例是 tagged 特性，num 快路径不支持）
    let hasLam = false;
    const walk = (n) => {
        if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n !== f) hasLam = true;
        if (ts.isNewExpression(n)) hasLam = true;
        ts.forEachChild(n, walk);
    };
    if (f.body) walk(f.body);
    return (allNum && rtOk && !hasLam && (f.parameters.length > 0 || (rt && rt.kind === ts.SyntaxKind.NumberKeyword))) ? "num" : "tagged";
}
function compileTS(input, outWasm, opts = {}) {
    const program = ts.createProgram([input], { strict: true, target: ts.ScriptTarget.ES2020 });
    const sf = program.getSourceFile(input);
    const m = new Module({ debug: !!opts.debug });   // opts.debug → name 段（函数名，调试/反汇编）
    if (opts.needMathFloor) m.importFn("qz", "math_floor", ["i32"], ["i32"]);
    const em = new Emitter(m);
    const fns = sf.statements.filter(st => ts.isFunctionDeclaration(st) && st.name);
    for (const st of fns) em.fnNames.add(st.name.text);
    const clsStmts = sf.statements.filter(st => ts.isClassDeclaration(st));
    const hasClasses = clsStmts.length > 0;
    // 阶段1：任一函数为 tagged 或存在类 → 注册全部 qz.* import + 字符串 helper；登记顶层函数签名
    const anyTagged = fns.some(f => funcMode(f) === "tagged") || hasClasses;
    if (anyTagged) {
        registerQz(m);
        m.addMemory(32);                                 // 2 MiB：heap(<1MiB) + 字面量(STR_BASE 起)
        m.addGlobal("i32", STR_BUMP);                    // global0 = bump 堆（字符串/对象）
        m.addGlobal("i64", 0);                           // global1 = __err（异常值；0 = 无错）
        emitStringHelpers(m);
    }
    for (const st of fns) {
        const isVoid = !!st.type && st.type.kind === ts.SyntaxKind.VoidKeyword;
        const isNum = funcMode(st) === "num";
        const vt = isNum ? "f64" : "i64";   // num=f64；tagged=i64（NaN-box）
        m.declareFunc(st.name.text, st.parameters.map(() => vt), isVoid ? [] : [vt]);
    }
    // 阶段1.5：收集类（登记方法/构造器签名）——须在发射体前
    if (hasClasses) em.collectClasses(sf);
    // 阶段1.5b：扫描 lambda（顶层函数体 + 类方法/构造器体 + 字段初值），登记 __lam_N 签名
    let lamSeq = 0;
    for (const st of fns) {
        for (const lam of em._collectLambdas(st.body)) em.emitLambda(lam, lamSeq++);
    }
    for (const cname of em._classList) {
        const c = em.classes.get(cname);
        if (c.ctor) for (const lam of em._collectLambdas(c.ctor.body)) em.emitLambda(lam, lamSeq++);
        for (const mth of c.methods) for (const lam of em._collectLambdas(mth.node.body)) em.emitLambda(lam, lamSeq++);
        for (const f of c.fields) if (f.init) for (const lam of em._collectLambdas(f.init)) em.emitLambda(lam, lamSeq++);
    }
    // 阶段2：逐个发射 body（顶层函数 + lambda + 类方法/构造器）
    for (const st of fns) em.emitFunc(st);
    em.emitLambdaBodies();
    if (hasClasses) em.emitClassBodies();
    for (const cname of em._classList) {
        const c = em.classes.get(cname);
        for (const mth of c.methods) m.exportFn(methName(cname, mth.name), methName(cname, mth.name));
        m.exportFn(ctorName(cname), ctorName(cname));
    }
    if (m.memory !== null) m.exportMemory();
    if (anyTagged) m.exportGlobal("__bump", m.globalIdx());
    for (const meta of em._lamById.values()) m.exportFn(meta.fname, meta.fname);
    fs.writeFileSync(outWasm, m.build());
    // funcMeta: 每导出函数 {name, mode(num/tagged), params}
    const funcMeta = fns.map(f => ({
        name: f.name.text,
        mode: funcMode(f),
        params: f.parameters.length,
    }));
    const lamMeta = {};
    for (const meta of em._lamById.values()) lamMeta[m._funcIdx[meta.fname]] = { name: meta.fname, n: meta.n };
    // classMeta[clsId] = { id, parent(parent的clsId), methods: {name: {name(导出名), n(参数量)}} }
    const classMeta = em._classList.map(cname => {
        const c = em.classes.get(cname);
        const methods = {};
        for (const mth of c.methods) {
            methods[mth.name] = { name: methName(cname, mth.name), n: mth.node.parameters.length };
        }
        const p = c.parent ? em.classes.get(c.parent) : null;
        return { id: c.id, parent: p ? p.id : null, methods };
    });
    return { module: m, strings: em.strings || [], fields: em.fieldMap ? [...em.fieldMap.keys()] : [], funcMeta, lamMeta, classMeta };
}


// ================= tagged 模式发射（动态值：对象/字符串/unknown） =================
// 值恒 i64：数值 = 原始 f64 位型（NaN-box 的数值侧），句柄 = 高16位0x7FF9|低32 offset；
// 字段 8 字节。与宿主字长无关，32/64 位设备共用。
const _fbuf = Buffer.alloc(8);
function f64Bits(v) { _fbuf.writeDoubleLE(v); return [_fbuf.readUInt32LE(0), _fbuf.readUInt32LE(4)]; }   // [lo, hi]
Emitter.prototype._fieldIndex = function (name) {
    if (!this.fieldMap) this.fieldMap = new Map();
    let i = this.fieldMap.get(name);
    if (i === undefined) { i = this.fieldMap.size; this.fieldMap.set(name, i); }
    return (i + 1) * 8;   // 字节偏移；偏移 0 保留给实例 __cls 头（类实例），字段从 8 起
};
Emitter.prototype._strId = function (text) {
    let i = this.strings.indexOf(text);
    if (i < 0) { i = this.strings.length; this.strings.push(text); }
    return i;
};
// 字符串句柄 tag 测试：栈顶 i64 → i32（是字符串?）
Emitter.prototype._emitIsStr = function () {
    this.m.i64Const(48n); this.m.i64ShrU(); this.m.i64Const(0x7ffan); this.m.i64Eq();
};
// 字面量 → data 段 [len:i32][utf8]，返回偏移（句柄低32位）
Emitter.prototype._litOffset = function (text) {
    let off = this._litOff.get(text);
    if (off !== undefined) return off;
    off = (this._litCursor === undefined) ? STR_BASE : this._litCursor;
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
Emitter.prototype._emitConcat = function () {
    const M = this.m;
    M.localSet(this.scratchA); M.localSet(this.scratchB);   // a=scratchB, b=scratchA
    M.localGet(this.scratchB); this._emitIsStr();           // isStr(a)
    M.ifBlock("i64");
    // a 字符串：计算 b 字节源 (len→sT[0], ptr→sT[2])
    M.localGet(this.scratchA); this._emitIsStr();
    M.ifBlock("void");
      // b 字符串
      M.localGet(this.scratchA); this._emitStrParts();       // sT0=len, sT2=ptr
    M.else_();
      // b 数字 → numstr(SCRATCH, b)
      M.i32Const(SCRATCH); M.localGet(this.scratchA); M.f64ReinterpretI64(); M.i64TruncF64S(); M.call("qzs_numstr");
      M.drop();
      M.i32Const(SCRATCH); M.i32Load(2, 0); M.localSet(this.sT[0]);   // len
      M.i32Const(SCRATCH + 4); M.localSet(this.sT[2]);               // ptr
    M.end();
    // qzs_append(a_off, ptr, len) → 新 buf；tag
    M.localGet(this.scratchB); M.i32WrapI64();              // a_off
    M.localGet(this.sT[2]); M.localGet(this.sT[0]); M.call("qzs_append");
    this._strTag();
    M.else_();
    // a 非字符串
    M.localGet(this.scratchA); this._emitIsStr();           // isStr(b)
    M.ifBlock("i64");
      // a 数 + b 串：回退 JS 拼接
      M.localGet(this.scratchB); M.localGet(this.scratchA); M.call("qz.string_concat");
    M.else_();
      // 双数：f64 add
      M.localGet(this.scratchB); M.f64ReinterpretI64();
      M.localGet(this.scratchA); M.f64ReinterpretI64();
      M.f64Add(); M.i64ReinterpretF64();
    M.end();
    M.end();
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
Emitter.prototype.emitTaggedBlock = function (node) { for (const st of node.statements) this.emitTaggedStmt(st); };
Emitter.prototype.emitTaggedStmt = function (s) {
    if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
            if (d.initializer) { this.emitTaggedExpr(d.initializer); this.m.localSet(this._local(d.name.text)); }
        }
        return;
    }
    if (ts.isReturnStatement(s)) { if (s.expression) this.emitTaggedExpr(s.expression); this.m.return_(); return; }
    if (ts.isBreakStatement(s)) { this.m.br(this._breakRel(s.label && s.label.text)); return; }
    if (ts.isContinueStatement(s)) { this.m.br(this._contRel(s.label && s.label.text)); return; }
    if (ts.isDoStatement(s)) { this.emitDoWhile(s, true); return; }
    if (ts.isSwitchStatement(s)) { this.emitSwitch(s, true); return; }
    if (ts.isThrowStatement(s)) {
        if (this.mode !== "tagged") throw new Error("[num] throw 不支持（仅 tagged）");
        this.emitTaggedExpr(s.expression); this.m.globalSet(1);   // __err = 值
        if (!this._tryStack.length) throw new Error("throw 不在 try 内（跨函数 throw 不支持）");
        this.m.br(this.depth - this._tryStack[this._tryStack.length - 1].errBrk);
        return;
    }
    if (ts.isTryStatement(s)) { this.emitTry(s, true); return; }
    if (ts.isIfStatement(s)) {
        this.emitCondI32(s.expression !== undefined ? s.expression : s.condition);
        this.m.ifBlock(); this.depth++;          // 条件已归约为裸 i32 布尔
        this.emitTaggedStmt(s.thenStatement);
        if (s.elseStatement) { this.m.else_(); this.emitTaggedStmt(s.elseStatement); }
        this.depth--; this.m.end(); return;
    }
    if (ts.isWhileStatement(s)) {
        this.m.block(); this.depth++; this.m.loop(); this.depth++;
        this.labels.push({ brk: this.depth - 1, cont: this.depth, label: this._curLabel() });
        this.emitCondI32(s.expression !== undefined ? s.expression : s.condition);
        this.m.i32Eqz(); this.m.brIf(1);
        this.emitTaggedStmt(s.statement);
        this.m.br(0);
        this.labels.pop(); this.depth--; this.m.end(); this.depth--; this.m.end(); return;
    }
    if (ts.isForStatement(s)) {
        if (s.initializer) {
            if (ts.isVariableDeclarationList(s.initializer)) {
                for (const d of s.initializer.declarations) if (d.initializer) { this.emitTaggedExpr(d.initializer); this.m.localSet(this._local(d.name.text)); }
            } else { this.emitTaggedExpr(s.initializer); this.m.drop(); }
        }
        // block(brk) loop block(cont) body end; incr; br 0 end end（continue 跳 incr 前）
        this.m.block(); this.depth++; this.m.loop(); this.depth++;
        if (s.condition) { this.emitCondI32(s.condition); this.m.i32Eqz(); this.m.brIf(1); }
        this.m.block(); this.depth++;
        this.labels.push({ brk: this.depth - 2, cont: this.depth, label: this._curLabel() });
        if (s.statement) this.emitTaggedStmt(s.statement);
        this.labels.pop();
        this.depth--; this.m.end();                       // end cont block
        if (s.incrementor) { this.emitTaggedExpr(s.incrementor); this.m.drop(); }
        this.m.br(0);
        this.depth--; this.m.end();                       // end loop
        this.depth--; this.m.end(); return;               // end brk block
    }
    if (ts.isForOfStatement(s)) {
        // for (let x of arr) body：每嵌套层独立 local 对（arrL=i64 句柄, idxL=i32 索引）。
        // 结构同 for：block(brk) loop block(cont) body end; i++; br 0 end end。
        const M = this.m;
        if (!ts.isVariableDeclarationList(s.initializer) || s.initializer.declarations.length !== 1
            || !ts.isIdentifier(s.initializer.declarations[0].name))
            throw new Error("[tagged] for-of 仅支持 let x of arr");
        const varIdx = this._local(s.initializer.declarations[0].name.text);
        if (varIdx === undefined) throw new Error("未定义 for-of 变量");
        const arrL = this.forOfBase + this.forOfCount * 2;       // 本层数组句柄 local
        const idxL = arrL + 1;                                   // 本层索引 local
        this.forOfCount++;
        this.emitTaggedExpr(s.expression); M.localSet(arrL);     // 数组句柄（i64）
        M.i32Const(0); M.localSet(idxL);                         // i = 0
        M.block(); this.depth++; M.loop(); this.depth++;
        M.localGet(idxL);
        M.localGet(arrL); M.i32WrapI64(); M.i32Const(0); M.i32Load(2, 0);   // header[0] = len
        M.i32GeS(); M.brIf(1);                                   // i >= len → 退出
        M.block(); this.depth++;
        this.labels.push({ brk: this.depth - 2, cont: this.depth, label: this._curLabel() });
        M.localGet(arrL); M.i32WrapI64(); M.i32Load(2, 8);       // dataOff
        M.localGet(idxL); M.i32Const(8); M.i32Mul(); M.i32Add(); // dataOff + i*8
        M.i64Load(3, 0); M.localSet(varIdx);                     // x = arr[i]
        if (s.statement) this.emitTaggedStmt(s.statement);
        this.labels.pop();
        this.depth--; M.end();                                   // end cont
        M.localGet(idxL); M.i32Const(1); M.i32Add(); M.localSet(idxL);   // i++
        M.br(0);
        this.depth--; M.end();                                   // end loop
        this.depth--; M.end();                                   // end brk
        this.forOfCount--;
        return;
    }
    if (ts.isLabeledStatement(s)) { if (ts.isIterationStatement(s.statement, false)) this._labelStack.push(s.label.text); this.emitTaggedStmt(s.statement); return; }
    if (ts.isBlock(s)) { this.emitTaggedBlock(s); return; }
    if (ts.isExpressionStatement(s)) {
        // console.log(x) → qz.log（边界输出）
        const ex = s.expression;
        if (ts.isCallExpression(ex) && ts.isPropertyAccessExpression(ex.expression) && ex.expression.expression.text === "console") {
            for (const a of ex.arguments) { this.emitTaggedExpr(a); this.m.call("qz.log"); }
            return;
        }
        if (ts.isCallExpression(ex) && ts.isSuperKeyword(ex.expression)) { this.emitTaggedExpr(ex); return; }
        this.emitTaggedExpr(ex); this.m.drop(); return;
    }
    if (ts.isEmptyStatement(s)) return;
    throw new Error("[tagged] 不支持的语句: " + ts.SyntaxKind[s.kind]);
};
// try/catch/finally：__err(global1) + 结构化 br。
//   block $done → block $err → <try> → br $done | end $err → <catch> → end $done → <finally>
// throw 跳 $err 后（catch）；正常跳 $done 后（跳过 catch）。finally 两路都会执行。
Emitter.prototype.emitTry = function (s, tagged) {
    const M = this.m;
    M.block(); this.depth++;                       // $done
    M.block(); this.depth++;                       // $err
    this._tryStack.push({ errBrk: this.depth });   // 记录 $err 相对深度（throw 用）
    if (tagged) this.emitTaggedBlock(s.tryBlock); else this.emitBlock(s.tryBlock);
    M.br(this.depth - (this.depth - 1));           // 正常 → 跳 $done 后（跳过 catch）
    this._tryStack.pop();
    this.depth--; M.end();                         // end $err → catch 入口
    const c = s.catchClause;
    if (c) {
        if (c.variableDeclaration && ts.isIdentifier(c.variableDeclaration.name)) {
            const idx = this._local(c.variableDeclaration.name.text);
            if (idx !== undefined) { M.globalGet(1); M.localSet(idx); }   // catch 变量 = __err
        }
        if (tagged) this.emitTaggedBlock(c.block); else this.emitBlock(c.block);
    }
    this.depth--; M.end();                         // end $done
    if (s.finallyBlock) {
        if (tagged) this.emitTaggedBlock(s.finallyBlock); else this.emitBlock(s.finallyBlock);
    }
};

// switch：entry-index 方案。先算入口 clause 序号（无匹配→default，无 default→len），
// 再按源码序遍历，swIdx<=i 激活（fallthrough 天然正确，default 位置无关）。break → 外层 block。
Emitter.prototype.emitSwitch = function (s, tagged) {
    const M = this.m;
    const clauses = s.caseBlock.clauses;
    let defaultIdx = clauses.findIndex(c => ts.isDefaultClause(c));
    if (defaultIdx < 0) defaultIdx = clauses.length;
    M.block(); this.depth++;
    this.labels.push({ brk: this.depth, cont: null, label: this._curLabel() });
    if (tagged) this.emitTaggedExpr(s.expression); else this.emitExpr(s.expression);
    M.localSet(this.scratch);
    M.i32Const(defaultIdx); M.localSet(this.swIdx);
    // scan：首个 disc===caseVal → entry=i 并跳出（br 1 出 scan block）；全不匹配保持 defaultIdx。
    M.block(); this.depth++;
    for (let i = 0; i < clauses.length; i++) {
        const c = clauses[i];
        if (ts.isDefaultClause(c)) continue;
        M.localGet(this.scratch);
        if (tagged) { this.emitTaggedExpr(c.expression); M.call("qz.seq"); M.call("qz.truthy"); }
        else { this.emitExpr(c.expression); M.f64Eq(); }
        M.ifBlock(); this.depth++;
        M.i32Const(i); M.localSet(this.swIdx);
        M.br(1);
        M.end(); this.depth--;
    }
    this.depth--; M.end();                                  // end scan
    for (let i = 0; i < clauses.length; i++) {                          // 源码序执行（fallthrough）
        M.localGet(this.swIdx); M.i32Const(i); M.i32LeS();
        M.ifBlock(); this.depth++;
        for (const st of clauses[i].statements) { if (tagged) this.emitTaggedStmt(st); else this.emitStmt(st); }
        M.end(); this.depth--;
    }
    this.labels.pop();
    this.depth--; M.end();
};
Emitter.prototype.emitTaggedExpr = function (e) {
    if (ts.isNumericLiteral(e)) {
        this.m.i64ConstBits(...f64Bits(Number(e.text)));   // 数值 = 原始 f64 位型
        return;
    }
    if (ts.isStringLiteral(e)) { this._emitStrLitHandle(e.text); return; }
    if (ts.isNoSubstitutionTemplateLiteral(e)) { this._emitStrLitHandle(e.text); return; }
    if (ts.isTemplateExpression(e)) {
        // `head${e1}lit1${e2}lit2…`：逐段 _emitConcat（栈 [a,b]→句柄）。空段字面量为空串。
        this._emitStrLitHandle(e.head.text);
        for (const span of e.templateSpans) {
            this.emitTaggedExpr(span.expression);
            this._emitConcat();
            this._emitStrLitHandle(span.literal ? span.literal.text : "");
            this._emitConcat();
        }
        return;
    }
    if (ts.isThis(e)) {
        const idx = this._local("this");
        if (idx === undefined) throw new Error("[tagged] this 仅在类方法/构造器内可用");
        this.m.localGet(idx); return;
    }
    if (ts.isIdentifier(e)) {
        const idx = this._local(e.text);
        if (idx !== undefined) { this.m.localGet(idx); return; }
        this._emitCapturedRead(e.text); return;
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) { this._emitLambdaNew(e); return; }
    if (ts.isParenthesizedExpression(e)) { this.emitTaggedExpr(e.expression); return; }
    if (ts.isTypeOfExpression(e)) {
        // 内联分类：字符串句柄(hi16=0x7FFA)→"string"；数组/对象(0x7FF8/0x7FF9)→"object"；其余→"number"。
        const M = this.m;
        this.emitTaggedExpr(e.expression); M.localSet(this.scratch);
        M.block("i64");
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffan); M.i64Eq();
        M.ifBlock("i64");
        this._emitStrLitHandle("string");
        M.else_();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ff8n); M.i64Eq();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ff9n); M.i64Eq();
        M.i32Or();
        M.ifBlock("i64");
        this._emitStrLitHandle("object");
        M.else_();
        this._emitStrLitHandle("number");
        M.end(); M.end();
        M.end();
        return;
    }
    if (ts.isObjectLiteralExpression(e)) {
        // POJO：字段驻留 wasm 线性内存（零跨界读写）。句柄 = box(高16位0x7FF9 | offset)。字段宽 8 字节（i64）。
        if (e.properties.some(p => !ts.isPropertyAssignment(p))) {
            throw new Error("[tagged] 对象字面量只支持 { x: v } 形式");
        }
        const NF = e.properties.length;
        // 字段偏移用全局 fieldMap（名→固定偏移，POJO 隐式形状）：与读取端 _fieldIndex 一致。
        // 分配 size = 最大字段字节偏移 + 8（偏移 0 保留给 __cls 头，POJO 留 0 亦无害）。
        const fIdx = e.properties.map(p => this._fieldIndex(p.name.text));
        const size = Math.max(...fIdx) + 8;
        this.m.globalGet(0);
        this.m.i32Const(size);
        this.m.i32Add();
        this.m.globalSet(0);
        this.m.globalGet(0);
        this.m.i32Const(size);
        this.m.i32Sub();                            // → offset(i32)
        this.m.i64ExtendI32U(); this.m.i64ConstBits(0, 0x7ff9); this.m.i64Or();   // 句柄 = 高16位0x7FF9 | offset(低32)
        const slot = this.objBase + this._objDepth;   // 本层句柄槽（嵌套各占一层，避免内层覆盖）
        this._objDepth++;
        this.m.localSet(slot);                        // 句柄 → slot（i64）
        for (let i = 0; i < NF; i++) {
            this.m.localGet(slot);                    // [h]
            this.m.i32WrapI64();                      // 低32位=offset
            this.emitTaggedExpr(e.properties[i].initializer);   // [off(i32), val(i64)]
            this.m.i64Store(3, fIdx[i]);              // memory[off + idx] = val（fIdx 已是字节偏移）
        }
        this.m.localGet(slot);
        this._objDepth--;
        return;
    }
    if (ts.isArrayLiteralExpression(e)) {
        // 数组：稳定句柄布局 header(16B: len,cap,dataOff,pad) + data 块(elem i64×N)。
        // 句柄 = 0x7FF8|headerOff；push 增长只换 data 块、句柄不变（支持别名/传参/属性）。
        const N = e.elements.length;
        const total = 16 + N * 8;
        this.m.globalGet(0); this.m.i32Const(total); this.m.i32Add(); this.m.globalSet(0);
        this.m.globalGet(0); this.m.i32Const(total); this.m.i32Sub();     // → headerOff(i32)
        this.m.localSet(this.sT[0]);
        this.m.localGet(this.sT[0]); this.m.i32Const(N); this.m.i32Store(2, 0);    // len
        this.m.localGet(this.sT[0]); this.m.i32Const(N); this.m.i32Store(2, 4);    // cap
        this.m.localGet(this.sT[0]); this.m.localGet(this.sT[0]); this.m.i32Const(16); this.m.i32Add(); this.m.i32Store(2, 8);   // dataOff = off+16
        for (let i = 0; i < N; i++) {
            this.m.localGet(this.sT[0]); this.m.i32Load(2, 8);            // dataOff
            this.emitTaggedExpr(e.elements[i]);
            this.m.i64Store(3, i * 8);
        }
        this.m.localGet(this.sT[0]); this.m.i64ExtendI32U();
        this.m.i64ConstBits(0, 0x7ff80000); this.m.i64Or();               // 句柄
        return;
    }
    if (ts.isElementAccessExpression(e)) {
        // a[i]：数组句柄(0x7FF8) → header[+8]=dataOff → load [dataOff + i*8]；i 须 number。
        this.emitTaggedExpr(e.expression); this.m.localSet(this.scratch);   // scratch = 数组值
        this.emitTaggedExpr(e.argumentExpression);                          // [i_value:i64]
        this.m.f64ReinterpretI64(); this.m.i32TruncF64S();                  // → i32 index
        this.m.i32Const(8); this.m.i32Mul();
        this.m.localGet(this.scratch); this.m.i32WrapI64(); this.m.i32Load(2, 8); this.m.i32Add();   // dataOff + i*8
        this.m.i64Load(3, 0);
        return;
    }
    if (ts.isPropertyAccessExpression(e) && e.name.text === "length") {
        // .length：字符串(0x7FFA)/数组(0x7FF8) 结构首 i32 即 len → wasm 内 load；
        // 其余回退 qz.str_len（跨界，罕见）。
        this.emitTaggedExpr(e.expression);
        this.m.localSet(this.scratch);
        this.m.localGet(this.scratch); this.m.i64Const(48n); this.m.i64ShrU();
        this.m.i64Const(0x7ffan); this.m.i64Eq();
        this.m.localGet(this.scratch); this.m.i64Const(48n); this.m.i64ShrU();
        this.m.i64Const(0x7ff8n); this.m.i64Eq();
        this.m.i32Or();
        this.m.ifBlock("i64");
        this.m.localGet(this.scratch); this.m.i32WrapI64(); this.m.i32Load(2, 0);
        this.m.f64ConvertI32U(); this.m.i64ReinterpretF64();
        this.m.else_();
        this.m.localGet(this.scratch); this.m.call("qz.str_len");
        this.m.end();
        return;
    }
    if (ts.isPropertyAccessExpression(e)) {                                                 // obj.a（POJO：wasm load，零跨界）
        this.emitTaggedExpr(e.expression);
        this.m.i32WrapI64();                       // 低32位=offset
        this.m.i64Load(3, this._fieldIndex(e.name.text));                               // 字段 +8 字节步进
        return;
    }
    if (ts.isNewExpression(e)) { this._emitNewCall(e); return; }
    if (ts.isCallExpression(e) && ts.isSuperKeyword(e.expression)) {
        if (!this._curClassObj) throw new Error("[tagged] super() 仅在构造器内可用");
        this._emitSuperCall(this._curClassObj, e.arguments || []); return;
    }
    if (ts.isCallExpression(e)) {
        if (ts.isPropertyAccessExpression(e.expression)) {
            const rx = e.expression.expression, method = e.expression.name.text;
            if (method === "push" && e.arguments.length === 1) { this._emitArrayPush(rx, e.arguments[0]); return; }
            if (method === "pop" && e.arguments.length === 0) { this._emitArrayPop(rx); return; }
            this._emitDynMethod(rx, method, e.arguments); return;
        }
        if (!ts.isIdentifier(e.expression)) throw new Error("[tagged] 调用目标必须是标识符");
        const fn = e.expression.text;
        if (this.m._funcIdx[fn] === undefined && !this.fnNames.has(fn)) {
            // 非顶层函数 → 变量持有闭包：closure_call(handle, a0..a3)
            const hIdx = this._local(fn);
            if (hIdx === undefined) throw new Error("未定义函数: " + fn);
            for (let i = 0; i < 4; i++) {
                if (i < e.arguments.length) this.emitTaggedExpr(e.arguments[i]);
                else this._emitUndefined();
                this.m.localSet(this.cloArgs[i]);
            }
            this.m.localGet(hIdx);
            for (let i = 0; i < 4; i++) this.m.localGet(this.cloArgs[i]);
            this.m.call("qz.closure_call");
            return;
        }
        for (const a of e.arguments) this.emitTaggedExpr(a);
        this.m.call(e.expression.text); return;
    }
    if (ts.isConditionalExpression(e)) {                                                     // a ? b : c
        this.emitCondI32(e.condition);
        this.m.ifBlock("i64");
        this.emitTaggedExpr(e.whenTrue);
        this.m.else_();
        this.emitTaggedExpr(e.whenFalse);
        this.m.end();
        return;
    }
    if (ts.isPrefixUnaryExpression(e)) {
        if (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken) {
            // ++x / --x：x = x ± 1，返回新值
            const idx = this._local(e.operand.text);
            this.m.localGet(idx);
            this.m.i64ConstBits(...f64Bits(1));
            this.emitGuardedOp(e.operator === ts.SyntaxKind.PlusPlusToken ? "qz.add" : "qz.sub",
                               e.operator === ts.SyntaxKind.PlusPlusToken ? this.m.f64Add : this.m.f64Sub);
            this.m.localTee(idx);   // 新值留栈（表达式结果）
            return;
        }
        this.emitTaggedExpr(e.operand);
        if (e.operator === ts.SyntaxKind.ExclamationToken) {
            // !x：truthy 产裸 i32 → i32Eqz 取反 → 装箱为 tagged bool（emitTaggedExpr 契约恒 i64）
            this.m.call("qz.truthy"); this.m.i32Eqz(); this.emitBoxBool();
        } else if (e.operator === ts.SyntaxKind.MinusToken) {
            this.m.f64ReinterpretI64(); this.m.f64Neg(); this.m.i64ReinterpretF64();
        }
        return;
    }
    if (ts.isPostfixUnaryExpression(e)) {                                                    // x++ / x--（guard 命中走原生 f64）
        const idx = this._local(e.operand.text);
        this.m.localGet(idx); this.m.localSet(this.scratch);    // scratch=旧值（表达式结果）
        this.m.localGet(idx);
        this.m.i64ConstBits(...f64Bits(1));
        const inc = e.operator === ts.SyntaxKind.PlusPlusToken;
        this.emitGuardedOp(inc ? "qz.add" : "qz.sub", inc ? this.m.f64Add : this.m.f64Sub);
        this.m.localSet(idx);
        this.m.localGet(this.scratch);                          // 留旧值
        return;
    }
    if (ts.isBinaryExpression(e)) { this.emitTaggedBinary(e); return; }
    throw new Error("[tagged] 不支持的表达式: " + ts.SyntaxKind[e.kind]);
};
// 栈顶裸 i32 布尔 → tagged 值（i64）：f64 位型的 0.0/1.0。
// 注意与整数 0/1 的 i64 不同——tagged number 1 是 0x3FF0...，不是 1。
Emitter.prototype.emitBoxBool = function () {
    this.m.f64ConvertI32U(); this.m.i64ReinterpretF64();
};
// tagged 值 → 裸 i32 布尔（条件用）。比较二元表达式走 guard 特化：命中 number
// 走原生 f64 谓词（零跨界）；回退才调 qz.<op>。其余表达式经 qz.truthy。
const CMP_GUARD = {
    [ts.SyntaxKind.LessThanToken]: ["qz.lt", "f64Lt"],
    [ts.SyntaxKind.GreaterThanToken]: ["qz.gt", "f64Gt"],
    [ts.SyntaxKind.LessThanEqualsToken]: ["qz.le", "f64Le"],
    [ts.SyntaxKind.GreaterThanEqualsToken]: ["qz.ge", "f64Ge"],
    [ts.SyntaxKind.EqualsEqualsToken]: ["qz.seq", "f64Eq"],
    [ts.SyntaxKind.EqualsEqualsEqualsToken]: ["qz.seq", "f64Eq"],
    [ts.SyntaxKind.ExclamationEqualsToken]: ["qz.sne", "f64Ne"],
    [ts.SyntaxKind.ExclamationEqualsEqualsToken]: ["qz.sne", "f64Ne"],
};
// 栈顶 i64 句柄判定 → 在栈上留 i32：高16位 == 0x7FF9（对象）或 0x7FFA（字符串）。
// 仅靠 0x7FF9 会漏字符串句柄，导致字符串比较回落 f64（两 NaN eq → 恒 false）。
Emitter.prototype._emitIsHandle = function (scratch) {
    const M = this.m;
    M.localGet(scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ff9n); M.i64Eq();
    M.localGet(scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffan); M.i64Eq();
    M.i32Or();
};
Emitter.prototype.emitCmpI32 = function (qzName, f64cmp) {
    const M = this.m;
    M.localSet(this.scratchB); M.localSet(this.scratchA);
    this._emitIsHandle(this.scratchA); this._emitIsHandle(this.scratchB);
    M.i32Or();
    M.ifBlock("i32");
    // 含句柄：回退 qz.<op>，返回 tagged 0/1 位型 → reinterpret 后 !=0 转 i32
    M.localGet(this.scratchA); M.localGet(this.scratchB); M.call(qzName);
    M.f64ReinterpretI64(); M.f64Const(0); M.f64Ne();
    M.else_();
    M.localGet(this.scratchA); M.f64ReinterpretI64();
    M.localGet(this.scratchB); M.f64ReinterpretI64();
    M[f64cmp]();
    M.end();
};
Emitter.prototype.emitCondI32 = function (expr) {
    if (ts.isBinaryExpression(expr) && CMP_GUARD[expr.operatorToken.kind]) {
        const [qz, f64] = CMP_GUARD[expr.operatorToken.kind];
        this.emitTaggedExpr(expr.left); this.emitTaggedExpr(expr.right);
        this.emitCmpI32(qz, f64);
        return;
    }
    this.emitTaggedExpr(expr); this.m.call("qz.truthy");
};
// guarded 数值特化：栈 [a b] → 都是 tagged number 走原生指令，否则回退 qz.* 跨界。
// 数值=原始 f64 位型，句柄=高16位 0x7FF9（对象）/0x7FFA（字符串）→ reinterpret 后原生 f64 运算（零跨界）。
// cmp=true 时 fastEmit 产出 i32 谓词（f64.lt 等），需 extend 回 i64。
Emitter.prototype.emitGuardedOp = function (qzName, fastEmit, cmp) {
    this.m.localSet(this.scratchB);
    this.m.localSet(this.scratchA);
    // guard: 任一操作数是句柄即回退 qz.*（覆盖对象 + 字符串两种句柄）
    this._emitIsHandle(this.scratchA);
    this._emitIsHandle(this.scratchB);
    this.m.i32Or();
    this.m.ifBlock("i64");
    this.m.localGet(this.scratchA); this.m.localGet(this.scratchB); this.m.call(qzName);
    this.m.else_();
    this.m.localGet(this.scratchA); this.m.f64ReinterpretI64();
    this.m.localGet(this.scratchB); this.m.f64ReinterpretI64();
    fastEmit.call(this.m);
    // cmp: 谓词产裸 i32 → tagged bool 位型（与 qz.lt 回退分支的 f64 0.0/1.0 对齐）
    if (cmp) { this.m.f64ConvertI32U(); this.m.i64ReinterpretF64(); } else this.m.i64ReinterpretF64();
    this.m.end();
};

// 位运算 guard：命中双 number → f64→i32 截断 → 原生 i32 运算 → f64（JS 32 位语义）；
// 任一为句柄 → 回退 qz.<op>（宿主 JS 位运算）。unsigned（>>>）结果按无符号回 f64。
Emitter.prototype.emitGuardedBit = function (qzName, i32op, unsigned) {
    const M = this.m;
    M.localSet(this.scratchB); M.localSet(this.scratchA);
    this._emitIsHandle(this.scratchA); this._emitIsHandle(this.scratchB); M.i32Or();
    M.ifBlock("i64");
    M.localGet(this.scratchA); M.localGet(this.scratchB); M.call(qzName);
    M.else_();
    M.localGet(this.scratchA); M.f64ReinterpretI64(); M.i32TruncF64S();
    M.localSet(this.sT[0]);
    M.localGet(this.scratchB); M.f64ReinterpretI64(); M.i32TruncF64S();
    M.localSet(this.sT[1]);
    M.localGet(this.sT[0]); M.localGet(this.sT[1]); i32op.call(M);
    unsigned ? M.f64ConvertI32U() : M.f64ConvertI32S();
    M.i64ReinterpretF64();
    M.end();
};

// % 专用 guard：命中 number 走 wasm 内 a - trunc(a/b)*b（= JS 余数语义，含负数/除零 NaN），
// 否则回退 qz.rem。f64 无原生 rem，故不复用 emitGuardedOp 的 fastEmit 模型。
Emitter.prototype.emitTaggedRem = function () {
    const M = this.m;
    M.localSet(this.scratchB); M.localSet(this.scratchA);
    this._emitIsHandle(this.scratchA); this._emitIsHandle(this.scratchB); M.i32Or();
    M.ifBlock("i64");
    M.localGet(this.scratchA); M.localGet(this.scratchB); M.call("qz.rem");
    M.else_();
    M.localGet(this.scratchA); M.f64ReinterpretI64(); M.localSet(this.scratchFA);
    M.localGet(this.scratchB); M.f64ReinterpretI64(); M.localSet(this.scratchFB);
    M.localGet(this.scratchFA); M.localGet(this.scratchFB); M.f64Div(); M.f64Trunc();   // trunc(a/b)
    M.localGet(this.scratchFB); M.f64Mul(); M.localSet(this.scratchFB);                 // FB = trunc(a/b)*b
    M.localGet(this.scratchFA); M.localGet(this.scratchFB); M.f64Sub();                 // a - FB
    M.i64ReinterpretF64();
    M.end();
};
// 属性/索引赋值：值已在栈（i64）。注意会重新求值 receiver（读+写各一次；无副作用表达式安全）。
Emitter.prototype._emitStoreProp = function (left) {
    const M = this.m;
    M.localSet(this.scratch);                     // 值 → scratch（i64）
    this.emitTaggedExpr(left.expression);         // obj 句柄
    M.i32WrapI64();                               // 低32位 = offset
    M.localGet(this.scratch);
    M.i64Store(3, this._fieldIndex(left.name.text));
    M.localGet(this.scratch);                     // 赋值表达式返回所赋之值
};
Emitter.prototype._emitStoreElem = function (left) {
    const M = this.m;
    M.localSet(this.scratch);                     // 值 → scratch（i64）
    this.emitTaggedExpr(left.expression);         // 数组句柄
    M.i32WrapI64(); M.localSet(this.sT[0]);       // headerOff
    this.emitTaggedExpr(left.argumentExpression); // i（number）
    M.f64ReinterpretI64(); M.i32TruncF64S();
    M.i32Const(8); M.i32Mul();
    M.localGet(this.sT[0]); M.i32Load(2, 8); M.i32Add();   // dataOff + i*8
    M.localGet(this.scratch); M.i64Store(3, 0);
    M.localGet(this.scratch);                     // 返回所赋之值
};
// undefined = 句柄 0x7FF9|0（qzvm handles[0]=undefined）
Emitter.prototype._emitUndefined = function () { this.m.i64ConstBits(0, 0x7ff90000); };
// a.push(x)：header(16B)=[len,cap,dataOff,pad]；满则 bump 新 data 块 + memcpy（句柄不变）。
Emitter.prototype._emitArrayPush = function (rx, arg) {
    const M = this.m;
    this.emitTaggedExpr(rx); M.localSet(this.scratch);        // 数组句柄
    this.emitTaggedExpr(arg); M.localSet(this.scratchA);      // 待压值
    M.localGet(this.scratch); M.i32WrapI64(); M.localSet(this.sT[3]);   // h
    M.localGet(this.sT[3]); M.i32Load(2,0);                   // len
    M.localGet(this.sT[3]); M.i32Load(2,4);                   // cap
    M.i32GeS();
    M.ifBlock();
      M.localGet(this.sT[3]); M.i32Load(2,4); M.i32Eqz();     // cap==0
      M.ifBlock("i32"); M.i32Const(4); M.else_();
        M.localGet(this.sT[3]); M.i32Load(2,4); M.i32Const(2); M.i32Mul();
      M.end();
      M.localSet(this.sT[4]);                                 // newCap
      M.globalGet(0); M.localSet(this.sT[5]);                 // newData = bump
      M.globalGet(0); M.localGet(this.sT[4]); M.i32Const(8); M.i32Mul(); M.i32Add(); M.globalSet(0);
      M.localGet(this.sT[5]);                                 // dest
      M.localGet(this.sT[3]); M.i32Load(2,8);                 // src = oldData
      M.localGet(this.sT[3]); M.i32Load(2,0); M.i32Const(8); M.i32Mul();   // n = len*8
      M.call("qzs_memcpy");
      M.localGet(this.sT[3]); M.localGet(this.sT[5]); M.i32Store(2,8);     // header.dataOff = newData
      M.localGet(this.sT[3]); M.localGet(this.sT[4]); M.i32Store(2,4);     // header.cap = newCap
    M.end();
    M.localGet(this.sT[3]); M.i32Load(2,8);                   // dataOff
    M.localGet(this.sT[3]); M.i32Load(2,0); M.i32Const(8); M.i32Mul(); M.i32Add();
    M.localGet(this.scratchA); M.i64Store(3,0);               // data[len] = val
    M.localGet(this.sT[3]);
    M.localGet(this.sT[3]); M.i32Load(2,0); M.i32Const(1); M.i32Add(); M.i32Store(2,0);   // len++
    M.localGet(this.sT[3]); M.i32Load(2,0);
    M.f64ConvertI32U(); M.i64ReinterpretF64();                // 返回新长度（number）
};
// a.pop()：空 → undefined；否则取末元素 + len--。
Emitter.prototype._emitArrayPop = function (rx) {
    const M = this.m;
    this.emitTaggedExpr(rx); M.localSet(this.scratch);
    M.localGet(this.scratch); M.i32WrapI64(); M.localSet(this.sT[3]);   // h
    M.localGet(this.sT[3]); M.i32Load(2,0); M.i32Eqz();
    M.ifBlock("i64");
      this._emitUndefined();
    M.else_();
      M.localGet(this.sT[3]); M.i32Load(2,0); M.i32Const(1); M.i32Sub(); M.localSet(this.sT[4]);   // i = len-1
      M.localGet(this.sT[3]); M.localGet(this.sT[4]); M.i32Store(2,0);
      M.localGet(this.sT[3]); M.i32Load(2,8);                 // dataOff
      M.localGet(this.sT[4]); M.i32Const(8); M.i32Mul(); M.i32Add();
      M.i64Load(3,0);
    M.end();
};
// x.method(...)：字符串/通用方法经 qz.str_method(recv, nameId, a0, a1) 回退（正确处理 UTF-8）。
// 结果 = 句柄（字符串 toJS 还原；数值方法如 charCodeAt/indexOf 结果亦 join handles 表 → toJS 为 number）。
// 箭头/函数表达式求值：bump 分配 [funcidx:i32][nCaps:i32][cell×N]，
// 捕获变量逐个求值存入 cell，返回句柄 0x7FF9|off。
Emitter.prototype._emitLambdaNew = function (lam) {
    const M = this.m;
    const meta = this._lamById.get(lam);
    if (!meta) throw new Error("未登记的 lambda");
    const fidx = this.m._funcIdx[meta.fname];
    const caps = meta.caps.filter(n => this.varMap.has(n) || this.capMap.has(n));
    const total = 8 + caps.length * 8;
    M.globalGet(0); M.i32Const(total); M.i32Add(); M.globalSet(0);
    M.globalGet(0); M.i32Const(total); M.i32Sub();
    M.localSet(this.cloOff);                          // cloOff = off
    M.localGet(this.cloOff); M.i32Const(fidx); M.i32Store(2, 0);    // [off]=funcidx
    M.localGet(this.cloOff); M.i32Const(caps.length); M.i32Store(2, 4);  // [off+4]=nCaps
    for (let i = 0; i < caps.length; i++) {
        this._emitCapturedRead(caps[i]);              // [val]
        M.localSet(this.cloArgs[0]);                  // 暂存
        M.localGet(this.cloOff); M.i32Const(8 + i * 8); M.i32Add();   // [addr]
        M.localGet(this.cloArgs[0]);                  // [addr, val]
        M.i64Store(3, 0);
    }
    M.localGet(this.cloOff); M.i64ExtendI32U();
    M.i64ConstBits(0, 0x7ff9); M.i64Or();
};
// 类实例分配：size 覆盖全局字段表最大偏移（+8 头），clsId 写 [0]；返回 self 句柄。
Emitter.prototype._instSize = function () {
    return ((this.fieldMap ? this.fieldMap.size : 0) + 1) * 8;
};
Emitter.prototype._emitNewCall = function (e) {
    const M = this.m;
    if (!ts.isIdentifier(e.expression)) throw new Error("[tagged] new 目标必须是标识符");
    const cname = e.expression.text;
    if (!this.classes.has(cname)) throw new Error("[tagged] new 未知类: " + cname);
    const c = this.classes.get(cname);
    const args = e.arguments;
    if (args.length > 4) throw new Error("[tagged] new 最多 4 参");
    for (let i = 0; i < 4; i++) {
        if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
        M.localSet(this.cloArgs[i]);
    }
    M.i32Const(this._instSize());
    M.i32Const(c.id);
    M.call("qz.newobj");                                    // → self 句柄(i64)
    M.localSet(this.scratch);
    M.localGet(this.scratch);
    for (let i = 0; i < 4; i++) M.localGet(this.cloArgs[i]);
    M.call(ctorName(cname));                                // 写 __cls、字段、执行体
    M.localGet(this.scratch);                               // 表达式值 = 实例
};
// super(...)：在构造器内，self=local0。调父 ctor 后回写本类字段默认值（JS 派生字段初始化序）。
Emitter.prototype._emitSuperCall = function (c, args) {
    const M = this.m;
    if (!c.parent) throw new Error("[tagged] " + c.name + " 无父类，super() 非法");
    if (args.length > 4) throw new Error("[tagged] super 最多 4 参");
    for (let i = 0; i < 4; i++) {
        if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
        M.localSet(this.cloArgs[i]);
    }
    M.localGet(0);
    for (let i = 0; i < 4; i++) M.localGet(this.cloArgs[i]);
    M.call(ctorName(c.parent));
    this._emitFieldDefaults(c);                             // 子类字段默认值在 super 之后
};
// 合成派生 ctor：local1..4 = 补齐后的参数槽，原样转发给父 ctor。
Emitter.prototype._emitSuperCallForward = function (c) {
    const M = this.m;
    M.localGet(0);
    for (let i = 1; i <= 4; i++) M.localGet(i);
    M.call(ctorName(c.parent));
    this._emitFieldDefaults(c);
};
// 动态方法分派：method_call(recv, mid, a0..a3) → i64（qz 侧按 recv 类型派发：字符串→str_method；
// 类实例（内存[0]=__cls）→ classMeta 沿继承链调 wasm 导出方法）。未知类型/无方法 → 宿主抛错。
Emitter.prototype._emitDynMethod = function (rx, method, args) {
    const M = this.m;
    if (args.length > 4) throw new Error("[tagged] 方法最多 4 参");
    // 静态精确接收者：沿父链解析方法 owner 后直调导出 __m_<Owner>$<m>，跳过 qz.method_call。
    const cls = this._staticRecvClass(rx);
    if (cls) {
        const owner = this._methodOwner(cls, method);
        const meta = owner && this._classMethodMeta(owner, method);
        // 仅直调有返回值、非 setter 的普通方法；void/setter 语义与动态路径不同（动态返回 i64），退回。
        const voidRet = meta && !!meta.node.type && meta.node.type.kind === ts.SyntaxKind.VoidKeyword;
        if (owner && meta && meta.accessor !== "set" && !voidRet) {
            // 纯值栈：self + 4 参按形参序压栈（实参可为嵌套调用，天然按深度隔离，无需暂存槽）。
            this.emitTaggedExpr(rx);                                // self
            for (let i = 0; i < 4; i++) {
                if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
            }
            M.call(methName(owner, method));
            return;
        }
    }
    // 动态：压 recv + mid + 4 参入值栈（实参可为嵌套调用，无暂存槽覆盖问题）。
    this.emitTaggedExpr(rx);
    M.i32Const(this._strId(method));
    for (let i = 0; i < 4; i++) {
        if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
    }
    M.call("qz.method_call");
};
Emitter.prototype.emitTaggedBinary = function (e) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.FirstAssignment) {
        if (ts.isPropertyAccessExpression(e.left)) { this.emitTaggedExpr(e.right); this._emitStoreProp(e.left); return; }
        if (ts.isElementAccessExpression(e.left)) { this.emitTaggedExpr(e.right); this._emitStoreElem(e.left); return; }
        const idx = this._local(e.left.text);
        this.emitTaggedExpr(e.right);
        this.m.localTee(idx); return;
    }
    const COMPOUND = {
        [ts.SyntaxKind.PlusEqualsToken]: ts.SyntaxKind.PlusToken,
        [ts.SyntaxKind.MinusEqualsToken]: ts.SyntaxKind.MinusToken,
        [ts.SyntaxKind.AsteriskEqualsToken]: ts.SyntaxKind.AsteriskToken,
        [ts.SyntaxKind.SlashEqualsToken]: ts.SyntaxKind.SlashToken,
        [ts.SyntaxKind.PercentEqualsToken]: ts.SyntaxKind.PercentToken,
        [ts.SyntaxKind.LessThanLessThanEqualsToken]: ts.SyntaxKind.LessThanLessThanToken,
        [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanToken,
        [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
        [ts.SyntaxKind.AmpersandEqualsToken]: ts.SyntaxKind.AmpersandToken,
        [ts.SyntaxKind.BarEqualsToken]: ts.SyntaxKind.BarToken,
        [ts.SyntaxKind.CaretEqualsToken]: ts.SyntaxKind.CaretToken,
    };
    if (COMPOUND[op] !== undefined) {
        if (ts.isPropertyAccessExpression(e.left)) {
            this.emitTaggedExpr(e.left); this.emitTaggedExpr(e.right); this._emitBinOp(COMPOUND[op]);
            this._emitStoreProp(e.left); return;
        }
        if (ts.isElementAccessExpression(e.left)) {
            this.emitTaggedExpr(e.left); this.emitTaggedExpr(e.right); this._emitBinOp(COMPOUND[op]);
            this._emitStoreElem(e.left); return;
        }
        const idx = this._local(e.left.text);
        this.m.localGet(idx); this.emitTaggedExpr(e.right);
        this._emitBinOp(COMPOUND[op]);
        this.m.localTee(idx); return;
    }
    if (op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
        // a ||= b → a = a || b（值语义短路，与 emitShortCircuit 一致）；a &&= b → a = a && b
        const idx = this._local(e.left.text);
        this.emitShortCircuit(op === ts.SyntaxKind.AmpersandAmpersandEqualsToken, e.left, e.right);
        this.m.localTee(idx); return;
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        this.emitShortCircuit(op === ts.SyntaxKind.AmpersandAmpersandToken, e.left, e.right);
        return;
    }
    this.emitTaggedExpr(e.left); this.emitTaggedExpr(e.right);
    this._emitBinOp(op);
};
// 短路逻辑（值语义，真短路）：结果留 tagged i64。
//  && : truthy(a) ? b : a；|| : truthy(a) ? a : b
Emitter.prototype.emitShortCircuit = function (isAnd, left, right) {
    const M = this.m;
    M.block("i64");                                  // block (result i64)
    this.emitTaggedExpr(left);                       // [a]
    M.localSet(this.scratch);                        // []
    M.localGet(this.scratch);                        // [a]（跳转时作块结果）
    M.localGet(this.scratch); M.call("qz.truthy");   // [a, i32 ]
    if (isAnd) M.i32Eqz();                           // && : falsy(a) → 1
    M.brIf(0);                                       // 条件真 → 跳出块，[a] 为结果
    M.drop();                                        // 落下路径丢弃 a → []
    this.emitTaggedExpr(right);                      // 真短路：仅此路径求值 right
    M.end();
};
// 操作数已在栈上 [a, b]；按 op 发射运算
Emitter.prototype._emitBinOp = function (op) {
    const G = (qz, f64op, cmp) => () => this.emitGuardedOp(qz, f64op, cmp);
    const GUARD = {
        [ts.SyntaxKind.PlusToken]: () => this._emitConcat(),   // 任一操作数 0x7FFA → wasm 内拼接，否则数值
        [ts.SyntaxKind.MinusToken]: G("qz.sub", this.m.f64Sub),
        [ts.SyntaxKind.AsteriskToken]: G("qz.mul", this.m.f64Mul),
        [ts.SyntaxKind.SlashToken]: G("qz.div", this.m.f64Div),
        [ts.SyntaxKind.PercentToken]: () => this.emitTaggedRem(),   // f64 无原生 rem → a - trunc(a/b)*b
        [ts.SyntaxKind.LessThanToken]: G("qz.lt", this.m.f64Lt, true),
        [ts.SyntaxKind.GreaterThanToken]: G("qz.gt", this.m.f64Gt, true),
        [ts.SyntaxKind.LessThanEqualsToken]: G("qz.le", this.m.f64Le, true),
        [ts.SyntaxKind.GreaterThanEqualsToken]: G("qz.ge", this.m.f64Ge, true),
        [ts.SyntaxKind.EqualsEqualsToken]: G("qz.seq", this.m.f64Eq, true),
        [ts.SyntaxKind.EqualsEqualsEqualsToken]: G("qz.seq", this.m.f64Eq, true),
        [ts.SyntaxKind.ExclamationEqualsToken]: G("qz.sne", this.m.f64Ne, true),
        [ts.SyntaxKind.ExclamationEqualsEqualsToken]: G("qz.sne", this.m.f64Ne, true),
        [ts.SyntaxKind.AmpersandToken]: () => this.emitGuardedBit("qz.band", this.m.i32And, false),
        [ts.SyntaxKind.BarToken]: () => this.emitGuardedBit("qz.bor", this.m.i32Or, false),
        [ts.SyntaxKind.CaretToken]: () => this.emitGuardedBit("qz.bxor", this.m.i32Xor, false),
        [ts.SyntaxKind.LessThanLessThanToken]: () => this.emitGuardedBit("qz.shl", this.m.i32Shl, false),
        [ts.SyntaxKind.GreaterThanGreaterThanToken]: () => this.emitGuardedBit("qz.shr", this.m.i32ShrS, false),
        [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken]: () => this.emitGuardedBit("qz.ushr", this.m.i32ShrU, true),
    };
    if (GUARD[op]) { GUARD[op](); return; }
    const map = {
        [ts.SyntaxKind.PlusToken]: "qz.add", [ts.SyntaxKind.MinusToken]: "qz.sub",
        [ts.SyntaxKind.AsteriskToken]: "qz.mul", [ts.SyntaxKind.SlashToken]: "qz.div",
        [ts.SyntaxKind.PercentToken]: "qz.rem",
    };
    if (map[op]) { this.m.call(map[op]); return; }
    throw new Error("[tagged] 不支持的运算符: " + ts.SyntaxKind[op]);
};
Emitter.prototype._taggedOpFor = function (binKind) {
    const m = { Add: "qz.add", Subtract: "qz.sub", Asterisk: "qz.mul", Slash: "qz.div", Percent: "qz.rem" };
    return m[binKind] || "qz.add";
};

module.exports = { compileTS, Emitter };

if (require.main === module) {
    const input = process.argv[2];
    const out = process.argv[3] || "/tmp/out.wasm";
    const opts = { needMathFloor: true };
    const r = compileTS(input, out, opts);
    console.log("wrote", out, fs.statSync(out).size, "bytes; imports:", r.module.imports.length, "funcs:", r.module.funcs.length, "strings:", r.strings.length);
}