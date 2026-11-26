// 实验负载：纯数值循环 + 字符串尾部。编译成 qzjs 字节码后，循环区间走 wasm，
// 尾部 get_length + add 仍由 qzjs 解释执行。
function work(n) {
  let s = 0;
  for (let i = 0; i < n; i = i + 1) {
    const a = i % 1000;
    s = (s + a * a + ((i * 3) % 13)) % 1000003;
  }
  const tag = "v1";
  return s + tag.length;
}
globalThis.work = work;
