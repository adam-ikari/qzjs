#!/usr/bin/env python3
"""docs C 片段编译门 —— 把文档里的 ```c 块真的编译一遍。

动机：文档里的 C 示例腐化是静默的——公共 API 改个名字、把 `timeout_ms` 语义写反，
文档照旧发布，用户照抄照踩。M-P7 评审里 `qz_get_jsctx`（函数根本不存在）、
`qz_post_message` 长度字面量 26（应 29）、event-loop 示例第 3 步不回流（逻辑错、
编译得过）都是这么活下来的。

**这个门覆盖什么、不覆盖什么**（这一段是实测出来的，不是推测）：
  覆盖：函数改名、参数个数/类型变化、返回值语义、类型不兼容、缺 return、
        用到不存在的结构体字段、隐式函数声明。
  **不覆盖「少个 include」**。预置头无条件 include 了 qzjs/uv/stdio/stdlib/
        string/unistd/stdint/errno/poll——片段里少写 `#include <stdio.h>` 照样
        编得过。要真抓这个，只能另加一档「不带 include 块的预置头」，那是另一
        套判据（而且会让大量片段因为省略 include 而红）。早先的注释宣称覆盖
        这一项，属于**门声称的比门实际测的多**——那类不一致最难发现，所以写明。

三种编译姿势，按顺序试，任一通过即算该块「可编译」：
  A  原样编译       —— 完整翻译单元（含 main）
  B  包进函数体编译 —— 语句片段
  D  同 B 但去掉函数定义的 static —— 嵌套函数（GNU 扩展），C 搞不定时兜底

实测独占贡献（99 块里「只有它能过」的数量）：A 2 块、D 6 块、B 0 块。B 目前不
独占任何一块，但只一行且与 D 共用实现，作为语句片段的兜底保留。
**早先还有姿势 C（顶层定义外提 + 剩余语句包进函数，40 行 bespoke 启发式）**，
实测独占 0 块，且它的说明自称是「混合片段的唯一解」——那实际是 D 在干的事。
够不到的启发式加一段不属实的说明是纯负债，已删。

B/D 都预置 `qz_config_t cfg`（宿主自有的配置结构，片段按「已在 main 里」写）。

预置头只提供头文件与「契约桩」（宿主自有的 loop/句柄变量等）。qzjs API 一律
从真头文件解析——不桩掉，否则这个门就把自己要守的东西挡在门外了。

用法：
  python3 test/docs_c_snippet_check.py            # 打印每块结果与统计
  python3 test/docs_c_snippet_check.py --ratchet  # 低于 .docs-snippet-baseline 则失败（CI 用）

退出码：0 全过（--ratchet 且未跌破基线时也算过），1 有块编译不过或跌破基线。
"""

import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 归档目录与历史设计稿不在维护面内（术语裁决：docs/archive/ 不在范围）。
# 只列真会命中的：md_files() 只走 docs/ + README.md，deps/ 与 polyfill/ 永远
# 不在候选里，写进来只会让人以为门扫过它们。
SKIP_DIRS = ("docs/archive/", "docs/.vitepress/")
# qwrt-architecture-design.md 是历史设计稿（内容已被 docs/architecture/ 取代），
# 它的片段按当初写的样子编译不过，不在维护面内。
SKIP_FILES = ("docs/qwrt-architecture-design.md",)

# 契约桩：宿主自己拥有的东西，片段里直接用。只桩「宿主侧变量」，
# 不桩任何 qzjs/uv API —— 那正是这个门要验的。
PREAMBLE = r"""
#include <qzjs/qzjs.h>
#include <uv.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>
#include <errno.h>
#include <poll.h>

/* 宿主自有（片段按「已经在 main 里」写） */
static uv_loop_t *doc_uv_loop;
static qz_t *doc_rt;
#define uv_loop doc_uv_loop
#define rt      doc_rt

/* 片段里常见的宿主侧自定义回调 —— 签名随用随改，桩到能编过为止 */
static void doc_handle(char *json, size_t len) { (void)json; (void)len; }
#define handle doc_handle
"""

BLOCK_RE = re.compile(r"^```c[ \t]*$")


def md_files():
    """维护面内的 markdown：README.md + docs/ 全部（排除归档与构建产物）。"""
    out = []
    for relf in sorted(
        os.path.join(dp, fn).replace(os.sep, "/")
        for dp, _d, fs in os.walk(os.path.join(ROOT, "docs"))
        for fn in fs
        if fn.endswith(".md")
    ):
        rel = os.path.relpath(relf, ROOT).replace(os.sep, "/")
        if any(rel.startswith(s) for s in SKIP_DIRS):
            continue
        if rel in SKIP_FILES:
            continue
        out.append(rel)
    if os.path.exists(os.path.join(ROOT, "README.md")):
        out.append("README.md")
    return sorted(set(out))


def extract(path):
    """返回 [(起始行号, 代码文本)]，仅 ```c 块。"""
    blocks = []
    inb = False
    start = 0
    buf = []
    with open(os.path.join(ROOT, path), encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            if not inb and BLOCK_RE.match(line.rstrip("\n")):
                inb, start, buf = True, i + 1, []
                continue
            if inb and line.rstrip("\n") in ("```", "```c"):
                blocks.append((start, "".join(buf)))
                inb = False
                continue
            if inb:
                buf.append(line)
    if inb:
        # 未闭合围栏原来是把整块**静默丢掉**：只在遇到闭合围栏时才 append，文件在
        # 块内 EOF 就无声消失。ratchet 靠 ok 下降能兜住（这本来就是它的用法），但
        # 哪天 --ratchet 从 CI 摘掉，覆盖损失就彻底不可见。宁可报出来。
        sys.stderr.write(
            "FAIL %s:%d 有一个未闭合的 ```c 围栏（从第 %d 行到文件末尾都没闭合）\n"
            % (path, start, start))
        return None
    return blocks


def cfg_decl(code):
    """片段按「已经在 main 里」写，常直接用 cfg。宿主自有配置结构，补一个局部
    声明；但片段自己声明了就别补（同名重复声明是硬错误）。"""
    if re.search(r"\bqz_config_t\s+cfg\b", code):
        return ""
    return "    qz_config_t cfg;\n"


def compile_modes(code, tmpdir, tag):
    inc = [
        "-I" + os.path.join(ROOT, "include"),
        "-I" + os.path.join(ROOT, "src"),
        "-I" + os.path.join(ROOT, "deps", "quickjs-ng"),
        "-I" + os.path.join(ROOT, "deps", "cjson"),
        "-I" + os.path.join(ROOT, "deps", "libuv", "include"),
        "-I" + os.path.join(ROOT, "deps", "libuv", "src"),
    ]
    def as_body(src, drop_static):
        t = src
        if drop_static:
            # 嵌套函数不能是 static —— 文件作用域的 static 定义搬进函数体后
            # 得去掉这个关键字，否则 gcc 报错。
            t = re.sub(r"^static\s+(void|int|char|size_t|long)\s+", r"\1 ", t, flags=re.M)
        return "int __doc_body(void) {\n" + cfg_decl(src) + t + "\n}\n"

    modes = {
        "A": code,
        "B": as_body(code, False),
        "D": as_body(code, True),
    }
    # 片段里的缩进/未用参数不该算错：只留真正会挡住腐化的诊断。
    warn = [
        "-Werror=implicit-function-declaration",
        "-Werror=incompatible-pointer-types",
        "-Werror=int-conversion",
        "-Werror=return-type",
        "-Werror=uninitialized",
        "-Werror=format",
    ]
    for name, src in modes.items():
        p = os.path.join(tmpdir, "%s_%s.c" % (tag, name))
        with open(p, "w", encoding="utf-8") as f:
            f.write(PREAMBLE + "\n" + src)
        r = subprocess.run(
            ["cc", "-fsyntax-only", "-std=c99", "-D_POSIX_C_SOURCE=200809L"]
            + inc
            + warn
            + [p],
            capture_output=True,
            text=True,
        )
        if r.returncode == 0:
            return name, ""
        err = "\n".join(
            l for l in r.stderr.split("\n") if " error:" in l or l.startswith(p)
        )
        if not err:
            err = r.stderr.strip().split("\n")[:6]
            err = "\n".join(err)
    return None, err


def main():
    ratchet = "--ratchet" in sys.argv
    total = ok = 0
    fails = []
    with tempfile.TemporaryDirectory() as td:
        for i, rel in enumerate(md_files()):
            blocks = extract(rel)
            if blocks is None:          # extract 已报出未闭合围栏
                return 1
            for j, (line, code) in enumerate(blocks):
                if not code.strip():
                    continue
                total += 1
                mode, err = compile_modes(code, td, "s%d_%d" % (i, j))
                if mode:
                    ok += 1
                else:
                    fails.append((rel, line, err))

    for rel, line, err in fails:
        print("FAIL %s:%d" % (rel, line))
        for l in err.split("\n")[:8]:
            print("     " + l.replace(os.path.join(ROOT, "") + "/", ""))
    print("\n%d/%d 片段可编译，%d 不过" % (ok, total, len(fails)))

    if fails:
        return 1
    # 棘轮只防一件事：**有人为了让门变绿而删掉过不了的片段**。块数变少不等于
    # 「腐化了」——恰恰相反，块数变少是覆盖率被删。它检测不到「加 3 个坏块同时
    # 删 3 个好块」这种对冲，所以是廉价信号不是保证；真正的保证是上面那行
    # `if fails: return 1`（任何一块编不过就红，与计数无关）。
    if ratchet:
        bp = os.path.join(ROOT, "test", ".docs-snippet-baseline")
        if os.path.exists(bp):
            base = int(open(bp).read().strip())
            if ok < base:
                print("FAIL 可编译片段数从基线 %d 掉到 %d——有片段被删掉了。"
                      "删片段让门变绿等于偷偷放弃覆盖；要删就同时下调基线并说清理由。"
                      % (base, ok))
                return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
