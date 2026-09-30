# Claude Code Guidance

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Note**: This content was migrated from `CLAUDE.md` (2025-06) into the `brain/docs/` directory to consolidate project documentation.

## What qzjs is

qzjs is an embeddable **QuickJS-ng runtime wrapper** written in C99. It exposes a
small C API on top of the QuickJS-ng engine, plus a WinterTC-compatible
runtime of standard Web APIs (fetch, console, crypto, streams, timers, fs, …).
It is **libuv-native**: qzjs owns its own thread(s) running libuv event
loops; the host never touches JS directly and **qzjs never runs host code**.
Inbound: host calls `qz_post_message` (thread-safe). Outbound: every
host-bound message (JS `postMessage`, crash `{"type":"error"}`, CONTROL
receipts) is queued into a per-runtime FIFO **mailbox** the host drains
itself via `qz_recv_message` / `qz_free_message`, optionally waking on
`qz_message_fd` (an `eventfd`) in its own poll/epoll/select. There is **no host
callback** and **no loop injection** (M-P7; the old `message_cb` + `cfg.uv_loop`
contract is gone). It is **standalone** — it contains no
LLM/agent/business logic and must not reference upper-layer applications.

## Build & test

```bash
# Configure (QuickJS-ng is auto-built into quickjs-ng/build/ on first run)
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)

# With tests
cmake -B build -DCMAKE_BUILD_TYPE=Debug -DQZ_BUILD_TESTS=ON
cmake --build build -j$(nproc)
cd build && ctest --output-on-failure

# Run a single ctest target
cd build && ctest -R test_am --output-on-failure
# Or invoke the binary directly (some tests need WORKING_DIRECTORY = build/test):
./build/test/test_am

# Tests are labelled for selection: `offline` (CI default; local, deterministic),
# `network` (outbound HTTP/HTTPS), `benchmark` (perf, not pass/fail), `dap`.
ctest -L offline --output-on-failure

# Memory check
valgrind --leak-check=full ./build/test/test_am
```

Feature toggles are CMake options prefixed `QZ_WITH_*` (see README "CMake
Options"). Notable: `QZ_WITH_TLS` (mbedTLS), `QZ_WITH_COMPRESS` (miniz),
`QZ_WITH_CRYPTO_EXT`, `QZ_WITH_TEXTCODEC`, `QZ_WITH_WAMR` (default ON —
the WASM engine; WAMR-2.4.5, Fast Interp + AOT) and `QZ_WITH_WASM3` (default
OFF — alternative engine; the two are mutually exclusive). **libuv is a hard
dependency** (always built via `add_subdirectory` → `uv_a`, C99) — there is no
PAL-backend option anymore. Tests use **mock_libuv** (`test/mock_libuv.{c,h}`),
a fake `uv_*` API for deterministic offline tests, instead of a PAL mock.

**First configure needs network.** With `QZ_BUILD_TESTS=ON`, googletest is
FetchContent'd from GitHub; with WAMR ON (the default), WAMR's build also
FetchContent's asmjit from GitHub (for AOT). Both fail offline. For an offline
build: `cmake -B build -DQZ_WITH_WAMR=OFF -DQZ_BUILD_TESTS=OFF`. CI mirrors
this — most matrix jobs pass `-DQZ_WITH_WAMR=OFF`; one dedicated job covers
WAMR.

**qzjs is strict C99** (`CMAKE_C_STANDARD 99`, `CMAKE_C_EXTENSIONS OFF` →
`-std=c99`, enforced with `-Wall -Wextra -Werror` via `qz_enable_warnings`).
quickjs-ng and libuv ship C11 `<stdatomic.h>` code, but qzjs applies C99
atomics patches (`deps/quickjs-ng-c99-atomics.patch`,
`deps/libuv-c99-atomics.patch`) that swap the C11 `_Atomic`/`atomic_*` ops for
GCC/Clang `__atomic_*` builtins, so they compile under `-std=c99` (qzjs forces
`C_STANDARD 99` on the `qjs`/`uv_a` targets). The patches are applied **in-place
to the submodule working trees** at configure time (`patch -p1 -f`), so
`git status` shows `m deps/libuv`, `m deps/quickjs-ng` after any configure —
this is expected, do not revert or commit it; the next configure re-applies.
`QZ_UNUSED(x)` (qz_internal.h) marks QuickJS-callback fixed-signature
params that would otherwise trip `-Wunused-parameter`.

**No mutable file-scope state.** `src/*.c` contains zero mutable globals —
all per-runtime state (QuickJS class IDs, WASM engine environment, the embedded
`uv_loop_t`, thread handles) lives on `qz_t` (per-runtime, since one qz_t
owns one JSRuntime and QuickJS classes are runtime-scoped). Recover `qz_t*`
from a `JSContext*` via `qz_get_rt_from_ctx(ctx)`, or from a `JSRuntime*`
(finalizers) via `qz_get_rt_from_jsrt(jsrt)`. Deterministic lookup tables
(e.g. CRC32) are `static const`.

Tests link `qzjs` + `mock_libuv` (not a PAL); network/TLS/stream tests
additionally link real libuv (`uv_a`) and are gated behind
`LIBUV_FOUND`/`QZ_WITH_TLS`. A few tests are GoogleTest `.cpp` (fetched via
FetchContent). **The `qzjs` static library does NOT link `uv_a`** — it compiles
against libuv headers only; uv symbols resolve at the final target
(tests: `mock_libuv`; `qz_full`: `uv_a`).

### Building the WinterTC modules

The WinterTC-compatible runtime is **precompiled to QuickJS bytecode and inlined as
`src/polyfill_<mode>.c`** (an auto-generated C array — do not hand-edit; rodata
mode keeps the tracked baseline name `src/polyfill_default.c`, other modes write
their own untracked file). To
rebuild after editing anything under `polyfill/src/`:

```bash
cd polyfill && npm install   # first time only, pulls esbuild
npm run build                # bundles via esbuild, runs qjsc, regenerates the file for the active mode
```

Flow: `polyfill/src/index.js` → esbuild bundles into an IIFE →
`build.js` post-processes so `pal` arrives as an IIFE closure parameter from
`globalThis.__pal_inject__` (see `polyfill/src/pal.js` and the header comment in
`build.js`) → `qjsc -C -b` compiles to bytecode → written to the mode's
generated file and `dist/polyfill.bytecode`. `build.js` looks for
`qjsc` at `QJSC` env var or `../deps/quickjs-ng/build/qjsc`; the actual
checkout lives at `deps/quickjs-ng/` (as a git submodule), so set `QJSC` if the default path is
wrong. The WinterTC modules are injected into a context by `qz_inject_polyfill_ctx`
(bridge.c), which sets `__pal_inject__` to a `pal` JS object for the duration of
the eval.

## Architecture

The runtime is layered. Read these together to understand it:

- **`include/qzjs/qzjs.h`** — the public surface: `qz_config_t` (initial_script /
  initial_script_path / initial_bytecode / debug / control_plane /
  control_pipe_path / worker_backend — **no callback and no loop field**),
  `qz_ext_t` (extension hooks: `init`/`destroy`/`suspend`/`resume`), and the
  core API: `qz_create`, `qz_destroy`, `qz_post_message`, `qz_recv_message`,
  `qz_free_message`, `qz_message_fd`, `qz_wait_idle`, `qz_ping`,
  `qz_ping_path`, `qz_control`, `qz_free`. The PAL-era `qz_eval`/`qz_tick`
  APIs are **gone**, and so is the M-P6 `message_cb`/`cfg.uv_loop`/
  `host_data`/`qz_{get,set}_runtime_data` surface: the host does not eval JS,
  drive a loop, or receive callbacks — it posts JSON in and drains the mailbox
  out. Sovereignty rule (M-P7): qzjs never executes host code; the library
  owns all its threads/loops.
- **`src/qz_internal.h`** — the real internal layout. `qz_t` holds a fixed
  array of up to `QZ_MAX_CONTEXTS` (64) `qz_ctx_t*`, an embedded `uv_loop_t`
  (BY VALUE), the internal `uv_thread_t`, **two lock-free MPSC message queues**
  (`mq_in` inbound FIFO + `mq_out` outbound mailbox, both `qz_mq_t`) plus the
  mailbox `eventfd` (`out_efd`), worker/handle tables, and the module bytecode
  (saved for re-injection). `QZ_MAGIC` validates the opaque `qz_t*`. The `uv.h`
  include switches to `mock_libuv.h` under `QZ_USE_MOCK_LIBUV`.
- **`src/qzjs.c`** — core lifecycle (`qz_create` — ISOLATED spawns the main-RT
  process + the library host-side thread, THREAD starts the internal thread, both
  block until ready; `qz_destroy`/`qz_wait_idle` shutdown; `qz_recv_message`/
  `qz_message_fd` mailbox consumption; `qz_mailbox_teardown` drains `mq_out` +
  closes `out_efd`; `qz_free` dual-role via `QZ_MAGIC` + `thread_joined`;
  internals `qz_runtime_init`/`qz_eval_internal`/`qz_thread_teardown`).
- **`src/rt_host.c`** — the ISOLATED host-side thread+loop (library-owned,
  never the host's): runs `uv_run`, owns the mainRT channel handles, wake
  async, tx-spill timer; three-tier ≤2s terminate of a frozen mainRT happens on
  this thread, the calling thread only joins.
- **`src/thread.c`** — the THREAD-model internal qzjs thread: runs
  `uv_run(UV_RUN_ONCE)`, drains the inbound `mq_in` via `qz_wake_cb`, and
  flushes all JS microtasks (`qz_flush_microtasks`) after each loop iteration.
- **`src/msgq.c`** — the lock-free MPSC queue (ACQ_REL, no mutex/cond/futex)
  instantiated twice: `mq_in` (host→runtime inbound, drained by `qz_wake_cb`
  uv_async wakeup) and `mq_out` (the host-facing mailbox — `qz_out_push` links
  then writes the `out_efd`; `qz_recv_message`/`qz_out_pop` consume). Also the
  `qz_post_to_host` funnel (`rt->host_emit` uplink for the main-RT child →
  else → mailbox) and message encode/decode. `qz_msg_push` no longer sends the
  async internally — each inbound call site wakes explicitly.
- **`src/uv_io.c`** — direct libuv I/O: timers, fs, HTTP, TLS. The old PAL
  backend logic now calls libuv directly (still exposed to JS via the `pal`
  object / `qz_io_*` functions).
- **`src/context.c`** — multi-context lifecycle (`spawn`/`suspend`/`resume`/
  `destroy_ctx`, `qz_get_active_ctx`).
- **`src/worker.c`** — Web Worker support: `new Worker(url)` spawns a new qz_t
  (independent JSRuntime + independent loop) on a new thread.
- **`src/extension.c`** — runs `qz_ext_t` hooks across the build-time
  extension table (no runtime registration; the table is fixed at compile time
  via the `QZ_EXTENSIONS` macro in `include/qzjs/qz_ext_registry.h`).
- **`src/bridge.c`** — the JS↔libuv bridge. Builds the per-context `pal` JS
  object (`qz_create_pal_object_ctx`), injects the WinterTC modules,
  dispatches host messages (`onmessage`), and encodes/decodes JSON between the
  host and JS.
- **`src/ext_*.c`** — native extensions (compress/crypto/textcodec/wamr,
  optionally wasm3/web-wasm), each implementing `qz_ext_t`.
- **`test/mock_libuv.{c,h}`** — fake `uv_*` API for deterministic offline tests
  (synchronous scheduler; real pthread mutex/cond/thread).

### Key execution model

- **JS runs on the library's own thread, never the host's.** Default build
  ISOLATED: `qz_create` spawns the main-RT child *process* (`qzjs-rt`, its own
  `uv_loop_t` + JS) **and** a library-internal host-side thread+loop in
  the host process. THREAD build (fallback): a single internal `uv_thread_t`
  runs the embedded `uv_loop_t`. Either way every JS evaluation, uv callback,
  and microtask runs on the library thread — the host thread never touches
  `JSContext`, and qzjs never runs host code.
- **Message boundary, not eval / not callback.** Host → runtime:
  `qz_post_message` (thread-safe, JSON copied into `mq_in`; the loop thread
  drains and dispatches to JS `onmessage`). Runtime → host: JS `postMessage` /
  crash report / CONTROL receipt → `qz_post_to_host` → the `mq_out` mailbox;
  the host pulls with `qz_recv_message` (returns 0 got / 1 timeout / -1 error;
  the buffer is malloc'd, release with `qz_free_message`) or blocks on the
  `qz_message_fd` `eventfd`. There is no callback and no thread-safety burden
  on the host — it consumes on whichever thread it picks.
- **uv callbacks enter JS directly** on the loop thread (no deferred queue —
  the old `qz_defer_callback` mechanism is gone). After each `uv_run`,
  `qz_flush_microtasks` drains the entire `JS_ExecutePendingJob` queue, so
  one `qz_post_message` round-trip implies the prior eval's promise chain
  completed.
- **Graceful shutdown.** `qz_destroy` signals teardown (`shutting_down` +
  `uv_async_send(wake)`), the library loop thread exits and reaps the
  main-RT process (ISOLATED) — the ≤2s three-tier terminate of a frozen mainRT
  runs on the library thread, the caller only joins — then drains/closes the
  mailbox. After `qz_wait_idle` the mailbox still yields messages until
  `qz_free` (mutually exclusive with `qz_destroy`).

### Bridge layer discipline (`src/bridge.c`)

The `js_pal_*` wrappers in `bridge.c` are the only C between the libuv I/O
layer (`src/uv_io.c`) and the WinterTC modules (JS, which closures over the `pal` JS
object). C is *required* here for three things nothing else can do:

1. **JSValue ↔ C conversion** (`JS_ToCString`, `JS_GetUint8Array`,
   `JS_NewArrayBufferCopy`, `JS_NewString`, …) — the JS modules can't touch
   QuickJS internal representations.
2. **The I/O call** — invoking the `qz_io_*` functions (direct libuv), not a
   PAL function pointer.
3. **Promise + thread boundary** — `JS_NewPromiseCapability`, storing
   resolve/reject handles, so uv callbacks settle promises on the loop thread.

**Everything else stays out of the bridge.** A `js_pal_*` wrapper should do
*only* the three things above. In particular: input validation, default
values, length caps, level mappings, and string formatting are **not** the
bridge's job — they belong in the JS WinterTC modules (caller-facing semantics) or
`uv_io.c` (platform policy), not in C. Keep the bridge thin.
Example: the Web Crypto 65536-byte cap on `getRandomValues` lives in
`polyfill/src/crypto.js`, not in `js_pal_random_bytes`.

## Conventions (from CONTRIBUTING.md)

- C99, 4 spaces, no tabs, no trailing whitespace. `snake_case` functions/vars,
  `SHOUTING_CASE` macros. `/* */` comments (not `//`) in C. Include guards are
  `#ifndef QZ_…_H` (no `#pragma once`).
- Conventional Commits (`feat(qzjs):`, `fix(uv_io):`, …).
- Adding an **extension**: `src/ext_<name>.c` + `include/qzjs/ext_<name>.h`,
  implement `qz_ext_t` (at least `init`+`destroy`), register JS via
  `JS_SetPropertyStr` in `init`, add a `QZ_WITH_<NAME>` option, list it in the
  default extensions in `qz_create`.
- Tests register with `add_test` (NOT a POST_BUILD step — a POST_BUILD run aborts
  the whole build on one failure, see the comment in `test/CMakeLists.txt`).

## Repo layout notes

- `deps/` contains all third-party dependencies as **git submodules** with
  pinned versions: `libuv/` (v1.52.1 — the sole platform backend), `mbedtls/`
  (v3.6.6), `miniz/` (3.1.2), `quickjs-ng/` (v0.15.1), `wamr/` (WAMR-2.4.5,
  default WASM engine), `wasm3/` (v0.5.0, alternative WASM engine).
  **All dependencies are built from source — qzjs links no system libraries.**
  Each is pulled in via `add_subdirectory(... EXCLUDE_FROM_ALL)` (never
  `execute_process`), so its `.o` files live in the main build tree and are
  subject to `-j` / incremental rebuild. Targets: quickjs-ng → `qjs` (C99;
  atomics patched), libuv → `uv_a` (C99; atomics patched, always built),
  mbedtls → `mbedtls`/`mbedx509`/
  `mbedcrypto` (C99, when `QZ_WITH_TLS`/`QZ_WITH_CRYPTO_EXT`), miniz →
  `miniz` (C90, when `QZ_WITH_COMPRESS`), wasm3 → `m3` (C99, when
  `QZ_WITH_WASM3`), wamr → `vmlib` (libiwasm.a, when `QZ_WITH_WAMR`).
  qzjs's C99 / `-Werror` are PRIVATE to the qzjs targets
  only — vendored deps compile under their own standard.
- **Never edit vendored dep source** — control them only via CMake
  variables/options in the root `CMakeLists.txt`. Deps are pinned to specific
  git tags; update by checking out the desired tag in the submodule.
- `src/debugger.c` + `src/debugger_dap.c` (+ `include/qzjs/qz_debug{,_dap}.h`)
  implement the DAP step-debugger, gated by `QZ_BUILD_DEBUGGER` (default OFF;
  applies `deps/quickjs-ng-debugger.patch` to the engine).
- `libam_full` is a CMake link-interface aggregator (qzjs + real libuv + enabled extensions) for host embedding; the core static lib deliberately does not bundle uv/extension symbols — they resolve at the final link, and `install` ships every vendored archive alongside `libqzjs.a`.
- `qzjs.pc` (pkg-config, full static link line) is also produced.
- `.github/workflows/ci.yml` — Actions matrix: most jobs build with
  `-DQZ_WITH_WAMR=OFF` for speed, plus dedicated `wamr`/`wasm3` and ASan+UBSan
  jobs; tests run as `ctest -L offline`.
- `docs/` is a VitePress site (`.vitepress/`, `zh/`) plus design docs
  (`qzjs-architecture-design.md` — PAL sections marked deprecated after the
  libuv-native migration) and the current migration spec
  (`docs/archive/superpowers/specs/2026-08-12-qzjs-libuv-native-design.md`).

<!-- BEGIN brain.md -->
## Project Brain

This project keeps a **Project Brain**: a persistent memory layer of its durable decisions, requirements, and constraints. Read `./BRAIN.md` for the full read/write contract.
@import ./BRAIN.md

Maintain the brain as part of normal coding work — not as a separate task. While discussing or implementing features:
- **Start of a task:** load relevant context with the `brain` CLI (`list-pages`, `read-page`, `read-root`). Prefer a narrow read over scanning everything.
- **When a decision, requirement, constraint, or durable insight settles** (in chat or while coding): capture it immediately via the `brain` CLI. Do not wait to be asked and do not batch it for later.
- **Pure implementation with no new decision:** do not write to the brain.
- **When overturning a prior conclusion:** update the page (`update-truth` and/or `append-timeline` with `kind: reversal`, or `archive-page`).
- Only store what will still matter in six months and is hard to reconstruct from the code alone.
- All reads and writes go through the `brain` CLI — never hand-edit brain files.

The brain skills (`brain-setup`, `brain-page`, `brain-ingest`, `brain-bootstrap`) are installed in your global skills directory. Prefer `brain init` to scaffold a new project.
<!-- END brain.md -->
