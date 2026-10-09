/**
 * qzjs polyfill: EventSource
 *
 * WHATWG EventSource API for server-sent events.
 * Uses pal.httpRequestStream for HTTP streaming.
 *
 * Implements the current WHATWG processing model (HTML §9.2):
 *   - EventTarget-based: addEventListener/removeEventListener/dispatchEvent,
 *     onopen/onmessage/onerror as event handler attributes.
 *   - text/event-stream parsing: data:/event:/id:/retry: fields, comment
 *     lines, LF/CRLF/CR line endings, leading-BOM stripping, multi-line data
 *     joined with LF, empty-data dispatch, cross-chunk field buffering, and
 *     UTF-8 decoding via a streaming TextDecoder.
 *   - Reconnection: a network error or a normal end-of-body reestablishes the
 *     connection (fire `error`, retry after the reconnection time, sending
 *     Last-Event-ID when set); a non-200 response fails the connection
 *     (fire `error`, readyState CLOSED, no reconnect); close() stops it all.
 */

export function setupEventSource(pal) {
  if (typeof pal.httpRequestStream !== 'function') return;

  /* Best-effort origin serialization of an absolute http(s) URL. */
  function computeOrigin(url) {
    var m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(url);
    if (!m) return 'null';
    var scheme = m[1].toLowerCase();
    var hostPort = m[2];
    var defaultPort = (scheme === 'https') ? 443 : (scheme === 'http') ? 80 : null;
    var colon = hostPort.lastIndexOf(':');
    if (colon >= 0 && defaultPort !== null &&
        hostPort.slice(colon + 1) === String(defaultPort)) {
      return scheme + '://' + hostPort.slice(0, colon);
    }
    return scheme + '://' + hostPort;
  }

  class EventSource extends EventTarget {
    constructor(url, eventSourceInitDict) {
      super();
      url = String(url);
      if (!/^https?:\/\//i.test(url)) {
        throw new DOMException("EventSource: invalid URL '" + url + "'", 'SyntaxError');
      }
      this._url = url;
      this._withCredentials = !!(eventSourceInitDict && eventSourceInitDict.withCredentials);
      this._reconnectDelay = 3000;    /* reconnection time (ms) */
      this._lastEventId = '';         /* last event ID string — persists across reconnects */
      this._lastIdBuffer = '';        /* last event ID buffer (per stream) */
      this._dataLines = [];           /* data buffer */
      this._eventType = '';           /* event type buffer */
      this._readyState = 0;           /* CONNECTING */
      this._closed = false;
      this._buffer = '';              /* unterminated line carried across chunks */
      this._origin = computeOrigin(url);
      this._onopen = null;
      this._onmessage = null;
      this._onerror = null;
      this._connect();
    }

    get CONNECTING() { return 0; }
    get OPEN() { return 1; }
    get CLOSED() { return 2; }

    get url() { return this._url; }
    get readyState() { return this._readyState; }
    get withCredentials() { return this._withCredentials; }

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

    _connect() {
      if (this._closed) return;
      this._readyState = 0;      /* CONNECTING */
      this._buffer = '';
      this._dataLines = [];
      this._eventType = '';
      this._lastIdBuffer = '';
      this._decoder = new TextDecoder('utf-8');   /* strips leading BOM + streams */

      var headers = { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' };
      if (this._lastEventId !== '') headers['Last-Event-ID'] = this._lastEventId;

      var self = this;
      function onHeaders(status) {
        if (self._closed) return;
        if (status === 200) {
          self._readyState = 1;   /* OPEN */
          self.dispatchEvent(new Event('open'));
        } else {
          /* Non-200 → fail the connection (no reconnect). */
          self._failConnection();
        }
      }
      function onData(chunk) {
        if (self._closed || self._readyState !== 1) return;
        var uint8 = (chunk instanceof Uint8Array) ? chunk : new Uint8Array(chunk);
        self._buffer += self._decoder.decode(uint8, { stream: true });
        self._processBuffer();
      }
      function onEnd() {
        if (self._closed) return;
        /* Normal end of body or network error → reestablish the connection. */
        self._reestablish();
      }
      try {
        pal.httpRequestStream(this._url, 'GET', JSON.stringify(headers), '',
                              onHeaders, onData, onEnd);
      } catch (e) {
        /* Request failed to start → treat as a network error. */
        self._reestablish();
      }
    }

    _processBuffer() {
      /* Normalize CRLF and bare CR line endings to LF, then split. */
      var lines = this._buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      this._buffer = lines.pop() || '';   /* keep the last (unterminated) line */
      for (var i = 0; i < lines.length; i++) this._processLine(lines[i]);
    }

    _processLine(line) {
      if (line === '') { this._dispatchEventNow(); return; }   /* blank → dispatch */
      if (line[0] === ':') return;                             /* comment → ignore */
      var colon = line.indexOf(':');
      var field, value;
      if (colon >= 0) {
        field = line.slice(0, colon);
        value = line.slice(colon + 1);
        if (value[0] === ' ') value = value.slice(1);          /* strip one leading space */
      } else {
        field = line;      /* no colon → whole line is the field name */
        value = '';
      }
      switch (field) {
        case 'event': this._eventType = value; break;
        case 'data': this._dataLines.push(value); break;
        case 'id':
          if (value.indexOf('\u0000') < 0) this._lastIdBuffer = value;
          break;
        case 'retry':
          if (/^[0-9]+$/.test(value)) {                       /* ASCII digits only */
            var ms = parseInt(value, 10);
            if (!isNaN(ms)) this._reconnectDelay = ms;
          }
          break;
        default: break;   /* unknown field → ignore */
      }
    }

    _dispatchEventNow() {
      /* Spec: last event ID string ← last event ID buffer (before the empty check). */
      this._lastEventId = this._lastIdBuffer;
      if (this._dataLines.length === 0) { this._eventType = ''; return; }
      var data = this._dataLines.join('\n');
      var type = this._eventType || 'message';
      this._dataLines = [];
      this._eventType = '';
      if (this._readyState !== 2) {
        this.dispatchEvent(new MessageEvent(type, {
          data: data,
          lastEventId: this._lastEventId,
          origin: this._origin
        }));
      }
    }

    _failConnection() {
      /* readyState → CLOSED + error; never reconnects. */
      if (this._closed || this._readyState === 2) return;
      this._readyState = 2;
      this.dispatchEvent(new Event('error'));
    }

    _reestablish() {
      if (this._closed || this._readyState === 2) return;
      this._readyState = 0;   /* CONNECTING */
      this.dispatchEvent(new Event('error'));
      var self = this;
      setTimeout(function() {
        if (!self._closed && self._readyState === 0) self._connect();
      }, this._reconnectDelay);
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      this._readyState = 2;   /* CLOSED */
      this._buffer = '';
    }
  }

  globalThis.EventSource = EventSource;
}
