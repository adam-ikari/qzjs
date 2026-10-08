// AS 部分（静态数值）：fib + @external log（由 JS 胶水提供）
@external("env", "log")
declare function log(n: i32): void;

export function fib(n: i32): i32 {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

// start: instantiate 时自动执行，调 fib(20) 经 log 输出（wasm→JS 方向）
log(fib(20));
