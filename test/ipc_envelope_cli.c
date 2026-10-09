/*
 * ipc_envelope_cli — test helper for ipc_envelope_fbcheck.py (M-P0 gate:
 * C <-> Python flatbuffers wire cross-verification, design doc §11).
 *
 *   enc <source> <target> <kind> <payload_hex|""> [-]
 *       Encode; prints the canonical fb bytes as lowercase hex.
 *   dec <hex|-> [-]
 *       Decode; prints "<source> <target> <kind> <payload_hex>" on success
 *       (payload_hex may be empty), or "ERR <reason>" + exit 1 on rejection.
 *
 * A trailing "-" reads the hex argument from stdin (avoids E2BIG for
 * >100 KiB payload vectors in cross-verification case 3). Pure C99 +
 * ipc_envelope.c — no libuv, no qzjs.
 */
#include "ipc/ipc_envelope.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int hexval(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Read one whitespace-separated hex blob from stdin. Grows as needed;
 * returns a malloc'd buffer, sets *out_len. Exits 2 on bad hex. */
static uint8_t *read_stdin_hex(size_t *out_len)
{
    size_t cap = 4096, n = 0;
    uint8_t *buf = malloc(cap);
    if (!buf) return NULL;
    int c, hi = -1;
    while ((c = getchar()) != EOF) {
        if (c == '\n' || c == '\r' || c == ' ' || c == '\t') continue;
        int v = hexval(c);
        if (v < 0) exit(2);
        if (hi < 0) {
            hi = v;
        } else {
            if (n == cap && !(buf = realloc(buf, cap *= 2))) exit(2);
            buf[n++] = (uint8_t)((hi << 4) | v);
            hi = -1;
        }
    }
    if (hi >= 0) exit(2);   /* odd number of hex digits */
    *out_len = n;
    return buf;
}

static size_t hex_decode(const char *s, uint8_t *out, size_t cap)
{
    size_t n = strlen(s);
    if (n % 2 || n / 2 > cap) return (size_t)-1;
    for (size_t i = 0; i < n; i += 2) {
        int hi = hexval(s[i]), lo = hexval(s[i + 1]);
        if (hi < 0 || lo < 0) return (size_t)-1;
        out[i / 2] = (uint8_t)((hi << 4) | lo);
    }
    return n / 2;
}

static void print_hex(const uint8_t *p, size_t n)
{
    for (size_t i = 0; i < n; i++) printf("%02x", p[i]);
}

int main(int argc, char **argv)
{
    if (argc < 2) return 2;

    if (!strcmp(argv[1], "enc") && argc == 6) {
        int32_t source = (int32_t)strtol(argv[2], NULL, 10);
        int32_t target = (int32_t)strtol(argv[3], NULL, 10);
        int kind = (int)strtol(argv[4], NULL, 10);
        const char *phex = argv[5];
        size_t plen;
        uint8_t *payload;
        if (!strcmp(phex, "-")) {
            payload = read_stdin_hex(&plen);
        } else {
            plen = strlen(phex) / 2;
            payload = malloc(plen ? plen : 1);
            if (plen && hex_decode(phex, payload, plen) == (size_t)-1) {
                fprintf(stderr, "bad payload hex\n");
                free(payload);
                return 2;
            }
        }
        if (!payload) return 2;
        uint8_t *buf = malloc(IPC_ENVELOPE_ENCODED_SIZE(plen));
        if (!buf) { free(payload); return 2; }
        size_t n = ipc_envelope_encode(buf, IPC_ENVELOPE_ENCODED_SIZE(plen),
                                       source, target, (int8_t)kind,
                                       0 /* corr */,
                                       payload, (uint32_t)plen);
        if (!n) {
            fprintf(stderr, "encode failed\n");
            free(buf); free(payload);
            return 1;
        }
        print_hex(buf, n);
        printf("\n");
        free(buf); free(payload);
        return 0;
    }

    if (!strcmp(argv[1], "dec") && argc == 3) {
        size_t blen;
        uint8_t *buf;
        if (!strcmp(argv[2], "-")) {
            buf = read_stdin_hex(&blen);
        } else {
            blen = strlen(argv[2]) / 2;
            buf = malloc(blen ? blen : 1);
            if (blen && hex_decode(argv[2], buf, blen) == (size_t)-1) {
                printf("ERR bad hex\n");
                free(buf);
                return 1;
            }
        }
        if (!buf) return 2;
        ipc_envelope_view_t v;
        if (ipc_envelope_decode(buf, blen, &v) != 0) {
            printf("ERR rejected\n");
            free(buf);
            return 1;
        }
        printf("%" PRId32 " %" PRId32 " %d ", v.source, v.target, v.kind);
        print_hex(v.payload, v.payload_len);
        printf("\n");
        free(buf);
        return 0;
    }

    fprintf(stderr, "usage: %s enc <source> <target> <kind> <payload_hex|->\n"
                    "       %s dec <hex|->\n", argv[0], argv[0]);
    return 2;
}
