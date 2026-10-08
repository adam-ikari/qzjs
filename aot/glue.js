const bytes = Uint8Array.from(atob("AGFzbQEAAAABDQNgAX8Bf2AAAGABfwACCwEDZW52A2xvZwACAwMCAAEFAwEAAAYGAX8BQQALBxkDA2ZpYgABBm1lbW9yeQIABl9zdGFydAACCjECHAAgAEECSAR/IAAFIABBAWsQASAAQQJrEAFqCwsSACMABEAPC0EBJABBFBABEAAL"), c => c.charCodeAt(0));
const mod = new WebAssembly.Module(bytes);
const inst = new WebAssembly.Instance(mod, {
  env: { log: (n) => console.log("fib(20) = " + n) }
});
inst.exports._start();            // wasm→JS: AS start 调 log(fib(20))
const r = inst.exports.fib(25);   // JS→wasm: 调导出 fib
console.log("fib(25) = " + r);
