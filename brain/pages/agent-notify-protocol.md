---
id: agent-notify-protocol
title: "汇报协议：done/blocked/ask 推送给主 agent"
category: concept
status: active
tags: [agent-ops, protocol]
created: "2026-11-13T17:13:21"
updated: "2026-11-13T19:57:14"
---

<!-- compiled_truth -->
汇报协议（用户裁决 2026-11-13，绑定 agent-ops）：
- 干完一轮 / 卡住 / 需要人决定时，执行 `notify-main` 脚本把话直接推给主 agent（小奎），不要等对方轮询。
- 用法：`CHAT=/home/gem/project/chat /home/gem/project/chat/scripts/notify-main <done|blocked|ask> "<一句话>"`。
  - 脚本读 `$CHAT` 定位 a2a/herdr 工具，未导出会 `CHAT: unbound variable` 退出 1；新 shell 每轮 cwd/env 不持久，务必先 `export CHAT=/home/gem/project/chat`。
- 只发三种动作：`done` / `blocked` / `ask`。进展流水账不要发。
- 例外：通知应等自己这轮真正结束（验证通过）再报 done，不要把「还在跑」当 done。


## Timeline

- time: 2026-11-13T17:13:21
  kind: decision
  summary: "Created this page: 汇报协议：done/blocked/ask 推送给主 agent"
  source: "用户裁决 2026-11-13"
  affects: [agent-notify-protocol]

- time: 2026-11-13T17:15:16
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "用户裁决 2026-11-13"
  affects: [agent-notify-protocol]

- time: 2026-11-13T19:57:14
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "实测 2026-11-13"
  affects: [agent-notify-protocol]
