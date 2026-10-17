;; in-module 跨界税 bench：空 import vs 带负载（读内存）
(module
  (import "qz_host" "noop" (func $noop (param i32) (result i32)))
  (import "qz_host" "sink" (func $sink (param i32) (param i32) (result i32)))  ;; (ptr, len)
  (memory (export "memory") 1)
  (data (i32.const 16) "0123456789abcdef0123456789abcdef")  ;; 32B 负载

  ;; 空跨界 N 次
  (func (export "bench_cross") (param $n i32) (result i32)
    (local $i i32)
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (drop (call $noop (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (local.get $i))

  ;; 带负载跨界 N 次（host 读 32B 内存）
  (func (export "bench_payload") (param $n i32) (result i32)
    (local $i i32)
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (drop (call $sink (i32.const 16) (i32.const 32)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (local.get $i))

  ;; 纯 wasm
  (func (export "bench_native") (param $n i32) (result i32)
    (local $i i32) (local $acc i32)
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $acc (i32.add (local.get $acc) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (local.get $i))
)
