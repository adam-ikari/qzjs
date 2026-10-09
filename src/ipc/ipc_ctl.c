/*
 * qzjs IPC CONTROL 协议分类（§6.1）——通道层保留命名空间的唯一裁决点
 *
 * 「payload 顶层带数字 "qzjs" 键」= 通道层系统 CONTROL（ready / idle /
 * shutdown / ping / pong / pfail，以及 M-P4 closing 等未知系统消息），不
 * 进控制面命令路由器。这个判据被两处消费：
 *   - src/host/rt_main.c 收帧分流：SYSTEM 家族就地消费（不进 msgq/JS），其余路由；
 *   - src/control/control.c 的 qz_control_sink 入口：带该键的用户命令显式拒收，
 *     否则命令会静默消失（没有回执、没有错误）。
 *
 * 独立成文件而不是放进 ipc_process.c：本翻译单元是纯 payload 分类（cJSON +
 * 键名比对，不碰 libuv、不碰进程句柄），而 ipc_process.c 在 mock 测试构建
 * （QZ_BUILD_TESTS=ON）里整文件不编——放那儿会让这个判据在测试构建里凭空
 * 消失，两处守卫各写各的、迟早分叉。也没塞进 ipc_envelope.c：那个文件是
 * 协议编解码的最底层，被 test/ipc_envelope_cli.c 以「只给 -I src、零依赖」
 * 的方式单独编译，拖进 ipc_process.h 就等于拖进 libuv。
 */
#include "ipc_process.h"

#include <string.h>
#include <cJSON.h>

/* ── M-P2 主RT 通道 CONTROL 协议分类（§6.1，两侧共用） ── */

qz_ipc_ctl_kind_t qz_ipc_ctl_classify(const uint8_t *payload,
                                          uint32_t len, int *out_val)
{
    if (!payload || len == 0) return QZ_IPC_CTL_NONE;

    /* cJSON 按 NUL 结尾扫描，payload 是零拷贝片（rbuf 内），补一份带 NUL 的
     * 副本再解析。CONTROL 消息都很小（<64B），一次性栈缓冲足够。 */
    char buf[256];
    if (len >= sizeof(buf)) return QZ_IPC_CTL_NONE;
    memcpy(buf, payload, len);
    buf[len] = '\0';

    cJSON *j = cJSON_Parse(buf);
    if (!j) return QZ_IPC_CTL_NONE;
    qz_ipc_ctl_kind_t kind = QZ_IPC_CTL_NONE;
    if (cJSON_IsNumber(cJSON_GetObjectItemCaseSensitive(j, "qzjs"))) {
        const cJSON *ready = cJSON_GetObjectItemCaseSensitive(j, "ready");
        const cJSON *idle  = cJSON_GetObjectItemCaseSensitive(j, "idle");
        const cJSON *sd    = cJSON_GetObjectItemCaseSensitive(j, "shutdown");
        if (cJSON_IsNumber(ready)) {
            kind = QZ_IPC_CTL_READY;
            *out_val = ready->valueint;
        } else if (cJSON_IsNumber(idle)) {
            kind = QZ_IPC_CTL_IDLE;
            *out_val = idle->valueint;
        } else if (cJSON_IsNumber(sd)) {
            kind = QZ_IPC_CTL_SHUTDOWN;
            *out_val = sd->valueint;
        } else if (cJSON_IsNumber(cJSON_GetObjectItemCaseSensitive(j, "ping"))) {
            /* liveness 探测：宿主→对端。对端 C 层读回调识别后直回 PONG。 */
            kind = QZ_IPC_CTL_PING;
            *out_val = 1;
        } else if (cJSON_IsNumber(cJSON_GetObjectItemCaseSensitive(j, "pong"))) {
            /* liveness 应答：对端读回调回显 corr（= ping seq）。 */
            kind = QZ_IPC_CTL_PONG;
            *out_val = 1;
        } else if (cJSON_IsNumber(
                       cJSON_GetObjectItemCaseSensitive(j, "pfail"))) {
            /* 跨层 ping 转发失败：中间节点回 corr=seq（宿主快速 -1）。 */
            kind = QZ_IPC_CTL_PFAIL;
            *out_val = 1;
        } else {
            /* 带 "qzjs" 标记但非 ready/idle/shutdown（M-P4 closing 等）：
             * 通道级系统消息，交通道层消费，不被当作控制面命令路由。 */
            kind = QZ_IPC_CTL_SYSTEM;
        }
    }
    cJSON_Delete(j);
    return kind;
}
