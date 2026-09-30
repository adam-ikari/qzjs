#!/bin/bash
# M-P7 mailbox contract e2e（宿主主权翻转正后的直接覆盖门）。
# 跑真 ISOLATED 构建（QZ_BUILD_TESTS=OFF）下的 C harness —— 它就是宿主：
# 零回调、零 libuv，出站消息全部经 qz_recv_message 从 per-rt 邮箱消费。
# 断言面：属主线程 ping 免驱动 / 2000 帧洪泛 FIFO+spill / wait_idle 后箱净 /
# kill -9 主RT 的错误帧在 wait_idle 后首 recv 即得（I4 时序门）/ SIGSTOP
# 冻结 destroy 预算 ≤3s（三级终止在库宿主侧线程，I5②；库内 graceful 档 2000ms，
# 旧预算 6s 是它的 3 倍）/ pre-ready 帧首排干
# 即得 + 回发安全（H1 绊线）/ qz_message_fd 可读提示 + 三步协议终止性 +
# 丢唤醒免疫压力 / 双实例邮箱与 fd 独立互不串扰。
# Usage: bash test/test_mp7_mailbox_e2e.sh <path-to-qzjs>
# 每条用例外面套 timeout 120：脚本的 killer 靠 pgrep 命中，一旦没命中，
# 带 setInterval 的主 RT 永不 idle，harness 的 wait_idle/join 会一直等下去——
# 没有上界就把一次断言失败放大成整 job 挂到超时上限（124 同样判失败）。
set -u
AM="${1:-./build/qzjs}"
BUILD_DIR="$(cd "$(dirname "$AM")" && pwd)"
H="$BUILD_DIR/qz_mp7_mailbox_e2e"

fail() { echo "FAIL: $1"; [ -n "${2:-}" ] && { echo "--- got:"; echo "$2"; }; exit 1; }

[ -x "$H" ] || fail "harness not found at '$H'（需 ISOLATED + QZ_BUILD_TESTS=OFF 构建）"

# 残留检查**不在这里做**。原先是 `pgrep -x qzjs-rt | wc -l` 数整台机器：共享
# runner 上别的 job 起一个 qzjs-rt 就 AFTER > BEFORE 假红，而 pgrep 缺失时两边都是 0、
# 这条检查静默变成永真。正确口径是「harness 自己的子树」，那只有 harness 知道——
# 已移入 mailbox_e2e.c 的 main（pgrep -P <own pid>）。
# 但 pgrep 是那条自查的前提，缺了必须显式报错而不是静默放过。
command -v pgrep >/dev/null 2>&1 || fail "pgrep 不在 PATH：残留自查依赖它，缺了就等于不查"

# ── basic：ping 免驱动 / 洪泛 FIFO / wait_idle 后箱净 ──
OUT="$(timeout 120 "$H" basic 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "basic mode (ping/flood/箱净)" "$OUT"
# 标记要 grep 到冒号为止：harness 里同时有 `ok ①` 与 `ok ①b`，用 "ok ①" 会被
# ①b 满足，于是删掉 ① 那条 printf 这道门照样绿。
echo "$OUT" | grep -q "ok ①:" || fail "basic 缺 ① ping 免驱动断言" "$OUT"
echo "$OUT" | grep -q "ok ②" || fail "basic 缺 ② flood 断言" "$OUT"
echo "$OUT" | grep -q "ok ③" || fail "basic 缺 ③ 箱净断言" "$OUT"
echo "$OUT" | grep -q "ok ①b" || fail "basic 缺 ①b ping 后箱净断言" "$OUT"
echo "$OUT" | grep -q "ok ④" || fail "basic 缺 ④ 漏排干 teardown 排干断言" "$OUT"

# ── crash：kill -9 主RT → wait_idle 返回后首 recv 即错误帧 ──
OUT="$(timeout 120 "$H" crash 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "crash mode (错误帧 wait_idle 后可 recv)" "$OUT"

# ── hung：SIGSTOP 冻结主RT → destroy 墙钟预算（冻结在库线程）──
OUT="$(timeout 120 "$H" hung 2>&1)"; RC=$?
if [ $RC -eq 77 ]; then
    echo "SKIP: hung mode —— $OUT"       # 环境测不了（如容器没挂 /proc），不是失败
elif [ $RC -eq 0 ]; then
    :
else
    fail "hung mode (冻结 destroy 预算)" "$OUT"
fi

# ── replay：pre-ready 帧首排干即得 + create 内回发安全（H1）──
OUT="$(timeout 120 "$H" replay 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "replay mode (pre-ready 入箱 + 回发)" "$OUT"
echo "$OUT" | grep -q "ok ⑥" || fail "replay 缺 ⑥ 组合断言" "$OUT"

# ── fd：可读提示 + 三步协议终止性 + 丢唤醒免疫压力 ──
OUT="$(timeout 120 "$H" fd 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "fd mode (message_fd + 消费协议)" "$OUT"
echo "$OUT" | grep -q "ok ⑦a" || fail "fd 缺 ⑦a 可读提示断言" "$OUT"
echo "$OUT" | grep -q "ok ⑦b" || fail "fd 缺 ⑦b+⑦c 协议压力断言" "$OUT"

# ── dual：双实例邮箱/fd 独立 ──
OUT="$(timeout 120 "$H" dual 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "dual mode (双实例邮箱独立)" "$OUT"
echo "$OUT" | grep -q "ok ⑧a" || fail "dual 缺 ⑧a fd 独立断言" "$OUT"
echo "$OUT" | grep -q "ok ⑧b" || fail "dual 缺 ⑧b 交错 FIFO 断言" "$OUT"
# 同理：harness 有 `ok ⑧c`（ping 均返回 0）与 `ok ⑧c'`（ping 后箱净）两条，
# "ok ⑧c" 是 "ok ⑧c'" 的子串，必须 grep 到冒号才锁得住 ⑧c 本身。
echo "$OUT" | grep -q "ok ⑧c:" || fail "dual 缺 ⑧c ping 均返回 0 断言" "$OUT"
echo "$OUT" | grep -q "ok ⑧c':" || fail "dual 缺 ⑧c' ping 后箱净断言" "$OUT"

echo "PASS: M-P7 mailbox e2e — ping免驱动 / 2000帧FIFO+spill / wait_idle后箱净 / kill-9错误帧wait_idle后首recv即得 / 冻结destroy预算内（库线程三级终止）/ pre-ready首排干即得+回发无崩溃 / fd可读提示+三步协议丢唤醒免疫 / 双实例邮箱fd独立 / 无残留主RT（限本进程子树）"
