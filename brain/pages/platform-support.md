---
id: platform-support
title: "平台支持：仅 Linux，不承诺跨平台"
category: decision
status: active
tags: [platform, linux, scope]
created: "2026-10-04T03:41:49"
updated: "2026-10-04T03:42:03"
---

<!-- compiled_truth -->
## 结论

**qzjs 只支持 Linux，不承诺 macOS / Windows / BSD。**（2026-10-03 用户拍板）

这不是"还没做"，是**范围决定**。跨平台验证不在待办清单里。

## 为什么写下来

此前 brain 里没有任何平台相关记录，文档也未明确声明——是沉默而非承诺。沉默的代价：
macOS/Windows 用户读 `docs/guide/building.md`（"所有依赖从源码构建，无需系统包"）
照着做，撞墙后才发现这不是支持的平台。范围决定必须显式写在文档里，不能靠读者自己撞出来。

## Linux-only 的技术根据（非推测）

代码里有明确的 Linux 专属依赖，不是"没适配"那么简单：

- `qz_message_fd()` 返回 `eventfd`——Linux 特有的 syscall（README 已标 Linux-only）
- 控制面 LOCAL 档用 `AF_UNIX` 端点 + `SO_PEERCRED` 校验 uid
- io_uring 需显式禁用（`UV_USE_IO_URING=0`，qzjs.c:109——某些内核 io_uring_setup
  会破坏 futex/pthread_cond 唤醒，导致 cond_wait 永不返回）
- 测试 mock 层依赖 eventfd 语义；CI 仅 ubuntu-latest

## 影响面

- **CI**：只在 ubuntu-latest 跑。这是**符合范围**的，不是缺口。不要把"跨平台验证"
  列为成熟度待办项——那会引入不该做的需求。
- **文档**：`docs/guide/building.md` 与 `docs/zh/guide/building.md` 必须写明仅 Linux。
- **依赖**：`libuv`、`AF_UNIX`、`eventfd`、`pthread` 等按 Linux 语义用即可，不需要
  抽象层或条件编译去兼容别的平台（YAGNI）。
- **第三方声明**：`THIRD_PARTY_NOTICES.md` 里的依赖登记按 Linux 构建记录即可。

## 与成熟度评估的关系

评估「是否成熟」时，跨平台验证原本被列为待办第 3 步。**该步作废**——
Linux-only 是既定范围，不是未完成项。成熟度的剩余门槛只有一条：
冻结 breaking 变更、攒到 1.0（时间维度，无具体工作量）。


## Timeline

- time: 2026-10-04T03:41:49
  kind: decision
  summary: "Created this page: 平台支持：仅 Linux，不承诺跨平台"
  source: created via brain create-page
  affects: [platform-support]

- time: 2026-10-04T03:42:03
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [platform-support]
