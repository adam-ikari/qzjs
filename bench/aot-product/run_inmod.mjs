#!/usr/bin/env node
// bench/aot-product/run_inmod.mjs — M6b 合并模块 bench：同批负载经 libqzvm（C 侧）端到端。
// 与 run.js 同口径：3 负载 × 5 次计时 → p50/p95（p95 取最大值）；载荷字节 = 产品 wasm。
// 依赖：build-inmod/src/qzvm/libqzvm.wasm（QZ_IN_MODULE 构建，cmake/wasm32.cmake）。
// 用法：node bench/aot-product/run_inmod.mjs [--libqzvm <path>]
import { readFileSync, statSync } from 'node:fs';
import { WASI } from 'node:wasi';

const LIB = process.argv.find((_, i) => process.argv[i - 1] === '--libqzvm')
  ?? new URL('../../build-inmod/src/qzvm/libqzvm.wasm', import.meta.url).pathname;

const { compileTS } = await import('../../src/qzvm/aot/emitter.js');
const src = new URL('./workloads/aotp.ts', import.meta.url).pathname;
const prodPath = new URL('./workloads/aotp_inmod.wasm', import.meta.url).pathname;
console.error('compile inModuleLink...');
compileTS(src, prodPath, { inModuleLink: true });
console.error('product wasm:', statSync(prodPath).size, 'B');

const wasi = new WASI({ version: 'preview1' });
const li = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(LIB)),
  { wasi_snapshot_preview1: wasi.wasiImport, qz_host: { fs_read: () => 0, drain: () => 0 } });
wasi.initialize(li);
const L = li.exports;
const rt = L.qz_create(0, 0);
const mem = L.memory;

const prod = new WebAssembly.Module(readFileSync(prodPath));
const qz = { memory: mem, __indirect_function_table: L.__indirect_function_table };
const missing = [];
for (const im of WebAssembly.Module.imports(prod)) {
  if (im.module !== 'qz' || im.kind !== 'function') continue;
  if (typeof L[im.name] === 'function') qz[im.name] = L[im.name];
  else missing.push(im.name);
}
if (missing.length) { console.error('MISSING_PRIMS', missing.join(' ')); process.exit(1); }
const P = new WebAssembly.Instance(prod, { qz, wasi_snapshot_preview1: wasi.wasiImport }).exports;

const view = () => new DataView(mem.buffer);
const box = (x) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x); return d.getBigInt64(0); };
const unbox = (b) => { const d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, BigInt.asIntN(64, b)); return d.getFloat64(0); };
// 探测 ABI：纯 num 函数 f64（普通 number）；触碰对象的函数 tagged i64（BigInt）。
function callFn(name, arg) {
  try { return P[name](arg); }
  catch (e) { if (/BigInt/.test(String(e))) return P[name](box(arg)); throw e; }
}
const norm = (r) => (typeof r === 'bigint') ? unbox(r) : r;

const LOADS = [['computeWork', 200000], ['jsonWork', 30000], ['validationWork', 200000]];
for (const [name, arg] of LOADS) {
  let w = null;
  try { w = norm(callFn(name, arg)); } catch (e) { console.log('RESULT', JSON.stringify({ load: name, err: String(e && e.message || e) })); continue; }
  const ts = [];
  for (let r = 0; r < 5; r++) { const t = performance.now(); callFn(name, arg); ts.push(performance.now() - t); }
  ts.sort((a, b) => a - b);
  console.log('RESULT', JSON.stringify({ load: name, p50_ms: +ts[2].toFixed(3), p95_ms: +(ts[4]).toFixed(3), ret: w }));
}
const N1 = 1000000;
try {
  const w0 = norm(callFn('tagLoop', N1));
  const tb = []; for (let r=0;r<5;r++){ const t=performance.now(); callFn('tagLoop', N1); tb.push(performance.now()-t); }
  tb.sort((a,b)=>a-b);
  console.log('RESULT', JSON.stringify({ load: 'tagLoop(alloc+read)', n: N1, p50_ms: +tb[2].toFixed(3), ns_per_op: +((tb[2]*1e6/N1)).toFixed(1), ret: w0 }));
} catch(e){ console.log('RESULT', JSON.stringify({ load:'tagLoop', err:String(e.message) })); }
L.qz_destroy(rt);