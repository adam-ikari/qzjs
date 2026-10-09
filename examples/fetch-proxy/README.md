# qzjs fetch-proxy Example

演示 qzjs `fetch()` 的**出站代理**能力：`HTTP_PROXY` / `HTTPS_PROXY` /
`NO_PROXY` 环境变量（含小写、`*` 通配、后缀匹配）。代理逻辑由 C 层透明
实现——http 走绝对式请求行（RFC 7230 §5.3.2），https 走 CONNECT 隧道后
TLS 端到端；JS 侧零感知，fetch 调用方式不变。

示例自带一个用 `serve()` + `fetch()` 写的极简转发代理（协议在 JS，
qzjs 只提供原语），本地即可跑通，无需外部代理软件。

## 运行

```bash
# 构建产物（仓库根已有则跳过）
cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j

# 终端 1：启动转发代理（干净环境启动，模拟网络中的代理）
./build/qzjs examples/fetch-proxy/main.js proxy 18082

# 终端 2：启动客户端 + 本地源站（带代理环境变量）
HTTP_PROXY=http://127.0.0.1:18082 NO_PROXY=127.0.0.1,example.com \
  ./build/qzjs examples/fetch-proxy/main.js client
```

客户端跑完自动退出；代理 `Ctrl-C` 停止。端口可换（ORIGIN_PORT 固定
18081，PROXY_PORT 由 `proxy` 角色第 2 个参数指定）。

## 期望输出

终端 2（客户端）：

```
[origin] GET /hello
[client] via-proxy : status=200  x-proxied-by=qzjs-fetch-proxy-example  body=origin-hello
[origin] GET /direct
[client] direct    : status=200  x-proxied-by=null  body=origin-hello
[client] internet  : status=200  len=<可变>  (NO_PROXY 直连)   # 网络可用时
[client] done
```

终端 1（代理）：

```
[proxy] GET http://localhost:18081/hello  ->  http://127.0.0.1:18081/hello
```

要点：

- `via-proxy` 响应带 `x-proxied-by` 头——代理转发时注入，证明请求
  经过了代理；代理日志里还能看到绝对式请求行的目标 URL。
- `direct` 的 `x-proxied-by=null`——`NO_PROXY=127.0.0.1` 命中后缀，
  fetch 绕过代理直连源站。
- `internet` 一条演示 `NO_PROXY=…,example.com` 域名后缀匹配（外网
  直连）。https 经代理需 CONNECT 隧道：本例的极简转发代理只实现
  plain-http 转发；对接真实代理（squid 等）时配 `HTTPS_PROXY` 即可，
  TLS 证书仍对源站校验。离线环境该行打印不可达，属正常。

## 依赖的能力（qzjs 内置）

| 能力 | 说明 |
|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | fetch 出站代理（C 层 `src/io/uv_io.c`，含小写与 `*` 通配） |
| `serve({port}, handler)` | HTTP 监听 + 回复（源站与代理都用它） |
| `fetch` / `Response` / `URL` | 客户端请求与绝对 URL 解析 |
| `globalThis.env` / `globalThis.arguments` | CLI 注入的环境快照与脚本参数 |
