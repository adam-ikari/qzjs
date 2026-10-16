// 差分审计语料（第七批）：迭代协议 / 语言边界 / 描述符 / 数字字符串深水区 / 控制流收尾。
module.exports = [
  // ---------- 迭代协议 ----------
  { name: "iter-custom-symbol", fn: "f", ts: `export function f(): any {
  const obj: any = {
    from: 1, to: 3,
    [Symbol.iterator]() {
      let cur = this.from, last = this.to;
      return { next() { return cur <= last ? { value: cur++, done: false } : { value: undefined, done: true }; } };
    }
  };
  const out: any = [];
  for (const v of obj) out.push(v);
  out.push([...obj].join(","));
  return out.join("|");
}` },
  { name: "iter-array-entries", fn: "f", ts: `export function f(): any {
  const a = ["x", "y"];
  const out: any = [];
  for (const [i, v] of a.entries()) out.push(i + ":" + v);
  for (const i of a.keys()) out.push("k" + i);
  a.values ? 0 : 0;
  out.push([...a.values()].join(""));
  out.push([...a.keys()].length);
  return out.join("|");
}` },
  { name: "iter-string-spread", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push([..."abc"].length);
  out.push([..."a😀b"].length);
  out.push([..."abc"].join("-"));
  out.push(Array.from("a😀").length);
  out.push(Math.max(...[1, 5, 3]));
  out.push([...[1, 2], ...[3]].join(","));
  return out.join("|");
}` },
  { name: "iter-destructure-array-args", fn: "f", ts: `export function f(): any {
  function g([a, b]: any, { c }: any) { return a + b + c; }
  return g([1, 2], { c: 3 });
}` },
  { name: "generator-function", fn: "f", ts: `export function f(): any {
  function* gen() { yield 1; yield 2; }
  const out: any = [];
  for (const v of gen()) out.push(v);
  return out.join(",");
}` },
  { name: "async-function", fn: "f", ts: `export async function f(): Promise<any> {
  return 1;
}` },
  // ---------- BigInt / 数字边界 ----------
  { name: "bigint-basic", fn: "f", ts: `export function f(): any {
  const a = 10n;
  const b = 3n;
  return (a + b).toString() + "|" + (a / b).toString() + "|" + typeof a;
}` },
  { name: "num-literal-forms", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(0b1010 + 0o12 + 0xff + 1_000);
  out.push(.5 + 5.);
  out.push(1e3, 1E-3, 1e+3);
  out.push(Number.isFinite(1 / 0) ? 1 : 0);
  out.push(0.1 * 3);
  out.push((1234567890123456).toString().length);
  return out.join("|");
}` },
  { name: "num-precision", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(0.1 + 0.2 === 0.30000000000000004 ? 1 : 0);
  out.push((0.1).toFixed(20));
  out.push(1 / 3 + 1 / 3 + 1 / 3);
  out.push(Number.EPSILON > 0 ? 1 : 0);
  out.push((-0).toFixed(1));
  out.push((1e-10).toString());
  out.push((123456789.123456789).toString());
  return out.join("|");
}` },
  { name: "num-coercion-odd", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push([] == "" ? 1 : 0);
  out.push([null] == "" ? 1 : 0);
  out.push([undefined] == "" ? 1 : 0);
  out.push([1, 2] == "1,2" ? 1 : 0);
  out.push({} == "[object Object]" ? 1 : 0);
  out.push(+" " === 0 ? 1 : 0);
  out.push(null <= 0 ? 1 : 0);
  out.push(undefined > 0 ? 1 : 0);
  return out.join("|");
}` },
  // ---------- 描述符 / 对象内省 ----------
  { name: "obj-descriptor", fn: "f", ts: `export function f(): any {
  const o: any = {};
  Object.defineProperty(o, "hidden", { value: 1, enumerable: false, writable: false });
  const out: any = [];
  out.push(o.hidden);
  out.push(Object.keys(o).length);
  out.push(Object.getOwnPropertyNames ? Object.getOwnPropertyNames(o).join(",") : "n/a");
  return out.join("|");
}` },
  { name: "obj-instance-props", fn: "f", ts: `class C { a: any = 1; b: any; constructor() { this.b = 2; } m(): any { return 3; } }
export function f(): any {
  const c = new C();
  const out: any = [];
  out.push(c.hasOwnProperty("a") ? 1 : 0);
  out.push("a" in c ? 1 : 0);
  out.push(typeof c.m);
  const keys: any = [];
  for (const k in c) keys.push(k);
  out.push(keys.sort().join(","));
  return out.join("|");
}` },
  { name: "for-in-inherited", fn: "f", ts: `class A { x: any = 1; }
class B extends A { y: any = 2; }
export function f(): any {
  const b = new B();
  const keys: any = [];
  for (const k in b) keys.push(k);
  const pojo: any = { p: 1, q: 2 };
  const pk: any = [];
  for (const k in pojo) pk.push(k);
  return keys.sort().join(",") + "|" + pk.sort().join(",");
}` },
  // ---------- JSON 深水 ----------
  { name: "json-replacer", fn: "f", ts: `export function f(): any {
  const o: any = { a: 1, b: 2 };
  const s = JSON.stringify(o, ["a"]);
  return s + "|" + JSON.stringify(o, null, 2).length;
}` },
  { name: "json-reviver", fn: "f", ts: `export function f(): any {
  const s = '{"a":1,"b":2}';
  const o: any = JSON.parse(s, (k: any, v: any) => (k === "b" ? undefined : v));
  return JSON.stringify(o) + "|" + (o.b === undefined ? 1 : 0);
}` },
  { name: "json-undefined-nan", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(JSON.stringify(undefined));
  out.push(JSON.stringify(NaN), JSON.stringify(Infinity), JSON.stringify(-Infinity));
  out.push(JSON.stringify([1, undefined, NaN]));
  out.push(JSON.stringify({ a: undefined, b: NaN }));
  out.push(JSON.stringify(-0));
  return out.join("|");
}` },
  { name: "json-instance-tojson", fn: "f", ts: `class T { v: any = 5; toJSON(): any { return { val: this.v }; } }
export function f(): any {
  const t = new T();
  const arr: any = [t, t];
  const o: any = { t: t, n: 1 };
  return JSON.stringify(t) + "|" + JSON.stringify(arr) + "|" + JSON.stringify(o);
}` },
  // ---------- 控制流 / 其他 ----------
  { name: "switch-scoped-blocks", fn: "f", ts: `export function f(x: any): any {
  let out = "";
  switch (x) {
    case 1: { const v = "a"; out += v; }
    case 2: { const v = "b"; out += v; break; }
    default: { const v = "d"; out += v; }
  }
  return out;
}`, args: [1] },
  { name: "try-catch-in-catch", fn: "f", ts: `export function f(): any {
  const out: any = [];
  try {
    try { throw new Error("inner"); }
    catch (e: any) { out.push("i:" + e.message); throw new Error("outer"); }
  } catch (e: any) { out.push("o:" + e.message); }
  try { try { throw 1; } catch (e: any) { out.push("n:" + e); } } finally { out.push("f"); }
  return out.join("|");
}` },
  { name: "deep-recursion", fn: "f", ts: `export function f(): any {
  function go(n: any): any { return n === 0 ? 0 : 1 + go(n - 1); }
  return go(250);   // 宿主↔wasm 闭包递归每层耗 JS 栈 ~300 层上限（500 需 node --stack-size）
}` },
  { name: "many-locals", fn: "f", ts: `export function f(): any {
  let a1 = 1, a2 = 2, a3 = 3, a4 = 4, a5 = 5, a6 = 6, a7 = 7, a8 = 8, a9 = 9, a10 = 10;
  let b1 = 11, b2 = 12, b3 = 13, b4 = 14, b5 = 15, b6 = 16, b7 = 17, b8 = 18, b9 = 19, b10 = 20;
  let s = 0;
  for (let i = 0; i < 3; i++) { s += a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8 + a9 + a10 + b1 + b2 + b3 + b4 + b5 + b6 + b7 + b8 + b9 + b10; }
  return s + "|" + (a1 + b10);
}` },
  { name: "string-long-repeat", fn: "f", ts: `export function f(): any {
  let s = "";
  for (let i = 0; i < 200; i++) s += "abc";
  const parts = s.split("b");
  return s.length + "|" + parts.length + "|" + parts[0];
}` },
  { name: "switch-string-many", fn: "f", ts: `export function f(s: any): any {
  switch (s) {
    case "aa": return 1;
    case "bb": return 2;
    case "cc": return 3;
    case "dd": return 4;
    default: return 0;
  }
}`, args: ["cc"] },
  { name: "optional-mixed-chain", fn: "f", ts: `export function f(o: any): any {
  const out: any = [];
  out.push(o?.a?.b ?? "1");
  out.push((o?.arr ?? [1])[0]);
  out.push(o?.["k"] ?? "2");
  out.push(o?.fn2 ? 1 : 0);
  out.push(typeof o?.a);
  return out.join("|");
}`, args: [{ a: { b: "bb" }, arr: [7], k: "kk" }] },
  { name: "class-static-method-chain", fn: "f", ts: `class M { static n: any = 0; static inc(): any { M.n++; return M; } static get(): any { return M.n; } }
export function f(): any {
  const out: any = [];
  out.push(M.inc().inc().get());
  out.push(M.n);
  return out.join("|");
}` },
  { name: "nested-closure-capture-deep", fn: "f", ts: `export function f(): any {
  let acc = 0;
  function l1() {
    let a = 1;
    function l2() {
      let b = 2;
      function l3() { acc += a + b; return acc; }
      return l3();
    }
    return l2();
  }
  l1(); l1();
  return acc;
}` },
  { name: "array-holes-vs-undefined", fn: "f", ts: `export function f(): any {
  const a: any = new Array(3);
  const out: any = [];
  out.push(a.length);
  out.push(a[0] === undefined ? 1 : 0);
  out.push(a.join("-"));
  out.push(a.map((x: any) => 1).length);
  const b: any = [undefined, undefined];
  out.push(b.map((x: any) => 1).length);
  out.push(b.join("-"));
  return out.join("|");
}` },
];
