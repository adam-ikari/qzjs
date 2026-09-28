#ifndef QZ_H
#define QZ_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct qz_t qz_t;

/* ================================================================
 * qzjs configuration
 * ================================================================ */

typedef struct qz_config_s {
    /* 主 context 启动时在 qzjs 线程上 eval；抛异常 → qz_create 返回 NULL。
     * initial_script（内联 JS）与 initial_script_path（文件，优先）二选一；
     * initial_bytecode 独立叠加——两者都设置时先跑脚本再跑字节码（宿主可
     * 用脚本装 bootstrap，再执行预编译主程序）。字节码由 qz_compile 产出
     * （或与本构建相同的 qjsc -b）；与引擎版本强绑定，跨 qzjs 版本不保证
     * 兼容。各缓冲在 qz_create 返回前保持有效（内部已拷贝）。 */
    const char *initial_script;
    const char *initial_script_path;
    const uint8_t *initial_bytecode;
    size_t         initial_bytecode_len;
    /* 出站消息回调。线程：ISOLATED 编译 = 泵 cfg->uv_loop 的宿主线程（库不再
     * 自带宿主线程；阻塞宿主 API 内部泵时可能重入触发，见 uv_loop 注释）；
     * THREAD 编译 = qzjs 内部线程。必须线程安全。nullptr 表示宿主不接收消息。 */
    void (*message_cb)(qz_t *rt, const char *json, size_t len, void *data);
    int  debug;                      /* 沿用 DAP bit 语义 */
    void *host_data;                 /* per-runtime opaque ptr，可经 qz_get_runtime_data 读取 */
    /* 控制面三档（CTL-0/CTL-2）：OFF（默认，qz_control 恒 -1）/
     * IN_PROC（进程内宿主线程命令）/ LOCAL（IN_PROC + 本机 uv_pipe 端点）。
     * 见 docs/plans/2026-09-04-control-plane-design.md §4.1。 */
    int control_plane;               /* qz_control_plane_t 值 */
    /* LOCAL 档的端点路径（AF_UNIX）。NULL → 缺省 /tmp/qzjs-<pid>-<n>.ctl。
     * 端点文件权限 0600；连接方以 SO_PEERCRED 校验 uid（§2.3 / §4.2）。 */
    const char *control_pipe_path;
    /* Worker 执行后端（M-P1/M-P2 多进程模型 §1.4）。取值语义随编译模型
     * （QZ_PROCESS_MODEL）条件编译——见下方 qz_worker_backend_t 注释。
     * 粒度 per-rt：同一 qz_t 的全部 worker 同后端。M-P1 缺省 THREAD；
     * M-P2 起 ISOLATED 编译缺省 PROCESS（编译模型驱动缺省，§1.4）。 */
    int worker_backend;              /* qz_worker_backend_t 值 */
    /* ISOLATED 编译专用（THREAD 编译忽略）：宿主自己的 uv loop（uv_loop_t*
     * 擦 void* 传入，保本头 uv-free）。库把宿主侧全部句柄（通道读泵 pipe、
     * tx spill 冲刷 timer、wake async）绑到这个 loop 上，message_cb 跑在泵
     * 该 loop 的线程——库不再自带宿主线程与宿主侧 loop。ISOLATED 下 NULL →
     * qz_create 显式失败（不静默降级）。宿主与 libqzjs 必须链接同一个 libuv。
     * 阻塞 API（qz_ping/qz_ping_path/qz_wait_idle/qz_destroy）等待期间就地
     * 泵该 loop（UV_RUN_NOWAIT 轮询）：message_cb 及宿主挂在该 loop 上的
     * 其他回调可能在阻塞调用内部重入触发；规则——message_cb 内不得再调任何
     * 阻塞宿主 API。qz_post_message/qz_control 不受影响（MPSC 入队 +
     * uv_async_send，任意线程可调；实际投递到通道 = 宿主下一次泵）。 */
    const void *uv_loop;
} qz_config_t;

/* 把 JS 源码编译为字节码 blob。独立函数（无需 qz_t/运行时）。
 * 成功返回 0 并写 *out（malloc，用 free() 释放）与 *out_len；
 * 失败返回 -1，*err（若非 NULL）为 malloc 错误串（free() 释放）。
 * filename 仅用于错误定位（栈帧/报错），可 NULL。
 *
 * ⚠ 兼容性：字节码与本次构建的 qzjs（内嵌引擎版本、编译选项）强绑定，
 * 不保证跨 qzjs 版本/跨构建可加载——版本不匹配时运行时会显式报错拒绝。
 * 请在源码分发并在部署环境重编译，仅在受控部署中直接分发字节码。 */
int qz_compile(const char *source, size_t len, const char *filename,
               uint8_t **out, size_t *out_len, char **err);
typedef enum {
    QZ_CONTROL_OFF = 0,     /* 默认：控制面关闭 */
    QZ_CONTROL_IN_PROC = 1, /* 进程内命令（msgq 路径） */
    QZ_CONTROL_LOCAL = 2,   /* IN_PROC + uv_pipe 本地端点（CTL-2） */
} qz_control_plane_t;

/* Worker 执行后端（qz_config_t.worker_backend 取值）。
 *
 * 数值随编译模型条件编译（§2.1「C 枚举字段可以条件编译」），即 memset 清零的
 * 配置在两种编译下各自落到该模型的缺省后端：
 *   ISOLATED 编译：0 = PROCESS（缺省＝独立进程）、1 = THREAD（显式回退）
 *   THREAD  编译：0 = THREAD（现状基线）、1 = PROCESS（未启用 → 求值报错，§1.4）
 *   mock 测试构建（QZ_USE_MOCK_LIBUV，无 ipc 后端）：恒按 THREAD 排列
 * 铁律：只用符号常量，勿硬编码 0/1。消费方必须与库看到同一 QZ_PROCESS_MODEL_*
 * 宏——CMake 构建经 target_compile_definitions(qzjs PUBLIC …) 自动传递。 */
#if defined(QZ_PROCESS_MODEL_ISOLATED) && !defined(QZ_USE_MOCK_LIBUV)
typedef enum {
    QZ_WORKER_BACKEND_PROCESS = 0, /* 编译缺省：独立进程 worker（M-P1 机制） */
    QZ_WORKER_BACKEND_THREAD  = 1, /* 显式回退：真线程 */
} qz_worker_backend_t;
#else
typedef enum {
    QZ_WORKER_BACKEND_THREAD  = 0, /* 缺省：真线程（THREAD 编译 / mock 测试构建） */
    QZ_WORKER_BACKEND_PROCESS = 1, /* 独立进程 worker（THREAD 编译未启用 → 报错） */
} qz_worker_backend_t;
#endif

/* ================================================================
 * Core API
 * ================================================================ */

/* 创建 qzjs。ISOLATED：spawn 主RT 进程 → 握手 → 阻塞等待其 CONTROL{ready}
 * （同步通道读，不泵宿主 loop、不触发 message_cb）→ 通道句柄挂上
 * cfg->uv_loop 就绪返回；cfg->uv_loop 为 NULL 或 ready 失败 → 返回 NULL。
 * THREAD：起内部线程，阻塞到线程 ready；initial_script 在 JS 线程上 eval，
 * 抛异常则返回 NULL。返回的 rt 由宿主线程调用 qz_destroy 销毁。 */
qz_t *qz_create(const qz_config_t *config);

/* 优雅关停：强制终止主RT（进程/线程）→ 回收 → free。ISOLATED 下最坏阻塞 =
 * 主RT 无视 shutdown 的三级终止预算（≤2s）。只允许宿主线程调用，不得在
 * message_cb 内调用（等待时会泵宿主 loop，造成嵌套 uv_run）。 */
void qz_destroy(qz_t *rt);

/* 线程安全入站消息（任何线程可调）。json 会被拷贝。返回 0 成功，-1 失败。 */
int qz_post_message(qz_t *rt, const char *json, size_t len);
/* Request auto-exit once there is no pending async work (CLI use), and block
 * until the main runtime has exited (ISOLATED: the qzjs-rt process; THREAD:
 * the internal thread). ISOLATED 等待期间就地泵 cfg->uv_loop —— message_cb
 * （含崩溃 {"type":"error"} 上报）可能在本调用内部触发；不得从 message_cb
 * 内调用。Thread-safe; mutually exclusive with qz_destroy (call one or the
 * other, never both). After this returns the runtime is torn down and must
 * not be used (no further post_message). Do NOT call qz_destroy after this:
 * destroy forces shutdown and would cancel pending async work (e.g. a live
 * timer). */
void qz_wait_idle(qz_t *rt);

/* Liveness ping（宿主→主RT 进程，ISOLATED 编译）：发 CONTROL ping（corr =
 * 单调 seq）并阻塞等待主RT C 层读泵直回的 PONG（不经 JS/msgq——pong 延迟
 * 只反映主RT 进程 uv loop 的健康度，JS 忙不误报）。等待期间就地泵
 * cfg->uv_loop（PONG 经宿主 loop 读泵回填）；不得从 message_cb 内调用。
 * 返回 0 = loop 通畅（deadline 内 PONG 命中）；1 = 超时 = 对端 loop 阻塞
 * （或对端极度繁忙但读泵 starvation，见设计文档）；-1 = 参数/状态错误
 * （未 ready、正在关停、通道已死——进程死亡另有 EOF 路径）。timeout_ms
 * 建议 100–1000。 */
int qz_ping(qz_t *rt, int32_t timeout_ms);

/* Liveness ping 到树中任意 worker（§8.2 path 寻址，仅 ISOLATED）：path =
 * root-relative 槽位链（同命令面 target_path，如 {1001,1002} = 主RT 的
 * worker 1001 的 sub worker 1002）。返回 0 = 目标 loop 通畅；1 = 超时 =
 * 目标 loop 阻塞；-1 = 参数/状态错误/路径不存在/中间通道死（转发失败由
 * 中间节点回执快速判 -1，不白等 timeout）。PING 按链逐跳下投（读泵 C 层
 * 转发，不消费不进 JS），目标读泵直回 PONG（回显路径作过境标记）沿树上
 * 行；中间节点目标级 JS 零参与。等待期间就地泵 cfg->uv_loop；不得从
 * message_cb 内调用。timeout_ms 建议 100–1000。 */
int qz_ping_path(qz_t *rt, const int32_t *path, int path_len,
                   int32_t timeout_ms);

/* 控制命令入队（线程安全，任何线程可调）。bytes 为命令 JSON，内部拷贝。
 * control_plane=OFF 时恒返回 -1。返回 0 成功，-1 失败（OFF/OOM/参数非法）。
 * 命令由主执行体（ISOLATED = 主RT 进程 / THREAD = qzjs 线程）在自己的事件
 * 循环安全点自主执行；结果经 message_cb 异步回传（ISOLATED = 宿主泵
 * cfg->uv_loop 的线程），回执 JSON 顶层带 "ctl":true 标记位，correl 原样
 * 透传供配对。设计：docs/plans/2026-09-04-control-plane-design.md §1-§3。 */
int qz_control(qz_t *rt, const char *bytes, size_t len);

void *qz_get_runtime_data(qz_t *rt);
void  qz_set_runtime_data(qz_t *rt, void *data);

/* 释放 qz_create 返回的运行时实例（等价 qz_destroy 的最终 free；历史兼容）。
 * ⚠ 仅接受 qz_t 指针——内部按 qz_t 结构释放其 config 缓冲。任意 malloc 块
 * 请用 free()。NULL-safe。 */
void qz_free(void *ptr);

/* ================================================================
 * Extension interface
 * ================================================================ */

typedef struct qz_ext_t qz_ext_t;

struct qz_ext_t {
    const char *name;
    int (*init)(qz_ext_t *ext, qz_t *rt);
    void (*destroy)(qz_ext_t *ext, qz_t *rt);
    int (*suspend)(qz_ext_t *ext, qz_t *rt);
    int (*resume)(qz_ext_t *ext, qz_t *rt);
    void *user_data;
};

/* Forward declaration for JSContext (kept for extension ABI compatibility) */
struct JSContext;

#ifdef __cplusplus
}
#endif

#endif /* QZ_H */
