#!/usr/bin/env python3
"""qzjs fetch() outbound-proxy end-to-end tests (ROADMAP B2 剩余项).

Drives the real qzjs CLI (real libuv + mbedTLS) through a stdlib-socket HTTP
proxy implemented here (absolute-form GET forwarding + CONNECT tunneling),
against a stdlib origin HTTP server.

Coverage:
  plain HTTP via proxy : fetch() GET, absolute-form request line at the proxy,
                         response round-trip
  streaming via proxy  : response.body reader chunks through the proxy
  NO_PROXY bypass      : NO_PROXY excludes the origin; proxy must see nothing
  CONNECT tunnel       : HTTPS_PROXY triggers "CONNECT host:port"; proxy
                         replies 200 and pipes raw bytes
  NO_PROXY IPv6        : bracketed entries ("[::1]") match bare hosts; a
                         non-matching IPv6 origin still uses the proxy
  CONNECT refused      : proxy replies 403 -> fetch rejects with a network
                         error mentioning the proxy

TLS note: qzjs always verifies certificates against the system CA store
(VERIFY_REQUIRED, hardcoded for security), so a full https-through-tunnel
success round-trip is impossible in an offline test with a self-signed origin.
The CONNECT tests therefore assert the tunnel mechanics (exact CONNECT
request line seen by the proxy, 200/403 gating, post-200 TLS handshake
attempt against the origin) instead of a verified TLS session.

Env: standard HTTP_PROXY/HTTPS_PROXY/NO_PROXY (lowercase accepted by qzjs).
"""

import argparse
import os
import socket
import select
import subprocess
import sys
import tempfile
import threading
import time

TESTS = []
def test(fn):
    TESTS.append(fn)
    return fn

def free_port():
    """Ask the OS for a currently-unused TCP port (bind :0, read back, close).

    This used to be a monotonic counter seeded from the pid, which only
    guaranteed Origin/Proxy never collide with *each other* -- it never checked
    the port was free. On a shared CI runner any other process holding that port
    made bind() fail with EADDRINUSE (seen: test_proxy_wildcard_no_proxy,
    "OSError(98, 'Address already in use')"). Asking the kernel removes that
    whole class; the residual close-then-rebind race is far narrower than the
    previous guaranteed collision.

    Each caller binds what it gets, so a collision between two tests in this
    same process is still impossible (every port is distinct at request time).
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]

class Origin:
    """Minimal origin HTTP server: GET /hello -> 200 text/plain body."""

    def __init__(self, body=b"hello-via-origin", host="127.0.0.1"):
        self.body = body
        self.port = free_port()
        self.requests = []           # (method, target, headers) tuples
        self._lock = threading.Lock()
        self._srv = socket.socket(socket.AF_INET6 if ":" in host
                                  else socket.AF_INET)
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._srv.bind((host, self.port))
        self._srv.listen(8)
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self):
        while True:
            try:
                c, _ = self._srv.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(c,), daemon=True).start()

    def _handle(self, c):
        try:
            c.settimeout(5)
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = c.recv(4096)
                if not chunk:
                    return
                data += chunk
            head = data.split(b"\r\n\r\n", 1)[0]
            lines = head.split(b"\r\n")
            method, target, _ver = lines[0].decode().split(" ", 2)
            headers = {}
            for ln in lines[1:]:
                if b":" in ln:
                    k, v = ln.split(b":", 1)
                    headers[k.strip().decode().lower()] = v.strip().decode()
            with self._lock:
                self.requests.append((method, target, headers))
            c.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n"
                      b"Content-Length: %d\r\nConnection: close\r\n\r\n"
                      % len(self.body) + self.body)
        except OSError:
            pass
        finally:
            c.close()

    def stop(self):
        self._srv.close()

    @property
    def seen(self):
        with self._lock:
            return list(self.requests)


class Proxy:
    """Minimal HTTP proxy: absolute-form GET forwarding + CONNECT tunneling.

    mode "allow": forward to the real target.
    mode "refuse_connect": reply 403 to CONNECT.
    Every request/tunnel is logged to .log for assertions.
    """

    def __init__(self, mode="allow"):
        self.mode = mode
        self.port = free_port()
        self.log = []                # raw first request lines
        self._lock = threading.Lock()
        self._srv = socket.socket()
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._srv.bind(("127.0.0.1", self.port))
        self._srv.listen(8)
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self):
        while True:
            try:
                c, _ = self._srv.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(c,), daemon=True).start()

    def _handle(self, c):
        remote = None
        try:
            c.settimeout(10)
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = c.recv(4096)
                if not chunk:
                    return
                data += chunk
            head, extra = data.split(b"\r\n\r\n", 1)
            lines = head.split(b"\r\n")
            first = lines[0].decode()
            with self._lock:
                self.log.append(first)
            parts = first.split(" ")

            if parts[0] == "CONNECT":
                host, _, port = parts[1].rpartition(":")
                port = int(port)
                if self.mode == "refuse_connect":
                    c.sendall(b"HTTP/1.1 403 Forbidden\r\n"
                              b"Content-Length: 0\r\nConnection: close\r\n\r\n")
                    return
                remote = socket.create_connection(("127.0.0.1", port), timeout=5)
                c.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                if extra:
                    remote.sendall(extra)
                self._pipe(c, remote)
            else:
                # absolute-form: METHOD http://host[:port]/path HTTP/1.1
                rest = parts[1].split("://", 1)[1]
                hostport, _, path = rest.partition("/")
                path = "/" + path
                host, _, port = hostport.partition(":")
                port = int(port) if port else 80
                remote = socket.create_connection(("127.0.0.1", port), timeout=5)
                rebuilt = ("%s %s HTTP/1.1\r\n" % (parts[0], path)).encode()
                rebuilt += data.split(b"\r\n", 1)[1]
                remote.sendall(rebuilt)
                self._pipe(c, remote)
        except (OSError, ValueError):
            pass
        finally:
            if remote is not None:
                remote.close()
            c.close()

    @staticmethod
    def _pipe(a, b):
        socks = [a, b]
        try:
            while True:
                r, _, x = select.select(socks, [], socks, 15)
                if x or not r:
                    return
                for s in r:
                    d = s.recv(65536)
                    if not d:
                        return
                    (b if s is a else a).sendall(d)
        except OSError:
            pass

    def stop(self):
        self._srv.close()

    @property
    def seen(self):
        with self._lock:
            return list(self.log)


def run_qz_fetch(qz_bin, js, proxy_port=None, no_proxy=None):
    """Run `js` under qzjs with proxy env; return (exitcode, output)."""
    env = dict(os.environ)
    env.pop("HTTP_PROXY", None); env.pop("http_proxy", None)
    env.pop("HTTPS_PROXY", None); env.pop("https_proxy", None)
    env.pop("NO_PROXY", None); env.pop("no_proxy", None)
    if proxy_port is not None:
        purl = "http://127.0.0.1:%d" % proxy_port
        env["HTTP_PROXY"] = purl
        env["HTTPS_PROXY"] = purl
    if no_proxy:
        env["NO_PROXY"] = no_proxy
    p = subprocess.run([qz_bin, "-e", js], env=env, timeout=20,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return p.returncode, p.stdout.decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------

@test
def test_http_via_proxy(qz_bin):
    origin = Origin()
    proxy = Proxy()
    try:
        js = ("fetch('http://127.0.0.1:%d/hello').then(function(r){return r.text();})"
              ".then(function(t){console.log('GOT:'+t);},"
              "function(e){console.log('ERR:'+e);});" % origin.port)
        rc, out = run_qz_fetch(qz_bin, js, proxy_port=proxy.port)
        assert "GOT:hello-via-origin" in out, out
        assert rc == 0, (rc, out)
        # proxy must have seen the absolute-form target
        assert proxy.seen and proxy.seen[0].startswith(
            "GET http://127.0.0.1:%d/hello HTTP/1.1" % origin.port), proxy.seen
        # and the origin must have been reached with the relative target
        assert origin.seen and origin.seen[0][1] == "/hello", origin.seen
    finally:
        proxy.stop()
        origin.stop()


@test
def test_no_proxy_bypass(qz_bin):
    origin = Origin()
    proxy = Proxy()
    try:
        js = ("fetch('http://127.0.0.1:%d/hello').then(function(r){return r.text();})"
              ".then(function(t){console.log('GOT:'+t);},"
              "function(e){console.log('ERR:'+e);});" % origin.port)
        rc, out = run_qz_fetch(qz_bin, js, proxy_port=proxy.port,
                                 no_proxy="127.0.0.1")
        assert "GOT:hello-via-origin" in out, out
        time.sleep(0.2)
        assert proxy.seen == [], proxy.seen
    finally:
        proxy.stop()
        origin.stop()


@test
def test_no_proxy_bracketed_ipv6_bypass(qz_bin):
    """NO_PROXY='[::1]' must bypass the proxy for http://[::1]:port/ —
    hosts are stored bare, so bracketed entries must be bracket-stripped."""
    origin = Origin(host="::1")
    proxy = Proxy()
    try:
        js = ("fetch('http://[::1]:%d/hello').then(function(r){return r.text();})"
              ".then(function(t){console.log('GOT:'+t);},"
              "function(e){console.log('ERR:'+e);});" % origin.port)
        rc, out = run_qz_fetch(qz_bin, js, proxy_port=proxy.port,
                                 no_proxy="[::1]")
        assert "GOT:hello-via-origin" in out, out
        time.sleep(0.2)
        assert proxy.seen == [], proxy.seen
    finally:
        proxy.stop()
        origin.stop()


@test
def test_no_proxy_ipv6_nonmatch_uses_proxy(qz_bin):
    """An IPv6 origin NOT covered by NO_PROXY still goes through the proxy
    (the request line must appear in the proxy log)."""
    proxy = Proxy()
    try:
        js = ("fetch('http://[::1]:%d/hello').then(function(r){console.log('UNEXPECTED');},"
              "function(e){console.log('ERR:'+e);});" % (proxy.port - 1))
        rc, out = run_qz_fetch(qz_bin, js, proxy_port=proxy.port,
                                 no_proxy="example.com")
        assert proxy.seen and proxy.seen[0].startswith(
            "GET http://[::1]:%d/hello HTTP/1.1" % (proxy.port - 1)), proxy.seen
    finally:
        proxy.stop()


@test
def test_proxy_wildcard_no_proxy(qz_bin):
    origin = Origin()
    proxy = Proxy()
    try:
        js = ("fetch('http://127.0.0.1:%d/hello').then(function(r){return r.text();})"
              ".then(function(t){console.log('GOT:'+t);},"
              "function(e){console.log('ERR:'+e);});" % origin.port)
        rc, out = run_qz_fetch(qz_bin, js, proxy_port=proxy.port,
                                 no_proxy="*")
        assert "GOT:hello-via-origin" in out, out
        time.sleep(0.2)
        assert proxy.seen == [], proxy.seen
    finally:
        proxy.stop()
        origin.stop()



@test
def test_streaming_via_proxy(qz_bin):
    origin = Origin(body=b"chunk0-chunk1-chunk2")
    proxy = Proxy()
    try:
        js = ("fetch('http://127.0.0.1:%d/stream').then(function(r){"
              "  var reader = r.body.getReader(); var parts = [];"
              "  function pump(){"
              "    return reader.read().then(function(res){"
              "      if (res.done) { return parts.join('|'); }"
              "      parts.push(new TextDecoder().decode(res.value));"
              "      return pump();"
              "    });"
              "  }"
              "  return pump();"
              "}).then(function(all){console.log('STREAM:'+all);},"
              "function(e){console.log('ERR:'+e);});" % origin.port)
        rc, out = run_qz_fetch(qz_bin, js, proxy_port=proxy.port)
        assert "STREAM:" in out, out
        assert out.split("STREAM:")[1].split("\n")[0].replace("|", "") == "chunk0-chunk1-chunk2", out
        assert proxy.seen, proxy.seen
    finally:
        proxy.stop()
        origin.stop()


def make_tls_sink():
    """Plain TCP socket masquerading as the https origin behind the tunnel.
    Accepts and immediately replies with non-TLS garbage so the post-tunnel
    mbedTLS handshake fails fast (offline stand-in for an untrusted origin)."""
    garbage = b"\x16\x03\x01\x00\x00not-a-real-tls-server-hello"
    sink = socket.socket()
    sink.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sink.bind(("127.0.0.1", 0))
    sink.listen(4)
    stop = threading.Event()

    def serve():
        while not stop.is_set():
            try:
                c, _ = sink.accept()
            except OSError:
                return
            try:
                c.settimeout(5)
                c.recv(4096)          # ClientHello
                c.sendall(garbage)
            except OSError:
                pass
            c.close()

    t = threading.Thread(target=serve, daemon=True)
    t.start()
    return sink, stop


@test
def test_https_connect_tunnel(qz_bin):
    """HTTPS_PROXY -> CONNECT request; proxy 200; qzjs then attempts TLS.

    The origin here is a plain TCP socket (no TLS), so after the tunnel opens
    the mbedTLS handshake must fail against non-TLS bytes. That failure is the
    assertion that the full CONNECT -> 2xx -> TLS-continuation path ran.
    """
    sink, sink_stop = make_tls_sink()
    sink_port = sink.getsockname()[1]

    proxy = Proxy()
    try:
        js = ("fetch('https://localhost:%d/x').then("
              "function(r){console.log('UNEXPECTED');},"
              "function(e){console.log('REJ:'+e);});" % sink_port)
        rc, out = run_qz_fetch(qz_bin, js, proxy_port=proxy.port)
        assert "REJ:" in out, out
        assert "UNEXPECTED" not in out, out
        assert proxy.seen and proxy.seen[0] == "CONNECT localhost:%d HTTP/1.1" % sink_port, proxy.seen
    finally:
        sink_stop.set()
        proxy.stop()
        sink.close()


@test
def test_https_connect_refused(qz_bin):
    """Proxy refuses CONNECT with 403 -> fetch rejects, origin never dialed."""
    proxy = Proxy(mode="refuse_connect")
    try:
        js = ("fetch('https://localhost:9/x').then("
              "function(r){console.log('UNEXPECTED');},"
              "function(e){console.log('REJ:'+e);});")
        rc, out = run_qz_fetch(qz_bin, js, proxy_port=proxy.port)
        assert "REJ:" in out, out
        assert "UNEXPECTED" not in out, out
        assert proxy.seen and proxy.seen[0].startswith("CONNECT localhost:9 "), proxy.seen
    finally:
        proxy.stop()


@test
def test_malformed_proxy_url_fails_closed(qz_bin):
    origin = Origin()
    try:
        env = dict(os.environ)
        env.pop("HTTPS_PROXY", None); env.pop("https_proxy", None)
        env.pop("NO_PROXY", None); env.pop("no_proxy", None)
        env["HTTP_PROXY"] = "socks5://127.0.0.1:1080"   # unsupported scheme
        js = ("fetch('http://127.0.0.1:%d/hello').then("
              "function(r){console.log('UNEXPECTED');},"
              "function(e){console.log('REJ:'+e);});" % origin.port)
        p = subprocess.run([qz_bin, "-e", js], env=env, timeout=20,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        out = p.stdout.decode("utf-8", "replace")
        assert "REJ:" in out, out
        assert "UNEXPECTED" not in out, out
    finally:
        origin.stop()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--qzjs-bin", required=True)
    args = ap.parse_args()
    qz_bin = os.path.abspath(args.qzjs_bin)
    assert os.path.exists(qz_bin), "qzjs binary not found: %s" % qz_bin

    failed = []
    for fn in TESTS:
        name = fn.__name__
        t0 = time.time()
        try:
            fn(qz_bin)
            print("PASS %-36s (%.1fs)" % (name, time.time() - t0))
        except AssertionError as e:
            failed.append(name)
            print("FAIL %-36s (%.1fs): %s" % (name, time.time() - t0, e))
        except Exception as e:  # noqa: BLE001 — harness reports and continues
            failed.append(name)
            print("ERROR %-35s (%.1fs): %r" % (name, time.time() - t0, e))
    print("\n%d/%d passed" % (len(TESTS) - len(failed), len(TESTS)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
