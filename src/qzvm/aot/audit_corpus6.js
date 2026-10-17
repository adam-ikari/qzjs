// 差分审计语料（第六批）：标准库边界 / 迭代协议 / 类与闭包细节 / 控制流细节。
module.exports = [
  // ---------- String 边界 ----------
  { name: "str-split-limit", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("a,b,c,d".split(",", 2).join("|"));
  out.push("a,b,c".split(undefined as any).length);
  out.push("".split(",").length);
  out.push("abc".split("").join(""));
  out.push(" a b ".split(" ").length);
  return out.join("#");
}` },
  { name: "str-slice-edges", fn: "f", ts: `export function f(): any {
  const s = "abcdef";
  const out: any = [];
  out.push(s.slice(-2));
  out.push(s.slice(-2, -1));
  out.push(s.slice(4, 2));
  out.push(s.substring(4, 2));
  out.push(s.substring(-3, 2));
  out.push(s.slice(0, -100));
  out.push(s.slice(100));
  out.push(s.substr ? s.substr(-3, 2) : "n/a");
  return out.join("|");
}` },
  { name: "str-pad-multi", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("x".padStart(5, "ab"));
  out.push("x".padEnd(6, "xyz"));
  out.push("x".padStart(1, "ab"));
  out.push("".padStart(3, "-"));
  return out.join("|");
}` },
  { name: "str-charcode-edges", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("abc".charCodeAt(10));
  out.push("abc".charCodeAt(-1));
  out.push("abc".charAt(10) === "" ? 1 : 0);
  out.push(String.fromCharCode(97, 98));
  out.push("abc".indexOf("", 2));
  out.push("abc".lastIndexOf("b", 0));
  out.push("abc".includes("", 1) ? 1 : 0);
  return out.join("|");
}` },
  { name: "str-raw-and-escapes", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("a\\\\b".length);
  out.push("a\\nb".length);
  out.push("\\u{1F600}".length);
  out.push("tab\\there".indexOf("\\t"));
  out.push("q'z\\"w".length);
  return out.join("|");
}` },
  // ---------- Array 边界 ----------
  { name: "arr-sort-comparator", fn: "f", ts: `export function f(): any {
  const a = [3, 1, 2];
  const out: any = [];
  out.push(a.slice().sort((x: any, y: any) => (x > y ? 1 : x < y ? -1 : 0)).join(","));
  out.push(a.slice().sort(() => 0).join(","));
  out.push([10, 9, 1].sort().join(","));
  out.push(["b", "a", "C"].sort().join(","));
  const mixed: any = [10, "2", 1];
  out.push(mixed.slice().sort().join(","));
  return out.join("|");
}` },
  { name: "arr-flat-fill", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push([1, [2, [3, [4]]]].flat().length);
  out.push([1, [2, [3, [4]]]].flat(2).length);
  out.push([1, [2, [3, [4]]]].flat(Infinity).length);
  const a: any = [1, 2, 3, 4];
  out.push(a.slice().fill(0, 1, 3).join(","));
  out.push([1, 2, 3, 4, 5].slice().copyWithin(0, 3).join(","));
  return out.join("|");
}` },
  { name: "arr-index-from", fn: "f", ts: `export function f(): any {
  const a = [1, 2, 3, 2, 1];
  const out: any = [];
  out.push(a.indexOf(2, 2));
  out.push(a.lastIndexOf(2, 2));
  out.push(a.indexOf(9));
  out.push(a.includes(9) ? 1 : 0);
  out.push(a.find((x: any) => x > 2));
  out.push(a.findLast ? a.findLast((x: any) => x < 2) : "n/a");
  return out.join("|");
}` },
  { name: "arr-empty-callbacks", fn: "f", ts: `export function f(): any {
  const e: any = [];
  const out: any = [];
  out.push(e.every((x: any) => x > 0) ? 1 : 0);
  out.push(e.some((x: any) => x > 0) ? 1 : 0);
  out.push(e.map((x: any) => x).length);
  out.push(e.filter((x: any) => x).length);
  let threw = 0;
  try { e.reduce((s: any, x: any) => s + x); } catch (err: any) { threw = 1; }
  out.push(threw);
  out.push(e.reduce((s: any, x: any) => s + x, 7));
  return out.join("|");
}` },
  { name: "arr-splice-negative", fn: "f", ts: `export function f(): any {
  const a: any = [1, 2, 3, 4, 5];
  const out: any = [];
  out.push(a.splice(-2).join(","));
  out.push(a.join(","));
  const b: any = [1, 2, 3, 4, 5];
  out.push(b.splice(-3, 2).join(","));
  out.push(b.join(","));
  const c: any = [1, 2, 3];
  out.push(c.splice(1, 0, "x").length);
  out.push(c.join(","));
  return out.join("|");
}` },
  { name: "arr-push-multi-return", fn: "f", ts: `export function f(): any {
  const a: any = [1];
  const out: any = [];
  out.push(a.push(2, 3));
  out.push(a.join(","));
  out.push(a.unshift(0, -1));
  out.push(a.join(","));
  out.push(a.pop(), a.shift());
  out.push(a.join(","));
  return out.join("|");
}` },
  // ---------- Object / 迭代 ----------
  { name: "obj-assign-multi", fn: "f", ts: `export function f(): any {
  const t: any = { a: 1 };
  const o: any = Object.assign(t, { b: 2 }, { a: 3 }, { c: 4 });
  const out: any = [];
  out.push(o === t ? 1 : 0);
  out.push(JSON.stringify(Object.keys(o).sort()));
  out.push(o.a, o.b, o.c);
  return out.join("|");
}` },
  { name: "obj-in-numeric", fn: "f", ts: `export function f(): any {
  const o: any = { "1": "a", x: 1 };
  const out: any = [];
  out.push(1 in o ? 1 : 0);
  out.push("1" in o ? 1 : 0);
  out.push("x" in o ? 1 : 0);
  out.push(2 in o ? 1 : 0);
  out.push(o[1]);
  const a: any = [10, 20];
  out.push(0 in a ? 1 : 0);
  out.push(2 in a ? 1 : 0);
  return out.join("|");
}` },
  { name: "iteration-destructure-nested", fn: "f", ts: `export function f(): any {
  const pairs: any = [[1, [2, 3]], [4, [5, 6]]];
  const out: any = [];
  for (const [a, [b, c]] of pairs) out.push(a + b + c);
  const o: any = { x: [1, 2], y: [3] };
  for (const [k, [v1, v2]] of Object.entries(o)) out.push(k + v1 + (v2 === undefined ? 0 : v2));
  return out.join(",");
}` },
  { name: "map-iterate-entries", fn: "f", ts: `export function f(): any {
  const m: any = new Map([["a", 1], ["b", 2]]);
  const out: any = [];
  for (const [k, v] of m.entries()) out.push(k + v);
  out.push(Array.from(m).length);
  out.push(Array.from(m.keys()).join(""));
  out.push(Array.from(m.values()).join(""));
  return out.join("|");
}` },
  // ---------- 类与闭包细节 ----------
  { name: "class-method-super-param", fn: "f", ts: `class A { m(x: any): any { return "A" + x; } }
class B extends A { m(x: any): any { return "B" + super.m(x) + x; } }
export function f(): any { const b = new B(); const out: any = []; out.push(b.m(1)); out.push(b.m(2)); return out.join("|"); }` },
  { name: "class-field-this-ref", fn: "f", ts: `class C { a: any = 1; b: any = 2; sum(): any { return this.a + this.b; } }
export function f(): any { const c = new C(); const d = new C(); d.a = 10; return c.sum() + "|" + d.sum() + "|" + (c.sum() === 3 ? 1 : 0); }` },
  { name: "class-instance-array-sort", fn: "f", ts: `class P { n: any; constructor(n: any) { this.n = n; } }
export function f(): any {
  const ps: any = [new P(3), new P(1), new P(2)];
  ps.sort((x: any, y: any) => x.n - y.n);
  return ps.map((p: any) => p.n).join(",");
}` },
  { name: "closure-shared-counter", fn: "f", ts: `export function f(): any {
  function makePair() {
    let n = 0;
    const inc = () => { n++; return n; };
    const get = () => n;
    return { inc: inc, get: get };
  }
  const p = makePair();
  p.inc(); p.inc();
  const q = makePair();
  return p.get() + "|" + q.get() + "|" + p.inc();
}` },
  { name: "closure-recursion-inside", fn: "f", ts: `export function f(): any {
  function outer(n: any) {
    function inner(k: any): any { return k <= 0 ? 0 : k + inner(k - 1); }
    return inner(n) + n;
  }
  return outer(4) + "|" + outer(1);
}` },
  { name: "this-arrow-in-method", fn: "f", ts: `class C { v: any = 5; make(): any { const f = () => this.v * 2; return f(); } deep(): any { const f = () => () => this.v + 1; return f()(); } }
export function f(): any { const c = new C(); return c.make() + "|" + c.deep(); }` },
  { name: "getter-with-sideeffect", fn: "f", ts: `class C { _n: any = 0; get v(): any { this._n++; return this._n; } }
export function f(): any { const c = new C(); const out: any = []; out.push(c.v); out.push(c.v); out.push(c._n); return out.join("|"); }` },
  // ---------- 控制流细节 ----------
  { name: "loop-label-continue", fn: "f", ts: `export function f(): any {
  let out = "";
  outer: for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (j === 2) continue outer;
      if (i === 2) break outer;
      out += "" + i + j;
    }
  }
  return out;
}` },
  { name: "switch-in-loop-break", fn: "f", ts: `export function f(): any {
  let out = "";
  for (let i = 0; i < 4; i++) {
    switch (i) {
      case 0: out += "z"; break;
      case 1: out += "o"; continue;
      case 2: out += "t"; break;
      default: out += "d"; break;
    }
    out += ".";
  }
  return out + "|" + out.length;
}` },
  { name: "try-in-loop-mixed", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const boom = (i: any) => { throw new Error("e" + i); };
  for (let i = 0; i < 4; i++) {
    try { if (i % 2 === 1) boom(i); out.push("ok" + i); }
    catch (e: any) { out.push("c" + e.message); }
    finally { out.push("f" + i); }
  }
  return out.join("|");
}` },
  { name: "nested-loops-break-value", fn: "f", ts: `export function f(): any {
  let found = -1;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (i * j === 6) { found = i * 10 + j; break; }
    }
    if (found >= 0) break;
  }
  const a: any = [];
  for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) a.push(i * 3 + j); }
  return found + "|" + a.join(",");
}` },
  { name: "negative-zero-and-nan", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const z = -0;
  out.push(1 / z);
  out.push(z === 0 ? 1 : 0);
  out.push(Object.is ? (Object.is(z, 0) ? 1 : 0) : -1);
  out.push(String(z));
  out.push(NaN === NaN ? 1 : 0);
  out.push(Math.min(0, -0) === -0 ? "min-0" : "min0");
  out.push([NaN].indexOf(NaN));
  out.push([NaN].includes(NaN) ? 1 : 0);
  return out.join("|");
}` },
  { name: "num-int-edges", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Number.isInteger(1e21) ? 1 : 0);
  out.push(Number.parseInt("10", 2));
  out.push(Number.parseInt("z", 36));
  out.push(Number.parseFloat("  1.5e2x"));
  out.push(parseInt("0x10", 16));
  out.push(Number("0b101"));
  out.push(Number("Infinity"));
  out.push(1e21 === 1e21 + 1 ? 1 : 0);
  out.push(Number.MAX_SAFE_INTEGER + 2 === Number.MAX_SAFE_INTEGER + 1 ? 1 : 0);
  out.push((0.1 + 0.2).toFixed(20).length);
  return out.join("|");
}` },
  { name: "string-method-chains", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("  A,b,C  ".trim().split(",").map((s: any) => s.trim().toLowerCase()).sort().join("-"));
  out.push("abc".toUpperCase().slice(1).concat("!"));
  out.push("a-b-c".split("-").reverse().join("+"));
  out.push("x".repeat(3).length);
  out.push("Hello".replace("l", "L").replace("l", "L"));
  return out.join("|");
}` },
];
