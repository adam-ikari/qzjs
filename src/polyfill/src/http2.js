/**
 * qzjs polyfill: HTTP/2 client stack (RFC 7540) — pure JS over pal.tcp*.
 *
 * Scope (gRPC/HTTP2 Phase 1): a client-side h2 engine — frame codec, HPACK
 * header (de)compression (via hpack.js), stream multiplexing, per-stream +
 * connection flow control, SETTINGS negotiation, PING, GOAWAY, RST_STREAM,
 * HEADERS/CONTINUATION assembly, and the stream state machine
 * (idle → open → half-closed → closed). Server push and priority are ignored
 * (gRPC never uses them); PUSH_PROMISE is a connection error since we
 * advertise ENABLE_PUSH=0.
 *
 * Transport is `pal.tcpConnect` (plaintext h2c, or TLS+ALPN 'h2' once the
 * caller passes tls opts — Phase 0 primitive). The engine only ever sees a
 * plaintext byte stream; TLS is transparent to it.
 *
 * This is the client half only. The gRPC framing layer sits on top of this in
 * a later phase and is intentionally NOT part of this module.
 */

import { HPACKDecoder, hpackEncode } from './hpack.js';

var _pal = null;

// ── Frame constants (RFC 7540 §6) ──
var FRAME = {
  DATA: 0x0, HEADERS: 0x1, PRIORITY: 0x2, RST_STREAM: 0x3, SETTINGS: 0x4,
  PUSH_PROMISE: 0x5, PING: 0x6, GOAWAY: 0x7, WINDOW_UPDATE: 0x8, CONTINUATION: 0x9,
};
var FLAG = {
  END_STREAM: 0x1, ACK: 0x1, END_HEADERS: 0x4, PADDED: 0x8, PRIORITY: 0x20,
};
var SETTING = {
  HEADER_TABLE_SIZE: 0x1, ENABLE_PUSH: 0x2, MAX_CONCURRENT_STREAMS: 0x3,
  INITIAL_WINDOW_SIZE: 0x4, MAX_FRAME_SIZE: 0x5, MAX_HEADER_LIST_SIZE: 0x6,
};
var ERR = {
  NO_ERROR: 0x0, PROTOCOL_ERROR: 0x1, INTERNAL_ERROR: 0x2, FLOW_CONTROL_ERROR: 0x3,
  SETTINGS_TIMEOUT: 0x4, STREAM_CLOSED: 0x5, FRAME_SIZE_ERROR: 0x6, REFUSED_STREAM: 0x7,
  CANCEL: 0x8, COMPRESSION_ERROR: 0x9, CONNECT_ERROR: 0xa, ENHANCE_YOUR_CALM: 0xb,
  INADEQUATE_SECURITY: 0xc, HTTP_1_1_REQUIRED: 0xd,
};
var ERR_NAME = Object.keys(ERR).reduce(function (m, k) { m[ERR[k]] = k; return m; }, {});

var PREFACE = new Uint8Array([
  0x50, 0x52, 0x49, 0x20, 0x2a, 0x20, 0x48, 0x54, 0x54, 0x50, 0x2f, 0x32, 0x2e, 0x30,
  0x0d, 0x0a, 0x0d, 0x0a, 0x53, 0x4d, 0x0d, 0x0a, 0x0d, 0x0a,
]); // "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"
var DEFAULT_WINDOW = 65535;
var DEFAULT_MAX_FRAME = 16384;

// ── Stream states (RFC 7540 §5.1) ──
var S_IDLE = 0, S_OPEN = 1, S_HCL = 2 /* half-closed(local) */,
    S_HCR = 3 /* half-closed(remote) */, S_CLOSED = 4;

// ── byte buffer helpers ──
function InputBuf() { this.buf = new Uint8Array(8192); this.len = 0; }
InputBuf.prototype.append = function (u8) {
  if (this.len + u8.length > this.buf.length) {
    var n = new Uint8Array(Math.max(this.buf.length * 2, this.len + u8.length));
    n.set(this.buf.subarray(0, this.len));
    this.buf = n;
  }
  this.buf.set(u8, this.len);
  this.len += u8.length;
};
InputBuf.prototype.consume = function (n) {
  if (n >= this.len) { this.len = 0; return; }
  this.buf.copyWithin(0, n, this.len);
  this.len -= n;
};

function u24(b, o) { return (b[o] << 16) | (b[o + 1] << 8) | b[o + 2]; }
function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

/* Build a single frame: 9-byte header + payload. */
function frame(type, flags, streamId, payload) {
  var len = payload.length;
  var out = new Uint8Array(9 + len);
  out[0] = (len >> 16) & 0xff; out[1] = (len >> 8) & 0xff; out[2] = len & 0xff;
  out[3] = type; out[4] = flags;
  out[5] = (streamId >>> 24) & 0xff; out[6] = (streamId >> 16) & 0xff;
  out[7] = (streamId >> 8) & 0xff; out[8] = streamId & 0xff;
  out.set(payload, 9);
  return out;
}
function settingsPayload(pairs) {
  var out = new Uint8Array(pairs.length * 6);
  for (var i = 0; i < pairs.length; i++) {
    var id = pairs[i][0], val = pairs[i][1], o = i * 6;
    out[o] = (id >> 8) & 0xff; out[o + 1] = id & 0xff;
    out[o + 2] = (val >>> 24) & 0xff; out[o + 3] = (val >> 16) & 0xff;
    out[o + 4] = (val >> 8) & 0xff; out[o + 5] = val & 0xff;
  }
  return out;
}

/* ── Stream handle returned to callers ── */
function Stream(conn, id, cb) {
  this._conn = conn;
  this.id = id;
  this.state = S_IDLE;
  this.cb = cb || {};
  this.sendWindow = DEFAULT_WINDOW;
  this.recvWindow = DEFAULT_WINDOW;
  this.outQueue = [];      // pending DATA (Uint8Array) awaiting window
  this.outOffset = 0;      // bytes already sliced off outQueue[0]
  this.endQueued = false;  // end() called but data still queued / not yet open
  this.localEnded = false; // END_STREAM sent
  this.remoteEnded = false;// END_STREAM received
  this.halfClosedRemote = false;
  this.aborted = false;
}
Stream.prototype.end = function (data) {
  this._conn._streamEnd(this, data);
};
Stream.prototype.write = function (data) {
  this._conn._streamWrite(this, data, false);
};
Stream.prototype.cancel = function (code) {
  this._conn._resetStream(this, code == null ? ERR.CANCEL : code);
};

/* ── HTTP/2 client ── */
export class HTTP2Client {
  constructor() {
    this._input = new InputBuf();
    this._out = [];              // pending Uint8Array frames to coalesce
    this._flushing = false;
    this._streams = new Map();   // id → Stream
    this._nextStreamId = 1;
    this._active = 0;            // streams consuming a concurrency slot
    this._pending = [];          // queued requests at max concurrency
    this._state = 'connecting';  // connecting|open|closing|closed
    this._prefaceSent = false;
    this._connSendWindow = DEFAULT_WINDOW;
    this._peerMaxFrame = DEFAULT_MAX_FRAME;
    this._localMaxFrame = DEFAULT_MAX_FRAME;
    this._maxConcurrent = Infinity;
    this._peerHeaderTableSize = 4096;
    this._decoder = new HPACKDecoder(4096);
    this._hdr = null;            // in-progress header block {id, parts[], endStream}
    this._goawayLast = 0;
    this._onCloseCbs = [];
    this._error = null;
  }

  /* Resolve the transport pal: explicit opts.pal wins, else the module-level
   * pal installed by setupHttp2(). */
  static _pal(opts) {
    var p = (opts && opts.pal) || _pal;
    if (!p || typeof p.tcpConnect !== 'function')
      throw new Error('http2: no pal.tcpConnect (call setupHttp2(pal) or pass opts.pal)');
    return p;
  }

  static connect(opts) {
    var pal = HTTP2Client._pal(opts);
    var client = new HTTP2Client();
    return new Promise(function (resolve, reject) {
      var settled = false;
      var host = opts.host, port = opts.port;
      if (!host) return reject(new Error('http2: connect requires {host, port}'));
      var tcpOpts;
      if (opts.tls) {
        tcpOpts = { tls: true, servername: opts.servername || host };
        if (opts.alpn) tcpOpts.alpn = opts.alpn;
        if (opts.ca) tcpOpts.ca = opts.ca;
      }
      var cbs = {
        onconnect: function () {
          if (settled) return;
          settled = true;
          client._pal = pal;
          client._tcp = handle;
          client._state = 'open';
          client._send(PREFACE);
          client._sendSettings();
          resolve(client);
        },
        ondata: function (data) { client._onData(data); },
        onerror: function (msg) {
          if (!settled) { settled = true; reject(new Error('http2: connect error: ' + msg)); return; }
          client._failAll('transport error: ' + msg);
        },
        onclose: function () { client._onTcpClose(); },
      };
      var handle = tcpOpts ? pal.tcpConnect(host, port, cbs, tcpOpts) : pal.tcpConnect(host, port, cbs);
    });
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
    if (!this._out.length || !this._tcp) { this._out.length = 0; return; }
    var total = 0, i;
    for (i = 0; i < this._out.length; i++) total += this._out[i].length;
    var buf = new Uint8Array(total), off = 0;
    for (i = 0; i < this._out.length; i++) { buf.set(this._out[i], off); off += this._out[i].length; }
    this._out.length = 0;
    try { this._pal.tcpWrite(this._tcp, buf); }
    catch (e) { this._failAll('write failed: ' + (e && e.message)); }
  }

  _sendSettings() {
    // Advertise: no push, our receive frame size, a generous initial window.
    var pairs = [
      [SETTING.ENABLE_PUSH, 0],
      [SETTING.MAX_FRAME_SIZE, this._localMaxFrame],
      [SETTING.INITIAL_WINDOW_SIZE, DEFAULT_WINDOW],
    ];
    this._send(frame(FRAME.SETTINGS, 0, 0, settingsPayload(pairs)));
  }

  /* ── public request API ── */
  request(opts, cb) {
    if (this._state !== 'open') {
      var err = new Error('http2: connection not open');
      if (cb && cb.onError) cb.onError(err); else throw err;
      return null;
    }
    var id = this._nextStreamId;
    this._nextStreamId += 2;
    var st = new Stream(this, id, cb);
    this._streams.set(id, st);
    st._headers = this._buildHeaders(opts);
    if (this._active < this._maxConcurrent) this._openStream(st);
    else this._pending.push(st);
    return st;
  }

  _buildHeaders(opts) {
    var scheme = opts.tls || opts.scheme ? 'https' : (opts.scheme || 'http');
    var authority = opts.authority || opts.host || '';
    var headers = [
      [':method', opts.method || 'POST'],
      [':scheme', opts.scheme || scheme],
      [':path', opts.path || '/'],
    ];
    if (authority) headers.push([':authority', authority]);
    var extra = opts.headers || {};
    var keys = Object.keys(extra);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i].toLowerCase();
      var v = extra[keys[i]];
      if (Array.isArray(v)) for (var j = 0; j < v.length; j++) headers.push([k, String(v[j])]);
      else headers.push([k, String(v)]);
    }
    return headers;
  }

  _openStream(st) {
    st.state = S_OPEN;
    this._active++;
    st.sendWindow = Math.min(st.sendWindow, this._peerInitialWindow());
    var block = hpackEncode(st._headers);
    this._sendHeaderBlock(st.id, block, false);
    // If end() was requested before the stream opened, flush it now.
    if (st.endQueued) { this._flushOut(st); if (!st.localEnded) this._endStreamFrame(st); }
  }

  _peerInitialWindow() { return this._initialWindowSize == null ? DEFAULT_WINDOW : this._initialWindowSize; }

  /* Split a header block into HEADERS (+ CONTINUATION) frames ≤ maxFrame. */
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
      if (first) {
        this._send(frame(FRAME.HEADERS, flags, id, chunk));
      } else {
        this._send(frame(FRAME.CONTINUATION, flags, id, chunk));
      }
      pos += n;
      first = false;
    } while (pos < block.length);
  }

  _streamWrite(st, data, isEnd) {
    if (st.state === S_CLOSED || st.aborted) return;
    var bytes = toBytes(data);
    if (bytes.length) { st.outQueue.push(bytes); this._flushOut(st); }
    if (isEnd) { if (st.outQueue.length) st.endQueued = true; else this._endStreamFrame(st); }
  }
  _streamEnd(st, data) {
    if (data != null) this._streamWrite(st, data, true);
    else {
      if (st.outQueue.length) st.endQueued = true;
      else this._endStreamFrame(st);
    }
  }
  /* Emit DATA frames honouring connection + stream send windows. */
  _flushOut(st) {
    if (st.state === S_IDLE) return; // queued, not open yet
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
    if (st.endQueued && !st.outQueue.length) this._endStreamFrame(st);
  }
  _endStreamFrame(st) {
    if (st.localEnded) return;
    st.localEnded = true;
    // A zero-length DATA with END_STREAM closes the send side.
    this._send(frame(FRAME.DATA, FLAG.END_STREAM, st.id, new Uint8Array(0)));
    if (st.state === S_OPEN) st.state = S_HCL;
    else if (st.state === S_HCR) this._closeStream(st);
  }

  _resetStream(st, code) {
    if (st.state === S_CLOSED) return;
    st.aborted = true;
    this._send(frame(FRAME.RST_STREAM, 0, st.id, u32Payload(code)));
    this._closeStream(st);
  }

  _closeStream(st) {
    if (st.state === S_CLOSED) return;
    var wasActive = (st.state !== S_IDLE);
    st.state = S_CLOSED;
    this._streams.delete(st.id);
    if (wasActive) {
      this._active--;
      // admit a queued stream
      while (this._pending.length && this._active < this._maxConcurrent) {
        var next = this._pending.shift();
        if (next.aborted || next.state === S_CLOSED) continue;
        this._openStream(next);
      }
    }
    this._maybeFinishClose();
  }

  /* ── inbound data / frame parsing ── */
  _onData(arrayBuffer) {
    this._input.append(new Uint8Array(arrayBuffer));
    try { this._parse(); }
    catch (e) { this._failAll('parse: ' + (e && e.message ? e.message : e)); }
  }

  _parse() {
    var buf = this._input.buf, len = this._input.len;
    // Consume the connection preface from the server side is N/A (we are client).
    for (;;) {
      buf = this._input.buf; len = this._input.len;
      if (len < 9) return;
      var flen = u24(buf, 0);
      var type = buf[3];
      var flags = buf[4];
      var sid = u32(buf, 5) & 0x7fffffff;
      if (flen > this._localMaxFrame) { this._goaway(ERR.FRAME_SIZE_ERROR, 'frame too large'); return; }
      if (len < 9 + flen) return; // need more
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
      case FRAME.DATA: return this._onData_(flags, sid, payload, flen);
      case FRAME.WINDOW_UPDATE: return this._onWindowUpdate(flags, sid, payload, flen);
      case FRAME.RST_STREAM: return this._onRstStream(flags, sid, payload, flen);
      case FRAME.PING: return this._onPing(flags, payload, flen);
      case FRAME.GOAWAY: return this._onGoaway(flags, payload, flen);
      case FRAME.PRIORITY: return; // ignored (gRPC does not use priority)
      case FRAME.PUSH_PROMISE:
        // We advertise ENABLE_PUSH=0; a push is a connection error.
        this._goaway(ERR.PROTOCOL_ERROR, 'push not allowed');
        return;
      default:
        this._goaway(ERR.PROTOCOL_ERROR, 'unknown frame type ' + type);
    }
  }

  _onSettings(flags, payload, flen) {
    if (flags & FLAG.ACK) { this._settingsAcked = true; return; }
    if (flen % 6 !== 0) { this._goaway(ERR.FRAME_SIZE_ERROR, 'bad settings length'); return; }
    for (var i = 0; i + 6 <= flen; i += 6) {
      var id = (payload[i] << 8) | payload[i + 1];
      var val = u32(payload, i + 2);
      switch (id) {
        case SETTING.HEADER_TABLE_SIZE:
          this._decoder.setMaxSize(val); this._peerHeaderTableSize = val; break;
        case SETTING.ENABLE_PUSH: break;
        case SETTING.MAX_CONCURRENT_STREAMS: this._maxConcurrent = val; break;
        case SETTING.INITIAL_WINDOW_SIZE:
          if (val > 0xffffffff) { this._goaway(ERR.FLOW_CONTROL_ERROR, 'window too large'); return; }
          this._applyInitialWindow(val); break;
        case SETTING.MAX_FRAME_SIZE:
          if (val < 16384 || val > 16777215) { this._goaway(ERR.PROTOCOL_ERROR, 'bad max frame'); return; }
          this._peerMaxFrame = val; break;
        case SETTING.MAX_HEADER_LIST_SIZE: break;
        default: break; // ignore unknown
      }
    }
    // ACK the peer's SETTINGS.
    this._send(frame(FRAME.SETTINGS, FLAG.ACK, 0, new Uint8Array(0)));
    // admit queued streams now that concurrency limit may have changed
    while (this._pending.length && this._active < this._maxConcurrent) {
      var next = this._pending.shift();
      if (next.aborted || next.state === S_CLOSED) continue;
      this._openStream(next);
    }
  }
  _applyInitialWindow(val) {
    // RFC 7540 §6.9.2: the delta applies to all open streams' send windows.
    var delta = val - (this._initialWindowSize == null ? DEFAULT_WINDOW : this._initialWindowSize);
    this._initialWindowSize = val;
    var self = this;
    this._streams.forEach(function (st) { st.sendWindow += delta; self._flushOut(st); });
  }

  _onHeaders(flags, sid, payload) {
    var st = this._streams.get(sid);
    if (!st) return; // stream already closed/unknown → ignore body
    var p = payload, plen = p.length;
    if (flags & FLAG.PADDED) {
      var padLen = p[0]; p = p.subarray(1, plen - 1 - padLen);
    }
    if (flags & FLAG.PRIORITY) p = p.subarray(5);
    this._hdr = { id: sid, parts: [p.slice ? p.slice() : Uint8Array.from(p)], endStream: !!(flags & FLAG.END_STREAM) };
    if (flags & FLAG.END_HEADERS) this._finishHeaderBlock();
  }
  _onContinuation(flags, sid, payload) {
    if (!this._hdr || this._hdr.id !== sid) { this._goaway(ERR.PROTOCOL_ERROR, 'unexpected CONTINUATION'); return; }
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
    catch (e) { this._goaway(ERR.COMPRESSION_ERROR, 'hpack: ' + e.message); return; }
    if (st && st.cb.onHeaders) { try { st.cb.onHeaders(headers); } catch (e) {} }
    if (h.endStream) this._remoteEnd(st);
  }

  _onData_(flags, sid, payload, flen) {
    var st = this._streams.get(sid);
    if (!st) return; // closed stream: still replenish connection window below
    var p = payload;
    if (flags & FLAG.PADDED) {
      var padLen = p[0]; p = p.subarray(1, flen - 1 - padLen);
    }
    if (st.cb.onData && p.length) { try { st.cb.onData(Uint8Array.from(p)); } catch (e) {} }
    // Flow control: immediately replenish what we consumed (connection + stream).
    if (flen > 0) {
      this._send(frame(FRAME.WINDOW_UPDATE, 0, 0, u32Payload(flen)));
      if (st) this._send(frame(FRAME.WINDOW_UPDATE, 0, sid, u32Payload(flen)));
    }
    if (flags & FLAG.END_STREAM) this._remoteEnd(st);
  }
  _remoteEnd(st) {
    if (!st || st.remoteEnded) return;
    st.remoteEnded = true;
    if (st.cb.onEnd) { try { st.cb.onEnd(); } catch (e) {} }
    if (st.state === S_OPEN) st.state = S_HCR;
    else if (st.state === S_HCL) this._closeStream(st);
    else this._closeStream(st);
  }

  _onWindowUpdate(flags, sid, payload, flen) {
    if (flen !== 4) { this._goaway(ERR.FRAME_SIZE_ERROR, 'WINDOW_UPDATE size'); return; }
    var inc = u32(payload, 0) & 0x7fffffff;
    if (inc === 0) { this._goaway(ERR.PROTOCOL_ERROR, 'zero window update'); return; }
    if (sid === 0) { this._connSendWindow += inc; var self = this; this._streams.forEach(function (st) { self._flushOut(st); }); }
    else { var st = this._streams.get(sid); if (st) { st.sendWindow += inc; this._flushOut(st); } }
  }

  _onRstStream(flags, sid, payload, flen) {
    if (flen !== 4) { this._goaway(ERR.FRAME_SIZE_ERROR, 'RST_STREAM size'); return; }
    var code = u32(payload, 0);
    var st = this._streams.get(sid);
    if (!st) return;
    st.aborted = true;
    if (st.cb.onError) { try { st.cb.onError(new Error('RST_STREAM ' + (ERR_NAME[code] || code))); } catch (e) {} }
    this._closeStream(st);
  }

  _onPing(flags, payload, flen) {
    if (flen !== 8) { this._goaway(ERR.FRAME_SIZE_ERROR, 'PING size'); return; }
    if (flags & FLAG.ACK) { this._pongSeen = true; return; }
    this._send(frame(FRAME.PING, FLAG.ACK, 0, Uint8Array.from(payload)));
  }

  _onGoaway(flags, payload, flen) {
    var lastId = 0, err = 0;
    if (flen >= 8) { lastId = u32(payload, 0) & 0x7fffffff; err = u32(payload, 4); }
    this._goawayLast = lastId;
    this._state = 'closing';
    // Fail streams that will never be serviced (id > lastId) and any queued.
    var self = this;
    this._streams.forEach(function (st) {
      if (st.id > lastId) {
        if (st.cb.onError) { try { st.cb.onError(new Error('GOAWAY ' + (ERR_NAME[err] || err))); } catch (e) {} }
        self._closeStream(st);
      }
    });
    var still = [];
    for (var i = 0; i < this._pending.length; i++) {
      var q = this._pending[i];
      if (q.id > lastId) { if (q.cb.onError) { try { q.cb.onError(new Error('GOAWAY refused')); } catch (e) {} } this._streams.delete(q.id); }
      else still.push(q);
    }
    this._pending = still;
    this._maybeFinishClose();
  }

  _goaway(code, reason) {
    if (this._state === 'closed') return;
    this._state = 'closing';
    var payload;
    if (reason) {
      var r = utf8(reason);
      payload = new Uint8Array(8 + r.length);
      writeU32(payload, 0, this._nextStreamId - 2 >= 1 ? this._goawayLast : 0);
      writeU32(payload, 4, code);
      payload.set(r, 8);
    } else {
      payload = new Uint8Array(8);
      writeU32(payload, 0, 0); writeU32(payload, 4, code);
    }
    this._send(frame(FRAME.GOAWAY, 0, 0, payload));
    this._failAll('connection error ' + (ERR_NAME[code] || code) + (reason ? ': ' + reason : ''));
  }

  _failAll(msg) {
    var self = this;
    this._streams.forEach(function (st) {
      if (st.cb.onError) { try { st.cb.onError(new Error(msg)); } catch (e) {} }
    });
    this._streams.clear();
    this._pending.length = 0;
    this._active = 0;
    this._shutdown();
  }

  _onTcpClose() {
    if (this._state === 'closed') return;
    var self = this;
    this._streams.forEach(function (st) {
      if (st.cb.onError) { try { st.cb.onError(new Error('connection closed')); } catch (e) {} }
    });
    this._streams.clear();
    this._pending.length = 0;
    this._shutdown();
  }

  _shutdown() {
    this._state = 'closed';
    if (this._tcp && this._pal && this._pal.tcpClose) { try { this._pal.tcpClose(this._tcp); } catch (e) {} }
    this._tcp = null;
    var cbs = this._onCloseCbs; this._onCloseCbs = [];
    for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) {} }
  }

  _maybeFinishClose() {
    if (this._state === 'closing' && this._streams.size === 0 && this._pending.length === 0) {
      this._shutdown();
    }
  }

  /* Graceful close: send GOAWAY, stop new streams, drain in-flight. */
  close() {
    if (this._state === 'closed') return Promise.resolve();
    this._state = 'closing';
    var payload = new Uint8Array(8);
    writeU32(payload, 0, Math.max(0, this._nextStreamId - 2));
    writeU32(payload, 4, ERR.NO_ERROR);
    this._send(frame(FRAME.GOAWAY, 0, 0, payload));
    var self = this;
    if (this._streams.size === 0 && this._pending.length === 0) {
      return Promise.resolve().then(function () { self._shutdown(); });
    }
    return new Promise(function (resolve) { self._onCloseCbs.push(resolve); });
  }

  /* Send a keepalive PING; resolves on ACK (or rejects if closed). */
  ping() {
    var self = this;
    if (this._state !== 'open') return Promise.reject(new Error('http2: not open'));
    var data = new Uint8Array(8);
    this._send(frame(FRAME.PING, 0, 0, data));
    return new Promise(function (resolve) {
      var t = setInterval(function () {
        if (self._pongSeen) { clearInterval(t); self._pongSeen = false; resolve(); }
        else if (self._state === 'closed') { clearInterval(t); resolve(); }
      }, 5);
      if (t.unref) t.unref();
    });
  }
}

function u32Payload(v) { var b = new Uint8Array(4); writeU32(b, 0, v); return b; }
function writeU32(b, o, v) { b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >> 16) & 0xff; b[o + 2] = (v >> 8) & 0xff; b[o + 3] = v & 0xff; }
function toBytes(data) {
  if (data == null) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return utf8(String(data));
}
function utf8(s) {
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
    else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
      var c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xDC00 && c2 <= 0xDFFF) { var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00); i++;
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F)); }
      else out.push(0xEF, 0xBF, 0xBD);
    } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
  }
  return Uint8Array.from(out);
}

/* Install the h2 client into the global namespace (bundle wiring). */
export function setupHttp2(pal) {
  _pal = pal;
  if (typeof pal.tcpConnect === 'function') {
    globalThis.qzjs = globalThis.qzjs || {};
    globalThis.qzjs.http2 = { HTTP2Client: HTTP2Client };
  }
}

export { FRAME, FLAG, SETTING, ERR, PREFACE, InputBuf, frame, settingsPayload,
         u24, u32, u32Payload, writeU32, toBytes, utf8 };
