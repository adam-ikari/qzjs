// 差分审计语料（第二十四批）：Math 特殊值 / 数组方法链 / 泛化数组方法 / 位运算边界 / typeof 矩阵 / 混合解构进阶。
module.exports = [
  { name: "math-extrema", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Math.min(), Math.max(), Math.min(1), Math.max(1));
  out.push(Math.min(3, 1, 2), Math.max(3, 1, 2));
  out.push(Math.max(3, "5"), Math.min("5", 3), Math.max(true, false));
  out.push(Math.min(Infinity, 5), Math.max(-Infinity, 5), Math.min(NaN, 5) !== Math.min(NaN, 5) ? 1 : 0);
  out.push(Math.max(0, -0) === 0 ? 1 : 0, 1 / Math.min(0, -0));
  return out.join("|");
}` },
  { name: "array-method-strings-chain", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const xs: any = [" b", "a", " C"];
  out.push(xs.map((x: any) => x.trim()).filter((x: any) => x !== "").sort().join("|"));
  out.push("hello world foo".split(" ").map((w: any) => w[0] + w.slice(1)).join("-"));
  out.push([1, 2, 3, 4].reverse().join(","), [3, 1, 2].sort().join(""));
  out.push([1, 2, 3].join(""), Array(3).fill("x").join(""));
  out.push("ab cd ef".split(" ").reduce((a: any, b: any) => b + a, ""), [1, [2, [3]]].toString());
  return out.join("|");
}` },
  { name: "generic-array-methods", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const obj: any = { 0: "a", 1: "b", length: 2 };
  out.push(Array.prototype.join.call(obj, "-"), Array.prototype.map.call(obj, (x: any) => x + "!").join(","));
  out.push(Array.prototype.push.call(obj, "c"), obj.length, obj[2]);
  out.push(Array.prototype.slice.call(obj, 1).join(""));
  const s: any = { length: 2, 0: "x", 1: "y" };
  out.push(Array.from(s).join(""), [...s].join(""));
  out.push(Array.prototype.findIndex.call("abc", (c: any) => c === "b"));
  return out.join("|");
}` },
  { name: "bitwise-boundaries", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(~~3.7, ~~-3.7, ~~NaN, ~~Infinity, ~~0.5, ~~-0.5);
  out.push(7 | 0, -7 | 0, 0xFFFFFFFF | 0, -0x80000000 | 0);
  out.push(4294967295 >>> 0, -1 >>> 0, 2147483647 >>> 0);
  out.push((3.9 << 0), (1 << 29), (1 << 30), (1 << 31) | 0);
  out.push(123 & 456, 123 | 456, 123 ^ 456, ~0);
  out.push(2147483647 + 1 | 0, 0.5 * 4 | 0);
  return out.join("|");
}` },
  { name: "typeof-matrix", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(typeof 1, typeof "s", typeof true, typeof undefined, typeof null);
  out.push(typeof {}, typeof [], typeof (() => 1), typeof class {}, typeof NaN);
  out.push(typeof (1 / 0), typeof (Symbol ? Symbol("x") : "no"), typeof (function () {})());
  const v1: any = null; const v2: any = undefined;
  out.push(typeof v1, typeof v2, typeof String, typeof Number);
  return out.join("|");
}` },
  { name: "destructure-advanced-mix", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const data: any = { a: 1, arr: [10, 20, 30], nested: { x: { y: [1, 2] } }, empty: {} };
  const { a, arr: [b, , c], nested: { x: { y: [d] } }, empty: { z = 99 } = {} } = data;
  out.push(a, b, c, d, z);
  const [p, ...rest] = [1, 2, 3, 4];
  out.push(p, rest.join(","), rest.length);
  const { m = 1, n = 2, o = 3 } = { n: 20 };
  out.push(m, n, o);
  let x1 = 1, x2 = 2;
  [x1, x2] = [x2, x1];
  out.push(x1, x2);
  const { q: { r = "d" } = {} } = {};
  out.push(r);
  return out.join("|");
}` },
  { name: "in-operator-bounds", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [1, 2, 3];
  out.push("0" in a ? 1 : 0, "1" in a ? 1 : 0, "3" in a ? 1 : 0, "length" in a ? 1 : 0);
  out.push("length" in "abc" ? 1 : 0, "0" in "abc" ? 1 : 0, "x" in { x: 1 } ? 1 : 0);
  out.push("toString" in {} ? 1 : 0, "hasOwnProperty" in [] ? 1 : 0);
  const o: any = { a: undefined };
  out.push("a" in o ? 1 : 0);
  return out.join("|");
}` },
  { name: "spread-call-rest", fn: "f", ts: `function sumAll(...xs: any[]): any { return xs.reduce((a: any, b: any) => a + b, 0); }
function pair(a: any, b: any): any { return a + ":" + b; }
export function f(): any {
  const out: any = [];
  const arr: any = [1, 2, 3, 4];
  out.push(sumAll(...arr), sumAll(...[10, 20]));
  out.push(pair(...[5, 6]), pair(...[7]));
  out.push(Math.max(...[1, 9, 3]));
  const arr2: any = [1, ...[2, 3], 4];
  out.push(arr2.join(""), arr2.length);
  out.push(sumAll(1, ...[2, 3], 4));
  return out.join("|");
}` },
  { name: "switch-default-not-last", fn: "f", ts: `export function f(x: any): any {
  const log: any = [];
  switch (x) {
    default: log.push("d");
    case 1: log.push("a");
    case 2: log.push("b"); break;
  }
  return log.join("");
}`, args: [9] },
  { name: "void-and-unary-edge", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let n = 0;
  out.push(void 0, void 0 === undefined ? 1 : 0, (void (n = 5), n));
  out.push(+ +"5", - -"3", !0, !!1, !"x", !null, !undefined, !!0);
  out.push(!"", !!NaN, ![], !{});
  let i = 1;
  out.push(i++, ++i, i--, --i, i);
  return out.join("|");
}` },
  { name: "class-private-cross-method", fn: "f", ts: `class Wallet {
  #cash: any = 100;
  #log: any = [];
  deposit(v: any): any { this.#cash += v; this.#log.push("+" + v); return this.#cash; }
  withdraw(v: any): any { if (v > this.#cash) return "no"; this.#cash -= v; this.#log.push("-" + v); return this.#cash; }
  get amount(): any { return this.#cash; }
  get trail(): any { return this.#log.join(","); }
  static create(seed: any): any { const w = new Wallet(); w.#cash = seed; return w; }
}
export function f(): any {
  const out: any = [];
  const w = new Wallet();
  out.push(w.deposit(50), w.withdraw(30), w.withdraw(200), w.amount, w.trail);
  const w2: any = Wallet.create(7);
  out.push(w2.deposit(3), w2.amount, w2 instanceof Wallet ? 1 : 0);
  return out.join("|");
}` },
  { name: "string-matchall-replace-fn", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s = "a1b2c3";
  out.push(s.replace(/(\\d)/g, (m: any, d: any) => "[" + d + "]"));
  out.push(s.replace(/\\d/g, () => "x"));
  const ma: any = s.matchAll ? [...s.matchAll(/(\\d)/g)].map((m: any) => m[0]).join(",") : "na";
  out.push(ma);
  out.push("ababa".replaceAll("a", "X"), "aaa".replace(/a/g, (m: any, i: any) => i + ""));
  out.push("".match(/x/), "".match(/x/) === null ? 1 : 0);
  return out.join("|");
}` },
  { name: "object-keys-array-indices", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = ["x", "y", "z"];
  out.push(Object.keys(a).join(","), Object.getOwnPropertyNames(a).join(","));
  out.push(Object.keys(a).length);
  const o: any = { 2: "two", 1: "one", 10: "ten", a: "A" };
  out.push(Object.keys(o).join(","));
  out.push(Object.getOwnPropertyNames([1, 2]).join(","));
  const s: any = "ab";
  out.push(Object.keys(s).join(","));
  return out.join("|");
}` },
  { name: "json-parse-nested-escape", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const p: any = JSON.parse('{"s":"a\\\\\\"b\\\\nc\\\\u0041","n":-1.5e3,"b":true,"arr":[[1],[2,3]]}');
  out.push(p.s, p.n, p.b ? 1 : 0, JSON.stringify(p.arr));
  out.push(JSON.parse("[null,true,false]").join(","), JSON.parse("0"), JSON.parse("-0") === 0 ? 1 : 0);
  out.push(JSON.parse('"\\\\ud834\\\\udd1e"').length, JSON.parse('"\\\\uD83D\\\\uDE00"').length);
  return out.join("|");
}` },
  { name: "reduce-no-init-throw", fn: "f", ts: `export function f(): any {
  const out: any = [];
  try { const r = [].reduce((a: any, b: any) => a + b); out.push("no:" + r); }
  catch (e: any) { out.push("caught:" + (e instanceof TypeError ? "TypeError" : "oth")); }
  out.push([1].reduce((a: any, b: any) => a + b));
  out.push([].reduce((a: any, b: any) => a + b, 10));
  try { const r2 = [].reduce((a: any, b: any) => a + b, undefined); out.push("v:" + (r2 === undefined)); }
  catch (e: any) { out.push("c2:" + (e instanceof TypeError ? "T" : "o")); }
  return out.join("|");
}` },
  { name: "closure-in-default-param", fn: "f", ts: `let counter = 0;
function nextId(): any { return ++counter; }
function make(v: any = nextId(), tag: any = "t" + v): any { return [v, tag]; }
export function f(): any {
  const out: any = [];
  out.push(make().join(":"), make().join(":"), make(100).join(":"));
  function g(a: any = h(), h: any): any { return a; }
  function h(): any { return 7; }
  out.push(g(undefined, 1));
  const w: any = (x: any = 5, y: any = x * x) => [x, y].join(",");
  out.push(w(), w(3));
  return out.join("|");
}` },
  { name: "array-destructure-return", fn: "f", ts: `function minmax(...xs: any[]): any {
  let mn = Infinity, mx = -Infinity;
  for (const x of xs) { if (x < mn) mn = x; if (x > mx) mx = x; }
  return [mn, mx];
}
function swap2([a, b]: any): any { return [b, a]; }
export function f(): any {
  const out: any = [];
  const [lo, hi] = minmax(4, 1, 9, 3);
  out.push(lo, hi);
  out.push(swap2([1, 2]).join(","));
  const [first, ...rest] = minmax(10, 5);
  out.push(first, rest.join(","));
  const [{ a }, { b }] = [{ a: 1 }, { b: 2 }];
  out.push(a + b);
  return out.join("|");
}` },
  { name: "string-comparison-unicode", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("a" < "b" ? 1 : 0, "ä" < "b" ? 1 : 0, "é" < "ö" ? 1 : 0, "Z" < "a" ? 1 : 0);
  out.push("😀" > "a" ? 1 : 0, "😀" < "😁" ? 1 : 0);
  out.push("abc" == "abc" ? 1 : 0, "abc" === "abc" ? 1 : 0);
  out.push("1" == 1 ? 1 : 0, "1" === 1 ? 1 : 0, null == undefined ? 1 : 0, null === undefined ? 1 : 0);
  out.push("" == 0 ? 1 : 0, "" == "0" ? 1 : 0, "0" == 0 ? 1 : 0);
  return out.join("|");
}` },
  { name: "method-chaining-fluent", fn: "f", ts: `class Str {
  v: any;
  constructor(v: any) { this.v = String(v); }
  up(): any { this.v = this.v.toUpperCase(); return this; }
  rep(n: any): any { this.v = this.v.repeat(n); return this; }
  trim(): any { this.v = this.v.trim(); return this; }
  get() { return this.v; }
}
export function f(): any {
  const out: any = [];
  out.push(new Str("  ab ").trim().up().get());
  out.push(new Str("x-").rep(3).get());
  const s = new Str("a b c");
  s.up().rep(1).trim();
  out.push(s.get());
  const chain: any = new Str(" hi ").trim().up().rep(2).get();
  out.push(chain.length, chain);
  return out.join("|");
}` },
  { name: "object-spread-literal-order", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = { x: 1, y: 2 };
  const b: any = { y: 20, z: 30 };
  out.push(JSON.stringify({ ...a, ...b }));
  out.push(JSON.stringify({ ...a, y: 5, ...b }));
  out.push(JSON.stringify({ ...b, ...a }));
  out.push(Object.keys({ ...a, ...b }).join(","));
  out.push(JSON.stringify({ ...{ 1: "one", 0: "zero" } }));
  return out.join("|");
}` },
  { name: "for-while-conditional-mix", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let s = "";
  for (let i = 0; i < 5; i++) { s += i; if (i === 1) continue; if (i === 3) break; }
  out.push(s);
  let r: any = 0;
  for (let i = 10; i > 0; i -= 2) { if (i === 4) break; r += i; }
  out.push(r);
  let w = 0, n = 0;
  while (w < 20) { w += (n++) * 2; if (n === 4) continue; if (w > 15) break; }
  out.push(w, n);
  const acc: any = [];
  for (let i = 1; i <= 3; i++) { for (let j = 1; j <= 2; j++) { if (i === j) continue; acc.push(i + "" + j); } }
  out.push(acc.join(","));
  return out.join("|");
}`},
];