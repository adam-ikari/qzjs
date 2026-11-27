// 把 TS 标注 side table 注入 qzjs 字节码函数并验证往返（实验/构建期工具）。
//   annotate <in.bytecode> <funcName> <annot.txt> <out.bytecode>
// 依赖 quickjs-ng 的 qzjs AOT 补丁（JS_SetFunctionAnnotation / JS_GetFunctionAnnotation）。
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"
#include "quickjs-libc.h"

static uint8_t *slurp(const char *path, size_t *plen) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *b = malloc((size_t)n + 1);
    if (fread(b, 1, (size_t)n, f) != (size_t)n) { fclose(f); free(b); return NULL; }
    fclose(f); b[n] = 0; *plen = (size_t)n; return b;
}

int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "--print") == 0) {
        size_t clen;
        uint8_t *code = slurp(argv[2], &clen);
        if (!code) return 3;
        JSRuntime *rt = JS_NewRuntime();
        JSContext *ctx = JS_NewContext(rt);
        JSValue v = JS_ReadObject(ctx, code, clen, JS_READ_OBJ_BYTECODE);
        if (JS_IsException(v)) { js_std_dump_error(ctx); return 4; }
        size_t len = 0;
        const uint8_t *a = JS_GetFunctionAnnotation(ctx, v, &len);
        if (a && len) fwrite(a, 1, len, stdout);
        JS_FreeValue(ctx, v);
        JS_FreeContext(ctx); JS_FreeRuntime(rt); free(code);
        return a && len ? 0 : 5;
    }
    if (argc != 5) return 2;
    size_t clen, alen;
    uint8_t *code = slurp(argv[1], &clen);
    uint8_t *annot = slurp(argv[3], &alen);
    if (!code || !annot) return 3;

    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt);
    JSValue v = JS_ReadObject(ctx, code, clen, JS_READ_OBJ_BYTECODE);
    if (JS_IsException(v)) { js_std_dump_error(ctx); return 4; }
    JSValue r = JS_EvalFunction(ctx, v);
    if (JS_IsException(r)) { js_std_dump_error(ctx); return 5; }
    JS_FreeValue(ctx, r);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, global, argv[2]);
    JS_FreeValue(ctx, global);
    if (!JS_IsFunction(ctx, fn)) { printf("function not found: %s\n", argv[2]); return 6; }

    if (JS_SetFunctionAnnotation(ctx, fn, annot, alen) != 0) return 7;

    JSValue bcv = JS_GetFunctionBytecodeValue(ctx, fn);
    if (JS_IsException(bcv)) return 12;
    size_t olen;
    uint8_t *out = JS_WriteObject(ctx, &olen, bcv, JS_WRITE_OBJ_BYTECODE);
    if (!out) { js_std_dump_error(ctx); return 8; }
    FILE *of = fopen(argv[4], "wb");
    if (!of) return 9;
    fwrite(out, 1, olen, of);
    fclose(of);
    JS_FreeValue(ctx, fn);
    js_free(ctx, out);

    // round-trip check: reload and read annotation back
    uint8_t *again = slurp(argv[4], &olen);
    JSValue v2 = JS_ReadObject(ctx, again, olen, JS_READ_OBJ_BYTECODE);
    if (JS_IsException(v2)) { js_std_dump_error(ctx); return 10; }
    size_t got_len = 0;
    const uint8_t *got = JS_GetFunctionAnnotation(ctx, v2, &got_len);
    if (!got || got_len != alen || memcmp(got, annot, alen) != 0) {
        printf("ROUNDTRIP FAIL: got_len=%zu expected=%zu\n", got_len, alen);
        return 11;
    }
    printf("ROUNDTRIP OK: %s annotation %zu bytes, bytecode %zu bytes\n", argv[2], got_len, olen);
    JS_FreeValue(ctx, v2);
    free(again); free(code); free(annot);
    JS_FreeContext(ctx); JS_FreeRuntime(rt);
    return 0;
}
