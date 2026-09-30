// CONTROL payload 分类（src/ipc_ctl.c）单元测试
//
// 「payload 顶层带数字 "qzjs" 键」= 通道层系统 CONTROL 的保留命名空间，这个
// 判据有两处消费：rt_main.c 收帧分流（SYSTEM 家族就地消费，其余路由）与
// control.c 的 qz_control 入口（带该键的用户命令显式拒收）。两处必须共用同一
// 判据——判据本身没有直接覆盖时，某个构建里它悄悄消失或语义漂移都没人发现
// （历史上正是「双调用 + 谓词过宽」让 M-P7 箱净门形同虚设）。
//
// 本文件锁住：系统家族逐个命中、out_val 取值、保留命名空间的边界（键缺失 /
// 非数字 / 非法 JSON / 超长 / 空）、以及 SYSTEM 兜底（带 qzjs 但不属于任何
// 已知家族 → SYSTEM，绝不落回 NONE 去当用户命令路由）。

#include "ipc_process.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

// classify 一段 C 字符串形式的 payload（内部按 (bytes, len) 传，不依赖 NUL）。
int classify(const char *json, int *out_val = nullptr) {
    int local = 0;
    int kind = qz_ipc_ctl_classify(reinterpret_cast<const uint8_t *>(json),
                                   static_cast<uint32_t>(std::strlen(json)),
                                   out_val ? out_val : &local);
    return kind;
}

TEST(IpcCtl, SystemFamilyHitsWithValue) {
    int v = 0;
    EXPECT_EQ(classify("{\"qzjs\":1,\"ready\":1}", &v), QZ_IPC_CTL_READY);
    EXPECT_EQ(v, 1);
    v = 0;
    EXPECT_EQ(classify("{\"qzjs\":1,\"idle\":1}", &v), QZ_IPC_CTL_IDLE);
    EXPECT_EQ(v, 1);
    v = 0;
    EXPECT_EQ(classify("{\"qzjs\":1,\"shutdown\":1}", &v), QZ_IPC_CTL_SHUTDOWN);
    EXPECT_EQ(v, 1);
    // 关闸位本身要透传（0 与 1 语义不同：0 = 不关）。
    v = -1;
    EXPECT_EQ(classify("{\"qzjs\":1,\"shutdown\":0}", &v), QZ_IPC_CTL_SHUTDOWN);
    EXPECT_EQ(v, 0);
}

TEST(IpcCtl, LivenessFamilyAlwaysValOne) {
    int v = 0;
    EXPECT_EQ(classify("{\"qzjs\":1,\"ping\":7}", &v), QZ_IPC_CTL_PING);
    EXPECT_EQ(v, 1);
    v = 0;
    EXPECT_EQ(classify("{\"qzjs\":1,\"pong\":3}", &v), QZ_IPC_CTL_PONG);
    EXPECT_EQ(v, 1);
    v = 0;
    EXPECT_EQ(classify("{\"qzjs\":1,\"pfail\":9,\"corr\":9}", &v), QZ_IPC_CTL_PFAIL);
    EXPECT_EQ(v, 1);
}

// 跨层形态：PING/PONG 带 "tp" 过境标记，分类不得因多一个字段而改变。
TEST(IpcCtl, CrossLayerTpDoesNotChangeClassification) {
    EXPECT_EQ(classify("{\"qzjs\":1,\"ping\":1,\"tp\":[1001,1002]}"),
              QZ_IPC_CTL_PING);
    EXPECT_EQ(classify("{\"qzjs\":1,\"pong\":1,\"tp\":[1001]}"),
              QZ_IPC_CTL_PONG);
}

// 保留命名空间的兜底：带数字 qzjs 但不属于任何已知家族（M-P4 closing 等）。
// 必须是 SYSTEM —— 落回 NONE 会被当用户命令路由进控制面，系统消息与用户命令
// 两条路互相污染。
TEST(IpcCtl, ReservedNamespaceFallsBackToSystemNotNone) {
    EXPECT_EQ(classify("{\"qzjs\":1,\"closing\":1}"), QZ_IPC_CTL_SYSTEM);
    EXPECT_EQ(classify("{\"qzjs\":1}"), QZ_IPC_CTL_SYSTEM);
    EXPECT_EQ(classify("{\"qzjs\":42,\"brand-new\":true}"), QZ_IPC_CTL_SYSTEM);
}

// ready 优先于同帧的其它系统键（顺序即优先级：握手先于一切）。
TEST(IpcCtl, ReadyWinsOverOtherSystemKeys) {
    int v = 0;
    EXPECT_EQ(classify("{\"qzjs\":1,\"ready\":1,\"ping\":5}", &v),
              QZ_IPC_CTL_READY);
    EXPECT_EQ(v, 1);
}

// 非保留命名空间 = 用户命令面，一律 NONE。
TEST(IpcCtl, UserCommandsAreNone) {
    EXPECT_EQ(classify("{\"cmd\":\"eval\",\"code\":\"2+2\"}"), QZ_IPC_CTL_NONE);
    EXPECT_EQ(classify("{\"op\":\"metrics\"}"), QZ_IPC_CTL_NONE);
    EXPECT_EQ(classify("{}"), QZ_IPC_CTL_NONE);
    // qzjs 存在但不是数字 → 不算保留命名空间（type 判据是「数字」）。
    EXPECT_EQ(classify("{\"qzjs\":\"1\",\"ready\":1}"), QZ_IPC_CTL_NONE);
    // 嵌套位置的 qzjs 不算顶层键。
    EXPECT_EQ(classify("{\"cmd\":\"x\",\"nested\":{\"qzjs\":1}}"),
              QZ_IPC_CTL_NONE);
}

// 退化输入：空、NULL、非 JSON、超长（> 栈缓冲 256B）都判 NONE 而不是崩。
TEST(IpcCtl, DegenerateInputIsNoneNotCrash) {
    int v = 0;
    EXPECT_EQ(qz_ipc_ctl_classify(nullptr, 0, &v), QZ_IPC_CTL_NONE);
    EXPECT_EQ(classify("", &v), QZ_IPC_CTL_NONE);
    EXPECT_EQ(classify("not json at all", &v), QZ_IPC_CTL_NONE);
    EXPECT_EQ(classify("{\"qzjs\":1,", &v), QZ_IPC_CTL_NONE);

    // 超长：classify 早退 NONE（不进栈缓冲），因此 rt_main 侧也不会把它当系统
    // 消息吞掉——超长 payload 走用户命令路径，不会黑洞。
    std::string big = "{\"qzjs\":1,\"pad\":\"";
    big.append(512, 'x');
    big += "\"}";
    EXPECT_GT(big.size(), 256u);
    EXPECT_EQ(classify(big.c_str()), QZ_IPC_CTL_NONE);
}

// payload 未必 NUL 结尾（rt_main 传的是 rbuf 零拷贝片）——按 (bytes, len)
// 读，且只读 len 字节。
TEST(IpcCtl, ReadsExactlyLenBytesFromNonNulTerminatedBuffer) {
    // {"qzjs":1,"ready":1} 恰 20 字节，后面跟的垃圾不得进解析。
    const char raw[] = "{\"qzjs\":1,\"ready\":1}TRAILING-GARBAGE";
    int v = 0;
    EXPECT_EQ(qz_ipc_ctl_classify(reinterpret_cast<const uint8_t *>(raw), 20, &v),
              QZ_IPC_CTL_READY);
    EXPECT_EQ(v, 1);
    // 截断到 18 字节（少了 "1}"）→ JSON 不完整 → NONE。证明它按 len 读，
    // 而不是「读到 NUL 为止」把后面的垃圾也吞进来。
    v = 0;
    EXPECT_EQ(qz_ipc_ctl_classify(reinterpret_cast<const uint8_t *>(raw), 18, &v),
              QZ_IPC_CTL_NONE);
}

}  // namespace
