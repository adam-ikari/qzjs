# 运行时生命周期

每个 qzjs 程序都遵循相同的生命周期：**创建 → 使用 → 排干邮箱 → 销毁**。

## `qz_create`

```c
qz_t *qz_create(const qz_config_t *config);
```

创建一个新的 qzjs 运行时。宿主侧发生什么取决于构建的进程模型（`QZ_PROCESS_MODEL`，缺省 `ISOLATED`）：

- **ISOLATED** — 库**拥有自己的宿主侧线程和循环**：先 spawn 主RT 进程（`qzjs-rt`），再在库内启动宿主侧线程 + loop（绝不使用宿主的 loop）。`qz_create` 阻塞等待主RT 的 `CONTROL{ready}`。ready 前到达的消息帧在 create 返回前就已重放进邮箱，宿主第一次 `qz_recv_message` 即可取到。JS（含 `initial_script`）在主RT 进程内、库自有的 loop 上运行。
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

1. Spawn 主RT 进程（`qzjs-rt`），在库内启动宿主侧线程 + loop，然后阻塞等待主RT 的 `CONTROL{ready}`——创建期间不执行任何宿主代码；ready 前的帧已在邮箱中
2. 在主RT 进程内部：初始化库自有 libuv 循环，创建 `JSRuntime` 和初始上下文，注册编译期扩展集（`QZ_EXTENSIONS` 表），注入 WinterTC 兼容运行时，求值 `initial_script`，若设置了 `initial_bytecode` 再求值字节码
3. 运行时就绪后返回

THREAD：

1. 启动 qzjs 的内部线程并初始化嵌入式 libuv 循环
2. 在该线程上：创建 `JSRuntime` 和初始上下文，注册编译期扩展集，注入 WinterTC 兼容运行时，求值 `initial_script`，若设置了 `initial_bytecode` 再求值字节码
3. 阻塞到线程就绪后返回

**线程模型：** 库自主管理线程与 loop，从不执行宿主代码。所有 JS 都在运行时内部、它自己的单一 loop 上运行（ISOLATED 为主RT 进程，THREAD 为内部 qzjs 线程）。宿主发送消息（`qz_post_message`，两个模型下都线程安全；同一 runtime 的 FIFO 顺序保持），并在[邮箱](#邮箱)中接收一切发往宿主的消息——JS `postMessage` 输出、崩溃上报 `{"type":"error"}`、CONTROL 回执——自选线程、自选时机消费。没有 libuv loop 注入义务，也没有同链接要求。存活探测（`qz_ping`、`qz_ping_path`）的阻塞等待发生在**调用线程**上（带退避的短睡轮询，回执由库宿主侧线程回填）；邮箱不受影响。

## `qz_destroy`

```c
void qz_destroy(qz_t *rt);
```

优雅关闭运行时：强制终止主执行体（ISOLATED 为 `qzjs-rt` 进程 + 库自有线程，THREAD 为内部线程）、回收，然后销毁所有上下文并释放所有资源（句柄、定时器、polyfill 状态、库自有的循环）。ISOLATED 下冻结的主RT 走三级终止，最坏阻塞 ≤2s，且冻结处理在库线程内完成，调用线程只等收尸。**宿主未消费的邮箱消息会在此被释放**——如需读取，先用 `qz_recv_message` 排干。传入 `NULL` 是安全的。仅限宿主线程——从调用 `qz_create` 的线程调用。

```c
qz_destroy(rt);
```

与 `qz_wait_idle` 互斥：二者只可选其一结束运行时。

## `qz_wait_idle`

```c
void qz_wait_idle(qz_t *rt);
```

请求「无待处理异步工作时自动退出」，并阻塞直到主执行体退出。等待在库内部完成——宿主什么都不用驱动。等待期间出站消息（含崩溃上报 `{"type":"error"}`）照常进入邮箱；`qz_wait_idle` 返回后、`qz_free` 之前，`qz_recv_message` 仍然可用——最终排干就在那里做。返回后不得再对该 runtime 投递消息，也不得再 `qz_destroy`——只能 `qz_free`。与 `qz_destroy` 互斥（二者只可选其一，绝不同时调用）。

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

## 消息

### `qz_post_message`

```c
int qz_post_message(qz_t *rt, const char *json, size_t len);
```

入站消息入队。任何线程可调；`json` 内部拷贝，调用方仍持有自己的缓冲。
成功返回 0，失败返回 -1（参数非法，或运行时正在关停——`qz_wait_idle` 返回后
再 post 会被拒）。

同一 runtime 的 FIFO 顺序保持。投递不依赖宿主的调度——库自有线程双向搬运帧。

```c
#include <qzjs/qzjs.h>

static const char kMsg[] = "{\"cmd\":\"echo\",\"data\":\"hi\"}";
qz_post_message(rt, kMsg, sizeof kMsg - 1);   /* len 不含结尾 NUL */
```

### `qz_control`

```c
int qz_control(qz_t *rt, const char *bytes, size_t len);
```

控制命令入队。任何线程可调；`bytes` 内部拷贝。`config.control_plane` 为
`OFF`（缺省）时恒返回 -1。成功返回 0，失败返回 -1（OFF / OOM / 参数非法 /
下面两条硬拒）。

命令由主执行体在自己的事件循环安全点自主执行（ISOLATED = 主RT 进程，
THREAD = qzjs 线程）。**回执异步入邮箱**（`qz_recv_message`），JSON 顶层带
`"ctl":true`，`correl` 原样透传供配对。

两条输入在入口就被拒，而不是被静默 mishandle：

- 顶层带**数字** `"qzjs"` 键 = 通道层系统 CONTROL（`ready` / `idle` /
  `shutdown` / `ping` / `pong` / `pfail`）的保留命名空间。主RT 会把这些
  就地消费而不路由——用户命令带这个键就会无声消失，没有回执也没有错误，
  故 `qz_control` 拒收。
- 缺 `"correl"`（缺失、非字符串或空串）。回执唯一的配对依据就是 `correl`，
  缺了它宿主只会收到一条 `correl:""` 的孤儿回执，既配不上也丢不掉。

  **唯一例外是 `op:"interrupt"`**：它是 fire-and-forget 的——效果是投递时置位
  原子标志，命令消息入队只是为了「能」产出一份回执。所以不带 `correl` 的
  interrupt **照收**（返回 0），并且为了不造出上面那种孤儿回执，既不登记回执条目
  也不入队。带了 `correl` 的 interrupt 走常规路径（登记 + 入队 + 回执），
  不需要那份回执就忽略它。

## 存活探测

### `qz_ping` / `qz_ping_path`（仅 ISOLATED）

```c
int qz_ping(qz_t *rt, int32_t timeout_ms);
int qz_ping_path(qz_t *rt, const int32_t *path, int path_len,
                 int32_t timeout_ms);
```

`qz_ping` 发 CONTROL ping 到主RT，等它 C 层读回调就地直回的 PONG（不经 JS
也不经 msgq——pong 延迟只反映主RT 进程 uv loop 的健康度，JS 忙不误报）。
`qz_ping_path` 按 root-relative 槽位链寻址树中任意 worker（§8.2 path
寻址）——`path` 与命令面 `target_path` 同一套方案，如 `{1001,1002}` = worker
1001 的 sub worker 1002。ping 逐跳下投、PONG 沿树上行；中间节点与目标级 JS
零参与。

| 返回 | 含义 |
|------|------|
| `0` | 目标 loop 通畅（deadline 内 PONG 命中） |
| `1` | 超时 = 目标 loop 阻塞 |
| `-1` | 参数/状态错误（未 ready、正在关停、通道死、路径不存在） |

`timeout_ms` 建议 100–1000。等待发生在**调用线程**上（带退避的短睡轮询），
邮箱不受影响。

**这两个函数只在 `QZ_PROCESS_MODEL_ISOLATED`（且非 mock 测试构建）下声明**，
因为实现住在 `src/rt_host.c`，而那个文件只在这些配置下编译。THREAD 构建下
声明直接不存在——宿主误调会在**编译期**报出、指向源码那一行，而不是等到链接
期才来一句看起来像「构建坏了」的 `undefined reference`。

### `qz_ping_if_available` / `qz_ping_path_if_available`（所有构建）

```c
#define QZ_PING_UNAVAILABLE (-2)
int qz_ping_if_available(qz_t *rt, int32_t timeout_ms);
int qz_ping_path_if_available(qz_t *rt, const int32_t *path, int path_len,
                              int32_t timeout_ms);
```

同一组探测，所有构建都有——可移植的宿主代码因此既不需要 `#if`，也不必知道
`QZ_PROCESS_MODEL_*` 这些内部宏。ISOLATED 下直接转发 `qz_ping` /
`qz_ping_path`；THREAD（与 mock 测试构建）下返回 `QZ_PING_UNAVAILABLE`：
所有 JS 都跑在库自有线程上，宿主与 JS 之间没有可 ping 的边界，「问自己通不通」
不是有意义的探测。这里**刻意不**返回 0——谎报健康比明说「测不了」危险得多，
宿主会据此以为 loop 已经验过了，而实际上什么都没验。

| 返回 | 含义 |
|------|------|
| `0` / `1` / `-1` | 同上 `qz_ping` |
| `QZ_PING_UNAVAILABLE`（`-2`） | 本构建没有可测的跨边界 liveness |

`QZ_PING_UNAVAILABLE` 与 `-1`（参数/状态错误）刻意分开：「我的调用写错了」和
「这个构建答不了」该做的后续完全不同，混在一起宿主就再也分不出来。

```c
#include <qzjs/qzjs.h>

int rc = qz_ping_if_available(rt, 500);
if (rc == QZ_PING_UNAVAILABLE) {
    /* THREAD 构建：没有可探测的跨进程边界。 */
} else if (rc != 0) {
    fprintf(stderr, "main RT loop 阻塞或探测失败: %d\n", rc);
}
```

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

### 库的错误帧：宿主**必须**能容忍它们

邮箱里不只有你自己的协议。库在失败时会把一条 `{"type":"error", ...}` 帧塞进流里，
这是 §5.3「不静默降级」的载体：宁可让宿主看到一个形状陌生的帧，也不要在流上留一个
**无标记的洞**。当前两种：

| `error` 值 | 含义 | 宿主的正确反应 |
|---|---|---|
| （崩溃上报，见 `qz_wait_idle`） | 主RT 崩了，帧里带崩溃信息 | 记录；该 runtime 的后续行为已无意义 |
| `mailbox-alloc-failed` | **出站消息投递失败**（malloc 失败）——这条消息**已经丢了** | 记日志并告警；立刻加大排干频率 |

`mailbox-alloc-failed` 之所以重要：出站邮箱是**无界**的，宿主不排干就一直涨、
涨到分配失败为止。所以它的出现几乎总是「宿主排干得太慢」而不是库坏了，而帧里的
`hint` 字段写的就是这件事。

**所以消费循环不要假设每条帧都是你自己的协议。** 一条判别式就够，例如：

```c
char *json = NULL;
size_t len = 0;
int r;
while ((r = qz_recv_message(rt, &json, &len, 1000)) == 0) {
    if (strstr(json, "\"type\":\"error\"")) {
        /* 库的错误帧：记录后**继续**排干，不要 break —— 后面可能还有正常消息 */
        fprintf(stderr, "qzjs error frame: %.*s\n", (int)len, json);
    } else {
        printf("my protocol: %.*s\n", (int)len, json);   /* 你自己的协议 */
    }
    qz_free_message(json);             /* 每条都要放，循环里别漏 */
}
if (r < 0)
    fprintf(stderr, "recv failed: 参数/状态错误（不是「没消息」）\n");
else
    fprintf(stderr, "idle: 1s 内没有新消息\n");
```

把它当成「宿主必须实现的错误可见性契约」而不是某个具体帧：将来库再新增一种错误帧，
同一条判别式照样生效。

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

- `qz_recv_message` 可从任何线程调用，但同一 runtime **同一时刻只允许一个消费者**：无锁 pop 并非互斥，两个线程并发弹出会各自读到同一个 head 节点，同一条消息被交付两次、同一节点被释放两次。消费须由宿主自行串行化；取走消息后的跨线程移交由宿主负责。
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
