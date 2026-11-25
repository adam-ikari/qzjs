// bench/aot-product workload: three real-world JS shapes.
// Pure JS (no ?., no async/generator) so both the wasm and interp paths can run.
// NOTE: keep semantics identical to the interp baseline embedded in run.js.

// 1) pure compute loop (hot numeric path)
function computeWork(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = i % 1000;
    const v = a * a;
    s = (s + v - ((v / 7) | 0) + ((i * 3) % 13)) % 1000003;
  }
  return s;
}

// 2) JSON -> object mapping
// 注意：本函数由 bench 构建脚本显式标记 --interp jsonWork（不编 wasm）。
// 原因：JSON.parse 产宿主对象，每轮 prop_get 6 + get_index 4 + builtin 1 次跨界；
// CI 四档实测 wasm-AOT 0.50×、wasm-JIT 0.15× 于 qzjs 解释，属负优化 → 留 interp。
function jsonWork(n: number): number {
  const src = '{"id":7,"name":"alice","tags":["a","b","c"],"vals":[1,2,3,4]}';
  let t = 0;
  for (let i = 0; i < n; i++) {
    const o = JSON.parse(src);
    const m = { id: o.id + i, name: o.name, total: o.vals[0] + o.vals[1] + o.vals[2] + o.vals[3] };
    t = t + m.id + m.total + m.name.length;
  }
  return t;
}

// 3) schema validation (zod-like: required / type / range / nested)
function validate(v: any): number {
  if (v === null || typeof v !== "object") return -1;
  let errs = 0;
  if (typeof v.name !== "string") errs = errs + 1;
  else if (v.name.length < 2) errs = errs + 1;
  else if (v.name.length > 20) errs = errs + 1;
  if (typeof v.age !== "number") errs = errs + 1;
  else if (v.age < 0) errs = errs + 1;
  else if (v.age > 150) errs = errs + 1;
  if (typeof v.email !== "string") errs = errs + 1;
  else if (v.email.indexOf("@") < 0) errs = errs + 1;
  return errs;
}
function validationWork(n: number): number {
  const good = { name: "Alice", age: 30, email: "a@b.com" };
  const bad = { name: "", age: 200, email: "nope" };
  let t = 0;
  for (let i = 0; i < n; i++) {
    if ((i % 2) === 0) t = t + validate(good);
    else t = t + validate(bad);
  }
  return t;
}

// boundary tax probe: 每 iter 对象 alloc + 属性读（tagged qz.* call_indirect）。
function tagLoop(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) { const o: any = { x: i }; t = t + o.x; }
  return t;
}

// 4) mixed: tagged setup (object literal / property access) outside a hot numeric loop.
//    M7 target: the loop is pure-numeric → extract to a num AOT fragment; tagged setup stays.
function mixedWork(n: number): number {
  const cfg = { mul: 3 };
  const base = cfg.mul;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = i % 1000;
    const v = a * a;
    s = (s + v - ((v / 7) | 0) + ((i * 3) % 13)) % 1000003;
  }
  return s + (base > 0 ? 0 : 1);
}
