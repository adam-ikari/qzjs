# C API 参考

qzjs 暴露了一个小巧、专注的 C API 接口。每个函数都操作一个不透明的 `qz_t*` 运行时句柄。JS 在运行时内部是**单线程**的——宿主从不直接调用 JS，qzjs 也从不执行宿主代码：所有发往宿主的消息都进入每个运行时独立的**邮箱**，由宿主自选线程消费。阻塞型宿主 API（`qz_create`、`qz_destroy`、`qz_ping`、`qz_ping_path`、`qz_wait_idle`）必须来自创建运行时的宿主线程；`qz_post_message`、`qz_control` 任何线程可调；`qz_recv_message` 也可从任何线程调用，但同一 runtime 同一时刻只允许一个消费者。

## API 分组

| 分组 | 描述 |
|-------|-------------|
| [运行时生命周期](/zh/c-api/runtime) | `qz_create`、`qz_destroy`、`qz_wait_idle`、`qz_free` |
| [消息](/zh/c-api/runtime#消息) | 入 `qz_post_message`，出 `qz_recv_message` / `qz_free_message` / `qz_message_fd` |
| [控制面](/zh/c-api/runtime#qz_control) | `qz_control` — eval / inspect / metrics / interrupt，回执走邮箱 |
| [存活探测](/zh/c-api/runtime#存活探测) | `qz_ping`、`qz_ping_path`（ISOLATED）与全构建可用的 `*_if_available` |
| [字节码](/zh/c-api/runtime#qz_compile) | `qz_compile` — JS 源码编译为字节码 blob |
| [多上下文](/zh/guide/multi-context) | 一个运行时内隔离的 JS 上下文 |
| [扩展](/zh/c-api/extensions) | `qz_ext_t`、生命周期钩子 |

## 快速示例

```c
#include <qzjs/qzjs.h>
#include <stdio.h>

int main(void) {
    qz_config_t cfg = {0};
    cfg.initial_script = "globalThis.onmessage = function (e) { postMessage(e.data); };";
    qz_t *rt = qz_create(&cfg);
    if (!rt) { fprintf(stderr, "create failed\n"); return 1; }

    qz_post_message(rt, "{\"cmd\":\"echo\",\"data\":\"hi\"}", 26);

    /* 在本线程排干邮箱——无需驱动 loop，也没有回调。 */
    for (;;) {
        char *json = NULL; size_t len = 0;
        int r = qz_recv_message(rt, &json, &len, 1000 /* ms */);
        if (r != 0) break;              /* 1 = 超时，-1 = 错误 */
        printf("收到: %.*s\n", (int)len, json);
        qz_free_message(json);
    }

    qz_wait_idle(rt);
    char *json; size_t len;
    while (qz_recv_message(rt, &json, &len, 0) == 0) {   /* 最终排干 */
        printf("迟到消息: %.*s\n", (int)len, json);
        qz_free_message(json);
    }
    qz_free(rt);   /* 同时释放邮箱中残余消息 */
    return 0;
}
```

THREAD 构建下同一程序原样可用：两种进程模型下库都自主管理自己的线程与
loop，宿主只需消费邮箱。若要把唤醒 fd（`qz_message_fd`）接入你自己的
poll/epoll/select 事件系统，消费协议见[运行时生命周期](/zh/c-api/runtime#邮箱)。

## 构建集成

```cmake
find_package(qzjs REQUIRED)
target_link_libraries(your_app PRIVATE qzjs::qzjs)
```

## 线程模型

JS 执行在设计上**单线程**：所有 JS 都在运行时自己的 loop 上运行，宿主线程从不直接调用 JS。库自主管理线程与 loop，从不执行宿主代码；宿主自选线程、自选时机消费消息。库的**一侧**形态随构建而定：

- **ISOLATED（缺省）**——库 spawn 主RT 进程（`qzjs-rt`），并在库内启动自己的宿主侧线程 + loop。出站消息——JS `postMessage`、崩溃上报 `{"type":"error"}`、CONTROL 回执——进入邮箱；宿主通过 `qz_recv_message` 在任意线程消费（可选用 `qz_message_fd` 唤醒）。阻塞宿主 API（`qz_ping`、`qz_ping_path`、`qz_wait_idle`、`qz_destroy`）阻塞的是**调用线程**，库自有线程在这期间照常转 loop 并产出回执（或执行三级终止）。没有 loop 注入，没有驱动 loop 义务，也没有同链接 libuv 的要求。
- **THREAD**——库启动内部 `qzjs` 线程运行嵌入式 libuv 循环，所有 JS 都在该线程上运行；出站消息进入同一套邮箱 API。

两个模型下 `qz_post_message` 都是线程安全的（入站，JSON 会被拷贝）；`qz_recv_message` 可从任何线程调用，但同一 runtime 同一时刻只允许一个消费者；`qz_create`/`qz_destroy` 是宿主线程调用。
