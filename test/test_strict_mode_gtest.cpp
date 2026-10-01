// test_strict_mode_gtest.cpp — 严格模式（safe-run untrusted script）回归。
//
// 严格模式是安全边界：fs 限根（sandbox_root）+ 相对路径拒绝 + 默认模式不误伤。
// 判定在 bridge.c 的 bridge_validate_path（纯 libc realpath 前缀校验，不依赖
// uv），故 mock_libuv 构建下可测——越界路径在建 Promise 前就 reject，走不到
// uv stub；根内路径走完 stub resolve。每个用例配「非 strict 同路径」对照。
//
// 用 host_eval + globalThis 标志 + host_poll_until_value（与 polyfill 测试
// 同一约定）：同步 throw 在 async 包装下表现为 rejection。
#include "test_host.h"
#include <cstdlib>
#include <string>
#include <unistd.h>
#include <sys/stat.h>

namespace {

std::string g_sandbox;   /* mkdtemp 沙箱根（/tmp 下无 symlink） */
std::string g_outside;   /* 根外诱饵文件（绝对路径） */

void mk_sandbox() {
    char tpl[] = "/tmp/qzjs_strict_XXXXXX";
    char *d = mkdtemp(tpl);
    EXPECT_NE(nullptr, d);
    if (!d) return;
    g_sandbox = d;
    mkdir((g_sandbox + "/sub").c_str(), 0700);
    FILE *f = fopen((g_sandbox + "/inside.txt").c_str(), "w");
    if (f) { fputs("inside\n", f); fclose(f); }
    g_outside = g_sandbox + "_outside.txt";
    f = fopen(g_outside.c_str(), "w");
    if (f) { fputs("SECRET\n", f); fclose(f); }
}

void rm_sandbox() {
    if (g_sandbox.empty()) return;
    unlink((g_sandbox + "/inside.txt").c_str());
    rmdir((g_sandbox + "/sub").c_str());
    unlink(g_outside.c_str());
    rmdir(g_sandbox.c_str());
    g_sandbox.clear();
    g_outside.clear();
}

// 建 strict（sandbox_root 非空）或默认（nullptr）运行时。
HostCtx *host_create_strict(const char *sandbox_root) {
    auto *h = new HostCtx();
    qz_config_t cfg;
    qz_config_init(&cfg);
    cfg.initial_script = kTestBootstrap;
    if (sandbox_root) {
        cfg.strict_mode = 1;
        cfg.sandbox_root = sandbox_root;
    }
    h->rt = qz_create(&cfg);
    if (!h->rt) { delete h; return nullptr; }
    return h;
}

// 发起一次 readFile(path) 并等待 settle 到期望分类。「'ok'」= 通过 fs 校验
// （落到 uv stub resolve），rej = 被 fs 层拒绝。mock 下 uv 不真读盘，故
// 只观测校验层放行与否——这正是严格模式要断言的东西。
bool fs_read_expect(HostCtx *h, const std::string &path, const char *expected) {
    std::string out;
    std::string code = "globalThis._sc='pending'; qzjs.fs.readFile(" +
        JSON_string(path.c_str()) +
        ").then(function(){ globalThis._sc='ok'; },"
        " function(){ globalThis._sc='rej'; }); 0";
    if (!host_eval(h, code.c_str(), &out)) return false;
    std::string v;
    return host_poll_until_value(h, "_sc", expected, &v);
}

}  // namespace

class StrictModeTest : public ::testing::Test {
protected:
    HostCtx *h = nullptr;
    void SetUp() override {
        if (g_sandbox.empty()) mk_sandbox();
        h = host_create_strict(g_sandbox.c_str());
        ASSERT_NE(nullptr, h);
    }
    void TearDown() override { host_destroy(h); rm_sandbox(); }
};

// 根内绝对路径 → 通过校验（resolve 到 uv stub）。
TEST_F(StrictModeTest, InRootPathAllowed) {
    ASSERT_TRUE(fs_read_expect(h, g_sandbox + "/inside.txt", "ok"))
        << "in-root absolute path must pass strict validation";
}

// 根外绝对路径 → strict 下拒绝（严格模式的核心断言）。
TEST_F(StrictModeTest, AbsoluteEscapeDenied) {
    ASSERT_TRUE(fs_read_expect(h, g_outside, "rej"))
        << "root-external absolute path must be denied";
}

// ".." 逃逸 → 拒绝（既有基线防护，strict 下同样拒）。
TEST_F(StrictModeTest, DotDotEscapeDenied) {
    ASSERT_TRUE(fs_read_expect(h, g_sandbox + "/../" + g_outside, "rej"));
}

// 相对路径 → strict 下拒绝（下游按 CWD 解析，校验层不脑补 root-relative）。
TEST_F(StrictModeTest, RelativePathDenied) {
    ASSERT_TRUE(fs_read_expect(h, "inside.txt", "rej"))
        << "relative path must be denied in strict mode";
}

// 默认（trusted）模式下同一越界路径不被 fs 门控拒绝——门控不能误伤宿主。
TEST_F(StrictModeTest, DefaultModeUnaffected) {
    host_destroy(h);
    h = host_create_strict(nullptr);
    ASSERT_NE(nullptr, h);
    ASSERT_TRUE(fs_read_expect(h, g_outside, "ok"))
        << "default mode must not gate fs";
}