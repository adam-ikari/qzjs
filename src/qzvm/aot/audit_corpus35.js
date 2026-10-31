// 差分审计语料（第三十五批）：原型访问器（defineProperty on prototype）、静态继承与 super、解构形参+默认值+rest、
// catch 解构、自定义迭代器、JSON.toJSON、Date 确定性操作、数组排序边界、类实例的属性描述符、delete/in/typeof 组合、闭包 + do-while、互递归。
module.exports = [
  { name: "proto-accessors", fn: "f", ts: `export function f(): any {
  const proto: any = {};
  Object.defineProperty(proto, "computed", { get() { return this._v * 2; }, set(x: any) { this._v = x + 1; }, configurable: true });
  const o: any = Object.create(proto);
  o._v = 5;
  const out: any = [];
  out.push(o.computed);
  o.computed = 10;
  out.push(o._v, o.computed);
  out.push(Object.getOwnPropertyNames(proto).join(","), Object.keys(o).join(","));
  out.push("computed" in o, proto.hasOwnProperty("computed"));
  return out.join("|");
}` },
  { name: "static-inherit-super", fn: "f", ts: `class A {
  static tag: any = "A";
  static describe(): any { return "A:" + this.tag; }
  static who(): any { return A.name; }
}
class B extends A {
  static tag: any = "B";
  static describe(): any { return "B+" + super.describe(); }
}
export function f(): any {
  const out: any = [];
  out.push(A.describe(), B.describe());
  out.push(B.who(), B.tag, A.tag);
  out.push(Object.getPrototypeOf(B) === A, B.prototype instanceof A);
  out.push(typeof B, B.name);
  return out.join("|");
}` },
  { name: "destructure-params", fn: "f", ts: `function opts({ a = 1, b = 2, ...rest }: any = {}): any { return [a, b, JSON.stringify(rest)].join(","); }
function arr([x = 0, y = 0, ...zs]: any = []): any { return [x, y, zs.length].join(","); }
function combo(a: any, { b = 10 }: any = {}, ...cs: any[]): any { return [a, b, cs.join("-")].join(":"); }
export function f(): any {
  const out: any = [];
  out.push(opts(), opts({ a: 5 }), opts({ a: 1, b: 2, c: 3, d: 4 }));
  out.push(arr(), arr([1]), arr([1, 2, 3, 4]));
  out.push(combo(1), combo(1, { b: 2 }), combo(1, { b: 2 }, 3, 4));
  return out.join("|");
}` },
  { name: "catch-destructure", fn: "f", ts: `export function f(): any {
  const out: any = [];
  try { throw new TypeError("bad value"); } catch ({ message, name }: any) { out.push(name, message); }
  try { throw { code: 42, detail: { info: "deep" } }; } catch ({ code, detail }: any) { out.push(code, detail.info); }
  try { JSON.parse("{"); } catch (e: any) { out.push(e instanceof SyntaxError, e.name); }
  try { null as any .x; } catch ({ name }: any) { out.push(name); }
  return out.join("|");
}` },
  { name: "custom-iterator-class", fn: "f", ts: `class Range {
  constructor(public start: any, public end: any) {}
  [Symbol.iterator](): any {
    let i = this.start;
    const end = this.end;
    return { next: () => (i <= end ? { value: i++, done: false } : { value: undefined, done: true }) };
  }
}
export function f(): any {
  const out: any = [];
  const r: any = new Range(1, 4);
  out.push([...r].join(","));
  for (const v of r) if (v % 2 === 0) out.push("e" + v);
  out.push(Array.from(r).join("+"));
  const [first, ...rest] = r as any;
  out.push(first, rest.join(""));
  out.push([...new Range(5, 5)].join(","), [...new Range(3, 1)].length);
  return out.join("|");
}` },
  { name: "json-tojson", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, toJSON() { return { replaced: true }; } };
  out.push(JSON.stringify(o));
  const nested: any = { x: { keep: 1, skip: undefined }, y: [1, undefined, 2] };
  out.push(JSON.stringify(nested));
  const withFn: any = { f: () => 1, n: 2, s: "t", b: false, z: null };
  out.push(JSON.stringify(withFn));
  const dateLike: any = { when: { toJSON(): any { return "2024-01-01"; } } };
  out.push(JSON.stringify(dateLike));
  out.push(JSON.stringify([[1, 2], [3]], null, 0));
  return out.join("|");
}` },
  { name: "date-deterministic", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const d: any = new Date(0);
  out.push(d.getTime(), d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  d.setUTCFullYear(2024, 0, 15);
  out.push(d.getUTCFullYear() + "-" + (d.getUTCMonth() + 1) + "-" + d.getUTCDate());
  out.push(Date.UTC(2020, 5, 15), typeof Date.now() === "number");
  const d2: any = new Date(2024, 0, 1);
  out.push(d2.getFullYear(), d2.getMonth(), d2.getDate());
  out.push(new Date(1000).getTime() - new Date(0).getTime());
  out.push(Object.prototype.toString.call(new Date(0)));
  return out.join("|");
}` },
  { name: "sort-edge-values", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push([3, undefined, 1, null, 2].sort().join(","));
  out.push(["B", "a", "Z"].sort().join(","));
  out.push([10, 5, 40, 25].sort().join(","));
  out.push([10, 5, 40, 25].sort((a: any, b: any) => a - b).join(","));
  const words: any = ["bb", "a", "ccc"];
  out.push(words.slice().sort((x: any, y: any) => x.length - y.length).join(","));
  const nums: any = [3, 1, 2];
  const sorted: any = nums.toSorted ? nums.toSorted() : nums.slice().sort();
  out.push(sorted.join(","), nums.join(","));
  return out.join("|");
}` },
  { name: "instance-descriptors", fn: "f", ts: `class P {
  a: any = 1;
  #priv: any = 2;
  get b(): any { return this.a + 1; }
}
export function f(): any {
  const out: any = [];
  const p: any = new P();
  Object.defineProperty(p, "extra", { value: 9, enumerable: true, writable: false, configurable: false });
  out.push(p.extra, Object.keys(p).join(","));
  const d: any = Object.getOwnPropertyDescriptor(p, "extra");
  out.push(d.value, d.writable, d.enumerable, d.configurable);
  out.push(Object.getOwnPropertyNames(p).join(","));
  out.push(p.a, p.b);
  p.a = 10;
  out.push(p.b, p.a);
  return out.join("|");
}` },
  { name: "delete-in-typeof", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: 2 };
  out.push("a" in o, "z" in o, delete o.a, "a" in o);
  out.push(Object.keys(o).join(","));
  const arr: any = [1, 2, 3];
  out.push(1 in arr, 5 in arr, delete arr[1], 1 in arr, arr.length);
  const fns: any = { s: "x", n: 1, f: () => 1, z: null, u: undefined };
  out.push(typeof fns.s, typeof fns.n, typeof fns.f, typeof fns.z, typeof fns.u, typeof fns.missing);
  out.push(typeof [], typeof {}, typeof null, typeof true, typeof undefined);
  return out.join("|");
}` },
  { name: "class-instance-delete", fn: "f", ts: `class C { x: any = 1; y: any = 2; m(): any { return this.x + this.y; } }
export function f(): any {
  const out: any = [];
  const c: any = new C();
  out.push(c.m(), Object.keys(c).join(","));
  delete c.y;
  out.push(c.m(), Object.keys(c).join(","), c.y === undefined ? 1 : 0);
  c.y = 5;
  out.push(c.m());
  out.push(Object.getOwnPropertyNames(C.prototype).join(","));
  return out.join("|");
}` },
  { name: "dowhile-closures", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const fns: any = [];
  let i = 0;
  do { const k = i; fns.push(() => k * 10); i++; } while (i < 3);
  out.push(fns.map((g: any) => g()).join(","));
  let n = 0;
  while (true) { n++; if (n >= 3) break; }
  out.push(n);
  let acc = "";
  for (let j = 0; j < 5; j++) { if (j === 1) continue; if (j === 4) break; acc += j; }
  out.push(acc);
  let count = 0;
  outer: for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) { count++; if (b === 1) continue outer; } }
  out.push(count);
  return out.join("|");
}` },
  { name: "mutual-recursion", fn: "f", ts: `function isEven(n: any): any { return n === 0 ? true : isOdd(n - 1); }
function isOdd(n: any): any { return n === 0 ? false : isEven(n - 1); }
export function f(): any {
  const out: any = [];
  out.push(isEven(10), isOdd(10), isEven(7), isOdd(7));
  const fib = (n: any): any => (n < 2 ? n : fib(n - 1) + fib(n - 2));
  out.push(fib(12));
  const fact = (n: any, acc: any = 1): any => (n <= 1 ? acc : fact(n - 1, acc * n));
  out.push(fact(6));
  const sum = (arr: any): any => (arr.length === 0 ? 0 : arr[0] + sum(arr.slice(1)));
  out.push(sum([1, 2, 3, 4, 5]));
  return out.join("|");
}` },
  { name: "map-set-convert", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const entries: any = [["a", 1], ["b", 2]];
  const m: any = new Map(entries as any);
  out.push(JSON.stringify(Object.fromEntries(m as any)));
  out.push([...m].map((e: any) => e.join("=")).join(","));
  const s: any = new Set([1, 2, 3]);
  out.push([...s].map((x: any) => x * 2).join(","));
  const m2: any = new Map([[1, "one"], [2, "two"]]);
  const flipped: any = new Map([...m2].map(([k, v]: any) => [v, k]));
  out.push(flipped.get("one"), flipped.get("two"));
  out.push([...new Set("aabbcc")].join(""), [...new Map([[1, 1], [1, 2]]).values()].join(","));
  out.push(Array.from(m.keys()).length, m.size === Array.from(m).length);
  return out.join("|");
}` },
  { name: "template-literal-raw-edge", fn: "f", ts: `function join(strings: any, ...vals: any[]): any {
  let s = "";
  for (let i = 0; i < strings.length; i++) { s += strings[i]; if (i < vals.length) s += "[" + vals[i] + "]"; }
  return s;
}
function count(strings: any): any { return strings.length + ":" + strings.raw.length; }
export function f(): any {
  const out: any = [];
  out.push(join\`a\${1}b\${2}c\`);
  out.push(join\`x\${"y"}z\`);
  out.push(join\`no\${"sub"}\`);
  out.push(count\`a\${1}b\${2}c\${3}\`, count\`only\`);
  const t: any = "T";
  out.push(join\`\${t}\${t}\`);
  return out.join("|");
}` },
  { name: "getter-setter-side-effects", fn: "f", ts: `class Store {
  #data: any = {};
  get size(): any { return Object.keys(this.#data).length; }
  set item(k: any) { this.#data[k] = (this.#data[k] || 0) + 1; }
  get item(): any { return "n/a"; }
  read(k: any): any { return this.#data[k] || 0; }
}
export function f(): any {
  const out: any = [];
  const s: any = new Store();
  out.push(s.size);
  s.item = "a"; s.item = "a"; s.item = "b";
  out.push(s.size, s.read("a"), s.read("b"), s.read("zz"));
  out.push(s.item);
  const o: any = { _n: 0, get n() { return this._n; }, set n(v: any) { this._n = v * 2; }, inc() { this.n = this.n + 1; return this.n; } };
  o.n = 3;
  out.push(o.n, o.inc(), o._n);
  return out.join("|");
}` },
  { name: "spread-call-dynamic", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const pushAll = (target: any, items: any) => { target.push(...items); return target.length; };
  const arr: any = [1];
  out.push(pushAll(arr, [2, 3]), arr.join(","));
  const obj: any = { prefix: "p", join(...xs: any[]): any { return this.prefix + xs.join(""); } };
  const args: any = ["a", "b", "c"];
  out.push(obj.join(...args), obj.join("z"));
  const math: any = Math.max(...[3, 9, 4]);
  out.push(math, Math.min(...[], 5));
  const nums: any = [1, 2, 3];
  out.push([...nums, ...nums].join(","), [...nums].length);
  return out.join("|");
}` },
];
