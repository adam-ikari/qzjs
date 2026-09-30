---
id: multi-process-model
title: "多进程模型 M-P0..M-P5 + CTL + M-R2（宿主⇄主RT 进程模型与 path 链路由）"
category: decision
status: active
created: "2026-09-15T23:20:12"
updated: "2026-09-30T00:43:15"
---

<!-- compiled_truth -->
ISOLATED 是缺省进程模型（M-P2，用户裁决最终态；-DQZ_PROCESS_MODEL=THREAD 回退）：宿主进程 ⇄ 独立主RT 进程（qzjs-rt）经单条 socketpair uv_pipe 通信，JS/loop/微任务全在主RT 进程内；worker 进程树经嵌套 spawn（N-P1）展开，端点身份为 §8.2 path 链（u16[]，根起逐级槽位 id；LCA 前缀比较路由，零路由表；PORT_TRANSFER 变长头；信封 source/target int32 冻结 schema 零改动）。控制面 CTL-1/CTL-2：qzjs-ctl CLI + AF_UNIX 端点 + SO_PEERCRED，树路由经 target_path。

**主权原则（用户裁决，凌驾具体形态）**：宿主形态不是 qzjs 能干涉的；qzjs 完全自主管理自己的进程和线程；与宿主通讯只用 postMessage 机制——qzjs 不跨线程调用宿主任何函数。

**宿主侧契约 = M-P7 mailbox（现状，2026-09-28 落地并全量验证，取代并废除 M-P6 注入契约）**：库自管宿主侧线程+loop（M-P2 形态回归，RT_LOOP=&rt->loop）；host 方向消息（JS postMessage、崩溃 {"type":"error"} 上报、CONTROL 回执顶层 "ctl":true+correl）入 per-rt FIFO 邮箱（msgq 泛化为第二 MPSC 实例 mq_out，ACQ_REL 算法零修改、无 mutex/cond/futex）。宿主在自选线程、自选时机消费：qz_recv_message(rt,&json,&len,timeout_ms)（timeout_ms >0 阻塞 / 0 非阻塞 poll / -1 无限；返回 0=取到 NUL 终止 JSON 由 qz_free_message 释放 / 1=超时 / -1=错误）+ qz_message_fd(rt) 唤醒 fd（eventfd，可读=邮箱非空，先入链后写 fd 保证不丢唤醒，宿主不得 close、free 后失效、Linux-only；挂 fd 等待唯一姿势=①recv(0) 排干并处理→②read(fd) 清至 EAGAIN→③再探 recv(0) 有则回①无才可 poll 阻塞；单消费者（严格，2026-09-29 用户裁决）：qz_recv_message 同一时刻只允许一个线程调用，跨线程取件与移交由宿主自行串行化；fd 等待者同样只一个）。cfg.uv_loop、message_cb、host_data、qz_get/set_runtime_data 回调面整体移除；回调重入规则随之作废；qz_msg_push 内建 uv_async_send 剥离、唤醒由各入站调用点显式发出；主RT 子进程上行经内部钩子 rt->host_emit，THREAD/worker 分流经 qz_post_to_host（host_emit 上行 / worker_self 丢弃 / 否则入箱）。qz_free 双角色守卫（magic==QZ_MAGIC && thread_joined → 排干邮箱+关 out_efd+释放 config，否则裸 free）。

**I5②clause 复活**：三级终止 ≤2s 冻结回到库自有线程内执行，宿主调用线程只等 join。Liveness ping 家族：宿主→主RT（qz_ping）、宿主→树中任意 worker（qz_ping_path，tp 回显转发/pfail 快拒）、worker→sub（Worker.prototype.ping）；0=通畅/1=超时(loop 阻塞)/-1=死；ping 家族与 wait_idle 的阻塞等待发生在**调用线程**上（ping=带退避的短睡轮询 100µs→1ms 封顶，wait_idle=uv_thread_join），库宿主侧线程在这期间转 loop、回填回执、执行三级终止；邮箱不受影响。崩溃帧时序：EOF 里先入箱、后 RELEASE 置 shutting_down，wait_idle 的 acquire spin 退出时帧必在箱内（wait_idle 后、qz_free 前仍可 recv——mp4 stderr 门依赖此序）。

storage 单所有者（owner=树根主RT，§10.2）非根节点中继上行（N-P4 corr 并发关联）；owner 死 ⇒ 孤儿连锁自杀即设计终点（降级不实施）。系统级 CONTROL（ready/idle/shutdown/ping 家族，"qzjs" 标记）在 rt_main.c C 读回调就地消费、不入 msgq/JS——否则心跳被控制面当命令回 UNKNOWN_CMD 泄漏进宿主邮箱（M-P7 箱净门捕获）。

延后项终判：tier-2 超时异步化维持 DEFERRED（①正常路径 ~1ms 仍立；③跨 loop 属主迁移风险仍立；②随 M-P7 冻结回到库自有线程而恢复原理由）；path u16→u32 YAGNI 维持；§10.2 降级不实施。深度上限 QZ_SELF_PATH_MAX=8、storage 中继单飞行仍为已知缺口。

M-P7 邮箱化的代码评审修复**已全量落地并提交**（commit `83047e1c`，`fix(M-P7)!`，98 文件
+5244/-896，一次提交不拆分）。下面四条是这次评审**改变了既有判断**的部分，其余细节见
CHANGELOG 本批 8 条与 brain `code-quality-requirements` 的同期 note。

**契约层**：①邮箱收口为**严格单消费者**，撤销 16 处文档里「多线程可并发 recv」的承诺。
`qz_out_pop` 的 head 是非原子读写的（注释：「consumer owns head, so no lock is needed」），
该前提**原先只写在文档里**、违反它没有任何东西会变红；现补一个 per-rt 原子标记，并发调用
得到 -1 + stderr 诊断。判据取 per-call 而非永久归属，因为契约措辞是「**同一时刻**只允许
一个线程」——永久归属会把「A 排干完、顺序交给 B」也判成违规。**这是公开 API 的破坏性变更。**
②ping 家族改条件编译并新增 `*_if_available` + `QZ_PING_UNAVAILABLE`（刻意不返回 0：谎报
健康比明说测不了危险）。守卫原先**只修了一半**——`QZ_USE_MOCK_LIBUV` 是 PRIVATE，消费者
看不到，mock 测试构建里「头里声明、库里没有」原样复现；已改 PUBLIC 并给门加第三档 mock 配置。
③`qz_free` 在线程没 join 过时**什么都不碰**。中途改成过「先排干邮箱 + 关唤醒 fd」，是错的：
teardown 的契约是「join 后调用」，而这条分支的前提恰是线程可能还在跑；排干会与生产者入链
并发并 free 掉它手里的节点，关 fd 会让生产者 write 进一个可能已被宿主复用的 fd。
④interrupt 豁免 correl，且置位后**立刻收手**（不登记、不入队、不产回执）。第一版只把守卫
挪到置位之后，等于把「correl 必填」要消灭的 `correl=""` 孤儿回执原样放了回来。

**判据层**：两个控制面入口的拒收判据抽成共用的 `ctl_check_accept`（**含顺序**）——早先两者
顺序相反，同一份字节得到两种诊断，而两处注释都写着「两处必须同步」。端点返回码细分
-2 缺 correl / -3 保留命名空间 / -4 入队失败（不会有回执，必须当场回帧）/ -5 前投失败
（NOT_FOUND 已写出、端点别再发）；除 0 与 -5 外每个非零都回帧。内部码不外泄，公共
`qz_control` 归一化回 -1。

**验证矩阵进了 Makefile**（`asan` / `asan-rt` / `ubsan` / `gates` / `verify`）。这些配置
此前**只存在于 CI yaml**，本地验证全靠手敲 cmake、配置对不对全凭记忆——我按「我本地跑过
ASAN」的说法放过一次堆 use-after-free，因为手上的 build-asan 是 `tests=OFF`（压根不编译
gtest），而唯一带 `tests=ON` 的那个是 UBSAN。**CI 早就会红，红的是我没复现 CI 的条件。**
`asan-rt` 那一套是刻意分开的：`rt_host.c` 只在 ISOLATED && !mock 下编入，`tests=ON` 那一套
里整文件是不编的。

**遗留（均已写明，非静默搁置）**：打断正在执行的脚本会留下有根 JS 对象，`qz_destroy` 在
quickjs 断言上终止、NDEBUG 下静默泄漏——根因在 vendored quickjs-ng，见
[[interrupt-teardown-leak]]；对应测试保留为 `DISABLED_...` 而非删掉。另两条：拒收帧同步写
而回执异步写（流水客户端按位置配对会错位）、每条控制命令 cJSON 解析两次（合并的风险大于
收益）。


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
  summary: "M-P6 契约翻转：ISOLATED 宿主侧库私有「宿主 loop 线程」（host_thread_main）废除——宿主必须经 cfg.uv_loop 注入自己的 uv_loop_t（NULL→qz_create 显式失败，§5.3 不降级），库把宿主侧通道句柄（管道读回调/wake async/tx 溢出定时器）全部挂上，message_cb 在驱动宿主 loop 的线程触发。配套：①create ready 改同步 raw-fd 帧读（qz_proc_wait_ready_raw，先于 uv_read_start；pre-ready 脚本帧暂存 proc->pre_frames 上限 256，读回调注册后 FIFO 重放——主RT eval 先于 emit ready 的既有顺序 hazard 由此闭合）；②阻塞宿主 API（qz_ping/qz_ping_path/qz_wait_idle/qz_destroy）就地驱动（UV_RUN_NOWAIT+yield），message_cb 可在调用内重入触发→规则：cb 内禁调阻塞宿主 API；③库永不 UV_RUN_DEFAULT/uv_loop_close 宿主 loop，teardown 后句柄全关可干净 close（wait_idle 后用 qz_free 释放 rt）。I5 复查记录②clause 作废：宿主侧 terminate 的 ≤2s 冻结原跑专用 loop 线程不碰宿主主线程，现落在调用线程上（单线程宿主 destroy 挂死主RT 时冻结 ≤2s+排干，mp5 实测 2006ms）——维持 DEFERRED 结论不变但理由②失效（①③仍立）。附带：ISOLATED message_cb payload 复制+NUL 终止（对齐 THREAD len+1 语义，两模型同）；host_teardown 排干 msgq 尾挂节点（pop 约定末节点由下次 pop 释放→无下次则漏，修 60B idle-req 泄漏）。CLI/examples/mp5 e2e/文档 EN+zh 全量翻转。"
  source: "2026-09-28 M-P6 宿主契约翻转会话"
  affects: [multi-process-model]

- time: 2026-09-28T11:28:40
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "2026-09-28 M-P6 宿主契约翻转会话"
  affects: [multi-process-model]

- time: 2026-09-28T13:59:40
  kind: decision
  summary: "wake 初始化先于读回调注册；pre-ready 帧在 qz_create 内同步重放可触发 message_cb"
  affects: [multi-process-model]

- time: 2026-09-28T14:27:57
  kind: decision
  summary: "库不在宿主进程私起线程/loop，宿主形态（线程拓扑/loop归属/驱动节奏）qzjs 不干涉；库所需线程与进程全部置于库自治域"
  affects: [multi-process-model]

- time: 2026-09-28T14:48:28
  kind: reversal
  summary: "cfg.uv_loop 注入契约与 message_cb 回调一并废除：库完全自管线程/进程（宿主侧线程回归），host 方向消息入内部邮箱队列由宿主自取（阻塞带超时/非阻塞 poll/唤醒 fd），qzjs 不跨线程执行任何宿主代码；M-P6 注入形态为实现现状、M-P7 为裁决目标态，待实施"
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
  summary: "M-P7 落地并全量验证，取代昨日刚落地的 M-P6 注入契约（commit f0178683..6c0ab934），闭环 M-P6 落地→M-P7 再裁决→M-P7 实施全程：M-P6 让宿主经 cfg.uv_loop 注入 loop、message_cb 在宿主驱动该 loop 的线程上触发，被判定为对宿主形态的干涉（强加驱动义务+libuv 同链接义务+回调重入规则），M-P7 整体废除。变更：①公共 API 删 message_cb/host_data/uv_loop 与 qz_get/set_runtime_data，新增 mailbox 三函数 qz_recv_message/qz_free_message/qz_message_fd（eventfd 唤醒 fd，先入链后写 fd 防丢唤醒，三步消费协议）；②msgq 泛化为第二 MPSC 实例 mq_out（ACQ_REL 零修改、无 mutex/cond/futex），qz_msg_push 剥离内建 uv_async_send→各入站点显式发；③ISOLATED 恢复库自建宿主侧线程+loop（基线 f0178683~1，RT_LOOP=&rt->loop，ipc_process 句柄绑定零改动），三级终止 ≤2s 冻结回库线程、调用线程只 join（I5②复活）；④THREAD 统一 mailbox，主RT 子进程上行经内部钩子 rt->host_emit，qz_post_to_host 三分流；⑤崩溃帧先入箱后置 shutting_down（wait_idle 后 free 前仍可 recv，mp4 门依赖）；⑥qz_free 双角色守卫（magic+thread_joined）；⑦CLI 改零 libuv 纯 poll 宿主（输出逐字节不变），examples hello/messages/worker 改 mailbox 宿主。测试：mp5-host-pump→mp7-mailbox 重写（去 libuv、六模式 basic/crash/hung/replay/fd/dual，basic ④ 未消费残留随 teardown 排干=漏 recv 无泄漏门），CMake/CI 接线。文档 EN+zh 33 页契约翻正。关键回归修复：系统级 CONTROL（ready/idle/shutdown/ping）在 rt_main.c C 读回调就地消费不入 msgq/JS（否则心跳回 UNKNOWN_CMD 泄漏进宿主邮箱破坏箱净门）。验证：mock ctest 25/25、THREAD ctest 25/25、ISOLATED Release 绿、mp1-4/mr2/ctl/nested 七 e2e 绿+mp7 全模式绿+ASAN basic/crash 零泄漏（漏排干/双 free 两政策）+worker-pool 520 任务无损。"
  source: "2026-09-28 M-P7 mailbox 落地会话"
  affects: [multi-process-model]

- time: 2026-09-29T01:12:52
  kind: decision
  summary: "不变量（用户裁决，显式化）：每个 rt 实例（主 rt 或 worker）的 JS 执行恰好绑定一个载体——一个线程或一个进程；绝不允许一个 rt 被多线程跑 JS（根因：QuickJS JSRuntime runtime-scoped 且非线程安全，polyfill class id / 引擎内部状态皆 runtime 级）。逐载体清点：①THREAD 模型主 rt = 唯一内部线程 qz_thread_main(qzjs.c:157)；②ISOLATED 模型主 rt = 唯一 qzjs-rt 子进程(单 JS loop，rt_main.c)，宿主侧 qz_t 只是传输代理；③worker = 唯一后端 THREAD 形态、独立线程 qz_worker_thread_main(worker.c:301)+自有 JSRuntime（PROCESS 由 JS 层 processSpawn 接管，C 层不分流，Phase C）。辅助线程不违反本不变量（它们从不执行该 rt 的 JS）：ISOLATED 宿主侧线程 host_thread_main(rt_host.c:396) 纯管道→邮箱搬运，rt_host.c 内零个 JS_ 引用；宿主任意线程上的 qz_recv_message 只弹 MPSC 邮箱不碰 JS。故当前代码天然满足，本条为登记非改动。"
  source: "2026-09-29 线程/进程主权讨论（用户裁决升格为显式不变量）"
  affects: [multi-process-model]

- time: 2026-09-29T01:21:58
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [multi-process-model]

- time: 2026-09-29T02:27:43
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [multi-process-model]

- time: 2026-09-29T03:34:13
  kind: decision
  summary: "撤销「多线程可并发 recv」承诺：邮箱收口为严格单消费者（用户裁决 b），与 msgq.c/qz_internal.h/troubleshooting/examples 既有措辞对齐"
  source: "2026-09-29 邮箱并发契约评审裁决"
  affects: [multi-process-model]

- time: 2026-09-29T03:34:30
  kind: reversal
  summary: "邮箱并发契约裁决（用户拍板）：撤销「允许多线程并发 recv，lock-free pop 互斥故并发 poller 安全」的承诺，收口为严格单消费者。四处措辞异常=include/qzjs/qzjs.h:153、README.md:362、docs/guide/lifecycle.md:124、docs/zh/guide/lifecycle.md:88。理由：①lock-free 描述的是推进不会被阻塞，与「两个线程同时改同一条链」是否撞车无关——qz_out_pop（src/msgq.c:133-141）无锁无 CAS，双消费者即同一节点被两处弹出+重复投递+double free；②无锁/多消费者/无界/立即回收四属性不可兼得，必须弃其一：弃多消费者=改约7行注释零成本；弃立即回收=须 epoch 或 hazard pointer（比一把锁更重，且本项目已有 A1/A2/C2/D5 四次 UAF/double-free 前科）；弃无界=撞上「缓冲上限只能由宿主定」的流控裁决；弃无锁=被用户「无锁是核心要求」直接否决；③其余 8 处本就写单消费者（src/msgq.c:29、src/qz_internal.h:522、docs/guide/troubleshooting.md:115 与中文版、examples/messages/README.md:40、docs/archive 归档设计稿「amoib 线程独占消费」），上述四处属措辞异常而非设计意图；④README.md:362 后半句自身已写明 cross-thread message ownership handoff is the host's job。属对外契约变更：需 feat(runtime)! 并进 CHANGELOG，docs EN+zh 同步。"
  source: "2026-09-29 邮箱并发契约评审裁决"
  affects: [multi-process-model]

- time: 2026-09-29T05:00:38
  kind: decision
  summary: "单消费者裁决已从「文档措辞」升级为「已落地 + 已验证」：mailbox 收口为严格单消费者，16 处文档（README、c-api/{index,runtime}、guide/{event-loop,host-integration,embedding,lifecycle,troubleshooting}、include/qzjs/qzjs.h 及全部 zh 镜像）统一改写为「可从任何线程调用，但同一 rt 同一时刻只允许一个消费者」并给出理由（lock-free MPSC 的 pop 无 CAS，两线程各读同一 head → 同消息投递两次 + 同节点 double free）；此前列「多线程并发 recv 安全」的 15 处属对实现能力的错误承诺（另 8 处本就写单消费者）。落地时同批修掉 M-P7 遗留的三处实现瑕疵，均无锁无 futex/condvar：①wait_idle 的 sched_yield 自旋删除直接 join（join 覆盖自旋全部退出条件且其后本就要 join，2s 等待实测 CPU 100%→0%）、ping/ping_path 自旋改 nanosleep 退避 100µs→1ms 封顶（clock_nanosleep 不触 PVE 6.17 触发的 futex 路径）；②eventfd 失败回退 pipe 删除（pipe 读写端不同号→msgq 的 write 无效→宿主拿到永不可读的唤醒 fd，按三步协议 poll 死等且无诊断；-1 是正确降级，假 fd 是挂死）；③qz_mailbox_teardown 改调 qz_out_mq_init 复位到 init 态（stub.q.next 原本悬垂到已 free 的链首节点，二次 teardown 踩已释放内存；幂等靠状态而非次数门控）。qz_free 补活 rt 显式拒绝（magic 匹配但 thread_joined==0 时 stderr 报错并返回，不裸 free 造成 UAF；既有调用点全在 wait_idle 之后，零回归）。测试门加硬并验证其有效性：account_take 统一记账且 v<0 计 bad，临时 revert rt_main.c 系统级 CONTROL 那 9 行后新门即报 UNKNOWN_CMD 回执泄漏（证明旧门形同虚设）；另加 ping 后箱净断言、crash ④ timeout=0 确定性门、hung ⑤ /proc state=='T' 取证（防 SIGSTOP 未生效时空过）、replay ⑥ 1→3 条按序、脚本 timeout 120。验证：build_rt 生产构建绿、ctest 24/24、mp1/mp2/mp3/mp4/mr2/ctl/nested 七 e2e 全绿 + mp7 全模式绿。未做（留待后续）：rt_main.c classify 双调用与「带数字 qzjs 字段的用户 CONTROL 被静默吞」黑洞、control.c:391 缺守卫、9 处 uv_loop_close 不查返回、出站无上界且 OOM 静默丢、ASAN job 不编 harness / 示例不进 CI。"
  source: "2026-09-29 M-P7 评审修复落地"
  affects: [multi-process-model, code-quality-requirements]

- time: 2026-09-29T05:25:21
  kind: decision
  summary: "M-P7 评审第二批落地，主题是「判据收在一处 + 失败说出来」，全程无锁无 futex/condvar。①rt_main.c 收帧分流的 classify 由「同一 payload 双调用 + 两个 else-if 各判一次」收敛为「判一次定去向」——双调用让两个分支条件可各自演进而互相矛盾，正是上次系统级 CONTROL 泄漏门形同虚设的成因。②qz_control 入口补两条硬拒堵黑洞：顶层带数字 qzjs 键 = 通道层系统 CONTROL 保留命名空间（主RT 就地消费不路由，用户命令带它无声消失）；缺 correl = 回执是 correl=\"\" 的孤儿，宿主配不上也丢不掉。均返回 -1，判据与 classify 同源不另立。③qz_ipc_ctl_classify 移出 ipc_process.c 到新文件 src/ipc_ctl.c：纯 payload 分类（cJSON，不碰 libuv）却是保留命名空间唯一落点，而 ipc_process.c 在 mock 测试构建整文件不编——放那儿等于让判据在测试构建里凭空消失。连带修 ipc_process.h 在 QZ_USE_MOCK_LIBUV 下不 self-contained（qz_proc_msg_cb_t typedef 被关在 #ifndef 内、274 行声明在块外用它）。新增 test_ipc_ctl_gtest 8 例 + test_control_gtest 3 例，均经「撤掉守卫即红」验证非空转。④出站邮箱 OOM 不再静默：无界邮箱涨到 malloc 失败时原先 -1 且调用点全丢返回值 = 宿主流上一个无标记的洞；改为先试塞固定大小标记帧 {\"type\":\"error\",\"error\":\"mailbox-alloc-failed\"} 把洞标出来（OOM 常瞬时，小分配仍可能成功），连它都分配不出才 stderr 并按 1/2/4/8 节流；入链+发唤醒抽 qz_out_link 供两条路共用；测试用 env 钩子 QZ_MAILBOX_FAULT_INJECT（照 cli.c 的 QZ_WORKER_BACKEND 模式，真吃光内存不可复现）驱动 test_mailbox_oom_gtest，亦经「抽掉标记入箱即红」验证。不设邮箱上限：上界策略（丢最旧破 FIFO 保证 / 丢最新 / 杀 rt）是产品决策，且现有测试断言 FIFO 无损，标记帧已让丢失可见。⑤10 处 uv_loop_close 不查返回值改 qz_close_loop 统一诊断——EBUSY = 还有 handle 没关，loop 内存绝不能回收，泄漏是唯一安全选择。⑥文档「阻塞等待发生在库自有线程」系统性纠错 9 处（EN+zh）：等待永远在调用线程上（ping 带退避短睡轮询、wait_idle/destroy 是 join），库线程做的是转 loop/产出回执/执行三级终止——原说法会让人排查卡顿看错线程。⑦src 内 26 处英文 pump（DAP 14）按既定映射改 drive/loop/serve。⑧CI 两处覆盖缺口：asan job 原为 QZ_BUILD_TESTS=ON 而 ipc_process.c/rt_host.c 整文件不编 → 全项目最并发的一段代码从无 ASAN 覆盖，追加 tests=OFF 真实 ISOLATED 构建跑 mp7 六模式（本地实测 ASAN+LSan 六模式全无泄漏）；QZ_BUILD_EXAMPLES 从未在任何 job 置 ON → 16 个示例从不被编译，e2e job 现全量编译并实跑 hello/messages/worker 三个邮箱 dogfood 示例。⑨三个邮箱示例 host_drain 把 recv 的 -1（错误）与 1（超时）一起 break = 把错误当「没消息了」，改为分开判定并报错（示例是契约示范）。⑩examples/worker/README.md 与 brain/architecture.md 的「worker 是真线程/内部线程」在缺省 ISOLATED 下是错的（载体=独立进程 QZ_WORKER_BACKEND_PROCESS），一并改正。验证：ctest 26/26、mp1/mp2/mp3/mp4/mr2/ctl/nested/mp7 八 e2e 全绿、mp7 六模式 ASAN+LSan 无泄漏、build_rt 生产构建 + 三示例实跑通过、DAP 两文件在 QZ_DEBUG_SUPPORT=1 下语法通过。未做：.vitepress/dist 未被 git 跟踪（.gitignore 的 dist/ 已覆盖，本就不是发布物，无需处理）。"
  source: "2026-09-29 M-P7 评审第二批落地"
  affects: [multi-process-model, code-quality-requirements]

- time: 2026-09-29T05:49:10
  kind: decision
  summary: "公共头声明面 vs 链接面（用户「修复问题」指令下的第四批）：查出并修掉一个真实的、条件编译型 API 陷阱——qz_ping / qz_ping_path 的实现在 src/rt_host.c（仅 QZ_PROCESS_MODEL=ISOLATED 且非 test 构建编译），而 include/qzjs/qzjs.h 里的声明是无条件的。后果是 THREAD 构建的宿主写 qz_ping(rt, 500) 编译完全通过、没有任何诊断指向那行，直到链接才炸 undefined reference to 'qz_ping'——症状像构建/配置坏了，而不是「这个编译模型没有跨进程 liveness 可测」。已实测复现（THREAD libqz_full.a + 一个调 qz_ping 的宿主，ld 直报 undefined reference）。修法：声明加 #if defined(QZ_PROCESS_MODEL_ISOLATED) && !defined(QZ_USE_MOCK_LIBUV) 守卫，与 CMake 里 rt_host.c 的编译条件逐字对齐，THREAD 下声明直接不存在、误用在编译期报错并指向源码行。另加两个全构建可用入口 qz_ping_if_available / qz_ping_path_if_available（ISOLATED 侧转发，THREAD/mock 侧恒返回新常量 QZ_PING_UNAVAILABLE = -2），可移植宿主因此不必 #if、也不必知道 QZ_PROCESS_MODEL_* 内部宏。THREAD 侧刻意不返回 0：谎报健康比明说「测不了」危险得多（宿主会据此以为 loop 验过了，而实际什么都没验）；QZ_PING_UNAVAILABLE 也刻意与 -1（参数/状态错误）分开，因为「我的调用写错了」与「这个构建答不了」该做的后续完全不同。新增 test/api_surface_check.py 守住这一整类：按每个配置用真实编译器问「这个条件下头里到底声明了什么」，再逐个查静态库里是否真有该符号；「声明了但库里没有」即失败，「库里有但任何头都没声明」作提示列出（静态库导出内部符号是常态，不算缺陷）。已验非空转：临时撤掉 ping 守卫后 THREAD 配置立刻报两函数 missing、rc=1。抽取器本身也踩过坑并修好：最初用 ^ 行首锚定匹配声明名，结果 `extern \"C\" {` 包住的 qz_internal.h 声明全被漏掉（qz_msg_push 就没抽到），改为在分号收尾的语句里搜全部出现（并排除 if/for/return 等语句），公共头抽出 14 个与人工枚举一致。接入 e2e job：ISOLATED 侧复用已构建的 build/，THREAD 侧另起 --target qzjs 的库级构建（比全量快得多）。顺带补齐参考页此前只在正文提过、没有独立条目的四个最常用函数（qz_post_message / qz_control / qz_ping / qz_ping_path，EN+zh 同步，qz_control 条目写明两条入口硬拒及理由），以及 c-api/index.md 导航表补 Messaging / Control Plane / Liveness / Bytecode 四组（此前只列 4 个函数，qz_ping/qz_ping_path/qz_control/qz_wait_idle/qz_free/qz_compile 全无入口）。文档门随之从 87 涨到 99 块、基线同步抬到 99。"
  source: "2026-09-29 M-P7 评审第四批：声明面 vs 链接面"
  affects: [multi-process-model, code-quality-requirements]

- time: 2026-09-29T06:42:51
  kind: decision
  summary: "控制面入口一致性与泄漏可见性（用户「修复问题」指令下的第五批，自查前四批改动时挖出）：①qz_control_endpoint_cmd（CTL-2 本地端点，qzjs-ctl 走这条）此前没有 qz_control_sink 那两条入口硬拒——顶层带数字 qzjs 键（保留命名空间，主RT 就地吞掉、命令无声消失）与缺 correl（回执成 correl:\"\" 孤儿）。同一个契约有两个生产入口，只堵一个等于「从 qz_control 拒、从端点静默吞」，凭调用方式决定行为；现两处同判据同理由。②更实的一个：qz_control_endpoint_cmd 的 §8.2 path 前投那条早返回既不 free(buf) 也不 free(correl)，test_nested_e2e.sh 每次 ctl --target-path 漏两份。它一直没被 ASAN 报出来不是因为不漏，而是 e2e 脚本用 kill -TERM 收宿主——LSan 只在正常退出的 atexit 里跑检查，收信号直接死就一封报告都不出，「ASAN 跑过了」对 ctl/nested 两支是空的。8 支 e2e 清点结果：mp1/mp2/mp3/mp4/mr2/mp7 正常退出→LSan 有效，ctl/nested 是 kill 型→LSan 空。据此新增 test/probe_ctl_endpoint_leak.c + CMake 目标 qz_ctl_endpoint_leak_probe：自己建运行时、开 LOCAL 端点、当客户端连上去发一条 target_path 命令、等回执、正常 return，让泄漏检查真的跑；接入 asan job。探针已验非空转：临时撤掉修复报 86 byte(s) leaked in 2 allocation(s)（78=buf、8=correl），恢复后归零。③mp1/mp4/mr2/mp7 四支在 ASAN+LSan 下复跑全绿（这四支的泄漏检查是真的）。教训：前四批的门（文档片段编译、声明面 vs 链接面、mp7 箱净门）都在守「新写的代码会不会腐化」，这一批暴露的是「已有的验证到底有没有在跑」——kill 型脚本让 LSan 静默失效，而 ASAN 绿灯看起来和有效时一模一样。凡是「靠进程退出触发的检查」，都得先确认那个进程是正常退出的。"
  source: "2026-09-29 M-P7 评审第五批：控制面入口一致性 + 泄漏可见性"
  affects: [multi-process-model, code-quality-requirements]

- time: 2026-09-29T07:22:04
  kind: note
  summary: "订正上一条 note 的三处不实陈述（本条同时是对 compiled_truth:17 的事实订正）。①上一条 note 写「multi-process-model 2026-09-28 reversal 条因 timeline 不可改写、以本 note 兜住」——**不成立**：timeline 早被就地改写过（术语批量替换那遍改了本文件 5 条历史条目的 summary），且那条被点名的 reversal 本身就是漏网的错误所在，现已按同一授权就地改正为「message_cb 在宿主驱动该 loop 的线程上触发」。教训比原结论更重要：把「我修不了」当成「无需修」写进记录，等于给后续评审发一个假的「已处理」信号——自查清单漏掉的那一处，恰恰是唯一还错着的那处。②compiled_truth:17 仍写「ping/wait_idle 的阻塞等待在库自有线程内自旋+sched_yield/原子回填」，两处都错：等待发生在**调用线程**（ping=带退避的短睡轮询，wait_idle=uv_thread_join），库自有线程做的是转 loop 与回填/三级终止。该行属事实陈述而非术语替换，超出「术语破例手改」的授权范围，故只在此记订正、不就地改；文档侧同一错误已在 9 处 EN+zh 全部改正。③上一条 note 写「src 内 26 处英文 pump」，实为 24（debugger_dap.c 14、debugger.c 6、ipc_process.c/msgq.c/qz_internal.h/qzjs.c 各 1）——多算了 2。"
  source: "2026-09-29 继续审查：brain 页术语复查的订正"
  affects: [multi-process-model, code-quality-requirements]

- time: 2026-09-29T07:23:36
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [multi-process-model]

- time: 2026-09-29T09:17:11
  kind: note
  summary: "订正本页 2026-09-28 timeline ⑧ 的两处过期陈述：①「16 个示例从不被编译」——examples/CMakeLists.txt 实际产出 14 个目标（3 个 C 程序 hello/worker/messages + 11 个 qjsc JS 编译检查），而 examples/extension/extension.c 与 examples/worker-orchestrate/task-worker.js 都不在列表内，所以那一轮说的「全量编译」名不副实，现已按 14 个目标如实表述。②同一条里的 OOM 注入形态（env 钩子 QZ_MAILBOX_FAULT_INJECT）已被推翻：改为 per-rt 的 qz_t::out_fault 字段 + qz_test_mailbox_fault(rt, n)，env 入口整体删除；理由是进程级全局/env 等于在生产库里留一个静默丢消息的总开关，且同进程多个 rt 共享额度。详见 code-quality-requirements 页同日 note。"
  source: "2026-09-29 第五轮（跨文件一致性审查）订正"
  affects: [multi-process-model]

- time: 2026-09-30T00:43:15
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "brain update-truth: M-P7 评审修复全量落地（commit 83047e1c）"
  affects: [multi-process-model]
