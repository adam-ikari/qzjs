// 差分审计语料（第十六批）：描述符全矩阵 / Date 方法矩阵 / RegExp 状态 / 命名空间与导入 / 私有静态跨类 / 排序稳定性 / 数值字符串格式。
module.exports = [
  { name: "descriptor-full", fn: "f", ts: `export function f(): any {
  const o: any = {};
  Object.defineProperty(o, "ro", { value: 1, writable: false, enumerable: true, configurable: false });
  Object.defineProperty(o, "hidden", { value: 2, enumerable: false, writable: true, configurable: true });
  const out: any = [];
  out.push(o.ro, o.hidden);
  out.push(Object.keys(o).join(","));
  out.push(Object.getOwnPropertyNames(o).join(","));
  const d: any = Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(o, "ro") : null;
  out.push(d ? [d.value, d.writable ? 1 : 0, d.enumerable ? 1 : 0, d.configurable ? 1 : 0].join(",") : "na");
  o.hidden = 9;
  out.push(o.hidden);
  return out.join("|");
}` },
  { name: "date-methods-matrix", fn: "f", ts: `export function f(): any {
  const d: any = new Date(0);
  const out: any = [];
  out.push(d.getTime(), d.valueOf(), d.getUTCFullYear());
  d.setUTCFullYear(2020);
  out.push(d.getUTCFullYear());
  d.setUTCMonth(5);
  out.push(d.getUTCMonth());
  d.setUTCDate(15);
  out.push(d.getUTCDate());
  d.setUTCHours(10, 30, 45, 123);
  out.push(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  out.push(d.toISOString());
  out.push(new Date(d.getTime()).getTime());
  out.push(typeof d.toString());
  return out.join("|");
}` },
  { name: "regexp-state", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const g: any = /a/g;
  out.push(g.lastIndex);
  out.push(g.test("xa"), g.lastIndex);
  out.push(g.test("xa"), g.lastIndex);
  g.lastIndex = 0;
  out.push(g.test("xa"), g.lastIndex);
  const y: any = /a/y;
  y.lastIndex = 1;
  out.push(y.test("ba"), y.lastIndex);
  y.lastIndex = 0;
  out.push(y.test("ba"));
  const m: any = "a1b2c3".match(/\\d/g);
  out.push(m.join(","));
  const re: any = /(\\d)(\\w)/;
  const ex: any = re.exec("x1y2z");
  out.push(ex[0], ex[1], ex[2], ex.index, ex.input);
  return out.join("|");
}` },
  { name: "namespace-import-sim", fn: "f", ts: `export function f(): any {
  const utils: any = {
    double: (x: any) => x * 2,
    triple: (x: any) => x * 3,
    prop: 7,
    nested: { deep: (x: any) => x + 100 }
  };
  const out: any = [];
  out.push(utils.double(5), utils.triple(5), utils.prop);
  out.push(utils.nested.deep(1));
  out.push(Object.keys(utils).length);
  return out.join("|");
}` },
  { name: "private-static-cross-class", fn: "f", ts: `class A {
  static #count = 0;
  static #bump(): any { return ++A.#count; }
  static next(): any { return A.#bump(); }
}
class B {
  static #count = 100;
  static #bump(): any { return ++B.#count; }
  static next(): any { return B.#bump(); }
}
export function f(): any {
  const out: any = [];
  out.push(A.next(), A.next(), B.next(), B.next());
  out.push(A.next(), B.next());
  return out.join("|");
}` },
  { name: "sort-stability-edge", fn: "f", ts: `export function f(): any {
  const items: any = [];
  for (let i = 0; i < 10; i++) items.push({ k: i % 2, i: i });
  const byK: any = items.slice().sort((a: any, b: any) => a.k - b.k);
  const out: any = [];
  out.push(byK.map((x: any) => x.i).join(","));
  const neg: any = [3, -1, -2, 0, 5].sort((a: any, b: any) => a - b);
  out.push(neg.join(","));
  const strs: any = ["b", "a", "c", "A", "B"].sort();
  out.push(strs.join(","));
  const mixed: any = [10, 2, "3", 1].sort((a: any, b: any) => a - b);
  out.push(mixed.join(","));
  return out.join("|");
}` },
  { name: "number-format-matrix", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push((1234.5678).toFixed(0), (1234.5678).toFixed(5));
  out.push((0.00012345).toPrecision(3), (123456).toPrecision(3));
  out.push((1234.5678).toExponential(), (1234.5678).toExponential(3));
  out.push(Number("  12  "), Number(""), Number("x"), Number(true), Number(null), Number(undefined));
  out.push((255).toString(16), (255).toString(8), (255).toString(36));
  out.push(Number.MAX_SAFE_INTEGER.toString());
  out.push(Number.MIN_SAFE_INTEGER.toString());
  out.push((-0.5).toFixed(0), (0.5).toFixed(0));
  return out.join("|");
}` },
  { name: "string-unicode-ops", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s = "a\\u0301b";
  out.push(s.length, [...s].length);
  out.push(s.normalize("NFC").length, s.normalize("NFD").length);
  out.push("\\u00e9".normalize("NFD").length, "e\\u0301".normalize("NFC").length);
  out.push("ß".toUpperCase(), "İ".toLowerCase().length);
  out.push("café".toUpperCase());
  out.push("𝌆".length, [..."𝌆"].length);
  out.push("a".codePointAt(0), "𝌆".codePointAt(0));
  out.push(String.fromCodePoint(0x1D306).length);
  return out.join("|");
}` },
  { name: "getownpropertydescriptor-matrix", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1 };
  const d1: any = Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(o, "a") : null;
  out.push(d1 ? [d1.value, d1.writable ? 1 : 0, d1.enumerable ? 1 : 0, d1.configurable ? 1 : 0].join(",") : "na");
  const d2: any = Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(o, "z") : null;
  out.push(d2 === undefined ? 1 : 0);
  const arr: any = [1, 2];
  const d3: any = Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(arr, "length") : null;
  out.push(d3 ? d3.value : "na");
  out.push(Object.getOwnPropertyNames(o).join(","));
  return out.join("|");
}` },
  { name: "array-copy-methods", fn: "f", ts: `export function f(): any {
  const a: any = [1, 2, 3];
  const out: any = [];
  const b: any = a.concat([4, 5]);
  const c: any = a.concat(6, [7]);
  const d: any = a.slice(0);
  const e: any = [...a];
  b.push(9); d.push(9); e.push(9);
  out.push(a.join(","), b.join(","), c.join(","), d.join(","), e.join(","));
  out.push(a.concat("x").join(","), [].concat(1, 2).join(","));
  out.push([...a, ...[4]].join(","));
  return out.join("|");
}` },
  { name: "object-entries-values-deep", fn: "f", ts: `export function f(): any {
  const o: any = { b: 2, a: 1, c: { x: 3 } };
  const out: any = [];
  out.push(Object.keys(o).join(","));
  out.push(Object.values(o).map((v: any) => typeof v === "object" ? "obj" : v).join(","));
  out.push(Object.entries(o).map((e: any) => e[0] + ":" + (typeof e[1] === "object" ? "obj" : e[1])).join(","));
  const from: any = Object.fromEntries(Object.entries(o));
  out.push(from.a, from.c.x);
  out.push(Object.entries(from).length);
  return out.join("|");
}` },
  { name: "closure-perf-shapes", fn: "f", ts: `export function f(): any {
  const out: any = [];
  function memo(): any {
    const cache: any = {};
    return (k: any): any => { if (cache[k] === undefined) cache[k] = k * 2; return cache[k]; };
  }
  const m = memo();
  out.push(m(3), m(3), m(4));
  let counter = 0;
  const incr = (): any => ++counter;
  out.push(incr(), incr(), counter);
  const objPool: any = [];
  for (let i = 0; i < 3; i++) objPool.push({ i: i, get: () => i * 10 });
  out.push(objPool.map((o: any) => o.get()).join(","));
  return out.join("|");
}` },
  { name: "try-finally-value-paths", fn: "f", ts: `export function f(): any {
  const out: any = [];
  function a(): any { try { return "try"; } finally { out.push("fa"); } }
  function b(): any { try { throw new Error("e"); } catch (er: any) { return "catch"; } finally { out.push("fb"); } }
  function c(): any { let v = 0; try { v = 1; return v; } finally { v = 2; } }
  out.push(a(), b(), c());
  function d(): any { for (let i = 0; i < 3; i++) { try { if (i === 1) return i; } finally { out.push("d" + i); } } return -1; }
  out.push(d());
  return out.join("|");
}` },
  { name: "switch-fallthrough-chain", fn: "f", ts: `export function f(x: any): any {
  const out: any = [];
  switch (x) {
    case 1: out.push("one");
    case 2: out.push("two");
    case 3: out.push("three"); break;
    case 4: out.push("four");
    default: out.push("def");
  }
  return out.join(",");
}`, args: [2] },
  { name: "array-methods-return-types", fn: "f", ts: `export function f(): any {
  const a: any = [1, 2, 3];
  const out: any = [];
  out.push(typeof a.map((x: any) => x), typeof a.filter((x: any) => x), typeof a.find((x: any) => x));
  out.push(typeof a.indexOf(2), typeof a.includes(2), typeof a.join(","));
  out.push(typeof a.push(4), typeof a.slice(0), typeof a.concat([]));
  out.push(a.length);
  const r: any = a.map((x: any) => x * 2);
  out.push(Array.isArray(r) ? 1 : 0, r.length);
  return out.join("|");
}` },
  { name: "nested-destructure-deep", fn: "f", ts: `export function f(): any {
  const data: any = { a: [1, { b: 2, c: [3, 4] }], d: { e: { f: 5 } } };
  const { a: [a0, { b, c: [c0, c1] }], d: { e: { f } } } = data;
  const out: any = [];
  out.push(a0, b, c0, c1, f);
  const nested: any = { x: { y: { z: [1, 2, 3] } } };
  const { x: { y: { z: [z0] } } } = nested;
  out.push(z0, nested.x.y.z.length);
  return out.join("|");
}` },
  { name: "boolean-number-coerce", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Boolean(0), Boolean(""), Boolean("0"), Boolean([]), Boolean({}), Boolean(null));
  out.push([] == false ? 1 : 0, "" == 0 ? 1 : 0, "0" == false ? 1 : 0);
  out.push([0] == false ? 1 : 0, [1] == true ? 1 : 0);
  out.push(null == undefined ? 1 : 0, null === undefined ? 1 : 0);
  out.push(0 == "0" ? 1 : 0, 0 === "0" ? 1 : 0);
  out.push(NaN == NaN ? 1 : 0, isNaN(NaN) ? 1 : 0);
  return out.join("|");
}` },
  { name: "class-getter-setter-inherit-mix", fn: "f", ts: `class Base { _v: any = 1; get v(): any { return this._v * 10; } set v(x: any) { this._v = x; } }
class Mid extends Base { get w(): any { return this.v + 1; } }
class Leaf extends Mid { get v(): any { return super.v + 100; } set v(x: any) { super.v = x * 2; } }
export function f(): any {
  const out: any = [];
  const l = new Leaf();
  out.push(l.v, l.w);
  l.v = 3;
  out.push(l._v, l.v, l.w);
  const b = new Base();
  out.push(b.v);
  b.v = 5;
  out.push(b.v);
  return out.join("|");
}` },
  { name: "json-stringify-nested-edge", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const arr: any = [1, [2, [3, [4]]]];
  out.push(JSON.stringify(arr));
  out.push(JSON.stringify({ a: { b: { c: null } } }));
  out.push(JSON.stringify([{}, [], null, true, 0, ""]));
  out.push(JSON.stringify({ "k-1": 1, "k 2": 2 }));
  const parsed: any = JSON.parse('{"a":[1,{"b":2}]}');
  out.push(parsed.a[1].b);
  out.push(JSON.stringify({ d: 1 }));
  return out.join("|");
}` },
];
