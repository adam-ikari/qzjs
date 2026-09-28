---
id: multi-process-model
title: "多进程模型 M-P0..M-P5 + CTL + M-R2（宿主⇄主RT 进程模型与 path 链路由）"
category: decision
status: active
created: "2026-09-15T23:20:12"
updated: "2026-09-28T17:18:17"
---

<!-- compiled_truth -->
ISOLATED 是缺省进程模型（M-P2，用户裁决最终态；-DQZ_PROCESS_MODEL=THREAD 回退）：宿主进程 ⇄ 独立主RT 进程（qzjs-rt）经单条 socketpair uv_pipe 通信，JS/loop/微任务全在主RT 进程内；worker 进程树经嵌套 spawn（N-P1）展开，端点身份为 §8.2 path 链（u16[]，根起逐级槽位 id；LCA 前缀比较路由，零路由表；PORT_TRANSFER 变长头；信封 source/target int32 冻结 schema 零改动）。控制面 CTL-1/CTL-2：qzjs-ctl CLI + AF_UNIX 端点 + SO_PEERCRED，树路由经 target_path。

**主权原则（用户裁决，凌驾具体形态）**：宿主形态不是 qzjs 能干涉的；qzjs 完全自主管理自己的进程和线程；与宿主通讯只用 postMessage 机制——qzjs 不跨线程调用宿主任何函数。

**宿主侧契约 = M-P7 mailbox（现状，2026-09-28 落地并全量验证，取代并废除 M-P6 注入契约）**：库自管宿主侧泵线程+loop（M-P2 形态回归，RT_LOOP=&rt->loop）；host 方向消息（JS postMessage、崩溃 {"type":"error"} 上报、CONTROL 回执顶层 "ctl":true+correl）入 per-rt FIFO 邮箱（msgq 泛化为第二 MPSC 实例 mq_out，ACQ_REL 算法零修改、无 mutex/cond/futex）。宿主在自选线程、自选时机消费：qz_recv_message(rt,&json,&len,timeout_ms)（timeout_ms >0 阻塞 / 0 非阻塞 poll / -1 无限；返回 0=取到 NUL 终止 JSON 由 qz_free_message 释放 / 1=超时 / -1=错误）+ qz_message_fd(rt) 唤醒 fd（eventfd，可读=邮箱非空，先入链后写 fd 保证不丢唤醒，宿主不得 close、free 后失效、Linux-only；挂 fd 等待唯一姿势=①recv(0) 排干并处理→②read(fd) 清至 EAGAIN→③再探 recv(0) 有则回①无才可 poll 阻塞；单消费者：多线程可并发 recv 但同一时刻只一个 fd 等待者）。cfg.uv_loop、message_cb、host_data、qz_get/set_runtime_data 回调面整体移除；回调重入规则随之作废；qz_msg_push 内建 uv_async_send 剥离、唤醒由各入站调用点显式发出；主RT 子进程上行经内部钩子 rt->host_emit，THREAD/worker 分流经 qz_post_to_host（host_emit 上行 / worker_self 丢弃 / 否则入箱）。qz_free 双角色守卫（magic==QZ_MAGIC && thread_joined → 排干邮箱+关 out_efd+释放 config，否则裸 free）。

**I5②clause 复活**：三级终止 ≤2s 冻结回到库泵线程内执行，宿主调用线程只等 join。Liveness ping 家族：宿主→主RT（qz_ping）、宿主→树中任意 worker（qz_ping_path，tp 回显转发/pfail 快拒）、worker→sub（Worker.prototype.ping）；0=通畅/1=超时(loop 阻塞)/-1=死；ping/wait_idle 的阻塞等待在库泵线程内自旋+sched_yield/原子回填，邮箱不受影响。崩溃帧时序：EOF 里先入箱、后 RELEASE 置 shutting_down，wait_idle 的 acquire spin 退出时帧必在箱内（wait_idle 后、qz_free 前仍可 recv——mp4 stderr 门依赖此序）。

storage 单所有者（owner=树根主RT，§10.2）非根节点中继上行（N-P4 corr 并发关联）；owner 死 ⇒ 孤儿连锁自杀即设计终点（降级不实施）。系统级 CONTROL（ready/idle/shutdown/ping 家族，"qzjs" 标记）在 rt_main.c C 读泵就地消费、不入 msgq/JS——否则心跳被控制面当命令回 UNKNOWN_CMD 泄漏进宿主邮箱（M-P7 箱净门捕获）。

延后项终判：tier-2 超时异步化维持 DEFERRED（①正常路径 ~1ms 仍立；③跨 loop 属主迁移风险仍立；②随 M-P7 冻结回到库泵线程而恢复原理由）；path u16→u32 YAGNI 维持；§10.2 降级不实施。深度上限 QZ_SELF_PATH_MAX=8、storage 中继单飞行仍为已知缺口。


## Timeline

- time: 2026-09-15T23:20:12
  kind: decision
  summary: "Created this page: 多进程模型 M-P0..M-P5 + CTL + M-R2（宿主⇄主RT 进程模型与 path 链路由）"
  source: "2026-09-15 多进程轨道落地会话"
  affects: [multi-process-model]

- time: 2026-09-15T23:20:22
  kind: decision
  summary: "M-P0..M-P5 + CTL + M-R2 全部落地（commit 范围 2295e402..b92709c7），多进程轨道完整落地。"
  source: "2026-09-15 多进程轨道落地会话"
  affects: [multi-process-model]

- time: 2026-09-15T23:20:23
  kind: decision
  summary: "M-P2 缺省 ISOLATED：qzjs 缺省宿主⇄主RT 独立进程（-DQZ_PROCESS_MODEL=THREAD 回退）——用户裁决，最终态。"
  source: "2026-09-15 多进程轨道落地会话"
  affects: [multi-process-model]

- time: 2026-09-15T23:20:23
  kind: decision
  summary: "M-P5 嵌套 spawn + §8.2 path 链路由：worker 再 spawn worker（孙）；端点身份 int32→path 链（u16[]，根=[]，子=父path++槽位）；LCA 前缀比较路由（上/本地/下投），零路由表；PORT_TRANSFER 头 16B→变长；信封 source/target 冻结 schema 零改动（wire 兼容）。"
  source: "2026-09-15 多进程轨道落地会话"
  affects: [multi-process-model]

- time: 2026-09-15T23:20:30
  kind: decision
  summary: "Q1-Q3 裁决：① path 放 payload（PORT 头变长 + CTL target_path），信封 int32 只放当前跳；② (owner,id)→path，扁平退化 worker.path=[slot]/mainRT.path=[]，单元素退化为旧语义；③ path 元素 u16（>65535 升 u32）。"
  source: "2026-09-15 多进程轨道落地会话"
  affects: [multi-process-model]

- time: 2026-09-15T23:20:31
  kind: decision
  summary: "CTL-1/CTL-2：控制面树路由 + qzjs-ctl CLI（AF_UNIX 端点 + SO_PEERCRED uid 校验）。"
  source: "2026-09-15 多进程轨道落地会话"
  affects: [multi-process-model]

- time: 2026-09-15T23:20:31
  kind: decision
  summary: "M-R2：多 RT 组合 gtest（contexts × workers 正交）。"
  source: "2026-09-15 多进程轨道落地会话"
  affects: [multi-process-model]

- time: 2026-09-15T23:20:36
  kind: decision
  summary: "已知延后：tier-2 超时异步化（§9.2/I5）、§10.2 所有者死亡降级、STORAGE 中继并发关联 id、path u32 升级。"
  source: "2026-09-15 多进程轨道落地会话"
  affects: [multi-process-model]

- time: 2026-09-15T23:20:36
  kind: decision
  summary: "watch-item：mp4 e2e 本地挂（worker localStorage→主RT 同步 RPC）待查。"
  source: "2026-09-15 多进程轨道落地会话"
  affects: [multi-process-model]

- time: 2026-09-17T04:05:45
  kind: decision
  summary: "watch-item 关闭：mp4 storage 同步 RPC「本地挂」经 2026-09-16 量化验证 = 非真 bug，环境/设计误判。ISOLATED 进程模型 test_mp4_storage_crash_e2e.sh 3/3 通过（6.8–7.7s/次，脚本 timeout 30s，CI e2e 无 timeout-minutes 默认 360min，风险低）；THREAD 构建无 process 后端，脚本 probe.js 检测 PROC-ERR → SKIP 退出 0（设计如此），「挂」系绕过探针直接跑 fixture 所致；worker_storage.js 6MB setItem 超 5MiB quota → QuotaExceededError（设计预期），payload 整帧 RPC 到 owner 后才检查，单次 ~7.5s = 同步 RPC 大 payload 线性成本（~1.1ms/KB，src/ipc_process.c emit_sync + src/rt_main.c pipe_read_cb），非死锁。证据：test/test_mp4_storage_crash_e2e.sh、test/mp4-e2e/*.js。"
  source: "2026-09-16 量化验证会话"
  affects: [multi-process-model]

- time: 2026-09-17
  kind: decision
  summary: "延后项复查：tier-2 超时异步化（§9.2/I5）→ 维持 DEFERRED（非真问题，不实施）。qz_proc_terminate（src/ipc_process.c:453）同步三级终止，最坏 2s/挂死 worker，但①冻结只在已损坏（无视 shutdown）子进程兑现，正常退出 ~1ms；②嵌入宿主自身从不阻塞——宿主侧 terminate 仅 destroy 路径（rt_host.c:160，专用 loop 线程，非宿主主线程），JS 侧 processTerminate（bridge.c:1927）冻结的是主RT 自身 loop（ISOLATED 缺省为独立进程）；③异步化须迁移 pid 属权与 proc 生命周期跨 loop tick，4 个调用点均紧跟 qz_proc_free（假设 terminate 返回即已收尸）→ UAF/双释放风险大于收益。详见 CHANGELOG。"
  source: "tier-2 超时异步化调查会话"
  affects: [multi-process-model]

- time: 2026-09-18
  kind: decision
  summary: "延后项复查：path 元素 u16→u32 → 维持 u16（YAGNI，不实施）。证据：QZ_MAX_PROC_HANDLES=64 并发进程句柄/rt（qz_internal.h:135），path 深度上限 QZ_SELF_PATH_MAX=8（:138）；path 元素 = 各 runtime 本地单调计数器 procWorkerSeq（polyfill/src/worker.js:66，1000 起），溢出须单 runtime 累积 >6.45 万次 PROCESS spawn（id 每 runtime 本地分配，非全局），现实不可达；rt_main.c:600 已有 v<=0xFFFF 解析守卫。非 path 字段 key_port 本为 u32，无其他溢出点。升 u32 须改 PORT_TRANSFER 头变长公式 8+2*(dl+kl)→8+4*(dl+kl)，破坏 §4.1 冻结 schema / §7.2 字节不动 wire 兼容 → 超出低成本，维持延后。详见 CHANGELOG。"
  source: "path u16 升级调查会话"
  affects: [multi-process-model]

- time: 2026-09-18
  kind: decision
  summary: "延后项复查：§10.2 所有者死亡降级 → 不实施，孤儿自杀即设计终点（§9.4 优先）。owner 死亡时孤儿自杀而非存活降级：主RT 死 → parent-fd EOF → shutting_down → teardown → exit（rt_main.c:348-353）；storage 代理同步 RPC 收 EOF → storageSync 抛 InternalError → 连锁自杀（bridge.c:2053、local-storage.js:27-28）。判定不实施：① §9.4 连锁死亡是预期行为，§6.4 通道不重连，孤儿存活即成不可达死进程；② 降级态结构上不可达——owner 恒为树根主RT（§10.2+N-P4），owner 死 ⇒ 祖先全死 ⇒ 任何孤儿必经 §9.4 自杀；③ 计划 §10.2 降级兜底（快照只读+LWW）破坏单所有者不变量且与现有 e2e 级联断言冲突。详见 CHANGELOG。"
  source: "§10.2 所有者死亡降级调查会话"
  affects: [multi-process-model]

- time: 2026-09-28T11:27:31
  kind: reversal
  summary: "M-P6 契约翻转：ISOLATED 宿主侧库私有「宿主 loop 线程」（host_thread_main）废除——宿主必须经 cfg.uv_loop 注入自己的 uv_loop_t（NULL→qz_create 显式失败，§5.3 不降级），库把宿主侧通道句柄（管道读泵/wake async/tx 溢出定时器）全部挂上，message_cb 在泵宿主 loop 的线程触发。配套：①create ready 改同步 raw-fd 帧读（qz_proc_wait_ready_raw，先于 uv_read_start；pre-ready 脚本帧暂存 proc->pre_frames 上限 256，读泵注册后 FIFO 重放——主RT eval 先于 emit ready 的既有顺序 hazard 由此闭合）；②阻塞宿主 API（qz_ping/qz_ping_path/qz_wait_idle/qz_destroy）就地泵（UV_RUN_NOWAIT+yield），message_cb 可在调用内重入触发→规则：cb 内禁调阻塞宿主 API；③库永不 UV_RUN_DEFAULT/uv_loop_close 宿主 loop，teardown 后句柄全关可干净 close（wait_idle 后用 qz_free 释放 rt）。I5 复查记录②clause 作废：宿主侧 terminate 的 ≤2s 冻结原跑专用 loop 线程不碰宿主主线程，现落在调用线程上（单线程宿主 destroy 挂死主RT 时冻结 ≤2s+排干，mp5 实测 2006ms）——维持 DEFERRED 结论不变但理由②失效（①③仍立）。附带：ISOLATED message_cb payload 复制+NUL 终止（对齐 THREAD len+1 语义，两模型同）；host_teardown 排干 msgq 尾挂节点（pop 约定末节点由下次 pop 释放→无下次则漏，修 60B idle-req 泄漏）。CLI/examples/mp5 e2e/文档 EN+zh 全量翻转。"
  source: "2026-09-28 M-P6 宿主契约翻转会话"
  affects: [multi-process-model]

- time: 2026-09-28T11:28:40
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "2026-09-28 M-P6 宿主契约翻转会话"
  affects: [multi-process-model]

- time: 2026-09-28T13:59:40
  kind: decision
  summary: "wake 初始化先于读泵注册；pre-ready 帧在 qz_create 内同步重放可触发 message_cb"
  affects: [multi-process-model]

- time: 2026-09-28T14:27:57
  kind: decision
  summary: "库不在宿主进程私起线程/loop，宿主形态（线程拓扑/loop归属/泵节奏）qzjs 不干涉；库所需线程与进程全部置于库自治域"
  affects: [multi-process-model]

- time: 2026-09-28T14:48:28
  kind: reversal
  summary: "cfg.uv_loop 注入契约与 message_cb 回调一并废除：库完全自管线程/进程（宿主侧泵线程回归），host 方向消息入内部邮箱队列由宿主自取（阻塞带超时/非阻塞 poll/唤醒 fd），qzjs 不跨线程执行任何宿主代码；M-P6 注入形态为实现现状、M-P7 为裁决目标态，待实施"
  source: "2026-09-28 宿主通讯再裁决会话"
  affects: [multi-process-model]

- time: 2026-09-28T14:48:55
  kind: decision
  summary: "compiled truth 更新至 M-P7 再裁决：宿主通讯改 mailbox（qz_recv_message + 唤醒 fd），qzjs 不再调用宿主代码；M-P6 注入形态标注为过渡现状"
  source: "2026-09-28 宿主通讯再裁决会话"
  affects: [multi-process-model]

- time: 2026-09-28T17:17:52
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [multi-process-model]

- time: 2026-09-28T17:18:17
  kind: reversal
  summary: "M-P7 落地并全量验证，取代昨日刚落地的 M-P6 注入契约（commit f0178683..6c0ab934），闭环 M-P6 落地→M-P7 再裁决→M-P7 实施全程：M-P6 让宿主经 cfg.uv_loop 注入 loop、message_cb 在泵线程触发，被判定为对宿主形态的干涉（强加泵义务+libuv 同链接义务+回调重入规则），M-P7 整体废除。变更：①公共 API 删 message_cb/host_data/uv_loop 与 qz_get/set_runtime_data，新增 mailbox 三函数 qz_recv_message/qz_free_message/qz_message_fd（eventfd 唤醒 fd，先入链后写 fd 防丢唤醒，三步消费协议）；②msgq 泛化为第二 MPSC 实例 mq_out（ACQ_REL 零修改、无 mutex/cond/futex），qz_msg_push 剥离内建 uv_async_send→各入站点显式发；③ISOLATED 恢复库自建宿主侧泵线程+loop（基线 f0178683~1，RT_LOOP=&rt->loop，ipc_process 句柄绑定零改动），三级终止 ≤2s 冻结回库线程、调用线程只 join（I5②复活）；④THREAD 统一 mailbox，主RT 子进程上行经内部钩子 rt->host_emit，qz_post_to_host 三分流；⑤崩溃帧先入箱后置 shutting_down（wait_idle 后 free 前仍可 recv，mp4 门依赖）；⑥qz_free 双角色守卫（magic+thread_joined）；⑦CLI 改零 libuv 纯 poll 宿主（输出逐字节不变），examples hello/messages/worker 改 mailbox 宿主。测试：mp5-host-pump→mp7-mailbox 重写（去 libuv、六模式 basic/crash/hung/replay/fd/dual，basic ④ 未消费残留随 teardown 排干=漏 recv 无泄漏门），CMake/CI 接线。文档 EN+zh 33 页契约翻正。关键回归修复：系统级 CONTROL（ready/idle/shutdown/ping）在 rt_main.c C 读泵就地消费不入 msgq/JS（否则心跳回 UNKNOWN_CMD 泄漏进宿主邮箱破坏箱净门）。验证：mock ctest 25/25、THREAD ctest 25/25、ISOLATED Release 绿、mp1-4/mr2/ctl/nested 七 e2e 绿+mp7 全模式绿+ASAN basic/crash 零泄漏（漏排干/双 free 两政策）+worker-pool 520 任务无损。"
  source: "2026-09-28 M-P7 mailbox 落地会话"
  affects: [multi-process-model]
