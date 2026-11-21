#!/bin/bash
# 堆硬上限（qz_config_t.memory_limit）的跨进程 e2e —— 跑真实 ISOLATED 构建下的
# test/mem_limit_e2e.c。
#
# 补的是静态门补不上的一段：config_propagation_check.py 只验字段**名**出现在
# rt_host.c（宿主组装 argv）与 rt_main.c（子进程还原）两侧，捕不到「argv 拼了但
# 子进程没解析」「解析了但没写进 config」。本 e2e 在真进程边界上做值级断言：
#   · memory_limit=64MiB → 256MiB 的 ArrayBuffer 必须失败于 out of memory
#   · 不设上限 → 同一表达式必须成功（负控：正例的失败确由上限导致）
#
# 第三道防漂移：本脚本断言的是**具体错误串** "out of memory"（引擎
# JS_ThrowOutOfMemory → JS_ThrowInternalError）。上游改了措辞就该在这里变红，
# 而不是变成一条永远匹配不上的空断言。
#
# Usage: bash test/test_mem_limit_e2e.sh <path-to-qzjs>
set -u
AM="${1:-./build/qzjs}"
BUILD_DIR="$(cd "$(dirname "$AM")" && pwd)"
BIN="$BUILD_DIR/mem_limit_e2e"

fail() { echo "FAIL: $1"; [ -n "${2:-}" ] && { echo "--- got:"; echo "$2"; }; exit 1; }

[ -x "$BIN" ] || fail "mem_limit_e2e not built at '$BIN'（需 ISOLATED + QZ_BUILD_TESTS=OFF 构建）"
[ -x "$BUILD_DIR/qzjs-rt" ] || fail "缺 qzjs-rt（$BUILD_DIR）——不是 ISOLATED 构建？"

# 防漂移：断言依赖的引擎错误串必须真的在引擎源码里。
grep -q 'JS_ThrowInternalError(ctx, "out of memory")' deps/quickjs-ng/quickjs.c \
  || fail "引擎不再用 'out of memory' 这个串——本 e2e 的断言已与引擎漂移"

OUT="$(cd "$BUILD_DIR" && QZ_RT_SERVER="$BUILD_DIR/qzjs-rt" timeout 120 ./mem_limit_e2e 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "mem_limit_e2e（正例 + 负控）" "$OUT"
echo "$OUT" | grep -q "穿 ISOLATED 进程边界生效" || fail "缺跨进程生效断言" "$OUT"
echo "$OUT"
