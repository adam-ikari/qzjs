#!/usr/bin/env node
// bench/aot-product/run_wasm2c_polyfill.mjs — wasm2c 加速 polyfill 实验
//
// 形态：TS(polyfill 纯函数) → emitter wasm → wasm2c C → qzjs 编译期扩展(qz_ext_t)
//       → JS 全局 hpackBatch(n) 直接调原生 C。与 JS 基线 / wamrc AOT 同算法同 N。
// 本机只生成源码与校验结构；编译 + 性能在 CI runner 上做。
// 用法：node bench/aot-product/run_wasm2c_polyfill.mjs
//   WABT_DIR / WASM2C_OUT / OUT_DIR 可覆盖。

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WD = path.join(ROOT, 'bench', 'aot-product', 'wasm2c');
const OUT = process.env.WASM2C_OUT || path.join(ROOT, 'build', 'aot', 'wasm2c-polyfill');
const WABT = process.env.WABT_DIR || path.join(OUT, 'wabt');
const WASM2C = path.join(WABT, 'bin', 'wasm2c');
const SRC = path.join(ROOT, 'bench', 'aot-product', 'workloads', 'pure.ts'); // 含 hpackIntBatch 的纯数值子集
const MOD = 'w2c_pf';                            // wasm2c 输出前缀
const GEN = 'pure';                              // 生成标识符 = wasm 文件名 basename
const HDR = `${MOD}.h`;
const FN = `w2c_${GEN}_hpackIntBatch`;
const INST = `w2c_${GEN}`;
const INIT = `wasm2c_${GEN}_instantiate`;
const FREE = `wasm2c_${GEN}_free`;

if (!existsSync(WASM2C)) { console.error('wasm2c not found:', WASM2C); process.exit(1); }
mkdirSync(OUT, { recursive: true });

// 1. 重编 wasm（确保与 pure.ts 一致）
const { compileTS } = await import(ROOT + 'src/qzvm/aot/emitter.js');
compileTS(SRC, path.join(OUT, 'pure.wasm'), {});

// 2. wasm2c 生成 C/H
execFileSync(WASM2C, [path.join(OUT, 'pure.wasm'), '-o', path.join(OUT, MOD)], { stdio: 'inherit' });
// wasm2c 生成 C 含 unused var/func，与 qzjs -Werror 冲突；注入 pragma 仅放松本文件。
const genC = readFileSync(path.join(OUT, MOD), 'utf8');
const pragma = ['unused-variable','unused-function','unused-value','unused-parameter','unused-but-set-variable']
  .map(w => `#pragma GCC diagnostic ignored "-W${w}"`).join('\n') + '\n';
writeFileSync(path.join(OUT, MOD + '.c'), pragma + genC);

// 3. 生成扩展包装源码
const tpl = readFileSync(path.join(WD, 'polyfill_ext.c.tpl'), 'utf8');
const ext = tpl
  .replace(/W2C_HDR/g, HDR)
  .replace(/IMPORT_IMPL/g, `w2c_qz_math_rem(struct w2c_qz* i, f64 a, f64 b) { (void)i; return fmod(a, b); }`)
  .replace(/TAIL_IMPL/g, `wasm_tailcall_w2c_qz_math_rem(void **ip, void *ts, wasm_rt_tailcallee_t *n) { (void)ip; (void)ts; (void)n; }`)
  .replace(/%INST%/g, INST)
  .replace(/%FN%/g, FN)
  .replace(/%FREE%/g, FREE)
  .replace(/%INST%_instantiate/g, INIT);  // 注意顺序：先替换 _instantiate 形式
// %INST%_instantiate 已在上面被 %INST% 替换成 INST_instantiate，修正为生成名 INIT
let extSrc = ext.replace(`${INST}_instantiate`, INIT);
writeFileSync(path.join(OUT, 'polyfill_ext.c'), extSrc);

// 4. 生成扩展头文件（extern qz_ext_t）
writeFileSync(path.join(OUT, 'polyfill_ext.h'),
`/* generated: extern declaration for QZ_EXTRA_HEADERS */\n#ifndef QZ_W2C_POLYFILL_H\n#define QZ_W2C_POLYFILL_H\n#include <qzjs/qzjs.h>\nextern const qz_ext_t w2c_polyfill_ext;\n#endif\n`);

// 5. 输出构建参数（供 CI 消费）
const cfg = {
  QZ_EXTRA_SOURCES: [path.join(OUT, 'polyfill_ext.c'), path.join(OUT, MOD + '.c'),
    path.join(WABT, 'share', 'wabt', 'wasm2c', 'wasm-rt-impl.c'),
    path.join(WABT, 'share', 'wabt', 'wasm2c', 'wasm-rt-mem-impl.c')].join(';'),
  QZ_EXTRA_HEADERS: path.join(OUT, 'polyfill_ext.h'),
  QZ_EXTENSIONS: 'QZ_DEFAULT_EXTENSIONS &w2c_polyfill_ext',
  CFLAGS: `-I${WABT}/include -I${OUT}`,
};
writeFileSync(path.join(OUT, 'build-config.json'), JSON.stringify(cfg, null, 2));
console.log('wasm2c polyfill extension sources generated at', OUT);
console.log(JSON.stringify(cfg, null, 2));
