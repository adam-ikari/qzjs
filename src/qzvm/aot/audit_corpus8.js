// 差分审计语料（第八批）：Date / JSON / String 深水 / Array 扩展 / Object.freeze / Error 子类 / 数字边界。
module.exports = [
  // ---------- Date ----------
  { name: "date-epoch", fn: "f", ts: `export function f(): any {
  const d = new Date(0);
  const out: any = [];
  out.push(d.getTime());
  out.push(d.toISOString());
  out.push(typeof d);
  out.push(d instanceof Date ? 1 : 0);
  out.push(new Date("2020-01-01T00:00:00.000Z").getTime());
  out.push(new Date(1609459200000).toISOString());
  out.push(new Date(NaN).getTime());
  return out.join("|");
}` },
  { name: "date-methods", fn: "f", ts: `export function f(): any {
  const d = new Date(1609459200000);
  const out: any = [];
  out.push(d.getFullYear());
  out.push(d.getMonth());
  out.push(d.getDate());
  out.push(d.getUTCHours());
  out.push(d.getUTCMinutes());
  out.push(d.getUTCSeconds());
  out.push(d.getUTCDay());
  out.push(d.setFullYear(2021) > 0 ? 1 : 0);
  out.push(d.getFullYear());
  return out.join("|");
}` },
  { name: "date-static", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Date.now() > 0 ? 1 : 0);
  out.push(Date.parse("2020-01-01T00:00:00.000Z"));
  out.push(Date.UTC(2020, 0, 1));
  out.push(typeof Date.now());
  return out.join("|");
}` },
  // ---------- JSON 深水 ----------
  { name: "json-circular", fn: "f", ts: `export function f(): any {
  const o: any = {};
  o.self = o;
  try { JSON.stringify(o); return "threw-expected"; }
  catch (e: any) { return "caught:" + (e instanceof TypeError ? 1 : 0); }
}` },
  { name: "json-indent", fn: "f", ts: `export function f(): any {
  const o: any = { b: [1, 2], a: { x: 1 } };
  const s2 = JSON.stringify(o, null, 2);
  const s0 = JSON.stringify(o, null, 0);
  const st = JSON.stringify(o, null, "\\t");
  const out: any = [];
  out.push(s2.includes("\\n") ? 1 : 0);
  out.push(s2.split("\\n").length);
  out.push(s0.includes("\\n") ? 1 : 0);
  out.push(st.includes("\\t") ? 1 : 0);
  out.push(JSON.stringify(o, null, "  ").split("\\n").length);
  return out.join("|");
}` },
  { name: "json-tostring-tag", fn: "f", ts: `export function f(): any {
  const o: any = { [Symbol.toStringTag]: "Foo", x: 1 };
  const out: any = [];
  out.push(JSON.stringify(o) === JSON.stringify({ x: 1 }) ? 1 : 0);
  out.push(Object.prototype.toString.call(o));
  return out.join("|");
}` },
  // ---------- String 深水 ----------
  { name: "str-pad-start-end", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("5".padStart(3, "0"));
  out.push("5".padStart(2));
  out.push("abc".padEnd(6, "xy"));
  out.push("".padStart(3, "0"));
  out.push("x".padStart(0));
  out.push("abcdef".padStart(3));
  return out.join("|");
}` },
  { name: "str-repeat", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("ab".repeat(3));
  out.push("".repeat(5));
  out.push("x".repeat(0));
  try { "x".repeat(-1); } catch (e: any) { out.push("err:" + (e instanceof RangeError ? 1 : 0)); }
  try { "x".repeat(Infinity); } catch (e: any) { out.push("err:" + (e instanceof RangeError ? 1 : 0)); }
  return out.join("|");
}` },
  { name: "str-match-all", fn: "f", ts: `export function f(): any {
  const s = "a1b2c3";
  const out: any = [];
  const m = s.matchAll(/([a-z])(\\d)/g);
  const arr: any = [];
  for (const match of m) arr.push(match[1] + match[2]);
  out.push(arr.join(","));
  out.push([...s.matchAll(/\\d/g)].length);
  out.push([...s.matchAll(/x/g)].length);
  return out.join("|");
}` },
  { name: "str-at-neg", fn: "f", ts: `export function f(): any {
  const s = "hello";
  const out: any = [];
  out.push(s.at(0), s.at(-1), s.at(-2), s.at(10));
  out.push(s.charAt(1), s.charCodeAt(0));
  out.push(s.codePointAt(0));
  out.push(s.indexOf("l"), s.lastIndexOf("l"));
  out.push(s.includes("ell"));
  out.push(s.startsWith("he"), s.endsWith("lo"));
  return out.join("|");
}` },
  { name: "str-split-limit-regex", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("a,b,c".split(",").join("-"));
  out.push("a,b,c".split(",", 2).join("-"));
  out.push("a1b2c3".split(/\\d/).join("-"));
  out.push("a1b2c3".split(/(\\d)/).join("-"));
  out.push("".split(",").length);
  out.push("abc".split("").join("-"));
  out.push("abc".split("", 2).join("-"));
  return out.join("|");
}` },
  // ---------- Array 扩展 ----------
  { name: "arr-flat-flatmap", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push([1, [2, [3]]].flat().join(","));
  out.push([1, [2, [3]]].flat(2).join(","));
  out.push([1, [2, [3]]].flat(Infinity).join(","));
  out.push([1, 2, 3].flatMap((x: any) => [x, x * 2]).join(","));
  out.push([1, [2], 3].flatMap((x: any) => x).join(","));
  out.push([[1, 2], [3, 4]].flat().join(","));
  return out.join("|");
}` },
  { name: "arr-at-copywithin", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [1, 2, 3, 4, 5];
  out.push(a.at(0), a.at(-1), a.at(-2));
  out.push([1, 2, 3].at(10));
  const b: any = [1, 2, 3, 4, 5];
  b.copyWithin(0, 3);
  out.push(b.join(","));
  const c: any = [1, 2, 3, 4, 5];
  c.copyWithin(0, 1, 3);
  out.push(c.join(","));
  return out.join("|");
}` },
  { name: "arr-slice-splice", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [1, 2, 3, 4, 5];
  out.push(a.slice(1, 3).join(","));
  out.push(a.slice(-2).join(","));
  out.push(a.slice().join(","));
  out.push(a.slice(1, -1).join(","));
  const b: any = [1, 2, 3, 4, 5];
  const r = b.splice(1, 2);
  out.push(r.join(","), b.join(","));
  const c: any = [1, 2, 3];
  c.splice(1, 0, 9, 10);
  out.push(c.join(","));
  return out.join("|");
}` },
  { name: "arr-reduce-reduceright", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push([1, 2, 3, 4].reduce((a: any, b: any) => a + b));
  out.push([1, 2, 3, 4].reduce((a: any, b: any) => a + b, 10));
  out.push([1, 2, 3, 4].reduceRight((a: any, b: any) => a + b));
  out.push([1, 2, 3, 4].reduceRight((a: any, b: any) => "" + a + b));
  out.push(["a", "b", "c"].reduce((a: any, b: any) => a + b, ""));
  try { [].reduce((a: any, b: any) => a + b); }
  catch (e: any) { out.push("err:" + (e instanceof TypeError ? 1 : 0)); }
  out.push([5].reduce((a: any, b: any) => a + b));
  out.push([].reduce((a: any, b: any) => a + b, 42));
  return out.join("|");
}` },
  { name: "arr-sort-compare", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push([3, 1, 2].sort().join(","));
  out.push([3, 1, 2].sort((a: any, b: any) => a - b).join(","));
  out.push([3, 1, 2].sort((a: any, b: any) => b - a).join(","));
  out.push([10, 2, 1, 20].sort().join(","));
  out.push([10, 2, 1, 20].sort((a: any, b: any) => a - b).join(","));
  out.push(["c", "a", "b"].sort().join(","));
  out.push(["banana", "apple", "cherry"].sort().join(","));
  return out.join("|");
}` },
  // ---------- Object.freeze / seal ----------
  { name: "obj-freeze-seal", fn: "f", ts: `export function f(): any {
  const o: any = { x: 1 };
  Object.freeze(o);
  o.x = 2;
  o.y = 3;
  const out: any = [];
  out.push(o.x, o.y === undefined ? 1 : 0);
  out.push(Object.isFrozen(o) ? 1 : 0);
  const s2: any = { a: 1 };
  Object.seal(s2);
  s2.a = 2; s2.b = 3;
  out.push(s2.a, s2.b === undefined ? 1 : 0);
  out.push(Object.isSealed(s2) ? 1 : 0);
  out.push(Object.isFrozen({}) ? 0 : 1);
  return out.join("|");
}` },
  // ---------- Error 子类 ----------
  { name: "error-subclass-fields", fn: "f", ts: `class MyErr extends Error {
  code: any;
  constructor(msg: any, code: any) { super(msg); this.name = "MyErr"; this.code = code; }
}
export function f(): any {
  const out: any = [];
  const e = new MyErr("boom", 42);
  out.push(e.message);
  out.push(e.code);
  out.push(e.name);
  out.push(e instanceof Error ? 1 : 0);
  out.push(e instanceof MyErr ? 1 : 0);
  out.push(e.stack ? 1 : 0);
  try { throw e; }
  catch (c: any) { out.push(c.code); }
  return out.join("|");
}` },
  { name: "error-without-new", fn: "f", ts: `export function f(): any {
  const e = Error("plain");
  const e2 = Error(123);
  const out: any = [];
  out.push(e.message);
  out.push(e2.message);
  out.push(e instanceof Error ? 1 : 0);
  out.push(typeof e.stack);
  return out.join("|");
}` },
  // ---------- Number 边界 ----------
  { name: "num-tostring-radix", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push((255).toString(16));
  out.push((255).toString(2));
  out.push((0).toString(16));
  out.push((-255).toString(16));
  out.push((3.5).toString());
  out.push((1.5e-6).toString());
  out.push((100000000000000000000).toString());
  out.push(Number(0).toString());
  out.push((NaN).toString());
  return out.join("|");
}` },
  { name: "num-tofixed-toprecision", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push((3.14159).toFixed(2));
  out.push((3.14159).toFixed(0));
  out.push((255).toPrecision(2));
  out.push((255).toPrecision(5));
  out.push((0.1).toFixed(1));
  out.push((1).toFixed(2));
  out.push((-3.14).toFixed(1));
  out.push((123456789).toExponential(2));
  return out.join("|");
}` },
  { name: "num-parse-int-float", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(parseInt("123"));
  out.push(parseInt("0xff", 16));
  out.push(parseInt("0xff"));
  out.push(parseInt("11", 2));
  out.push(parseInt("99", 8));
  out.push(parseInt("abc"));
  out.push(parseInt(" 42 "));
  out.push(parseInt("3.14"));
  out.push(parseFloat("3.14abc"));
  out.push(parseFloat("  1e3  "));
  out.push(parseFloat(".5"));
  out.push(parseFloat("abc"));
  out.push(Number("0x10"));
  out.push(Number(""));
  out.push(Number("  "));
  out.push(Number(null));
  out.push(Number([]));
  out.push(Number([5]));
  out.push(Number([1, 2]));
  return out.join("|");
}` },
  // ---------- for-in 行为 ----------
  { name: "for-in-shadow-prototo", fn: "f", ts: `class Base { x: any = 1; }
class Derived extends Base { x: any = 2; y: any = 3; }
export function f(): any {
  const d = new Derived();
  const keys: any = [];
  for (const k in d) keys.push(k);
  const out: any = [];
  out.push(keys.join(","));
  const pojo: any = { a: 1, b: 2 };
  const owned = Object.keys(pojo);
  out.push(owned.join(","));
  const o2: any = {};
  o2.c = 3;
  out.push(Object.keys(o2).join(","));
  return out.join("|");
}` },
  { name: "obj-entries-values-fromEntries", fn: "f", ts: `export function f(): any {
  const o: any = { a: 1, b: 2, c: 3 };
  const out: any = [];
  out.push(Object.keys(o).join(","));
  out.push(Object.values(o).join(","));
  out.push(Object.entries(o).map((e: any) => e.join("=")).join(","));
  const o2: any = Object.fromEntries([["x", 10], ["y", 20]]);
  out.push(Object.keys(o2).join(","));
  out.push(o2.x, o2.y);
  const arr: any = [[1, "a"], [2, "b"]];
  out.push(Object.fromEntries(arr).size || Object.keys(Object.fromEntries(arr)).length);
  return out.join("|");
}` },
];
