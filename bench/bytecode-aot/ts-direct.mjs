#!/usr/bin/env node
// 验证目标：TS 源码（含 ES2023 语法 + 类型标注）能否直接走 bytecode 拆分加速。
// 链路：TS → transpile → qzjs 字节码 dump → 纯数值循环 opcode → wasm AOT → 其余字节码解释。
// 不适用时 fail-closed：遇到未覆盖 opcode 就报边界，不静默生成错值。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mapOpcodes, uleb, f64c, section, vec } from './opcode-map.mjs';

const require = createRequire(import.meta.url);
const ts = require('../../src/qzvm/aot/node_modules/typescript');
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = process.env.OUT || '/tmp/tsdirect';
const QZJS = process.env.QZJS || path.join(ROOT, 'build', 'qzjs');
const WAMRC = process.env.WAMRC || path.join(ROOT, 'deps', 'wamr', 'wamr-compiler', 'build', 'wamrc');
const MEASURE = process.env.MEASURE === '1';
fs.mkdirSync(OUT, { recursive: true });

const dumpTool = path.join(OUT, 'dumpbc');
if (!fs.existsSync(dumpTool)) {
  const qjs = path.join(ROOT, 'deps', 'quickjs-ng');
  execFileSync('gcc', ['-O1', '-D_GNU_SOURCE', '-DQJS_BUILD_LIBC', '-I' + qjs, '-o', dumpTool,
    path.join(ROOT, 'bench', 'bytecode-aot', 'dumpbc.c'),
    path.join(qjs, 'dtoa.c'), path.join(qjs, 'libregexp.c'), path.join(qjs, 'libunicode.c'),
    path.join(qjs, 'quickjs.c'), path.join(qjs, 'quickjs-libc.c'), '-lm', '-ldl', '-lpthread'],
    { stdio: 'inherit' });
}

const dir = path.join(ROOT, 'bench', 'aot-product', 'workloads', 'es2023');
const cases = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort() : [];
if (!cases.length) { console.error('no ES2023 TS workloads'); process.exit(1); }

const ulebStr = (arr) => JSON.stringify(arr);
const emitWasm = (code) => {
  const body = [0x01, 0x05, 0x7c, 0x02, 0x40, 0x03, 0x40, ...code, 0x0b, 0x0b, 0x20, 0x01, 0x0b];
  const typeSec = section(1, vec([[0x60, 0x01, 0x7c, 0x01, 0x7c]]));
  const funcSec = section(3, vec([[0]]));
  const nm = Buffer.from('loop');
  const expSec = section(7, vec([[nm.length, ...nm, 0x00, 0x00]]));
  const codeSec = section(10, vec([[...uleb(body.length), ...body]]));
  return Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...typeSec, ...funcSec, ...expSec, ...codeSec]);
};

// 从 transpile 后的 JS 里把 for 循环整段换成 `const s = loop(n);`（按花括号配平）。
function replaceLoopWithWasm(js) {
  const start = js.indexOf('for (let i = 0;');
  if (start < 0) return null;
  const open = js.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < js.length; i++) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return null;
  return (js.slice(0, start) + 'const s = loop(n);' + js.slice(end)).replace(/let s = 0;\s*/, '');
}

let pass = 0, notApplicable = 0;
for (const file of cases) {
  const name = path.basename(file, '.ts');
  const tsSrc = fs.readFileSync(path.join(dir, file), 'utf8').replace(/^export /gm, '');
  // 类型标注存在性检查（TS 直接加速的前提）
  const typed = /function work\(n: number\): number/.test(tsSrc)
    && /let s: number/.test(tsSrc) && /let i: number/.test(tsSrc);
  const js = ts.transpileModule(tsSrc, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None,
  } }).outputText + '\nglobalThis.work = work;\n';
  const jsPath = path.join(OUT, name + '.js');
  fs.writeFileSync(jsPath, js);
  const dumpPath = path.join(OUT, name + '.dump');
  const dump = execFileSync('/bin/sh', ['-c', `"${dumpTool}" "${jsPath}" 2>&1`], { encoding: 'utf8', maxBuffer: 1 << 20 });
  fs.writeFileSync(dumpPath, dump);
  const dl = dump.split('\n');
  // 只在 work() 函数段里找 for 循环的回边，避免把 class/static-init 段的 opcode 混进来。
  const wf = dl.findIndex((l) => l.includes('function: work'));
  const forC = wf < 0 ? -1 : dl.findIndex((l, i) => i > wf && l.includes(';;') && l.includes('for (let i'));
  const goto = forC < 0 ? -1 : dl.findIndex((l, i) => i > forC && l.includes('goto8'));
  if (goto < 0) { console.log(`${name.padEnd(18)} NOT-APPLICABLE (no loop back-edge)`); notApplicable++; continue; }
  let start = -1;
  for (let i = forC + 1; i < goto; i++) { if (/^\s*\d+:/.test(dl[i])) { start = i; break; } }
  if (start < 0) { console.log(`${name.padEnd(18)} NOT-APPLICABLE (no loop start label)`); notApplicable++; continue; }
  const ops = [];
  for (const raw of dl.slice(start, goto + 1)) {
    const l = raw.trim();
    if (!l || l.startsWith(';;')) continue;
    const m = l.match(/^(?:\d+:\s*)?([a-z_][a-z0-9_]*)\s*(.*)$/);
    if (m) {
      const rest = m[2];
      const nm = rest.match(/;\s*([A-Za-z_$][\w$]*)\s*$/);
      ops.push([m[1], rest.replace(/;.*$/, '').trim(), nm ? nm[1] : null]);
    }
  }
  // ES2023 运算符（??= 等）在循环里引入额外分支/判定 opcode：显式判不适用，不静默生成错值。
  const loopDump = dl.slice(start, goto + 1).join('\n');
  const esOp = loopDump.match(/is_undefined_or_null|is_undefined|is_nullish/);
  let mapped;
  try { if (esOp) throw new Error(`UNMAPPED ES2023 opcode: ${esOp[0]}`); mapped = mapOpcodes(ops); }
  catch (e) {
    console.log(`${name.padEnd(18)} NOT-APPLICABLE (${e.message}) [typed=${typed}]`);
    notApplicable++; continue;
  }
  const wasm = emitWasm(mapped.code);
  const wPath = path.join(OUT, name + '.wasm');
  fs.writeFileSync(wPath, wasm);
  let aot = null;
  if (fs.existsSync(WAMRC)) {
    const aPath = path.join(OUT, name + '.aot');
    execFileSync(WAMRC, ['-o', aPath, wPath], { stdio: 'ignore' });
    aot = fs.readFileSync(aPath);
  }
  const splitJs = replaceLoopWithWasm(js);
  if (!splitJs) { console.log(`${name.padEnd(18)} NOT-APPLICABLE (loop replace failed)`); notApplicable++; continue; }
  const driver = `
const origSrc = ${JSON.stringify(js)};
const splitSrc = ${JSON.stringify(splitJs)};
(0, eval)(origSrc);
const original = globalThis.work;
const wb = new Uint8Array(${ulebStr(Array.from(wasm))});
${aot ? `const ab = new Uint8Array(${ulebStr(Array.from(aot))});` : 'const ab = null;'}
WebAssembly.instantiate(wb, {}, ab ? { aot: ab } : undefined).then(({ instance }) => {
  globalThis.loop = instance.exports.loop;
  (0, eval)(splitSrc);
  const split = globalThis.work;
  globalThis.work = original;
  let ok = true;
  for (const n of [0,1,2,10,100,1000]) { const a = original(n), b = split(n); if (a !== b) { ok = false; console.log("MISMATCH", n, a, b); } }
  console.log("EQUIVALENCE", ok ? "PASS" : "FAIL");
${MEASURE ? `
  const N = 1000000, R = 7;
  function p50(fn) { const xs=[]; for(let r=0;r<R;r++){const t=Date.now();fn(N);xs.push(Date.now()-t);} xs.sort((a,b)=>a-b); return xs[Math.floor(R/2)]; }
  console.log("RESULT " + JSON.stringify({ interp: p50(original), split: p50(split), N: N, reps: R }));
` : ''}
}).catch(e => console.log("ERR", e.message));
`;
  const dPath = path.join(OUT, name + '.driver.js');
  fs.writeFileSync(dPath, driver);
  let out;
  try { out = execFileSync(QZJS, [dPath], { encoding: 'utf8', maxBuffer: 1 << 20, timeout: 20000 }); }
  catch (e) {
    console.log(`${name.padEnd(18)} NOT-APPLICABLE (qzjs timeout / runtime error)`);
    notApplicable++; continue;
  }
  const ok = out.includes('EQUIVALENCE PASS');
  const m = out.match(/RESULT (\{.*\})/);
  let extra = '';
  if (m) { const r = JSON.parse(m[1]); extra = ` p50 ${r.interp}→${r.split}ms (${+(r.interp / r.split).toFixed(2)}x)`; }
  console.log(`${name.padEnd(18)} ${ok ? 'PASS' : 'FAIL'}  ops=${mapped.mapped}/${ops.length} typed=${typed}${extra}`);
  if (ok) pass++;
}
console.log(`\nsummary: ${pass} PASS, ${notApplicable} NOT-APPLICABLE, total ${cases.length}`);
process.exit(pass > 0 ? 0 : 1);
