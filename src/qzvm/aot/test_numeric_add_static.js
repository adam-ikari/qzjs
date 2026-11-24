#!/usr/bin/env node
"use strict";
/* 静态 number 的 + 应直接发 f64 加法；any 字符串拼接仍必须走宿主。 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { compileTS } = require("./emitter.js");
const { makeQzvm } = require("./qzvm.js");

async function main() {
  const src = `
function add(a: number, b: number): number { const t: any = typeof a; let x = 0; x = a + b; return x + b; }
function addAny(a: any, b: any): any { return a + b; }
`;
  const tmp = path.join(os.tmpdir(), "qz_aot_numeric_add_static.ts");
  const wasm = path.join(os.tmpdir(), "qz_aot_numeric_add_static.wasm");
  fs.writeFileSync(tmp, src);
  const r = compileTS(tmp, wasm, {});
  const qz = makeQzvm(r.strings, { fields: r.fields });
  let addCalls = 0, concatCalls = 0, dupCalls = 0;
  const origAdd = qz.add, origConcat = qz.string_concat, origDup = qz.str_dup;
  qz.add = (...a) => { addCalls++; return origAdd(...a); };
  qz.string_concat = (...a) => { concatCalls++; return origConcat(...a); };
  qz.str_dup = (...a) => { dupCalls++; return origDup(...a); };
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
  qz.bindMem(instance.exports.memory);
  if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
  qz.bindClosures(instance.exports, r.lamMeta);
  const unbox = (b) => { const d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, BigInt.asIntN(64, b), true); return d.getFloat64(0, true); };
  const num = (x) => unbox(instance.exports.add(qz._fromJS(x), qz._fromJS(0)));
  const anyAdd = (a, b) => qz._toJS(instance.exports.addAny(qz._fromJS(a), qz._fromJS(b)));

  assert.strictEqual(num(0.5), 0.5, "fraction must stay exact");
  assert.strictEqual(num(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.ok(Object.is(num(-0), 0), "-0 + 0 must be +0 per JS");
  assert.ok(Number.isNaN(num(NaN)));
  assert.strictEqual(num(Infinity), Infinity);
  assert.strictEqual(addCalls, 0, `typed number + must not call qz.add, got ${addCalls}`);
  assert.strictEqual(concatCalls, 0, `typed number + must not call qz.string_concat, got ${concatCalls}`);
  assert.strictEqual(dupCalls, 0, `typed number + must not call qz.str_dup, got ${dupCalls}`);

  assert.strictEqual(anyAdd("a", "b"), "ab", "any + must still concatenate");
  console.log("typed numeric add stays in wasm; any concat preserved");
}
main().catch(e => { console.error(e); process.exit(1); });
