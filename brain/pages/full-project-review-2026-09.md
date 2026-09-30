---
id: full-project-review-2026-09
title: "全维度项目评审（2026-09-23）：六维结论与已验证缺陷清单"
category: project
status: active
tags: [review, quality, security, ci, docs]
created: "2026-09-23T04:17:41"
updated: "2026-09-30T06:20:43"
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
6. `src/bridge.c:449-454` `bridge_validate_path` 明写 "Leading / is allowed"、无 root jail；`src/cli.c:198/227/247/255/273` 五处 malloc **无 NULL 检查**（OOM 即段错误）。
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
