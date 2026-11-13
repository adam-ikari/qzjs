// 定向诊断：modInterpBindings 的 clash 检查。构造「wasm 函数 inc() 突变模块级可变 `counter`」+
//「async 闭包 readAsync()（modInterpBinding）读同一变量」。
// 期望：clash 检查捕获 → 整模块退 interp（单域，无双状态）→ 零漂移。若未捕获（partial），则运行期漂移。
//   运行：node src/qzvm/aot/test_interp_shared_clash.js   （0 = 冲突被捕获/无漂移；2 = 漂移复现）
const path = require("path");
const fs = require("fs");
const os = require("os");
const E = require(path.join(__dirname, "emitter.js"));
const { makeQzvm } = require(path.join(__dirname, "qzvm.js"));

const src = `
let counter = 0;
export function inc(): number { counter++; return counter; }
export const readAsync = async (): Promise<number> => counter;
`;
const tsfile = path.join(os.tmpdir(), "qz_aot_shared_clash.ts");
const wasm = path.join(os.tmpdir(), "qz_aot_shared_clash.wasm");
fs.writeFileSync(tsfile, src + "\n");

const r = E.compileTS(tsfile, wasm, {});
const nInterp = r.funcMeta.filter(m => m.mode === "interp").length;
const wholeModule = nInterp === r.funcMeta.length && r.funcMeta.length > 0;
console.log("COMPILE:", r.funcMeta.map(m => m.name + ":" + m.mode).join(","), "modIB=" + JSON.stringify(r.modInterpBindings || []));
console.log("  whole-module interp? " + (wholeModule ? "YES (clash caught -> rollback)" : "NO (partial -> clash MISSED)"));

(async () => {
  const qz = makeQzvm(r.strings, { fields: r.fields });
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
  if (instance.exports.memory) qz.bindMem(instance.exports.memory);
  if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
  qz.bindClosures(instance.exports, r.lamMeta);
  const iNames = [...(r.funcMeta || []).filter(f => f.mode === "interp").map(f => f.name), ...(r.modInterpBindings || [])];
  const imap = iNames.length ? new Function(r.interpJs + "\nreturn { " + iNames.map(n => n + ": typeof " + n + ' === "function" ? ' + n + " : undefined").join(", ") + " };")() : {};
  if (r.interpJs) qz.bindInterp(imap);
  qz.bindClasses(instance.exports, r.classMeta);

  // inc：整模块 interp 时走 interp 副本；partial 时走 wasm 导出。
  const inc = wholeModule ? imap.inc : instance.exports.inc;
  let wasmCounter = 0;
  for (let i = 0; i < 3; i++) { const v = inc(wholeModule ? undefined : qz._fromJS(0)); const n = typeof v === "bigint" ? Number(v) : v; if (Number.isFinite(n)) wasmCounter = n; }
  // readAsync：读 interp 副本。整模块 interp 时 inc 与 readAsync 同一副本 → 必然一致。
  const interpCounter = await imap.readAsync();
  const drift = wasmCounter !== interpCounter && !wholeModule;
  console.log("  inc counter =", Number(wasmCounter), "| readAsync() =", interpCounter);
  if (wholeModule) { console.log("PASS: clash caught -> whole-module interp (no dual state)"); process.exit(0); }
  console.log(drift ? "FAIL: DRIFT REPRODUCED (wasm=" + wasmCounter + " vs interp=" + interpCounter + ")" : "PASS: no drift");
  process.exit(drift ? 2 : 0);
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
