#!/bin/bash
# M-P6 host-pump contract e2e（ISOLATED 宿主契约翻转的直接覆盖门）。
# 跑真 libuv 构建（QZ_BUILD_TESTS=OFF）下的 C harness —— 它就是宿主：
# 自建 uv_loop 经 cfg.uv_loop 注入，断言 message_cb 跑在泵 loop 的线程、
# NULL loop 显式失败、属主线程 ping 不自死锁、洪泛 FIFO+spill 冲刷、
# wait_idle 后宿主 loop 干净可关、kill -9 主RT 的崩溃上报在 wait_idle
# 内触发、冻结主RT 的 destroy 在 terminate 预算内收束、pre-ready 帧于
# create 内重放且回发安全（H1）。
# Usage: bash test/test_mp5_host_pump_e2e.sh <path-to-qzjs>
set -u
AM="${1:-./build/qzjs}"
BUILD_DIR="$(cd "$(dirname "$AM")" && pwd)"
H="$BUILD_DIR/qz_mp5_host_pump_e2e"

fail() { echo "FAIL: $1"; [ -n "${2:-}" ] && { echo "--- got:"; echo "$2"; }; exit 1; }

[ -x "$H" ] || fail "harness not found at '$H'（需 ISOLATED + QZ_BUILD_TESTS=OFF 构建）"

RT_PID_COUNT() { pgrep -x qzjs-rt | wc -l; }

BEFORE="$(RT_PID_COUNT)"

# ── ② uv_loop=NULL → qz_create 显式失败 ──
OUT="$("$H" null 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "null mode (uv_loop=NULL 显式失败)" "$OUT"

# ── ①③④⑤ basic：cb 线程 / ping / 洪泛 FIFO / loop 干净关闭 ──
OUT="$("$H" basic 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "basic mode (cb 线程/ping/flood/wait_idle+loop_close)" "$OUT"
echo "$OUT" | grep -q "ok ①" || fail "basic 缺 ① cb 线程断言" "$OUT"
echo "$OUT" | grep -q "ok ③" || fail "basic 缺 ③ ping 断言" "$OUT"
echo "$OUT" | grep -q "ok ④" || fail "basic 缺 ④ flood 断言" "$OUT"
echo "$OUT" | grep -q "ok ⑤" || fail "basic 缺 ⑤ loop 干净关闭断言" "$OUT"

# ── ⑥ kill -9 主RT：wait_idle 内收 {"type":"error"} ──
OUT="$("$H" crash 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "crash mode (kill -9 → wait_idle 内崩溃上报)" "$OUT"

# ── ⑦ SIGSTOP 冻结主RT：destroy 在 terminate 预算内 ──
OUT="$("$H" hung 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "hung mode (冻结 destroy 预算)" "$OUT"

# ── ⑧ pre-ready 重放 + create 内回发 post_message（H1 守卫）──
OUT="$("$H" replay 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "replay mode (pre-ready 重放 + create 内回发)" "$OUT"
echo "$OUT" | grep -q "ok ⑧a" || fail "replay 缺 ⑧a create 内重放断言" "$OUT"
echo "$OUT" | grep -q "ok ⑧b" || fail "replay 缺 ⑧b create 内回发断言" "$OUT"

# ── 无残留 qzjs-rt（各模式 proc 回收 + reap 兜底）──
AFTER="$(RT_PID_COUNT)"
[ "$AFTER" -le "$BEFORE" ] || fail "leftover qzjs-rt after run (before=$BEFORE after=$AFTER)"

echo "PASS: M-P6 host-pump e2e — NULL-loop显式失败 / cb线程==泵线程 / ping不自死锁 / 2000帧FIFO+spill冲刷 / wait_idle后loop干净关闭 / kill-9崩溃上报在wait_idle内 / 冻结destroy预算内收束 / pre-ready重放+create内回发无崩溃 / 无残留主RT"
