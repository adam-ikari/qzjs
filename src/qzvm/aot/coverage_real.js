#!/usr/bin/env node
/* coverage_real.js — 用真实 TS 代码库测 AOT 编译覆盖率。
 *
 * 对每个 .ts 文件独立跑 compileTS，统计：编译成功 / 失败 / 首个错误类别。
 * 这是「距离生产级多远」的客观指标——自造 corpus 只能证明已知路径，
 * 真实代码库才能暴露未覆盖的语法与语义。
 *
 * 用法: node src/qzvm/aot/coverage_real.js <ts目录或文件> [--limit N] [--top N] [--include-tests]
 *
 * 默认排除 tests/、benchmarks/ 目录（见下方 INCLUDE_TESTS 注释）。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const E = require("./emitter.js");

// 覆盖率工具的职责就是解释「为什么没进 wasm」，故默认开启 interp 归因追踪。
process.env.QZDBG_INTERP = process.env.QZDBG_INTERP || "1";

const argv = process.argv.slice(2);
const target = argv[0];
if (!target) { console.error("用法: coverage_real.js <ts目录|文件> [--limit N] [--top N] [--include-tests]"); process.exit(2); }
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
const LIMIT = argVal("--limit", 0);
const TOP = argVal("--top", 25);

function walk(p, out) {
  const st = fs.statSync(p);
  if (st.isFile()) { if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p); return; }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name === "node_modules" && p !== target) continue;
    walk(path.join(p, e.name), out);
  }
  return out;
}

// 默认排除测试/基准目录：它们 import vitest / benchmark / node:buffer 等外部包，
// 失败反映的是「没有那些依赖」，不是编译器缺口。混在一起会把覆盖率分母稀释成噪声。
// 需要测测试文件时传 --include-tests。
const INCLUDE_TESTS = argv.includes("--include-tests");
const files = walk(path.resolve(target), [])
  .filter(f => INCLUDE_TESTS || !/[/\\](tests?|benchmarks?)[/\\]/.test(path.relative(path.resolve(target), f)));
const list = LIMIT ? files.slice(0, LIMIT) : files;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qz-cov-"));
const wasm = path.join(dir, "o.wasm");

let ok = 0;
let funcs = 0, interpFuncs = 0, filesWithInterp = 0, wholeInterp = 0;
const failByKind = new Map();
const samples = new Map();
const reasonCounts = new Map();   // 归因类别 → 函数数
const reasonDetails = new Map();  // 类别 → (callee/上下文 → 函数数)
const reasonFiles = new Map();    // 类别 → 命中文件集合

for (const f of list) {
  try {
    const r = E.compileTS(f, wasm, {});
    ok++;
    // 「编译成功」不等于「进了 wasm」：async/类等无 wasm 通道的函数会退 interp（宿主 JS 副本）。
    // 只报成功率会把「管线不崩」说成「AOT 覆盖」，必须同时给出真实发射分布。
    const n = r.funcMeta.length;
    const ni = r.funcMeta.filter(m => m.mode === "interp").length;
    funcs += n;
    interpFuncs += ni;
    if (ni > 0) filesWithInterp++;
    if (n > 0 && ni === n) wholeInterp++;
    if (r.dbgInterp) {
      const rel = path.relative(path.resolve(target), f);
      for (const why of r.dbgInterp.values()) {
        const i = why.indexOf(":");
        const kind = i >= 0 ? why.slice(0, i) : why;
        const detail = i >= 0 ? why.slice(i + 1) : "";
        reasonCounts.set(kind, (reasonCounts.get(kind) || 0) + 1);
        if (detail) {
          if (!reasonDetails.has(kind)) reasonDetails.set(kind, new Map());
          const d = reasonDetails.get(kind);
          d.set(detail, (d.get(detail) || 0) + 1);
        }
        if (!reasonFiles.has(kind)) reasonFiles.set(kind, new Set());
        reasonFiles.get(kind).add(rel);
      }
    }
  } catch (e) {
    const msg = String((e && e.message) || e).split("\n")[0].replace(/^[^:]+:\s*/, "").trim();
    // 归一化：去掉具体标识符/路径，聚合同类失败
    const kind = msg
      .replace(/\/[^\s:]+/g, "<path>")
      .replace(/'[^']*'/g, "'<id>'")
      .replace(/"[^"]*"/g, '"<id>"')
      .replace(/\b\d+\b/g, "N")
      .slice(0, 110);
    failByKind.set(kind, (failByKind.get(kind) || 0) + 1);
    if (!samples.has(kind)) samples.set(kind, path.relative(process.cwd(), f) + " :: " + msg.slice(0, 120));
  }
  try { fs.unlinkSync(wasm); } catch {}
}

const total = list.length;
const bad = total - ok;
console.log(`样本: ${total} 个 .ts 文件（${path.resolve(target)}）`);
console.log(`编译成功: ${ok} (${((ok / total) * 100).toFixed(1)}%)   失败: ${bad} (${((bad / total) * 100).toFixed(1)}%)`);
const wasmFuncs = funcs - interpFuncs;
console.log(`函数发射: ${funcs} 个，其中 wasm ${wasmFuncs} (${funcs ? ((wasmFuncs / funcs) * 100).toFixed(1) : "0.0"}%)`
  + ` / interp ${interpFuncs} (${funcs ? ((interpFuncs / funcs) * 100).toFixed(1) : "0.0"}%)`);
console.log(`含 interp 的文件: ${filesWithInterp}（整模块 interp: ${wholeInterp}）—— interp 是正确性回退，不是 AOT 覆盖`);
console.log("");
const reasonSorted = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP);
if (reasonSorted.length) {
  console.log(`interp 归因 top ${reasonSorted.length}:`);
  for (const [kind, n] of reasonSorted) {
    console.log(`  ${String(n).padStart(5)}  ${kind}（${reasonFiles.get(kind).size} 个文件）`);
    const d = reasonDetails.get(kind);
    if (d) {
      const top = [...d.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      console.log(`         e.g. ${top.map(([k, v]) => `${k} ×${v}`).join(", ")}`);
    }
  }
  console.log("");
}
const sorted = [...failByKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP);
console.log(`失败类别 top ${sorted.length}:`);
for (const [kind, n] of sorted) {
  console.log(`  ${String(n).padStart(5)}  ${kind}`);
  console.log(`         e.g. ${samples.get(kind)}`);
}
