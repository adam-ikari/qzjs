// 差分审计语料（第十批）：this 绑定 / Function.prototype 三件套 / 原型 / 访问器边界 / 数组洞 / 正则 / 异常边界。
module.exports = [
  // ---------- this 绑定 ----------
  { name: "this-arrow-vs-fn", fn: "f", ts: `class C {
  v: any = 1;
  m1(): any { return [1].map((x: any) => this.v)[0]; }
  m2(): any { const self = this; return [1].map(function (this: any) { return self.v; })[0]; }
  m3(): any { return (() => this.v)(); }
}
export function f(): any {
  const c = new C();
  return [c.m1(), c.m2(), c.m3()].join("|");
}` },
  { name: "fn-call-apply-bind", fn: "f", ts: `export function f(): any {
  function g(this: any, a: any, b: any) { return this.n + a + b; }
  const out: any = [];
  const o: any = { n: 10 };
  out.push(g.call(o, 1, 2));
  out.push(g.apply(o, [3, 4]));
  const b = g.bind(o, 5);
  out.push(b(6));
  out.push(typeof b);
  out.push(g.bind(o)(7, 8));
  return out.join("|");
}` },
  { name: "fn-length-name", fn: "f", ts: `export function f(): any {
  function g(a: any, b: any, c: any): any { return 0; }
  const h = (x: any) => x;
  const out: any = [];
  out.push(g.length, h.length);
  out.push(g.name === "g" ? 1 : 0);
  out.push(typeof g);
  out.push(g.toString().startsWith("function") ? 1 : 0);
  return out.join("|");
}` },
  // ---------- 原型 ----------
  { name: "obj-create-proto", fn: "f", ts: `export function f(): any {
  const proto: any = { greet(): any { return "hi"; }, v: 1 };
  const o: any = Object.create(proto);
  o.own = 2;
  const out: any = [];
  out.push(o.greet());
  out.push(o.v);
  out.push(Object.keys(o).join(","));
  out.push(Object.getPrototypeOf(o) === proto ? 1 : 0);
  out.push("own" in o ? 1 : 0);
  out.push("v" in o ? 1 : 0);
  out.push(o.hasOwnProperty("v") ? 1 : 0);
  return out.join("|");
}` },
  { name: "obj-assign-merge", fn: "f", ts: `export function f(): any {
  const a: any = { x: 1 }, b: any = { y: 2 }, c: any = { x: 9, z: 3 };
  const r: any = Object.assign(a, b, c);
  const out: any = [];
  out.push(r === a ? 1 : 0);
  out.push(Object.keys(a).sort().join(","));
  out.push(a.x);
  out.push(Object.assign({}, { p: 1 }, null, undefined).p);
  const spread: any = { ...b, ...c, w: 4 };
  out.push(Object.keys(spread).sort().join(","));
  return out.join("|");
}` },
  // ---------- 访问器 / 描述符边界 ----------
  { name: "accessor-this-chain", fn: "f", ts: `class Base { _v: any = 0; get v(): any { return this._v + 100; } set v(x: any) { this._v = x * 2; } }
class Sub extends Base { get double(): any { return this.v * 2; } }
export function f(): any {
  const s = new Sub();
  const out: any = [];
  out.push(s.v);
  s.v = 5;
  out.push(s.v, s._v, s.double);
  out.push(Object.keys(s).sort().join(","));
  out.push(Object.getOwnPropertyNames ? 1 : 0);
  return out.join("|");
}` },
  { name: "obj-literal-getter-this", fn: "f", ts: `export function f(): any {
  const o: any = {
    n: 3,
    get doubled(): any { return this.n * 2; },
    set doubled2(v: any) { this.n = v + 1; },
    method(): any { return this.n * 10; }
  };
  const out: any = [];
  out.push(o.doubled);
  o.doubled2 = 10;
  out.push(o.n);
  out.push(o.method());
  const { doubled } = o;
  out.push(doubled);
  return out.join("|");
}` },
  { name: "accessor-throws", fn: "f", ts: `class C { get boom(): any { throw new Error("acc"); } }
export function f(): any {
  const c = new C();
  const out: any = [];
  try { const v = c.boom; out.push("no:" + v); } catch (e: any) { out.push("caught:" + e.message); }
  out.push("after");
  return out.join("|");
}` },
  // ---------- 数组洞 / 稀疏 ----------
  { name: "array-holes-methods", fn: "f", ts: `export function f(): any {
  const a: any = new Array(3);
  const out: any = [];
  out.push(a.length);
  out.push(a.map((x: any) => 1).length);
  out.push(a.filter((x: any) => true).length);
  out.push(a.reduce((acc: any, x: any) => acc + 1, 0));
  out.push(a.join("-"));
  out.push(a.indexOf(undefined));
  out.push(a.includes(undefined) ? 1 : 0);
  out.push(a.every((x: any) => x === undefined) ? 1 : 0);
  out.push([...a].length);
  out.push(JSON.stringify(a));
  return out.join("|");
}` },
  { name: "array-length-assign", fn: "f", ts: `export function f(): any {
  const a: any = [1, 2, 3, 4, 5];
  const out: any = [];
  a.length = 2;
  out.push(a.join(","), a.length);
  a.length = 4;
  out.push(a.join(","), a.length);
  out.push(a[2] === undefined ? 1 : 0);
  a[10] = 9;
  out.push(a.length, a.filter((x: any) => x !== undefined).length);
  a.length = 0;
  out.push(a.length, a.join(","));
  return out.join("|");
}` },
  // ---------- 正则 ----------
  { name: "regex-exec-flags", fn: "f", ts: `export function f(): any {
  const re = /(\\d)(\\w)/g;
  const out: any = [];
  const m = re.exec("a1b 2c");
  out.push(m[0], m[1], m[2], m.index);
  const m2 = re.exec("a1b 2c");
  out.push(m2[0], m2.index);
  out.push(re.lastIndex);
  out.push(re.test("x3y"));
  const re2 = /a/g;
  out.push(re2.global ? 1 : 0, re2.source, re2.flags);
  out.push("aAbB".replace(/[a-z]/g, (c: any) => c.toUpperCase()));
  out.push("2024-01-02".replace(/(\\d+)-(\\d+)-(\\d+)/, "$3/$2/$1"));
  out.push(/^\\s*$/.test("   ") ? 1 : 0);
  return out.join("|");
}` },
  { name: "regex-split-capture", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("a1b2c".split(/(\\d)/).join("|"));
  out.push("a1b2c".split(/\\d/).join("|"));
  out.push("a1b2c".split(/(\\d)/, 3).join("|"));
  out.push("x".match(/(x)|(y)/).length);
  out.push([..."aXbXc".matchAll(/X/g)].length);
  out.push("aaa".replaceAll("a", "b"));
  return out.join("|");
}` },
  // ---------- 异常边界 ----------
  { name: "throw-primitives", fn: "f", ts: `export function f(): any {
  const out: any = [];
  function t(v: any): any { try { throw v; } catch (e: any) { return typeof e + ":" + e; } }
  out.push(t("s"));
  out.push(t(42));
  out.push(t(true));
  out.push(t(null));
  out.push(t(undefined));
  out.push(t({ msg: "o" }) === "object:[object Object]" ? 1 : 0);
  try { throw [1, 2]; } catch (e: any) { out.push(Array.isArray(e) ? 1 : 0); }
  return out.join("|");
}` },
  { name: "nested-try-finally-order", fn: "f", ts: `export function f(): any {
  const log: any = [];
  function run(): any {
    try {
      try { log.push("a"); throw new Error("x"); }
      finally { log.push("b"); }
    } catch (e: any) { log.push("c"); }
    finally { log.push("d"); }
    try { return "r"; } finally { log.push("e"); }
  }
  const r = run();
  return log.join(",") + "|" + r;
}` },
  { name: "loop-return-finally", fn: "f", ts: `export function f(): any {
  const log: any = [];
  function g(n: any): any {
    for (let i = 0; i < 3; i++) {
      try { if (i === n) return "ret" + i; } finally { log.push("f" + i); }
    }
    return "end";
  }
  const r = g(1);
  return log.join(",") + "|" + r;
}` },
  // ---------- 数值/字符串边界 ----------
  { name: "num-format-edge", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push((1e21).toString());
  out.push((1e-7).toString());
  out.push((123456789012345678901).toString());
  out.push((0.000001).toString());
  out.push((100).toString(36));
  out.push((-0).toString());
  out.push((1 / -0).toString());
  out.push(String(0.1 + 0.2));
  out.push((5e-324).toString() !== "0" ? 1 : 0);
  out.push(Math.round(-0.5), Math.round(0.5), Math.round(-1.5));
  out.push(Math.max(), Math.min());
  out.push(Math.max(NaN, 1));
  return out.join("|");
}` },
  { name: "str-escapes-unicode", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("\\u0041\\x42");   // 八进制转义在严格模式非法（tsc/node 会抛）
  out.push("\\u{1F600}".length);
  out.push("a\\u0301".length);
  out.push("\\t|\\n".length);
  out.push("café".toUpperCase());
  out.push("ß".length);
  out.push("\\uD83D\\uDE00".length);
  out.push("👍".length);
  out.push([..."👍"].length);
  out.push("a".charCodeAt(0), "A".codePointAt(0));
  out.push(String.fromCharCode(65, 66));
  return out.join("|");
}` },
  // ---------- 深层调用 / ABI ----------
  { name: "many-args-abi", fn: "f", ts: `export function f(): any {
  function six(a: any, b: any, c: any, d: any, e: any, g: any): any { return [a, b, c, d, e, g].join("-"); }
  function rest(...xs: any[]): any { return xs.length + ":" + xs.join("+"); }
  const out: any = [];
  out.push(six(1, 2, 3, 4, 5, 6));
  out.push(rest(1, 2));
  out.push(rest(1, 2, 3, 4, 5, 6, 7));
  out.push(rest());
  out.push(six(1, 2, 3));
  return out.join("|");
}` },
  { name: "default-params-ref", fn: "f", ts: `export function f(): any {
  function g(a: any, b: any = a * 2, c: any = b + 1): any { return [a, b, c].join(","); }
  const out: any = [];
  out.push(g(1));
  out.push(g(1, 5));
  out.push(g(1, undefined, 9));
  out.push(g(1, null, 9));
  out.push(g(0));
  return out.join("|");
}` },
  { name: "closure-capture-var", fn: "f", ts: `export function f(): any {
  const fns: any = [];
  for (var i = 0; i < 3; i++) fns.push(() => i);
  const out: any = [];
  out.push(fns.map((g: any) => g()).join(","));
  const fns2: any = [];
  for (let j = 0; j < 2; j++) { const k = j * 10; fns2.push(() => j + k); }
  out.push(fns2.map((g: any) => g()).join(","));
  return out.join("|");
}` },
  { name: "recursion-mutual", fn: "f", ts: `export function f(): any {
  function isEven(n: any): any { return n === 0 ? true : isOdd(n - 1); }
  function isOdd(n: any): any { return n === 0 ? false : isEven(n - 1); }
  const out: any = [];
  out.push(isEven(10) ? 1 : 0, isOdd(10) ? 1 : 0);
  const fact = (n: any): any => n <= 1 ? 1 : n * fact(n - 1);
  out.push(fact(5));
  return out.join("|");
}` },
  { name: "getter-setter-inherit-override", fn: "f", ts: `class A { get v(): any { return "A"; } m(): any { return this.v; } }
class B extends A { get v(): any { return "B" + super.v; } }
class C extends A { }
export function f(): any {
  return [new A().m(), new B().m(), new C().m()].join("|");
}` },
  { name: "static-block-order", fn: "f", ts: `class S {
  static a: any = initA();
  static b: any;
  static { S.b = S.a + 1; }
  static c: any = initC();
}
function initA(): any { return 5; }
function initC(): any { return S.b * 2; }
export function f(): any {
  return [S.a, S.b, S.c].join("|");
}` },
  { name: "private-fields-methods", fn: "f", ts: `class P {
  #n = 0;
  #inc(): any { this.#n++; return this.#n; }
  bump(): any { return this.#inc(); }
  static #s = 7;
  static getS(): any { return P.#s; }
}
export function f(): any {
  const p = new P();
  const out: any = [];
  out.push(p.bump(), p.bump());
  out.push(P.getS());
  out.push(Object.keys(p).join(","));
  return out.join("|");
}` },
];
