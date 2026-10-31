// 差分审计语料（第二十二批）：默认参数间依赖 / 原型与描述符 / 迭代协议细节 / 正则分组 / 错误链 / 类字段与静态块。
module.exports = [
  { name: "default-params-depend", fn: "f", ts: `function g(a: any, b: any = a * 2, c: any = a + b): any { return [a, b, c].join(","); }
export function f(): any {
  const out: any = [];
  out.push(g(1), g(1, 5), g(1, undefined, 9), g(2, 0));
  const h = (x: any = 3, y: any = x + 1) => x * y;
  out.push(h(), h(2), h(2, 5));
  return out.join("|");
}` },
  { name: "prototype-chain-call", fn: "f", ts: `function Animal(this: any, name: any) { this.name = name; }
Animal.prototype.speak = function (this: any) { return this.name + " makes a sound"; };
function Dog(this: any, name: any) { Animal.call(this, name); }
Dog.prototype = Object.create(Animal.prototype);
Dog.prototype.constructor = Dog;
export function f(): any {
  const out: any = [];
  const d: any = new (Dog as any)("Rex");
  out.push(d.name, d.speak(), d instanceof (Animal as any) ? 1 : 0);
  const proto: any = Object.getPrototypeOf(d);
  out.push(proto === Dog.prototype ? 1 : 0, proto.speak ? 1 : 0);
  return out.join("|");
}` },
  { name: "class-fields-order-static-block", fn: "f", ts: `class Config {
  static base: any = 10;
  static derived: any = Config.base * 2;
  static log: any = [];
  static { Config.log.push("block1"); }
  static after: any = Config.log.length;
  a: any = 1;
  b: any = this.a + 1;
  static { Config.log.push("block2"); }
  sum(): any { return this.a + this.b; }
}
export function f(): any {
  const out: any = [];
  out.push(Config.base, Config.derived, Config.log.join(","), Config.after);
  const c = new Config();
  out.push(c.a, c.b, c.sum());
  return out.join("|");
}` },
  { name: "regex-groups-and-flags", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const m: any = "2024-06-15".match(/(\\d{4})-(\\d{2})-(\\d{2})/);
  out.push(m[0], m[1], m[2], m[3], m.index, m.length);
  out.push("a1b2c3".replace(/(\\d)/g, "[$1]"));
  out.push("x y  z".split(/\\s+/).join("|"));
  out.push("aaa".replace(/a/g, "b"));
  out.push((/b/i).test("ABC") ? 1 : 0, (/b/).test("ABC") ? 1 : 0);
  const g: any = "a1b2".match(/\\w\\d/g);
  out.push(g.join(","), g.length);
  return out.join("|");
}` },
  { name: "error-chain-finally", fn: "f", ts: `class MyErr extends Error { extra: any; constructor(m: any, extra: any) { super(m); this.extra = extra; } }
export function f(): any {
  const log: any = [];
  function risky(n: any): any {
    try {
      if (n === 0) throw new MyErr("zero", 42);
      if (n < 0) throw new MyErr("neg", -n);
      return "ok" + n;
    } catch (e: any) {
      log.push("c:" + e.message + ":" + (e.extra !== undefined ? e.extra : "-"));
      if (n < 0) throw new MyErr("re:" + e.message, 0);
      return "handled";
    } finally {
      log.push("f:" + n);
    }
  }
  const out: any = [];
  out.push(risky(1));
  out.push(risky(0));
  try { risky(-5); } catch (e: any) { out.push("outer:" + e.message); }
  out.push(log.join(" "));
  return out.join("|");
}` },
  { name: "map-set-object-keys", fn: "f", ts: `class K { id: any; constructor(id: any) { this.id = id; } toString(): any { return "K" + this.id; } }
export function f(): any {
  const out: any = [];
  const m: any = new Map();
  const k1 = new K(1), k2 = new K(2);
  m.set(k1, "a"); m.set(k2, "b"); m.set("k1", "s");
  out.push(m.size, m.get(k1), m.get(k2), m.get("k1"));
  out.push([...m.keys()].map((k: any) => String(k)).join(","));
  const s: any = new Set([k1, k2, k1]);
  out.push(s.size, s.has(k1) ? 1 : 0, s.has("k1") ? 1 : 0);
  const nested: any = new Map([["x", new Map([["y", 1]])]]);
  out.push(nested.get("x").get("y"));
  return out.join("|");
}` },
  { name: "iteration-protocols", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const m: any = new Map([["a", 1], ["b", 2]]);
  const acc: any = [];
  for (const [k, v] of m) acc.push(k + "=" + v);
  out.push(acc.join(","));
  for (const k of m.keys()) acc.push("k:" + k);
  out.push(acc.slice(2).join(","));
  const s: any = new Set([3, 1, 2]);
  const sorted: any = [...s].sort((a: any, b: any) => a - b);
  out.push(sorted.join(","));
  const entries: any = [...m.entries()].map((e: any) => e[0] + e[1]);
  out.push(entries.join(""));
  const arr: any = [10, 20];
  for (const [i, v] of arr.entries()) acc.push(i + ":" + v);
  out.push(acc.slice(-2).join(","));
  return out.join("|");
}` },
  { name: "object-descriptors-proto", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const proto: any = { greet() { return "hi"; }, n: 1 };
  const child: any = Object.create(proto);
  child.own = 2;
  out.push(child.greet ? child.greet() : "na", child.n, child.own);
  out.push(Object.keys(child).join(","), Object.getPrototypeOf(child) === proto ? 1 : 0);
  out.push("n" in child ? 1 : 0, child.hasOwnProperty("n") ? 1 : 0);
  const frozen: any = Object.freeze({ x: 1 });
  out.push(Object.isFrozen(frozen) ? 1 : 0, frozen.x);
  return out.join("|");
}` },
  { name: "string-compare-sort", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const words: any = ["banana", "Apple", "cherry", "apple"];
  out.push(words.slice().sort().join(","));
  out.push(words.slice().sort((a: any, b: any) => a.toLowerCase() < b.toLowerCase() ? -1 : 1).join(","));
  out.push("a" < "b" ? 1 : 0, "A" < "a" ? 1 : 0, "abc" < "abd" ? 1 : 0);
  out.push("10" < "9" ? 1 : 0, 10 < 9 ? 1 : 0);
  const objs: any = [{ n: 3 }, { n: 1 }, { n: 2 }];
  out.push(objs.slice().sort((a: any, b: any) => a.n - b.n).map((o: any) => o.n).join(","));
  return out.join("|");
}` },
  { name: "closures-module-pattern", fn: "f", ts: `const Mod: any = (function () {
  let secret = 0;
  const listeners: any = [];
  return {
    inc(): any { secret++; return secret; },
    get value(): any { return secret; },
    on(fn: any): any { listeners.push(fn); return listeners.length; },
    emit(v: any): any { return listeners.map((f: any) => f(v)).join(","); }
  };
})();
export function f(): any {
  const out: any = [];
  Mod.inc(); Mod.inc();
  out.push(Mod.value, Mod.on((x: any) => x * 2), Mod.on((x: any) => x + 1));
  out.push(Mod.emit(10));
  return out.join("|");
}` },
  { name: "math-rounding-floats", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Math.round(2.5), Math.round(3.5), Math.round(-2.5), Math.round(-3.5));
  out.push(Math.round(2.4), Math.round(2.6), Math.round(-0.5), Math.round(0.5));
  out.push((1.005).toFixed(2), (2.675).toFixed(2), (0.1 + 0.2).toFixed(2));
  out.push((1234.5).toFixed(0), Math.floor(-0.5), Math.ceil(-0.5));
  out.push(5 % 3, -5 % 3, 5.5 % 2, 0.3 - 0.1 > 0.19 ? 1 : 0);
  out.push(Math.abs(-0), Object.is(Math.abs(-0), 0) ? 1 : 0);
  return out.join("|");
}` },
  { name: "logical-assignment-ops", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 0, b: "", c: null, d: 5 };
  o.a ||= 10;
  o.b ||= "x";
  o.c ??= "d";
  o.d &&= 7;
  out.push(JSON.stringify(o));
  const arr: any = [0, 1, 2];
  arr[0] ||= 99;
  arr[1] ??= 88;
  out.push(arr.join(","));
  let n: any = null;
  n ??= 3;
  n += 1;
  out.push(n);
  const nested: any = { p: { q: 0 } };
  nested.p.q ||= 42;
  out.push(nested.p.q);
  return out.join("|");
}` },
  { name: "class-inherit-override-super", fn: "f", ts: `class Shape { name: any = "shape"; area(): any { return 0; } describe(): any { return this.name + ":" + this.area(); } }
class Rect extends Shape { w: any; h: any; constructor(w: any, h: any) { super(); this.name = "rect"; this.w = w; this.h = h; } area(): any { return this.w * this.h; } describe(): any { return "[" + super.describe() + "]"; } }
class Square extends Rect { constructor(s: any) { super(s, s); this.name = "square"; } }
export function f(): any {
  const out: any = [];
  const shapes: any = [new Shape(), new Rect(2, 3), new Square(4)];
  for (const s of shapes) out.push(s.describe());
  out.push(shapes.filter((s: any) => s instanceof Shape).length);
  out.push(shapes.filter((s: any) => s instanceof Rect).length);
  return out.join("|");
}` },
  { name: "array-of-objects-aggregate", fn: "f", ts: `export function f(): any {
  const rows: any = [
    { dept: "a", amount: 10 }, { dept: "b", amount: 20 },
    { dept: "a", amount: 5 }, { dept: "b", amount: 1 }, { dept: "c", amount: 7 }
  ];
  const out: any = [];
  const byDept: any = {};
  for (const r of rows) byDept[r.dept] = (byDept[r.dept] || 0) + r.amount;
  out.push(Object.keys(byDept).sort().map((k: any) => k + "=" + byDept[k]).join(","));
  out.push(rows.reduce((a: any, r: any) => a + r.amount, 0));
  out.push(rows.map((r: any) => r.amount).filter((a: any) => a > 5).length);
  out.push(rows.slice().sort((a: any, b: any) => b.amount - a.amount)[0].dept);
  const total: any = rows.reduce((acc: any, r: any) => { acc[r.dept] = (acc[r.dept] || 0) + 1; return acc; }, {});
  out.push(JSON.stringify(total));
  return out.join("|");
}` },
  { name: "switch-complex-cases", fn: "f", ts: `export function f(t: any): any {
  let r = "";
  switch (t) {
    case "a": case "b": r = "ab"; break;
    case "c": r = "c"; break;
    default: r = "other";
  }
  switch (true) {
    case 1 > 2: r += "|no"; break;
    case 2 > 1: r += "|yes";
  }
  return r;
}`, args: ["b"] },
  { name: "try-in-loop-continue", fn: "f", ts: `export function f(): any {
  const out: any = [];
  for (let i = 0; i < 4; i++) {
    try {
      if (i === 1) continue;
      if (i === 3) break;
      out.push("t" + i);
    } finally {
      out.push("f" + i);
    }
  }
  let j = 0;
  while (j < 3) {
    try { j++; if (j === 2) continue; out.push("w" + j); } finally { out.push("g" + j); }
  }
  return out.join(",");
}` },
  { name: "json-tojson-replacer", fn: "f", ts: `class Money { amount: any; constructor(a: any) { this.amount = a; } toJSON(): any { return "$" + this.amount; } }
export function f(): any {
  const out: any = [];
  out.push(JSON.stringify(new Money(5)));
  out.push(JSON.stringify({ m: new Money(7), list: [1, new Money(2)] }));
  out.push(JSON.stringify({ a: 1, b: 2 }, ["a"]));
  out.push(JSON.stringify({ a: 1 }, null, 2).split("\\n").length);
  const parsed: any = JSON.parse('{"x":{"y":[1,2,3]}}');
  out.push(parsed.x.y.length, JSON.stringify(parsed));
  return out.join("|");
}` },
  { name: "sorted-by-multiple-keys", fn: "f", ts: `export function f(): any {
  const items: any = [
    { a: 1, b: 2, n: "x" }, { a: 1, b: 1, n: "y" }, { a: 0, b: 9, n: "z" }, { a: 1, b: 1, n: "w" }
  ];
  const sorted: any = items.slice().sort((p: any, q: any) => p.a - q.a || p.b - q.b || (p.n < q.n ? -1 : p.n > q.n ? 1 : 0));
  return sorted.map((i: any) => i.a + "" + i.b + i.n).join(",");
}` },
  { name: "nested-destructuring-functions", fn: "f", ts: `function draw({ x, y, style: { color = "black", width = 1 } = {} }: any, [first, second]: any = []): any {
  return [x, y, color, width, first, second].join(",");
}
export function f(): any {
  const out: any = [];
  out.push(draw({ x: 1, y: 2 }, [3, 4]));
  out.push(draw({ x: 5, y: 6, style: { color: "red" } }));
  out.push(draw({ x: 7, y: 8, style: { width: 3 } }, [9]));
  const pick = ({ a, b: { c } }: any) => a + c;
  out.push(pick({ a: 1, b: { c: 2 } }));
  return out.join("|");
}` },
];
