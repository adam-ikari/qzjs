---
title: timers
description: Timer APIs in qzjs — setTimeout, clearTimeout, setInterval, clearInterval, and microtask scheduling.
---

# Timers API

Standard `setTimeout` / `setInterval` with millisecond resolution. Backed by libuv timers (`uv_timer_*`) on the runtime's own loop (the `qzjs-rt` process under ISOLATED, the internal `qzjs` thread under THREAD; ~1ms precision).

## Globals

| Global | Description |
|--------|-------------|
| `setTimeout(callback, delay, ...args)` | Run `callback` after `delay` ms |
| `clearTimeout(id)` | Cancel a timeout |
| `setInterval(callback, delay, ...args)` | Run `callback` every `delay` ms |
| `clearInterval(id)` | Cancel an interval |

## setTimeout

```js
// Run after 1 second
let id = setTimeout(() => {
    console.log('1 second passed');
}, 1000);

// With arguments
setTimeout((name, age) => {
    console.log(name, age);
}, 500, 'Alice', 30);

// Cancel before it fires
clearTimeout(id);
```

### Minimum Delay

Delays are clamped to a minimum of **4ms** for nested timeouts (browser convention). Values less than 0 are treated as 0 (execute ASAP).

### Return Value

`setTimeout` and `setInterval` return numeric handles (not objects). These handles are per-context and reused after clearing.

## setInterval

```js
// Run every 500ms
let counter = 0;
let id = setInterval(() => {
    counter++;
    console.log('Tick:', counter);
    if (counter >= 10) clearInterval(id);
}, 500);
```

## clearTimeout / clearInterval

Both functions are interchangeable — `clearTimeout` can cancel an interval and vice versa.

```js
let id = setInterval(() => console.log('tick'), 1000);
clearTimeout(id);  // also works
```

Passing an invalid handle (already cleared, garbage value) is silently ignored.

## Timer Lifecycle

```
setTimeout(cb, 1000)
    │
    ▼
uv_timer_start(1s, one-shot) on qzjs's internal loop
    │
    ▼  (1000ms passes, loop wakes)
    │
timer callback fires on the runtime loop → cb() called
```

For `setInterval`, the uv timer repeats; each fire re-runs the callback until it is cleared.

## Context Lifecycle

- Timers are managed per context on the runtime's own loop
- Timers are automatically cancelled when the runtime shuts down (`qz_destroy`)
- No timers survive a restart — create them fresh in `initial_script`

## Max Timers

Each context supports up to `QZ_MAX_HANDLES` (256) total handles across all handle types (timers + filesystem + HTTP). Creating a timer when the table is full returns `0` (invalid handle), and the callback is never called.

## Notes

- Timer precision is libuv's (~1ms)
- There is no `queueMicrotask` wrapper needed — it's available as `globalThis.queueMicrotask`
- Nested `setTimeout` calls deeper than 5 levels are clamped to 4ms minimum delay
- `setTimeout(cb, 0)` executes on the next event loop tick, not immediately
