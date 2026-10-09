---
id: code-quality-requirements
title: "代码质量硬性要求：可读性 + DRY（项目级）"
category: decision
status: active
tags: [code-quality, readability, dry, review]
created: "2026-09-13T12:41:26"
updated: "2026-09-29T18:21:29"
---

<!-- compiled_truth -->
## 代码质量硬性要求（项目级，用户 2026-09-13 追加，对全部产出生效）

两条要求是 DIRECTOR 的显式要求，不是可选项；适用于新增代码与顺手触及的既有代码。

### 1. 可读性

- **诊断/错误消息自解释**：打印或抛出时必须自带定位与差异上下文——文件/路径、期望 vs 实际、触发条件。禁止「校验失败」「invalid input」这类裸话。
- **禁魔法数字**：`-4`、`32`、`64`、`0xFFFFFFFF` 之类裸字面量改用命名常量/枚举/宏（编译期常量亦可），名字说明语义。
- **标识符自描述**：变量/函数名表达意图，不用单字符或含义不明的缩写。
- **注释解释「为什么」**：记录设计约束、踩过的坑、权衡取舍；不复述「这行做了什么」。
- **函数短、单一职责**：避免深嵌套；嵌套过深即拆分或提前返回。

### 2. DRY（Don't Repeat Yourself）

- **不 copy-paste**：重复出现的逻辑、常量、样板抽成公共 helper / 命名常量 / 宏，或复用仓库既有实现（错误码枚举、既有工具函数、既有测试隔离模式皆优先于新建平行实现）。
- **单一事实来源**：一处定义、多处引用；改了定义即处处生效。
- **拒绝过度抽象**：不得为「将来可能有重复」造层——只有一个调用点的包装、无实际重复的通用化属 YAGNI 反例；确需引入时说明理由，否则回退。

### 落地方式

- 提交前自查两条：有未命名的裸数字、裸诊断消息、复制粘贴的 setup/断言，即属未达标。
- 每轮代码交付报告包含「可读性自查 / DRY 自查」小节，列出为达标所做的调整（含「为何该处不抽象」的理由）。
- 与既有 `decision-principles`（苏格拉底式提问 / 第一性原理 / 奥卡姆剃刀）配合：奥卡姆剃刀管「要不要做」，本页管「做完的代码长什么样」。


## Timeline

- time: 2026-09-13T12:41:26
  kind: decision
  summary: "Created this page: 代码质量硬性要求：可读性 + DRY（项目级）"
  source: "2026-09-13 用户/DIRECTOR 项目级代码要求"
  affects: [code-quality-requirements]

- time: 2026-09-13T12:41:42
  kind: decision
  summary: "写入两条项目级代码硬性要求：可读性（自解释诊断 / 禁魔法数字 / 自描述标识符 / 注释讲为什么 / 函数短单一职责）与 DRY（抽公共件与单一事实来源，拒绝无实际重复的过度抽象）"
  source: "2026-09-13 用户/DIRECTOR 追加要求"
  affects: [code-quality-requirements]

- time: 2026-09-13T12:41:42
  kind: decision
  summary: "用户追加两条项目级代码质量硬性要求（可读性 + DRY），要求适用于全部产出并在报告中附自查小节；本轮 polyfill external 测试/收尾即按此标准产出（命名常量 kTamperFlipMask/kMinPlausibleBytecodeBytes、断言带路径与期望/实际、helper host_read_file/host_write_file 与 load_polyfill_at 抽公共件、删除 test_suspend_gtest 的 read_file_bytes 副本）"
  source: "2026-09-13 用户/DIRECTOR 追加要求"
  affects: [code-quality-requirements]

- time: 2026-09-29T02:37:08
  kind: decision
  summary: "中文术语规范（用户裁决）：「泵」不符合中文语境，全仓弃用。固定映射——泵线程→宿主侧线程（ISOLATED 专属）/库自有线程（跨模型泛指）；读泵→读回调（uv *_read_cb）；泵动/泵(动词)→驱动；免泵→免驱动；泵义务→驱动义务；DAP 三条『泵』(paused/mid-run/configure)→三条处理分支。英文侧 pump thread→host-side thread、pump→drive（stream reader 循环的函数名 pump 属常规英文命名，保留）。适用范围：代码注释/头文件/文档站(EN+zh)/CHANGELOG/README/brain（含 timeline 历史，经用户授权破例手改）。未来写作不得 reintroduce 泵/pump-thread。"
  source: "2026-09-29 用户裁决：泵/读泵/泵线程 中文弃用"
  affects: [code-quality-requirements]

- time: 2026-09-29T04:55:30
  kind: note
  summary: "上一条「泵线程→宿主侧线程」固定映射有个语义反转的坑（2026-09-29 评审时发现并修正 4 处）：M-P6 契约下的「泵线程」指**宿主自己驱动注入 loop 的那个线程**，不是库自有的宿主侧线程——M-P6 的标题恰恰是「库侧宿主线程废除」。按固定映射替成「宿主侧线程」后，同一句变成「M-P6 要求 message_cb 在宿主侧线程触发」，与该条自身的前提直接矛盾。术语替换的判据不是「像哪个词」，而是「替换后这句在它所属的契约语境里还成立吗」：凡涉及模型专属语义的词（宿主侧/库自有/线程/loop），先确认在**该段描述的那个模型**下指谁。已修：CHANGELOG.md M-P6 条的 cb 线程 tid 断言、brain/background.md、brain/flow.md（经 update-root），multi-process-model 2026-09-28 reversal 条因 timeline 不可改写、以本 note 订正。"
  source: "2026-09-29 M-P7 评审修复：术语替换自查"
  affects: [code-quality-requirements, multi-process-model]

- time: 2026-09-29T05:36:45
  kind: decision
  summary: "文档腐化门（用户「修复」指令下的第三批）：新增 test/docs_c_snippet_check.py + test/.docs-snippet-baseline 棘轮（87/87），接入 e2e job。要点：①抽出 docs/（排除 archive/ 与 .vitepress/）+ README.md 全部 ```c 块共 87 块，四种编译姿势 A 原样 / B 包进函数体 / C 顶层声明与定义外提+剩余语句包进函数 / D 同B去static（嵌套函数兜底）——单一姿势覆盖不了「片段里既有 static 函数定义又有裸语句」这种形态（extensions 的 per-rt 表、event-loop 的 mailbox 消费都是）。②预置头只给头文件与「宿主自有变量」桩（cfg/rt/uv_loop/handle），qzjs 与 uv API 一律从真头文件解析：桩掉就等于把要守的东西挡在门外，qz_get_jsctx 那类「函数根本不存在」就抓不到了。③诊断只把 implicit-function-declaration / incompatible-pointer-types / int-conversion / return-type / uninitialized / format 升 -Werror，未用参数与缩进不算错。④门已验非空转：注入 qz_post_mesage 拼错立刻报「did you mean qz_post_message」exit 1；基线抬到 88 如期报「文档片段腐化了」。⑤修完现存 16 处不过（8 组 EN/zh 配对），最值得记的是 extensions 三处：只给了 my_hello_fn 的调用却没给定义，my_state_t / MAX / my_registry_get_or_create 全是悬空符号——整段编不过，等于在教一个不存在的写法；补成自洽实现时顺带把「表满静默复用别人的槽」改成显式失败。另修 dev/debugging.md 的 src 未声明、build-options.md 用 QZ_UNUSED 却没 include 它的 qz_internal.h、bytecode.md 的 source/source_len 未声明、host-integration.md 的 handle_json 未定义 + 把 qz_recv_message 的 -1（错误）与 1（超时）一起 break（把错误当「没消息了」，而示例是给人照抄的）。教训与前两批同源：判据/示例一旦没有执行器就等于不存在——前两批是「双调用 + 谓词过宽让门形同虚设」「wait_idle 自旋没人验」，这批是「文档示例根本没人编译」。凡是要防回归的断言，都得先问「谁在跑它、跑不过会红吗」。"
  source: "2026-09-29 M-P7 评审第三批：文档门"
  affects: [code-quality-requirements, multi-process-model]

- time: 2026-09-29T06:52:17
  kind: decision
  summary: "投递失败不再被吞（用户「修复问题」指令下的第六批）：qz_post_message 的返回值此前在 src/cli/cli.c 两处、三个示例、mp7 harness 12 处全被丢弃，而 qz_msg_push 失败只有两个原因（OOM / 长度非法）——都是「消息压根没发出去」这一种事实。CLI 侧后果最重：投递失败后紧跟 cli_wait_done，那是个无上限的 for(;;)，等一个永远不会到的回执就是挂死且无任何诊断；现改为检查返回值、报错、跳过等待（--run 路径非 0 退出并走 wait_idle+free 收尾，REPL 路径置 exit_code=1 继续）。示例（hello/messages）同样报错退出——示例是契约示范。mp7 harness 新增 post() 包装，12 处调用点改用它，poster 线程的失败经 pthread_join 回传检查（否则主线程只会看到「收不齐 200 条」而不知道是 poster 没发出去）。已验非空转：注入「投递恒失败」后 basic/fd/dual 三模式都以 [harness] qz_post_message failed 非 0 退出；没有这层时它们分别报「收不齐 2000 条」「poll 没变可读」「交错洪泛不完」，真因被症状完全掩盖。这个验证本身也踩了一次坑值得记：第一轮我把 cmake --build 的输出重定向到 /dev/null，构建其实因 unused-parameter 失败，跑的是旧二进制，于是 basic 挂了而 fd 却「通过」，两个结果自相矛盾。教训：验证「改动生效了没」时绝不能把构建输出丢掉——构建失败和「旧代码行为」长得一模一样。顺带修自己留下的两处设计瑕疵：文档门的 --ratchet 消息原写「低于基线——文档片段腐化了」，方向说反了——块数变少不是腐化，是有人为了让门变绿而删掉过不了的片段（真正腐化由 if fails: return 1 负责，与计数无关）；改为如实描述并写明是廉价信号不是保证（对冲式「加 3 坏删 3 好」检测不到）。另清点 8 支 e2e 的 timeout 覆盖：ctl/nested 的 ctl() helper 均有 timeout 10，无裸调用。"
  source: "2026-09-29 M-P7 评审第六批：返回值丢弃"
  affects: [code-quality-requirements, multi-process-model]

- time: 2026-09-29T07:12:04
  kind: note
  summary: "UBSAN 补上与 ASAN 同构的覆盖缺口（用户「不拆分了 / 继续」之后换的新检查角度）：前几轮都在跑正常构建与 ASAN，UBSAN 一次没本地跑过——而 UBSAN 抓的是有符号溢出、错位访问、非法转换这类别的检查看不见的东西。跑起来后发现：①CI 的 ubsan job 只配 QZ_BUILD_TESTS=ON，src/ipc/ipc_process.c 与 src/host/rt_host.c 在该配置下整文件不编，所以邮箱 MPSC / eventfd 唤醒 / 三级终止 / 崩溃帧时序 / ping 退避这一段最吃 UB（指针算术、size 溢出、原子配对）的代码从没有在 UBSan 下跑过——与它当初没进 ASAN 是完全同一个结构性原因（两处独立发现，同一根因）。②本地实测干净：gcc + 真实 ISOLATED 构建跑满八支 e2e + 五支 service worker + 两个 python e2e（httpserver / fetch proxy），全程零 runtime error。③ubsan job 追加一个 tests=OFF 的真实 ISOLATED 构建并跑 mp7 mailbox e2e 六模式，gcc 与 clang 两列都本地验证通过。这一轮的收获不在于找到 bug（没找到），而在于把「哪些代码从来没被哪种检查看过」这件事变成可回答的：ASAN 与 UBSAN 两个 job 此前都只覆盖 mock/THREAD 测试构建，M-P7 的并发路径对两者都是盲区，现在两边都补上了。记一笔方法论：ASAN 与 UBSAN 都不是「跑一次就等于覆盖到了」——它们的覆盖范围由构建配置决定，而本项目恰好有一个「测试构建不编并发路径」的结构性盲区，两种 sanitizer 同时踩中它。"
  source: "2026-09-29 M-P7 评审第七批：UBSAN 覆盖缺口"
  affects: [code-quality-requirements, multi-process-model]

- time: 2026-09-29T07:52:05
  kind: note
  summary: "第三轮并行审查（brain 页 / docs / 新增的门与测试 / src 改动）共找出 22 条问题，全部已修。其中最要紧的几条打在我自己这轮改动上，且有两类是我此前完全没意识到的系统性盲区。逐条记：①api_surface_check.py 的判定靠正则匹配编译器诊断里的引号，只认 gcc+UTF8 locale 打的 U+2018/U+2019，clang 与 C locale 打的 ASCII 引号完全匹配不到——于是 declared_here 恒空、守卫函数被算成「可见」、THREAD 档恒红。它在 CI 里一直绿只是因为 ubuntu-latest 默认 C.UTF-8 恰好让 gcc 打了弯引号。修法是加 -Werror=implicit-function-declaration 并用词根（undeclared / implicit declaration）而非逐条列举措辞、两种引号都认、子进程钉死 LC_ALL；顺带补「探针自身失败」检查（探针若因与未声明无关的原因失败，空集会让门看起来没问题）。加这道自检时立刻见效：我第一版把「探针零诊断」当失败，而 ISOLATED 下 14 个函数全部可见、零诊断才是对的——自检把一个错误判据顶了出来。②ping 家族的守卫写的是 `#if defined(QZ_PROCESS_MODEL_ISOLATED) && !defined(QZ_USE_MOCK_LIBUV)`，但 ISOLATED 是 PUBLIC、QZ_USE_MOCK_LIBUV 是 PRIVATE，消费者根本看不到 mock 宏——**守卫的 mock 那半边是死的**，mock 测试构建里「头里声明 qz_ping、库里没有」原样复现，我只修了真实 THREAD 构建那一半。修法：把 mock 宏改 PUBLIC，并给门加第三档 mock 配置（挂进 asan job，那儿本来就有 tests=ON 的库）。③我加的 OOM 故障注入器有真 bug：g_out_fault_budget 同时兼任「未读 env」哨兵（-1）和计数器，而 fetch_sub 会把 0 自然减成 -1，两者撞车 → 额度用尽后被读成未初始化 → 每 N+1 次 push 永远丢一条消息且静默；同一对象还混用原子与非原子访问（UB）；无 env 时每两次 push 调一次 getenv。subagent 给了复现（N=3 得到 888888468888884…）。修法：init 与 budget 拆成两个变量，init 用 CAS 抢一次性读 env，budget 用饱和 fetch_sub。修的过程中我自己又踩一次：CAS 的 expected 写成 &(int){0} 复合字面量是**坏的**（第一次调用返回失败、init_ 仍是 0，注入整整晚一轮），换成真正的 int 局部变量。④同一钩子还是进程级一次性的，一个测试进程只能注入一次——我补 N=3 那条用例时立刻撞上（第二个 case 静默不生效）。加 qz_test_mailbox_fault(n) setter，env 保留为进程级入口；并把 N=3 用例写成回归锁（修前 8 条标记、修后 3 条）。⑤test_mailbox_oom_gtest 原来用 host_wait_msg 收干，而那个 shim 超时清理时会丢掉所有以 {\"type\":\"error 开头的帧——正是标记帧的字面量，于是回执晚于预算就会报「OOM 未在流上留标记」并附空串：帧在流里、诊断说它不在。改直接 qz_recv_message。⑥CTL-2 泄漏探针三处：不断言自己走到了目标路径（什么都不跑到也绿）、裸 read 无上界（ASAN job 没有外层 timeout，整 job 能挂到上限）、固定 socket 名而库对显式路径不 unlink（同机之后每次跑都红）。重写为「同一条命令本地 ok:true、带 target_path 则 TIMEOUT」——这是我试过三种判据后唯一能从外部证明走到了前投分支的（只断言回执里有 correl 是不够的：本地路径也登记回执、也出 TIMEOUT，撤掉 target_path 照样绿）。⑦我加的端点拒收回执把 ctl_forward 的 -1（无此槽位）误判成拒收，发出误导性的「保留命名空间」错误帧——探针抓到的。改用专用码 -2/-3。⑧correl 必填的判据只在两个生产者入口，wire 路径（ctl_local_command）没拦，子进程发来的帧照样能造 correl=\"\" 孤儿；把判据下沉到收口。⑨qz_close_loop 的诊断文案承诺「loop 内存有意不回收」，而每个调用点下一行就 free(rt)——诊断描述了一个没人做的决定；改成如实描述并让函数返回 int，各调用点标注取舍。⑩ping 退避封顶注释写 1ms、实际 1.6ms（翻倍在判封顶之前，序列 100→200→400→800→1600）。⑪qz_free 守卫在「主RT 自行 idle 自退、宿主随后 free」这条真实路径上会拒绝（那条路上 thread_joined 恒为 0），且连 eventfd 都不关；改成先做安全的部分（排干邮箱+关 fd），只对 rt 本身 declines。⑫api_surface 的反向检查是装饰（只 print 不 fail）且常亮 9 条噪声；brain 三处术语错（dap 页残留英文 pump、a2 页「读泵停」被换成读不出得通的「读回调停」、multi-process-model 第 5 处语义反转）；docs 侧既有事实错误（首页 recv 三态、faq 把 qzjs.fs/localStorage/navigator.serviceWorker/CompressionStream 当全局、21 vs 30 模块、c-js-layering 引用不存在的 ext_web_wasm.c 与 3 用例、5 条断链）。
两处系统性盲区值得单独记：一是**「条件编译型 API 陷阱」我修了一半就以为修完了**——真实 THREAD 构建好了，mock 测试构建原样坏着，而我甚至用 clang 建过 UBSAN 却从没在 clang 下跑过自己那道门；二是**「门说自己测了什么」和「门实际测了什么」可以差很远**——api_surface 的引号正则、OOM 测试的 shim 吞帧、探针的假断言，三者都是文档/注释声称覆盖 A、实际只覆盖 A 的一部分或完全没覆盖。教训：每个门都要有一个「撤掉被测逻辑它会不会红」的负控，而且负控本身会被自己的判据挡住（我第一版自检就误判了 ISOLATED 的合法零诊断）。"
  source: "2026-09-29 第三轮并行审查（brain/docs/门与测试/src）"
  affects: [code-quality-requirements, multi-process-model]

- time: 2026-09-29T08:11:56
  kind: note
  summary: "第四轮审查（对象是第三轮修完之后、还没人看过的代码）只查出一处真缺陷，但暴露的东西比缺陷本身重要。缺陷：`test_mailbox_oom_gtest.cpp` 的 FaultGuard 声明在 host_destroy 之前，析构却跑在 qz_destroy 的 free(rt) 之后，析构里那次 qz_test_mailbox_fault(rt,0) 是写已释放内存。三个值得单独记的点。①**「我本地跑过 ASAN」这句话在没有对应构建配置时是空的**。/tmp/opencode/build-asan 是 tests=OFF，压根不编译 gtest（ctest 报 \"No tests were found!!!\"）；另一个带 tests=ON 的 /tmp/opencode/build-ubsan 是 UBSAN，抓不到堆 UAF。所以我在改完 per-rt 注入后跑了 ctest 26/26 全绿，ASAN 一次都没跑过那个二进制——而缺陷就在我刚写的代码里。真正抓到它的是临时现配的一个 ASAN+tests=ON 构建（照 ci.yml:308-314 的 asan job 参数）。**CI 早就会红**（asan job 就是 tests=ON+ASAN），红的是我没复现 CI 的验证条件。这跟之前那次「结构性盲区」是同一个病：验证构建的配置错了，「跑了」和「验证了」不是一回事。②**Makefile 里没有任何 sanitizer 目标**（12 个 target，无一个 asan/ubsan），本地验证全靠手敲 cmake 命令，配置正确与否全靠记忆。这是上面那个坑的结构性成因。③那道门的成功信号本身是死代码，而这类缺陷**不会被任何负控发现**——负控验的是「被测逻辑坏掉时会不会红」，而「成功提示永远打不出来」不影响 rc、不影响任何断言。它是靠人读输出才发现的。这条补进已有的教训：门不只要有负控，它的**输出**也得能让人一眼看出通过与否，否则它绿着的时候你并不知道它绿没绿。"
  source: "2026-09-29 第四轮审查：per-rt 注入改造后的自查"
  affects: [code-quality-requirements]

- time: 2026-09-29T08:18:35
  kind: note
  summary: "第四轮子审查（CTL 端点 + correl 收口）的三条发现，性质比上一轮那条 UAF 更值得记：它们全都是**我为了「让失败可诊断」而加的代码本身不可诊断**。-3 拒收帧是非法 JSON——C 源码里写 \\\"qzjs\\\" 只让字符串里出现一个裸引号，拼进 JSON 在第 53 列截断 error 串；而唯一会消费它的客户端 qzjs-ctl 用 strstr(resp, \"\\\"ok\\\":true\") 判断成败、从不解析 JSON，所以整条链上没有任何一处会红。两帧还都自带尾 \\n，而 qz_ctl_conn_write 无条件再补一个，于是每条拒收后面跟一个空帧，客户端 json.loads(\"\") 抛异常。第三条更直接：我写在注释里的前提（\"path 前投那条路函数内部已自行回 NOT_FOUND\"）是假的——那处直接 return rc，没 ctl_unregister 也没任何回执，客户端干等到 5s 后的 TIMEOUT。**我自己的探针输出就是反证，而我读到那个 TIMEOUT 时把它当成了预期结果**。三条合起来指向同一个可复用的判据：当一条链路上「诊断」本身是新加的代码时，先问三件事——它可被下游真解析吗（用真解析器验，别用 strstr）、它的字节形态与既有约定一致吗（尾换行、转义层数、字符集）、它依赖的事实前提成立吗（写进注释的理由要单独核，不要连带相信）。另有一条元教训：新增返回码/新协议分支时，「契约只存在于一行 if 里」是常态而测试覆盖为零也是常态——全仓 grep 不到任何 -2/-3 断言，e2e 脚本的 helper 又总是自动生成 correl，于是两条路都不可达。这类缺口只能靠「新行为必须配一条自己写的判据」来堵，不能指望既有测试顺带覆盖。而我补的那条判据当场又抓出一处：端点自己的守卫在到达收口前就拒了 interrupt，说明上一条修复漏了第三个入口——新写的测试第一次运行就抓到了同批次的第二个漏改，这正是「每条新行为配一条自己的判据」的回报。"
  source: "2026-09-29 第四轮子审查：CTL 拒收路径"
  affects: [code-quality-requirements, multi-process-model]

- time: 2026-09-29T08:38:24
  kind: note
  summary: "把此前标记「已知但未修」的缺口一次收掉之后，最值得留的不是那些修复本身，是三条关于「验证」和「判据」的方法论。一，**验证配置本身也是被测对象**。这些 sanitizer/编译配置此前只存在于 CI yaml 里，本地验证全靠手敲 cmake，配置对不对全凭记忆，于是我按「我本地跑过 ASAN」的说法放过一次堆 use-after-free——手上的 build-asan 是 tests=OFF（压根不编译 gtest，ctest 报 \"No tests were found!!!\"），带 tests=ON 的那个是 UBSAN（抓不到堆 UAF）。CI 早就会红，红的是我没复现 CI 的条件。修法不是「下次记得」，是把矩阵搬进 Makefile：配置写死，跑哪个是人的选择。这条比「加个 ASAN 步骤」重要得多，因为**一个只能靠记忆复现的验证条件，迟早会被记错**。二，**自己新写的判据要能被自己的负控抓住，而负控常常先抓到别的东西**。补 mp7 harness 的 SIGSTOP 等待时踩了个坑：等待循环写成 system(\"pgrep -P $$ ...\")，而 $$ 在 system() 起的 /bin/sh 里是子 shell 自己的 pid，永远匹配不到本进程的子节点——症状是「hung 模式判红」，离真因（pid 取错了对象）隔了三层。这类「在 shell 里写 pid」的错在 C 里没有编译期检查，只能靠对现象的追问：为什么会红？→ 因为等待永远不成立 → 因为 $$ 不是我。三，**在 shell/字面量里手写长度和 pid，是一类没有编译期保护的错误**，而这一路修的正是这类（qz_post_message 长度 26 应 29；我新写的两条 gtest 又把 16 字符写成 20，ASAN 报的是 global-buffer-overflow in __interceptor_memcpy，离「长度算错」很远）。规律：凡是把「本该由语言保证的东西」挪到字面量里，就等于把一个编译期错误降级成运行期的、离症状很远的那种。所以这类位置的规矩是能用 strlen/具名常量就绝不手写。"
  source: "2026-09-29 收尾：未修缺口全清（harness 假红 / CTL 码分类 / 验证矩阵 / 文档门收窄）"
  affects: [code-quality-requirements]

- time: 2026-09-29T08:47:28
  kind: note
  summary: "这一轮最有价值的是一个判据设计的教训，而且它是靠两次「负控绿了」暴露的。上一轮我给 interrupt 做了 correl 豁免，理由成立（它是唯一不依赖回执配对的命令，守卫排在置位之前会构成公共 API 的静默破坏）。但豁免之后我让它继续往下走到了 qz_ctl_register(rt, NULL, …) 和入队——而那里 r->correl = strdup(\"\")，dispatch 侧 ctl_claim(rt, NULL) 第一行又是 if (!correl) return 1（压根不查表），于是照样产出一条 correl=\"\" 的回执。守卫被绕过的同时，守卫要防的东西原样回来了。教训是：**「豁免某条规则」和「让这条命令走完整条路径」是两件事**，中间那段没人写代码的位置，恰恰是漏洞最容易出现的地方。正确形态是置位之后立刻收手：不登记、不入队、不产回执——效果已经达成，而没有 correl 本来就没有可配对的回执。
判据那一侧更有普遍性。我给探针的第 4 项加了「不许自己产帧」这半条断言，负控实测：撤掉修复，探针全绿。原因是探针走端点路径、经的是那处本来就对的 ctl_local_command，够不到我改的 sink。换成 gtest 走公共 qz_control，第一版仍然抓不到——因为断言写在 host_wait_ctl 的结果里，而那个 eval 配对 shim 只放行匹配所等 correl 的帧，孤儿在到达断言前就被它丢了。两次都是「负控绿了」才暴露的，所以规律是两条，必须同时成立：判据要落在**被测改动真正所在的那条路径**上（不是某条恰好也经过的路径），且观测点与被观测对象之间**不能夹一层会丢弃它的过滤**。附带一条更细的：断言「某字段非空」常常等价于没断言——我先只验 correl 非空，于是把回显换成任意字符串的负控照样绿；改成比对具体值之后，两个负控（回显错的 correl、省略 \"correl\":null）才都给出精确诊断。凡是「按某个键配对」的协议，断言就该比对那个键的值，而不是它的存在性。"
  source: "2026-09-29 interrupt 豁免引入的回归 + 判据必须落在被测路径上"
  affects: [code-quality-requirements]

- time: 2026-09-29T09:17:11
  kind: note
  summary: "订正本页两条 timeline 里的三处陈述（都是数字/形态过期，不是判断错）：①2026-09-28 那条「文档腐化门」记的是「棘轮（87/87）」「共 87 块」「四种编译姿势 A/B/C/D」。基线早已随文档增补抬到 99（test/.docs-snippet-baseline = 99，实测 99/99）；姿势 C 已删——按「只有它能过」的口径实测 99 块里独占 0 块（A 独占 2、D 独占 6），且它注释自称「混合片段的唯一解」而那实际是 D 在干的事，40 行 bespoke 启发式连同不属实的说明一并移除，现存 A/B/D 三种。所以「四种」应读作「三种（A 原样 / B 包进函数体 / D 去 static）」。②同一批里「测试用 env 钩子 QZ_MAILBOX_FAULT_INJECT=N 驱动 test_mailbox_oom_gtest」已被推翻：注入额度改成 per-rt 的 qz_t::out_fault 字段，由 qz_test_mailbox_fault(rt, n) 写，**env 入口已整体删除**。当时留 env 的理由（进程级一次性，一个测试进程只能注入一次）恰恰是「作用域选错」的证据——而且 env 入口等于在生产库里留一个静默丢消息的总开关。③本轮新增的一处同类订正见 multi-process-model 页。"
  source: "2026-09-29 第五轮（跨文件一致性审查）订正"
  affects: [code-quality-requirements]

- time: 2026-09-29T18:21:29
  kind: note
  summary: "本轮挖出一个既存缺陷，值得单独记它的**形状**而不只是内容：打断正在执行的脚本会留下有根的 JS 对象（qz_ctl_interrupt_handler 返回 1 → quickjs 抛 uncatchable InternalError 并 longjmp 展开，展开点的解释器临时值无人回收），之后 qz_destroy 走到 JS_FreeRuntime 就命中 list_empty(&rt->gc_obj_list) 断言。影响面不是「只在测试里」：任何带断言的构建（所有 Debug，含 CI 的 asan/ubsan 两个 job）对被打断过的运行时调 qz_destroy 会 abort，NDEBUG 下断言被编掉、对象静默泄漏。
这个缺陷的**发现路径**本身是更可复用的东西：interrupt 一直只验回执（test_ctl_e2e.sh 那条「回执里有没有 interrupted:true」），而那张回执是 dispatch 路径无条件产出的，与引擎有没有真被打断毫无关系——所以中断处理器从没装上、标志读错、JS 侧不检查它，全部测试照样绿。补测试时先踩了两个自己的坑：①把 8 字符的 {\"go\":1} 手写成长度 9，多读一个字节让 JSON 非法、消息根本没被处理，对照组于是假红（长度字面量这一类已经栽过多次）；②实验组预算 1500ms 小于脚本 3000ms 的自然耗时，于是「没收到 done」既可能是被打断也可能只是没跑完，负控（摘掉中断处理器）照样绿——改成同一预算、两个相反结论才没有刀锋时刻。判据最终形态是「对照组必须跑完 + 实验组必须始终不出现」加忙等而非 sleep（sleep 主动让出，标志只在指令边界被检查，测不到那件事）。结论仍然成立：**回执层面的断言不能替代效果层面的断言**，凡是「机制声称在某个时刻生效」的契约，判据必须落在那个时刻上。
另一条已经第二次出现的模式是**验证自己的门时踩到陈旧二进制**：这次 DISABLED_TEST 宏不存在导致编译失败，而我因为过滤了构建输出、只看 ctest 结果，把「100% passed」当成了真的通过——实际跑的是上一版二进制。同类今天已发生六次。以后的做法固定成：任何带负控的验证，构建输出不许过滤，且失败时先确认二进制真的变了（strings 查诊断字符串、或确认 ninja 报了「Linking」）。"
  source: "2026-09-29 补 interrupt 效果覆盖：挖出既存缺陷 + 两个自踩的坑"
  affects: [code-quality-requirements, multi-process-model]
