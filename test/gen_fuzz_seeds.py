#!/usr/bin/env python3
"""从构建产出的字节码生成 fuzz 语料种子（prefix seeds）。

背景：qzjs 把 polyfill / worker-boot 的字节码内嵌进库（`src/polyfill_default.c`
/ `src/worker_boot_default.c`），而这两份字节码是 **构建期用 qjsc 重新生成** 的
（见 polyfill/build.js 与 CMake 的 add_custom_command）。字节码会随 polyfill 源码
或 qjsc 变动而变，且**逐位不可复现**（同源码两次构建可有数字节差异）。

fuzz 语料里的 `seed-polyfill-head{N}k.bc` / `seed-workerboot.bc` 的语义是
「**仓库自己那份**字节码的头 N 字节」——它们必须是真实字节码的前缀，fuzz 预算
才是在真实字节码结构附近变异，而不是在一个已不存在的形态上。

过去这四个 seed 是 committed 的，而字节码是构建产物——两者会漂移，且因为字节码
非确定性，committed 的 seed 永远无法稳定匹配某次 CI 构建的字节码（`fuzz_corpus_
align_check.py` 因此恒红）。本脚本把 seed 变成**构建产物**：字节码一变，seed 跟着
重新生成，对齐门就永远成立。

用法（CMake 调用；也可手工）：
    python3 test/gen_fuzz_seeds.py <dist_dir> <out_dir>

依赖：只读 dist/polyfill.bytecode、dist/worker-boot.bytecode（polyfill/build.js 的
输出），不碰构建工具链，因此无 node/esbuild 的 job 也能跑（用 committed 基线
字节码生成一致的 seed）。
"""

import io
import os
import sys

# (输出文件名, 源字节码, 取前多少字节)；None = 整个文件。
SEEDS = [
    ("seed-polyfill-head4k.bc", "polyfill.bytecode", 4 * 1024),
    ("seed-polyfill-head8k.bc", "polyfill.bytecode", 8 * 1024),
    ("seed-polyfill-head64k.bc", "polyfill.bytecode", 64 * 1024),
    ("seed-workerboot.bc", "worker-boot.bytecode", None),
]


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: %s <dist_dir> <out_dir>\n" % argv[0])
        return 2
    dist, out = argv[1], argv[2]
    os.makedirs(out, exist_ok=True)
    rc = 0
    for name, src, n in SEEDS:
        src_path = os.path.join(dist, src)
        try:
            data = io.open(src_path, "rb").read()
        except OSError as e:
            sys.stderr.write("MISSING %s: %s\n" % (src_path, e))
            rc = 1
            continue
        if n is not None:
            if len(data) < n:
                sys.stderr.write("SHORT  %s: %d bytes < %d requested\n"
                                 % (src_path, len(data), n))
                rc = 1
                continue
            data = data[:n]
        with open(os.path.join(out, name), "wb") as f:
            f.write(data)
        print("seed %-24s <- %s (%d bytes)" % (name, src, len(data)))
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv))
