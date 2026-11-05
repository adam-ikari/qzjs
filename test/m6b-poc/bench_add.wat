;; M6b 量税 bench: 循环 N 次调 qz_add, 量 multi-module 调用税
(module
  (import "qz" "memory" (memory 1))
  (import "qz" "add" (func $qz_add (param i64 i64) (result i64)))
  (func (export "bench") (param $n i64) (result i64)
    (local $i i64) (local $acc i64)
    i64.const 3
    local.set $acc
    i64.const 0
    local.set $i
    (block $done
      (loop $loop
        local.get $i
        local.get $n
        i64.ge_s
        br_if $done
        local.get $acc
        i64.const 4
        call $qz_add
        local.set $acc
        local.get $i
        i64.const 1
        i64.add
        local.set $i
        br $loop))
    local.get $acc)
)
