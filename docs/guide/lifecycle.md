---
title: Runtime Lifecycle
description: qzjs runtime lifecycle — create, configure, use, and destroy. Understand qz_create, qz_destroy, and the message loop.
---

# Runtime Lifecycle

Every qzjs program follows the same lifecycle: **create → use → destroy**.

## Creating a Runtime

```c
uv_loop_t loop;
uv_loop_init(&loop);

qz_config_t config = {
    .initial_script = "postMessage('ready');",  // eval'd in the runtime at create
    .message_cb = on_message,                   // outbound messages
    .uv_loop = &loop,                           // host loop (required under ISOLATED)
    .debug = 0,                                 // Enable debug output (0 or 1)
};
qz_t *rt = qz_create(&config);
if (!rt) {
    // Creation failed — initial_script threw, cfg.uv_loop was NULL
    // (ISOLATED), or thread/loop init failed
}
```

`qz_create` does the following:
1. Under ISOLATED (the default): spawns the main-RT process (`qzjs-rt`) and,
   after the ready handshake, binds its host-side channel handles (pipe read
   pump, wake async, tx-spill timer) onto `cfg.uv_loop` — passing `NULL`
   fails `qz_create` explicitly (no internal host-thread fallback). Under
   THREAD: starts qzjs's internal thread and initializes the embedded libuv
   loop
2. Creates the `JSRuntime` and initial context
3. Registers the build-time extension set (the `QZ_EXTENSIONS` table —
   built-ins like compress/crypto/textcodec/wamr when their `QZ_WITH_*` is on,
   plus any user extensions added via `QZ_EXTRA_SOURCES`)
4. Injects the WinterTC-compatible runtime into the initial context
5. Eval's `initial_script` in the runtime — inside the main-RT process under
   ISOLATED, on the internal thread under THREAD; a throw makes `qz_create`
   return `NULL`

`qz_create` blocks until the runtime is ready and `initial_script` has been
eval'd. Under ISOLATED the ready handshake is a synchronous raw-fd read —
**no pumping and no callbacks fire during create**; script messages that
arrive before the read pump is registered are buffered and replayed FIFO.
The runtime owns all of its resources.
to keep alive.

## Destroying a Runtime

```c
qz_destroy(rt);  // graceful shutdown, host thread only, NULL-safe
                 // (pumps cfg.uv_loop internally under ISOLATED)
```

`qz_destroy`:
1. Under ISOLATED: pumps the host loop internally while it tears down the
   main-RT process, then closes every library handle bound to `cfg.uv_loop` —
   so `uv_loop_close` on your loop succeeds afterwards. Under THREAD:
   requests the internal thread to exit and joins it
2. Destroys all contexts (calls extension `destroy` hooks)
3. Frees the `JSRuntime` and the loop the runtime owned
4. Frees the runtime

`qz_destroy(NULL)` is safe (no-op).

## Thread Safety

- **JS never runs on the host thread** — under ISOLATED it runs in the
  separate main-RT process; under THREAD, on qzjs's internal thread. The
  host never calls into JS
- **`qz_post_message` is thread-safe** under both models — call it from any
  thread; the JSON is copied
- **`message_cb` fires on the thread pumping `cfg.uv_loop` under ISOLATED**
  (on the qzjs thread under THREAD) — your callback must be thread-safe, and
  under ISOLATED it may fire **reentrantly inside the blocking host APIs**
  (`qz_ping`, `qz_ping_path`, `qz_wait_idle`, `qz_destroy`), which pump the
  loop internally; **never call a blocking host API from inside
  `message_cb`**
- **`qz_destroy` is host-thread-only** — call it from the thread that called `qz_create`

## Memory Model

- All per-runtime state lives on `qz_t` — there is **zero mutable file-scope state**
- Class IDs are runtime-scoped (shared across contexts within one `qz_t`)
- Recover `qz_t*` from a `JSContext*` via `qz_get_rt_from_ctx(ctx)` (internal)
