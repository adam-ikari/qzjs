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
    title: Message-based host boundary
    details: Host and runtime exchange JSON over `qz_post_message` / `message_cb`. Inbound is thread-safe; outbound fires on the thread pumping your injected `uv_loop` (ISOLATED, default) or on the runtime thread (THREAD build). No `eval`, no `tick`.
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
    cfg.initial_script = "globalThis.onmessage = function (e) { postMessage(e.data); };";
    cfg.message_cb = on_message;
    cfg.uv_loop = &loop;        /* host loop (required under ISOLATED) */
    qz_t *rt = qz_create(&cfg);
    if (!rt) return 1;
    qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);
    while (uv_run(&loop, UV_RUN_ONCE)) { /* pump: message_cb fires here */ }
    qz_destroy(rt);
    uv_loop_close(&loop);
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
    Worker -->|"message_cb: JSON out — on the thread pumping your cfg.uv_loop (ISOLATED) · on the qzjs thread (THREAD)"| HOST
    UvIO --> LIBUV["libuv"]
```
