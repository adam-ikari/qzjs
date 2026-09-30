#!/bin/bash
# 嵌套 spawn e2e（§1.1 树形拓扑 / §8.2 path 链路由 / CTL-1 path 扩展）。
#
# 覆盖：
#   1. worker 进程内 new Worker → 孙 worker 进程：三级进程树（PID 证据，
#      父子关系 host→主RT→worker→孙）+ postMessage 往返（能力打通 N-P1）。
#   2. §8.2 port path 路由：port 经 worker 再转移给孙，main↔孙 跨两级往返
#      （中继节点按路由表「改指转发」，payload 不解码）。
#   3. CTL 到孙：--target-path <k1,k2> 的命令在孙 runtime 上执行（用「孙设的
#      全局在主RT / worker 都不可见」证明驻留点），回执沿树回程配对。
#
# Usage: bash test/test_nested_e2e.sh [path-to-qzjs] [path-to-qzjs-ctl]
set -u
AM="${1:-./build/qzjs}"
QZCTL="${2:-./build/qzjs-ctl}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
FIXI="$DIR/nested-e2e"

for bin in "$AM" "$QZCTL"; do
  [ -x "$bin" ] || { echo "FAIL: binary not found: $bin"; exit 1; }
done

FIX="$(mktemp -d)"
QPID=""
# 所有 setsid 起的 qzjs 宿主进程登记到此（各即进程组号）：cleanup 组杀只碰
# 本测试的组，不再用 pkill -f 全机匹配（避免误杀并行 e2e / 无关 qzjs-rt）。
# qzjs 子进程（mainRT/worker/孙）不自行 setsid，留在宿主组内，组杀全覆盖。
# 注意：数组名不可用 GROUPS —— 那是 bash 特殊变量（当前用户组列表），赋值/追加
# 会失败，在 set -u 下让 mark_group 中止函数、连带 start_tree 提前退出。
HOST_PIDS=()
mark_group() { [ -n "$1" ] && HOST_PIDS+=("$1"); }
cleanup() {
  local g
  for g in "${HOST_PIDS[@]:-}"; do
    [ -n "$g" ] && kill -KILL -- -"$g" 2>/dev/null
  done
  rm -rf "$FIX"
}
trap cleanup EXIT
fail() { echo "FAIL: $1"; [ -n "${2:-}" ] && { echo "--- got:"; printf '%s\n' "$2"; }; exit 1; }

# fixture 里的 worker URL 是仓内绝对路径（历史写法，与 mp1/mp4 fixture 同风格）
# —— 全部副本统一重写到 $FIX（fixture 之间的相互引用也须落在同一目录，否则
# CI checkout 下 worker 会去读本地开发路径）。
NESTED_FIXTURES="main-nested.js main-nested-port.js main-nested-storage.js \
main-nested-cascade.js worker_spawn_child.js worker_grand_echo.js \
worker_port_relay.js worker_grand_port_echo.js worker_spawn_child_storage.js \
worker_grand_storage.js worker_spawn_child_hold.js"
for f in $NESTED_FIXTURES; do
  sed "s#file:///home/gem/project/qzjs/test/nested-e2e#file://$FIX#g" "$FIXI/$f" > "$FIX/$f"
done
# 自检：副本里不得再残留开发机绝对路径（CI checkout 下会变成致命误路由）。
if grep -l "file:///home/gem/project/qzjs" "$FIX"/*.js > /dev/null 2>&1; then
  fail "fixture 重写不完整（仍有开发机绝对路径）" \
       "$(grep -l 'file:///home/gem/project/qzjs' "$FIX"/*.js)"
fi

export QZ_WORKER_BACKEND=process
rm -f /tmp/qzjs-rt-script-*

# ── 1: 孙 worker 进程能力 + 三级 PID + 往返 ──
OUT="$(timeout 30 "$AM" "$FIX/main-nested.js" 2>&1)" || fail "1 nested run rc" "$OUT"
EXP=$'nested:child-grand:ping\nDONE'
[ "$OUT" = "$EXP" ] || fail "1 nested spawn round-trip" "$OUT"

# PID 证据：跑一个 spawn 孙但不退出的脚本，检查三级父子链。
setsid "$AM" "$FIX/main-nested-cascade.js" > "$FIX/hold.out" 2>&1 &
HPID=$!
mark_group "$HPID"
for _ in $(seq 1 50); do grep -q READY "$FIX/hold.out" 2>/dev/null && break; sleep 0.1; done
sleep 0.6
MAINRT="$(pgrep -P "$HPID" -f 'qzjs-rt' 2>/dev/null | head -1)"
[ -n "$MAINRT" ] || fail "1 no mainRT child of host $HPID" "$(cat "$FIX/hold.out")"
WORKER="$(pgrep -P "$MAINRT" 2>/dev/null | head -1)"
[ -n "$WORKER" ] || fail "1 no worker child of mainRT $MAINRT" "$(cat "$FIX/hold.out")"
GRAND="$(pgrep -P "$WORKER" 2>/dev/null | head -1)"
[ -n "$GRAND" ] || fail "1 no grandchild child of worker $WORKER" "$(cat "$FIX/hold.out")"
[ "$MAINRT" != "$WORKER" ] && [ "$WORKER" != "$GRAND" ] && [ "$MAINRT" != "$GRAND" ] \
  || fail "1 three distinct PIDs (host=$HPID mainRT=$MAINRT worker=$WORKER grand=$GRAND)"
kill -TERM "$HPID" 2>/dev/null
sleep 0.5

# ── 2: §8.2 port path 路由（跨两级经 LCA + 改指转发）──
OUT="$(timeout 30 "$AM" "$FIX/main-nested-port.js" 2>&1)" || fail "2 nested port rc" "$OUT"
EXP2=$'G2M:echo:hello\nDONE'
[ "$OUT" = "$EXP2" ] || fail "2 nested MessagePort two-level round-trip" "$OUT"
kill -TERM "$HPID" 2>/dev/null
for _ in $(seq 1 60); do kill -0 "$HPID" 2>/dev/null || break; sleep 0.1; done
SOCK="$FIX/ctl.sock"
setsid "$AM" --control-plane=local --control-pipe="$SOCK" -e "
var w = new Worker('file://$FIX/worker_spawn_child_hold.js');
setInterval(function(){}, 100);
" > "$FIX/q.out" 2>&1 &
QPID=$!
mark_group "$QPID"
for _ in $(seq 1 50); do [ -S "$SOCK" ] && break; sleep 0.1; done

[ -S "$SOCK" ] || fail "3 endpoint socket not created" "$(cat "$FIX/q.out")"
ctl() { timeout 10 "$QZCTL" --pipe "$SOCK" "$@"; }

# 孙的 path = [主RT 给 worker 的槽位, worker 给孙的槽位] = 1001,1001（见 worker.js procWorkerSeq）。
OUT="$(ctl --correl n-set --target-path 1001,1001 eval "(function(){ globalThis.__GRAND__=42; return 'set-ok'; })()")" \
  || fail "3 eval on grandchild rc" "$OUT"
echo "$OUT" | grep -q '"correl":"n-set"' || fail "3 grandchild receipt correl" "$OUT"
echo "$OUT" | grep -q '"result":"set-ok"' || fail "3 grandchild eval executed" "$OUT"
OUT="$(ctl --target-path 1001,1001 eval "'grand:' + globalThis.__GRAND__")" \
  || fail "3 grandchild readback rc" "$OUT"
echo "$OUT" | grep -q '"result":"grand:42"' || fail "3 grandchild readback" "$OUT"
OUT="$(ctl eval "'mainrt:' + (typeof globalThis.__GRAND__)")" || fail "3 mainRT eval rc" "$OUT"
echo "$OUT" | grep -q '"result":"mainrt:undefined"' || fail "3 marker absent on mainRT" "$OUT"
OUT="$(ctl --target-path 1001 eval "'worker:' + (typeof globalThis.__GRAND__)")" \
  || fail "3 worker eval rc" "$OUT"
echo "$OUT" | grep -q '"result":"worker:undefined"' || fail "3 marker absent on worker" "$OUT"
OUT="$(ctl --target-path 1001,1001 metrics)" || fail "3 grandchild metrics rc" "$OUT"
echo "$OUT" | grep -q '"worker_count":0' || fail "3 grandchild metrics (leaf)" "$OUT"

# 组杀整棵树（QPID 即组号），再用组内 pgrep 等级联退出完成——不再全机
# pgrep -f 匹配（会误命中并行 e2e / 无关 qzjs-rt 造成假失败或误判）。
QGID="$QPID"
kill -TERM -- -"$QGID" 2>/dev/null
for _ in $(seq 1 60); do
  pgrep -g "$QGID" -f "qzjs-rt" > /dev/null 2>&1 || break
  sleep 0.1
done
if pgrep -g "$QGID" -f "qzjs-rt" > /dev/null 2>&1; then
  fail "cleanup: leftover qzjs-rt in test process group" "$(pgrep -g "$QGID" -af qzjs-rt)"
fi
QPID=""

# ── 4: §10.2 STORAGE 嵌套（孙的 localStorage 经子中继到主RT 所有者）──
OUT="$(timeout 30 "$AM" "$FIX/main-nested-storage.js" 2>&1)" || fail "4 nested storage rc" "$OUT"
printf '%s\n' "$OUT" | grep -q "grand:g-get=gv1" || fail "4 grandchild reads owner-set value" "$OUT"
printf '%s\n' "$OUT" | grep -q "main-sees-gkey:gval" || fail "4 owner sees grandchild write" "$OUT"
printf '%s\n' "$OUT" | grep -q "NESTED-STORAGE-DONE" || fail "4 nested storage completion" "$OUT"
# ── 5: 死亡级联（§9.4 两级）──
# 起一棵 host→主RT→worker→孙 的树并回传三级 PID（全局 PID_* / 输出文件）。
start_tree() {
  TREE_OUT="$FIX/tree.out"
  : > "$TREE_OUT"
  setsid "$AM" "$FIX/main-nested-cascade.js" > "$TREE_OUT" 2>&1 &
  TREE_HOST=$!
  mark_group "$TREE_HOST"
  for _ in $(seq 1 60); do grep -q READY "$TREE_OUT" 2>/dev/null && break; sleep 0.1; done
  sleep 0.6
  PID_MAINRT="$(pgrep -P "$TREE_HOST" -f 'qzjs-rt' 2>/dev/null | head -1)"
  PID_WORKER="$(pgrep -P "$PID_MAINRT" 2>/dev/null | head -1)"
  PID_GRAND="$(pgrep -P "$PID_WORKER" 2>/dev/null | head -1)"
  [ -n "$PID_MAINRT" ] && [ -n "$PID_WORKER" ] && [ -n "$PID_GRAND" ] \
    || fail "5 tree not up (host=$TREE_HOST mainRT=$PID_MAINRT worker=$PID_WORKER grand=$PID_GRAND)" "$(cat "$TREE_OUT")"
}
zombies() { ps -eo pgid=,stat=,comm= 2>/dev/null | awk -v g="$TREE_HOST" '$1==g && $3=="qzjs-rt" && $2 ~ /Z/' | wc -l; }

# 5a：kill 孙 → 子（worker）收尸，主RT/worker 存活，零 zombie。
start_tree
kill -9 "$PID_GRAND" 2>/dev/null
for _ in $(seq 1 60); do kill -0 "$PID_GRAND" 2>/dev/null || break; sleep 0.1; done
kill -0 "$PID_GRAND" 2>/dev/null && fail "5a grandchild survived its own kill"
kill -0 "$PID_WORKER" 2>/dev/null || fail "5a worker died when grandchild was killed"
kill -0 "$PID_MAINRT" 2>/dev/null || fail "5a mainRT died when grandchild was killed"
[ "$(zombies)" = "0" ] || fail "5a zombies after grandchild reap: $(zombies)"

# 5b（新树）：kill worker → 孙按 §9.4 孤儿自杀 + 主RT 感知 error 且自身存活。
KGID="$TREE_HOST"; kill -TERM "$KGID" 2>/dev/null
for _ in $(seq 1 60); do pgrep -g "$KGID" -f qzjs-rt >/dev/null 2>&1 || break; sleep 0.1; done
start_tree
kill -9 "$PID_WORKER" 2>/dev/null
for _ in $(seq 1 80); do kill -0 "$PID_GRAND" 2>/dev/null || break; sleep 0.1; done
kill -0 "$PID_GRAND" 2>/dev/null && fail "5b grandchild orphan survived worker death (§9.4 chain)"
kill -0 "$PID_MAINRT" 2>/dev/null || fail "5b mainRT died when worker was killed"
for _ in $(seq 1 60); do grep -q "MAINRT-ONERROR:" "$TREE_OUT" 2>/dev/null && break; sleep 0.1; done
grep -q "MAINRT-ONERROR:" "$TREE_OUT" || fail "5b mainRT onerror on worker death (§9.3)" "$(cat "$TREE_OUT")"

# 5c（新树）：kill 宿主 → 主RT + worker + 孙 全链退出（§9.4）。
KGID="$TREE_HOST"; kill -TERM "$KGID" 2>/dev/null
for _ in $(seq 1 60); do pgrep -g "$KGID" -f qzjs-rt >/dev/null 2>&1 || break; sleep 0.1; done
start_tree
KGID="$TREE_HOST"; kill -9 "$KGID" 2>/dev/null
for _ in $(seq 1 80); do pgrep -g "$KGID" -f qzjs-rt >/dev/null 2>&1 || break; sleep 0.1; done
if pgrep -g "$KGID" -f qzjs-rt > /dev/null 2>&1; then
  fail "5c two-level chain death incomplete" "$(pgrep -g "$KGID" -af qzjs-rt)"
fi
[ "$(zombies)" = "0" ] || fail "5c zombies after host kill: $(zombies)"

echo "PASS: 嵌套 spawn e2e — 三级进程树 (PID 证据) / worker↔孙 postMessage / §8.2 port path 跨两级经 LCA / CTL --target-path 到孙 + 回执配对 / §10.2 STORAGE 孙→主RT 中继 / §9.4 两级死亡级联（收尸/孤儿自杀/连锁）无 zombie 无残留"
