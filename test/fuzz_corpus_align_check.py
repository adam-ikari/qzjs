#!/usr/bin/env python3
"""fuzz 语料与内嵌字节码的对齐门。

## 为什么需要这道门

`test/fuzz-corpus/` 里那几个 `seed-polyfill-head{4k,8k,64k}.bc` /
`seed-workerboot.bc` 的语义是「**当次构建产出的那份**字节码的头 N 字节」——polyfill
字节码在 `<build>/generated/polyfill/polyfill_default.c` 的 .rodata 里，worker boot
字节码在同目录的 `worker_boot_default.c` 里（monorepo 后中间产物不落 src/）。

这几个种子现在是**构建产物**（`test/gen_fuzz_seeds.py`，CMake 的
`fuzz_seeds_gen` 目标，随字节码重新生成），不再是 committed 文件。原因：内嵌
字节码由 qjsc 在构建期生成，且**逐位不可复现**——同一份 polyfill 源码、同样的
patch 与配置，两次构建的字节码可以差几个字节。曾经这四个 seed 是 committed 的，
而字节码是构建产物且不可复现，于是 committed 的前缀种子永远匹配不上某次 CI 构建
的字节码，这道门恒红（seed 比真实字节码还长，或第 1 字节就不同）。

## 这道门现在守什么

生成环节（`gen_fuzz_seeds.py`）已保证种子来自当次构建的 `dist/*.bytecode`；本门
再校验它们确实是**内嵌进库的那份**字节码的真实前缀——即 rodata 模式下
`<build>/generated/polyfill/*_default.c` 的前缀。两者一旦脱节（生成读错了源、
字节码被换掉而种子没重生成），门就红。

真正要防的事没变：种子必须代表内嵌字节码的真实结构，否则 fuzz 的 60 秒预算是
在一个**已不存在的字节码形态**附近做变异——正是 libFuzzer seeded run 最不该
发生的（CI 注释自己写着「spends its time mutating around known-interesting shapes
rather than rediscovering the container format from scratch」）。

对每个 seed：它的**全部字节**必须等于对应 `*_default.c` 里那段字节码的同长
前缀。比 4 字节强得多，也不依赖任何魔数。

不是前缀的 seed（`seed-crash-*.bin` / `seed-oom-*.bin` / 那些哈希名文件）不在本门
范围——它们是 fuzz 发现的输入，与真实字节码无对应关系，由 CI 的重放门负责。


用法：python3 test/fuzz_corpus_align_check.py     # 退出码 1 = 有 seed 已漂移
"""

import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 内嵌字节码的 C 数组不再落 src/：monorepo 后由 build.js 经 QZ_POLYFILL_GEN_DIR
# 写到 <build>/generated/polyfill/（.gitignore 明确不 committed 中间产物）。
# 构建目录取 argv[1]（默认 build/），与 CI 各 job 的 -B 目录一致。
BUILD_DIR = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 \
    else os.path.join(ROOT, "build")
_GEN_DIR = os.path.join(BUILD_DIR, "generated", "polyfill")

# seed 名 → 当次构建产出的「真实字节码」C 源文件
SEEDS = {
    "seed-polyfill-head4k.bc": os.path.join(_GEN_DIR, "polyfill_default.c"),
    "seed-polyfill-head8k.bc": os.path.join(_GEN_DIR, "polyfill_default.c"),
    "seed-polyfill-head64k.bc": os.path.join(_GEN_DIR, "polyfill_default.c"),
    "seed-workerboot.bc": os.path.join(_GEN_DIR, "worker_boot_default.c"),
}

_BYTE_RE = re.compile(r"0x([0-9a-fA-F]{2})")


def embedded_bytes(path):
    """取 C 数组字面量里的字节（.rodata 形式的 `{0x..,0x..,...}`）。"""
    if not os.path.exists(path):
        return None
    src = io.open(path, encoding="utf-8").read()
    m = re.search(r"\{\s*0x[0-9a-fA-F]{2}\s*,", src)
    if not m:
        return None
    start = src.index("{", m.start())
    end = src.index("}", start)
    return bytes(int(h, 16) for h in _BYTE_RE.findall(src[start + 1:end]))


def main():
    drift = []
    for seed, real in sorted(SEEDS.items()):
        sp = os.path.join(ROOT, "test", "fuzz-corpus", seed)
        if not os.path.exists(sp):
            drift.append((seed, real, "语料文件不存在"))
            continue
        ref = embedded_bytes(real)
        if not ref:
            drift.append((seed, real, "从 %s 里取不到字节码数组" % real))
            continue
        data = io.open(sp, "rb").read()
        if len(data) > len(ref):
            drift.append((seed, real,
                          "语料 %d 字节 > 真实字节码 %d 字节（源文件被截短了？）"
                          % (len(data), len(ref))))
            continue
        if ref[:len(data)] != data:
            # 找第一处不同的偏移，报出来比「不匹配」有用得多
            off = next((i for i in range(len(data)) if data[i] != ref[i]),
                       min(len(data), len(ref)))
            drift.append((seed, real,
                          "不是 %s 字节码的前缀：第 %d 字节起不同（语料 %02x vs 真实 %02x）"
                          % (real, off, data[off], ref[off])))
        else:
            print("  ok  %-24s = %s 的前 %d 字节" % (seed, real, len(data)))
    for seed, real, why in drift:
        print("DRIFT %-24s %s" % (seed, why))
    print("fuzz 语料对齐：%d 个 seed，%d 个已漂移" % (len(SEEDS), len(drift)))
    return 1 if drift else 0


if __name__ == "__main__":
    sys.exit(main())
