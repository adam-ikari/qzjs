#!/usr/bin/env node
"use strict";
/* 字符串 .indexOf(ASCII 字面量) 必须留在 wasm：不得为每次查找跨界 qz.method_call。 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { compileTS } = require("./emitter.js");
const { makeQzvm } = require("./qzvm.js");

async function main() {
  const src = `
function idx(v: any): number { return v.indexOf("@"); }
function idxEmpty(v: any): number { return v.indexOf(""); }
function idxNum(v: any): number { return v.indexOf("@"); }
`;
  const tmp = path.join(os.tmpdir(), "qz_aot_indexof_inline.ts");
  const wasm = path.join(os.tmpdir(), "qz_aot_indexof_inline.wasm");
  fs.writeFileSync(tmp, src);
  const r = compileTS(tmp, wasm, {});
  const qz = makeQzvm(r.strings, { fields: r.fields });
  let methodCalls = 0;
  const original = qz.method_call;
  qz.method_call = (...args) => { methodCalls++; return original(...args); };
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
  qz.bindMem(instance.exports.memory);
  if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
  qz.bindClosures(instance.exports, r.lamMeta);
  const call = (name, v) => qz._toJS(instance.exports[name](qz._fromJS(v)));

  assert.strictEqual(call("idx", "a@b"), 1);
  assert.strictEqual(call("idx", "no@"), 2);
  assert.strictEqual(call("idx", "plain"), -1);
  assert.strictEqual(call("idx", ""), -1);
  assert.strictEqual(call("idx", "你好@x"), 2);       // UTF-16 码元索引，不是 UTF-8 字节偏移
  assert.strictEqual(call("idx", "😀@x"), 2);         // 代理对算 2 个码元
  assert.strictEqual(call("idxEmpty", "abc"), 0);     // 空 needle 恒 0
  assert.strictEqual(methodCalls, 0, `expected no qz.method_call, got ${methodCalls}`);
  assert.throws(() => call("idxNum", 123), /数值无方法 indexOf/);  // 非字符串不得静默返回 -1
  console.log("string indexOf(ASCII literal) stays in wasm");
}
main().catch(e => { console.error(e); process.exit(1); });
