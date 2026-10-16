// 差分审计语料（第十三批）：别名/共享/原型链/this 绑定/键序（整数键）/shallow 语义/提取方法。
module.exports = [
  { name: "alias-object-shared", fn: "f", ts: `export function f(): any {
  const a: any = { x: 1, inner: { v: 1 } };
  const b: any = a;
  b.x = 2;
  b.inner.v = 9;
  const out: any = [];
  out.push(a.x, a.inner.v);
  out.push(a === b ? 1 : 0);
  const c: any = { ...a };
  c.x = 5;
  c.inner.v = 99;
  out.push(a.x, a.inner.v, c.x);
  out.push(a.inner === c.inner ? 1 : 0);
  return out.join("|");
}` },
  { name: "alias-array-shared", fn: "f", ts: `export function f(): any {
  const a: any = [1, 2];
  const b: any = a;
  b.push(3);
  const c: any = [...a];
  c.push(4);
  const out: any = [];
  out.push(a.length, b.length, c.length);
  out.push(a === b ? 1 : 0, a === c ? 1 : 0);
  const d: any = a.slice();
  d[0] = 9;
  out.push(a[0], d[0]);
  return out.join("|");
}` },
  { name: "object-assign-shallow", fn: "f", ts: `export function f(): any {
  const src: any = { n: { k: 1 }, s: "x" };
  const tgt: any = Object.assign({}, src);
  tgt.n.k = 42;
  tgt.s = "y";
  const out: any = [];
  out.push(src.n.k, src.s, tgt.n.k, tgt.s);
  out.push(src.n === tgt.n ? 1 : 0);
  return out.join("|");
}` },
  { name: "proto-chain-methods", fn: "f", ts: `export function f(): any {
  const base: any = { greet(): any { return "hi-" + this.name; }, name: "b" };
  const child: any = Object.create(base);
  child.name = "c";
  child.own = 1;
  const out: any = [];
  out.push(child.greet());
  out.push(Object.keys(child).join(","));
  out.push("greet" in child ? 1 : 0);
  out.push(child.hasOwnProperty("greet") ? 1 : 0);
  out.push(base.isPrototypeOf(child) ? 1 : 0);
  delete child.name;
  out.push(child.name);
  return out.join("|");
}` },
  { name: "intlike-key-order", fn: "f", ts: `export function f(): any {
  const o: any = {};
  o.z = 1;
  o[2] = "two";
  o.a = 2;
  o[1] = "one";
  o[10] = "ten";
  const out: any = [];
  out.push(Object.keys(o).join(","));
  out.push(JSON.stringify(o));
  const p: any = { 2: "b", 1: "a", x: "c" };
  out.push(Object.keys(p).join(","));
  out.push(Object.values(p).join(","));
  return out.join("|");
}` },
  { name: "extracted-method-this", fn: "f", ts: `class C { v: any = 7; m(): any { return this.v; } }
export function f(): any {
  const c = new C();
  const out: any = [];
  out.push(c.m());
  const obj: any = { v: 3, m(): any { return this.v; } };
  out.push(obj.m());
  const loose: any = obj.m;
  try { out.push("loose:" + loose()); } catch (e: any) { out.push("threw"); }
  return out.join("|");
}` },
  { name: "super-in-arrow", fn: "f", ts: `class A { m(): any { return "A"; } get g(): any { return "GA"; } }
class B extends A {
  m(): any { return "B" + super.m(); }
  arrow(): any { const f = () => "a" + super.m(); return f(); }
  arrowG(): any { const f = () => super.g; return f(); }
}
export function f(): any {
  const b = new B();
  return [b.m(), b.arrow(), b.arrowG()].join("|");
}` },
  { name: "class-field-this-init", fn: "f", ts: `class C {
  base: any = 10;
  derived: any = this.base * 2;
  arr: any = [this.base, this.derived];
  obj: any = { b: this.base };
  m(): any { return this.derived + this.arr[1] + this.obj.b; }
}
export function f(): any {
  const c = new C();
  const out: any = [];
  out.push(c.derived, c.arr.join(","), c.obj.b);
  out.push(c.m());
  return out.join("|");
}` },
  { name: "getter-via-prototype-keys", fn: "f", ts: `class C { _v: any = 1; get v(): any { return this._v * 2; } set v(x: any) { this._v = x; } m(): any { return 1; } }
export function f(): any {
  const c = new C();
  const out: any = [];
  out.push(c.v);
  c.v = 5;
  out.push(c.v, c._v);
  out.push(Object.keys(c).join(","));
  const { v } = c;
  out.push(v);
  out.push("v" in c ? 1 : 0, c.hasOwnProperty("v") ? 1 : 0);
  return out.join("|");
}` },
  { name: "nested-mutation-through-fn", fn: "f", ts: `export function f(): any {
  interface Box { inner: { n: number } }
  function bump(b: any): any { b.inner.n++; b.newKey = 1; return b; }
  const box: any = { inner: { n: 1 } };
  const r = bump(box);
  const out: any = [];
  out.push(box.inner.n, r === box ? 1 : 0, box.newKey);
  function replace(b: any): any { b = { inner: { n: 100 } }; return b; }
  replace(box);
  out.push(box.inner.n);
  return out.join("|");
}` },
  { name: "closure-captures-this-method", fn: "f", ts: `class Counter {
  n: any = 0;
  inc(): any { this.n++; return this; }
  makeAdder(): any { return (k: any) => this.n + k; }
  delayed(): any { const self = this; return function (this: any, k: any) { return self.n * k; }; }
}
export function f(): any {
  const c = new Counter();
  const out: any = [];
  c.inc().inc();
  out.push(c.n);
  const add = c.makeAdder();
  out.push(add(5));
  c.inc();
  out.push(add(5));
  const d = c.delayed();
  out.push(d(2));
  return out.join("|");
}` },
  { name: "map-set-insertion-order", fn: "f", ts: `export function f(): any {
  const m: any = new Map();
  m.set("b", 2); m.set("a", 1); m.set("c", 3);
  m.delete("b"); m.set("b", 9);
  const out: any = [];
  out.push([...m.keys()].join(","));
  out.push([...m.values()].join(","));
  const s: any = new Set();
  s.add(3); s.add(1); s.add(3); s.add(2);
  out.push([...s].join(","));
  out.push(s.size);
  return out.join("|");
}` },
  { name: "destructure-defaults-ref", fn: "f", ts: `export function f(): any {
  const o: any = { a: 5 };
  const { a, b = a * 2, c = b + 1 } = o;
  const out: any = [];
  out.push(a, b, c);
  const arr: any = [1];
  const [x, y = x + 10, z = y + 1] = arr;
  out.push(x, y, z);
  function g({ p = 1, q = p + 1 } = {} as any): any { return p + q; }
  out.push(g(), g({ p: 10 }));
  return out.join("|");
}` },
  { name: "finally-return-override", fn: "f", ts: `export function f(): any {
  function a(): any { try { return 1; } finally { return 2; } }
  function b(): any { let x = 0; try { throw new Error("e"); } catch (e: any) { x = 1; return x; } finally { x = 99; } }
  function c(): any { for (let i = 0; i < 3; i++) { try { if (i === 1) return i; } finally { i += 10; } } return -1; }
  const out: any = [];
  out.push(a(), b(), c());
  return out.join("|");
}` },
  { name: "json-undefined-holes", fn: "f", ts: `export function f(): any {
  const arr: any = [1, undefined, 2];
  const o: any = { a: undefined, b: 1, c: null };
  const out: any = [];
  out.push(JSON.stringify(arr));
  out.push(JSON.stringify(o));
  out.push(JSON.stringify([undefined, undefined]));
  const nested: any = { x: [undefined, { y: undefined }] };
  out.push(JSON.stringify(nested));
  out.push(JSON.parse(JSON.stringify(o)) !== null ? 1 : 0);
  return out.join("|");
}` },
  { name: "sort-stability-objects", fn: "f", ts: `export function f(): any {
  const items: any = [];
  for (let i = 0; i < 6; i++) items.push({ k: i % 3, i });
  items.sort((a: any, b: any) => a.k - b.k);
  const out: any = [];
  out.push(items.map((x: any) => x.i).join(","));
  const nums: any = [10, 9, 1, 2];
  out.push(nums.slice().sort().join(","));
  out.push(nums.slice().sort((a: any, b: any) => a - b).join(","));
  out.push([3, 1, 2].sort((a: any, b: any) => a - b).reverse().join(","));
  return out.join("|");
}` },
  { name: "nested-closures-scope", fn: "f", ts: `export function f(): any {
  const out: any = [];
  for (let i = 0; i < 2; i++) {
    const fn = (): any => {
      let acc = 0;
      for (let j = 0; j < 2; j++) {
        const inner = (): any => i * 10 + j;
        acc += inner();
      }
      return acc;
    };
    out.push(fn());
  }
  return out.join("|");
}` },
  { name: "array-iterators-snapshot", fn: "f", ts: `export function f(): any {
  const a: any = [1, 2, 3];
  const it = a.values();
  const out: any = [];
  out.push(it.next().value);
  a.push(4);
  out.push(it.next().value);
  out.push([...a].join(","));
  out.push([...it].join(","));
  return out.join("|");
}` },
  { name: "string-immutability", fn: "f", ts: `export function f(): any {
  let s = "abc";
  const t = s;
  s += "d";
  const out: any = [];
  out.push(s, t);
  const arr: any = ["a", "b"];
  const joined = arr.join("");
  arr.push("c");
  out.push(joined, arr.join(""));
  let r = "";
  const parts: any = [];
  for (let i = 0; i < 3; i++) { r += i; parts.push(r); }
  out.push(r, parts.join("|"));
  return out.join("|");
}` },
  { name: "enum-plus-class-mix", fn: "f", ts: `enum Kind { A = "a", B = "b" }
class Item { kind: any; constructor(k: any) { this.kind = k; } label(): any { return "item:" + this.kind; } }
export function f(): any {
  const out: any = [];
  const items: any = [new Item(Kind.A), new Item(Kind.B)];
  out.push(items.map((i: any) => i.label()).join(","));
  out.push(items.filter((i: any) => i.kind === Kind.A).length);
  out.push(Kind.A, Kind.B);
  const m: any = new Map();
  m.set(Kind.A, 1);
  m.set(Kind.B, 2);
  out.push(m.get(Kind.A), m.size);
  return out.join("|");
}` },
];
