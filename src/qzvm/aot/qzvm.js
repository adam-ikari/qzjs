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
const BOOL_HI = 0x7ffcn;                  // 布尔句柄高 16 位（0x7FFC|低32=0/-1：与字符串/数组同族 arith-inert NaN）
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

function makeQzvm(strings) {
  const handles = [undefined, null];      // index 0=undefined、1=null（固定槽，供 wasm 内 null 字面量用 0x7FF9|1）；其余从 2 起

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
  const toJS = (b) => (isStrH(b) ? strRead(b) : isArrH(b) ? arrRead(b) : isH(b) ? handles[idxOf(b)] : isBoolH(b) ? Number(BigInt(b) & 1n) === 1 : bitsToNum(b));
  const tagHandle = (x) => x === undefined ? TAG : x === null ? (TAG | 1n) : (TAG | BigInt(handles.push(x) - 1));   // undefined/null 用固定槽 0/1
  const box = (n) => numToBits(n);
  const boxBool = (b) => (BOOL_HI << 48n) | BigInt(b ? 1 : 0);   // 0x7FFC | 低32=0/1：bool 独立 tag（与 f64 0/1 区分，宿主 toJS 还原真布尔）
  const bool = (b) => boxBool(b);
  let bump = 0, mem = null, memU8 = null, bumpRef = null, exportsRef = null, lamMeta = null, classMeta = null;
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
    const args = [off + 8, a0, a1, a2, a3].slice(0, 1 + meta.n);
    return fn(...args);
  };
  // 数组方法（recv=0x7FFB 原生数组）。回调（map/filter/reduce/…）为闭包句柄，
  // 经 closure_call(handle, v, i, arr) 调用 wasm 侧箭头函数。返回：number/bool→box、
  // string→strWriteback、array→arrWriteback、null/undefined/其它→JS 句柄。
  const doArrMethod = (recv, mid, a0, a1) => {
    const name = strings[mid];
    const arr = () => arrRead(recv);
    const ret = (r) => typeof r === "number" ? box(r) : typeof r === "boolean" ? box(r ? 1 : 0)
                     : typeof r === "string" ? strWriteback(r) : r === undefined || r === null ? tagHandle(r)
                     : Array.isArray(r) ? arrWriteback(r) : tagHandle(r);
    const cbv = (h, v, i, acc) => toJS(closureCall(h, bitsOf(v), box(i), acc === undefined ? recv : acc));
    let r;
    switch (name) {
      case "indexOf":     r = arr().indexOf(toJS(a0)); break;
      case "lastIndexOf": r = arr().lastIndexOf(toJS(a0)); break;
      case "includes":    r = arr().some(x => x === toJS(a0)); break;
      case "slice":       r = arr().slice(toJS(a0), a1 === undefined ? undefined : toJS(a1)); break;
      case "concat":      r = arr().concat(a0 === undefined ? [] : toJS(a0)); break;
      case "join":        r = arr().map(x => x === undefined || x === null ? "" : String(x)).join(a0 === undefined ? "," : String(toJS(a0))); break;
      case "reverse":     r = arrSetInPlace(recv, arr().reverse()); return recv;
      case "shift":       { const a = arr(); r = a.length ? a.shift() : undefined; arrSetInPlace(recv, a); return ret(r); }
      case "unshift":     { const a = arr(); a.unshift(toJS(a0)); arrSetInPlace(recv, a); return box(a.length); }
      case "map":         r = arr().map((v, i) => cbv(a0, v, i)); break;
      case "filter":      r = arr().filter((v, i) => !!cbv(a0, v, i)); break;
      case "reduce":      { const a = arr();
                            const rc = (acc, v, i) => toJS(closureCall(a0, bitsOf(acc), bitsOf(v), box(i)));
                            r = a1 !== undefined ? a.reduce((acc, v, i) => rc(acc, v, i), toJS(a1))
                                                 : a.reduce((acc, v, i) => rc(acc, v, i)); break; }
      case "forEach":     arr().forEach((v, i) => cbv(a0, v, i)); r = undefined; break;
      case "find":        r = arr().find((v, i) => !!cbv(a0, v, i)); break;
      case "findIndex":   r = arr().findIndex((v, i) => !!cbv(a0, v, i)); break;
      case "some":        r = arr().some((v, i) => !!cbv(a0, v, i)); break;
      case "every":       r = arr().every((v, i) => !!cbv(a0, v, i)); break;
      case "sort":        r = arrSetInPlace(recv, arr().sort((x, y) => (a0 !== undefined ? toJS(closureCall(a0, bitsOf(x), bitsOf(y), recv)) : (x > y) - (x < y)))); return recv;
      case "splice":      { const a = arr(); const del = a.splice(toJS(a0), a1 === undefined ? a.length : toJS(a1)); arrSetInPlace(recv, a); r = del; break; }
      case "fill":        { const a = arr(); a.fill(toJS(a0)); arrSetInPlace(recv, a); return recv; }
      default: throw new Error("method_call: 数组无方法 " + name);
    }
    return ret(r);
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
    // 数字（charCodeAt/indexOf/lastIndexOf）→ box；数组（split）→ wasm 原生数组（0x7FFB，
    // 使 .length/索引/push/pop 在 wasm 侧可用）；其它 → JS 句柄。
    if (typeof r === "string") return strWriteback(r);
    if (typeof r === "number") return box(r);
    if (Array.isArray(r)) return arrWriteback(r);
    return tagHandle(r);
  };
  return {
    // POJO 分配：返回 wasm 内存偏移（裸 i32），字段由 wasm i64.store 写入（零跨界）
    alloc: (nbytes) => { const off = bump; bump += nbytes; return off; },
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
    // **：Math.pow 语义（含 NaN^0=1、0^0=1 等特例）；tagged 操作数经 toJS 解引用
    pow:  (a, b) => box(Math.pow(toJS(a), toJS(b))),
    math_pow: (a, b) => Math.pow(a, b),
    math_rem: (a, b) => a % b,
    is_nullish: (a) => { const v = toJS(a); return (v === null || v === undefined) ? 1 : 0; },
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
    // 宽松相等 == / 不等 !=：JS 强制转换（ToPrimitive/ToNumber；1=="1"=true、null==undefined=true）
    eq:   (a, b) => bool(toJS(a) == toJS(b)),
    ne:   (a, b) => bool(toJS(a) != toJS(b)),
    bnot: (a) => box(~(toJS(a) | 0)),
    to_num: (a) => box(+toJS(a)),
    // 真值判定：不经 toJS——类实例/POJO 句柄（0x7FF9|内存偏移）不在 JS handles 表中，
    // 经 toJS 会取到 undefined 而误判 falsy。按 tag 直接判：idx=0=undefined→假；其余查 handles[idx]（null→假、对象→真）。
    truthy: (v) => {
      const u = BigInt.asUintN(64, v), hi = u >> 48n;
      if (hi === TAG_HI) { const idx = Number(u & MASK32); return idx === 0 ? 0 : (handles[idx] ? 1 : 0); }  // 0x7FF9：idx=0=undefined→假；其余查 handles[idx]（null→假、对象→真）
      if (hi === STR_HI) return strRead(v).length ? 1 : 0;          // 0x7FFA：字符串
      if (hi === 0x7ffbn) return 1;                                 // 0x7FFB：wasm 原生数组（恒真；Boolean([])=true）
      if (hi === BOOL_HI) return Number(u & 1n);                    // 0x7FFC：布尔（复用低 32 = 0/1）
      return bitsToNum(v) ? 1 : 0;
    },
    log:  (v) => console.log("  [qz]", typeof toJS(v) === "string" ? toJS(v) : String(toJS(v))),
    // 字符串方法：recv + 方法名 id + 2 参（undefined 句柄 = 缺省）→ 结果字符串句柄。
    str_method: (recv, mid, a0, a1) => doStrMethod(recv, mid, a0, a1),
    // 通用方法调用：字符串 → doStrMethod；数组(0x7FFB) → doArrMethod；类实例（内存 [0]=__cls id）
    // → 沿继承链查 classMeta[clsId].methods[name] 调 wasm 导出方法（self=recv, a0..a3）。
    method_call: (recv, mid, a0, a1, a2, a3) => {
      if (isStrH(recv)) return doStrMethod(recv, mid, a0, a1);
      if (isArrH(recv)) return doArrMethod(recv, mid, a0, a1);
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
    // 数组 .length= 赋值：截断或扩容（扩容量不足换 data 块，新槽补 undefined 句柄 0x7FF9|0）。
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
