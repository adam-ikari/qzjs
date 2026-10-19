// M6b e2e：真实负载 cls.ts（三层继承 / 字段遮蔽 / 多参分派 / 动态化）跑 in-module 档。
// 断言集与 test_aot.js runClasses 一一对应——同一批真实语义，宿主换成 C 侧原语。
import { readFileSync, mkdtempSync } from 'node:fs';
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

const { compileTS } = await import('../../src/qzvm/aot/emitter.js');
const dir = mkdtempSync(join(tmpdir(), 'qzcls-'));
const wasmPath = join(dir, 'cls.wasm');
const info = compileTS(new URL('../../src/qzvm/aot/cls.ts', import.meta.url).pathname, wasmPath, { inModuleLink: true });

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

const unbox = (b) => { const d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, BigInt.asIntN(64, b)); return d.getFloat64(0); };
const toJS = (b) => {
  const u = BigInt.asUintN(64, b), hi = u >> 48n, off = Number(u & 0xFFFFFFFFn);
  if (hi === 0x7FFAn) { const l = new DataView(mem.buffer).getUint32(off, true);
    return new TextDecoder().decode(new Uint8Array(mem.buffer, off + 4, l)); }
  if (hi === 0x7FFCn) return !!(u & 1n);
  if (hi === 0x7FF9n) return off === 1 ? null : undefined;
  return unbox(b);
};
let failed = 0;
const chk = (l, got, want) => { const ok = Object.is(got, want); if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${l} = ${JSON.stringify(got)}${ok ? '' : ' want ' + JSON.stringify(want)}`); };

const call = (n) => {
  const m = info.funcMeta.find(f => f.name === n);
  if (P.__bump_reset) P.__bump_reset();
  const res = P[n]();
  if (m.mode === 'num') return res;
  const u = BigInt.asUintN(64, res);
  if (process.env.QZDBG && (u >> 48n) > 0x7FF0n) console.log(`  [dbg] ${n} tag=0x${(u >> 48n).toString(16)} off=${Number(u & 0xFFFFFFFFn)}`);
  return toJS(res);
};

chk('类.继承+super', call('dogRun'), 'hi woof/woof!');
chk('类.字段默认值+遮蔽', call('fieldRun'), 43);
chk('类.方法多参', call('argRun'), 7);
chk('类.合成ctor转发参', call('fwdRun'), 'bit/3');
chk('类.实例真值', call('truthyRun'), 5);
chk('类.逻辑赋值动态化', call('andAssignRun'), 300);
chk('类.嵌套实参', call('nestedArgRun'), 3520);
chk('类.前置自增字段', call('preFieldInc'), 4043);
chk('类.后置自增字段', call('postFieldInc'), 3004);
chk('类.前置自减字段', call('preFieldDec'), 202);
chk('类.后置自减字段', call('postFieldDec'), 302);
chk('类.字段自增循环', call('fieldIncLoop'), 2508);

L.qz_destroy(rt);
if (failed) { console.error(`FAIL: ${failed} 项`); process.exit(1); }
console.log('PASS: 真实负载 cls.ts（三层继承/字段遮蔽/多参分派）经 in-module 档');
