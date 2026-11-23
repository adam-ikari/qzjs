#!/bin/bash
# WAMR 源码级调试 e2e —— 定制 lldb 消费 DWARF，`b <file>.ts:N` 命中。
#
# 这是「DWARF 段被真实调试前端消费」的唯一端到端证明（RSP 偏移级断点见
# test_wamr_debug_rsp.sh；本脚本验证 lldb 从远端模块读 DWARF、按源码行号
# 解析出断点地址并命中）。lldb 非构建依赖：本脚本只在前置件齐备时跑。
#
# 前置（二选一，均非 repo 依赖）：
#   1) 预编译 WAMR lldb（推荐，免打补丁重编）：
#      https://github.com/bytecodealliance/wasm-micro-runtime/releases
#      资产名 wamr-lldb-<ver>-x86_64-ubuntu-<os>.tar.gz → 解压到 WAMR_LLDB_DIR
#   2) 自编：LLVM release/13.x + deps/wamr/build-scripts/lldb_wasm.patch
#
# 用法：bash test/test_wamr_debug_source.sh [build-dir] [lldb-dir]
#   lldb-dir 默认 $ROOT/.tools/wamr-lldb（含 bin/lldb、lib/）
# 缺少 lldb/debug 构建时：跳过（exit 0）并打印如何获取——不作为失败。
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
BUILD="${1:-$ROOT/build-dbg}"
LLDB_DIR="${2:-$ROOT/.tools/wamr-lldb}"
OUT="$ROOT/build/aot"
LINE_SPEC="strwork.ts:4"          # 断点行（strwork.ts L4 = for 循环体）

fail() { echo "FAIL: $1"; exit 1; }
skip() { echo "SKIP: $1"; exit 0; }

command -v node >/dev/null 2>&1 || fail "node not found"

[ -x "$LLDB_DIR/bin/lldb" ] || skip "prebuilt lldb not found at $LLDB_DIR/bin/lldb — \
下载 https://github.com/bytecodealliance/wasm-micro-runtime/releases 的 \
wamr-lldb-<ver>-x86_64-ubuntu-<os>.tar.gz 解压到 $LLDB_DIR"

# ── 1. debug-interp 版 qzjs（缺则跳过：源码级验证不阻塞默认流程）──
QZJS="$BUILD/qzjs"
if [ ! -x "$QZJS" ]; then
    mkdir -p "$BUILD"
    cmake -S "$ROOT" -B "$BUILD" -DQZ_WITH_WAMR=ON -DQZ_WITH_WAMR_DEBUG_INTERP=ON \
          -DQZ_BUILD_CLI=ON \
          > "$BUILD/qz-src.cfg.log" 2>&1 \
      || { cat "$BUILD/qz-src.cfg.log"; fail "cmake configure"; }
    # 可执行 target 是 qz_cli（OUTPUT_NAME qzjs）；`qzjs` 是静态库 target。
    cmake --build "$BUILD" --target qz_cli -j"$(nproc 2>/dev/null || echo 4)" \
          > "$BUILD/qz-src.build.log" 2>&1 \
      || { tail -40 "$BUILD/qz-src.build.log"; fail "qzjs debug build"; }
fi
[ -x "$QZJS" ] || fail "qzjs debug binary not found at $QZJS"

# ── 2. 编译被测模块（--debug 产 DWARF）+ 纯 wasm glue ──
mkdir -p "$OUT"
node "$ROOT/src/qzvm/aot/build.js" compile "$ROOT/src/qzvm/aot/strwork.ts" strw --debug \
      > /dev/null 2>&1 || fail "compile strw"
node "$ROOT/src/qzvm/aot/build.js" glue "$OUT/strw" --main "strWork(5)" --no-aot \
      > /dev/null 2>&1 || fail "glue strw (--no-aot)"

# ── 3. 起 qzjs（固定端口）+ lldb 连 GDB-RSP → 源码行断点 → 断言命中 ──
PORT=$(( (RANDOM % 2000) + 20000 ))
LOG="$(mktemp)"; ERR="$(mktemp)"; LLOG="$(mktemp)"
( cd "$OUT" && QZ_WAMR_DEBUG_PORT=$PORT "$QZJS" "$OUT/strw.glue.js" ) > "$LOG" 2> "$ERR" &
QZJS_PID=$!
cleanup() { kill -9 "$QZJS_PID" 2>/dev/null; rm -f "$LOG" "$ERR" "$LLOG"; }
trap cleanup EXIT

for _ in $(seq 1 40); do
    grep -q "listening on port" "$ERR" 2>/dev/null && break
    sleep 0.25
done
grep -q "listening on port" "$ERR" || { cat "$ERR"; fail "debug server did not start"; }

LD_LIBRARY_PATH="$LLDB_DIR/lib:${LD_LIBRARY_PATH:-}" timeout 60 \
    "$LLDB_DIR/bin/lldb" \
    -o "process connect -p wasm connect://127.0.0.1:$PORT" \
    -o "b $LINE_SPEC" -o c -o "bt" -o q > "$LLOG" 2>&1
RC=$?

grep -q "stop reason = breakpoint" "$LLOG" || {
    echo "--- lldb output ---"; cat "$LLOG"
    echo "--- qzjs stdout ---"; cat "$LOG"
    fail "源码级断点未命中（rc=$RC）"; }

echo "PASS: test_wamr_debug_source（lldb 'b $LINE_SPEC' → stop reason = breakpoint）"
grep -E "Breakpoint 1:.*address =|stop reason = breakpoint" "$LLOG"
