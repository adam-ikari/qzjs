#!/usr/bin/env node
/* wasm-encoder.js — 最小 wasm 二进制生成器（自研 TS→wasm 的基础层）。
 * 支持段: type / import / function / memory / export / code。
 * 支持指令最小集（数值 i32/i64/f64 + 控制流）——足够生成完整 TS 的动态类型 wasm
 * （tagged 值 i64 f64 NaN-box 或 i32 位模型，均经 qz.* import）。
 *
 * 用法: const { Module } = require('./wasm-encoder.js');
 *       const m = new Module();
 *       m.funcType([...params], result);
 *       m.importFn("qz", "object_new", [...], result);
 *       m.startFunc(name, [...locals]);  // 开始写函数体
 *       m.i32Const(1); m.i32Add(); m.end();   // 指令
 *       m.call(name); m.exportFn(name);
 *       fs.writeFileSync("out.wasm", m.build());
 */

"use strict";

// ---------- LEB128 ----------
function uleb(n) { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; }
function sleb(n) { const out = []; let more = true; while (more) { let b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) more = false; else b |= 0x80; out.push(b); } return out; }
function vec(items) { const out = uleb(items.length); for (const i of items) out.push(...i); return out; }
// 64 位 LEB（i64 常量、大偏移）：BigInt 版，`>>`/`|` 均为 32 位不可用
function uleb64(n) { n = BigInt(n) & 0xffffffffffffffffn; const out = []; do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b); } while (n); return out; }
function sleb64(n) {
    n = BigInt.asIntN(64, BigInt(n));
    const out = []; let more = true;
    while (more) {
        let b = Number(n & 0x7fn);
        n >>= 7n;
        if ((n === 0n && !(b & 0x40)) || (n === -1n && (b & 0x40))) more = false; else b |= 0x80;
        out.push(b);
    }
    return out;
}

const VAL = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, func: 0x60, void: 0x40 };
// 指令集（值来自 wasm core spec；i32/f64 为解释器快路径，i64 用于 tagged NaN-box）
const OP = {
    end: 0x0b, else: 0x05, block: 0x02, loop: 0x03, if: 0x04, br: 0x0c, br_if: 0x0d,
    br_table: 0x0e, return: 0x0f, call: 0x10, call_indirect: 0x11, drop: 0x1a, select: 0x1b,
    local_get: 0x20, local_set: 0x21, local_tee: 0x22, global_get: 0x23, global_set: 0x24,
    i32_load: 0x28, i64_load: 0x29, f64_load: 0x2b,
    i32_store: 0x36, i64_store: 0x37, f64_store: 0x39,
    i32_const: 0x41, i64_const: 0x42, f64_const: 0x44,
    i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_lt_s: 0x48, i32_lt_u: 0x49,
    i32_gt_s: 0x4a, i32_gt_u: 0x4b, i32_le_s: 0x4c, i32_le_u: 0x4d, i32_ge_s: 0x4e, i32_ge_u: 0x4f,
    i64_eqz: 0x50, i64_eq: 0x51, i64_ne: 0x52, i64_lt_s: 0x53, i64_lt_u: 0x54,
    i32_load: 0x28, i64_load: 0x29, f64_load: 0x2b, i32_load8_u: 0x2d,
    i32_store: 0x36, i64_store: 0x37, f64_store: 0x39, i32_store8: 0x3a, i64_store32: 0x3e,
    f64_eq: 0x61, f64_ne: 0x62, f64_lt: 0x63, f64_gt: 0x64, f64_le: 0x65, f64_ge: 0x66,
    i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c, i32_div_s: 0x6d, i32_div_u: 0x6e, i32_rem_s: 0x6f, i32_rem_u: 0x70,
    i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73, i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
    i64_add: 0x7c, i64_sub: 0x7d, i64_mul: 0x7e, i64_div_s: 0x7f, i64_div_u: 0x80, i64_rem_s: 0x81, i64_rem_u: 0x82,
    i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85, i64_shl: 0x86, i64_shr_s: 0x87, i64_shr_u: 0x88,
    f64_neg: 0x9a, f64_floor: 0x9c, f64_trunc: 0x9d, f64_abs: 0x99,
    f64_add: 0xa0, f64_sub: 0xa1, f64_mul: 0xa2, f64_div: 0xa3, f64_min: 0xa4, f64_max: 0xa5,
    i32_wrap_i64: 0xa7, i32_trunc_f64_s: 0xaa, i32_trunc_f64_u: 0xab,
    i64_extend_i32_s: 0xac, i64_extend_i32_u: 0xad,
    f64_convert_i32_s: 0xb7, f64_convert_i32_u: 0xb8, f64_convert_i64_s: 0xb9, f64_convert_i64_u: 0xba,
    i64_reinterpret_f64: 0xbd, f64_reinterpret_i64: 0xbf,
    unreachable: 0x00,
};

class Module {
    constructor() { this.types = []; this.imports = []; this.funcs = []; this.memory = null; this.exports = []; this.codes = []; this.globals = null; this.data = []; this._typeIdx = {}; this._funcIdx = {}; this._importIdx = {}; this._cur = null; }
    // type: {name, params:[valtype], results:[valtype]}（results 空 = void）
    funcType(params, results) {
        const key = JSON.stringify([params, results]);
        if (this._typeIdx[key] !== undefined) return this._typeIdx[key];
        const idx = this.types.length;
        this.types.push({ params, results });
        this._typeIdx[key] = idx;
        return idx;
    }
    importMemory(module, field, min, max) {     // memory import（WAMR AOT 要求内存来自宿主）
        const idx = this.imports.length;
        this.imports.push({ module, field, memory: { min, max } });
        this._importIdx[module + "." + field] = idx;
        return idx;
    }
    importFn(module, field, params, results) {
        const key = module + "." + field;
        if (this._importIdx[key] !== undefined) return this._importIdx[key];
        const t = this.funcType(params, results);
        const idx = this.imports.length;
        this.imports.push({ module, field, type: t });
        this._importIdx[key] = idx;
        return idx;
    }
    declareFunc(name, params, results) {          // 两阶段：先登记签名（支持前向引用）
        const t = this.funcType(params, results);
        const codeIdx = this.funcs.length;                    // codes 数组索引（本地函数序号）
        const fidx = codeIdx + this.imports.length;           // call 指令用（函数区全局索引）
        this.funcs.push(t);
        this._funcIdx[name] = fidx;
        this._codeIdx = this._codeIdx || {};
        this._codeIdx[name] = codeIdx;
        this.codes.push(null);
        return fidx;
    }
    startBody(name, locals) { this._cur = { idx: (this._codeIdx || {})[name], locals: locals || [], body: [] }; }
    endBody() { if (this._cur) { this._cur.body.push(OP.end); this.codes[this._cur.idx] = { locals: this._cur.locals, body: this._cur.body }; this._cur = null; } }
    addFunc(name, params, results, locals) {
        const t = this.funcType(params, results);
        const fidx = this.funcs.length + this.imports.length; // funcs 索引 = imports + 本地函数序
        this.funcs.push(t);
        this._funcIdx[name] = fidx;
        this._codeIdx = this._codeIdx || {};
        this._codeIdx[name] = fidx - this.imports.length;
        this._cur = { name, locals: locals || [], body: [] };
        return fidx;
    }
    start(name) { this.addFunc(name, [], []); }
    // --- 指令 ---
    _emit(...bytes) { this._cur.body.push(...bytes); }
    end() { this._emit(OP.end); }        // 结束 block/loop/if（只 push end）
    finish() { this._emit(OP.end); if (this._cur) { this.codes.push({ locals: this._cur.locals, body: this._cur.body }); this._cur = null; } }
    i32Const(v) { this._emit(OP.i32_const, ...sleb(v | 0)); }
    i64Const(v) { this._emit(OP.i64_const, ...sleb64(v)); }
    i64ConstBits(lo, hi) { this._emit(OP.i64_const, ...sleb64((BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0))); }
    f64Const(v) { const b = Buffer.alloc(8); b.writeDoubleLE(v); this._emit(OP.f64_const, ...b); }
    call(name) { const idx = this._importIdx[name] !== undefined ? this._importIdx[name] : this._funcIdx[name]; if (idx === undefined) throw new Error("call 未定义: " + name); this._emit(OP.call, ...uleb(idx)); }
    addGlobal(type, init) { (this.globals = this.globals || []).push({ type, init: init || 0 }); return this.globals.length - 1; }
    globalGet(i) { this._emit(OP.global_get, ...uleb(i)); }
    globalSet(i) { this._emit(OP.global_set, ...uleb(i)); }
    globalTee(i) { /* wasm 无 global.tee：用 get+set+get 等价序列 */ this.globalGet(i); this.globalSet(i); this.globalGet(i); }
    localGet(i) { this._emit(OP.local_get, ...uleb(i)); }
    localSet(i) { this._emit(OP.local_set, ...uleb(i)); }
    localTee(i) { this._emit(OP.local_tee, ...uleb(i)); }
    // 算术
    i32Add() { this._emit(OP.i32_add); } i32Sub() { this._emit(OP.i32_sub); } i32Mul() { this._emit(OP.i32_mul); } i32DivS() { this._emit(OP.i32_div_s); } i32RemS() { this._emit(OP.i32_rem_s); }
    i32DivU() { this._emit(OP.i32_div_u); } i32RemU() { this._emit(OP.i32_rem_u); }
    truncI64F64S() { this._emit(0xb0); }   // i64.trunc_f64_s
    i64Add() { this._emit(OP.i64_add); } i64Sub() { this._emit(OP.i64_sub); } i64Mul() { this._emit(OP.i64_mul); }
    i64DivS() { this._emit(OP.i64_div_s); } i64RemS() { this._emit(OP.i64_rem_s); }
    i64DivU() { this._emit(OP.i64_div_u); } i64RemU() { this._emit(OP.i64_rem_u); }
    i64And() { this._emit(OP.i64_and); } i64Or() { this._emit(OP.i64_or); } i64Xor() { this._emit(OP.i64_xor); }
    i64Shl() { this._emit(OP.i64_shl); } i64ShrU() { this._emit(OP.i64_shr_u); } i64ShrS() { this._emit(OP.i64_shr_s); }
    i64Eqz() { this._emit(OP.i64_eqz); }
    i64Eq() { this._emit(OP.i64_eq); } i64Ne() { this._emit(OP.i64_ne); }
    i64LtS() { this._emit(OP.i64_lt_s); } i64GtS() { this._emit(OP.i64_gt_s); } i64LeS() { this._emit(OP.i64_le_s); } i64GeS() { this._emit(OP.i64_ge_s); }
    i64LtU() { this._emit(OP.i64_lt_u); } i64GtU() { this._emit(OP.i64_gt_u); } i64LeU() { this._emit(OP.i64_le_u); } i64GeU() { this._emit(OP.i64_ge_u); }
    i32WrapI64() { this._emit(OP.i32_wrap_i64); }
    i64ExtendI32S() { this._emit(OP.i64_extend_i32_s); } i64ExtendI32U() { this._emit(OP.i64_extend_i32_u); }
    f64ConvertI64S() { this._emit(OP.f64_convert_i64_s); }
    i64ReinterpretF64() { this._emit(OP.i64_reinterpret_f64); } f64ReinterpretI64() { this._emit(OP.f64_reinterpret_i64); }
    f64Add() { this._emit(OP.f64_add); } f64Sub() { this._emit(OP.f64_sub); } f64Mul() { this._emit(OP.f64_mul); } f64Div() { this._emit(OP.f64_div); }
    i32Eqz() { this._emit(OP.i32_eqz); }
    i32Eq() { this._emit(OP.i32_eq); } i32Ne() { this._emit(OP.i32_ne); } i32LtS() { this._emit(OP.i32_lt_s); } i32GtS() { this._emit(OP.i32_gt_s); } i32LeS() { this._emit(OP.i32_le_s); } i32GeS() { this._emit(OP.i32_ge_s); }
    f64Eq() { this._emit(OP.f64_eq); } f64Lt() { this._emit(OP.f64_lt); } f64Gt() { this._emit(OP.f64_gt); }
    f64Le() { this._emit(OP.f64_le); } f64Ge() { this._emit(OP.f64_ge); } f64Ne() { this._emit(OP.f64_ne); }
    f64Neg() { this._emit(OP.f64_neg); } f64Max() { this._emit(OP.f64_max); } f64Trunc() { this._emit(OP.f64_trunc); } f64Floor() { this._emit(OP.f64_floor); }
    f64ConvertI32S() { this._emit(OP.f64_convert_i32_s); }
    i32TruncF64S() { this._emit(OP.i32_trunc_f64_s); }
    i32Shl() { this._emit(OP.i32_shl); } i32ShrU() { this._emit(OP.i32_shr_u); } i32Or() { this._emit(OP.i32_or); } i32And() { this._emit(OP.i32_and); }
    i32And() { this._emit(OP.i32_and); } i32Or() { this._emit(OP.i32_or); } i32Xor() { this._emit(OP.i32_xor); }
    // 控制流（label 用索引引用，wasm 相对深度）
    block(t) { this._emit(OP.block, t ? VAL[t] : VAL.void); }
    loop(t) { this._emit(OP.loop, t ? VAL[t] : VAL.void); }
    ifBlock(t) { this._emit(OP.if, t ? VAL[t] : VAL.void); }
    else_() { this._emit(OP.else); }
    br(depth) { this._emit(OP.br, ...uleb(depth)); }
    brIf(depth) { this._emit(OP.br_if, ...uleb(depth)); }
    return_() { this._emit(OP.return); }
    drop() { this._emit(OP.drop); }
    select() { this._emit(OP.select); }
    unreachable() { this._emit(OP.unreachable); }
    // 内存（字符串/数组共享内存用）
    addMemory(pages) { this.memory = pages; }
    addData(offset, bytes) { this.data.push({ offset, bytes: Uint8Array.from(bytes) }); }   // 数据段（字符串字面量 UTF-8）
    i32Store(align, offset) { this._emit(OP.i32_store, ...uleb(align), ...uleb(offset)); }
    i32Store8(align, offset) { this._emit(OP.i32_store8, ...uleb(align), ...uleb(offset)); }
    i32Load(align, offset) { this._emit(OP.i32_load, ...uleb(align), ...uleb(offset)); }
    i32Load8U(align, offset) { this._emit(OP.i32_load8_u, ...uleb(align), ...uleb(offset)); }
    i64Store(align, offset) { this._emit(OP.i64_store, ...uleb(align), ...uleb(offset)); }
    i64Store32(align, offset) { this._emit(OP.i64_store32, ...uleb(align), ...uleb(offset)); }
    i64Load(align, offset) { this._emit(OP.i64_load, ...uleb(align), ...uleb(offset)); }
    // export
    exportFn(name, fnName) { this.exports.push({ name, idx: this._funcIdx[fnName], kind: 0x00 }); }
    exportMemory() { this.exports.push({ name: "memory", idx: this.memoryIdx(), kind: 0x02 }); }
    memoryIdx() {   // memory 索引空间独立于 func：无 memory import 时本地 memory 索引 = 0
        let n = 0;
        for (const imp of this.imports) if (imp.memory) n++;
        return n;
    }

    // ---------- 段编码 ----------
    build() {
        const out = [];
        // magic + version
        out.push(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);
        // type 段
        if (this.types.length) {
            const body = vec(this.types.map(t => [
                0x60, ...uleb(t.params.length), ...t.params.map(p => [VAL[p]]),
                ...uleb(t.results.length), ...t.results.map(p => [VAL[p]])
            ]));
            out.push(1, ...uleb(body.length), ...body);
        }
        // import 段
        if (this.imports.length) {
            const body = vec(this.imports.map(imp => {
                const head = [...uleb(imp.module.length), ...[...Buffer.from(imp.module)],
                              ...uleb(imp.field.length), ...[...Buffer.from(imp.field)]];
                if (imp.memory) return [...head, 0x02, 0x03, ...uleb(imp.memory.min), ...uleb(imp.memory.max)];  // memory: shared + has max（WAMR AOT 要求 shared）
                return [...head, 0x00, ...uleb(imp.type)];   // func import, type idx
            }));
            out.push(2, ...uleb(body.length), ...body);
        }
        // function 段
        if (this.funcs.length) {
            const body = vec(this.funcs.map(t => uleb(t)));
            out.push(3, ...uleb(body.length), ...body);
        }
        // memory 段
        if (this.memory !== null) {
            // vec(memorytype)：count=1 + limits{flags=0x01(has max), min, max}
            // 非 shared（shared 需 import，WAMR 不接受本地定义）
            const body = [0x01, 0x00, ...uleb(this.memory)];   // count=1 + limits{flags=0x00(min only), min} —— WAMR classic AOT 不支持 max
            out.push(5, ...uleb(body.length), ...body);
        }
        // global 段：mutable i32（wasm 内 bump 分配器）
        if (this.globals && this.globals.length) {
            const body = vec(this.globals.map(g => [VAL[g.type], 0x01, 0x41, ...sleb(g.init || 0), OP.end]));
            out.push(6, ...uleb(body.length), ...body);
        }
        // export 段
        if (this.exports.length) {
            const body = vec(this.exports.map(e => [
                ...uleb(e.name.length), ...[...Buffer.from(e.name)],
                e.kind === undefined ? 0x00 : e.kind, ...uleb(e.idx)   // 0x00=func 0x02=memory
            ]));
            out.push(7, ...uleb(body.length), ...body);
        }
        if (this.codes.length) {
            const body = vec(this.codes.map(c => {
                const localGroups = [];
                for (const l of c.locals) {
                    const last = localGroups[localGroups.length - 1];
                    if (last && last[1] === VAL[l]) last[0]++;
                    else localGroups.push([1, VAL[l]]);
                }
                const header = vec(localGroups.map(g => uleb(g[0]).concat(g[1])));
                const code = [...header, ...c.body];
                return uleb(code.length).concat(code);
            }));
            out.push(10, ...uleb(body.length), ...body);
        }
        // data 段（字符串字面量 UTF-8；active，i32.const offset + 字节）—— wasm 段序要求排在 code(10) 之后
        if (this.data.length) {
            const body = vec(this.data.map(d => [...uleb(0x00), OP.i32_const, ...sleb(d.offset), OP.end, ...uleb(d.bytes.length), ...d.bytes]));
            out.push(11, ...uleb(body.length), ...body);
        }
        return Buffer.from(out.flat());
    }
}

module.exports = { Module, VAL, OP };
