#!/usr/bin/env node
// bench/aot-product/run_wasm2c_full.mjs — 复用可行性实验（不是性能档）
//
// 第一性原理：qz.* 不是引擎 ABI，是 AOT 工具链的 import 面。它有两份实现：
//   JS shim（qzvm.js）与 C host（guest_entry.c 编进 libqzvm.wasm）。
// wasm2c 把 wasm import 变成 C 函数声明（带一个 opaque 实例指针首参），
// 所以复用点是「合并后的 wasm 模块」而不是「重写一份 C 宿主」：
//   M6b 合并单模块（emitter 产品 + libqzvm.wasm）经 wasm2c → C，
//   qz.* 全部落成模块内 C 函数，共享同一线性内存；对外只剩 7 个 import
//   （2 个 qz_host.* + 5 个 WASI），用桩函数即可。
//
// 本脚本只验证「生成 + 编译 + 链接 + 实例化」是否成立；不跑性能。
// 用法：WABT_DIR=/tmp/wabt142 MERGED=/tmp/aotp_merged.wasm node bench/aot-product/run_wasm2c_full.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WABT = process.env.WABT_DIR || '/tmp/wabt142';
const WASM2C = path.join(WABT, 'bin', 'wasm2c');
const MERGED = process.env.MERGED || '/tmp/aotp_merged.wasm';
const OUT = process.env.WASM2C_FULL_OUT || path.join(ROOT, 'build', 'aot', 'wasm2c-full');
const MOD = 'merged';

if (!existsSync(WASM2C)) { console.error('wasm2c not found:', WASM2C, '— set WABT_DIR'); process.exit(1); }
if (!existsSync(MERGED)) {
  console.error('merged wasm not found:', MERGED, '— Tier A (run_wamr.js) must run first');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

// wabt 1.0.42 硬约束（1.0.27 在带 import 的模块上崩溃）
const v = spawnSync(WASM2C, ['--version'], { encoding: 'utf8' });
if (v.status !== 0 || !(v.stdout || '').includes('1.0.42')) {
  console.error(`wasm2c 1.0.42 required, got "${(v.stdout || v.stderr || '').trim()}"`);
  process.exit(1);
}

// 1. wasm2c：合并模块 → C
const t0 = Date.now();
execFileSync(WASM2C, [MERGED, '-o', path.join(OUT, MOD)], { stdio: 'inherit', maxBuffer: 1 << 28 });
writeFileSync(path.join(OUT, MOD + '.c'), readFileSync(path.join(OUT, MOD)));
const hdr = readFileSync(path.join(OUT, MOD + '.h'), 'utf8');

// 2. 从生成的头文件抽 import 声明，生成桩定义（GCC 允许定义里省略参数名）
//    只桩 import 与 tailcall；export / get_func_type 由生成 C 自己定义。
const stubs = [`#include "${MOD}.h"`, ''];
let inImport = false;
for (const line of hdr.split('\n')) {
  const t = line.trim();
  if (t.startsWith('/* import:')) { inImport = true; continue; }
  if (t.startsWith('/* export:')) { inImport = false; continue; }
  const m = t.match(/^([A-Za-z_][\w\s\*]*?)\s+(w2c_[A-Za-z0-9_]+|wasm_tailcall_[A-Za-z0-9_]+)\s*\(([^;]*)\)\s*;$/);
  if (!m) continue;
  const [, ret, name, args] = m;
  if (name.includes('get_func_type')) continue;
  const isTail = name.startsWith('wasm_tailcall_');
  if (!inImport && !isTail) continue;
  stubs.push(`${ret.trim()} ${name}(${args}) ${ret.trim() === 'void' ? '{ }' : '{ return 0; }'}`);
  inImport = false;
}
writeFileSync(path.join(OUT, 'stubs.c'), stubs.join('\n') + '\n');
const stubNames = stubs.filter((l) => l.includes('(') && !l.startsWith('#include'));
console.log(`stub imports: ${stubNames.length}`);

// 3. main：实例化一次（仅验证链接/初始化，不计时）
const im = hdr.match(/void\s+(wasm2c_[A-Za-z0-9_]+_instantiate)\s*\(([^;]*?)\)\s*;/);
if (!im) { console.error('instantiate declaration not found in generated header'); process.exit(1); }
const initName = im[1];
const params = im[2].split(',').map((s) => s.trim()).filter(Boolean);
const modType = params[0].replace(/\*.*$/, '').trim();
const nulls = params.length > 1 ? ', ' + Array(params.length - 1).fill('NULL').join(', ') : '';
const fm = hdr.match(/void\s+(wasm2c_[A-Za-z0-9_]+_free)\s*\(/);
const freeName = fm ? fm[1] : null;
writeFileSync(path.join(OUT, 'main.c'), [
  '#include <stddef.h>',
  `#include "${MOD}.h"`,
  'int main(void) {',
  '  wasm_rt_init();',
  `  ${modType} inst;`,
  `  ${initName}(&inst${nulls});`,
  freeName ? `  ${freeName}(&inst);` : '',
  '  wasm_rt_free();',
  '  return 0;',
  '}',
].join('\n') + '\n');

// 4. gcc -O3 编译 + 链接（flags 只给本实验的 C，不进 qzjs 自身 TU）
const rtSrc = path.join(WABT, 'share', 'wabt', 'wasm2c');
const cc = spawnSync('gcc', [
  '-O3', '-std=c99', '-D_GNU_SOURCE', '-DWASM_RT_SKIP_SIGNAL_RECOVERY=1',
  '-I' + path.join(WABT, 'include'), '-I' + OUT,
  '-o', path.join(OUT, 'check'),
  path.join(OUT, MOD + '.c'), path.join(OUT, 'stubs.c'), path.join(OUT, 'main.c'),
  path.join(rtSrc, 'wasm-rt-impl.c'), path.join(rtSrc, 'wasm-rt-mem-impl.c'), '-lm',
], { encoding: 'utf8', maxBuffer: 1 << 28 });
if (cc.status !== 0) {
  console.error('gcc FAILED:\n' + (cc.stderr || '').slice(0, 6000));
  process.exit(1);
}
const compileMs = Date.now() - t0;

// 5. 实例化运行（桩 WASI 返回 0；能跑通即证明初始化路径可用）
const run = spawnSync(path.join(OUT, 'check'), [], { encoding: 'utf8', timeout: 300000 });

console.log('\n=== wasm2c 合并模块（qzvm C 宿主复用可行性）===');
console.log('merged wasm   :', statSync(MERGED).size, 'bytes');
console.log('generated C   :', statSync(path.join(OUT, MOD + '.c')).size, 'bytes');
console.log('compile+link  :', compileMs, 'ms');
console.log('binary        :', statSync(path.join(OUT, 'check')).size, 'bytes');
console.log('RUN_STATUS    :', run.status, run.error ? run.error.message : '');
if (run.stderr) console.log('RUN_STDERR    :', run.stderr.slice(0, 500));
console.log('COMPILE_OK');
