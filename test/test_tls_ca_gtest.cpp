// test_tls_ca_gtest.cpp — 运行时 CA 信任库（qz_add_ca_pem）
//
// 背景：TLS 客户端此前只从四个固定系统路径加载 CA，宿主无法为自建 CA /
// 私有 PKI 增补信任根。qz_add_ca_pem() 让宿主追加 PEM；TLS op 建连时把它
// **追加**进系统 CA 之后（追加信任，不替换系统信任 —— 自建 CA 与公有 CA
// 同时有效）。
//
// 本测试刻意调用**生产函数** uv_io_tls_load_host_ca()，而不是在测试里复现
// 一次 mbedtls_x509_crt_parse：这里唯一的 off-by-one 风险就在长度约定
// （ca_pem_len 不含末尾 NUL，传参要 +1），复现版测不到真实约定——它只会
// 测到测试自己写对的那个约定。
//
// 未覆盖（诚实说明）：真实 mbedtls 握手（自签服务器 + fetch）没有离线覆盖。
// 那需要真实 libuv + TLS 服务器，现有 gtest 跑在 mock_libuv 上，无真实套接字。

#include "test_host.h"
#include "mock_libuv.h"
#include <mbedtls/x509_crt.h>
#include <string>
#include <vector>
#include <cstdio>

namespace {

/* 读测试夹具里的自签证书（CN=localhost，subject==issuer，可作 CA）。
 * 走源码树相对路径而非依赖 cwd：ctest 的 WORKING_DIRECTORY 未必是仓库根。 */
static std::string load_fixture_cert()
{
    /* TEST_DIR 由 CMakeLists 传为 test/ 目录本身，故首选项就是
     * <repo>/test/fixtures/test.crt；后两项兜底「cwd 是仓库根/上层」的跑法。
     *
     * 该夹具已于 2026-08-18 过期，但**在本测试里无关**：这里只做
     * mbedtls_x509_crt_parse —— 解析不校验有效期，日期只有走完整证书链验证
     * （握手）才会被查。所以过期的 PEM 照样能作为「一段可解析的证书材料」。
     * 需要真握手的 test_tls_ca_e2e.py 不复用它，改为现生成两级 PKI
     * （拿过期证书跑会在「过期」而非「信任」上失败，测的就不是目标功能了）。
     * 看到「夹具过期」请勿顺手替换本文件——除非同时新增了校验日期的断言。 */
    const char *paths[] = {
        TEST_DIR "/fixtures/test.crt",
        "../test/fixtures/test.crt",
        "test/fixtures/test.crt",
        nullptr
    };
    for (const char **p = paths; *p != nullptr; p++) {
        FILE *f = fopen(*p, "rb");
        if (!f) continue;
        std::string out;
        char buf[4096];
        size_t n;
        while ((n = fread(buf, 1, sizeof buf, f)) > 0) out.append(buf, n);
        fclose(f);
        if (!out.empty()) return out;
    }
    return std::string();
}

/* 数一条 x509 链上**真正解析出来**的证书数。
 * 注意不能直接数链表节点：mbedtls 的空链也有一个「头节点」（version==0），
 * 数节点会把空链数成 1。version==0 正是 mbedtls 用来标记「此槽未装证书」的
 * 字段（parse 时往 version==0 的空槽写，装上才置 version）。 */
static int count_certs(const mbedtls_x509_crt *chain)
{
    int n = 0;
    for (const mbedtls_x509_crt *c = chain; c != NULL; c = c->next) {
        if (c->version != 0) n++;
    }
    return n;
}

}  // namespace

class TlsCaTest : public ::testing::Test {
protected:
    HostCtx *h = nullptr;
    void SetUp() override { h = host_create(); ASSERT_NE(nullptr, h); }
    void TearDown() override { if (h) { host_destroy(h); h = nullptr; } }

    qz_t *rt() { return h->rt; }
};

TEST_F(TlsCaTest, RejectsInvalidArguments)
{
    /* 参数非法必须返回 -1，不是崩、不是静默 0（宿主会以为 CA 已装上）。 */
    EXPECT_EQ(-1, qz_add_ca_pem(nullptr, "x"));
    EXPECT_EQ(-1, qz_add_ca_pem(rt(), nullptr));
    EXPECT_EQ(-1, qz_add_ca_pem(rt(), ""));
}

TEST_F(TlsCaTest, EmptyStoreAddsNothing)
{
    /* 没加过 CA 时：链保持原样（空），且不报错。
     * 这是「系统 CA 缺失时不得静默降级」那条不变量的另一半 —— 这里只验
     * 不污染，真握手路径由 tls_init_op 负责。 */
    mbedtls_x509_crt chain;
    mbedtls_x509_crt_init(&chain);
    EXPECT_EQ(0, uv_io_tls_load_host_ca(rt(), &chain));
    EXPECT_EQ(0, count_certs(&chain));
    mbedtls_x509_crt_free(&chain);
}

TEST_F(TlsCaTest, AppendsHostCaIntoChain)
{
    const std::string pem = load_fixture_cert();
    ASSERT_FALSE(pem.empty()) << "test/fixtures/test.crt 读不到，测试无法验证真实路径";

    ASSERT_EQ(0, qz_add_ca_pem(rt(), pem.c_str()));
    EXPECT_GT(rt()->ca_pem_len, 0u);
    /* 末尾必须有 NUL：mbedtls_x509_crt_parse 按 NUL 终止缓冲解析。
     * 漏掉这个 NUL 是本函数最容易被后续改动踩坏的点。 */
    ASSERT_NE(nullptr, rt()->ca_pem);
    EXPECT_EQ('\0', rt()->ca_pem[rt()->ca_pem_len]);

    mbedtls_x509_crt chain;
    mbedtls_x509_crt_init(&chain);
    ASSERT_EQ(0, uv_io_tls_load_host_ca(rt(), &chain))
        << "生产函数解析失败 —— 多半是长度约定（ca_pem_len + 1）被改坏";
    EXPECT_EQ(1, count_certs(&chain));
    mbedtls_x509_crt_free(&chain);
}

TEST_F(TlsCaTest, SecondCaAppendsRatherThanReplaces)
{
    const std::string pem = load_fixture_cert();
    ASSERT_FALSE(pem.empty());

    ASSERT_EQ(0, qz_add_ca_pem(rt(), pem.c_str()));
    ASSERT_EQ(0, qz_add_ca_pem(rt(), pem.c_str()));

    mbedtls_x509_crt chain;
    mbedtls_x509_crt_init(&chain);
    ASSERT_EQ(0, uv_io_tls_load_host_ca(rt(), &chain));
    /* 两张都在链上。若实现改成「替换」，这里会是 1 —— 而真实后果是第二张
     * CA 静默失效，宿主以为配好了。 */
    EXPECT_EQ(2, count_certs(&chain));
    mbedtls_x509_crt_free(&chain);
}

TEST_F(TlsCaTest, StoreSurvivesRepeatedCallsWithoutCorruptingTail)
{
    const std::string pem = load_fixture_cert();
    ASSERT_FALSE(pem.empty());

    /* 反复追加会触发 realloc 扩容路径；最后一张必须仍能被解析出来。
     * 扩容算错会导致前面的内容被截断，而那表现为「某张 CA 莫名失效」。 */
    for (int i = 0; i < 8; i++) ASSERT_EQ(0, qz_add_ca_pem(rt(), pem.c_str()));

    mbedtls_x509_crt chain;
    mbedtls_x509_crt_init(&chain);
    ASSERT_EQ(0, uv_io_tls_load_host_ca(rt(), &chain));
    EXPECT_EQ(8, count_certs(&chain));
    mbedtls_x509_crt_free(&chain);
}