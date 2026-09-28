---
title: Use Cases
description: Where qzjs fits — embedding JS + Wasm in C applications, edge nodes, devices, and extensible runtimes, with low overhead.
---

# Use Cases

qzjs is a **WinterTC-compatible runtime** for embedding JS (and WebAssembly)
inside C applications, with a thread-safe JSON message boundary and minimal
overhead. It shines wherever you want to push logic into JavaScript without
standing up a heavy process or a full browser engine.

## Embedded & Edge Nodes

The defining case: run JS on resource-constrained targets.

- **Edge gateways** — devices that need to interpret rules, filters, or
  protocol glue written in JS, reloadable without recompiling the C firmware.
- **Embedded devices** — qzrt's zero-dependency build (2.45 MiB stripped,
  ~5 ms startup) fits on targets where Node/Deno cannot.
- **Low-overhead scripting** — a single `initial_script` or a message-driven
  handler replaces a hand-written C state machine.

The host stays in C. Under the default ISOLATED model the library owns no
host-side thread: JS runs in a separate main-RT process and the host simply
injects and pumps its own `uv_loop`. Under THREAD, JS runs on qzjs's own
internal thread with its own libuv loop and the host pumps nothing.

## Extending a C Application with Scripting

Give your C app a scripting surface without a full interpreter integration.

- Ship logic as `initial_script` so it can be updated at runtime.
- Drive the runtime over JSON messages — your app's domain events become JS
  handler calls, and JS results flow back through `message_cb`.
- Expose your C functions to JS through a compiled-in extension
  ([Examples](/guide/examples), `extension/`).

## WinterTC Web APIs on Native

Code written against standard Web APIs runs as-is:

- `fetch`, `WebSocket`, `EventSource`, streams, timers, `crypto.subtle`,
  `BroadcastChannel`, `serve()` (HTTP/WS/gRPC) — all available as globals.

## Parallelism at the Edge

- `new Worker(url)` runs isolated contexts — as parallel threads or, under the
  default `-DQZ_PROCESS_MODEL=ISOLATED`, as dedicated child processes.
- Offload CPU-heavy or blocking work from the main runtime thread.
