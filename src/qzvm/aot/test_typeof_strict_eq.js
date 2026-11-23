#!/usr/bin/env node
"use strict";
/* typeof v !== "string" 的两个操作数都是 wasm 内部字符串句柄，严格比较不得跨宿主 qz.sne。 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { compileTS } = require("./emitter.js");
const { makeQzvm } = require("./qzvm.js");

async function main() {
  const src = `
function typeCheck(v: any): number {
  if (typeof v !== "string") return 0;
  return 1;
}
function typeExpr(v: any): number {
  const ok: any = typeof v === "string";
  return ok ? 1 : 0;
}
`;
  const tmp = path.join(os.tmpdir(), "qz_aot_typeof_strict.ts");
  const wasm = path.join(os.tmpdir(), "qz_aot_typeof_strict.wasm");
  fs.writeFileSync(tmp, src);
  const r = compileTS(tmp, wasm, {});
  const qz = makeQzvm(r.strings, { fields: r.fields });
  let sneCalls = 0;
  const originalSne = qz.sne;
  qz.sne = (...args) => { sneCalls++; return originalSne(...args); };
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
  qz.bindMem(instance.exports.memory);
  if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
  qz.bindClosures(instance.exports, r.lamMeta);
  const call = (name, v) => qz._toJS(instance.exports[name](qz._fromJS(v)));
  let before = sneCalls;
  assert.strictEqual(call("typeCheck", "x"), 1);
  assert.strictEqual(call("typeCheck", 7), 0);
  assert.strictEqual(call("typeCheck", {}), 0);
  assert.strictEqual(call("typeCheck", true), 0);
  assert.strictEqual(sneCalls - before, 0, `condition: expected no qz.sne calls, got ${sneCalls - before}`);

  let seqCalls = 0;
  const originalSeq = qz.seq;
  qz.seq = (...args) => { seqCalls++; return originalSeq(...args); };
  before = seqCalls;
  assert.strictEqual(call("typeExpr", "x"), 1);
  assert.strictEqual(call("typeExpr", 7), 0);
  assert.strictEqual(call("typeExpr", {}), 0);
  assert.strictEqual(seqCalls - before, 0, `expression: expected no qz.seq calls, got ${seqCalls - before}`);
  console.log("typeof strict comparison stays in wasm");
}
main().catch(e => { console.error(e); process.exit(1); });
