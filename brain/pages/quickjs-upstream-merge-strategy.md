---
id: quickjs-upstream-merge-strategy
title: "QuickJS-ng/libuv 上游合并策略"
category: decision
status: active
tags: [build, upstream]
created: "2026-08-31T11:59:47"
updated: "2026-10-02T00:24:25"
---

<!-- compiled_truth -->
## 现状

- deps/quickjs-ng 与 deps/libuv 均为「本地快照 + 补丁文件」双机制：源码作为 git submodule 快照锁定在仓库内，上游差异通过补丁文件维护。
- gitlink 已修复：deps/libuv 回指上游存在的 commit 20b08342（v1.52.1 祖先，可被 CI fetch），不再指向悬空 commit。
- **quickjs-ng 已升级至 v0.16.2（commit 1009e662，2026-09-12）**：97 commits，三补丁 3way rebase 零冲突；BC_VERSION 26→27；唯一公开 API 破坏为 realloc_func 签名（7 callsite + 3 回调改造）。polyfill.bytecode 须用同版本 qjsc 重编，否则 host_create 全挂（findQjsc 扫描 build* 会静默选到旧 qjsc，已定案：CMake 传 $QJSC 指向当前 build 目录）。
- **quickjs-ng 已升级至 v0.17.0（commit 6d46d07，2026-09-18）**：32 commits，四补丁（c99-atomics / drain-jobs / bc-reader-hardening / debugger）rebase 零 FAILED（仅 hunk offset 位移）；BC_VERSION 27→28；polyfill.bytecode/worker-boot.bytecode 已用 v0.17.0 qjsc 重编。收获上游安全修复（TypedArray OOB / AsyncDisposableStack UAF / Promise.withResolvers refcount / hash 碰撞）。offline ctest 23/23 + e2e + seeded fuzz 全绿（CI 35451993074）。
- libuv 已跟进 v1.x HEAD（84af0b18，2026-09-20）：上游 v1.x 线仅 8 commits（BSD/CI 类），零冲突；c99-atomics patch 扩展纳入 io_uring env workaround（见 brain/pages/libuv-io-uring-workaround.md）。master 线为 v2 dev，暂不跟随。
- **debugger patch 含 pc2line 修复（2026-09-26 行归属 / 2026-09-27 行覆盖）**：quickjs-ng-debugger 352→416 行（行归属 3 处修复）→**522 行 / 20 hunks**（行覆盖：语句入口 marker + phase-3 录制面 + switch 收尾 marker），详见 [[dap-pc2line-line-attribution]]；重建后 a-side 基线已刷新为 configure 时的 v0.17.0 基线（旧文件 stale 在 v0.16.2，靠 offset 也能应用）。

## 策略（最保守默认）

- **补丁文件随 repo 提交 + CMake configure 阶段 `patch -p1` apply**：保证任何机器 checkout 后重新 configure 即得一致 vmlib（纯 C，无系统依赖）。
- 上游新 commit 需人工 rebase 三补丁到上游后合入，本地先跑 test262 与 offline ctest 验证再合入：
  - quickjs-ng-c99-atomics（22 行）
  - quickjs-ng-debugger（522 行）
  - libuv-c99-atomics（30 行）
- 不引入 fork url、不依赖个人仓库。
- **bytecode 工具链锁定**：polyfill.bytecode 重编必须用与引擎同版本 qjsc（realloc_func/BC_VERSION 破坏会被静默的旧 qjsc 掩盖，产出的不匹配 bytecode 直接挂 host_create 测试）。
- **patch 镜像校验金标准**：`git -C deps/quickjs-ng diff` 是 4 个 configure-time patch 的超集（顺序见 CMakeLists.txt:333-486），单补丁 delta 必须 diff(worktree, HEAD+前序补丁)；验收 = 按 CMake 顺序在 clean HEAD 副本重放 4 补丁后 cmp（quickjs.c/quickjs.h/quickjs-opcode.h/quickjs-c-atomics.h）与工作树相同 + hunk 计数校验 + 已 patch 树 reverse dry-run 全 0。

## 证据

- `patch --dry-run` OK，补丁可干净回放。
- v0.16.2 升级：三补丁 3way rebase 零冲突；offline ctest 通过；polyfill.bytecode 重编 155873B。
- 无补丁状态下 test_compress_gtest 30% flaky（-std=c99 原子行为不稳），补丁后降至 10%，非产品回归。
- debugger patch 重建（2026-09-27 行覆盖重镜像后）：ctest 26/26、npm test 3/3（SMOKE / DEBUGGER-STMT / LINE-COVERAGE）、gold 4 文件 cmp 全同 + hunk 0 mismatch + reverse dry-run OK——过程与 gotcha 见 [[dap-pc2line-line-attribution]]。


## Timeline

- time: 2026-08-31T11:59:47
  kind: decision
  summary: "Created this page: QuickJS-ng/libuv 上游合并策略"
  source: created via brain create-page
  affects: [quickjs-upstream-merge-strategy]

- time: 2026-08-31T12:00:10
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [quickjs-upstream-merge-strategy]

- time: 2026-08-31T12:00:17
  kind: decision
  summary: "gitlink 修复回指上游 20b08342 + 确认 patch 机制为唯一可复现路径"
  source: "CI submodule 修复会话"
  affects: [quickjs-upstream-merge-strategy]

- time: 2026-09-07T11:16:08
  kind: decision
  summary: "用户明确确认：C99 补丁提交形态维持现状——4 个 .patch 已 tracked 在本工程仓库（quickjs-ng-c99-atomics/libuv-c99-atomics/drain-jobs/debugger），CMake configure 阶段 patch -p1 应用；子模块 git status 的 m（deps/libuv、deps/quickjs-ng 工作树残留）为设计内残留，不还原、不加钩子、不 fork、不 vendor。此前的 'Do NOT stage submodule pointer changes' 约定与此一致——无指针变更被暂存过。"
  source: "2026-09-07 用户拍板会话"
  affects: [quickjs-upstream-merge-strategy]

- time: 2026-09-13T00:44:31
  kind: decision
  summary: "quickjs-ng v0.15.1→v0.16.2 升级定案（commit 1009e662，2026-09-12）：跟进上游 97 commits，三补丁（c99-atomics/debugger/drain-jobs）3way rebase 零冲突；唯一公开 API 破坏为 JS_NewArrayBuffer/JS_NewUint8Array 的 free_func→realloc_func 签名变更（7 callsite + 3 回调改造，realloc 回调 size==0 即释放语义）；BC_VERSION 26→27；polyfill.bytecode 用 v0.16.2 qjsc 重编（155873B）。"
  source: "2026-09-13 修复所有定案会话"
  affects: [quickjs-upstream-merge-strategy]

- time: 2026-09-13T00:45:15
  kind: decision
  summary: "build.js 工具链坑（单独修复进行中）：findQjsc() 扫 build* 目录会静默选中旧版 qjsc（v0.15.1，BC=26），产出与引擎（v0.16.2，BC=27）不匹配的 bytecode，致所有 host_create 测试挂。定案：重编 polyfill.bytecode 必须用与引擎同版本 qjsc——CMake 传 $QJSC 指向当前 build 目录，不得依赖 findQjsc 扫描猜测（该坑正被单独修复）。"
  source: "2026-09-13 修复所有定案会话"
  affects: [quickjs-upstream-merge-strategy]

- time: 2026-09-13T00:45:48
  kind: decision
  summary: "compiled_truth 更新：quickjs-ng 已升级 v0.16.2（BC 27），补 bytecode 工具链锁定规则"
  source: "2026-09-13 修复所有定案会话"
  affects: [quickjs-upstream-merge-strategy]

- time: 2026-09-13T06:28:02
  kind: decision
  summary: "libuv 升级：20b08342 (v1.52.1-72) → 096a02d1 (v1.52.1-110, v1.x HEAD, +38 commits)。c99-atomics 补丁保留并重生成（上游 uv-common.h@42 仍 #include <stdatomic.h>，无原生 C99 原子）；新基线上 dry-run 零 fuzz。验证：offline 21/21、e2e HTTPServer 34/34、fetch proxy 9/9、SW e2e 3/3、JS harness 4/4。commit e6a8e18c"
  source: "2026-09-13 libuv 升级会话"
  affects: [quickjs-upstream-merge-strategy]

- time: 2026-09-13T06:57:31
  kind: decision
  summary: "裁决：quickjs-ng bytecode local_count 一致性校验（deps/quickjs-ng-bc-localcount.patch，commit 7227ed81）为必要修改，永久保留（用户裁决 + 实证）。依据1-writer 恒等：quickjs.c:38809-38812 写 bc_put_leb128(s, b->arg_count + b->var_count)，上游自带注释 38810 \"this field is redundant\"；vardefs==NULL 时 else 分支 38828 写 0（js_create_function_bytecode 仅在 arg+var>0 时挂 vardefs）→ 合法值只有 0 或恰为 arg+var → 校验零误拒。依据2-双来源边界：reader 按流内 local_count 定 vardefs 尺寸（39765），free_function_bytecode（定义 37156，遍历循环 37163-37165：for i < b->arg_count + b->var_count）释放同一缓冲 → 畸形 bytecode OOB 读 rt->atom_array。实证：未修 base(1ab8676) ASan 报 SEGV /tmp/qjsrepro/base/quickjs.c:3699:9 in __JS_FreeAtom（栈 free_function_bytecode→JS_FreeAtomRT→__JS_FreeAtom，blob=33B Base64 G/////8ADP//Gw//////AQz//xsP/////wEAAAwNAAAA）；打补丁后干净 'SyntaxError: invalid local count'（18/20 次；残留 2/20 静默 139 属既有 Debug+ASan 下 JS_ReadObject 异常路径 teardown 问题，与 local_count 无关）。上游态度：origin/master(5301314) 无任何一致性校验；issue #1518（同 bug）closed not_planned，#1394 与 PR #1492 亦 wontfix/未合并，SECURITY.md 明示 bytecode hardening out of scope → 不建议上报上游，本补丁为唯一防护。受影响版本：v0.2.0 至 v0.16.2 全部 tag 及 master。行号更正：free_function_bytecode 真实定义在 37156（此前误报 37127，那是 js_create_function_bytecode 的赋值段）。"
  source: "核实会话 upstream-verify 2026-09-13"
  affects: [quickjs-upstream-merge-strategy]

- time: 2026-09-13T07:11:14
  kind: decision
  summary: "定性澄清（对 7227ed81 local_count 记录的补充，不改保留结论）：deps/quickjs-ng-bc-localcount.patch 的一致性校验属纵深防御 / CI 稳定性，非安全边界。依据（已核实输入面）：全仓 JS_READ_OBJ_BYTECODE 仅 3 处——src/context.c:178（polyfill 加载，默认 rodata 编译期 const 数组）、src/qzjs.c:222（worker boot，src/worker_boot_default.c git tracked）、.github/workflows/ci.yml:929（fuzz harness 随机 buffer）；跨信任边界传递为零：worker 复用同进程 rodata（worker.c:32-36,149）、process worker fork+exec 不传 bytecode（ipc_process.c:238-287）、挂起序列化（context.c:371）不经 JS_ReadObject → 默认构建无不可信 bytecode 入口；唯一非信入口为 external 模式 QZ_POLYFILL_FILE 指向的磁盘文件（polyfill_load.c:84-170），是否用于生产未证。上游立场：deps/quickjs-ng/SECURITY.md 原文 \"Bytecode hardening is out of scope … Loading untrusted bytecode (JS_ReadObject with JS_READ_OBJ_BYTECODE) is equivalent to executing untrusted native code\"，即 bytecode=本机代码级信任、解析层校验非安全边界；配合 issue #1518 not_planned。设计原则推论：若将来 external/host 模式支持不可信 polyfill，应在加载层建立信任（哈希/签名 + 来源白名单），而非在 reader 逐字段校验——reader 有多个可放大字段（cpool_count/closure_var_count/byte_code_len/var_ref_count/stack_size），逐字段既不完整又拖热路径，且上游明确不接。保留结论不变：补丁保留（用户裁决 + fuzz 门禁稳定 + external 模式损坏文件优雅报错）。"
  source: "2026-09-13 威胁模型核实会话"
  affects: [quickjs-upstream-merge-strategy]

- time: 2026-09-26T21:18:08
  kind: decision
  summary: "debugger patch 行数刷新（352→416 行/12 hunks，pc2line 行归属修复）+ 补 patch 镜像校验金标准，详见 [[dap-pc2line-line-attribution]]"
  source: "2026-09-26 pc2line 修复定案会话"
  affects: [quickjs-upstream-merge-strategy]

- time: 2026-09-27T04:16:03
  kind: decision
  summary: "debugger patch 行数刷新：416 行/12 hunks → 522 行/20 hunks（2026-09-27 行覆盖修复重镜像），证据行 npm 2/2 → 3/3"
  source: "2026-09-27 断点行覆盖修复会话"
  affects: [quickjs-upstream-merge-strategy]

- time: 2026-10-02T00:24:25
  kind: decision
  summary: "策略变更（2026-10-01 用户拍板）：quickjs 改为**独立维护**，quickjs-ng 仍是上游。含义：①vendored quickjs 从『跟随上游 + patch』升级为『独立 fork』——可自由修改引擎生命周期/语义，不必等上游合入，也无需仅靠 patch 表达差异；②quickjs-ng 仍是上游：安全修复要合入参考、可向上游提交，但不再阻塞 qzjs 侧的独立修复；③升级节奏从『主动跟随上游』改为『按需拉取上游安全修复 + 独立维护差异』。直接影响 interrupt-teardown-leak 的处理：此前『需改 quickjs 生命周期语义，qzjs 侧无修法，只能报上游或暂缓』——现在可在 vendored fork 内直接改，不再受『等上游』约束。patch 机制（CMake configure 期 patch -p1 + 镜像校验金标准）仍保留作为表达/回放差异的方式。"
  affects: [quickjs-upstream-merge-strategy]
