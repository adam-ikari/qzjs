#!/usr/bin/env python3
"""公共头声明面 vs 实际链接面的一致性门。

`include/qzjs/qzjs.h` 里声明、但只在某个编译模型下才有实现的函数，是最难
查的一类缺陷：宿主**编译通过**（头无条件声明），直到**链接**才炸出一句
`undefined reference to 'qz_ping'`——看起来像构建/配置坏了，而不是「这个
编译模型没这个功能」。M-P7 评审里 qz_ping / qz_ping_path 就是这样：实现在
`src/rt_host.c`（仅 ISOLATED + 非 test 编译），声明却是无条件的。

本门按每个编译配置各跑一遍：抽出头里声明的公共函数，逐个查静态库里是否真有
该符号（跳过本配置下头里就没声明的——那是刻意条件编译，如 ping 家族）。

配置：
  isolated   真实 libuv + ISOLATED（生产形态，ping 家族在）
  thread     真实 libuv + THREAD（ping 家族不在）

用法：python3 test/api_surface_check.py [--build-dir DIR] [--model M]
退出码 0 全对，1 有声明无实现。反方向（有实现无声明）**只是参考信息**，不参与判定：非 static 的模块内部函数本就不该进公共头，把它算成失败会逼着人把内部函数公开。
"""

import argparse
import glob
import os
import re
import subprocess
import tempfile
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 头里出现的函数声明：分号收尾的语句里出现的 qz_xxx( 。不锚定行首——声明可能
# 被 `extern "C" {` 之类的构造前缀包住（qz_internal.h 就是这样），锚行首会漏。
NAME_RE = re.compile(r"\b(qz_[a-z_0-9]+)\s*\(")
# 这些是语句（控制流/赋值）而非声明，出现在头里的极少；排除掉以免把函数调用
# 误认成声明。误多认只让 WARN 变安静，不会掩盖 missing，故从宽。
NOT_A_DECL = re.compile(r"^\s*(if|for|while|switch|return|else|do)\b")
# 编译器诊断里的标识符可能被引成 ASCII '…'（clang、C locale）或 ‘…’（gcc + UTF-8
# locale）。两种都要认，否则这道门在换编译器/locale 时恒红——见 main() 里的说明。
QUOTED_NAME_RE = re.compile(r"['\u2018](qz_[a-z_0-9]+)['\u2019]")

# 这些不是函数（类型名 / 宏展开出来的标识）。
NOT_FUNCS = {"qz_t", "qz_ext_t", "qz_config_t", "qz_msg_t"}


def declared_functions(header_path):
    src = open(header_path, encoding="utf-8").read()
    # 先把注释块剥掉，否则注释里的 qz_xxx( 会被当成声明
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"//[^\n]*", "", src)
    out = []
    # 声明可能跨行：把连续的形参行合并
    stmt, depth = "", 0
    for line in src.split("\n"):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        stmt = (stmt + " " + s).strip() if stmt else s
        depth += line.count("(") - line.count(")")
        if depth == 0 and stmt.endswith(";"):
            if not NOT_A_DECL.match(stmt):
                for m in NAME_RE.finditer(stmt):
                    if m.group(1) not in NOT_FUNCS:
                        out.append(m.group(1))
            stmt = ""
    return sorted(set(out))


def defined_symbols(archive):
    """返回 (全部已定义符号, 其中**代码**符号)。分开是因为反向检查只该看代码符号：
    `extern const qz_ext_t qz_compress_ext;` 这类**数据**符号的头部声明没有括号，
    declared_functions() 按定义就看不见它，于是它必然落进「有实现无声明」——
    纯误报。此前把两类混在一起，直接后果是这个集合恒非空，而成功行
    「OK 声明面与链接面一致」恰恰以它为空为前提，于是那行永远打不出来，
    门只剩一串 WARN 和一个 rc=0。"""
    if not os.path.exists(archive):
        return None
    r = subprocess.run(
        ["nm", "--defined-only", archive], capture_output=True, text=True
    )
    if r.returncode != 0:
        return None
    syms, code = set(), set()
    for line in r.stdout.split("\n"):
        parts = line.split()
        if len(parts) >= 3 and parts[-2] in ("T", "W", "D", "B", "R"):
            syms.add(parts[-1])
            if parts[-2] in ("T", "W"):
                code.add(parts[-1])
    return syms, code


def header_guards_active(extra_defines):
    """用真实编译器问「这个配置下头里到底声明了什么」——不自己复刻 #if 逻辑。

    探针文件放 tempfile 而不是固定路径：两个模型并发跑（开发者同时开两个
    shell 很常见）时，一个删掉另一个 cc 正在读的探针，探针就会「静默通过」，
    declared_here 变空，整道门跟着走偏。
    """
    names = declared_functions(os.path.join(ROOT, "include", "qzjs", "qzjs.h"))
    body = ["#include <qzjs/qzjs.h>"]
    for i, n in enumerate(names):
        body.append("void *p%d = (void *)&%s;" % (i, n))   # 取地址即可
    fd, probe = tempfile.mkstemp(prefix="api_surface_probe_", suffix=".c")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("\n".join(body) + "\n")
        cmd = [
            "cc", "-fsyntax-only",
            # implicit-function-declaration 升 error：诊断里就带稳定关键词，
            # 不依赖 warning 是否被别的 -W 抑制。
            "-Werror=implicit-function-declaration",
            "-I", os.path.join(ROOT, "include"),
        ] + extra_defines + [probe]
        env = dict(os.environ, LC_ALL="C.UTF-8")
        r = subprocess.run(cmd, capture_output=True, text=True, env=env)
    finally:
        try:
            os.remove(probe)
        except OSError:
            pass
    return names, r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build-dir", default=os.path.join(ROOT, "build_rt"))
    ap.add_argument(
        "--model",
        default="isolated",
        choices=["isolated", "thread", "mock"],
        help=("isolated → 只定义 QZ_PROCESS_MODEL_ISOLATED（真实 libuv + ISOLATED）；"
              "thread → THREAD；mock → ISOLATED + QZ_USE_MOCK_LIBUV（测试构建）。"
              "mock 必须在 --build-dir 指向 QZ_BUILD_TESTS=ON 的那个库。"),
    )
    args = ap.parse_args()

    # mock 一档的存在理由：ping 家族的守卫是
    #   #if defined(QZ_PROCESS_MODEL_ISOLATED) && !defined(QZ_USE_MOCK_LIBUV)
    # 而 ISOLATED 是 PUBLIC、mock 曾是 PRIVATE——那时消费者只看得到 ISOLATED，
    # 守卫的 mock 那半边形同虚设，头里照旧声明 qz_ping 而库里没有，「编译过、
    # 链接炸」在测试构建里原样复现。只查 isolated/thread 两档是看不见它的。
    defines = {
        "isolated": ["-DQZ_PROCESS_MODEL_ISOLATED=1"],
        "thread": ["-DQZ_PROCESS_MODEL_THREAD=1"],
        "mock": ["-DQZ_PROCESS_MODEL_ISOLATED=1", "-DQZ_USE_MOCK_LIBUV"],
    }[args.model]

    all_names, probe = header_guards_active(defines)
    # 从编译器的诊断里认出「这个条件下头里没声明哪些函数」。判据必须与
    # locale、编译器、引号风格都无关：gcc 在 UTF-8 locale 下打 ‘…’（U+2018/9），
    # clang 和 C locale 下打 ASCII '…'。原来只匹配前者，于是换 runner 镜像、
    # LC_ALL=C、或 cc 指向 clang 时 declared_here 变空 → 守卫函数被算成「可见」
    # → THREAD 库里没有 → 恒红。CI 一直绿只是因为 ubuntu-latest 默认
    # C.UTF-8 让 gcc 恰好打了弯引号。
    #
    # 所以：①把 implicit-function-declaration 升为 error，诊断就带稳定的
    # 关键词而不只是 warning；②两种引号都认；③顺带把 LC_ALL 钉死当兜底。
    def is_undecl(line):
        low = line.lower()
        # 措辞随编译器与标准版本变：gcc 打 "undeclared here"（C99 起隐式声明
        # 默认即错），clang 打 "use of undeclared identifier"，旧版打
        # "implicit declaration of function"。统一用 undeclared / implicit 两个
        # 词根匹配，别逐条列举——列举过一次就漏过一次（'undeclared here' 就漏过）。
        return any(k in low for k in
                   ("undeclared", "implicit declaration", "not declared in this scope"))

    errs = [l for l in probe.stderr.split("\n") if "error:" in l]
    other = [l for l in errs if not is_undecl(l)]
    if other:
        # 探针因为与「未声明」无关的原因失败（头找不到、-I 变了、语法错）。
        # 此时下面的分类毫无意义，而空集会让门看起来「什么都没问题」——直接失败。
        print("FAIL 探针编译失败，且错误与「未声明」无关（分类将不可信）：")
        for l in other[:6]:
            print("     " + l)
        return 1
    undeclared_here = {m.group(1) for l in errs
                       for m in [QUOTED_NAME_RE.search(l)] if m}

    # 「探针产出为空」本身不是问题：ISOLATED 下 14 个函数全部可见，零诊断是正确
    # 结果。只有在**预期**有函数被条件编译掉时，零诊断才说明守卫条件没被覆盖。
    if args.model in ("thread", "mock") and not undeclared_here:
        print("FAIL %s 配置下探针没报出任何未声明函数——"
              "守卫条件可能没被覆盖，这道门此刻检不出任何东西" % args.model)
        return 1

    visible = [n for n in all_names if n not in undeclared_here]

    archive = os.path.join(args.build_dir, "libqzjs.a")
    found = defined_symbols(archive)
    if found is None:
        print("FAIL 读不到 %s（先构建该配置）" % archive)
        return 1
    syms, code = found

    # 硬门：头里声明了、库里却没有 → 宿主「编译通过、链接才炸」。这条必须 fail。
    missing = [n for n in visible if n not in syms]
    # 反方向是**参考信息，不是门**：库里有个 qz_* 代码符号，头里任何地方都没声明。
    # 这多数是正常的——非 static 的模块内部函数（qz_tcp_io_init 就在 src/tcp_io.c
    # 里声明+定义）本就不该进公共头。所以只打印、不影响 rc，也不参与成功判定。
    internal = set()
    for hdr in glob.glob(os.path.join(ROOT, "src", "*.h")) + glob.glob(
        os.path.join(ROOT, "include", "qzjs", "*.h")
    ):
        internal |= set(declared_functions(hdr))
    extra = sorted(
        s for s in code
        if s.startswith("qz_") and s not in visible and s not in internal
    )

    print("配置 %s（%s）" % (args.model, archive))
    print("  头里声明 %d 个，本配置可见 %d 个，库中 %d 个"
          % (len(all_names), len(visible), len([s for s in syms if s.startswith("qz_")])))
    if undeclared_here:
        print("  本条件下刻意不声明：%s" % ", ".join(sorted(undeclared_here)))
    rc = 0
    if missing:
        print("  FAIL 声明了但库里没有实现（宿主会编译通过、链接才炸）：")
        print("       若代码里明明有，先怀疑 --build-dir 指向的归档是**陈旧**的"
              "（本门只读归档、不触发构建）：重新 cmake --build 那个目录再跑。")
        for n in missing:
            print("    - " + n)
        rc = 1
    if extra:
        print("  参考（不影响判定）：库里有实现、头里没声明的 qz_* 代码符号 —— "
              "非 static 的模块内部函数属正常，看到新名字才值得看一眼：")
        for n in extra:
            print("    - " + n)
    if not missing:
        print("  OK 声明面与链接面一致（头里声明的都有实现）")
    return rc


if __name__ == "__main__":
    sys.exit(main())
