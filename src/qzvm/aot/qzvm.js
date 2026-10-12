#!/usr/bin/env node
/* qzvm.js — qz.* 运行时（f64 NaN-box 值模型，32/64 位宿主通用）。
 *
 * 值模型（i64）：
 *   - 数值：直接是 f64 的 IEEE-754 位型（i64.reinterpret_f64），对齐 TS number 53 位精度。
 *   - 句柄：高 16 位 = 0x7FF9 的 NaN 位型（真实 f64 算术不会产出，canonical NaN 高 16 位是 0x7FF8），
 *           低 32 位存表索引。判定「是句柄」= `b >> 48 == 0x7FF9`。
 * 该表示与宿主字长无关：wasm f64 恒为 IEEE-754 double，32 位宿主由 wamrc 降到软/硬浮点，
 * 数值语义（含 >2^31 的整数）不变 —— 故 32/64 位设备共用同一表示，无需按目标位宽切换。
 * 跨界（wasm import ↔ JS）用 BigInt 传 i64。
 *
 * 用法: const { makeQzvm } = require('./qzvm.js');
 *       const qz = makeQzvm(["k0","k1",...]);   // strings 由 emitter 输出
 *       new WebAssembly.Instance(module, { qz });
 */
"use strict";

const TAG = 0x7ff9_0000_0000_0000n;      // 句柄标记（高 16 位 0x7FF9）
const TAG_HI = 0x7ff9n;                   // 高 16 位比较值
const STR_HI = 0x7ffan;                   // 字符串句柄高 16 位
const MASK32 = 0xffff_ffffn;
const _ab = new ArrayBuffer(8);
const _dvw = new DataView(_ab);
function _writeF64(n, le) { _dvw.setFloat64(0, n, le); return _dvw.getBigInt64(0, le); }
function _readF64(b, le) { _dvw.setBigInt64(0, b, le); return _dvw.getFloat64(0, le); }
// UTF-8 字节 → 字符串（无 TextDecoder 依赖；真 qzjs 运行时无 Buffer/TextDecoder）
function _utf8(u8, s, e) {
  let r = "", i = s;
  while (i < e) {
    const c = u8[i++];
    if (c < 0x80) r += String.fromCharCode(c);
    else if (c < 0xe0) r += String.fromCharCode(((c & 0x1f) << 6) | (u8[i++] & 0x3f));
    else if (c < 0xf0) r += String.fromCharCode(((c & 0x0f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f));
    else { const cp = ((c & 7) << 18) | ((u8[i++] & 0x3f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f);
           const x = cp - 0x10000; r += String.fromCharCode(0xd800 + (x >> 10), 0xdc00 + (x & 0x3ff)); }
  }
  return r;
}

function makeQzvm(strings) {
  const handles = [undefined];            // index 0 保留（handle 0 无效）

  const numToBits = (n) => _writeF64(n, true);
  const bitsToNum = (b) => _readF64(BigInt.asIntN(64, b), true);
  const isH = (b) => (BigInt(b) >> 48n) === TAG_HI;
  const isStrH = (b) => (BigInt(b) >> 48n) === STR_HI;
  const idxOf = (b) => Number(BigInt(b) & MASK32);
  const strRead = (b) => {
    const off = Number(BigInt(b) & MASK32);
    const dv = new Uint8Array(mem.buffer);
    const len = dv[off] | (dv[off+1] << 8) | (dv[off+2] << 16) | (dv[off+3] << 24);
    return _utf8(dv, off + 4, off + 4 + len);
  };
  const toJS = (b) => (isStrH(b) ? strRead(b) : (isH(b) ? handles[idxOf(b)] : bitsToNum(b)));
  const tagHandle = (x) => TAG | BigInt(handles.push(x) - 1);
  const box = (n) => numToBits(n);
  const bool = (b) => numToBits(b ? 1 : 0);

  let bump = 0, mem = null, memU8 = null, bumpRef = null, exportsRef = null, lamMeta = null, classMeta = null;
  const bindMem = (m) => { mem = m; memU8 = new Uint8Array(m.buffer); };
  const bindBump = (g) => { bumpRef = g; };
  // JS 字符串 → wasm 堆（[len:i32 LE][utf8]），bump 分配，返回 0x7FFA 句柄。
  const strWriteback = (str) => {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.codePointAt(i);
      if (c > 0xffff) i++;                            // 代理对
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    const off = bumpRef.value;
    const total = 4 + bytes.length;
    const aligned = (total + 7) & ~7;
    bumpRef.value = off + aligned;
    memU8[off] = bytes.length & 0xff; memU8[off+1] = (bytes.length >>> 8) & 0xff;
    memU8[off+2] = (bytes.length >>> 16) & 0xff; memU8[off+3] = (bytes.length >>> 24) & 0xff;
    for (let i = 0; i < bytes.length; i++) memU8[off + 4 + i] = bytes[i];
    return (0x7ffan << 48n) | BigInt(off);
  };
  // 类实例分配：bump 分配 sizeBytes 并写 [0]=clsId（wasm 构造器随后写字段）。
  const newobj = (sizeBytes, clsId) => {
    const off = (bumpRef.value + 7) & ~7;
    bumpRef.value = off + ((sizeBytes + 7) & ~7);
    new Int32Array(mem.buffer, off, 1)[0] = clsId;
    return (0x7ff9n << 48n) | BigInt(off);
  };
  const doStrMethod = (recv, mid, a0, a1) => {
    const s = toJS(recv);
    const arg = (x) => toJS(x);
    const name = strings[mid];
    let r;
    switch (name) {
      case "charAt":       r = s.charAt(arg(a0)); break;
      case "charCodeAt":   r = s.charCodeAt(arg(a0)); break;
      case "indexOf":      r = s.indexOf(String(arg(a0))); break;
      case "lastIndexOf":  r = s.lastIndexOf(String(arg(a0))); break;
      case "slice":        r = s.slice(arg(a0), a1 === undefined ? undefined : arg(a1)); break;
      case "substring":    r = s.substring(arg(a0), a1 === undefined ? undefined : arg(a1)); break;
      case "substr":       r = s.substr(arg(a0), a1 === undefined ? undefined : arg(a1)); break;
      case "toUpperCase":  r = s.toUpperCase(); break;
      case "toLowerCase":  r = s.toLowerCase(); break;
      case "trim":         r = s.trim(); break;
      case "trimStart":    r = s.trimStart(); break;
      case "trimEnd":      r = s.trimEnd(); break;
      case "repeat":       r = s.repeat(arg(a0)); break;
      case "startsWith":   r = s.startsWith(String(arg(a0))); break;
      case "endsWith":     r = s.endsWith(String(arg(a0))); break;
      case "includes":     r = s.includes(String(arg(a0))); break;
      case "padStart":     r = s.padStart(arg(a0), arg(a1)); break;
      case "padEnd":       r = s.padEnd(arg(a0), arg(a1)); break;
      case "replace":      r = s.replace(String(arg(a0)), String(arg(a1))); break;
      case "split":        r = s.split(String(arg(a0))); break;   // 返回 JS 数组句柄（toJS = array）
      case "concat":       r = s.concat(arg(a0)); break;
      default: throw new Error("未知字符串方法: " + name);
    }
    // 字符串 → 写回 wasm 堆（[len][utf8]），返回 0x7FFA 句柄（与热路径内存布局一致）；
    // 数字（charCodeAt/indexOf/lastIndexOf）→ box；其它（split 返回数组）→ JS 句柄。
    if (typeof r === "string") return strWriteback(r);
    if (typeof r === "number") return box(r);
    return tagHandle(r);
  };
  return {
    // POJO 分配：返回 wasm 内存偏移（裸 i32），字段由 wasm i64.store 写入（零跨界）
    alloc: (nbytes) => { const off = bump; bump += nbytes; return off; },
    newobj,
    bindMem,
    object_new: () => tagHandle({}),
    object_set: (o, k, v) => { handles[idxOf(o)][strings[k]] = toJS(v); },
    object_get: (o, k) => tagHandle(handles[idxOf(o)][strings[k]]),
    string_new: (id) => tagHandle(strings[id]),
    string_concat: (a, b) => tagHandle(String(toJS(a)) + String(toJS(b))),
    str_len: (a) => box(strRead(a).length),
    add:  (a, b) => box(toJS(a) + toJS(b)),
    sub:  (a, b) => box(toJS(a) - toJS(b)),
    mul:  (a, b) => box(toJS(a) * toJS(b)),
    div:  (a, b) => box(toJS(a) / toJS(b)),
    rem:  (a, b) => box(toJS(a) % toJS(b)),
    band: (a, b) => box((toJS(a) | 0) & (toJS(b) | 0)),
    bor:  (a, b) => box((toJS(a) | 0) | (toJS(b) | 0)),
    bxor: (a, b) => box((toJS(a) | 0) ^ (toJS(b) | 0)),
    shl:  (a, b) => box((toJS(a) | 0) << ((toJS(b) | 0) & 31)),
    shr:  (a, b) => box((toJS(a) | 0) >> ((toJS(b) | 0) & 31)),
    ushr: (a, b) => box((toJS(a) | 0) >>> ((toJS(b) | 0) & 31)),
    lt:   (a, b) => bool(toJS(a) < toJS(b)),
    gt:   (a, b) => bool(toJS(a) > toJS(b)),
    le:   (a, b) => bool(toJS(a) <= toJS(b)),
    ge:   (a, b) => bool(toJS(a) >= toJS(b)),
    seq:  (a, b) => bool(toJS(a) === toJS(b)),
    sne:  (a, b) => bool(toJS(a) !== toJS(b)),
    // 真值判定：不经 toJS——类实例/POJO 句柄（0x7FF9|内存偏移）不在 JS handles 表中，
    // 经 toJS 会取到 undefined 而误判 falsy。按 tag 直接判：undefined/null=0x7FF9|0 → 假；
    // 对象/数组/非空字符串 → 真；其余按 f64 数值。
    truthy: (v) => {
      const u = BigInt.asUintN(64, v), hi = u >> 48n;
      if (hi === TAG_HI) return Number(u & MASK32) !== 0 ? 1 : 0;   // 0x7FF9：偏移 0 = undefined/null
      if (hi === STR_HI) return strRead(v).length ? 1 : 0;          // 0x7FFA：字符串
      if (hi === 0x7ff8n) return 1;                                 // 0x7FF8：数组
      return bitsToNum(v) ? 1 : 0;
    },
    log:  (v) => console.log("  [qz]", typeof toJS(v) === "string" ? toJS(v) : String(toJS(v))),
    // 字符串方法：recv + 方法名 id + 2 参（undefined 句柄 = 缺省）→ 结果字符串句柄。
    str_method: (recv, mid, a0, a1) => doStrMethod(recv, mid, a0, a1),
    // 通用方法调用：字符串 → 同上；类实例（内存 [0]=__cls id）→ 沿继承链查
    // classMeta[clsId].methods[name] 调 wasm 导出方法（self=recv, a0..a3）。
    method_call: (recv, mid, a0, a1, a2, a3) => {
      if (isStrH(recv)) return doStrMethod(recv, mid, a0, a1);
      const off = Number(BigInt.asUintN(64, recv) & 0xffff_ffffn);
      const clsId = new Int32Array(mem.buffer, off, 1)[0];
      const name = strings[mid];
      let c = classMeta && classMeta[clsId];
      while (c) {
        const m = c.methods[name];
        if (m) {
          const fn = exportsRef[m.name];
          return fn(recv, a0, a1, a2, a3);
        }
        c = c.parent != null ? classMeta[c.parent] : null;
      }
      throw new Error("method_call: 类 " + clsId + " 无方法 " + name);
    },
    bindClasses: (ex, cm) => { exportsRef = ex; classMeta = cm; },
    bindBump,
    // 供宿主检查用（不在 wasm import 面）
    _toJS: toJS, _fromJS: (x) => (typeof x === "number" ? numToBits(x) : tagHandle(x)),
    _handles: handles, _TAG: TAG,
    // 闭包调用：handle → 堆对象 [funcidx:i32][nCaps:i32][cell×N i64]。
    // blk = off+8（cell 起点），按 lamMeta[funcidx]={name,n} 调 wasm 导出 __lam_N。
    closure_call: (handle, a0, a1, a2, a3) => {
      const off = Number(BigInt.asUintN(64, handle) & 0xffff_ffffn);
      const u32 = new Uint32Array(mem.buffer, off, 2);
      const funcidx = u32[0];
      const meta = lamMeta && lamMeta[funcidx];
      if (!meta) throw new Error("closure_call: 未知 funcidx " + funcidx);
      const fn = exportsRef[meta.name];
      const args = [off + 8, a0, a1, a2, a3].slice(0, 1 + meta.n);
      return fn(...args);
    },
    bindClosures: (ex, lm) => { exportsRef = ex; lamMeta = lm; },
  };
}
module.exports = { makeQzvm };

if (require.main === module) {
  const qz = makeQzvm(["a"]);
  console.assert(qz._toJS(qz._fromJS(42)) === 42, "number 往返");
  console.assert(qz._toJS(qz._fromJS(8999999000)) === 8999999000, "大数 53 位");
  const o = qz.object_new();
  console.assert(qz._toJS(o) !== undefined && typeof qz._toJS(o) === "object", "句柄往返");
  console.log("qzvm self-check ok");
}
