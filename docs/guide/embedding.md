---
title: Embedding Patterns
description: Patterns for embedding qzjs in C applications — host data, custom extensions, message-based communication, and multi-instance setups.
---

# Embedding Patterns

Common patterns for embedding qzjs in C applications.

## Basic Embedding

Under the default ISOLATED model the library owns **no host-side thread or
loop**: you inject your `uv_loop_t` via `cfg.uv_loop`, JS runs in the
separate main-RT process, and `message_cb` fires on the thread that pumps
your loop. Under THREAD, qzjs owns its internal thread and libuv loop and
all JS runs there. Either way, the host communicates with the runtime over
JSON messages.

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
    cfg.initial_script = "postMessage({hello: 'world'});";
    cfg.message_cb = on_message;
    cfg.uv_loop = &loop;            // required under ISOLATED
    qz_t *rt = qz_create(&cfg);
    if (!rt) return 1;

    // Your application logic: drive the runtime by posting JSON messages
    qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);

    // Pump your loop — replies arrive in on_message on this thread
    while (uv_run(&loop, UV_RUN_ONCE)) { /* until done */ }

    qz_destroy(rt);
    uv_loop_close(&loop);
    return 0;
}
```

`qz_create` blocks until the runtime is ready and `initial_script` has been
eval'd (under ISOLATED the ready handshake is a synchronous raw-fd read —
the host loop is never pumped during the handshake; pre-ready script
messages replay FIFO to `message_cb` on the calling thread just before
`qz_create` returns). The host sends messages via
`qz_post_message` (thread-safe under both models) and receives replies
through `message_cb`, which under ISOLATED fires on the thread pumping
`cfg.uv_loop` — keep it fast and never call a blocking host API from inside
it (replies arrive while that loop is pumped). Under THREAD `message_cb`
fires on the qzjs thread. `qz_destroy` performs a graceful shutdown.

## Calling C Functions from JS

Register C functions as JS globals:

```c
#include <quickjs.h>
#include "qz_internal.h"   // qz_get_active_jsctx (internal helper)

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
`src/qz_internal.h`), for use from extension hooks.

## Calling JS from C with Structured Data

Calling JS from C means posting a JSON message and letting the JS side reply
via `postMessage`. Install a handler in `initial_script`:

```c
static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    printf("JS returned: %.*s\n", (int)len, json);
}

// Bootstrap an onmessage handler that processes structured data
qz_config_t cfg = {0};
cfg.initial_script =
    "globalThis.onmessage = function (e) {"
    "  var d = e.data;"
    "  if (d.cmd === 'process')"
    "    postMessage({ doubled: d.value * 2, ok: true });"
    "};";
cfg.message_cb = on_message;
cfg.uv_loop = &loop;            // your host loop (see Basic Embedding)
qz_t *rt = qz_create(&cfg);

// Post the input as a JSON message; the reply arrives via message_cb
// once your loop is pumped (ISOLATED)
qz_post_message(rt, "{\"cmd\":\"process\",\"value\":21}", 28);
// on_message prints: JS returned: {"doubled":42,"ok":true}
```

The JSON is copied by `qz_post_message` (thread-safe, callable from any
thread). There is no synchronous `qz_call` — results always flow back as
messages.

## Per-Request Context Isolation

Contexts are managed **inside** the runtime (`src/context.c`); the host does
not manipulate them through the public C API. The host sees one runtime and
communicates over JSON messages (`qz_post_message` / `message_cb`). For
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
each owns its own runtime (JS state, and its own thread/loop or main-RT
process):

```c
static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt;
    printf("%s: %.*s\n", (const char *)data, (int)len, json);
}

qz_config_t cfg1 = { .initial_script = "postMessage('rt1');",
                       .message_cb = on_message, .host_data = "rt1",
                       .uv_loop = &loop /* host loop, required under ISOLATED */ };
qz_config_t cfg2 = { .initial_script = "postMessage('rt2');",
                       .message_cb = on_message, .host_data = "rt2",
                       .uv_loop = &loop /* both runtimes may share one loop */ };

qz_t *rt1 = qz_create(&cfg1);
qz_t *rt2 = qz_create(&cfg2);

// Post to each independently; replies arrive on each runtime's message_cb
qz_post_message(rt1, "{\"cmd\":\"echo\",\"data\":\"a\"}", 26);
qz_post_message(rt2, "{\"cmd\":\"echo\",\"data\":\"b\"}", 26);

qz_destroy(rt1);
qz_destroy(rt2);
```

Under ISOLATED, both runtimes' channel handles can sit on the same host
loop — one pumping schedule drives both. Under THREAD there is no host loop
to drive — each runtime runs itself.

## Error Handling Patterns

There is no synchronous eval, so errors surface as messages rather than return
codes:

- If `initial_script` throws, `qz_create` returns `NULL`.
- At runtime, JS can report failures explicitly — e.g. an `onmessage` handler
  replies `postMessage({ ok: false, e: String(err) })`, which the host reads in
  `message_cb`:

```c
static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    printf("%.*s\n", (int)len, json);  // e.g. {"ok":false,"e":"TypeError: ..."}
}
```

An uncaught exception inside a message handler does not take down the
runtime.

## Memory Management

- `qz_free` still exists for malloc'd blocks returned by qzjs (`qz_free(NULL)` is safe) — there is no longer any `qz_eval`/`qz_call` result to free
- The runtime owns all its internal resources (its thread/loop or process,
  libuv loop, contexts) — `qz_destroy` frees everything on graceful shutdown;
  under ISOLATED it also closes every library handle bound to your
  `cfg.uv_loop`, so `uv_loop_close` on the host loop succeeds afterwards
- Per-runtime host data: set `config.host_data` before `qz_create`; an
  extension's `init` hook reads it via `qz_get_runtime_data(rt)` during
  create (the rt is valid inside init, before the host receives it). Note:
  `qz_ext_t.user_data` is on the shared compile-time extension struct — use
  `qz_get_runtime_data`/`qz_set_runtime_data` for per-instance data, not
  `user_data` (which is shared across runtimes).
