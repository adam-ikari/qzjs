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
    int  debug;                      /* 沿用 DAP bit 语义 */
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
 * ================================================================
 * 主权原则：qzjs 从不执行宿主代码——库不调用任何宿主回调，公共 API 无函数
 * 指针字段；宿主与库的全部通讯走「邮箱」（见下）+ 入站 API。库完全自主
 * 管理自己的线程与 loop（ISOLATED = 主RT 子进程 + 库内宿主侧泵线程；
 * THREAD = 库内 qzjs 线程）。宿主可把 qzjs 嵌进任何事件系统（poll/epoll/
 * select/自己的线程模型），无 libuv 同链接义务。 */

/* 创建 qzjs。ISOLATED：spawn 主RT 进程 → 库内起宿主侧泵线程 → 阻塞等待
 * 主RT 的 CONTROL{ready}（ready 前到达的消息帧已在 create 返回前重放进邮
 * 箱，宿主第一次 recv 即得）。THREAD：起内部 qzjs 线程，阻塞到线程 ready；
 * initial_script 在 JS 线程上 eval，抛异常则返回 NULL。失败返回 NULL。
 * rt 由调用线程销毁（qz_destroy 或 qz_wait_idle + qz_free）。 */
qz_t *qz_create(const qz_config_t *config);

/* 优雅关停：强制终止主执行体（ISOLATED = 主RT 进程 + 库泵线程；THREAD =
 * 内部线程）→ 回收 → free。ISOLATED 最坏阻塞 = 主RT 无视 shutdown 的三级
 * 终止预算（≤2s，冻结在库线程内处理，调用线程只等收尸）。关停后邮箱中未
 * 消费的消息被释放——如需读取，先 qz_recv_message(rt,NULL,NULL,0) 排干。 */
void qz_destroy(qz_t *rt);

/* 线程安全入站消息（任何线程可调）。json 会被拷贝。返回 0 成功，-1 失败。 */
int qz_post_message(qz_t *rt, const char *json, size_t len);
/* 请求「无待处理异步工作时自动退出」，并阻塞直到主执行体退出（ISOLATED =
 * qzjs-rt 进程 + 库泵线程；THREAD = 内部线程）。等待期间出站消息（含崩溃
 * {"type":"error"} 上报）照常入邮箱，返回后、qz_free 前仍可 qz_recv_message
 * 取净。Thread-safe; mutually exclusive with qz_destroy (call one or the
 * other, never both)。返回后 rt 不得再使用（禁 post）；勿再 qz_destroy：
 * destroy 强制关停会取消 pending 异步工作（如活 timer），只可 qz_free。 */
void qz_wait_idle(qz_t *rt);

/* Liveness ping（宿主→主RT，ISOLATED 编译）：发 CONTROL ping（corr =
 * 单调 seq）并等待主RT C 层读泵直回的 PONG（不经 JS/msgq——pong 延迟只反
 * 映主RT 进程 uv loop 的健康度，JS 忙不误报）。阻塞等待发生在库泵线程，
 * 调用线程仅自旋至回执；邮箱不受影响。
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
 * 行；中间节点目标级 JS 零参与。timeout_ms 建议 100–1000。 */
int qz_ping_path(qz_t *rt, const int32_t *path, int path_len,
                   int32_t timeout_ms);

/* 控制命令入队（线程安全，任何线程可调）。bytes 为命令 JSON，内部拷贝。
 * control_plane=OFF 时恒返回 -1。返回 0 成功，-1 失败（OFF/OOM/参数非法）。
 * 命令由主执行体（ISOLATED = 主RT 进程 / THREAD = qzjs 线程）在自己的事件
 * 循环安全点自主执行；回执异步入邮箱（qz_recv_message 取），JSON 顶层带
 * "ctl":true 标记位，correl 原样透传供配对。
 * 设计：docs/plans/2026-09-04-control-plane-design.md §1-§3。 */
int qz_control(qz_t *rt, const char *bytes, size_t len);

/* ================================================================
 * Mailbox（出站消息邮箱）
 * ================================================================
 * 库 → 宿主方向的全部消息（JS postMessage、崩溃 {"type":"error"} 上报、
 * CONTROL 回执）进入 per-rt 的 FIFO 邮箱；qzjs 不调用任何宿主函数，宿主
 * 自选线程、自选时机消费。json 为 NUL 终止 UTF-8（len 不含终止符）。
 *
 * 消费协议（挂 fd 等待时的唯一正确姿势，防丢唤醒）：
 *   1. qz_recv_message(rt,&json,&len,0) 循环取空并处理；
 *   2. read(qz_message_fd(rt),...) 清计数直到 EAGAIN；
 *   3. 再探一次 qz_recv_message(...,0)——有消息回步骤 1，无才可 poll 阻塞。
 * （先清箱后清 fd 再复核：入箱先于写 fd，此序保证不丢唤醒。）
 *
 * 单消费者规则：同一 rt 的 qz_recv_message 允许多线程并发轮询消费（timeout
 * 0/正值均可，锁-free 弹出互斥），但同一时刻只应有一个线程做「fd 等待协
 * 程」；跨线程分发由宿主自行保证消息所有权移交。
 * 未消费的消息在 qz_destroy/qz_free 时释放（不泄漏，也不再可达）。
 * out fd 归 rt 所有：宿主不得 close；qz_free 后 fd 失效。
 * Linux-only（eventfd）。 */

/* 从邮箱取出一条消息。timeout_ms：0 = 纯轮询不等待；>0 = 至多等待该时长；
 * -1 = 无限等待。返回 0 = 取到（*json 为 malloc 缓冲，用 qz_free_message 释
 * 放）；1 = 超时（*json 不变）；-1 = 参数/状态错误。 */
int qz_recv_message(qz_t *rt, char **json, size_t *len, int timeout_ms);

/* 释放 qz_recv_message 返回的消息缓冲。NULL-safe。 */
void qz_free_message(void *json);

/* 返回该 rt 邮箱的唤醒 fd（eventfd，单调计数；非阻塞读、CLOEXEC）。
 * 与宿主自己的 poll/epoll/select/kevent（自行适配）一起等待；0 条可读时
 * read 返回 EAGAIN。等待本体在 qz_recv_message 内部已用之——宿主仅在
 * 「自己组织事件循环」时需要。失败（极少）返回 -1。 */
int qz_message_fd(qz_t *rt);

/* 释放对象（NULL-safe）。双角色：传入 qz_create 的 rt（已 qz_wait_idle 收束、
 * 或已 qz_destroy 之外的路径）→ 排干邮箱、关闭唤醒 fd、释放 config 缓冲与
 * rt；传入 qz_compile 等产出的裸 malloc 块 → 直接 free。内部按 magic 判别。 */
void qz_free(void *ptr);

/* ================================================================
 * Extension interface
 * ================================================================ */

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
