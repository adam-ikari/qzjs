---
title: 扩展
description: qzjs 构建时原生 C 扩展 — qz_ext_t 接口、QZ_EXTENSIONS 宏、生命周期钩子和每运行时状态。
---

# 扩展

扩展是为 JS 上下文添加全局对象和函数的原生 C 模块。它们实现了带有生命周期钩子的 `qz_ext_t` 接口。

## 内置扩展

| 扩展 | 选项 | JS API |
|-----------|--------|-------|
| `ext_compress` | `QZ_WITH_COMPRESS` | gzip/zlib/deflate 压缩 |
| `ext_crypto` | `QZ_WITH_CRYPTO_EXT` | SHA、HMAC、PBKDF2、AES-GCM |
| `ext_textcodec` | `QZ_WITH_TEXTCODEC` | UTF-8、Base64 编解码 |
| `ext_wamr` | `QZ_WITH_WAMR` | 通过 WAMR 的 WebAssembly（默认） |
| `ext_wasm3` | `QZ_WITH_WASM3` | 通过 wasm3 的 WebAssembly（可选） |

**注意：** `ext_wamr` 和 `ext_wasm3` 互斥 — 两者都注册 `WebAssembly` 全局对象，因此每次构建只能启用其中一个。

内置扩展会在每个新上下文上自动注册。

## 扩展接口

```c
typedef struct qz_ext_t {
    const char *name;          // 人类可读的名称，用于诊断
    int (*init)(qz_ext_t *ext, qz_t *rt);      // 上下文创建时调用
    void (*destroy)(qz_ext_t *ext, qz_t *rt);   // 上下文销毁时调用
    int (*suspend)(qz_ext_t *ext, qz_t *rt);    // 上下文挂起时调用
    int (*resume)(qz_ext_t *ext, qz_t *rt);     // 上下文恢复时调用
    void *user_data;           // 不透明的扩展状态
} qz_ext_t;
```

## 编写自定义扩展

```c
#include <qzjs/qzjs.h>
#include <quickjs.h>
#include "base/qz_rt.h"    // qz_get_active_jsctx（内部辅助）

static JSValue my_hello_fn(JSContext *ctx, JSValue this_val,
                           int argc, JSValue *argv) {
    QZ_UNUSED(this_val); QZ_UNUSED(argc); QZ_UNUSED(argv);
    return JS_NewString(ctx, "hello from C");
}

static int my_ext_init(qz_ext_t *ext, qz_t *rt) {
    QZ_UNUSED(ext);
    JSContext *ctx = qz_get_active_jsctx(rt);
    if (!ctx) return -1;

    // 添加全局函数
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "hello",
        JS_NewCFunction(ctx, my_hello_fn, "hello", 0));
    JS_FreeValue(ctx, global);

    return 0;  // 成功
}

static void my_ext_destroy(qz_ext_t *ext, qz_t *rt) {
    // 清理扩展资源
    // JSContext 的清理由 qzjs 处理
}

static int my_ext_suspend(qz_ext_t *ext, qz_t *rt) {
    // 保存状态、关闭连接等
    return 0;
}

static int my_ext_resume(qz_ext_t *ext, qz_t *rt) {
    // 恢复状态、重新打开连接等
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

## 注册扩展

扩展在**构建时**通过 `QZ_EXTENSIONS` 宏（定义在
`include/qzjs/qz_ext_registry.h` 中）注册。没有运行时注册 API —
扩展集在编译 qzjs 库时固定。

### 内置扩展

内置扩展（compress/crypto/textcodec/wamr）在其 `QZ_WITH_*` CMake 选项开启时自动注册。
它们作为条件槽出现在 `QZ_DEFAULT_EXTENSIONS` 中
（禁用的内置扩展变为 NULL 槽，在初始化时被跳过）。

### 添加自定义扩展（非侵入式）

父项目可以**不修改 qzjs 源码**来添加自己的扩展：将扩展的 `.c` 编译进 qzjs 目标
（使其 `&my_extension` 符号对 `context.c` 可见），并将其追加到 `QZ_EXTENSIONS`：

```cmake
# 在父项目的 CMakeLists.txt 中，在 add_subdirectory(qzjs) 之前：
set(QZ_EXTENSIONS "QZ_DEFAULT_EXTENSIONS &my_extension")
set(QZ_EXTRA_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/my_extension.c)
add_subdirectory(deps/qzjs)
```

`QZ_EXTRA_SOURCES` 将源文件添加到 `qzjs` 目标；`QZ_EXTENSIONS`
覆盖表格以在默认集之后追加 `&my_extension`。注意分隔符是**空格**：
`QZ_DEFAULT_EXTENSIONS` 本身以尾随逗号结尾，此处再写逗号会展开出空数组元素
（`ptr, , &my_extension`），C99 下直接编译报错。要**裁剪**内置扩展，
只需列出你需要的条目，而不是 `QZ_DEFAULT_EXTENSIONS`。

## 生命周期钩子

- **`init`** — 在扩展注册到上下文时调用（`qz_create` 时，或创建 worker 上下文时）。注册 JS 全局对象，分配资源。成功返回 0，失败返回 <0。
- **`destroy`** — 在上下文销毁时调用。释放扩展资源。JSContext 清理是自动的 — 你只需要释放自己的分配。
- **`suspend`** — 在上下文挂起时调用。保存状态、暂停定时器、关闭连接。
- **`resume`** — 在上下文恢复时调用。恢复状态、恢复定时器、重新打开连接。

所有钩子都接收扩展和运行时。通过 `qz_get_active_jsctx(rt)` 获取活跃的 `JSContext*`（内部辅助，声明于 `src/base/qz_rt.h`）。

### init 中的每运行时状态

`qz_ext_t.user_data` 字段位于**共享的编译时**扩展结构体上 — 它不是每实例的。
公共 API 没有每运行时的不透明指针：既没有 `host_data` 配置字段，也没有
runtime-data 访问器，且库从不回调宿主（所有发往宿主的消息都进邮箱）。需要每运
行时状态的扩展，自行维护一张以每个钩子收到的 `qz_t *` 句柄为键的表：

```c
#include <qzjs/qzjs.h>
#include "base/qz_types.h" /* QZ_UNUSED */

/* 你自己的 per-rt 表：qzjs 不提供 runtime-data 通道，键只能是钩子收到的 rt。 */
typedef struct { int refcount; } my_state_t;
#define MAX_INSTANCES 64
static struct { qz_t *rt; my_state_t *st; } g_registry[MAX_INSTANCES];

static my_state_t *my_registry_get_or_create(qz_t *rt) {
    for (size_t i = 0; i < MAX_INSTANCES; i++)
        if (g_registry[i].st && g_registry[i].rt == rt) return g_registry[i].st;
    for (size_t i = 0; i < MAX_INSTANCES; i++) {
        if (!g_registry[i].st) {
            g_registry[i].rt = rt;
            g_registry[i].st = calloc(1, sizeof *g_registry[i].st);
            return g_registry[i].st;
        }
    }
    return NULL;   /* 表满：显式失败，不静默复用别人的槽 */
}

/* 扩展 init：init 在 qz_create 期间于 JS 线程上运行，此时宿主尚未拿到 rt —
 * 但在钩子内部 rt 是有效的键。 */
static int my_ext_init(qz_ext_t *ext, qz_t *rt) {
    QZ_UNUSED(ext);
    my_state_t *st = my_registry_get_or_create(rt);
    return st ? 0 : -1;
}
```