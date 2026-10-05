/**
 * qzjs Polyfill - fetch API
 *
 * Implements WHATWG Fetch standard: Headers, Request, Response, fetch()
 * Uses pal.httpRequestStream(url, method, headers_json, body, onHeaders, onData, onEnd)
 * for streaming HTTP responses via ReadableStream.
 *
 * PAL httpRequestStream callbacks:
 *   onHeaders(status, headersJson) — called once with response status and headers
 *   onData(arrayBuffer)            — called for each chunk of response body
 *   onEnd(errorStatus, errorMsg)   — response completes (0 = success);
 *                                     errorMsg = diagnostic or null
 *
 * Depends on: DOMException (from abort.js)
 */

export function setupFetch(pal) {
  'use strict';

  // ================================================================
  // Status text mapping for common HTTP status codes
  // PAL doesn't return status text, so we map it ourselves.
  // ================================================================

  var STATUS_TEXTS = {
    100: 'Continue',
    101: 'Switching Protocols',
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    203: 'Non-Authoritative Information',
    204: 'No Content',
    205: 'Reset Content',
    206: 'Partial Content',
    300: 'Multiple Choices',
    301: 'Moved Permanently',
    302: 'Found',
    303: 'See Other',
    304: 'Not Modified',
    307: 'Temporary Redirect',
    308: 'Permanent Redirect',
    400: 'Bad Request',
    401: 'Unauthorized',
    402: 'Payment Required',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    406: 'Not Acceptable',
    407: 'Proxy Authentication Required',
    408: 'Request Timeout',
    409: 'Conflict',
    410: 'Gone',
    411: 'Length Required',
    412: 'Precondition Failed',
    413: 'Payload Too Large',
    414: 'URI Too Long',
    415: 'Unsupported Media Type',
    416: 'Range Not Satisfiable',
    417: 'Expectation Failed',
    418: "I'm a Teapot",
    422: 'Unprocessable Entity',
    425: 'Too Early',
    426: 'Upgrade Required',
    428: 'Precondition Required',
    429: 'Too Many Requests',
    431: 'Request Header Fields Too Large',
    451: 'Unavailable For Legal Reasons',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
    505: 'HTTP Version Not Supported',
    506: 'Variant Also Negotiates',
    507: 'Insufficient Storage',
    508: 'Loop Detected',
    510: 'Not Extended',
    511: 'Network Authentication Required'
  };

  // ================================================================
  // Helpers
  // ================================================================

  function normalizeName(name) {
    if (typeof name !== 'string') {
      name = String(name);
    }
    var normalized = name.toLowerCase();
    if (/[^a-z0-9\-!#$%&'*+.^_`|~]/.test(normalized)) {
      throw new TypeError('Invalid header name: ' + name);
    }
    return normalized;
  }

  function normalizeValue(value) {
    if (value === undefined || value === null) {
      throw new TypeError('Invalid header value');
    }
    var str = String(value);
    if (/[^\t\x20-\x7e\x80-\xff]/.test(str)) {
      throw new TypeError('Invalid header value: ' + str);
    }
    return str;
  }

  /* WHATWG method：合法 HTTP token，规范化（大写）。与 /^[A-Z]+$/ 相比接受
   * 完整 token 字符集（如 'PATCH'、'MKCOL'），并拒绝空串/含空格等非法值。 */
  function normalizeMethod(method) {
    var m = String(method);
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(m)) {
      throw new TypeError('Invalid HTTP method: ' + m);
    }
    return m.toUpperCase();
  }

  /* Response 构造的 status 校验：整数且在 200-599（WHATWG Response 构造器）。
   * Response.error()/opaqueredirect 走内部路径绕开（status 0）。 */
  function validateStatus(status) {
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      throw new RangeError('Invalid status code: ' + status);
    }
    return status;
  }

  /* 构造规范化后的 URL href；非法 URL 抛 TypeError（WHATWG fetch 要求绝对 URL）。 */
  function normalizeUrl(url) {
    return new URL(String(url)).href;
  }

  // String-to-Uint8Array using TextEncoder for proper UTF-8 support
  function stringToUint8Array(str) {
    return new TextEncoder().encode(str);
  }

  // Serialize a Request body to bytes: returns a Uint8Array (or null) when
  // the body is available synchronously, or a Promise<Uint8Array> when it is
  // a stream that must be read asynchronously.
  function serializeBody(body) {
    if (body == null) {
      return null;
    }
    if (typeof body === 'string') {
      return new TextEncoder().encode(body);
    }
    if (body instanceof Uint8Array) {
      return body;
    }
    if (body instanceof ArrayBuffer) {
      return new Uint8Array(body);
    }
    if (typeof body.getReader === 'function') {
      var reader = body.getReader();
      var chunks = [];
      var total = 0;
      function pump() {
        return reader.read().then(function(result) {
          if (result.done) {
            reader.releaseLock();
            var out = new Uint8Array(total);
            var off = 0;
            for (var i = 0; i < chunks.length; i++) {
              out.set(chunks[i], off);
              off += chunks[i].length;
            }
            return out;
          }
          var chunk = result.value;
          if (!(chunk instanceof Uint8Array)) {
            chunk = stringToUint8Array(String(chunk));
          }
          chunks.push(chunk);
          total += chunk.length;
          return pump();
        });
      }
      return pump();
    }
    return new TextEncoder().encode(String(body));
  }

  // ================================================================
  // Headers class
  // WHATWG Headers interface with case-insensitive header names.
  // ================================================================

  function Headers(init) {
    this._map = new Map();

    if (init === null) {
      throw new TypeError('Headers init must not be null');
    }
    if (init !== undefined) {
      if (init instanceof Headers) {
        init._map.forEach(function(value, key) {
          this._map.set(key, value);
        }.bind(this));
      } else if (typeof init === 'object') {
        if (Symbol && Symbol.iterator && init[Symbol.iterator]) {
          // Iterable of [name, value] pairs
          var items = Array.from(init);
          for (var i = 0; i < items.length; i++) {
            var pair = items[i];
            if (!Array.isArray(pair) || pair.length !== 2) {
              throw new TypeError('Headers init: each header must be a [name, value] pair');
            }
            this.append(pair[0], pair[1]);
          }
        } else {
          // Plain object
          var keys = Object.keys(init);
          for (var j = 0; j < keys.length; j++) {
            this.append(keys[j], init[keys[j]]);
          }
        }
      } else {
        throw new TypeError('Headers init must be Headers, object, or iterable');
      }
    }
  }

  Headers.prototype.get = function(name) {
    var value = this._map.get(normalizeName(name));
    /* 命中但值为空串时返回 ''，未命中才返回 null */
    return value === undefined ? null : value;
  };

  Headers.prototype.set = function(name, value) {
    this._map.set(normalizeName(name), normalizeValue(value));
  };

  Headers.prototype.has = function(name) {
    return this._map.has(normalizeName(name));
  };

  Headers.prototype.delete = function(name) {
    this._map.delete(normalizeName(name));
  };

  Headers.prototype.append = function(name, value) {
    var key = normalizeName(name);
    var existing = this._map.get(key);
    if (existing) {
      this._map.set(key, existing + ', ' + normalizeValue(value));
    } else {
      this._map.set(key, normalizeValue(value));
    }
  };

  Headers.prototype.forEach = function(callback, thisArg) {
    this._map.forEach(function(value, key) {
      callback.call(thisArg, value, key, this);
    }.bind(this));
  };

  Headers.prototype.entries = function() {
    return this._map.entries();
  };

  Headers.prototype.keys = function() {
    return this._map.keys();
  };

  Headers.prototype.values = function() {
    return this._map.values();
  };

  if (Symbol) {
    Headers.prototype[Symbol.iterator] = function() {
      return this._map.entries();
    };
  }

  // ================================================================
  // Body mixin helper
  // Shared body consumption logic for Request and Response.
  // ================================================================

  function consumeBody(body) {
    if (typeof body === 'string') {
      return body;
    }
    if (body === null || body === undefined) {
      return '';
    }
    /* 字节 body（SW 回话重建的 Response / 非流式网络回退）按 UTF-8 解码，
     * 而非 String(Uint8Array) 的逗号字节列表 */
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
      return new TextDecoder().decode(body);
    }
    return String(body);
  }

  // ================================================================
  // Request class
  // ================================================================

  function Request(input, init) {
    init = init || {};

    // input can be a string URL or another Request
    if (input instanceof Request) {
      this._method = normalizeMethod(init.method || input.method);
      this._url = input.url;
      this._headers = new Headers(init.headers || input.headers);
      this._body = init.body !== undefined ? init.body : input._body;
      this._signal = init.signal || input.signal;
      this._redirect = init.redirect || input.redirect || 'follow';
      this._keepalive = init.keepalive !== undefined ? !!init.keepalive : input.keepalive;
      this._cache = init.cache || input.cache || 'default';
      this._mode = init.mode || input.mode || 'cors';
      this._credentials = init.credentials || input.credentials || 'same-origin';
    } else {
      this._method = normalizeMethod(init.method || 'GET');
      this._url = normalizeUrl(input);
      this._headers = new Headers(init.headers);
      this._body = init.body !== undefined ? init.body : null;
      this._signal = init.signal || null;
      this._redirect = init.redirect || 'follow';
      this._keepalive = !!init.keepalive;
      this._cache = init.cache || 'default';
      this._mode = init.mode || 'cors';
      this._credentials = init.credentials || 'same-origin';
    }

    this._bodyUsed = false;

  }

  Object.defineProperty(Request.prototype, 'method', {
    get: function() { return this._method; }
  });

  Object.defineProperty(Request.prototype, 'url', {
    get: function() { return this._url; }
  });

  Object.defineProperty(Request.prototype, 'headers', {
    get: function() { return this._headers; }
  });

  Object.defineProperty(Request.prototype, 'body', {
    get: function() { return this._body; }
  });

  Object.defineProperty(Request.prototype, 'bodyUsed', {
    get: function() { return this._bodyUsed; }
  });

  Object.defineProperty(Request.prototype, 'signal', {
    get: function() { return this._signal; }
  });

  Object.defineProperty(Request.prototype, 'redirect', {
    get: function() { return this._redirect; }
  });

  Object.defineProperty(Request.prototype, 'keepalive', {
    get: function() { return this._keepalive; }
  });

  Object.defineProperty(Request.prototype, 'cache', {
    get: function() { return this._cache; }
  });

  Object.defineProperty(Request.prototype, 'mode', {
    get: function() { return this._mode; }
  });

  Object.defineProperty(Request.prototype, 'credentials', {
    get: function() { return this._credentials; }
  });

  Request.prototype.clone = function() {
    if (this._bodyUsed) {
      throw new TypeError('Cannot clone a Request whose body has been used');
    }
    return new Request(this);
  };

  Request.prototype.text = function() {
    if (this._bodyUsed) {
      throw new TypeError('Body has already been used');
    }
    this._bodyUsed = true;
    return Promise.resolve(consumeBody(this._body));
  };

  Request.prototype.json = function() {
    return this.text().then(function(text) {
      return JSON.parse(text);
    });
  };

  Request.prototype.arrayBuffer = function() {
    return this.text().then(function(text) {
      var u8 = stringToUint8Array(text);
      return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    });
  };

  Request.prototype.blob = function() {
    return this.arrayBuffer().then(function(buf) {
      return new Blob([buf]);
    });
  };

  // ================================================================
  // ReadableStream (streaming implementation)
  // Uses the GLOBAL streams.js ReadableStream (registered on globalThis by
  // setupStreams) so fetch response bodies interoperate with the rest of the
  // runtime: response.body.pipeTo(dest), tee(), and for-await all work. The
  // class is resolved lazily — setupStreams runs at init time (index.js),
  // before any fetch() call.
  // ================================================================

  function makeReadableStream(underlyingSource) {
    return new globalThis.ReadableStream(underlyingSource);
  }

  // ================================================================
  // Response class
  // ================================================================

  function Response(body, init) {
    init = init || {};

    var status = init.status !== undefined ? Number(init.status) : 200;
    this._status = validateStatus(status);
    /* statusText 默认空串；STATUS_TEXTS 仅由内部 fetch 路径显式提供 */
    this._statusText = init.statusText !== undefined ? String(init.statusText) : '';
    this._headers = new Headers(init.headers);
    this._bodyUsed = false;
    this._type = 'default';
    this._url = init.url || '';
    this._redirected = init.redirected || false;

    // body can be a ReadableStream (duck-type check) or a string/null (non-streaming)
    if (body && typeof body.getReader === 'function') {
      this._bodyStream = body;
      this._body = null;
    } else {
      this._bodyStream = null;
      this._body = body !== undefined ? body : null;
    }
  }

  Object.defineProperty(Response.prototype, 'status', {
    get: function() { return this._status; }
  });

  Object.defineProperty(Response.prototype, 'statusText', {
    get: function() { return this._statusText; }
  });

  Object.defineProperty(Response.prototype, 'ok', {
    get: function() { return this._status >= 200 && this._status <= 299; }
  });

  Object.defineProperty(Response.prototype, 'headers', {
    get: function() { return this._headers; }
  });

  Object.defineProperty(Response.prototype, 'body', {
    get: function() {
      if (this._bodyStream) return this._bodyStream;
      if (this._body == null) return null;
      // Create a ReadableStream from the body string for non-streaming responses
      var bodyStr = consumeBody(this._body);
      var arr = stringToUint8Array(bodyStr);
      return makeReadableStream({
        start: function(controller) {
          controller.enqueue(arr);
          controller.close();
        }
      });
    }
  });

  Object.defineProperty(Response.prototype, 'bodyUsed', {
    get: function() { return this._bodyUsed; }
  });

  Object.defineProperty(Response.prototype, 'type', {
    get: function() { return this._type; }
  });

  Object.defineProperty(Response.prototype, 'url', {
    get: function() { return this._url; }
  });

  Object.defineProperty(Response.prototype, 'redirected', {
    get: function() { return this._redirected; }
  });

  Response.prototype.clone = function() {
    if (this._bodyUsed) {
      throw new TypeError('Cannot clone a Response whose body has been used');
    }
    if (this._bodyStream) {
      /* WHATWG：流式 clone = tee。原流被 tee 锁定 reader 后不能再 getReader，
       * 必须整体替换为分支流；本对象与 clone 各持一个分支（SW-2 cache.put
       * 依赖此语义：put 存副本，调用方继续用原 response）。 */
      var branches = this._bodyStream.tee();
      this._bodyStream = branches[0];
      var cloned = new Response(branches[1], {
        status: this._status,
        statusText: this._statusText,
        headers: this._headers,
        url: this._url,
        redirected: this._redirected
      });
      cloned._type = this._type;
      return cloned;
    }
    var cloned = new Response(this._body, {
      status: this._status,
      statusText: this._statusText,
      headers: this._headers,
      url: this._url,
      redirected: this._redirected
    });
    cloned._type = this._type;
    return cloned;
  };

  Response.prototype.text = function() {
    var self = this;
    if (self._bodyUsed) {
      throw new TypeError('Body has already been used');
    }
    self._bodyUsed = true;

    if (self._bodyStream) {
      // Read all chunks from the stream and concatenate
      return self._readStreamFully().then(function(chunks) {
        var totalLen = 0;
        for (var i = 0; i < chunks.length; i++) {
          totalLen += chunks[i].length;
        }
        var combined = new Uint8Array(totalLen);
        var offset = 0;
        for (var i = 0; i < chunks.length; i++) {
          combined.set(chunks[i], offset);
          offset += chunks[i].length;
        }
        // Decode as UTF-8
        return new TextDecoder('utf-8').decode(combined);
      });
    }

    return Promise.resolve(consumeBody(self._body));
  };

  Response.prototype._readStreamFully = function() {
    var reader = this._bodyStream.getReader();
    var chunks = [];
    function pump() {
      return reader.read().then(function(result) {
        if (result.done) return chunks;
        var chunk = result.value;
        // Convert ArrayBuffer to Uint8Array if needed
        if (chunk instanceof ArrayBuffer) {
          chunk = new Uint8Array(chunk);
        }
        chunks.push(chunk);
        return pump();
      });
    }
    return pump();
  };

  Response.prototype.json = function() {
    return this.text().then(function(text) {
      return JSON.parse(text);
    });
  };

  Response.prototype.arrayBuffer = function() {
    var self = this;
    if (self._bodyUsed) {
      throw new TypeError('Body has already been used');
    }
    self._bodyUsed = true;

    if (self._bodyStream) {
      return self._readStreamFully().then(function(chunks) {
        var totalLen = 0;
        for (var i = 0; i < chunks.length; i++) {
          totalLen += chunks[i].length;
        }
        var combined = new Uint8Array(totalLen);
        var offset = 0;
        for (var i = 0; i < chunks.length; i++) {
          combined.set(chunks[i], offset);
          offset += chunks[i].length;
        }
        return combined.buffer;
      });
    }

    return Promise.resolve(stringToUint8Array(consumeBody(self._body)));
  };

  Response.prototype.blob = function() {
    return this.arrayBuffer().then(function(buf) {
      return new Blob([buf]);
    });
  };

  // Static methods

  Response.error = function() {
    /* status 0 是内部错误响应的合法值，绕开构造器 200-599 校验 */
    var response = new Response(null, { statusText: '' });
    response._status = 0;
    response._type = 'error';
    return response;
  };

  Response.redirect = function(url, status) {
    if (status === undefined) status = 302;
    if (status < 300 || status > 399) {
      throw new RangeError('Invalid redirect status: ' + status);
    }
    var response = new Response(null, {
      status: status,
      headers: { location: url }
    });
    response._type = 'opaqueredirect';
    return response;
  };

  Response.json = function(data, init) {
    init = init || {};
    var body = JSON.stringify(data);
    var headers = new Headers(init.headers);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return new Response(body, {
      status: init.status !== undefined ? init.status : 200,
      statusText: init.statusText || '',
      headers: headers
    });
  };

  // ================================================================
  // fetch function
  // ================================================================

  function fetch(input, init) {
    return new Promise(function(resolve, reject) {
      var request;

      try {
        request = new Request(input, init);
      } catch (e) {
        reject(e);
        return;
      }

      // Check if already aborted
      if (request.signal && request.signal.aborted) {
        var reason = request.signal.reason;
        if (reason === undefined) {
          reason = new DOMException('The operation was aborted.', 'AbortError');
        }
        reject(reason);
        return;
      }

      // One HTTP transfer; redirects re-enter via doRequest. redirectCount
      // guards against infinite redirect loops (WHATWG cap is 20).
      doRequest(request, resolve, reject, 0);
    });
  }

  // One HTTP transfer (plus redirect following). Each hop owns its own abort
  // listener, readable stream, and cleanup; on 3xx, follow/error/manual branch
  // before the body stream is exposed.
  function doRequest(request, resolve, reject, redirectCount) {
    // Serialize headers to JSON
    var headersObj = Object.create(null);
    request.headers.forEach(function(value, name) {
      headersObj[name] = value;
    });
    var headersJson = JSON.stringify(headersObj);

    // Serialize request body to bytes (Uint8Array) or null. Stream bodies
    // return a Promise; the PAL call below is deferred until it resolves.
    var requestBodyBytes = serializeBody(request.body);

    var aborted = false;
    var onAbort;
    var streamController = null;
    var abandoned = false;   /* this hop's stream was abandoned due to a redirect */
    var streamCancelled = false; /* consumer cancelled the response body stream */
    /* 本跳底层传输的 abort 句柄：pal.httpRequestStream 返回的 op id。
     * 信号 abort / body cancel 时调 pal.httpRequestAbort(opId) 真正中止
     * libuv 连接（关闭 socket、触发 on_end），而非只丢弃回调。0 = 无 op。 */
    var opId = 0;

    var resolved = false;    /* fetch promise 已 settle(防 onEnd 重复 reject) */
    /* 首跳请求体的已序列化字节。307/308 重定向需重发 body，但流式 body 已被
     * serializeBody 读走，不能复用原 Request._body，只能用这份字节。 */
    var sentBodyBytes = null;
    var sentBodyReady = false;
    if (request.signal) {
      onAbort = function() {
        aborted = true;
        var reason = request.signal.reason;
        if (reason === undefined) {
          reason = new DOMException('The operation was aborted.', 'AbortError');
        }
        if (streamController) {
          try { streamController.error(reason); } catch (e) {}
        }
        /* 连接级中止：让 C 层关闭底层 socket（on_end 触发，aborted 已置位
         * 故 fetch promise 不会重复 reject）。opId 为 0（请求体还在序列化、
         * op 未创建）时由 whenBodyReady 的 aborted 检查跳过创建。 */
        if (opId && typeof pal.httpRequestAbort === 'function') {
          try { pal.httpRequestAbort(opId); } catch (e) {}
        }
        reject(reason);
      };
      request.signal.addEventListener('abort', onAbort);
    }

    function cleanupAbort() {
      if (request.signal && onAbort) {
        request.signal.removeEventListener('abort', onAbort);
      }
    }

    // Run cb once the request body is ready. Serialization is synchronous
    // except for stream bodies (async read); a failed read rejects the fetch.
    function whenBodyReady(cb) {
      function deliver(bytes) {
        sentBodyBytes = bytes;
        sentBodyReady = true;
        cb(bytes);
      }
      if (requestBodyBytes && typeof requestBodyBytes.then === 'function') {
        requestBodyBytes.then(deliver, function(err) {
          if (aborted) return;
          cleanupAbort();
          reject(new TypeError('fetch failed: ' + (err || 'unknown error')));
        });
      } else {
        deliver(requestBodyBytes);
      }
    }

    /* SW-1：Service Worker fetch 拦截。存在 activated 控制器时把请求交给
     * service-worker.js 的 __qz_sw_intercept__（request + 已序列化 body）。
     * 返回 true = SW 接管本请求；超时 / SW 回退时由其调用 onFallback(bytes)
     * 续走网络路径（bytes 复用，避免二次消费流式 body）。SW 明确回退后
     * swBypassed 置位，同一请求不再重复派发（防 SW-网络-SW 死循环）。
     * abort：SW 接管后由信号监听器把 AbortError 交给 reject（正常网络路径
     * 同样如此），settle 后 settleHook 移除监听器。 */
    var swBypassed = false;
    function swDispatch(bytes, onFallback) {
      if (swBypassed) return false;
      if (globalThis.__qz_sw_mode__) return false; /* SW 线程内不递归拦截 */
      var svc = globalThis.navigator && globalThis.navigator.serviceWorker;
      if (!svc || typeof svc.__qz_sw_intercept__ !== 'function') return false;
      var settleHook = null;
      var oldOnAbort = onAbort;
      if (request.signal && onAbort) {
        onAbort = function() {
          oldOnAbort();
          if (!aborted) return;
          var reason = request.signal.reason;
          if (reason === undefined) {
            reason = new DOMException('The operation was aborted.', 'AbortError');
          }
          reject(reason);
        };
        settleHook = cleanupAbort;
      }
      var taken = svc.__qz_sw_intercept__(request, bytes, resolve, reject,
        function(fbBytes) { swBypassed = true; onFallback(fbBytes); },
        settleHook) === true;
      if (!taken && settleHook) { onAbort = oldOnAbort; }
      return taken;
    }

    // Fallback to non-streaming httpRequest if streaming not available.
    // pal.httpRequest returns a Promise<string> (resolves with the body on
    // success, rejects with an error string on failure); it does NOT provide
    // the HTTP status or headers, so the Response is built with status 200
    // and empty headers (the non-streaming PAL contract's limitation).
    if (typeof pal.httpRequestStream !== 'function') {
      // The non-streaming PAL API accepts only a string body, so decode the
      // serialized bytes (lossless round-trip for text bodies).
      whenBodyReady(function startNonStream(bytes) {
        if (aborted) { return; }
        if (swDispatch(bytes, startNonStream)) { return; }
        cleanupAbort();
        var bodyStr = bytes ? new TextDecoder().decode(bytes) : null;
        var p = pal.httpRequest(request.url, request.method, headersJson, bodyStr);
        Promise.resolve(p).then(function(data) {
          if (aborted) return;
          var resBytes = stringToUint8Array(data || '');
          var res = new Response(resBytes, {
            status: 200,
            headers: new Headers()
          });
          res._url = request.url;
          resolve(res);
        }, function(err) {
          if (aborted) return;
          reject(new TypeError('fetch failed: ' + (err || 'unknown error')));
        });
      });
      return;
    }

    // Create a ReadableStream that will receive chunks from PAL callbacks.
    // cancel() fires when the consumer cancels the body (reader.cancel /
    // pipeTo abort): abort the underlying transfer so no more onData arrives
    // and the socket is torn down, not just the JS-side stream.
    var readableStream = makeReadableStream({
      start: function(controller) {
        streamController = controller;
      },
      cancel: function(reason) {
        streamCancelled = true;
        if (opId && typeof pal.httpRequestAbort === 'function') {
          try { pal.httpRequestAbort(opId); } catch (e) {}
        }
      }
    });

    // PAL streaming callbacks
    function onHeaders(status, headersJsonStr) {
      if (aborted) return;

      var parsedHeaders = {};
      if (headersJsonStr) {
        try {
          parsedHeaders = JSON.parse(headersJsonStr);
        } catch (e) {
          // If headers parse fails, use empty headers
        }
      }

      // === redirect handling (3xx) ===
      if (status >= 300 && status <= 399) {
        if (request.redirect === 'error') {
          cleanupAbort();
          reject(new TypeError('fetch failed: redirect mode is "error"'));
          return;
        }
        if (request.redirect === 'manual') {
          cleanupAbort();
          var manualRes = new Response(null, { statusText: '' });
          manualRes._status = 0;
          manualRes._type = 'opaqueredirect';
          resolve(manualRes);
          return;
        }
        /* redirect === 'follow' (default) */
        if (redirectCount >= 20) {
          cleanupAbort();
          reject(new TypeError('fetch failed: too many redirects'));
          return;
        }
        var location = parsedHeaders['location'] || parsedHeaders['Location'] || null;
        if (location) {
          var nextUrl;
          try {
            nextUrl = new URL(location, request.url).href;
          } catch (e) {
            cleanupAbort();
            reject(new TypeError('fetch failed: invalid redirect location'));
            return;
          }
          var nextInit = {
            method: request.method,
            headers: request.headers,
            signal: request.signal,
            redirect: request.redirect,
            keepalive: request.keepalive,
            cache: request.cache,
            mode: request.mode,
            credentials: request.credentials
          };
          /* 301/302 (POST→GET) 和 303 丢弃 body；307/308 保留 method+body。
           * 307/308 重发已序列化字节（流式 body 首跳已读走）。 */
          if (status === 303 ||
              (status === 301 && request.method === 'POST') ||
              (status === 302 && request.method === 'POST')) {
            nextInit.method = 'GET';
          } else {
            nextInit.body = sentBodyReady ? sentBodyBytes : request.body;
          }
          var nextReq = new Request(nextUrl, nextInit);
          cleanupAbort();
          abandoned = true;
          doRequest(nextReq, resolve, reject, redirectCount + 1);
          return;
        }
        /* No Location header: fall through and return the response as-is */
      }

      var headers = new Headers(parsedHeaders);
      var resp = new Response(readableStream, {
        status: status,
        statusText: STATUS_TEXTS[status] || '',
        headers: headers,
        url: request.url
      });

      resolved = true;       /* 之后 onEnd 的 EOF 只 close 流,不再 reject */
      resolve(resp);
    }

    function onData(chunk) {
      if (aborted || abandoned || streamCancelled || !streamController) return;
      // chunk is an ArrayBuffer from the bridge; convert to Uint8Array
      var arr;
      if (chunk instanceof ArrayBuffer) {
        arr = new Uint8Array(chunk);
      } else if (chunk instanceof Uint8Array) {
        arr = chunk;
      } else {
        // String fallback
        arr = stringToUint8Array(String(chunk));
      }
      /* 全局 ReadableStream 的 controller.enqueue 在流被 cancel/close/error
       * 后会抛 TypeError；body 被消费端放弃后不应让桥接回调崩掉。 */
      try { streamController.enqueue(arr); } catch (e) {}
    }

    function onEnd(errorStatus, errorMsg) {
      // Clean up abort listener
      cleanupAbort();

      if (aborted || abandoned || streamCancelled) return;

      /* 网络错误(连接/握手/TLS 失败/代理拒绝)且 fetch promise 尚未 settle:
       * 必须 reject，否则 fetch 永远 pending。errorStatus 语义：
       *   0      — 正常完成；
       *   < 0    — qzjs 错误码（网络/TLS/无效参数…）；
       *   > 0    — 代理拒绝时透传的 HTTP 状态（407/403，来自 CONNECT 失败）。 */
      if (errorStatus !== 0 && !resolved) {
        if (errorStatus > 0) {
          reject(new TypeError('fetch failed: proxy error HTTP ' + errorStatus));
        } else if (errorStatus === -6) {
          /* QZ_ERR_INVALID_ARG：多为无效/不支持的代理 URL（含 https:// 代理） */
          reject(new TypeError('fetch failed: invalid proxy URL'));
        } else {
          /* errorMsg 是 C 层传来的具体原因（"TLS certificate verification
           * failed" / "DNS resolution failed" / mbedtls_strerror 文本…）。
           * 只报 errorStatus 会把完全不同的失败压成同一个 -5，无法诊断。 */
          reject(new TypeError('fetch failed: network error ' + errorStatus +
            (errorMsg ? ' (' + errorMsg + ')' : '')));
        }
        return;
      }

      if (streamController) {
        if (errorStatus !== 0) {
          streamController.error(new TypeError('fetch failed with status: ' + errorStatus));
        } else {
          streamController.close();
        }
      }
    }

    // Call PAL streaming HTTP once the request body is ready. SW 回退时用
    // 同一份已序列化 body bytes 重进网络路径（流式 body 已消费，不可重读）。
    whenBodyReady(function startNetwork(bytes) {
      if (aborted) return;
      if (swDispatch(bytes, startNetwork)) return;
      /* 返回值 = 底层传输的 op id（C 层 uv_io_http_request_stream）。0 = 同步
       * 失败（op 未创建）。信号 abort / body cancel 用它精确定位并关闭连接。 */
      opId = pal.httpRequestStream(request.url, request.method, headersJson, bytes, onHeaders, onData, onEnd) || 0;
    });
  }


  // ================================================================
  // Register on globalThis
  // ================================================================

  globalThis.Headers = Headers;
  globalThis.Request = Request;
  globalThis.Response = Response;
  globalThis.fetch = fetch;
}
