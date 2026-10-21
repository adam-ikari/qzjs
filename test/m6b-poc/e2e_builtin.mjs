// M6b e2e：内建全局（builtin/builtin_value/builtin_fn/builtin_member/instanceof_builtin）
//   直驱 libqzvm 导出 + 真实 emitter 产物（Math/parseInt/String）两条路径。
// 注意：strId 需宿主经 __set_strtab 注入产物字符串表（emit 时 info.strings）。
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
const TAG = (0x7FF9n << 48n);
const box = (x) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x); return d.getBigInt64(0); };
const unbox = (b) => { const d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, BigInt.asIntN(64, b)); return d.getFloat64(0); };
const readStr = (h) => { const off = Number(BigInt.asUintN(64, h) & 0xFFFFFFFFn);
  return new TextDecoder().decode(new Uint8Array(mem.buffer, off + 4, view().getUint32(off, true))); };
const writeStr = (s) => { const b = Buffer.from(s, 'utf8'); const off = L.alloc(b.length + 4);
  view().setUint32(off, b.length, true); new Uint8Array(mem.buffer, off + 4, b.length).set(b);
  return (0x7FFAn << 48n) | BigInt(off); };
// 注入字符串表：[count][off,len]×count + 字节块
const setStrTab = (names) => {
  const blob = names.map((n) => Buffer.from(n, 'utf8'));
  const tbl = 4 + blob.length * 8;
  const base = L.alloc(tbl + blob.reduce((a, b) => a + b.length, 0) + 16);
  const v = view();
  v.setUint32(base, blob.length, true);
  let cur = base + tbl;
  blob.forEach((b, i) => { v.setUint32(base + 4 + i * 8, cur, true); v.setUint32(base + 8 + i * 8, b.length, true);
    new Uint8Array(mem.buffer, cur, b.length).set(b); cur += b.length; });
  L.__set_strtab(base);
};

let failed = 0;
const chk = (l, g, w) => { const ok = Object.is(g, w); if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${l} = ${JSON.stringify(g)}${ok ? '' : ' want ' + JSON.stringify(w)}`); };

// ── 1. 直驱原语 ──
setStrTab(['Math.floor', 'Math.max', 'Math.PI', 'String', 'parseInt', 'toUpperCase', 'push']);
chk('builtin Math.floor(3.7)', unbox(L.builtin(0, 1, box(3.7), TAG, TAG, TAG, TAG)), 3);
chk('builtin Math.max(1,9)', unbox(L.builtin(1, 2, box(1), box(9), TAG, TAG, TAG, TAG)), 9);
chk('builtin Math.PI', unbox(L.builtin(2, 0, TAG, TAG, TAG, TAG, TAG)), Math.PI);
chk('builtin parseInt("42")', unbox(L.builtin(4, 1, writeStr('42'), TAG, TAG, TAG, TAG)), 42);
chk('builtin_value String 是函数句柄', typeof L.builtin_value(3), 'bigint');
chk('method_call "abc".toUpperCase()', readStr(L.method_call(writeStr('abc'), 5, TAG, TAG, TAG, TAG, TAG)), 'ABC');
chk('instanceof_builtin 非实例 → 0', L.instanceof_builtin(box(1), 3), 0);

// ── 2. 真实产物 ──
const { compileTS } = await import('../../src/qzvm/aot/emitter.js');
const dir = mkdtempSync(join(tmpdir(), 'qzbi-'));
const tsPath = join(dir, 'b.ts'), wasmPath = join(dir, 'b.wasm');
writeFileSync(tsPath, `
export function fl(x: number): number { return Math.floor(x); }
export function mx(a: number, b: number): number { return Math.max(a, b); }
export function pi(): number { return Math.PI; }
export function parse(s: string): number { return parseInt(s); }
export function str(v: number): string { return String(v); }
`);
const info = compileTS(tsPath, wasmPath, { inModuleLink: true });
setStrTab(info.strings || []);   // 产物 strId → 名字

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
chk('产物 fl(3.7)', unbox(P.fl(box(3.7))), 3);
chk('产物 mx(2,9)', unbox(P.mx(box(2), box(9))), 9);
chk('产物 pi()', unbox(P.pi()), Math.PI);
chk('产物 parse("42")', unbox(P.parse(writeStr('42'))), 42);
chk('产物 str(7)', readStr(P.str(box(7))), '7');

L.qz_destroy(rt);
if (failed) { console.error(`FAIL: ${failed} 项`); process.exit(1); }
console.log('PASS: 内建全局分派（直驱 + 真实产物）');
