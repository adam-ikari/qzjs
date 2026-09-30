---
title: Bytecode Compilation
description: Hosts can compile JS to bytecode (qz_compile / the qzc tool) and run it at startup — with the caveat that bytecode is NOT portable across qzjs versions.
---

# Bytecode Compilation

qzjs precompiles its own JavaScript (the WinterTC polyfill and the worker boot
script) to **bytecode** at build time using the `qjsc` compiler.
Loading bytecode skips parsing entirely, which speeds startup and shrinks the
shipped payload.

Hosts can use the same machinery for their own programs.

## Compile Bytecode

From C:

```c
#include <qzjs/qzjs.h>

const char *source = "1 + 1";   /* 你的 JS 源码 */
size_t source_len = 5;          /* 不含结尾 NUL */

char *err = NULL;
uint8_t *bc = NULL;
size_t bc_len = 0;
if (qz_compile(source, source_len, "app.js", &bc, &bc_len, &err) != 0) {
    /* err: malloc'd message, free with free() */
}
/* ... ship / persist bc ... */
free(bc);
```

From the CLI (`qzc` tool):

```bash
qzc app.js -o app.bc
```

## Run Bytecode

Two ways, both evaluated after `initial_script` (so a bootstrap script and a
precompiled main program compose):

- **C API** — set `qz_config_t.initial_bytecode` / `initial_bytecode_len`
  before `qz_create`.
- **CLI** — `qzjs --bytecode app.bc [args...]` (script args still work; they
  come through the CLI bootstrap).

Failure semantics match `initial_script`: a bad or incompatible blob makes
`qz_create` return `NULL` (CLI: nonzero exit with the engine's error on
stderr).

## Bytecode Compatibility Is NOT Guaranteed

Bytecode is bound to the exact qzjs build — the embedded engine version, its
serialization format (including a version byte and checksum), and compile
options. **A blob produced by one qzjs build is not guaranteed to load on
another.** The runtime rejects incompatible blobs explicitly (e.g.
`SyntaxError: invalid version (27 expected=28)`, or `checksum error` on a
tampered blob); it never falls back to
source.

Recommended workflow: distribute **source**, and compile at deploy time on the
target qzjs build (`qzc`). Ship precompiled bytecode only in
controlled deployments where the host and the runtime binary come from the
same build. `qjsc -b` output from the same embedded engine build also loads,
but pin it to the same version as qzjs.

## Internal Use

The build pipeline compiles the polyfill sources to bytecode and embeds them
in the binary (same `qjsc` flow, at build time). At runtime the embedded
bytecode is evaluated on the internal thread instead of parsing source.
