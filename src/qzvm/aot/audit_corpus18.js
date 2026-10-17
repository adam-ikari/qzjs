// 差分审计语料（第十八批）：强转优先级 / getter 与 spread / Map·Set 身份 / JSON 与 Date / RegExp 替换 / 类型擦除边界 / 求值顺序。
module.exports = [
  { name: "toPrimitive-order", fn: "f", ts: `class V { v: any; constructor(v: any) { this.v = v; } valueOf(): any { return this.v; } toString(): any { return "S" + this.v; } }
class T { toString(): any { return "T"; } }
export function f(): any {
  const out: any = [];
  const a = new V(5);
  out.push(a + 1, String(a), \`\${a}\`, Number(a));
  out.push(new T() + "", Number(new T()));
  out.push([a] + "", [a, a] + "");
  out.push("" + a, a + "");
  return out.join("|");
}` },
  { name: "spread-getters", fn: "f", ts: `export function f(): any {
  let reads = 0;
  const src: any = { get a(): any { reads++; return 1; }, b: 2 };
  const copy: any = { ...src };
  const out: any = [];
  out.push(reads, copy.a, copy.b, Object.keys(copy).join(","));
  const arr: any = [...[src]];
  out.push(arr.length, arr[0] === src ? 1 : 0);
  return out.join("|");
}` },
  { name: "map-set-identity-deep", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const m: any = new Map();
  m.set(NaN, "nan");
  out.push(m.get(NaN), m.size);
  const s: any = new Set();
  s.add(NaN); s.add(NaN);
  out.push(s.size);
  const o1: any = { k: 1 }, o2: any = { k: 1 };
  const m2: any = new Map([[o1, "a"], [o2, "b"]]);
  out.push(m2.size, m2.get(o1), m2.get(o2));
  const s2: any = new Set([0, -0, 1]);
  out.push(s2.size);
  out.push([...s2].join(","));
  return out.join("|");
}` },
  { name: "json-date-symbol", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const d: any = new Date(0);
  out.push(JSON.stringify(d));
  out.push(JSON.stringify({ d: d, n: 1 }));
  const o: any = { a: 1 };
  o[Symbol("s")] = 2;
  out.push(JSON.stringify(o));
  out.push(JSON.stringify([1, "a", null, true]));
  out.push(JSON.stringify("str"));
  out.push(JSON.stringify(42), JSON.stringify(null), JSON.stringify(true));
  return out.join("|");
}` },
  { name: "regexp-replace-patterns", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("abc".replace(/b/, "[$&]"));
  out.push("abc".replace(/(b)/, "[$1]"));
  out.push("abc".replace(/(b)/, "[$2]"));
  out.push("a-b-c".replace(/-(.)/g, "+$1"));
  out.push("abc".replace(/b/, "$\u0060"));
  out.push("abc".replace(/b/, "$'"));
  out.push("ab".replace(/a/, "$$"));
  out.push("2024-01-02".replace(/(\\d+)-(\\d+)-(\\d+)/, "$3-$2-$1"));
  out.push("x".replace(/x/, (m: any) => "<" + m + ">"));
  return out.join("|");
}` },
  { name: "class-computed-and-static-2", fn: "f", ts: `const KEY: any = "dyn";
class C {
  ["d" + "yn"]: any = 1;
  static ["s" + "t"]: any = 2;
  [KEY + "2"]: any = 3;
  m(): any { return this["dyn"] + this["dyn2"]; }
}
export function f(): any {
  const c = new C();
  const out: any = [];
  out.push(c.dyn, c.dyn2, (C as any).st, c.m());
  out.push(Object.keys(c).join(","));
  return out.join("|");
}` },
  { name: "evaluation-order", fn: "f", ts: `export function f(): any {
  const log: any = [];
  function a(): any { log.push("a"); return 1; }
  function b(): any { log.push("b"); return 2; }
  const out: any = [];
  out.push(a() + b());
  log.length = 0;
  out.push([a(), b()].join(""));
  log.length = 0;
  const o: any = {};
  o[a()] = b();
  out.push(log.join(""));
  log.length = 0;
  out.push({ x: a(), y: b() }.x);
  out.push(log.join(""));
  log.length = 0;
  out.push(Math.max(a(), b()));
  out.push(log.join(""));
  return out.join("|");
}` },
  { name: "type-erasure-edge", fn: "f", ts: `interface I { n: number }
type Alias = string | number;
declare const amd: any;
const asrt = { v: 1 } as I;
export function f(): any {
  const out: any = [];
  out.push(asrt.v);
  const arr: Array<Alias> = [1, "s"];
  out.push(arr.length, arr[0], arr[1]);
  const t: [number, string] = [1, "a"];
  out.push(t[0], t[1]);
  const ro: Readonly<{ x: number }> = { x: 5 };
  out.push(ro.x);
  const part: Partial<I> = {};
  out.push(part.n === undefined ? 1 : 0);
  function generic<T>(x: T): T { return x; }
  out.push(generic<string>("g"), generic(9));
  return out.join("|");
}` },
  { name: "getter-in-destructure-spread", fn: "f", ts: `class Box { _v: any = 1; get v(): any { return this._v; } set v(x: any) { this._v = x; } }
export function f(): any {
  const b = new Box();
  const out: any = [];
  const { v } = b;
  out.push(v);
  const o: any = { ...b };
  out.push(o._v, o.v === undefined ? 1 : 0);
  const keys: any = Object.keys(b);
  out.push(keys.join(","));
  out.push("v" in b ? 1 : 0);
  return out.join("|");
}` },
  { name: "nested-closure-loop-fns", fn: "f", ts: `export function f(): any {
  const out: any = [];
  function makeAll(): any {
    const fns: any = [];
    for (let i = 0; i < 3; i++) {
      const inner = (): any => i * 2;
      fns.push(() => inner() + i);
    }
    return fns;
  }
  out.push(makeAll().map((g: any) => g()).join(","));
  function counter(): any {
    let n = 0;
    return { inc: () => ++n, get value() { return n; } };
  }
  const c = counter();
  c.inc(); c.inc();
  out.push(c.value);
  return out.join("|");
}` },
  { name: "array-from-holes-length", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = Array.from({ length: 3 });
  out.push(a.length, a[0] === undefined ? 1 : 0, a.map((x: any) => 1).length);
  const b: any = Array.from({ length: 3 }, (v: any, i: any) => i);
  out.push(b.join(","));
  const c: any = Array.from("ab", (ch: any) => ch.toUpperCase());
  out.push(c.join(""));
  out.push(Array.of(1, 2, 3).join(","));
  const spread: any = [...Array(2)];
  out.push(spread.length, spread[0] === undefined ? 1 : 0);
  return out.join("|");
}` },
  { name: "string-raw-nested", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const n = 2;
  out.push(String.raw\`a\\nb\`);
  out.push(String.raw\`x\${n}y\`);
  out.push(String.raw\`\\t\${"z"}\\u0041\`);
  out.push(\`a\\nb\`.length, String.raw\`a\\nb\`.length);
  out.push(String.raw\`\\\`\`);
  return out.join("|");
}` },
  { name: "json-reviver-mutate", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const r: any = JSON.parse('{"a":1,"b":{"c":2},"list":[1,2]}', (k: any, v: any) => {
    if (k === "a") return v + 10;
    if (k === "c") return v * 100;
    return v;
  });
  out.push(r.a, r.b.c, r.list.join(","));
  let count = 0;
  JSON.parse('{"x":{"y":1}}', (k: any, v: any) => { count++; return v; });
  out.push(count > 2 ? 1 : 0);
  return out.join("|");
}` },
  { name: "labeled-nested-loops", fn: "f", ts: `export function f(): any {
  const out: any = [];
  outer: for (let i = 0; i < 3; i++) {
    inner: for (let j = 0; j < 3; j++) {
      if (j === 2) continue outer;
      if (i === 2) break outer;
      out.push(i + "" + j);
    }
  }
  let k = 0;
  loop: while (true) { k++; if (k > 2) break loop; }
  out.push("k" + k);
  return out.join(",");
}` },
  { name: "try-catch-destructure", fn: "f", ts: `export function f(): any {
  const out: any = [];
  try { throw { code: 42, msg: "e" }; }
  catch ({ code, msg }: any) { out.push(code, msg); }
  try { throw [1, 2]; }
  catch ([a, b]: any) { out.push(a + b); }
  try { throw new Error("x"); }
  catch (e: any) { const { message } = e; out.push(message); }
  return out.join("|");
}` },
  { name: "numeric-separators-radix", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(1_000_000, 0b1010_1010, 0o777, 0xff_ff);
  out.push(0.1_5, 1e1_0);
  out.push((1_000).toString(2).length);
  out.push(Number("1_000"));
  return out.join("|");
}` },
  { name: "array-destructure-swap-deep", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let a: any = [1, 2], b: any = [3, 4];
  [a, b] = [b, a];
  out.push(a.join(","), b.join(","));
  const [[x, y], [z]] = [[1, 2], [3]];
  out.push(x, y, z);
  const { p: { q } = { q: 0 } } = { p: { q: 9 } } as any;
  out.push(q);
  const [, , third] = [1, 2, 3];
  out.push(third);
  const { length } = [1, 2, 3, 4];
  out.push(length);
  return out.join("|");
}` },
  { name: "super-method-chain", fn: "f", ts: `class A { v(): any { return 1; } }
class B extends A { v(): any { return super.v() + 10; } }
class C extends B { v(): any { return super.v() * 2; } }
export function f(): any {
  const out: any = [];
  out.push(new A().v(), new B().v(), new C().v());
  const c = new C();
  out.push(c.v(), c instanceof A ? 1 : 0);
  return out.join("|");
}` },
  { name: "object-descriptors-bulk", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: 2 };
  out.push(Object.getOwnPropertyNames(o).join(","));
  const ds: any = Object.getOwnPropertyDescriptors ? Object.getOwnPropertyDescriptors(o) : null;
  out.push(ds ? Object.keys(ds).join(",") : "na");
  out.push(ds ? (ds.a.value + ":" + (ds.a.writable ? 1 : 0)) : "na");
  const assigned: any = Object.assign({}, o, { c: 3 });
  out.push(Object.keys(assigned).join(","));
  const entries: any = Object.entries(o);
  out.push(entries.length, entries[0][0], entries[0][1]);
  return out.join("|");
}` },
];
