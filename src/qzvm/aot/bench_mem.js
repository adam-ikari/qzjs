#!/usr/bin/env node
/* bench_mem.js — AOT(TS→wasm) vs 解释器(TS→JS) 内存占用对比。
 *
 * 同一份 TS 负载，两种执行形态，各起独立 qzjs 进程，用 wait4 的 ru_maxrss
 * 取进程峰值 RSS（含 wasm 线性内存的真实驻留）。
 *
 *   AOT  : TS → wasm(+wamrc .aot) → <prefix>.glue.js，qzjs 跑 glue
 *   interp: TS 剥类型 → 纯 JS，qzjs 直接解释执行
 *
 * 用法：
 *   node src/qzvm/aot/bench_mem.js            # 用已有 build/aot 产物
 *   node src/qzvm/aot/bench_mem.js --build    # 先重建
 * 环境：QZJS=<qzjs 二进制>（默认 build/qzjs）、WAMRC=<wamrc>
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..", "..");
const OUT = path.join(ROOT, "build", "aot");
const QZJS = path.resolve(process.env.QZJS || path.join(ROOT, "build", "qzjs"));
const ts = require("./node_modules/typescript");

// 与 bench_mix 同负载（数值 / 对象 / 字符串），参数取小以免污染内存曲线
const LOADS = [
  { shim: "mix", src: "mix.ts", name: "numWork", arg: 3000 },
  { shim: "mix", src: "mix.ts", name: "objWork", arg: 30000 },
  { shim: "str", src: "strwork.ts", name: "strWork", arg: 200000 },
];

// 用 fork+wait4 拿子进程峰值 RSS（node 的 spawnSync 拿不到 ru_maxrss）
function runPeak(cmd, args, cwd) {
  const py = `
import os, sys, json, time
cmd = json.loads(sys.argv[1]); cwd = sys.argv[2]
t0 = time.time()
pid = os.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(cmd[0], cmd)
_, st, ru = os.wait4(pid, 0)
print(json.dumps({"rss_mib": ru.ru_maxrss/1024.0, "wall": time.time()-t0, "status": st}))
`;
  const r = spawnSync("python3", ["-c", py, JSON.stringify([cmd, ...args]), cwd], { encoding: "utf8", timeout: 900000 });
  const line = (r.stdout || "").trim().split("\n").pop();
  try { return JSON.parse(line); } catch { throw new Error(`runPeak 失败: ${(r.stderr || "").trim()}`); }
}

function stripTypes(tsSrc, outPath) {
  const js = ts.transpileModule(tsSrc, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None, removeComments: true },
  }).outputText;
  fs.writeFileSync(outPath, js);
  return js;
}

function mainHook(name, arg) {
  return `
globalThis.__main = (__call) => {
  const r = __call("${name}", [${arg}]);
  console.log("${name} check=", typeof r === "string" ? r.length : r);
};`;
}

function benchAot(prefix, name, arg) {
  const glue = path.join(OUT, `${prefix}.glue.js`);
  if (!fs.existsSync(glue)) throw new Error(`缺 ${glue}，先跑 --build`);
  const base = fs.readFileSync(glue, "utf8");
  const bak = glue + ".bak";
  fs.renameSync(glue, bak);
  try {
    fs.writeFileSync(glue, base + mainHook(name, arg));
    return runPeak(QZJS, [glue], OUT);
  } finally { fs.renameSync(bak, glue); }
}

function benchInterp(srcFile, name, arg) {
  const js = path.join(os.tmpdir(), `bench_mem_interp_${path.basename(srcFile)}.js`);
  stripTypes(fs.readFileSync(path.join(__dirname, srcFile), "utf8"), js);
  const code = fs.readFileSync(js, "utf8") + `
{ const r = ${name}(${arg}); console.log("${name} check=", typeof r === "string" ? r.length : r); }`;
  const f = path.join(os.tmpdir(), `bench_mem_run_${name}.js`);
  fs.writeFileSync(f, code);
  try { return runPeak(QZJS, [f], os.tmpdir()); }
  finally { fs.unlinkSync(f); fs.unlinkSync(js); }
}

function benchBuild() {
  const seen = new Set();
  for (const l of LOADS) {
    if (seen.has(l.shim)) continue;
    seen.add(l.shim);
    execSync(`node ${path.join(__dirname, "build.js")} build ${path.join(__dirname, l.src)} ${l.shim}`,
      { stdio: "inherit", env: process.env });
  }
}

if (process.argv.includes("--build")) benchBuild();

console.log(`qzjs: ${QZJS}`);
console.log("基准（qzjs 空载）:", JSON.stringify(runPeak(QZJS, ["-e", "0"], ROOT)));
console.log("");
const rows = [];
for (const l of LOADS) {
  const a = benchAot(l.shim, l.name, l.arg);
  const i = benchInterp(l.src, l.name, l.arg);
  rows.push({ load: `${l.shim}.${l.name}(${l.arg})`, aot: a.rss_mib, interp: i.rss_mib, diff: a.rss_mib - i.rss_mib,
              aotWall: a.wall, interpWall: i.wall });
}
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("负载", 28) + pad("AOT RSS", 12) + pad("解释 RSS", 12) + pad("差值", 10) + pad("AOT 耗时", 12) + "解释耗时");
for (const r of rows) {
  console.log(pad(r.load, 28) + pad(r.aot.toFixed(1) + " MiB", 12) + pad(r.interp.toFixed(1) + " MiB", 12)
    + pad((r.diff >= 0 ? "+" : "") + r.diff.toFixed(1) + " MiB", 10)
    + pad(r.aotWall.toFixed(2) + "s", 12) + r.interpWall.toFixed(2) + "s");
}
