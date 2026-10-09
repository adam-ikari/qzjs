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
if(NOT QZ_WITH_WAMR AND NOT QZ_WITH_WASM3)
    message(FATAL_ERROR
        "wasm engine required (AOT key): QZ_WITH_WAMR or QZ_WITH_WASM3 must be ON. "
        "WebAssembly runtime is the execution backend for the AOT toolchain — "
        "it cannot be disabled. Enable exactly one:\n"
        "  wamr  (default): -DQZ_WITH_WAMR=ON\n"
        "  wasm3:            -DQZ_WITH_WASM3=ON -DQZ_WITH_WAMR=OFF")
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
