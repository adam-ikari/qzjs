---
title: console
description: qzjs 中的 console API —— console.log、console.error、console.warn 以及结构化日志。
---

# console API

WHATWG Console 标准，用于日志记录和调试。

## 全局对象

| 全局对象 | 类型 | 描述 |
|--------|------|-------------|
| `console` | object | 日志记录和调试接口 |

## 方法

### `console.log(...args)`

记录信息性消息。参数在输出中以空格分隔。

```js
console.log('你好，世界！');
console.log('值:', 42, '状态:', true);
console.log({ key: 'value' });  // 对象会被序列化
```

### `console.info(...args)`

`console.log` 的别名。

```js
console.info('服务器已在端口 8080 上启动');
```

### `console.warn(...args)`

记录警告消息。在输出中带有 `[WARN]` 前缀。

```js
console.warn('调用了已弃用的 API');
console.warn('内存使用:', process.memoryUsage());
```

### `console.error(...args)`

记录错误消息。在输出中带有 `[ERROR]` 前缀。

```js
console.error('连接数据库失败');
console.error('错误详情:', err.message, err.stack);
```

### `console.debug(...args)`

记录调试消息。在输出中带有 `[DEBUG]` 前缀。

```js
console.debug('请求头:', JSON.stringify(headers));
```

## 日志级别

每个方法映射到一个包含在输出前缀中的数字日志级别：

| 方法 | 级别 | 值 |
|--------|-------|-------|
| `console.debug()` | DEBUG | 0 |
| `console.log()` / `.info()` | INFO | 1 |
| `console.warn()` | WARN | 2 |
| `console.error()` | ERROR | 3 |

## 实现

`console.*` 运行在运行时自有的 loop 上（ISOLATED 为 `qzjs-rt` 进程，THREAD 为内部 `qzjs` 线程），并写入标准错误，格式为 `[qzjs:<level>] <message>`。console 没有宿主回调 — 输出直接进入 stderr。

## 格式化

参数通过 `String()` 转换为字符串。使用 `JSON.stringify` 序列化的对象可能会截断循环引用。复杂对象最好逐个属性记录。

## 注意事项

- **不支持** `console.table()`、`console.group()`、`console.time()`、`console.trace()`
- **不支持** `console.assert()` —— 请使用 `if` 守卫配合 `console.error`
- `console.error` 的堆栈跟踪不会自动包含——请显式传递 `err.stack`
- 日志级别前缀由运行时固定，无法从 JS 配置