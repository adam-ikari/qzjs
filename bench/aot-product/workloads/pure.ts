function computeWork(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) { const a = i % 1000; const v = a * a;
    s = (s + v - ((v / 7) | 0) + ((i * 3) % 13)) % 1000003; }
  return s;
}
function hpackIntBatch(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) { let v = (i * 7919) >>> 0; let len = 1;
    while (v > 0x7f) { v = v >>> 7; len = len + 1; } t = t + len; }
  return t;
}
function varintBatch(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) { let v = (i * 104729) % 2147483647; let len = 1;
    while (v > 0x7f) { v = v >>> 7; len = len + 1; } t = t + len; }
  return t;
}
function hashBatch(n: number): number {
  let h = 2166136261 % 16777216;
  for (let i = 0; i < n; i++) { h = (h ^ (i * 7919)) % 16777216; h = (h * 33) % 16777216; }
  return h;
}

// 与 run_polyfill.js 的 hpack varint 算法完全一致（用于 wasm2c 加速 polyfill 对照）
function polyfillBatch(n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const value = (i * 7919) % 1000003;
    const mask = 127;
    if (value < mask) { t = t + 1; continue; }
    let len = 1, v = value - mask;
    while (v >= 128) { len = len + 1; v = (v / 128) | 0; }
    t = t + len + 1;
  }
  return t;
}
