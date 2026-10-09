/**
 * qzjs polyfill: HTTP server (serve API) — pure JS implementation
 *
 * Uses pal.tcpListen/tcpWrite/tcpClose for raw TCP transport.
 * HTTP request parsing, routing, WebSocket server, and response
 * serialization are implemented entirely in JS.
 *
 * Design: C provides TCP transport (bind/listen/accept/read/write/close);
 * JS provides all protocol semantics. Mirrors the fetch/WS-client pattern.
 */

export function setupHttpServer(pal) {
  if (typeof pal.tcpListen !== 'function') return;

  var WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';  // RFC 6455 §1.3
  var PMD_TAIL = new Uint8Array([0, 0, 0xFF, 0xFF]);  // RFC 7692 §7.2.2 inflate tail
  /* 请求头区上限：超过即视为恶意/异常，防 raw 缓冲无界增长（内存 DoS） */
  var MAX_HEADER_SIZE = 64 * 1024;

  /* 请求体流高水位：handler 不读 req.body 时，body 流队列未读字节超过此值
   * 即 error 流并关闭连接（无 tcpPause 原语，不能真正暂停底层 read）。
   * 读得够快的 handler 队列会排空，不受影响。 */
  var MAX_BODY_BUFFER = 1024 * 1024;
  /* WS 收包缓冲 + 单消息分片重组上限：HTTP body 侧有 MAX_BODY_BUFFER，WS 侧
   * 此前没有对应物 —— this.buf / _fragParts 无界累积，单连接即可撑爆内存
   * （内存 DoS）。超限按 RFC 6455 §7.4.1 1009 (Message Too Big) 关闭。 */
  var MAX_WS_BUFFER = 16 * 1024 * 1024;
  var WS_CLOSE_MESSAGE_TOO_BIG = 0x03F1;  /* RFC 6455 §7.4.1: 1009 */
  /* Single-server enforcement: only one serve() instance at a time */
  var activeInstance = null;

  /* ── WS accept computation ──
   * 语义归 JS（RFC 6455 握手协议），算力全下沉：SHA-1 走 mbedTLS 的
   * pal.nativeDigest（crypto 扩展），digest 经 globalThis.btoa 编码
   * （nativeBtoa，textcodec 扩展）。两者均在 polyfill 注入后注册，
   * 必须每次调用探测。任一缺失（QZ_WITH_CRYPTO_EXT / QZ_WITH_TEXTCODEC
   * =OFF）即抛 Error——无 JS fallback（原 b64encode/手写 SHA-1 已删）。 */
  function wsAccept(key) {
    var raw = new Uint8Array(key.length + WS_GUID.length);
    for (var i = 0; i < key.length; i++) raw[i] = key.charCodeAt(i);
    for (var i = 0; i < WS_GUID.length; i++) raw[key.length + i] = WS_GUID.charCodeAt(i);
    if (typeof pal.nativeDigest !== 'function' ||
        typeof globalThis.btoa !== 'function') {
      throw new Error('WebSocket accept unavailable: rebuild with QZ_WITH_CRYPTO_EXT=ON and QZ_WITH_TEXTCODEC=ON');
    }
    var digest = pal.nativeDigest('SHA-1', raw);
    return globalThis.btoa(String.fromCharCode.apply(null, digest));
  }

  /* ── HTTP request parser (header-only; body delivered as a stream) ──
   * headerStr is the decoded header section WITHOUT the trailing \r\n\r\n.
   * The body never round-trips through a string: raw bytes are fed straight
   * into the body ReadableStream, so binary bodies are preserved. */
  function parseRequest(headerStr) {
    var idx = headerStr.indexOf('\r\n');
    if (idx < 0) return null;
    var reqLine = headerStr.substring(0, idx);
    var parts = reqLine.split(' ');
    if (parts.length < 3) return null;
    var method = parts[0], path = parts[1], version = parts[2];
    /* F4 安全审计：头名来自远程字节流。对象若无原型，'__proto__' 等键
     * 只是普通属性，无法触发原型链污染。 */
    var headers = Object.create(null);
    headerStr.substring(idx + 2).split('\r\n').forEach(function(l) {
      var ci = l.indexOf(':');
      if (ci > 0) headers[l.substring(0, ci).toLowerCase()] = l.substring(ci + 1).trim();
    });
    var clRaw = (headers['content-length'] || '').trim();
    var contentLength = 0;
    if (clRaw !== '') {
      /* 严格数字校验：'10foo' 之类不得按 10 解析（RFC 7230 §3.3.2） */
      if (!/^\d+$/.test(clRaw)) return null;
      contentLength = Number(clRaw);
    }
    var conn = (headers['connection'] || '').toLowerCase();
    var keepAlive = version !== 'HTTP/1.0' && conn !== 'close';
    return {
      method: method, path: path, version: version, headers: headers,
      keepAlive: keepAlive,
      contentLength: contentLength
    };
  }

  function concatBytes(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  /* index of the \r\n\r\n header terminator in raw bytes, or -1 */
  function indexOfHdrEnd(bytes) {
    for (var i = 0; i + 3 < bytes.length; i++)
      if (bytes[i] === 13 && bytes[i + 1] === 10 &&
          bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
    return -1;
  }

  /* Read a ReadableStream to completion, returning all bytes as one Uint8Array. */
  function streamToBytes(stream) {
    if (!stream) return Promise.resolve(new Uint8Array(0));
    var reader = stream.getReader();
    var chunks = [];
    var total = 0;
    function pump(r) {
      if (r.done) {
        var out = new Uint8Array(total);
        var off = 0;
        for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
        return out;
      }
      chunks.push(r.value);
      total += r.value.length;
      return reader.read().then(pump);
    }
    return reader.read().then(pump);
  }

  /* ── WS frame parser (server side: client→server frames are MASKED) ── */
  function parseWSFrame(buf) {
    if (buf.length < 2) return null;
    var first = buf[0], second = buf[1];
    var fin = (first >> 7) & 1;
    var rsv1 = (first >> 6) & 1;
    var opcode = first & 0x0F;
    var masked = (second >> 7) & 1;
    var len = second & 0x7F;
    var offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = (buf[2] << 8) | buf[3];
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      var hi = 0, lo = 0;
      for (var i = 0; i < 4; i++) hi = (hi * 256) + buf[2 + i];
      for (var i = 4; i < 8; i++) lo = (lo * 256) + buf[2 + i];
      len = hi * 4294967296 + lo;
      offset = 10;
    }
    var mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.slice(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    var payload = buf.slice(offset, offset + len);
    if (mask) for (var i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    return { fin: fin, rsv1: rsv1, opcode: opcode, masked: masked, payload: payload, totalLen: offset + len };
  }

  /* ── Build WS frame (server→client: NOT masked) ── */
  function buildWSFrame(opcode, payload, fin, rsv1) {
    var len = payload.length;
    var header = [(fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode];
    if (len < 126) {
      header.push(len);
    } else if (len < 65536) {
      header.push(126, (len >> 8) & 0xFF, len & 0xFF);
    } else {
      header.push(127);
      for (var i = 7; i >= 0; i--) header.push((len >> (i * 8)) & 0xFF);
    }
    var frame = new Uint8Array(header.length + len);
    for (var i = 0; i < header.length; i++) frame[i] = header[i];
    for (var i = 0; i < len; i++) frame[header.length + i] = payload[i];
    return frame;
  }

  /* 响应头值校验：拒绝 CR/LF（防头注入）。值来自 handler 返回的 headers。 */
  function safeHeaderValue(v) {
    var s = String(v);
    if (/[\r\n]/.test(s)) throw new TypeError('Invalid HTTP response header value');
    return s;
  }

  /* ── Build HTTP response bytes ── */
  function buildHTTPResponse(status, statusText, hdrs, bodyBytes) {
    var h = 'HTTP/1.1 ' + status + ' ' + safeHeaderValue(statusText || '') + '\r\n';
    for (var k in hdrs) h += k + ': ' + safeHeaderValue(hdrs[k]) + '\r\n';
    h += '\r\n';
    var enc = new TextEncoder();
    var hBytes = enc.encode(h);
    var out = new Uint8Array(hBytes.length + bodyBytes.length);
    out.set(hBytes, 0);
    out.set(bodyBytes, hBytes.length);
    return out;
  }

  /* ── serve() ── */
  globalThis.serve = function serve(options, handler) {
    if (typeof options !== 'object' || options === null)
      throw new TypeError('serve: options object required');
    if (typeof handler !== 'function')
      throw new TypeError('serve: handler must be a function');

    var port = options.port === undefined ? 8080 : options.port;
    var idleTimeout = options.idleTimeout === undefined ? 30000 : options.idleTimeout;
    if (typeof port !== 'number' || port < 0 || port > 65535)
      throw new TypeError('serve: invalid port');
    var hostname = options.hostname || '127.0.0.1';
    var wsRoutes = options.ws || {};
    var activeServer = { closed: false };
    /* h2/gRPC 分流：QZ_WITH_GRPC=ON 时 grpc-stack 已把 HTTP2ServerSession 与
     * PREFACE 挂到 qzjs.http2；options.grpc 为 grpc.createServer() 实例时，
     * h2 连接上的流路由到 gRPC 服务端（ALPN 'h2' 或明文前导识别）。 */
    var h2api = (globalThis.qzjs && globalThis.qzjs.http2) || null;
    var H2SessionClass = (h2api && h2api.HTTP2ServerSession) || null;
    var H2Preface = (h2api && h2api.PREFACE) || null;
    var H2_PREFACE_LEN = H2Preface ? H2Preface.length : 0;
    var grpcServer = options.grpc || null;

    if (activeInstance && !activeInstance.closed)
      throw new Error('serve: a server is already running (call srv.close() first)');
    activeInstance = activeServer;

    /* ── WS connection ── */
    var currentKeepAlive = true;
    var currentResetIdle = function() {};
    function WSConnection(conn) {
      this.conn = conn;
      this.state = 0;  // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
      this.buf = new Uint8Array(0);
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      /* fragmentation state */
      this._fragOpcode = 0;    // 0x1 (text) or 0x2 (binary) of a fragmented message
      this._fragParts = [];    // payload chunks of the current fragmented message
      this._msgRsv1 = false;   // RSV1 of the current incoming message (permessage-deflate)
    }

    WSConnection.prototype.send = function(data) {
      if (this.state !== 1) return;
      var binary = typeof data !== 'string';
      var payload = binary ?
        (data || new Uint8Array(0)) : new TextEncoder().encode(data);
      var rsv1 = false;
      if (this._deflate) {
        try {
          var comp = pal.deflatePush(this._deflate, payload, true);
          /* strip the trailing 00 00 ff ff SYNC-FLUSH marker (RFC 7692 §7.2.1) */
          if (comp.length >= 5) {
            payload = comp.subarray(0, comp.length - 4);
            rsv1 = true;
          }
        } catch (e) {}
      }
      pal.tcpWrite(this.conn, buildWSFrame(binary ? 0x2 : 0x1, payload, 1, rsv1));
    };

    WSConnection.prototype.close = function(code, reason) {
      if (this.state >= 2) return;
      this.state = 2;
      code = code || 1000;
      reason = reason || '';
      var reasonBytes = new TextEncoder().encode(reason);
      var payload = new Uint8Array(2 + reasonBytes.length);
      payload[0] = (code >> 8) & 0xFF;
      payload[1] = code & 0xFF;
      payload.set(reasonBytes, 2);
      pal.tcpWrite(this.conn, buildWSFrame(0x8, payload, 1));
      this.state = 3;
    };

    WSConnection.prototype._processWSData = function(data) {
      /* data is an ArrayBuffer from the C layer — wrap for TypedArray ops */
      var dv = data instanceof Uint8Array ? data : new Uint8Array(data);
      var newBuf = new Uint8Array(this.buf.length + dv.length);
      newBuf.set(this.buf, 0);
      newBuf.set(dv, this.buf.length);
      this.buf = newBuf;
      /* 收包缓冲有界：不设上限时单连接可无界累积字节（内存 DoS） */
      if (this.buf.length > MAX_WS_BUFFER) {
        closeWSMessageTooBig(this);
        return;
      }

      for (;;) {
        var frame = parseWSFrame(this.buf);
        if (!frame) break;
        /* RFC 6455: 客户端→服务器帧必须掩码；未掩码 = 协议错误 → 1002 关闭 */
        if (!frame.masked) {
          try { pal.tcpWrite(this.conn, buildWSFrame(0x8, new Uint8Array([0x03, 0xEA]), 1)); } catch (e) {}
          this.state = 3;
          pal.tcpClose(this.conn);
          return;
        }
        this.buf = this.buf.slice(frame.totalLen);

        if (frame.opcode === 0x8) {  // Close
          var closeCode = 1005, closeReason = '';
          if (frame.payload.length >= 2) {
            closeCode = (frame.payload[0] << 8) | frame.payload[1];
            closeReason = new TextDecoder().decode(frame.payload.slice(2));
          }
          pal.tcpWrite(this.conn, buildWSFrame(0x8, frame.payload, 1));
          this.state = 3;
          if (this.onclose) {
            var ev = { code: closeCode, reason: closeReason, wasClean: true };
            try { this.onclose(ev); } catch (e) {}
          }
        } else if (frame.opcode === 0x9) {  // Ping → Pong (RFC 6455 §5.5.2)
          try { pal.tcpWrite(this.conn, buildWSFrame(0xA, frame.payload, 1)); } catch (e) {}
        } else if (frame.opcode === 0xA) {  // Pong — nothing to do
        } else if (frame.opcode === 0x0) {  // Continuation
          this._fragParts.push(frame.payload);
          /* 分片重组同样有界：单条消息可跨任意多帧，累加超限即关闭 */
          if (fragmentsBytes(this._fragParts) > MAX_WS_BUFFER) {
            closeWSMessageTooBig(this);
            return;
          }
          if (frame.fin) {
            var fragOp = this._fragOpcode;
            var combined = combineBytes(this._fragParts);
            this._fragOpcode = 0;
            this._fragParts = [];
            deliverWS(this, fragOp, combined);
          }
        } else if (frame.opcode === 0x1 || frame.opcode === 0x2) {  // Text/Binary
          this._msgRsv1 = frame.rsv1 ? true : false;
          if (frame.fin) {
            deliverWS(this, frame.opcode, frame.payload);
          } else {
            // start a fragmented message
            this._fragOpcode = frame.opcode;
            this._fragParts = [frame.payload];
          }
        }
      }
    };

    /* 分片重组的累计字节数 —— 上限判定必须在分配前做，故与 combineBytes 分开 */
    function fragmentsBytes(parts) {
      var total = 0;
      for (var i = 0; i < parts.length; i++) total += parts[i].length;
      return total;
    }

    /* RFC 6455 §7.4.1 1009 Message Too Big：收包缓冲或分片重组触到
     * MAX_WS_BUFFER 时关闭连接（防单连接无界累积内存）。 */
    function closeWSMessageTooBig(ws) {
      try {
        pal.tcpWrite(ws.conn, buildWSFrame(0x8, new Uint8Array([
          (WS_CLOSE_MESSAGE_TOO_BIG >> 8) & 0xFF, WS_CLOSE_MESSAGE_TOO_BIG & 0xFF
        ]), 1));
      } catch (e) {}
      ws.state = 3;
      pal.tcpClose(ws.conn);
    }

    function combineBytes(parts) {
      var out = new Uint8Array(fragmentsBytes(parts));
      var off = 0;
      for (var i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
      return out;
    }

    function deliverWS(ws, opcode, payload) {
      if (ws._msgRsv1 && ws._inflate) {
        /* permessage-deflate: inflate the message, appending the RFC 7692
         * tail so the SYNC-FLUSH-terminated stream reaches a block boundary. */
        try {
          var out = pal.inflatePush(ws._inflate, payload, false);
          var tail = pal.inflatePush(ws._inflate, PMD_TAIL, false);
          var merged = new Uint8Array(out.length + tail.length);
          merged.set(out, 0);
          merged.set(tail, out.length);
          payload = merged;
        } catch (e) {}
      }
      ws._msgRsv1 = false;
      var msg = null;
      if (opcode === 0x1) msg = new TextDecoder().decode(payload);
      else msg = payload;
      if (ws.onmessage) {
        var ev2 = { data: msg };
        try { ws.onmessage(ev2); } catch (e) {}
      }
    }

    function handleConnection(conn) {
      var raw = new Uint8Array(0);  // unparsed raw bytes (header + leftover body/requests)
      var ws = null;
      var idleTimer = null;
      var bodyState = null;  // {controller, remaining, received} of the in-flight request body
      conns.push(conn);
      /* ── h2/gRPC 分流状态（首段数据一次性判定）── */
      var h2session = null;
      var h2Decided = false;   // 已判定非 h2（HTTP/1.1）
      var preBuf = null;       // 明文前导累积缓冲
      function startH2() {
        var session = new H2SessionClass({ pal: pal });
        session.attach(conn);
        if (grpcServer) {
          session.onStream(function (st) { grpcServer._handleStream(st); });
        } else {
          /* 无 gRPC server：通用 h2 请求 → 404 */
          session.onStream(function (st) {
            st.respond([[':status', '404'], ['content-type', 'text/plain']]);
            st.end([]);
          });
        }
        h2session = session;
        return session;
      }

      function resetIdle() {
        clearTimeout(idleTimer);
        if (idleTimeout > 0 && !ws) {
          idleTimer = setTimeout(function() {
            pal.tcpClose(conn);
          }, idleTimeout);
        }
      }

      /* Feed body bytes into the request body stream with a high-water mark:
       * if the handler is not consuming the stream and the unread queue would
       * exceed MAX_BODY_BUFFER, error the stream and close the connection
       * (memory-DoS guard). Returns 1 on success, 0 when the connection was
       * torn down (caller must stop processing). */
      function feedBody(conn, chunk) {
        /* 高水位检查：用公开 API desiredSize 替代内部 _stream._queue。
         * wsp 无 _stream 内部字段，改用 desiredSize（negative = 过量）。
         * 若 desiredSize 为负或 chunk 会将其推过上限，拒绝。 */
        var desired = bodyState.controller.desiredSize;
        if (desired !== null && desired + chunk.length > MAX_BODY_BUFFER) {
          try {
            bodyState.controller.error(new Error('request body too large: stream not consumed'));
          } catch (e) {}
          bodyState = null;
          try { pal.tcpClose(conn); } catch (e) {}
          return 0;
        }
        bodyState.controller.enqueue(chunk);
        return 1;
      }
 

      conn.ondata = function(data) {
        if (ws) {
          ws._processWSData(data);
          return;
        }
        data = data instanceof Uint8Array ? data : new Uint8Array(data);
        resetIdle();
        /* ── h2/gRPC 分流（仅首段数据判定一次）── */
        if (h2session) { h2session.feed(data); return; }
        if (!h2Decided && H2SessionClass) {
          if (conn.alpn === 'h2') {
            /* TLS 且 ALPN 协商 h2 → 直接 h2 路径（前导随解密流到达） */
            h2Decided = true;
            startH2().feed(data);
            return;
          }
          if (conn.alpn == null) {
            /* 明文连接：嗅探 24 字节前导 "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"。
             * 前导可跨 TCP 段：累积直到凑满或字节失配判非 h2。 */
            var merged = new Uint8Array((preBuf ? preBuf.length : 0) + data.length);
            if (preBuf) merged.set(preBuf, 0);
            merged.set(data, preBuf ? preBuf.length : 0);
            preBuf = merged;
            var pn = Math.min(preBuf.length, H2_PREFACE_LEN);
            var pm = true;
            for (var pi = 0; pi < pn; pi++) {
              if (preBuf[pi] !== H2Preface[pi]) { pm = false; break; }
            }
            if (!pm) {
              /* 非 h2：整段交回 HTTP/1.1 解析 */
              h2Decided = true;
              data = preBuf;
              preBuf = null;
            } else if (preBuf.length < H2_PREFACE_LEN) {
              return; // 前导未完，等待更多字节
            } else {
              h2Decided = true;
              startH2().feed(preBuf);
              preBuf = null;
              return;
            }
          } else {
            /* TLS 但 ALPN 非 h2 → HTTP/1.1 */
            h2Decided = true;
          }
        }

        if (bodyState) {
          /* pure body bytes — feed the stream directly (no string round-trip) */
          var take = Math.min(bodyState.remaining - bodyState.received, data.length);
          if (take > 0) {
            /* 高水位背压：handler 未消费 body 流时队列超限 → error 流并关连接 */
            if (!feedBody(conn, data.subarray(0, take))) return;
            bodyState.received += take;
          }
          if (take < data.length) {
            /* bytes beyond this body belong to the next request */
            raw = concatBytes(raw, data.subarray(take));
          }
          if (bodyState.received < bodyState.remaining) {
            return;  // body still streaming — wait for more data
          }
          bodyState.controller.close();
          bodyState = null;
          /* fall through: body complete — parse any buffered next request */
        } else {
          raw = concatBytes(raw, data);
        }
        /* 防内存 DoS：raw 已超出上限且无完整头部终止符 → 431 关闭 */
        if (raw.length > MAX_HEADER_SIZE && indexOfHdrEnd(raw) < 0) {
          try { pal.tcpWrite(conn, buildHTTPResponse(431, 'Request Header Fields Too Large',
            { 'Content-Length': '0', 'Connection': 'close' }, new Uint8Array(0))); } catch (e) {}
          pal.tcpClose(conn);
          return;
        }

        while (true) {
          var hdrEnd = indexOfHdrEnd(raw);
          if (hdrEnd < 0) return;  // header incomplete — wait for more data
          var headerStr = new TextDecoder().decode(raw.subarray(0, hdrEnd));
          var req = parseRequest(headerStr);
          if (!req) return;
          raw = raw.subarray(hdrEnd + 4);
          currentKeepAlive = req.keepAlive;

          /* ── WebSocket upgrade (no body) ── */
          var upgrade = (req.headers['upgrade'] || '').toLowerCase();
          if (upgrade === 'websocket') {
            var wsKey = req.headers['sec-websocket-key'];
            if (!wsKey) {
              pal.tcpWrite(conn, buildHTTPResponse(400, 'Bad Request',
                { 'Content-Length': '0', 'Connection': 'close' }, new Uint8Array(0)));
              return;
            }
            var wsHandler = wsRoutes[req.path];
            if (!wsHandler) {
              pal.tcpWrite(conn, buildHTTPResponse(404, 'Not Found',
                { 'Content-Length': '0', 'Connection': 'close' }, new Uint8Array(0)));
              return;
            }

            var wsRouteFn = typeof wsHandler === 'function' ? wsHandler : wsHandler.handler;
            var accept = wsAccept(wsKey);
            var respHdrs = {
              'Upgrade': 'websocket',
              'Connection': 'Upgrade',
              'Sec-WebSocket-Accept': accept,
              'Content-Type': 'text/plain',
              'Content-Length': '0'
            };
            /* subprotocol negotiation: echo the first supported protocol */
            var reqProtocols = (req.headers['sec-websocket-protocol'] || '')
              .split(',').map(function(s) { return s.trim(); });
            var supportedProtocols = null;
            if (wsHandler && typeof wsHandler === 'object' &&
                Array.isArray(wsHandler.protocols)) {
              supportedProtocols = wsHandler.protocols;
            }
            if (supportedProtocols && reqProtocols.length) {
              for (var i = 0; i < reqProtocols.length; i++) {
                if (supportedProtocols.indexOf(reqProtocols[i]) >= 0) {
                  respHdrs['Sec-WebSocket-Protocol'] = reqProtocols[i];
                  break;
                }
              }
            }
            /* permessage-deflate (RFC 7692): echo the extension when the client
             * offers it and the native streaming deflate primitives exist. */
            var reqExt = (req.headers['sec-websocket-extensions'] || '').toLowerCase();
            var pmd = typeof pal.deflateCreate === 'function' &&
                      reqExt.indexOf('permessage-deflate') >= 0;
            if (pmd) respHdrs['Sec-WebSocket-Extensions'] = 'permessage-deflate';
            pal.tcpWrite(conn, buildHTTPResponse(101, 'Switching Protocols', respHdrs, new Uint8Array(0)));

            ws = new WSConnection(conn);
            ws.state = 1;
            if (pmd) {
              try {
                ws._inflate = pal.inflateCreate();
                ws._deflate = pal.deflateCreate();
              } catch (e) {}
            }
            clearTimeout(idleTimer);
            if (typeof wsRouteFn === 'function') {
              try { wsRouteFn(ws); } catch (e) {}
            }
            if (ws.onopen) { try { ws.onopen({}); } catch (e) {} }
            return;
          }

          /* ── Regular HTTP request ── */
          var pathname = req.path;
          var qm = pathname.indexOf('?');
          var search = '';
          if (qm >= 0) {
            search = pathname.substring(qm);
            pathname = pathname.substring(0, qm);
          }

          /* body: ReadableStream fed from raw bytes (binary-safe) */
          var bodyStream = null;
          if (req.contentLength > 0) {
            var controller;
            bodyStream = new ReadableStream({ start: function(c) { controller = c; } });
            bodyState = { controller: controller, remaining: req.contentLength, received: 0 };
            /* feed body bytes already buffered in raw（首段也计入高水位） */
            var btake = Math.min(bodyState.remaining, raw.length);
            if (btake > 0) {
              if (!feedBody(conn, raw.subarray(0, btake))) return;
              raw = raw.subarray(btake);
              bodyState.received += btake;
            }
            if (bodyState.received >= bodyState.remaining) {
              try { bodyState.controller.close(); } catch (e) {}
              bodyState = null;
            }
          }
          var requestObj = {
            method: req.method,
            url: req.path,
            pathname: pathname,
            search: search,
            headers: req.headers,
            body: bodyStream,
            keepAlive: req.keepAlive
          };
          requestObj.text = function() {
            return streamToBytes(bodyStream).then(function(bytes) {
              return new TextDecoder().decode(bytes);
            });
          };
          requestObj.arrayBuffer = function() {
            return streamToBytes(bodyStream).then(function(bytes) {
              return bytes.buffer;
            });
          };

          currentResetIdle = resetIdle;

          try {
            var result = handler(requestObj);
            if (result && typeof result.then === 'function') {
              result.then(function(val) {
                try { sendResponse(conn, val); }
                catch (e) { sendResponse(conn, null, 500, 'Internal Server Error'); }
              }, function() {
                try { sendResponse(conn, null, 500, 'Internal Server Error'); }
                catch (e) { try { pal.tcpClose(conn); } catch (x) {} }
              });
            } else {
              sendResponse(conn, result);
            }
          } catch (e) {
            sendResponse(conn, null, 500, 'Internal Server Error');
          }

          if (bodyState) return;  // body still streaming — wait for the remaining data
          /* no body / body complete — continue parsing buffered requests (pipelining) */
        }
      };

      conn.onerror = function(msg) {
        if (ws && ws.onerror) { try { ws.onerror(msg); } catch (e) {} }
        if (bodyState) {
          try { bodyState.controller.error(msg); } catch (e) {}
          bodyState = null;
        }
      };

      conn.onclose = function(code) {
        clearTimeout(idleTimer);
        if (h2session) { try { h2session._teardown(); } catch (e) {} h2session = null; }

        var idx = conns.indexOf(conn);
        if (idx >= 0) conns.splice(idx, 1);
        if (ws) {
          if (ws._deflate) { try { pal.deflateFree(ws._deflate); } catch (e) {} ws._deflate = null; }
          if (ws._inflate) { try { pal.inflateFree(ws._inflate); } catch (e) {} ws._inflate = null; }
        }
        if (bodyState) {
          try { bodyState.controller.error(new Error('connection closed')); } catch (e) {}
          bodyState = null;
        }
        if (ws && ws.onclose && ws.state < 3) {
          ws.state = 3;
          var ev = { code: code || 1006, reason: '', wasClean: false };
          try { ws.onclose(ev); } catch (e) {}
        }
      };
    }

    function sendResponse(conn, val, status, statusText) {
      var enc = new TextEncoder();

      if (val === null || val === undefined) {
        status = status || 500;
        statusText = statusText || 'Internal Server Error';
        pal.tcpWrite(conn, buildHTTPResponse(status, statusText, {
          'Content-Type': 'text/plain', 'Content-Length': '0',
          'Connection': 'close'
        }, new Uint8Array(0)));
        return;
      }

      if (typeof val === 'string') {
        var b = enc.encode(val);
        pal.tcpWrite(conn, buildHTTPResponse(200, 'OK', {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': '' + b.length,
          'Connection': currentKeepAlive ? 'keep-alive' : 'close'
        }, b));
        if (!currentKeepAlive) pal.tcpClose(conn);
        return;
      }

      if (typeof val === 'object' && val !== null) {
        var st = val.status || 200;
        var stText = val.statusText || (st === 200 ? 'OK' : '');
        var hdrs = Object.create(null);   /* 头名不做原型链解析（F4 审计） */
        if (val.headers && typeof val.headers.forEach === 'function') {
          val.headers.forEach(function(v, k) { hdrs[k] = v; });
        } else if (val.headers) {
          for (var k in val.headers) {
            if (typeof val.headers[k] !== 'function' && k[0] !== '_')
              hdrs[k] = String(val.headers[k]);
          }
        }
        /* Body: _body (string/ArrayBuffer/Uint8Array) or text() sync fallback.
         * ArrayBuffer and Uint8Array go straight to buildHTTPResponse as raw bytes
         * (binary-safe). Strings go through TextEncoder for the rest. */
        var b = val._body;
        var b2;
        if (b instanceof ArrayBuffer) {
          b2 = new Uint8Array(b);
        } else if (typeof b === 'string') {
          b2 = enc.encode(b);
        } else if (b instanceof Uint8Array) {
          b2 = b;
        } else if (b && typeof b === 'object' && !(b instanceof Uint8Array)) {
          /* Blob/FormData/URLSearchParams-like: stringify */
          try { b2 = enc.encode(String(b)); } catch (e) {}
        }
        if (!b2 && typeof val.text === 'function') {
          try { var t = val.text(); if (typeof t === 'string') b2 = enc.encode(t); } catch (e) {}
        }
        if (!b2) b2 = enc.encode('');
        hdrs['Content-Length'] = '' + b2.length;
        if (!hdrs['Connection']) hdrs['Connection'] = currentKeepAlive ? 'keep-alive' : 'close';
        pal.tcpWrite(conn, buildHTTPResponse(st, stText, hdrs, b2));
        if (currentKeepAlive) currentResetIdle();
        return;
      }

      /* Numbers, booleans, etc. are invalid handler results */
      pal.tcpWrite(conn, buildHTTPResponse(500, 'Internal Server Error', {
        'Content-Type': 'text/plain',
        'Content-Length': '0',
        'Connection': 'close'
      }, new Uint8Array(0)));
      pal.tcpClose(conn);
    }

    var listener;
    var tls = options.tls;
    if (tls && tls.cert && tls.key) {
      /* h2 栈存在且用户未指定 alpn：默认补 ['h2','http/1.1']，让 TLS 端口
       * 同时服务 h2（gRPC）与 HTTP/1.1。显式 alpn 优先。 */
      var tlsCfg = tls;
      if (H2SessionClass && !tlsCfg.alpn) {
        tlsCfg = {};
        for (var tk in tls) {
          if (typeof tls[tk] !== 'function' && tls[tk] !== undefined) tlsCfg[tk] = tls[tk];
        }
        tlsCfg.alpn = ['h2', 'http/1.1'];
      }
      listener = pal.tcpListen(port, hostname, 128, handleConnection, tlsCfg);
    } else {
      listener = pal.tcpListen(port, hostname, 128, handleConnection);
    }
    var conns = [];
    activeServer.close = function() {
      activeServer.closed = true;
      if (activeInstance === activeServer) activeInstance = null;
      pal.tcpCloseListener(listener);
    };
    return activeServer;
  };
}