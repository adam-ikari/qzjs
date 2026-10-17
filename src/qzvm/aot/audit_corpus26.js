// 差分审计语料（第二十六批）：字符串方法矩阵 / 数组方法补全 / 对象方法 / Reflect / 运算符强制转换 / 可选链调用 / delete / 标签循环 / switch-true / 数值边界。
module.exports = [
  { name: "string-search-methods", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s = "hello world";
  out.push(s.startsWith("hello"), s.startsWith("world", 6), s.endsWith("world"), s.endsWith("lo", 5));
  out.push(s.includes("world"), s.includes("o", 8), s.includes("xyz"));
  out.push(s.indexOf("o"), s.indexOf("o", 5), s.indexOf("xyz"), s.lastIndexOf("o"), s.lastIndexOf("o", 4));
  out.push("aaa".indexOf("a", 10), "".indexOf(""), "abc".indexOf(""));
  return out.join("|");
}` },
  { name: "string-pad-repeat-trim", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("5".padStart(3, "0"), "5".padStart(1), "5".padStart(0), "hi".padEnd(5, "!"), "hi".padEnd(2));
  out.push("ab".repeat(3), "x".repeat(0), "".repeat(5), "  hi  ".trim(), "  hi  ".trimStart(), "  hi  ".trimEnd());
  out.push("a".repeat(3).length, "ab".padStart(5).length);
  return out.join("|");
}` },
  { name: "string-replace-all", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("a-b-c".replace("-", "+"), "a-b-c".replaceAll("-", "+"));
  out.push("hello".replace(/l/g, "L"), "hello".replace(/l/, "L"));
  out.push("2024-01-15".replace(/(\\d+)-(\\d+)-(\\d+)/, "$3/$2/$1"));
  out.push("abcabc".replaceAll("a", "X"), "abc".replaceAll("", "-"));
  out.push("a1b2".replace(/(\\d)/g, (m: any) => "[" + m + "]"));
  out.push("Hello World".replace(/(\\w)(\\w+)/g, (_: any, c: any, r: any) => c.toUpperCase() + r));
  return out.join("|");
}` },
  { name: "string-at-charcode", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const s = "abc";
  out.push(s.at(0), s.at(-1), s.at(2), s.at(5) === undefined ? 1 : 0, s.at(-5) === undefined ? 1 : 0);
  out.push(s.charAt(0), s.charAt(-1), s.charAt(5));
  out.push(s.charCodeAt(0), s.charCodeAt(1), "ABC".charCodeAt(0));
  out.push(String.fromCharCode(65, 66, 67), String.fromCharCode(0x4e2d));
  out.push("a".codePointAt(0), "🙂".codePointAt(0), "🙂".length, [..."🙂"].length);
  out.push("ABC".toLowerCase(), "abc".toUpperCase(), "MixedCase".toLowerCase());
  return out.join("|");
}` },
  { name: "array-at-flat-flatmap", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [1, 2, 3, 4];
  out.push(a.at(0), a.at(-1), a.at(-2), a.at(10) === undefined ? 1 : 0);
  out.push([1, [2, [3, [4]]]].flat(), JSON.stringify([1, [2, [3, [4]]]].flat(2)), JSON.stringify([1, [2, [3, [4]]]].flat(Infinity)));
  out.push([1, 2, 3].flatMap((x: any) => [x, x * 10]).join(","));
  out.push([1, 2, 3].flatMap((x: any) => x > 1 ? [x] : []).join(","));
  out.push([[1, 2], [3, 4]].flatMap((x: any) => x).join(","));
  out.push([1, [2, [3]]].flatMap((x: any) => Array.isArray(x) ? x : [x]).join(","));
  return out.join("|");
}` },
  { name: "array-splice-reverse-fill", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let a: any = [1, 2, 3, 4, 5];
  const r = a.splice(1, 2);
  out.push(a.join(","), r.join(","));
  a = [1, 2, 3, 4, 5];
  a.splice(2, 0, "a", "b");
  out.push(a.join(","));
  a = [1, 2, 3, 4, 5];
  a.splice(-2, 1);
  out.push(a.join(","));
  a = [1, 2, 3];
  out.push(a.reverse().join(","), a.join(","));
  out.push([0, 0, 0].fill(7, 1, 2).join(","), Array(5).fill(0).fill(9, 2).join(","));
  a = [1, 2, 3, 4, 5];
  out.push(a.slice(1, 3).join(","), a.slice(-2).join(","), a.slice().join(","), a.slice(2).join(","));
  return out.join("|");
}` },
  { name: "array-findlast-includes", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const a: any = [1, 2, 3, 2, 1];
  out.push(a.findLast((x: any) => x > 2), a.findLastIndex((x: any) => x === 2), a.findLast((x: any) => x > 5) === undefined ? 1 : 0);
  out.push([1, 2, 3].includes(2), [1, 2, 3].includes(2, 2), [1, 2, NaN].includes(NaN), [1, 2, 3].includes(4));
  out.push(a.indexOf(2), a.indexOf(2, 2), a.lastIndexOf(2), a.lastIndexOf(2, 1));
  out.push([5, 4, 3, 2, 1].sort().join(","), [5, 4, 3, 2, 1].sort((a: any, b: any) => a - b).join(","));
  out.push([10, 1, 2].sort().join(","), [10, 1, 2].sort((a: any, b: any) => a - b).join(","));
  out.push([3, 1, 2].sort((a: any, b: any) => b - a).join(","));
  return out.join("|");
}` },
  { name: "object-fromentries-desc", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = Object.fromEntries([["a", 1], ["b", 2]]);
  out.push(JSON.stringify(o), o.a, o.b);
  const d: any = Object.getOwnPropertyDescriptor({ x: 5 }, "x");
  out.push(d.value, d.writable, d.enumerable, d.configurable);
  const o2: any = {};
  Object.defineProperty(o2, "hidden", { value: 42, enumerable: false, configurable: true });
  out.push(o2.hidden, JSON.stringify(o2), Object.keys(o2).length, Object.getOwnPropertyNames(o2).join(","));
  const o3: any = { a: 1 };
  Object.defineProperties(o3, { b: { value: 2, enumerable: true }, c: { value: 3, enumerable: false } });
  out.push(o3.b, o3.c, Object.keys(o3).join(","), Object.getOwnPropertyNames(o3).join(","));
  return out.join("|");
}` },
  { name: "object-assign-getters", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const src: any = { get x() { out.push("getx"); return 10; }, y: 5 };
  const dst: any = {};
  Object.assign(dst, src);
  out.push(dst.x, dst.y, JSON.stringify(dst));
  const merged: any = Object.assign({}, { a: 1 }, { b: 2 }, { a: 3 });
  out.push(JSON.stringify(merged), merged.a);
  const arr: any = [1, 2, 3];
  const dst2: any = {};
  Object.assign(dst2, arr);
  out.push(dst2[0], dst2[1], dst2.length, JSON.stringify(dst2));
  return out.join("|");
}` },
  { name: "reflect-basics", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: 2 };
  out.push(Reflect.has(o, "a"), Reflect.has(o, "c"), Reflect.get(o, "a"), Reflect.set(o, "c", 3), o.c);
  out.push(Reflect.ownKeys(o).join(","), Reflect.deleteProperty(o, "b"), Reflect.has(o, "b"));
  out.push(Reflect.get([1, 2, 3], 1), Reflect.has("str", "length"));
  const fn: any = (a: any, b: any) => a + b;
  out.push(Reflect.apply(fn, null, [1, 2]), Reflect.apply(fn, undefined, [10, 20]));
  return out.join("|");
}` },
  { name: "operator-coercion", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push("3" * 2, "3" - 1, "3" + 1, 3 + "1", true + 1, null + 1, undefined + 1);
  out.push([1, 2] + [3, 4], {} + "", {} + 0, [] + 0, [] + []);
  out.push("5" == 5, 0 == "", 0 == null, null == undefined, NaN == NaN, "1" === 1);
  out.push(1 < 2, "10" < "9", "10" < 9, 10 < "9", "abc" < "abd");
  out.push(!!0, !!"", !!"0", !!null, !!undefined, !!{}, !![]);
  out.push(+"3.14", +"", +"  ", +"abc", +"0x10", +"10px", -"5", ~5, ~"5");
  return out.join("|");
}` },
  { name: "optional-chaining-calls", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: { b: { c: () => 42 } }, fn: (x: any) => x * 2 };
  out.push(o.a?.b?.c?.(), o.a?.b?.c?.call?.(o.a.b), o?.x?.y ?? "none", o?.fn?.(5));
  out.push(o.a.b.c?.(), null?.x, undefined?.x?.y, (null as any)?.());
  const arr: any = [1, 2, 3];
  out.push(arr?.[1], arr?.[10], arr?.find?.((x: any) => x === 2));
  const f2: any = undefined;
  out.push(f2?.(1) ?? "nofn", o?.missing?.() ?? "missing");
  out.push(o?.a?.b?.c?.() + 1, o.a?.[0]?.x ?? "idx");
  return out.join("|");
}` },
  { name: "delete-void-comma", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = { a: 1, b: 2 };
  out.push(delete o.a, JSON.stringify(o), "a" in o, "b" in o);
  out.push(delete o.c, void 0, void 5, void "x", typeof void(0));
  let x: any = (1, 2, 3);
  out.push(x, (out.push(1), out.push(2), "done"));
  const arr: any = [1, 2, 3];
  delete arr[1];
  out.push(arr.length, arr[1] === undefined ? 1 : 0, JSON.stringify(arr), arr.filter((x: any) => x !== undefined).length);
  out.push(typeof delete o.b, JSON.stringify(o));
  return out.join("|");
}` },
  { name: "labeled-break-continue", fn: "f", ts: `export function f(): any {
  const out: any = [];
  outer: for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (i === 1 && j === 1) break outer;
      out.push(i + "" + j);
    }
  }
  out.push("---");
  let sum = 0;
  loop1: for (let i = 0; i < 5; i++) {
    if (i % 2 === 0) continue loop1;
    sum += i;
  }
  out.push("sum=" + sum);
  let found = "";
  search: for (const item of [1, 2, 3, 4, 5]) {
    for (const sub of [10, 20]) {
      if (item * sub > 40) { found = item + ":" + sub; break search; }
    }
  }
  out.push(found);
  return out.join(",");
}` },
  { name: "switch-true-pattern", fn: "f", ts: `export function f(x: any): any {
  switch (true) {
    case x < 0: return "neg";
    case x === 0: return "zero";
    case x < 10: return "small";
    case x < 100: return "med";
    default: return "big";
  }
}`, args: [50] },
  { name: "switch-fallthrough-multi", fn: "f", ts: `export function f(d: any): any {
  let out = "";
  switch (new Date(d).getDay()) {
    case 0: case 6: out = "weekend"; break;
    case 1: case 2: case 3: case 4: case 5: out = "weekday"; break;
    default: out = "invalid";
  }
  return out;
}` },
  { name: "numeric-edges", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(2 ** 10, 2 ** 0, 2 ** -1, 10 ** 2, 0.1 + 0.2, 0.1 + 0.2 === 0.3);
  out.push(Number.EPSILON > 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2);
  out.push(Number.MIN_VALUE > 0, Number.MAX_VALUE, Infinity, -Infinity, NaN);
  out.push(1 / 0, -1 / 0, 0 / 0, Infinity - Infinity, Infinity + Infinity);
  out.push(1e308 * 10, -1e308 * 10, 5 % 3, -5 % 3, 5 % -3, 5.5 % 2);
  out.push(Math.round(0.5), Math.round(-0.5), Math.round(2.5), Math.round(-2.5), Math.round(1.4), Math.round(-1.4));
  out.push(Math.trunc(1.9), Math.floor(1.9), Math.ceil(1.1), Math.round(2.499));
  return out.join("|");
}` },
  { name: "math-hypot-atan2", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push(Math.hypot ? (Math.hypot(3, 4) === 5 ? 1 : 0) : "na", Math.hypot ? Math.round(Math.hypot(5, 12)) : "na");
  out.push(Math.atan2 ? (Math.abs(Math.atan2(1, 0) - Math.PI / 2) < 0.001 ? 1 : 0) : "na");
  out.push(Math.atan2 ? (Math.atan2(0, 1) === 0 ? 1 : 0) : "na");
  out.push(Math.max(...[1, 5, 3, 2]), Math.min(...[4, 2, 8, 1]), Math.max(1, "2", 3), Math.min(1, "abc", 3));
  out.push(Math.max(), Math.min(), Math.max(NaN, 1), Math.min(NaN, 1));
  out.push(Math.abs(-5), Math.abs(5), Math.abs(-Infinity), Math.pow(2, 8), Math.sqrt(16), Math.sqrt(-1));
  out.push(Math.round(Math.PI * 100) / 100, Math.round(Math.E * 100) / 100);
  return out.join("|");
}` },
  { name: "tostring-chain-join", fn: "f", ts: `export function f(): any {
  const out: any = [];
  out.push([1, 2, 3].toString(), [1, [2, [3]]].toString(), [].toString());
  out.push([1, 2, 3].join(), [1, 2, 3].join("-"), [1, 2, 3].join(""), [1, null, 3].join(","), [1, undefined, 3].join(","));
  out.push([1, 2, 3].join("|"), ["a", "b", "c"].join(""), [true, false].join(","));
  out.push(({ a: 1 }).toString(), [1, 2].toString(), (5).toString(), (5.5).toString());
  out.push(String([1, 2, 3]), String({}), String(null), String(undefined), String(true), String(123));
  out.push([1, 2, 3].join("").length, "1,2,3".split(",").join("-"));
  return out.join("|");
}` },
  { name: "array-copywithin", fn: "f", ts: `export function f(): any {
  const out: any = [];
  let a: any = [1, 2, 3, 4, 5];
  out.push(a.copyWithin(0, 3).join(","), a.join(","));
  a = [1, 2, 3, 4, 5];
  out.push(a.copyWithin(1, 3, 4).join(","));
  a = [1, 2, 3, 4, 5];
  out.push(a.copyWithin(0, -2).join(","));
  a = [1, 2, 3, 4, 5];
  out.push(a.copyWithin(-2, 0, 2).join(","));
  return out.join("|");
}` },
  { name: "symbol-toprimitive", fn: "f", ts: `export function f(): any {
  const out: any = [];
  const o: any = {
    [Symbol.toPrimitive](hint: any) { return hint === "number" ? 42 : hint === "string" ? "str" : "def"; },
    valueOf() { return 99; },
    toString() { return "TS"; }
  };
  out.push(+o, \`\${o}\`, o + "", o + 1, String(o), Number(o));
  const o2: any = { valueOf() { return 7; }, toString() { return "seven"; } };
  out.push(+o2, \`\${o2}\`, o2 + "", o2 + 1, o2 == 7, o2 === 7);
  out.push([] + 1, [] - 1, [5] - 0, [1, 2] - 0, [null] - 0);
  return out.join("|");
}` },
];