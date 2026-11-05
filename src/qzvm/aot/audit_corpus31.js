// 差分审计语料（第三十一批）：数组高维/嵌套、正则进阶、错误处理矩阵、数值边界、字符串 Unicode/编码、日期/时间（loud 观察）、生成器/异步（loud 观察）、类静态&继承进阶、函数参数边界。
module.exports = [
  { name: "array-nested-matrix", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const m: any = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
  out.push(m.map((r: any) => r.join("")).join("|"), m.length, m[1][2]);
  out.push(m.flat().join(","), m.flatMap((r: any) => r.map((x: any) => x * 2)).join(","));
  const transposed: any = m[0].map((_: any, i: any) => m.map((r: any) => r[i]));
  out.push(JSON.stringify(transposed));
  const cube: any = [[[1, 2], [3, 4]], [[5, 6], [7, 8]]];
  out.push(cube.flat(2).join(","), cube.length, cube[1][0][1], JSON.stringify(cube[0].flat()));
  const jagged: any = [[1], [2, 3], [4, 5, 6]];
  out.push(jagged.map((r: any) => r.length).join(","), jagged.reduce((a: any, r: any) => a + r.length, 0));
  out.push(JSON.stringify([[1, 2], [3, 4]].map(([x, y]: any) => x * y)));
  return out.join("__");
}` },
  { name: "regex-advanced-patterns", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s = "2024-01-15T10:30:00Z user@example.com +1-555-1234";
  out.push(s.match(/\\d{4}-\\d{2}-\\d{2}/)[0], s.match(/\\w+@\\w+\\.\\w+/)[0]);
  out.push(s.replace(/\\d/g, "#").slice(0, 10));
  out.push(s.split(/\\s+/).length, s.match(/[A-Z]/g).join(""));
  out.push(/^\\d+$/.test("12345"), /^\\d+$/.test("12a"), /^\\s*$/.test("   "));
  out.push("a1b2c3".replace(/([a-z])(\\d)/g, "$2$1"), "hello world".replace(/\\b\\w/g, (m: any) => m.toUpperCase()));
  const re: any = /(\\w+)=(\\w+)/g; const pairs: any = []; let mm: any;
  while ((mm = re.exec("a=1 b=2 c=3")) !== null) pairs.push(mm[1] + ":" + mm[2]);
  out.push(pairs.join(","));
  out.push("aaa".replace(/a/g, "b"), "abc".replace(/[abc]/g, "-"), "a.b".replace(/\\./g, "!"));
  out.push(/(\\d)(\\d)/.exec("123")?.slice(1).join("+"), "CamelCase".replace(/([A-Z])/g, "_$1").toLowerCase());
  return out.join("|");
}` },
  { name: "error-handling-matrix", fn: "f", ts: `class E1 extends Error { constructor(m: any) { super(m); this.name = "E1"; } }
class E2 extends E1 { constructor(m: any, public n: any) { super(m); } }
export function f(): any {
  const out: any = [];
  const attempt = (fn: any) => { try { return "ok:" + fn(); } catch (e: any) { return "err:" + e.name + ":" + e.message; } finally { out.push("f"); } };
  out.push(attempt(() => 1 + 1), attempt(() => { throw new E1("boom"); }), attempt(() => { throw new E2("deep", 9); }));
  out.push(attempt(() => { throw new TypeError("bad type"); }));
  const e = new E2("x", 5);
  out.push(e.message, e.n, e.name, e instanceof E1, e instanceof Error, e.toString().indexOf("Error") >= 0);
  try { throw { code: 42, msg: "obj" }; } catch (x: any) { out.push(x.code, x.msg); }
  try { throw 42; } catch (x: any) { out.push(typeof x, x); }
  let caught = "";
  try { JSON.parse("{bad}"); } catch { caught = "json"; } finally { caught += "|fin"; }
  out.push(caught);
  return out.join("|");
}` },
  { name: "numeric-boundaries-2", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, -(2 ** 53) - 1, 2 ** 53);
  out.push(Number.isSafeInteger(2 ** 53 - 1), Number.isSafeInteger(2 ** 53), Number.isInteger(2 ** 53));
  out.push((0.1).toFixed(1), (0.15).toFixed(1), (0.25).toFixed(1), (0.35).toFixed(1));
  out.push(Math.round(0.5), Math.round(-0.5), Math.round(1.5), Math.round(-1.5), Math.round(2.5));
  out.push(Number.MAX_VALUE, Number.MIN_VALUE, 5e-324, 1.7976931348623157e308);
  out.push(-0 === 0, Object.is(-0, 0), 1 / 0 === Infinity, -1 / 0 === -Infinity);
  out.push(parseInt("0x1f"), parseInt("1e3"), parseFloat("1e3"), Number("1e3"));
  out.push((1234.5678).toFixed(2), (1e21).toFixed(2) !== undefined, Math.trunc(-1.7), Math.sign(-0));
  out.push([1e-7, 1e-6, 1e20, 1e21].map((n: any) => n.toString()).join(","));
  return out.join("|");
}` },
  { name: "string-unicode-encode", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("héllo".length, "🙂".length, [..."🙂"].length, "a🙂b".length);
  out.push("héllo".toUpperCase(), "HÉLLO".toLowerCase());
  out.push(encodeURIComponent("a b&c=d"), decodeURIComponent("a%20b%26c%3Dd"));
  out.push(encodeURI("a b?c=d"), decodeURI("a%20b?c=d"));
  out.push("\\u00e9".charCodeAt(0), "🙂".codePointAt(0), String.fromCharCode(233), String.fromCodePoint(0x1f642).length);
  out.push("abc".split("").reverse().join(""), "abc".at(-1), "abc".charAt(0));
  out.push("a".localeCompare("b") < 0, "b".localeCompare("a") > 0, "a".localeCompare("a") === 0);
  out.push(JSON.stringify("héllo"), JSON.stringify("🙂"), JSON.stringify("\\n\\t"));
  out.push("\\u0041\\u0042".length, "\\x41\\x42", "A" === "\\u0041");
  return out.join("|");
}` },
  { name: "generator-async-loud-probe", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("start");
  const inner = (x: any) => x * 2;
  out.push(inner(21));
  out.push([1, 2, 3].map(inner).join(","));
  out.push("end");
  return out.join("|");
}` },
  { name: "class-static-advanced", fn: "f", ts: `class Registry { static items: any = []; static count: any = 0;
  static add(x: any): any { Registry.items.push(x); return ++Registry.count; }
  static remove(): any { const r = Registry.items.pop(); if (r !== undefined) Registry.count--; return r; }
  static get size(): any { return Registry.items.length; }
  static reset(): any { Registry.items = []; Registry.count = 0; return true; } }
class SubRegistry extends Registry { static tag(): any { return "sub:" + SubRegistry.size; } static add(x: any): any { return super.add(x) * 10; } }
export function f(): any {
  const out: any = [];
  out.push(Registry.add("a"), Registry.add("b"), Registry.size, Registry.count);
  out.push(Registry.remove(), Registry.size);
  out.push(SubRegistry.add("c"), SubRegistry.size, SubRegistry.tag());
  out.push(Registry.size, Registry.reset(), Registry.size, Registry.count);
  out.push(SubRegistry.tag());
  out.push(Object.getPrototypeOf(SubRegistry) === Registry);
  return out.join("|");
}` },
  { name: "function-params-edge", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const f0 = () => "noargs";
  const f1 = (a: any) => a;
  const f2 = (a: any, b: any) => a + "," + (b === undefined ? "u" : b);
  const f3 = (a: any = 1, b: any = 2, c: any = 3) => a + b + c;
  const f4 = (a: any, b: any, c: any, d: any) => [a, b, c, d].join("-");
  const f5 = (a: any, b: any, c: any, d: any, e: any) => [a, b, c, d, e].join("-");
  out.push(f0(), f1(5), f2(1), f2(1, 2), f3(), f3(10), f3(10, 20), f3(10, 20, 30));
  out.push(f4(1, 2, 3, 4), f5(1, 2, 3, 4, 5));
  out.push([f0, f1, f2].map((fn: any) => typeof fn).join(","));
  const apply = (fn: any, args: any) => fn(...args);
  out.push(apply(f2, [7, 8]), apply(f3, []), apply(f4, [1, 2, 3, 4]));
  out.push(f3(undefined, undefined, 9), f2(undefined, 3).indexOf("u") > 0 ? "hasU" : "noU");
  return out.join("|");
}` },
  { name: "iterable-class-patterns", fn: "f", ts: `class Bag { items: any = []; add(x: any): any { this.items.push(x); return this; } get size(): any { return this.items.length; } [Symbol.iterator](): any { let i = 0; const it = this.items; return { next: () => i < it.length ? { value: it[i++], done: false } : { value: undefined, done: true } }; } }
export function f(): any {
  const out: any = [];
  const b = new Bag();
  b.add(1).add(2).add(3);
  out.push(b.size, [...b].join(","), Array.from(b).length);
  for (const x of b) out.push(x);
  out.push([...b].map((x: any) => x * 10).join(","));
  const sum = (it: any) => { let s = 0; for (const v of it) s += v; return s; };
  out.push(sum(b), sum([10, 20]), sum("abc".length ? [1, 2] : []));
  out.push(Math.max(...[1, 5, 3]), new Set([...b, 4]).size);
  return out.join("|");
}` },
  { name: "getter-computed-mix", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const key = "dyn";
  const o: any = { a: 1, [key]: 2, ["b" + "c"]: 3, ["x" + (1 + 1)]: 4 };
  out.push(JSON.stringify(o), o.a, o.dyn, o.bc, o.x2, Object.keys(o).join(","));
  const o2: any = {}; const ks: any = ["p", "q", "r"];
  ks.forEach((k: any, i: any) => { o2[k] = i * 10; });
  out.push(JSON.stringify(o2), Object.keys(o2).join(","), Object.values(o2).join(","));
  const o3: any = { _v: 1, get v() { return this._v; }, set v(x: any) { this._v = x; }, get double() { return this._v * 2; } };
  out.push(o3.v, o3.double, o3._v);
  o3.v = 10;
  out.push(o3.v, o3.double, o3._v, Object.keys(o3).join(","));
  const dynKey = "k" + 1;
  const o4: any = { [dynKey]: "d1" };
  out.push(o4.k1, JSON.stringify(o4));
  return out.join("|");
}` },
  { name: "array-sort-compare-edge", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const words: any = ["banana", "apple", "Cherry", "date"];
  out.push(words.slice().sort().join(","));
  out.push(words.slice().sort((a: any, b: any) => a.toLowerCase().localeCompare(b.toLowerCase())).join(","));
  out.push([10, 9, 100, 1].slice().sort().join(","), [10, 9, 100, 1].slice().sort((a: any, b: any) => a - b).join(","));
  const nums: any = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
  out.push(nums.slice().sort((a: any, b: any) => a - b).join(""), nums.slice().sort((a: any, b: any) => b - a).join(""));
  out.push(nums.slice().sort((a: any, b: any) => a - b).filter((v: any, i: any, arr: any) => i === 0 || v !== arr[i - 1]).join(","));
  const objs: any = [{ n: "b", v: 2 }, { n: "a", v: 1 }, { n: "c", v: 2 }];
  out.push(objs.slice().sort((x: any, y: any) => x.v - y.v || (x.n < y.n ? -1 : 1)).map((o: any) => o.n).join(""));
  out.push([].sort().length, [1].sort().join(","));
  out.push(["b", "a"].sort((x: any, y: any) => x.localeCompare(y)).join(","));
  return out.join("|");
}` },
  { name: "recursion-via-closures", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const fact = (n: any): any => n <= 1 ? 1 : n * fact(n - 1);
  out.push(fact(5), fact(10));
  const sum = (n: any): any => n <= 0 ? 0 : n + sum(n - 1);
  out.push(sum(10), sum(50));
  const gcd = (a: any, b: any): any => b === 0 ? a : gcd(b, a % b);
  out.push(gcd(12, 8), gcd(100, 75));
  const flatten = (arr: any): any => arr.reduce((acc: any, x: any) => acc.concat(Array.isArray(x) ? flatten(x) : x), []);
  out.push(flatten([1, [2, [3, [4, 5]]]]).join(","));
  const pow = (b: any, e: any): any => e === 0 ? 1 : b * pow(b, e - 1);
  out.push(pow(2, 10), pow(3, 3));
  return out.join("|");
}` },
  { name: "map-set-advanced", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const m: any = new Map([["a", 1], ["b", 2]]);
  m.set("c", 3);
  out.push(m.size, [...m.keys()].join(","), [...m.values()].join(","));
  out.push([...m.entries()].map(([k, v]: any) => k + v).join(","));
  const objKeys: any = {};
  m.forEach((v: any, k: any) => { objKeys[k] = v * 10; });
  out.push(JSON.stringify(objKeys));
  const m2: any = new Map(m);
  out.push(m2.size, m2.get("b"));
  out.push(m.has("a"), m.has("z"), m.get("z") === undefined);
  const s: any = new Set([1, 2, 3, 2, 1]);
  out.push(s.size, [...s].join(","), s.has(2), s.has(9));
  const union: any = new Set([...s, ...new Set([3, 4])]);
  out.push([...union].sort().join(","), union.size);
  const inter: any = [...s].filter((x: any) => new Set([2, 3, 9]).has(x));
  out.push(inter.join(","));
  return out.join("|");
}` },
  { name: "string-transform-pipeline", fn: "f", ts: `const slugify = (s: any): any => s.toLowerCase().trim().replace(/[^a-z0-9\\s-]/g, "").replace(/\\s+/g, "-").replace(/-+/g, "-");
const capitalize = (s: any): any => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const titleCase = (s: any): any => s.split(" ").map(capitalize).join(" ");
export function f(): any {
  const out: any = [];
  out.push(slugify("Hello, World! 2024"), slugify("  Multi   Space  "), slugify("a--b---c"));
  out.push(capitalize("hELLO"), titleCase("hello world foo"));
  out.push(titleCase("the quick brown fox"), slugify(titleCase("Test String")));
  const truncate = (s: any, n: any) => s.length <= n ? s : s.slice(0, n - 1) + "…";
  out.push(truncate("hello world", 8), truncate("short", 10));
  const pad = (s: any, n: any, c: any) => s.padStart(Math.floor((n - s.length) / 2), c).padEnd(n, c);
  out.push(pad("mid", 9, "-"), pad("x", 5, "*"));
  out.push([..."hello"].map((c: any, i: any) => i % 2 ? c.toUpperCase() : c).join(""));
  return out.join("|");
}` },
  { name: "sparse-array-advanced", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = new Array(5);
  out.push(a.length, a.fill(0).join(","), a.fill(1, 1, 3).join(","));
  const b: any = [1, , 3, , 5];
  out.push(b.length, b.filter((x: any) => x !== undefined).length);
  out.push(b.map((x: any) => x === undefined ? -1 : x).join(","));
  out.push(JSON.stringify(b), b.join(","), String(b));
  out.push(b.slice(1, 4).length, JSON.stringify(b.slice(1, 4)));
  const c: any = [1, 2, 3];
  c[10] = 11;
  out.push(c.length, c.filter(() => true).length, Object.keys(c).length);
  out.push(c.join(",").length, c.indexOf(11), c[5] === undefined);
  out.push([...c].length, Array.from(c).length);
  return out.join("|");
}` },
  { name: "object-utils-implement", fn: "f", ts: `const pick = (o: any, ks: any) => ks.reduce((acc: any, k: any) => { if (k in o) acc[k] = o[k]; return acc; }, {});
const omit = (o: any, ks: any) => Object.keys(o).reduce((acc: any, k: any) => { if (ks.indexOf(k) < 0) acc[k] = o[k]; return acc; }, {});
const invert = (o: any) => Object.keys(o).reduce((acc: any, k: any) => { acc[String(o[k])] = k; return acc; }, {});
const merge = (a: any, b: any) => ({ ...a, ...b });
export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: 2, c: 3 };
  out.push(JSON.stringify(pick(o, ["a", "c"])), JSON.stringify(pick(o, ["x"])), JSON.stringify(omit(o, ["b"])));
  out.push(JSON.stringify(invert({ x: "1", y: "2" })), JSON.stringify(merge({ a: 1 }, { a: 2, b: 3 })));
  const groupBy = (arr: any, fn: any) => arr.reduce((acc: any, x: any) => { const k = fn(x); (acc[k] = acc[k] || []).push(x); return acc; }, {});
  out.push(JSON.stringify(groupBy([1, 2, 3, 4, 5], (x: any) => x % 2 ? "odd" : "even")));
  const uniqBy = (arr: any, fn: any) => { const seen: any = {}; return arr.filter((x: any) => { const k = String(fn(x)); if (seen[k]) return false; seen[k] = 1; return true; }); };
  out.push(uniqBy([1, 2, 2, 3, 3, 3], (x: any) => x).join(","));
  const countBy = (arr: any, fn: any) => arr.reduce((acc: any, x: any) => { const k = String(fn(x)); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  out.push(JSON.stringify(countBy(["a", "b", "a", "c", "a"], (x: any) => x)));
  out.push(JSON.stringify(pick(omit({ a: 1, b: 2, c: 3 }, ["b"]), ["a", "c", "d"])));
  return out.join("|");
}` },
  { name: "truthiness-coercion-matrix", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const vals: any = [0, -0, NaN, "", null, undefined, false, 1, "0", "false", [], {}, [0], Infinity];
  out.push(vals.map((v: any) => v ? "T" : "F").join(""));
  out.push(vals.filter((v: any) => v).length, vals.filter((v: any) => !!v).length);
  out.push(vals.map((v: any) => typeof v).join(","));
  out.push(vals.map((v: any) => String(v)).join("|"));
  out.push(vals.map((v: any) => Number(v)).map((n: any) => Number.isNaN(n) ? "NaN" : String(n)).join(","));
  out.push([] == false, "" == false, "0" == false, [0] == false, null == false, undefined == false);
  out.push(Boolean([]), Boolean({}), Boolean(""), Boolean(" "), !!"0", !!"false");
  out.push([...vals].length, vals.indexOf(null), vals.indexOf(NaN), vals.indexOf(0));
  return out.join("__");
}` },
  { name: "higher-order-realistic", fn: "f", ts: `const pipe = (...fns: any) => (x: any) => fns.reduce((v: any, fn: any) => fn(v), x);
const compose = (...fns: any) => (x: any) => fns.reduceRight((v: any, fn: any) => fn(v), x);
const curry2 = (fn: any) => (a: any) => (b: any) => fn(a, b);
const partial = (fn: any, ...pre: any) => (...post: any) => fn(...pre, ...post);
const memoize = (fn: any) => { const cache: any = {}; return (x: any) => { const k = String(x); if (!(k in cache)) cache[k] = fn(x); return cache[k]; }; };
export function f(): any {
  const out: any = [];
  const add = (a: any, b: any) => a + b;
  const mul = (a: any, b: any) => a * b;
  out.push(pipe(add(1), mul(2), (x: any) => x - 3)(5));
  out.push(compose(add(1), mul(2))(5));
  out.push(curry2(add)(3)(4), curry2(mul)(3)(4));
  out.push(partial(add, 10)(5), partial(mul, 2)(21));
  let calls = 0;
  const slow = memoize((n: any) => { calls++; return n * n; });
  out.push(slow(4), slow(4), slow(5), calls);
  const once = (fn: any) => { let done = false, r: any; return () => { if (!done) { done = true; r = fn(); } return r; }; };
  let n = 0;
  const init = once(() => ++n);
  out.push(init(), init(), init(), n);
  const times = (n2: any, fn: any) => { for (let i = 0; i < n2; i++) fn(i); };
  const acc: any = [];
  times(3, (i: any) => acc.push(i * 2));
  out.push(acc.join(","));
  return out.join("|");
}` },
];