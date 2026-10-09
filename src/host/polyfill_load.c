/*
 * qzjs Polyfill Bytecode Loader (mode: rodata | compressed | external | host)
 *
 * Provides the unified interface qz_polyfill_load / qz_polyfill_unload.
 * Which storage backend is used depends on the compile-time macro
 * QZ_POLYFILL_MODE (set by CMake's -DQZ_POLYFILL_MODE=<mode>).
 *
 *   rodata (default)   — const array in .rodata, no heap allocation.
 *   compressed         — lz4-block-compressed array in .rodata, decompressed
 *                        to heap at load (raw LZ4 block via LZ4_decompress_safe;
 *                        build.js produces the block via cmake target
 *                        qz_lz4_compress — same vendored lz4, same format).
 *   external           — external .polyfill file read into heap at load.
 *   host               — delegates to the weak qz_polyfill_load_custom().
 */

#include "base/qz_rt.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#if QZ_POLYFILL_MODE == QZ_POLYFILL_MODE_COMPRESSED
# include "lz4.h"
#endif

/* ================================================================
 * Mode C — const array in .rodata (default)
 * ================================================================ */
#if QZ_POLYFILL_MODE == QZ_POLYFILL_MODE_RODATA

int qz_polyfill_load(const uint8_t **out, size_t *out_len, void **owner)
{
    *out    = qz_default_polyfill;
    *out_len = qz_default_polyfill_len;
    *owner  = NULL;
    return 0;
}

void qz_polyfill_unload(void *owner)
{
    (void)owner;  /* mode C: no heap allocation, nothing to free */
}

/* ================================================================
 * compressed — lz4-block-compressed array → heap decompress
 * ================================================================ */
#elif QZ_POLYFILL_MODE == QZ_POLYFILL_MODE_COMPRESSED

int qz_polyfill_load(const uint8_t **out, size_t *out_len, void **owner)
{
    uint8_t *decomp = malloc(qz_default_polyfill_orig_len);
    if (!decomp) {
        fprintf(stderr, "[qzjs] polyfill: lz4 decompress OOM (%zu bytes)\n",
                qz_default_polyfill_orig_len);
        return QZ_ERR_NO_MEMORY;
    }
    int rc = LZ4_decompress_safe((const char *)qz_default_polyfill_compressed,
                                 (char *)decomp,
                                 (int)qz_default_polyfill_compressed_len,
                                 (int)qz_default_polyfill_orig_len);
    if (rc < 0 || (size_t)rc != qz_default_polyfill_orig_len) {
        free(decomp);
        fprintf(stderr, "[qzjs] polyfill: lz4 decompression failed "
                "(rc=%d, compressed %zu, expected %zu)\n",
                rc, qz_default_polyfill_compressed_len,
                qz_default_polyfill_orig_len);
        return QZ_ERR_GENERIC;
    }
    *out    = (const uint8_t *)decomp;
    *out_len = qz_default_polyfill_orig_len;
    *owner  = decomp;
    return 0;
}

void qz_polyfill_unload(void *owner)
{
    free(owner);
}

/* ================================================================
 * Mode B — external .polyfill file
 * ================================================================ */
#elif QZ_POLYFILL_MODE == QZ_POLYFILL_MODE_EXTERNAL

/*
 * File path resolution (first match wins):
 *   1. QZ_POLYFILL_FILE  environment variable
 *   2. QZ_POLYFILL_FILE  compile-time macro (if defined)
 *   3. error — no path available
 */
static const char *polyfill_file_path(void)
{
    const char *env = getenv("QZ_POLYFILL_FILE");
    if (env && env[0]) return env;
#ifdef QZ_POLYFILL_FILE
    return QZ_POLYFILL_FILE;
#else
    return NULL;
#endif
}

/* ── Minimal SHA-256 (FIPS 180-4) ──────────────────────────────────
 * Self-contained C99, no allocation, compiled only in external mode (the
 * other modes embed their bytecode and need no integrity check).
 * Used to verify the on-disk bytecode against the digest that polyfill/
 * build.js embedded into this binary. */
static uint32_t sha256_rotr(uint32_t x, unsigned n)
{
    return (x >> n) | (x << (32 - n));
}

static void sha256_compress(uint32_t h[8], const uint8_t *p)
{
    static const uint32_t K[64] = {
        0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
        0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
        0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
        0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
        0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
        0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
        0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
        0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
    };
    uint32_t w[64], a, b, c, d, e, f, g, hh;
    int i;

    for (i = 0; i < 16; i++)
        w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
               ((uint32_t)p[i * 4 + 2] << 8) | (uint32_t)p[i * 4 + 3];
    for (i = 16; i < 64; i++) {
        uint32_t s0 = sha256_rotr(w[i - 15], 7) ^ sha256_rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = sha256_rotr(w[i - 2], 17) ^ sha256_rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }

    a = h[0]; b = h[1]; c = h[2]; d = h[3];
    e = h[4]; f = h[5]; g = h[6]; hh = h[7];
    for (i = 0; i < 64; i++) {
        uint32_t S1 = sha256_rotr(e, 6) ^ sha256_rotr(e, 11) ^ sha256_rotr(e, 25);
        uint32_t ch = (e & f) ^ (~e & g);
        uint32_t t1 = hh + S1 + ch + K[i] + w[i];
        uint32_t S0 = sha256_rotr(a, 2) ^ sha256_rotr(a, 13) ^ sha256_rotr(a, 22);
        uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t t2 = S0 + maj;
        hh = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }

    h[0] += a; h[1] += b; h[2] += c; h[3] += d;
    h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}

static void sha256(const uint8_t *data, size_t len, uint8_t out[32])
{
    uint32_t h[8] = { 0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                      0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u };
    uint8_t tail[128];
    uint64_t bits = (uint64_t)len * 8u;
    size_t i = 0, rem, tail_len;
    int k;

    for (; i + 64 <= len; i += 64)
        sha256_compress(h, data + i);

    rem = len - i;
    memset(tail, 0, sizeof tail);
    memcpy(tail, data + i, rem);
    tail[rem] = 0x80;
    tail_len = (rem < 56) ? 64 : 128;
    for (k = 0; k < 8; k++)
        tail[tail_len - 1 - k] = (uint8_t)(bits >> (8 * k));
    for (i = 0; i < tail_len; i += 64)
        sha256_compress(h, tail + i);

    for (k = 0; k < 8; k++) {
        out[k * 4]     = (uint8_t)(h[k] >> 24);
        out[k * 4 + 1] = (uint8_t)(h[k] >> 16);
        out[k * 4 + 2] = (uint8_t)(h[k] >> 8);
        out[k * 4 + 3] = (uint8_t)(h[k]);
    }
}

static void sha256_hex(const uint8_t digest[32], char out[65])
{
    static const char hex[] = "0123456789abcdef";
    int i;
    for (i = 0; i < 32; i++) {
        out[i * 2]     = hex[digest[i] >> 4];
        out[i * 2 + 1] = hex[digest[i] & 0xf];
    }
    out[64] = '\0';
}

int qz_polyfill_load(const uint8_t **out, size_t *out_len, void **owner)
{
    const char *path = polyfill_file_path();
    if (!path || !path[0]) {
        fprintf(stderr, "[qzjs] polyfill: QZ_POLYFILL_FILE not set "
                "(define the macro or set the environment variable)\n");
        return QZ_ERR_NOT_FOUND;
    }

    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stderr, "[qzjs] polyfill: cannot open %s: %s\n",
                path, strerror(errno));
        return QZ_ERR_NOT_FOUND;
    }

    /* Get file size */
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        fprintf(stderr, "[qzjs] polyfill: fseek failed on %s\n", path);
        return QZ_ERR_IO;
    }
    long file_size = ftell(f);
    if (file_size < 0) {
        fclose(f);
        fprintf(stderr, "[qzjs] polyfill: ftell failed on %s\n", path);
        return QZ_ERR_IO;
    }
    rewind(f);

    /* Allocate buffer */
    size_t sz = (size_t)file_size;
    uint8_t *buf = (uint8_t *)malloc(sz);
    if (!buf) {
        fclose(f);
        return QZ_ERR_NO_MEMORY;
    }

    /* Read contents */
    size_t nread = fread(buf, 1, sz, f);
    fclose(f);
    if (nread != sz) {
        free(buf);
        fprintf(stderr, "[qzjs] polyfill: short read from %s "
                "(%zu != %zu)\n", path, nread, sz);
        return QZ_ERR_IO;
    }

    /* Integrity check — defense in depth against post-deployment tampering.
     * polyfill/build.js embeds, at build time, the SHA-256 of the official
     * external polyfill bytecode it wrote to dist/polyfill_default.polyfill;
     * any other file (tampered, replaced, or a foreign build) is refused
     * before it can reach JS_ReadObject(). Note: a writer of this file is
     * usually already able to rewrite the binary, so this is not a trust
     * boundary — it only catches a modified/replaced data file. */
    {
        uint8_t digest[32];
        char expected_hex[65], actual_hex[65];
        sha256(buf, sz, digest);
        if (memcmp(digest, qz_polyfill_external_sha256, 32) != 0) {
            sha256_hex(qz_polyfill_external_sha256, expected_hex);
            sha256_hex(digest, actual_hex);
            fprintf(stderr, "[qzjs] polyfill: SHA-256 mismatch for %s\n"
                    "  expected: %s\n"
                    "  actual:   %s\n"
                    "  refusing to load bytecode, it is not the file this "
                    "binary was built with\n", path, expected_hex, actual_hex);
            free(buf);
            return QZ_ERR_PERMISSION;
        }
    }

    *out    = buf;
    *out_len = sz;
    *owner  = buf;
    return 0;
}

void qz_polyfill_unload(void *owner)
{
    free(owner);
}

/* ================================================================
 * Mode D — host-provided custom hook (weak symbols)
 * ================================================================ */
#else /* QZ_POLYFILL_MODE_HOST */

__attribute__((weak))
int qz_polyfill_load_custom(const uint8_t **out, size_t *out_len, void **owner)
{
    (void)out; (void)out_len; (void)owner;
    fprintf(stderr, "[qzjs] polyfill: mode D but qz_polyfill_load_custom "
            "is not defined by the host\n");
    return QZ_ERR_NOT_SUPPORTED;
}

__attribute__((weak))
void qz_polyfill_unload_custom(void *owner)
{
    (void)owner;
}

int qz_polyfill_load(const uint8_t **out, size_t *out_len, void **owner)
{
    return qz_polyfill_load_custom(out, out_len, owner);
}

void qz_polyfill_unload(void *owner)
{
    qz_polyfill_unload_custom(owner);
}

#endif
