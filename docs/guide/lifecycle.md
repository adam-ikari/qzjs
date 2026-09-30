---
title: Runtime Lifecycle
description: qzjs runtime lifecycle — create, configure, use, and destroy. Understand qz_create, the mailbox, qz_wait_idle, qz_destroy, and qz_free.
---

# Runtime Lifecycle

Every qzjs program follows the same lifecycle: **create → use → destroy**.

## Creating a Runtime

```c
qz_config_t config = {
    .initial_script = "postMessage('ready');",  // eval'd in the runtime at create
    .debug = 0,                                 // Enable debug output (0 or 1)
};
qz_t *rt = qz_create(&config);
if (!rt) {
    // Creation failed — initial_script threw, or process/thread init failed
}
```

`qz_create` does the following:
1. Under ISOLATED (the default): spawns the main-RT process (`qzjs-rt`), then
   the **library starts its own host-side thread and loop** (never the
   host's) and blocks until mainRT's `CONTROL{ready}`. Under THREAD:
   everything runs on the library's internal qzjs thread. Failure returns
   `NULL`
2. Creates the `JSRuntime` and initial context
3. Registers the build-time extension set (the `QZ_EXTENSIONS` table —
   built-ins like compress/crypto/textcodec/wamr when their `QZ_WITH_*` is on,
   plus any user extensions added via `QZ_EXTRA_SOURCES`)
4. Injects the WinterTC-compatible runtime into the initial context
5. Eval's `initial_script` in the runtime — inside the main-RT process under
   ISOLATED, on the internal thread under THREAD; a throw makes `qz_create`
   return `NULL`

`qz_create` blocks until the runtime is ready and `initial_script` has been
eval'd. Frames that arrived before the ready handshake are already replayed
into the per-runtime **mailbox**, so the host's very first `qz_recv_message`
gets them. The host can embed qzjs in any event system (poll/epoll/select, its
own threads): the library owns its threads and loop and never runs host code —
there is no loop for the host to run or drive, and no callback into host code.

## Exchanging Messages: post and recv

Requests go in through `qz_post_message`; everything coming out — JS
`postMessage`, the crash report `{"type":"error"}`, and CONTROL receipts —
queues in the mailbox, drained on whatever host thread you choose:

```c
qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);

char *json = NULL; size_t len = 0;
int r = qz_recv_message(rt, &json, &len, 5000);  // 0=poll, >0=ms, -1=block forever
if (r == 0) {
    printf("%.*s\n", (int)len, json);            // NUL-terminated UTF-8 JSON
    qz_free_message(json);                       // you must release the buffer
}                                                // r==1: timeout, r==-1: param/state error
```

To block on messages instead of polling, integrate `qz_message_fd(rt)` (an
`eventfd` wake fd) into your own poll/epoll/select using the
drain-then-clear-then-recheck protocol: poll the mailbox empty with
`qz_recv_message(..., 0)`, read the fd until `EAGAIN`, re-probe the mailbox
once — only then may you block. The fd belongs to the runtime: never close it;
it is invalid after `qz_free`.

## Waiting: qz_ping and qz_wait_idle

- `qz_ping` / `qz_ping_path`: liveness probes. The blocking wait happens on
  the **calling thread** (a bounded backoff poll for the reply the library's
  own thread fills in); the mailbox is unaffected
- `qz_wait_idle`: requests auto-exit once no async work is pending, then
  blocks until the main body exits. Outbound messages — including a crash
  `{"type":"error"}` — keep entering the mailbox during the wait, and after it
  returns you can still `qz_recv_message` until you call `qz_free`. It is
  mutually exclusive with `qz_destroy` (call one or the other, never both)

## Destroying a Runtime

```c
qz_destroy(rt);  // graceful force-terminate, host thread only, NULL-safe
```

`qz_destroy`:
1. Requests a graceful shutdown; under ISOLATED, if the mainRT stays frozen the
   library's own thread escalates through a three-tier terminate with a
   worst-case ≤2s budget — the caller only waits for the child to be reaped.
   Under THREAD: requests the internal thread to exit and joins it
2. Destroys all contexts (calls extension `destroy` hooks)
3. Frees the `JSRuntime`, the loop/thread the library owned, and any
   **mailbox messages you never consumed** — drain the mailbox first if you
   still need them
4. Frees the runtime

`qz_destroy(NULL)` is safe (no-op).

The alternative shutdown path is `qz_wait_idle` followed by `qz_free`, which
lets you consume final messages after the runtime exits:

```c
qz_wait_idle(rt);
char *json = NULL; size_t len = 0;
while (qz_recv_message(rt, &json, &len, 0) == 0) {
    printf("%.*s\n", (int)len, json);   // last outputs, incl. {"type":"error"}
    qz_free_message(json);
}
qz_free(rt);                           // drains mailbox, closes wake fd, frees rt
```

`qz_free(void*)` is dual-role: given a torn-down rt (after `qz_wait_idle`) it
drains the mailbox, closes the wake fd, and frees the config buffers and the
rt; given a plain malloc'd blob (e.g. from `qz_compile`) it is a plain `free`.
An internal magic tag distinguishes the two. `qz_free(NULL)` is safe.

## Thread Safety

- **JS never runs on the host thread, and host code never runs inside the
  library** — the library owns all its threads/loop; the only bridge between
  the two sides is data (messages), so there are no callback reentrancy rules
- **`qz_post_message` is thread-safe** under both models — call it from any
  thread; the JSON is copied
- **`qz_recv_message` may be called from any thread, but only one consumer at
  a time per rt** — the lock-free pop is *not* mutually exclusive, so
  concurrent calls deliver and free the same node twice; serialize in the
  host, and cross-thread handoff of received messages is the host's job
- **Blocking waits leave the mailbox flowing** — `qz_ping`, `qz_ping_path`,
  and `qz_wait_idle` block the calling thread (the library's own thread keeps
  the loop turning meanwhile); messages (including crash reports) keep
  queueing and are drained whenever you choose
- **`qz_destroy` is host-thread-only** — call it from the thread that called `qz_create`

## Memory Model

- All per-runtime state lives on `qz_t` — there is **zero mutable file-scope state**
- Class IDs are runtime-scoped (shared across contexts within one `qz_t`)
- Recover `qz_t*` from a `JSContext*` via `qz_get_rt_from_ctx(ctx)` (internal)
