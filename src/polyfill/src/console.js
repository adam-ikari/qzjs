/**
 * qzjs polyfill: console
 *
 * Implements console.log/warn/error/info/debug/trace/dir/time/timeEnd/assert
 * using pal.log(level, message) primitive.
 *
 * Level mapping: 0=debug, 1=info/log, 2=warn, 3=error
 */

export function setupConsole(pal) {
  const timers = new Map();

  // Level mapping for pal.log
  const LEVELS = {
    debug: 0,
    log: 1,
    info: 1,
    warn: 2,
    error: 3
  };

  // Helper to format arguments
  function formatArgs(args) {
    return args.map(arg => {
      if (arg === null) return 'null';
      if (arg === undefined) return 'undefined';
      if (typeof arg === 'string') return arg;
      if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
      try {
        return JSON.stringify(arg);
      } catch (e) {
        return String(arg);
      }
    }).join(' ');
  }

  const console = {
    log: function(...args) {
      pal.log(LEVELS.log, formatArgs(args));
    },

    info: function(...args) {
      pal.log(LEVELS.info, formatArgs(args));
    },

    warn: function(...args) {
      pal.log(LEVELS.warn, formatArgs(args));
    },

    error: function(...args) {
      pal.log(LEVELS.error, formatArgs(args));
    },

    debug: function(...args) {
      pal.log(LEVELS.debug, formatArgs(args));
    },

    trace: function(...args) {
      // In QuickJS we don't have real stack traces, so just prefix with "Trace:"
      pal.log(LEVELS.debug, 'Trace: ' + formatArgs(args));
    },

    dir: function(obj, options) {
      // dir is similar to log but with more detail - for now just use JSON
      try {
        pal.log(LEVELS.log, JSON.stringify(obj, null, options?.depth ?? 2));
      } catch (e) {
        pal.log(LEVELS.log, String(obj));
      }
    },

    time: function(label) {
      label = label || 'default';
      timers.set(label, pal.timeNow());
    },

    timeEnd: function(label) {
      label = label || 'default';
      const start = timers.get(label);
      if (start === undefined) {
        pal.log(LEVELS.warn, `Timer '${label}' does not exist`);
        return;
      }
      timers.delete(label);
      const elapsed = pal.timeNow() - start;
      pal.log(LEVELS.info, `${label}: ${elapsed.toFixed(3)}ms`);
    },

    assert: function(condition, ...args) {
      if (!condition) {
        pal.log(LEVELS.error, 'Assertion failed: ' + formatArgs(args));
      }
    },

    clear: function() {
      // No-op in this environment - no terminal control
    },

    count: function(label) {
      // Simple counter implementation
      label = label || 'default';
      const counts = this._counts || (this._counts = new Map());
      const count = (counts.get(label) || 0) + 1;
      counts.set(label, count);
      pal.log(LEVELS.info, `${label}: ${count}`);
    },

    countReset: function(label) {
      label = label || 'default';
      const counts = this._counts;
      if (counts) {
        counts.delete(label);
      }
    },

    group: function(label) {
      // No-op - no indentation support
      pal.log(LEVELS.info, (label || 'Group'));
    },

    groupEnd: function() {
      // No-op
    },

    table: function(data) {
      // Simplified table output
      try {
        pal.log(LEVELS.info, JSON.stringify(data, null, 2));
      } catch (e) {
        pal.log(LEVELS.info, String(data));
      }
    }
  };

  globalThis.console = console;
}
