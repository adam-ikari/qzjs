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
| `user_data` | 不透明的扩展状态。**注意：** 这在所有运行时之间共享 — 对于每个实例的数据，使用 `config.host_data`。 |

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

`qz_ext_t.user_data` 在所有运行时之间共享。对于每个实例的状态，使用 `config.host_data`：

```c
qz_config_t cfg = { .pal = pal, .host_data = my_per_rt_state,
                      .uv_loop = my_loop /* uv_loop_t*，ISOLATED 下必填 */ };
qz_t *rt = qz_create(&cfg);

// 在扩展 init 内部：
my_state_t *st = (my_state_t *)qz_get_runtime_data(rt);
```

## 参见

- [扩展指南](/zh/guide/extensions) — 详细的扩展文档
- [扩展注册头文件](/zh/c-api/runtime) — 运行时生命周期