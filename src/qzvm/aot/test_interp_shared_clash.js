// 定向诊断：modInterpBindings 绕过 shared-state clash 检查 → wasm 副本与 interp 副本的模块级
// 可变变量漂移。构造「wasm 函数 inc() 突变模块级 `counter`」+「async 闭包 readAsync()（modInterpBinding）
// 读同一变量」。若 clash 检查覆盖 modInterpBindings，则整模块应退 interp（两边同一份 counter，零漂移）。
//
// 当前实测（2026-11-13, interp-fn-value 通道）：编译期 partial（inc wasm / readAsync modInterpBinding），
// clash 被绕过 → 运行期漂移复现（wasm counter=3 vs interp readAsync()=0）。
// 本脚本为已知缺口的回归锚点：修复后应打印 "no drift" 并以 0 退出；当前打印 "CONFLICT REPRODUCED" 以 2 退出。
//   运行：node src/qzvm/aot/test_interp_shared_clash.js
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
console.log("COMPILE:", r.funcMeta.map(m => m.name + ":" + m.mode).join(","), "modInterpBindings=" + JSON.stringify(r.modInterpBindings || []));
console.log("  whole-module interp? " + (wholeModule ? "YES (clash caught)" : "NO (partial -> clash BYPASSED)"));

(async () => {
  const qz = makeQzvm(r.strings, { fields: r.fields });
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
  if (instance.exports.memory) qz.bindMem(instance.exports.memory);
  if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
  qz.bindClosures(instance.exports, r.lamMeta);
  if (r.interpJs) {
    const iNames = [...(r.funcMeta || []).filter(f => f.mode === "interp").map(f => f.name), ...(r.modInterpBindings || [])];
    if (iNames.length) {
      const imap = new Function(r.interpJs + "\nreturn { " + iNames.map(n => n + ": typeof " + n + ' === "function" ? ' + n + " : undefined").join(", ") + " };")();
      qz.bindInterp(imap);
    }
  }
  qz.bindClasses(instance.exports, r.classMeta);

  const inc = instance.exports.inc;
  let wasmCounter = 0;
  for (let i = 0; i < 3; i++) { const v = inc(); wasmCounter = typeof v === "bigint" ? Number(v) : v; }
  const interpMap = new Function(r.interpJs + "\nreturn { readAsync: typeof readAsync==='function'?readAsync:undefined };")();
  const interpCounter = await interpMap.readAsync();
  const drift = wasmCounter !== interpCounter;
  console.log("  wasm counter after 3x inc() =", wasmCounter, "| interp readAsync() =", interpCounter);
  console.log(drift ? "CONFLICT REPRODUCED (wasm=" + wasmCounter + " vs interp=" + interpCounter + ")" : "no drift (both=" + wasmCounter + ")");
  process.exit(drift ? 2 : 0);
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
