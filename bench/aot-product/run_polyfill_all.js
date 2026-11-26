#!/usr/bin/env node
// bench/aot-product/run_polyfill_all.js — polyfill 加速三档对照
//
// 同一 hpack varint 算法，三档在各自 qzjs 进程内跑，check 逐点一致才计比值：
//   1. baseline JS  ：polyfill 原样 JS（QZJS）
//   2. wamrc AOT    ：emitter wasm → wamrc AOT（QZJS + build/aot/polyfill）
//   3. wasm2c native：wasm → C → 编译期扩展 qz_ext_t → JS 全局 hpackBatch（QZJS_W2C）
// 需要两份 qzjs：普通 Release（1/2）与带 wasm2c 扩展的 Release（3）。
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const QZJS = path.resolve(process.env.QZJS || path.join(ROOT, "build", "qzjs"));
const QZJS_W2C = process.env.QZJS_W2C ? path.resolve(process.env.QZJS_W2C) : null;
const N = 200000, REPS = 5;
const OUT = path.join(ROOT, "build", "aot", "polyfill");

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
function benchSrc(call) {
  return `
  const ts = [];
  for (let r = 0; r < ${REPS}; r++) { const t0 = performance.now(); ${call}; ts.push(performance.now() - t0); }
  ts.sort((a,b)=>a-b);
  console.log("RESULT " + JSON.stringify({p50_ms: +ts[${Math.floor(REPS/2)}].toFixed(3), p95_ms: +ts[${REPS-1}].toFixed(3), check: ${call}}));
`;
}
function run(bin, code, tag) {
  if (!bin) return null;
  const f = path.join(os.tmpdir(), "qz_poly3_" + tag + ".js");
  fs.writeFileSync(f, code);
  const r = spawnSync(bin, [f], { encoding: "utf8", timeout: 300000, cwd: OUT });
  if (r.error || r.status !== 0) {
    console.error(tag, "failed:", r.error ? r.error.message : "exit " + r.status,
                  (r.stderr || "").slice(0, 300));
    return null;
  }
  const m = (r.stdout || "").match(/RESULT (\{.*\})/);
  if (!m) { console.error(tag, "no RESULT:", (r.stderr || "").slice(0, 300)); return null; }
  return JSON.parse(m[1]);
}

const base = run(QZJS, JS_IMPL + benchSrc(`batch(${N})`), "js");
const gluePath = path.join(OUT, "hpack_int.glue.js");
const aot = fs.existsSync(gluePath)
  ? run(QZJS, fs.readFileSync(gluePath, "utf8") + `globalThis.__main = function(__call) {${benchSrc(`__call('batch', [${N}])`)}};`, "aot")
  : null;
const w2c = QZJS_W2C ? run(QZJS_W2C, benchSrc(`polyfillBatch(${N})`), "w2c") : null;

console.log("\n=== polyfill 加速三档（qzjs 进程内，N=" + N + "，5 reps）===");
for (const [name, r] of [["baseline JS", base], ["wamrc AOT", aot], ["wasm2c native ext", w2c]]) {
  console.log(name.padEnd(20), r ? JSON.stringify(r) : "N/A");
}
const ref = base && base.check;
// 三档必须都存在：缺档不能算「一致」，否则 CI 会在 wasm2c 档没跑时静默变绿。
const allOk = !!(base && aot && w2c) &&
  aot.check === ref && w2c.check === ref;
console.log("check 一致:", allOk);
if (base && aot) console.log("AOT vs JS p50:", +(base.p50_ms / aot.p50_ms).toFixed(2) + "×");
if (base && w2c) console.log("wasm2c vs JS p50:", +(base.p50_ms / w2c.p50_ms).toFixed(2) + "×");
if (aot && w2c) console.log("wasm2c vs AOT p50:", +(aot.p50_ms / w2c.p50_ms).toFixed(2) + "×");
if (!allOk) {
  if (!base) console.error("missing tier: baseline JS");
  if (!aot) console.error("missing tier: wamrc AOT");
  if (!w2c) console.error("missing tier: wasm2c native ext");
  process.exit(1);
}
