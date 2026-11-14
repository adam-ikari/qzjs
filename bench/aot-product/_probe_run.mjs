// 隔离 tagged 路径崩溃点。compileTS 内联 TS → inmod 跑，逐函数 catch trap。
import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';
const LIB = new URL('../../build-inmod/src/qzvm/libqzvm.wasm', import.meta.url).pathname;
const { compileTS } = await import('../../src/qzvm/aot/emitter.js');
const src = new URL('./_probe.ts', import.meta.url).pathname;
const prodPath = new URL('./_probe_inmod.wasm', import.meta.url).pathname;
compileTS(src, prodPath, { inModuleLink: true });
const wasi = new WASI({ version: 'preview1' });
const li = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(LIB)),
  { wasi_snapshot_preview1: wasi.wasiImport, qz_host: { fs_read: () => 0, drain: () => 0 } });
wasi.initialize(li);
const L = li.exports; const rt = L.qz_create(0, 0); const mem = L.memory;
const prod = new WebAssembly.Module(readFileSync(prodPath));
const qz = { memory: mem, __indirect_function_table: L.__indirect_function_table };
const missing = [];
for (const im of WebAssembly.Module.imports(prod)) { if (im.module === 'qz' && im.kind === 'function') { if (typeof L[im.name] === 'function') qz[im.name] = L[im.name]; else missing.push(im.name); } }
if (missing.length) { console.error('MISSING', missing.join(' ')); process.exit(1); }
const P = new WebAssembly.Instance(prod, { qz, wasi_snapshot_preview1: wasi.wasiImport }).exports;
const view = () => new DataView(mem.buffer);
const box = (x) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x); return d.getBigInt64(0); };
const unbox = (b) => { const d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, BigInt.asIntN(64, b)); return d.getFloat64(0); };
const writeStr = (s) => { const b = Buffer.from(s, 'utf8'); const off = L.alloc(b.length + 4); const v = view(); v.setUint32(off, b.length, true); new Uint8Array(mem.buffer, off + 4, b.length).set(b); return (0x7FFAn << 48n) | BigInt(off); };
const readStr = (h) => { const off = Number(BigInt.asUintN(64, h) & 0xFFFFFFFFn); return new TextDecoder().decode(new Uint8Array(mem.buffer, off + 4, view().getUint32(off, true))); };
const callN = (name, ...a) => {
  const norm = (r) => (typeof r === 'bigint') ? 'tagged_num=' + unbox(r) : r;
  try { return norm(P[name](...a)); }
  catch (e) {
    if (/BigInt/.test(String(e)) && a.length) { try { return norm(P[name](...a.map(x => typeof x === 'number' ? box(x) : x))); } catch (e2) { return 'ERR2:' + e2.message; } }
    return 'ERR:' + e.message;
  }
};
console.log('t1 objLiteral+read   =', callN('t1'));
console.log('t2 propWrite+read    =', callN('t2'));
console.log('t3 typeof+length     =', callN('t3'));
console.log('t4 indexOf           =', callN('t4'));
console.log('t5 JSON.parse(num)   =', callN('t5', writeStr('{"a":1}')));
console.log('t6 JSON.parse→prop   =', callN('t6', writeStr('{"id":7}')));
console.log('t7 full validate     =', callN('t7'));
console.log('t7 full validate     =', callN('t7'));
for (const N of [10, 100, 500]) {
  console.log('t8 numLoop N='+N+'     =', callN('t8', N));
  console.log('t9 valLoop  N='+N+'     =', callN('t9', N));
  console.log('t10 valWork N='+N+'    =', callN('t10', N));
}
L.qz_destroy(rt);