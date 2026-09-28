---
slug: background
title: Project background
role: project background
updated: "2026-09-28T14:50:37"
---

# Project background

## Why

提供可嵌入的轻量级 JavaScript 运行时：C 宿主应用需要运行 JS（配置/脚本/插件），
但不想引入 V8/JSC 的体量，也不需要 Node.js 生态依赖。qzjs 以 libuv 驱动事件循环，
循环内置于运行时：主权原则（M-P7 裁决，2026-09-28）——qzjs 完全自主管理自己的进程
和线程，宿主形态不受干涉，通讯只用 postMessage 机制：JS→宿主的消息进库内部邮箱，
宿主在自选线程上 qz_recv_message 取件（或挂 qz_message_fd 唤醒 fd 进自己的事件
系统），qzjs 从不跨线程调用宿主代码。缺省 ISOLATED 进程模型下 JS 跑在独立主RT 进程
（qzjs-rt），THREAD 模型下跑在库内部线程——两模型宿主体验一致、零泵义务。
**现状为过渡态 M-P6**：ISOLATED 宿主需注入 cfg.uv_loop、message_cb 在泵线程触发；
该契约已被 M-P7 裁决取代，待实施翻转。

## Goals

- 可嵌入：单一 qz_create 初始化；宿主零事件循环参与——收发全走 postMessage/邮箱（M-P7 目标态；现状 M-P6 下 ISOLATED 宿主需泵自己的 loop）
- WinterTC 兼容：覆盖 Web 平台通用标准 API（fetch、streams、crypto、Worker、URL 等）
- 轻量：QuickJS-ng 引擎，低启动时间、低内存占用，严格 C99
- 确定性测试：mock_libuv 离线 gtest 全覆盖，CI 门禁（test262 + e2e）
- 原生扩展：压缩（miniz）、加密（mbedTLS）、WebAssembly（WAMR/wasm3）；HTTP 服务为纯 JS serve()（raw TCP + mbedTLS）

## Non-goals

- 不做 Node.js 兼容（无 npm 模块系统、无 Node API）；npm 包仅做运行时兼容验证
- 不做浏览器 DOM（无 DOM/HTML 解析）
- 不追求 V8 级别的 JIT 性能（目标场景是嵌入式/宿主脚本）

## Target user

- 需要把 JS 作为可脚本化插件层嵌入 C/C++ 应用的开发者（游戏、IoT、配置驱动、边缘）
- 需要轻量 Web Worker + MessagePort 并行模型的宿主
- 评估 WinterTC/WinterCG 运行时兼容性的嵌入式平台团队
