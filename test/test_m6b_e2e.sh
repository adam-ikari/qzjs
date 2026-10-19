#!/usr/bin/env bash
# M6b in-module guest 原语 e2e 汇总：QZ 契约面（113 原语）逐族验证。
# 用法：test/test_m6b_e2e.sh [build-dir]
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
BUILD="${1:-$ROOT/build-inmod}"

fail() { echo "FAIL: $1"; exit 1; }
command -v node >/dev/null 2>&1 || fail "node not found"

WASM="$BUILD/src/qzvm/libqzvm.wasm"
[ -f "$WASM" ] || fail "libqzvm.wasm 缺失，先跑 test/test_inmodule_guest_e2e.sh"

run() {  # run <名称> <脚本> [额外参数...]
    local name="$1"; shift
    local out
    out="$(node "$@" 2>&1)" || { echo "$out" | tail -8; fail "$name"; }
    echo "$out" | grep -E '^PASS' | tail -1 || fail "$name (no PASS line)"
}

run "primitives"        "$DIR/m6b-poc/e2e_prims.mjs"        --libqzvm "$WASM"
run "real-program"      "$DIR/m6b-poc/e2e_real_program.mjs" --libqzvm "$WASM"
run "prop-get"          "$DIR/m6b-poc/e2e_prop_get.mjs"     --libqzvm "$WASM"
run "builtin"           "$DIR/m6b-poc/e2e_builtin.mjs"      --libqzvm "$WASM"
run "closure"           "$DIR/m6b-poc/e2e_closure.mjs"      --libqzvm "$WASM"
run "class"             "$DIR/m6b-poc/e2e_class.mjs"        --libqzvm "$WASM"
run "statics"           "$DIR/m6b-poc/e2e_statics.mjs"     --libqzvm "$WASM"
run "concat"            "$DIR/m6b-poc/e2e_concat.mjs"       --libqzvm "$WASM" \
                        --product "$DIR/m6b-poc/concat_inmod.wasm"

echo "PASS: test_m6b_e2e (8 组 e2e)"
