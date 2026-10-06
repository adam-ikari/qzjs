#!/usr/bin/env python3
"""qzjs 运行时 CA 信任库端到端测试（qz_add_ca_pem / qzjs --ca）。

驱动真实 qzjs CLI（真实 libuv + 真实 mbedTLS 握手）访问一个**私有 CA 签发**
的本地 HTTPS 服务器。这是 qz_add_ca_pem 唯一有意义的验收场景，也是 mock_libuv
gtest 永远到不了的那条路径：

  - 无 --ca：未知 CA → fetch reject（且必须是**证书原因**的拒绝）
  - 无关 CA：链不匹配 → fetch reject
  - 正确 --ca：真实握手成功、fetch 拿到响应体

第三项是正向路径，也正是 #1 修复的核心「握手成功后切换读回调」所在：只有真握手
成功才会走到 tls_stream_read_cb，而 gtest 跑在 mock_libuv 上没有真实套接字。

必须用 QZ_BUILD_TESTS=OFF 构建的 qzjs：测试构建里 qz_cli 链接 mock_libuv，没有
真实网络（CMakeLists 里 qz_cli 那段注释写明了）。CI 的 e2e job 正是这个配置。

证书在测试内用 openssl 现生成（长期有效），不用仓库夹具：
test/fixtures/test.crt 是自签但 2026-08-18 即过期，拿它跑会在**过期**上失败而
不是**信任**上失败——那测的就不是本功能了。现生成保证测试不会腐烂。

Env: --qzjs-bin PATH（默认 ./build/qzjs）
"""

import argparse
import http.server
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading

BODY = b"qzjs-tls-ca-ok\n"


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    def log_message(self, *a):  # silence per-request stderr noise
        pass


class _DualStackServer(http.server.HTTPServer):
    """Listen on [::] so both ::1 and 127.0.0.1 reach us.

    Required because "localhost" resolves to ::1 first on most systems and qzjs
    does not fall back to IPv4 — an IPv4-only listener makes every fetch fail
    with a bare "connection failed" before TLS is ever reached, which looks
    like a trust failure but isn't.
    """
    address_family = socket.AF_INET6


def run_openssl(args):
    r = subprocess.run(["openssl"] + args, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("openssl %s failed: %s" % (args[0], r.stderr))


def make_pki(tmpdir, tag, host):
    """Build a two-tier PKI: a CA (CA:TRUE) plus a leaf signed by it.

    Returns (ca_pem, srv_pem, srv_key). The client is given the CA, not the
    leaf — that is the real trust-anchor scenario. A cert without
    basicConstraints=CA:TRUE is not a valid anchor, so keeping the CA tier
    exercises the genuine path rather than a degenerate one.
    """
    ca_pem = os.path.join(tmpdir, tag + "-ca.pem")
    ca_key = os.path.join(tmpdir, tag + "-ca.key")
    srv_pem = os.path.join(tmpdir, tag + "-srv.pem")
    srv_key = os.path.join(tmpdir, tag + "-srv.key")
    csr = os.path.join(tmpdir, tag + "-srv.csr")
    ext = os.path.join(tmpdir, tag + "-ext.cnf")

    run_openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes",
                 "-keyout", ca_key, "-out", ca_pem, "-days", "3650",
                 "-subj", "/CN=qzjs-test-%s-CA" % tag,
                 "-addext", "basicConstraints=critical,CA:TRUE",
                 "-addext", "keyUsage=critical,keyCertSign,cRLSign"])

    run_openssl(["req", "-newkey", "rsa:2048", "-nodes",
                 "-keyout", srv_key, "-out", csr, "-subj", "/CN=%s" % host])
    with open(ext, "w") as f:
        f.write("subjectAltName=DNS:%s,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n" % host)
    run_openssl(["x509", "-req", "-in", csr, "-CA", ca_pem, "-CAkey", ca_key,
                 "-CAcreateserial", "-out", srv_pem, "-days", "3650",
                 "-extfile", ext])
    return ca_pem, srv_pem, srv_key


def start_tls_server(srv_pem, srv_key):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=srv_pem, keyfile=srv_key)
    httpd = _DualStackServer(("::", 0), _Handler)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    port = httpd.socket.getsockname()[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def run_qzjs(binpath, code, extra_args=()):
    return subprocess.run(
        [binpath] + list(extra_args) + ["-e", code],
        capture_output=True, text=True, timeout=90,
    )


def assert_rejected(r, why):
    """Assert fetch FAILED for a certificate reason - not merely 'failed'.

    A timeout or connection-refused also rejects the promise, so checking only
    "no BODY:" would pass even if TLS never engaged at all (e.g. a
    QZ_BUILD_TESTS=ON build of qzjs, which links mock_libuv and has no real
    networking). Requiring a cert/TLS mention keeps environment failures from
    masquerading as coverage.
    """
    blob = (r.stdout + r.stderr).lower()
    if "BODY:" in r.stdout:
        print("FAIL[%s]: fetch unexpectedly SUCCEEDED\n%s"
              % (why, r.stdout + r.stderr), file=sys.stderr)
        return False
    marks = ("certificate", "cert", "tls", "handshake", "verify", "x509",
             "unknown ca", "self-signed", "self signed", "alert")
    if not any(m in blob for m in marks):
        print("FAIL[%s]: rejected but not for a certificate reason (environment "
              "failure, not the TLS path under test)\n%s"
              % (why, r.stdout + r.stderr), file=sys.stderr)
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--qzjs-bin", default="./build/qzjs")
    args = ap.parse_args()

    if not (os.path.isfile(args.qzjs_bin) and os.access(args.qzjs_bin, os.X_OK)):
        print("qzjs binary not found/executable: %s" % args.qzjs_bin, file=sys.stderr)
        return 1
    if shutil.which("openssl") is None:
        print("openssl not available on PATH", file=sys.stderr)
        return 1

    tmp = tempfile.mkdtemp(prefix="qzjs-tls-ca-")
    try:
        ca_pem, srv_pem, srv_key = make_pki(tmp, "main", "localhost")
        other_ca, _, _ = make_pki(tmp, "other", "not-localhost")

        httpd, port = start_tls_server(srv_pem, srv_key)
        url = "https://localhost:%d/" % port
        fetch_code = (
            "fetch(%r).then(function(r){return r.text()})"
            ".then(function(t){console.log('BODY:'+t);})"
            ".catch(function(e){console.log('ERR:'+e.message);});0"
        ) % url

        # 1) No CA -> reject, and it must be a CERTIFICATE rejection.
        if not assert_rejected(run_qzjs(args.qzjs_bin, fetch_code), "no --ca"):
            return 1
        print("ok   no --ca -> rejected (unknown CA)")

        # 2) Unrelated CA -> still reject. Proves trust keys off the actual
        #    chain, not off "some CA was supplied".
        if not assert_rejected(run_qzjs(args.qzjs_bin, fetch_code, ["--ca", other_ca]),
                               "wrong --ca"):
            return 1
        print("ok   wrong --ca -> rejected (unrelated anchor)")

        # 3) Correct CA -> real handshake + body. THE positive path: exercises
        #    the post-handshake read-callback swap, unreachable from mock gtests.
        r_ca = run_qzjs(args.qzjs_bin, fetch_code, ["--ca", ca_pem])
        if "BODY:" not in r_ca.stdout:
            print("FAIL: fetch with correct --ca did not return body\n%s"
                  % (r_ca.stdout + r_ca.stderr), file=sys.stderr)
            return 1
        got = r_ca.stdout.split("BODY:", 1)[1].split("\n", 1)[0].strip()
        if got != BODY.decode().strip():
            print("FAIL: wrong body %r (want %r)" % (got, BODY), file=sys.stderr)
            return 1
        print("ok   correct --ca -> handshake OK, body matches")

        httpd.shutdown()
        print("PASS test_tls_ca_e2e")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())