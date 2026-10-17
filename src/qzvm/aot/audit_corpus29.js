// 差分审计语料（第二十九批）：类值/原型链深化、闭包+this、高阶函数与互递归、sort 稳定性、浮点累加、Object.prototype.toString 与 Symbol.toStringTag、String.raw、Array.from 迭代器、原型 getter、delete 语义、JSON toJSON、递归深度、trampoline、柯里化、对象字面量 super、类表达式名、extends 表达式、私有静态。
module.exports = [
  { name: "class-value-proto-deep", fn: "f", ts: `class A { m(): any { return "A.m"; } } class B extends A { m(): any { return "B.m"; } n(): any { return "B.n"; } } class C extends B {}
export function f(): any {
  const out: any = [];
  out.push(Object.getPrototypeOf(C) === B, Object.getPrototypeOf(B) === A, Object.getPrototypeOf(A) === Function.prototype);
  out.push(Object.getPrototypeOf(C.prototype) === B.prototype, Object.getPrototypeOf(B.prototype) === A.prototype);
  const c = new C();
  out.push(c.m(), c.n(), c.constructor === C, c instanceof A, c instanceof B);
  out.push(typeof A, A.prototype.constructor === A, A.name, B.name, C.name);
  return out.join("|");
}` },
  { name: "closure-this-capture", fn: "f", ts: `class Counter { count: any = 0; inc(): any { const f = () => { this.count++; return this.count; }; f(); f(); return this.count; } make(): any { return () => this.count * 10; } }
export function f(): any {
  const out: any = [];
  const c = new Counter();
  out.push(c.inc(), c.count);
  const g = c.make();
  out.push(g(), g());
  c.count = 5;
  out.push(g(), c.inc());
  const obj: any = { v: 3, arrow: null, make() { this.arrow = () => this.v; return this.arrow; } };
  const a = obj.make();
  out.push(a(), obj.v);
  return out.join("|");
}` },
  { name: "higher-order-mutual-recursion", fn: "f", ts: `const isEven = (n: any): any => n === 0 ? true : isOdd(n - 1);
const isOdd = (n: any): any => n === 0 ? false : isEven(n - 1);
const fib = (n: any): any => n < 2 ? n : fib(n - 1) + fib(n - 2);
export function f(): any {
  const out: any = [];
  out.push(isEven(10), isOdd(7), isEven(0), isOdd(0));
  out.push(fib(10), fib(15), fib(0), fib(1));
  const compose = (...fns: any) => (x: any) => fns.reduceRight((acc: any, fn: any) => fn(acc), x);
  const add1 = (x: any) => x + 1, dbl = (x: any) => x * 2;
  out.push(compose(add1, dbl)(5), compose(dbl, add1)(5), compose(add1, dbl, add1)(1));
  const pipe = (...fns: any) => (x: any) => fns.reduce((acc: any, fn: any) => fn(acc), x);
  out.push(pipe(add1, dbl, add1)(3));
  return out.join("|");
}` },
  { name: "sort-stability-compare", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const data: any = [{ k: "a", v: 2 }, { k: "b", v: 1 }, { k: "c", v: 2 }, { k: "d", v: 1 }, { k: "e", v: 3 }];
  out.push(data.slice().sort((x: any, y: any) => x.v - y.v).map((x: any) => x.k).join(","));
  out.push([3, 1, 4, 1, 5, 9, 2, 6].sort((a: any, b: any) => a - b).join(","));
  out.push(["b", "a", "c"].sort().join(","), [10, 9, 8].sort().join(","), [10, 9, 8].sort((a: any, b: any) => a - b).join(","));
  out.push([1, 2, 3].sort(() => 0).join(","), [2, 1].sort(() => 1).join(","), [2, 1].sort(() => -1).join(","));
  out.push([5, 3, 8, 1].sort((a: any, b: any) => b - a).join(","));
  out.push(["aa", "b", "ccc"].sort((x: any, y: any) => x.length - y.length).join("|"));
  return out.join("__");
}` },
  { name: "float-accumulation", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let sum = 0; for (let i = 0; i < 10; i++) sum += 0.1;
  out.push(sum, sum.toFixed(10), sum === 1, Math.abs(sum - 1) < 1e-9);
  let s2 = 0; for (let i = 1; i <= 100; i++) s2 += i;
  out.push(s2, s2 === 5050);
  out.push(1e15 + 1 === 1e15, 0.1 + 0.2 === 0.30000000000000004, (0.1 + 0.2).toFixed(2));
  out.push(1 / 3, (1 / 3).toFixed(5), 2 / 3, (2 / 3).toFixed(5));
  out.push(Number((0.1 * 3).toFixed(10)), (0.1 * 3).toFixed(10));
  out.push(123456789.123456789, 1e-7, 1e21, 1e-21 > 0);
  out.push(Math.max(1e308, 1e307), 1e308 + 1e307, Number.isFinite(1e308 * 10));
  return out.join("|");
}` },
  { name: "object-tostring-tag", fn: "f", ts: `class Tagged { get [Symbol.toStringTag](): any { return "Tagged"; } }
export function f(): any {
  const out: any = [];
  out.push(Object.prototype.toString.call([]), Object.prototype.toString.call({}), Object.prototype.toString.call(1));
  out.push(Object.prototype.toString.call("s"), Object.prototype.toString.call(true), Object.prototype.toString.call(null));
  out.push(Object.prototype.toString.call(undefined), Object.prototype.toString.call(() => 1));
  out.push(Object.prototype.toString.call(new Map()), Object.prototype.toString.call(new Set()));
  out.push(Object.prototype.toString.call(new Tagged()), new Tagged()[Symbol.toStringTag]);
  out.push(Object.prototype.toString.call(/x/), Object.prototype.toString.call(new Date(0)));
  return out.join("|");
}` },
  { name: "string-raw-and-misc", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(String.raw\`a\\nb\`, String.raw\`C:\\path\\${"x"}\`, String.raw\`x\${1}y\`);
  out.push(\`a\\nb\`.length, \`a\\nb\`, "a\\nb".length);
  out.push("x".padStart(3, "ab"), "x".padEnd(3, "ab"), "ab".repeat(2));
  out.push("café".length, "café".toUpperCase(), "CAFÉ".toLowerCase());
  out.push("a,b".split(",").length, "a b  c".split(" ").join("|"), "a1b".split(/\\d/).join("|"));
  out.push("\\u00e9".normalize("NFC"), "e\\u0301".normalize("NFC") === "\\u00e9" ? 1 : 0, "e\\u0301".normalize("NFC").length);
  out.push("abc".startsWith("ab"), "abc".endsWith("bc"), "abc".includes("b"));
  return out.join("|");
}` },
  { name: "array-from-iterators", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const gen = { *[Symbol.iterator]() { yield 1; yield 2; yield 3; } };
  out.push(Array.from([1, 2, 3]).join(","), Array.from("ab").join(","));
  out.push(Array.from({ length: 3 }, (_: any, i: any) => i).join(","));
  out.push(Array.from(new Set([1, 2, 2])).join(","), Array.from(new Map([["a", 1]])).length);
  out.push([...new Set([3, 1, 2])].join(","), [...new Map([["k", "v"]]).flat()].join(","));
  const arr: any = [1, 2, 3];
  out.push(Array.from(arr, (x: any) => x * 2).join(","), [...arr].join(","));
  out.push([..."abc"].join("-"), [..."a1b2"].filter((c: any) => /\\d/.test(c)).join(""));
  return out.join("|");
}` },
  { name: "proto-getters-inherit", fn: "f", ts: `class Base { _x: any = 1; get x(): any { return this._x; } set x(v: any) { this._x = v * 2; } get doubled(): any { return this.x * 2; } }
class Sub extends Base { _y: any = 10; get y(): any { return this._y; } get sum(): any { return this.x + this.y; } }
export function f(): any {
  const out: any = [];
  const s = new Sub();
  out.push(s.x, s.doubled, s.y, s.sum);
  s.x = 5;
  out.push(s.x, s.doubled, s.sum, s._x);
  out.push(Base.prototype.hasOwnProperty("x") || "x" in s, "doubled" in s, "y" in s);
  const b = new Base();
  out.push(b.x, b.doubled);
  b.x = 3;
  out.push(b.x, b.doubled);
  return out.join("|");
}` },
  { name: "delete-semantics", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: 2, c: 3 };
  delete o.b;
  out.push(Object.keys(o).join(","), "b" in o, o.b === undefined ? 1 : 0, JSON.stringify(o));
  const arr: any = [1, 2, 3, 4];
  delete arr[1];
  out.push(arr.length, 1 in arr, arr[1] === undefined ? 1 : 0, Object.keys(arr).join(","));
  out.push(JSON.stringify(arr), arr.join(","));
  const o2: any = {};
  o2.x = 1; delete o2.x; o2.y = 2;
  out.push(JSON.stringify(o2), Object.keys(o2).join(","));
  const proto: any = { p: 1 };
  const child: any = Object.create(proto);
  child.c = 2;
  out.push("p" in child, delete child.p, "p" in child);
  return out.join("|");
}` },
  { name: "json-tojson-custom", fn: "f", ts: `class Money { constructor(public amount: any, public cur: any) {} toJSON(): any { return { amount: this.amount, cur: this.cur, formatted: this.amount + " " + this.cur }; } }
export function f(): any {
  const out: any = [];
  out.push(JSON.stringify(new Money(10, "USD")));
  const o: any = { a: 1, toJSON() { return "custom"; } };
  out.push(JSON.stringify(o), JSON.stringify({ nested: o }));
  out.push(JSON.stringify([new Money(1, "A"), new Money(2, "B")]));
  const deep: any = { l1: { l2: { l3: { arr: [1, { x: 2 }] } } } };
  out.push(JSON.stringify(deep));
  out.push(JSON.stringify({ u: undefined, f: () => 1, n: null, s: "str", num: 1.5, b: true }));
  out.push(JSON.parse(JSON.stringify(deep)).l1.l2.l3.x === undefined ? 1 : 0);
  out.push(JSON.stringify({ arr: [undefined, null, 1] }), JSON.stringify([undefined]));
  return out.join("|");
}` },
  { name: "recursion-depth-bounded", fn: "f", ts: `const sumTo = (n: any): any => n <= 0 ? 0 : n + sumTo(n - 1);
const depth = (n: any): any => n === 0 ? 0 : 1 + depth(n - 1);
const ackermannish = (m: any, n: any): any => m === 0 ? n + 1 : n === 0 ? ackermannish(m - 1, 1) : ackermannish(m - 1, ackermannish(m, n - 1));
export function f(): any {
  const out: any = [];
  out.push(sumTo(100), sumTo(500), depth(200));
  out.push(ackermannish(2, 3), ackermannish(1, 5), ackermannish(0, 4));
  const fact = (n: any): any => n <= 1 ? 1 : n * fact(n - 1);
  out.push(fact(10), fact(20));
  const gcd = (a: any, b: any): any => b === 0 ? a : gcd(b, a % b);
  out.push(gcd(48, 18), gcd(17, 5), gcd(100, 75));
  return out.join("|");
}` },
  { name: "trampoline-curry", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const trampoline = (fn: any) => { let r = fn(); while (typeof r === "function") r = r(); return r; };
  const countdown = (n: any): any => () => n <= 0 ? "done" : countdown(n - 1);
  out.push(trampoline(() => countdown(1000)));
  const curry = (fn: any) => { const arity = fn.length; const collect = (args: any): any => (...more: any) => { const all = args.concat(more); return all.length >= arity ? fn(...all) : collect(all); }; return collect([]); };
  const add3 = curry((a: any, b: any, c: any) => a + b + c);
  out.push(add3(1)(2)(3), add3(1, 2)(3), add3(1)(2, 3), add3(1, 2, 3));
  const partial = (fn: any, ...a: any) => (...b: any) => fn(...a, ...b);
  const mul = (a: any, b: any) => a * b;
  out.push(partial(mul, 3)(4), partial(mul)(5)(6));
  return out.join("|");
}` },
  { name: "object-literal-super", fn: "f", ts: `const base: any = { greet() { return "base"; }, get kind(): any { return "B"; } };
const derived: any = { __proto__: base, greet() { return "derived+" + super.greet(); } };
export function f(): any {
  const out: any = [];
  out.push(derived.greet(), derived.kind, "greet" in derived, Object.getPrototypeOf(derived) === base);
  const o: any = { a: 1, b: 2, sum() { return this.a + this.b; }, get product() { return this.a * this.b; } };
  out.push(o.sum(), o.product, Object.keys(o).join(","));
  const obj: any = { _v: 0, set v(x: any) { this._v = x + 1; }, get v() { return this._v; } };
  obj.v = 5;
  out.push(obj.v, obj._v, Object.keys(obj).join(","));
  return out.join("|");
}` },
  { name: "class-expression-names", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const Named = class Inner { tag(): any { return "inner"; } };
  out.push(new Named().tag(), Named.name, typeof Named);
  const Anon = class { tag(): any { return "anon"; } };
  out.push(new Anon().tag(), Anon.name);
  const makeClass = (label: any) => class { get label(): any { return label; } };
  const A = makeClass("A"), B = makeClass("B");
  out.push(new A().label, new B().label, new A() instanceof A, new A() instanceof B);
  const Ext = class extends Named { tag(): any { return "ext+" + super.tag(); } };
  out.push(new Ext().tag(), new Ext() instanceof Named, Ext.name);
  return out.join("|");
}` },
  { name: "private-static-blocks", fn: "f", ts: `class Registry { static #items: any = []; static #count: any = 0;
  static { Registry.#count = 100; }
  static register(x: any): any { Registry.#items.push(x); Registry.#count++; return Registry.#count; }
  static get items(): any { return Registry.#items.slice(); }
  static get count(): any { return Registry.#count; } }
export function f(): any {
  const out: any = [];
  out.push(Registry.count, Registry.register("a"), Registry.register("b"), Registry.count);
  out.push(Registry.items.join(","), Registry.items.length);
  out.push(Registry.register("c"), Registry.items.join(","), Registry.count);
  return out.join("|");
}` },
  { name: "prototype-method-extraction", fn: "f", ts: `class M { v: any = 42; get(): any { return this.v; } }
export function f(): any {
  const out: any = [];
  const m = new M();
  const g = m.get;
  out.push(g.call(m), g.apply(m), g.call({ v: 7 }));
  out.push([1, 2].map(g, m).join(","), [1].map(() => g.call(m)).join(","));
  const proto = M.prototype;
  out.push(typeof proto.get, proto.get.call(m), Object.getPrototypeOf(m) === proto);
  out.push(Object.getOwnPropertyNames(proto).indexOf("get") >= 0, "get" in m);
  const bound = m.get.bind(m);
  out.push(bound(), bound.call({ v: 99 }));
  return out.join("|");
}` },
  { name: "string-template-advanced", fn: "f", ts: `const tag = (strings: any, ...vals: any) => strings.raw.join("|") + "//" + vals.join(",");
export function f(): any {
  const out: any = [];
  out.push(tag\`a\\nb\${1}c\${2}d\`);
  out.push(\`\${"nested " + \`inner \${1 + 1}\`}\`);
  out.push(\`\${[1, 2, 3].map((x: any) => x * 2).join("-")}\`);
  const name = "World";
  out.push(\`Hello, \${name}!\`, \`\${name.length}\${name.toUpperCase()}\`);
  out.push(\`multi
line\`.split("\\n").length, \`tab\\there\`.includes("\\t"));
  out.push(\`\${null}\${undefined}\${0}\${false}\${""}\`);
  const obj: any = { toString() { return "OBJ"; } };
  out.push(\`\${obj}\`, \`\${{ a: 1 }.a}\`);
  return out.join("|");
}` },
  { name: "bitwise-numeric-edge", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(5 & 3, 5 | 3, 5 ^ 3, ~5, 5 << 1, 5 >> 1, -5 >> 1, 5 >>> 1, -5 >>> 1);
  out.push(0x80000000 | 0, 0x7fffffff, 2147483647 + 1 | 0, -2147483648 | 0);
  out.push(1 << 31, 1 << 30, 1 << 32, 1 << 33);
  out.push(NaN | 0, Infinity | 0, -Infinity | 0, 1e20 | 0, "5" | 0, null | 0, undefined | 0);
  out.push(3.9 | 0, -3.9 | 0, 3.9 >> 0, 3.9 << 0, 3.9 ^ 0);
  out.push(0xff & 0x0f, 0b1010 | 0b0101, 0o17 & 0o7);
  out.push(1e9 | 0, 1e10 | 0, 4294967295 >>> 0, 4294967296 >>> 0);
  out.push(true & 1, false | 0, "abc" | 0, [] | 0, [5] | 0);
  return out.join("|");
}` },
  { name: "mixed-realistic-program", fn: "f", ts: `class Task { constructor(public id: any, public title: any, public done: any = false) {} complete(): any { this.done = true; return this; } toString(): any { return "#" + this.id + " " + this.title + (this.done ? " [x]" : " [ ]"); } }
class TaskList { items: any = []; static nextId: any = 1;
  add(title: any): any { const t = new Task(TaskList.nextId++, title); this.items.push(t); return t; }
  get pending(): any { return this.items.filter((t: any) => !t.done); }
  get summary(): any { return this.items.length + " total, " + this.pending.length + " pending"; }
  render(): any { return this.items.map((t: any) => t.toString()).join("; "); } }
export function f(): any {
  const out: any = [];
  const list = new TaskList();
  list.add("write").complete();
  list.add("test");
  list.add("ship");
  out.push(list.summary, list.render());
  list.items[1].complete();
  out.push(list.pending.length, list.summary);
  out.push(list.items.map((t: any) => t.id).join(","), JSON.stringify(list.items[0]));
  out.push(list.items[0] instanceof Task, list.pending[0].title);
  out.push(TaskList.nextId, list.add("extra").id, TaskList.nextId);
  return out.join("|");
}` },
];