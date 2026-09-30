---
title: Troubleshooting
description: Diagnose common qzjs failures — build errors, creation failures, worker spawn problems, serve() and WebSocket errors, and CLI issues.
---

# Troubleshooting

Symptom → cause → fix, grouped by the stage where the failure appears.
Error strings are quoted verbatim so you can match them against your output.

## Build & Configure

### `QZ_WITH_WAMR=ON and QZ_WITH_WASM3=ON are mutually exclusive`

Both WASM engines register the same `WebAssembly` global, so only one may be on.

```bash
# pick exactly one (WAMR is the default, Fast Interp + AOT)
cmake -B build -DQZ_WITH_WAMR=ON -DQZ_WITH_WASM3=OFF
```

### `QZ_WITH_TLS=ON but mbedTLS source not found` / `QZ_WITH_CRYPTO_EXT=ON but mbedTLS source not found`

The dependency submodules are not checked out.

```bash
git submodule update --init --recursive
```

### `QZ_POLYFILL_MODE=compressed requires vendored lz4`

Same cause: the lz4 submodule is missing.

```bash
git submodule update --init deps/lz4
```

### `QZ_PROFILE` / `QZ_PROCESS_MODEL` / `QZ_POLYFILL_MODE` got an unexpected value

These are validated at configure time and reject anything outside their
accepted set. Accepted values are listed in [Build Options](/guide/build-options):

- `QZ_PROFILE` — `minimal`, `standard`, or empty
- `QZ_PROCESS_MODEL` — `ISOLATED` or `THREAD`
- `QZ_POLYFILL_MODE` — `rodata`, `compressed`, `external`, `host`

Changing `QZ_PROFILE` recalculates the `QZ_WITH_*` cache defaults and prints a
`QZ_PROFILE changed:` status line.

### A profile disables an API you need

Profiles flip the `QZ_WITH_*` feature switches. `minimal` keeps WebAssembly,
`crypto.subtle`, `atob`/`btoa`, and compression. `standard` adds the rest. Set
the individual `QZ_WITH_*` option explicitly if a profile's default is wrong
for you. See [Building](/guide/building#cmake-options).

## Runtime Creation

### `qz_create` returns `NULL`

`qz_create` blocks until the runtime is ready and `initial_script` has run;
it returns `NULL` when either fails. The causes:

1. **`initial_script` threw.** Any exception in the initial script aborts
   creation — the runtime does not start degraded.
2. **Thread or loop init failed** (resource exhaustion). All threads and
   loops are owned by the library — the host injects nothing.
3. **Under ISOLATED: the main-RT child process (`qzjs-rt`) failed to
   spawn.** `qz_create` spawns it first, then starts the library's own
   host-side thread and loop; if the binary cannot be located or the
   spawn fails, create returns `NULL`.

The CLI prints `qzjs: runtime init failed` for the same condition.

```c
qz_t *rt = qz_create(&cfg);
if (!rt) {
    /* initial_script threw, or thread/loop init failed */
    return 1;
}
```

Isolate the cause by emptying `initial_script` and re-running: if creation now
succeeds, the script threw.

### `initial_script_path` is ignored

When both `initial_script` and `initial_script_path` are set, the **path wins**.
Set only one. A path that cannot be read also makes `qz_create` return `NULL`.

### Runtime exits before an async callback fires

By design. After the top-level script finishes, the runtime keeps running until
all pending async work (timers, fetch, streams) completes, then exits. If you
need work to survive past the script, keep the runtime alive from the host —
do not expect the script's end to be a barrier. A pending 50 ms `setTimeout`
does fire before exit.

### `qz_recv_message` never returns a message

`qz_recv_message` is the **outbound** (JS → host) consumption channel —
nothing is ever pushed into a host callback. If it never yields a message,
check, in order:

1. **The script never calls `postMessage(...)`.** Outbound sends only happen
   when JS actually posts; a runtime that stays silent has nothing in the
   mailbox.
2. **You passed `timeout_ms = 0` everywhere.** `0` is a pure poll — it
   returns `1` immediately when the mailbox is empty at that instant. Wait
   with `timeout_ms > 0` (or `-1` to block), or integrate
   `qz_message_fd(rt)` (the wake fd, a Linux `eventfd`) into your own
   poll/epoll/select loop — readable means ≥1 message pending.
3. **Another consumer took it first.** Only **one consumer at a time** may
   call `qz_recv_message` on one rt — concurrent calls are not safe: both
   threads read the same head node, so one message is delivered twice and one
   node is freed twice. To consume from several threads, serialize in the
   host (your own queue, then fan out).

Crash reports are ordinary mailbox messages too: the `{"type":"error"}`
frame arrives via `qz_recv_message` — notably after `qz_wait_idle` returns,
when you do the final `recv(0)` drain. See
[Host Integration](/guide/host-integration) and
[Event Loop](/guide/event-loop).

## Workers & the Process Model

### `spawnWorker failed` / `spawn failed` / `binary not found`

Under the default `ISOLATED` process model, a `new Worker(...)` spawns a child
process running the companion binary `qzjs-rt`. If it cannot be located, the
spawn fails.

The resolver tries, in order:

1. an explicit binary path,
2. the `QZ_RT_SERVER` environment variable,
3. `qzjs-rt` in the directory of `/proc/self/exe`,
4. the compile-time `QZ_RT_PATH`.

Fix: build the companion binary (`QZ_BUILD_CLI=ON`, the default, builds
`qzjs`, `qzjs-rt`, and `qzjs-ctl` together) or point `QZ_RT_SERVER` at it.

```bash
export QZ_RT_SERVER=/path/to/build/qzjs-rt
```

### `worker boot failed` / `worker script error`

The worker's boot shim or its script threw during evaluation. The message is
the worker-side error; check the script passed to `new Worker(url)`.

### `Worker: only file:// URLs are supported in v1`

`new Worker()` accepts `file://` URLs only.

### Workers can't share memory

The main runtime is single-threaded, and workers — whether threads (THREAD
model) or child processes (ISOLATED model) — exchange **structured-clone
messages**, not shared memory. Use `postMessage` / `MessageChannel`.

### Choosing a worker backend

`qz_config_t.worker_backend` selects the backend, but the enum values are
**conditionally compiled**:

- `ISOLATED` build: `0` = `PROCESS` (default), `1` = `THREAD`
- `THREAD` build: `0` = `THREAD`, `1` = `PROCESS` (unsupported — errors at eval)

Use the symbolic constants (`QZ_WORKER_BACKEND_PROCESS` /
`QZ_WORKER_BACKEND_THREAD`), never the literals. A zero-initialized config
lands on the default backend for whichever model you compiled.

## serve() / HTTP / WebSocket

### `serve: a server is already running (call srv.close() first)`

Only one server may be active at a time. Close the previous one first.

```js
let srv = serve({ port: 8080 }, handler);
srv.close();
srv = serve({ port: 8081 }, handler);
```

### `WebSocket accept unavailable: rebuild with QZ_WITH_CRYPTO_EXT=ON and QZ_WITH_TEXTCODEC=ON`

The WebSocket upgrade path needs the crypto and textcodec extensions. Your
build has one or both off.

```bash
cmake -B build -DQZ_WITH_CRYPTO_EXT=ON -DQZ_WITH_TEXTCODEC=ON
```

Note that `QZ_WITH_TLS=ON` forces `QZ_WITH_CRYPTO_EXT=ON` automatically.

### `wss://` is not supported

The WebSocket client supports `ws://`; `wss://` throws `wss:// not supported yet`.
Terminate TLS in a front proxy.

### Port already in use

`serve({ port: N })` fails to bind if the port is taken. Use `port: 0` to let
the OS assign one.

### Binding beyond loopback

`serve()` binds `127.0.0.1` by default and has **no authentication
middleware**. Passing `hostname: '0.0.0.0'` exposes the server to the network —
put your own authentication in front. See [Security](/guide/security).

## CLI

### `qzjs` prints usage and exits with code `2`

Unknown flag or a malformed `-e` invocation. Exit codes:

| Code | Meaning |
|------|---------|
| `0` | success |
| `1` | script threw (message on stderr), or the file was unreadable |
| `2` | unknown flag / bad `-e` usage |

### `qzjs: cannot open '<file>'` / `qzjs: cannot size '<file>'` / `qzjs: read error`

The script path is missing, unreadable, or changed while being read. Confirm
the path and permissions.

### No `process`, `require`, or `Buffer` in scripts

By design — the CLI exposes no Node-style globals. Scripts use the WinterTC Web
API surface instead. See [Standalone CLI](/guide/cli#no-nodejs-api).

### `qzjs-ctl` commands fail

Five things to check:

1. The runtime was started with `--control-plane=local`.
2. `--pipe` matches the runtime's `--control-pipe` (default
   `/tmp/qzjs-<pid>-<n>.ctl`).
3. The peer UID matches — the endpoint is `0600` and verified via `SO_PEERCRED`.
4. `--target N` names a real slot (`1` = main runtime; `>1` = that node's
   child worker slot).
5. With `control_plane = OFF` (the default), `qz_control` always returns `-1`.

## Bytecode

### "How do I feed qzjs precompiled bytecode?"

`qz_compile()` compiles JS source to a bytecode blob; run it via
`qz_config_t.initial_bytecode` or `qzjs --bytecode file.bc`
(`qzc` produces the file). Bytecode is bound to the exact qzjs
build — an incompatible blob fails `qz_create` with an explicit
`SyntaxError: invalid version` on stderr rather than falling back to source.
Compile at deploy time on the target build. See
[Bytecode Compilation](/guide/bytecode).

## Still Stuck

- [FAQ](/guide/faq) — design questions that look like bugs but are not
- [Security](/guide/security) — what is and is not defended
- [Debugging](/dev/debugging) — the built-in DAP debugger
- [GitHub Issues](https://github.com/adam-ikari/qzjs/issues) — file a report
