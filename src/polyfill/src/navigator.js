/**
 * qzjs polyfill: navigator.userAgent, reportError, self, globalThis event handlers
 *
 * TC55/ECMA-429 requires:
 *   - navigator.userAgent — identifies the runtime
 *   - reportError — reports errors to the global error handler
 *   - self — alias for globalThis
 *   - onerror / onunhandledrejection / onrejectionhandled — event handler properties
 *
 * Pure JS - no PAL primitives needed.
 */

export function setupNavigatorReportError() {

  /**
   * navigator object
   *
   * Provides platform identification per TC55 spec.
   */
  var navigator = {
    userAgent: 'qzjs/1.0 (WinterTC)',
    language: 'en-US',
    platform: 'wintercg',
    hardwareConcurrency: 1,
    onLine: true,
    maxTouchPoints: 0,
  };

  globalThis.navigator = navigator;

  /**
   * self — alias for globalThis per TC55 spec.
   */
  globalThis.self = globalThis;

  /**
   * reportError(error)
   *
   * Reports an error to the global unhandledrejection/error handlers.
   * Dispatches an ErrorEvent on globalThis if error handlers exist.
   */
  globalThis.reportError = function reportError(error) {
    if (error === undefined || error === null) return;

    // Dispatch as ErrorEvent on globalThis for uncaught error handling
    var event;
    if (typeof globalThis.ErrorEvent === 'function') {
      var message = error instanceof Error ? error.message : String(error);
      var filename = error instanceof Error ? (error.fileName || '') : '';
      var lineno = error instanceof Error ? (error.lineNumber || 0) : 0;
      var colno = error instanceof Error ? (error.columnNumber || 0) : 0;

      event = new globalThis.ErrorEvent('error', {
        message: message,
        filename: filename,
        lineno: lineno,
        colno: colno,
        error: error,
        cancelable: true,
      });
    } else {
      event = new Event('error');
      event.message = error instanceof Error ? error.message : String(error);
      event.error = error;
    }

    globalThis.dispatchEvent(event);
  };

  // ================================================================
  // GlobalThis event handler properties
  // TC55 requires onerror, onunhandledrejection, onrejectionhandled
  // ================================================================

  Object.defineProperty(globalThis, 'onerror', {
    get: function() {
      var listener = this._onerrorHandler;
      return listener || null;
    },
    set: function(handler) {
      if (this._onerrorHandler) {
        this.removeEventListener('error', this._onerrorHandler);
      }
      this._onerrorHandler = handler;
      if (handler) {
        this.addEventListener('error', handler);
      }
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(globalThis, 'onunhandledrejection', {
    get: function() {
      var listener = this._onunhandledrejectionHandler;
      return listener || null;
    },
    set: function(handler) {
      if (this._onunhandledrejectionHandler) {
        this.removeEventListener('unhandledrejection', this._onunhandledrejectionHandler);
      }
      this._onunhandledrejectionHandler = handler;
      if (handler) {
        this.addEventListener('unhandledrejection', handler);
      }
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(globalThis, 'onrejectionhandled', {
    get: function() {
      var listener = this._onrejectionhandledHandler;
      return listener || null;
    },
    set: function(handler) {
      if (this._onrejectionhandledHandler) {
        this.removeEventListener('rejectionhandled', this._onrejectionhandledHandler);
      }
      this._onrejectionhandledHandler = handler;
      if (handler) {
        this.addEventListener('rejectionhandled', handler);
      }
    },
    configurable: true,
    enumerable: true,
  });
}