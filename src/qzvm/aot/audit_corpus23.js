// 差分审计语料（第二十三批）：新数组方法 / fromEntries / 迭代期间修改 / getter 抛错 / 原型遮蔽 / delete 与稀疏 / 深可选链。
module.exports = [
  { name: "array-new-methods", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [1, 2, 3, 4, 5];
  out.push(a.at(-1), a.at(0), a.at(9) === undefined ? 1 : 0);
  out.push(a.findLast ? a.findLast((x: any) => x % 2 === 1) : "na");
  out.push(a.findLastIndex ? a.findLastIndex((x: any) => x > 2) : "na");
  out.push(a.toReversed ? JSON.stringify(a.toReversed()) : "na", JSON.stringify(a));
  out.push(a.toSorted ? JSON.stringify(a.toSorted((x: any, y: any) => y - x)) : "na");
  out.push(a.toSpliced ? JSON.stringify(a.toSpliced(1, 2, 9)) : "na");
  out.push(a.with ? JSON.stringify(a.with(0, 7)) : "na", JSON.stringify(a));
  return out.join("|");
}` },
  { name: "from-entries-iterables", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const e: any = [["a", 1], ["b", 2]];
  out.push(JSON.stringify(Object.fromEntries(e)));
  const m: any = new Map([["x", 10], ["y", 20]]);
  out.push(JSON.stringify(Object.fromEntries(m)));
  const gen: any = [[1, "one"], [2, "two"]];
  out.push(JSON.stringify(Object.fromEntries(gen)));
  const arr: any = [["k", undefined]];
  const r: any = Object.fromEntries(arr);
  out.push("k" in r ? 1 : 0, JSON.stringify(r));
  return out.join("|");
}` },
  { name: "map-mutate-during-iter", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const m: any = new Map([["a", 1], ["b", 2], ["c", 3]]);
  const seen: any = [];
  for (const [k, v] of m) { seen.push(k); if (k === "b") m.delete("c"); }
  out.push(seen.join(""), m.size);
  const s: any = new Set([1, 2, 3, 4]);
  const sv: any = [];
  for (const x of s) { sv.push(x); if (x === 2) s.add(5); }
  out.push(sv.join(","), s.size);
  m.set("d", 4);
  out.push(m.size, JSON.stringify([...m.keys()].join("")));
  return out.join("|");
}` },
  { name: "getter-throw-propagation", fn: "f", ts: `class Risk { get boom(): any { throw new Error("bang"); } }
export function f(): any {
  const out: any = [];
  const r = new Risk();
  try { const x = r.boom; out.push("no:" + x); }
  catch (e: any) { out.push("caught:" + e.message); }
  const o: any = { get v() { throw "str-err"; } };
  try { const y = o.v; out.push("no:" + y); }
  catch (e: any) { out.push("caught2:" + String(e)); }
  try { const z = JSON.stringify(r); out.push("no:" + z); }
  catch (e: any) { out.push("caught3:" + e.message); }
  out.push(Object.keys(r).length);
  return out.join("|");
}` },
  { name: "proto-shadowing", fn: "f", ts: `class Base { m(): any { return "base"; } n: any = 1; get g(): any { return "bg"; } }
class Sub extends Base { m(): any { return "sub"; } n: any = 2; get g(): any { return "sg"; } has(): any { return this.m() + "|" + this.n + "|" + this.g; } }
const o: any = { m() { return "lit"; }, n: 3 };
export function f(): any {
  const out: any = [];
  out.push(new Sub().has(), new Base().m());
  out.push(new Sub().m(), new Sub().n, new Sub().g);
  const inSub: any = new Sub();
  out.push("m" in inSub ? 1 : 0, Object.keys(inSub).join(","));
  out.push((o as any).m(), o.n);
  return out.join("|");
}` },
  { name: "delete-sparse-length", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [1, 2, 3, 4];
  delete a[1];
  out.push(a.length, a[1] === undefined ? 1 : 0, JSON.stringify(a));
  out.push(a.join("-"), a.indexOf(undefined), a.includes ? a.includes(undefined) ? 1 : 0 : "na");
  const keys: any = [];
  for (const k in a) keys.push(k);
  out.push(keys.join(","), a.map((x: any) => x === undefined ? "u" : "v").join(""));
  const b: any = [1, 2, 3];
  delete b[1];
  b[5] = 6;
  out.push(b.length, b[2], JSON.stringify([...b]));
  return out.join("|");
}` },
  { name: "deep-optional-nullish", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const cfg: any = { a: { b: { c: { d: "deep" } } } };
  out.push(cfg?.a?.b?.c?.d, cfg?.x?.y?.z?.w ?? "def", cfg?.a?.b?.z ?? "zz");
  out.push(cfg?.a?.b?.c?.d?.length);
  const arr: any = [{ v: 1 }, null, { v: 3 }];
  out.push(arr?.[0]?.v, arr?.[1]?.v ?? "u", arr?.[2]?.v);
  const fn: any = { f: (x: any) => x * 2 };
  out.push(fn?.f?.(21), fn?.g?.(1) ?? "ng");
  const nested: any = { m: { n: null } };
  out.push(nested?.m?.n?.o ?? "deep-null", nested?.m?.o?.p ?? "mid-null");
  return out.join("|");
}` },
  { name: "math-and-strings-mixed", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(1 + "2", "2" + 1, 1 + 2 + "3", "1" + 2 + 3);
  out.push("5" - 2, "5" * 2, "10" / "2", "10" % "3");
  out.push("a" + 1 + 2, "" + [1, 2], [] + 1);
  out.push(+"7", -"3", +true, +false, -null);
  out.push("5" > "20" ? 1 : 0, 5 > "20" ? 1 : 0);
  out.push(+"", +"  ", +"0x10", +"1e2");
  return out.join("|");
}` },
  { name: "tagged-raw-eval-order", fn: "f", ts: `let log: any = "";
function tag(strings: any, ...vs: any[]): any {
  log += "S" + strings.length;
  return strings.map((s: any, i: any) => s + (i < vs.length ? "[" + vs[i] + "]" : "")).join("");
}
function side(v: any): any { log += "." + v; return v; }
export function f(): any {
  const out: any = [];
  log = "";
  out.push(tag\`a\${side(1)}b\${side(2)}c\`, log);
  log = "";
  const t1: any = \`\${side("x")}\${side("y")}\`;
  out.push(t1, log);
  log = "";
  out.push(String.raw\`p\${side(3)}q\`, log);
  return out.join("|");
}` },
  { name: "json-formatting-details", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: [1, 2], c: { d: null } };
  out.push(JSON.stringify(o, null, 4).split("\\n").length);
  out.push(JSON.stringify(o, null, 1).split("\\n").length);
  out.push(JSON.stringify(o, null, 0));
  out.push(JSON.stringify(o, null, "\t").split("\\n").length);
  out.push(JSON.stringify([1, 2, 3], null, 2).split("\\n").length);
  out.push(JSON.stringify("a\\nb", null, 0), JSON.stringify(12345, null, 0));
  return out.join("|");
}` },
  { name: "instanceof-edges", fn: "f", ts: `class A {} class B extends A {}
export function f(): any {
  const out: any = [];
  out.push(new B() instanceof A ? 1 : 0, new A() instanceof B ? 1 : 0);
  out.push(new A() instanceof A ? 1 : 0, new B() instanceof Object ? 1 : 0);
  out.push([] instanceof Array ? 1 : 0, [] instanceof Object ? 1 : 0, [] instanceof A ? 1 : 0);
  out.push({} instanceof Object ? 1 : 0, null instanceof A ? 0 : 1, undefined instanceof A ? 0 : 1);
  out.push(5 instanceof Object ? 1 : 0, "" instanceof Object ? 1 : 0);
  return out.join("|");
}` },
  { name: "switch-expr-cases", fn: "f", ts: `const K: any = 10;
export function f(x: any): any {
  let r = "";
  switch (x) {
    case K + 5: r = "a"; break;
    case "s".length + 2: r = "b"; break;
    case 2 ** 4: r = "c"; break;
    default: r = "d";
  }
  switch (x) {
    case 1:
    case 2:
      r += "|low";
      break;
    case 3 > 2 ? 3 : 0:
      r += "|three";
      break;
  }
  return r;
}`, args: [15] },
  { name: "object-create-variants", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const nullProto: any = Object.create(null);
  nullProto.a = 1;
  out.push(nullProto.a, Object.getPrototypeOf(nullProto) === null ? 1 : 0, Object.keys(nullProto).join(","));
  const withProps: any = Object.create({}, { p: { value: 42, enumerable: true } });
  out.push(withProps.p, withProps.hasOwnProperty("p") ? 1 : 0, "p" in withProps ? 1 : 0);
  const proto2: any = { m() { return "P"; } };
  const child2: any = Object.create(proto2);
  child2.m = () => "C";
  out.push(child2.m(), proto2.m());
  return out.join("|");
}` },
  { name: "number-methods-matrix", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push((255).toString(16), (255).toString(2), (10).toString(8), (10).toString(36));
  out.push((1.5).toString(), (-0).toString(), (1e21).toString(), (1e-7).toString());
  out.push((3.14159).toPrecision(3), (0.000123).toPrecision(2), (123456).toPrecision(1));
  out.push((2.5).toExponential(1), (255).toExponential(0));
  out.push(Number.EPSILON > 0 ? 1 : 0, Number.MAX_VALUE > 1e308 ? 1 : 0, Number.MIN_VALUE > 0 ? 1 : 0);
  return out.join("|");
}` },
  { name: "while-complex-compound", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let i = 0, acc = "";
  while ((i += 2) < 10) { acc += i; if (i === 4) continue; if (i === 8) break; }
  out.push(acc, i);
  let n = 100;
  const terms: any = [];
  while (n > 0) { terms.push(n % 7); n = Math.floor(n / 7); }
  out.push(terms.join(","));
  let m = 1;
  let r = 0;
  while (m < 1000) { r += m; m *= 3; }
  out.push(r, m);
  return out.join("|");
}` },
  { name: "close-over-loop-let-var", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const fns: any = [];
  for (let i = 0; i < 3; i++) { const k = i * 10; fns.push({ g: () => k + i }); }
  out.push(fns.map((fn: any) => fn.g()).join(","));
  const hf: any = [];
  for (var j = 0; j < 3; j++) hf.push(() => j);
  out.push(hf.map((h: any) => h()).join(","));
  let sum = 0;
  for (let a2 of [1, 2], [3, 4]) { for (const b2 of a2) sum += b2; }
  out.push(sum);
  const fs2: any = [];
  for (const v of [5, 6]) { fs2.push(() => v + 1); }
  out.push(fs2.map((g2: any) => g2()).join(","));
  return out.join("|");
}` },
  { name: "nested-spread-mutation", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const base: any = { list: [1, 2, 3], child: { x: 1 } };
  const copy1: any = { list: [...base.list], child: { ...base.child } };
  copy1.list.push(4);
  copy1.child.x = 99;
  out.push(JSON.stringify(base), JSON.stringify(copy1));
  const arr1: any = [1, [2, 3], 4];
  const arr2: any = [...arr1];
  arr2[1][0] = 9;
  out.push(JSON.stringify(arr1), JSON.stringify(arr2));
  const deep: any = JSON.parse(JSON.stringify({ a: [{ b: 1 }] }));
  deep.a[0].b = 5;
  out.push(JSON.stringify(deep));
  return out.join("|");
}` },
  { name: "string-escapes-raw", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("a\\tb".length, "a\\nb".split("\\n").length, "\\u0041\\u00e9", "\\x41\\x42");
  out.push("\\u{1F600}".length, ("\\uD83D\\uDE00").length);
  out.push(String.raw\`a\\tb\`.length, \`a\\tb\`.length);
  out.push("\\\"".length, "\\\\".length, "\\'".length);
  out.push("line\\\ncont".length, "0\\n1\\n2".split("\\n").length);
  return out.join("|");
}` },
  { name: "closure-capture-mutable-cell", fn: "f", ts: `function makeTracker(): any {
  const state: any = { count: 0, history: [] };
  return {
    tick(v: any): any { state.count += v; state.history.push(state.count); return state.count; },
    get n(): any { return state.count; },
    get hist(): any { return state.history.join(","); }
  };
}
export function f(): any {
  const out: any = [];
  const t = makeTracker();
  out.push(t.tick(1), t.tick(2), t.n, t.hist);
  const clone: any = makeTracker();
  out.push(clone.n, clone.tick(5), t.n);
  const dec: any = { v: 10, down(): any { this.v--; return this.v; } };
  out.push(dec.down(), dec.down(), dec.v);
  return out.join("|");
}` },
  { name: "class-static-getter-inherit", fn: "f", ts: `class P { static m(): any { return "P"; } static get tag(): any { return "PT"; } }
class Q extends P { static m(): any { return "Q" + super.m(); } static get tag(): any { return "QT"; } }
export function f(): any {
  const out: any = [];
  out.push(P.m(), Q.m(), P.tag, Q.tag);
  out.push(new Q() instanceof P ? 1 : 0);
  const typed: any[] = [];
  typed.push(P, Q);
  out.push(typed.length);
  return out.join("|");
}` },
];