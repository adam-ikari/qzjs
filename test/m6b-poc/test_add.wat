;; M6b PoC: 验 multi-module import 链接机制
;; import "qz" "memory" + "qz" "add" → 经 reader 加载 libqzvm.wasm → 链接
(module
  (import "qz" "memory" (memory 1))
  (import "qz" "add" (func $qz_add (param i64 i64) (result i64)))
  (func (export "test_add") (param i64 i64) (result i64)
    local.get 0
    local.get 1
    call $qz_add)
)
