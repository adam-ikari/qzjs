// 差分审计语料（第五批）：容器深用 / 展开位置 / 类静态继承 / 错误传播 / JSON 边界 / 数字格式 / 求值顺序。
module.exports = [
  // ---------- 容器深用 ----------
  { name: "map-ops", fn: "f", ts: `export function f(): any {
  const m: any = new Map();
  m.set(1, "a"); m.set(2, "b");
  const out: any = [];
  out.push(m.size);
  out.push(m.get(1));
  m.delete(1);
  out.push(m.size, m.has(1) ? 1 : 0);
  m.clear();
  out.push(m.size);
  const arr: any = [];
  m.forEach ? m.forEach((v: any, k: any) => { arr.push(k + ":" + v); }) : 0;
  out.push(arr.length);
  return out.join("|");
}` },
  { name: "set-ops", fn: "f", ts: `export function f(): any {
  const s: any = new Set();
  s.add(1); s.add(2); s.add(2);
  const out: any = [];
  out.push(s.size);
  out.push(s.has(2) ? 1 : 0);
  s.delete(2);
  out.push(s.size);
  const vals: any = [];
  for (const v of s.values()) vals.push(v);
  out.push(vals.join(","));
  return out.join("|");
}` },
  { name: "array-from-string", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Array.from("abc").join("-"));
  out.push(Array.from([1, 2], (x: any) => x * 2).join(","));
  out.push(Array.from({ length: 3 }, (v: any, i: any) => i).join(","));
  return out.join("|");
}` },
  { name: "nested-container", fn: "f", ts: `export function f(): any {
  const m: any = new Map();
  const arr: any = [1, 2];
  m.set("k", arr);
  const got: any = m.get("k");
  got.push(3);
  return JSON.stringify(m.get("k")) + "|" + arr.length + "|" + m.size;
}` },
  // ---------- 展开位置 ----------
  { name: "spread-in-array-nested", fn: "f", ts: `export function f(): any {
  const a: any = [1, 2];
  const b: any = [...a, ...[3, 4], 5];
  const c: any = [[...a], a];
  return b.join(",") + "|" + c[0].join(",") + "|" + c[1].length + "|" + (c[0] === c[1] ? 1 : 0);
}` },
  { name: "spread-object-deep", fn: "f", ts: `export function f(): any {
  const base: any = { a: { x: 1 }, b: 2 };
  const o: any = { ...base };
  o.a.x = 9;
  o.c = 3;
  return base.a.x + "|" + Object.keys(o).sort().join(",") + "|" + (o.b === base.b ? 1 : 0);
}` },
  { name: "spread-call-mixed", fn: "f", ts: `export function f(): any {
  function g(...xs: any) { return xs.length + ":" + xs.join(","); }
  const a: any = [2, 3];
  const out: any = [];
  out.push(g(...a));
  out.push(g(1, ...a, 4));
  out.push(g(...[], 9));
  return out.join("|");
}` },
  // ---------- 类静态继承 / 求值顺序 ----------
  { name: "static-inherit-chain", fn: "f", ts: `class A { static v: any = 1; static get v2(): any { return this === undefined ? -1 : A.v * 2; } static m(): any { return "A"; } }
class B extends A { static m(): any { return "B" + A.m(); } }
class C extends B { }
export function f(): any {
  const out: any = [];
  out.push(A.v, C.v);
  out.push(B.m(), C.m());
  C.v = 5;
  out.push(A.v, C.v);
  return out.join("|");
}` },
  { name: "eval-order-call", fn: "f", ts: `export function f(): any {
  const log: any = [];
  function t(x: any) { log.push("t" + x); return x; }
  function c(a: any, b: any, d: any) { log.push("c"); return a + b + d; }
  const v = c(t(1), t(2), t(3));
  return v + "|" + log.join(",");
}` },
  { name: "eval-order-member", fn: "f", ts: `export function f(): any {
  const log: any = [];
  const o: any = { n: 1, get v() { log.push("getv"); return this.n * 2; }, set v(x: any) { log.push("setv" + x); this.n = x; } };
  const r = o.v + (o.v = 5) + o.v;
  return r + "|" + o.n + "|" + log.join(",");
}` },
  { name: "eval-order-mixed", fn: "f", ts: `export function f(): any {
  const log: any = [];
  let i = 0;
  const o: any = { a: [1, 2, 3] };
  const v = o.a[i++] + o.a[i++] * 10;
  return v + "|" + i + "|" + o.a.length;
}` },
  // ---------- 错误传播 ----------
  { name: "error-propagate-nested", fn: "f", ts: `export function f(): any {
  function inner() { throw new Error("deep"); }
  function middle() { inner(); }
  const out: any = [];
  try { middle(); } catch (e: any) { out.push("caught:" + e.message); }
  try { middle(); } finally { out.push("fin"); }
  return out.join("|");
}` },
  { name: "error-in-ctor", fn: "f", ts: `class C { constructor(v: any) { if (!v) throw new Error("need v"); this.v = v; } v: any; }
export function f(): any {
  const out: any = [];
  try { const c = new C(0); out.push("ok" + c.v); } catch (e: any) { out.push("err:" + e.message); }
  const good = new C(5);
  out.push("v" + good.v);
  return out.join("|");
}` },
  { name: "error-rethrow-loop", fn: "f", ts: `export function f(): any {
  const out: any = [];
  for (let i = 0; i < 3; i++) {
    try { if (i === 1) throw new Error("e" + i); out.push("t" + i); }
    catch (e: any) { out.push("c" + e.message); continue; }
    finally { out.push("f" + i); }
    out.push("after" + i);
  }
  return out.join("|");
}` },
  // ---------- JSON / 物化 ----------
  { name: "json-array-objects", fn: "f", ts: `class R { id: any; tags: any; constructor(i: any, t: any) { this.id = i; this.tags = t; } }
export function f(): any {
  const rows: any = [new R(1, ["a"]), new R(2, [])];
  const s = JSON.stringify(rows);
  const back: any = JSON.parse(s);
  return s + "|" + back.length + "|" + back[0].tags[0] + "|" + back[1].tags.length;
}` },
  { name: "json-numbers", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(JSON.stringify([1, 1.5, -0, NaN, Infinity, 1e21]));
  out.push(JSON.stringify({ a: undefined, b: function () { return 1; } }));
  out.push(JSON.stringify("\\u00e9"));
  out.push(JSON.stringify(true), JSON.stringify(null));
  return out.join("|");
}` },
  { name: "json-nested-arrays", fn: "f", ts: `export function f(): any {
  const v: any = { m: [[1, 2], [3, [4, 5]]], n: { o: { p: 6 } } };
  const s = JSON.stringify(v);
  const back: any = JSON.parse(s);
  return s + "|" + back.m[1][1][0] + "|" + back.n.o.p + "|" + back.m[0].length;
}` },
  { name: "obj-keys-instance-vs-pojo", fn: "f", ts: `class C { a: any = 1; m(): any { return 2; } }
export function f(): any {
  const c = new C();
  const p: any = { a: 1, m: 2 };
  const out: any = [];
  out.push(Object.keys(c).sort().join(","));
  out.push(Object.keys(p).sort().join(","));
  out.push(JSON.stringify(c));
  out.push(JSON.stringify(p));
  return out.join("|");
}` },
  // ---------- 数字 / 字符串格式 ----------
  { name: "num-format-more", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push((1234.5678).toFixed(0));
  out.push((0.5).toFixed(0));
  out.push((1.005).toFixed(2));
  out.push((1e-7).toString());
  out.push((1e21).toExponential());
  out.push((255).toString(36));
  out.push((0.1).toPrecision(1));
  out.push(String(-0));
  out.push((1000000).toLocaleString ? "y" : "n");
  out.push(String(1.23456789012345678));
  return out.join("|");
}` },
  { name: "string-methods-more", fn: "f", ts: `export function f(): any {
  const s = "Hello World";
  const out: any = [];
  out.push(s.split("").length);
  out.push(s.split(" ").length);
  out.push(s.slice(-3));
  out.push(s.substring(0, 0));
  out.push(s.replace("l", "L"));
  out.push(s.replaceAll ? s.replaceAll("l", "L") : "n/a");
  out.push(s.split(" ").map((w: any) => w.charAt(0)).join(""));
  out.push("  x  ".trim().length);
  out.push(s.indexOf("W", 3));
  return out.join("|");
}` },
  { name: "array-methods-more2", fn: "f", ts: `export function f(): any {
  const a = [5, 1, 4, 2];
  const out: any = [];
  out.push(a.slice().sort((x: any, y: any) => x - y).join(","));
  out.push(a.findIndex((x: any) => x === 4));
  out.push(a.filter((x: any) => x > 2).length);
  out.push(a.map((x: any) => x + 1).reduce((s: any, x: any) => s * x, 1));
  out.push(a.includes(4) ? 1 : 0);
  out.push(a.indexOf(2), a.lastIndexOf(5));
  const b: any = a.slice();
  b.length = 2;
  out.push(b.join(","));
  return out.join("|");
}` },
  { name: "destructure-nested-default", fn: "f", ts: `export function f(): any {
  const { a: { b = 5 } = {} }: any = {};
  const { x = { y: 1 } }: any = {};
  const [p = [1, 2]]: any = [];
  const out: any = [];
  out.push(b, x.y, p.length);
  const data: any = { list: [{ v: 1 }, { v: 2 }] };
  const { list: [{ v: first }] } = data;
  out.push(first);
  return out.join("|");
}` },
  { name: "closures-in-objects", fn: "f", ts: `export function f(): any {
  function make(n: any) {
    return {
      get: function () { return n; },
      add: function (k: any) { n += k; return n; },
      list: [function () { return n * 2; }]
    };
  }
  const a = make(1), b = make(10);
  a.add(1);
  return a.get() + "|" + b.get() + "|" + a.list[0]() + "|" + b.list[0]();
}` },
  { name: "this-in-object-method-chain", fn: "f", ts: `export function f(): any {
  const o: any = {
    v: 0,
    inc() { this.v++; return this; },
    val() { return this.v; }
  };
  return o.inc().inc().val() + "|" + o.v;
}` },
  { name: "ternary-chain-types", fn: "f", ts: `export function f(x: any): any {
  const out: any = [];
  out.push(typeof (x > 0 ? "p" : x < 0 ? -1 : null));
  out.push(x > 0 ? [1] : { a: 1 });
  const y: any = x > 0 ? 1 : "s";
  out.push(y + 1);
  return out.join("|");
}`, args: [5] },
  { name: "while-closure-and-mutation", fn: "f", ts: `export function f(): any {
  const handlers: any = [];
  let n = 0;
  while (n < 3) {
    const local = n;
    handlers.push(function () { return local + ":" + n; });
    n++;
  }
  return handlers.map((h: any) => h()).join(",");
}` },
  { name: "recursive-object-build", fn: "f", ts: `export function f(): any {
  function build(depth: any): any {
    if (depth === 0) return { leaf: true };
    return { child: build(depth - 1), depth: depth };
  }
  const t = build(3);
  return JSON.stringify(t);
}` },
  { name: "string-num-concat-loop", fn: "f", ts: `export function f(): any {
  let s = "";
  for (let i = 0; i < 5; i++) s += i + ",";
  const parts: any = [];
  for (let i = 0; i < 3; i++) parts.push("p" + i);
  return s + "|" + parts.join("/") + "|" + s.length;
}` },
];
