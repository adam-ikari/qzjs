#!/usr/bin/env node
/* bench_scin.js — 科学计算性能基准（AOT wasm vs qzjs 解释器 vs V8 JIT）。
 *
 * 负载见 scin.ts：数值积分 / 矩阵乘 / N 体 / 素数筛 / Lorenz ODE / 蒙特卡洛 π / Mandelbrot 分形。
 *
 * 用法：
 *   node src/qzvm/aot/bench_scin.js             # 用已有 build/aot/scin.{glue.js,wasm,aot}
 *   node src/qzvm/aot/bench_scin.js --build     # 先重建 AOT 产物
 *
 * 环境：QZJS=<qzjs 二进制>（默认 build/qzjs）；WAMRC=<wamrc>（--build 时）。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..", "..");
const OUT = path.join(ROOT, "build", "aot");
const QZJS = path.resolve(process.env.QZJS || path.join(ROOT, "build", "qzjs"));

// [名字, 实参, 说明]。说明里的模式标签由 glue 的 __meta 动态补全（见下方 aotMode）。
// 前 7 个是自然写法（含数组/箭头函数），后 4 个是纯标量对照版。
const CASES = [
    ["integrate", [100000], "Simpson 求 π"],
    ["matmul", [120], "120×120 矩阵乘"],
    ["nbody", [60], "32 体引力 60 步"],
    ["sieve", [200000], "素数筛 ≤2e5"],
    ["lorenz", [20000], "Lorenz RK4 2e4 步"],
    ["mcpi", [500000], "蒙特卡洛 π 5e5 点"],
    ["mandel", [300, 200], "Mandelbrot 300×200"],
    ["nbodyNum", [60], "32 体引力 60 步·标量"],
    ["mcpiNum", [500000], "蒙特卡洛 π 5e5 点·标量"],
    ["sieveNum", [3000], "试除素数 ≤3e3·标量"],
    ["matmulNum", [120], "张量积和式 120³·标量"],
];

const REPEAT = 3;   // 每个负载跑 REPEAT 次取最好

function hookBody() {
    return `
globalThis.__main = function (__call) {
  const CASES = ${JSON.stringify(CASES)};
  for (const [n, a] of CASES) {
    let best = Infinity, val = null;
    for (let i = 0; i < ${REPEAT}; i++) {
      const t = performance.now();
      val = __call(n, a);
      const d = performance.now() - t;
      if (d < best) best = d;
    }
    console.log(n, "ms=", best.toFixed(2), "val=", typeof val === "number" ? val.toFixed(6) : val);
  }
};`;
}

function parse(stdout) {
    const out = {};
    for (const line of (stdout || "").trim().split("\n")) {
        const m = line.match(/^(\w+) ms= ([\d.]+) val= (\S+)/);
        if (m) out[m[1]] = { ms: parseFloat(m[2]), val: m[3] };
    }
    return out;
}

// 从产物 glue 的 __meta 提取真实编译模式（num/tagged/interp），标签不再硬编码。
function aotModes() {
    const glue = path.join(OUT, "scin.glue.js");
    if (!fs.existsSync(glue)) return {};
    const m = fs.readFileSync(glue, "utf8").match(/const __meta = (\[.*?\]);/);
    if (!m) return {};
    try { return Object.fromEntries(JSON.parse(m[1]).map(f => [f.name, f.mode])); } catch { return {}; }
}

// AOT：把 __main 钩子追加到 glue 尾部，跑完还原。
function benchAot() {
    const glue = path.join(OUT, "scin.glue.js");
    if (!fs.existsSync(glue)) throw new Error(`缺 ${glue}，先跑 --build`);
    const bak = glue + ".benchbak";
    fs.copyFileSync(glue, bak);
    try {
        fs.writeFileSync(glue, fs.readFileSync(bak, "utf8") + hookBody());
        const r = spawnSync(QZJS, [glue], { encoding: "utf8", cwd: OUT, timeout: 1800000 });
        if (r.status !== 0) throw new Error(`AOT 失败: ${(r.stderr || "").trim().slice(0, 400)}`);
        return parse(r.stdout);
    } finally {
        fs.renameSync(bak, glue);
    }
}

// 解释器对照：qzjs 直接跑纯 JS（同语义负载，已剥类型注解）
function benchInterp() {
    const js = interpSource();
    const f = path.join(os.tmpdir(), "bench_scin_interp.js");
    fs.writeFileSync(f, js);
    try {
        const r = spawnSync(QZJS, [f], { encoding: "utf8", timeout: 1800000 });
        if (r.status !== 0) throw new Error(`qzjs 解释器失败: ${(r.stderr || "").trim().slice(0, 400)}`);
        return parse(r.stdout);
    } finally {
        fs.unlinkSync(f);
    }
}

// 原生 V8 对照：同源码跑 node（真实 JIT），AOT 的上界参照
function benchV8() {
    const js = interpSource();
    const f = path.join(os.tmpdir(), "bench_scin_v8.js");
    fs.writeFileSync(f, js);
    try {
        const r = spawnSync(process.execPath, [f], { encoding: "utf8", timeout: 1800000 });
        return parse(r.stdout);
    } finally {
        fs.unlinkSync(f);
    }
}

// 剥 TS 类型注解，得到 V8/qzjs 都能跑的纯 JS（含 REPEAT 计时逻辑）
function interpSource() {
    let src = fs.readFileSync(path.join(__dirname, "scin.ts"), "utf8");
    src = src
        .replace(/^export /gm, "")
        .replace(/: number\[\]/g, "")
        .replace(/: boolean\[\]/g, "")
        .replace(/: number/g, "")
        .replace(/: void/g, "")
        .replace(/: any/g, "");
    return src + `
const CASES = ${JSON.stringify(CASES)};
for (const [n, a] of CASES) {
  const fn = eval(n);
  let best = Infinity, val = null;
  for (let i = 0; i < ${REPEAT}; i++) {
    const t = performance.now();
    val = fn(...a);
    const d = performance.now() - t;
    if (d < best) best = d;
  }
  console.log(n, "ms=", best.toFixed(2), "val=", typeof val === "number" ? val.toFixed(6) : val);
}
`;
}

function build() {
    const wamrc = process.env.WAMRC || path.join(ROOT, "deps", "wamr", "wamr-compiler", "build", "wamrc");
    const r = spawnSync(process.execPath, [path.join(__dirname, "build.js"), "build",
        path.join(__dirname, "scin.ts"), "scin"], { encoding: "utf8", env: { ...process.env, WAMRC: wamrc } });
    if (r.status !== 0) throw new Error(`build 失败: ${(r.stderr || r.stdout || "").trim().slice(0, 600)}`);
}

const t0 = Date.now();
if (process.argv.includes("--build")) { console.log("> 重建 AOT 产物…"); build(); }
console.log(`> AOT  (${path.basename(QZJS)})…`);
const aot = benchAot();
console.log("> qzjs 解释器…");
const interp = benchInterp();
console.log("> V8 JIT (node)…");
const v8 = benchV8();
const modes = aotModes();
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
console.log("");
console.log(pad("负载", 22) + padL("AOT ms", 10) + padL("解释器 ms", 12) + padL("V8 ms", 10)
    + padL("AOT/解释", 11) + padL("AOT/V8", 9) + "  校验");
console.log("-".repeat(88));
let okAll = true;
for (const [n, a, desc] of CASES) {
    const A = aot[n], I = interp[n], V = v8[n];
    if (!A || !I || !V) { console.log(pad(n, 22) + "  缺失结果"); okAll = false; continue; }
    const sameAI = A.val === I.val, sameAV = A.val === V.val;
    const chk = sameAI && sameAV ? "OK" : `差异 AOT=${A.val} 解释=${I.val} V8=${V.val}`;
    if (!sameAI || !sameAV) okAll = false;
    console.log(
        pad(`${n} ${desc}${modes[n] ? " · " + modes[n] : ""}`, 30)
        + padL(A.ms, 10) + padL(I.ms, 12) + padL(V.ms, 10)
        + padL((I.ms / A.ms).toFixed(2) + "×", 11) + padL((V.ms / A.ms).toFixed(2) + "×", 9)
        + "  " + chk
    );
}
console.log("");
console.log(okAll ? "数值校验：全部一致" : "数值校验：存在差异（见上行）");
console.log(`Wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!okAll) process.exitCode = 1;
