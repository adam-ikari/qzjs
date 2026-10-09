---
title: Build Options
description: Complete reference of qzjs CMake options — QZ_WITH_* feature toggles and QZ_BUILD_* build targets.
---

# Build Options

qzjs's CMake options live on **two separate levels**: `QZ_WITH_*` toggles
**optional features** (native extensions layered on top of the runtime), while
`QZ_BUILD_*` controls what gets built (tests, examples, debugger). libuv is a
**hard dependency** — it is always built from the `deps/libuv` submodule and
there is no option to disable it. Defaults are sensible for a full-featured
Linux build.

## Feature Toggles (`QZ_WITH_*`)

These toggle optional native extensions on top of the WinterTC-compatible
runtime.

| Option | Default | Description |
|--------|---------|-------------|
| `QZ_WITH_TLS` | ON | mbedTLS for HTTPS. Forces `QZ_WITH_CRYPTO_EXT=ON` — a TLS client without `crypto.subtle` (no cert hashing, no WebCrypto key derivation) is not a complete WinterTC runtime. Disable to remove mbedTLS entirely. |
| `QZ_WITH_COMPRESS` | ON | miniz compression extension. Adds gzip/zlib/deflate to the JS API. |
| `QZ_WITH_CRYPTO_EXT` | ON | `crypto.subtle` extension: SHA-256/384/512, HMAC, PBKDF2, AES-GCM via mbedTLS. May be used without TLS (HTTP-only); required by `QZ_WITH_TLS`. When OFF, `crypto.subtle` is `undefined` (no JS fallback). |
| `QZ_WITH_TEXTCODEC` | ON | UTF-8 and Base64 TextEncoder/TextDecoder. |
| `QZ_WITH_NONUTF_ENCODINGS` | OFF | Enable non-UTF encoding labels (Latin-1, replacement) in TextDecoder. |
| `QZ_WITH_WAMR` | ON | WAMR WebAssembly engine (Fast Interpreter + AOT). Default WASM engine. |
| `QZ_WITH_WASM3` | OFF | wasm3 WebAssembly interpreter (alternative, more portable). |

**Note:** `QZ_WITH_WAMR` and `QZ_WITH_WASM3` are mutually exclusive — both register the `WebAssembly` global.

## Build Profiles (`QZ_PROFILE`)

`QZ_PROFILE` is a preset bundle of the `QZ_WITH_*` feature toggles. It
**only changes options not explicitly given** on the command line:
`-DQZ_PROFILE=minimal -DQZ_WITH_TLS=ON` keeps the explicit `TLS=ON`.
Empty (default) behaves bit-for-bit like the historical per-option defaults.
Any other value fails configure.

| Profile | Macro effect | qzjs size (stripped, measured) | ECMA-429 WinterTC |
|---------|--------------|-------------------------------|-------------------|
| `standard` (equivalent to empty) | Same as historical defaults: WAMR/TLS/COMPRESS/CRYPTO_EXT/TEXTCODEC=ON | Same as default build | ✅ full mandatory set met |
| `minimal` | Same as standard but **TLS=OFF** (fetch degrades to http-only; ECMA-429 has no HTTPS requirement) | **2.45 MiB** (Release/-O3); 1.81 MiB (MinSizeRel/-Os) | ✅ still met: atob/btoa, WebAssembly (WAMR), crypto.subtle, CompressionStream all present |

Re-running configure in the **same build directory** with a different
`QZ_PROFILE` recalculates the five `QZ_WITH_*` cache entries to the new
profile's defaults (status message `QZ_PROFILE changed: ...`). Explicit
`-DQZ_WITH_X` values do **not** survive a profile switch — prefer a fresh
build directory when mixing presets with explicit overrides.

## gRPC Stack (`QZ_WITH_GRPC`)

| Option | Default | Description |
|--------|---------|-------------|
| `QZ_WITH_GRPC` | OFF | Embed the gRPC/HTTP2 stack (h2 + HPACK + protobuf + grpc, ~3.5k lines JS) in the polyfill bundle. Needs npm + esbuild + qjsc (same prerequisites as the polyfill rebuild); warns and skips when the toolchain is missing. Manual path: `QZ_WITH_GRPC=1 node src/polyfill/build.js`. |

## Build Targets (`QZ_BUILD_*`)

| Option | Default | Description |
|--------|---------|-------------|
| `QZ_BUILD_TESTS` | OFF | Build the test suite. Enables FetchContent for GoogleTest. |
| `QZ_BUILD_EXAMPLES` | OFF | Build the examples in `examples/` (httpserver, grpc-hello, stream-pipeline, worker orchestration). |
| `QZ_BUILD_CLI` | ON | Build the `qzjs` CLI (`build/qzjs`, `build/qzjs-ctl`, `build/qzjs-rt`). |
| `QZ_BUILD_DEBUGGER` | OFF | Build the DAP step-debugger (adds `src/debugger.c` + `src/debugger_dap.c` to `libqzjs`). |

> **Note:** `QZ_BUILD_DEBUGGER` and `QZ_WITH_NONUTF_ENCODINGS` are gate-checked
> by the `QZ_WITH_*` feature matrix in CI — see `.github/workflows/ci.yml`.

## Common Configurations

### Development (full debug, all features)

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Debug \
      -DQZ_BUILD_TESTS=ON -DQZ_WITH_TLS=ON \
      -DQZ_WITH_COMPRESS=ON -DQZ_WITH_CRYPTO_EXT=ON \
      -DQZ_WITH_TEXTCODEC=ON -DQZ_WITH_WAMR=ON
```

### Minimal (embedded, no networking)

```bash
cmake -B build -DCMAKE_BUILD_TYPE=MinSizeRel \
      -DQZ_WITH_TLS=OFF -DQZ_WITH_COMPRESS=OFF \
      -DQZ_WITH_CRYPTO_EXT=OFF -DQZ_WITH_TEXTCODEC=OFF \
      -DQZ_WITH_WAMR=OFF
```

### Release (production, all features)

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release \
      -DQZ_WITH_TLS=ON -DQZ_WITH_COMPRESS=ON \
      -DQZ_WITH_CRYPTO_EXT=ON -DQZ_WITH_TEXTCODEC=ON \
      -DQZ_WITH_WAMR=ON
```

## Compiler Flags

qzjs and all dependencies compile under `-std=c99 -Wall -Wextra -Werror` (enforced via `qz_enable_warnings`).

### Suppressing Unused Parameter Warnings

Engine callbacks have fixed signatures that may include unused parameters. Use `QZ_UNUSED(x)`:

```c
#include <quickjs.h>
#include "qz_internal.h"   /* QZ_UNUSED 定义在此（内部头） */

static JSValue my_callback(JSContext *ctx, JSValue this_val,
                           int argc, JSValue *argv) {
    QZ_UNUSED(this_val);  // suppresses -Wunused-parameter
    return JS_UNDEFINED;
}
```

## Output

| File | Description |
|------|-------------|
| `build/lib/libqzjs.a` | Core runtime library (static, does not link libuv) |
| `build/lib/libqz_full.a` | Aggregator: qzjs + libuv + mbedTLS + miniz + WAMR + pthread/dl/rt |
| `build/test/test_*` | Test binaries (when `QZ_BUILD_TESTS=ON`) |
