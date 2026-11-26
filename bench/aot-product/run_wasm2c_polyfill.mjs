#!/usr/bin/env node
// bench/aot-product/run_wasm2c_polyfill.mjs — wasm2c 加速 polyfill 实验
//
// 形态：TS(polyfill 纯函数) → emitter wasm → wasm2c C → qzjs 编译期扩展(qz_ext_t)
//       → JS 全局 polyfillBatch(n) 直接调原生 C。与 JS 基线 / wamrc AOT 同算法同 N。
// 本机只生成源码与校验结构；编译 + 性能在 CI runner 上做。
// 用法：node bench/aot-product/run_wasm2c_polyfill.mjs
//   WABT_DIR / WASM2C_OUT 可覆盖。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { toolchain, wasmToC, pragma, runtimeSources } from './wasm2c/common.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WD = path.join(ROOT, 'bench', 'aot-product', 'wasm2c');
const OUT = process.env.WASM2C_OUT || path.join(ROOT, 'build', 'aot', 'wasm2c-polyfill');
const SRC = path.join(ROOT, 'bench', 'aot-product', 'workloads', 'pure.ts'); // 纯数值子集（含 polyfillBatch）
const MOD = 'w2c_pf';                            // wasm2c 输出前缀
const GEN = 'pure';                              // 生成标识符 = wasm 文件名 basename
const HDR = `${MOD}.h`;
const FN = `w2c_${GEN}_polyfillBatch`;
const INST = `w2c_${GEN}`;
const INIT = `wasm2c_${GEN}_instantiate`;
const FREE = `wasm2c_${GEN}_free`;

const tc = toolchain(OUT);
mkdirSync(OUT, { recursive: true });

// 1. 重编 wasm（确保与 pure.ts 一致）
const { compileTS } = await import(ROOT + 'src/qzvm/aot/emitter.js');
compileTS(SRC, path.join(OUT, 'pure.wasm'), {});

// 2. wasm2c 生成 C/H
const gen = wasmToC(tc, path.join(OUT, 'pure.wasm'), path.join(OUT, MOD));
// wasm2c 生成 C 含 unused var/func，与 qzjs -Werror 冲突；注入 pragma 仅放松本文件。
writeFileSync(gen.c, pragma() + readFileSync(gen.c, 'utf8'));

// 3. 生成扩展包装源码
const tpl = readFileSync(path.join(WD, 'polyfill_ext.c.tpl'), 'utf8');
const ext = tpl
  .replace(/W2C_HDR/g, HDR)
  .replace(/IMPORT_IMPL/g, `w2c_qz_math_rem(struct w2c_qz* i, f64 a, f64 b) { (void)i; return fmod(a, b); }`)
  .replace(/TAIL_IMPL/g, `wasm_tailcall_w2c_qz_math_rem(void **ip, void *ts, wasm_rt_tailcallee_t *n) { (void)ip; (void)ts; (void)n; }`)
  .replace(/%INST%/g, INST)
  .replace(/%FN%/g, FN)
  .replace(/%FREE%/g, FREE);
// %INST% 展开后 instantiate 变成 w2c_pure_instantiate；改成生成名 wasm2c_pure_instantiate。
const extSrc = ext.replace(`${INST}_instantiate`, INIT);
writeFileSync(path.join(OUT, 'polyfill_ext.c'), extSrc);

// 4. 生成扩展头文件（extern qz_ext_t）
writeFileSync(path.join(OUT, 'polyfill_ext.h'),
`/* generated: extern declaration for QZ_EXTRA_HEADERS */\n#ifndef QZ_W2C_POLYFILL_H\n#define QZ_W2C_POLYFILL_H\n#include <qzjs/qzjs.h>\nextern const qz_ext_t w2c_polyfill_ext;\n#endif\n`);

// 5. 输出构建参数（供 CI 消费）：wasm-rt 副本 + scoped flags。
const rtSources = runtimeSources(tc, OUT);

const cfg = {
  QZ_EXTRA_SOURCES: [path.join(OUT, 'polyfill_ext.c'), gen.c, ...rtSources].join(';'),
  QZ_EXTRA_HEADERS: path.join(OUT, 'polyfill_ext.h'),
  QZ_EXTENSIONS: 'QZ_DEFAULT_EXTENSIONS &w2c_polyfill_ext',
  // 只作用于 QZ_EXTRA_SOURCES（见 CMakeLists 的 QZ_EXTRA_CFLAGS），不污染 qzjs 自身 TU。
  // WASM_RT_SKIP_SIGNAL_RECOVERY=1 关掉进程级 SIGSEGV/SIGBUS handler，避免与 WAMR 抢。
  CFLAGS: `-I${tc.wabt}/include -I${tc.runtime} -I${OUT} -D_GNU_SOURCE -DWASM_RT_SKIP_SIGNAL_RECOVERY=1`,
};
writeFileSync(path.join(OUT, 'build-config.json'), JSON.stringify(cfg, null, 2));
console.log('wasm2c polyfill extension sources generated at', OUT);
console.log(JSON.stringify(cfg, null, 2));
