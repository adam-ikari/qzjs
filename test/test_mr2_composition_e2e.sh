#!/bin/bash
# M-R2 组合模型 PROCESS 后端 e2e（§14.3）：在**真实进程 worker** 上回归
# 「contexts ×N 与 workers ×N 正交并存」——ctx suspend/resume/destroy 与 worker
# postMessage 交错，无死锁、消息一条不丢、两轴结果都对；worker 归 rt（terminate
# 后优雅退出，不留残留子进程）。
#
# THREAD 基线（mock 离线确定性）见 test/test_context_worker_composition_gtest.cpp；
# 本脚本是 §14.3「M-P1 合入后同场景以进程后端回归」的落地。
# Usage: bash test/test_mr2_composition_e2e.sh <path-to-qzjs>
set -u
AM="${1:-./build_e2e/qzjs}"
DIR="$(cd "$(dirname "$0")/mr2-e2e" && pwd)"
export QZ_WORKER_BACKEND=process

# fixture 内的 worker URL 是同仓绝对路径（与 mp1-e2e 同约定）——CI checkout 不在
# 该路径下，故按本仓根替换到临时副本再跑（fixture 本身不动）。
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIX="$(mktemp -d)"
STATE=/tmp/qzjs-mr2-state.bin
trap 'rm -rf "$FIX"; rm -f "$STATE"' EXIT
sed "s#file:///home/gem/project/qzjs#file://$ROOT#g" \
    "$DIR/main-mr2-composition.js" > "$FIX/main-mr2-composition.js"
grep -q "file://$ROOT/test/mr2-e2e/" "$FIX/main-mr2-composition.js" \
  || { echo "FAIL: fixture path rewrite"; exit 1; }

if [ ! -x "$AM" ]; then
  echo "FAIL: qzjs binary not found at '$AM'"
  exit 1
fi

rm -f "$STATE"
# setsid 后台起（拿到进程组号），后续 worker 残留校验限本组，不用全机 pgrep -f。
setsid timeout 30 "$AM" "$FIX/main-mr2-composition.js" > "$FIX/mr2.out" 2>&1 &
P1=$!
wait "$P1"; RC=$?
OUT="$(cat "$FIX/mr2.out")"
EXP=$'echoes:6\nDONE'
if [ "$OUT" != "$EXP" ]; then
  echo "FAIL: composition e2e output mismatch (rc=$RC)"
  diff <(printf '%s\n' "$EXP") <(printf '%s\n' "$OUT")
  exit 1
fi

# 挂起状态确实落盘：suspend 真跑了（不是被静默跳过）
if [ ! -s "$STATE" ]; then
  echo "FAIL: suspend state file missing/empty ($STATE)"
  exit 1
fi

# 无残留进程 worker：两个 worker 都已 terminate 并被回收（给优雅退出留 2s）
for _ in $(seq 1 20); do
  pgrep -g "$P1" -f -- '--qzjs-worker' >/dev/null || break
  sleep 0.1
done
if pgrep -g "$P1" -f -- '--qzjs-worker' >/dev/null; then
  echo "FAIL: leftover process worker (not reaped)"
  pgrep -g "$P1" -af -- '--qzjs-worker'
  exit 1
fi

echo "PASS: M-R2 composition e2e (PROCESS backend) — ctx suspend/resume/destroy interleaved with worker messages"
exit 0
