// 差分审计语料（第二批）：覆盖更细的语义角落。
module.exports = [
  { name: "try-catch-finally", fn: "f", ts: `export function f(x: any): any {
  const out: any = [];
  try { if (x) throw new Error("boom" + x); out.push("no-throw"); } catch (e: any) { out.push("catch:" + e.message); } finally { out.push("fin"); }
  return out.join("|");
}`, args: [1] },
  { name: "try-nested-rethrow", fn: "f", ts: `export function f(): any {
  const out: any = [];
  try {
    try { throw "s1"; } catch (e: any) { out.push("in:" + e); throw "s2"; } finally { out.push("fin1"); }
  } catch (e: any) { out.push("out:" + e); }
  return out.join("|");
}` },
  { name: "switch-string", fn: "f", ts: `export function f(s: any): any {
  switch (s) {
    case "a": return 1;
    case "b": case "c": return 2;
    default: return 0;
  }
}`, args: ["c"] },
  { name: "for-of-string", fn: "f", ts: `export function f(): any {
  let out = "";
  const s = "abc";
  for (const ch of s) out += ch + ".";
  return out;
}` },
  { name: "array-chain", fn: "f", ts: `export function f(): any {
  const a = [5, 3, 8, 1, 9, 2];
  const out: any = [];
  out.push(a.filter((x: any) => x > 2).map((x: any) => x * 10).reduce((s: any, x: any) => s + x, 0));
  out.push(a.slice().sort((x: any, y: any) => y - x).join(","));
  out.push(a.find((x: any) => x > 4));
  out.push(a.findIndex((x: any) => x > 4));
  out.push(a.some((x: any) => x > 8) ? 1 : 0);
  out.push(a.every((x: any) => x > 0) ? 1 : 0);
  out.push(a.reduce((s: any, x: any) => s + x));
  out.push(a.slice(1, 3).join(","));
  out.push(a.indexOf(8));
  return out.join("|");
}` },
  { name: "array-splice-push-loop", fn: "f", ts: `export function f(): any {
  const a: any = [];
  for (let i = 0; i < 5; i++) a.push(i * i);
  a.splice(2, 1);
  a[0] = 100;
  return a.join(",") + "|" + a.length;
}` },
  { name: "obj-mutation-nested", fn: "f", ts: `export function f(): any {
  const o: any = { a: { b: [1, 2] }, c: 1 };
  o.a.b.push(3);
  o.c = o.a.b.length;
  const k = "c";
  o[k] = o[k] + 1;
  if (o.a) o.a.d = "x";
  return JSON.stringify(o) + "|" + o.a.b.length;
}` },
  { name: "closure-shared-state", fn: "f", ts: `export function f(): any {
  function makeCounter() {
    let n = 0;
    return { inc: function () { n++; return n; }, get: function () { return n; } };
  }
  const c = makeCounter();
  const out: any = [];
  out.push(c.inc());
  out.push(c.inc());
  out.push(c.get());
  return out.join("|");
}` },
  { name: "this-in-methods", fn: "f", ts: `class P { n: any = 0; constructor(v: any) { this.n = v; } add(k: any): any { this.n = this.n + k; return this.n; } chain(): any { return this.add(1); } }
export function f(): any {
  const p = new P(10);
  const out: any = [];
  out.push(p.add(5));
  out.push(p.chain());
  out.push(p.n);
  return out.join("|");
}` },
  { name: "getter-inheritance", fn: "f", ts: `class A { get v(): any { return 1; } m(): any { return this.v; } }
class B extends A { get v(): any { return 2; } }
export function f(): any { const b = new B(); const a = new A(); return b.v + "|" + a.v + "|" + b.m() + "|" + a.m(); }` },
  { name: "static-and-instance", fn: "f", ts: `class C { static n: any = 1; v: any = 2; static s(): any { return C.n; } inst(): any { return this.v; } }
export function f(): any { const c = new C(); C.n = 5; return C.s() + "|" + c.inst() + "|" + c.v; }` },
  { name: "object-in-object-spread", fn: "f", ts: `export function f(): any {
  const a: any = { x: 1, y: { z: 2 } };
  const b: any = { ...a, w: 3 };
  b.y.z = 9;
  return JSON.stringify(b) + "|" + a.y.z + "|" + JSON.stringify(a);
}` },
  { name: "json-deep", fn: "f", ts: `export function f(): any {
  const obj: any = { list: [{ id: 1, tags: ["a", "b"] }, { id: 2, tags: [] }], meta: { n: 2, ok: true } };
  const s = JSON.stringify(obj);
  const back: any = JSON.parse(s);
  return back.list[0].tags[1] + "|" + back.list.length + "|" + back.meta.n + "|" + (back.meta.ok ? 1 : 0) + "|" + s.length;
}` },
  { name: "string-search-replace", fn: "f", ts: `export function f(): any {
  const s = "a,b,c,d";
  const out: any = [];
  out.push(s.split(",").length);
  out.push(s.split(",").slice(1, 3).join("-"));
  out.push(s.replace(",", ";"));
  out.push(s.indexOf("c"));
  out.push(s.lastIndexOf(","));
  out.push(s.substring(2, 5));
  out.push(s.charAt(s.length - 1));
  out.push(s.toUpperCase().toLowerCase());
  return out.join("|");
}` },
  { name: "num-formatting", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(String(1234.5678));
  out.push((1234.5678).toFixed(2));
  out.push((1234.5678).toFixed(6));
  out.push((0.1 + 0.2).toFixed(17));
  out.push((1e21).toFixed(2));
  out.push((123456789).toString(36));
  out.push(String(-0.5));
  out.push(String(1 / 0));
  out.push(String(-1 / 0));
  out.push(String(NaN));
  out.push((1000000).toLocaleString("en-US"));
  return out.join("|");
}` },
  { name: "math-edges", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Math.floor(-1.5));
  out.push(Math.trunc(-1.5));
  out.push(Math.round(1.5));
  out.push(Math.round(-1.5));
  out.push(Math.pow(2, -1));
  out.push(Math.sqrt(-1) ? "y" : "n");
  out.push(Math.log(1));
  out.push(Math.log2(8));
  out.push(Math.log10(1000));
  out.push(Math.hypot(3, 4));
  out.push(Math.atan2(1, 1).toFixed(4));
  out.push(Math.min(3, -1, 2));
  out.push(Math.max(-3, -1, -2));
  return out.join("|");
}` },
  { name: "bitwise-strings", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("12" | 0);
  out.push((3.9 | 0) + (2.1 & 3));
  out.push(1 << 3 >> 1);
  out.push(7 ^ 3);
  out.push(-1 ^ 0);
  out.push(~0);
  out.push((0xffffffff >>> 0) + 1);
  return out.join("|");
}` },
  { name: "comparisons-mixed", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(("2" > 1) ? 1 : 0);
  out.push((1 < "2") ? 1 : 0);
  out.push((null >= 0) ? 1 : 0);
  out.push((undefined == null) ? 1 : 0);
  out.push((undefined === null) ? 1 : 0);
  out.push((NaN < 1) ? 1 : 0);
  out.push(("" == 0) ? 1 : 0);
  out.push(("b" > "a") ? 1 : 0);
  return out.join("|");
}` },
  { name: "conditional-chains", fn: "f", ts: `export function f(n: any): any {
  const out: any = [];
  out.push(n > 10 ? "big" : n > 5 ? "mid" : "small");
  out.push(n || 5);
  out.push(n && 7);
  const o: any = n ? { a: 1 } : null;
  out.push(o?.a ?? "none");
  out.push(o === null ? "null" : "obj");
  return out.join("|");
}`, args: [3] },
  { name: "while-do-while-break", fn: "f", ts: `export function f(): any {
  let i = 0, out = "";
  while (i < 10) { i++; if (i % 3 === 0) continue; if (i > 7) break; out += i; }
  let j = 0;
  do { j += 2; } while (j < 5);
  return out + "|" + i + "|" + j;
}` },
  { name: "switch-continue-in-loop", fn: "f", ts: `export function f(): any {
  let out = "";
  for (let i = 0; i < 5; i++) {
    switch (i) {
      case 0: out += "z"; break;
      case 1: continue;
      case 2: out += "t"; break;
      default: out += "d";
    }
    out += "-";
  }
  return out;
}` },
  { name: "destructure-swap-and-nested-obj", fn: "f", ts: `export function f(): any {
  let a = 1, b = 2;
  [a, b] = [b, a];
  const o: any = { p: { q: 5 } };
  const { p } = o;
  const arr: any = [[1, 2], [3, 4]];
  const [first] = arr;
  return a + "|" + b + "|" + p.q + "|" + first[1];
}` },
  { name: "string-concat-loop", fn: "f", ts: `export function f(): any {
  let s = "";
  for (let i = 0; i < 20; i++) s += i % 10;
  const parts: any = [];
  for (let i = 0; i < 5; i++) parts.push("x" + i);
  return s + "|" + parts.join("") + "|" + s.length;
}` },
  { name: "map-index-usage", fn: "f", ts: `export function f(): any {
  const a = ["a", "b", "c"];
  return a.map((v: any, i: any) => v + i).join("-") + "|" + a.filter((v: any, i: any) => i > 0).length;
}` },
  { name: "reduce-acc-object", fn: "f", ts: `export function f(): any {
  const a = [1, 2, 3, 4];
  const sum = a.reduce((acc: any, x: any) => acc + x, 0);
  const max = a.reduce((acc: any, x: any) => x > acc ? x : acc, -Infinity);
  const joined = a.reduce((acc: any, x: any) => acc + String(x), "");
  return sum + "|" + max + "|" + joined;
}` },
  { name: "recursion-memo", fn: "f", ts: `export function f(n: any): any {
  const memo: any = {};
  function fib(k: any): any {
    if (k < 2) return k;
    if (memo[k] !== undefined) return memo[k];
    const v = fib(k - 1) + fib(k - 2);
    memo[k] = v;
    return v;
  }
  return fib(n);
}`, args: [25] },
  { name: "classes-array-of-instances", fn: "f", ts: `class Item { name: any; price: any; constructor(n: any, p: any) { this.name = n; this.price = p; } total(k: any): any { return this.price * k; } }
export function f(): any {
  const items: any = [new Item("a", 2), new Item("b", 3)];
  let sum = 0;
  for (const it of items) sum += it.total(2);
  return items.map((x: any) => x.name).join(",") + "|" + sum + "|" + items.length;
}` },
  { name: "type-coercion-table", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(1 + true);
  out.push("1" + true);
  out.push([] + 1);
  out.push([1, 2] + "");
  out.push({} + "");
  out.push(!!"0" ? 1 : 0);
  out.push(!"0" ? 1 : 0);
  out.push(+true);
  out.push(+"12px" ? 1 : 0);
  out.push(+"12");
  return out.join("|");
}` },
  { name: "delete-and-in", fn: "f", ts: `export function f(): any {
  const o: any = { a: 1, b: 2 };
  const out: any = [];
  out.push(("a" in o) ? 1 : 0);
  out.push(delete o.a ? 1 : 0);
  out.push(("a" in o) ? 1 : 0);
  out.push(Object.keys(o).join(","));
  const a: any = [1, 2, 3];
  out.push(delete a[1] ? 1 : 0);
  out.push(a.length);
  return out.join("|");
}` },
  { name: "optional-call-and-method", fn: "f", ts: `export function f(o: any): any {
  const out: any = [];
  out.push(o.list?.length ?? -1);
  out.push(o.list ? o.list.length : -2);
  out.push(o.missing?.length ?? "x");
  out.push(typeof o.list);
  out.push(o["list"] ? 1 : 0);
  return out.join("|");
}`, args: [{ list: [1, 2, 3] }] },
  { name: "string-edge-empty", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("".length);
  out.push("".toUpperCase());
  out.push("" + 1);
  out.push("".split("").length);
  out.push(("".charAt(0) === "") ? 1 : 0);
  out.push("abc".slice(10).length);
  out.push("abc".substring(2, 1));
  return out.join("|");
}` },
  { name: "array-edge-cases", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [];
  out.push(a.length);
  out.push(a.join(","));
  a.push(1);
  out.push(a[5] === undefined ? 1 : 0);
  out.push(a.length);
  const b: any = [1, 2, 3];
  out.push(b.slice(-2).join(","));
  out.push(b.slice(0).length);
  out.push(b.concat().length);
  b.length = 1;
  out.push(b.join(","));
  return out.join("|");
}` },
  { name: "nested-ternary-obj", fn: "f", ts: `export function f(x: any): any {
  const r: any = x > 0 ? { sign: 1 } : x < 0 ? { sign: -1 } : { sign: 0 };
  return r.sign + "|" + (r.sign === 0 ? "zero" : r.sign > 0 ? "pos" : "neg");
}`, args: [-5] },
  { name: "iife-module-pattern", fn: "f", ts: `export function f(): any {
  const mod = (function () { let n = 0; return { add: function (k: any) { n += k; return n; }, get: function () { return n; } }; })();
  mod.add(3);
  mod.add(4);
  return mod.get();
}` },
  { name: "global-func-passed", fn: "f", ts: `export function f(): any {
  const a = [3, 1, 2];
  function cmp(x: any, y: any): any { return x - y; }
  return a.slice().sort(cmp).join(",") + "|" + a.map(function (x: any) { return x * 2; }).join(",");
}` },
  { name: "typeof-fn-local", fn: "f", ts: `export function f(): any {
  function g(x: any) { return x; }
  const h = (x: any) => x;
  return typeof g + "|" + typeof h + "|" + (typeof g === "function" ? 1 : 0);
}` },
  { name: "arg-default-and-undefined", fn: "f", ts: `export function f(): any {
  function g(a: any, b: any) { return b === undefined ? "U" : "" + a + b; }
  const out: any = [];
  out.push(g(1));
  out.push(g(1, 2));
  out.push(g(1, undefined));
  out.push(g(1, null));
  return out.join("|");
}` },
  { name: "large-array-push", fn: "f", ts: `export function f(): any {
  const a: any = [];
  for (let i = 0; i < 300; i++) a.push(i);
  let s = 0;
  for (let i = 0; i < a.length; i += 100) s += a[i];
  return a.length + "|" + s + "|" + a[299];
}` },
  { name: "object-keys-order-mixed", fn: "f", ts: `export function f(): any {
  const o: any = {};
  o.b = 1; o.a = 2; o[3] = 3;
  return Object.keys(o).join(",") + "|" + Object.values(o).join(",");
}` },
  { name: "map-set-unsupported-probe", fn: "f", ts: `export function f(): any {
  const a = [1, 2, 3, 4];
  return a.filter(function (x: any) { return x % 2 === 0; }).length;
}` },
];
