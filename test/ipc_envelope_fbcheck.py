#!/usr/bin/env python3
"""IPC Envelope cross-verification (M-P0 verification gate, design doc §11).

Proves the handwritten C codec (src/ipc/ipc_envelope.c) is byte-level FlatBuffers
wire-format compatible with the official Python `flatbuffers` library:

  A) C encode -> Python decode, field-by-field compare
  B) Python encode -> C decode (via ipc_envelope_cli), field-by-field compare

Usage: python3 test/ipc_envelope_fbcheck.py --cli <path-to-ipc_envelope_cli>
Exit 0 = wire-compatible. Requires: pip install flatbuffers
"""

import argparse
import struct
import subprocess
import sys

import flatbuffers
from flatbuffers import Builder
from flatbuffers import number_types as N
from flatbuffers.table import Table

# Schema field ids (wire contract, design doc §4.1).
F_SOURCE, F_TARGET, F_KIND, F_PAYLOAD = 0, 1, 2, 3

CASES = [
    # (source, target, kind, payload-bytes)
    (0, 1, 0, b""),
    (1, 0, 3, b"\x01\x02\x03"),
    (-5, 77, 2, b"payload text \xe4\xb8\xad\xe6\x96\x87"),
    (2**31 - 1, -(2**31), 1, bytes(range(256))),
    (3, 4, 0, b"\x00" * 70000),  # > 64 KiB
]


def py_encode(source, target, kind, payload):
    b = Builder(len(payload) + 64)
    # [ubyte] vector: prepend elements back-to-front.
    b.StartVector(1, len(payload), 1)
    for x in reversed(payload):
        b.PrependUint8(x)
    payload_off = b.EndVector()
    b.StartObject(4)
    b.PrependInt32Slot(F_SOURCE, source, 0)
    b.PrependInt32Slot(F_TARGET, target, 0)
    b.PrependInt8Slot(F_KIND, kind, 0)
    # Slot variant registers field id 3 in the vtable (PrependUOffsetTRelative
    # alone would leave the field untracked = absent on decode).
    b.PrependUOffsetTRelativeSlot(F_PAYLOAD, payload_off, 0)
    root = b.EndObject()
    b.Finish(root)
    return bytes(b.Output())


def py_decode(buf):
    """Return (source, target, kind, payload) or raise on malformed."""
    n = struct.unpack_from("<I", buf, 0)[0]
    tab = Table(buf, n)
    voff = tab.Offset(4 + 2 * F_SOURCE)
    source = tab.Get(N.Int32Flags, voff + tab.Pos) if voff else 0
    voff = tab.Offset(4 + 2 * F_TARGET)
    target = tab.Get(N.Int32Flags, voff + tab.Pos) if voff else 0
    voff = tab.Offset(4 + 2 * F_KIND)
    kind = tab.Get(N.Int8Flags, voff + tab.Pos) if voff else 0
    voff = tab.Offset(4 + 2 * F_PAYLOAD)
    payload = b""
    if voff:
        payload = tab.Bytes[
            tab.Vector(voff): tab.Vector(voff) + tab.VectorLen(voff)]
    return source, target, kind, payload


def run_cli(cli_bin, stdin_data, *args):
    r = subprocess.run([cli_bin, *args], input=stdin_data,
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(
            f"cli {args[0]} failed rc={r.returncode}: {r.stdout}{r.stderr}")
    return r.stdout.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cli", required=True, help="path to ipc_envelope_cli")
    args = ap.parse_args()
    cli_bin = args.cli

    fails = 0
    for i, (source, target, kind, payload) in enumerate(CASES):
        phex = payload.hex()

        # A) C encode (payload hex via stdin — E2BIG-safe) -> Python decode.
        cbytes = bytes.fromhex(run_cli(cli_bin, phex, "enc", str(source),
                                       str(target), str(kind), "-"))
        try:
            got = py_decode(cbytes)
        except Exception as e:  # noqa: BLE001 — report, don't traceback
            print(f"FAIL case {i}: python decode of C bytes raised {e}")
            fails += 1
            continue
        if got != (source, target, kind, payload):
            print(f"FAIL case {i}: C-enc -> py-dec {got!r} != "
                  f"{(source, target, kind, payload)!r}")
            fails += 1

        # B) Python encode -> C decode (buffer hex via stdin).
        pbytes = py_encode(source, target, kind, payload)
        out = run_cli(cli_bin, pbytes.hex(), "dec", "-").split(" ", 3)
        while len(out) < 4:  # empty payload hex is stripped by the CLI
            out.append("")
        if out[0] == "ERR":
            print(f"FAIL case {i}: C rejected python bytes: {out}")
            fails += 1
            continue
        want = (str(source), str(target), str(kind), phex)
        if tuple(out) != want:
            print(f"FAIL case {i}: py-enc -> C-dec {out!r} != {want!r}")
            fails += 1

    # Roundtrip sanity inside python itself (guards the reference impl).
    for i, (s, t, k, p) in enumerate(CASES):
        if py_decode(py_encode(s, t, k, p)) != (s, t, k, p):
            print(f"FAIL case {i}: python self-roundtrip")
            fails += 1

    if fails:
        print(f"ipc_envelope_fbcheck: {fails} FAILURES")
        return 1
    print(f"PASS: ipc_envelope_fbcheck — {len(CASES)} cases, "
          f"both directions wire-compatible")
    return 0


if __name__ == "__main__":
    sys.exit(main())
