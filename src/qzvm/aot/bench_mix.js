#!/usr/bin/env node
/* bench_mix.js — AOT 混合负载性能基准（AOT vs qzjs 解释器纯 JS）。
 *
 * 复用仓库已有负载：
 *   mix.ts      : numWork（纯数值 / num 快路径）、objWork（tagged 对象循环）、bigAcc（精度）
 *   strwork.ts  : strWork（tagged 字符串原地追加）
 *
 * 每负载独立子进程：wasm 内 bump 分配器（global0）不随导出调用重置，
 * 同进程连跑会让后一负载撞 2MiB 内存上限（out of bounds），污染计时。
 *
 * 用法：
 *   node src/qzvm/aot/bench_mix.js            # 用已有 build/aot/{mix,str}.glue.js
 *   node src/qzvm/aot/bench_mix.js --build    # 先重建 AOT 产物
 *
 * 环境：QZJS=<qzjs 二进制>（默认 build/dbg/qzjs）；WAMRC=<wamrc>（--build 时）。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..", "..");
const OUT = path.join(ROOT, "build", "aot");
const QZJS = process.env.QZJS || path.join(ROOT, "build", "dbg", "qzjs");

// 每负载：[glue 前缀, 导出名, 参数]
const LOADS = [
    { shim: "mix", name: "numWork", arg: 3000 },
    { shim: "mix", name: "objWork", arg: 30000 },
    { shim: "str", name: "strWork", arg: 8000 },
];

function runQzjs(script, cwd) {
    const r = spawnSync(QZJS, [script], { encoding: "utf8", timeout: 300000, cwd });
    const line = (r.stdout || "").trim().split("\n").filter(l => l.includes("ms=")).pop();
    if (!line) throw new Error(`no result from ${path.basename(script)}: ${(r.stderr || "").trim()}`);
    return line.trim();
}

// 生成 main 钩子：单次调用 + 计时（warmup 会污染 bump；单次足矣，负载本身即循环）
function mainHook(name, arg) {
    return `
globalThis.__main = function (__call) {
  const t = Date.now();
  const r = __call("${name}", [${arg}]);
  console.log("${name} ms=", Date.now() - t, "check=", typeof r === "string" ? r.length : r);
};
`;
}

// glue 运行时按自身 basename 读同目录 .wasm/.aot，故须原地改写 <prefix>.glue.js。
function benchAot() {
    const out = {};
    for (const l of LOADS) {
        const glue = path.join(OUT, `${l.shim}.glue.js`);
        if (!fs.existsSync(glue)) throw new Error(`缺 ${glue}，先跑 --build`);
        const base = fs.readFileSync(glue, "utf8");
        const bak = glue + ".bak";
        fs.renameSync(glue, bak);
        try {
            fs.writeFileSync(glue, base + mainHook(l.name, l.arg));
            out[l.name] = runQzjs(glue, OUT);
        } finally {
            fs.renameSync(bak, glue);
        }
    }
    return out;
}

// 解释器对照：qzjs 直接跑纯 JS（同语义负载）
function benchInterp() {
    const js = `
function fib(n){ if(n<2) return n; return fib(n-1)+fib(n-2); }
function numWork(it){ let s=0; for(let i=0;i<it;i++) s=s+fib(20+(i%5)); return s; }
function objWork(n){ let t=0; for(let i=0;i<n;i++){ const r={id:i,sq:i*i,tag:"r"}; t=t+r.id+r.sq; } return t; }
function strWork(n){ let s="0"; for(let i=0;i<n;i++) s=s+i; return s; }
for (const [name, fn, arg] of [["numWork",numWork,3000],["objWork",objWork,30000],["strWork",strWork,8000]]) {
  const t=Date.now(); const r=fn(arg);
  console.log(name, "ms=", Date.now()-t, "check=", typeof r==="string"?r.length:r);
}
`;
    const f = path.join(os.tmpdir(), "bench_mix_interp.js");
    fs.writeFileSync(f, js);
    const r = spawnSync(QZJS, [f], { encoding: "utf8", timeout: 600000 });
    fs.unlinkSync(f);
    const out = {};
    for (const line of (r.stdout || "").trim().split("\n")) {
        const m = line.match(/^(\w+) ms= (\d+) check= (\S+)/);
        if (m) out[m[1]] = line.trim();
    }
    return out;
}

(function main() {
    if (process.argv.includes("--build")) {
        for (const [src, prefix] of [["mix.ts", "mix"], ["strwork.ts", "str"]]) {
            execSync(`node ${path.join(__dirname, "build.js")} build ${path.join(__dirname, src)} ${prefix}`,
                { stdio: "inherit", env: process.env, cwd: ROOT });
        }
    }
    console.log("qzjs:", QZJS);
    const aot = benchAot();
    const interp = benchInterp();
    console.log("\n负载          AOT                               解释器(纯 JS)");
    for (const l of LOADS) {
        console.log(`${l.name.padEnd(10)}  ${(aot[l.name] || "?").padEnd(34)} ${interp[l.name] || "?"}`);
    }
})();
