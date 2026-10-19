// M6b e2e：类（继承 + super + 动态实例化）经 C 侧 classMeta 传表 + call_indirect。
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WASI } from 'node:wasi';
import { serializeClassMeta, serializeFields } from './clsmeta_ser.mjs';

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

let failed = 0;
const chk = (l, g, w) => { const ok = Object.is(g, w); if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${l} = ${JSON.stringify(g)}${ok ? '' : ' want ' + JSON.stringify(w)}`); };

const { compileTS } = await import('../../src/qzvm/aot/emitter.js');
const dir = mkdtempSync(join(tmpdir(), 'qzcls-'));
const tsPath = join(dir, 'c.ts'), wasmPath = join(dir, 'c.wasm');
writeFileSync(tsPath, `
class P { constructor(public x: number, public y: number) {} sum(): number { return this.x + this.y; } }
export function mk(a: number, b: number): number { const p = new P(a, b); return p.sum(); }
class Q extends P { sum(): number { return super.sum() * 2; } }
export function mk2(a: number, b: number): number { return new Q(a, b).sum(); }
class Shape { constructor(public n: number) {} area(): number { return 0; } }
class Sq extends Shape { constructor(n: number) { super(n); } area(): number { return this.n * this.n; } }
export function polyTotal(): number {
  const xs: Shape[] = [new Sq(2), new Shape(9)];
  let s = 0;
  for (const x of xs) s += x.area();
  return s;
}
const mkCls = (n: number) => class { v(): number { return n; } };
const CA = mkCls(1), CB = mkCls(2);
export function classExprFactory(): number { return new CA() instanceof CB ? 1 : 0; }
export function higherOrder(n: number): number {
  const f = (x: number): number => x + 1;
  const g = (h: (x: number) => number, y: number): number => h(h(y));
  return g(f, n);
}
`);
const info = compileTS(tsPath, wasmPath, { inModuleLink: true });

// strtab 注入（method name 已加进 strings）
{
  const names = info.strings;
  const blob = names.map((n) => Buffer.from(n, 'utf8'));
  const tbl = 4 + blob.length * 8;
  const base = L.alloc(tbl + blob.reduce((a, b) => a + b.length, 0) + 16);
  const v = view();
  v.setUint32(base, blob.length, true); let cur = base + tbl;
  blob.forEach((b, i) => { v.setUint32(base + 4 + i * 8, cur, true); v.setUint32(base + 8 + i * 8, b.length, true);
    new Uint8Array(mem.buffer, cur, b.length).set(b); cur += b.length; });
  L.__set_strtab(base);
}
// classMeta 注入
serializeClassMeta(L, mem, info.classMeta);
if (info.fields) serializeFields(L, mem, info.fields);

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
chk('mk(3,4)', unbox(P.mk(box(3), box(4))), 7);
chk('mk2(3,4) 继承+super', unbox(P.mk2(box(3), box(4))), 14);
chk('polyTotal() 多态虚分派', unbox(P.polyTotal()), 4);      // Sq(2).area=4 + Shape(9).area=0
chk('higherOrder(5) 闭包+类共存', unbox(P.higherOrder(box(5))), 7);
chk('classExprFactory() 工厂产出独立类', unbox(P.classExprFactory()), 0);   // new A() instanceof B === false

L.qz_destroy(rt);
if (failed) { console.error(`FAIL: ${failed} 项`); process.exit(1); }
console.log('PASS: 类（继承 + super + 多态虚分派）与闭包共存，经 C 侧 classMeta 传表');
