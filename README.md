<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="logo/logo-wordmark-dark.svg">
  <img src="logo/logo-wordmark.svg" alt="Qz.js" width="360">
</picture>

</div>

# Qz.js — Embeddable WinterTC Runtime

> 🌐 Website & API reference: **https://adam-ikari.github.io/qzjs/**

qzjs is a lightweight, **libuv-native**, **WinterTC-compatible** runtime for embedding JS and Wasm
JavaScript in C applications. It provides a WinterTC-compatible runtime of
standard Web APIs (fetch, console, crypto, streams, timers, fs, …) and a small,
thread-safe C API for host ↔ runtime messaging and multi-context execution.
JS runs on a library-owned event loop — in a separate main-RT process
(`qzjs-rt`) under the default ISOLATED build, where the host injects its own
`uv_loop_t` via `cfg.uv_loop` and receives `message_cb` on the thread that
pumps it; on an internal `qzjs` thread under the THREAD build. The host never
touches JS directly.

## Features

- **ES2023 engine** — full ES2023 support, fast startup (Release `qzjs -e 'console.log(1)'` median 4.82 ms after lazy WAMR init), low memory
- **WinterTC standard runtime** — WinterCG-compatible Web APIs (fetch, crypto.subtle, streams, timers, fs, serve) as globals, low overhead
- **WinterTC-compatible runtime** — 30 registered modules: fetch, console, crypto.subtle, ReadableStream, setTimeout, fs, URL, TextEncoder, WebSocket, serve() and more (verified as an ECMA-429 interface matrix + project gtest harness — the WPT runner was removed; this is interface parity, not byte-for-byte browser parity)
- **Streaming HTTP + TLS** — mbedTLS for HTTPS, chunked transfer decoding, certificate verification
- **Native extensions** — compression (miniz), crypto (mbedTLS), text codec (UTF-8/Base64), WebAssembly (WAMR default, wasm3 alternative)
- **Multi-context + Web Workers** — spawn isolated contexts (soft suspend/resume to disk); `new Worker(url)` runs real parallel threads, or dedicated processes when built with `-DQZ_PROCESS_MODEL=ISOLATED` (the default since the multi-process M-P2 milestone)
- **Host ↔ runtime messaging** — JSON messages via `qz_post_message` / `message_cb`; `postMessage` / `onmessage` on the JS side

## Quick Start

### Build

```bash
git clone --recursive https://github.com/adam-ikari/qzjs.git
cd qzjs
make build          # → build/qzjs build/qzc build/qzjs-rt
```

`make` is the command entry point (`make help`-style target list lives in the
`Makefile` header): `make build` / `make qzjs ARGS='...'` / `make qzc SRC=...`
/ `make bc SRC=...` / `make example NAME=fs` / `make test-offline` /
`make docs`. Under the hood these drive CMake/Ninja; raw CMake still works
(see [Building](docs/guide/building.md) for every option).
The WinterTC polyfill ships as precompiled bytecode with the JavaScript source
stripped (`qjsc -s`), shrinking the embedded polyfill bytecode by ~87%.
Polyfill initialization is lazy: core infrastructure (console, timers, event
targets, abort, URL, encoding, performance, navigator, structured clone, ...)
is set up at injection, while heavier or scenario-specific APIs (fetch,
streams, blob, worker, message-channel, caches, websocket, serve, fs,
storage, crypto.subtle, ...) initialize on first access. JS consumers observe
no difference — every name is visible (`in`/`Object.keys`) before first use
and resolves to the same descriptors as an eager install — so unused feature
APIs cost no setup time, closures, or resident instances.
The native WAMR runtime initializes lazily on first WebAssembly use as well —
end-to-end CLI startup (Release) dropped from 10.33 ms to **4.82 ms** median
for scripts that never touch `WebAssembly`.

### Minimal Example

```c
#include <qzjs/qzjs.h>
#include <uv.h>
#include <stdio.h>

static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    printf("received: %.*s\n", (int)len, json);
}

int main(void) {
    uv_loop_t loop;
    uv_loop_init(&loop);

    qz_config_t cfg = {0};
    cfg.initial_script = "globalThis.onmessage = function (e) { postMessage('pong'); };";
    cfg.message_cb = on_message;
    cfg.uv_loop = &loop;   /* host loop injection (required under ISOLATED) */
    qz_t *rt = qz_create(&cfg);
    if (!rt) return 1;

    /* thread-safe inbound message; the runtime processes it on its own loop */
    qz_post_message(rt, "{\"cmd\":\"ping\"}", 14);

    /* pump the host loop: message_cb fires on this thread */
    while (uv_run(&loop, UV_RUN_ONCE)) { /* until done */ }

    qz_destroy(rt);  /* graceful shutdown: terminate main RT → reap → free */
    uv_loop_close(&loop);
    return 0;
}
```

`qz_create` spawns/blocks until the runtime is ready and `initial_script`
has been evaluated (a thrown exception makes `qz_create` return NULL). Under
ISOLATED the ready handshake reads on a synchronous raw-fd path (no host-loop
pumping during the handshake); pre-ready script messages are buffered and
replayed FIFO to `message_cb` on the calling thread before `qz_create`
returns. `message_cb` fires for every `postMessage` from JS — on the
thread pumping your `cfg.uv_loop` under ISOLATED, on the internal qzjs
thread under THREAD — and must be thread-safe. In a THREAD build the same
program needs no `uv_loop`.

### Examples

Runnable samples live in [`examples/`](examples/), built with `QZ_BUILD_EXAMPLES=ON`:

```bash
make build                          # QZ_BUILD_EXAMPLES=ON included
./build/examples/hello/qz_hello     # host ↔ JS messaging
./build/examples/worker/qz_worker   # real-thread Web Worker round-trip
make example NAME=fs                # run a JS example directly
```

### Build with Tests

```bash
make test            # full suite (incl. test262)
make test-offline    # offline label — right default on a fresh clone
```

## Standalone CLI

qzjs ships a standalone runtime executable (built by default, `QZ_BUILD_CLI=ON`)
that runs WinterTC Web APIs directly — no Node.js APIs (`process`, `require`,
`Buffer` are absent by design).

```bash
make build                       # produces build/qzjs build/qzc build/qzjs-rt

./build/qzjs script.js a b c     # run a script, args via globalThis.arguments
./build/qzjs -e 'await fetch(url)' # evaluate a one-liner
./build/qzjs                     # interactive REPL (Ctrl-D to exit)
./build/qzjs --help
./build/qzjs --version
```

- **`globalThis.arguments`** — script args as an array (WinterCG
  `proposal-cli-api` direction; excludes the executable and script path)
- **`globalThis.env`** — process environment as a plain object
- **Async exit** — the runtime waits for pending async work (fetch, timers,
  streams) to complete before exiting, so top-level `await`-style scripts run to
  completion
- **Console routing** — `console.log`/`info`/`debug` → stdout,
  `console.warn`/`error` → stderr

```bash
./build/qzjs -e 'console.log(JSON.stringify(globalThis.arguments))' a b c
# => ["a","b","c"]
```

## Architecture

```mermaid
flowchart TB
    subgraph HOST["Host process"]
        App["C application"]
        HLoop["host uv_loop (cfg.uv_loop — ISOLATED)"]
        HLoop -- "uv_run pump → message_cb" --> App
    end
    subgraph AM["qz_t (one qzjs = one JSRuntime)"]
        Thread["runtime-owned loop — ISOLATED: qzjs-rt process · THREAD: internal thread (uv_thread_t)"]
        Ctx["JSContext + contexts"]
        Msg["message FIFO (inbound)"]
        IOBridge["bridge.c — JS ↔ libuv (uv_io.c)"]
        Thread --> Ctx
        IOBridge --> Thread
    end
    App -- "qz_post_message (thread-safe, JSON)" --> Msg
    Msg --> Thread
    Ctx -- "postMessage" --> IOBridge
    IOBridge -- "message_cb: JSON out (ISOLATED: via host loop read pump; THREAD: on qzjs thread)" --> HLoop
    Ctx -. "new Worker(url) → new qz_t (own loop: thread or process)" .-> AM
```

By default (`QZ_PROCESS_MODEL=ISOLATED`, multi-process M-P2) the host and the
main runtime are **separate processes**: `qz_create` spawns
`qzjs-rt --qzjs-rt-server`, then the two sides exchange FlatBuffers-framed
envelopes over a socketpair — a runtime crash (or a hard-killed runtime) cannot
take the host down. On the host side the library owns **no thread and no
loop**: you inject your own `uv_loop_t` via `cfg.uv_loop` (required — `NULL`
makes `qz_create` fail) and the library binds its host-side channel handles
(pipe read pump, wake async, tx-spill timer) to it, so `message_cb` fires on
the thread pumping your loop. Build with `-DQZ_PROCESS_MODEL=THREAD` for the
single-process baseline (one internal qzjs thread per runtime, `message_cb`
on that thread, host pumps nothing). In both models JS runs on the runtime's
own loop: the host drives work by posting JSON messages (`qz_post_message`,
thread-safe) and receiving replies through `message_cb`.

## API Reference

### Core API

| Function | Description |
|----------|-------------|
| `qz_create(config)` | Create runtime. ISOLATED: spawns the main-RT process, handshakes on a synchronous raw-fd read (no pumping/callbacks), attaches channel handles to `cfg.uv_loop` (NULL → fails). THREAD: starts the internal thread. Blocks until ready + `initial_script` eval'd. Returns NULL on failure. |
| `qz_destroy(rt)` | Graceful shutdown: terminate main RT (process/thread) → reap → free. Pumps `cfg.uv_loop` while waiting (ISOLATED) — never call from `message_cb`. Host thread only, NULL-safe. |
| `qz_post_message(rt, json, len)` | Thread-safe inbound JSON message (copied). Returns 0 / -1. |
| `qz_get_runtime_data(rt)` / `qz_set_runtime_data(rt, data)` | Per-runtime opaque pointer accessors. |
| `qz_free(ptr)` | Free malloc'd blocks. NULL-safe. |

### Configuration (`qz_config_t`)

| Field | Description |
|-------|-------------|
| `initial_script` | Eval'd inside the runtime at create (main-RT process under ISOLATED, qzjs thread under THREAD); a throw → `qz_create` returns NULL. |
| `message_cb` | Outbound message callback (NUL-terminated JSON, `len` excludes the terminator). Fires on the thread pumping `cfg.uv_loop` (ISOLATED) or the qzjs thread (THREAD); must be thread-safe and must never call blocking host APIs. |
| `uv_loop` | `const void *` (`uv_loop_t *`) — host's own loop, **required under ISOLATED** (NULL → `qz_create` fails), ignored under THREAD. Host and libqzjs must link the same libuv. |
| `debug` | DAP debugger bits (see Debugging). |
| `host_data` | Per-runtime opaque pointer, read via `qz_get_runtime_data`. |

### Multi-context

Multi-context (spawn/suspend/resume and `qzContext.*`) and Web Workers are
JS-level APIs — see the [docs](https://adam-ikari.github.io/qzjs/) for
`qzContext.spawn` / `suspend` / `resume` and `new Worker(url)`.

### Extensions

Extensions are registered at build time via the `QZ_EXTENSIONS` macro (see
`include/qzjs/qz_ext_registry.h`); there is no runtime registration API.
Built-in extensions (compress/crypto/textcodec/wamr) are auto-registered when
their `QZ_WITH_*` is on. A parent project adds its own extension to the table
non-invasively via the CMake `QZ_EXTENSIONS` / `QZ_EXTRA_SOURCES` variables.

## CMake Options

`QZ_WITH_*` toggles optional native extensions layered on the runtime. libuv
itself is a **hard dependency** (always built from `deps/libuv`) — there is no
platform-backend option anymore.

### Feature Toggles (`QZ_WITH_*`)

| Option | Default | Description |
|--------|---------|-------------|
| `QZ_WITH_WAMR` | ON | WAMR WebAssembly engine (Fast Interp + AOT) |
| `QZ_WITH_WASM3` | OFF | wasm3 WebAssembly engine (alternative; mutually exclusive with WAMR) |
| `QZ_WITH_TLS` | ON | mbedTLS HTTPS (forces `QZ_WITH_CRYPTO_EXT=ON`) |
| `QZ_WITH_COMPRESS` | ON | miniz compression extension |
| `QZ_WITH_CRYPTO_EXT` | ON | crypto.subtle extension (undefined when OFF) |
| `QZ_WITH_TEXTCODEC` | ON | UTF-8/Base64 extension |
| `QZ_WITH_NONUTF_ENCODINGS` | OFF | non-UTF encoding labels (Latin-1, replacement) in TextDecoder |

### Build Profiles (`QZ_PROFILE`)

`QZ_PROFILE` 是 `QZ_WITH_*` 各项的预设包，**只改未显式指定的项**：
`-DQZ_PROFILE=minimal -DQZ_WITH_TLS=ON` 中显式的 `TLS=ON` 赢。空值
（默认）时各项行为与历史默认逐位一致。取值 `minimal | standard`，其他值
configure 报错。所有命名档位均满足 ECMA-429 WinterTC 全量必选集。

| Profile | 宏效果 | qzjs 尺寸（strip 后，实测） | ECMA-429 WinterTC | 适用场景 |
|---------|--------|---------------------------|-------------------|----------|
| `standard`（与空 profile 等效） | 与历史默认相同：WAMR/TLS/COMPRESS/CRYPTO_EXT/TEXTCODEC=ON | 同默认构建 | ✅ 全量必选满足 | 通用运行时 |
| `minimal` | 同 standard 但 **TLS=OFF**（fetch 降级 http-only；ECMA-429 不含 HTTPS） | **2.45 MiB**（Release/-O3）；1.81 MiB（MinSizeRel/-Os） | ✅ 全量必选仍满足：atob/btoa、WebAssembly（WAMR）、crypto.subtle、CompressionStream 全部在 | 嵌入式/尺寸敏感，仍需过 WinterTC 一致性 |

实测命令与行为探测（2026-09-12，x86_64 Linux）：

```bash
cmake -S . -B build_profile_min -DQZ_PROFILE=minimal -DCMAKE_BUILD_TYPE=Release
cmake --build build_profile_min -j
strip build_profile_min/qzjs   # 2,573,536 B
./build_profile_min/qzjs -e 'console.log(typeof btoa, typeof WebAssembly, typeof crypto?.subtle, typeof CompressionStream)'
# minimal: function object object function
```


### gRPC Stack (`QZ_WITH_GRPC`)

`QZ_WITH_GRPC`（默认 OFF）现在是 CMake option：ON 时构建系统向
polyfill rebuild 传 `QZ_WITH_GRPC=1`，把 gRPC/HTTP2 栈（h2 + HPACK +
protobuf + grpc，~3.5k 行 JS）编进 `src/polyfill_default.c`。依赖 npm +
esbuild + qjsc（polyfill rebuild 本来就依赖，无新增前提）。手工路径仍是
`QZ_WITH_GRPC=1 node polyfill/build.js`。

> Note: before `QZ_WITH_GRPC` was a CMake option, the stack was gated only
> inside the polyfill **build** step (`QZ_WITH_GRPC=1 node
> polyfill/build.js`). The CMake option drives the same rebuild
> automatically; the manual path still works.

### Build Targets (`QZ_BUILD_*`)

| Option | Default | Description |
|--------|---------|-------------|
| `QZ_BUILD_TESTS` | OFF | Build test suite |
| `QZ_BUILD_DEBUGGER` | OFF | DAP step-debugger (adds `src/debugger.c` + `src/debugger_dap.c`) |

### Library Outputs

| Target | Description |
|--------|-------------|
| `libqzjs.a` | Static core. Deliberately does **not** link libuv — uv symbols resolve at the final executable. |
| `libqz_full.a` | CMake link-interface aggregator: qzjs + real libuv + mbedTLS + miniz + WAMR + pthread/dl/rt. |
| `qzjs.pc` | pkg-config. `pkg-config --cflags --libs qzjs` yields the full static link line (all vendored archives). |

## WinterTC Modules

| Module | Globals | Backend |
|--------|---------|---------|
| fetch | `fetch`, `Headers`, `Request`, `Response` | libuv (uv_io.c) |
| console | `console` | stdout |
| crypto | `crypto`, `crypto.subtle` | ext_crypto (mbedTLS) |
| streams | `ReadableStream`, `WritableStream` | — |
| timers | `setTimeout`, `setInterval` | libuv timers |
| fs | `fs.read`, `fs.write` | libuv (uv_io.c) |
| storage | `storage.get/set/delete` | libuv in-memory map |
| encoding | `TextEncoder`, `TextDecoder` | ext_textcodec |
| url | `URL`, `URLSearchParams` | — |
| abort | `AbortController`, `AbortSignal` | — |
| performance | `performance.now()` | libuv hrtime |
| event-target | `EventTarget`, `Event` | — |
| blob | `Blob`, `File`, `FormData` | — |
| message-channel | `MessageChannel`, `MessagePort` | — |
| navigator | `navigator` | — |
| structured-clone | `structuredClone` | — |
| error-events | `ErrorEvent` | — |

## Dependencies

All dependencies are built from source via CMake `add_subdirectory` — qzjs
never links system libraries, and each dep's objects live in the main build
tree (subject to `-j` and incremental rebuild). All are git submodules with
pinned versions. qzjs and all its dependencies build under **strict C99** (`-std=c99`).

| Dependency | Source | Required | Purpose |
|------------|--------|----------|---------|
| JS engine | git submodule | Yes | (C99) |
| libuv | git submodule | Yes | Event loop / I/O backend (C99; atomics patched) |
| mbedTLS | git submodule | No (QZ_WITH_TLS) | TLS / crypto (C99) |
| miniz | git submodule | No (QZ_WITH_COMPRESS) | Compression (C90) |
| WAMR | git submodule | No (QZ_WITH_WAMR) | WebAssembly engine (default) |
| wasm3 | git submodule | No (QZ_WITH_WASM3) | WebAssembly engine (alternative) |

### npm Polyfill 构建依赖

polyfill 构建期引入 npm 依赖（esbuild + 3 个库），均 devDependencies，不随二进制发布：

| 包名 | 版本 | 许可 | 目标 polyfill | 说明 |
|------|------|------|--------------|------|
| `urlpattern-polyfill` | 10.1.0 | MIT | `polyfill/src/url-pattern.js` | URLPattern 规范实现 |
| `@ungap/structured-clone` | 1.4.0 | ISC | `polyfill/src/structured-clone.js` | 深拷贝算法，保留 qzjs 扩展分支（MessagePort transfer、ArrayBuffer transfer、DataView offset/len、Blob/File、DOMException） |
| `web-streams-polyfill` | 4.3.0 | MIT | `polyfill/src/streams.js` | 三大流类规范实现（ReadableStream / WritableStream / TransformStream） |

> 注：whatwg-url 未引入（tr46 IDNA 485KB 依赖链过大 + esbuild IIFE 时序冲突），保留自研。

## Thread Safety

- **All JS runs on the runtime's own single loop** — the `qzjs-rt` process under ISOLATED (default), the internal `qzjs` thread under THREAD; the host never calls into JS directly.
- `qz_create` / `qz_destroy` are host-thread calls. The blocking host APIs (`qz_ping`, `qz_ping_path`, `qz_wait_idle`, `qz_destroy`) pump `cfg.uv_loop` internally under ISOLATED (`UV_RUN_NOWAIT` + yield), so `message_cb` may fire **reentrantly** inside them — never call one from `message_cb`. After `qz_wait_idle` free the runtime with `qz_free(rt)`, not `qz_destroy`.
- `qz_post_message` is **thread-safe** in both models (any thread may call it; the JSON is copied). Under ISOLATED delivery latency equals your pump frequency; FIFO order per runtime is preserved.
- `message_cb` fires on the thread pumping your injected `cfg.uv_loop` (ISOLATED) or on the internal qzjs thread (THREAD) — the host callback must be thread-safe. The JSON payload is NUL-terminated (`len` excludes the terminator) in both models.
- The library never calls `uv_run(UV_RUN_DEFAULT)` or `uv_loop_close` on your loop; after `qz_wait_idle`/`qz_destroy` all library handles are closed so `uv_loop_close` on the host loop succeeds. Host and libqzjs must link the **same** libuv.
- Worker contexts each run on their own loop — thread or process depending on the worker backend (real parallelism).

## Debugging

qzjs ships a DAP (Debug Adapter Protocol) step-debugger built into the
library — step-debug any embedded program in VS Code. Enable with
`-DQZ_BUILD_DEBUGGER=ON` (adds breakpoint/step
primitives; zero overhead when OFF). Run your program with `QZ_DEBUG=1`
(or set bit 1 of `qz_config_t.debug`) and VS Code attaches with
`request:"attach"`. See [docs/dev/debugging.md](docs/dev/debugging.md) for
the full setup, launch.json, and limitations.

## Testing

Tests are GoogleTest `.cpp` suites in `test/`, linked against `qzjs` plus
`mock_libuv` (a fake `uv_*` API for deterministic offline tests — see
`test/mock_libuv.h` and the `HostCtx` harness in `test/test_host.h`).

```bash
# Unit tests (offline label — the right default on a fresh clone)
make test-offline

# With valgrind
valgrind --leak-check=full ./build/test/test_qzjs_gtest
```

`ctest -L offline` is the right default: a fresh clone has no test262 corpus
(it is an upstream submodule with `update = none`), so a bare
`ctest --output-on-failure` fails on `test262_quickjs`. To run it too:

```bash
git -C deps/quickjs-ng submodule update --init --depth 1 test262
ctest -L test262
```

Tests are labelled for selection (`ctest -L <label>`; `ctest --print-labels`
lists what this build actually registered):

- `offline` — local, deterministic (default; what CI runs)
- `dap` — DAP debugger end-to-end (needs `-DQZ_BUILD_DEBUGGER=ON`)
- `test262` — ECMAScript conformance (needs the corpus, see above)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, style, the PR checklist,
and the release process.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md) — please use
private reporting rather than a public issue. That page also states the
threat model explicitly (qzjs runs trusted script; it is not a sandbox for
untrusted code).

## License

MIT
