#!/usr/bin/env node
/* qzvm.js — qz.* 运行时（qzjs 侧 JS 实现）。
 * tagged i32 值模型：bit0=0 数值(v>>1) | bit0=1 handle(v>>1，handles 表索引)。
 * emitter 的 tagged 模式产物通过 WebAssembly.instantiate 的 { qz: qzvm(strings) } import 调用本运行时。
 *
 * 用法: const qz = require('./qzvm.js').makeQzvm(["k0","k1",...]);
 *        new WebAssembly.Instance(module, { qz });   // strings 由 emitter 输出
 */
"use strict";

function makeQzvm(strings) {
  const handles = [undefined];            // index 0 保留（tagged handle 0 无效）
  const isH = (v) => (v & 1) === 1;
  const toJS = (v) => (isH(v) ? handles[v >>> 1] : (v >>> 1));
  const tagHandle = (x) => (handles.push(x) - 1) * 2 + 1;
  const fromJS = (x) => (typeof x === "number" ? (x << 1) : tagHandle(x));
  const bool = (b) => (b ? 1 : 0) << 1;   // 布尔 → tagged number
  const num = (a, b) => toJS(a) >>> 0;
  const bin = (f) => (a, b) => fromJS(f(toJS(a), toJS(b)));

  let bump = 0, mem = null;         // wasm 线性内存 bump 分配器（对象字段区，mem = 实例 memory）
  const bindMem = (m) => { mem = m; };
  return {
    // POJO 分配：只返回 wasm 内存偏移（裸 i32），字段由 wasm i32.store 写入（零跨界）
    alloc: (nbytes) => { const off = bump; bump += nbytes; return off; },
    bindMem,
    object_new: () => tagHandle({}),
    object_set: (o, k, v) => { handles[o >>> 1][strings[k]] = toJS(v); },
    object_get: (o, k) => fromJS(handles[o >>> 1][strings[k]]),
    string_new: (id) => tagHandle(strings[id]),
    string_concat: (a, b) => tagHandle(String(toJS(a)) + String(toJS(b))),
    add:  (a, b) => fromJS(toJS(a) + toJS(b)),
    sub:  (a, b) => fromJS(toJS(a) - toJS(b)),
    mul:  (a, b) => fromJS(toJS(a) * toJS(b)),
    div:  (a, b) => fromJS(Math.floor(toJS(a) / toJS(b))),
    rem:  (a, b) => fromJS(toJS(a) % toJS(b)),
    lt:   (a, b) => bool(toJS(a) < toJS(b)),
    gt:   (a, b) => bool(toJS(a) > toJS(b)),
    le:   (a, b) => bool(toJS(a) <= toJS(b)),
    ge:   (a, b) => bool(toJS(a) >= toJS(b)),
    seq:  (a, b) => bool(toJS(a) === toJS(b)),
    sne:  (a, b) => bool(toJS(a) !== toJS(b)),
    truthy: (v) => bool(!!toJS(v)),
    log:  (v) => console.log("  [qz]", typeof toJS(v) === "string" ? toJS(v) : String(toJS(v))),
    // 供宿主检查用（不在 wasm import 面）
    _toJS: toJS, _fromJS: fromJS, _handles: handles,
  };
}

module.exports = { makeQzvm };

if (require.main === module) {
  // 自检：tagged 编解码往返
  const qz = makeQzvm(["a", "b"]);
  const n = qz._fromJS(42);            // 42<<1 = 84
  const o = qz.object_new();
  qz.object_set(o, 0, n);
  const back = qz.object_get(o, 0);
  console.log("tagged num:", n, "→", qz._toJS(n), "(want 42)");
  console.log("object roundtrip:", qz._toJS(back), "(want 42)");
  console.log("add 40+2 =", qz._toJS(qz.add(qz._fromJS(40), qz._fromJS(2))), "(want 42)");
}