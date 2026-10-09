/**
 * gRPC client e2e harness (verification only — not part of the runtime bundle).
 *
 * Runs the REAL polyfill/src/grpc.js (+ http2.js, hpack.js, protobuf.js,
 * esbuild-bundled to ESM) against real HTTP/2 servers. Only the
 * transport is shimmed: `pal.tcpConnect/tcpWrite/tcpClose` are backed by Node
 * `net` sockets, so the h2 engine sees the same byte stream it would in the
 * qzjs runtime.
 *
 * Two peers, on purpose:
 *   1. A hand-written Node http2 server that encodes/decodes protobuf BYTES
 *      itself (no protobuf library anywhere near it). This is the deterministic,
 *      dependency-free core: it proves the 5-byte gRPC framing, the trailers
 *      status model, metadata, deadline and wire compatibility of our own
 *      protobuf.js against an independent reading of the spec.
 *   2. @grpc/grpc-js, if resolvable (QZ_GRPC_PEER_MODULES or a global
 *      install). A genuine standard peer — the strongest interop evidence.
 *      Skipped (loudly) when absent, since installing it needs network.
 *
 * Usage: node test/grpc_harness.mjs
 * Exits 0 on all-pass (skips allowed), 1 on any failure.
 */
import http2 from 'node:http2';
import net from 'node:net';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { buildSync } = require(path.resolve(__dirname, '..', 'src', 'polyfill', 'node_modules', 'esbuild'));
const SRC = path.resolve(__dirname, '..', 'src', 'polyfill', 'src');

// 1. bundle the whole gRPC stack to a temp ESM file
const bundlePath = '/tmp/grpc_harness.bundle.mjs';
buildSync({
  entryPoints: [path.join(SRC, 'grpc.js')],
  bundle: true, format: 'esm', outfile: bundlePath, write: true, logLevel: 'silent',
});
const { setupGrpc } = await import(bundlePath);

// 2. pal shim over Node net (mirrors the qzjs pal.tcp* contract)
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
    return new Promise((resolve, reject) => {
      h.sock.write(data, (err) => (err ? reject(err) : resolve(data.length)));
    });
  },
  tcpClose(h) { try { h.sock.end(); } catch (e) {} },
};
setupGrpc(pal);
const grpc = globalThis.grpc;

// ── tiny test harness ───────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; failures.push(name + ': ' + (e && e.stack || e)); console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
}
function skip(name, why) { skipped++; console.log('  SKIP ' + name + ' (' + why + ')'); }
function eq(a, b, what) {
  if (a !== b) {
    if (typeof a === 'bigint') a = Number(a);
    if (typeof b === 'bigint') b = Number(b);
    if (a !== b) throw new Error((what || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
  }
}
function ok(cond, what) { if (!cond) throw new Error(what || 'condition failed'); }

// ── hand-rolled protobuf wire codec (independent of protobuf.js) ───
// Only what helloworld.proto needs: length-delimited strings and varints.
function varint(n) {
  const out = [];
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return Uint8Array.from(out);
}
function readVarint(buf, pos) {
  let r = 0, shift = 1, i = pos;
  for (;;) { const b = buf[i++]; r += (b & 0x7f) * shift; if (!(b & 0x80)) break; shift *= 128; }
  return [r, i];
}
/** HelloReply { string message = 1; int32 count = 2; } */
function rawEncodeReply({ message, count }) {
  const parts = [];
  if (message != null) {
    const s = new TextEncoder().encode(message);
    parts.push(Uint8Array.from([0x0a]), varint(s.length), s);
  }
  if (count) parts.push(Uint8Array.from([0x10]), varint(count));
  let len = 0; for (const p of parts) len += p.length;
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** HelloRequest { string name = 1; repeated string tags = 2; } */
function rawDecodeRequest(bytes) {
  const req = { name: '', tags: [] };
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i++];
    const field = tag >> 3, wire = tag & 7;
    if (wire !== 2) throw new Error('raw codec: unexpected wire type ' + wire);
    const [len, j] = readVarint(bytes, i); i = j + len;
    const s = new TextDecoder().decode(bytes.subarray(j, j + len));
    if (field === 1) req.name = s; else if (field === 2) req.tags.push(s);
  }
  return req;
}
/** gRPC Length-Prefixed-Message: [flag:1][len:4 BE][payload] */
function rawFrame(payload) {
  const out = new Uint8Array(5 + payload.length);
  out[0] = 0;
  out[1] = (payload.length >>> 24) & 255; out[2] = (payload.length >>> 16) & 255;
  out[3] = (payload.length >>> 8) & 255; out[4] = payload.length & 255;
  out.set(payload, 5);
  return out;
}
function rawUnframe(buf) {
  if (buf.length < 5) throw new Error('raw peer: short frame ' + buf.length);
  const len = ((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]) >>> 0;
  if (len !== buf.length - 5) throw new Error('raw peer: frame length mismatch ' + len + ' vs ' + (buf.length - 5));
  return buf.subarray(5);
}

/* Unframe every gRPC message in a byte blob (client-streaming requests send
 * several length-prefixed messages back to back). */
function rawUnframeAll(buf) {
  const out = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    const len = ((buf[i + 1] << 24) | (buf[i + 2] << 16) | (buf[i + 3] << 8) | buf[i + 4]) >>> 0;
    if (i + 5 + len > buf.length) throw new Error('raw peer: truncated frame len ' + len);
    out.push(buf.subarray(i + 5, i + 5 + len));
    i += 5 + len;
  }
  if (i !== buf.length) throw new Error('raw peer: trailing garbage ' + (buf.length - i) + ' bytes');
  return out;
}

// ── the hand-written gRPC-over-http2 peer ──────────────────────────
// handlers: { '/pkg.Svc/M': (req, ctx) => ({reply|status|...}) }
function startRawServer(handlers) {
  const seen = [];   // one entry per call: {path, headers, req, error}
  const srv = http2.createServer({ settings: { enablePush: false } });
  srv.on('stream', (stream, headers) => {
    const ctx = { headers, seen };
    const chunks = [];
    let settled = false;
    const path_ = headers[':path'];
    seen.push({ path: path_, headers });
    const entry = seen[seen.length - 1];
    stream.on('data', (d) => chunks.push(new Uint8Array(d)));
    stream.on('aborted', () => { entry.aborted = true; });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      let total = 0; for (const c of chunks) total += c.length;
      const all = new Uint8Array(total); let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      entry.raw = all;
      const h = handlers[path_];
      if (!h) {
        // Trailers-Only form: status arrives in the SAME header block, no DATA.
        stream.respond({ ':status': 200, 'content-type': 'application/grpc',
                         'grpc-status': '12', 'grpc-message': 'unimplemented' }, { endStream: true });
        return;
      }
      // Handlers receive the full request message stream as an array of
      // unframed payloads ([] for an empty request stream) — one entry per
      // gRPC message, so client-streaming/bidi requests are visible whole.
      let r;
      try { r = h(all.length ? rawUnframeAll(all) : [], ctx); }
      catch (e) {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc',
                         'grpc-status': '13', 'grpc-message': String(e.message) }, { endStream: true });
        return;
      }
      const delay = r.delayMs || 0;
      setTimeout(() => {
        if (stream.destroyed || entry.aborted) return;
        if (r.trailersOnly) {
          // Trailers-Only: status in the SAME header block, no DATA at all.
          stream.respond({ ':status': r.httpStatus || 200, 'content-type': 'application/grpc',
                           'grpc-status': String(r.status || 0),
                           ...(r.message ? { 'grpc-message': r.message } : {}) }, { endStream: true });
          return;
        }
        if (r.httpStatusOnly) {   // a peer that never speaks grpc-status
          stream.respond({ ':status': r.httpStatus }, { endStream: true });
          return;
        }
        const trailer = { 'grpc-status': String(r.status || 0) };
        if (r.message) trailer['grpc-message'] = r.message;
        if (r.trailerMeta) Object.assign(trailer, r.trailerMeta);
        try {
          stream.respond({ ':status': 200, 'content-type': headers['content-type'] || 'application/grpc',
                           'grpc-encoding': 'identity', ...(r.headerMeta || {}) },
                          { endStream: false, waitForTrailers: true });
          // Node fires wantTrailers only when respond() opts waitForTrailers.
          // sendTrailers() then emits the trailer HEADERS frame (END_STREAM).
          stream.on('wantTrailers', () => stream.sendTrailers(trailer));
          // r.body: a single payload, or an array of payloads — server
          // streaming sends one framed message per entry (separate DATA).
          const bodies = Array.isArray(r.body) ? r.body : (r.body == null ? [] : [r.body]);
          for (const b of bodies) stream.write(Buffer.from(rawFrame(b)));
          stream.end();
        } catch (e) { entry.serverError = e.message; }
      }, delay);
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port, seen })));
}

const PROTO_TEXT = fs.readFileSync(path.join(__dirname, 'proto', 'helloworld.proto'), 'utf8');

// ════════════════════════════════════════════════════════════════════
//  A. protobuf path against the hand-written peer (default codec)
// ════════════════════════════════════════════════════════════════════
const reg = grpc.loadProto(PROTO_TEXT);
const sayHello = reg.service('helloworld.Greeter').method('SayHello');
const failCall = reg.service('helloworld.Greeter').method('Fail');
const slowCall = reg.service('helloworld.Greeter').method('Slow');
const echoMeta = reg.service('helloworld.Greeter').method('EchoMeta');

const H = {
  '/helloworld.Greeter/SayHello': (req) => {
    const r = rawDecodeRequest(req[0]);
    return { body: rawEncodeReply({ message: 'Hello ' + r.name, count: r.tags.length }) };
  },
  '/helloworld.Greeter/Fail': () => ({ status: 5, message: 'no such %E2%98%BA thing' }),
  '/helloworld.Greeter/Collect': (req) => {
    // Client-streaming: the whole request stream arrives as one frame per
    // message in `req`.
    const names = req.map((b) => rawDecodeRequest(b).name);
    return { body: rawEncodeReply({ message: 'collected:' + names.join(','), count: names.length }) };
  },
  '/helloworld.Greeter/Chat': (req) => {
    // Bidi: reply with one framed message per request, in order.
    const names = req.map((b) => rawDecodeRequest(b).name);
    return { body: names.map((n) => rawEncodeReply({ message: 'echo ' + n, count: 0 })) };
  },
  '/helloworld.Greeter/Slow': () => ({ body: rawEncodeReply({ message: 'late' }), delayMs: 400 }),
  '/helloworld.Greeter/EchoMeta': (req, ctx) => ({
    body: rawEncodeReply({ message: 'meta' }),
    headerMeta: { 'x-early': 'from-header' },
    trailerMeta: { 'x-custom': ctx.headers['x-custom'] || '', 'x-bin': ctx.headers['x-bin'] || '' },
  }),
};
const raw = await startRawServer(H);
const ch = grpc.createInsecureChannel('127.0.0.1:' + raw.port);

console.log('\ngRPC client e2e (peer: hand-written node http2, protobuf default codec)');

await t('module mounted on globalThis', () => {
  ok(grpc && typeof grpc.createChannel === 'function', 'grpc.createChannel');
  ok(typeof grpc.loadProto === 'function', 'grpc.loadProto');
  eq(grpc.Status.DEADLINE_EXCEEDED, 4, 'status table');
  eq(grpc.Status.UNAVAILABLE, 14, 'status table');
});

await t('unary call, protobuf reply decoded', async () => {
  const reply = await ch.invoke(sayHello, { name: 'world', tags: ['a', 'b'] });
  eq(reply.message, 'Hello world', 'reply.message');
  eq(reply.count, 2, 'reply.count (repeated field survived the round trip)');
});

await t('request bytes are spec-shaped protobuf', () => {
  // The peer decoded it with an independent codec and echoed the right answer;
  // additionally assert the framing we actually put on the wire.
  const frame = raw.seen[0].raw;
  eq(frame[0], 0, 'compressed flag must be 0');
  eq(((frame[1] << 24) | (frame[2] << 16) | (frame[3] << 8) | frame[4]) >>> 0, frame.length - 5, 'declared length');
  eq(frame[5], 0x0a, 'field 1 wiretype 2 tag');
});

await t('method resolved from a bare /pkg.Svc/M path', async () => {
  const reply = await ch.invoke('/helloworld.Greeter/SayHello', { name: 'path' },
                                { registry: reg });
  eq(reply.message, 'Hello path');
});

await t('content-type advertises the protobuf codec', () => {
  eq(raw.seen[0].headers['content-type'], 'application/grpc+proto', 'content-type');
  eq(raw.seen[0].headers['te'], 'trailers', 'te');
  eq(raw.seen[0].headers[':method'], 'POST', ':method');
});

await t('non-zero grpc-status rejects with StatusError', async () => {
  let err = null;
  try { await ch.invoke(failCall, { name: 'x' }); } catch (e) { err = e; }
  ok(err instanceof grpc.StatusError, 'expected StatusError, got ' + err);
  eq(err.code, grpc.Status.NOT_FOUND, 'code');
  eq(err.codeName, 'NOT_FOUND', 'codeName');
  eq(err.message, 'grpc: NOT_FOUND: no such ☺ thing', 'percent-decoded grpc-message');
});

await t('unknown method -> UNIMPLEMENTED via trailers-only', async () => {
  let err = null;
  try { await ch.invoke('/helloworld.Greeter/Nope', { name: 'x' }, { registry: reg }); }
  catch (e) { err = e; }
  ok(err instanceof grpc.StatusError, 'StatusError');
  eq(err.code, grpc.Status.UNIMPLEMENTED, 'code');
});

await t('metadata: -bin sent as base64, response metadata decoded', async () => {
  const token = Uint8Array.from([0xde, 0xad, 0x00, 0x01, 0xff]);
  let meta = null;
  const reply = await ch.invoke(echoMeta, { name: 'm' },
    { headers: { 'X-Custom': 'hi', 'x-bin': token }, onMetadata: (m) => { meta = m; } });
  eq(reply.message, 'meta');
  ok(meta, 'onMetadata fired');
  eq(meta['x-custom'], 'hi', 'round-tripped text metadata');
  ok(meta['x-bin'] instanceof Uint8Array, '-bin decoded to bytes');
  eq(Array.from(meta['x-bin']).join(','), '222,173,0,1,255', '-bin bytes');
  // what the peer actually received must be base64 text, not raw bytes
  eq(raw.seen[raw.seen.length - 1].headers['x-bin'], '3q0AAf8=', 'outgoing -bin base64');
  eq(raw.seen[raw.seen.length - 1].headers['x-custom'], 'hi', 'keys lowercased');
});

await t('deadline: grpc-timeout header + local DEADLINE_EXCEEDED', async () => {
  const before = Date.now();
  let err = null;
  try { await ch.invoke(slowCall, { name: 's' }, { timeoutMs: 120 }); } catch (e) { err = e; }
  const took = Date.now() - before;
  ok(err instanceof grpc.StatusError, 'StatusError, got ' + err);
  eq(err.code, grpc.Status.DEADLINE_EXCEEDED, 'code');
  ok(took < 350, 'must not wait for the 400ms server, took ' + took + 'ms');
  const sent = raw.seen[raw.seen.length - 1].headers['grpc-timeout'];
  ok(/^120m$/.test(sent), 'grpc-timeout should be 120m, got ' + sent);
});

await t('deadline generous enough -> call succeeds', async () => {
  const reply = await ch.invoke(slowCall, { name: 's' }, { timeoutMs: 1500 });
  eq(reply.message, 'late');
});

await t('missing grpc-status maps HTTP :status', async () => {
  const p = await startRawServer({ '/x.S/M': () => ({ httpStatusOnly: true, httpStatus: 503 }) });
  const c = grpc.createInsecureChannel('127.0.0.1:' + p.port);
  let err = null;
  try { await c.invoke('/x.S/M', {}, { requestType: reg.HelloRequest, responseType: reg.HelloReply }); }
  catch (e) { err = e; }
  eq(err && err.code, grpc.Status.UNAVAILABLE, '503 -> UNAVAILABLE');
  await c.close(); p.srv.close();
});

await t('maxRecvMsgSize guards a runaway peer', async () => {
  const big = new Uint8Array(64 * 1024);
  const p = await startRawServer({ '/x.S/M': () => ({ body: big }) });
  const c = grpc.createInsecureChannel('127.0.0.1:' + p.port, { maxRecvMsgSize: 4096 });
  let err = null;
  try { await c.invoke('/x.S/M', {}, { requestType: reg.HelloRequest, responseType: reg.HelloReply }); }
  catch (e) { err = e; }
  eq(err && err.code, grpc.Status.RESOURCE_EXHAUSTED, 'code');
  await c.close(); p.srv.close();
});

await t('connection reuse: one socket serves many calls', async () => {
  const before = raw.seen.length;
  await Promise.all([1, 2, 3, 4, 5].map((n) => ch.invoke(sayHello, { name: 'n' + n })));
  eq(raw.seen.length - before, 5, 'five calls');
  const reply = await ch.invoke(sayHello, { name: 'after' });
  eq(reply.message, 'Hello after', 'still healthy afterwards');
});

await t('server streaming: invokeStream collects every framed message', async () => {
  const p = await startRawServer({
    '/helloworld.Greeter/CountUp': () => ({
      body: [1, 2, 3].map((i) => rawEncodeReply({ message: 'chunk' + i, count: i })),
    }),
  });
  const c = grpc.createInsecureChannel('127.0.0.1:' + p.port);
  const m = reg.service('helloworld.Greeter').method('CountUp');
  const rs = await c.invokeStream(m, { name: 'x' });
  eq(rs.length, 3, 'message count');
  eq(rs.map((r) => r.message).join('|'), 'chunk1|chunk2|chunk3', 'messages in order');
  eq(rs[2].count, 3, 'last payload');
  await c.close(); p.srv.close();
});

await t('server streaming: empty stream is a valid response', async () => {
  const p = await startRawServer({ '/helloworld.Greeter/CountUp': () => ({ body: [] }) });
  const c = grpc.createInsecureChannel('127.0.0.1:' + p.port);
  const m = reg.service('helloworld.Greeter').method('CountUp');
  const rs = await c.invokeStream(m, { name: 'x' });
  eq(rs.length, 0, 'zero messages resolved');
  await c.close(); p.srv.close();
});

await t('streaming methods are refused, not silently truncated', async () => {
  let err = null;
  try { await ch.invoke(sayHello, { name: 'x' }, {}); } catch (e) { err = e; }
  ok(!err, 'sanity: unary still works');
  const sreg = grpc.loadProto(`syntax="proto3";
    service S { rpc Up(stream A) returns (B); }
    message A { string a = 1; } message B { string b = 1; }`);
  try { await ch.invoke(sreg.service('S').method('Up'), { a: 'x' }); } catch (e) { err = e; }
  eq(err && err.code, grpc.Status.INVALID_ARGUMENT, 'invoke() refuses streaming, code');
  try { await ch.invokeStream(sayHello, { name: 'x' }); } catch (e) { err = e; }
  eq(err && err.code, grpc.Status.INVALID_ARGUMENT, 'invokeStream() refuses a unary method');
  try { await ch.invokeStream(sreg.service('S').method('Up'), { a: 'x' }); } catch (e) { err = e; }
  eq(err && err.code, grpc.Status.INVALID_ARGUMENT, 'invokeStream() refuses a client-streaming method');
});

const collect = reg.service('helloworld.Greeter').method('Collect');
const chat = reg.service('helloworld.Greeter').method('Chat');

await t('client streaming: 3 requests → 1 reply (raw peer)', async () => {
  const reply = await ch.invokeClientStream(collect, [{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
  eq(reply.message, 'collected:a,b,c', 'reply.message');
  eq(reply.count, 3, 'reply.count');
});

await t('client streaming: async generator request stream', async () => {
  async function* gen() { yield { name: 'x' }; yield { name: 'y' }; }
  const reply = await ch.invokeClientStream(collect, gen());
  eq(reply.message, 'collected:x,y', 'generator consumed in order');
});

await t('client streaming: empty request stream is valid', async () => {
  const reply = await ch.invokeClientStream(collect, []);
  eq(reply.message, 'collected:', 'empty stream');
  eq(reply.count, 0, 'count');
});

await t('bidi: 3 requests → 3 replies, order preserved (raw peer)', async () => {
  const rs = await ch.invokeBidi(chat, [{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
  eq(rs.length, 3, 'message count');
  eq(rs.map((r) => r.message).join('|'), 'echo a|echo b|echo c', 'messages in order');
});

await t('bidi: empty request stream → empty response stream', async () => {
  const rs = await ch.invokeBidi(chat, []);
  eq(rs.length, 0, 'zero messages resolved');
});

await t('new stream APIs refuse non-matching methods', async () => {
  let err = null;
  try { await ch.invokeClientStream(sayHello, [{ name: 'x' }]); } catch (e) { err = e; }
  eq(err && err.code, grpc.Status.INVALID_ARGUMENT, 'invokeClientStream() refuses a unary method');
  try { await ch.invokeClientStream(reg.service('helloworld.Greeter').method('CountUp'), [{ name: 'x' }]); }
  catch (e) { err = e; }
  eq(err && err.code, grpc.Status.INVALID_ARGUMENT, 'invokeClientStream() refuses a server-streaming method');
  try { await ch.invokeBidi(sayHello, [{ name: 'x' }]); } catch (e) { err = e; }
  eq(err && err.code, grpc.Status.INVALID_ARGUMENT, 'invokeBidi() refuses a unary method');
  try { await ch.invokeBidi(collect, [{ name: 'x' }]); } catch (e) { err = e; }
  eq(err && err.code, grpc.Status.INVALID_ARGUMENT, 'invokeBidi() refuses a client-streaming method');
  try { await ch.invokeStream(chat, { name: 'x' }); } catch (e) { err = e; }
  eq(err && err.code, grpc.Status.INVALID_ARGUMENT, 'invokeStream() refuses a bidi method');
});


// ════════════════════════════════════════════════════════════════════
//  C. @grpc/grpc-js — a real standard peer (optional)
// ════════════════════════════════════════════════════════════════════
console.log('\ngRPC client e2e (peer: @grpc/grpc-js, standard interop)');
let peer = null;
try {
  const base = process.env.QZ_GRPC_PEER_MODULES || '/tmp/grpcpeer';
  const preq = createRequire(path.join(base, 'noop.js'));
  peer = { grpc: preq('@grpc/grpc-js'), loader: preq('@grpc/proto-loader') };
} catch (e) { peer = null; }

if (!peer) {
  skip('interop with @grpc/grpc-js', 'package not resolvable; set QZ_GRPC_PEER_MODULES');
} else {
  const def = peer.loader.loadSync(path.join(__dirname, 'proto', 'helloworld.proto'),
                                   { keepCase: true, longs: Number, defaults: true });
  const svc = peer.grpc.loadPackageDefinition(def).helloworld.Greeter;
  const server = new peer.grpc.Server();
  server.addService(svc.service, {
    SayHello: (call, cb) => cb(null, { message: 'Hello ' + call.request.name, count: (call.request.tags || []).length }),
    Fail: (call, cb) => cb({ code: peer.grpc.status.NOT_FOUND, details: 'no such ☺ thing' }),
    Slow: (call, cb) => setTimeout(() => cb(null, { message: 'late' }), 400),
    EchoMeta: (call, cb) => {
      const md = new peer.grpc.Metadata();
      md.set('x-custom', call.metadata.get('x-custom')[0] || '');
      md.set('x-bin', Buffer.from(call.metadata.get('x-bin')[0] || '', 'base64'));
      cb(null, { message: 'meta' }, md);
    },
    CountUp: (call) => {
      const n = (call.request.tags || []).length || 1;
      for (let i = 1; i <= n; i++) call.write({ message: 'c' + i, count: i });
      call.end();
    },
    Collect: (call, cb) => {
      const names = [];
      call.on('data', (req) => names.push(req.name));
      call.on('end', () => cb(null, { message: 'collected:' + names.join(','), count: names.length }));
    },
    Chat: (call) => {
      call.on('data', (req) => call.write({ message: 'echo ' + req.name, count: 0 }));
      call.on('end', () => call.end());
    },
  });
  const port = await new Promise((res, rej) => server.bindAsync('127.0.0.1:0', peer.grpc.ServerCredentials.createInsecure(),
    (e, p) => (e ? rej(e) : res(p))));
  const gch = grpc.createInsecureChannel('127.0.0.1:' + port);

  await t('interop: unary protobuf against grpc-js', async () => {
    const reply = await gch.invoke(sayHello, { name: 'grpc-js', tags: ['t'] });
    eq(reply.message, 'Hello grpc-js');
    eq(reply.count, 1);
  });

  await t('interop: grpc-js status surfaces as StatusError', async () => {
    let err = null;
    try { await gch.invoke(failCall, { name: 'x' }); } catch (e) { err = e; }
    eq(err && err.code, grpc.Status.NOT_FOUND, 'code');
    ok(err && /no such ☺ thing/.test(err.message), 'details forwarded, got: ' + (err && err.message));
  });

  await t('interop: metadata both directions', async () => {
    let meta = null;
    const reply = await gch.invoke(echoMeta, { name: 'm' }, {
      headers: { 'x-custom': 'ping', 'x-bin': Uint8Array.from([1, 2, 250]) },
      onMetadata: (m) => { meta = m; },
    });
    eq(reply.message, 'meta');
    eq(meta && meta['x-custom'], 'ping', 'echoed text metadata');
    eq(meta && Array.from(meta['x-bin']).join(','), '1,2,250', 'echoed -bin metadata');
  });

  await t('interop: deadline propagates and aborts', async () => {
    let err = null;
    try { await gch.invoke(slowCall, { name: 's' }, { timeoutMs: 100 }); } catch (e) { err = e; }
    eq(err && err.code, grpc.Status.DEADLINE_EXCEEDED, 'code');
  });

  await t('interop: 20 sequential + 20 concurrent calls on one channel', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await gch.invoke(sayHello, { name: 'seq' + i });
      eq(r.message, 'Hello seq' + i, 'seq ' + i);
    }
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => gch.invoke(sayHello, { name: 'c' + i })));
    eq(rs.map((r) => r.message).join('|'), Array.from({ length: 20 }, (_, i) => 'Hello c' + i).join('|'), 'concurrent');
  });

  await t('interop: server streaming against grpc-js (qzjs client)', async () => {
    const countUp = reg.service('helloworld.Greeter').method('CountUp');
    const rs = await gch.invokeStream(countUp, { name: 'x', tags: ['a', 'b', 'c'] });
    eq(rs.length, 3, 'message count');
    eq(rs.map((r) => r.message).join('|'), 'c1|c2|c3', 'messages in order');
    eq(rs[2].count, 3, 'last payload');
  });

  await t('interop: client streaming against grpc-js (qzjs client)', async () => {
    const reply = await gch.invokeClientStream(collect, [{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    eq(reply.message, 'collected:a,b,c', 'reply.message');
    eq(reply.count, 3, 'reply.count');
  });

  await t('interop: bidi against grpc-js, 3↔3 full duplex (qzjs client)', async () => {
    const rs = await gch.invokeBidi(chat, [{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    eq(rs.length, 3, 'message count');
    eq(rs.map((r) => r.message).join('|'), 'echo a|echo b|echo c', 'messages in order');
  });

  await t('interop: empty bidi request stream against grpc-js', async () => {
    const rs = await gch.invokeBidi(chat, []);
    eq(rs.length, 0, 'zero messages resolved');
  });

  await gch.close();
  await new Promise((res) => server.tryShutdown(res));
}

await ch.close();

console.log('\ngrpc: ' + passed + ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
if (failed) { console.log('\n' + failures.join('\n')); process.exit(1); }
setTimeout(() => process.exit(0), 50).unref();
