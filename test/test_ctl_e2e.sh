#!/bin/bash
# CTL-1 / CTL-2 e2e — 控制面本地端点 + 跨进程树路由（control-plane-design §6）。
#
# 覆盖：
#   1. LOCAL 端点：qzjs-ctl 连运行中 qzjs（ISOLATED，宿主→主RT）→ 四命令往返
#      （eval / inspect / metrics / interrupt），回执 correl 与请求配对。
#   2. 树路由到 worker（宿主 → 主RT → worker 槽位）：--target <worker 槽位 id>
#      的命令确实在 worker runtime 上执行（用「worker 设的全局在主RT 不可见」
#      证明），并回读同一标记；worker 的 metrics 与主RT 不同。
#      —— 这一条同时验证「宿主视角 target = 主RT 子槽位 id」的映射无偏移：
#      worker 进程的 --worker-id 就是父侧 spawn 登记的子槽位 id（polyfill
#      worker.js 的 procWorkerSeq 从 1000 起，单 worker 场景 = 1001）。
#   3. 无对应槽位的 target → NOT_FOUND 回执（不留无应答）。
#   4. OFF 档恒拒：control_plane=off 不暴露端点，连接失败。
#
# Usage: bash test/test_ctl_e2e.sh [path-to-qzjs] [path-to-qzjs-ctl]
set -u
AM="${1:-./build/qzjs}"
QZCTL="${2:-./build/qzjs-ctl}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"

for bin in "$AM" "$QZCTL"; do
  [ -x "$bin" ] || { echo "FAIL: binary not found: $bin"; exit 1; }
done

FIX="$(mktemp -d)"
SOCK="$FIX/ctl.sock"
QPID=""
cleanup() {
  # setsid 起的所有 qzjs（宿主 → 主RT → worker 树）同处一个进程组，QPID 即
  # 组号。组杀收敛：只碰本测试的进程，不再用 pkill -f 全局匹配（避免误杀
  # 并行跑的其它 e2e / 无关 qzjs-rt）。
  [ -n "$QPID" ] && kill -TERM -- -"$QPID" 2>/dev/null
  sleep 0.3
  [ -n "$QPID" ] && kill -KILL -- -"$QPID" 2>/dev/null
  rm -rf "$FIX"
}
trap cleanup EXIT

fail() { echo "FAIL: $1"; [ -n "${2:-}" ] && { echo "--- got:"; printf '%s\n' "$2"; }; exit 1; }

WORKER_ID=1001   # 单 worker：procWorkerSeq(1000) 的第一次 ++ —— 见文件头说明

# ── 起一个 ISOLATED 运行中 qzjs：主RT 跑脚本并 spawn 一个 PROCESS worker ──
setsid "$AM" --control-plane=local --control-pipe="$SOCK" -e "
var w = new Worker('file://$ROOT/test/mp1-e2e/worker_echo.js');
setInterval(function(){}, 100);
" > "$FIX/qzjs.out" 2>&1 &
QPID=$!

for _ in $(seq 1 50); do [ -S "$SOCK" ] && break; sleep 0.1; done
[ -S "$SOCK" ] || fail "1 endpoint socket not created" "$(cat "$FIX/qzjs.out")"

ctl() { timeout 10 "$QZCTL" --pipe "$SOCK" "$@"; }

# ── 1: 四命令往返 + correl 配对 ──
OUT="$(ctl --correl e2e-eval eval '1+1')" || fail "1 eval rc" "$OUT"
echo "$OUT" | grep -q '"correl":"e2e-eval"' || fail "1 eval correl pairing" "$OUT"
echo "$OUT" | grep -q '"result":2' || fail "1 eval result" "$OUT"

OUT="$(ctl --correl e2e-inspect inspect '({a:1,b:[2,3]})')" || fail "1 inspect rc" "$OUT"
echo "$OUT" | grep -q '"correl":"e2e-inspect"' || fail "1 inspect correl" "$OUT"
echo "$OUT" | grep -qF '"json":"{\"a\":1,\"b\":[2,3]}"' || fail "1 inspect json" "$OUT"

OUT="$(ctl --correl e2e-metrics metrics)" || fail "1 metrics rc" "$OUT"
echo "$OUT" | grep -q '"correl":"e2e-metrics"' || fail "1 metrics correl" "$OUT"
echo "$OUT" | grep -q '"heap_bytes":' || fail "1 metrics fields" "$OUT"

OUT="$(ctl --correl e2e-int interrupt)" || fail "1 interrupt rc" "$OUT"
echo "$OUT" | grep -q '"interrupted":true' || fail "1 interrupt receipt" "$OUT"

# ── 2: 树路由到 worker（target = 主RT 子槽位 id） ──
OUT="$(ctl --correl e2e-wr --target "$WORKER_ID" eval 'globalThis.__ctlE2e = "worker"; "set"')" \
  || fail "2 worker eval rc" "$OUT"
echo "$OUT" | grep -q '"ok":true' || fail "2 worker eval receipt" "$OUT"

# worker 上设的全局在主RT 不可见（证明命令真的落在 worker runtime 上，
# 而不是被主RT 本地执行 —— 即 target 映射无偏移）。
OUT="$(ctl --correl e2e-main-read eval 'globalThis.__ctlE2e === undefined ? "absent" : "leaked"')" \
  || fail "2 mainRT read rc" "$OUT"
echo "$OUT" | grep -q '"result":"absent"' || fail "2 worker/mainRT isolation" "$OUT"

# worker 自己能读回该标记。
OUT="$(ctl --correl e2e-wr-read --target "$WORKER_ID" eval 'globalThis.__ctlE2e')" \
  || fail "2 worker read rc" "$OUT"
echo "$OUT" | grep -q '"result":"worker"' || fail "2 worker readback" "$OUT"

# worker 的 metrics 与主RT 不同（不同 runtime）。
WOUT="$(ctl --target "$WORKER_ID" metrics)" || fail "2 worker metrics rc" "$WOUT"
MOUT="$(ctl metrics)" || fail "2 mainRT metrics rc" "$MOUT"
WH="$(printf '%s' "$WOUT" | sed -n 's/.*"heap_bytes":\([0-9]*\).*/\1/p')"
MH="$(printf '%s' "$MOUT" | sed -n 's/.*"heap_bytes":\([0-9]*\).*/\1/p')"
[ -n "$WH" ] && [ -n "$MH" ] || fail "2 metrics parse" "w=$WOUT m=$MOUT"
[ "$WH" != "$MH" ] || fail "2 worker metrics identical to mainRT (no routing?)" "$WOUT"

# ── 3: 无对应槽位 → NOT_FOUND（不留无应答） ──
OUT="$(ctl --target 9999 metrics)"   # rc=1（ok:false）：回执本身必须到
echo "$OUT" | grep -q '"code":"NOT_FOUND"' || fail "3 unknown target receipt" "$OUT"

# ── 4: OFF 档恒拒（无端点） ──
kill -TERM -- -"$QPID" 2>/dev/null; wait "$QPID" 2>/dev/null; QPID=""
rm -f "$FIX/off.sock"
setsid "$AM" --control-plane=off --control-pipe="$FIX/off.sock" \
  -e 'setInterval(function(){}, 100)' > "$FIX/off.out" 2>&1 &
QPID=$!
sleep 1.5
if [ -S "$FIX/off.sock" ]; then
  fail "4 OFF tier must not expose an endpoint"
fi
if timeout 5 "$QZCTL" --pipe "$FIX/off.sock" metrics >/dev/null 2>&1; then
  fail "4 OFF tier connect must fail"
fi

# ── 5: DAP 并存（§2.3「与 DAP 并存规则」） ──
# DAP 在 runtime_init 内 attach 并阻塞到 configuration；端点必须在此之前建立，
# 否则调试会话期间控制面完全不可用。旧顺序（端点在 runtime_init 之后）在这里
# 会失败——该断言即回归护栏。DAP 暂停期间控制命令按 timeout_ms 作废（§2.3
# 明示），故此处只验证两通道并存、互不抢占。
kill -TERM -- -"$QPID" 2>/dev/null; wait "$QPID" 2>/dev/null; QPID=""
rm -f "$FIX/dap.in" "$FIX/dap.sock"
mkfifo "$FIX/dap.in"
QZ_DEBUG=1 setsid "$AM" --control-plane=local --control-pipe="$FIX/dap.sock" \
  -e 'setInterval(function(){}, 100)' < "$FIX/dap.in" > "$FIX/dap.out" 2>&1 &
QPID=$!
exec 9> "$FIX/dap.in"      # 保持 DAP stdin 打开，会话不因 EOF 结束
for _ in $(seq 1 50); do [ -S "$FIX/dap.sock" ] && break; sleep 0.1; done
if [ ! -S "$FIX/dap.sock" ]; then
  fail "5 endpoint missing while DAP attaches" "$(cat "$FIX/dap.out")"
fi
if grep -q "Content-Length" "$FIX/dap.out" 2>/dev/null; then
  echo "       (5) DAP session active + control endpoint present"
else
  echo "       (5) no DAP output (build without QZ_DEBUG_SUPPORT?); endpoint present"
fi
exec 9>&-
kill -TERM -- -"$QPID" 2>/dev/null; wait "$QPID" 2>/dev/null; QPID=""

echo "PASS: CTL-1/CTL-2 control-plane e2e — endpoint 4 commands + correl pairing / tree routing to worker (target=$WORKER_ID, isolation + no id skew) / NOT_FOUND / OFF tier refused / DAP coexist"
