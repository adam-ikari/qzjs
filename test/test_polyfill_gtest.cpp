// test_polyfill_gtest.cpp — polyfill 各模块（执行模型 A / mock_libuv）
// Console/Encoding/Url 同步求值；Timer/Storage/Fetch 异步，用 host_poll_until_value
// 轮询（每次 host_eval 都跑一轮 loop + 冲刷微任务）。
#include "test_host.h"
#include <cstring>
#include <cstdlib>
#include <unistd.h>
#include <fstream>

class PolyfillTest : public ::testing::Test {
protected:
    HostCtx *h = nullptr;

    void SetUp() override {
        h = host_create();
        ASSERT_NE(nullptr, h);
    }
    void TearDown() override { host_destroy(h); }
};

TEST_F(PolyfillTest, Console) {
    std::string out;
    ASSERT_TRUE(host_eval(h, "console.log('hello', 'polyfill'); 1", &out));
    EXPECT_NE(std::string::npos, out.find("\"ok\":true"));   /* 无异常即通过 */
}

TEST_F(PolyfillTest, Timer) {
    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var _timerFired = false;\n"
        "setTimeout(function(){ _timerFired = true; }, 100);\n"
        "0", &out));

    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "_timerFired", "true", &v));
}

TEST_F(PolyfillTest, Encoding) {
    std::string v;
#if QZ_WITH_TEXTCODEC
    ASSERT_TRUE(host_value(h, "btoa('hello')", &v));
    EXPECT_NE(std::string::npos, v.find("aGVsbG8="));
    ASSERT_TRUE(host_value(h, "atob('aGVsbG8=')", &v));
    EXPECT_NE(std::string::npos, v.find("hello"));
#else
    /* textcodec OFF：JS 平行实现已删，btoa/atob 必须抛 TypeError */
    ASSERT_TRUE(host_value(h,
        "var errs = [];\n"
        "try { btoa('hello'); } catch(e) { errs.push(String(e)); }\n"
        "try { atob('aGVsbG8='); } catch(e) { errs.push(String(e)); }\n"
        "JSON.stringify(errs)", &v));
    EXPECT_NE(std::string::npos, v.find("QZ_WITH_TEXTCODEC")) << "got: " << v;
#endif
}

TEST_F(PolyfillTest, Url) {
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var u = new URL('https://example.com/path?q=1#frag');\n"
        "JSON.stringify({q: u.searchParams.get('q'), proto: u.protocol,\n"
        "  host: u.hostname, path: u.pathname})", &v));
    EXPECT_NE(std::string::npos, v.find("\"q\":\"1\""));
    EXPECT_NE(std::string::npos, v.find("\"proto\":\"https:\""));
    EXPECT_NE(std::string::npos, v.find("\"host\":\"example.com\""));
    EXPECT_NE(std::string::npos, v.find("\"path\":\"/path\""));
}

TEST_F(PolyfillTest, UrlPatternBasic) {
    std::string v;
    /* named group :id matches one path segment */
    ASSERT_TRUE(host_value(h,
        "var p = new URLPattern('/books/:id');\n"
        "JSON.stringify({t: p.test('https://x.com/books/42'),\n"
        "  g: p.exec('https://x.com/books/42').pathname.groups})", &v));
    EXPECT_NE(std::string::npos, v.find("\"t\":true"));
    EXPECT_NE(std::string::npos, v.find("\"id\":\"42\""));
}

TEST_F(PolyfillTest, UrlPatternModifiers) {
    std::string v;
    /* :x? optional segment */
    ASSERT_TRUE(host_value(h,
        "var p = new URLPattern({pathname: '/a/:x?'});\n"
        "JSON.stringify([p.test('https://x.com/a/5'), p.test('https://x.com/a/')])", &v));
    EXPECT_NE(std::string::npos, v.find("true"));

    /* :x+ one-or-more segments (greedy, crosses '/') */
    ASSERT_TRUE(host_value(h,
        "var p = new URLPattern({pathname: '/a/:x+'});\n"
        "var m = p.exec('https://x.com/a/b/c');\n"
        "JSON.stringify({t: !!m, g: m ? m.pathname.groups : null})", &v));
    EXPECT_NE(std::string::npos, v.find("\"t\":true"));
    EXPECT_NE(std::string::npos, v.find("\"x\":\"b/c\""));

    /* :x* zero-or-more segments (greedy) */
    ASSERT_TRUE(host_value(h,
        "var p = new URLPattern({pathname: '/a/:x*'});\n"
        "var m = p.exec('https://x.com/a/b/c');\n"
        "JSON.stringify({t: !!m, g: m ? m.pathname.groups : null})", &v));
    EXPECT_NE(std::string::npos, v.find("\"t\":true"));
    EXPECT_NE(std::string::npos, v.find("\"x\":\"b/c\""));
}

TEST_F(PolyfillTest, FormData) {
    std::string v;
    /* append / get / getAll / has / set / delete */
    ASSERT_TRUE(host_value(h,
        "var fd = new FormData();\n"
        "fd.append('k', 'a'); fd.append('k', 'b');\n"
        "var r = [fd.get('k'), fd.getAll('k').length, fd.getAll('k')[0], fd.getAll('k')[1], fd.has('k')];\n"
        "fd.set('k', 'c'); r.push(fd.get('k'));\n"
        "fd.delete('k'); r.push(fd.has('k'));\n"
        "JSON.stringify(r)", &v));
    EXPECT_NE(std::string::npos, v.find("\"a\""));
    EXPECT_NE(std::string::npos, v.find("2"));   /* getAll length */
    EXPECT_NE(std::string::npos, v.find("\"b\""));
    EXPECT_NE(std::string::npos, v.find("true")); /* has */
    EXPECT_NE(std::string::npos, v.find("\"c\"")); /* after set */
    EXPECT_NE(std::string::npos, v.find("false")); /* after delete */

    /* keys / values / entries / forEach */
    ASSERT_TRUE(host_value(h,
        "var fd = new FormData(); fd.append('k1','v1'); fd.append('k2','v2');\n"
        "var ks = [], vs = [];\n"
        "fd.forEach(function(v,k){ ks.push(k); vs.push(v); });\n"
        "JSON.stringify([ks.join(','), vs.join(','), fd.size])", &v));
    EXPECT_NE(std::string::npos, v.find("k1,k2"));
    EXPECT_NE(std::string::npos, v.find("v1,v2"));

    /* Blob value with filename -> File-like */
    ASSERT_TRUE(host_value(h,
        "var fd = new FormData();\n"
        "fd.append('f', new Blob(['hi']), 'a.txt');\n"
        "var f = fd.get('f');\n"
        "JSON.stringify([f instanceof Blob, f.name, f.size])", &v));
    EXPECT_NE(std::string::npos, v.find("true"));
    EXPECT_NE(std::string::npos, v.find("\"a.txt\""));
}

TEST_F(PolyfillTest, ErrorEventAndEvent) {
    std::string v;
    /* ErrorEvent ctor fills standard fields */
    ASSERT_TRUE(host_value(h,
        "var e = new ErrorEvent('error', {message:'boom', filename:'x.js', lineno:3, colno:5});\n"
        "JSON.stringify([e.type, e.message, e.filename, e.lineno, e.colno])", &v));
    EXPECT_NE(std::string::npos, v.find("\"error\""));
    EXPECT_NE(std::string::npos, v.find("\"boom\""));
    EXPECT_NE(std::string::npos, v.find("\"x.js\""));
    EXPECT_NE(std::string::npos, v.find("3"));
    EXPECT_NE(std::string::npos, v.find("5"));

    /* ErrorEvent defaults (empty message, 0/0 coords) */
    ASSERT_TRUE(host_value(h,
        "var e = new ErrorEvent('error');\n"
        "JSON.stringify([e.message, e.filename, e.lineno, e.colno])", &v));
    EXPECT_NE(std::string::npos, v.find("\"\""));

    /* Event basic flags */
    ASSERT_TRUE(host_value(h,
        "var e = new Event('x');\n"
        "JSON.stringify([e.type, e.bubbles, e.cancelable])", &v));
    EXPECT_NE(std::string::npos, v.find("\"x\""));
    EXPECT_NE(std::string::npos, v.find("false"));
}

TEST_F(PolyfillTest, StructuredCloneTransferArrayBuffer) {
    std::string v;
    /* transfer 一个 ArrayBuffer：克隆结果保留内容，原 buffer 被 detach */
    ASSERT_TRUE(host_value(h,
        "var ab = new ArrayBuffer(4);\n"
        "new Uint8Array(ab).set([1,2,3,4]);\n"
        "var c = structuredClone(ab, {transfer:[ab]});\n"
        "JSON.stringify({src: ab.byteLength, c: new Uint8Array(c).join(',')})", &v));
    EXPECT_NE(std::string::npos, v.find("\"src\":0")) << "got: " << v;      /* 原 buffer detached */
    EXPECT_NE(std::string::npos, v.find("\"c\":\"1,2,3,4\"")) << "got: " << v;

    /* 不带 transfer：原 buffer 不被 detach */
    ASSERT_TRUE(host_value(h,
        "var ab = new ArrayBuffer(4);\n"
        "var c = structuredClone(ab);\n"
        "JSON.stringify(ab.byteLength)", &v));
    EXPECT_NE(std::string::npos, v.find("4")) << "got: " << v;

    /* transfer 列表含不可转移对象（普通对象）→ DataCloneError */
    ASSERT_TRUE(host_value(h,
        "var r = 'no-error';\n"
        "try { structuredClone({}, {transfer:[{}]}); }\n"
        "catch (e) { r = e.name; }\n"
        "JSON.stringify(r)", &v));
    EXPECT_NE(std::string::npos, v.find("\"DataCloneError\"")) << "got: " << v;

    /* transfer 列表重复对象 → DataCloneError */
    ASSERT_TRUE(host_value(h,
        "var ab = new ArrayBuffer(4);\n"
        "var r = 'no-error';\n"
        "try { structuredClone(ab, {transfer:[ab, ab]}); }\n"
        "catch (e) { r = e.name; }\n"
        "JSON.stringify(r)", &v));
    EXPECT_NE(std::string::npos, v.find("\"DataCloneError\"")) << "got: " << v;
}

TEST_F(PolyfillTest, StructuredCloneTransferMessagePort) {
    std::string v;
    /* transfer 一个 MessagePort：不抛错，原 port 被标记 detached */
    ASSERT_TRUE(host_value(h,
        "var ch = new MessageChannel();\n"
        "var c = structuredClone({p: ch.port1}, {transfer:[ch.port1]});\n"
        "JSON.stringify({d: ch.port1._detached, hasP: c.p instanceof MessagePort})", &v));
    EXPECT_NE(std::string::npos, v.find("\"d\":true")) << "got: " << v;   /* 原 port detached */
    EXPECT_NE(std::string::npos, v.find("\"hasP\":true")) << "got: " << v;

    /* 值里的 MessagePort（不在 transfer）不可克隆 → DataCloneError */
    ASSERT_TRUE(host_value(h,
        "var r = 'no-error';\n"
        "try { structuredClone(new MessageChannel().port1); }\n"
        "catch (e) { r = e.name; }\n"
        "JSON.stringify(r)", &v));
    EXPECT_NE(std::string::npos, v.find("\"DataCloneError\"")) << "got: " << v;
}

TEST_F(PolyfillTest, Storage) {
    std::string v;
    ASSERT_TRUE(host_eval(h,
        "var _setOk = null; var _got = null; var _delOk = null;\n"
        "qzjs.storage.set('pf_key', 'pf_value').then(function(){ _setOk = 'yes'; });\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_setOk", "yes", &v));

    ASSERT_TRUE(host_eval(h,
        "qzjs.storage.get('pf_key').then(function(v){ _got = v; });\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_got", "pf_value", &v));

    ASSERT_TRUE(host_eval(h,
        "qzjs.storage.delete('pf_key').then(function(){ _delOk = 'yes'; });\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_delOk", "yes", &v));
}

/* localStorage（Web Storage Storage 接口，同步 + 持久化）。
 * 用 QZ_LOCALSTORAGE_FILE 指向独立临时文件，避免触碰默认 ~/.qzjs/
 * localstorage.json。 */
TEST_F(PolyfillTest, LocalStorageBasic) {
    char tmpl[] = "/tmp/qz_ls_basic_XXXXXX";
    int fd = ::mkstemp(tmpl);
    ASSERT_GE(fd, 0);
    ::close(fd);
    ::remove(tmpl);   /* 从空文件开始（mkstemp 建的空文件，读空串解析失败→空） */
    setenv("QZ_LOCALSTORAGE_FILE", tmpl, 1);
    /* runtime 在 polyfill 注入时解析持久化路径，必须先设好 env 再建 host */
    host_destroy(h);
    h = host_create();
    ASSERT_NE(nullptr, h);
    std::string v;

    /* getItem/setItem/removeItem/length/key + 键/值强制 String */
    ASSERT_TRUE(host_value(h,
        "var r = [];\n"
        "r.push(localStorage.getItem('k1'));\n"          /* 缺失 → null */
        "localStorage.setItem('k1', 'v1');\n"
        "localStorage.setItem(42, 'v42');\n"             /* 键强制 '42' */
        "localStorage.setItem('k3', 3);\n"               /* 值强制 '3' */
        "r.push(localStorage.getItem('k1'));\n"
        "r.push(localStorage.length);\n"
        "r.push(localStorage.key(0));\n"
        "r.push(localStorage.key(1));\n"
        "r.push(localStorage.key(99));\n"                /* 越界 → null */
        "r.push(localStorage.getItem('42'));\n"
        "r.push(localStorage.getItem('k3'));\n"
        "localStorage.removeItem('k1');\n"
        "r.push(localStorage.getItem('k1'));\n"
        "r.push(localStorage.length);\n"
        "JSON.stringify(r)", &v));
    EXPECT_EQ("[null,\"v1\",3,\"k1\",\"42\",null,\"v42\",\"3\",null,2]", v) << "got: " << v;

    /* Storage 接口实例：方法/访问器不可枚举 */
    ASSERT_TRUE(host_value(h, "JSON.stringify(Object.keys(localStorage).length)", &v));
    EXPECT_EQ("0", v) << "got: " << v;

    /* clear() 清空 */
    ASSERT_TRUE(host_value(h,
        "localStorage.clear();\n"
        "JSON.stringify([localStorage.length, localStorage.getItem('k3')])", &v));
    EXPECT_EQ("[0,null]", v) << "got: " << v;

    unsetenv("QZ_LOCALSTORAGE_FILE");
    ::remove(tmpl);
}

/* M-P4 §10.2：所有者侧 storage 请求处理（__qz_storage_dispatch__）——
 * worker 经 kind=STORAGE 信封发来的 op 编排在这里执行。进程往返本身由
 * test/test_mp4_storage_crash_e2e.sh 覆盖（真两进程）；本用例单测所有者
 * 编排的语义与回包线格式（op 执行、异常封装、kind=4/source 回显），不需要
 * 进程后端——THREAD 基线上直接驱动。 */
TEST_F(PolyfillTest, StorageOwnerDispatch) {
    char tmpl[] = "/tmp/qz_ls_dispatch_XXXXXX";
    int fd = ::mkstemp(tmpl);
    ASSERT_GE(fd, 0);
    ::close(fd);
    ::remove(tmpl);
    setenv("QZ_LOCALSTORAGE_FILE", tmpl, 1);
    host_destroy(h);
    h = host_create();
    ASSERT_NE(nullptr, h);
    std::string v;

    ASSERT_TRUE(host_value(h,
        /* 截获回包（进程路径里 __qz_worker_post__ 由 worker.js 注册；这里
         * 直接替换为记录器，观察所有者发出的帧） */
        "globalThis.__replies = [];\n"
        "globalThis.__qz_worker_post__ = function (src, bytes, kind) {\n"
        "  __replies.push({s: src, k: kind, r: __qz_deserialize__(bytes)});\n"
        "};\n"
        "function req(op, key, value, domain) {\n"
        "  __qz_storage_dispatch__(\n"
        "    __qz_serialize__({ op: op, key: key, value: value,\n"
        "                         storageDomain: domain || 'localStorage' }), 1001);\n"
        "  return __replies[__replies.length - 1];\n"
        "}\n"
        "localStorage.clear();\n"
        "var out = [];\n"
        "out.push(req('get', 'miss'));\n"
        "out.push(req('set', 'a', 'A'));\n"
        "out.push(req('length'));\n"
        "out.push(req('key', 0));\n"
        "out.push(req('get', 'a'));\n"
        "out.push(req('bogus-op'));\n"     /* 未知 op → {e:{name:'Error'}} 形状 */
        "out.push(req('remove', 'a'));\n"
        "out.push(req('length'));\n"
        "JSON.stringify(out.map(function (x) {\n"
        "  return [x.s, x.k, x.r.v !== undefined ? x.r.v\n"
        "          : (x.r.e ? x.r.e.name : null)];\n"
        "}))", &v));
    /* source 回显 1001、kind 恒 4（STORAGE）；op 语义与同进程一致；错误封装为
     * {e:{name}}（代理侧据此重建异常）。配额异常的跨进程传播由 e2e 与
     * LocalStorageQuotaExceeded 覆盖，这里不重复。 */
    EXPECT_EQ("[[1001,4,null],[1001,4,null],[1001,4,1],[1001,4,\"a\"],"
              "[1001,4,\"A\"],[1001,4,\"Error\"],"
              "[1001,4,null],[1001,4,0]]", v) << "got: " << v;
    /* sessionStorage 域路由：storageDomain='sessionStorage' → 独立区（ssArea），
     * 与 localStorage 同 key 互不污染；缺省/其他域 → localStorage。 */
    ASSERT_TRUE(host_value(h,
        "sessionStorage.clear();\n"
        "localStorage.clear();\n"
        "localStorage.setItem('shared', 'ls');\n"
        "var out = [];\n"
        "req('set', 'shared', 'ss', 'sessionStorage');\n"
        "out.push(req('get', 'shared', undefined, 'sessionStorage').r.v);\n"
        "out.push(req('get', 'shared').r.v);\n"               /* 缺省域 → localStorage */
        "out.push(req('length', undefined, undefined, 'sessionStorage').r.v);\n"
        "out.push(req('remove', 'shared', undefined, 'sessionStorage').r.v);\n"
        "out.push(req('get', 'shared', undefined, 'sessionStorage').r.v);\n"
        "out.push(req('get', 'shared').r.v);\n"               /* localStorage 不受 session remove 影响 */
        "JSON.stringify(out)", &v));
    EXPECT_EQ("[\"ss\",\"ls\",1,null,null,\"ls\"]", v) << "got: " << v;

    unsetenv("QZ_LOCALSTORAGE_FILE");
    ::remove(tmpl);
}

/* 持久化：setItem 后销毁 runtime，用同一文件重建 → 数据仍在（跨重启）。 */
TEST_F(PolyfillTest, LocalStoragePersistsAcrossRestart) {
    char tmpl[] = "/tmp/qz_ls_persist_XXXXXX";
    int fd = ::mkstemp(tmpl);
    ASSERT_GE(fd, 0);
    ::close(fd);
    ::remove(tmpl);
    setenv("QZ_LOCALSTORAGE_FILE", tmpl, 1);
    /* runtime 在 polyfill 注入时解析持久化路径，必须先设好 env 再建 host */
    host_destroy(h);
    h = host_create();
    ASSERT_NE(nullptr, h);
    std::string v;

    ASSERT_TRUE(host_value(h,
        "localStorage.setItem('pk', 'pv');\n"
        "localStorage.setItem('pn', '7');\n"
        "JSON.stringify([localStorage.length, localStorage.getItem('pk')])", &v));
    EXPECT_EQ("[2,\"pv\"]", v) << "got: " << v;

    /* 模拟重启：销毁 runtime，同一持久化文件重建 */
    host_destroy(h);
    h = host_create();
    ASSERT_NE(nullptr, h);

    ASSERT_TRUE(host_value(h,
        "JSON.stringify([localStorage.length, localStorage.getItem('pk'), "
        "localStorage.getItem('pn')])", &v));
    EXPECT_EQ("[2,\"pv\",\"7\"]", v) << "got: " << v;

    /* 文件落盘为 JSON 对象 */
    FILE *f = fopen(tmpl, "rb");
    ASSERT_NE(nullptr, f);
    char buf[256];
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[n] = '\0';
    EXPECT_NE(std::string::npos, std::string(buf).find("\"pk\":\"pv\"")) << "got: " << buf;

    unsetenv("QZ_LOCALSTORAGE_FILE");
    ::remove(tmpl);
}

/* 配额（5 MiB 键+值 code units）：超限抛 QuotaExceededError，状态不变、不落盘。 */
TEST_F(PolyfillTest, LocalStorageQuotaExceeded) {
    char tmpl[] = "/tmp/qz_ls_quota_XXXXXX";
    int fd = ::mkstemp(tmpl);
    ASSERT_GE(fd, 0);
    ::close(fd);
    ::remove(tmpl);
    setenv("QZ_LOCALSTORAGE_FILE", tmpl, 1);
    /* runtime 在 polyfill 注入时解析持久化路径，必须先设好 env 再建 host */
    host_destroy(h);
    h = host_create();
    ASSERT_NE(nullptr, h);
    std::string v;

    /* 单个超配额值 → 抛错，length 0，未落盘 */
    ASSERT_TRUE(host_value(h,
        "var big = 'x'.repeat(6 * 1024 * 1024);\n"
        "var name = 'no-error';\n"
        "try { localStorage.setItem('big', big); }\n"
        "catch (e) { name = e.name; }\n"
        "JSON.stringify([name, localStorage.length, localStorage.getItem('big')])", &v));
    EXPECT_EQ("[\"QuotaExceededError\",0,null]", v) << "got: " << v;
    FILE *f = fopen(tmpl, "rb");
    EXPECT_EQ(nullptr, f) << "配额失败不应创建持久化文件";

    /* 配额内多个 2MiB 键可写入；累加推过 5MiB 后抛错且长度不变 */
    ASSERT_TRUE(host_value(h,
        "var two = 'y'.repeat(2 * 1024 * 1024);\n"
        "localStorage.setItem('a', two);\n"
        "localStorage.setItem('b', two);\n"
        "var name2 = 'no-error';\n"
        "try { localStorage.setItem('c', two); }\n"
        "catch (e) { name2 = e.name; }\n"
        "JSON.stringify([name2, localStorage.length, localStorage.getItem('a') !== null])", &v));
    EXPECT_EQ("[\"QuotaExceededError\",2,true]", v) << "got: " << v;

    unsetenv("QZ_LOCALSTORAGE_FILE");
    ::remove(tmpl);
}
/* sessionStorage：独立域（纯内存区，生命周期 = runtime 会话）——与 localStorage
 * 同 key 完全隔离、全 op 语义一致、超限同 QUOTA（5 MiB）、不落盘（数据不写进
 * localStorage 持久文件）。 */
TEST_F(PolyfillTest, SessionStorageBasic) {
    char tmpl[] = "/tmp/qz_ss_basic_XXXXXX";
    int fd = ::mkstemp(tmpl);
    ASSERT_GE(fd, 0);
    ::close(fd);
    ::remove(tmpl);
    setenv("QZ_LOCALSTORAGE_FILE", tmpl, 1);
    host_destroy(h);
    h = host_create();
    ASSERT_NE(nullptr, h);
    std::string v;

    /* 同 key 隔离（双向）+ 全 op（getItem/setItem/removeItem/clear/length/key）
     * + 键/值强制 String */
    ASSERT_TRUE(host_value(h,
        "var r = [];\n"
        "localStorage.setItem('k', 'ls-v');\n"
        "sessionStorage.setItem('k', 'ss-v');\n"
        "r.push(sessionStorage.getItem('k'));\n"        /* 'ss-v'：session 读自己的 */
        "r.push(localStorage.getItem('k'));\n"          /* 'ls-v'：反向隔离 */
        "r.push(sessionStorage.length);\n"
        "r.push(sessionStorage.key(0));\n"
        "sessionStorage.setItem(7, 8);\n"               /* 键/值强制 String */
        "r.push(sessionStorage.getItem('7'));\n"
        "sessionStorage.removeItem('k');\n"
        "r.push(sessionStorage.getItem('k'));\n"        /* null */
        "r.push(sessionStorage.length);\n"
        "r.push(localStorage.getItem('k'));\n"          /* localStorage 不受 session 操作影响 */
        "sessionStorage.clear();\n"
        "r.push(sessionStorage.length);\n"
        "r.push(localStorage.length);\n"
        "JSON.stringify(r)", &v));
    EXPECT_EQ("[\"ss-v\",\"ls-v\",1,\"k\",\"8\",null,1,\"ls-v\",0,1]", v) << "got: " << v;

    /* 超限同 QUOTA：单次 key+value > 5 MiB → QuotaExceededError，状态不变 */
    ASSERT_TRUE(host_value(h,
        "var name = 'no-error';\n"
        "try { sessionStorage.setItem('big', 'x'.repeat(6 * 1024 * 1024)); }\n"
        "catch (e) { name = e.name; }\n"
        "JSON.stringify([name, sessionStorage.length, sessionStorage.getItem('big')])", &v));
    EXPECT_EQ("[\"QuotaExceededError\",0,null]", v) << "got: " << v;

    /* 接口面：方法/访问器不可枚举（与 localStorage 一致） */
    ASSERT_TRUE(host_value(h, "JSON.stringify(Object.keys(sessionStorage).length)", &v));
    EXPECT_EQ("0", v) << "got: " << v;

    /* sessionStorage 不落盘：localStorage 持久文件只含 localStorage 数据 */
    std::ifstream f(tmpl);
    std::string contents((std::istreambuf_iterator<char>(f)),
                         std::istreambuf_iterator<char>());
    EXPECT_NE(std::string::npos, contents.find("\"k\":\"ls-v\""))
        << "localStorage file missing its own data: " << contents;
    EXPECT_EQ(std::string::npos, contents.find("ss-v"))
        << "session data leaked into localStorage file: " << contents;

    unsetenv("QZ_LOCALSTORAGE_FILE");
    ::remove(tmpl);
}

/* 默认持久化路径：无 QZ_LOCALSTORAGE_FILE → $HOME/.qzjs/localstorage.json；
 * HOME 缺失 → 当前目录 .qzjs-localstorage.json。 */
TEST_F(PolyfillTest, LocalStorageDefaultPath) {
    unsetenv("QZ_LOCALSTORAGE_FILE");
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var p = __native__.localStoragePath();\n"
        "JSON.stringify([typeof localStorage, p.indexOf('.qzjs/localstorage.json') >= 0])", &v));
    EXPECT_EQ("[\"object\",true]", v) << "got: " << v;

    const char *home = getenv("HOME");
    if (home) {
        unsetenv("HOME");
        ASSERT_TRUE(host_value(h, "__native__.localStoragePath()", &v));
        EXPECT_EQ(".qzjs-localstorage.json", v) << "got: " << v;
        setenv("HOME", home, 1);
    }
}

TEST_F(PolyfillTest, Fetch) {
    const char *resp =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/plain\r\n"
        "Content-Length: 20\r\n"
        "\r\n"
        "polyfill fetch works";
    ASSERT_EQ(0, mock_tcp_respond(&h->rt->loop, resp, strlen(resp)));

    std::string v;
    ASSERT_TRUE(host_eval(h,
        "var _fetchResult = null;\n"
        "fetch('http://example.com/api').then(function(r){ return r.text(); })\n"
        "  .then(function(t){ _fetchResult = t; });\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_fetchResult", "polyfill fetch works", &v));
}

// ================================================================
// BYOB streams (ECMA-429 Streams: ReadableByteStreamController /
// ReadableStreamBYOBReader / ReadableStreamBYOBRequest)
// ================================================================

TEST_F(PolyfillTest, ReadableByteStreamGlobals) {
    std::string v;
    /* 三个 BYOB 接口必须暴露为构造函数 */
    ASSERT_TRUE(host_value(h,
        R"(JSON.stringify([typeof ReadableByteStreamController,
          typeof ReadableStreamBYOBReader, typeof ReadableStreamBYOBRequest]))", &v));
    EXPECT_NE(std::string::npos, v.find("\"function\"")) << "got: " << v;
}

TEST_F(PolyfillTest, ByteStreamByobReaderMode) {
    std::string v;
    /* bytes stream + getReader({mode:'byob'}) → BYOBReader 实例 + 锁住 */
    ASSERT_TRUE(host_value(h,
        R"(var s = new ReadableStream({type:'bytes'});
        var r = s.getReader({mode:'byob'});
        JSON.stringify([r instanceof ReadableStreamBYOBReader, s.locked]))", &v));
    EXPECT_NE(std::string::npos, v.find("true")) << "got: " << v;

    /* 非 bytes stream + byob mode → TypeError */
    ASSERT_TRUE(host_value(h,
        R"(var s2 = new ReadableStream();
        var err = 'none';
        try { s2.getReader({mode:'byob'}); } catch(e) { err = e.name; }
        JSON.stringify(err))", &v));
    EXPECT_NE(std::string::npos, v.find("\"TypeError\"")) << "got: " << v;

    /* 非 bytes stream + 无参 getReader() → default reader（保持兼容） */
    ASSERT_TRUE(host_value(h,
        R"(var s3 = new ReadableStream();
        var r3 = s3.getReader();
        JSON.stringify(r3 instanceof ReadableStreamDefaultReader))", &v));
    EXPECT_NE(std::string::npos, v.find("true")) << "got: " << v;
}

TEST_F(PolyfillTest, ByobReadFromQueue) {
    std::string v;
    /* source 在 start 里 enqueue 两个 Uint8Array 后 close；BYOB read 填充用户 view */
    ASSERT_TRUE(host_eval(h,
        R"(var _byob_r = null;
        var _byob_r2 = null;
        var s = new ReadableStream({
          type: 'bytes',
          start: function(c) {
            c.enqueue(new Uint8Array([1,2,3,4]));
            c.enqueue(new Uint8Array([5,6]));
            c.close();
          }
        });
        var reader = s.getReader({mode:'byob'});
        reader.read(new Uint8Array(4)).then(function(res){
          _byob_r = JSON.stringify({d: res.done, b: Array.from(res.value)});
        });
        0)", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_byob_r", "\"b\":[1,2,3,4]", &v));

    /* 第二次读剩余 chunk [5,6]：value 部分填充，长度为 2 */
    ASSERT_TRUE(host_eval(h,
        R"(reader.read(new Uint8Array(4)).then(function(res){
          _byob_r2 = JSON.stringify({d: res.done, b: Array.from(res.value), l: res.value.length});
        });
        0)", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_byob_r2", "\"b\":[5,6]", &v));
    std::string v2;
    ASSERT_TRUE(host_value(h, "_byob_r2", &v2));
    EXPECT_NE(std::string::npos, v2.find("\"l\":2")) << "got: " << v2;
}

TEST_F(PolyfillTest, ByobReadClosedEmpty) {
    std::string v;
    /* 空队列 + 已 close → read 返回 {done:true} */
    ASSERT_TRUE(host_eval(h,
        R"(var _byob_d = null;
        var s = new ReadableStream({type:'bytes', start:function(c){ c.close(); }});
        var reader = s.getReader({mode:'byob'});
        reader.read(new Uint8Array(4)).then(function(res){
          _byob_d = JSON.stringify([res.done]);
        });
        0)", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_byob_d", "true", &v));
}

TEST_F(PolyfillTest, ByobRequestRespond) {
    std::string v;
    /* pull 里经 controller.byobRequest.view 写数据 + respond(n) 完成一次 BYOB read */
    ASSERT_TRUE(host_eval(h,
        R"(var _byob_req = null;
        var pulled = 0;
        var s = new ReadableStream({
          type: 'bytes',
          pull: function(c) {
            pulled++;
            var req = c.byobRequest;
            if (req && req.view) {
              var w = new Uint8Array(req.view.buffer, req.view.byteOffset, 3);
              w.set([7,8,9]);
              req.respond(3);
            }
          }
        });
        var reader = s.getReader({mode:'byob'});
        reader.read(new Uint8Array(8)).then(function(res){
          _byob_req = JSON.stringify({d: res.done, b: Array.from(res.value), l: res.value.length});
        });
        0)", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_byob_req", "\"b\":[7,8,9]", &v));
    std::string v2;
    ASSERT_TRUE(host_value(h, "_byob_req", &v2));
    EXPECT_NE(std::string::npos, v2.find("\"l\":3")) << "got: " << v2;
    EXPECT_NE(std::string::npos, v2.find("\"d\":false")) << "got: " << v2;
}

// ================================================================
// Crypto / Performance constructor exposure (ECMA-429 WEBCRYPTO / HR-TIME)
// ================================================================

#if QZ_WITH_CRYPTO_EXT
TEST_F(PolyfillTest, CryptoGlobals) {
    std::string v;
    /* Crypto / SubtleCrypto 构造函数暴露为 globalThis，且实例关系正确。
     * SubtleCrypto 仅在原生 crypto 扩展存在时安装（ext_crypto 的 init 钩子调
     * pal.__installCryptoSubtle__），故该测试随扩展门控。 */
    ASSERT_TRUE(host_value(h,
        R"(JSON.stringify([typeof Crypto, typeof SubtleCrypto,
          globalThis.crypto instanceof Crypto,
          globalThis.crypto.subtle instanceof SubtleCrypto]))", &v));
    EXPECT_NE(std::string::npos, v.find("\"function\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("true")) << "got: " << v;

    /* getRandomValues 回归：返回同一 typed array，填充正确字节数 */
    ASSERT_TRUE(host_value(h,
        R"(var u8 = new Uint8Array(16);
        var r = globalThis.crypto.getRandomValues(u8);
        JSON.stringify([r === u8, u8.length, u8[0] !== undefined]))", &v));
    EXPECT_NE(std::string::npos, v.find("true")) << "got: " << v;
}
#endif

TEST_F(PolyfillTest, PerformanceGlobals) {
    std::string v;
    /* Performance 构造函数暴露为 globalThis，且实例关系正确 */
    ASSERT_TRUE(host_value(h,
        R"(JSON.stringify([typeof Performance,
          globalThis.performance instanceof Performance,
          typeof globalThis.performance.now]))", &v));
    EXPECT_NE(std::string::npos, v.find("\"function\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("true")) << "got: " << v;

    /* performance.now 回归：返回数字（毫秒） */
    ASSERT_TRUE(host_value(h,
        R"(var t = globalThis.performance.now();
        JSON.stringify([typeof t, t >= 0]))", &v));
    EXPECT_NE(std::string::npos, v.find("\"number\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("true")) << "got: " << v;
}

TEST_F(PolyfillTest, FetchRequestOptions) {
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var r = new Request('https://x.com', {redirect:'error', keepalive:true, cache:'no-store', mode:'cors', credentials:'include'});\n"
        "JSON.stringify([r.redirect, r.keepalive, r.cache, r.mode, r.credentials])", &v));
    EXPECT_NE(std::string::npos, v.find("\"error\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("true")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"no-store\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"cors\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"include\"")) << "got: " << v;
}

TEST_F(PolyfillTest, StreamTeeCancel) {
    std::string v;
    /* 单分支取消不应传播到源（另一分支仍活跃）；两分支都取消后才释放源锁
     * 并触发 underlying source 的 cancel（WHATWG tee 语义）。 */
    ASSERT_TRUE(host_eval(h,
        R"(var _tc = null;
        var srcCancelled = false;
        var s = new ReadableStream({
          type: 'bytes',
          start: function(c){ c.enqueue(new Uint8Array([1,2,3])); },
          cancel: function(){ srcCancelled = true; }
        });
        var branches = s.tee();
        var afterOne;
        /* 规范 tee cancel：分支 cancel promise 须两分支都取消才 resolve，
         * 但源 cancel（srcCancelled）只在两分支都取消后触发——先取消 b0，
         * 下一 tick 采样（此时 b1 未取消，源必未被 cancel），再取消 b1。 */
        branches[0].cancel();
        Promise.resolve().then(function(){
          afterOne = JSON.stringify({src: srcCancelled});
          return branches[1].cancel();
        }).then(function(){
          _tc = afterOne + '|' + JSON.stringify({src: srcCancelled});
        });
        0)", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_tc", "\"src\":true", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, PipeToPreventAbort) {
    std::string v;
    /* preventAbort:true：源 errored 时 pipeTo 仍 reject，但 writer 不被 abort */
    ASSERT_TRUE(host_eval(h,
        R"(var _pa = null;
        var abortCalled = false;
        var src = new ReadableStream({
          start: function(c){ c.error(new Error('boom')); }
        });
        var dest = new WritableStream({
          write: function(){ return Promise.resolve(); },
          abort: function(){ abortCalled = true; }
        });
        var p = src.pipeTo(dest, {preventAbort: true});
        p.then(function(){ _pa = 'resolved:' + abortCalled; },
               function(e){ _pa = 'rejected:' + abortCalled; });
        0)", &v));
    /* pipeTo reject 且 abort 未被调用 */
    ASSERT_TRUE(host_poll_until_value(h, "_pa", "rejected:false", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, PipeToPreventClose) {
    std::string v;
    /* preventClose:true：源读完时 pipeTo resolve，但 writer 不被 close */
    ASSERT_TRUE(host_eval(h,
        R"(var _pc = null;
        var closeCalled = false;
        var src = new ReadableStream({
          start: function(c){ c.enqueue(1); c.close(); }
        });
        var dest = new WritableStream({
          write: function(){ return Promise.resolve(); },
          close: function(){ closeCalled = true; }
        });
        var p = src.pipeTo(dest, {preventClose: true});
        p.then(function(){ _pc = 'resolved:' + closeCalled; },
               function(e){ _pc = 'rejected:' + closeCalled; });
        0)", &v));
    /* pipeTo resolve 且 close 未被调用 */
    ASSERT_TRUE(host_poll_until_value(h, "_pc", "resolved:false", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, PipeToBackpressureSerial) {
    std::string v;
    /* write 返回 pending promise：pump 必须等待其完成才读下一个 chunk（串行） */
    ASSERT_TRUE(host_eval(h,
        R"(var _bp = null;
        var writes = '';
        var src = new ReadableStream({
          start: function(c){ c.enqueue(1); c.enqueue(2); c.enqueue(3); c.close(); }
        });
        var dest = new WritableStream({
          write: function(chunk){
            writes += String(chunk);
            return new Promise(function(resolve){ setTimeout(resolve, 30); });
          }
        });
        var p = src.pipeTo(dest);
        p.then(function(){ _bp = writes; },
               function(e){ _bp = 'error:' + e.message; });
        0)", &v));
    /* 串行写入：1、2、3 顺序到达，无并发重入 */
    ASSERT_TRUE(host_poll_until_value(h, "_bp", "123", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, StreamPipeToAbort) {
    std::string v;
    /* dest write 失败 → pipeTo reject，且源流被 cancel（preventCancel 缺省为 false）；
     * 同时验证背压：writer.write 返回 pending 时 pump 不并发推进 */
    ASSERT_TRUE(host_eval(h,
        R"(var _pt = null;
        var srcCancelled = false;
        var writeCount = 0;
        var src = new ReadableStream({
          start: function(c){ c.enqueue('d1'); c.enqueue('d2'); c.enqueue('d3'); },
          cancel: function(){ srcCancelled = true; }
        });
        var dest = new WritableStream({
          write: function(chunk) {
            writeCount++;
            if (chunk === 'd2') return Promise.reject(new Error('sink boom'));
            return new Promise(function(res){ setTimeout(res, 30); });
          }
        });
        src.pipeTo(dest).catch(function(e){
          _pt = JSON.stringify([srcCancelled, e.message]);
        });
        0)", &v));
    /* 期望：源 cancelled=true，错误消息为 'sink boom' */
    ASSERT_TRUE(host_poll_until_value(h, "_pt", "true", &v));
    std::string v2;
    ASSERT_TRUE(host_value(h, "_pt", &v2));
    EXPECT_NE(std::string::npos, v2.find("sink boom")) << "got: " << v2;

    /* 背压：写端第一次 write 是 pending(30ms)，期间不应发起第二次 read ——
     * d2 失败时 d3 尚未被读走（pump 串行）。验证失败时源只 abort，不 cancel。 */
    ASSERT_TRUE(host_value(h, "JSON.stringify(writeCount)", &v));
    EXPECT_EQ(0, v.compare("2")) << "写端并发推进了: got " << v;
}


TEST_F(PolyfillTest, PipeToReleasesWriterLock) {
    std::string v;
    /* WHATWG ReadableStreamPipeTo 收尾必须释放 dest writer 锁——否则 pipeTo
     * 完成后 dest.getWriter() 抛 "already has a writer"。三路径:正常收尾 /
     * preventClose / 出错(源 errored)都必须解锁。 */
    ASSERT_TRUE(host_eval(h,
        R"(var _rl = null;
        var relocked = function(dest){
          try { var w = dest.getWriter(); w.releaseLock(); return true; }
          catch(e) { return false; }
        };
        var r = [];
        var s1 = new ReadableStream({ start: function(c){ c.enqueue(1); c.close(); } });
        var d1 = new WritableStream({ write: function(){ return Promise.resolve(); } });
        s1.pipeTo(d1).then(function(){
          r.push('normal:' + relocked(d1));
          var s2 = new ReadableStream({ start: function(c){ c.enqueue(2); c.close(); } });
          var d2 = new WritableStream({ write: function(){ return Promise.resolve(); } });
          return s2.pipeTo(d2, {preventClose:true}).then(function(){
            r.push('preventClose:' + relocked(d2));
            var s3 = new ReadableStream({ start: function(c){ c.error(new Error('x')); } });
            var d3 = new WritableStream({ write: function(){ return Promise.resolve(); } });
            return s3.pipeTo(d3).then(function(){}, function(){
              r.push('error:' + relocked(d3));
            });
          });
        }).then(function(){ _rl = r.join('|'); });
        0)", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_rl", "normal:true", &v)) << "got: " << v;
    ASSERT_TRUE(host_poll_until_value(h, "_rl", "preventClose:true", &v)) << "got: " << v;
    ASSERT_TRUE(host_poll_until_value(h, "_rl", "error:true", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, ReleaseLockRejectsPendingRead) {
    std::string v;
    /* reader.releaseLock() 时有 pending read:该 read 必须被 reject(TypeError),
     * 而非永久挂起(规范 readableStreamReaderGenericRelease)。 */
    ASSERT_TRUE(host_eval(h,
        R"(var _rl2 = null;
        var s = new ReadableStream();   // 无数据 → read() 挂 pending
        var r = s.getReader();
        r.read().then(function(x){ _rl2 = 'resolved:' + JSON.stringify(x); },
                       function(e){ _rl2 = 'rejected:' + (e && e.name); });
        r.releaseLock();
        0)", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_rl2", "rejected:TypeError", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, ReadAfterReleaseRejects) {
    std::string v;
    /* releaseLock 后再 read():必须 reject TypeError("Reader has been released"),
     * 而非返回 {done:true}(规范)。 */
    ASSERT_TRUE(host_eval(h,
        "var _rar = null;\n"
        "var s = new ReadableStream({ start: function(c){ c.enqueue(1); } });\n"
        "var r = s.getReader();\n"
        "r.releaseLock();\n"
        "r.read().then(function(x){ _rar = 'resolved'; }, function(e){ _rar = e.name; });\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_rar", "TypeError", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, TeeSingleCancelClosesBranch) {
    std::string v;
    /* 单分支取消:该分支关闭(后续 read 返回 done),另一分支继续工作(规范
     * ReadableStreamTee)。规范中分支 cancel promise 须两分支都取消才
     * resolve,故这里不 await cancel(),直接读两分支验证语义。 */
    ASSERT_TRUE(host_eval(h,
        R"(var _tee3 = null;
        var s = new ReadableStream({
          start: function(c){ c.enqueue('a'); c.enqueue('b'); c.close(); }
        });
        var b = s.tee();
        b[0].cancel();
        /* 取消不 await（其 promise 须双分支都取消才 resolve）；setTimeout
         * 走宿主宏任务 tick（与 pipeTo 用例同模式），保证 cancel 已生效。 */
        setTimeout(function(){
          var r0 = b[0].getReader();
          r0.read().then(function(x){
            var cancelledBranch = JSON.stringify(x);
            var r1 = b[1].getReader();
            return r1.read().then(function(y){
              _tee3 = cancelledBranch + '|' + JSON.stringify([y.value]);
            });
          });
        }, 0);
        0)", &v));
    /* 取消的分支读返回 done,活跃分支仍读到数据 */
    ASSERT_TRUE(host_poll_until_value(h, "_tee3", "\"done\":true", &v)) << "got: " << v;
    ASSERT_TRUE(host_poll_until_value(h, "_tee3", "\"a\"", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, PipeThroughValidation) {
    std::string v;
    /* pipeThrough 规范校验:transform 缺 readable/writable 或源流已 locked
     * 必须同步抛 TypeError。 */
    ASSERT_TRUE(host_value(h,
        "var e1 = null, e2 = null, e3 = null;\n"
        "var s = new ReadableStream();\n"
        "try { s.pipeThrough({}); } catch(e) { e1 = e.name; }\n"
        "try { s.pipeThrough({readable: new ReadableStream()}); } catch(e) { e2 = e.name; }\n"
        "var s2 = new ReadableStream();\n"
        "s2.getReader();\n"
        "try { s2.pipeThrough({readable: new ReadableStream(), writable: new WritableStream()}); } catch(e) { e3 = e.name; }\n"
        "JSON.stringify([e1, e2, e3])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"TypeError\",\"TypeError\",\"TypeError\"]")) << "got: " << v;
}

TEST_F(PolyfillTest, TextDecoderStreamMultibyte) {
    std::string v;
    /* 3 字节 UTF-8 字符（€ = E2 82 AC）跨 chunk 边界写入 TextDecoderStream：
       第一个 chunk 只含首字节，第二个 chunk 含剩余两字节。writable 两次 write
       必须靠 TextDecoder stream:true 的残留缓冲正确拼接，readable 输出一个字符。
       用 charCodeAt 断言避免 C++/JSON 非 ASCII 编码歧义（0x20AC = 8364）。 */
    ASSERT_TRUE(host_eval(h,
        R"(var _tdec = null;
        var s = new TextDecoderStream('utf-8');
        var writer = s.writable.getWriter();
        var reader = s.readable.getReader();
        var out = '';
        writer.write(new Uint8Array([0xE2]));
        writer.write(new Uint8Array([0x82, 0xAC]));
        writer.close();
        function pump() {
          reader.read().then(function(r){
            if (r.done) { _tdec = JSON.stringify([out.length, out.charCodeAt(0)]); return; }
            out += r.value;
            pump();
          });
        }
        pump();
        0)", &v));
    /* 输出恰好 1 个字符，码点 0x20AC (8364) */
    ASSERT_TRUE(host_poll_until_value(h, "_tdec", "8364", &v)) << "got: " << v;
    ASSERT_TRUE(host_poll_until_value(h, "_tdec", "[1,", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, TextDecoderEdgeCases) {
    std::string v;

    /* 1. 多字节 + 代理对正确解码（€=E2 82 AC；😀=F0 9F 98 80） */
    ASSERT_TRUE(host_value(h,
        "var t = new TextDecoder();\n"
        "JSON.stringify([t.decode(new Uint8Array([0xE2,0x82,0xAC])), t.decode(new Uint8Array([0xF0,0x9F,0x98,0x80]))])", &v));
    EXPECT_NE(std::string::npos, v.find("\"€\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"😀\"")) << "got: " << v;

    /* 2. 非 fatal：非法字节 → U+FFFD (0xFFFD) */
    ASSERT_TRUE(host_value(h,
        "var t = new TextDecoder();\n"
        "var s = t.decode(new Uint8Array([0x41, 0x80]));\n"
        "JSON.stringify([s.length, s.charCodeAt(1)])", &v));
    EXPECT_NE(std::string::npos, v.find("[2,65533]")) << "got: " << v;

    /* 3. fatal:true：遇非法字节应抛 TypeError */
    ASSERT_TRUE(host_value(h,
        "var t = new TextDecoder('utf-8', {fatal:true});\n"
        "var err = null;\n"
        "try { t.decode(new Uint8Array([0x41, 0x80])); } catch(e) { err = String(e); }\n"
        "JSON.stringify([err !== null, /TypeError/.test(err)])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,true]")) << "got: " << v;

    /* 4. 流式半字符：{stream:true} 跨调用残留，后续调用补全出完整字符 */
    ASSERT_TRUE(host_value(h,
        "var t = new TextDecoder();\n"
        "var a = t.decode(new Uint8Array([0xE2]), {stream:true});\n"
        "var b = t.decode(new Uint8Array([0x82, 0xAC]), {stream:true});\n"
        "var c = t.decode();\n"
        "JSON.stringify([a.length, b.charCodeAt(0), c.length])", &v));
    EXPECT_NE(std::string::npos, v.find("[0,8364,0]")) << "got: " << v;

    /* 5. BOM：默认剥离（EF BB BF → 不输出 U+FEFF）；ignoreBOM:true 保留 U+FEFF */
    ASSERT_TRUE(host_value(h,
        "var bom = new Uint8Array([0xEF,0xBB,0xBF,0x41]);\n"
        "var d = new TextDecoder();\n"
        "var d2 = new TextDecoder('utf-8', {ignoreBOM:true});\n"
        "JSON.stringify([d.decode(bom).charCodeAt(0), d2.decode(bom).charCodeAt(0)])", &v));
    EXPECT_NE(std::string::npos, v.find("[65,65279]")) << "got: " << v;  /* 'A', U+FEFF */
}

TEST_F(PolyfillTest, UrlSearchParamsEdgeCases) {
    std::string v;

    /* 1. 解析：重复键、%20 解码、+ 解码为空格 */
    ASSERT_TRUE(host_value(h,
        "var p = new URLSearchParams('a=1&a=2&b=hello%20world&c=x+y');\n"
        "JSON.stringify([p.get('a'), p.getAll('a').join(','), p.get('b'), p.get('c')])", &v));
    EXPECT_NE(std::string::npos, v.find("\"1\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"1,2\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"hello world\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"x y\"")) << "got: " << v;

    /* 2. 编码：空格→+、特殊字符 !'()* → %XX 大写、中文 UTF-8 */
    ASSERT_TRUE(host_value(h,
        "var p = new URLSearchParams();\n"
        "p.set('q', 'a b'); p.set('s', '!\\'()*'); p.set('z', '中文');\n"
        "JSON.stringify(p.toString())", &v));
    EXPECT_NE(std::string::npos, v.find("q=a+b")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("%21%27%28%29%2A")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("%E4%B8%AD%E6%96%87")) << "got: " << v;

    /* 3. append 重复键 + delete + has + toString 顺序 */
    ASSERT_TRUE(host_value(h,
        "var p = new URLSearchParams('a=1&a=2&b=3');\n"
        "p.append('a', '4');\n"
        "var r = [p.getAll('a').length, p.has('b'), p.toString()];\n"
        "p.delete('a');\n"
        "r.push(p.has('a'));\n"
        "JSON.stringify(r)", &v));
    EXPECT_NE(std::string::npos, v.find("3")) << "got: " << v;  /* getAll a length */
    EXPECT_NE(std::string::npos, v.find("true")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("a=4")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("false")) << "got: " << v;

    /* 4. sort() 按键排序 */
    ASSERT_TRUE(host_value(h,
        "var p = new URLSearchParams('c=3&a=1&b=2');\n"
        "p.sort();\n"
        "JSON.stringify(p.toString())", &v));
    EXPECT_NE(std::string::npos, v.find("a=1&b=2&c=3")) << "got: " << v;

    /* 5. 迭代器：for..of / entries / keys / values / forEach */
    ASSERT_TRUE(host_value(h,
        "var p = new URLSearchParams('a=1&b=2');\n"
        "var e = [], k = [], vals = [], f = [];\n"
        "for (var x of p) e.push(x.join(':'));\n"
        "for (var kv of p.entries()) k.push(kv[0]);\n"
        "for (var vv of p.values()) vals.push(vv);\n"
        "p.forEach(function(val, key){ f.push(key+'='+val); });\n"
        "JSON.stringify([e.join(';'), k.join(','), vals.join(','), f.join(';')])", &v));
    EXPECT_NE(std::string::npos, v.find("a:1;b:2")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("a,b")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("1,2")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("a=1;b=2")) << "got: " << v;

    /* 6. URL.searchParams 与 URL.search 双向同步 */
    ASSERT_TRUE(host_value(h,
        "var u = new URL('https://x.com/p?q=1');\n"
        "u.searchParams.set('q', '2');\n"
        "u.searchParams.append('r', '3');\n"
        "var s1 = u.search;\n"
        "u.search = '?x=9';\n"
        "var s2 = u.searchParams.get('x');\n"
        "JSON.stringify([s1, s2])", &v));
    EXPECT_NE(std::string::npos, v.find("q=2")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("r=3")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"9\"")) << "got: " << v;
}

TEST_F(PolyfillTest, StreamEdgeCases) {
    std::string v;

    /* 1. tee() 双分支独立消费：同一 chunk 应同时进入两个分支，互不阻塞 */
    ASSERT_TRUE(host_eval(h,
        R"(var _tee2 = null;
        var s = new ReadableStream({
          start: function(c){ c.enqueue('a'); c.enqueue('b'); c.close(); }
        });
        var b = s.tee();
        var r0 = b[0].getReader();
        var r1 = b[1].getReader();
        r0.read().then(function(x){
          r1.read().then(function(y){
            _tee2 = JSON.stringify([x.value, y.value]);
          });
        });
        0)", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_tee2", "\"a\"", &v)) << "got: " << v;

    /* 2. BYOB reader 对 non-byte stream 抛 TypeError */
    ASSERT_TRUE(host_value(h,
        "var s = new ReadableStream();\n"
        "var err = null;\n"
        "try { s.getReader({mode:'byob'}); } catch(e) { err = String(e); }\n"
        "JSON.stringify([err !== null, /TypeError/.test(err)])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,true]")) << "got: " << v;

    /* 3. cancel() 多次调用幂等：第二次直接返回 resolved，不重复触发源 cancel */
    ASSERT_TRUE(host_eval(h,
        R"(var _cidem = null;
        var cancelCount = 0;
        var s = new ReadableStream({
          start: function(c){ c.enqueue('x'); },
          cancel: function(){ cancelCount++; }
        });
        s.cancel().then(function(){
          return s.cancel();
        }).then(function(){
          _cidem = JSON.stringify([cancelCount, s.locked]);
        });
        0)", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_cidem", "[1,", &v)) << "got: " << v;
    ASSERT_TRUE(host_poll_until_value(h, "_cidem", "false", &v)) << "got: " << v;

    /* 4. locked 时 getReader 抛 TypeError，且 locked 为 true */
    ASSERT_TRUE(host_value(h,
        "var s = new ReadableStream({ start: function(c){ c.enqueue('x'); } });\n"
        "var r = s.getReader();\n"
        "var err = null;\n"
        "try { s.getReader(); } catch(e) { err = String(e); }\n"
        "JSON.stringify([err !== null, /TypeError/.test(err), s.locked])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,true,true]")) << "got: " << v;
}

TEST_F(PolyfillTest, EventTargetEdgeCases) {
    std::string v;

    /* 1. {once:true} 触发一次后自动移除 */
    ASSERT_TRUE(host_value(h,
        "var et = new EventTarget();\n"
        "var count = 0;\n"
        "et.addEventListener('x', function(){ count++; }, {once:true});\n"
        "et.dispatchEvent(new Event('x'));\n"
        "et.dispatchEvent(new Event('x'));\n"
        "JSON.stringify(count)", &v));
    EXPECT_NE(std::string::npos, v.find("1")) << "got: " << v;

    /* 2. 重复添加相同回调不重复注册 */
    ASSERT_TRUE(host_value(h,
        "var et = new EventTarget();\n"
        "var count = 0;\n"
        "var fn = function(){ count++; };\n"
        "et.addEventListener('x', fn);\n"
        "et.addEventListener('x', fn);\n"
        "et.dispatchEvent(new Event('x'));\n"
        "JSON.stringify(count)", &v));
    EXPECT_NE(std::string::npos, v.find("1")) << "got: " << v;

    /* 3. removeEventListener 移除后不再触发 */
    ASSERT_TRUE(host_value(h,
        "var et = new EventTarget();\n"
        "var count = 0;\n"
        "var fn = function(){ count++; };\n"
        "et.addEventListener('x', fn);\n"
        "et.removeEventListener('x', fn);\n"
        "et.dispatchEvent(new Event('x'));\n"
        "JSON.stringify(count)", &v));
    EXPECT_NE(std::string::npos, v.find("0")) << "got: " << v;

    /* 4. dispatchEvent 返回值：默认阻止返回 false，否则 true */
    ASSERT_TRUE(host_value(h,
        "var et = new EventTarget();\n"
        "var ev = new Event('x', {cancelable:true});\n"
        "et.addEventListener('x', function(e){ e.preventDefault(); });\n"
        "var r1 = et.dispatchEvent(ev);\n"
        "var r2 = et.dispatchEvent(new Event('y'));\n"
        "JSON.stringify([r1, r2])", &v));
    EXPECT_NE(std::string::npos, v.find("[false,true]")) << "got: " << v;

    /* 5. AbortSignal abort 后 addEventListener 立即回调（微任务调度） */
    ASSERT_TRUE(host_eval(h,
        "var _et5 = null;\n"
        "var ac = new AbortController();\n"
        "ac.abort();\n"
        "var called = false;\n"
        "ac.signal.addEventListener('abort', function(){ called = true; _et5 = JSON.stringify([called, ac.signal.aborted]); });\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_et5", "[true,true]", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, BlobEdgeCases) {
    std::string v;

    /* 1. blobParts 非对象/无 @@iterator → TypeError；undefined → 空 Blob */
    ASSERT_TRUE(host_value(h,
        "function t(x){ try { new Blob(x); return false; } catch(e){ return /TypeError/.test(String(e)); } }\n"
        "var r = [t(null), t(true), t(0), t('fail'), t({}), t(new Date())];\n"
        "var empty = new Blob(undefined);\n"
        "r.push([empty.size, empty.type]);\n"
        "JSON.stringify(r)", &v));
    EXPECT_NE(std::string::npos, v.find("[true,true,true,true,true,true,[0,\"\"]]")) << "got: " << v;

    /* 2. type 规范化：只去 0x09/0x0A/0x0D，保留空格；`' image/gif '` 保留空格 */
    ASSERT_TRUE(host_value(h,
        "var a = new Blob(['x'], {type: ' Image/GIF '});\n"
        "var b = new Blob(['x'], {type: '\\timage/gif\\t'});\n"
        "JSON.stringify([a.type, b.type])", &v));
    EXPECT_NE(std::string::npos, v.find("\" image/gif \"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"image/gif\"")) << "got: " << v;

    /* 3. 字符串元素 UTF-8 编码：非 ASCII 内容 text() 应正确 */
    ASSERT_TRUE(host_eval(h,
        R"(var _bt = null;
        var b = new Blob(['€']);
        b.text().then(function(s){ _bt = JSON.stringify([s.length, s.charCodeAt(0)]); });
        0)", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_bt", "[1,8364]", &v)) << "got: " << v;

    /* 4. slice 负值/小数 + contentType */
    ASSERT_TRUE(host_eval(h,
        R"(var _bs = null;
        var b = new Blob(['0123456789']);
        var s = b.slice(-3, -1, 'text/plain');
        s.text().then(function(t){ _bs = JSON.stringify([t, s.type, s.size]); });
        0)", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_bs", "\"78\"", &v)) << "got: " << v;

    /* 5. arrayBuffer() + json() */
    ASSERT_TRUE(host_eval(h,
        R"(var _bj = null;
        var b = new Blob(['{"k":1}']);
        b.json().then(function(o){ _bj = JSON.stringify([o.k, b.size]); });
        0)", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_bj", "[1,", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, HeadersEdgeCases) {
    std::string v;

    /* 1. 构造：undefined/空对象/序列/record/拷贝 */
    ASSERT_TRUE(host_value(h,
        "var h1 = new Headers();\n"
        "var h2 = new Headers(undefined);\n"
        "var h3 = new Headers({});\n"
        "var h4 = new Headers([['a','1'],['b','2']]);\n"
        "var h5 = new Headers({x:'3'});\n"
        "var h6 = new Headers(h4);\n"
        "JSON.stringify([h1.get('a'), h4.get('a'), h4.get('b'), h5.get('x'), h6.get('a')])", &v));
    EXPECT_NE(std::string::npos, v.find("[null,\"1\",\"2\",\"3\",\"1\"]")) << "got: " << v;

    /* 2. append/set/get/has/delete + 大小写不敏感 + 逗号合并 */
    ASSERT_TRUE(host_value(h,
        "var h = new Headers();\n"
        "h.append('X-Key', 'a');\n"
        "h.append('x-key', 'b');\n"
        "var g = h.get('x-key');\n"
        "h.set('X-Key', 'c');\n"
        "var afterSet = h.get('x-key');\n"
        "var has = h.has('X-KEY');\n"
        "h.delete('x-key');\n"
        "var afterDel = h.get('x-key');\n"
        "JSON.stringify([g, afterSet, has, afterDel])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"a, b\",\"c\",true,null]")) << "got: " << v;

    /* 3. 迭代器：keys/values/entries/Symbol.iterator/forEach */
    ASSERT_TRUE(host_value(h,
        "var h = new Headers([['a','1'],['b','2']]);\n"
        "var ks = [], vs = [], es = [];\n"
        "for (var k of h.keys()) ks.push(k);\n"
        "for (var vv of h.values()) vs.push(vv);\n"
        "for (var e of h.entries()) es.push(e.join(':'));\n"
        "var f = []; h.forEach(function(v,k){ f.push(k+'='+v); });\n"
        "var it = h[Symbol.iterator]();\n"
        "JSON.stringify([ks.join(','), vs.join(','), es.join(';'), f.join(';'), it.next().value.join(':')])", &v));
    EXPECT_NE(std::string::npos, v.find("a,b")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("1,2")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("a:1;b:2")) << "got: " << v;

    /* 4. new Headers(null) 抛 TypeError；3 元素 pair 抛 TypeError */
    ASSERT_TRUE(host_value(h,
        "function t(f){ try { f(); return false; } catch(e){ return /TypeError/.test(String(e)); } }\n"
        "var r = [t(function(){ new Headers(null); }),\n"
        "         t(function(){ new Headers([['a','b','c']]); }),\n"
        "         t(function(){ new Headers([['name']]); })];\n"
        "JSON.stringify(r)", &v));
    EXPECT_NE(std::string::npos, v.find("[true,true,true]")) << "got: " << v;

    /* 5. 非法 name/value 抛 TypeError */
    ASSERT_TRUE(host_value(h,
        "function t(f){ try { f(); return false; } catch(e){ return /TypeError/.test(String(e)); } }\n"
        "var h = new Headers();\n"
        "var r = [t(function(){ h.set('bad name', 'v'); }),\n"
        "         t(function(){ h.set('ok', '\\x00'); })];\n"
        "JSON.stringify(r)", &v));
    EXPECT_NE(std::string::npos, v.find("[true,true]")) << "got: " << v;
}

TEST_F(PolyfillTest, EncodeIntoEdgeCases) {
    std::string v;
    /* read/written 精确语义（对齐 WPT encodeInto.any.js 数据向量） */
    ASSERT_TRUE(host_value(h,
        "function enc(s, len) {\n"
        "  var buf = new ArrayBuffer(64);\n"
        "  var view = new Uint8Array(buf, 0, len);\n"
        "  var r = new TextEncoder().encodeInto(s, view);\n"
        "  return JSON.stringify([r.read, r.written, Array.from(view.subarray(0, r.written))]);\n"
        "}\n"
        "JSON.stringify([enc('Hi', 0), enc('A', 10), enc('\\u{1D306}', 4), enc('\\u{1D306}A', 3)])", &v));
    EXPECT_NE(std::string::npos, v.find("[0,0,[]]")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("[1,1,[65]]")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("[2,4,[240,157,140,134]]")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("[0,0,[]]")) << "got: " << v;

    /* 孤立代理对 → U+FFFD (EF BF BD)；有效代理对完整 4 字节 */
    ASSERT_TRUE(host_value(h,
        "function enc(s, len) {\n"
        "  var view = new Uint8Array(new ArrayBuffer(64), 0, len);\n"
        "  var r = new TextEncoder().encodeInto(s, view);\n"
        "  return JSON.stringify([r.read, r.written, Array.from(view.subarray(0, r.written))]);\n"
        "}\n"
        "var loneHi = enc('\\uD834A', 10);\n"
        "var loneLo = enc('A\\uDF06', 4);\n"
        "JSON.stringify([loneHi, loneLo])", &v));
    EXPECT_NE(std::string::npos, v.find("[2,4,[239,191,189,65]]")) << "got: " << v;  /* U+FFFD + 'A' */
    EXPECT_NE(std::string::npos, v.find("[2,4,[65,239,191,189]]")) << "got: " << v;  /* 'A' + U+FFFD */

    /* 非 Uint8Array 目标（DataView/Int8Array/ArrayBuffer）抛 TypeError */
    ASSERT_TRUE(host_value(h,
        "function t(f){ try { f(); return false; } catch(e){ return /TypeError/.test(String(e)); } }\n"
        "var te = new TextEncoder();\n"
        "var r = [t(function(){ te.encodeInto('x', new DataView(new ArrayBuffer(4))); }),\n"
        "         t(function(){ te.encodeInto('x', new Int8Array(4)); }),\n"
        "         t(function(){ te.encodeInto('x', new ArrayBuffer(4)); })];\n"
        "JSON.stringify(r)", &v));
    EXPECT_NE(std::string::npos, v.find("[true,true,true]")) << "got: " << v;

    /* 多字节字符无法完整放入剩余空间时不部分写入（read 停在前一个完整字符） */
    ASSERT_TRUE(host_value(h,
        "var view = new Uint8Array(new ArrayBuffer(3), 0, 3);\n"
        "var r = new TextEncoder().encodeInto('A\\u{1D306}', view);\n"
        "JSON.stringify([r.read, r.written, Array.from(view)])", &v));
    EXPECT_NE(std::string::npos, v.find("[1,1,[65,0,0]]")) << "got: " << v;

    /* 6. DOMString 转换：非字符串输入应 String() 后编码（undefined→'undefined'） */
    ASSERT_TRUE(host_value(h,
        "var view = new Uint8Array(new ArrayBuffer(64), 0, 64);\n"
        "var r = new TextEncoder().encodeInto(123, view);\n"
        "JSON.stringify([r.read, r.written, Array.from(view.subarray(0, r.written))])", &v));
    EXPECT_NE(std::string::npos, v.find("[3,3,[49,50,51]]")) << "got: " << v;  /* '1','2','3' */
}

TEST_F(PolyfillTest, RandomUuidAndNavigator) {
    std::string v;

    /* 1. crypto.randomUUID() 返回 v4 UUID 格式 */
    ASSERT_TRUE(host_value(h,
        "var u = crypto.randomUUID();\n"
        "JSON.stringify([typeof u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u), u.length])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"string\",true,36]")) << "got: " << v;

    /* 2. 多次调用不同 */
    ASSERT_TRUE(host_value(h,
        "var a = crypto.randomUUID(); var b = crypto.randomUUID();\n"
        "JSON.stringify(a !== b)", &v));
    EXPECT_NE(std::string::npos, v.find("true")) << "got: " << v;

    /* 3. navigator.userAgent 非空 string */
    ASSERT_TRUE(host_value(h,
        "JSON.stringify([typeof navigator, typeof navigator.userAgent, navigator.userAgent.length > 0])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"object\",\"string\",true]")) << "got: " << v;
}

TEST_F(PolyfillTest, EventTargetAdvanced) {
    std::string v;

    /* 1. composedPath 返回数组含 target */
    ASSERT_TRUE(host_value(h,
        "var et = new EventTarget(); var ev = new Event('x');\n"
        "var p = et.dispatchEvent(ev) || 1;\n"
        "var cp = ev.composedPath();\n"
        "JSON.stringify([Array.isArray(cp), cp.length >= 0])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,true]")) << "got: " << v;

    /* 2. stopImmediatePropagation：后续监听器不触发 */
    ASSERT_TRUE(host_value(h,
        "var et = new EventTarget(); var order = [];\n"
        "et.addEventListener('x', function(e){ order.push('a'); e.stopImmediatePropagation(); });\n"
        "et.addEventListener('x', function(e){ order.push('b'); });\n"
        "et.dispatchEvent(new Event('x'));\n"
        "JSON.stringify(order)", &v));
    EXPECT_NE(std::string::npos, v.find("[\"a\"]")) << "got: " << v;

    /* 3. capture 监听器先于 bubble 触发 */
    ASSERT_TRUE(host_value(h,
        "var et = new EventTarget(); var order = [];\n"
        "et.addEventListener('x', function(){ order.push('bubble'); });\n"
        "et.addEventListener('x', function(){ order.push('capture'); }, {capture:true});\n"
        "et.dispatchEvent(new Event('x'));\n"
        "JSON.stringify(order)", &v));
    EXPECT_NE(std::string::npos, v.find("\"capture\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("[\"capture\",\"bubble\"]")) << "got: " << v;

    /* 4. 子类化：class extends EventTarget */
    ASSERT_TRUE(host_value(h,
        "var Cls = class extends EventTarget { constructor(){ super(); } };\n"
        "var o = new Cls(); var hit = false;\n"
        "o.addEventListener('y', function(){ hit = true; });\n"
        "o.dispatchEvent(new Event('y'));\n"
        "JSON.stringify([o instanceof EventTarget, hit])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,true]")) << "got: " << v;
}

TEST_F(PolyfillTest, PerformanceApi) {
    std::string v;

    /* 1. now() 返回 number，单调递增 */
    ASSERT_TRUE(host_value(h,
        "var t1 = performance.now(); var t2 = performance.now();\n"
        "JSON.stringify([typeof t1, t1 >= 0, t2 >= t1])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"number\",true,true]")) << "got: " << v;

    /* 2. mark() + getEntries/getEntriesByType('mark') */
    ASSERT_TRUE(host_value(h,
        "performance.mark('a'); performance.mark('b');\n"
        "var marks = performance.getEntriesByType('mark');\n"
        "JSON.stringify([marks.length >= 2, marks[0].name, marks[0].entryType])", &v));
    EXPECT_NE(std::string::npos, v.find("true")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"mark\"")) << "got: " << v;

    /* 3. measure() + getEntriesByType('measure') */
    ASSERT_TRUE(host_value(h,
        "performance.mark('start'); performance.mark('end');\n"
        "performance.measure('dur', 'start', 'end');\n"
        "var ms = performance.getEntriesByType('measure');\n"
        "JSON.stringify([ms.length >= 1, ms[0].name, ms[0].entryType, ms[0].duration >= 0])", &v));
    EXPECT_NE(std::string::npos, v.find("\"dur\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"measure\"")) << "got: " << v;

    /* 4. clearMarks() 清除 mark 条目 */
    ASSERT_TRUE(host_value(h,
        "performance.mark('x'); performance.clearMarks('x');\n"
        "JSON.stringify(performance.getEntriesByType('mark').filter(function(e){ return e.name === 'x'; }).length)", &v));
    EXPECT_NE(std::string::npos, v.find("0")) << "got: " << v;
}

TEST_F(PolyfillTest, AbortSignalStatic) {
    std::string v;

    /* 1. AbortSignal.abort() 返回已 aborted 的 signal */
    ASSERT_TRUE(host_value(h,
        "var s = AbortSignal.abort('boom');\n"
        "JSON.stringify([s.aborted, s.reason])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"boom\"")) << "got: " << v;

    /* 2. throwIfAborted：未 aborted 不抛，aborted 抛 */
    ASSERT_TRUE(host_value(h,
        "var s1 = new AbortController().signal;\n"
        "var s2 = AbortSignal.abort('err');\n"
        "var r1 = false, r2 = false;\n"
        "try { s1.throwIfAborted(); r1 = true; } catch(e) {}\n"
        "try { s2.throwIfAborted(); } catch(e) { r2 = true; }\n"
        "JSON.stringify([r1, r2])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,true]")) << "got: " << v;

    /* 3. AbortSignal.any([signal])：任一 abort 则组合 signal abort */
    ASSERT_TRUE(host_value(h,
        "var ac = new AbortController();\n"
        "var combined = AbortSignal.any([ac.signal]);\n"
        "var before = combined.aborted;\n"
        "ac.abort('reason1');\n"
        "JSON.stringify([before, combined.aborted, combined.reason])", &v));
    EXPECT_NE(std::string::npos, v.find("[false,true,")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"reason1\"")) << "got: " << v;

    /* 4. AbortSignal.timeout(ms)：超时后 signal abort（异步轮询） */
    ASSERT_TRUE(host_eval(h,
        "var _at = null;\n"
        "var s = AbortSignal.timeout(50);\n"
        "s.addEventListener('abort', function(){ _at = JSON.stringify([s.aborted, s.reason instanceof DOMException]); });\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_at", "[true,true]", &v, 3000)) << "got: " << v;
}

TEST_F(PolyfillTest, UrlSearchParamsBoundary) {
    std::string v;

    /* 1. searchParams 同一性：同一 url 多次取返回同一对象 */
    ASSERT_TRUE(host_value(h,
        "var u = new URL('https://x.com/p?a=1');\n"
        "JSON.stringify(u.searchParams === u.searchParams)", &v));
    EXPECT_NE(std::string::npos, v.find("true")) << "got: " << v;

    /* 2. strict 模式下 searchParams 赋值抛 TypeError（getter-only） */
    ASSERT_TRUE(host_value(h,
        "var u = new URL('https://x.com/p?a=1');\n"
        "var err = null;\n"
        "try { (function(){ 'use strict'; u.searchParams = new URLSearchParams(); })(); }\n"
        "catch(e) { err = String(e); }\n"
        "JSON.stringify([err !== null, /TypeError/.test(err)])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,true]")) << "got: " << v;

    /* 3. search='??a=b'：searchParams 解析出 a=b（url.js 简化实现不编码多余 ?，
     *     WPT 期望 ?%3Fa=b，需完整 URL 解析，高难度，已知限制） */
    ASSERT_TRUE(host_value(h,
        "var u = new URL('https://x.com/p');\n"
        "u.search = '??a=b';\n"
        "JSON.stringify([u.searchParams.get('a'), u.search.length > 0])", &v));
    EXPECT_NE(std::string::npos, v.find("\"b\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("true")) << "got: " << v;

    /* 4. searchParams 修改反向同步到 url.search */
    ASSERT_TRUE(host_value(h,
        "var u = new URL('https://x.com/p');\n"
        "u.searchParams.set('q', 'hello world');\n"
        "JSON.stringify(u.search)", &v));
    EXPECT_NE(std::string::npos, v.find("q=hello+world")) << "got: " << v;
}

TEST_F(PolyfillTest, QueueMicrotask) {
    std::string v;
    /* 1. 存在 + 类型校验：非函数参数抛 TypeError */
    ASSERT_TRUE(host_value(h,
        "var r = [typeof queueMicrotask];\n"
        "var err = null;\n"
        "try { queueMicrotask(123); } catch(e) { err = String(e); }\n"
        "r.push(err !== null, /TypeError/.test(err));\n"
        "JSON.stringify(r)", &v));
    EXPECT_NE(std::string::npos, v.find("[\"function\",true,true]")) << "got: " << v;

    /* 2. 微任务在同步代码之后、按注册顺序执行 */
    ASSERT_TRUE(host_eval(h,
        "var _qm = null;\n"
        "var order = [];\n"
        "queueMicrotask(function(){ order.push('a'); });\n"
        "queueMicrotask(function(){ order.push('b'); });\n"
        "order.push('sync');\n"
        "queueMicrotask(function(){ _qm = JSON.stringify(order); });\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_qm", "\"sync\"", &v)) << "got: " << v;
    ASSERT_TRUE(host_poll_until_value(h, "_qm", "\"a\"", &v)) << "got: " << v;
    ASSERT_TRUE(host_poll_until_value(h, "_qm", "\"b\"", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, BtoaAtobEdgeCases) {
#if QZ_WITH_TEXTCODEC
    std::string v;
    /* 1. btoa 非 Latin1 字符抛错（> 0xFF） */
    ASSERT_TRUE(host_value(h,
        "var err = null; try { btoa('\\u0100'); } catch(e) { err = String(e); }\n"
        "JSON.stringify([err !== null, err.length > 0])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,true]")) << "got: " << v;

    /* 2. atob 非法 base64 抛错 */
    ASSERT_TRUE(host_value(h,
        "var err = null; try { atob('!!!invalid'); } catch(e) { err = String(e); }\n"
        "JSON.stringify([err !== null, err.length > 0])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,true]")) << "got: " << v;

    /* 3. 往返一致性：btoa → atob 还原原串 */
    ASSERT_TRUE(host_value(h,
        "var s = 'Hello, World!';\n"
        "var encoded = btoa(s); var decoded = atob(encoded);\n"
        "JSON.stringify([decoded, decoded === s])", &v));
    EXPECT_NE(std::string::npos, v.find("\"Hello, World!\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("true")) << "got: " << v;

    /* 4. 空串往返 */
    ASSERT_TRUE(host_value(h,
        "JSON.stringify([btoa(''), atob('')])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"\",\"\"]")) << "got: " << v;
#else
    /* textcodec OFF：API 必须抛 TypeError（含 build 错误提示），不再有 JS 查表 */
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var errs = [];\n"
        "try { btoa('hi'); } catch(e) { errs.push(String(e)); }\n"
        "try { atob('aGk='); } catch(e) { errs.push(String(e)); }\n"
        "JSON.stringify(errs)", &v));
    EXPECT_NE(std::string::npos, v.find("QZ_WITH_TEXTCODEC")) << "got: " << v;
#endif
}

TEST_F(PolyfillTest, StructuredCloneDeepTypes) {
    std::string v;
    /* 1. Date 深拷贝：新对象，值相等 */
    ASSERT_TRUE(host_value(h,
        "var d = new Date(1234567890); var c = structuredClone(d);\n"
        "JSON.stringify([c instanceof Date, c.getTime() === d.getTime(), c !== d])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,true,true]")) << "got: " << v;

    /* 2. Map 深拷贝：键值深拷贝 */
    ASSERT_TRUE(host_value(h,
        "var m = new Map([['k', {v: 1}]]); var c = structuredClone(m);\n"
        "JSON.stringify([c instanceof Map, c.size, c.get('k').v])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,1,1]")) << "got: " << v;

    /* 3. Set 深拷贝 */
    ASSERT_TRUE(host_value(h,
        "var s = new Set([1, 2, 3]); var c = structuredClone(s);\n"
        "JSON.stringify([c instanceof Set, c.size, c.has(2)])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,3,true]")) << "got: " << v;

    /* 4. RegExp 深拷贝 */
    ASSERT_TRUE(host_value(h,
        "var r = /test/gi; var c = structuredClone(r);\n"
        "JSON.stringify([c instanceof RegExp, c.source, c.flags, c !== r])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,\"test\",\"gi\",true]")) << "got: " << v;

    /* 5. 循环引用：不无限递归，保持自引用 */
    ASSERT_TRUE(host_value(h,
        "var a = {x: 1}; a.self = a; var c = structuredClone(a);\n"
        "JSON.stringify([c.x, c.self === c, c.self !== a])", &v));
    EXPECT_NE(std::string::npos, v.find("[1,true,true]")) << "got: " << v;

    /* 6. 嵌套对象深拷贝：修改副本不影响原 */
    ASSERT_TRUE(host_value(h,
        "var orig = {nested: {val: 10}}; var c = structuredClone(orig);\n"
        "c.nested.val = 99;\n"
        "JSON.stringify([orig.nested.val, c.nested.val])", &v));
    EXPECT_NE(std::string::npos, v.find("[10,99]")) << "got: " << v;
}

TEST_F(PolyfillTest, DomException) {
    std::string v;
    /* 1. 构造器 + name/code 映射 + 继承 Error */
    ASSERT_TRUE(host_value(h,
        "var e = new DOMException('aborted', 'AbortError');\n"
        "JSON.stringify([e.message, e.name, e.code, e instanceof Error])", &v));
    EXPECT_NE(std::string::npos, v.find("\"aborted\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"AbortError\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find(",20,true]")) << "got: " << v;

    /* 2. 默认 name='Error', code=0 */
    ASSERT_TRUE(host_value(h,
        "var e = new DOMException('oops');\n"
        "JSON.stringify([e.name, e.code])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"Error\",0]")) << "got: " << v;

    /* 3. 常见 code 映射 */
    ASSERT_TRUE(host_value(h,
        "JSON.stringify([new DOMException('','NotSupportedError').code,\n"
        "  new DOMException('','InvalidStateError').code,\n"
        "  new DOMException('','SecurityError').code])", &v));
    EXPECT_NE(std::string::npos, v.find("[9,11,18]")) << "got: " << v;
}

TEST_F(PolyfillTest, BroadcastChannel) {
    std::string v;
    /* 1. 存在 + name 属性 */
    ASSERT_TRUE(host_value(h,
        "var bc = new BroadcastChannel('test-ch');\n"
        "JSON.stringify([typeof BroadcastChannel, bc.name])", &v));
    EXPECT_NE(std::string::npos, v.find("\"function\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"test-ch\"")) << "got: " << v;

    /* 2. postMessage：同名 channel 收到 message 事件（同步 dispatch） */
    ASSERT_TRUE(host_value(h,
        "var rcv = new BroadcastChannel('ch2'); var got = null;\n"
        "rcv.onmessage = function(e){ got = [e.data, e.type]; };\n"
        "var snd = new BroadcastChannel('ch2');\n"
        "snd.postMessage({hello: 'world'});\n"
        "JSON.stringify([got !== null, got[0] && got[0].hello, got[1]])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,\"world\",\"message\"]")) << "got: " << v;

    /* 3. 不同名 channel 不收到 */
    ASSERT_TRUE(host_value(h,
        "var rcv = new BroadcastChannel('chA'); var got = false;\n"
        "rcv.onmessage = function(){ got = true; };\n"
        "new BroadcastChannel('chB').postMessage('x');\n"
        "JSON.stringify(got)", &v));
    EXPECT_NE(std::string::npos, v.find("false")) << "got: " << v;

    /* 4. close()：关闭后不收到消息 */
    ASSERT_TRUE(host_value(h,
        "var rcv = new BroadcastChannel('ch3'); var got = false;\n"
        "rcv.onmessage = function(){ got = true; };\n"
        "rcv.close();\n"
        "new BroadcastChannel('ch3').postMessage('x');\n"
        "JSON.stringify(got)", &v));
    EXPECT_NE(std::string::npos, v.find("false")) << "got: " << v;
}

TEST_F(PolyfillTest, PerformanceObserver) {
    std::string v;
    /* 1. 存在 */
    ASSERT_TRUE(host_value(h, "JSON.stringify(typeof PerformanceObserver)", &v));
    EXPECT_NE(std::string::npos, v.find("\"function\"")) << "got: " << v;

    /* 2. observe + mark → callback 收到 entry（微任务） */
    ASSERT_TRUE(host_eval(h,
        "var _po = null;\n"
        "var obs = new PerformanceObserver(function(list){\n"
        "  var entries = list.getEntries();\n"
        "  _po = JSON.stringify([entries.length, entries[0].name, entries[0].entryType]);\n"
        "});\n"
        "obs.observe({entryTypes:['mark']});\n"
        "performance.mark('test-mark');\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_po", "\"test-mark\"", &v, 3000)) << "got: " << v;
    ASSERT_TRUE(host_poll_until_value(h, "_po", "\"mark\"", &v, 3000)) << "got: " << v;

    /* 3. disconnect 后不收到 */
    ASSERT_TRUE(host_eval(h,
        "var _po2 = 'none';\n"
        "var obs2 = new PerformanceObserver(function(){ _po2 = 'received'; });\n"
        "obs2.observe({entryTypes:['mark']});\n"
        "obs2.disconnect();\n"
        "performance.mark('after-disconnect');\n"
        "JSON.stringify(_po2)", &v));
    /* host_eval 返回 JSON 包装的字符串，v 形如 "\"none\""（JSON 串内嵌 JSON 串）
     * 但实际内容包含 "none" 子串（无引号），所以查找 none 即可。 */
    EXPECT_NE(std::string::npos, v.find("none")) << "got: " << v;
}

TEST_F(PolyfillTest, CacheStorageEdgeCases) {
    std::string v;
    /* 1. caches 全局存在。CacheStorage 是纯 JS lazy 模块（index.js lazyUnit
     * 无条件注册），无 QZ_WITH_* 编译开关、任何构建恒存在——无条件硬断言，
     * 不做运行时探测 skip。 */
    ASSERT_TRUE(host_value(h, "JSON.stringify(typeof caches)", &v));
    EXPECT_NE(std::string::npos, v.find("\"object\"")) << "got: " << v;

    /* 2. open → put → match → text */
    ASSERT_TRUE(host_eval(h,
        "var _cs = null;\n"
        "caches.open('v1').then(function(cache){\n"
        "  return cache.put(\"https://x.com/a\", new Response('body'));\n"
        "}).then(function(){\n"
        "  return caches.open('v1');\n"
        "}).then(function(cache){\n"
        "  return cache.match(\"https://x.com/a\");\n"
        "}).then(function(resp){\n"
        "  return resp.text().then(function(t){ return [t, resp.status]; });\n"
        "}).then(function(arr){\n"
        "  _cs = JSON.stringify(arr);\n"
        "}).catch(function(e){\n"
        "  _cs = 'err:' + String(e);\n"
        "});\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_cs", "\"body\"", &v, 3000)) << "got: " << v;
}

// ================================================================
// EventSource — 完整 WHATWG 语义（mock 流式数据源：patch __native__.
// httpRequestStream 捕获回调，直接喂状态码/数据块/结束，不发起真实连接）
// ================================================================

TEST_F(PolyfillTest, EventSourceParsing) {
    std::string v;
    /* patch httpRequestStream 捕获回调；记录消息（onmessage 只接 message 类型，
     * addEventListener('custom') 接自定义事件名）。 */
    ASSERT_TRUE(host_value(h,
        "var _esConns = [];\n"
        "__native__.httpRequestStream = function(url, method, headers, body, onHeaders, onData, onEnd) {\n"
        "  _esConns.push({url:url, headers:headers, onHeaders:onHeaders, onData:onData, onEnd:onEnd});\n"
        "  return 0;\n"
        "};\n"
        "var _rec = ''; var _om = 0; var _open = 0;\n"
        "var es = new EventSource('http://x/stream');\n"
        "es.onopen = function(){ _open++; };\n"
        "es.onmessage = function(){ _om++; };\n"
        "es.addEventListener('message', function(ev){\n"
        "  _rec += 'M[' + ev.data.replace(/\\n/g, '<LF>') + '|' + ev.lastEventId + '|' + ev.origin + '];';\n"
        "});\n"
        "es.addEventListener('custom', function(ev){\n"
        "  _rec += 'C[' + ev.data.replace(/\\n/g, '<LF>') + '|' + ev.lastEventId + '];';\n"
        "});\n"
        "JSON.stringify(typeof EventSource)", &v));
    /* EventSource 是纯 JS lazy 模块（index.js lazyUnit 无条件注册），无
     * QZ_WITH_* 编译开关、任何构建恒存在——无条件硬断言，不做运行时探测。 */
    EXPECT_NE(std::string::npos, v.find("\"function\"")) << "got: " << v;

    /* 200 + 分块喂入：BOM / 注释 / CRLF / CR / LF / 多 data 行 / 空 data /
     * 自定义 event / id / 跨 chunk 字段拆分。 */
    ASSERT_TRUE(host_value(h,
        "_esConns[0].onHeaders(200, '{}');\n"
        "_esConns[0].onData(new TextEncoder().encode('\\uFEFF:comment\\r\\nevent: custom\\rdata: alpha\\r').buffer);\n"
        "_esConns[0].onData(new TextEncoder().encode('id: 7\\r\\ndata:  beta\\ndata:ga').buffer);\n"
        "_esConns[0].onData(new TextEncoder().encode('mma\\n\\ndata:\\n\\ndata: multi\\n').buffer);\n"
        "_esConns[0].onData(new TextEncoder().encode('data: line\\n\\n').buffer);\n"
        "es.close();\n"
        "JSON.stringify([_rec, _om, _open])", &v));
    /* 事件1：event: custom + 多 data 行（"alpha\\n beta\\ngamma"，data: 只剥一个空格）+ id=7 */
    EXPECT_NE(std::string::npos, v.find("C[alpha<LF> beta<LF>gamma|7]")) << "got: " << v;
    /* 事件2：data: 空值 → 空串消息（仍触发 onmessage），lastEventId 沿用 7，origin 序列化 */
    EXPECT_NE(std::string::npos, v.find("M[|7|http://x]")) << "got: " << v;
    /* 事件3：跨 chunk 拆分的 data 行连接成 "multi\\nline" */
    EXPECT_NE(std::string::npos, v.find("M[multi<LF>line|7|http://x]")) << "got: " << v;
    /* onmessage 只统计 message 类型（2 次，custom 走 addEventListener）；open 触发一次 */
    EXPECT_NE(std::string::npos, v.find(",2,1]")) << "got: " << v;
}

TEST_F(PolyfillTest, EventSourceEventTarget) {
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var _esConns = [];\n"
        "__native__.httpRequestStream = function(url, method, headers, body, onHeaders, onData, onEnd) {\n"
        "  _esConns.push({onHeaders:onHeaders, onData:onData, onEnd:onEnd}); return 0;\n"
        "};\n"
        "var es = new EventSource('http://x/s');\n"
        "var _l = 0;\n"
        "es.addEventListener('open', function(){ _l++; });\n"
        "es.onopen = function(){ _l += 10; };\n"
        "JSON.stringify([es instanceof EventTarget,\n"
        "  typeof es.dispatchEvent, typeof es.removeEventListener,\n"
        "  es.readyState, es.CONNECTING, es.OPEN, es.CLOSED])", &v));
    /* EventTarget 继承 + 方法存在 + readyState 初始 CONNECTING(0) */
    EXPECT_NE(std::string::npos, v.find("[true,\"function\",\"function\",0,0,1,2]")) << "got: " << v;
    /* 200 → open 事件：addEventListener + onopen 都收到（1 + 10）；readyState OPEN(1) */
    ASSERT_TRUE(host_value(h,
        "_esConns[0].onHeaders(200, '{}');\n"
        "JSON.stringify([_l, es.readyState])", &v));
    EXPECT_NE(std::string::npos, v.find("[11,1]")) << "got: " << v;
    /* close() → CLOSED(2)；随后 onEnd 不触发重连（_esConns 仍 1 个连接） */
    ASSERT_TRUE(host_value(h,
        "es.close();\n"
        "_esConns[0].onEnd(0);\n"
        "JSON.stringify([es.readyState, _esConns.length])", &v));
    EXPECT_NE(std::string::npos, v.find("[2,1]")) << "got: " << v;
}

TEST_F(PolyfillTest, EventSourceReconnectLastEventId) {
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var _esConns = [];\n"
        "__native__.httpRequestStream = function(url, method, headers, body, onHeaders, onData, onEnd) {\n"
        "  _esConns.push({url:url, headers:headers, onHeaders:onHeaders, onData:onData, onEnd:onEnd}); return 0;\n"
        "};\n"
        "var _err = 0; var _data = '';\n"
        "var es = new EventSource('http://x/s');\n"
        "es.onerror = function(){ _err++; };\n"
        "es.onmessage = function(ev){ _data += ev.data + '|' + ev.lastEventId + ';'; };\n"
        "0", &v));
    /* 首连 200：retry: 10 缩短重连延时；id: 42 + data */
    ASSERT_TRUE(host_value(h,
        "_esConns[0].onHeaders(200, '{}');\n"
        "_esConns[0].onData(new TextEncoder().encode('retry: 10\\nid: 42\\ndata: hello\\n\\n').buffer);\n"
        "JSON.stringify([_data, _err, es.readyState])", &v));
    EXPECT_NE(std::string::npos, v.find("hello|42;")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find(",0,1]")) << "got: " << v;   /* 无 error，OPEN */
    /* onEnd → 重连：error 事件 + readyState CONNECTING(0) */
    ASSERT_TRUE(host_value(h,
        "_esConns[0].onEnd(0);\n"
        "JSON.stringify([_err, es.readyState])", &v));
    EXPECT_NE(std::string::npos, v.find("[1,0]")) << "got: " << v;
    /* 轮询第二次连接（retry 10ms）；第二次请求带 Last-Event-ID: 42 */
    ASSERT_TRUE(host_poll_until_value(h, "JSON.stringify(_esConns.length)", "2", &v, 2000));
    ASSERT_TRUE(host_value(h,
        "var _h = JSON.parse(_esConns[1].headers);\n"
        "JSON.stringify([_h['Last-Event-ID'], _esConns[1].url])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"42\",\"http://x/s\"]")) << "got: " << v;
}

TEST_F(PolyfillTest, EventSourceNon200NoReconnect) {
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var _esConns = [];\n"
        "__native__.httpRequestStream = function(url, method, headers, body, onHeaders, onData, onEnd) {\n"
        "  _esConns.push({onHeaders:onHeaders, onData:onData, onEnd:onEnd}); return 0;\n"
        "};\n"
        "var _err = 0; var _open = 0;\n"
        "var es = new EventSource('http://x/s');\n"
        "es.onerror = function(){ _err++; };\n"
        "es.onopen = function(){ _open++; };\n"
        "0", &v));
    /* 非 200：不 OPEN、触发 error、readyState CLOSED；onEnd 不再补发重连 */
    ASSERT_TRUE(host_value(h,
        "_esConns[0].onHeaders(404, '{}');\n"
        "_esConns[0].onEnd(0);\n"
        "JSON.stringify([_err, _open, es.readyState])", &v));
    EXPECT_NE(std::string::npos, v.find("[1,0,2]")) << "got: " << v;
    /* fail the connection = 永不重连：400ms 内连接数保持 1 */
    EXPECT_FALSE(host_poll_until_value(h, "JSON.stringify(_esConns.length)", "2", &v, 400));
}

TEST_F(PolyfillTest, EventSourceRetryBackoffTiming) {
    /* P1-6 补课：retry: 改变重连延时的"时间维度"验证。既有
     * EventSourceReconnectLastEventId 只验证重连发生 + 头带 Last-Event-ID，
     * 未验证延时本身——retry 被忽略/单位错/写死 0 都测不出来。
     * mock_libuv 的 timer 按单调时钟触发，host_poll_until_value 的预算按
     * 真实流逝时间记账，可安全断言窗口。 */
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var _esConns = [];\n"
        "__native__.httpRequestStream = function(url, method, headers, body, onHeaders, onData, onEnd) {\n"
        "  _esConns.push({url:url, headers:headers, onHeaders:onHeaders, onData:onData, onEnd:onEnd}); return 0;\n"
        "};\n"
        "var es = new EventSource('http://x/s');\n"
        "'ok'", &v));
    /* 首连 200 + retry: 50 → 重连延时从默认 3000ms 缩到 50ms */
    ASSERT_TRUE(host_value(h,
        "_esConns[0].onHeaders(200, '{}');\n"
        "_esConns[0].onData(new TextEncoder().encode('retry: 50\\n\\n').buffer);\n"
        "globalThis.__t0 = performance.now();\n"
        "_esConns[0].onEnd(0);\n"
        "'ok'", &v));
    /* 40ms 预算内第二次连接不得出现（retry 生效 → 延时 50ms > 40ms）；
     * 若 retry 被忽略（仍 3000ms）或被写成 0（立即重连），这里都会抓到。 */
    EXPECT_FALSE(host_poll_until_value(h, "JSON.stringify(_esConns.length)", "2", &v, 40));
    ASSERT_TRUE(host_poll_until_value(h, "JSON.stringify(_esConns.length)", "2", &v, 1000)) << v;
    /* 第二次连接发生在 ~50ms 量级而非 3000ms 量级：上一步 1s 预算成功即覆盖。
     * reconnection time 是 EventSource 对象级状态：retry 设置后跨流持久，
     * 不因新连接重置回 3000ms。第三次重连仍应在 ~50ms 量级出现；若实现
     * 每流重置，500ms 预算内不会有第三次连接。 */
    ASSERT_TRUE(host_value(h,
        "_esConns[1].onEnd(0);\n"
        "'ok'", &v));
    ASSERT_TRUE(host_poll_until_value(h, "JSON.stringify(_esConns.length)", "3", &v, 500)) << v;
}

TEST_F(PolyfillTest, EventSourceReconnectDropsPartialBufferedData) {
    /* P1-6 补课：跨流解析器状态隔离。流 1 收到未终结的 data: 行（无空行
     * dispatch）后 onEnd → 重连。已缓冲的 "stale" 不得在流 2 泄漏派发，
     * 否则重连后消费端收到不属于新流的数据。 */
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var _esConns = [];\n"
        "__native__.httpRequestStream = function(url, method, headers, body, onHeaders, onData, onEnd) {\n"
        "  _esConns.push({url:url, headers:headers, onHeaders:onHeaders, onData:onData, onEnd:onEnd}); return 0;\n"
        "};\n"
        "var es = new EventSource('http://x/s');\n"
        "var _rec = '';\n"
        "es.onmessage = function(ev){ _rec += '[' + ev.data.replace(/\\n/g, '<LF>') + '|' + ev.lastEventId + ']'; };\n"
        "'ok'", &v));
    /* 流 1：retry: 10 + 无空行收尾的 data 行 → 不派发，重连 */
    ASSERT_TRUE(host_value(h,
        "_esConns[0].onHeaders(200, '{}');\n"
        "_esConns[0].onData(new TextEncoder().encode('retry: 10\\ndata: stale\\n').buffer);\n"
        "_esConns[0].onEnd(0);\n"
        "JSON.stringify([_rec, es.readyState])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"\",0]")) << "got: " << v;
    /* 流 2：一行完整 data + 空行 → 只派发 fresh，无 stale */
    ASSERT_TRUE(host_poll_until_value(h, "JSON.stringify(_esConns.length)", "2", &v, 2000));
    ASSERT_TRUE(host_value(h,
        "_esConns[1].onHeaders(200, '{}');\n"
        "_esConns[1].onData(new TextEncoder().encode('data: fresh\\n\\n').buffer);\n"
        "JSON.stringify(_rec)", &v));
    EXPECT_NE(std::string::npos, v.find("[fresh|]")) << "got: " << v;
}

TEST_F(PolyfillTest, EventSourceParserFieldEdgeCases) {
    /* P1-6 补课：字段词法边界。①无冒号行（整行是字段名、值空 → 已知字段
     * 都不命中）；②retry: 非数字 → 不改变重连延时；③id 值含 NUL → 该 id
     * 忽略（Last-Event-ID 不得带上）；④未知字段 → 忽略不崩。
     * 防的 bug：parseInt 宽松解析、NUL 混入请求头、词法分支把无冒号行当
     * data。 */
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var _esConns = [];\n"
        "__native__.httpRequestStream = function(url, method, headers, body, onHeaders, onData, onEnd) {\n"
        "  _esConns.push({url:url, headers:headers, onHeaders:onHeaders, onData:onData, onEnd:onEnd}); return 0;\n"
        "};\n"
        "var es = new EventSource('http://x/s');\n"
        "var _rec = ''; var _err = 0;\n"
        "es.onmessage = function(ev){ _rec += '[' + ev.data + ']'; };\n"
        "es.onerror = function(){ _err++; };\n"
        "'ok'", &v));
    /* 无冒号 data/event/retry 变体 + 非法 retry + NUL id + 未知字段 + 真数据 */
    ASSERT_TRUE(host_value(h,
        "_esConns[0].onHeaders(200, '{}');\n"
        "_esConns[0].onData(new TextEncoder().encode('data\\nevent\\nretry: abc\\nbogus x\\nid: bad\\u0000id\\ndata: real\\n\\n').buffer);\n"
        "_esConns[0].onEnd(0);\n"
        "JSON.stringify([_rec.replace(/\\n/g, '<LF>'), _err, es.readyState])", &v));
    /* 恰好派发一条 real（data 行的值含换行拼接 LF——无冒号 data 行贡献空串）；
     * 错误事件恰一次（onEnd 重连） */
    EXPECT_NE(std::string::npos, v.find("\"[<LF>real]\",1,0")) << "got: " << v;
    /* 重连延时保持默认 3000ms：400ms 内第二次连接不得出现 */
    EXPECT_FALSE(host_poll_until_value(h, "JSON.stringify(_esConns.length)", "2", &v, 400));
    /* 等默认延时重连，验证 NUL id 没进 Last-Event-ID 头 */
    ASSERT_TRUE(host_poll_until_value(h, "JSON.stringify(_esConns.length)", "2", &v, 3500));
    ASSERT_TRUE(host_value(h,
        "var _h = JSON.parse(_esConns[1].headers);\n"
        "JSON.stringify([_h['Last-Event-ID'] === undefined ? null : _h['Last-Event-ID']])", &v));
    /* NUL id 被忽略 → 不设 Last-Event-ID 头（键不存在 → 序列化为 [null]） */
    EXPECT_NE(std::string::npos, v.find("[null]")) << "got: " << v;
}

TEST_F(PolyfillTest, EventSourceConnectThrowReconnects) {
    /* P1-6 补课：连接发起阶段同步 throw（httpRequestStream 抛错）必须按网络
     * 错误处理：error 事件 + 按延时重连，而不是冒泡出构造/挂死/CLOSED。
     * 让第二次连接抛错（而非首连）——首连的 error 在构造器内同步派发，此时
     * 调用方还没机会绑定 onerror，可观察面只剩"重连发生"。 */
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var _attempts = 0; var _esConns = [];\n"
        "__native__.httpRequestStream = function(url, method, headers, body, onHeaders, onData, onEnd) {\n"
        "  _attempts++;\n"
        "  if (_attempts === 2) throw new Error('dial fail');\n"
        "  _esConns.push({url:url, headers:headers, onHeaders:onHeaders, onData:onData, onEnd:onEnd}); return 0;\n"
        "};\n"
        "var es = new EventSource('http://x/s');\n"
        "var _err = 0;\n"
        "es.onerror = function(){ _err++; };\n"
        "'ok'", &v));
    /* 首连 200 + retry: 10 缩短重连延时；onEnd → 网络错误：error + CONNECTING */
    ASSERT_TRUE(host_value(h,
        "_esConns[0].onHeaders(200, '{}');\n"
        "_esConns[0].onData(new TextEncoder().encode('retry: 10\\n\\n').buffer);\n"
        "_esConns[0].onEnd(0);\n"
        "JSON.stringify([_err, es.readyState])", &v));
    EXPECT_NE(std::string::npos, v.find("[1,0]")) << "got: " << v;
    /* 第二次连接同步 throw → 按网络错误处理：error 计到 2、该尝试不入列，
     * 且继续重连（第三次尝试入列）。终态 [_attempts,_err,_esConns,readyState]
     * = [3,2,2,0]；若 catch 缺失，异常会冒泡使构造/定时器回调中断，终态不再
     * 出现；若不重连，_esConns.length 停在 1。 */
    ASSERT_TRUE(host_poll_until_value(h,
        "JSON.stringify([_attempts, _err, _esConns.length, es.readyState])",
        "[3,2,2,0]", &v, 2000)) << v;
}

TEST_F(PolyfillTest, EventSourceCloseMidStreamInert) {
    /* P1-6 补课：close() 之后迟到的 onData/onEnd 必须全部失效——不派发
     * 消息、不触发 error、不重连。防的 bug：close 后回调仍写解析器状态或
     * 触发重连（连接关不掉 = 断开后无限重连风暴）。 */
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var _esConns = [];\n"
        "__native__.httpRequestStream = function(url, method, headers, body, onHeaders, onData, onEnd) {\n"
        "  _esConns.push({url:url, headers:headers, onHeaders:onHeaders, onData:onData, onEnd:onEnd}); return 0;\n"
        "};\n"
        "var es = new EventSource('http://x/s');\n"
        "var _rec = ''; var _err = 0;\n"
        "es.onmessage = function(ev){ _rec += '[' + ev.data + ']'; };\n"
        "es.onerror = function(){ _err++; };\n"
        "'ok'", &v));
    /* OPEN 后 close，再喂完整事件 + 流结束 */
    ASSERT_TRUE(host_value(h,
        "_esConns[0].onHeaders(200, '{}');\n"
        "es.close();\n"
        "_esConns[0].onData(new TextEncoder().encode('data: late\\n\\n').buffer);\n"
        "_esConns[0].onEnd(0);\n"
        "JSON.stringify([_rec, _err, es.readyState, _esConns.length])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"\",0,2,1]")) << "got: " << v;
    /* 400ms 无重连（若 onEnd 击穿 closed 防护会重连） */
    EXPECT_FALSE(host_poll_until_value(h, "JSON.stringify(_esConns.length)", "2", &v, 400));
}

// ================================================================
// ECMA-429 Minimum Common Web API gap coverage
// （已实现但此前无 gtest 覆盖的规范表面）
// ================================================================

TEST_F(PolyfillTest, Ecma429CustomEvent) {
    std::string v;
    /* 1. CustomEvent 全局存在；detail 透传 options；继承 Event */
    ASSERT_TRUE(host_value(h,
        "var ev = new CustomEvent('x', {detail: {a: 1}});\n"
        "JSON.stringify([typeof CustomEvent, ev instanceof Event, ev.type, ev.detail.a])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"function\",true,\"x\",1]")) << "got: " << v;

    /* 2. 无 options → detail 默认 null；bubbles/cancelable 默认 false */
    ASSERT_TRUE(host_value(h,
        "var ev = new CustomEvent('y');\n"
        "JSON.stringify([ev.detail, ev.bubbles, ev.cancelable])", &v));
    EXPECT_NE(std::string::npos, v.find("[null,false,false]")) << "got: " << v;
}

TEST_F(PolyfillTest, Ecma429PromiseRejectionEvent) {
    std::string v;
    /* 1. 构造 + promise/reason 属性透传 */
    ASSERT_TRUE(host_value(h,
        "var p = Promise.reject('r'); p.catch(function(){});\n"
        "var ev = new PromiseRejectionEvent('unhandledrejection', {promise: p, reason: 'r'});\n"
        "JSON.stringify([typeof PromiseRejectionEvent, ev instanceof Event, ev.promise === p, ev.reason])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"function\",true,true,\"r\"]")) << "got: " << v;

    /* 2. unhandledrejection cancelable=true；rejectionhandled cancelable=false */
    ASSERT_TRUE(host_value(h,
        "var p = Promise.resolve();\n"
        "var u = new PromiseRejectionEvent('unhandledrejection', {promise: p, reason: 'x'});\n"
        "var h = new PromiseRejectionEvent('rejectionhandled', {promise: p});\n"
        "JSON.stringify([u.cancelable, h.cancelable, h.reason === undefined])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,false,true]")) << "got: " << v;
}

TEST_F(PolyfillTest, GlobalErrorHandlerProperties) {
    std::string v;
    /* 1. self === globalThis；reportError 存在 */
    ASSERT_TRUE(host_value(h,
        "JSON.stringify([self === globalThis, typeof reportError])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,\"function\"]")) << "got: " << v;

    /* 2. onerror 赋值 → dispatch error 事件触发；getter 返回；置 null 移除 */
    ASSERT_TRUE(host_value(h,
        "var got = null;\n"
        "globalThis.onerror = function(e){ got = e.type; };\n"
        "globalThis.dispatchEvent(new ErrorEvent('error', {message: 'boom', error: new Error('boom')}));\n"
        "var g = globalThis.onerror;\n"
        "globalThis.onerror = null;\n"
        "JSON.stringify([got, g !== null, globalThis.onerror === null])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"error\",true,true]")) << "got: " << v;

    /* 3. reportError 分发 ErrorEvent 到全局 error 处理器 */
    ASSERT_TRUE(host_value(h,
        "var got2 = null;\n"
        "globalThis.onerror = function(e){ got2 = [e.type, e.message, e.error instanceof Error]; };\n"
        "reportError(new Error('kaboom'));\n"
        "globalThis.onerror = null;\n"
        "JSON.stringify(got2)", &v));
    EXPECT_NE(std::string::npos, v.find("[\"error\",\"kaboom\",true]")) << "got: " << v;

    /* 4. onunhandledrejection / onrejectionhandled 事件处理器属性 */
    ASSERT_TRUE(host_value(h,
        "var gotU = null; var gotH = null;\n"
        "globalThis.onunhandledrejection = function(e){ gotU = [e.type, e.reason]; };\n"
        "globalThis.onrejectionhandled = function(e){ gotH = e.type; };\n"
        "var p = Promise.reject('why'); p.catch(function(){});\n"
        "globalThis.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {promise: p, reason: 'why'}));\n"
        "globalThis.dispatchEvent(new PromiseRejectionEvent('rejectionhandled', {promise: p}));\n"
        "globalThis.onunhandledrejection = null; globalThis.onrejectionhandled = null;\n"
        "JSON.stringify([gotU, gotH])", &v));
    EXPECT_NE(std::string::npos, v.find("[[\"unhandledrejection\",\"why\"],\"rejectionhandled\"]")) << "got: " << v;
}

TEST_F(PolyfillTest, TextEncoderStreamApi) {
    std::string v;
    /* 1. 全局存在；readable/writable 是流实例 */
    ASSERT_TRUE(host_value(h,
        "var es = new TextEncoderStream();\n"
        "JSON.stringify([typeof TextEncoderStream, es.encoding, es.readable instanceof ReadableStream, es.writable instanceof WritableStream])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"function\",\"utf-8\",true,true]")) << "got: " << v;

    /* 2. 写入字符串 → readable 产出 UTF-8 字节（'hé' = 0x68 0xC3 0xA9） */
    ASSERT_TRUE(host_eval(h,
        "var _enc = null;\n"
        "var es = new TextEncoderStream();\n"
        "var w = es.writable.getWriter();\n"
        "var r = es.readable.getReader();\n"
        "w.write('h\\u00e9').then(function(){ return w.close(); }).then(function(){ return r.read(); })\n"
        "  .then(function(x){ var u = x.value; _enc = JSON.stringify([u instanceof Uint8Array, u.length, u[0], u[1], u[2]]); });\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_enc", "[true,3,104,195,169]", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, QueuingStrategies) {
    std::string v;
    /* 1. ByteLengthQueuingStrategy：highWaterMark + size(chunk)=byteLength */
    ASSERT_TRUE(host_value(h,
        "var s = new ByteLengthQueuingStrategy({highWaterMark: 1024});\n"
        "var u = new Uint8Array(4);\n"
        "JSON.stringify([s.highWaterMark, s.size(u), s.size('str'), typeof s.size])", &v));
    /* 规范 ByteLengthQueuingStrategy.size = chunk => chunk.byteLength：
     * 无 byteLength 属性 → undefined（JSON null），旧 shim 的 ??0 是扩展。 */
    EXPECT_NE(std::string::npos, v.find("[1024,4,null,\"function\"]")) << "got: " << v;

    /* 2. CountQueuingStrategy：highWaterMark + size()=1 */
    ASSERT_TRUE(host_value(h,
        "var s = new CountQueuingStrategy({highWaterMark: 10});\n"
        "JSON.stringify([s.highWaterMark, s.size('anything'), s.size(null)])", &v));
    EXPECT_NE(std::string::npos, v.find("[10,1,1]")) << "got: " << v;
}

TEST_F(PolyfillTest, TransformStreamApi) {
    std::string v;
    /* 1. 全局存在 + 基本结构 */
    ASSERT_TRUE(host_value(h,
        "var ts = new TransformStream();\n"
        "JSON.stringify([typeof TransformStream, ts.readable instanceof ReadableStream, ts.writable instanceof WritableStream])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"function\",true,true]")) << "got: " << v;

    /* 2. transform 映射 + flush 回调 */
    ASSERT_TRUE(host_eval(h,
        "var _ts = null;\n"
        "var flushed = false;\n"
        "var ts = new TransformStream({\n"
        "  transform: function(chunk, c){ c.enqueue(String(chunk).toUpperCase()); },\n"
        "  flush: function(){ flushed = true; }\n"
        "});\n"
        "var w = ts.writable.getWriter(); var r = ts.readable.getReader();\n"
        "var out = [];\n"
        /* 规范默认 HWM=0：readable 不读则 writable 背压挂起——先起读取循环（pump），再写。 */
        "var pump = (function loop(){ return r.read().then(function(x){\n"
        "  if (x.done) { out.push(x.done); return; } out.push(x.value); return loop(); }); })();\n"
        "w.write('a').then(function(){ return w.write('b'); }).then(function(){ return w.close(); })\n"
        "  .then(function(){ return pump; })\n"
        "  .then(function(){ _ts = JSON.stringify([out, flushed]); });\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_ts", "[[\"A\",\"B\",true],true]", &v)) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"A\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"B\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("true]")) << "got: " << v;
}

TEST_F(PolyfillTest, BroadcastChannelCloneIsolation) {
    std::string v;
    /* 1. 发送者自身不接收自己的消息 */
    ASSERT_TRUE(host_value(h,
        "var bc = new BroadcastChannel('bc-self'); var got = false;\n"
        "bc.onmessage = function(){ got = true; };\n"
        "bc.postMessage('x');\n"
        "bc.close();\n"
        "JSON.stringify(got)", &v));
    EXPECT_NE(std::string::npos, v.find("false")) << "got: " << v;

    /* 2. postMessage 快照隔离：发送后改原对象，接收方看到 post 时快照 */
    ASSERT_TRUE(host_value(h,
        "var rcv = new BroadcastChannel('bc-snap'); var got = null;\n"
        "rcv.onmessage = function(e){ got = e.data.x; };\n"
        "var snd = new BroadcastChannel('bc-snap');\n"
        "var obj = {x: 1}; snd.postMessage(obj); obj.x = 99;\n"
        "rcv.close(); snd.close();\n"
        "JSON.stringify(got)", &v));
    EXPECT_NE(std::string::npos, v.find("1")) << "got: " << v;
}

/* ---- 消息层三规范偏差回归（WHATWG DOM / HTML） ---- */

/* Bug 1 回归：once 监听器须在 invoke 前移除（WHATWG DOM §observing event
 * listeners, step 2.2：remove 先于 invoke）。同类型嵌套 dispatch 时 once 不再
 * 被二次调用；恰好执行 1 次。 */
TEST_F(PolyfillTest, EventTargetOnceRemovedBeforeInvoke) {
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var et = new EventTarget(); var hits = 0;\n"
        "et.addEventListener('x', function once(e){\n"
        "  hits++;\n"
        "  if (hits < 20) et.dispatchEvent(new Event('x'));\n"
        "}, {once: true});\n"
        "et.dispatchEvent(new Event('x'));\n"
        "JSON.stringify(hits)", &v));
    EXPECT_NE(std::string::npos, v.find("1")) << "got: " << v;
}

/* Bug 2 回归：MessagePort 本地路径 clone 失败须向 postMessage 调用方抛
 * DataCloneError（HTML §message-port-post-steps step 6：failed clone →
 * throw a "DataCloneError" DOMException）；messageerror 只用于接收端
 * 反序列化失败。断言 throw 且对端无 messageerror。 */
TEST_F(PolyfillTest, MessagePortLocalCloneFailureThrows) {
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var ch = new MessageChannel(); var merr = false;\n"
        "ch.port2.onmessageerror = function(){ merr = true; };\n"
        "var threw = '';\n"
        "try { ch.port1.postMessage(function(){}); }\n"
        "catch (e) { threw = e.name; }\n"
        "JSON.stringify([threw, merr])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"DataCloneError\",false]")) << "got: " << v;
}

/* Bug 3 回归：BroadcastChannel 每 peer 独立副本（HTML §dom-broadcastchannel-
 * postmessage：serialise 每 target 各一次）。peer B 改收到的对象，peer C 不变。 */
TEST_F(PolyfillTest, BroadcastChannelPerPeerIndependentClone) {
    std::string v;
    ASSERT_TRUE(host_value(h,
        "var b = new BroadcastChannel('bc-peer'); var c = new BroadcastChannel('bc-peer');\n"
        "var gotB = null, gotC = null;\n"
        "b.onmessage = function(e){ gotB = e.data; };\n"
        "c.onmessage = function(e){ gotC = e.data; };\n"
        "new BroadcastChannel('bc-peer').postMessage({n: 1});\n"
        "gotB.n = 42;\n"
        "b.close(); c.close();\n"
        "JSON.stringify([gotB.n, gotC.n])", &v));
    EXPECT_NE(std::string::npos, v.find("[42,1]")) << "got: " << v;
}

TEST_F(PolyfillTest, CacheStorageExtended) {
    std::string v;
    /* 跳过条件同 CacheStorageEdgeCases */
    ASSERT_TRUE(host_value(h, "JSON.stringify(typeof caches)", &v));
    EXPECT_NE(std::string::npos, v.find("\"object\"")) << "got: " << v;  /* CacheStorage 恒存在（纯 JS lazy 模块），硬断言 */

    /* 1. caches.has / keys / delete 生命周期 */
    ASSERT_TRUE(host_eval(h,
        "var _cs2 = null;\n"
        "caches.open('ex1').then(function(){ return caches.has('ex1'); })\n"
        "  .then(function(has){ var a = [has]; return caches.keys().then(function(ks){ a.push(ks.indexOf('ex1') >= 0); return a; }); })\n"
        "  .then(function(a){ return caches.delete('ex1').then(function(d){ a.push(d); return a; }); })\n"
        "  .then(function(a){ return caches.has('ex1').then(function(h2){ a.push(h2); return a; }); })\n"
        "  .then(function(a){ _cs2 = JSON.stringify(a); }).catch(function(e){ _cs2 = 'err:' + String(e); });\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_cs2", "[true,true,true,false]", &v)) << "got: " << v;

    /* 2. cache.put → matchAll → keys → delete 生命周期 */
    ASSERT_TRUE(host_eval(h,
        "var _cs3 = null;\n"
        "caches.open('ex2').then(function(c){\n"
        "  return c.put('https://x.com/1', new Response('one'))\n"
        "    .then(function(){ return c.put('https://x.com/2', new Response('two')); })\n"
        "    .then(function(){ return c.matchAll().then(function(all){ return all.length; }); })\n"
        "    .then(function(n){ var r = [n]; return c.keys().then(function(ks){ r.push(ks.length, ks[0]); return r; }); })\n"
        "    .then(function(r){ return c.matchAll('https://x.com/1').then(function(s){ r.push(s.length, s[0].status); return r; }); })\n"
        "    .then(function(r){ return c.delete('https://x.com/1').then(function(d){ r.push(d); return r; }); })\n"
        "    .then(function(r){ return c.keys().then(function(ks){ r.push(ks.length); return r; }); })\n"
        "    .then(function(r){ _cs3 = JSON.stringify(r); });\n"
        "}).catch(function(e){ _cs3 = 'err:' + String(e); });\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_cs3", "[2,2,", &v)) << "got: " << v;
    ASSERT_TRUE(host_poll_until_value(h, "_cs3", "\"https://x.com/1\"", &v)) << "got: " << v;
    ASSERT_TRUE(host_poll_until_value(h, "_cs3", ",1,200,true,1]", &v)) << "got: " << v;

    /* 3. put 非 Response → TypeError */
    ASSERT_TRUE(host_eval(h,
        "var _cs4 = null;\n"
        "caches.open('ex3').then(function(c){\n"
        "  return c.put('https://x.com/n', 'not-a-response')\n"
        "    .then(function(){ _cs4 = 'resolved'; })\n"
        "    .catch(function(e){ _cs4 = e.name + ':' + e.message; });\n"
        "}).catch(function(e){ _cs4 = 'outer:' + String(e); });\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_cs4", "TypeError", &v)) << "got: " << v;

    /* 4. match 未命中 → undefined；命中两次返回独立 clone */
    ASSERT_TRUE(host_eval(h,
        "var _cs5 = null; var miss = null;\n"
        "caches.open('ex4').then(function(c){\n"
        "  return c.put('https://x.com/c', new Response('orig'))\n"
        "    .then(function(){ return c.match('https://x.com/miss'); })\n"
        "    .then(function(m){ miss = (m === undefined); return c.match('https://x.com/c'); })\n"
        "    .then(function(r){ return r.text().then(function(t1){ return c.match('https://x.com/c').then(function(r2){ return r2.text().then(function(t2){ _cs5 = JSON.stringify([miss, t1, t2]); }); }); }); });\n"
        "}).catch(function(e){ _cs5 = 'err:' + String(e); });\n"
        "0", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_cs5", "[true,\"orig\",\"orig\"]", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, MessageChannelMessaging) {
    std::string v;
    /* 1. 同上下文消息往返：onmessage 赋值自动 start；数据/类型透传 */
    ASSERT_TRUE(host_value(h,
        "var ch = new MessageChannel(); var got = [];\n"
        "ch.port2.onmessage = function(e){ got.push([e.data, e.type]); };\n"
        "ch.port1.postMessage('m1'); ch.port1.postMessage('m2');\n"
        "JSON.stringify([got, ch.port2 instanceof MessagePort])", &v));
    EXPECT_NE(std::string::npos, v.find("[[[\"m1\",\"message\"],[\"m2\",\"message\"]],true]")) << "got: " << v;

    /* 2. 未 start 的 port：消息排队，start() 后按序 flush */
    ASSERT_TRUE(host_value(h,
        "var ch = new MessageChannel(); var got2 = [];\n"
        "ch.port2.addEventListener('message', function(e){ got2.push(e.data); });\n"
        "ch.port1.postMessage('q1');\n"
        "ch.port2.start();\n"
        "ch.port1.postMessage('q2');\n"
        "JSON.stringify(got2)", &v));
    EXPECT_NE(std::string::npos, v.find("[\"q1\",\"q2\"]")) << "got: " << v;

    /* 3. close() 后不再投递 */
    ASSERT_TRUE(host_value(h,
        "var ch = new MessageChannel(); var got3 = false;\n"
        "ch.port2.onmessage = function(){ got3 = true; };\n"
        "ch.port2.close();\n"
        "ch.port1.postMessage('x');\n"
        "JSON.stringify(got3)", &v));
    EXPECT_NE(std::string::npos, v.find("false")) << "got: " << v;
}

// ================================================================
// qzjs.fs — 异步文件系统 API 覆盖（ROADMAP A1）
// 异步原语走 uv_io_*；mock_libuv 在 uv_fs_* 调用点同步执行真实文件系统并
// 立即回调，promise 在下一轮 host_eval（跑 loop + 冲刷微任务）后可见。
// 临时路径 /tmp/qz_fs_<tag>_<pid>_<id>：唯一且绝对（guard 只拒 ".." 组件）。
// ================================================================

#include <unistd.h>
#include <sys/stat.h>

namespace {
// 每个测试一个唯一 /tmp 路径（同进程 pid 相同，静态计数保证唯一）。
std::string fs_tmp(const char *tag) {
    static std::atomic<int> n{0};
    int id = n.fetch_add(1) + 1;
    return std::string("/tmp/qz_fs_") + tag + "_" +
           std::to_string((long)getpid()) + "_" + std::to_string(id);
}
}

TEST_F(PolyfillTest, FsApiSurface) {
    std::string v;
    /* 6 个 async fs API 全部挂载 */
    ASSERT_TRUE(host_value(h,
        "JSON.stringify([typeof qzjs.fs.readFile, typeof qzjs.fs.readFileBinary,\n"
        "  typeof qzjs.fs.writeFile, typeof qzjs.fs.exists,\n"
        "  typeof qzjs.fs.readdir, typeof qzjs.fs.unlink])", &v));
    int cnt = 0;
    std::string::size_type p = 0;
    while ((p = v.find("\"function\"", p)) != std::string::npos) { cnt++; p += 10; }
    EXPECT_EQ(6, cnt) << "got: " << v;

    /* readFileSync 是显式拒绝的同步别名 */
    ASSERT_TRUE(host_value(h,
        "(() => { try { qzjs.fs.readFileSync('/etc/hostname'); return 'NO_THROW'; }"
        " catch (e) { return e.message; } })()", &v));
    EXPECT_NE(std::string::npos, v.find("not supported")) << "got: " << v;
}

// 注意：所有轮询目标全局都必须先初始化为非 undefined 哨兵（'pending'）——
// host_poll_until_value 在表达式求值为 undefined（无 "v" 字段）时会立即失败返回
// false，而不是继续轮询；异步 .then 若未在该轮 eval 内冲刷微任务，就会误报。
TEST_F(PolyfillTest, FsWriteReadRoundtrip) {
    std::string path = fs_tmp("rw");
    std::string plit = JSON_string(path.c_str());
    std::string out, v;

    ASSERT_TRUE(host_eval(h, ("globalThis._w = 'pending'; qzjs.fs.writeFile(" + plit +
        ", 'hello fs world').then(function(){ globalThis._w = 'done'; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_w", "done", &v));

    /* 异步 readFile 往返 */
    ASSERT_TRUE(host_eval(h, ("globalThis._rd = 'pending'; qzjs.fs.readFile(" + plit +
        ").then(function(d){ globalThis._rd = d; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_rd", "hello fs world", &v));

    /* 原生 fsReadSync 交叉验证（worker 脚本加载走同一同步读） */
    ASSERT_TRUE(host_value(h, ("__native__.fsReadSync(" + plit + ")").c_str(), &v));
    EXPECT_NE(std::string::npos, v.find("hello fs world")) << "got: " << v;

    /* 清理 */
    ASSERT_TRUE(host_eval(h, ("globalThis._del = 'pending'; qzjs.fs.unlink(" + plit +
        ").then(function(){ globalThis._del = 'done'; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_del", "done", &v));
}

TEST_F(PolyfillTest, FsExistsUnlink) {
    std::string path = fs_tmp("ex");
    std::string plit = JSON_string(path.c_str());
    std::string out, v;

    /* 不存在 → false */
    ASSERT_TRUE(host_eval(h, ("globalThis._e = 'pending'; qzjs.fs.exists(" + plit +
        ").then(function(b){ globalThis._e = b; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_e", "false", &v));

    /* 写入 → true */
    ASSERT_TRUE(host_eval(h, ("globalThis._w = 'pending'; qzjs.fs.writeFile(" + plit +
        ", 'x').then(function(){ globalThis._w = 'done'; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_w", "done", &v));
    ASSERT_TRUE(host_eval(h, ("globalThis._e2 = 'pending'; qzjs.fs.exists(" + plit +
        ").then(function(b){ globalThis._e2 = b; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_e2", "true", &v));

    /* unlink → false */
    ASSERT_TRUE(host_eval(h, ("globalThis._u = 'pending'; qzjs.fs.unlink(" + plit +
        ").then(function(){ globalThis._u = 'done'; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_u", "done", &v));
    ASSERT_TRUE(host_eval(h, ("globalThis._e3 = 'pending'; qzjs.fs.exists(" + plit +
        ").then(function(b){ globalThis._e3 = b; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_e3", "false", &v));
}

TEST_F(PolyfillTest, FsReadFileBinary) {
    std::string path = fs_tmp("bin");
    std::string plit = JSON_string(path.c_str());
    std::string out, v;

    /* 二进制往返：NUL + 0x7f（<0x80 保证 UTF-8 单字节映射，字节精确） */
    ASSERT_TRUE(host_eval(h, ("globalThis._w = 'pending'; qzjs.fs.writeFile(" + plit +
        ", '\\x00\\x01\\x02\\x7f').then(function(){ globalThis._w = 'done'; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_w", "done", &v));

    /* readFileBinary → ArrayBuffer → Uint8Array 逐字节核对 */
    ASSERT_TRUE(host_eval(h, ("globalThis._b = 'pending'; qzjs.fs.readFileBinary(" + plit +
        ").then(function(ab){ globalThis._b = Array.from(new Uint8Array(ab)); }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "JSON.stringify(_b)", "0,1,2,127", &v));

    /* 清理 */
    ASSERT_TRUE(host_eval(h, ("globalThis._del = 'pending'; qzjs.fs.unlink(" + plit +
        ").then(function(){ globalThis._del = 'done'; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_del", "done", &v));
}

TEST_F(PolyfillTest, FsReaddir) {
    std::string dir = fs_tmp("dir");
    std::string f1 = dir + "/one.txt";
    std::string f2 = dir + "/two.txt";
    ASSERT_EQ(0, ::mkdir(dir.c_str(), 0700));
    std::string out, v;

    ASSERT_TRUE(host_eval(h, ("globalThis._w1 = 'pending'; qzjs.fs.writeFile(" +
        JSON_string(f1.c_str()) + ", '1').then(function(){ globalThis._w1 = 'done'; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_w1", "done", &v));
    ASSERT_TRUE(host_eval(h, ("globalThis._w2 = 'pending'; qzjs.fs.writeFile(" +
        JSON_string(f2.c_str()) + ", '2').then(function(){ globalThis._w2 = 'done'; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_w2", "done", &v));

    /* readdir 列出两个文件（顺序无关，逐个断言存在） */
    ASSERT_TRUE(host_eval(h, ("globalThis._dl = 'pending'; qzjs.fs.readdir(" +
        JSON_string(dir.c_str()) + ").then(function(a){ globalThis._dl = a.join(','); }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_dl", "one.txt", &v));
    ASSERT_TRUE(host_poll_until_value(h, "_dl", "two.txt", &v));

    /* 清理：unlink 两文件 + 移除目录 */
    ASSERT_TRUE(host_eval(h, ("globalThis._d1 = 'pending'; qzjs.fs.unlink(" +
        JSON_string(f1.c_str()) + ").then(function(){ globalThis._d1 = 'done'; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_d1", "done", &v));
    ASSERT_TRUE(host_eval(h, ("globalThis._d2 = 'pending'; qzjs.fs.unlink(" +
        JSON_string(f2.c_str()) + ").then(function(){ globalThis._d2 = 'done'; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_d2", "done", &v));
    ASSERT_EQ(0, ::rmdir(dir.c_str()));
}

TEST_F(PolyfillTest, FsTraversalGuard) {
    std::string out, v;
    /* 全部异步 fs op 都在调用点拒绝 ".." 组件（同步 throw → async 包装变 rejection） */
    const char *ops[] = {
        "qzjs.fs.writeFile('../q_x', 'x')",
        "qzjs.fs.readFile('../q_x')",
        "qzjs.fs.readFileBinary('../q_x')",
        "qzjs.fs.exists('../q_x')",
        "qzjs.fs.readdir('../q_x')",
        "qzjs.fs.unlink('../q_x')",
    };
    for (size_t i = 0; i < sizeof(ops) / sizeof(ops[0]); i++) {
        char gname[24];
        snprintf(gname, sizeof gname, "_g%zu", i);   /* 每轮独立全局，避免上一轮残留误匹配 */
        std::string code = "globalThis['" + std::string(gname) + "'] = 'pending'; " +
            std::string(ops[i]) +
            ".then(function(){ globalThis['" + gname + "'] = 'ok'; },"
            " function(e){ globalThis['" + gname + "'] = 'rej:' + e.message; }); 0";
        ASSERT_TRUE(host_eval(h, code.c_str(), &out)) << "op[" << i << "]";
        ASSERT_TRUE(host_poll_until_value(h, gname, "rej:Path traversal detected", &v))
            << "op[" << i << "] " << ops[i] << " got: " << v;
    }
}

/* ────────────────────────────────────────────────────────────────
 * F2 覆盖率补测：fs 错误路径。
 * 正常路径（往返/exists/二进制/readdir/穿越守卫）已被上面用例覆盖；
 * 这里补齐 uv_io_fs_* 的失败分支：读不存在文件、读目录当文件、
 * 写不存在目录、readdir 不存在目录、unlink 不存在、多块读取扩容、
 * readdir 条目扩容。mock_libuv 的 uv_fs_* 在调用点同步走真实文件
 * 系统并立即回调，promise 在下一轮 host_eval 后可见；错误经
 * bridge_io_done 以字符串 reject（如 "file not found"）。
 * ──────────────────────────────────────────────────────────────── */

TEST_F(PolyfillTest, FsReadFileMissing) {
    std::string path = fs_tmp("missing_read");
    std::string plit = JSON_string(path.c_str());
    std::string out, v;

    /* 读不存在的文件 → rejection "file not found"（uv_io_fs_read_open_cb NOT_FOUND 分支） */
    ASSERT_TRUE(host_eval(h, ("globalThis._e = 'pending'; qzjs.fs.readFile(" + plit +
        ").then(function(){ globalThis._e = 'ok'; },"
        " function(e){ globalThis._e = 'rej:' + e; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_e", "rej:file not found", &v)) << "got: " << v;

    /* readFileBinary 同路径 */
    ASSERT_TRUE(host_eval(h, ("globalThis._b = 'pending'; qzjs.fs.readFileBinary(" + plit +
        ").then(function(){ globalThis._b = 'ok'; },"
        " function(e){ globalThis._b = 'rej:' + e; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_b", "rej:file not found", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, FsWriteToMissingDir) {
    /* 写不存在的目录 → open 失败 "cannot open file for writing"（uv_io_fs_write_open_cb） */
    std::string path = fs_tmp("no_dir") + "/x.txt";
    std::string out, v;
    ASSERT_TRUE(host_eval(h, ("globalThis._e = 'pending'; qzjs.fs.writeFile(" +
        JSON_string(path.c_str()) + ", 'x').then(function(){ globalThis._e = 'ok'; },"
        " function(e){ globalThis._e = 'rej:' + e; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_e", "rej:cannot open file for writing", &v))
        << "got: " << v;
}

TEST_F(PolyfillTest, FsReaddirMissingDir) {
    /* 不存在的目录 → scandir 失败 "scandir error"（uv_io_fs_list_cb result<0） */
    std::string dir = fs_tmp("no_dir2");
    std::string out, v;
    ASSERT_TRUE(host_eval(h, ("globalThis._e = 'pending'; qzjs.fs.readdir(" +
        JSON_string(dir.c_str()) + ").then(function(){ globalThis._e = 'ok'; },"
        " function(e){ globalThis._e = 'rej:' + e; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_e", "rej:scandir error", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, FsUnlinkMissing) {
    /* unlink 不存在文件 → "not found"（uv_io_fs_remove_cb ENOENT 分支） */
    std::string path = fs_tmp("no_unlink");
    std::string out, v;
    ASSERT_TRUE(host_eval(h, ("globalThis._e = 'pending'; qzjs.fs.unlink(" +
        JSON_string(path.c_str()) + ").then(function(){ globalThis._e = 'ok'; },"
        " function(e){ globalThis._e = 'rej:' + e; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_e", "rej:not found", &v)) << "got: " << v;
}

TEST_F(PolyfillTest, FsReadLargeFileMultiChunk) {
    /* >8KB 文件触发多块读取与缓冲区增长（uv_io_fs_read_cb 的 realloc/grow 分支）。
     * PAL_UV_FS_BUF_INIT=4096：首读 4096 → iov.len=0 触发扩容（×2）→ 续读至 EOF。 */
    std::string path = fs_tmp("big");
    std::string data(30000, 'z');
    std::string plit = JSON_string(path.c_str());
    std::string dlit = JSON_string(data.c_str());
    std::string out, v;

    ASSERT_TRUE(host_eval(h, ("globalThis._w = 'pending'; qzjs.fs.writeFile(" + plit +
        ", " + dlit + ").then(function(){ globalThis._w = 'done'; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_w", "done", &v));

    /* 读回：长度精确 + 首尾字节正确（无截断/错位） */
    ASSERT_TRUE(host_eval(h, ("globalThis._r = 'pending'; qzjs.fs.readFile(" + plit +
        ").then(function(d){ globalThis._r = d.length + ':' + d[0] + d[d.length-1]; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_r", "30000:zz", &v)) << "got: " << v;

    /* 清理 */
    ASSERT_TRUE(host_eval(h, ("globalThis._d = 'pending'; qzjs.fs.unlink(" + plit +
        ").then(function(){ globalThis._d = 'done'; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_d", "done", &v));
}

TEST_F(PolyfillTest, FsReaddirManyEntries) {
    /* >32 条目触发 fs_list 的 names 扩容分支（cap 32 → 64 → …） */
    const int N = 36;
    std::string dir = fs_tmp("many");
    ASSERT_EQ(0, ::mkdir(dir.c_str(), 0700));
    std::string files[N];
    char name[64];
    for (int i = 0; i < N; i++) {
        snprintf(name, sizeof name, "%s/f_%02d.txt", dir.c_str(), i);
        files[i] = name;
    }
    std::string out, v;
    for (int i = 0; i < N; i++) {
        ASSERT_TRUE(host_eval(h, ("globalThis._w = 'pending'; qzjs.fs.writeFile(" +
            JSON_string(files[i].c_str()) + ", 'x').then(function(){ globalThis._w = 'done'; }); 0").c_str(), &out));
        ASSERT_TRUE(host_poll_until_value(h, "_w", "done", &v));
    }
    /* 36 个条目全列出 */
    ASSERT_TRUE(host_eval(h, ("globalThis._dl = 'pending'; qzjs.fs.readdir(" +
        JSON_string(dir.c_str()) + ").then(function(a){ globalThis._dl = a.length; }); 0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "_dl", "36", &v)) << "got: " << v;
    /* 清理 */
    for (int i = 0; i < N; i++) {
        ASSERT_TRUE(host_eval(h, ("globalThis._d = 'pending'; qzjs.fs.unlink(" +
            JSON_string(files[i].c_str()) + ").then(function(){ globalThis._d = 'done'; }); 0").c_str(), &out));
        ASSERT_TRUE(host_poll_until_value(h, "_d", "done", &v));
    }
    ASSERT_EQ(0, ::rmdir(dir.c_str()));
}

/* F4 安全审计回归：structuredClone 反序列化端遇到 '__proto__' 键必须落为
 * 普通 own 属性（defineProperty），不得触发原型 setter 污染 Object.prototype。 */
TEST_F(PolyfillTest, CloneProtoPollutionGuard) {
    std::string v;
    /* 1. 恶意对象：own enumerable '__proto__' 键（defineProperty 绕过 setter
     *    才能造出来），序列化后其键进入字节流；克隆端不得改写原型。 */
    ASSERT_TRUE(host_value(h,
        "var evil = {};\n"
        "Object.defineProperty(evil, '__proto__', { value: {polluted: 1}, enumerable: true });\n"
        "var c = structuredClone(evil);\n"
        "var protoOk = Object.getPrototypeOf(c) === Object.prototype;\n"
        "var globalOk = Object.prototype.polluted === undefined;\n"
        "var ownOk = Object.prototype.hasOwnProperty.call(c, '__proto__');\n"
        "JSON.stringify([protoOk, globalOk, ownOk])", &v));
    EXPECT_NE(std::string::npos, v.find("[true,true,true]")) << "got: " << v;

    /* 2. 循环引用仍正常（defineProperty 路径不破坏 0x1E ref 解析）。 */
    ASSERT_TRUE(host_value(h,
        "var a = {x: 1}; a.self = a; var c = structuredClone(a);\n"
        "JSON.stringify([c.x, c.self === c])", &v));
    EXPECT_NE(std::string::npos, v.find("[1,true]")) << "got: " << v;

    /* 3. 普通属性的可枚举/可写语义保持不变。 */
    ASSERT_TRUE(host_value(h,
        "var c = structuredClone({p: 5});\n"
        "var d = Object.getOwnPropertyDescriptor(c, 'p');\n"
        "JSON.stringify([d.value, d.writable, d.enumerable, d.configurable])", &v));
    EXPECT_NE(std::string::npos, v.find("[5,true,true,true]")) << "got: " << v;
}

/* F4 安全审计回归：反序列化长度字段来自不可信字节流。截断/巨量长度必须
 * 抛 DataCloneError，不得越界读或按 0xFFFFFFFF 分配。 */
TEST_F(PolyfillTest, CloneTruncatedLengthGuard) {
    std::string v;
    /* 1. 对象键声明超长字符串长度（tag 0x1D + count 1 + key len=0xFFFFFFFF）→ str() 越界拒绝。 */
    ASSERT_TRUE(host_value(h,
        "var b = new Uint8Array([0x1D, 1,0,0,0, 0xFF,0xFF,0xFF,0xFF]);\n"
        "var r; try { __qz_deserialize__(b.buffer); r = 'no-throw'; }\n"
        "catch (e) { r = e.name + ':' + (e.message || ''); }\n"
        "r.indexOf('DataCloneError') >= 0 ? 'guarded' : 'leak:' + r", &v));
    EXPECT_EQ("guarded", v) << "got: " << v;

    /* 2. TypedArray 声明巨量字节长度（tag 0x0D + len=0xFFFFFFFF）→ bytes() 拒绝。 */
    ASSERT_TRUE(host_value(h,
        "var b = new Uint8Array([0x0D, 0xFF,0xFF,0xFF,0xFF]);\n"
        "var r; try { __qz_deserialize__(b.buffer); r = 'no-throw'; }\n"
        "catch (e) { r = e.name; }\n"
        "r === 'DataCloneError' ? 'guarded' : 'leak:' + r", &v));
    EXPECT_EQ("guarded", v) << "got: " << v;

    /* 3. 合法数据不受影响：正常 round-trip 仍工作。 */
    ASSERT_TRUE(host_value(h,
        "var c = structuredClone({s: 'hello', arr: [1,2,3]});\n"
        "JSON.stringify([c.s, c.arr.join(',')])", &v));
    EXPECT_NE(std::string::npos, v.find("[\"hello\",\"1,2,3\"]")) << "got: " << v;
}

/* ================================================================
 * External 模式（QZ_POLYFILL_MODE=external）加载契约：磁盘 bytecode 必须与
 * 编译期内嵌的 SHA-256 一致（「固定版防篡改」，见
 * brain/pages/polyfill-bundling-policy.md）。篡改任意一比特必须被拒，且不得
 * 把字节码交给 JS_ReadObject；未篡改的官方文件必须照常装载。
 * 仅 external 构建编译——其余模式 bytecode 编进二进制，无此攻击面。
 * ================================================================ */
#if QZ_POLYFILL_MODE == QZ_POLYFILL_MODE_EXTERNAL

/* 篡改方式：翻转一个比特位。任何位变化都会改变 SHA-256，故加载器必拒。 */
static const uint8_t kTamperFlipMask = 0x01;

/* 合法 polyfill bytecode 的下界；短于此说明基线产物异常、测试无意义。 */
static const size_t kMinPlausibleBytecodeBytes = 64;

/* 把 QZ_POLYFILL_FILE 指向 path 后再加载一次——加载器只从环境变量取路径，
 * 用例三处（官方 / 篡改副本 / 恢复官方）共用此入口，免得重复 setenv 样板。
 * 返回 qz_polyfill_load 的状态码；setenv 失败（仅 ENOMEM/EINVAL 可能）先记
 * 一条断言失败，再由调用点按状态码判定。 */
static int load_polyfill_at(const char *path, const uint8_t **out_bytes,
                            size_t *out_len, void **out_owner)
{
    EXPECT_EQ(0, setenv("QZ_POLYFILL_FILE", path, 1))
        << "setenv(QZ_POLYFILL_FILE) 失败，路径: " << path;
    return qz_polyfill_load(out_bytes, out_len, out_owner);
}

TEST(PolyfillExternalTest, TamperRejectedAndIntactAccepted)
{
    const char *intact_path = getenv("QZ_POLYFILL_FILE");
    ASSERT_NE(nullptr, intact_path)
        << "QZ_POLYFILL_FILE 未设置：ctest 为其注入官方 bytecode 路径 "
           "(test/CMakeLists.txt external 分支)";

    /* 1) 未篡改：官方 bytecode 正常装载。 */
    const uint8_t *intact_bytes = nullptr;
    size_t intact_len = 0;
    void *intact_owner = nullptr;
    ASSERT_EQ(0, load_polyfill_at(intact_path, &intact_bytes, &intact_len,
                                  &intact_owner))
        << "官方 bytecode 装载失败，路径: " << intact_path;
    ASSERT_NE(nullptr, intact_bytes)
        << "装载成功必须交出字节码指针，路径: " << intact_path;
    ASSERT_GE(intact_len, kMinPlausibleBytecodeBytes)
        << "官方 bytecode 只有 " << intact_len << " 字节（下界 "
        << kMinPlausibleBytecodeBytes << "），基线产物可疑，路径: " << intact_path;
    qz_polyfill_unload(intact_owner);

    /* 2) 篡改副本：翻转中间一比特后写入临时文件，仓库内的官方文件不被改动。
     * 临时路径的命名与唯一性交给 mkstemp（本文件其余临时文件用例同款）。 */
    std::string tampered_bytes;
    ASSERT_TRUE(host_read_file(intact_path, &tampered_bytes))
        << "读取官方 bytecode 失败，路径: " << intact_path;
    ASSERT_GE(tampered_bytes.size(), kMinPlausibleBytecodeBytes)
        << "官方 bytecode 只有 " << tampered_bytes.size() << " 字节（下界 "
        << kMinPlausibleBytecodeBytes << "），篡改点无意义，路径: " << intact_path;
    tampered_bytes[tampered_bytes.size() / 2] ^= kTamperFlipMask;

    char tampered_path_template[] = "/tmp/qz_polyfill_tampered_XXXXXX";
    const int tampered_fd = ::mkstemp(tampered_path_template);
    ASSERT_GE(tampered_fd, 0) << "mkstemp 失败，模板: " << tampered_path_template;
    ::close(tampered_fd);
    const std::string tampered_path = tampered_path_template;
    ASSERT_TRUE(host_write_file(tampered_path, tampered_bytes))
        << "写入篡改副本失败，路径: " << tampered_path;

    const uint8_t *rejected_bytes = nullptr;
    size_t rejected_len = 0;
    void *rejected_owner = nullptr;
    const int tampered_status = load_polyfill_at(tampered_path.c_str(),
                                                 &rejected_bytes, &rejected_len,
                                                 &rejected_owner);
    EXPECT_EQ(QZ_ERR_PERMISSION, tampered_status)
        << "哈希不匹配的 bytecode 必须拒绝（期望 QZ_ERR_PERMISSION="
        << (int)QZ_ERR_PERMISSION << "），实际 " << tampered_status
        << "，文件: " << tampered_path;
    EXPECT_EQ(nullptr, rejected_bytes)
        << "被拒时不得交出字节码指针，文件: " << tampered_path;
    EXPECT_EQ(nullptr, rejected_owner)
        << "被拒时不得交出 ownership 指针，文件: " << tampered_path;
    EXPECT_EQ(0u, rejected_len)
        << "被拒时不得报告字节数，文件: " << tampered_path;

    /* 3) 恢复官方路径再装载一次：负例不得残留 env / 缓存状态。 */
    const uint8_t *restored_bytes = nullptr;
    size_t restored_len = 0;
    void *restored_owner = nullptr;
    EXPECT_EQ(0, load_polyfill_at(intact_path, &restored_bytes, &restored_len,
                                  &restored_owner))
        << "恢复官方 bytecode 后应重新可装载，路径: " << intact_path;
    qz_polyfill_unload(restored_owner);

    remove(tampered_path.c_str());
}
#endif
