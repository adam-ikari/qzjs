// M6b e2e：类静态字段（lazy 初始化 + 读写）+ 对象字面量访问器。
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
const box = (x) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x); return d.getBigInt64(0); };
const unbox = (b) => { const d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, BigInt.asIntN(64, b)); return d.getFloat64(0); };
let failed = 0;
const chk = (l, g, w) => { const ok = Object.is(g, w); if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${l} = ${JSON.stringify(g)}${ok ? '' : ' want ' + JSON.stringify(w)}`); };

const { compileTS } = await import('../../src/qzvm/aot/emitter.js');
const dir = mkdtempSync(join(tmpdir(), 'qzst-'));
const tsPath = join(dir, 'c.ts'), wasmPath = join(dir, 'c.wasm');
writeFileSync(tsPath, `
class C {
  static n: number = 7;
  static inc(): number { C.n = C.n + 1; return C.n; }
}
export function statRead(): number { return C.n; }
export function statIncTwice(): number { C.inc(); return C.inc(); }
class Acc {
  private _v: number = 3;
  get v(): number { return this._v * 10; }
  set v(x: number) { this._v = x; }
}
export function accRead(): number { return new Acc().v; }
export function accWriteThenRead(): number { const a = new Acc(); a.v = 5; return a.v; }
`);
const info = compileTS(tsPath, wasmPath, { inModuleLink: true });
{
  const names = info.strings, blob = names.map(n => Buffer.from(n, 'utf8'));
  const tbl = 4 + blob.length * 8;
  const base = L.alloc(tbl + blob.reduce((a, b) => a + b.length, 0) + 16);
  const v = new DataView(mem.buffer);
  v.setUint32(base, blob.length, true); let cur = base + tbl;
  blob.forEach((b, i) => { v.setUint32(base + 4 + i * 8, cur, true); v.setUint32(base + 8 + i * 8, b.length, true);
    new Uint8Array(mem.buffer, cur, b.length).set(b); cur += b.length; });
  L.__set_strtab(base);
}
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

chk('statRead() 静态字段初值', unbox(P.statRead()), 7);
chk('statIncTwice() 静态字段写回', unbox(P.statIncTwice()), 9);
chk('accRead() getter', unbox(P.accRead()), 30);
chk('accWriteThenRead() setter+getter', unbox(P.accWriteThenRead()), 50);

L.qz_destroy(rt);
if (failed) { console.error(`FAIL: ${failed} 项`); process.exit(1); }
console.log('PASS: 类静态字段 + 对象访问器经 C 侧静态/访问器表');
