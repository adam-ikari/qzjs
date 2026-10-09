---
id: polyfill-bundling-policy
title: "Polyfill 内嵌强绑定：放弃拆 bundle/外置，优化内存占用为唯一方向"
category: decision
status: active
tags: [polyfill, bundling, memory]
created: "2026-09-10T01:38:27"
updated: "2026-09-13T10:52:49"
---

<!-- compiled_truth -->
## 启动加速决策链（2026-09-10 用户拍板）

- 动机：加速 qz_create（R1 7.5ms，polyfill 占 ~2ms）。
- 已否决路径：① 跨 context 复用反序列化字节码（QuickJS realm 绑定，实测同对象两 context 执行均写入第一个 context 的 global——b->realm 在反序列化时定死，无法摊薄）② context 预热池（复杂、驻留内存、跨 realm 不可共享，奥卡姆否决）③ 字节码级分片（esbuild 拆多入口按需 ReadObject——收益 <1ms 且每块仍要反序列化）。
- **最终形态（保留）**：**属性级懒加载**（已实现 6c27d6a9 + 10bff38e）：14 eager + 17 lazy 单元，eval 压至 0.02ms；ReadObject（~2ms）为 QuickJS 一次性反序列化硬成本，无法 lazy。
- 首启剩余 2ms 属引擎固有；最大头为 WAMR/libuv init（~5.5ms，73%）——未来若继续压启动，那是主战场。

## 启动时间构成（实测）

- JS_NewContext 0.4ms；JS_ReadObject ~2ms（不可省）；eval 0.02ms（lazy 已省）；WAMR/libuv init ~5.5ms。
- 模式：rodata 150KB（lz4 压缩 99KB，模式可切换）；minify 已启用。


## Timeline

- time: 2026-09-10T01:38:27
  kind: decision
  summary: "Created this page: Polyfill 内嵌强绑定：放弃拆 bundle/外置，优化内存占用为唯一方向"
  source: "2026-09-10 用户决策"
  affects: [polyfill-bundling-policy]

- time: 2026-09-10T01:38:27
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [polyfill-bundling-policy]

- time: 2026-09-11T00:12:24
  kind: decision
  summary: "决策补充（2026-09-10）：放弃 context 缓存/预热池/字节码分片——属性级懒加载为最终形态"
  source: brain update-truth
  affects: [polyfill-bundling-policy]

- time: 2026-09-11T10:02:27
  kind: reversal
  summary: "指向 wamr-init-lazy——WAMR init 主战场已由懒加载解决（3a8c26e9），启动 R1 降至 4.82ms median"
  affects: [wamr-init-lazy]

- time: 2026-09-13T09:35:18
  kind: decision
  summary: "external 模式（QZ_POLYFILL_MODE=external，仓库唯一非编译期锚定的 bytecode 入口）定位为「固定版防篡改」：polyfill/build.js 构建 external 产物时把官方 bytecode（dist/polyfill_default.polyfill）的 SHA-256 写进 src/polyfill_external.c（强符号 qz_polyfill_external_sha256[32]；strong 而非 weak，否则静态归档不抽取该 object）；src/host/polyfill_load.c external 分支读文件后自算 SHA-256 比对，不一致打印 expected/actual 并返回 QZ_ERR_PERMISSION，拒绝交给 JS_ReadObject。SHA-256 为自包含 C99 实现（FIPS 180-4，无分配，仅 external 模式编译），不引新依赖（未用 mbedtls）。定性：纵深防御，非安全边界——能改数据文件者通常也能改二进制。不加「热替换/每部署不同文件」开关（用户取舍）；自定义 polyfill 需自行重跑 build.js 更新期望 hash（注释/CHANGELOG/CMake option 描述已写明）。CI leg polyfill-external 已覆盖（configure external → polyfill_rebuild 生成 hash 数组 → ctest）。commit 246cddc0。"
  source: "2026-09-13 external 完整性锚定实现会话"
  affects: [polyfill-bundling-policy, quickjs-upstream-merge-strategy]

- time: 2026-09-13T10:52:49
  kind: note
  summary: "polyfill 模式产物分家（fix(build)）：build.js 与 CMakeLists 把生成 C 文件按 QZ_POLYFILL_MODE 拆分——rodata 仍写 tracked 基线 src/polyfill_default.c，compressed/external/host 各写 untracked src/polyfill_<mode>.c（CMake _polyfill_gen_c 同映射）。修掉「三模式共写同一 tracked 文件、互覆产物」缺陷；external 的 SHA-256 锚定符号 qz_polyfill_external_sha256 随 polyfill_external.c 落盘；运行时行为与 SHA-256 校验语义不变。验证：rodata/compressed/external 三模式各自 configure+build 通过、ctest offline 21/21、external 篡改 .polyfill 被拒绝、tracked 基线 hash 不变"
  affects: [polyfill-bundling-policy]
