// 差分审计语料（第十一批）：类表达式 / IIFE / 表达式运算符 / 标签 / switch 边界 / Map·Set 边界 / 访问器定义 / 模板标签函数。
module.exports = [
  { name: "class-expression", fn: "f", ts: `export function f(): any {
  const C = class { v: any = 1; m(): any { return this.v + 1; } };
  const out: any = [];
  const c = new C();
  out.push(c.m());
  out.push(c instanceof C ? 1 : 0);
  const D = class Named { n(): any { return "n"; } };
  out.push(new D().n());
  return out.join("|");
}` },
  { name: "iife-comma-void", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push((function () { return 1; })());
  out.push((() => 2)());
  let a = 0;
  out.push((a = 1, a + 1));
  out.push(void 0 === undefined ? 1 : 0);
  out.push((a++, a));
  out.push((0, Math.max)(1, 2));
  let b: any;
  out.push(b = 5);
  return out.join("|");
}` },
  { name: "labeled-loops-break", fn: "f", ts: `export function f(): any {
  const out: any = [];
  outer: for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (j === 1) continue outer;
      if (i === 2) break outer;
      out.push(i + ":" + j);
    }
  }
  let n = 0;
  loop: while (n < 3) { n++; if (n === 2) continue loop; out.push("w" + n); }
  return out.join(",");
}` },
  { name: "switch-fallthrough-default-mid", fn: "f", ts: `export function f(x: any): any {
  let out = "";
  switch (x) {
    case 1: out += "1";
    default: out += "d";
    case 2: out += "2"; break;
    case 3: out += "3";
  }
  return out;
}`, args: [1] },
  { name: "do-while-continue", fn: "f", ts: `export function f(): any {
  let i = 0, out = "";
  do { i++; if (i % 2 === 0) continue; out += i; } while (i < 5);
  let j = 10;
  do { j++; } while (false);
  return out + "|" + j;
}` },
  { name: "map-object-keys", fn: "f", ts: `export function f(): any {
  const k1: any = { id: 1 }, k2: any = { id: 2 };
  const m: any = new Map();
  m.set(k1, "a"); m.set(k2, "b");
  const out: any = [];
  out.push(m.size);
  out.push(m.get(k1), m.get(k2));
  out.push(m.get({ id: 1 }) === undefined ? 1 : 0);
  out.push(m.has(k1) ? 1 : 0);
  m.delete(k1);
  out.push(m.size, m.get(k1) === undefined ? 1 : 0);
  const s: any = new Set([NaN, NaN, 0, -0]);
  out.push(s.size);
  return out.join("|");
}` },
  { name: "prop-order-runtime-keys", fn: "f", ts: `export function f(): any {
  const o: any = {};
  const keys: any = ["z", "y", "x"];
  for (const k of keys) o[k] = k.toUpperCase();
  const out: any = [];
  out.push(Object.keys(o).join(","));
  out.push(JSON.stringify(o));
  delete o.y;
  out.push(Object.keys(o).join(","));
  o.y2 = "!";
  out.push(Object.keys(o).join(","));
  return out.join("|");
}` },
  { name: "defineproperty-accessor", fn: "f", ts: `export function f(): any {
  const o: any = { _v: 1 };
  let log: any = [];
  Object.defineProperty(o, "v", {
    get() { log.push("g"); return this._v * 10; },
    set(x: any) { log.push("s"); this._v = x; },
    enumerable: true, configurable: true
  });
  const out: any = [];
  out.push(o.v);
  o.v = 4;
  out.push(o._v, o.v);
  out.push(log.join(""));
  out.push(Object.keys(o).sort().join(","));
  return out.join("|");
}` },
  { name: "template-tag-function", fn: "f", ts: `export function f(): any {
  function tag(strings: any, ...vals: any[]): any { return strings.join("|") + "#" + vals.join(","); }
  const x = 1, y = 2;
  return tag\`a\${x}b\${y}c\`;
}` },
  { name: "array-from-length-map", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Array.from({ length: 3 }, (v: any, i: any) => i * 2).join(","));
  out.push(Array.from({ length: 0 }).length);
  out.push(Array.from(new Map([[1, "a"], [2, "b"]]), (e: any) => e[0] + e[1]).join(","));
  out.push([...Array(3)].length);
  out.push([...Array(3)].map((_, i) => i).join(","));
  return out.join("|");
}` },
  { name: "string-methods-chain", fn: "f", ts: `export function f(): any {
  const s = "  Hello World  ";
  const out: any = [];
  out.push(s.trim().toLowerCase().replace(" ", "_"));
  out.push(s.trim().split(" ").length);
  out.push("a-b-c".split("-").map((x: any) => x.toUpperCase()).join(""));
  out.push("abc".padStart(5, "*").padEnd(7, "!"));
  out.push("x".repeat(3).length);
  out.push(["b", "a"].join("") + "c");
  return out.join("|");
}` },
  { name: "number-methods-edge", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push((123.456).toFixed(1));
  out.push((0.000001234).toPrecision(2));
  out.push((1234.5).toExponential(1));
  out.push(Number.isNaN(NaN), Number.isFinite(Infinity));
  out.push((10).toString(2), (10).toString(36));
  out.push(Math.trunc(-4.7), Math.floor(-4.7), Math.ceil(-4.7));
  out.push(Math.abs(-0) === 0 ? 1 : 0);
  out.push(Math.sign(-3), Math.sign(0));
  out.push((2 ** 10), Math.pow(2, 10));
  return out.join("|");
}` },
  { name: "destructure-nested-defaults", fn: "f", ts: `export function f(): any {
  const { a: { b = 1 } = {}, c = 2 } = { a: {} } as any;
  const out: any = [];
  out.push(b, c);
  const [x = 10, [y = 20] = []] = [undefined] as any;
  out.push(x, y);
  const { p: { q } = { q: 3 } } = {} as any;
  out.push(q);
  function g({ m = 5, n: { o = 6 } = {} } = {} as any): any { return m + o; }
  out.push(g());
  out.push(g({ m: 1, n: { o: 2 } }));
  return out.join("|");
}` },
  { name: "rest-spread-objects", fn: "f", ts: `export function f(): any {
  const o: any = { a: 1, b: 2, c: 3 };
  const { a, ...rest } = o;
  const out: any = [];
  out.push(a, Object.keys(rest).join(","));
  const merged: any = { ...rest, d: 4 };
  out.push(JSON.stringify(merged));
  const arr: any = [1, 2, 3, 4];
  const [h, ...t] = arr;
  out.push(h, t.join(","));
  function g(first: any, ...others: any[]): any { return first + ":" + others.length; }
  out.push(g(1, 2, 3), g(0));
  return out.join("|");
}` },
  { name: "getter-in-class-inheritance-chain", fn: "f", ts: `class A { get v(): any { return "A"; } }
class B extends A { get v(): any { return "B"; } }
class Cx extends B { m(): any { return this.v + super.v; } }
export function f(): any {
  const out: any = [];
  out.push(new Cx().m());
  out.push(new Cx().v);
  const obj: any = new Cx();
  out.push(Object.keys(obj).length);
  out.push("v" in obj ? 1 : 0);
  return out.join("|");
}` },
  { name: "class-private-static-method", fn: "f", ts: `class P {
  static #count = 0;
  static #bump(): any { return ++P.#count; }
  static next(): any { return P.#bump(); }
  #x = 5;
  getX(): any { return this.#x; }
}
export function f(): any {
  const out: any = [];
  out.push(P.next(), P.next());
  const p = new P();
  out.push(p.getX());
  return out.join("|");
}` },
  { name: "array-sort-stability", fn: "f", ts: `export function f(): any {
  const a: any = [{ k: 1, i: 0 }, { k: 0, i: 1 }, { k: 1, i: 2 }, { k: 0, i: 3 }];
  a.sort((x: any, y: any) => x.k - y.k);
  return a.map((x: any) => x.i).join(",");
}` },
  { name: "json-nested-mixed", fn: "f", ts: `export function f(): any {
  const o: any = { arr: [1, { a: [2, 3] }, "s"], nested: { deep: { x: null } }, t: true, n: 1.5 };
  const s = JSON.stringify(o);
  const back = JSON.parse(s);
  const out: any = [];
  out.push(s);
  out.push(back.arr[1].a[1], back.nested.deep.x === null ? 1 : 0, back.t ? 1 : 0);
  out.push(Object.keys(back).join(","));
  out.push(Array.isArray(back.arr) ? 1 : 0);
  return out.join("|");
}` },
  { name: "try-nested-return-value", fn: "f", ts: `export function f(): any {
  function a(): any {
    try {
      try { throw new Error("x"); }
      catch (e: any) { return "inner"; }
      finally { }
    } finally { }
  }
  function b(): any {
    for (let i = 0; i < 3; i++) { try { if (i === 1) return i; } finally { } }
    return -1;
  }
  function c(): any {
    let v = 0;
    try { throw 1; } catch (e: any) { v = 1; } finally { v += 10; }
    return v;
  }
  return [a(), b(), c()].join("|");
}` },
  { name: "typeof-instanceof-chain", fn: "f", ts: `class A { }
class B extends A { }
export function f(): any {
  const b = new B();
  const out: any = [];
  out.push(typeof b, typeof A, typeof undefined);
  out.push(b instanceof B ? 1 : 0, b instanceof A ? 1 : 0);
  out.push(b instanceof Object ? 1 : 0);
  out.push([] instanceof Array ? 1 : 0);
  out.push({} instanceof Object ? 1 : 0);
  out.push("s" instanceof String ? 1 : 0);
  return out.join("|");
}` },
  { name: "object-getter-symbol-iterator", fn: "f", ts: `export function f(): any {
  const o: any = {
    data: [1, 2, 3],
    [Symbol.iterator]() { let i = 0; const d = this.data; return { next: () => i < d.length ? { value: d[i++], done: false } : { value: undefined, done: true } }; }
  };
  const out: any = [];
  out.push([...o].join(","));
  out.push(Array.from(o).length);
  for (const v of o) out.push("v" + v);
  return out.join("|");
}` },
  { name: "string-comparison-sort", fn: "f", ts: `export function f(): any {
  const names: any = ["banana", "Apple", "cherry", "apple", "Banana"];
  const out: any = [];
  out.push(names.slice().sort().join(","));
  out.push(names.slice().sort((a: any, b: any) => a.localeCompare(b)).join(","));
  out.push(names.slice().sort((a: any, b: any) => b.length - a.length).join(","));
  out.push(names.filter((n: any) => n.toLowerCase().startsWith("a")).join(","));
  out.push(names.findIndex((n: any) => n === "cherry"));
  return out.join("|");
}` },
  { name: "closure-counter-methods", fn: "f", ts: `export function f(): any {
  function makeCounter(): any {
    let n = 0;
    return { inc: () => ++n, dec: () => --n, get value() { return n; } };
  }
  const c1 = makeCounter(), c2 = makeCounter();
  const out: any = [];
  out.push(c1.inc(), c1.inc(), c2.inc());
  out.push(c1.value, c2.value);
  out.push(c1.dec(), c1.value);
  return out.join("|");
}` },
  { name: "array-reduce-object-accum", fn: "f", ts: `export function f(): any {
  const items: any = [{ k: "a", v: 1 }, { k: "b", v: 2 }, { k: "a", v: 3 }];
  const grouped: any = items.reduce((acc: any, it: any) => { (acc[it.k] = acc[it.k] || []).push(it.v); return acc; }, {});
  const out: any = [];
  out.push(Object.keys(grouped).join(","));
  out.push(grouped.a.join(","), grouped.b.join(","));
  out.push(JSON.stringify(grouped));
  return out.join("|");
}` },
];
