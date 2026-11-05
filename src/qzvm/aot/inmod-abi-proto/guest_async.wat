;; in-module 异步回流原型（§10.4 import 拉模型）
;;
;; 验证：宿主异步完成 → 写完成队列 → guest 拉（drain）→ resolve
;; 这是 promise 回流的骨架（真实版 resolve 持 guest 内 JSValue，此原型用整型 op_id）

(module
  ;; 发起异步 fs 读：返回 op_id（§10.3 qz_host_fs_read）
  (import "qz_host" "fs_read" (func $fs_read (param $ptr i32) (param $len i32) (result i32)))
  ;; 拉取完成事件：写进 [ptr, ptr+max)，返回字节数（0=无）（§10.4 qz_host_drain）
  (import "qz_host" "drain" (func $drain (param $ptr i32) (param $max i32) (result i32)))
  ;; 宿主时钟，用于"轮询等到完成"（模拟 tick 循环）
  (import "qz_host" "now" (func $now (result i64)))

  (memory (export "memory") 1)

  ;; 路径 "guest.txt" @ 64
  (data (i32.const 64) "guest.txt")

  ;; 完成事件缓冲 @ 128（长 64）
  (global $evbuf i32 (i32.const 128))

  ;; 结果状态（供宿主读回校验）：[0]=op_id, [4]=drain 轮数, [8]=收到的字节数
  (func (export "run_async") (result i32)
    (local $op i32)
    (local $rounds i32)
    (local $n i32)

    ;; 发起异步读
    (local.set $op (call $fs_read (i32.const 64) (i32.const 9)))  ;; "guest.txt" len=9
    (i32.store (i32.const 0) (local.get $op))

    ;; 模拟 tick 循环：反复 drain 直到拿到事件（上限防单核饿死 worker）
    (local.set $rounds (i32.const 0))
    (block $done
      (loop $spin
        (local.set $n (call $drain (global.get $evbuf) (i32.const 64)))
        (local.set $rounds (i32.add (local.get $rounds) (i32.const 1)))
        (br_if $done (i32.gt_s (local.get $n) (i32.const 0)))
        (br_if $done (i32.gt_u (local.get $rounds) (i32.const 200000000)))
        (br $spin)
      )
    )
    (i32.store (i32.const 4) (local.get $rounds))
    (i32.store (i32.const 8) (local.get $n))
    (local.get $n))   ;; 返回收到字节数
)
