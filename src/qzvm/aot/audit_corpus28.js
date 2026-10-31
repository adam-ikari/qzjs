// 差分审计语料（第二十八批）：Map/Set 方法 / Object freeze-seal / Reflect construct-ownKeys / String matchAll-substring / Math 三角与常量 / JSON replacer-reviver / Symbol for-keyFor / catch 无绑定 / 数组 reduceRight-keys-values / 动态键赋值 / 类 extends null / super 构造。
module.exports = [
  { name: "map-methods-full", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const m: any = new Map([["a", 1], ["b", 2]]);
  out.push(m.get("a"), m.get("b"), m.get("c") === undefined ? 1 : 0, m.has("a"), m.has("c"));
  m.set("c", 3); m.set("a", 10);
  out.push(m.get("a"), m.get("c"), m.size);
  m.delete("b");
  out.push(m.size, m.has("b"), m.get("b") === undefined ? 1 : 0);
  out.push([...m.keys()].join(","), [...m.values()].join(","), [...m.entries()].map((e: any) => e.join(":")).join(","));
  m.forEach((v: any, k: any) => out.push(k + "=" + v));
  out.push([...m].map((e: any) => e.join(":")).join("|"));
  const m2: any = new Map();
  out.push(m2.size);
  return out.join(",");
}` },
  { name: "set-methods-full", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s: any = new Set([3, 1, 2, 3, 1]);
  out.push(s.size, s.has(1), s.has(4), [...s].join(","));
  s.add(4); s.add(1);
  out.push(s.size, [...s].join(","));
  s.delete(2);
  out.push(s.size, s.has(2), [...s].join(","));
  const entries: any = [];
  s.forEach((v: any) => entries.push(v));
  out.push(entries.join(","));
  out.push([...s.entries()].map((e: any) => e.join("=")).join(","));
  out.push([...s.keys()].join(","), [...s.values()].join(","));
  const s2: any = new Set("abc");
  out.push(s2.size, [...s2].join(","));
  return out.join("|");
}` },
  { name: "object-freeze-seal", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = Object.freeze({ a: 1 });
  out.push(Object.isFrozen(o), Object.isSealed(o), Object.isExtensible(o));
  const o2: any = Object.seal({ b: 2 });
  out.push(Object.isFrozen(o2), Object.isSealed(o2), Object.isExtensible(o2));
  o2.b = 3; out.push(o2.b);
  const o3: any = { c: 5 };
  Object.preventExtensions(o3);
  out.push(Object.isExtensible(o3), Object.isSealed(o3));
  o3.c = 10; o3.d = 20;
  out.push(o3.c, o3.d === undefined ? 1 : 0);
  const arr: any = Object.freeze([1, 2, 3]);
  out.push(Object.isFrozen(arr), Object.isSealed(arr), arr.length);
  const frozen: any = Object.freeze({ x: 1 });
  out.push(JSON.stringify(frozen), frozen.x);
  return out.join("|");
}` },
  { name: "reflect-construct-ownkeys", fn: "f", ts: `export function f(): any {
  const out: any = [];
  class P { constructor(a: any, b: any) { this.a = a; this.b = b; } sum(): any { return this.a + this.b; } }
  const obj: any = Reflect.construct(P, [3, 4]);
  out.push(obj.a, obj.b, obj.sum(), obj instanceof P);
  out.push(Reflect.ownKeys({ a: 1, b: 2, 3: "x" }).join(","));
  out.push(Reflect.getPrototypeOf([]) === Array.prototype ? 1 : 0, Reflect.getPrototypeOf({}) === Object.prototype ? 1 : 0);
  const o: any = { x: 1 };
  out.push(Reflect.setPrototypeOf(o, { y: 2 }), o.y, Reflect.getPrototypeOf(o) !== Object.prototype ? 1 : 0);
  const sym: any = Symbol("s");
  const o2: any = { [sym]: 99, a: 1 };
  out.push(Reflect.ownKeys(o2).length, Reflect.get(o2, sym), Reflect.has(o2, "a"));
  return out.join("|");
}` },
  { name: "string-matchall-substr", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s = "Hello World";
  out.push(s.substring(0, 5), s.substring(6), s.substring(-3, 5), s.substring(5, 2));
  out.push(s.substr(0, 5), s.substr(6), s.substr(-5), s.substr(1, 3));
  out.push(s.slice(0, 5), s.slice(6), s.slice(-5), s.slice(-5, -1));
  out.push(s.indexOf("o"), s.lastIndexOf("o"), s.indexOf("o", 5));
  const matches: any = [...s.matchAll(/[oO]/g)];
  out.push(matches.length, matches.map((m: any) => m.index).join(","));
  out.push(s.localeCompare("Hello World") === 0 ? 1 : 0, "abc".localeCompare("abd") < 0 ? 1 : 0);
  out.push("a,b,c".split(",").join("-"), "hello".toUpperCase().split("").reverse().join(""));
  out.push("  trim  ".trim().length, "test123".replace(/\\d+/, "NUM"));
  return out.join("|");
}` },
  { name: "math-trig-constants", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Math.round(Math.PI * 100) / 100, Math.round(Math.E * 100) / 100);
  out.push(Math.round(Math.sin(0) * 1000) / 1000, Math.round(Math.cos(0) * 1000) / 1000);
  out.push(Math.round(Math.sin(Math.PI / 2) * 1000) / 1000);
  out.push(Math.round(Math.tan(0) * 1000) / 1000);
  out.push(Math.abs(-5), Math.ceil(1.1), Math.floor(1.9), Math.round(2.5), Math.round(-2.5));
  out.push(Math.max(1, 2, 3), Math.min(1, 2, 3), Math.max(...[5, 3, 8]), Math.min(...[5, 3, 8]));
  out.push(Math.pow(2, 10), Math.sqrt(144), Math.cbrt(27), Math.abs(-Infinity));
  out.push(Math.round(Math.log(Math.E) * 1000) / 1000, Math.round(Math.exp(0) * 1000) / 1000);
  out.push(Math.round(Math.log10(1000) * 1000) / 1000, Math.round(Math.log2(1024) * 1000) / 1000);
  out.push(Math.sign(-5), Math.sign(0), Math.sign(5), Math.sign(-0) === -0 ? 1 : 0);
  out.push(Math.hypot(3, 4), Math.hypot(5, 12), Math.round(Math.atan2(1, 1) * 100) / 100);
  return out.join("|");
}` },
  { name: "json-replacer-reviver", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: 2, c: 3 };
  out.push(JSON.stringify(o, ["b", "a"]), JSON.stringify(o, (k: any, v: any) => k === "b" ? undefined : v));
  out.push(JSON.stringify({ x: 1, y: 2 }, null, 0), JSON.stringify({ x: 1 }, null, 2));
  const parsed: any = JSON.parse('{"a":1,"b":2}', (k: any, v: any) => typeof v === "number" ? v * 10 : v);
  out.push(parsed.a, parsed.b);
  out.push(JSON.stringify([1, 2, 3], null, 1), JSON.stringify({ nested: { a: [1, 2] } }, null, 0));
  out.push(JSON.stringify(undefined), JSON.stringify(null), JSON.stringify(NaN), JSON.stringify(Infinity));
  out.push(JSON.stringify({ fn: () => 1, u: undefined, n: null }), JSON.stringify([undefined, function() {}]));
  const o2: any = { a: 1, b: { c: 2, d: 3 } };
  out.push(JSON.stringify(o2, ["a", "b", "c"]));
  out.push(JSON.parse("[1,2,3]").join(","), JSON.parse('"str""), JSON.parse("42") + 1);
  return out.join("|");
}` },
  { name: "symbol-for-keyfor", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s1: any = Symbol.for("shared");
  const s2: any = Symbol.for("shared");
  out.push(s1 === s2 ? 1 : 0, Symbol.keyFor(s1), Symbol.keyFor(s2));
  const local: any = Symbol("local");
  out.push(Symbol.keyFor(local) === undefined ? 1 : 0, local.description);
  const o: any = {}; o[s1] = "value";
  out.push(o[s1], o[s2], s1.description);
  const iter: any = Symbol.iterator;
  out.push(typeof iter, iter.description, iter === Symbol.iterator ? 1 : 0);
  out.push(Symbol.for("x") === Symbol.for("x") ? 1 : 0, Symbol("x") === Symbol("x") ? 1 : 0);
  out.push(typeof Symbol("s"), Symbol("s").toString().startsWith("Symbol") ? 1 : 0);
  return out.join("|");
}` },
  { name: "catch-no-binding", fn: "f", ts: `export function f(): any {
  const out: any = [];
  try { throw new Error("e"); } catch { out.push("caught"); }
  try { throw 42; } catch { out.push("num"); }
  try { null.x; } catch { out.push("typeerr"); }
  try { undeclaredVar; } catch { out.push("referr"); }
  try { try { throw "inner"; } catch { out.push("inner-caught"); } throw "outer"; } catch { out.push("outer-caught"); }
  try { undefinedVar; } catch { out.push("ok1"); } finally { out.push("fin1"); }
  try { throw new TypeError("te"); } catch (e: any) { out.push(e.constructor.name, e.message); } catch { out.push("fallback"); }
  let result = "";
  try { throw "x"; } catch { result = "caught"; throw "rethrow"; } catch { result += "-recaught"; } finally { out.push(result); }
  return out.join(",");
}` },
  { name: "array-reduceright-keys", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push([1, 2, 3, 4].reduceRight((a: any, b: any) => a + "" + b), [1, 2, 3].reduceRight((a: any, b: any) => a - b));
  out.push(["a", "b", "c"].reduceRight((acc: any, x: any) => acc + x, ""), [5, 4, 3].reduceRight((a: any, b: any) => a * b));
  const arr: any = [10, 20, 30];
  out.push([...arr.keys()].join(","), [...arr.values()].join(","), [...arr.entries()].map((e: any) => e.join(":")).join(","));
  out.push([1, 2, 3].reduceRight((acc: any, x: any, i: any) => acc + i + ":" + x, ""));
  out.push([].reduceRight(() => 0, 0), [1].reduceRight(() => 1, 0));
  const nested: any = [[1, 2], [3, 4]];
  out.push(nested.reduceRight((acc: any, x: any) => acc.concat(x), []).join(","));
  out.push([1, 2, 3, 4, 5].reduceRight((acc: any, x: any) => x > 2 ? acc + x : acc, 0));
  return out.join("|");
}` },
  { name: "dynamic-key-assign", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = {};
  const k1 = "a", k2 = 1, k3 = Symbol("s");
  o[k1] = 1; o[k2] = "two"; o[k3] = "sym";
  out.push(o.a, o[1], o["1"], o[k3], JSON.stringify(o), Object.keys(o).join(","));
  const arr: any = [];
  for (let i = 0; i < 3; i++) { arr["k" + i] = i * 10; }
  out.push(arr.k0, arr.k1, arr.k2, arr.length, Object.keys(arr).join(","));
  const o2: any = {};
  let i = 0;
  while (i < 3) { o2["item" + i++] = i; }
  out.push(o2.item0, o2.item1, o2.item2, Object.keys(o2).join(","));
  const o3: any = {};
  const keys = ["x", "y", "z"];
  keys.forEach((k: any, idx: any) => o3[k] = idx);
  out.push(JSON.stringify(o3));
  return out.join("|");
}` },
  { name: "class-extends-null-super-ctor", fn: "f", ts: `class Animal { constructor(public name: any) {} speak(): any { return this.name + " speaks"; } }
class Dog extends Animal { constructor(name: any, public breed: any) { super(name); } speak(): any { return super.speak() + " (woof)"; } info(): any { return this.name + ":" + this.breed; } }
export function f(): any {
  const out: any = [];
  const d = new Dog("Rex", "Lab");
  out.push(d.name, d.breed, d.speak(), d.info(), d instanceof Dog, d instanceof Animal);
  const a = new Animal("Cat");
  out.push(a.name, a.speak(), a instanceof Animal, a instanceof Dog);
  out.push(Object.getPrototypeOf(Dog.prototype) === Animal.prototype ? 1 : 0);
  out.push(d.constructor === Dog ? 1 : 0, a.constructor === Animal ? 1 : 0);
  return out.join("|");
}` },
  { name: "nested-try-catch-finally-throw", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const trace = (label: any, fn: any) => { try { out.push(label + ":start"); fn(); out.push(label + ":end"); } catch (e: any) { out.push(label + ":catch:" + e); } finally { out.push(label + ":fin"); } };
  trace("A", () => { trace("B", () => { throw "B-err"; }); });
  trace("C", () => { try { throw "C1"; } catch (e: any) { out.push("C:caught:" + e); throw "C2"; } });
  let seq = "";
  try { seq += "1"; try { seq += "2"; throw "x"; } catch (e: any) { seq += "3"; throw "y"; } finally { seq += "4"; } } catch (e: any) { seq += "5:" + e; } finally { seq += "6"; }
  out.push(seq);
  const g = () => { try { try { return "inner"; } finally { out.push("inner-fin"); } } finally { out.push("outer-fin"); } };
  out.push(g());
  try { try { throw 1; } catch (e: any) { throw 2; } finally { out.push("deep-fin"); } } catch (e: any) { out.push("deep:" + e); }
  return out.join(",");
}` },
  { name: "number-constants-coerce", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Number.MAX_VALUE > 1e308, Number.MIN_VALUE > 0, Number.MAX_SAFE_INTEGER === 9007199254740991);
  out.push(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Infinity, -Infinity);
  out.push(Number.EPSILON > 0, Number.NaN, NaN);
  out.push(+"3.14", +"", +"0x10", +"1e3", +"  5  ", +"abc", +"", +"Infinity");
  out.push(Number(""), Number("  "), Number("abc"), Number(null), Number(undefined), Number([]), Number([5]), Number([1,2]));
  out.push(Number(true), Number(false), Number("true"), Number("false"));
  out.push(parseInt("3.14"), parseInt("0xFF"), parseInt("11", 2), parseInt("0xFF", 16), parseInt("777", 8));
  out.push(parseFloat("3.14xyz"), parseFloat("3.14"), parseFloat(".5"), parseFloat("1e3"), parseFloat("abc"));
  out.push(+null, +undefined, +true, +false, +"", +[], +{}, +"" === 0 ? 1 : 0);
  return out.join("|");
}` },
  { name: "array-concat-spread-nested", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push([1, 2].concat([3, 4]).join(","), [1].concat(2, [3], 4).join(","));
  out.push([1, [2, [3]]].flat().join(","), [1, [2, [3, [4]]]].flat(1).join(","), [1, [2, [3, [4]]]].flat(2).join(","));
  out.push([1, 2, 3].concat([4, 5], 6, [7]).join(","));
  out.push([...[1, 2], ...[3, 4], 5].join(","));
  out.push([1, 2, 3].map((x: any) => [x, x * 2]).flat().join(","));
  out.push([1, 2, 3].flatMap((x: any) => [x]).join(","), [1, 2].flatMap((x: any) => [x, x * 10]).join(","));
  out.push(Array.from([1, 2, 3], (x: any) => x * 2).join(","), Array.from("ab", (c: any) => c).join(","));
  out.push(Array.of(1, 2, 3).join(","), Array.of().length, Array(3).fill(0).join(","));
  out.push([1, 2, 3, 4, 5].slice(1, 4).join(","), [1, 2, 3].slice(-2).join(","));
  return out.join("|");
}` },
  { name: "regex-advance-flags", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const sticky: any = /\\d+/y;
  sticky.lastIndex = 0;
  out.push(sticky.exec("123abc") !== null ? 1 : 0, sticky.sticky);
  sticky.lastIndex = 3;
  out.push(sticky.exec("123abc") === null ? 1 : 0);
  const gi: any = /hello/gi;
  out.push(gi.flags, gi.source, gi.global, gi.ignoreCase);
  out.push("Hello HELLO hello".match(/hello/gi).length);
  out.push("a1b2c3".replace(/\\d/g, (m: any) => "[" + m + "]"));
  out.push("2024-01-15".replace(/(\\d+)-(\\d+)-(\\d+)/, "$3/$2/$1"));
  out.push("hello world".match(/\\w+/g).join("|"), "".match(/\\w+/) === null ? 1 : 0);
  const re: any = /(\\w)(\\w)/;
  const m: any = re.exec("abcd");
  out.push(m[0], m[1], m[2], m.index, m.input);
  out.push("test".replace(/t/g, "$&$&"), "a.b.c".split("\\.").join("-"));
  out.push("Hello".replace(/(?<first>\\w)/, "X"), /(?<name>\\w+)/.exec("abc")?.[1] || "na");
  return out.join("|");
}` },
  { name: "string-repeat-pad-compare", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("ab".repeat(3), "a".repeat(0), "x".repeat(5), "".repeat(10));
  out.push("5".padStart(3, "0"), "5".padStart(2, "0"), "hi".padEnd(5, "-"), "x".padStart(5, "ab"));
  out.push("abc".repeat(2).length, "ab".padStart(10).length);
  out.push("  hi  ".trim(), "  hi  ".trimStart(), "  hi  ".trimEnd(), "  hi  ".trimStart().trimEnd());
  out.push("abc".at(0), "abc".at(-1), "abc".at(3) === undefined ? 1 : 0);
  out.push("abc".charAt(0), "abc".charAt(-1), "abc".charAt(5) === "" ? 1 : 0);
  out.push("abc".charCodeAt(0), "abc".charCodeAt(2), "abc".charCodeAt(5) === NaN ? 1 : 0);
  out.push(String.fromCharCode(72, 105), String.fromCodePoint(128512) !== undefined ? 1 : 0);
  out.push("ABC".toLowerCase(), "abc".toUpperCase(), "Mixed".toLowerCase());
  out.push("abc" < "abd" ? 1 : 0, "abc" < "ab" ? 1 : 0, "a" < "b" ? 1 : 0, "Z" < "a" ? 1 : 0);
  return out.join("|");
}` },
  { name: "closure-memory-leak-safe", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const makeStack = () => { let items: any = []; return { push: (x: any) => { items.push(x); return items.length; }, pop: () => items.length ? items.pop() : undefined, size: () => items.length, peek: () => items[items.length - 1] }; };
  const s = makeStack();
  out.push(s.push(1), s.push(2), s.push(3), s.size(), s.peek(), s.pop(), s.size(), s.peek());
  const makeCounter = (start: any) => { let count = start; return { inc: () => ++count, dec: () => --count, get: () => count, reset: () => { count = start; } }; };
  const c = makeCounter(10);
  out.push(c.get(), c.inc(), c.inc(), c.get(), c.dec(), c.get(), c.reset(), c.get());
  const memoize = (fn: any) => { let cache: any = null, cached = false; return (x: any) => { if (!cached) { cache = fn(x); cached = true; } return cache; }; };
  let calls = 0;
  const m = memoize((x: any) => { calls++; return x * 2; });
  out.push(m(5), m(5), m(5), calls);
  return out.join("|");
}` },
  { name: "object-method-chain-deep", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: { c: 2, d: { e: 3 } } };
  out.push(o.a, o.b.c, o.b.d.e, JSON.stringify(o));
  const arr: any = [{ x: 1 }, { x: 2 }, { x: 3 }];
  out.push(arr.map((o: any) => o.x).join(","), arr.reduce((s: any, o: any) => s + o.x, 0));
  out.push(Object.keys(o).join(","), Object.entries(o.b).map((e: any) => e.join(":")).join(","));
  out.push(Object.values(o.b.d).join(","), JSON.stringify(Object.fromEntries(Object.entries(o.b))));
  const merge: any = { ...{ a: 1 }, ...{ b: 2 }, ...{ a: 3, c: 4 } };
  out.push(JSON.stringify(merge));
  const pick: any = (({ a, c }: any) => ({ a, c }))({ a: 1, b: 2, c: 3 });
  out.push(JSON.stringify(pick));
  const data: any = [1, 2, 3, 4, 5];
  out.push(data.filter((x: any) => x > 2).map((x: any) => x * 10).reduce((a: any, b: any) => a + b, 0));
  return out.join("|");
}` },
  { name: "class-static-block-fields", fn: "f", ts: `class Config { static defaults: any; static version: any = "1.0";
  static { this.defaults = { timeout: 30, retries: 3 }; }
  static get timeout(): any { return Config.defaults.timeout; } }
export function f(): any {
  const out: any = [];
  out.push(Config.version, Config.defaults.timeout, Config.defaults.retries, Config.timeout);
  Config.defaults.timeout = 60;
  out.push(Config.timeout, Config.defaults.timeout);
  out.push(Config.version = "2.0", Config.version);
  return out.join("|");
}` },
  { name: "ternary-chain-short-circuit", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const classify = (n: any) => n < 0 ? "neg" : n === 0 ? "zero" : n < 10 ? "small" : n < 100 ? "med" : "big";
  out.push(classify(-5), classify(0), classify(5), classify(50), classify(500));
  const g = (x: any) => x && x.foo && x.foo.bar || "default";
  out.push(g(null), g({}), g({ foo: {} }), g({ foo: { bar: 42 } }));
  const h = (x: any) => x?.a?.b ?? "none";
  out.push(h(null), h({}), h({ a: {} }), h({ a: { b: 5 } }));
  let side = 0;
  const eff = (v: any) => { side++; return v; };
  out.push(true && eff(1), false && eff(2), true || eff(3), false || eff(4), side);
  out.push(null ?? eff(5), undefined ?? eff(6), 0 ?? eff(7), "" ?? eff(8), side);
  const chain: any = null; const chain2: any = { a: 1 };
  out.push(chain?.a?.b ?? "c1", chain2?.a ?? "c2", chain2?.a?.b ?? "c3");
  return out.join("|");
}` },
];