// M6b e2e：C 侧原语异常的可捕获化（qz.take_err 通道）。
// 覆盖：reduce 空数组无初值 → TypeError（此前静默返回 undefined）；
//       throw new TypeError(...) 经 __err → catch 绑定（回归保护，防 take_err 覆盖用户 throw）。
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WASI } from 'node:wasi';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const libPath = get('--libqzvm');
if (!libPath) { console.error('usage: --libqzvm <libqzvm.wasm>'); process.exit(2); }

const { compileTS } = await import('../../src/qzvm/aot/emitter.js');
// 产物是可复现构建产物（brain: bytecode-build-artifact）→ 写临时目录，不落仓库
const srcPath = new URL('./throw_cases.ts', import.meta.url).pathname;
const prodPath = join(tmpdir(), 'qz_e2e_throw_' +
  createHash('sha1').update(readFileSync(srcPath)).digest('hex').slice(0, 8) + '.wasm');
const info = compileTS(srcPath, prodPath, { inModuleLink: true });

const wasi = new WASI({ version: 'preview1' });
const li = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(libPath)),
  { wasi_snapshot_preview1: wasi.wasiImport, qz_host: { fs_read: () => 0, drain: () => 0 } });
wasi.initialize(li);
const L = li.exports;
const rt = L.qz_create(0, 0);
if (!rt) { console.error('FAIL: qz_create 返回 0'); process.exit(1); }
const mem = L.memory;

// 字符串表：产物按 strId 读
const names = info.strings, blob = names.map((n) => Buffer.from(n, 'utf8'));
const tbl = 4 + blob.length * 8;
const base = L.alloc(tbl + blob.reduce((a, b) => a + b.length, 0) + 16);
const dv = new DataView(mem.buffer);
dv.setUint32(base, blob.length, true);
let cur = base + tbl;
blob.forEach((b, i) => {
  dv.setUint32(base + 4 + i * 8, cur, true);
  dv.setUint32(base + 8 + i * 8, b.length, true);
  new Uint8Array(mem.buffer, cur, b.length).set(b);
  cur += b.length;
});
L.__set_strtab(base);

const prod = new WebAssembly.Module(readFileSync(prodPath));
const qz = { memory: mem, __indirect_function_table: L.__indirect_function_table };
const missing = [];
for (const im of WebAssembly.Module.imports(prod)) {
  if (im.module !== 'qz' || im.kind !== 'function') continue;
  if (typeof L[im.name] === 'function') qz[im.name] = L[im.name];
  else missing.push(im.name);
}
if (missing.length) { console.error('FAIL: libqzvm 缺原语 ' + missing.join(' ')); process.exit(1); }
const P = new WebAssembly.Instance(prod, { qz, wasi_snapshot_preview1: wasi.wasiImport }).exports;
if (P.__bump_reset) P.__bump_reset();

const readStr = (h) => {
  const u = BigInt.asUintN(64, h);
  if ((u >> 48n) !== 0x7FFAn) return '<not-string:' + (u >> 48n).toString(16) + '>';
  const off = Number(u & 0xFFFFFFFFn);
  return new TextDecoder().decode(new Uint8Array(mem.buffer, off + 4, dv.getUint32(off, true)));
};

let failed = 0;
const chk = (l, g, w) => { const ok = g === w; if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${l} = ${JSON.stringify(g)}${ok ? '' : ' want ' + JSON.stringify(w)}`); };

chk('reduceEmpty()', readStr(P.reduceEmpty()), 'TypeError:Reduce of empty array with no initial value');
chk('userThrow()', readStr(P.userThrow()), 'TypeError:user-err');
chk('reduceNonEmpty()', readStr(P.reduceNonEmpty()), '6');
chk('noThrow()', readStr(P.noThrow()), 'ok');

L.qz_destroy(rt);
if (failed) { console.error(`FAIL: ${failed} 项`); process.exit(1); }
console.log('PASS: C 侧原语异常经 qz.take_err 可捕获（reduce 空数组 + 用户 throw 不被覆盖）');
