#!/bin/bash
# in-module guest 异步回流 e2e (IN_MODULE_DESIGN.md §10.4 「import 拉」M5)
#
# 构建 qzvm-guest（wasm32-wasi reactor → libqzvm.wasm）并用 node WASI 宿主 shim
# 实例化驱动：宿主无 JSContext，仅按 ptr+len 搬字节；guest 持 resolve(JSValue)，
# 异步 fs 完成经 qz_host.drain 队列拉回。验证 §10.4 回流形态真机成立。
#
# 用法：bash test/test_inmodule_guest_e2e.sh [build-dir]
# 依赖：clang(-target wasm32-wasi) + wasi-libc + node
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
BUILD="${1:-$ROOT/build-inmod}"

fail() { echo "FAIL: $1"; exit 1; }

command -v node >/dev/null 2>&1 || fail "node not found"

# ── 构建 guest 产物（日志留在 build 目录内，不污染仓库根）──
mkdir -p "$BUILD"
cmake -S "$ROOT" -B "$BUILD" -DQZ_PROFILE=in-module \
      -DCMAKE_TOOLCHAIN_FILE="$ROOT/cmake/wasm32.cmake" \
      > "$BUILD/qz-guest.cfg.log" 2>&1 \
  || { cat "$BUILD/qz-guest.cfg.log"; fail "cmake configure"; }
cmake --build "$BUILD" --target qzvm-guest > "$BUILD/qz-guest.build.log" 2>&1 \
  || { cat "$BUILD/qz-guest.build.log"; fail "qzvm-guest build"; }

WASM="$(find "$BUILD" -name 'libqzvm.wasm' -print -quit)"
[ -n "$WASM" ] || fail "libqzvm.wasm not produced"
echo "guest artifact: $WASM"

# ── 驱动：node WASI shim 跑 3 个断言（成功/拒绝/并发）──
node "$DIR/inmodule-e2e/host.mjs" --wasm "$WASM" --data "$DIR/inmodule-e2e" \
  || fail "host shim"

echo "PASS: test_inmodule_guest_e2e"
