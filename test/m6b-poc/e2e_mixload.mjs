// M6b e2e：真实负载 mix.ts（仓库既有基准负载）跑 in-module 档全链路。
// 与 test_aot.js 的 runTagged 同一批断言，但宿主是 libqzvm.wasm（C 侧原语），
// 不是 JS 侧的 qzvm.js —— 验证原语层能承载真实程序，而不只是合成用例。
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

const { compileTS } = await import('../../src/qzvm/aot/emitter.js');
const dir = mkdtempSync(join(tmpdir(), 'qzmix-'));
const wasmPath = join(dir, 'mix.wasm');
// mix.ts 的函数无 export → 直接编译仓库文件（emitter 对非 export 函数也生成导出，见 funcMeta）
const info = compileTS(new URL('../../src/qzvm/aot/mix.ts', import.meta.url).pathname, wasmPath, { inModuleLink: true });

// strtab
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
if (info.classMeta && info.classMeta.length) serializeClassMeta(L, mem, info.classMeta);
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

const box = (x) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x); return d.getBigInt64(0); };
const unbox = (b) => { const d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, BigInt.asIntN(64, b)); return d.getFloat64(0); };
// tagged 字符串句柄 0x7FFA|off → JS 串
const toJS = (b) => {
  const u = BigInt.asUintN(64, b), hi = u >> 48n, off = Number(u & 0xFFFFFFFFn);
  if (hi === 0x7FFAn) { const l = new DataView(mem.buffer).getUint32(off, true);
    return new TextDecoder().decode(new Uint8Array(mem.buffer, off + 4, l)); }
  if (hi === 0x7FFCn) return !!(u & 1n);
  if (hi === 0x7FF9n) return off === 1 ? null : off === 0 ? undefined : undefined;
  return unbox(b);
};
let failed = 0;
const chk = (l, got, want) => { const ok = Object.is(got, want); if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${l} = ${JSON.stringify(got)}${ok ? '' : ' want ' + JSON.stringify(want)}`); };

const meta = (n) => info.funcMeta.find(f => f.name === n);
const call = (n, a = []) => {
  const m = meta(n);
  if (P.__bump_reset) P.__bump_reset();
  /* num 模式 wasm 签名是 f64 → 传 number。
   * tagged 模式签名是 i64 → 必须传 BigInt；数值实参按 NaN-box 约定转位型。*/
  const conv = m.mode === 'num' ? a : a.map(x => typeof x === 'number' ? box(x) : x);
  const res = P[n](...conv);
  /* num 模式返回 wasm f64 = plain number；tagged 模式返回 i64 位型 → 解引用。*/
  return m.mode === 'num' ? res : toJS(res);
};

call('fib', [20]);   // 预热（首次调用分配表项）
chk('fib(20)', call('fib', [20]), 6765);
chk('numWork(3000)', call('numWork', [3000]), 66268200);
chk('objWork(5)', call('objWork', [5]), 40);
chk('bigAcc(3000)', call('bigAcc', [3000]), 3000000000000);
chk('arrWork(3)', call('arrWork', [3]), 6);
chk('arrGrowWrite()', call('arrGrowWrite', []), 102);
chk('strConcatEq()', call('strConcatEq', []), 11);

L.qz_destroy(rt);
if (failed) { console.error(`FAIL: ${failed} 项`); process.exit(1); }
console.log('PASS: 真实负载 mix.ts 经 in-module 档（C 侧原语）端到端');
