#!/usr/bin/env node
// bench/aot-product/run_inmod.mjs — M6b 合并模块 bench：负载经 libqzvm（C 侧）端到端。
// 同口径：每负载 inmod(wasm) vs qzjs-interp，5 次计时 p50/p95；载荷字节 = 产品 wasm。
// 依赖：build-inmod/src/qzvm/libqzvm.wasm（QZ_IN_MODULE，cmake/wasm32.cmake）。
//   QZJS=<qzjs>   默认 build-master/qzjs（解释器基线）
//   --libqzvm <path>
import { readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { WASI } from 'node:wasi';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const QZJS = process.env.QZJS || ROOT + 'build-master/qzjs';
const LIB = (process.argv.find((_, i) => process.argv[i - 1] === '--libqzvm'))
  ?? ROOT + 'build-inmod/src/qzvm/libqzvm.wasm';

const { compileTS } = await import(ROOT + 'src/qzvm/aot/emitter.js');
const src = fileURLToPath(new URL('./workloads/aotp.ts', import.meta.url));
const prodPath = fileURLToPath(new URL('./workloads/aotp_inmod.wasm', import.meta.url));
const mergedPath = '/tmp/aotp_merged.wasm';
const info = compileTS(src, prodPath, { inModuleLink: true });
// strtab 注入：产物 strId → 名字须经宿主写共享内存 + __set_strtab(base)，否则
// qz_str_by_id 按无表返回 NULL → JSON.parse/属性名/方法名查不到（静默 0）。
const setStrTab = (names) => {
  const blob = names.map((n) => Buffer.from(n, 'utf8'));
  const tbl = 4 + blob.length * 8;
  const base = L.alloc(tbl + blob.reduce((a, b) => a + b.length, 0) + 16);
  const v = new DataView(mem.buffer);
  v.setUint32(base, blob.length, true);
  let cur = base + tbl;
  blob.forEach((b, i) => { v.setUint32(base + 4 + i * 8, cur, true); v.setUint32(base + 8 + i * 8, b.length, true);
    new Uint8Array(mem.buffer, cur, b.length).set(b); cur += b.length; });
  L.__set_strtab(base);
};

const MERGE = process.argv.includes('--merge');
const WASM_MERGE = process.env.WASM_MERGE || '/home/gem/emsdk/upstream/bin/wasm-merge';

const wasi = new WASI({ version: 'preview1' });
let L, P, mem, rt;
if (MERGE) {
  // 终态：静态单模块——emitter 产物 + libqzvm 合并，qz.* 内化为模块内调用（无 import）。
  const { spawnSync: ss } = await import('node:child_process');
  const r = ss(WASM_MERGE, [LIB, 'qz', prodPath, 'prod', '--rename-export-conflicts', '-o', mergedPath], { encoding: 'utf8' });
  if (r.status !== 0) { console.error('wasm-merge FAIL:', r.stderr); process.exit(1); }
  const inst = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(mergedPath)),
    { wasi_snapshot_preview1: wasi.wasiImport, qz_host: { fs_read: () => 0, drain: () => 0 } });
  wasi.initialize(inst);
  L = inst.exports;
  if (!L.qz_create) { console.error('merged: qz_create missing'); process.exit(1); }
  rt = L.qz_create(0, 0);
  if (!rt) { console.error('merged: qz_create FAIL'); process.exit(1); }
  mem = L.memory;
  P = L; // 同一模块：产品函数与 qzvm 内部直调
  console.error('merged single-module ok (qz.* internalized)');
} else {
  // 中间态：multi-module 动态链接（量税用途，非交付形态）
  const li = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(LIB)),
    { wasi_snapshot_preview1: wasi.wasiImport, qz_host: { fs_read: () => 0, drain: () => 0 } });
  wasi.initialize(li);
  L = li.exports; rt = L.qz_create(0, 0); mem = L.memory;
  const prod = new WebAssembly.Module(readFileSync(prodPath));
  const qz = { memory: mem, __indirect_function_table: L.__indirect_function_table };
  const missing = [];
  for (const im of WebAssembly.Module.imports(prod)) { if (im.module === 'qz' && im.kind === 'function') { if (typeof L[im.name] === 'function') qz[im.name] = L[im.name]; else missing.push(im.name); } }
  if (missing.length) { console.error('MISSING_PRIMS', missing.join(' ')); process.exit(1); }
  P = new WebAssembly.Instance(prod, { qz, wasi_snapshot_preview1: wasi.wasiImport }).exports;
}
setStrTab(info.strings || []);   // 注入产物字符串表（strId → 名字）
const box = (x) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x); return d.getBigInt64(0); };
const unbox = (b) => { const d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, BigInt.asIntN(64, b)); return d.getFloat64(0); };
const callFn = (name, arg) => { try { return P[name](arg); } catch (e) { if (/BigInt/.test(String(e))) return P[name](box(arg)); throw e; } };
const norm = (r) => (typeof r === 'bigint') ? unbox(r) : r;

// qzjs 解释器基线（同语义 JS，同 N）
function interpSrc(loads) {
  return `
function jsonWork(n){ const src='{"id":7,"name":"alice","tags":["a","b","c"],"vals":[1,2,3,4]}'; let t=0;
  for(let i=0;i<n;i++){ const o=JSON.parse(src); const m={id:o.id+i,name:o.name,total:o.vals[0]+o.vals[1]+o.vals[2]+o.vals[3]}; t=t+m.id+m.total+m.name.length; } return t; }
function computeWork(n){ let s=0; for(let i=0;i<n;i++){ const a=i%1000; const v=a*a; s=(s+v-((v/7)|0)+((i*3)%13))%1000003; } return s; }
function validate(v){ if(v===null||typeof v!=="object") return -1; let e=0;
  if(typeof v.name!=="string") e=e+1; else if(v.name.length<2) e=e+1;
  if(typeof v.age!=="number") e=e+1; else if(v.age<0) e=e+1;
  if(typeof v.email!=="string") e=e+1; else if(v.email.indexOf("@")<0) e=e+1; return e; }
function validationWork(n){ const good={name:"Alice",age:30,email:"a@b.com"}; const bad={name:"",age:200,email:"nope"}; let t=0;
  for(let i=0;i<n;i++){ if((i%2)===0) t=t+validate(good); else t=t+validate(bad); } return t; }
const L = ${JSON.stringify(loads)};
const FN = { computeWork, jsonWork, validationWork };
const out = [];
for (const [name, arg] of L) { if (!FN[name]) { out.push({ load: name, skip: true }); continue; } FN[name](arg);
  const ts=[]; for(let r=0;r<5;r++){ const t=performance.now(); FN[name](arg); ts.push(performance.now()-t); }
  ts.sort((a,b)=>a-b); out.push({ load: name, p50_ms:+ts[2].toFixed(3), p95_ms:+ts[4].toFixed(3) }); }
console.log("INTERP " + JSON.stringify(out));
`;
}

function benchInterp(loads) {
  const f = '/tmp/aotp_interp.js';
  writeFileSync(f, interpSrc(loads));
  const r = spawnSync(QZJS, [f], { encoding: 'utf8', timeout: 120000 });
  const m = (r.stdout || '').match(/INTERP (\[.*\])/);
  return m ? JSON.parse(m[1]) : [];
}

const VALIDATION_N = Number(process.env.VALIDATION_N) || 500;
const LOADS = [['computeWork', 200000], ['jsonWork', 500], ['validationWork', VALIDATION_N]]; // jsonWork: JSON.parse 返回 host 对象，wasm 读属性 NaN → 结构性缺口
const rows = [];
for (const [name, arg] of LOADS) {
  let inP50 = null, ret = null, err = null;
  try { ret = norm(callFn(name, arg)); const ts = []; for (let r = 0; r < 5; r++) { const t = performance.now(); callFn(name, arg); ts.push(performance.now() - t); } ts.sort((a, b) => a - b); inP50 = +ts[2].toFixed(3); }
  catch (e) { err = String(e && e.message || e); }
  rows.push({ load: name, N: arg, inmod_p50_ms: inP50 ?? err, ret });
}
const interp = benchInterp(LOADS);
for (const r of rows) { const il = interp.find(x => x.load === r.load); r.interp_p50_ms = il ? il.p50_ms : null; r.ratio = (r.inmod_p50_ms && il && il.p50_ms) ? +(il.p50_ms / r.inmod_p50_ms).toFixed(2) : null; }

// 边界税：tagLoop（POJO alloc+read 内联）per-op
let taxNs = null;
try { const N1 = 1000000; norm(callFn('tagLoop', N1)); const tb = []; for (let r = 0; r < 5; r++) { const t = performance.now(); callFn('tagLoop', N1); tb.push(performance.now() - t); } tb.sort((a, b) => a - b); taxNs = +(tb[2] * 1e6 / N1).toFixed(1); } catch (e) { taxNs = 'ERR:' + e.message; }

L.qz_destroy(rt);
console.log('\n=== bench/aot-product (M6b 合并模块, host) ===');
console.table(rows);
console.log(`载荷字节: ${MERGE ? '合并单 wasm ' + statSync(mergedPath).size + ' B' : '产品 wasm ' + statSync(prodPath).size + ' B'}`);
console.log(`边界税 tagLoop(POJO 内联 alloc+read): ${taxNs} ns/op（非内联 qz.* call PoC ~54ns ≤ 100ns）`);
console.log('G1(热点计算≥3×): computeWork ' + (rows[0].ratio ?? '?') + '× ' + ((rows[0].ratio ?? 0) >= 3 ? '✓ 达标' : '✗'));
console.log('G2(翻转≥1.5×): validationWork ' + (rows[2].ratio ?? '?') + '× ' + ((rows[2].ratio ?? 0) >= 1.5 ? '✓ 达标' : '✗'));
