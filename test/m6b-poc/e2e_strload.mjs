// M6b e2e：真实负载 strwork.ts（字符串拼接/复合赋值/字符串方法）跑 in-module 档。
// 断言集与 test_aot.js 字符串段一一对应；字符串是跨原语最重的路径。
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { WASI } from 'node:wasi';
import { serializeClassMeta, serializeFields, serializeLamSynth } from './clsmeta_ser.mjs';
const { compileTS } = await import('../../src/qzvm/aot/emitter.js');
const args = process.argv.slice(2);
const gi = args.indexOf('--libqzvm');
if (gi < 0) { console.error('usage: --libqzvm <libqzvm.wasm>'); process.exit(2); }
const LIB = args[gi + 1];
const wasi = new WASI({ version: 'preview1' });
const li = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(LIB)),
  { wasi_snapshot_preview1: wasi.wasiImport, qz_host: { fs_read: () => 0, drain: () => 0 } });
wasi.initialize(li);
const L = li.exports, mem = L.memory; L.qz_create(0, 0);
const dir = mkdtempSync(join(tmpdir(), 'str-'));
const wp = join(dir, 's.wasm');
const info = compileTS(new URL('../../src/qzvm/aot/strwork.ts', import.meta.url).pathname, wp, { inModuleLink: true });
{ const names = info.strings, blob = names.map(n => Buffer.from(n, 'utf8'));
  const tbl = 4 + blob.length * 8;
  const base = L.alloc(tbl + blob.reduce((a, b) => a + b.length, 0) + 16);
  const v = new DataView(mem.buffer); v.setUint32(base, blob.length, true); let cur = base + tbl;
  blob.forEach((b, i) => { v.setUint32(base+4+i*8, cur, true); v.setUint32(base+8+i*8, b.length, true);
    new Uint8Array(mem.buffer, cur, b.length).set(b); cur += b.length; });
  L.__set_strtab(base); }
if (info.fields) serializeFields(L, mem, info.fields);
if (info.classMeta && info.classMeta.length) serializeClassMeta(L, mem, info.classMeta);
const prod = new WebAssembly.Module(readFileSync(wp));
const qz = { memory: mem, __indirect_function_table: L.__indirect_function_table };
const missing=[];
for (const im of WebAssembly.Module.imports(prod)) if (im.module==='qz'&&im.kind==='function') {
  if (typeof L[im.name]==='function') qz[im.name]=L[im.name]; else missing.push(im.name); }
if (missing.length) { console.error('缺原语', missing.join(' ')); process.exit(1); }
const P = new WebAssembly.Instance(prod, { qz, wasi_snapshot_preview1: wasi.wasiImport }).exports;
const box = (x) => { const d=new DataView(new ArrayBuffer(8)); d.setFloat64(0,x); return d.getBigInt64(0); };
const toJS = (b) => { const u=BigInt.asUintN(64,b), hi=u>>48n, off=Number(u&0xFFFFFFFFn);
  if (hi===0x7FFAn){ const l=new DataView(mem.buffer).getUint32(off,true);
    return new TextDecoder().decode(new Uint8Array(mem.buffer, off+4, l)); }
  if (hi===0x7FF9n) return off===1?null:undefined;
  const d=new DataView(new ArrayBuffer(8)); d.setBigInt64(0,BigInt.asIntN(64,b)); return d.getFloat64(0); };
const call=(n,a=[])=>{ const m=info.funcMeta.find(f=>f.name===n); if(P.__bump_reset)P.__bump_reset();
  return toJS(P[n](...a.map(box))); };
let bad=0; const chk=(l,g,w)=>{const ok=Object.is(g,w);if(!ok)bad++;console.log(`${ok?'ok  ':'FAIL'} ${l} = ${JSON.stringify(g)}${ok?'':' want '+JSON.stringify(w)}`);};
chk('strWork(5)', call('strWork',[5]), '001234');
chk('strWork(0)', call('strWork',[0]), '0');
{ let ref='0'; for(let i=0;i<2000;i++) ref+=i; chk('strWork(2000)', call('strWork',[2000]), ref); }
chk('strWorkEq(5)', call('strWorkEq',[5]), '001234');
chk('strMethods()', call('strMethods'), 'Hello|HELLO, WORLD|7|e|Hello, qz|ababab');
if (bad) { console.error(`FAIL: ${bad} 项`); process.exit(1); }
console.log('PASS: 真实负载 strwork.ts（字符串拼接/方法）经 in-module 档');
