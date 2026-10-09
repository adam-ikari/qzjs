/**
 * HTTP/2 client e2e harness (verification only — not part of the runtime bundle).
 *
 * Runs the REAL polyfill/src/http2.js + hpack.js (esbuild-bundled to ESM) against
 * a REAL Node built-in http2 server. The only thing shimmed is the transport:
 * `pal.tcpConnect/tcpWrite/tcpClose` are backed by Node `net` sockets, so the h2
 * engine sees an identical plaintext byte stream to what it would over
 * pal.tcpConnect in the qzjs runtime.
 *
 * Usage: node test/h2_client_harness.mjs
 * Exits 0 on all-pass, 1 on any failure.
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

// 1. bundle the h2 stack to a temp ESM file
const bundlePath = '/tmp/h2_client.bundle.mjs';
buildSync({
  entryPoints: [path.join(SRC, 'http2.js')],
  bundle: true, format: 'esm', outfile: bundlePath, write: true, logLevel: 'silent',
});
const { HTTP2Client } = await import(bundlePath);

// 2. pal shim over Node net (mirrors qzjs pal.tcp* contract)
const pal = {
  tcpConnect(host, port, cb /*, opts */) {
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

// 3. start a Node http2 server
function startServer() {
  return new Promise((resolve) => {
    const server = http2.createServer({ maxHeaderSize: 1 << 20, settings: { maxHeaderListSize: 1 << 20 } });
    server.on('stream', (stream, headers) => {
      const url = headers[':path'];
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const body = Buffer.concat(chunks);
        if (url === '/echo') {
          stream.respond({ ':status': 200, 'content-type': 'text/plain', 'x-echo-len': String(body.length) });
          stream.end(body);
          return;
        }
        if (url === '/big') {
          const payload = Buffer.alloc(200 * 1024, 0x41); // 200KB 'A'
          stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' });
          stream.end(payload);
          return;
        }
        if (url === '/trailers') {
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0', 'grpc-message': 'ok' }));
          stream.end(Buffer.from('000000000568656c6c6f', 'hex')); // gRPC prefix + "hello"
          return;
        }
        if (url === '/many') {
          stream.respond({ ':status': 200, 'x-path': url, 'x-n': headers['x-n'] || '' });
          stream.end('resp:' + (headers['x-n'] || ''));
          return;
        }
        if (url === '/bigecho') {
          stream.respond({ ':status': 200, 'content-type': 'application/octet-stream', 'x-len': String(body.length) });
          stream.end(body);
          return;
        }
        if (url === '/hdrs') {
          // respond with a large header block (>16KB) → Node splits into
          // HEADERS + CONTINUATION; the client must reassemble them.
          const resp = { ':status': 200 };
          for (let i = 0; i < 400; i++) resp['x-h' + i] = 'value-' + i + '-' + 'z'.repeat(60);
          stream.respond(resp);
          stream.end('ok');
          return;
        }
        if (url === '/reset') {
          stream.close(8 /* NGHTTP2_CANCEL */);
          return;
        }
        if (url === '/status500') {
          stream.respond({ ':status': 500 });
          stream.end('boom');
          return;
        }
        stream.respond({ ':status': 200, 'content-type': 'text/plain', 'x-custom': 'yes' });
        stream.end('Hello h2 from Node');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ok  ' + msg); } else { fail++; console.log('  FAIL ' + msg); } }

function doRequest(client, opts, body) {
  return new Promise((resolve, reject) => {
    let headers = null; const data = []; let errored = false;
    const st = client.request(opts, {
      onHeaders: (h) => { headers = h; },
      onData: (d) => { data.push(d); },
      onEnd: () => resolve({ headers, body: Buffer.concat(data.map(d => Buffer.from(d))) }),
      onError: (e) => { if (!errored) { errored = true; reject(e); } },
    });
    if (body != null) st.end(body); else st.end();
  });
}

const { server, port } = await startServer();
console.log('h2 server on 127.0.0.1:' + port);

try {
  const client = await HTTP2Client.connect({ host: '127.0.0.1', port, pal, maxHeaderSize: 1 << 20 });
  ok(client && client._state === 'open', 'connect() resolves with open client');

  // basic GET
  {
    const r = await doRequest(client, { method: 'GET', path: '/', authority: 'localhost:' + port, scheme: 'http' });
    const status = r.headers.find(x => x[0] === ':status')[1];
    ok(status === '200', 'GET :status 200, got ' + status);
    ok(r.body.toString() === 'Hello h2 from Node', 'GET body, got ' + JSON.stringify(r.body.toString()));
    const xc = r.headers.find(x => x[0] === 'x-custom');
    ok(xc && xc[1] === 'yes', 'GET custom header x-custom=yes');
  }

  // POST echo body
  {
    const payload = 'the quick brown fox jumps over the lazy dog '.repeat(10);
    const r = await doRequest(client, { method: 'POST', path: '/echo', authority: 'localhost:' + port, scheme: 'http' }, payload);
    ok(r.body.toString() === payload, 'POST /echo round-trips body (' + payload.length + 'B)');
    ok(r.headers.find(x => x[0] === 'x-echo-len')[1] === String(payload.length), 'echo length header matches');
  }

  // large response (flow control + DATA chunking > 64KB window)
  {
    const r = await doRequest(client, { method: 'GET', path: '/big', authority: 'localhost:' + port, scheme: 'http' });
    ok(r.body.length === 200 * 1024, 'GET /big 200KB received, got ' + r.body.length);
    ok(r.body.every(b => b === 0x41), 'GET /big content all 0x41');
  }

  // trailers (gRPC-style): onHeaders fires for initial + trailers
  {
    let headerBlocks = 0, trailer = null;
    const st = client.request({ method: 'POST', path: '/trailers', authority: 'localhost:' + port, scheme: 'http', headers: { 'te': 'trailers', 'content-type': 'application/grpc' } }, {
      onHeaders: (h) => { headerBlocks++; const gs = h.find(x => x[0] === 'grpc-status'); if (gs) trailer = gs[1]; },
      onData: () => {},
      onEnd: () => {},
      onError: () => {},
    });
    st.end(Buffer.from('0000000000', 'hex'));
    await new Promise(res => setTimeout(res, 400));
    ok(headerBlocks === 2, 'trailers: two HEADERS blocks, got ' + headerBlocks);
    ok(trailer === '0', 'trailers: grpc-status=0 in trailer block, got ' + trailer);
  }

  // concurrent streams (multiplexing)
  {
    const N = 8;
    const reqs = [];
    for (let i = 0; i < N; i++) {
      reqs.push(doRequest(client, { method: 'GET', path: '/many', authority: 'localhost:' + port, scheme: 'http', headers: { 'x-n': String(i) } }));
    }
    const rs = await Promise.all(reqs);
    let allOk = true;
    for (let i = 0; i < N; i++) {
      const n = rs[i].headers.find(x => x[0] === 'x-n')[1];
      if (n !== String(i) || rs[i].body.toString() !== 'resp:' + i) allOk = false;
    }
    ok(allOk, 'concurrent ' + N + ' streams each matched their response');
  }

  // non-200 status
  {
    const r = await doRequest(client, { method: 'GET', path: '/status500', authority: 'localhost:' + port, scheme: 'http' });
    ok(r.headers.find(x => x[0] === ':status')[1] === '500', 'GET /status500 :status 500');
    ok(r.body.toString() === 'boom', 'status500 body');
  }

  // send-side flow control: large POST body (300KB > initial window)
  {
    const big = Buffer.alloc(300 * 1024, 0x5a);
    const r = await doRequest(client, { method: 'POST', path: '/bigecho', authority: 'localhost:' + port, scheme: 'http' }, big);
    ok(r.headers.find(x => x[0] === 'x-len')[1] === String(big.length), 'POST /bigecho server saw ' + big.length + 'B');
    ok(r.body.length === big.length && r.body.every(b => b === 0x5a), 'POST /bigecho body round-tripped intact');
  }

  // CONTINUATION: server sends a >16KB response header block split across
  // HEADERS + CONTINUATION frames; the client must reassemble + decode all.
  {
    const r = await doRequest(client, { method: 'GET', path: '/hdrs', authority: 'localhost:' + port, scheme: 'http' });
    let n = 0;
    for (const [k] of r.headers) if (k.startsWith('x-h')) n++;
    ok(n === 400, 'CONTINUATION: client reassembled all 400 response headers, got ' + n);
  }

  // RST_STREAM received → onError fires, connection stays usable
  {
    let err = null;
    try { await doRequest(client, { method: 'GET', path: '/reset', authority: 'localhost:' + port, scheme: 'http' }); }
    catch (e) { err = e; }
    ok(err && /RST_STREAM/.test(err.message), 'RST_STREAM from server → onError, got ' + (err && err.message));
    const r2 = await doRequest(client, { method: 'GET', path: '/', authority: 'localhost:' + port, scheme: 'http' });
    ok(r2.body.toString() === 'Hello h2 from Node', 'connection still usable after RST_STREAM');
  }

  // client-initiated cancel: stream removed, connection survives
  {
    let cancelled = false;
    const st = client.request({ method: 'GET', path: '/big', authority: 'localhost:' + port, scheme: 'http' }, {
      onHeaders: () => {}, onData: () => { if (!cancelled) { cancelled = true; st.cancel(); } }, onEnd: () => {}, onError: () => {},
    });
    st.end();
    await new Promise(res => setTimeout(res, 200));
    ok(cancelled && !client._streams.has(st.id), 'client cancel() removed stream');
    const r3 = await doRequest(client, { method: 'GET', path: '/', authority: 'localhost:' + port, scheme: 'http' });
    ok(r3.body.toString() === 'Hello h2 from Node', 'connection usable after client cancel');
  }

  // ping
  {
    await client.ping();
    ok(true, 'ping() resolved on ACK');
  }

  // graceful close
  {
    await client.close();
    ok(client._state === 'closed', 'close() -> state closed');
  }
} catch (e) {
  fail++;
  console.log('  FAIL exception: ' + (e && e.stack || e));
}

server.close();
setTimeout(() => {
  console.log('H2-E2E: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}, 100);
