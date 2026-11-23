// 差分审计语料（第十二批）：>4 形参闭包 ABI / 调用元数语义 / rest·默认值·解构形参组合 / 高阶函数。
module.exports = [
  { name: "many-params-nested-decl", fn: "f", ts: `export function f(): any {
  function six(a: any, b: any, c: any, d: any, e: any, g: any): any { return [a, b, c, d, e, g].join("-"); }
  const out: any = [];
  out.push(six(1, 2, 3, 4, 5, 6));
  out.push(six(1, 2, 3));
  out.push(six(1, 2, 3, 4, 5, 6, 7));
  out.push(six());
  return out.join("|");
}` },
  { name: "many-params-arrow", fn: "f", ts: `export function f(): any {
  const sum7 = (a: any, b: any, c: any, d: any, e: any, g: any, h: any) => a + b + c + d + e + g + h;
  const out: any = [];
  out.push(sum7(1, 2, 3, 4, 5, 6, 7));
  out.push(typeof sum7);
  return out.join("|");
}` },
  { name: "many-params-mixed-rest", fn: "f", ts: `export function f(): any {
  function mix(a: any, b: any, c: any, d: any, ...rest: any[]): any { return a + b + c + d + ":" + rest.join(","); }
  const out: any = [];
  out.push(mix(1, 2, 3, 4));
  out.push(mix(1, 2, 3, 4, 5, 6));
  out.push(mix(1));
  return out.join("|");
}` },
  { name: "many-params-defaults", fn: "f", ts: `export function f(): any {
  function d5(a: any, b: any, c: any, d: any = "D", e: any = "E"): any { return [a, b, c, d, e].join(","); }
  const out: any = [];
  out.push(d5(1, 2, 3));
  out.push(d5(1, 2, 3, 4));
  out.push(d5(1, 2, 3, undefined, 9));
  out.push(d5(1, 2, 3, null, 9));
  return out.join("|");
}` },
  { name: "many-params-passed-as-value", fn: "f", ts: `export function f(): any {
  function six(a: any, b: any, c: any, d: any, e: any, g: any): any { return [a, b, c, d, e, g].join(""); }
  const fn: any = six;
  const out: any = [];
  out.push(typeof fn);
  out.push(fn(1, 2, 3, 4, 5, 6));
  out.push([1, 2, 3].map((x: any) => six(x, x, x, x, x, x)).join("|"));
  return out.join("|");
}` },
  { name: "higher-order-callbacks-arities", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const apply6 = (cb: any): any => cb(1, 2, 3, 4, 5, 6);
  out.push(apply6((...xs: any[]) => xs.length + ":" + xs.join("")));
  const arr: any = [1, 2, 3];
  out.push(arr.map((v: any, i: any) => v * 10 + i).join(","));
  out.push(arr.reduce((acc: any, v: any, i: any) => acc + v + i, 0));
  out.push(arr.filter((v: any, i: any) => (v + i) % 2 === 0).join(","));
  out.push(arr.sort((a: any, b: any) => b - a).join(","));
  return out.join("|");
}` },
  { name: "closure-captures-with-many-params", fn: "f", ts: `export function f(): any {
  let total = 0;
  function add5(a: any, b: any, c: any, d: any, e: any): any { total += a + b + c + d + e; return total; }
  const out: any = [];
  out.push(add5(1, 1, 1, 1, 1));
  out.push(add5(2, 2, 2, 2, 2));
  out.push(total);
  const mk = (): any => (w: any, x: any, y: any, z: any, q: any) => w + x + y + z + q;
  out.push(mk()(1, 2, 3, 4, 5));
  return out.join("|");
}` },
  { name: "nested-function-decl-calls", fn: "f", ts: `export function f(): any {
  function outer(): any {
    function inner(a: any, b: any, c: any, d: any, e: any): any { return [a, b, c, d, e].join("/"); }
    return inner("a", "b", "c", "d", "e");
  }
  const g: any = () => {
    function inner2(a: any, b: any, c: any, d: any, e: any, g2: any): any { return a + b + c + d + e + g2; }
    return inner2(1, 1, 1, 1, 1, 1);
  };
  return outer() + "|" + g();
}` },
  { name: "recursive-many-params", fn: "f", ts: `export function f(): any {
  function build(n: any, acc: any, a: any, b: any, c: any): any {
    if (n === 0) return acc.join("-");
    return build(n - 1, acc.concat([n + a + b + c]), a, b, c);
  }
  return build(3, [], 1, 2, 3);
}` },
  { name: "many-params-exported", fn: "g", ts: `export function g(a: any, b: any, c: any, d: any, e: any, f2: any): any {
  return [a, b, c, d, e, f2].map((x: any) => typeof x).join(",");
}`, args: [1, "s", true, null, undefined, {}] },
  { name: "callback-with-extra-args-ignored", fn: "f", ts: `export function f(): any {
  let seen = "";
  function only3(a: any, b: any, c: any): any { seen = [a, b, c].join(","); return seen; }
  const extra4: any = (a: any, b: any, c: any, d: any): any => only3(a, b, c) + "|" + typeof d;
  const out: any = [];
  out.push(extra4(1, 2, 3, 4));
  out.push(seen);
  out.push(extra4(1, 2, 3));
  return out.join("|");
}` },
  { name: "iife-many-params", fn: "f", ts: `export function f(): any {
  const r: any = (function (a: any, b: any, c: any, d: any, e: any): any { return a + b + c + d + e; })(1, 2, 3, 4, 5);
  const r2: any = ((a: any, b: any, c: any, d: any, e: any, g: any) => a * b * c * d * e * g)(1, 1, 2, 1, 1, 3);
  return r + "|" + r2;
}` },
  { name: "object-literal-methods-many-params", fn: "f", ts: `export function f(): any {
  const o: any = {
    base: 10,
    add5(a: any, b: any, c: any, d: any, e: any): any { return this.base + a + b + c + d + e; },
    nested(): any { function inner(p: any, q: any, r: any, s: any, t: any): any { return p + q + r + s + t; } return inner(1, 2, 3, 4, 5); }
  };
  const out: any = [];
  out.push(o.add5(1, 1, 1, 1, 1));
  out.push(o.nested());
  return out.join("|");
}` },
  { name: "class-method-many-params", fn: "f", ts: `class C {
  v: any = 1;
  m(a: any, b: any, c: any, d: any, e: any): any { return this.v + a + b + c + d + e; }
  static s(a: any, b: any, c: any, d: any, e: any): any { return [a, b, c, d, e].join(""); }
}
export function f(): any {
  const c = new C();
  const out: any = [];
  out.push(c.m(1, 1, 1, 1, 1));
  out.push(C.s("a", "b", "c", "d", "e"));
  const m: any = c.m.bind(c);
  out.push(m(2, 2, 2, 2, 2));
  return out.join("|");
}` },
  { name: "array-holes-and-spread-mix", fn: "f", ts: `export function f(): any {
  const a: any = [1, , 3];
  const b: any = [...a, 4];
  const out: any = [];
  out.push(a.length, b.length);
  out.push(a.join("-"), b.join("-"));
  out.push(a.map((x: any) => (x === undefined ? "u" : x)).join(","));
  out.push(Object.keys(a).join(","));
  const c: any = new Array(3).fill(0);
  out.push(c.join(","));
  out.push([...c, ...a].length);
  return out.join("|");
}` },
  { name: "string-builder-perf-shape", fn: "f", ts: `export function f(): any {
  let s = "";
  for (let i = 0; i < 50; i++) s += "ab";
  const parts = s.split("b");
  return s.length + "|" + parts.length + "|" + s.slice(0, 4) + "|" + (s === s) ;
}` },
];
