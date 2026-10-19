// M6b 原语语义 e2e：位移/幂/比较/类型判定（guest_entry.c）。
// 数值经 NaN-box 位型传递（i64 位型 == f64 位型），布尔为 0x7FFC|bit，字符串为 0x7FFA|off。
import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';

let failed = 0;
const fail = (m) => { console.error('FAIL: ' + m); failed++; };
const eqv = (label, got, want) => {
  const ok = Object.is(got, want);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} = ${JSON.stringify(got)}${ok ? '' : ' want ' + JSON.stringify(want)}`);
  if (!ok) failed++;
};

const args = process.argv.slice(2);
const i = args.indexOf('--libqzvm');
if (i < 0) { console.error('usage: --libqzvm <libqzvm.wasm>'); process.exit(2); }

const wasi = new WASI({ version: 'preview1' });
const inst = new WebAssembly.Instance(
  new WebAssembly.Module(readFileSync(args[i + 1])),
  { wasi_snapshot_preview1: wasi.wasiImport, qz_host: { fs_read: () => 0, drain: () => 0 } });
wasi.initialize(inst);
const vm = inst.exports;
vm.qz_create(0, 0);

const view = () => new DataView(vm.memory.buffer);
// f64 → i64 位型（NaN-box 数值编码）
const box = (x) => { const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, x); return dv.getBigInt64(0); };
// i64 位型 → f64
const unbox = (b) => { const dv = new DataView(new ArrayBuffer(8)); dv.setBigInt64(0, BigInt.asIntN(64, b)); return dv.getFloat64(0); };
// 布尔句柄 0x7FFC|bit → 0/1
const asBool = (b) => { const u = BigInt.asUintN(64, b); return (u >> 48n) === 0x7FFCn ? Number(u & 1n) : `tag=0x${(u >> 48n).toString(16)}`; };
// 写 [len][utf8] 串，返回 0x7FFA|off 句柄
const str = (s) => {
  const b = Buffer.from(s, 'utf8');
  const off = vm.alloc(b.length + 4);
  const dv = view();
  dv.setUint32(off, b.length, true);
  new Uint8Array(vm.memory.buffer, off + 4, b.length).set(b);
  return (0x7FFAn << 48n) | BigInt(off);
};

// ── 位移：JS 语义为 32 位，移位量按 31 掩码 ──
eqv('shl(1,3)', unbox(vm.shl(box(1), box(3))), 8);
eqv('shl(-1,1)', unbox(vm.shl(box(-1), box(1))), -2);
eqv('shl(1,33) 移位量掩码', unbox(vm.shl(box(1), box(33))), 2);
eqv('shr(-8,1) 算术右移', unbox(vm.shr(box(-8), box(1))), -4);
eqv('ushr(-1,1) 逻辑右移', unbox(vm.ushr(box(-1), box(1))), 2147483647);

// ── 幂 / 余数 ──
eqv('pow(2,10)', unbox(vm.pow(box(2), box(10))), 1024);
eqv('pow(2,-1)', unbox(vm.pow(box(2), box(-1))), 0.5);
eqv('math_pow 裸 f64', vm.math_pow(2, 0.5).toFixed(6), Math.sqrt(2).toFixed(6));
eqv('math_rem(-7,3) fmod 语义', vm.math_rem(-7, 3), -1);

// ── ToNumber / 类型判定 ──
eqv('to_num("42")', unbox(vm.to_num(str('42'))), 42);
eqv('to_num("3.5")', unbox(vm.to_num(str('3.5'))), 3.5);
eqv('is_nullish(undefined)', vm.is_nullish(0x7ff9000000000000n), 1);
eqv('is_nullish(null)', vm.is_nullish(0x7ff9000000000001n), 1);
eqv('is_nullish(0)', vm.is_nullish(box(0)), 0);
eqv('is_undef(undefined)', vm.is_undef(0x7ff9000000000000n), 1);
eqv('is_undef(null)', vm.is_undef(0x7ff9000000000001n), 0);
eqv('typeof_host(数值) 非函数', vm.typeof_host(box(5)), 0);
eqv('typeof_host(undefined)', vm.typeof_host(0x7ff9000000000000n), 0);

// ── 比较（== / !=）──
eqv('eq(1,1)', asBool(vm.eq(box(1), box(1))), 1);
eqv('eq(1,-1)', asBool(vm.eq(box(1), box(-1))), 0);
eqv('ne(1,2)', asBool(vm.ne(box(1), box(2))), 1);
eqv('eq("a","a") 字符串', asBool(vm.eq(str('a'), str('a'))), 1);
eqv('eq(NaN,NaN) NaN≠NaN', asBool(vm.eq(box(NaN), box(NaN))), 0);

// ── in 运算符 ──
const obj = vm.object_new();
eqv('in_op 缺键', asBool(vm.in_op(str('x'), obj)), 0);
vm.object_set(obj, 0, box(1));          // （id 即偏移；此处仅建属性，键名无关紧要）
eqv('in_op 非对象接收者', asBool(vm.in_op(str('x'), box(1))), 0);

if (failed) { console.error(`FAIL: ${failed} 项`); process.exit(1); }
console.log('PASS: primitives semantics e2e');
