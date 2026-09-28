cmake_minimum_required(VERSION 3.14)
project(qz_messages C)

add_executable(qz_messages messages.c)
target_link_libraries(qz_messages PRIVATE qz_full)
target_include_directories(qz_messages PRIVATE ${CMAKE_SOURCE_DIR}/include)
# ISOLATED 示例 #include <uv.h>（宿主注入 loop），需 POSIX 宏暴露 pthread_rwlock_t
target_compile_definitions(qz_messages PRIVATE _POSIX_C_SOURCE=200809L)
