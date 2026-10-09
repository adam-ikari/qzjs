/**
 * qzjs polyfill: AbortController and AbortSignal
 *
 * Standard AbortController implementation for cancelable operations.
 * Pure JS - no PAL primitives needed.
 *
 * Depends on EventTarget (must be loaded after event-target.js).
 */

export function setupAbort() {
  // Ensure EventTarget is available
  if (typeof globalThis.EventTarget !== 'function') {
    throw new Error('AbortController requires EventTarget to be loaded first');
  }

  /**
   * AbortSignal class
   *
   * A signal object that can be watched for abort events.
   * Extends EventTarget for addEventListener support.
   */
  class AbortSignal extends EventTarget {
    constructor() {
      super();
      this._aborted = false;
      this._reason = undefined;
    }

    /**
     * True if the signal has been aborted.
     */
    get aborted() {
      return this._aborted;
    }

    /**
     * The reason for abort (if any).
     */
    get reason() {
      return this._reason;
    }

    /**
     * Throws an AbortError if the signal has been aborted.
     */
    throwIfAborted() {
      if (this._aborted) {
        /* 抛原始 reason；仅当 reason 未设置时才兜底 AbortError */
        var reason = this._reason;
        if (reason === undefined) {
          reason = new DOMException('The operation was aborted', 'AbortError');
        }
        throw reason;
      }
    }

    /**
     * Internal method to abort the signal.
     */
    /**
     * Override addEventListener to support the AbortSignal spec: if the signal
     * has already been aborted, the new listener is called in a microtask.
     */
    addEventListener(type, callback, options) {
      super.addEventListener(type, callback, options);
      if (type === 'abort' && this._aborted) {
        var self = this;
        Promise.resolve().then(function() {
          if (typeof callback === 'function') {
            callback.call(self, new Event('abort'));
          } else if (callback && typeof callback.handleEvent === 'function') {
            callback.handleEvent.call(self, new Event('abort'));
          }
          /* Remove once listeners immediately after first call (since
           * dispatchEvent is not involved, mark once manually). */
        });
      }
    }

    _abort(reason) {
      if (this._aborted) return;

      this._aborted = true;
      this._reason = reason;

      // Dispatch abort event
      const event = new Event('abort');
      this.dispatchEvent(event);
    }

    /**
     * Static method to create an already-aborted signal.
     */
    static abort(reason) {
      const signal = new AbortSignal();
      if (reason === undefined) {
        reason = new DOMException('The operation was aborted', 'AbortError');
      }
      signal._aborted = true;
      signal._reason = reason;
      return signal;
    }

    /**
     * Static method to create a signal that aborts after a timeout.
     * (Requires setTimeout to be available)
     */
    static timeout(ms) {
      const signal = new AbortSignal();
      const timer = setTimeout(function() {
        signal._abort(new DOMException('The operation timed out', 'TimeoutError'));
      }, ms);

      // Clean up timer if signal is aborted manually
      signal.addEventListener('abort', function() {
        clearTimeout(timer);
      });

      return signal;
    }

    /**
     * Static method to create a signal that aborts when any of the given signals abort.
     */
    static any(signals) {
      if (!Array.isArray(signals)) {
        throw new TypeError('signals must be an array');
      }

      const result = new AbortSignal();
      const listeners = [];

      for (const signal of signals) {
        if (!(signal instanceof AbortSignal)) {
          throw new TypeError('All signals must be AbortSignal instances');
        }

        if (signal.aborted) {
          /* 已 aborted - 立即 abort result，并清理前面已注册的 listener */
          result._abort(signal.reason);
          for (const l of listeners) l.signal.removeEventListener('abort', l.fn);
          return result;
        }

        const fn = function() { result._abort(signal.reason); };
        signal.addEventListener('abort', fn);
        listeners.push({ signal: signal, fn: fn });
      }

      /* result abort 后移除所有 listener：防泄漏 */
      result.addEventListener('abort', function() {
        for (const l of listeners) l.signal.removeEventListener('abort', l.fn);
      }, { once: true });

      return result;
    }

    /* spec: AbortSignal.prototype[Symbol.toStringTag] = 'AbortSignal'。
     * wsp/webidl 依此做 brand-check（缺则 signal 被当非 AbortSignal 忽略，
     * pipeTo({signal}) 不注册 abort listener）。 */
    get [Symbol.toStringTag]() { return 'AbortSignal'; }
  }

  /**
   * AbortController class
   *
   * Controller that can be used to abort async operations.
   */
  class AbortController {
    constructor() {
      this._signal = new AbortSignal();
    }

    /**
     * The associated AbortSignal.
     */
    get signal() {
      return this._signal;
    }

    /**
     * Abort the associated signal.
     *
     * @param reason - Optional reason for abort
     */
    abort(reason) {
      /* 无参 abort：signal.reason 默认 AbortError DOMException */
      if (reason === undefined) {
        reason = new DOMException('The operation was aborted', 'AbortError');
      }
      this._signal._abort(reason);
    }
  }

  // DOMException polyfill (if not already defined)
  if (typeof globalThis.DOMException === 'undefined') {
    class DOMException extends Error {
      constructor(message, name) {
        super(message);
        this.name = name || 'Error';
        this.code = DOMException._codes[this.name] || 0;
      }
    }

    // Error code constants
    DOMException._codes = {
      'IndexSizeError': 1,
      'DOMStringSizeError': 2,
      'HierarchyRequestError': 3,
      'WrongDocumentError': 4,
      'InvalidCharacterError': 5,
      'NoDataAllowedError': 6,
      'NoModificationAllowedError': 7,
      'NotFoundError': 8,
      'NotSupportedError': 9,
      'InUseAttributeError': 10,
      'InvalidStateError': 11,
      'SyntaxError': 12,
      'InvalidModificationError': 13,
      'NamespaceError': 14,
      'InvalidAccessError': 15,
      'ValidationError': 16,
      'TypeMismatchError': 17,
      'SecurityError': 18,
      'NetworkError': 19,
      'AbortError': 20,
      'URLMismatchError': 21,
      'QuotaExceededError': 22,
      'TimeoutError': 23,
      'InvalidNodeTypeError': 24,
      'DataCloneError': 25
    };

    globalThis.DOMException = DOMException;
  }

  // Register on globalThis
  globalThis.AbortController = AbortController;
  globalThis.AbortSignal = AbortSignal;
}
