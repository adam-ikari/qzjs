---
title: Host Integration
description: The host integration path for embedding qzjs in a C application — create, the JSON message contract, lending capabilities to JavaScript, and graceful teardown.
---

# Host Integration

Embedding qzjs in a C application goes through five steps. qzjs has no
`qz_eval`: the host and the runtime communicate only over
JSON messages.

## The Five Steps

```
┌─────────────────────────────────────────────────────────────┐
│ 1. create      qz_create(&cfg)   — runtime live, JS ready   │
│ 2. script      initial_script(_path)    — what JS runs first │
│ 3. communicate qz_post_message ⇄ message_cb  — JSON contract│
│ 4. lend        expose C funcs, serve/fs/worker/crypto to JS   │
│ 5. destroy     qz_destroy(rt)    — graceful shutdown         │
└─────────────────────────────────────────────────────────────┘
```

## 1. Create

[`qz_create`](/c-api/runtime) boots the runtime and evals
`cfg.initial_script`. Under the default **ISOLATED** host contract you must
pass your own `uv_loop_t` as `cfg.uv_loop` (`NULL` → `qz_create` fails
explicitly — no internal host-thread fallback): `qz_create` spawns the
main-RT process (`qzjs-rt`), completes its ready handshake on a synchronous
raw-fd read — no pumping, no callbacks during create — then binds its
host-side channel handles (pipe read pump, wake async, tx-spill timer) onto
your loop. Under **THREAD** it starts qzjs's internal thread and embedded
libuv loop instead. Either way it **blocks until ready** — when it returns,
the runtime is live and `initial_script` has run.

```c
uv_loop_t loop;
uv_loop_init(&loop);

qz_config_t cfg = {0};
cfg.initial_script = "postMessage({ready: true});";
cfg.message_cb = on_message;      // outbound JS→host
cfg.uv_loop    = &loop;           // host loop (required under ISOLATED)
qz_t *rt = qz_create(&cfg);   // blocks until ready
```

## 2. Choose What JS Runs First

Three ways to feed the runtime its initial script:

- **`initial_script`** — a small inline string, good for bootstrap logic. qzjs
  compiles its own WinterTC polyfill to bytecode internally. Precompiled
  bytecode also composes: set `initial_bytecode` to run a `qz_compile()` blob
  after the script (bytecode is build-locked — see
  [Bytecode](/guide/bytecode))
- **`initial_script_path`** — a filesystem path to a JS file; qzjs reads and
  evals it at creation. Convenient when the script lives on disk (deployment).
  If both are set, `initial_script_path` wins; a missing file fails
  `qz_create` (returns `NULL`).
- **`qz_post_message`** — drive everything else by messaging the runtime
  after creation

## 3. The Message Contract

The host and JS exchange data as JSON strings in both directions: no
pointers, no shared memory objects cross the boundary.

Under **ISOLATED** the host owns its loop: the library binds its channel
handles onto the `uv_loop_t` you inject (`cfg.uv_loop`) and runs nothing of
its own on the host side. Under **THREAD**, qzjs owns its internal thread and
loop and the host pumps nothing. In both models the host never calls into JS
to make it run.

| Direction | Mechanism | Thread |
|-----------|-----------|--------|
| Host → JS | `qz_post_message(rt, json, len)` | thread-safe, call from any thread |
| JS → Host | `cfg.message_cb(rt, json, len, data)` | ISOLATED: fires on the thread pumping your `cfg.uv_loop`; THREAD: fires on qzjs's thread |

Rules:

- **Both directions are JSON strings.** No pointers, no shared memory objects
  across the boundary — pass serializable data only.
- **`qz_post_message` is thread-safe** under both models. You may call it
  from any host thread; it enqueues into the runtime's inbound queue (MPSC +
  `uv_async`). Under ISOLATED its delivery latency equals your pump
  frequency; FIFO order per runtime is preserved.
- **Under ISOLATED, `message_cb` runs on the thread that pumps
  `cfg.uv_loop`.** Keep it fast, and **never call a blocking host API
  (`qz_ping`, `qz_ping_path`, `qz_wait_idle`, `qz_destroy`) from inside it** —
  those pump the loop internally (`UV_RUN_NOWAIT` + yield), which would mean
  a nested `uv_run`; the callback may already be firing reentrantly inside
  one of them. Heavy work belongs back on your own thread/queue. Under
  THREAD, `message_cb` shares the qzjs thread with the event loop and all
  JS — keep it fast and thread-safe there too.
- **Under ISOLATED, replies arrive when you pump.** Your own scheduling
  drives `uv_run`, or the blocking host APIs pump the loop for you. The
  library never calls `uv_run(UV_RUN_DEFAULT)` or `uv_loop_close` on your
  loop.
- **There is a bounded queue.** If the runtime is busy (or JS never reads),
  inbound messages backpressure at the queue bound. Design your host to cope
  with `qz_post_message` not draining instantly.

```c
static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    // json is a full JSON string; parse and dispatch on the host side
    handle_json(json, len);
}

// from any host thread:
qz_post_message(rt, "{\"cmd\":\"start\",\"n\":42}", 22);
```

The reciprocal — **JS calling C** — is `postMessage` from JS (which lands in
`message_cb`) or registering C functions as JS globals. See
[Extensions](/guide/extensions) and the deep-dive
[Embedding Patterns](/guide/embedding).

### Sending code to run

The boundary carries JSON, but what you put in that JSON is up to you. A
common pattern is sending a `{ cmd: 'eval', code: ... }` message and having
the JS side execute it — this is how a REPL or a dynamic-rule engine works:

```js
// initial_script
globalThis.onmessage = function (e) {
  if (e.data && e.data.cmd === 'eval') {
    let out;
    try { out = eval(e.data.code); }
    catch (err) { out = { error: String(err) }; }
    postMessage({ result: out });
  }
};
```

```c
// host side — send code to run
qz_post_message(rt, "{\"cmd\":\"eval\",\"code\":\"2 + 2\"}", 26);
// message_cb receives: {"result":4}
```

The snippet is executed by the JS `eval` in the runtime; the result flows back
over `message_cb` like any other reply.

### Double-ended event dispatch

Both sides dispatch by event type. Agree on a shape — `{"type": ..., "payload": ...}`
— and give **each** end its own dispatcher: the JS side routes inbound host
messages in `onmessage`, the C side routes inbound JS replies in `message_cb`.

**JS side** — a dispatcher that handles a table of events and replies:

```js
// initial_script — JS event dispatcher
const handlers = {
  ping(d)  { return { ok: true, at: Date.now() }; },
  add(d)   { return d.a + d.b; },
};
globalThis.onmessage = function (e) {
  const { type, payload } = e.data || {};
  const h = handlers[type];
  postMessage({ type: type + ':reply', ok: !!h, payload: h ? h(payload) : undefined });
};
```

**Host side** — mirror the same dispatch in `message_cb`, routing each inbound
event (a `{type, payload}` JSON string) to a C handler:

```c
#include <qzjs/qzjs.h>
#include <uv.h>
#include <stdio.h>
#include <string.h>

static void on_ping(const char *json)  { puts("[host] ping:reply"); }
static void on_add(const char *json)   { puts("[host] add:reply"); }

static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    /* parse `type` with your host JSON library; substring match shown for brevity */
    if (strstr(json, "\"type\":\"ping:reply\"")) on_ping(json);
    else if (strstr(json, "\"type\":\"add:reply\"")) on_add(json);
}

int main(void) {
    uv_loop_t loop;
    uv_loop_init(&loop);

    qz_config_t cfg = {0};
    cfg.message_cb = on_message;
    cfg.initial_script = "/* the JS dispatcher above */";
    cfg.uv_loop = &loop;                    /* ISOLATED: the host loop (required) */
    qz_t *rt = qz_create(&cfg);

    const char *ping = "{\"type\":\"ping\",\"payload\":{}}";
    qz_post_message(rt, ping, strlen(ping));            // → on_ping
    const char *add  = "{\"type\":\"add\",\"payload\":{\"a\":2,\"b\":3}}";
    qz_post_message(rt, add, strlen(add));              // → on_add

    /* Pump the host loop: on_message dispatches replies as they arrive */
    while (uv_run(&loop, UV_RUN_ONCE)) { /* until done */ }

    qz_destroy(rt);
    uv_loop_close(&loop);
    return 0;
}
```

One dispatcher per end keeps the event contract symmetric and readable: the JS
table and the C `if/else` chain name the same events, so both sides agree on
what `type` means.

## 4. Lend Capabilities to JS

JS in the runtime sees the WinterTC surface as globals, with no imports:
`fetch`, `crypto.subtle`, `ReadableStream`, timers, `fs`, `WebSocket`,
`Worker`, `BroadcastChannel`, `serve()` (HTTP/WS/gRPC servers). See the
[JS API Reference](/js-api/).

You can also register your own C functions as JS globals. See
[Extensions](/guide/extensions).

## 5. Destroy

[`qz_destroy`](/c-api/runtime) performs a graceful shutdown: under ISOLATED
it pumps your loop internally while it tears the main-RT process down and
closes every library handle bound to `cfg.uv_loop` (so `uv_loop_close` on
your loop succeeds afterwards); under THREAD it signals the internal thread
and joins it. Either way it drains pending work and frees the runtime. Call
it from the host when the runtime is no longer needed. For the full
lifecycle and memory model, see [Runtime Lifecycle](/guide/lifecycle).

---

## Related pages

| Topic | Page |
|-------|------|
| Thread ownership, readiness, shutdown | [Runtime Lifecycle](/guide/lifecycle) |
| Who drives the loop, backpressure | [Event Loop](/guide/event-loop) |
| Multiple isolated contexts in one runtime | [Multi-Context](/guide/multi-context) |
| Register C functions / structured data | [Embedding Patterns](/guide/embedding) |
| C API reference | [C API](/c-api/) |
