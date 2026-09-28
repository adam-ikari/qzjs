# C API Reference

qzjs exposes a small, focused C API surface. Every function operates on an opaque `qz_t*` runtime handle. JS is **single-threaded inside the runtime** — the host never calls into JS. Blocking host API calls (`qz_create`, `qz_destroy`, `qz_ping`, `qz_ping_path`, `qz_wait_idle`) must come from the host thread that created the runtime; `qz_post_message` and `qz_control` are thread-safe from any thread.

## API Groups

| Group | Description |
|-------|-------------|
| [Runtime Lifecycle](/c-api/runtime) | `qz_create`, `qz_destroy`, `qz_post_message` |
| [Multi-Context](/guide/multi-context) | Isolated JS contexts within one runtime |
| [Extensions](/c-api/extensions) | `qz_ext_t`, lifecycle hooks |
| [Host Data](/c-api/runtime#host-data) | `qz_get_runtime_data`, `qz_set_runtime_data` |

## Quick Example

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
    cfg.uv_loop = &loop;        /* host loop injection (required under ISOLATED) */
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "create failed\n"); return 1; }

    qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);

    /* Pump the host loop: message_cb fires on this thread. */
    while (uv_run(&loop, UV_RUN_ONCE)) { /* until done */ }

    qz_destroy(rt);
    uv_loop_close(&loop);
    return 0;
}
```

In a THREAD build the same program needs no `uv_loop`: `message_cb` fires on
the library's internal qzjs thread while the host does its own work. See
[Event Loop](/guide/event-loop) for the full pumping and reentrancy rules.

## Build Integration

```cmake
find_package(qzjs REQUIRED)
target_link_libraries(your_app PRIVATE qzjs::qzjs)
```

## Thread Model

JS execution is **single-threaded by design**: all JS runs on the runtime's
own loop, and the host thread never calls into JS. The host *side* of the
library depends on the build:

- **ISOLATED (default):** the library owns no host-side thread or loop. You
  inject your own `uv_loop_t` via `cfg.uv_loop` (required — `NULL` makes
  `qz_create` fail); the library binds its host-side channel handles to it
  and `message_cb` fires **on the thread that pumps your loop**. Blocking
  host APIs (`qz_ping`, `qz_ping_path`, `qz_wait_idle`, `qz_destroy`) pump
  that loop internally, so `message_cb` may fire reentrantly inside them —
  never call a blocking host API from `message_cb`. The library never runs
  `uv_run(UV_RUN_DEFAULT)` on your loop or closes it. Host and libqzjs must
  link the **same** libuv.
- **THREAD:** the library starts an internal `qzjs` thread running the
  embedded libuv loop; all JS and `message_cb` run on that thread and the
  host pumps nothing.

In both models `qz_post_message` is thread-safe (inbound, JSON copied),
`message_cb` must be thread-safe, and `qz_create`/`qz_destroy` are
host-thread calls. See [Event Loop](/guide/event-loop).
