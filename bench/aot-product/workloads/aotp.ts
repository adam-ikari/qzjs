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
// 注意：本函数由 bench 构建脚本显式标记 --interp（不编 wasm）。
// 原因：JSON.parse 产宿主对象，每轮 prop_get 6 + get_index 4 + builtin 1 次跨界；
// CI 实测 wasm-AOT 0.50× 于 qzjs 解释，属负优化 → 留 interp。
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
// @qz-pure
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
// validate 已标注为纯函数 → LICM 把两个循环不变调用外提，循环体变纯 f64 → M7 抽 num 片段。
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

// ── 真实场景（取自 qzjs polyfill / 设备策略的纯计算形态）──
// HPACK RFC7541 §5.1 整数编码长度（hpack.js encodeInt 数值部分）
function hpackIntBatch(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    let v = (i * 7919) >>> 0;
    let len = 1;
    while (v > 0x7f) { v = v >>> 7; len = len + 1; }
    t = t + len;
  }
  return t;
}
// protobuf varint 长度（protobuf.js Writer.varintNum 数值部分）
function varintBatch(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    let v = (i * 104729) % 2147483647;
    let len = 1;
    while (v > 0x7f) { v = v >>> 7; len = len + 1; }
    t = t + len;
  }
  return t;
}
// FNV-1a 风格滚动哈希（帧/缓存键校验）
function hashBatch(n: number): number {
  let h = 2166136261 % 16777216;
  for (let i = 0; i < n; i++) {
    h = (h ^ (i * 7919)) % 16777216;
    h = (h * 33) % 16777216;
  }
  return h;
}
// 固定设备策略的重复评估（LICM 形态）
// @qz-pure
function policyScore(cfg: any): number {
  let s = 0;
  if (cfg.retry < 0) s = s + 1;
  if (cfg.timeout > 5000) s = s + 1;
  if (cfg.name.length < 3) s = s + 1;
  return s;
}
function policyGate(n: number): number {
  const strict = { retry: 3, timeout: 1000, name: "strict-mode" };
  const loose = { retry: -1, timeout: 9000, name: "x" };
  let t = 0;
  for (let i = 0; i < n; i++) {
    if ((i % 2) === 0) t = t + policyScore(strict);
    else t = t + policyScore(loose);
  }
  return t;
}
