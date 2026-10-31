// 差分审计语料（第二十七批）：类特性进阶（super/静态继承/getter-setter 副作用/计算属性 Symbol）/ JSON 边界 / RegExp 标志 / 运算符边角 / new.target / Error 子类 / 解构默认值 / spread 混用。
module.exports = [
  { name: "class-super-methods", fn: "f", ts: `class A { greet(): any { return "A.greet"; } base(): any { return "A.base " + this.tag(); } tag(): any { return "A"; } }
class B extends A { tag(): any { return "B"; } greet(): any { return "B.greet+" + super.greet(); } callbase(): any { return super.base(); } }
export function f(): any {
  const out: any = [];
  const b = new B();
  out.push(b.greet(), b.callbase(), b.tag(), b.base());
  out.push(new A().greet(), new A().tag());
  out.push(b instanceof A, b instanceof B, new A() instanceof B);
  return out.join("|");
}` },
  { name: "class-static-inheritance", fn: "f", ts: `class Base { static x: any = 1; static sx(): any { return "Base.sx"; } static get val(): any { return Base.x * 10; } }
class Derived extends Base { static x: any = 2; static dx(): any { return "Derived.dx+" + super.sx(); } }
export function f(): any {
  const out: any = [];
  out.push(Base.x, Base.sx(), Base.val);
  out.push(Derived.x, Derived.dx(), Derived.val, Derived.sx());
  out.push(Base.x = 10, Base.val, Derived.x, Derived.val);
  Base.x = 1; Derived.x = 2;
  out.push(Object.getPrototypeOf(Derived) === Base);
  return out.join("|");
}` },
  { name: "class-getter-setter-sidefx", fn: "f", ts: `class Counter { _v: any = 0; _log: any = [];
  get v(): any { this._log.push("get"); return this._v; }
  set v(x: any) { this._log.push("set:" + x); this._v = x; }
  inc(): any { this.v = this.v + 1; return this.v; } }
export function f(): any {
  const out: any = [];
  const c = new Counter();
  out.push(c.v, c.v = 5, c.v, c.inc(), c.v);
  out.push(c._log.join(","));
  return out.join("|");
}` },
  { name: "class-computed-symbol", fn: "f", ts: `const _iter: any = Symbol.iterator;
class Range { constructor(public from: any, public to: any) {} [_iter]() { let i = this.from; const end = this.to; return { next: () => i < end ? { value: i++, done: false } : { value: undefined, done: true } }; } }
export function f(): any {
  const out: any = [];
  const r = new Range(1, 4);
  for (const x of r) out.push(x);
  out.push([...new Range(5, 8)].join(","));
  const it: any = new Range(1, 3)[Symbol.iterator]();
  out.push(it.next().value, it.next().value, it.next().done);
  return out.join("|");
}` },
  { name: "class-private-fields", fn: "f", ts: `class Safe { #x: any = 10; #y: any = 20; get sum(): any { return this.#x + this.#y; } addToX(n: any): any { this.#x += n; return this.#x; } static #count: any = 0; static inst(): any { return ++Safe.#count; } }
export function f(): any {
  const out: any = [];
  const s = new Safe();
  out.push(s.sum, s.addToX(5), s.sum);
  out.push(Safe.inst(), Safe.inst(), Safe.inst());
  const s2 = new Safe();
  out.push(s2.sum, s.sum);
  return out.join("|");
}` },
  { name: "json-edge-values", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(JSON.stringify(undefined), JSON.stringify(null), JSON.stringify(NaN), JSON.stringify(Infinity));
  out.push(JSON.stringify([undefined, null, function() {}]), JSON.stringify({a: undefined, b: null, c: () => {}}));
  out.push(JSON.stringify({}), JSON.stringify([]), JSON.stringify(""), JSON.stringify(0));
  out.push(JSON.stringify({nested: {deep: {val: [1, "x", null, true]}}}));
  out.push(JSON.parse("[1, 2, 3]")[1], JSON.parse('{"a":1,"b":"x"}').b, JSON.parse("null"), JSON.parse("true"), JSON.parse("42"));
  out.push(JSON.parse('{"list":[1,2]}').list.length, JSON.parse('"hello"').length);
  out.push(JSON.stringify({ x: 1, y: 2 }, null, 0), JSON.stringify([1, 2, 3]));
  const o: any = { toJSON() { return { custom: 1 }; } };
  out.push(JSON.stringify(o));
  return out.join("|");
}` },
  { name: "regexp-flags-behavior", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const re: any = /ab/g;
  out.push(re.flags, re.source, re.global, re.ignoreCase, re.multiline);
  const re2: any = /x/i;
  out.push(re2.ignoreCase, re2.test("X"), re2.test("x"), re2.test("y"));
  const re3: any = /^a/m;
  out.push("a\nb".match(re3).length, re3.multiline);
  out.push("aaa".replace(/a/g, "b"), "aA".replace(/a/gi, "x"));
  out.push("2024-01".match(/(\\d+)-(\\d+)/).slice(1).join("-"));
  out.push("hello".split(/(?=[o])/).join("|"), "a1b2".match(/[a-z]\\d/g).join(","));
  out.push(/\\d+/.exec("abc123def")[0], /\\d+/.exec("abcdef") === null ? 1 : 0);
  out.push("test".replace(/t/g, (m: any, i: any) => i + m));
  return out.join("|");
}` },
  { name: "operator-corner", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let x: any = 2;
  out.push(x **= 3, x, x **= 0, x);
  x = 10; out.push(x %= 3, x, x <<= 2, x, x >>= 1, x);
  x = 5; out.push(x &= 3, x, x |= 8, x, x ^= 2, x, x >>>= 1, x);
  out.push(2 ** 3 ** 2, (-2) ** 2, 2 ** -2);   // -2 ** 2 是 JS 语法错误（一元前不得直接接 **），已删
  out.push(0.1 + 0.2, Math.round((0.1 + 0.2) * 1e9) / 1e9, 0.1 + 0.2 === 0.3);
  out.push(1 < 2 < 3, 3 > 2 > 1, 5 - 3 - 1, 10 - (5 - 3), 2 * 3 + 4, 2 + 3 * 4);
  out.push(true && false, true || false, !true && true, 1 && 2 && 3, 0 || "" || "d", null ?? "def");
  return out.join("|");
}` },
  { name: "new-target-error-sub", fn: "f", ts: `class E extends Error { constructor(msg: any, public code: any) { super(msg); this.name = "E"; } }
class E2 extends E { constructor(msg: any, code: any, public cause: any) { super(msg, code); } toString(): any { return this.name + ":" + this.code + ":" + this.message + ":" + this.cause; } }
export function f(): any {
  const out: any = [];
  const e = new E("boom", 42);
  out.push(e.message, e.code, e.name, e instanceof Error, e instanceof E);
  const e2 = new E2("fail", 7, "root");
  out.push(e2.message, e2.code, e2.cause, e2.toString(), e2 instanceof E, e2 instanceof Error);
  try { throw new E("thrown", 99); } catch (ex: any) { out.push(ex.code, ex.message); }
  out.push(new Error("plain").message, new Error("plain").name);
  return out.join("|");
}` },
  { name: "destructure-defaults-rest", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const fn = (a: any, b: any = 10, c: any = a + b) => [a, b, c];
  out.push(fn(1), fn(1, 2), fn(1, 2, 3), fn(5, undefined, 100));
  const obj: any = { x: 1, y: 2, z: 3, w: 4 };
  const { x, y = 99, ...rest } = obj;
  out.push(x, y, JSON.stringify(rest));
  const { a: aa = 5, b: bb = 6 } = { a: 1 } as any;
  out.push(aa, bb);
  const [p = 1, q = 2, r = 3] = [10, undefined];
  out.push(p, q, r);
  const [, , third, , fifth] = [1, 2, 3, 4, 5];
  out.push(third, fifth);
  const { nested: { deep = 42 } } = { nested: {} } as any;
  out.push(deep);
  const [first, ...others] = [1, 2, 3, 4];
  out.push(first, others.join(","));
  return out.join("|");
}` },
  { name: "spread-mixed-calls", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const sum = (...args: any) => args.reduce((a: any, b: any) => a + b, 0);
  const nums = [1, 2, 3];
  out.push(sum(...nums), sum(...nums, 4), sum(0, ...nums), sum(...nums, ...[4, 5]));
  out.push(Math.max(...nums, 10, ...[20, 5]), Math.min(100, ...nums, 0));
  const arr: any = [1, 2, 3];
  out.push([0, ...arr, 4].join(","), [...arr, ...arr].join(","));
  const fn2 = (a: any, b: any, c: any) => a + b + c;
  out.push(fn2(...[1, 2, 3]), fn2(...[1], 2, 3));
  out.push([..."abc"].join(""), [..."ab", ..."cd"].join(""));
  const obj: any = { a: 1, b: 2 };
  out.push(JSON.stringify({ ...obj, c: 3 }), JSON.stringify({ ...obj, ...{ b: 9, d: 4 } }));
  out.push(sum(), sum(5), sum(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
  return out.join("|");
}` },
  { name: "object-create-proto", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const proto = { greet() { return "hi"; }, type: "proto" };
  const o: any = Object.create(proto);
  out.push(o.greet(), o.type, Object.getPrototypeOf(o) === proto);
  const o2: any = Object.create(proto, { x: { value: 5, enumerable: true }, y: { value: 6, enumerable: false } });
  out.push(o2.greet(), o2.x, o2.y, Object.keys(o2).join(","), Object.getOwnPropertyNames(o2).join(","));
  const o3: any = Object.create(null);
  out.push(Object.getPrototypeOf(o3) === null, o3.__proto__ === undefined ? 1 : 0);
  o3.custom = 1;
  out.push(JSON.stringify(o3), Object.keys(o3).join(","));
  const arr = Object.create(Array.prototype);
  arr[0] = 1; arr[1] = 2; arr.length = 2;
  out.push(arr.length, arr.join(","), Array.isArray(arr));
  return out.join("|");
}` },
  { name: "getter-chains-deep", fn: "f", ts: `const chain = { _v: 1, get a() { return { _v: 2, get b() { return { _v: 3, get c() { return this._v; } }; } }; } };
export function f(): any {
  const out: any = [];
  out.push(chain.a.b.c);
  out.push(chain.a.b._v, chain.a._v);
  const obj: any = { get x() { return 10; }, get y() { return this.x * 2; }, get z() { return this.y + 1; } };
  out.push(obj.x, obj.y, obj.z);
  const lazy: any = { _cache: null, get computed() { if (this._cache === null) this._cache = { n: 42 }; return this._cache; } };
  out.push(lazy.computed.n, lazy.computed.n, lazy._cache === lazy.computed);
  return out.join("|");
}` },
  { name: "try-finally-return", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const g = () => { try { return "try"; } finally { out.push("fin"); } };
  out.push(g());
  const g2 = () => { try { throw "e"; } catch (e: any) { return "caught:" + e; } finally { out.push("fin2"); } };
  out.push(g2());
  const g3 = () => { let v = 0; try { v = 1; throw "x"; } catch (e: any) { v = 2; return v; } finally { v = 3; out.push("v=" + v); } return v; };
  out.push(g3());
  const g4 = () => { try { try { return "inner"; } finally { out.push("inner-fin"); } } finally { out.push("outer-fin"); } };
  out.push(g4());
  let ran = false;
  const g5 = () => { try { return 1; } finally { ran = true; } };
  out.push(g5(), ran);
  return out.join("|");
}` },
  { name: "instanceof-custom-hasinstance", fn: "f", ts: `class Even { static [Symbol.hasInstance](x: any) { return typeof x === "number" && x % 2 === 0; } }
class Odd { static [Symbol.hasInstance](x: any) { return typeof x === "number" && x % 2 === 1; } }
export function f(): any {
  const out: any = [];
  out.push(4 instanceof Even, 5 instanceof Even, 7 instanceof Odd, 8 instanceof Odd);
  out.push("x" instanceof Even, 0 instanceof Even);
  class A {} class B extends A {} class C extends B {}
  const c = new C();
  out.push(c instanceof C, c instanceof B, c instanceof A, c instanceof Object);
  out.push([] instanceof Array, [] instanceof Object, {} instanceof Object, "s" instanceof String);
  out.push((x: any) => x instanceof Function);
  return out.join("|");
}` },
  { name: "array-methods-chained", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const data: any = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  out.push(data.filter((x: any) => x % 2 === 0).map((x: any) => x * 10).join(","));
  out.push(data.map((x: any) => x * x).reduce((a: any, b: any) => a + b, 0));
  out.push(data.slice(2, 5).join(","), data.slice(-3).join(","));
  out.push(data.filter((x: any) => x > 5).length, data.find((x: any) => x > 5));
  out.push([...data].reverse().join(","), data.join("-"));
  out.push(data.some((x: any) => x > 9), data.every((x: any) => x > 0));
  const nested: any = [[1, 2], [3, 4], [5, 6]];
  out.push(nested.map((a: any) => a.reduce((x: any, y: any) => x + y, 0)).join(","));
  out.push(data.filter((x: any, i: any) => i < 3).map((x: any) => x + 100).join(","));
  return out.join("|");
}` },
  { name: "string-template-coerce", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const n = 5, s = "hi", b = true, arr = [1, 2, 3], obj: any = { x: 1 };
  out.push(\`\${n}\`, \`\${s}\`, \`\${b}\`, \`\${arr}\`, \`\${obj}\`, \`\${null}\`, \`\${undefined}\`);
  out.push(\`n=\${n} s=\${s} b=\${b}\`, \`\${n + 1}\`, \`\${n > 3 ? "big" : "sml"}\`);
  out.push(\`\${1 + 2}\` + \`\${3 * 4}\`, \`\${[1, 2, 3].join("-")}\`);
  out.push(\`\${typeof n}\`, \`\${typeof s}\`, \`\${typeof arr}\`);
  out.push(\`\\n\`, \`\\t\`, \`\\\`\`, \`\\\${x}\`);
  out.push(\`\${"a"}\${"b"}\${"c"}\`, \`\${0}\${1}\${2}\`);
  out.push(\`\${obj.x}\${obj.x + 1}\`, \`\${arr.length}\${arr[0]}\`);
  out.push(\`\${{ a: 1 }.a}\`, \`\${[1, 2][1]}\`, \`\${(function () { return 42; })()}\`);
  return out.join("|");
}` },
  { name: "closure-capture-mutation", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const makers: any = [];
  for (let i = 0; i < 3; i++) makers.push(() => i);
  out.push(makers.map((m: any) => m()).join(","));
  const counters: any = [];
  for (let i = 0; i < 3; i++) { let c = i * 10; counters.push({ get: () => c, inc: () => c++ }); }
  out.push(counters.map((c: any) => c.get()).join(","), counters[0].inc(), counters[0].inc(), counters[0].get());
  let x = 1;
  const g = () => x; const h = () => { x = 100; };
  out.push(g(), h(), g());
  const factory = (n: any) => (m: any) => n + m;
  const add5 = factory(5);
  out.push(add5(3), add5(10), factory(10)(1));
  return out.join("|");
}` },
  { name: "in-operator-types", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: 2, 3: "three" };
  out.push("a" in o, "b" in o, "c" in o, 3 in o, "3" in o);
  const arr: any = [10, 20, 30];
  out.push(0 in arr, 2 in arr, 3 in arr, 5 in arr, "length" in arr);
  out.push("x" in { x: 1 }, "toString" in {}, "toString" in { toString: 1 });
  const proto: any = { inherited: 1 };
  const child: any = Object.create(proto);
  out.push("inherited" in child, "missing" in child);
  out.push("constructor" in {}, "valueOf" in {});
  return out.join("|");
}` },
  { name: "number-method-edge", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push((255).toString(16), (255).toString(2), (255).toString(8), (0).toString(16), (-255).toString(16));
  out.push((3.14159).toFixed(2), (3.14159).toFixed(0), (0.5).toFixed(0), (1.005).toFixed(2), (1234.5678).toFixed(1));
  out.push((1000).toExponential(2), (0.0001234).toExponential(2));
  out.push((123.456).toPrecision(2), (123.456).toPrecision(6), (0.0001).toPrecision(2));
  out.push(Number("3.14"), Number("0xFF"), Number("1e3"), Number("  42  "), Number("abc"));
  out.push(parseInt("100", 2), parseInt("ff", 16), parseInt("777", 8), parseInt("99", 10));
  out.push(parseFloat("3.14xyz"), parseFloat("0.001"), parseFloat("1e10"), parseFloat("Infinity"));
  out.push(Number.isInteger(3.0), Number.isInteger(3.5), Number.isFinite(Infinity), isFinite("100"));
  return out.join("|");
}` },
  { name: "object-keys-entries-values", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { c: 3, a: 1, b: 2, 2: "two", 1: "one" };
  out.push(Object.keys(o).join(","), Object.values(o).join(","), Object.entries(o).map((e: any) => e.join(":")).join(","));
  const o2: any = Object.fromEntries(Object.entries(o).map(([k, v]: any) => [k, v]));
  out.push(JSON.stringify(o2), Object.keys(o2).join(","));
  out.push(Object.keys({}).length, Object.values({}).length, Object.entries({}).length);
  const o3: any = { x: 1, y: 2 };
  out.push(JSON.stringify(Object.keys(o3)), JSON.stringify(Object.values(o3)));
  out.push(Object.entries({ a: 1 }).length, Object.entries({ a: 1, b: 2, c: 3 }).length);
  const arr: any = [10, 20, 30];
  out.push(Object.keys(arr).join(","), Object.values(arr).join(","), Object.entries(arr).map((e: any) => e.join("=")).join(","));
  return out.join("|");
}` },
];