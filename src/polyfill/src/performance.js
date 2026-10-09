/**
 * qzjs polyfill: performance
 *
 * Implements performance.now() using pal.hrtime() (nanosecond precision)
 * or pal.timeNow() (millisecond precision) as fallback.
 * Also provides basic performance.mark/measure/getEntries.
 *
 * Exposes the Performance interface per ECMA-429 (HR-TIME): the constructor
 * is globalThis.Performance and the instance is globalThis.performance.
 */

export function setupPerformance(pal) {
  const marks = new Map();
  const measures = [];
  const observers = [];

  function notifyEntry(entry) {
    observers.forEach(function(obs) {
      if (obs._connected && obs._entryTypes.indexOf(entry.entryType) >= 0) {
        obs._buffer.push(entry);
        if (!obs._scheduled) {
          obs._scheduled = true;
          /* Synchronous dispatch for now — microtask scheduling (queueMicrotask
           * / Promise.resolve().then) is unreliable in mock_libuv. The spec
           * requires async delivery, but the API surface is correct; async can
           * be added when the test runtime supports it. */
          obs._scheduled = false;
          if (obs._connected && obs._buffer.length > 0) {
            var entries = obs.takeRecords();
            try { obs.callback(new PerformanceObserverEntryList(entries), obs); } catch(e) {}
          }
        }
      }
    });
  }

  /* Use hrtime (nanoseconds) if available for sub-ms precision,
   * otherwise fall back to timeNow (milliseconds). */
  const hasHrtime = typeof pal.hrtime === 'function';
  let _hrtimeOrigin = 0;
  if (hasHrtime) {
    _hrtimeOrigin = pal.hrtime();
  }

  function nowMs() {
    if (hasHrtime) {
      return (pal.hrtime() - _hrtimeOrigin) / 1e6;
    }
    return pal.timeNow();
  }

  class Performance {
    constructor() {}

    /**
     * Returns a high-resolution timestamp in milliseconds.
     */
    now() {
      return nowMs();
    }

    /**
     * Get the time origin (approximation - time when runtime started)
     * Since we don't track this precisely, we use 0 as baseline.
     */
    get timeOrigin() {
      return 0;
    }

    /**
     * Create a named performance mark.
     */
    mark(name, options) {
      if (typeof name !== 'string' || name === '') {
        throw new TypeError('Mark name must be a non-empty string');
      }
      marks.set(name, {
        name: name,
        entryType: 'mark',
        startTime: nowMs(),
        duration: 0
      });
      notifyEntry(marks.get(name));
    }

    /**
     * Create a named performance measure between two marks.
     */
    measure(name, startMark, endMark) {
      if (typeof name !== 'string' || name === '') {
        throw new TypeError('Measure name must be a non-empty string');
      }

      let startTime, endTime;

      // Handle different argument patterns
      if (typeof startMark === 'object' && startMark !== null) {
        // measure(name, options)
        const options = startMark;
        startTime = options.start !== undefined ?
          (marks.get(options.start)?.startTime ?? options.start) :
          0;
        endTime = options.end !== undefined ?
          (marks.get(options.end)?.startTime ?? options.end) :
          nowMs();
      } else {
        // measure(name, startMark?, endMark?)
        if (startMark) {
          const startEntry = marks.get(startMark);
          if (!startEntry) {
            throw new Error(`Mark '${startMark}' not found`);
          }
          startTime = startEntry.startTime;
        } else {
          startTime = 0;
        }

        if (endMark) {
          const endEntry = marks.get(endMark);
          if (!endEntry) {
            throw new Error(`Mark '${endMark}' not found`);
          }
          endTime = endEntry.startTime;
        } else {
          endTime = nowMs();
        }
      }

      measures.push({
        name: name,
        entryType: 'measure',
        startTime: startTime,
        duration: endTime - startTime
      });
      notifyEntry(measures[measures.length - 1]);
    }

    /**
     * Remove a mark by name.
     */
    clearMarks(name) {
      if (name) {
        marks.delete(name);
      } else {
        marks.clear();
      }
    }

    /**
     * Remove measures by name.
     */
    clearMeasures(name) {
      if (name) {
        for (let i = measures.length - 1; i >= 0; i--) {
          if (measures[i].name === name) {
            measures.splice(i, 1);
          }
        }
      } else {
        measures.length = 0;
      }
    }

    /**
     * Get all performance entries.
     */
    getEntries() {
      const result = [];
      marks.forEach(entry => result.push({...entry}));
      measures.forEach(entry => result.push({...entry}));
      return result.sort((a, b) => a.startTime - b.startTime);
    }

    /**
     * Get entries by name.
     */
    getEntriesByName(name, type) {
      return this.getEntries().filter(entry =>
        entry.name === name && (!type || entry.entryType === type)
      );
    }

    /**
     * Get entries by type.
     */
    getEntriesByType(type) {
      return this.getEntries().filter(entry => entry.entryType === type);
    }
  }

  globalThis.performance = new Performance();
  globalThis.Performance = Performance;

  // ================================================================
  // PerformanceObserver / PerformanceObserverEntryList
  // ================================================================

  class PerformanceObserverEntryList {
    constructor(entries) { this._entries = entries; }
    getEntries() { return this._entries; }
    getEntriesByType(type) { return this._entries.filter(function(e) { return e.entryType === type; }); }
    getEntriesByName(name, type) {
      return this._entries.filter(function(e) { return e.name === name && (!type || e.entryType === type); });
    }
  }

  class PerformanceObserver {
    constructor(callback) {
      this.callback = callback;
      this._buffer = [];
      this._entryTypes = [];
      this._connected = false;
      this._scheduled = false;
    }

    observe(options) {
      if (!options || !options.entryTypes) {
        throw new TypeError('PerformanceObserver.observe: entryTypes required');
      }
      this._connected = true;
      this._entryTypes = options.entryTypes;
      observers.push(this);
    }

    disconnect() {
      this._connected = false;
      this._buffer = [];
      var idx = observers.indexOf(this);
      if (idx >= 0) observers.splice(idx, 1);
    }

    takeRecords() {
      var r = this._buffer;
      this._buffer = [];
      return r;
    }
  }

  globalThis.PerformanceObserver = PerformanceObserver;
  globalThis.PerformanceObserverEntryList = PerformanceObserverEntryList;
}
