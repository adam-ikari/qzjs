# Testing

qzjs has a comprehensive multi-layer test suite.

## Test Layers

| Layer | Runner | Coverage | Command |
|-------|--------|----------|---------|
| **Offline** | gtest + ctest | Core runtime, extensions, WASM | `ctest -L offline` |
| **WinterTC** | gtest | Web APIs (URL/URLPattern/FormData/Event/Blob/console/...) | `ctest -L offline` (`test_polyfill_gtest` etc.) |
| **test262** | ctest | ECMAScript language conformance | `ctest -L test262` |
| **DAP** | ctest | Debugger protocol | `ctest -L dap` |
| **e2e** | shell / python / mjs | HTTPServer, multi-process, control plane, Service Worker, gRPC — real libuv, not mocked | see the `e2e` job in `.github/workflows/ci.yml` |

> The old `wpt_runner` (vendored WPT `.any.js` files) was removed in the
> libuv-native refactor (mock-PAL gone). WinterTC Web API coverage now lives
> in the offline gtest suites (`test_polyfill_gtest` etc.); the vendored
> `test/wpt/` files remain for reference.

## Quick Run

```bash
# Configure with tests
cmake -B build -DCMAKE_BUILD_TYPE=Debug -DQZ_BUILD_TESTS=ON
cmake --build build -j$(nproc)

# All offline tests (includes WinterTC Web API gtest suites)
cd build && ctest -L offline --output-on-failure

# test262 ECMAScript conformance
cd build && ctest -R test262
```

## Test Labels

| Label | Description |
|-------|-------------|
| `offline` | Local, deterministic — CI default |
| `dap` | Debugger protocol tests (needs `-DQZ_BUILD_DEBUGGER=ON`) |
| `test262` | ECMAScript language conformance (needs the corpus) |

These three are all that exist — check what a given build actually
registered rather than trusting a written-down list:

```bash
ctest --print-labels   # labels in this build
ctest -N               # test names in this build
```

> Historical note: `network`, `benchmark` and `wpt` labels appeared in
> earlier drafts of this page but were never registered. Network and
> performance coverage lives in CI as shell/python/mjs e2e and benchmark
> jobs; WPT was removed (see below).

## Current Results

Run the suite to get them — counts change with the `QZ_*` options a build
was configured with, so a hand-maintained table goes stale immediately:

```bash
cd build
ctest -L offline --output-on-failure
ctest -N -L offline | tail -1     # how many tests this build registers
```

¹ WASM streaming 3 用例来自 `test/test_wasm_streaming_gtest.cpp`：compileStreaming/instantiateStreaming 语义等价实现 + 非法 source 拒绝。
² CLI end-to-end 来自 `test/test_cli_gtest.cpp`（fork 真实 qzjs 可执行文件，断言 stdout/stderr/退出码）。
³ HTTPServer e2e 来自 `test/test_httpserver_e2e.py`（真实 libuv 构建 + 纯 JS serve() listener）。

## Coverage Scope — Uncovered-by-Design

The gtest + coverage gate builds with `-DQZ_BUILD_TESTS=ON`, which compiles
the core against `mock_libuv` (an in-process libuv fake). Modules that bind
to **real** libuv primitives (`uv_pipe`, `SO_PEERCRED`, real sockets, the
`qzjs-rt`/`qzjs-ctl` executables) are therefore **excluded from the gtest
and gcov denominator** — they link only in the `QZ_BUILD_TESTS=OFF`
(real-libuv) build, and are covered exclusively by e2e:

| Module | File | Why mocked out | Real coverage |
|---|---|---|---|
| IPC process channel | `src/ipc_process.c` | real `uv_pipe` | e2e (`test_mp*_e2e.sh`, `test_ctl_e2e.sh`) |
| CTL-2 local endpoint | `src/control_endpoint.c` | `uv_pipe` + `SO_PEERCRED` | e2e (`test_ctl_e2e.sh`) |
| Host↔main-RT process split | `src/rt_host.c` | fork+exec of `qzjs-rt` | e2e (`test_mp2_host_split_e2e.sh`) |
| TCP I/O | `src/tcp_io.c` | real sockets | e2e (HTTPServer, WS, gRPC suites) |
| Main RT entrypoint | `src/rt_main.c` (`qzjs-rt`) | standalone executable | e2e (every ISOLATED run) |
| CTL CLI entrypoint | `src/ctl_cli.c` (`qzjs-ctl`) | standalone executable | e2e (`test_ctl_e2e.sh`) |

This is intentional, not a gap: the mock PAL cannot exercise process
isolation, real IPC, or live sockets — those semantics are asserted by e2e
under ASan+LSan (the `asan`/`ubsan` jobs' real-ISOLATED builds and the `e2e`
job). The gcov 50% gate thus measures the mock-testable surface; the
multi-process layer is gated by e2e green, not by line coverage.

## Memory Safety

All offline tests pass under AddressSanitizer with leak detection
(`ASAN_OPTIONS=detect_leaks=1`) and UndefinedBehaviorSanitizer (UBSan).
Valgrind confirms zero bytes definitely lost.

## Writing Tests

Tests use GoogleTest (C++), linked against `qzjs` + `mock_libuv` — a
deterministic in-process fake of the libuv API (see `test/mock_libuv.{c,h}`) —
and are built with `-DQZ_USE_MOCK_LIBUV`. Tests drive the runtime through
the `HostCtx` harness in `test/test_host.h`: `host_create` starts a qzjs
runtime and installs a bootstrap `onmessage` command channel
(`{cmd:'eval'}`, `{cmd:'echo'}`); `host_eval`/`host_value` evaluate JS and
return the result; `host_poll_until_value` polls until an async condition
(timer, promise, storage) is met.

```cpp
#include <qzjs/qzjs.h>
#include "test_host.h"   // HostCtx harness + mock_libuv
#include <gtest/gtest.h>

class MyTest : public ::testing::Test {
protected:
    HostCtx *h = nullptr;

    void SetUp() override {
        h = host_create();       // starts a runtime + test bootstrap
        ASSERT_NE(nullptr, h);
    }

    void TearDown() override { host_destroy(h); }
};

TEST_F(MyTest, EvalExpression) {
    std::string out;
    ASSERT_TRUE(host_value(h, "1 + 1", &out));
    EXPECT_EQ(out, "2");
}

TEST_F(MyTest, AsyncTimer) {
    host_eval(h, "setTimeout(() => { globalThis.flag = 'fired'; }, 100);");
    std::string out;
    EXPECT_TRUE(host_poll_until_value(h, "globalThis.flag", "fired", &out));
}
```
