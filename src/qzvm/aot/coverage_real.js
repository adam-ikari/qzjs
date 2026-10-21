#!/usr/bin/env node
/* coverage_real.js — 用真实 TS 代码库测 AOT 编译覆盖率。
 *
 * 对每个 .ts 文件独立跑 compileTS，统计：编译成功 / 失败 / 首个错误类别。
 * 这是「距离生产级多远」的客观指标——自造 corpus 只能证明已知路径，
 * 真实代码库才能暴露未覆盖的语法与语义。
 *
 * 用法: node src/qzvm/aot/coverage_real.js <ts目录或文件> [--limit N] [--top N]
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const E = require("./emitter.js");

const argv = process.argv.slice(2);
const target = argv[0];
if (!target) { console.error("用法: coverage_real.js <ts目录|文件> [--limit N] [--top N]"); process.exit(2); }
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

const files = walk(path.resolve(target), []);
const list = LIMIT ? files.slice(0, LIMIT) : files;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qz-cov-"));
const wasm = path.join(dir, "o.wasm");

let ok = 0;
const failByKind = new Map();
const samples = new Map();

for (const f of list) {
  try {
    E.compileTS(f, wasm, {});
    ok++;
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
console.log("");
const sorted = [...failByKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP);
console.log(`失败类别 top ${sorted.length}:`);
for (const [kind, n] of sorted) {
  console.log(`  ${String(n).padStart(5)}  ${kind}`);
  console.log(`         e.g. ${samples.get(kind)}`);
}
