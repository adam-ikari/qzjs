#!/usr/bin/env node
// bench/aot-product/run_wasm2c.mjs — wasm2c 档：无 wasm 运行时设备的交付形态
//
// 口径：TS → emitter wasm（纯数值子集，唯一 import qz.math_rem）→ wasm2c 生成 C
//       → gcc -O3 → native 进程计时。与 qzjs-interp / node-JS / WAMR-AOT 同负载同 N。
// 工具链：WABT 1.0.42 预编译包（系统 1.0.27 在带 import 的模块上崩溃）。
// 用法：node bench/aot-product/run_wasm2c.mjs
//   WABT_DIR=<dir> 覆盖 wabt 根目录；WASM2C_OUT=<dir> 覆盖产物目录。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { toolchain, wasmToC, linkNative } from './wasm2c/common.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = process.env.WASM2C_OUT || path.join(ROOT, 'build', 'aot', 'wasm2c');
const SRC = path.join(ROOT, 'bench', 'aot-product', 'workloads', 'pure.ts');
const REPS = 5;

const { compileTS } = await import(ROOT + 'src/qzvm/aot/emitter.js');

// 负载与 run_wamr.js 同 N（纯数值档）
const LOADS = [
  ['computeWork', 200000],
  ['hpackIntBatch', 200000],
  ['varintBatch', 200000],
  ['hashBatch', 200000],
];
const M = 'w2c_pure';                 // wasm2c 输出前缀；生成名 w2c_pure，struct w2c_pure
const GEN = 'pure';                    // wasm2c 生成标识符 = 文件名 basename
const TYPE = `w2c_${GEN}`;
const INIT = `wasm2c_${GEN}_instantiate`;
const FREE = `wasm2c_${GEN}_free`;
const IMPL = `f64 w2c_qz_math_rem(struct w2c_qz* i, f64 a, f64 b) { (void)i; return fmod(a, b); }`;
const TAIL = `void wasm_tailcall_w2c_qz_math_rem(void **ip, void *ts, wasm_rt_tailcallee_t *n) { (void)ip; (void)ts; (void)n; }`;

const tc = toolchain(OUT);
mkdirSync(OUT, { recursive: true });

// 1. 编 wasm（纯数值子集）
const r = compileTS(SRC, path.join(OUT, 'pure.wasm'), {});
const modes = Object.fromEntries(r.funcMeta.map((f) => [f.name, f.mode]));

// 2. wasm2c → C/H
const gen = wasmToC(tc, path.join(OUT, 'pure.wasm'), path.join(OUT, M));

// 3. 生成 harness（从模板填充导出函数签名）
const tpl = readFileSync(path.join(ROOT, 'bench', 'aot-product', 'wasm2c', 'bench.c.tpl'), 'utf8');
const rows = LOADS.map(([name, n], i) => {
  const fn = `w2c_${GEN}_${name}`; // wasm2c 导出: w2c_<gen>_<export>
  return `  printf("${i ? ',' : ''}\\"${name}\\":"); printf("%.3f", p50(${fn}, &inst, ${n}.0, ${REPS}));`;
}).join('\n');
const c = tpl
  .replace(/%HDR%/g, `${M}.h`)
  .replace(/%IMPORT%/g, IMPL)
  .replace(/%TAILCALL%/g, TAIL)
  .replace(/%TYPE%/g, TYPE)
  .replace(/%INIT%/g, INIT)
  .replace(/%FREE%/g, FREE)
  .replace(/%ROWS%/g, rows);
writeFileSync(path.join(OUT, 'bench.c'), c);

// 4. gcc -O3 链接 wasm-rt
linkNative({ tc, outDir: OUT, sources: [path.join(OUT, 'bench.c'), gen.c], binary: path.join(OUT, 'bench') });

// 5. 运行计时
const out = execFileSync(path.join(OUT, 'bench'), { encoding: 'utf8' });
const m = out.match(/RESULT (\{.*\})/);
if (!m) { console.error('no RESULT:', out); process.exit(1); }
const timings = JSON.parse(m[1]);
console.log('\n=== wasm2c (wabt 1.0.42, gcc -O3, no wasm runtime) ===');
for (const [name, n] of LOADS) {
  console.log(`${name.padEnd(16)} N=${String(n).padStart(7)}  p50_ms=${timings[name] ?? 'ERR'}  mode=${modes[name]}`);
}
console.log('artifacts:', path.join(OUT, M + '.c'), path.join(OUT, 'bench'));
