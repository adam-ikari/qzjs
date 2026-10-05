/*
 * qzjs libuv I/O（执行模型 A）
 *
 * 直接调 libuv：I/O 回调在 qzjs 自持线程的 loop 上触发、直接进入 JS（无 deferred
 * 队列中转）。保留既有修复：chunked 解码、destroy 泄漏、double-free、UAF。
 */

#define _POSIX_C_SOURCE 200809L

#include "qz_internal.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <ctype.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>

#if QZ_WITH_TLS
#include <mbedtls/ssl.h>
#include <mbedtls/net_sockets.h>
#include <mbedtls/entropy.h>
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/error.h>
#endif

/* ================================================================
 * Constants
 * ================================================================ */

#define PAL_UV_STORAGE_DEFAULT 128
#define PAL_UV_FS_BUF_INIT 4096
#define PAL_UV_HTTP_BUF_INIT 4096
#define PAL_UV_CONNECT_TIMEOUT_MS 30000
#define PAL_UV_READ_IDLE_TIMEOUT_MS 60000
#define PAL_UV_MAX_CHUNK_SIZE (16 * 1024 * 1024)  /* 16 MB */

/* Chunked transfer-encoding parsing states */
enum {
    CHUNK_STATE_SIZE = 0,   /* reading chunk-size line */
    CHUNK_STATE_DATA,       /* reading chunk-data */
    CHUNK_STATE_TRAILER,    /* reading \r\n after chunk-data */
    CHUNK_STATE_DONE        /* received 0-length final chunk */
};

/* ================================================================
 * Operation wrapper structs — carry PAL callback alongside uv req
 * ================================================================ */

/* Generic fs operation wrapper */
typedef struct uv_io_fs_op_t {
    qz_io_done_t cb;
    void *cb_data;
    uv_fs_t fs_req;
    qz_t *rt;
    /* For fs_read/fs_write: buffer (original malloc pointer, never advanced) */
    char *buf;
    size_t buf_len;
    size_t buf_cap;
    /* Zero-copy fs_read: alloc_fn provisions buf after open (JS ArrayBuffer
     * backing); owner != NULL marks buf as externally owned — close_cb then
     * hands it to the done callback instead of free(). err records a read
     * failure so close_cb releases the backing before the (already-fired)
     * error callback's cleanup. */
    qz_fs_alloc_fn alloc_fn;
    qz_fs_free_fn free_fn;
    void *alloc_ud;
    void *owner;
    int err;
    /* EOF probe for zero-copy reads: when the backing (sized by fstat) is
     * full, read one byte to distinguish EOF from a file that grew. */
    char probe[1];
    int probing;
    /* For fs_write: write offset into buf (avoids advancing buf pointer) */
    size_t buf_offset;
    /* For fs_read/fs_write: file descriptor after open */
    uv_file fd;
    /* For fs_list: directory entries */
    uv_dirent_t *dent_buf;
    int dent_count;
    int dent_cap;
} uv_io_fs_op_t;


/* HTTP operation wrapper */
typedef struct uv_io_http_op_t {
    qz_io_done_t cb;
    void *cb_data;
    qz_t *rt;
    uv_tcp_t tcp;
    uv_connect_t connect_req;
    uv_write_t write_req;
    uv_getaddrinfo_t addr_req;
    uv_timer_t connect_timer;
    uv_timer_t idle_timer;

    /* Parsed URL components (heap-allocated copies) */
    char *host;
    int port;
    char *path;
    char *method;
    char *headers_json;
    char *body;
    size_t body_len;

    int use_tls;

    /* Outbound proxy (HTTP(S)_PROXY env, NO_PROXY excludes). proxy_active=1
     * routes DNS/TCP at proxy_host:proxy_port; plain-http origins use an
     * absolute-form request line, https origins get a CONNECT tunnel. */
    char *proxy_host;
    int proxy_port;
    int proxy_active;

    /* CONNECT tunnel state: 0=unused, 1=CONNECT sent, awaiting response.
     * proxy_buf accumulates the raw CONNECT response bytes. */
    int connect_state;
    char *proxy_buf;
    size_t proxy_buf_len;

    /* Borrowed pointer to the runtime-cached "Proxy-Authorization: Basic <b64>"
     * header value (from rt->proxy_auth_value), or NULL when the proxy URL has
     * no userinfo. Emitted on CONNECT and plain-http absolute-form requests.
     * NOT owned by the op — freed by rt teardown after all ops are gone. */
    char *proxy_auth;

#if QZ_WITH_TLS
    mbedtls_ssl_context ssl;
    mbedtls_ssl_config ssl_conf;
    mbedtls_x509_crt ca_certs;
    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context ctr_drbg;
    unsigned char *tls_read_buf; /* Encrypted data from network */
    size_t tls_read_buf_len;
    size_t tls_read_consumed;   /* Bytes consumed by tls_recv_cb */
    int tls_handshake_done;
#endif

    /* Request buffer */
    char *req_buf;
    size_t req_buf_len;

    /* Response buffer */
    char *resp_buf;
    size_t resp_buf_len;
    size_t resp_buf_cap;

    /* Response parsing state */
    int parse_state;       /* 0=status, 1=headers, 2=body */
    int http_status;
    int headers_done;
    size_t header_end_offset;

    /* Content-Length / chunked body tracking */
    int chunked;           /* 1 = Transfer-Encoding: chunked */
    size_t body_expected;  /* Content-Length value (0 = unknown) */
    size_t body_received;  /* body bytes received so far */

    /* Chunked encoding parsing state */
    int chunk_state;       /* CHUNK_STATE_* */
    size_t chunk_remaining;/* bytes remaining in current chunk */
    char chunk_size_buf[16];/* partial chunk-size line buffer */
    size_t chunk_size_buf_len;
    /* Multi-read chunked decode: decoded bytes are compacted into resp_buf at
     * [header_end_offset, chunk_write_pos). Raw (encoded) bytes arrive via
     * process_data appended at resp_buf_len; the decoder consumes from
     * header_end_offset + chunk_raw_consumed. These persist across reads so a
     * chunked body split across multiple reads decodes correctly (previously
     * write_pos reset each call, causing decoded bytes to be overwritten /
     * re-parsed as framing -> body lost). */
    size_t chunk_write_pos;  /* decoded body length so far (offset from header_end) */
    size_t chunk_raw_consumed; /* raw encoded bytes consumed so far (from body start) */

    /* Streaming mode */
    int streaming;              /* 1 = streaming response via stream_ops */
    qz_io_stream_ops_t stream_ops;

    /* Streaming header parsing state */
    int headers_parsed;         /* 1 = headers already delivered via on_headers */
    char *resp_headers;         /* Accumulated header text for parsing */
    size_t resp_headers_len;

    /* Streaming chunked decoding state */
    size_t chunk_size;          /* parsed chunk size for current chunk */

    /* Handle initialization flags — only close handles that were init'd */
    unsigned tcp_init : 1;
    unsigned timer_init : 1;
    unsigned idle_timer_init : 1;
    unsigned aborted : 1;       /* set by uv_io_http_abort; callbacks must no-op */
    unsigned teardown_started : 1; /* set at the top of uv_io_http_stream_cleanup;
                               * makes it idempotent and lets the read cb no-op
                               * on the ECANCELED delivered after a forced close */
    unsigned tearing_down : 1;    /* 1 once a teardown function (finish_error/
                              * finish_success/stream_cleanup/stream_finish_error)
                              * begins closing op's handles. Only handles closed
                              * while tearing_down participate in the close
                              * refcount - mid-life closes (a failed connect
                              * timer, a connect timer retired after connect) must
                              * not, or their close cb would free a still-live op. */
    int closes_pending;      /* refcount of teardown uv_close'd handles whose
                              * hasn't fired. op is freed only when this reaches
                              * 0, so a handle still in libuv's closing queue is
                              * never freed prematurely (would be UAF: libuv
                              * dereferences the handle struct inside op). */
    int closes_uncounted;    /* refcount of MID-LIFE uv_close'd handles (closed
                              * while tearing_down == 0, e.g. a failed connect
                              * timer). Their close callbacks may fire AFTER
                              * teardown begins (tearing_down == 1), so they must
                              * consume a separate counter — close_done checks it
                              * first and never lets an uncounted close drain
                              * closes_pending (else op frees before the counted
                              * TCP close callback runs → UAF). */

    /* Per-op abort registry linkage: rt->http_ops is a singly-linked list of
     * LIVE streaming ops. op_id is assigned on start (rt->http_op_seq) and
     * handed to JS as the abort handle; uv_io_http_abort_by_id looks the op up
     * here. uv_io_http_cleanup unlinks the op before free, so a stale JS handle
     * can never reach freed memory. */
    struct uv_io_http_op_t *next;
    uint64_t op_id;
 } uv_io_http_op_t;


/* ================================================================
 * TLS helpers (mbedTLS)
 * ================================================================ */

#if QZ_WITH_TLS
static int tls_init_op(uv_io_http_op_t *op) {
    int ret;
    mbedtls_ssl_init(&op->ssl);
    mbedtls_ssl_config_init(&op->ssl_conf);
    mbedtls_x509_crt_init(&op->ca_certs);
    mbedtls_entropy_init(&op->entropy);
    mbedtls_ctr_drbg_init(&op->ctr_drbg);
    op->tls_read_buf = NULL;
    op->tls_read_buf_len = 0;
    op->tls_read_consumed = 0;

    ret = mbedtls_ctr_drbg_seed(&op->ctr_drbg, mbedtls_entropy_func,
                                 &op->entropy, NULL, 0);
    if (ret != 0) return -1;

    ret = mbedtls_ssl_config_defaults(&op->ssl_conf,
                                       MBEDTLS_SSL_IS_CLIENT,
                                       MBEDTLS_SSL_TRANSPORT_STREAM,
                                       MBEDTLS_SSL_PRESET_DEFAULT);
    if (ret != 0) return -1;

    mbedtls_ssl_conf_rng(&op->ssl_conf, mbedtls_ctr_drbg_random, &op->ctr_drbg);

    /* Load system CA certificates */
    const char *ca_paths[] = {
        "/etc/ssl/certs/ca-certificates.crt",                /* Debian/Ubuntu */
        "/etc/pki/tls/certs/ca-bundle.crt",                  /* RHEL/CentOS */
        "/etc/ssl/ca-bundle.pem",                            /* OpenSUSE */
        "/usr/local/share/certs/ca-root-nss.crt",           /* FreeBSD */
        NULL
    };
    int ca_loaded = 0;
    for (const char **p = ca_paths; *p != NULL; p++) {
        ret = mbedtls_x509_crt_parse_file(&op->ca_certs, *p);
        if (ret == 0) {
            ca_loaded = 1;
            break;
        }
    }
    if (ca_loaded) {
        mbedtls_ssl_conf_ca_chain(&op->ssl_conf, &op->ca_certs, NULL);
    }
    /* 恒为 VERIFY_REQUIRED:证书验证失败必须让握手失败。即使没有系统 CA
     * (ca_chain 为空,任何服务器证书都无法验证 → 连接被拒),也绝不静默
     * 降级到 VERIFY_OPTIONAL——那会接受任意中间人/自签名证书。 */
    mbedtls_ssl_conf_authmode(&op->ssl_conf, MBEDTLS_SSL_VERIFY_REQUIRED);

    /* ALPN:必须声明 http/1.1。省略 ALPN 时,现代服务器(Cloudflare /
     * Google / Fastly 等)在收到不含 ALPN 扩展的 ClientHello 时会按
     * RFC 7301 直接以握手 alert 关闭连接 —— 表现为对端在 ClientHello
     * 之后立刻 EOF,握手永远走不到证书校验。tcp_io.c 早已默认声明
     * http/1.1(见其 alpn_buf 逻辑),uv_io.c 这条客户端路径此前一直缺失,
     * 导致所有 https fetch 失败。这里补齐,并把失败降级为「不致命」:
     * 声明失败不阻断连接,交给后续握手结果说话。 */
    {
        static const char *alpn_protos[] = { (const char *)"http/1.1", NULL };
        int alpn_rc = mbedtls_ssl_conf_alpn_protocols(&op->ssl_conf, alpn_protos);
        if (alpn_rc != 0) {
            fprintf(stderr, "[qzjs] uv_io: failed to set ALPN http/1.1 (%d); "
                            "some servers will reject the handshake\n", alpn_rc);
        }
    }

    ret = mbedtls_ssl_setup(&op->ssl, &op->ssl_conf);
    if (ret != 0) return -1;

    ret = mbedtls_ssl_set_hostname(&op->ssl, op->host);
    if (ret != 0) return -1;   /* SNI/主机名校验不可用 → 拒绝,不静默通过 */
    op->tls_handshake_done = 0;
    return 0;
}

static void tls_free_op(uv_io_http_op_t *op) {
    mbedtls_ssl_free(&op->ssl);
    mbedtls_ssl_config_free(&op->ssl_conf);
    mbedtls_x509_crt_free(&op->ca_certs);
    mbedtls_entropy_free(&op->entropy);
    mbedtls_ctr_drbg_free(&op->ctr_drbg);
    if (op->tls_read_buf) {
        free(op->tls_read_buf);
        op->tls_read_buf = NULL;
    }
}

static void tls_write_cb(uv_write_t *req, int status) {
    (void)status;  /* write result unused — buffer freed regardless */
    free(req->data); /* free the copied buffer */
    free(req);
}

static int tls_send_cb(void *ctx, const unsigned char *buf, size_t len) {
    uv_io_http_op_t *op = (uv_io_http_op_t *)ctx;
    /* Copy buffer — mbedTLS may reuse it, and uv_write is async */
    char *copy = malloc(len);
    if (!copy) return MBEDTLS_ERR_NET_SEND_FAILED;
    memcpy(copy, buf, len);
    uv_write_t *req = malloc(sizeof(uv_write_t));
    if (!req) { free(copy); return MBEDTLS_ERR_NET_SEND_FAILED; }
    req->data = copy;
    uv_buf_t wbuf = uv_buf_init(copy, (unsigned int)len);
    int ret = uv_write(req, (uv_stream_t *)&op->tcp, &wbuf, 1, tls_write_cb);
    if (ret != 0) { free(copy); free(req); return MBEDTLS_ERR_NET_SEND_FAILED; }
    return (int)len;
}

static int tls_recv_cb(void *ctx, unsigned char *buf, size_t len) {
    uv_io_http_op_t *op = (uv_io_http_op_t *)ctx;
    size_t avail = op->tls_read_buf_len - op->tls_read_consumed;
    if (avail == 0) {
        return MBEDTLS_ERR_SSL_WANT_READ;
    }
    size_t copy = len < avail ? len : avail;
    memcpy(buf, op->tls_read_buf + op->tls_read_consumed, copy);
    op->tls_read_consumed += copy;
    return (int)copy;
}
#endif

/* ────────────────────────────────────────────────────────────────
 * JSON helpers and URL parser（原 platform/pal_common.c 内联进 uv_io.c）
 * ──────────────────────────────────────────────────────────────── */

/* Parsed URL components（自 pal_common 移植） */
typedef struct {
    char *host;         /* heap-allocated hostname */
    int   port;         /* port number (defaults to 80 or 443) */
    char *path;         /* heap-allocated path (always at least "/") */
    int   tls;          /* 1 if https://, 0 if http:// */
} uv_io_url_t;
static int uv_io_json_escape(const char *src, size_t src_len,
                    char *dst, size_t dst_cap)
{
    size_t i, j;
    for (i = 0, j = 0; i < src_len; i++) {
        unsigned char c = (unsigned char)src[i];
        switch (c) {
        case '"':  if (j + 2 > dst_cap) return -1; dst[j++] = '\\'; dst[j++] = '"';  break;
        case '\\': if (j + 2 > dst_cap) return -1; dst[j++] = '\\'; dst[j++] = '\\'; break;
        case '\b': if (j + 2 > dst_cap) return -1; dst[j++] = '\\'; dst[j++] = 'b';  break;
        case '\f': if (j + 2 > dst_cap) return -1; dst[j++] = '\\'; dst[j++] = 'f';  break;
        case '\n': if (j + 2 > dst_cap) return -1; dst[j++] = '\\'; dst[j++] = 'n';  break;
        case '\r': if (j + 2 > dst_cap) return -1; dst[j++] = '\\'; dst[j++] = 'r';  break;
        case '\t': if (j + 2 > dst_cap) return -1; dst[j++] = '\\'; dst[j++] = 't';  break;
        default:
            if (c < 0x20) {
                if (j + 7 > dst_cap) return -1;
                j += (size_t)snprintf(dst + j, dst_cap - j, "\\u%04x", c);
            } else {
                if (j + 1 > dst_cap) return -1;
                dst[j++] = (char)c;
            }
            break;
        }
    }
    if (j < dst_cap) {
        dst[j] = '\0';
    } else if (dst_cap > 0) {
        return -1;
    }
    return (int)j;
}

/* ================================================================
 * uv_io_build_headers_json — Build a JSON object from raw HTTP headers
 *
 * Input: header region (between status line and \r\n\r\n)
 * Output: {"Key":"Value","Key2":"Value2"}
 * ================================================================ */

static char *uv_io_build_headers_json(const char *hdr_start, size_t hdr_len,
                             size_t *out_len)
{
    /* Worst case: each char could become a \u00XX sequence (6 bytes) */
    size_t cap = hdr_len * 6 + 4;
    char *buf = (char *)malloc(cap);
    if (!buf) {
        *out_len = 0;
        return NULL;
    }

    size_t pos = 0;
    buf[pos++] = '{';

    const char *p = hdr_start;
    const char *end = hdr_start + hdr_len;
    int first = 1;

    while (p < end) {
        /* Find end of line */
        const char *eol = p;
        while (eol < end && !(*eol == '\r' && (eol + 1 < end) && *(eol + 1) == '\n')) {
            eol++;
        }

        /* Find colon separating key and value */
        const char *colon = p;
        while (colon < eol && *colon != ':') colon++;

        if (colon < eol) {
            /* We have a key: value pair */
            size_t key_len = (size_t)(colon - p);
            const char *val_start = colon + 1;
            /* Skip leading whitespace in value */
            while (val_start < eol && (*val_start == ' ' || *val_start == '\t')) {
                val_start++;
            }
            size_t val_len = (size_t)(eol - val_start);

            if (!first) {
                buf[pos++] = ',';
            }
            first = 0;

            buf[pos++] = '"';
            {
                int n = uv_io_json_escape(p, key_len, buf + pos, cap - pos - 1);
                if (n < 0) { free(buf); *out_len = 0; return NULL; }
                pos += (size_t)n;
            }
            buf[pos++] = '"';
            buf[pos++] = ':';
            buf[pos++] = '"';
            {
                int n = uv_io_json_escape(val_start, val_len, buf + pos, cap - pos - 1);
                if (n < 0) { free(buf); *out_len = 0; return NULL; }
                pos += (size_t)n;
            }
            buf[pos++] = '"';
        }

        /* Move past \r\n */
        p = eol;
        if (p < end && *p == '\r') p++;
        if (p < end && *p == '\n') p++;
    }

    buf[pos++] = '}';
    buf[pos] = '\0';
    *out_len = pos;
    return buf;
}

/* ================================================================
 * uv_io_build_http_json — Build JSON result for HTTP response
 *
 * Format: {"status":NNN,"headers":<json>,"body":"<escaped>"}
 * Caller must free the returned string.
 * ================================================================ */

static char *uv_io_build_http_json(int status, const char *headers,
                          size_t headers_len,
                          const char *body, size_t body_len,
                          size_t *out_len)
{
    /* Worst case: body chars could each become \u00XX (6 bytes) */
    size_t cap = 64 + headers_len + body_len * 6 + 128;
    char *buf = (char *)malloc(cap);
    if (!buf) {
        *out_len = 0;
        return NULL;
    }

    size_t pos = 0;
    pos += snprintf(buf + pos, cap - pos, "{\"status\":%d,\"headers\":", status);

    if (headers && headers_len > 0) {
        /* headers is already a JSON object string from parsing */
        memcpy(buf + pos, headers, headers_len);
        pos += headers_len;
    } else {
        memcpy(buf + pos, "{}", 2);
        pos += 2;
    }

    memcpy(buf + pos, ",\"body\":\"", 9);
    pos += 9;

    {
        int n = uv_io_json_escape(body, body_len, buf + pos, cap - pos - 2);
        if (n < 0) { free(buf); *out_len = 0; return NULL; }
        pos += (size_t)n;
    }

    memcpy(buf + pos, "\"}", 2);
    pos += 2;

    *out_len = pos;
    return buf;
}

/* ================================================================
 * uv_io_build_json_array — Build JSON array from string list
 *
 * Output: ["item1","item2",...]
 * Caller must free the returned string.
 * ================================================================ */

static char *uv_io_build_json_array(const char *const *items, int count,
                           size_t *out_len)
{
    size_t cap = 4 + (size_t)count * 256;
    char *buf = (char *)malloc(cap);
    if (!buf) {
        *out_len = 0;
        return NULL;
    }

    size_t pos = 0;
    buf[pos++] = '[';

    int i;
    for (i = 0; i < count; i++) {
        if (i > 0) {
            buf[pos++] = ',';
        }
        buf[pos++] = '"';
    {
        int n = uv_io_json_escape(items[i], strlen(items[i]),
                               buf + pos, cap - pos - 2);
        if (n < 0) { free(buf); *out_len = 0; return NULL; }
        pos += (size_t)n;
    }
        buf[pos++] = '"';
    }

    buf[pos++] = ']';
    buf[pos] = '\0';
    *out_len = pos;
    return buf;
}

/* ================================================================
 * uv_io_parse_url — HTTP 客户端 URL 解析
 *
 * 从 http:// 或 https:// 绝对 URL 提取 host（裸主机名，IPv6 字面量不带
 * 方括号，供 getaddrinfo / SNI 使用）、port、path（含 query，不含 fragment）
 * 与 TLS 标志。返回 0 成功；-1 表示非法 scheme/host/port、控制字符注入、
 * 或分配失败。port 越界/非数字即拒绝（fail closed），而非回退默认端口。
 * ================================================================ */

static int uv_io_parse_url(const char *url, uv_io_url_t *out)
{
    const char *p;
    const char *end;
    const char *frag;

    if (!url || !out) return -1;

    /* CR/LF/空格/Tab 出现在 URL 任意位置都会破坏请求行或 Host 头
     * （头注入向量；url.js 不做百分号编码，可能原样放行）。 */
    for (p = url; *p; p++) {
        if (*p == '\r' || *p == '\n' || *p == ' ' || *p == '\t') return -1;
    }

    if (strncasecmp(url, "https://", 8) == 0) {
        out->tls = 1;
        p = url + 8;
    } else if (strncasecmp(url, "http://", 7) == 0) {
        out->tls = 0;
        p = url + 7;
    } else {
        return -1;
    }

    /* fragment 不上线路（WHATWG：仅拼进 href，绝不发送），视作虚拟结尾。 */
    frag = strchr(p, '#');
    end = frag ? frag : p + strlen(p);

    /* authority 段 = p..auth_end（首个 '/' 或 '?' 之前）。 */
    const char *auth_end = end;
    for (const char *q = p; q < end; q++) {
        if (*q == '/' || *q == '?') { auth_end = q; break; }
    }

    /* userinfo（最后一个 '@' 之前）丢弃：凭据不进 host/DNS/SNI。 */
    const char *host_start = p;
    for (const char *q = p; q < auth_end; q++) {
        if (*q == '@') host_start = q + 1;
    }
    if (host_start >= auth_end) return -1;   /* 空 host（含 http://user@/） */

    /* host + port。IPv6 字面量 [..]：host 取括号内裸地址，':' 只在 ']' 后
     * 才是端口分隔符。 */
    const char *host_end;
    const char *port_start = NULL;
    if (*host_start == '[') {
        const char *close = NULL;
        for (const char *q = host_start + 1; q < auth_end; q++) {
            if (*q == ']') { close = q; break; }
        }
        if (!close) return -1;   /* 括号未闭合 */
        host_start++;            /* 跳过 '['，存裸地址 */
        host_end = close;
        if (close + 1 < auth_end) {
            if (close[1] != ':') return -1;
            port_start = close + 2;
        }
    } else {
        host_end = host_start;
        while (host_end < auth_end && *host_end != ':') host_end++;
        if (host_end < auth_end) port_start = host_end + 1;
    }

    /* 默认端口；显式端口必须为纯数字且 1..65535（空串 = 默认端口）。 */
    int default_port = out->tls ? 443 : 80;
    if (port_start) {
        long port = 0;
        const char *q = port_start;
        if (q >= auth_end) {
            out->port = default_port;            /* "host:/" → 默认端口 */
        } else {
            for (; q < auth_end; q++) {
                if (*q < '0' || *q > '9') return -1;
                port = port * 10 + (*q - '0');
                if (port > 65535) return -1;
            }
            if (port <= 0) return -1;
            out->port = (int)port;
        }
    } else {
        out->port = default_port;
    }

    size_t host_len = (size_t)(host_end - host_start);
    if (host_len == 0) return -1;   /* "http://[]/x" */

    out->host = (char *)malloc(host_len + 1);
    if (!out->host) return -1;
    memcpy(out->host, host_start, host_len);
    out->host[host_len] = '\0';

    /* path：'/' 或裸 '?'（无斜杠 query）开头；无则 "/"。只拷贝到 fragment
     * 虚拟结尾 end，strdup 会把 fragment 带进请求行。 */
    if (auth_end == end) {
        out->path = strdup("/");
    } else if (*auth_end == '/') {
        size_t n = (size_t)(end - auth_end);
        out->path = (char *)malloc(n + 1);
        if (out->path) {
            memcpy(out->path, auth_end, n);
            out->path[n] = '\0';
        }
    } else {   /* '?' 无 '/'：WHATWG pathname 为 "/"，补齐后再拼 query */
        size_t n = (size_t)(end - auth_end);
        out->path = (char *)malloc(n + 2);
        if (out->path) {
            out->path[0] = '/';
            memcpy(out->path + 1, auth_end, n);
            out->path[n + 1] = '\0';
        }
    }
    if (!out->path) {
        free(out->host);
        out->host = NULL;
        return -1;
    }

    return 0;
}

/* ================================================================
 * Outbound proxy (env configuration)
 *
 * HTTP_PROXY / http_proxy      — proxy for plain-http origins
 * HTTPS_PROXY / https_proxy    — proxy for https origins
 * NO_PROXY / no_proxy          — comma-separated host suffixes, "*" = all
 *
 * Proxy URL form: http://host[:port] (default port 80). Other schemes are
 * rejected (failing closed) rather than silently bypassing the proxy.
 * ================================================================ */

/* Does host[:port] match one NO_PROXY entry? Suffix match on dot boundaries;
 * a leading dot in the entry is ignored. Exact match also passes. An entry
 * may carry a ":port" suffix ("example.com:8080") — then the request port
 * must match too. "*" excludes everything. */
static int uv_io_no_proxy_entry_match(const char *host, int port, const char *entry)
{
    size_t hl, el;
    const char *colon;
    int entry_port = 0, has_port = 0;

    if (!host || !entry || !*entry) return 0;
    if (strcmp(entry, "*") == 0) return 1;

    /* Split an optional trailing ":port" off the entry. IPv6 literals in
     * NO_PROXY are bracketed ("[::1]"), so the LAST colon is the port sep. */
    colon = strrchr(entry, ':');
    if (colon && colon[1] != '\0' &&
        strspn(colon + 1, "0123456789") == strlen(colon + 1)) {
        char *end = NULL;
        long p = strtol(colon + 1, &end, 10);
        if (end != colon + 1 && p > 0 && p <= 65535) {
            has_port = 1;
            entry_port = (int)p;
        }
    }
    if (has_port) {
        if (port != entry_port) return 0;
        /* compare host part only */
        el = (size_t)(colon - entry);
    } else {
        el = strlen(entry);
    }
    /* Bracketed IPv6 literals ("[::1]") must match the bare host form "::1"
     * that uv_io_parse_url produces (hosts are stored without brackets). */
    if (el > 1 && entry[0] == '[' && entry[el - 1] == ']') { entry++; el -= 2; }
    if (el == 0) return 0;

    if (entry[0] == '.') { entry++; el--; }
    hl = strlen(host);
    if (el > hl) return 0;
    if (strncmp(host + hl - el, entry, el) != 0) return 0;
    /* "x.com" must not match "ax.com"; equal length = exact match */
    return (hl == el || host[hl - el - 1] == '.');
}

static int uv_io_host_in_no_proxy(const char *host, int port)
{
    const char *np = getenv("NO_PROXY");
    const char *p, *entry;
    if (!np || !*np) {
        np = getenv("no_proxy");
        if (!np || !*np) return 0;
    }
    p = np;
    while (*p) {
        size_t len;
        entry = p;
        while (*p && *p != ',') p++;
        len = (size_t)(p - entry);
        if (len > 0) {
            char buf[256];
            if (len >= sizeof(buf)) len = sizeof(buf) - 1;
            memcpy(buf, entry, len);
            buf[len] = '\0';
            /* trim surrounding whitespace */
            {
                char *b = buf;
                while (*b == ' ' || *b == '\t') b++;
                char *e = b + strlen(b);
                while (e > b && (e[-1] == ' ' || e[-1] == '\t')) e--;
                *e = '\0';
                if (*b && uv_io_no_proxy_entry_match(host, port, b)) return 1;
            }
        }
        if (*p == ',') p++;
    }
    return 0;
}

/* RFC 4648 base64 encode (no padding variant used by Basic auth is the
 * padded one; standard table). Returns malloc'd string or NULL on OOM. */
static char *uv_io_base64_encode(const unsigned char *data, size_t len)
{
    static const char tbl[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t out_len = ((len + 2) / 3) * 4;
    char *out = (char *)malloc(out_len + 1);
    size_t i, o = 0;
    if (!out) return NULL;
    for (i = 0; i + 2 < len; i += 3) {
        unsigned v = ((unsigned)data[i] << 16) |
                     ((unsigned)data[i + 1] << 8) | (unsigned)data[i + 2];
        out[o++] = tbl[(v >> 18) & 0x3F];
        out[o++] = tbl[(v >> 12) & 0x3F];
        out[o++] = tbl[(v >> 6) & 0x3F];
        out[o++] = tbl[v & 0x3F];
    }
    if (i < len) {
        unsigned v = (unsigned)data[i] << 16;
        if (i + 1 < len) v |= (unsigned)data[i + 1] << 8;
        out[o++] = tbl[(v >> 18) & 0x3F];
        out[o++] = tbl[(v >> 12) & 0x3F];
        out[o++] = (i + 1 < len) ? tbl[(v >> 6) & 0x3F] : '=';
        out[o++] = '=';
    }
    out[o] = '\0';
    return out;
}

/* Percent-decode a userinfo string ("user%40x:pa%25ss" -> "user@x:pa%ss").
 * Returns malloc'd decoded string (may shrink) or NULL on OOM. */
static char *uv_io_percent_decode(const char *s)
{
    size_t len = strlen(s);
    char *out = (char *)malloc(len + 1);
    size_t i, o = 0;
    if (!out) return NULL;
    for (i = 0; i < len; i++) {
        if (s[i] == '%' && i + 2 < len &&
            isxdigit((unsigned char)s[i + 1]) && isxdigit((unsigned char)s[i + 2])) {
            int hi = (s[i + 1] <= '9') ? (s[i + 1] - '0')
                     : ((s[i + 1] | 0x20) - 'a' + 10);
            int lo = (s[i + 2] <= '9') ? (s[i + 2] - '0')
                     : ((s[i + 2] | 0x20) - 'a' + 10);
            out[o++] = (char)((hi << 4) | lo);
            i += 2;
        } else {
            out[o++] = s[i];
        }
    }
    out[o] = '\0';
    return out;
}

/* Parse "http://[user:pass@]host[:port]" from env. Returns 0 and fills
 * host/port on success; -1 on malformed value or unsupported scheme
 * (failing closed). userinfo_out receives the decoded "user:pass" (malloc'd)
 * or NULL when absent — caller frees it. */
static int uv_io_parse_proxy_url(const char *url, char **host_out, int *port_out,
                                 char **userinfo_out)
{
    const char *p;
    const char *host_start, *port_start = NULL;
    size_t len;
    long port = 80;
    char *host;

    if (userinfo_out) *userinfo_out = NULL;
    if (strncmp(url, "http://", 7) != 0) return -1;   /* https-pfx unsupported */
    p = url + 7;
    if (!*p) return -1;

    /* Optional userinfo up to '@'. A lone '@' or one without ':' still forms a
     * valid Basic credential (password empty), so accept any non-empty part. */
    {
        const char *at = strchr(p, '@');
        if (at) {
            size_t ulen = (size_t)(at - p);
            char *raw = (char *)malloc(ulen + 1);
            if (!raw) return -1;
            memcpy(raw, p, ulen);
            raw[ulen] = '\0';
            char *decoded = uv_io_percent_decode(raw);
            free(raw);
            if (!decoded) return -1;
            if (userinfo_out) {
                *userinfo_out = decoded;
            } else {
                free(decoded);
            }
            p = at + 1;
        }
    }

    host_start = p;
    while (*p && *p != ':' && *p != '/') p++;
    len = (size_t)(p - host_start);
    if (len == 0 || len > 253) return -1;
    if (*p == ':') {
        char *end = NULL;
        port = strtol(p + 1, &end, 10);
        if (end == p + 1 || port <= 0 || port > 65535) return -1;
        port_start = end;
    }
    /* trailing garbage after host[:port] (path, more colons) is invalid */
    if (port_start && *port_start) return -1;
    if (!port_start && *p) return -1;

    host = (char *)malloc(len + 1);
    if (!host) return -1;
    memcpy(host, host_start, len);
    host[len] = '\0';
    *host_out = host;
    *port_out = (int)port;
    return 0;
}

/* Decide whether this op goes through a proxy, from env. Called once after
 * URL parsing. On failure (bad proxy URL) the op errors out — failing closed
 * keeps traffic from silently bypassing the configured proxy. When the proxy
 * URL carries userinfo, the "Proxy-Authorization: Basic …" header is computed
 * once per proxy URL and cached on the runtime for its whole lifetime. */
static int uv_io_http_apply_proxy(uv_io_http_op_t *op)
{
    const char *val;
    char *userinfo = NULL;
    if (uv_io_host_in_no_proxy(op->host, op->port)) return 0;
    if (op->use_tls) {
        val = getenv("HTTPS_PROXY");
        if (!val || !*val) val = getenv("https_proxy");
    } else {
        val = getenv("HTTP_PROXY");
        if (!val || !*val) val = getenv("http_proxy");
    }
    if (!val || !*val) return 0;
    if (uv_io_parse_proxy_url(val, &op->proxy_host, &op->proxy_port,
                              &userinfo) < 0) {
        free(userinfo);
        return -1;
    }
    op->proxy_active = 1;

    /* Proxy authentication (cache per proxy URL for the runtime lifetime). */
    if (userinfo) {
        if (!op->rt->proxy_auth_url || strcmp(op->rt->proxy_auth_url, val) != 0) {
            char *b64 = uv_io_base64_encode((const unsigned char *)userinfo,
                                            strlen(userinfo));
            free(op->rt->proxy_auth_url);
            free(op->rt->proxy_auth_value);
            op->rt->proxy_auth_url = strdup(val);
            if (b64) {
                size_t n = strlen(b64) + 7;   /* "Basic " + b64 + NUL */
                op->rt->proxy_auth_value = (char *)malloc(n);
                if (op->rt->proxy_auth_value) {
                    snprintf(op->rt->proxy_auth_value, n, "Basic %s", b64);
                }
                free(b64);
            } else {
                op->rt->proxy_auth_value = NULL;
            }
        }
        op->proxy_auth = op->rt->proxy_auth_value;
    }
    free(userinfo);
    return 0;
}

/* Effective DNS/connect target: the proxy when active, else the origin. */
static const char *uv_io_http_connect_host(uv_io_http_op_t *op)
{
    return op->proxy_active ? op->proxy_host : op->host;
}

static int uv_io_http_connect_port(uv_io_http_op_t *op)
{
    return op->proxy_active ? op->proxy_port : op->port;
}

/* host[:port] 上线形式（authority）：IPv6 裸字面量补方括号，端口等于默认
 * 值时省略。返回 malloc 串，调用方 free。 */
static char *uv_io_http_authority(const char *host, int port, int default_port)
{
    const char *l = strchr(host, ':') ? "[" : "";
    const char *r = strchr(host, ':') ? "]" : "";
    char *s;
    size_t n = strlen(host) + 16;
    s = (char *)malloc(n);
    if (!s) return NULL;
    if (port != default_port) snprintf(s, n, "%s%s%s:%d", l, host, r, port);
    else snprintf(s, n, "%s%s%s", l, host, r);
    return s;
}

/* Absolute-form request target for plain-http via proxy (RFC 7230 5.3.2);
 * default port 80 may be omitted. Returns malloc'd string or NULL. */
static char *uv_io_http_proxy_request_target(uv_io_http_op_t *op)
{
    char *auth = uv_io_http_authority(op->host, op->port, 80);
    if (!auth) return NULL;
    size_t n = strlen("http://") + strlen(auth) + strlen(op->path) + 1;
    char *target = (char *)malloc(n);
    if (target) snprintf(target, n, "http://%s%s", auth, op->path);
    free(auth);
    return target;
}

/* Build and send "CONNECT host[:port] HTTP/1.1" to the proxy. Returns 0 and
 * has consumed the write on success; -1 fills err and the caller must fail. */
#if QZ_WITH_TLS
static void uv_io_http_connect_write_cb(uv_write_t *req, int status);
static void uv_io_http_proxy_connect_read_cb(uv_stream_t *stream, ssize_t nread,
                                             const uv_buf_t *buf);

static int uv_io_http_send_connect(uv_io_http_op_t *op, const char **err)
{
    uv_buf_t buf;
    int n;
    char *req;
    const char *auth = op->proxy_auth;
    char *authority = uv_io_http_authority(op->host, op->port, 443);
    size_t auth_extra = auth ? (strlen(auth) + 32) : 0;
    if (!authority) { *err = "out of memory"; return -1; }
    size_t cap = strlen(authority) * 2 + 96 + auth_extra;

    req = (char *)malloc(cap);
    if (!req) { free(authority); *err = "out of memory"; return -1; }
    n = snprintf(req, cap, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n",
                 authority, authority);
    free(authority);
    if (n <= 0 || (size_t)n >= cap) { free(req); *err = "connect build failed"; return -1; }
    if (auth) {
        int n2 = snprintf(req + n, cap - n, "Proxy-Authorization: %s\r\n", auth);
        if (n2 <= 0 || (size_t)n2 >= cap - n) { free(req); *err = "connect build failed"; return -1; }
        n += n2;
    }
    {
        int n3 = snprintf(req + n, cap - n, "\r\n");
        if (n3 <= 0 || (size_t)n3 >= cap - n) { free(req); *err = "connect build failed"; return -1; }
        n += n3;
    }

    op->req_buf = req;
    op->req_buf_len = (size_t)n;
    buf.base = req;
    buf.len = (size_t)n;
    op->connect_state = 1;
    op->write_req.data = op;
    if (uv_write(&op->write_req, (uv_stream_t *)&op->tcp, &buf, 1,
                 uv_io_http_connect_write_cb) != 0) {
        free(req);
        op->req_buf = NULL;
        op->req_buf_len = 0;
        op->connect_state = 0;
        *err = "proxy connect write failed";
        return -1;
    }
    return 0;
}
#endif /* QZ_WITH_TLS */
/* ================================================================
 * Storage operations (in-memory, synchronous callback)
 * ================================================================ */
void uv_io_storage_get(qz_t *rt, const char *key,
                               qz_io_done_t cb, void *cb_data)
{
    int i;

    if (!key) {
        cb(cb_data, QZ_ERR_INVALID_ARG, "invalid key", 11);
        return;
    }

    for (i = 0; i < rt->store_count; i++) {
        if (strcmp(rt->store[i].key, key) == 0) {
            cb(cb_data, 0, rt->store[i].value, rt->store[i].value_len);
            return;
        }
    }

    cb(cb_data, QZ_ERR_NOT_FOUND, "not found", 9);
}

static void uv_io_storage_init(qz_t *rt); /* defined in fs section below */

void uv_io_storage_set(qz_t *rt, const char *key,
                               const char *value, size_t value_len,
                               qz_io_done_t cb, void *cb_data)
{
    uv_io_storage_init(rt);
    int i;

    if (!key) {
        cb(cb_data, QZ_ERR_INVALID_ARG, "invalid key", 11);
        return;
    }

    /* Update existing */
    for (i = 0; i < rt->store_count; i++) {
        if (strcmp(rt->store[i].key, key) == 0) {
            free(rt->store[i].value);
            rt->store[i].value = (char *)malloc(value_len + 1);
            if (!rt->store[i].value) {
                cb(cb_data, QZ_ERR_GENERIC, "out of memory", 13);
                return;
            }
            memcpy(rt->store[i].value, value, value_len);
            rt->store[i].value[value_len] = '\0';
            rt->store[i].value_len = value_len;
            cb(cb_data, 0, "ok", 2);
            return;
        }
    }

    /* Insert new */
    if (rt->store_count >= rt->storage_max) {
        cb(cb_data, QZ_ERR_GENERIC, "storage full", 12);
        return;
    }

    rt->store[rt->store_count].key = strdup(key);
    rt->store[rt->store_count].value = (char *)malloc(value_len + 1);
    if (!rt->store[rt->store_count].key ||
        !rt->store[rt->store_count].value) {
        free(rt->store[rt->store_count].key);
        free(rt->store[rt->store_count].value);
        cb(cb_data, QZ_ERR_GENERIC, "out of memory", 13);
        return;
    }
    memcpy(rt->store[rt->store_count].value, value, value_len);
    rt->store[rt->store_count].value[value_len] = '\0';
    rt->store[rt->store_count].value_len = value_len;
    rt->store_count++;

    cb(cb_data, 0, "ok", 2);
}

void uv_io_storage_del(qz_t *rt, const char *key,
                               qz_io_done_t cb, void *cb_data)
{
    int i;

    if (!key) {
        cb(cb_data, QZ_ERR_INVALID_ARG, "invalid key", 11);
        return;
    }

    for (i = 0; i < rt->store_count; i++) {
        if (strcmp(rt->store[i].key, key) == 0) {
            free(rt->store[i].key);
            free(rt->store[i].value);
            /* Shift remaining entries down */
            int j;
            for (j = i; j < rt->store_count - 1; j++) {
                rt->store[j] = rt->store[j + 1];
            }
            rt->store_count--;
            cb(cb_data, 0, "ok", 2);
            return;
        }
    }

    cb(cb_data, QZ_ERR_NOT_FOUND, "not found", 9);
}

/* ================================================================
 * Filesystem operations
 * ================================================================ */

/* Lazily allocate the per-runtime storage area. uv_io owns rt->store
 * directly (previously uv_io_create_with_config allocated it); qzjs.c
 * frees rt->store at teardown. */
static void uv_io_storage_init(qz_t *rt)
{
    if (rt->store) return;
    rt->storage_max = PAL_UV_STORAGE_DEFAULT;
    rt->store = (uv_io_store_entry_t *)calloc((size_t)rt->storage_max,
                                              sizeof(uv_io_store_entry_t));
    if (!rt->store) rt->storage_max = 0;
}

/* --- fs_read: open -> read loop -> close -> callback --- */

static void uv_io_fs_read_close_cb(uv_fs_t *req)
{
    uv_io_fs_op_t *op = (uv_io_fs_op_t *)req->data;
    uv_fs_req_cleanup(req);

    /* Zero-copy error path: release the externally-owned backing before the
     * cleanup free below would double-free it (the error callback itself has
     * already fired synchronously from read_cb). Success hands the backing to
     * the done callback — uv_io must not free it. */
    if (op->err && op->owner && op->free_fn) {
        op->free_fn(op->alloc_ud, op->owner);
        op->owner = NULL;
    }
    if (op->cb) {
        op->cb(op->cb_data, 0, op->buf, op->buf_len);
    }

    if (!op->owner)
        free(op->buf);
    free(op);
}

/* Grow op->buf to at least new_cap. In zero-copy mode the backing store is
 * owned by the allocator (e.g. a JS ArrayBuffer) and cannot be realloc'd:
 * release it and fall back to a plain malloc buffer, copying what has been
 * read so far. Returns the (possibly new) buffer, or NULL on OOM. */
static char *uv_io_fs_read_grow(uv_io_fs_op_t *op, size_t new_cap)
{
    char *new_buf;
    if (op->owner && op->free_fn) {
        /* Copy BEFORE releasing the backing: free_fn may free op->buf
         * (e.g. the engine finalizer), so reading from it afterwards is
         * a use-after-free. */
        new_buf = (char *)malloc(new_cap);
        if (new_buf && op->buf_len)
            memcpy(new_buf, op->buf, op->buf_len);
        op->free_fn(op->alloc_ud, op->owner);
        op->owner = NULL;
        if (!new_buf)
            op->buf = NULL;  /* close_cb must not free the released backing */
    } else {
        new_buf = (char *)realloc(op->buf, new_cap);
    }
    return new_buf;
}

static void uv_io_fs_read_cb(uv_fs_t *req)
{
    uv_io_fs_op_t *op = (uv_io_fs_op_t *)req->data;
    ssize_t result = req->result;

    if (result < 0) {
        uv_fs_req_cleanup(req);
        /* Read error */
        uv_fs_close(&op->rt->loop, &op->fs_req, op->fd,
                     uv_io_fs_read_close_cb);
        /* op->buf will be freed in close_cb; set cb to NULL to avoid
         * double-callback, then do error callback from close_cb.
         * Actually, we need to deliver the error. Let's do it here
         * and clean up in close_cb without calling cb again. */
        qz_io_done_t cb = op->cb;
        void *cb_data = op->cb_data;
        op->err = 1;
        /* Release the zero-copy backing BEFORE the error callback fires:
         * the callback frees the allocator state, so free_fn must not run
         * afterwards from close_cb. */
        if (op->owner && op->free_fn) {
            op->free_fn(op->alloc_ud, op->owner);
            op->owner = NULL;
            op->buf = NULL;
        }
        op->cb = NULL;
        cb(cb_data, QZ_ERR_GENERIC, "read error", 10);
        return;
    }

    if (op->probing) {
        /* EOF probe result: 0 means we are truly at EOF (deliver the
         * zero-copy backing as-is); 1 means the file grew past fstat's size,
         * so fall back to a malloc buffer and keep the probe byte. */
        op->probing = 0;
        if (result == 0) {
            uv_fs_close(&op->rt->loop, &op->fs_req, op->fd,
                         uv_io_fs_read_close_cb);
            return;
        }
        uv_fs_req_cleanup(req);
        size_t new_cap = op->buf_cap + PAL_UV_FS_BUF_INIT;
        char *new_buf = uv_io_fs_read_grow(op, new_cap);
        if (!new_buf) {
            qz_io_done_t cb = op->cb;
            void *cb_data = op->cb_data;
            op->cb = NULL;
            uv_fs_close(&op->rt->loop, &op->fs_req, op->fd,
                         uv_io_fs_read_close_cb);
            cb(cb_data, QZ_ERR_GENERIC, "out of memory", 13);
            return;
        }
        op->buf = new_buf;
        op->buf_cap = new_cap;
        op->buf[op->buf_len] = op->probe[0];
        op->buf_len += 1;
        /* keep reading from the new offset */
        uv_buf_t iov;
        iov.base = op->buf + op->buf_len;
        iov.len = op->buf_cap - op->buf_len;
        uv_fs_read(&op->rt->loop, &op->fs_req, op->fd, &iov, 1,
                   QZ_ERR_GENERIC, uv_io_fs_read_cb);
        return;
    }
    if (result == 0) {
        /* EOF — close file and deliver data */
        uv_fs_close(&op->rt->loop, &op->fs_req, op->fd,
                     uv_io_fs_read_close_cb);
        return;
    }

    /* success: uv_fs_read wrote the bytes directly into op->buf + op->buf_len
     * (the iov we passed to libuv). Just advance buf_len — no copy needed;
     * realloc below preserves the accumulated bytes. */
    uv_fs_req_cleanup(req);
    size_t new_len = op->buf_len + (size_t)result;
    if (new_len > op->buf_cap) {
        size_t new_cap = op->buf_cap * 2;
        if (new_cap < new_len) new_cap = new_len;
        char *new_buf = uv_io_fs_read_grow(op, new_cap);
        if (!new_buf) {
            qz_io_done_t cb = op->cb;
            void *cb_data = op->cb_data;
            op->cb = NULL;
            uv_fs_close(&op->rt->loop, &op->fs_req, op->fd,
                         uv_io_fs_read_close_cb);
            cb(cb_data, QZ_ERR_GENERIC, "out of memory", 13);
            return;
        }
        op->buf = new_buf;
        op->buf_cap = new_cap;
    }
    op->buf_len = new_len;

    /* Read more */
    uv_buf_t iov;
    iov.base = op->buf + op->buf_len;
    iov.len = op->buf_cap - op->buf_len;
    if (iov.len == 0) {
        if (op->owner) {
            /* Zero-copy backing is exactly fstat's size and it is now full:
             * probe one byte to tell EOF (deliver the backing untouched)
             * from a file that grew mid-read (fall back to a malloc buf). */
            op->probe[0] = 0;
            op->probing = 1;
            uv_buf_t p = { op->probe, 1 };
            uv_fs_read(&op->rt->loop, &op->fs_req, op->fd, &p, 1,
                       QZ_ERR_GENERIC, uv_io_fs_read_cb);
            return;
        }
        iov.len = PAL_UV_FS_BUF_INIT;
        /* Grow buffer */
        size_t new_cap = op->buf_cap + PAL_UV_FS_BUF_INIT;
        char *new_buf = uv_io_fs_read_grow(op, new_cap);
        if (!new_buf) {
            qz_io_done_t cb = op->cb;
            void *cb_data = op->cb_data;
            op->cb = NULL;
            uv_fs_close(&op->rt->loop, &op->fs_req, op->fd,
                         uv_io_fs_read_close_cb);
            cb(cb_data, QZ_ERR_GENERIC, "out of memory", 13);
            return;
        }
        op->buf = new_buf;
        op->buf_cap = new_cap;
        iov.base = op->buf + op->buf_len;
        iov.len = op->buf_cap - op->buf_len;
    }
    uv_fs_read(&op->rt->loop, &op->fs_req, op->fd, &iov, 1, QZ_ERR_GENERIC,
               uv_io_fs_read_cb);
}

static void uv_io_fs_read_open_cb(uv_fs_t *req)
{
    uv_io_fs_op_t *op = (uv_io_fs_op_t *)req->data;
    ssize_t result = req->result;
    uv_fs_req_cleanup(req);

    if (result < 0) {
        /* Open failed */
        const char *msg = "file not found";
        op->cb(op->cb_data, QZ_ERR_NOT_FOUND, msg, (size_t)strlen(msg));
        free(op->buf);
        free(op);
        return;
    }

    op->fd = (uv_file)result;

    /* Zero-copy mode: size the destination with a cheap synchronous fstat
     * (loop thread) and let the allocator provision the backing store; libuv
     * then reads straight into it. Fall back to the malloc buffer when no
     * allocator is set, the stat fails, or the file is empty. */
    if (op->alloc_fn) {
        struct stat st;
        if (fstat(op->fd, &st) == 0 && st.st_size > 0) {
            void *owner = NULL;
            char *backing = (char *)op->alloc_fn(op->alloc_ud,
                                                 (size_t)st.st_size, &owner);
            if (backing) {
                op->buf = backing;
                op->buf_cap = (size_t)st.st_size;
                op->owner = owner;
            }
        }
        if (!op->buf) {
            op->buf_cap = PAL_UV_FS_BUF_INIT;
            op->buf = (char *)malloc(op->buf_cap);
            if (!op->buf) {
                /* 先置 op->cb = NULL 再调 cb：否则 uv_fs_close 后 close_cb
                 * （uv_io_fs_read_close_cb）会二次回调同一 cb（double-free/
                 * UAF）。仿 fs_read_cb 的错误路径（cb = NULL → close → cb）。 */
                qz_io_done_t cb = op->cb;
                op->cb = NULL;
                uv_fs_close(&op->rt->loop, &op->fs_req, op->fd,
                             uv_io_fs_read_close_cb);
                cb(op->cb_data, QZ_ERR_GENERIC, "out of memory", 13);
                return;
            }
        }
    }

    /* Start reading */
    uv_buf_t iov;
    iov.base = op->buf;
    iov.len = op->buf_cap;
    uv_fs_read(&op->rt->loop, &op->fs_req, op->fd, &iov, 1, QZ_ERR_GENERIC,
               uv_io_fs_read_cb);
}

void uv_io_fs_read_ex(qz_t *rt, const char *path,
                      qz_io_done_t cb, void *cb_data,
                      qz_fs_alloc_fn alloc_fn, qz_fs_free_fn free_fn,
                      void *alloc_ud)
{
    if (!path) {
        cb(cb_data, QZ_ERR_INVALID_ARG, "invalid path", 12);
        return;
    }

    uv_io_fs_op_t *op = (uv_io_fs_op_t *)calloc(1, sizeof(*op));
    if (!op) {
        cb(cb_data, QZ_ERR_GENERIC, "out of memory", 13);
        return;
    }

    op->cb = cb;
    op->cb_data = cb_data;
    op->rt = rt;
    op->fs_req.data = op;
    op->alloc_fn = alloc_fn;
    op->free_fn = free_fn;
    op->alloc_ud = alloc_ud;
    if (!alloc_fn) {
        op->buf_cap = PAL_UV_FS_BUF_INIT;
        op->buf = (char *)malloc(op->buf_cap);
        if (!op->buf) {
            free(op);
            cb(cb_data, QZ_ERR_GENERIC, "out of memory", 13);
            return;
        }
    }

    uv_fs_open(&rt->loop, &op->fs_req, path, O_RDONLY, 0,
               uv_io_fs_read_open_cb);
}

void uv_io_fs_read(qz_t *rt, const char *path,
                   qz_io_done_t cb, void *cb_data)
{
    uv_io_fs_read_ex(rt, path, cb, cb_data, NULL, NULL, NULL);
}

/* --- fs_write: open -> write -> close -> callback --- */

static void uv_io_fs_write_close_cb(uv_fs_t *req)
{
    uv_io_fs_op_t *op = (uv_io_fs_op_t *)req->data;
    uv_fs_req_cleanup(req);

    if (op->cb) {
        op->cb(op->cb_data, 0, "ok", 2);
    }

    free(op->buf);
    free(op);
}

static void uv_io_fs_write_cb(uv_fs_t *req)
{
    uv_io_fs_op_t *op = (uv_io_fs_op_t *)req->data;
    ssize_t result = req->result;
    uv_fs_req_cleanup(req);

    if (result < 0) {
        qz_io_done_t cb = op->cb;
        void *cb_data = op->cb_data;
        op->cb = NULL;
        uv_fs_close(&op->rt->loop, &op->fs_req, op->fd,
                     uv_io_fs_write_close_cb);
        cb(cb_data, QZ_ERR_GENERIC, "write error", 11);
        return;
    }

    /* Check if all data was written */
    if ((size_t)result < op->buf_len) {
        /* Partial write — write remaining */
        op->buf_offset += (size_t)result;
        op->buf_len -= (size_t)result;
        uv_buf_t iov;
        iov.base = op->buf + op->buf_offset;
        iov.len = op->buf_len;
        uv_fs_write(&op->rt->loop, &op->fs_req, op->fd, &iov, 1, QZ_ERR_GENERIC,
                     uv_io_fs_write_cb);
        return;
    }

    /* All written — close file */
    uv_fs_close(&op->rt->loop, &op->fs_req, op->fd,
                 uv_io_fs_write_close_cb);
}

static void uv_io_fs_write_open_cb(uv_fs_t *req)
{
    uv_io_fs_op_t *op = (uv_io_fs_op_t *)req->data;
    ssize_t result = req->result;
    uv_fs_req_cleanup(req);

    if (result < 0) {
        op->cb(op->cb_data, QZ_ERR_GENERIC, "cannot open file for writing", 28);
        free(op->buf);
        free(op);
        return;
    }

    op->fd = (uv_file)result;

    uv_buf_t iov;
    iov.base = op->buf + op->buf_offset;
    iov.len = op->buf_len;
    uv_fs_write(&op->rt->loop, &op->fs_req, op->fd, &iov, 1, QZ_ERR_GENERIC,
                 uv_io_fs_write_cb);
}

void uv_io_fs_write(qz_t *rt, const char *path,
                            const char *data, size_t data_len,
                            qz_io_done_t cb, void *cb_data)
{

    if (!path) {
        cb(cb_data, QZ_ERR_INVALID_ARG, "invalid path", 12);
        return;
    }

    uv_io_fs_op_t *op = (uv_io_fs_op_t *)calloc(1, sizeof(*op));
    if (!op) {
        cb(cb_data, QZ_ERR_GENERIC, "out of memory", 13);
        return;
    }

    op->cb = cb;
    op->cb_data = cb_data;
    op->rt = rt;
    op->fs_req.data = op;
    op->buf_len = data_len;
    op->buf_offset = 0;
    op->buf = (char *)malloc(data_len);
    if (!op->buf) {
        free(op);
        cb(cb_data, QZ_ERR_GENERIC, "out of memory", 13);
        return;
    }
    memcpy(op->buf, data, data_len);

    uv_fs_open(&rt->loop, &op->fs_req, path,
               O_WRONLY | O_CREAT | O_TRUNC, 0644,
               uv_io_fs_write_open_cb);
}

/* --- fs_exists: stat -> callback --- */

static void uv_io_fs_exists_cb(uv_fs_t *req)
{
    uv_io_fs_op_t *op = (uv_io_fs_op_t *)req->data;
    uv_fs_req_cleanup(req);

    if (req->result == 0) {
        op->cb(op->cb_data, 0, "true", 4);
    } else {
        op->cb(op->cb_data, 0, "false", 5);
    }

    free(op);
}

void uv_io_fs_exists(qz_t *rt, const char *path,
                             qz_io_done_t cb, void *cb_data)
{

    if (!path) {
        cb(cb_data, QZ_ERR_INVALID_ARG, "invalid path", 12);
        return;
    }

    uv_io_fs_op_t *op = (uv_io_fs_op_t *)calloc(1, sizeof(*op));
    if (!op) {
        cb(cb_data, QZ_ERR_GENERIC, "out of memory", 13);
        return;
    }

    op->cb = cb;
    op->cb_data = cb_data;
    op->rt = rt;
    op->fs_req.data = op;

    uv_fs_stat(&rt->loop, &op->fs_req, path, uv_io_fs_exists_cb);
}

/* --- fs_remove: unlink -> callback --- */

static void uv_io_fs_remove_cb(uv_fs_t *req)
{
    uv_io_fs_op_t *op = (uv_io_fs_op_t *)req->data;
    uv_fs_req_cleanup(req);

    if (req->result == 0) {
        op->cb(op->cb_data, 0, "ok", 2);
    } else {
        int err = (req->result == UV_ENOENT) ? -2 : -1;
        const char *msg = (req->result == UV_ENOENT) ? "not found" : "remove error";
        size_t msg_len = (size_t)strlen(msg);
        op->cb(op->cb_data, err, msg, msg_len);
    }

    free(op);
}

void uv_io_fs_remove(qz_t *rt, const char *path,
                             qz_io_done_t cb, void *cb_data)
{

    if (!path) {
        cb(cb_data, QZ_ERR_INVALID_ARG, "invalid path", 12);
        return;
    }

    uv_io_fs_op_t *op = (uv_io_fs_op_t *)calloc(1, sizeof(*op));
    if (!op) {
        cb(cb_data, QZ_ERR_GENERIC, "out of memory", 13);
        return;
    }

    op->cb = cb;
    op->cb_data = cb_data;
    op->rt = rt;
    op->fs_req.data = op;

    uv_fs_unlink(&rt->loop, &op->fs_req, path, uv_io_fs_remove_cb);
}

/* --- fs_list: scandir -> collect entries -> callback --- */

static void uv_io_fs_list_cb(uv_fs_t *req)
{
    uv_io_fs_op_t *op = (uv_io_fs_op_t *)req->data;

    if (req->result < 0) {
        uv_fs_req_cleanup(req);
        op->cb(op->cb_data, QZ_ERR_GENERIC, "scandir error", 13);
        free(op);
        return;
    }

    /* Collect directory entries */
    int count = 0;
    int cap = 32;
    char **names = (char **)malloc(sizeof(char *) * (size_t)cap);
    if (!names) {
        uv_fs_req_cleanup(req);
        op->cb(op->cb_data, QZ_ERR_GENERIC, "out of memory", 13);
        free(op);
        return;
    }

    uv_dirent_t dent;
    while (uv_fs_scandir_next(req, &dent) != UV_EOF) {
        /* Skip . and .. */
        if (strcmp(dent.name, ".") == 0 || strcmp(dent.name, "..") == 0) {
            continue;
        }

        if (count >= cap) {
            cap *= 2;
            char **new_names = (char **)realloc(names, sizeof(char *) * (size_t)cap);
            if (!new_names) {
                int j;
                for (j = 0; j < count; j++) free(names[j]);
                free(names);
                uv_fs_req_cleanup(req);
                op->cb(op->cb_data, QZ_ERR_GENERIC, "out of memory", 13);
                free(op);
                return;
            }
            names = new_names;
        }

        names[count] = strdup(dent.name);
        if (!names[count]) {
            int j;
            for (j = 0; j < count; j++) free(names[j]);
            free(names);
            uv_fs_req_cleanup(req);
            op->cb(op->cb_data, QZ_ERR_GENERIC, "out of memory", 13);
            free(op);
            return;
        }
        count++;
    }

    uv_fs_req_cleanup(req);

    /* Build JSON array */
    size_t json_len;
    char *json = uv_io_build_json_array((const char *const *)names, count, &json_len);

    /* Free names */
    int i;
    for (i = 0; i < count; i++) {
        free(names[i]);
    }
    free(names);

    if (!json) {
        op->cb(op->cb_data, QZ_ERR_GENERIC, "out of memory", 13);
        free(op);
        return;
    }

    op->cb(op->cb_data, 0, json, json_len);
    free(json);
    free(op);
}

void uv_io_fs_list(qz_t *rt, const char *path,
                           qz_io_done_t cb, void *cb_data)
{

    if (!path) {
        cb(cb_data, QZ_ERR_INVALID_ARG, "invalid path", 12);
        return;
    }

    uv_io_fs_op_t *op = (uv_io_fs_op_t *)calloc(1, sizeof(*op));
    if (!op) {
        cb(cb_data, QZ_ERR_GENERIC, "out of memory", 13);
        return;
    }

    op->cb = cb;
    op->cb_data = cb_data;
    op->rt = rt;
    op->fs_req.data = op;

    uv_fs_scandir(&rt->loop, &op->fs_req, path, 0, uv_io_fs_list_cb);
}

/* ================================================================
 * HTTP operation (uv_tcp based)
 *
 * Parses URL, connects via TCP, sends HTTP request, reads response.
 * Response is parsed to extract status code, headers, and body.
 * Supports DNS resolution via uv_getaddrinfo.
 * Supports Content-Length and chunked transfer-encoding.
 * HTTPS URLs are detected but require QZ_WITH_TLS compile flag.
 * Connect timeout of 30 seconds via uv_timer_t.
 * Callback receives JSON: {"status":NNN,"headers":{...},"body":"..."}
 * ================================================================ */

/* Parse HTTP response headers from the response buffer.
 * Sets http_status, finds header region, finds body start.
 * Also extracts Content-Length and checks for chunked transfer-encoding.
 * Returns 0 if headers are complete, -1 if not yet. */
static int parse_http_response(uv_io_http_op_t *op)
{
    /* Find \r\n\r\n marking end of headers */
    char *hdr_end = NULL;
    size_t i;
    for (i = 3; i < op->resp_buf_len; i++) {
        if (op->resp_buf[i - 3] == '\r' && op->resp_buf[i - 2] == '\n' &&
            op->resp_buf[i - 1] == '\r' && op->resp_buf[i] == '\n') {
            hdr_end = op->resp_buf + i + 1;
            op->header_end_offset = (size_t)(hdr_end - op->resp_buf);
            break;
        }
    }

    if (!hdr_end) {
        return -1; /* headers not complete yet */
    }

    /* Parse status line: HTTP/1.x NNN ... */
    char *line_start = op->resp_buf;
    char *line_end = NULL;

    /* Find end of status line */
    for (i = 0; i < op->header_end_offset; i++) {
        if (op->resp_buf[i] == '\r' && op->resp_buf[i + 1] == '\n') {
            line_end = op->resp_buf + i;
            break;
        }
    }

    if (!line_end) return -1;

    /* Find the status code after "HTTP/1.x " */
    char *sp = line_start;
    while (sp < line_end && *sp != ' ') sp++;
    if (sp >= line_end) return -1;
    sp++; /* skip the space */

    /* Parse 3-digit status code */
    op->http_status = 0;
    int digits = 0;
    while (sp < line_end && *sp >= '0' && *sp <= '9' && digits < 3) {
        op->http_status = op->http_status * 10 + (*sp - '0');
        sp++;
        digits++;
    }

    if (digits == 0) return -1;

    /* Scan headers for Content-Length and Transfer-Encoding: chunked.
     * Header region starts after the status line (\r\n) and ends at
     * header_end_offset - 4 (the \r\n\r\n). */
    const char *hdrs = op->resp_buf + (line_end - op->resp_buf) + 2;
    const char *hdrs_end = op->resp_buf + op->header_end_offset - 4;

    op->body_expected = 0;
    op->chunked = 0;

    const char *hp = hdrs;
    while (hp < hdrs_end) {
        /* Find end of this header line */
        const char *eol = hp;
        while (eol < hdrs_end && !(*eol == '\r' && (eol + 1 < hdrs_end) && *(eol + 1) == '\n')) {
            eol++;
        }

        /* Check for Content-Length (case-insensitive) */
        if (eol - hp > 15 && strncasecmp(hp, "Content-Length:", 15) == 0) {
            const char *val = hp + 15;
            while (val < eol && (*val == ' ' || *val == '\t')) val++;
            unsigned long long cl = strtoull(val, NULL, 10);
            /* Clamp to SIZE_MAX to avoid truncation on 32-bit platforms */
            op->body_expected = cl > SIZE_MAX ? SIZE_MAX : (size_t)cl;
        }

        /* Check for Transfer-Encoding: chunked (case-insensitive). Require
         * >= 18 chars (header name + colon) - NOT > 26, which misses
         * "Transfer-Encoding: chunked" (exactly 26 chars) exactly. Matches the
         * streaming scanner's check below. */
        if (eol - hp >= 18 && strncasecmp(hp, "Transfer-Encoding:", 18) == 0) {
            const char *val = hp + 18;
            while (val < eol && (*val == ' ' || *val == '\t')) val++;
            if (eol - val >= 7 && strncasecmp(val, "chunked", 7) == 0) {
                op->chunked = 1;
            }
        }

        /* Move to next line */
        hp = eol + 2;
        if (hp > hdrs_end) hp = hdrs_end;
    }

    op->headers_done = 1;
    return 0;
}

/* Forward declarations for HTTP operations */
static void uv_io_http_finish_error(uv_io_http_op_t *op, int status,
                                     const char *msg);
static void uv_io_http_finish_success(uv_io_http_op_t *op);
static void uv_io_http_stream_close_cb(uv_handle_t *handle);

static void uv_io_http_cleanup(uv_io_http_op_t *op)
{
    /* This is the final free for every HTTP op (streaming and non-streaming,
     * normal/error/abort paths all funnel here before free(op)). Clear the
     * PAL's active_stream tracker if it still points at us, so a later
     * uv_io_http_abort() never dereferences a freed op. */
    if (op->rt && op->rt->active_stream == op) {
        op->rt->active_stream = NULL;
    }

    /* Unlink from the per-op abort registry. Streaming ops register here at
     * start; removing the node now means uv_io_http_abort_by_id can never
     * resolve a stale handle to this (about-to-be-freed) op. */
    if (op->rt && op->rt->http_ops) {
        struct uv_io_http_op_t **pp = &op->rt->http_ops;
        while (*pp && *pp != op) pp = &(*pp)->next;
        if (*pp == op) *pp = op->next;
        op->next = NULL;
    }

    /* Untrack all handles that belong to this op. The TCP close callback
     * (uv_io_http_close_cb / uv_io_http_stream_close_cb) untracks the TCP
     * handle, but the timer close callback (uv_io_http_timer_close_cb) does
     * NOT — it can't safely access op (may already be freed). So we untrack
     * the timers here, before free(op), to prevent dangling pointers in the
     * handles[] array that would cause uv_close assertions in uv_io_destroy. */
    if (op->rt) {
        if (op->timer_init) {
        }
        if (op->idle_timer_init) {
        }
        /* TCP may or may not have been untracked by the close callback yet.
         * untrack is safe to call even if already removed (no-op if not found). */
        if (op->tcp_init) {
        }
    }
#if QZ_WITH_TLS
    if (op->use_tls) {
        tls_free_op(op);
    }
#endif
    if (op->host) free(op->host);
    if (op->path) free(op->path);
    if (op->method) free(op->method);
    if (op->headers_json) free(op->headers_json);
    if (op->body) free(op->body);
    if (op->req_buf) free(op->req_buf);
    if (op->resp_buf) free(op->resp_buf);
    if (op->resp_headers) free(op->resp_headers);
    if (op->proxy_host) free(op->proxy_host);
    if (op->proxy_buf) free(op->proxy_buf);
    free(op);
}

static void uv_io_http_close_handle(uv_io_http_op_t *op, uv_handle_t *h,
                                     uv_close_cb cb)
{
    /* Only teardown-phase closes count toward the teardown refcount; mid-life
     * closes (tearing_down == 0) increment a separate uncounted counter so
     * their close callbacks — which may fire after teardown begins — never
     * drain closes_pending (which would free op before the counted handles'
     * close callbacks run → UAF). */
    if (op->tearing_down)
        op->closes_pending++;
    else
        op->closes_uncounted++;
    uv_close(h, cb);
}

/* Called from a handle's close callback: one fewer pending close. Frees op when
 * the last teardown close fires. Safe for any of op's handles (tcp,
 * connect_timer, idle_timer) - all set .data = op. An uncounted (mid-life)
 * close consumes one closes_uncounted and does NOT touch closes_pending, even
 * when its close callback runs after teardown started. */
static void uv_io_http_close_done(uv_io_http_op_t *op)
{
    if (op->closes_uncounted > 0) {
        /* mid-life（uncounted）close 回调 */
        op->closes_uncounted--;
        /* 若这是最后一个 uncounted，且 teardown 已开始但计数 close 已全部
         * 发出（pending == 0 —— finalize 因 uncounted>0 未 free 的场景），
         * 由我们补上 cleanup，避免泄漏。 */
        if (op->tearing_down && op->closes_uncounted == 0 &&
            op->closes_pending == 0) {
            uv_io_http_cleanup(op);
        }
        return;
    }
    if (op->tearing_down && --op->closes_pending == 0) {
        uv_io_http_cleanup(op);
    }
}

/* Called from a teardown path after uv_close'ing the handles it needs to. If no
 * closes are pending, frees op now; otherwise the pending close callbacks free
 * it when the last fires. Replaces direct uv_io_http_cleanup() calls in
 * teardown paths, which could free op while a timer close was still pending. */
static void uv_io_http_finalize(uv_io_http_op_t *op)
{
    if (op->closes_pending == 0 && op->closes_uncounted == 0) {
        uv_io_http_cleanup(op);
    }
}

static void uv_io_http_close_cb(uv_handle_t *handle)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)handle->data;
    uv_io_http_close_done(op);
}

/* Close callback for the connect_timer and idle_timer. Decrements the
 * teardown close refcount; op is freed when the last of its handles
 * (tcp + timers) closes. A no-op for mid-life closes (tearing_down 0). */
static void uv_io_http_timer_close_cb(uv_handle_t *handle)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)handle->data;
    uv_io_http_close_done(op);
}

static void uv_io_http_finish_error(uv_io_http_op_t *op, int status,
                                     const char *msg)
{
    size_t msg_len = strlen(msg);
    op->tearing_down = 1;

    /* Stop and close the connect timer if initialized and active */
    if (op->timer_init && op->connect_timer.data &&
        !uv_is_closing((uv_handle_t *)&op->connect_timer)) {
        uv_timer_stop(&op->connect_timer);
        uv_io_http_close_handle(op, (uv_handle_t *)&op->connect_timer, uv_io_http_timer_close_cb);
    }

    if (op->streaming) {
        /* Streaming mode: deliver error via on_end callback */
        if (op->stream_ops.on_end) {
            op->stream_ops.on_end(op->stream_ops.user_data, status, msg);
        }
        if (op->tcp_init && !uv_is_closing((uv_handle_t *)&op->tcp)) {
            uv_io_http_close_handle(op, (uv_handle_t *)&op->tcp, uv_io_http_stream_close_cb);
        } else {
            uv_io_http_finalize(op);
        }
        return;
    }

    op->cb(op->cb_data, status, msg, msg_len);
    if (op->tcp_init && !uv_is_closing((uv_handle_t *)&op->tcp)) {
        uv_io_http_close_handle(op, (uv_handle_t *)&op->tcp, uv_io_http_close_cb);
    } else {
        /* TCP never init'd (DNS failed) — clean up directly */
        uv_io_http_finalize(op);
    }
}

static void uv_io_http_finish_success(uv_io_http_op_t *op)
{
    op->tearing_down = 1;
    /* Stop and close the connect timer if initialized and active */
    if (op->timer_init && op->connect_timer.data &&
        !uv_is_closing((uv_handle_t *)&op->connect_timer)) {
        uv_timer_stop(&op->connect_timer);
        uv_io_http_close_handle(op, (uv_handle_t *)&op->connect_timer, uv_io_http_timer_close_cb);
    }

    /* Parse headers and build JSON response */
    char *headers_json = NULL;
    size_t headers_json_len = 0;

    /* Find the header region (after status line, before \r\n\r\n) */
    const char *status_line_end = NULL;
    size_t i;
    for (i = 0; i < op->header_end_offset; i++) {
        if (op->resp_buf[i] == '\r' && op->resp_buf[i + 1] == '\n') {
            status_line_end = op->resp_buf + i + 2;
            break;
        }
    }

    if (status_line_end) {
        size_t hdr_len = op->resp_buf + op->header_end_offset - 4 - status_line_end;
        headers_json = uv_io_build_headers_json(status_line_end, hdr_len,
                                              &headers_json_len);
    }

    const char *body_start = op->resp_buf + op->header_end_offset;
    size_t body_len = op->resp_buf_len - op->header_end_offset;

    size_t json_len;
    char *json = uv_io_build_http_json(op->http_status,
                                 headers_json ? headers_json : "{}",
                                 headers_json ? headers_json_len : 2,
                                 body_start, body_len, &json_len);
    free(headers_json);

    if (json) {
        op->cb(op->cb_data, 0, json, json_len);
        free(json);
    } else {
        op->cb(op->cb_data, QZ_ERR_GENERIC, "out of memory", 13);
    }

    if (!uv_is_closing((uv_handle_t *)&op->tcp)) {
        uv_io_http_close_handle(op, (uv_handle_t *)&op->tcp, uv_io_http_close_cb);
    }
}

/* ================================================================
 * Chunked transfer-encoding body processor
 *
 * Processes body data starting at body_start for body_len bytes.
 * The decoded body is written back into op->resp_buf starting at
 * op->header_end_offset, compacting in place.
 *
 * Returns:
 *   1  — chunked body is complete (final 0-length chunk seen)
 *   0  — need more data
 *  -1  — parse error
 * ================================================================ */

static int process_chunked_body(uv_io_http_op_t *op,
                                size_t body_offset, size_t body_len)
{
    /* Decoded chunks are written into resp_buf at
     * [header_end_offset + chunk_write_pos, ...). Raw encoded bytes are read
     * from resp_buf + body_offset + chunk_raw_consumed up to
     * resp_buf + body_offset + body_len. body_offset 是 resp_buf 内的相对偏移
     * （= header_end_offset），不是指针：本函数内 realloc(op->resp_buf) 会搬移
     * 内存，调用方按旧指针传入的 body_start 会悬空（UAF）。每次进入都从
     * op->resp_buf 按偏移重建源指针，realloc 分支同样重建。 */
    size_t write_pos = op->header_end_offset + op->chunk_write_pos;
    const char *body_start = op->resp_buf + body_offset;
    const char *p = body_start + op->chunk_raw_consumed;
    const char *end = body_start + body_len;

    while (p < end) {
        if (op->chunk_state == CHUNK_STATE_SIZE) {
            /* Reading chunk-size line. Look for \r\n. */
            const char *eol = p;
            while (eol < end && !(*eol == '\r' && (eol + 1 < end) && *(eol + 1) == '\n')) {
                eol++;
            }

            if (eol >= end) {
                /* Partial chunk-size line - save what we have */
                size_t avail = (size_t)(end - p);
                if (op->chunk_size_buf_len + avail < sizeof(op->chunk_size_buf) - 1) {
                    memcpy(op->chunk_size_buf + op->chunk_size_buf_len, p, avail);
                    op->chunk_size_buf_len += avail;
                }
                op->chunk_raw_consumed = (size_t)(p - body_start);
                break; /* need more data */
            }

            /* We have a complete chunk-size line.
             * Combine with any previously buffered partial. */
            char size_buf[32];
            size_t size_buf_len = op->chunk_size_buf_len;
            if (size_buf_len > 0) {
                if (size_buf_len >= sizeof(size_buf)) size_buf_len = sizeof(size_buf) - 1;
                memcpy(size_buf, op->chunk_size_buf, size_buf_len);
                op->chunk_size_buf_len = 0;
            }
            size_t line_len = (size_t)(eol - p);
            if (size_buf_len + line_len >= sizeof(size_buf))
                line_len = sizeof(size_buf) - 1 - size_buf_len;
            memcpy(size_buf + size_buf_len, p, line_len);
            size_buf_len += line_len;
            size_buf[size_buf_len] = '\0';

            /* Parse chunk size (hex, may have extensions after ;) */
            size_t chunk_size = (size_t)strtoul(size_buf, NULL, 16);

            /* Reject oversized chunks (DoS protection — matches streaming path) */
            if (errno == ERANGE || chunk_size > PAL_UV_MAX_CHUNK_SIZE) {
                return -1; /* chunk too large or overflow */
            }

            if (chunk_size == 0) {
                /* Final chunk - skip trailing \r\n and we're done */
                p = eol + 2;
                op->chunk_state = CHUNK_STATE_DONE;
                op->chunk_raw_consumed = (size_t)(p - body_start);
                op->chunk_write_pos = write_pos - op->header_end_offset;
                op->resp_buf_len = op->header_end_offset + op->chunk_write_pos;
                return 1;
            }

            op->chunk_remaining = chunk_size;
            op->chunk_state = CHUNK_STATE_DATA;
            p = eol + 2; /* skip \r\n after chunk-size */

        } else if (op->chunk_state == CHUNK_STATE_DATA) {
            /* Read chunk data bytes */
            size_t avail = (size_t)(end - p);
            size_t to_copy = avail < op->chunk_remaining ? avail : op->chunk_remaining;

            /* Ensure resp_buf has space */
            if (write_pos + to_copy > op->resp_buf_cap) {
                size_t new_cap = op->resp_buf_cap * 2;
                if (new_cap < write_pos + to_copy) new_cap = write_pos + to_copy;
                char *new_buf = (char *)realloc(op->resp_buf, new_cap);
                if (!new_buf) return -1;
                op->resp_buf = new_buf;
                op->resp_buf_cap = new_cap;
                /* realloc 可能搬移内存：body_start/p/end 都是按旧指针算的，
                 * 必须按偏移从新 resp_buf 重建（否则继续解引用悬空指针）。 */
                size_t consumed = (size_t)(p - body_start);
                body_start = op->resp_buf + body_offset;
                p = body_start + consumed;
                end = body_start + body_len;
            }

            /* memmove, not memcpy: decoded bytes are compacted back into
             * resp_buf starting at write_pos while the source chunk data p may
             * sit further in the same buffer - regions can overlap. */
            memmove(op->resp_buf + write_pos, p, to_copy);
            write_pos += to_copy;
            p += to_copy;
            op->chunk_remaining -= to_copy;

            if (op->chunk_remaining == 0) {
                op->chunk_state = CHUNK_STATE_TRAILER;
            }

        } else if (op->chunk_state == CHUNK_STATE_TRAILER) {
            /* Expect \r\n after chunk data */
            if (end - p < 2) {
                /* Need more data for the trailer \r\n */
                op->chunk_raw_consumed = (size_t)(p - body_start);
                break;
            }
            if (p[0] != '\r' || p[1] != '\n') {
                return -1; /* malformed */
            }
            p += 2;
            op->chunk_state = CHUNK_STATE_SIZE;

        } else if (op->chunk_state == CHUNK_STATE_DONE) {
            break;
        }
    }

    /* Persist decode progress for the next read. Do NOT shrink resp_buf_len:
     * process_data appends new raw bytes at resp_buf_len, so shrinking would
     * make the next read overwrite the decoded region. resp_buf_len keeps the
     * raw length; only on completion (above) do we set it to the decoded length. */
    op->chunk_raw_consumed = (size_t)(p - body_start);
    op->chunk_write_pos = write_pos - op->header_end_offset;
    return (op->chunk_state == CHUNK_STATE_DONE) ? 1 : 0;
}

/* Connect timeout callback */
static void uv_io_http_connect_timer_cb(uv_timer_t *handle)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)handle->data;
    if (op->aborted) return;  /* teardown already in progress */
    uv_io_http_finish_error(op, QZ_ERR_NETWORK, "connection timeout");
}

static void uv_io_http_stream_cleanup(uv_io_http_op_t *op);

/* Read-idle timeout callback — fires when no data arrives during streaming */
static void uv_io_http_idle_timer_cb(uv_timer_t *handle)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)handle->data;
    if (op->aborted) return;  /* teardown already in progress */
    if (op->stream_ops.on_end) {
        op->stream_ops.on_end(op->stream_ops.user_data, QZ_ERR_NETWORK, "unspecified network error");
    }
    uv_io_http_stream_cleanup(op);
}

static void uv_io_http_read_cb(uv_stream_t *stream, ssize_t nread,
                                const uv_buf_t *buf);

static void uv_io_http_stream_read_cb(uv_stream_t *stream, ssize_t nread,
                                        const uv_buf_t *buf);

static void uv_io_http_alloc_cb(uv_handle_t *handle, size_t suggested_size,
                                 uv_buf_t *buf)
{
    (void)handle;
    (void)suggested_size;
    buf->base = (char *)malloc(4096);
    buf->len = buf->base ? 4096 : 0;
}

static void uv_io_http_write_cb(uv_write_t *req, int status);
#if QZ_WITH_TLS
static void uv_io_http_connect_write_cb(uv_write_t *req, int status);
static void uv_io_http_proxy_connect_read_cb(uv_stream_t *stream, ssize_t nread,
                                             const uv_buf_t *buf);
#endif
static void uv_io_http_start_tls(uv_io_http_op_t *op);

#if QZ_WITH_TLS
static void tls_read_cb(uv_stream_t *stream, ssize_t nread,
                         const uv_buf_t *buf);
static void tls_stream_read_cb(uv_stream_t *stream, ssize_t nread,
                                const uv_buf_t *buf);
#endif

/* ================================================================
 * HTTP request builder — builds and sends the HTTP request over TCP.
 * Called from the connect callback (non-TLS) or after TLS handshake.
 * ================================================================ */

static void uv_io_http_send_request(uv_io_http_op_t *op)
{
    const char *method = op->method ? op->method : "GET";
    const char *path = op->path ? op->path : "/";
    const char *host = op->host ? op->host : "localhost";
    char *host_hdr = uv_io_http_authority(host,
                                          op->port, op->use_tls ? 443 : 80);
    char *proxy_target = NULL;

    /* Plain-http via proxy: absolute-form request target (RFC 7230 5.3.2). */
    if (op->proxy_active && !op->use_tls) {
        proxy_target = uv_io_http_proxy_request_target(op);
        if (!proxy_target) {
            uv_io_http_finish_error(op, QZ_ERR_GENERIC, "out of memory");
            return;
        }
        path = proxy_target;
    }

    /* 请求行长度随 path/host 增长（URL path 不受固定 1024 限制），把它们的
     * 长度计入容量；随后的 snprintf 仍逐段检查返回值 —— 任何截断立即失败，
     * 而不是累加返回值越过 req_cap（原代码 pos 无界增长 → 越界写）。 */
    size_t req_cap = 1024 + (op->body_len > 0 ? op->body_len : 0) +
                     strlen(path) + strlen(host) + 64 +
                     (op->proxy_auth ? strlen(op->proxy_auth) + 32 : 0);
    char *req_buf = (char *)malloc(req_cap);
    if (!req_buf) {
        free(host_hdr);
        free(proxy_target);
        uv_io_http_finish_error(op, QZ_ERR_GENERIC, "out of memory");
        return;
    }

    size_t pos = 0;
    int n = snprintf(req_buf + pos, req_cap - pos,
                     "%s %s HTTP/1.1\r\nHost: %s\r\n",
                     method, path, host_hdr ? host_hdr : host);
    free(host_hdr);
    free(proxy_target);
    if (n < 0 || (size_t)n >= req_cap - pos) goto req_too_large;
    pos += (size_t)n;

    /* Add Content-Length if we have a body */
    if (op->body && op->body_len > 0) {
        n = snprintf(req_buf + pos, req_cap - pos,
                     "Content-Length: %zu\r\n", op->body_len);
        if (n < 0 || (size_t)n >= req_cap - pos) goto req_too_large;
        pos += (size_t)n;
    }

    /* Add Connection: close so server closes after response */
    n = snprintf(req_buf + pos, req_cap - pos, "Connection: close\r\n");
    if (n < 0 || (size_t)n >= req_cap - pos) goto req_too_large;
    pos += (size_t)n;

    /* Proxy authentication: plain-http via proxy carries the cached
     * Proxy-Authorization header so authenticated proxies accept the request
     * (CONNECT requests carry it separately in uv_io_http_send_connect). */
    if (op->proxy_active && op->proxy_auth) {
        n = snprintf(req_buf + pos, req_cap - pos,
                     "Proxy-Authorization: %s\r\n", op->proxy_auth);
        if (n < 0 || (size_t)n >= req_cap - pos) goto req_too_large;
        pos += (size_t)n;
    }

    /* Parse and add custom headers from headers_json.
     * Simple approach: scan for "key":"value" patterns. */
    if (op->headers_json && op->headers_json[0] == '{') {
        const char *p = op->headers_json + 1;
        while (*p && *p != '}') {
            /* Skip whitespace and commas */
            while (*p == ' ' || *p == ',' || *p == '\t') p++;
            if (*p == '}' || *p == '\0') break;

            /* Expect opening quote for key */
            if (*p != '"') { p++; continue; }
            p++;

            /* Read key */
            const char *key_start = p;
            while (*p && *p != '"') {
                if (*p == '\\') p++;
                p++;
            }
            size_t key_len = (size_t)(p - key_start);
            if (*p == '"') p++;

            /* Skip colon */
            while (*p == ' ' || *p == ':' || *p == '\t') p++;

            /* Expect opening quote for value */
            if (*p != '"') { p++; continue; }
            p++;

            /* Read value */
            const char *val_start = p;
            while (*p && *p != '"') {
                if (*p == '\\') p++;
                p++;
            }
            size_t val_len = (size_t)(p - val_start);
            if (*p == '"') p++;

            /* Add header line: key: value */
            if (pos + key_len + val_len + 5 < req_cap) {
                memcpy(req_buf + pos, key_start, key_len);
                pos += key_len;
                req_buf[pos++] = ':';
                req_buf[pos++] = ' ';
                memcpy(req_buf + pos, val_start, val_len);
                pos += val_len;
                req_buf[pos++] = '\r';
                req_buf[pos++] = '\n';
            }
        }
    }

    /* End of headers */
    req_buf[pos++] = '\r';
    req_buf[pos++] = '\n';

    /* Append body if present */
    if (op->body && op->body_len > 0 && pos + op->body_len < req_cap) {
        memcpy(req_buf + pos, op->body, op->body_len);
        pos += op->body_len;
    }

    op->req_buf = req_buf;
    op->req_buf_len = pos;

#if QZ_WITH_TLS
    if (op->use_tls) {
        /* Encrypt and send through TLS */
        int ret = mbedtls_ssl_write(&op->ssl, (const unsigned char *)req_buf, pos);
        if (ret < 0) {
            /* op->req_buf owns req_buf (set above); let uv_io_http_cleanup free
             * it via op->req_buf. Freeing it here too would double-free. */
            uv_io_http_finish_error(op, QZ_ERR_NETWORK, "TLS write failed");
            return;
        }
        free(req_buf);
        op->req_buf = NULL;
        /* Start reading response via TLS */
        if (op->streaming) {
            uv_read_start((uv_stream_t *)&op->tcp, uv_io_http_alloc_cb,
                          tls_stream_read_cb);
            /* Start read-idle timer for TLS streaming */
            if (uv_timer_init(&op->rt->loop, &op->idle_timer) == 0) {
                op->idle_timer_init = 1;
                op->idle_timer.data = op;
                uv_timer_start(&op->idle_timer, uv_io_http_idle_timer_cb,
                               PAL_UV_READ_IDLE_TIMEOUT_MS,
                               PAL_UV_READ_IDLE_TIMEOUT_MS);
            }
        } else {
            uv_read_start((uv_stream_t *)&op->tcp, uv_io_http_alloc_cb,
                          tls_read_cb);
        }
        return;
    }
#endif

    /* Send the request (non-TLS path) */
    uv_buf_t write_buf;
    write_buf.base = op->req_buf;
    write_buf.len = op->req_buf_len;

    op->write_req.data = op;
    uv_write(&op->write_req, (uv_stream_t *)&op->tcp, &write_buf, 1,
             uv_io_http_write_cb);
    return;

req_too_large:
    free(req_buf);
    uv_io_http_finish_error(op, QZ_ERR_GENERIC, "request too large");
}

/* ================================================================
 * TLS handshake read callback — feeds encrypted data to mbedTLS.
 * On handshake completion, proceeds to send the HTTP request.
 * ================================================================ */

#if QZ_WITH_TLS
static void tls_handshake_read_cb(uv_stream_t *stream, ssize_t nread,
                                   const uv_buf_t *buf)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)stream->data;
    if (op->aborted || op->teardown_started || op->tearing_down) {
        if (buf && buf->base) free(buf->base);
        return;
    }
    if (nread < 0) {
        free(buf->base);
        uv_io_http_finish_error(op, QZ_ERR_NETWORK, "TLS handshake read error");
        return;
    }

    /* Free previous buffer if partially consumed */
    if (op->tls_read_buf != NULL) {
        free(op->tls_read_buf);
    }
    op->tls_read_buf = (unsigned char *)buf->base;
    op->tls_read_buf_len = (size_t)nread;
    op->tls_read_consumed = 0;

    int ret = mbedtls_ssl_handshake(&op->ssl);
    if (ret == 0) {
        /* 纵深防御:即使 authmode 被误配为 OPTIONAL,证书/主机名验证失败
         * 也必须拒绝连接,不能带着未经验证的证书继续。 */
        if (mbedtls_ssl_get_verify_result(&op->ssl) != 0) {
            uv_read_stop((uv_stream_t *)&op->tcp);
            free(op->tls_read_buf);
            op->tls_read_buf = NULL;
            op->tls_read_buf_len = 0;
            op->tls_read_consumed = 0;
            uv_io_http_finish_error(op, QZ_ERR_NETWORK,
                                    "TLS certificate verification failed");
            return;
        }
        op->tls_handshake_done = 1;
        /* 握手完成:必须换掉读回调并停掉当前读,再发请求。
         * 此前这里只设 tls_handshake_done 就返回 —— 读循环保持注册在
         * tls_handshake_read_cb 上,服务器发来的响应字节会再次进入本回调
         * 并重跑 mbedtls_ssl_handshake(此时已非握手阶段),轻则多跑一次
         * 握手状态机、重则把响应数据当作握手记录吞掉,最终以
         * "TLS handshake read error"(EOF) 收场。表现为所有 https fetch
         * 失败,而同一构建的明文 http 正常。 */
        uv_read_stop((uv_stream_t *)&op->tcp);
        /* send_request selects the correct read callback (tls_stream_read_cb
         * or tls_read_cb) based on op->streaming; no need to race it here. */
        uv_io_http_send_request(op);
        return;
    } else if (ret != MBEDTLS_ERR_SSL_WANT_READ &&
               ret != MBEDTLS_ERR_SSL_WANT_WRITE) {
        char err[128];
        mbedtls_strerror(ret, err, sizeof(err));
        free(op->tls_read_buf);
        op->tls_read_buf = NULL;
        op->tls_read_buf_len = 0;
        uv_io_http_finish_error(op, QZ_ERR_NETWORK, err);
    }
    /* On WANT_READ/WANT_WRITE, keep buffer for next recv_cb call */
}
#endif

/* ================================================================
 * HTTP connect callback — called after TCP connection is established.
 * Stops the connect timer, then sends the HTTP request.
 * ================================================================ */

static void uv_io_http_connect_cb(uv_connect_t *req, int status)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)req->data;

    /* If the op was aborted, or teardown already began (e.g. the connect
     * timeout fired and closed tcp while uv_tcp_connect was still pending),
     * do nothing: libuv's uv__stream_destroy delivers a final UV_ECANCELED
     * here, which would re-enter finish_error and deliver the completion
     * callback a second time. */
    if (op->aborted || op->tearing_down) return;

    /* Stop the connect timer on any connect result. Do NOT uv_close it here:
     * tearing_down is still 0 at this point, so uv_io_http_close_handle would
     * treat it as a mid-life close and NOT bump closes_pending — yet uv_close
     * would put it on libuv's closing queue. When the finish path later closes
     * tcp (counted) and frees op once closes_pending hits 0, this uncounted
     * connect_timer close is still pending, so uv__run_closing_handles reads the
     * freed op (use-after-free, flagged by Valgrind). Stopping the timer here is
     * enough to prevent the timeout firing during the request; the finish paths
     * (finish_error/finish_success) close connect_timer counted via
     * uv_io_http_close_handle. */
    if (op->connect_timer.data && !uv_is_closing((uv_handle_t *)&op->connect_timer)) {
        uv_timer_stop(&op->connect_timer);
    }

    if (status < 0) {
        uv_io_http_finish_error(op, QZ_ERR_NETWORK, "connection failed");
        return;
    }

    /* https via proxy: tunnel first (CONNECT), TLS starts after the proxy's
     * 2xx, TLS hostname verification still targets the origin. */
    if (op->proxy_active && op->use_tls) {
#if QZ_WITH_TLS
        const char *err = NULL;
        if (uv_io_http_send_connect(op, &err) != 0) {
            uv_io_http_finish_error(op, QZ_ERR_NETWORK, err);
            return;
        }
        uv_read_start((uv_stream_t *)&op->tcp, uv_io_http_alloc_cb,
                      uv_io_http_proxy_connect_read_cb);
        return;
#else
        uv_io_http_finish_error(op, QZ_ERR_NETWORK, "TLS not supported: compile with QZ_WITH_TLS");
        return;
#endif
    }

    if (op->use_tls) {
        uv_io_http_start_tls(op);
        return;
    }

    uv_io_http_send_request(op);
}

/* Initiate the TLS handshake on an established (possibly tunneled) TCP
 * connection. Shared by the direct-connect path and the CONNECT-tunnel
 * continuation. */
static void uv_io_http_start_tls(uv_io_http_op_t *op)
{
#if QZ_WITH_TLS
    if (tls_init_op(op) != 0) {
        uv_io_http_finish_error(op, QZ_ERR_NETWORK, "TLS init failed");
        return;
    }
    mbedtls_ssl_set_bio(&op->ssl, op, tls_send_cb, tls_recv_cb, NULL);
    op->tls_handshake_done = 0;
    /* Start reading for handshake data */
    uv_read_start((uv_stream_t *)&op->tcp, uv_io_http_alloc_cb,
                  tls_handshake_read_cb);
    /* Kick off the handshake — this sends ClientHello via tls_send_cb */
    {
        int ret = mbedtls_ssl_handshake(&op->ssl);
        if (ret == 0) {
            /* 纵深防御:同步握手成功后同样校验证书/主机名验证结果。 */
            if (mbedtls_ssl_get_verify_result(&op->ssl) != 0) {
                uv_io_http_finish_error(op, QZ_ERR_NETWORK,
                                        "TLS certificate verification failed");
                return;
            }
            /* Handshake completed synchronously (unlikely) */
            op->tls_handshake_done = 1;
            uv_read_stop((uv_stream_t *)&op->tcp);
            uv_io_http_send_request(op);
        } else if (ret != MBEDTLS_ERR_SSL_WANT_READ &&
                   ret != MBEDTLS_ERR_SSL_WANT_WRITE) {
            char err[128];
            mbedtls_strerror(ret, err, sizeof(err));
            uv_io_http_finish_error(op, QZ_ERR_NETWORK, err);
        }
        /* WANT_READ/WANT_WRITE: wait for tls_handshake_read_cb */
    }
    return;
#else
    uv_io_http_finish_error(op, QZ_ERR_NETWORK, "TLS not supported: compile with QZ_WITH_TLS");
#endif
}

static void uv_io_http_write_cb(uv_write_t *req, int status)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)req->data;

    if (op->aborted) return;  /* teardown in progress — don't start reads */

    if (status < 0) {
        uv_io_http_finish_error(op, QZ_ERR_NETWORK, "write error");
        return;
    }

    /* Request sent — start reading response */
    if (op->streaming) {
        uv_read_start((uv_stream_t *)&op->tcp, uv_io_http_alloc_cb,
                      uv_io_http_stream_read_cb);
        /* Start read-idle timer for streaming */
        if (uv_timer_init(&op->rt->loop, &op->idle_timer) == 0) {
            op->idle_timer_init = 1;
            op->idle_timer.data = op;
            uv_timer_start(&op->idle_timer, uv_io_http_idle_timer_cb,
                           PAL_UV_READ_IDLE_TIMEOUT_MS,
                           PAL_UV_READ_IDLE_TIMEOUT_MS);
        }
    } else {
        uv_read_start((uv_stream_t *)&op->tcp, uv_io_http_alloc_cb,
                      uv_io_http_read_cb);
    }
}

#if QZ_WITH_TLS
/* CONNECT request flushed → start reading the proxy's response. */
static void uv_io_http_connect_write_cb(uv_write_t *req, int status)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)req->data;

    if (op->aborted) return;
    if (status < 0) {
        uv_io_http_finish_error(op, QZ_ERR_NETWORK, "proxy connect write error");
        return;
    }
    /* Reading was already started in connect_cb; nothing else to do here. */
}

/* Accumulate the CONNECT response until the end of headers, require a 2xx,
 * then continue with TLS through the tunnel. Any bytes after the header end
 * belong to the TLS record stream (ServerHello may share the segment) and are
 * replayed into tls_read_buf exactly like tls_handshake_read_cb does. */
static void uv_io_http_proxy_connect_read_cb(uv_stream_t *stream, ssize_t nread,
                                             const uv_buf_t *buf)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)stream->data;
    size_t search_from, i;
    char *new_buf;

    if (op->aborted) {
        if (buf && buf->base) free(buf->base);
        return;
    }
    if (nread < 0) {
        free(buf->base);
        uv_io_http_finish_error(op, QZ_ERR_NETWORK, "proxy CONNECT failed");
        return;
    }
    if (nread == 0) {
        free(buf->base);
        return;
    }

    new_buf = (char *)realloc(op->proxy_buf, op->proxy_buf_len + (size_t)nread);
    if (!new_buf) {
        free(buf->base);
        uv_io_http_finish_error(op, QZ_ERR_GENERIC, "out of memory");
        return;
    }
    op->proxy_buf = new_buf;
    memcpy(op->proxy_buf + op->proxy_buf_len, buf->base, (size_t)nread);
    op->proxy_buf_len += (size_t)nread;
    free(buf->base);

    /* Look for \r\n\r\n */
    search_from = op->proxy_buf_len > (size_t)nread
                      ? op->proxy_buf_len - (size_t)nread - 3 : 0;
    for (i = search_from; i + 3 < op->proxy_buf_len; i++) {
        if (op->proxy_buf[i] == '\r' && op->proxy_buf[i + 1] == '\n' &&
            op->proxy_buf[i + 2] == '\r' && op->proxy_buf[i + 3] == '\n') {
            break;
        }
    }
    if (i + 3 >= op->proxy_buf_len) return;  /* headers not complete yet */

    /* 2xx required ("HTTP/1.x 2xx ..."). A non-2xx (e.g. 407 Proxy
     * Authentication Required, 403 Forbidden) is surfaced to the caller as a
     * POSITIVE status code in the error status so fetch can report the
     * proxy's actual refusal instead of a generic network error. The
     * streaming path forwards it via on_end; fetch.js maps status > 0 to a
     * "proxy error HTTP n" message. */
    if (op->proxy_buf_len < 12 ||
        strncmp(op->proxy_buf, "HTTP/", 5) != 0 ||
        (op->proxy_buf[9] != '2')) {
        uv_read_stop((uv_stream_t *)&op->tcp);
        int proxy_status = 0;
        if (op->proxy_buf_len >= 12 &&
            op->proxy_buf[9] >= '0' && op->proxy_buf[9] <= '9' &&
            op->proxy_buf[10] >= '0' && op->proxy_buf[10] <= '9' &&
            op->proxy_buf[11] >= '0' && op->proxy_buf[11] <= '9') {
            proxy_status = (op->proxy_buf[9] - '0') * 100 +
                           (op->proxy_buf[10] - '0') * 10 +
                           (op->proxy_buf[11] - '0');
        }
        if (proxy_status > 0) {
            char msg[64];
            snprintf(msg, sizeof(msg),
                     "proxy CONNECT refused (HTTP %d)", proxy_status);
            uv_io_http_finish_error(op, proxy_status, msg);
        } else {
            uv_io_http_finish_error(op, QZ_ERR_NETWORK,
                                    "proxy CONNECT refused or malformed response");
        }
        return;
    }

    /* Tunnel established. Requeue leftover TLS bytes, then start TLS. */
    uv_read_stop((uv_stream_t *)&op->tcp);
    op->connect_state = 0;
    {
        size_t hdr_end = i + 4;
        size_t leftover = op->proxy_buf_len - hdr_end;
        if (leftover > 0) {
#if QZ_WITH_TLS
            op->tls_read_buf = (unsigned char *)malloc(leftover);
            if (!op->tls_read_buf) {
                uv_io_http_finish_error(op, QZ_ERR_GENERIC, "out of memory");
                return;
            }
            memcpy(op->tls_read_buf, op->proxy_buf + hdr_end, leftover);
            op->tls_read_buf_len = leftover;
            op->tls_read_consumed = 0;
#endif
        }
    }
    free(op->proxy_buf);
    op->proxy_buf = NULL;
    op->proxy_buf_len = 0;

    uv_io_http_start_tls(op);
}
#endif /* QZ_WITH_TLS */

/* ================================================================
 * HTTP response data processor — appends data to response buffer
 * and parses headers/body. Called from both TLS and non-TLS paths.
 *
 * Returns 1 if the operation completed (success or error dispatched),
 * 0 if more data is needed.
 * ================================================================ */

static int uv_io_http_process_data(uv_io_http_op_t *op, const char *data,
                                     size_t len)
{
    /* Append to response buffer */
    size_t new_len = op->resp_buf_len + len;
    if (new_len > op->resp_buf_cap) {
        size_t new_cap = op->resp_buf_cap * 2;
        if (new_cap < new_len) new_cap = new_len;
        char *new_buf = (char *)realloc(op->resp_buf, new_cap);
        if (!new_buf) {
            uv_io_http_finish_error(op, QZ_ERR_GENERIC, "out of memory");
            return 1;
        }
        op->resp_buf = new_buf;
        op->resp_buf_cap = new_cap;
    }
    memcpy(op->resp_buf + op->resp_buf_len, data, len);
    op->resp_buf_len = new_len;

    /* Try to parse headers if not done yet */
    if (!op->headers_done) {
        if (parse_http_response(op) == 0) {
            /* Headers parsed — check body encoding */

            if (op->chunked) {
                /* Process any body data already in the buffer */
                size_t body_len = op->resp_buf_len - op->header_end_offset;
                int result = process_chunked_body(op, op->header_end_offset,
                                                  body_len);
                if (result == 1) {
                    /* Chunked body complete */
                    uv_io_http_finish_success(op);
                    return 1;
                } else if (result < 0) {
                    uv_io_http_finish_error(op, QZ_ERR_NETWORK, "chunked encoding parse error");
                    return 1;
                }
                /* else: need more data, keep reading */
            } else if (op->body_expected > 0) {
                /* Content-Length: check if we have all body bytes */
                op->body_received = op->resp_buf_len - op->header_end_offset;
                if (op->body_received >= op->body_expected) {
                    /* We have all the body bytes — finish */
                    op->resp_buf_len = op->header_end_offset + op->body_expected;
                    uv_io_http_finish_success(op);
                    return 1;
                }
            }
            /* else: no Content-Length and not chunked — fall back to EOF */
        }
        return 0;
    }

    /* Headers already parsed — process additional body data */
    if (op->chunked) {
        size_t body_len = op->resp_buf_len - op->header_end_offset;
        int result = process_chunked_body(op, op->header_end_offset,
                                          body_len);
        if (result == 1) {
            uv_io_http_finish_success(op);
            return 1;
        } else if (result < 0) {
            uv_io_http_finish_error(op, QZ_ERR_NETWORK, "chunked encoding parse error");
            return 1;
        }
        /* else: need more data, keep reading */
    } else if (op->body_expected > 0) {
        /* Content-Length: check if we have all body bytes */
        op->body_received = op->resp_buf_len - op->header_end_offset;
        if (op->body_received >= op->body_expected) {
            op->resp_buf_len = op->header_end_offset + op->body_expected;
            uv_io_http_finish_success(op);
            return 1;
        }
    }
    /* else: no Content-Length and not chunked — keep reading until EOF */
    return 0;
}

/* ================================================================
 * TLS-aware read callback — decrypts incoming data via mbedTLS
 * and feeds it to the HTTP response parser.
 * ================================================================ */

#if QZ_WITH_TLS
static void tls_read_cb(uv_stream_t *stream, ssize_t nread,
                         const uv_buf_t *buf)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)stream->data;

    if (nread < 0) {
        free(buf->base);
        if (nread == UV_EOF) {
            /* Connection closed — finish with what we have */
            if (op->headers_done) {
                if (op->chunked && op->chunk_state != CHUNK_STATE_DONE) {
                    uv_io_http_finish_error(op, QZ_ERR_NETWORK,
                        "connection closed before chunked body complete");
                } else {
                    uv_io_http_finish_success(op);
                }
            } else {
                uv_io_http_finish_error(op, QZ_ERR_NETWORK,
                    "connection closed before headers");
            }
        } else {
            uv_io_http_finish_error(op, QZ_ERR_NETWORK, "TLS read error");
        }
        return;
    }

    if (nread == 0) {
        free(buf->base);
        return;
    }

    /* Free previous TLS read buffer if any */
    if (op->tls_read_buf) {
        free(op->tls_read_buf);
    }
    op->tls_read_buf = (unsigned char *)buf->base;
    op->tls_read_buf_len = (size_t)nread;
    op->tls_read_consumed = 0;

    /* Decrypt and feed to HTTP parser */
    unsigned char decrypt_buf[8192];
    int ret;
    while ((ret = mbedtls_ssl_read(&op->ssl, decrypt_buf,
                                    sizeof(decrypt_buf))) > 0) {
        /* Feed decrypted data to the HTTP response parser */
        if (uv_io_http_process_data(op, (const char *)decrypt_buf,
                                      (size_t)ret)) {
            /* Operation completed — clean up TLS buffer */
            free(op->tls_read_buf);
            op->tls_read_buf = NULL;
            op->tls_read_buf_len = 0;
            op->tls_read_consumed = 0;
            return;
        }
    }

    /* Clean up consumed TLS buffer */
    if (op->tls_read_consumed >= op->tls_read_buf_len) {
        free(op->tls_read_buf);
        op->tls_read_buf = NULL;
        op->tls_read_buf_len = 0;
        op->tls_read_consumed = 0;
    }

    if (ret != MBEDTLS_ERR_SSL_WANT_READ) {
        if (ret == 0) {
            /* TLS connection closed cleanly */
            uv_io_http_finish_success(op);
        } else if (ret == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY) {
            uv_io_http_finish_success(op);
        } else {
            uv_io_http_finish_error(op, QZ_ERR_NETWORK, "TLS decrypt error");
        }
    }
    /* On WANT_READ, keep reading — more encrypted data needed */
}
#endif

/* ================================================================
 * HTTP read callback — reads response data and handles:
 *  - Content-Length: reads exactly N body bytes then finishes
 *  - Chunked transfer-encoding: decodes chunks until 0-length final chunk
 *  - Fallback: reads until EOF if neither Content-Length nor chunked
 * ================================================================ */

static void uv_io_http_read_cb(uv_stream_t *stream, ssize_t nread,
                                const uv_buf_t *buf)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)stream->data;

    if (nread < 0) {
        if (nread == UV_EOF) {
            /* Connection closed — if we have headers, deliver what we have */
            if (op->headers_done) {
                /* For chunked, EOF before complete is an error unless done */
                if (op->chunked && op->chunk_state != CHUNK_STATE_DONE) {
                    uv_io_http_finish_error(op, QZ_ERR_NETWORK, "connection closed before chunked body complete");
                } else {
                    uv_io_http_finish_success(op);
                }
            } else {
                uv_io_http_finish_error(op, QZ_ERR_NETWORK, "connection closed before headers");
            }
        } else {
            uv_io_http_finish_error(op, QZ_ERR_NETWORK, "read error");
        }
        free(buf->base);
        return;
    }

    if (nread == 0) {
        free(buf->base);
        return;
    }

    /* Process the data through the shared processor */
    uv_io_http_process_data(op, buf->base, (size_t)nread);
    free(buf->base);
}

/* ================================================================
 * Streaming HTTP — cleanup and finish helpers
 * ================================================================ */

static void uv_io_http_stream_close_cb(uv_handle_t *handle)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)handle->data;
    uv_io_http_close_done(op);
}

static void uv_io_http_stream_cleanup(uv_io_http_op_t *op)
{
    /*
     * Idempotency guard. The non-abort teardown paths (idle timeout, write
     * error, connect error, chunked/parse error) call on_end + stream_cleanup,
     * which uv_close()s the TCP while reads may still be pending. libuv then
     * delivers a read callback with UV_ECANCELED — without this guard that
     * callback would re-enter the nread<0 path, fire on_end a SECOND time,
     * and call stream_cleanup again, which (seeing tcp already closing) would
     * fall through to free(op) while the first close callback is still
     * pending → double-free / UAF. Setting teardown_started here makes both
     * stream_cleanup and the read callback no-op on re-entry.
     */
    if (op->teardown_started) return;
    op->teardown_started = 1;
    op->tearing_down = 1;

    /* Clear the active-stream tracker first. The op itself is freed later
     * (in the TCP close callback or via uv_io_http_cleanup below), but no
     * other code should reach it via active_stream after teardown begins. */
    if (op->rt && op->rt->active_stream == op) {
        op->rt->active_stream = NULL;
    }

    /* Stop and close the idle timer if initialized and active */
    if (op->idle_timer_init && op->idle_timer.data &&
        !uv_is_closing((uv_handle_t *)&op->idle_timer)) {
        uv_timer_stop(&op->idle_timer);
        uv_io_http_close_handle(op, (uv_handle_t *)&op->idle_timer, uv_io_http_timer_close_cb);
    }

    /* Stop and close the connect timer if initialized and active */
    if (op->timer_init && op->connect_timer.data &&
        !uv_is_closing((uv_handle_t *)&op->connect_timer)) {
        uv_timer_stop(&op->connect_timer);
        uv_io_http_close_handle(op, (uv_handle_t *)&op->connect_timer, uv_io_http_timer_close_cb);
    }

    /* Close TCP handle; cleanup happens in close callback */
    if (op->tcp_init && !uv_is_closing((uv_handle_t *)&op->tcp)) {
        uv_io_http_close_handle(op, (uv_handle_t *)&op->tcp, uv_io_http_stream_close_cb);
    } else if (op->aborted && !op->tcp_init) {
        /*
         * Aborted before TCP was initialized: DNS (uv_getaddrinfo) is likely
         * still in flight and will fire its callback later with this op. We
         * must NOT free the op here — cancel the addrinfo request and let the
         * getaddrinfo callback (which checks op->aborted) free it. Otherwise
         * the callback would touch freed memory.
         */
        uv_cancel((uv_req_t *)&op->addr_req);
    } else {
        uv_io_http_finalize(op);
    }
}

/* Abort a single in-flight streaming HTTP op: mark it aborted (so any
 * in-flight connect/read/timer callback that fires after we begin teardown
 * becomes a no-op instead of touching the op), deliver an on_end cancellation
 * error to the JS consumer (so the fetch Promise rejects rather than hangs),
 * then tear down the TCP + timers. The op is unlinked from rt->http_ops by
 * uv_io_http_cleanup when its close callbacks drain. Must be called on the
 * loop thread (JS pal calls / teardown run there). */
static void uv_io_http_abort_op(uv_io_http_op_t *op)
{
    /* Idempotency guard. stream_cleanup has its own teardown_started guard,
     * but it runs *after* the on_end call below, so it cannot protect it.
     * Without this, an op reachable by two abort routes — e.g.
     * pal.httpRequestAbort(opId) first, then runtime teardown's
     * uv_io_http_abort() — fires on_end twice. bridge_stream_on_end frees
     * the bridge ctx and its JSValues on the first call, so the second call
     * JS_FreeValue's already-freed values (gc_prev == NULL while the object
     * is not the gc list head) → SIGSEGV inside quickjs.
     * Check both teardown flags: teardown_started (set by stream_cleanup)
     * and tearing_down (set by finish_error) both mean "this op is
     * already being torn down". Both paths must be covered — finish_error
     * fires on_end and leaves the op in rt->http_ops until its close
     * callbacks drain, so a later abort() would re-fire on_end on a bridge
     * ctx that was already freed. */
    if (op->teardown_started || op->tearing_down) return;
    op->aborted = 1;

    /* Deliver a cancellation error to the JS consumer before teardown so
     * the fetch Promise rejects rather than hanging. Use -7 (CANCELLED)
     * to mirror error codes. */
    if (op->stream_ops.on_end) {
        op->stream_ops.on_end(op->stream_ops.user_data, QZ_ERR_CANCELLED, "request aborted");
    }

    /* Tear down handles (clears active_stream, closes TCP/timers, frees op
     * via the TCP close callback). */
    uv_io_http_stream_cleanup(op);
}

/*
 * Abort a specific in-flight streaming HTTP request by op id. No-op for an
 * unknown/stale id (the op already finished and unlinked itself). Must be
 * called on the loop thread (pal.httpRequestAbort runs there via JS).
 */
void uv_io_http_abort_by_id(qz_t *rt, uint64_t op_id)
{
    uv_io_http_op_t *op = rt->http_ops;
    while (op && op->op_id != op_id) op = op->next;
    if (op) {
        uv_io_http_abort_op(op);
    }
}

/*
 * Abort every in-flight streaming HTTP request (runtime teardown). Iterates
 * the registry so concurrent fetches are all torn down, not just the most
 * recent one. Delivers an on_end error to each stream consumer and tears down
 * the TCP connections + timers. Must be called on the loop thread (host calls
 * it from qzjs teardown, which runs on the owner thread).
 */
void uv_io_http_abort(qz_t *rt)
{
    /* Walk the registry ONCE, following ->next.
     *
     * This used to be `while (rt->http_ops) { op = rt->http_ops;
     * uv_io_http_abort_op(op); }`, which assumed each abort unlinks the op
     * synchronously. It does not: uv_io_http_stream_cleanup only clears
     * rt->active_stream and uv_close()s the handles; the unlink happens in
     * uv_io_http_cleanup, reached from the close callbacks — which run on a
     * later loop iteration. So rt->http_ops never changed inside the loop
     * and every iteration re-aborted the same head op, firing its on_end
     * repeatedly (crash: see uv_io_http_abort_op's guard).
     *
     * Safe to follow ->next here: from abort_op the op is never freed
     * synchronously — the tcp path uv_close()s (callback deferred) and the
     * pre-tcp path uv_cancel()s the getaddrinfo request (its callback frees
     * the op later). Both need the loop to advance first. */
    for (uv_io_http_op_t *op = rt->http_ops; op; ) {
        uv_io_http_op_t *next = op->next; /* snapshot before abort may reorder list */
        uv_io_http_abort_op(op);
        op = next;
    }
}

/* ================================================================
 * Streaming chunked transfer-encoding decoder
 *
 * Decodes chunked TE data and calls on_data for decoded chunks.
 * Returns: 1 = final chunk seen, 0 = need more data, -1 = error
 * ================================================================ */

static int stream_decode_chunked(uv_io_http_op_t *op,
                                 const char *data, size_t len)
{
    const char *p = data;
    const char *end = data + len;

    while (p < end) {
        if (op->chunk_state == CHUNK_STATE_SIZE) {
            /* Reading chunk-size line. Look for \r\n. */
            const char *eol = p;
            while (eol < end && !(*eol == '\r' && (eol + 1 < end) && *(eol + 1) == '\n')) {
                eol++;
            }

            if (eol >= end) {
                /* Partial chunk-size line — save what we have */
                size_t avail = (size_t)(end - p);
                if (op->chunk_size_buf_len + avail < sizeof(op->chunk_size_buf) - 1) {
                    memcpy(op->chunk_size_buf + op->chunk_size_buf_len, p, avail);
                    op->chunk_size_buf_len += avail;
                }
                break; /* need more data */
            }

            /* We have a complete chunk-size line.
             * Combine with any previously buffered partial. */
            char size_buf[32];
            size_t size_buf_len = op->chunk_size_buf_len;
            if (size_buf_len > 0) {
                if (size_buf_len >= sizeof(size_buf)) size_buf_len = sizeof(size_buf) - 1;
                memcpy(size_buf, op->chunk_size_buf, size_buf_len);
                op->chunk_size_buf_len = 0;
            }
            size_t line_len = (size_t)(eol - p);
            if (size_buf_len + line_len >= sizeof(size_buf))
                line_len = sizeof(size_buf) - 1 - size_buf_len;
            memcpy(size_buf + size_buf_len, p, line_len);
            size_buf_len += line_len;
            size_buf[size_buf_len] = '\0';

            /* Parse chunk size (hex, may have extensions after ;) */
            errno = 0;
            op->chunk_size = (size_t)strtoul(size_buf, NULL, 16);

            if (errno == ERANGE || op->chunk_size > PAL_UV_MAX_CHUNK_SIZE) {
                return -1; /* chunk too large or overflow */
            }

            if (op->chunk_size == 0) {
                /* Final chunk */
                op->chunk_state = CHUNK_STATE_DONE;
                return 1;
            }

            op->chunk_remaining = op->chunk_size;
            op->chunk_state = CHUNK_STATE_DATA;
            p = eol + 2; /* skip \r\n after chunk-size */

        } else if (op->chunk_state == CHUNK_STATE_DATA) {
            /* Read chunk data bytes — deliver directly via on_data */
            size_t avail = (size_t)(end - p);
            size_t to_deliver = avail < op->chunk_remaining ? avail : op->chunk_remaining;

            if (op->stream_ops.on_data) {
                op->stream_ops.on_data(op->stream_ops.user_data, p, to_deliver);
            }
            p += to_deliver;
            op->chunk_remaining -= to_deliver;

            if (op->chunk_remaining == 0) {
                op->chunk_state = CHUNK_STATE_TRAILER;
            }

        } else if (op->chunk_state == CHUNK_STATE_TRAILER) {
            /* Expect \r\n after chunk data */
            if (end - p < 2) {
                break; /* need more data */
            }
            if (p[0] != '\r' || p[1] != '\n') {
                return -1; /* malformed */
            }
            p += 2;
            op->chunk_state = CHUNK_STATE_SIZE;

        } else if (op->chunk_state == CHUNK_STATE_DONE) {
            break;
        }
    }

    return (op->chunk_state == CHUNK_STATE_DONE) ? 1 : 0;
}

/* ================================================================
 * Streaming response data processor
 *
 * Accumulates header data until headers are complete, then delivers
 * on_headers callback and switches to body delivery mode via on_data.
 * For chunked responses, decodes chunks before calling on_data.
 *
 * Returns 1 if the operation completed (end callback dispatched),
 * 0 if more data is needed.
 * ================================================================ */

static int uv_io_http_stream_process_data(uv_io_http_op_t *op,
                                            const char *data, size_t len)
{
    if (op->headers_parsed) {
        /* Body data — check for chunked encoding */
        if (op->chunked) {
            int result = stream_decode_chunked(op, data, len);
            if (result == 1) {
                /* Final chunk seen */
                if (op->stream_ops.on_end) {
                    op->stream_ops.on_end(op->stream_ops.user_data, 0, NULL);
                }
                uv_io_http_stream_cleanup(op);
                return 1;
            } else if (result < 0) {
                if (op->stream_ops.on_end) {
                    op->stream_ops.on_end(op->stream_ops.user_data, QZ_ERR_NETWORK, "stream error before response headers");
                }
                uv_io_http_stream_cleanup(op);
                return 1;
            }
        } else {
            /* Non-chunked body — deliver raw bytes */
            if (op->stream_ops.on_data) {
                op->stream_ops.on_data(op->stream_ops.user_data, data, len);
            }
            /* Content-Length completion: once body_expected bytes have been
             * delivered, the message body is complete even if the server
             * keeps the connection alive (no EOF follows). Truncated bodies
             * (EOF before body_expected) are caught in the read callback. */
            if (op->body_expected > 0) {
                op->body_received += len;
                if (op->body_received >= op->body_expected) {
                    if (op->stream_ops.on_end) {
                        op->stream_ops.on_end(op->stream_ops.user_data, 0, NULL);
                    }
                    uv_io_http_stream_cleanup(op);
                    return 1;
                }
            }
        }
        return 0;
    }

    /* Headers not yet parsed — accumulate header data */
    size_t new_len = op->resp_headers_len + len;
    char *new_buf = (char *)realloc(op->resp_headers, new_len + 1);
    if (!new_buf) {
        if (op->stream_ops.on_end) {
            op->stream_ops.on_end(op->stream_ops.user_data, QZ_ERR_NETWORK, "socket connect failed");
        }
        uv_io_http_stream_cleanup(op);
        return 1;
    }
    op->resp_headers = new_buf;
    memcpy(op->resp_headers + op->resp_headers_len, data, len);
    op->resp_headers_len = new_len;
    op->resp_headers[new_len] = '\0';

    /* Look for \r\n\r\n marking end of headers */
    char *hdr_end = NULL;
    size_t i;
    for (i = 3; i < op->resp_headers_len; i++) {
        if (op->resp_headers[i - 3] == '\r' && op->resp_headers[i - 2] == '\n' &&
            op->resp_headers[i - 1] == '\r' && op->resp_headers[i] == '\n') {
            hdr_end = op->resp_headers + i + 1;
            break;
        }
    }

    if (!hdr_end) {
        return 0; /* need more header data */
    }

    /* Parse status line: HTTP/1.x NNN ... */
    char *line_end = NULL;
    for (i = 0; i < op->resp_headers_len; i++) {
        if (op->resp_headers[i] == '\r' && op->resp_headers[i + 1] == '\n') {
            line_end = op->resp_headers + i;
            break;
        }
    }

    int http_status = 0;
    if (line_end) {
        char *sp = op->resp_headers;
        while (sp < line_end && *sp != ' ') sp++;
        if (sp < line_end) sp++; /* skip space */
        int digits = 0;
        while (sp < line_end && *sp >= '0' && *sp <= '9' && digits < 3) {
            http_status = http_status * 10 + (*sp - '0');
            sp++;
            digits++;
        }
    }

    /* Scan headers for Content-Length and Transfer-Encoding: chunked. */
    op->chunked = 0;
    op->body_expected = 0;
    size_t header_end_offset = (size_t)(hdr_end - op->resp_headers);
    const char *hdrs = op->resp_headers + (line_end - op->resp_headers) + 2;
    const char *hdrs_end = op->resp_headers + header_end_offset - 4;

    const char *hp = hdrs;
    while (hp < hdrs_end) {
        const char *eol = hp;
        while (eol < hdrs_end && !(*eol == '\r' && (eol + 1 < hdrs_end) && *(eol + 1) == '\n')) {
            eol++;
        }

        /* eol points at the \r of the line's \r\n (or hdrs_end). The line
         * content is [hp, eol), so require >= 18 chars (header name + colon)
         * — NOT > 26, which misses "Transfer-Encoding: chunked" exactly. */
        if (eol - hp >= 18 && strncasecmp(hp, "Transfer-Encoding:", 18) == 0) {
            const char *val = hp + 18;
            while (val < eol && (*val == ' ' || *val == '\t')) val++;
            if (eol - val >= 7 && strncasecmp(val, "chunked", 7) == 0) {
                op->chunked = 1;
            }
        }

        /* Content-Length (case-insensitive). When both Content-Length and
         * chunked are present, chunked wins (RFC 7230 §3.3.3): body delivery
         * checks op->chunked first, so body_expected only governs the
         * non-chunked path. */
        if (eol - hp > 15 && strncasecmp(hp, "Content-Length:", 15) == 0) {
            const char *val = hp + 15;
            while (val < eol && (*val == ' ' || *val == '\t')) val++;
            unsigned long long cl = strtoull(val, NULL, 10);
            /* Clamp to SIZE_MAX to avoid truncation on 32-bit platforms */
            op->body_expected = cl > SIZE_MAX ? SIZE_MAX : (size_t)cl;
        }

        hp = eol + 2;
        if (hp > hdrs_end) hp = hdrs_end;
    }

    /* Build headers JSON for on_headers callback */
    char *headers_json = NULL;
    size_t headers_json_len = 0;

    if (line_end) {
        const char *status_line_end = op->resp_headers + (line_end - op->resp_headers) + 2;
        size_t hdr_len = (size_t)(hdrs_end - status_line_end);
        headers_json = uv_io_build_headers_json(status_line_end, hdr_len, &headers_json_len);
    }

    /* Deliver on_headers callback */
    if (op->stream_ops.on_headers) {
        op->stream_ops.on_headers(op->stream_ops.user_data, http_status,
                                   headers_json ? headers_json : "{}");
    }
    free(headers_json);

    op->headers_parsed = 1;
    op->chunk_state = CHUNK_STATE_SIZE;

    /* Any data after the header boundary is body data */
    size_t body_offset = header_end_offset;
    size_t body_len = op->resp_headers_len - body_offset;

    if (body_len > 0) {
        /* Process remaining body data */
        return uv_io_http_stream_process_data(op,
                                                op->resp_headers + body_offset,
                                                body_len);
    }

    return 0;
}

/* ================================================================
 * Streaming HTTP read callback — reads response data and feeds it
 * to the streaming processor for header/body delivery.
 * ================================================================ */

static void uv_io_http_stream_read_cb(uv_stream_t *stream, ssize_t nread,
                                        const uv_buf_t *buf)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)stream->data;

    /* Aborted or teardown-in-progress: a forced close (idle timeout/error/etc.)
     * delivers a final UV_ECANCELED read here; treat as no-op so we don't
     * re-enter on_end / stream_cleanup and double-free. */
    if (op->aborted || op->teardown_started) {
        if (buf && buf->base) free(buf->base);
        return;
    }

    if (nread < 0) {
        free(buf->base);
        if (nread == UV_EOF) {
            if (op->stream_ops.on_end) {
                if (op->headers_parsed) {
                    if (op->chunked && op->chunk_state != CHUNK_STATE_DONE) {
                        op->stream_ops.on_end(op->stream_ops.user_data, QZ_ERR_NETWORK, "truncated chunked body");
                    } else if (op->body_expected > 0 &&
                               op->body_received < op->body_expected) {
                        /* Content-Length promised more bytes than arrived —
                         * truncated body must not resolve as success. */
                        op->stream_ops.on_end(op->stream_ops.user_data, QZ_ERR_NETWORK, "truncated body (Content-Length not satisfied)");
                    } else {
                        op->stream_ops.on_end(op->stream_ops.user_data, 0, NULL);
                    }
                } else {
                    op->stream_ops.on_end(op->stream_ops.user_data, QZ_ERR_NETWORK, "connection closed before response headers");
                }
            }
        } else {
            if (op->stream_ops.on_end) {
                op->stream_ops.on_end(op->stream_ops.user_data, QZ_ERR_NETWORK, "socket read error");
            }
        }
        uv_io_http_stream_cleanup(op);
        return;
    }

    if (nread == 0) {
        free(buf->base);
        return;
    }

    uv_io_http_stream_process_data(op, buf->base, (size_t)nread);
    free(buf->base);

    /* Reset idle timer on data received */
    if (op->idle_timer_init && !uv_is_closing((uv_handle_t *)&op->idle_timer)) {
        uv_timer_again(&op->idle_timer);
    }
}

/* ================================================================
 * TLS-aware streaming read callback — decrypts incoming data via
 * mbedTLS and feeds it to the streaming response processor.
 * ================================================================ */

#if QZ_WITH_TLS
static void tls_stream_read_cb(uv_stream_t *stream, ssize_t nread,
                                const uv_buf_t *buf)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)stream->data;

    /* Aborted or teardown-in-progress: mirror the non-TLS read-cb guard so a
     * post-close UV_ECANCELED doesn't double-fire on_end / double-free. */
    if (op->aborted || op->teardown_started) {
        if (buf && buf->base) free(buf->base);
        return;
    }

    if (nread < 0) {
        free(buf->base);
        if (nread == UV_EOF) {
            if (op->stream_ops.on_end) {
                if (op->headers_parsed) {
                    if (op->chunked && op->chunk_state != CHUNK_STATE_DONE) {
                        op->stream_ops.on_end(op->stream_ops.user_data, QZ_ERR_NETWORK, "TLS read error");
                    } else if (op->body_expected > 0 &&
                               op->body_received < op->body_expected) {
                        /* Content-Length promised more bytes than arrived —
                         * truncated body must not resolve as success. */
                        op->stream_ops.on_end(op->stream_ops.user_data, QZ_ERR_NETWORK, "TLS truncated body (Content-Length not satisfied)");
                    } else {
                        op->stream_ops.on_end(op->stream_ops.user_data, 0, NULL);
                    }
                } else {
                    op->stream_ops.on_end(op->stream_ops.user_data, QZ_ERR_NETWORK, "TLS connection closed before response headers");
                }
            }
        } else {
            if (op->stream_ops.on_end) {
                op->stream_ops.on_end(op->stream_ops.user_data, QZ_ERR_NETWORK, "TLS socket read error");
            }
        }
        uv_io_http_stream_cleanup(op);
        return;
    }

    if (nread == 0) {
        free(buf->base);
        return;
    }

    /* Free previous TLS read buffer if any */
    if (op->tls_read_buf) {
        free(op->tls_read_buf);
    }
    op->tls_read_buf = (unsigned char *)buf->base;
    op->tls_read_buf_len = (size_t)nread;
    op->tls_read_consumed = 0;

    /* Decrypt and feed to streaming processor */
    unsigned char decrypt_buf[8192];
    int ret;
    while ((ret = mbedtls_ssl_read(&op->ssl, decrypt_buf,
                                    sizeof(decrypt_buf))) > 0) {
        if (uv_io_http_stream_process_data(op, (const char *)decrypt_buf,
                                             (size_t)ret)) {
            /* Operation completed — clean up TLS buffer */
            free(op->tls_read_buf);
            op->tls_read_buf = NULL;
            op->tls_read_buf_len = 0;
            op->tls_read_consumed = 0;
            return;
        }
    }

    /* Clean up consumed TLS buffer */
    if (op->tls_read_consumed >= op->tls_read_buf_len) {
        free(op->tls_read_buf);
        op->tls_read_buf = NULL;
        op->tls_read_buf_len = 0;
        op->tls_read_consumed = 0;
    }

    /* Reset idle timer on data received */
    if (op->idle_timer_init && !uv_is_closing((uv_handle_t *)&op->idle_timer)) {
        uv_timer_again(&op->idle_timer);
    }

    if (ret != MBEDTLS_ERR_SSL_WANT_READ) {
        if (ret == 0 || ret == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY) {
            /* TLS connection closed cleanly */
            if (op->stream_ops.on_end) {
                if (op->headers_parsed) {
                    op->stream_ops.on_end(op->stream_ops.user_data, 0, NULL);
                } else {
                    op->stream_ops.on_end(op->stream_ops.user_data, QZ_ERR_NETWORK, "TLS connection closed prematurely");
                }
            }
            uv_io_http_stream_cleanup(op);
        } else {
            if (op->stream_ops.on_end) {
                op->stream_ops.on_end(op->stream_ops.user_data, QZ_ERR_NETWORK, "TLS socket error");
            }
            uv_io_http_stream_cleanup(op);
        }
    }
    /* On WANT_READ, keep reading — more encrypted data needed */
}
#endif

/* ================================================================
 * DNS resolution callback — called after uv_getaddrinfo completes.
 * Initiates the TCP connection and starts the connect timer.
 * ================================================================ */

static void uv_io_http_getaddrinfo_cb(uv_getaddrinfo_t *req,
                                        int status, struct addrinfo *res)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)req->data;

    if (status < 0) {
        uv_io_http_finish_error(op, QZ_ERR_NETWORK, "DNS resolution failed");
        uv_freeaddrinfo(res);
        return;
    }

    if (!res) {
        uv_io_http_finish_error(op, QZ_ERR_NETWORK, "DNS resolution returned no addresses");
        return;
    }

    /* Initialize TCP handle */
    int rc = uv_tcp_init(&op->rt->loop, &op->tcp);
    if (rc < 0) {
        uv_freeaddrinfo(res);
        uv_io_http_finish_error(op, QZ_ERR_NETWORK, "tcp init failed");
        return;
    }
    op->tcp_init = 1;
    op->tcp.data = op;

    /* Connect using the first resolved address */
    op->connect_req.data = op;
    rc = uv_tcp_connect(&op->connect_req, &op->tcp, res->ai_addr,
                        uv_io_http_connect_cb);
    uv_freeaddrinfo(res);

    if (rc < 0) {
        uv_io_http_finish_error(op, QZ_ERR_NETWORK, "connect failed");
        return;
    }

    /* Start connect timer */
    rc = uv_timer_init(&op->rt->loop, &op->connect_timer);
    if (rc < 0) {
        /* Timer init failed — connection is already started, let it proceed.
         * We just won't have a timeout. Not fatal. */
    } else {
        op->timer_init = 1;
        op->connect_timer.data = op;
        rc = uv_timer_start(&op->connect_timer, uv_io_http_connect_timer_cb,
                            PAL_UV_CONNECT_TIMEOUT_MS, 0);
        if (rc < 0) {
            /* Timer start failed — non-fatal, connection proceeds without timeout */
            uv_io_http_close_handle(op, (uv_handle_t *)&op->connect_timer, uv_io_http_timer_close_cb);
        }
    }
}

/* ================================================================
 * HTTP request entry point
 * ================================================================ */

void uv_io_http_request(qz_t *rt,
                                const char *url, const char *method,
                                const char *headers, const char *body,
                                size_t body_len,
                                qz_io_done_t cb, void *cb_data)
{

    if (!url) {
        cb(cb_data, QZ_ERR_INVALID_ARG, "invalid url", 11);
        return;
    }

    uv_io_http_op_t *op = (uv_io_http_op_t *)calloc(1, sizeof(*op));
    if (!op) {
        cb(cb_data, QZ_ERR_GENERIC, "out of memory", 13);
        return;
    }

    op->cb = cb;
    op->cb_data = cb_data;
    op->rt = rt;
    op->chunk_state = CHUNK_STATE_SIZE;

    /* Parse URL */
    {
        uv_io_url_t parts = {0};
        if (uv_io_parse_url(url, &parts) < 0) {
            cb(cb_data, QZ_ERR_INVALID_ARG, "invalid url format", 18);
            free(op);
            return;
        }
        op->host    = parts.host;
        op->port    = parts.port;
        op->path    = parts.path;
        op->use_tls = parts.tls;
        /* parts fields are now owned by op — do NOT call uv_io_url_free */
    }

    /* Outbound proxy from env (must precede DNS: it decides connect target).
     * A malformed proxy URL fails the request — failing closed. */
    if (uv_io_http_apply_proxy(op) < 0) {
        uv_io_http_finalize(op);
        cb(cb_data, QZ_ERR_INVALID_ARG, "invalid proxy URL", 18);
        return;
    }

    /* If TLS is requested, check compile-time support */
    if (op->use_tls) {
#if QZ_WITH_TLS
        /* TLS handshake will be initiated after connect */
#else
        /* Error out early before doing any network I/O */
        uv_io_http_finalize(op);
        cb(cb_data, QZ_ERR_NETWORK, "TLS not supported: compile with QZ_WITH_TLS", 45);
        return;
#endif
    }

    /* Copy method and headers */
    op->method = method ? strdup(method) : strdup("GET");
    op->headers_json = headers ? strdup(headers) : NULL;

    /* Copy body */
    if (body && body_len > 0) {
        op->body = (char *)malloc(body_len + 1);
        if (op->body) {
            memcpy(op->body, body, body_len);
            op->body[body_len] = '\0';
            op->body_len = body_len;
        }
    }

    /* Initialize response buffer */
    op->resp_buf_cap = PAL_UV_HTTP_BUF_INIT;
    op->resp_buf = (char *)malloc(op->resp_buf_cap);
    if (!op->resp_buf) {
        uv_io_http_finalize(op);
        cb(cb_data, QZ_ERR_GENERIC, "out of memory", 13);
        return;
    }

    /* Resolve hostname via uv_getaddrinfo */
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;     /* IPv4 + IPv6 */
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;

    /* Build port string for getaddrinfo. Via proxy, resolve the proxy. */
    char port_str[8];
    snprintf(port_str, sizeof(port_str), "%d", uv_io_http_connect_port(op));

    op->addr_req.data = op;
    int rc = uv_getaddrinfo(&rt->loop, &op->addr_req,
                            uv_io_http_getaddrinfo_cb,
                            uv_io_http_connect_host(op), port_str, &hints);
    if (rc < 0) {
        uv_io_http_finalize(op);
        cb(cb_data, QZ_ERR_NETWORK, "DNS resolution request failed", 29);
        return;
    }
}

/* ================================================================
 * Streaming HTTP request entry point
 *
 * Similar to uv_io_http_request but uses streaming callbacks instead
 * of a single completion callback. Reuses the same connection flow
 * (DNS -> TCP connect -> send request -> read response) but delivers
 * headers, body chunks, and end-of-stream via stream_ops callbacks.
 * ================================================================ */

/* Streaming-specific error handler — calls on_end instead of cb */
static void uv_io_http_stream_finish_error(uv_io_http_op_t *op, int error_status)
{
    /* Idempotency: a re-entry (e.g. a UV_ECANCELED read cb after this close)
     * must not deliver on_end again or reach the free fall-through. */
    if (op->teardown_started) return;
    op->teardown_started = 1;
    op->tearing_down = 1;

    /* Stop and close the connect timer if initialized and active */
    if (op->timer_init && op->connect_timer.data &&
        !uv_is_closing((uv_handle_t *)&op->connect_timer)) {
        uv_timer_stop(&op->connect_timer);
        uv_io_http_close_handle(op, (uv_handle_t *)&op->connect_timer, uv_io_http_timer_close_cb);
    }

    if (op->rt && op->rt->active_stream == op) {
        op->rt->active_stream = NULL;
    }

    if (op->stream_ops.on_end) {
        op->stream_ops.on_end(op->stream_ops.user_data, error_status, "stream aborted");
    }

    if (op->tcp_init && !uv_is_closing((uv_handle_t *)&op->tcp)) {
        uv_io_http_close_handle(op, (uv_handle_t *)&op->tcp, uv_io_http_stream_close_cb);
    } else {
        uv_io_http_finalize(op);
    }
}

/* Streaming DNS resolution callback */
static void uv_io_http_stream_getaddrinfo_cb(uv_getaddrinfo_t *req,
                                                int status, struct addrinfo *res)
{
    uv_io_http_op_t *op = (uv_io_http_op_t *)req->data;

    /*
     * If the op was aborted before DNS completed, stream_cleanup cancelled
     * this request and deferred freeing the op to us. Free addrinfo + op and
     * return — do not touch any handles (none were init'd yet).
     */
    if (op->aborted) {
        if (res) uv_freeaddrinfo(res);
        uv_io_http_finalize(op);
        return;
    }

    if (status < 0) {
        uv_io_http_stream_finish_error(op, QZ_ERR_NETWORK);
        uv_freeaddrinfo(res);
        return;
    }

    if (!res) {
        uv_io_http_stream_finish_error(op, QZ_ERR_NETWORK);
        return;
    }

    /* Initialize TCP handle */
    int rc = uv_tcp_init(&op->rt->loop, &op->tcp);
    if (rc < 0) {
        uv_freeaddrinfo(res);
        uv_io_http_stream_finish_error(op, QZ_ERR_NETWORK);
        return;
    }
    op->tcp_init = 1;
    op->tcp.data = op;

    /* Connect using the first resolved address */
    op->connect_req.data = op;
    rc = uv_tcp_connect(&op->connect_req, &op->tcp, res->ai_addr,
                        uv_io_http_connect_cb);
    uv_freeaddrinfo(res);

    if (rc < 0) {
        uv_io_http_stream_finish_error(op, QZ_ERR_NETWORK);
        return;
    }

    /* Start connect timer */
    rc = uv_timer_init(&op->rt->loop, &op->connect_timer);
    if (rc < 0) {
        /* Timer init failed — non-fatal */
    } else {
        op->timer_init = 1;
        op->connect_timer.data = op;
        rc = uv_timer_start(&op->connect_timer, uv_io_http_connect_timer_cb,
                            PAL_UV_CONNECT_TIMEOUT_MS, 0);
        if (rc < 0) {
            uv_io_http_close_handle(op, (uv_handle_t *)&op->connect_timer, uv_io_http_timer_close_cb);
        }
    }
}

uint64_t uv_io_http_request_stream(qz_t *rt,
                                    const char *url, const char *method,
                                    const char *headers, const char *body,
                                    size_t body_len,
                                    qz_io_stream_ops_t *ops)
{
    /* Returns the op id (uint64) handed to JS as the abort handle, or 0 on a
     * synchronous failure (JS treats 0 as "no op to abort"). */

    if (!url || !ops) {
        if (ops && ops->on_end) {
            ops->on_end(ops->user_data, QZ_ERR_INVALID_ARG, "request setup failed");
        }
        return 0;
    }

    uv_io_http_op_t *op = (uv_io_http_op_t *)calloc(1, sizeof(*op));
    if (!op) {
        if (ops->on_end) {
            ops->on_end(ops->user_data, QZ_ERR_GENERIC, "request setup failed");
        }
        return 0;
    }

    op->cb = NULL;  /* streaming uses ops callbacks instead */
    op->cb_data = NULL;
    op->rt = rt;
    op->streaming = 1;
    op->stream_ops = *ops;  /* copy stream ops */
    op->chunk_state = CHUNK_STATE_SIZE;

    /* Parse URL */
    {
        uv_io_url_t parts = {0};
        if (uv_io_parse_url(url, &parts) < 0) {
            if (ops->on_end) {
                ops->on_end(ops->user_data, QZ_ERR_INVALID_ARG, "request setup failed");
            }
            free(op);
            return 0;
        }
        op->host    = parts.host;
        op->port    = parts.port;
        op->path    = parts.path;
        op->use_tls = parts.tls;
        /* parts fields are now owned by op — do NOT call uv_io_url_free */
    }

    /* Outbound proxy from env (must precede DNS: it decides connect target).
     * A malformed proxy URL fails the request — failing closed. */
    if (uv_io_http_apply_proxy(op) < 0) {
        uv_io_http_finalize(op);
        if (ops->on_end) {
            ops->on_end(ops->user_data, QZ_ERR_INVALID_ARG, "request setup failed");
        }
        return 0;
    }

    /* If TLS is requested, check compile-time support */
    if (op->use_tls) {
#if QZ_WITH_TLS
        /* TLS handshake will be initiated after connect */
#else
        uv_io_http_finalize(op);
        if (ops->on_end) {
            ops->on_end(ops->user_data, QZ_ERR_NETWORK, "request setup failed");
        }
        return 0;
#endif
    }

    /* Copy method and headers */
    op->method = method ? strdup(method) : strdup("GET");
    op->headers_json = headers ? strdup(headers) : NULL;

    /* Copy body */
    if (body && body_len > 0) {
        op->body = (char *)malloc(body_len + 1);
        if (op->body) {
            memcpy(op->body, body, body_len);
            op->body[body_len] = '\0';
            op->body_len = body_len;
        }
    }

    /* Resolve hostname via uv_getaddrinfo */
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;     /* IPv4 + IPv6 */
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;

    /* Build port string for getaddrinfo. Via proxy, resolve the proxy. */
    char port_str[8];
    snprintf(port_str, sizeof(port_str), "%d", uv_io_http_connect_port(op));

    op->addr_req.data = op;
    int rc = uv_getaddrinfo(&rt->loop, &op->addr_req,
                            uv_io_http_stream_getaddrinfo_cb,
                            uv_io_http_connect_host(op), port_str, &hints);
    if (rc < 0) {
        uv_io_http_finalize(op);
        if (ops->on_end) {
            ops->on_end(ops->user_data, QZ_ERR_NETWORK, "request setup failed");
        }
        return 0;
    }

    /*
     * Only now is the op committed to async I/O (getaddrinfo submitted) with
     * a callback that will run later. Track it as the active stream so
     * uv_io_http_abort can reach it (teardown), and register it in the
     * per-op abort registry so pal.httpRequestAbort(op_id) can target this
     * exact op even when several fetches are in flight.
     */
    op->op_id = ++rt->http_op_seq;
    op->next = rt->http_ops;
    rt->http_ops = op;
    rt->active_stream = op;
    return op->op_id;
}
