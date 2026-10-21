// M6b e2e：真实 emitter 产物（含循环/递归/数组/字符串/for-of/push）经 libqzvm 端到端实跑。
// 覆盖 sum/pick（f64 ABI）、greet（tagged i64 + 字符串）、fib（递归）、arrSum（数组字面量+for-of）。
// 注：arrSum 的 a.push 由 emitter 内联为内存数组写，不经 method_call；
//     method_call 的覆盖见 e2e_builtin.mjs。
import { readFileSync, existsSync } from 'node:fs';
import { WASI } from 'node:wasi';

const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const libPath = get('--libqzvm'), prodPath = get('--product');
if (!libPath) { console.error('usage: --libqzvm <libqzvm.wasm> [--product <product.wasm>]'); process.exit(2); }

// 产物缺省即由本目录 real_program.ts 现编（免手工生成步骤）
let prodPath2 = prodPath;
if (!prodPath2 || !existsSync(prodPath2)) {
  const { compileTS } = await import('../../src/qzvm/aot/emitter.js');
  prodPath2 = new URL('./real_program_inmod.wasm', import.meta.url).pathname;
  compileTS(new URL('./real_program.ts', import.meta.url).pathname, prodPath2, { inModuleLink: true });
}

const wasi = new WASI({ version: 'preview1' });
const li = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(libPath)),
  { wasi_snapshot_preview1: wasi.wasiImport, qz_host: { fs_read: () => 0, drain: () => 0 } });
wasi.initialize(li);
const L = li.exports;
const rt = L.qz_create(0, 0);
if (!rt) { console.error('FAIL: qz_create 返回 0'); process.exit(1); }
const mem = L.memory;

// 产物 import "qz"：memory 直接共享 libqzvm 的，其余函数转发到 libqzvm 导出
const prod = new WebAssembly.Module(readFileSync(prodPath2));
const qz = { memory: mem, __indirect_function_table: L.__indirect_function_table };
const missing = [];
for (const im of WebAssembly.Module.imports(prod)) {
  if (im.module !== 'qz' || im.kind !== 'function') continue;
  if (typeof L[im.name] === 'function') qz[im.name] = L[im.name];
  else missing.push(im.name);
}
if (missing.length) { console.error('FAIL: libqzvm 缺原语 ' + missing.join(' ')); process.exit(1); }
const P = new WebAssembly.Instance(prod, { qz, wasi_snapshot_preview1: wasi.wasiImport }).exports;

const view = () => new DataView(mem.buffer);
const box = (x) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x); return d.getBigInt64(0); };
const unbox = (b) => { const d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, BigInt.asIntN(64, b)); return d.getFloat64(0); };
const readStr = (h) => { const off = Number(BigInt.asUintN(64, h) & 0xFFFFFFFFn);
  return new TextDecoder().decode(new Uint8Array(mem.buffer, off + 4, view().getUint32(off, true))); };
const writeStr = (s) => { const b = Buffer.from(s, 'utf8');
  const off = L.alloc(b.length + 4); const v = view();
  v.setUint32(off, b.length, true); new Uint8Array(mem.buffer, off + 4, b.length).set(b);
  return (0x7FFAn << 48n) | BigInt(off); };

let failed = 0;
const chk = (l, g, w) => { const ok = Object.is(g, w); if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${l} = ${JSON.stringify(g)}${ok ? '' : ' want ' + JSON.stringify(w)}`); };

chk('sum(5)', P.sum(5), 10);                       // f64 ABI
chk('sum(0)', P.sum(0), 0);
chk('pick(3,9)', P.pick(3, 9), 9);
chk('pick(9,3)', P.pick(9, 3), 9);
chk('fib(10)', P.fib(10), 55);                     // 递归
chk('greet("x")', readStr(P.greet(writeStr('x'))), 'hi x');   // tagged + 字符串拼接
chk('arrSum(3)', unbox(P.arrSum(box(3))), 6);      // 数组字面量 + for-of
chk('arrSum(4)', unbox(P.arrSum(box(4))), 12);

L.qz_destroy(rt);
if (failed) { console.error(`FAIL: ${failed} 项`); process.exit(1); }
console.log('PASS: 真实 emitter 产物（循环/递归/数组/for-of）经 libqzvm 端到端');
