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
const HOLE = 0x7ff9000000000002n;         // 数组「洞」（稀疏）：读作 undefined，数组方法跳过，JSON → null
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
  "Date.now": [Date.now, 0], "Date.parse": [Date.parse, 1], "Date.UTC": Date.UTC,
  "Object.prototype": Object.prototype, "Array.prototype": Array.prototype, "String.prototype": String.prototype,
  "Number.prototype": Number.prototype, "Function.prototype": Function.prototype, "Object.getOwnPropertySymbols": Object.getOwnPropertySymbols,
  "String": String, "Number": Number, "Boolean": Boolean, "String.raw": String.raw,
  "parseInt": parseInt, "parseFloat": parseFloat,
  "isNaN": isNaN, "isFinite": isFinite,
  "JSON.stringify": JSON.stringify, "JSON.parse": JSON.parse,
  "Object.keys": Object.keys, "Object.values": Object.values, "Object.entries": Object.entries,
  "Object.keysIn": (o) => { const out = []; if (o != null) for (const k in o) out.push(k); return out; },   // for-in 键（含继承可枚举）
  "Object.freeze": Object.freeze, "Object.seal": Object.seal, "Object.isFrozen": Object.isFrozen, "Object.isSealed": Object.isSealed,
  "Object.preventExtensions": Object.preventExtensions, "Object.isExtensible": Object.isExtensible,
  "Object.getOwnPropertyNames": Object.getOwnPropertyNames, "Object.getPrototypeOf": Object.getPrototypeOf,
  "Object.create": Object.create, "Object.defineProperty": Object.defineProperty,
  // Object.assign 见 builtin 特殊分支（就地写 POJO/实例并返回目标）
  "Object.is": Object.is, "Object.fromEntries": Object.fromEntries,
  "Object.hasOwn": Object.hasOwn, "Object.groupBy": Object.groupBy, "Map.groupBy": Map.groupBy,
  "Object.getOwnPropertyDescriptor": Object.getOwnPropertyDescriptor, "Object.getOwnPropertyDescriptors": Object.getOwnPropertyDescriptors,
  "Array.isArray": Array.isArray, "Array.from": Array.from, "Array.of": Array.of,
  "Number.isInteger": Number.isInteger, "Number.isNaN": Number.isNaN, "Number.isFinite": Number.isFinite,
  "Number.isSafeInteger": Number.isSafeInteger,
  "Number.parseInt": Number.parseInt, "Number.parseFloat": Number.parseFloat,
  "Object.isFrozen": Object.isFrozen, "Object.isSealed": Object.isSealed, "Object.isExtensible": Object.isExtensible,
  "Object.getOwnPropertyNames": Object.getOwnPropertyNames, "Object.getPrototypeOf": Object.getPrototypeOf,
  "Object.seal": Object.seal, "Object.preventExtensions": Object.preventExtensions,
  "Object.create": Object.create, "Object.defineProperty": Object.defineProperty,
  "encodeURIComponent": encodeURIComponent, "decodeURIComponent": decodeURIComponent,
  "encodeURI": encodeURI, "decodeURI": decodeURI,
  "Math.expm1": Math.expm1, "Math.log1p": Math.log1p, "Math.clz32": Math.clz32, "Math.imul": Math.imul,
  "Math.fround": Math.fround, "Math.sinh": Math.sinh, "Math.cosh": Math.cosh, "Math.tanh": Math.tanh,
  "Math.asinh": Math.asinh, "Math.acosh": Math.acosh, "Math.atanh": Math.atanh,
  "String.raw": (t, ...v) => String.raw(t, ...v),
  "String.fromCharCode": String.fromCharCode, "String.fromCodePoint": String.fromCodePoint,
};
// 内建全局常量（属性读非调用）：Math.PI 等。
// 内建构造器（new X(...) / X(...)）：宿主直接调用（返回宿主对象句柄 0x7FFD）。
const BUILTIN_CTORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "EvalError", "URIError", "Map", "Set", "WeakMap", "WeakSet", "Date", "Array", "Object", "RegExp", "Promise"]);

const BUILTIN_CONSTS = {
  "Symbol.iterator": Symbol.iterator, "Symbol.asyncIterator": Symbol.asyncIterator, "Symbol.hasInstance": Symbol.hasInstance,
  "Symbol.isConcatSpreadable": Symbol.isConcatSpreadable, "Symbol.toPrimitive": Symbol.toPrimitive, "Symbol.toStringTag": Symbol.toStringTag,
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
  const cloWrap = (b) => {
    const f = (...args) => toJS(closureCall(b, ...args.map(ret)));
    cloOf.set(f, b);            // 往返：再交回 wasm 时还原闭包句柄
    return f;
  };
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
  const arrOf = new WeakMap();   // JS 数组 → 原 wasm 数组句柄（往返还原，保持别名）
  let fnCacheMap = null;         // 顶层函数名 → 宿主包装句柄（fn_value：同一函数名恒等同一句柄）
  const arrOfHost = new WeakMap();   // **宿主来源**的 JS 数组 → {h, bump}：同一 bump 世代内同一数组恒同一句柄
                                     // （否则 `h.c` 每次读都新建 box → `h.c[0]=v` 写入丢失；见 ASSESSMENT 已知静默项）
  const arrRead = (b) => {
    const off = Number(BigInt(b) & MASK32);
    const dv = new DataView(mem.buffer);
    const len = dv.getInt32(off, true);
    const dataOff = dv.getInt32(off + 8, true);
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
      const raw = BigInt.asUintN(64, dv.getBigInt64(dataOff + i * 8, true));
      if (raw === HOLE) continue;                          // 洞 → JS 侧保持空洞（方法跳过、无键）
      out[i] = toJS(raw);
    }
    arrOf.set(out, b);
    return out;
  };
  const isBoolH = (b) => (BigInt(b) >> 48n) === BOOL_HI;
  const isObjHandle = (u) => { const h = u >> 48n; if (h === TAG_HI) return (u & MASK32) >= 8n; return h === INST_HI || h === HOST_HI || h === CLO_HI || h === 0x7ffbn; };   // 数组：引用同一性
  const statics = new Map();
  let fieldEntries = [];                  // [[name, byteOffset], ...]（bindFields 设；与 emitter _fieldIndex 一致）
  const bindFields = (fields) => { fieldEntries = (fields || []).map((n, i) => [n, (i + 1) * 8]); };
  // POJO/类实例（内存驻留）→ JS 对象物化：按 [0]=size 限定范围，逐字段读（undefined sentinel 跳过）。
  const pojoOf = new WeakMap();   // 物化对象 → { off, mem }（往返还原 POJO 句柄）
  const cloOf = new WeakMap();    // 闭包包装函数 → 闭包句柄
  const materializeUncached = (off, isInst, o, setNow) => {
    syncExtras(); syncPojoCache();
    if (!mem) return o;
    const dv = new DataView(mem.buffer);
    const size = dv.getInt32(off + 4, true);
    syncNonEnum(bumpRef ? Number(bumpRef.value) : -1);
    syncOrder();
    const ord = orderMap.get(off);
    const seen = new Set();
    if (ord) {                                   // 插入序优先（JS 语义：键序 = 插入序；含赋值为 undefined 的键）
      for (const name of ord) {
        if (typeof name === "string" && name.charCodeAt(0) === 35) continue;     // 私有字段不进 Object.keys/JSON
        seen.add(name);
        const acc2 = dynAcc.get(off + "|" + name);
        if (acc2) {                                    // 运行时访问器 → 物化对象上定义 get/set（JSON.stringify 会调 getter）
          const opt = { configurable: true, enumerable: !nonEnum.has(off + "|" + name) };
          if (acc2.g !== undefined) { const gh = acc2.g, ugh = BigInt.asUintN(64, gh); opt.get = ugh >> 48n === CLO_HI ? (() => toJS(closureCall(gh, TAG, TAG, TAG, TAG, undefined, TAG | BigInt(off)))) : (() => handles[idxOf(gh)].call(o)); }
          if (acc2.s !== undefined) { const sh = acc2.s, ush = BigInt.asUintN(64, sh); opt.set = ush >> 48n === CLO_HI ? ((nv) => { closureCall(sh, ret(nv), TAG, TAG, TAG, undefined, TAG | BigInt(off)); }) : ((nv) => handles[idxOf(sh)].call(o, nv)); }
          Object.defineProperty(o, name, opt); setNow.add(name);
          continue;
        }
        const e2 = fieldEntries.find(([n]) => n === name);
        let v;
        if (e2) v = toJS(dv.getBigInt64(off + e2[1], true));
        else { syncExtras(); const x2 = extras.get(off + "|" + name); v = x2 === undefined ? undefined : toJS(x2); }   // 运行期新增键（extras）
        if (v !== undefined && !nonEnum.has(off + "|" + name)) { o[name] = v; setNow.add(name); }
      }
    }
    for (const [name, idx] of fieldEntries) {
      if (idx >= size || seen.has(name)) continue;
      if (typeof name === "string" && name.charCodeAt(0) === 35) continue;        // 私有字段（#类名#名）：非自有可枚举属性（JS 私有槽）
      if (nonEnum.has(off + "|" + name)) continue;   // defineProperty enumerable:false
      const v = toJS(dv.getBigInt64(off + idx, true));
      if (v !== undefined) { o[name] = v; setNow.add(name); }
    }
    for (const [k, v] of extras) {                        // 运行期新增字段
      const bar = k.indexOf("|");
      if (Number(k.slice(0, bar)) !== off) continue;
      const jv = toJS(v);
      if (jv !== undefined) { o[k.slice(bar + 1)] = jv; setNow.add(k.slice(bar + 1)); }
    }
    { const m = symProps.get(off);                       // 符号键属性（own enumerable symbol）
      if (m) for (const [sy, tv] of m) Object.defineProperty(o, sy, { value: toJS(tv), enumerable: true, writable: true, configurable: true }); }
    pojoOf.set(o, { off, mem, isInst });
    if (isInst && mem) {   // 类实例物化对象 → 原型指向类原型（JS 语义：Object.getPrototypeOf(inst) === C.prototype）
      try { const cidP = new DataView(mem.buffer).getInt32(off, true); const cP = classObjImpl(cidP); if (cP && cP.prototype) Object.setPrototypeOf(o, cP.prototype); } catch (_) {}
    }
    // 类方法驱动的强制转换钩子（JSON.stringify 用 toJSON；String()/+ 用 toString/valueOf）——非枚举，不进 Object.keys/JSON
    if (mem && isInst) {                             // 仅实例才有类方法钩子（POJO 的 clsId 恒为 0，会撞第一个类的 id）
      const clsId = new DataView(mem.buffer).getInt32(off, true);
      let c = classMeta && classMeta[clsId];
      const hook = (nm) => {
        let cc = c;
        while (cc) { const m = own(cc.methods, nm); if (m) return m; cc = chainNext(cc); }
        return null;
      };
      const mk = (nm) => {
        const m = hook(nm);
        if (!m) return null;
        return function () { return toJS(exportsRef[m.name](TAG | BigInt(off), TAG, TAG, TAG, TAG)); };
      };
      const tj = mk("toJSON");
      if (tj) Object.defineProperty(o, "toJSON", { value: tj, enumerable: false, configurable: true });
      // @@<Symbol>：类方法（[Symbol.iterator]/[Symbol.toPrimitive]…）→ 物化对象上挂真 Symbol
      for (const sn of ["iterator", "toPrimitive", "toStringTag", "hasInstance", "isConcatSpreadable", "asyncIterator"]) {
        const mm = hook("@@" + sn);
        if (!mm) continue;
        const val = (sn === "toStringTag")
          ? toJS(exportsRef[mm.name](TAG | BigInt(off), TAG, TAG, TAG, TAG))
          : function (...as2) {                                // wasm 方法签名恒 (self, a0..a3)：实参数不足须补 TAG（否则 undefined → BigInt 转换抛错）
              const aa = [TAG | BigInt(off)].concat(as2.slice(0, 4).map(bitsOf));
              while (aa.length < 5) aa.push(TAG);
              return toJS(exportsRef[mm.name](...aa.slice(0, 5)));
            };
        Object.defineProperty(o, Symbol[sn], { value: val, enumerable: false, configurable: true, writable: true });
      }
      const vs = hook("valueOf") ? mk("valueOf") : null;
      const ts2 = hook("toString") ? mk("toString") : null;
      if (vs) Object.defineProperty(o, "valueOf", { value: vs, enumerable: false, configurable: true });
      if (ts2) Object.defineProperty(o, "toString", { value: ts2, enumerable: false, configurable: true });
    }
    return o;
  };
  // 循环结构：同一次物化树内同一 offset 复用同一 JS 对象（否则 o.self=o 会无限递归 → 栈溢出；
  // JS 侧 JSON.stringify 才能抛真实 TypeError("Converting circular structure to JSON")）
  const inProgress = new Set();                    // 正在物化的 offset（自引用 → 返回同一对象）
  const pojoCache = new Map();                     // offset → JS 对象（同一 bump 生命周期内恒等）
  const cacheKeys = new Map();                     // offset → 已写入的键集合（刷新时删陈旧键）
  let pojoCacheAt = -1;
  const syncPojoCache = () => { const v = bumpRef ? Number(bumpRef.value) : -1; if (v < pojoCacheAt) { pojoCache.clear(); cacheKeys.clear(); } pojoCacheAt = v; };
  const materialize = (off, isInst) => {
    let o = pojoCache.get(off);
    if (!o) { o = {}; pojoCache.set(off, o); cacheKeys.set(off, new Set()); }
    if (inProgress.has(off)) return o;                  // 自引用/循环：正在填充 → 直接给同一对象（否则无限递归）
    inProgress.add(off);
    const ks = cacheKeys.get(off);
    const setNow = new Set();
    let out;
    try { out = materializeUncached(off, isInst, o, setNow); } finally { inProgress.delete(off); }
    for (const k of ks) if (!setNow.has(k)) delete o[k];   // 刷新：本轮未写入的旧键 → 删除
    cacheKeys.set(off, setNow);
    return out;
  };
  const isInstH = (b) => (BigInt(b) >> 48n) === INST_HI;
  const isHostH = (b) => (BigInt(b) >> 48n) === HOST_HI;
  // 类实例 → 稳定占位对象（同 offset 同对象，保证 === 自身）；宿主无法访问其实例内存。
  const toJS = (b) => (typeof b === "bigint" && BigInt.asUintN(64, b) === HOLE) ? undefined : (isCloH(b) ? cloWrap(b) : isStrH(b) ? strRead(b) : isArrH(b) ? arrRead(b) : isH(b) ? (idxOf(b) < 8 ? handles[idxOf(b)] : (mem && fieldEntries.length ? materialize(idxOf(b), false) : handles[idxOf(b)])) : isHostH(b) ? handles[idxOf(b)] : isBoolH(b) ? Number(BigInt(b) & 1n) === 1 : isInstH(b) ? (mem && fieldEntries.length ? materialize(idxOf(b), true) : {}) : bitsToNum(b));
  // undefined/null → 0x7FF9|0 / |1（wasm 字面量 sentinel）；其余 JS 值 → 宿主对象句柄 0x7FFD|idx
  const hostOf = new WeakMap();   // JS 对象/函数 → 已有句柄（同一 JS 值恒等同一句柄 → === 语义正确）
  const symOf = new Map();        // Symbol → 句柄（symbol 非对象，WeakMap 不收；well-known 符号为单例，泄漏可忽略）
  const tagHandle = (x) => x === undefined ? TAG : x === null ? (TAG | 1n)
      : (typeof x === "object" || typeof x === "function")
        ? (hostOf.has(x) ? hostOf.get(x) : (() => { const h = HOST_TAG | BigInt(handles.push(x) - 1); hostOf.set(x, h); return h; })())
      : (typeof x === "symbol"
        ? (symOf.has(x) ? symOf.get(x) : (() => { const h = HOST_TAG | BigInt(handles.push(x) - 1); symOf.set(x, h); return h; })())
        : (HOST_TAG | BigInt(handles.push(x) - 1)));
  const box = (n) => numToBits(n);
  const boxBool = (b) => (BOOL_HI << 48n) | BigInt(b ? 1 : 0);   // 0x7FFC | 低32=0/1：bool 独立 tag（与 f64 0/1 区分，宿主 toJS 还原真布尔）
  const bool = (b) => boxBool(b);
  let bump = 0, mem = null, memU8 = null, bumpRef = null, exportsRef = null, lamMeta = null, classMeta = null;
  // 运行期新增字段（POJO/实例上静态未预登记的名字，如 o[k] 中 k 由运行期决定）：
  // 存宿主侧旁表，键 = 内存偏移 + "|" + 字段名；bump 复位（偏移复用）时整体清空。
  const extras = new Map();
  const frozen = new Set(), sealed = new Set(), nonExt = new Set();   // 写保护（offset）
  let protAt = -1;
  const syncProt = () => { const v = bumpRef ? Number(bumpRef.value) : -1; if (v < protAt) { frozen.clear(); sealed.clear(); nonExt.clear(); } protAt = v; };
  const arrMeta = new Map();               // header 偏移 → 附加自有属性（非数字键；正则 exec/match 的 index/input/groups）
  let arrMetaAt = -1;
  const syncArrMeta = () => { const v = bumpRef ? Number(bumpRef.value) : -1; if (v < arrMetaAt) arrMeta.clear(); arrMetaAt = v; };
  const orderMap = new Map();              // POJO/实例偏移 → 插入序名字表（Object.keys/JSON/for-in 用）
  let orderAt = -1;
  const syncOrder = () => { const v = bumpRef ? Number(bumpRef.value) : -1; if (v < orderAt) orderMap.clear(); orderAt = v; };
  const propFlags = new Map();             // off|name → {w, c}（Object.defineProperty 的 writable/configurable）
  let propFlagsAt = -1;
  const syncPropFlags = () => { const v = bumpRef ? Number(bumpRef.value) : -1; if (v < propFlagsAt) propFlags.clear(); propFlagsAt = v; };
  const dynAcc = new Map();                // off|name → {g, s}（运行时 defineProperty 访问器的闭包/宿主函数句柄）
  let dynAccAt = -1;
  const syncDynAcc = () => { const v = bumpRef ? Number(bumpRef.value) : -1; if (v < dynAccAt) dynAcc.clear(); dynAccAt = v; };
  const symProps = new Map();                // off → Map<symbol, tagged>（POJO/实例的符号键属性）
  let symAt = -1;
  const syncSym = () => { const v = bumpRef ? Number(bumpRef.value) : -1; if (v < symAt) symProps.clear(); symAt = v; };
  const symBucket = (off) => { syncSym(); let m = symProps.get(off); if (!m) { m = new Map(); symProps.set(off, m); } return m; };
  const nonEnum = new Map();                 // 键 = 偏移 + "|" + 字段名（defineProperty enumerable:false）
  let nonEnumAt = -1;
  const syncNonEnum = (v) => { if (v < nonEnumAt) nonEnum.clear(); nonEnumAt = v; };
  let extrasAt = -1;
  // bump 复位（值变小）→ 偏移被复用 → 旁表整体失效；仅「变小」才清（同一次调用内 bump 单调增）
  const syncExtras = () => { const v = bumpRef ? Number(bumpRef.value) : -1; if (v < extrasAt) extras.clear(); extrasAt = v; };
  if (opts && opts.fields) bindFields(opts.fields);   // 便于宿主物化 POJO/实例（等价 bindFields）
  const bindMem = (m) => { mem = m; memU8 = new Uint8Array(m.buffer); };
  // 跨函数 throw 的宿主侧出口：调用导出后若 __err≠0 → 取出并抛出，模拟 JS 异常
  // 宿主侧抛出：设 __err（经导出的 __set_err），产物内调用点检查后转入其 catch（JS 可捕获）
  const throwValue = (v) => { if (exportsRef && exportsRef.__set_err) exportsRef.__set_err(bitsOf(v)); };
  let _modInitDone = false;
  const tryRunModuleInit = () => {                      // 模块初始化：宿主各 bind 完成后调用一次（幂等）
    if (_modInitDone) return;
    _modInitDone = true;
    const f = exportsRef && exportsRef.__module_init;
    if (typeof f === "function") { try { f(); } catch (err) { throwValue(err); } }
  };
  const takeErr = () => {
    if (!exportsRef || !exportsRef.__err) return;
    const v = exportsRef.__err.value;
    if (v !== 0n) { exportsRef.__err.value = 0n; throw toJS(v); }
  };
  const bindBump = (g) => { bumpRef = g; };
  // 宿主侧 bump 分配：与 wasm 侧 STR_BASE(8MiB) 同界；越界抛错（绝不静默覆盖字面量段）。
  const ARENA_END = 16 << 20;          // 与 emitter 的 STR_BASE 一致（bump 堆上限）
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
  // 原型污染防护：classMeta 的 methods/getters/setters 是对象字面量 → 必须只认自有键
  // （否则 methods["valueOf"] 会命中原型上的 Object.prototype.valueOf → m.name=undefined/"valueOf" 崩溃）
  // Function.prototype.call 的 thisArg → JS 值（宿主对象原样；其它 undefined）
  const thisArgOf = (h) => (h === undefined ? undefined : toJS(h));   // call/apply 的 thisArg：任意句柄 → JS 值（POJO/实例需物化）
  // 闭包句柄 → 可重入宿主包装（带 length/name，便于宿主内省；调用即 closureCall）
  const wrapCb = (f) => (f.__qzCb ? f.__qzCb : Object.defineProperty(f, "__qzCb", { value: (...xs) => f(...xs), enumerable: false }), f.__qzCb);
  const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k)) ? o[k] : undefined;
  const bitsOf = (e) => Array.isArray(e) && arrOf.has(e) ? arrOf.get(e)   // 来自 wasm 的数组 → 原句柄（别名）
                     : typeof e === "function" && cloOf.has(e) ? cloOf.get(e)
                     : (e !== null && typeof e === "object" && pojoOf.has(e) && pojoOf.get(e).mem === mem)
                       ? ((pojoOf.get(e).isInst ? (0x7ffen << 48n) : TAG) | BigInt(pojoOf.get(e).off))   // 实例 → 实例 tag（回调里方法调用需要）
                     : typeof e === "string" ? strWriteback(e)
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
    { const ks = Object.keys(js);                 // 数字索引之外的属性（exec 的 index/input…）→ 旁表
      if (ks.some(k => !/^\d+$/.test(k))) { syncArrMeta(); const o2 = {}; for (const k of ks) if (!/^\d+$/.test(k)) o2[k] = js[k]; arrMeta.set(start, o2); } }
    const dataOff = start + 16;
    const dv = new DataView(mem.buffer);
    dv.setInt32(start, N, true);
    dv.setInt32(start + 4, N, true);
    dv.setInt32(start + 8, dataOff, true);
    dv.setInt32(start + 12, 0, true);
    for (let i = 0; i < N; i++) dv.setBigInt64(dataOff + i * 8, (i in js) ? BigInt.asIntN(64, bitsOf(js[i])) : BigInt.asIntN(64, HOLE), true);
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
    for (let i = 0; i < N; i++) dv.setBigInt64(dataOff + i * 8, (i in js) ? BigInt.asIntN(64, bitsOf(js[i])) : BigInt.asIntN(64, HOLE), true);
    return recv;
  };
  // 闭包调用：handle → 堆对象 [funcidx:i32][nCaps:i32][cell×N i64]。
  // blk = off+8（cell 起点），按 lamMeta[funcidx]={name,n} 调 wasm 导出 __lam_N。
  const closureCall = (handle, a0, a1, a2, a3, ovfArr, recv) => {
    if ((BigInt.asUintN(64, handle) >> 48n) === HOST_HI) {         // 宿主函数句柄（顶层函数作值/回调）→ 直接调用
      const hf = handles[idxOf(handle)];
      if (typeof hf !== "function") throw new Error("closure_call: 非函数值");
      const selfArg = (recv === undefined || recv === TAG) ? undefined : toJS(recv);   // thisArg（map/filter 第 2 实参、.call 的 receiver）→ JS this
      return ret(hf.apply(selfArg, [a0, a1, a2, a3].filter(givenSlot).map(toJS)));   // 只传真传了的实参
    }
    const off = Number(BigInt.asUintN(64, handle) & 0xffff_ffffn);
    const funcidx = new DataView(mem.buffer).getUint32(off, true);   // 免 4 对齐（bump 偏移可非 4 倍数）
    const meta = lamMeta && lamMeta[funcidx];
    if (!meta) throw new Error("closure_call: 未知 funcidx " + funcidx);
    const fn = exportsRef[meta.name];
    const blk = new DataView(mem.buffer).getInt32(off + 4, true);   // env 索引（0 = 无捕获）
    let args;
    const hasEx = ovfArr !== undefined && ovfArr !== TAG;      // 调用点是否显式传了溢出实参数组
    if (meta.synthThis) {                                       // 合成方法箭头 / 带 `this` 形参的闭包：槽 0 = receiver
      const rv = recv === undefined ? TAG : recv;
      if (hasEx) { const ex0 = toJS(ovfArr) || []; const s0 = [a0, a1, a2, a3];
        ovfArr = arrWriteback([a0, a1, a2, a3].concat(ex0).slice(0));   // 原样透传（下面按 slots 重排）
        a0 = rv; a1 = s0[0]; a2 = s0[1]; a3 = s0[2];
        ovfArr = arrWriteback([s0[2], s0[3]].concat(ex0).map(x => x === undefined ? TAG : x).slice(2));
      } else { a3 = a2; a2 = a1; a1 = a0; a0 = rv; }
    }
    if (hasEx) {
      // 新约定：slots a0..a3 = 实参 0..3（未传补 TAG），ovfArr = 实参 3.. 的数组 → 两种被调均可还原
      const ex = toJS(ovfArr) || [];
      const slots = [a0, a1, a2, a3];
      const nFix = meta.rest ? meta.n - 1 : meta.n;
      args = [blk];
      for (let i = 0; i < Math.min(nFix, 4); i++) args.push(slots[i] === undefined ? TAG : slots[i]);
      if (meta.rest) {                                // rest：固定参之外的实参（slots 尾部 + 溢出数组）打包成数组
        const tail = [];
        for (let i = nFix; i < 4; i++) if (slots[i] !== undefined && slots[i] !== TAG) tail.push(toJS(slots[i]));
        for (let i = (meta.synthThis ? 0 : 1); i < ex.length; i++) tail.push(ex[i]);   // synthThis 时 receiver 由宿主前置 → slots 已右移，ex[0]（实参 3）不再在 slots 中
                                                                                     // 否则 ex[0] = 实参 3（已在 slots）→ 跳过
        args.push(arrWriteback(tail));
      } else {
        for (let i = 4; i < meta.n; i++) args.push((i - 3) < ex.length ? bitsOf(ex[i - 3]) : TAG);   // ex[0] = 实参 3（已在 slots）
      }
    } else if (meta.n > 4) {
      const ex = (a3 === undefined || a3 === TAG) ? [] : (toJS(a3) || []);
      args = [blk, a0, a1, a2];
      if (meta.rest) args.push(arrWriteback(ex.slice(meta.n - 4)));
      else for (let i = 0; i < meta.n - 3; i++) args.push(i < ex.length ? bitsOf(ex[i]) : TAG);
    } else if (meta.rest) {
      // 惯例（实测）：调用方传 [固定参…, rest 数组, 余参…]。判定「已打包」= a[nFix] 是 wasm 数组(0x7FFB)。
      // 未打包（如箭头 const 被直接调用）→ 固定参 + 剩余打包成数组。
      const nFix0 = meta.n - 1;
      const slots0 = [a0, a1, a2, a3];
      const noneMore0 = (x) => x === undefined || x === TAG;
      const isArrH = (x) => !noneMore0(x) && (BigInt.asUintN(64, x) >> 48n) === 0x7ffbn;
      const packed = nFix0 >= 0 && nFix0 < 4 && isArrH(slots0[nFix0]);
      if (packed) {
        args = [blk];
        for (let i = 0; i < Math.min(nFix0, 4); i++) args.push(slots0[i] === undefined ? TAG : slots0[i]);
        args.push(slots0[nFix0]);
      } else {
        args = [blk];
        for (let i = 0; i < Math.min(nFix0, 4); i++) args.push(slots0[i] === undefined ? TAG : slots0[i]);
        const tail0 = [];
        for (let i = nFix0; i < 4; i++) if (!noneMore0(slots0[i])) tail0.push(toJS(slots0[i]));
        args.push(arrWriteback(tail0));
      }
    } else {
      args = [blk, a0, a1, a2, a3].slice(0, 1 + meta.n);
    }
    return fn(...args);
  };
  // JS 值 → tagged 位型（宿主回退返回用）：number→box、bool→boxBool、string→0x7FFA、
  // array→0x7FFB、null/undefined→固定槽、其它→0x7FF9 句柄。
  const ret = (r) => typeof r === "number" ? box(r) : typeof r === "boolean" ? boxBool(r)
                   : typeof r === "string" ? strWriteback(r) : r === undefined || r === null ? tagHandle(r)
                   : Array.isArray(r) ? (arrOf.has(r) ? arrOf.get(r)                        // wasm 数组回程 → 原句柄（别名语义）
                     : (() => { const curB = bumpRef ? Number(bumpRef.value) : -1;
                                const e0 = arrOfHost.get(r);
                                if (e0 && e0.bump <= curB) return e0.h;                     // 同一世代：同一 JS 数组 → 同一句柄
                                const h0 = arrWriteback(r);
                                arrOfHost.set(r, { h: h0, bump: curB });
                                return h0; })())
                   : (r !== null && typeof r === "object" && pojoOf.has(r) && pojoOf.get(r).mem === mem)
                     ? ((pojoOf.get(r).isInst ? (0x7ffen << 48n) : TAG) | BigInt(pojoOf.get(r).off))   // 物化过的 POJO/实例 → 还原原句柄（find/pop/at 等返回元素时保持身份）
                   : tagHandle(r);
  // 数组方法（recv=0x7FFB 原生数组）。回调（map/filter/reduce/…）为闭包句柄，
  // 经 closure_call(handle, v, i, arr) 调用 wasm 侧箭头函数。
  // 4 参槽中未传的实参由 emitter 填 undefined 句柄（0x7FF9|0）；变参方法（concat）据此过滤。
  const givenSlot = (x) => {
    if (x === undefined) return false;
    const u = BigInt.asUintN(64, x);
    return !(u >> 48n === TAG_HI && (u & 0xffff_ffffn) <= 1n);
  };
  // 数组迭代器（values/keys/entries）：惰性读 wasm 内存 → 迭代期间的 push/length 变化可见（JS 迭代的是活数组）
  // —— 类名作值：clsId → 缓存 JS 构造器（prototype 链 + 静态方法（含 @@hasInstance））——
  const classObjs = new Map();             // clsId → JS 构造器对象
  const instanceById = (obj, clsId) => {     // 原型链判定（@@hasInstance 优先，含运行时父链）→ tagged bool
    let cc = classMeta && classMeta[clsId];
    while (cc) {
      const sm = cc.staticMethods && cc.staticMethods["@@hasInstance"];
      if (sm && exportsRef) { const fn0 = exportsRef[sm.name];
        if (typeof fn0 === "function") return boxBool(!!toJS(fn0(TAG, obj, TAG, TAG, TAG))); }
      cc = chainNext(cc);
    }
    const u = BigInt.asUintN(64, obj);
    if ((u >> 48n) !== INST_HI) return boxBool(false);
    const off = Number(u & MASK32);
    if (!mem || off + 4 > mem.buffer.byteLength) return boxBool(false);
    let c = new DataView(mem.buffer).getInt32(off, true);
    while (c !== null && c !== undefined) {
      if (c === clsId) return boxBool(true);
      const m = classMeta && classMeta[c];
      c = classRuntimeParent.has(c) ? classRuntimeParent.get(c) : (m ? m.parent : null);
    }
    return boxBool(false);
  };
  const classHandles = new Map();          // clsId → 宿主句柄（缓存 → === 同一）
  const builtinValCache = new Map();       // 内建名 → 句柄缓存（=== 稳定）
  const qzBuiltinValue = (n0) => {         // 取内建全局的宿主句柄（缓存）
    let h0 = builtinValCache.get(n0);
    if (h0 !== undefined) return h0;
    const v0 = globalThis[n0];
    if (v0 === undefined) return TAG;
    h0 = tagHandle(v0); builtinValCache.set(n0, h0);
    return h0;
  };
  const classRuntimeParent = new Map();    // clsId → 运行时父 clsId（动态 extends / mixin）
  const chainNext = (cc) => {              // 类链下一跳：优先运行时父（mixin），否则静态 parent
    if (!cc) return null;
    const rp = classRuntimeParent.get(cc.id);
    if (rp !== undefined) return classMeta[rp] || null;
    return cc.parent != null ? (classMeta[cc.parent] || null) : null;
  };
  const classObjImpl = (clsId, baseOv) => {
    let o = classObjs.get(clsId);
    if (o) return o;
    const meta = classMeta && classMeta[clsId];
    if (!meta) return null;
    const pc = baseOv !== undefined ? baseOv : (meta.parent != null ? classObjImpl(meta.parent) : null);
    const ctor = function (...as3) { return buildInstance(clsId, as3); };
    Object.defineProperty(ctor, "__qzClsId", { value: clsId, configurable: true });
    Object.setPrototypeOf(ctor, pc || Function.prototype);
    Object.defineProperty(ctor, "name", { value: meta.name || "C", configurable: true });
    const proto = Object.create(pc ? pc.prototype : Object.prototype);
    Object.defineProperty(proto, "constructor", { value: ctor, enumerable: false, writable: true, configurable: true });
    ctor.prototype = proto;
    if (classHandles.size >= 0) for (const nm of Object.keys(meta.staticMethods || {})) {
      const sm = meta.staticMethods[nm];
      if (!sm || !exportsRef || typeof exportsRef[sm.name] !== "function") continue;
      try {
        Object.defineProperty(ctor, nm === "@@hasInstance" ? Symbol.hasInstance : nm, {
          value: (...as) => toJS(exportsRef[sm.name](TAG, ...as.slice(0, 4).map(bitsOf), TAG)),
          writable: true, configurable: true, enumerable: false });
      } catch (_) {}
    }
    if (classHandles.size >= 0) {   // 实例方法/访问器挂到 prototype（JS 语义：C.prototype.get / Object.getOwnPropertyNames(C.prototype)）
      const mkMeth = (exName) => function (...as) {
        const fn = exportsRef && exportsRef[exName];
        if (typeof fn !== "function") return undefined;
        const aa = [0, 1, 2, 3].map(i => (i < as.length && as[i] !== undefined) ? bitsOf(as[i]) : TAG);
        return toJS(fn(bitsOf(this), aa[0], aa[1], aa[2], aa[3]));
      };
      for (const nm of Object.keys(meta.methods || {})) {
        const mm = meta.methods[nm];
        if (!mm || !exportsRef || typeof exportsRef[mm.name] !== "function") continue;
        try { Object.defineProperty(proto, nm, { value: mkMeth(mm.name), writable: true, configurable: true, enumerable: false }); } catch (_) {}
      }
      for (const nm of Object.keys(meta.getters || {})) {
        const gg = meta.getters[nm], ss = (meta.setters || {})[nm];
        try {
          Object.defineProperty(proto, nm, {
            get: gg && exportsRef && exportsRef[gg.name] ? function () { return toJS(exportsRef[gg.name](bitsOf(this), TAG, TAG, TAG, TAG)); } : undefined,
            set: ss && exportsRef && exportsRef[ss.name] ? function (v) { return toJS(exportsRef[ss.name](bitsOf(this), bitsOf(v), TAG, TAG, TAG)); } : undefined,
            configurable: true, enumerable: false });
        } catch (_) {}
      }
    }
    classObjs.set(clsId, ctor);
    return ctor;
  };
  const buildInstance = (clsId, args) => {                    // Reflect.construct / 宿主侧构造 → wasm 实例句柄
    const meta = classMeta && classMeta[clsId];
    if (!meta || !mem) return TAG;
    const size = Math.max(meta.size || 16, 16);
    const off = bumpAlloc(size);
    const dv = new DataView(mem.buffer);
    dv.setInt32(off, clsId, true);
    dv.setInt32(off + 4, size, true);                          // [4]=size（供宿主物化，与 emitter _emitNewCall 一致）
    for (let k = 8; k < size; k += 8) dv.setBigInt64(off + k, TAG, true);   // 字段槽 = undefined
    const self = (0x7ffen << 48n) | BigInt(off);
    const fnC = exportsRef && meta.ctor && exportsRef[meta.ctor];
    if (typeof fnC === "function") {
      const as4 = (args || []).slice(0, 4).map(x => bitsOf(x));
      while (as4.length < 4) as4.push(TAG);
      fnC(self, as4[0], as4[1], as4[2], as4[3]);
    }
    return self;
  };
  const classValueImpl = (clsId) => {
    let h = classHandles.get(clsId);
    if (h !== undefined) return h;
    const c = classObjImpl(clsId);
    if (!c) return TAG;
    h = ret(c);
    classHandles.set(clsId, h);
    return h;
  };
  const liveIter = (recv, kind) => {
    let i = 0;
    const it = {
      next() {
        const off = Number(BigInt.asUintN(64, recv) & MASK32);
        const dv = new DataView(mem.buffer);
        const len = dv.getInt32(off, true);
        if (i >= len) return { value: undefined, done: true };
        const dataOff = dv.getInt32(off + 8, true);
        const raw = BigInt.asUintN(64, dv.getBigInt64(dataOff + i * 8, true));
        const idx = i++;
        if (kind === "keys") return { value: idx, done: false };
        if (raw === HOLE) return { value: undefined, done: false };
        const v = toJS(raw);
        return { value: kind === "values" ? v : [idx, v], done: false };
      },
      [Symbol.iterator]() { return this; },
    };
    return tagHandle(it);
  };
  const doArrMethod = (recv, mid, a0, a1, a2, a3) => {
    const extra = (first) => [a0, a1, a2, a3].slice(first).filter(givenSlot).map(toJS);
    const name = strings[mid];
    const arr = () => arrRead(recv);
    const cbv = (h, v, i, acc) => toJS(closureCall(h, bitsOf(v), box(i), acc === undefined ? recv : acc, TAG, undefined, givenSlot(a1) ? a1 : undefined));   // thisArg（map/filter…第 2 实参）→ 闭包 receiver（合成方法 lambda 的 this）
    let r;
    switch (name) {
      case "indexOf":     r = givenSlot(a1) ? arr().indexOf(toJS(a0), toJS(a1)) : arr().indexOf(toJS(a0)); break;   // 未传 fromIndex 必须**省略实参**（传 undefined 语义不同）
      case "lastIndexOf": r = givenSlot(a1) ? arr().lastIndexOf(toJS(a0), toJS(a1)) : arr().lastIndexOf(toJS(a0)); break;
      case "includes":    r = givenSlot(a1) ? arr().includes(toJS(a0), toJS(a1)) : arr().includes(toJS(a0)); break;   // SameValueZero；不跳洞；支持 fromIndex
      case "findLast":    { const a2 = arr(); const v = toJS(a0); r = a2.slice().reverse().find((x, i) => !!toJS(closureCall(a0, bitsOf(x), box(a2.length - 1 - i), TAG))); break; }
      case "findLastIndex": { const a2 = arr(); let idx = -1; for (let i = a2.length - 1; i >= 0; i--) { if (toJS(closureCall(a0, bitsOf(a2[i]), box(i), TAG))) { idx = i; break; } } r = idx; break; }
      case "slice":       r = arr().slice(toJS(a0), givenSlot(a1) ? toJS(a1) : undefined); break;
      case "concat":      r = arr().concat(...extra(0)); break;
      case "join":        r = arr().map(x => x === undefined || x === null ? "" : String(x)).join(toJS(a0) === undefined ? "," : String(toJS(a0))); break;
      case "reverse":     r = arrSetInPlace(recv, arr().reverse()); return recv;
      case "shift":       { const a = arr(); r = a.length ? a.shift() : undefined; arrSetInPlace(recv, a); return ret(r); }
      case "unshift":     { const a = arr(); a.unshift(toJS(a0)); arrSetInPlace(recv, a); return box(a.length); }
      case "map":         r = arr().map((v, i) => cbv(a0, v, i)); break;
      case "filter":      r = arr().filter((v, i) => !!cbv(a0, v, i)); break;
      case "reduce":      { const a = arr();
                            const rc = (acc, v, i) => toJS(closureCall(a0, bitsOf(acc), bitsOf(v), box(i)));
                            if (a.length === 0 && toJS(a1) === undefined) { throwValue(new TypeError("Reduce of empty array with no initial value")); return TAG; }
                            r = toJS(a1) !== undefined ? a.reduce((acc, v, i) => rc(acc, v, i), toJS(a1))
                                                 : a.reduce((acc, v, i) => rc(acc, v, i)); break; }
      case "forEach":     arr().forEach((v, i) => cbv(a0, v, i)); r = undefined; break;
      case "find":        r = arr().find((v, i) => !!cbv(a0, v, i)); break;
      case "findIndex":   r = arr().findIndex((v, i) => !!cbv(a0, v, i)); break;
      case "some":        r = arr().some((v, i) => !!cbv(a0, v, i)); break;
      case "every":       r = arr().every((v, i) => !!cbv(a0, v, i)); break;
      case "sort":        r = arrSetInPlace(recv, toJS(a0) !== undefined ? arr().sort((x, y) => toJS(closureCall(a0, bitsOf(x), bitsOf(y), recv))) : arr().sort()); return recv;   // 无比较器 → JS 默认字典序
      case "splice":      { const a = arr(); const del = a.splice(toJS(a0), toJS(a1) === undefined ? a.length : toJS(a1)); arrSetInPlace(recv, a); r = del; break; }
      case "flat":         r = arr().flat(toJS(a0) === undefined ? 1 : toJS(a0)); break;
      case "flatMap":      r = arr().flatMap((v, i) => cbv(a0, v, i)); break;   // cbv 已返回 JS 值，勿再 toJS
      case "reduceRight":  { const a2 = arr();
                             const rc2 = (acc, v, i) => toJS(closureCall(a0, bitsOf(acc), bitsOf(v), box(i)));
                             r = toJS(a1) !== undefined ? a2.reduceRight((acc, v, i) => rc2(acc, v, i), toJS(a1))
                                                         : a2.reduceRight((acc, v, i) => rc2(acc, v, i)); break; }
      case "at":           { const a2 = arr(); const i = Math.trunc(toJS(a0)); r = a2[i < 0 ? a2.length + i : i]; break; }
      case "toReversed":   r = arr().slice().reverse(); break;
      case "toSpliced":   { const src = arr(); const st2 = toJS(a0);                     // 原数组不变（返回新数组）
                            const items = [a2, a3].slice(0, 2).filter(givenSlot).map(toJS);
                            r = src.slice(); r.splice(st2, givenSlot(a1) ? toJS(a1) : src.length - (st2 < 0 ? Math.max(0, src.length + st2) : Math.min(st2, src.length)), ...items); break; }
      case "with":         r = toJS(a0) < 0 ? arr().slice(0, arr().length + toJS(a0)).concat([toJS(a1)], arr().slice(arr().length + toJS(a0) + 1)) : arr().slice(0, toJS(a0)).concat([toJS(a1)], arr().slice(toJS(a0) + 1)); break;
      case "entries":      return liveIter(recv, "entries");   // 惰性读内存：迭代期间的 push/length 变化可见（JS 迭代活数组）
      case "keys":         return liveIter(recv, "keys");
      case "values":       return liveIter(recv, "values");
      case "copyWithin":   { const a3 = arr(); a3.copyWithin(toJS(a0), a1 === undefined ? 0 : toJS(a1), a2 === undefined ? a3.length : toJS(a2)); arrSetInPlace(recv, a3); return recv; }
      case "toString":     r = arr().map(x => x === undefined || x === null ? "" : String(x)).join(","); break;
      case "toSorted":     r = givenSlot(a0) ? arr().slice().sort((x, y) => toJS(closureCall(a0, bitsOf(x), bitsOf(y), recv))) : arr().slice().sort(); break;
      case "fill":        { const a = arr(); const st = givenSlot(a1) ? toJS(a1) : 0, en = givenSlot(a2) ? toJS(a2) : a.length; a.fill(toJS(a0), st, en); arrSetInPlace(recv, a); return recv; }
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
      case "toString":     r = s; break;
      case "valueOf":      r = s; break;
      case "trimLeft":     r = s.trimStart(); break;
      case "trimRight":    r = s.trimEnd(); break;
      case "charCodeAt":   r = s.charCodeAt(arg(a0)); break;
      case "indexOf":      r = s.indexOf(String(arg(a0)), a1 === undefined ? undefined : arg(a1)); break;
      case "lastIndexOf":  r = s.lastIndexOf(String(arg(a0)), a1 === undefined ? undefined : arg(a1)); break;
      case "slice":        r = s.slice(arg(a0), a1 === undefined ? undefined : arg(a1)); break;
      case "substring":    r = s.substring(arg(a0), a1 === undefined ? undefined : arg(a1)); break;
      case "substr":       r = s.substr(arg(a0), a1 === undefined ? undefined : arg(a1)); break;
      case "toUpperCase":  r = s.toUpperCase(); break;
      case "toLowerCase":  r = s.toLowerCase(); break;
      case "toLocaleUpperCase": r = s.toLocaleUpperCase(); break;
      case "toLocaleLowerCase": r = s.toLocaleLowerCase(); break;
      case "localeCompare": r = s.localeCompare(String(arg(a0))); break;
      case "normalize":    r = s.normalize(arg(a0) === undefined ? "NFC" : String(arg(a0))); break;
      case "replaceAll":   { const pat = toJS(a0); const rep2 = toJS(a1);
                             r = s.replaceAll(pat instanceof RegExp ? pat : String(pat), typeof rep2 === "function" ? wrapCb(rep2) : String(rep2)); break; }
      case "search":       r = s.search(toJS(a0)); break;
      case "match":        { const x = s.match(toJS(a0)); r = x === null ? null : x; break; }
      case "at":           { const i = Math.trunc(arg(a0)); r = i < 0 ? s[s.length + i] : s[i]; break; }
      case "trim":         r = s.trim(); break;
      case "trimStart":    r = s.trimStart(); break;
      case "trimEnd":      r = s.trimEnd(); break;
      case "repeat":       r = s.repeat(arg(a0)); break;
      case "startsWith":   r = givenSlot(a1) ? s.startsWith(String(arg(a0)), Number(arg(a1))) : s.startsWith(String(arg(a0))); break;   // 第 2 实参 = fromIndex
      case "endsWith":     r = givenSlot(a1) ? s.endsWith(String(arg(a0)), Number(arg(a1))) : s.endsWith(String(arg(a0))); break;   // 第 2 实参 = endPosition
      case "includes":     r = givenSlot(a1) ? s.includes(String(arg(a0)), Number(arg(a1))) : s.includes(String(arg(a0))); break;   // 第 2 实参 = fromIndex（与数组 includes 一致）
      case "padStart":     r = s.padStart(arg(a0), arg(a1)); break;
      case "padEnd":       r = s.padEnd(arg(a0), arg(a1)); break;
      case "replace":      { const pat = toJS(a0);   // 正则模式原样传（String() 会毁掉 RegExp / 回调函数）
                             const rep2 = toJS(a1);
                             r = s.replace(pat instanceof RegExp ? pat : String(pat), typeof rep2 === "function" ? wrapCb(rep2) : String(rep2)); break; }
      case "split":        { const sep = toJS(a0);
                             const lim = givenSlot(a1) ? toJS(a1) : undefined;
                             r = s.split(sep instanceof RegExp ? sep : String(sep), lim); break; }
      case "concat":       r = s.concat(...extra().map(String)); break;
      case "at":           { const i = Math.trunc(arg(a0)); r = s[i < 0 ? s.length + i : i]; break; }
      case "localeCompare": r = s.localeCompare(String(arg(a0))); break;
      case "normalize":    r = arg(a0) === undefined ? s.normalize() : s.normalize(String(arg(a0))); break;
      case "codePointAt":  r = s.codePointAt(arg(a0)); break;
      case "match":        r = s.match(toJS(a0)); break;
      case "search":       r = s.search(toJS(a0)); break;
      case "matchAll":     r = Array.from(s.matchAll(toJS(a0))); break;
      case "replaceAll":   r = s.replaceAll(toJS(a0), String(arg(a1))); break;
      case "charAt":       r = s.charAt(arg(a0)); break;
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
  // 写保护（Object.freeze/seal/preventExtensions）：strict 语义抛 TypeError（经 __err 转入 wasm catch）
  const protGuard = (off, name) => {
    syncProt();
    syncPropFlags();
    if ((propFlags.get(off + "|" + name) || {}).w === false) { throwValue(new TypeError("Cannot assign to read only property '" + name + "' of object")); return true; }
    if (frozen.has(off) || sealed.has(off) || nonExt.has(off)) {
      if (frozen.has(off)) { throwValue(new TypeError("Cannot assign to read only property '" + name + "' of object")); return true; }
      const e = fieldEntries.find(([n]) => n === name);
      const cur = e && mem ? new DataView(mem.buffer).getBigInt64(off + e[1], true) : TAG;
      if (BigInt.asUintN(64, cur) === TAG) { throwValue(new TypeError("Cannot add property " + name + ", object is not extensible")); return true; }
    }
    return false;
  };
  // seal/freeze：把对象**既有**属性的 configurable/writable 写入标志表（描述符报告与写保护一致）
  const markAllProps = (off, w, c) => {
    syncPropFlags();
    const size = mem ? new DataView(mem.buffer).getInt32(off + 4, true) : 0;
    for (const [name, idx] of fieldEntries) {
      if (idx + 8 > size) continue;
      const cur = propFlags.get(off + "|" + name) || {};
      propFlags.set(off + "|" + name, { w: w === undefined ? cur.w : w, c: c === undefined ? cur.c : c });
    }
    syncExtras();
    for (const [k] of extras) {
      const bar = k.indexOf("|");
      if (Number(k.slice(0, bar)) !== off) continue;
      const cur = propFlags.get(k) || {};
      propFlags.set(k, { w: w === undefined ? cur.w : w, c: c === undefined ? cur.c : c });
    }
  };
  const setIndexImpl = (o, k, v) => {
      const u = BigInt.asUintN(64, o), hi = u >> 48n, off = Number(u & MASK32);
      if (hi === 0x7ffbn) {                            // wasm 数组 + 数字形态字符串键 → 按索引写（JS：a["0"] ≡ a[0]）
        const kk = toJS(k);
        if (typeof kk === "string" && /^\d+$/.test(kk)) {
          const a2 = arrRead(o), i2 = Number(kk);
          while (a2.length <= i2) a2.push(undefined);
          a2[i2] = toJS(v);
          arrSetInPlace(o, a2);
          return;
        }
        if (typeof kk === "string") {                  // 自定义字符串键（非索引）→ arrMeta 旁表（与既有读取路径一致）+ 插入序表（Object.keys/for-in）
          if (protGuard(off, kk)) return;
          syncArrMeta(); { let am = arrMeta.get(off); if (!am) { am = {}; arrMeta.set(off, am); } am[kk] = toJS(v); }
          syncOrder(); { let l = orderMap.get(off); if (!l) { l = []; orderMap.set(off, l); } if (l.indexOf(kk) < 0) l.push(kk); }
          return;
        }
      }
      if (hi === TAG_HI || hi === INST_HI) {
        if (off < 8) { handles[off] = toJS(v); return; }
        { const kk = toJS(k); if (typeof kk === "symbol") { symBucket(off).set(kk, v); return; } }
        const name = String(toJS(k));
        { syncDynAcc(); const acc = dynAcc.get(off + "|" + name);            // 运行时 setter（o[k] = v）
          if (acc) { if (acc.s === undefined) return;
            const us = BigInt.asUintN(64, acc.s);
            if (us >> 48n === CLO_HI) closureCall(acc.s, v, TAG, TAG, TAG, undefined, o); else handles[idxOf(acc.s)].call(toJS(o), toJS(v));
            return; } }
        if (protGuard(off, name)) return;
        const e = fieldEntries.find(([n]) => n === name);
        if (!e || !mem) { syncExtras(); extras.set(off + "|" + name, v); return; }   // 运行期新增字段
        new DataView(mem.buffer).setBigInt64(off + e[1], v, true);
        return;
      }
      if (hi === HOST_HI) { handles[off][toJS(k)] = toJS(v); return; }   // 键原样（符号键可用）
      toJS(o)[toJS(k)] = toJS(v);
  };
  return {
    // POJO 分配：返回 wasm 内存偏移（裸 i32），字段由 wasm i64.store 写入（零跨界）
    alloc: (nbytes) => { const off = bump; bump += nbytes; return off; },
    bindMem,
    object_new: () => tagHandle({}),
    object_set: (o, k, v) => { handles[idxOf(o)][strings[k]] = toJS(v); },
    // 值经 ret（string→0x7FFA、array→0x7FFB、其它→0x7FFD）；**数组保持宿主句柄** → 元素读/写就地作用于真实
    // JS 数组（否则 wasm box 与宿主数组分离：h.c[0]=v 写入 box，JSON.stringify(h) 仍见旧值）。
    object_get: (o, k) => { if (process.env.QZDBG && strings[k]==="extra") console.error("[dbg] object_get extra off=", Number(BigInt.asUintN(64, o) & MASK32), "val=", String(handles[Number(BigInt.asUintN(64, o) & MASK32)] && handles[Number(BigInt.asUintN(64, o) & MASK32)]["extra"])); const v = handles[idxOf(o)][strings[k]]; return Array.isArray(v) ? tagHandle(v) : ret(v); },
    string_new: (id) => tagHandle(strings[id]),
    string_concat: (a, b) => strWriteback(toJS(a) + toJS(b)),
    to_string: (v) => strWriteback(String(toJS(v))),           // ToString：对象走 string hint（toString 优先）
    is_nan_host: (v) => toJS(v) !== toJS(v) ? 1 : 0,   // JS "+" 语义（含 ToPrimitive(default)：对象优先 valueOf）
    iter_new: (o) => {
      const js = toJS(o);
      if (js == null) throw new Error("for-of: 不可迭代（null/undefined）");
      const it = typeof js[Symbol.iterator] === "function" ? js[Symbol.iterator]() : null;
      if (!it || typeof it.next !== "function") throw new Error("for-of: 目标不可迭代");
      return tagHandle({ it, val: undefined, done: false });
    },
    iter_pull: (h) => {
      const st = handles[idxOf(h)];
      const r = st.it.next();
      st.val = r.value; st.done = !!r.done;
      return st.done ? 1n : 0n;   // i64 flag（宿主返回 i64 必须 BigInt）
    },
    iter_val: (h) => ret(handles[idxOf(h)].val),
    iter_close: (h) => { const st = handles[idxOf(h)]; if (st && typeof st.it.return === "function") try { st.it.return(); } catch (_) {} return; },
    iter_array: (v) => {                          // 非数组可迭代（Map/Set/迭代器等）→ wasm 数组（元素经 toJS/bitsOf）
      const x = toJS(v);
      if (x == null) throw new Error("for-of: 该值不可迭代");
      const itf = x[Symbol.iterator];
      if (typeof itf !== "function") throw new Error("for-of: 该值不可迭代");
      // 手写迭代协议：自定义迭代器（类 [Symbol.iterator] 返回 { next }）只保证 next 存在，Array.from 会因缺 Symbol.iterator 退化
      const out = [];
      const it = itf.call(x);
      for (let guard = 0; guard < 1e7; guard++) {
        const r = it.next();
        if (!r || r.done) break;
        out.push(r.value);
      }
      return arrWriteback(out);
    },
    // 值调用：闭包句柄 → closure_call；宿主函数句柄 → 直接调用
    call_value: (v, a0, a1, a2, a3, ovf, recv) => {
      const h = BigInt.asUintN(64, v) >> 48n;
      if (h === CLO_HI) return closureCall(v, a0, a1, a2, a3, ovf, recv);
      if (h === HOST_HI) {
        const f = handles[idxOf(v)];
        if (typeof f === "function") {
          const as3 = [a0, a1, a2, a3].map(toJS);
          while (as3.length && as3[as3.length - 1] === undefined) as3.pop();   // 未传实参必须省略
          return ret(f(...as3));
        }
      }
      throw new Error("call_value: 被调值不是函数");
    },
    // 展开实参 + rest 收尾被调函数：实参数组即其唯一形参
    call_named_rest: (id, arr) => {
      const name = strings[id], fn = exportsRef && exportsRef[name];
      if (typeof fn !== "function") throw new Error("call_named_rest: 未导出函数 " + name);
      return fn(arr);
    },
    str_dup: (a) => strWriteback(strRead(a)),     // 字符串私有副本（在 bump 顶，随后原地追加安全）
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
    new_dynamic: (obj, a0, a1, a2, a3) => {          // 运行时类值构造（类表达式工厂）：类对象 → 实例句柄
      const f = handles[idxOf(obj)];
      if (typeof f !== "function") throw new Error("new: 目标不是类（期望类对象）");
      return f(...[a0, a1, a2, a3].map(x => toJS(x)));
    },
    class_value_dyn: (clsId, baseObj) => {          // 动态父类值：clsId + 父类对象 → 类对象（记录运行时父链）
      const baseCtor = handles[idxOf(baseObj)];
      if (typeof baseCtor !== "function") throw new Error("extends: 父类值不是类对象");
      const bid = baseCtor.__qzClsId;
      if (bid === undefined) throw new Error("extends: 父类值缺少 __qzClsId");
      classRuntimeParent.set(clsId, bid);
      let h = classHandles.get(clsId);
      if (h !== undefined) return h;
      const c = classObjImpl(clsId, baseCtor);
      if (!c) return TAG;
      h = ret(c); classHandles.set(clsId, h);
      return h;
    },
    super_ctor: (clsId, self, a0, a1, a2, a3) => {   // 动态父构造转发（mixin 的合成 ctor）
      const bid = classRuntimeParent.get(clsId);
      if (bid === undefined) throw new Error("super_ctor: 无运行时父类（动态 extends 未链接）");
      const m = classMeta && classMeta[bid];
      const fn = m && exportsRef && exportsRef[m.ctor];
      if (typeof fn === "function") fn(self, a0, a1, a2, a3);
      return;
    },
    builtin_value: (id) => {                        // 内建全局作值：句柄缓存（保证 === 同一）
      const n = strings[id];
      let h2 = builtinValCache.get(n);
      if (h2 !== undefined) return h2;
      const v = globalThis[n];
      if (v === undefined) return TAG;
      h2 = tagHandle(v); builtinValCache.set(n, h2);
      return h2;
    },
    class_value: (clsId) => classValueImpl(clsId),
    instanceof_dyn: (x, rhs) => {                // 动态右值 instanceof：用户类值 → 运行时父链；内建函数值 → 按名回退；否则 loud
      const c = handles[idxOf(rhs)];
      const cid = (c && typeof c === "function") ? c.__qzClsId : undefined;
      if (cid !== undefined) return instanceById(x, cid);
      const nm = (c && typeof c === "function" && c.name) ? c.name : null;
      if (nm) {                                   // 内建函数值 → 按名判定（与 instanceof_builtin 同语义，内联以避免自引用）
        const j = toJS(x);
        const hi2 = BigInt.asUintN(64, x) >> 48n;
        switch (nm) {
          case "Array":    return boxBool(hi2 === 0x7ffbn || Array.isArray(j));
          case "Object":   return boxBool(j !== null && (typeof j === "object" || typeof j === "function"));
          case "Function": return boxBool(typeof j === "function");
          case "String":   return boxBool(typeof j === "object" && j !== null && j instanceof String);
          case "Number":   return boxBool(typeof j === "object" && j !== null && j instanceof Number);
          case "Boolean":  return boxBool(typeof j === "object" && j !== null && j instanceof Boolean);
          case "Map":      return boxBool(j instanceof Map);
          case "Set":      return boxBool(j instanceof Set);
          case "WeakMap":  return boxBool(j instanceof WeakMap);
          case "WeakSet":  return boxBool(j instanceof WeakSet);
          case "Promise":  return boxBool(j instanceof Promise);
          case "RegExp":   return boxBool(j instanceof RegExp);
          case "Date":     return boxBool(j instanceof Date);
          default:
            if (/^(Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError)$/.test(nm)) {
              return boxBool(typeof globalThis[nm] === "function" && j instanceof globalThis[nm]);
            }
        }
      }
      throw new Error("instanceof: 右操作数不是类或内建类");
    },
    instanceof_op: (obj, clsId) => {
      // Symbol.hasInstance 优先（JS [[HasInstance]] 语义）：沿类继承链查 static @@hasInstance → 调 wasm 静态方法
      {
        let cc = classMeta && classMeta[clsId];
        while (cc) {
          const sm = cc.staticMethods && cc.staticMethods["@@hasInstance"];
          if (sm && exportsRef) {
            const fn = exportsRef[sm.name];
            if (typeof fn === "function") return boxBool(!!toJS(fn(TAG, obj, TAG, TAG, TAG)));   // self=TAG(占位)；a0=x=obj(tagged i64)
          }
          cc = chainNext(cc);
        }
      }
      const u = BigInt.asUintN(64, obj);
      if ((u >> 48n) !== INST_HI) return boxBool(false);
      const off = Number(u & MASK32);
      if (!mem || off + 4 > mem.buffer.byteLength) return boxBool(false);
      let c = new DataView(mem.buffer).getInt32(off, true);   // 实例的 clsId（含运行时父链：动态 extends/mixin）
      while (c !== null && c !== undefined) {
        if (c === clsId) return boxBool(true);
        const m = classMeta && classMeta[c];
        c = classRuntimeParent.has(c) ? classRuntimeParent.get(c) : (m ? m.parent : null);
      }
      return boxBool(false);
    },
    // 对象展开（{...o, a:1}）：Object.assign({}, ...pieces) → 宿主对象句柄。n = pieces 数。
    obj_assign: (n, a0, a1, a2, a3) => ret(Object.assign({}, ...[a0, a1, a2, a3].slice(0, n).map(toJS))),
    // 闭包共享环境（链式）：env = 宿主对象 {__parent, <var>: tagged}；idx = handles 索引。
    // 外层本体与其闭包共享同一 env → 写回互相可见（不再是值快照）。
    env_new: (parentIdx) => ret({ __parent: parentIdx >= 0 ? handles[parentIdx] : null }),
    // 直接写入指定环境层（每迭代新绑定的种子：不经 __parent 链查找）
    env_def: (idx, kid, v) => { handles[idx][strings[kid]] = v; },
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
    statics_has: (id, fid) => { const o = statics.get(strings[id]); return o && strings[fid] in o ? 1 : 0; },
    statics_mark: (id) => { if (!statics.has(strings[id])) statics.set(strings[id], {}); },
    static_get: (id, fid) => { const o = statics.get(strings[id]); const v = o ? o[strings[fid]] : undefined; return v === undefined ? TAG : v; },
    static_set: (id, fid, v) => { let o = statics.get(strings[id]); if (!o) { o = {}; statics.set(strings[id], o); } o[strings[fid]] = v; },
    // 类 getter/setter 分派（仅当程序内有该类属性访问器时由产物调用）：实例沿继承链找访问器；
    // 命中 → 调 wasm 导出方法；未命中 → 退化为字段读/写（与 qz.get_index/set_index 同语义）。
    prop_get: (recv, id) => {
      const name = strings[id];
      const u = BigInt.asUintN(64, recv), hi = u >> 48n, off = Number(u & MASK32);
      if (hi === TAG_HI && off < 8) {                    // undefined/null 上读属性 → TypeError（JS）
        throwValue(new TypeError("Cannot read properties of " + (off === 1 ? "null" : "undefined") + " (reading '" + name + "')"));
        return TAG;
      }
      if (hi === BOOL_HI || (hi !== TAG_HI && hi !== STR_HI && hi !== 0x7ffbn && hi !== HOST_HI && hi !== CLO_HI && hi !== INST_HI)) {
        // 数字/布尔等原始值：JS 会装箱（'x'.length 之类已由字符串/数组路径处理）→ 走宿主取值或 undefined
      }
      if ((hi === TAG_HI && off >= 8) || hi === INST_HI) {           // 运行时访问器（Object.defineProperty）
        syncDynAcc();
        const acc = dynAcc.get(off + "|" + name);
        if (acc) {
          if (acc.g === undefined) return TAG;
          const uu = BigInt.asUintN(64, acc.g);
          if (uu >> 48n === CLO_HI) return closureCall(acc.g, TAG, TAG, TAG, TAG, undefined, recv);
          return ret(handles[idxOf(acc.g)].call(toJS(recv)));
        }
      }
      if (hi === TAG_HI && off >= 8) {                              // POJO：字段/运行期新键（usesDynAcc 程序里 emitter 把内存直读改走此处）
        const pe = fieldEntries.find(([n]) => n === name);
        if (pe && mem && new DataView(mem.buffer).getInt32(off + 4, true) >= pe[1] + 8) {
          const pv = new DataView(mem.buffer).getBigInt64(off + pe[1], true);
          if (BigInt.asUintN(64, pv) !== TAG) return pv;
        }
        syncExtras();
        const px = extras.get(off + "|" + name);
        if (px !== undefined) return px;
        // 未命中 → 落到下方通用分支（Object.prototype 方法 / 访问器绑定等）
      }
      if (hi === INST_HI && mem) {
        const clsId = new DataView(mem.buffer).getInt32(off, true);
        let c = classMeta && classMeta[clsId];
        while (c) {
          const g = own(c.getters, name);
          if (g) return exportsRef[g.name](recv, TAG, TAG, TAG, TAG);
          c = c.parent != null ? classMeta[c.parent] : null;
        }
        const e = fieldEntries.find(([n]) => n === name);
        if (e && new DataView(mem.buffer).getInt32(off + 4, true) >= e[1] + 8) {
          const v = new DataView(mem.buffer).getBigInt64(off + e[1], true);
          if (BigInt.asUintN(64, v) !== TAG) return v;                    // 字段已赋值 → 自有属性（遮蔽原型方法）
        }
        syncExtras();
        const x = extras.get(off + "|" + name);
        if (x !== undefined) return x;
        {
          const clsId2 = mem ? new DataView(mem.buffer).getInt32(off, true) : -1;
          let c2 = classMeta && classMeta[clsId2];
          while (c2) {                                                    // 原型方法 → 绑定宿主函数
            const m2 = own(c2.methods, name);
            if (m2) {
              const recv2 = recv;
              return tagHandle(function (...args) {   // 提取的类方法：JS this 优先（.call/.apply 的 thisArg）；this 为 undefined/null 时回退原接收者
                const selfH = (this === undefined || this === null) ? recv2 : bitsOf(this);
                const a2 = args.filter(x => x !== undefined && x !== null).map(bitsOf);
                while (a2.length < 4) a2.push(TAG);
                return toJS(exportsRef[m2.name](selfH, ...a2.slice(0, 4), TAG));
              });
            }
            c2 = chainNext(c2);
          }
        }
        return TAG;
      }
      if (name === "constructor" && (hi === STR_HI || hi === BOOL_HI || (hi !== TAG_HI && hi !== HOST_HI && hi !== CLO_HI && hi !== INST_HI && hi !== 0x7ffbn))) {
        return qzBuiltinValue(hi === STR_HI ? "String" : hi === BOOL_HI ? "Boolean" : "Number");   // 原始值 .constructor
      }
      if (hi === INST_HI && name === "constructor") {        // 实例 .constructor → 类对象（JS 语义）
        const cid = mem ? new DataView(mem.buffer).getInt32(off, true) : -1;
        return (cid >= 0 && classMeta && classMeta[cid]) ? classValueImpl(cid) : TAG;
      }
      if (hi === HOST_HI) {
        const o = handles[off], hv = o == null ? undefined : o[name];
        return Array.isArray(hv) ? tagHandle(hv) : ret(hv);   // 宿主数组：保持宿主句柄（就地写，见 object_get 注释）
      }
      if (hi === CLO_HI) {                                   // 闭包值：函数自身属性
        const dv3 = mem ? new DataView(mem.buffer) : null;
        const ar = dv3 && off + 12 <= mem.buffer.byteLength ? dv3.getInt32(off + 8, true) : 0;
        const nid = dv3 && off + 16 <= mem.buffer.byteLength ? dv3.getInt32(off + 12, true) : -1;   // -1 = 匿名
        const nm2 = (nid >= 0 && nid < strings.length) ? strings[nid] : "";
        if (name === "length") return box(ar);
        if (name === "name") return ret(nm2);
        if (name === "valueOf") return recv;
        if (name === "toString") return tagHandle(() => "function " + (nm2 || "anonymous") + "() { [native code] }");
        if (name === "call" || name === "apply" || name === "bind") {
          const cm = (this2, rest) => toJS(closureCall(recv, ...[0, 1, 2].map(i => rest[i] === undefined ? TAG : rest[i]), TAG, undefined, this2 === undefined ? TAG : this2));
          if (name === "call") return tagHandle((this2, x0, x1, x2) => cm(bitsOf(this2), [bitsOf(x0), bitsOf(x1), bitsOf(x2)]));
          if (name === "apply") return tagHandle((this2, arr3) => cm(bitsOf(this2), (arr3 === undefined ? [] : (toJS(arr3) || [])).map(bitsOf)));
          return tagHandle((...xs) => (...ys) => cm(bitsOf(xs[0]), [...xs.slice(1), ...ys].slice(0, 3).map(bitsOf)));
        }
        return TAG;                                            // 其它属性：闭包值无自有属性
      }
      // Object.prototype 方法（POJO/实例）：以接收者为 self 的绑定宿主函数
      if ((hi === TAG_HI && off >= 8) || hi === INST_HI) {
        if (name === "hasOwnProperty") return tagHandle((k) => {
          const key = String(toJS(k));
          const e2 = fieldEntries.find(([n]) => n === key);
          if (e2 && mem && new DataView(mem.buffer).getInt32(off + 4, true) >= e2[1] + 8) {
            if (BigInt.asUintN(64, new DataView(mem.buffer).getBigInt64(off + e2[1], true)) !== TAG) return true;
          }
          syncExtras();
          return extras.has(off + "|" + key);
        });
        if (name === "valueOf" || name === "toString" || name === "toLocaleString") return tagHandle(() => toJS(recv));
        if (name === "isPrototypeOf" || name === "propertyIsEnumerable") return tagHandle(() => false);
      }
      // 字符串/数组：方法名 → 绑定宿主函数（truthy + 可调用）；其余属性 → 值
      if (hi === STR_HI || hi === 0x7ffbn) {
        if (hi === 0x7ffbn) { const am = arrMeta.get(off); if (am && Object.prototype.hasOwnProperty.call(am, name)) return ret(am[name]); }
        const v = toJS(recv);
        const m = v == null ? undefined : v[name];
        return typeof m === "function" ? tagHandle(m.bind(v)) : ret(m);
      }
      return ret(toJS(recv)[name]);
    },
    prop_set: (recv, id, v) => { if (process.env.QZDBG && strings[id]==="extra") console.error("[dbg] prop_set extra off=", Number(BigInt.asUintN(64, recv) & MASK32), "vRaw=", String(v), "hi=", (BigInt.asUintN(64, v) >> 48n).toString(16));
      const name = strings[id];
      const u = BigInt.asUintN(64, recv), hi = u >> 48n, off = Number(u & MASK32);
      if (hi === TAG_HI && off < 8) { throwValue(new TypeError("Cannot set properties of " + (off === 1 ? "null" : "undefined") + " (setting '" + name + "')")); return; }   // undefined/null 写属性 → TypeError（JS 语义）
      if ((hi === TAG_HI && off >= 8) || hi === INST_HI) {          // 运行时 setter（Object.defineProperty）优先于字段写
        syncDynAcc();
        const acc = dynAcc.get(off + "|" + name);
        if (acc) {
          if (acc.s === undefined) return;                          // 只读访问器：strict 下应抛错（此处静默忽略，见限制）
          const us = BigInt.asUintN(64, acc.s);
          if (us >> 48n === CLO_HI) closureCall(acc.s, v, TAG, TAG, TAG, undefined, recv);
          else handles[idxOf(acc.s)].call(toJS(recv), toJS(v));
          return;
        }
      }
      if (hi === TAG_HI && off >= 8) {                 // POJO 字段写（usesDynAcc 程序里 emitter 把内存直写改走此处）
        const e2 = fieldEntries.find(([n]) => n === name);
        if (protGuard(off, name)) return;
        if (!e2 || !mem || new DataView(mem.buffer).getInt32(off + 4, true) < e2[1] + 8) { syncExtras(); extras.set(off + "|" + name, v); return; }
        new DataView(mem.buffer).setBigInt64(off + e2[1], v, true);
        return;
      }
      if (hi === INST_HI && mem) {
        const clsId = new DataView(mem.buffer).getInt32(off, true);
        let c = classMeta && classMeta[clsId];
        while (c) {
          const st = own(c.setters, name);
          if (st) { exportsRef[st.name](recv, v, v, v, v); return; }
          c = c.parent != null ? classMeta[c.parent] : null;
        }
        if (protGuard(off, name)) return;
        const e = fieldEntries.find(([n]) => n === name);
        if (!e || new DataView(mem.buffer).getInt32(off + 4, true) < e[1] + 8) { syncExtras(); extras.set(off + "|" + name, v); return; }
        new DataView(mem.buffer).setBigInt64(off + e[1], v, true);
        return;
      }
      if (hi === HOST_HI) { const o = handles[off]; if (o != null) o[name] = toJS(v); return; }
    },
    // x instanceof 内建类：按 tag / 物化后判定（Array/Object/String/Number/Boolean/Function/Error…）
    // x instanceof 内建类：按**物化后的 JS 语义**判定（原始值 instanceof String/Number/Boolean 为 false）
    instanceof_builtin: (x, id) => {
      const name = strings[id];
      const u = BigInt.asUintN(64, x), hi = u >> 48n;
      if (hi === INST_HI && classMeta && mem) {                 // wasm 类实例：沿类链查内建父类（extends Error 族）
        const off0 = Number(u & MASK32);
        if (off0 + 4 <= mem.buffer.byteLength) {
          let c = classMeta[new DataView(mem.buffer).getInt32(off0, true)];
          while (c) {
            if (c.builtinParent) {
              const bp = c.builtinParent;
              if (bp === name || (name === "Error" && /Error$/i.test(bp) && bp !== "URIError" && /^(Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError)$/.test(bp))) return 1;
              break;
            }
            c = c.parent != null ? classMeta[c.parent] : null;
          }
        }
      }
      const j = toJS(x);
      switch (name) {
        case "Array":    return (hi === 0x7ffbn || Array.isArray(j)) ? 1 : 0;
        case "Object":   return (j !== null && (typeof j === "object" || typeof j === "function")) ? 1 : 0;
        case "Function": return typeof j === "function" ? 1 : 0;
        case "String":   return (typeof j === "object" && j !== null && j instanceof String) ? 1 : 0;
        case "Number":   return (typeof j === "object" && j !== null && j instanceof Number) ? 1 : 0;
        case "Boolean":  return (typeof j === "object" && j !== null && j instanceof Boolean) ? 1 : 0;
        case "Error":    return (j instanceof Error) ? 1 : 0;
        case "TypeError": case "RangeError": case "SyntaxError": case "ReferenceError":
        case "EvalError": case "URIError":
                         return (typeof globalThis[name] === "function" && j instanceof globalThis[name]) ? 1 : 0;
        case "Map":      return (j instanceof Map) ? 1 : 0;
        case "Set":      return (j instanceof Set) ? 1 : 0;
        case "WeakMap":  return (j instanceof WeakMap) ? 1 : 0;
        case "WeakSet":  return (j instanceof WeakSet) ? 1 : 0;
        case "Promise":  return (j instanceof Promise) ? 1 : 0;
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
      const jsArr = toJS(arr) || [];
      if (meta.rest) {                                  // rest 闭包惯例：固定参… + rest 数组（否则会被摊平成单值）
        const nFixS = Math.max(meta.n - 1, 0);
        const fixedS = jsArr.slice(0, nFixS).map(ret);
        const restS = arrWriteback(jsArr.slice(nFixS));
        return exportsRef[meta.name](blk, ...fixedS, restS);
      }
      const raw = jsArr.slice(0, 4).map(ret);
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
    is_symbol_host: (v) => (typeof handles[idxOf(v)] === "symbol" ? 1 : 0),   // typeof 宿主 symbol → "symbol"
    is_symbol_host: (v) => (typeof handles[idxOf(v)] === "symbol" ? 1 : 0),   // typeof 宿主 symbol → "symbol"
    // 对象字面量的方法（闭包，第一个形参为 self）：宿主调用时转发接收者
    object_set_method: (o, k, v) => {
      const obj = handles[idxOf(o)];
      obj[strings[k]] = function (...args) {
        const selfH = (this && typeof this === "object" && this !== globalThis) ? tagHandle(this) : TAG;   // 实际接收者；提取后调用 this=undefined（JS 语义）
        const aa = args.slice(0, 4).map(ret);
        while (aa.length < 4) aa.push(TAG);                       // 未传实参 = TAG
        const ovfA = args.length > 3 ? ret(args.slice(3)) : undefined;   // 闭包 ABI：ovf = 实参 3..（rest/>4 形参由 callee 侧解包）
        return toJS(closureCall(v, aa[0], aa[1], aa[2], aa[3], ovfA, selfH));   // receiver 走 recv
      };
      obj[strings[k]].__qzClo = v;   // 原始闭包句柄（访问器调用需替换 this）
    },
    object_set_method_key: (o, keyHandle, v) => {   // 计算键名方法（Symbol.iterator 等）
      const obj = handles[idxOf(o)], key = toJS(keyHandle);
      obj[key] = function (...args) {
        const selfH = (this && typeof this === "object" && this !== globalThis) ? tagHandle(this) : TAG;
        const aa = args.slice(0, 4).map(ret);
        while (aa.length < 4) aa.push(TAG);                       // 未传实参 = TAG
        const ovfA = args.length > 3 ? ret(args.slice(3)) : undefined;   // 闭包 ABI：ovf = 实参 3..（rest/>4 形参由 callee 侧解包）
        return toJS(closureCall(v, aa[0], aa[1], aa[2], aa[3], ovfA, selfH));   // receiver 走 recv
      };
      obj[key].__qzClo = v;
    },
    obj_accessor: (o, k, g, s2) => {
      const name = strings[k], obj = handles[idxOf(o)], opt = {};
      const selfOf = function () { return (this && typeof this === "object" && this !== globalThis) ? tagHandle(this) : TAG; };
      if (BigInt.asUintN(64, g) >> 48n === CLO_HI) opt.get = function () { return toJS(closureCall(g, TAG, TAG, TAG, TAG, undefined, selfOf.call(this))); };
      if (BigInt.asUintN(64, s2) >> 48n === CLO_HI) opt.set = function (v) { closureCall(s2, ret(v), TAG, TAG, TAG, undefined, selfOf.call(this)); };
      if (opt.get || opt.set) Object.defineProperty(obj, name, { get: opt.get, set: opt.set, configurable: true, enumerable: true });
    },
    // {..src}：把 src 的自有可枚举键按**键序**补登记到 dst（已存在保持原位、新键追加 = JS 语义）
    spread_order: (dst, src) => {
      if (!mem) return;                                  // start 段 mem 未绑定 → 跳过（模块级对象的键序由 order_note 负责）
      syncOrder(); syncExtras();
      const so = Number(BigInt.asUintN(64, src) & MASK32), dof = Number(BigInt.asUintN(64, dst) & MASK32);
      let srcList = orderMap.get(so);
      if (!srcList) { const js = toJS(src); if (!js || typeof js !== "object") return; srcList = Object.keys(js); }
      let dl = orderMap.get(dof); if (!dl) { dl = []; orderMap.set(dof, dl); }
      for (const k of srcList) {
        if (typeof k === "string" && k.charCodeAt(0) === 35) continue;
        let present = extras.has(so + "|" + k);
        if (!present) { const fe2 = fieldEntries.find(([n]) => n === k);
          present = !!(fe2 && new DataView(mem.buffer).getInt32(so + 4, true) >= fe2[1] + 8
                       && BigInt.asUintN(64, new DataView(mem.buffer).getBigInt64(so + fe2[1], true)) !== TAG); }
        if (!present) { const js2 = toJS(src); present = !!(js2 && typeof js2 === "object" && k in js2); }
        if (!present) continue;
        if (dl.indexOf(k) < 0) dl.push(k);
      }
    },
    obj_merge: (target, src) => {
      const o = toJS(src);
      if (o == null) return;
      { const hd = BigInt.asUintN(64, target) >> 48n, od = Number(BigInt.asUintN(64, target) & MASK32);   // 宿主对象目标：就地合并
        if (hd === HOST_HI) { const t0 = handles[od]; if (t0 && typeof t0 === "object") { for (const k of Object.keys(o)) t0[k] = o[k]; } return; } }
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
        { const kk = toJS(k); if (typeof kk === "symbol") { syncSym(); const m = symProps.get(off); const v = m && m.get(kk); return v === undefined ? TAG : v; } }
        const name = String(toJS(k));
        const e = fieldEntries.find(([n]) => n === name);
        if (!e || !mem) { syncExtras(); const x = extras.get(off + "|" + name); return x === undefined ? TAG : x; }
        return new DataView(mem.buffer).getBigInt64(off + e[1], true);
      }
      if (hi === HOST_HI) return ret(handles[off][toJS(k)]);
      if (hi === 0x7ffbn && typeof toJS(k) === "string") { const am = arrMeta.get(off); const kk = toJS(k); if (am && Object.prototype.hasOwnProperty.call(am, kk)) return ret(am[kk]); }
      return ret(toJS(o)[toJS(k)]);
    },


    // 插入序登记（程序观察键序时才由产物调用）：Object.keys/for-in/JSON.stringify/对象展开 依赖插入序
    // 键序登记（strId 版）：start 段 mem 未绑定时亦可用（模块级对象键序）
    order_note: (v, sid) => {
      const u = BigInt.asUintN(64, v); const hi = u >> 48n;
      if (!((hi === TAG_HI && Number(u & MASK32) >= 8) || hi === INST_HI)) return;
      const name = strings[sid];
      if (typeof name !== "string" || name.charCodeAt(0) === 35) return;
      syncOrder(); const off = Number(u & MASK32); let l = orderMap.get(off);
      if (!l) { l = []; orderMap.set(off, l); }
      if (l.indexOf(name) < 0) l.push(name);
    },
    field_order: (v, nameHandle) => {
      if (!mem) return;   // start 段 mem 未绑定（模块级对象键序走 qz.order_note）
      const u = BigInt.asUintN(64, v), hi = u >> 48n;
      if (!((hi === TAG_HI && Number(u & MASK32) >= 8) || hi === INST_HI)) return;
      syncOrder(); const off = Number(u & MASK32); let l = orderMap.get(off);
      if (!l) { l = []; orderMap.set(off, l); }
      const nm = toJS(nameHandle); if (typeof nm !== "string") return;   // 符号键不进插入序（Object.keys 不含符号）
      if (l.indexOf(nm) < 0) l.push(nm);
    },
    field_order_del: (v, nameHandle) => {           // delete o.k → 从插入序名单移除
      const u = BigInt.asUintN(64, v), hi = u >> 48n;
      if (!((hi === TAG_HI && Number(u & MASK32) >= 8) || hi === INST_HI)) return;
      syncOrder(); const nm = toJS(nameHandle); if (typeof nm !== "string") return;
      const l = orderMap.get(Number(u & MASK32)); if (!l) return;
      const ix = l.indexOf(nm); if (ix >= 0) l.splice(ix, 1);
    },
    field_order_lit: (v, sid) => {                 // 编译期常量名单（\u0000 分隔，i32 字符串 id）
      const u = BigInt.asUintN(64, v), hi = u >> 48n;
      if (!((hi === TAG_HI && Number(u & MASK32) >= 8) || hi === INST_HI)) return;
      syncOrder(); const off = Number(u & MASK32); let l = orderMap.get(off);
      if (!l) { l = []; orderMap.set(off, l); }
      for (const nm of strings[sid].split("\u0000")) { if (nm && l.indexOf(nm) < 0) l.push(nm); }
    },
    // delete o.k：宿主对象真删（原型链可继续透出）；POJO/实例 → 槽写 undefined sentinel（等价删除）
    prop_delete: (recv, id) => {
      const name = strings[id];
      const u = BigInt.asUintN(64, recv), hi = u >> 48n;
      if (hi === HOST_HI) { const o = handles[idxOf(recv)]; if (o !== null && typeof o === "object") delete o[name]; }
      else if ((hi === TAG_HI && idxOf(recv) >= 8) || hi === INST_HI) {
        const off0 = idxOf(recv);
        const e2 = fieldEntries.find(([n]) => n === name);
        if (e2 && mem && new DataView(mem.buffer).getInt32(off0 + 4, true) >= e2[1] + 8) new DataView(mem.buffer).setBigInt64(off0 + e2[1], TAG, true);   // 槽置 undefined（等价删除）
        else { syncExtras(); extras.delete(off0 + "|" + name); }
      }
      syncOrder(); { const l = orderMap.get(idxOf(recv)); if (l) { const ix = l.indexOf(name); if (ix >= 0) l.splice(ix, 1); } }
    },
    // 写前写保护检查（仅在程序使用 freeze/seal/preventExtensions 时由产物调用）：冻结/不可扩展对象写入 → 抛 TypeError
    prot_check: (v, nameId) => {
      const u = BigInt.asUintN(64, v), hi = u >> 48n;
      if ((hi === TAG_HI && Number(u & MASK32) >= 8) || hi === INST_HI) protGuard(Number(u & MASK32), strings[nameId]);
    },
    set_index: (o, k, v) => setIndexImpl(o, k, v),
    // k in o：宿主语义（POJO/实例先物化；数组/宿主对象直接 in）。
    in_op: (k, o) => {
      const u0 = BigInt.asUintN(64, o);
      if ((u0 >> 48n) === INST_HI && mem && classMeta) {          // 原型上的 getter/setter/方法 → JS: "v" in obj 为 true
        const key = String(toJS(k));
        let c = classMeta[new DataView(mem.buffer).getInt32(Number(u0 & MASK32), true)];
        while (c) { if (own(c.getters, key) || own(c.setters, key) || own(c.methods, key)) return boxBool(true); c = c.parent != null ? classMeta[c.parent] : null; }
      }
      return boxBool(toJS(k) in toJS(o));
    },   // tagged bool（不可经 ret：BigInt 会被当宿主句柄）
    // delete o.k：宿主对象真删；POJO/实例由 emitter 直接把槽写成 undefined sentinel（本函数仅宿主）。
    object_delete: (o, kid) => { const obj = handles[idxOf(o)]; if (obj !== null && typeof obj === "object") delete obj[strings[kid]]; },
    // 内建全局调用/常量：nameId + n(实际参数个数) + a0..a3 → 宿主 JS 内建 → ret。
    // n 由调用点编译期已知：变参函数（Math.max/min/hypot/Array.of/fromCharCode）按 n 取参，
    // 不传 undefined 占位（否则 Math.max(2,5) 会变 Math.max(2,5,undefined,…)=NaN）。
    builtin: (id, n, a0, a1, a2, a3, ovf) => {
      const name = strings[id];
      if (Object.prototype.hasOwnProperty.call(BUILTIN_CONSTS, name)) return ret(BUILTIN_CONSTS[name]);
      if (name === "String" && a0 !== undefined) {                  // String(实例) → 调其 toString（JS ToPrimitive）
        const h = BigInt.asUintN(64, a0) >> 48n;
        if (h === TAG_HI || h === INST_HI) {
          const off2 = Number(BigInt.asUintN(64, a0) & MASK32);
          if (off2 >= 8 && mem) {
            const clsId = new DataView(mem.buffer).getInt32(off2, true);
            let c = classMeta && classMeta[clsId];
            while (c) {
              const m = own(c.methods, "toString");
              if (m) return exportsRef[m.name](a0, TAG, TAG, TAG, TAG);
              c = c.parent != null ? classMeta[c.parent] : null;
            }
          }
        }
      }
      // 展开实参 + 内建函数：Math.max(...a) 等
      if (name === "builtin_spread") {
        const fn2 = BUILTIN_FNS[strings[a0]] || (BUILTIN_CTORS.has(strings[a0]) ? globalThis[strings[a0]] : undefined);
        if (typeof fn2 !== "function") throw new Error("builtin_spread: 非函数 " + strings[a0]);
        return ret(fn2.apply(null, toJS(a1)));
      }
      // Object.freeze/seal/preventExtensions/isFrozen/isSealed/isExtensible：就地作用于 POJO/实例（旁表写保护）
      if (/^Object\.(freeze|seal|preventExtensions|isFrozen|isSealed|isExtensible)$/.test(name) && a0 !== undefined) {
        const h = BigInt.asUintN(64, a0) >> 48n, off0 = Number(BigInt.asUintN(64, a0) & MASK32);
        if ((h === TAG_HI && off0 >= 8) || h === INST_HI) {
          syncProt();
          const op2 = name.slice(7);
          if (op2 === "isFrozen") return boxBool(frozen.has(off0));
          if (op2 === "isSealed") return boxBool(frozen.has(off0) || sealed.has(off0));
          if (op2 === "isExtensible") return boxBool(!(frozen.has(off0) || sealed.has(off0) || nonExt.has(off0)));
          if (op2 === "freeze") { frozen.add(off0); sealed.add(off0); nonExt.add(off0); markAllProps(off0, false, false); return a0; }   // 既有属性：writable/configurable = false
          if (op2 === "seal") { sealed.add(off0); nonExt.add(off0); markAllProps(off0, undefined, false); return a0; }                     // 既有属性：configurable = false
          nonExt.add(off0); return a0;
        }
      }
      // Object.defineProperties(target, props)：对 POJO/实例就地注册（与 defineProperty 同路径；此前走原生物化副本 → getOwnPropertyNames 静默漏报）
      if (name === "Object.defineProperties" && a0 !== undefined) {
        const hD = BigInt.asUintN(64, a0) >> 48n, offD = Number(BigInt.asUintN(64, a0) & MASK32);
        if ((hD === TAG_HI && offD >= 8) || hD === INST_HI) {
          const props = toJS(a1) || {};
          for (const key of Object.keys(props)) {
            const desc = props[key] || {};
            const val = bitsOf(desc.value);
            const e2 = fieldEntries.find(([nn]) => nn === key);
            if (e2 && mem && new DataView(mem.buffer).getInt32(offD + 4, true) >= e2[1] + 8) new DataView(mem.buffer).setBigInt64(offD + e2[1], val, true);
            else { syncExtras(); extras.set(offD + "|" + key, val); }
            if (desc.enumerable === false) { syncNonEnum(bumpRef ? Number(bumpRef.value) : -1); nonEnum.set(offD + "|" + key, true); }
            syncPropFlags(); propFlags.set(offD + "|" + key, { w: desc.writable !== false, c: desc.configurable !== false });
          }
          return a0;
        }
        if (hD === HOST_HI) { Object.defineProperties(handles[offD], toJS(a1)); return a0; }
      }
      // Object.defineProperty(target, key, desc)：就地定义；enumerable:false 记入 nonEnum（物化/keys 跳过）
      if (name === "Object.defineProperty" && a0 !== undefined) {
        const h = BigInt.asUintN(64, a0) >> 48n, off0 = Number(BigInt.asUintN(64, a0) & MASK32);
        const key = toJS(a1), desc = toJS(a2) || {};
        if ((h === TAG_HI && off0 >= 8) || h === INST_HI || h === HOST_HI) {
          if (h === HOST_HI) { Object.defineProperty(handles[off0], key, desc); return a0; }
          if (desc.get || desc.set) {                     // 访问器描述符：记入访问器表（POJO/实例读/写走宿主）
            syncDynAcc();
            { if (typeof key === "string") { let l = orderMap.get(off0); if (!l) { l = []; orderMap.set(off0, l); } if (l.indexOf(key) < 0) l.push(key); } }   // 符号键不进插入序
            const gv = desc.get, sv = desc.set;
            const gH = (gv && typeof gv === "function" && gv.__qzClo !== undefined) ? gv.__qzClo : (gv === undefined ? undefined : bitsOf(gv));
            const sH = (sv && typeof sv === "function" && sv.__qzClo !== undefined) ? sv.__qzClo : (sv === undefined ? undefined : bitsOf(sv));
            dynAcc.set(off0 + "|" + key, { g: gH, s: sH });
            syncPropFlags(); propFlags.set(off0 + "|" + key, { w: desc.writable !== false, c: desc.configurable !== false });
          syncPropFlags(); propFlags.set(off0 + "|" + key, { w: desc.writable !== false, c: desc.configurable !== false });
          if (desc.enumerable === false) { syncNonEnum(bumpRef ? Number(bumpRef.value) : -1); nonEnum.set(off0 + "|" + key, true); }
            return a0;
          }
          const val = bitsOf(desc.value);
          const e2 = fieldEntries.find(([n]) => n === key);
          if (e2 && mem && new DataView(mem.buffer).getInt32(off0 + 4, true) >= e2[1] + 8) new DataView(mem.buffer).setBigInt64(off0 + e2[1], val, true);
          else { syncExtras(); extras.set(off0 + "|" + key, val); }
          if (desc.enumerable === false) { syncNonEnum(bumpRef ? Number(bumpRef.value) : -1); nonEnum.set(off0 + "|" + key, true); }   // 值描述符同样可能 non-enumerable
          syncPropFlags(); propFlags.set(off0 + "|" + key, { w: desc.writable !== false, c: desc.configurable !== false });
          syncPropFlags(); propFlags.set(off0 + "|" + key, { w: desc.writable !== false, c: desc.configurable !== false });
          if (desc.enumerable === false) { syncNonEnum(bumpRef ? Number(bumpRef.value) : -1); nonEnum.set(off0 + "|" + key, true); }
          return a0;
        }
      }
      // Object.getOwnPropertyDescriptor(o, k)：POJO/实例 → 组装描述符（含 writable/configurable/enumerable）
      if (name === "Object.getOwnPropertyDescriptor" && a0 !== undefined) {
        const h0 = BigInt.asUintN(64, a0) >> 48n, off0 = Number(BigInt.asUintN(64, a0) & MASK32);
        if ((h0 === TAG_HI && off0 >= 8) || h0 === INST_HI) {
          const key = String(toJS(a1));
          const e2 = fieldEntries.find(([n]) => n === key);
          let has = false, val = undefined;
          if (e2 && mem && new DataView(mem.buffer).getInt32(off0 + 4, true) >= e2[1] + 8) {
            const raw = BigInt.asUintN(64, new DataView(mem.buffer).getBigInt64(off0 + e2[1], true));
            if (raw !== TAG) { has = true; val = toJS(raw); }
          }
          if (!has) { syncExtras(); const x2 = extras.get(off0 + "|" + key); if (x2 !== undefined) { has = true; val = toJS(x2); } }
          if (!has) return TAG;
          syncPropFlags(); syncNonEnum(bumpRef ? Number(bumpRef.value) : -1);
          const fl = propFlags.get(off0 + "|" + key) || {};
          return tagHandle({ value: val, writable: fl.w !== false, enumerable: !nonEnum.has(off0 + "|" + key), configurable: fl.c !== false });
        }
      }
      // Object.getOwnPropertyNames(o)：预登记字段（已赋值）+ extras（含非枚举）
      if (name === "Object.getOwnPropertyNames" && a0 !== undefined) {
        const h = BigInt.asUintN(64, a0) >> 48n, off0 = Number(BigInt.asUintN(64, a0) & MASK32);
        if ((h === TAG_HI && off0 >= 8) || h === INST_HI) {
          syncExtras(); syncNonEnum(bumpRef ? Number(bumpRef.value) : -1);
          const dv2 = mem ? new DataView(mem.buffer) : null;
          const size2 = dv2 ? dv2.getInt32(off0 + 4, true) : 0;
          const out2 = [];
          for (const [n, idx] of fieldEntries) {
            if (idx >= size2) continue;
            if (BigInt.asUintN(64, dv2.getBigInt64(off0 + idx, true)) !== TAG) out2.push(n);
          }
          for (const [k] of extras) { const bar = k.indexOf("|"); if (Number(k.slice(0, bar)) === off0) out2.push(k.slice(bar + 1)); }
          return ret(out2);
        }
      }
      // Reflect.set / Reflect.deleteProperty：目标为 POJO/实例 → 就地改（物化副本无效）
      if ((name === "Reflect.set" || name === "Reflect.deleteProperty") && a0 !== undefined) {
        const h0 = BigInt.asUintN(64, a0) >> 48n, off0 = Number(BigInt.asUintN(64, a0) & MASK32);
        if ((h0 === TAG_HI && off0 >= 8) || h0 === INST_HI) {
          const key = String(toJS(a1));
          const slotOf = (nm) => { const e2 = fieldEntries.find(([n]) => n === nm); return (e2 && mem && new DataView(mem.buffer).getInt32(off0 + 4, true) >= e2[1] + 8) ? e2[1] : -1; };
          const so = slotOf(key);
          if (name === "Reflect.set") {
            const val = bitsOf(toJS(a2));
            if (so >= 0) new DataView(mem.buffer).setBigInt64(off0 + so, val, true);
            else { syncExtras(); extras.set(off0 + "|" + key, val); }
            return boxBool(true);
          }
          if (so >= 0) new DataView(mem.buffer).setBigInt64(off0 + so, TAG, true);
          else { syncExtras(); extras.delete(off0 + "|" + key); }
          syncOrder(); { const l = orderMap.get(off0); if (l) { const ix = l.indexOf(key); if (ix >= 0) l.splice(ix, 1); } }
          return boxBool(true);
        }
      }
      if (name === "Reflect.construct" && a0 !== undefined) {   // Reflect.construct(用户类, argsArray) → wasm 实例
        if ((BigInt.asUintN(64, a0) >> 48n) === HOST_HI) {
          const cobj = handles[idxOf(a0)];
          const cid = cobj && cobj.__qzClsId;
          if (cid !== undefined) return buildInstance(cid, toJS(a1) || []);
        }
      }
      // Object.keys/values/entries/getOwnPropertyNames(wasm 数组)：索引键（0..len-1，升序）+ 自定义字符串键（插入序）
      if ((name === "Object.keys" || name === "Object.values" || name === "Object.entries" || name === "Object.getOwnPropertyNames")
          && a0 !== undefined && (BigInt.asUintN(64, a0) >> 48n) === 0x7ffbn) {
        const offA = Number(BigInt.asUintN(64, a0) & MASK32);
        const dvA = mem ? new DataView(mem.buffer) : null;
        const lenA = dvA ? dvA.getInt32(offA, true) : 0;
        const dataA = dvA ? dvA.getInt32(offA + 8, true) : 0;
        const keysA = [];
        const elemA = (i) => (dvA && dataA) ? dvA.getBigInt64(dataA + i * 8, true) : TAG;
        for (let i = 0; i < lenA; i++) {                       // 稀疏：洞不计入 Object.keys/values/entries
          const raw = elemA(i);
          if (BigInt.asUintN(64, raw) === HOLE) { if (name === "Object.getOwnPropertyNames") keysA.push(String(i)); continue; }
          keysA.push(String(i));
        }
        const enm = [];
        for (const k of keysA) enm.push(k);
        syncArrMeta(); syncOrder();
        const amA = arrMeta.get(offA);
        const ck = amA ? Object.keys(amA) : [];
        for (const k of ck) if (enm.indexOf(k) < 0) enm.push(k);
        if (name === "Object.getOwnPropertyNames") { enm.push("length"); return ret(enm); }
        const keysOut = enm;
        const valA = (k) => /^\d+$/.test(k) ? toJS(elemA(Number(k))) : (amA ? amA[k] : undefined);
        if (name === "Object.keys") return ret(keysOut);
        if (name === "Object.values") return ret(keysOut.map(valA));
        return ret(keysOut.map(k => [k, valA(k)]));
      }
      if (name === "Object.assign" && a0 !== undefined) {          // 就地合并（POJO/实例为目标）并返回目标句柄
        const h = BigInt.asUintN(64, a0) >> 48n;
        const off0 = Number(BigInt.asUintN(64, a0) & MASK32);
        if ((h === TAG_HI && off0 >= 8) || h === INST_HI || h === HOST_HI) {
          syncOrder();
          let dl0 = orderMap.get(off0); if (!dl0) { dl0 = []; orderMap.set(off0, dl0); }   // JS：已存在键保持原位、新键追加（此前不登记 → 物化退化为槽序）
          for (const src of [a1, a2, a3].filter(givenSlot)) {
            const o = toJS(src);
            if (o == null) continue;
            for (const k of Object.keys(o)) {
              if (dl0.indexOf(k) < 0) dl0.push(k);
              if (h === HOST_HI) { handles[off0][k] = o[k]; continue; }
              const e2 = fieldEntries.find(([n]) => n === k);
              const v = bitsOf(o[k]);
              if (e2 && mem && new DataView(mem.buffer).getInt32(off0 + 4, true) >= e2[1] + 8) new DataView(mem.buffer).setBigInt64(off0 + e2[1], v, true);
              else { syncExtras(); extras.set(off0 + "|" + k, v); }
            }
          }
          return a0;
        }
      }
      try {
      // 宿主句柄原样参与的对象内省（物化会丢原型/附加属性）
      if (/^Object\.(getPrototypeOf|setPrototypeOf|getOwnPropertyDescriptor|getOwnPropertyDescriptors|create)$/.test(name) && a0 !== undefined
          && BigInt.asUintN(64, a0) >> 48n === HOST_HI) {
        const o0 = handles[idxOf(a0)], fn0 = BUILTIN_FNS[name];
        if (name === "Object.create") return ret(Object.create(o0, a1 !== undefined ? toJS(a1) : undefined));
        if (name === "Object.setPrototypeOf") { Object.setPrototypeOf(o0, toJS(a1)); return a0; }
        if (name === "Object.getPrototypeOf") return ret(Object.getPrototypeOf(o0));
        if (name === "Object.getOwnPropertyDescriptor") return ret(Object.getOwnPropertyDescriptor(o0, toJS(a1)));
        return ret(Object.getOwnPropertyDescriptors(o0));
      }
      let fn = BUILTIN_FNS[name] || (BUILTIN_CTORS.has(name) ? globalThis[name] : undefined);
      if (fn === undefined && typeof globalThis[name] === "function") fn = globalThis[name];   // 内建全局函数作调用（Symbol/BigInt/Reflect/…）
      if (fn === undefined && name.indexOf(".") > 0) {                       // 点号成员（Symbol.for / Reflect.has / Number.isInteger…）
        let cur = globalThis;
        for (const seg of name.split(".")) { cur = cur == null ? undefined : cur[seg]; if (cur === undefined) break; }
        fn = cur;
      }
      let arity = 0;                                  // 表项 [fn, arity] = 固定元数（调用点按此裁剪实参）
      if (Array.isArray(fn)) { arity = fn[1]; fn = fn[0]; }
      if (typeof fn !== "function") throw new Error("qz.builtin 未实现: " + name);
      let flat = [a0, a1, a2, a3];
      if (ovf !== undefined && ovf !== TAG) flat = flat.concat((toJS(ovf) || []).slice(1).map(bitsOf));   // ovf[0] = 实参 3（已在 a3）
      const args = flat.slice(0, arity || n).map(toJS);
      return ret(BUILTIN_CTORS.has(name) ? Reflect.construct(fn, args) : fn.apply(null, args));
      } catch (e) {
        const msg = e && e.message ? String(e.message) : "";
        if (!(e instanceof Error) || /^(qz\.|builtin_spread|未定义)/.test(msg)) throw e;
        throwValue(e);        // JSON.stringify 循环引用等 → 设 __err，调用点的 _emitErrCheck 转入 catch
        return TAG;
      }
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
    eq:   (a, b) => { const ua = BigInt.asUintN(64, a), ub = BigInt.asUintN(64, b); const oa = isObjHandle(ua), ob = isObjHandle(ub); return bool(oa && ob ? ua === ub : toJS(a) == toJS(b)); },   // 两个对象 → 身份；其余走 JS 宽松相等（含对象↔原始值强转）
    ne:   (a, b) => bool(toJS(a) != toJS(b)),
    bnot: (a) => box(~(toJS(a) | 0)),
    to_num: (a) => box(+toJS(a)),
    neg: (a) => box(-toJS(a)),                          // 一元 -：ToNumber（对象 valueOf）
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
    take_err: () => takeErr(),
    log:  (v) => console.log("  [qz]", typeof toJS(v) === "string" ? toJS(v) : String(toJS(v))),
    // 字符串方法：recv + 方法名 id + 2 参（undefined 句柄 = 缺省）→ 结果字符串句柄。
    str_method: (recv, mid, a0, a1) => doStrMethod(recv, mid, a0, a1),
    // 通用方法调用：字符串 → doStrMethod；数组(0x7FFB) → doArrMethod；类实例（内存 [0]=__cls id）
    // → 沿继承链查 classMeta[clsId].methods[name] 调 wasm 导出方法（self=recv, a0..a3）。
    method_call: (recv, mid, a0, a1, a2, a3, ovf) => {
      if (BigInt.asUintN(64, recv) >> 48n === BOOL_HI) {   // 布尔装箱：toString/valueOf（数字分支按 f64 位解析会得 NaN）
        const bv = (BigInt(recv) & 1n) === 1n;
        if (strings[mid] === "toString" || strings[mid] === "valueOf") return ret(bv.toString());
      }
      try {
      if (isStrH(recv)) return doStrMethod(recv, mid, a0, a1, a2, a3);
      if (isArrH(recv)) return doArrMethod(recv, mid, a0, a1, a2, a3);
      const name = strings[mid];
      if ((BigInt.asUintN(64, recv) >> 48n) === CLO_HI && (name === "toString" || name === "valueOf")) {
        const dv4 = mem ? new DataView(mem.buffer) : null;
        const off4 = Number(BigInt.asUintN(64, recv) & MASK32);
        const nid4 = dv4 && off4 + 16 <= mem.buffer.byteLength ? dv4.getInt32(off4 + 12, true) : -1;
        const nm4 = (nid4 >= 0 && nid4 < strings.length) ? strings[nid4] : "";
        if (name === "valueOf") return recv;
        return ret("function " + (nm4 || "anonymous") + "() { [native code] }");
      }
      // 函数值接收者（闭包 0x7FFF / 宿主函数）：Function.prototype 三件套
      const hiR = BigInt.asUintN(64, recv) >> 48n;
      if (name === "call" || name === "apply" || name === "bind") {
        const rawFn = hiR === HOST_HI ? handles[idxOf(recv)] : null;
        if (hiR === CLO_HI || typeof rawFn === "function") {
          const callIt = (self2, rest) => {
            if (hiR === CLO_HI) {
              const off0 = Number(BigInt.asUintN(64, recv) & 0xffff_ffffn);
              const mi = mem ? new DataView(mem.buffer).getUint32(off0, true) : -1;
              const mm = lamMeta && lamMeta[mi];
              const passSelf = !!(mm && mm.synthThis);            // 合成箭头（对象字面量方法/访问器）：this 为真实 receiver 槽
              const a = rest.map(x => x === undefined ? TAG : x);
              return toJS(closureCall(recv, a[0], a[1], a[2], TAG, undefined, self2 === undefined ? TAG : self2));   // receiver 走 recv（宿主按 synthThis 前置）
            }
            return rawFn.apply(thisArgOf(self2), rest.slice(0, 3).map(toJS));
          };
          if (name === "call") return ret(callIt(a0, [a1, a2, a3]));
          if (name === "apply") { const arr2 = a1 === undefined ? [] : (toJS(a1) || []).map(bitsOf); return ret(callIt(a0, arr2)); }
          // bind：返回宿主函数（thisArg 固定在前）——经 qz.call_value 可调用
          const boundSelf = a0, boundPre = [a1, a2, a3];
          return tagHandle(function (...xs) {
            const rest = boundPre.filter(givenSlot).slice(0, 3);   // 只保留真正传入的实参（TAG = 未传）
            const all = rest.concat(xs.map(bitsOf)).slice(0, 3);
            return callIt(boundSelf, all);
          });
        }
      }
      if (isHostH(recv)) {                                   // 宿主对象（JSON.parse 结果等）：调真实 JS 方法
        const obj = handles[idxOf(recv)];
        const fn = obj == null ? undefined : obj[name];
        if (typeof fn !== "function") throw new Error("method_call: 宿主对象无方法 " + name);
        const as = [a0, a1, a2, a3].map(toJS);
        if (ovf !== undefined && ovf !== TAG) as.push(...(toJS(ovf) || []).slice(1));   // ovf[0] = 实参 3（已在 a3）；其余接在 4 槽之后（rest/>4 形参）
        while (as.length && as[as.length - 1] === undefined) as.pop();   // 未传实参必须省略（否则 setFullYear(2021,undefined) → Invalid Date）
        return ret(fn.apply(obj, as));
      }
      // POJO/实例：Object.prototype 内建方法（hasOwnProperty / toString / valueOf …）
      {
        const h0 = BigInt.asUintN(64, recv) >> 48n;
        const off0 = Number(BigInt.asUintN(64, recv) & MASK32);
        if ((h0 === TAG_HI && off0 >= 8) || h0 === INST_HI) {
          if (name === "hasOwnProperty") {
            const key = String(toJS(a0));
            const e2 = fieldEntries.find(([n]) => n === key);
            if (e2 && mem && new DataView(mem.buffer).getInt32(off0 + 4, true) >= e2[1] + 8) {
              const v = new DataView(mem.buffer).getBigInt64(off0 + e2[1], true);
              if (BigInt.asUintN(64, v) !== TAG) return boxBool(true);
            }
            syncExtras(); syncDynAcc(); syncOrder();
            {   // defineProperty 定义的访问器（dynAcc）与插入序表（orderMap）里的键也是自有属性（此前只查内存槽 → 静默漏报）
              if (extras.has(off0 + "|" + key) || dynAcc.has(off0 + "|" + key)) return boxBool(true);
              const ord0 = orderMap.get(off0);
              if (ord0 && ord0.indexOf(key) >= 0) return boxBool(true);
            }
            return boxBool(extras.has(off0 + "|" + key));
          }
          if (name === "toString" || name === "toLocaleString" || name === "valueOf") {
            // 类/原型链上若自定义了同名方法 → 不套用 Object.prototype 默认值（否则静默遮蔽类方法）
            let cid0 = h0 === INST_HI && mem ? new DataView(mem.buffer).getInt32(off0, true) : -1;
            let cc0 = cid0 >= 0 && classMeta ? classMeta[cid0] : null;
            let hasOwnM = false;
            while (cc0) { if (own(cc0.methods, name)) { hasOwnM = true; break; } cc0 = chainNext(cc0); }
            if (!hasOwnM) return ret("[object Object]");
            let cc1 = cid0 >= 0 ? classMeta[cid0] : null, mOwner = null;      // 类自定义同名方法 → 直接派发 wasm 方法
            while (cc1) { if (own(cc1.methods, name)) { mOwner = cc1; break; } cc1 = cc1.parent != null ? classMeta[cc1.parent] : null; }
            const mm0 = mOwner && mOwner.methods[name];
            if (mm0 && exportsRef[mm0.name]) return exportsRef[mm0.name](recv, a0, a1, a2, a3);
            return ret("[object Object]");
          }
        }
      }
      // 纯数值接收者（高16位非任何句柄 tag）→ Number.prototype 方法
      {
        const vnum = bitsToNum(recv);
        if (name === "toString") return ret(vnum.toString(toJS(a0) !== undefined ? toJS(a0) : 10));
        if (name === "toFixed") return ret(vnum.toFixed(Number(toJS(a0))));
        if (name === "valueOf") return ret(vnum);
        if (name === "toLocaleString" || name === "toExponential" || name === "toPrecision") return ret(vnum[name](toJS(a0) !== undefined ? Number(toJS(a0)) : undefined));
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
            if (BigInt.asUintN(64, fv) >> 48n === CLO_HI) return closureCall(fv, a0, a1, a2, a3, ovf, recv);   // 方法位置的闭包值：receiver = recv，ovf 透传（rest/>4 形参）
          }
        }
      }
      // 仅类实例(0x7FFE)走类方法派发：POJO(0x7FF9) 的 clsId 恒为 0，会撞第一个类的 id
      if ((BigInt.asUintN(64, recv) >> 48n) !== INST_HI) throw new Error("method_call: 无方法 " + name);
      const clsId = new DataView(mem.buffer).getInt32(off, true);   // 免 4 对齐
      let c = classMeta && classMeta[clsId];
      while (c) {
        const m = own(c.methods, name);
        if (m) {
          const fn = exportsRef[m.name];
          {   // 平坦实参 = a0..a3 + ovf[1..]（ovf[0] = 实参 3，已在 a3）；rest 形参把尾部打包成数组
            const ex = (ovf === undefined || ovf === TAG) ? [] : (toJS(ovf) || []);
            const flat = [a0, a1, a2, a3].concat(ex.slice(1).map(bitsOf));   // 统一为 tagged（ex 元素是 JS 值）
            if (m.rest) {
              const nFix = (m.n || 1) - 1;
              const tail = flat.slice(nFix).filter(givenSlot);   // tagged
              const head = flat.slice(0, nFix);
              const out2 = [recv].concat(head, [arrWriteback(tail.map(toJS))]);   // rest 数组落在其形参槽；arrWriteback 收 JS 值
              while (out2.length < 5) out2.push(TAG);
              return fn(...out2);
            }
            if ((m.n || 0) > 4) {
              const n2 = m.n;
              const ovfA2 = flat.slice(3, n2).map(x => x === undefined ? TAG : x);   // ovf[0] = 实参 3（与 callee 的 ovf[i-3] 约定一致；tagged）
              return fn(recv, flat[0], flat[1], flat[2], flat[3], arrWriteback(ovfA2.map(toJS)));   // arrWriteback 收 JS 值；flat 为 tagged → toJS
            }
          }
          return fn(recv, a0, a1, a2, a3);
        }
        c = chainNext(c);
      }
      throw new Error("method_call: 类 " + clsId + " 无方法 " + name);
      } catch (e) {
        const msg = e && e.message ? String(e.message) : "";
        if (!(e instanceof Error) || /^(method_call|qz\.|for-of|instanceof_builtin|arr_|str_|call_value|closure|未定义)/.test(msg)) throw e;
        throwValue(e);        // 标准库语义错误（RangeError/TypeError…）→ 设 __err，调用点的 _emitErrCheck 转入 catch
        return TAG;
      }
    },
    // 数组 .length= 赋值：截断或扩容（扩容量不足换 data 块，新槽补 undefined 句柄 0x7FF9|0）。
    // a[i] = v（越界：JS 扩容并补 undefined 槽）；返回所赋之值
    arr_set_index: (recv, i, v) => {
      if ((BigInt.asUintN(64, recv) >> 48n) !== 0x7ffbn) return setIndexImpl(recv, i, v);   // 宿主对象/POJO/实例 → 交 set_index（此前按 wasm 数组写 → 静默丢失）
      const a = arrRead(recv);
      const idx = Math.trunc(toJS(i));
      if (idx < 0 || !isFinite(idx)) return v;
      if (a.length < idx) a.length = idx;      // JS 语义：跳过的下标是**洞**（不是 undefined）
      a[idx] = toJS(v);
      arrSetInPlace(recv, a);
      return v;
    },
    // delete a[i] → 槽置 undefined（长度不变；JS 的「洞」在本表示里等同 undefined）
    // delete o[k]（数组 → 槽置 undefined；POJO/实例 → 字段置 undefined；宿主对象 → delete）
    delete_index: (o, k) => {
      { const u = BigInt.asUintN(64, o);                              // wasm 数组 + 数值键 → 写洞（JS：delete a[i] 产生洞，length 不变）
        if ((u >> 48n) === 0x7ffbn) {
          const kk = toJS(k);
          if (typeof kk === "number") { const a2 = arrRead(o); if (kk >= 0 && kk < a2.length) { const dv = new DataView(mem.buffer); const off0 = Number(u & MASK32); dv.setBigInt64(dv.getInt32(off0 + 8, true) + Math.trunc(kk) * 8, BigInt.asIntN(64, HOLE), true); } return true; }
        } }
      { const u = BigInt.asUintN(64, o), h = u >> 48n;                 // 插入序名单同步移除（否则 keys/for-in 仍列出已删属性）
        if ((h === TAG_HI && Number(u & MASK32) >= 8) || h === INST_HI) {
          syncOrder(); const l = orderMap.get(Number(u & MASK32));
          if (l) { const nm = String(toJS(k)), ix = l.indexOf(nm); if (ix >= 0) l.splice(ix, 1); }
        } }
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
    // 变参数组方法：实参数组 + 名 → push/unshift/splice/concat（含就地变更与返回值语义）
    empty_array: () => arrWriteback([]),          // rest 形参未传实参 → 空数组
    arr_apply: (recv, mid, arr) => {
      if ((BigInt.asUintN(64, recv) >> 48n) !== 0x7ffbn) throw new Error("arr_apply: 非 wasm 数组接收者");
      const name = strings[mid], args = toJS(arr) || [], a = arrRead(recv);
      let r;
      switch (name) {
        case "push":    r = a.push(...args); arrSetInPlace(recv, a); return box(r);
        case "unshift": r = a.unshift(...args); arrSetInPlace(recv, a); return box(r);
        case "splice":  r = a.splice(...args); arrSetInPlace(recv, a); return ret(r);
        case "concat":  return ret(a.concat(...args));
        default: throw new Error("arr_apply: 不支持 " + name);
      }
    },
    // 字符串 → 码点字符数组（for…of 按码点迭代，与 JS 一致）
    str_chars: (v) => arrWriteback(Array.from(strRead(v))),
    // 内建函数值读取（Math.expm1 / JSON.stringify 之类，作为值而非调用）→ 宿主函数句柄
    // 内建成员读（作为值）：常量 → 值；函数 → 宿主函数句柄；未知 → undefined
    // 正则字面量：宿主 RegExp（/pat/flags 原文 → new RegExp）。typeof → object ✓ instanceof RegExp ✓
    regex: (id) => {
      const src = strings[id];
      const m = /^\/(.*)\/([a-z]*)$/s.exec(src);
      if (!m) throw new Error("regex: 无法解析字面量 " + src);
      return tagHandle(new RegExp(m[1], m[2]));
    },
    builtin_member: (id) => {
      const name = strings[id];
      if (Object.prototype.hasOwnProperty.call(BUILTIN_CONSTS, name)) return ret(BUILTIN_CONSTS[name]);
      const e = BUILTIN_FNS[name];
      let f = Array.isArray(e) ? e[0] : (e || (BUILTIN_CTORS.has(name) ? globalThis[name] : undefined));
      if (f === undefined && Object.prototype.hasOwnProperty.call(globalThis, name)) f = globalThis[name];   // 内建全局作值（Symbol/BigInt/Math/JSON/Reflect…）
      if (f === undefined && name.indexOf(".") > 0) {                       // 点号成员（Symbol.for / Object.prototype.toString / Number.isInteger…）→ 沿 globalThis 走
        let cur = globalThis;
        for (const seg of name.split(".")) { cur = cur == null ? undefined : cur[seg]; if (cur === undefined) break; }
        f = cur;
      }
      return f === undefined ? TAG : tagHandle(f);    // 函数/原型对象/其它值皆返回句柄
    },
    // 内建函数 + 展开实参（Math.max(...a) 等）
    // [...x]：按迭代协议并入（数组/字符串/迭代器/Map/Set）
    // 实例的 .stack：Error 族（extends Error）→ 按当前 name/message 合成（栈文本实现定义，这里给同一格式）
    err_stack: (v) => {
      const u = BigInt.asUintN(64, v), hi2 = u >> 48n;
      if (hi2 === HOST_HI) { const o = handles[idxOf(v)]; return ret(o == null ? undefined : o.stack); }
      if (hi2 !== INST_HI || !mem || !classMeta) return TAG;
      const off = Number(u & MASK32);
      const dv = new DataView(mem.buffer);
      let c = classMeta[dv.getInt32(off, true)], isErr = false;
      while (c) { if (c.builtinParent && /Error$/.test(c.builtinParent)) { isErr = true; break; } c = c.parent != null ? classMeta[c.parent] : null; }
      if (!isErr) return TAG;
      const rd = (nm) => { const e = fieldEntries.find(([n]) => n === nm); if (!e) return undefined;
        const t = dv.getBigInt64(off + e[1], true); return BigInt.asUintN(64, t) === TAG ? undefined : toJS(t); };
      const nm2 = String(rd("name") === undefined ? "Error" : rd("name")), ms = rd("message");
      return ret(ms === undefined || ms === "" ? nm2 : nm2 + ": " + ms);
    },
    // 用户标签模板 strings 对象：cooked 数组 + .raw = raw 数组（tag(s, ...v) 的 s.raw 可用）
    tagged_strings: (cooked, raw) => {
      const c = toJS(cooked) || [], r = toJS(raw) || [];
      const o = Array.from(c);
      Object.defineProperty(o, "raw", { value: r, enumerable: false, configurable: true, writable: true });
      return tagHandle(o);
    },
    spread_into: (acc, x) => {
      const a2 = arrRead(acc);
      for (const v of toJS(x)) a2.push(v);
      arrSetInPlace(acc, a2);
      return acc;
    },
    // 顶层函数作值（回调/别名/属性宿主）：包装为宿主 JS 函数，调用时按 arity 补 TAG 后直调 wasm 导出
    fn_value: (sid, arity) => {
      const nm = strings[sid];
      const n = arity | 0;
      fnCacheMap = fnCacheMap || new Map();
      const hit = fnCacheMap.get(nm);
      if (process.env.QZDBG) console.error("[dbg] fn_value", nm, "arity=", n, "cached=", hit !== undefined);
      if (hit !== undefined) return hit;                       // 同名 → 同一宿主句柄（属性/身份稳定）
      const hv = tagHandle(function (...as) {
        const f = exportsRef && exportsRef[nm];
        if (typeof f !== "function") throw new Error("fn_value: 未导出函数 " + nm);
        const a2 = as.slice(0, n).map(x => (x === undefined || x === null) ? TAG : bitsOf(x));   // JS 少传 = undefined → TAG
        while (a2.length < n) a2.push(TAG);
        return toJS(f(...a2));
      });
      fnCacheMap.set(nm, hv);
      return hv;
    },
    builtin_spread: (id, arr) => {
      const name = strings[id];
      const e2 = BUILTIN_FNS[name];
      let f = Array.isArray(e2) ? e2[0] : (e2 || (BUILTIN_CTORS.has(name) ? globalThis[name] : undefined));
      if (f === undefined && typeof globalThis[name] === "function") f = globalThis[name];
      if (typeof f !== "function") throw new Error("builtin_spread: 非函数 " + name);
      return ret(f.apply(null, toJS(arr) || []));
    },
    builtin_fn: (id) => {
      const name = strings[id];
      const e = BUILTIN_FNS[name];
      const f = Array.isArray(e) ? e[0] : (e || (BUILTIN_CTORS.has(name) ? globalThis[name] : undefined));
      if (typeof f !== "function") throw new Error("builtin_fn: 非函数 " + name);
      return tagHandle(f);
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
    bindClasses: (ex, cm) => { exportsRef = ex; classMeta = cm; tryRunModuleInit(); },   // 最后一次 bind → 触发模块初始化
    bindFields,
    bindBump,
    // 供宿主检查用（不在 wasm import 面）
    // 宿主 JS 值 → wasm 句柄位型：复用 bitsOf（string→0x7FFA 写回、array→0x7FFB、bool→num、其它→0x7FF9）。
    // 此前仅 number→numToBits、其余一律 tagHandle → 字符串入参得 0x7FF9 假句柄，wasm 侧 .length/concat
    // 落到 str_len 读垃圾，静默返回 0 / 丢操作数。修复后与 bitsOf/arrWriteback 语义一致。
    _toJS: toJS, _fromJS: (x) => bitsOf(x),
    _handles: handles, _TAG: TAG,
    // 闭包调用：闭包句柄 → wasm；宿主函数句柄（bind 结果/宿主回调）→ 直接调用（调用点无法静态区分）
    closure_call: (handle, a0, a1, a2, a3, recv) => {
      if (BigInt.asUintN(64, handle) >> 48n === HOST_HI) {
        const f = handles[idxOf(handle)];
        if (typeof f !== "function") throw new Error("closure_call: 非函数值");
        const as = [a0, a1, a2, a3].map(toJS);
        while (as.length && as[as.length - 1] === undefined) as.pop();
        return ret(f(...as));
      }
      return closureCall(handle, a0, a1, a2, a3, undefined, recv);
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
