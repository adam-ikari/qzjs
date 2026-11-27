#!/usr/bin/env node
// 实验：真实 qzjs bytecode 的纯数值 opcode 区间 → wasm 片段，其余留 qzjs 解释
//
// 要验证的命题（用户 2026-11-26）：bytecode 拆分可以避免证明函数等价。
//   AST→wasm 要证明 wasm ≡ JS 源语义（整个函数）；
//   bytecode→wasm 只需证明 wasm 实现那几条 opcode（局部机械映射），
//   其余 opcode 仍由 qzjs 解释器执行同一份 bytecode。
//
// 本脚本用 build-dbg 的 quickjs-ng（ENABLE_DUMPS）导出 work() 的 opcode 流，
// 按 opcode 名把循环区间翻成 wasm；边界处的 s 交接给 qzjs 继续跑尾部 bytecode。
// 不做 TS↔wasm 等价证明，只做 opcode 级翻译 + 端到端 check 一致。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mapOpcodes, uleb, f64c, section, vec } from './opcode-map.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MEASURE = process.env.MEASURE === '1';
const QZJS = process.env.QZJS || path.join(ROOT, 'build', 'qzjs');
const WAMRC = process.env.WAMRC || path.join(ROOT, 'deps', 'wamr', 'wamr-compiler', 'build', 'wamrc');
const OUT = process.env.OUT || '/tmp/bcaot';
const DUMP = process.env.DUMP || path.join(OUT, 'work.dump');
fs.mkdirSync(OUT, { recursive: true });

// dumpbc 需要 ENABLE_DUMPS：直接编 quickjs-ng 源码（不定义 NDEBUG），不依赖 build-dbg。
const dumpTool = path.join(OUT, 'dumpbc');
if (!fs.existsSync(dumpTool)) {
  const qjs = path.join(ROOT, 'deps', 'quickjs-ng');
  execFileSync('gcc', [
    '-O1', '-D_GNU_SOURCE', '-DQJS_BUILD_LIBC', '-I' + qjs, '-o', dumpTool,
    path.join(ROOT, 'bench', 'bytecode-aot', 'dumpbc.c'),
    path.join(qjs, 'dtoa.c'), path.join(qjs, 'libregexp.c'), path.join(qjs, 'libunicode.c'),
    path.join(qjs, 'quickjs.c'), path.join(qjs, 'quickjs-libc.c'),
    '-lm', '-ldl', '-lpthread',
  ], { stdio: 'inherit' });
}
if (!fs.existsSync(DUMP)) {
  const cmd = `"${dumpTool}" "${path.join(ROOT, 'bench', 'bytecode-aot', 'work.js')}" 2>&1`;
  const dump = execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', maxBuffer: 1 << 20 });
  fs.writeFileSync(DUMP, dump);
}

// ── 1. 从真实 bytecode dump 抽循环区间的 opcode ────────────────────────
const lines = fs.readFileSync(DUMP, 'utf8').split('\n');
const start = lines.findIndex((l) => l.includes('13:') && l.includes('get_loc_check'));
if (start < 0) { console.error('loop start opcode not found'); process.exit(1); }
const end = lines.findIndex((l, i) => i > start && l.includes('goto8'));
if (end < 0) { console.error('loop end opcode not found'); process.exit(1); }
const ops = [];
for (const raw of lines.slice(start, end + 1)) {
  const l = raw.trim();
  if (!l || l.startsWith(';;')) continue;
  const m = l.match(/^(?:(\d+):\s*)?([a-z_][a-z0-9_]*)\s*(.*)$/);
  if (!m) continue;
  const rest = m[3];
  const vn = rest.match(/;\s*([A-Za-z_$][\w$]*)\s*$/);
  ops.push([m[2], rest.replace(/;.*$/, '').trim(), vn ? vn[1] : null,
    m[1] === undefined ? null : Number(m[1])]);
}
console.log('bytecode loop opcodes:', ops.length, ops.map((o) => o[0]).join(' '));

// ── 2. opcode → wasm f64 指令（局部机械映射，见 opcode-map.mjs） ─────────
const { code, mapped, ignored } = mapOpcodes(ops);
console.log('opcode mapping:', mapped, 'mapped,', ignored, 'ignored');

const body = [0x01, 0x05, 0x7c, 0x02, 0x40, 0x03, 0x40, ...code, 0x0b, 0x0b, 0x20, 0x01, 0x0b];
const typeSec = section(1, vec([[0x60, 0x01, 0x7c, 0x01, 0x7c]]));
const funcSec = section(3, vec([[0]]));
const nm = Buffer.from('loop');
const expSec = section(7, vec([[nm.length, ...nm, 0x00, 0x00]]));
const codeSec = section(10, vec([[...uleb(body.length), ...body]]));
const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...typeSec, ...funcSec, ...expSec, ...codeSec]);
const wasmPath = path.join(OUT, 'loop.wasm');
fs.writeFileSync(wasmPath, wasm);
// 关键：裸 wasm 在 qzjs 里走 WAMR Fast Interp（JIT 关闭），必须 wamrc 预编 AOT 才拿到机器码。
let aotBytes = null;
if (fs.existsSync(WAMRC)) {
  const aotPath = path.join(OUT, 'loop.aot');
  execFileSync(WAMRC, ['-o', aotPath, wasmPath], { stdio: 'inherit' });
  aotBytes = fs.readFileSync(aotPath);
  console.log('wamrc AOT:', aotPath, aotBytes.length, 'bytes');
} else {
  console.error('wamrc not found — wasm fragment will run in WAMR Fast Interp (no speedup)');
}

// ── 3. qzjs 里跑：原函数 vs wasm 循环 + qzjs 解释尾部 ──────────────────
const driver = `
const bytes = new Uint8Array(${JSON.stringify(Array.from(wasm))});
${aotBytes ? `const aot = new Uint8Array(${JSON.stringify(Array.from(aotBytes))});` : 'const aot = null;'}
WebAssembly.instantiate(bytes, {}, aot ? { aot: aot } : undefined).then(({ instance }) => {
const loop = instance.exports.loop;
function original(n) {
  let s = 0;
  for (let i = 0; i < n; i = i + 1) { const a = i % 1000; s = (s + a*a + ((i*3)%13)) % 1000003; }
  const tag = "v1";
  return s + tag.length;
}
function split(n) {
  const s = loop(n);
  const tag = "v1";
  return s + tag.length;
}
let ok = true;
for (const n of [0,1,2,10,100,1000,20000]) {
  const a = original(n), c = split(n);
  if (a !== c) { ok = false; console.log("MISMATCH", n, a, c); }
}
console.log("EQUIVALENCE", ok ? "PASS" : "FAIL");
${MEASURE ? `
const N = 1000000, REPS = 7;
function p50(fn) {
  const xs = [];
  for (let r = 0; r < REPS; r++) { const t = Date.now(); fn(N); xs.push(Date.now() - t); }
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)];
}
console.log("RESULT " + JSON.stringify({
  interp_qzjs_bytecode: p50(original),
  wasm_plus_bytecode: p50(split),
  N: N, reps: REPS,
}));
` : ''}
});
`;
const driverPath = path.join(OUT, 'driver.js');
fs.writeFileSync(driverPath, driver);
const out = execFileSync(QZJS, [driverPath], { encoding: 'utf8', maxBuffer: 1 << 20 });
console.log(out.trim());
console.log('wasm:', wasmPath, wasm.length, 'bytes');
if (MEASURE) {
  const m = out.match(/RESULT (\{.*\})/);
  if (!m) { console.error('no RESULT in qzjs output'); process.exit(2); }
  const r = JSON.parse(m[1]);
  console.log('\n=== bytecode split p50 (qzjs, N=' + r.N + ', reps=' + r.reps + ') ===');
  console.log('interp (qzjs bytecode):', r.interp_qzjs_bytecode, 'ms');
  console.log('wasm + bytecode tail :', r.wasm_plus_bytecode, 'ms');
  console.log('speedup              :', +(r.interp_qzjs_bytecode / r.wasm_plus_bytecode).toFixed(2) + 'x');
}
process.exit(out.includes('EQUIVALENCE PASS') ? 0 : 1);
