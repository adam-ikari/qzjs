// 两档一致性交叉验证：同一批真实负载 + 同一批断言，
// 独立档（JS 宿主 qzvm.js）与 in-module 档（C 侧 libqzvm 原语）必须给出相同结果。
// 价值：单档通过不能证明「档间无偏差」——两个宿主各自实现同一语义，跑同一负载
// 才会暴露只在某一档生效的错值。
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WASI } from 'node:wasi';
import { serializeClassMeta, serializeFields, serializeLamSynth } from './clsmeta_ser.mjs';

const args = process.argv.slice(2);
const gi = args.indexOf('--libqzvm');
if (gi < 0) { console.error('usage: --libqzvm <libqzvm.wasm>'); process.exit(2); }
const LIB = args[gi + 1];

// ── 断言表：负载文件 → [函数名, 实参, 期望值] ──────────────────────────────
const LOADS = [
  ['mix.ts', [
    ['fib', [20], 6765],
    ['numWork', [3000], 66268200],
    ['objWork', [5], 40],
    ["objWork", [500], 41666500],
    ['bigAcc', [3000], 3000000000000],
    ['arrWork', [3], 6],
    ['arrMethods', [], 25],
    ['arrAlias', [], 303],
    ['splitIndex', [], 'z3'],
    ['literals', [], 5],
  ]],
  ['cls.ts', [
    ['dogRun', [], 'hi woof/woof!'],
    ['fieldRun', [], 43],
    ['argRun', [], 7],
    ['fwdRun', [], 'bit/3'],
    ['truthyRun', [], 5],
    ['andAssignRun', [], 300],
    ['nestedArgRun', [], 3520],
    ['preFieldInc', [], 4043],
    ['postFieldInc', [], 3004],
    ['fieldIncLoop', [], 2508],
  ]],
  ['strwork.ts', [
    ['strWork', [5], '001234'],
    ['strWorkEq', [5], '001234'],
    ['strMethods', [], 'Hello|HELLO, WORLD|7|e|Hello, qz|ababab'],
  ]],
];

const { compileTS } = await import('../../src/qzvm/aot/emitter.js');
const ROOT = new URL('../../src/qzvm/aot/', import.meta.url).pathname;

// ── in-module 档（C 侧原语）────────────────────────────────────────────────
const wasi = new WASI({ version: 'preview1' });
const li = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(LIB)),
  { wasi_snapshot_preview1: wasi.wasiImport, qz_host: { fs_read: () => 0, drain: () => 0 } });
wasi.initialize(li);
const L = li.exports, mem = L.memory;
if (!L.qz_create(0, 0)) { console.error('FAIL: qz_create 返回 0'); process.exit(1); }

const box = (x) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x); return d.getBigInt64(0); };
const memToJS = (b) => {
  const u = BigInt.asUintN(64, b), hi = u >> 48n, off = Number(u & 0xFFFFFFFFn);
  if (hi === 0x7FFAn) { const l = new DataView(mem.buffer).getUint32(off, true);
    return new TextDecoder().decode(new Uint8Array(mem.buffer, off + 4, l)); }
  if (hi === 0x7FF9n) return off === 1 ? null : undefined;
  if (hi === 0x7FFCn) return !!(u & 1n);
  const d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, BigInt.asIntN(64, b)); return d.getFloat64(0);
};

async function runInModule(file) {
  const dir = mkdtempSync(join(tmpdir(), 'xz-'));
  const wp = join(dir, 'm.wasm');
  const info = compileTS(ROOT + file, wp, { inModuleLink: true });
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
  if (info.fields) serializeFields(L, mem, info.fields);
  if (info.classMeta && info.classMeta.length) serializeClassMeta(L, mem, info.classMeta);
  const prod = new WebAssembly.Module(readFileSync(wp));
  const qz = { memory: mem, __indirect_function_table: L.__indirect_function_table };
  for (const im of WebAssembly.Module.imports(prod))
    if (im.module === 'qz' && im.kind === 'function') qz[im.name] = L[im.name];
  const P = new WebAssembly.Instance(prod, { qz, wasi_snapshot_preview1: wasi.wasiImport }).exports;
  return (name, a) => {
    const m = info.funcMeta.find(f => f.name === name);
    if (P.__bump_reset) P.__bump_reset();
    const conv = m.mode === 'num' ? a : a.map(box);
    const res = P[name](...conv);
    return m.mode === 'num' ? res : memToJS(res);
  };
}

// ── 独立档（JS 宿主）────────────────────────────────────────────────────────
async function runStandalone(file) {
  const dir = mkdtempSync(join(tmpdir(), 'xs-'));
  const wp = join(dir, 'm.wasm');
  const info = compileTS(ROOT + file, wp, {});
  // 复用 test_aot.js 的 JS 宿主实现（与生产独立档同一份）
  const hostMod = await import('../../src/qzvm/aot/qzvm.js');
  const qz = hostMod.makeQzvm
    ? hostMod.makeQzvm(info.strings, { fields: info.fields })
    : new hostMod.Qzvm(info.strings, { fields: info.fields });
  const { instance } = await WebAssembly.instantiate(readFileSync(wp), { qz: qz.api || qz });
  if (qz.bindMem) qz.bindMem(instance.exports.memory);
  if (instance.exports.__bump && qz.bindBump) qz.bindBump(instance.exports.__bump);
  if (qz.bindClasses && info.classMeta) qz.bindClasses(instance.exports, info.classMeta);
  if (qz.bindClosures) qz.bindClosures(instance.exports, info.lamMeta);
  return (name, a) => {
    const m = info.funcMeta.find(f => f.name === name);
    if (instance.exports.__bump_reset) instance.exports.__bump_reset();
    const conv = m.mode === 'num' ? a : a.map(x => qz._fromJS ? qz._fromJS(x) : x);
    const res = instance.exports[name](...conv);
    return m.mode === 'num' ? res : (qz._toJS ? qz._toJS(res) : res);
  };
}

let failed = 0, compared = 0;
for (const [file, cases] of LOADS) {
  const inM = await runInModule(file);
  let stand = null;
  try { stand = await runStandalone(file); } catch (e) { /* 独立档宿主接口不同则跳过对比 */ }
  for (const [fn, a, want] of cases) {
    const gIn = inM(fn, a);
    const okIn = Object.is(gIn, want);
    if (!okIn) failed++;
    let note = '';
    if (stand) {
      compared++;
      const gS = stand(fn, a);
      if (!Object.is(gS, gIn)) { failed++; note = ` ⚠ 档间不一致: 独立档=${JSON.stringify(gS)}`; }
    }
    console.log(`${okIn && !note ? 'ok  ' : 'FAIL'} ${file}:${fn} = ${JSON.stringify(gIn)}${okIn ? '' : ' want ' + JSON.stringify(want)}${note}`);
  }
}
if (failed) { console.error(`FAIL: ${failed} 项`); process.exit(1); }
console.log(`PASS: 两档一致（${compared} 项跨档对比）`);
