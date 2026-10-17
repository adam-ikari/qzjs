// 差分审计语料（第二十一批）：类与继承细节 / 闭包模式 / 高阶数组链 / 协议方法 / 描述符交互 / 短路副作用。
module.exports = [
  { name: "ctor-super-args-chain", fn: "f", ts: `class A { id: any; constructor(id: any) { this.id = id; } tag(): any { return "A" + this.id; } }
class B extends A { extra: any; constructor(id: any, extra: any) { super(id * 10); this.extra = extra; } tag(): any { return super.tag() + "/B" + this.extra; } }
class C extends B { constructor() { super(2, "x"); } tag(): any { return super.tag() + "/C"; } }
export function f(): any {
  const out: any = [];
  const c = new C();
  out.push(c.id, c.extra, c.tag());
  out.push(c instanceof A ? 1 : 0, c instanceof B ? 1 : 0, c instanceof C ? 1 : 0);
  return out.join("|");
}` },
  { name: "closure-currying-memo", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const add = (a: any) => (b: any) => a + b;
  out.push(add(2)(3), add(10)(-1));
  let calls = 0;
  const cache: any = {};
  const memo = (n: any): any => { calls++; if (cache[n] !== undefined) return cache[n]; const v = n * n; cache[n] = v; return v; };
  out.push(memo(4), memo(4), memo(5), calls);
  const compose = (f2: any, g: any) => (x: any) => f2(g(x));
  const inc = (x: any) => x + 1, dbl = (x: any) => x * 2;
  out.push(compose(inc, dbl)(5), compose(dbl, inc)(5));
  return out.join("|");
}` },
  { name: "array-chain-pipeline", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const xs: any = [5, 1, 4, 2, 3, 6];
  out.push(xs.filter((x: any) => x % 2 === 0).map((x: any) => x * 10).join(","));
  out.push(xs.slice().sort((a: any, b: any) => a - b).join(","));
  out.push(xs.slice().sort((a: any, b: any) => b - a).join(","));
  out.push([1, 2, 3, 4].reduce((a: any, b: any) => a + b, 100));
  out.push([[1, 2], [3], [4, 5]].flat().reduce((a: any, b: any) => a + b, 0));
  const grouped: any = {};
  for (const x of xs) { const k = x % 2 === 0 ? "even" : "odd"; (grouped[k] = grouped[k] || []).push(x); }
  out.push(JSON.stringify(grouped));
  return out.join("|");
}` },
  { name: "object-spread-override", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const base: any = { a: 1, b: 2 };
  const over: any = { ...base, b: 99, c: 3 };
  out.push(JSON.stringify(over), Object.keys(over).join(","));
  const merged: any = Object.assign({}, base, { d: 4 }, over);
  out.push(JSON.stringify(merged));
  const { a, ...rest } = over;
  out.push(a, JSON.stringify(rest));
  const dyn: any = {};
  const k1 = "x", k2 = "y";
  dyn[k1 + k2] = 7;
  out.push(JSON.stringify(dyn), Object.keys(dyn).join(","));
  return out.join("|");
}` },
  { name: "protocol-valueof-compare", fn: "f", ts: `class Ver { n: any; constructor(n: any) { this.n = n; } valueOf(): any { return this.n; } toString(): any { return "v" + this.n; } }
export function f(): any {
  const out: any = [];
  const a = new Ver(2), b = new Ver(3);
  out.push(a < b ? 1 : 0, b > a ? 1 : 0, a == 2 ? 1 : 0, a + b);
  out.push(Math.max(a, b), [b, a].sort().map((v: any) => String(v)).join(","));
  out.push(String(a), \`\${b}\`, a === 2 ? 1 : 0);
  out.push(a - 1, a * 3, -a);
  return out.join("|");
}` },
  { name: "descriptor-getter-setter", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { _v: 1 };
  Object.defineProperty(o, "v", { get() { return this._v * 2; }, set(x: any) { this._v = x; }, enumerable: false, configurable: true });
  out.push(o.v);
  o.v = 21;
  out.push(o.v, o._v, Object.keys(o).join(","));
  out.push(JSON.stringify(o));
  const keys: any = [];
  for (const k in o) keys.push(k);
  out.push(keys.join(","), o.hasOwnProperty("v") ? 1 : 0, "v" in o ? 1 : 0);
  return out.join("|");
}` },
  { name: "shortcircuit-sideeffects", fn: "f", ts: `export function f(): any {
  const log: any = [];
  const t = (v: any, name: any) => { log.push(name); return v; };
  const out: any = [];
  out.push(t(false, "a") && t(true, "b"), log.join(""));
  log.length = 0;
  out.push(t(true, "c") || t(false, "d"), log.join(""));
  log.length = 0;
  out.push(t(0, "e") ?? t(1, "f"), log.join(""));
  log.length = 0;
  out.push(t(null, "g") ?? t(2, "h"), log.join(""));
  out.push((false || "x") + ("" || "y"), (1 && 2) || 3);
  return out.join("|");
}` },
  { name: "darkmatter-labeled-dispatch", fn: "f", ts: `export function f(op: any, a: any, b: any): any {
  const table: any = {
    add: (x: any, y: any) => x + y,
    sub: (x: any, y: any) => x - y,
    mul: (x: any, y: any) => x * y
  };
  if (table[op]) return table[op](a, b);
  switch (op) {
    case "div": return b === 0 ? "inf" : a / b;
    case "mod": return a % b;
    default: return "?";
  }
}`, args: ["mul", 6, 7] },
  { name: "state-machine-switch", fn: "f", ts: `export function f(input: any): any {
  let state = "start";
  const seen: any = [];
  for (const ch of input) {
    switch (state) {
      case "start":
        if (ch === "a") { state = "inA"; seen.push("A"); }
        else if (ch === " ") { state = "space"; }
        break;
      case "inA":
        if (ch === "a") { seen.push("A"); }
        else if (ch === " ") { state = "space"; }
        else { state = "other"; seen.push("X"); }
        break;
      case "space":
        if (ch === "b") { state = "inB"; seen.push("B"); }
        else state = "start";
        break;
      case "inB":
        if (ch === "b") seen.push("B");
        else state = "other";
        break;
      default:
        seen.push("?");
    }
  }
  return seen.join("") + "#" + state;
}`, args: ["aab b"] },
  { name: "try-catch-nested-finally", fn: "f", ts: `export function f(): any {
  const log: any = [];
  function inner(): any {
    try {
      try { throw new Error("deep"); }
      finally { log.push("fin1"); }
    } catch (e: any) {
      log.push("caught:" + e.message);
      try { throw new Error("re"); }
      catch (e2: any) { log.push("caught2:" + e2.message); return "from-catch2"; }
      finally { log.push("fin2"); }
    } finally { log.push("fin3"); }
  }
  const r = inner();
  return log.join(",") + "|" + r;
}` },
  { name: "closure-counter-variants", fn: "f", ts: `export function f(): any {
  const out: any = [];
  function makeCounter(start: any): any {
    let n = start;
    return { inc: () => ++n, dec: () => --n, reset: () => { n = start; return n; }, get value() { return n; } };
  }
  const c1 = makeCounter(0), c2 = makeCounter(10);
  c1.inc(); c1.inc();
  c2.dec();
  out.push(c1.value, c2.value);
  out.push(c1.reset(), c1.value, c2.value);
  const shared: any = (() => { let total = 0; return { add: (x: any) => total += x, get: () => total }; })();
  shared.add(5); shared.add(7);
  out.push(shared.get());
  return out.join("|");
}` },
  { name: "string-template-methods", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const items: any = [{ n: "a", v: 1 }, { n: "b", v: 2 }];
  out.push(items.map((i: any) => \`\${i.n}=\${i.v}\`).join(","));
  out.push(\`total=\${items.reduce((a: any, i: any) => a + i.v, 0)}\`);
  const name = "x";
  out.push(\`pre\${name.toUpperCase()}post\`, \`\${name.length}\${name.slice(0, 1)}\`);
  out.push(\`multi
line\`.split("\\n").length);
  return out.join("|");
}` },
  { name: "map-set-operations", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const m: any = new Map();
  m.set("a", 1); m.set("b", 2);
  m.set("a", 3);
  out.push(m.size, m.get("a"), m.has("c") ? 1 : 0);
  out.push([...m.keys()].join(","), [...m.values()].join(","));
  m.delete("a");
  out.push(m.size, m.get("a") === undefined ? 1 : 0);
  const s: any = new Set([1, 2, 2, 3]);
  s.add(4); s.delete(1);
  out.push(s.size, [...s].join(","), s.has(3) ? 1 : 0);
  const arr: any = [];
  m.forEach((v: any, k: any) => arr.push(k + ":" + v));
  out.push(arr.join(","));
  return out.join("|");
}` },
  { name: "integer-math-edge", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(2 ** 10, 2 ** 0.5 === Math.sqrt(2) ? 1 : 0, (-2) ** 3);
  out.push(7 / 2, 7 % 2, -7 / 2, -7 % 2);
  out.push(Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1 === Number.MAX_SAFE_INTEGER + 2 ? 1 : 0);
  out.push(0.1 + 0.2 === 0.3 ? 1 : 0, Math.abs(0.1 + 0.2 - 0.3) < 1e-10 ? 1 : 0);
  out.push((123.456).toFixed(1), Math.trunc(-0.5), Math.round(-0.5), Math.round(0.5));
  out.push(parseInt("0x1f"), parseInt("0b11", 2), Number("0x10"), Number("1e2"));
  return out.join("|");
}` },
  { name: "class-fields-arrow-this", fn: "f", ts: `class T {
  v: any = 7;
  getV = () => this.v;
  double = () => this.getV() * 2;
  viaMethod(): any { return this.getV(); }
}
export function f(): any {
  const out: any = [];
  const t = new T();
  out.push(t.getV(), t.double(), t.viaMethod());
  const g = t.getV;
  out.push(g(), t.double());
  const d = t.double;
  out.push(d());
  return out.join("|");
}` },
  { name: "inherit-getter-ctor-read", fn: "f", ts: `class A { _x: any; constructor() { this._x = 5; } get x(): any { return this._x; } }
class B extends A { constructor() { super(); this._x = this._x + 1; } get x(): any { return super.x * 10; } }
export function f(): any {
  const out: any = [];
  const b = new B();
  out.push(b.x, b._x);
  const a = new A();
  out.push(a.x, a._x);
  return out.join("|");
}` },
  { name: "deep-clone-and-compare", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const src: any = { a: 1, b: { c: [1, 2, { d: 3 }] }, e: null };
  const clone: any = JSON.parse(JSON.stringify(src));
  out.push(JSON.stringify(clone) === JSON.stringify(src) ? 1 : 0);
  clone.b.c[0] = 99;
  out.push(src.b.c[0], clone.b.c[0]);
  out.push(Object.keys(clone).join(","), Array.isArray(clone.b.c) ? 1 : 0);
  const shallow: any = { ...src };
  shallow.b.c[1] = 88;
  out.push(src.b.c[1]);
  return out.join("|");
}` },
  { name: "for-in-vs-keys-vs-entries", fn: "f", ts: `class Base { inherited: any = "i"; }
class Sub extends Base { own: any = "o"; }
export function f(): any {
  const out: any = [];
  const s = new Sub();
  const forIn: any = [];
  for (const k in s) forIn.push(k);
  out.push(forIn.join(","), Object.keys(s).join(","));
  const o: any = { z: 1, a: 2 };
  o.m = 3;
  out.push(Object.keys(o).join(","), Object.entries(o).map((e: any) => e[0] + "=" + e[1]).join(","));
  const vals: any = [];
  for (const k in o) vals.push(o[k]);
  out.push(vals.join(","));
  return out.join("|");
}` },
];
