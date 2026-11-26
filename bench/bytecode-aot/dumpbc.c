// 用 quickjs-ng 的 ENABLE_DUMPS（debug 构建）导出函数字节码 opcode + PC2LINE。
// 只用于实验取证；不进产品构建。
//   gcc -I deps/quickjs-ng -o dumpbc dumpbc.c \
//       build-dbg/deps/quickjs-ng/libqjs-libc.a build-dbg/deps/quickjs-ng/libqjs.a -lm -ldl -lpthread
//   ./dumpbc work.js > work.dump
#include <stdio.h>
#include <stdlib.h>
#include "quickjs.h"
#include "quickjs-libc.h"

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    FILE *f = fopen(argv[1], "rb");
    if (!f) return 3;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *src = malloc((size_t)n + 1);
    fread(src, 1, (size_t)n, f);
    src[n] = 0;
    fclose(f);

    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt);
    JS_SetDumpFlags(rt, JS_DUMP_BYTECODE_FINAL | JS_DUMP_BYTECODE_PC2LINE);
    JSValue ret = JS_Eval(ctx, src, (size_t)n, "<dump>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(ret)) { js_std_dump_error(ctx); return 5; }
    JS_FreeValue(ctx, ret);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    free(src);
    return 0;
}
