#!/bin/bash
# 宿主消费契约 e2e —— 跑真实 ISOLATED 构建下的 test/host_contract_e2e.c。
#
# 补的是既有 8 支 e2e 都不覆盖的那件事：**宿主照文档写出来的消费循环**能不能用。
# harness 是测试专用宿主，跑的是各自那一条断言；而「按 docs/{,zh/}c-api/runtime.md
# 邮箱节那段循环收发」这个宿主一定会做的事，没有任何一支 e2e 在验，文档门也只保证
# 那段代码能编、不保证它行为正确。三条路径：
#   1. 文档循环原样（三态分开判、库错误帧认出来且**不 break**）
#   2. 宿主自己的 eventfd（qz_message_fd）+ poll 驱动的循环
#   3. qz_wait_idle 之后仍可排干（最终排干的位置就在那里）
#
# 另有一道**防漂移检查**：文档里那段示例与本程序必须对库错误帧用同一条判别式。
# 两边各写一次、又没有检查的话，迟早文档说 A 程序做 B，而宿主照文档抄。
# Usage: bash test/test_host_contract_e2e.sh <path-to-qzjs>
set -u
AM="${1:-./build/qzjs}"
BUILD_DIR="$(cd "$(dirname "$AM")" && pwd)"
BIN="$BUILD_DIR/host_contract_e2e"

fail() { echo "FAIL: $1"; [ -n "${2:-}" ] && { echo "--- got:"; echo "$2"; }; exit 1; }

[ -x "$BIN" ] || fail "host_contract_e2e not built at '$BIN'（需 ISOLATED + QZ_BUILD_TESTS=OFF 构建）"

# ── 防漂移：文档的判别式 == 程序的判别式 ──
DOC='docs/c-api/runtime.md'
PROG='test/host_contract_e2e.c'
# 文档里是**纯文本**判别式，C 程序里是**转义后**的形式（\"type\":\"error\"），
# 两者要分开匹配。第一版对三者一律 grep 纯文本，结果程序侧匹配到的是文件顶部**注释**
# 里那句说明、而不是代码——检查一直在测注释，负控改了代码它照样绿。
for f in "$DOC" "docs/zh/c-api/runtime.md"; do
  [ -f "$f" ] || fail "缺文件 $f"
  grep -q '"type":"error"' "$f" \
    || fail "$f 里找不到库错误帧的判别式 \"type\":\"error\"（文档与程序已漂移？）"
done
# 程序侧必须匹配转义形式（代码里真正的样子），而不是注释里的纯文本。
grep -q 'type\\":\\"error' "$PROG" \
  || fail "$PROG 的代码里找不到转义形式的判别式（文档与程序已漂移？）"
# 反向：代码里不该再出现别的 error 帧判别式。
grep -q 'type\\":\\"fatal' "$PROG" \
  && fail "$PROG 用了与文档不同的判别式（漂移）"
grep -q '不 break\|不要 break\|keep draining' "$DOC" || fail "EN 文档不再声明「错误帧不要 break」——消费循环的承诺变了？"
grep -q '不要 break' "docs/zh/c-api/runtime.md" || fail "zh 文档不再声明「错误帧不要 break」"

OUT="$(cd "$BUILD_DIR" && QZ_RT_SERVER="$BUILD_DIR/qzjs-rt" timeout 300 ./host_contract_e2e 2>&1)"; RC=$?
[ $RC -eq 0 ] || fail "host_contract_e2e (三条消费路径)" "$OUT"
echo "$OUT" | grep -q "路径1 收满 40 条、按投递序、不重不漏" || fail "缺 路径1（文档循环原样 / 顺序 / 不重不漏）断言" "$OUT"
echo "$OUT" | grep -q "路径1 收满后邮箱为空" || fail "缺 路径1 箱净断言" "$OUT"
echo "$OUT" | grep -q "路径2（宿主 eventfd + poll）收满" || fail "缺 路径2（eventfd 交接）断言" "$OUT"
echo "$OUT" | grep -q "路径3 wait_idle 之后仍排干" || fail "缺 路径3（wait_idle 后排干）断言" "$OUT"

echo "PASS: 宿主消费契约 — 文档循环原样 / 错误帧不 break / 收满后箱净 / 宿主 eventfd 交接 / wait_idle 后排干 / 文档与程序判别式一致"
