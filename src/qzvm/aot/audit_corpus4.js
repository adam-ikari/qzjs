// 差分审计语料（第四批）：容器/类细节/可选调用/强制转换/错误/数字字符串边界。
module.exports = [
  // ---------- 容器（宿主内建） ----------
  { name: "map-basic", fn: "f", ts: `export function f(): any {
  const m: any = new Map();
  m.set("a", 1); m.set("b", 2);
  const out: any = [];
  out.push(m.get("a"));
  out.push(m.has("c") ? 1 : 0);
  out.push(m.size);
  m.delete("a");
  out.push(m.size);
  out.push(m.get("missing") === undefined ? 1 : 0);
  return out.join("|");
}` },
  { name: "set-basic", fn: "f", ts: `export function f(): any {
  const s: any = new Set([1, 2, 2, 3]);
  const out: any = [];
  out.push(s.size);
  out.push(s.has(2) ? 1 : 0);
  s.add(4);
  out.push(s.size);
  return out.join("|");
}` },
  { name: "map-iterate", fn: "f", ts: `export function f(): any {
  const m: any = new Map(); m.set("a", 1); m.set("b", 2);
  const out: any = [];
  for (const k of m.keys()) out.push(k);
  for (const [k, v] of m) out.push(k + "=" + v);
  return out.join(",");
}` },
  { name: "array-from-map", fn: "f", ts: `export function f(): any {
  const m: any = new Map([["x", 1], ["y", 2]]);
  return Array.from(m.keys()).join(",") + "|" + Array.from(m.values()).join(",");
}` },
  { name: "date-basic", fn: "f", ts: `export function f(): any {
  const d: any = new Date(0);
  const out: any = [];
  out.push(typeof d);
  out.push(d instanceof Date ? 1 : 0);
  out.push(d.getTime ? 1 : 0);
  return out.join("|");
}` },
  { name: "error-throw-typed", fn: "f", ts: `export function f(): any {
  const out: any = [];
  try { throw new TypeError("bad"); } catch (e: any) {
    out.push(e instanceof TypeError ? 1 : 0);
    out.push(e instanceof Error ? 1 : 0);
    out.push(e.message);
    out.push(e.name);
  }
  return out.join("|");
}` },
  { name: "error-custom-class", fn: "f", ts: `class MyErr extends Error { constructor(m: any) { super(m); } }
export function f(): any {
  const out: any = [];
  try { throw new MyErr("x1"); } catch (e: any) { out.push(e.message); out.push(e.name); }
  return out.join("|");
}` },
  // ---------- 类细节 ----------
  { name: "class-private-field", fn: "f", ts: `class C { #v: any = 1; get v(): any { return this.#v; } inc(): any { this.#v++; return this.#v; } }
export function f(): any { const c = new C(); return c.v + "|" + c.inc() + "|" + c.v; }` },
  { name: "class-static-block", fn: "f", ts: `class C { static v: any = 1; static { C.v = 7; } }
export function f(): any { return C.v; }` },
  { name: "class-tojson", fn: "f", ts: `class P { a: any = 1; toJSON(): any { return { wrapped: this.a }; } }
export function f(): any { const p = new P(); return JSON.stringify(p) + "|" + JSON.stringify({ p: p }); }` },
  { name: "class-valueof-plus", fn: "f", ts: `class N { v: any; constructor(v: any) { this.v = v; } valueOf(): any { return this.v * 2; } toString(): any { return "N" + this.v; } }
export function f(): any { const n = new N(5); const out: any = []; out.push(n + 1); out.push("" + n); out.push(String(n)); return out.join("|"); }` },
  { name: "class-obj-keys", fn: "f", ts: `class C { a: any = 1; b: any = 2; m(): any { return 3; } }
export function f(): any { const c = new C(); return JSON.stringify(c) + "|" + Object.keys(c).join(",") + "|" + ("a" in c ? 1 : 0); }` },
  { name: "class-method-ref", fn: "f", ts: `class C { v: any = 3; get(): any { return this.v; } }
export function f(): any { const c = new C(); const out: any = []; out.push(typeof c.get); out.push(c.get()); return out.join("|"); }` },
  { name: "class-inherit-static-inherit", fn: "f", ts: `class A { static kind(): any { return "A"; } static who(): any { return this.kind ? "this" : "no-this"; } }
class B extends A { static kind(): any { return "B"; } }
export function f(): any { return A.kind() + "|" + B.kind(); }` },
  { name: "class-super-prop", fn: "f", ts: `class A { x: any = 1; get v(): any { return 10; } }
class B extends A { x: any = 2; get v(): any { return super.v + this.x; } }
export function f(): any { const b = new B(); return b.v + "|" + b.x; }` },
  // ---------- 可选调用 / 展开 ----------
  { name: "opt-call-fn2", fn: "f", ts: `export function f(o: any): any {
  const out: any = [];
  out.push(typeof o?.cb);
  out.push(o?.cb ? "has" : "none");
  if (o && typeof o.cb === "function") out.push(o.cb(2));
  return out.join("|");
}`, args: [{ cb: function (x) { return x * 3; } }] },
  { name: "new-spread", fn: "f", ts: `class P { a: any; b: any; constructor(x: any, y: any) { this.a = x; this.b = y; } }
export function f(): any {
  const args: any = [1, 2];
  const p = new P(...args);
  const q = new P(...[3, 4]);
  return p.a + "|" + p.b + "|" + q.a + "|" + q.b;
}` },
  { name: "template-nested", fn: "f", ts: `export function f(): any {
  const a = 1;
  const s = \`x\${a > 0 ? \`pos\${a}\` : "neg"}\${[1, 2].length}\`;
  return s + "|" + \`\${"nested \`" + "q" + "\`"}\`;
}` },
  { name: "tagged-template", fn: "f", ts: `export function f(): any {
  function tag(strings: any, v: any) { return strings[0] + "-" + v + "-" + strings[1]; }
  return tag\`a\${1}b\`;
}` },
  { name: "spread-object-in-call", fn: "f", ts: `export function f(): any {
  function g(o: any) { return o.a + "|" + o.b; }
  const base: any = { a: 1 };
  return g({ ...base, b: 2 });
}` },
  // ---------- 强制转换 / 数字字符串 ----------
  { name: "coerce-obj-primitive", fn: "f", ts: `export function f(): any {
  const o: any = { a: 1 };
  const out: any = [];
  out.push(String(o));
  out.push(Number(o) === Number.NaN ? "nan" : "num");
  out.push(!!o ? 1 : 0);
  out.push([1, 2].toString());
  out.push([1, 2] + "");
  out.push([] + []);
  return out.join("|");
}` },
  { name: "num-parse-edge", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Number(""));
  out.push(Number("  "));
  out.push(Number("0x10"));
  out.push(Number("1e3"));
  out.push(Number(null));
  out.push(Number(undefined));
  out.push(parseInt(""));
  out.push(parseFloat(".5"));
  out.push(parseFloat("1e2"));
  out.push((0.1 + 0.2 === 0.3) ? 1 : 0);
  out.push(1e21 + 1);
  out.push((123.456).toFixed(1));
  out.push((-0).toString());
  out.push((1 / 3).toPrecision(3));
  return out.join("|");
}` },
  { name: "num-bit-edge2", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(2147483647 + 1 | 0);
  out.push(-2147483648 - 1 | 0);
  out.push(0.9 | 0);
  out.push(-0.9 | 0);
  out.push(Infinity | 0);
  out.push(1.5 << 1);
  out.push(3.7 >>> 0);
  out.push(0x7fffffff << 1);
  return out.join("|");
}` },
  { name: "str-escapes", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("a\\tb".length);
  out.push("a\\nb".charCodeAt(1));
  out.push("\\u0041");
  out.push("\\x41");
  out.push("\\\\".length);
  out.push("q\\"z".length);
  out.push("caf\\u00e9".length);
  return out.join("|");
}` },
  { name: "str-compare-sort", fn: "f", ts: `export function f(): any {
  const a = ["b", "a", "C", "10", "2"];
  const out: any = [];
  out.push(a.slice().sort().join(","));
  out.push(a.slice().sort((x: any, y: any) => x.length - y.length).join(","));
  out.push("b" > "a" ? 1 : 0);
  out.push("2" > "10" ? 1 : 0);
  return out.join("|");
}` },
  { name: "json-nested-classes", fn: "f", ts: `class Row { id: any; tags: any; constructor(i: any, t: any) { this.id = i; this.tags = t; } }
export function f(): any {
  const rows: any = [new Row(1, ["a"]), new Row(2, [])];
  const s = JSON.stringify(rows);
  const back: any = JSON.parse(s);
  return s + "|" + back.length + "|" + back[0].tags[0];
}` },
  { name: "closure-this-arrow-method", fn: "f", ts: `class C { v: any = 5; make(): any { const g = () => this.v; return g(); } make2(): any { const self = this; const g2 = function () { return self.v + 1; }; return g2(); } }
export function f(): any { const c = new C(); return c.make() + "|" + c.make2(); }` },
  { name: "object-methods-this", fn: "f", ts: `export function f(): any {
  const counter: any = { n: 0, add(k: any) { this.n += k; return this; }, get() { return this.n; } };
  counter.add(2).add(3);
  return counter.get() + "|" + counter.n;
}` },
  { name: "destructure-param-default-obj", fn: "f", ts: `export function f(): any {
  function g({ a = 1, b = { c: 2 } }: any = {}) { return a + "|" + b.c; }
  const out: any = [];
  out.push(g());
  out.push(g({ a: 5 }));
  out.push(g({ a: 5, b: { c: 9 } }));
  return out.join(",");
}` },
  { name: "arr-of-arr-mutation", fn: "f", ts: `export function f(): any {
  const m: any = [[1, 2], [3]];
  m[0].push(9);
  m[1][0] = 30;
  return JSON.stringify(m) + "|" + m.length + "|" + m[0].length;
}` },
  { name: "string-json-special", fn: "f", ts: `export function f(): any {
  const o: any = { s: "a\\"b\\\\c\\nd", t: "tab\\there", u: "\\u00e9" };
  const j = JSON.stringify(o);
  const back: any = JSON.parse(j);
  return j.length + "|" + back.s.length + "|" + back.t.charAt(3) + "|" + back.u;
}` },
  { name: "mixed-ops-precedence", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(1 + 2 * 3);
  out.push((1 + 2) * 3);
  out.push(2 ** 3 ** 2);
  out.push(-(2 ** 2));
  out.push(1 - -1);
  out.push(!0 + 1);
  out.push(typeof void 0);
  out.push(1 < 2 === true ? 1 : 0);
  out.push((1, 2, 3));
  return out.join("|");
}` },
  { name: "switch-numeric-and-default-order", fn: "f", ts: `export function f(x: any): any {
  let out = "";
  switch (x) {
    default: out += "d";
    case 1: out += "1"; break;
    case 2: out += "2"; break;
  }
  return out;
}`, args: [1] },
  { name: "do-while-continue", fn: "f", ts: `export function f(): any {
  let i = 0, out = "";
  do { i++; if (i % 2 === 0) continue; out += i; } while (i < 6);
  return out + "|" + i;
}` },
  { name: "labeled-block-break", fn: "f", ts: `export function f(): any {
  let out = "";
  outer: { out += "a"; if (out) break outer; out += "b"; }
  out += "|";
  inner: for (let i = 0; i < 2; i++) { for (let j = 0; j < 2; j++) { if (j === 1) continue inner; out += i + "" + j; } }
  return out;
}` },
  { name: "try-finally-no-catch", fn: "f", ts: `export function f(): any {
  const out: any = [];
  try { out.push("t"); } finally { out.push("f"); }
  function g() { try { return 1; } finally { out.push("g"); } }
  out.push(g());
  return out.join("|");
}` },
  { name: "array-methods-chain-complex", fn: "f", ts: `export function f(): any {
  const users: any = [{ n: "a", age: 30 }, { n: "b", age: 20 }, { n: "c", age: 40 }];
  return users
    .filter((u: any) => u.age >= 30)
    .sort((x: any, y: any) => y.age - x.age)
    .map((u: any) => u.n + ":" + u.age)
    .join(" | ");
}` },
  { name: "obj-spread-merge-order", fn: "f", ts: `export function f(): any {
  const a: any = { x: 1, y: 2 };
  const b: any = { y: 3, z: 4 };
  const c: any = { ...a, ...b };
  const d: any = { ...b, ...a };
  const k = (o: any) => Object.keys(o).sort().map((n: any) => n + "=" + o[n]).join(",");\n  return k(c) + "|" + k(d) + "|" + c.y + "|" + d.y;
}` },
  // 累加器原地追加的边界：只有「函数末尾纯返回」才可原地追加；
  // 别名/自拼接/循环内提前 return/多 return 分支必须走复制（否则改到别处引用或已返回的缓冲区）。
  { name: "str-acc-alias", fn: "f", ts: `export function f(): any {
  let s = "a"; const a = s; s = s + "b";
  return a + "|" + s;
}` },
  { name: "str-acc-selfconcat", fn: "f", ts: `export function f(): any {
  let s = "x"; s = s + s; s = s + s;
  return s;
}` },
  { name: "str-acc-early-return", fn: "f", ts: `export function f(n: any): any {
  let s = "";
  for (let i = 0; i < n; i++) { s = s + i; if (i > 3) return s; }
  return s + "!";
}` },
  { name: "str-acc-two-returns", fn: "f", ts: `export function f(n: any): any {
  let s = "0";
  if (n > 0) { s = s + "a"; return s; }
  s = s + "b"; return s;
}` },
  { name: "str-acc-nested-loop", fn: "f", ts: `export function f(): any {
  let s = "p";
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) s = s + i + j;
  return s;
}` },
  { name: "str-acc-array-push", fn: "f", ts: `export function f(): any {
  const out: any = []; let s = "z";
  for (let i = 0; i < 4; i++) { s = s + i; out.push(s); }
  return out.join(",");
}` },
  { name: "str-acc-long-tail", fn: "f", ts: `export function f(n: any): any {
  let s = "0";
  for (let i = 0; i < n; i++) s = s + i;
  return s;
}` },
  // 循环 arena 回滚的安全边界：不安全（对象逃逸出迭代）时绝不能复位 bump，
  // 否则后续迭代会覆盖仍被引用的对象 → 悬空/串值。
  { name: "loop-alloc-escape-array", fn: "f", ts: `export function f(): any {
  const keep: any = [];
  for (let i = 0; i < 5; i++) { const r = { id: i, sq: i * i }; keep.push(r); }
  return keep.map((x: any) => x.id + ":" + x.sq).join(",");
}` },
  { name: "loop-alloc-escape-var", fn: "f", ts: `export function f(): any {
  let last: any = null;
  for (let i = 0; i < 5; i++) { const r = { id: i }; last = r; }
  return last.id;
}` },
  { name: "loop-alloc-escape-return", fn: "f", ts: `export function f(): any {
  for (let i = 0; i < 5; i++) { const r = { id: i }; if (i === 3) return r; }
  return null;
}` },
  { name: "loop-alloc-escape-closure", fn: "f", ts: `export function f(): any {
  const fns: any = [];
  for (let i = 0; i < 5; i++) { const r = { id: i }; fns.push(() => r.id); }
  return fns[3]().toString();
}` },
  { name: "loop-alloc-safe-scalar", fn: "f", ts: `export function f(): any {
  let t = 0;
  for (let i = 0; i < 5; i++) { const r = { id: i, sq: i * i }; t = t + r.id + r.sq; }
  return t;
}` },
  { name: "loop-alloc-safe-nested", fn: "f", ts: `export function f(): any {
  let t = 0;
  for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { const r = { v: i * j }; t = t + r.v; } }
  return t;
}` },
  // while / do-while 与 for 同享循环级 arena 回滚（三形态都必须触发，否则等价写法行为不一致）。
  { name: "loop-alloc-while-safe", fn: "f", ts: `export function f(): any {
  let t = 0, i = 0;
  while (i < 5) { const r = { id: i, sq: i * i }; t = t + r.id + r.sq; i = i + 1; }
  return t;
}` },
  { name: "loop-alloc-do-safe", fn: "f", ts: `export function f(): any {
  let t = 0, i = 0;
  do { const r = { id: i, sq: i * i }; t = t + r.id + r.sq; i = i + 1; } while (i < 5);
  return t;
}` },
  { name: "loop-alloc-while-escape", fn: "f", ts: `export function f(): any {
  const keep: any = []; let i = 0;
  while (i < 5) { const r = { id: i }; keep.push(r); i = i + 1; }
  return keep.map((x: any) => x.id).join(",");
}` },
  // 判定边界的「保守拒绝」：这些场景对象可能被外部持有，必须不复位。
  { name: "loop-alloc-host-call", fn: "f", ts: `export function f(): any {
  let t = 0;
  for (let i = 0; i < 5; i++) { const r = { id: i }; t = t + JSON.stringify(r).length; }
  return t;
}` },
  { name: "loop-alloc-try-inside", fn: "f", ts: `export function f(): any {
  let t = 0;
  for (let i = 0; i < 5; i++) { const r = { id: i }; try { t = t + r.id; } catch (e) { t = t + 1000; } }
  return t;
}` },
  { name: "loop-alloc-field-self-assign", fn: "f", ts: `export function f(): any {
  let t = 0;
  for (let i = 0; i < 5; i++) { const r = { id: i }; r.id = r.id * 2; t = t + r.id; }
  return t;
}` },
  { name: "loop-alloc-nested-escape", fn: "f", ts: `export function f(): any {
  const keep: any = [];
  for (let i = 0; i < 3; i++) { const r = { id: i }; for (let j = 0; j < 2; j++) { const q = { v: j }; keep.push(q); } }
  return keep.length + keep[5].v;
}` },
  // 函数级 arena 回滚：函数内造临时对象、只读字段、返回标量 → 返回前复位 bump。
  // 关键前提是返回类型标注为标量（编译期可证返回值不是句柄）。
  { name: "fn-alloc-numeric-ret", fn: "f", ts: `export function f(): any {
  let t = 0;
  for (let i = 0; i < 5; i++) t = t + mk(i);
  return t;
}
function mk(a: number): number { const p = { x: a, sq: a * a }; return p.x + p.sq; }` },
  { name: "fn-alloc-readonly-fields", fn: "f", ts: `export function f(): any {
  let t = 0;
  for (let i = 0; i < 5; i++) t = t + g(i);
  return t;
}
function g(a: number): number { const p = { v: a, w: a + 1 }; const q = { z: p.v }; return q.z + p.w; }` },
  // 保守拒绝：返回类型是 any（可能是对象句柄）→ 绝不复位。
  { name: "fn-alloc-any-ret-reject", fn: "f", ts: `export function f(): any {
  const o = h(3);
  return o.v;
}
function h(a: number): any { const p = { v: a }; return p; }` },
  // 保守拒绝：返回对象本身 → 句柄逃出，复位会悬空。
  { name: "fn-alloc-obj-ret-reject", fn: "f", ts: `export function f(): any {
  const o = k(4);
  return o.v + o.w;
}
function k(a: number): any { const p = { v: a, w: a + 1 }; return p; }` },
  // 保守拒绝：函数内有 new → 构造分配逃逸性不可证。
  { name: "fn-alloc-new-reject", fn: "f", ts: `export function f(): any {
  const a = n(2);
  return a.v;
}
class Box { v: number = 7; w: number = 1; }
function n(a: number): any { const b = new Box(); return b; }` },

];
