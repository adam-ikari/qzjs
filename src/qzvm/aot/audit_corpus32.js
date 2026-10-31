// 差分审计语料（第三十二批）：模块级初始化模式（闭包调用现已被 start-段修复解锁）、闭包状态机、迭代协议、字符串格式化、数值算法、类层次、错误恢复、ES2023+ 探针。
module.exports = [
  { name: "module-init-closures", fn: "f", ts: `const makeAdder = (n: any) => (x: any) => x + n;
const add5 = makeAdder(5);
const add10 = makeAdder(10);
const BASE: any = add5(1) + add10(2);
const doubled = ((x: any) => x * 2)(21);
const registry: any = {};
(function init(): any { registry.a = 1; registry.b = 2; })();
export function f(): any {
  return BASE + "," + doubled + "," + add5(100) + "," + registry.a + registry.b;
}` },
  { name: "module-init-state-machine", fn: "f", ts: `const transitions: any = { idle: "running", running: "paused", paused: "running" };
let state = "idle";
const step = () => { state = transitions[state] || "idle"; return state; };
const history: any = [state, step(), step(), step()];
const counter = (() => { let n = 0; return { next: () => ++n, reset: () => { n = 0; return 0; } }; })();
export function f(): any {
  return history.join(">") + "|" + counter.next() + counter.next() + "|" + counter.reset() + counter.next();
}` },
  { name: "iteration-protocols", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const m: any = new Map([["a", 1], ["b", 2]]);
  out.push([...m.keys()].join(""), [...m.values()].join(""), [...m.entries()].map((e: any) => e.join(":")).join(","));
  for (const [k, v] of m) out.push(k + "=" + v);
  const s: any = new Set([3, 1, 2]);
  out.push([...s.entries()].map((e: any) => e.join("=")).join(","), [...s.keys()].join(""), [...s.values()].join(""));
  const arr: any = ["x", "y"];
  out.push([...arr.entries()].map((e: any) => e.join(":")).join(","), [...arr.keys()].join(""), [...arr.values()].join(""));
  out.push(Array.from(m).length, Array.from(s).join(""), Array.from(arr.entries()).length);
  for (const ch of "ab") out.push(ch);
  return out.join("|");
}` },
  { name: "string-formatting-algos", fn: "f", ts: `const repeat = (s: any, n: any) => new Array(n + 1).join(s);
const lpad = (s: any, n: any) => repeat(" ", Math.max(0, n - String(s).length)) + s;
const rpad = (s: any, n: any) => s + repeat(" ", Math.max(0, n - String(s).length));
const hex2 = (n: any) => (n < 16 ? "0" : "") + n.toString(16);
const bin = (n: any) => n.toString(2).padStart(8, "0");
export function f(): any {
  const out: any = [];
  out.push("[" + lpad("x", 5) + "]", "[" + rpad("y", 5) + "]");
  out.push(hex2(5) + hex2(255).slice(-2), bin(5), bin(170));
  const rows: any = [["a", 1], ["bb", 22]];
  out.push(rows.map((r: any) => lpad(r[0], 3) + "|" + lpad(r[1], 4)).join(";"));
  const bar = (n: any, max: any) => repeat("#", Math.round(n / max * 10)) + repeat(".", 10 - Math.round(n / max * 10));
  out.push(bar(3, 10), bar(10, 10), bar(0, 10));
  out.push(String(12345).split("").reverse().join(""), (1234.5).toFixed(2), repeat("ab", 3));
  return out.join("|");
}` },
  { name: "numeric-algorithms", fn: "f", ts: `const isPrime = (n: any): any => { if (n < 2) return false; for (let i = 2; i * i <= n; i++) if (n % i === 0) return false; return true; };
const primes = (n: any): any => { const r: any = []; for (let i = 2; i < n; i++) if (isPrime(i)) r.push(i); return r; };
const factorial = (n: any): any => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
const gcd = (a: any, b: any): any => { while (b) { const t = a % b; a = b; b = t; } return a; };
const fibIter = (n: any): any => { let a = 0, b = 1; for (let i = 0; i < n; i++) { const t = a + b; a = b; b = t; } return a; };
const digitSum = (n: any): any => String(n).split("").reduce((a: any, d: any) => a + Number(d), 0);
export function f(): any {
  const out: any = [];
  out.push(primes(30).join(","), isPrime(97) ? 1 : 0, isPrime(100) ? 1 : 0);
  out.push(factorial(10), gcd(48, 18), gcd(17, 5), fibIter(20), digitSum(98765));
  let sum = 0; for (let i = 1; i <= 100; i++) sum += i * i;
  out.push(sum, Math.sqrt(144), 2 ** 16, Math.abs(-42));
  const collatz = (n: any): any => { let steps = 0; while (n !== 1) { n = n % 2 === 0 ? n / 2 : 3 * n + 1; steps++; } return steps; };
  out.push(collatz(27), collatz(1));
  return out.join("|");
}` },
  { name: "class-hierarchy-shapes", fn: "f", ts: `class Shape { constructor(public name: any) {} area(): any { return 0; } describe(): any { return this.name + "(" + this.area() + ")"; } }
class Circle extends Shape { constructor(public r: any) { super("circle"); } area(): any { return Math.round(Math.PI * this.r * this.r * 100) / 100; } }
class Rect extends Shape { constructor(public w: any, public h: any) { super("rect"); } area(): any { return this.w * this.h; } }
class Square extends Rect { constructor(s: any) { super(s, s); this.name = "square"; } }
export function f(): any {
  const shapes: any = [new Circle(1), new Rect(2, 3), new Square(4)];
  const out: any = [shapes.map((s: any) => s.describe()).join(",")];
  out.push(shapes.map((s: any) => s.area()).join(","));
  out.push(shapes.filter((s: any) => s instanceof Rect).length, shapes.filter((s: any) => s instanceof Shape).length);
  const total = shapes.reduce((a: any, s: any) => a + s.area(), 0);
  out.push(Math.round(total * 100) / 100, shapes.length);
  out.push(shapes.map((s: any) => s.constructor === Circle ? "C" : s.constructor === Square ? "Q" : "R").join(""));
  return out.join("|");
}` },
  { name: "error-recovery-patterns", fn: "f", ts: `const tryParse = (s: any) => { try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false, value: null }; } };
const withRetry = (fn: any, times: any) => { let last: any = null; for (let i = 0; i < times; i++) { try { return fn(i); } catch (e: any) { last = e; } } throw last; };
let attempts = 0;
const flaky = () => { if (++attempts < 3) throw new Error("fail" + attempts); return "ok" + attempts; };
export function f(): any {
  const out: any = [];
  out.push(tryParse('{"a":1}').ok, tryParse("bad").ok, tryParse('[1,2]').value.length);
  out.push(withRetry(flaky, 5), attempts);
  const safe = (fn: any) => { try { return fn(); } catch (e: any) { return "E:" + e.message; } };
  out.push(safe(() => 1 + 1), safe(() => { throw new Error("boom"); }), safe(() => JSON.parse("{")));
  const nested = () => { try { try { throw new Error("inner"); } catch (e: any) { throw new Error("outer:" + e.message); } } catch (e2: any) { return e2.message; } };
  out.push(nested());
  return out.join("|");
}` },
  { name: "closure-loop-capture", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const fs1: any = [];
  for (var i = 0; i < 3; i++) fs1.push(() => i);
  out.push(fs1.map((g: any) => g()).join(","));
  const fs2: any = [];
  for (let j = 0; j < 3; j++) fs2.push(() => j);
  out.push(fs2.map((g: any) => g()).join(","));
  const fs3: any = [];
  const arr: any = [1, 2, 3];
  for (const v of arr) fs3.push(() => v * 10);
  out.push(fs3.map((g: any) => g()).join(","));
  const fs4: any = [];
  let k = 0;
  while (k < 3) { const kk = k; fs4.push(() => kk); k++; }
  out.push(fs4.map((g: any) => g()).join(","), i, k);
  return out.join("|");
}` },
  { name: "object-literal-patterns", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const key = "dyn";
  const o: any = {
    plain: 1,
    [key]: 2,
    "quoted key": 3,
    42: "num",
    m() { return "method"; },
    get g() { return "getter"; },
    set s(v: any) { this._s = v; },
    _s: null,
    ...{ spread: 4 },
    nested: { deep: { v: 5 } },
  };
  o.s = "set!";
  out.push(JSON.stringify(o), Object.keys(o).length);
  out.push(o.plain, o.dyn, o["quoted key"], o[42], o.m(), o.g, o._s, o.spread, o.nested.deep.v);
  const { plain, dyn, nested: { deep: { v } } } = o;
  out.push(plain, dyn, v);
  const { m, g } = o;
  out.push(m.call(o), g);
  out.push(Object.keys(o).slice(0, 4).join(","));
  return out.join("|");
}` },
  { name: "array-iteration-advanced", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [5, 3, 8, 1];
  out.push(a.reduce((x: any, y: any) => x + y, 0), a.reduceRight((x: any, y: any) => x - y, 0));
  out.push(a.find((x: any) => x > 4), a.findIndex((x: any) => x > 4), a.findLast((x: any) => x < 5));
  out.push(a.every((x: any) => x > 0), a.some((x: any) => x > 7), a.includes(8), a.includes(9));
  out.push(a.slice().sort((x: any, y: any) => x - y).join(","), a.join(","));
  const byKey: any = {};
  a.forEach((v: any, idx: any) => { byKey[idx] = v * 2; });
  out.push(JSON.stringify(byKey));
  out.push(a.map((v: any, idx: any) => v + idx).join(","), a.filter((_: any, idx: any) => idx % 2 === 0).join(","));
  const flat: any = [[1, 2], [3, [4]]];
  out.push(flat.flat().join(","), flat.flat(2).join(","), flat.flatMap((x: any) => x).join(","));
  return out.join("|");
}` },
  { name: "switch-control-flow", fn: "f", ts: `const classify = (n: any) => { let r = ""; switch (true) { case n < 0: r = "neg"; break; case n === 0: r = "zero"; break; case n < 10: r = "unit"; break; case n < 100: r = "tens"; break; default: r = "big"; } return r; };
const dayType = (d: any) => { switch (d) { case 0: case 6: return "weekend"; case 1: case 2: case 3: case 4: case 5: return "weekday"; default: return "invalid"; } };
export function f(): any {
  const out: any = [];
  out.push([-5, 0, 7, 42, 1000].map(classify).join(","));
  out.push([0, 6, 3, 9].map(dayType).join(","));
  let s = "";
  switch ("b") { case "a": s += "A"; case "b": s += "B"; case "c": s += "C"; break; default: s += "D"; }
  out.push(s);
  let t = "";
  for (const v of [1, 2, 3, 4, 5]) { switch (v % 3) { case 0: t += "z"; continue; case 1: t += "o"; break; default: t += "t"; } t += "."; }
  out.push(t);
  return out.join("|");
}` },
  { name: "json-roundtrip-complex", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const data: any = { users: [{ id: 1, name: "a", tags: ["x", "y"] }, { id: 2, name: "b", tags: [] }], meta: { total: 2, nested: { flag: true } } };
  const s = JSON.stringify(data);
  const back = JSON.parse(s);
  out.push(back.users.length, back.users[0].tags.join(""), back.meta.nested.flag, back.meta.total);
  out.push(JSON.stringify(back) === s, s.length > 0);
  out.push(JSON.stringify(data, null, 0).length, JSON.stringify(data, null, 1).length > JSON.stringify(data, null, 0).length);
  const withNulls: any = { a: null, b: undefined, c: [null, undefined], d: { e: null } };
  out.push(JSON.stringify(withNulls));
  out.push(JSON.parse(JSON.stringify(withNulls)).c.length, JSON.parse(JSON.stringify(withNulls)).c[1] === null);
  out.push(JSON.stringify("quote\\"here"), JSON.stringify({ "k\"q": 1 }));
  const nums: any = [0, -0, 1.5, 1e21, 1e-7, NaN, Infinity];
  out.push(JSON.stringify(nums));
  return out.join("|");
}` },
  { name: "map-set-heavy", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const index: any = new Map();
  const words: any = ["apple", "banana", "avocado", "cherry"];
  words.forEach((w: any) => { const k = w[0]; index.set(k, (index.get(k) || []).concat(w)); });
  out.push(index.size, [...index.keys()].join(""), index.get("a").join(","));
  const counts: any = new Map();
  for (const ch of "abracadabra") counts.set(ch, (counts.get(ch) || 0) + 1);
  out.push([...counts.entries()].sort((x: any, y: any) => y[1] - x[1]).map((e: any) => e.join("")).join(","));
  const seen: any = new Set();
  const uniq: any = [];
  for (const n of [1, 2, 2, 3, 1, 4]) if (!seen.has(n)) { seen.add(n); uniq.push(n); }
  out.push(uniq.join(""), seen.size);
  const objs: any = new Set();
  const o1: any = { id: 1 };
  objs.add(o1); objs.add(o1); objs.add({ id: 1 });
  out.push(objs.size);
  const m2: any = new Map([[1, "a"], [2, "b"]]);
  out.push(m2.has(1), m2.get(1), m2.delete(1), m2.size, m2.get(1) === undefined);
  return out.join("|");
}` },
  { name: "higher-order-pipeline", fn: "f", ts: `const map = (fn: any) => (arr: any) => arr.map(fn);
const filter = (fn: any) => (arr: any) => arr.filter(fn);
const reduce = (fn: any, init: any) => (arr: any) => arr.reduce(fn, init);
const pipe = (...fns: any) => (x: any) => fns.reduce((v: any, f: any) => f(v), x);
const double = (x: any) => x * 2;
const isEven = (x: any) => x % 2 === 0;
const sum = (a: any, b: any) => a + b;
export function f(): any {
  const out: any = [];
  const data: any = [1, 2, 3, 4, 5, 6];
  out.push(pipe(filter(isEven), map(double), reduce(sum, 0))(data));
  out.push(map(double)(filter(isEven)(data)).join(","));
  out.push(reduce(sum, 0)(data), reduce((a: any, b: any) => a * b, 1)(data));
  const chunk = (n: any) => (arr: any) => { const r: any = []; for (let i = 0; i < arr.length; i += n) r.push(arr.slice(i, i + n)); return r; };
  out.push(JSON.stringify(chunk(2)(data)), JSON.stringify(chunk(4)(data)));
  const zip = (a: any, b: any) => a.map((x: any, i: any) => [x, b[i]]);
  out.push(JSON.stringify(zip([1, 2], ["a", "b"])));
  return out.join("|");
}` },
  { name: "string-parsing", fn: "f", ts: `const parseKV = (s: any) => { const o: any = {}; s.split("&").forEach((p: any) => { const [k, v] = p.split("="); if (k) o[k] = v === undefined ? true : decodeURIComponent(v); }); return o; };
const camel = (s: any) => s.replace(/-([a-z])/g, (_: any, c: any) => c.toUpperCase());
export function f(): any {
  const out: any = [];
  out.push(JSON.stringify(parseKV("a=1&b=hello%20world&c")));
  out.push(camel("my-long-name"), camel("x"), camel("already"));
  const csv = "name,age\\nalice,30\\nbob,25";
  const rows = csv.split("\\n").map((l: any) => l.split(","));
  out.push(rows.length, rows[0].join("|"), rows[1][1], rows.map((r: any) => r[0]).slice(1).join("/"));
  const num = (s: any) => { const n = parseFloat(s.replace(/[^0-9.eE+-]/g, "")); return isNaN(n) ? 0 : n; };
  out.push(num("$1,234.56"), num("abc"), num("-3.5kg"));
  const words = "the quick brown fox".split(" ").filter((w: any) => w.length > 3);
  out.push(words.join("-"), words.length);
  out.push("a-b-c".split("-").map((s: any, i: any) => i + s).join(""));
  return out.join("|");
}` },
  { name: "bigint-symbol-probe", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const sym: any = Symbol("tag");
  const o: any = { [sym]: "symval", normal: 1 };
  out.push(o[sym], JSON.stringify(o), Object.keys(o).join(","));
  out.push(typeof Symbol.iterator, typeof BigInt === "function" ? "hasBigInt" : "noBigInt");
  if (typeof BigInt === "function") { try { out.push((BigInt(10) + BigInt(5)).toString()); } catch (e: any) { out.push("bigint-err"); } }
  out.push(Object.getOwnPropertySymbols(o).length);
  out.push(Symbol.for("k") === Symbol.for("k"), Symbol.keyFor(Symbol.for("k")));
  const tagged: any = { [Symbol.toStringTag]: "Custom" };
  out.push(Object.prototype.toString.call(tagged));
  return out.join("|");
}` },
  { name: "deep-nested-data", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const tree: any = { v: 1, children: [{ v: 2, children: [{ v: 4, children: [] }, { v: 5, children: [] }] }, { v: 3, children: [{ v: 6, children: [] }] }] };
  const sumTree = (n: any): any => n.v + n.children.reduce((a: any, c: any) => a + sumTree(c), 0);
  out.push(sumTree(tree));
  const collect = (n: any, acc: any): any => { acc.push(n.v); n.children.forEach((c: any) => collect(c, acc)); return acc; };
  out.push(collect(tree, []).join(","));
  const depth = (n: any): any => 1 + n.children.reduce((m: any, c: any) => Math.max(m, depth(c)), 0);
  out.push(depth(tree));
  const find = (n: any, target: any): any => n.v === target ? n : n.children.reduce((r: any, c: any) => r || find(c, target), null);
  out.push(find(tree, 5).v, find(tree, 99) === null);
  const flat: any = [];
  const flatten = (n: any): any => { flat.push(n.v); n.children.forEach(flatten); return flat; };
  out.push(flatten(tree).length, JSON.stringify(tree).length > 100);
  return out.join("|");
}` },
  { name: "mixed-program-v2", fn: "f", ts: `class Inventory { items: any = []; constructor(public name: any) {} add(sku: any, qty: any): any { this.items.push({ sku, qty }); return this; } total(): any { return this.items.reduce((a: any, i: any) => a + i.qty, 0); } find(sku: any): any { return this.items.find((i: any) => i.sku === sku); } report(): any { return this.name + ":" + this.total() + " items in " + this.items.length + " skus"; } }
const log: any = [];
const track = (fn: any) => (...a: any) => { const r = fn(...a); log.push(a.join("+")); return r; };
const multiply = (a: any, b: any) => a * b;
export function f(): any {
  const out: any = [];
  const inv = new Inventory("main");
  inv.add("a", 5).add("b", 3).add("c", 7);
  out.push(inv.report(), inv.total(), inv.find("b").qty, inv.find("z") === undefined);
  const m = track(multiply);
  out.push(m(2, 3), m(4, 5), log.join(","));
  out.push(inv.items.map((i: any) => i.sku + ":" + i.qty).join("|"), JSON.stringify(inv.items[0]));
  const sorted = inv.items.slice().sort((a: any, b: any) => b.qty - a.qty).map((i: any) => i.sku);
  out.push(sorted.join(">"), inv.total() === 15);
  return out.join("|");
}` },
  { name: "numeric-precision-ops", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const round2 = (n: any) => Math.round(n * 100) / 100;
  const sumFloats = (a: any) => a.reduce((x: any, y: any) => x + y, 0);
  const cents = (n: any) => Math.round(n * 100);
  out.push(round2(0.1 + 0.2), round2(1 / 3), sumFloats([0.1, 0.2, 0.3]));
  out.push(cents(19.99), cents(0.1 + 0.2), cents(19.99) + cents(5.01));
  out.push(round2(cents(19.99) / 100 + cents(5.01) / 100));
  out.push((1.005).toFixed(2), round2(1.005), Math.round(1.005 * 100) / 100);
  out.push(0.1 * 3 === 0.3, round2(0.1 * 3) === 0.3);
  const avg = (a: any) => round2(a.reduce((x: any, y: any) => x + y, 0) / a.length);
  out.push(avg([1, 2, 3, 4]), avg([1.5, 2.25]));
  out.push(Number((123.456).toFixed(1)), Number((0.0001).toFixed(4)), Number(Math.PI.toFixed(5)));
  return out.join("|");
}` },
];