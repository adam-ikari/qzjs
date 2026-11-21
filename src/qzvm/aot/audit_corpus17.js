// 差分审计语料（第十七批）：数组全方法矩阵 / 字符串全方法矩阵 / 冻结·密封交互 / 错误形态 / WeakMap·WeakSet / 私有字段继承遮蔽 / 日期时区无关量。
module.exports = [
  { name: "array-method-matrix", fn: "f", ts: `export function f(): any {
  const a: any = [1, 2, 3, 4, 5];
  const out: any = [];
  out.push(a.lastIndexOf(3), a.lastIndexOf(9));
  out.push(a.indexOf(2, 2), a.includes(3, 3));
  out.push(a.copyWithin(0, 3).join(","));
  const b: any = [1, 2, 3];
  out.push(b.fill(0, 1).join(","), b.fill(9).join(","));
  out.push([[1, [2]], [3]].flat().join(","), [[1], [2]].flatMap((x: any) => x).join(","));
  out.push(a.slice(-3, -1).join(","), a.slice(2).join(","));
  const c: any = [1, 2, 3];
  out.push(c.splice(1, 1, 9, 9).join(","), c.join(","));
  out.push(a.reduce((s: any, x: any) => s + x, 100));
  out.push(a.filter((x: any) => x % 2 === 1).join(","));
  out.push(a.map((x: any, i: any) => x * i).join(","));
  return out.join("|");
}` },
  { name: "string-method-matrix", fn: "f", ts: `export function f(): any {
  const s = "Hello, World";
  const out: any = [];
  out.push(s.length, s.charAt(1), s.charCodeAt(0), s.at(-1), s.at(0));
  out.push(s.indexOf("o"), s.lastIndexOf("o"), s.indexOf("z"));
  out.push(s.slice(0, 5), s.slice(-5), s.substring(7), s.substr(7, 5));
  out.push(s.toUpperCase(), s.toLowerCase());
  out.push(s.split(", ").join("|"), s.split("").length);
  out.push(s.replace("World", "TS"), s.replaceAll("l", "L"));
  out.push(s.startsWith("Hello"), s.endsWith("World"), s.includes("lo, W"));
  out.push(s.padStart(15, "*"), s.padEnd(15, "*"));
  out.push(s.trim(), "  x  ".trimStart(), "  x  ".trimEnd());
  out.push(s.repeat(2).length);
  out.push(s.concat("!", "?"), s.localeCompare("Hello, World"));
  return out.join("|");
}` },
  { name: "seal-freeze-descriptor-interaction", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: 2 };
  Object.seal(o);
  out.push(Object.isSealed(o) ? 1 : 0, Object.isFrozen(o) ? 1 : 0);
  o.a = 10;
  out.push(o.a);
  const d: any = Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(o, "a") : null;
  out.push(d ? (d.configurable ? 1 : 0) : "na");
  const p: any = { x: 1 };
  Object.freeze(p);
  out.push(Object.isFrozen(p) ? 1 : 0, Object.isSealed(p) ? 1 : 0);
  const d2: any = Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(p, "x") : null;
  out.push(d2 ? [(d2.writable ? 1 : 0), (d2.configurable ? 1 : 0)].join(",") : "na");
  return out.join("|");
}` },
  { name: "error-shapes", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const e: any = new Error("msg");
  out.push(e.message, e.name, typeof e.stack, String(e));
  const t: any = new TypeError("t");
  out.push(t.name, t.message, t instanceof Error ? 1 : 0);
  try { null.x; } catch (er: any) { out.push(er.name, er instanceof TypeError ? 1 : 0); }
  try { (undefined as any).foo; } catch (er: any) { out.push(er instanceof TypeError ? 1 : 0); }
  try { ({} as any).missing.deep; } catch (er: any) { out.push(er instanceof TypeError ? 1 : 0); }
  return out.join("|");
}` },
  { name: "weakmap-weakset-deep", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const wm: any = new WeakMap();
  const k1: any = {}, k2: any = {};
  wm.set(k1, [1, 2]);
  out.push(wm.get(k1).length, wm.has(k2) ? 1 : 0);
  wm.delete(k1);
  out.push(wm.has(k1) ? 1 : 0);
  const ws: any = new WeakSet();
  ws.add(k1); ws.add(k2);
  out.push(ws.has(k1) ? 1 : 0, ws.has(k2) ? 1 : 0);
  ws.delete(k2);
  out.push(ws.has(k2) ? 1 : 0);
  out.push(String(wm), String(ws));
  return out.join("|");
}` },
  { name: "private-shadow-inherit", fn: "f", ts: `class A { #v: any = 1; getV(): any { return this.#v; } setV(x: any): any { this.#v = x; return this; } }
class B extends A { #v: any = 2; getV2(): any { return this.#v; } }
export function f(): any {
  const b = new B();
  const out: any = [];
  out.push(b.getV(), b.getV2());
  b.setV(10);
  out.push(b.getV(), b.getV2());
  const a = new A();
  out.push(a.getV(), a.setV(5).getV());
  return out.join("|");
}` },
  { name: "date-tz-independent", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const d: any = new Date(1700000000000);
  out.push(d.getTime(), d.valueOf());
  out.push(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  out.push(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  out.push(d.getUTCDay());
  out.push(d.toISOString());
  out.push(Date.UTC(2024, 0, 15, 12), Date.UTC(2024, 5, 1));   // 内建 ABI 4 槽：>4 实参为 loud（见 ASSESSMENT）
  out.push(new Date(Date.UTC(2024, 0, 15)).toISOString());
  return out.join("|");
}` },
  { name: "array-numeric-strings", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [];
  a["0"] = "x";
  a[1] = "y";
  out.push(a.length, a[0], a[1]);
  const o: any = {};
  o["0"] = "x";
  out.push(o[0], Object.keys(o).join(","));
  out.push([1, 2][0], [1, 2]["0"]);
  out.push([1, 2]["length"], [1, 2].length);
  const arr: any = [1, 2, 3];
  out.push(arr["length"], arr["0"], arr["10"] === undefined ? 1 : 0);
  return out.join("|");
}` },
  { name: "arrow-this-lexical", fn: "f", ts: `class C {
  v: any = 7;
  m(): any { const f = (): any => this.v; return f(); }
  make(): any { return (): any => this.v * 2; }
}
export function f(): any {
  const c = new C();
  const out: any = [];
  out.push(c.m());
  const g = c.make();
  out.push(g());
  const obj: any = {
    v: 100,
    run(): any { return [1].map(() => this.v)[0]; },
    inner(): any { return { v: 200, run: () => this.v }; }
  };
  out.push(obj.run(), obj.inner().run());
  return out.join("|");
}` },
  { name: "switch-complex-flow", fn: "f", ts: `export function f(x: any): any {
  const out: any = [];
  switch (x) {
    case 1:
    case 2:
      out.push("a");
      break;
    case 3:
      out.push("b");
      if (x > 0) break;
      out.push("c");
      break;
    default:
      out.push("d");
  }
  switch (x * 10) {
    case 10: out.push("ten");
    case 20: out.push("twenty"); break;
  }
  return out.join(",");
}`, args: [1] },
  { name: "array-of-objects-mutate", fn: "f", ts: `class Row { id: any; n: any; constructor(i: any) { this.id = i; this.n = 0; } inc(): any { this.n++; return this; } }
export function f(): any {
  const rows: any = [new Row(1), new Row(2)];
  const out: any = [];
  rows.forEach((r: any) => r.inc());
  out.push(rows.map((r: any) => r.n).join(","));
  const found: any = rows.find((r: any) => r.id === 2);
  found.inc();
  out.push(rows[1].n, found === rows[1] ? 1 : 0);
  const sorted: any = rows.slice().sort((a: any, b: any) => b.id - a.id);
  out.push(sorted.map((r: any) => r.id).join(","));
  out.push(rows.indexOf(rows[0]));
  const removed: any = rows.splice(0, 1);
  out.push(removed[0].id, rows.length, removed[0] === sorted[1] || removed[0] === sorted[0] ? 1 : 0);
  return out.join("|");
}` },
  { name: "number-edge-values", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Number.POSITIVE_INFINITY > 1e308, Number.NEGATIVE_INFINITY < -1e308);
  out.push(1 / 0, -1 / 0, 0 / 0);
  out.push(Math.round(2.5), Math.round(-2.5), Math.round(3.5));
  out.push(Math.trunc(-2.5), Math.floor(-2.5), Math.ceil(-2.5));
  out.push(Math.sign(-0), Math.abs(-3), Math.abs(-0));
  out.push(Math.min(1, 0), Math.max(1, 0));
  out.push(Number.isFinite(1 / 0), Number.isNaN(0 / 0));
  out.push(Math.pow(2, 10), 2 ** 10, (-2) ** 3);
  out.push(Math.sqrt(-1));
  out.push(parseFloat("1e3"), parseInt("100", 2), parseFloat(".5e1"));
  return out.join("|");
}` },
  { name: "object-key-order-frozen", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = {};
  o.z = 1; o.a = 2; o.m = 3;
  out.push(Object.keys(o).join(","));
  Object.freeze(o);
  out.push(Object.keys(o).join(","));
  const p: any = { b: 1 };
  Object.defineProperty(p, "a", { value: 2, enumerable: true, writable: true, configurable: true });
  out.push(Object.keys(p).join(","));
  out.push(JSON.stringify(p));
  return out.join("|");
}` },
  { name: "destructure-swap-defaults", fn: "f", ts: `export function f(): any {
  let a = 1, b = 2;
  [a, b] = [b, a];
  const out: any = [];
  out.push(a, b);
  const o: any = { x: 1, y: 2 };
  ({ x: a, y: b } = { x: 10, y: 20 });
  out.push(a, b);
  const arr: any = [1];
  const [p = 5, q = p * 2] = arr;
  out.push(p, q);
  const { m = 1, n = m + 1 } = { m: 10 } as any;
  out.push(m, n);
  return out.join("|");
}` },
  { name: "callback-this-binding", fn: "f", ts: `class Handler { tag: any = "h"; run(cb: any): any { return cb(); } runWith(cb: any): any { return cb.call(this); } }
export function f(): any {
  const h = new Handler();
  const out: any = [];
  const arrow = (): any => h.tag;
  out.push(h.run(arrow));
  const obj: any = { tag: "o", get(): any { return this.tag; } };
  out.push(obj.get());
  out.push(h.runWith(obj.get));
  out.push(h.runWith(function (this: any) { return this.tag; }));
  return out.join("|");
}` },
  { name: "array-sort-numeric-strings", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push([3, 20, 100].sort().join(","));
  out.push([3, 20, 100].sort((a: any, b: any) => a - b).join(","));
  out.push(["3", "20", "100"].sort().join(","));
  out.push([true, false].sort().join(","));
  out.push([undefined, 1, null, 2].sort().join(","));
  const objs: any = [{ n: 3 }, { n: 1 }, { n: 2 }];
  out.push(objs.slice().sort((a: any, b: any) => a.n - b.n).map((o: any) => o.n).join(","));
  return out.join("|");
}` },
  { name: "map-object-keys-deep", fn: "f", ts: `export function f(): any {
  const m: any = new Map();
  const k1: any = { id: 1 }, k2: any = { id: 2 };
  m.set(k1, "a").set(k2, "b");
  const out: any = [];
  out.push(m.size, m.get(k1), m.get(k2));
  out.push(m.has(k1) ? 1 : 0, m.has({ id: 1 }) ? 1 : 0);
  const keys: any = [...m.keys()];
  out.push(keys.length, keys[0] === k1 ? 1 : 0);
  m.clear();
  out.push(m.size);
  const s: any = new Set([k1, k2]);
  out.push(s.has(k1) ? 1 : 0, s.size);
  return out.join("|");
}` },
  { name: "string-char-iteration", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s = "a𝌆b";
  out.push(s.length, [...s].length);
  out.push([...s].join("|"));
  out.push(s.charAt(1).length, s.charCodeAt(1));
  out.push(s.codePointAt(1));
  out.push(Array.from(s).length);
  let count = 0;
  for (const ch of s) count++;
  out.push(count);
  out.push(s.split("").length);
  return out.join("|");
}` },
];
