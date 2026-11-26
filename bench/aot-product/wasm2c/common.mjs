// wasm2c 工具链的共用片段。消费方：run_wasm2c.mjs / run_wasm2c_polyfill.mjs /
// run_wasm2c_full.mjs。三者都要做同一串事（找 wabt 1.0.42 → wasm 转 C → 链接
// wasm-rt），差别只在「生成什么 harness / 是否编进 qzjs」。抽掉的正是这串重复。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';

const VERSION = '1.0.42';

// wasm2c 生成 C 与 wasm-rt 源码在 qzjs -std=c99/-Werror 下的固定告警集合。
// 一份列表同时用于生成 C 的前缀与 runtime 副本，避免两处列表漂移。
export const WARNINGS = [
  'unused-parameter', 'unused-variable', 'unused-function', 'unused-value',
  'unused-but-set-variable', 'sign-compare',
];

export function pragma(warnings = WARNINGS) {
  return warnings.map((w) => `#pragma GCC diagnostic ignored "-W${w}"`).join('\n') + '\n';
}

export function toolchain(outDir) {
  const wabt = process.env.WABT_DIR || path.join(outDir, 'wabt');
  const wasm2c = path.join(wabt, 'bin', 'wasm2c');
  if (!existsSync(wasm2c)) {
    console.error('wasm2c not found:', wasm2c, '— set WABT_DIR');
    process.exit(1);
  }
  // 1.0.42 是硬约束：1.0.27 在带 import 的模块上崩溃，生成签名也随版本变。
  const v = spawnSync(wasm2c, ['--version'], { encoding: 'utf8' });
  const got = (v.stdout || v.stderr || '').trim();
  if (v.status !== 0 || !got.includes(VERSION)) {
    console.error(`wasm2c ${VERSION} required, got "${got}" (set WABT_DIR)`);
    process.exit(1);
  }
  return {
    wabt,
    wasm2c,
    include: path.join(wabt, 'include'),
    runtime: path.join(wabt, 'share', 'wabt', 'wasm2c'),
  };
}

// wasm2c 输出没有扩展名，补成 .c 才能直接喂 gcc；.h 同基名。
export function wasmToC(tc, wasmPath, outBase) {
  execFileSync(tc.wasm2c, [wasmPath, '-o', outBase], { stdio: 'inherit', maxBuffer: 1 << 28 });
  writeFileSync(outBase + '.c', readFileSync(outBase));
  return { c: outBase + '.c', h: outBase + '.h' };
}

// qzjs 的 -std=c99/-Werror 不认 wasm-rt 的 SA_ONSTACK/SIGSTKSZ；复制进工作区
// 并加 pragma（与项目对 miniz/libuv 的第三方隔离同思路），返回供 QZ_EXTRA_SOURCES 用。
export function runtimeSources(tc, outDir, warnings = WARNINGS) {
  return ['wasm-rt-impl.c', 'wasm-rt-mem-impl.c'].map((f) => {
    const dst = path.join(outDir, f);
    writeFileSync(dst, pragma(warnings) + readFileSync(path.join(tc.runtime, f), 'utf8'));
    return dst;
  });
}

// 独立 native 二进制共用的链接配方。WASM_RT_SKIP_SIGNAL_RECOVERY=1 让
// wasm_rt_init/free 不装进程级 SIGSEGV/SIGBUS handler，避免与 WAMR 抢。
export function linkNative({ tc, outDir, sources, binary }) {
  execFileSync('gcc', [
    '-O3', '-std=c99', '-D_GNU_SOURCE', '-DWASM_RT_SKIP_SIGNAL_RECOVERY=1',
    '-I' + tc.include, '-I' + outDir, '-o', binary,
    ...sources,
    path.join(tc.runtime, 'wasm-rt-impl.c'), path.join(tc.runtime, 'wasm-rt-mem-impl.c'), '-lm',
  ], { stdio: 'inherit', maxBuffer: 1 << 28 });
}
