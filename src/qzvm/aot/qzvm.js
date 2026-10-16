#!/usr/bin/env node
/* qzvm.js — qz.* 运行时（f64 NaN-box 值模型，32/64 位宿主通用）。
 *
 * 值模型（i64）：
 *   - 数值：直接是 f64 的 IEEE-754 位型（i64.reinterpret_f64），对齐 TS number 53 位精度。
 *   - 句柄：高 16 位 = 0x7FF9/0x7FFA(串)/0x7FFB(数组) 等 NaN 位型；canonical NaN 高 16 位是
 *           0x7FF8 —— 该值**禁用**为标签（宿主 box(NaN) 恰产此位型，会与 NaN 相撞）。
 *           低 32 位存表索引/偏移。判定「是句柄」= 高 16 位 ∈ {0x7FF9, 0x7FFA, 0x7FFB}。
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
const BOOL_HI = 0x7ffcn;                  // 布尔句柄高 16 位（0x7FFC|低32=0/1）
const INST_HI = 0x7ffen;                  // 类实例句柄高 16 位（0x7FFE|低32=内存 offset；[off:i32]=clsId）
const HOST_TAG = 0x7ffd_0000_0000_0000n;  // 宿主对象句柄标记（0x7FFD|低32=handles 索引）
const CLO_HI = 0x7fffn;                   // 闭包值（函数）句柄高 16 位（0x7FFF|低32=cell offset）
const HOST_HI = 0x7ffdn;                  // 类实例句柄高 16 位（0x7FFE|低32=内存 offset；[off:i32]=clsId）
// 内建全局分派：名 → JS 函数（参数个数由调用点传入的 n 决定，见 builtin）。
// AOT 产物经 qz.builtin(nameId, a0..a3) 调；未列出的报「未实现」。
const BUILTIN_FNS = {
  "Math.floor": Math.floor, "Math.ceil": Math.ceil, "Math.round": Math.round,
  "Math.trunc": Math.trunc, "Math.sign": Math.sign, "Math.abs": Math.abs,
  "Math.sqrt": Math.sqrt, "Math.cbrt": Math.cbrt, "Math.exp": Math.exp,
  "Math.log": Math.log, "Math.log2": [Math.log2, 1], "Math.log10": [Math.log10, 1],
  "Math.sin": Math.sin, "Math.cos": Math.cos, "Math.tan": Math.tan,
  "Math.asin": Math.asin, "Math.acos": Math.acos, "Math.atan": Math.atan,
  "Math.atan2": [Math.atan2, 2], "Math.pow": Math.pow, "Math.hypot": Math.hypot,
  "Math.max": Math.max, "Math.min": Math.min,
  "String": String, "Number": Number, "Boolean": Boolean,
  "parseInt": parseInt, "parseFloat": parseFloat,
  "isNaN": isNaN, "isFinite": isFinite,
  "JSON.stringify": JSON.stringify, "JSON.parse": JSON.parse,
  "Object.keys": Object.keys, "Object.values": Object.values, "Object.entries": Object.entries,
  "Object.assign": Object.assign, "Object.freeze": Object.freeze,
  "Object.is": Object.is, "Object.fromEntries": Object.fromEntries,
  "Array.isArray": Array.isArray, "Array.from": Array.from, "Array.of": Array.of,
  "Number.isInteger": Number.isInteger, "Number.isNaN": Number.isNaN, "Number.isFinite": Number.isFinite,
  "Number.parseInt": Number.parseInt, "Number.parseFloat": Number.parseFloat,
  "String.fromCharCode": String.fromCharCode, "String.fromCodePoint": String.fromCodePoint,
};
// 内建全局常量（属性读非调用）：Math.PI 等。
// 内建构造器（new X(...) / X(...)）：宿主直接调用（返回宿主对象句柄 0x7FFD）。
const BUILTIN_CTORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "EvalError", "URIError", "Map", "Set", "WeakMap", "WeakSet", "Date", "Array", "Object", "RegExp", "Promise"]);

const BUILTIN_CONSTS = {
  "Math.PI": Math.PI, "Math.E": Math.E, "Math.LN2": Math.LN2, "Math.LN10": Math.LN10,
  "Math.LOG2E": Math.LOG2E, "Math.LOG10E": Math.LOG10E, "Math.SQRT2": Math.SQRT2, "Math.SQRT1_2": Math.SQRT1_2,
  "Number.MAX_SAFE_INTEGER": Number.MAX_SAFE_INTEGER, "Number.MIN_SAFE_INTEGER": Number.MIN_SAFE_INTEGER,
  "Number.MAX_VALUE": Number.MAX_VALUE, "Number.MIN_VALUE": Number.MIN_VALUE,
  "Number.EPSILON": Number.EPSILON, "Number.POSITIVE_INFINITY": Number.POSITIVE_INFINITY,
  "Number.NEGATIVE_INFINITY": Number.NEGATIVE_INFINITY, "Number.NaN": Number.NaN,
};
const MASK32 = 0xffff_ffffn;
const _ab = new ArrayBuffer(8);
const _dvw = new DataView(_ab);
function _writeF64(n, le) { _dvw.setFloat64(0, n, le); return _dvw.getBigInt64(0, le); }
function _readF64(b, le) { _dvw.setBigInt64(0, b, le); return _dvw.getFloat64(0, le); }
// UTF-8 字节 → 字符串（wasm 字符串句柄低 32 位 = offset，字节在 offset+4 起；u8 = 线性内存视图）。
// QuickJS 无原生 TextDecoder（qzjs 的 TextDecoder 是 JS polyfill，反而更慢），故两条路径：
//   ① ASCII 快路径（绝大多数场景）：Uint32Array 批量测高位（4 字节/次），命中则直接
//      String.fromCharCode.apply(null, u8.subarray(...))——免 JS 逐字节解码。1MB ≈ 27ms。
//   ② 非 ASCII：逐字节解 UTF-8 → UTF-16 code unit 到定长缓冲，每 65535（apply 参数上限）
//      一次 fromCharCode.apply。1MB ≈ 85ms。
//   旧实现逐字节 r += fromCharCode：每字符一次 JS_ConcatString，1MB ≈ 100ms+。
function _utf8(u8, s, e) {
    const CH = 65535;
    // ── ① ASCII 检测 + 快路径 ──
    if (u8.byteOffset === 0) {
        let ascii = true, i = s;
        const aStart = (s + 3) & ~3;
        for (; i < aStart && i < e; i++) if (u8[i] >= 0x80) { ascii = false; break; }
        if (ascii && e - aStart >= 4) {
            const u32 = new Uint32Array(u8.buffer, aStart, (e - aStart) >> 2);
            const n32 = u32.length;
            for (let k = 0; k < n32; k++) if (u32[k] & 0x80808080) { ascii = false; break; }
            i = aStart + (n32 << 2);
        }
        if (ascii) for (; i < e; i++) if (u8[i] >= 0x80) { ascii = false; break; }
        if (ascii) {
            if (e - s <= CH) return String.fromCharCode.apply(null, u8.subarray(s, e));
            const chunks = [];
            for (let k = s; k < e; k += CH) chunks.push(String.fromCharCode.apply(null, u8.subarray(k, k + CH < e ? k + CH : e)));
            return chunks.join("");
        }
    }
    // ── ② 非 ASCII：UTF-8 解码 ──
    const buf = new Array(CH);
    let r = "", i = s, pending = -1;
    while (i < e || pending >= 0) {
        let n = 0;
        while (n < CH && (i < e || pending >= 0)) {
            if (pending >= 0) { buf[n++] = pending; pending = -1; continue; }
            const c = u8[i++];
            if (c < 0x80) buf[n++] = c;
            else if (c < 0xe0) buf[n++] = ((c & 0x1f) << 6) | (u8[i++] & 0x3f);
            else if (c < 0xf0) buf[n++] = ((c & 0x0f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f);
            else {
                const cp = ((c & 7) << 18) | ((u8[i++] & 0x3f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f);
                const x = cp - 0x10000;
                buf[n++] = 0xd800 + (x >> 10);
                const lo = 0xdc00 + (x & 0x3ff);
                if (n < CH) buf[n++] = lo; else pending = lo;
            }
        }
        r += n === CH ? String.fromCharCode.apply(null, buf) : String.fromCharCode.apply(null, buf.slice(0, n));
    }
    return r;
}

function makeQzvm(strings, opts) {
  const handles = [undefined, null];      // index 0=undefined、1=null（固定槽，供 wasm 内 null 字面量用 0x7FF9|1）；其余从 2 起

  const numToBits = (n) => _writeF64(n, true);
  const bitsToNum = (b) => _readF64(BigInt.asIntN(64, b), true);
  const isH = (b) => (BigInt(b) >> 48n) === TAG_HI;
  const isCloH = (b) => (BigInt(b) >> 48n) === CLO_HI;
  // 闭包值 → JS 函数包装（宿主侧调用回调，如 sort(cmp)/map(fn)）
  const cloWrap = (b) => (...args) => toJS(closureCall(b, ...args.map(ret)));
  const isStrH = (b) => (BigInt(b) >> 48n) === STR_HI;
  const idxOf = (b) => Number(BigInt(b) & MASK32);
  const strRead = (b) => {
    const off = Number(BigInt(b) & MASK32);
    const dv = new Uint8Array(mem.buffer);
    const len = dv[off] | (dv[off+1] << 8) | (dv[off+2] << 16) | (dv[off+3] << 24);
    return _utf8(dv, off + 4, off + 4 + len);
  };
  const isArrH = (b) => (BigInt(b) >> 48n) === 0x7ffbn;
  // wasm 原生数组（0x7FFB）：header[0]=len，header[2]=dataOff，data = i64×len（元素解引用递归）。
  const arrRead = (b) => {
    const off = Number(BigInt(b) & MASK32);
    const dv = new DataView(mem.buffer);
    const len = dv.getInt32(off, true);
    const dataOff = dv.getInt32(off + 8, true);
    const out = new Array(len);
    for (let i = 0; i < len; i++) out[i] = toJS(dv.getBigInt64(dataOff + i * 8, true));
    return out;
  };
  const isBoolH = (b) => (BigInt(b) >> 48n) === BOOL_HI;
  const isObjHandle = (u) => { const h = u >> 48n; if (h === TAG_HI) return (u & MASK32) >= 8n; return h === INST_HI || h === HOST_HI || h === CLO_HI; };
  const statics = new Map();
  let fieldEntries = [];                  // [[name, byteOffset], ...]（bindFields 设；与 emitter _fieldIndex 一致）
  const bindFields = (fields) => { fieldEntries = (fields || []).map((n, i) => [n, (i + 1) * 8]); };
  // POJO/类实例（内存驻留）→ JS 对象物化：按 [0]=size 限定范围，逐字段读（undefined sentinel 跳过）。
  const materialize = (off) => {
    syncExtras();
    // 每次新鲜物化：POJO/实例由 bump 分配，调用间 __bump_reset 会复用偏移 → 不可跨调用缓存。
    const o = {};
    if (!mem) return o;
    const dv = new DataView(mem.buffer);
    const size = dv.getInt32(off + 4, true);
    for (const [name, idx] of fieldEntries) {
      if (idx >= size) continue;
      const v = toJS(dv.getBigInt64(off + idx, true));
      if (v !== undefined) o[name] = v;
    }
    for (const [k, v] of extras) {                        // 运行期新增字段
      const bar = k.indexOf("|");
      if (Number(k.slice(0, bar)) !== off) continue;
      const jv = toJS(v);
      if (jv !== undefined) o[k.slice(bar + 1)] = jv;
    }
    return o;
  };
  const isInstH = (b) => (BigInt(b) >> 48n) === INST_HI;
  const isHostH = (b) => (BigInt(b) >> 48n) === HOST_HI;
  // 类实例 → 稳定占位对象（同 offset 同对象，保证 === 自身）；宿主无法访问其实例内存。
  const toJS = (b) => (isCloH(b) ? cloWrap(b) : isStrH(b) ? strRead(b) : isArrH(b) ? arrRead(b) : isH(b) ? (idxOf(b) < 8 ? handles[idxOf(b)] : (mem && fieldEntries.length ? materialize(idxOf(b)) : handles[idxOf(b)])) : isHostH(b) ? handles[idxOf(b)] : isBoolH(b) ? Number(BigInt(b) & 1n) === 1 : isInstH(b) ? (mem && fieldEntries.length ? materialize(idxOf(b)) : {}) : bitsToNum(b));
  // undefined/null → 0x7FF9|0 / |1（wasm 字面量 sentinel）；其余 JS 值 → 宿主对象句柄 0x7FFD|idx
  const tagHandle = (x) => x === undefined ? TAG : x === null ? (TAG | 1n) : (HOST_TAG | BigInt(handles.push(x) - 1));
  const box = (n) => numToBits(n);
  const boxBool = (b) => (BOOL_HI << 48n) | BigInt(b ? 1 : 0);   // 0x7FFC | 低32=0/1：bool 独立 tag（与 f64 0/1 区分，宿主 toJS 还原真布尔）
  const bool = (b) => boxBool(b);
  let bump = 0, mem = null, memU8 = null, bumpRef = null, exportsRef = null, lamMeta = null, classMeta = null;
  // 运行期新增字段（POJO/实例上静态未预登记的名字，如 o[k] 中 k 由运行期决定）：
  // 存宿主侧旁表，键 = 内存偏移 + "|" + 字段名；bump 复位（偏移复用）时整体清空。
  const extras = new Map();
  let extrasAt = -1;
  // bump 复位（值变小）→ 偏移被复用 → 旁表整体失效；仅「变小」才清（同一次调用内 bump 单调增）
  const syncExtras = () => { const v = bumpRef ? Number(bumpRef.value) : -1; if (v < extrasAt) extras.clear(); extrasAt = v; };
  if (opts && opts.fields) bindFields(opts.fields);   // 便于宿主物化 POJO/实例（等价 bindFields）
  const bindMem = (m) => { mem = m; memU8 = new Uint8Array(m.buffer); };
  const bindBump = (g) => { bumpRef = g; };
  // 宿主侧 bump 分配：与 wasm 侧 STR_BASE(8MiB) 同界；越界抛错（绝不静默覆盖字面量段）。
  const ARENA_END = 8 << 20;
  const bumpAlloc = (nbytes) => {
    const off = bumpRef.value;
    if (off + nbytes > ARENA_END) throw new Error(`qzvm: bump arena 溢出（${off}+${nbytes} > ${ARENA_END}）；调用间未重置 __bump？`);
    bumpRef.value = off + nbytes;
    return off;
  };
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
    const off = bumpAlloc((4 + bytes.length + 7) & ~7);
    memU8[off] = bytes.length & 0xff; memU8[off+1] = (bytes.length >>> 8) & 0xff;
    memU8[off+2] = (bytes.length >>> 16) & 0xff; memU8[off+3] = (bytes.length >>> 24) & 0xff;
    for (let i = 0; i < bytes.length; i++) memU8[off + 4 + i] = bytes[i];
    return (0x7ffan << 48n) | BigInt(off);
  };
  // JS 值 → 句柄位型（i64）。string→0x7FFA；number→f64 位型；array→wasm 原生数组(0x7FFB)；
  // 其它→JS 句柄(0x7FF9)。wasm 侧可直接 .length/索引/push/pop 的只有 0x7FFA/0x7FFB。
  // null/undefined 不在此归一：null 走 tagHandle（独立 handles[idx]，toJS 还原 null），
  // undefined 走 tagHandle → handles[idx]（toJS 还原 undefined）。保留 null≠undefined 区分，
  // 使 + / Number / String 等运算按 JS 正确分支（Number(null)=0 ≠ Number(undefined)=NaN）。
  // ?? 判 nullish 走宿主 qz.is_nullish（见 emitNullish），不靠 TAG|0 比对。
  const bitsOf = (e) => typeof e === "string" ? strWriteback(e)
                     : typeof e === "number" ? numToBits(e)
                     : typeof e === "boolean" ? boxBool(e)
                     : Array.isArray(e) ? arrWriteback(e)
                     : tagHandle(e);
  // JS 数组 → wasm 原生数组（0x7FFB 布局：header 16B [len,cap,dataOff,pad] + data i64×N），
  // 与 emitter 数组字面量一致。关键：使 split(…)/数组方法产出的数组在 wasm 侧可直接
  // .length/索引/push/pop（此前返回 JS 句柄 0x7FF9，wasm 侧 .length 落到 str_len 读垃圾 → 静默返回 0）。
  const arrWriteback = (js) => {
    const N = js.length;
    const start = bumpAlloc((16 + N * 8 + 7) & ~7);
    const dataOff = start + 16;
    const dv = new DataView(mem.buffer);
    dv.setInt32(start, N, true);
    dv.setInt32(start + 4, N, true);
    dv.setInt32(start + 8, dataOff, true);
    dv.setInt32(start + 12, 0, true);
    for (let i = 0; i < N; i++) dv.setBigInt64(dataOff + i * 8, BigInt.asIntN(64, bitsOf(js[i])), true);
    return (0x7ffbn << 48n) | BigInt(start);
  };
  // 原地改写既有数组（保持句柄不变，支持别名/传参）：容量不足则换 data 块（同 push 语义）。
  const arrSetInPlace = (recv, js) => {
    const off = Number(BigInt(recv) & MASK32);
    const dv = new DataView(mem.buffer);
    let dataOff = dv.getInt32(off + 8, true);
    let cap = dv.getInt32(off + 4, true);
    const N = js.length;
    if (N > cap) {
      cap = N < 4 ? 4 : N * 2;
      dataOff = bumpAlloc(cap * 8);
      dv.setInt32(off + 8, dataOff, true);
      dv.setInt32(off + 4, cap, true);
    }
    dv.setInt32(off, N, true);
    for (let i = 0; i < N; i++) dv.setBigInt64(dataOff + i * 8, BigInt.asIntN(64, bitsOf(js[i])), true);
    return recv;
  };
  // 闭包调用：handle → 堆对象 [funcidx:i32][nCaps:i32][cell×N i64]。
  // blk = off+8（cell 起点），按 lamMeta[funcidx]={name,n} 调 wasm 导出 __lam_N。
  const closureCall = (handle, a0, a1, a2, a3) => {
    const off = Number(BigInt.asUintN(64, handle) & 0xffff_ffffn);
    const funcidx = new DataView(mem.buffer).getUint32(off, true);   // 免 4 对齐（bump 偏移可非 4 倍数）
    const meta = lamMeta && lamMeta[funcidx];
    if (!meta) throw new Error("closure_call: 未知 funcidx " + funcidx);
    const fn = exportsRef[meta.name];
    const blk = new DataView(mem.buffer).getInt32(off + 4, true);   // env 索引（0 = 无捕获）
    const args = [blk, a0, a1, a2, a3].slice(0, 1 + meta.n);
    return fn(...args);
  };
  // JS 值 → tagged 位型（宿主回退返回用）：number→box、bool→boxBool、string→0x7FFA、
  // array→0x7FFB、null/undefined→固定槽、其它→0x7FF9 句柄。
  const ret = (r) => typeof r === "number" ? box(r) : typeof r === "boolean" ? boxBool(r)
                   : typeof r === "string" ? strWriteback(r) : r === undefined || r === null ? tagHandle(r)
                   : Array.isArray(r) ? arrWriteback(r) : tagHandle(r);
  // 数组方法（recv=0x7FFB 原生数组）。回调（map/filter/reduce/…）为闭包句柄，
  // 经 closure_call(handle, v, i, arr) 调用 wasm 侧箭头函数。
  // 4 参槽中未传的实参由 emitter 填 undefined 句柄（0x7FF9|0）；变参方法（concat）据此过滤。
  const givenSlot = (x) => {
    if (x === undefined) return false;
    const u = BigInt.asUintN(64, x);
    return !(u >> 48n === TAG_HI && (u & 0xffff_ffffn) <= 1n);
  };
  const doArrMethod = (recv, mid, a0, a1, a2, a3) => {
    const extra = (first) => [a0, a1, a2, a3].slice(first).filter(givenSlot).map(toJS);
    const name = strings[mid];
    const arr = () => arrRead(recv);
    const cbv = (h, v, i, acc) => toJS(closureCall(h, bitsOf(v), box(i), acc === undefined ? recv : acc));
    let r;
    switch (name) {
      case "indexOf":     r = arr().indexOf(toJS(a0)); break;
      case "lastIndexOf": r = arr().lastIndexOf(toJS(a0)); break;
      case "includes":    r = arr().some(x => x === toJS(a0)); break;
      case "slice":       r = arr().slice(toJS(a0), a1 === undefined ? undefined : toJS(a1)); break;
      case "concat":      r = arr().concat(...extra(0)); break;
      case "join":        r = arr().map(x => x === undefined || x === null ? "" : String(x)).join(toJS(a0) === undefined ? "," : String(toJS(a0))); break;
      case "reverse":     r = arrSetInPlace(recv, arr().reverse()); return recv;
      case "shift":       { const a = arr(); r = a.length ? a.shift() : undefined; arrSetInPlace(recv, a); return ret(r); }
      case "unshift":     { const a = arr(); a.unshift(toJS(a0)); arrSetInPlace(recv, a); return box(a.length); }
      case "map":         r = arr().map((v, i) => cbv(a0, v, i)); break;
      case "filter":      r = arr().filter((v, i) => !!cbv(a0, v, i)); break;
      case "reduce":      { const a = arr();
                            const rc = (acc, v, i) => toJS(closureCall(a0, bitsOf(acc), bitsOf(v), box(i)));
                            r = toJS(a1) !== undefined ? a.reduce((acc, v, i) => rc(acc, v, i), toJS(a1))
                                                 : a.reduce((acc, v, i) => rc(acc, v, i)); break; }
      case "forEach":     arr().forEach((v, i) => cbv(a0, v, i)); r = undefined; break;
      case "find":        r = arr().find((v, i) => !!cbv(a0, v, i)); break;
      case "findIndex":   r = arr().findIndex((v, i) => !!cbv(a0, v, i)); break;
      case "some":        r = arr().some((v, i) => !!cbv(a0, v, i)); break;
      case "every":       r = arr().every((v, i) => !!cbv(a0, v, i)); break;
      case "sort":        r = arrSetInPlace(recv, toJS(a0) !== undefined ? arr().sort((x, y) => toJS(closureCall(a0, bitsOf(x), bitsOf(y), recv))) : arr().sort()); return recv;   // 无比较器 → JS 默认字典序
      case "splice":      { const a = arr(); const del = a.splice(toJS(a0), toJS(a1) === undefined ? a.length : toJS(a1)); arrSetInPlace(recv, a); r = del; break; }
      case "fill":        { const a = arr(); a.fill(toJS(a0)); arrSetInPlace(recv, a); return recv; }
      default: throw new Error("method_call: 数组无方法 " + name);
    }
    return ret(r);
  };
  const doStrMethod = (recv, mid, a0, a1, a2, a3) => {
    const extra = () => [a0, a1, a2, a3].filter(givenSlot).map(toJS);
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
      case "concat":       r = s.concat(...extra().map(String)); break;
      default: throw new Error("未知字符串方法: " + name);
    }
    // 字符串 → 写回 wasm 堆（[len][utf8]），返回 0x7FFA 句柄（与热路径内存布局一致）；
    // 数字（charCodeAt/indexOf/lastIndexOf）→ box；数组（split）→ wasm 原生数组（0x7FFB，
    // 使 .length/索引/push/pop 在 wasm 侧可用）；其它 → JS 句柄。
    if (typeof r === "string") return strWriteback(r);
    if (typeof r === "number") return box(r);
    if (typeof r === "boolean") return boxBool(r);   // startsWith/endsWith/includes 等 → 真布尔 tag
    if (Array.isArray(r)) return arrWriteback(r);
    return tagHandle(r);
  };
  return {
    // POJO 分配：返回 wasm 内存偏移（裸 i32），字段由 wasm i64.store 写入（零跨界）
    alloc: (nbytes) => { const off = bump; bump += nbytes; return off; },
    bindMem,
    object_new: () => tagHandle({}),
    object_set: (o, k, v) => { handles[idxOf(o)][strings[k]] = toJS(v); },
    object_get: (o, k) => ret(handles[idxOf(o)][strings[k]]),   // 值经 ret（string→0x7FFA、array→0x7FFB、其它→0x7FFD）
    string_new: (id) => tagHandle(strings[id]),
    string_concat: (a, b) => strWriteback(String(toJS(a)) + String(toJS(b))),   // → 0x7FFA
    str_len: (a) => box(strRead(a).length),
    add:  (a, b) => ret(toJS(a) + toJS(b)),   // JS + 可能产字符串 → ret（非固定数值）
    sub:  (a, b) => box(toJS(a) - toJS(b)),
    mul:  (a, b) => box(toJS(a) * toJS(b)),
    div:  (a, b) => box(toJS(a) / toJS(b)),
    rem:  (a, b) => box(toJS(a) % toJS(b)),
    // **：Math.pow 语义（含 NaN^0=1、0^0=1 等特例）；tagged 操作数经 toJS 解引用
    pow:  (a, b) => box(Math.pow(toJS(a), toJS(b))),
    math_pow: (a, b) => Math.pow(a, b),
    math_rem: (a, b) => a % b,
    // nullish = 0x7FF9|0（undefined）或 0x7FF9|1（null）——按 tag 判定，不经 toJS（无需字段表/物化）。
    is_nullish: (a) => { const u = BigInt.asUintN(64, a); if ((u >> 48n) !== TAG_HI) return 0; const idx = Number(u & MASK32); return (idx === 0 || idx === 1) ? 1 : 0; },
    // instanceof：obj 须为类实例句柄（专用 tag 0x7FFE|off，[off]=clsId）；沿「实例类 → 父链」查目标 clsId。
    // 非实例（数字/字符串/bool/null/数组/POJO/宿主对象）→ false。需 bindClasses 提供 classMeta。
    instanceof_op: (obj, clsId) => {
      const u = BigInt.asUintN(64, obj);
      if ((u >> 48n) !== INST_HI) return boxBool(false);
      const off = Number(u & MASK32);
      if (!mem || off + 4 > mem.buffer.byteLength) return boxBool(false);
      let c = new DataView(mem.buffer).getInt32(off, true);   // 实例的 clsId
      while (c !== null && c !== undefined) {
        if (c === clsId) return boxBool(true);
        const m = classMeta && classMeta[c];
        c = m ? m.parent : null;
      }
      return boxBool(false);
    },
    // 对象展开（{...o, a:1}）：Object.assign({}, ...pieces) → 宿主对象句柄。n = pieces 数。
    obj_assign: (n, a0, a1, a2, a3) => ret(Object.assign({}, ...[a0, a1, a2, a3].slice(0, n).map(toJS))),
    // 闭包共享环境（链式）：env = 宿主对象 {__parent, <var>: tagged}；idx = handles 索引。
    // 外层本体与其闭包共享同一 env → 写回互相可见（不再是值快照）。
    env_new: (parentIdx) => ret({ __parent: parentIdx >= 0 ? handles[parentIdx] : null }),
    env_get: (idx, kid) => {
      const name = strings[kid];
      let e = handles[idx];
      while (e) { const v = e[name]; if (v !== undefined) return v; e = e.__parent; }
      return TAG;   // 未定义 → undefined sentinel（0x7FF9|0）
    },
    env_set: (idx, kid, v) => {   // 沿 __parent 链写到「定义该变量」的层（否则内层环境会遮蔽外层写）
      const name = strings[kid];
      let e = handles[idx];
      while (e) { if (Object.prototype.hasOwnProperty.call(e, name)) { e[name] = v; return; } e = e.__parent; }
      handles[idx][name] = v;
    },
    // 类静态字段：宿主表 nameId → { fieldId: tagged值 }；lazy 初始化（statics_ready 未标记时由产物内联初始值）。
    statics_ready: (id) => (statics.has(strings[id]) ? 1 : 0),
    statics_mark: (id) => { if (!statics.has(strings[id])) statics.set(strings[id], {}); },
    static_get: (id, fid) => { const o = statics.get(strings[id]); const v = o ? o[strings[fid]] : undefined; return v === undefined ? TAG : v; },
    static_set: (id, fid, v) => { let o = statics.get(strings[id]); if (!o) { o = {}; statics.set(strings[id], o); } o[strings[fid]] = v; },
    // 类 getter/setter 分派（仅当程序内有该类属性访问器时由产物调用）：实例沿继承链找访问器；
    // 命中 → 调 wasm 导出方法；未命中 → 退化为字段读/写（与 qz.get_index/set_index 同语义）。
    prop_get: (recv, id) => {
      const name = strings[id];
      const u = BigInt.asUintN(64, recv), hi = u >> 48n, off = Number(u & MASK32);
      if (hi === INST_HI && mem) {
        const clsId = new DataView(mem.buffer).getInt32(off, true);
        let c = classMeta && classMeta[clsId];
        while (c) {
          const g = c.getters && c.getters[name];
          if (g) return exportsRef[g.name](recv, TAG, TAG, TAG, TAG);
          c = c.parent != null ? classMeta[c.parent] : null;
        }
        const e = fieldEntries.find(([n]) => n === name);
        if (!e || new DataView(mem.buffer).getInt32(off + 4, true) < e[1] + 8) {
          syncExtras(); const x = extras.get(off + "|" + name); return x === undefined ? TAG : x;
        }
        return new DataView(mem.buffer).getBigInt64(off + e[1], true);
      }
      if (hi === HOST_HI) { const o = handles[off]; return ret(o == null ? undefined : o[name]); }
      return ret(toJS(recv)[name]);
    },
    prop_set: (recv, id, v) => {
      const name = strings[id];
      const u = BigInt.asUintN(64, recv), hi = u >> 48n, off = Number(u & MASK32);
      if (hi === INST_HI && mem) {
        const clsId = new DataView(mem.buffer).getInt32(off, true);
        let c = classMeta && classMeta[clsId];
        while (c) {
          const st = c.setters && c.setters[name];
          if (st) { exportsRef[st.name](recv, v, v, v, v); return; }
          c = c.parent != null ? classMeta[c.parent] : null;
        }
        const e = fieldEntries.find(([n]) => n === name);
        if (!e || new DataView(mem.buffer).getInt32(off + 4, true) < e[1] + 8) { syncExtras(); extras.set(off + "|" + name, v); return; }
        new DataView(mem.buffer).setBigInt64(off + e[1], v, true);
        return;
      }
      if (hi === HOST_HI) { const o = handles[off]; if (o != null) o[name] = toJS(v); return; }
    },
    // x instanceof 内建类：按 tag / 物化后判定（Array/Object/String/Number/Boolean/Function/Error…）
    instanceof_builtin: (x, id) => {
      const name = strings[id];
      const u = BigInt.asUintN(64, x), hi = u >> 48n;
      const j = toJS(x);
      switch (name) {
        case "Array":    return (hi === 0x7ffbn || Array.isArray(j)) ? 1 : 0;
        case "String":   return (hi === STR_HI || typeof j === "string") ? 1 : 0;
        case "Number":   return (hi !== TAG_HI && hi !== STR_HI && hi !== 0x7ffbn && hi !== HOST_HI && hi !== INST_HI && typeof j === "number") ? 1 : 0;
        case "Boolean":  return (hi === BOOL_HI || typeof j === "boolean") ? 1 : 0;
        case "Function": return typeof j === "function" ? 1 : 0;
        case "Object":   return (j !== null && typeof j === "object") ? 1 : 0;
        case "Error":    return (j instanceof Error) ? 1 : 0;
        case "RegExp":   return (j instanceof RegExp) ? 1 : 0;
        case "Date":     return (j instanceof Date) ? 1 : 0;
        default: throw new Error("instanceof_builtin: 未知内建类 " + name);
      }
    },
    // 展开实参动态调用：call_named(nameId, argsArr, isNum)；isNum=1 → 目标为 f64 ABI（传数字）。
    call_named: (id, arr, isNum) => {
      const name = strings[id];
      const fn = exportsRef && exportsRef[name];
      if (typeof fn !== "function") throw new Error("call_named: 未导出函数 " + name);
      const raw = toJS(arr) || [];
      const args = isNum ? raw.map(Number) : raw.map(ret);   // JS 值 → tagged（bitsOf 是反向）
      // 目标可能是多参 ABI（静态方法 = self + a0..a3 共 5 槽）→ 按导出函数的实际参数个数补齐
      const n = fn.length || args.length;
      while (args.length < n) args.push(isNum ? NaN : ret(undefined));
      // 调用结果已是 tagged i64（tagged 目标）/ f64（num 目标）→ 不可再 ret（双重装箱）
      return isNum ? box(Number(fn(...args))) : fn(...args);
    },
    closure_call_spread: (handle, arr) => {
      const off = Number(BigInt.asUintN(64, handle) & 0xffff_ffffn);
      const funcidx = new DataView(mem.buffer).getUint32(off, true);
      const meta = lamMeta && lamMeta[funcidx];
      if (!meta) throw new Error("closure_call_spread: 未知 funcidx " + funcidx);
      const blk = new DataView(mem.buffer).getInt32(off + 4, true);
      const raw = (toJS(arr) || []).slice(0, 4).map(ret);
      while (raw.length < 4) raw.push(TAG);
      return exportsRef[meta.name](blk, ...raw);
    },
    is_undef: (v) => (BigInt.asUintN(64, v) === TAG ? 1 : 0),   // undefined = 0x7FF9|0（null = |1 不触发默认值）
    // {...rest}：物化后去掉指定键，返回**宿主对象**（可继续读写）。
    object_rest: (v, i0, i1, i2, i3) => {
      const skip = [i0, i1, i2, i3].map(i => strings[i]);
      const o = toJS(v);
      const out = {};
      for (const k of Object.keys(o || {})) if (!skip.includes(k)) out[k] = o[k];
      return tagHandle(out);
    },
    // 对象展开的宿主源（JSON.parse 结果等非 POJO）：物化后逐键写进目标（预登记字段 → 内存槽；其余 → extras）。
    // 含方法/访问器的对象字面量 → 宿主对象：get/set 回调 wasm 闭包（宿主 JS 侧亦按 JS 语义工作）
    obj_new: () => tagHandle({}),
    typeof_host: (v) => (typeof handles[idxOf(v)] === "function" ? 1 : 0),
    // 对象字面量的方法（闭包，第一个形参为 self）：宿主调用时转发接收者
    object_set_method: (o, k, v) => {
      const obj = handles[idxOf(o)];
      obj[strings[k]] = function (...args) { return toJS(closureCall(v, o, ret(args[0]), ret(args[1]), ret(args[2]))); };
    },
    obj_accessor: (o, k, g, s2) => {
      const name = strings[k], obj = handles[idxOf(o)], opt = {};
      if (BigInt.asUintN(64, g) >> 48n === CLO_HI) opt.get = () => toJS(closureCall(g, o, TAG, TAG, TAG));
      if (BigInt.asUintN(64, s2) >> 48n === CLO_HI) opt.set = (v) => { closureCall(s2, o, ret(v), TAG, TAG); };
      if (opt.get || opt.set) Object.defineProperty(obj, name, { get: opt.get, set: opt.set, configurable: true, enumerable: true });
    },
    obj_merge: (target, src) => {
      const o = toJS(src);
      if (o == null) return;
      syncExtras();
      const u = BigInt.asUintN(64, target), off = Number(u & MASK32);
      const dv = mem ? new DataView(mem.buffer) : null;
      const size = dv ? dv.getInt32(off + 4, true) : 0;
      for (const k of Object.keys(o)) {
        const v = ret(o[k]);
        const e = fieldEntries.find(([n]) => n === k);
        if (e && dv && e[1] + 8 <= size) dv.setBigInt64(off + e[1], v, true);
        else extras.set(off + "|" + k, v);
      }
    },
    // 动态键取值/赋值 o[k]：POJO/实例按字段名表（fieldEntries）定位；宿主对象直接索引；数组/字符串走 toJS。
    get_index: (o, k) => {
      const u = BigInt.asUintN(64, o), hi = u >> 48n, off = Number(u & MASK32);
      if (hi === TAG_HI || hi === INST_HI) {
        if (off < 8) return handles[off];
        const name = String(toJS(k));
        const e = fieldEntries.find(([n]) => n === name);
        if (!e || !mem) { syncExtras(); const x = extras.get(off + "|" + name); return x === undefined ? TAG : x; }
        return new DataView(mem.buffer).getBigInt64(off + e[1], true);
      }
      if (hi === HOST_HI) return ret(handles[off][toJS(k)]);
      return ret(toJS(o)[toJS(k)]);
    },
    set_index: (o, k, v) => {
      const u = BigInt.asUintN(64, o), hi = u >> 48n, off = Number(u & MASK32);
      if (hi === TAG_HI || hi === INST_HI) {
        if (off < 8) { handles[off] = toJS(v); return; }
        const name = String(toJS(k));
        const e = fieldEntries.find(([n]) => n === name);
        if (!e || !mem) { syncExtras(); extras.set(off + "|" + name, v); return; }   // 运行期新增字段
        new DataView(mem.buffer).setBigInt64(off + e[1], v, true);
        return;
      }
      if (hi === HOST_HI) { handles[off][toJS(k)] = toJS(v); return; }
      toJS(o)[toJS(k)] = toJS(v);
    },
    // k in o：宿主语义（POJO/实例先物化；数组/宿主对象直接 in）。
    in_op: (k, o) => boxBool(toJS(k) in toJS(o)),   // tagged bool（不可经 ret：BigInt 会被当宿主句柄）
    // delete o.k：宿主对象真删；POJO/实例由 emitter 直接把槽写成 undefined sentinel（本函数仅宿主）。
    object_delete: (o, kid) => { const obj = handles[idxOf(o)]; if (obj !== null && typeof obj === "object") delete obj[strings[kid]]; },
    // 内建全局调用/常量：nameId + n(实际参数个数) + a0..a3 → 宿主 JS 内建 → ret。
    // n 由调用点编译期已知：变参函数（Math.max/min/hypot/Array.of/fromCharCode）按 n 取参，
    // 不传 undefined 占位（否则 Math.max(2,5) 会变 Math.max(2,5,undefined,…)=NaN）。
    builtin: (id, n, a0, a1, a2, a3) => {
      const name = strings[id];
      if (Object.prototype.hasOwnProperty.call(BUILTIN_CONSTS, name)) return ret(BUILTIN_CONSTS[name]);
      let fn = BUILTIN_FNS[name] || (BUILTIN_CTORS.has(name) ? globalThis[name] : undefined);
      let arity = 0;                                  // 表项 [fn, arity] = 固定元数（调用点按此裁剪实参）
      if (Array.isArray(fn)) { arity = fn[1]; fn = fn[0]; }
      if (typeof fn !== "function") throw new Error("qz.builtin 未实现: " + name);
      const args = [a0, a1, a2, a3].slice(0, arity || n).map(toJS);
      return ret(BUILTIN_CTORS.has(name) ? Reflect.construct(fn, args) : fn.apply(null, args));
    },
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
    // == / === 对「对象类句柄」（POJO 0x7FF9|off≥8、实例 0x7FFE、宿主 0x7FFD）按 (tag|off) 身份比较
    // （物化对象每次新建，不能靠引用相等）；其余按 toJS 值比较（宽松 == 另走 qz.eq）。
    seq:  (a, b) => { const ua = BigInt.asUintN(64, a), ub = BigInt.asUintN(64, b); const oa = isObjHandle(ua), ob = isObjHandle(ub); return oa || ob ? bool(oa && ob && ua === ub) : bool(toJS(a) === toJS(b)); },
    sne:  (a, b) => { const ua = BigInt.asUintN(64, a), ub = BigInt.asUintN(64, b); const oa = isObjHandle(ua), ob = isObjHandle(ub); return oa || ob ? bool(!(oa && ob && ua === ub)) : bool(toJS(a) !== toJS(b)); },
    // 宽松相等 == / 不等 !=：JS 强制转换（ToPrimitive/ToNumber；1=="1"=true、null==undefined=true）
    eq:   (a, b) => bool(toJS(a) == toJS(b)),
    ne:   (a, b) => bool(toJS(a) != toJS(b)),
    bnot: (a) => box(~(toJS(a) | 0)),
    to_num: (a) => box(+toJS(a)),
    // 真值判定：不经 toJS——类实例/POJO 句柄（0x7FF9|内存偏移）不在 JS handles 表中，
    // 经 toJS 会取到 undefined 而误判 falsy。按 tag 直接判：idx=0=undefined→假；其余查 handles[idx]（null→假、对象→真）。
    truthy: (v) => {
      const u = BigInt.asUintN(64, v), hi = u >> 48n;
      if (hi === TAG_HI) { const idx = Number(u & MASK32); if (idx === 0) return 0; if (idx === 1) return 0; return idx >= 8 ? 1 : (handles[idx] ? 1 : 0); }  // 0x7FF9：0=undefined/1=null→假；POJO(idx>=8)→真；其余查 handles[idx]
      if (hi === STR_HI) return strRead(v).length ? 1 : 0;          // 0x7FFA：字符串
      if (hi === 0x7ffbn) return 1;                                 // 0x7FFB：wasm 原生数组（恒真；Boolean([])=true）
      if (hi === BOOL_HI) return Number(u & 1n);                    // 0x7FFC：布尔（复用低 32 = 0/1）
      if (hi === INST_HI) return 1;                                 // 0x7FFE：类实例（恒真）
      if (hi === CLO_HI) return 1;                                  // 0x7FFF：闭包值（函数，恒真）
      if (hi === HOST_HI) return handles[idxOf(v)] ? 1 : 0;         // 0x7FFD：宿主对象（查 handles）
      return bitsToNum(v) ? 1 : 0;
    },
    // .length 宿主回退：宿主数组/宿主字符串句柄/POJO（物化后取 JS .length；无 length 字段 → undefined）
    length_of: (v) => { const x = toJS(v); return ret(x == null ? undefined : x.length); },
    log:  (v) => console.log("  [qz]", typeof toJS(v) === "string" ? toJS(v) : String(toJS(v))),
    // 字符串方法：recv + 方法名 id + 2 参（undefined 句柄 = 缺省）→ 结果字符串句柄。
    str_method: (recv, mid, a0, a1) => doStrMethod(recv, mid, a0, a1),
    // 通用方法调用：字符串 → doStrMethod；数组(0x7FFB) → doArrMethod；类实例（内存 [0]=__cls id）
    // → 沿继承链查 classMeta[clsId].methods[name] 调 wasm 导出方法（self=recv, a0..a3）。
    method_call: (recv, mid, a0, a1, a2, a3) => {
      if (isStrH(recv)) return doStrMethod(recv, mid, a0, a1, a2, a3);
      if (isArrH(recv)) return doArrMethod(recv, mid, a0, a1, a2, a3);
      const name = strings[mid];
      if (isHostH(recv)) {                                   // 宿主对象（JSON.parse 结果等）：调真实 JS 方法
        const obj = handles[idxOf(recv)];
        const fn = obj == null ? undefined : obj[name];
        if (typeof fn !== "function") throw new Error("method_call: 宿主对象无方法 " + name);
        return ret(fn.call(obj, ...[a0, a1, a2, a3].slice(0, 4).map(toJS)));
      }
      // 纯数值接收者（高16位非任何句柄 tag）→ Number.prototype 方法
      {
        const hi = BigInt.asUintN(64, recv) >> 48n;
        if (hi !== TAG_HI && hi !== STR_HI && hi !== BOOL_HI
            && hi !== HOST_HI && hi !== INST_HI && hi !== 0x7ffbn) {
          const n = bitsToNum(recv);
          const g = (x) => (x === undefined ? undefined : toJS(x));
          switch (name) {
            case "toString": return ret(n.toString(g(a0) === undefined ? 10 : g(a0)));
            case "toFixed": return ret(n.toFixed(g(a0)));
            case "toPrecision": return ret(g(a0) === undefined ? n.toString() : n.toPrecision(g(a0)));
            case "toExponential": return ret(n.toExponential(g(a0)));
            case "toLocaleString": return ret(n.toLocaleString("en-US"));
            case "valueOf": return recv;
            default: throw new Error("method_call: 数值无方法 " + name);
          }
        }
      }
      const off = Number(BigInt.asUintN(64, recv) & 0xffff_ffffn);
      // POJO/实例：字段持有闭包值（0x7FFF）→ 直接调用该闭包（对象字面量里的方法 / 模块模式）
      {
        const h = BigInt.asUintN(64, recv) >> 48n;
        if ((h === TAG_HI && off >= 8) || h === INST_HI) {
          const fe = fieldEntries.find(([n]) => n === name);
          if (fe && mem && new DataView(mem.buffer).getInt32(off + 4, true) >= fe[1] + 8) {
            const fv = new DataView(mem.buffer).getBigInt64(off + fe[1], true);
            if (BigInt.asUintN(64, fv) >> 48n === CLO_HI) return closureCall(fv, a0, a1, a2, a3);
          }
        }
      }
      const clsId = new DataView(mem.buffer).getInt32(off, true);   // 免 4 对齐
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
    // 数组 .length= 赋值：截断或扩容（扩容量不足换 data 块，新槽补 undefined 句柄 0x7FF9|0）。
    // a[i] = v（越界：JS 扩容并补 undefined 槽）；返回所赋之值
    arr_set_index: (recv, i, v) => {
      const a = arrRead(recv);
      const idx = Math.trunc(toJS(i));
      if (idx < 0 || !isFinite(idx)) return v;
      while (a.length < idx) a.push(undefined);
      a[idx] = toJS(v);
      arrSetInPlace(recv, a);
      return v;
    },
    // delete a[i] → 槽置 undefined（长度不变；JS 的「洞」在本表示里等同 undefined）
    // delete o[k]（数组 → 槽置 undefined；POJO/实例 → 字段置 undefined；宿主对象 → delete）
    delete_index: (o, k) => {
      const u = BigInt.asUintN(64, o), hi = u >> 48n, off = Number(u & MASK32);
      if (hi === 0x7ffbn) {                                  // wasm 数组：槽置 undefined（长度不变）
        const a = arrRead(o);
        const idx = Math.trunc(toJS(k));
        if (idx >= 0 && idx < a.length) { a[idx] = undefined; arrSetInPlace(o, a); }
        return 1n;
      }
      if (hi === HOST_HI) { const obj = handles[off]; if (obj != null) delete obj[toJS(k)]; return 1n; }
      if ((hi === TAG_HI && off >= 8) || hi === INST_HI) {    // POJO/实例：字段槽置 undefined
        const name = String(toJS(k));
        const e = fieldEntries.find(([n]) => n === name);
        if (e && mem && new DataView(mem.buffer).getInt32(off + 4, true) >= e[1] + 8) {
          new DataView(mem.buffer).setBigInt64(off + e[1], TAG, true);
        } else if (mem) { syncExtras(); extras.delete(off + "|" + name); }
        return 1n;
      }
      return 1n;
    },
    arr_delete_index: (recv, i) => {
      const a = arrRead(recv);
      const idx = Math.trunc(toJS(i));
      if (idx >= 0 && idx < a.length) { a[idx] = undefined; arrSetInPlace(recv, a); }
      return 1n;
    },
    arr_set_len: (recv, n) => {
      const off = Number(BigInt.asUintN(64, recv) & MASK32);
      const want = Math.max(0, Math.trunc(toJS(n)));
      const dv = new DataView(mem.buffer);
      let dataOff = dv.getInt32(off + 8, true);
      let cap = dv.getInt32(off + 4, true);
      const oldLen = dv.getInt32(off, true);
      if (want > cap) {
        const newData = bumpRef.value;
        const newCap = want * 2;
        bumpRef.value += newCap * 8;
        for (let i = 0; i < oldLen; i++) dv.setBigInt64(newData + i * 8, dv.getBigInt64(dataOff + i * 8, true), true);
        dataOff = newData;
        dv.setInt32(off + 8, dataOff, true);
        dv.setInt32(off + 4, cap = newCap, true);
      }
      const undef = BigInt.asIntN(64, TAG);
      for (let i = oldLen; i < want; i++) dv.setBigInt64(dataOff + i * 8, undef, true);   // 扩容槽补 undefined
      dv.setInt32(off, want, true);
      return numToBits(want);
    },
    bindClasses: (ex, cm) => { exportsRef = ex; classMeta = cm; },
    bindFields,
    bindBump,
    // 供宿主检查用（不在 wasm import 面）
    // 宿主 JS 值 → wasm 句柄位型：复用 bitsOf（string→0x7FFA 写回、array→0x7FFB、bool→num、其它→0x7FF9）。
    // 此前仅 number→numToBits、其余一律 tagHandle → 字符串入参得 0x7FF9 假句柄，wasm 侧 .length/concat
    // 落到 str_len 读垃圾，静默返回 0 / 丢操作数。修复后与 bitsOf/arrWriteback 语义一致。
    _toJS: toJS, _fromJS: (x) => bitsOf(x),
    _handles: handles, _TAG: TAG,
    closure_call: (handle, a0, a1, a2, a3) => closureCall(handle, a0, a1, a2, a3),
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
