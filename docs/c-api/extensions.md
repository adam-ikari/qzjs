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
| `user_data` | Opaque extension state. **Note:** This is shared across all runtimes — qzjs provides no per-runtime host-data channel, so key per-instance state inside your own structures (e.g. by `rt`) if you need it. |

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
#include "qz_internal.h"   /* qz_get_active_jsctx — internal helper */

static JSValue my_hello_fn(JSContext *ctx, JSValue this_val,
                           int argc, JSValue *argv) {
    QZ_UNUSED(this_val);
    return JS_NewString(ctx, "hello from C");
}

static int my_ext_init(qz_ext_t *ext, qz_t *rt) {
    QZ_UNUSED(ext);
    JSContext *ctx = qz_get_active_jsctx(rt);
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

qzjs provides **no per-runtime host-data channel** for extensions: there are
no `qz_get_runtime_data` / `qz_set_runtime_data` accessors and no
`config.host_data` field. `qz_ext_t.user_data` is shared across all runtimes.
If an extension needs per-instance state, key it inside its own structures —
the `rt` (and `JSContext *`) passed to every lifecycle hook is a stable
identity:

```c
#include <qzjs/qzjs.h>
#include "qz_internal.h"   /* QZ_UNUSED */

/* 扩展自己的东西：qzjs 不提供任何 per-runtime 宿主数据通道。 */
typedef struct { int refcount; } my_state_t;

#define MAX_INSTANCES 64
typedef struct { qz_t *rt; my_state_t *state; } ext_instance_t;

static ext_instance_t instances[MAX_INSTANCES];   /* 或按 rt 索引的哈希表 */

static ext_instance_t *find_or_create_instance(ext_instance_t *tab, size_t cap,
                                              qz_t *rt) {
    for (size_t i = 0; i < cap; i++)
        if (tab[i].state && tab[i].rt == rt) return &tab[i];
    for (size_t i = 0; i < cap; i++) {
        if (!tab[i].state) {
            tab[i].rt = rt;
            tab[i].state = calloc(1, sizeof *tab[i].state);
            return &tab[i];
        }
    }
    return NULL;   /* 表满：显式失败，不静默复用别人的槽 */
}

static my_state_t *my_per_rt_state_new(void) { return calloc(1, sizeof(my_state_t)); }

static int my_ext_init(qz_ext_t *ext, qz_t *rt) {
    QZ_UNUSED(ext);
    ext_instance_t *inst = find_or_create_instance(instances, MAX_INSTANCES, rt);
    if (!inst) return -1;
    inst->state = my_per_rt_state_new();
    return inst->state ? 0 : -1;
}
```

Host-bound messages flow through the runtime mailbox (`qz_recv_message`),
not through extension callbacks — see
[Runtime Lifecycle / Mailbox](/c-api/runtime#mailbox).

## See Also

- [Extensions Guide](/guide/extensions) — detailed extension documentation
- [Extension Registry Header](/c-api/runtime) — runtime lifecycle