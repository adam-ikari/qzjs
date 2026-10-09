/* lz4_compress_main.c — build-time helper: raw-LZ4-block compress stdin→stdout.
 *
 * Used by polyfill/build.js in QZ_POLYFILL_MODE=compressed to produce the
 * payload that src/host/polyfill_load.c decodes with LZ4_decompress_safe().
 * Raw block (no frame format) keeps the C decoder to one call.
 *
 * Usage: qz_lz4_compress < level > level.lz4
 * Exit 0 on success, 1 on failure. No output on stdout except the block.
 */
#include "lz4.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv)
{
    (void)argc; (void)argv;
    /* read all of stdin */
    size_t cap = 1 << 20, len = 0;
    uint8_t *src = malloc(cap);
    if (!src) return 1;
    for (;;) {
        if (len == cap) {
            cap *= 2;
            uint8_t *ns = realloc(src, cap);
            if (!ns) { free(src); return 1; }
            src = ns;
        }
        size_t n = fread(src + len, 1, cap - len, stdin);
        len += n;
        if (n == 0) break;
    }
    if (ferror(stdin)) { free(src); return 1; }
    if (len == 0 || len > LZ4_MAX_INPUT_SIZE) {
        fprintf(stderr, "qz_lz4_compress: input size %zu (max %d)\n",
                len, (int)LZ4_MAX_INPUT_SIZE);
        free(src);
        return 1;
    }
    int bound = LZ4_compressBound((int)len);
    char *dst = malloc((size_t)bound);
    if (!dst) { free(src); return 1; }
    int clen = LZ4_compress_default((const char *)src, dst, (int)len, bound);
    free(src);
    if (clen <= 0) { free(dst); return 1; }
    if (fwrite(dst, 1, (size_t)clen, stdout) != (size_t)clen) { free(dst); return 1; }
    free(dst);
    return 0;
}
