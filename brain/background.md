---
slug: background
title: Project background
role: project background
updated: "2026-09-28T11:28:23"
---

# Project background

## Why

提供可嵌入的轻量级 JavaScript 运行时：C 宿主应用需要运行 JS（配置/脚本/插件），
但不想引入 V8/JSC 的体量，也不需要 Node.js 生态依赖。qzjs 以 libuv 驱动事件循环，
循环内置于运行时：缺省 ISOLATED 进程模型下 JS 跑在独立主RT 进程（qzjs-rt），宿主侧
库不拥有线程——宿主经 cfg.uv_loop 注入自己的 uv_loop_t，message_cb 在泵该 loop 的
线程上触发（M-P6 契约，2026-09-28 翻转）；THREAD 模型下库自带内部线程，宿主
只通过线程安全的 C API 收发 JSON 消息，无需参与事件泵。

## Goals

- 可嵌入：单一 qz_create 初始化；ISOLATED 宿主侧「传入你的 loop、继续你的泵」，THREAD 宿主零轮询
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
