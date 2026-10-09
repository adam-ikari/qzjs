#!/usr/bin/env node
/* emitter.js — tsc AST → wasm 发射器（切片 2a：number-only）。
 * 值模型：TS 标注 number 的值 = 裸 i32 local，算术走原生 wasm 指令（零跨界）。
 * 动态值（any/string/对象）本切片报不支持，切片 2b 加 tagged i32 + qz.* import。
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
const QZ = {
  alloc:  { params: ["i32"],  results: ["i32"] },   // POJO: 分配 wasm 内存偏移
  object_new:   { params: [],        results: ["i32"] },
  object_set:   { params: ["i32", "i32", "i32"], results: [] },
  object_get:   { params: ["i32", "i32"], results: ["i32"] },
  string_new:   { params: ["i32"],   results: ["i32"] },
  string_concat:{ params: ["i32", "i32"], results: ["i32"] },
  add:  { params: ["i32", "i32"], results: ["i32"] },
  sub:  { params: ["i32", "i32"], results: ["i32"] },
  mul:  { params: ["i32", "i32"], results: ["i32"] },
  div:  { params: ["i32", "i32"], results: ["i32"] },
  rem:  { params: ["i32", "i32"], results: ["i32"] },
  lt:   { params: ["i32", "i32"], results: ["i32"] },
  gt:   { params: ["i32", "i32"], results: ["i32"] },
  le:   { params: ["i32", "i32"], results: ["i32"] },
  ge:   { params: ["i32", "i32"], results: ["i32"] },
  seq:  { params: ["i32", "i32"], results: ["i32"] },
  sne:  { params: ["i32", "i32"], results: ["i32"] },
  truthy: { params: ["i32"], results: ["i32"] },
  log:  { params: ["i32"], results: [] },
};
function registerQz(m) { for (const k of Object.keys(QZ)) m.importFn("qz", k, QZ[k].params, QZ[k].results); return m; }

class Emitter {
    constructor(mod) { this.m = mod; this.varMap = new Map(); this.depth = 0; this.labels = []; this.strings = []; }
    _local(name) { return this.varMap.get(name); }

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

    // ---------- 函数 ----------
    emitFunc(f) {
        const params = f.parameters.map(p => "i32");
        const locals = this._collectLocals(f.body);
        const isVoid = !!f.type && f.type.kind === ts.SyntaxKind.VoidKeyword;
        // 模式：参数全 number 注解 → 裸 i32 快路径；否则 tagged（动态值）路径
        this.mode = f.parameters.every(p => p.type && p.type.getText && p.type.kind === ts.SyntaxKind.NumberKeyword) ? "num" : "tagged";
        this.scratch = f.parameters.length + locals.length;   // scratch（后缀 ++/--）
        this.scratchA = this.scratch + 1;                    // guard 暂存 a
        this.scratchB = this.scratch + 2;                    // guard 暂存 b
        this.m.startBody(f.name.text, locals.map(() => "i32").concat(["i32", "i32", "i32"]));   // + scratch(++)/scratchA/scratchB（guard 暂存）
        // 参数 → local 0..n-1；局部 → n..
        f.parameters.forEach((p, i) => this.varMap.set(p.name.text, i));
        locals.forEach((n, i) => this.varMap.set(n, f.parameters.length + i));
        this.depth = 0; this.labels = [];
        if (this.mode === "tagged") this.emitTaggedBlock(f.body);
        else this.emitBlock(f.body);
        this.m.endBody();
        this.m.exportFn(f.name.text, f.name.text);
        this.varMap.clear();
    }

    // ---------- 语句 ----------
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
            this.emitExpr(s.expression !== undefined ? s.expression : s.condition);
            this.m.ifBlock();          // 语句 if 无返回值
            this.depth++;
            this.labels.push({ brk: this.depth, cont: null });
            this.emitStmt(s.thenStatement);
            if (s.elseStatement) { this.m.else_(); this.emitStmt(s.elseStatement); }
            this.labels.pop();
            this.depth--;
            this.m.end();
            return;
        }
        if (ts.isWhileStatement(s)) { this.emitWhile(s); return; }
        if (ts.isForStatement(s)) { this.emitFor(s); return; }
        if (ts.isBlock(s)) { this.emitBlock(s); return; }
        if (ts.isExpressionStatement(s)) { this.emitExpr(s.expression); this.m.drop(); return; }
        if (ts.isEmptyStatement(s)) return;
        throw new Error("不支持的语句: " + ts.SyntaxKind[s.kind]);
    }

    emitWhile(s) {
        this.m.block(); this.depth++;
        this.m.loop(); this.depth++;
        this.labels.push({ brk: this.depth - 1, cont: this.depth });
        this.emitExpr(s.expression !== undefined ? s.expression : s.condition);
        this.m.i32Eqz();
        this.m.brIf(1);                     // 退出外层 block
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
        this.m.block(); this.depth++;
        this.m.loop(); this.depth++;
        this.labels.push({ brk: this.depth - 1, cont: this.depth });
        if (s.condition) { this.emitExpr(s.condition); this.m.i32Eqz(); this.m.brIf(1); }
        if (s.statement) this.emitStmt(s.statement);
        if (s.incrementor) { this.emitExpr(s.incrementor); this.m.drop(); }
        this.m.br(0);
        this.labels.pop();
        this.depth--; this.m.end();
        this.depth--; this.m.end();
    }

    // ---------- 表达式（number 域） ----------
    emitExpr(e) {
        if (ts.isNumericLiteral(e)) { this.m.i32Const(Number(e.text)); return; }
        if (ts.isIdentifier(e)) {
            const idx = this._local(e.text);
            if (idx === undefined) throw new Error("未定义变量: " + e.text);
            this.m.localGet(idx); return;
        }
        if (ts.isParenthesizedExpression(e)) { this.emitExpr(e.expression); return; }
        if (ts.isPrefixUnaryExpression(e)) {
            this.emitExpr(e.operand);
            if (e.operator === ts.SyntaxKind.MinusToken) { this.m.i32Const(0); this.m.i32Sub(); }
            else if (e.operator === ts.SyntaxKind.PlusToken) { /* noop */ }
            else if (e.operator === ts.SyntaxKind.ExclamationToken) { this.m.i32Eqz(); }
            else throw new Error("不支持的一元运算符: " + ts.SyntaxKind[e.operator]);
            return;
        }
        if (ts.isPostfixUnaryExpression(e)) {
            const idx = this._local(e.operand.text);
            if (idx === undefined) throw new Error("未定义变量: " + e.operand.text);
            const dec = e.operator === ts.SyntaxKind.MinusMinusToken;
            // x++：栈留旧值（localTee scratch），x 更新
            this.m.localGet(idx); this.m.localTee(this.scratch);
            this.m.localGet(idx); this.m.i32Const(1); dec ? this.m.i32Sub() : this.m.i32Add(); this.m.localSet(idx);
            return;
        }
        if (ts.isPrefixUnaryExpression(e)) {
            const idx = this._local(e.operand.text);
            if (idx === undefined) throw new Error("未定义变量: " + e.operand.text);
            const dec = e.operator === ts.SyntaxKind.MinusMinusToken;
            this.m.localGet(idx); this.m.i32Const(1); dec ? this.m.i32Sub() : this.m.i32Add(); this.m.localTee(idx);
            return;
        }
        if (ts.isBinaryExpression(e)) { this.emitBinary(e); return; }
        if (ts.isCallExpression(e)) {
            if (!ts.isIdentifier(e.expression)) throw new Error("不支持的调用目标");
            const fn = e.expression.text;
            if (fn === "Math_floor") { this.emitExpr(e.arguments[0]); this.m.call("qz.math_floor"); return; }
            for (const a of e.arguments) this.emitExpr(a);
            this.m.call(fn);
            return;
        }
        throw new Error("不支持的表达式: " + ts.SyntaxKind[e.kind]);
    }

    emitBinary(e) {
        const op = e.operatorToken.kind;
        // 赋值：x = rhs → localTee（保留值供表达式上下文）；x op= rhs → 读-算-写
        const assignOps = { [ts.SyntaxKind.EqualsToken]: null, [ts.SyntaxKind.PlusEqualsToken]: ts.SyntaxKind.PlusToken, [ts.SyntaxKind.MinusEqualsToken]: ts.SyntaxKind.MinusToken, [ts.SyntaxKind.AsteriskEqualsToken]: ts.SyntaxKind.AsteriskToken, [ts.SyntaxKind.SlashEqualsToken]: ts.SyntaxKind.SlashToken, [ts.SyntaxKind.PercentEqualsToken]: ts.SyntaxKind.PercentToken };
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

        // 短路逻辑
        if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
            // 简化：非短路直接算两边（数值域布尔即 0/1）
            this.emitBinaryOperandValue(e.left); this.emitBinaryOperandValue(e.right);
            if (op === ts.SyntaxKind.AmpersandAmpersandToken) this.m.i32And(); else this.m.i32Or();
            return;
        }
        this.emitBinaryOperandValue(e.left);
        this.emitBinaryOperandValue(e.right);
        this.emitBinaryOp(op);
    }
    emitBinaryOp(op) {
        switch (op) {
            case ts.SyntaxKind.PlusToken: this.m.i32Add(); break;
            case ts.SyntaxKind.MinusToken: this.m.i32Sub(); break;
            case ts.SyntaxKind.AsteriskToken: this.m.i32Mul(); break;
            case ts.SyntaxKind.SlashToken: this.m.i32DivS(); break;
            case ts.SyntaxKind.PercentToken: this.m.i32RemS(); break;
            case ts.SyntaxKind.LessThanToken: this.m.i32LtS(); break;
            case ts.SyntaxKind.GreaterThanToken: this.m.i32GtS(); break;
            case ts.SyntaxKind.LessThanEqualsToken: this.m.i32LeS(); break;
            case ts.SyntaxKind.GreaterThanEqualsToken: this.m.i32GeS(); break;
            case ts.SyntaxKind.EqualsEqualsToken: case ts.SyntaxKind.EqualsEqualsEqualsToken: this.m.i32Eq(); break;
            case ts.SyntaxKind.ExclamationEqualsToken: case ts.SyntaxKind.ExclamationEqualsEqualsToken: this.m.i32Ne(); break;
            case ts.SyntaxKind.AmpersandToken: this.m.i32And(); break;
            case ts.SyntaxKind.BarToken: this.m.i32Or(); break;
            default: throw new Error("不支持的二元运算符: " + ts.SyntaxKind[op]);
        }
    }
    emitBinaryOperandValue(e) { if (ts.isBinaryExpression(e)) this.emitBinary(e); else this.emitExpr(e); }
}

// ---------- 主流程 ----------
function compileTS(input, outWasm, opts = {}) {
    const program = ts.createProgram([input], { strict: true, target: ts.ScriptTarget.ES2020 });
    const sf = program.getSourceFile(input);
    const m = new Module();
    // 预注册 import（qz.math_floor 等）
    if (opts.needMathFloor) m.importFn("qz", "math_floor", ["i32"], ["i32"]);
    const em = new Emitter(m);
    const fns = sf.statements.filter(st => ts.isFunctionDeclaration(st) && st.name);
    // 阶段1：任一函数为 tagged → 注册全部 qz.* import；登记所有函数签名（支持前向/互递归）
    const anyTagged = fns.some(f => !f.parameters.every(p => p.type && p.type.kind === ts.SyntaxKind.NumberKeyword));
    if (anyTagged) { registerQz(m); m.addMemory(2); m.addGlobal("i32", 0); }   // global0 = wasm 内 bump 分配器   // 本地定义 memory（wamrc AOT 只支持本地 memory，不支持 import）
    for (const st of fns) {
        const isVoid = !!st.type && st.type.kind === ts.SyntaxKind.VoidKeyword;
        m.declareFunc(st.name.text, st.parameters.map(() => "i32"), isVoid ? [] : ["i32"]);
    }
    if (anyTagged) m.exportMemory();          // 导出本地 memory（qz.alloc 经 exports.memory 访问）
    // 阶段2：逐个发射 body
    for (const st of fns) em.emitFunc(st);
    // 字段槽位可能超 2 页 → 按需扩内存
    // memory 由宿主提供（import），此处仅校验字段槽位是否放得下
    fs.writeFileSync(outWasm, m.build());
    return { module: m, strings: em.strings || [], fields: em.fieldMap ? [...em.fieldMap.keys()] : [] };
}


// ================= tagged 模式发射（动态值：对象/字符串/any） =================
// tagged i32: bit0=0 数值(v>>1) | bit0=1 handle(v>>1，qzrt 表索引)
Emitter.prototype._fieldIndex = function (name) {
    if (!this.fieldMap) this.fieldMap = new Map();
    let i = this.fieldMap.get(name);
    if (i === undefined) { i = this.fieldMap.size; this.fieldMap.set(name, i); }
    return i * 4;                     // 字节偏移
};
Emitter.prototype._strId = function (text) {
    let i = this.strings.indexOf(text);
    if (i < 0) { i = this.strings.length; this.strings.push(text); }
    return i;
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
    if (ts.isIfStatement(s)) {
        this.emitTaggedExpr(s.expression !== undefined ? s.expression : s.condition);
        this.m.ifBlock(); this.depth++;          // 条件是 tagged bool（0 假/非0 真），wasm if 直接用
        this.labels.push({ brk: this.depth, cont: null });
        this.emitTaggedStmt(s.thenStatement);
        if (s.elseStatement) { this.m.else_(); this.emitTaggedStmt(s.elseStatement); }
        this.labels.pop(); this.depth--; this.m.end(); return;
    }
    if (ts.isWhileStatement(s)) {
        this.m.block(); this.depth++; this.m.loop(); this.depth++;
        this.labels.push({ brk: this.depth - 1, cont: this.depth });
        this.emitTaggedExpr(s.expression !== undefined ? s.expression : s.condition);
        this.m.i32Eqz(); this.m.brIf(1);      // 条件已是 tagged bool（guard 产出 0/2），无需 qz.truthy
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
        this.m.block(); this.depth++; this.m.loop(); this.depth++;
        this.labels.push({ brk: this.depth - 1, cont: this.depth });
        if (s.condition) { this.emitTaggedExpr(s.condition); this.m.i32Eqz(); this.m.brIf(1); }
        if (s.statement) this.emitTaggedStmt(s.statement);
        if (s.incrementor) { this.emitTaggedExpr(s.incrementor); this.m.drop(); }
        this.m.br(0);
        this.labels.pop(); this.depth--; this.m.end(); this.depth--; this.m.end(); return;
    }
    if (ts.isBlock(s)) { this.emitTaggedBlock(s); return; }
    if (ts.isExpressionStatement(s)) {
        // console.log(x) → qz.log（边界输出）
        const ex = s.expression;
        if (ts.isCallExpression(ex) && ts.isPropertyAccessExpression(ex.expression) && ex.expression.expression.text === "console") {
            for (const a of ex.arguments) { this.emitTaggedExpr(a); this.m.call("qz.log"); }
            return;
        }
        this.emitTaggedExpr(ex); this.m.drop(); return;
    }
    if (ts.isEmptyStatement(s)) return;
    throw new Error("[tagged] 不支持的语句: " + ts.SyntaxKind[s.kind]);
};
Emitter.prototype.emitTaggedExpr = function (e) {
    if (ts.isNumericLiteral(e)) { this.m.i32Const(Number(e.text) * 2); return; }          // tagged number = n<<1
    if (ts.isStringLiteral(e)) { this.m.i32Const(this._strId(e.text)); this.m.call("qz.string_new"); return; }
    if (ts.isIdentifier(e)) { const idx = this._local(e.text); if (idx === undefined) throw new Error("未定义变量: " + e.text); this.m.localGet(idx); return; }
    if (ts.isParenthesizedExpression(e)) { this.emitTaggedExpr(e.expression); return; }
    if (ts.isObjectLiteralExpression(e)) {
        // POJO：字段驻留 wasm 线性内存（零跨界读写）。tagged handle = (offset<<1)|1。
        if (!ts.isObjectLiteralExpression(e) || e.properties.some(p => !ts.isPropertyAssignment(p))) {
            throw new Error("[tagged] 对象字面量只支持 { x: v } 形式");
        }
        const NF = e.properties.length;
        // 内联 bump：global0 += NF*4; offset = new_bump - NF*4（零跨界）
        this.m.globalGet(0);
        this.m.i32Const(NF * 4);
        this.m.i32Add();
        this.m.globalSet(0);
        this.m.globalGet(0);
        this.m.i32Const(NF * 4);
        this.m.i32Sub();                      // → offset
        this.m.i32Const(1); this.m.i32Shl();  // offset<<1
        this.m.i32Const(1); this.m.i32Or();   // |1 = tagged handle
        this.m.localSet(this.scratch);
        for (let i = 0; i < NF; i++) {
            this.m.localGet(this.scratch);   // [h]
            this.m.i32Const(1); this.m.i32ShrU();  // [off]
            this.emitTaggedExpr(e.properties[i].initializer);  // [off, val]
            this.m.i32Store(2, i * 4);       // memory[off + i*4] = val
        }
        this.m.localGet(this.scratch); return;
    }
    if (ts.isPropertyAccessExpression(e)) {                                                 // obj.a（POJO：wasm load，零跨界）
        this.emitTaggedExpr(e.expression);
        this.m.i32Const(1); this.m.i32ShrU();          // tagged handle → offset
        this.m.i32Load(2, this._fieldIndex(e.name.text));  // memory[off + fieldOff]（tagged 值）
        return;
    }
    if (ts.isCallExpression(e)) {
        if (!ts.isIdentifier(e.expression)) throw new Error("[tagged] 调用目标必须是标识符");
        for (const a of e.arguments) this.emitTaggedExpr(a);
        this.m.call(e.expression.text); return;
    }
    if (ts.isPrefixUnaryExpression(e)) {
        this.emitTaggedExpr(e.operand);
        if (e.operator === ts.SyntaxKind.ExclamationToken) this.m.call("qz.truthy");
        else if (e.operator === ts.SyntaxKind.MinusToken) { this.m.i32Const(0); this.m.call("qz.sub"); }
        return;
    }
    if (ts.isPostfixUnaryExpression(e)) {                                                    // x++（tagged +1）
        const idx = this._local(e.operand.text);
        this.m.localGet(idx); this.m.localTee(this.scratch);
        this.m.localGet(idx); this.m.i32Const(2); this.m.call("qz.add"); this.m.localSet(idx);
        return;
    }
    if (ts.isBinaryExpression(e)) { this.emitTaggedBinary(e); return; }
    throw new Error("[tagged] 不支持的表达式: " + ts.SyntaxKind[e.kind]);
};
// guarded 数值特化：栈 [a b] → 若都是 tagged number（bit0=0）走原生指令，
// 否则回退 qz.*（JS 语义：字符串拼接 / 对象等）。跨界仅在慢路径。
Emitter.prototype.emitGuardedOp = function (qzName, fastEmit) {
    this.m.localSet(this.scratchB);
    this.m.localSet(this.scratchA);
    this.m.localGet(this.scratchA); this.m.i32Const(1); this.m.i32And();
    this.m.localGet(this.scratchB); this.m.i32Const(1); this.m.i32And();
    this.m.i32Or();
    this.m.ifBlock("i32");
    this.m.localGet(this.scratchA); this.m.localGet(this.scratchB); this.m.call(qzName);
    this.m.else_();
    this.m.localGet(this.scratchA); this.m.i32Const(1); this.m.i32ShrU();
    this.m.localGet(this.scratchB); this.m.i32Const(1); this.m.i32ShrU();
    fastEmit.call(this.m);
    this.m.i32Const(1); this.m.i32Shl();
    this.m.end();
};
Emitter.prototype.emitTaggedBinary = function (e) {
    const op = e.operatorToken.kind;
    // 数值可特化：guard 判定后原生运算（tagged number），否则 qz.* JS 语义
    const GUARD = {
        [ts.SyntaxKind.PlusToken]: () => this.emitGuardedOp("qz.add", this.m.i32Add),
        [ts.SyntaxKind.MinusToken]: () => this.emitGuardedOp("qz.sub", this.m.i32Sub),
        [ts.SyntaxKind.AsteriskToken]: () => this.emitGuardedOp("qz.mul", this.m.i32Mul),
        [ts.SyntaxKind.SlashToken]: () => this.emitGuardedOp("qz.div", this.m.i32DivS),
        [ts.SyntaxKind.PercentToken]: () => this.emitGuardedOp("qz.rem", this.m.i32RemS),
        [ts.SyntaxKind.LessThanToken]: () => this.emitGuardedOp("qz.lt", this.m.i32LtS),
        [ts.SyntaxKind.GreaterThanToken]: () => this.emitGuardedOp("qz.gt", this.m.i32GtS),
        [ts.SyntaxKind.LessThanEqualsToken]: () => this.emitGuardedOp("qz.le", this.m.i32LeS),
        [ts.SyntaxKind.GreaterThanEqualsToken]: () => this.emitGuardedOp("qz.ge", this.m.i32GeS),
        [ts.SyntaxKind.EqualsEqualsToken]: () => this.emitGuardedOp("qz.seq", this.m.i32Eq),
        [ts.SyntaxKind.EqualsEqualsEqualsToken]: () => this.emitGuardedOp("qz.seq", this.m.i32Eq),
        [ts.SyntaxKind.ExclamationEqualsToken]: () => this.emitGuardedOp("qz.sne", this.m.i32Ne),
        [ts.SyntaxKind.ExclamationEqualsEqualsToken]: () => this.emitGuardedOp("qz.sne", this.m.i32Ne),
    };
    const map = {
        [ts.SyntaxKind.PlusToken]: "qz.add", [ts.SyntaxKind.MinusToken]: "qz.sub",
        [ts.SyntaxKind.AsteriskToken]: "qz.mul", [ts.SyntaxKind.SlashToken]: "qz.div",
        [ts.SyntaxKind.PercentToken]: "qz.rem", [ts.SyntaxKind.LessThanToken]: "qz.lt",
        [ts.SyntaxKind.GreaterThanToken]: "qz.gt", [ts.SyntaxKind.LessThanEqualsToken]: "qz.le",
        [ts.SyntaxKind.GreaterThanEqualsToken]: "qz.ge", [ts.SyntaxKind.EqualsEqualsToken]: "qz.seq",
        [ts.SyntaxKind.EqualsEqualsEqualsToken]: "qz.seq", [ts.SyntaxKind.ExclamationEqualsToken]: "qz.sne",
        [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "qz.sne",
    };
    if (GUARD[op]) { this.emitTaggedExpr(e.left); this.emitTaggedExpr(e.right); GUARD[op](); return; }
    if (map[op]) { this.emitTaggedExpr(e.left); this.emitTaggedExpr(e.right); this.m.call(map[op]); return; }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        this.emitTaggedExpr(e.left); this.m.call("qz.truthy"); this.m.i32Eqz();
        this.emitTaggedExpr(e.right); this.m.call("qz.truthy");
        if (op === ts.SyntaxKind.AmpersandAmpersandToken) this.m.i32And(); else this.m.i32Or();
        return;
    }
    if (op === ts.SyntaxKind.FirstAssignment || Object.values(ts.SyntaxKind).includes(op) && /Equals/.test(ts.SyntaxKind[op] || "")) {
        const idx = this._local(e.left.text);
        const bin = op === ts.SyntaxKind.FirstAssignment ? null : ts.SyntaxKind[op].replace("Equals", "");
        if (bin !== null) { this.m.localGet(idx); this.emitTaggedExpr(e.right); this.m.call(this._taggedOpFor(bin)); }
        else this.emitTaggedExpr(e.right);
        this.m.localTee(idx); return;
    }
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