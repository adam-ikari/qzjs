---
slug: flow
title: Key flows
role: key flows
updated: "2026-09-28T14:51:17"
---

# Key flows

## End-to-end path of a typical request（宿主→JS 消息；M-P7 目标态 = mailbox）

```mermaid
sequenceDiagram
  participant H as Host C
  participant Q as qzjs 自管线程(泵/运行时)
  participant L as libuv(库自有 loop)
  participant J as QuickJS runtime
  participant M as 邮箱(host 方向队列)
  H->>Q: qz_create(cfg) — initial_script
  Q->>L: uv_run loop（库线程）
  Q->>J: eval initial_script
  J->>J: postMessage({ok:true})
  J->>M: 入箱（NUL 终止 JSON）+ 唤醒 fd
  H->>M: qz_recv_message(timeout) / qz_message_fd 可读后取件
  H->>Q: qz_post_message({"cmd":"eval",...})（任意线程，MPSC）
  Q->>J: __qz_dispatch__ → onmessage eval
  J->>M: 结果 postMessage 入箱
  H->>M: qz_recv_message → 结果
  H->>Q: qz_destroy() — 请求停止
  Q->>L: uv_stop + join（终止预算冻结在库线程）
```

**现状差异（过渡态 M-P6，已实现）**：ISOLATED 下无库侧宿主泵线程——通道句柄挂宿主注入的
cfg.uv_loop，message_cb 在泵宿主 loop 的线程触发，阻塞 API 就地 NOWAIT 泵，邮箱/唤醒 fd
不存在；M-P7 实施后本图取代 M-P6 语义（见 [[multi-process-model]]）。

## Other important flows

- Worker 生命周期：qzjs 内部新建线程 → QuickJS 独立 JSRuntime → __qz_dispatch__ 消息通道
- MessagePort 跨线程：pal.portCreate() 分配全局 port id 对 → 序列化到字节通 → 接收侧 __qz_port_from_ref__ 重建代理
- HTTPServer 请求：serve() raw TCP accept → JS 解析 HTTP/1.1 → JS handler（fetch 风格）→ JS 构造 Response → 经 tcp/TLS 原语回写
