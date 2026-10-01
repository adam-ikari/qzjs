# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report them privately via [GitHub Security Advisories](https://github.com/adam-ikari/qzjs/security/advisories/new)
on this repository. Include:

- the affected version (a commit hash or release tag),
- a description of the issue and its impact,
- steps to reproduce, or a proof of concept,
- any known mitigations.

You should receive an acknowledgement within 7 days and a status update
within 30 days. Once a fix is available we will coordinate disclosure with
you and credit you in the advisory unless you prefer to remain anonymous.

## Supported versions

Security fixes are applied to the latest release and to the current `master`
branch. Older releases are not back-ported.

## Threat model

qzjs is an **embeddable runtime for trusted script**, not a sandbox for
untrusted code. Knowing what is and is not defended is part of reporting
correctly, so the boundaries are stated explicitly:

**In scope** — defects that let *data* cross a boundary the runtime itself
draws, or that let an unexpected input corrupt memory or crash the process:

- the bytecode reader (`JS_ReadObject`) handling malformed or hostile
  bytecode,
- the IPC envelope decoder and the HTTP/WS/HTTP2/protobuf parsers handling
  malformed input from a peer process or the network,
- memory-safety defects reachable from script through the public API,
- crypto correctness (`crypto.subtle`, TLS configuration, randomness).

**Out of scope by default — capabilities script legitimately has unless the
host opts into strict mode** (see "Strict mode" below):

- script can read and write any path the host process can. Path validation
  only rejects `..` components; there is no root jail and no permission
  model in the default (trusted-script) configuration.
- script can spawn processes (`pal.processSpawn` → `execv`) and read the
  full environment (`globalThis.env`).
- script runs in-process with the host (THREAD backend) or in a sibling
  process (ISOLATED backend); neither is a security boundary against
  malicious script.
- `serve()` binds `127.0.0.1` by default and has no authentication
  middleware. Passing `hostname: '0.0.0.0'` exposes it to the network —
  put your own authentication in front if you do that.

## Strict mode — running untrusted script

For workloads that load **untrusted or third-party** script (user plugins,
remote-supplied code), qzjs provides a **strict mode** — a single host-side
switch that confines three capabilities the default configuration leaves open:

- **fs is root-confined** to `sandbox_root`: paths resolve via `realpath`
  and must fall inside the root (symlinks that escape are rejected);
  relative paths are rejected (the downstream I/O layer resolves them
  against the process CWD, so root-relative semantics in the validator
  would silently mismatch).
- **process spawn is pinned to qzjs-rt**: the `binary_path` argument JS
  passes to `pal.processSpawn` is ignored and the runtime resolves its own
  binary (`/proc/self/exe` sibling `qzjs-rt`, the `QZ_RT_SERVER` env var,
  or the compile-time `QZ_RT_PATH`). Nested workers keep working.
- **env is allowlisted**: only keys the host lists are exposed to
  `globalThis.env`; an empty allowlist yields `env = {}`.

Enable it at `qz_create` time (one-shot, cannot be relaxed at runtime — JS
cannot turn it off on itself):

```c
qz_config_t cfg; qz_config_init(&cfg);
cfg.strict_mode  = 1;
cfg.sandbox_root = "/srv/sandbox";
cfg.env_allowlist = (const char *const[]){"PATH","HOME",NULL};
qz_t *rt = qz_create(&cfg);
```

Or on the CLI: `qzjs --strict-sandbox=/srv/sandbox script.js` (the env
allowlist defaults to `PATH,HOME,LANG`; override with `QZ_STRICT_ENV`).

Strict mode is an **engine-layer mechanism**, not a full sandbox: it blocks
the three host-takeover vectors above. It does **not** confine outbound
network access (tcp/http) in the current revision, and it does not replace a
proper OS-level sandbox (seccomp, containers, chroot) for high-risk code.
Combine it with those for defense in depth.

If you find a way for *untrusted input* (network bytes, bytecode, IPC frames
from an untrusted peer) to reach memory corruption, escape a parser boundary,
or bypass an explicit validation, that is in scope.

## Upstream dependencies

qzjs vendors its dependencies as pinned git submodules under `deps/`, plus
local patches (`deps/*.patch`). Note that upstream quickjs-ng explicitly
lists bytecode-reader hardening as out of scope for their project, so
malformed-bytecode findings against the vendored reader belong here rather
than upstream.

Report issues in a bundled dependency to us first so we can assess the
impact on this runtime; we will also pass them upstream where appropriate.
