#!/bin/bash
# M-P7 mailbox contract e2e（宿主主权翻转正后的直接覆盖门）。
# 跑真 ISOLATED 构建（QZ_BUILD_TESTS=OFF）下的 C harness —— 它就是宿主：
# 零回调、零 libuv，出站消息全部经 qz_recv_message 从 per-rt 邮箱消费。
# 断言面：属主线程 ping 免泵 / 2000 帧洪泛 FIFO+spill / wait_idle 后箱净 /
# kill -9 主RT 的错误帧在 wait_idle 后首 recv 即得（I4 时序门）/ SIGSTOP
# 冻结 destroy 预算 ≤6s（三级终止在库泵线程，I5②）/ pre-ready 帧首排干
# 即得 + 回发安全（H1 绊线）/ qz_message_fd 可读提示 + 三步协议终止性 +
# 丢唤醒免疫压力 / 双实例邮箱与 fd 独立互不串扰。
# Usage: bash test/test_mp7_mailbox_e2e.sh <path-to-qzjs>
set -u
AM="${1:-./build/qzjs}"
BUILD_DIR="$(cd "$(dirname "$AM")" && pwd)"
H="$BUILD_DIR/qz_mp7_mailbox_e2e"

fail() { echo "FAIL: $1"; [ -n "${2:-}" ] && { echo "--- got:"; echo "$2"; }; exit 1; }

[ -x "$H" ] || fail "harness not found at '$H'（需 ISOLATED + QZ_BUILD_TESTS=OFF 构建）"

RT_PID_COUNT() { pgrep -x qzjs-rt | wc -l; }

BEFORE="$(RT_PID_COUNT)"

# ── basic：ping 免泵 / 洪泛 FIFO / wait_idle 后箱净 ──
OUT="$("$H" basic 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "basic mode (ping/flood/箱净)" "$OUT"
echo "$OUT" | grep -q "ok ①" || fail "basic 缺 ① ping 免泵断言" "$OUT"
echo "$OUT" | grep -q "ok ②" || fail "basic 缺 ② flood 断言" "$OUT"
echo "$OUT" | grep -q "ok ③" || fail "basic 缺 ③ 箱净断言" "$OUT"
echo "$OUT" | grep -q "ok ④" || fail "basic 缺 ④ 漏排干 teardown 排干断言" "$OUT"

# ── crash：kill -9 主RT → wait_idle 返回后首 recv 即错误帧 ──
OUT="$("$H" crash 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "crash mode (错误帧 wait_idle 后可 recv)" "$OUT"

# ── hung：SIGSTOP 冻结主RT → destroy 墙钟预算（冻结在库线程）──
OUT="$("$H" hung 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "hung mode (冻结 destroy 预算)" "$OUT"

# ── replay：pre-ready 帧首排干即得 + create 内回发安全（H1）──
OUT="$("$H" replay 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "replay mode (pre-ready 入箱 + 回发)" "$OUT"
echo "$OUT" | grep -q "ok ⑥" || fail "replay 缺 ⑥ 组合断言" "$OUT"

# ── fd：可读提示 + 三步协议终止性 + 丢唤醒免疫压力 ──
OUT="$("$H" fd 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "fd mode (message_fd + 消费协议)" "$OUT"
echo "$OUT" | grep -q "ok ⑦a" || fail "fd 缺 ⑦a 可读提示断言" "$OUT"
echo "$OUT" | grep -q "ok ⑦b" || fail "fd 缺 ⑦b+⑦c 协议压力断言" "$OUT"

# ── dual：双实例邮箱/fd 独立 ──
OUT="$("$H" dual 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "dual mode (双实例邮箱独立)" "$OUT"
echo "$OUT" | grep -q "ok ⑧a" || fail "dual 缺 ⑧a fd 独立断言" "$OUT"
echo "$OUT" | grep -q "ok ⑧b" || fail "dual 缺 ⑧b 交错 FIFO 断言" "$OUT"

# ── 无残留 qzjs-rt（各模式 proc 回收 + reap 兜底）──
AFTER="$(RT_PID_COUNT)"
[ "$AFTER" -le "$BEFORE" ] || fail "leftover qzjs-rt after run (before=$BEFORE after=$AFTER)"

echo "PASS: M-P7 mailbox e2e — ping免泵 / 2000帧FIFO+spill / wait_idle后箱净 / kill-9错误帧wait_idle后首recv即得 / 冻结destroy预算内（库线程三级终止）/ pre-ready首排干即得+回发无崩溃 / fd可读提示+三步协议丢唤醒免疫 / 双实例邮箱fd独立 / 无残留主RT"
