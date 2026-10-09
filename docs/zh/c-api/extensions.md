# 扩展（C API）

扩展是向 JS 上下文添加全局对象和函数的原生 C 模块。它们实现 `qz_ext_t` 接口及其生命周期钩子。

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

| 字段 | 描述 |
|-------|-------------|
| `name` | 用于诊断的人类可读名称 |
| `init` | 在上下文创建时调用 — 注册 JS 全局对象，分配资源。成功返回 0，失败返回 <0。 |
| `destroy` | 在上下文销毁时调用 — 释放扩展资源。JSContext 清理是自动的。 |
| `suspend` | 在上下文挂起时调用 — 保存状态、暂停定时器、关闭连接。 |
| `resume` | 在上下文恢复时调用 — 恢复状态、恢复定时器、重新打开连接。 |
| `user_data` | 不透明的扩展状态。**注意：** 这在所有运行时之间共享——qzjs 不提供每运行时的宿主数据通道，如需每实例状态，请在你自己的结构中按 `rt` 等键索引。 |

## 注册模型

扩展在**编译期**通过 `QZ_EXTENSIONS` 宏注册（定义在 `include/qzjs/qz_ext_registry.h` 中）。没有运行时注册 API — 扩展集在 qzjs 库编译时固定。

```c
// include/qzjs/qz_ext_registry.h
#define QZ_DEFAULT_EXTENSIONS \
    QZ_EXT_IF_WITH(COMPRESS,   &qz_compress_ext) \
    QZ_EXT_IF_WITH(CRYPTO_EXT, &qz_crypto_ext)   \
    QZ_EXT_IF_WITH(TEXTCODEC,  &qz_textcodec_ext) \
    QZ_EXT_IF_WITH(WAMR,       &qz_wamr_ext)
```

父项目通过在包含 qzjs 子目录之前覆盖 `QZ_EXTENSIONS` 来添加自定义扩展：

```cmake
set(QZ_EXTENSIONS "QZ_DEFAULT_EXTENSIONS &my_extension")
set(QZ_EXTRA_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/my_extension.c)
add_subdirectory(deps/qzjs)
```

`&my_extension` 前用**空格**而非逗号：`QZ_DEFAULT_EXTENSIONS` 本身以尾随逗号
结尾，写成 `"QZ_DEFAULT_EXTENSIONS, &my_extension"` 会展开出空数组元素，
编译失败。

## 内置扩展

| 扩展 | CMake 选项 | JS API |
|-----------|-------------|-------|
| `ext_compress` | `QZ_WITH_COMPRESS` | gzip/zlib/deflate |
| `ext_crypto` | `QZ_WITH_CRYPTO_EXT` | crypto.subtle（SHA、HMAC、PBKDF2、AES-GCM） |
| `ext_textcodec` | `QZ_WITH_TEXTCODEC` | TextEncoder、TextDecoder |
| `ext_wamr` | `QZ_WITH_WAMR` | WebAssembly（WAMR，默认） |
| `ext_wasm3` | `QZ_WITH_WASM3` | WebAssembly（wasm3，可选） |

## 编写扩展

```c
#include <qzjs/qzjs.h>
#include <quickjs.h>
#include "base/qz_rt.h"    /* qz_get_active_jsctx — 内部辅助函数 */

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
    // 释放任何扩展特定资源
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

## 每个运行时的数据

qzjs 为扩展**不提供每运行时的宿主数据通道**：没有 `qz_get_runtime_data` /
`qz_set_runtime_data` 访问器，也没有 `config.host_data` 字段。
`qz_ext_t.user_data` 在所有运行时之间共享。如果扩展需要每实例状态，请在其
自有结构中索引——每个生命周期钩子收到的 `rt`（以及 `JSContext *`）就是稳定
的身份标识：

```c
#include <qzjs/qzjs.h>
#include "base/qz_types.h" /* QZ_UNUSED */

/* 扩展自己的东西：qzjs 不提供任何 per-runtime 宿主数据通道。 */
typedef struct { int refcount; } my_state_t;

#define MAX_INSTANCES 64
typedef struct { qz_t *rt; my_state_t *state; } ext_instance_t;

static ext_instance_t instances[MAX_INSTANCES];   /* 或以 rt 为键的哈希表 */

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

发往宿主的消息经运行时邮箱（`qz_recv_message`）流转，而不是经扩展回调——
见[运行时生命周期 / 邮箱](/zh/c-api/runtime#邮箱)。

## 参见

- [扩展指南](/zh/guide/extensions) — 详细的扩展文档
- [扩展注册头文件](/zh/c-api/runtime) — 运行时生命周期