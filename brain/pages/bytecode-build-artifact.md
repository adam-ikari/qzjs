---
id: bytecode-build-artifact
title: "内嵌字节码是构建产物（推翻 rodata tracked 基线）：非可复现产物不进版本库"
category: decision
status: active
tags: [build, polyfill, bytecode, reproducibility]
created: "2026-09-30T15:09:54"
updated: "2026-10-13T08:06:27"
---

<!-- compiled_truth -->
## 结论

**推翻「rodata tracked 基线」**（2026-09-30）：内嵌字节码是**纯构建产物，不进版本库**。

## 谁是产物

`src/polyfill/build.js`（esbuild bundle → qjsc → C 数组）在构建期生成：

| 产物 | 内容 |
|---|---|
| `dist/polyfill.js` + `dist/polyfill.bytecode` | 打包后 JS + 字节码 |
| `src/polyfill_default.c` | rodata 模式 C 数组 |
| `dist/worker-boot.bytecode` + `src/worker_boot_default.c` | worker 引导 |
| `src/polyfill_{compressed,external,host}.c` | 各模式 C 数组 |

全部 `deliberately NOT tracked`（`.gitignore:13-31` 逐个显式列出；用显式名而非 `src/polyfill_*.c` glob，以免未来手写的 `src/polyfill_<name>.c` 被静默忽略）。

生成目录：**`build/generated/polyfill/`**（`CMakeLists.txt:106-108` `set(_polyfill_gen_dir "${CMAKE_CURRENT_BINARY_DIR}/generated/polyfill")`——中间产物一律进 `build/`，不污染 `src/`）。

## 为何推翻（理由）

**非可复现**：同源两次构建，字节码可差几字节。故 committed 副本**必然漂移**于构建实际嵌入的版本——这正是 fuzz-corpus 对齐门与「bytecode vs polyfill/src」审查反复误伤的原因。

佐证：`bc-reader-hardening` 记录的漂移事件——`test/fuzz-corpus/seed-polyfill-head*.bc` 声明的「仓库那份字节码头 N 字节」，HEAD 上是 `1b99c2fa`/`1bbc192a`，而仓库真实的是 `1cb7bf5b`/`1c7ae3a5`；`polyfill/` 与 `deps/quickjs-ng` 指针都没动，说明漂移长期存在、无信号触发。**一类缺陷长期存在通常不是因为难，而是因为没有任何东西会为它变红**。

## 代价

构建 qzjs **现在需要 polyfill 工具链**（node + `npm --prefix polyfill ci`）——fresh clone 不能直接编译。见 `docs/dev/` 或 CI 各 job 的 setup。

## 被本决策推翻的旧记录

- `polyfill-bundling-policy`（2026-09-13）：「rodata 仍写 **tracked 基线** `src/polyfill_default.c`，compressed/external/host 各写 untracked `src/polyfill_<mode>.c`」——**tracked 部分已作废**（模式分家仍成立，但全部 untracked + 落到 `build/generated/polyfill/`）。
- `src/polyfill/build.js` 旧注释「fresh clone 无需 polyfill 工具链即可编译」——**已作废**。


## Timeline

- time: 2026-09-30T15:09:54
  kind: decision
  summary: "Created this page: 内嵌字节码是构建产物（推翻 rodata tracked 基线）：非可复现产物不进版本库"
  source: created via brain create-page
  affects: [bytecode-build-artifact]

- time: 2026-10-13T08:06:27
  kind: decision
  summary: "补真内容：推翻 rodata tracked 基线——内嵌字节码是纯构建产物（非可复现），全部 untracked，生成目录 build/generated/polyfill/（CMakeLists:106-108）。代价：构建需 polyfill 工具链。推翻 polyfill-bundling-policy 2026-09-13 tracked 基线条目与 build.js 旧注释。"
  source: ".gitignore:13-31 + CMakeLists.txt:106-117/150/492-502 + bc-reader-hardening 漂移事件"
  affects: [bytecode-build-artifact]
