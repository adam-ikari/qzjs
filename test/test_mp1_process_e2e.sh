#!/bin/bash
# M-P1 process-backend e2e (review I7) — exercises the real two-process path
# against the qzjs CLI (QZ_WORKER_BACKEND=process). Three phases:
#   1.  spawn → handshake → postMessage round-trip → graceful terminate (tier-1)
#   1b. >64KB payload round-trip — frame spans multiple pipe reads, so the
#       receiver must accumulate a partial frame (2018 regression guard: the
#       M-P4 frame-accumulator change dropped that check → heap corruption)
#   2.  hard SIGKILL the child mid-flight → parent survives (C2 MSG_NOSIGNAL)
#       → zombie reaped + slot released (I1) so a fresh Worker spawns → no
#       leftover temp script file (C1)
# Usage: bash test/test_mp1_process_e2e.sh <path-to-qzjs>
set -u
AM="${1:-./build_e2e/qzjs}"
DIR="$(cd "$(dirname "$0")/mp1-e2e" && pwd)"
export QZ_WORKER_BACKEND=process

# main-mp1*.js 内的 worker URL 是同仓绝对路径（历史遗留）——CI checkout 不在该
# 路径下，故按本仓根替换到临时副本再跑（fixture 本身不动）。
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT
for f in main-mp1.js main-mp1-big.js main-mp1-kill.js; do
  sed "s#file:///home/gem/project/qzjs#file://$ROOT#g" "$DIR/$f" > "$FIX/$f"
  grep -q "file://$ROOT/test/mp1-e2e/" "$FIX/$f" || { echo "FAIL: fixture path rewrite"; exit 1; }
done

if [ ! -x "$AM" ]; then
  echo "FAIL: qzjs binary not found at '$AM'"
  exit 1
fi

# Clean any stale temp files so the C1 leak check is meaningful.
# C1 泄漏检查的正是 worker 脚本临时文件：polyfill/worker.js ProcessWorker()
# 写 /tmp/qzjs-worker-<id>.js，子进程读后自 unlink；被杀则残留。
rm -f /tmp/qzjs-worker-*

# ── Phase 1: graceful round-trip + terminate ──
OUT1="$(timeout 20 "$AM" "$FIX/main-mp1.js" 2>&1)"
EXP1=$'echo:ping\nDONE'
if [ "$OUT1" != "$EXP1" ]; then
  echo "FAIL: phase 1 (graceful round-trip) output mismatch"
  diff <(printf '%s\n' "$EXP1") <(printf '%s\n' "$OUT1")
  exit 1
fi

# ── Phase 1b: >64KB payload round-trip (multi-read frame accumulation) ──
OUT1B="$(timeout 20 "$AM" "$FIX/main-mp1-big.js" 2>&1)"
EXP1B=$'big:131072:7:9\nDONE'
if [ "$OUT1B" != "$EXP1B" ]; then
  echo "FAIL: phase 1b (>64KB round-trip) output mismatch"
  diff <(printf '%s\n' "$EXP1B") <(printf '%s\n' "$OUT1B")
  exit 1
fi

# ── Phase 2: hard kill + respawn + no zombie / no temp leak ──
TMP="$(mktemp)"
setsid "$AM" "$FIX/main-mp1-kill.js" > "$TMP" 2>&1 &
PARENT=$!
# Wait for the worker to come up (READY) so the child exists to kill.
for i in $(seq 1 50); do
  grep -q '^READY$' "$TMP" 2>/dev/null && break
  sleep 0.1
done
# 按 argv 定位 worker 进程（`--qzjs-worker`）且限在本测试进程组内（setsid
# 后 PGID=PARENT；主RT 与 worker 同组，组内只有本测试的 qzjs-rt）——不再
# 用全机 pgrep -f 匹配，避免命中并行 e2e / 无关 qzjs-rt。
CHILD="$(pgrep -g "$PARENT" -f -- '--qzjs-worker' | head -1)"
if [ -z "$CHILD" ]; then
  echo "FAIL: phase 2 — no qzjs-rt child found under parent $PARENT"
  kill "$PARENT" 2>/dev/null
  wait "$PARENT" 2>/dev/null
  cat "$TMP"; rm -f "$TMP"
  exit 1
fi
kill -9 "$CHILD"      # tier-3 equivalent: unrecoverable death
wait "$PARENT"
RC=$?
OUT2="$(cat "$TMP")"; rm -f "$TMP"
EXP2=$'READY\nRESPAWNED\necho2:ping2\nDONE'
if [ "$OUT2" != "$EXP2" ]; then
  echo "FAIL: phase 2 (hard kill + respawn) output mismatch (rc=$RC)"
  diff <(printf '%s\n' "$EXP2") <(printf '%s\n' "$OUT2")
  exit 1
fi

# Zombie check (I1): the killed child must have been reaped — no qzjs-rt lingers.
if pgrep -g "$PARENT" qzjs-rt >/dev/null; then
  echo "FAIL: phase 2 — leftover qzjs-rt process (zombie not reaped)"
  pgrep -g "$PARENT" -af qzjs-rt
  exit 1
fi

# Temp-file leak check (C1): the child unlinks its script after reading.
if ls /tmp/qzjs-worker-* >/dev/null 2>&1; then
  echo "FAIL: temp script files leaked:"
  ls /tmp/qzjs-worker-*
  exit 1
fi

echo "PASS: M-P1 process-backend e2e — round-trip / >64KB round-trip / graceful-terminate / hard-kill-reap / no-temp-leak"
exit 0
