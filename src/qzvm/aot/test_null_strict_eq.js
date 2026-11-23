#!/usr/bin/env node
"use strict";
/* null 是固定 tagged 句柄 0x7FF9|1；x === null / !== null 可在 wasm 内直接比位，免 qz.seq。 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { compileTS } = require("./emitter.js");
const { makeQzvm } = require("./qzvm.js");

async function main() {
  const src = `
function isNullCond(v: any): number {
  if (v === null) return 1;
  return 0;
}
function isNullExpr(v: any): number {
  const ok: any = v !== null;
  return ok ? 1 : 0;
}
`;
  const tmp = path.join(os.tmpdir(), "qz_aot_null_strict.ts");
  const wasm = path.join(os.tmpdir(), "qz_aot_null_strict.wasm");
  fs.writeFileSync(tmp, src);
  const r = compileTS(tmp, wasm, {});
  const qz = makeQzvm(r.strings, { fields: r.fields });
  let seqCalls = 0;
  const originalSeq = qz.seq;
  qz.seq = (...args) => { seqCalls++; return originalSeq(...args); };
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
  qz.bindMem(instance.exports.memory);
  if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
  qz.bindClosures(instance.exports, r.lamMeta);
  const call = (name, v) => qz._toJS(instance.exports[name](qz._fromJS(v)));

  let before = seqCalls;
  assert.strictEqual(call("isNullCond", null), 1);
  assert.strictEqual(call("isNullCond", undefined), 0);
  assert.strictEqual(call("isNullCond", 0), 0);
  assert.strictEqual(call("isNullCond", "x"), 0);
  assert.strictEqual(call("isNullCond", {}), 0);
  assert.strictEqual(seqCalls - before, 0, `condition: expected no qz.seq calls, got ${seqCalls - before}`);

  before = seqCalls;
  assert.strictEqual(call("isNullExpr", null), 0);
  assert.strictEqual(call("isNullExpr", undefined), 1);
  assert.strictEqual(call("isNullExpr", {}), 1);
  assert.strictEqual(seqCalls - before, 0, `expression: expected no qz.seq calls, got ${seqCalls - before}`);
  console.log("strict null comparison stays in wasm");
}
main().catch(e => { console.error(e); process.exit(1); });
