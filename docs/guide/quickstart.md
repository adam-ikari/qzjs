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
#include <uv.h>
#include <stdio.h>

static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    printf("received: %.*s\n", (int)len, json);
}

int main(void) {
    // The host owns its event loop: under ISOLATED (the default) the
    // library starts no host-side thread — it binds its channel handles
    // onto the loop you inject below, and on_message fires on the thread
    // that pumps it. (Host and libqzjs must link the same libuv.)
    uv_loop_t loop;
    uv_loop_init(&loop);

    // Create the runtime — blocks until JS is ready (evals initial_script)
    qz_config_t cfg = {0};
    cfg.initial_script = "console.log('Hello from qzjs!'); postMessage(1 + 1);";
    cfg.message_cb = on_message;
    cfg.uv_loop = &loop;
    qz_t *rt = qz_create(&cfg);
    if (!rt) {
        fprintf(stderr, "Failed to create runtime\n");
        return 1;
    }

    // Drive the runtime by posting JSON messages
    qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);

    // Pump the host loop — replies arrive in on_message here
    while (uv_run(&loop, UV_RUN_ONCE)) { /* until done */ }

    // Clean up — graceful shutdown (library handles on the loop are closed)
    qz_destroy(rt);
    uv_loop_close(&loop);
    return 0;
}
```

In a `THREAD` build (`-DQZ_PROCESS_MODEL=THREAD`) the same program needs no
`uv_loop` at all: qzjs runs an internal thread and loop, and `message_cb`
fires there while the host pumps nothing.

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
