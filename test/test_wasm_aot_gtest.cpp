// test_wasm_aot_gtest.cpp — WAMR AOT bypass (Tier 0/1).
//
// WebAssembly.compile / instantiate / compileStreaming / instantiateStreaming
// accept a non-standard optional options arg {aot: aotBytes, aotFail?: fn}:
// when .aot bytes are provided, the AOT module is tried first
// (wasm_runtime_load auto-dispatches \0aot by magic to aot_load_from_aot_file);
// on load failure the call silently falls back to the interpreter path with
// the portable .wasm bytes (fail-open) and aotFail(e) is invoked when given.
// With only .aot bytes and no .wasm backup the failure still throws
// (TypeError), matching the existing explicit-selection semantics.
//
// Real .aot bytes require wamrc + LLVM (host tool, not available in this
// repo), so the fixture is a forged \0aot magic + wrong version byte
// (0 != WAMR's AOT_CURRENT_VERSION=5): the magic routes to the AOT loader,
// which rejects the version ("unknown binary version") — a deterministic way
// to exercise the fail-open fallback. Real .aot end-to-end (AOT load success,
// AOT module + imports double-load) needs a wamrc/LLVM host to verify.
#include "test_host.h"

// add.wasm — exports add(i32,i32)->i32 (same fixture as the streaming test).
static const unsigned char kAddModule[] = {
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60,
    0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01,
    0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09, 0x01, 0x07, 0x00, 0x20,
    0x00, 0x20, 0x01, 0x6a, 0x0b
};

// i64.wat — exports id64(i64)->i64, add64(i64,i64)->i64, hi()->i64.
// Guards the export-side i64 bridge: arguments accepted as BigInt
// (JS_ToInt64Ext) and results returned as BigInt (JS_NewBigInt64) — a plain
// Number return corrupts values above 2^31 (NaN-box handles live there).
static const unsigned char kI64Module[] = {
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x10, 0x03, 0x60,
    0x01, 0x7e, 0x01, 0x7e, 0x60, 0x02, 0x7e, 0x7e, 0x01, 0x7e, 0x60, 0x00,
    0x01, 0x7e, 0x03, 0x04, 0x03, 0x00, 0x01, 0x02, 0x07, 0x15, 0x03, 0x04,
    0x69, 0x64, 0x36, 0x34, 0x00, 0x00, 0x05, 0x61, 0x64, 0x64, 0x36, 0x34,
    0x00, 0x01, 0x02, 0x68, 0x69, 0x00, 0x02, 0x0a, 0x1c, 0x03, 0x04, 0x00,
    0x20, 0x00, 0x0b, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x7c, 0x0b, 0x0d,
    0x00, 0x42, 0x81, 0x80, 0x80, 0x80, 0x80, 0x80, 0xc0, 0xfc, 0xff, 0x00,
    0x0b
};

// Forged .aot: \0aot magic (0x00 0x61 0x6f 0x74) + version 0 (≠ 5). WAMR's
// wasm_runtime_load routes on the magic to aot_load_from_aot_file, which
// rejects the version -> load fails -> the JS shim must fall back to .wasm.
static const unsigned char kBadAotModule[] = {
    0x00, 0x61, 0x6f, 0x74,
    0x00, 0x00, 0x00, 0x00
};

// shrink.wasm — declares (memory 32) and exports it, but has no memory.size/
// memory.grow. WAMR's SHRUNK_MEMORY loader path folds the declared page count
// into num_bytes_per_page and collapses init_page_count to 1; the export shim
// must derive the buffer length from the real page size, not a hardcoded
// 64 KiB spec constant, or the ArrayBuffer undershoots the live memory.
static const unsigned char kShrinkMemModule[] = {
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x0b, 0x02, 0x60,
    0x02, 0x7f, 0x7f, 0x00, 0x60, 0x01, 0x7f, 0x01, 0x7f, 0x03, 0x03, 0x02,
    0x00, 0x01, 0x05, 0x03, 0x01, 0x00, 0x20, 0x07, 0x18, 0x03, 0x06, 0x6d,
    0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x04, 0x70, 0x6f, 0x6b, 0x65,
    0x00, 0x00, 0x04, 0x70, 0x65, 0x65, 0x6b, 0x00, 0x01, 0x0a, 0x13, 0x02,
    0x09, 0x00, 0x20, 0x00, 0x20, 0x01, 0x36, 0x02, 0x00, 0x0b, 0x07, 0x00,
    0x20, 0x00, 0x28, 0x02, 0x00, 0x0b
};

// JS fixtures: _wasmBytes (ArrayBuffer), _badAot (ArrayBuffer), _src (a
// streaming source whose arrayBuffer() resolves to the wasm bytes).
static const std::string kFixtures = [] {
    std::string s = "var _wasmBytes = new Uint8Array([";
    for (size_t i = 0; i < sizeof(kAddModule); i++) {
        if (i) s += ",";
        s += std::to_string(kAddModule[i]);
    }
    s += "]).buffer;\n";
    s += "var _badAot = new Uint8Array([";
    for (size_t i = 0; i < sizeof(kBadAotModule); i++) {
        if (i) s += ",";
        s += std::to_string(kBadAotModule[i]);
    }
    s += "]).buffer;\n";
    s += "var _i64Bytes = new Uint8Array([";
    for (size_t i = 0; i < sizeof(kI64Module); i++) {
        if (i) s += ",";
        s += std::to_string(kI64Module[i]);
    }
    s += "]).buffer;\n";
    s += "var _shrinkBytes = new Uint8Array([";
    for (size_t i = 0; i < sizeof(kShrinkMemModule); i++) {
        if (i) s += ",";
        s += std::to_string(kShrinkMemModule[i]);
    }
    s += "]).buffer;\n";
    s += "var _src = { arrayBuffer: function(){ return Promise.resolve(_wasmBytes); } };";
    return s;
}();

// instantiate(bytes, imports, {aot}) with a failing .aot -> fail-open: the
// interpreter path must still produce a working instance.
TEST(wasm_aot, instantiate_aot_fallback_to_interpreter) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h, (kFixtures +
        "\nvar _r = null;\n"
        "WebAssembly.instantiate(_wasmBytes, undefined, {aot: _badAot})\n"
        "  .then(function(res){ _r = res.instance.exports.add(2, 3); })\n"
        "  .catch(function(e){ _r = 'ERR:' + e.message; });\n"
        "0").c_str(), &out));

    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "String(_r)", "5", &v))
        << "aot fallback did not produce add(2,3)==5, got: " << v;
    host_destroy(h);
}

// The aotFail callback must fire with the AOT load error, and the fallback
// module must still be usable (fail-open, not a silent wrong path).
TEST(wasm_aot, aotFail_callback_receives_error_and_module_works) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h, (kFixtures +
        "\nvar _r = null, _fired = false, _msg = '';\n"
        "WebAssembly.instantiate(_wasmBytes, undefined, {\n"
        "  aot: _badAot,\n"
        "  aotFail: function(e){ _fired = true; _msg = String(e && e.message || e); }\n"
        "})\n"
        "  .then(function(res){ _r = res.instance.exports.add(10, 20); })\n"
        "  .catch(function(e){ _r = 'ERR:' + e.message; });\n"
        "0").c_str(), &out));

    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "String(_r)", "30", &v))
        << "fallback after aotFail did not produce add(10,20)==30, got: " << v;
    ASSERT_TRUE(host_poll_until_value(h, "String(_fired)", "true", &v))
        << "aotFail callback was not invoked, got: " << v;
    ASSERT_TRUE(host_poll_until_value(h, "String(_msg.length > 0)", "true", &v))
        << "aotFail should receive a non-empty error, got: " << v;
    host_destroy(h);
}

// compile(bytes, {aot}) -> Promise<Module>; failing aot falls back to the
// interpreter module, which must instantiate and run.
TEST(wasm_aot, compile_aot_fallback_and_instantiates) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h, (kFixtures +
        "\nvar _r = null;\n"
        "WebAssembly.compile(_wasmBytes, {aot: _badAot})\n"
        "  .then(function(mod){ return new WebAssembly.Instance(mod); })\n"
        "  .then(function(inst){ _r = inst.exports.add(4, 5); })\n"
        "  .catch(function(e){ _r = 'ERR:' + e.message; });\n"
        "0").c_str(), &out));

    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "String(_r)", "9", &v))
        << "compile aot fallback did not produce add(4,5)==9, got: " << v;
    host_destroy(h);
}

// Pure .aot bytes (no options, no .wasm backup) that fail to load still throw
// TypeError — explicit selection means explicit failure.
TEST(wasm_aot, pure_aot_without_wasm_throws_typeerror) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h, (kFixtures +
        "\nvar _r = 'not-run';\n"
        "try { WebAssembly.instantiate(_badAot); _r = 'no-throw'; }\n"
        "catch (e) { _r = e.name; }\n"
        "0").c_str(), &out));

    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "String(_r)", "TypeError", &v))
        << "pure .aot bytes should throw TypeError, got: " << v;
    host_destroy(h);
}

// Streaming shims must forward the options arg to compile/instantiate, so the
// {aot} fallback works there too.
TEST(wasm_aot, streaming_forwards_options_and_falls_back) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h, (kFixtures +
        "\nvar _r = null;\n"
        "WebAssembly.instantiateStreaming(_src, undefined, {aot: _badAot})\n"
        "  .then(function(res){ _r = res.instance.exports.add(8, 9); })\n"
        "  .catch(function(e){ _r = 'ERR:' + e.message; });\n"
        "0").c_str(), &out));

    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "String(_r)", "17", &v))
        << "instantiateStreaming aot fallback did not produce add(8,9)==17, got: " << v;
    host_destroy(h);

    h = host_create();
    ASSERT_NE(nullptr, h);
    ASSERT_TRUE(host_eval(h, (kFixtures +
        "\nvar _r = null;\n"
        "WebAssembly.compileStreaming(_src, {aot: _badAot})\n"
        "  .then(function(mod){ return new WebAssembly.Instance(mod); })\n"
        "  .then(function(inst){ _r = inst.exports.add(1, 1); })\n"
        "  .catch(function(e){ _r = 'ERR:' + e.message; });\n"
        "0").c_str(), &out));
    ASSERT_TRUE(host_poll_until_value(h, "String(_r)", "2", &v))
        << "compileStreaming aot fallback did not produce add(1,1)==2, got: " << v;
    host_destroy(h);
}

// instantiate(module, imports, {aot}) — options.aot is meaningless for an
// already-compiled module; it must be ignored (the given module is used) and
// the module-arg form still resolves to the Instance.
TEST(wasm_aot, module_arg_instantiate_ignores_aot_option) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h, (kFixtures +
        "\nvar _r = null;\n"
        "WebAssembly.compile(_wasmBytes)\n"
        "  .then(function(mod){ return WebAssembly.instantiate(mod, undefined, {aot: _badAot}); })\n"
        "  .then(function(inst){ _r = inst.exports.add(6, 7); })\n"
        "  .catch(function(e){ _r = 'ERR:' + e.message; });\n"
        "0").c_str(), &out));

    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "String(_r)", "13", &v))
        << "module-arg instantiate with aot option did not use the module, got: " << v;
    host_destroy(h);
}

// No options at all — existing behavior must be unchanged (regression guard).
TEST(wasm_aot, no_options_unaffected) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h, (kFixtures +
        "\nvar _r = null;\n"
        "WebAssembly.instantiate(_wasmBytes)\n"
        "  .then(function(res){ _r = res.instance.exports.add(5, 6); })\n"
        "  .catch(function(e){ _r = 'ERR:' + e.message; });\n"
        "0").c_str(), &out));

    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "String(_r)", "11", &v))
        << "no-options instantiate regressed, got: " << v;
    host_destroy(h);
}

// Export-side i64 bridge: arguments must round-trip as BigInt and results
// must come back as BigInt (not Number). A Number return truncates to f64
// and destroys NaN-box handles above 2^31.
TEST(wasm_aot, export_i64_bigint_roundtrip) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h, (kFixtures +
        "\nvar _r = null;\n"
        "WebAssembly.instantiate(_i64Bytes).then(function(res){\n"
        "  var e = res.instance.exports;\n"
        "  _r = [typeof e.id64(7n), String(e.add64(5n, 9n)), String(e.hi())].join('|');\n"
        "}).catch(function(e){ _r = 'ERR:' + e.message; });\n"
        "0").c_str(), &out));

    // hi() = 0x7FF9000000000001 = 9221401712017801217.
    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "String(_r)",
        "bigint|14|9221401712017801217", &v))
        << "i64 export bridge wrong (expected bigint args + bigint result), got: " << v;
    host_destroy(h);
}

// SHRUNK_MEMORY regression: exporting (memory 32) with no memory.size must
// still expose a buffer covering 32 pages (32 * 64 KiB = 2097152). Before the
// page-size fix the shim used num_pages * 65536 against WAMR's folded page
// size, exposing only 64 KiB — writes past that silently no-op.
TEST(wasm_aot, shrunk_memory_export_length) {
    HostCtx *h = host_create();
    ASSERT_NE(nullptr, h);

    std::string out;
    ASSERT_TRUE(host_eval(h, (kFixtures +
        "\nvar _r = null;\n"
        "WebAssembly.instantiate(_shrinkBytes).then(function(res){\n"
        "  var mem = res.instance.exports.memory;\n"
        "  var n = mem.buffer.byteLength;\n"
        "  mem.__probe = new Uint8Array(mem.buffer);\n"
        "  _r = (n >= 2097152 && mem.__probe.length === n) ? 'ok' : ('bad:' + n);\n"
        "}).catch(function(e){ _r = 'ERR:' + e.message; });\n"
        "0").c_str(), &out));

    std::string v;
    ASSERT_TRUE(host_poll_until_value(h, "String(_r)", "ok", &v))
        << "shrunk-memory export exposed a short buffer, got: " << v;
    host_destroy(h);
}
