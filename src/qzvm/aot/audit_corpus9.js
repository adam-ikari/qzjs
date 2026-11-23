// 差分审计语料（第九批）：ES2023/2024 新 API / super / ToPrimitive 强制转换 / delete·in / 迭代器·Map·Set / 类深水。
module.exports = [
  // ---------- ES2023 数组新 API ----------
  { name: "arr-tosorted-toreversed-with", fn: "f", ts: `export function f(): any {
  const a: any = [3, 1, 2];
  const out: any = [];
  out.push(a.toSorted ? a.toSorted().join(",") : "na");
  out.push(a.toReversed ? a.toReversed().join(",") : "na");
  out.push(a.with ? a.with(1, 9).join(",") : "na");
  out.push(a.toSpliced ? a.toSpliced(0, 1).join(",") : "na");
  out.push(a.findLast((x: any) => x > 1));
  out.push(a.findLastIndex((x: any) => x > 1));
  out.push(a.join(","));                      // 原数组不变
  return out.join("|");
}` },
  // ---------- ES2024 Object.groupBy / Map.groupBy ----------
  { name: "groupby", fn: "f", ts: `export function f(): any {
  const a: any = [1, 2, 3, 4, 5];
  const out: any = [];
  if (Object.groupBy) {
    const g: any = Object.groupBy(a, (x: any) => (x % 2 ? "odd" : "even"));
    out.push(Object.keys(g).join(","));
    out.push(g.odd.join(","), g.even.join(","));
  } else out.push("na");
  if (Map.groupBy) {
    const m: any = Map.groupBy(a, (x: any) => (x < 3 ? "lo" : "hi"));
    out.push(m.get("lo").join(","), m.get("hi").join(","));
  } else out.push("na");
  return out.join("|");
}` },
  // ---------- Object.hasOwn / 迭代器辅助 ----------
  { name: "obj-hasown", fn: "f", ts: `export function f(): any {
  const o: any = { a: 1 };
  const out: any = [];
  out.push(Object.hasOwn(o, "a") ? 1 : 0);
  out.push(Object.hasOwn(o, "b") ? 1 : 0);
  const a: any = [1, 2];
  out.push(Object.hasOwn(a, 0) ? 1 : 0);
  out.push(Object.hasOwn(a, "length") ? 1 : 0);
  out.push(typeof o.hasOwnProperty);
  out.push(o.hasOwnProperty("a") ? 1 : 0);
  return out.join("|");
}` },
  // ---------- 类深水：继承 + super 属性 + 静态继承 ----------
  { name: "class-super-prop", fn: "f", ts: `class A { x: any = 1; get y(): any { return 10; } set y(v: any) { this.x = v; } m(): any { return "A"; } }
class B extends A { x: any = 2; get z(): any { return this.x + super.y; } m(): any { return "B" + super.m(); } }
export function f(): any {
  const b = new B();
  const out: any = [];
  out.push(b.z);
  b.y = 5;
  out.push(b.x);
  out.push(b.m());
  out.push(b instanceof A ? 1 : 0);
  return out.join("|");
}` },
  { name: "class-static-inherit", fn: "f", ts: `class A { static v: any = 1; static s(): any { return "A"; } }
class B extends A { static v2: any = 2; }
export function f(): any {
  const out: any = [];
  out.push(B.v);
  out.push(B.s());
  out.push(B.v2);
  B.v = 9;
  out.push(B.v, A.v);
  return out.join("|");
}` },
  // ---------- ToPrimitive 强制转换 ----------
  { name: "toprimitive-tostring-valueof", fn: "f", ts: `class Money { n: any; constructor(n: any) { this.n = n; } toString(): any { return "$" + this.n; } valueOf(): any { return this.n; } }
class OnlyStr { toString(): any { return "S"; } }
export function f(): any {
  const m = new Money(5);
  const out: any = [];
  out.push("v=" + m);
  out.push(m + 1);
  out.push(m * 2);
  out.push(Number(m));
  out.push(String(m));
  out.push(\`\${m}\`);
  out.push(new OnlyStr() + "");
  out.push(typeof (m + ""));
  return out.join("|");
}` },
  { name: "symbol-toprimitive", fn: "f", ts: `class T { v: any; constructor(v: any) { this.v = v; }
  [Symbol.toPrimitive](hint: any): any { return hint === "number" ? 42 : "H" + hint; } }
export function f(): any {
  const t = new T(1);
  const out: any = [];
  out.push(t + 0);
  out.push(\`\${t}\`);
  out.push(t == "Hdefault" ? 1 : 0);
  out.push(Number(t));
  return out.join("|");
}` },
  // ---------- delete / in ----------
  { name: "delete-in-props", fn: "f", ts: `class C { a: any = 1; b: any = 2; }
export function f(): any {
  const o: any = { x: 1, y: 2 };
  const out: any = [];
  out.push(delete o.x ? 1 : 0);
  out.push(Object.keys(o).join(","));
  out.push(o.x === undefined ? 1 : 0);
  const c = new C();
  out.push("a" in c ? 1 : 0);
  out.push(delete (c as any).a ? 1 : 0);
  out.push(c.a === undefined ? 1 : 0);
  const a: any = [1, 2, 3];
  out.push(delete a[1] ? 1 : 0);
  out.push(a.length);
  out.push(a[1] === undefined ? 1 : 0);
  return out.join("|");
}` },
  // ---------- 迭代器 / Map / Set ----------
  { name: "map-set-iteration", fn: "f", ts: `export function f(): any {
  const m: any = new Map([["a", 1], ["b", 2]]);
  const out: any = [];
  const ks: any = [];
  for (const [k, v] of m) ks.push(k + v);
  out.push(ks.join(","));
  out.push([...m.keys()].join(","));
  out.push([...m.values()].join(","));
  out.push([...m.entries()].map((e: any) => e.join(":")).join(","));
  out.push(m.size);
  m.delete("a");
  out.push(m.size, m.has("a") ? 1 : 0);
  const s: any = new Set([1, 2, 2, 3]);
  out.push([...s].join(","), s.size);
  s.delete(1);
  out.push([...s].join(","));
  return out.join("|");
}` },
  { name: "array-from-mapfn", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Array.from([1, 2, 3], (x: any) => x * 2).join(","));
  out.push(Array.from("abc").join("-"));
  out.push(Array.from({ length: 3 }, (v: any, i: any) => i).join(","));
  out.push(Array.from(new Set([1, 1, 2])).join(","));
  out.push(Array.from(new Map([["a", 1]])).length);
  out.push(Array.of(1, 2, 3).join(","));
  out.push([...Array(3).keys()].join(","));
  return out.join("|");
}` },
  { name: "spread-in-call-map", fn: "f", ts: `export function f(): any {
  const a: any = [1, 2, 3];
  const out: any = [];
  out.push(Math.max(...a));
  out.push(Math.min(...a));
  out.push(Math.max(...a, 10));
  out.push([0, ...a, 4].join(","));
  out.push([...a, ...a].length);
  common(...a);
  function common(x: any, y: any, z: any): any { out.push("c:" + (x + y + z)); }
  out.push(Math.hypot(...[3, 4]));
  return out.join("|");
}` },
  // ---------- 字符串新 API ----------
  { name: "str-replaceall-at-raw", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("a-b-c".replaceAll("-", "+"));
  out.push("aaa".replaceAll("a", "b"));
  out.push("a1b2".replaceAll(/\\d/g, "#"));
  out.push("abc".match(/b/)[0]);
  out.push("abc".match(/z/) === null ? 1 : 0);
  out.push("a1b2c3".match(/\\d/g).join(","));
  out.push("abc".search(/b/));
  out.push("abc".search(/z/));
  return out.join("|");
}` },
  { name: "str-normalize-case", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("ß".toUpperCase());
  out.push("İ".toLowerCase().length);
  out.push("abc".toLocaleUpperCase());
  out.push("a,b".split(",").length);
  out.push("\\u00e9".normalize("NFD").length);
  out.push("  x  ".trim().length);
  out.push("A".localeCompare("B"));
  out.push("B".localeCompare("A"));
  return out.join("|");
}` },
  // ---------- 数字 / 解析 ----------
  { name: "num-big-ints-boundary", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Number.MAX_SAFE_INTEGER);
  out.push(Number.MAX_SAFE_INTEGER + 1);
  out.push(Number.isSafeInteger(Number.MAX_SAFE_INTEGER));
  out.push(Number.isSafeInteger(Number.MAX_SAFE_INTEGER + 1));
  out.push(Number.MIN_VALUE > 0 ? 1 : 0);
  out.push(Number.MAX_VALUE * 2);
  out.push(-Number.MAX_VALUE * 2);
  out.push(Number.isInteger(5.0), Number.isInteger(5.5));
  out.push((2 ** 53) === (2 ** 53 + 1) ? 1 : 0);
  return out.join("|");
}` },
  { name: "bitwise-32", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(2147483647 + 1 | 0);
  out.push(-2147483648 - 1 | 0);
  out.push(3000000000 | 0);
  out.push(3000000000 >>> 0);
  out.push(-1 >>> 0);
  out.push(1 << 31);
  out.push(1 << 32);
  out.push(~0, ~5);
  out.push(5 & 3, 5 | 3, 5 ^ 3);
  out.push(1.9 | 0, -1.9 | 0);
  out.push(NaN | 0, Infinity | 0, -Infinity | 0);
  out.push("12" | 0);
  return out.join("|");
}` },
  // ---------- 闭包 / 作用域深水 ----------
  { name: "closure-loop-let-nested", fn: "f", ts: `export function f(): any {
  const fns: any = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) fns.push(() => i + "" + j);
  }
  return fns.map((g: any) => g()).join(",");
}` },
  { name: "closure-while-let", fn: "f", ts: `export function f(): any {
  const fns: any = [];
  let n = 0;
  while (n < 3) { const m = n; fns.push(() => m * 10); n++; }
  return fns.map((g: any) => g()).join(",");
}` },
  { name: "closure-forof-let", fn: "f", ts: `export function f(): any {
  const fns: any = [];
  for (const v of [1, 2, 3]) fns.push(() => v * 2);
  return fns.map((g: any) => g()).join(",");
}` },
  { name: "func-in-object-methods", fn: "f", ts: `export function f(): any {
  const obj: any = {
    n: 5,
    inc(): any { this.n++; return this; },
    get double(): any { return this.n * 2; },
    set double2(v: any) { this.n = v; },
    sum(a: any, b: any): any { return this.n + a + b; }
  };
  const out: any = [];
  out.push(obj.inc().inc().n);
  out.push(obj.double);
  obj.double2 = 100;
  out.push(obj.n);
  out.push(obj.sum(1, 2));
  return out.join("|");
}` },
  { name: "this-in-nested-fn", fn: "f", ts: `class C { v: any = 7; m(): any { const f = () => this.v; return f(); } n(): any { const self = this; return (function () { return self.v * 2; })(); } }
export function f(): any {
  const c = new C();
  return c.m() + "|" + c.n();
}` },
  // ---------- try/catch/finally 与返回值 ----------
  { name: "finally-overrides-return", fn: "f", ts: `export function f(): any {
  function a(): any { try { return 1; } finally { return 2; } }
  function b(): any { try { return 1; } catch (e: any) { return 2; } finally { } }
  function c(): any { let x = 0; try { throw new Error("e"); } catch (e: any) { x = 1; } finally { x += 10; } return x; }
  function d(): any { try { return "t"; } finally { } }
  function e2(): any { for (let i = 0; i < 3; i++) { try { if (i === 1) continue; if (i === 2) break; } finally { } } return "done"; }
  return [a(), b(), c(), d(), e2()].join("|");
}` },
  { name: "error-props-message", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const e = new Error("m");
  out.push(e.message, e.name, typeof e.stack);
  const t = new TypeError("t");
  out.push(t.message, t.name);
  out.push(t instanceof Error ? 1 : 0);
  out.push(e instanceof TypeError ? 1 : 0);
  const r = new RangeError("r");
  out.push(r.name);
  return out.join("|");
}` },
  // ---------- 泛型/类型擦除边界（语义上应与 JS 一致） ----------
  { name: "ts-erased-generics", fn: "f", ts: `export function f(): any {
  function id<T>(x: T): T { return x; }
  const out: any = [];
  out.push(id(1), id("s"));
  const arr: Array<number> = [1, 2, 3];
  out.push(arr.map(x => x * 2).join(","));
  function pair<A, B>(a: A, b: B): any { return [a, b]; }
  out.push(pair(1, "x").join(":"));
  interface P { n: number }
  const p: P = { n: 5 };
  out.push(p.n);
  type U = string | number;
  const u: U = 3;
  out.push(typeof u);
  out.push((arr as any).length);
  const t2: [number, string] = [1, "a"];
  out.push(t2[0], t2[1]);
  return out.join("|");
}` },
  { name: "enum-const", fn: "f", ts: `enum Color { Red, Green = 5, Blue }
export function f(): any {
  const out: any = [];
  out.push(Color.Red, Color.Green, Color.Blue);
  out.push(Color[0], Color[5]);
  return out.join("|");
}` },
  { name: "str-raw-tag", fn: "f", ts: `export function f(): any {
  return String.raw\`a\\nb\${1}\`;
}` },
];
