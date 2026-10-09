/*
 * qzjs TextCodec Extension
 *
 * Native UTF-8 encode/decode and Base64 encode/decode.
 * Registers pal.nativeEncodeUtf8, pal.nativeBtoa, pal.nativeAtob on the JS pal object.
 *
 * Hand-written C — no external library needed.
 * The algorithms are simple and the win comes from avoiding
 * per-character JS function call overhead and string concatenation.
 */

#include "base/qz_rt.h"

#if QZ_WITH_TEXTCODEC

#include <string.h>
#include <stdlib.h>

/* ================================================================
 * UTF-8 encode: JS string -> Uint8Array
 * ================================================================ */

static JSValue js_pal_native_encode_utf8(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "nativeEncodeUtf8 requires 1 argument");
    }

    size_t len = 0;
    const char *str = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!str) return JS_EXCEPTION;

    /* JS_ToCStringLen reports the true UTF-8 byte length (QuickJS stores
     * strings as UTF-8 internally). strlen() would truncate at an embedded
     * NUL, corrupting binary payloads, so it must not be used here. */
    JSValue result = JS_NewUint8ArrayCopy(ctx, (const uint8_t *)str, len);
    JS_FreeCString(ctx, str);
    return result;
}

/* ================================================================
 * Base64 encode (btoa): JS string -> JS string
 * ================================================================ */

static const char b64_table[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static JSValue js_pal_native_btoa(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "nativeBtoa requires 1 argument");
    }

    /* WHATWG btoa semantics: the input is a binary string where each
     * UTF-16 code unit contributes its low 8 bits (charCodeAt(i) & 0xFF)
     * as one byte. Must read via the UTF-16 accessor — JS_ToCStringLen
     * yields UTF-8 bytes, which would expand code points >= 0x80 into
     * several bytes (é -> C3 A9) and break the binary-string contract. */
    size_t len = 0;
    const uint16_t *str = JS_ToCStringLenUTF16(ctx, &len, argv[0]);
    if (!str) return JS_EXCEPTION;
    size_t out_len = 4 * ((len + 2) / 3);
    char *out = (char *)js_malloc(ctx, out_len + 1);
    if (!out) {
        JS_FreeCStringUTF16(ctx, str);
        return JS_ThrowOutOfMemory(ctx);
    }

    size_t i, j;
    for (i = 0, j = 0; i + 2 < len; i += 3) {
        uint32_t n = ((uint32_t)(str[i] & 0xFF) << 16) |
                     ((uint32_t)(str[i+1] & 0xFF) << 8) |
                     (uint32_t)(str[i+2] & 0xFF);
        out[j++] = b64_table[(n >> 18) & 0x3F];
        out[j++] = b64_table[(n >> 12) & 0x3F];
        out[j++] = b64_table[(n >> 6) & 0x3F];
        out[j++] = b64_table[n & 0x3F];
    }
    if (i < len) {
        uint32_t n = (uint32_t)(str[i] & 0xFF) << 16;
        if (i + 1 < len) n |= (uint32_t)(str[i+1] & 0xFF) << 8;
        out[j++] = b64_table[(n >> 18) & 0x3F];
        out[j++] = b64_table[(n >> 12) & 0x3F];
        out[j++] = (i + 1 < len) ? b64_table[(n >> 6) & 0x3F] : '=';
        out[j++] = '=';
    }
    out[j] = '\0';

    JS_FreeCStringUTF16(ctx, str);
    JSValue result = JS_NewString(ctx, out);
    js_free(ctx, out);
    return result;
}

/* ================================================================
 * Base64 decode (atob): JS string -> JS string
 * ================================================================ */

static const int8_t b64_decode[256] = {
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,
    52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-1,-1,-1,
    -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,
    15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
    -1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,
    41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
};

static JSValue js_pal_native_atob(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc;
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "nativeAtob requires 1 argument");
    }

    size_t len = 0;
    const char *str = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!str) return JS_EXCEPTION;
    /* Strip whitespace and validate */
    size_t clean_len = 0;
    uint8_t *clean = (uint8_t *)js_malloc(ctx, len ? len : 1);
    if (!clean) {
        JS_FreeCString(ctx, str);
        return JS_ThrowOutOfMemory(ctx);
    }

    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)str[i];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') continue;
        if (b64_decode[c] < 0 && c != '=') {
            js_free(ctx, clean);
            JS_FreeCString(ctx, str);
            return JS_ThrowTypeError(ctx, "nativeAtob: invalid base64 character");
        }
        clean[clean_len++] = c;
    }
    JS_FreeCString(ctx, str);

    /* Decode */
    size_t out_len = (clean_len / 4) * 3;
    /* Account for padding */
    if (clean_len > 0 && clean[clean_len - 1] == '=') out_len--;
    if (clean_len > 1 && clean[clean_len - 2] == '=') out_len--;

    uint8_t *out = (uint8_t *)js_malloc(ctx, out_len + 1);
    if (!out) {
        js_free(ctx, clean);
        return JS_ThrowOutOfMemory(ctx);
    }

    size_t j = 0;
    for (size_t i = 0; i + 3 < clean_len; i += 4) {
        uint32_t n = 0;
        for (int k = 0; k < 4; k++) {
            n <<= 6;
            if (clean[i + k] != '=') {
                n |= (uint32_t)b64_decode[clean[i + k]];
            }
        }
        if (j < out_len) out[j++] = (n >> 16) & 0xFF;
        if (j < out_len) out[j++] = (n >> 8) & 0xFF;
        if (j < out_len) out[j++] = n & 0xFF;
    }

    js_free(ctx, clean);

    /* atob returns a string where each decoded byte maps to a codepoint
     * U+00XX. QuickJS stores strings as UTF-8, so bytes >= 0x80 must be
     * re-encoded as 2-byte UTF-8 sequences — feeding the raw bytes to
     * JS_NewStringLen would otherwise build an invalid UTF-8 string. */
    size_t utf8_len = out_len;
    for (size_t i = 0; i < out_len; i++) {
        if (out[i] >= 0x80) utf8_len++;
    }
    uint8_t *utf8 = (uint8_t *)js_malloc(ctx, utf8_len ? utf8_len : 1);
    if (!utf8) {
        js_free(ctx, out);
        return JS_ThrowOutOfMemory(ctx);
    }
    size_t p = 0;
    for (size_t i = 0; i < out_len; i++) {
        unsigned char b = out[i];
        if (b < 0x80) {
            utf8[p++] = b;
        } else {
            utf8[p++] = (uint8_t)(0xC0 | (b >> 6));
            utf8[p++] = (uint8_t)(0x80 | (b & 0x3F));
        }
    }
    js_free(ctx, out);

    JSValue result = JS_NewStringLen(ctx, (const char *)utf8, utf8_len);
    js_free(ctx, utf8);
    return result;
}

/* ================================================================
 * Extension hooks
 * ================================================================ */

static int textcodec_ext_init(qz_ext_t *ext, qz_t *rt)
{
    JSContext *ctx = qz_get_active_jsctx(rt);
    if (!ctx) return -1;

    JSValue global = JS_GetGlobalObject(ctx);

    JSValue pal = JS_GetPropertyStr(ctx, global, "pal");
    if (JS_IsUndefined(pal) || JS_IsException(pal)) {
        JS_FreeValue(ctx, pal);
        pal = JS_GetPropertyStr(ctx, global, "__native__");
    }

    if (JS_IsUndefined(pal) || JS_IsException(pal)) {
        JS_FreeValue(ctx, pal);
        JS_FreeValue(ctx, global);
        return -1;
    }

    JS_SetPropertyStr(ctx, pal, "nativeEncodeUtf8",
        JS_NewCFunction(ctx, js_pal_native_encode_utf8, "nativeEncodeUtf8", 1));
    JS_SetPropertyStr(ctx, pal, "nativeBtoa",
        JS_NewCFunction(ctx, js_pal_native_btoa, "nativeBtoa", 1));
    JS_SetPropertyStr(ctx, pal, "nativeAtob",
        JS_NewCFunction(ctx, js_pal_native_atob, "nativeAtob", 1));

    JS_FreeValue(ctx, pal);
    JS_FreeValue(ctx, global);

    (void)ext;
    return 0;
}

static void textcodec_ext_destroy(qz_ext_t *ext, qz_t *rt)
{
    (void)ext; (void)rt;
}

static int textcodec_ext_suspend(qz_ext_t *ext, qz_t *rt)
{
    (void)ext; (void)rt;
    return 0;
}

static int textcodec_ext_resume(qz_ext_t *ext, qz_t *rt)
{
    (void)ext; (void)rt;
    return 0;
}

#endif /* QZ_WITH_TEXTCODEC */

/* ================================================================
 * Extension definition
 * ================================================================ */

const qz_ext_t qz_textcodec_ext = {
    .name = "textcodec",
#if QZ_WITH_TEXTCODEC
    .init = textcodec_ext_init,
    .destroy = textcodec_ext_destroy,
    .suspend = textcodec_ext_suspend,
    .resume = textcodec_ext_resume,
#else
    .init = NULL,
    .destroy = NULL,
    .suspend = NULL,
    .resume = NULL,
#endif
    .user_data = NULL,
};
