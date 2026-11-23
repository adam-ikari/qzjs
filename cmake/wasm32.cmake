# wasm32-wasi 工具链（in-module guest 构建，IN_MODULE_DESIGN.md §8）
#
# 用法：
#   cmake -S . -B build-inmod -DQZ_PROFILE=in-module \
#     -DCMAKE_TOOLCHAIN_FILE=cmake/wasm32.cmake
#   cmake --build build-inmod --target qzvm-guest
#
# 选型（§9）：wasi-sdk 风格——clang -target wasm32-wasi + wasi-libc（freestanding，
# 贴合 guest 自包含），而非 emscripten。本机布局为 Debian/Ubuntu 的 wasi-libc
# 包（sysroot=/usr，头文件在 /usr/include/wasm32-wasi，库在 /usr/lib/wasm32-wasi）。
# 若装有官方 wasi-sdk，覆写 -DWASI_SYSROOT=/path/to/wasi-sysroot 即可。

set(CMAKE_SYSTEM_NAME      WASI)
set(CMAKE_SYSTEM_PROCESSOR wasm32)

# 工具链前缀（wasi-sdk 提供 wasm32-wasi-clang；Debian wasi-libc 用系统 clang + -target）
find_program(QZ_WASM32_CLANG NAMES clang)
find_program(QZ_WASM32_AR    NAMES llvm-ar llvm-ar-14 ar)
find_program(QZ_WASM32_RANLIB NAMES llvm-ranlib llvm-ranlib-14 ranlib)

if(NOT QZ_WASM32_CLANG)
    message(FATAL_ERROR "wasm32 工具链：找不到 clang。装 wasi-sdk 或 clang + wasi-libc。")
endif()

# sysroot 探测：显式 -DWASI_SYSROOT > wasi-sdk 默认布局 > Debian wasi-libc(/usr)
set(WASI_SYSROOT "" CACHE PATH "WASI sysroot (默认自动探测)")
if(NOT WASI_SYSROOT)
    foreach(_cand /usr "$ENV{WASI_SDK_PATH}/share/wasi-sysroot")
        if(_cand AND EXISTS "${_cand}/include/wasm32-wasi" AND EXISTS "${_cand}/lib/wasm32-wasi")
            set(WASI_SYSROOT "${_cand}")
            break()
        endif()
    endforeach()
endif()
if(NOT WASI_SYSROOT)
    message(FATAL_ERROR
        "wasm32 工具链：找不到 WASI sysroot（含 include|lib/wasm32-wasi）。\n"
        "装 wasi-libc（Debian: apt-get install wasi-libc）或 wasi-sdk，"
        "或用 -DWASI_SYSROOT=<path> 指定。")
endif()

set(_qz_wasm32_flags "-target wasm32-wasi --sysroot=${WASI_SYSROOT}")

set(CMAKE_C_COMPILER   "${QZ_WASM32_CLANG}")
set(CMAKE_CXX_COMPILER "${QZ_WASM32_CLANG}")
set(CMAKE_AR           "${QZ_WASM32_AR}")
set(CMAKE_RANLIB       "${QZ_WASM32_RANLIB}")

# freestanding 风格：不隐式链默认启动/库（guest 是 reactor，host 驱动 export）。
# 链接期由 target 显式给 libc + 出口符号（见 qzvm-guest link flags）。
set(CMAKE_C_FLAGS_INIT   "${_qz_wasm32_flags}")
set(CMAKE_CXX_FLAGS_INIT "${_qz_wasm32_flags}")

# Wasm 目标可执行文件后缀沿用 .wasm（链接产物名由 target 的 OUTPUT_NAME 定）。
set(CMAKE_EXECUTABLE_SUFFIX ".wasm")

set(CMAKE_FIND_ROOT_PATH "${WASI_SYSROOT}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

# freestanding 风格：不隐式链默认库。Debian 的 wasi-libc 不带 libgcc，clang 驱动
# 默认会给 wasm-ld 传 -lgcc → 链接失败（本代码不需要软件 builtin：i64 除法等由
# wasm 原生指令直接生成）。故链接期绕过默认库（-nodefaultlibs），显式链 libc/libm；
# 启动/入口由 target 自定（guest 是 reactor：--no-entry + 显式 export）。
set(CMAKE_EXE_LINKER_FLAGS_INIT "-nodefaultlibs")
set(CMAKE_C_STANDARD_LIBRARIES   "-lc -lm")
set(CMAKE_CXX_STANDARD_LIBRARIES "-lc -lm")
