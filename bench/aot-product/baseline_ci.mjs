#!/usr/bin/env node
// baseline_ci.mjs — 唯一权威 AOT 性能/内存基线采集器（CI runner 使用）。
// 构建固定版本工具链的 AOT 产物，逐负载独立进程测量 p50/p95 与峰值 RSS，
// 最后一行输出裸 JSON（与 test/compare_perf.py --section aot 对接）。
"use strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const OUT = path.join(ROOT, "build", "aot-baseline");
const BUILD_JS = path.join(ROOT, "src", "qzvm", "aot", "build.js");
const AOTP_SRC = path.join(ROOT, "bench", "aot-product", "workloads", "aotp.ts");
const MIX_SRC = path.join(ROOT, "src", "qzvm", "aot", "mix.ts");
const STR_SRC = path.join(ROOT, "src", "qzvm", "aot", "strwork.ts");
const ZOD_CLASSIC = path.resolve(ROOT, "bench", "aot-product", "node_modules", "zod", "src", "v4", "classic", "index.ts");
const ZOD_BENCH_SRC = path.join(OUT, "zodbench_ci.ts");

function parseArgs() {
  const args = process.argv.slice(2);
  const opt = {
    out: "/tmp/aot-baseline.json",
    qzjs: process.env.QZJS || path.join(ROOT, "build", "qzjs"),
    wamrc: process.env.WAMRC || "wamrc",
    reps: 5,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") opt.out = path.resolve(args[++i]);
    else if (args[i] === "--qzjs") opt.qzjs = path.resolve(args[++i]);
    else if (args[i] === "--wamrc") opt.wamrc = path.resolve(args[++i]);
    else if (args[i] === "--reps") opt.reps = Number(args[++i]);
    else throw new Error(`未知参数: ${args[i]}`);
  }
  if (!Number.isInteger(opt.reps) || opt.reps < 1) throw new Error("--reps 必须是正整数");
  return opt;
}

function text(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  const s = ((r.stdout || "") + (r.stderr || "")).trim().split("\n")[0] || "unknown";
  return s;
}

function machine() {
  const cpu = (() => { try { return fs.readFileSync("/proc/cpuinfo", "utf8").match(/model name\s*:\s*(.+)/)[1].trim(); } catch { return "unknown"; } })();
  const memKb = (() => { try { return Number(fs.readFileSync("/proc/meminfo", "utf8").match(/MemTotal:\s*(\d+) kB/)[1]); } catch { return 0; } })();
  return {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu,
    cpu_count: os.cpus().length,
    mem_total_kib: memKb,
    runner: process.env.GITHUB_RUNNER_OS || os.hostname(),
    commit: text("git", ["rev-parse", "HEAD"]),
    node: process.version,
    python: text("python3", ["--version"]),
  };
}

function artifactSizes(name) {
  const out = {};
  for (const ext of [".wasm", ".aot", ".glue.js", ".interp.js", ".meta.json", ".strings.json"]) {
    const p = path.join(OUT, name + ext);
    out[ext] = fs.existsSync(p) ? fs.statSync(p).size : 0;
  }
  return out;
}

function build(name, src, env, extra = []) {
  const t0 = Date.now();
  try {
    execFileSync(process.execPath, [BUILD_JS, "build", src, name, ...extra], {
      cwd: ROOT,
      env: { ...process.env, AOT_OUT_DIR: OUT, WAMRC: env.wamrc },
      stdio: "pipe",
      timeout: 20 * 60 * 1000,
    });
  } catch (e) {
    throw new Error(`build ${name} 失败: ${(e.stderr || e.stdout || e.message || "").toString().slice(-4000)}`);
  }
  return { wall_ms: Date.now() - t0, artifacts: artifactSizes(name) };
}

// 用 fork+wait4 拿子进程峰值 RSS（spawnSync 拿不到 ru_maxrss）。
function runPeak(cmd, args, cwd) {
  const py = `
import os, sys, json, time, tempfile
cmd = json.loads(sys.argv[1]); cwd = sys.argv[2]
out = tempfile.TemporaryFile(); err = tempfile.TemporaryFile()
t0 = time.time()
pid = os.fork()
if pid == 0:
    os.dup2(out.fileno(), 1); os.dup2(err.fileno(), 2)
    os.chdir(cwd)
    os.execvp(cmd[0], cmd)
_, st, ru = os.wait4(pid, 0)
out.seek(0); err.seek(0)
print(json.dumps({"rss_kib": ru.ru_maxrss, "wall_s": round(time.time()-t0, 4), "status": st,
                  "child_stdout": out.read().decode("utf-8", "replace"),
                  "child_stderr": err.read().decode("utf-8", "replace")}))
`;
  const r = spawnSync("python3", ["-c", py, JSON.stringify([cmd, ...args]), cwd], { encoding: "utf8", timeout: 15 * 60 * 1000 });
  const line = (r.stdout || "").trim().split("\n").pop();
  let peak;
  try { peak = JSON.parse(line); } catch { throw new Error(`runPeak 失败: ${(r.stderr || r.stdout || "").trim()}`); }
  if (peak.status !== 0) throw new Error(`进程失败 status=${peak.status}: ${(peak.child_stderr || r.stdout || "").slice(0, 2000)}`);
  return { ...peak, stdout: peak.child_stdout || r.stdout };
}

function resultOf(stdout, label) {
  const text = stdout || "";
  if (text.includes("AOT load failed:")) {
    throw new Error(`${label}: ${text.split("\n").filter(l => l.includes("AOT load failed:")).pop()}`);
  }
  const line = text.split("\n").filter(l => l.startsWith("RESULT ")).pop();
  if (!line) throw new Error(`${label}: 无 RESULT 输出; tail=${text.slice(-1000)}`);
  return JSON.parse(line.slice("RESULT ".length))[0];
}

function aotHarness(loads, reps) {
  return `
globalThis.__main = function (__call) {
  const out = [];
  for (const [name, arg] of ${JSON.stringify(loads)}) {
    __call(name, [arg]);
    const ts = [];
    for (let r = 0; r < ${reps}; r++) { const t = performance.now(); __call(name, [arg]); ts.push(performance.now() - t); }
    ts.sort((a, b) => a - b);
    const r = __call(name, [arg]);
    out.push({ load: name, p50_ms: +ts[${Math.floor(reps / 2)}].toFixed(3), p95_ms: +ts[${reps - 1}].toFixed(3), check: typeof r === "string" ? r.length : r });
  }
  console.log("RESULT " + JSON.stringify(out));
};
`;
}

function interpHarness(loads, reps, names) {
  return `
const FN = { ${names.join(", ")} };
const out = [];
for (const [name, arg] of ${JSON.stringify(loads)}) {
  const fn = FN[name];
  fn(arg);
  const ts = [];
  for (let r = 0; r < ${reps}; r++) { const t = performance.now(); fn(arg); ts.push(performance.now() - t); }
  ts.sort((a, b) => a - b);
  const r = fn(arg);
  out.push({ load: name, p50_ms: +ts[${Math.floor(reps / 2)}].toFixed(3), p95_ms: +ts[${reps - 1}].toFixed(3), check: typeof r === "string" ? r.length : r });
}
console.log("RESULT " + JSON.stringify(out));
`;
}

function runAotLoad(opt, name, load, reps) {
  const src = fs.readFileSync(path.join(OUT, `${name}.glue.js`), "utf8");
  const file = path.join(OUT, `${name}_${load[0]}_bench.js`);
  fs.writeFileSync(file, src + aotHarness([load], reps));
  try {
    const peak = runPeak(opt.qzjs, [file], OUT);
    return { ...resultOf(peak.stdout, name + "." + load[0]), rss_kib: peak.rss_kib, wall_s: peak.wall_s };
  } finally { fs.unlinkSync(file); }
}

function runInterpLoad(opt, label, source, load, reps, names) {
  const file = path.join(OUT, `${label}_${load[0]}_bench.js`);
  fs.writeFileSync(file, source + interpHarness([load], reps, names));
  try {
    const peak = runPeak(opt.qzjs, [file], OUT);
    return { ...resultOf(peak.stdout, label + "." + load[0]), rss_kib: peak.rss_kib, wall_s: peak.wall_s };
  } finally { fs.unlinkSync(file); }
}

function compare(a, i, label) {
  if (a.check !== i.check) throw new Error(`${label}: AOT/interp 结果不一致: ${JSON.stringify(a.check)} != ${JSON.stringify(i.check)}`);
  return {
    aot: { p50_ms: a.p50_ms, p95_ms: a.p95_ms, rss_kib: a.rss_kib, wall_s: a.wall_s, check: a.check },
    interp: { p50_ms: i.p50_ms, p95_ms: i.p95_ms, rss_kib: i.rss_kib, wall_s: i.wall_s, check: i.check },
    speedup_p50: +(i.p50_ms / a.p50_ms).toFixed(3),
  };
}

const MICRO_INTERP = `
function fib(n){ if(n<2) return n; return fib(n-1)+fib(n-2); }
function numWork(it){ let s=0; for(let i=0;i<it;i++) s=s+fib(20+(i%5)); return s; }
function objWork(n){ let t=0; for(let i=0;i<n;i++){ const r={id:i,sq:i*i,tag:"r"}; t=t+r.id+r.sq; } return t; }
function strWork(n){ let s="0"; for(let i=0;i<n;i++) s=s+i; return s; }
`;

function writeZodSource() {
  if (!fs.existsSync(ZOD_CLASSIC)) throw new Error(`缺 zod 源: ${ZOD_CLASSIC}（先 npm ci --prefix bench/aot-product）`);
  fs.mkdirSync(OUT, { recursive: true });
  const importPath = JSON.stringify(ZOD_CLASSIC);
  fs.writeFileSync(ZOD_BENCH_SRC, `import { z } from ${importPath};
const schema = z.object({ a: z.string(), b: z.number().int(), c: z.array(z.boolean()) });
export function bench(n: number): number {
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const r = schema.safeParse({ a: "x" + i, b: i, c: [true, false] });
    if (r.success) ok++;
  }
  return ok;
}
`);
}

async function main() {
  const opt = parseArgs();
  fs.mkdirSync(OUT, { recursive: true });
  writeZodSource();
  const meta = machine();

  const buildStats = {};
  // jsonWork / validationWork 经 CI 实测 wasm 负优化 → 回退 interp（与 run.js 同口径）。
  buildStats.aotp = build("aotp_ci", AOTP_SRC, opt, ["--interp", "jsonWork,validationWork"]);
  buildStats.mix = build("mix_ci", MIX_SRC, opt);
  buildStats.str = build("str_ci", STR_SRC, opt);
  buildStats.zodbench = build("zodbench_ci", ZOD_BENCH_SRC, opt);

  const funcs = JSON.parse(fs.readFileSync(path.join(OUT, "zodbench_ci.meta.json"), "utf8")).funcs.map(f => f.name);
  buildStats.zodbench_interp = build("zodbench_interp_ci", ZOD_BENCH_SRC, opt, ["--interp", funcs.join(",")]);

  const { LOADS: productLoads, source: productInterp } = require("./workloads/aotp.interp.js");
  const microLoads = [["numWork", 3000], ["objWork", 30000], ["strWork", 200000]];
  const zodLoad = [["bench", 100]];

  const runtime = { product: {}, micro: {}, zodbench: {} };
  for (const l of productLoads) runtime.product[l[0]] = compare(runAotLoad(opt, "aotp_ci", l, opt.reps),
    runInterpLoad(opt, "aotp_ci", productInterp, l, opt.reps, ["computeWork", "jsonWork", "validationWork"]), `product.${l[0]}`);
  for (const l of microLoads) {
    const name = l[0] === "strWork" ? "str_ci" : "mix_ci";
    runtime.micro[l[0]] = compare(runAotLoad(opt, name, l, opt.reps),
      runInterpLoad(opt, name, MICRO_INTERP, l, opt.reps, ["numWork", "objWork", "strWork"]), `micro.${l[0]}`);
  }
  runtime.zodbench.bench = compare(runAotLoad(opt, "zodbench_ci", zodLoad[0], opt.reps),
    runAotLoad(opt, "zodbench_interp_ci", zodLoad[0], opt.reps), "zodbench.bench");

  const base = runPeak(opt.qzjs, ["-e", "0"], ROOT);
  const section = {
    meta: {
      generated_at: new Date().toISOString(),
      machine: meta,
      qzjs: opt.qzjs,
      wamrc: text(opt.wamrc, ["--version"]),
      method: "wait4 ru_maxrss; performance.now(); 1 warmup + N reps, p50/p95",
      reps: opt.reps,
    },
    empty_qzjs: { rss_kib: base.rss_kib, wall_s: base.wall_s },
    build: buildStats,
    runtime,
  };
  fs.writeFileSync(opt.out, JSON.stringify(section, null, 2) + "\n");
  process.stdout.write(JSON.stringify(section) + "\n");
}

main().catch(e => { console.error("baseline_ci:", e.message || e); process.exit(1); });
