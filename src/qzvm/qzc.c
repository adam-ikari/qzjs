/*
 * qzc — qzjs bytecode compiler（独立编译工具）
 *
 * 把 JS 源码编译为 qzjs 可加载的字节码文件（qz_compile 的 CLI 形态）。
 * 产物由 `qzjs --bytecode <file>`（或 qz_config_t.initial_bytecode）运行。
 *
 * ⚠ 字节码与本次 qzc/qzjs 构建强绑定（引擎版本 + BC_VERSION + 校验和），
 * 跨版本不保证可加载——运行时会显式拒绝（SyntaxError: invalid version /
 * checksum error），绝不静默回退源码。分发请带源码、部署环境重编译。
 */

#include <qzjs/qzjs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void usage(FILE *out) {
    fprintf(out,
        "Usage: qzc <in.js> [-o <out.bc>]\n"
        "\n"
        "Compiles JS source to qzjs bytecode. The output runs via\n"
        "  qzjs --bytecode <out.bc>\n"
        "or qz_config_t.initial_bytecode. Bytecode is bound to this exact\n"
        "qzjs build and is NOT portable across versions — the runtime\n"
        "rejects incompatible blobs explicitly. Distribute source; compile\n"
        "at deploy time on the target build.\n");
}

int main(int argc, char **argv) {
    const char *in_path = NULL;
    const char *out_path = NULL;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-h") || !strcmp(argv[i], "--help")) {
            usage(stdout);
            return 0;
        }
        if (!strcmp(argv[i], "-o")) {
            if (i + 1 >= argc) { usage(stderr); return 2; }
            out_path = argv[++i];
            continue;
        }
        if (argv[i][0] == '-') { usage(stderr); return 2; }
        if (in_path) { usage(stderr); return 2; }
        in_path = argv[i];
    }
    if (!in_path) { usage(stderr); return 2; }

    FILE *f = fopen(in_path, "rb");
    if (!f) { fprintf(stderr, "qzc: cannot open '%s'\n", in_path); return 1; }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0) { fprintf(stderr, "qzc: cannot size '%s'\n", in_path); fclose(f); return 1; }
    char *src = malloc((size_t)sz);
    if (!src) { fprintf(stderr, "qzc: out of memory\n"); fclose(f); return 1; }
    if (fread(src, 1, (size_t)sz, f) != (size_t)sz) {
        fprintf(stderr, "qzc: read error '%s'\n", in_path);
        fclose(f); free(src); return 1;
    }
    fclose(f);

    char *err = NULL;
    uint8_t *bc = NULL;
    size_t bc_len = 0;
    int rc = qz_compile(src, (size_t)sz, in_path, &bc, &bc_len, &err);
    free(src);
    if (rc != 0) {
        fprintf(stderr, "qzc: compile failed: %s\n", err ? err : "?");
        free(err);
        return 1;
    }

    char defout[strlen(in_path) + 8];
    if (!out_path) {
        snprintf(defout, sizeof defout, "%s.bc", in_path);
        out_path = defout;
    }
    FILE *o = fopen(out_path, "wb");
    if (!o) { fprintf(stderr, "qzc: cannot write '%s'\n", out_path); free(bc); return 1; }
    if (fwrite(bc, 1, bc_len, o) != bc_len) {
        fprintf(stderr, "qzc: write error '%s'\n", out_path);
        fclose(o); free(bc); return 1;
    }
    fclose(o);
    free(bc);
    printf("%s\n", out_path);
    return 0;
}
