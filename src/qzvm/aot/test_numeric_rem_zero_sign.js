#!/usr/bin/env node
"use strict";
/* 有限 number 的 %（含零余数）应留在 wasm，且零余数符号随被除数（-4%2 === -0）。 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { compileTS } = require("./emitter.js");
const { makeQzvm } = require("./qzvm.js");

async function main() {
  const src = `
function rem(a: any, b: any): any { return a % b; }
`;
  const tmp = path.join(os.tmpdir(), "qz_aot_rem_zero_sign.ts");
  const wasm = path.join(os.tmpdir(), "qz_aot_rem_zero_sign.wasm");
  fs.writeFileSync(tmp, src);
  const r = compileTS(tmp, wasm, {});
  const qz = makeQzvm(r.strings, { fields: r.fields });
  let remCalls = 0;
  const original = qz.rem;
  qz.rem = (...args) => { remCalls++; return original(...args); };
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
  qz.bindMem(instance.exports.memory);
  if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
  qz.bindClosures(instance.exports, r.lamMeta);
  const call = (a, b) => qz._toJS(instance.exports.rem(qz._fromJS(a), qz._fromJS(b)));

  assert.strictEqual(call(7, 3), 1);
  assert.strictEqual(call(-7, 3), -1);
  assert.strictEqual(call(7, -3), 1);
  assert.strictEqual(call(-7, -3), -1);
  assert.ok(Object.is(call(-4, 2), -0), "-4 % 2 must be -0");
  assert.ok(Object.is(call(4, -2), 0), "4 % -2 must be +0");
  assert.ok(Object.is(call(-4, -2), -0), "-4 % -2 must be -0");
  assert.ok(Object.is(call(-0, 2), -0), "-0 % 2 must be -0");
  assert.strictEqual(remCalls, 0, `expected no qz.rem calls, got ${remCalls}`);

  assert.ok(Number.isNaN(call(NaN, 2)));
  assert.ok(Number.isNaN(call(Infinity, 2)));
  assert.strictEqual(call(2, Infinity), 2);
  assert.ok(remCalls > 0, "non-finite operands must use host fallback");
  console.log("finite numeric remainder stays in wasm with signed zero");
}
main().catch(e => { console.error(e); process.exit(1); });
