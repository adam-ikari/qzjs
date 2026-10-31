#!/usr/bin/env node
/* wasm-dwarf.js — 为自研 wasm 生成 DWARF 调试段（.debug_abbrev / .debug_info /
 * .debug_line / .debug_str），供打了 lldb_wasm.patch 的定制 lldb 做源码级调试。
 *
 * 地址约定（与 clang wasm 后端一致，已实证）：DWARF 地址 = **code 段 payload
 * 起始的相对偏移**，而非模块文件绝对偏移。WAMR debug-engine 报的 PC 是文件绝对
 * 偏移，lldb 侧用 code 段文件偏移重定位到本约定。见 brain: debugging-layering。
 *
 * DWARF 版本 4，addr_size = 4（wasm32 恒定，与宿主字长无关）。
 */
"use strict";

// ---------- LEB128 / 小端 ----------
function uleb(n) { const o = []; n >>>= 0; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; }
function sleb(n) {
    const o = []; let more = true;
    while (more) { let b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) more = false; else b |= 0x80; o.push(b); }
    return o;
}
function u16(n) { return [n & 0xff, (n >>> 8) & 0xff]; }
function u32(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }

// ---------- DWARF 常量 ----------
const FORM = { addr: 0x01, data2: 0x05, data4: 0x06, data1: 0x0b, strp: 0x0e, sec_offset: 0x17, flag_present: 0x19 };
const AT = { name: 0x03, stmt_list: 0x10, low_pc: 0x11, high_pc: 0x12, language: 0x13, comp_dir: 0x1b, producer: 0x25, decl_file: 0x3a, decl_line: 0x3b, external: 0x3f };
const TAG = { compile_unit: 0x11, subprogram: 0x2e };
const DW_LANG_C99 = 0x0c;
// line 标准操作码
const LNS = { copy: 1, advance_pc: 2, advance_line: 3 };
const LNE = { end_sequence: 1, set_address: 2 };

// 字符串表：去重，返回 strp 偏移
class StrTab {
    constructor() { this.map = new Map(); this.buf = []; this.pending = []; }
    // 两遍：先登记取偏移，再 write() 落字节
    add(s) { if (!this.map.has(s)) this.map.set(s, 0); return s; }
    write() {
        this.buf = [];
        for (const s of this.map.keys()) { this.map.set(s, this.buf.length); this.buf.push(...Buffer.from(s, "utf8"), 0); }
        return this.buf;
    }
    off(s) { return this.map.get(s); }
}

// ---------- .debug_abbrev ----------
function buildAbbrev() {
    const out = [];
    // abbrev 1: compile_unit（有子）
    out.push(1, TAG.compile_unit, 1);
    const cu = [[AT.producer, FORM.strp], [AT.language, FORM.data2], [AT.name, FORM.strp], [AT.stmt_list, FORM.sec_offset], [AT.comp_dir, FORM.strp], [AT.low_pc, FORM.addr], [AT.high_pc, FORM.data4]];
    for (const [a, f] of cu) out.push(...uleb(a), ...uleb(f));
    out.push(0, 0);
    // abbrev 2: subprogram（无子）
    out.push(2, TAG.subprogram, 0);
    const sp = [[AT.low_pc, FORM.addr], [AT.high_pc, FORM.data4], [AT.name, FORM.strp], [AT.decl_file, FORM.data1], [AT.decl_line, FORM.data2], [AT.external, FORM.flag_present]];
    for (const [a, f] of sp) out.push(...uleb(a), ...uleb(f));
    out.push(0, 0);
    out.push(0);   // abbrev 表结束
    return out;
}

// ---------- .debug_line ----------
// marks: [{addr, line}] 按 addr 非降序；endAddr = CU 结束地址（end_sequence 行）
function buildLine(fileName, dirIdx, marks, endAddr) {
    const header = [];
    header.push(1);      // minimum_instruction_length
    header.push(1);      // maximum_operations_per_instruction
    header.push(1);      // default_is_stmt
    header.push(0xfb);   // line_base = -5（有符号字节）
    header.push(14);     // line_range
    header.push(13);     // opcode_base
    // 标准操作码 1..12 的操作数个数
    header.push(0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1);   // set_isa(12) 有 1 个操作数
    header.push(0);      // include_directories：null 终止（空）
    const fnb = [...Buffer.from(fileName, "utf8"), 0];
    header.push(...fnb, ...uleb(dirIdx), 0, 0, 0);   // file_names：名\0 + dir/mtime/size + 终止 0

    // 程序
    const prog = [];
    let curLine = 1;
    for (const m of marks) {
        prog.push(0x00, ...uleb(1 + 4), LNE.set_address, ...u32(m.addr >>> 0));
        const d = m.line - curLine;
        if (d !== 0) prog.push(LNS.advance_line, ...sleb(d));
        curLine = m.line;
        prog.push(LNS.copy);
    }
    prog.push(0x00, ...uleb(1), LNE.end_sequence);

    const body = [...header, ...prog];
    const unitLen = 2 + 4 + body.length;   // version + header_length 字段 + 内容
    const out = [...u32(unitLen), ...u16(4), ...u32(header.length), ...body];
    return out;
}

// ---------- .debug_info ----------
// funcs: [{name, low, size, line}]；CU: {producer,name,dir,low,size}；high_pc(data4)=size
function buildInfo(cu, funcs, str, lineSectionOffset) {
    const dus = [];
    // CU DIE (abbrev 1)
    dus.push(1);
    dus.push(...u32(str.off(cu.producer)));
    dus.push(...u16(DW_LANG_C99));
    dus.push(...u32(str.off(cu.name)));
    dus.push(...u32(lineSectionOffset));
    dus.push(...u32(str.off(cu.dir)));
    dus.push(...u32(cu.low >>> 0));
    dus.push(...u32(cu.size >>> 0));
    // subprogram DIEs
    for (const f of funcs) {
        dus.push(2);
        dus.push(...u32(f.low >>> 0));
        dus.push(...u32(f.size >>> 0));
        dus.push(...u32(str.off(f.name)));
        dus.push(1);                 // decl_file
        dus.push(...u16(f.line));    // decl_line
        // external: flag_present（无字节）
    }
    dus.push(0);   // children 结束
    const unitLen = 2 + 4 + 1 + dus.length;   // version + abbrev_offset + addr_size + DIE 流
    return [...u32(unitLen), ...u16(4), ...u32(0), 4, ...dus];
}

// ---------- 汇总 ----------
// meta: { file, dir, producer, funcs: [{name, low, size, line}], marks: [{addr, line}], cuLow, cuEnd }
function buildDebugSections(meta) {
    const str = new StrTab();
    str.add(meta.producer);
    str.add(meta.file);
    str.add(meta.dir);
    for (const f of meta.funcs) str.add(f.name);
    str.write();

    const lname = meta.file;   // 行表文件名与 CU name 一致
    const line = buildLine(lname, 0, meta.marks, meta.cuEnd !== undefined ? meta.cuEnd : (meta.funcs.reduce((m, f) => Math.max(m, f.low + f.size), 0)));
    const info = buildInfo({ producer: meta.producer, name: meta.file, dir: meta.dir, low: meta.cuLow, size: meta.cuEnd - meta.cuLow }, meta.funcs, str, 0);
    const abbrev = buildAbbrev();
    return { abbrev, info, line, str: str.buf };
}

module.exports = { buildDebugSections };
