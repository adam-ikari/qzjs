#!/usr/bin/env python3
"""third_party_notices_check.py — 校验 THIRD_PARTY_NOTICES.md 覆盖全部 vendored 依赖。

新增依赖（git submodule、deps/ 下的 vendored 目录、或 polyfill 打包进字节码的
npm 依赖）时若忘记在 THIRD_PARTY_NOTICES.md 的表格里登记，本检查失败。MIT 等
许可的分发义务要求版权声明随二进制走；NOTICES 漂移 = 合规风险。这条约束已被
实际漂移验证过（cJSON 与三个 polyfill npm 依赖曾漏登记）。

判定用表格第一列的**精确**组件名（不是全文子串——URL 或 license 文件名里出现
依赖名不算登记，否则删掉组件名也测不出来）。匹配时忽略大小写与空格下划线，
以容忍「Mbed TLS」这类展示名与 deps/mbedtls 目录名的差异。

覆盖三类：
  1. .gitmodules 的每个 submodule（deps/<name>）
  2. deps/ 下所有 vendored 目录（含非 submodule 的 cJSON，编进库）
  3. polyfill/package.json 的 npm 依赖（编进字节码随二进制分发）

用法：python3 test/third_party_notices_check.py
退出码：0 = 覆盖完整；1 = 有未登记的依赖（逐条 ::error:: 打印）。
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
NOTICES = ROOT / "THIRD_PARTY_NOTICES.md"

# esbuild 是 polyfill 的构建期 bundler，不编进字节码/二进制；NOTICES 段落
# 里显式声明了这一豁免，因此它不要求出现在组件表里。
BUILD_ONLY_NPM = {"esbuild"}


def normalize(s):
    return re.sub(r"[\s_\-]+", "", s.lower())


def parse_notice_components(text):
    """提取 NOTICES 表格第一列的组件名（归一化，精确匹配用）。"""
    names = set()
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        name = cells[0].strip("`* ")
        if not name or set(name) <= set("- ") or name.lower() == "component":
            continue
        names.add(normalize(name))
    return names


def main():
    if not NOTICES.exists():
        print(f"::error::missing {NOTICES}")
        return 1

    text = NOTICES.read_text()
    components = parse_notice_components(text)
    ok = True

    def require(ident, why):
        nonlocal ok
        if normalize(ident) not in components:
            ok = False
            print(f"::error::THIRD_PARTY_NOTICES.md missing [{why}]: {ident}")

    # 1) .gitmodules 子模块
    gm = ROOT / ".gitmodules"
    if gm.exists():
        for line in gm.read_text().splitlines():
            m = re.match(r"\s*path\s*=\s*deps/(\S+)", line)
            if m:
                require(m.group(1), "git submodule")

    # 2) deps/ 下所有 vendored 目录
    deps_dir = ROOT / "deps"
    if deps_dir.is_dir():
        for d in sorted(deps_dir.iterdir()):
            if d.is_dir():
                require(d.name, "vendored dep under deps/")

    # 3) polyfill npm 依赖（编进字节码）
    pkg = ROOT / "polyfill" / "package.json"
    if pkg.exists():
        data = json.loads(pkg.read_text())
        for section in ("dependencies", "devDependencies"):
            for name in data.get(section, {}):
                if name in BUILD_ONLY_NPM:
                    # 豁免也必须在文档里说清楚，否则构建期/运行时分界会丢
                    if name not in text:
                        ok = False
                        print(f"::error::NOTICES 未说明 {name} 为构建期工具（不进二进制）")
                    continue
                require(name, "polyfill npm dep (bundled into bytecode)")

    if not ok:
        return 1
    print(f"third-party notices: {len(components)} components cover all vendored deps")
    return 0


if __name__ == "__main__":
    sys.exit(main())