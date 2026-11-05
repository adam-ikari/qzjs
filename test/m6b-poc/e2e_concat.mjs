// M6b 真 e2e（node WASI 宿主 shim）：
//   libqzvm.wasm（真 guest VM，带 qz_host shim）→ qz_create 建 realm
//   → emitter 产物 concat_inmod.wasm，import "qz" 链接 libqzvm 导出（共享 memory）
//   → greet(字符串句柄) 经 libqzvm string_concat/str_dup 原语 → "x!"
// 证明：emitter 产物 + 真 libqzvm multi-module 链接的字符串原语端到端可用。
import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';
function fail(m) { console.error('FAIL: ' + m); process.exit(1); }


const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const wasmPath = get('--libqzvm');
const prodPath = get('--product');
if (!wasmPath || !prodPath) fail('usage: --libqzvm <libqzvm.wasm> --product <product.wasm>');

const wasi = new WASI({ version: 'preview1' });
const vmBytes = readFileSync(wasmPath);
const vmImports = { wasi_snapshot_preview1: wasi.wasiImport, qz_host: {
  fs_read: () => 0, drain: () => 0,
} };
const vmInst = new WebAssembly.Instance(new WebAssembly.Module(vmBytes), vmImports);
const vm = vmInst.exports;
wasi.initialize(vmInst);
const rt = vm.qz_create(0, 0);
if (!rt) fail('qz_create returned 0');
const mem = vm.memory;
const view = new DataView(mem.buffer);

// emitter 产物：import "qz" {memory, add, string_concat, str_dup, ...} 全链接 libqzvm 导出
const qz = { memory: vm.memory, __indirect_function_table: vm.__indirect_function_table };
for (const k of Object.keys(vm)) if (typeof vm[k] === 'function') qz[k] = vm[k];
const prodBytes = readFileSync(prodPath);
const prodInst = new WebAssembly.Instance(new WebAssembly.Module(prodBytes), { qz });
const prod = prodInst.exports;

// 写 "x" 到 bump arena 起点（STR_BUMP=128）；字面量段在 16MiB，勿覆盖
const off = 128;
view.setUint32(off, 1, true);
new Uint8Array(mem.buffer, off + 4, 1)[0] = 0x78;   // 'x'
const handle = (0x7FFAn << 48n) | BigInt(off);
const r = prod.greet(handle);
const roff = Number(BigInt.asUintN(64, r) & 0xFFFFFFFFn);
const rlen = view.getUint32(roff, true);
const s = new TextDecoder().decode(new Uint8Array(mem.buffer, roff + 4, rlen));
console.log(`greet("x") = ${JSON.stringify(s)} (expect "x!")`);
if (s !== 'x!') fail('greet result mismatch');
vm.qz_destroy(rt);
console.log('PASS: emitter product + real libqzvm string concat e2e');
