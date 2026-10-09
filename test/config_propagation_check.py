#!/usr/bin/env python3
"""qz_config_t 字段的跨进程传递门。

ISOLATED 进程模型（默认）下 runtime 只存在于 spawn 出的 `qzjs-rt` 子进程
（宿主进程只有通道桩）。于是宿主经 `qz_config_t` 公开结构体设的任何值，
若没被显式传递到子进程，就**静默失效**——没有报错、没有降级提示。

`debug` 就是这么丢的：宿主设 `cfg.debug` 启用 DAP，而 `rt_main.c` 曾把子
进程的 `rt->config.debug` 硬编码为 0。CLI 一直没暴露，因为它走 `QZ_DEBUG`
环境变量（子进程 exec 继承 environ）；**受害者是库宿主**，而那正是 qzjs 的
主要使用场景。同型缺陷还有 `QZ_CA_FILE` 那一路（CA 信任库跨不进子进程）。

本门按「加字段必须接线」强制：**qz_config_t 每个字段，要么出现在跨进程
传递路径上，要么进白名单并写明为什么不需要传**。新增字段忘了传递 → 本门
变红，附上该字段名。

传递路径的判据（两处任一命中即视为已接线）：
  - rt_host.c 里出现 `rt->config.<field>`（宿主侧 argv/env 组装）
  - rt_main.c 里出现 `rt->config.<field> =`（子进程侧从 argv/env 还原）

刻意宽松处：判据是**字段名的出现**，不是语义正确性。语义对不对由该字段
自身的测试负责——本门只防「忘了传」这一类，不越权。

用法：python3 test/config_propagation_check.py
退出码 0 = 全对；1 = 有字段既未传递也无白名单理由。
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEADER = os.path.join(ROOT, "include", "qzjs", "qzjs.h")
PRODUCER = os.path.join(ROOT, "src", "rt_host.c")   # 宿主侧：组装 argv
CONSUMER = os.path.join(ROOT, "src", "rt_main.c")   # 子进程侧：从 argv 还原


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)
    return text


def config_fields(header_text):
    """qz_config_t 的字段名，顺序与头文件一致。

    逐行取「以分号收尾的声明」，剥掉分号与数组尾后，末个 token 即字段名
    （前面是类型与指针星号）。不用正则去切类型/名字的分界——`[\w\s\*]+`
    贪婪匹配会把整个声明吃掉、捕获组只能回退拿到最后一个字符。
    """
    m = re.search(r"typedef\s+struct\s+qz_config_?s?\s*\{(.*?)\}\s*qz_config_t\s*;",
                  header_text, flags=re.S)
    if not m:
        raise SystemExit("找不到 qz_config_t 定义（头文件结构变了？）")
    body = strip_comments(m.group(1))
    fields = []
    for line in body.split("\n"):
        line = line.strip()
        if not line.endswith(";"):
            continue                       # 续行 / 结构体收尾等
        decl = line[:-1].strip()           # 去掉分号
        decl = re.sub(r"\[[^\]]*\]$", "", decl).strip()   # 去掉数组尾
        name = decl.split()[-1].lstrip("*")                # 末个 token 即字段名
        if re.fullmatch(r"[A-Za-z_]\w*", name):
            fields.append(name)
    return fields


# 不需要跨进程传递的字段 —— 每条都要写清「为什么」。
# 新增条目时把理由写完整：白名单是给半年后的自己看的，不是形式。
ALLOWLIST = {
    "struct_size":
        "ABI 门控字段。qz_create() 在宿主侧本地比对 sizeof 与 abi_version，"
        "不一致直接返回 NULL（qzjs.c 的 'ABI mismatch' 诊断）。子进程自己 "
        "calloc 出 rt、不声明 qz_config_t，从无从也不需要这项。",
    "abi_version":
        "同 struct_size：宿主侧 ABI 门控，纯本地校验，不构成跨进程配置。",
    "initial_script_path":
        "在 qz_create 期就折叠掉了——qzjs.c 读文件内容写回 "
        "rt->config.initial_script（path 优先），spawn 时路径已无意义；"
        "真正传递的是折叠后的 initial_script（经 --script-stdin 管道）。",
    "sandbox_root":
        "经 QZ_STRICT_SANDBOX 环境变量传递（与 strict_mode 同一条通道），"
        "但子进程把它存进**不同名**的 rt->strict_root 而非 "
        "rt->config.sandbox_root，故本门的 'rt->config.<field>' 判据看不见。"
        "见 rt_main.c 的 getenv(\"QZ_STRICT_SANDBOX\") 分支。",
    "env_allowlist":
        "同上，经 QZ_STRICT_ENV 环境变量传递，子进程存进不同名的 "
        "rt->strict_env_allow（NULL 结尾数组）。"
        "strict 通道本身有 e2e 覆盖，不靠本门。",
}


def main():
    if not (os.path.isfile(HEADER) and os.path.isfile(PRODUCER)
            and os.path.isfile(CONSUMER)):
        print("找不到 %s / %s / %s" % (HEADER, PRODUCER, CONSUMER),
              file=sys.stderr)
        return 1

    header_text = strip_comments(open(HEADER, encoding="utf-8").read())
    producer = open(PRODUCER, encoding="utf-8").read()
    consumer = open(CONSUMER, encoding="utf-8").read()

    fields = config_fields(header_text)
    if not fields:
        print("FAIL: 从头文件解析出 0 个 qz_config_t 字段，判据本身失效",
              file=sys.stderr)
        return 1

    missing = []
    for f in fields:
        produced = ("rt->config.%s" % f) in producer
        consumed = ("rt->config.%s =" % f) in consumer
        if produced or consumed or f in ALLOWLIST:
            continue
        missing.append(f)

    print("qz_config_t 字段 %d 个，已接线 %d，白名单 %d"
          % (len(fields), len(fields) - len(missing) - len(ALLOWLIST),
             len(ALLOWLIST)))

    # 白名单里若有已接线的字段，说明理由过期了——提醒删掉，别让白名单变成
    # 「什么都往里塞」的逃生舱。
    stale = [f for f in ALLOWLIST
             if ("rt->config.%s" % f) in producer
             or ("rt->config.%s =" % f) in consumer]
    if stale:
        print("NOTE: 白名单里这些字段其实已接线，理由可能过期：%s"
              % ", ".join(stale))

    if missing:
        print("FAIL: 这些 qz_config_t 字段既没出现在跨进程传递路径上，"
              "也没有白名单理由：", file=sys.stderr)
        for f in missing:
            print("    - %s" % f, file=sys.stderr)
        print("\nISOLATED（默认进程模型）下子进程看不到这些字段的值 —— "
              "宿主设了等于没设，且无任何报错。", file=sys.stderr)
        print("要修：在 src/host/rt_host.c 的 argv/env 组装里传它，"
              "并在 src/host/rt_main.c 里从 argv 还原；", file=sys.stderr)
        print("若确实无需传递，加进本脚本的 ALLOWLIST 并写明理由。",
              file=sys.stderr)
        return 1

    print("OK: 每个 qz_config_t 字段都有明确的跨进程归属")
    return 0


if __name__ == "__main__":
    sys.exit(main())