#!/bin/bash
# 确定性随机源 e2e（brain/pages/qzvm-qzjs-layering.md 约束③）——
# 跑真实 ISOLATED 构建，验 `--seed=N` 从**宿主进程**一路走到**引擎**。
#
# 为什么单独一支：ISOLATED 下 JS 跑在 spawn 出的 qzjs-rt 子进程里，主RT 的
# qz_config_t 只能靠 argv 传递（宿主 → rt_host.c 拼 argv → rt_main.c 解析 →
# rt->config → qz_runtime_init → JS_SetRandomSeed）。这条链断在哪一段，
# 症状都是「种子静默失效」——`qz_create` 照样成功、脚本照样跑，只是
# Math.random() 每次运行都不同。单测（THREAD 构建，qz_config_t 直传）看不见
# 这一段：它们根本不过进程边界。
#
# 三条断言：
#   1. 同种子两跑 → stdout 逐字节相同
#   2. 异种子     → stdout 不同（种子真的被用了，不是被忽略成常量）
#   3. 无种子两跑 → stdout 不同（缺省仍是时钟播种，没被悄悄固定成常量）
#
# Usage: bash test/test_seed_determinism_e2e.sh <path-to-qzjs>
set -u
AM="${1:-./build/qzjs}"

fail() { echo "FAIL: $1"; [ -n "${2:-}" ] && { echo "--- got:"; echo "$2"; }; exit 1; }

[ -x "$AM" ] || fail "qzjs not found/executable at '$AM'"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 每次调用各取一串 Math.random()：只看序列，不看墙钟。多取几个数，避免
# 「两次恰好同值」的偶然（QuickJS 的 random_state 是 xorshift64star，同种子
# 必然同序列，异种子撞上前若干位几乎不可能）。
cat > "$TMP/seed.js" <<'JS'
const out = [];
for (let i = 0; i < 8; i++) out.push(Math.random());
console.log(JSON.stringify(out));
JS

run() {  # run <args...> → stdout（去掉任何 debug/日志噪声只看最后一行）
    "$AM" "$@" "$TMP/seed.js" 2>/dev/null | tail -n 1
}

A1="$(run --seed=20261015)"
A2="$(run --seed=20261015)"
B="$(run --seed=424242)"
[ -n "$A1" ] || fail "empty output (seed=20261015)"

[ "$A1" = "$A2" ] || fail "同种子两次运行输出不同 —— 种子未穿过进程边界" "$A1
vs
$A2"
[ "$A1" != "$B" ] || fail "异种子输出相同 —— 种子被忽略（退化常量）" "$A1"

C1="$(run)"
C2="$(run)"
[ "$C1" != "$C2" ] || fail "无种子两次运行输出相同 —— 缺省时钟播种被改坏了" "$C1"

echo "PASS: 确定性随机源 —— --seed 穿 ISOLATED 进程边界生效（同种子可复现 / 异种子不同 / 缺省仍时钟播种）"
