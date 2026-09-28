---
title: Quick Start
description: Get qzjs running in under 5 minutes — clone, build, and run your first JavaScript program on the embedded runtime.
---

# Quick Start

Get qzjs running in under 5 minutes.

## Prerequisites

- **C compiler** — GCC 8+ or Clang 10+ (POSIX; Windows/MSVC is not yet supported)
- **CMake** 3.10+
- **Git** (for submodules)

## Clone & Build

```bash
# Clone with all submodules
git clone --recursive https://github.com/adam-ikari/qzjs.git
cd qzjs

# Configure and build (Release mode)
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

Size-sensitive builds: add `-DQZ_PROFILE=minimal` (keeps WinterTC
compatibility, 2.45 MiB stripped). See [Build Options](/guide/build-options).

The build produces `libqzjs.a` (static core) and `libqz_full.a` (link-interface aggregator for CMake consumers) in `build/`, plus `build/qzjs.pc` for pkg-config.

## Your First Program

Create `hello.c`:

```c
#include <qzjs/qzjs.h>
#include <stdio.h>

int main(void) {
    // qzjs owns all of its threads and loops — the host injects no event
    // loop and runs no callbacks. Everything JS sends out (postMessage,
    // crash reports) lands in a per-runtime FIFO mailbox that the host
    // drains on its own thread, at its own time, via qz_recv_message.

    // Create the runtime — blocks until JS is ready (evals initial_script)
    qz_config_t cfg = {0};
    cfg.initial_script = "console.log('Hello from qzjs!'); postMessage(1 + 1);";
    qz_t *rt = qz_create(&cfg);
    if (!rt) {
        fprintf(stderr, "Failed to create runtime\n");
        return 1;
    }

    // Drive the runtime by posting JSON messages
    qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);

    // Consume replies from the mailbox: wait up to 1 s for the first
    // message, then pure-poll until it drains.
    char *json;
    size_t len;
    int timeout_ms = 1000;
    while (qz_recv_message(rt, &json, &len, timeout_ms) == 0) {
        printf("received: %.*s\n", (int)len, json);
        qz_free_message(json);
        timeout_ms = 0;
    }

    // Let the runtime auto-exit once no async work is pending, then a
    // final pure-poll drain — messages that arrived during the wait
    // (including a crash {"type":"error"} report) are still in the mailbox.
    qz_wait_idle(rt);
    while (qz_recv_message(rt, &json, &len, 0) == 0) {
        printf("received: %.*s\n", (int)len, json);
        qz_free_message(json);
    }

    // Clean up — frees the mailbox, closes the wake fd, releases the rt
    qz_free(rt);
    return 0;
}
```

The host can embed qzjs in any event system: `qz_message_fd(rt)` returns the
runtime's wake fd (a Linux `eventfd`) — readable means at least one message is
pending, so you can `poll()`/`epoll`/`select` it beside your own fds. Drain the
mailbox before clearing that fd (see the consume protocol in
[Host Integration](/guide/host-integration)). Under a `THREAD` build
(`-DQZ_PROCESS_MODEL=THREAD`) the same program is unchanged: JS runs on
qzjs's internal thread and the host still just consumes the mailbox.

Compile and link with pkg-config (pulls the full static link line — all vendored archives):

```bash
cc -std=c99 -o hello hello.c $(pkg-config --cflags --libs qzjs)
```

For an in-tree build, point pkg-config at the build directory first:

```bash
export PKG_CONFIG_PATH="$PWD/build"
```

## Build with Tests

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Debug -DQZ_BUILD_TESTS=ON
cmake --build build -j$(nproc)
cd build && ctest --output-on-failure
```

Tests are labeled for targeted runs:

```bash
ctest -L offline   # local, deterministic tests (CI default)
ctest -L dap       # DAP protocol tests
ctest -L test262   # ECMA-262 conformance suite
```

## Next Steps

- [Building](/guide/building) — all CMake options explained
- [Runtime Lifecycle](/guide/lifecycle) — create, use, destroy
- [Embedding](/guide/embedding) — message-based host patterns
