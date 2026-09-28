---
title: 独立 CLI
description: 把 qzjs 当作独立的 WinterTC 运行时使用 — 无需嵌入或 Node.js，即可运行 JS 脚本、单行表达式或交互式 REPL。
---

# 独立 CLI

qzjs 附带一个独立运行时可执行文件（默认随 `QZ_BUILD_CLI=ON` 构建），直接运行
完整的 WinterTC Web API 面——按设计**不提供** Node.js API（`process`、`require`、
`Buffer`）。

## 构建

CLI 属于默认构建：

```bash
make build   # 产物：build/qzjs build/qzc build/qzjs-rt
```

## 用法

```bash
qzjs script.js [args...]   # 运行脚本文件
qzjs -e 'code' [args...]   # 求值一个表达式 / 语句
qzc app.js -o app.bc              # 把 JS 编译为字节码（qzc 工具）
qzjs --bytecode app.bc [args...]  # 运行预编译字节码
qzjs                       # 交互式 REPL（Ctrl-D 退出）
qzjs --help                # 用法
qzjs --version             # 版本字符串
```

### 脚本模式

```bash
./build/qzjs hello.js
# hello from qzjs
```

脚本参数通过 `globalThis.arguments` 暴露（WinterCG
[proposal-cli-api](https://github.com/wintercg/proposal-cli-api) 方向——可执行名
与脚本路径不计入）：

```bash
./build/qzjs -e 'console.log(JSON.stringify(globalThis.arguments))' a b c
# ["a","b","c"]
```

### `-e` 求值模式

```bash
./build/qzjs -e 'const r = await fetch("https://example.com"); console.log(r.status)'
```

### REPL

不带参数运行 `qzjs` 进入交互式会话：

```text
$ qzjs
qzjs 0.2.0 (WinterTC runtime) — type JS, Ctrl-D to exit
1 + 2
3
```

### 字节码模式

一次编译，多次运行——字节码在启动时跳过解析。编译由独立工具 `qzc` 完成：

```bash
qzc app.js -o app.bc
qzjs --bytecode app.bc arg1 arg2
# hello from bytecode, 1+2 = 3 | args: ["arg1","arg2"]
```

`qzjs --compile` 仍可用作别名，但 `qzc` 是规范形式。

脚本参数照常可用（经 CLI bootstrap 传入）。字节码与 qzjs 的具体构建绑定——
不兼容的文件会在 stderr 报 `SyntaxError: invalid version` 并以非零退出。
见[字节码编译](/zh/guide/bytecode)。

## 运行时行为

- **异步退出** — 顶层脚本结束后，运行时继续运行，直到所有待处理异步工作
  （定时器、fetch、流）完成才退出。50ms 的 `setTimeout` 保证在进程终止前触发。
- **console 路由** — `console.log`/`info`/`debug` → stdout；
  `console.warn`/`error` → stderr（与 Web 运行时 console 语义一致）。
- **`globalThis.env`** — 进程环境，以普通对象形式暴露。
- **退出码** — `0` 成功；`1` 脚本抛错（消息打到 stderr）或文件不可读；
  `2` 未知 flag / `-e` 用法错误。

## 控制面（`qzjs-ctl`）

使用 `--control-plane=local` 时，运行中的运行时暴露一个本地 AF_UNIX 端点
（0600，经 `SO_PEERCRED` 校验对端 uid），每行接受一条 JSON 控制命令，每命令
回写一份回执：

```bash
# 启动一个暴露端点的运行时
qzjs --control-plane=local --control-pipe=/tmp/my-qzjs.ctl app.js

# 另开一个 shell：发命令，打印回执
qzjs-ctl --pipe /tmp/my-qzjs.ctl eval '1 + 1'
qzjs-ctl --pipe /tmp/my-qzjs.ctl inspect '({a: 1})'
qzjs-ctl --pipe /tmp/my-qzjs.ctl metrics
qzjs-ctl --pipe /tmp/my-qzjs.ctl interrupt

# 定位进程树中的另一节点（worker 槽位 id），或发送原始 JSON
qzjs-ctl --pipe /tmp/my-qzjs.ctl --target 1001 metrics
qzjs-ctl --pipe /tmp/my-qzjs.ctl --json '{"op":"metrics","correl":"c1"}'
```

命令为 `eval` / `inspect` / `metrics` / `interrupt`。`--target N` 让命令沿进程树
路由（CTL-1）：`1` 是主运行时（默认），`>1` 是该节点的子槽位（即一个 worker
进程——隔离构建下 `new Worker(...)` 得到槽位 id 1001、1002……）。回执按
`correl` 配对；回执 `ok:true` 时退出码为 `0`，否则为 `1`。省略
`--control-pipe` 时的默认路径是 `/tmp/qzjs-<pid>-<n>.ctl`。`off`（默认）不暴露
任何端点；`in-proc` 仅允许同进程命令。

## 无 Node.js API

CLI 有意**不暴露**任何 Node 风格的全局——没有 `process`，没有 `require`，没有
`Buffer`，没有 CommonJS。脚本使用与嵌入版 qzjs 相同的 WinterTC Web API
（fetch、console、crypto.subtle、ReadableStream、timers、URL、TextEncoder……）。

## 下一步

- [事件循环](/zh/guide/event-loop) — 库自有 loop（ISOLATED：`qzjs-rt` 进程 + 库的宿主侧泵线程；THREAD：内部 qzjs 线程）如何驱动执行——宿主不泵动任何事件循环
- [嵌入](/zh/guide/embedding) — 面向宿主应用的 C API（邮箱消费）
