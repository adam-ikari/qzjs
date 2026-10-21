// M6b prop_get e2e：直接驱动 libqzvm 导出，验证 strId → 字符串表 → JS 属性读。
//   __set_strtab(base) 写入 [count][ [off,len] × count ] 表 + 字节块
//   object_new() → 对象句柄；object_set(obj, strId, val)；prop_get(obj, strId) 读回
// 证明：emitter 的 i32 字段名 id 在 guest 侧经共享内存字符串表解析为真实属性名。
import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';
function fail(m) { console.error('FAIL: ' + m); process.exit(1); }

const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const wasmPath = get('--libqzvm');
if (!wasmPath) fail('usage: --libqzvm <libqzvm.wasm>');

const wasi = new WASI({ version: 'preview1' });
const inst = new WebAssembly.Instance(
  new WebAssembly.Module(readFileSync(wasmPath)),
  { wasi_snapshot_preview1: wasi.wasiImport, qz_host: { fs_read: () => 0, drain: () => 0 } });
wasi.initialize(inst);
const vm = inst.exports;
const rt = vm.qz_create(0, 0);
if (!rt) fail('qz_create returned 0');
const mem = vm.memory;
const view = new DataView(mem.buffer);
const u8 = new Uint8Array(mem.buffer);

// ── 写字符串表到 malloc 区 ──────────────────────────────────────────
// 表：[count:i32][off:i32][len:i32] × count，off 指向该名字的 [utf8] 字节（表尾）
const names = ['title', 'n'];
const tableBytes = 4 + names.length * 8;
const blobBytes = names.reduce((a, n) => a + Buffer.byteLength(n), 0);
const base = vm.alloc(tableBytes + blobBytes + 16);
if (!base) fail('alloc failed');
let blobCursor = base + tableBytes;
view.setUint32(base, names.length, true);
names.forEach((n, i) => {
  const b = Buffer.from(n, 'utf8');
  view.setUint32(base + 4 + i * 8, blobCursor, true);
  view.setUint32(base + 8 + i * 8, b.length, true);
  u8.set(b, blobCursor);
  blobCursor += b.length;
});
vm.__set_strtab(base);

// ── 对象读写 ────────────────────────────────────────────────────────
const obj = vm.object_new();
if (!obj) fail('object_new returned 0');

// 值：字符串句柄 —— [len:i32]["hello"]
const soff = vm.alloc(16);
view.setUint32(soff, 5, true);
u8.set(Buffer.from('hello', 'utf8'), soff + 4);
const strHandle = (0x7FFAn << 48n) | BigInt(soff);

const TITLE = 0, N = 1;
vm.object_set(obj, TITLE, strHandle);

// 命中：字符串句柄读回
const got = vm.prop_get(obj, TITLE);
const gtag = BigInt.asUintN(64, got) >> 48n;
const goff = Number(BigInt.asUintN(64, got) & 0xFFFFFFFFn);
const glen = view.getUint32(goff, true);
const gs = new TextDecoder().decode(u8.subarray(goff + 4, goff + 4 + glen));
console.log(`prop_get(obj,"title") tag=0x${gtag.toString(16)} = ${JSON.stringify(gs)} (expect "hello")`);
if (gtag !== 0x7FFAn) fail('prop_get 结果不是字符串句柄');
if (gs !== 'hello') fail('prop_get 结果不符（字符串表未生效？）');

// 未设置属性 → undefined 固定槽 0x7FF9|0（emitter _emitUndefined 约定）
const missBits = BigInt.asUintN(64, vm.prop_get(obj, N));
console.log(`prop_get(obj,"n") (未设置) = 0x${missBits.toString(16)} (expect 0x7ff9000000000000)`);
if (missBits !== 0x7FF9000000000000n) fail('未设置属性应返回 undefined 固定槽');


vm.qz_destroy(rt);
console.log('PASS: prop_get + strId string table e2e');
