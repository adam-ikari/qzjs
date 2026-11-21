// 差分审计语料（第三十七批）：Unicode 字符串、Math 扩展、数组空洞与排序、Object.create(null)/描述符往返、
// 迭代器提前退出、错误 cause、标签块、switch 块级作用域、Map NaN 键、位运算截断、IIFE 记忆化、trampoline。
module.exports = [
  { name: "string-unicode", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const emoji: any = "a😀b";
  out.push(emoji.length, [...emoji].length, emoji.codePointAt(1) > 0x10000 ? 1 : 0);
  out.push(emoji.charCodeAt(1), "😀".length, Array.from("😀").length);
  const s: any = "e\\u0301";
  out.push(s.length, s.normalize("NFC").length, s.normalize("NFD").length);
  out.push("ß".toUpperCase(), "İ".toLowerCase().length, "abc".split("").reverse().join(""));
  out.push(emoji.slice(1, 2).length, [...emoji].slice(1, 2).join(""));
  return out.join("|");
}` },
  { name: "math-extended", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Math.sign(-5), Math.sign(0), Math.sign(3), Math.trunc(-4.7), Math.cbrt(-8));
  out.push(Math.hypot(3, 4, 12), Math.log2(8), Math.log10(1000), Math.exp(0));
  out.push(Math.log1p(0), Math.expm1(0), Math.sinh(0), Math.cosh(0), Math.tanh(0));
  out.push(Math.imul(3, 4), Math.clz32(1), Math.fround(5.5), Math.fround(0.1) !== 0.1 ? 1 : 0);
  out.push(Math.PI > 3.14, Math.floor(-0.5), Math.ceil(-0.5), Math.round(-0.5), Math.round(0.5));
  out.push(Math.atan2(1, 1).toFixed(4), Math.acos(1), Math.atan(0), Math.asin(0));
  return out.join("|");
}` },
  { name: "array-holes-iter", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [1, , 3];
  out.push(a.length, a.filter((x: any) => true).length, a.map((x: any) => x).length);
  out.push(a.join("-"), JSON.stringify(a), a.indexOf(undefined), a.includes(undefined));
  const sparse: any = new Array(3);
  out.push(sparse.length, JSON.stringify(sparse), Object.keys(sparse).length);
  out.push([...[1, , 3]].length, [...[1, , 3]].map((x: any) => (x === undefined ? "u" : x)).join(","));
  out.push(Array.from([1, , 3], (x: any) => (x === undefined ? "u" : x)).join(","));
  return out.join("|");
}` },
  { name: "object-create-null", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = Object.create(null);
  o.a = 1;
  out.push(o.a, Object.getPrototypeOf(o) === null ? 1 : 0, Object.keys(o).join(","));
  try { out.push(String(o)); } catch (e: any) { out.push("threw"); }
  try { out.push(o.hasOwnProperty("a") ? 1 : 0); } catch (e: any) { out.push("no-hasOwn"); }
  out.push(Object.prototype.hasOwnProperty.call(o, "a") ? 1 : 0);
  const proto: any = { greet() { return "hi"; } };
  const d: any = Object.create(proto, { x: { value: 5, enumerable: true } });
  out.push(d.x, d.greet(), "x" in d, Object.keys(d).join(","));
  return out.join("|");
}` },
  { name: "descriptor-roundtrip", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const src: any = { a: 1 };
  Object.defineProperty(src, "b", { value: 2, enumerable: false, writable: false, configurable: true });
  Object.defineProperty(src, "c", { get: () => 3, enumerable: true });
  const descs: any = Object.getOwnPropertyDescriptors(src);
  out.push(Object.keys(descs).join(","), descs.b.enumerable, descs.b.writable, typeof descs.c.get);
  const copy: any = Object.defineProperties({}, descs);
  out.push(copy.b, copy.c, Object.keys(copy).join(","));
  const frozen: any = Object.freeze({ z: 1 });
  const f2: any = Object.getOwnPropertyDescriptor(frozen, "z");
  out.push(f2.writable, f2.configurable);
  return out.join("|");
}` },
  { name: "iterator-early-exit", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let closed = 0;
  const mk = (vals: any) => ({
    [Symbol.iterator]() {
      let i = 0;
      return {
        next: () => (i < vals.length ? { value: vals[i++], done: false } : { value: undefined, done: true }),
        return: () => { closed++; return { value: undefined, done: true }; }
      };
    }
  });
  for (const v of mk([1, 2, 3])) { if (v === 2) break; }
  out.push(closed);
  const [first] = mk([9, 8]) as any;
  out.push(first);
  let sum = 0;
  for (const v of mk([1, 2, 3])) sum += v;
  out.push(sum, closed);
  out.push([...mk([])].length);
  return out.join("|");
}` },
  { name: "error-cause-stack", fn: "f", ts: `export class AppError extends Error {
  constructor(msg: any, public code: any = 500) { super(msg); this.name = "AppError"; }
}
export function f(): any {
  const out: any = [];
  const e: any = new AppError("bad");
  out.push(e.message, e.name, e.code, e instanceof AppError, e instanceof Error);
  out.push(typeof e.stack, e.stack !== undefined ? 1 : 0 ? 1 : 0);
  const e2: any = new AppError("x", 404);
  out.push(e2.code, e2.toString().indexOf("AppError") === 0 ? 1 : 0);
  try { throw new AppError("thrown", 1); } catch (x: any) { out.push(x.code, x.message, x.name); }
  out.push(new Error("plain").message, String(new TypeError("t")).indexOf("TypeError") === 0 ? 1 : 0);
  return out.join("|");
}` },
  { name: "labeled-blocks", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let hits = 0;
  blk: { hits++; if (hits > 0) break blk; hits += 100; }
  out.push(hits);
  let n = 0;
  lbl: while (n < 5) { n++; if (n === 2) continue lbl; if (n === 4) break lbl; }
  out.push(n);
  let s = "";
  outer: { inner: { s += "a"; break outer; } s += "b"; } s += "c";
  out.push(s);
  let m = 0;
  loop: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { m++; if (j === 1) continue loop; } }
  out.push(m);
  return out.join("|");
}` },
  { name: "switch-block-scope", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const g = (x: any): any => {
    switch (x) {
      case 1: { const v = "one"; return v; }
      case 2: { let v = "two"; v += "!"; return v; }
      default: { const v = "other"; return v + x; }
    }
  };
  out.push(g(1), g(2), g(9));
  const h = (x: any): any => {
    let r = "";
    switch (x) {
      case "a": r += "A";
      case "b": r += "B"; break;
      case "c": r += "C";
      default: r += "D";
    }
    return r;
  };
  out.push(h("a"), h("b"), h("c"), h("z"));
  const arr: any = [];
  for (const v of [1, 2, 3]) { switch (v) { case 2: arr.push("two"); break; default: arr.push(v); } }
  out.push(arr.join(","));
  return out.join("|");
}` },
  { name: "map-nan-keys", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const m: any = new Map();
  m.set(NaN, "nan");
  m.set(0, "zero");
  m.set(-0, "negzero");
  out.push(m.size, m.get(NaN), m.get(0), m.get(-0));
  const o1: any = { id: 1 }, o2: any = { id: 1 };
  const om: any = new Map([[o1, "a"], [o2, "b"]]);
  out.push(om.size, om.get(o1), om.get(o2), om.get({ id: 1 }));
  const s: any = new Set([NaN, NaN, 0, -0, "0"]);
  out.push(s.size, s.has(NaN), s.has(0), s.has(-0), s.has("0"));
  const keys: any = [...m.keys()].map((k: any) => (Number.isNaN(k) ? "NaN" : String(k)));
  out.push(keys.join(","));
  return out.join("|");
}` },
  { name: "bitwise-truncation", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(3000000000 | 0, -3000000000 | 0, 4294967296 >>> 0, -1 >>> 0);
  out.push(3.7 | 0, -3.7 | 0, 3.7 >>> 0, NaN | 0, Infinity | 0);
  out.push("12" | 0, true | 0, null | 0, undefined | 0);
  out.push(1 << 31, (1 << 31) >>> 0, 1 << 32, 2147483647 + (2147483647 | 0) !== 2147483647 ? 1 : 0);
  out.push(0xffffffff | 0, 0x7fffffff | 0, ~0 >>> 0);
  out.push(5 & "3", 5 | "3", 5 ^ "3", "0x10" | 0);
  return out.join("|");
}` },
  { name: "iife-memoize", fn: "f", ts: `const fib = (() => {
  const cache: any = {};
  const go = (n: any): any => {
    if (n < 2) return n;
    if (cache[n] !== undefined) return cache[n];
    const v = go(n - 1) + go(n - 2);
    cache[n] = v;
    return v;
  };
  return go;
})();
const once = (() => { let done = false; let v: any = null; return (fn: any) => { if (!done) { v = fn(); done = true; } return v; }; })();
export function f(): any {
  const out: any = [];
  out.push(fib(20), fib(30), fib(10));
  let calls = 0;
  const g = () => { calls++; return "computed"; };
  out.push(once(g), once(g), calls);
  const memo: any = {};
  const wrap = (fn: any) => (x: any) => (memo[x] !== undefined ? memo[x] : (memo[x] = fn(x)));
  const sq = wrap((x: any) => x * x);
  out.push(sq(3), sq(4), sq(3));
  return out.join("|");
}` },
  { name: "trampoline-recursion", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const sumTo = (n: any, acc: any = 0): any => (n === 0 ? acc : sumTo(n - 1, acc + n));
  out.push(sumTo(200), sumTo(1), sumTo(0));
  const flat = (arr: any, acc: any = []): any => arr.reduce((a: any, x: any) => (Array.isArray(x) ? flat(x, a) : (a.push(x), a)), acc);
  out.push(flat([1, [2, [3, [4]]]]).join(","));
  const countDown = (n: any, acc: any = ""): any => (n === 0 ? acc : countDown(n - 1, acc + n % 10));
  out.push(countDown(10));
  const mapDeep = (o: any, fn: any): any => (Array.isArray(o) ? o.map((x: any) => mapDeep(x, fn))
    : o !== null && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]: any) => [k, mapDeep(v, fn)]))
    : typeof o === "number" ? fn(o) : o);
  out.push(JSON.stringify(mapDeep({ a: 1, b: [2, { c: 3 }] }, (x: any) => x * 10)));
  return out.join("|");
}` },
  { name: "string-replace-edge", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("$$".replace("$", "x"), "$&".replace("$&", "y"), "abc".replace("b", "X"));
  out.push("a.b".replace(/./g, (m: any) => m === "." ? "" : m));
  out.push("name: x".replace(/(\\w+):\\s*(\\w+)/, "$2 $1"));
  out.push("aaa".replace("a", ""), "aaa".replace(/a/, ""), "aaa".replaceAll("a", ""));
  out.push("1,2,3".split(",").map(Number).reduce((a: any, b: any) => a + b, 0));
  out.push("hello".padStart(8, "-").padEnd(11, "="), "x".padStart(0), "ab".repeat(3));
  out.push(" a b ".trim().split(" ").length, "a\\nb".split(/\\n/).length);
  return out.join("|");
}` },
  { name: "nested-destructure-defaults", fn: "f", ts: `function cfg({ host = "h", port = 80, opts: { secure = false, retries = 3 } = {} }: any = {}): any {
  return [host, port, secure, retries].join(",");
}
function pair({ a, b = a * 2 }: any): any { return a + ":" + b; }
function arr([x = 1, [y = 2, z = 3] = []]: any = []): any { return [x, y, z].join(","); }
export function f(): any {
  const out: any = [];
  out.push(cfg(), cfg({ host: "x" }), cfg({ opts: { secure: true } }), cfg({ host: "y", port: 1, opts: { retries: 0 } }));
  out.push(pair({ a: 5 }), pair({ a: 5, b: 9 }));
  out.push(arr(), arr([9]), arr([9, [8]]), arr([9, [8, 7]]));
  const { p = 1, q = p + 1 } = { p: 10 } as any;
  out.push(p, q);
  return out.join("|");
}` },
  { name: "class-static-private", fn: "f", ts: `class Registry {
  static #items: any = [];
  #name: any;
  constructor(name: any) { this.#name = name; Registry.#items.push(name); }
  get name(): any { return this.#name; }
  static get list(): any { return Registry.#items.slice(); }
  static get count(): any { return Registry.#items.length; }
  static has(n: any): any { return Registry.#items.indexOf(n) >= 0; }
  equals(o: any): any { return o instanceof Registry && o.#name === this.#name; }
}
export function f(): any {
  const out: any = [];
  const a: any = new Registry("a");
  const b: any = new Registry("b");
  out.push(a.name, b.name, Registry.count, Registry.list.join(","));
  out.push(Registry.has("a"), Registry.has("z"), a.equals(new Registry("a")), a.equals(b));
  out.push(Object.keys(a).length, Object.getOwnPropertyNames(a).length);
  return out.join("|");
}` },
  { name: "optional-deep-chains", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const data: any = { users: [{ name: "a", roles: ["r1"] }, { name: "b" }] };
  out.push(data?.users?.[0]?.name, data?.users?.[1]?.roles?.[0] ?? "none", data?.missing?.[0]?.name ?? "x");
  const get = (o: any) => o?.a?.b?.c ?? "dflt";
  out.push(get({ a: { b: { c: 1 } } }), get({ a: {} }), get(null), get(undefined));
  const fns: any = { m: () => ({ n: () => "deep" }) };
  out.push(fns?.m?.()?.n?.(), fns?.x?.()?.y ?? "no");
  const arr: any = [1, 2, 3];
  out.push(arr?.[1], arr?.[-1] ?? "neg", arr?.length, (null as any)?.[0] ?? "n");
  return out.join("|");
}` },
];
