// 差分审计语料（第四批）：容器/类细节/可选调用/强制转换/错误/数字字符串边界。
module.exports = [
  // ---------- 容器（宿主内建） ----------
  { name: "map-basic", fn: "f", ts: `export function f(): any {
  const m: any = new Map();
  m.set("a", 1); m.set("b", 2);
  const out: any = [];
  out.push(m.get("a"));
  out.push(m.has("c") ? 1 : 0);
  out.push(m.size);
  m.delete("a");
  out.push(m.size);
  out.push(m.get("missing") === undefined ? 1 : 0);
  return out.join("|");
}` },
  { name: "set-basic", fn: "f", ts: `export function f(): any {
  const s: any = new Set([1, 2, 2, 3]);
  const out: any = [];
  out.push(s.size);
  out.push(s.has(2) ? 1 : 0);
  s.add(4);
  out.push(s.size);
  return out.join("|");
}` },
  { name: "map-iterate", fn: "f", ts: `export function f(): any {
  const m: any = new Map(); m.set("a", 1); m.set("b", 2);
  const out: any = [];
  for (const k of m.keys()) out.push(k);
  for (const [k, v] of m) out.push(k + "=" + v);
  return out.join(",");
}` },
  { name: "array-from-map", fn: "f", ts: `export function f(): any {
  const m: any = new Map([["x", 1], ["y", 2]]);
  return Array.from(m.keys()).join(",") + "|" + Array.from(m.values()).join(",");
}` },
  { name: "date-basic", fn: "f", ts: `export function f(): any {
  const d: any = new Date(0);
  const out: any = [];
  out.push(typeof d);
  out.push(d instanceof Date ? 1 : 0);
  out.push(d.getTime ? 1 : 0);
  return out.join("|");
}` },
  { name: "error-throw-typed", fn: "f", ts: `export function f(): any {
  const out: any = [];
  try { throw new TypeError("bad"); } catch (e: any) {
    out.push(e instanceof TypeError ? 1 : 0);
    out.push(e instanceof Error ? 1 : 0);
    out.push(e.message);
    out.push(e.name);
  }
  return out.join("|");
}` },
  { name: "error-custom-class", fn: "f", ts: `class MyErr extends Error { constructor(m: any) { super(m); } }
export function f(): any {
  const out: any = [];
  try { throw new MyErr("x1"); } catch (e: any) { out.push(e.message); out.push(e.name); }
  return out.join("|");
}` },
  // ---------- 类细节 ----------
  { name: "class-private-field", fn: "f", ts: `class C { #v: any = 1; get v(): any { return this.#v; } inc(): any { this.#v++; return this.#v; } }
export function f(): any { const c = new C(); return c.v + "|" + c.inc() + "|" + c.v; }` },
  { name: "class-static-block", fn: "f", ts: `class C { static v: any = 1; static { C.v = 7; } }
export function f(): any { return C.v; }` },
  { name: "class-tojson", fn: "f", ts: `class P { a: any = 1; toJSON(): any { return { wrapped: this.a }; } }
export function f(): any { const p = new P(); return JSON.stringify(p) + "|" + JSON.stringify({ p: p }); }` },
  { name: "class-valueof-plus", fn: "f", ts: `class N { v: any; constructor(v: any) { this.v = v; } valueOf(): any { return this.v * 2; } toString(): any { return "N" + this.v; } }
export function f(): any { const n = new N(5); const out: any = []; out.push(n + 1); out.push("" + n); out.push(String(n)); return out.join("|"); }` },
  { name: "class-obj-keys", fn: "f", ts: `class C { a: any = 1; b: any = 2; m(): any { return 3; } }
export function f(): any { const c = new C(); return JSON.stringify(c) + "|" + Object.keys(c).join(",") + "|" + ("a" in c ? 1 : 0); }` },
  { name: "class-method-ref", fn: "f", ts: `class C { v: any = 3; get(): any { return this.v; } }
export function f(): any { const c = new C(); const out: any = []; out.push(typeof c.get); out.push(c.get()); return out.join("|"); }` },
  { name: "class-inherit-static-inherit", fn: "f", ts: `class A { static kind(): any { return "A"; } static who(): any { return this.kind ? "this" : "no-this"; } }
class B extends A { static kind(): any { return "B"; } }
export function f(): any { return A.kind() + "|" + B.kind(); }` },
  { name: "class-super-prop", fn: "f", ts: `class A { x: any = 1; get v(): any { return 10; } }
class B extends A { x: any = 2; get v(): any { return super.v + this.x; } }
export function f(): any { const b = new B(); return b.v + "|" + b.x; }` },
  // ---------- 可选调用 / 展开 ----------
  { name: "opt-call-fn2", fn: "f", ts: `export function f(o: any): any {
  const out: any = [];
  out.push(typeof o?.cb);
  out.push(o?.cb ? "has" : "none");
  if (o && typeof o.cb === "function") out.push(o.cb(2));
  return out.join("|");
}`, args: [{ cb: function (x) { return x * 3; } }] },
  { name: "new-spread", fn: "f", ts: `class P { a: any; b: any; constructor(x: any, y: any) { this.a = x; this.b = y; } }
export function f(): any {
  const args: any = [1, 2];
  const p = new P(...args);
  const q = new P(...[3, 4]);
  return p.a + "|" + p.b + "|" + q.a + "|" + q.b;
}` },
  { name: "template-nested", fn: "f", ts: `export function f(): any {
  const a = 1;
  const s = \`x\${a > 0 ? \`pos\${a}\` : "neg"}\${[1, 2].length}\`;
  return s + "|" + \`\${"nested \`" + "q" + "\`"}\`;
}` },
  { name: "tagged-template", fn: "f", ts: `export function f(): any {
  function tag(strings: any, v: any) { return strings[0] + "-" + v + "-" + strings[1]; }
  return tag\`a\${1}b\`;
}` },
  { name: "spread-object-in-call", fn: "f", ts: `export function f(): any {
  function g(o: any) { return o.a + "|" + o.b; }
  const base: any = { a: 1 };
  return g({ ...base, b: 2 });
}` },
  // ---------- 强制转换 / 数字字符串 ----------
  { name: "coerce-obj-primitive", fn: "f", ts: `export function f(): any {
  const o: any = { a: 1 };
  const out: any = [];
  out.push(String(o));
  out.push(Number(o) === Number.NaN ? "nan" : "num");
  out.push(!!o ? 1 : 0);
  out.push([1, 2].toString());
  out.push([1, 2] + "");
  out.push([] + []);
  return out.join("|");
}` },
  { name: "num-parse-edge", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Number(""));
  out.push(Number("  "));
  out.push(Number("0x10"));
  out.push(Number("1e3"));
  out.push(Number(null));
  out.push(Number(undefined));
  out.push(parseInt(""));
  out.push(parseFloat(".5"));
  out.push(parseFloat("1e2"));
  out.push((0.1 + 0.2 === 0.3) ? 1 : 0);
  out.push(1e21 + 1);
  out.push((123.456).toFixed(1));
  out.push((-0).toString());
  out.push((1 / 3).toPrecision(3));
  return out.join("|");
}` },
  { name: "num-bit-edge2", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(2147483647 + 1 | 0);
  out.push(-2147483648 - 1 | 0);
  out.push(0.9 | 0);
  out.push(-0.9 | 0);
  out.push(Infinity | 0);
  out.push(1.5 << 1);
  out.push(3.7 >>> 0);
  out.push(0x7fffffff << 1);
  return out.join("|");
}` },
  { name: "str-escapes", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("a\\tb".length);
  out.push("a\\nb".charCodeAt(1));
  out.push("\\u0041");
  out.push("\\x41");
  out.push("\\\\".length);
  out.push("q\\"z".length);
  out.push("caf\\u00e9".length);
  return out.join("|");
}` },
  { name: "str-compare-sort", fn: "f", ts: `export function f(): any {
  const a = ["b", "a", "C", "10", "2"];
  const out: any = [];
  out.push(a.slice().sort().join(","));
  out.push(a.slice().sort((x: any, y: any) => x.length - y.length).join(","));
  out.push("b" > "a" ? 1 : 0);
  out.push("2" > "10" ? 1 : 0);
  return out.join("|");
}` },
  { name: "json-nested-classes", fn: "f", ts: `class Row { id: any; tags: any; constructor(i: any, t: any) { this.id = i; this.tags = t; } }
export function f(): any {
  const rows: any = [new Row(1, ["a"]), new Row(2, [])];
  const s = JSON.stringify(rows);
  const back: any = JSON.parse(s);
  return s + "|" + back.length + "|" + back[0].tags[0];
}` },
  { name: "closure-this-arrow-method", fn: "f", ts: `class C { v: any = 5; make(): any { const g = () => this.v; return g(); } make2(): any { const self = this; const g2 = function () { return self.v + 1; }; return g2(); } }
export function f(): any { const c = new C(); return c.make() + "|" + c.make2(); }` },
  { name: "object-methods-this", fn: "f", ts: `export function f(): any {
  const counter: any = { n: 0, add(k: any) { this.n += k; return this; }, get() { return this.n; } };
  counter.add(2).add(3);
  return counter.get() + "|" + counter.n;
}` },
  { name: "destructure-param-default-obj", fn: "f", ts: `export function f(): any {
  function g({ a = 1, b = { c: 2 } }: any = {}) { return a + "|" + b.c; }
  const out: any = [];
  out.push(g());
  out.push(g({ a: 5 }));
  out.push(g({ a: 5, b: { c: 9 } }));
  return out.join(",");
}` },
  { name: "arr-of-arr-mutation", fn: "f", ts: `export function f(): any {
  const m: any = [[1, 2], [3]];
  m[0].push(9);
  m[1][0] = 30;
  return JSON.stringify(m) + "|" + m.length + "|" + m[0].length;
}` },
  { name: "string-json-special", fn: "f", ts: `export function f(): any {
  const o: any = { s: "a\\"b\\\\c\\nd", t: "tab\\there", u: "\\u00e9" };
  const j = JSON.stringify(o);
  const back: any = JSON.parse(j);
  return j.length + "|" + back.s.length + "|" + back.t.charAt(3) + "|" + back.u;
}` },
  { name: "mixed-ops-precedence", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(1 + 2 * 3);
  out.push((1 + 2) * 3);
  out.push(2 ** 3 ** 2);
  out.push(-2 ** 2);
  out.push(1 - -1);
  out.push(!0 + 1);
  out.push(typeof void 0);
  out.push(1 < 2 === true ? 1 : 0);
  out.push((1, 2, 3));
  return out.join("|");
}` },
  { name: "switch-numeric-and-default-order", fn: "f", ts: `export function f(x: any): any {
  let out = "";
  switch (x) {
    default: out += "d";
    case 1: out += "1"; break;
    case 2: out += "2"; break;
  }
  return out;
}`, args: [1] },
  { name: "do-while-continue", fn: "f", ts: `export function f(): any {
  let i = 0, out = "";
  do { i++; if (i % 2 === 0) continue; out += i; } while (i < 6);
  return out + "|" + i;
}` },
  { name: "labeled-block-break", fn: "f", ts: `export function f(): any {
  let out = "";
  outer: { out += "a"; if (out) break outer; out += "b"; }
  out += "|";
  inner: for (let i = 0; i < 2; i++) { for (let j = 0; j < 2; j++) { if (j === 1) continue inner; out += i + "" + j; } }
  return out;
}` },
  { name: "try-finally-no-catch", fn: "f", ts: `export function f(): any {
  const out: any = [];
  try { out.push("t"); } finally { out.push("f"); }
  function g() { try { return 1; } finally { out.push("g"); } }
  out.push(g());
  return out.join("|");
}` },
  { name: "array-methods-chain-complex", fn: "f", ts: `export function f(): any {
  const users: any = [{ n: "a", age: 30 }, { n: "b", age: 20 }, { n: "c", age: 40 }];
  return users
    .filter((u: any) => u.age >= 30)
    .sort((x: any, y: any) => y.age - x.age)
    .map((u: any) => u.n + ":" + u.age)
    .join(" | ");
}` },
  { name: "obj-spread-merge-order", fn: "f", ts: `export function f(): any {
  const a: any = { x: 1, y: 2 };
  const b: any = { y: 3, z: 4 };
  const c: any = { ...a, ...b };
  const d: any = { ...b, ...a };
  return JSON.stringify(c) + "|" + JSON.stringify(d) + "|" + c.y + "|" + d.y;
}` },
];
