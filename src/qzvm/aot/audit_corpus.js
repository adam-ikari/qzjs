// 差分审计语料：每条独立编译。name / fn / args / ts。
module.exports = [
  // ---------- 数字 / 字符串转换 ----------
  { name: "num-str-cases", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(String(0.1 + 0.2));
  out.push(String(1e21));
  out.push(String(1e-7));
  out.push(String(-0));
  out.push(String(123456789012345678901234567890));
  out.push(String(1 / 3));
  out.push(String(2 / 3));
  out.push(String(100));
  out.push(String(1.005));
  return out.join("|");
}` },
  { name: "num-rounding", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Math.round(-0.5));
  out.push(Math.round(0.5));
  out.push(Math.round(2.5));
  out.push(Math.round(-2.5));
  out.push(Math.trunc(-1.7));
  out.push(Math.sign(-3));
  out.push(Math.floor(-0.1));
  out.push(Math.ceil(-0.9));
  out.push(Math.max(1, NaN, 3));
  out.push(Math.min());
  out.push((1.005).toFixed(2));
  out.push((255).toString(16));
  out.push((-255).toString(2));
  out.push((0.000001).toString());
  return out.join("|");
}` },
  { name: "num-parse", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(parseInt("42px"));
  out.push(parseInt("0x1f"));
  out.push(parseInt("  12  "));
  out.push(parseFloat("3.14abc"));
  out.push(Number("12"));
  out.push(Number(""));
  out.push(Number("abc"));
  out.push(parseInt("08"));
  out.push(parseInt("-0x10"));
  return out.join("|");
}` },
  { name: "num-bitwise", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(-1 >>> 0);
  out.push(2147483648 | 0);
  out.push(5 & 3);
  out.push(5 | 3);
  out.push(5 ^ 3);
  out.push(~5);
  out.push(1 << 31);
  out.push(-8 >> 1);
  out.push(-8 >>> 1);
  out.push(1e9 * 1e9 | 0);
  out.push(3.7 | 0);
  out.push(NaN | 0);
  return out.join("|");
}` },
  // ---------- 字符串 ----------
  { name: "str-methods", fn: "f", ts: `export function f(): any {
  const s = "Hello, World";
  const out: any = [];
  out.push(s.toLowerCase());
  out.push(s.toUpperCase());
  out.push(s.indexOf("o"));
  out.push(s.lastIndexOf("o"));
  out.push(s.indexOf("z"));
  out.push(s.slice(7));
  out.push(s.slice(-5));
  out.push(s.slice(2, 5));
  out.push(s.substring(5, 2));
  out.push(s.charAt(1));
  out.push(s.charCodeAt(0));
  out.push(s.split(", ").join("-"));
  out.push(s.replace("World", "JS"));
  out.push("  pad  ".trim());
  out.push("ab".repeat(3));
  out.push("5".padStart(3, "0"));
  out.push("5".padEnd(3, "x"));
  out.push(s.includes("World") ? 1 : 0);
  out.push(s.startsWith("Hell") ? 1 : 0);
  out.push(s.endsWith("ld") ? 1 : 0);
  out.push(s.concat("!", "?"));
  return out.join("|");
}` },
  { name: "str-unicode", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("你好".length);
  out.push("😀".length);
  out.push("a😀b".length);
  out.push("héllo".toUpperCase());
  out.push("你好"[0]);
  out.push("café".indexOf("é"));
  return out.join("|");
}` },
  { name: "str-template", fn: "f", ts: `export function f(a: number, b: string): any {
  const obj: any = { x: 1 };
  return \`a=\${a} b=\${b} obj=\${obj.x} nest=\${"<" + (a + 1) + ">"} t=\${true} n=\${null} u=\${undefined}\`;
}` , args: [3, "hi"] },
  { name: "str-compare", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("a" < "b" ? 1 : 0);
  out.push("Z" < "a" ? 1 : 0);
  out.push("10" < "9" ? 1 : 0);
  out.push("abc" == "abc" ? 1 : 0);
  out.push("2" * "3");
  out.push("2" + 3);
  out.push(2 + "3");
  out.push("5" - 1);
  return out.join("|");
}` },
  // ---------- 数组 ----------
  { name: "arr-methods", fn: "f", ts: `export function f(): any {
  const a = [3, 1, 2];
  const out: any = [];
  out.push(a.join(","));
  out.push(a.slice(1).join(","));
  out.push(a.concat([4, 5]).join(","));
  out.push(a.indexOf(2));
  out.push(a.includes(9) ? 1 : 0);
  out.push(a.map((x: any) => x * 2).join(","));
  out.push(a.filter((x: any) => x > 1).join(","));
  out.push(a.reduce((s: any, x: any) => s + x, 0));
  out.push(a.slice().sort().join(","));
  out.push(a.slice().sort((x: any, y: any) => x - y).join(","));
  out.push(a.slice().reverse().join(","));
  out.push(a.length);
  return out.join("|");
}` },
  { name: "arr-mutate", fn: "f", ts: `export function f(): any {
  const a: any = [1, 2, 3];
  const out: any = [];
  out.push(a.push(4));
  out.push(a.pop());
  out.push(a.shift());
  out.push(a.unshift(0));
  out.push(a.join(","));
  out.push(a.splice(1, 2).join(","));
  out.push(a.join(","));
  a.length = 1;
  out.push(a.join(","));
  return out.join("|");
}` },
  { name: "arr-sparse-nest", fn: "f", ts: `export function f(): any {
  const a: any = [1, [2, 3], [4, [5]]];
  const out: any = [];
  out.push(a[1][1]);
  out.push(a[2][1][0]);
  out.push(a.length);
  out.push([...a[1], ...a[2][1]].join(","));
  const b: any = [...a];
  out.push(b.length);
  return out.join("|");
}` },
  // ---------- 对象 ----------
  { name: "obj-keys", fn: "f", ts: `export function f(): any {
  const o: any = { b: 2, a: 1, c: 3 };
  const out: any = [];
  out.push(Object.keys(o).join(","));
  out.push(Object.values(o).join(","));
  out.push(Object.entries(o).map((e: any) => e[0]).join(","));
  out.push(Object.keys(o).length);
  const p: any = { ...o, d: 4 };
  out.push(Object.keys(p).join(","));
  out.push(JSON.stringify(p));
  const q: any = Object.assign({}, o, { a: 9 });
  out.push(JSON.stringify(q));
  out.push("a" in o ? 1 : 0);
  delete o.a;
  out.push(Object.keys(o).join(","));
  out.push(Object.keys(o).length);
  return out.join("|");
}` },
  { name: "obj-nested", fn: "f", ts: `export function f(): any {
  const o: any = { a: { b: { c: 42 } }, arr: [1, 2, { d: 3 }] };
  const out: any = [];
  out.push(o.a.b.c);
  out.push(o.arr[2].d);
  o.a.b.c = 7;
  out.push(JSON.stringify(o.a));
  out.push(o.arr.length);
  const k = "a";
  out.push(o[k].b.c);
  o[k].b.c = 8;
  out.push(o.a.b.c);
  return out.join("|");
}` },
  { name: "obj-getter", fn: "f", ts: `export function f(): any {
  const o: any = { _v: 5, get v(): any { return this._v * 2; }, set v(x: any) { this._v = x + 1; } };
  const out: any = [];
  out.push(o.v);
  o.v = 10;
  out.push(o._v);
  out.push(o.v);
  return out.join("|");
}` },
  { name: "json-roundtrip", fn: "f", ts: `export function f(): any {
  const o: any = { a: [1, 2, { b: "x" }], n: null, t: true, s: "q\\"z" };
  const s = JSON.stringify(o);
  const b = JSON.parse(s);
  return s + "||" + b.a[2].b + "|" + b.t + "|" + b.n + "|" + b.a.length;
}` },
  // ---------- 控制流 ----------
  { name: "switch-fallthrough", fn: "f", ts: `export function f(x: any): any {
  let out = "";
  switch (x) {
    case 1: out += "1";
    case 2: out += "2"; break;
    case 3: out += "3";
    default: out += "d";
  }
  return out;
}`, args: [1] },
  { name: "labeled-loops", fn: "f", ts: `export function f(): any {
  let out = "";
  outer: for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (j === 1) continue outer;
      if (i === 2) break outer;
      out += "" + i + j + " ";
    }
  }
  return out;
}` },
  { name: "dowhile-while", fn: "f", ts: `export function f(): any {
  let i = 0, n = 0;
  do { n += i; i++; } while (i < 3);
  let j = 10, m = 0;
  while (j > 7) { m += j; j--; }
  return n + "|" + m + "|" + i + "|" + j;
}` },
  { name: "ternary-nullish-opt", fn: "f", ts: `export function f(o: any): any {
  const out: any = [];
  out.push(o && o.a ? 1 : 0);
  out.push(o?.a ?? "dflt");
  out.push(o?.b?.c ?? "none");
  out.push(o?.a === 0 ? "zero" : "nz");
  out.push((null as any) ?? "n");
  out.push((undefined as any) ?? "u");
  out.push((0 as any) ?? "z");
  out.push(("" as any) ?? "e");
  return out.join("|");
}`, args: [{ a: 0 }] },
  { name: "typeof-all", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(typeof 1);
  out.push(typeof "s");
  out.push(typeof true);
  out.push(typeof undefined);
  out.push(typeof null);
  out.push(typeof {});
  out.push(typeof []);
  out.push(typeof f);
  out.push(typeof Symbol);
  return out.join("|");
}` },
  { name: "equality-complex", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(1 == "1" ? 1 : 0);
  out.push(null == undefined ? 1 : 0);
  out.push(NaN == NaN ? 1 : 0);
  out.push(0 == false ? 1 : 0);
  out.push("" == false ? 1 : 0);
  out.push([] == "" ? 1 : 0);
  out.push(1 === 1 ? 1 : 0);
  out.push({} === {} ? 1 : 0);
  out.push(1 != "2" ? 1 : 0);
  out.push(null === undefined ? 1 : 0);
  return out.join("|");
}` },
  // ---------- 闭包 / 函数 ----------
  { name: "closure-counter", fn: "f", ts: `export function f(): any {
  function make() { let n = 0; return function () { n++; return n; }; }
  const c1 = make(), c2 = make();
  const out: any = [];
  out.push(c1()); out.push(c1()); out.push(c2());
  return out.join("|");
}` },
  { name: "closure-nested-write", fn: "f", ts: `export function f(): any {
  let total = 0;
  function outer(k: any) {
    function inner(m: any) { total += k * m; }
    inner(2); inner(3);
  }
  outer(1); outer(10);
  return total;
}` },
  { name: "recursion", fn: "f", ts: `export function f(n: any): any {
  function fib(k: any): any { return k < 2 ? k : fib(k - 1) + fib(k - 2); }
  let s = 0;
  for (let i = 0; i < n; i++) s += fib(i);
  return s;
}`, args: [10] },
  { name: "iife-arrow-capture", fn: "f", ts: `export function f(): any {
  const arr: any = [1, 2, 3];
  let s = 0;
  arr.forEach((v: any) => { s += v * 2; });
  const g = (x: any) => (y: any) => x + y;
  const add5 = g(5);
  return s + "|" + add5(3) + "|" + ((() => 42)());
}` },
  { name: "default-rest-params", fn: "f", ts: `export function f(a: any, b?: any): any {
  function g(x: any, y: any) { return x + "-" + y; }
  function h(x: any) { return x; }
  const out: any = [];
  out.push(g(1, 2));
  out.push(h(9));
  out.push(f2(1));
  out.push(f2(1, 2));
  return out.join("|");
  function f2(p: any, q: any) { return q === undefined ? "undef" : p + q; }
}`, args: [1] },
  // ---------- 类 ----------
  { name: "class-inherit-super", fn: "f", ts: `class A { x: any = 1; constructor(a: any) { this.x = a; } m(): any { return "A" + this.x; } }
class B extends A { y: any; constructor(a: any, b: any) { super(a); this.y = b; } m(): any { return "B" + super.m() + this.y; } }
export function f(): any {
  const b = new B(5, 6);
  const out: any = [];
  out.push(b.m());
  out.push(b.x + b.y);
  out.push(b instanceof B ? 1 : 0);
  out.push(b instanceof A ? 1 : 0);
  out.push(b instanceof Array ? 1 : 0);
  return out.join("|");
}` },
  { name: "class-accessors", fn: "f", ts: `class C { _n: any = 1; get n(): any { return this._n; } set n(v: any) { this._n = v * 2; } inc(): any { return ++this._n; } }
export function f(): any {
  const c = new C();
  const out: any = [];
  out.push(c.n);
  c.n = 10;
  out.push(c._n);
  out.push(c.inc());
  out.push(c.n);
  return out.join("|");
}` },
  { name: "class-this-method", fn: "f", ts: `class Counter { n: any = 0; add(k: any): any { this.n += k; return this; } get(): any { return this.n; } }
export function f(): any {
  const c = new Counter();
  return c.add(1).add(2).get();
}` },
  // ---------- 解构 / 展开 ----------
  { name: "destructure", fn: "f", ts: `export function f(): any {
  const [a, b, ...rest] = [1, 2, 3, 4];
  const { x, y: z } = { x: 10, y: 20 };
  const [p = 99, q = 5] = [1, undefined];
  const out: any = [];
  out.push(a + "|" + b + "|" + rest.join(","));
  out.push(x + "|" + z);
  out.push(p + "|" + q);
  const o: any = { m: 1, n: 2 };
  const { m, ...others } = o;
  out.push(m + "|" + JSON.stringify(others));
  return out.join("|");
}` },
  { name: "spread-call", fn: "f", ts: `export function f(): any {
  const a: any = [2, 3];
  function g(x: any, y: any, z: any) { return x + y + z; }
  const o: any = { p: 1, q: 2 };
  const o2: any = { ...o, r: 3 };
  return g(1, ...[2, 3]) + "|" + JSON.stringify(o2) + "|" + [0, ...a, 4].join(",");
}` },
  // ---------- 其它 ----------
  { name: "try-catch", fn: "f", ts: `export function f(): any {
  const out: any = [];
  try { throw new Error("boom"); } catch (e: any) { out.push("caught:" + e.message); }
  try { out.push("ok"); } finally { out.push("fin"); }
  return out.join("|");
}` },
  { name: "string-method-on-result", fn: "f", ts: `export function f(): any {
  const o: any = { list: [1, 2, 3] };
  return o.list.filter((x: any) => x > 1).map((x: any) => "v" + x).join("+");
}` },
  { name: "nested-fn-decl", fn: "f", ts: `export function f(): any {
  return inner(2) + helper(3);
  function inner(x: any) { return x * 10; }
  function helper(y: any) { return inner(y) + 1; }
}` },
  { name: "while-break-nested", fn: "f", ts: `export function f(): any {
  let out = "";
  let i = 0;
  while (true) {
    i++;
    if (i > 5) break;
    if (i % 2 === 0) continue;
    out += i;
  }
  return out + "|" + i;
}` },
  { name: "array-of-objects-flow", fn: "f", ts: `export function f(): any {
  const rows: any = [{ n: "a", v: 1 }, { n: "b", v: 2 }, { n: "c", v: 3 }];
  let total = 0;
  let names = "";
  for (const r of rows) { total += r.v; names += r.n; }
  let idx = 0, s = "";
  for (const r of rows) { if (idx > 0) s += ","; s += r.v * 2; idx++; }
  return total + "|" + names + "|" + s;
}` },
  { name: "string-number-mix", fn: "f", ts: `export function f(): any {
  let s = "";
  for (let i = 0; i < 3; i++) { s = s + i + "=" + (i * i) + ";"; }
  const t: any = { a: s, b: s.length };
  return t.a + "|" + t.b;
}` },
  { name: "object-in-array-mutate", fn: "f", ts: `export function f(): any {
  const o: any = { items: [] };
  o.items.push({ id: 1 });
  o.items.push({ id: 2 });
  o.items[0].id = 9;
  return JSON.stringify(o) + "|" + o.items.length;
}` },
  { name: "very-deep-call", fn: "f", ts: `export function f(): any {
  function go(n: any): any { return n <= 0 ? 0 : 1 + go(n - 1); }
  return go(200);
}` },
  { name: "global-ish-builtins", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(isNaN(1 as any) ? 1 : 0);
  out.push(String(123));
  out.push(Boolean(0) ? 1 : 0);
  out.push(Boolean("x") ? 1 : 0);
  out.push(Array.isArray([]) ? 1 : 0);
  out.push(Array.isArray("x") ? 1 : 0);
  out.push(Math.abs(-3));
  out.push(Math.pow(2, 10));
  out.push(Math.sqrt(16));
  out.push(Math.PI.toFixed(4));
  return out.join("|");
}` },
  { name: "void-undef-return", fn: "f", ts: `export function f(): any {
  function noRet() { }
  const a: any = noRet();
  const out: any = [];
  out.push(a === undefined ? 1 : 0);
  out.push(typeof a);
  out.push(void 0 === undefined ? 1 : 0);
  return out.join("|");
}` },
  { name: "chained-optional-call", fn: "f", ts: `export function f(o: any): any {
  const out: any = [];
  out.push(typeof o?.m);
  out.push(o?.m ? "has" : "no");
  out.push(o && o.arr ? o.arr.length : "n/a");
  return out.join("|");
}`, args: [{ m: 1, arr: [1, 2] }] },
  { name: "comma-sequence", fn: "f", ts: `export function f(): any {
  let a = 0;
  const b = (a = 1, a + 1);
  const o: any = { x: 1 };
  const c = (o.x = 2, o.x * 3);
  return b + "|" + c + "|" + a;
}` },
  { name: "string-split-edges", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("a,b,,c".split(",").length);
  out.push("".split(",").length);
  out.push("abc".split("").join(""));
  out.push("a-b".split("-").length);
  out.push("x".repeat(0).length);
  return out.join("|");
}` },
  { name: "num-to-string-radix-obj", fn: "f", ts: `export function f(): any {
  const o: any = {};
  o["k" + 1] = "v";
  o["k2"] = "w";
  o.n = 3;
  const out: any = [];
  out.push(Object.keys(o).sort().join(","));
  out.push(JSON.stringify(o));
  const arr: any = [];
  arr[2] = "c";
  arr[0] = "a";
  out.push(arr.length);
  out.push(JSON.stringify(arr));
  return out.join("|");
}` },
  { name: "typeof-function-value", fn: "f", ts: `export function f(): any {
  function g(x: any) { return x; }
  const h = (x: any) => x;
  const o: any = { m: function (x: any) { return x * 2; } };
  const out: any = [];
  out.push(typeof g);
  out.push(typeof h);
  out.push(typeof o.m);
  out.push(o.m(4));
  return out.join("|");
}` },
  { name: "big-loop-perf-sanity", fn: "f", ts: `export function f(): any {
  let s = 0;
  for (let i = 0; i < 1000; i++) { s += i; if (s > 100000) s = 0; }
  const a: any = [];
  for (let i = 0; i < 50; i++) a.push(i * i);
  let t = 0;
  for (const v of a) t += v;
  return s + "|" + t + "|" + a.length;
}` },
];
