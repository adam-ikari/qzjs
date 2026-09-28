# C API 参考

qzjs 暴露了一个小巧、专注的 C API 接口。每个函数都操作一个不透明的 `qz_t*` 运行时句柄。JS 在运行时内部是**单线程**的——宿主从不直接调用 JS。阻塞型宿主 API（`qz_create`、`qz_destroy`、`qz_ping`、`qz_ping_path`、`qz_wait_idle`）必须来自创建运行时的宿主线程；`qz_post_message` 与 `qz_control` 线程安全，任何线程可调。

## API 分组

| 分组 | 描述 |
|-------|-------------|
| [运行时生命周期](/zh/c-api/runtime) | `qz_create`、`qz_destroy`、`qz_post_message` |
| [多上下文](/zh/guide/multi-context) | 一个运行时内隔离的 JS 上下文 |
| [扩展](/zh/c-api/extensions) | `qz_ext_t`、生命周期钩子 |
| [宿主数据](/zh/c-api/runtime#宿主数据) | `qz_get_runtime_data`、`qz_set_runtime_data` |

## 快速示例

```c
#include <qzjs/qzjs.h>
#include <uv.h>
#include <stdio.h>

static void on_message(qz_t *rt, const char *json, size_t len, void *data) {
    (void)rt; (void)data;
    printf("received: %.*s\n", (int)len, json);
}

int main(void) {
    uv_loop_t loop;
    uv_loop_init(&loop);

    qz_config_t cfg = {0};
    cfg.initial_script = "globalThis.onmessage = function (e) { postMessage(e.data); };";
    cfg.message_cb = on_message;
    cfg.uv_loop = &loop;        /* 宿主 loop 注入（ISOLATED 必填） */
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "create failed\n"); return 1; }

    qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);

    /* 泵宿主 loop：message_cb 在本线程触发。 */
    while (uv_run(&loop, UV_RUN_ONCE)) { /* until done */ }

    qz_destroy(rt);
    uv_loop_close(&loop);
    return 0;
}
```

THREAD 构建下同一程序不需要 `uv_loop`：`message_cb` 在库的内部 qzjs 线程上
触发，宿主做自己的事即可。完整的泵与重入规则见[事件循环](/zh/guide/event-loop)。

## 构建集成

```cmake
find_package(qzjs REQUIRED)
target_link_libraries(your_app PRIVATE qzjs::qzjs)
```

## 线程模型

JS 执行在设计上**单线程**：所有 JS 都在运行时自己的 loop 上运行，宿主线程从不直接调用 JS。库的**宿主侧**形态随构建而定：

- **ISOLATED（缺省）**——库在宿主侧不拥有任何线程和循环：你通过 `cfg.uv_loop` 注入自己的 `uv_loop_t`（必填——传 `NULL` 会让 `qz_create` 失败），库把宿主侧通道句柄挂在它上面，`message_cb` **在泵你 loop 的线程上触发**。阻塞宿主 API（`qz_ping`、`qz_ping_path`、`qz_wait_idle`、`qz_destroy`）会在内部就地泵该 loop，因此 `message_cb` 可能在这些调用内重入触发——不要在 `message_cb` 内调用任何阻塞宿主 API。库从不对你的 loop 调 `uv_run(UV_RUN_DEFAULT)` 或关闭它。宿主与 libqzjs 必须链接**同一个** libuv。
- **THREAD**——库启动内部 `qzjs` 线程运行嵌入式 libuv 循环，所有 JS 与 `message_cb` 都在该线程上运行；宿主什么都不用泵。

两个模型下 `qz_post_message` 都是线程安全的（入站，JSON 会被拷贝），`message_cb` 必须线程安全，`qz_create`/`qz_destroy` 是宿主线程调用。完整规则见[事件循环](/zh/guide/event-loop)。