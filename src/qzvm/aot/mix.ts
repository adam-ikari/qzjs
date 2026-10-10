// 快路径（纯 number）：fib 递归 + 循环
function fib(n: number): number {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
function numWork(iters: number): number {
  let s = 0;
  for (let i = 0; i < iters; i++) s = s + fib(20 + (i % 5));
  return s;
}
// tagged（对象 I/O）：创建对象 + 属性访问 + 数值累加
function objWork(n: any): any {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const r = { id: i, sq: i * i, tag: "r" };
    total = total + r.id + r.sq;
  }
  return total;
}
// tagged 数值精度：累加超 32 位（f64 rep 精确；旧 i32 31 位模型会溢出）
function bigAcc(n: unknown): unknown {
  let total = 0;
  for (let i = 0; i < n; i++) total = total + 1000000000;
  return total;
}
