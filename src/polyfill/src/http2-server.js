/**
 * qzjs polyfill: HTTP/2 server stack (RFC 7540) — pure JS over pal.tcp*.
 *
 * Server half of the h2 engine (HTTP/2 + gRPC Phase 3). The client half lives
 * in http2.js; this module reuses its frame constants and byte helpers and
 * adds the server-side semantics:
 *
 *   - connection preface validation (24-byte magic, split-arrival safe)
 *     followed by our own SETTINGS (the first frame a server must send)
 *   - request streams arrive on odd stream ids (we never open streams —
 *     server push is not implemented, gRPC never uses it)
 *   - HEADERS/CONTINUATION assembly + HPACK decode of request headers
 *   - DATA with immediate WINDOW_UPDATE replenishment (connection + stream)
 *   - responses: HEADERS (respond) → DATA (write, flow-controlled by the
 *     peer's connection + stream windows) → trailers HEADERS (end)
 *   - PING → ACK, RST_STREAM, GOAWAY (graceful close drains open streams)
 *
 * The engine only ever sees a plaintext byte stream; TLS (+ALPN 'h2') is
 * transparent because the C layer delivers decrypted bytes via ondata.
 *
 * Bundle wiring: setupHttp2Server() mounts HTTP2ServerSession on
 * globalThis.qzjs.http2 next to the client. QZ_WITH_GRPC=0 keeps this
 * module out of the bundle entirely (grpc-stack aliasing).

 */

import {
  FRAME, FLAG, SETTING, ERR, PREFACE, InputBuf, frame, settingsPayload,
  u24, u32, u32Payload, writeU32, toBytes,
} from './http2.js';
import { HPACKDecoder, hpackEncode } from './hpack.js';


var DEFAULT_WINDOW = 65535;
var DEFAULT_MAX_FRAME = 16384;

/* Server view of stream states (RFC 7540 §5.1). Streams are opened by the
 * client (HEADERS), so the initial state after request headers is S_OPEN. */
var S_OPEN = 1, S_HCL = 2 /* half-closed(local) */, S_HCR = 3 /* half-closed(remote) */,
    S_CLOSED = 4;

/* ── server-side request stream ── */

function ServerStream(session, id) {
  this._session = session;
  this.id = id;
  this.state = S_OPEN;
  this.headers = null;      // decoded request header pairs [[name, value], ...]
  this.sendWindow = DEFAULT_WINDOW;   // peer's flow-control credit for our DATA
  this.outQueue = [];       // pending response DATA (Uint8Array)
  this.outOffset = 0;
  this._trailers = null;    // trailer header pairs awaiting the DATA drain
  this._endQueued = false;
  this.headersSent = false;
  this.localEnded = false;  // trailers (END_STREAM) sent
  this.remoteEnded = false; // client sent END_STREAM
  this.aborted = false;     // RST_STREAM received or connection failed
  this.onData = null;       // (Uint8Array) request body chunk
  this.onEnd = null;        // request complete (END_STREAM)
  this.onError = null;      // (Error) client cancelled / transport died
}

/* Send the response initial HEADERS block. */
ServerStream.prototype.respond = function (headers) {
  if (this.headersSent || this.localEnded || this.aborted) return;
  this.headersSent = true;
  this._session._sendHeaderBlock(this.id, hpackEncode(headers), false);
};

/* Queue response DATA; frames go out as the peer's windows allow. */
ServerStream.prototype.write = function (data) {
  if (this.localEnded || this.aborted) return;
  var bytes = toBytes(data);
  if (bytes.length) {
    this.outQueue.push(bytes);
    this._session._flushStream(this);
  }
};

/* Finish the response with trailers (a HEADERS block carrying END_STREAM).
 * Waits for queued DATA to drain first — trailers must be the final frame. */
ServerStream.prototype.end = function (trailers) {
  if (this.localEnded || this.aborted) return;
  this._trailers = trailers || [];
  if (this.outQueue.length) { this._endQueued = true; return; }
  this._session._sendTrailers(this);
};

/* Abort the stream (RST_STREAM). */
ServerStream.prototype.cancel = function (code) {
  this._session._resetStream(this, code == null ? ERR.CANCEL : code);
};

/* ── h2 server session ── */

export class HTTP2ServerSession {
  constructor(opts) {
    opts = opts || {};
    this._pal = opts.pal;
    this._conn = null;
    this._input = new InputBuf();
    this._out = [];
    this._flushing = false;
    this._streams = new Map();
    this._state = 'connecting';   // connecting|open|closing|closed
    this._prefaceDone = false;
    this._lastStreamId = 0;
    this._connSendWindow = DEFAULT_WINDOW;     // peer's connection window for our DATA
    this._initialWindowSize = DEFAULT_WINDOW;  // peer's per-stream initial window
    this._peerMaxFrame = DEFAULT_MAX_FRAME;
    this._localMaxFrame = opts.maxFrameSize || DEFAULT_MAX_FRAME;
    this._maxConcurrent = opts.maxConcurrent || 128;
    this._decoder = new HPACKDecoder(4096);
    this._hdr = null;             // in-progress header block {id, parts[], endStream}
    this._goawaySent = false;
    this._onStreamCb = opts.onStream || null;
    this._onCloseCbs = [];
  }

  onStream(cb) { this._onStreamCb = cb; }
  onClose(cb) { this._onCloseCbs.push(cb); }

  /* Bind to a conn handle from pal.tcpListen; writes go via pal.tcpWrite.
   * When the caller has not wired conn.ondata itself (serve() routes bytes
   * through its own dispatch), take over the callbacks so a bare session
   * works out of the box. */
  attach(conn) {
    this._conn = conn;
    if (!conn.ondata) {
      conn.ondata = (d) => this.feed(d);
      conn.onclose = () => this._teardown();
    }
  }

  /* Feed decrypted transport bytes (ArrayBuffer | Uint8Array). */
  feed(data) {
    if (this._state === 'closed') return;
    this._input.append(data instanceof Uint8Array ? data : new Uint8Array(data));
    if (!this._prefaceDone) {
      if (this._input.len < PREFACE.length) {
        // Partial preface: every byte so far must still match, else the peer
        // is not an h2 client at all — tear down without frames.
        for (var i = 0; i < this._input.len; i++) {
          if (this._input.buf[i] !== PREFACE[i]) { this._teardown(); return; }
        }
        return;
      }
      for (var j = 0; j < PREFACE.length; j++) {
        if (this._input.buf[j] !== PREFACE[j]) { this._teardown(); return; }
      }
      this._input.consume(PREFACE.length);
      this._prefaceDone = true;
      this._state = 'open';
      this._sendSettings();
    }
    try { this._parse(); }
    catch (e) { this._goaway(ERR.PROTOCOL_ERROR, 'parse'); }
  }

  _send(bytes) {
    this._out.push(bytes);
    if (this._flushing) return;
    this._flushing = true;
    var self = this;
    queueMicrotask(function () { self._flush(); });
  }
  _flush() {
    this._flushing = false;
    if (!this._out.length || !this._conn) { this._out.length = 0; return; }
    var total = 0, i;
    for (i = 0; i < this._out.length; i++) total += this._out[i].length;
    var buf = new Uint8Array(total), off = 0;
    for (i = 0; i < this._out.length; i++) { buf.set(this._out[i], off); off += this._out[i].length; }
    this._out.length = 0;
    try { this._pal.tcpWrite(this._conn, buf); }
    catch (e) { this._teardown(); }
  }

  _sendSettings() {
    var pairs = [
      [SETTING.MAX_CONCURRENT_STREAMS, this._maxConcurrent],
      [SETTING.INITIAL_WINDOW_SIZE, DEFAULT_WINDOW],
    ];
    this._send(frame(FRAME.SETTINGS, 0, 0, settingsPayload(pairs)));
  }

  /* HEADERS (+ CONTINUATION) split to ≤ peer max frame size. */
  _sendHeaderBlock(id, block, endStream) {
    var max = this._peerMaxFrame;
    var first = true;
    var pos = 0;
    do {
      var n = Math.min(max, block.length - pos);
      var chunk = block.subarray(pos, pos + n);
      var last = (pos + n) >= block.length;
      var flags = 0;
      if (last) flags |= FLAG.END_HEADERS;
      if (first && endStream) flags |= FLAG.END_STREAM;
      if (first) this._send(frame(FRAME.HEADERS, flags, id, chunk));
      else this._send(frame(FRAME.CONTINUATION, flags, id, chunk));
      pos += n;
      first = false;
    } while (pos < block.length);
  }

  _sendTrailers(st) {
    if (st.localEnded) return;
    st.localEnded = true;
    this._sendHeaderBlock(st.id, hpackEncode(st._trailers), true);
    if (st.state === S_OPEN) st.state = S_HCL;
    else this._closeStream(st);
    this._maybeFinish();
  }

  /* Emit DATA frames honouring connection + stream send windows. */
  _flushStream(st) {
    if (st.state === S_CLOSED || st.aborted) return;
    while (st.outQueue.length) {
      var avail = Math.min(this._connSendWindow, st.sendWindow, this._peerMaxFrame);
      if (avail <= 0) return; // wait for WINDOW_UPDATE
      var head = st.outQueue[0];
      var take = Math.min(avail, head.length - st.outOffset);
      var slice = head.subarray(st.outOffset, st.outOffset + take);
      this._send(frame(FRAME.DATA, 0, st.id, slice));
      this._connSendWindow -= take;
      st.sendWindow -= take;
      st.outOffset += take;
      if (st.outOffset >= head.length) { st.outQueue.shift(); st.outOffset = 0; }
    }
    if (st._endQueued && !st.outQueue.length) { st._endQueued = false; this._sendTrailers(st); }
  }

  _resetStream(st, code) {
    if (st.state === S_CLOSED) return;
    st.aborted = true;
    this._send(frame(FRAME.RST_STREAM, 0, st.id, u32Payload(code)));
    this._closeStream(st);
  }

  _closeStream(st) {
    if (st.state === S_CLOSED) return;
    st.state = S_CLOSED;
    this._streams.delete(st.id);
    this._maybeFinish();
  }

  _maybeFinish() {
    if (this._state === 'closing' && this._streams.size === 0) this._teardown();
  }

  /* ── inbound frames ── */
  _parse() {
    for (;;) {
      var buf = this._input.buf, len = this._input.len;
      if (len < 9) return;
      var flen = u24(buf, 0);
      var type = buf[3];
      var flags = buf[4];
      var sid = u32(buf, 5) & 0x7fffffff;
      if (flen > this._localMaxFrame) { this._goaway(ERR.FRAME_SIZE_ERROR); return; }
      if (len < 9 + flen) return;
      // Copy the payload out BEFORE consume() — consume() shifts the backing
      // buffer in place (copyWithin), which would corrupt a live subarray view.
      var payload = buf.slice(9, 9 + flen);
      this._input.consume(9 + flen);
      this._handleFrame(type, flags, sid, payload, flen);
      if (this._state === 'closed') return;
    }
  }

  _handleFrame(type, flags, sid, payload, flen) {
    switch (type) {
      case FRAME.SETTINGS: return this._onSettings(flags, payload, flen);
      case FRAME.HEADERS: return this._onHeaders(flags, sid, payload);
      case FRAME.CONTINUATION: return this._onContinuation(flags, sid, payload);
      case FRAME.DATA: return this._onData(flags, sid, payload, flen);
      case FRAME.WINDOW_UPDATE: return this._onWindowUpdate(flags, sid, payload, flen);
      case FRAME.RST_STREAM: return this._onRstStream(flags, sid, payload, flen);
      case FRAME.PING: return this._onPing(flags, payload, flen);
      case FRAME.GOAWAY: return this._onGoaway(payload, flen);
      case FRAME.PRIORITY: return; // ignored (no priority tree)
      default:
        // Unknown frame types must be ignored (RFC 7540 §5.5) for extensibility.
        return;
    }
  }

  _onSettings(flags, payload, flen) {
    if (flags & FLAG.ACK) return;
    if (flen % 6 !== 0) { this._goaway(ERR.FRAME_SIZE_ERROR); return; }
    for (var i = 0; i + 6 <= flen; i += 6) {
      var id = (payload[i] << 8) | payload[i + 1];
      var val = u32(payload, i + 2);
      switch (id) {
        case SETTING.HEADER_TABLE_SIZE: break; // we never index the dynamic table
        case SETTING.ENABLE_PUSH: break;       // we never push
        case SETTING.MAX_CONCURRENT_STREAMS: break; // client-side limit, N/A here
        case SETTING.INITIAL_WINDOW_SIZE:
          if (val > 0x7fffffff) { this._goaway(ERR.FLOW_CONTROL_ERROR); return; }
          this._applyInitialWindow(val); break;
        case SETTING.MAX_FRAME_SIZE:
          if (val < 16384 || val > 16777215) { this._goaway(ERR.PROTOCOL_ERROR); return; }
          this._peerMaxFrame = val; break;
        default: break; // ignore unknown
      }
    }
    this._send(frame(FRAME.SETTINGS, FLAG.ACK, 0, new Uint8Array(0)));
  }

  _applyInitialWindow(val) {
    var delta = val - this._initialWindowSize;
    this._initialWindowSize = val;
    var self = this;
    this._streams.forEach(function (st) { st.sendWindow += delta; self._flushStream(st); });
  }

  _onHeaders(flags, sid, payload) {
    if ((sid & 1) === 0) { this._goaway(ERR.PROTOCOL_ERROR); return; }
    var st = this._streams.get(sid);
    var p = payload, plen = p.length;
    if (flags & FLAG.PADDED) {
      var padLen = p[0]; p = p.subarray(1, plen - 1 - padLen);
    }
    if (flags & FLAG.PRIORITY) p = p.subarray(5);
    if (st && st.headers != null) {
      // Trailers from the client: gRPC clients do not send them; honour only
      // the stream-termination signal.
      this._hdr = null;
      if (flags & FLAG.END_STREAM) this._remoteEnd(st, flags);
      return;
    }
    if (!st) {
      if (this._streams.size >= this._maxConcurrent) {
        // Over concurrency: refuse just this stream (RST), keep the connection.
        this._send(frame(FRAME.RST_STREAM, 0, sid, u32Payload(ERR.REFUSED_STREAM)));
        return;
      }
      if (sid <= this._lastStreamId) { this._goaway(ERR.PROTOCOL_ERROR); return; }
      this._lastStreamId = sid;
      st = new ServerStream(this, sid);
      st.sendWindow = this._initialWindowSize;
      this._streams.set(sid, st);
    }
    this._hdr = { id: sid, parts: [Uint8Array.from(p)], endStream: !!(flags & FLAG.END_STREAM) };
    if (flags & FLAG.END_HEADERS) this._finishHeaderBlock();
  }

  _onContinuation(flags, sid, payload) {
    if (!this._hdr || this._hdr.id !== sid) { this._goaway(ERR.PROTOCOL_ERROR); return; }
    this._hdr.parts.push(Uint8Array.from(payload));
    if (flags & FLAG.END_HEADERS) this._finishHeaderBlock();
  }

  _finishHeaderBlock() {
    var h = this._hdr; this._hdr = null;
    var st = this._streams.get(h.id);
    var total = 0, i;
    for (i = 0; i < h.parts.length; i++) total += h.parts[i].length;
    var block = new Uint8Array(total); var off = 0;
    for (i = 0; i < h.parts.length; i++) { block.set(h.parts[i], off); off += h.parts[i].length; }
    var headers;
    try { headers = this._decoder.decode(block); }
    catch (e) { this._goaway(ERR.COMPRESSION_ERROR); return; }
    if (st && st.headers == null) {
      st.headers = headers;
      if (this._onStreamCb) { try { this._onStreamCb(st); } catch (e) {} }
    }
    if (h.endStream) this._remoteEnd(st, 0);
  }

  _onData(flags, sid, payload, flen) {
    var st = this._streams.get(sid);
    var p = payload;
    if (flags & FLAG.PADDED) {
      var padLen = p[0]; p = p.subarray(1, flen - 1 - padLen);
    }
    if (st && !st.aborted && p.length && st.onData) {
      try { st.onData(Uint8Array.from(p)); } catch (e) {}
    }
    // Flow control: immediately replenish what we consumed (connection + stream).
    if (flen > 0) {
      this._send(frame(FRAME.WINDOW_UPDATE, 0, 0, u32Payload(flen)));
      this._send(frame(FRAME.WINDOW_UPDATE, 0, sid, u32Payload(flen)));
    }
    if (flags & FLAG.END_STREAM) this._remoteEnd(st, 0);
  }

  _remoteEnd(st) {
    if (!st || st.remoteEnded) return;
    st.remoteEnded = true;
    if (st.onEnd) { try { st.onEnd(); } catch (e) {} }
    if (st.state === S_OPEN) st.state = S_HCR;
    else this._closeStream(st);
  }

  _onWindowUpdate(flags, sid, payload, flen) {
    if (flen !== 4) { this._goaway(ERR.FRAME_SIZE_ERROR); return; }
    var inc = u32(payload, 0) & 0x7fffffff;
    if (inc === 0) { this._goaway(ERR.PROTOCOL_ERROR); return; }
    if (sid === 0) {
      this._connSendWindow += inc;
      var self = this;
      this._streams.forEach(function (st) { self._flushStream(st); });
    } else {
      var st = this._streams.get(sid);
      if (st) { st.sendWindow += inc; this._flushStream(st); }
    }
  }

  _onRstStream(flags, sid, payload, flen) {
    if (flen !== 4) { this._goaway(ERR.FRAME_SIZE_ERROR); return; }
    var st = this._streams.get(sid);
    if (!st) return;
    st.aborted = true;
    if (st.onError) { try { st.onError(new Error('stream cancelled')); } catch (e) {} }
    this._closeStream(st);
  }

  _onPing(flags, payload, flen) {
    if (flen !== 8) { this._goaway(ERR.FRAME_SIZE_ERROR); return; }
    if (flags & FLAG.ACK) return;
    this._send(frame(FRAME.PING, FLAG.ACK, 0, Uint8Array.from(payload)));
  }

  _onGoaway(payload, flen) {
    // Client is going away: nothing new will arrive; drain and close.
    this._state = 'closing';
    this._teardown();
  }

  _goaway(code) {
    if (this._goawaySent) return;
    this._goawaySent = true;
    var payload = new Uint8Array(8);
    writeU32(payload, 0, this._lastStreamId);
    writeU32(payload, 4, code);
    this._send(frame(FRAME.GOAWAY, 0, 0, payload));
    this._failAll();
  }

  _failAll() {
    var self = this;
    this._streams.forEach(function (st) {
      st.aborted = true;
      if (st.onError) { try { st.onError(new Error('connection error')); } catch (e) {} }
      st.state = S_CLOSED;
    });
    this._streams.clear();
    this._teardown();
  }

  /* Graceful close: GOAWAY, stop new work, drain in-flight streams, then
   * close the TCP connection once (or immediately when nothing is open). */
  close() {
    if (this._state === 'closed') return;
    this._state = 'closing';
    if (this._conn && !this._goawaySent) {
      this._goawaySent = true;
      var payload = new Uint8Array(8);
      writeU32(payload, 0, this._lastStreamId);
      writeU32(payload, 4, ERR.NO_ERROR);
      this._send(frame(FRAME.GOAWAY, 0, 0, payload));
    }
    if (this._streams.size === 0) this._teardown();
  }

  _teardown() {
    if (this._state === 'closed') return;
    this._state = 'closed';
    if (this._conn && this._pal && this._pal.tcpClose) {
      try { this._pal.tcpClose(this._conn); } catch (e) {}
    }
    this._conn = null;
    var cbs = this._onCloseCbs; this._onCloseCbs = [];
    for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) {} }
  }
}

/* Install the h2 server session next to the client (bundle wiring). */
export function setupHttp2Server(pal) {
  globalThis.qzjs = globalThis.qzjs || {};
  if (!globalThis.qzjs.http2) globalThis.qzjs.http2 = {};
  globalThis.qzjs.http2.HTTP2ServerSession = HTTP2ServerSession;
  /* PREFACE exposed so serve() can sniff plaintext h2c without importing us. */
  globalThis.qzjs.http2.PREFACE = PREFACE;
}
