---
title: fs（文件系统）
description: qzjs 中的文件系统 API —— readFile、readFileBinary、writeFile、目录操作以及 libuv 支持的文件 I/O。
---

# fs — 文件系统 API

qzjs 扩展 API，用于读写文件。作为 `qzjs.fs` 上的方法暴露。

## 全局对象

| 全局对象 | 描述 |
|--------|-------------|
| `qzjs.fs` | 文件系统操作命名空间 |

## 方法

### `qzjs.fs.read(path)`

以字符串形式读取文件内容。

```js
let content = await qzjs.fs.read('/app/config.json');
let config = JSON.parse(content);
```

返回：`Promise<string>`，包含文件内容。

错误——以**字符串** reject（不是 Error 对象）：`'file not found'`、`'not found'`、`'write error'`、`'unknown error'`。

### `qzjs.fs.readFileBinary(path)`

以原始字节读取文件——二进制安全。

```js
let bytes = await qzjs.fs.readFileBinary('/app/logo.png');
new Uint8Array(bytes); // 原始文件内容的 ArrayBuffer
```

返回：`Promise<ArrayBuffer>`。

### `qzjs.fs.readFileSync(path)`

抛出 `Error: 'Synchronous fs operations not supported in qzjs'`。请用 `read` / `readFileBinary`。

### `qzjs.fs.write(path, data)`

将数据写入文件。如果文件不存在则创建，如果存在则覆盖。

```js
await qzjs.fs.write('/data/log.txt', '日志条目: ' + new Date().toISOString());
await qzjs.fs.write('/app/state.json', JSON.stringify({ step: 5, done: false }));
```

返回：`Promise<void>`。

错误——以**字符串** reject（不是 Error 对象）：`'file not found'`、`'not found'`、`'write error'`、`'unknown error'`。

### `qzjs.fs.exists(path)`

检查文件或目录是否存在。

```js
if (await qzjs.fs.exists('/app/init.js')) {
    let script = await qzjs.fs.read('/app/init.js');
    // ...
}
```

返回：`Promise<boolean>`。

### `qzjs.fs.remove(path)`

删除一个文件。

```js
await qzjs.fs.remove('/tmp/temp.dat');
```

返回：`Promise<void>`。

错误——以**字符串** reject（不是 Error 对象）：`'file not found'`、`'not found'`、`'write error'`、`'unknown error'`。

### `qzjs.fs.list(path)`

列出目录内容。

```js
let entries = await qzjs.fs.list('/app');
// entries: [{ name: "main.js", type: "file" }, { name: "lib", type: "dir" }]

for (let entry of entries) {
    if (entry.type === 'file') {
        console.log('文件:', entry.name);
    }
}
```

返回：`Promise<Array<{name: string, type: "file"|"dir"}>>`。

错误——以**字符串** reject（不是 Error 对象）：`'file not found'`、`'not found'`、`'write error'`、`'unknown error'`。

## 完整示例

```js
// 读取配置，更新，写回
async function updateConfig(key, value) {
    let config = {};

    if (await qzjs.fs.exists('/app/config.json')) {
        let raw = await qzjs.fs.read('/app/config.json');
        config = JSON.parse(raw);
    }

    config[key] = value;

    await qzjs.fs.write('/app/config.json', JSON.stringify(config, null, 2));
}

await updateConfig('theme', 'dark');
```

## 路径约定

- 路径以 `/` 开头（绝对路径）
- 使用正斜杠（`/`）作为分隔符
- `.` 和 `..` 由运行时解析
- 没有驱动器字母（不兼容 Windows）

## 平台依赖

文件系统操作运行在运行时自有的 libuv 循环上（ISOLATED 为 `qzjs-rt` 进程，THREAD 为内部 `qzjs` 线程），由 libuv 异步文件 I/O 支持。失败时方法以纯**字符串**消息 reject（见各方法的错误节）——没有错误码对象，也没有 `DOMException` 类型。

## 注意事项

- **没有路径沙箱** —— 路径只校验 `..` 组件，绝对路径原样放行，因此脚本代码可以访问宿主进程能访问的任何路径。请把脚本视为完全可信；若不可信，请在宿主进程层面自行沙箱化（chroot/容器）。
- 不保证原子写入——崩溃时 `fs.write` 可能留下部分数据
- 不支持文件锁定或并发控制
- 不支持流式读写——整个文件内容被加载到内存中
- 二进制数据以字符串形式返回（使用 `TextEncoder`/`TextDecoder` 进行字节操作）