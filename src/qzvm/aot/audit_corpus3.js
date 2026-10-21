// 差分审计语料（第三批）：参数语义 / 循环闭包 / 内建方法覆盖 / 调用可选链 / 计算属性名 / 类静态访问器 / 其它角落。
module.exports = [
  // ---------- 参数语义 ----------
  { name: "param-default", fn: "f", ts: `export function f(a: any, b: any = 5, c: any = a + 1): any {
  function g(x: any, y: any = 10, z: any = y * 2) { return "" + x + "," + y + "," + z; }
  const out: any = [];
  out.push("" + a + "," + b + "," + c);
  out.push(g(1));
  out.push(g(1, 2));
  out.push(g(1, undefined, 3));
  out.push(g(1, null));
  return out.join("|");
}`, args: [7] },
  { name: "param-destructure", fn: "f", ts: `export function f(): any {
  function g({ a, b = 2 }: any, [c, d = 4]: any = [3]) { return a + "|" + b + "|" + c + "|" + d; }
  return g({ a: 1 }) + ";;" + g({ a: 1, b: 9 });
}` },
  { name: "param-rest", fn: "f", ts: `export function f(): any {
  function g(first: any, ...rest: any) { return first + ":" + rest.length + ":" + rest.join(","); }
  const out: any = [];
  out.push(g(1));
  out.push(g(1, 2, 3));
  out.push(g(1, 2, 3, 4, 5));
  return out.join("|");
}` },
  { name: "param-arrow-default", fn: "f", ts: `export function f(): any {
  const g = (x: any, y: any = x * 2) => x + y;
  const out: any = [];
  out.push(g(3));
  out.push(g(3, 1));
  const h = ({ k = 7 }: any = {}) => k;
  out.push(h());
  out.push(h({ k: 1 }));
  return out.join("|");
}` },
  { name: "param-arguments", fn: "f", ts: `export function f(): any {
  function g() { return arguments.length + ":" + arguments[0]; }
  return g(9, 8);
}` },
  // ---------- 循环闭包（let 每迭代绑定） ----------
  { name: "loop-closure-let", fn: "f", ts: `export function f(): any {
  const fns: any = [];
  for (let i = 0; i < 3; i++) fns.push(function () { return i; });
  for (const v of ["a", "b"]) fns.push(function () { return v; });
  return fns.map((g: any) => g()).join(",");
}` },
  { name: "loop-closure-var", fn: "f", ts: `export function f(): any {
  const fns: any = [];
  for (var i = 0; i < 3; i++) fns.push(function () { return i; });
  return fns.map((g: any) => g()).join(",");
}` },
  { name: "loop-closure-while", fn: "f", ts: `export function f(): any {
  const fns: any = [];
  let i = 0;
  while (i < 3) { const j = i; fns.push(function () { return j; }); i++; }
  return fns.map((g: any) => g()).join(",");
}` },
  // ---------- 内建方法覆盖（数组） ----------
  { name: "arr-more-methods", fn: "f", ts: `export function f(): any {
  const a = [1, 2, 3, 4, 5];
  const out: any = [];
  out.push(a.filter((x: any) => x % 2 === 1).join(""));
  out.push(a.find((x: any) => x > 3));
  out.push(a.findIndex((x: any) => x > 3));
  out.push(a.some((x: any) => x === 5) ? 1 : 0);
  out.push(a.every((x: any) => x > 0) ? 1 : 0);
  out.push(a.flatMap((x: any) => [x, x * 10]).length);
  out.push(a.slice(-2).join(","));
  out.push(a.reverse().join(","));
  out.push(a.indexOf(3));
  out.push(a.lastIndexOf(3));
  out.push(a.includes(4) ? 1 : 0);
  out.push([3, 1, 2].sort().join(","));
  out.push([10, 9, 100].sort().join(","));
  out.push([].concat(a).length);
  return out.join("|");
}` },
  { name: "arr-fill-entries-keys", fn: "f", ts: `export function f(): any {
  const a: any = [1, 2, 3];
  const out: any = [];
  out.push(a.entries ? "has" : "no");
  out.push(Object.keys(a).join(","));
  const b: any = new Array(3);
  out.push(b.length);
  out.push(Array.isArray(a) ? 1 : 0);
  out.push(Array.from("xyz").join(""));
  out.push(Array.of(1, 2).join(","));
  return out.join("|");
}` },
  { name: "arr-sort-stability", fn: "f", ts: `export function f(): any {
  const rows: any = [{ k: 2, id: "a" }, { k: 1, id: "b" }, { k: 2, id: "c" }];
  rows.sort((x: any, y: any) => x.k - y.k);
  return rows.map((r: any) => r.id).join(",");
}` },
  { name: "arr-reduce-variants", fn: "f", ts: `export function f(): any {
  const a = [1, 2, 3];
  const out: any = [];
  out.push(a.reduce((s: any, x: any) => s + x, 100));
  out.push(a.reduceRight((s: any, x: any) => s + "-" + x, "z"));
  out.push(a.map((v: any, i: any, arr: any) => v * i + arr.length).join(","));
  return out.join("|");
}` },
  { name: "arr-splice-multi", fn: "f", ts: `export function f(): any {
  const a: any = [1, 2, 3, 4];
  const out: any = [];
  out.push(a.splice(1, 2, "x", "y", "z").join(","));
  out.push(a.join(","));
  out.push(a.splice(-1).join(","));
  out.push(a.join(","));
  return out.join("|");
}` },
  // ---------- 内建方法覆盖（字符串） ----------
  { name: "str-more-methods", fn: "f", ts: `export function f(): any {
  const s = "  Hello World  ";
  const out: any = [];
  out.push(s.trim());
  out.push(s.trimStart());
  out.push(s.trimEnd());
  out.push("a-b-c".split("-").join(""));
  out.push("abc".at ? "abc".at(-1) : "n/a");
  out.push("x".repeat(3));
  out.push("abc".padStart(5, "*"));
  out.push("abc".padEnd(5, "*"));
  out.push("Hello".includes("ell") ? 1 : 0);
  out.push("Hello".startsWith("He") ? 1 : 0);
  out.push("Hello".endsWith("lo") ? 1 : 0);
  out.push("Hello".charCodeAt(1));
  out.push(String.fromCharCode(72, 105));
  return out.join("|");
}` },
  { name: "str-split-regexish", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("a1b2c".split(/\\d/).join(","));
  out.push("x1y2".replace(/\\d/g, "#"));
  out.push("HELLO".toLowerCase());
  out.push("café".length);
  out.push("café".toUpperCase());
  return out.join("|");
}` },
  { name: "str-locale-trim-unicode", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s = "\\u00e9\\u0301";
  out.push(s.length);
  out.push(s.normalize ? s.normalize("NFC") : "no");
  out.push("a".localeCompare("b") < 0 ? 1 : 0);
  out.push("10".localeCompare("9"));
  return out.join("|");
}` },
  // ---------- Object / Number / JSON / Math ----------
  { name: "obj-more-methods", fn: "f", ts: `export function f(): any {
  const o: any = { a: 1, b: 2 };
  const out: any = [];
  out.push(Object.keys(o).length);
  out.push(Object.entries(o).map((e: any) => e[0] + "=" + e[1]).join(","));
  out.push(Object.assign({}, o, { c: 3 }).c);
  out.push(Object.is(1, 1) ? 1 : 0);
  out.push(Object.is(NaN, NaN) ? 1 : 0);
  out.push(Object.is(0, -0) ? 1 : 0);
  out.push(o.hasOwnProperty("a") ? 1 : 0);
  out.push("a" in o ? 1 : 0);
  out.push(Object.getOwnPropertyNames ? "has" : "no");
  return out.join("|");
}` },
  { name: "obj-freeze-seal", fn: "f", ts: `export function f(): any {
  const o: any = { a: 1 };
  const fz: any = Object.freeze(o);
  const out: any = [];
  out.push(fz.a);
  out.push(Object.isFrozen ? (Object.isFrozen(fz) ? 1 : 0) : -1);
  return out.join("|");
}` },
  { name: "num-more", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Number.isInteger(5) ? 1 : 0);
  out.push(Number.isInteger(5.5) ? 1 : 0);
  out.push(Number.isNaN(NaN) ? 1 : 0);
  out.push(Number.isFinite(Infinity) ? 1 : 0);
  out.push(Number.isSafeInteger(1e20) ? 1 : 0);
  out.push(Number.MAX_SAFE_INTEGER);
  out.push(Number.MAX_VALUE > 1e308 ? 1 : 0);
  out.push((255).toString(16));
  out.push((1e21).toExponential(2));
  out.push((123.456).toPrecision(4));
  out.push(parseInt("0b101", 2));
  out.push(parseInt("ff", 16));
  out.push(parseFloat("  1.5x"));
  out.push(isFinite("12") ? 1 : 0);
  out.push(Math.trunc(-0.9));
  out.push(Math.cbrt(27));
  out.push(Math.expm1 ? Math.expm1(0) : -1);
  out.push(Math.clz32 ? Math.clz32(1) : -1);
  return out.join("|");
}` },
  { name: "json-edges", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(JSON.stringify({ a: undefined, b: 1, c: null }));
  out.push(JSON.stringify([undefined, null, 1]));
  out.push(JSON.stringify("x"));
  out.push(JSON.stringify({ n: [1, { q: true }] }));
  out.push(JSON.parse("[1,2,3]").length);
  out.push(JSON.parse("null") === null ? 1 : 0);
  out.push(JSON.stringify(0.1));
  out.push(JSON.parse('{"a":{"b":2}}').a.b);
  return out.join("|");
}` },
  { name: "json-global-builtins", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(encodeURIComponent("a b&c").toString());
  out.push(decodeURIComponent("a%20b"));
  out.push(isNaN("x") ? 1 : 0);
  out.push(isNaN("12") ? 1 : 0);
  out.push(isNaN(NaN) ? 1 : 0);
  out.push(String(12.5));
  out.push(String(true));
  out.push(Number("  12  "));
  out.push(Number(true));
  out.push(Boolean(" ") ? 1 : 0);
  return out.join("|");
}` },
  // ---------- 调用/访问角落 ----------
  { name: "opt-call", fn: "f", ts: `export function f(o: any): any {
  const out: any = [];
  out.push(typeof o?.m);
  out.push(o?.arr?.length ?? -1);
  out.push(o?.["arr"] ? 1 : 0);
  out.push(o?.missing?.deep?.x ?? "none");
  return out.join("|");
}`, args: [{ arr: [1, 2] }] },
  { name: "opt-call-fn", fn: "f", ts: `export function f(o: any): any {
  const out: any = [];
  out.push(typeof o.m);
  out.push(o.m ? 1 : 0);
  return out.join("|");
}`, args: [{ m: function () { return 1; } }] },
  { name: "computed-key-literal", fn: "f", ts: `export function f(): any {
  const k = "dyn";
  const o: any = { [k]: 1, plain: 2, ["x" + "y"]: 3 };
  const out: any = [];
  out.push(o.dyn + "|" + o.xy + "|" + Object.keys(o).length);
  return out.join("|");
}` },
  { name: "num-string-props", fn: "f", ts: `export function f(): any {
  const o: any = {};
  o[1] = "a";
  o["1"] = "b";
  o[2] = "c";
  const out: any = [];
  out.push(o[1]);
  out.push(Object.keys(o).join(","));
  out.push(Object.keys(o).length);
  const a: any = [1, 2, 3];
  out.push(Object.keys(a).join(","));
  out.push(a[1] === 2 ? 1 : 0);
  return out.join("|");
}` },
  { name: "recursion-mutual", fn: "f", ts: `export function f(n: any): any {
  function isEven(k: any): any { return k === 0 ? true : isOdd(k - 1); }
  function isOdd(k: any): any { return k === 0 ? false : isEven(k - 1); }
  return (isEven(n) ? "E" : "O") + ":" + (isOdd(n) ? "O" : "E");
}`, args: [7] },
  { name: "closure-counter-factory", fn: "f", ts: `export function f(): any {
  function counter(step: any) { let n = 0; return function () { n += step; return n; }; }
  const c1 = counter(1), c2 = counter(10);
  const out: any = [];
  out.push(c1(), c1(), c2(), c1(), c2());
  return out.join(",");
}` },
  { name: "string-iteration-unicode", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let i = 0;
  for (const ch of "aé😀") { out.push(ch.length); i++; }
  out.push(i);
  return out.join(",");
}` },
  { name: "ternary-assign-ops", fn: "f", ts: `export function f(): any {
  let a: any = 1, b: any = 0;
  a ||= 5; b ||= 5;
  a &&= a + 1; b &&= 9;
  const o: any = { x: null, y: 2 };
  o.x ??= 7; o.y ??= 8;
  let c: any = null; c ??= "d";
  return [a, b, o.x, o.y, c].join("|");
}` },
  { name: "class-static-accessor", fn: "f", ts: `class C { static _v: any = 1; static get v(): any { return C._v * 3; } static set v(x: any) { C._v = x; } }
export function f(): any { const out: any = []; out.push(C.v); C.v = 4; out.push(C.v); out.push(C._v); return out.join("|"); }` },
  { name: "class-instanceof-chain", fn: "f", ts: `class A { }
class B extends A { }
class C extends B { }
export function f(): any {
  const c = new C();
  const out: any = [];
  out.push(c instanceof C ? 1 : 0, c instanceof B ? 1 : 0, c instanceof A ? 1 : 0, c instanceof Array ? 1 : 0);
  return out.join("|");
}` },
  { name: "class-ctor-order", fn: "f", ts: `class A { x: any = 1; constructor() { this.x = 10; } }
class B extends A { y: any = this.x + 1; constructor() { super(); this.y = this.x + 5; } }
export function f(): any { const b = new B(); return b.x + "|" + b.y; }` },
  { name: "class-tostring-self", fn: "f", ts: `class P { name: any; constructor(n: any) { this.name = n; } toString(): any { return "P(" + this.name + ")"; } }
export function f(): any {
  const p = new P("x");
  const out: any = [];
  out.push(p.toString());
  out.push(String(p) === p.toString() ? 1 : 0);
  return out.join("|");
}` },
  { name: "misc-typeof-more", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(typeof NaN);
  out.push(typeof Infinity);
  out.push(typeof (() => 1));
  const o: any = { m: function () { } };
  out.push(typeof o.m);
  out.push(typeof JSON);
  out.push(typeof Math);
  out.push(typeof Symbol);
  return out.join("|");
}` },
  { name: "misc-void-delete", fn: "f", ts: `export function f(): any {
  const o: any = { a: 1 };
  const out: any = [];
  out.push(void o.a);
  out.push(o.a);
  out.push(delete o.a);
  out.push(o.a === undefined ? 1 : 0);
  out.push(typeof void 0);
  return out.join("|");
}` },
  { name: "misc-comma-labeled", fn: "f", ts: `export function f(): any {
  let out = "";
  outer: for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (j === 1 && i === 1) continue outer;
      if (i === 2) break outer;
      out += i + "" + j;
    }
  }
  return out;
}` },
  { name: "misc-switch-string-fallthrough", fn: "f", ts: `export function f(s: any): any {
  let out = "";
  switch (s) {
    case "x":
    case "y": out += "xy"; break;
    case "z": out += "z";
    default: out += "d";
  }
  return out;
}`, args: ["z"] },
  { name: "misc-nested-destructure-decl", fn: "f", ts: `export function f(): any {
  const data: any = { list: [{ id: 1 }, { id: 2 }], meta: { n: 2 } };
  const { list, meta } = data;
  const first = list[0];
  const [a, b] = list;
  return (a.id + b.id) + "|" + meta.n + "|" + first.id;
}` },
  { name: "misc-sparse-array-holes", fn: "f", ts: `export function f(): any {
  const a: any = [];
  a[3] = "x";
  const out: any = [];
  out.push(a.length);
  out.push(a[0] === undefined ? 1 : 0);
  out.push(a.join(","));
  out.push(Object.keys(a).join(","));
  return out.join("|");
}` },
];
