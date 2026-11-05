#!/usr/bin/env node
/* stress_aot.js — AOT 编译/运行长时间压力测试（单核）。
 *
 * 循环：全语料 TS→wasm 编译 + 实例化 + 执行 + 与 oracle 比对，反复若干轮。
 * 目的是暴露只在长时间重复下出现的失败：编译产物不确定、句柄表泄漏、
 * wasm 内存涨不停、进程级崩溃。
 *
 * 单核：用 taskset 绑到 CPU 0（脚本自己 re-exec，CPU 由 $QZ_STRESS_CPU 指定）。
 *
 * 用法：
 *   node src/qzvm/aot/stress_aot.js [--rounds N] [--minutes M] [--rss-limit MB]
 * 默认 rounds=0 minutes=30，任一触发即停。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// ── 单核绑定：在 CPU 0（或 $QZ_STRESS_CPU）上 re-exec 自己 ──
if (!process.env.QZ_STRESS_PINNED) {
  const cpu = process.env.QZ_STRESS_CPU || "0";
  let st = 0;
  try {
    execFileSync("taskset", ["-c", cpu, process.execPath, __filename, ...process.argv.slice(2)], {
      stdio: "inherit", env: { ...process.env, QZ_STRESS_PINNED: "1", QZ_STRESS_CPU: cpu },
    });
  } catch (e) {
    if (typeof e.status !== "number") { console.error(`FAIL: taskset 绑定 CPU ${cpu} 失败: ${e.message}`); process.exit(2); }
    st = e.status;   // 子进程正常退出但带非零码（有 diff / 超 rss）→ 原样透传
  }
  process.exit(st);
}

const E = require("./emitter.js");
const { makeQzvm } = require("./qzvm.js");
const ts = require("./node_modules/typescript");

const argv = process.argv.slice(2);
const getArg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
const MAX_ROUNDS = getArg("--rounds", 0);
const MAX_MINUTES = getArg("--minutes", 30);
const RSS_LIMIT_MB = getArg("--rss-limit", 2048);

// 全部语料（audit_corpus.js + audit_corpus2..N.js）
const corpora = [];
for (let i = 1; ; i++) {
  const p = path.join(__dirname, i === 1 ? "audit_corpus.js" : `audit_corpus${i}.js`);
  if (!fs.existsSync(p)) break;
  corpora.push({ file: path.basename(p), cases: require(p) });
}
const totalCases = corpora.reduce((a, c) => a + c.cases.length, 0);

function jsFn(src, fn) {
  const out = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  const exp = {};
  new Function("exports", out)(exp);
  return exp[fn];
}
const j = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

async function runCase(c, dir, seq) {
  const file = path.join(dir, `c${seq}.ts`), wasm = path.join(dir, `c${seq}.wasm`);
  let got, aotErr = null, exp, jsErr = null;
  try {
    fs.writeFileSync(file, c.ts + "\n");
    const r = E.compileTS(file, wasm, {});
    const qz = makeQzvm(r.strings, { fields: r.fields });
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
    if (instance.exports.memory) qz.bindMem(instance.exports.memory);
    if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
    qz.bindClosures(instance.exports, r.lamMeta);
    qz.bindClasses(instance.exports, r.classMeta);
    const m = (r.funcMeta || []).find(f => f.name === c.fn);
    if (m && m.mode === "interp") {
      // async/generator 等挂起语义走宿主 JS 副本（同 build.js glue 路径）
      const rec = new Function(r.interpJs + `\nreturn typeof ${c.fn} === "function" ? ${c.fn} : undefined;`)();
      if (typeof rec !== "function") throw new Error("interp 函数缺失: " + c.fn);
      const res = rec(...(c.args || []));
      got = res && typeof res.then === "function" ? await res : res;
    } else {
      // wasm 导出为固定元数：补足到形参个数（num 模式无 undefined → 补 NaN，与 JS 少传算术一致）
      const raw = (c.args || []).slice();
      const nPar = m ? m.params : raw.length;
      while (raw.length < nPar) raw.push(m && m.mode === "num" ? NaN : undefined);
      const args = raw.slice(0, nPar).map(x => qz._fromJS(x));
      const res = instance.exports[c.fn](...args);
      if (qz.take_err) qz.take_err();          // 跨函数 throw 的宿主出口（glue 约定）
      got = m && m.mode === "num" ? res : qz._toJS(res);
    }
    fs.unlinkSync(wasm);
  } catch (e) { aotErr = "AOT:" + String(e && e.message || e).split("\n")[0].slice(0, 70); }
  try {                                        /* oracle 无条件跑：两侧同抛视为一致（判据同 audit_diff）*/
    let res = jsFn(c.ts, c.fn)(...(c.args || []));
    if (res && typeof res.then === "function") res = await res;   // async oracle 与 AOT 同 await
    exp = res && typeof res === "object" ? JSON.parse(JSON.stringify(res)) : res;
  } catch (e) { jsErr = "JS:" + String(e && e.message || e).split("\n")[0].slice(0, 40); }
  const j = (v) => (typeof v === "number" ? (Number.isNaN(v) ? "NaN" : !isFinite(v) ? (v > 0 ? "Infinity" : "-Infinity") : (Object.is(v, -0) ? "-0" : String(v))) : JSON.stringify(v));
  /* 已知缺口（corpus 条目 `unsupported`）：AOT 必须显式报错才算通过；静默错值仍算失败。 */
  if (c.unsupported) return aotErr ? null : { name: c.name || c.fn, got: j(got), exp: "unsupported: " + c.unsupported };
  const same = (aotErr || jsErr)
    ? (!!aotErr === !!jsErr)
    : (typeof got === "number" && typeof exp === "number")
      ? Object.is(got, exp) || (Number.isNaN(got) && Number.isNaN(exp))
      : j(got) === j(exp);
  return same ? null : { name: c.name || c.fn, got: aotErr || j(got), exp: jsErr || j(exp) };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qz-stress-"));
  const t0 = Date.now();
  const deadline = t0 + MAX_MINUTES * 60000;
  let round = 0, checked = 0, bad = 0;
  const failures = [];
  let peakRss = 0;
  console.log(`stress_aot: ${corpora.length} 批 / ${totalCases} 例，单核 CPU ${process.env.QZ_STRESS_CPU}` +
    `，上限 ${MAX_ROUNDS ? MAX_ROUNDS + " 轮" : ""}${MAX_ROUNDS && MAX_MINUTES ? " / " : ""}${MAX_MINUTES} 分钟`);

  while (true) {
    if (MAX_ROUNDS && round >= MAX_ROUNDS) break;
    if (Date.now() > deadline) break;
    round++;
    let roundBad = 0;
    for (const { cases } of corpora) {
      for (let i = 0; i < cases.length; i++) {
        const r = await runCase(cases[i], dir, i);
        checked++;
        if (r) { bad++; roundBad++; if (failures.length < 30) failures.push({ round, ...r }); }
      }
    }
    const rss = process.memoryUsage().rss / 1048576;
    peakRss = Math.max(peakRss, rss);
    const el = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`round ${round}: ${checked} 例累计，diff ${bad}，本轮 ${roundBad}，rss ${rss.toFixed(0)}MiB，${el}s`);
    if (rss > RSS_LIMIT_MB) { console.error(`FAIL: rss ${rss.toFixed(0)}MiB > ${RSS_LIMIT_MB}MiB（疑似泄漏）`); bad++; break; }
  }

  for (const f of failures) console.error(`DIFF r${f.round} ${f.name} wasm=${f.got} js=${f.exp}`);
  const el = ((Date.now() - t0) / 1000).toFixed(1);
  if (bad) { console.error(`FAIL: ${bad} 例不一致 / ${checked} 例，${round} 轮，${el}s，峰值 rss ${peakRss.toFixed(0)}MiB`); process.exit(1); }
  console.log(`PASS: ${checked} 例（${round} 轮）全部一致，${el}s，峰值 rss ${peakRss.toFixed(0)}MiB`);
})();
