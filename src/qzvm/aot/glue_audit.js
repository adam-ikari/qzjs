#!/usr/bin/env node
/* glue_audit.js — 验证 **glue 装配路径** 而非 compileTS 直调路径。
 *
 * 为什么需要单独一个：`audit_diff.js` 直接 `makeQzvm(r.strings, { fields: r.fields })`，
 * 手动把字段表喂进去。真实产物走的是 `build.js build` → 写 .meta.json → 读回 →
 * 塞进 glue 里的 makeQzvm 调用。两段装配是分开的代码，前者正确不代表后者正确。
 *
 * 实证：build.js 曾漏传 fields，导致 glue 里 fieldEntries 恒空 →
 * 宿主容器（Map/Set）持有的对象字面量全部退化成 undefined，静默无异常；
 * 889 例 audit_diff 全绿仍漏检，因为测试路径自己把 fields 补上了。
 *
 * 本脚本对每个用例：build.js build 出 glue → 加 __main → qzjs 跑 → 与 V8 对比。
 *
 * 用法: node src/qzvm/aot/glue_audit.js [corpus文件]
 * 需要环境变量 WAMRC（wamrc 路径）或默认 deps 下构建产物。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const QZJS = process.env.QZJS || path.join(ROOT, "build", "qzjs");
const WAMRC = process.env.WAMRC || path.join(ROOT, "deps", "wamr", "wamr-compiler", "build", "wamrc");
const BUILD = path.join(__dirname, "build.js");

const corpusPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "audit_corpus41.js");
const corpus = require(corpusPath);

const OUT_DIR = process.env.AOT_OUT_DIR || path.join(ROOT, "build", "aot");
const ts = require(path.join(__dirname, "node_modules", "typescript"));

// 参考实现：同一份 TS 交给 V8（去类型后跑）
function jsRun(src, fn, args) {
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exp = {};
  new Function("exports", js)(exp);
  const out = exp[fn](...(args || []));
  if (out === undefined) return "undefined";   // JSON.stringify(undefined) === undefined，与 CLI 打印的 "undefined" 不同型
  return typeof out === "string" ? out : JSON.stringify(out);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qz-glue-"));


let pass = 0, fail = 0;
const rows = [];

for (const c of corpus) {
  const srcPath = path.join(dir, "case.ts");
  const base = "qzglue_" + c.name.replace(/[^\w-]/g, "_");   // build.js 把 name 拼进 outDir()
  const prefix = path.join(OUT_DIR, base);
  fs.writeFileSync(srcPath, c.ts + "\n");

  let got = null, err = null;
  try {
    execFileSync(process.execPath, [BUILD, "build", srcPath, base, "--main", `${c.fn}()`], {
      stdio: "pipe", env: { ...process.env, WAMRC },
    });
    const out = execFileSync(QZJS, [base + ".glue.js"], { cwd: OUT_DIR, stdio: "pipe", encoding: "utf8", timeout: 60000 });
    // build.js 的 --main 直接产出 `<fn>() = <值>` 行；取出右侧原文（不重新 JSON 解析，
    // 保持与 V8 参考值同形态的字符串比较）
    const m = new RegExp("^" + c.fn.replace(/\$/g, "\\$") + "\\(\\) = (.*)$", "m").exec(out);
    got = m ? m[1] : null;
    if (got === null) err = "no <fn>() line";
  } catch (e) {
    err = String((e.stderr || e.message || e)).split("\n").filter(Boolean).slice(-1)[0] || "error";
  }

  let want = null;
  try { want = jsRun(c.ts, c.fn, c.args); } catch (e) { want = "JS:" + String(e.message).slice(0, 60); }

  const ok = c.unsupported ? !!err : (err === null && got === want);   // 已知缺口：build/运行必须 loud（同 audit_diff 判据）
  if (ok) pass++; else fail++;
  rows.push({ name: c.name, ok, got: err ? "ERR:" + err.slice(0, 60) : got, want: c.unsupported ? "unsupported: " + c.unsupported : want });
}

const w = Math.max(...rows.map(r => r.name.length), 4);
for (const r of rows) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(w)}  got=${r.got}`);
  if (!r.ok) console.log(`      ${"".padEnd(w)}  want=${r.want}`);
}
console.log(`\n${pass}/${pass + fail} ${fail === 0 ? "全部一致（glue 装配路径）" : "有差异"}　corpus=${path.basename(corpusPath)}`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
