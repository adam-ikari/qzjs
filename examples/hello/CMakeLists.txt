cmake_minimum_required(VERSION 3.14)
project(qz_hello C)

add_executable(qz_hello hello.c)
target_link_libraries(qz_hello PRIVATE qz_full)
target_include_directories(qz_hello PRIVATE ${CMAKE_SOURCE_DIR}/include)
# ISOLATED 示例 #include <uv.h>（宿主注入 loop），需 POSIX 宏暴露 pthread_rwlock_t
target_compile_definitions(qz_hello PRIVATE _POSIX_C_SOURCE=200809L)
