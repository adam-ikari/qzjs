const wasm = new Uint8Array([0,97,115,109,1,0,0,0,1,7,1,96,2,126,126,1,126,2,26,2,2,113,122,6,109,101,109,111,114,121,2,0,1,2,113,122,6,113,122,95,97,100,100,0,0,3,2,1,0,7,12,1,8,116,101,115,116,95,97,100,100,0,1,10,10,1,8,0,32,0,32,1,16,0,11]);
console.log("wasm len:", wasm.length);

// M6b PoC: multi-module import 链接验证
// wasm import "qz" "memory" + "qz" "qz_add" → reader 加载 libqzvm.wasm → 链接
try {
  const mod = new WebAssembly.Module(wasm.buffer);
  console.log("Module compiled");
  const inst = new WebAssembly.Instance(mod, {});
  console.log("Instance created");
  const r = inst.exports.test_add(3n, 4n);
  console.log("test_add(3,4) =", r, "(expect 7)");
} catch (e) {
  console.log("ERR:", e.message || e);
}
