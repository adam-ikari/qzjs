// M6b e2e：in-module 档 POJO 物化（对象字面量/实例是 wasm 内存块，交给 C 侧内建
//   Object.keys/JSON.stringify/Object.freeze 时必须物化成真 JS 对象）。
// 覆盖三处必须成立的行为：键集与顺序、内建读值、freeze 后写抛 TypeError。
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WASI } from 'node:wasi';

const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const libPath = get('--libqzvm');
if (!libPath) { console.error('usage: --libqzvm <libqzvm.wasm>'); process.exit(2); }

const wasi = new WASI({ version: 'preview1' });
const li = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(libPath)),
  { wasi_snapshot_preview1: wasi.wasiImport, qz_host: { fs_read: () => 0, drain: () => 0 } });
wasi.initialize(li);
const L = li.exports, mem = L.memory;
const rt = L.qz_create(0, 0);
if (!rt) { console.error('FAIL: qz_create 返回 0'); process.exit(1); }
const view = () => new DataView(mem.buffer);
const box = (x) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x); return d.getBigInt64(0); };
const unbox = (b) => { const d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, BigInt.asIntN(64, b)); return d.getFloat64(0); };
const readStr = (h) => { const off = Number(BigInt.asUintN(64, h) & 0xFFFFFFFFn);
  return new TextDecoder().decode(new Uint8Array(mem.buffer, off + 4, view().getUint32(off, true))); };

let failed = 0;
const chk = (l, g, w) => { const ok = Object.is(g, w); if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${l} = ${JSON.stringify(g)}${ok ? '' : ' want ' + JSON.stringify(w)}`); };

// 注入字符串表：[count][off,len]×count + 字节块
const setStrTab = (names) => {
  const blob = names.map((n) => Buffer.from(n, 'utf8'));
  const tbl = 4 + blob.length * 8;
  const base = L.alloc(tbl + blob.reduce((a, b) => a + b.length, 0) + 16);
  const v = view();
  v.setUint32(base, blob.length, true);
  let cur = base + tbl;
  blob.forEach((b, i) => {
    v.setUint32(base + 4 + i * 8, cur, true);
    v.setUint32(base + 8 + i * 8, b.length, true);
    new Uint8Array(mem.buffer, cur, b.length).set(b);
    cur += b.length;
  });
  L.__set_strtab(base);
};

const { compileTS } = await import('../../src/qzvm/aot/emitter.js');
const { serializeFields, serializeClassMeta } = await import('./clsmeta_ser.mjs');
const dir = mkdtempSync(join(tmpdir(), 'qzpojo-'));
const tsPath = join(dir, 'p.ts'), wasmPath = join(dir, 'p.wasm');
writeFileSync(tsPath, `
class Pt { constructor(public x: number, public y: number) {} sum(): number { return this.x + this.y; } }
export function keys(): number { const o = { a: 1, b: 2 }; return Object.keys(o).length; }
export function kjoin(): string { const o = { a: 1, b: 2 }; return Object.keys(o).join(","); }
export function json(): string { const o = { a: 1, b: "x" }; return JSON.stringify(o); }
export function inst(): string { const p = new Pt(3, 4); return JSON.stringify(p); }
export function froz(): number { const o = { a: 7 }; Object.freeze(o);
  try { o.a = 9; } catch (e) { return -1; } return o.a; }
export function wr(): number { const o = { a: 7 }; o.a = 9; return o.a; }
export function vals(): number { const o = { a: 1, b: 2 }; return Object.values(o).length; }
export function ents(): number { const o = { a: 1, b: 2 }; return Object.entries(o).length; }
export function instKeys(): string { const p = new Pt(3, 4); return Object.keys(p).join(","); }
export function instMeth(): number { return new Pt(3, 4).sum(); }
export function frozenMeth(): number { const p = new Pt(3, 4); Object.freeze(p); return p.sum(); }   /* 冻结后方法仍可调（方法在原型）*/
`);
const info = compileTS(tsPath, wasmPath, { inModuleLink: true });
setStrTab(info.strings || []);
if (info.fields) serializeFields(L, mem, info.fields);
if (info.classMeta) serializeClassMeta(L, mem, info.classMeta);

const prod = new WebAssembly.Module(readFileSync(wasmPath));
const qz = { memory: mem, __indirect_function_table: L.__indirect_function_table };
const missing = [];
for (const im of WebAssembly.Module.imports(prod)) {
  if (im.module !== 'qz' || im.kind !== 'function') continue;
  if (typeof L[im.name] === 'function') qz[im.name] = L[im.name];
  else missing.push(im.name);
}
if (missing.length) { console.error('FAIL: libqzvm 缺原语 ' + missing.join(' ')); process.exit(1); }
const P = new WebAssembly.Instance(prod, { qz, wasi_snapshot_preview1: wasi.wasiImport }).exports;

// 每轮之间复位 bump 堆，模拟宿主逐次调用（缓存若按偏移保存就会在此暴露错值）
const call = (fn) => { if (P.__bump_reset) P.__bump_reset(); return fn(); };

chk('Object.keys({a,b}).length', unbox(call(() => P.keys())), 2);
chk('Object.keys({a,b}).join()', readStr(call(() => P.kjoin())), 'a,b');
chk('JSON.stringify({a:1,b:"x"})', readStr(call(() => P.json())), '{"a":1,"b":"x"}');
chk('JSON.stringify(new Pt(3,4)) 只含已赋字段', readStr(call(() => P.inst())), '{"x":3,"y":4}');
chk('freeze 后写 → TypeError → catch', unbox(call(() => P.froz())), -1);
chk('未冻结对象写生效', unbox(call(() => P.wr())), 9);
chk('Object.values({a,b}).length', unbox(call(() => P.vals())), 2);
chk('Object.entries({a,b}).length', unbox(call(() => P.ents())), 2);
chk('Object.keys(new Pt(3,4)) 不含方法', readStr(call(() => P.instKeys())), 'x,y');
chk('实例方法调用', unbox(call(() => P.instMeth())), 7);
chk('冻结实例后方法仍可调', unbox(call(() => P.frozenMeth())), 7);

if (failed) { console.error(`FAIL: ${failed} assertion(s)`); process.exit(1); }
console.log('PASS: in-module POJO 物化（keys/values/entries/json/实例/freeze/方法）');
