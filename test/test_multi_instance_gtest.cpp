// test_multi_instance_gtest.cpp — M-R1 多实例生命周期回归（§13/§13.4）
//
// 一个宿主进程内 N 个 qz_t 并存（各自 qz_create/destroy 独立生命周期，
// 互不知晓）。M-R1 不是新机制，是审计 + 约束声明 + 回归证明：
//   1. 双实例交错 eval/postMessage 互不串扰；一个 destroy 后另一个继续收发。
//   2. wait_idle → destroy 序列不重 join 已退出的线程（双重 pthread_join UB；
//      M-R1 G2 修复：thread_joined 跟踪）。
//   3. port id 跨实例全局唯一（进程级原子计数器，bridge.c g_qz_next_port_id）。
//   4. 全局状态审计表见 src/qz_internal.h（M-R1 §13.2）。
//
// DAP stdio 单通道约束的第二实例拒绝回归在 test_dap_gtest.cpp
// （DapDebugger.StdioConflictSecondInstanceRejected，随 QZ_BUILD_DEBUGGER 构建）。
#include "test_host.h"

#ifdef QZ_USE_MOCK_LIBUV
#include "base/qz_rt.h"
#endif
#include <string>

// 1) 双实例交错 eval（eval 即 postMessage→message_cb 通路）：各自的
//    globalThis 独立；一个 destroy 后另一个继续收发。
TEST(multi_instance, interleaved_lifecycle_no_crosstalk)
{
    HostCtx *a = host_create();
    HostCtx *b = host_create();
    ASSERT_NE(nullptr, a);
    std::string va, vb;
    // 各自的全局状态互不可见（独立 JSRuntime）
    ASSERT_TRUE(host_value(a, "globalThis.__mri__ = 1; globalThis.__mri__", &va));
    ASSERT_TRUE(host_value(b, "globalThis.__mri__ = 2; globalThis.__mri__", &vb));
    EXPECT_EQ("1", va);
    EXPECT_EQ("2", vb);

    // 交错推进，状态各自单调
    ASSERT_TRUE(host_value(a, "++globalThis.__mri__", &va));
    ASSERT_TRUE(host_value(b, "++globalThis.__mri__", &vb));
    EXPECT_EQ("2", va);
    EXPECT_EQ("3", vb);

    // 销毁 a，b 继续正常收发（§13.4：一个 destroy 后另一个继续）
    host_destroy(a);
    ASSERT_TRUE(host_value(b, "globalThis.__mri__ * 10", &vb));
    EXPECT_EQ("30", vb);
    host_destroy(b);
}

// 2) wait_idle → destroy：join 恰好一次。修复前 destroy 会对已 join 的
//    句柄再跑一次 uv_thread_join（裸 pthread_join，UB——glibc 上通常表现为
//    ESRCH/EINVAL，句柄内存可能已随线程描述符释放）。
TEST(multi_instance, wait_idle_then_destroy_joins_once)
{
    HostCtx *h = host_create();
    std::string v;
    ASSERT_TRUE(host_value(h, "40+2", &v));
    EXPECT_EQ("42", v);

    qz_wait_idle(h->rt);   // 线程 idle 自退 + join
#ifdef QZ_USE_MOCK_LIBUV
    EXPECT_EQ(1, __atomic_load_n(&h->rt->thread_joined, __ATOMIC_ACQUIRE));
#endif
    host_destroy(h);         // 修复前：对已退出线程二次 join（UB）
}

// 3) port id 跨实例全局唯一：分配器是进程级原子计数器，多实例并发
//    portCreate 不得撞号（id 撞号 = 消息路由错投）。
TEST(multi_instance, port_ids_unique_across_instances)
{
    HostCtx *a = host_create();
    HostCtx *b = host_create();
    ASSERT_NE(nullptr, a);
    ASSERT_NE(nullptr, b);

    std::string va, vb;
    ASSERT_TRUE(host_value(a, "globalThis.__native__.portCreate().id1", &va));
    ASSERT_TRUE(host_value(b, "globalThis.__native__.portCreate().id1", &vb));
    EXPECT_FALSE(va.empty());
    EXPECT_FALSE(vb.empty());
    EXPECT_NE(va, vb);   // 全局唯一

    host_destroy(a);
    host_destroy(b);
}
