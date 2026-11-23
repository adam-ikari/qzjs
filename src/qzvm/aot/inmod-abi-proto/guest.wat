;; in-module 跨界 ABI 最小原型（对应 IN_MODULE_DESIGN.md §10）
;;
;; 验证 §10 的两个核心主张：
;;   (1) guest 经 wasm import 调宿主能力（qz_host.*）
;;   (2) 内存按 ptr+len 传字节（不在 wasm 外碰 JSValue）
;;
;; import module 名 "qz_host"（§10.6：与 AOT 的 "qz.*" 值原语隔离）

(module
  ;; 宿主能力：日志（§10.3 qz_host_log）
  (import "qz_host" "log" (func $host_log (param $level i32) (param $ptr i32) (param $len i32)))
  ;; 宿主能力：时钟（§10.3 qz_host_now）
  (import "qz_host" "now" (func $host_now (result i64)))

  (memory (export "memory") 1)

  ;; 静态字符串 "hello from wasm guest\n" @ offset 16
  (data (i32.const 16) "hello from wasm guest\n")

  ;; 阶段 A：同步调宿主 log（ptr+len 传字节）
  (func (export "greet")
    (call $host_log
      (i32.const 1)      ;; level = warn
      (i32.const 16)     ;; ptr
      (i32.const 22)))   ;; len

  ;; 阶段 B：调宿主 now()，把 i64 返回值写回内存第 0..8 字节，
  ;; 返回 ptr(=0) + len(=8)，模拟"完成事件取回"的回流形态（§10.4 import 拉）
  (func (export "pull_now") (result i32)
    (i64.store (i32.const 0) (call $host_now))
    (i32.const 0))     ;; 返回 buf 起点；host 侧读 8 字节
)
