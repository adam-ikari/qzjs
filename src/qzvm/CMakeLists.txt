# qzvm —— 纯 VM 构建单元（选项 + 源列表）
#
# 选项（wasm 引擎选择 + debug 功能）：
#   QZ_WITH_WAMR  / QZ_WITH_WASM3 —— WebAssembly 引擎选择（互斥）。
#     **AOT 关键：不允许关闭** —— 二者至少一个必须 ON（wasm 运行时是 AOT 工具链的
#     执行后端；全关则 WebAssembly API 不可用）。
#   QZ_BUILD_DEBUGGER —— DAP step-debugger（quickjs-ng 引擎已含 debugger patch，
#     本选项只控制 qzvm 是否编译 DAP 适配器并定义 QZ_DEBUG_SUPPORT 接 dispatch 钩子）。
#
# 源通过 QZVM_SOURCES（PARENT_SCOPE）交回顶层，并入 libqzjs 编译——避免 qzvm
# 与宿主层（扩展符号 compress/crypto/textcodec）形成静态库循环链接。选项与源
# 组织在 qzvm 独立管理；宏/include 由顶层 qzjs target 统一（PUBLIC 宏块 + include 路径）。

# ── wasm 引擎选择（AOT 关键，不允许关闭）──────────────────────────────
option(QZ_WITH_WAMR "Link WAMR WASM engine (default; AOT key, cannot be off)" ON)
option(QZ_WITH_WASM3 "Link wasm3 WASM engine (alternative; AOT key, cannot be off)" OFF)
if(NOT QZ_WITH_WAMR AND NOT QZ_WITH_WASM3 AND NOT QZ_IN_MODULE)
    message(FATAL_ERROR
        "wasm engine required (AOT key): QZ_WITH_WAMR or QZ_WITH_WASM3 must be ON. "
        "WebAssembly runtime is the execution backend for the AOT toolchain — "
        "it cannot be disabled. Enable exactly one:\n"
        "  wamr  (default): -DQZ_WITH_WAMR=ON\n"
        "  wasm3:            -DQZ_WITH_WASM3=ON -DQZ_WITH_WAMR=OFF\n"
        "(in-module: qzvm IS the wasm guest; host runtime supplies the engine — "
        "both OFF is correct under -DQZ_PROFILE=in-module)")
endif()
if(QZ_WITH_WAMR AND QZ_WITH_WASM3)
    message(FATAL_ERROR
        "QZ_WITH_WAMR=ON and QZ_WITH_WASM3=ON are mutually exclusive. Enable only one.")
endif()

# ── debug 功能 ───────────────────────────────────────────────────────
option(QZ_BUILD_DEBUGGER "Build DAP step-debugger (compiles debugger.c + debugger_dap.c, defines QZ_DEBUG_SUPPORT)" OFF)

# ── qzvm 源（纯 VM：context / eval+compile / 扩展生命周期 / wasm / debugger）──
# 交回顶层，并入 libqzjs（源列表 + 条件 genex；宏/include 由顶层 qzjs target 提供）
set(QZVM_SOURCES
    ${CMAKE_CURRENT_SOURCE_DIR}/context.c
    ${CMAKE_CURRENT_SOURCE_DIR}/vm_core.c
    ${CMAKE_CURRENT_SOURCE_DIR}/ext_lifecycle.c
    $<$<BOOL:${QZ_WITH_WAMR}>:${CMAKE_CURRENT_SOURCE_DIR}/ext_wamr.c>
    $<$<BOOL:${QZ_WITH_WASM3}>:${CMAKE_CURRENT_SOURCE_DIR}/ext_wasm3.c>
    $<$<BOOL:${QZ_BUILD_DEBUGGER}>:${CMAKE_CURRENT_SOURCE_DIR}/debugger.c ${CMAKE_CURRENT_SOURCE_DIR}/debugger_dap.c>)
set(QZVM_SOURCES ${QZVM_SOURCES} PARENT_SCOPE)

# ── in-module guest 产物（IN_MODULE_DESIGN.md §6/§8 M4）──────────────────
# qzvm 编到 wasm32-wasi reactor，产 libqzvm.wasm。源集 = 内核三源 + quickjs-ng
# + guest 入口；宿主侧（libuv/wamr/polyfill/ext 接线）一律不进。QZ_VM_GUEST
# 驱动 qz_core.h/qz_types.h/qz_rt.h 的条件编译，让 uv 类型对 guest 不可达。
if(QZ_IN_MODULE)
    add_executable(qzvm-guest
        ${CMAKE_CURRENT_SOURCE_DIR}/context.c
        ${CMAKE_CURRENT_SOURCE_DIR}/vm_core.c
        ${CMAKE_CURRENT_SOURCE_DIR}/ext_lifecycle.c
        ${CMAKE_CURRENT_SOURCE_DIR}/guest_entry.c)
    # QZ_WITH_* 全 0：内核不引任何扩展符号（qz_default_exts 全 NULL 槽）。
    # QZ_VM_GUEST 下发条件编译；QZ_EXTENSIONS 留默认（QZ_EXT_IF_WITH 解析为
    # NULL 占位，不引用未编入的扩展符号）。
    target_compile_definitions(qzvm-guest PRIVATE
        QZ_VM_GUEST
        QZ_WITH_WAMR=0 QZ_WITH_WASM3=0
        QZ_WITH_COMPRESS=0 QZ_WITH_CRYPTO_EXT=0 QZ_WITH_TEXTCODEC=0
        QZ_WITH_TLS=0 QZ_WITH_NONUTF_ENCODINGS=0
        QZ_POLYFILL_MODE=0)
    # include 根：src/（"base/qz_rt.h"）、include/（"qzjs/..."）、
    # deps/quickjs-ng（<quickjs.h>）。QUICKJS_DIR 顶层 add_subdirectory 前设。
    target_include_directories(qzvm-guest PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/..
        ${CMAKE_CURRENT_SOURCE_DIR}/../../include
        ${QUICKJS_DIR})
    target_link_libraries(qzvm-guest PRIVATE qjs)
    # reactor：-mexec-model=reactor 让 clang 驱动用 crt1-reactor.o（无 main），
    # 免 libc.a __main_argc_argv 的 main 引用（command 模式会要 main）。
    # 导出 qz_create/eval/tick/destroy 经 guest_entry.c 的
    # __attribute__((export_name)) 自动导出，不用 --export（它按 C 符号名找，
    # 会找不到 qz_guest_*）。memory/malloc/free 需显式 --export：宿主读写
    # guest 内存 + 分配脚本串（§10.3 ptr+len 传字节）。
    # 命名 libqzvm.wasm（reactor 的 wasm 产物设计名，§6）。
    set_target_properties(qzvm-guest PROPERTIES
        OUTPUT_NAME qzvm
        SUFFIX ".wasm"
        PREFIX "lib")
    target_link_options(qzvm-guest PRIVATE
        -mexec-model=reactor
        -Wl,--export=malloc -Wl,--export=free)
endif()
