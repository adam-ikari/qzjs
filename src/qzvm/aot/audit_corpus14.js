// 差分审计语料（第十四批）：this 绑定矩阵 / undefined·null 访问 / 原型与继承 / 别名与共享 / 边界收尾。
module.exports = [
  { name: "this-bind-matrix", fn: "f", ts: `class C { v: any = 5; m(): any { return this.v; } }
export function f(): any {
  const c = new C();
  const out: any = [];
  out.push(c.m());
  out.push(c.m.call(c));
  out.push(c.m.apply(c, []));
  const bound: any = c.m.bind(c);
  out.push(bound());
  const o: any = { v: 7, m(c.m) };
  out.push(o.m());
  out.push(o.m.call({ v: 9 }));
  try { out.push("x:" + (c.m as any).call(null)); } catch (e: any) { out.push("threw:" + (e instanceof TypeError ? "T" : "?")); }
  return out.join("|");
}` },
  { name: "undefined-access-matrix", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const u: any = undefined;
  const n: any = null;
  out.push(u?.a === undefined ? 1 : 0);
  out.push(n?.a === undefined ? 1 : 0);
  try { out.push("u:" + u.a); } catch (e: any) { out.push("u-threw:" + (e instanceof TypeError ? "T" : "?")); }
  try { out.push("n:" + n.a); } catch (e: any) { out.push("n-threw:" + (e instanceof TypeError ? "T" : "?")); }
  try { u.a = 1; out.push("wrote"); } catch (e: any) { out.push("w-threw:" + (e instanceof TypeError ? "T" : "?")); }
  const obj: any = { a: { b: undefined } };
  out.push(obj.a.b === undefined ? 1 : 0, obj.a?.b ?? "d");
  out.push(obj.missing === undefined ? 1 : 0);
  return out.join("|");
}` },
  { name: "class-inherit-super-chain", fn: "f", ts: `class A { n: any = 1; who(): any { return "A" + this.n; } get g(): any { return this.n * 10; } }
class B extends A { n: any = 2; who(): any { return "B" + super.who() + "|" + super.g; } }
class Cc extends B { who(): any { return "C" + super.who(); } }
export function f(): any {
  const c = new Cc();
  const out: any = [];
  out.push(c.who());
  out.push(c.n, c.g);
  out.push(c instanceof Cc ? 1 : 0, c instanceof B ? 1 : 0, c instanceof A ? 1 : 0);
  out.push(Object.keys(c).join(","));
  return out.join("|");
}` },
  { name: "freeze-array-methods", fn: "f", ts: `export function f(): any {
  const a: any = [3, 1, 2];
  const sorted = a.toSorted();
  const rev = a.toReversed();
  const withv = a.with(0, 9);
  const out: any = [];
  out.push(sorted.join(","), rev.join(","), withv.join(","), a.join(","));
  out.push(a.toSpliced(1, 1).join(","), a.length);
  out.push(a.findLast((x: any) => x > 1), a.findLastIndex((x: any) => x < 3));
  out.push(a.some((x: any) => x === 9) ? 1 : 0, a.every((x: any) => x > 0) ? 1 : 0);
  out.push(a.reduceRight((acc: any, x: any) => acc + x, 0));
  return out.join("|");
}` },
  { name: "nested-object-alias-fn", fn: "f", ts: `export function f(): any {
  function mutate(b: any): any { b.items.push(4); b.meta.count++; return b; }
  const state: any = { items: [1, 2, 3], meta: { count: 0 } };
  const r = mutate(state);
  const out: any = [];
  out.push(state.items.join(","), state.meta.count, r === state ? 1 : 0);
  const copy: any = { ...state, items: state.items.slice(), meta: { ...state.meta } };
  mutate(copy);
  out.push(state.items.join(","), state.meta.count, copy.items.join(","), copy.meta.count);
  return out.join("|");
}` },
  { name: "string-concat-snapshot", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let s = "a";
  const snaps: any = [];
  for (let i = 0; i < 3; i++) { s += i; snaps.push(s); }
  out.push(s, snaps.join("|"));
  let t = "";
  const objs: any = [];
  for (let i = 0; i < 2; i++) { t = t + "x" + i; objs.push({ v: t }); }
  out.push(t, objs.map((o: any) => o.v).join(","));
  const arr: any = ["p"];
  arr.push(arr[0] + "q");
  out.push(arr.join(","));
  return out.join("|");
}` },
  { name: "array-methods-on-instances", fn: "f", ts: `class Item { id: any; constructor(i: any) { this.id = i; } label(): any { return "#" + this.id; } }
export function f(): any {
  const items: any = [new Item(1), new Item(2), new Item(3)];
  const out: any = [];
  out.push(items.map((i: any) => i.label()).join(","));
  out.push(items.filter((i: any) => i.id > 1).map((i: any) => i.label()).join(","));
  out.push(items.find((i: any) => i.id === 2).label());
  out.push(items.reduce((acc: any, i: any) => acc + i.id, 0));
  out.push(items.every((i: any) => i instanceof Item) ? 1 : 0);
  out.push(items.indexOf(items[1]));
  out.push(items.slice(1).map((i: any) => i.label()).join(","));
  const sorted = items.slice().sort((a: any, b: any) => b.id - a.id);
  out.push(sorted.map((i: any) => i.label()).join(","));
  return out.join("|");
}` },
  { name: "object-keys-order-mixed", fn: "f", ts: `export function f(): any {
  const o: any = {};
  o.b = 1;
  o["2"] = 2;
  o.a = 3;
  o["1"] = 4;
  const out: any = [];
  out.push(Object.keys(o).join(","));
  out.push(Object.values(o).join(","));
  out.push(JSON.stringify(o));
  const p: any = { 10: "x", 2: "y", z: "w" };
  out.push(Object.keys(p).join(","));
  const q: any = {};
  q.z = 1; delete q.z; q.z = 2;
  out.push(Object.keys(q).join(","));
  return out.join("|");
}` },
  { name: "try-catch-throw-objects", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const custom: any = { code: 42, message: "m" };
  try { throw custom; } catch (e: any) { out.push(e.code, e === custom ? 1 : 0); }
  try { throw [1, 2]; } catch (e: any) { out.push(Array.isArray(e) ? 1 : 0, e.length); }
  function thrower(): any { throw new RangeError("r"); }
  try { thrower(); } catch (e: any) { out.push(e.name, e instanceof RangeError ? 1 : 0, e instanceof Error ? 1 : 0); }
  try { throw new Error("outer"); } catch (e: any) { out.push(e.message); } finally { out.push("fin"); }
  return out.join("|");
}` },
  { name: "closure-loop-capture-mixed", fn: "f", ts: `export function f(): any {
  const fns: any = [];
  for (var i = 0; i < 2; i++) fns.push(() => i);
  const out: any = [];
  out.push(fns.map((g: any) => g()).join(","));
  const fns2: any = [];
  for (let j = 0; j < 2; j++) fns2.push(() => j);
  out.push(fns2.map((g: any) => g()).join(","));
  const fns3: any = [];
  let k = 0;
  while (k < 2) { const m = k * 5; fns3.push(() => m); k++; }
  out.push(fns3.map((g: any) => g()).join(","));
  const fns4: any = [];
  for (const v of [7, 8]) fns4.push(() => v);
  out.push(fns4.map((g: any) => g()).join(","));
  return out.join("|");
}` },
  { name: "destructure-in-params-and-return", fn: "f", ts: `export function f(): any {
  function give(): any { return { a: 1, b: { c: 2, d: [3, 4] } }; }
  const { a, b: { c, d: [x, y] } } = give();
  const out: any = [];
  out.push(a, c, x, y);
  function take({ p, q = 5 }: any, [r, s = 6]: any): any { return p + q + r + s; }
  out.push(take({ p: 1 }, [2]));
  out.push(take({ p: 1, q: 2 }, [3, 4]));
  const arr: any = [[1, 2], [3, 4]];
  const [[e1, e2], [e3]] = arr;
  out.push(e1 + e2 + e3);
  return out.join("|");
}` },
  { name: "getter-setter-prototype-chain", fn: "f", ts: `class A { _v: any = 1; get v(): any { return this._v; } set v(x: any) { this._v = x * 2; } }
class B extends A { }
export function f(): any {
  const b = new B();
  const out: any = [];
  out.push(b.v);
  b.v = 3;
  out.push(b.v, b._v);
  const a = new A();
  a.v = 10;
  out.push(a.v, a._v);
  out.push(Object.keys(b).join(","));
  return out.join("|");
}` },
  { name: "typeof-instanceof-matrix", fn: "f", ts: `class A { }
export function f(): any {
  const out: any = [];
  const vals: any = [1, "s", true, undefined, null, {}, [], function () { }, new A()];
  out.push(vals.map((v: any) => typeof v).join(","));
  out.push([] instanceof Array ? 1 : 0, {} instanceof Object ? 1 : 0);
  const a = new A();
  out.push(a instanceof A ? 1 : 0, a instanceof Object ? 1 : 0);
  out.push(typeof A);
  out.push(Array.isArray([]) ? 1 : 0, Array.isArray({}) ? 1 : 0);
  return out.join("|");
}` },
  { name: "json-round-trip-shapes", fn: "f", ts: `export function f(): any {
  const src: any = { n: 1, s: "t", b: true, nl: null, arr: [1, { x: 2 }], nest: { deep: { v: 3 } } };
  const round: any = JSON.parse(JSON.stringify(src));
  const out: any = [];
  out.push(round.n, round.s, round.b, round.nl === null ? 1 : 0);
  out.push(round.arr[1].x, round.nest.deep.v);
  out.push(Object.keys(round).join(","));
  out.push(JSON.stringify(round) === JSON.stringify(src) ? 1 : 0);
  out.push(Array.isArray(round.arr) ? 1 : 0);
  return out.join("|");
}` },
  { name: "numeric-edge-ops", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(0.1 + 0.2);
  out.push(1 / 3);
  out.push(2 ** 53, 2 ** 53 + 1);
  out.push(-0 === 0 ? 1 : 0, Object.is ? (Object.is(-0, 0) ? 1 : 0) : "na");
  out.push(Math.max() === -Infinity ? 1 : 0, Math.min() === Infinity ? 1 : 0);
  out.push((0.0000001).toString().length > 3 ? 1 : 0);
  out.push(parseInt("0x10"), Number("0x10"), +( "0x10" ));
  out.push((1234.5678).toFixed(2), (1234.5678).toPrecision(6));
  return out.join("|");
}` },
  { name: "array-holes-final", fn: "f", ts: `export function f(): any {
  const a: any = [1, , 3];
  const out: any = [];
  out.push(a.length, a[1] === undefined ? 1 : 0);
  out.push(Object.keys(a).join(","));
  out.push(a.map((x: any) => (x === undefined ? "u" : x)).join(","));
  out.push(a.filter((x: any) => true).length);
  out.push(a.join("-"));
  out.push([...a].length);
  out.push(JSON.stringify(a));
  const b: any = new Array(2);
  out.push(b.length, b.map((x: any) => 1).length, b.join("|"));
  return out.join("|");
}` },
  { name: "iife-and-scoping", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const r = ((): any => { const x = 5; return x * 2; })();
  out.push(r);
  const r2 = (function (a: any, b: any): any { return a + b; })(1, 2);
  out.push(r2);
  let outer = 1;
  { let outer2 = 2; out.push(outer + outer2); }
  {
    let outer = 10;
    out.push(outer);
  }
  out.push(outer);
  return out.join("|");
}` },
];
