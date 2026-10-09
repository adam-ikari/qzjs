/**
 * qzjs polyfill: ErrorEvent, PromiseRejectionEvent
 *
 * TC55/ECMA-429 requires these event types for error reporting.
 *
 * Depends on: Event (must be loaded after event-target.js).
 */

export function setupErrorEvents() {
  if (typeof globalThis.Event !== 'function') {
    throw new Error('ErrorEvent requires Event to be loaded first');
  }

  /**
   * ErrorEvent
   *
   * Fired when an error occurs. Carries error details.
   */
  class ErrorEvent extends Event {
    constructor(type, options) {
      super(type, options);
      this._message = options?.message ?? '';
      this._filename = options?.filename ?? '';
      this._lineno = options?.lineno ?? 0;
      this._colno = options?.colno ?? 0;
      this._error = options?.error ?? null;
    }

    get message() { return this._message; }
    get filename() { return this._filename; }
    get lineno() { return this._lineno; }
    get colno() { return this._colno; }
    get error() { return this._error; }
  }

  /**
   * PromiseRejectionEvent
   *
   * Fired when a Promise is rejected without a handler.
   */
  class PromiseRejectionEvent extends Event {
    constructor(type, options) {
      super(type, { cancelable: type === 'unhandledrejection' });
      this._promise = options?.promise ?? null;
      this._reason = options?.reason ?? undefined;
    }

    get promise() { return this._promise; }
    get reason() { return this._reason; }
  }

  globalThis.ErrorEvent = ErrorEvent;
  globalThis.PromiseRejectionEvent = PromiseRejectionEvent;
}
