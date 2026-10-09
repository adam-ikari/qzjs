# API and ABI Versioning

qzjs follows [Semantic Versioning](https://semver.org/). While the project is on a
`0.x` version, the ABI is versioned explicitly and gated at both compile time and
runtime, so a host compiled against one version fails loudly against another
instead of reading past the end of a struct.

## The two version numbers

qzjs has two independent version numbers. They answer different questions, and
mixing them up is the main source of confusion.

| Number | Where it lives | What it means |
|--------|----------------|---------------|
| **Release version** (`0.3.0`) | The Git tag, `project(... VERSION ...)` in CMake, `qzjs --version` | The version of the whole project: JS-level APIs, behavior, features |
| **ABI version** (`QZ_ABI_VERSION`, currently `1`) | `include/qzjs/qzjs.h` | The binary layout of the C boundary: struct fields, function signatures |

A release may bump the release version without touching `QZ_ABI_VERSION` — adding
a JS-level feature does not change how a C struct is laid out in memory.

## What the ABI version covers

`QZ_ABI_VERSION` is bumped when any of these change:

- a field is **removed** or **reordered** in a public struct (`qz_config_t`)
- a field's **type** or size changes
- a public function's **signature** changes (parameters, return type, calling convention)
- a function is removed or renamed
- the **meaning** of an existing field or return value changes in a way that
  changes how a correctly-written host must behave

It is **not** bumped when:

- fields are **appended to the end** of a public struct (see below)
- new functions are **added** alongside existing ones
- JS-level behavior changes: new Web APIs, new polyfill features, engine upgrades

## How the gate works

### Compile time

`qz_config_t` starts with two fields that exist only for this purpose:

```c
#define QZ_ABI_VERSION 1

typedef struct qz_config_s {
    uint32_t struct_size;   /* qz_config_init fills this with sizeof(qz_config_t) */
    uint32_t abi_version;   /* must equal QZ_ABI_VERSION */
    /* ... the real configuration fields ... */
} qz_config_t;
```

Always initialize through `qz_config_init`:

```c
qz_config_t cfg;
qz_config_init(&cfg);        /* sets struct_size and abi_version for you */
cfg.initial_script = "...";
qz_t *rt = qz_create(&cfg);
```

Zero-initializing with `= {0}` leaves both fields at `0`, which `qz_create`
rejects. That is deliberate: a silent default would let a half-filled config
through.

### Runtime

`qz_config_t` is passed **by value** across the library boundary and copied in
full. A host compiled against an older header passes a *shorter* struct; a host
compiled against a newer one passes a *longer* struct. Either way the library
would read past the end of the caller's stack frame — silent memory unsafety.

```c
#include <qzjs/qzjs.h>
#include <stdio.h>

/* the guard qz_create runs before copying anything (src/host/qzjs.c) */
static int abi_mismatch(const qz_config_t *config)
{
    return config->abi_version != QZ_ABI_VERSION ||
           config->struct_size != (uint32_t)sizeof(qz_config_t);
}

static qz_t *create_guarded(const qz_config_t *cfg)
{
    if (abi_mismatch(cfg)) {
        fprintf(stderr, "qzjs: ABI mismatch — recompile the host\n");
        return NULL;
    }
    return qz_create(cfg);
}
```

The diagnostic goes to `stderr` because a failed `qz_create` has no other way to
report a reason — see [the runtime lifecycle docs](/c-api/runtime).

### Linking against a different library

When linking dynamically, the header you compiled against and the library you
loaded can still disagree even though `qz_create` would catch it eventually.
Check up front:

```c
#include <qzjs/qzjs.h>
#include <stdio.h>

int main(void) {
    if (qz_abi_version() != QZ_ABI_VERSION) {
        fprintf(stderr, "qzjs: header ABI %u, library ABI %u — rebuild the host\n",
                (unsigned)QZ_ABI_VERSION, (unsigned)qz_abi_version());
        return 1;
    }
    /* ... */
}
```

## Adding fields to a public struct

New fields are **appended to the end** and the ABI version stays the same. This
is safe because the host passes the struct by value and `struct_size` records
how much of it is meaningful: a host on the older header sends the shorter
size, and the library reads only the fields that header knew about.

The guarantee is one-directional and worth stating plainly: a **newer library
keeps working with an older-compiled host**. A host recompiled against a newer
header but run against an older library does not work — the gate rejects it.

If a change genuinely cannot be expressed as an append — a field is removed,
retyped, or reordered — bump `QZ_ABI_VERSION` in the same commit and note the
migration in `CHANGELOG.md`.

## Enums that vary by build

`qz_worker_backend_t` is the one enum whose *values* depend on compile-time
configuration (the ISOLATED vs THREAD process model). Its meaning is documented
where it is declared in `qzjs.h`. This is a documented consequence of the
process model, not an ABI break: the enum size and layout do not change, only
which values are meaningful. Hosts should not persist these values across builds.

## Bytecode is version-bound

Bytecode blobs produced by `qz_compile` (or `qjsc -b`) are **not** portable across
qzjs or engine versions. The reader validates the stream and rejects mismatches
with a checksum or version error, but the guarantee is only "bytecode from this
build runs in this build".

For deployment, ship the bytecode and the runtime together and rebuild together.

## What host authors should do

1. Call `qz_config_init` — never `= {0}`.
2. If linking dynamically, compare `qz_abi_version()` against `QZ_ABI_VERSION` at
   startup.
3. Read the `CHANGELOG.md` section for the version you are upgrading **across**.
   On a `0.x` line, breaking changes do occur; the ABI gate protects memory
   safety, not your source compatibility.
4. Rebuild the host whenever you upgrade the library. It costs a compile and
   removes the whole class of problems.

## See also

- [C API overview](/c-api/) — the surface these rules apply to
- [Runtime lifecycle](/c-api/runtime) — `qz_create` / `qz_destroy` semantics
- [Extensions](/c-api/extensions) — the extension ABI (`qz_ext_t`)