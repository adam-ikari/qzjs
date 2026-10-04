---
title: Building
description: CMake build options for qzjs — feature toggles, C99 toolchain, and example configurations for development and production.
---

# Building

qzjs uses CMake with feature toggles. All dependencies are built from source — no system packages required.

::: warning Platform support
**qzjs supports Linux only.** macOS, Windows, and the BSDs are out of scope —
not "not yet ported". The library uses Linux-specific primitives throughout:
`eventfd` (`qz_message_fd`), `AF_UNIX` endpoints with `SO_PEERCRED`, and an
explicit `UV_USE_IO_URING=0` (io_uring_setup can break futex/pthread_cond
wakeups on some kernels, hanging `cond_wait` forever). Building elsewhere is
unsupported and will fail in ways that are not documented here.
:::

## Basic Build

`make` is the command entry point — it wraps CMake/Ninja:

```bash
make build          # configure + build Release with examples → build/qzjs qzc qzjs-rt
make qzjs ARGS='-e "console.log(1)"'   # run the CLI
make qzc SRC=app.js [OUT=app.bc]       # compile JS to bytecode
make bc SRC=app.js [ARGS='a b']        # compile + run bytecode
make example NAME=fs                   # run an example
make test-offline                      # build + run offline tests
make docs                              # build the website
make clean
```

Raw CMake is equivalent and documented below for every option:

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

Build types: `Release` (optimized), `Debug` (with symbols and assertions), `RelWithDebInfo`, `MinSizeRel`.

## CMake Options

### Feature Toggles (`QZ_WITH_*`)

| Option | Default | Description |
|--------|---------|-------------|
| `QZ_WITH_TLS` | ON | mbedTLS for HTTPS and crypto primitives |
| `QZ_WITH_COMPRESS` | ON | miniz compression/decompression extension |
| `QZ_WITH_CRYPTO_EXT` | ON | `crypto.subtle` (SHA, HMAC, PBKDF2, AES-GCM) |
| `QZ_WITH_TEXTCODEC` | ON | UTF-8 / Base64 encoder/decoder |
| `QZ_WITH_WAMR` | ON | WAMR WebAssembly engine (Fast Interp + AOT, default) |
| `QZ_WITH_WASM3` | OFF | wasm3 WebAssembly engine (alternative, lighter weight) |

**Note:** `QZ_WITH_WAMR` and `QZ_WITH_WASM3` are mutually exclusive — only one WASM engine can be enabled at a time.

### Build Targets

| Option | Default | Description |
|--------|---------|-------------|
| `QZ_BUILD_TESTS` | OFF | Build test suite (25 test targets) |
| `QZ_BUILD_EXAMPLES` | OFF | Build examples in `examples/` |
| `QZ_BUILD_CLI` | ON | Build the `qzjs` CLI plus the `qzjs-rt` worker and `qzjs-ctl` control-plane binaries |
| `QZ_PROCESS_MODEL` | ISOLATED | `THREAD` (single-process multi-thread) or `ISOLATED` (dedicated child processes, default) |

## Example Configurations

### Minimal (WinterTC still met)

```bash
cmake -B build -DQZ_PROFILE=minimal
cmake --build build -j$(nproc)
```

`minimal` keeps WebAssembly, `crypto.subtle`, `atob`/`btoa`, and compression
(2.45 MiB stripped, Release) — the smallest profile that satisfies the full
WinterTC mandatory set. See [Build Options](/guide/build-options) for the
profile table and the `QZ_WITH_GRPC` CMake option.

### Full Development Build

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Debug \
      -DQZ_BUILD_TESTS=ON
cmake --build build -j$(nproc)
cd build && ctest --output-on-failure
```

Full option reference including build profiles (`QZ_PROFILE`) and the gRPC
stack (`QZ_WITH_GRPC`): [Build Options](/guide/build-options).

### wasm3 Alternative Engine

```bash
cmake -B build -DQZ_WITH_WAMR=OFF -DQZ_WITH_WASM3=ON
cmake --build build -j$(nproc)
```

## C Standard Isolation

qzjs and all its dependencies build under **strict C99** (`-std=c99`).

## Output Artifacts

| Artifact | Path |
|----------|------|
| `libqzjs.a` | `build/` (static core — deliberately does not link libuv; uv symbols resolve at the final executable) |
| `libqz_full.a` | `build/` (CMake link-interface aggregator: qzjs + libuv + mbedTLS + miniz + WAMR + pthread/dl/rt) |
| `qzjs.pc` | `build/` (pkg-config — `pkg-config --cflags --libs qzjs` lists every vendored archive) |
| Test binaries | `build/test/` |
| `qzjs` | `build/` (CLI — `qzjs -e 'console.log(1)'`) |
| `qzjs-rt` | `build/` (worker-process binary, worker-process binary) |
| `qzjs-ctl` | `build/` (control-plane endpoint client) |

