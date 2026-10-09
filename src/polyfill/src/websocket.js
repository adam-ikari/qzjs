/**
 * qzjs polyfill: WebSocket (client) — pure JS RFC 6455 implementation
 *
 * Uses pal.tcpConnect/tcpWrite/tcpClose for raw TCP transport.
 * The WebSocket protocol (handshake, frame masking, frame parsing,
 * close handshake, ping/pong) is implemented entirely in JS.
 *
 * The WS client and server are architecturally independent — both
 * implement the same RFC 6455 at different layers.
 */

export function setupWebSocket(pal) {
  if (typeof pal.tcpConnect !== 'function') return;

  var CONNECTING = 0;
  var OPEN = 1;
  var CLOSING = 2;
  var CLOSED = 3;

  // ── RFC 6455 helpers ──

  var OPCODE_CONT = 0x0;
  var OPCODE_TEXT = 0x1;
  var OPCODE_BINARY = 0x2;
  var OPCODE_CLOSE = 0x8;
  var OPCODE_PING = 0x9;
  var OPCODE_PONG = 0xA;

  /* Generate a random Sec-WebSocket-Key (16 bytes → base64). */
  function makeKey() {
    var key = new Uint8Array(16);
    crypto.getRandomValues(key);
    return btoa(String.fromCharCode.apply(null, key));
  }

  /* Compute the expected Sec-WebSocket-Accept for a given key. */
  function computeAccept(key) {
    var MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';  // RFC 6455 §1.3
    var s = key + MAGIC;
    // SHA-1 via crypto.subtle
    return crypto.subtle.digest('SHA-1', new TextEncoder().encode(s))
      .then(function(hash) {
        return btoa(String.fromCharCode.apply(null, new Uint8Array(hash)));
      });
  }

  /* Concatenate fragmented payload chunks into one Uint8Array. */
  function concatParts(parts) {
    var total = 0;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
    return out;
  }

  function buildFrame(opcode, payload, mask) {
    var len = payload.length;
    var headerSize = 2;
    if (len >= 126) headerSize += (len < 65536 ? 2 : 8);
    var maskLen = mask ? 4 : 0;
    var frame = new Uint8Array(headerSize + maskLen + len);
    var pos = 0;
    frame[pos++] = 0x80 | opcode;  // FIN + opcode
    if (len < 126) {
      frame[pos++] = (mask ? 0x80 : 0) | len;
    } else if (len < 65536) {
      frame[pos++] = (mask ? 0x80 : 0) | 126;
      frame[pos++] = (len >> 8) & 0xFF;
      frame[pos++] = len & 0xFF;
    } else {
      frame[pos++] = (mask ? 0x80 : 0) | 127;
      for (var i = 7; i >= 0; i--) frame[pos++] = (len >> (i * 8)) & 0xFF;
    }
    if (mask) {
      var maskKey = new Uint8Array(4);
      crypto.getRandomValues(maskKey);
      frame.set(maskKey, pos);
      pos += 4;
      for (var i = 0; i < len; i++)
        frame[pos + i] = payload[i] ^ maskKey[i % 4];
    } else {
      frame.set(payload, pos);
    }
    return frame.buffer;
  }

  /* ── WebSocket class ── */

  class WebSocket extends EventTarget {
    constructor(url) {
      super();
      this._url = url;
      this._readyState = CONNECTING;
      this._onopen = null;
      this._onmessage = null;
      this._onerror = null;
      this._onclose = null;
      this._protocol = '';
      this._tcp = null;
      this._buf = null;        // accumulated receive buffer (ArrayBuffer)
      this._bufView = null;    // Uint8Array view of _buf
      this._handshakeDone = false;
      this._closeSent = false;
      this._closeCode = 1000;
      this._closeReason = '';
      this._binaryType = 'blob';   /* 收到二进制帧的呈现形态（blob|arraybuffer） */
      this._fragOpcode = 0;        /* 分片消息起始 opcode（0 = 无分片进行中） */
      this._fragParts = null;      /* 分片载荷片段 */

      // Parse URL
      var isSecure = url.indexOf('wss://') === 0;
      if (isSecure) throw new Error('wss:// not supported yet');
      if (url.indexOf('ws://') !== 0) throw new Error('invalid WebSocket URL: ' + url);
      var rest = url.slice(5);
      var slashIdx = rest.indexOf('/');
      var hostPort = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
      var path = slashIdx >= 0 ? rest.slice(slashIdx) : '/';
      var colonIdx = hostPort.indexOf(':');
      var host = colonIdx >= 0 ? hostPort.slice(0, colonIdx) : hostPort;
      var port = colonIdx >= 0 ? parseInt(hostPort.slice(colonIdx + 1), 10) : 80;
      if (!port || port < 1) port = 80;

      var self = this;
      this._key = makeKey();
      this._host = host;
      this._port = port;
      this._path = path;

      this._tcp = pal.tcpConnect(host, port, {
        onconnect: function() { self._onConnect(); },
        ondata: function(data) { self._onData(data); },
        onerror: function(msg) { self._onError(msg); },
        onclose: function() { self._onTcpClose(); },
      });
    }

    /* Event handler attributes → backing event listeners (EventTarget semantics). */
    get onopen() { return this._onopen; }
    set onopen(fn) {
      if (this._onopen) this.removeEventListener('open', this._onopen);
      this._onopen = fn;
      if (fn) this.addEventListener('open', fn);
    }
    get onmessage() { return this._onmessage; }
    set onmessage(fn) {
      if (this._onmessage) this.removeEventListener('message', this._onmessage);
      this._onmessage = fn;
      if (fn) this.addEventListener('message', fn);
    }
    get onerror() { return this._onerror; }
    set onerror(fn) {
      if (this._onerror) this.removeEventListener('error', this._onerror);
      this._onerror = fn;
      if (fn) this.addEventListener('error', fn);
    }
    get onclose() { return this._onclose; }
    set onclose(fn) {
      if (this._onclose) this.removeEventListener('close', this._onclose);
      this._onclose = fn;
      if (fn) this.addEventListener('close', fn);
    }

    // ── Data accumulation ──

    _appendData(data) {
      var incoming = new Uint8Array(data);
      if (!this._buf) {
        this._buf = data;
        this._bufView = incoming;
        this._bufPos = 0;
      } else {
        var merged = new Uint8Array(this._buf.byteLength + incoming.length);
        merged.set(this._bufView, 0);
        merged.set(incoming, this._bufView.length);
        this._buf = merged.buffer;
        this._bufView = merged;
      }
    }

    _consume(n) {
      if (n >= this._bufView.length) {
        this._buf = null;
        this._bufView = null;
        return;
      }
      this._bufView = this._bufView.subarray(n);
      this._buf = this._bufView.buffer;
    }

    // ── Incoming data handler ──

    _onConnect() {
      // TCP connection established — send the WebSocket upgrade request
      var req = 'GET ' + this._path + ' HTTP/1.1\r\n' +
                'Host: ' + this._host + ':' + this._port + '\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                'Sec-WebSocket-Key: ' + this._key + '\r\n' +
                'Sec-WebSocket-Version: 13\r\n' +
                '\r\n';
      pal.tcpWrite(this._tcp, req);
    }

    _onData(data) {
      try {
        this._appendData(data);
        if (this._handshakeDone) {
          this._parseFrames();
        } else {
          this._parseHandshake();
        }
      } catch (e) {
        this._fail(e && e.message ? e.message : String(e));
      }
    }

    // ── Handshake ──

    _parseHandshake() {
      var view = this._bufView;
      // Find end of HTTP headers (double CRLF)
      var headerEnd = -1;
      for (var i = 0; i + 3 < view.length; i++) {
        if (view[i] === 13 && view[i+1] === 10 && view[i+2] === 13 && view[i+3] === 10) {
          headerEnd = i + 4;
          break;
        }
      }
      if (headerEnd < 0) return; // need more data

      var headerStr = new TextDecoder().decode(view.subarray(0, headerEnd));
      var lines = headerStr.split('\r\n');

      // Check status line
      if (lines[0].indexOf('101') < 0) {
        this._fail('unexpected HTTP status: ' + lines[0]);
        return;
      }

      // Verify the upgrade headers and Sec-WebSocket-Accept
      var accept = null;
      var protocol = '';
      var upgradeOk = false;
      var connectionOk = false;
      for (var j = 1; j < lines.length; j++) {
        var l = lines[j].toLowerCase();
        if (l.indexOf('sec-websocket-accept:') === 0) {
          accept = lines[j].split(':')[1].trim();
        } else if (l.indexOf('sec-websocket-protocol:') === 0) {
          protocol = lines[j].split(':')[1].trim();
        } else if (l.indexOf('upgrade:') === 0) {
          upgradeOk = l.indexOf('websocket') >= 0;
        } else if (l.indexOf('connection:') === 0) {
          connectionOk = l.indexOf('upgrade') >= 0;
        }
      }
      if (!upgradeOk || !connectionOk) {
        this._fail('missing Upgrade/Connection header');
        return;
      }

      var self = this;
      computeAccept(this._key).then(function(expected) {
        if (accept !== expected) {
          self._fail('invalid Sec-WebSocket-Accept');
          return;
        }
        // Consume header bytes
        self._consume(headerEnd);
        self._handshakeDone = true;
        self._readyState = OPEN;
        self._protocol = protocol;
        self.dispatchEvent(new Event('open'));
        // Process any pipelined frame bytes
        if (self._bufView) self._parseFrames();
      }).catch(function(e) {
        self._fail('SHA-1 failed: ' + (e && e.message ? e.message : String(e)));
      });
    }

    // ── Frame parsing ──

    _parseFrames() {
      /* 解析帧在 OPEN 与 CLOSING 都允许——close() 发出 close 帧后进入
       * CLOSING，仍需接收并处理服务端回应的 close echo（onclose 由此触发）。 */
      if (this._readyState !== OPEN && this._readyState !== CLOSING) return;
      while (this._bufView && this._bufView.length >= 2) {
        var view = this._bufView;
        var b0 = view[0];
        var b1 = view[1];
        var fin = (b0 & 0x80) !== 0;
        var opcode = b0 & 0x0F;
        var masked = (b1 & 0x80) !== 0;
        var len = b1 & 0x7F;
        var offset = 2;

        /* No extension was negotiated, so the RSV bits must be clear. */
        if ((b0 & 0x70) !== 0) { this._fail('RSV bits set (no extension negotiated)'); return; }
        /* RFC 6455 §5.1: a client MUST NOT accept masked frames. */
        if (masked) { this._fail('masked frame from server (RFC 6455 §5.1)'); return; }
        /* Control frames must be unfragmented and ≤ 125 bytes. */
        if ((opcode & 0x8) !== 0 && (!fin || len > 125)) {
          this._fail('invalid control frame');
          return;
        }

        if (len === 126) {
          if (view.length < 4) break;
          len = (view[2] << 8) | view[3];
          offset = 4;
        } else if (len === 127) {
          if (view.length < 10) break;
          len = 0;
          for (var i = 0; i < 8; i++) len = (len << 8) | view[2 + i];
          offset = 10;
        }

        if (view.length < offset + len) break; // need more data

        // Extract payload (server frames are unmasked)
        var payload = view.subarray(offset, offset + len);

        // Consume the frame
        this._consume(offset + len);

        // Handle control frames inline; data frames are dispatched via onmessage
        this._handleFrame(fin, opcode, payload);
      }
    }

    _handleFrame(fin, opcode, payload) {
      if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
        if (!fin) {
          /* start a fragmented message */
          this._fragOpcode = opcode;
          this._fragParts = [payload];
          return;
        }
        this._deliverMessage(opcode, payload);
      } else if (opcode === OPCODE_CONT) {
        if (this._fragOpcode === 0 || !this._fragParts) {
          /* continuation without a start — protocol error */
          this._fail('unexpected continuation frame');
          return;
        }
        this._fragParts.push(payload);
        if (fin) {
          var fragOp = this._fragOpcode;
          var parts = this._fragParts;
          this._fragOpcode = 0;
          this._fragParts = null;
          this._deliverMessage(fragOp, concatParts(parts));
        }
      } else if (opcode === OPCODE_CLOSE) {
        var code = 1000;
        var reason = '';
        if (payload.length >= 2) {
          code = (payload[0] << 8) | payload[1];
          if (payload.length > 2)
            reason = new TextDecoder().decode(payload.subarray(2));
        }
        // Echo the close frame back (RFC 6455 §5.5.1)
        if (!this._closeSent) {
          var reasonBytes = new TextEncoder().encode(reason);
          var closePayload = new Uint8Array(2 + reasonBytes.length);
          closePayload[0] = (code >> 8) & 0xFF;
          closePayload[1] = code & 0xFF;
          closePayload.set(reasonBytes, 2);
          var frame = buildFrame(OPCODE_CLOSE, closePayload, true);
          pal.tcpWrite(this._tcp, frame);
        }
        this._readyState = CLOSED;
        this.dispatchEvent(new CloseEvent('close', { code: code, reason: reason, wasClean: true }));
        // Close the underlying TCP connection to drain the event loop
        pal.tcpClose(this._tcp);
      } else if (opcode === OPCODE_PING) {
        // Respond with Pong
        var pong = buildFrame(OPCODE_PONG, payload, true);
        pal.tcpWrite(this._tcp, pong);
      } else if (opcode === OPCODE_PONG) {
        // Nothing to do
      }
    }

    _deliverMessage(opcode, payload) {
      if (this._readyState !== OPEN) return;
      if (opcode === OPCODE_TEXT) {
        var text = new TextDecoder().decode(payload);
        this.dispatchEvent(new MessageEvent('message', { data: text }));
        return;
      }
      /* binary frame: detached ArrayBuffer, presented per binaryType */
      var ab = payload.slice().buffer;
      var data;
      if (this._binaryType === 'arraybuffer') {
        data = ab;
      } else if (typeof Blob !== 'undefined') {
        data = new Blob([ab]);
      } else {
        data = ab;
      }
      this.dispatchEvent(new MessageEvent('message', { data: data }));
    }

    _onError(msg) {
      if (this._readyState === CLOSED) return;
      this._fail(msg);
    }

    _fail(msg) {
      if (this._readyState === CLOSED) return;
      this._readyState = CLOSED;
      this.dispatchEvent(new Event('error'));
      /* 异常关闭：规范要求 code 1006、reason 空串的 close 事件 */
      this.dispatchEvent(new CloseEvent('close', { code: 1006, reason: '', wasClean: false }));
      /* 释放底层 TCP，避免泄漏挂起连接 */
      if (this._tcp) { try { pal.tcpClose(this._tcp); } catch (e) {} }
    }

    _onTcpClose() {
      if (this._readyState === CLOSED) return;
      this._readyState = CLOSED;
      this.dispatchEvent(new CloseEvent('close', { code: 1006, reason: '', wasClean: false }));
    }

    // ── Public API ──

    get url() { return this._url; }
    get readyState() { return this._readyState; }
    get protocol() { return this._protocol; }
    get extensions() { return ''; }
    get bufferedAmount() { return 0; }
    get CONNECTING() { return CONNECTING; }
    get OPEN() { return OPEN; }
    get CLOSING() { return CLOSING; }
    get CLOSED() { return CLOSED; }

    get binaryType() { return this._binaryType; }
    set binaryType(v) {
      v = String(v);
      if (v !== 'blob' && v !== 'arraybuffer') {
        throw new TypeError('binaryType must be "blob" or "arraybuffer"');
      }
      this._binaryType = v;
    }

    send(data) {
      if (this._readyState === CONNECTING) {
        throw new DOMException('WebSocket is still CONNECTING', 'InvalidStateError');
      }
      if (this._readyState !== OPEN) return;   /* CLOSING / CLOSED → discard */
      var opcode = OPCODE_TEXT;
      var payload;
      if (typeof data === 'string') {
        payload = new TextEncoder().encode(data);
      } else if (data instanceof ArrayBuffer) {
        payload = new Uint8Array(data);
        opcode = OPCODE_BINARY;
      } else if (ArrayBuffer.isView(data)) {
        payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        opcode = OPCODE_BINARY;
      } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
        payload = data._getBytes ? data._getBytes() : new Uint8Array(0);
        opcode = OPCODE_BINARY;
      } else {
        /* numbers/booleans etc → text via String() (WebIDL conversion) */
        payload = new TextEncoder().encode(String(data));
      }
      var frame = buildFrame(opcode, payload, true);
      pal.tcpWrite(this._tcp, frame);
    }

    close(code, reason) {
      if (code !== undefined) {
        code = Number(code);
        if (code !== 1000 && (code < 3000 || code > 4999)) {
          throw new DOMException('close code must be 1000 or 3000-4999', 'InvalidAccessError');
        }
      }
      if (reason !== undefined && new TextEncoder().encode(String(reason)).length > 123) {
        throw new DOMException('close reason must be at most 123 bytes', 'SyntaxError');
      }
      if (this._readyState === CLOSING || this._readyState === CLOSED) return;
      this._closeCode = (code === undefined) ? 1000 : code;
      this._closeReason = (reason === undefined) ? '' : String(reason);
      if (this._readyState === CONNECTING) {
        /* 连接尚未建立：无法完成 close 握手 → 按规范 fail（error + close 1006）。 */
        this._readyState = CLOSING;
        this._fail('connection closed before establishment');
        return;
      }
      this._readyState = CLOSING;
      this._closeSent = true;
      var reasonBytes = new TextEncoder().encode(this._closeReason);
      var payload = new Uint8Array(2 + reasonBytes.length);
      payload[0] = (this._closeCode >> 8) & 0xFF;
      payload[1] = this._closeCode & 0xFF;
      if (reasonBytes.length > 0) payload.set(reasonBytes, 2);
      var frame = buildFrame(OPCODE_CLOSE, payload, true);
      pal.tcpWrite(this._tcp, frame);
    }
  }

  // ── Register globals ──

  globalThis.WebSocket = WebSocket;
  globalThis.CloseEvent = globalThis.CloseEvent || class CloseEvent extends Event {
    constructor(type, init) {
      super(type, init);
      this.code = (init && init.code) || 1000;
      this.reason = (init && init.reason) || '';
      this.wasClean = (init && init.wasClean) || false;
    }
  };
}
