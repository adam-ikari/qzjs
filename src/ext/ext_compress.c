/*
 * qzjs Compression Extension
 *
 * Native DEFLATE/gzip compression and decompression using miniz.
 * Registers pal.nativeCompress and pal.nativeDecompress on the JS pal object.
 *
 * Formats supported: "deflate-raw" (raw DEFLATE), "deflate" (zlib-wrapped),
 * "gzip" (gzip-wrapped with CRC32/ISIZE).
 *
 * miniz v3 only supports raw DEFLATE via its stream API (window_bits must
 * be ±15). We handle zlib/gzip wrapping manually:
 *   - zlib: 2-byte header + raw DEFLATE + 4-byte Adler-32 (from stream.adler)
 *   - gzip: 10-byte header + raw DEFLATE + CRC32 + ISIZE
 *
 * Optimizations:
 *   - Single allocation: deflate output written directly at the correct offset
 *     within the final buffer (no intermediate memcpy of compressed data)
 *   - stream.adler used for zlib Adler-32 (no separate input scan)
 *
 * When QZ_WITH_COMPRESS is not defined, the extension compiles but does
 * nothing — CompressionStream/DecompressionStream will throw
 * "Native compression extension not available".
 */

#include "base/qz_rt.h"

#if QZ_WITH_COMPRESS

#include <miniz.h>
#include <string.h>
#include <limits.h>

/* ================================================================
 * Format enum
 * ================================================================ */

enum compress_format {
    FORMAT_DEFLATE_RAW = 0,
    FORMAT_DEFLATE,
    FORMAT_GZIP,
};

static int parse_format(const char *format)
{
    if (strcmp(format, "deflate-raw") == 0) return FORMAT_DEFLATE_RAW;
    if (strcmp(format, "deflate") == 0) return FORMAT_DEFLATE;
    if (strcmp(format, "gzip") == 0) return FORMAT_GZIP;
    return -1;
}

/* ================================================================
 * Raw DEFLATE inflate (miniz stream API)
 *
 * Returns 0 on success, -1 on init/stream error, -2 on corrupt data,
 * -3 on out of memory.
 * ================================================================ */

static int raw_inflate(JSContext *ctx,
                       const uint8_t *in, size_t in_len,
                       uint8_t **out, size_t *out_len)
{
    mz_stream stream;
    memset(&stream, 0, sizeof(stream));

    /* Guard: mz_stream.avail_in is unsigned int (32-bit) */
    if (in_len > UINT_MAX) return -1;

    int ret = mz_inflateInit2(&stream, -MAX_WBITS);
    if (ret != MZ_OK) return -1;

    size_t out_size = in_len * 4;
    /* Overflow check for in_len * 4 */
    if (out_size / 4 != in_len || out_size < 256) out_size = 256;
    uint8_t *buf = (uint8_t *)js_malloc(ctx, out_size);
    if (!buf) {
        mz_inflateEnd(&stream);
        return -3;
    }

    stream.next_in = (const uint8_t *)in;
    stream.avail_in = (mz_uint)in_len;
    stream.next_out = buf;
    stream.avail_out = (mz_uint)out_size;

    size_t total = 0;
    int guard = 0;

    do {
        if (++guard > 100000) {
            /* Defensive cap: a pathological stream that keeps producing
             * output without ever reaching STREAM_END. */
            js_free(ctx, buf);
            mz_inflateEnd(&stream);
            return -2;
        }
        ret = mz_inflate(&stream, MZ_NO_FLUSH);
        if (ret == MZ_DATA_ERROR) {
            js_free(ctx, buf);
            mz_inflateEnd(&stream);
            return -2;
        }
        if (ret == MZ_STREAM_ERROR || ret == MZ_MEM_ERROR) {
            js_free(ctx, buf);
            mz_inflateEnd(&stream);
            return (ret == MZ_MEM_ERROR) ? -3 : -1;
        }
        if (ret == MZ_BUF_ERROR) {
            /* miniz returns MZ_BUF_ERROR when no forward progress is
             * possible — input exhausted before STREAM_END (truncated
             * stream) or the output buffer is full with nothing left to
             * emit. Without this branch the loop would spin forever. */
            js_free(ctx, buf);
            mz_inflateEnd(&stream);
            return (stream.avail_in == 0) ? -2 : -1;
        }

        total = out_size - stream.avail_out;

        if (ret != MZ_STREAM_END && stream.avail_out == 0) {
            size_t new_size = out_size * 2;
            uint8_t *new_buf = (uint8_t *)js_realloc(ctx, buf, new_size);
            if (!new_buf) {
                js_free(ctx, buf);
                mz_inflateEnd(&stream);
                return -3;
            }
            buf = new_buf;
            out_size = new_size;
            stream.next_out = buf + total;
            stream.avail_out = (mz_uint)(out_size - total);
        }
    } while (ret != MZ_STREAM_END);

    mz_inflateEnd(&stream);

    *out_len = total;
    if (total < out_size) {
        uint8_t *shrunk = (uint8_t *)js_realloc(ctx, buf, total);
        if (shrunk) buf = shrunk;
    }
    *out = buf;
    return 0;
}

/* crc32 由 miniz mz_crc32 提供 */



/* ================================================================
 * Header/trailer size constants
 * ================================================================ */

#define ZLIB_HEADER_SIZE  2
#define ZLIB_TRAILER_SIZE 4
#define GZIP_HEADER_SIZE  10
#define GZIP_TRAILER_SIZE 8
#define COMPRESS_SHRINK_THRESHOLD 64  /* only realloc if wasting more bytes */

/* ================================================================
 * pal.nativeCompress(data, format) -> Uint8Array
 *
 * Single-allocation path: allocate the full output buffer (header +
 * deflateBound + trailer), write deflate directly at the header offset,
 * then fill trailer. For deflate-raw, no header/trailer overhead.
 * ================================================================ */

static JSValue js_pal_native_compress(JSContext *ctx, JSValueConst this_val,
                                       int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "nativeCompress requires 2 arguments: data, format");
    }

    const uint8_t *in_bytes;
    size_t in_len;
    if (qz_js_extract_bytes(ctx, argv[0], &in_bytes, &in_len) < 0) {
        return JS_ThrowTypeError(ctx, "nativeCompress: data must be ArrayBuffer or Uint8Array");
    }

    /* Guard: mz_stream.avail_in is unsigned int (32-bit) */
    if (in_len > UINT_MAX) {
        return JS_ThrowRangeError(ctx, "nativeCompress: input too large (max 4GB)");
    }

    const char *format_str = JS_ToCString(ctx, argv[1]);
    if (!format_str) {
        return JS_ThrowTypeError(ctx, "nativeCompress: format must be a string");
    }

    int fmt = parse_format(format_str);
    JS_FreeCString(ctx, format_str);
    if (fmt < 0) {
        return JS_ThrowTypeError(ctx, "nativeCompress: unknown format (use deflate-raw, deflate, or gzip)");
    }

    /* Determine header/trailer sizes */
    size_t hdr_size = 0, trl_size = 0;
    if (fmt == FORMAT_DEFLATE) {
        hdr_size = ZLIB_HEADER_SIZE;
        trl_size = ZLIB_TRAILER_SIZE;
    } else if (fmt == FORMAT_GZIP) {
        hdr_size = GZIP_HEADER_SIZE;
        trl_size = GZIP_TRAILER_SIZE;
    }

    /* Initialize deflate to get deflateBound */
    mz_stream stream;
    memset(&stream, 0, sizeof(stream));

    int ret = mz_deflateInit2(&stream, MZ_DEFAULT_COMPRESSION, MZ_DEFLATED,
                               -MAX_WBITS, MAX_MEM_LEVEL, MZ_DEFAULT_STRATEGY);
    if (ret != MZ_OK) {
        return JS_ThrowInternalError(ctx, "nativeCompress: deflateInit2 failed");
    }

    /* in_len <= UINT_MAX guaranteed above, so (mz_ulong)cast is safe */
    size_t raw_bound = mz_deflateBound(&stream, (mz_ulong)in_len);
    /* Guard: stream.avail_out is unsigned int (32-bit) — a deflateBound
     * larger than UINT_MAX would be silently truncated by the (mz_uint)
     * cast when writing stream.avail_out below. */
    if (raw_bound > UINT_MAX) {
        mz_deflateEnd(&stream);
        return JS_ThrowRangeError(ctx, "nativeCompress: output too large (max 4GB)");
    }
    size_t buf_size = hdr_size + raw_bound + trl_size;

    uint8_t *buf = (uint8_t *)js_malloc(ctx, buf_size);
    if (!buf) {
        mz_deflateEnd(&stream);
        return JS_ThrowOutOfMemory(ctx);
    }

    /* Write header */
    if (fmt == FORMAT_DEFLATE) {
        buf[0] = 0x78;  /* CMF: CM=8=deflate, CINFO=7=32K window */
        buf[1] = 0x01;  /* FLG: FCHECK makes CMF*256+FLG divisible by 31 */
    } else if (fmt == FORMAT_GZIP) {
        buf[0] = 0x1F;  /* ID1 */
        buf[1] = 0x8B;  /* ID2 */
        buf[2] = 0x08;  /* CM = deflate */
        buf[3] = 0x00;  /* FLG = no extra fields */
        qz_wr32(buf + 4, 0);  /* MTIME = 0 */
        buf[8] = 0x00;  /* XFL */
        buf[9] = 0xFF;  /* OS = unknown */
    }

    /* Deflate directly into the buffer after the header */
    stream.next_in = (const uint8_t *)in_bytes;
    stream.avail_in = (mz_uint)in_len;
    stream.next_out = buf + hdr_size;
    stream.avail_out = (mz_uint)raw_bound;

    ret = mz_deflate(&stream, MZ_FINISH);

    if (ret != MZ_STREAM_END) {
        js_free(ctx, buf);
        mz_deflateEnd(&stream);
        return JS_ThrowInternalError(ctx, "nativeCompress: deflate failed");
    }

    size_t raw_len = raw_bound - stream.avail_out;
    mz_ulong adler = stream.adler;
    mz_deflateEnd(&stream);

    /* Write trailer */
    if (fmt == FORMAT_DEFLATE) {
        qz_wr32(buf + hdr_size + raw_len, (uint32_t)adler);
    } else {
        uint32_t crc = (uint32_t)mz_crc32(MZ_CRC32_INIT, in_bytes, in_len);
        qz_wr32(buf + hdr_size + raw_len, crc);
        qz_wr32(buf + hdr_size + raw_len + 4, (uint32_t)(in_len & 0xFFFFFFFFu));
    }

    size_t total_len = hdr_size + raw_len + trl_size;

    /* Shrink if significantly over-allocated */
    if (total_len < buf_size && buf_size - total_len > COMPRESS_SHRINK_THRESHOLD) {
        uint8_t *shrunk = (uint8_t *)js_realloc(ctx, buf, total_len);
        if (shrunk) buf = shrunk;
    }

    JSValue result = JS_NewUint8ArrayCopy(ctx, buf, total_len);
    js_free(ctx, buf);
    return result;
}

/* ================================================================
 * pal.nativeDecompress(data, format) -> Uint8Array
 * ================================================================ */

static JSValue js_pal_native_decompress(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "nativeDecompress requires 2 arguments: data, format");
    }

    const uint8_t *in_bytes;
    size_t in_len;
    if (qz_js_extract_bytes(ctx, argv[0], &in_bytes, &in_len) < 0) {
        return JS_ThrowTypeError(ctx, "nativeDecompress: data must be ArrayBuffer or Uint8Array");
    }

    /* Guard: mz_stream.avail_in is unsigned int (32-bit) */
    if (in_len > UINT_MAX) {
        return JS_ThrowRangeError(ctx, "nativeDecompress: input too large (max 4GB)");
    }

    const char *format_str = JS_ToCString(ctx, argv[1]);
    if (!format_str) {
        return JS_ThrowTypeError(ctx, "nativeDecompress: format must be a string");
    }

    int fmt = parse_format(format_str);
    JS_FreeCString(ctx, format_str);
    if (fmt < 0) {
        return JS_ThrowTypeError(ctx, "nativeDecompress: unknown format (use deflate-raw, deflate, or gzip)");
    }

    const uint8_t *raw_data;
    size_t raw_data_len;

    if (fmt == FORMAT_DEFLATE_RAW) {
        raw_data = in_bytes;
        raw_data_len = in_len;
    } else if (fmt == FORMAT_DEFLATE) {
        /* Validate and strip zlib header (2 bytes) and Adler-32 trailer (4 bytes) */
        if (in_len < 6) {
            return JS_ThrowTypeError(ctx, "nativeDecompress: invalid zlib data (too short)");
        }
        uint8_t cmf = in_bytes[0], flg = in_bytes[1];
        if ((cmf & 0x0F) != 8 || (cmf >> 4) > 7 || (cmf * 256 + flg) % 31 != 0) {
            return JS_ThrowTypeError(ctx, "nativeDecompress: invalid zlib header");
        }
        raw_data = in_bytes + 2;
        raw_data_len = in_len - 6;
    } else {
        /* Validate and strip gzip header and trailer */
        if (in_len < 18) {
            return JS_ThrowTypeError(ctx, "nativeDecompress: invalid gzip data (too short)");
        }
        if (in_bytes[0] != 0x1F || in_bytes[1] != 0x8B) {
            return JS_ThrowTypeError(ctx, "nativeDecompress: invalid gzip magic");
        }
        /* Parse header to find DEFLATE start */
        size_t offset = 10;
        uint8_t flg = in_bytes[3];

        if (flg & 0x04) {  /* FEXTRA */
            if (offset + 2 > in_len) return JS_ThrowTypeError(ctx, "nativeDecompress: truncated gzip extra");
            uint16_t xlen = qz_rd16(in_bytes + offset);
            if (offset + 2 + xlen > in_len) return JS_ThrowTypeError(ctx, "nativeDecompress: truncated gzip extra field");
            offset += 2 + xlen;
        }
        if (flg & 0x08) {  /* FNAME */
            while (offset < in_len && in_bytes[offset] != 0) offset++;
            if (offset >= in_len) return JS_ThrowTypeError(ctx, "nativeDecompress: unterminated FNAME in gzip header");
            offset++;  /* skip null terminator */
        }
        if (flg & 0x10) {  /* FCOMMENT */
            while (offset < in_len && in_bytes[offset] != 0) offset++;
            if (offset >= in_len) return JS_ThrowTypeError(ctx, "nativeDecompress: unterminated FCOMMENT in gzip header");
            offset++;
        }
        if (flg & 0x02) {  /* FHCRC */
            if (offset + 2 > in_len) return JS_ThrowTypeError(ctx, "nativeDecompress: truncated gzip HCRC");
            offset += 2;
        }

        if (offset + 8 > in_len) {
            return JS_ThrowTypeError(ctx, "nativeDecompress: truncated gzip data");
        }

        /* DEFLATE data is between header and 8-byte trailer (CRC32 + ISIZE) */
        raw_data = in_bytes + offset;
        raw_data_len = in_len - offset - 8;
    }

    /* Inflate raw DEFLATE */
    uint8_t *out = NULL;
    size_t out_len = 0;
    int inflate_ret = raw_inflate(ctx, raw_data, raw_data_len, &out, &out_len);
    if (inflate_ret < 0) {
        if (inflate_ret == -2)
            return JS_ThrowTypeError(ctx, "nativeDecompress: corrupt compressed data");
        if (inflate_ret == -3)
            return JS_ThrowOutOfMemory(ctx);
        return JS_ThrowInternalError(ctx, "nativeDecompress: inflate failed");
    }

    /* Verify checksums */
    if (fmt == FORMAT_DEFLATE) {
        uint32_t expected_adler = qz_rd32(in_bytes + in_len - 4);
        uint32_t actual_adler = (uint32_t)mz_adler32(1, out, out_len);
        if (actual_adler != expected_adler) {
            js_free(ctx, out);
            return JS_ThrowTypeError(ctx, "nativeDecompress: zlib Adler-32 checksum mismatch");
        }
    } else if (fmt == FORMAT_GZIP) {
        uint32_t expected_crc = qz_rd32(in_bytes + in_len - 8);
        uint32_t expected_size = qz_rd32(in_bytes + in_len - 4);
        if ((out_len & 0xFFFFFFFFu) != expected_size) {
            js_free(ctx, out);
            return JS_ThrowTypeError(ctx, "nativeDecompress: gzip ISIZE mismatch");
        }
        uint32_t actual_crc = (uint32_t)mz_crc32(MZ_CRC32_INIT, out, out_len);
        if (actual_crc != expected_crc) {
            js_free(ctx, out);
            return JS_ThrowTypeError(ctx, "nativeDecompress: gzip CRC32 checksum mismatch");
        }
    }

    JSValue result = JS_NewUint8ArrayCopy(ctx, out, out_len);
    js_free(ctx, out);
    return result;
}

/* ================================================================
 * pal.nativeBytesEqual(a, b) -> boolean
 *
 * Deterministic O(n) binary comparison via memcmp: true iff a and b
 * are byte-identical (same length, equal contents). Roundtrip tests
 * use it instead of a per-byte JS comparison loop, which under Debug
 * (unoptimized QuickJS bytecode interpreter) takes seconds for 1MB
 * payloads. Both arguments must be ArrayBuffer or Uint8Array.
 * ================================================================ */

static JSValue js_pal_native_bytes_equal(JSContext *ctx, JSValueConst this_val,
                                          int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "nativeBytesEqual requires 2 arguments: a, b");
    }

    const uint8_t *a_bytes, *b_bytes;
    size_t a_len, b_len;
    if (qz_js_extract_bytes(ctx, argv[0], &a_bytes, &a_len) < 0 ||
        qz_js_extract_bytes(ctx, argv[1], &b_bytes, &b_len) < 0) {
        return JS_ThrowTypeError(ctx, "nativeBytesEqual: arguments must be ArrayBuffer or Uint8Array");
    }

    return JS_NewBool(ctx, a_len == b_len &&
                            (a_len == 0 || memcmp(a_bytes, b_bytes, a_len) == 0));
}

/* ================================================================
 * Streaming DEFLATE / inflate contexts
 *
 * Raw-DEFLATE streams whose zlib state is retained across pushes —
 * used by the WebSocket permessage-deflate extension (RFC 7692),
 * which needs one shared deflate/inflate context per connection.
 * Exposed on pal as deflateCreate/deflatePush/deflateFree and
 * inflateCreate/inflatePush/inflateFree. Handles are JS objects that
 * own a mz_stream; the GC finalizer tears the stream down, so a
 * handle that goes out of scope cannot leak.
 * ================================================================ */

typedef struct {
    mz_stream strm;
    int inited;
    int finished;
} compress_stream_ctx;

static void compress_deflate_finalizer(JSRuntime *jsrt, JSValue val)
{
    qz_t *rt = qz_get_rt_from_jsrt(jsrt);
    if (!rt) return;
    compress_stream_ctx *c = JS_GetOpaque(val, rt->compress_deflate_class_id);
    if (c) {
        if (c->inited) mz_deflateEnd(&c->strm);
        js_free_rt(jsrt, c);
    }
}

static void compress_inflate_finalizer(JSRuntime *jsrt, JSValue val)
{
    qz_t *rt = qz_get_rt_from_jsrt(jsrt);
    if (!rt) return;
    compress_stream_ctx *c = JS_GetOpaque(val, rt->compress_inflate_class_id);
    if (c) {
        if (c->inited) mz_inflateEnd(&c->strm);
        js_free_rt(jsrt, c);
    }
}

static void compress_register_classes(qz_t *rt, JSContext *ctx)
{
    JSRuntime *jsrt = JS_GetRuntime(ctx);

    JS_NewClassID(jsrt, &rt->compress_deflate_class_id);
    JSClassDef deflate_class = {
        .class_name = "DeflateContext",
        .finalizer = compress_deflate_finalizer,
    };
    JS_NewClass(jsrt, rt->compress_deflate_class_id, &deflate_class);

    JS_NewClassID(jsrt, &rt->compress_inflate_class_id);
    JSClassDef inflate_class = {
        .class_name = "InflateContext",
        .finalizer = compress_inflate_finalizer,
    };
    JS_NewClass(jsrt, rt->compress_inflate_class_id, &inflate_class);
}

static int compress_get_handle(JSContext *ctx, JSValueConst val, JSClassID cid,
                               compress_stream_ctx **out)
{
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return -1;
    compress_stream_ctx *c = JS_GetOpaque(val, cid);
    if (!c || !c->inited) return -1;
    *out = c;
    return 0;
}

static JSValue js_pal_deflate_create(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    compress_stream_ctx *c = js_malloc(ctx, sizeof(*c));
    if (!c) return JS_ThrowOutOfMemory(ctx);
    memset(c, 0, sizeof(*c));
    int ret = mz_deflateInit2(&c->strm, MZ_DEFAULT_COMPRESSION, MZ_DEFLATED,
                              -MAX_WBITS, MAX_MEM_LEVEL, MZ_DEFAULT_STRATEGY);
    if (ret != MZ_OK) {
        js_free(ctx, c);
        return JS_ThrowInternalError(ctx, "deflateCreate: deflateInit2 failed");
    }
    c->inited = 1;
    JSValue obj = JS_NewObjectClass(ctx, rt->compress_deflate_class_id);
    if (JS_IsException(obj)) {
        mz_deflateEnd(&c->strm);
        js_free(ctx, c);
        return obj;
    }
    JS_SetOpaque(obj, c);
    return obj;
}

static JSValue js_pal_deflate_push(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    (void)this_val;
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    compress_stream_ctx *c = NULL;
    if (argc < 2 || compress_get_handle(ctx, argv[0], rt->compress_deflate_class_id, &c) < 0)
        return JS_ThrowTypeError(ctx, "deflatePush: invalid deflate handle");

    const uint8_t *in;
    size_t in_len;
    if (qz_js_extract_bytes(ctx, argv[1], &in, &in_len) < 0)
        return JS_ThrowTypeError(ctx, "deflatePush: data must be ArrayBuffer or Uint8Array");
    if (in_len > UINT_MAX)
        return JS_ThrowRangeError(ctx, "deflatePush: input too large (max 4GB)");

    int flush = MZ_NO_FLUSH;
    if (argc > 2 && !JS_IsUndefined(argv[2]) && JS_ToBool(ctx, argv[2]))
        flush = MZ_SYNC_FLUSH;

    c->strm.next_in = in;
    c->strm.avail_in = (mz_uint)in_len;

    size_t cap = in_len + in_len / 2 + 64;
    if (cap < 4096) cap = 4096;
    uint8_t *out = js_malloc(ctx, cap);
    if (!out) return JS_ThrowOutOfMemory(ctx);
    size_t out_len = 0;

    int guard = 0;
    for (;;) {
        if (++guard > 100000) {
            return JS_ThrowInternalError(ctx,
                "deflatePush: loop guard (in=%u out=%zu)", c->strm.avail_in, out_len);
        }
        if (out_len >= cap) {
            size_t ncap = cap * 2;
            uint8_t *nout = js_realloc(ctx, out, ncap);
            if (!nout) { js_free(ctx, out); return JS_ThrowOutOfMemory(ctx); }
            out = nout;
            cap = ncap;
        }
        c->strm.next_out = out + out_len;
        c->strm.avail_out = (mz_uint)(cap - out_len);
        size_t before_out = c->strm.avail_out;
        int ret = mz_deflate(&c->strm, flush);
        out_len += before_out - c->strm.avail_out;
        if (ret != MZ_OK && ret != MZ_STREAM_END) {
            js_free(ctx, out);
            return JS_ThrowInternalError(ctx, "deflatePush: deflate failed (%d)", ret);
        }
        if (ret == MZ_STREAM_END) break;
        /* MZ_SYNC_FLUSH: the flush output may span multiple calls when the
         * output buffer fills mid-flush, so breaking the moment avail_in hits
         * 0 would truncate the stream. But once a call leaves output space
         * (avail_out > 0) with all input consumed, the sync flush is fully
         * drained — calling again with no input would only emit empty
         * 00 00 ff ff blocks forever. MZ_NO_FLUSH buffers nothing more once
         * the input is consumed, so break immediately in that case. */
        if (c->strm.avail_in == 0 &&
            (flush == MZ_NO_FLUSH || c->strm.avail_out > 0))
            break;
    }
    JSValue result = JS_NewUint8ArrayCopy(ctx, out, out_len);
    js_free(ctx, out);
    return result;
}

static JSValue js_pal_deflate_free(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    (void)this_val;
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    if (argc < 1) return JS_UNDEFINED;
    compress_stream_ctx *c = JS_GetOpaque(argv[0], rt->compress_deflate_class_id);
    if (c) {
        if (c->inited) mz_deflateEnd(&c->strm);
        c->inited = 0;
        js_free(ctx, c);
        JS_SetOpaque(argv[0], NULL);
    }
    return JS_UNDEFINED;
}

static JSValue js_pal_inflate_create(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    compress_stream_ctx *c = js_malloc(ctx, sizeof(*c));
    if (!c) return JS_ThrowOutOfMemory(ctx);
    memset(c, 0, sizeof(*c));
    int ret = mz_inflateInit2(&c->strm, -MAX_WBITS);
    if (ret != MZ_OK) {
        js_free(ctx, c);
        return JS_ThrowInternalError(ctx, "inflateCreate: inflateInit2 failed");
    }
    c->inited = 1;
    JSValue obj = JS_NewObjectClass(ctx, rt->compress_inflate_class_id);
    if (JS_IsException(obj)) {
        mz_inflateEnd(&c->strm);
        js_free(ctx, c);
        return obj;
    }
    JS_SetOpaque(obj, c);
    return obj;
}

static JSValue js_pal_inflate_push(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    (void)this_val;
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    compress_stream_ctx *c = NULL;
    if (argc < 2 || compress_get_handle(ctx, argv[0], rt->compress_inflate_class_id, &c) < 0)
        return JS_ThrowTypeError(ctx, "inflatePush: invalid inflate handle");

    const uint8_t *in;
    size_t in_len;
    if (qz_js_extract_bytes(ctx, argv[1], &in, &in_len) < 0)
        return JS_ThrowTypeError(ctx, "inflatePush: data must be ArrayBuffer or Uint8Array");
    if (in_len > UINT_MAX)
        return JS_ThrowRangeError(ctx, "inflatePush: input too large (max 4GB)");

    c->strm.next_in = in;
    c->strm.avail_in = (mz_uint)in_len;

    size_t cap = in_len * 4 + 64;
    if (cap < 4096) cap = 4096;
    uint8_t *out = js_malloc(ctx, cap);
    if (!out) return JS_ThrowOutOfMemory(ctx);
    size_t out_len = 0;

    int guard = 0;
    for (;;) {
        if (++guard > 100000) {
            js_free(ctx, out);
            return JS_ThrowInternalError(ctx,
                "inflatePush: loop guard (in=%u out=%zu)", c->strm.avail_in, out_len);
        }
        if (out_len >= cap) {
            size_t ncap = cap * 2;
            uint8_t *nout = js_realloc(ctx, out, ncap);
            if (!nout) { js_free(ctx, out); return JS_ThrowOutOfMemory(ctx); }
            out = nout;
            cap = ncap;
        }
        c->strm.next_out = out + out_len;
        c->strm.avail_out = (mz_uint)(cap - out_len);
        size_t before_out = c->strm.avail_out;
        int ret = mz_inflate(&c->strm, MZ_NO_FLUSH);
        out_len += before_out - c->strm.avail_out;
        if (ret == MZ_STREAM_END) break;
        if (ret != MZ_OK) {
            if (ret == MZ_BUF_ERROR && c->strm.avail_in == 0)
                break;  /* needs more input — normal for streaming inflate */
            js_free(ctx, out);
            return JS_ThrowInternalError(ctx, "inflatePush: inflate failed (%d)", ret);
        }
        if (c->strm.avail_in == 0 && before_out == c->strm.avail_out)
            break;  /* all input consumed, no more output pending */
    }

    JSValue result = JS_NewUint8ArrayCopy(ctx, out, out_len);
    js_free(ctx, out);
    return result;
}

static JSValue js_pal_inflate_free(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    (void)this_val;
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_EXCEPTION;
    if (argc < 1) return JS_UNDEFINED;
    compress_stream_ctx *c = JS_GetOpaque(argv[0], rt->compress_inflate_class_id);
    if (c) {
        if (c->inited) mz_inflateEnd(&c->strm);
        c->inited = 0;
        js_free(ctx, c);
        JS_SetOpaque(argv[0], NULL);
    }
    return JS_UNDEFINED;
}

/* ================================================================
 * Extension hooks
 * ================================================================ */

static int compress_ext_init(qz_ext_t *ext, qz_t *rt)
{
    JSContext *ctx = qz_get_active_jsctx(rt);
    if (!ctx) return -1;

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue pal = JS_GetPropertyStr(ctx, global, "__native__");
    if (JS_IsUndefined(pal) || JS_IsException(pal)) {
        JS_FreeValue(ctx, pal);
        pal = JS_GetPropertyStr(ctx, global, "pal");
    }

    if (JS_IsUndefined(pal) || JS_IsException(pal)) {
        JS_FreeValue(ctx, pal);
        JS_FreeValue(ctx, global);
        return -1;
    }

    compress_register_classes(rt, ctx);

    JS_SetPropertyStr(ctx, pal, "nativeCompress",
        JS_NewCFunction(ctx, js_pal_native_compress, "nativeCompress", 2));
    JS_SetPropertyStr(ctx, pal, "nativeDecompress",
        JS_NewCFunction(ctx, js_pal_native_decompress, "nativeDecompress", 2));
    JS_SetPropertyStr(ctx, pal, "nativeBytesEqual",
        JS_NewCFunction(ctx, js_pal_native_bytes_equal, "nativeBytesEqual", 2));
    JS_SetPropertyStr(ctx, pal, "deflateCreate",
        JS_NewCFunction(ctx, js_pal_deflate_create, "deflateCreate", 0));
    JS_SetPropertyStr(ctx, pal, "deflatePush",
        JS_NewCFunction(ctx, js_pal_deflate_push, "deflatePush", 3));
    JS_SetPropertyStr(ctx, pal, "deflateFree",
        JS_NewCFunction(ctx, js_pal_deflate_free, "deflateFree", 1));
    JS_SetPropertyStr(ctx, pal, "inflateCreate",
        JS_NewCFunction(ctx, js_pal_inflate_create, "inflateCreate", 0));
    JS_SetPropertyStr(ctx, pal, "inflatePush",
        JS_NewCFunction(ctx, js_pal_inflate_push, "inflatePush", 2));
    JS_SetPropertyStr(ctx, pal, "inflateFree",
        JS_NewCFunction(ctx, js_pal_inflate_free, "inflateFree", 1));

    JS_FreeValue(ctx, pal);
    JS_FreeValue(ctx, global);

    (void)ext;
    return 0;
}

#endif /* QZ_WITH_COMPRESS */

/* ================================================================
 * Extension definition
 * ================================================================ */

const qz_ext_t qz_compress_ext = {
    .name = "compress",
#if QZ_WITH_COMPRESS
    .init = compress_ext_init,
    .destroy = NULL,
    .suspend = NULL,
    .resume = NULL,
#else
    .init = NULL,
    .destroy = NULL,
    .suspend = NULL,
    .resume = NULL,
#endif
    .user_data = NULL,
};
