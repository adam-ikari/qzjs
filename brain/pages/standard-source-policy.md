---
id: standard-source-policy
title: "qzjs 能力面标准来源：WinterTC（ECMA-429 核心）∪ W3C Web API（补充）"
category: decision
status: active
tags: [standard, policy, wintertc, webrtc, w3c]
created: "2026-09-09T03:37:10"
updated: "2026-10-07T15:19:03"
---

<!-- compiled_truth -->
# qzjs 标准来源策略（用户拍板 2026-09-09）

- **能力面标准来源** = **WinterTC（ECMA-429 Minimum common web API，核心）∪ W3C Web API 标准（补充）**。
- WinterTC 已覆盖且已实现的能力：保持现状（ECMA-429 接口矩阵 + gtest harness，ROADMAP §二.7）。
- WinterTC **缺失**的能力：从对应 W3C 规范**补充实现**——API 面对齐该规范（接口/方法/属性/事件模型一致），**不是私有子集命名**。
- 先例归位（WinterTC 覆盖外能力按本策略定性）：
  - Service Worker / CacheStorage → W3C service-worker 规范（[[service-worker-stack]]）；
  - WebRTC → W3C webrtc-pc + webrtc-datachannel（RTCPeerConnection/RTCDataChannel/RTCSessionDescription/RTCIceCandidate/RTCConfiguration 对标本标准；实现分阶段）。
- **边界**：
  1. 标准对齐 = 接口面与语义（事件模型/方法/属性/回调）对齐规范文本；
  2. 互操作价值来自标准线格式（SDP/ICE/DTLS-SCTP/DTLS-SRTP）——与 Chrome/Firefox 对端互通；
  3. 实现完整性分阶段管理：接口面先行、内部能力分期填充（如 getUserMedia 无设备 → 正确 reject，不虚报）；
  4. 超出本策略的取舍（如媒体编解码引库）仍需走 [[oss-library-policy]] 三条件。
- **适用**：本策略是 WinterTC 之外能力面扩展的总则；与 WinterTC 冲突时 WinterTC 优先（核心），W3C 补充不覆盖已有实现。

## 与稳定面定义的关系（交叉引用，2026-10-07 补充）

本页定**能力面按什么标准实现**（WinterTC ∪ W3C），**不**定义「哪些 API 稳定/对外公开」。
**稳定面定义以 [[release-artifact-topology]] 术语澄清为准**：
- 稳定 API = qzjs 对外公开的 API 集合（WinterTC 为核心组成，**但不限于 WinterTC**）；
- 引擎/字节码二进制 ABI 永不保证跨版本兼容；
- wasm 独立可执行文件形态对外仅保证 WASI API。

两页正交：本页 = 实现标准来源；release-artifact-topology = 稳定/兼容承诺面。


## Timeline

- time: 2026-09-09T03:37:10
  kind: decision
  summary: "Created this page: qzjs 能力面标准来源：WinterTC（ECMA-429 核心）∪ W3C Web API（补充）"
  source: "2026-09-09 用户拍板（WebRTC API 设计会话追加指令）"
  affects: [standard-source-policy]

- time: 2026-09-09T03:37:45
  kind: decision
  summary: "2026-09-09 用户拍板：qzjs 能力面标准来源 = WinterTC（ECMA-429 最小集，核心）∪ W3C Web API 标准（补充）；WinterTC 缺失能力按对应 W3C 规范补充、API 面对齐该规范；先例归位 SW/CacheStorage→service-worker 规范、WebRTC→webrtc-pc+datachannel"
  source: "2026-09-09 用户追加指令（WebRTC API 设计会话）"
  affects: [standard-source-policy]

- time: 2026-09-13T00:44:30
  kind: decision
  summary: "bare 档废除落地（commit 99df2c40，2026-09-12）：用户裁决 qzjs 最新版本必须始终支持 WinterTC/ECMA-429，bare 档（五宏全 OFF：WAMR/TLS/COMPRESS/CRYPTO_EXT/TEXTCODEC，缺 WebAssembly/btoa/atob/crypto.subtle/CompressionStream）不满足必选集，废除。QZ_PROFILE 合法集合缩为 {standard, minimal}，CMakeLists.txt:22-27 对非法值 FATAL_ERROR；空值等效 standard（全 ON），minimal 仅 TLS=OFF 仍满足全量必选。README/docs(en+zh)/CHANGELOG 已同步。"
  source: "2026-09-13 修复所有定案会话"
  affects: [standard-source-policy]

- time: 2026-10-07T15:19:03
  kind: decision
  summary: "加交叉引用：稳定面定义以 release-artifact-topology 术语澄清为准（不止 WinterTC）"
  source: "2026-10-07 用户指示"
  affects: [standard-source-policy]
