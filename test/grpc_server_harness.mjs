/**
 * gRPC server e2e harness (verification only — not part of the runtime bundle).
 *
 * Runs the REAL polyfill/src/{http-server,http2-server,grpc-server,grpc,http2,
 * hpack,protobuf}.js (esbuild-bundled to ESM) against real clients. Only the
 * transport is shimmed: `pal.tcpListen/tcpWrite/tcpClose` are backed by Node
 * `net`, so the h2 engine and serve() see the same byte streams they would in
 * the qzjs runtime.
 *
 * Coverage (HTTP/2 + gRPC Phase 3 acceptance):
 *   1. h2 server engine: Node http2.connect GET/POST round-trip, trailers,
 *      >64KB response (send-side flow control)
 *   2. gRPC server semantics: unary round-trip, error status mapping
 *      (handler-thrown StatusError → grpc-status), UNIMPLEMENTED, request
 *      metadata (incl. -bin), async handler, concurrent streams
 *   3. serve() dispatch: HTTP/1.1 + gRPC on ONE port (ALPN/preface sniffing),
 *      plaintext h2c preface sniffing across TCP fragments, h2-without-grpc
 *      returns 404
 *   4. @grpc/grpc-js client (peer modules at QZ_GRPC_PEER_MODULES or
 *      /tmp/grpcpeer) — a real standard gRPC peer
 *
 * Usage: node test/grpc_server_harness.mjs
 * Exits 0 on all-pass, 1 on any failure.
 */
import net from 'node:net';
import http from 'node:http';
import http2 from 'node:http2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { buildSync } = require(path.resolve(__dirname, '..', 'src', 'polyfill', 'node_modules', 'esbuild'));
const SRC = path.resolve(__dirname, '..', 'src', 'polyfill', 'src');
const PROTO_TEXT = `
syntax = "proto3";
package helloworld;
service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply) {}
  rpc Fail (HelloRequest) returns (HelloReply) {}
  rpc Slow (HelloRequest) returns (HelloReply) {}
  rpc EchoMeta (HelloRequest) returns (HelloReply) {}
  rpc Big (HelloRequest) returns (HelloReply) {}
  rpc CountUp (HelloRequest) returns (stream HelloReply) {}
  rpc CountList (HelloRequest) returns (stream HelloReply) {}
  rpc Collect (stream HelloRequest) returns (HelloReply) {}
  rpc Chat (stream HelloRequest) returns (stream HelloReply) {}
}
message HelloRequest { string name = 1; repeated string tags = 2; }
message HelloReply { string message = 1; int32 count = 2; }
`;

// ── bundle the qzjs server stack to a temp ESM file ──
const entryPath = '/tmp/qz_server_entry.mjs';
fs.writeFileSync(entryPath,
  `export { setupHttpServer } from '${SRC}/http-server.js';\n` +
  `export { setupGrpcStack } from '${SRC}/grpc-stack.js';\n`);
const bundlePath = '/tmp/grpc_server_harness.bundle.mjs';
buildSync({
  entryPoints: [entryPath], bundle: true, format: 'esm',
  outfile: bundlePath, write: true, logLevel: 'silent',
});

// ── pal shim over Node net (mirrors the qzjs pal.tcp* contract) ──
// Setting pal._fragment = N>1 splits every inbound chunk into N-byte pieces,
// forcing the h2c connection preface / frame headers across many TCP segments.
const pal = {
  _fragment: 0,
  tcpConnect(host, port, cb) {
    const sock = net.connect({ host, port });
    sock.setNoDelay(true);
    const h = { sock };
    sock.on('connect', () => cb.onconnect && cb.onconnect());
    sock.on('data', (dd) => cb.ondata && cb.ondata(dd.buffer.slice(dd.byteOffset, dd.byteOffset + dd.byteLength)));
    sock.on('error', (e) => cb.onerror && cb.onerror(e.message));
    sock.on('close', () => cb.onclose && cb.onclose());
    return h;
  },
  tcpListen(port, hostname, backlog, onconnection, tls) {
    const srv = net.createServer();
    srv.on('connection', (sock) => {
      sock.setNoDelay(true);
      const conn = { sock, alpn: null };
      const queued = [];
      const deliver = (ab) => {
        if (conn.ondata) conn.ondata(ab);
        else queued.push(ab);
      };
      sock.on('data', (d) => {
        const ab = d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
        if (pal._fragment > 1 && ab.byteLength > 1) {
          const u8 = new Uint8Array(ab);
          for (let i = 0; i < u8.length; i += pal._fragment) {
            deliver(u8.subarray(i, Math.min(u8.length, i + pal._fragment)).slice().buffer);
          }
        } else deliver(ab);
      });
      sock.on('error', (e) => conn.onerror && conn.onerror(e.message));
      sock.on('close', () => conn.onclose && conn.onclose());
      onconnection(conn);
      while (queued.length && conn.ondata) conn.ondata(queued.shift());
    });
    const ready = new Promise((res) => srv.once('listening', res));
    srv.listen(port, hostname);
    return { srv, ready, close() { try { srv.close(); } catch (e) {} } };
  },
  tcpWrite(conn, data) {
    return new Promise((resolve, reject) => {
      const b = data instanceof Uint8Array
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(data);
      conn.sock.write(b, (err) => (err ? reject(err) : resolve(b.length)));
    });
  },
  tcpClose(conn) { try { conn.sock.end(); } catch (e) {} },
  tcpCloseListener(l) { try { l.srv.close(); } catch (e) {} },
};

// __native_inject__ must be set BEFORE importing the bundle (pal.js reads it
// at module init).
globalThis.__native_inject__ = pal;
globalThis.qzjs = globalThis.qzjs || {};
const { setupHttpServer, setupGrpcStack } = await import(bundlePath);
setupHttpServer(pal);
setupGrpcStack();
const grpc = globalThis.grpc;
const H2 = globalThis.qzjs.http2;

// ── tiny test harness ───────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; failures.push(name + ': ' + (e && e.stack || e)); console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
}
function skip(name, why) { skipped++; console.log('  SKIP ' + name + ' (' + why + ')'); }
function eq(a, b, what) {
  if (a !== b) throw new Error((what || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}
function ok(cond, what) { if (!cond) throw new Error(what || 'condition failed'); }
function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function waitPort(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      await new Promise((res, rej) => {
        const s = net.connect(port, '127.0.0.1');
        s.once('connect', () => { s.destroy(); res(); });
        s.once('error', rej);
      });
      return;
    } catch (e) { await new Promise((r) => setTimeout(r, 20)); }
  }
  throw new Error('port ' + port + ' never accepted connections');
}

// ════════════════════════════════════════════════════════════════════
//  A. h2 server engine (raw HTTP2ServerSession, no serve())
// ════════════════════════════════════════════════════════════════════
async function rawH2Server(handler) {
  const port = await freePort();
  const l = pal.tcpListen(port, '127.0.0.1', 128, (conn) => {
    const session = new H2.HTTP2ServerSession({ pal });
    session.attach(conn);
    session.onStream(handler);
  });
  await l.ready;
  await waitPort(port);
  return { port, close: l.close };
}

async function http2RoundTrip(port, { method = 'GET', path: p = '/x', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const client = http2.connect('http://127.0.0.1:' + port);
    client.on('error', reject);
    const req = client.request({ ':method': method, ':path': p, ':scheme': 'http' });
    const chunks = [];
    let respHeaders = null, trailerHeaders = null;
    req.on('response', (h) => { respHeaders = h; });
    req.on('data', (d) => chunks.push(Buffer.from(d)));
    req.on('trailers', (h) => { trailerHeaders = h; });
    req.on('end', () => {
      client.close();
      resolve({ headers: respHeaders, trailers: trailerHeaders, body: Buffer.concat(chunks) });
    });
    req.on('error', (e) => { client.close(); reject(e); });
    req.end(body || undefined);
  });
}

console.log('\nh2 server engine (peer: node:http2 client)');
const echoHandler = (st) => {
  const chunks = [];
  st.onData = (c) => chunks.push(c);
  st.onEnd = () => {
    let total = 0; for (const c of chunks) total += c.length;
    const body = new Uint8Array(total); let o = 0;
    for (const c of chunks) { body.set(c, o); o += c.length; }
    st.respond([[':status', '200'], ['content-type', 'text/plain']]);
    st.write(body);
    st.end([['x-trailer', 'done']]);
  };
};
const raw = await rawH2Server(echoHandler);
await t('connection preface + SETTINGS + GET round-trip', async () => {
  const r = await http2RoundTrip(raw.port, { method: 'GET', path: '/hello' });
  eq(r.headers[':status'], 200, ':status');
  eq(r.body.toString(), '', 'empty GET body');
});
await t('POST body echo + trailers', async () => {
  const r = await http2RoundTrip(raw.port, { method: 'POST', path: '/echo', body: 'hello h2' });
  eq(r.headers[':status'], 200, ':status');
  eq(r.body.toString(), 'hello h2', 'echoed body');
  eq(r.trailers['x-trailer'], 'done', 'trailer HEADERS delivered');
});
await t('large response (>64KB) flows via WINDOW_UPDATE', async () => {
  const big = await rawH2Server((st) => {
    st.onEnd = () => {
      st.respond([[':status', '200']]);
      const b = new Uint8Array(300 * 1024).fill(65);
      st.write(b.subarray(0, 100 * 1024));
      st.write(b.subarray(100 * 1024, 200 * 1024));
      st.write(b.subarray(200 * 1024));
      st.end([]);
    };
  });
  const r = await http2RoundTrip(big.port, { method: 'GET', path: '/' });
  eq(r.body.length, 300 * 1024, 'full 300KB received');
  ok(r.body.every((b) => b === 65), 'content intact');
  big.close();
});
raw.close();

// ════════════════════════════════════════════════════════════════════
//  B. gRPC server via serve(options.grpc) — @grpc/grpc-js client
// ════════════════════════════════════════════════════════════════════
let peer = null;
try {
  const base = process.env.QZ_GRPC_PEER_MODULES || '/tmp/grpcpeer/node_modules';
  peer = { grpc: require(path.join(base, '@grpc', 'grpc-js')), loader: require(path.join(base, '@grpc', 'proto-loader')) };
} catch (e) { peer = null; }

if (!peer) {
  skip('gRPC server via @grpc/grpc-js', 'package not resolvable; set QZ_GRPC_PEER_MODULES');
} else {
  const grpcjs = peer.grpc;
  const loader = peer.loader;
  const protoTmp = path.join(os.tmpdir(), 'qz_server_helloworld.proto');
  fs.writeFileSync(protoTmp, PROTO_TEXT);
  const def = loader.loadSync(protoTmp, { keepCase: true, longs: Number, defaults: true });
  const pkg = grpcjs.loadPackageDefinition(def);

  async function startGrpcServer(opts) {
    const port = await freePort();
    const reg = grpc.loadProto(PROTO_TEXT);
    const server = grpc.createServer();
    server.addService(reg, opts.handlers);
    const active = serve({ port, grpc: server }, (req) => 'http1:' + req.url);
    await waitPort(port);
    return { port, server, active };
  }

  console.log('\ngRPC server semantics (client: @grpc/grpc-js, plaintext h2c, same port as HTTP/1.1)');
  const srv = await startGrpcServer({
    handlers: {
      SayHello: (call) => ({
        message: 'Hello ' + call.request.name,
        count: (call.request.tags || []).length,
      }),
      Fail: () => { throw new grpc.StatusError('no such ☺ thing', grpc.Status.NOT_FOUND); },
      Slow: (call) => new Promise((res) => setTimeout(() => res({ message: 'late ' + call.request.name }), 150)),
      EchoMeta: (call) => {
        const text = call.metadata['x-custom'] || '';
        const bin = call.metadata['x-bin'] instanceof Uint8Array
          ? Array.from(call.metadata['x-bin']).join(',') : '';
        return { message: 'meta:' + text + ':' + bin, count: 0 };
      },
      Big: () => ({ message: 'B'.repeat(200 * 1024), count: 0 }),
      // Server streaming: async generator (promise-backed iteration) ...
      CountUp: async function* (call) {
        const n = (call.request.tags || []).length;
        for (let i = 1; i <= n; i++) yield { message: 'chunk ' + i, count: i };
      },
      // ... and a plain array (sync iterator).
      CountList: (call) => Array.from({ length: (call.request.tags || []).length },
                                      (_, i) => ({ message: 'item ' + (i + 1), count: i + 1 })),
      // Client streaming: the whole request stream arrives as an array
      // (call.request), handler returns the single reply.
      Collect: (call) => {
        const names = (call.request || []).map((r) => r.name);
        return { message: 'collected:' + names.join(','), count: names.length };
      },
      // Bidi: whole request array in, whole response iterable out.
      Chat: (call) => (call.request || []).map((r) => ({ message: 'echo ' + r.name, count: 0 })),
    },
  });
  const greeter = new pkg.helloworld.Greeter(
    '127.0.0.1:' + srv.port, grpcjs.credentials.createInsecure());

  await t('unary round-trip, protobuf reply decoded by grpc-js', async () => {
    const r = await new Promise((res, rej) =>
      greeter.SayHello({ name: 'grpc-js', tags: ['a', 'b'] }, (e, v) => (e ? rej(e) : res(v))));
    eq(r.message, 'Hello grpc-js', 'message');
    eq(r.count, 2, 'count');
  });

  await t('handler-thrown StatusError → grpc-status mapped', async () => {
    const err = await new Promise((res) => greeter.Fail({ name: 'x' }, (e) => res(e)));
    ok(err, 'expected error');
    eq(err.code, grpcjs.status.NOT_FOUND, 'code');
    ok(/no such ☺ thing/.test(err.details || ''), 'details: ' + (err.details || ''));
  });

  await t('unknown method → UNIMPLEMENTED', async () => {
    const HR = def['helloworld.HelloRequest'];
    const err = await new Promise((res) =>
      greeter.makeUnaryRequest(
        '/helloworld.Greeter/Nope',
        HR.serialize, HR.deserialize,
        { name: 'x' }, (e) => res(e)));
    ok(err, 'expected error');
    eq(err.code, grpcjs.status.UNIMPLEMENTED, 'code');
  });

  await t('request metadata incl. -bin decoded for the handler', async () => {
    const md = new grpcjs.Metadata();
    md.set('x-custom', 'ping');
    md.set('x-bin', Buffer.from([1, 2, 250]));
    const r = await new Promise((res, rej) =>
      greeter.EchoMeta({ name: 'm' }, md, (e, v) => (e ? rej(e) : res(v))));
    eq(r.message, 'meta:ping:1,2,250', 'text + binary metadata round-tripped');
  });

  await t('async handler (Promise) resolves', async () => {
    const r = await new Promise((res, rej) =>
      greeter.Slow({ name: 's' }, (e, v) => (e ? rej(e) : res(v))));
    eq(r.message, 'late s', 'message');
  });

  await t('large response (>64KB) — send-side flow control', async () => {
    const r = await new Promise((res, rej) =>
      greeter.Big({ name: 'x' }, (e, v) => (e ? rej(e) : res(v))));
    eq(r.message.length, 200 * 1024, '200KB message received intact');
  });

  await t('concurrent unary calls on one connection', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      new Promise((res, rej) => greeter.SayHello({ name: 'c' + i }, (e, v) => (e ? rej(e) : res(v))))));
    eq(rs.map((r) => r.message).join('|'), Array.from({ length: 10 }, (_, i) => 'Hello c' + i).join('|'));
  });
  await t('qzjs client → qzjs server (own stack interop)', async () => {
    const regOwn = grpc.loadProto(PROTO_TEXT);
    const sayHelloMethod = regOwn.service('helloworld.Greeter').method('SayHello');
    const qch = grpc.createInsecureChannel('127.0.0.1:' + srv.port);
    const qr = await qch.invoke(sayHelloMethod, { name: 'own', tags: ['t'] });
    eq(qr.message, 'Hello own', 'message');
    eq(qr.count, 1, 'count');
    let err = null;
    try { await qch.invoke('/helloworld.Greeter/Fail', { name: 'x' }, { registry: regOwn }); }
    catch (e) { err = e; }
    ok(err && err.code === grpc.Status.NOT_FOUND, 'qzjs client saw NOT_FOUND, got ' + (err && err.code));
    await qch.close();
  });

  await t('server streaming (async generator): grpc-js client gets every message + OK', async () => {
    const msgs = [];
    await new Promise((res, rej) => {
      const s = greeter.CountUp({ name: 'x', tags: ['a', 'b', 'c'] });
      s.on('data', (m) => msgs.push(m));
      s.on('error', rej);
      s.on('end', res);
    });
    eq(msgs.length, 3, 'message count');
    eq(msgs.map((m) => m.message).join('|'), 'chunk 1|chunk 2|chunk 3', 'messages in order');
    eq(msgs[2].count, 3, 'last payload intact');
  });

  await t('server streaming (array): qzjs client invokeStream collects all messages', async () => {
    const regOwn = grpc.loadProto(PROTO_TEXT);
    const countList = regOwn.service('helloworld.Greeter').method('CountList');
    const qch = grpc.createInsecureChannel('127.0.0.1:' + srv.port);
    const rs = await qch.invokeStream(countList, { name: 'x', tags: ['p', 'q'] });
    eq(rs.length, 2, 'message count');
    eq(rs.map((r) => r.message).join('|'), 'item 1|item 2', 'messages in order');
    eq(rs[1].count, 2, 'payload intact');
    await qch.close();
  });
  await t('client streaming: grpc-js writable stream → whole array to handler', async () => {
    const reply = await new Promise((res, rej) => {
      const call = greeter.Collect((e, v) => (e ? rej(e) : res(v)));
      call.write({ name: 'a' });
      call.write({ name: 'b' });
      call.write({ name: 'c' });
      call.end();
    });
    eq(reply.message, 'collected:a,b,c', 'message');
    eq(reply.count, 3, 'count');
  });

  await t('client streaming: empty request stream → empty array to handler', async () => {
    const reply = await new Promise((res, rej) => {
      const call = greeter.Collect((e, v) => (e ? rej(e) : res(v)));
      call.end();
    });
    eq(reply.message, 'collected:', 'message');
    eq(reply.count, 0, 'count');
  });

  await t('bidi: grpc-js duplex, 3↔3 against qzjs server', async () => {
    const msgs = [];
    const done = new Promise((res, rej) => {
      const call = greeter.Chat();
      call.on('data', (m) => msgs.push(m));
      call.on('end', res);
      call.on('error', rej);
      call.write({ name: 'a' });
      call.write({ name: 'b' });
      call.write({ name: 'c' });
      call.end();
    });
    await done;
    eq(msgs.length, 3, 'message count');
    eq(msgs.map((m) => m.message).join('|'), 'echo a|echo b|echo c', 'messages in order');
  });

  await t('bidi: qzjs client invokeBidi against qzjs server (own stack)', async () => {
    const regOwn = grpc.loadProto(PROTO_TEXT);
    const chat = regOwn.service('helloworld.Greeter').method('Chat');
    const qch = grpc.createInsecureChannel('127.0.0.1:' + srv.port);
    const rs = await qch.invokeBidi(chat, [{ name: 'x' }, { name: 'y' }]);
    eq(rs.length, 2, 'message count');
    eq(rs.map((r) => r.message).join('|'), 'echo x|echo y', 'messages in order');
    await qch.close();
  });


  await t('HTTP/1.1 and gRPC share the same serve() port', async () => {
    const body = await new Promise((res, rej) => {
      http.get('http://127.0.0.1:' + srv.port + '/x', (rsp) => {
        let b = '';
        rsp.on('data', (d) => (b += d));
        rsp.on('end', () => res(b));
      }).on('error', rej);
    });
    eq(body, 'http1:/x', 'HTTP/1.1 handler on the gRPC port');
    const r = await new Promise((res, rej) =>
      greeter.SayHello({ name: 'again' }, (e, v) => (e ? rej(e) : res(v))));
    eq(r.message, 'Hello again', 'grpc after HTTP/1.1');
  });

  await t('server.close() tears down cleanly', async () => {
    srv.active.close();
    greeter.close();
    await new Promise((res) => setTimeout(res, 50));
  });

  // ── preface + frames arriving byte-by-byte through serve() sniffing ──
  console.log('\nserve() with byte-fragmented plaintext (h2c preface sniffing)');
  const srvF = await startGrpcServer({
    handlers: { SayHello: (call) => ({ message: 'frag ' + call.request.name, count: 0 }) },
  });
  const greeterF = new pkg.helloworld.Greeter(
    '127.0.0.1:' + srvF.port, grpcjs.credentials.createInsecure());
  pal._fragment = 1;
  try {
    await t('grpc-js call works when preface arrives byte-by-byte', async () => {
      const r = await new Promise((res, rej) =>
        greeterF.SayHello({ name: 'byte' }, (e, v) => (e ? rej(e) : res(v))));
      eq(r.message, 'frag byte', 'message');
    });
    await t('HTTP/1.1 still parsed under fragmentation', async () => {
      const body = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:' + srvF.port + '/y', (rsp) => {
          let b = '';
          rsp.on('data', (d) => (b += d));
          rsp.on('end', () => res(b));
        }).on('error', rej);
      });
      eq(body, 'http1:/y', 'HTTP/1.1 body under fragmentation');
    });
  } finally {
    pal._fragment = 0;
  }
  srvF.active.close();
  greeterF.close();
  await new Promise((res) => setTimeout(res, 50));
}

// ════════════════════════════════════════════════════════════════════
//  C. serve() without options.grpc: h2 is still served, requests → 404
// ════════════════════════════════════════════════════════════════════
console.log('\nserve() without a gRPC server (h2 requests still negotiate)');
{
  const port = await freePort();
  const active = serve({ port }, () => 'plain');
  await waitPort(port);
  await t('h2 connect succeeds, generic request → 404', async () => {
    const r = await http2RoundTrip(port, { method: 'GET', path: '/' });
    eq(r.headers[':status'], 404, ':status');
  });
  await t('HTTP/1.1 unaffected when no gRPC configured', async () => {
    const body = await new Promise((res, rej) => {
      http.get('http://127.0.0.1:' + port + '/p', (rsp) => {
        let b = '';
        rsp.on('data', (d) => (b += d));
        rsp.on('end', () => res(b));
      }).on('error', rej);
    });
    eq(body, 'plain', 'HTTP/1.1 body');
  });
  active.close();
  await new Promise((res) => setTimeout(res, 30));
}

console.log('\ngrpc server: ' + passed + ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
if (failed) { console.log('\n' + failures.join('\n')); process.exit(1); }
setTimeout(() => process.exit(0), 50).unref();
