#!/bin/sh
# in-module 跨界 ABI 原型一键验证（对应 IN_MODULE_DESIGN.md §10）
#
# 依赖：wat2wasm (wabt)、cc、项目 build/deps/wamr/libiwasm.a
# 用法：sh src/qzvm/aot/inmod-abi-proto/build.sh
set -e
here=$(dirname "$0")
root=$(cd "$here/../../../.." && pwd)

INC="-I$root/deps/wamr/core/iwasm/include \
     -I$root/deps/wamr/core/shared/platform/include \
     -I$root/deps/wamr/core/shared/utils \
     -I$root/deps/wamr/core/shared/mem-alloc \
     -I$root/deps/wamr/core/config"
WAMR="$root/build/deps/wamr/libiwasm.a"

cd "$here"

echo "########## A. 同步 + 回流写回（§10.3 / §10.4 骨架） ##########"
wat2wasm guest.wat -o guest.wasm
wasm-validate guest.wasm
cc host.c -o host $INC "$WAMR" -lpthread -lm
./host guest.wasm

echo
echo "########## B. 异步回流（§10.4 import 拉模型） ##########"
printf 'async payload from file\n' > guest.txt
wat2wasm guest_async.wat -o guest_async.wasm
wasm-validate guest_async.wasm
cc host_async.c -o host_async $INC "$WAMR" -lpthread -lm
./host_async guest_async.wasm
