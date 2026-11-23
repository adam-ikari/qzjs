#!/usr/bin/env node
"use strict";
/* strict 比较产 tagged bool；|| / && 及其 if 条件不应再逐项 qz.truthy 跨界。 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { compileTS } = require("./emitter.js");
const { makeQzvm } = require("./qzvm.js");

async function main() {
  const src = `
function guard(v: any): number {
  if (v === null || typeof v !== "object") return 0;
  return 1;
}
function both(v: any): number {
  if (v !== null && typeof v === "object") return 1;
  return 0;
}
`;
  const tmp = path.join(os.tmpdir(), "qz_aot_bool_shortcircuit.ts");
  const wasm = path.join(os.tmpdir(), "qz_aot_bool_shortcircuit.wasm");
  fs.writeFileSync(tmp, src);
  const r = compileTS(tmp, wasm, {});
  const qz = makeQzvm(r.strings, { fields: r.fields });
  let truthyCalls = 0;
  const originalTruthy = qz.truthy;
  qz.truthy = (...args) => { truthyCalls++; return originalTruthy(...args); };
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
  qz.bindMem(instance.exports.memory);
  if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
  qz.bindClosures(instance.exports, r.lamMeta);
  const call = (name, v) => qz._toJS(instance.exports[name](qz._fromJS(v)));

  let before = truthyCalls;
  assert.strictEqual(call("guard", null), 0);
  assert.strictEqual(call("guard", "x"), 0);
  assert.strictEqual(call("guard", {}), 1);
  assert.strictEqual(truthyCalls - before, 0, `||: expected no qz.truthy calls, got ${truthyCalls - before}`);

  before = truthyCalls;
  assert.strictEqual(call("both", null), 0);
  assert.strictEqual(call("both", "x"), 0);
  assert.strictEqual(call("both", {}), 1);
  assert.strictEqual(truthyCalls - before, 0, `&&: expected no qz.truthy calls, got ${truthyCalls - before}`);
  console.log("boolean short-circuit stays in wasm");
}
main().catch(e => { console.error(e); process.exit(1); });
