---
id: oss-library-policy
title: "开源库引入与替换原则（项目级政策）"
category: decision
status: active
tags: [deps, policy, oss]
created: "2026-09-04T13:27:08"
updated: "2026-09-14T05:34:30"
---

<!-- compiled_truth -->
# 开源库引入与替换原则

**polyfill 层允许引入 npm polyfill 库（例外通道）。** 标准三条件仍适用于 C 层和非 polyfill JS 层；polyfill 层的 npm 引入额外要求：零依赖 + esbuild IIFE 无缝 bundle。若库只提供 ESM/CJS 且与 esbuild IIFE 冲突（如 whatwg-url 的 `__esModule` 导出模式时序阻断），或其依赖链过大（>100KB 传递依赖），则保留自研。

1. **正收益实证**：自制代码本身是风险源（已识别的正确性缺口、重复实现、维护负债），而非仅仅行数超阈值或"不够标准"。收益必须落到可删除的负债与可修复的缺口上，不接受"换上更规范"的抽象收益。
2. **原位可换**：能在不违反架构铁律（C 只给 pal 原语、协议策略在 JS）与不破坏跨层接口（PAL 原语面、bridge 字节协议、polyfill 内部耦合）的前提下原位替换。需要重写消费者或跨层接口的候选直接否决。
3. **vendor 成本可控**：C 库须 C99 兼容、零或近零传递依赖，按 deps/ 现行机制 vendor（本地快照 submodule + 随 repo 提交的补丁，见 [[quickjs-upstream-merge-strategy]]）；polyfill npm 库须零传递依赖 + esbuild IIFE 无缝 bundle（已验证：urlpattern-polyfill@10.1.0、@ungap/structured-clone@1.4.0、web-streams-polyfill@4.3.0）；若库只提供 ESM/CJS 且与 esbuild IIFE 冲突，或依赖链过大（>100KB 传递依赖），则保留自研。许可须与 MIT 兼容。

## 复核机制（"保留"不是终审）

三条件门槛只对引库举证、继续自制零举证，是单向失衡。因此：

- **年度复核**：每年对全量自制模块重跑一次三条件举证（2026-09 为首次基线）。
- **事件触发复核**：相关 CVE/安全公告、规范演进（WHATWG/RFC 修订影响自制实现）、或观察对象触发条件成立时，立即复核对应裁决，不等年度周期。
- 复核结果与触发理由写入本页 timeline；翻案走 update-truth + reversal。

## 2026-09 全量审计基线（27 个自制模块）

- **唯一建议替换（带硬触发）**：`src/io/uv_io.c` 手写 HTTP 客户端解析 → **llhttp**。约 700 行可删（parse_http_response ×2、双份 chunked 状态机、CONNECT 解析、URL 解析），消 ~290 行重复，修复 obs-fold / 多值 Transfer-Encoding / 双 Content-Length 冲突等 5 类健壮性缺口。它是全项目唯一"自制代码本身是风险源"的形状：既不在 JS 层（拿不到规范测试），也不是薄绑定（自造状态机）。**硬触发（满足其一即执行替换，不再 case-by-case）**：① 上述 5 类缺口任一在实际流量中确认触发缺陷；② 任何触及 parse_http_response / chunked 状态机的缺陷修复动工前，先做 llhttp 替换评估并留痕。
- **保留 + 触察**（触发条件写死，不许"以后再说"）：
  - `polyfill/src/url.js`（499 行，缺 IDNA）：whatwg-url 不可引入（tr46 IDNA 485KB 依赖链过大 + `__esModule` 与 esbuild IIFE 冲突，git show f350fbff）；实测解析 bug 出现 → 复核。
  - ~~`polyfill/src/url-pattern.js`~~ → 已替换为 urlpattern-polyfill@10.1.0（npm polyfill，零依赖，esbuild IIFE 无缝 bundle）。
  - `polyfill/src/hpack.js`（566 行，自维护 257 项 Huffman 表）：解码错误致实际 interop 故障，或 HPACK 规范表修订 → 复核 nghttp2 vendor 成本（当前"成本远超 660 行现实现"的否决理由随 http2.js 演进重估）。
- **保留（替换负收益）**，共同形态是"正确的薄层"：C 层 tcp_io.c / ext_crypto.c / ext_compress.c / debugger_dap.c / wasm 引擎绑定 / msgq.c（绑定与胶水，算法全在 mbedTLS/miniz/wasm 引擎）；JS 层 streams.js（→ web-streams-polyfill@4.3.0 已替换）/ ~~structured-clone.js~~（→ @ungap/structured-clone@1.4.0 已替换）/ fetch.js / protobuf.js / http2.js / websocket.js（协议逻辑有 WHATWG/RFC 可对照且有 harness 测试，开源候选均需垫 Node API 或破坏内部耦合）与其余 ~20 个杂项胶水。这些裁决均受上方复核机制约束，不是终审。
- 候选库已否决：libwebsockets（自带事件循环，架空 pal.tcp*，违架构铁律）、picohttpparser（只吃头解析，收益不足）、nghttp2（vendor + C 绑定层成本远超 660 行现实现）、protobufjs（~200KB 且假设 Node 生态）、whatwg-fetch/undici/ws polyfill（需 XHR/Node API）。
- 顺手清理项：`polyfill/src/index.js` 的 queueMicrotask 守卫 polyfill 是死代码（quickjs-ng 内置），可删。

## 2026-09-11 C 层 JSON：vendored cJSON（裁决反转）

- **裁决**：C 层 JSON 解析/序列化一律使用 vendored 官方库快照 **cJSON v1.7.19**（`deps/cjson/`，上游 commit c859b25，MIT，上游原样纯快照，**禁 submodule**），禁自制轮子。本裁决推翻同日早先的"手写共享份"方案（37d1e9c2：control/ipc JSON 归并手写 `qz_json_*`），由用户指令"不要手写"触发，落地 commit 08985bb8（净删 201 行手写 JSON 基建；验证 offline 20/20、dap 3/3、mp1_process_e2e PASS）。
- **唯一例外**：宿主 `cli.c` 的最小 escape——只 include cJSON 公共头，宿主边界不新增运行时 JSON 基建。

新模块默认自制 + harness 测试；要引库时先对三条件逐条举证，并核对上面的基线裁决；观察对象只在触发条件成立时换，触发条件变更须走本页 update-truth；"保留"裁决按复核机制周期性重举证，CVE 与规范演进立即触发。


## Timeline

- time: 2026-09-04T13:27:08
  kind: decision
  summary: "Created this page: 开源库引入与替换原则（项目级政策）"
  source: "开源库替换审计会话（oss-replace-audit）"
  affects: [oss-library-policy]

- time: 2026-09-04T13:27:55
  kind: decision
  summary: "固化开源库审计+评审结论为项目级引入与替换原则：默认自制+三条件门槛+2026-09 全量审计基线（uv_io.c→llhttp 唯一建议替换；url.js/url-pattern.js 观察对象带触发条件；其余保留）"
  source: "开源库替换审计会话（oss-replace-audit，5 scout 并行审计）"
  affects: [oss-library-policy]

- time: 2026-09-04T15:29:38
  kind: decision
  summary: "评审闭环（design-philosophy critique T3/T7）：uv_io.c→llhttp 替换裁决加硬触发（缺口实测触发 / 缺陷修复前强制评估）；新增复核机制（年度全量重举证 + CVE/规范演进事件触发）；hpack.js 从保留名单移入观察名单（interop 故障或规范表修订触发）；保留裁决明示受复核机制约束"
  source: brain update-truth
  affects: [oss-library-policy]

- time: 2026-09-07T08:02:42
  kind: note
  summary: "SW1 Service Worker scope 级匹配语义落地，urlpattern-polyfill 替换自维护 url-pattern.js 子集实现并规避 IDNA 解析 bug，配套 url.js 换 whatwg-url，回归 + 24/24 worker gtest + 4/4 套件全绿。"
  source: "SW1 Service Worker 里程碑"
  affects: [oss-library-policy]

- time: 2026-09-07T08:45:02
  kind: note
  summary: "更正：本页 2026-09-07T08:02:42 的 'SW1 Service Worker scope 级匹配语义落地，urlpattern-polyfill 替换…' 条目为误记——未发生 url-pattern.js→urlpattern-polyfill 替换，url.js 也未换 whatwg-url。该条内容与 SW 实际里程碑（fetch 拦截，非 scope 匹配）不符，属错误写入；正确记录见 [[service-worker-stack]]。本页 compiled_truth 审计基线（url-pattern.js 仍为自制子集，观察对象）不受影响。"
  source: "brain 记录复核修正"
  affects: [oss-library-policy]

- time: 2026-09-11T12:18:27
  kind: decision
  summary: "C 层 JSON 裁决反转：由\"手写共享份\"（37d1e9c2）改判为 vendored cJSON v1.7.19 官方快照（deps/cjson/ c859b25，MIT，禁 submodule），C 层 JSON 一律用库、禁自制轮子；宿主 cli.c 最小 escape 为唯一例外（只 include 公共头）。触发：用户指令\"不要手写\"；落地 commit 08985bb8（净删 201 行手写 JSON 基建）"
  source: brain update-truth
  affects: [oss-library-policy]

- time: 2026-09-11T12:18:37
  kind: reversal
  summary: "2026-09-11 用户指令\"不要手写\"推翻同日早先\"C 层 JSON 手写共享份\"裁决（37d1e9c2：control/ipc 归并手写 qz_json_*）：C 层 JSON 一律 vendored 官方库快照（cJSON v1.7.19，deps/cjson/ 快照 c859b25，MIT，禁 submodule），禁自制轮子；宿主 cli.c 最小 escape 为唯一例外（只 include 公共头）。落地 commit 08985bb8（净删 201 行），验证 offline 20/20、dap 3/3、mp1_process_e2e PASS"
  affects: [c-js-layering]

- time: 2026-09-11T13:59:39
  kind: decision
  summary: "重写 compiled_truth：删除误嵌入的第二层 frontmatter 与旧 Timeline 副本，正文恢复为\"# 开源库引入与替换原则\"起（默认自制三条件 + 复核机制 + 2026-09 审计基线 + 2026-09-11 C 层 JSON vendored cJSON 裁决反转段）；仅修结构，不改动裁决内容"
  source: brain update-truth
  affects: [oss-library-policy]

- time: 2026-09-14T05:34:30
  kind: decision
  summary: "政策翻转：从「禁止引入外部 npm/JS 依赖」改为「polyfill 的 npm 包必须能用 esbuild 无缝 IIFE bundle；若库只提供 ESM/CJS 且与 esbuild IIFE 冲突（如 whatwg-url 的 __esModule 导出模式时序阻断），或其依赖链过大（tr46 IDNA 485KB），则保留自研」。已引入三库：urlpattern-polyfill@10.1.0（MIT）、@ungap/structured-clone@1.4.0（ISC）、web-streams-polyfill@4.3.0（MIT）——均为零依赖 + esbuild IIFE 无缝 bundle。保留自研项：url.js（whatwg-url 不可引入：tr46 IDNA 485KB 依赖链过大 + __esModule 与 IIFE 冲突，git show f350fbff）。体积变化：polyfill bytecode 139KB → 264.5KB（+125KB，qjsc 常量表膨胀，用户已接受）。完整提交链：24d34452/71c3a6ea/86258431/eb1f251e/d56bb2cc/f350fbff。"
  affects: [oss-library-policy]
