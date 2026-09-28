---
title: Standalone CLI
description: Use qzjs as a standalone WinterTC runtime — run JavaScript scripts, one-liners, or an interactive REPL without embedding or Node.js.
---

# Standalone CLI

qzjs ships a standalone runtime executable (built by default with `QZ_BUILD_CLI=ON`)
that runs the full WinterTC Web API surface directly — no Node.js APIs
(`process`, `require`, `Buffer`) by design.

## Build

The CLI is part of the default build:

```bash
make build   # → build/qzjs build/qzc build/qzjs-rt
```

## Usage

```bash
qzjs script.js [args...]   # run a script file
qzjs -e 'code' [args...]   # evaluate an expression / statement
qzc app.js -o app.bc              # compile JS to bytecode (qzc tool)
qzjs --bytecode app.bc [args...]  # run precompiled bytecode
qzjs                       # interactive REPL (Ctrl-D to exit)
qzjs --help                # usage
qzjs --version             # version string
```

### Script mode

```bash
./build/qzjs hello.js
# hello from qzjs
```

Script args are exposed as `globalThis.arguments` (WinterCG
[proposal-cli-api](https://github.com/wintercg/proposal-cli-api) direction — the
executable name and script path are excluded):

```bash
./build/qzjs -e 'console.log(JSON.stringify(globalThis.arguments))' a b c
# ["a","b","c"]
```

### -e eval mode

```bash
./build/qzjs -e 'const r = await fetch("https://example.com"); console.log(r.status)'
```

### REPL

Run `qzjs` with no arguments for an interactive session:

```text
$ qzjs
qzjs 0.2.0 (WinterTC runtime) — type JS, Ctrl-D to exit
1 + 2
3
```

### Bytecode mode

Compile once, run many — bytecode skips parsing at startup. Compilation is
its own tool, `qzc`:

```bash
qzc app.js -o app.bc
qzjs --bytecode app.bc arg1 arg2
# hello from bytecode, 1+2 = 3 | args: ["arg1","arg2"]
```

`qzjs --compile` still works as an alias, but `qzc` is the canonical form.

Script args still work (they flow through the CLI bootstrap). Bytecode is
bound to the exact qzjs build — an incompatible file fails with
`SyntaxError: invalid version` on stderr and a nonzero exit. See
[Bytecode Compilation](/guide/bytecode).

## Runtime Behaviour

- **Async exit** — after the top-level script finishes, the runtime keeps
  running until all pending async work (timers, fetch, streams) completes, then
  exits. A 50ms `setTimeout` always fires before the process terminates.
- **Console routing** — `console.log`/`info`/`debug` → stdout;
  `console.warn`/`error` → stderr (aligned with web-runtime console semantics).
- **`globalThis.env`** — the process environment as a plain object.
- **Exit codes** — `0` success; `1` script threw (message on stderr) or the file
  was unreadable; `2` unknown flag / bad `-e` usage.

## Control plane (`qzjs-ctl`)

With `--control-plane=local`, the running runtime exposes a local AF_UNIX
endpoint (0600, peer-uid checked via `SO_PEERCRED`) that accepts one JSON
control command per line and writes back one receipt per command:

```bash
# start a runtime that exposes an endpoint
qzjs --control-plane=local --control-pipe=/tmp/my-qzjs.ctl app.js

# in another shell: send commands, print receipts
qzjs-ctl --pipe /tmp/my-qzjs.ctl eval '1 + 1'
qzjs-ctl --pipe /tmp/my-qzjs.ctl inspect '({a: 1})'
qzjs-ctl --pipe /tmp/my-qzjs.ctl metrics
qzjs-ctl --pipe /tmp/my-qzjs.ctl interrupt

# address another node of the process tree (worker slot id), or send raw JSON
qzjs-ctl --pipe /tmp/my-qzjs.ctl --target 1001 metrics
qzjs-ctl --pipe /tmp/my-qzjs.ctl --json '{"op":"metrics","correl":"c1"}'
```

Commands are `eval` / `inspect` / `metrics` / `interrupt`. `--target N` routes
the command through the process tree (CTL-1): `1` is the main runtime (default),
`>1` is that node's child slot (i.e. a worker process — a `new Worker(...)`
under the isolated build gets slot id 1001, 1002, …). Receipts are paired by
`correl`; the exit code is `0` when the receipt says `ok:true`, `1` otherwise.
The default path when `--control-pipe` is omitted is
`/tmp/qzjs-<pid>-<n>.ctl`. `off` (the default) exposes nothing; `in-proc`
allows in-process commands only.

## No Node.js API

The CLI intentionally exposes **no** Node-style globals — there is no `process`,
no `require`, no `Buffer`, no CommonJS. Scripts use the same WinterTC Web APIs
that embedded qzjs offers (fetch, console, crypto.subtle, ReadableStream,
timers, URL, TextEncoder, …).

## Next Steps

- [Event Loop](/guide/event-loop) — how the library-owned loop (ISOLATED: the
  `qzjs-rt` process plus the library's host-side pump thread; THREAD: the
  internal qzjs thread) drives execution — the host pumps nothing
- [Embedding](/guide/embedding) — the C API for host applications (mailbox consumption)
