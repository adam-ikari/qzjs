// AS wasm 性能 bench：fib(i64) 递归 —— 验证原生指令的真实吞吐。
// 数值运算走 i64.add 原生指令（零桥），对比 qzjs 解释器与 ts2c so（int64）。

@external("qz", "dump")
declare function dump(v: i32): void;

@external("qz", "new_number")
declare function new_number(n: i32): i32;

// i64 递归 fib —— 编译为原生 i64 指令
export function fib(n: i64): i64 {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

// bench: N 次 fib(25)，结果累加（防死代码消除）
export function bench(iters: i32): i64 {
  let s: i64 = 0;
  for (let i = 0; i < iters; i++) {
    s += fib(25);
  }
  return s;
}

// start: iters 从环境无法读 —— 固定 100 次，dump 结果（100 * 75025 = 7502500）
dump(new_number(<i32>bench(100)));
