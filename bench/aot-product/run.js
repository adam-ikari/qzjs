#!/usr/bin/env node
/* bench/aot-product/run.js — AOT product-level acceptance bench (G1–G5, host calibration).
 *
 * Three real workloads: pure compute / JSON->object / schema validation.
 * Each is timed in two variants, on the SAME host, with the SAME harness:
 *   - wasm  : TS->wasm via build.js compile + glue (WAMR runs the wasm bytecode)
 *   - interp: the same functions as plain JS, run by the qzjs interpreter
 * Reports p50/p95 (5 reps) + payload bytes (wasm + interpJs) vs interp-only JS source.
 *
 * Real-device (C1 Slim) calibration is the same口径; without wamrc only the wasm-if
 * variant is available locally (no native .aot), so absolute ns differ but ratios hold.
 *
 * Usage: node bench/aot-product/run.js [--rebuild]
 *   QZJS=<qzjs binary>   default build-master/qzjs
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(ROOT, "build", "aot");
const QZJS = path.resolve(process.env.QZJS || path.join(ROOT, "build-master", "qzjs"));
const PREFIX = "aotp";
const SRC = path.join(__dirname, "workloads", "aotp.ts");
const { LOADS, source: INTERP_SRC } = require("./workloads/aotp.interp.js");
const REPS = 5;

const MAIN_INTERP = `
const LOADS = ${JSON.stringify(LOADS)};
const FN = { computeWork, jsonWork, validationWork };
const out = [];
for (const [name, arg] of LOADS) {
  const fn = FN[name];
  let wt = null;
  try { fn(arg); } catch (e) { out.push({ load: name, err: String(e && e.message || e) }); continue; }
  const ts = [];
  for (let r = 0; r < ${REPS}; r++) { const t = performance.now(); fn(arg); ts.push(performance.now() - t); }
  ts.sort((a, b) => a - b);
  out.push({ load: name, p50_ms: +ts[${Math.floor(REPS/2)}].toFixed(3), p95_ms: +(ts[${REPS-1}]).toFixed(3), check: typeof fn(arg) });
}
console.log("RESULT " + JSON.stringify(out));
`;

function mainWasm() {
  return `
globalThis.__main = function (__call) {
  const LOADS = ${JSON.stringify(LOADS)};
  const out = [];
  for (const [name, arg] of LOADS) {
    try { __call(name, [arg]); } catch (e) { out.push({ load: name, err: String(e && e.message || e) }); continue; }
    const ts = [];
    for (let r = 0; r < ${REPS}; r++) { const t = performance.now(); __call(name, [arg]); ts.push(performance.now() - t); }
    ts.sort((a, b) => a - b);
    let check = null;
    try { check = typeof __call(name, [arg]); } catch (e) { check = "ERR"; }
    out.push({ load: name, p50_ms: +ts[${Math.floor(REPS/2)}].toFixed(3), p95_ms: +(ts[${REPS-1}]).toFixed(3), check });
  }
  console.log("RESULT " + JSON.stringify(out));
};
`;
}

function qzjsRun(file, cwd) {
  const r = spawnSync(QZJS, [file], { encoding: "utf8", timeout: 300000, cwd: cwd || OUT });
  return r.stdout || "";
}

function build() {
  const b = path.join(ROOT, "src", "qzvm", "aot", "build.js");
  // jsonWork 无 wasm 优化空间（JSON.parse 产宿主对象，prop_get/get_index 每轮 11 次跨界；
  // CI 实测 wasm-AOT 0.50× 于 qzjs 解释）→ 回退 interp，避免负优化。
  execFileSync("node", [b, "compile", SRC, PREFIX, "--interp", "jsonWork"], { stdio: "inherit" });
  execFileSync("node", [b, "glue", PREFIX, "--no-aot"], { cwd: OUT, stdio: "inherit" });
}

function bytes(p) { return fs.existsSync(p) ? fs.statSync(p).size : 0; }

function main() {
  if (process.argv.includes("--rebuild")) build();
  for (const f of [`${PREFIX}.glue.js`, `${PREFIX}.wasm`]) {
    if (!fs.existsSync(path.join(OUT, f))) { console.error(`missing ${f}; run with --rebuild`); process.exit(1); }
  }
  // wasm variant
  const glue = path.join(OUT, `${PREFIX}.glue.js`);
  const glueTmp = path.join(OUT, `${PREFIX}_run.js`);
  fs.writeFileSync(glueTmp, fs.readFileSync(glue, "utf8") + mainWasm());
  const wasmOut = qzjsRun(glueTmp);
  const interpTmp = path.join(os.tmpdir(), `aotp_interp.js`);
  fs.writeFileSync(interpTmp, INTERP_SRC + MAIN_INTERP);
  const interpOut = qzjsRun(interpTmp);
  fs.unlinkSync(glueTmp);
  fs.unlinkSync(interpTmp);

  const parse = (s) => { const m = (s || "").match(/RESULT (\[.*\])/); return m ? JSON.parse(m[1]) : null; };
  const w = parse(wasmOut), i = parse(interpOut);
  // payload: wasm variant = wasm + interpJs ; interp-only baseline = workload JS source
  const wasmPayload = bytes(path.join(OUT, `${PREFIX}.wasm`)) + bytes(path.join(OUT, `${PREFIX}.interp.js`));
  const interpPayload = Buffer.byteLength(INTERP_SRC, "utf8");
  const rows = LOADS.map((l, k) => {
    const wl = w && w[k] ? w[k] : {}, il = i && i[k] ? i[k] : {};
    const p50 = wl.p50_ms && il.p50_ms ? +(il.p50_ms / wl.p50_ms).toFixed(2) : null;
    return { load: l[0], wasm_p50: wl.p50_ms ?? wl.err, interp_p50: il.p50_ms ?? il.err,
             wasm_p95: wl.p95_ms, interp_p95: il.p95_ms, speedup_p50: p50,
             check_wasm: wl.check, check_interp: il.check };
  });
  console.log("\n=== bench/aot-product (host) ===");
  console.table(rows);
  console.log(`payload bytes: wasm+interpJs=${wasmPayload}  interp-only(source)=${interpPayload}  delta=${interpPayload ? ((wasmPayload - interpPayload) / interpPayload * 100).toFixed(1) + "%" : "n/a"}`);
}

main();
