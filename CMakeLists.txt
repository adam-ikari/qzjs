cmake_minimum_required(VERSION 3.10)
project(qzjs
    VERSION 0.2.0
    DESCRIPTION "Embeddable QuickJS-ng runtime wrapper (libuv-native)"
    HOMEPAGE_URL "https://github.com/adam-ikari/qzjs"
    LANGUAGES C CXX
)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)   # pure -std=c99, no GNU extensions (deps use their own)

# ============================================================================
# Options
# ============================================================================
# Build profile — preset bundles of the QZ_WITH_* feature toggles.
# Every named profile satisfies the full ECMA-429 WinterTC mandatory set:
# "standard" is all-ON; "minimal" still satisfies ECMA-429 (only TLS is cut).
# Empty (default) = no preset: the options below behave exactly as before.
# Explicit -DQZ_WITH_X=... always wins over the profile preset.
# ============================================================================
set(QZ_PROFILE "" CACHE STRING
    "Build profile: minimal | standard (empty = individual QZ_WITH_* options)")
string(TOLOWER "${QZ_PROFILE}" _qz_profile)
if(_qz_profile AND NOT _qz_profile MATCHES "^(minimal|standard)$")
    message(FATAL_ERROR "QZ_PROFILE must be minimal|standard or empty (got '${QZ_PROFILE}')")
endif()
# Profile preset defaults, resolved BEFORE option() so an explicit
# -DQZ_WITH_X on the command line is already in the cache and wins.
if(_qz_profile STREQUAL "minimal" OR _qz_profile STREQUAL "standard")
    set(_prof_wamr ON)
    set(_prof_tls ON)
    set(_prof_compress ON)
    set(_prof_crypto_ext ON)
    set(_prof_textcodec ON)
endif()
if(_qz_profile STREQUAL "minimal")
    set(_prof_tls OFF)   # only cut vs standard; ECMA-429 has no HTTPS requirement
endif()
if(NOT _qz_profile)
    # Empty profile: preserve the historical per-option defaults bit-for-bit.
    set(_prof_wamr ON)
    set(_prof_tls ON)
    set(_prof_compress ON)
    set(_prof_crypto_ext ON)
    set(_prof_textcodec ON)
endif()
option(QZ_WITH_GRPC "Embed gRPC/HTTP2 stack in polyfill bundle (~3.5k lines JS; needs polyfill rebuild toolchain)" OFF)
option(QZ_BUILD_TESTS "Build tests" OFF)
option(QZ_BUILD_DEBUGGER "Build the DAP step-debugger (applies the QuickJS-ng debugger patch; adds src/debugger.c + src/debugger_dap.c to libqzjs)" OFF)

option(QZ_WITH_WAMR "Link WAMR WASM engine (default; enables real WebAssembly via WAMR with Fast Interp + AOT)" "${_prof_wamr}")
option(QZ_WITH_WASM3 "Link wasm3 WASM engine (alternative, more portable)" "${_prof_wasm3}")
option(QZ_WITH_TLS "Build with mbedTLS for HTTPS support" "${_prof_tls}")
option(QZ_WITH_COMPRESS "Enable native compression via miniz" "${_prof_compress}")
# 关闭 QZ_WITH_CRYPTO_EXT / QZ_WITH_TEXTCODEC 时，polyfill 无 JS 回退实现：
# btoa/atob 抛 TypeError，HTTP serve 的 WebSocket 握手（Sec-WebSocket-Accept）抛
# Error——CI 全 OFF 矩阵据此断言缺失路径，见 Test/test_polyfill_gtest.cpp。
option(QZ_WITH_CRYPTO_EXT "Enable native crypto.subtle via mbedTLS" "${_prof_crypto_ext}")
option(QZ_WITH_TEXTCODEC "Enable native UTF-8/Base64 encoding" "${_prof_textcodec}")
option(QZ_WITH_NONUTF_ENCODINGS "Enable non-UTF encoding labels (Latin-1, replacement) in TextDecoder" OFF)
option(QZ_BUILD_EXAMPLES "Build example programs" OFF)
# 声明在选项区而非文件尾：add_subdirectory(test) 在 CLI target 定义之前执行，
# 测试侧要用 if(QZ_BUILD_CLI) 门控注册 —— 选项若留在文件尾，首次 configure
# 读到的是未定义变量，测试会被静默漏注册（且只有二次 configure 才补上）。
option(QZ_BUILD_CLI "Build the qzjs CLI" ON)

# 应用模型（多进程模型 §2.1，M-P2）：ISOLATED = 宿主与主RT 各跑独立进程（缺省，
# 目标形态）；THREAD = 单进程多线程（回退档）。宏 QZ_PROCESS_MODEL_ISOLATED 是
# 源码 #if 选择的唯一依据。翻转历史：P1-P3 期间缺省 THREAD（增量提交期基线不被
# 未就绪路径污染），P4 端到端两进程 e2e + 双后端 parity 全绿后翻为 ISOLATED。
set(QZ_PROCESS_MODEL "ISOLATED" CACHE STRING
    "Application model: ISOLATED (host and main RT in separate processes) | THREAD (single process, one thread per runtime)")
set_property(CACHE QZ_PROCESS_MODEL PROPERTY STRINGS ISOLATED THREAD)
if(NOT QZ_PROCESS_MODEL STREQUAL "ISOLATED" AND NOT QZ_PROCESS_MODEL STREQUAL "THREAD")
    message(FATAL_ERROR "QZ_PROCESS_MODEL must be ISOLATED or THREAD (got '${QZ_PROCESS_MODEL}')")
endif()

set(QZ_POLYFILL_MODE "rodata" CACHE STRING
    "Polyfill bytecode embedding: rodata=const .rodata array (default) | compressed=lz4-compressed .rodata, decompressed to heap at load | external=external .polyfill file (QZ_POLYFILL_FILE), loader rejects any file whose SHA-256 != the hash embedded at build time | host=host hook qz_polyfill_load_custom()")

# Normalise: accept legacy single letters (C/A/B/D) and any case.
string(TOLOWER "${QZ_POLYFILL_MODE}" _polyfill_mode)
if(_polyfill_mode STREQUAL "c")
    set(_polyfill_mode rodata)
elseif(_polyfill_mode STREQUAL "a")
    set(_polyfill_mode compressed)
elseif(_polyfill_mode STREQUAL "b")
    set(_polyfill_mode external)
elseif(_polyfill_mode STREQUAL "d")
    set(_polyfill_mode host)
endif()

if(NOT _polyfill_mode MATCHES "^(rodata|compressed|external|host)$")
    message(FATAL_ERROR "QZ_POLYFILL_MODE must be rodata|compressed|external|host (got '${QZ_POLYFILL_MODE}')")
endif()
set(QZ_POLYFILL_MODE "${_polyfill_mode}")

# Generated polyfill C file per mode (polyfill/build.js uses the same mapping).
# rodata lands in the tracked baseline src/polyfill_default.c so a fresh clone
# without the polyfill toolchain still compiles; every other mode lands in
# untracked src/polyfill_<mode>.c, so switching modes can neither overwrite the
# baseline nor leave a stale object file carrying the previous mode's symbols.
if(_polyfill_mode STREQUAL "rodata")
    set(_polyfill_gen_c "src/polyfill_default.c")
else()
    set(_polyfill_gen_c "src/polyfill_${_polyfill_mode}.c")
endif()

# sanitizer 构建检测（ASan/UBSan/TSan）：CMAKE_C_FLAGS 显式注入
# -fsanitize=* 的配置视为 sanitizer 档。注入 QZ_SANITIZE_BUILD，供
# qzjs.c 等提升 JS 栈预算（sanitizer 帧放大易误报 QuickJS stack overflow）。
if(CMAKE_C_FLAGS MATCHES "-fsanitize=" OR CMAKE_C_FLAGS_DEBUG MATCHES "-fsanitize=")
    add_compile_definitions(QZ_SANITIZE_BUILD=1)
    message(STATUS "Sanitizer build detected — QZ_SANITIZE_BUILD=1")
    # clang 的 -fsanitize=function 对 quickjs-ng 的函数指针类型混用
    # （js_realloc 经 DynBuf realloc_func 的 size_t 声明链路）系统性误报
    # （UrlSearchParams 等路径实测触发）——编译期豁免该单项，其余 undefined
    # 检查保留。gcc 无 function sanitizer，无副作用。
    if(CMAKE_C_COMPILER_ID MATCHES "Clang")
        add_compile_options(-fno-sanitize=function)
    endif()
endif()
# Map mode name to integer for the compile-time define
if(QZ_POLYFILL_MODE STREQUAL "rodata")
    set(_qz_polyfill_mode_num 0)
elseif(QZ_POLYFILL_MODE STREQUAL "compressed")
    set(_qz_polyfill_mode_num 1)
elseif(QZ_POLYFILL_MODE STREQUAL "external")
    set(_qz_polyfill_mode_num 2)
elseif(QZ_POLYFILL_MODE STREQUAL "host")
    set(_qz_polyfill_mode_num 3)
endif()

# compressed mode requires the vendored lz4 (decoder + build-time compressor)
if(QZ_POLYFILL_MODE STREQUAL "compressed" AND NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/deps/lz4/lib/lz4.c")
    message(FATAL_ERROR "QZ_POLYFILL_MODE=compressed requires vendored lz4 (deps/lz4/lib/lz4.c missing — run: git submodule update --init deps/lz4)")
endif()

if(QZ_POLYFILL_MODE STREQUAL "external")
    message(STATUS "Polyfill mode external: bytecode loaded from external .polyfill file (QZ_POLYFILL_FILE); SHA-256 anchored at build time (see the generated src/polyfill_external.c)")
endif()

# WAMR and wasm3 are mutually exclusive (both register the WebAssembly global)
if(QZ_WITH_WAMR AND QZ_WITH_WASM3)
    message(FATAL_ERROR
        "QZ_WITH_WAMR=ON and QZ_WITH_WASM3=ON are mutually exclusive. "
        "Enable only one:\n"
        "  wamr  (default): -DQZ_WITH_WAMR=ON\n"
        "  wasm3:            -DQZ_WITH_WASM3=ON -DQZ_WITH_WAMR=OFF")
endif()

# TLS requires the crypto extension: both use mbedTLS, and a TLS client
# without crypto.subtle (no cert hashing, no WebCrypto key derivation) is not
# a complete WinterCG runtime. So QZ_WITH_TLS=ON forces
# QZ_WITH_CRYPTO_EXT=ON. (The reverse is allowed: crypto-ext without TLS.)
if(QZ_WITH_TLS AND NOT QZ_WITH_CRYPTO_EXT)
    message(STATUS "QZ_WITH_TLS=ON forces QZ_WITH_CRYPTO_EXT=ON (TLS requires crypto)")
    set(QZ_WITH_CRYPTO_EXT ON CACHE BOOL "Enable native crypto.subtle via mbedTLS" FORCE)
endif()
# ----------------------------------------------------------------------------
# Profile switch detection — re-running configure in the same build dir with a
# different QZ_PROFILE. option() only populates the cache on the FIRST
# configure, so stale QZ_WITH_* values would silently win. Recalculate the
# per-profile defaults into the cache. QZ_WITH_WASM3 is never a profile
# default (OFF in every preset). NOTE: explicit -DQZ_WITH_X values do NOT
# survive a profile switch — use a fresh build dir when mixing.
# ----------------------------------------------------------------------------
if(NOT QZ_PROFILE_LAST STREQUAL _qz_profile)
    message(STATUS "QZ_PROFILE changed: '${QZ_PROFILE_LAST}' -> '${_qz_profile}' — recalculating QZ_WITH_* cache defaults")
    if(_qz_profile STREQUAL "minimal")
        # minimal：WebAssembly 默认关闭（更小）；需 WASM 时 -DQZ_WITH_WAMR=ON
        set(QZ_WITH_WAMR       OFF CACHE BOOL "" FORCE)
        set(QZ_WITH_TLS        OFF CACHE BOOL "" FORCE)
        set(QZ_WITH_COMPRESS   ON  CACHE BOOL "" FORCE)
        set(QZ_WITH_CRYPTO_EXT ON  CACHE BOOL "" FORCE)
        set(QZ_WITH_TEXTCODEC  ON  CACHE BOOL "" FORCE)
    else() # standard and empty: historical all-ON defaults
        set(QZ_WITH_WAMR       ON  CACHE BOOL "" FORCE)
        set(QZ_WITH_TLS        ON  CACHE BOOL "" FORCE)
        set(QZ_WITH_COMPRESS   ON  CACHE BOOL "" FORCE)
        set(QZ_WITH_CRYPTO_EXT ON  CACHE BOOL "" FORCE)
        set(QZ_WITH_TEXTCODEC  ON  CACHE BOOL "" FORCE)
    endif()
    set(QZ_WITH_WASM3 OFF CACHE BOOL "" FORCE)
    # Keep the TLS→crypto-ext invariant across a switch (the check above ran
    # against the pre-switch cache).
    if(QZ_WITH_TLS AND NOT QZ_WITH_CRYPTO_EXT)
        set(QZ_WITH_CRYPTO_EXT ON CACHE BOOL "" FORCE)
    endif()
    set(QZ_PROFILE_LAST "${_qz_profile}" CACHE STRING "" FORCE)
endif()


if(QZ_WITH_TLS)
    set(MBEDTLS_SRC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/mbedtls")
    set(MBEDTLS_INCLUDE_DIR "${MBEDTLS_SRC_DIR}/include")

    if(EXISTS "${MBEDTLS_SRC_DIR}/CMakeLists.txt")
        # mbedTLS via add_subdirectory. Its CMake already sets CMAKE_C_STANDARD
        # 99 + CMAKE_C_EXTENSIONS OFF (matching qzjs), so no isolation needed.
        # Disable programs/tests/shared; link the *_static targets.
        set(ENABLE_PROGRAMS               OFF CACHE BOOL "" FORCE)
        set(ENABLE_TESTING                OFF CACHE BOOL "" FORCE)
        set(USE_SHARED_MBEDTLS_LIBRARY    OFF CACHE BOOL "" FORCE)
        set(MBEDTLS_FATAL_WARNINGS        OFF CACHE BOOL "" FORCE)

        # Force PIC so the static mbedcrypto/mbedtls/mbedx509 archives can be
        # linked into a shared library (e.g. ace-core's libace_node.so).
        # CMAKE_POSITION_INDEPENDENT_CODE is a directory property that only
        # applies to targets created *after* it is set, so it must precede
        # the add_subdirectory call below.
        set(CMAKE_POSITION_INDEPENDENT_CODE ON)
        add_subdirectory(${MBEDTLS_SRC_DIR} ${CMAKE_BINARY_DIR}/deps/mbedtls EXCLUDE_FROM_ALL)

        # Static targets — names are mbedtls/mbedx509/mbedcrypto (the _static
        # suffix is only added when BOTH static and shared are built).
        set(MBEDTLS_LIB   mbedtls)
        set(MBEDX509_LIB  mbedx509)
        set(MBEDCRYPTO_LIB mbedcrypto)
        set(MBEDCRYPTO_INCLUDE_DIR "${MBEDTLS_INCLUDE_DIR}")
        set(MBEDTLS_FOUND TRUE)

        message(STATUS "TLS support enabled (mbedTLS, source-built via add_subdirectory)")
    else()
        set(MBEDTLS_FOUND FALSE)
        message(FATAL_ERROR "QZ_WITH_TLS=ON but mbedTLS source not found. "
            "Run: git submodule update --init deps/mbedtls")
    endif()
endif()

# ============================================================================
# miniz dependency (compression extension)
# ============================================================================
if(QZ_WITH_COMPRESS)
    set(MINIZ_SRC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/miniz")
    # Set PIC globally so miniz (added via add_subdirectory) compiles with -fPIC,
    # needed when linked into a shared library.
    set(CMAKE_POSITION_INDEPENDENT_CODE ON)
    add_subdirectory(${MINIZ_SRC_DIR} ${CMAKE_BINARY_DIR}/deps/miniz)

    message(STATUS "Compression support enabled (miniz)")
endif()

# ============================================================================
# lz4 dependency (polyfill bytecode compression mode)
# ============================================================================
set(LZ4_SRC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/lz4/lib" CACHE PATH "lz4 lib dir")
if(EXISTS "${LZ4_SRC_DIR}/lz4.c")
    set(CMAKE_POSITION_INDEPENDENT_CODE ON)
    add_library(lz4_static STATIC
        "${LZ4_SRC_DIR}/lz4.c"
        "${LZ4_SRC_DIR}/lz4hc.c")
    target_include_directories(lz4_static PUBLIC "${LZ4_SRC_DIR}")
    # lz4.h warns about unused Kxx constants at -Wall -Wextra -Werror paths
    target_compile_options(lz4_static PRIVATE -w)
    # 压缩器 CLI（构建期工具，供 polyfill/build.js 调用；不进安装面）
    add_executable(qz_lz4_compress EXCLUDE_FROM_ALL "${LZ4_SRC_DIR}/lz4.c" cmake/lz4_compress_main.c)
    target_include_directories(qz_lz4_compress PRIVATE "${LZ4_SRC_DIR}")
    message(STATUS "lz4 vendored (${LZ4_SRC_DIR}) — polyfill compressed mode + build tool")
else()
    message(STATUS "lz4 not vendored (deps/lz4/lib/lz4.c missing) — polyfill compressed mode unavailable")
endif()

# ============================================================================
# cJSON dependency (C-layer JSON: control plane field extraction, IPC
# handshake parsing, DAP message parse/serialize)
# ============================================================================
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
add_library(cjson STATIC deps/cjson/cJSON.c)
target_include_directories(cjson PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/deps/cjson")
target_compile_options(cjson PRIVATE -w)
message(STATUS "cJSON vendored (deps/cjson, v1.7.19) — C-layer JSON")

# ============================================================================
# Crypto extension (mbedTLS for native crypto.subtle)
#
# Reuses the mbedTLS source build from the QZ_WITH_TLS block above. If TLS
# is OFF but crypto-ext is ON, build just libmbedcrypto from the same source.
# ============================================================================
if(QZ_WITH_CRYPTO_EXT)
    # crypto-ext needs mbedcrypto. If QZ_WITH_TLS is ON, the TLS block above
    # already added mbedtls via add_subdirectory and set MBEDCRYPTO_LIB to the
    # mbedcrypto_static target. Otherwise add the subdir here for crypto-only.
    if(NOT QZ_WITH_TLS)
        set(MBEDTLS_SRC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/mbedtls")
        set(MBEDCRYPTO_INCLUDE_DIR "${MBEDTLS_SRC_DIR}/include")

        if(EXISTS "${MBEDTLS_SRC_DIR}/CMakeLists.txt")
            set(ENABLE_PROGRAMS            OFF CACHE BOOL "" FORCE)
            set(ENABLE_TESTING             OFF CACHE BOOL "" FORCE)
            set(USE_SHARED_MBEDTLS_LIBRARY OFF CACHE BOOL "" FORCE)
            set(MBEDTLS_FATAL_WARNINGS     OFF CACHE BOOL "" FORCE)

            # Force PIC (same reason as the TLS block above).
            set(CMAKE_POSITION_INDEPENDENT_CODE ON)
            add_subdirectory(${MBEDTLS_SRC_DIR} ${CMAKE_BINARY_DIR}/deps/mbedtls EXCLUDE_FROM_ALL)
            set(MBEDCRYPTO_LIB mbedcrypto)
        else()
            message(FATAL_ERROR "QZ_WITH_CRYPTO_EXT=ON but mbedTLS source not found. "
                "Run: git submodule update --init deps/mbedtls")
        endif()
    endif()

    message(STATUS "Crypto extension enabled (mbedTLS, source-built)")
endif()

# ============================================================================
# QuickJS-NG dependency — built from source via add_subdirectory (not a system
# lib). quickjs-ng's CMake mutates global CMAKE_C_STANDARD (→11) / CMAKE_BUILD_TYPE
# and adds install rules, so we save+restore those around the add_subdirectory
# and disable its install/programs/tests/CLI to keep qzjs's build clean.
# ============================================================================
set(QUICKJS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/quickjs-ng")

set(_qz_saved_c_standard       ${CMAKE_C_STANDARD})
set(_qz_saved_c_extensions     ${CMAKE_C_EXTENSIONS})
set(_qz_saved_c_visibility     ${CMAKE_C_VISIBILITY_PRESET})
set(_qz_saved_build_type       ${CMAKE_BUILD_TYPE})

set(QJS_ENABLE_INSTALL       OFF CACHE BOOL "" FORCE)
set(QJS_BUILD_EXAMPLES       OFF CACHE BOOL "" FORCE)
set(QJS_BUILD_CLI_STATIC     OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS        OFF CACHE BOOL "" FORCE)

# ── QuickJS-ng C99 atomics patch ──────────────────────────────────────────
# quickjs-ng uses C11 <stdatomic.h> (_Atomic) for its atomics. Its own
# quickjs-c-atomics.h already has a GCC_BUILTIN_ATOMICS path that maps the
# atomic_* ops to GCC/Clang __atomic_* builtins and #defines _Atomic to empty
# — i.e. no C11 needed. The path is only taken on old GCC; this patch forces
# it on for all GCC/Clang, so quickjs-ng compiles under -std=c99 (qzjs's
# standard). Applied unconditionally (working-tree-only; submodule stays clean).
set(QZ_QUICKJS_C99_PATCH "${CMAKE_CURRENT_SOURCE_DIR}/deps/quickjs-ng-c99-atomics.patch")
if(EXISTS "${QZ_QUICKJS_C99_PATCH}")
    execute_process(
        COMMAND patch -p1 --dry-run -f -i "${QZ_QUICKJS_C99_PATCH}"
        WORKING_DIRECTORY "${QUICKJS_DIR}"
        RESULT_VARIABLE _c99_patch_dry
        OUTPUT_QUIET ERROR_QUIET)
    if(_c99_patch_dry EQUAL 0)
        execute_process(
            COMMAND patch -p1 -f -i "${QZ_QUICKJS_C99_PATCH}"
            WORKING_DIRECTORY "${QUICKJS_DIR}"
            RESULT_VARIABLE _c99_patch_apply ERROR_QUIET)
        if(NOT _c99_patch_apply EQUAL 0)
            message(FATAL_ERROR "Failed to apply quickjs-ng C99 atomics patch")
        endif()
        message(STATUS "Applied quickjs-ng C99 atomics patch (deps/quickjs-ng-c99-atomics.patch)")
    else()
        # Already applied (e.g. reconfigure) — verify the patched symbol is present.
        execute_process(
            COMMAND grep -c "qwrt: force GCC/Clang __atomic"
                    "${QUICKJS_DIR}/quickjs-c-atomics.h"
            OUTPUT_QUIET ERROR_QUIET RESULT_VARIABLE _c99_grep_rc)
        if(NOT _c99_grep_rc EQUAL 0)
            message(FATAL_ERROR
                "quickjs-ng C99 atomics patch does not apply cleanly and is not "
                "already applied. Regenerate deps/quickjs-ng-c99-atomics.patch.")
        endif()
    endif()
endif()

# ── QuickJS-ng per-ctx job drain patch ────────────────────────────────────
# Adds JS_DrainPendingJobsForContext(): qz_ctx_destroy needs to remove a
# freed context's pending jobs from rt->job_list before JS_FreeContext, or
# the next JS_ExecutePendingJob dereferences a dangling ctx pointer (UAF).
# Applied unconditionally (working-tree-only; submodule stays clean).
set(QZ_QUICKJS_DRAIN_PATCH "${CMAKE_CURRENT_SOURCE_DIR}/deps/quickjs-ng-drain-jobs.patch")
if(EXISTS "${QZ_QUICKJS_DRAIN_PATCH}")
    execute_process(
        COMMAND patch -p1 --dry-run -f -i "${QZ_QUICKJS_DRAIN_PATCH}"
        WORKING_DIRECTORY "${QUICKJS_DIR}"
        RESULT_VARIABLE _drain_patch_dry
        OUTPUT_QUIET ERROR_QUIET)
    if(_drain_patch_dry EQUAL 0)
        execute_process(
            COMMAND patch -p1 -f -i "${QZ_QUICKJS_DRAIN_PATCH}"
            WORKING_DIRECTORY "${QUICKJS_DIR}"
            RESULT_VARIABLE _drain_patch_apply ERROR_QUIET)
        if(NOT _drain_patch_apply EQUAL 0)
            message(FATAL_ERROR "Failed to apply quickjs-ng drain-jobs patch")
        endif()
        message(STATUS "Applied quickjs-ng drain-jobs patch (deps/quickjs-ng-drain-jobs.patch)")
    else()
        # Already applied (e.g. reconfigure) — verify the patched symbol is present.
        execute_process(
            COMMAND grep -c "JS_DrainPendingJobsForContext"
                    "${QUICKJS_DIR}/quickjs.h"
            OUTPUT_QUIET ERROR_QUIET RESULT_VARIABLE _drain_patch_check)
        if(NOT _drain_patch_check EQUAL 0)
            message(FATAL_ERROR
                "quickjs-ng drain-jobs patch does not apply cleanly and is not "
                "already applied. Regenerate deps/quickjs-ng-drain-jobs.patch.")
        endif()
    endif()
endif()

# ── QuickJS-ng bytecode reader hardening ──────────────────────────────────
# The bytecode deserializer (JS_ReadObject with JS_READ_OBJ_BYTECODE) is the
# loader path for bytes that do not come from the trusted build (embedded
# polyfill, worker boot shims) and is the fuzz-smoke target. The vendored
# reader trusted stream-supplied counts/opcodes: out-of-range opcode →
# short_opcode_info() global-buffer-overflow; unbounded cpool/var/module/
# pc2line/source lengths → multi-GB allocations (OOM); req_module_entries_
# count exceeding the allocated array → failure-path free walked garbage
# atoms (SEGV). Hardens all of it; upstream master is identical (unfixed).
# Applied unconditionally (working-tree-only; submodule stays clean).
set(QZ_QUICKJS_BCH_PATCH "${CMAKE_CURRENT_SOURCE_DIR}/deps/quickjs-ng-bc-reader-hardening.patch")
if(EXISTS "${QZ_QUICKJS_BCH_PATCH}")
    execute_process(
        COMMAND patch -p1 --dry-run -f -i "${QZ_QUICKJS_BCH_PATCH}"
        WORKING_DIRECTORY "${QUICKJS_DIR}"
        RESULT_VARIABLE _bch_patch_dry
        OUTPUT_QUIET ERROR_QUIET)
    if(_bch_patch_dry EQUAL 0)
        execute_process(
            COMMAND patch -p1 -f -i "${QZ_QUICKJS_BCH_PATCH}"
            WORKING_DIRECTORY "${QUICKJS_DIR}"
            RESULT_VARIABLE _bch_patch_apply)
        if(NOT _bch_patch_apply EQUAL 0)
            message(FATAL_ERROR "Failed to apply quickjs-ng bytecode reader hardening patch")
        endif()
        message(STATUS "Applied quickjs-ng bytecode reader hardening patch (deps/quickjs-ng-bc-reader-hardening.patch)")
    else()
        # Already applied (e.g. reconfigure) — verify a guard is present.
        execute_process(
            COMMAND grep -c "invalid opcode (pos="
                    "${QUICKJS_DIR}/quickjs.c"
            OUTPUT_QUIET ERROR_QUIET RESULT_VARIABLE _bch_patch_check)
        if(NOT _bch_patch_check EQUAL 0)
            message(FATAL_ERROR
                "quickjs-ng bytecode reader hardening patch does not apply cleanly and is not "
                "already applied. Regenerate deps/quickjs-ng-bc-reader-hardening.patch.")
        endif()
        message(STATUS "quickjs-ng bytecode reader hardening patch already applied")
    endif()
endif()

# ── QuickJS-ng debugger patch ──────────────────────────────────────────────
# When QZ_BUILD_DEBUGGER is ON, apply deps/quickjs-ng-debugger.patch to the
# quickjs-ng submodule working tree BEFORE add_subdirectory so the patched
# sources compile. The patch is the source of truth; the submodule stays clean
# in git (working-tree-only modification). Patch failure = FATAL_ERROR with a
# regenerate hint. QZ_DEBUG_SUPPORT is defined on the qjs target below.
if(QZ_BUILD_DEBUGGER)
    set(QZ_QUICKJS_PATCH "${CMAKE_CURRENT_SOURCE_DIR}/deps/quickjs-ng-debugger.patch")
    if(NOT EXISTS "${QZ_QUICKJS_PATCH}")
        message(FATAL_ERROR "QZ_BUILD_DEBUGGER=ON but deps/quickjs-ng-debugger.patch is missing")
    endif()
    execute_process(
        COMMAND patch -p1 --dry-run -f -i "${QZ_QUICKJS_PATCH}"
        WORKING_DIRECTORY "${QUICKJS_DIR}"
        RESULT_VARIABLE _patch_dry
        OUTPUT_VARIABLE _patch_out
        ERROR_VARIABLE _patch_err)
    if(_patch_dry EQUAL 0)
        execute_process(
            COMMAND patch -p1 -f -i "${QZ_QUICKJS_PATCH}"
            WORKING_DIRECTORY "${QUICKJS_DIR}"
            RESULT_VARIABLE _patch_apply)
        if(NOT _patch_apply EQUAL 0)
            message(FATAL_ERROR "Failed to apply quickjs-ng debugger patch:\n${_patch_err}")
        endif()
        message(STATUS "Applied quickjs-ng debugger patch (deps/quickjs-ng-debugger.patch)")
    else()
        # dry-run failed: either already applied, or genuinely won't apply.
        # Distinguish by checking if the patched symbols already exist.
        execute_process(
            COMMAND grep -c "JS_SetDebuggerHandler"
                    "${QUICKJS_DIR}/quickjs.h"
            OUTPUT_VARIABLE _grep_out
            OUTPUT_STRIP_TRAILING_WHITESPACE
            RESULT_VARIABLE _grep_rc)
        if(_grep_rc EQUAL 0 AND _grep_out GREATER 0)
            message(STATUS "quickjs-ng debugger patch already applied")
        else()
            message(FATAL_ERROR
                "quickjs-ng debugger patch does not apply cleanly:\n${_patch_err}\n"
                "Regenerate deps/quickjs-ng-debugger.patch against the current "
                "deps/quickjs-ng revision.")
        endif()
    endif()
    set(QZ_DEBUG_SUPPORT_DEFINE QZ_DEBUG_SUPPORT)
endif()

add_subdirectory(${QUICKJS_DIR} ${CMAKE_BINARY_DIR}/deps/quickjs-ng EXCLUDE_FROM_ALL)

# test262 runner：quickjs-ng 子目录 EXCLUDE_FROM_ALL → 全量 build 默认不产出
# run-test262（ctest test262_quickjs 会 "Not Run"）。测试开启时显式挂 ALL 依赖，
# CI/本地默认构建即包含 runner。
if(QZ_BUILD_TESTS AND TARGET run-test262)
  add_custom_target(qz_test262_runner ALL DEPENDS run-test262)
endif()

# Expose QZ_DEBUG_SUPPORT on the qjs target so the engine's DEBUGGER_CHECK
# dispatch hook compiles in (it's a no-op when the macro is undefined).
if(QZ_BUILD_DEBUGGER AND TARGET qjs)
    target_compile_definitions(qjs PUBLIC ${QZ_DEBUG_SUPPORT_DEFINE})
endif()

set(CMAKE_C_STANDARD         ${_qz_saved_c_standard})
set(CMAKE_C_EXTENSIONS       ${_qz_saved_c_extensions})
set(CMAKE_C_VISIBILITY_PRESET ${_qz_saved_c_visibility})
set(CMAKE_BUILD_TYPE         ${_qz_saved_build_type})

# qjs is the static lib target quickjs-ng produces (libqjs.a).
if(NOT TARGET qjs)
    message(FATAL_ERROR "quickjs-ng add_subdirectory did not define target 'qjs'")
endif()

# Force qjs to compile under C99, not C11. quickjs-ng's CMake sets
# CMAKE_C_STANDARD=11, but with the C99-atomics patch applied (GCC_BUILTIN_ATOMICS,
# no <stdatomic.h>), its sources need no C11. Target-level C_STANDARD overrides
# the subdir's global setting.
set_target_properties(qjs PROPERTIES C_STANDARD 99 C_EXTENSIONS OFF)

# qjsc — quickjs-ng's bytecode compiler (target qjsc). EXCLUDE_FROM_ALL means it
# isn't built by default; pull it in only when something needs JS→bytecode.
# qz_compile_js(<out_var> <input.js>) compiles a JS source to a QuickJS
# bytecode file (qjsc -C -b) at configure time, returning the output path. The
# generated .bc is added to a custom target so it rebuilds when the JS changes.
function(qz_compile_js out_var js_file)
    cmake_parse_arguments(ARG "" "TARGET" "" ${ARGN})
    if(NOT TARGET qjsc)
        message(FATAL_ERROR "qz_compile_js needs the 'qjsc' target (quickjs-ng)")
    endif()
    get_filename_component(_js_abs "${js_file}" ABSOLUTE)
    set(_bc "${CMAKE_CURRENT_BINARY_DIR}/${ARG_TARGET}.bc")
    add_custom_command(
        OUTPUT  "${_bc}"
        COMMAND "$<TARGET_FILE:qjsc>" -C -b -o "${_bc}" "${_js_abs}"
        DEPENDS qjsc "${_js_abs}"
        COMMENT "Compiling JS→bytecode: ${js_file}"
        VERBATIM)
    if(ARG_TARGET)
        add_custom_target(${ARG_TARGET} DEPENDS "${_bc}")
    endif()
    set(${out_var} "${_bc}" PARENT_SCOPE)
endfunction()

# ============================================================================
# Polyfill rebuild — triggered when QZ_WITH_NONUTF_ENCODINGS changes.
# The polyfill is precompiled to bytecode via npm run build; this custom
# target regenerates it when the option is toggled.
# ============================================================================
if(QZ_WITH_NONUTF_ENCODINGS)
    message(STATUS "Non-UTF encoding support ENABLED (Latin-1, replacement)")
    set(_polyfill_env QZ_WITH_NONUTF_ENCODINGS=1)
else()
    set(_polyfill_env QZ_WITH_NONUTF_ENCODINGS=0)
endif()
find_program(NPM_EXECUTABLE npm)
if(NPM_EXECUTABLE AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/polyfill/node_modules/esbuild" AND EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/deps/quickjs-ng/qjsc.c")
    set(_polyfill_rebuild_enabled TRUE)
    # 源依赖：polyfill/src/** 变更必须触发 rebuild，否则旧字节码静默进产物
    file(GLOB_RECURSE QZ_POLYFILL_SRC "${CMAKE_SOURCE_DIR}/polyfill/src/*.js")
    # qjsc 必须由 CMake 决定：当前 build 目录自编译的 qjsc 与引擎版本
    # 必然一致（QJSC=$<TARGET_FILE:qjsc>）。否则 build.js 回落 fs 扫描，
    # readdir 顺序不确定，撞上残留旧版 qjsc（如 0.15.1 → BC_VERSION 26）
    # 会静默产出引擎拒读的字节码：JS_ReadObject: invalid version(26
    # expected=27) → qz_create 返回 NULL → host_create 测试全挂。
    #
    # 产物走 add_custom_command(OUTPUT)，不是 custom target 的隐式副作用：非
    # rodata 模式产物 untracked，fresh clone/CI 在 configure 期根本没有该文件，
    # 普通源文件列表会直接 "Cannot find source file"；OUTPUT 声明让构建系统既
    # 知道从哪里生成、又只在真缺文件时才触发。qjsc / qz_lz4_compress 直接进
    # DEPENDS（add_custom_command 里的跨目录目标依赖有效，见上面的
    # qz_compile_js），比 add_dependencies 更早锁住顺序，避免并行构建 race。
    set(_polyfill_rebuild_tools qjsc)
    if(TARGET qz_lz4_compress)   # compressed 产物压缩器（EXCLUDE_FROM_ALL）
        list(APPEND _polyfill_rebuild_tools qz_lz4_compress)
    endif()
    # 选项变化必须触发再生：custom target 永不过期，OUTPUT 规则只看依赖新旧。
    # 三个 env 选项编进 stamp 文件名（file(GENERATE) 在构建期落一个空文件），
    # 任一选项一变 stamp 名就变 → 依赖缺失 → 立即再生。
    set(_polyfill_stamp "${CMAKE_CURRENT_BINARY_DIR}/polyfill_${_polyfill_mode}_nonutf${QZ_WITH_NONUTF_ENCODINGS}_grpc${QZ_WITH_GRPC}.stamp")
    file(GENERATE OUTPUT "${_polyfill_stamp}" CONTENT "")
    add_custom_command(
        OUTPUT "${CMAKE_CURRENT_SOURCE_DIR}/${_polyfill_gen_c}"
               "${CMAKE_CURRENT_SOURCE_DIR}/src/worker_boot_default.c"
        COMMAND ${CMAKE_COMMAND} -E env ${_polyfill_env} QZ_WITH_GRPC=$<BOOL:${QZ_WITH_GRPC}> QZ_POLYFILL_MODE=${QZ_POLYFILL_MODE} QZ_LZ4_COMPRESS=${CMAKE_BINARY_DIR}/qz_lz4_compress QJSC=$<TARGET_FILE:qjsc> npm --prefix "${CMAKE_CURRENT_SOURCE_DIR}/polyfill" run build
        DEPENDS ${QZ_POLYFILL_SRC} ${_polyfill_rebuild_tools} "${_polyfill_stamp}"
        COMMENT "Rebuilding polyfill with QZ_WITH_NONUTF_ENCODINGS=${QZ_WITH_NONUTF_ENCODINGS} QZ_WITH_GRPC=${QZ_WITH_GRPC} QZ_POLYFILL_MODE=${QZ_POLYFILL_MODE}"
        VERBATIM
    )
    # Phony handle: `--target polyfill_rebuild` 仍可用，其他 target 也能对它排序。
    add_custom_target(polyfill_rebuild DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/${_polyfill_gen_c}"
        "${CMAKE_CURRENT_SOURCE_DIR}/src/worker_boot_default.c")
else()
    set(_polyfill_rebuild_enabled FALSE)
    # 非 rodata 模式没有 tracked 基线：工具链缺失且产物还没生成时直接配置失败，
    # 否则只会在编译期冒出一句看不出原因的 "Cannot find source file"。
    if(NOT _polyfill_mode STREQUAL "rodata"
       AND NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/${_polyfill_gen_c}")
        message(FATAL_ERROR
            "QZ_POLYFILL_MODE=${_polyfill_mode} needs the polyfill toolchain: "
            "${_polyfill_gen_c} is generated, untracked, and absent. "
            "Run `npm --prefix polyfill ci` (creates node_modules/esbuild), then re-configure.")
    endif()
    if(QZ_WITH_GRPC)
        message(WARNING "QZ_WITH_GRPC=ON but polyfill toolchain missing; gRPC stack will NOT be embedded")
    endif()
    add_custom_target(polyfill_rebuild
        COMMAND ${CMAKE_COMMAND} -E echo "polyfill_rebuild: skipped (esbuild/node_modules missing — using pre-generated ${_polyfill_gen_c})"
        VERBATIM
    )
    message(STATUS "Polyfill rebuild DISABLED — esbuild/node_modules not found; using pre-generated ${_polyfill_gen_c}. Run `npm --prefix polyfill ci` then re-configure to enable.")
endif()

# fuzz 语料种子：随字节码一起变成构建产物。内嵌的 polyfill / worker-boot
# 字节码是 qjsc 构建期生成的，且逐位不可复现（同源码两次构建可有数字节差异），
# 所以 committed 的「字节码前缀」种子永远无法稳定匹配某次构建的字节码——对齐门
# （test/fuzz_corpus_align_check.py）因此恒红。改为从构建产出的原始字节码
# （dist/*.bytecode，raw；compressed 模式下 C 数组是压缩的，故不用 C 数组）生成。
# 依赖 src/${_polyfill_gen_c}（polyfill 命令的 OUTPUT）保证顺序：build.js 先写
# dist 字节码再写 C 数组，该文件变新即触发本命令。工具链缺失时（else 分支）产物
# 是 committed 基线，命令仍能跑（只依赖已存在的 dist/*.bytecode）。
find_package(Python3 COMPONENTS Interpreter QUIET)
if(Python3_Interpreter_FOUND)
    add_custom_command(
        OUTPUT "${CMAKE_CURRENT_SOURCE_DIR}/test/fuzz-corpus/seed-polyfill-head4k.bc"
               "${CMAKE_CURRENT_SOURCE_DIR}/test/fuzz-corpus/seed-polyfill-head8k.bc"
               "${CMAKE_CURRENT_SOURCE_DIR}/test/fuzz-corpus/seed-polyfill-head64k.bc"
               "${CMAKE_CURRENT_SOURCE_DIR}/test/fuzz-corpus/seed-workerboot.bc"
        COMMAND ${Python3_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/test/gen_fuzz_seeds.py"
                "${CMAKE_CURRENT_SOURCE_DIR}/dist" "${CMAKE_CURRENT_SOURCE_DIR}/test/fuzz-corpus"
        DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/${_polyfill_gen_c}"
                "${CMAKE_CURRENT_SOURCE_DIR}/test/gen_fuzz_seeds.py"
        COMMENT "Generating fuzz corpus seeds from built bytecode"
        VERBATIM
    )
    add_custom_target(fuzz_seeds_gen DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/test/fuzz-corpus/seed-workerboot.bc")
else()
    message(WARNING "python3 not found — fuzz corpus seeds will not be regenerated at build time")
endif()

# ============================================================================
# WAMR dependency (default WASM engine) — built from source via add_subdirectory
# ============================================================================
# WAMR-2.4.5: Fast Interpreter + AOT. Target vmlib → libiwasm.a.
# C99-compatible out-of-the-box (no atomics patch needed — asm removed since
# 1.3.3, _Atomic only in WASI which qzjs doesn't build).
if(QZ_WITH_WAMR)
    set(WAMR_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/wamr")
    if(NOT EXISTS "${WAMR_DIR}/CMakeLists.txt")
        message(FATAL_ERROR "QZ_WITH_WAMR=ON but WAMR source not found. "
            "Run: git submodule update --init deps/wamr")
    endif()
    set(WAMR_BUILD_INTERP 1)
    set(WAMR_BUILD_AOT 1)
    set(WAMR_BUILD_JIT 0)
    # fast-jit/lazy-jit compile asmjit (C++) into libiwasm.a, forcing consumers
    # to link a C++ runtime. qzjs only needs the Fast Interpreter + AOT (both
    # pure C) — keep vmlib linkable by a plain C compiler.
    set(WAMR_BUILD_FAST_JIT 0)
    set(WAMR_BUILD_LAZY_JIT 0)
    set(WAMR_BUILD_FAST_INTERP 1)
    set(WAMR_BUILD_WASM_C_API 1)
    set(WAMR_BUILD_LIBC_BUILTIN 1)
    set(WAMR_BUILD_LIBC_WASI 0)
    # WAMR's Linux platform needs _GNU_SOURCE (pthread_rwlock_t). qzjs's
    # -std=c99 would hide it; inject for the subdirectory only.
    set(_qz_saved_c_flags ${CMAKE_C_FLAGS})
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -D_GNU_SOURCE")
    add_subdirectory(${WAMR_DIR} ${CMAKE_BINARY_DIR}/deps/wamr EXCLUDE_FROM_ALL)
    set(CMAKE_C_FLAGS ${_qz_saved_c_flags})
    # Relax warnings on vmlib (WAMR has some shadow/unused-parameter warnings)
    if(TARGET vmlib)
        target_compile_options(vmlib PRIVATE -Wno-error -Wno-unused-parameter -Wno-shadow)
    endif()
    # WAMR 编译代码流有意用 2/4 字节步长嵌 8 字节指针（x86 硬件支持未对齐，
    # WASM_CPU_SUPPORTS_UNALIGNED_ADDR_ACCESS=1 直接解引用）——UBSan alignment
    # 检查对其系统性误报（wasm_loader.c STORE_PTR）。仅豁免该检查，保留其余
    # sanitizer 覆盖；非 x86/arm 走 UNALIGNED=0 分支无此问题。
    if(TARGET vmlib AND CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(vmlib PRIVATE -fno-sanitize=alignment)
    endif()
    message(STATUS "WAMR enabled — building vmlib from source (fast interp + AOT)")
endif()

# ============================================================================
# wasm3 dependency (optional) — built from source via add_subdirectory
# ============================================================================
if(QZ_WITH_WASM3)
    set(WASM3_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/wasm3")
    set(WASM3_SRC_DIR "${WASM3_DIR}/source")
    if(EXISTS "${WASM3_SRC_DIR}/CMakeLists.txt")
        # qzjs's wasm3 ext is a pure-sandbox model — no WASI, no host APIs.
        # BUILD_WASI unset (not simple/metawasi/uvwasi) leaves d_m3HasWASI
        # undefined, so m3_api_wasi.c compiles to nothing and needs no POSIX
        # feature macros.
        set(BUILD_WASI "none" CACHE STRING "wasm3 WASI mode (none)" FORCE)
        add_subdirectory(${WASM3_SRC_DIR} ${CMAKE_BINARY_DIR}/deps/wasm3 EXCLUDE_FROM_ALL)
        message(STATUS "wasm3 enabled — building m3 from source (no WASI)")
        # wasm3's m3_api_libc.c uses strnlen (POSIX); under strict C99 (clang)
        # it needs _POSIX_C_SOURCE to be declared, else -Wimplicit-function-declaration.
        if(TARGET m3)
            target_compile_definitions(m3 PRIVATE _POSIX_C_SOURCE=200809L)
        endif()
    else()
        message(FATAL_ERROR "QZ_WITH_WASM3=ON but wasm3 source not found. "
            "Run: git submodule update --init deps/wasm3")
    endif()
endif()

# ============================================================================
# Core library (qzjs.c + bridge.c)
#
# Source files that are always compiled (no feature toggle):
#   qzjs.c, bridge.c, context.c, extension.c, polyfill_*.c (mode-dependent),
#   worker_boot_default.c, thread.c (执行模型 A 自持线程主循环), msgq.c
#   (入站消息 FIFO), ipc_envelope.c (M-P0 进程信封 fb 编解码)
# Extension sources are guarded by QZ_WITH_* feature toggles so they are
# only compiled when the corresponding feature is enabled. This avoids wasting
# compile time on dead code (e.g. ext_wasm3.c when WASM3=OFF).
# ============================================================================
set(_qz_core_sources
    src/qzjs.c
    src/bridge.c
    src/context.c
    src/extension.c
    ${_polyfill_gen_c}
    src/polyfill_load.c
    src/worker_boot_default.c
    src/thread.c
    src/msgq.c
    src/ipc_envelope.c
    src/ipc_ctl.c
    src/uv_io.c
    src/worker.c
    src/control.c
)
if(QZ_WITH_WAMR)
    list(APPEND _qz_core_sources src/ext_wamr.c)
endif()
if(QZ_WITH_WASM3)
    list(APPEND _qz_core_sources src/ext_wasm3.c)
endif()
if(QZ_WITH_COMPRESS)
    list(APPEND _qz_core_sources src/ext_compress.c)
endif()
if(NOT QZ_BUILD_TESTS)
    # M-P1 IPC process channel (src/ipc_process.c) uses real-libuv pipe APIs
    # (uv_pipe_t/uv_fileno) that mock_libuv does not implement, and its spawn
    # path is only exercisable by real-process e2e (design §10.1). Test builds
    # (QZ_BUILD_TESTS) compile the core against mock_libuv.h and exclude it.
    list(APPEND _qz_core_sources src/ipc_process.c)

    # CTL-2 本地控制端点（src/control_endpoint.c）：uv_pipe + SO_PEERCRED，
    # 与 ipc_process.c 同款——mock 构建无 uv_pipe，mock 下 LOCAL 档由
    # control.c 的 no-op stub 兜底（端点不可用，命令仍走进程内路径）。
    list(APPEND _qz_core_sources src/control_endpoint.c)

endif()
if(QZ_PROCESS_MODEL STREQUAL "ISOLATED" AND NOT QZ_BUILD_TESTS)
    # M-P2：宿主↔主RT 进程分离（src/rt_host.c）。THREAD 编译不编该路径——语义门见
    # §1.4：THREAD 编译下显式 worker_backend=PROCESS 求值报错。（§2.1「THREAD 不
    # 编入 ipc_*.c」的源级排除延后：先达成语义门，偏差记于 plan 状态。）
    list(APPEND _qz_core_sources src/rt_host.c)
endif()
if(QZ_WITH_CRYPTO_EXT)
    list(APPEND _qz_core_sources src/ext_crypto.c)
endif()
if(QZ_WITH_TEXTCODEC)
    list(APPEND _qz_core_sources src/ext_textcodec.c)
endif()

# TCP socket PAL — always available (excluded from mock-libuv test builds)
if(NOT QZ_BUILD_TESTS)
    list(APPEND _qz_core_sources src/tcp_io.c)
endif()

if(QZ_BUILD_DEBUGGER)
    list(APPEND _qz_core_sources src/debugger.c src/debugger_dap.c)
endif()


add_library(qzjs STATIC ${_qz_core_sources})

# fuzz 语料种子是字节码的派生产物：qzjs 一旦链接就带上了那份字节码，种子必须与
# 它同批生成，否则对齐门拿旧种子比新字节码。挂在 qzjs 上让每个构建 qzjs 的 job
# 都自动刷新种子（内嵌字节码变了，种子跟着变）。
if(Python3_Interpreter_FOUND)
    add_dependencies(qzjs fuzz_seeds_gen)
endif()

# ISOLATED 编译的定义（源码 #if 选择的唯一依据）。PUBLIC：消费者（含 qzjs-rt 与
# 宿主二进制）必须与库看到同一宏——include/qzjs/qzjs.h 的 worker_backend 枚举值
# 随该宏条件编译（§2.1「C 枚举字段可以条件编译」）。
if(QZ_PROCESS_MODEL STREQUAL "ISOLATED")
    target_compile_definitions(qzjs PUBLIC QZ_PROCESS_MODEL_ISOLATED=1)
endif()

# ${_polyfill_gen_c} 是生成产物（build.js 按 QZ_POLYFILL_MODE /
# QZ_WITH_NONUTF_ENCODINGS 产出不同符号面）；polyfill_rebuild 这个 phony target
# 让 qzjs 排在它之后，真正的生成规则是上面 add_custom_command(OUTPUT ...)（源文件
# 本身也直接触发该规则，见 _qz_core_sources）。
if(_polyfill_rebuild_enabled)
    add_dependencies(qzjs polyfill_rebuild)
endif()

# Let a parent project add its own extension sources to the qzjs target so
# &my_foo_ext is visible to context.c (which instantiates the QZ_EXTENSIONS
# table). Non-invasive: set(QZ_EXTRA_SOURCES ...) before add_subdirectory(qzjs).
if(DEFINED QZ_EXTRA_SOURCES)
    target_sources(qzjs PRIVATE ${QZ_EXTRA_SOURCES})
endif()
if(DEFINED QZ_EXTRA_HEADERS)
    # 自定义扩展声明（extern qz_ext_t ...）强制预包含，context.c 展开
    # QZ_EXTENSIONS 表时可见自定义扩展符号。
    target_compile_options(qzjs PRIVATE -include ${QZ_EXTRA_HEADERS})
endif()

# Let a parent project override the extension set at build time. The value is a
# macro expression (e.g. "QZ_DEFAULT_EXTENSIONS &my_foo_ext") resolved by
# qz_ext_registry.h at compile time. context.c #includes that header, so
# QZ_DEFAULT_EXTENSIONS is available even in an override.
if(DEFINED QZ_EXTENSIONS)
    target_compile_definitions(qzjs PRIVATE QZ_EXTENSIONS=${QZ_EXTENSIONS})
endif()

target_include_directories(qzjs PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

# Vendored headers reach qzjs's TUs as -isystem: the -Wall -Wextra -Wpedantic
# -Werror gate below judges qzjs's own sources only, and libuv's uv.h is not
# C99-clean under -Wpedantic (unnamed structs/unions). This only changes the
# header search path — every dep is a separate target that keeps its own flags.
target_include_directories(qzjs SYSTEM PUBLIC
    ${QUICKJS_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/deps/libuv/include
    ${CMAKE_CURRENT_SOURCE_DIR}/deps/libuv/src
)

# Test builds compile the core against mock_libuv.h: qz_t embeds uv_loop_t
# BY VALUE, so the struct layout must match the uv implementation the tests
# link (mock_libuv, not the system libuv). Production builds omit this define
# and use real libuv's uv.h.
if(QZ_BUILD_TESTS)
    # QZ_USE_MOCK_LIBUV 必须 **PUBLIC**：include/qzjs/qzjs.h 的 ping 家族守卫是
    # `#if defined(QZ_PROCESS_MODEL_ISOLATED) && !defined(QZ_USE_MOCK_LIBUV)`，
    # 而 ISOLATED 是 PUBLIC、mock 若留在 PRIVATE，测试目标就只看得到 ISOLATED
    # ——守卫的 mock 那半边对消费者形同虚设，头里照旧声明 qz_ping，而
    # libqzjs.a 里根本没有它（rt_host.c 整文件不编）。结果是「编译过、链接炸」
    # 在测试构建里原样复现。改成 PUBLIC 后守卫对库和消费者说的是同一件事。
    # 副作用可控：qzjs.h 本身不因该宏分支，消费方无需 mock_libuv.h 头文件。
    target_compile_definitions(qzjs PUBLIC QZ_USE_MOCK_LIBUV)
    target_include_directories(qzjs PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/test)
endif()

# ext_compress.c includes the vendored miniz.h, whose static-inline helpers
# (zError/crc32/inflate/…) trigger -Wunused-function under our -Werror. Relax
# just that warning for this one file (third-party header, not qzjs code).
set_source_files_properties(src/ext_compress.c PROPERTIES
    COMPILE_OPTIONS "-Wno-unused-function")

# polyfill_load.c includes the vendored miniz.h in mode A for tinfl inflate;
# its static-inline helpers trigger the same -Wunused-function as ext_compress.c.
set_source_files_properties(src/polyfill_load.c PROPERTIES
    COMPILE_OPTIONS "-Wno-unused-function")

# Warn-hardening + strict C99 for qzjs's own sources.
#
# Isolation (src vs deps): this function is the ONE place -Werror is set and
# it is PRIVATE to the target, so no flag propagates into vendored code built
# by add_subdirectory (miniz, quickjs-ng, mbedtls, wamr) or into libuv's own
# targets - they keep their own warning flags and C standard. In the other
# direction, vendored *headers* included by src/ are reached as -isystem (see
# the qzjs include-directories block above), so the compiler treats them as
# system headers and -Wpedantic judges src/ code only: uv.h's unnamed
# structs/unions (not C99) stay silent, while a real src/ pedantic defect
# still fails the build.
#
# -Wpedantic enforces the "no GNU extensions" promise in CMAKE_C_EXTENSIONS
# rather than merely declaring it. _POSIX_C_SOURCE exposes strdup/putenv/etc.
# that qzjs uses, since pure -std=c99 hides them. bridge.c marks QuickJS
# callback fixed-signature params with QZ_UNUSED.
function(qz_enable_warnings target)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
    target_compile_definitions(${target} PRIVATE _POSIX_C_SOURCE=200809L)
endfunction()
qz_enable_warnings(qzjs)

# QZ_DEBUG_SUPPORT gates the debugger code in src/debugger.c, src/debugger_dap.c
# and the auto-attach path in qzjs.c. The engine patch's DEBUGGER_CHECK hook is
# also gated on this macro (it's a no-op when undefined). Only defined when
# QZ_BUILD_DEBUGGER=ON, so non-debugger builds have zero debug overhead.
if(QZ_BUILD_DEBUGGER)
    target_compile_definitions(qzjs PUBLIC QZ_DEBUG_SUPPORT)
endif()

# Conditional wasm3 includes
# All QZ_WITH_* are defined as 0 or 1 (not just defined when ON) so the
# QZ_EXT_IF_WITH conditional macro in qz_ext_registry.h can resolve a
# disabled built-in to a NULL slot. PUBLIC so consumers (tests, examples) can
# see which extensions are compiled in.
target_compile_definitions(qzjs PUBLIC
    QZ_WITH_WAMR=$<BOOL:${QZ_WITH_WAMR}>
    QZ_WITH_WASM3=$<BOOL:${QZ_WITH_WASM3}>
    QZ_WITH_COMPRESS=$<BOOL:${QZ_WITH_COMPRESS}>
    QZ_WITH_CRYPTO_EXT=$<BOOL:${QZ_WITH_CRYPTO_EXT}>
    QZ_WITH_TEXTCODEC=$<BOOL:${QZ_WITH_TEXTCODEC}>
    QZ_WITH_TLS=$<BOOL:${QZ_WITH_TLS}>
    QZ_WITH_NONUTF_ENCODINGS=$<BOOL:${QZ_WITH_NONUTF_ENCODINGS}>
    QZ_POLYFILL_MODE=${_qz_polyfill_mode_num}
)
if(QZ_WITH_WAMR)
    target_include_directories(qzjs PUBLIC
        ${WAMR_DIR}/core/iwasm/include
    )
endif()
if(QZ_WITH_CRYPTO_EXT)
    target_include_directories(qzjs PUBLIC
        ${MBEDCRYPTO_INCLUDE_DIR}
    )
endif()

# Core link libraries — qjs (QuickJS-ng) and libm are always needed.
# pthread and dl are POSIX-specific; libuv (uv_a) is deliberately NOT linked
# here — the qzjs static lib compiles against libuv headers only, and uv
# symbols resolve at the final target (tests: mock_libuv; qz_full: uv_a).
set(_qz_core_libs qjs m)
if(UNIX AND NOT ESP_PLATFORM)
    list(APPEND _qz_core_libs pthread dl)
endif()
target_link_libraries(qzjs PUBLIC ${_qz_core_libs})


if(QZ_POLYFILL_MODE STREQUAL "compressed")
    target_link_libraries(qzjs PUBLIC lz4_static)
endif()
# C-layer JSON (control/ipc/DAP sites, see c-js-layering §6.6)
target_link_libraries(qzjs PUBLIC cjson)
# Conditional WASM engine linking
if(QZ_WITH_WAMR)
    target_link_libraries(qzjs PUBLIC vmlib)
endif()
if(QZ_WITH_WASM3)
    target_link_libraries(qzjs PUBLIC m3)
endif()
if(QZ_WITH_COMPRESS)
    target_link_libraries(qzjs PUBLIC miniz)
endif()
if(QZ_WITH_CRYPTO_EXT)
    target_link_libraries(qzjs PUBLIC ${MBEDCRYPTO_LIB})
endif()
if(QZ_WITH_TLS)
    # uv_io.c（编进 qzjs 核心）用 mbedTLS SSL API 做 HTTPS；链接全部三个
    # mbedTLS 归档，消费方才能解析 mbedtls_ssl_*。
    target_link_libraries(qzjs PUBLIC ${MBEDTLS_LIB} ${MBEDX509_LIB} ${MBEDCRYPTO_LIB})
endif()

# ============================================================================
# libuv — hard dependency (sole event-loop backend)
#
# Built from source (vendored as the libuv/ submodule) — never linked against
# the system libuv. libuv is a hard dependency: qzjs embeds uv_loop_t BY VALUE
# in qz_t and runs its own thread on uv_run, so without it nothing compiles.
# The qzjs static lib compiles against libuv headers but does NOT link uv_a —
# uv symbols resolve at the final target (tests resolve them via mock_libuv).
# ============================================================================
set(LIBUV_SRC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/deps/libuv")
if(NOT EXISTS "${LIBUV_SRC_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "libuv source not found. "
        "Run: git submodule update --init deps/libuv")
endif()

# ── libuv C99 atomics patch ────────────────────────────────────────────────
# libuv uses C11 <stdatomic.h> (_Atomic). Apply a patch that maps the
# atomic_* ops + _Atomic qualifier to GCC/Clang __atomic_* builtins
# (in uv-common.h, which all libuv sources include), so it compiles
# under -std=c99. Working-tree-only; submodule stays clean.
set(QZ_LIBUV_C99_PATCH "${CMAKE_CURRENT_SOURCE_DIR}/deps/libuv-c99-atomics.patch")
if(EXISTS "${QZ_LIBUV_C99_PATCH}")
    execute_process(
        COMMAND patch -p1 --dry-run -f -i "${QZ_LIBUV_C99_PATCH}"
        WORKING_DIRECTORY "${LIBUV_SRC_DIR}"
        RESULT_VARIABLE _luv_dry OUTPUT_QUIET ERROR_QUIET)
    if(_luv_dry EQUAL 0)
        execute_process(
            COMMAND patch -p1 -f -i "${QZ_LIBUV_C99_PATCH}"
            WORKING_DIRECTORY "${LIBUV_SRC_DIR}"
            RESULT_VARIABLE _luv_apply ERROR_QUIET)
        if(NOT _luv_apply EQUAL 0)
            message(FATAL_ERROR "Failed to apply libuv C99 atomics patch")
        endif()
        message(STATUS "Applied libuv C99 atomics patch (deps/libuv-c99-atomics.patch)")
    else()
        execute_process(
            COMMAND grep -c "qwrt: avoid C11 <stdatomic.h>"
                    "${LIBUV_SRC_DIR}/src/uv-common.h"
            OUTPUT_QUIET ERROR_QUIET RESULT_VARIABLE _luv_grep_rc)
        if(NOT _luv_grep_rc EQUAL 0)
            message(FATAL_ERROR
                "libuv C99 atomics patch does not apply cleanly and is not "
                "already applied. Regenerate deps/libuv-c99-atomics.patch.")
        endif()
    endif()
endif()

# libuv via add_subdirectory. Its CMake mutates global CMAKE_C_STANDARD
# (→11) and CMAKE_EXPORT_COMPILE_COMMANDS; save+restore to keep qzjs C99.
set(_qz_saved_c_extensions     ${CMAKE_C_EXTENSIONS})
set(_qz_saved_c_standard       ${CMAKE_C_STANDARD})
set(_qz_saved_export_cc        ${CMAKE_EXPORT_COMPILE_COMMANDS})

set(LIBUV_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS  OFF CACHE BOOL "" FORCE)
set(LIBUV_BUILD_TESTS  OFF CACHE BOOL "" FORCE)
set(LIBUV_BUILD_BENCH  OFF CACHE BOOL "" FORCE)

add_subdirectory(${LIBUV_SRC_DIR} ${CMAKE_BINARY_DIR}/deps/libuv EXCLUDE_FROM_ALL)

set(CMAKE_C_EXTENSIONS           ${_qz_saved_c_extensions})
set(CMAKE_C_STANDARD             ${_qz_saved_c_standard})
set(CMAKE_EXPORT_COMPILE_COMMANDS ${_qz_saved_export_cc})

if(NOT TARGET uv_a)
    message(FATAL_ERROR "libuv add_subdirectory did not define target 'uv_a'")
endif()

# Force uv_a to C99 (libuv's CMake sets CMAKE_STANDARD=11, but with the
# C99-atomics patch its sources need no C11).
set_target_properties(uv_a PROPERTIES C_STANDARD 99 C_EXTENSIONS OFF)

set(LIBUV_FOUND TRUE)
set(LIBUV_INCLUDE_DIRS "${LIBUV_SRC_DIR}/include")
set(LIBUV_LIBRARIES uv_a rt dl pthread)

# ============================================================================
# Full library (qzjs + real libuv + extensions, bundled)
#
# A single static archive aggregating the qzjs core with real libuv (uv_a).
# uv symbols are NOT resolved inside qzjs — the qzjs static lib compiles
# against libuv headers only; qz_full supplies uv_a so a consumer linking
# one archive resolves everything. qzjs's PUBLIC links already pull in
# qjs/m/pthread/dl and the enabled extensions (vmlib/miniz/mbedcrypto/
# mbedtls/…), which flow through transitively.
# ============================================================================
file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/qz_full_stub.c "")
add_library(qz_full STATIC ${CMAKE_CURRENT_BINARY_DIR}/qz_full_stub.c)
target_include_directories(qz_full PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${QUICKJS_DIR}
    ${LIBUV_INCLUDE_DIRS}
)
target_link_libraries(qz_full PUBLIC qzjs ${LIBUV_LIBRARIES})
if(QZ_BUILD_DEBUGGER)
    target_compile_definitions(qz_full PUBLIC QZ_DEBUG_SUPPORT)
endif()


# ============================================================================
# Subdirectories
# ============================================================================

if(QZ_BUILD_TESTS)
    enable_testing()
    add_subdirectory(test)
endif()

if(QZ_BUILD_EXAMPLES)
    add_subdirectory(examples)
endif()

# ============================================================================
# CLI — standalone WinterTC runtime (dogfoods the qzjs C API)
# ============================================================================
if(QZ_BUILD_CLI)
    add_executable(qz_cli src/cli.c)
    set_target_properties(qz_cli PROPERTIES OUTPUT_NAME qzjs)
    if(QZ_BUILD_TESTS)
        # Test builds compile the qzjs core against mock_libuv.h
        # (QZ_USE_MOCK_LIBUV), so the CLI must link mock_libuv too. Linking
        # qz_full (real uv_a) makes the real-libuv functions operate on
        # mock-sized structs and overwrite the queue fields — the old
        # "free(): invalid pointer" abort on `qzjs -e 'console.log(1+1)'`.
        # Mock libuv's loop drives timers/asyncs/threads, so basic scripts
        # evaluate correctly; real networking needs a QZ_BUILD_TESTS=OFF
        # build (e.g. build_cli).
        target_link_libraries(qz_cli PRIVATE qzjs mock_libuv)
    else()
        target_link_libraries(qz_cli PRIVATE qz_full)
    endif()
qz_enable_warnings(qz_cli)
endif()
# ============================================================================
# qzjs-rt — standalone worker process binary (M-P1 multi-process model)
# Spawned by qz_proc_spawn via fork+exec. Uses real-libuv pipe APIs, so it
# only builds in non-test builds (mock_libuv has no pipe API — design §10.1).
# ============================================================================
if(QZ_BUILD_CLI AND NOT QZ_BUILD_TESTS)
    add_executable(qz_rt src/rt_main.c)
    set_target_properties(qz_rt PROPERTIES OUTPUT_NAME qzjs-rt)
    # Same -Wall -Wextra -Werror + _POSIX_C_SOURCE discipline as the qzjs lib
    # (review I8): rt_main.c is core runtime code, not an exception.
    qz_enable_warnings(qz_rt)
    target_link_libraries(qz_rt PRIVATE qz_full)
endif()

# ============================================================================
# qzc — qzjs bytecode compiler（qz_compile 的 CLI 形态）
# 独立工具：qzc <in.js> [-o out.bc]；产物经 qzjs --bytecode 运行。
# 编译期只调 qz_compile（一次性 JSRuntime），不触碰 libuv 运行时 API——
# mock 测试构建（QZ_USE_MOCK_LIBUV）也产出，链接 qzjs 即可；真实构建链
# qz_full（真 libuv 传递闭包）。注意：mock/real 两个构建产出的 qzc 语义
# 相同（qz_compile 不依赖 uv loop），字节码可互换（同引擎构建）。
# ============================================================================
if(QZ_BUILD_CLI)
    add_executable(qz_qzc src/qzc.c)
    set_target_properties(qz_qzc PROPERTIES OUTPUT_NAME qzc)
    qz_enable_warnings(qz_qzc)
    if(QZ_BUILD_TESTS)
        target_link_libraries(qz_qzc PRIVATE qzjs mock_libuv)
    else()
        target_link_libraries(qz_qzc PRIVATE qz_full)
    endif()
endif()

# ============================================================================
# qzjs-ctl — control-plane endpoint client (CTL-2)
# 纯 POSIX socket + stdio（不依赖 libuv / qzjs 库）；只在真实构建产出
# （test 构建无控制面端点）。
# ============================================================================
if(QZ_BUILD_CLI AND NOT QZ_BUILD_TESTS)
    add_executable(qz_ctl src/ctl_cli.c)
    set_target_properties(qz_ctl PROPERTIES OUTPUT_NAME qzjs-ctl)
    qz_enable_warnings(qz_ctl)
endif()
# ============================================================================
# qz_mp7_mailbox_e2e — M-P7 邮箱宿主契约 e2e harness（真 qz_full + ISOLATED
# 后端；mock/test 构建无该路径，仅在真实构建产出）。harness 即宿主：零回调、
# 零 libuv，邮箱消费全走 qz_recv_message/qz_message_fd。与 qzjs-rt 同目录
# （QZ_RT_SERVER 解析链经 /proc/self/exe 命中）。
# ============================================================================
if(QZ_PROCESS_MODEL STREQUAL "ISOLATED" AND NOT QZ_BUILD_TESTS)
    add_executable(qz_mp7_mailbox_e2e test/mp7-mailbox/mailbox_e2e.c)
    target_link_libraries(qz_mp7_mailbox_e2e PRIVATE qz_full)
    target_include_directories(qz_mp7_mailbox_e2e PRIVATE
        ${CMAKE_SOURCE_DIR}/include)
    # pthread / clock_gettime / poll 在 -std=c99 下需 POSIX 宏
    target_compile_definitions(qz_mp7_mailbox_e2e PRIVATE _POSIX_C_SOURCE=200809L)
    qz_enable_warnings(qz_mp7_mailbox_e2e)
endif()
# ============================================================================
# qz_ctl_endpoint_leak_probe — CTL-2 本地端点 + target_path 前投的 LSan 探针。
#
# 为什么要有这个独立探针：test_nested_e2e.sh 里 `ctl --target-path` 走的正是
# qz_control_endpoint_cmd 的 path 前投早返回，而那条路径曾经不 free(buf) /
# free(correl)。ASAN 一直没报出来不是因为不漏，而是 e2e 脚本用 kill -TERM 收
# 宿主——LSan 只在**正常退出**的 atexit 里跑检查，收信号直接死就一封报告都不出。
# 「测试没报」不等于「没漏」。本探针自己建运行时、当客户端、正常 return，
# 让泄漏检查真的跑。仅诊断用，不参与 ctest（需要 ASAN 才有意义）。
# ============================================================================
if(QZ_BUILD_CLI AND NOT QZ_BUILD_TESTS)
    add_executable(qz_ctl_endpoint_leak_probe test/probe_ctl_endpoint_leak.c)
    target_link_libraries(qz_ctl_endpoint_leak_probe PRIVATE qz_full)
    target_compile_definitions(qz_ctl_endpoint_leak_probe PRIVATE
        _POSIX_C_SOURCE=200809L)
    qz_enable_warnings(qz_ctl_endpoint_leak_probe)
endif()

# ============================================================================
# qz_ctl_reject_frames_probe — 端点拒收路径的帧级探针，逐帧用 cJSON 真解析。
#
# 存在的理由：第一版那两条拒收回帧里，-3 帧是**非法 JSON**（C 记法 \"qzjs\"
# 只让字符串里出现裸引号，拼进 JSON 在第 53 列截断 error 串），而 qzjs-ctl 用
# strstr 判断成败、从不解析 JSON，所以谁都没抓��到——用 strstr 写的断言天生抓不到
# 「JSON 非法」。同源的另外三条也一起锁：帧尾不能自带 \n（否则多一个空帧）、
# 前投无此槽位要当场回 NOT_FOUND、interrupt 不带 correl 不得被拒。
# ============================================================================
if(QZ_BUILD_CLI AND NOT QZ_BUILD_TESTS)
    add_executable(qz_ctl_reject_frames_probe test/probe_ctl_reject_frames.c)
    target_link_libraries(qz_ctl_reject_frames_probe PRIVATE qz_full cjson)
    target_compile_definitions(qz_ctl_reject_frames_probe PRIVATE
        _POSIX_C_SOURCE=200809L)
    qz_enable_warnings(qz_ctl_reject_frames_probe)
endif()

# ============================================================================
# host_contract_e2e — 宿主形态的消费契约端到端验证（真实 ISOLATED 构建）。
#
# 既有 8 支 e2e 的 harness 是**测试专用**宿主，各自验一条断言。宿主真正会做的事
# ——照 docs/{,zh/}c-api/runtime.md「邮箱」节那段循环收发——没有任何一支在验；
# 文档门只保证那段代码能编，不保证它行为正确。这一支跑三条路径：
#   1. 文档循环原样（三态分开判、错误帧认出来且不 break）
#   2. 宿主自己的 eventfd（qz_message_fd）+ poll 驱动的循环
#   3. qz_wait_idle 之后仍可排干（最终排干的位置就在那里）
# ============================================================================
if(QZ_BUILD_CLI AND NOT QZ_BUILD_TESTS)
    add_executable(host_contract_e2e test/host_contract_e2e.c)
    target_link_libraries(host_contract_e2e PRIVATE qz_full)
    target_compile_definitions(host_contract_e2e PRIVATE _POSIX_C_SOURCE=200809L)
    qz_enable_warnings(host_contract_e2e)
endif()

# ============================================================================
# Install
# ============================================================================
set(_qz_install_targets qzjs qz_full)
install(TARGETS ${_qz_install_targets}
    ARCHIVE DESTINATION lib
)
install(DIRECTORY include/qzjs
    DESTINATION include
)
install(FILES include/qzjs/ext_wasm3.h DESTINATION include/qzjs)
# Vendored dependency archives. The qzjs static lib deliberately does not
# bundle uv/qjs/extensions — their symbols resolve at the final link — so
# install the archives alongside libqzjs.a for non-CMake consumers
# (pkg-config, plain -L<prefix>/lib).
set(_qz_dep_install_targets uv_a qjs)
if(QZ_WITH_WAMR)
    list(APPEND _qz_dep_install_targets vmlib)
endif()
if(QZ_WITH_WASM3)
    list(APPEND _qz_dep_install_targets m3)
endif()
if(QZ_WITH_COMPRESS)
    list(APPEND _qz_dep_install_targets miniz)
endif()
if(QZ_WITH_TLS)
    list(APPEND _qz_dep_install_targets
        ${MBEDTLS_LIB} ${MBEDX509_LIB} ${MBEDCRYPTO_LIB})
elseif(QZ_WITH_CRYPTO_EXT)
    list(APPEND _qz_dep_install_targets ${MBEDCRYPTO_LIB})
endif()
install(TARGETS ${_qz_dep_install_targets}
    ARCHIVE DESTINATION lib
)

# ============================================================================
# pkg-config & CMake config for find_package(qzjs) consumers
# ============================================================================
include(CMakePackageConfigHelpers)

# qzjs-config.cmake — exported by install, consumed by find_package(qzjs)
set(_qz_cmake_config_dir "lib/cmake/qzjs")

# Write the version file (uses project version from project() call above)
write_basic_package_version_file(
    "${CMAKE_CURRENT_BINARY_DIR}/qzConfigVersion.cmake"
    VERSION ${PROJECT_VERSION}
    COMPATIBILITY SameMajorVersion
)
install(FILES
    "${CMAKE_CURRENT_BINARY_DIR}/qzConfigVersion.cmake"
    DESTINATION "${_qz_cmake_config_dir}"
)

# Generate a pkg-config .pc file for qzjs (qzjs.pc)
set(_qz_pc_dir "lib/pkgconfig")
# Static link line for non-CMake consumers: the qzjs core + every vendored
# archive it leaves unresolved (uv/qjs + the feature-gated extensions below).
# NOTE: `-lam` was the pre-rename name of the core lib and no longer matches
# any installed archive — pkg-config emitted a link line that could never
# resolve. Keep this list in sync with _qz_install_targets/_qz_dep_install_targets.
set(_qz_pc_libs "-lqzjs -luv -lqjs")
if(QZ_WITH_WAMR)
    string(APPEND _qz_pc_libs " -liwasm")
endif()
if(QZ_WITH_WASM3)
    string(APPEND _qz_pc_libs " -lm3")
endif()
if(QZ_WITH_COMPRESS)
    string(APPEND _qz_pc_libs " -lminiz")
endif()
if(QZ_WITH_TLS)
    string(APPEND _qz_pc_libs " -lmbedtls -lmbedx509 -lmbedcrypto")
elseif(QZ_WITH_CRYPTO_EXT)
    string(APPEND _qz_pc_libs " -lmbedcrypto")
endif()
if(UNIX AND NOT ESP_PLATFORM)
    string(APPEND _qz_pc_libs " -lpthread -ldl -lrt")
endif()
set(_qz_pc_requires "")
set(_qz_pc_cflags "-I\${includedir}")

configure_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/cmake/libqzjs.pc.in"
    "${CMAKE_CURRENT_BINARY_DIR}/qzjs.pc"
    @ONLY
)
install(FILES
    "${CMAKE_CURRENT_BINARY_DIR}/qzjs.pc"
    DESTINATION "${_qz_pc_dir}"
)
