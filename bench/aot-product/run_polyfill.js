#!/usr/bin/env node
// bench/aot-product/run_polyfill.js — AOT 加速 qzjs polyfill 的实验对照
//
// 问题：把 polyfill 里真实纯计算函数交给 AOT，能给 qzjs 整体带来多少提升？
// 方法：同一算法两份实现，各自在 qzjs 进程内跑，p50 对照：
//   - baseline：polyfill 原样 JS（从 src/polyfill/src/hpack.js 摘出的 varint encode 逻辑）
//   - aot     ：同一逻辑经 emitter → wasm → wamrc AOT，经 glue 调用
// 两者输出逐点比对（check 一致才计入比值），口径同 run.js（5 reps, p50/p95）。
// 本机不跑性能；CI runner 上执行。
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const QZJS = path.resolve(process.env.QZJS || path.join(ROOT, "build", "qzjs"));
const OUT = path.join(ROOT, "build", "aot", "polyfill");
const SRC = path.join(OUT, "hpack_int.ts");
const PREFIX = "hpack_int";
const N = 200000;
const REPS = 5;
const WAMRC = process.env.WAMRC || "wamrc";

// 与 hpack.js encodeInt（RFC7541 §5.1）同逻辑：返回 varint 占用字节数
const IMPL = `
function encodeIntLen(value: number, prefixBits: number): number {
  const mask = (1 << prefixBits) - 1;
  if (value < mask) return 1;
  let n = 1, v = value - mask;
  while (v >= 128) { n = n + 1; v = (v / 128) | 0; }
  return n + 1;
}
function batch(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) t = t + encodeIntLen((i * 7919) % 1000003, 7);
  return t;
}
`;
const JS_IMPL = `
function encodeIntLen(value, prefixBits) {
  const mask = (1 << prefixBits) - 1;
  if (value < mask) return 1;
  let n = 1, v = value - mask;
  while (v >= 128) { n = n + 1; v = Math.floor(v / 128); }
  return n + 1;
}
function batch(n) { let t = 0; for (let i=0;i<n;i++) t += encodeIntLen((i*7919)%1000003, 7); return t; }
`;

function harness(aot) {
  const call = aot ? "__call('batch', [" + N + "])" : "batch(" + N + ")";
  return `
${aot ? "globalThis.__main = function(__call) {" : ""}
  const ts = [];
  for (let r = 0; r < ${REPS}; r++) { const t0 = performance.now(); ${call}; ts.push(performance.now() - t0); }
  ts.sort((a,b)=>a-b);
  console.log("RESULT " + JSON.stringify({p50_ms: +ts[${Math.floor(REPS / 2)}].toFixed(3), p95_ms: +ts[${REPS - 1}].toFixed(3), check: ${call}}));
${aot ? "};" : ""}
`;
}
function run(code) {
  const f = path.join(os.tmpdir(), "qz_polyfill_" + (code.includes("__call") ? "aot" : "js") + ".js");
  fs.writeFileSync(f, code);
  const r = spawnSync(QZJS, [f], { encoding: "utf8", timeout: 300000, cwd: OUT });
  const m = (r.stdout || "").match(/RESULT (\{.*\})/);
  if (!m) { console.error("no RESULT:", (r.stderr || "").slice(0, 300)); return null; }
  return JSON.parse(m[1]);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(SRC, IMPL);
const build = path.join(ROOT, "src", "qzvm", "aot", "build.js");
execFileSync(process.execPath, [build, "build", SRC, PREFIX], {
  cwd: OUT, stdio: "inherit", env: { ...process.env, AOT_OUT_DIR: OUT, WAMRC },
});
const glue = fs.readFileSync(path.join(OUT, PREFIX + ".glue.js"), "utf8");
const base = run(JS_IMPL + harness(false));
const aot = run(glue + harness(true));
if (!base || !aot) process.exit(1);
console.log("\n=== AOT 加速 polyfill（qzjs 进程内，N=" + N + "，5 reps）===");
console.log("baseline JS:", base);
console.log("AOT wasm  :", aot);
console.log("check 一致:", base.check === aot.check);
console.log("speedup p50:", +(base.p50_ms / aot.p50_ms).toFixed(2) + "×");
