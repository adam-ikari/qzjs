const bench_wasm = new Uint8Array([0,97,115,109,1,0,0,0,1,12,2,96,2,126,126,1,126,96,1,126,1,126,2,26,2,2,113,122,6,109,101,109,111,114,121,2,0,1,2,113,122,6,113,122,95,97,100,100,0,0,3,2,1,1,7,9,1,5,98,101,110,99,104,0,1,10,46,1,44,1,2,126,66,3,33,2,66,0,33,1,2,64,3,64,32,1,32,0,89,13,1,32,2,66,4,16,0,33,2,32,1,66,1,124,33,1,12,0,11,11,32,2,11]);

// M6b 量税: multi-module 调用税 vs JS shim 3.55µs
try {
  const mod = new WebAssembly.Module(bench_wasm.buffer);
  const inst = new WebAssembly.Instance(mod, {});
  const N = 1000000n;
  // warmup
  inst.exports.bench(1000n);
  const t0 = performance.now();
  const r = inst.exports.bench(N);
  const t1 = performance.now();
  const dt_ms = t1 - t0;
  const ns_per_call = (dt_ms * 1e6) / Number(N);
  console.log("bench N=" + N + " r=" + r + " dt=" + dt_ms.toFixed(2) + "ms");
  console.log("multi-module 调用税: " + ns_per_call.toFixed(1) + "ns/call");
  console.log("对比 JS shim 3.55µs/call (aot-performance-model): " + (3550/ns_per_call).toFixed(1) + "x 加速");
} catch (e) {
  console.log("ERR:", e.message || e);
}
