// 差分审计语料（第四十二批）：解构**赋值式**（[a,b]=、{x:…}=）全覆盖——嵌套模式、默认值、
// 数组/对象 rest、成员/元素目标、计算键、可迭代源、表达式结果值。旧实现仅支持
// 「标识符 + {key: 标识符}」，其余形状 loud 报错；现由 _emitDestructuringAssign 统一发射。
module.exports = [
  { name: "assign-basic-swap", fn: "f", ts: `export function f(): any {
  let a = 1, b = 2;
  [a, b] = [b, a];
  return a + "," + b;
}` },
  { name: "assign-holes-indices", fn: "f", ts: `export function f(): any {
  let a = 0, c = 0;
  [a, , c] = [10, 20, 30];
  return a + "," + c;
}` },
  { name: "assign-array-defaults", fn: "f", ts: `export function f(): any {
  let a = 9, b = 9;
  [a = 5, b = 6] = [undefined, 1];
  return a + "," + b;
}` },
  { name: "assign-array-rest", fn: "f", ts: `export function f(): any {
  let d = 0; let rest: any = [];
  [d, ...rest] = [1, 2, 3];
  return d + "|" + rest.join(",");
}` },
  { name: "assign-object-rename", fn: "f", ts: `export function f(): any {
  let e = 0, g = 0;
  ({ x: e, y: g } = { x: 7, y: 8 });
  return e + "," + g;
}` },
  { name: "assign-object-shorthand-default", fn: "f", ts: `export function f(): any {
  let h = 0, i = 0;
  ({ h = 9 } = {});
  ({ i } = { i: 3 });
  return h + "," + i;
}` },
  { name: "assign-member-target", fn: "f", ts: `export function f(): any {
  const o: any = { p: 1 };
  ({ p: o.q } = { p: 42 });
  [o.r] = [7];
  return o.q + "," + o.r;
}` },
  { name: "assign-element-target", fn: "f", ts: `export function f(): any {
  const arr: any = [];
  ([arr[0], arr[1]] = [15, 16]);
  return arr.join("-");
}` },
  { name: "assign-nested-patterns", fn: "f", ts: `export function f(): any {
  let a = 0, b = 0;
  [[a], { z: b }] = [[11], { z: 12 }];
  const { deep: { k } } = { deep: { k: 0 } };
  ({ deep: [{ v: b }] } = { deep: [{ v: 99 }] });
  return a + "," + b;
}` },
  { name: "assign-computed-key", fn: "f", ts: `export function f(): any {
  let c = 0; const kk = "k";
  ({ [kk]: c } = { k: 13 });
  return c;
}` },
  { name: "assign-iterable-source", fn: "f", ts: `export function f(): any {
  let a = 0, b = 0;
  [a, b] = new Set([1, 2]);
  return a + "," + b;
}` },
  { name: "assign-expression-value", fn: "f", ts: `export function f(): any {
  let a = 0;
  const z: any = ([a] = [77]);
  const w: any = ({ a } = { a: 88 });
  return a + "|" + z[0] + "|" + w.a;
}` },
];
