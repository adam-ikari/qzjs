---
title: Extensions
description: Build-time native C extensions for qzjs — qz_ext_t interface, QZ_EXTENSIONS macro, lifecycle hooks, and per-runtime state.
---

# Extensions

Extensions are native C modules that add global objects and functions to JS contexts. They implement the `qz_ext_t` interface with lifecycle hooks.

## Built-in Extensions

| Extension | Option | JS API |
|-----------|--------|-------|
| `ext_compress` | `QZ_WITH_COMPRESS` | gzip/zlib/deflate compression |
| `ext_crypto` | `QZ_WITH_CRYPTO_EXT` | SHA, HMAC, PBKDF2, AES-GCM |
| `ext_textcodec` | `QZ_WITH_TEXTCODEC` | UTF-8, Base64 encode/decode |
| `ext_wamr` | `QZ_WITH_WAMR` | WebAssembly via WAMR (default) |
| `ext_wasm3` | `QZ_WITH_WASM3` | WebAssembly via wasm3 (optional) |

**Note:** `ext_wamr` and `ext_wasm3` are mutually exclusive — both register the `WebAssembly` global, so only one can be enabled per build.

Built-in extensions are automatically registered on every new context.

## Extension Interface

```c
typedef struct qz_ext_t {
    const char *name;          // Human-readable name for diagnostics
    int (*init)(qz_ext_t *ext, qz_t *rt);      // Called on context creation
    void (*destroy)(qz_ext_t *ext, qz_t *rt);   // Called on context destruction
    int (*suspend)(qz_ext_t *ext, qz_t *rt);    // Called on context suspend
    int (*resume)(qz_ext_t *ext, qz_t *rt);     // Called on context resume
    void *user_data;           // Opaque extension state
} qz_ext_t;
```

## Writing a Custom Extension

```c
#include <qzjs/qzjs.h>
#include <quickjs.h>
#include "qz_internal.h"   // qz_get_active_jsctx (internal helper)

static int my_ext_init(qz_ext_t *ext, qz_t *rt) {
    JSContext *ctx = qz_get_active_jsctx(rt);
    if (!ctx) return -1;

    // Add a global function
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "hello",
        JS_NewCFunction(ctx, my_hello_fn, "hello", 0));
    JS_FreeValue(ctx, global);

    return 0;  // success
}

static void my_ext_destroy(qz_ext_t *ext, qz_t *rt) {
    // Clean up any extension resources
    // JSContext cleanup is handled by qzjs
}

static int my_ext_suspend(qz_ext_t *ext, qz_t *rt) {
    // Save state, close connections, etc.
    return 0;
}

static int my_ext_resume(qz_ext_t *ext, qz_t *rt) {
    // Restore state, reopen connections, etc.
    return 0;
}

qz_ext_t my_extension = {
    .name = "my_extension",
    .init = my_ext_init,
    .destroy = my_ext_destroy,
    .suspend = my_ext_suspend,
    .resume = my_ext_resume,
    .user_data = NULL,
};
```

## Registering Extensions

Extensions are registered at **build time** via the `QZ_EXTENSIONS` macro
(defined in `include/qzjs/qz_ext_registry.h`). There is no runtime
registration API — the extension set is fixed when the qzjs library is compiled.

### Built-in extensions

Built-in extensions (compress/crypto/textcodec/wamr) are auto-registered when
their `QZ_WITH_*` CMake option is on. They appear in `QZ_DEFAULT_EXTENSIONS`
as conditional slots (a disabled built-in becomes a NULL slot that's skipped at
init).

### Adding a custom extension (non-invasive)

A parent project adds its own extension **without editing qzjs source**: compile
the extension's `.c` into the qzjs target (so its `&my_extension` symbol is
visible to `context.c`) and append it to `QZ_EXTENSIONS`:

```cmake
# In the parent project's CMakeLists.txt, before add_subdirectory(qzjs):
set(QZ_EXTENSIONS "QZ_DEFAULT_EXTENSIONS &my_extension")
set(QZ_EXTRA_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/my_extension.c)
add_subdirectory(deps/qzjs)
```

`QZ_EXTRA_SOURCES` adds the source to the `qzjs` target; `QZ_EXTENSIONS`
overrides the table to append `&my_extension` after the default set. Note the
**space** separator: `QZ_DEFAULT_EXTENSIONS` already ends in a trailing comma,
so a comma here would produce an empty array element (`ptr, , &my_extension`)
and a C99 compile error. To **trim** a built-in, list only the entries you want
instead of `QZ_DEFAULT_EXTENSIONS`.

## Lifecycle Hooks

- **`init`** — called when the extension is registered on a context (at `qz_create`, or when a worker context is created). Register JS globals, allocate resources. Return 0 on success, <0 on failure.
- **`destroy`** — called when the context is destroyed. Free extension resources. JSContext cleanup is automatic — you only need to free your own allocations.
- **`suspend`** — called when the context is suspended. Save state, pause timers, close connections.
- **`resume`** — called when the context is resumed. Restore state, resume timers, reopen connections.

All hooks receive both the extension and the runtime. Get the active `JSContext*` via `qz_get_active_jsctx(rt)` (internal, `src/qz_internal.h`).

### Per-runtime state in init

The `qz_ext_t.user_data` field lives on the **shared compile-time** extension
struct — it is NOT per-instance. The public API has no per-runtime opaque
pointer: there is no `host_data` config field and no runtime-data accessor, and
the library never invokes host callbacks (all host-bound output goes to the
mailbox). An extension that needs per-runtime state keeps its own table keyed by
the `qz_t *` handle it receives in every hook:

```c
/* extension init: init runs on the JS thread during qz_create, before the
 * host holds the rt — but rt is a valid key from inside the hook. */
static int my_ext_init(qz_ext_t *ext, qz_t *rt) {
    my_state_t *st = my_registry_get_or_create(rt);  /* your own per-rt table */
    ...
}
```
