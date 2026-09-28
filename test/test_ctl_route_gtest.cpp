// test_ctl_route_gtest.cpp — CTL-1 信封 CONTROL 树路由测试
//
// 覆盖：逐跳相对寻址决策（命中本地 / 上行 / 下行槽位 / 非法丢弃）、三层树
// （宿主 0 → 主RT 1 → worker K）请求与回执的逐跳路径、信封编解码的 payload
// 字节零改写透传（correl 随 payload 透传）、命令 JSON 的 target 字段提取、
// OFF 档入站丢弃、命中本地时命令确实被 dispatch 执行。
// 真实进程树的跨进程端到端由 test/test_ctl_e2e.sh 覆盖（control-plane-design
// §6 CTL-1/CTL-2 验证门）。
#include "test_host.h"
#include "ipc_envelope.h"
#include <cstring>

/* ── 1. 路由决策（纯函数，无副作用） ── */

TEST(ctl_route, decide_local_when_target_is_self) {
    /* target == 本节点槽位 id → 命中本地（入 msgq 交 dispatch）。 */
    EXPECT_EQ(QZ_CTL_ROUTE_LOCAL, qz_ctl_route_decide(1, 1));   /* 主RT */
    EXPECT_EQ(QZ_CTL_ROUTE_LOCAL, qz_ctl_route_decide(5, 5));   /* worker */
    EXPECT_EQ(QZ_CTL_ROUTE_LOCAL, qz_ctl_route_decide(0, 0));   /* 宿主 */
}

TEST(ctl_route, decide_up_for_rootward_targets) {
    /* 0/1 且非本地 → 朝根方向上行（父/宿主）。 */
    EXPECT_EQ(QZ_CTL_ROUTE_UP, qz_ctl_route_decide(1, 0));
    EXPECT_EQ(QZ_CTL_ROUTE_UP, qz_ctl_route_decide(5, 0));
    EXPECT_EQ(QZ_CTL_ROUTE_UP, qz_ctl_route_decide(5, 1));
    EXPECT_EQ(QZ_CTL_ROUTE_UP, qz_ctl_route_decide(7, 1));
}

TEST(ctl_route, decide_down_for_child_slot) {
    /* >1 且非本地 → 下行到本地子槽位（多跳路径编码不做：单跳相对地址）。 */
    EXPECT_EQ(QZ_CTL_ROUTE_DOWN, qz_ctl_route_decide(1, 2));
    EXPECT_EQ(QZ_CTL_ROUTE_DOWN, qz_ctl_route_decide(1, 5));
    EXPECT_EQ(QZ_CTL_ROUTE_DOWN, qz_ctl_route_decide(3, 9));
}

TEST(ctl_route, decide_drop_for_invalid_target) {
    /* 负数 target：无此地址（§4.3 明确不做 -1 广播）。 */
    EXPECT_EQ(QZ_CTL_ROUTE_DROP, qz_ctl_route_decide(1, -1));
    EXPECT_EQ(QZ_CTL_ROUTE_DROP, qz_ctl_route_decide(5, -3));
}

/* ── 2. 三层树（宿主 → 主RT → worker）逐跳路径 ── */

TEST(ctl_route, three_level_request_reaches_worker_slot) {
    /* 宿主填 target=5：单跳相对语义下它表达"接收方（主RT）的子槽位 5"。
     * 主RT 下行（target 保持 5），worker（槽位 id 5）命中自身。 */
    const int32_t t = 5;
    EXPECT_EQ(QZ_CTL_ROUTE_DOWN, qz_ctl_route_decide(1, t));
    EXPECT_EQ(QZ_CTL_ROUTE_LOCAL, qz_ctl_route_decide(5, t));
}

TEST(ctl_route, three_level_reply_hops_back_to_host) {
    /* worker 的回执 target = 命令来源地址（宿主 0）→ 主RT 继续上行 →
     * 宿主（id 0）命中本地，经 message_cb 交还宿主。 */
    EXPECT_EQ(QZ_CTL_ROUTE_UP, qz_ctl_route_decide(5, 0));
    EXPECT_EQ(QZ_CTL_ROUTE_LOCAL, qz_ctl_route_decide(0, 0));
}

TEST(ctl_route, reply_to_parent_when_request_came_from_mainrt) {
    /* 命令 source=1（主RT 内部下发）→ worker 回执 target=1，主RT 本地消费。 */
    EXPECT_EQ(QZ_CTL_ROUTE_UP, qz_ctl_route_decide(5, 1));
    EXPECT_EQ(QZ_CTL_ROUTE_LOCAL, qz_ctl_route_decide(1, 1));
}

/* ── 3. 信封编解码：信封头逐跳改写，payload 字节不动 ── */

TEST(ctl_route, envelope_roundtrip_preserves_headers_and_payload) {
    const char *cmd = "{\"op\":\"metrics\",\"correl\":\"c42\",\"target\":5}";
    uint32_t len = (uint32_t)strlen(cmd);
    uint8_t buf[256];
    size_t n = ipc_envelope_encode(buf, sizeof buf, 0, 5, IPC_ENV_KIND_CONTROL,
                                   0 /* corr */,
                                   (const uint8_t *)cmd, len);
    ASSERT_EQ(IPC_ENVELOPE_ENCODED_SIZE(len), n);
    ipc_envelope_view_t v;
    ASSERT_EQ(0, ipc_envelope_decode(buf, n, &v));
    EXPECT_EQ(0, v.source);
    EXPECT_EQ(5, v.target);
    EXPECT_EQ(IPC_ENV_KIND_CONTROL, v.kind);
    ASSERT_EQ(len, v.payload_len);
    EXPECT_EQ(0, memcmp(v.payload, cmd, len));   /* correl 随 payload 原样透传 */
}

/* ── 4. 命令 JSON 的寻址字段提取（C 层，无 JSContext） ── */

TEST(ctl_route, cmd_target_field_defaults_to_self) {
    const char *with_t = "{\"op\":\"metrics\",\"target\":7}";
    EXPECT_EQ(7, qz_ctl_cmd_target(with_t, strlen(with_t)));
    const char *without = "{\"op\":\"metrics\",\"correl\":\"x\"}";
    EXPECT_EQ(1, qz_ctl_cmd_target(without, strlen(without)));  /* 缺省 1=主RT */
    const char *bad = "{not json";
    EXPECT_EQ(1, qz_ctl_cmd_target(bad, strlen(bad)));
}

/* ── 5. OFF 档：信封 CONTROL 命令入站即丢弃（§4.1） ── */

static HostCtx *host_create_ctl_plane(int plane) {
    auto *h = new HostCtx();
    qz_config_t cfg = {};
    cfg.initial_script = kTestBootstrap;
    cfg.control_plane = plane;
    h->rt = qz_create(&cfg);
    if (!h->rt) {
        delete h;
        return nullptr;
    }
    return h;
}

TEST(ctl_route, off_plane_drops_inbound_envelope) {
    HostCtx *h = host_create_ctl_plane(QZ_CONTROL_OFF);
    ASSERT_NE(nullptr, h);
    const char *cmd = "{\"op\":\"metrics\",\"correl\":\"off-1\"}";
    EXPECT_EQ(-1, qz_control_route(h->rt, 1, 0, 1,
                                     (const uint8_t *)cmd,
                                     (uint32_t)strlen(cmd)));
    host_destroy(h);
}

/* ── 6. 命中本地：命令确实被 dispatch 执行 ── */

TEST(ctl_route, local_hit_dispatches_command) {
    HostCtx *h = host_create_ctl_plane(QZ_CONTROL_IN_PROC);
    ASSERT_NE(nullptr, h);
    /* target == 本地（主RT 槽位 1）→ 入 msgq（flags=CONTROL）→ wake 分流点
     * dispatch。eval 的 postMessage 副作用经 message_cb 可见，证明命令真的
     * 被执行（而非仅入队）。 */
    const char *cmd =
        "{\"op\":\"eval\",\"correl\":\"ctl-1\","
        "\"script\":\"postMessage(\\\"ctl-route-hit\\\")\"}";
    EXPECT_EQ(0, qz_control_route(h->rt, 1, 0, 1,
                                    (const uint8_t *)cmd,
                                    (uint32_t)strlen(cmd)));

    bool seen = false;
    for (int i = 0; i < 100 && !seen; i++) {
        std::string raw;
        if (!host_wait_msg(h, &raw, 100)) continue;
        if (raw.find("ctl-route-hit") != std::string::npos) seen = true;
    }
    EXPECT_TRUE(seen);
    host_destroy(h);
}

/* ── 7. §8.2 path 链寻址：首跳提取（宿主侧装信封用；N-P3） ──
 * 命令 JSON 带 target_path 时，信封 target 必须是路径首元素（根的直接子槽位）——
 * 后续各跳由 qz_control_route 按各节点自身深度重写。无 target_path 时保持
 * 旧单跳相对语义，扁平拓扑零改动。 */

TEST(ctl_route, cmd_target_prefers_target_path_head) {
    const char *cmd =
        "{\"op\":\"eval\",\"correl\":\"c1\",\"target\":1,"
        "\"target_path\":[1001,1002],\"script\":\"1\"}";
    EXPECT_EQ(1001, qz_ctl_cmd_target(cmd, strlen(cmd)));
}

TEST(ctl_route, cmd_target_falls_back_to_scalar_target) {
    const char *with_t = "{\"op\":\"eval\",\"target\":7}";
    EXPECT_EQ(7, qz_ctl_cmd_target(with_t, strlen(with_t)));
    const char *no_t = "{\"op\":\"metrics\"}";
    EXPECT_EQ(1, qz_ctl_cmd_target(no_t, strlen(no_t)));   /* 缺省 = 主RT */
    EXPECT_EQ(1, qz_ctl_cmd_target(nullptr, 0));
}
