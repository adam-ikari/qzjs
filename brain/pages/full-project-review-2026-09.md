---
id: full-project-review-2026-09
title: "全维度项目评审（2026-09-23）：六维结论与已验证缺陷清单"
category: project
status: active
tags: [review, quality, security, ci, docs]
created: "2026-09-23T04:17:41"
updated: "2026-10-01T11:54:09"
---

<!-- compiled_truth -->
六维全量评审（2026-09-23，静态核查 + 关键项亲自复现验证）。总体判断：**工程质量明显高于同类自研项目平均水平，短板集中在"对外呈现层"与"安全治理层"，而非核心代码。**

## 总评分（10 分制）
| 维度 | 分 | 一句话 |
|---|---|---|
| C 代码质量/错误处理 | 8 | malloc 抽样 20 处 15 处有 NULL 检查；JS_Eval 10/10 查异常；strcpy/strcat 零命中；全仓仅 2 处 TODO |
| 架构/模块化 | 6.5 | 单层扁平 + 22/28 文件 include 同一个 qz_internal.h（上帝头）；uv_io/bridge/ipc_process 三个巨型文件职责 9/11/5 类 |
| 公共 API/ABI | 7 | qz_t 不透明、线程安全契约逐条写明是亮点；但 qz_config_t 无 size 字段、qz_worker_backend_t 枚举值随编译宏翻转 |
| 构建系统 | 7.5 | modern CMake 规范（target 级、SYSTEM include、无全局 include_directories）；扣分在 1153 行单文件 + 4 段重复 patch 块 |
| 测试体系 | 8 | 316 gtest 用例 / 1000+ 断言，零 `\|\| true`、零 DISABLED；e2e 有 PID 血缘与 zombie 检查 |
| CI | 7 | ASan/UBSan×2 编译器/coverage 门/test262/DAP/fuzz/e2e 覆盖厚；但零缓存、零 timeout、零 concurrency、仅 Linux、clang-tidy 空转 |
| 文档准确性 | 5.5 | API 签名与示例目标名基本全对；但首屏示例有确定性 bug、包配置断链、内部文档进 sitemap、数字三处互斥 |
| 安全 | 5 | 解析器普遍有界、近期专项加固到位；但**无权限模型**、`serve()` 默认 0.0.0.0、无 SECURITY.md、无 timingSafeEqual |

## 已亲自复现验证的高危缺陷（确凿，非推断）
1. `README.md:65` 最小示例长度参数 23 ≠ 实际 **26** 字节 → 用户照抄即截断 JSON（其余 8 处文档均写 26）。
2. `CMakeLists.txt:1124` `_qz_pc_libs "-lam ..."` 而全仓**无 `am` 目标**（实为 `qz_full`，L997）→ pkg-config 静态链接行必然失败，README/quickstart 声称"完整链接行"不成立。
3. `test/test_cli_gtest.cpp`（9 用例）**未在 test/CMakeLists.txt 注册** → 永不编译运行，而 `docs/dev/testing.md:58` 宣称 "CLI 9/9"。
4. `docs/.vitepress/config.mjs:98,209` sidebar 指向 `/c-api/eval`、`/zh/c-api/eval`，两目录均无 eval.md → 中英各一条死链（VitePress 不校验 sidebar，故"0 dead link"未覆盖）。
5. `polyfill/src/http-server.js:197` `serve()` 默认 `0.0.0.0` + 无鉴权中间件 → 默认即局域网可访问入口。
6. `src/host/bridge.c:449-454` `bridge_validate_path` 明写 "Leading / is allowed"、无 root jail；`src/cli/cli.c:198/227/247/255/273` 五处 malloc **无 NULL 检查**（OOM 即段错误）。
7. `polyfill/src/http-server.js:266-269,299,314` WS `this.buf`/`_fragParts` **无上限拼接**（HTTP body 有 1MiB 上限，WS 没有）→ 单连接内存 DoS。
8. `docs/js-api/fs.md:132` 声称 "different contexts can have different filesystem roots" → **实现不存在**，属虚假安全声明。
9. CI（ci.yml 1218 行 / 24 job）`permissions:` / `concurrency:` / `timeout-minutes` **三者全为 0 命中**，action 仅锁 `@v4` tag 未锁 SHA。
10. `test/service_worker_sw3_e2e.sh` 与 `sw3_update` 两脚本 CI 零引用（ci.yml:910-912 只跑 sw0/sw1/sw2），而 `ROADMAP.md:114` 声称 5 套件全绿。

## 结构性（非单点）结论
- **覆盖率 50% 门的分母不含多进程层**：`ipc_process.c / control_endpoint.c / rt_host.c / tcp_io.c / rt_main.c / ctl_cli.c` 在 `QZ_BUILD_TESTS=ON` 下根本不编译（CMakeLists:711-740,1049-1067）→ 门对最复杂并发代码零约束，且这些模块只靠 e2e 覆盖但报告不可见。
- **CI 零覆盖的对外承诺配置**：`QZ_PROCESS_MODEL=THREAD`、`QZ_PROFILE=minimal/standard`、`QZ_BUILD_EXAMPLES=ON`、`QZ_POLYFILL_MODE=host` 在 ci.yml 全文 0 处 —— README 主推的变体反而无回归防护。
- **无权限/沙箱层**：fs 绝对路径放行 + `pal.processSpawn`→`execv` 任意执行 + 全量 environ 注入 `globalThis.env` + serve 默认全网卡，四者叠加 = 跑半可信 JS 等价宿主沦陷。这是定位问题不是 bug：须么补 capability 档位，么在 README/docs 明写"qzjs 不是沙箱"。
- **安全治理缺口**：无 SECURITY.md / 无第三方 NOTICE(SBOM) / 无 release tag（git tag 为空但 CHANGELOG 有 0.2.0、CMake VERSION 0.2.0）/ fuzz 仅字节码读取器一条腿。
- **依赖**：mbedtls 3.6.6 落后 3.6.7（含 CVE-2026-50587 RSA 时序修复）且全仓无 timingSafeEqual；wasm3 pin 在未打 tag 的 main（CVE-2025-15413 公开利用，上游停维）；lz4 pin 在 `origin/dev` 而非 v1.10.0 tag。
- **e2e 并行不安全**：`test_ctl_e2e.sh:33-34`、`test_nested_e2e.sh:29-30` trap 里 `pkill -f "qzjs-rt --qzjs-worker"` 会误杀无关进程；多处全局 `pgrep -f qzjs-rt` + `rm -f /tmp/qzjs-worker-*`。
- **文档数字三处互斥**：ROADMAP 说 ctest 21/21 + CI 20 job；实际 22-23 与 24；CHANGELOG 内部同时有 23/23、21/21、17/17、20/20。
- **内部文档外泄**：`docs/archive/**`(21 篇)、`docs/superpowers/**`、`CI_FIX_BACKLOG` 全部进 sitemap（124 loc）对搜索引擎可见，与 `website-guidelines.md:47`"不得暴露内部细节"自相矛盾；且含全篇旧名 `amoib` 的归档。

## 突出亮点（应保持）
- **"严格 C99" 声称属实**：CMAKE_C_STANDARD 99 + EXTENSIONS OFF，src/ 内 `_Atomic|_Static_assert|_Thread_local|stdatomic` 零命中，靠 4 个 deps/*.patch 把上游 C11 特性改写。
- **submodule 依赖 8/8 全部 pinned 到具体 SHA**；patch 应用有 dry-run→marker grep→FATAL 三段门禁。
- **测试真实性高**：e2e 用逐字输出比对、JSON 字段断言、校验和、PID 血缘、zombie 检查，不是"退出码即通过"。
- **Brain 决策留痕完整**（44 页），且多处"结论：不实施/YAGNI/DEFERRED"的负向决策也留痕 —— 这是罕见的工程自律。
- **flaky 有根因修复而非重试掩盖**（CHANGELOG:96,111 poll 预算改 CLOCK_MONOTONIC，308+91 次压测验证）。

## 修复优先级
- **P0（确凿且成本极低，应立即修）**：README 长度 23→26；`-lam`→`-lqz_full`；注册 test_cli_gtest；删/补 sidebar `/c-api/eval` 两条；补 `SECURITY.md`；`serve()` 默认改 `127.0.0.1`；`cli.c` 五处 malloc 判空；WS 加 `MAX_WS_BUFFER`。
- **P1（结构性）**：CI 加 `permissions/concurrency/timeout-minutes` + THREAD/profile/examples 三个 job；补 mbedtls 3.6.7 + `timingSafeEqual`；e2e 的全局 pgrep/pkill 收敛到每测试私有命名空间；覆盖率显式列"uncovered-by-design（仅 e2e）"清单；docs sitemap 加 `srcExclude` 黑名单；补 release tag 与 THIRD_PARTY_NOTICES。
- **P2（长期）**：拆 `qz_internal.h` 上帝头（uv_io/bridge 私有头下沉）；uv_io.c 按 fs/http/tls/storage 拆分；抽出 `qz_apply_patch()` 消 150 行重复；`CMakePresets.json` 替代 30 个手敲 build 目录；CI 加 ccache + macos runner；权限模型（capability 档位）立项。


## Timeline

- time: 2026-09-23T04:17:41
  kind: decision
  summary: "Created this page: 全维度项目评审（2026-09-23）：六维结论与已验证缺陷清单"
  source: created via brain create-page
  affects: [full-project-review-2026-09]

- time: 2026-09-23T04:17:41
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [full-project-review-2026-09]

- time: 2026-09-23T05:50:15
  kind: decision
  summary: "P0 全部 8 项落地并验证：README 长度 23→26、pkg-config -lam→真实 target、test_cli_gtest 注册（首次真实运行 9/9）、sidebar /c-api/eval 双死链删除、SECURITY.md 新建、serve() 默认 127.0.0.1（实测只绑回环）、cli.c 五处 malloc 判空、WS MAX_WS_BUFFER 16MiB + 1009 关闭（新增 2 个回归用例，禁用 guard 时确实失败）。另修复改名漏改类 bug：6 个 python 脚本 args.qz_bin→args.qzjs_bin。"
  affects: [full-project-review-2026-09]

- time: 2026-09-30T03:24:16
  kind: evidence
  summary: "P1 全部 6 子项落地并验证（5 commits，213302c1..c5445ada）：①CI 治理——ci.yml 顶层加 permissions(contents:read)+concurrency(cancel-in-progress)，24 job 逐个 timeout-minutes，新增 profile-minimal job(QZ_PROFILE=minimal 此前 CI 零覆盖)；②release 治理——v0.2.0 annotated tag 指向发布点 afdccc72、THIRD_PARTY_NOTICES.md 列 8 个 vendored 依赖 pinned SHA+SPDX+patch 声明；③覆盖率——docs/dev/testing.md 加 'Coverage Scope — Uncovered-by-Design' 清单，6 个多进程模块(经 QZ_BUILD_TESTS=ON mock 构建排除)标注为何 mock 出+哪条 e2e 把关(设计非缺口)；④e2e 收敛——test_ctl/nested/mp1/mp2/mr2 五脚本全局 pkill/pgrep/rm 全收敛到进程组(setsid 起宿主+GROUPS 数组+pgrep -g+zombies() 限组)，顺带修 mp1 一处 stale 泄漏检查(/tmp/qzjs-worker-* 配不上实际落盘的 qzjs-rt-script-*，检查曾是空操作)；⑤mbedtls 3.6.6→3.6.7(CVE-2026-50587 RSA 时序)+ polyfill 新增 timingSafeEqual 接入 HMAC verify；⑥sitemap srcExclude 09-23 前已落地。验证：5 脚本 bash -n 全过、无残留全局 kill/pgrep、mbedtls 3.6.7 重编 165/165+TLS smoke、HMAC verify 四态全对。注：本机多进程 e2e 因既有 spawnWorker failed(err -9)(ISOLATED worker spawn 本身问题，基线对照改动前后同样失败)无法端到端跑，非本次引入。"
  affects: [full-project-review-2026-09]

- time: 2026-09-30T06:20:43
  kind: evidence
  summary: "多进程 e2e 三失败定性（2026-09-30，5 commits 5341664a/c7a9fc43 等）：①err -9(worker 被杀)=P1 收敛前的全局 pkill -f 交叉误杀 + 残留进程污染，组作用域收敛已修；②nested PID_GRAND:unbound=P1 e2e 收敛引入的回归(数组名 GROUPS 撞 bash 特殊变量当前用户组列表，GROUPS+= 在 set -u 下令 mark_group 中止 start_tree)，基线对照在『基线全红』时零证明力故当时未察觉，已改名 HOST_PIDS 修复；③手动跑 worker 脚本在仓库路径报 fsReadSync ENOENT=本 PVE 宿主 FS/内核异常(strace 实证：同 ext4、同文件、同代码路径，openat 结果随调用上下文不同；worker 脚本放 /tmp 则正常)，非 qzjs 代码、规范 e2e 不受影响。终态 nested/mp1/mp2/mr2 四套多进程 e2e 全 PASS。方法论教训入账 decision-principles『验证前提』节。"
  affects: [full-project-review-2026-09]

- time: 2026-10-01T04:09:30
  kind: decision
  summary: "P2 去重完成：bridge.c PAL 包装器群收敛。真实重复是 9 个 js_pal_* 异步包装器（~340 行，超 150 目标）；抽出 pal_path_promise_op() helper，6 个单参数 path/key op（fs_read/exists/remove/list + storage_get/del）骨架逐字节相同，收敛一处，差异经 opname/argname/validate_path/launch/done 五参数化。fs_read_binary（mid 插 bridge_zc_t + read_ex 签名不同）、fs_write、storage_set（2 参数+value 提取）结构不同，保留原样。验证：ninja 零警告 + ctest 28/28 + 真实运行时 smoke 6 op 全通。评审建议名 qz_apply_patch 为泛指"
  affects: [full-project-review-2026-09]

- time: 2026-10-01T05:17:22
  kind: decision
  summary: "P2 CMakePresets.json 完成：cmake 3.31.10；12 个 configure preset 覆盖 CI 真实组合（default/debug-tests/minimal/all-features-off/thread/asan/asan-iso/ubsan/ubsan-iso/polyfill-compressed/polyfill-external/coverage），hidden base preset 抽 Ninja+compile_commands 公共部分；配套 build presets(jobs=0) 与 test presets(并行4)。binaryDir=build/<preset>，build/ 已在 .gitignore。验证：12/12 configure 成功；default+debug-tests+asan-iso build 成功；default ctest 28/28。目的：替代手敲 30 个 build 目录为  一键；CI 暂未改（保持绿），可选后续迁移"
  affects: [full-project-review-2026-09]

- time: 2026-10-01T05:37:33
  kind: decision
  summary: "P2 uv_io.c 拆分评估后选跳过：代码实证 http+TLS 占 84% (3285/3905)，TLS 内嵌 uv_io_http_op_t 状态机（tls_init_op/send_cb/recv_cb 操作 op->tcp/ssl 字段），不可独立拆出；http 是单一状态机贯穿所有回调，无法横向切小。唯一可拆是 fs+storage 数据层 ~620 行 (16%)，共享仅 json_escape 一个函数。收益被现实约束大幅压缩——http 主体 3285 行仍是巨物，主痛点未解，620 行搬移的手术成本不匹配。结论：评审项基于'该拆'直觉，但现实约束使其成为为拆而拆；记录约束供后续决策。转 CI ccache（纯收益零行为风险）"
  affects: [full-project-review-2026-09]

- time: 2026-10-01T06:01:19
  kind: decision
  summary: "P2 CI ccache 完成：新增 composite action .github/actions/ccache-setup（装 ccache via hendrikmuhs/ccache-action + restore cache + 导出 CMAKE_C/CXX_COMPILER_LAUNCHER=ccache 到 GITHUB_ENV，使所有 cmake -B 自动透明走 ccache，无需逐 job 改 configure 命令）；ci.yml 24 个含 checkout 的编译 job 各插一行 uses。cache key 按 github.job 隔离。本地验证 CCACHE+launcher 编 qzjs 通过、YAML 语法 OK、24/24 覆盖。策略：composite 封装让每 job 只一行，降低 24 处重复配置的错误面"
  affects: [full-project-review-2026-09]

- time: 2026-10-01T09:45:00
  kind: decision
  summary: "P2 CI macos runner 评估后跳过：非「加 runner」而是「先做 macOS 平台移植」——ipc_process.c 无平台守卫（AF_UNIX socketpair/fork+exec/SIGKILL+waitpid Linux-only 声明但无 #ifdef）、resolve_binary 硬依赖 /proc/self/exe（macOS 无 /proc，需 _NSGetExecutablePath）、CMake ISOLATED 无 macOS 变体、deps/wamr 需额外适配。约 200-400 行改动跨 ipc_process.c/rt_host.c/CMakeLists + WAMR/mbedtls 平台分支，且「能编译」≠「能跑对」——定位是 Linux 嵌入式运行时，macOS 支持无明确需求。与 uv_io.c 拆分同性质：评审项基于直觉，现实约束使收益/风险不匹配。记录为已知约束，不立项。至此评审 P2 全清单闭环（除 macos runner 跳过、uv_io.c 跳过外，qz_apply_patch 去重/CMakePresets/CI ccache/严格模式 四项全部实施完成且 CI 29/29 实证）"
  affects: [full-project-review-2026-09]

- time: 2026-10-01T11:24:57
  kind: decision
  summary: "生产级合规：THIRD_PARTY_NOTICES 补漏 + 固化防漂移门。实际漂移比 scout 估计更多——NOTICES 只列 8 个 .gitmodules 子模块，漏 cJSON（v1.7.19，CMakeLists:270 编进库）+ 三个 polyfill npm 依赖（urlpattern-polyfill 10.1.0 / web-streams-polyfill 4.3.0 / @ungap/structured-clone 1.4.0，均被 polyfill/src import 并编进嵌入字节码随二进制分发）。MIT 要求保留版权声明 → 分发即违规风险。新增 Bundled JavaScript polyfill 段说明 esbuild 是构建期 bundler 不进二进制（显式豁免声明，否则分界会丢）。新增 test/third_party_notices_check.py 固化成门并挂 CI：校验 .gitmodules 子模块 + deps/ 全部 vendored 目录 + polyfill npm 依赖均在 NOTICES 表格第一列精确登记。踩坑两处：①子串匹配太松（删掉组件名 lz4 仍通过，因 URL/license 文件名里还有 'lz4'）→ 改精确解析表格第一列；②NOTICES 展示名与目录名不一致（表 'Mbed TLS' vs deps/mbedtls）→ 归一化匹配忽略大小写空格。有效性用变异测试证明：删 cJSON 行、删 web-streams 行均被精确 ::error:: 抓到"
  affects: [full-project-review-2026-09]

- time: 2026-10-01T11:32:12
  kind: decision
  summary: "生产级发布工程：①版本号单一来源——CMakeLists project(VERSION) 注入编译期宏 QZ_VERSION，cli.c 用 'qzjs ' QZ_VERSION（此前 cli.c:18 与 CMakeLists.txt:3 两处硬编码 0.2.0 会漂移），保留字面量 fallback 供非 cmake 手敲构建。②新增 .github/workflows/release.yml：tag v*.*.* 触发（另留 workflow_dispatch 手动），构建 → cmake --install 打包 → NOTICES 校验 → tarball → upload-artifact + gh release --generate-notes。tag 与 project 版本不一致即拒（防打 tag 到版本还没跟上的提交上）。③修 install 真实缺口：此前 _qz_install_targets 只装库和头文件，发布 tarball 里零可执行文件——第三方拿到包却跑不起来。补 foreach 装 qz_cli/qz_rt/qz_ctl 到 bin/（用 TARGET 判断而非 QZ_BUILD_CLI，后者与 tests 的组合会漏 qzjs-rt）。本地全链路验证：install 产出 bin/{qzjs,qzjs-rt,qzjs-ctl} + lib/*.a + include/qzjs + pkgconfig/qzjs.pc + cmake config；产物实跑 'dist runs: 2'；tarball 4.9MB/34 项含 LICENSE+NOTICES+README。此前仅有 v0.2.0 tag 但零发布工程——版本号只存在于源码文本，第三方无法从 GitHub 拿到可安装版本"
  affects: [full-project-review-2026-09]

- time: 2026-10-01T11:54:09
  kind: decision
  summary: "ABI 门控第二轮漏网修复：上一提交（126757df）只改了 gtest，漏了 .c harness——host_contract_e2e(3处)/probe_ctl_endpoint_leak/probe_ctl_reject_frames/mp7-mailbox mailbox_e2e(6处) 仍用 qz_config_t = {0}，CI asan/ubsan/e2e 五个 job 红（qz_create 报 ABI mismatch struct_size=0）。漏网根因：增量构建下 ctest 假绿（测试二进制没重链），clean rebuild 才暴露 gtest 部分；但 .c harness 在 tests=OFF 的 asan-rt/e2e 构建里，根本不进本地 mock ctest，所以本地无论如何测不到——只有 CI 的 ASan+ISOLATED 构建能触发。教训分两层：①ABI 迁移必须一次改净全部调用点（含所有 .c harness 与 examples），grep 要覆盖变量名不只 cfg（漏了 cfg2）；②mock 构建的 ctest 覆盖不到 tests=OFF 的真实-libuv harness 路径，这类回归只能靠 CI 或本地复刻 asan-rt 配置。另更新 examples/hello/README.md 的 = {0} 描述为 qz_config_init。本地复现验证：ASan+ISOLATED+tests=OFF 构建跑 mp7 mailbox e2e PASS（原 CI 失败项）"
  affects: [full-project-review-2026-09]
