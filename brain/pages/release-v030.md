---
id: release-v030
title: "v0.3.0 发布：breaking（M-P7 邮箱化 + flatbuffers 退役 + bare 档移除 + C API 版本化）"
category: decision
status: active
tags: [release, version, milestone]
created: "2026-10-02T15:15:40"
updated: "2026-10-02T15:16:04"
---

<!-- compiled_truth -->
## 结论

v0.3.0 于 2026-10-02 发布到 GitHub（tag `v0.3.0` → `cb960d97`）。自 v0.2.0 起
441 个提交（83 feat / 81 fix）。0.x 阶段按 semver 惯例走 minor bump（含 breaking）。

## Breaking（用户升级必读）
1. `QZ_PROFILE=bare` 档移除（不满足 ECMA-429 WinterTC）
2. JS 层 flatbuffers 退役 → gRPC 改 **protobuf-only**（删 flatbuffers.js 1219 行）
3. 宿主通讯改 **per-rt 邮箱**（M-P7）：库不再调用宿主任何回调，线程自管
4. 公共 C API 已版本化（`docs/api-versioning.md`）

## 主要新功能
- VS Code DAP 调试扩展（`vscode/qzjs-debug`，仓库首个编辑器集成）
- 严格模式：安全运行第三方代码
- Worker liveness ping（`Worker.prototype.ping()`）
- fetch 出站代理 + 请求体字节化
- crypto.subtle wrapKey/unwrapKey
- polyfill OSS 化（url-pattern / structured-clone / streams）

## 关键修复
- interrupt 打断后销毁泄漏（teardown sweep，valgrind 158KB/次 → 0）
- DAP 断点行归属（pc2line peephole）
- 字节码读取器加固

## 引擎
- vendored quickjs-ng 锁定 v0.17.0（独立维护决策落地，quickjs-ng 仍为上游基准）

## 发布流程
- **版本号真源** = `project(... VERSION ...)`（CMakeLists 唯一真源）
- **GitHub Release 自动化**：推 tag 即触发 `Release` workflow（github-actions bot 建 Release + 上传 `qzjs-v0.3.0.tar.gz` 产物）
- **Release notes 手工补**：CI 生成的默认 notes 只有一行 Full Changelog 链接，需 `gh release edit --notes-file` 补 4 段（Breaking / 新功能 / 关键修复 / 引擎）

## 发布过程修掉的一个静默漂移
`QZ_VERSION` 宏只注入到 `qzjs` 库 target，但 `cli.c` 编在 `qz_cli` 可执行 target——宏到不了它，CLI 一直用 `src/cli.c` 里硬编码的 `"0.2.0"` fallback。真源升到 0.3.0 后 `qzjs --version` 仍报 0.2.0，构建系统毫无察觉。修法：给 `qz_cli`/`qz_rt` 补注入 + 删 fallback 改 `#error`。

## 验证
- Debug ctest 29/29
- Release 构建 0 error，`qzjs --version` → `qzjs 0.3.0`
- CI + Release 两个 workflow 均 success


## Timeline

- time: 2026-10-02T15:15:40
  kind: decision
  summary: "Created this page: v0.3.0 发布：breaking（M-P7 邮箱化 + flatbuffers 退役 + bare 档移除 + C API 版本化）"
  source: created via brain create-page
  affects: [release-v030]

- time: 2026-10-02T15:16:04
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [release-v030]
