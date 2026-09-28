---
title: JS Execution
description: How qzjs executes JavaScript — initial_script, message-driven evaluation, Web Workers, and extension-injected globals. The host never evaluates JS directly.
---

# JS Execution

All JavaScript runs inside the runtime — in the separate main-RT process
under the default ISOLATED model, on qzjs's internal thread under THREAD.
The host never evaluates or calls into JS directly. Code is executed in one
of four ways:

1. **`initial_script`** — a script eval'd once when the runtime starts
2. **Message-driven** — JSON messages posted from the host run handlers in JS
3. **Web Workers** — `new Worker(url)` runs a separate script in parallel
4. **Extension globals** — C extensions (built into qzjs at compile time) expose
   native functions to JS

## 1. Initial Script

`qz_create` eval's `config.initial_script` in the runtime (its own
thread/process) before it returns. A throw makes `qz_create` return `NULL`:

```c
qz_config_t cfg = {
    .initial_script =
        "console.log('hello from qzjs');"
        "globalThis.onmessage = function (e) { postMessage('got: ' + e.data); };",
    .message_cb = on_message,
};
qz_t *rt = qz_create(&cfg);   // NULL if initial_script threw
```

This is where you install message handlers and top-level state before the host
starts driving the runtime.

## 2. Message-Driven Execution

The host drives JS by posting JSON messages; JS replies with `postMessage`:

```
host  ── qz_post_message(json) ──▶  JS: globalThis.onmessage(e)
host  ◀── message_cb(json)       ───  JS: postMessage(value)
```

- `qz_post_message` is **thread-safe** (the JSON is copied) and may be called
  from any host thread.
- The message arrives as a JS object/string via `onmessage`; `e.data` is the
  parsed payload.
- `message_cb` fires with the JSON serialized from `postMessage`: under
  ISOLATED on the thread pumping your `cfg.uv_loop`, under THREAD on the
  qzjs thread — so the callback must be thread-safe, and under ISOLATED it
  must never call a blocking host API (it can fire reentrantly inside one).

This is the only channel for host ↔ JS data. There is no synchronous return
value — results always flow back through `message_cb`.

## 3. Web Workers

`new Worker(url)` runs a script in a separate, isolated execution context —
real parallel work, not a shared-`JSRuntime` context. Workers communicate with
their creator and each other via `postMessage`/`onmessage`:

```js
// main script
const w = new Worker("worker.js");
w.onmessage = (e) => console.log("from worker:", e.data);
w.postMessage("start");
```

Under `-DQZ_PROCESS_MODEL=THREAD` a worker runs on a parallel thread; under
the default `ISOLATED` model it runs as a dedicated child process (`qzjs-rt`
spawned as a child process). See [Multi-Context](/guide/multi-context).

## 4. Extension Globals

Native C functions are exposed to JS by building an extension into qzjs (the
compile-time `QZ_EXTENSIONS` table), not by calling into JS from the host.
An extension's `init` hook runs when a context is created and may register
globals via the engine's C API:

```c
#include <qzjs/qzjs.h>
#include <quickjs.h>
#include "qz_internal.h"   // qz_get_active_jsctx (internal)

static JSValue js_greet(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv) {
    const char *name = argc > 0 ? JS_ToCString(ctx, argv[0]) : "world";
    JSValue v = JS_NewString(ctx, name);
    if (argc > 0) JS_FreeCString(ctx, name);
    return v;
}

static int my_ext_init(qz_ext_t *ext, qz_t *rt) {
    JSContext *ctx = qz_get_active_jsctx(rt);   // internal helper
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "greet",
                      JS_NewCFunction(ctx, js_greet, "greet", 1));
    JS_FreeValue(ctx, global);
    return 0;
}
```

Register the extension at compile time (see [Extensions](/guide/extensions)).

## Asynchronous Execution

Promises, `async`/`await`, and timers are driven by the embedded libuv loop
on the runtime's internal thread — in the main-RT process under ISOLATED,
in-process under THREAD. Microtasks are flushed naturally between loop
iterations —
A `setTimeout`/`fetch`/stream
continues to make progress until it settles; see [Event Loop](/guide/event-loop).
