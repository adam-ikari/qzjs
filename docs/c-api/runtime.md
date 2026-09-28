# Runtime Lifecycle

Every qzjs program follows the same lifecycle: **create → use → destroy**.

## `qz_create`

```c
qz_t *qz_create(const qz_config_t *config);
```

Creates a new qzjs runtime. What happens on the host side depends on the
build's process model (`QZ_PROCESS_MODEL`, default `ISOLATED`):

- **ISOLATED** — the library owns **no host-side thread or loop**: you must
  inject your own `uv_loop_t` via `config.uv_loop` (`NULL` → `qz_create`
  fails explicitly; there is no internal host-thread fallback). `qz_create`
  spawns the main-RT process (`qzjs-rt`), completes the ready handshake on a
  synchronous raw-fd read — **the host loop is never pumped during the
  handshake**; pre-ready script messages are buffered and replayed in FIFO
  order to `message_cb` **synchronously on the calling thread before
  `qz_create` returns** — then attaches its host-side channel handles
  (pipe read pump, wake async, tx-spill timer) to `config.uv_loop`. JS —
  including `initial_script` — runs inside the main-RT process, on the
  library-owned loop there.
- **THREAD** — qzjs starts its own internal thread and embedded libuv loop;
  `qz_create` blocks until the thread is ready and `initial_script` has been
  eval'd on it.

The registered extension set is fixed at build time via the `QZ_EXTENSIONS`
macro; there is no runtime extension list. Host and libqzjs must link the
**same** libuv.

Returns `NULL` on failure (including a throwing `initial_script`; under
ISOLATED also on `config.uv_loop == NULL` or a failed ready handshake).

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `config.initial_script` | `const char *` | JS eval'd inside the runtime at create (main-RT process under ISOLATED, internal qzjs thread under THREAD); a throw makes `qz_create` return `NULL` |
| `config.message_cb` | `void (*)(qz_t *, const char *, size_t, void *)` | Outbound message callback; `json` is NUL-terminated (`len` excludes the terminator, same in both models). Fires on the thread pumping `config.uv_loop` under ISOLATED (may fire reentrantly inside blocking host APIs), on the internal qzjs thread under THREAD. Must be thread-safe and must never call a blocking host API |
| `config.uv_loop` | `const void *` (`uv_loop_t *`) | **Required under ISOLATED** — the host's own loop; the library binds all host-side channel handles to it and `NULL` makes `qz_create` fail. Ignored under THREAD. Host and libqzjs must link the same libuv |
| `config.debug` | `int` | Bit mask. `0x2` enables the DAP debugger (also `QZ_DEBUG=1` env var) |
| `config.control_plane` | `int` | `qz_control_plane_t`: `OFF` (0, default — `qz_control` always -1) / `IN_PROC` (1) / `LOCAL` (2, adds an AF_UNIX endpoint) |
| `config.control_pipe_path` | `const char *` | Endpoint path for `LOCAL`; `NULL` → `/tmp/qzjs-<pid>-<n>.ctl` (0600, SO_PEERCRED) |
| `config.worker_backend` | `int` | `qz_worker_backend_t`; default follows the build's process model (ISOLATED → `PROCESS`, THREAD → `THREAD`) |
| `config.host_data` | `void *` | Per-runtime opaque pointer, readable by extensions; passed as the `data` arg to `message_cb` |
| `config.initial_script_path` | `const char *` | JS file read and eval'd instead of `initial_script`; wins if both are set |
| `config.initial_bytecode` | `const uint8_t *` | Precompiled bytecode (from `qz_compile`), eval'd after the initial script |
| `config.initial_bytecode_len` | `size_t` | Length in bytes of `initial_bytecode` |

**What `qz_create` does internally:**

ISOLATED (default):

1. Spawns the main-RT process (`qzjs-rt`) and waits for its `CONTROL{ready}`
   on a synchronous raw-fd read — the host loop is not pumped and no callback
   fires during create
2. Inside the main-RT process: initializes the library-owned libuv loop,
   creates a `JSRuntime` and initial context, registers the build-time
   extension set (the `QZ_EXTENSIONS` table), injects the WinterTC-compatible
   runtime, eval's `initial_script`, then `initial_bytecode` if set
3. Attaches the host-side channel handles (pipe read pump, wake async,
   tx-spill timer) to `config.uv_loop` and returns

THREAD:

1. Starts qzjs's internal thread and initializes the embedded libuv loop
2. On that thread: creates a `JSRuntime` and initial context, registers the
   build-time extension set, injects the WinterTC-compatible runtime, eval's
   `initial_script`, then `initial_bytecode` if set
3. Blocks until the thread is ready, then returns

**Thread model:** all JS runs inside the runtime, on its own single loop
(the main-RT process under ISOLATED, the internal qzjs thread under THREAD).
The host posts messages (`qz_post_message`, thread-safe in both models;
under ISOLATED delivery latency equals your pump frequency, FIFO order per
runtime preserved) and receives them via `message_cb` — on the thread
pumping `config.uv_loop` under ISOLATED, on the qzjs thread under THREAD.

## `qz_destroy`

```c
void qz_destroy(qz_t *rt);
```

Gracefully shuts down the runtime: requests the main runtime (the `qzjs-rt`
process under ISOLATED, the internal thread under THREAD) to exit, joins /
reaps it, then destroys all contexts and frees all resources (handles,
timers, polyfill state, the libuv loop). Under ISOLATED the wait pumps
`config.uv_loop` internally, so `message_cb` may fire reentrantly inside this
call — never call it from `message_cb`. All library handles attached to your
loop are closed on return, so `uv_loop_close` on the host loop succeeds
afterwards. Safe to call with `NULL`. Host-thread only —
call it from the thread that called `qz_create`.

```c
qz_destroy(rt);
```

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

## Host Data

Per-runtime data is available to extensions during initialization:

```c
void *qz_get_runtime_data(qz_t *rt);
void qz_set_runtime_data(qz_t *rt, void *data);
```

`qz_create` copies `config->host_data` onto the runtime, so extension init
hooks can read it before the host has the `rt` pointer — resolving the
init-time ordering deadlock:

```c
qz_config_t cfg = { .initial_script = "postMessage('ready');",
                      .message_cb = on_message,
                      .host_data = my_state,
                      .uv_loop = my_loop /* uv_loop_t*, required under ISOLATED */ };
qz_t *rt = qz_create(&cfg);
// my_state is now available inside extension init via qz_get_runtime_data(rt)
// and arrives as the `data` arg of message_cb
```
