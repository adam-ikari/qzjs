# C API Reference

qzjs exposes a small, focused C API surface. Every function operates on an opaque `qz_t*` runtime handle. JS is **single-threaded inside the runtime** — the host never calls into JS, and qzjs never runs host code: all host-bound messages arrive in a per-runtime **mailbox** the host drains on its own thread. Blocking host API calls (`qz_create`, `qz_destroy`, `qz_ping`, `qz_ping_path`, `qz_wait_idle`) must come from the host thread that created the runtime; `qz_post_message`, `qz_control`, and `qz_recv_message` are thread-safe from any thread.

## API Groups

| Group | Description |
|-------|-------------|
| [Runtime Lifecycle](/c-api/runtime) | `qz_create`, `qz_destroy`, `qz_post_message` |
| [Multi-Context](/guide/multi-context) | Isolated JS contexts within one runtime |
| [Extensions](/c-api/extensions) | `qz_ext_t`, lifecycle hooks |
| [Mailbox](/c-api/runtime#mailbox) | `qz_recv_message`, `qz_free_message`, `qz_message_fd` |

## Quick Example

```c
#include <qzjs/qzjs.h>
#include <stdio.h>

int main(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = "globalThis.onmessage = function (e) { postMessage(e.data); };";
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "create failed\n"); return 1; }

    qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);

    /* Drain the mailbox on this thread — no loop to pump, no callback. */
    for (;;) {
        char *json = NULL; size_t len = 0;
        int r = qz_recv_message(rt, &json, &len, 1000 /* ms */);
        if (r != 0) break;              /* 1 = timeout, -1 = error */
        printf("received: %.*s\n", (int)len, json);
        qz_free_message(json);
    }

    qz_wait_idle(rt);
    char *json; size_t len;
    while (qz_recv_message(rt, &json, &len, 0) == 0) {   /* final drain */
        printf("late: %.*s\n", (int)len, json);
        qz_free_message(json);
    }
    qz_free(rt);   /* also drains any remaining mailbox messages */
    return 0;
}
```

The same program works unchanged under a THREAD build: the library owns its
threads and loop in both process models, and the host just consumes the
mailbox. See [Runtime Lifecycle](/c-api/runtime#mailbox) for the wake-fd
consume protocol (`qz_message_fd`) when integrating into your own
poll/epoll/select event system.

## Build Integration

```cmake
find_package(qzjs REQUIRED)
target_link_libraries(your_app PRIVATE qzjs::qzjs)
```

## Thread Model

JS execution is **single-threaded by design**: all JS runs on the runtime's
own loop, and the host thread never calls into JS. The library owns its
threads and loop and never executes host code; the host picks its own thread
and timing for consuming messages. The *side* of the library depends on the
build:

- **ISOLATED (default):** the library spawns the main-RT process (`qzjs-rt`)
  plus its own internal host-side pump thread + loop. Outbound messages —
  JS `postMessage`, the crash report `{"type":"error"}`, CONTROL receipts —
  enter the mailbox; the host drains it via `qz_recv_message` (optionally
  waking on `qz_message_fd`) on whatever thread it likes. The blocking host
  APIs (`qz_ping`, `qz_ping_path`, `qz_wait_idle`, `qz_destroy`) do their
  waiting inside the library's pump thread. There is no loop injection, no
  pumping obligation, and no same-libuv requirement.
- **THREAD:** the library starts an internal `qzjs` thread running the
  embedded libuv loop; all JS runs there, and outbound messages enter the
  same mailbox API.

In both models `qz_post_message` is thread-safe (inbound, JSON copied),
`qz_recv_message` may be called concurrently from several threads (at most
one should wait on the wake fd), and `qz_create`/`qz_destroy` are
host-thread calls.
