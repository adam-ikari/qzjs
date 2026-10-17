// 差分审计语料（第三十批）：mixin（类表达式 + extends）、ES2023 数组方法、Object.getOwnPropertyDescriptors、私有品牌检查、描述符/冻结深、静态初始化序、自定义迭代器协议、嵌套箭头 this、JSON 边界、错误子类 instanceof、柯里化类工厂。
module.exports = [
  { name: "mixin-class-factory", fn: "f", ts: `class Base { hello(): any { return "base"; } }
const Tagged = (Base2: any) => class extends Base2 { tag(): any { return "tagged"; } };
const Counted = (Base2: any) => class extends Base2 { count: any = 0; inc(): any { return ++this.count; } };
class Final extends Counted(Tagged(Base)) {}
export function f(): any {
  const out: any = [];
  const x = new Final();
  out.push(x.hello(), x.tag(), x.inc(), x.inc(), x.count);
  out.push(x instanceof Final, x instanceof Base);
  out.push(typeof Tagged, typeof Counted);
  const T = Tagged(Base);
  const y: any = new T();
  out.push(y.hello(), y.tag(), y instanceof Base);
  return out.join("|");
}` },
  { name: "es2023-array-methods", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [3, 1, 2];
  if (typeof a.toSorted === "function") {
    out.push(a.toSorted().join(","), a.toSorted((x: any, y: any) => y - x).join(","), a.join(","));
  } else out.push("na", "na", "na");
  if (typeof a.toReversed === "function") { out.push(a.toReversed().join(","), a.join(",")); } else out.push("na", "na");
  if (typeof a.with === "function") { out.push(a.with(1, 99).join(","), a.with(-1, 0).join(","), a.join(",")); } else out.push("na", "na", "na");
  out.push(a.slice().sort().join(","), [...a].reverse().join(","));
  return out.join("|");
}` },
  { name: "object-descriptors", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: 2 };
  const d: any = Object.getOwnPropertyDescriptors ? Object.getOwnPropertyDescriptors(o) : null;
  out.push(d ? Object.keys(d).join(",") : "na");
  out.push(d ? d.a.value : "na", d ? d.a.enumerable : "na", d ? d.a.writable : "na");
  const frozen: any = Object.freeze({ x: 1 });
  out.push(Object.isFrozen(frozen), Object.isFrozen({}), Object.isFrozen(frozen.x));
  const deep: any = { inner: { k: 1 } };
  Object.freeze(deep);
  out.push(Object.isFrozen(deep), Object.isFrozen(deep.inner), Object.isSealed(deep));
  out.push(Object.keys(o).join(","), Object.getOwnPropertyNames(o).join(","));
  return out.join("|");
}` },
  { name: "private-brand-check", fn: "f", ts: `class Validator { #value: any = 42; static isValidator(x: any): any { return #value in x; } get value(): any { return this.#value; } }
export function f(): any {
  const out: any = [];
  const v = new Validator();
  out.push(Validator.isValidator(v), Validator.isValidator({}), Validator.isValidator(null));
  out.push(v.value, Validator.isValidator(new Validator()));
  class Sub extends Validator {}
  out.push(Validator.isValidator(new Sub()));
  return out.join("|");
}` },
  { name: "custom-iterator-protocol", fn: "f", ts: `class Range { constructor(public from: any, public to: any) {} [Symbol.iterator](): any { let i = this.from; const to = this.to; return { next: () => i < to ? { value: i++, done: false } : { value: undefined, done: true }, return: () => { return { done: true }; } }; } }
export function f(): any {
  const out: any = [];
  out.push([...new Range(1, 4)].join(","), [...new Range(0, 0)].length);
  for (const x of new Range(5, 8)) out.push(x);
  const it: any = new Range(1, 3)[Symbol.iterator]();
  out.push(it.next().value, it.next().value, it.next().done);
  out.push(Array.from(new Range(1, 4)).length);
  const [p, q] = new Range(10, 20);
  out.push(p, q);
  return out.join("|");
}` },
  { name: "nested-arrow-this", fn: "f", ts: `class Obj { v: any = 10; get(): any { const f = () => () => () => this.v; return f()()(); } mapArr(): any { return [1, 2, 3].map((x: any) => x + this.v); } sum(): any { let s = 0; [1, 2].forEach((x: any) => { [10, 20].forEach((y: any) => { s += x + y + this.v; }); }); return s; } }
export function f(): any {
  const out: any = [];
  const o = new Obj();
  out.push(o.get(), o.mapArr().join(","), o.sum());
  out.push([1].map(() => this === undefined ? "u" : "t").join(""));
  const ctx: any = { v: 5, get(): any { return (() => this.v)(); } };
  out.push(ctx.get());
  return out.join("|");
}` },
  { name: "static-init-order", fn: "f", ts: `class C { static a: any = 1; static b: any = C.a + 1; static { C.c = C.b + 1; } static d: any = C.c * 2; }
export function f(): any {
  const out: any = [];
  out.push(C.a, C.b, C.c, C.d);
  out.push(C.a + C.b + C.c + C.d);
  class D { static s: any = []; static { D.s.push("block1"); } static x: any = D.s.push("field") && D.s.length; static { D.s.push("block2"); } }
  out.push(D.s.join(","), D.x);
  return out.join("|");
}` },
  { name: "error-subclass-instanceof", fn: "f", ts: `class AppError extends Error { constructor(msg: any, public code: any) { super(msg); this.name = "AppError"; } }
class NotFound extends AppError { constructor(msg: any) { super(msg, 404); this.name = "NotFound"; } }
export function f(): any {
  const out: any = [];
  const e = new NotFound("missing");
  out.push(e.message, e.code, e.name, e instanceof NotFound, e instanceof AppError, e instanceof Error);
  out.push(Object.getPrototypeOf(e) === NotFound.prototype);
  out.push(e.constructor === NotFound, e.constructor.name);
  try { throw e; } catch (x: any) { out.push(x instanceof Error, x.code, x.message); }
  const plain = new AppError("bad", 500);
  out.push(plain instanceof NotFound, plain instanceof AppError, plain.toString().indexOf("AppError: bad") === 0);
  return out.join("|");
}` },
  { name: "json-edge-proto", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
  out.push(o.a, ({} as any).polluted === undefined ? 1 : 0, Object.keys(o).join(","));
  out.push(JSON.stringify({ a: 1, b: [1, 2, { c: 3 }] }));
  out.push(JSON.stringify({ s: "a\\"b\\\\c", n: "\\n\\t", u: "\\u00e9" }));
  out.push(JSON.parse('"\\u00e9"').length, JSON.parse('{"n":1.5e3}').n, JSON.parse('{"b":true,"z":null}').b);
  out.push(JSON.stringify([1, 2], null, 1), JSON.stringify({ x: 1 }, null, 1));
  const circ: any = { a: 1 }; circ.self = circ;
  try { JSON.stringify(circ); out.push("nothrow"); } catch (e: any) { out.push(e instanceof TypeError ? "TypeError" : "other"); }
  out.push(JSON.stringify(new Date(0)) !== undefined, JSON.stringify({ d: new Date(0) }).indexOf("T") > 0);
  return out.join("|");
}` },
  { name: "curried-class-factory", fn: "f", ts: `const withVersion = (v: any) => (Base: any) => class extends Base { version(): any { return v; } };
const withName = (n: any) => (Base: any) => class extends Base { theName(): any { return n; } };
class Root { root(): any { return "root"; } }
const Mid = withVersion("1.0")(withName("mid")(Root));
export function f(): any {
  const out: any = [];
  const m = new Mid();
  out.push(m.root(), m.version(), m.theName());
  out.push(m instanceof Root, m instanceof Mid);
  const V = withVersion("2.0")(Root);
  const v: any = new V();
  out.push(v.root(), v.version());
  out.push(typeof withVersion, typeof withVersion("x"));
  return out.join("|");
}` },
  { name: "optional-chain-assign-mix", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: { b: 1 }, arr: [1, 2] };
  out.push(o.a?.b, o.x?.y, o.arr?.[0], o.arr?.[5], o?.fn?.());
  let v: any = null;
  v ??= "default"; out.push(v);
  v ??= "other"; out.push(v);
  let w: any = 0;
  w ||= 5; out.push(w);
  let z: any = 1;
  z &&= 9; out.push(z);
  const obj: any = { n: 0, get g(): any { return this.n; }, set g(x: any) { this.n = x; } };
  obj.g ??= 7; out.push(obj.n, obj.g);
  const deep: any = {};
  (deep.a ??= {}).b = 1;
  out.push(JSON.stringify(deep));
  return out.join("|");
}` },
  { name: "array-holes-vs-undefined", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const h: any = [1, , 3];
  const u: any = [1, undefined, 3];
  out.push(h.length, u.length, h[1] === undefined, u[1] === undefined);
  out.push(1 in h, 1 in u, Object.keys(h).join(","), Object.keys(u).join(","));
  out.push(h.map((x: any) => x).length, JSON.stringify(h), JSON.stringify(u));
  out.push(h.filter(() => true).length, u.filter(() => true).length);
  out.push([...h].length, h.indexOf(undefined), u.indexOf(undefined));
  const s: any = new Array(3);
  out.push(s.length, s.map((x: any) => 1).length, Object.keys(s).length);
  return out.join("|");
}` },
  { name: "getter-setter-pairs", fn: "f", ts: `class Temp { _c: any = 0; get celsius(): any { return this._c; } set celsius(v: any) { this._c = v; } get fahrenheit(): any { return this._c * 9 / 5 + 32; } set fahrenheit(v: any) { this._c = (v - 32) * 5 / 9; } get both(): any { return this._c + "/" + this.fahrenheit; } }
export function f(): any {
  const out: any = [];
  const t = new Temp();
  out.push(t.celsius, t.fahrenheit, t.both);
  t.celsius = 100;
  out.push(t.celsius, t.fahrenheit, t.both);
  t.fahrenheit = 32;
  out.push(t.celsius, t.fahrenheit, t.both);
  const keys: any = [];
  for (const k in t) keys.push(k);
  out.push(keys.join(","), JSON.stringify(t));
  out.push(Object.getOwnPropertyNames(Temp.prototype).sort().join(","));
  return out.join("|");
}` },
  { name: "spread-getter-eval", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const src: any = { get a() { out.push("getA"); return 1; }, b: 2 };
  const copy: any = { ...src };
  out.push(JSON.stringify(copy), out.join(","));
  out.length = 0;
  const merged: any = { ...src, ...{ c: 3 }, a: 9 };
  out.push(JSON.stringify(merged), out.join(","));
  out.length = 0;
  function take(o: any): any { return JSON.stringify(o); }
  out.push(take({ ...src }), out.join(","));
  out.length = 0;
  const arr: any = [1, 2];
  out.push(JSON.stringify({ ...arr }), JSON.stringify([...arr]));
  out.push(JSON.stringify({ ..."ab" }), JSON.stringify({ ...[1, 2] }));
  return out.join("|");
}` },
  { name: "closure-counter-patterns", fn: "f", ts: `const makeCounter = (): any => { let n = 0; return { inc: () => ++n, dec: () => --n, get: () => n, reset: () => { n = 0; } }; };
const makeAdder = (x: any): any => (y: any) => x + y;
const once = (fn: any): any => { let called = false, res: any; return (...a: any) => { if (!called) { called = true; res = fn(...a); } return res; }; };
export function f(): any {
  const out: any = [];
  const c = makeCounter();
  out.push(c.inc(), c.inc(), c.dec(), c.get(), c.reset(), c.get());
  const add5 = makeAdder(5);
  out.push(add5(1), add5(2), makeAdder(10)(3));
  let calls = 0;
  const o = once((x: any) => { calls++; return x * 2; });
  out.push(o(5), o(5), o(9), calls);
  const memo: any = {};
  const fibM = (n: any): any => n < 2 ? n : (memo[n] !== undefined ? memo[n] : (memo[n] = fibM(n - 1) + fibM(n - 2)));
  out.push(fibM(20), Object.keys(memo).length > 0);
  return out.join("|");
}` },
  { name: "string-methods-matrix2", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s = "Hello, World";
  out.push(s.split(", ").join("|"), s.replace(",", ";"), s.indexOf("o"), s.lastIndexOf("o"));
  out.push(s.slice(0, 5), s.slice(-5), s.substring(7), s.substr(7, 5));
  out.push(s.toUpperCase().toLowerCase(), s.repeat(1), s.padEnd(15, "."));
  out.push("a-b-c".split("-").reverse().join("-"), "x".concat("y", "z"));
  out.push("  pad  ".trim().length, "ABC".localeCompare("abc") !== 0, "abc".localeCompare("abc") === 0);
  out.push("a1b2c3".replace(/\\d/g, "#"), "a1b2c3".split(/\\d/).join("|"));
  out.push("Hello".startsWith("He"), "Hello".endsWith("lo"), "Hello".includes("ell"));
  out.push(String.fromCharCode(97, 98, 99), "abc".charCodeAt(1), "abc".codePointAt(1));
  return out.join("|");
}` },
  { name: "numeric-formatting", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push((1234.5678).toFixed(2), (0.0001234).toFixed(8), (1e21).toString(), (1e-7).toString());
  out.push((255).toString(16), (255).toString(2), (255).toString(8), (255).toString(36));
  out.push((123.456).toPrecision(4), (123.456).toExponential(2));
  out.push(Number("1e3"), Number("0b101"), Number("0o17"), Number("0x1f"), Number("  42  "));
  out.push(parseInt("42px"), parseFloat("42.5px"), parseInt("ff", 16), parseInt("z", 36));
  out.push(Number.MAX_SAFE_INTEGER, Number.EPSILON, Number.MIN_SAFE_INTEGER);
  out.push(Number.isInteger(1.0), Number.isSafeInteger(2 ** 53), Number.isSafeInteger(2 ** 53 - 1));
  out.push((0.1).toFixed(20).length > 0, (-0).toString(), (1 / -0) === -Infinity);
  return out.join("|");
}` },
  { name: "inheritance-chains-deep", fn: "f", ts: `class L1 { a(): any { return "L1a"; } common(): any { return "L1"; } }
class L2 extends L1 { b(): any { return "L2b"; } common(): any { return "L2+" + super.common(); } }
class L3 extends L2 { c(): any { return "L3c"; } common(): any { return "L3+" + super.common(); } }
class L4 extends L3 { d(): any { return "L4d"; } }
export function f(): any {
  const out: any = [];
  const x = new L4();
  out.push(x.a(), x.b(), x.c(), x.d(), x.common());
  out.push(x instanceof L1, x instanceof L2, x instanceof L3, x instanceof L4);
  let protoCount = 0; let p = Object.getPrototypeOf(x);
  while (p && p !== Object.prototype) { protoCount++; p = Object.getPrototypeOf(p); }
  out.push(protoCount);
  out.push(Object.getPrototypeOf(L4) === L3, Object.getPrototypeOf(L2.prototype) === L1.prototype);
  return out.join("|");
}` },
  { name: "mixed-pipeline-realistic", fn: "f", ts: `type Row = { name: any; score: any; tags: any };
const rows: any = [
  { name: "alice", score: 90, tags: ["a", "b"] },
  { name: "bob", score: 60, tags: ["b"] },
  { name: "carol", score: 75, tags: ["c", "a"] },
  { name: "dave", score: 45, tags: [] },
];
const byScore = (min: any) => (r: any) => r.score >= min;
const nameOf = (r: any) => r.name;
const tally = (acc: any, r: any) => { r.tags.forEach((t: any) => { acc[t] = (acc[t] || 0) + 1; }); return acc; };
export function f(): any {
  const out: any = [];
  out.push(rows.filter(byScore(70)).map(nameOf).join(","));
  out.push(rows.map((r: any) => r.score).reduce((a: any, b: any) => a + b, 0));
  out.push(JSON.stringify(rows.reduce(tally, {})));
  const sorted: any = rows.slice().sort((a: any, b: any) => b.score - a.score).map(nameOf);
  out.push(sorted.join(">"));
  out.push(rows.find((r: any) => r.score < 50).name, rows.findIndex((r: any) => r.name === "carol"));
  out.push(rows.every((r: any) => r.score > 0), rows.some((r: any) => r.score > 85));
  out.push(rows.map((r: any) => r.name.length).join(""), rows.reduce((a: any, r: any) => a + r.tags.length, 0));
  return out.join("|");
}` },
  { name: "try-catch-finallly-realistic", fn: "f", ts: `const parse = (s: any): any => { try { const v: any = JSON.parse(s); return { ok: true, v }; } catch (e: any) { return { ok: false, err: e instanceof SyntaxError ? "syntax" : "other" }; } finally { /* 清理 */ } };
export function f(): any {
  const out: any = [];
  out.push(JSON.stringify(parse('{"a":1}')), JSON.stringify(parse("{bad}")));
  out.push(parse('{"b":2}').v.b, parse("nope").ok);
  const out2: any = [];
  const risky = (n: any): any => { try { if (n < 0) throw new RangeError("neg"); return n * 2; } catch (e: any) { out2.push(e.name); return -1; } finally { out2.push("fin" + n); } };
  out.push(risky(5), risky(-5), risky(0));
  out.push(out2.join(","));
  const nested = (): any => { try { try { throw "inner"; } finally { out2.push("innerfin"); } } catch (e: any) { out2.push("caught:" + e); } finally { out2.push("outerfin"); } return out2.length; };
  out.push(nested());
  return out.join("|");
}` },
];