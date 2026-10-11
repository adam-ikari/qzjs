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
};
function registerQz(m) { for (const k of Object.keys(QZ)) m.importFn("qz", k, QZ[k].params, QZ[k].results); return m; }

class Emitter {
    constructor(mod) { this.m = mod; this.varMap = new Map(); this.depth = 0; this.labels = []; this.strings = []; this._litOff = new Map(); this._strVars = new Set(); }
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
        this.m.startBody(f.name.text, locals.map(() => vt).concat([vt, vt, vt]).concat(extra).concat(sT));
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
            this.emitExpr(s.expression !== undefined ? s.expression : s.condition); this.emitCond();
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
        if (ts.isBreakStatement(s)) { this.m.br(this._loopLabel().brkRel); return; }
        if (ts.isDoStatement(s)) { this.emitDoWhile(s, false); return; }
        if (ts.isContinueStatement(s)) { this.m.br(this._loopLabel().contRel); return; }
        if (ts.isWhileStatement(s)) { this.emitWhile(s); return; }
        if (ts.isForStatement(s)) { this.emitFor(s); return; }
        if (ts.isBlock(s)) { this.emitBlock(s); return; }
        if (ts.isExpressionStatement(s)) { this.emitExpr(s.expression); this.m.drop(); return; }
        if (ts.isEmptyStatement(s)) return;
        throw new Error("不支持的语句: " + ts.SyntaxKind[s.kind]);
    }

    // break/continue → 最近的循环 label（cont != null），算 wasm 相对深度。
    _loopLabel() {
        for (let i = this.labels.length - 1; i >= 0; i--) {
            const L = this.labels[i];
            if (L.cont != null) return { brkRel: this.depth - L.brk, contRel: this.depth - L.cont };
        }
        throw new Error("break/continue 不在循环内");
    }

    emitWhile(s) {
        this.m.block(); this.depth++;
        this.m.loop(); this.depth++;
        this.labels.push({ brk: this.depth - 1, cont: this.depth });
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
        this.labels.push({ brk: this.depth - 2, cont: this.depth });
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
        this.labels.push({ brk: this.depth - 2, cont: this.depth });
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
            default: throw new Error("不支持的二元运算符: " + ts.SyntaxKind[op]);
        }
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
    return (allNum && rtOk && (f.parameters.length > 0 || (rt && rt.kind === ts.SyntaxKind.NumberKeyword))) ? "num" : "tagged";
}

function compileTS(input, outWasm, opts = {}) {
    const program = ts.createProgram([input], { strict: true, target: ts.ScriptTarget.ES2020 });
    const sf = program.getSourceFile(input);
    const m = new Module();
    // 预注册 import（qz.math_floor 等）
    if (opts.needMathFloor) m.importFn("qz", "math_floor", ["i32"], ["i32"]);
    const em = new Emitter(m);
    const fns = sf.statements.filter(st => ts.isFunctionDeclaration(st) && st.name);
    // 阶段1：任一函数为 tagged → 注册全部 qz.* import + 字符串 helper；登记所有函数签名（支持前向/互递归）
    const anyTagged = fns.some(f => funcMode(f) === "tagged");
    if (anyTagged) {
        registerQz(m);
        m.addMemory(32);                                 // 2 MiB：heap(<1MiB) + 字面量(STR_BASE 起)
        m.addGlobal("i32", STR_BUMP);                    // global0 = bump 堆（字符串/对象）
        emitStringHelpers(m);
    }
    for (const st of fns) {
        const isVoid = !!st.type && st.type.kind === ts.SyntaxKind.VoidKeyword;
        const isNum = funcMode(st) === "num";
        const vt = isNum ? "f64" : "i64";   // num=f64；tagged=f64 NaN-box(i64)
        m.declareFunc(st.name.text, st.parameters.map(() => vt), isVoid ? [] : [vt]);
    }
    if (anyTagged) m.exportMemory();          // 导出本地 memory（qz.alloc 经 exports.memory 访问）
    // 阶段2：逐个发射 body
    for (const st of fns) em.emitFunc(st);
    fs.writeFileSync(outWasm, m.build());
    // funcMeta: 每导出函数 {name, mode(num/tagged), params}
    const funcMeta = fns.map(f => ({
        name: f.name.text,
        mode: funcMode(f),
        params: f.parameters.length,
    }));
    return { module: m, strings: em.strings || [], fields: em.fieldMap ? [...em.fieldMap.keys()] : [], funcMeta };
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
    return i * 8;   // 字节偏移（字段 8 字节，存 i64）
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
    if (ts.isBreakStatement(s)) { this.m.br(this._loopLabel().brkRel); return; }
    if (ts.isContinueStatement(s)) { this.m.br(this._loopLabel().contRel); return; }
    if (ts.isDoStatement(s)) { this.emitDoWhile(s, true); return; }
    if (ts.isIfStatement(s)) {
        this.emitCondI32(s.expression !== undefined ? s.expression : s.condition);
        this.m.ifBlock(); this.depth++;          // 条件已归约为裸 i32 布尔
        this.labels.push({ brk: this.depth, cont: null });
        this.emitTaggedStmt(s.thenStatement);
        if (s.elseStatement) { this.m.else_(); this.emitTaggedStmt(s.elseStatement); }
        this.labels.pop(); this.depth--; this.m.end(); return;
    }
    if (ts.isWhileStatement(s)) {
        this.m.block(); this.depth++; this.m.loop(); this.depth++;
        this.labels.push({ brk: this.depth - 1, cont: this.depth });
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
        this.labels.push({ brk: this.depth - 2, cont: this.depth });
        if (s.statement) this.emitTaggedStmt(s.statement);
        this.labels.pop();
        this.depth--; this.m.end();                       // end cont block
        if (s.incrementor) { this.emitTaggedExpr(s.incrementor); this.m.drop(); }
        this.m.br(0);
        this.depth--; this.m.end();                       // end loop
        this.depth--; this.m.end(); return;               // end brk block
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
    if (ts.isNumericLiteral(e)) {
        this.m.i64ConstBits(...f64Bits(Number(e.text)));   // 数值 = 原始 f64 位型
        return;
    }
    if (ts.isStringLiteral(e)) { this._emitStrLitHandle(e.text); return; }
    if (ts.isIdentifier(e)) { const idx = this._local(e.text); if (idx === undefined) throw new Error("未定义变量: " + e.text); this.m.localGet(idx); return; }
    if (ts.isParenthesizedExpression(e)) { this.emitTaggedExpr(e.expression); return; }
    if (ts.isObjectLiteralExpression(e)) {
        // POJO：字段驻留 wasm 线性内存（零跨界读写）。句柄 = box(高16位0x7FF9 | offset)。字段宽 8 字节（i64）。
        if (e.properties.some(p => !ts.isPropertyAssignment(p))) {
            throw new Error("[tagged] 对象字面量只支持 { x: v } 形式");
        }
        const NF = e.properties.length;
        // 内联 bump：global0 += NF*8; offset = new_bump - NF*8（零跨界）
        this.m.globalGet(0);
        this.m.i32Const(NF * 8);
        this.m.i32Add();
        this.m.globalSet(0);
        this.m.globalGet(0);
        this.m.i32Const(NF * 8);
        this.m.i32Sub();                            // → offset(i32)
        this.m.i64ExtendI32U(); this.m.i64ConstBits(0, 0x7ff9); this.m.i64Or();   // 句柄 = 高16位0x7FF9 | offset(低32)
        this.m.localSet(this.scratch);              // scratch 保存句柄（i64）
        for (let i = 0; i < NF; i++) {
            this.m.localGet(this.scratch);          // [h]
            this.m.i32WrapI64();                                            // 低32位=offset
            this.emitTaggedExpr(e.properties[i].initializer);              // [off(i32), val(i64)]
            this.m.i64Store(3, i * 8);          // memory[off + i*8] = val
        }
        this.m.localGet(this.scratch); return;
    }
    if (ts.isArrayLiteralExpression(e)) {
        // 数组：bump 分配 [len:i32][pad:i32][elem:i64×N]（元素自 +8，8B 步进）。
        // 句柄 = 高16位 0x7FF8 | offset(低32)。零跨界。
        const N = e.elements.length;
        const bytes = 8 + N * 8;
        this.m.globalGet(0); this.m.i32Const(bytes); this.m.i32Add(); this.m.globalSet(0);
        this.m.globalGet(0); this.m.i32Const(bytes); this.m.i32Sub();          // → offset(i32)
        this.m.localSet(this.sT[0]);                                           // sT0 = offset
        this.m.localGet(this.sT[0]); this.m.i32Const(N); this.m.i32Store(2, 0); // [off] = len
        for (let i = 0; i < N; i++) {
            this.m.localGet(this.sT[0]);                                       // [off]
            this.emitTaggedExpr(e.elements[i]);                                // [off, val:i64]
            this.m.i64Store(3, 8 + i * 8);                                     // [off+8+i*8] = val
        }
        this.m.localGet(this.sT[0]); this.m.i64ExtendI32U();
        this.m.i64ConstBits(0, 0x7ff80000); this.m.i64Or();                    // 句柄
        return;
    }
    if (ts.isElementAccessExpression(e)) {
        // a[i]：数组句柄(0x7FF8) → load [off + 8 + i*8]；i 须 number（f64→i32）。
        this.emitTaggedExpr(e.expression); this.m.localSet(this.scratch);   // scratch = 数组值
        this.emitTaggedExpr(e.argumentExpression);                          // [i_value:i64]
        this.m.f64ReinterpretI64(); this.m.i32TruncF64S();                  // → i32 index
        this.m.i32Const(8); this.m.i32Mul();
        this.m.localGet(this.scratch); this.m.i32WrapI64(); this.m.i32Add(); // [off + 8 + i*8]
        this.m.i64Load(3, 8);                                               // 元素自 off+8 起
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
    if (ts.isCallExpression(e)) {
        if (!ts.isIdentifier(e.expression)) throw new Error("[tagged] 调用目标必须是标识符");
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
Emitter.prototype.emitTaggedBinary = function (e) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.FirstAssignment) {
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
    };
    if (COMPOUND[op] !== undefined) {
        const idx = this._local(e.left.text);
        this.m.localGet(idx); this.emitTaggedExpr(e.right);
        this._emitBinOp(COMPOUND[op]);
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