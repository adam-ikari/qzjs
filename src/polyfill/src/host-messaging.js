/**
 * qzjs polyfill: host messaging boundary (postMessage / onmessage /
 * __qz_dispatch__)
 *
 * W3C worker-style messaging between the host and the qzjs context:
 *   - postMessage(data)      — JS → host. Bridge JSON-serializes data and
 *                              delivers it to the host's message_cb.
 *   - __qz_dispatch__(data, source) — host → JS. Bridge invokes this with
 *                              the parsed JSON (source 0 = host) or raw bytes
 *                              (source > 0 = worker). Dispatches a MessageEvent.
 *   - onmessage              — EventTarget-style handler property.
 *
 * Depends on: MessageEvent (message-channel.js), reportError (navigator.js).
 * Both are only referenced at dispatch time, i.e. after all setup modules have
 * run, so setup order is not a concern here.
 */

export function setupHostMessaging(pal) {
  var self = globalThis;

  // JS → host: data must be JSON-serializable (bridge uses JS_JSONStringify).
  globalThis.postMessage = function (data) {
    pal.postMessage(data);
  };

  // host → JS: bridge dispatches inbound messages here; source 0 = host.
  globalThis.__qz_dispatch__ = function (data, source) {
    self.dispatchEvent(new MessageEvent('message', { data: data }));
  };

  // onmessage property (EventTarget semantics)
  var __onmsg = null;
  Object.defineProperty(self, 'onmessage', {
    get: function () { return __onmsg; },
    set: function (fn) {
      if (__onmsg) self.removeEventListener('message', __onmsg);
      __onmsg = function (e) {
        try { fn.call(self, e); } catch (err) { reportError(err); }
      };
      if (fn) self.addEventListener('message', __onmsg);
    },
    configurable: true,
  });
}
