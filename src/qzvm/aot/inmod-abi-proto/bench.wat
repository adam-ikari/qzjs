;; in-module 跨界税 bench（i32 返回，宿主侧计时）
(module
  (import "qz_host" "noop" (func $noop (param i32) (result i32)))
  (memory (export "memory") 1)

  ;; N 次跨界调用，返回 N
  (func (export "bench_cross") (param $n i32) (result i32)
    (local $i i32)
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (drop (call $noop (local.get $i)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (local.get $i))

  ;; N 次纯 wasm 循环，返回 N
  (func (export "bench_native") (param $n i32) (result i32)
    (local $i i32) (local $acc i32)
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $acc (i32.add (local.get $acc) (local.get $i)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (local.get $i))
)
