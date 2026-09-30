#!/usr/bin/env python3
"""fuzz 语料与仓库真实字节码的对齐门。

## 为什么需要这道门

`test/fuzz-corpus/` 里那几个 `seed-polyfill-head{4k,8k,64k}.bc` /
`seed-workerboot.bc` 的定义是「**仓库自己那份**字节码的头 N 字节」——真实
polyfill 字节码在 `src/polyfill_default.c` 的 .rodata 里，worker boot 字节码在
`src/worker_boot_default.c` 里，两者都是 tracked 的构建产物。

问题在于：字节码会随 quickjs 的 patch、polyfill 的改动而变，而**语料不会自动跟着
变**。一旦漂移，这几个 seed 就不再代表任何真实字节码了：它们仍然能喂给
`JS_ReadObject`、仍然不会让重放门报错，但 fuzz 的 60 秒预算是在一个**已经不存在的
字节码形态**附近做变异——正是 libFuzzer seeded run 最不该发生的事（CI 注释自己写着
「so the 60 s budget spends its time mutating around known-interesting shapes
rather than rediscovering the container format from scratch」）。

这不是假想：核对时发现 HEAD 上那四个 seed 与 `src/*_default.c` **对不上**（头 4 字节
分别是 1b99c2fa / 1bbc192a，而仓库真实的是 1cb7bf5b / 1c7ae3a5），工作区里重新生成
的版本才对得上。也就是说这道门要抓的漂移**已经发生过一次**，只是没人有判据去发现。

## 判据

对每个 seed：它的**全部字节**必须等于对应 `src/*_default.c` 里那段字节码的同长前缀。
比 4 字节强得多，也不依赖任何魔数。

不是前缀的 seed（`seed-crash-*.bin` / `seed-oom-*.bin` / 那些哈希名文件）不在本门范围
——它们是 fuzz 发现的输入，与真实字节码无对应关系，由 CI 的重放门负责。

用法：python3 test/fuzz_corpus_align_check.py     # 退出码 1 = 有 seed 已漂移
"""

import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# seed 名 → 仓库里那份「真实字节码」的源文件
SEEDS = {
    "seed-polyfill-head4k.bc": "src/polyfill_default.c",
    "seed-polyfill-head8k.bc": "src/polyfill_default.c",
    "seed-polyfill-head64k.bc": "src/polyfill_default.c",
    "seed-workerboot.bc": "src/worker_boot_default.c",
}

_BYTE_RE = re.compile(r"0x([0-9a-fA-F]{2})")


def embedded_bytes(path):
    """取 C 数组字面量里的字节（.rodata 形式的 `{0x..,0x..,...}`）。"""
    src = io.open(os.path.join(ROOT, path), encoding="utf-8").read()
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
