;; M6b PoC: minimal libqzvm dummy（无 import，验 multi-module 机制）
;; 真实 libqzvm 有 qz_host/wasi 依赖，submodule native registration 是后续工程。
(module
  (memory (export "memory") 1)
  (func (export "qz_add") (param i64 i64) (result i64)
    local.get 0
    local.get 1
    i64.add)
)
