---
id: a2-worker-robustness
title: "A2 多上下文/Worker 健壮性（软挂起边界 + transferable 错误路径 + 错误事件流 + 压力）"
category: decision
status: active
tags: [worker, suspend, transferable, robustness, gtest]
created: "2026-08-28T15:53:09"
updated: "2026-09-13T00:44:30"
---

<!-- compiled_truth -->
- **范围**：ROADMAP A2「多上下文 / Worker 健壮性」= 软挂起恢复边界、transferable 泄漏、worker 错误事件流全覆盖，交付 gtest + 压力。全部落在 test_suspend_gtest.cpp（+4 例）与 test_worker_gtest.cpp（+8 例：6 错误路径 + 2 压力）。
- **软挂起边界语义（测试文档化）**：
  - destroy 已挂起槽位后 `resume(1,'',path)` 合法：状态完全来自 state 文件，恢复后再 suspend 字节一致（restore 真实回写）。
  - 坏 state 路径：文件被删后 resume → C 读盘失败 → TypeError 抛回 JS，主 context 不受影响。
  - **skipped 属性首次 restore 后永久丢失**（设计行为）：不可克隆属性（函数）记入 skipped，restore 无从重建 → 第二次快照 skipped 少该键。可克隆数据完整往返。断言写法：第二次 skipped ⊆ 第一次 + data 字节一致，而非两次快照字节全等。
  - suspend→resume(init) 循环 10 轮：rebuild 先 eval init 再 restore；restore 只写回捕获键、不删 init 新键 → init 写独有键可跨轮保留，槽位稳定复用，主 context 全程可用。
- **transferable 错误路径**：transfer 列表重复对象 / 非 transferable（普通对象）→ DataCloneError 且无副作用（buffer 不 detach、消息不发）；已 detach 的 ArrayBuffer 再进 transfer 列表 → DataCloneError（本次修复，见下）。
- **Worker 生命周期错误路径**：new Worker('http://…') → Error（loadScript 校验）、new Worker('file://不存在') → TypeError（fsReadSync 透传）；失败构造不占槽位，后续 spawn 正常。terminate 后 postMessage/重复 terminate 静默安全。父侧 onmessage handler 抛错 → reportError，worker 存活。跨线程回显有竞态：'a' 的回显可能恰在父侧替换 handler 后到达——断言目标消息到达即证存活，不做条数/顺序假设。
- **timer 回调异步错误进错误事件流（本次修复）**：timers.js 的 setTimeout/setInterval catch 原本只 console.error → worker 内 self.onerror 收不到异步异常。修复：catch 后调 `reportError(err)`（typeof 守卫，navigator.js 晚于 timers 挂载）再打日志。worker.c 顶层 throw 路径（ErrorEvent + {type:'error'} 父通知）不变。
- **detached ArrayBuffer transfer 校验（本次修复）**：structured-clone.js 两处校验（structuredClone options.transfer、serializeToBytes transfer）补 `t.detached` 检查 → `DOMException('ArrayBuffer has already been detached', 'DataCloneError')`。
- **压力**：4 worker × 20 消息洪泛（80 回显集合全等）；30 轮 ArrayBuffer transfer 往返链（父发→detach 校验→worker echo→内容逐轮校验）。
- **验证**：test_suspend_gtest 6/6、test_worker_gtest 23/23、全量 offline ctest 14/14（test_compress_gtest Deflate 用例偶发 flaky：负载尖峰下超边界，复跑即绿，与本改动无关）。


## Timeline

- time: 2026-08-28T15:53:09
  kind: decision
  summary: "Created this page: A2 多上下文/Worker 健壮性（软挂起边界 + transferable 错误路径 + 错误事件流 + 压力）"
  source: 2026-08-28 A2 session
  affects: [a2-worker-robustness]

- time: 2026-08-28T15:53:31
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: 2026-08-28 A2 session
  affects: [a2-worker-robustness]

- time: 2026-09-07T08:02:42
  kind: note
  summary: "M-P1 多进程/worker 健壮性落地（commit 8e18b988），含 socketpair spawn/§3.3 handshake/3-tier terminate/worker_background 分流及 teardown UAF 修复，e2e + 24/24 worker gtest + 4/4 套件全绿。"
  source: "M-P1 合入 master commit 8e18b988"
  affects: [a2-worker-robustness]

- time: 2026-09-08T12:14:19
  kind: note
  summary: "已知限制：PROCESS 后端（QZ_WORKER_BACKEND=process）单 worker 连续 postMessage 往返 >~500-1000 条洪水下间歇卡死（JS 派发深层丢帧 + 帧错位双模式）。已修 3 处确证根因（背压 EAGAIN 静默丢帧→spill buffer、ENOBUFS 丢整包→按背压、JS 异常污染→JS_GetException）。残余已排除：写路径丢帧、读侧停/死锁、子进程崩溃、JS_NewArrayBufferCopy 异常。风险点：A) worker.js deliverToWorker 派发深层；B) 父 rbuf 解帧错位（oversized flen 异常）；C) spill buffer 多 proc/重连未验证。基准 R3/R4 以分批≤40 条 workaround。根治方向：JS 派发丢帧 + 帧错位。见 commit fix(proc) PROCESS worker 消息挂死。"
  source: "2026-09-07 PROCESS 洪水基准修复会话"
  affects: [a2-worker-robustness]

- time: 2026-09-08T12:14:27
  kind: note
  summary: "已知限制：PROCESS 后端（QZ_WORKER_BACKEND=process）单 worker 连续 postMessage 往返 >~500-1000 条洪水下间歇卡死（JS 派发深层丢帧 + 帧错位双模式）。已修 3 处确证根因（背压 EAGAIN 静默丢帧→spill buffer、ENOBUFS 丢整包→按背压、JS 异常污染→JS_GetException）。残余已排除：写路径丢帧、读侧停/死锁、子进程崩溃、JS_NewArrayBufferCopy 异常。风险点：A) worker.js deliverToWorker 派发深层；B) 父 rbuf 解帧错位（oversized flen 异常）；C) spill buffer 多 proc/重连未验证。基准 R3/R4 以分批≤40 条 workaround。根治方向：JS 派发丢帧 + 帧错位。见 commit fix(proc) PROCESS worker 消息挂死。"
  source: "2026-09-07 PROCESS 洪水基准修复会话"
  affects: [a2-worker-robustness]

- time: 2026-09-08T14:14:04
  kind: decision
  summary: "已根治：PROCESS 洪水卡死（前述已知限制解除）。确证根因 = src/ipc_process.c proc_read_cb 缺 memcpy(rbuf, buf->base)（commit 9b7c0781 误删）——父读回调读入字节从未真正进 rbuf，前 ~950 帧靠 malloc 地址复用凑巧工作（首次 realloc 复用刚 free 的 buf 内存块），rbuf 扩容 realloc 移块后数据全丢 + rbuf_len 虚增 → 解帧读垃圾 → oversized flen 0x40100000 → 假卡死（rcvd 停 ~1159）；且原始代码 UAF（free 在 memcpy 前）。修复：恢复 memcpy（rbuf_len+= 前）+ free 移到每分支 memcpy 后（与子侧 rt_main.c pipe_read_cb 一致）。验证：10000 条洪水 7/7 PASS + mp1 e2e PASS。PROCESS 后端可支撑 10000 条连续往返，基准 R3/R4 分批 workaround 可移除。"
  source: "2026-09-08 PROCESS 洪水根治会话"
  affects: [a2-worker-robustness]

- time: 2026-09-08T15:27:55
  kind: note
  summary: "THREAD 后端 terminate 不释放 worker 槽位（QZ_MAX_WORKERS=16）：spawn/terminate 16 次后槽位耗尽直到 teardown——动态大量 worker 的宿主受限，M-P2 parity 关注。"
  affects: [a2-worker-robustness]

- time: 2026-09-08T15:27:55
  kind: note
  summary: "性能特征：R3 postMessage 往返 64KB payload 实测 ~140ms/op（序列化主导，双后端 ~1×）——大 payload 往返远慢于小 payload，基准采样需按 payload 分级。"
  affects: [a2-worker-robustness]

- time: 2026-09-13T00:44:30
  kind: decision
  summary: "消息层三规范修复落地（commit 10e582fd）：1) EventTarget once 监听器改为 invoke 前移除——原 invoke 后移除，once 回调内再 dispatch 同事件会重复触发；2) MessagePort 本地 structured clone 失败改为发送方抛 DataCloneError——原误派到对端 messageerror，违反 HTML 规范错误归属；3) BroadcastChannel 每 peer 独立 clone——原各 channel 共享同一副本，B 处修改在 C 处可见，违反规范隔离语义。三者均为规范语义偏差修复，gtest 覆盖。"
  source: "2026-09-13 修复所有定案会话"
  affects: [a2-worker-robustness]
