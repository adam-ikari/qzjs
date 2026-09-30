---
title: 字节码编译
description: 宿主可把 JS 编译为字节码（qz_compile / qzc 工具）并在启动时运行 — 注意字节码不保证跨 qzjs 版本兼容。
---

# 字节码编译

qzjs 在构建时用 `qjsc` 编译器把自己的 JavaScript（WinterTC polyfill 与
worker 启动脚本）**预编译为字节码**。加载字节码完全
跳过解析，从而加快启动并缩小发布体积。

宿主可以用同一套机制处理自己的程序。

## 编译字节码

C API：

```c
#include <qzjs/qzjs.h>

const char *source = "1 + 1";   /* 你的 JS 源码 */
size_t source_len = 5;          /* 不含结尾 NUL */

char *err = NULL;
uint8_t *bc = NULL;
size_t bc_len = 0;
if (qz_compile(source, source_len, "app.js", &bc, &bc_len, &err) != 0) {
    /* err：malloc 的错误串，free() 释放 */
}
/* ... 分发 / 持久化 bc ... */
free(bc);
```

CLI：

```bash
qzc app.js -o app.bc
```

## 运行字节码

两种方式，都在 `initial_script` 之后求值（因此引导脚本与预编译主程序可以
叠加使用）：

- **C API** —— 在 `qz_create` 前设置 `qz_config_t.initial_bytecode` /
  `initial_bytecode_len`。
- **CLI** —— `qzjs --bytecode app.bc [args...]`（脚本参数照常可用，经 CLI
  的 bootstrap 传入）。

失败语义与 `initial_script` 一致：损坏或不兼容的字节码使 `qz_create`
返回 `NULL`（CLI：非零退出，引擎错误打到 stderr）。

## 字节码兼容性不保证

字节码与 qzjs 的**具体构建**强绑定——内嵌引擎版本、序列化格式（含版本字节
与校验和）以及编译选项。**一个构建产出的字节码不保证能在另一个构建上加载。**
运行时对不兼容的字节码显式拒绝（如
`SyntaxError: invalid version (27 expected=28)`，被篡改的字节码报
`checksum error`），绝不静默回退到源码。

推荐做法：分发**源码**，在部署环境的目标 qzjs 构建上编译（
`qzc`）。仅在与运行时二进制同构建来源的受控部署中直接分发
预编译字节码。同一内嵌引擎版本的 `qjsc -b` 产物也可加载，但版本必须与
qzjs 一致。

## 内部用途

构建流水线把 polyfill 源码编译成字节码并嵌入二进制（同一 `qjsc` 流程，
构建期完成）。运行时在内部线程上求值嵌入的字节码，而非解析源码。
