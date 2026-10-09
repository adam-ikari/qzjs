/**
 * qzjs polyfill: timers
 *
 * Implements setTimeout/setInterval/clearTimeout/clearInterval
 * using pal.timerStart(delay_ms, repeat) and pal.timerStop(handle).
 *
 * IMPORTANT: pal.timerStart returns {handle: number, promise: Promise}
 * - handle: used for clearTimeout/clearInterval
 * - promise: resolves when timer fires (for setTimeout scheduling)
 *
 * For setInterval, we re-schedule setTimeout each time since promises
 * only resolve once.
 */

export function setupTimers(pal) {
  // Map of handle -> {callback, args, stopped, isInterval, delay}
  const timerEntries = new Map();

  // Negative handles for intervals, never collide with positive timer handles
  let nextIntervalHandle = -1;

  /**
   * setTimeout(callback, delay, ...args)
   *
   * @param callback - function to call after delay
   * @param delay - milliseconds to wait (default 0)
   * @param args - additional arguments to pass to callback
   * @returns number - timer handle for clearTimeout
   */
  globalThis.setTimeout = function(callback, delay, ...args) {
    if (typeof callback !== 'function') {
      throw new TypeError('setTimeout callback must be a function');
    }

    // Coerce delay to number, default to 0, clamp to >= 0 and <= 2^31-1
    delay = Math.min(2147483647, Math.max(0, Number(delay) || 0));

    // Start the timer via PAL
    const result = pal.timerStart(delay, 0); // repeat=0 for one-shot
    const handle = result.handle;

    // Store callback info
    const entry = {
      callback: callback,
      args: args,
      stopped: false,
      isInterval: false,
      delay: delay,
      currentPalHandle: handle   // always set so clearTimeout can stop it (handle may be 0)
    };
    timerEntries.set(handle, entry);

    // When promise resolves, execute callback
    result.promise.then(function() {
      const e = timerEntries.get(handle);
      if (e && !e.stopped) {
        timerEntries.delete(handle);
        try {
          e.callback.apply(null, e.args);
        } catch (err) {
          // Timer callbacks must not break the runtime, but the error still
          // enters the error-event flow (reportError → ErrorEvent 'error' on
          // globalThis → self.onerror / addEventListener('error')). reportError
          // is installed later (navigator.js) — guard for early fires.
          if (typeof globalThis.reportError === 'function') {
            globalThis.reportError(err);
          }
          if (globalThis.console) {
            console.error('Uncaught error in setTimeout callback:', err);
          }
        }
      }
    });

    return handle;
  };

  /**
   * setInterval(callback, delay, ...args)
   *
   * For intervals, we use setTimeout and re-schedule after each callback.
   * This is because pal.timerStart with repeat=1 fires the promise only once.
   *
   * @param callback - function to call repeatedly
   * @param delay - milliseconds between calls
   * @param args - additional arguments to pass to callback
   * @returns number - timer handle for clearInterval
   */
  globalThis.setInterval = function(callback, delay, ...args) {
    if (typeof callback !== 'function') {
      throw new TypeError('setInterval callback must be a function');
    }

    delay = Math.min(2147483647, Math.max(0, Number(delay) || 0));

    // Use a unique negative handle that we manage
    // We'll start a setTimeout and re-schedule it each time
    const handle = nextIntervalHandle--;
    let currentPalHandle = null;

    const entry = {
      callback: callback,
      args: args,
      stopped: false,
      isInterval: true,
      delay: delay,
      currentPalHandle: null
    };
    timerEntries.set(handle, entry);

    // Internal function to schedule the next tick
    function scheduleNext() {
      if (entry.stopped) return;

      const result = pal.timerStart(delay, 0);
      entry.currentPalHandle = result.handle;

      result.promise.then(function() {
        if (entry.stopped) return;

        try {
          entry.callback.apply(null, entry.args);
        } catch (err) {
          if (typeof globalThis.reportError === 'function') {
            globalThis.reportError(err);
          }
          if (globalThis.console) {
            console.error('Uncaught error in setInterval callback:', err);
          }
        }

        // Re-schedule if not stopped
        if (!entry.stopped) {
          scheduleNext();
        }
      });
    }

    // Start the first iteration
    scheduleNext();

    return handle;
  };

  /**
   * clearTimeout(handle)
   *
   * Cancels a setTimeout by handle.
   */
  globalThis.clearTimeout = function(handle) {
    if (handle === undefined || handle === null) return;

    const entry = timerEntries.get(handle);
    if (entry) {
      entry.stopped = true;
      timerEntries.delete(handle);

      // Stop the underlying PAL timer if we have its handle
      if (entry.currentPalHandle !== null && entry.currentPalHandle !== undefined) {
        pal.timerStop(entry.currentPalHandle);
      } else if (!entry.isInterval && handle > 0) {
        // For setTimeout, the handle IS the PAL handle (positive numbers only)
        pal.timerStop(handle);
      }
      // Note: Negative handles are interval handles managed by us,
      // not PAL. We only stop via currentPalHandle for those.
    }
  };

  /**
   * clearInterval(handle)
   *
   * Same as clearTimeout - cancels an interval.
   */
  globalThis.clearInterval = function(handle) {
    globalThis.clearTimeout(handle);
  };
}
