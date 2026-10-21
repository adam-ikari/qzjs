// 差分审计语料（第三十八批）：Array flat/flatMap/copyWithin/at、String matchAll/at/split(limit)、
// Object.fromEntries 迭代器源、sort 稳定性/比较函数返回非数、Map/Set 迭代器协议、Reflect、Symbol.toPrimitive。
module.exports = [
  { name: "array-flat-flatmap", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push([1, [2, [3, [4]]]].flat().join(","), [1, [2, [3, [4]]]].flat(2).join(","), [1, [2, [3, [4]]]].flat(Infinity).join(","));
  out.push([1, [2, [3, [4]]]].flat(0).join(","), [].flat().length, [[[1]]].flat().join(","));
  out.push([1, 2, 3].flatMap(x => [x, x * 10]).join(","), [1, 2].flatMap(x => x).join(","));
  out.push(["a,b", "c,d"].flatMap(s => s.split(",")).join(","));
  out.push([1, 2, 3].flatMap(x => null).length, [1, 2].flatMap(x => [x]).join(","));
  return out.join("|");
}` },
  { name: "array-copywithin-fill", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a1: any = [1, 2, 3, 4, 5];
  a1.copyWithin(0, 3);
  out.push(a1.join(","));
  const a2: any = [1, 2, 3, 4, 5];
  a2.copyWithin(1, 3, 4);
  out.push(a2.join(","));
  const a3: any = [1, 2, 3, 4, 5];
  a3.copyWithin(-2, 0, 2);
  out.push(a3.join(","));
  const a4: any = [0, 0, 0, 0];
  a4.fill(5, 1, 3);
  out.push(a4.join(","));
  const a5: any = new Array(3);
  a5.fill(7);
  out.push(a5.join(","));
  const a6: any = [1, 2, 3, 4];
  a6.fill(0, -3, -1);
  out.push(a6.join(","));
  return out.join("|");
}` },
  { name: "array-at-negative", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const arr: any = [10, 20, 30, 40];
  out.push(arr.at(0), arr.at(-1), arr.at(-2), arr.at(2), arr.at(99), arr.at(-99));
  out.push(arr.at(), arr.length);
  const s: any = "hello";
  out.push(s.at(0), s.at(-1), s.at(-2), s.at(10), s.at(-10));
  return out.join("|");
}` },
  { name: "string-split-limit-matchall", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("a,b,c,d".split(",", 2).join("|"), "a,b,c,d".split(",", 0).length, "a,b,c".split(",").length);
  out.push("a__b__c".split("__").join("|"), "abc".split("").join("|"));
  out.push("a1b2c3".split(/\d/).join("|"), "a1b2c3".split(/(\d)/).join("|"));
  const matches: any = [];
  for (const m of "a1b2c3".matchAll(/([a-z])(\d)/g)) matches.push(m[0] + ":" + m[1] + ":" + m[2]);
  out.push(matches.join(","));
  out.push("aaa".matchAll(/a/g) ? "has" : "none", [..."test".matchAll(/t/g)].length);
  return out.join("|");
}` },
  { name: "sort-stability-comparator", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const items: any = [{ k: "a", v: 1 }, { k: "b", v: 1 }, { k: "c", v: 1 }, { k: "d", v: 0 }, { k: "e", v: 0 }];
  items.sort((a: any, b: any) => a.v - b.v);
  out.push(items.map((i: any) => i.k).join(""));
  const nums: any = [3, 1, 4, 1, 5, 9, 2, 6];
  nums.sort((a: any, b: any) => a - b);
  out.push(nums.join(","));
  const nums2: any = [3, 1, 2];
  nums2.sort(() => 0);
  out.push(nums2.join(","), nums2.length);
  const arr3: any = [10, 1, 2];
  arr3.sort();
  out.push(arr3.join(","));
  const arr4: any = [3, 1, 2];
  arr4.sort((a: any, b: any) => "x");
  out.push(arr4.length, arr4.join(","));
  return out.join("|");
}` },
  { name: "object-fromentries-iter", unsupported: "generator 参与迭代未实现", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const entries: any = [["a", 1], ["b", 2], ["c", 3]];
  const o: any = Object.fromEntries(entries);
  out.push(Object.keys(o).join(","), o.a, o.b, o.c, o.a + o.b + o.c);
  const map: any = new Map([["x", 10], ["y", 20]]);
  const o2: any = Object.fromEntries(map);
  out.push(Object.keys(o2).join(","), o2.x, o2.y);
  const gen: any = (function* () { yield ["first", 1]; yield ["second", 2]; })();
  const o3: any = Object.fromEntries(gen);
  out.push(Object.keys(o3).join(","), o3.first, o3.second);
  out.push(Object.fromEntries([]).length, Object.keys(Object.fromEntries([["a", 1]])).join(""));
  return out.join("|");
}` },
  { name: "map-iteration-protocol", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const m: any = new Map();
  m.set("a", 1); m.set("b", 2); m.set("c", 3);
  const keys: any = [];
  for (const k of m.keys()) keys.push(k);
  out.push(keys.join(","));
  const vals: any = [];
  for (const v of m.values()) vals.push(v);
  out.push(vals.join(","));
  const entries: any = [];
  for (const [k, v] of m) entries.push(k + "=" + v);
  out.push(entries.join(","));
  const spread: any = [...m];
  out.push(spread.length, spread[0][0], spread[0][1]);
  const m2: any = new Map([["x", 1], ["y", 2]]);
  out.push(m2.size, m2.get("x"), Array.from(m2).length);
  return out.join("|");
}` },
  { name: "set-operations-iter", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s: any = new Set([1, 2, 3, 2, 1]);
  out.push(s.size, s.has(2) ? 1 : 0, s.has(4) ? 1 : 0);
  const arr: any = [];
  for (const v of s) arr.push(v);
  out.push(arr.join(","));
  const s2: any = new Set("hello");
  out.push(s2.size, [...s2].join(""));
  out.push(new Set([1, 2, 3]).size, new Set().size, new Set([null, undefined, 0, "", false]).size);
  const dup: any = new Set([{}]);
  out.push(dup.size);
  return out.join("|");
}` },
  { name: "symbol-toprimitive", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = {
    [Symbol.toPrimitive](hint: any) {
      if (hint === "number") return 42;
      if (hint === "string") return "forty-two";
      return "default";
    }
  };
  out.push(+o, o + "", o + 1, "" + o);
  out.push(\`\${o}\`, String(o), Number(o));
  const o2: any = { [Symbol.toPrimitive]() { return "x"; } };
  out.push(o2 + "", o2 * 1, isNaN(o2 * 1) ? "NaN" : "num");
  return out.join("|");
}` },
  { name: "reflect-basics", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: 2 };
  out.push(Reflect.has(o, "a") ? 1 : 0, Reflect.has(o, "c") ? 1 : 0);
  out.push(Reflect.get(o, "a"), Reflect.get(o, "b"), Reflect.get(o, "c", { a: 99 }));
  out.push(Reflect.ownKeys(o).join(","));
  Reflect.set(o, "c", 3);
  out.push(o.c, Reflect.get(o, "c"));
  out.push(Reflect.deleteProperty(o, "a") ? 1 : 0, "a" in o ? 1 : 0);
  const arr: any = [10, 20, 30];
  out.push(Reflect.get(arr, 1), Reflect.has(arr, "length") ? 1 : 0);
  out.push(typeof Reflect.apply, typeof Reflect.construct);
  return out.join("|");
}` },
  { name: "number-tostring-precision", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push((255).toString(16), (255).toString(2), (255).toString(8), (0).toString(16));
  out.push((3.14159).toFixed(2), (1.5).toFixed(0), (0.0001).toFixed(0), (1234.5678).toFixed(2));
  out.push((123).toPrecision(1), (123).toPrecision(2), (0.000123).toPrecision(2));
  out.push((1000000).toExponential(2), (0.0000123).toExponential(1));
  out.push((1e21).toString(), (1e-7).toString(), (1e-6).toString());
  out.push(parseInt("0xff", 16), parseInt("10", 2), parseInt("99", 8), parseFloat("3.14abc"));
  return out.join("|");
}` },
  { name: "array-splice-slice-edge", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a1: any = [1, 2, 3, 4, 5];
  const r1: any = a1.splice(1, 2);
  out.push(a1.join(","), r1.join(","));
  const a2: any = [1, 2, 3, 4, 5];
  const r2: any = a2.splice(-2, 1);
  out.push(a2.join(","), r2.join(","));
  const a3: any = [1, 2, 3, 4, 5];
  const r3: any = a3.splice(1, 0, "a", "b");
  out.push(a3.join(","), r3.length);
  const a4: any = [1, 2, 3, 4, 5];
  const r4: any = a4.splice(2);
  out.push(a4.join(","), r4.join(","));
  out.push([1, 2, 3, 4, 5].slice(-3).join(","), [1, 2, 3, 4, 5].slice(-3, -1).join(","));
  out.push([1, 2, 3, 4, 5].slice(1, -2).join(","), [].slice(0, 10).length);
  return out.join("|");
}` },
  { name: "string-repeat-pad-trim", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("ab".repeat(3), "".repeat(5).length, "x".repeat(0), "abc".repeat(2));
  out.push("5".padStart(3, "0"), "5".padStart(3), "abc".padEnd(5, "*"), "abc".padEnd(2));
  out.push("5".padStart(1, "0"), "hello".padStart(10, "ab"));
  out.push("  hi  ".trim(), "  hi  ".trimStart(), "  hi  ".trimEnd());
  out.push("\\t\\n hi \\n\\t".trim().length, "a b c".trim().length);
  out.push("abc".repeat(3).length, "ab".repeat(0).length);
  return out.join("|");
}` },
  { name: "logical-assignment-nullish", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let a: any = null;
  a ??= 5;
  out.push(a);
  let b: any = 0;
  b ??= 10;
  out.push(b);
  let c: any = "";
  c ??= "x";
  out.push(c);
  let d: any = undefined;
  d ??= "d";
  out.push(d);
  let e: any = false;
  e ||= true;
  out.push(e);
  let f2: any = 1;
  f2 ||= 2;
  out.push(f2);
  let g: any = 0;
  g &&= 5;
  out.push(g);
  let h: any = 1;
  h &&= 5;
  out.push(h);
  return out.join("|");
}` },
  { name: "ternary-chains-defaults", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const grade: any = (s: any) => s >= 90 ? "A" : s >= 80 ? "B" : s >= 70 ? "C" : s >= 60 ? "D" : "F";
  out.push(grade(95), grade(85), grade(75), grade(65), grade(55));
  const fmt: any = (v: any) => v == null ? "null" : typeof v === "string" ? "str:" + v : typeof v === "number" ? "num:" + v : "other";
  out.push(fmt(null), fmt(undefined), fmt("hi"), fmt(42), fmt(true));
  const get: any = (o: any, k: any, dflt: any) => (o != null && k in o) ? o[k] : dflt;
  out.push(get({ a: 1 }, "a", 0), get({ a: 1 }, "b", 99), get(null, "x", "none"), get({}, "y", "empty"));
  const arr: any = [1, 2, 3];
  out.push(arr.length > 0 ? arr[0] : "empty", arr.length > 5 ? arr[5] : "short", arr[arr.length - 1]);
  return out.join("|");
}` },
  { name: "closure-over-loop-edge", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const fns: any[] = [];
  for (let i = 0; i < 3; i++) { fns.push(() => i); }
  out.push(fns[0](), fns[1](), fns[2]());
  const fns2: any[] = [];
  for (let i = 0; i < 3; i++) { fns2.push(((j: any) => () => j)(i)); }
  out.push(fns2[0](), fns2[1](), fns2[2]());
  let x: any = 10;
  const g: any = () => x;
  out.push(g());
  x = 20;
  out.push(g());
  const h: any = (a: any) => (b: any) => (c: any) => a + b + c;
  out.push(h(1)(2)(3));
  const counter: any = (() => { let n: any = 0; return () => ++n; })();
  out.push(counter(), counter(), counter());
  return out.join("|");
}` },
  { name: "error-cause-chain", fn: "f", ts: `export function f(): any {
  const out: any = [];
  try {
    try {
      throw new Error("inner");
    } catch (e: any) {
      throw new Error("outer", { cause: e });
    }
  } catch (e2: any) {
    out.push(e2.message, e2.cause.message, e2.cause instanceof Error);
  }
  const err: any = new Error("test", { cause: "string cause" });
  out.push(err.message, err.cause, typeof err.cause);
  try { JSON.parse("{bad"); } catch (e3: any) { out.push(e3 instanceof SyntaxError, e3.message.length > 0); }
  const custom: any = class extends Error { constructor(m: any) { super(m); this.name = "Custom"; } };
  const c: any = new custom("hi");
  out.push(c.message, c.name, c instanceof Error, c instanceof custom);
  return out.join("|");
}` },
  { name: "prototype-chain-edge", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const base: any = { b: 1 };
  const derived: any = Object.create(base);
  derived.d = 2;
  out.push(derived.d, derived.b, Object.getPrototypeOf(derived) === base);
  out.push("d" in derived, "b" in derived, derived.hasOwnProperty("d"), derived.hasOwnProperty("b"));
  const o: any = Object.create(null);
  out.push(Object.getPrototypeOf(o), o instanceof Object);
  const proto: any = { greet() { return "hi"; } };
  const obj: any = Object.create(proto);
  out.push(obj.greet(), Object.getPrototypeOf(obj) === proto);
  const chain: any = Object.create(Object.create({ x: 1 }));
  out.push(chain.x, "x" in chain);
  const ctor: any = function C(this: any) { this.v = 5; } as any;
  ctor.prototype.m = function() { return "m"; };
  const inst: any = new ctor();
  out.push(inst.v, inst.m(), inst instanceof ctor);
  return out.join("|");
}` },
];
