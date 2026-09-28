---
title: Host Integration
description: The host integration path for embedding qzjs in a C application — create, the JSON mailbox contract, lending capabilities to JavaScript, and graceful teardown.
---

# Host Integration

Embedding qzjs in a C application goes through five steps. qzjs has no
`qz_eval`: the host and the runtime communicate only over
JSON messages. And qzjs never runs host code — there are no callbacks:
every outbound message lands in a mailbox the host consumes on its own
thread at its own time.

## The Five Steps

```
┌─────────────────────────────────────────────────────────────┐
│ 1. create      qz_create(&cfg)   — runtime live, JS ready   │
│ 2. script      initial_script(_path)    — what JS runs first │
│ 3. communicate qz_post_message ⇄ qz_recv_message — mailbox  │
│ 4. lend        expose C funcs, serve/fs/worker/crypto to JS   │
│ 5. destroy     qz_destroy(rt)    — graceful shutdown         │
└─────────────────────────────────────────────────────────────┘
```

## 1. Create

[`qz_create`](/c-api/runtime) boots the runtime and evals
`cfg.initial_script`. Under the default **ISOLATED** build, `qz_create`
spawns the main-RT process (`qzjs-rt`) and then the **library starts its own
host-side pump thread + loop** — you inject nothing and pump nothing. It
blocks until mainRT's `CONTROL{ready}` receipt arrives; frames that arrived
before ready are already replayed into the mailbox, so the host's very first
`qz_recv_message` gets them. Under **THREAD** it starts qzjs's internal
thread and embedded libuv loop instead. Either way it **blocks until ready** —
when it returns, the runtime is live and `initial_script` has run. On failure
it returns `NULL`.

```c
qz_config_t cfg = {0};
cfg.initial_script = "postMessage({ready: true});";
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

qzjs **never executes host code** — there is no callback anywhere in the
public API. All host-bound messages — JS `postMessage`, the crash report
`{"type":"error"}`, and CONTROL receipts — land in a per-runtime FIFO
**mailbox** that the host drains on its own thread at its own time. Under
both builds the library owns its threads and loops (ISOLATED: mainRT child
process plus a library-internal host-side pump thread; THREAD: an internal
qzjs thread); the host simply reads the mailbox.

| Direction | Mechanism | Thread |
|-----------|-----------|--------|
| Host → JS | `qz_post_message(rt, json, len)` | thread-safe, call from any thread |
| JS → Host | mailbox, consumed via `qz_recv_message(rt, &json, &len, timeout_ms)` | the host picks its own thread and timing |

```c
int  qz_recv_message(qz_t *rt, char **json, size_t *len, int timeout_ms);
void qz_free_message(void *json);
int  qz_message_fd(qz_t *rt);
```

- **`qz_recv_message`** — `timeout_ms`: `0` = pure poll (no wait), `>0` = wait
  up to that many ms, `-1` = block forever. Returns `0` = got a message
  (`*json` is a malloc buffer you **must** release with `qz_free_message`),
  `1` = timeout (`*json` untouched), `-1` = param/state error. `json` is
  NUL-terminated UTF-8; `len` excludes the terminator.
- **`qz_message_fd`** — the runtime's wake fd (an `eventfd`). Readable ⇒ ≥1
  message pending. Integrate it into your own poll/epoll/select. Owned by the
  runtime: the host must NOT close it, and it becomes invalid after `qz_free`.
  Linux-only.
- **`qz_free_message`** — releases the buffer returned by `qz_recv_message`.
  NULL-safe.

Rules:

- **Both directions are JSON strings.** No pointers, no shared memory objects
  across the boundary — pass serializable data only.
- **`qz_post_message` is thread-safe** under both models. You may call it
  from any host thread; it enqueues into the runtime's inbound queue. FIFO
  order per runtime is preserved, and delivery does not depend on the host's
  schedule — the library's own pump thread moves frames in both directions.
- **The host fully owns consumption.** Any thread, any timing. Multiple
  threads may concurrently call `qz_recv_message` on the same runtime (the
  pop is mutually exclusive), but at most one thread should be the "fd
  waiter"; cross-thread message ownership handoff is the host's job.
- **The blocking host APIs (`qz_ping`, `qz_ping_path`, `qz_wait_idle`,
  `qz_destroy`) wait on the library's pump thread**, not on anything you run.
  There is no callback to keep fast and no nesting to avoid — drain the
  mailbox whenever convenient, including while one of them is blocked on
  another thread.
- **Unconsumed messages are freed at `qz_destroy`/`qz_free`** — no leak, but
  drain the mailbox first if you need the messages.
- **There is a bounded queue.** If the runtime is busy (or JS never reads),
  inbound messages backpressure at the queue bound. Design your host to cope
  with `qz_post_message` not draining instantly.

```c
static void host_drain(qz_t *rt, int timeout_ms) {
    for (;;) {
        char *json = NULL; size_t len = 0;
        int r = qz_recv_message(rt, &json, &len, timeout_ms);
        if (r != 0) break;
        // json is a full JSON string; parse and dispatch on the host side
        handle_json(json, len);
        qz_free_message(json);
        timeout_ms = 0;   // first arrived — switch to pure poll to drain
    }
}

// from any host thread:
qz_post_message(rt, "{\"cmd\":\"start\",\"n\":42}", 22);
```

The reciprocal — **JS calling C** — is `postMessage` from JS (which lands in
the mailbox) or registering C functions as JS globals. See
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
// qz_recv_message returns: {"result":4}
```

The snippet is executed by the JS `eval` in the runtime; the result flows back
through the mailbox like any other reply.

### Double-ended event dispatch

Both sides dispatch by event type. Agree on a shape — `{"type": ..., "payload": ...}`
— and give **each** end its own dispatcher: the JS side routes inbound host
messages in `onmessage`, the C side routes inbound JS replies as it drains the
mailbox.

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

**Host side** — mirror the same dispatch while draining the mailbox, routing
each inbound event (a `{type, payload}` JSON string) to a C handler:

```c
#include <qzjs/qzjs.h>
#include <stdio.h>
#include <string.h>

static void on_ping(const char *json)  { puts("[host] ping:reply"); }
static void on_add(const char *json)   { puts("[host] add:reply"); }

static void dispatch_message(const char *json) {
    /* parse `type` with your host JSON library; substring match shown for brevity */
    if (strstr(json, "\"type\":\"ping:reply\"")) on_ping(json);
    else if (strstr(json, "\"type\":\"add:reply\"")) on_add(json);
}

int main(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = "/* the JS dispatcher above */";
    qz_t *rt = qz_create(&cfg);          // library owns its threads/loop

    const char *ping = "{\"type\":\"ping\",\"payload\":{}}";
    qz_post_message(rt, ping, strlen(ping));            // → on_ping
    const char *add  = "{\"type\":\"add\",\"payload\":{\"a\":2,\"b\":3}}";
    qz_post_message(rt, add, strlen(add));              // → on_add

    /* Consume the mailbox here: two replies expected, wait up to 2s each */
    for (int i = 0; i < 2; i++) {
        char *json = NULL; size_t len = 0;
        if (qz_recv_message(rt, &json, &len, 2000) != 0) break;
        dispatch_message(json);
        qz_free_message(json);
    }

    qz_destroy(rt);
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

[`qz_destroy`](/c-api/runtime) performs a graceful force-terminate: under
ISOLATED the worst case is a ≤2s three-tier terminate of a frozen mainRT,
handled inside the library's own thread — the caller only waits for the
reaping; under THREAD it signals the internal thread and joins it. Either way
it drains pending work and frees the runtime. **Any mailbox messages you have
not consumed are freed at this point**, so drain first if you need them. Call
it from the host when the runtime is no longer needed. For the full
lifecycle and memory model, see [Runtime Lifecycle](/guide/lifecycle).

---

## Related pages

| Topic | Page |
|-------|------|
| Thread ownership, readiness, shutdown | [Runtime Lifecycle](/guide/lifecycle) |
| Library-owned threads, the wake fd, draining the mailbox | [Event Loop](/guide/event-loop) |
| Multiple isolated contexts in one runtime | [Multi-Context](/guide/multi-context) |
| Register C functions / structured data | [Embedding Patterns](/guide/embedding) |
| C API reference | [C API](/c-api/) |
