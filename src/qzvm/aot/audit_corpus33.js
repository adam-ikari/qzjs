// 差分审计语料（第三十三批）：Object/Array 组合方法、defineProperty、sort 稳定性、String 方法、JSON、标签循环、
// try/finally、switch、解构、Map/Set、数值与位运算、Math、freeze、私有字段、Symbol、可选链/逻辑赋值、Array.from、闭包循环变量。
module.exports = [
  { name: "object-entries-fromentries", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: 2 };
  out.push(Object.entries(o).map((e: any) => e.join(":")).join(","));
  out.push(JSON.stringify(Object.fromEntries([["x", 1], ["y", 2]])));
  out.push(Object.assign({}, { a: 1 }, { b: 2 }, null, undefined, { a: 3 }).a);
  out.push(Object.values({ p: 1, q: 2 }).join(","));
  out.push(Object.getOwnPropertyNames({ z: 1, 2: "two" }).join(","));
  return out.join("|");
}` },
  { name: "defineproperty-descriptors", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = {};
  Object.defineProperty(o, "hidden", { value: 42, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(o, "vis", { value: 1, enumerable: true });
  out.push(o.hidden, o.vis, Object.keys(o).join(","), Object.getOwnPropertyNames(o).join(","));
  const d: any = Object.getOwnPropertyDescriptor(o, "hidden");
  out.push(d.value, d.enumerable, d.writable);
  out.push(Object.prototype.hasOwnProperty.call(o, "hidden"));
  return out.join("|");
}` },
  { name: "array-sort-comparators", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [3, 1, 2];
  out.push(a.slice().sort().join(","), a.slice().sort((x: any, y: any) => y - x).join(","));
  const objs: any = [{ k: 2, t: "b" }, { k: 1, t: "a" }, { k: 2, t: "c" }];
  out.push(objs.slice().sort((x: any, y: any) => x.k - y.k).map((e: any) => e.t).join(""));
  out.push(["b", "a", "C"].sort().join(","));
  out.push([10, 9, 100].sort().join(","));
  out.push([4, 2, 3, 1].sort((x: any, y: any) => x - y).reverse().join(","));
  return out.join("|");
}` },
  { name: "string-methods-deep", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s: any = "Hello World";
  out.push(s.replace("World", "There"), s.replace(/o/g, "0"));
  out.push(s.split(" ").join("-"), "a,b,,c".split(",").join(";"));
  out.push(s.slice(1, 4), s.slice(-5), s.indexOf("o"), s.lastIndexOf("o"), s.includes("World"));
  out.push("  pad  ".trim(), "ab".padStart(5, "."), "ab".padEnd(5, "."), "x".repeat(3));
  out.push(s.charAt(0), s[1], s.toUpperCase(), s.toLowerCase());
  out.push("a-b-c".split("-", 2).join("+"));
  return out.join("|");
}` },
  { name: "json-stringify-replacer", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: "s", c: [1, 2], d: { e: null }, f: true, g: undefined };
  out.push(JSON.stringify(o));
  out.push(JSON.stringify(o, ["a", "b"]));
  out.push(JSON.stringify(o, (k: any, v: any) => (typeof v === "number" ? v * 10 : v)));
  out.push(JSON.stringify({ x: 1 }, null, 0));
  out.push(JSON.stringify([1, [2, [3]]]));
  out.push(JSON.stringify("q"), JSON.stringify(5), JSON.stringify(null), JSON.stringify(true));
  return out.join("|");
}` },
  { name: "labeled-loops-finally", fn: "f", ts: `export function f(): any {
  const out: any = [];
  outer: for (let i = 0; i < 3; i++) {
    inner: for (let j = 0; j < 3; j++) {
      if (j === 2) continue outer;
      if (i === 2) break outer;
      out.push(i + "" + j);
    }
  }
  const g = (): any => { try { return "try"; } finally { out.push("fin"); } };
  out.push(g());
  const h = (): any => { try { throw new Error("x"); } catch (e: any) { return "catch"; } finally { out.push("f2"); } };
  out.push(h());
  return out.join("|");
}` },
  { name: "switch-forms", fn: "f", ts: `function kind(x: any): any {
  switch (x) {
    case 1:
    case 2: return "small";
    case "s": return "str";
    default: return "other";
  }
}
export function f(): any {
  const out: any = [];
  out.push(kind(1), kind(2), kind("s"), kind(99));
  let acc = "";
  for (let i = 0; i < 4; i++) {
    switch (i) { case 0: acc += "a"; break; case 1: acc += "b"; default: acc += "d"; }
  }
  out.push(acc);
  switch (true) { case 1 > 0: out.push("pos"); break; default: out.push("neg"); }
  return out.join("|");
}` },
  { name: "destructuring-advanced", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const { a: x1, b: { c: x2 = 9 } = {}, ...rest } = { a: 1, b: {}, d: 4, e: 5 } as any;
  out.push(x1, x2, JSON.stringify(rest));
  const [p, , q = 7, ...tail] = [1, 2, undefined, 4, 5];
  out.push(p, q, tail.join(","));
  let m = 1, n = 2; [m, n] = [n, m];
  out.push(m, n);
  const { ["k" + 1]: dyn } = { k1: "v1" } as any;
  out.push(dyn);
  const fn = ({ z = 3 }: any = {}) => z;
  out.push(fn(), fn({ z: 8 }));
  return out.join("|");
}` },
  { name: "map-set-full", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const m: any = new Map();
  const keyObj: any = { id: 1 };
  m.set("a", 1).set(keyObj, 2).set(3, "three");
  out.push(m.size, m.get("a"), m.get(keyObj), m.get(3), m.has("zz"));
  m.delete("a");
  out.push(m.size, [...m.keys()].length);
  const s: any = new Set([1, 2, 2, 3]);
  s.add(4).add(1);
  out.push(s.size, [...s].join(","), s.has(2), s.has(9));
  s.delete(1);
  out.push([...s].join(","));
  const m2: any = new Map([["x", 1]]);
  m2.clear();
  out.push(m2.size);
  return out.join("|");
}` },
  { name: "numbers-bitwise", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Number.parseInt("42px"), Number.parseFloat("3.14abc"), Number.isInteger(5), Number.isInteger(5.5));
  out.push(Number.isSafeInteger(9007199254740991), Number.isNaN(NaN), Number.isFinite(Infinity));
  out.push((255).toString(16), (8).toString(2), Number("0x1f"), Number("  12  "));
  out.push(5 & 3, 5 | 2, 5 ^ 1, ~5, 1 << 4, -8 >> 1, -8 >>> 1);
  out.push(3.7 | 0, -3.7 | 0, (1.005).toFixed(2), (1234.5678).toFixed(2));
  out.push(Number.MAX_SAFE_INTEGER > 0, Math.trunc(4.9), Math.sign(-3), Math.cbrt(27));
  return out.join("|");
}` },
  { name: "math-rounding", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Math.round(2.5), Math.round(-2.5), Math.floor(-2.5), Math.ceil(-2.5), Math.trunc(-2.5));
  out.push(Math.min(1, 2, -3), Math.max(1, 2, -3), Math.abs(-7));
  out.push(Math.pow(2, 10), 2 ** 10, Math.sqrt(16), Math.hypot(3, 4));
  out.push(Math.PI.toFixed(5), Math.E > 2.7);
  out.push(Math.round(1.5), Math.round(-1.5), Math.round(0.5));
  return out.join("|");
}` },
  { name: "freeze-seal", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1 };
  Object.freeze(o);
  out.push(Object.isFrozen(o), Object.isSealed(o), Object.isExtensible(o));
  try { o.a = 2; } catch (e: any) { out.push("threw"); }
  out.push(o.a);
  const p: any = { b: 1 };
  Object.seal(p);
  p.b = 2; p.c = 3;
  out.push(p.b, p.c === undefined ? 1 : 0, Object.isSealed(p));
  out.push(Object.isFrozen({}), Object.isSealed({}));
  return out.join("|");
}` },
  { name: "private-fields-static", fn: "f", ts: `class Counter {
  #n: any = 0;
  static #total: any = 0;
  inc(): any { this.#n++; Counter.#total++; return this.#n; }
  get value(): any { return this.#n; }
  static get total(): any { return Counter.#total; }
  has(o: any): any { return #n in o ? 1 : 0; }
}
export function f(): any {
  const out: any = [];
  const c: any = new Counter();
  out.push(c.inc(), c.inc(), c.value, Counter.total);
  out.push(c.has(c), c.has({}));
  const c2: any = new Counter();
  c2.inc();
  out.push(Counter.total, c.value);
  return out.join("|");
}` },
  { name: "symbol-for-iterator", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s1: any = Symbol.for("k");
  const s2: any = Symbol.for("k");
  out.push(s1 === s2, Symbol.keyFor(s1), typeof Symbol("x"));
  const obj: any = {
    data: [1, 2, 3],
    [Symbol.iterator]() {
      let i = 0; const d = this.data;
      return { next: () => (i < d.length ? { value: d[i++], done: false } : { value: undefined, done: true }) };
    }
  };
  out.push([...obj].join(","));
  for (const v of obj) out.push("v" + v);
  const tagged: any = { [Symbol.toStringTag]: "Custom" };
  out.push(Object.prototype.toString.call(tagged));
  return out.join("|");
}` },
  { name: "optional-nullish-assign", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: { b: null }, arr: [1] };
  out.push(o?.a?.b ?? "dflt", o?.x?.y ?? "nope", o.arr?.[0], o.arr?.[5] ?? "none");
  const p: any = null;
  out.push(p?.z, p?.[0], p?.m?.());
  let n: any = null; n ??= 5;
  let m: any = 1; m ||= 9;
  let k: any = 0; k ||= 7;
  let q: any = 2; q &&= 8;
  out.push(n, m, k, q);
  let arr: any = null; arr ??= [1, 2];
  out.push(arr.join(","));
  const fn: any = null;
  out.push(typeof (fn?.()), typeof (() => 1)?.());
  return out.join("|");
}` },
  { name: "array-from-flat", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Array.from("abc").join(","), Array.from([1, 2], (x: any) => x * 2).join(","));
  out.push(Array.from({ length: 3 }, (_: any, i: any) => i).join(","));
  out.push(Array.of(7, 8).join(","));
  out.push([[1, 2], [3]].flat().join(","), [1, [2, [3]]].flat(2).join(","));
  out.push([1, 2, 3].flatMap((x: any) => [x, x * 10]).join(","));
  out.push(Array.isArray([]), Array.isArray({}), Array.isArray("x"));
  const it: any = new Set([1, 2]).values();
  out.push(Array.from(it).join(","));
  return out.join("|");
}` },
  { name: "closure-loop-vars", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const fns: any = [];
  for (let i = 0; i < 3; i++) fns.push(() => i);
  out.push(fns.map((g: any) => g()).join(","));
  const fns2: any = [];
  for (var j = 0; j < 3; j++) fns2.push(() => j);
  out.push(fns2.map((g: any) => g()).join(","));
  let acc = 0;
  const adders: any = [1, 2, 3].map((n: any) => (x: any) => x + n);
  for (const a of adders) acc = a(acc);
  out.push(acc);
  const counters: any = [];
  for (const ch of "ab") { let n = 0; counters.push(() => ch + ++n); }
  out.push(counters[0]() + counters[0]() + counters[1]());
  return out.join("|");
}` },
  { name: "regex-groups", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const re: any = /(\\d+)-(\\d+)/;
  const m: any = re.exec("ab 12-34 cd");
  out.push(m[0], m[1], m[2], m.index);
  out.push(re.test("12-34"), re.test("nope"));
  out.push("a1b2c3".replace(/\\d/g, "#"));
  out.push("2024-01-15".replace(/(\\d+)-(\\d+)-(\\d+)/, "$3/$2/$1"));
  const g: any = "x=1;y=2".matchAll(/(\\w)=(\\d)/g);
  out.push([...g].map((e: any) => e[2]).join(","));
  out.push(/^\\d+$/.test("123"), /^\\d+$/.test("12a"));
  return out.join("|");
}` },
];
