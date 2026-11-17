#!/usr/bin/env node
/* Rank the 39 whole-module interp files by impact.
 * Criteria per module: own function count, interp reason, direct dependents,
 * entry points affected, test files blocked. Analysis only — no code changes.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ts = require("/home/gem/project/qzjs/src/qzvm/aot/node_modules/typescript");
const E = require("/home/gem/project/qzjs/src/qzvm/aot/emitter.js");
process.env.QZDBG_INTERP = "1";

const ROOT = "/home/gem/project/report_mcp/node_modules/zod/src";
const dir = fs.mkdtempSync("/tmp/qz-gap-");
const wasmPath = path.join(dir, "o.wasm");

function walk(p, out) {
  const st = fs.statSync(p);
  if (st.isFile()) { if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p); return; }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    walk(path.join(p, e.name), out);
  }
  return out;
}

const allFiles = walk(ROOT, []);
const isTest = f => /[/\\]tests?[/\\]/.test(path.relative(ROOT, f));
const srcFiles = allFiles.filter(f => !isTest(f));
const testFiles = allFiles.filter(isTest);

// 1. Count own functions per file (FunctionDeclaration + MethodDeclaration + arrow consts)
function countOwnFuncs(f) {
  const sf = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.ES2020, true);
  let n = 0;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) n++;
    if (ts.isArrowFunction(node)) n++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

// 2. Compile each src file → whole-interp + reason
const wholeInterp = [];
for (const f of srcFiles) {
  try {
    const r = E.compileTS(f, wasmPath, { inModuleLink: true });
    const n = r.funcMeta.length;
    const ni = r.funcMeta.filter(m => m.mode === "interp").length;
    const rel = path.relative(ROOT, f);
    if (n > 0 && ni === n) {
      const reasons = new Map();
      if (r.dbgInterp) for (const why of r.dbgInterp.values()) {
        const kind = why.indexOf(":") >= 0 ? why.slice(0, why.indexOf(":")) : why;
        reasons.set(kind, (reasons.get(kind) || 0) + 1);
      }
      wholeInterp.push({ rel, path: f, ownFuncs: countOwnFuncs(f), reasons });
    }
  } catch (e) {}
  try { fs.unlinkSync(wasmPath); } catch {}
}

// 3. Import graph from ALL files (src + test): resolve relative imports
const fileByRel = new Map();
for (const f of allFiles) fileByRel.set(path.relative(ROOT, f).replace(/\.ts$/, ""), f);

function resolveImport(importerPath, importSpec) {
  const clean = importSpec.replace(/\.js$/, "").replace(/\.ts$/, "");
  const resolved = path.resolve(path.dirname(importerPath), clean);
  const rel = path.relative(ROOT, resolved);
  return fileByRel.has(rel) ? rel : (fileByRel.has(rel + ".ts") ? rel + ".ts" : null);
}

const dependents = new Map();  // rel (no ext) → Set<importer rel (no ext)>
function addDep(target, importer) {
  if (!target || !importer || target === importer) return;
  if (!dependents.has(target)) dependents.set(target, new Set());
  dependents.get(target).add(importer);
}

for (const f of allFiles) {
  const src = fs.readFileSync(f, "utf8");
  const importerRel = path.relative(ROOT, f).replace(/\.ts$/, "");
  const re = /(?:import|export)[^;]*?\sfrom\s+["'](\.{1,2}\/[^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) addDep(resolveImport(f, m[1]), importerRel);
}

// 4. Transitive dependents (who transitively imports this module)
function transitiveDeps(target, seen = new Set()) {
  if (seen.has(target)) return seen;
  seen.add(target);
  const direct = dependents.get(target);
  if (direct) for (const d of direct) transitiveDeps(d, seen);
  return seen;
}

// Entry points = files matching index.ts or external.ts (public entry)
const entryRels = new Set(srcFiles.filter(f => /^(index|external)\.ts$/.test(path.basename(f)))
  .map(f => path.relative(ROOT, f).replace(/\.ts$/, "")));

// Test rels (no ext)
const testRels = new Set(testFiles.map(f => path.relative(ROOT, f).replace(/\.ts$/, "")));

// 5. For each whole-interp file: compute criteria
for (const w of wholeInterp) {
  const target = w.rel.replace(/\.ts$/, "");
  const reach = transitiveDeps(target);
  reach.delete(target);  // exclude self
  w.directDeps = dependents.get(target) ? dependents.get(target).size : 0;
  w.entryAffected = [...reach].filter(r => entryRels.has(r));
  w.testsBlocked = [...reach].filter(r => testRels.has(r));
  w.transitiveReach = reach.size;
}

// 6. Rank by impact = ownFuncs × (testsBlocked + entryAffected + directDeps + 1)
wholeInterp.sort((a, b) =>
  (b.ownFuncs * (b.testsBlocked.length + b.entryAffected.length + b.directDeps + 1)) -
  (a.ownFuncs * (a.testsBlocked.length + a.entryAffected.length + a.directDeps + 1)));

// 7. Output
console.log(`# zod 整模块 interp 缺口排序（${wholeInterp.length} 个，2026-11-17）`);
console.log(`# corpus: ${srcFiles.length} src + ${testFiles.length} test .ts；impact = ownFuncs × (tests + entries + deps + 1)\n`);
console.log(`> shared-state 已由 host-backed 模块绑定解决（clash const 走 interpJs 单一事实源），33 个 v4 文件已翻回 wasm；剩余 4 个文件为 v3 module-suspend。`);
console.log(`> wasm 6053 → 20845 / 20945（28.9% → 99.5%）；详情见 brain [[aot-shared-state-clash-design]]。\n`);
console.log(`| # | 模块 | 自有函数 | 拦截原因 | 直接依赖 | 影响入口 | 挡测试 | impact |`);
console.log(`|---|------|---------|----------|---------|---------|--------|--------|`);
for (let i = 0; i < wholeInterp.length; i++) {
  const w = wholeInterp[i];
  const reasons = [...w.reasons.entries()].map(([k, v]) => `${k}×${v}`).join(", ");
  const impact = w.ownFuncs * (w.testsBlocked.length + w.entryAffected.length + w.directDeps + 1);
  console.log(`| ${i+1} | ${w.rel} | ${w.ownFuncs} | ${reasons} | ${w.directDeps} | ${w.entryAffected.length} | ${w.testsBlocked.length} | ${impact} |`);
}
console.log(`\n## Top 10 详情`);
for (const w of wholeInterp.slice(0, 10)) {
  console.log(`\n### ${w.rel}`);
  console.log(`  自有函数: ${w.ownFuncs}；拦截: ${[...w.reasons.entries()].map(([k,v])=>k+"×"+v).join(", ")}`);
  console.log(`  影响入口: ${w.entryAffected.length ? w.entryAffected.slice(0,5).join(", ") : "(无)"}`);
  console.log(`  挡测试: ${w.testsBlocked.length} 个（${w.testsBlocked.slice(0,3).map(t=>path.basename(t)).join(", ")}${w.testsBlocked.length>3?"…":""}）`);
  console.log(`  直接依赖: ${w.directDeps}；传递覆盖: ${w.transitiveReach}`);
}
