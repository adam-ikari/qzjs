# 运行时生命周期

每个 qzjs 程序都遵循相同的生命周期：**创建 → 使用 → 排干邮箱 → 销毁**。

## `qz_create`

```c
qz_t *qz_create(const qz_config_t *config);
```

创建一个新的 qzjs 运行时。宿主侧发生什么取决于构建的进程模型（`QZ_PROCESS_MODEL`，缺省 `ISOLATED`）：

- **ISOLATED** — 库**拥有自己的宿主侧线程和循环**：先 spawn 主RT 进程（`qzjs-rt`），再在库内启动宿主侧泵线程 + loop（绝不使用宿主的 loop）。`qz_create` 阻塞等待主RT 的 `CONTROL{ready}`。ready 前到达的消息帧在 create 返回前就已重放进邮箱，宿主第一次 `qz_recv_message` 即可取到。JS（含 `initial_script`）在主RT 进程内、库自有的 loop 上运行。
- **THREAD** — qzjs 启动自己的内部线程和嵌入式 libuv 循环；`qz_create` 阻塞，直到线程就绪且 `initial_script` 已在该线程上求值。

注册的扩展集在编译期通过 `QZ_EXTENSIONS` 宏固定；没有运行时扩展列表。宿主**不注入 loop**，也**不提供回调**：所有发往宿主的消息都进入运行时的[邮箱](#邮箱)，宿主自选线程、自选时机消费。

失败时返回 `NULL`（包括 `initial_script` 抛出异常，或 ready 握手失败）。

**参数：**

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `config.initial_script` | `const char *` | 创建时在运行时内部求值的 JS（ISOLATED 在主RT 进程，THREAD 在内部 qzjs 线程）；抛出异常会使 `qz_create` 返回 `NULL` |
| `config.debug` | `int` | 位掩码。`0x2` 启用 DAP 调试器（也可设环境变量 `QZ_DEBUG=1`） |
| `config.control_plane` | `int` | `qz_control_plane_t`：`OFF`（0，缺省——`qz_control` 恒 -1）/ `IN_PROC`（1）/ `LOCAL`（2，额外开 AF_UNIX 端点） |
| `config.control_pipe_path` | `const char *` | `LOCAL` 档端点路径；`NULL` → `/tmp/qzjs-<pid>-<n>.ctl`（0600，SO_PEERCRED） |
| `config.worker_backend` | `int` | `qz_worker_backend_t`；缺省随编译模型（ISOLATED → `PROCESS`，THREAD → `THREAD`） |
| `config.initial_script_path` | `const char *` | 从文件读取并求值的 JS，替代 `initial_script`；两者都设时优先 |
| `config.initial_bytecode` | `const uint8_t *` | 预编译字节码（来自 `qz_compile`），在初始脚本之后求值 |
| `config.initial_bytecode_len` | `size_t` | `initial_bytecode` 的字节长度 |

**`qz_create` 内部做了什么：**

ISOLATED（缺省）：

1. Spawn 主RT 进程（`qzjs-rt`），在库内启动宿主侧泵线程 + loop，然后阻塞等待主RT 的 `CONTROL{ready}`——创建期间不执行任何宿主代码；ready 前的帧已在邮箱中
2. 在主RT 进程内部：初始化库自有 libuv 循环，创建 `JSRuntime` 和初始上下文，注册编译期扩展集（`QZ_EXTENSIONS` 表），注入 WinterTC 兼容运行时，求值 `initial_script`，若设置了 `initial_bytecode` 再求值字节码
3. 运行时就绪后返回

THREAD：

1. 启动 qzjs 的内部线程并初始化嵌入式 libuv 循环
2. 在该线程上：创建 `JSRuntime` 和初始上下文，注册编译期扩展集，注入 WinterTC 兼容运行时，求值 `initial_script`，若设置了 `initial_bytecode` 再求值字节码
3. 阻塞到线程就绪后返回

**线程模型：** 库自主管理线程与 loop，从不执行宿主代码。所有 JS 都在运行时内部、它自己的单一 loop 上运行（ISOLATED 为主RT 进程，THREAD 为内部 qzjs 线程）。宿主发送消息（`qz_post_message`，两个模型下都线程安全；同一 runtime 的 FIFO 顺序保持），并在[邮箱](#邮箱)中接收一切发往宿主的消息——JS `postMessage` 输出、崩溃上报 `{"type":"error"}`、CONTROL 回执——自选线程、自选时机消费。没有 libuv loop 注入义务，也没有同链接要求。存活探测（`qz_ping`、`qz_ping_path`）的阻塞等待发生在库的泵线程上；邮箱不受影响。

## `qz_destroy`

```c
void qz_destroy(qz_t *rt);
```

优雅关闭运行时：强制终止主执行体（ISOLATED 为 `qzjs-rt` 进程 + 库泵线程，THREAD 为内部线程）、回收，然后销毁所有上下文并释放所有资源（句柄、定时器、polyfill 状态、库自有的循环）。ISOLATED 下冻结的主RT 走三级终止，最坏阻塞 ≤2s，且冻结处理在库线程内完成，调用线程只等收尸。**宿主未消费的邮箱消息会在此被释放**——如需读取，先用 `qz_recv_message` 排干。传入 `NULL` 是安全的。仅限宿主线程——从调用 `qz_create` 的线程调用。

```c
qz_destroy(rt);
```

与 `qz_wait_idle` 互斥：二者只可选其一结束运行时。

## `qz_wait_idle`

```c
void qz_wait_idle(qz_t *rt);
```

请求「无待处理异步工作时自动退出」，并阻塞直到主执行体退出。等待在库内部完成——宿主什么都不用泵。等待期间出站消息（含崩溃上报 `{"type":"error"}`）照常进入邮箱；`qz_wait_idle` 返回后、`qz_free` 之前，`qz_recv_message` 仍然可用——最终排干就在那里做。返回后不得再对该 runtime 投递消息，也不得再 `qz_destroy`——只能 `qz_free`。与 `qz_destroy` 互斥（二者只可选其一，绝不同时调用）。

## `qz_free`

```c
void qz_free(void *p);
```

双重身份的释放，内部用 magic tag 区分：

- 传入已关停的运行时（`qz_wait_idle` 之后）——排干邮箱、关闭唤醒 fd、释放配置缓冲与运行时本身。
- 传入普通 malloc 缓冲（如来自 `qz_compile`）——等价于普通 `free`。

## `qz_compile`

```c
int qz_compile(const char *source, size_t len, const char *filename,
               uint8_t **out, size_t *out_len, char **err);
```

把 JS 源码编译为字节码 blob。独立函数——无需运行时实例。
成功返回 0（`*out` 为 malloc 缓冲，用 `free()` 释放；`*out_len` 为长度）；
失败返回 -1（`*err` 为 malloc 错误串，`free()` 释放）。`filename` 仅用于
错误/栈帧命名，可为 `NULL`。

字节码在启动时经 `qz_config_t.initial_bytecode` /
`initial_bytecode_len` 运行，或 CLI `qzjs --bytecode file.bc`。

**兼容性不保证：** 字节码与 qzjs 的具体构建绑定（引擎版本、序列化格式、
编译选项）。不同构建产出的字节码会让 `qz_create` 以
`SyntaxError: invalid version` 失败。请分发源码并在部署环境按目标构建编译。
见[字节码编译](/zh/guide/bytecode)。

## 邮箱

库发往宿主的每条消息——JS `postMessage` 输出、崩溃上报 `{"type":"error"}`、CONTROL 回执（顶层带 `"ctl":true` 与 `correl` 字段）——都进入每个运行时独立的 FIFO **邮箱**，宿主自选线程、自选时机消费：

```c
int  qz_recv_message(qz_t *rt, char **json, size_t *len, int timeout_ms);
void qz_free_message(void *json);
int  qz_message_fd(qz_t *rt);
```

### `qz_recv_message`

```c
int qz_recv_message(qz_t *rt, char **json, size_t *len, int timeout_ms);
```

取出邮箱中最旧的一条消息。

- `timeout_ms`：`0` = 纯轮询（不等待），`> 0` = 最多等待该毫秒数，`-1` = 无限阻塞直到有消息。
- 返回 `0` = 取到消息（`*json` 为 malloc 的 NUL 终止 UTF-8 缓冲，**必须**用 `qz_free_message` 释放；`*len` 不含终止符），`1` = 超时（`*json` 不变），`-1` = 参数/状态错误。

### `qz_free_message`

```c
void qz_free_message(void *json);
```

释放 `qz_recv_message` 返回的缓冲。NULL 安全。

### `qz_message_fd`

```c
int qz_message_fd(qz_t *rt);
```

运行时的唤醒 fd——一个 `eventfd`（单调计数、非阻塞、CLOEXEC）。把它接入你自己的 poll/epoll/select；可读 ⇒ 至少一条消息待取。该 fd 归运行时所有：宿主**不得**关闭它，且 `qz_free` 之后即失效。仅限 Linux（eventfd）。

### 消费协议

当基于唤醒 fd 等待时，这是**唯一**正确的顺序（消息先挂入邮箱、后写 eventfd，此顺序保证不会丢唤醒）：

1. `qz_recv_message(rt, &json, &len, 0)`——循环取出并**处理**，直到返回非 0。
2. `read(qz_message_fd(rt), ...)`——清 eventfd 计数，直到 `EAGAIN`。
3. 再探一次 `qz_recv_message(rt, &json, &len, 0)`——若取到消息回到步骤 1（并处理它）；只有确认为空才可以 `poll()` 阻塞。

### 消费者规则

- 同一 runtime 允许多个线程并发调用 `qz_recv_message` 消费（出队互斥）。但最多只应有**一个**线程作为「fd 等待者」。跨线程的消息所有权交接由宿主自行负责。
- 未被消费的消息在 `qz_destroy` / `qz_free` 时被释放——不泄漏，但此后不可达。若还需要它们，先排干邮箱。

### 纯轮询排干示例

```c
static void host_drain(qz_t *rt, int timeout_ms) {
    for (;;) {
        char *json = NULL; size_t len = 0;
        int r = qz_recv_message(rt, &json, &len, timeout_ms);
        if (r != 0) break;
        printf("[host] 收到 JS 消息: %.*s\n", (int)len, json);
        qz_free_message(json);
        timeout_ms = 0;   /* 首条到达后转纯轮询排干 */
    }
}
```

典型流程：`qz_create` → `qz_post_message` → 循环 `qz_recv_message(timeout)` 直到完成 → `qz_wait_idle` → 最终 `qz_recv_message(..., 0)` 排干 → `qz_free`。
