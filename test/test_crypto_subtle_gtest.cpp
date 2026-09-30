// test_crypto_subtle_gtest.cpp — crypto.subtle 宿主契约测试（执行模型 A / mock_libuv）
//
// 覆盖 test/wpt/crypto/subtle-digest.any.js 的测试向量：SHA-256 digest、
// HMAC sign/verify/importKey/exportKey/generateKey、PBKDF2 deriveBits。
// crypto.subtle 由 crypto 扩展（ext_crypto.c，QZ_WITH_CRYPTO_EXT=ON）在
// runtime 初始化时安装，所有操作返回 Promise，测试用全局变量 + 轮询断言。
#include "test_host.h"
#include <cstdio>
#include <cstring>

class CryptoSubtleTest : public ::testing::Test {
protected:
    HostCtx *h = nullptr;

    void SetUp() override {
        h = host_create();
        ASSERT_NE(nullptr, h);
    }
    void TearDown() override { host_destroy(h); }
};

// 异步执行 code（结果写全局 var），轮询直到 var 的 JSON 值包含 expected。
// timeout_ms 默认 5s；RSA 类用例在 ASan/UBSan 仪器化下 keygen+往返远超此值
// （mbedtls 3.6.7 起 RSA 解密走常量时间路径，更慢），故允许逐例放宽。
static bool poll_until(HostCtx *h, const char *var, const char *code,
                       const char *expected, std::string *out,
                       int timeout_ms = 5000) {
    std::string v;
    if (!host_eval(h, code, &v, timeout_ms)) return false;
    return host_poll_until_value(h, var, expected, out, timeout_ms);
}

// ================================================================
// crypto.subtle.digest — SHA-256 已知向量
// ================================================================

TEST_F(CryptoSubtleTest, DigestExists) {
    std::string v;
    ASSERT_TRUE(host_value(h,
        "JSON.stringify({obj: typeof crypto.subtle, fn: typeof crypto.subtle.digest})", &v));
    EXPECT_NE(std::string::npos, v.find("\"obj\":\"object\""));
    EXPECT_NE(std::string::npos, v.find("\"fn\":\"function\""));
}

// SHA-256 of empty input — e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
TEST_F(CryptoSubtleTest, DigestSHA256Empty) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_d",
        "var _d = null;\n"
        "crypto.subtle.digest('SHA-256', new Uint8Array(0)).then(function(buf){\n"
        "  var s=''; var u=new Uint8Array(buf);\n"
        "  for(var i=0;i<u.length;i++) s += u[i].toString(16).padStart(2,'0');\n"
        "  _d = s;\n"
        "});\n"
        "'go'",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", &v));
}

// SHA-256 of "hello" — 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
TEST_F(CryptoSubtleTest, DigestSHA256Hello) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_d",
        "var _d = null;\n"
        "crypto.subtle.digest('SHA-256', new TextEncoder().encode('hello')).then(function(buf){\n"
        "  var s=''; var u=new Uint8Array(buf);\n"
        "  for(var i=0;i<u.length;i++) s += u[i].toString(16).padStart(2,'0');\n"
        "  _d = s;\n"
        "});\n"
        "'go'",
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", &v));
}

// ================================================================
// HMAC — generateKey / sign / verify
// ================================================================

TEST_F(CryptoSubtleTest, HmacSignVerifyRoundTrip) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_r",
        "var _r = null;\n"
        "crypto.subtle.generateKey({name:'HMAC', hash:'SHA-256'}, false, ['sign','verify'])\n"
        "  .then(function(k){\n"
        "    var msg = new TextEncoder().encode('test message');\n"
        "    return crypto.subtle.sign({name:'HMAC'}, k, msg).then(function(sig){\n"
        "      return crypto.subtle.verify({name:'HMAC'}, k, sig, msg).then(function(ok){\n"
        "        _r = JSON.stringify({type:k.type, usages:k.usages, sigLen:sig.byteLength, ok:ok});\n"
        "      });\n"
        "    });\n"
        "  });\n"
        "'go'",
        "\"type\":\"secret\"", &v));
    EXPECT_NE(std::string::npos, v.find("\"usages\":[\"sign\",\"verify\"]"));
    EXPECT_NE(std::string::npos, v.find("\"sigLen\":32"));
    EXPECT_NE(std::string::npos, v.find("\"ok\":true"));
}

TEST_F(CryptoSubtleTest, HmacVerifyRejectsTampered) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_r",
        "var _r = null;\n"
        "crypto.subtle.generateKey({name:'HMAC', hash:'SHA-256'}, false, ['sign','verify'])\n"
        "  .then(function(k){\n"
        "    var msg = new TextEncoder().encode('test message');\n"
        "    return crypto.subtle.sign({name:'HMAC'}, k, msg).then(function(sig){\n"
        "      var tampered = new Uint8Array(msg); tampered[0] ^= 0xff;\n"
        "      return crypto.subtle.verify({name:'HMAC'}, k, sig, tampered).then(function(ok){\n"
        "        _r = JSON.stringify({ok:ok});\n"
        "      });\n"
        "    });\n"
        "  });\n"
        "'go'",
        "\"ok\":false", &v));
}

// generateKey 产出的 CryptoKey 属性（algorithm.name / extractable）
TEST_F(CryptoSubtleTest, GenerateKeyCryptoKeyAttrs) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_a",
        "var _a = null;\n"
        "crypto.subtle.generateKey({name:'HMAC', hash:'SHA-256'}, false, ['sign'])\n"
        "  .then(function(k){\n"
        "    var hashName = k.algorithm.hash.name || k.algorithm.hash;\n"
        "    _a = JSON.stringify({name:k.algorithm.name, hash:hashName, extractable:k.extractable});\n"
        "  });\n"
        "'go'",
        "\"name\":\"HMAC\"", &v));
    EXPECT_NE(std::string::npos, v.find("\"hash\":\"SHA-256\""));
    EXPECT_NE(std::string::npos, v.find("\"extractable\":false"));
}

// importKey(raw) + exportKey(raw) 往返
TEST_F(CryptoSubtleTest, HmacImportExportKey) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_e",
        "var _e = null;\n"
        "crypto.subtle.importKey('raw', new TextEncoder().encode('secret key'),\n"
        "  {name:'HMAC', hash:'SHA-256'}, true, ['sign'])\n"
        "  .then(function(k){ return crypto.subtle.exportKey('raw', k); })\n"
        "  .then(function(exp){ _e = new TextDecoder().decode(exp); });\n"
        "'go'",
        "secret key", &v));
}

// ================================================================
// PBKDF2 — importKey(raw) + deriveBits
// ================================================================

TEST_F(CryptoSubtleTest, Pbkdf2DeriveBits) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_p",
        "var _p = null;\n"
        "crypto.subtle.importKey('raw', new TextEncoder().encode('password'),\n"
        "  'PBKDF2', false, ['deriveBits'])\n"
        "  .then(function(k){\n"
        "    var salt = new Uint8Array(8);\n"
        "    return crypto.subtle.deriveBits(\n"
        "      {name:'PBKDF2', salt:salt, iterations:1000, hash:'SHA-256'}, k, 128)\n"
        "      .then(function(bits){\n"
        "        var s=''; var u=new Uint8Array(bits);\n"
        "        for(var i=0;i<u.length;i++) s += u[i].toString(16).padStart(2,'0');\n"
        "        _p = JSON.stringify({len:bits.byteLength, hex:s});\n"
        "      });\n"
        "  });\n"
        "'go'",
        "\"len\":16", &v));
    // 输出非平凡（不是全 0）
    EXPECT_NE(std::string::npos, v.find("\"hex\":\""));
    size_t hexpos = v.find("\"hex\":\"");
    ASSERT_NE(std::string::npos, hexpos);
    std::string hex = v.substr(hexpos + 7, 32);
    EXPECT_NE(std::string(32, '0'), hex);
}

// ================================================================
// AES encrypt/decrypt round-trips (algorithm correctness)
// ================================================================

TEST_F(CryptoSubtleTest, AesGcmRoundTrip) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_r",
        "var _r = null;\n"
        "crypto.subtle.generateKey({name:'AES-GCM', length:256}, false, ['encrypt','decrypt'])\n"
        "  .then(function(k){\n"
        "    var msg = new TextEncoder().encode('aes-gcm roundtrip payload');\n"
        "    var iv = new Uint8Array(12);\n"
        "    return crypto.subtle.encrypt({name:'AES-GCM', iv:iv}, k, msg).then(function(ct){\n"
        "      return crypto.subtle.decrypt({name:'AES-GCM', iv:iv}, k, ct).then(function(pt){\n"
        "        _r = JSON.stringify({txt:new TextDecoder().decode(pt), ctLen:ct.byteLength});\n"
        "      });\n"
        "    });\n"
        "  });\n"
        "'go'",
        "\"txt\":\"aes-gcm roundtrip payload\"", &v));
    /* GCM 输出 = 明文 + 16 字节 tag */
    EXPECT_NE(std::string::npos, v.find("\"ctLen\":41")) << "got: " << v;
}

TEST_F(CryptoSubtleTest, AesCbcRoundTrip) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_r",
        "var _r = null;\n"
        "crypto.subtle.generateKey({name:'AES-CBC', length:256}, false, ['encrypt','decrypt'])\n"
        "  .then(function(k){\n"
        "    var msg = new TextEncoder().encode('aes-cbc roundtrip payload');\n"
        "    var iv = new Uint8Array(16);\n"
        "    return crypto.subtle.encrypt({name:'AES-CBC', iv:iv}, k, msg).then(function(ct){\n"
        "      return crypto.subtle.decrypt({name:'AES-CBC', iv:iv}, k, ct).then(function(pt){\n"
        "        _r = new TextDecoder().decode(pt);\n"
        "      });\n"
        "    });\n"
        "  });\n"
        "'go'",
        "aes-cbc roundtrip payload", &v));
}

TEST_F(CryptoSubtleTest, AesCtrRoundTrip) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_r",
        "var _r = null;\n"
        "crypto.subtle.generateKey({name:'AES-CTR', length:256}, false, ['encrypt','decrypt'])\n"
        "  .then(function(k){\n"
        "    var msg = new TextEncoder().encode('aes-ctr roundtrip payload');\n"
        "    var counter = new Uint8Array(16);\n"
        "    return crypto.subtle.encrypt({name:'AES-CTR', counter:counter}, k, msg).then(function(ct){\n"
        "      return crypto.subtle.decrypt({name:'AES-CTR', counter:counter}, k, ct).then(function(pt){\n"
        "        _r = new TextDecoder().decode(pt);\n"
        "      });\n"
        "    });\n"
        "  });\n"
        "'go'",
        "aes-ctr roundtrip payload", &v));
}

// ================================================================
// wrapKey / unwrapKey (raw + jwk formats, AES-GCM wrapping)
// ================================================================

TEST_F(CryptoSubtleTest, WrapUnwrapKeyRoundTrip) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_w",
        "var _w = null;\n"
        "var _kek = null;\n"
        "crypto.subtle.generateKey({name:'AES-GCM', length:256}, false, ['wrapKey','unwrapKey'])\n"
        "  .then(function(kek){\n"
        "    _kek = kek;\n"
        "    return crypto.subtle.generateKey({name:'AES-GCM', length:128}, true, ['encrypt','decrypt']);\n"
        "  })\n"
        "  .then(function(target){\n"
        "    var iv = new Uint8Array(12);\n"
        "    return crypto.subtle.wrapKey('raw', target, _kek, {name:'AES-GCM', iv:iv}).then(function(wrapped){\n"
        "      return crypto.subtle.unwrapKey('raw', wrapped, _kek, {name:'AES-GCM', iv:iv},\n"
        "        {name:'AES-GCM', length:128}, true, ['encrypt','decrypt']).then(function(unwrapped){\n"
        "          var msg = new TextEncoder().encode('unwrapped key works');\n"
        "          var iv2 = new Uint8Array(12);\n"
        "          return crypto.subtle.encrypt({name:'AES-GCM', iv:iv2}, unwrapped, msg).then(function(ct){\n"
        "            return crypto.subtle.decrypt({name:'AES-GCM', iv:iv2}, unwrapped, ct).then(function(pt){\n"
        "              _w = JSON.stringify({wrappedLen:wrapped.byteLength, txt:new TextDecoder().decode(pt),\n"
        "                type:unwrapped.type, extractable:unwrapped.extractable});\n"
        "            });\n"
        "          });\n"
        "        });\n"
        "    });\n"
        "  });\n"
        "'go'",
        "\"txt\":\"unwrapped key works\"", &v));
    EXPECT_NE(std::string::npos, v.find("\"type\":\"secret\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"extractable\":true")) << "got: " << v;
    /* 128-bit key raw 16B + GCM tag 16B = 32B wrapped */
    EXPECT_NE(std::string::npos, v.find("\"wrappedLen\":32")) << "got: " << v;
}

TEST_F(CryptoSubtleTest, WrapUnwrapJwk) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_j",
        "var _j = null;\n"
        "var _kek = null;\n"
        "crypto.subtle.generateKey({name:'AES-GCM', length:256}, false, ['wrapKey','unwrapKey'])\n"
        "  .then(function(kek){\n"
        "    _kek = kek;\n"
        "    return crypto.subtle.importKey('raw', new TextEncoder().encode('0123456789abcdef'),\n"
        "      {name:'AES-GCM', length:128}, true, ['encrypt']);\n"
        "  })\n"
        "  .then(function(target){\n"
        "    var iv = new Uint8Array(12);\n"
        "    return crypto.subtle.wrapKey('jwk', target, _kek, {name:'AES-GCM', iv:iv}).then(function(wrapped){\n"
        "      return crypto.subtle.unwrapKey('jwk', wrapped, _kek, {name:'AES-GCM', iv:iv},\n"
        "        {name:'AES-GCM', length:128}, true, ['encrypt']).then(function(unwrapped){\n"
        "          return crypto.subtle.exportKey('raw', unwrapped).then(function(raw){\n"
        "            _j = JSON.stringify({txt:new TextDecoder().decode(raw), type:unwrapped.type});\n"
        "          });\n"
        "        });\n"
        "    });\n"
        "  });\n"
        "'go'",
        "\"txt\":\"0123456789abcdef\"", &v));
    EXPECT_NE(std::string::npos, v.find("\"type\":\"secret\"")) << "got: " << v;
}

// SHA-1/SHA-384/SHA-512 of empty input — verify all four SHA variants work
// (existing DigestSHA256Empty/Hello only covered SHA-256).
TEST_F(CryptoSubtleTest, DigestShaVariants) {
    std::string v;
    // SHA-1("") = da39a3ee5e6b4b0d3255bfef95601890afd80709
    ASSERT_TRUE(poll_until(h, "_d1",
        "var _d1=null;\n"
        "crypto.subtle.digest('SHA-1', new Uint8Array(0)).then(function(buf){\n"
        "  var s=''; var u=new Uint8Array(buf);\n"
        "  for(var i=0;i<u.length;i++) s+=u[i].toString(16).padStart(2,'0');\n"
        "  _d1=s;\n"
        "});\n'go'",
        "da39a3ee5e6b4b0d3255bfef95601890afd80709", &v));
    // SHA-384("") = 38b060a751ac96384cd9327eb1b1e36a21fdb71114bebe43...
    ASSERT_TRUE(poll_until(h, "_d2",
        "var _d2=null;\n"
        "crypto.subtle.digest('SHA-384', new Uint8Array(0)).then(function(buf){\n"
        "  var s=''; var u=new Uint8Array(buf);\n"
        "  for(var i=0;i<u.length;i++) s+=u[i].toString(16).padStart(2,'0');\n"
        "  _d2=s;\n"
        "});\n'go'",
        "38b060a751ac96384cd9327eb1b1e36a", &v));
    // SHA-512("") = cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc...
    ASSERT_TRUE(poll_until(h, "_d3",
        "var _d3=null;\n"
        "crypto.subtle.digest('SHA-512', new Uint8Array(0)).then(function(buf){\n"
        "  var s=''; var u=new Uint8Array(buf);\n"
        "  for(var i=0;i<u.length;i++) s+=u[i].toString(16).padStart(2,'0');\n"
        "  _d3=s;\n"
        "});\n'go'",
        "cf83e1357eefb8bdf1542850d66d8007", &v));
}

// importKey('jwk') + exportKey('jwk') direct round-trip (existing tests only
// cover raw import/export and jwk via wrapKey/unwrapKey).
TEST_F(CryptoSubtleTest, JwkImportExportRoundTrip) {
    std::string v;
    // importKey('raw', 'test-key') -> exportKey('jwk') -> importKey('jwk')
    // -> exportKey('raw') must yield the original key bytes.
    // 'test-key' hex = 746573742d6b6579
    ASSERT_TRUE(poll_until(h, "_j",
        "var _j = null;\n"
        "crypto.subtle.importKey('raw', new TextEncoder().encode('test-key'),\n"
        "  {name:'HMAC',hash:'SHA-256'}, true, ['sign']).then(function(k){\n"
        "  return crypto.subtle.exportKey('jwk', k);\n"
        "}).then(function(jwk){\n"
        "  return crypto.subtle.importKey('jwk', jwk, {name:'HMAC',hash:'SHA-256'}, true, ['sign']);\n"
        "}).then(function(k2){\n"
        "  return crypto.subtle.exportKey('raw', k2);\n"
        "}).then(function(raw){\n"
        "  var s=''; var u=new Uint8Array(raw);\n"
        "  for(var i=0;i<u.length;i++) s+=u[i].toString(16).padStart(2,'0');\n"
        "  _j = s;\n"
        "});\n'go'",
        "746573742d6b6579", &v));
}

// ================================================================
// HKDF — importKey(raw) + deriveBits / deriveKey
// ================================================================

// JS 片段：把 ArrayBuffer/Uint8Array 转 hex 字符串（供本文件后续测试复用）
static const char *kJsHex = "function _hx(b){var s='';var u=new Uint8Array(b);"
    "for(var i=0;i<u.length;i++)s+=u[i].toString(16).padStart(2,'0');return s;}";

// RFC 5869 Test Case 1 已知向量 (SHA-256, L=336 bits=42 bytes)
// OKM = 3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865
TEST_F(CryptoSubtleTest, HkdfDeriveBitsRfc5869) {
    std::string v;
    std::string code = std::string(kJsHex) + R"(
var _d = null;
var ikm = new Uint8Array(22); ikm.fill(0x0b);
var salt = new Uint8Array([0,1,2,3,4,5,6,7,8,9,10,11,12]);
var info = new Uint8Array([0xf0,0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,0xf9]);
crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']).then(function(k){
  return crypto.subtle.deriveBits({name:'HKDF', hash:'SHA-256', salt:salt, info:info}, k, 336)
    .then(function(bits){ _d = JSON.stringify({len: bits.byteLength, hex: _hx(bits)}); });
});
'go'
)";
    ASSERT_TRUE(poll_until(h, "_d", code.c_str(),
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865", &v));
    EXPECT_NE(std::string::npos, v.find("\"len\":42")) << "got: " << v;
}

// deriveKey 派生 AES-GCM 密钥并完成加密往返（验证 deriveKey 路径与派生密钥可用）
TEST_F(CryptoSubtleTest, HkdfDeriveKeyRoundTrip) {
    std::string v;
    std::string code = std::string(kJsHex) + R"(
var _k = null;
var ikm = new TextEncoder().encode('hkdf test ikm material');
var salt = new Uint8Array([1,2,3,4,5,6,7,8]);
var info = new Uint8Array([9,10,11,12]);
crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']).then(function(bk){
  return crypto.subtle.deriveKey({name:'HKDF', hash:'SHA-256', salt:salt, info:info}, bk,
    {name:'AES-GCM', length:128}, false, ['encrypt','decrypt']).then(function(ak){
      var msg = new TextEncoder().encode('hkdf derived key roundtrip');
      var iv = new Uint8Array(12);
      return crypto.subtle.encrypt({name:'AES-GCM', iv:iv}, ak, msg).then(function(ct){
        return crypto.subtle.decrypt({name:'AES-GCM', iv:iv}, ak, ct).then(function(pt){
          _k = JSON.stringify({txt: new TextDecoder().decode(pt), type: ak.type, usages: ak.usages});
        });
      });
  });
});
'go'
)";
    ASSERT_TRUE(poll_until(h, "_k", code.c_str(),
        "\"txt\":\"hkdf derived key roundtrip\"", &v));
    EXPECT_NE(std::string::npos, v.find("\"type\":\"secret\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"usages\":[\"encrypt\",\"decrypt\"]")) << "got: " << v;
}

// 同一 IKM/salt/info 下 SHA-1/SHA-384/SHA-512 均可用，输出互不相同且非全零
TEST_F(CryptoSubtleTest, HkdfShaVariants) {
    std::string v;
    std::string code = std::string(kJsHex) + R"(
var _h = null;
function deriveH(hash){
  var ikm = new TextEncoder().encode('hkdf multi-hash ikm');
  var salt = new Uint8Array([1,2,3,4,5,6,7,8]);
  var info = new Uint8Array([9,10,11,12]);
  return crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']).then(function(k){
    return crypto.subtle.deriveBits({name:'HKDF', hash:hash, salt:salt, info:info}, k, 256)
      .then(function(bits){ return _hx(bits); });
  });
}
Promise.all([deriveH('SHA-1'), deriveH('SHA-384'), deriveH('SHA-512')]).then(function(hs){
  var z = '0000000000000000000000000000000000000000000000000000000000000000';
  _h = JSON.stringify({len: 32,
    distinct: hs[0] !== hs[1] && hs[1] !== hs[2] && hs[0] !== hs[2],
    nonzero: hs[0] !== z && hs[1] !== z && hs[2] !== z});
});
'go'
)";
    ASSERT_TRUE(poll_until(h, "_h", code.c_str(), "\"distinct\":true", &v));
    EXPECT_NE(std::string::npos, v.find("\"nonzero\":true")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"len\":32")) << "got: " << v;
}

// ================================================================
// AES-KW (RFC 3394) — wrapKey/unwrapKey roundtrip（wrap 后 unwrap 还原字节一致）
// ================================================================

TEST_F(CryptoSubtleTest, AesKwWrapUnwrapRoundTrip) {
    std::string v;
    std::string code = std::string(kJsHex) + R"(
var _w = null;
var _kek = null; var _orig = '';
crypto.subtle.generateKey({name:'AES-KW', length:256}, false, ['wrapKey','unwrapKey']).then(function(kek){
  _kek = kek;
  return crypto.subtle.generateKey({name:'AES-GCM', length:128}, true, ['encrypt','decrypt']);
}).then(function(target){
  return crypto.subtle.exportKey('raw', target).then(function(raw){
    _orig = _hx(raw);
    return crypto.subtle.wrapKey('raw', target, _kek, {name:'AES-KW'}).then(function(wrapped){
      return crypto.subtle.unwrapKey('raw', wrapped, _kek, {name:'AES-KW'},
        {name:'AES-GCM', length:128}, true, ['encrypt','decrypt']).then(function(unwrapped){
          return crypto.subtle.exportKey('raw', unwrapped).then(function(raw2){
            _w = JSON.stringify({wrappedLen: wrapped.byteLength, orig: _orig, hex: _hx(raw2),
              match: _orig === _hx(raw2), type: unwrapped.type});
          });
      });
    });
  });
});
'go'
)";
    ASSERT_TRUE(poll_until(h, "_w", code.c_str(), "\"type\":\"secret\"", &v));
    EXPECT_NE(std::string::npos, v.find("\"match\":true")) << "got: " << v;
    /* RFC 3394: wrapped = 明文(16B) + 8B 完整性块 => 24B */
    EXPECT_NE(std::string::npos, v.find("\"wrappedLen\":24")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"orig\"")) << "got: " << v;
}

// ================================================================
// ECDSA — generateKey / sign / verify 往返 + import/exportKey(jwk)
// ================================================================

TEST_F(CryptoSubtleTest, EcdsaP256SignVerifyRoundTrip) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_e",
        "var _e = null;\n"
        "crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign','verify'])\n"
        "  .then(function(kp){\n"
        "    var msg = new TextEncoder().encode('ecdsa p-256 message');\n"
        "    return crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, kp.privateKey, msg).then(function(sig){\n"
        "      return crypto.subtle.verify({name:'ECDSA', hash:'SHA-256'}, kp.publicKey, sig, msg).then(function(ok){\n"
        "        _e = JSON.stringify({sigLen: sig.byteLength, ok: ok,\n"
        "          pubType: kp.publicKey.type, privType: kp.privateKey.type,\n"
        "          curve: kp.publicKey.algorithm.namedCurve, usages: kp.privateKey.usages});\n"
        "      });\n"
        "    });\n"
        "  });\n'go'",
        "\"ok\":true", &v));
    EXPECT_NE(std::string::npos, v.find("\"sigLen\":64")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"pubType\":\"public\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"privType\":\"private\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"curve\":\"P-256\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"usages\":[\"sign\"]")) << "got: " << v;
}

// 负例：篡改签名或消息后 verify 必须返回 false
TEST_F(CryptoSubtleTest, EcdsaP256VerifyRejectsTampered) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_e",
        "var _e = null;\n"
        "crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, false, ['sign','verify'])\n"
        "  .then(function(kp){\n"
        "    var msg = new TextEncoder().encode('ecdsa tamper test');\n"
        "    return crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, kp.privateKey, msg).then(function(sig){\n"
        "      var s2 = new Uint8Array(sig); s2[0] ^= 0x01;\n"
        "      return crypto.subtle.verify({name:'ECDSA', hash:'SHA-256'}, kp.publicKey, s2, msg).then(function(badSig){\n"
        "        var t2 = new Uint8Array(msg); t2[0] ^= 0xff;\n"
        "        return crypto.subtle.verify({name:'ECDSA', hash:'SHA-256'}, kp.publicKey, sig, t2).then(function(badMsg){\n"
        "          _e = JSON.stringify({badSig: badSig, badMsg: badMsg});\n"
        "        });\n"
        "      });\n"
        "    });\n"
        "  });\n'go'",
        "\"badSig\":false", &v));
    EXPECT_NE(std::string::npos, v.find("\"badMsg\":false")) << "got: " << v;
}

// exportKey('jwk', 私钥) -> importKey('jwk') 后仍能签出被原公钥验证的签名
TEST_F(CryptoSubtleTest, EcdsaP256ImportExportJwk) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_e",
        "var _e = null;\n"
        "crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign','verify'])\n"
        "  .then(function(kp){\n"
        "    var msg = new TextEncoder().encode('ecdsa jwk roundtrip');\n"
        "    return crypto.subtle.exportKey('jwk', kp.privateKey).then(function(jwk){\n"
        "      return crypto.subtle.importKey('jwk', jwk, {name:'ECDSA', namedCurve:'P-256'}, false, ['sign'])\n"
        "        .then(function(imp){\n"
        "          return crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, imp, msg).then(function(sig){\n"
        "            return crypto.subtle.verify({name:'ECDSA', hash:'SHA-256'}, kp.publicKey, sig, msg).then(function(ok){\n"
        "              return crypto.subtle.exportKey('jwk', kp.publicKey).then(function(pubjwk){\n"
        "                _e = JSON.stringify({kty: jwk.kty, crv: jwk.crv, hasD: !!jwk.d,\n"
        "                  hasX: !!jwk.x, hasY: !!jwk.y, ok: ok, pubKty: pubjwk.kty, pubX: !!pubjwk.x});\n"
        "              });\n"
        "            });\n"
        "          });\n"
        "        });\n"
        "    });\n"
        "  });\n'go'",
        "\"ok\":true", &v));
    EXPECT_NE(std::string::npos, v.find("\"kty\":\"EC\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"crv\":\"P-256\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"hasD\":true")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"hasX\":true")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"hasY\":true")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"pubKty\":\"EC\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"pubX\":true")) << "got: " << v;
}

// 多曲线覆盖：P-384 sign/verify（r||s = 96B）
TEST_F(CryptoSubtleTest, EcdsaP384SignVerify) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_e",
        "var _e = null;\n"
        "crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-384'}, false, ['sign','verify'])\n"
        "  .then(function(kp){\n"
        "    var msg = new TextEncoder().encode('ecdsa p-384 message');\n"
        "    return crypto.subtle.sign({name:'ECDSA', hash:'SHA-384'}, kp.privateKey, msg).then(function(sig){\n"
        "      return crypto.subtle.verify({name:'ECDSA', hash:'SHA-384'}, kp.publicKey, sig, msg).then(function(ok){\n"
        "        _e = JSON.stringify({sigLen: sig.byteLength, ok: ok, curve: kp.publicKey.algorithm.namedCurve});\n"
        "      });\n"
        "    });\n"
        "  });\n'go'",
        "\"ok\":true", &v));
    EXPECT_NE(std::string::npos, v.find("\"sigLen\":96")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"curve\":\"P-384\"")) << "got: " << v;
}

// ================================================================
// ECDH — 双方 generateKey 后 deriveBits 共享密钥一致 (P-256, 32B)
// ================================================================

TEST_F(CryptoSubtleTest, EcdhP256SharedSecret) {
    std::string v;
    std::string code = std::string(kJsHex) + R"(
var _e = null;
crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, false, ['deriveBits']).then(function(a){
  return crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, false, ['deriveBits']).then(function(b){
    return crypto.subtle.deriveBits({name:'ECDH', public: b.publicKey}, a.privateKey, 256).then(function(sa){
      return crypto.subtle.deriveBits({name:'ECDH', public: a.publicKey}, b.privateKey, 256).then(function(sb){
        var ua = new Uint8Array(sa); var ub = new Uint8Array(sb);
        var match = ua.length === ub.length;
        var nonzero = false;
        for (var i = 0; i < ua.length; i++) { if (ua[i] !== ub[i]) match = false; if (ua[i] !== 0) nonzero = true; }
        _e = JSON.stringify({len: ua.length, match: match, nonzero: nonzero, hex: _hx(sa)});
      });
    });
  });
});
'go'
)";
    ASSERT_TRUE(poll_until(h, "_e", code.c_str(), "\"match\":true", &v));
    EXPECT_NE(std::string::npos, v.find("\"len\":32")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"nonzero\":true")) << "got: " << v;
}

// ================================================================
// RSA-OAEP — generateKey / encrypt / decrypt roundtrip (2048)
// ================================================================

TEST_F(CryptoSubtleTest, RsaOaepGenerateEncryptDecryptRoundTrip) {
    std::string v;
    std::string code = std::string(kJsHex) + R"(
var _e = null;
crypto.subtle.generateKey({name:'RSA-OAEP', modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256'}, false, ['encrypt','decrypt'])
  .then(function(kp){
    var msg = new TextEncoder().encode('hello rsa oaep 2048');
    return crypto.subtle.encrypt({name:'RSA-OAEP'}, kp.publicKey, msg).then(function(ct){
      return crypto.subtle.decrypt({name:'RSA-OAEP'}, kp.privateKey, ct).then(function(pt){
        _e = JSON.stringify({ctLen: ct.byteLength, match: _hx(pt) === _hx(msg),
          pubType: kp.publicKey.type, privType: kp.privateKey.type,
          alg: kp.publicKey.algorithm.name, hash: kp.publicKey.algorithm.hash,
          usages: kp.privateKey.usages});
      });
    });
  });
'go'
)";
    ASSERT_TRUE(poll_until(h, "_e", code.c_str(), "\"match\":true", &v, 90000));
    EXPECT_NE(std::string::npos, v.find("\"ctLen\":256")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"pubType\":\"public\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"privType\":\"private\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"alg\":\"RSA-OAEP\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"hash\":\"SHA-256\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"usages\":[\"decrypt\"]")) << "got: " << v;
}

// ================================================================
// RSASSA-PKCS1-v1_5 — generateKey / sign / verify roundtrip (2048)
// ================================================================

TEST_F(CryptoSubtleTest, RsaSsaSignVerifyRoundTrip) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_e",
        "var _e = null;\n"
        "crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5', modulusLength:2048, hash:'SHA-256'}, false, ['sign','verify'])\n"
        "  .then(function(kp){\n"
        "    var msg = new TextEncoder().encode('rsassa pkcs1 v1 5 message');\n"
        "    return crypto.subtle.sign({name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, kp.privateKey, msg).then(function(sig){\n"
        "      return crypto.subtle.verify({name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, kp.publicKey, sig, msg).then(function(ok){\n"
        "        _e = JSON.stringify({sigLen: sig.byteLength, ok: ok,\n"
        "          pubType: kp.publicKey.type, privType: kp.privateKey.type,\n"
        "          alg: kp.publicKey.algorithm.name, usages: kp.privateKey.usages});\n"
        "      });\n"
        "    });\n"
        "  });\n'go'",
        "\"ok\":true", &v, 90000));
    EXPECT_NE(std::string::npos, v.find("\"sigLen\":256")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"pubType\":\"public\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"privType\":\"private\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"alg\":\"RSASSA-PKCS1-v1_5\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"usages\":[\"sign\"]")) << "got: " << v;
}

// 负例：篡改签名或消息后 verify 必须返回 false
TEST_F(CryptoSubtleTest, RsaSsaVerifyRejectsTampered) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_e",
        "var _e = null;\n"
        "crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5', modulusLength:2048, hash:'SHA-256'}, false, ['sign','verify'])\n"
        "  .then(function(kp){\n"
        "    var msg = new TextEncoder().encode('rsa tamper test');\n"
        "    return crypto.subtle.sign({name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, kp.privateKey, msg).then(function(sig){\n"
        "      var s2 = new Uint8Array(sig); s2[0] ^= 0x01;\n"
        "      return crypto.subtle.verify({name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, kp.publicKey, s2, msg).then(function(badSig){\n"
        "        var t2 = new Uint8Array(msg); t2[0] ^= 0xff;\n"
        "        return crypto.subtle.verify({name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, kp.publicKey, sig, t2).then(function(badMsg){\n"
        "          _e = JSON.stringify({badSig: badSig, badMsg: badMsg});\n"
        "        });\n"
        "      });\n"
        "    });\n"
        "  });\n'go'",
        "\"badSig\":false", &v, 90000));
    EXPECT_NE(std::string::npos, v.find("\"badMsg\":false")) << "got: " << v;
}

// ================================================================
// RSA importKey/exportKey — spki（公钥）+ pkcs8（私钥）往返
// ================================================================

TEST_F(CryptoSubtleTest, RsaImportExportSpkiPkcs8) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_e",
        "var _e = null;\n"
        "crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5', modulusLength:2048, hash:'SHA-256'}, true, ['sign','verify'])\n"
        "  .then(function(kp){\n"
        "    var msg = new TextEncoder().encode('rsa spki pkcs8 roundtrip');\n"
        "    return crypto.subtle.sign({name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, kp.privateKey, msg).then(function(sig){\n"
        "      return crypto.subtle.exportKey('spki', kp.publicKey).then(function(spki){\n"
        "        return crypto.subtle.exportKey('pkcs8', kp.privateKey).then(function(pkcs8){\n"
        "          return crypto.subtle.importKey('spki', spki, {name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, false, ['verify']).then(function(pubImp){\n"
        "            return crypto.subtle.importKey('pkcs8', pkcs8, {name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, false, ['sign']).then(function(privImp){\n"
        "              return crypto.subtle.verify({name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, pubImp, sig, msg).then(function(v1){\n"
        "                return crypto.subtle.sign({name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, privImp, msg).then(function(sig2){\n"
        "                  return crypto.subtle.verify({name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, kp.publicKey, sig2, msg).then(function(v2){\n"
        "                    _e = JSON.stringify({spkiLen: spki.byteLength, pkcs8Len: pkcs8.byteLength,\n"
        "                      spkiBig: spki.byteLength > 250, pkcs8Big: pkcs8.byteLength > 1100,\n"
        "                      v1: v1, v2: v2, pubType: pubImp.type, privType: privImp.type,\n"
        "                      pubExtractable: pubImp.extractable});\n"
        "                  });\n"
        "                });\n"
        "              });\n"
        "            });\n"
        "          });\n"
        "        });\n"
        "      });\n"
        "    });\n"
        "  });\n'go'",
        "\"v1\":true", &v, 90000));
    EXPECT_NE(std::string::npos, v.find("\"v2\":true")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"pubType\":\"public\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"privType\":\"private\"")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"spkiBig\":true")) << "got: " << v;
    EXPECT_NE(std::string::npos, v.find("\"pkcs8Big\":true")) << "got: " << v;
}

// ================================================================
// RSA 密钥长度边界 — 1024 拒绝；3072 可用
// ================================================================

TEST_F(CryptoSubtleTest, RsaRejectsModulus1024) {
    std::string v;
    ASSERT_TRUE(poll_until(h, "_e",
        "var _e = null;\n"
        "crypto.subtle.generateKey({name:'RSA-OAEP', modulusLength:1024, hash:'SHA-256'}, false, ['encrypt','decrypt'])\n"
        "  .then(function(){ _e = JSON.stringify({rejected:false}); },\n"
        "        function(err){ _e = JSON.stringify({rejected:true, name:(err && err.name)||String(err)}); });\n'go'",
        "\"rejected\":true", &v, 90000));
}

TEST_F(CryptoSubtleTest, RsaOaep3072RoundTrip) {
    std::string v;
    std::string code = std::string(kJsHex) + R"(
var _e = null;
crypto.subtle.generateKey({name:'RSA-OAEP', modulusLength:3072, hash:'SHA-256'}, false, ['encrypt','decrypt'])
  .then(function(kp){
    var msg = new TextEncoder().encode('3072 oaep message');
    return crypto.subtle.encrypt({name:'RSA-OAEP'}, kp.publicKey, msg).then(function(ct){
      return crypto.subtle.decrypt({name:'RSA-OAEP'}, kp.privateKey, ct).then(function(pt){
        _e = JSON.stringify({ctLen: ct.byteLength, match: _hx(pt) === _hx(msg)});
      });
    });
  });
'go'
)";
    /* gcov 插桩（-O0 --coverage）下 mbedTLS 3072 位 keygen + 往返是最慢的用例：
     * 全部耗时计入 host_eval 的同步预算 + 下方 poll 预算。实测 2048 位在 coverage
     * 下已需 ~10-40s，3072 位再慢约 3x——60s poll 在 CI 上偶发不足（本条曾在
     * e4b2b866 绿、1b5dd3e5 红，边界抖动）。给足 120s 双向预算：这是最慢的单个
     * 用例，多等一会儿不影响整体（coverage job 时限 60min）。 */
    if (!host_eval(h, code.c_str(), &v, 120000)) { FAIL() << "3072 setup eval failed"; }
    ASSERT_TRUE(host_poll_until_value(h, "_e", "\"match\":true", &v, 120000));
    EXPECT_NE(std::string::npos, v.find("\"ctLen\":384")) << "got: " << v;
}
