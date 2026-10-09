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

class Emitter {
    constructor(mod) { this.m = mod; this.varMap = new Map(); this.depth = 0; this.labels = []; }
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
        this.scratch = f.parameters.length + locals.length;   // 末尾追加 scratch（后缀 ++/-- 需要）
        this.m.addFunc(f.name.text, params, isVoid ? [] : ["i32"], locals.map(() => "i32").concat(["i32"]));  // 局部全 i32 + scratch
        // 参数 → local 0..n-1；局部 → n..
        f.parameters.forEach((p, i) => this.varMap.set(p.name.text, i));
        locals.forEach((n, i) => this.varMap.set(n, f.parameters.length + i));
        this.depth = 0; this.labels = [];
        this.emitBlock(f.body);
        this.m.finish();
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
    for (const st of sf.statements) {
        if (ts.isFunctionDeclaration(st) && st.name) em.emitFunc(st);
    }
    fs.writeFileSync(outWasm, m.build());
    return m;
}

module.exports = { compileTS, Emitter };

if (require.main === module) {
    const input = process.argv[2];
    const out = process.argv[3] || "/tmp/out.wasm";
    const opts = { needMathFloor: true };
    const m = compileTS(input, out, opts);
    console.log("wrote", out, fs.statSync(out).size, "bytes; imports:", m.imports.length, "funcs:", m.funcs.length);
}