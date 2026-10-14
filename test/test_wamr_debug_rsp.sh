#!/bin/bash
# WAMR debug-interp（GDB RSP）端到端 e2e —— DWARF 地址约定守卫。
#
# WAMR 源码级调试通道（QZ_WITH_WAMR_DEBUG_INTERP）此前仅在 /tmp 手验，不入仓、
# CI 不跑：ext_wamr.c 接线 / RSP 帧 / DWARF 地址约定一改无人发现。本脚本固化
# 全链：配置 debug 构建 → 编译 strw（--debug）→ 纯 .wasm 加载（--no-aot；WAMR
# 拒绝 AOT 实例）→ 从 DWARF 行表取行地址 → 裸 RSP 客户端断点 → 断言
# reason:breakpoint 命中。
#
# 地址约定（本测试即守之）：WAMR PC = wasm 文件绝对偏移 | (WasmObj<<62)；
# DWARF 地址是 code 段 payload 起始的相对偏移 → 断点地址 = DWARF 行地址 +
# code 段 payload 文件偏移。二者必须一致，否则断点永不命中。
#
# 用法：bash test/test_wamr_debug_rsp.sh [build-dir]
# 依赖：cmake + C 工具链 + node + llvm-dwarfdump（或 dwarfdump）+ python3
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
BUILD="${1:-$ROOT/build-dbg}"
OUT="$ROOT/build/aot"

fail() { echo "FAIL: $1"; exit 1; }

command -v node >/dev/null 2>&1 || fail "node not found"
command -v python3 >/dev/null 2>&1 || fail "python3 not found"
DWARFDUMP="$(command -v llvm-dwarfdump-14 || command -v llvm-dwarfdump || command -v dwarfdump || true)"
[ -n "$DWARFDUMP" ] || fail "llvm-dwarfdump not found"

# ── 1. 配置 + 构建 debug-interp 版 qzjs ──
mkdir -p "$BUILD"
cmake -S "$ROOT" -B "$BUILD" -DQZ_WITH_WAMR=ON -DQZ_WITH_WAMR_DEBUG_INTERP=ON \
      > "$BUILD/qz-dbg.cfg.log" 2>&1 \
  || { cat "$BUILD/qz-dbg.cfg.log"; fail "cmake configure"; }
cmake --build "$BUILD" --target qzjs -j"$(nproc 2>/dev/null || echo 4)" \
      > "$BUILD/qz-dbg.build.log" 2>&1 \
  || { tail -40 "$BUILD/qz-dbg.build.log"; fail "qzjs debug build"; }
QZJS="$BUILD/qzjs"
[ -x "$QZJS" ] || QZJS="$(find "$BUILD" -maxdepth 3 -type f -name qzjs -perm -u+x -print -quit)"
[ -n "$QZJS" ] && [ -x "$QZJS" ] || fail "qzjs binary not found in $BUILD"
echo "qzjs: $QZJS"

# ── 2. 编译被测模块（--debug 产 DWARF），生成纯 wasm glue ──
mkdir -p "$OUT"
node "$ROOT/src/qzvm/aot/build.js" compile "$ROOT/src/qzvm/aot/strwork.ts" strw --debug \
      > /dev/null 2>&1 || fail "compile strw"
node "$ROOT/src/qzvm/aot/build.js" glue "$OUT/strw" --main "strWork(5)" --no-aot \
      > /dev/null 2>&1 || fail "glue strw (--no-aot)"
[ -f "$OUT/strw.wasm" ] || fail "strw.wasm not produced"
grep -q 'readFileBinary("strw.wasm")' "$OUT/strw.glue.js" || fail "glue not wasm-only"
grep -q 'strw.aot' "$OUT/strw.glue.js" && fail "glue still references .aot"

# ── 3. 从 DWARF 行表取全部行地址，算 code 段 payload 文件偏移（断点地址 = 行地址 + 基址）──
# 输出「基址 行地址...」：基址在前，故用 FIRST/REST 读（read 仅在最后一个变量
# 收余下全文，故不能把多 token 放非末位）。
read -r FIRST REST < <(python3 - "$OUT/strw.wasm" "$DWARFDUMP" <<'PY'
import re, subprocess, sys
wasm, dump = sys.argv[1], sys.argv[2]
# code 段 payload 文件偏移（DWARF 地址约定基准）
d = open(wasm, "rb").read()
def uleb(p):
    v = s = 0
    while True:
        b = d[p]; p += 1; v |= (b & 0x7f) << s; s += 7
        if not b & 0x80: return v, p
i, code = 8, None
while i < len(d):
    sid = d[i]; i += 1; ln, i = uleb(i); ps = i
    if sid == 10: code = ps
    i = ps + ln
# 行表全部非 end_sequence 行地址（DWARF 行地址）。取全部：首行地址可能早于
# WAMR 入口停顿 PC（已越过的地址不命中断点）——见下方设点注释。
out = subprocess.run([dump, "--debug-line", wasm], capture_output=True, text=True).stdout
rows = [int(m.group(1), 16) for m in re.finditer(r"^(0x[0-9a-fA-F]+)\s+\d+", out, re.M)]
if code is None or not rows:
    sys.exit("no code section or no line rows")
print(hex(code), " ".join(hex(a + code) for a in rows))
PY
) || fail "extract DWARF line addresses"
CODE_BASE="$FIRST"; ALL_ADDRS="$REST"
[ -n "$ALL_ADDRS" ] || fail "no DWARF line addresses"

# 起始停顿（reason:trace）已推进过入口，早于该 PC 的行地址不会命中——故对全部
# 行地址设点，任一命中即证明「DWARF 地址 + code 基址 = 文件绝对偏移」约定成立。
ARGS=()
for a in $ALL_ADDRS; do ARGS+=( "$(printf '0x%x' $((a + (1 << 62))))" ); done

# ── 4. 起 qzjs（自动端口）→ 裸 RSP 断点 → 断言命中 ──
LOG="$(mktemp)"; ERR="$(mktemp)"
( cd "$OUT" && QZ_WAMR_DEBUG_PORT=0 "$QZJS" "$OUT/strw.glue.js" ) > "$LOG" 2> "$ERR" &
QZJS_PID=$!
cleanup() { kill -9 "$QZJS_PID" 2>/dev/null; rm -f "$LOG" "$ERR"; }
trap cleanup EXIT

PORT=""
for _ in $(seq 1 40); do
    PORT="$(sed -n 's/.*listening on port \([0-9]*\).*/\1/p' "$ERR" | head -1)"
    [ -n "$PORT" ] && break
    sleep 0.25
done
[ -n "$PORT" ] || { cat "$ERR"; fail "debug server did not start"; }
echo "debug port: $PORT"

python3 "$DIR/wamr-debug-e2e/rsp_break.py" "$PORT" "${ARGS[@]}" \
  || { echo "--- qzjs stdout ---"; cat "$LOG"; echo "--- stderr ---"; cat "$ERR"; fail "breakpoint not hit"; }

echo "PASS: test_wamr_debug_rsp (${#ARGS[@]} DWARF line addr(s) + code base $CODE_BASE -> hit)"
