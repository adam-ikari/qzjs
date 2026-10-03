#!/usr/bin/env python3
"""JS_GetException 返回值丢弃门。

`JS_GetException(ctx)` 是**转移**语义：把 current_exception 的所有权交给调用方
并清空槽。丢弃返回值 = 丢掉一次引用的所有权。曾被丢弃的那个 InternalError 对象
refcount 永远回不到 0，经 error backtrace 撑住整棵解释器栈帧图，gc_obj_list 因此
永远非空——Debug 下命中 `list_empty(&rt->gc_obj_list)` 断言 abort，NDEBUG 下断言
被编掉、内存静默泄漏（实测 ~158KB/次 interrupt+destroy，THREAD 模型反复起停累积）。

这种泄漏运行时测试抓不到（teardown 才显现），只能静态挡。门只认两种合法写法：
  ① 赋值给变量：    `JSValue exc = JS_GetException(ctx);`            （后续须配对 free，那由人保证）
  ② 直接包入 free： `JS_FreeValue(ctx, JS_GetException(ctx));`
其余任何把 `JS_GetException(...)` 当语句（返回值未接收）的写法都判红。

退出码 0 全对，1 有丢弃。
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRCS = [
    os.path.join(ROOT, "src", f)
    for f in os.listdir(os.path.join(ROOT, "src"))
    if f.endswith((".c", ".h"))
]

# 合法：赋值（= 在前）或被 JS_FreeValue 包入。注释行（// 或 /* 开头）整行跳过。
LEGAL = re.compile(
    r"(=\s*JS_GetException\b"            # ① 赋值
    r"|JS_FreeValue\s*\([^)]*\bJS_GetException\b"  # ② 直接 free
    r")"
)
GETEXC = re.compile(r"\bJS_GetException\b")
COMMENT = re.compile(r"^\s*(//|/\*|\*)")


def strip_inline_comment(line: str) -> str:
    """剥掉行内 //... 尾巴（/* */ 跨行少见，本仓库 JS_GetException 行都不跨）。"""
    idx = line.find("//")
    return line[:idx] if idx >= 0 else line


def main() -> int:
    bad = []
    for path in sorted(SRCS):
        with open(path, encoding="utf-8") as f:
            for i, raw in enumerate(f, 1):
                if COMMENT.match(raw):
                    continue
                line = strip_inline_comment(raw)
                if not GETEXC.search(line):
                    continue
                if LEGAL.search(line):
                    continue
                bad.append(f"{os.path.relpath(path, ROOT)}:{i}: {raw.rstrip()}")

    if bad:
        sys.stderr.write(
            "JS_GetException 返回值被丢弃（转移语义，丢一次引用所有权）：\n"
        )
        for b in bad:
            sys.stderr.write(f"  {b}\n")
        sys.stderr.write(
            "改法：JS_FreeValue(ctx, JS_GetException(ctx));\n"
            "或赋值后配对 free：JSValue exc = JS_GetException(ctx); ... JS_FreeValue(ctx, exc);\n"
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
