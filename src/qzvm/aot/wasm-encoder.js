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
function vec(items) { const out = uleb(items.length); for (const i of items) for (const b of i) out.push(b); return out; }
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
    i64_gt_s: 0x55, i64_gt_u: 0x56, i64_le_s: 0x57, i64_le_u: 0x58, i64_ge_s: 0x59, i64_ge_u: 0x5a,
    i32_load: 0x28, i64_load: 0x29, f64_load: 0x2b, i32_load8_u: 0x2d,
    i32_store: 0x36, i64_store: 0x37, f64_store: 0x39, i32_store8: 0x3a, i64_store32: 0x3e,
    f64_eq: 0x61, f64_ne: 0x62, f64_lt: 0x63, f64_gt: 0x64, f64_le: 0x65, f64_ge: 0x66,
    i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c, i32_div_s: 0x6d, i32_div_u: 0x6e, i32_rem_s: 0x6f, i32_rem_u: 0x70,
    i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73, i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
    i64_add: 0x7c, i64_sub: 0x7d, i64_mul: 0x7e, i64_div_s: 0x7f, i64_div_u: 0x80, i64_rem_s: 0x81, i64_rem_u: 0x82,
    i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85, i64_shl: 0x86, i64_shr_s: 0x87, i64_shr_u: 0x88,
    f64_neg: 0x9a, f64_ceil: 0x9b, f64_floor: 0x9c, f64_trunc: 0x9d, f64_nearest: 0x9e, f64_sqrt: 0x9f, f64_abs: 0x99,
    f64_add: 0xa0, f64_sub: 0xa1, f64_mul: 0xa2, f64_div: 0xa3, f64_min: 0xa4, f64_max: 0xa5,
    i32_wrap_i64: 0xa7, i32_trunc_f64_s: 0xaa, i32_trunc_f64_u: 0xab,
    i64_extend_i32_s: 0xac, i64_extend_i32_u: 0xad, i64_trunc_f64_s: 0xb0,
    f64_convert_i32_s: 0xb7, f64_convert_i32_u: 0xb8, f64_convert_i64_s: 0xb9, f64_convert_i64_u: 0xba,
    i64_reinterpret_f64: 0xbd, f64_reinterpret_i64: 0xbf,
    memory_size: 0x3f, memory_grow: 0x40,
    unreachable: 0x00,
};

class Module {
    constructor(opts) { this.types = []; this.imports = []; this.funcs = []; this.memory = null; this.exports = []; this.codes = []; this.globals = null; this.data = []; this.startIdx = null; this.table = null; this.tableElems = []; this._typeIdx = {}; this._funcIdx = {}; this._importIdx = {}; this._cur = null;
        this.debug = !!(opts && opts.debug);   // 生成 name 段（函数名）→ wat/wasm 可读，DAP 友好
        this._fnNames = [];                    // funcidx(全局) → 名（导入在前，本地函数在后）
        this.debugLine = !!(opts && opts.debugLine); // 生成 DWARF 调试段（.debug_info/line/abbrev/str）
        this._codeName = {};                   // codeIdx → 函数名（本地函数）
        this._codeDecl = {};                   // codeIdx → 声明行号
        this.srcFile = (opts && opts.srcFile) || ""; // 源文件路径（DWARF CU/行表用）
        // collectImports：**采集模式**——只记录被引用到的 import 名（call/importFn），
        // 不真正登记、不产字节。用于「先求出实际用到的契约面，再按需注册」：import
        // 索引必须在 declareFunc 之前定妥（funcidx = codeIdx + imports.length），
        // 故无法边发射边补登记；两趟发射（一趟采集、一趟真发）是唯一干净解。
        this.collect = !!(opts && opts.collectImports);
        this.collected = new Set();
    }
    // type: {name, params:[valtype], results:[valtype]}（results 空 = void）
    funcType(params, results) {
        const key = JSON.stringify([params, results]);
        if (this._typeIdx[key] !== undefined) return this._typeIdx[key];
        const idx = this.types.length;
        this.types.push({ params, results });
        this._typeIdx[key] = idx;
        return idx;
    }
    _importFuncCount() { let n = 0; for (const imp of this.imports) if (imp.type !== undefined) n++; return n; }
    importMemory(module, field, min, max) {     // memory import（WAMR AOT 要求内存来自宿主）
        const idx = this.imports.length;
        this.imports.push({ module, field, memory: { min, max } });
        this._importIdx[module + "." + field] = idx;
        return idx;
    }
    importFn(module, field, params, results) {
        const key = module + "." + field;
        if (this.collect) { this.collected.add(key); return 0; }   // 采集模式：只记名
        if (this._importIdx[key] !== undefined) return this._importIdx[key];
        const t = this.funcType(params, results);
        const idx = this._importFuncCount();
        if (this.debug) this._fnNames[this._importFuncCount()] = field;   // funcidx = push 前已登记函数导入数
        this.imports.push({ module, field, type: t });
        this._importIdx[key] = idx;
        return idx;
    }
    declareFunc(name, params, results) {          // 两阶段：先登记签名（支持前向引用）
        // 幂等：同名重复登记只保留首份。否则第二次的 _codeIdx 覆盖第一次，第一个 codes 槽
        // 永远是 null → build() 误报「函数体未闭合」（collectClasses 逐文件调用的边界）。
        this._codeIdx = this._codeIdx || {};
        if (this._codeIdx[name] !== undefined) return this._funcIdx[name];
        const t = this.funcType(params, results);
        const codeIdx = this.funcs.length;                    // codes 数组索引（本地函数序号）
        const fidx = codeIdx + this._importFuncCount();        // call 指令用（函数区全局索引；memory import 不占 funcidx）
        this.funcs.push(t);
        this._funcIdx[name] = fidx;
        if (this.debug) this._fnNames[fidx] = name;
        this._codeIdx = this._codeIdx || {};
        this._codeIdx[name] = codeIdx;
        this.codes.push(null);
        (this._pending = this._pending || {})[codeIdx] = name;
        return fidx;
    }
    startBody(name, locals, names, declLine) {
        // 嵌套开体 = 上一个函数体漏了 endBody（发射期抛错/提前 return）→ loud，勿静默覆盖，
        // 否则错误表现为 build() 时「codes[i] 为 null」，丢失原始位置。
        if (this._cur) throw new Error(`[wasm-encoder] 嵌套 startBody: "${name}" 覆盖未闭合的 "${this._cur.name}"`);
        const idx = (this._codeIdx || {})[name];
        if (idx === undefined) throw new Error(`[wasm-encoder] startBody 未知函数 "${name}"（未 declareFunc）`);
        this._cur = { idx, name, locals: locals || [], names: names || null, body: [], marks: [], declLine: declLine || 1 };
    }
    endBody() { if (this._cur) { this._cur.body.push(OP.end); this.codes[this._cur.idx] = { name: this._cur.name, locals: this._cur.locals, names: this._cur.names, body: this._cur.body, marks: this._cur.marks, declLine: this._cur.declLine }; this._cur = null; } }
    // 语句级行标记：记录「当前函数体内指令字节偏移 → 源码行」。DWARF 行表用。
    markLine(srcLine) { if (this.debugLine && this._cur) this._cur.marks.push([this._cur.body.length, srcLine]); }
    addFunc(name, params, results, locals) {
        const t = this.funcType(params, results);
        const fidx = this.funcs.length + this._importFuncCount(); // funcs 索引 = 函数 import 数 + 本地函数序
        this.funcs.push(t);
        this._funcIdx[name] = fidx;
        this._codeIdx = this._codeIdx || {};
        this._codeIdx[name] = fidx - this._importFuncCount();
        this._cur = { name, locals: locals || [], body: [], marks: [], declLine: 1 };
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
    call(name) {
        const idx = this._importIdx[name] !== undefined ? this._importIdx[name] : this._funcIdx[name];
        if (idx === undefined) {
            /* 采集模式：遇到 qz.* 记为「契约面用到」，不产字节（本趟 module 丢弃）。
             * 非 qz.*（本地函数/helper）未定义 = 真错误，照抛。 */
            if (this.collect && typeof name === "string" && name.indexOf("qz.") === 0) { this.collected.add(name); return; }
            throw new Error("call 未定义: " + name);
        }
        this._emit(OP.call, ...uleb(idx));
    }
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
    i64TruncF64S() { this._emit(OP.i64_trunc_f64_s); }
    i64ReinterpretF64() { this._emit(OP.i64_reinterpret_f64); } f64ReinterpretI64() { this._emit(OP.f64_reinterpret_i64); }
    f64Add() { this._emit(OP.f64_add); } f64Sub() { this._emit(OP.f64_sub); } f64Mul() { this._emit(OP.f64_mul); } f64Div() { this._emit(OP.f64_div); }
    i32Eqz() { this._emit(OP.i32_eqz); }
    i32Eq() { this._emit(OP.i32_eq); } i32Ne() { this._emit(OP.i32_ne); } i32LtS() { this._emit(OP.i32_lt_s); } i32GtS() { this._emit(OP.i32_gt_s); } i32LeS() { this._emit(OP.i32_le_s); } i32GeS() { this._emit(OP.i32_ge_s); }
    i32LtU() { this._emit(OP.i32_lt_u); } i32GtU() { this._emit(OP.i32_gt_u); } i32LeU() { this._emit(OP.i32_le_u); } i32GeU() { this._emit(OP.i32_ge_u); }
    f64Eq() { this._emit(OP.f64_eq); } f64Lt() { this._emit(OP.f64_lt); } f64Gt() { this._emit(OP.f64_gt); }
    f64Le() { this._emit(OP.f64_le); } f64Ge() { this._emit(OP.f64_ge); } f64Ne() { this._emit(OP.f64_ne); }
    f64Neg() { this._emit(OP.f64_neg); } f64Max() { this._emit(OP.f64_max); } f64Min() { this._emit(OP.f64_min); }
    f64Trunc() { this._emit(OP.f64_trunc); } f64Floor() { this._emit(OP.f64_floor); }
    f64Ceil() { this._emit(OP.f64_ceil); } f64Nearest() { this._emit(OP.f64_nearest); }
    f64Sqrt() { this._emit(OP.f64_sqrt); } f64Abs() { this._emit(OP.f64_abs); }
    f64ConvertI32S() { this._emit(OP.f64_convert_i32_s); } f64ConvertI32U() { this._emit(OP.f64_convert_i32_u); }
    i32TruncF64S() { this._emit(OP.i32_trunc_f64_s); }
    i32Shl() { this._emit(OP.i32_shl); } i32ShrU() { this._emit(OP.i32_shr_u); } i32ShrS() { this._emit(OP.i32_shr_s); } i32Or() { this._emit(OP.i32_or); } i32And() { this._emit(OP.i32_and); }
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
    memorySize() { this._emit(OP.memory_size, 0x00); }   // 栈：当前页数(i32)
    memoryGrow() { this._emit(OP.memory_grow, 0x00); }   // 栈：增量页数(i32) → 旧页数(i32)，失败 = -1
    addMemory(pages, maxPages) { this.memory = pages; this.memoryMax = (maxPages === undefined ? null : maxPages); }
    addData(offset, bytes) { this.data.push({ offset, bytes: Uint8Array.from(bytes) }); }   // 数据段（字符串字面量 UTF-8）
    /* funcref 表：跨模块共享（import 名 __indirect_function_table），供 C 侧原语
     * 经 call_indirect 回调产物内的闭包体/类方法。函数指针在 C 里就是 i32 索引，
     * 故原语只需拿到表槽号即可分派。
     *   addTableImport(min)  → 表来自宿主（libqzvm 导出）
     *   addTableLocal(min)   → 本模块自建表
     *   addElem(slot, funcIdx) → 把函数装入表槽（elem 段） */
    addTableImport(min, name, module) { this.table = { imported: true, min, name: name || "__indirect_function_table", module: module || "qz" }; }
    addTableLocal(min) { this.table = { imported: false, min }; }
    /* 被动 elem 段：不参与实例化时的表初始化（此时表还没扩容），由启动函数
     * 在 table.grow 之后 table.init 装入。 */
    addElem(slot, funcIdx) { this.tableElems.push({ slot, funcIdx }); }
    addTableGrow(n) { this.tableGrow = n; }
    /* 生成启动函数完成表扩容 + 被动段装入。ply：产物侧起始槽（=宿主表容量）。
     *   table.grow(dst, ref.null func) → 抬高到 ply + n
     *   table.init(elem idx, dst, src, len) 逐段装入
     * 必须在所有 addElem 之后、build 之前调用。 */
    emitTableInit(growBy, baseSlot) {
        if (!this.tableElems.length) return;
        const fnName = "__qz_table_init";
        this.declareFunc(fnName, [], []);
        this.startBody(fnName, []);
        // table.grow：栈序 (ref, n) → 返回旧尺寸
        this._emit(0xd0, 0x70);                 // ref.null func
        this._emit(0x41, ...sleb(growBy));      // i32.const growBy
        this._emit(0xfc, ...uleb(15), ...uleb(0));   // table.grow table=0（0xFC 15）
        this._emit(OP.drop);
        const sorted = [...this.tableElems].sort((a, b) => a.slot - b.slot);
        sorted.forEach((e, i) => {
            this._emit(0x41, ...sleb(e.slot));  // dst
            this._emit(0x41, 0x00);             // src=0（每段只有 1 项）
            this._emit(0x41, 0x01);             // len=1
            this._emit(0xfc, ...uleb(12), ...uleb(i), ...uleb(0));   // table.init elem=i, table=0（0xFC 12）
        });
        this.endBody();
        this.setStart(fnName);
    }
    i32Store(align, offset) { this._emit(OP.i32_store, ...uleb(align), ...uleb(offset)); }
    i32Store8(align, offset) { this._emit(OP.i32_store8, ...uleb(align), ...uleb(offset)); }
    i32Load(align, offset) { this._emit(OP.i32_load, ...uleb(align), ...uleb(offset)); }
    i32Load8U(align, offset) { this._emit(OP.i32_load8_u, ...uleb(align), ...uleb(offset)); }
    i64Store(align, offset) { this._emit(OP.i64_store, ...uleb(align), ...uleb(offset)); }
    i64Store32(align, offset) { this._emit(OP.i64_store32, ...uleb(align), ...uleb(offset)); }
    i64Load(align, offset) { this._emit(OP.i64_load, ...uleb(align), ...uleb(offset)); }
    f64Load(align, offset) { this._emit(OP.f64_load, ...uleb(align), ...uleb(offset)); }
    f64Store(align, offset) { this._emit(OP.f64_store, ...uleb(align), ...uleb(offset)); }
    // export
    setStart(fnName) { this.startIdx = this._funcIdx[fnName]; }   // start 段：实例化时自动执行（模块级初始化）
    exportFn(name, fnName) { this.exports.push({ name, idx: this._funcIdx[fnName], kind: 0x00 }); }
    exportMemory(idx) { this.exports.push({ name: "memory", idx: idx !== undefined ? idx : this.memoryIdx(), kind: 0x02 }); }   // 导入 memory 时传 0
    exportGlobal(name, gidx) { this.exports.push({ name, idx: gidx, kind: 0x03 }); }   // mutable global 导出
    globalIdx() { return 0; }   // 本地 global 索引空间：当前单 global（bump）
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
        // import 段（含可能存在的 imported funcref 表）
        if (this.imports.length || (this.table && this.table.imported)) {
            const items = this.imports.map(imp => {
                const head = [...uleb(imp.module.length), ...[...Buffer.from(imp.module)],
                              ...uleb(imp.field.length), ...[...Buffer.from(imp.field)]];
                if (imp.memory) return [...head, 0x02, 0x00, ...uleb(imp.memory.min)];  // memory import: 非 shared、min-only（WAMR 拒 shared+max）
                return [...head, 0x00, ...uleb(imp.type)];   // func import, type idx
            });
            /* imported funcref 表必须排在 import 段内：0x01 = table，tabletype =
             * reftype(0x70 funcref) + limits(flag=0x01 有 max, min, max)。与 libqzvm
             * 导出的表同型（min=max=514），跨模块共享同一张表。 */
            if (this.table && this.table.imported) {
                const mn = this.table.min;
                const mod = Buffer.from(this.table.module || "qz");
                const fld = Buffer.from(this.table.name || "__indirect_function_table");
                /* limits flag=0x00（仅 min）：宿主表无 max（libqzvm --growable-table）。
                 * min 必须 ≤ 宿主现有表长（否则链接失败），故用宿主容量；
                 * 产物所需的额外槽在启动函数里 table.grow 扩容后 table.init 装入。 */
                items.push([...uleb(mod.length), ...mod, ...uleb(fld.length), ...fld,
                            0x01, 0x70, 0x00, ...uleb(mn)]);
            }
            const body = vec(items);
            out.push(2, ...uleb(body.length), ...body);
        }
        // function 段
        if (this.funcs.length) {
            const body = vec(this.funcs.map(t => uleb(t)));
            out.push(3, ...uleb(body.length), ...body);
        }
        // memory 段
        if (this.memory !== null) {
            // vec(memorytype)：count=1 + limits。有 max 时 flags=0x01(min,max)，否则 0x00(min)。
            // 非 shared（shared 需 import，WAMR 不接受本地定义）。
            const lim = (this.memoryMax === null || this.memoryMax === undefined)
                ? [0x00, ...uleb(this.memory)]
                : [0x01, ...uleb(this.memory), ...uleb(this.memoryMax)];
            const body = [0x01, ...lim];
            out.push(5, ...uleb(body.length), ...body);
        }
        // table 段（id 4）：仅本地表（import 表已在 import 段内）
        if (this.table && !this.table.imported) {
            const mn = this.table.min;
            const body = vec([[0x70, 0x00, ...uleb(mn)]]);   // funcref + limits(min only)
            out.push(4, ...uleb(body.length), ...body);
        }
        // global 段：mutable（bump i32 / __err i64）；init 按类型选 const opcode（0x41=i32 0x42=i64）
        if (this.globals && this.globals.length) {
            const body = vec(this.globals.map(g => [VAL[g.type], 0x01,
                ...(g.type === "i64" ? [0x42, ...sleb64(g.init || 0)] : [0x41, ...sleb(g.init || 0)]), OP.end]));
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
        // start 段（8）：模块级初始化函数，实例化时自动执行
        if (this.startIdx !== null && this.startIdx !== undefined) {
            const b = uleb(this.startIdx);
            out.push(8, ...uleb(b.length), ...b);
        }
        /* elem 段（id 9）：**被动**段（flags=1）。产物的表槽在宿主表容量之外，
         * 实例化时表还没扩容 → 不能在实例化期装入；改为启动函数里 grow 之后
         * table.init。段内按槽号升序排，启动函数用同一顺序 init。 */
        if (this.tableElems.length) {
            const sorted = [...this.tableElems].sort((a, b) => a.slot - b.slot);
            const items = sorted.map(e => [
                0x01,                            // flags=1：passive + elemkind，vec(funcidx)
                0x00,                            // elemkind: funcref
                ...uleb(1), ...uleb(e.funcIdx)
            ]);
            const body = vec(items);
            out.push(9, ...uleb(body.length), ...body);
        }
        let dwarfPayload = null;   // { entries:[{c, low, size}], payloadLen }
        if (this.codes.length) {
            const hole = this.codes.findIndex(c => !c);
            if (hole >= 0) throw new Error(`[wasm-encoder] 函数体未闭合（codes[${hole}] = ${(this._pending || {})[hole]}）：startBody 后漏了 endBody`);
            this._pending = null;
            const built = this.codes.map(c => {
                const localGroups = [];
                for (const l of c.locals) {
                    const last = localGroups[localGroups.length - 1];
                    if (last && last[1] === VAL[l]) last[0]++;
                    else localGroups.push([1, VAL[l]]);
                }
                const header = vec(localGroups.map(g => uleb(g[0]).concat(g[1])));
                const code = [...header, ...c.body];
                return { c, header, code };
            });
            const body = vec(built.map(e => uleb(e.code.length).concat(e.code)));
            // 不用 spread：内联后的单文件可达数千函数，body 元素数远超引擎实参上限（RangeError）。
            out.push(10);
            for (const b of uleb(body.length)) out.push(b);
            for (const b of body) out.push(b);
            if (this.debugLine) {
                // payload 起点 = 本段长度 LEB 之后的 count 字节；低址约定 = code 段 payload 相对偏移
                const countLeb = uleb(built.length).length;
                let rel = countLeb;   // count 字节之后
                const entries = [];
                for (const e of built) {
                    rel += uleb(e.code.length).length;      // size LEB
                    entries.push({ e, low: rel, size: e.code.length, headerLen: e.header.length });
                    rel += e.code.length;
                }
                dwarfPayload = { entries, payloadLen: rel };
            }
        }
        // data 段（字符串字面量 UTF-8；active，i32.const offset + 字节）—— wasm 段序要求排在 code(10) 之后
        if (this.data.length) {
            const body = vec(this.data.map(d => [...uleb(0x00), OP.i32_const, ...sleb(d.offset), OP.end, ...uleb(d.bytes.length), ...d.bytes]));
            out.push(11, ...uleb(body.length), ...body);
        }
        // name 段（custom section，id 0）：子段 1=函数名、子段 2=局部名。
        // 可选（debug）：wat/wasm 反汇编显示 $名 / $局部名，DAP 友好。不影响执行。
        if (this.debug) {
            const subs = [];
            // 子段 1：函数名。funcidx → 名（含导入）。
            const fnNames = [];
            for (let i = 0; i < this._fnNames.length; i++) {
                const nm = this._fnNames[i];
                if (nm === undefined) continue;
                fnNames.push([...uleb(i), ...uleb(Buffer.byteLength(nm)), ...[...Buffer.from(nm)]]);
            }
            if (fnNames.length) subs.push({ id: 1, content: vec(fnNames) });
            // 子段 2：局部名。name = indrectnamemap: vec(funcidx → namemap)。
            // namemap: vec(localidx → name)。local 0..n-1 = 参数 + 局部（与 wasm local 序号一致）。
            const localMaps = [];
            for (let ci = 0; ci < this.codes.length; ci++) {
                const c = this.codes[ci];
                if (!c || !c.names) continue;
                const fidx = ci + this._importFuncCount();   // codes 索引 → funcidx
                const entries = [];
                for (let li = 0; li < c.names.length; li++) {
                    const nm = c.names[li];
                    if (nm === undefined) continue;
                    entries.push([...uleb(li), ...uleb(Buffer.byteLength(nm)), ...[...Buffer.from(nm)]]);
                }
                if (entries.length) localMaps.push([...uleb(fidx), ...vec(entries)]);
            }
            if (localMaps.length) subs.push({ id: 2, content: vec(localMaps) });
            if (subs.length) {
                const body = [];
                for (const { id, content } of subs) body.push(id, ...uleb(content.length), ...content);
                const sec = [...uleb(Buffer.byteLength("name")), ...[...Buffer.from("name")], ...body];
                out.push(0, ...uleb(sec.length), ...sec);   // custom section (id 0)
            }
        }
        // DWARF 调试段（custom，id 0）：.debug_abbrev/.debug_info/.debug_line/.debug_str。
        // 地址约定 = code 段 payload 相对偏移（见 wasm-dwarf.js 注释）。
        if (this.debugLine && dwarfPayload) {
            const { buildDebugSections } = require("./wasm-dwarf.js");
            const funcs = [], marks = [];
            let cuLow = Infinity, cuEnd = 0;
            for (const ent of dwarfPayload.entries) {
                const c = ent.e.c;
                funcs.push({ name: c.name || "?", low: ent.low, size: ent.size, line: c.declLine || 1 });
                cuLow = Math.min(cuLow, ent.low);
                cuEnd = Math.max(cuEnd, ent.low + ent.size);
                for (const m of (c.marks || [])) marks.push({ addr: ent.low + ent.headerLen + m[0], line: m[1] });
            }
            marks.sort((a, b) => a.addr - b.addr);
            const abs = this.srcFile && require("path").resolve(this.srcFile);
            const dir = abs ? require("path").dirname(abs) : ".";
            const base = abs ? require("path").basename(abs) : (this.srcFile || "module.ts");
            const ds = buildDebugSections({
                producer: "qzvm TS->wasm", file: base, dir, funcs, marks,
                cuLow: cuLow === Infinity ? 0 : cuLow, cuEnd: cuEnd || 1,
            });
            for (const [nm, bytes] of [["abbrev", ds.abbrev], ["info", ds.info], ["line", ds.line], ["str", ds.str]]) {
                const sec = [...uleb(Buffer.byteLength(".debug_" + nm)), ...[...Buffer.from(".debug_" + nm)], ...bytes];
                out.push(0, ...uleb(sec.length), ...sec);
            }
        }
        return Buffer.from(out.flat());
    }
}

module.exports = { Module, VAL, OP };
