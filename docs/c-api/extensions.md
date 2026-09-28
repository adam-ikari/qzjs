# Extensions (C API)

Extensions are native C modules that add global objects and functions to JS contexts. They implement the `qz_ext_t` interface with lifecycle hooks.

## `qz_ext_t`

```c
typedef struct qz_ext_t {
    const char *name;
    int (*init)(qz_ext_t *ext, qz_t *rt);
    void (*destroy)(qz_ext_t *ext, qz_t *rt);
    int (*suspend)(qz_ext_t *ext, qz_t *rt);
    int (*resume)(qz_ext_t *ext, qz_t *rt);
    void *user_data;
} qz_ext_t;
```

| Field | Description |
|-------|-------------|
| `name` | Human-readable name for diagnostics |
| `init` | Called on context creation — register JS globals, allocate resources. Return 0 on success, <0 on failure. |
| `destroy` | Called on context destruction — free extension resources. JSContext cleanup is automatic. |
| `suspend` | Called on context suspend — save state, pause timers, close connections. |
| `resume` | Called on context resume — restore state, resume timers, reopen connections. |
| `user_data` | Opaque extension state. **Note:** This is shared across all runtimes — for per-instance data, use `config.host_data`. |

## Registration Model

Extensions are registered at **build time** via the `QZ_EXTENSIONS` macro (defined in `include/qzjs/qz_ext_registry.h`). There is no runtime registration API — the extension set is fixed when the qzjs library is compiled.

```c
// include/qzjs/qz_ext_registry.h
#define QZ_DEFAULT_EXTENSIONS \
    QZ_EXT_IF_WITH(COMPRESS,   &qz_compress_ext) \
    QZ_EXT_IF_WITH(CRYPTO_EXT, &qz_crypto_ext)   \
    QZ_EXT_IF_WITH(TEXTCODEC,  &qz_textcodec_ext) \
    QZ_EXT_IF_WITH(WAMR,       &qz_wamr_ext)
```

A parent project adds custom extensions by overriding `QZ_EXTENSIONS` before including the qzjs subdirectory:

```cmake
set(QZ_EXTENSIONS "QZ_DEFAULT_EXTENSIONS &my_extension")
set(QZ_EXTRA_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/my_extension.c)
add_subdirectory(deps/qzjs)
```

Use a **space**, not a comma, before `&my_extension`: `QZ_DEFAULT_EXTENSIONS`
already ends in a trailing comma, so `"QZ_DEFAULT_EXTENSIONS, &my_extension"`
expands to an empty array element and fails to compile.

## Built-in Extensions

| Extension | CMake Option | JS API |
|-----------|-------------|-------|
| `ext_compress` | `QZ_WITH_COMPRESS` | gzip/zlib/deflate |
| `ext_crypto` | `QZ_WITH_CRYPTO_EXT` | crypto.subtle (SHA, HMAC, PBKDF2, AES-GCM) |
| `ext_textcodec` | `QZ_WITH_TEXTCODEC` | TextEncoder, TextDecoder |
| `ext_wamr` | `QZ_WITH_WAMR` | WebAssembly (WAMR, default) |
| `ext_wasm3` | `QZ_WITH_WASM3` | WebAssembly (wasm3, optional) |

## Writing an Extension

```c
#include <qzjs/qzjs.h>
#include <quickjs.h>

static int my_ext_init(qz_ext_t *ext, qz_t *rt) {
    JSContext *ctx = qz_get_jsctx(rt);
    if (!ctx) return -1;

    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "hello",
        JS_NewCFunction(ctx, my_hello_fn, "hello", 0));
    JS_FreeValue(ctx, global);

    return 0;
}

static void my_ext_destroy(qz_ext_t *ext, qz_t *rt) {
    // Free any extension-specific resources
}

qz_ext_t my_extension = {
    .name = "my_extension",
    .init = my_ext_init,
    .destroy = my_ext_destroy,
    .suspend = NULL,
    .resume = NULL,
    .user_data = NULL,
};
```

## Per-Runtime Data

`qz_ext_t.user_data` is shared across all runtimes. For per-instance state, use `config.host_data`:

```c
qz_config_t cfg = { .pal = pal, .host_data = my_per_rt_state,
                      .uv_loop = my_loop /* uv_loop_t*, required under ISOLATED */ };
qz_t *rt = qz_create(&cfg);

// Inside extension init:
my_state_t *st = (my_state_t *)qz_get_runtime_data(rt);
```

## See Also

- [Extensions Guide](/guide/extensions) — detailed extension documentation
- [Extension Registry Header](/c-api/runtime) — runtime lifecycle