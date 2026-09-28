---
title: fs (Filesystem)
description: The filesystem API in qzjs — readFile, readFileBinary, writeFile, directory operations, and libuv-backed file I/O.
---

# fs — Filesystem API

qzjs extension API for reading and writing files. Exposed as methods on `qzjs.fs`.

## Global

| Global | Description |
|--------|-------------|
| `qzjs.fs` | Filesystem operations namespace |

## Methods

### `qzjs.fs.readFile(path)`

Read the contents of a file as a string.

```js
let content = await qzjs.fs.readFile('/app/config.json');
let config = JSON.parse(content);
```

Returns: `Promise<string>` with the file contents.

Errors — rejects with a **string** (not an Error object): `'file not found'`, `'not found'`, `'write error'`, `'unknown error'`.

### `qzjs.fs.readFileBinary(path)`

Read a file as raw bytes — binary-safe.

```js
let bytes = await qzjs.fs.readFileBinary('/app/logo.png');
new Uint8Array(bytes); // ArrayBuffer of the raw file contents
```

Returns: `Promise<ArrayBuffer>`.

### `qzjs.fs.readFileSync(path)`

Throws `Error: 'Synchronous fs operations not supported in qzjs'`. Use `readFile` / `readFileBinary`.

### `qzjs.fs.writeFile(path, data)`

Write data to a file. Creates the file if it doesn't exist, overwrites if it does.

```js
await qzjs.fs.writeFile('/data/log.txt', 'Log entry: ' + new Date().toISOString());
await qzjs.fs.writeFile('/app/state.json', JSON.stringify({ step: 5, done: false }));
```

Returns: `Promise<void>`.

Errors — rejects with a **string** (not an Error object): `'file not found'`, `'not found'`, `'write error'`, `'unknown error'`.

### `qzjs.fs.exists(path)`

Check if a file or directory exists.

```js
if (await qzjs.fs.exists('/app/init.js')) {
    let script = await qzjs.fs.readFile('/app/init.js');
    // ...
}
```

Returns: `Promise<boolean>`.

### `qzjs.fs.unlink(path)`

Delete a file.

```js
await qzjs.fs.unlink('/tmp/temp.dat');
```

Returns: `Promise<void>`.

Errors — rejects with a **string** (not an Error object): `'file not found'`, `'not found'`, `'write error'`, `'unknown error'`.

### `qzjs.fs.readdir(path)`

List the contents of a directory.

```js
let entries = await qzjs.fs.readdir('/app');
// entries: ["main.js", "lib", ...]  — 字符串数组

for (let name of entries) {
    console.log('entry:', name);
}
```

Returns: `Promise<string[]>` — directory entry names.

Errors — rejects with a **string** (not an Error object): `'file not found'`, `'not found'`, `'write error'`, `'unknown error'`.

## Complete Example

```js
// Read config, update it, write it back
async function updateConfig(key, value) {
    let config = {};

    if (await qzjs.fs.exists('/app/config.json')) {
        let raw = await qzjs.fs.readFile('/app/config.json');
        config = JSON.parse(raw);
    }

    config[key] = value;

    await qzjs.fs.writeFile('/app/config.json', JSON.stringify(config, null, 2));
}

await updateConfig('theme', 'dark');
```

## Path Conventions

- Paths start with `/` (absolute)
- Forward slashes (`/`) as separators
- `.` and `..` are resolved by the runtime
- No drive letters (not Windows-compatible)

## Platform Dependency

Filesystem operations run inside the runtime, on its own libuv loop (the
`qzjs-rt` process under ISOLATED, the internal `qzjs` thread under THREAD),
backed by libuv's asynchronous file I/O. On failure the methods reject with a
plain **string**
message (see each method's Errors section) — there are no error codes or
`DOMException` types.

## Notes

- **No path sandbox** — paths are validated only against `..` components;
  absolute paths are passed through as-is, so script code can reach any path
  the host process can. Treat scripts as fully trusted, or sandbox the host
  process itself (chroot/container) if they are not.
- No atomic write guarantees — `fs.write` may leave partial data on crash
- No file locking or concurrency control
- No streaming read/write — entire file contents are loaded into memory
- `readFile` returns a string; for binary-safe reads use `qzjs.fs.readFileBinary(path)`, which resolves with a real `ArrayBuffer`
