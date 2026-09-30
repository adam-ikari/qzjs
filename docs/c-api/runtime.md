# Runtime Lifecycle

Every qzjs program follows the same lifecycle: **create → use → drain the mailbox → destroy**.

## `qz_create`

```c
qz_t *qz_create(const qz_config_t *config);
```

Creates a new qzjs runtime. What happens on the host side depends on the
build's process model (`QZ_PROCESS_MODEL`, default `ISOLATED`):

- **ISOLATED** — the library **owns its own host-side thread and loop**:
  it spawns the main-RT process (`qzjs-rt`), then starts its internal host-side
  thread + loop (never the host's). `qz_create` blocks until the main-RT's
  `CONTROL{ready}` arrives. Frames that arrived before ready are already
  replayed into the mailbox, so the host's very first `qz_recv_message`
  gets them. JS — including `initial_script` — runs inside the main-RT
  process, on the library-owned loop there.
- **THREAD** — qzjs starts its own internal thread and embedded libuv loop;
  `qz_create` blocks until the thread is ready and `initial_script` has been
  eval'd on it.

The registered extension set is fixed at build time via the `QZ_EXTENSIONS`
macro; there is no runtime extension list. The host does **not** inject a
loop and does **not** provide a callback: every host-bound message goes to
the runtime's [mailbox](#mailbox) and the host drains it on its own thread
at its own time.

Returns `NULL` on failure (including a throwing `initial_script` or a failed
ready handshake).

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `config.initial_script` | `const char *` | JS eval'd inside the runtime at create (main-RT process under ISOLATED, internal qzjs thread under THREAD); a throw makes `qz_create` return `NULL` |
| `config.debug` | `int` | Bit mask. `0x2` enables the DAP debugger (also `QZ_DEBUG=1` env var) |
| `config.control_plane` | `int` | `qz_control_plane_t`: `OFF` (0, default — `qz_control` always -1) / `IN_PROC` (1) / `LOCAL` (2, adds an AF_UNIX endpoint) |
| `config.control_pipe_path` | `const char *` | Endpoint path for `LOCAL`; `NULL` → `/tmp/qzjs-<pid>-<n>.ctl` (0600, SO_PEERCRED) |
| `config.worker_backend` | `int` | `qz_worker_backend_t`; default follows the build's process model (ISOLATED → `PROCESS`, THREAD → `THREAD`) |
| `config.initial_script_path` | `const char *` | JS file read and eval'd instead of `initial_script`; wins if both are set |
| `config.initial_bytecode` | `const uint8_t *` | Precompiled bytecode (from `qz_compile`), eval'd after the initial script |
| `config.initial_bytecode_len` | `size_t` | Length in bytes of `initial_bytecode` |

**What `qz_create` does internally:**

ISOLATED (default):

1. Spawns the main-RT process (`qzjs-rt`), starts the library's own host-side
   thread + loop, and blocks until the main-RT's `CONTROL{ready}` —
   no host code runs during create; pre-ready frames are already in the
   mailbox
2. Inside the main-RT process: initializes the library-owned libuv loop,
   creates a `JSRuntime` and initial context, registers the build-time
   extension set (the `QZ_EXTENSIONS` table), injects the WinterTC-compatible
   runtime, eval's `initial_script`, then `initial_bytecode` if set
3. Returns once the runtime is ready

THREAD:

1. Starts qzjs's internal thread and initializes the embedded libuv loop
2. On that thread: creates a `JSRuntime` and initial context, registers the
   build-time extension set, injects the WinterTC-compatible runtime, eval's
   `initial_script`, then `initial_bytecode` if set
3. Blocks until the thread is ready, then returns

**Thread model:** the library owns its threads and loops and never runs host
code. All JS runs inside the runtime, on its own single loop (the main-RT
process under ISOLATED, the internal qzjs thread under THREAD). The host
posts messages (`qz_post_message`, thread-safe in both models; FIFO order per
runtime preserved) and receives everything — JS `postMessage` output, the
crash report `{"type":"error"}`, and CONTROL receipts — from the
[mailbox](#mailbox), on the thread and at the cadence it chooses. There is
no libuv loop-injection obligation and no same-libuv requirement. The
liveness pings (`qz_ping`, `qz_ping_path`) do their blocking wait on the
library's own thread; the mailbox is unaffected.

## `qz_destroy`

```c
void qz_destroy(qz_t *rt);
```

Gracefully shuts down the runtime: requests the main runtime (the `qzjs-rt`
process under ISOLATED, the internal thread under THREAD) to exit, joins /
reaps it, then destroys all contexts and frees all resources (handles,
timers, polyfill state, the library's own loops — including the host-side
thread under ISOLATED). Under ISOLATED the three-tier terminate of a
frozen main-RT takes at most ~2s worst case and is handled inside the
library's thread; the caller only waits for reaping. **Mailbox messages the
host never consumed are freed here** — drain with `qz_recv_message` first if
you need them. Safe to call with `NULL`. Host-thread only —
call it from the thread that called `qz_create`.

```c
qz_destroy(rt);
```

Mutually exclusive with `qz_wait_idle`: use one or the other to end a
runtime.

## `qz_wait_idle`

```c
void qz_wait_idle(qz_t *rt);
```

Requests the runtime to auto-exit once no async work is pending, then blocks
until the main body exits. The wait runs **on the calling thread** — the host
thread just blocks and drives nothing; what the library's own thread does
during the wait is keep the loop turning and perform the teardown. Outbound
messages (including the crash report
`{"type":"error"}`) keep entering the mailbox during the wait, and after
`qz_wait_idle` returns but before `qz_free`, `qz_recv_message` still works —
do your final drain there. After it returns the runtime must not be used for
posting and must not be `qz_destroy`d — only `qz_free`. Mutually exclusive
with `qz_destroy` (call one or the other, never both).

## `qz_free`

```c
void qz_free(void *p);
```

Dual-role release, distinguished internally by a magic tag:

- Given a torn-down runtime (after `qz_wait_idle`) — drains the mailbox,
  closes the wake fd, frees the config buffers and the runtime itself.
- Given a plain malloc blob (e.g. from `qz_compile`) — plain `free`.

## `qz_compile`

```c
int qz_compile(const char *source, size_t len, const char *filename,
               uint8_t **out, size_t *out_len, char **err);
```

Compiles JS source to a bytecode blob. Standalone — no runtime needed.
Returns 0 on success (`*out` malloc'd, free with `free()`; `*out_len` set)
or -1 (`*err` malloc'd message, free with `free()`). `filename` is for
error/backtrace naming only, may be `NULL`.

Run the blob at startup via `qz_config_t.initial_bytecode` /
`initial_bytecode_len`, or `qzjs --bytecode file.bc` on the CLI.

**Compatibility is not guaranteed:** bytecode is bound to the exact qzjs
build (engine version, serialization format, compile options). A blob from a
different build fails `qz_create` with `SyntaxError: invalid version`.
Distribute source and compile at deploy time on the target build. See
[Bytecode Compilation](/guide/bytecode).

## Messaging

### `qz_post_message`

```c
int qz_post_message(qz_t *rt, const char *json, size_t len);
```

Enqueues an inbound message for the runtime. Thread-safe from any thread;
`json` is copied internally, so the caller keeps ownership. Returns 0 on
success, -1 on failure (bad arguments, or the runtime is shutting down —
posting after `qz_wait_idle` returns is rejected).

FIFO order is preserved per runtime. Delivery does not depend on the host's
scheduling — the library's own thread moves frames in both directions.

```c
#include <qzjs/qzjs.h>

static const char kMsg[] = "{\"cmd\":\"echo\",\"data\":\"hi\"}";
qz_post_message(rt, kMsg, sizeof kMsg - 1);   /* len excludes the NUL */
```

### `qz_control`

```c
int qz_control(qz_t *rt, const char *bytes, size_t len);
```

Enqueues a control command. Thread-safe from any thread; `bytes` is copied.
Always returns -1 when `config.control_plane` is `OFF` (the default). Returns
0 on success, -1 on failure (OFF / OOM / invalid arguments / rejected below).

The command is executed autonomously by the main body at a safe point in its
own event loop (ISOLATED = the main-RT process, THREAD = the qzjs thread).
The **receipt arrives asynchronously in the mailbox** (`qz_recv_message`),
with `"ctl":true` at the top level and `correl` echoed verbatim for pairing.

Two inputs are rejected at the door rather than silently mishandled:

- A top-level **numeric** `"qzjs"` key is the channel layer's reserved
  namespace for system CONTROL (`ready` / `idle` / `shutdown` / `ping` /
  `pong` / `pfail`). The main RT consumes those in place instead of routing
  them — a user command carrying the key would vanish with no receipt and no
  error, so `qz_control` refuses it.
- A missing `"correl"` (absent, non-string, or empty). The receipt's only
  pairing key is `correl`; without it the host receives an orphan
  `correl:""` receipt it can neither match nor discard.

  **One exception: `op:"interrupt"`.** It is fire-and-forget — its effect is
  setting the atomic interrupt flag at post time, and the command message is
  enqueued only so a receipt *could* be produced. So a `correl`-less
  interrupt is **accepted** (returns 0) and, to avoid producing the very
  orphan described above, it is neither registered nor enqueued. An interrupt
  that *does* carry a `correl` takes the normal path (registered, enqueued,
  receipt written) — ignore the receipt if you don't want it.

Design notes live in `docs/archive/plans/2026-09-04-control-plane-design.md`
(archived, not part of the site routes). For the four commands and correl
pairing in practice, see [Control Plane via qzjs-ctl](/guide/cli).

## Liveness

### `qz_ping` / `qz_ping_path` (ISOLATED only)

```c
int qz_ping(qz_t *rt, int32_t timeout_ms);
int qz_ping_path(qz_t *rt, const int32_t *path, int path_len,
                 int32_t timeout_ms);
```

`qz_ping` sends a CONTROL ping to the main RT and waits for the PONG that its
C-level read callback answers directly (never through JS or the msgq — pong
latency reflects the main-RT process's uv loop health, so a busy JS thread
does not produce a false alarm). `qz_ping_path` reaches any worker in the tree
by root-relative slot chain (§8.2 path addressing) — `path` uses the same
scheme as the command plane's `target_path`, e.g. `{1001,1002}` = the sub
worker 1002 of worker 1001. The ping is forwarded hop by hop and the PONG
travels back up the tree; intermediate nodes and target-level JS do not
participate.

| Return | Meaning |
|--------|---------|
| `0` | target loop healthy (PONG arrived within the deadline) |
| `1` | timeout = target loop blocked |
| `-1` | bad arguments / wrong state (not ready, shutting down, channel dead, path not found) |

`timeout_ms` of 100–1000 is the useful range. The wait happens on the
**calling** thread (a bounded backoff poll); the mailbox is unaffected.

**These two are declared only under `QZ_PROCESS_MODEL_ISOLATED`** (and not in
mock test builds) because their implementation lives in `src/rt_host.c`, which
is compiled only there. In a THREAD build the declarations are simply absent,
so a host that calls them fails at compile time with a diagnostic pointing at
the line — not with a link-time `undefined reference` that looks like a broken
build.

### `qz_ping_if_available` / `qz_ping_path_if_available` (all builds)

```c
#define QZ_PING_UNAVAILABLE (-2)
int qz_ping_if_available(qz_t *rt, int32_t timeout_ms);
int qz_ping_path_if_available(qz_t *rt, const int32_t *path, int path_len,
                              int32_t timeout_ms);
```

The same probes, available in every build so portable host code needs no
`#if` and no knowledge of the internal `QZ_PROCESS_MODEL_*` macros. Under
ISOLATED they forward to `qz_ping` / `qz_ping_path`. Under THREAD (and mock
test builds) they return `QZ_PING_UNAVAILABLE`: all JS runs on the library's
own thread, so there is no boundary between host and JS to ping — "is my own
loop responsive?" is not a meaningful probe. They deliberately do **not**
return 0 there: reporting health that was never measured is worse than saying
"not measurable", because the host would go on believing the loop was checked.

| Return | Meaning |
|--------|---------|
| `0` / `1` / `-1` | same as `qz_ping` above |
| `QZ_PING_UNAVAILABLE` (`-2`) | this build has no cross-boundary liveness to measure |

`QZ_PING_UNAVAILABLE` is deliberately distinct from `-1` (bad arguments or
state): "my call was wrong" and "this build cannot answer" call for different
follow-ups, and folding them together would leave the host unable to tell them
apart.

```c
#include <qzjs/qzjs.h>

int rc = qz_ping_if_available(rt, 500);
if (rc == QZ_PING_UNAVAILABLE) {
    /* THREAD build: no cross-process boundary to probe. */
} else if (rc != 0) {
    fprintf(stderr, "main RT loop blocked or probe failed: %d\n", rc);
}
```

## Mailbox

Every message the library sends to the host — JS `postMessage` output, the
crash report `{"type":"error"}`, and CONTROL receipts (which carry
`"ctl":true` plus a `correl` field) — lands in a per-runtime FIFO **mailbox**
the host drains on its own thread at its own time:

```c
int  qz_recv_message(qz_t *rt, char **json, size_t *len, int timeout_ms);
void qz_free_message(void *json);
int  qz_message_fd(qz_t *rt);
```

### `qz_recv_message`

```c
int qz_recv_message(qz_t *rt, char **json, size_t *len, int timeout_ms);
```

Pops the oldest mailbox message.

- `timeout_ms`: `0` = pure poll (no wait), `> 0` = wait up to that many
  milliseconds, `-1` = block forever until a message arrives.
- Returns `0` = got a message (`*json` is a malloc'd, NUL-terminated UTF-8
  buffer you **must** release with `qz_free_message`; `*len` excludes the
  terminator), `1` = timeout (`*json` untouched), `-1` = parameter/state
  error.

### Library error frames — your loop **must** tolerate them

The mailbox does not carry only your protocol. On failure the library pushes a
`{"type":"error", ...}` frame into the stream: that is §5.3 "no silent
degradation" made concrete — a frame shape you didn't expect is strictly better
than an **unmarked hole** in what you receive. Two kinds exist today:

| `error` value | Meaning | What the host should do |
|---|---|---|
| (crash report, see `qz_wait_idle`) | the main RT crashed; the frame carries the crash detail | log it; the runtime is no longer meaningful |
| `mailbox-alloc-failed` | an **outbound message could not be delivered** (malloc failed) — that message **is lost** | log and alert; drain the mailbox faster |

`mailbox-alloc-failed` matters because the outbound mailbox is **unbounded**:
if you do not drain it, it grows until allocation fails. So its appearance is
almost always "the host drains too slowly", not "the library is broken" — which
is what the frame's `hint` field says.

**So do not assume every frame is your own protocol.** One discriminator is
enough:

```c
char *json = NULL;
size_t len = 0;
int r;
while ((r = qz_recv_message(rt, &json, &len, 1000)) == 0) {
    if (strstr(json, "\"type\":\"error\"")) {
        /* 库的错误帧：记录后**继续**排干，不要 break —— 后面可能还有正常消息 */
        fprintf(stderr, "qzjs error frame: %.*s\n", (int)len, json);
    } else {
        printf("my protocol: %.*s\n", (int)len, json);   /* 你自己的协议 */
    }
    qz_free_message(json);             /* 每条都要放，循环里别漏 */
}
if (r < 0)
    fprintf(stderr, "recv failed: 参数/状态错误（不是「没消息」）\n");
else
    fprintf(stderr, "idle: 1s 内没有新消息\n");
```

Treat it as an error-visibility contract the host must implement, not as one
specific frame: when the library adds a new error kind later, the same
discriminator keeps working.

### `qz_free_message`

```c
void qz_free_message(void *json);
```

Releases the buffer returned by `qz_recv_message`. NULL-safe.

### `qz_message_fd`

```c
int qz_message_fd(qz_t *rt);
```

The runtime's wake fd — an `eventfd` (monotonic counter, non-blocking,
CLOEXEC). Integrate it into your own poll/epoll/select loop; readable ⇒ at
least one message is pending. The fd is owned by the runtime: the host must
**not** close it, and it becomes invalid after `qz_free`. Linux-only
(eventfd).

### The consume protocol

When waiting on the wake fd, this is the **only** correct order (it prevents
lost wakeups, because a message is linked into the mailbox **before** the
eventfd is written):

1. `qz_recv_message(rt, &json, &len, 0)` — drain and **process** until it
   returns non-0.
2. `read(qz_message_fd(rt), ...)` — clear the eventfd counter until `EAGAIN`.
3. Re-probe `qz_recv_message(rt, &json, &len, 0)` once more — if it returns a
   message, go back to step 1 (and process it); only when it is empty may you
   `poll()` block.

### Consumer rules

- Any thread may call `qz_recv_message`, but **only one at a time per
  runtime** — the lock-free pop is *not* mutually exclusive, so two
  concurrent callers read the same head node and deliver and free it twice.
  Serialize consumption in the host; handing a taken message to another
  thread is the host's job.
- Messages you never consume are freed at `qz_destroy` / `qz_free` — no leak,
  but unreachable afterward. Drain the mailbox first if you still need them.

### Pure-poll draining example

```c
static void host_drain(qz_t *rt, int timeout_ms) {
    for (;;) {
        char *json = NULL; size_t len = 0;
        int r = qz_recv_message(rt, &json, &len, timeout_ms);
        if (r != 0) break;
        printf("[host] got JS message: %.*s\n", (int)len, json);
        qz_free_message(json);
        timeout_ms = 0;   /* switch to pure poll once the first message lands */
    }
}
```

Typical run: `qz_create` → `qz_post_message` → loop `qz_recv_message(timeout)`
until done → `qz_wait_idle` → final `qz_recv_message(..., 0)` drain →
`qz_free`.
