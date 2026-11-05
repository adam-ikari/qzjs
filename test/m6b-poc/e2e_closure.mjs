// M6b e2e：闭包经 C 侧 call_indirect 分派。
// 覆盖：纯函数闭包、带捕获变量的闭包、闭包作实参传递、闭包内调用闭包。
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WASI } from 'node:wasi';

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
const view = () => new DataView(mem.buffer);
const box = (x) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x); return d.getBigInt64(0); };
const unbox = (b) => { const d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, BigInt.asIntN(64, b)); return d.getFloat64(0); };

let failed = 0;
const chk = (l, g, w) => { const ok = Object.is(g, w); if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${l} = ${JSON.stringify(g)}${ok ? '' : ' want ' + JSON.stringify(w)}`); };

// ── 1. 直驱 closure_call：手造闭包值 [slot][env][arity][nameStrId] ──
// 蹦床由 emitter 产物装入；这里只能用真实产物。所以直驱断言跳过，全部走真实产物。

// ── 2. 真实产物 ──
const { compileTS } = await import('../../src/qzvm/aot/emitter.js');
const dir = mkdtempSync(join(tmpdir(), 'qzcl-'));
const tsPath = join(dir, 'c.ts'), wasmPath = join(dir, 'c.wasm');
writeFileSync(tsPath, `
export function doubler(n: number): number {
  const f = (x: number): number => x * 2;
  return f(n) + 1;
}
export function counter(n: number): number {
  let s = 0;
  const add = (x: number): void => { s += x; };
  for (let i = 0; i < n; i++) add(i);
  return s;
}
export function applyer(n: number): number {
  const apply = (f: (x: number) => number, x: number): number => f(x);
  const sq = (x: number): number => x * x;
  return apply(sq, n);
}
export function nest(n: number): number {
  const outer = (a: number): number => {
    const inner = (b: number): number => a + b;
    return inner(n);
  };
  return outer(10);
}
`);
const info = compileTS(tsPath, wasmPath, { inModuleLink: true });

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
// 跳过 strtab 注入（这些函数没有字符串 strId）

chk('doubler(5)', unbox(P.doubler(box(5))), 11);          // 纯函数闭包
chk('counter(4)', unbox(P.counter(box(4))), 6);            // 带捕获变量
chk('applyer(3)', unbox(P.applyer(box(3))), 9);           // 闭包作实参传递
chk('nest(7)', unbox(P.nest(box(7))), 17);                // 嵌套闭包

L.qz_destroy(rt);
if (failed) { console.error(`FAIL: ${failed} 项`); process.exit(1); }
console.log('PASS: 闭包经 C 侧 call_indirect 分派（纯函数/捕获/作实参/嵌套）');
