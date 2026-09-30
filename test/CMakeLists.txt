# NOTE: tests run via ctest (see add_test below), NOT as a POST_BUILD step.
# A POST_BUILD test run aborts the entire build on a single test failure,
# blocking unrelated targets (incl. the upper-layer tests) from building.

# ============================================================================
# Google Test targets
# ============================================================================
# googletest is a git submodule (deps/googletest) like the other deps — no
# FetchContent/network download (keeps offline builds reproducible).
set(GOOGLETEST_DIR "${CMAKE_SOURCE_DIR}/deps/googletest" CACHE PATH "Path to the googletest source tree (git submodule)")
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
add_subdirectory(${GOOGLETEST_DIR} ${CMAKE_CURRENT_BINARY_DIR}/googletest)

# mock libuv: fake uv_* API for deterministic offline tests
add_library(mock_libuv STATIC mock_libuv.c)
target_include_directories(mock_libuv PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(mock_libuv pthread)

add_executable(test_mock_uv_gtest test_mock_uv_gtest.cpp)
target_include_directories(test_mock_uv_gtest PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(test_mock_uv_gtest mock_libuv GTest::gtest_main pthread)
add_test(NAME test_mock_uv_gtest COMMAND test_mock_uv_gtest)
set_tests_properties(test_mock_uv_gtest PROPERTIES LABELS "offline")

function(add_qz_gtest name)
    add_executable(${name} ${name}.cpp)
    target_include_directories(${name} PRIVATE
        ${PROJECT_SOURCE_DIR}/include
        ${PROJECT_SOURCE_DIR}/src
        ${CMAKE_CURRENT_SOURCE_DIR}
    )
    target_compile_definitions(${name} PRIVATE QZ_USE_MOCK_LIBUV)
    target_link_libraries(${name} qzjs mock_libuv GTest::gtest_main pthread)
    add_test(NAME ${name} COMMAND ${name})
    if(QZ_POLYFILL_MODE STREQUAL "external")
        set_tests_properties(${name} PROPERTIES
            LABELS "offline"
            ENVIRONMENT "QZ_POLYFILL_FILE=${PROJECT_SOURCE_DIR}/dist/polyfill_default.polyfill")
    else()
        set_tests_properties(${name} PROPERTIES LABELS "offline")
    endif()
endfunction()

# Core gtest suites
add_qz_gtest(test_context_gtest)
add_qz_gtest(test_suspend_gtest)
target_compile_definitions(test_suspend_gtest PRIVATE TEST_DIR="${CMAKE_CURRENT_SOURCE_DIR}")
add_qz_gtest(test_qzjs_gtest)
add_qz_gtest(test_control_gtest)          # CTL-0 控制面（进程内基线）
add_qz_gtest(test_ctl_route_gtest)        # CTL-1 信封 CONTROL 树路由
add_qz_gtest(test_multi_instance_gtest)   # M-R1 §13.4 双实例回归
add_qz_gtest(test_worker_gtest)
target_compile_definitions(test_worker_gtest PRIVATE TEST_DIR="${CMAKE_CURRENT_SOURCE_DIR}")
add_qz_gtest(test_bridge_http_gtest)
add_qz_gtest(test_bridge_stream_gtest)
add_qz_gtest(test_fetch_stream_gtest)
add_qz_gtest(test_polyfill_gtest)
add_qz_gtest(test_polyfill_lazy_gtest)
add_qz_gtest(test_host_messaging_gtest)   # host-messaging 边界直接测试（P2-10）
add_qz_gtest(test_ipc_envelope_gtest)
# 出站邮箱 OOM 可见性（per-rt 钩子 qz_test_mailbox_fault，见 src/msgq.c）：
# 分配失败必须在流上留标记帧，不能静默留洞。
add_qz_gtest(test_mailbox_oom_gtest)
# CONTROL payload 分类（"qzjs" 数字键 = 通道层保留命名空间）：rt_main 分流与
# qz_control 入口拒收共用同一判据，判据本身需直接覆盖。
add_qz_gtest(test_ipc_ctl_gtest)

# 出站邮箱队列的**单元**层：FIFO / 空队列 / has_pending 迁移 / teardown 幂等 /
# 多生产者计数完整性。此前 M-P7 的核心数据结构只被整运行时间接测。
add_qz_gtest(test_queue_gtest)
add_qz_gtest(test_context_worker_composition_gtest)   # M-R2 §14.3 组合语义（contexts × workers）
target_compile_definitions(test_context_worker_composition_gtest PRIVATE TEST_DIR="${CMAKE_CURRENT_SOURCE_DIR}")

# CLI end-to-end (test_cli_gtest.cpp): forks the real qzjs executable and
# asserts stdout/stderr/exit code for -e / script / timers / --help /
# --version / unknown-flag / globalThis.arguments. Gated on QZ_BUILD_CLI
# (option declared in the root options block, above add_subdirectory(test)).
# QZ_CLI_BIN is a generate-time genex because qz_cli is defined further down
# the root CMakeLists than this subdirectory is added.
if(QZ_BUILD_CLI)
    add_qz_gtest(test_cli_gtest)
    target_compile_definitions(test_cli_gtest PRIVATE
        QZ_CLI_BIN="$<TARGET_FILE:qz_cli>"
        CLI_SCRIPTS_DIR="${CMAKE_CURRENT_SOURCE_DIR}/cli_scripts"
    )
endif()

# IPC Envelope wire-format cross-verification (M-P0): the CLI helper is pure
# C99 + ipc_envelope.c (no libuv); the python driver needs the official
# flatbuffers package. Registered only when both are available so stock
# `ctest -L offline` never fails on machines without `pip install flatbuffers`.
# 不能 EXCLUDE_FROM_ALL：CI 干净全量构建（cmake --build --parallel）按
# EXCLUDE 不产出 CLI → fbcheck 测试找不到二进制必挂（本地增量构建残留的
# 旧产物会掩盖此问题，见 test262 runner 同款教训）。纯 C99 极小，全量无害。
add_executable(ipc_envelope_cli ipc_envelope_cli.c
               ../src/ipc_envelope.c)
target_include_directories(ipc_envelope_cli PRIVATE ${PROJECT_SOURCE_DIR}/src)
find_package(Python3 COMPONENTS Interpreter QUIET)
if(NOT Python3_Interpreter_FOUND)
    find_program(Python3_EXECUTABLE python3)
    if(Python3_EXECUTABLE)
        set(Python3_Interpreter_FOUND TRUE)
    endif()
endif()
if(Python3_Interpreter_FOUND)
    execute_process(COMMAND ${Python3_EXECUTABLE} -c "import flatbuffers"
                    RESULT_VARIABLE _fb_import_rc OUTPUT_QUIET ERROR_QUIET)
    if(NOT _fb_import_rc EQUAL 0)
        # CMake may resolve a venv/alternate python without user site-packages;
        # retry with the PATH python3 before giving up.
        find_program(_fb_py3 python3)
        if(_fb_py3)
            execute_process(COMMAND ${_fb_py3} -c "import flatbuffers"
                            RESULT_VARIABLE _fb_import_rc OUTPUT_QUIET ERROR_QUIET)
            if(_fb_import_rc EQUAL 0)
                set(Python3_EXECUTABLE ${_fb_py3})
            endif()
        endif()
    endif()
    if(_fb_import_rc EQUAL 0)
        add_test(NAME ipc_envelope_fbcheck
                 COMMAND ${Python3_EXECUTABLE}
                         ${CMAKE_CURRENT_SOURCE_DIR}/ipc_envelope_fbcheck.py
                         --cli $<TARGET_FILE:ipc_envelope_cli>)
        set_tests_properties(ipc_envelope_fbcheck PROPERTIES LABELS "offline")
    else()
        message(STATUS "python flatbuffers missing — ipc_envelope_fbcheck skipped")
    endif()
endif()

if(QZ_WITH_CRYPTO_EXT)
    add_qz_gtest(test_crypto_subtle_gtest)
endif()

if(QZ_WITH_WAMR OR QZ_WITH_WASM3)
    add_qz_gtest(test_wasm_streaming_gtest)
    add_qz_gtest(test_wasm_imports_gtest)
endif()

if(QZ_WITH_WAMR)
    add_qz_gtest(test_wasm_aot_gtest)
endif()

if(QZ_WITH_COMPRESS)
    add_qz_gtest(test_compress_gtest)
    add_qz_gtest(test_compress_consistency_gtest)
endif()

if(QZ_BUILD_DEBUGGER)
    # DAP end-to-end (test_dap_gtest.cpp): forks a child embedding host and
    # drives the DAP client over pipes (initialize/setBreakpoints/stopped/
    # stackTrace/scopes/variables/evaluate/continue). Kept out of "offline" —
    # runs only via `ctest -L dap` (the debugger CI job). 30s timeout so a
    # hung child fails via ctest instead of hanging the job.
    add_qz_gtest(test_dap_gtest)
    set_tests_properties(test_dap_gtest PROPERTIES LABELS "dap" TIMEOUT 30)
endif()

# ============================================================================
# ctest registration — non-gtest targets only (gtest targets register via
# add_test inside add_qz_gtest above)
#
# Tests are labelled so CI can select a subset:
#   LABELS "offline"   — pure local, no network, deterministic (run always)
#   LABELS "network"   — needs outbound HTTP/HTTPS
#   LABELS "benchmark" — perf measurement, not pass/fail
# Run subsets:  ctest -L offline     # CI default
#               ctest -L network     # only when network is available
# ============================================================================

# test262 — uses QuickJS-ng's own run-test262 runner and test262.conf
# to run ECMAScript conformance tests directly against the engine.
#
# Paths are relative to WORKING_DIRECTORY (deps/quickjs-ng), matching the
# runner's convention: test262.conf carries errorfile=test262_errors.txt and
# testdir=test262/test, and both are composed against the config file's
# directory. Absolute paths here would break find_error()'s relative-path
# matching against the error file.
# CI 全量 build 默认不产出 runner——顶层以 QZ_BUILD_TESTS 条件的 ALL 目标
# 显式依赖 run-test262（见 CMakeLists.txt quickjs 段）。
add_test(NAME test262_quickjs
  COMMAND ${CMAKE_BINARY_DIR}/deps/quickjs-ng/run-test262
    -c test262.conf
    test262/test
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}/deps/quickjs-ng)
set_tests_properties(test262_quickjs PROPERTIES LABELS "test262")
