---
title: Debugging
description: Debug qzjs with the DAP debugger — breakpoints, step-through, variable inspection, and VS Code integration.
---

# Debugging qzjs programs with VS Code

qzjs ships a **DAP (Debug Adapter Protocol)** step-debugger built into the
library itself — no separate debugger binary. When enabled, any program that
embeds qzjs can be step-debugged in VS Code (breakpoints, step over/into/out,
call stack, locals, evaluate).

## How it works

The debugger is a **library capability**, not a separate process. It lives in
`src/debugger.c` (debug core) and `src/debugger_dap.c` (DAP protocol layer),
compiled into `libqzjs.a` when `QZ_BUILD_DEBUGGER=ON`. A small patch to the
QuickJS-ng engine (`deps/quickjs-ng-debugger.patch`) adds the breakpoint/step
introspection primitives the core uses.

Activation is **automatic via config or env** — your host code does not
change. `qz_create` checks for debugging and, if enabled, attaches the DAP
layer (which speaks DAP on stdin/stdout) and pauses at entry. VS Code then
attaches.

### Two-layer disable (zero overhead when off)

- `QZ_BUILD_DEBUGGER=OFF` (default): the engine patch is **not** applied,
  `src/debugger.c`/`src/debugger_dap.c` are **not** compiled, and `qz_create`
  has no debug code path. Debugging does not exist; `libqzjs.a` is unchanged.
- `QZ_BUILD_DEBUGGER=ON`: the patch is applied and the sources compile in,
  but the engine's per-opcode `DEBUGGER_CHECK` is a no-op (one never-taken
  branch) **unless a debugger is attached at runtime**. Non-debugged runs pay
  essentially nothing.

## Build

```bash
cmake -B build -DQZ_BUILD_DEBUGGER=ON -DQZ_BUILD_TESTS=ON
cmake --build build -j$(nproc)
```

This applies `deps/quickjs-ng-debugger.patch` to the QuickJS-ng submodule
working tree at configure time (the submodule stays clean in git — the patch
is the source of truth). `cmake -DQZ_BUILD_DEBUGGER=OFF` restores pristine.

## Enable debugging in your program

**Option A — no code change (env var):** run your program with `QZ_DEBUG=1`:

```bash
QZ_DEBUG=1 ./myapp app.js
```

**Option B — config bit:** set bit 1 of `qz_config_t.debug` (bit 0 is the
existing verbose-log flag):

```c
#include <qzjs/qzjs.h>

const char *src = "debugger;\n";   /* pauses at entry, then at breakpoints */

qz_config_t cfg = {};
cfg.debug = 0x2;            /* bit 1 = debug-enable (or just run with QZ_DEBUG=1) */
cfg.initial_script = src;
qz_t *rt = qz_create(&cfg);
```

Note: code eval'd via `cfg.initial_script` is recorded by the engine under
the source name `<initial>` (see Limitations), so file breakpoints only fire
if your host evals the source with its real filename itself — entry pause and
`debugger;` work either way.

That's it — `qz_create` auto-attaches DAP, sends `initialized`, and blocks
on the DAP configuration phase (initialize / setBreakpoints /
configurationDone) before returning. `stop_on_entry` pauses at the first
statement of your program.

## Debugging from VS Code

The debugger speaks **standard DAP over stdio**: the runtime (`qz_create` with
debug enabled) is the DAP server on stdin/stdout, and the client is anything
that speaks DAP. Two pieces:

- **`vscode/qzjs-debug`** — the VS Code extension registering the `qzjs`
  debug type. It is an *inline* adapter: it spawns your binary with
  `QZ_DEBUG=1` and relays DAP frames between VS Code and the child's stdio.
- **The DAP server inside qzjs** — the library itself, also driven directly
  end-to-end by `test/test_dap_gtest.cpp`.

Run the extension from a development host: `npm run compile` in
`vscode/qzjs-debug`, open that folder in VS Code and press F5 (Run Extension),
or start VS Code with
`code --extensionDevelopmentPath=<repo>/vscode/qzjs-debug`.

Two other ways to drive the same DAP server without the extension:

**Option 1 — a generic debug adapter.** Point a stdio DAP adapter (e.g. the
Mock Debug adapter, or your own) at a launch config whose `program` runs your
binary under `QZ_DEBUG=1`. The adapter relays DAP between VS Code and the
child's stdio. Any adapter that is "DAP server over stdio, client-side" works;
the qzjs side needs no extension because it never registers a VS Code type.

**Option 2 — drive the DAP protocol directly.** With `QZ_DEBUG=1`, run your
program and speak DAP to its stdin/stdout yourself — a REPL, a script, or a
one-off client. `test/test_dap_gtest.cpp` is a working reference client: it
forks a child under `QZ_DEBUG=1`, then sends initialize → setBreakpoints →
configurationDone and expects a `stopped` event before stepping and
inspecting variables.

The DAP layer implements: initialize, attach, setBreakpoints,
configurationDone, threads, stackTrace, scopes, variables, continue, next,
stepIn, stepOut, evaluate, disconnect.

<details>
<summary>Reference <code>launch.json</code> (uses the bundled extension <code>vscode/qzjs-debug</code>)</summary>

```json
{
  "version": "0.2.0",
  "configurations": [{
    "type": "qzjs",
    "request": "launch",
    "name": "qzjs: debug",
    "program": "${workspaceFolder}/app.js",
    "runtimeExecutable": "${workspaceFolder}/build/qzjs"
  }]
}
```

`program` is the JS entry file, `runtimeExecutable` the binary embedding qzjs.
The adapter launches the child with `QZ_DEBUG=1` itself (no `env` entry
needed), appends `program` as the last argument, and resolves a relative
`program` against the workspace folder — VS Code sends breakpoints as the
document's absolute path, and the two must be byte-identical for the engine's
exact-match breakpoint lookup. If you pass `runtimeArgs`, they go *before* the
program path; don't list the program there a second time.

</details>

With the extension running you attach to your program paused at entry, then
continue to hit breakpoints, inspect Locals, step, and evaluate watch
expressions.


## What works (MVP)

- Breakpoints by (source file, line) — set from VS Code before launch.
- Breakpoints fire on all statement kinds: `return`, `break`/`continue`,
  `case`/`default:`, `try`/`catch`/`finally`/`else` headers, `do {`, empty
  statements and every line of a multi-declarator `var`. The compiler records
  a pc→line entry at every statement entry (and at switch-clause / `else` /
  `catch` / `finally` positions), not just plain assignments and calls.
- `setBreakpoints` is scoped per source file: each request replaces only the
  named file's breakpoints, so breakpoints in other files survive (DAP sends
  one request per file whenever that file's breakpoints change).
- Conditional breakpoints: a breakpoint's `condition` is evaluated (as JS,
  with frame locals exposed under `locals`, same convention as `evaluate`);
  non-zero stops, zero skips, a throwing condition stops so you see the error.
- Hit-count (conditional) breakpoints: a breakpoint's `hitCondition` is parsed
  once at set time (VS Code's "Hit count" menu forms: `N`/`==N` stop exactly on
  the Nth visit, `%N` every Nth, plus `>N` `>=N` `<N` `<=N` `!=N`). Hit counts
  are visit-based: one count per arrival at the line — the several opcodes of
  a statement and a call into a callee all belong to the same visit, and
  returning out of the callee does not re-count. A hitCondition the runtime
  cannot parse reports `verified: false` with a message (gray glyph in VS
  Code) instead of silently becoming a breakpoint that never fires. The count
  restarts when the breakpoint is re-registered (any setBreakpoints replacing
  it).
- Logpoints: a breakpoint whose `logMessage` is written to the Debug Console
  instead of stopping — `{expression}` holes are evaluated in the top frame
  (same `locals.` convention as `evaluate`), the line is printed, and
  execution continues automatically. A hit fires on every visit (a loop line
  logs each iteration), and rendering failure degrades to a normal stop —
  fail-open, a stop is never silently lost.
- Exception breakpoints (filter **All exceptions** = `all`): every `throw`
  stops with `reason: exception`, the error message as `text`, and the
  throw-site frame — caught or uncaught, exactly one stop per throw. Only
  this filter is offered (see Limitations).
- `verified` reflects the file system: a breakpoint on a missing file or
  past a file's last line reports `verified: false` (gray in VS Code); when
  a response can't be checked against the request 1:1, the engine's answer
  is kept.
- `debugger;` statement in your source — stops with reason `breakpoint` even
  when zero breakpoints are set, and regardless of what filename the engine
  recorded for the code.
- Pause at entry (`stop_on_entry`).
- Step over / into / out, continue.
- Call stack with file/line/function per frame.
- Locals scope (arguments + local variables) with values.
- Variables expand: an object or array in Locals — and in an `evaluate`
  result (hover/watch drills in the same way) — opens into its own
  enumerable properties / array indices, one level per click, with a bounded
  preview string per value. References live only for their stop: the next
  stop invalidates them (asking for a dead one just comes back empty).
- `evaluate` (REPL/watch). Globals and pure expressions eval directly; a
  frame's locals are exposed on a `locals` object during evaluate, so
  `locals.x` reads a local variable. (Bare `x` won't bind — true eval-in-frame
  would need engine support QuickJS doesn't expose.) Object results carry an
  expandable reference, so `locals.o` in the Debug Console can be opened.

## Limitations (MVP)

- **`evaluate` bare-local binding**: watch expressions referencing locals
  must use the `locals.` prefix (`locals.x`, not `x`). True eval-in-frame
  (binding locals directly) needs engine support QuickJS doesn't expose.
- **Filename matching is exact and entry-script-centric**: breakpoints match
  the frame's recorded source name with a byte-exact string compare. The CLI
  script path records the real path (the adapter guarantees an identical
  absolute string), but:
  - code from `-e` or the REPL records `<input>`;
  - an embedding host that evals `cfg.initial_script` records `<initial>`
    (`qz_eval_internal` hardcodes it), so breakpoints on the real file never
    fire there — entry pause and `debugger;` still work.
- **`verified: true` means "registered and in range", not "will hit"**: the
  adapter checks the line against the file on disk (missing file or a line
  past EOF reports `verified: false`), but filename matching stays byte-exact
  (see filename matching above), so a breakpoint only fires if that file is
  evaluated under the exact same path.
- **Closing braces aren't breakable**: a line with no statement bytecode —
  a lone `}` closing a block — has no pc→line entry, so a breakpoint set
  there reports `verified` but never fires.
- **`finally` continuation can re-fire the catch-body line**: resuming out
  of a `finally` block returns (`gosub`) into bookkeeping bytecode that
  physically sits in the preceding statement's line region, so a breakpoint
  on that already-executed line may fire once more on the way out. Mapping
  that code to a future line instead would break step semantics, so the
  line-entry behavior is kept.
- **No CDP / Chrome DevTools**: DAP only. Chrome DevTools Protocol (CDP over
  WebSocket) is deferred.
- **Exception breakpoints: `all` only** — there is no *Uncaught* filter
  (that would need catch-detection on the unwind path) and no separate
  promise handling: an async rejection is a throw and stops like one.
  Unknown filters a client sends anyway are answered `verified: false`.
- **Hit counts are per registration, not global** — a setBreakpoints request
  that re-registers a file's breakpoints resets their counts. `%N` counts
  *visits*, which for a loop line means iterations — except a `finally`
  re-fire (above), which is a new visit and counts.
- **Logpoint holes evaluate in the top frame only** — `{expr}` sees the same
  `locals.` view `evaluate` has, nothing deeper; a hole that throws falls
  back to a normal stop at the logpoint (the stop is never lost).
- **Variable expansion shows own enumerable properties only** — no
  prototype-chain members, no `Map`/`Set` internal entries (they open
  empty), functions are leaves (not openable), symbol keys are skipped, and
  each level lists at most 100 children (the remainder appears as one
  `<...>` row). A local still in its temporal dead zone shows as
  `[uninitialized]` (leaf) — breakpoints stop at statement entry, before that
  statement's initializer ran.
- **No source maps**, no edit-and-continue, no multi-isolate.

## Async while paused

The world is **frozen while paused** by design: the paused DAP loop only
services debug-protocol requests (50 ms stdin poll); it does not run the PAL
event loop, so `fetch` responses and `setTimeout` callbacks queued during a
pause fire only after you continue. This matches standard debugger
freeze-on-break semantics and avoids PAL-driven re-entry into a stopped
runtime (`debugger.c` has a re-entrancy guard as a second line of defense).

## Test

```bash
cmake -B build -DQZ_BUILD_DEBUGGER=ON -DQZ_BUILD_TESTS=ON && cmake --build build -j$(nproc)
ctest --test-dir build -L dap --output-on-failure   # or: make -C <dir> then ctest -L dap
```

`test/test_dap_gtest.cpp` is an in-process embedding host that forks a child
running a tiny JS program under `QZ_DEBUG=1`, then acts as the VS Code
client over a pipe: initialize → setBreakpoints → configurationDone → expects
`stopped` at the breakpoint → stackTrace/scopes/variables/evaluate → step →
continue → terminate. It validates the whole stack: engine patch + debug core
+ DAP layer + the auto-attach path in `qz_create`. It also covers per-file
breakpoint scope, a mid-run pause, the stdio single-instance constraint, the
exception-breakpoint filters (armed: one stop per throw; disarmed: none), and
variable expansion (nested objects/arrays, evaluate references, stale
references invalidated by the next stop).

The extension has its own end-to-end tests that drive the inline adapter
against a debugger-enabled binary (default `build/dbg/qzjs`, override with
`QZJS_RUNTIME`):

```bash
cmake --preset dbg && cmake --build build/dbg -j$(nproc)  # 统一 build/ 下，取代旧 build_dbg
cd vscode/qzjs-debug && npm run compile && npm test
```

CI runs both gates: the `debugger` job executes `ctest -L dap` and these
e2e tests (`QZJS_RUNTIME` points it at that job's `build/qzjs`).

- `test/smoke.mjs` — a breakpoint on the *real* source path fires:
  entry stop → continue → `stopped` with `reason: breakpoint`, top frame's
  path/line equal the file VS Code broke on, then `terminated`.
- `test/debugger-stmt.mjs` — `debugger;` stops with **zero** breakpoints
  registered (`reason: breakpoint`) and its frame reports the statement's own
  file and line.
- `test/line-coverage.mjs` — 17 breakpoints across every statement kind
  (if/return, do-while, switch `case`/`default:`, try/catch/finally,
  break/continue) asserting the exact stop sequence — a statement line that
  silently loses its pc→line entry fails the test.
- `test/breakpoint-scope.mjs` — two real sources (entry script + a helper
  file named via `__native__.nativeEvalScript`) plus a third file's set/clear
  requests: both files' breakpoints must fire, and the other file's requests
  must not wipe them.
- `test/verified.mjs` — `verified:false` semantics: a line past EOF, a
  missing file, and cases where the response length doesn't match the
  request (the engine's answer is kept instead).
- `test/logpoints.mjs` — a logpoint on a loop line logs all three
  iterations without stopping while a real breakpoint on the next line
  still stops twice; program output (`done`) reaches the Debug Console.
- `test/exception-bp.mjs` — filter `all` armed: a *caught* throw stops with
  `reason: exception`, `text` carrying the error message, top frame at the
  throw site, and exactly two stops for the whole session (one throw = one
  stop — no double-fire); disarmed (`filters: []`): the same throw runs
  through untouched.
- `test/variables-expand.mjs` — a nested object/array local drills from the
  Locals scope three levels deep (`o` → `nested` → `b` → elements), an
  `evaluate` result expands the same way, the next stop invalidates the
  previous stop's references (children come back empty), and program stdout
  (`r 5`) still reaches the Debug Console.
- `test/hit-condition.mjs` — a loop line reached 6 times with `hitCondition
  "%2"` stops exactly on reaches 2, 4 and 6 (the resume dispatches after each
  continue must not inflate the count); a second breakpoint with an
  unparseable hitCondition answers `verified: false` with a message and is
  NOT re-enabled by the line-on-disk check; program stdout (`s 15`) asserts
  the loop ran to completion.

## Troubleshooting

**Breakpoints never hit / no `stopped` event / tests time out at 30 s**

The engine's per-opcode breakpoint check is gated by a compile-time macro.
If the macro the CMake passes to the engine differs from the one in
`deps/quickjs-ng-debugger.patch`, `DEBUGGER_CHECK` compiles to a no-op and
debugging silently does nothing — no error, breakpoints just never fire.

1. Verify the macro matches in both places:

   ```bash
   grep -n DEBUG_SUPPORT deps/quickjs-ng-debugger.patch | head -4
   grep -n "QZ_DEBUG_SUPPORT_DEFINE" CMakeLists.txt
   ```

   Both must use the same name (currently `QZ_DEBUG_SUPPORT`). A project
   rename that misses the patch produces exactly this silent failure.

2. Verify the engine code is actually compiled in (not compiled out):

   ```bash
   grep -c "js_debugger_check" deps/quickjs-ng/quickjs.c
   ```

3. Confirm the DAP layer itself is linked (it lives in `libqzjs` only with
   `QZ_BUILD_DEBUGGER=ON`):

   ```bash
   nm build/libqzjs.a 2>/dev/null | grep -c qz_dap_attach   # or build/dbg/libqzjs.a for the debugger build
   ```

4. Run the end-to-end client — if it passes, the whole stack works and the
   problem is in your client's protocol exchange:

   ```bash
   ctest --test-dir build -L dap --output-on-failure
   ```

**`QZ_DEBUG=1` set but program doesn't pause at entry**

- Embedded host with the THREAD backend: the auto-attach happens on the
  qzjs thread during `qz_create` and blocks on the DAP configuration
  exchange — your client must send `initialize` + `setBreakpoints` +
  `configurationDone` or `qz_create` never returns.
- Worker runtimes never auto-attach (one stdio channel per process; a
  worker would race the parent for stdin). Breakpoints only apply to the
  attached runtime.
- `config.debug = 1` is **not** the debug bit — use `0x2` (bit 1).
