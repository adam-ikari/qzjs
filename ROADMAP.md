# qzjs 开发路线图（整体项目）

> 定位：**qzjs — 通用嵌入式 JS 运行时（可嵌入 QuickJS）**，非专属应用运行时；为宿主/平台层将其用作"应用运行时引擎"预留灵活接口。
> libuv-native、WinterTC 兼容、多上下文 + Web Workers、宿主↔运行时消息、
> 原生扩展（TLS/crypto/compress/WASM）、独立 CLI、服务端能力（serve）。
> 状态：滚动规划，随实际进展更新。最后更新：2026-09。

## 一、现状基线（2026-09）

### 运行时核心
- QuickJS-ng 引擎（ES2023，C99 补丁构建）、libuv 内部线程 + 事件循环
- 宿主↔运行时 JSON 消息（`qz_post_message` / `message_cb`，线程安全）
- 多上下文（spawn / suspend / resume，软挂起到磁盘）
- Web Workers（`new Worker(url)` 真并行线程）+ `structuredClone` / transferable
- DAP 调试器（`QZ_BUILD_DEBUGGER`，QuickJS-ng 打补丁）

### WinterTC 标准面（21 模块）+ Service Worker 子集
fetch / console / crypto.subtle / streams(含 BYOB) / timers / fs / storage /
encoding / url / URLPattern / abort / performance / event-target / blob(File,
FormData) / message-channel / navigator / structured-clone / error-events /
BroadcastChannel / CacheStorage / EventSource(SSE)；Service Worker（qzjs SW 子集：
fetch 拦截 + Cache + update，2026-09 合入 master，见 D6）。

### 服务端能力（应用层协议，qzjs 给原语）
- `serve()` 纯 JS HTTP/HTTPS/WS 服务器（TCP/TLS listener 在 C，协议在 JS）
- TLS（mbedTLS 服务器端握手）；WS 客户端（RFC 6455 over raw TCP）
- 文件读取 `fs.readFile` / `readFileBinary`；压缩 `CompressionStream`
- 应用层 example：路由 / LRU 缓存 + ETag / gzip（`examples/httpserver/`）

### 原生扩展
- WebAssembly：WAMR（默认，Fast Interp + AOT）/ wasm3（备选）
- mbedTLS（TLS + crypto.subtle）、miniz（compress）、textcodec（UTF-8/Base64）

### 质量
- gtest（mock_libuv 离线确定性）ctest offline 21/21 全绿；e2e 34/34 PASS
- CI 20 job：all-features-off / feature-matrix / wamr / wasm3 / polyfill-external /
  polyfill-compressed / nonutf-encodings / asan / ubsan / release /
  httpserver-perf / h2-client-perf / runtime-perf / cross-runtime / e2e /
  coverage（行覆盖 ≥50% 断言）/ debugger / test262 / clang-tidy / fuzz-smoke（libFuzzer 字节码读取 60s 冒烟）
- polyfill 三模块委托 OSS 库（url-pattern / structured-clone / streams），开源依赖数 3；whatwg-url 保留自研（tr46 IDNA 体积 + esbuild IIFE 时序双阻断）
- 服务端性能基线（wrk，阈值=基线 50%）：tiny 12.6k / small 3.1k / medium(16K) 256 / post 10.5k

## 二、架构原则

1. **能力原语 vs 协议策略**：C 层只给监听/回复、文件、压缩、加密等原语；
   路由、缓存、压缩策略、静态映射一律在应用层（JS）实现。
2. **异步优先**：所有 I/O（文件、网络、定时器）必须异步，绝不在事件循环上
   做阻塞式 fopen/fread。这是硬约束（文件/网络 I/O 已达成；TLS 的 mbedTLS
   同步 CPU 操作需严格异步化，列入 M2）。
3. **内存所有权**：跨层缓冲区一律单向转移（transfer 后原持有方不得再触碰）；
   回调上下文生命周期由注册方保证；destroy 顺序固定（停循环 → 释放上下文 →
   释放运行时）；确需共享的生命周期用引用计数（C2 裁决机制）。推论：所有权
   规则使跨层缓冲区无需锁保护——不得用加锁补救所有权设计（运行时内核保持
   单线程无锁）。依据：A1/A2/C2/D5 四次 UAF/double-free 修复，内存错误是
   本项目第一缺陷类别。
4. **测试分层**：mock_libuv 只测"对 libuv 的使用契约"（离线确定性）；真实
   后端行为（io_uring workaround 类 mock 盲区）由 e2e / 真环境压测覆盖。
   新增或更换 libuv 后端、行为相关的 uv 修复必须过 e2e。
5. **质量门槛**：任何提交必须 gtest + e2e 全绿**且无未处置 flaky**——预存
   flaky（如 test_compress_gtest）只能三选一并留痕：隔离带期限 / 根因修复 /
   显式降级；性能改动附基准；asan/ubsan 清零。
6. **C99 约束有主**：受益者是旧 libc / 嵌入式工具链目标平台（FreeRTOS/ESP32
   等）；代价是上游补丁（quickjs-ng/libuv 的 stdatomic 补丁）与 rebase 负债。
   复核触发：上游全迁 C11，或目标平台清单变更。
7. **WinterTC 验证边界自曝**：兼容性 = ECMA-429 接口矩阵 + 自建 gtest harness
   （WPT runner 已移除，理由见 `brain/pages/wpt-runner-removed.md`）。这证明
   接口面齐全与项目内用例通过，不证明与浏览器行为逐字节一致；行为争议以
   规范文本裁决。重估条件：可自动化运行的官方合规套件出现。
8. **可回滚**：大方向变更走独立分支，验证后合入 master。
9. **SSOT 分工**：原则以本节为准；政策与裁决在 `brain/pages/`（timeline 追加 +
   reversal，范式见 `brain/pages/oss-library-policy.md`）；`brain/roadmap.md`
   只是指针，不复制里程碑内容。本节与 brain 决策页冲突时，以 brain 为先修订本节。

## 三、路线图（按领域，M = 里程碑）

### A. 运行时核心

| # | 工作项 | 说明 | 验证 |
|---|--------|------|------|
| A1 | **异步文件 I/O 回归** ✅ | `fsRead/fsReadBinary` 已改回异步（`uv_io_fs_read`），修复根因（`uv_fs_read` 直接写入 iov 目标缓冲，删除多余 memcpy / UAF）。`fsExists/fsList/fsRemove/fsWrite` 走 `uv_io_*` 异步原语，补测试即可。 | 多连接并发读文件不阻塞事件循环；e2e fs 往返；ctest offline 20/20 |
| A2 | **多上下文 / Worker 健壮性** ✅ | 软挂起边界 4 例（destroy 后 resume 同槽、坏 state 路径、skipped 语义、10 轮循环复用）、transferable 错误路径全覆盖（重复/不可转移/detached → DataCloneError 无副作用）、worker 错误事件流补齐（timer 回调异步抛错接入 reportError）。修 2 个实现缺口（timers 错误流、detached transfer 校验）。 | gtest + 压力：suspend 6/6、worker 23/23、offline ctest 20/20 |
| A3 | 引擎升级跟进 ✅ | QuickJS-ng v0.15.1→v0.16.2 已完成（commit 1009e662，97 commits，三补丁 rebase 零冲突，BC_VERSION 26→27，realloc_func 签名适配，polyfill.bytecode 同版 qjsc 重编）。后续跟进继续走上游合并策略（小补丁 diff 管理，见 `brain/pages/quickjs-upstream-merge-strategy.md`）。 | test262 通过率 v0.17.0 已跟进（commit 7363479f，BC_VERSION 28，四补丁零冲突）。 |
| A4 | DAP 调试器完善 ✅ | 裁决：暂停=世界冻结 by design（与 debugger.c re-entrancy guard 一致）；过时 TODO 删除。多上下文断点在单活动 context 协作模型下由全局断点表正确覆盖（伪需求不实现）。扩展交付 vscode/qzjs-debug（内联适配器 + 4 e2e，CI debugger job 覆盖）；setBreakpoints 按文件作用域修复；pc2line 行归属/行覆盖修复。 | test_dap_gtest 5/5（ctest -L dap）+ 扩展 e2e 4/4（npm test） |
| A5 | **多进程模型 M-P2（宿主↔主RT 进程分离）** ✅ | `QZ_PROCESS_MODEL` 编译开关（缺省 ISOLATED）：宿主 spawn `qzjs-rt --qzjs-rt-server`（socketpair + FlatBuffers 信封 + 三级终止），C API 签名/语义不变（透明切换）；worker 后端缺省随编译模型（ISOLATED→PROCESS），`worker_backend` 枚举随宏条件编译。THREAD 编译保持单进程基线，显式 PROCESS 求值报错（不静默降级）。M-P3（跨进程 MessagePort 路由）/M-P4（优雅关闭+压力）待续。 | THREAD 缺省 gtest 22/22；ISOLATED：eval 往返 / 真两进程 PID 证据 / 无残留 / kill -9 宿主→主RT 自杀 / 双后端 worker parity 全绿（`test/test_mp2_host_split_e2e.sh`）；`test_mp1_process_e2e.sh` PASS |

### B. WinterTC 标准合规

| # | 工作项 | 说明 | 验证 |
|---|--------|------|------|
| B1 | **恢复 gzip e2e** ✅ | `test_gzip_compression` 已恢复（应用层 handler 用 CompressionStream 压缩 + Content-Encoding；serve 不自动压缩）。 | e2e 10/10 |
| B2 | fetch 完善 ✅ |
| B3 | **streams 覆盖** ✅ | backpressure 串行✅、tee 单分支 cancel 关闭分支✅、pipeThrough 校验（结构+locked）✅、releaseLock 语义（释放锁 reject pending read / release 后 read 抛错）✅、pipeTo 收尾释放 writer 锁✅；BYOB 已补齐。 | gtest 51/51（含 5 个新边界用例） |
| B4 | **标准缺口盘点** ✅ | 对照 **ECMA-429**（ECMA TC55 WinterTC Minimum common web API，2025 snapshot）全接口逐项盘点：5.1 Common interfaces（~60）+ 5.2 methods/properties（~30）**全部实现**；9 处"已实现但无测试"的规范表面补 gtest（CustomEvent / PromiseRejectionEvent / onerror+onunhandledrejection+onrejectionhandled+reportError / TextEncoderStream / QueuingStrategies / TransformStream / BroadcastChannel 克隆隔离 / CacheStorage 扩展 / MessageChannel 消息往返）。盘点暴露并修复 1 个真实规范违例：TransformStream 存在 flush 时 close 后不 terminate，readable 永不关闭 → 第三次 read() 挂起。 | 覆盖矩阵（brain `wintertc-ecma429-coverage`）；polyfill gtest 60/60 |

### C. 原生扩展

| # | 工作项 | 说明 | 验证 |
|---|--------|------|------|
| C1 | **WASM 引擎** ✅ | 双引擎去留已定案（2026-09 用户裁决）：WAMR（默认，Fast Interp + AOT，懒加载）与 wasm3 均保留，互斥编译，不删任一。wasm3 特性对等（streaming API 补齐：`compileStreaming`/`instantiateStreaming`，与 WAMR 语义等价）；修复 `QZ_DEFAULT_EXTENSIONS` 从未注册 wasm3 的根因（wasm3 构建下 `WebAssembly` 全局缺失）；streaming 测试门控 WAMR OR WASM3。 | gtest 3/3（wasm3）+ 3/3（WAMR 回归）；端到端 `instantiateStreaming` add(20,22)=42 |
| C2 | **TLS/crypto** ✅ | SNI 多证书（精确 + `*.suffix` 通配）+ 证书热加载（引用计数：旧 ctx 等连接关闭后才释放，修复 https 压测 TLS 关闭路径 SIGSEGV/UAF）；crypto.subtle 补齐 ECDSA/ECDH（P-256/384/521 generateKey/import/export(jwk)/sign/verify/deriveBits）、HKDF（SHA-1..512）、AES-KW wrap/unwrap（RFC 3394）。 | gtest 全绿；e2e 19/19；TLS 压测 2600+ 连接 0 崩溃；crypto smoke ECDSA/ECDH/HKDF/AES-KW 全过 |
| C3 | **压缩** ✅ | miniz 压缩缓存（相同 body 只压一次，可移植 uvhttp 时代 LRU）；httpserver 示例 gzip 结果缓存进 LRU entry.gz。 | 基准 + 正确性；16KB gzip 吞吐与未压缩持平 |


### D. 服务端能力

| # | 工作项 | 说明 | 验证 |
|---|--------|------|------|
| D1 | **HTTP/1.1 细节** ✅ | keep-alive 管理、Connection 头尊重、pipelining 支持、Content-Length 严格消费、HTTP/1.0 兼容（默认 close）。 | e2e 12/12；ctest 13/13 |
| D2 | **请求体流式** ✅ | `req.body` 变 ReadableStream,header 一到即调 handler,body 字节经流式 enqueue 增量交付(不经字符串往返,二进制安全);`req.text()`/`req.arrayBuffer()` 便捷读取;字节缓冲 + 字节级 header 扫描,支持 header+body 同包。 | e2e 15/15(含 test_streaming_body:分块大 body + 二进制) |
| D3 | **连接生命周期** ✅ | 空闲超时（serve idleTimeout，默认30s，0禁用）、Connection: close 排空、优雅停止（onclose 清理 conns）。 | e2e 12/12；ctest 13/13 |
| D4 | **WS server 增强** ✅ | 分片 ✅、子协议协商 ✅、permessage-deflate ✅（RFC 7692：协商、RSV1 收发、上下文 takeover；C 层流式 deflate/inflate 原语 `pal.deflate*/inflate*`）。Ping/Pong 保活不做（应用层策略）。 | e2e 16/16；ASan 0 泄漏 |
| D5 | **大响应性能** ✅ | 大文件 `fsReadBinary` 零拷贝（uv_io 直写 JS ArrayBuffer backing，无中间拷贝）；修复非 keep-alive 大响应截断（uv_close 取消未决 uv_write）与对象响应后多发 500 的 return 缺失；SIGPIPE 忽略（wrk 中断连不再崩）。 | wrk 提升；e2e 19/19；TLS 压测不崩 |

| D6 | **Service Worker 栈（SW-0..3）** ✅ | fetch 客户端拦截 + 离线缓存 + 消息通信，SW 跑独立 Worker 线程。SW-0 注册/生命周期状态机；SW-1 fetch 拦截（`__qz_sw_intercept__` 钩子 + 30s 超时回退 + 防递归）；SW-2 Cache API 集成（`cache.addAll`/`caches.match`/`Response.clone` tee）；SW-3 更新机制（`update()` 同步读 SW 脚本字节对比，未变跳过安装；controller 切换点延至 activate_done，新 SW install/activate 期间旧 SW 保持拦截，无控制真空）。语义简化拍板：全局唯一注册、scope 接受但忽略、install 完成即 skipWaiting+激活。 | SW e2e 5 套件全绿（含 sw3-update）；决策详情 brain `service-worker-stack` |

### E. 工具链

| # | 工作项 | 说明 | 验证 |
|---|--------|------|------|
| E1 | **CLI** ✅ | `globalThis.arguments/env` 已做；脚本 args 完整语义；`main()` 忽略 SIGPIPE（服务压测不崩）。 | test_cli_gtest；手动 |
| E2 | **REPL** ✅ | 多行输入、历史、补全（此前 M 收尾已实现）；`-e` 单行脚本执行。 | 手动 + gtest |

### F. 质量与性能

| # | 工作项 | 说明 | 验证 |
|---|--------|------|------|
| F1 | CI 全绿 ✅（远端连续通过） | 消除 SKIP（gzip）✅。 | CI 状态 |
| F2 | **覆盖率** ✅ | fs 错误路径（读缺失/写缺失目录/readdir 缺失/unlink 缺失）、多块大文件读取、readdir >32 条目扩容、WS 客户端错误路径（拒绝连接/非 WS 端点握手）补测。 | gtest + e2e 19/19 ✅ |
| F3 | **启动/内存** ✅ | 大文件零拷贝评估落地：`fsReadBinary` ArrayBuffer 直写（uv_io_fs_read_ex + bridge_zc），fstat 定容 + EOF probe，超容/错误回退 malloc。 | 基准 + e2e 19/19 |
| F4 | 安全审计 ✅ | 路径穿越、消息边界、TLS 证书校验、原型链污染四领域审计；发现并修复 4 漏洞（structured-clone `__proto__` 污染 ×2 处路径、msgq malloc OOM、clone 字节流长度无界、http 头对象污染），新增 3 回归测试。 | polyfill gtest 68/68；e2e 17/17 ✅ |

### G. 生态与文档

| # | 工作项 | 说明 | 验证 |
|---|--------|------|------|
| G1 | API 参考 ✅ | serve / fs / compress / crypto / worker 文档（网站 + repo）。 | 文档可跑通 |
| G2 | examples 扩充 ✅ | httpserver 已做；worker 编排、流式管道已有；fetch-proxy 独立 example 已补（HTTP(S)_PROXY / NO_PROXY 三行为演示）。examples/CMakeLists.txt 全量收编 4 个 JS example，qjsc 编译校验进门。 | example 可跑 |
| G3 | **打包** ✅ | `qzjs.pc`（原 libqzjs.pc，完整 Libs）、静态库目标（libqzjs/libam_full）+ 全部 vendored 依赖归档安装完整、无系统依赖构建；WAMR fast-jit 关闭（vmlib 纯 C）。 | CMake 验证 ✅（pkg-config 消费方编译/链接/运行 OK） |

### H. gRPC/HTTP2

| # | 工作项 | 说明 | 验证 |
| H1 | **Phase0 — pal.tcpConnect TLS 客户端 + ALPN h2 协商** ✅ | `tcpConnect` 新增可选 `opts.tls`（`{ca?, servername?, alpn:['h2']}`），照搬 `uv_io.c` TLS 客户端模板；握手后 `mbedtls_ssl_get_alpn_protocol` 校验 "h2"，否则 `onerror`。 | e2e 30/30（含 6 TLS 用例） |
| H2 | **Phase1 — 纯 JS HTTP/2 客户端栈** ✅ | `hpack.js`（HPACK 编解码，61 项静态表 + 257 项 Huffman 表 + 动态表）+ `http2.js`（帧层 + 多路复用 + 连接/流双窗口流控 + CONTINUATION 重组 + trailers + PING/RST/GOAWAY）。 | hpack 14/14 + 帧 16/16 + e2e 22/22 |
| H3 | **Phase2 — gRPC unary 客户端 + proto3/flatbuffers 序列化 + QZ_WITH_GRPC 编译开关** ✅ | `protobuf.js`（动态 proto3 子集解析器 + wire 编解码）+ `flatbuffers.js`（FlatBuffers 编解码）+ `grpc.js`（unary 语义、5 字节消息前缀、trailers、grpc-status 映射、deadline、metadata）。`QZ_WITH_GRPC` CMake 开关（默认 OFF）：ON 时将 h2/HPACK/gRPC/protobuf/flatbuffers 打入 polyfill bundle；OFF 时完全消除（零字节进 bundle）。 | grpc e2e 24/24 + flatbuffers 70/70 + ctest 15/15 无回归；OFF 构建 268KB 全消除 / ON 411KB |
| H4 | **Phase3 — 服务端 gRPC（serve() ALPN 分发 + h2 server）** ✅ | `tcpListen` TLS 加 ALPN `h2`；明文连接嗅探 `PRI * HTTP/2.0` 前导自动切 h2c；服务端 h2 引擎 + gRPC 服务端语义。决策点：HPACK 不下沉 C（架构铁律：协议在 JS，C 只给原语）。 | http2-server.js（~486 行，帧层/流控/PING/RST/GOAWAY）+ grpc-server.js（~226 行，unary/路由/trailers/StatusError 映射）；serve() 分流 alpn=h2(TLS)→h2 / 24 字节前导→h2c；grpc harness 服务端节 + gtest 全绿（76b50cd9 + ce3e09fc） |
| H5 | **flatbuffers JS 层退役** ✅ | 用户决策：flatbuffers 定位为纯 C 层内部格式（当前无 C 消费者，不实现）。JS 层退役理由：JS 急切 decode 无性能优势，zero-copy 仅在 C 层成立；Worker 间为同进程共享内存通信，非 IPC 场景，无需跨进程序列化协议。gRPC 序列化 protobuf-only；删除 flatbuffers.js / grpc loadFlatbuffers / flatbuffers harness。 | grpc_harness protobuf + grpc-js 节全绿；ctest offline 无回归 |

## 四、里程碑节奏

| 里程碑 | 内容 | 节奏 |
|--------|------|------|
| M1 ✅ | **异步 I/O 回归 + gzip 恢复 + fs 全路径测试**（A1/B1/F1 完成，CI 已确认） | 1 周 |
| M2 ✅ | **HTTP/1.1 细节 + WS 增强 + 流式 body**（D1–D4 全部完成） | 2–4 周 |
| M3 ✅ | fetch 完善 + streams 覆盖 + WASM 流式（B2/B3/C1 全部完成） | 1–2 月 |
| M4 ✅ | **质量与性能（F 全项）+ 大响应优化（D5）**（F2/F3 + C2/C3 + D5 + E1/E2 全部完成） | 持续 |
| M5 ✅ | 生态与文档（G）+ 安全审计（F4）（G1/G2/G3/F4 全部完成） | 持续 |

## 五、验证矩阵

| 里程碑 | gtest | e2e | 额外门槛 |
|--------|-------|-----|----------|
| M1 ✅ | 20/20 | 19/19 | fs 多连接并发不阻塞（已验）；ASan 无 fs 崩溃 |
| M2 | 全绿 | HTTP/1.1+WS 全绿 | wrk 无回退 |
| M3 | 全绿 | 全绿 | test262 通过率不降 |
| M4 ✅ | 全绿 | 全绿 | asan/ubsan 清零；wrk 大响应显著提升；TLS 压测 2600+ 连接 0 崩溃 |
| M5 | 全绿 | 全绿 | 文档/示例可跑通 |

## 六、明确不做（边界）

- **不内置**应用层路由 / 静态服务 / 缓存策略（example 演示如何做）。
- **不做** Node.js 兼容层全量（`process` / `require` / `Buffer` 刻意缺席；按需补 WinterCG 而非 Node API）。
- **不复活** uvhttp C 服务器（已被纯 JS serve() 取代；除非性能上 JS 无法满足再评估）。
- **不引入**系统库依赖（全部 `add_subdirectory` 源码构建，严格 C99）。
- **不做** 设备原语（GPIO / BLE / serial 类硬件抽象——属宿主层职责，qzjs 聚焦 JS 运行时 + 连接性）

## 七、参考

- `README.md` — 项目定位 / API / WinterTC 模块表 / 构建选项
- `brain/pages/` — 各领域决策（worker-transferable、wintertc-byob-streams、wasm-engine-integration、service-worker-stack 等 36 页）
- `examples/httpserver/` — 应用层完整 HTTP 服务器示例
- `test/` — gtest 套件 + e2e + mock_libuv
