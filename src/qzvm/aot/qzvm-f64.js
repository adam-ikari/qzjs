#!/usr/bin/env node
/* qzvm-f64.js — qz.* 运行时（f64 NaN-box 变体，64 位宿主）。
 *
 * 值模型（64 位 i64）：
 *   - 数值：直接是 f64 的 IEEE-754 位型（i64.reinterpret_f64），对齐 TS number 53 位精度。
 *   - 句柄：高 16 位 = 0x7FF9 的 NaN 位型（真实 f64 算术不会产出，canonical NaN 高 16 位是 0x7FF8），
 *           低 32 位存表索引。判定「是句柄」= `b >> 48 == 0x7FF9`。
 * 跨界（wasm import ↔ JS）用 BigInt 传 i64。
 *
 * 与 qzvm.js（i32 tagged，31 位）并列：
 *   - 64 位宿主（默认）→ 本文件 f64 NaN-box，精确 number 语义。
 *   - 32 位宿主 → qzvm.js i32 tagged（PORTABILITY_32BIT.md 裁决，单寄存器/4 字节字段最优）。
 *
 * 用法: const { makeQzvmF64 } = require('./qzvm-f64.js');
 *       const qz = makeQzvmF64(["k0","k1",...]);   // strings 由 emitter 输出
 *       new WebAssembly.Instance(module, { qz });
 */
"use strict";

const TAG = 0x7ff9_0000_0000_0000n;      // 句柄标记（高 16 位 0x7FF9）
const TAG_HI = 0x7ff9n;                   // 高 16 位比较值
const MASK32 = 0xffff_ffffn;
const buf = Buffer.alloc(8);

function makeQzvmF64(strings) {
  const handles = [undefined];            // index 0 保留（handle 0 无效）

  const numToBits = (n) => { buf.writeDoubleLE(n); return buf.readBigInt64LE(); };
  const bitsToNum = (b) => { buf.writeBigInt64LE(BigInt.asIntN(64, b)); return buf.readDoubleLE(); };
  const isH = (b) => (BigInt(b) >> 48n) === TAG_HI;
  const idxOf = (b) => Number(BigInt(b) & MASK32);
  const toJS = (b) => (isH(b) ? handles[idxOf(b)] : bitsToNum(b));
  const tagHandle = (x) => TAG | BigInt(handles.push(x) - 1);
  const box = (n) => numToBits(n);
  const bool = (b) => numToBits(b ? 1 : 0);

  let bump = 0, mem = null;
  const bindMem = (m) => { mem = m; };
  return {
    // POJO 分配：返回 wasm 内存偏移（裸 i32），字段由 wasm i64.store 写入（零跨界）
    alloc: (nbytes) => { const off = bump; bump += nbytes; return off; },
    bindMem,
    object_new: () => tagHandle({}),
    object_set: (o, k, v) => { handles[idxOf(o)][strings[k]] = toJS(v); },
    object_get: (o, k) => tagHandle(handles[idxOf(o)][strings[k]]),
    string_new: (id) => tagHandle(strings[id]),
    string_concat: (a, b) => tagHandle(String(toJS(a)) + String(toJS(b))),
    add:  (a, b) => box(toJS(a) + toJS(b)),
    sub:  (a, b) => box(toJS(a) - toJS(b)),
    mul:  (a, b) => box(toJS(a) * toJS(b)),
    div:  (a, b) => box(toJS(a) / toJS(b)),
    rem:  (a, b) => box(toJS(a) % toJS(b)),
    lt:   (a, b) => bool(toJS(a) < toJS(b)),
    gt:   (a, b) => bool(toJS(a) > toJS(b)),
    le:   (a, b) => bool(toJS(a) <= toJS(b)),
    ge:   (a, b) => bool(toJS(a) >= toJS(b)),
    seq:  (a, b) => bool(toJS(a) === toJS(b)),
    sne:  (a, b) => bool(toJS(a) !== toJS(b)),
    truthy: (v) => (toJS(v) ? 1 : 0),        // 裸 i32 布尔（wasm 条件直接消费）
    log:  (v) => console.log("  [qz]", typeof toJS(v) === "string" ? toJS(v) : String(toJS(v))),
    // 供宿主检查用（不在 wasm import 面）
    _toJS: toJS, _fromJS: (x) => (typeof x === "number" ? numToBits(x) : tagHandle(x)),
    _handles: handles, _TAG: TAG,
  };
}

module.exports = { makeQzvmF64 };

if (require.main === module) {
  // 自检：往返 + 大数精度 + 句柄判定
  const qz = makeQzvmF64(["a"]);
  console.assert(qz._toJS(qz._fromJS(42)) === 42, "number 往返");
  console.assert(qz._toJS(qz._fromJS(8999999000)) === 8999999000, "大数 53 位");
  const o = qz.object_new();
  console.assert(qz._toJS(o) !== undefined && typeof qz._toJS(o) === "object", "句柄往返");
  console.log("qzvm-f64 self-check ok");
}
