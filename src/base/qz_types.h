/* qzjs 内部类型层：平台头、常量、错误码、IO 回调、worker/进程句柄类型。
 *
 * 本头只含「不依赖 qz_t 布局」的基础类型与宏；运行时对象（struct qz_t、
 * qz_ctx_t）与内部函数原型分别在 qz_core.h / qz_rt.h。C++ 测试经 extern "C"
 * 调用时保持 C 符号。 */
#ifndef QZ_TYPES_H
#define QZ_TYPES_H

#include "qzjs/qzjs.h"
/* qz_proc_t 前置声明（ipc_process.h 全量 include 仅 worker.c 进程后端代码
 * 需要；这里只用指针。直接 include 会把 uv_pipe_t 拉进 mock 测试构建——
 * mock_libuv.h 无该类型。与 ipc_process.h 共用 guard：重复 typedef 在
 * -Wpedantic 下是错误。 */
#ifndef QZ_PROC_T_DEFINED
#define QZ_PROC_T_DEFINED
typedef struct qz_proc_s qz_proc_t;
#endif
typedef struct qz_ctx_s qz_ctx_t;   /* 前置声明：qz_proc_handle_t 用指针 */
#include <quickjs.h>

/* libuv include switch: qzjs embeds uv types (uv_loop_t etc.) BY VALUE in
 * qz_t, so the compiled struct layout must match the uv implementation
 * that the host links against. Test builds compile against mock_libuv.h
 * (deterministic offline scheduler); production builds use real libuv's
 * uv.h. The public qzjs.h stays uv-free — this switch is internal only. */
#ifdef QZ_USE_MOCK_LIBUV
#include "mock_libuv.h"
#else
#include <uv.h>
#endif

/* 句柄统一挂 rt 内嵌自持 loop（M-P7 主权裁决：库自管全部线程与 loop，
 * 宿主不注入任何东西，qzjs.h 保持 uv-free）。 */
#define RT_LOOP(rt) (&(rt)->loop)

/* C 层 JSON 一律用 vendored cJSON（<cjson.h>，deps/cjson/）——使用方
 * （control.c / ipc_process.c / debugger_dap.c）各自 include。 */
#include <stdint.h>
#include <time.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>   /* qz_close_loop 的诊断输出 */

/* libuv's intrusive queue primitives (uv__queue). Used by msgq.c as the
 * lock-free MPSC container; also needed for the qz_msg_t layout above. */
#include "queue.h"

/* Maximum concurrent timer/PAL-async handles. 256 slots balances memory
 * (qz_t grows by ~8 KB per 128 slots) against the rare case of
 * hundreds of overlapping timers or I/O operations.  When the table is
 * full, timer_start returns a RangeError. */
#define QZ_MAX_HANDLES 256

/* Maximum number of concurrent contexts per runtime. */
#define QZ_MAX_CONTEXTS 64

/* Maximum concurrent Web Workers per runtime (Task 4). A worker's id is its
 * slot index + 1 (id 0 is reserved for the host source), and tags inbound
 * messages (source = worker id, so source > 0 always means "from a worker"). */
#define QZ_MAX_WORKERS 16

/* Magic sentinel for qz_t validation — "AM" in ASCII */
#define QZ_MAGIC 0x51575254U

/* Polyfill embedding mode constants (QZ_POLYFILL_MODE compile definition).
 * 0 = rodata (const array in .rodata, default) | 1 = compressed (zlib array
 * → heap decompress at load) | 2 = external (external .polyfill file) |
 * 3 = host (host provides bytecode via qz_polyfill_load_custom()). */
#define QZ_POLYFILL_MODE_RODATA     0
#define QZ_POLYFILL_MODE_COMPRESSED 1
#define QZ_POLYFILL_MODE_EXTERNAL   2
#define QZ_POLYFILL_MODE_HOST       3
#ifndef QZ_POLYFILL_MODE
#define QZ_POLYFILL_MODE QZ_POLYFILL_MODE_RODATA
#endif

/* Silence -Wunused-parameter for fixed-signature callbacks (e.g. QuickJS
 * JSCFunction prototypes require this_val/argc/argv even when unused). */
#define QZ_UNUSED(x) ((void)(x))


/* ── I/O error codes (used by uv_io.c / bridge) ── */

typedef enum {
    QZ_OK                 =  0,
    QZ_ERR_GENERIC        = -1,
    QZ_ERR_NOT_FOUND      = -2,
    QZ_ERR_IO             = -3,
    QZ_ERR_PERMISSION     = -4,
    QZ_ERR_NETWORK        = -5,
    QZ_ERR_INVALID_ARG    = -6,
    QZ_ERR_CANCELLED      = -7,
    QZ_ERR_BUSY           = -8,
    QZ_ERR_NOT_SUPPORTED  = -9,
    QZ_ERR_TIMEOUT        = -10,
    QZ_ERR_NO_MEMORY      = -11,
} qz_err_t;

/* Async I/O completion callback: status is 0 (OK) or a qz_err_t,
 * result/len hold an optional JSON/C-string payload. */
typedef void (*qz_io_done_t)(void *opaque, int status,
                               const char *result, size_t len);

/* Streaming HTTP response callbacks (uv_io_http_request_stream). */
typedef struct qz_io_stream_ops_s {
    void (*on_headers)(void *user_data, int status, const char *headers_json);
    void (*on_data)(void *user_data, const char *data, size_t len);
    /* error_msg: human-readable diagnostic for error_status != 0 (e.g.
     * "TLS certificate verification failed", mbedtls_strerror text). Owned by
     * the callee — the pointer is only valid for the duration of the call, so
     * consumers must copy it if they keep it. NULL when there is no message
     * (success path, or a site that has nothing better than the code).
     *
     * Why this exists: error_status alone collapses every distinct failure
     * into the same opaque number. fetch's JS layer only ever saw -5
     * (QZ_ERR_NETWORK) for "connection refused", "TLS init failed",
     * "certificate verification failed" and "mbedtls handshake error
     * -0x7880" alike — making these undiagnosable from outside the library. */
    void (*on_end)(void *user_data, int error_status, const char *error_msg);
    void *user_data;
} qz_io_stream_ops_t;

/* Forward declarations */
struct qz_ext_t;

/* Web Worker (Task 4): worker = 独立 qz_t（自己的线程 + JSRuntime + loop）。
 * id = 槽位索引 + 1（0 保留给宿主 source，source>0 恒为 worker），所以
 * 入站消息用 source 标签即可区分宿主 / worker，无需额外字段。定义放这里：
 * bridge.c / qzjs.c（teardown）都要解引用 w->parent / w->id / w->thread。 */
typedef struct qz_worker_s {
    qz_t *parent;            /* 父 runtime（worker 的 JS 线程就是父线程） */
    int id;                    /* 槽位索引 + 1 = 消息 source 标签 */
    uv_thread_t thread;        /* worker 线程句柄（父 teardown 时 join） */
    qz_t *self;              /* worker 自己的 runtime（线程后端） */
    char *script;              /* worker 脚本源码 */
    int shutting_down;         /* 非 0 = 已请求退出：父线程回收槽位（worker.c
                               * qz_worker_reap：join→释放 runtime→清槽）的判据 */
    /* atomic: 1 = worker 自己的 loop 上仍有在途异步工作。父的 wait_idle 判定
     * （qz_loop_idle）据此不把父判为 idle —— worker 的 loop 独立于父 rt，
     * 父 loop 空闲完全看不到 worker 内的 fetch/timer。
     *
     * 只由 worker 线程写、父线程原子读：worker 在**自己线程上**调
     * qz_loop_idle(w->self) 算出布尔再发布，父绝不跨线程遍历 worker 的 loop
     * 或碰它的 JS（那是 worker 线程的独占所有权，跨线程访问是竞态）。
     *
     * 生命周期：spawn 时置 1（worker 从创建起就在干活，boot 期间也必须算忙），
     * 退出循环前清 0 —— 否则父会永远等一个已经结束的 worker。 */
    int busy;
    /* 注：进程后端（M-P1 的 qz_proc_t proc / script_path 字段）已随 spawn
     * 分层化移除（Phase C）——PROCESS worker 由 JS 层经 pal.processSpawn 封装，
     * C 层 qz_worker_t 仅服务线程后端。 */
} qz_worker_t;

#ifndef QZ_USE_MOCK_LIBUV
/* pal.processSpawn 句柄注册表（spawn 分层化, Phase B）。processSpawn 返回
 * 整数 handle id，JS 侧用它驱动 processPost / processOnMessage /
 * processTerminate；显式生命周期（terminate 释放），无需 GC finalizer。
 * 注册表内嵌在 qz_t（每个 runtime 至多 QZ_MAX_PROC_HANDLES 个并发
 * 进程句柄）；mock 构建无 ipc_process.c，此类型不编入。 */
typedef struct qz_proc_handle_s {
    int          id;        /* opaque handle id (>0) */
    qz_proc_t *proc;      /* IPC 通道句柄 */
    qz_ctx_t  *ctx;       /* 注册回调所在 context（JS_Call 用） */
    JSValue      onmsg;     /* JS 回调函数，未注册 = JS_UNDEFINED */
    uint8_t      live;      /* 1 = 已分配 */
} qz_proc_handle_t;
#define QZ_MAX_PROC_HANDLES 64
#endif
/* §8.2 path 链最大深度（rt 树层级上限；u16 元素，超出 65535 升 u32）。 */
#define QZ_SELF_PATH_MAX 8

#endif /* QZ_TYPES_H */
