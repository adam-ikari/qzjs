#!/usr/bin/env node
// bench/aot-product/run_wamr.js — WAMR 侧档位：qzjs-interp / wasm-interp / wasm-AOT / node-JS
// WAMR 经 qzjs ext_wamr（fast-interp + AOT）。合并单 wasm（wasm-merge 终态）。
//
// 测量协议（brain aot-roadmap, 2026-11-25）：wasm JIT 与 AOT 必须分别测，每档都要同时
// 与 qzjs 纯解释和 node 比较。本脚本覆盖 WAMR 三档 + node-JS 对照；
// wasm-JIT 档（node WebAssembly / V8 TurboFan）由 run_inmod.mjs 单独提供，
// 两脚本各自输出按同一负载矩阵对照，不混为一档。
// Usage: node bench/aot-product/run_wamr.js
const { readFileSync, writeFileSync, statSync } = require('fs');
const { spawnSync } = require('child_process');
const { fileURLToPath } = require('url');

const ROOT = process.env.QZJS_ROOT || __dirname + '/../../';
const QZJS = process.env.QZJS || ROOT + 'build-master/qzjs';
const WAMRC = process.env.WAMRC || ROOT + 'deps/wamr/wamr-compiler/build/wamrc';
const MERGE_BIN = process.env.WASM_MERGE || '/home/gem/emsdk/upstream/bin/wasm-merge';
const SRC = __dirname + '/workloads/aotp.ts';
const PROD = __dirname + '/workloads/aotp_inmod.wasm';
const LIB = process.env.LIBQZVM || ROOT + 'build-inmod/src/qzvm/libqzvm.wasm';
const MERGED = '/tmp/aotp_merged.wasm';
const AOT = '/tmp/aotp_merged.aot';

const LOADS = [
  ['computeWork', 200000, 'num'],
  ['jsonWork', 50000, 'tagged'],
  ['validationWork', 20000, 'tagged'],
  ['mixedWork', 200000, 'tagged'],
  ['hpackIntBatch', 200000, 'num'],
  ['varintBatch', 200000, 'num'],
  ['hashBatch', 200000, 'num'],
  ['policyGate', 20000, 'tagged'],
];

// 1. compile product + merge
const { compileTS } = require(ROOT + 'src/qzvm/aot/emitter.js');
// jsonWork / validationWork wasm 负优化 → 回退 interp（与产品 glue 同口径）。
const info = compileTS(SRC, PROD, { inModuleLink: true, interp: ['jsonWork'] });
const strings = info.strings || [];
// build mode map from funcMeta
const modes = {};
for (const f of (info.funcMeta || [])) modes[f.name] = f.mode;
console.error('strings:', strings.length, 'modes:', JSON.stringify(modes));

// merge
const mergeArgs = [MERGE_BIN, LIB, 'qz', PROD, 'prod', '--rename-export-conflicts', '-o', MERGED];
spawnSync(MERGE_BIN, [LIB, 'qz', PROD, 'prod', '--rename-export-conflicts', '-o', MERGED], { cwd: ROOT, stdio: 'pipe' });
if (!statSync(MERGED).size) { console.error('merge failed'); process.exit(1); }
console.error('merged:', statSync(MERGED).size, 'bytes');

// 2. wamrc AOT
const wamrcR = spawnSync(WAMRC, ['-o', AOT, MERGED], { encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
if (wamrcR.status !== 0) {
  console.error('wamrc failed:', (wamrcR.stderr || '').slice(0, 200));
} else {
  console.error('aot:', statSync(AOT).size, 'bytes');
}

// 3. generate WAMR harness
function genHarness(wasmPath, tag) {
  const isAot = wasmPath.endsWith('.aot');
  return `
var MEM;
var STRINGS = ${JSON.stringify(strings)};
var MODES = ${JSON.stringify(modes)};
var INTERP = (function(){ ${info.interpJs || ''}
  return { jsonWork: typeof jsonWork === "function" ? jsonWork : null };
})();
var TAG = ${JSON.stringify(tag)};
var LOADS = ${JSON.stringify(LOADS.map(([n, a]) => [n, a]))};
function setStrTab(L) {
  var names = STRINGS;
  var tbl = 4 + names.length * 8;
  var bb = names.reduce(function(a,n){return a+n.length;},0);
  var base = L.alloc(tbl + bb + 16);
  var dv = new DataView(MEM.buffer), cur = base + tbl;
  dv.setUint32(base, names.length, true);
  for (var i=0;i<names.length;i++) {
    dv.setUint32(base+4+i*8, cur, true);
    dv.setUint32(base+8+i*8, names[i].length, true);
    for (var j=0;j<names[i].length;j++) new Uint8Array(MEM.buffer,cur,names[i].length)[j]=names[i].charCodeAt(j);
    cur += names[i].length;
  }
  L.__set_strtab(base);
}
var box = function(x){var d=new DataView(new ArrayBuffer(8));d.setFloat64(0,x);return d.getBigInt64(0);};
var unbox = function(b){var d=new DataView(new ArrayBuffer(8));d.setBigInt64(0,BigInt.asIntN(64,b));return d.getFloat64(0);};
var nm = function(r){return(typeof r==='bigint')?unbox(r):r;};
var callFn = function(name, arg) {
  var mode = MODES[name];
  if (mode === 'interp') return INTERP[name](arg);   // jsonWork / validationWork 回退 interp（裸 JS 值）
  if (mode === 'tagged') return L[name](box(arg));
  return L[name](arg);
};
var L;
globalThis.qzjs.fs.readFileBinary(${JSON.stringify(wasmPath)}).then(function(bytes) {
  try {
    var mod = new WebAssembly.Module(bytes);
    var inst = new WebAssembly.Instance(mod, {
      wasi_snapshot_preview1: {
        clock_time_get:function(id,p,ptr){if(MEM){var d=new DataView(MEM.buffer);d.setUint32(ptr,0,true);d.setUint32(ptr+4,0,true);}return 0;},
        fd_close:function(){return 0;},
        fd_write:function(fd,iovs,n,nptr){if(MEM){var d=new DataView(MEM.buffer);d.setUint32(nptr,0,true);}return 0;},
        fd_seek:function(fd,off,wh,nptr){if(MEM){var d=new DataView(MEM.buffer);d.setUint32(nptr,0,true);d.setUint32(nptr+4,0,true);}return 0;},
        fd_fdstat_get:function(){return 0;}
      },
      qz_host: { drain:function(){return 0;}, fs_read:function(){return -1;} }
    });
    MEM = inst.exports.memory;
    L = inst.exports;
    var rt = L.qz_create(0, 0);
    if (!rt) { console.log("RESULT " + JSON.stringify({tag: TAG, error: "qz_create failed"})); return; }
    setStrTab(L);
    var out = [];
    for (var li=0; li<LOADS.length; li++) {
      var name = LOADS[li][0], arg = LOADS[li][1];
      var checkVal = null, err = null;
      try { checkVal = nm(callFn(name, arg)); } catch(e) { err = String(e && e.message || e); }
      if (err) { out.push({tag: TAG, load: name, N: arg, error: err.slice(0,60)}); continue; }
      var ts = [];
      for (var r=0; r<5; r++) { var t = performance.now(); callFn(name, arg); ts.push(performance.now()-t); }
      ts.sort(function(a,b){return a-b;});
      out.push({tag: TAG, load: name, N: arg, p50_ms: +ts[2].toFixed(3), p95_ms: +ts[4].toFixed(3), check: checkVal});
    }
    console.log("RESULT " + JSON.stringify(out));
  } catch(e) {
    console.log("RESULT " + JSON.stringify({tag: TAG, error: String(e && e.message || e).slice(0,80)}));
  }
}).catch(function(e){ console.log("RESULT " + JSON.stringify({tag: TAG, error: "READ:" + String(e).slice(0,60)})); });
`;
}

function runQzjs(jsCode, tag) {
  const f = '/tmp/aotp_' + tag + '.js';
  writeFileSync(f, jsCode);
  const r = spawnSync(QZJS, [f], { encoding: 'utf8', timeout: 300000 });
  const m = (r.stdout || '').match(/RESULT (\[.*\]|\{.*\})/);
  if (!m) { console.error(tag, 'no RESULT. stderr:', (r.stderr||'').slice(0,200)); return []; }
  return JSON.parse(m[1]);
}

// node-JS 对照档：同一份 interpSrc（等价 JS）直接跑在 node/V8 上。
function runNode(jsCode, tag) {
  const f = '/tmp/aotp_' + tag + '.js';
  writeFileSync(f, jsCode);
  const r = spawnSync(process.execPath, [f], { encoding: 'utf8', timeout: 300000 });
  const m = (r.stdout || '').match(/RESULT (\[.*\]|\{.*\})/);
  if (!m) { console.error(tag, 'no RESULT. stderr:', (r.stderr||'').slice(0,200)); return []; }
  return JSON.parse(m[1]);
}

// 4. qzjs interp baseline
function interpSrc(loads) {
  return `
function jsonWork(n){ const src='{"id":7,"name":"alice","tags":["a","b","c"],"vals":[1,2,3,4]}'; let t=0;
  for(let i=0;i<n;i++){ const o=JSON.parse(src); const m={id:o.id+i,name:o.name,total:o.vals[0]+o.vals[1]+o.vals[2]+o.vals[3]}; t=t+m.id+m.total+m.name.length; } return t; }
function computeWork(n){ let s=0; for(let i=0;i<n;i++){ const a=i%1000; const v=a*a; s=(s+v-((v/7)|0)+((i*3)%13))%1000003; } return s; }
function validate(v){ if(v===null||typeof v!=="object") return -1; let e=0;
  if(typeof v.name!=="string") e=e+1; else if(v.name.length<2) e=e+1;
  if(typeof v.age!=="number") e=e+1; else if(v.age<0) e=e+1;
  if(typeof v.email!=="string") e=e+1; else if(v.email.indexOf("@")<0) e=e+1; return e; }
function mixedWork(n){ const cfg={mul:3}; const base=cfg.mul; let s=0; for(let i=0;i<n;i++){ const a=i%1000; const v=a*a; s=(s+v-((v/7)|0)+((i*3)%13))%1000003; } return s+(base>0?0:1); }
function validationWork(n){ const good={name:"Alice",age:30,email:"a@b.com"}; const bad={name:"",age:200,email:"nope"}; let t=0;
  for(let i=0;i<n;i++){ if((i%2)===0) t=t+validate(good); else t=t+validate(bad); } return t; }

function hpackIntBatch(n){ let t=0; for(let i=0;i<n;i++){ let v=(i*7919)>>>0; let len=1; while(v>0x7f){ v=v>>>7; len=len+1; } t=t+len; } return t; }
function varintBatch(n){ let t=0; for(let i=0;i<n;i++){ let v=(i*104729)%2147483647; let len=1; while(v>0x7f){ v=v>>>7; len=len+1; } t=t+len; } return t; }
function hashBatch(n){ let h=2166136261%16777216; for(let i=0;i<n;i++){ h=(h^(i*7919))%16777216; h=(h*33)%16777216; } return h; }
function policyScore(c){ let s=0; if(c.retry<0)s=s+1; if(c.timeout>5000)s=s+1; if(c.name.length<3)s=s+1; return s; }
function policyGate(n){ const strict={retry:3,timeout:1000,name:"strict-mode"},loose={retry:-1,timeout:9000,name:"x"}; let t=0; for(let i=0;i<n;i++){ if((i%2)===0)t=t+policyScore(strict); else t=t+policyScore(loose); } return t; }
const L = ${JSON.stringify(loads.map(([n,a])=>[n,a]))};
const FN = { computeWork, jsonWork, validationWork, mixedWork, hpackIntBatch, varintBatch, hashBatch, policyGate };
const out = [];
for (const [name, arg] of L) { if (!FN[name]) { out.push({ load: name, skip: true }); continue; } FN[name](arg);
  const ts=[]; for(let r=0;r<5;r++){ const t=performance.now(); FN[name](arg); ts.push(performance.now()-t); }
  ts.sort((a,b)=>a-b); out.push({tag:"qzjs-interp", load: name, N: arg, p50_ms:+ts[2].toFixed(3), p95_ms:+ts[4].toFixed(3)}); }
console.log("RESULT " + JSON.stringify(out));
`;
}

// Run all 3 tiers
console.error('\n=== running qzjs interp ===');
const interpRes = runQzjs(interpSrc(LOADS), 'interp');

console.error('=== running node-JS (V8 JS reference) ===');
const nodeRes = runNode(interpSrc(LOADS), 'node-js');

console.error('=== running WAMR interp (fast-interp) ===');
const wamrInterpRes = runQzjs(genHarness(MERGED, 'WAMR-interp'), 'wamr-interp');

console.error('=== running WAMR AOT ===');
let wamrAotRes = [];
if (statSync(AOT).size) {
  wamrAotRes = runQzjs(genHarness(AOT, 'WAMR-AOT'), 'wamr-aot');
} else {
  wamrAotRes = [{tag:'WAMR-AOT', error:'wamrc failed — no .aot'}];
}

// 5. build table
const tiers = [
  { tag: 'qzjs-interp', data: interpRes },
  { tag: 'node-JS', data: nodeRes },
  { tag: 'WAMR-interp', data: wamrInterpRes },
  { tag: 'WAMR-AOT', data: wamrAotRes },
];
const loads = LOADS.map(([n]) => n);
console.log('\n=== 3 负载 × 3 档 (WAMR fast-interp + AOT, qzjs ext_wamr) ===');
const rows = [];
for (const load of loads) {
  for (const tier of tiers) {
    const d = tier.data.find(x => x.load === load) || { error: 'no data' };
    const N = LOADS.find(([n]) => n === load)[1];
    rows.push({
      load, tier: tier.tag, N,
      p50_ms: d.p50_ms ?? '-',
      p95_ms: d.p95_ms ?? '-',
      check: d.check ?? d.error?.slice(0,30) ?? '-',
    });
  }
}
console.table(rows);

// ratios (WAMR / qzjs-interp — interp faster = ratio >1 means interp wins)
console.log('\n=== 比值 (qzjs-interp p50 / WAMR p50, >1 = WAMR 快) ===');
for (const load of loads) {
  const interp = interpRes.find(x => x.load === load);
  const wi = wamrInterpRes.find(x => x.load === load);
  const ao = wamrAotRes.find(x => x.load === load);
  const nd = nodeRes.find(x => x.load === load);
  const ip = interp?.p50_ms, wp = wi?.p50_ms, ap = ao?.p50_ms, np = nd?.p50_ms;
  console.log(`${load}: qzjs-interp/node-JS ${ip&&np?(ip/np).toFixed(2):'—'}×  WAMR-interp ${ip&&wp?(ip/wp).toFixed(2):'—'}×  WAMR-AOT ${ip&&ap?(ip/ap).toFixed(2):'—'}×`);
  console.log(`  (相对 node-JS: WAMR-interp ${np&&wp?(np/wp).toFixed(2):'—'}×  WAMR-AOT ${np&&ap?(np/ap).toFixed(2):'—'}×)`);
}
