#!/bin/sh
# in-module 跨界 ABI 原型一键验证（对应 IN_MODULE_DESIGN.md §10）
#
# 依赖：wat2wasm (wabt)、cc、项目 build/deps/wamr/libiwasm.a
# 用法：sh src/qzvm/aot/inmod-abi-proto/build.sh
set -e
here=$(dirname "$0")
root=$(cd "$here/../../../.." && pwd)

cd "$here"
wat2wasm guest.wat -o guest.wasm
wasm-validate guest.wasm

INC="-I$root/deps/wamr/core/iwasm/include \
     -I$root/deps/wamr/core/shared/platform/include \
     -I$root/deps/wamr/core/shared/utils \
     -I$root/deps/wamr/core/shared/mem-alloc \
     -I$root/deps/wamr/core/config"
cc host.c -o host $INC "$root/build/deps/wamr/libiwasm.a" -lpthread -lm

./host guest.wasm
