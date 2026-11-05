// test_compress_gtest.cpp — Task 5: 迁 host 契约（host_eval 驱动）
//
// CompressionStream/DecompressionStream 的压缩动作在 writable.close() 内同步完成
// （pal.nativeCompress / pal.nativeDecompress，纯 CPU 无 I/O），剩下的只是 promise
// 链（微任务）。qzjs 线程每轮 uv_run 后冲刷全部微任务（qz_tick 排空
// job 队列），因此下一次 host_eval 即可见上一阶段的结果；最终结果用
// host_poll_until_value 轮询标志位（与 test_polyfill_gtest 的异步模式一致）。
//
// 覆盖：3 种格式 × 各尺寸（10B ~ 1MB）、roundtrip 正确性、gzip 头、压缩比、二进制数据。
// 大 payload 的二进制数据用 4096 字节模板 + Uint8Array.set 块复制生成（原生
// memcpy 级），避免 Debug 下 O(n) 的 JS 逐字节填充循环；roundtrip 校验走
// pal.nativeBytesEqual（C 侧 memcmp）。
#include "test_host.h"
#include <string>
#include <cstdio>
#include <cstdlib>

class CompressTestBase : public ::testing::Test {
protected:
    HostCtx *h = nullptr;

    void SetUp() override {
        h = host_create();
        ASSERT_NE(nullptr, h);
    }

    void TearDown() override {
        host_destroy(h);
    }

    /* 求值 JS 表达式并检查结果是否为布尔 true */
    bool js_bool(const char *expr) {
        std::string out;
        return host_value(h, expr, &out) && out == "true";
    }

    /* 通用 roundtrip：format 压缩 → 拼结果 → 解压 → nativeBytesEqual 校验。
     * 逐字节比较走 C 侧 memcmp（而非 JS for 循环）：unoptimized QuickJS
     * 解释执行 1MB 逐字节循环在 Debug 下需数秒，会击穿 host_eval 超时。 */
    void test_roundtrip(const char *format, const char *data_expr) {
        char code[1024];
        std::string out;

        /* Setup */
        snprintf(code, sizeof(code),
            "var _rok=false;var _rdata=%s;"
            "var _cs=new CompressionStream('%s');"
            "var _w=_cs.writable.getWriter();"
            "var _rd=_cs.readable.getReader();"
            "var _chunks=[];var _total=0;",
            data_expr, format);
        ASSERT_TRUE(host_eval(h, code, &out));

        /* Write + close（同步压缩；promise 链在下一轮 loop 冲刷中跑完） */
        ASSERT_TRUE(host_eval(h,
            "_w.write(_rdata).then(function(){return _w.close();}).then(function(){"
            "  function p(){_rd.read().then(function(r){"
            "    if(r.done){return;}"
            "    _chunks.push(r.value);_total+=r.value.length;p();});}"
            "  p();});", &out));

        /* 拼压缩结果 → 解压 */
        snprintf(code, sizeof(code),
            "var _comp=new Uint8Array(_total);var _off=0;"
            "for(var i=0;i<_chunks.length;i++){_comp.set(_chunks[i],_off);_off+=_chunks[i].length;}"
            "var _ds=new DecompressionStream('%s');"
            "var _dw=_ds.writable.getWriter();"
            "var _drd=_ds.readable.getReader();"
            "var _out=[];var _osize=0;",
            format);
        ASSERT_TRUE(host_eval(h, code, &out));

        ASSERT_TRUE(host_eval(h,
            "_dw.write(_comp).then(function(){return _dw.close();}).then(function(){"
            "  function q(){_drd.read().then(function(r){"
            "    if(r.done){"
            "      var _result=new Uint8Array(_osize);var _o=0;"
            "      for(var i=0;i<_out.length;i++){_result.set(_out[i],_o);_o+=_out[i].length;}"
            "      _rok=(_result.length===_rdata.length);"
            "      if(_rok){_rok=__native__.nativeBytesEqual(_result,_rdata);}"
            "      return;"
            "    }"
            "    _out.push(r.value);_osize+=r.value.length;q();});}"
            "  q();});", &out));

        ASSERT_TRUE(host_poll_until_value(h, "_rok", "true", &out));
        EXPECT_TRUE(js_bool("_rok"));
    }
};

/* ================================================================
 * deflate-raw
 * ================================================================ */

TEST_F(CompressTestBase, DeflateRaw10Bytes) {
    test_roundtrip("deflate-raw",
        "new Uint8Array([65,66,65,66,65,66,65,66,65,66])");
}

TEST_F(CompressTestBase, DeflateRaw130Bytes) {
    test_roundtrip("deflate-raw",
        "new TextEncoder().encode('Hello World! '.repeat(10))");
}

TEST_F(CompressTestBase, DeflateRaw4_4KB) {
    test_roundtrip("deflate-raw",
        "new TextEncoder().encode('The quick brown fox jumps over the lazy dog. '.repeat(100))");
}

TEST_F(CompressTestBase, DeflateRaw64KB) {
    test_roundtrip("deflate-raw",
        "new TextEncoder().encode('ABCDEFGH'.repeat(8192))");
}

TEST_F(CompressTestBase, DeflateRaw1MB) {
    test_roundtrip("deflate-raw",
        "new TextEncoder().encode('Hello World! '.repeat(80000))");
}

/* ================================================================
 * deflate (zlib)
 * ================================================================ */

TEST_F(CompressTestBase, Deflate10Bytes) {
    test_roundtrip("deflate",
        "new Uint8Array([65,66,65,66,65,66,65,66,65,66])");
}

TEST_F(CompressTestBase, Deflate1_3KB) {
    test_roundtrip("deflate",
        "new TextEncoder().encode('Hello World! '.repeat(100))");
}

TEST_F(CompressTestBase, Deflate64KB) {
    test_roundtrip("deflate",
        "new TextEncoder().encode('ABCDEFGH'.repeat(8192))");
}

TEST_F(CompressTestBase, Deflate1MB) {
    test_roundtrip("deflate",
        "new TextEncoder().encode('Hello World! '.repeat(80000))");
}

/* ================================================================
 * gzip
 * ================================================================ */

TEST_F(CompressTestBase, Gzip10Bytes) {
    test_roundtrip("gzip",
        "new Uint8Array([65,66,65,66,65,66,65,66,65,66])");
}

TEST_F(CompressTestBase, Gzip1_3KB) {
    test_roundtrip("gzip",
        "new TextEncoder().encode('Hello World! '.repeat(100))");
}

TEST_F(CompressTestBase, Gzip64KB) {
    test_roundtrip("gzip",
        "new TextEncoder().encode('ABCDEFGH'.repeat(8192))");
}

TEST_F(CompressTestBase, Gzip1MB) {
    test_roundtrip("gzip",
        "new TextEncoder().encode('Hello World! '.repeat(80000))");
}

/* ================================================================
 * gzip header verification
 * ================================================================ */

TEST_F(CompressTestBase, GzipMagicBytes) {
    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var _gmOk=false;"
        "var _gd=new TextEncoder().encode('Hello World! '.repeat(100));"
        "var _gcs=new CompressionStream('gzip');"
        "var _gw=_gcs.writable.getWriter();"
        "var _grd=_gcs.readable.getReader();"
        "var _gch=[];var _gsz=0;", &out));

    ASSERT_TRUE(host_eval(h,
        "_gw.write(_gd).then(function(){return _gw.close();}).then(function(){"
        "  function p(){_grd.read().then(function(r){"
        "    if(r.done){return;}"
        "    _gch.push(r.value);_gsz+=r.value.length;p();});}"
        "  p();});", &out));

    /* 检查 gzip 魔数（压缩链已在本轮冲刷中完成，_gch 已就绪） */
    EXPECT_TRUE(js_bool("_gch[0][0]===0x1f&&_gch[0][1]===0x8b"));

    /* 用同一份压缩数据走 roundtrip */
    ASSERT_TRUE(host_eval(h,
        "var _gcomp=new Uint8Array(_gsz);var _go=0;"
        "for(var i=0;i<_gch.length;i++){_gcomp.set(_gch[i],_go);_go+=_gch[i].length;}"
        "var _gds=new DecompressionStream('gzip');"
        "var _gdw=_gds.writable.getWriter();"
        "var _gdrd=_gds.readable.getReader();"
        "var _gout=[];var _gosz=0;", &out));

    ASSERT_TRUE(host_eval(h,
        "_gdw.write(_gcomp).then(function(){return _gdw.close();}).then(function(){"
        "  function q(){_gdrd.read().then(function(r){"
        "    if(r.done){"
        "      var _gr=new Uint8Array(_gosz);var _go2=0;"
        "      for(var i=0;i<_gout.length;i++){_gr.set(_gout[i],_go2);_go2+=_gout[i].length;}"
        "      _gmOk=(_gr.length===_gd.length);"
        "      if(_gmOk){for(var i=0;i<_gr.length;i++){if(_gr[i]!==_gd[i]){_gmOk=false;break;}}}"
        "      return;"
        "    }"
        "    _gout.push(r.value);_gosz+=r.value.length;q();});}"
        "  q();});", &out));

    ASSERT_TRUE(host_poll_until_value(h, "_gmOk", "true", &out));
    EXPECT_TRUE(js_bool("_gmOk"));
}

/* ================================================================
 * compression ratio
 * ================================================================ */

TEST_F(CompressTestBase, Gzip1MBRatio) {
    std::string out;
    ASSERT_TRUE(host_eval(h,
        "var _ratio=1;var _ratioDone=false;var _rin=0;"
        "var _rd=new TextEncoder().encode('Hello World! '.repeat(80000));"
        "_rin=_rd.length;"
        "var _rcs=new CompressionStream('gzip');"
        "var _rw=_rcs.writable.getWriter();"
        "var _rrd=_rcs.readable.getReader();"
        "var _rch=[];var _rsz=0;", &out));

    ASSERT_TRUE(host_eval(h,
        "_rw.write(_rd).then(function(){return _rw.close();}).then(function(){"
        "  function p(){_rrd.read().then(function(r){"
        "    if(r.done){_ratio=_rsz/_rin;_ratioDone=true;return;}"
        "    _rch.push(r.value);_rsz+=r.value.length;p();});}"
        "  p();});", &out));

    ASSERT_TRUE(host_poll_until_value(h, "_ratioDone", "true", &out));

    ASSERT_TRUE(host_value(h, "_ratio", &out));
    double ratio = atof(out.c_str());
    EXPECT_LT(ratio, 1.0) << "1MB repetitive gzip should compress (ratio was " << (ratio * 100) << "%)";
}

/* ================================================================
 * binary data
 * ================================================================ */

TEST_F(CompressTestBase, GzipBinary64KB) {
    test_roundtrip("gzip",
        "(function(){var t=new Uint8Array(4096);for(var i=0;i<t.length;i++)t[i]=i&0xff;var a=new Uint8Array(65536);for(var o=0;o<a.length;o+=4096)a.set(t,o);return a;})()");
}

TEST_F(CompressTestBase, DeflateRawBinary128KB) {
    test_roundtrip("deflate-raw",
        "(function(){var t=new Uint8Array(4096);for(var i=0;i<t.length;i++)t[i]=(i*7+13)&0xff;var a=new Uint8Array(131072);for(var o=0;o<a.length;o+=4096)a.set(t,o);return a;})()");
}

TEST_F(CompressTestBase, GzipBinary1MB) {
    test_roundtrip("gzip",
        "(function(){var t=new Uint8Array(4096);for(var i=0;i<t.length;i++)t[i]=i&0x03;var a=new Uint8Array(1048576);for(var o=0;o<a.length;o+=4096)a.set(t,o);return a;})()");
}
