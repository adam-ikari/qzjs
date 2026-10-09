/**
 * qzjs polyfill: CacheStorage / Cache
 *
 * Simplified WHATWG Cache API: in-memory Map-based implementation.
 * caches.open → Cache, put/match/delete/keys by URL string.
 *
 * Pure JS — no PAL primitives needed.
 * Requires: Request, Response (fetch.js) — Response.clone() tees streaming
 * bodies (SW-2), so cache.put can store a buffered copy without consuming
 * the caller's response.
 *
 * SW-2: Cache.put buffers the response body (Uint8Array) into a non-streaming
 * Response so repeated cache.match() hits each return an independent clone;
 * adds cache.add/addAll and CacheStorage.match (search all caches).
 */

export function setupCacheStorage() {
  function urlKey(request) {
    if (typeof request === 'string') return request;
    if (request instanceof Request) return request.url;
    return String(request);
  }

  /* Buffer a response into a non-streaming clone: body fully read, stored as
   * bytes. Repeated match() clones are then cheap and side-effect free. */
  function bufferResponse(response) {
    var stored = response.clone();
    return stored.arrayBuffer().then(function (buf) {
      var headers = {};
      stored.headers.forEach(function (v, n) { headers[n] = v; });
      return new Response(
        buf.byteLength ? new Uint8Array(buf) : null,
        {
          status: stored.status,
          statusText: stored.statusText,
          headers: headers,
          url: stored.url || '',
        }
      );
    });
  }

  class Cache {
    constructor(name) {
      this._name = name;
      this._map = new Map();
    }

    put(request, response) {
      var self = this;
      if (!(response instanceof Response)) {
        return Promise.reject(new TypeError('Cache.put: response must be a Response'));
      }
      var key = urlKey(request);
      /* WHATWG: put stores a clone — the caller keeps its own body.
       * Buffer via clone; the caller's response stays consumable. */
      var buffered;
      try {
        buffered = bufferResponse(response);
      } catch (err) {
        return Promise.reject(err);
      }
      return buffered.then(function (stored) {
        self._map.set(key, stored);
      });
    }

    match(request) {
      var key = urlKey(request);
      var r = this._map.get(key);
      return Promise.resolve(r ? r.clone() : undefined);
    }

    matchAll(request) {
      var key = request ? urlKey(request) : null;
      var results = [];
      this._map.forEach(function (v, k) {
        if (!key || k === key) results.push(v.clone());
      });
      return Promise.resolve(results);
    }

    delete(request) {
      var key = urlKey(request);
      return Promise.resolve(this._map.delete(key));
    }

    keys(request) {
      var key = request ? urlKey(request) : null;
      var results = [];
      this._map.forEach(function (v, k) {
        if (!key || k === key) results.push(k);
      });
      return Promise.resolve(results);
    }

    /* add/addAll: fetch each URL, fail fast on non-ok, store the response */
    add(request) {
      return this.addAll([request]);
    }

    addAll(requests) {
      var self = this;
      if (!Array.isArray(requests)) {
        return Promise.reject(new TypeError('Cache.addAll: requests must be an array'));
      }
      return Promise.all(requests.map(function (req) {
        var url = urlKey(req);
        return fetch(url).then(function (response) {
          if (!response.ok) {
            throw new TypeError('Cache.addAll: fetch failed for ' + url);
          }
          return self.put(url, response).then(function () {
            return response; /* caller sees the response; put stored its clone */
          });
        });
      })).then(function () { /* resolve undefined like WHATWG */ });
    }
  }

  class CacheStorage {
    constructor() {
      this._caches = new Map();
    }

    open(name) {
      if (!this._caches.has(name)) {
        this._caches.set(name, new Cache(name));
      }
      return Promise.resolve(this._caches.get(name));
    }

    has(name) {
      return Promise.resolve(this._caches.has(name));
    }

    delete(name) {
      return Promise.resolve(this._caches.delete(name));
    }

    keys() {
      return Promise.resolve(Array.from(this._caches.keys()));
    }

    /* Search every cache (insertion order), first hit wins */
    match(request) {
      var key = urlKey(request);
      var hit = null;
      this._caches.forEach(function (cache) {
        if (hit) return;
        var r = cache._map.get(key);
        if (r) hit = r;
      });
      return Promise.resolve(hit ? hit.clone() : undefined);
    }
  }

  globalThis.Cache = Cache;
  globalThis.CacheStorage = CacheStorage;
  globalThis.caches = new CacheStorage();
}
