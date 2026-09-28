cmake_minimum_required(VERSION 3.14)
project(qz_worker C)

add_executable(qz_worker main.c)
target_link_libraries(qz_worker PRIVATE qz_full)
target_include_directories(qz_worker PRIVATE ${CMAKE_SOURCE_DIR}/include)
# ISOLATED 示例 #include <uv.h>（宿主注入 loop），需 POSIX 宏暴露 pthread_rwlock_t
target_compile_definitions(qz_worker PRIVATE _POSIX_C_SOURCE=200809L)

# worker.js 绝对路径（file:// URL 用），编译期注入
add_compile_definitions(
    QZ_WORKER_SCRIPT="file://${CMAKE_CURRENT_SOURCE_DIR}/worker.js"
)
