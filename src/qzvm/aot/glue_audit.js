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
const { execFileSync, spawnSync } = require("child_process");

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
  const g = exp[fn];   // 裸调用（对齐 audit_diff）：exp[fn]() 会把 exports 泄进顶层函数的 this（strict 下应为 undefined）
  const out = g(...(args || []));
  if (out === undefined) return "undefined";   // JSON.stringify(undefined) === undefined，与 CLI 打印的 "undefined" 不同型
  return typeof out === "string" ? out : JSON.stringify(out);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qz-glue-"));

// 把 JS 参数值写成可嵌入 glue 源码的字面量（build.js 的 --main 只解析数字实参，
// 这里直接改写生成后的 __call 实参数组，保持与 V8 参考值的同一份参数）。
function lit(v) {
  if (v === undefined) return "void 0";
  if (v === null) return "null";
  if (typeof v === "number") return Number.isNaN(v) ? "NaN" : !isFinite(v) ? (v > 0 ? "Infinity" : "-Infinity") : String(v);
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "function") return `(${v.toString()})`;   // 实参里带回调（opt-call 系列）：嵌入函数源文本
  if (Array.isArray(v)) return "[" + v.map(lit).join(",") + "]";
  if (typeof v === "object") return "{" + Object.keys(v).map(k => `${JSON.stringify(k)}:${lit(v[k])}`).join(",") + "}";
  return "void 0";
}


let pass = 0, fail = 0, envPass = 0;
const rows = [];

for (const c of corpus) {
  const srcPath = path.join(dir, "case.ts");
  const base = "qzglue_" + c.name.replace(/[^\w-]/g, "_");   // build.js 把 name 拼进 outDir()
  const prefix = path.join(OUT_DIR, base);
  fs.writeFileSync(srcPath, c.ts + "\n");

  // kind: "value"（取到结果行）/ "throw"（运行期抛出）/ "error"（构建或装配失败）
  let kind = "value", got = null, err = null;
  try {
    execFileSync(process.execPath, [BUILD, "build", srcPath, base, "--main", `${c.fn}()`], {
      stdio: "pipe", env: { ...process.env, WAMRC },
    });
    // 注入实参：把 --main 生成的 `__call("<fn>", [])` 换成带参数的调用。
    const gluePath = path.join(OUT_DIR, base + ".glue.js");
    const callSrc = `__call(${JSON.stringify(c.fn)}, [])`;
    if (c.args && c.args.length) {
      const glue = fs.readFileSync(gluePath, "utf8");
      const patched = glue.replace(callSrc, `__call(${JSON.stringify(c.fn)}, [${c.args.map(lit).join(",")}])`);
      if (patched === glue) throw new Error("glue 里找不到 " + callSrc);
      fs.writeFileSync(gluePath, patched);
    }
    const r = spawnSync(QZJS, [base + ".glue.js"], { cwd: OUT_DIR, encoding: "utf8", timeout: 60000 });
    // build.js 的 --main 直接产出 `<fn>() = <值>` 行；取出右侧原文（不重新 JSON 解析，
    // 保持与 V8 参考值同形态的字符串比较）。值里可能含换行（JSON 字符串/模板串），
    // 所以取标记之后到输出末尾，不能只匹配「本行」。
    const marker = `${c.fn}() = `;
    const at = (r.stdout || "").indexOf(marker);
    if (at >= 0) { got = (r.stdout || "").slice(at + marker.length).replace(/\n$/, ""); }
    else {
      // 运行期异常被 glue 尾部 .catch 打成 "AOT load failed: <msg>"（退出码仍为 0）；
      // 与 V8 参考侧同为抛错时按 audit_diff 的判据算一致。
      const em = /AOT load failed: (.*)$/m.exec(r.stderr || "");
      if (em) { kind = "throw"; err = em[1].trim(); }
      else { kind = "error"; err = ("no <fn>() line: " + (r.stderr || "")).trim().slice(0, 120) || "no <fn>() line"; }
    }
  } catch (e) {
    kind = "error";
    err = String((e.stderr || e.message || e)).split("\n").filter(Boolean).slice(-1)[0] || "error";
  }

  let wantKind = "value", want = null;
  try { want = jsRun(c.ts, c.fn, c.args); } catch (e) { wantKind = "throw"; want = String(e.message).slice(0, 60); }

  // 已知缺口（unsupported）：build/运行必须 loud；否则值须相等，或两侧都抛错（同 audit_diff 判据）。
  // unsupported：必须 loud（构建失败或运行期抛错）。
  // 其余：值相等即通过；JS 侧抛错时要求产物也 loud（同 audit_diff：两侧都报错算一致，
  // 静默错值/静默 undefined 算失败）。
  // envdiff：登记过的**宿主引擎差异**（oracle=V8/node vs 生产档=qzjs/quickjs-ng：Math 精度、
  // Intl 缺失、比较器矛盾下的 sort 实现细节、栈深度）。两侧都出值（不等）或产物按容量/精度差异
  // 抛出而 oracle 出值 → 记 ENV 通过；构建/装配失败（error）仍算 FAIL（防装配回归被登记掩盖）。
  const envOk = !c.unsupported && !!c.envdiff && wantKind === "value" &&
    ((kind === "value" && got !== want) || kind === "throw");
  const ok = c.unsupported
    ? kind !== "value"
    : envOk || (wantKind === "throw" ? kind !== "value" : (kind === "value" && got === want));
  if (ok) pass++; else fail++;
  if (envOk) envPass++;
  rows.push({
    name: c.name, ok, env: envOk,
    got: kind === "value" ? got : kind.toUpperCase() + ":" + String(err).slice(0, 80),
    want: c.unsupported ? "unsupported: " + c.unsupported : (wantKind === "throw" ? "THROW:" + want : want),
  });
}

const w = Math.max(...rows.map(r => r.name.length), 4);
for (const r of rows) {
  console.log(`${r.ok ? (r.env ? "ENV  " : "PASS") : "FAIL"}  ${r.name.padEnd(w)}  got=${r.got}`);
  if (!r.ok) console.log(`      ${"".padEnd(w)}  want=${r.want}`);
}
console.log(`\n${pass}/${pass + fail}${envPass ? `（含 ${envPass} 条已登记宿主引擎差异 envdiff）` : ""} ${fail === 0 ? "全部一致（glue 装配路径）" : "有差异"}　corpus=${path.basename(corpusPath)}`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
