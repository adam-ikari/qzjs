#!/usr/bin/env node
/**
 * qzjs HTTP/2 client stack performance benchmark.
 *
 * Measures the pure-JS HTTP/2 client protocol stack (HPACK decode + frame
 * processing + stream multiplexing) by driving it against a local Node
 * http2 server.  The transport layer is shimmed via Node `net` sockets
 * (same pattern as test/h2_client_harness.mjs).
 *
 * This benchmarks the JS protocol stack only — NOT the C network path.
 * The qzjs binary is not involved.
 *
 * Scenarios:
 *   tiny       : 8-byte response, sequential         — per-request overhead
 *   small      : 1 KB response, sequential            — typical payload
 *   medium     : 16 KB response, sequential           — mid-size payload
 *   multiplex  : 8 concurrent streams × 1 KB each     — multiplexing throughput
 *
 * Usage:
 *   node test/bench_h2_client.mjs [--duration 5]
 *
 * Prints human-readable lines then a JSON summary on the last line
 * (matching bench_httpserver.py output contract).
 */
import http2 from 'node:http2';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { buildSync } = require(path.resolve(__dirname, '..', 'src', 'polyfill', 'node_modules', 'esbuild'));
const SRC = path.resolve(__dirname, '..', 'src', 'polyfill', 'src');

// ── CLI args ──
const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const DURATION = parseInt(argVal('--duration', '5'), 10);

// ── 1. Bundle h2 stack to temp ESM ──
const bundlePath = '/tmp/h2_client_bench.bundle.mjs';
buildSync({
  entryPoints: [path.join(SRC, 'http2.js')],
  bundle: true, format: 'esm', outfile: bundlePath, write: true, logLevel: 'silent',
});
const { HTTP2Client } = await import(bundlePath);

// ── 2. pal shim over Node net ──
const pal = {
  tcpConnect(host, port, cb) {
    const sock = net.connect({ host, port });
    sock.setNoDelay(true);
    const h = { sock };
    sock.on('connect', () => cb.onconnect && cb.onconnect());
    sock.on('data', (d) => {
      const ab = d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
      cb.ondata && cb.ondata(ab);
    });
    sock.on('error', (e) => cb.onerror && cb.onerror(e.message));
    sock.on('close', () => cb.onclose && cb.onclose());
    return h;
  },
  tcpWrite(h, data) {
    if (data instanceof Uint8Array) h.sock.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    else if (data instanceof ArrayBuffer) h.sock.write(Buffer.from(data));
    else h.sock.write(String(data));
  },
  tcpClose(h) { try { h.sock.end(); } catch (e) {} },
};

// ── 3. Start Node http2 server ──
function startServer() {
  return new Promise((resolve) => {
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
      const url = headers[':path'];
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        if (url === '/tiny') {
          stream.respond({ ':status': 200 });
          stream.end('ok');
          return;
        }
        if (url === '/small') {
          stream.respond({ ':status': 200 });
          stream.end('x'.repeat(1024));
          return;
        }
        if (url === '/medium') {
          stream.respond({ ':status': 200 });
          stream.end('y'.repeat(16384));
          return;
        }
        stream.respond({ ':status': 404 });
        stream.end('notfound');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ── 4. Request helper ──
function doRequest(client, opts) {
  return new Promise((resolve, reject) => {
    let headers = null; const data = []; let errored = false;
    const st = client.request(opts, {
      onHeaders: (h) => { headers = h; },
      onData: (d) => { data.push(d); },
      onEnd: () => resolve({ headers, body: Buffer.concat(data.map(d => Buffer.from(d))) }),
      onError: (e) => { if (!errored) { errored = true; reject(e); } },
    });
    st.end();
  });
}

// ── 5. Benchmark runner ──
async function benchSequential(client, port, path, durationSec) {
  const reqOpts = { method: 'GET', path, authority: '127.0.0.1:' + port, scheme: 'http' };
  let count = 0;
  let bytes = 0;
  const deadline = Date.now() + durationSec * 1000;

  while (Date.now() < deadline) {
    const r = await doRequest(client, reqOpts);
    count++;
    bytes += r.body.length;
  }

  const elapsed = durationSec;
  return {
    rps: count / elapsed,
    total_requests: count,
    total_bytes: bytes,
    throughput_mbps: (bytes / (1024 * 1024)) / elapsed,
  };
}

async function benchMultiplex(client, port, concurrency, durationSec) {
  const reqOpts = { method: 'GET', path: '/small', authority: '127.0.0.1:' + port, scheme: 'http' };
  let count = 0;
  let bytes = 0;
  const deadline = Date.now() + durationSec * 1000;

  while (Date.now() < deadline) {
    const promises = [];
    for (let i = 0; i < concurrency; i++) {
      promises.push(doRequest(client, reqOpts));
    }
    const results = await Promise.all(promises);
    for (const r of results) {
      count++;
      bytes += r.body.length;
    }
  }

  const elapsed = durationSec;
  return {
    rps: count / elapsed,
    total_requests: count,
    total_bytes: bytes,
    throughput_mbps: (bytes / (1024 * 1024)) / elapsed,
    concurrency,
  };
}

// ── 6. Main ──
const { server, port } = await startServer();

try {
  const client = await HTTP2Client.connect({ host: '127.0.0.1', port, pal });

  const scenarios = [
    { name: 'tiny',      fn: () => benchSequential(client, port, '/tiny', DURATION) },
    { name: 'small',     fn: () => benchSequential(client, port, '/small', DURATION) },
    { name: 'medium',    fn: () => benchSequential(client, port, '/medium', DURATION) },
    { name: 'multiplex', fn: () => benchMultiplex(client, port, 8, DURATION) },
  ];

  const results = {};
  for (const sc of scenarios) {
    const r = await sc.fn();
    results[sc.name] = r;
    console.log(`${sc.name.padEnd(10)} rps=${r.rps.toFixed(1).padEnd(10)} bytes=${r.total_bytes} thr=${r.throughput_mbps.toFixed(2)} MB/s`);
  }

  console.log(JSON.stringify(results));
  await client.close();
} catch (e) {
  console.error('BENCH-FAIL:', e && e.stack || e);
  process.exit(1);
} finally {
  server.close();
}
