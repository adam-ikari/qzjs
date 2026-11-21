// 批 41：宿主容器跨边界持有对象字面量句柄——POJO 物化的回归门。
//
// 背景：build.js 曾把 compileTS 返回的 fields（字段偏移表）丢弃，导致 glue 里
// makeQzvm 收到空 fieldEntries → toJS 无法把 POJO 句柄物化回 JS 对象 →
// Map/Set/数组 等宿主容器持有的对象值全部退化成 undefined。
// 症状是静默的：编译成功、不抛异常、m.size/m.has 都正确，只有取值错误。
// 此前 889 例 corpus 无一覆盖「宿主容器存对象字面量」这条路径，故长期漏检。
module.exports = [
  { name: "host-map-pojo-value", fn: "f", ts: `export function f(): any {
    const out: any = [];
    const obj = { name: "a", n: 7 };
    const m = new Map();
    m.set(1, obj);
    const g = m.get(1);
    out.push(g.name);              // "a"（曾为 undefined）
    out.push(String(g.n));         // "7"
    out.push(String(g === obj));   // "true"（对象身份必须保持）
    out.push(String(m.size));      // "1"
    out.push(String(m.has(1)));    // "true"
    return out.join("|");
  }` },
  { name: "host-map-multi-pojo", fn: "f", ts: `export function f(): any {
    const out: any = [];
    const m = new Map();
    for (let i = 0; i < 3; i++) m.set(i, { v: i * 10 });
    for (let i = 0; i < 3; i++) out.push(String(m.get(i).v));   // 0|10|20
    out.push(String(m.get(9) === undefined));                   // true（缺失键）
    return out.join("|");
  }` },
  { name: "host-set-pojo-value", fn: "f", ts: `export function f(): any {
    const out: any = [];
    const s = new Set();
    s.add({ k: "x" });
    s.add({ k: "y" });
    out.push(String(s.size));      // 2（不同对象 → 两个元素）
    return out.join("|");
  }` },
  { name: "host-map-nested-pojo", fn: "f", ts: `export function f(): any {
    const out: any = [];
    const m = new Map();
    m.set("a", { inner: { deep: 42 } });
    const g = m.get("a");
    out.push(String(g.inner.deep));   // 42（嵌套 POJO 也要物化）
    return out.join("|");
  }` },
  { name: "host-array-pojo-identity", fn: "f", ts: `export function f(): any {
    const out: any = [];
    const o = { name: "z" };
    const a: any[] = [o];
    out.push(a[0].name);              // "z"（数组路径本就正确，防回归）
    out.push(String(a[0] === o));     // "true"
    return out.join("|");
  }` },
];
