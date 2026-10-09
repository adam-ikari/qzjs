---
title: Overview
description: qzjs is an embeddable runtime in strict C99 — a WinterTC-compatible JS runtime. Designed for host developers who embed JavaScript in their own C applications.
---

# Overview

qzjs is an **embeddable runtime** written in **strict C99**. It provides a small C API and a **WinterTC-compatible runtime**, and communicates with the host over JSON messages.

For a C application that wants part of its logic in JavaScript, qzjs supplies the runtime: the library owns all of its threads and loops and never executes host code (under ISOLATED, JS runs in a separate main-RT process; under THREAD, on an internal qzjs thread). Everything bound for the host — JS `postMessage` output, crash reports, control receipts — lands in a per-runtime FIFO mailbox that the host drains on its own thread, at its own time, via `qz_recv_message`.

## How the Host Fits

![qzjs architecture](../assets/qzjs-arch.svg)

- **Message-based host boundary** — `qz_post_message` (in) / FIFO mailbox drained with `qz_recv_message` (out), JSON in both directions
- **Isolated runtime model** — JS runs in a separate main-RT process (`qzjs-rt`) under the default ISOLATED model, or on the instance's internal qzjs thread under THREAD; internal locks and atomics coordinate the process/thread, host, and worker boundaries, never JS execution
- **ECMAScript engine (ES2023)** — full ES2023 support, fast startup, low memory
- **WinterTC-compatible runtime** — `fetch`, `console`, `crypto.subtle`, `ReadableStream`, timers, `fs`, `URL`, `TextEncoder`, WebSocket, `serve()`, and more (see the [JS API](/js-api/) index)
- **Native extensions** — compression (miniz), crypto (mbedTLS), text codec, WebAssembly (WAMR, wasm3 optional)
- **Zero system dependencies** — all deps built from source via CMake; libuv is built from the deps submodule
- **Multi-context + Web Workers** — isolated contexts (soft suspend/resume to disk); `new Worker(url)` runs a real parallel thread, or — with `-DQZ_PROCESS_MODEL=ISOLATED`, the default — a dedicated child process

## The Host Integration Path

The Guide follows the order a host developer works in:

1. **[Quick Start](/guide/quickstart)** — build qzjs and run the minimal C embedding
2. **[Standalone CLI](/guide/cli)** — run JS directly with the `qzjs` executable
3. **[Host Integration](/guide/host-integration)** — the full loop: create → messaging → lending capabilities → destroy
4. **[Lifecycle](/guide/lifecycle)** — thread ownership, readiness, graceful shutdown
5. **[Multi-Context](/guide/multi-context)** — multiple isolated contexts in one runtime
6. **[Extensions](/guide/extensions)** — register your own C functions as JS globals
7. **[Bytecode](/guide/bytecode)** — precompile JS to bytecode (faster startup, no source shipped)

## When to Use qzjs

| Use Case | Why qzjs |
|----------|----------|
| **Embedded / edge scripting** | C99, tiny footprint, libuv event loop in the runtime |
| **Plugin systems** | Per-runtime isolation, multi-context handled inside the runtime |
| **Host applications needing scripting** | Script your C app's behavior in JS without shipping Node.js |
| **Edge compute** | WinterTC APIs feel familiar to JS developers |
| **Testing & simulation** | `mock_libuv` for deterministic tests, no network needed |

## When NOT to Use qzjs

- You need the **Node.js module system** — qzjs has no `require`/`import` of Node built-ins. Many pure-JS npm packages work (run `python3 test/compat_check.py <pkg>` (see [Compatible Packages](/guide/compatible-packages#checking-compatibility))); Node-only ones do not.
- You need **DOM** — qzjs provides the WinterTC/W3C subset (fetch, WebSocket, streams, localStorage, ...) but no `document`/`window`.
- You need **shared-memory concurrency** — the main runtime is single-threaded; Web Workers run real parallel threads or processes but communicate via structured-clone messages, not shared memory.
- You need **JIT performance** — qzjs's engine is an interpreter, not a JIT compiler.

## Project Structure

```
qzjs/
├── include/qzjs/       # Public headers (qzjs.h)
├── src/                 # Core runtime
│   ├── qzjs.c           #   Core API (create/destroy/post_message)
│   ├── thread.c         #   Internal thread + libuv loop
│   ├── uv_io.c          #   libuv I/O (network, fs, timers)
│   ├── msgq.c           #   Message queue (host ⇄ runtime)
│   ├── worker.c         #   Message dispatch (onmessage/postMessage)
│   ├── bridge.c         #   JS ↔ runtime bridge
│   └── context.c        #   Multi-context
├── src/polyfill/src/        # WinterTC module source

```
