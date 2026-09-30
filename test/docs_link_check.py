#!/usr/bin/env python3
"""文档站内部链接与锚点门。

站内链接指向一个被改名/被删的章节时，VitePress 构建**不报错**——它照常生成
页面，只是那个 `#anchor` 永远滚不到东西。读者点过去落在页顶，于是去找「那一段
到底写了什么」，找不到就以为文档没写。这类腐化完全静默。

本门按 VitePress 的 slug 规则把每篇的标题转成锚点集，再遍历全站站内链接
（`](/path#anchor)` 与 `](/path)`），逐条核对：
- 目标页面存在吗？
- 带锚点时锚点存在吗？

slug 规则（与 VitePress/markdown-it-anchor 一致）：
  去掉反引号与行内链接语法 → 去掉 `[^\w\u4e00-\u9fff\- ]` 的字符 → 小写 →
  空格换成 `-`。
注意 `&` 会被去掉但**两侧的空格保留**，于是 `## Workers & the Process Model`
的 slug 是 `workers--the-process-model`（双连字符）——这是最容易写错的一类。

用法：python3 test/docs_link_check.py        # 打印每条断链，退出码 1 = 有断链
"""

import glob
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP = ("/.vitepress/", "/archive/", "/node_modules/")   # node_modules 是第三方，只读参考
LINK_RE = re.compile(r"\]\((/[^)\s]*?)(#[^)\s]*)?\)")
HEAD_RE = re.compile(r"^(#{1,4})\s+(.*)$", re.M)


def slug(title: str) -> str:
    t = re.sub(r"`", "", title).strip()
    t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", t)
    return re.sub(r"[^\w\u4e00-\u9fff\- ]", "", t).lower().replace(" ", "-")


def page_body(f: str) -> str:
    """VitePress 路由：docs/guide/cli.md → /guide/cli（index.md → 目录）"""
    rel = os.path.relpath(f, ROOT).replace(os.sep, "/")
    if rel.startswith("docs/"):
        stem = rel[len("docs/"):].rsplit(".md", 1)[0]
    else:
        stem = rel.rsplit(".md", 1)[0]
    return "/" + (stem[:-6] if stem.endswith("/index") else stem)


def collect():
    anchors, files = {}, []
    for f in sorted(glob.glob(os.path.join(ROOT, "docs", "**", "*.md"), recursive=True)):
        rel = os.path.relpath(f, ROOT).replace(os.sep, "/")
        if any(s in rel for s in SKIP):
            continue
        src = io.open(f, encoding="utf-8").read()
        body = page_body(f)
        anchors.setdefault(body, set()).update(slug(m.group(2)) for m in HEAD_RE.finditer(src))
        anchors.setdefault(body + "/index", set())
        files.append((f, src))
    for f in ("README.md",):
        p = os.path.join(ROOT, f)
        if os.path.exists(p):
            files.append((p, io.open(p, encoding="utf-8").read()))
    return anchors, files


def main():
    anchors, files = collect()
    broken, checked = [], 0
    for f, src in files:
        rel = os.path.relpath(f, ROOT)
        for m in LINK_RE.finditer(src):
            path, frag = m.group(1), m.group(2)
            checked += 1
            tgt = path if path in anchors else path.rstrip("/") + "/index"
            if tgt not in anchors:
                broken.append((rel, path, "目标页面不存在"))
            elif frag and frag[1:] not in anchors[tgt]:
                broken.append((rel, path + frag, "锚点不存在"))
    for rel, link, why in broken:
        print("BROKEN %s -> %s（%s）" % (rel, link, why))
    print("站内链接 %d 条，断链 %d 条" % (checked, len(broken)))
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
