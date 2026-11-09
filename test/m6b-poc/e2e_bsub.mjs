// M6b e2e：内建子类承载（class extends Map/Array/Error）经 C 侧 new_builtin_sub。
// 宿主真内建实例 + __qzClsId 标记 → method_call/instanceof 沿 classMeta 查本类链；
// 继承方法原生（Map.get / Array.push）、自有方法走 wasm 蹦床、字段默认值由 ctor 写宿主属性。
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WASI } from 'node:wasi';
import { serializeClassMeta, serializeFields, serializeLamSynth } from './clsmeta_ser.mjs';

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
const dir = mkdtempSync(join(tmpdir(), 'qzbsub-'));
const tsPath = join(dir, 'b.ts'), wasmPath = join(dir, 'b.wasm');
writeFileSync(tsPath, `
export class M extends Map<string, number> { x: number = 1; get2(k: string): number { return this.get(k) as number; } }
export function mTest(): number { const m = new M(); m.set("a", 7); return m.get2("a") + m.x + (m instanceof M ? 100 : 0) + (m instanceof Map ? 1000 : 0); }
export class A extends Array<number> { x: number = 5; sum(): number { let s = 0; for (let i = 0; i < this.length; i++) s += this[i]; return s; } }
export function aTest(): number { const a = new A(); a.push(1); a.push(2); return a.sum() + a.length * 10 + a.x * 100 + (a instanceof A ? 1000 : 0) + (a instanceof Array ? 10000 : 0); }
export class E extends Error { code: number = 42; }
export function eTest(): number { const e = new E("bad"); return (e.message === "bad" ? 1 : 0) + e.code * 10 + (e instanceof E ? 100 : 0) + (e instanceof Error ? 1000 : 0); }
export function ctorTest(): number { const m = new M(); const c: any = m.constructor; return (c === M ? 1 : 0) + (c === Map ? 10 : 0); }
export class MS extends Map<string, number> { addS(k: string, v: number): number { super.set(k, v); return super.get(k) as number; } }
export function msTest(): number { const m = new MS(); return m.addS("a", 5) + m.size * 10; }
export class OS extends Map<string, number> { set(k: string, v: number): any { return super.set(k, v * 10); } }
export function osTest(): number { const o = new OS(); o.set("k", 3); return (o.get("k") as number) + o.size * 10; }
export class SM extends Map<string, number> { static n = 0; bump(): number { (SM as any).n++; return (SM as any).n; } }
export function smTest(): number { const a = new SM(); a.bump(); a.bump(); return (SM as any).n + a.size * 10; }
`);
const info = compileTS(tsPath, wasmPath, { inModuleLink: true });

// strtab 注入
{
  const blob = info.strings.map((n) => Buffer.from(n, 'utf8'));
  const tbl = 4 + blob.length * 8;
  const base = L.alloc(tbl + blob.reduce((a, b) => a + b.length, 0) + 16);
  const v = view();
  v.setUint32(base, blob.length, true); let cur = base + tbl;
  blob.forEach((b, i) => { v.setUint32(base + 4 + i * 8, cur, true); v.setUint32(base + 8 + i * 8, b.length, true);
    new Uint8Array(mem.buffer, cur, b.length).set(b); cur += b.length; });
  L.__set_strtab(base);
}
if (info.trampSlots && info.lamMeta) serializeLamSynth(L, mem, info.lamMeta, info.trampSlots);
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

chk('mTest() Map 子类（继承 get/set + 自有 get2 + 字段 + instanceof）', unbox(P.mTest()), 7 + 1 + 100 + 1000);
chk('aTest() Array 子类（push/索引/length + 自有 sum + 字段 + instanceof）', unbox(P.aTest()), 3 + 20 + 500 + 1000 + 10000);
chk('eTest() Error 子类（message + 字段 code + instanceof Error）', unbox(P.eTest()), 1 + 420 + 100 + 1000);
chk('ctorTest() 实例 .constructor 回本类值（非内建）', unbox(P.ctorTest()), 1);
chk('msTest() super.set/get（内建父方法）', unbox(P.msTest()), 5 + 10);
chk('osTest() super.set（覆盖后越过覆写）', unbox(P.osTest()), 30 + 10);
chk('smTest() 内建子类静态字段', unbox(P.smTest()), 2 + 0);

L.qz_destroy(rt);
if (failed) { console.error(`FAIL: ${failed} 项`); process.exit(1); }
console.log('PASS: 内建子类承载（Map/Array/Error）经 C 侧 new_builtin_sub + __qzClsId 派发');
