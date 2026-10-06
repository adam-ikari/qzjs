---
id: branch-management
title: "分支管理规范与 master 保护（2026-10）"
category: decision
status: active
tags: [git, workflow, branch, protection]
created: "2026-10-06T00:07:17"
updated: "2026-10-06T00:16:27"
---

<!-- compiled_truth -->
## 分支命名（7 前缀）
- `feat/` `fix/` `build/` `docs/` `refactor/` `perf/` `test/`，格式 `类型/简短描述`（小写、连字符）。
- 禁止裸名分支与语义不明名字；分支名一旦推送远端即不可变——改名走「新建+删旧」，不 force-push 重写。
- 生命周期：从 master 切 → Conventional Commits 提交 → PR → squash merge → 合并后 `delete_branch_on_merge` 自动删远端分支 + 本地 `git branch -d`。

## 合并方式：统一 squash merge
- 每条 master commit 对应一个可追溯 PR；squash message 默认取 PR 标题并附 PR 号。
- `required_linear_history` 强制线性历史（squash/rebase 均可，禁止 merge commit）。

## master 保护（branch protection）
- 禁止直接 push / force-push / 删除；改动必须经 PR。`enforce_admins=true`。
- **required status checks = 19**（strict：分支落后于 master 必须同步）：
  - 编译/测试矩阵 13：all-features-off / feature matrix 四档（tls=OFF、tls=ON、compress=OFF、textcodec=OFF）/ wamr / wasm3 / polyfill-external / polyfill-compressed / nonutf / profile=minimal / asan 两档。
  - 质量门禁 6：ubsan（gcc + clang）/ e2e（真实 libuv + JS harness）/ test262（ES 一致性）/ clang-tidy / fuzz-smoke（libFuzzer 字节码读取器）。
  - 不进门槛：perf 套件（record-only）、coverage / grpc-e2e / debugger / release build。
- **required approving reviews = 0**（单人项目，审查责任落在 CI 与 PR 描述）。
- 新增 CI job 时**必须**同步更新 required checks（`gh api .../branches/master/protection` 查当前 contexts）——否则新 job 不会进合并门槛，规则被悄悄绕过。

## 清理规范
- 已合并 PR 分支由 `delete_branch_on_merge=true` 自动删。
- 30 天无活动且无 open PR 的陈旧分支：公告 7 天后删。
- 处置旧分支的判据：`git cherry master <branch>`（patch-id，`-`=已吸收）比文件比对我们（2026-10 教训：靠文件名比对比对会把"已并入"误判成"未合并"，浅克隆还会把 merge-base 误判成历史重写）。

## 已删分支 SHA（2026-10-06，可恢复）
恢复命令：`git push origin <sha>:refs/heads/<name>`。
- `prod-merge`                → `6e4aaaf333b22937d95a1ddfdd29a1faeb40098c`
- `fix/prod-readiness-bugs`   → `c455fb29e7d7465b06d272c8e6e5ac5c9556966b`
- `fix/qwrt-full-mbedtls`     → `5127d3f1b7af6b336943cc435ff7ca76fcfc1115`
- `cross-build-qjsc`          → `bdbbb6375815c5e01f2cd35aa94278350bfb621b`
- `phase4-httpserver-perf`    → `e12e579ab5871220739376c4cf45b005574306e4`
- `feat/ext-redesign-wamr-default` → `8a029499cb2af23b1f55ce71e40d8fabe1299fe1`

## 落地记录（2026-10-05/06）
- 6 个旧分支清理理由：prod-merge / fix/prod-readiness-bugs / fix/qwrt-full-mbedtls（tip==merge-base，真祖先）、cross-build-qjsc（被 PR#2 覆盖）、phase4-httpserver-perf（宿主 uvhttp C 扩展已废弃，gzip LRU 已由 miniz 承接）、feat/ext-redesign-wamr-default（git cherry 9/9 已吸收）。
- 三个 PR 全合并：PR#1 HTTPS 修复、PR#2 QZ_QJSC_HOST/QZ_LZ4_HOST 交叉构建、PR#3 分支规范本身。
- HTTPServer 真相：master 里是纯 JS 实现（polyfill/src/http-server.js），uvhttp C 扩展从未进过 master。


## Timeline

- time: 2026-10-06T00:07:17
  kind: decision
  summary: "Created this page: 分支管理规范与 master 保护（2026-10）"
  source: "用户要求制定分支管理规范 + 逐项授权落地"
  affects: [branch-management]

- time: 2026-10-06T00:07:40
  kind: decision
  summary: "分支管理规范 + master 保护落地：7 前缀命名、squash merge、19 required checks、review=0、陈旧分支清理判据（git cherry 优于文件比对比对）"
  source: "2026-10 分支治理：用户逐项授权，agent 执行清理与三 PR 合并"
  affects: [branch-management]

- time: 2026-10-06T00:16:27
  kind: decision
  summary: "补充已删分支的完整 SHA + 恢复命令，防 /tmp 丢失后无法找回"
  source: "2026-10 分支治理收尾：SHA 固化进 brain"
  affects: [branch-management]
