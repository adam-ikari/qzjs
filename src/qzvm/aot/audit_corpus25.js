// 差分审计语料（第二十五批）：Math 扩展 / 数字判型 / 正则 lastIndex / split 捕获组 / 展开字符串与 Set / 整数键对象 / 稀疏数组方法。
module.exports = [
  { name: "math-extra-functions", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Math.imul ? Math.imul(3, 7) : "na", Math.imul ? Math.imul(-3, 7) : "na");
  out.push(Math.clz32 ? Math.clz32(1) : "na", Math.clz32 ? Math.clz32(0) : "na", Math.clz32 ? Math.clz32(0x80000000) : "na");
  out.push(Math.fround ? Math.fround(0.1) : "na");
  out.push(Math.sign(-0), Math.sign(0), Math.sign("3"), Math.sign(-Infinity));
  out.push(Math.trunc(0.9), Math.trunc(-0.9), Math.trunc(NaN), Math.trunc(Infinity));
  out.push(Math.exp(1) > 2.7 ? 1 : 0, Math.log(1), Math.log10(1000), Math.log2(1024), Math.cbrt(8));
  return out.join("|");
}` },
  { name: "number-type-predicates", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Number.isInteger(3) ? 1 : 0, Number.isInteger(3.5) ? 1 : 0, Number.isInteger(-3) ? 1 : 0, Number.isInteger(NaN) ? 1 : 0);
  out.push(Number.isNaN(NaN) ? 1 : 0, Number.isNaN("x") ? 1 : 0, Number.isNaN("NaN") ? 1 : 0);
  out.push(isNaN("x") ? 1 : 0, isNaN("3") ? 1 : 0, isNaN("") ? 1 : 0);
  out.push(Number.isFinite(3) ? 1 : 0, Number.isFinite(Infinity) ? 1 : 0, isFinite("3") ? 1 : 0, isFinite("x") ? 1 : 0);
  out.push(Number.isSafeInteger(9007199254740991) ? 1 : 0, Number.isSafeInteger(9007199254740992) ? 1 : 0);
  out.push(Number.isInteger(1e100) ? 1 : 0);
  return out.join("|");
}` },
  { name: "regex-lastindex-explicit", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const re: any = /ab/g;
  out.push(re.exec("abab")[0]);
  re.lastIndex = 2;
  out.push(re.exec("abab")[0], re.lastIndex);
  out.push(re.test("ab") ? 1 : 0, re.lastIndex);
  out.push(re.test("ab") ? 1 : 0, re.lastIndex);
  const r2: any = /a/g;
  r2.lastIndex = 100;
  out.push(r2.exec("a") === null ? 1 : 0);
  const r3: any = /(\\d+)(\\w)/;
  const m: any = "x12y".match(r3);
  out.push(m[0], m[1], m[2], m.index);
  return out.join("|");
}` },
  { name: "split-capture-groups", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("a1b2c".split(/(\\d)/).join("|"));
  out.push("a1b2c".split(/(\\d)/).length);
  out.push("a1b2c".split(/(\\d+)/).join("|"));
  out.push("hello world".split(" ").join(","));
  out.push("a-b-c".split("-", 2).join(","));
  out.push("ab".split("").length, "".split(",").length, ",".split(",").length);
  out.push("1,2,,3".split(",").map((x: any) => x === "" ? "E" : x).join("|"));
  return out.join("|");
}` },
  { name: "spread-string-set", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push([... "abc"].join(""), [..."a🙂b"].length);
  out.push([...new Set([1, 2, 2, 3])].join(","));
  out.push(JSON.stringify({ ...new Set([5, 6]) }));
  out.push([...new Map([["a", 1], ["b", 2]])].map((e: any) => e.join(":")).join(","));
  out.push(JSON.stringify({ ..."xy" }));
  const s: any = new Set([1, 2, 3]);
  out.push([...s, 4].join(","));
  return out.join("|");
}` },
  { name: "integer-keyed-order", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { b: 1, 2: "two", a: 2, 1: "one", 10: "ten", 0: "zero" };
  out.push(Object.keys(o).join(","));
  out.push(JSON.stringify(o));
  const arr: any = ["x", "y"];
  arr[3] = "z";
  out.push(Object.keys(arr).join(","), JSON.stringify(arr));
  const o2: any = { 3: "c", 1: "a", 2: "b" };
  out.push(Object.keys(o2).join(","), JSON.stringify(o2));
  return out.join("|");
}` },
  { name: "sparse-methods", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [1, , 3, , 5];
  out.push(a.length, a.join("-"), a.map((x: any) => x === undefined ? "u" : x).join(""));
  out.push(a.filter((x: any) => x !== undefined).length);
  out.push(a.reduce((acc: any, x: any) => acc + (x === undefined ? 0 : x), 0));
  out.push(a.every((x: any) => x !== undefined) ? 1 : 0, a.some((x: any) => x === 5) ? 1 : 0);
  out.push(a.indexOf(undefined), a.lastIndexOf(undefined));
  out.push(Array.prototype.indexOf.call(a, undefined), a.find((x: any) => x === 5));
  const b: any = new Array(4);
  out.push(b.length, b.map((x: any) => 1).join("").length, b.fill ? b.fill(7).join(",") : "na");
  return out.join("|");
}` },
  { name: "concat-and-spread-mix", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push([1].concat(2, [3], [4, 5]).join(","));
  out.push([1, 2].concat([], "a").join(","));
  const nested: any = [[1], [2]];
  out.push(JSON.stringify(nested.concat([3])));
  out.push([...[1, 2], 3, ...[4]].join(""));
  out.push(Array.prototype.concat.call([1], 2).join(""));
  const arrLike: any = { length: 2, 0: "a", 1: "b" };
  out.push([].concat(arrLike as any).length);
  return out.join("|");
}` },
  { name: "switch-let-scope", fn: "f", ts: `export function f(x: any): any {
  let out = "";
  switch (x) {
    case 1: { let v = "one"; out += v; break; }
    case 2: { let v = "two"; out += v; break; }
    default: { let v = "d"; out += v; }
  }
  const vals: any = [];
  for (let i = 0; i < 3; i++) { const tag = "t" + i; vals.push(tag); }
  out += "|" + vals.join(",");
  return out;
}`, args: [2] },
  { name: "for-comma-and-nested-ternary", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let acc = "";
  for (let i = 0, j = 9; i < j; i++, j--) acc += i + ":" + j + " ";
  out.push(acc.trim());
  const g = (v: any) => v > 0 ? "p" : v < 0 ? "n" : "z";
  out.push(g(5), g(-5), g(0), g(NaN) === "z" ? 1 : 0);
  out.push((1 ? 2 ? "a" : "b" : "c"));
  const list: any = [1, 2, 3, 4];
  out.push(list.map((v: any, i: any) => i % 2 ? v * 10 : v).join(","));
  return out.join("|");
}` },
  { name: "object-is-vs-strict", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Object.is(NaN, NaN) ? 1 : 0, NaN === NaN ? 1 : 0);
  out.push(Object.is(0, -0) ? 1 : 0, 0 === -0 ? 1 : 0);
  out.push(Object.is(-0, -0) ? 1 : 0);
  out.push(Object.is(1, 1) ? 1 : 0, Object.is("a", "a") ? 1 : 0);
  const o: any = {};
  out.push(Object.is(o, o) ? 1 : 0, Object.is(o, {}) ? 1 : 0);
  out.push(Object.is(null, null) ? 1 : 0, Object.is(undefined, null) ? 1 : 0);
  out.push(Object.is([], []) ? 1 : 0);
  return out.join("|");
}` },
  { name: "parse-float-int-exotic", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(parseInt("0x1A"), parseInt("0b101", 2), parseInt("010"), parseInt("-0x10"));
  out.push(parseFloat("3.14e2"), parseFloat("0x10"), parseFloat("Infinity"), parseFloat("-Infinity"));
  out.push(Number("0x1A"), Number("0b11"), Number("Infinity"), Number("-Infinity"), Number("0o17"));
  out.push(parseInt("  +12px"), parseInt("12.9"), parseFloat("12.9px"));
  out.push(parseInt("abc"), Number("abc"), parseFloat(""));
  return out.join("|");
}` },
  { name: "getter-returns-function-call", fn: "f", ts: `class C { _m: any = null; get m(): any { return () => "got:" + this._v(); } _v(): any { return 42; } }
const o: any = { _x: 5, get f(): any { return (a: any) => a * this._x; } };
export function f(): any {
  const out: any = [];
  const c = new C();
  out.push(c.m(), typeof c.m);
  out.push(o.f(3), o.f(4));
  const { f: getF } = o;
  out.push(getF(2));
  return out.join("|");
}` },
  { name: "throw-non-error", fn: "f", ts: `export function f(): any {
  const out: any = [];
  try { throw 42; } catch (e: any) { out.push(typeof e, e); }
  try { throw "str"; } catch (e: any) { out.push(e); }
  try { throw { code: 7, msg: "obj" }; } catch (e: any) { out.push(e.code, e.msg); }
  try { throw null; } catch (e: any) { out.push(e === null ? "null" : typeof e); }
  try { throw undefined; } catch (e: any) { out.push(e === undefined ? "undef" : typeof e); }
  try { throw [1, 2]; } catch (e: any) { out.push(e.length, e[0]); }
  return out.join("|");
}` },
  { name: "nested-obj-getter-chains", fn: "f", ts: `const data = {
  _n: 2,
  get double() { return { value: this._n * 2, get squared() { return this.value * this.value; } }; }
};
export function f(): any {
  const out: any = [];
  out.push(data.double.value, data.double.squared);
  const d = data.double;
  out.push(d.value, d.squared);
  const { double: { value } } = data;
  out.push(value);
  return out.join("|");
}` },
  { name: "array-from-string-iter", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Array.from("ab").join(","), Array.from("a🙂").length);
  out.push(Array.from({ length: 3 }).length, Array.from({ length: 2 }, (v: any, i: any) => i * 2).join(","));
  out.push(Array.from(new Set([1, 2])).join(","));
  out.push(Array.from("abc", (c: any) => c.toUpperCase()).join(""));
  out.push(Array.from([1, 2, 3], (x: any, i: any) => x + i).join(","));
  return out.join("|");
}` },
  { name: "string-index-and-char", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s = "abc";
  out.push(s[0], s[1], s[-1], s[5] === undefined ? 1 : 0, s["1"]);
  out.push(s.charAt(0), s.charAt(9), "abc"[2]);
  out.push(s[0] = "z", s);
  const idx: any = { 0: "x" };
  out.push("x"[0] === "x" ? 1 : 0, s[1.5] === undefined ? 1 : 0);
  return out.join("|");
}` },
  { name: "method-call-via-extract", fn: "f", ts: `class T { v: any = 9; m(): any { return this.v * 2; } }
const obj: any = { v: 5, m() { return this.v + 1; } };
export function f(): any {
  const out: any = [];
  const t = new T();
  const m1 = t.m;
  out.push(m1.call(t), m1.apply(t));
  const m2 = obj.m;
  out.push(m2.call(obj), m2.call({ v: 20 }));
  out.push([1].map(t.m, t) === undefined ? "u" : "v", [1].map(obj.m, obj) === undefined ? "u" : "v");
  return out.join("|");
}` },
  { name: "boolean-boxing-methods", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(true.toString(), false.toString(), (5).toString(), ("x").toString());
  out.push(true.valueOf(), (1).valueOf());
  out.push((3).toFixed ? (3).toFixed(1) : "na", (255).toString(16));
  out.push(Number(3).toString(), String(3));
  out.push(!!Number(0), Number(true), Number(false), Number(null), Number(undefined) !== Number(undefined) ? 1 : 0);
  return out.join("|");
}` },
  { name: "forin-vs-forof-objects", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: 2, c: 3 };
  const fi: any = [];
  for (const k in o) fi.push(k + "=" + o[k]);
  out.push(fi.join(","));
  const fo: any = [];
  for (const v of Object.values(o)) fo.push(v);
  out.push(fo.join(","));
  const objArr: any = [{ n: 1 }, { n: 2 }];
  const vals: any = [];
  for (const it of objArr) vals.push(it.n);
  out.push(vals.join(","));
  const proto: any = { p: 9 };
  const child: any = Object.create(proto);
  child.o = 1;
  const kin: any = [];
  for (const k in child) kin.push(k);
  out.push(kin.join(","));
  return out.join("|");
}` },
];