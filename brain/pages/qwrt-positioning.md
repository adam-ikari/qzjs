---
id: qzjs-positioning
title: "qzjs 定位：IoT 连接性中枢（gRPC/HTTP2 双端），非硬件抽象层"
category: decision
status: active
created: "2026-09-09T01:24:36"
updated: "2026-09-28T14:53:28"
---

<!-- compiled_truth -->
# qzjs 定位（用户拍板 2026-09-09，2026-09-10 更新，2026-09-28 通信面措辞对齐 M-P7）

- 目标市场 = **IoT 设备（gRPC/HTTP2 客户端连云）+ 云端边缘节点（gRPC/HTTP2 服务端）**
- gRPC/HTTP2 **客户端与服务端都是必需**：H1-H4 均属正确定位
- **设备原语（GPIO/BLE/serial 类）不是 qzjs 原生追求**——硬件抽象是宿主/其他层职责
- 与嵌入式定位一致：小内存/快启动/确定性是护城河，连接性是核心能力面
- WinterTC 子集对齐保持（标准可移植承诺）

## 定位补充（2026-09-10）：通用运行时，非专属应用运行时

qzjs **不转型**为应用运行时（不做 manifest/权限模型/应用包格式等平台层），设计目标仍是**通用嵌入式 JS 运行时**。取向调整：作为"应用运行时引擎"预留**灵活接口**，让宿主/平台层在其上构建自己的应用运行时（类比：ART 之于 Android——引擎与平台分层）。已有底座即此取向的体现：

- 加载注入：initial_script / polyfill 模式 B（外置文件）/ D（weak hook）——宿主自定义应用装载
- 运行期控制：CTL-0 控制面（eval/inspect/metrics/interrupt，三档安全模型）
- 通信：qz_post_message 入向 + host 方向 mailbox 消费（qz_recv_message / 唤醒 fd，M-P7 裁决目标态；现状过渡 M-P6 = message_cb 回调）——纯 postMessage 机制，qzjs 不跨线程调用宿主代码；JS 侧 Worker/MessageChannel 不变
- 生命周期：软挂起/恢复（suspend/resume to disk）+ 扩展 suspend/resume 钩子
- 多实例：M-R1 多 qz_t 并存

原则：引擎提供**机制**（mechanism），不绑**政策**（policy）——应用格式/权限/生命周期策略由宿主层定义，qzjs 只保证接口足够灵活可组合。


## Timeline

- time: 2026-09-09T01:24:36
  kind: decision
  summary: "Created this page: qzjs 定位：IoT 连接性中枢（gRPC/HTTP2 双端），非硬件抽象层"
  source: "2026-09-09 用户定位拍板"
  affects: [qzjs-positioning]

- time: 2026-09-09T01:24:45
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [qzjs-positioning]

- time: 2026-09-10T01:30:19
  kind: decision
  summary: "定位更新：qzjs 保持通用嵌入式 JS 运行时，不做专属应用运行时；设计取向是为'宿主把它用作应用运行时引擎'预留灵活接口（挂载/加载/控制/生命周期钩子），类比 ART 之于 Android——引擎通用、平台层在上层构建"
  source: brain update-truth
  affects: [qzjs-positioning]

- time: 2026-09-28T14:53:28
  kind: decision
  summary: "通信面措辞对齐 M-P7 裁决：宿主通道 = postMessage 入箱 + 宿主自取（现状过渡 M-P6 message_cb）"
  source: "2026-09-28 宿主通讯再裁决会话"
  affects: [qwrt-positioning]
