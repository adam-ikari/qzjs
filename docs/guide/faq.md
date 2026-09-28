---
title: FAQ
description: Frequently asked questions about qzjs — Node.js compatibility, process model, memory, API availability, and design intent.
---

# FAQ

Design questions that look like bugs but are not, plus the honest limits. Each
answer links to the page that documents the behavior in full.

## Positioning

### Is qzjs a Node.js replacement?

No. qzjs is an **embeddable runtime for trusted script**, not a Node.js
substitute. There is no `require`, no `import` of Node built-ins, no `process`,
no `Buffer`, and no CommonJS. Many pure-JS npm packages do work unchanged
because they only use the standard Web API surface; Node-only ones do not. Run
`python3 test/compat_check.py <pkg>` to test a specific package — see
[Compatible Packages](/guide/compatible-packages).

### Is qzjs a browser?

No. It implements the **WinterTC** subset of Web APIs (fetch, WebSocket,
streams, crypto, timers, ...), but has no DOM: no `document`, no `window`, no
rendering. It is a server-/edge-side runtime.

### Is qzjs a sandbox for untrusted code?

**No.** qzjs runs trusted script. Script can read and write any path the host
process can, spawn processes, and read the full environment — those are
legitimate capabilities, not escapes. See [Security](/guide/security) for the
explicit threat model.

### How big is it, and how fast does it start?

About **2.45 MiB stripped** in the minimal profile, with **sub-5 ms startup**
and peak RSS near 3 MB. It is built to fit embedded and edge targets where
Node.js or bun cannot. Numbers come from the project's own benchmarks — see
[Performance Benchmarks](/guide/benchmarking).

## Concurrency & the Process Model

### Is it multi-threaded? Can JS run in parallel?

The **main runtime is single-threaded**. All JS runs on qzjs's own internal
thread — under ISOLATED that is a thread inside the main-RT process, under
THREAD the library's internal qzjs thread — which also drives the embedded
libuv loop; the host thread never calls into JS and receives nothing by
callback: host-bound messages wait in the mailbox for `qz_recv_message`.
Concurrency comes from async I/O, not parallel JS in the main context.

Web Workers *do* run in parallel — as threads or child processes depending on
the backend — but communicate via structured-clone messages.

### What is the difference between `THREAD` and `ISOLATED`?

`QZ_PROCESS_MODEL` selects the default worker backend:

- **`ISOLATED`** (default) — each `new Worker(...)` runs in a dedicated child
  process (`qzjs-rt`) via fork+exec. Stronger isolation, IPC overhead. The
  host-side shape follows: JS lives in the main-RT process, the library owns
  its own host-side pump thread and loop, and all host-bound messages land in
  a FIFO mailbox drained with `qz_recv_message` — no loop to inject or pump.
- **`THREAD`** — workers are threads in one process. Lower overhead, shared
  address space. The library's internal qzjs thread runs everything; the host
  still just consumes the mailbox.

Neither is a security boundary against malicious script. See
[Multi-Context & Web Workers](/guide/multi-context).

### Why does a Worker need a companion binary?

Under `ISOLATED`, workers are separate processes, so they need an executable to
launch: `qzjs-rt`. It is built alongside the CLI (`QZ_BUILD_CLI=ON`). If it
cannot be found the spawn fails — see
[Troubleshooting](/guide/troubleshooting#workers-the-process-model).

### Can workers share memory?

No. Messages are structured-cloned, not shared. Use `postMessage` /
`MessageChannel`.

## APIs

### Which Web APIs are available?

21 modules are exposed as globals: `fetch`, `console`, `crypto.subtle`,
`streams`, `timers`, `URL`, `TextEncoder`/`TextDecoder`, `AbortController`,
`WebSocket`, `BroadcastChannel`, `EventSource`, `CacheStorage`, `Service
Worker`, `Worker`, `fs`, `storage`, `navigator`, `serve()`, `grpc`,
`compression`, `structuredClone`, and more. The full list with global names is
the [JS API Reference](/js-api/).

### Why is `serve()` not on `node:http`?

`serve()` is qzjs's own HTTP/WS/gRPC server, not a port of Express or `node:http`.
It is a single-server, callback-driven API. Only one server may run at a time.
See [serve()](/js-api/serve).

### Is there a public bytecode API?

**Yes.** `qz_compile()` compiles JS source to a bytecode blob, and hosts run
it at startup via `qz_config_t.initial_bytecode` (CLI: `qzc` /
`qzjs --bytecode`). The catch: bytecode is bound to the exact qzjs build and
is **not** portable across versions — the runtime rejects incompatible blobs
explicitly. Compile at deploy time for the target build. See
[Bytecode Compilation](/guide/bytecode).

### Can the host call JS directly, e.g. `qz_eval`?

No. There is **no `qz_eval`** on the public C API. The host and runtime
communicate only over JSON messages — `qz_post_message` inbound, and a
per-runtime FIFO **mailbox** outbound: JS `postMessage` output, crash reports,
and control receipts all land there, and the host drains them on its own
thread with `qz_recv_message` / `qz_free_message`. qzjs never executes host
code. This keeps the JS execution boundary explicit and the host free of
an eval channel. See [Host Integration](/guide/host-integration).

### Why do timers behave oddly under tests?

The GoogleTest harness links against **`mock_libuv`**, a deterministic
in-process fake of the libuv API. Under it, timers are quantized to a 1-second
tick so tests advance time deterministically. This is a test-only artifact, not
runtime behavior. See [Testing](/dev/testing).

## Build & Profiles

### What is the difference between `minimal` and `standard`?

`QZ_PROFILE=minimal` keeps WebAssembly, `crypto.subtle`, `atob`/`btoa`, and
compression — the smallest build that still satisfies the full WinterTC
required set. `standard` adds the remaining `QZ_WITH_*` features. Individual
`QZ_WITH_*` options override either profile. See
[Build Options](/guide/build-options).

### Can I enable both WASM engines?

No — WAMR and wasm3 both register the `WebAssembly` global, so they are mutually
exclusive. WAMR (Fast Interp + AOT) is the default.

### Does qzjs need system libraries?

No. Every dependency — libuv, mbedTLS, miniz, WAMR, cJSON, and the rest — is
built from source via CMake, from pinned submodules under `deps/`. Check out
submodules recursively or the configure step fails with a clear message.

### Why C99?

qzjs is embeddable in C99 host applications — device firmware and edge
services — and builds as C99 alongside its dependencies. That constraint keeps
the runtime buildable in toolchains that predate C11 atomics support.

## Errors & Debugging

### Why did `qz_create` return NULL?

The initial script threw, or thread/loop init failed; under ISOLATED,
failing to spawn the main-RT child (`qzjs-rt`) also returns `NULL` — the
library never relies on anything injected by the host. See
[Troubleshooting](/guide/troubleshooting#runtime-creation).

### How do I debug JS?

Build with debugging and qzjs attaches a **DAP** debug adapter over stdio
automatically — breakpoints, step-through, variable inspection, async-across-
pause. There is no CDP/Chrome DevTools support. See [Debugging](/dev/debugging).

### Something is wrong with the network stack

Check the proxy environment variables first: `fetch` honors `HTTP_PROXY` /
`HTTPS_PROXY` / `NO_PROXY` transparently at the C layer. An unsupported proxy
scheme (e.g. `socks5://`) makes the request **fail closed** rather than bypass
the proxy silently.

## See Also

- [Troubleshooting](/guide/troubleshooting) — symptom → cause → fix
- [Security](/guide/security) — threat model and what is out of scope
- [Use Cases](/guide/use-cases) — when qzjs fits and when it does not
