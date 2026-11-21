#!/usr/bin/env python3
"""裸 GDB-RSP 客户端：设断点 → continue → 断言命中。

WAMR debug-interp 的调试对象是 wasm 模块。本脚本不解析 DWARF——地址由调用方
（test_wamr_debug_rsp.sh，用 llvm-dwarfdump 读出）传入，PC 编码为
`offset | (WasmObj << 62)`，即文件绝对偏移。

用法：rsp_break.py <port> <hex-addr> [<hex-addr> ...] [--timeout S]
退出码 0 = 至少命中一次 reason:breakpoint；1 = 未命中/协议错。
"""
import socket
import sys
import time

WASMOBJ_SHIFT = 62


def parse_args(argv):
    addrs, timeout = [], 20.0
    i = 0
    while i < len(argv):
        if argv[i] == "--timeout":
            timeout = float(argv[i + 1]); i += 2
        else:
            addrs.append(int(argv[i], 16)); i += 1
    return addrs, timeout


class Rsp:
    def __init__(self, port, timeout):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        self.s.settimeout(timeout)
        self.buf = bytearray()
        self.deadline = time.time() + timeout

    def _read(self, wait):
        self.s.settimeout(wait)
        try:
            while True:
                b = self.s.recv(4096)
                if not b:
                    break
                self.buf.extend(b)
        except socket.timeout:
            pass

    def packets(self, flush=True):
        d = bytes(self.buf); out = []; i = 0
        while i < len(d):
            if d[i:i + 1] == b'+':
                i += 1; continue
            if d[i:i + 1] == b'$':
                h = d.find(b'#', i)
                if h < 0:
                    break
                out.append(d[i + 1:h].decode(errors='replace')); i = h + 3
            else:
                i += 1
        if flush:
            self.buf.clear()
        return out

    def send(self, payload, wait=0.6):
        msg = "$%s#%02x" % (payload, sum(payload.encode()) & 0xff)
        self.s.sendall(msg.encode())
        time.sleep(0.1)
        self._read(wait)

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


def main():
    if len(sys.argv) < 3:
        print("usage: rsp_break.py <port> <hex-addr> [...]", file=sys.stderr)
        return 2
    port = int(sys.argv[1])
    addrs, timeout = parse_args(sys.argv[2:])
    rsp = Rsp(port, timeout)
    try:
        rsp._read(1.5)                       # 首停（reason:trace）或空
        rsp.send("?")
        rsp.send("Hc-1")
        set_ok = True
        for a in addrs:
            rsp.send("Z0,%x,1" % a, wait=0.4)
            if "OK" not in rsp.packets():
                set_ok = False
        rsp.send("c", wait=0.5)
        hit = None
        exited = False
        while time.time() < rsp.deadline:
            for p in rsp.packets():
                if "reason:breakpoint" in p:
                    hit = p; break
                if p.startswith("W") or p.startswith("X"):
                    exited = True; break
            if hit or exited:
                break
            rsp._read(1.0)
        if hit:
            print("HIT %s" % hit)
            return 0
        print("MISS (breakpoints set=%s, exited=%s)" % (set_ok, exited), file=sys.stderr)
        return 1
    finally:
        rsp.close()


if __name__ == "__main__":
    sys.exit(main())
