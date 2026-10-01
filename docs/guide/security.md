---
title: Security
description: qzjs threat model — what the runtime defends against, what script is trusted to do, and how to report a vulnerability.
---

# Security

qzjs is an **embeddable runtime for trusted script**, not a sandbox for
untrusted code. This page states the boundaries explicitly so you can reason
about your deployment and report findings correctly.

## Reporting a Vulnerability

**Do not** open a public GitHub issue for security vulnerabilities.

Report privately via [GitHub Security Advisories](https://github.com/adam-ikari/qzjs/security/advisories/new).
Include:

- the affected version (commit hash or release tag),
- a description of the issue and its impact,
- steps to reproduce, or a proof of concept,
- any known mitigations.

You should receive an acknowledgement within **7 days** and a status update
within **30 days**. Once a fix is available we coordinate disclosure with you
and credit you in the advisory unless you prefer to remain anonymous.

## Supported Versions

Security fixes are applied to the **latest release** and the current `master`
branch. Older releases are not back-ported.

## Threat Model

### In scope

Defects that let *data* cross a boundary the runtime itself draws, or that let
unexpected input corrupt memory or crash the process:

- the bytecode reader (`JS_ReadObject`) handling malformed or hostile bytecode,
- the IPC envelope decoder and the HTTP/WS/HTTP2/protobuf parsers handling
  malformed input from a peer process or the network,
- memory-safety defects reachable from script through the public API,
- crypto correctness (`crypto.subtle`, TLS configuration, randomness).

If you find a way for *untrusted input* — network bytes, bytecode, IPC frames
from an untrusted peer — to reach memory corruption, escape a parser boundary,
or bypass an explicit validation, that is in scope.

### Out of scope by default (unless the host opts into strict mode — see below)

Capabilities script already legitimately has. These are not escapes:

- **Filesystem** — script can read and write any path the host process can.
  Path validation only rejects `..` components; there is **no root jail and no
  permission model**. See [fs](/js-api/fs).
- **Process spawning** — script can spawn processes (`pal.processSpawn` →
  `execv`).
- **Environment (CLI only)** — the standalone `qzjs` CLI injects the full environment as `globalThis.env` via its bootstrap. Embedded hosts (`qz_create`) have no env interface in the default configuration — the script sees no environment unless the host sets `strict_mode` + `env_allowlist`.
- **Host co-residence** — script runs in-process with the host (THREAD backend)
  or in a sibling process (ISOLATED backend); **neither is a security boundary**
  against malicious script.
- **Network exposure** — `serve()` binds `127.0.0.1` by default and has **no
  authentication middleware**. Passing `hostname: '0.0.0.0'` exposes it to the
  network — put your own authentication in front if you do that.


## Strict mode — running untrusted script

For workloads that load **untrusted or third-party** script (user plugins,
remote-supplied code), qzjs provides a host-side **strict mode** switch that
confines three capabilities the default configuration leaves open. It is an
**engine-layer mechanism**, not a full sandbox — use it alongside OS-level
confinement (seccomp, containers, chroot) for high-risk code.

| Capability | Default (trusted script) | Strict mode |
|---|---|---|
| Filesystem | any path the host can access (`..` rejected) | confined to `sandbox_root` via `realpath` prefix check; symlinks that escape the root are rejected; relative paths rejected |
| Process spawn | `pal.processSpawn` → `execv` of any binary JS names | JS-supplied `binary_path` ignored; runtime resolves its own `qzjs-rt` (`/proc/self/exe` sibling, `QZ_RT_SERVER`, or compile-time `QZ_RT_PATH`); nested workers keep working |
| Environment | full `globalThis.env` (CLI) / none (embedded default) | only `env_allowlist` keys exposed; empty allowlist → `env = {}` |

Enable at `qz_create` time (one-shot, cannot be relaxed at runtime — JS cannot
turn it off on itself):

```c
qz_config_t cfg; qz_config_init(&cfg);
cfg.strict_mode   = 1;
cfg.sandbox_root  = "/srv/sandbox";
cfg.env_allowlist = (const char *const[]){"PATH","HOME",NULL};
qz_t *rt = qz_create(&cfg);
```

CLI: `qzjs --strict-sandbox=/srv/sandbox script.js` (allowlist defaults to
`PATH,HOME,LANG`; override with `QZ_STRICT_ENV=KEY1,KEY2`).

**Not covered by strict mode** (still need OS-level confinement):
outbound network access (tcp/http), the DAP debugger surface, the CTL control
plane endpoint (use its own `LOCAL` + `SO_PEERCRED` tier for that).
## Deployment Guidance

Because the runtime trusts its script, the security of a qzjs deployment is the
security of your **host application's boundary**:

1. **Treat script as first-party code.** If any part of it comes from an
   untrusted source, do not run it in a qzjs runtime without your own
   confinement (a separate OS user, a container, a VM, or a seccomp policy).
2. **Do not expose `serve()` directly to the internet.** It is a bare server.
   Bind to loopback and front it with a reverse proxy that terminates TLS and
   enforces authentication.
3. **Constrain what the process can reach.** The filesystem, environment, and
   spawn capability are as broad as the host process's own privileges. Drop
   those privileges at the OS level if the workload does not need them.
4. **Prefer `ISOLATED` when isolation matters operationally.** A crashing or
   wedged worker does not take down the main runtime, and the process boundary
   is cleaner for resource limits. It is still not a security boundary against
   malicious script.
5. **Verify TLS peers.** The runtime performs SNI and certificate hostname
   verification on outbound TLS; a verification failure is fatal to that
   connection rather than silently ignored.
6. **Audit proxy configuration.** `fetch` honors `HTTP_PROXY` / `HTTPS_PROXY` /
   `NO_PROXY` from the environment. An unsupported proxy scheme fails closed
   rather than bypassing the proxy silently — but any process able to set those
   variables can redirect outbound traffic.

## Upstream Dependencies

qzjs vendors its dependencies as pinned git submodules under `deps/`, plus
local patches (`deps/*.patch`).

Upstream quickjs-ng explicitly lists **bytecode-reader hardening as out of
scope** for their project, so malformed-bytecode findings against the vendored
reader belong here rather than upstream.

Report issues in a bundled dependency to us first so we can assess the impact
on this runtime; we will also pass them upstream where appropriate.

## See Also

- [Troubleshooting](/guide/troubleshooting) — symptom → cause → fix
- [FAQ](/guide/faq) — design questions that look like bugs
- [fs](/js-api/fs) — the no-sandbox filesystem model
- [serve()](/js-api/serve) — the unauthenticated HTTP server
