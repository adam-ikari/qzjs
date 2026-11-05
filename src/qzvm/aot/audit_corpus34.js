// 差分审计语料（第三十四批）：强制转换（Symbol.toPrimitive/valueOf）、数值格式化、数组进阶方法（splice/fill/copyWithin/at/findLast）、
// RegExp 状态、Map/Set 迭代中修改、getter 抛错传播、稀疏数组、Object.is/descriptors、类访问器继承、delete/void、嵌套 trim/模板。
module.exports = [
  { name: "coercion-toprimitive", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { valueOf() { return 7; }, toString() { return "str"; } };
  out.push(o + 1, String(o), \`\${o}\`, +o);
  const p: any = { toString() { return "T"; } };
  out.push(p + "", String(p), +p);
  const q: any = { [Symbol.toPrimitive](hint: any) { return hint === "number" ? 5 : hint === "string" ? "S" : true; } };
  out.push(+q, q + "", \`\${q}\`, q == true ? 1 : 0);
  const arr: any = [1, 2];
  out.push(arr + "", arr + 0, String(arr));
  out.push("" + null + undefined + true + 1);
  return out.join("|");
}` },
  { name: "number-formatting", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push((255.5).toFixed(0), (255.5).toFixed(2), (-1.5).toFixed(0));
  out.push((1234.5678).toPrecision(4), (0.000123).toExponential(2));
  out.push((1e21).toString(), (1e-7).toString(), (0.1 + 0.2).toString());
  out.push(Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.EPSILON > 0);
  out.push(parseInt("0x1f"), parseInt("101", 2), parseFloat("1.5e2"));
  out.push((-0).toString(), Object.is(-0, 0) ? 1 : 0, 1 / -0 < 0 ? 1 : 0);
  return out.join("|");
}` },
  { name: "array-splice-fill", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [1, 2, 3, 4, 5];
  out.push(a.splice(1, 2).join(","), a.join(","));
  const b: any = [1, 2, 3];
  b.splice(1, 0, "x", "y");
  out.push(b.join(","));
  out.push(b.splice(-2, 1).join(","), b.join(","));
  const c: any = [1, 2, 3, 4];
  out.push(c.fill(0, 1, 3).join(","), c.fill(9).join(","));
  out.push([1, 2, 3, 4, 5].copyWithin(0, 3).join(","));
  return out.join("|");
}` },
  { name: "array-search-advanced", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [1, 2, 3, 4, 5];
  out.push(a.at(0), a.at(-1), a.at(9), a.indexOf(3), a.lastIndexOf(3));
  out.push(a.find((x: any) => x > 3), a.findIndex((x: any) => x > 3), a.findLast((x: any) => x < 3));
  out.push(a.some((x: any) => x > 4), a.every((x: any) => x > 0), a.every((x: any) => x > 1));
  out.push(a.reduceRight((acc: any, x: any) => acc + "" + x, ""), a.filter((x: any) => x % 2).join(","));
  out.push([].find((x: any) => x === 1) === undefined ? 1 : 0, [3, 1, 2].includes(1));
  return out.join("|");
}` },
  { name: "regex-state-flags", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const re: any = /a/g;
  out.push(re.exec("aaa").index, re.lastIndex, re.exec("aaa").index, re.lastIndex);
  re.lastIndex = 0;
  out.push(re.test("aaa"), re.lastIndex, re.test("aaa"), re.lastIndex);
  const m: any = "x1 y22 z333".match(/\\d+/g);
  out.push(m.join(","), m.length);
  out.push("a.b.c".split(".").length, "abc".search(/b/), "AAA".replace(/a/gi, "z"));
  out.push(/^a$/.source, new RegExp("b+", "i").flags.length > 0 ? 1 : 0);
  return out.join("|");
}` },
  { name: "map-mutation-iteration", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const m: any = new Map([["a", 1], ["b", 2]]);
  const seen: any = [];
  for (const [k, v] of m) { seen.push(k + v); if (k === "a") m.set("c", 3); }
  out.push(seen.join(","), m.size);
  const s: any = new Set([1, 2, 3]);
  const seen2: any = [];
  for (const v of s) { seen2.push(v); if (v === 1) s.delete(2); }
  out.push(seen2.join(","), s.size);
  const m2: any = new Map([["x", 1], ["y", 2]]);
  out.push([...m2.keys()].join(","), [...m2.values()].join(","), [...m2.entries()].join(";"));
  m2.forEach((v: any, k: any) => seen2.push(k + "=" + v));
  out.push(seen2.slice(-2).join(","));
  return out.join("|");
}` },
  { name: "getter-throws-catch", fn: "f", ts: `class Guard {
  get risky(): any { throw new TypeError("boom"); }
  get safe(): any { return "ok"; }
  method(): any { try { return this.risky; } catch (e: any) { return "caught:" + (e instanceof TypeError); } }
}
export function f(): any {
  const out: any = [];
  const g: any = new Guard();
  out.push(g.safe, g.method());
  try { out.push(g.risky); } catch (e: any) { out.push("outer:" + e.message); }
  const o: any = { get bad(): any { throw new Error("E1"); } };
  try { o.bad; } catch (e: any) { out.push(e.message); }
  out.push(g.safe);
  return out.join("|");
}` },
  { name: "sparse-arrays", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = new Array(3);
  out.push(a.length, a[0] === undefined ? 1 : 0, 0 in a ? 1 : 0);
  a[1] = "one";
  out.push(a.length, a.join(","), Object.keys(a).join(","));
  const b: any = [1, , 3];
  out.push(b.length, b[1] === undefined ? 1 : 0, b.join("-"));
  const c: any = [];
  c[2] = 5;
  out.push(c.length, c.filter((x: any) => true).length);
  out.push(...[1, 2, 3].slice(1));
  return out.join("|");
}` },
  { name: "object-is-descriptors", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Object.is(NaN, NaN), Object.is(0, -0), Object.is(1, 1), Object.is("a", "a"));
  const o: any = { a: 1 };
  Object.defineProperty(o, "b", { value: 2, enumerable: true });
  const ds: any = Object.getOwnPropertyDescriptors(o);
  out.push(Object.keys(ds).join(","), ds.a.value, ds.b.enumerable, ds.a.writable);
  const frozen: any = Object.freeze({ z: 9 });
  out.push(Object.getOwnPropertyDescriptor(frozen, "z").writable === false ? 1 : 0);
  out.push(Object.keys({ [Symbol("s")]: 1, a: 2 }).join(","));
  return out.join("|");
}` },
  { name: "class-accessor-inherit", fn: "f", ts: `class Base {
  #v: any = 1;
  get value(): any { return this.#v; }
  set value(x: any) { this.#v = x * 2; }
  get doubled(): any { return this.value * 2; }
}
class Sub extends Base {
  get value(): any { return super.value + 100; }
  set value(x: any) { super.value = x; }
}
export function f(): any {
  const out: any = [];
  const b: any = new Base();
  b.value = 5;
  out.push(b.value, b.doubled);
  const s: any = new Sub();
  s.value = 3;
  out.push(s.value, s.doubled);
  out.push(Object.getOwnPropertyNames(Object.getPrototypeOf(s)).join(","));
  return out.join("|");
}` },
  { name: "delete-void-comma", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: 2 };
  out.push(delete o.a, o.a === undefined ? 1 : 0, Object.keys(o).join(","));
  out.push(delete (o as any).zz);
  let x = 0;
  out.push((x = 5, x + 1), void 0 === undefined);
  out.push(typeof void 0, typeof (0, "s"));
  const a: any = [1, 2, 3];
  out.push(delete a[1], a.length, a[1] === undefined ? 1 : 0);
  return out.join("|");
}` },
  { name: "template-edge", fn: "f", ts: `function tag(strings: any, ...vals: any[]): any {
  return strings.raw.join("|") + "#" + vals.join(",") + "#" + strings.length;
}
export function f(): any {
  const out: any = [];
  out.push(tag\`a\\nb\${1}c\${2}\`);
  out.push(String.raw\`x\\ty\${3}z\`);
  const n = 5;
  out.push(\`v=\${n}\`, \`\${n > 3 ? "big" : "small"}\`, \`\${[1, 2].join("+")}\`);
  out.push(\`nested \${"in " + \`\${n}\`}\`, \`\${undefined}\`, \`\${null}\`);
  out.push(\`multi
line\`.length);
  return out.join("|");
}` },
  { name: "for-in-order", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { b: 1, 2: 2, a: 3, 1: 4 };
  const ks: any = [];
  for (const k in o) ks.push(k);
  out.push(ks.join(","), Object.keys(o).join(","));
  const proto: any = { inherited: 1 };
  const child: any = Object.create(proto);
  child.own = 2;
  const ks2: any = [];
  for (const k in child) ks2.push(k);
  out.push(ks2.join(","));
  const arr: any = ["x", "y"];
  const ks3: any = [];
  for (const k in arr) ks3.push(k);
  out.push(ks3.join(","));
  return out.join("|");
}` },
  { name: "string-builders", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(String.fromCharCode(72, 105), String.fromCodePoint(0x1f600).length);
  out.push("Hi".charCodeAt(0), "😀".codePointAt(0) > 0 ? 1 : 0);
  out.push("a".concat("b", "c"), "abc".localeCompare("abd") < 0 ? 1 : 0);
  out.push("  x  ".trimStart().length, "  x  ".trimEnd().length, "  x  ".trim().length);
  out.push("abc".substring(1, 3), "abc".substr(1, 1), "abcabc".replaceAll("a", "z"));
  out.push("a,b".split(",").map((s: any) => s.toUpperCase()).join("|"));
  out.push("ab".repeat(0), "ab".repeat(2).length);
  return out.join("|");
}` },
  { name: "nested-closures-state", fn: "f", ts: `function makeCounter(start: any, step: any = 1): any {
  let n = start;
  return {
    inc: () => { n += step; return n; },
    dec: () => { n -= step; return n; },
    peek: () => n
  };
}
export function f(): any {
  const out: any = [];
  const c1: any = makeCounter(10);
  const c2: any = makeCounter(0, 5);
  out.push(c1.inc(), c1.inc(), c2.inc(), c1.peek(), c2.peek());
  out.push(c1.dec(), c2.dec(), c1.peek());
  const adders: any = [];
  for (let i = 0; i < 3; i++) { const k = i * 2; adders.push((x: any) => x + k); }
  out.push(adders.map((a: any) => a(1)).join(","));
  return out.join("|");
}` },
  { name: "class-static-block-order", fn: "f", ts: `class Config {
  static a: any = 1;
  static b: any = Config.a + 1;
  static { Config.c = Config.b + 1; }
  static d: any = Config.c * 2;
  static { this.e = this.d + 1; }
  #priv: any = 5;
  get priv(): any { return this.#priv; }
  static summary(): any { return [Config.a, Config.b, Config.c, Config.d, Config.e].join(","); }
}
export function f(): any {
  const out: any = [];
  out.push(Config.summary(), new Config().priv);
  const c: any = new Config();
  out.push(c.priv, Config.d);
  return out.join("|");
}` },
  { name: "error-finally-order", fn: "f", ts: `export function f(): any {
  const log: any = [];
  function a(): any {
    try { log.push("t"); throw new RangeError("r"); }
    catch (e: any) { log.push("c:" + (e instanceof RangeError)); return "from-catch"; }
    finally { log.push("fin"); }
  }
  function b(): any {
    try { return "t-ret"; } finally { log.push("fin2"); }
  }
  function c(): any {
    try { log.push("t3"); } finally { log.push("fin3"); return "fin-ret"; }
  }
  const r1 = a(), r2 = b(), r3 = c();
  return [r1, r2, r3, log.join(",")].join("|");
}` },
  { name: "object-spread-deep", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const base: any = { a: 1, b: { x: 1 } };
  const merged: any = { ...base, a: 2, c: 3 };
  out.push(JSON.stringify(merged), merged.b.x);
  merged.b.x = 9;
  out.push(base.b.x);
  const arr: any = [{ k: 1 }, { k: 2 }];
  const mapped: any = arr.map((o: any) => ({ ...o, k: o.k * 10 }));
  out.push(JSON.stringify(mapped));
  const nested: any = { ...{ ...{ deep: 1 } }, extra: 2 };
  out.push(JSON.stringify(nested));
  const withFn: any = { f: () => 1, ...{ g: 2 } };
  out.push(typeof withFn.f, Object.keys(withFn).join(","));
  return out.join("|");
}` },
];
