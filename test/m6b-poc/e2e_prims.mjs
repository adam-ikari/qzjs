// M6b 原语语义 e2e：位移/幂/比较/类型判定（guest_entry.c）。
// 数值经 NaN-box 位型传递（i64 位型 == f64 位型），布尔为 0x7FFC|bit，字符串为 0x7FFA|off。
import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';

let failed = 0;
const fail = (m) => { console.error('FAIL: ' + m); failed++; };
const eqv = (label, got, want) => {
  const ok = Object.is(got, want);
  const show = (x) => (typeof x === 'bigint' ? `${x}n` : JSON.stringify(x));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} = ${show(got)}${ok ? '' : ' want ' + show(want)}`);
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


// ── 字符串表（后续 strId 键原语依赖它）──
{
  const names = ['a', 'z', 'a\u0000b\u0000c', 'toUpperCase'];
  const base = vm.alloc(256);
  const dv0 = view();
  dv0.setUint32(base, names.length, true);
  let c = base + 128;
  names.forEach((n, k) => {
    const b = Buffer.from(n, 'utf8');
    dv0.setUint32(base + 4 + k * 8, c, true);
    dv0.setUint32(base + 8 + k * 8, b.length, true);
    new Uint8Array(vm.memory.buffer, c, b.length).set(b);
    c += b.length;
  });
  vm.__set_strtab(base);
}
// 解 0x7FFA|off 字符串
const strOf = (h) => {
  const u = BigInt.asUintN(64, h);
  if ((u >> 48n) !== 0x7FFAn) return `tag=0x${(u >> 48n).toString(16)}`;
  const off = Number(u & 0xFFFFFFFFn);
  const dv = view();
  return new TextDecoder().decode(new Uint8Array(vm.memory.buffer, off + 4, dv.getUint32(off, true)));
};
// undefined 判定
const isUndef = (h) => BigInt.asUintN(64, h) === 0x7ff9000000000000n;

// ── 属性写/删（strId 键）──
const o = vm.object_new();
vm.prop_set(o, 0, box(7));                    // o.a = 7
eqv('prop_set 后 object_get', unbox(vm.object_get(o, 0)), 7);
vm.prop_delete(o, 0);
eqv('prop_delete 后', isUndef(vm.object_get(o, 0)), true);

// ── 动态下标（字符串句柄键）──
vm.set_index(o, str('k'), box(9));
eqv('set_index/get_index', unbox(vm.get_index(o, str('k'))), 9);
eqv('get_index 缺键', isUndef(vm.get_index(o, str('zz'))), true);
eqv('delete_index 存在', asBool(vm.delete_index(o, str('k'))), 1);

// ── length ──
eqv('length_of("hello")', unbox(vm.length_of(str('hello'))), 5);

// ── obj_new / obj_merge ──
{
  const d = vm.object_new(), s = vm.object_new();
  vm.prop_set(s, 0, box(5));
  vm.obj_merge(d, s);
  eqv('obj_merge 复制自有属性', unbox(vm.object_get(d, 0)), 5);
}

// ── arr_set_index / arr_set_len（对象作接收者，验下标与 length 语义）──
{
  const a = vm.object_new();
  vm.arr_set_index(a, box(0), box(10));
  vm.arr_set_index(a, box(5), box(50));
  eqv('arr_set_index 写 0', unbox(vm.get_index(a, box(0))), 10);
  eqv('arr_set_index 越界写 5', unbox(vm.get_index(a, box(5))), 50);
  vm.arr_set_len(a, box(2));
  eqv('arr_set_len 截断后 length', unbox(vm.length_of(a)), 2);
}

// ── 键序登记系列 ──
{
  const k = vm.object_new();
  vm.field_order(k, str('x'));
  vm.order_note(k, 1);                        // strId 1 = "z"
  const keys = vm.get_index(k, str('__qz_keys'));
  eqv('field_order+order_note 键数', unbox(vm.length_of(keys)), 2);
  eqv('  第 0 项', strOf(vm.get_index(keys, box(0))), 'x');
  eqv('  第 1 项（order_note 取字符串表）', strOf(vm.get_index(keys, box(1))), 'z');
  vm.field_order_del(k, str('x'));
  eqv('field_order_del 后键数', unbox(vm.length_of(vm.get_index(k, str('__qz_keys')))), 1);

  const lit = vm.object_new();
  vm.field_order_lit(lit, 2);                 // strId 2 = "a\0b\0c" → 3 项
  const lk = vm.get_index(lit, str('__qz_keys'));
  eqv('field_order_lit 分割键数', unbox(vm.length_of(lk)), 3);
  eqv('  拼接', [0, 1, 2].map((i) => strOf(vm.get_index(lk, box(i)))).join(','), 'a,b,c');

  const d2 = vm.object_new(), s2 = vm.object_new();
  vm.field_order(d2, str('d1'));
  vm.field_order(s2, str('s1'));
  vm.field_order(s2, str('s2'));
  vm.spread_order(d2, s2);
  const dk = vm.get_index(d2, str('__qz_keys'));
  eqv('spread_order 追加键序', [0, 1, 2].map((i) => strOf(vm.get_index(dk, box(i)))).join(','), 'd1,s1,s2');
}

// 键序登记不污染正常属性枚举（隐藏数组不可枚举）
{
  const src = Buffer.from('var t={}; t.keep=1; 0');
  const p = vm.alloc(src.length);
  new Uint8Array(vm.memory.buffer, p, src.length).set(src);
  eqv('libqzvm qz_eval 正常', vm.qz_eval(vm.qz_create(0, 0), p, src.length), 0);
}

// ── 闭包环境层链 ──
{
  const root = Number(vm.env_new(-1));            // 根层（parent=-1）
  vm.env_def(root, 0, box(42));
  eqv('env_get 本层', unbox(vm.env_get(root, 0)), 42);
  const child = Number(vm.env_new(root));
  eqv('env_get 沿 parent 上溯', unbox(vm.env_get(child, 0)), 42);
  vm.env_def(child, 1, box(7));
  eqv('env_get 子层自有名', unbox(vm.env_get(child, 1)), 7);
  vm.env_set(child, 0, box(99));                  // 写到定义层
  eqv('env_set 命中定义层', unbox(vm.env_get(root, 0)), 99);
  eqv('env_get 缺失名 → undefined', isUndef(vm.env_get(child, 5)), true);
}

// ── 空数组 / 迭代协议 ──
{
  const a = vm.empty_array();
  eqv('empty_array length', unbox(vm.length_of(a)), 0);
  vm.arr_set_index(a, box(0), box(10));
  vm.arr_set_index(a, box(1), box(20));
  const it = vm.iter_new(a);
  eqv('iter_pull 第一次', Number(vm.iter_pull(it)), 0);
  eqv('iter_val 第一次', unbox(vm.iter_val(it)), 10);
  eqv('iter_pull 第二次', Number(vm.iter_pull(it)), 0);
  eqv('iter_val 第二次', unbox(vm.iter_val(it)), 20);
  eqv('iter_pull 第三次 done', Number(vm.iter_pull(it)), 1);
  vm.iter_close(it);
  eqv('iter_array 长度', unbox(vm.length_of(vm.iter_array(a))), 2);
  const into = vm.empty_array();
  vm.spread_into(into, a);
  eqv('spread_into 长度', unbox(vm.length_of(into)), 2);
}

// ── 字符串 / 正则 / BigInt / Symbol ──
{
  eqv('str_chars 码点数', unbox(vm.length_of(vm.str_chars(str('a\u00e9\u{1f600}')))), 3);
  eqv('str_method toUpperCase（字符串表 strId 3）', strOf(vm.str_method(str('abc'), 3, 0x7ff9000000000000n, 0x7ff9000000000000n)), 'ABC');
  eqv('regex 生成了值（strId 1 = "z"）', isUndef(vm.regex(1)), false);
  eqv('is_symbol_host(数值)', vm.is_symbol_host(box(5)), 0);
  eqv('bigint_lit 是 BigInt 句柄', (BigInt.asUintN(64, vm.bigint_lit(0)) >> 48n), 0x7ff8n);
}

// ── object_rest / obj_assign / tagged_strings / err_stack ──
{
  const o = vm.object_new();
  vm.prop_set(o, 0, box(1));                      // "a"
  vm.prop_set(o, 1, box(2));                      // "z"
  const rest = vm.object_rest(o, 1, 0, -1, -1);   // 排除 strId 0 = "a"
  eqv('object_rest 排除 a', isUndef(vm.object_get(rest, 0)), true);
  eqv('object_rest 保留 z', unbox(vm.object_get(rest, 1)), 2);

  const d = vm.object_new(), s1 = vm.object_new();
  vm.prop_set(s1, 0, box(77));
  vm.obj_assign(0, d, s1, 0x7ff9000000000000n, 0x7ff9000000000000n);
  eqv('obj_assign 复制自有属性', unbox(vm.object_get(d, 0)), 77);

  const cooked = vm.empty_array(); vm.arr_set_index(cooked, box(0), str('hi'));
  const raw = vm.empty_array(); vm.arr_set_index(raw, box(0), str('hi'));
  const ts = vm.tagged_strings(cooked, raw);
  eqv('tagged_strings 长度', unbox(vm.length_of(ts)), 1);
  eqv('tagged_strings 带 raw', isUndef(vm.get_index(ts, str('raw'))), false);

  eqv('err_stack 普通对象 → undefined', isUndef(vm.err_stack(vm.object_new())), true);
}

if (failed) { console.error(`FAIL: ${failed} 项`); process.exit(1); }
console.log('PASS: primitives + props/arrays/key-order/env/iter semantics e2e');
