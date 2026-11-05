// 差分审计语料（第三十六批）：类内聚（toString/valueOf 强制转换、字段箭头函数、私有+静态 getter）、迭代器视图、
// 递归数据结构、finally 抛错、标签跳转、== 与 === 边界、JSON reviver、闭包 getter、模块级 IIFE、可选链方法调用。
module.exports = [
  { name: "class-coercion-methods", fn: "f", ts: `class Money {
  constructor(public amount: any) {}
  valueOf(): any { return this.amount; }
  toString(): any { return "$" + this.amount; }
}
class OnlyStr { toString(): any { return "S"; } }
export function f(): any {
  const out: any = [];
  const m: any = new Money(5);
  out.push(m + 1, m * 2, String(m), \`\${m}\`, m == 5 ? 1 : 0, m === 5 ? 1 : 0);
  out.push([m, m].join(","), [m].map((x: any) => x + 0).join(","));
  const s: any = new OnlyStr();
  out.push(s + "", String(s), \`\${s}\`, +s);
  out.push(new Money(1) < new Money(2) ? 1 : 0);
  return out.join("|");
}` },
  { name: "class-field-arrows", fn: "f", ts: `class Handler {
  name: any = "h";
  greet = (x: any = "w") => this.name + ":" + x;
  counter: any = 0;
  bump = () => { this.counter++; return this.counter; };
  static make(): any { return new Handler(); }
}
export function f(): any {
  const out: any = [];
  const h: any = new Handler();
  out.push(h.greet(), h.greet("z"), h.bump(), h.bump(), h.counter);
  const g: any = h.greet;
  out.push(g("detached"));
  const b: any = h.bump;
  out.push(b(), h.counter);
  out.push(Handler.make().greet(), typeof h.greet);
  return out.join("|");
}` },
  { name: "iterator-views", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const m: any = new Map([["a", 1], ["b", 2], ["c", 3]]);
  out.push([...m.entries()].map((e: any) => e[0] + e[1]).join(","));
  out.push([...m.keys()].join(""), [...m.values()].join(""));
  const it: any = m.entries();
  out.push(it.next().value.join(":"), it.next().value.join(":"), it.next().done);
  const arr: any = [10, 20, 30];
  const ai: any = arr.entries();
  out.push(ai.next().value.join("="), ai.next().done, ai.next().value[0]);
  const s: any = new Set(["x", "y"]);
  for (const [k, v] of s.entries()) out.push(k + v);
  out.push([...arr.keys()].join(","), [...new Set([1, 2, 3])].length);
  return out.join("|");
}` },
  { name: "recursive-structures", fn: "f", ts: `interface Node { v: any; next: any; }
function list(...vals: any[]): any {
  let head: any = null;
  for (let i = vals.length - 1; i >= 0; i--) head = { v: vals[i], next: head };
  return head;
}
function total(n: any): any { return n === null ? 0 : n.v + total(n.next); }
function rev(n: any, acc: any = null): any { return n === null ? acc : rev(n.next, { v: n.v, next: acc }); }
function show(n: any, out: any = []): any { return n === null ? out : show(n.next, out.concat([n.v])); }
export function f(): any {
  const out: any = [];
  const l: any = list(1, 2, 3, 4);
  out.push(total(l), show(l).join(","), show(rev(l)).join(","));
  const tree: any = { v: 1, kids: [{ v: 2, kids: [] }, { v: 3, kids: [{ v: 4, kids: [] }] }] };
  const sum = (t: any): any => t.v + t.kids.reduce((acc: any, k: any) => acc + sum(k), 0);
  out.push(sum(tree));
  out.push(show(list()).length, total(null));
  return out.join("|");
}` },
  { name: "finally-throws", fn: "f", ts: `export function f(): any {
  const log: any = [];
  const g = (): any => { try { log.push("t"); return "ret"; } finally { log.push("f1"); throw new Error("from-finally"); } };
  try { g(); } catch (e: any) { log.push("caught:" + e.message); }
  const h = (): any => { try { throw new Error("orig"); } catch (e: any) { log.push("c:" + e.message); throw e; } finally { log.push("f2"); } };
  try { h(); } catch (e: any) { log.push("outer:" + e.message); }
  const k = (): any => { try { try { throw new Error("deep"); } finally { log.push("inner-fin"); } } catch (e: any) { return "h:" + e.message; } };
  log.push(k());
  return log.join(",");
}` },
  { name: "equality-edges", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(null == undefined ? 1 : 0, null === undefined ? 1 : 0, null == 0 ? 1 : 0, null >= 0 ? 1 : 0);
  out.push("" == 0 ? 1 : 0, "" === 0 ? 1 : 0, "1" == 1 ? 1 : 0, "1" === 1 ? 1 : 0);
  out.push(NaN === NaN ? 1 : 0, Object.is(NaN, NaN) ? 1 : 0, [] == false ? 1 : 0, [] == "" ? 1 : 0);
  const o1: any = { a: 1 }, o2: any = { a: 1 };
  out.push(o1 == o2 ? 1 : 0, o1 === o2 ? 1 : 0, o1 == o1 ? 1 : 0);
  const arr: any = [1, 2];
  out.push(arr == arr ? 1 : 0, [1, 2] == "1,2" ? 1 : 0, true == 1 ? 1 : 0, false == "" ? 1 : 0);
  return out.join("|");
}` },
  { name: "json-reviver", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const r1: any = JSON.parse('{"a":1,"b":{"c":2},"d":[1,2]}', (k: any, v: any) => (typeof v === "number" ? v * 10 : v));
  out.push(JSON.stringify(r1));
  let keys: any = [];
  JSON.parse('{"x":1,"y":{"z":2}}', (k: any, v: any) => { if (k) keys.push(k); return v; });
  out.push(keys.join(","));
  const withDate: any = JSON.parse('{"d":"2024-01-01"}', (k: any, v: any) => (k === "d" ? "DATE:" + v : v));
  out.push(withDate.d);
  const dropped: any = JSON.parse('[1,2,3]', (k: any, v: any) => (v === 2 ? undefined : v));
  out.push(JSON.stringify(dropped), JSON.stringify(JSON.parse("[1,[2,3]]")));
  return out.join("|");
}` },
  { name: "closure-getters", fn: "f", ts: `function makeCounter(): any {
  let n = 0;
  const api: any = {};
  Object.defineProperty(api, "value", { get: () => n, enumerable: true, configurable: true });
  Object.defineProperty(api, "double", { get() { return n * 2; } });
  api.inc = () => ++n;
  return api;
}
export function f(): any {
  const out: any = [];
  const c: any = makeCounter();
  out.push(c.value, c.double);
  c.inc(); c.inc();
  out.push(c.value, c.double);
  const o: any = { base: 10 };
  Object.defineProperty(o, "derived", { get: () => o.base * 3 });
  out.push(o.derived);
  o.base = 20;
  out.push(o.derived, Object.keys(c).join(",").indexOf("value") >= 0 ? 1 : 0);
  return out.join("|");
}` },
  { name: "module-level-iife", fn: "f", ts: `const registry: any = (() => {
  const items: any = [];
  return { add: (x: any) => { items.push(x); return items.length; }, all: () => items.slice() };
})();
registry.add("a");
registry.add("b");
const config: any = (function () {
  const base: any = { debug: false, level: 1 };
  return { ...base, level: base.level + 1 };
})();
const counter: any = (() => { let n = 5; return { get: () => n, bump: () => ++n }; })();
export function f(): any {
  const out: any = [];
  out.push(registry.all().join(","), JSON.stringify(config), counter.get(), counter.bump(), counter.get());
  out.push(registry.add("c"), registry.all().length);
  return out.join("|");
}` },
  { name: "optional-chain-calls", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { m: () => "M", n: { deep: () => "D" } };
  out.push(o?.m(), o?.n?.deep(), o.missing?.(), o?.missing?.deep?.());
  const arr: any = [1, 2];
  out.push(arr?.[0], arr?.[9] ?? "none");
  const fn: any = (x: any) => x * 2;
  out.push(fn?.(21), (null as any)?.());
  let cfg: any = { v: null };
  cfg.v ??= "default";
  cfg.w ??= "w";
  out.push(cfg.v, cfg.w);
  const chain: any = { a: { b: { c: () => "deep" } } };
  out.push(chain.a.b.c(), chain.a?.b?.c?.(), chain.x?.y?.z ?? "fallback");
  return out.join("|");
}` },
  { name: "array-iterator-methods", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [5, 3, 8, 1];
  out.push(a.findLast((x: any) => x > 4), a.findLastIndex((x: any) => x > 4));
  out.push(a.toSorted().join(","), a.join(","));
  out.push(a.with(0, 99).join(","), a.join(","));
  out.push(a.toReversed().join(","), a.toSpliced(1, 2).join(","), a.join(","));
  const acc: any = a.reduce((s: any, x: any) => s + x, 0);
  out.push(acc, a.reduce((mx: any, x: any) => (x > mx ? x : mx)), a.length);
  out.push(a.every((x: any) => x > 0), a.some((x: any) => x > 7), a.includes(3));
  return out.join("|");
}` },
  { name: "getter-returning-closure", fn: "f", ts: `class Factory {
  #base: any = 100;
  get builder(): any { return (x: any) => this.#base + x; }
  get self(): any { return this; }
  makeAdder(n: any): any { return (x: any) => x + n; }
}
export function f(): any {
  const out: any = [];
  const fac: any = new Factory();
  out.push(fac.builder(1), fac.builder(2));
  out.push(fac.self === fac ? 1 : 0, fac.self.builder(0));
  const add5: any = fac.makeAdder(5);
  out.push(add5(1), add5(10));
  const adders: any = [1, 2, 3].map((n: any) => fac.makeAdder(n));
  out.push(adders.map((f2: any) => f2(0)).join(","));
  return out.join("|");
}` },
  { name: "label-jumps-deep", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let hits = 0;
  outer: for (let i = 0; i < 4; i++) {
    mid: for (let j = 0; j < 4; j++) {
      inner: for (let k = 0; k < 4; k++) {
        if (k > j) continue mid;
        if (j > i) continue outer;
        if (i + j + k > 5) break outer;
        hits++;
      }
    }
  }
  out.push(hits);
  let n = 0;
  loop: while (true) { n++; if (n > 3) break loop; }
  out.push(n);
  let s = "";
  for (const x of [1, 2, 3]) { for (const y of ["a", "b"]) { if (x === 2 && y === "a") continue; if (x === 3) break; s += x + y; } }
  out.push(s);
  return out.join("|");
}` },
  { name: "replace-with-fn", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("abc".replace(/b/g, (m: any) => m.toUpperCase()));
  out.push("a1b2".replace(/(\\d)/g, (_: any, d: any) => "[" + (Number(d) * 2) + "]"));
  out.push("x=1,y=2".replace(/(\\w)=(\\d)/g, (_: any, k: any, v: any) => k + ":" + v));
  out.push("aaa".replace(/a/g, (m: any, off: any) => String(off)));
  out.push("hello world".replace(/(\\w+) (\\w+)/, "$2 $1"));
  out.push("A-B".replace("-", (_: any) => "+"), "A-B".replaceAll("-", (_: any) => "*"));
  out.push("abc".replace(/z/, (m: any) => "no"), "abc".replace("b", "$&$&"));
  return out.join("|");
}` },
  { name: "object-spread-getters", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let reads = 0;
  const src: any = {};
  Object.defineProperty(src, "lazy", { get() { reads++; return reads; }, enumerable: true, configurable: true });
  const copy: any = { ...src };
  out.push(copy.lazy, reads, Object.keys(copy).join(","));
  const merged: any = Object.assign({}, src, { extra: 1 });
  out.push(merged.lazy, reads, Object.keys(merged).join(","));
  const frozen: any = Object.freeze({ a: 1, b: 2 });
  const spread: any = { ...frozen, c: 3 };
  out.push(JSON.stringify(spread), Object.isFrozen(frozen) ? 1 : 0, Object.isFrozen(spread) ? 1 : 0);
  return out.join("|");
}` },
  { name: "numeric-boundaries", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(2147483647 + 1, 2147483648 | 0, 4294967295 | 0, 4294967296 | 0);
  out.push(9007199254740991 + 1 === 9007199254740991 ? 1 : 0);
  out.push(0.1 * 3, (0.1 * 3).toFixed(20).length > 5 ? 1 : 0);
  out.push(1e308 + 1e308, -1e308 * 2, Number.MAX_VALUE > 1e308 ? 1 : 0);
  out.push(Number.EPSILON, 1 + Number.EPSILON > 1 ? 1 : 0);
  out.push(parseInt("999999999999999999"), 1e21 | 0, Math.pow(2, 53) === 2 ** 53 ? 1 : 0);
  out.push((-0).toFixed(1), (0.000001).toString(), (1234567890123456789).toString());
  return out.join("|");
}` },
  { name: "class-inheritance-mixins", fn: "f", ts: `const Serializable = (Base: any) => class extends Base {
  toJSON(): any { return { kind: this.kind, data: this.data }; }
};
const Versioned = (Base: any) => class extends Base {
  version: any = 1;
  bump(): any { this.version++; return this.version; }
};
class Core { kind: any = "core"; data: any = [1, 2]; }
class Full extends Serializable(Versioned(Core)) {}
export function f(): any {
  const out: any = [];
  const x: any = new Full();
  out.push(x.kind, x.data.join(""), x.version, x.bump(), x.version);
  out.push(JSON.stringify(x.toJSON()));
  out.push(x instanceof Full ? 1 : 0, x instanceof Core ? 1 : 0);
  out.push(typeof Full, Object.getPrototypeOf(Full.prototype) !== Object.prototype ? 1 : 0);
  return out.join("|");
}` },
];
