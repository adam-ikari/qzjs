---
layout: home

hero:
  name: "Qz.js"
  text: "Embeddable WinterTC Runtime"
  tagline: Strict C99 · Low overhead · WinterTC standard runtime
  image:
    light: /logo.svg
    dark: /logo-dark.svg
    alt: Qz.js
  actions:
    - theme: brand
      text: Get Started
      link: /guide/quickstart
    - theme: alt
      text: JS API
      link: /js-api/

features:
  - icon: 🔌
    title: Mailbox-based host boundary
    details: The library never runs host code — there is no callback to install and no loop to inject. All host-bound output (JS `postMessage`, crash reports, control receipts) queues in a per-runtime FIFO mailbox the host drains on its own thread via `qz_recv_message` / `qz_free_message` (wake fd `qz_message_fd`). Inbound stays thread-safe over `qz_post_message`. No `eval`, no `tick`.
  - icon: 🪶
    title: Low overhead
    details: ~2.45 MiB stripped, <5 ms startup — fits embedded and edge targets where Node/bun can't.
  - icon: 📦
    title: Zero system dependencies
    details: The runtime and all its dependencies build from source via CMake. About 2.45 MiB stripped in the minimal profile.
  - icon: ⚡
    title: Strict C99
    details: Builds as C99 alongside its dependencies. Release `qzjs -e 'console.log(1)'` starts in under 5 ms; peak RSS stays near 3 MB.
  - icon: 🌐
    title: WinterTC-compatible runtime
    details: 30 registered modules — fetch, crypto.subtle, streams, WebSocket, BroadcastChannel, EventSource, timers, fs, serve() and more. Precompiled to bytecode, available as globals.
  - icon: 🔒
    title: No global state
    details: Per-runtime isolation through an opaque `qz_t`. Multiple independent instances run in one process.

---

## Quick Start

```bash
# Clone with all submodules
git clone --recursive https://github.com/adam-ikari/qzjs.git
cd qzjs

# Configure and build
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

```c
#include <qzjs/qzjs.h>
#include <stdio.h>

int main(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = "globalThis.onmessage = function (e) { postMessage(e.data); };";
    qz_t *rt = qz_create(&cfg);   // no callback, no loop injection
    if (!rt) return 1;
    qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);
    for (;;) {
        char *json = NULL; size_t len = 0;
        if (qz_recv_message(rt, &json, &len, 5000) != 0) break;  // drain the mailbox
        printf("received: %.*s\n", (int)len, json);
        qz_free_message(json);
    }
    qz_destroy(rt);
    return 0;
}
```

Full walkthrough: [Quick Start](/guide/quickstart).

## Architecture

```mermaid
flowchart TB
    subgraph AM["qzjs"]
        direction TB
        Core["qzjs.c (core API)"]
        Thread["runtime-owned libuv loop — ISOLATED: in the qzjs-rt process · THREAD: internal qzjs thread (thread.c)"]
        Msgq["msgq.c — message queue"]
        Worker["worker.c — dispatch (onmessage/postMessage)"]
        UvIO["uv_io.c — libuv I/O"]
        Core --> Thread
        Thread --> Msgq
        Msgq --> Worker
        Thread --> UvIO
        JS["WinterTC modules: fetch · console · crypto · streams · timers · …"]
        ExtList["Extensions: compress · crypto · textcodec · wamr"]
        Worker -.injects.-> JS
    end
    HOST["Host"] -->|"qz_post_message: JSON in"| Msgq
    Worker -->|"JSON out → mailbox (qz_recv_message / qz_free_message; wake fd qz_message_fd) — the library never runs host code"| HOST
    UvIO --> LIBUV["libuv"]
```
