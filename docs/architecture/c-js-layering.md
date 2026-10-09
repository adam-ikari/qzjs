# C/JS 分层原则与标准

> 状态：架构级标准（active）
> 日期：2026-09-09
> 范围：qzjs 运行时（QuickJS-ng 嵌入式/边缘）——"这该进 C 还是 JS"的唯一裁决依据，供所有新模块/新能力归类时引用。
> 背景：用户指令——**C 与 JS 分层需要有原则和标准**。本文从第一性原理 + 现有实现（协议栈先例、spawn 分层化、信封/队列归类）归纳，将 ROADMAP §二.1 的单一表述（"能力原语 vs 协议策略"）展开为可逐条引用的判据、灰区决策流程与全量模块归类清单。
> 依据：ROADMAP §二.1；`docs/archive/plans/2026-09-03-grpc-http2-design.md` §2.2-2.4；`docs/archive/plans/2026-09-04-multi-process-model.md` §4；commit `606acb81`（spawn 分层化）；`src/polyfill/src/*.js`；`src/msgq.c`、`src/ipc_envelope.c`；brain `[[oss-library-policy]]`、`[[qzjs-positioning]]`、`[[httpserver-ws-fixes]]`、`[[wpt-runner-removed]]`。
> 冲突处置：本文件与 brain 决策页冲突时，以 brain 为准修订本文件（ROADMAP §二.9 SSOT 分工同款）。

**核心结论（TL;DR）**

1. **C 层 = 能力原语层**：只给"一次调用完成一件事"的原语——无状态单调用、字节级传输/加密/压缩、性能关键且接口长期稳定、引擎/运行时必需系统能力（判据 §2）。
2. **JS 层 = 可编程逻辑层**：一切有状态、有决策、需跟随标准演进的东西——协议状态机、策略/路由/应用逻辑、WinterTC 标准 API 面、需可审计/可热替换/可随 polyfill 升级的部分（判据 §3）。
3. **灰区不拍脑袋**：走"边界四问"决策流程（§4）——Q1 协议/策略语义→JS；Q2 字节级单调用→C；Q3 性能瓶颈+接口稳定→才考虑下沉 C（JS 接口不变）；Q4 跨实现互操作/标准跟随→JS。默认归 JS，下沉需额外举证。
4. **已裁决**：HPACK 首版不下沉（D-HPACK，服务端场景观察后决策）；FlatBuffers 信封 C-only、JS 零感知；spawn 原语通用化 + JS 封装 Worker；nghttp2 否决；msgq 归 C。已付代价：uvhttp C 服务器引入又移除（§7 警示）。

---

# 1. 为什么分层（第一性原理）

## 1.1 角色定义

- **C 层 = 宿主层**：链接 libqzjs 的应用是设备固件/边缘服务（C99 宿主，嵌入式目标平台 FreeRTOS/ESP32 等，ROADMAP §二.6）。C 层含引擎核心（QuickJS-ng/libuv/wasm）与能力原语（tcp/fs/crypto/compress）。
- **JS 层 = 可编程逻辑层**：polyfill bundle（字节码注入 JSRuntime）+ 应用代码。可升级（换 bundle）、可替换（按 `QZ_WITH_GRPC` 等开关裁剪组成）、可审计（源码即规范面）。

## 1.2 分层的四条第一性约束

分层不是风格偏好，是以下约束的必然结果：

1. **宿主主导权（嵌入式确定性）**：C 层必须自持，不能依赖 JS 层存在——设备固件可在无 polyfill/无应用 JS 的情况下初始化、跑事件循环、提供原语。小内存/快启动/确定性是护城河（[[qzjs-positioning]]）。→ 引擎与系统能力只能进 C。
2. **策略可演进且不绑架宿主**：路由、缓存、压缩选择、重试/退避是**决策点**，会随业务与需求变化；若进 C，每次策略调整都要改 C/重编译/升级固件——绑架宿主。JS 层策略随 bundle 升级即可，零宿主改动。
3. **协议面随标准演进**：HTTP/1.1、WS（RFC 6455）、h2（RFC 7540）、HPACK（RFC 7541）、gRPC 的语义细节持续修订。JS 层升级成本远低于 C（无 rebase、无 ABI、无 vendored 补丁冲突面）。
4. **风险隔离**：内存错误（UAF/double-free）是本项目第一缺陷类别（ROADMAP §二.3）。协议状态机有大量边界分支，放 C 直接扩大 C 缺陷面；放 JS 的缺陷是可控逻辑错误，不产生 C 层内存破坏。

## 1.3 一句话概括

> **C 只回答"怎么拿到/送出字节"，JS 回答"这些字节是什么意思、该怎么处理"。** 状态机、决策、标准语义归 JS；传输、加解密、压解、引擎能力归 C。

---

# 2. 判据——什么进 C（能力原语标准）

四条判据，按序检查；满足任意一条即 C。1/2 是硬性归属，3 是"性能下沉"专项门（此时 JS 接口不变），4 是宿主必需。

## 判据 C1：无状态单调用语义

一次调用完成一件事，不维护跨调用的协议/会话状态。

| 实例 | 说明 |
|---|---|
| `tcpWrite` / `tcpClose`（tcp_io.c） | 写一次、关一次，无连接语义 |
| `fsRead` / `fsReadBinary`（uv_io.c） | 读一次，字节直写 ArrayBuffer，零拷贝 |
| `nativeCompress` / `deflatePush`（ext_compress.c） | 单发压缩 / 流式压解原语，无协议状态 |

**反例警示**：帧解析、握手、多路复用都是有状态语义——即使实现"简单"，一旦需要跨调用记忆即归 JS（见判据 JS1 与 §4 Q1）。

## 判据 C2：字节级传输 / 加密 / 压缩（不含协议语义）

C 搬运、加解密、压解字节，但**不解释字节的含义**。协议语义的起点（"这一字节是头部还是 body"）就是 JS 的起点。

| 实例 | 说明 |
|---|---|
| `tcp_io.c` | bind/connect/read/write/close + mbedTLS 握手/加密传输；不解析应用层 |
| `uv_io.c` | 异步文件/HTTP 传输原语 + TLS 客户端模板；`httpRequestStream` 只给字节流 |
| `ext_crypto.c`（mbedTLS 绑定） | 摘要/HMAC/AES/ECDSA 等，只做算法不做协议 |
| `ext_compress.c`（miniz 绑定） | gzip/deflate 压解，不含"何时压缩"的策略 |
| `ext_textcodec.c` | UTF-8/Base64，纯字节变换 |

## 判据 C3：性能关键且接口长期稳定（下沉专项门）

本判据是"已归 JS 的模块可否回退到 C"的唯一通道。条件：

1. **性能瓶颈是实测的**，不是预判的（基准纪律：wrk/gtest 基线，见 ROADMAP §五）；
2. **接口进入稳定期**——跨层接口（PAL 原语面）一旦确立即长期不变（ROADMAP §二.3 所有权/接口纪律同源）；
3. **下沉后 JS 接口面不变**——下沉只是把实现换层，JS 侧 API 零感知（如 HPACK 候选：`pal.hpackEncode/hpackDecode` 可替换 hpack.js 内部，不改变上层 http2.js 调用面）。

| 实例 | 理由 |
|---|---|
| `msgq.c`（lock-free MPSC） | 每消息一次 ACQ_REL exchange，内存序精确控制；四符号 `qz_msg_push/pop/has_pending/free` 接口稳定。线程安全是 C 才能做的（JS 无内存序表达） |
| `ipc_envelope.c`（FlatBuffers 信封） | 字节级 vtable/offset 编解码 + payload zero-copy 片引用；C 内部格式，JS 不感知（裁决记录 §6.2） |

## 判据 C4：引擎/运行时必需的系统能力

宿主级能力，JS 无法自造或自造即重写引擎。

| 实例 | 说明 |
|---|---|
| libuv | 事件循环、异步 I/O、线程、进程——qzjs 的生命线 |
| quickjs-ng | JS 引擎本体（ES2023，C99 补丁构建） |
| WAMR / wasm3 | wasm 引擎（Fast Interp + AOT / 备选） |
| qzjs.c / context.c / thread.c / bridge.c 等 | 运行时生命周期、上下文、内部线程、C↔JS 桥——JS 层的存在前提 |

---

# 3. 判据——什么进 JS（可编程逻辑层标准）

满足任意一条即 JS。默认情形：**新能力不满足 C1-C4 时，默认归 JS**（下沉需额外举证，与 [[oss-library-policy]]"默认自制、引库单向举证"精神同构）。

## 判据 JS1：协议状态机

一切有连接/流/帧级跨调用状态的语义。放 C 意味着要再造一个 C↔JS 事件桥（桥接成本 ≈ 协议本身，见 §6.4 nghttp2 否决）。

| 实例 | 协议 | 传输只用 |
|---|---|---|
| `http-server.js` | HTTP/1.1 解析/路由/响应序列化 + WS 服务端 | `pal.tcpListen/tcpWrite/tcpClose` |
| `websocket.js` | RFC 6455：握手/掩码/帧/close/ping-pong 全 JS | `pal.tcpConnect/tcpWrite/tcpClose` |
| `http2.js` | RFC 7540 客户端：帧层 + 流状态机 + 双窗口流控 + CONTINUATION | `pal.tcpConnect`（TLS/ALPN 在 C 给字节流） |
| `http2-server.js` | RFC 7540 服务端（Phase 3 进行中）：前导校验 + 请求流 + 响应/流控/GOAWAY | 同上 |
| `hpack.js` | RFC 7541：静态表 61 项 + Huffman 257 项 + 动态表，全 JS | 无 `pal`（纯算法） |
| `grpc.js` / `grpc-server.js` | gRPC unary 语义：5 字节前缀、trailers、grpc-status、deadline | h2 引擎之上 |
| `protobuf.js` | proto3 动态解析 + wire 编解码 | 无 |

## 判据 JS2：策略 / 路由 / 应用逻辑

决策点归 JS：可审计（策略白纸黑字）、可替换（换 bundle/换脚本即换策略）、不绑架宿主。

| 实例 | 决策点 |
|---|---|
| serve 路由（http-server.js） | 路由映射、静态文件、中间件顺序 |
| Service Worker 拦截（service-worker.js） | SW 注册策略、fetch 拦截/缓存策略 |
| 压缩策略选择 | serve 不自动压缩，应用层决定 Content-Encoding（ROADMAP B1） |
| worker 后端选择（worker.js） | `workerBackend()` 分流 THREAD/PROCESS，语义在 JS 封装 |

## 判据 JS3：标准 API 面（WinterTC）

有规范文本可对照、需跟随标准演进、以 harness 测试验证的接口——天然是 JS 的既有工作方式（gtest + e2e 对照 WHATWG/RFC）。

fetch / cache-storage / streams / service-worker / worker / worker-boot / message-channel / broadcast-channel / structured-clone / url / url-pattern / encoding / text-encoding / blob-file-formdata / event-target / event-source / abort / timers / performance / navigator / error-events / console / crypto / crypto-subtle / local-storage / storage / fs 等（完整清单见 §5）。

## 判据 JS4：需可审计 / 可热替换 / 可随 polyfill 升级

polyfill bundle 是**单一替换单元**（`build.js` 打包 + `QZ_WITH_GRPC` 等开关控制组成，`polyfill_default.c` 内嵌字节码）。归 JS = 升级不改 C、不重编固件；归 C 则每次修订都是 vendored 补丁 + rebase 负债（见 §7 uvhttp 代价）。

---

# 4. 边界判据（灰区四问）——新模块归类决策流程

新能力需求出现时，按序回答四问：

```
新能力需求
 │
 ├─ Q1 是否含协议/策略语义（状态机/决策点/语义解释）？ ──是──▶ JS
 │    否
 ├─ Q2 是否字节级单调用原语（无跨调用状态）？ ──────────是──▶ C
 │    否
 ├─ Q3 性能瓶颈（实测）且接口长期稳定？ ──────────────是──▶ 考虑下沉 C；
 │    （是/否都继续 Q4）                               │    JS 接口不变
 │    否
 ├─ Q4 需跨实现互操作 / 跟随标准演进？ ────────────────是──▶ JS
 │    否
 └─ 默认归 JS（可编程逻辑层优先；下沉需额外举证）
```

**四问使用规则**：

- **Q1 优先于 Q2**：语义决定归属。帧解析只在流上下文中有意义，把"帧解析"与"流状态机"劈成 C/JS 两半两头不讨好（grpc 设计 §2.3 方案 C 帧原语形态明确不推荐）。
- **Q3 是唯一回退到 C 的门**，三条件全要求：实测瓶颈（非预判）+ 接口稳定期 + 下沉后 JS 接口不变。下沉本身就是一次边界裁决，须走 §6 记录。
- **Q4 是"留在 JS"的加强项**：跨实现对等（grpc-go / nghttp2 / Node http2 对测）与标准跟随依赖规范文本对照 + harness 测试——这正是 JS 层既有工作方式；归 C 会失去这套验证路径。
- **归 C 的举证责任在提议方**：说不清判据 C1-C4 哪条成立，就不该下沉（参照 [[oss-library-policy]]"默认自制"的单向举证结构）。

---

# 5. 标准清单表（现有模块全量归类）

## 5.1 C 层（src/*.c）

| 模块 | 归类 | 理由（判据） |
|---|---|---|
| qzjs.c | C | 运行时生命周期（C4） |
| context.c | C | 上下文/JSRuntime 管理、扩展表（C4） |
| thread.c | C | 内部线程 + 事件循环（C4） |
| worker.c | C | THREAD 后端 worker 管理；PROCESS 分流已删，由 JS worker.js 封装（C4 + JS1/JS2，commit `606acb81`） |
| ipc_process.c | C | PROCESS 后端进程 worker / spawn 原语（C4 + C1） |
| ipc_envelope.c | C | FlatBuffers 信封编解码：字节级 + zero-copy、C 内部格式（C2/C3） |
| msgq.c | C | lock-free MPSC：性能关键 + 接口稳定（C3） |
| tcp_io.c | C | TCP/TLS 原语：传输 + 加密，无协议语义（C2） |
| uv_io.c | C | libuv I/O 原语 + TLS 客户端模板（C2） |
| bridge.c | C | C↔JS 桥：pal 注册、消息派发（C4） |
| polyfill_load.c / polyfill_default.c | C | polyfill 字节码装载（C4） |
| worker_boot_default.c | C | worker boot 字节码内嵌（C4） |
| ext_crypto.c | C | mbedTLS 绑定，算法原语（C2） |
| ext_compress.c | C | miniz 绑定，压解原语（C2） |
| ext_textcodec.c | C | UTF-8/Base64 字节变换（C2） |
| ext_wamr.c / ext_wasm3.c | C | wasm 引擎绑定（C4） |
| extension.c | C | 扩展注册表（C4） |
| control.c | C | 控制平面（C4） |
| debugger.c / debugger_dap.c | C | DAP 调试器（C4；调试是工具面非应用协议） |
| cli.c | C | CLI 入口（C4） |
| rt_main.c | C | `qzjs-rt` 进程入口（C4） |

## 5.2 JS 层（src/polyfill/src/*.js）

| 模块 | 归类 | 理由（判据） |
|---|---|---|
| index.js / pal.js / grpc-stack.js / grpc-stack-stub.js | JS | bundle 接线层（polyfill 内部编排） |
| host-messaging.js | JS | 宿主消息边界：W3C worker 消息契约（JS3） |
| worker.js | JS | Worker 父侧封装 + 后端选择策略（JS2/JS3；底层 processSpawn 是 C 原语） |
| worker-boot.js | JS | worker 启动 shim（JS3） |
| service-worker.js | JS | SW 注册/生命周期 + fetch 拦截策略（JS2/JS3） |
| context.js | JS | 多上下文 + 软挂起 JS 面（JS3 辅助面） |
| http-server.js | JS | HTTP/1.1 + WS 服务端状态机（JS1） |
| websocket.js | JS | RFC 6455 全状态机（JS1） |
| http2.js | JS | RFC 7540 客户端帧层 + 流状态机（JS1） |
| http2-server.js | JS | RFC 7540 服务端引擎（JS1，Phase 3 进行中） |
| hpack.js | JS | RFC 7541 编解码（JS1；下沉候选，见 D-HPACK §6.1） |
| grpc.js / grpc-server.js | JS | gRPC unary/服务端语义（JS1，服务端 Phase 3 进行中） |
| protobuf.js | JS | proto3 动态解析 + wire 编解码（JS1/JS3） |
| fetch.js | JS | fetch API 面 + 请求语义（JS3；传输字节经 pal.httpRequestStream） |
| cache-storage.js / local-storage.js / storage.js | JS | 存储 API 面 + 持久化策略（JS3） |
| streams.js | JS | 流原语（JS3，标准语义） |
| structured-clone.js | JS | structuredClone 序列化（JS3；字节进信封由 C 透传） |
| blob-file-formdata.js / encoding.js / text-encoding.js / url.js / url-pattern.js / event-target.js / event-source.js / abort.js / timers.js / performance.js / navigator.js / error-events.js / console.js / message-channel.js / broadcast-channel.js / crypto.js / crypto-subtle.js / fs.js | JS | WinterTC 标准 API 面（JS3；fs.js 的底层字节 I/O 在 uv_io.c） |

> 注：`http2-server.js`/`grpc-server.js` 为 H4（Phase 3）在写文件（2026-09-09），列入上表时以落地时状态为准。它们与本标准预测一致：服务端 h2/gRPC 语义层仍为纯 JS，C 只补 TLS/ALPN 字节面。

---

# 6. 边界裁决记录

每次"是否下沉 C / 协议是否进 C"的裁决在此留痕。新裁决追加，不覆盖历史。

## 6.1 HPACK（D-HPACK）：首版不下沉，服务端场景观察后决策

- **结论**：HPACK 编解码全 JS（hpack.js 566 行，静态表 61 + Huffman 257 + 动态表），客户端场景不做下沉；Phase 3 服务端前再评估（grpc 设计 §2.4 D-HPACK）。
- **依据（灰区 Q3）**：性能下沉三条件当前不成立——首版客户端场景无**实测**瓶颈（RFC 7541 附录 C 官方向量 + python hpack 交叉对测 14/14 全绿）；接口未到需要 C 替换的稳定点。
- **触发条件**：服务端并发/大消息场景下 HPACK 编解码成为**实测**拖累 → 下沉 `pal.hpackEncode/hpackDecode`（复用 miniz 扩展模式，~150-250 行 C），**JS 接口不变**（上层 http2.js 调用面零感知）。
- **参考**：grpc 设计 §2.4；[[oss-library-policy]] 观察对象（hpack.js 保留裁决同源）。

## 6.2 FlatBuffers 信封：C-only，JS 零感知

- **结论**：IPC 信封用 FlatBuffers，编解码全在 C（ipc_envelope.c）；JS 层完全无感知（multi-process-model §4.2）。
- **依据**：信封是**进程边界 C↔C 内部格式**，JS 层 payload 保持 structured clone 字节透传零改动；zero-copy 仅在 C 层成立——JS 急切 decode 无性能优势（ROADMAP H5 flatbuffers.js 退役理由同源）。跨实现互操作（Q4）只对 fb 规范线格式成立，由 C 手写编解码保证（Python flatbuffers 交叉验证）。
- **反证**：JS 层 flatbuffers.js 因"无性能优势 + 非跨进程场景"被退役（H5），正反两面都证明：格式若只在 C 内部使用，不进 JS。

## 6.3 spawn：C 原语通用化 + JS 封装

- **结论**：C 层 `qz_proc_spawn` 是通用"启动任意可执行文件"原语（exe + 调用方拼 argv + 子端固定通道 fd=3 + `require_handshake` 可跳过）；polyfill worker.js 用其封装 W3C Worker 接口（commit `606acb81`，`/usr/bin/echo` 冒烟验证通用性）。
- **依据**：进程启动是**无状态单调用系统能力**（C1 + C4）；Worker 是**标准 API 面**（JS3）+ 后端选择策略（JS2）。分层化后 C 层 PROCESS 专用分流删除（worker.c），原语可复用于任意子进程场景。

## 6.4 nghttp2：否决（协议库进 C 的完整反例）

- **结论**：不 vendored nghttp2，h2/HPACK 全 JS（grpc 设计 §2.2）。
- **否决理由**：
  1. 破坏架构铁律——协议策略进 C，h2 成为唯一例外，与 WS/serve() 纯 JS 模式割裂；
  2. **桥接成本 ≈ 自建代价**——nghttp2 是 C 回调式 session API，把帧事件桥回 JS 等于再造一个 h2 事件接口，桥的工程量与 bug 面接近纯 JS 方案；
  3. 杀鸡用牛刀——库本体 ~2 万行 C，为一个明确的 gRPC h2 子集引整个引擎；
  4. gRPC 层无论如何仍要自写，nghttp2 只省帧/HPACK。

## 6.5 msgq：C

- **结论**：lock-free MPSC 消息队列归 C（src/msgq.c）。
- **依据**：性能关键（每消息一次 ACQ_REL exchange + 内存序精细控制，规避 PVE 6.17 futex 唤醒不可靠）+ 接口稳定（`qz_msg_push/pop/has_pending/free` 四符号长期不变）。线程安全是 C 才能表达的能力（C3 + C4）。

## 6.6 C 层 JSON 三站点：统一 vendored cJSON（用户指令：不手写）

- **结论**（2026-09-11 改判，用户指令推翻同日"手写共享份"裁决）：C 层 JSON
  一律用 vendored 开源库 **cJSON**（deps/cjson/，v1.7.19，MIT，
  cJSON.c + cJSON.h 单文件，严格 C99，上游原样快照）——不自制轮子。
  C 层本身归 C 的裁决不变，变的只是实现来源：手写 JSON 基建全部删除。
  1. `debugger_dap.c`（原 json_parser/json_parse_string/json_get/
     json_get_int/json_emit/json_emit_string，~280 行）：**cJSON 替换**。
     C 层时机论证仍成立——解析点 `dap_on_stopped` 暂停态处理运行在 JS 断点内，
     世界冻结、引擎栈在断点现场，`JS_ParseJSON` 属引擎重入。但 DAP 是
     Content-Length 分帧、整帧到手才解析（`dap_read_message`），无增量
     解析需求，`cJSON_Parse` 直接可用；序列化改 `cJSON_CreateObject` +
     `Add*` 构建 + `cJSON_PrintUnformatted`。行为由 `test_dap_gtest`
     锁定（9 用例 8 场景全过）。
  2. `control.c`（原共享份 qz_json_get_str/get_int 调用点）：**cJSON
     替换**。`qz_control` 在生产者线程，无 JSContext（JSRuntime 归
     qzjs 线程所有），且 interrupt 要求 runtime 暂停/未初始化也能入队
     生效——C 层时机不变；字段提取改 `cJSON_Parse` +
     `cJSON_GetObjectItemCaseSensitive`（correl/timeout_ms/op 三字段，
     缺字段失败路径不变）。完整解析仍在 dispatch（qzjs 线程）走
     `JS_ParseJSON`。
  3. `ipc_process.c`（原共享份调用点）：**cJSON 替换**。两个调用点都在
     JS context 尚不存在的窗口——父进程 spawn 同步握手、子进程 rt_main
     启动顺序 handshake/ack（步骤 2）先于 qz_t init（步骤 3）。改走
     JS 需倒置启动顺序，时机论证不变；handshake/ack 提取（v/role/id、
     ok/v）改 `cJSON_IsNumber` + `valueint`，缺字段语义不变。
  4. `cli.c`（json_escape/json_unescape）：**保留手写，不改**。escape
     调用点在 `qz_create` 之前构造 bootstrap（引擎不存在，循环依赖）；
     cli.c 刻意只 include 公共头 `qzjs/qzjs.h`，是 libqzjs 的 dogfood
     宿主——cJSON 是库内部依赖（不出公共接口），引它进宿主示例违反
     dogfood 边界。最小 escape 函数留在宿主侧。
- **替换实现**：`qz_internal.h` 的 `qz_json_find_val/get_str/get_int`
  static inline 共享份删除；`deps/cjson/`（cJSON.c/cJSON.h/LICENSE/
  SNAPSHOT）按 deps 现行机制 vendored，`add_library(cjson STATIC)` 链接
  进 libqzjs，不安装、不导出公共头。
- **共同前提**（不变）：各站点取值对象均为受信任/自产 JSON（IDE 客户端、
  本进程回执信封、自产 handshake、自产 eval 信封），非攻击面；cJSON 在
  此前提下的正确性收益是转义解码/嵌套遍历等语义完整性，而非安全加固。

---

# 7. 违反案例警示：uvhttp（协议进 C 的实际代价）

git 历史中 C 层 HTTP 服务器引入又整体移除——这是本标准的**反面教科书**。

**时间线**：

| 日期 | commit | 事件 |
|---|---|---|
| 2026-08-17/18 | f9e29f4a / 0f66729f | 引入 uvhttp：C 层 `serve()` 扩展（HTTP/HTTPS/WS/static/gzip） |
| 2026-08-23 | fc7c19ff | WS 客户端先改为 JS RFC 6455 over raw TCP——"C provides transport (TCP), JS provides protocol (WS)"，与 fetch 模式对齐 |
| 2026-08-24 | 007ca25d / a81e553b | serve() 整体换纯 JS（http-server.js），删除 ext_http_server.c（uvhttp bridge） |
| 2026-09-01 | 33781e86 | 文档清理 uvhttp 引用，纯 JS serve() 成为当前架构 |

**实际代价账单**（协议进 C 的四个教训）：

1. **协议修正 = 改 vendored 库源码**：[[httpserver-ws-fixes]] 记录的 uvhttp 底层修复（`HPE_PAUSED_UPGRADE` 暂停未恢复、WS 101 后 uvhttp 状态错乱）都是 deps/uvhttp 源码补丁——每处都制造升级冲突面（与 [[quickjs-upstream-merge-strategy]] 同源 rebase 负债）。协议状态机的 bug 密集区正是 C 最难迭代的地方。
2. **桥接面是 bug 面**：ext_http_server.c 把 uvhttp 回调事件桥回 JS（onRequest/onWSConnection…），桥本身需要修复（`b9f5a0dc` code review findings 一类的 C 边界修复）。
3. **功能面被 C 束缚**：移除时 e2e 6 PASS + 3 SKIP，SKIP 全是 gzip/static/TLS——这些能力随 uvhttp 一并失去，纯 JS 化后全部恢复且更强（流式 body、backpressure、压缩策略选择，ROADMAP D1-D5）。
4. **演进停滞**：C 服务器形态无法承载 WinterTC `serve()` 语义细节（流式 `req.body`、W3C 风格连接生命周期、permessage-deflate 协商），最终被 JS 重写。

**现行红线**（ROADMAP §六）：**不复活 uvhttp C 服务器，已被纯 JS serve() 取代；除非性能上 JS 无法满足再评估**。此处的"再评估"即 §4 Q3 流程，必须实测 + 接口稳定 + JS 接口不变三者齐备，且先过 §6 裁决记录。

---

# 8. 引用关系

- ROADMAP §二.1（能力原语 vs 协议策略）——本文是其展开与操作化。
- `docs/archive/plans/2026-09-03-grpc-http2-design.md` §2.2-2.4——h2 选型、nghttp2 否决、D-HPACK 决策点。
- `docs/archive/plans/2026-09-04-multi-process-model.md` §4——信封 fb、payload 结构化克隆字节的层界。
- commit `606acb81`——spawn 分层化范例。
- brain `[[oss-library-policy]]`——"默认自制 + 单向举证"门槛模式，本文灰区默认归 JS 同构。
- brain `[[qzjs-positioning]]`——IoT 连接性中枢定位，约束能力面边界。
- brain `[[httpserver-ws-fixes]]` / `[[wpt-runner-removed]]`——uvhttp 代价与测试验证边界的证据。
