# Third-Party Notices

This file enumerates the vendored dependencies (git submodules under
`deps/`) bundled with qzjs, their pinned commit, upstream source, and
license. Full license text ships in each `deps/<name>/LICENSE` (or
`COPYING`). qzjs itself is MIT-licensed — see `LICENSE` at the repo root.

This is a source-distribution notice; binary distributions must retain the
same notices.

| Component | Upstream | Pinned commit | License |
|---|---|---|---|
| libuv | https://github.com/libuv/libuv | `84af0b18c5ae` | MIT |
| wasm3 | https://github.com/wasm3/wasm3 | `d77cd814aa0b` | MIT |
| Mbed TLS | https://github.com/Mbed-TLS/mbedtls | `0bebf8b8c7f0` | Apache-2.0 OR GPL-2.0-or-later |
| miniz | https://github.com/richgel999/miniz | `77d0dce86277` | MIT |
| QuickJS-ng | https://github.com/quickjs-ng/quickjs | `6d46d07d0404` | MIT |
| WAMR | https://github.com/bytecodealliance/wasm-micro-runtime | `25bd7eb63e82` | Apache-2.0 |
| GoogleTest | https://github.com/google/googletest | `f8d7d77c0693` | BSD-3-Clause |
| lz4 | https://github.com/lz4/lz4 | `0774d05537f9` | BSD-2-Clause (lib/) / GPL-2.0-or-later (rest) |

## Patches

qzjs applies source patches to several vendored dependencies (tracked
under `deps/*.patch` and in-tree CMake patch blocks) for C99 conformance
and runtime adaptations. Patches do not alter upstream licenses; they are
applied under the same terms as the original code.
