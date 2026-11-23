// 回归：single-source 模块绑定。clash 的 const 绑定走 host-backed（interpJs 副本唯一），
// 交叉验证：wasm 侧读到的对象与 interp 侧 ===、Map 键命中，且初值只求值一次。
//   运行：node src/qzvm/aot/test_ss_module_bindings.js
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const E = require(path.join(__dirname, "emitter.js"));
const { makeQzvm } = require(path.join(__dirname, "qzvm.js"));

const src = `
const cfg = ((): { n: number } => {
  globalThis.__qzSSCount = (globalThis.__qzSSCount || 0) + 1;
  return { n: 1 };
})();
cfg.n = cfg.n + 1;   // 只触碰 host-backed 绑定：interp 侧单独执行，wasm 模块初始化不得重放
export function wasmCfg(): any { return cfg; }
export async function same(x: any): Promise<boolean> { return x === cfg; }
export async function mapHit(x: any): Promise<number | undefined> {
  const m: Map<any, number> = new Map(); m.set(cfg, 7); return m.get(x);
}
`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qz-ss-test-"));
const tsfile = path.join(dir, "ss.ts"), wasm = path.join(dir, "ss.wasm");
fs.writeFileSync(tsfile, src + "\n");

globalThis.__qzSSCount = 0;
const r = E.compileTS(tsfile, wasm, {});
const modes = Object.fromEntries(r.funcMeta.map(m => [m.name, m.mode]));
assert.strictEqual(globalThis.__qzSSCount, 0, "compileTS must not evaluate module initializers");
assert.strictEqual(modes.wasmCfg, "tagged", "wasm caller must stay in wasm");
assert.strictEqual(modes.same, "interp", "interp caller must stay in interp");
assert.ok(r.modInterpBindings.includes("cfg"), "cfg must become host-backed");
console.log("COMPILE:", r.funcMeta.map(m => m.name + ":" + m.mode).join(","), "hostBacked=" + JSON.stringify(r.modInterpBindings));

(async () => {
  const qz = makeQzvm(r.strings, { fields: r.fields });
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
  if (instance.exports.memory) qz.bindMem(instance.exports.memory);
  if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
  qz.bindClosures(instance.exports, r.lamMeta);
  const iNames = [...new Set([...r.funcMeta.filter(m => m.mode === "interp").map(m => m.name), ...r.modInterpBindings])];
  const imap = new Function(r.interpJs + "\nreturn { " + iNames.join(", ") + " };")();
  qz.bindInterp(imap);
  qz.bindClasses(instance.exports, r.classMeta);

  assert.strictEqual(globalThis.__qzSSCount, 1, "module initializer must execute once (interp only)");
  assert.strictEqual(imap.cfg.n, 2, "top-level mutation must execute once (interp only)");
  const fromWasm = qz._toJS(instance.exports.wasmCfg());
  assert.strictEqual(fromWasm.n, 2, "wasm read must see the single-source object");
  assert.strictEqual(await imap.same(imap.cfg), true, "same-domain identity");
  assert.strictEqual(await imap.same(fromWasm), true, "cross-domain identity must be unified");
  assert.strictEqual(await imap.mapHit(fromWasm), 7, "cross-domain Map key must hit");
  console.log("PASS: host-backed const — single init + unified identity/Map key");
  fs.rmSync(dir, { recursive: true, force: true });
})().catch(e => { console.error("FAIL", e && e.stack || e); process.exit(1); });
