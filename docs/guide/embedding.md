---
title: Embedding Patterns
description: Patterns for embedding qzjs in C applications — mailbox consumption, custom extensions, message-based communication, and multi-instance setups.
---

# Embedding Patterns

Common patterns for embedding qzjs in C applications.

## Basic Embedding

Under every build the library **owns its threads and loop**, and it **never
runs host code**: there is no callback to install and no loop to inject. All
host-bound output — JS `postMessage`, the crash report `{"type":"error"}`, and
CONTROL receipts — lands in a per-runtime FIFO **mailbox** that the host
consumes on its own thread at its own time via `qz_recv_message`.

```c
#include <qzjs/qzjs.h>
#include <stdio.h>

int main(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = "postMessage({hello: 'world'});";
    qz_t *rt = qz_create(&cfg);          // no callback, no loop injection
    if (!rt) return 1;

    // Your application logic: drive the runtime by posting JSON messages
    qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);

    // Consume the mailbox on this thread, at your own pace
    for (;;) {
        char *json = NULL; size_t len = 0;
        int r = qz_recv_message(rt, &json, &len, 5000);  // wait up to 5 s
        if (r != 0) break;              // 1 = timeout, -1 = param/state error
        printf("received: %.*s\n", (int)len, json);
        qz_free_message(json);          // the buffer is yours to release
    }

    qz_destroy(rt);
    return 0;
}
```

`qz_create` blocks until the runtime is ready and `initial_script` has been
eval'd. Under ISOLATED the library spawns the main-RT process plus **its own**
host-side thread and loop (never yours); frames that arrived before the
ready handshake are already replayed into the mailbox, so your very first
`qz_recv_message` picks them up. Under THREAD, JS runs on the library's
internal thread. The host sends messages via `qz_post_message` (thread-safe
under both models) and receives everything from the mailbox: `qz_recv_message`
returns `0` with a malloc'd, NUL-terminated UTF-8 JSON buffer you must release
with `qz_free_message` (`len` excludes the terminator); `timeout_ms` is `0`
for a pure poll, `>0` to wait up to that many ms, `-1` to block forever.
`qz_destroy` performs a graceful shutdown.

To wait on messages instead of polling, integrate `qz_message_fd(rt)` — the
runtime's wake fd, an `eventfd` — into your own poll/epoll/select loop;
readable means at least one message is pending. Follow this consume protocol
so no wakeup is ever lost (a message is linked into the mailbox *before* the
eventfd is written):

1. `qz_recv_message(rt, &json, &len, 0)` — drain and **process** until it returns non-0.
2. `read(qz_message_fd(rt), ...)` — clear the eventfd counter until `EAGAIN`.
3. Re-probe `qz_recv_message(..., 0)` once more — a message means go back to step 1; only when it comes up empty may you block in `poll()`.

The fd belongs to the runtime: never close it yourself, and it becomes invalid
after `qz_free`. `qz_recv_message` may be called from any thread, but only
one consumer at a time per runtime — the lock-free pop is not mutually
exclusive, so concurrent pollers would hand out the same message twice.

## Calling C Functions from JS

Register C functions as JS globals:

```c
#include <quickjs.h>
#include "base/qz_rt.h"    // qz_get_active_jsctx (internal helper)

static JSValue greet(JSContext *ctx, JSValue this_val,
                     int argc, JSValue *argv) {
    QZ_UNUSED(this_val);
    const char *name = "World";
    if (argc > 0) name = JS_ToCString(ctx, argv[0]);
    printf("Hello, %s!\n", name);
    if (argc > 0) JS_FreeCString(ctx, name);
    return JS_UNDEFINED;
}

// Register in a custom extension's init hook:
static int my_ext_init(qz_ext_t *ext, qz_t *rt) {
    QZ_UNUSED(ext);
    JSContext *ctx = qz_get_active_jsctx(rt);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "greet",
        JS_NewCFunction(ctx, greet, "greet", 1));
    JS_FreeValue(ctx, global);
    return 0;
}
```

The `init` hook runs on qzjs's internal thread during `qz_create`, before
the host receives the runtime — so registering globals here is safe.
`qz_get_active_jsctx` is an internal helper (declared in
`src/base/qz_rt.h`), for use from extension hooks.

## Calling JS from C with Structured Data

Calling JS from C means posting a JSON message and letting the JS side reply
via `postMessage`; the reply arrives in the mailbox. Install a handler in
`initial_script`:

```c
// Bootstrap an onmessage handler that processes structured data
qz_config_t cfg = {0};
cfg.initial_script =
    "globalThis.onmessage = function (e) {"
    "  var d = e.data;"
    "  if (d.cmd === 'process')"
    "    postMessage({ doubled: d.value * 2, ok: true });"
    "};";
qz_t *rt = qz_create(&cfg);

// Post the input as a JSON message; the reply lands in the mailbox
qz_post_message(rt, "{\"cmd\":\"process\",\"value\":21}", 28);

char *json = NULL; size_t len = 0;
if (qz_recv_message(rt, &json, &len, 5000) == 0) {
    printf("JS returned: %.*s\n", (int)len, json);  // {"doubled":42,"ok":true}
    qz_free_message(json);
}
```

The JSON is copied by `qz_post_message` (thread-safe, callable from any
thread). There is no synchronous `qz_call` — results always arrive as mailbox
messages.

## Per-Request Context Isolation

Contexts are managed **inside** the runtime (`src/context.c`); the host does
not manipulate them through the public C API. The host sees one runtime and
communicates over JSON messages (`qz_post_message` / `qz_recv_message`). For
request-level isolation, either create a fresh `qz_t` per request (each is
fully independent — its own runtime process under ISOLATED, or thread, loop
and JS state under THREAD) or route requests into a
running runtime by message, tagging them so the JS side can keep per-request
state.

## Testing with mock_libuv

For deterministic offline tests, replace libuv with `mock_libuv`
(`test/mock_libuv.{c,h}`) — a fake `uv_*` API with no network or system calls.
Gtest suites link `qzjs + mock_libuv` (with `-DQZ_USE_MOCK_LIBUV`) and drive
the runtime through the `HostCtx` harness in `test/test_host.h`:

- `host_create(script)` / `host_destroy(h)` — start/stop a runtime with a
  bootstrap that installs `globalThis.onmessage` handling `{cmd:'eval', code}`
  and `{cmd:'echo'}`
- `host_eval(h, code, &out)` / `host_value(h, code, &out)` — evaluate JS via
  the command channel
- `host_poll_until_value(h, expr, sub, &out)` — poll until a condition holds
  (used for async results: promises, timers, storage)

See [Testing](/dev/testing) for details.

## Multiple Independent Runtimes

Since qzjs has zero global state, you can run multiple `qz_t` instances —
each owns its own runtime (JS state, its own thread/loop or main-RT process,
and **its own mailbox**):

```c
static void host_drain(qz_t *rt, const char *label, int timeout_ms) {
    for (;;) {
        char *json = NULL; size_t len = 0;
        int r = qz_recv_message(rt, &json, &len, timeout_ms);
        if (r != 0) break;
        printf("%s: %.*s\n", label, (int)len, json);
        qz_free_message(json);
        timeout_ms = 0;   // first message arrived — pure-poll the rest
    }
}

qz_config_t cfg1 = { .initial_script = "postMessage('rt1');" };
qz_config_t cfg2 = { .initial_script = "postMessage('rt2');" };

qz_t *rt1 = qz_create(&cfg1);
qz_t *rt2 = qz_create(&cfg2);

// Post to each independently; each runtime queues its own mailbox
qz_post_message(rt1, "{\"cmd\":\"echo\",\"data\":\"a\"}", 25);
qz_post_message(rt2, "{\"cmd\":\"echo\",\"data\":\"b\"}", 25);

host_drain(rt1, "rt1", 5000);
host_drain(rt2, "rt2", 5000);

qz_destroy(rt1);
qz_destroy(rt2);
```

Each runtime is fully self-driven — there is no host loop to drive under
either model. `qz_message_fd(rt)` returns a distinct wake fd per runtime, so
one host thread can watch several mailboxes with a single poll/epoll set
(apply the drain-then-clear-then-recheck protocol to each fd you wait on).

## Error Handling Patterns

There is no synchronous eval, so errors surface as messages rather than return
codes:

- If `initial_script` throws, `qz_create` returns `NULL`.
- At runtime, JS can report failures explicitly — e.g. an `onmessage` handler
  replies `postMessage({ ok: false, e: String(err) })`, which the host reads
  from the mailbox:

```c
char *json = NULL; size_t len = 0;
if (qz_recv_message(rt, &json, &len, 5000) == 0) {
    printf("%.*s\n", (int)len, json);  // e.g. {"ok":false,"e":"TypeError: ..."}
    qz_free_message(json);
}
```

An uncaught exception inside a message handler does not take down the
runtime; a runtime-level failure is reported to the mailbox as an ordinary
`{"type":"error"}` message.

## Memory Management

- `qz_recv_message` hands you a malloc'd buffer on every `0` return — release
  it with `qz_free_message` (NULL-safe) when you are done with the JSON
- `qz_free` is dual-role: given a runtime already wrapped up by
  `qz_wait_idle`, it drains the mailbox, closes the wake fd, and frees the
  config buffers and the rt; given a plain malloc'd blob (e.g. from
  `qz_compile`), it is a plain free. `qz_free(NULL)` is safe — there is no
  longer any `qz_eval`/`qz_call` result to free
- The runtime owns all its internal resources (its process or thread, the
  library's loop, contexts, and the mailbox) — `qz_destroy` frees everything
  on graceful shutdown, including any messages you never consumed: drain the
  mailbox first if you still need them
- There is no `host_data` / runtime-data slot in the public API — the library
  never runs host code, so keep per-runtime host-side state in your own table
  keyed by the `qz_t*` handle (`qz_ext_t.user_data` lives on the shared
  compile-time extension struct and is shared across runtimes)
