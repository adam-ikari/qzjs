// 差分审计语料（第十九批）：格式化输出 / 数组边角 / 对象工具 / Date·RegExp·JSON 细节 / try-finally / 继承中的 this。
module.exports = [
  { name: "number-formatting", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const n: any = 1234.5678;
  out.push(n.toFixed(2), n.toFixed(0), n.toFixed(5));
  out.push((0.5).toFixed(0), (1.005).toFixed(2));
  out.push(n.toPrecision(4), n.toExponential(2), n.toExponential());
  out.push((255).toString(16), (255).toString(2), (255).toString(8));
  out.push((-7).toString(2), (0).toString(16));
  out.push(String(1e21), String(1e-7), String(-0));
  return out.join("|");
}` },
  { name: "string-formatting", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("5".padStart(3, "0"), "5".padEnd(3, "x"), "abcdef".padStart(4));
  out.push("a-b-c".replaceAll("-", "+"));
  out.push("x".repeat(3), "x".repeat(0));
  out.push("ABC".toLowerCase(), "abc".toUpperCase());
  out.push("  pad  ".trim(), "  pad  ".trimStart() + "|", "x".concat("y", "z"));
  out.push("a,b,,c".split(",").length, "a,b,,c".split(",").join("/"));
  out.push("abc".at(-1), "abc".at(1), "abc".charCodeAt(0), String.fromCharCode(65, 66));
  return out.join("|");
}` },
  { name: "array-edge-methods", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [1, [2, [3, [4]]]];
  out.push(JSON.stringify(a.flat()), JSON.stringify(a.flat(2)));
  out.push(JSON.stringify([1, 2].flatMap((x: any) => [x, x * 10])));
  out.push([1, 2, 3, 4].copyWithin ? JSON.stringify([1, 2, 3, 4].fill(0, 1, 3)) : "na");
  out.push([1, 2, 3].reduceRight((acc: any, v: any) => acc + "-" + v));
  out.push([1, 2, 3, 4].findLast ? [1, 2, 3, 4].findLast((v: any) => v % 2 === 1) : "na");
  out.push(JSON.stringify([3, 1, 2].sort()), JSON.stringify([10, 9, 1].sort()));
  out.push(JSON.stringify([1, 2].concat(3, [4])), [1, 2, 3].indexOf(2), [1, 2, 3].lastIndexOf(1));
  return out.join("|");
}` },
  { name: "object-utils", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(JSON.stringify(Object.fromEntries([["a", 1], ["b", 2]])));
  out.push(Object.is(NaN, NaN) ? 1 : 0, Object.is(0, -0) ? 1 : 0, Object.is(1, 1) ? 1 : 0);
  const o: any = Object.assign({}, { a: 1 }, { b: 2 }, { a: 3 });
  out.push(JSON.stringify(o), Object.keys(o).join(","));
  out.push(Object.values({ x: 1, y: 2 }).join(","));
  out.push(Object.entries({ k: 9 })[0].join(":"), Object.getOwnPropertyNames({ q: 1 }).join(","));
  out.push(JSON.stringify(Object.freeze({ f: 1 })));
  return out.join("|");
}` },
  { name: "date-details", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const d: any = new Date(1700000000000);
  out.push(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
  out.push(d.getTime(), d.toISOString());
  out.push(d.getDay(), d.getUTCDay());
  const d2: any = new Date(d.getTime() + 86400000);
  out.push(Math.round((d2.getTime() - d.getTime()) / 3600000));
  out.push(new Date(0).toISOString(), new Date(86400000).toISOString());
  out.push(d.getTimezoneOffset() === -d.getTimezoneOffset() ? "tz" : "tz-ok");
  return out.join("|");
}` },
  { name: "regexp-details", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const re: any = /(\\d+)-(\\d+)/;
  const m: any = re.exec("ab 12-34 cd");
  out.push(m[0], m[1], m[2], m.index);
  out.push(re.test("12-34") ? 1 : 0, re.test("nope") ? 1 : 0);
  const g: any = /(\\w)(\\d)/g;
  const found: any = [];
  let mm: any = g.exec("a1 b2");
  while (mm) { found.push(mm[0]); mm = g.exec("a1 b2"); }
  out.push(found.join(","));
  out.push("a1 b2".match(/\\w\\d/g)!.join(","));
  out.push("x=1,y=2".split(/[,=]/).join("|"));
  out.push("aaa".split("a").length, /^a+$/.test("aaa") ? 1 : 0);
  return out.join("|");
}` },
  { name: "json-details", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(JSON.stringify({ b: 1, a: [1, 2], c: { d: null } }));
  out.push(JSON.stringify({ u: undefined, f: () => 1, n: 1 }));
  out.push(JSON.stringify([undefined, () => 1, NaN, Infinity]));
  out.push(JSON.stringify({ nested: { deep: { v: 3 } } }));
  out.push(JSON.parse("{\\"a\\":1,\\"b\\":2}").b, JSON.parse("[1,2,3]")[2]);
  out.push(JSON.stringify("q\\"uote"));
  return out.join("|");
}` },
  { name: "tagged-template-fn", fn: "f", ts: `function tag(strings: any, ...vals: any[]): any {
  let r = "";
  for (let i = 0; i < strings.length; i++) { r += strings[i]; if (i < vals.length) r += "[" + vals[i] + "]"; }
  return r;
}
function upper(strings: any, ...vals: any[]): any { return strings.join("").toUpperCase() + ":" + vals.length; }
export function f(): any {
  const out: any = [];
  const a = 1, b = "x";
  out.push(tag\`p\${a}q\${b}r\`);
  out.push(upper\`ab\${1}cd\${2}ef\`);
  out.push(tag\`no\`);
  return out.join("|");
}` },
  { name: "class-inherit-accessors", fn: "f", ts: `class A { _v: any = 1; get v(): any { return this._v; } set v(x: any) { this._v = x * 2; } }
class B extends A { get v(): any { return super.v + 10; } set v(x: any) { super.v = x; } }
export function f(): any {
  const out: any = [];
  const b = new B();
  out.push(b.v);
  b.v = 5;
  out.push(b.v, b._v);
  const a: any = new A();
  a.v = 3;
  out.push(a.v, a._v);
  return out.join("|");
}` },
  { name: "try-finally-return", fn: "f", ts: `export function f(): any {
  const out: any = [];
  function g(): any { try { return "t"; } finally { out.push("fin"); } }
  out.push(g());
  function h(): any { try { throw new Error("e"); } catch { return "c"; } finally { out.push("f2"); } }
  out.push(h());
  function k(): any { try { return 1; } finally { return 2; } }
  out.push(k());
  const seq: any = [];
  try { seq.push("a"); } catch { seq.push("x"); } finally { seq.push("b"); }
  out.push(seq.join(""));
  return out.join("|");
}` },
  { name: "while-let-closure", fn: "f", ts: `export function f(): any {
  const fns: any = [];
  let i = 0;
  while (i < 3) { const j = i * 2; fns.push(() => j); i++; }
  const out: any = [fns.map((g: any) => g()).join(",")];
  const fns2: any = [];
  for (const v of [10, 20]) { fns2.push(() => v); }
  out.push(fns2.map((g: any) => g()).join(","));
  return out.join("|");
}` },
  { name: "new-with-spread", fn: "f", ts: `class P { a: any; b: any; c: any; constructor(a: any, b: any, c: any) { this.a = a; this.b = b; this.c = c; } sum(): any { return this.a + this.b + this.c; } }
export function f(): any {
  const out: any = [];
  const args: any = [1, 2, 3];
  const p = new P(...args);
  out.push(p.sum());
  const p2 = new P(...[4, 5, 6]);
  out.push(p2.a, p2.b, p2.c);
  const p3 = new (P as any)(7, 8, 9);
  out.push(p3.sum());
  return out.join("|");
}` },
  { name: "optional-combos", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: { b: { c: 1 } }, m() { return 5; } };
  out.push(o?.a?.b?.c, o?.x?.y?.z === undefined ? 1 : 0);
  out.push(o?.m?.(), (o as any).n?.m?.() === undefined ? 1 : 0);
  const arr: any = [1, 2];
  out.push(arr?.[0], arr?.[9] === undefined ? 1 : 0);
  out.push(o.a ?? "d", null ?? "d", undefined ?? "d", 0 ?? "d", "" ?? "d");
  return out.join("|");
}` },
  { name: "parseint-radix", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(parseInt("42"), parseInt("42px"), parseInt("ff", 16), parseInt("101", 2));
  out.push(parseFloat("3.14abc"), parseFloat(".5"), parseFloat("1e3"));
  out.push(Number("12"), Number(""), Number(" 7 "), Number("x"));
  out.push(Number.isNaN(NaN) ? 1 : 0, Number.isFinite(Infinity) ? 1 : 0, isNaN("x") ? 1 : 0);
  out.push((5 / 0), (-5 / 0), (0 / 0 !== 0 / 0) ? 1 : 0);
  return out.join("|");
}` },
  { name: "switch-return-fallthrough", fn: "f", ts: `export function f(x: any): any {
  let r = "";
  switch (x) {
    case 1: r += "a";
    case 2: r += "b"; break;
    case 3: r += "c"; return "ret" + r;
    default: r += "d";
  }
  return r;
}`, args: [1] },
  { name: "nested-obj-method-this", fn: "f", ts: `const cfg = {
  n: 5,
  inner: {
    n: 7,
    get v() { return this.n * 2; },
    m() { return this.n + 1; }
  },
  get total() { return this.n + this.inner.v; }
};
export function f(): any {
  const out: any = [];
  out.push(cfg.total, cfg.inner.v, cfg.inner.m(), cfg.n);
  const { inner } = cfg;
  out.push(inner.v, inner.m());
  return out.join("|");
}` },
  { name: "array-holes-sparse", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [1, , 3];
  out.push(a.length, a[1] === undefined ? 1 : 0, JSON.stringify(a));
  a[5] = 6;
  out.push(a.length, a[4] === undefined ? 1 : 0);
  const keys: any = [];
  for (const k in a) keys.push(k);
  out.push(keys.length > 0 ? 1 : 0);
  out.push(a.map((x: any) => x === undefined ? 0 : 1).join(","));
  return out.join("|");
}` },
  { name: "string-iteration-split", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s = "a🙂b";
  out.push(s.length, [...s].length);
  out.push(s.split("").length);
  out.push(Array.from(s).join("-"));
  out.push(s.charCodeAt(0), s.codePointAt(1));
  out.push("ab".split("").reverse().join(""));
  out.push("a b  c".split(" ").filter((x: any) => x !== "").join("|"));
  return out.join("|");
}` },
  { name: "getter-setter-side-effects", fn: "f", ts: `let log: any = "";
class Box {
  _v: any = 0;
  get v(): any { log += "g"; return this._v; }
  set v(x: any) { log += "s"; this._v = x; }
  bump(): any { this.v = this.v + 1; return this._v; }
}
export function f(): any {
  const out: any = [];
  const b = new Box();
  out.push(b.bump(), log);
  log = "";
  const x = b.v + b.v;
  out.push(x, log);
  return out.join("|");
}` },
];
