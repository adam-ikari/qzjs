---
title: console
description: The console API in qzjs — console.log, console.error, console.warn, and structured logging.
---

# console API

The WHATWG Console standard for logging and debugging.

## Global

| Global | Type | Description |
|--------|------|-------------|
| `console` | object | Logging and debugging interface |

## Methods

### `console.log(...args)`

Log informational messages. Arguments are space-separated in output.

```js
console.log('Hello, world!');
console.log('Value:', 42, 'Status:', true);
console.log({ key: 'value' });  // objects serialized
```

### `console.info(...args)`

Alias for `console.log`.

```js
console.info('Server started on port 8080');
```

### `console.warn(...args)`

Log a warning message. Prefixed with `[WARN]` in output.

```js
console.warn('Deprecated API called');
console.warn('Memory usage:', process.memoryUsage());
```

### `console.error(...args)`

Log an error message. Prefixed with `[ERROR]` in output.

```js
console.error('Failed to connect to database');
console.error('Error details:', err.message, err.stack);
```

### `console.debug(...args)`

Log a debug message. Prefixed with `[DEBUG]` in output.

```js
console.debug('Request headers:', JSON.stringify(headers));
```

## Log Levels

Each method maps to a numeric log level included in the output prefix:

| Method | Level | Value |
|--------|-------|-------|
| `console.debug()` | DEBUG | 0 |
| `console.log()` / `.info()` | INFO | 1 |
| `console.warn()` | WARN | 2 |
| `console.error()` | ERROR | 3 |

## Implementation

`console.*` runs on the runtime's own loop (the `qzjs-rt` process under
ISOLATED, the internal `qzjs` thread under THREAD) and writes to standard
error, formatted as `[qzjs:<level>] <message>`. There is no host
callback for console — output goes straight to stderr.

## Formatting

Arguments are converted to strings via `String()`. Objects serialized with `JSON.stringify` may truncate circular references. Complex objects are best logged one property at a time.

## Notes

- **No** `console.table()`, `console.group()`, `console.time()`, `console.trace()`
- **No** `console.assert()` — use an `if` guard with `console.error`
- Stack traces from `console.error` are not automatically included — pass `err.stack` explicitly
- The log level prefix is fixed by the runtime, not configurable from JS
