// 差分审计语料（第二十批）：错误类型/迭代协议/数值边界/切片语义/splice/描述符/作用域提升/运算符细节。
module.exports = [
  { name: "error-subclass-instanceof", fn: "f", ts: `class AppError extends Error { code: any; constructor(msg: any, code: any) { super(msg); this.code = code; this.name = "AppError"; } }
export function f(): any {
  const out: any = [];
  try { throw new AppError("bad", 42); }
  catch (e: any) { out.push(e.message, e.code, e.name, e instanceof AppError ? 1 : 0, e instanceof Error ? 1 : 0); }
  const e2: any = new TypeError("t");
  out.push(e2 instanceof TypeError ? 1 : 0, e2 instanceof Error ? 1 : 0, e2.name);
  out.push(new Error("m").message);
  return out.join("|");
}` },
  { name: "custom-iterable", fn: "f", ts: `class Range {
  lo: any; hi: any;
  constructor(lo: any, hi: any) { this.lo = lo; this.hi = hi; }
  [Symbol.iterator](): any {
    let i = this.lo; const hi = this.hi;
    return { next: () => (i <= hi ? { value: i++, done: false } : { value: undefined, done: true }) };
  }
}
export function f(): any {
  const out: any = [];
  const acc: any = [];
  for (const v of new Range(1, 3)) acc.push(v);
  out.push(acc.join(","));
  out.push([...new Range(5, 6)].join("-"));
  const it: any = new Range(8, 9)[Symbol.iterator]();
  out.push(it.next().value, it.next().value, it.next().done ? 1 : 0);
  return out.join("|");
}` },
  { name: "bitwise-negatives", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(-1 >>> 0, -2 >>> 1, -8 >> 1, -8 << 1);
  out.push(5 & 3, 5 | 3, 5 ^ 3, ~5);
  out.push(1 << 31, (1 << 31) >>> 0, 1 << 32, 1 << 33);
  out.push(0xff & 0x0f, 0x80000000 | 0);
  out.push(7 % 3, -7 % 3, 7.5 % 2, -0 % 5);
  return out.join("|");
}` },
  { name: "math-methods", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Math.abs(-3), Math.sign(-3), Math.sign(0), Math.trunc(4.7), Math.trunc(-4.7));
  out.push(Math.floor(-4.1), Math.ceil(-4.9), Math.round(2.5), Math.round(-2.5));
  out.push(Math.max(1, 5, 3), Math.min(1, 5, 3), Math.max(), Math.min());
  out.push(Math.hypot ? Math.hypot(3, 4) : "na", Math.cbrt(27), Math.log2(8), Math.log10(1000));
  out.push(Math.pow(2, 10), 2 ** 10, Math.sqrt(16), Math.exp(0));
  out.push(Math.PI > 3.14 ? 1 : 0, Math.E > 2.7 ? 1 : 0, Math.sqrt(-1) !== Math.sqrt(-1) ? 1 : 0);
  return out.join("|");
}` },
  { name: "string-slice-negatives", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s = "abcdef";
  out.push(s.slice(1, 3), s.slice(-2), s.slice(1, -1), s.slice(-100, 2));
  out.push(s.substring(2, 5), s.substring(5, 2), s.substring(-3, 2));
  out.push(s.substr ? s.substr(1, 3) : "na", s.substr ? s.substr(-2) : "na");
  out.push(s.startsWith("abc") ? 1 : 0, s.endsWith("def") ? 1 : 0, s.includes("cd") ? 1 : 0);
  out.push("x".localeCompare ? "x".localeCompare("y") < 0 ? 1 : 0 : "na");
  return out.join("|");
}` },
  { name: "array-splice-variants", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [1, 2, 3, 4, 5];
  out.push(JSON.stringify(a.splice(1, 2)), JSON.stringify(a));
  const b: any = [1, 2, 3];
  out.push(JSON.stringify(b.splice(1)), JSON.stringify(b));
  const c: any = [1, 4];
  c.splice(1, 0, 2, 3);
  out.push(c.join(","));
  const d: any = [1, 2, 3];
  const removed: any = d.splice(-2, 1, "x", "y");
  out.push(JSON.stringify(removed), JSON.stringify(d));
  out.push([1, 2, 3].slice(-2).join(","), [1, 2, 3].slice(1, -1).join(","));
  return out.join("|");
}` },
  { name: "array-nan-includes", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [1, NaN, 3];
  out.push(a.includes(NaN) ? 1 : 0, a.indexOf(NaN), a.includes(3) ? 1 : 0);
  out.push(a.indexOf(9), a.findIndex((x: any) => x !== x), a.join(","));
  out.push([undefined, null, 1].join("-"), [1, 2].concat("a" as any).length);
  out.push(Array.isArray(a) ? 1 : 0, Array.isArray("x") ? 1 : 0, Array.isArray({ length: 0 }) ? 1 : 0);
  out.push(new Array(3).length, [].length, [1, , 3].join("|"));
  return out.join("|");
}` },
  { name: "tostring-overrides", fn: "f", ts: `class Money {
  n: any;
  constructor(n: any) { this.n = n; }
  toString(): any { return "$" + this.n; }
  valueOf(): any { return this.n; }
}
class OnlyStr { toString(): any { return "S"; } }
export function f(): any {
  const out: any = [];
  const m = new Money(5);
  out.push("" + m, String(m), \`\${m}\`, m + 1, m * 2, m > 3 ? 1 : 0);
  out.push("" + new OnlyStr(), Number(new OnlyStr()));
  out.push([m, m].join(","));
  return out.join("|");
}` },
  { name: "private-methods-static", fn: "f", ts: `class Fmt {
  #sep: any = "-";
  static #count: any = 0;
  static bump(): any { Fmt.#count = Fmt.#count + 1; return Fmt.#count; }
  #join(a: any): any { return a.join(this.#sep); }
  run(a: any): any { return this.#join(a); }
  static make(): any { return new Fmt().run([1, 2, 3]); }
}
export function f(): any {
  const out: any = [];
  out.push(new Fmt().run(["a", "b"]), Fmt.make());
  out.push(Fmt.bump(), Fmt.bump(), new Fmt().run([9]));
  return out.join("|");
}` },
  { name: "define-property-descriptors", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = {};
  Object.defineProperty(o, "hidden", { value: 1, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(o, "visible", { value: 2, enumerable: true, writable: false, configurable: true });
  out.push(o.hidden, o.visible, Object.keys(o).join(","));
  const d: any = Object.getOwnPropertyDescriptor(o, "hidden");
  out.push(d.enumerable ? 1 : 0, d.writable ? 1 : 0, d.value);
  const sealed: any = Object.seal({ a: 1 });
  sealed.a = 2;
  out.push(sealed.a, Object.isSealed(sealed) ? 1 : 0, Object.isSealed({}) ? 1 : 0);
  return out.join("|");
}` },
  { name: "hoisting-and-scope", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(hoisted(), typeof later);
  function hoisted(): any { return "h"; }
  let later: any = 1;
  out.push(later);
  { const shadow = "inner"; out.push(shadow); }
  const shadow = "outer";
  out.push(shadow);
  for (let i = 0; i < 2; i++) { const k = i; if (i === 1) out.push(k); }
  out.push(typeof undefinedVar === "undefined" ? 1 : 0);
  return out.join("|");
}` },
  { name: "iife-and-mutual-recursion", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const v: any = (function (x: any) { return x * 2; })(21);
  out.push(v);
  const counter: any = (() => { let n = 0; return { inc: () => ++n, get: () => n }; })();
  counter.inc(); counter.inc();
  out.push(counter.get());
  function isEven(n: any): any { return n === 0 ? true : isOdd(n - 1); }
  function isOdd(n: any): any { return n === 0 ? false : isEven(n - 1); }
  out.push(isEven(4) ? 1 : 0, isOdd(4) ? 1 : 0, isEven(7) ? 1 : 0);
  return out.join("|");
}` },
  { name: "field-init-order", fn: "f", ts: `class A {
  a: any = this.get();
  b: any = 10;
  constructor() { this.c = 30; }
  c: any;
  get(): any { return 5; }
  order(): any { return this.a + this.b + this.c; }
}
export function f(): any {
  const out: any = [];
  const x = new A();
  out.push(x.a, x.b, x.c, x.order(), Object.keys(x).join(","));
  return out.join("|");
}` },
  { name: "static-inheritance", fn: "f", ts: `class Base { static tag: any = "B"; static get label(): any { return "L:" + this.tag; } static who(): any { return "who-" + this.tag; } }
class Sub extends Base { static tag2: any = "S"; }
export function f(): any {
  const out: any = [];
  out.push(Base.tag, Sub.tag, (Base as any).label, (Sub as any).label);
  out.push((Base as any).who(), (Sub as any).who());
  return out.join("|");
}` },
  { name: "destructure-nested-defaults", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const { a = 1, b: { c = 2 } = {} } = { a: 9 } as any;
  out.push(a, c);
  const [x = 5, [y = 6] = []] = [undefined] as any;
  out.push(x, y);
  const { p: { q = "d" } = { q: "dd" } } = {} as any;
  out.push(q);
  const { m = () => "f" } = {} as any;
  out.push(m());
  const [first, ...others] = [1, 2, 3];
  out.push(first, others.join(","));
  const { s, ...rest } = { s: 1, t: 2, u: 3 } as any;
  out.push(s, JSON.stringify(rest));
  return out.join("|");
}` },
  { name: "do-while-continue", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let i = 0;
  do { i++; if (i % 2 === 0) continue; out.push(i); } while (i < 5);
  let j = 5;
  do { j--; if (j === 3) break; } while (j > 0);
  out.push("j" + j);
  let k = 0;
  while (true) { k++; if (k < 3) continue; break; }
  out.push("k" + k);
  return out.join(",");
}` },
  { name: "ternary-and-comma", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a = 1 > 0 ? "y" : "n";
  out.push(a, (1, 2, 3), (0 ? "t" : 1 ? "u" : "v"));
  let x = 0;
  const y = (x = 5, x + 1);
  out.push(x, y);
  out.push(a === "y" ? (1 ? "aa" : "ab") : "z");
  const arr: any = [1, 2, 3];
  out.push(arr.length > 2 ? arr[2] : -1);
  return out.join("|");
}` },
  { name: "json-deep-unicode", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { list: [{ id: 1, tags: ["a", "b"] }, { id: 2, tags: [] }], meta: { total: 2, ok: true } };
  out.push(JSON.stringify(o));
  out.push(JSON.stringify(o, null, 0));
  out.push(JSON.parse(JSON.stringify(o)).list[0].tags.join(","));
  out.push(JSON.stringify({ u: "\\u00e9\\u4e2d" }), JSON.parse('"\\u00e9\\u4e2d"'));
  out.push(JSON.stringify({ esc: "a\\"b\\\\c\\nd" }));
  out.push(JSON.stringify([1, { a: [2, { b: 3 }] }]));
  return out.join("|");
}` },
  { name: "class-tostring-primitive", fn: "f", ts: `class P {
  constructor(public x: any, public y: any) {}
  toString(): any { return \`(\${this.x},\${this.y})\`; }
  add(o: any): any { return new P(this.x + o.x, this.y + o.y); }
  eq(o: any): any { return this.x === o.x && this.y === o.y; }
}
export function f(): any {
  const out: any = [];
  const p = new P(1, 2);
  const q = new P(3, 4);
  out.push(String(p), String(p.add(q)), p.add(q).eq(new P(4, 6)) ? 1 : 0);
  out.push([new P(0, 0), new P(1, 1)].map((v: any) => String(v)).join(";"));
  out.push(p.x, p.y, Object.keys(p).join(","));
  return out.join("|");
}` },
];
