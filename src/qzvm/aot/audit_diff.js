// 差分审计（oracle = 真 JS）：同一 TS 源 → (a) tsc 剥类型后 new Function 跑 JS；(b) AOT 编译 wasm 跑，
// 逐例比对。每例**独立编译**（坏构造只影响自身，不掩盖其余）。
// 用法: node src/qzvm/aot/audit_diff.js [corpus文件]（默认 audit_corpus.js）。
// 判据：静默错值 > loud 报错——两侧都抛错视为「一致」（同为未实现/报错）。
const E = require("/home/gem/project/qzjs/src/qzvm/aot/emitter.js");
const { makeQzvm } = require("/home/gem/project/qzjs/src/qzvm/aot/qzvm.js");
const ts = require("/home/gem/project/qzjs/src/qzvm/aot/node_modules/typescript");
const fs = require("fs");
const path = require("path");
const os = require("os");

const corpus = require(process.argv[2] ? require("path").resolve(process.argv[2]) : require("path").join(__dirname, "audit_corpus.js"));

function jsFn(src, fn) {
  const out = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  const exp = {};
  new Function("exports", out.replace(/^\s*(exports\.\w+ = void 0;)/gm, "$1"))(exp);
  return exp[fn];
}

(async () => {
  const rows = [];
  for (const c of corpus) {
    const file = path.join(os.tmpdir(), "qz_aot_case.ts"), wasm = path.join(os.tmpdir(), "qz_aot_case.wasm");
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
      const args = (c.args || []).map(x => qz._fromJS(x));
      const res = instance.exports[c.fn](...args);
      got = m && m.mode === "num" ? res : qz._toJS(res);
    } catch (e) { aotErr = "AOT:" + String(e.message).split("\n")[0].slice(0, 70); }
    try {
      const fn = jsFn(c.ts, c.fn);
      const res = fn(...(c.args || []));
      exp = res && typeof res === "object" ? JSON.parse(JSON.stringify(res)) : res;
    } catch (e) { jsErr = "JS:" + String(e.message).split("\n")[0].slice(0, 40); }
    const j = (v) => (typeof v === "number" ? (Number.isNaN(v) ? "NaN" : !isFinite(v) ? (v > 0 ? "Infinity" : "-Infinity") : (Object.is(v, -0) ? "-0" : String(v))) : JSON.stringify(v));
    const same = (aotErr || jsErr)
      ? (!!aotErr === !!jsErr)
      : (typeof got === "number" && typeof exp === "number")
        ? Object.is(got, exp) || (Number.isNaN(got) && Number.isNaN(exp))
        : j(got) === j(exp);
    rows.push({ name: c.name || c.fn, ok: same, got: aotErr || j(got), exp: jsErr || j(exp) });
  }
  const bad = rows.filter(r => !r.ok);
  for (const r of bad) console.log(`DIFF ${r.name.padEnd(28)} wasm=${r.got}  js=${r.exp}`);
  console.log(`\n${rows.length - bad.length}/${rows.length} match, ${bad.length} diff`);
})();
