// 差分审计语料（第十五批）：Symbol/Reflect/Proxy(loud)/TypedArray(loud)/Intl(loud)/Map·Set 深水/Date 格式化/RegExp 命名组/Promise(loud)/迭代协议/标签模板/类表达式继承。
module.exports = [
  { name: "symbol-values", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(typeof Symbol, typeof Symbol.iterator, typeof Symbol.for);
  const s1: any = Symbol("a"), s2: any = Symbol("a");
  out.push(s1 === s2 ? 1 : 0, s1 === s1 ? 1 : 0);
  out.push(s1.toString().slice(0, 6), String(s1).slice(0, 6));
  const o: any = {};
  o[s1] = "val";
  out.push(o[s1]);
  out.push(Object.getOwnPropertyNames(o).length, Object.getOwnPropertySymbols ? Object.getOwnPropertySymbols(o).length : "na");
  out.push(Symbol.keyFor(Symbol.for("shared")), Symbol.for("shared") === Symbol.for("shared") ? 1 : 0);
  return out.join("|");
}` },
  { name: "reflect-basics", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: 2 };
  out.push(Reflect.has(o, "a") ? 1 : 0, Reflect.has(o, "c") ? 1 : 0);
  out.push(Reflect.get(o, "a"), Reflect.ownKeys(o).join(","));
  Reflect.set(o, "c", 3);
  out.push(o.c);
  Reflect.deleteProperty(o, "b");
  out.push("b" in o ? 1 : 0, Reflect.has(o, "b") ? 1 : 0);
  const arr: any = [10, 20];
  out.push(Reflect.get(arr, 1), Reflect.has(arr, "length") ? 1 : 0);
  return out.join("|");
}` },
  { name: "object-get-own-symbols", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { x: 1 };
  const s: any = Symbol("test");
  o[s] = 2;
  out.push(Object.keys(o).join(","));
  out.push(Object.getOwnPropertyNames(o).join(","));
  out.push(Object.getOwnPropertySymbols ? Object.getOwnPropertySymbols(o).length : "na");
  out.push(Reflect.ownKeys(o).map((k: any) => typeof k === "symbol" ? "sym" : k).join(","));
  return out.join("|");
}` },
  { name: "map-deep-iteration", fn: "f", ts: `export function f(): any {
  const m: any = new Map([["a", 1], ["b", 2], ["c", 3]]);
  const out: any = [];
  out.push([...m].map((e: any) => e.join("=")).join(","));
  out.push(Object.fromEntries(m).a);
  out.push([...m.keys()].join(","), [...m.values()].join(","));
  out.push([...m.entries()].map((e: any) => e[0] + e[1]).join(","));
  const filtered: any = new Map([...m].filter((e: any) => e[1] > 1));
  out.push(filtered.size, [...filtered.keys()].join(","));
  out.push(m.get("b"), m.has("d") ? 1 : 0);
  return out.join("|");
}` },
  { name: "set-operations", fn: "f", ts: `export function f(): any {
  const a: any = new Set([1, 2, 3]);
  const b: any = new Set([2, 3, 4]);
  const out: any = [];
  out.push(a.size, b.size);
  const inter: any = new Set([...a].filter((x: any) => b.has(x)));
  out.push([...inter].join(","));
  const diff: any = new Set([...a].filter((x: any) => !b.has(x)));
  out.push([...diff].join(","));
  const uni: any = new Set([...a, ...b]);
  out.push(uni.size);
  a.add(5); a.delete(1);
  out.push(a.size, a.has(1) ? 1 : 0);
  return out.join("|");
}` },
  { name: "date-format", fn: "f", ts: `export function f(): any {
  const d: any = new Date(1609459200000);
  const out: any = [];
  out.push(d.toISOString());
  out.push(d.getTime());
  out.push(d.getFullYear(), d.getMonth(), d.getDate());
  out.push(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  out.push(d.toDateString().slice(0, 3));
  out.push(new Date("invalid").getTime());
  out.push(Date.parse("2020-01-01T00:00:00.000Z"));
  return out.join("|");
}` },
  { name: "regexp-named-groups", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const re: any = /(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})/;
  const m: any = "2023-07-15".match(re);
  out.push(m.groups.year, m.groups.month, m.groups.day);
  out.push(m[1], m[2], m[3]);
  const replaced: any = "2023-07-15".replace(re, "$<day>/$<month>/$<year>");
  out.push(replaced);
  out.push("test123".replace(/\\d/g, (x: any) => "[" + x + "]"));
  out.push([..."a1b2c3".matchAll(/([a-z])(\\d)/g)].map((m2: any) => m2[1] + m2[2]).join(","));
  return out.join("|");
}` },
  { name: "array-from-iterables", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Array.from("hello").join("-"));
  out.push(Array.from(new Set([3, 1, 2])).join(","));
  out.push(Array.from(new Map([["a", 1], ["b", 2]]), (e: any) => e[0] + "=" + e[1]).join(","));
  const iter: any = { [Symbol.iterator]: () => { let n = 0; return { next: () => n < 3 ? { value: n++, done: false } : { value: undefined, done: true } }; } };
  out.push(Array.from(iter).join(","));
  out.push([...iter].join(","));
  out.push(Array.from({ length: 3 }, (v: any, i: any) => i * 10).join(","));
  return out.join("|");
}` },
  { name: "string-raw-variants", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const x = 1, y = "s";
  out.push(String.raw\`a\${x}b\${y}\`);
  out.push(\`a\${x}b\${y}\`);
  function tag(s: any, ...v: any[]): any { return s.raw.join("|") + "#" + v.join(","); }
  out.push(tag\`p\${x}q\${y}r\`);
  out.push(String.raw\`\${x}+\${y}\`);
  return out.join("|");
}` },
  { name: "class-expr-heritage", fn: "f", ts: `class A { base: any = 1; m(): any { return "A"; } }
export function f(): any {
  const B: any = class extends A { extra: any = 2; m(): any { return "B" + super.m(); } };
  const b = new B();
  const out: any = [];
  out.push(b.base, b.extra, b.m());
  out.push(b instanceof B ? 1 : 0, b instanceof A ? 1 : 0);
  const C: any = class { v: any = 10; };
  out.push(new C().v, typeof C);
  return out.join("|");
}` },
  { name: "switch-let-tdz", fn: "f", ts: `export function f(x: any): any {
  let out = "";
  switch (x) {
    case 1: { const v = "a"; out += v; }
    case 2: { const v = "b"; out += v; break; }
    default: out += "d";
  }
  return out;
}`, args: [1] },
  { name: "labeled-break-switch", fn: "f", ts: `export function f(): any {
  const out: any = [];
  outer: for (let i = 0; i < 3; i++) {
    switch (i) {
      case 1: break outer;
      default: out.push(i);
    }
  }
  return out.join(",");
}` },
  { name: "delete-array-element", fn: "f", ts: `export function f(): any {
  const a: any = [1, 2, 3, 4];
  const out: any = [];
  delete a[1];
  out.push(a.length, a[1] === undefined ? 1 : 0);
  out.push(a.join(","), Object.keys(a).join(","));
  out.push(a.map((x: any) => x === undefined ? "u" : x).join(","));
  a.length = 2;
  out.push(a.length, a.join(","));
  return out.join("|");
}` },
  { name: "number-string-static", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Number.isInteger(5), Number.isInteger(5.5));
  out.push(Number.isNaN(NaN), Number.isFinite(Infinity));
  out.push(Number.isSafeInteger(2 ** 53), Number.MAX_SAFE_INTEGER);
  out.push(Number.parseInt("42px"), Number.parseFloat("3.14abc"));
  out.push(Number.EPSILON > 0 ? 1 : 0);
  out.push(String.fromCharCode(65, 66, 67));
  out.push(String.fromCodePoint(128512).length);
  out.push("abc".at(-1), "abc".at(0));
  return out.join("|");
}` },
  { name: "json-replacer-reviver", fn: "f", ts: `export function f(): any {
  const o: any = { a: 1, b: 2, nested: { c: 3 } };
  const s = JSON.stringify(o, (k: any, v: any) => k === "b" ? undefined : v);
  const out: any = [];
  out.push(s);
  const r: any = JSON.parse(s, (k: any, v: any) => typeof v === "number" ? v * 10 : v);
  out.push(r.a, r.nested.c, r.b === undefined ? 1 : 0);
  out.push(JSON.stringify([1, 2, 3], null, 2).includes("\\n") ? 1 : 0);
  out.push(JSON.stringify({ x: undefined, y: null, z: NaN }));
  return out.join("|");
}` },
  { name: "error-subclass-chain", fn: "f", ts: `class AppError extends Error { code: any; constructor(msg: any, code: any) { super(msg); this.name = "AppError"; this.code = code; } }
class FatalError extends AppError { constructor(msg: any) { super(msg, 500); this.name = "FatalError"; } }
export function f(): any {
  const out: any = [];
  const e: any = new FatalError("crash");
  out.push(e.message, e.code, e.name);
  out.push(e instanceof FatalError ? 1 : 0, e instanceof AppError ? 1 : 0, e instanceof Error ? 1 : 0);
  try { throw e; } catch (c: any) { out.push(c.code, c.name); }
  return out.join("|");
}` },
  { name: "iterator-custom-object", fn: "f", ts: `export function f(): any {
  const range: any = {
    from: 1, to: 4,
    [Symbol.iterator]() {
      let cur = this.from, last = this.to;
      return { next: () => cur <= last ? { value: cur++, done: false } : { value: undefined, done: true } };
    }
  };
  const out: any = [];
  out.push([...range].join(","));
  out.push(Array.from(range).join(","));
  let sum = 0;
  for (const v of range) sum += v;
  out.push(sum);
  return out.join("|");
}` },
  { name: "getter-returning-object", fn: "f", ts: `class Config { _d: any = { port: 8080 }; get data(): any { return this._d; } }
export function f(): any {
  const c = new Config();
  const out: any = [];
  out.push(c.data.port);
  c.data.port = 3000;
  out.push(c.data.port, c._d.port);
  out.push(c.data === c._d ? 1 : 0);
  out.push(c.data === c.data ? 1 : 0);
  return out.join("|");
}` },
  { name: "weakmap-identity", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const wm: any = new WeakMap();
  const k1: any = { id: 1 }, k2: any = { id: 2 };
  wm.set(k1, "v1"); wm.set(k2, "v2");
  out.push(wm.get(k1), wm.get(k2));
  out.push(wm.get({ id: 1 }) === undefined ? 1 : 0);
  out.push(wm.has(k1) ? 1 : 0);
  wm.delete(k1);
  out.push(wm.has(k1) ? 1 : 0, wm.get(k2));
  return out.join("|");
}` },
  { name: "optional-chain-call", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { fn: (x: any) => x * 2, nested: { fn2: (x: any) => x + 1 } };
  out.push(o.fn?.(5), o.missing?.(5));
  out.push(o.nested?.fn2?.(10), o.missing?.fn2?.(10));
  out.push(o.fn?.(o.nested?.fn2?.(3)));
  const arr: any = [1, 2];
  out.push(arr?.[0], arr?.[5]);
  out.push(arr?.map?.((x: any) => x * 10).join(","));
  return out.join("|");
}` },
];
