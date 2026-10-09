/**
 * qzjs polyfill: gRPC client — unary semantics over the pure-JS h2 stack.
 *
 * This is the gRPC layer of the HTTP/2 design (docs/plans/
 * 2026-09-03-grpc-http2-design.md §5.1). Transport (frames, HPACK, flow
 * control, multiplexing) lives in http2.js; message codecs live in
 * protobuf.js. This module adds only what gRPC itself specifies on top:
 *
 *   - Length-Prefixed-Message framing: [compressed-flag:1][len:4 BE][payload]
 *   - Request headers: :method POST, :path /pkg.Service/Method,
 *     content-type: application/grpc+proto, te: trailers,
 *     grpc-timeout, grpc-accept-encoding
 *   - Response: initial headers → DATA → **trailers** carrying grpc-status /
 *     grpc-message (plus the "Trailers-Only" single-HEADERS form)
 *   - Status model: non-OK rejects with a StatusError
 *   - Deadline: grpc-timeout header + a local timer that RST_STREAMs the call
 *   - Metadata: lowercase keys; `-bin` keys are base64 (Uint8Array <-> string)
 *
 * Serialization = protobuf only (standard gRPC interop).  Flatbuffers was
 * evaluated and retired from the JS layer — see ROADMAP H5 and
 * docs/plans/2026-09-03-flatbuffers-runtime-builtin.md for rationale.
 *
 * Scope: unary + all four streaming shapes, all Promise-style (this layer
 * deliberately has NO event/stream-object API — each call resolves once the
 * peer's whole response has arrived): invoke() for unary, invokeStream() for
 * server-streaming `returns (stream T)` (resolves with an array of all
 * messages), invokeClientStream() for client-streaming `(stream T) returns`
 * (resolves with the single reply), invokeBidi() for bidi `(stream A) returns
 * (stream B)` (resolves with an array of all reply messages). Client-streaming
 * and bidi send one framed message per item of the request array / (async)
 * iterable. gzip compression is a later phase; `grpc-encoding` is advertised
 * as `identity` only.
 */

import { HTTP2Client, ERR } from './http2.js';
import { parseProto } from './protobuf.js';

var _pal = null;

/* ── gRPC status codes (https://grpc.github.io/grpc/core/md_doc_statuscodes.html) ── */

var Status = {
  OK: 0, CANCELLED: 1, UNKNOWN: 2, INVALID_ARGUMENT: 3, DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5, ALREADY_EXISTS: 6, PERMISSION_DENIED: 7, RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9, ABORTED: 10, OUT_OF_RANGE: 11, UNIMPLEMENTED: 12,
  INTERNAL: 13, UNAVAILABLE: 14, DATA_LOSS: 15, UNAUTHENTICATED: 16,
};
var StatusName = {
  0: 'OK', 1: 'CANCELLED', 2: 'UNKNOWN', 3: 'INVALID_ARGUMENT', 4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND', 6: 'ALREADY_EXISTS', 7: 'PERMISSION_DENIED', 8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION', 10: 'ABORTED', 11: 'OUT_OF_RANGE', 12: 'UNIMPLEMENTED',
  13: 'INTERNAL', 14: 'UNAVAILABLE', 15: 'DATA_LOSS', 16: 'UNAUTHENTICATED',
};

/* HTTP :status → gRPC code, used only when the peer sent no grpc-status. */
var HTTP_TO_GRPC = {
  400: 13, 401: 16, 403: 7, 404: 12, 429: 14, 502: 14, 503: 14, 504: 14,
};

export class StatusError extends Error {
  constructor(message, code, metadata, details) {
    super('grpc: ' + (StatusName[code] || code) + ': ' + message);
    this.name = 'StatusError';
    this.rawMessage = message;  // unprefixed text; servers send this as grpc-message
    this.code = code | 0;
    this.codeName = StatusName[this.code] || String(this.code);
    this.metadata = metadata || null;
    this.details = details == null ? null : details;
  }
}

/* ── base64 (for `-bin` metadata) ── */

var B64A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64Encode(bytes) {
  var out = '', i;
  for (i = 0; i + 2 < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64A[(n >> 18) & 63] + B64A[(n >> 12) & 63] + B64A[(n >> 6) & 63] + B64A[n & 63];
  }
  var rem = bytes.length - i;
  if (rem === 1) {
    out += B64A[(bytes[i] >> 2) & 63] + B64A[(bytes[i] << 4) & 63] + '==';
  } else if (rem === 2) {
    var m = (bytes[i] << 8) | bytes[i + 1];
    out += B64A[(m >> 10) & 63] + B64A[(m >> 4) & 63] + B64A[(m << 2) & 63] + '=';
  }
  return out;
}

function b64Decode(s) {
  var clean = String(s).replace(/[^A-Za-z0-9+/]/g, ''), out = [], i;
  for (i = 0; i + 3 < clean.length; i += 4) {
    var n = (B64A.indexOf(clean[i]) << 18) | (B64A.indexOf(clean[i + 1]) << 12) |
            (B64A.indexOf(clean[i + 2]) << 6) | B64A.indexOf(clean[i + 3]);
    out.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }
  var rem = clean.length - i;
  if (rem >= 2) {
    var a = (B64A.indexOf(clean[i]) << 18) | (B64A.indexOf(clean[i + 1]) << 12);
    out.push((a >> 16) & 255);
    if (rem === 3) {
      a |= B64A.indexOf(clean[i + 2]) << 6;
      out.push((a >> 8) & 255);
    }
  }
  return Uint8Array.from(out);
}

/* grpc-message is percent-encoded on the wire (§Protocol-Basic-HTTP). */
function percentDecode(s) {
  if (s.indexOf('%') < 0) return s;
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

/* ── Length-Prefixed-Message framing (5-byte prefix) ── */

function frameMessage(payload) {
  var out = new Uint8Array(5 + payload.length);
  out[0] = 0; // compression flag: identity / uncompressed
  out[1] = (payload.length >>> 24) & 0xff;
  out[2] = (payload.length >>> 16) & 0xff;
  out[3] = (payload.length >>> 8) & 0xff;
  out[4] = payload.length & 0xff;
  out.set(payload, 5);
  return out;
}

/*
 * Reassembles gRPC messages out of arbitrarily-split HTTP/2 DATA frames.
 * Throws on a compressed flag we cannot decode (gzip is a later phase) or on
 * a message over `maxSize` (guards against a hostile/buggy peer causing OOM).
 */
function FrameSplitter(maxSize, onMessage) {
  this._buf = new Uint8Array(0);
  this._max = maxSize;
  this._onMessage = onMessage;
}
FrameSplitter.prototype.push = function (bytes) {
  var merged = new Uint8Array(this._buf.length + bytes.length);
  merged.set(this._buf, 0); merged.set(bytes, this._buf.length);
  this._buf = merged;
  this._drain();
};
FrameSplitter.prototype._drain = function () {
  while (this._buf.length >= 5) {
    var b = this._buf;
    if (b[0] !== 0) throw new StatusError('compressed responses are not supported', Status.INTERNAL);
    var len = ((b[1] * 16777216) + (b[2] << 16) + (b[3] << 8) + b[4]) >>> 0;
    if (len > this._max) {
      throw new StatusError('received message of ' + len + ' bytes exceeds maxRecvMsgSize (' + this._max + ')',
                            Status.RESOURCE_EXHAUSTED);
    }
    if (b.length < 5 + len) break;
    this._onMessage(b.subarray(5, 5 + len));
    this._buf = b.slice(5 + len);
  }
};
/* True when a complete message was consumed but bytes remain unframed. */
FrameSplitter.prototype.pending = function () { return this._buf.length !== 0; };

/* ── metadata ── */

var RESERVED = {
  'grpc-status': 1, 'grpc-message': 1, 'grpc-encoding': 1, 'grpc-accept-encoding': 1,
  'grpc-timeout': 1, 'grpc-status-details-bin': 1,
};

/* Outgoing: `-bin` keys accept Uint8Array (encoded) or an already-encoded string. */
function encodeMetadata(headers) {
  var out = {};
  if (!headers) return out;
  Object.keys(headers).forEach(function (k) {
    var key = k.toLowerCase();
    var v = headers[k];
    if (v == null) return;
    if (/-bin$/.test(key)) {
      out[key] = typeof v === 'string' ? v : b64Encode(v);
    } else {
      out[key] = Array.isArray(v) ? v.map(String) : String(v);
    }
  });
  return out;
}

/* Incoming header block → {metadata, status, statusText, httpStatus}. */
function readHeaderBlock(pairs) {
  var res = { metadata: {}, status: null, statusText: null, httpStatus: null };
  for (var i = 0; i < pairs.length; i++) {
    var k = pairs[i][0], v = pairs[i][1];
    if (k.charAt(0) === ':') { if (k === ':status') res.httpStatus = parseInt(v, 10) || null; continue; }
    var lk = k.toLowerCase();
    if (lk === 'grpc-status') res.status = parseInt(v, 10);
    else if (lk === 'grpc-message') res.statusText = percentDecode(v);
    else if (lk === 'grpc-status-details-bin') res.detailsBin = b64Decode(v);
    else if (!RESERVED[lk]) res.metadata[lk] = /-bin$/.test(lk) ? b64Decode(v) : v;
  }
  return res;
}

/* ── codecs ── */

/*
 * Resolve what a call will actually use: the method object, the
 * encode/decode pair, and whether it is streaming.
 */
function resolveCall(method, opts, registry) {
  var m = null;
  if (method && typeof method === 'object' && method.path) {
    m = method;
  } else if (typeof method === 'string') {
    var path = method.charAt(0) === '/' ? method : '/' + method;
    var parts = path.slice(1).split('/');
    registry = opts.registry || registry;
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error('grpc: bad method path "' + method + '" (expected /pkg.Service/Method)');
    }
    var svc = registry && (registry.services[parts[0]] || (registry.service && registry.service(parts[0])));
    var bound = svc && svc.methods[parts[1]];
    m = bound || { path: path, requestType: opts.requestType, responseType: opts.responseType };
  } else {
    throw new Error('grpc: invoke(method, req) needs a /pkg.Svc/M string or a bound method object');
  }

  var reqType = m.requestType || opts.requestType;
  var respType = m.responseType || opts.responseType;
  if (!reqType || !respType) {
    if (typeof method === 'string' && !opts.requestType && !opts.responseType) {
      // Bare path to an unknown method: let the call reach the server,
      // which will return e.g. UNIMPLEMENTED.  Use minimal passthrough
      // types so we can still send the request and parse the status.
      reqType = { encode: function (o) { return new Uint8Array(0); }, kind: 'message' };
      respType = { decode: function (b) { return null; }, kind: 'message' };
    } else {
      throw new Error('grpc: cannot resolve request/response types for ' + m.path +
                      ' — pass a method from loadProto(), or opts.requestType/respType');
    }
  }
  if (typeof reqType.encode !== 'function' || typeof respType.decode !== 'function') {
    throw new Error('grpc: message types for ' + m.path + ' lack encode/decode');
  }
  return { path: m.path, reqType: reqType, respType: respType,
           streaming: !!(m.clientStreaming || m.serverStreaming),
           clientStreaming: !!m.clientStreaming,
           serverStreaming: !!m.serverStreaming };
}

/* ── channel ── */

function Channel(target, opts) {
  this._t = target;                 // {host, port, tls, scheme}
  this._opts = opts || {};
  this._pal = this._opts.pal || _pal;
  this._registry = this._opts.registry || null;
  this._maxRecv = this._opts.maxRecvMsgSize || 4 * 1024 * 1024;
  this._conn = null;                // {client, promise}
  this._closed = false;
}

/* Lazily (re)establish the shared h2 connection; concurrent calls share it. */
Channel.prototype._connect = function () {
  if (this._closed) return Promise.reject(new StatusError('channel is closed', Status.UNAVAILABLE));
  if (this._conn) return this._conn.promise;
  var self = this;
  var client = null;
  var promise = HTTP2Client.connect({
    host: this._t.host, port: this._t.port, pal: this._pal,
    tls: this._t.tls ? true : undefined,
    servername: this._t.servername, alpn: this._t.tls ? ['h2'] : undefined,
    ca: this._t.ca,
  }).then(function (c) {
    client = c;
    c._onCloseCbs.push(function () { if (self._conn && self._conn.client === c) self._conn = null; });
    return c;
  }).catch(function (e) {
    if (self._conn && self._conn.client === client) self._conn = null;
    throw new StatusError('failed to connect to ' + self._t.host + ':' + self._t.port + ': ' + e.message,
                          Status.UNAVAILABLE);
  });
  this._conn = { client: null, promise: promise };
  promise.then(function (c) { if (self._conn) self._conn.client = c; }, function () {});
  return promise;
};

Channel.prototype._drop = function (client) {
  if (this._conn && this._conn.client === client) this._conn = null;
};

/**
 * Unary call.
 *
 * @param {string|object} method  '/pkg.Svc/Method' or a bound method object from
 *                                `loadProto(...).service('pkg.Svc').method('M')`.
 * @param {object} req            request message as a plain JS object.
 * @param {object} [opts]
 *   headers        gRPC metadata (keys lowercased; `-bin` values may be Uint8Array)
 *   timeoutMs      deadline; sends grpc-timeout and aborts locally on expiry
 *   requestType / responseType  explicit types when `method` is a bare path
 *   registry       .proto registry to resolve a bare path against
 *   onMetadata     called with the peer's response metadata
 * @returns {Promise<object>} the decoded response message
 */
Channel.prototype.invoke = function (method, req, opts) {
  var call;
  try {
    call = resolveCall(method, opts || {}, this._registry);
  } catch (e) {
    return Promise.reject(e instanceof StatusError ? e : new StatusError(e.message, Status.INVALID_ARGUMENT));
  }
  if (call.streaming) {
    // invoke() is the unary API; streaming methods must use the stream API.
    return Promise.reject(new StatusError('use invokeStream()/invokeClientStream()/invokeBidi() '
                                          + 'for streaming RPC: ' + call.path,
                                          Status.INVALID_ARGUMENT));
  }
  return this._send(call, req, opts);
};

/**
 * Server-streaming call.
 *
 * Same transport as invoke() but for `returns (stream T)` RPCs: resolves
 * with an ARRAY of all decoded response messages (an empty array is a valid
 * empty stream). Only server-streaming methods are accepted; unary methods
 * must use invoke().
 *
 * @returns {Promise<object[]>} the decoded response messages
 */
Channel.prototype.invokeStream = function (method, req, opts) {
  var call;
  try {
    call = resolveCall(method, opts || {}, this._registry);
  } catch (e) {
    return Promise.reject(e instanceof StatusError ? e : new StatusError(e.message, Status.INVALID_ARGUMENT));
  }
  if (!call.serverStreaming || call.clientStreaming) {
    // bidi methods must use invokeBidi(); client-streaming invokeClientStream().
    return Promise.reject(new StatusError('invokeStream() is for server-streaming RPCs: ' + call.path,
                                          Status.INVALID_ARGUMENT));
  }
  return this._send(call, req, opts);
};

/**
 * Client-streaming call: `(stream T) returns R`. The request stream is the
 * array / (async) iterable `reqs` — each item becomes one framed message and
 * is sent in order, then the request side is closed and the single reply is
 * awaited. Contrast grpc-js's event style (call.on('data')): qzjs always
 * collects the whole request stream up front and resolves with the decoded
 * reply message once it arrives.
 *
 * @param {Array|Iterable|AsyncIterable} reqs  request messages, one frame each
 * @returns {Promise<object>} the decoded response message
 */
Channel.prototype.invokeClientStream = function (method, reqs, opts) {
  var call;
  try {
    call = resolveCall(method, opts || {}, this._registry);
  } catch (e) {
    return Promise.reject(e instanceof StatusError ? e : new StatusError(e.message, Status.INVALID_ARGUMENT));
  }
  if (!call.clientStreaming || call.serverStreaming) {
    return Promise.reject(new StatusError('invokeClientStream() is for client-streaming RPCs: ' + call.path,
                                          Status.INVALID_ARGUMENT));
  }
  return this._sendMany(call, reqs, opts);
};

/**
 * Bidi-streaming call: `(stream A) returns (stream B)`. The request stream is
 * the array / (async) iterable `reqs` (one framed message each, then the
 * request side closes); resolves with an ARRAY of all decoded reply messages
 * once the peer ends its response stream (an empty array is a valid empty
 * stream). Like invokeStream() this is the Promise-style "send whole request
 * stream, receive whole response stream" shape — NOT grpc-js's bidirectional
 * event streams (call.write()/on('data')). Bidi handlers on the qzjs server
 * receive the whole request array and return the whole response iterable.
 *
 * @returns {Promise<object[]>} the decoded response messages
 */
Channel.prototype.invokeBidi = function (method, reqs, opts) {
  var call;
  try {
    call = resolveCall(method, opts || {}, this._registry);
  } catch (e) {
    return Promise.reject(e instanceof StatusError ? e : new StatusError(e.message, Status.INVALID_ARGUMENT));
  }
  if (!call.clientStreaming || !call.serverStreaming) {
    return Promise.reject(new StatusError('invokeBidi() is for bidi-streaming RPCs: ' + call.path,
                                          Status.INVALID_ARGUMENT));
  }
  return this._sendMany(call, reqs, opts);
};

Channel.prototype._send = function (call, req, opts) {
  var payload;
  try {
    payload = frameMessage(call.reqType.encode(req));
  } catch (e) {
    return Promise.reject(new Error('grpc: failed to encode request for ' + call.path + ': ' + e.message));
  }
  return this._once(call, [payload], opts || {}, false);
};

/* Client-streaming / bidi: frame every item of `reqs` (array or (async)
 * iterable — one frame per item, consumed in order), then send them all on
 * one stream. Same transparent retry as _send(); a framing failure rejects
 * with a plain Error like _send's encode failure. Frames are materialized
 * once and reused for the retry (generators cannot be re-iterated). */
Channel.prototype._sendMany = function (call, reqs, opts) {
  var self = this;
  return this._frameAll(call, reqs).then(function (payloads) {
    return self._once(call, payloads, opts || {}, false)
      .catch(function (err) {
        if (err && err.__grpcRetry) return self._once(call, payloads, opts || {}, true);
        throw err;
      });
  });
};

Channel.prototype._frameAll = function (call, reqs) {
  var frames = [];
  function encodeOne(req) {
    var payload;
    try { payload = frameMessage(call.reqType.encode(req)); }
    catch (e) {
      throw new Error('grpc: failed to encode request for ' + call.path + ': ' + e.message);
    }
    frames.push(payload);
  }
  function step(it) {
    var p = it.next();
    return Promise.resolve(p).then(function (r) {
      if (r.done) return frames;
      encodeOne(r.value);
      return step(it);
    });
  }
  return Promise.resolve().then(function () {
    if (reqs == null) return frames;           // empty request stream
    var asyncIt = typeof reqs[Symbol.asyncIterator] === 'function' && reqs[Symbol.asyncIterator]();
    var it = asyncIt || (typeof reqs[Symbol.iterator] === 'function' && reqs[Symbol.iterator]());
    if (!it) {
      throw new Error('grpc: request stream for ' + call.path + ' is not iterable');
    }
    return step(it);
  });
};

Channel.prototype._once = function (call, payloads, opts, isRetry) {
  var self = this;
  return this._connect().then(function (client) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;
      var messages = [];
      var frameErr = null;
      var httpStatus = null;
      var status = null, statusText = null, detailsBin = null;
      var respMeta = {};
      var splitter = new FrameSplitter(self._maxRecv, function (m) { messages.push(m); });

      var headers = {
        'content-type': 'application/grpc+proto',
        'te': 'trailers',
        'grpc-accept-encoding': 'identity',
        'user-agent': 'qzjs-grpc-js/1.0',
      };
      var timeoutMs = opts.timeoutMs;
      if (timeoutMs != null) {
        var whole = Math.floor(timeoutMs);
        if (!(whole > 0)) {
          reject(new StatusError('timeoutMs must be a positive number of milliseconds', Status.INVALID_ARGUMENT));
          return;
        }
        headers['grpc-timeout'] = Math.min(99999999, whole) + 'm'; // unit 'm' = milliseconds
        timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          try { stream.cancel(ERR.CANCEL); } catch (e) {}
          self._drop(client);
          reject(new StatusError('deadline exceeded after ' + whole + 'ms calling ' + call.path,
                                 Status.DEADLINE_EXCEEDED));
        }, whole);
        if (timer.unref) timer.unref();
      }
      Object.assign(headers, encodeMetadata(opts.headers));

      function mergeMeta(from) { Object.keys(from).forEach(function (k) { respMeta[k] = from[k]; }); }

      function finish() {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);

        if (frameErr) { reject(frameErr); return; }
        var code = status;
        if (code == null || isNaN(code)) {
          // No grpc-status at all: the call did not complete per spec.
          code = httpStatus != null && HTTP_TO_GRPC[httpStatus] != null
            ? HTTP_TO_GRPC[httpStatus]
            : (messages.length ? Status.INTERNAL : Status.UNAVAILABLE);
          statusText = statusText || ('missing grpc-status (HTTP :status ' + httpStatus + ')');
        }
        if (code !== Status.OK) {
          reject(new StatusError(statusText || StatusName[code] || 'RPC failed', code, respMeta, detailsBin));
          return;
        }
        var reply;
        try {
          if (call.serverStreaming) {
            // Server streaming + bidi: every framed message is a reply; an
            // empty stream is a valid (zero-message) response.
            reply = messages.map(function (m) { return call.respType.decode(m); });
          } else {
            // Unary + client streaming: exactly one reply message.
            if (!messages.length) {
              reject(new StatusError('response is missing the reply message', Status.INTERNAL));
              return;
            }
            reply = call.respType.decode(messages[0]);
          }
        } catch (e) {
          return;
        }
        if (opts.onMetadata) { try { opts.onMetadata(respMeta); } catch (e) {} }
        resolve(reply);
      }

      var stream = client.request({
        method: 'POST',
        scheme: self._t.tls ? 'https' : 'http',
        path: call.path,
        authority: self._t.authority || (self._t.host + ':' + self._t.port),
        headers: headers,
      }, {
        onHeaders: function (pairs) {
          var blk;
          try { blk = readHeaderBlock(pairs); }
          catch (e) { frameErr = e; return; }
          if (blk.httpStatus != null && httpStatus == null) httpStatus = blk.httpStatus;
          if (blk.status != null && !isNaN(blk.status)) status = blk.status;
          if (blk.statusText != null) statusText = blk.statusText;
          if (blk.detailsBin != null) detailsBin = blk.detailsBin;
          mergeMeta(blk.metadata);
        },
        onData: function (bytes) {
          try { splitter.push(bytes); }
          catch (e) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try { stream.cancel(ERR.CANCEL); } catch (e2) {}
            reject(e instanceof StatusError ? e : new StatusError(e.message, Status.INTERNAL));
          }
        },
        onEnd: finish,
        onError: function (err) {
          if (settled) return;
          // Transport died before any status arrived. A fresh connection can
          // still make the call succeed, so flag exactly one retry. (http2.js
          // swallows exceptions thrown from callbacks, so the retry signal has
          // to travel through the rejection, not a throw.)
          self._drop(client);
          settled = true;
          if (timer) clearTimeout(timer);
          var e = new StatusError((err && err.message) || 'transport error', Status.UNAVAILABLE);
          if (!isRetry && status == null && !messages.length) e.__grpcRetry = true;
          reject(e);
        },
      });

      if (!stream) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        var err = new StatusError('connection is not usable', Status.UNAVAILABLE);
        if (!isRetry) err.__grpcRetry = true;
        reject(err);
        return;
      }
      try {
        // One framed message per request; unary/server-streaming send exactly
        // one, client-streaming/bidi send the whole materialized stream.
        for (var i = 0; i < payloads.length; i++) stream.write(payloads[i]);
        stream.end();
      }
      catch (e) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(new StatusError((e && e.message) || 'write failed', Status.UNAVAILABLE));
      }
    });
  });
};

/* Graceful close: GOAWAY, stop accepting new calls. */
Channel.prototype.close = function () {
  this._closed = true;
  var conn = this._conn;
  this._conn = null;
  if (!conn) return Promise.resolve();
  var c = conn.client;
  if (!c) { return conn.promise.then(function (x) { return x.close(); }, function () {}); }
  return c.close();
};

/* ── target parsing ── */

function parseTarget(url, defaultTls) {
  var s = String(url || '').trim();
  var scheme = null;
  var m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length); }
  var tls = scheme == null ? !!defaultTls : (scheme === 'https' || scheme === 'grpcs' || scheme === 'h2');
  if (scheme != null && !tls && scheme !== 'http' && scheme !== 'grpc' && scheme !== 'h2c') {
    throw new Error('grpc: unsupported scheme "' + m[1] + '" — use grpc(s):// or http(s)://');
  }
  // Strip a trailing path; gRPC targets are host:port only.
  var slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);
  var host, port;
  if (s.charAt(0) === '[') {                       // [::1]:50051
    var close = s.indexOf(']');
    if (close < 0) throw new Error('grpc: bad IPv6 target ' + JSON.stringify(url));
    host = s.slice(1, close);
    port = s.charAt(close + 1) === ':' ? s.slice(close + 2) : '';
  } else {
    var colon = s.lastIndexOf(':');
    if (colon < 0) { host = s; port = ''; }
    else { host = s.slice(0, colon); port = s.slice(colon + 1); }
  }
  if (!host) throw new Error('grpc: empty target ' + JSON.stringify(url));
  var nport = port === '' ? (tls ? 443 : 50051) : parseInt(port, 10);
  if (!(nport > 0 && nport < 65536)) throw new Error('grpc: bad port in target ' + JSON.stringify(url));
  return { host: host, port: nport, authority: host + ':' + nport, tls: tls,
           servername: host, ca: undefined };
}

/**
 * TLS channel. `opts.tls = {ca, servername}`; ALPN 'h2' is always requested.
 * verify is strict — there is no opt-out.
 */
function createChannel(url, opts) {
  opts = opts || {};
  var t = parseTarget(url, true);
  if (opts.tls) {
    if (opts.tls.ca != null) t.ca = opts.tls.ca;
    if (opts.tls.servername != null) t.servername = opts.tls.servername;
  }
  return new Channel(t, opts);
}

/** Plaintext h2c channel — internal networks and local testing. */
function createInsecureChannel(target, opts) {
  return new Channel(parseTarget(target, false), opts || {});
}

/* ── schema loading ── */

/** Parse .proto text → registry of bound methods. */
function loadProto(text, opts) {
  return parseProto(text, opts);
}

/* ── global mount ── */

export function setupGrpc(pal) {
  _pal = pal;
  globalThis.qzjs = globalThis.qzjs || {};
  globalThis.grpc = {
    Status: Status,
    StatusName: StatusName,
    StatusError: StatusError,
    Channel: Channel,
    loadProto: loadProto,
    createChannel: createChannel,
    createInsecureChannel: createInsecureChannel,
  };
}

export {
  Channel, Status, StatusName, loadProto, createChannel, createInsecureChannel,
  // Shared with grpc-server.js (the server side reuses the same wire model).
  FrameSplitter, frameMessage, encodeMetadata, b64Decode, RESERVED,
};

