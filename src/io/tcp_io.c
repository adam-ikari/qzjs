/**
 * qzjs TCP socket PAL — raw libuv TCP for JS-level protocol implementations
 *
 * Provides pal.tcpConnect/tcpWrite/tcpClose so the JS polyfill can implement
 * application-layer protocols (e.g. RFC 6455 WebSocket) on top of raw TCP,
 * without coupling the WS client to a C-level WS client library.
 *
 * Design: C handles the libuv async I/O (DNS, connect, read, write, close);
 * the JS layer handles protocol framing, masking, and handshake parsing.
 * This mirrors the fetch API pattern where C provides transport and JS
 * provides protocol semantics.
 */

#include "base/qz_rt.h"
#include <uv.h>
#include <string.h>
#include <strings.h>
#include <stdlib.h>

#if QZ_WITH_TLS
#include <mbedtls/ssl.h>
#include <mbedtls/net_sockets.h>
#include <mbedtls/entropy.h>
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/error.h>
#include <mbedtls/x509_crt.h>
#include <mbedtls/pk.h>
#endif

/* TLS server context (shared across connections from one listener) */
#if QZ_WITH_TLS

/* One certificate (+key). The first entry with name[0]=='\0' is the
 * default; others are selected by SNI hostname (exact or "*.suffix"). */
typedef struct qz_tls_cert_entry {
    struct qz_tls_cert_entry *next;
    mbedtls_x509_crt cert;
    mbedtls_pk_context key;
    char name[256];
} qz_tls_cert_entry_t;

typedef struct {
    mbedtls_ssl_config ssl_conf;
    qz_tls_cert_entry_t *certs;    /* live list (default first) */
    qz_tls_cert_entry_t *retired;  /* old list awaiting last unref */
    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context ctr_drbg;
    int refs;                        /* listener + in-flight connections */
    const char *alpn_protos[8];      /* server ALPN list (NULL-terminated) */
    char alpn_buf[160];              /* storage for alpn_protos strings */
} qz_tls_server_ctx_t;

static void tls_cert_entries_free(qz_tls_cert_entry_t *list) {
    while (list) {
        qz_tls_cert_entry_t *n = list->next;
        mbedtls_x509_crt_free(&list->cert);
        mbedtls_pk_free(&list->key);
        free(list);
        list = n;
    }
}

/* Drop one reference. Retired certificates are only freed once the
 * listener is the sole remaining reference (no connection can still be
 * mid-handshake against them). */
static void tls_server_ctx_unref(qz_tls_server_ctx_t *tc) {
    if (!tc || --tc->refs > 0) return;
    mbedtls_ssl_config_free(&tc->ssl_conf);
    tls_cert_entries_free(tc->certs);
    tls_cert_entries_free(tc->retired);
    mbedtls_ctr_drbg_free(&tc->ctr_drbg);
    mbedtls_entropy_free(&tc->entropy);
    free(tc);
}

/* Wildcard-aware host match: "a.com" exact, "*.a.com" one label + suffix. */
static int tls_host_match(const char *pattern, const char *host) {
    if (strcasecmp(pattern, host) == 0) return 1;
    if (strncmp(pattern, "*.", 2) == 0) {
        const char *dot = strchr(host, '.');
        return dot && strcasecmp(pattern + 1, dot) == 0;
    }
    return 0;
}

/* SNI callback: pick the matching cert, fall back to the default entry. */
static int tls_sni_cb(void *p, mbedtls_ssl_context *ssl,
                      const unsigned char *name, size_t len) {
    qz_tls_server_ctx_t *tc = (qz_tls_server_ctx_t *)p;
    char host[256];
    if (len >= sizeof(host)) return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    memcpy(host, name, len);
    host[len] = '\0';

    qz_tls_cert_entry_t *def = NULL;
    for (qz_tls_cert_entry_t *e = tc->certs; e; e = e->next) {
        if (e->name[0] && tls_host_match(e->name, host))
            return mbedtls_ssl_set_hs_own_cert(ssl, &e->cert, &e->key);
        if (!e->name[0]) def = e;
    }
    if (def)
        return mbedtls_ssl_set_hs_own_cert(ssl, &def->cert, &def->key);
    return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
}

/* Parse one {cert, key, name?} into a new entry; NULL on failure. */
static qz_tls_cert_entry_t *tls_cert_entry_new(mbedtls_ctr_drbg_context *drbg,
                                                 const char *cert_path,
                                                 const char *key_path,
                                                 const char *name) {
    qz_tls_cert_entry_t *e = calloc(1, sizeof(*e));
    if (!e) return NULL;
    mbedtls_x509_crt_init(&e->cert);
    mbedtls_pk_init(&e->key);
    if (mbedtls_x509_crt_parse_file(&e->cert, cert_path) != 0 ||
        mbedtls_pk_parse_keyfile(&e->key, key_path, NULL,
                                 mbedtls_ctr_drbg_random, drbg) != 0) {
        mbedtls_x509_crt_free(&e->cert);
        mbedtls_pk_free(&e->key);
        free(e);
        return NULL;
    }
    snprintf(e->name, sizeof(e->name), "%s", name ? name : "");
    return e;
}

/* Build cert list from JS tls object {cert, key, sni: {host: {cert,key}}}.
 * Returns list (default first) or NULL; *ok set to 0 on parse failure. */
static qz_tls_cert_entry_t *tls_certs_from_js(JSContext *ctx,
                                                JSValueConst tls_obj,
                                                mbedtls_ctr_drbg_context *drbg,
                                                int *ok) {
    qz_tls_cert_entry_t *head = NULL, **tail = &head;
    *ok = 1;

    JSValue cv = JS_GetPropertyStr(ctx, tls_obj, "cert");
    JSValue kv = JS_GetPropertyStr(ctx, tls_obj, "key");
    const char *cert_path = JS_ToCString(ctx, cv);
    const char *key_path = JS_ToCString(ctx, kv);
    if (cert_path && key_path) {
        qz_tls_cert_entry_t *e = tls_cert_entry_new(drbg, cert_path, key_path, NULL);
        if (!e) { *ok = 0; }
        else { *tail = e; tail = &e->next; }
    }
    if (cert_path) JS_FreeCString(ctx, cert_path);
    if (key_path) JS_FreeCString(ctx, key_path);
    JS_FreeValue(ctx, cv);
    JS_FreeValue(ctx, kv);

    JSValue sni = JS_GetPropertyStr(ctx, tls_obj, "sni");
    if (JS_IsObject(sni)) {
        JSPropertyEnum *props = NULL;
        uint32_t nprops = 0;
        if (JS_GetOwnPropertyNames(ctx, &props, &nprops, sni,
                                   JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
            for (uint32_t i = 0; i < nprops && *ok; i++) {
                JSValue entry = JS_GetProperty(ctx, sni, props[i].atom);
                const char *host = JS_AtomToCString(ctx, props[i].atom);
                if (JS_IsObject(entry) && host) {
                    JSValue ecv = JS_GetPropertyStr(ctx, entry, "cert");
                    JSValue ekv = JS_GetPropertyStr(ctx, entry, "key");
                    const char *ecert = JS_ToCString(ctx, ecv);
                    const char *ekey = JS_ToCString(ctx, ekv);
                    if (ecert && ekey) {
                        qz_tls_cert_entry_t *e = tls_cert_entry_new(drbg, ecert, ekey, host);
                        if (!e) *ok = 0;
                        else { *tail = e; tail = &e->next; }
                    } else {
                        *ok = 0;
                    }
                    if (ecert) JS_FreeCString(ctx, ecert);
                    if (ekey) JS_FreeCString(ctx, ekey);
                    JS_FreeValue(ctx, ecv);
                    JS_FreeValue(ctx, ekv);
                } else {
                    *ok = 0;
                }
                JS_FreeCString(ctx, host);
                JS_FreeValue(ctx, entry);
            }
            for (uint32_t i = 0; i < nprops; i++) JS_FreeAtom(ctx, props[i].atom);
            js_free(ctx, props);
        } else {
            *ok = 0;
        }
    }
    JS_FreeValue(ctx, sni);

    if (!*ok) {
        tls_cert_entries_free(head);
        return NULL;
    }
    return head;
}

/* Shared setup: init ctx, build cert list, config defaults + SNI callback. */
static qz_tls_server_ctx_t *tls_server_ctx_new(JSContext *ctx,
                                                 JSValueConst tls_obj) {
    qz_tls_server_ctx_t *tc = calloc(1, sizeof(*tc));
    if (!tc) {
        JS_ThrowOutOfMemory(ctx);
        return NULL;
    }
    int ok = 0;
    do {
        mbedtls_ssl_config_init(&tc->ssl_conf);
        mbedtls_entropy_init(&tc->entropy);
        mbedtls_ctr_drbg_init(&tc->ctr_drbg);
        if (mbedtls_ctr_drbg_seed(&tc->ctr_drbg, mbedtls_entropy_func,
                                  &tc->entropy, NULL, 0) != 0) break;
        tc->certs = tls_certs_from_js(ctx, tls_obj, &tc->ctr_drbg, &ok);
        if (!ok || !tc->certs) break;
        if (mbedtls_ssl_config_defaults(&tc->ssl_conf, MBEDTLS_SSL_IS_SERVER,
                                        MBEDTLS_SSL_TRANSPORT_STREAM,
                                        MBEDTLS_SSL_PRESET_DEFAULT) != 0) break;
        mbedtls_ssl_conf_rng(&tc->ssl_conf, mbedtls_ctr_drbg_random, &tc->ctr_drbg);
        /* Certs are selected per-handshake in tls_sni_cb (default entry
         * included) so a hot reload swaps them without touching ssl_conf. */
        mbedtls_ssl_conf_sni(&tc->ssl_conf, tls_sni_cb, tc);
        /* ALPN: optional alpn array, default ['http/1.1'] for backward compat. */
        {
            int n = 0;
            size_t off = 0;
            JSValue av = JS_GetPropertyStr(ctx, tls_obj, "alpn");
            int alpn_given = !JS_IsUndefined(av) && !JS_IsNull(av);
            int alpn_err = alpn_given && !JS_IsArray(av);
            if (!alpn_err && alpn_given) {
                JSValue lv = JS_GetPropertyStr(ctx, av, "length");
                uint32_t count = 0;
                JS_ToUint32(ctx, &count, lv);
                JS_FreeValue(ctx, lv);
                for (uint32_t i = 0; i < count && !alpn_err; i++) {
                    JSValue item = JS_GetPropertyUint32(ctx, av, i);
                    const char *s = JS_IsString(item) ? JS_ToCString(ctx, item) : NULL;
                    if (!s || !s[0] || n >= 7 ||
                        off + strlen(s) + 1 > sizeof(tc->alpn_buf))
                        alpn_err = 1;
                    else {
                        size_t len = strlen(s);
                        memcpy(tc->alpn_buf + off, s, len + 1);
                        tc->alpn_protos[n++] = tc->alpn_buf + off;
                        off += len + 1;
                    }
                    if (s) JS_FreeCString(ctx, s);
                    JS_FreeValue(ctx, item);
                }
            }
            JS_FreeValue(ctx, av);
            if (alpn_err) break;
            /* Default: http/1.1 only (backward compatible with existing serve()). */
            if (!alpn_given) {
                size_t len = strlen("http/1.1");
                memcpy(tc->alpn_buf + off, "http/1.1", len + 1);
                tc->alpn_protos[n++] = tc->alpn_buf + off;
                off += len + 1;
            }
            if (n > 0) {
                tc->alpn_protos[n] = NULL;
                if (mbedtls_ssl_conf_alpn_protocols(&tc->ssl_conf,
                                                    tc->alpn_protos) != 0)
                    break;
            }
        }
        tc->refs = 1;
        return tc;
    } while (0);

    tls_server_ctx_unref(tc);
    JS_ThrowTypeError(ctx, "tcpListen: TLS setup failed (bad cert/key?)");
    return NULL;
}
#endif

/* ── Per-connection state ── */
typedef struct qz_tcp_client qz_tcp_client_t;

/* Wrapper for uv_write requests: embeds the data pointer so the write
 * callback can free both the request and the buffer after the write completes. */
typedef struct {
    uv_write_t req;
    qz_tcp_client_t *client;
    void *data;
} tcp_write_req_t;

struct qz_tcp_client {
    qz_t *rt;
    uv_tcp_t tcp;            /* embedded; closed async, freed in close_cb */
    int tcp_active;          /* 1 once uv_tcp_init succeeded */
    int freed;               /* tcp_client_free idempotency guard */
    int closed;              /* onclose delivered */
    JSContext *jsctx;
    JSValue handle_obj;      /* rooted JS handle object */
    JSValue ondata;          /* callback: ondata(data: ArrayBuffer) */
    JSValue onerror;         /* callback: onerror(msg: string) */
    JSValue onclose;         /* callback: onclose(code: int) */
    JSValue onconnect;       /* callback: onconnect() — TCP established */
    uv_getaddrinfo_t addr_req;  /* DNS resolution */
    uv_connect_t connect_req;   /* TCP connect */
    char host[256];
    int port;
    struct qz_tcp_client *next;
#if QZ_WITH_TLS
    int use_tls;
    int tls_is_client;           /* 1 = tcpConnect client, 0 = accepted server conn */
    mbedtls_ssl_context ssl;
    mbedtls_ssl_config tls_conf;         /* client only */
    mbedtls_x509_crt tls_ca;             /* client only */
    mbedtls_entropy_context tls_entropy; /* client only */
    mbedtls_ctr_drbg_context tls_drbg;   /* client only */
    const char *alpn_protos[8];          /* client only: NULL-terminated ALPN list */
    char alpn_buf[160];                  /* client only: storage for alpn_protos */
    unsigned char *tls_read_buf;
    size_t tls_read_buf_len;
    size_t tls_read_consumed;
    int tls_handshake_done;
    qz_tls_server_ctx_t *tls_server_ctx;
#endif
};

/* JS-visible handle wrapper for a TCP client. The JS handle object is a class
 * instance whose opaque is a tcp_client_handle_t*. When the connection is torn
 * down, client is set to NULL so stale JS handles (tcpWrite/tcpClose after
 * close) become no-ops instead of dereferencing freed memory. */
typedef struct {
    qz_tcp_client_t *client;
} tcp_client_handle_t;

static void tcp_client_handle_finalizer(JSRuntime *jsrt, JSValue val)
{
    qz_t *rt = qz_get_rt_from_jsrt(jsrt);
    if (!rt) return;
    tcp_client_handle_t *h = JS_GetOpaque(val, rt->tcp_client_class_id);
    if (h) js_free_rt(jsrt, h);
}

/* ── Forward declarations ── */
static void tcp_alloc_cb(uv_handle_t *handle, size_t suggested_size, uv_buf_t *buf);
static void tcp_read_cb(uv_stream_t *stream, ssize_t nread, const uv_buf_t *buf);
static void tcp_connect_cb(uv_connect_t *req, int status);
static void tcp_dns_cb(uv_getaddrinfo_t *req, int status, struct addrinfo *res);
static void tcp_write_cb(uv_write_t *req, int status);
static void tcp_close_cb(uv_handle_t *handle);
static void tcp_error(qz_tcp_client_t *c, const char *msg);

#if QZ_WITH_TLS
/* mbedTLS bio callbacks (defined with the listener path) — needed by the
 * TLS client setup below, which runs before them in this file. */
static int tls_send_cb(void *ctx, const unsigned char *buf, size_t len);
static int tls_recv_cb(void *ctx, unsigned char *buf, size_t len);
#endif

/* ── Teardown ── */
static void tcp_client_free(qz_tcp_client_t *c) {
    if (!c || c->freed) return;
    c->freed = 1;
    c->closed = 1;
    /* Detach the JS handle wrapper: stale JS handles must become no-ops
     * instead of dereferencing this (possibly soon-to-be-freed) client. */
    if (c->rt && JS_IsObject(c->handle_obj)) {
        tcp_client_handle_t *h = JS_GetOpaque(c->handle_obj, c->rt->tcp_client_class_id);
        if (h) h->client = NULL;
    }

    if (c->jsctx) {
        JS_FreeValue(c->jsctx, c->handle_obj);
        JS_FreeValue(c->jsctx, c->ondata);
        JS_FreeValue(c->jsctx, c->onerror);
        JS_FreeValue(c->jsctx, c->onclose);
        JS_FreeValue(c->jsctx, c->onconnect);
    }
#if QZ_WITH_TLS
    if (c->use_tls) {
        mbedtls_ssl_free(&c->ssl);
        free(c->tls_read_buf);
        c->tls_read_buf = NULL;
        c->tls_read_buf_len = 0;
        c->tls_read_consumed = 0;
        if (c->tls_is_client) {
            mbedtls_ssl_config_free(&c->tls_conf);
            mbedtls_x509_crt_free(&c->tls_ca);
            mbedtls_ctr_drbg_free(&c->tls_drbg);
            mbedtls_entropy_free(&c->tls_entropy);
        } else {
            tls_server_ctx_unref(c->tls_server_ctx);
            c->tls_server_ctx = NULL;
        }
    }
#endif
    if (c->tcp_active) {
        c->tcp_active = 0;
        uv_read_stop((uv_stream_t *)&c->tcp);
        uv_close((uv_handle_t *)&c->tcp, tcp_close_cb);
    } else {
        js_free(c->jsctx, c);
    }
}

/* Run after uv_close completes — safe to free the struct. */
static void tcp_close_cb(uv_handle_t *handle) {
    qz_tcp_client_t *c = (qz_tcp_client_t *)handle->data;
    if (c && c->jsctx)
        js_free(c->jsctx, c);
}

/* Fire the JS onerror callback, then teardown. */
static void tcp_error(qz_tcp_client_t *c, const char *msg) {
    if (c->closed) return;
    c->closed = 1;
    if (c->jsctx && JS_IsFunction(c->jsctx, c->onerror)) {
        JSValue err = JS_NewString(c->jsctx, msg);
        JS_Call(c->jsctx, c->onerror, c->handle_obj, 1, (JSValueConst[]){err});
        JS_FreeValue(c->jsctx, err);
    }
    tcp_client_free(c);
}

/* ── Alloc callback ── */
static void tcp_alloc_cb(uv_handle_t *handle, size_t suggested_size, uv_buf_t *buf) {
    qz_tcp_client_t *c = (qz_tcp_client_t *)handle->data;
    if (!c || c->freed) { buf->base = NULL; buf->len = 0; return; }
    buf->base = (char *)js_malloc(c->jsctx, suggested_size);
    buf->len = buf->base ? suggested_size : 0;
}

/* ── Read callback ── */
static void tcp_read_cb(uv_stream_t *stream, ssize_t nread, const uv_buf_t *buf) {
    qz_tcp_client_t *c = (qz_tcp_client_t *)(((uv_tcp_t *)stream)->data);
    if (!c) {
        if (buf->base) free(buf->base);
        return;
    }
    if (c->freed) {
        if (buf->base) js_free(c->jsctx, buf->base);
        return;
    }

    if (nread < 0) {
        if (buf->base) js_free(c->jsctx, buf->base);
        if (nread == UV_EOF) {
            if (!c->closed) {
                c->closed = 1;
                if (JS_IsFunction(c->jsctx, c->onclose))
                    JS_Call(c->jsctx, c->onclose, c->handle_obj, 0, NULL);
            }
            tcp_client_free(c);
        } else {
            tcp_error(c, uv_strerror((int)nread));
        }
        return;
    }

#if QZ_WITH_TLS
    if (c->use_tls) {
        if (nread > 0) {
            unsigned char *nb = realloc(c->tls_read_buf, c->tls_read_buf_len + (size_t)nread);
            if (!nb) {
                if (buf->base) js_free(c->jsctx, buf->base);
                tcp_error(c, "TLS OOM");
                return;
            }
            c->tls_read_buf = nb;
            memcpy(c->tls_read_buf + c->tls_read_buf_len, buf->base, (size_t)nread);
            c->tls_read_buf_len += (size_t)nread;
        }
        if (buf->base) js_free(c->jsctx, buf->base);

        int ret;
        if (!c->tls_handshake_done) {
            ret = mbedtls_ssl_handshake(&c->ssl);
            if (ret == 0) {
                c->tls_handshake_done = 1;
                if (c->tls_is_client) {
                    /* 纵深防御:authmode 已是 VERIFY_REQUIRED,握手成功即应
                     * 验证通过;再查一次,任何非 0 结果都拒绝连接。 */
                    if (mbedtls_ssl_get_verify_result(&c->ssl) != 0) {
                        tcp_error(c, "TLS certificate verification failed");
                        return;
                    }
                    /* 暴露协商结果(conn.alpn),由 JS 层决定是否接受。 */
                    const char *proto = mbedtls_ssl_get_alpn_protocol(&c->ssl);
                    JSValue av = proto ? JS_NewString(c->jsctx, proto) : JS_NULL;
                    if (JS_IsException(av)) av = JS_NULL;
                    JS_SetPropertyStr(c->jsctx, c->handle_obj, "alpn", av);
                    /* onconnect 延迟到 TLS 就绪后才触发:JS 此刻写出的字节
                     * 一定是明文(h2 前导/SETTINGS),由 mbedTLS 负责加密。 */
                    if (JS_IsFunction(c->jsctx, c->onconnect))
                        JS_Call(c->jsctx, c->onconnect, c->handle_obj, 0, NULL);
                    if (c->closed || c->freed) return;
                } else {
                    /* Server connection: expose negotiated ALPN protocol. */
                    const char *proto = mbedtls_ssl_get_alpn_protocol(&c->ssl);
                    JSValue av = proto ? JS_NewString(c->jsctx, proto) : JS_NULL;
                    if (JS_IsException(av)) av = JS_NULL;
                    JS_SetPropertyStr(c->jsctx, c->handle_obj, "alpn", av);
                }
            } else if (ret == MBEDTLS_ERR_SSL_WANT_READ || ret == MBEDTLS_ERR_SSL_WANT_WRITE) {
                return;
            } else {
                tcp_error(c, "TLS handshake failed");
                return;
            }
        }

        if (c->tls_handshake_done) {
            unsigned char dc[4096];
            while ((ret = mbedtls_ssl_read(&c->ssl, dc, sizeof(dc))) > 0) {
                JSValue ab = JS_NewArrayBufferCopy(c->jsctx, dc, (size_t)ret);
                if (!JS_IsException(ab) && JS_IsFunction(c->jsctx, c->ondata))
                    JS_Call(c->jsctx, c->ondata, c->handle_obj, 1, (JSValueConst[]){ab});
                JS_FreeValue(c->jsctx, ab);
                /* The ondata callback may have closed the connection
                 * (tcpClose/tcp_error → tcp_client_free → mbedtls_ssl_free);
                 * stop reading from the torn-down TLS context. The client
                 * struct is still allocated here (uv_close defers the free),
                 * so checking closed/freed is safe. */
                if (c->closed || c->freed) return;
            }
            if (ret == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY) {
                c->closed = 1;
                if (JS_IsFunction(c->jsctx, c->onclose))
                    JS_Call(c->jsctx, c->onclose, c->handle_obj, 0, NULL);
                tcp_client_free(c);
                return;
            }
        }

        if (c->tls_read_consumed > 0) {
            size_t rem = c->tls_read_buf_len - c->tls_read_consumed;
            if (rem > 0) memmove(c->tls_read_buf, c->tls_read_buf + c->tls_read_consumed, rem);
            c->tls_read_buf_len = rem;
            c->tls_read_consumed = 0;
        }
        return;
    }
#endif

    if (nread > 0 && !c->closed) {
        JSValue ab = JS_NewArrayBufferCopy(c->jsctx, (const uint8_t *)buf->base, (size_t)nread);
        js_free(c->jsctx, buf->base);
        if (JS_IsException(ab)) {
            tcp_error(c, "OOM in ondata");
            return;
        }
        if (JS_IsFunction(c->jsctx, c->ondata))
            JS_Call(c->jsctx, c->ondata, c->handle_obj, 1, (JSValueConst[]){ab});
        JS_FreeValue(c->jsctx, ab);
        return;
    }

    if (buf->base) js_free(c->jsctx, buf->base);
}

/* ── Write callback: free the request struct AND the data buffer ── */
static void tcp_write_cb(uv_write_t *req, int status) {
    (void)status;
    tcp_write_req_t *wr = (tcp_write_req_t *)req;
    qz_tcp_client_t *c = wr->client;
    if (c && c->jsctx) {
        js_free(c->jsctx, wr->data);
        js_free(c->jsctx, wr);
    } else {
        free(wr->data);
        free(wr);
    }
}

/* ── Connect callback ── */
static void tcp_connect_cb(uv_connect_t *req, int status) {
    qz_tcp_client_t *c = (qz_tcp_client_t *)req->data;

    if (!c || c->freed) return;

    if (status < 0) {
        char errbuf[128];
        snprintf(errbuf, sizeof(errbuf), "TCP connect failed: %s", uv_strerror(status));
        tcp_error(c, errbuf);
        return;
    }

#if QZ_WITH_TLS
    if (c->use_tls && c->tls_is_client) {
        /* TLS 客户端:onconnect 必须等握手完成(见 tcp_read_cb),否则 JS
         * 写出的协议前导会被当成明文发到 TLS 端口。先起读,再踢一次握手
         * 发出 ClientHello(此刻无入站数据,bio 返回 WANT_READ)。 */
        int r = uv_read_start((uv_stream_t *)&c->tcp, tcp_alloc_cb, tcp_read_cb);
        if (r != 0) {
            tcp_error(c, uv_strerror(r));
            return;
        }
        int hr = mbedtls_ssl_handshake(&c->ssl);
        if (hr == 0) {
            /* 极端情况:握手无需入站数据即完成。走与 tcp_read_cb 相同的
             * 交付路径,避免逻辑重复。 */
            tcp_read_cb((uv_stream_t *)&c->tcp, 0, &(uv_buf_t){NULL, 0});
        } else if (hr != MBEDTLS_ERR_SSL_WANT_READ && hr != MBEDTLS_ERR_SSL_WANT_WRITE) {
            tcp_error(c, "TLS handshake failed");
        }
        return;
    }
#endif

    /* Fire onconnect so the JS layer can send its protocol handshake */
    if (c->jsctx && JS_IsFunction(c->jsctx, c->onconnect))
        JS_Call(c->jsctx, c->onconnect, c->handle_obj, 0, NULL);

    int r = uv_read_start((uv_stream_t *)&c->tcp, tcp_alloc_cb, tcp_read_cb);
    if (r != 0) {
        tcp_error(c, uv_strerror(r));
    }
}

/* ── DNS callback ── */
static void tcp_dns_cb(uv_getaddrinfo_t *req, int status, struct addrinfo *res) {
    qz_tcp_client_t *c = (qz_tcp_client_t *)req->data;
    if (!c || c->freed) {
        if (res) uv_freeaddrinfo(res);
        return;
    }

    if (status < 0 || !res) {
        char buf[512];
        snprintf(buf, sizeof(buf), "DNS resolution failed for '%s': %s",
                 c->host, uv_strerror(status));
        if (res) uv_freeaddrinfo(res);
        tcp_error(c, buf);
        return;
    }

    struct sockaddr_in *addr = (struct sockaddr_in *)res->ai_addr;
    c->connect_req.data = c;
    uv_tcp_connect(&c->connect_req, &c->tcp, (const struct sockaddr *)addr, tcp_connect_cb);
    uv_freeaddrinfo(res);
}

#if QZ_WITH_TLS
/* Append one protocol id to the connection's ALPN list (storage lives in the
 * client struct because mbedtls only keeps a pointer to the list). */
static int tls_alpn_add(qz_tcp_client_t *c, int *n, size_t *off, const char *proto) {
    size_t len = strlen(proto);
    if (!len || *n >= 7 || *off + len + 1 > sizeof(c->alpn_buf)) return -1;
    memcpy(c->alpn_buf + *off, proto, len + 1);
    c->alpn_protos[(*n)++] = c->alpn_buf + *off;
    *off += len + 1;
    return 0;
}

/* Set up a TLS client context on a not-yet-connected tcpConnect client.
 * `tls_src` carries {servername?, alpn?[], ca?} — either the flat opts object
 * or opts.tls itself when that is an object. Returns 0, or -1 with a pending
 * JS exception (caller just tears the client down). */
static int tls_client_setup(JSContext *ctx, qz_tcp_client_t *c,
                            JSValueConst tls_src, const char *host) {
    /* Mark TLS first: the struct is js_mallocz'd and every mbedtls free is a
     * no-op on a zeroed context, so tcp_client_free cleans up a partial setup. */
    c->use_tls = 1;
    c->tls_is_client = 1;

    mbedtls_ssl_init(&c->ssl);
    mbedtls_ssl_config_init(&c->tls_conf);
    mbedtls_x509_crt_init(&c->tls_ca);
    mbedtls_entropy_init(&c->tls_entropy);
    mbedtls_ctr_drbg_init(&c->tls_drbg);

    int ret = mbedtls_ctr_drbg_seed(&c->tls_drbg, mbedtls_entropy_func,
                                    &c->tls_entropy, NULL, 0);
    if (ret != 0) {
        JS_ThrowTypeError(ctx, "tcpConnect: TLS RNG seed failed (-0x%04x)", -ret);
        return -1;
    }

    ret = mbedtls_ssl_config_defaults(&c->tls_conf, MBEDTLS_SSL_IS_CLIENT,
                                      MBEDTLS_SSL_TRANSPORT_STREAM,
                                      MBEDTLS_SSL_PRESET_DEFAULT);
    if (ret != 0) {
        JS_ThrowTypeError(ctx, "tcpConnect: TLS config failed (-0x%04x)", -ret);
        return -1;
    }
    mbedtls_ssl_conf_rng(&c->tls_conf, mbedtls_ctr_drbg_random, &c->tls_drbg);

    /* Trust anchors: explicit `ca` (PEM file path, or inline PEM), else the
     * system bundle — same search order as the HTTPS client in uv_io.c. */
    int ca_loaded = 0;
    JSValue cav = JS_GetPropertyStr(ctx, tls_src, "ca");
    if (JS_IsString(cav)) {
        const char *ca = JS_ToCString(ctx, cav);
        if (ca) {
            if (mbedtls_x509_crt_parse_file(&c->tls_ca, ca) == 0) {
                ca_loaded = 1;
            } else {
                /* mbedtls_x509_crt_parse wants a NUL-terminated PEM buffer. */
                if (mbedtls_x509_crt_parse(&c->tls_ca, (const unsigned char *)ca,
                                           strlen(ca) + 1) == 0)
                    ca_loaded = 1;
            }
            JS_FreeCString(ctx, ca);
        }
        JS_FreeValue(ctx, cav);
        if (!ca_loaded) {
            JS_ThrowTypeError(ctx, "tcpConnect: TLS ca not readable (bad path or PEM)");
            return -1;
        }
    } else {
        JS_FreeValue(ctx, cav);
        static const char *ca_paths[] = {
            "/etc/ssl/certs/ca-certificates.crt",       /* Debian/Ubuntu */
            "/etc/pki/tls/certs/ca-bundle.crt",         /* RHEL/CentOS */
            "/etc/ssl/ca-bundle.pem",                   /* OpenSUSE */
            "/usr/local/share/certs/ca-root-nss.crt",   /* FreeBSD */
            NULL
        };
        for (const char **p = ca_paths; *p != NULL; p++) {
            if (mbedtls_x509_crt_parse_file(&c->tls_ca, *p) == 0) { ca_loaded = 1; break; }
        }
    }
    if (ca_loaded) mbedtls_ssl_conf_ca_chain(&c->tls_conf, &c->tls_ca, NULL);
    /* 恒为 VERIFY_REQUIRED(与 uv_io.c 的 HTTPS 客户端同一纪律):没有可用 CA
     * 时握手必然失败,而不是静默降级成接受任意证书。 */
    mbedtls_ssl_conf_authmode(&c->tls_conf, MBEDTLS_SSL_VERIFY_REQUIRED);

    /* ALPN: opts.alpn (array of ids) or the h2-first default. */
    int n = 0;
    size_t off = 0;
    JSValue av = JS_GetPropertyStr(ctx, tls_src, "alpn");
    int alpn_given = !JS_IsUndefined(av) && !JS_IsNull(av);
    int alpn_err = alpn_given && !JS_IsArray(av);
    if (!alpn_err && alpn_given) {
        JSValue lv = JS_GetPropertyStr(ctx, av, "length");
        uint32_t count = 0;
        JS_ToUint32(ctx, &count, lv);
        JS_FreeValue(ctx, lv);
        for (uint32_t i = 0; i < count && !alpn_err; i++) {
            JSValue item = JS_GetPropertyUint32(ctx, av, i);
            const char *s = JS_IsString(item) ? JS_ToCString(ctx, item) : NULL;
            if (!s || tls_alpn_add(c, &n, &off, s) != 0) alpn_err = 1;
            if (s) JS_FreeCString(ctx, s);
            JS_FreeValue(ctx, item);
        }
    }
    JS_FreeValue(ctx, av);
    if (alpn_err) {
        JS_ThrowTypeError(ctx, "tcpConnect: TLS alpn must be an array of <=7 non-empty strings");
        return -1;
    }
    if (!alpn_given && (tls_alpn_add(c, &n, &off, "h2") != 0 ||
                        tls_alpn_add(c, &n, &off, "http/1.1") != 0)) {
        JS_ThrowTypeError(ctx, "tcpConnect: default alpn does not fit");
        return -1;
    }
    /* n == 0 只可能来自显式 `alpn: []` —— 意为「不提供 ALPN」。 */
    if (n > 0) {
        c->alpn_protos[n] = NULL;
        ret = mbedtls_ssl_conf_alpn_protocols(&c->tls_conf, c->alpn_protos);
        if (ret != 0) {
            JS_ThrowTypeError(ctx, "tcpConnect: TLS alpn rejected (-0x%04x)", -ret);
            return -1;
        }
    }

    ret = mbedtls_ssl_setup(&c->ssl, &c->tls_conf);
    if (ret != 0) {
        JS_ThrowTypeError(ctx, "tcpConnect: TLS setup failed (-0x%04x)", -ret);
        return -1;
    }

    /* SNI + certificate hostname verification. Failure is fatal: a client
     * that silently skips it is a man-in-the-middle hole. */
    char servername[256];
    JSValue sv = JS_GetPropertyStr(ctx, tls_src, "servername");
    const char *sn = JS_IsString(sv) ? JS_ToCString(ctx, sv) : NULL;
    snprintf(servername, sizeof(servername), "%s", (sn && sn[0]) ? sn : host);
    if (sn) JS_FreeCString(ctx, sn);
    JS_FreeValue(ctx, sv);
    /* 空 servername 会让 mbedtls 带着零长度主机名进入证书校验,语义不确定;
     * 明确拒绝,不给"可能跳过主机名校验"留口子。 */
    if (!servername[0]) {
        JS_ThrowTypeError(ctx, "tcpConnect: TLS requires a non-empty servername/host");
        return -1;
    }

    ret = mbedtls_ssl_set_hostname(&c->ssl, servername);
    if (ret != 0) {
        JS_ThrowTypeError(ctx, "tcpConnect: TLS hostname '%s' rejected (-0x%04x)",
                          servername, -ret);
        return -1;
    }
    mbedtls_ssl_set_bio(&c->ssl, c, tls_send_cb, tls_recv_cb, NULL);
    return 0;
}
#endif

/* ── PAL: tcpConnect(host, port, callbacks[, opts]) ──
 * opts = {tls: true|{...}, servername?, alpn?[], ca?}. `tls` truthy turns the
 * connection into a TLS client; when opts.tls is itself an object the TLS
 * fields are read from it. Omitting opts (or falsy tls) keeps plain TCP. */
JSValue js_pal_tcp_connect(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 3 || !JS_IsString(argv[0]) || !JS_IsNumber(argv[1]) || !JS_IsObject(argv[2]))
        return JS_ThrowTypeError(ctx, "tcpConnect(host, port, callbacks[, opts]) required");

    const char *host = JS_ToCString(ctx, argv[0]);
    if (!host) return JS_EXCEPTION;

    int32_t port = 0;
    JS_ToInt32(ctx, &port, argv[1]);
    if (port <= 0 || port > 65535) {
        JS_FreeCString(ctx, host);
        return JS_ThrowTypeError(ctx, "tcpConnect: invalid port %d", (int)port);
    }

    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) { JS_FreeCString(ctx, host); return JS_ThrowTypeError(ctx, "tcpConnect: no runtime"); }

    qz_tcp_client_t *c = js_mallocz(ctx, sizeof(*c));
    if (!c) { JS_FreeCString(ctx, host); return JS_ThrowTypeError(ctx, "tcpConnect: OOM"); }

    c->rt = rt;
    c->jsctx = ctx;
    c->ondata = JS_UNDEFINED;
    c->onerror = JS_UNDEFINED;
    c->onclose = JS_UNDEFINED;
    c->onconnect = JS_UNDEFINED;

    /* Extract callbacks */
    JSValue fn;
    fn = JS_GetPropertyStr(ctx, argv[2], "onconnect");
    if (JS_IsFunction(ctx, fn)) c->onconnect = fn; else JS_FreeValue(ctx, fn);
    fn = JS_GetPropertyStr(ctx, argv[2], "ondata");
    if (JS_IsFunction(ctx, fn)) c->ondata = fn; else JS_FreeValue(ctx, fn);
    fn = JS_GetPropertyStr(ctx, argv[2], "onerror");
    if (JS_IsFunction(ctx, fn)) c->onerror = fn; else JS_FreeValue(ctx, fn);
    fn = JS_GetPropertyStr(ctx, argv[2], "onclose");
    if (JS_IsFunction(ctx, fn)) c->onclose = fn; else JS_FreeValue(ctx, fn);

    /* Create the JS handle object: a class instance whose opaque is a
     * tcp_client_handle_t wrapping the client pointer. On close the wrapper's
     * client is NULLed so stale handles can't dereference freed memory. */
    tcp_client_handle_t *h = (tcp_client_handle_t *)js_mallocz(ctx, sizeof(*h));
    if (!h) {
        JS_FreeCString(ctx, host);
        JS_FreeValue(ctx, c->ondata);
        JS_FreeValue(ctx, c->onerror);
        JS_FreeValue(ctx, c->onclose);
        JS_FreeValue(ctx, c->onconnect);
        js_free(ctx, c);
        return JS_ThrowOutOfMemory(ctx);
    }
    h->client = c;
    JSValue obj = JS_NewObjectClass(ctx, rt->tcp_client_class_id);
    if (JS_IsException(obj)) {
        js_free(ctx, h);
        JS_FreeCString(ctx, host);
        JS_FreeValue(ctx, c->ondata);
        JS_FreeValue(ctx, c->onerror);
        JS_FreeValue(ctx, c->onclose);
        JS_FreeValue(ctx, c->onconnect);
        js_free(ctx, c);
        return JS_EXCEPTION;
    }
    JS_SetOpaque(obj, h);
    JS_SetPropertyStr(ctx, obj, "_tcpClient", JS_NewInt64(ctx, (int64_t)(uintptr_t)c));
    c->handle_obj = JS_DupValue(ctx, obj);

    /* Optional TLS (must be set up before the socket connects so the first
     * inbound byte already feeds the handshake). */
    int want_tls = 0;
    JSValue tls_src = JS_UNDEFINED;
    if (argc >= 4 && JS_IsObject(argv[3])) {
        JSValue tv = JS_GetPropertyStr(ctx, argv[3], "tls");
        int tb = JS_ToBool(ctx, tv);
        if (tb > 0) {
            want_tls = 1;
            tls_src = JS_IsObject(tv) ? JS_DupValue(ctx, tv) : JS_DupValue(ctx, argv[3]);
        }
        JS_FreeValue(ctx, tv);
        if (tb < 0) {
            tcp_client_free(c);
            JS_FreeCString(ctx, host);
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }
    }
    if (want_tls) {
#if QZ_WITH_TLS
        if (tls_client_setup(ctx, c, tls_src, host) != 0) {
            JS_FreeValue(ctx, tls_src);
            tcp_client_free(c);
            JS_FreeCString(ctx, host);
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }
#else
        JS_FreeValue(ctx, tls_src);
        tcp_client_free(c);
        JS_FreeCString(ctx, host);
        JS_FreeValue(ctx, obj);
        return JS_ThrowTypeError(ctx, "tcpConnect: built without TLS support");
#endif
    }
    JS_FreeValue(ctx, tls_src);

    /* Create TCP socket */
    if (uv_tcp_init(&rt->loop, &c->tcp) != 0) {
        /* tcp_client_free releases the handle object, the callbacks and the
         * client struct (tcp not active yet → immediate free). */
        tcp_client_free(c);
        JS_FreeCString(ctx, host);
        JS_FreeValue(ctx, obj);
        return JS_ThrowTypeError(ctx, "tcpConnect: tcp init failed");
    }
    c->tcp_active = 1;
    c->tcp.data = c;

    strncpy(c->host, host, sizeof(c->host) - 1);
    c->host[sizeof(c->host) - 1] = '\0';
    c->port = (int)port;
    JS_FreeCString(ctx, host);

    /* Start DNS resolution */
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;
    hints.ai_flags = 0;

    char port_str[8];
    snprintf(port_str, sizeof(port_str), "%d", (int)port);

    c->addr_req.data = c;
    int r = uv_getaddrinfo(&rt->loop, &c->addr_req, tcp_dns_cb, c->host, port_str, &hints);
    if (r != 0) {
        tcp_error(c, "uv_getaddrinfo failed");
        tcp_client_free(c);
        JS_FreeValue(ctx, obj);
        return JS_ThrowTypeError(ctx, "tcpConnect: DNS resolution failed");
    }

    return obj;
}

/* ── PAL: tcpWrite(handle, data) ── */
JSValue js_pal_tcp_write(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "tcpWrite(handle, data) required");

    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_UNDEFINED;
    tcp_client_handle_t *h = JS_GetOpaque(argv[0], rt->tcp_client_class_id);
    if (!h || !h->client) return JS_UNDEFINED;  /* stale/invalid handle */
    qz_tcp_client_t *c = h->client;
    if (c->closed || c->freed || !c->tcp_active)
        return JS_UNDEFINED;

    /* Extract the raw bytes from the argument (string or ArrayBuffer) */
    size_t len;
    void *data;

    if (JS_IsString(argv[1])) {
        const char *str = JS_ToCString(ctx, argv[1]);
        if (!str) return JS_EXCEPTION;
        len = strlen(str);
        data = js_malloc(ctx, len);
        if (!data) { JS_FreeCString(ctx, str); return JS_ThrowTypeError(ctx, "tcpWrite: OOM"); }
        memcpy(data, str, len);
        JS_FreeCString(ctx, str);
    } else if (JS_IsArrayBuffer(argv[1])) {
        size_t ab_len;
        uint8_t *src = JS_GetArrayBuffer(ctx, &ab_len, argv[1]);
        if (!src) { return JS_ThrowTypeError(ctx, "tcpWrite: invalid ArrayBuffer"); }
        data = js_malloc(ctx, ab_len);
        if (!data) { return JS_ThrowTypeError(ctx, "tcpWrite: OOM"); }
        memcpy(data, src, ab_len);
        len = ab_len;
    } else if (JS_GetUint8Array(ctx, &len, argv[1])) {
        /* Uint8Array / TypedArray view (e.g. from TextEncoder) */
        uint8_t *src = JS_GetUint8Array(ctx, &len, argv[1]);
        if (!src) return JS_ThrowTypeError(ctx, "tcpWrite: invalid Uint8Array");
        data = js_malloc(ctx, len);
        if (!data) return JS_ThrowTypeError(ctx, "tcpWrite: OOM");
        memcpy(data, src, len);
    } else {
        return JS_ThrowTypeError(ctx, "tcpWrite: data must be string or ArrayBuffer");
    }

    /* Allocate the write request wrapper (freed in tcp_write_cb with data) */
    tcp_write_req_t *wr = (tcp_write_req_t *)js_malloc(ctx, sizeof(tcp_write_req_t));
    if (!wr) {
        js_free(ctx, data);
        return JS_ThrowTypeError(ctx, "tcpWrite: OOM");
    }
    wr->client = c;
    wr->data = data;

#if QZ_WITH_TLS
    if (c->use_tls) {
        /* TLS path: encrypt via mbedtls_ssl_write → tls_send_cb → uv_write */
        js_free(ctx, wr);  /* not needed — mbedTLS handles I/O */
        unsigned char *buf = (unsigned char *)data;
        size_t remaining = len;
        while (remaining > 0) {
            int ret = mbedtls_ssl_write(&c->ssl, buf, (unsigned int)remaining);
            if (ret > 0) {
                buf += ret;
                remaining -= (size_t)ret;
            } else if (ret != MBEDTLS_ERR_SSL_WANT_WRITE) {
                break;
            }
        }
        js_free(ctx, data);
        return JS_UNDEFINED;
    }
#endif

    uv_buf_t wbuf = uv_buf_init((char *)data, (unsigned int)len);
    int r = uv_write(&wr->req, (uv_stream_t *)&c->tcp, &wbuf, 1, tcp_write_cb);
    if (r != 0) {
        js_free(ctx, wr);
        js_free(ctx, data);
        return JS_UNDEFINED;
    }
    return JS_UNDEFINED;
}

/* ── PAL: tcpClose(handle) ── */
JSValue js_pal_tcp_close(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "tcpClose(handle) required");

    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_UNDEFINED;
    tcp_client_handle_t *h = JS_GetOpaque(argv[0], rt->tcp_client_class_id);
    if (!h || !h->client) return JS_UNDEFINED;  /* stale/invalid handle */
    qz_tcp_client_t *c = h->client;
    if (c->closed || c->freed)
        return JS_UNDEFINED;

    c->closed = 1;
    if (c->jsctx && JS_IsFunction(c->jsctx, c->onclose))
        JS_Call(c->jsctx, c->onclose, c->handle_obj, 0, NULL);
    tcp_client_free(c);
    return JS_UNDEFINED;
}

/* ── TCP listener state ── */
typedef struct qz_tcp_listener qz_tcp_listener_t;

struct qz_tcp_listener {
    qz_t *rt;
    JSContext *jsctx;
    uv_tcp_t tcp;               /* listening socket; closed async */
    int closed;
    JSValue handle_obj;          /* rooted JS handle */
    JSValue onconnection;        /* JS callback: onconnection(conn_handle) */
#if QZ_WITH_TLS
    qz_tls_server_ctx_t *tls_ctx;  /* NULL for plain TCP */
#endif
};

/* JS-visible handle wrapper for a TCP listener (same stale-handle UAF
 * protection as the client handle). */
typedef struct {
    qz_tcp_listener_t *listener;
} tcp_listener_handle_t;

static void tcp_listener_handle_finalizer(JSRuntime *jsrt, JSValue val)
{
    qz_t *rt = qz_get_rt_from_jsrt(jsrt);
    if (!rt) return;
    tcp_listener_handle_t *h = JS_GetOpaque(val, rt->tcp_listener_class_id);
    if (h) js_free_rt(jsrt, h);
}

/* ── Listener close callback (libuv) ── */
static void tcp_listener_close_cb(uv_handle_t *handle) {
    qz_tcp_listener_t *l = (qz_tcp_listener_t *)handle->data;
    if (l) {
        /* Detach the JS handle wrapper so a stale handle (tcpCloseListener
         * after close) cannot dereference the freed listener. */
        if (l->jsctx && l->rt && JS_IsObject(l->handle_obj)) {
            tcp_listener_handle_t *h = JS_GetOpaque(l->handle_obj, l->rt->tcp_listener_class_id);
            if (h) h->listener = NULL;
        }
        if (l->jsctx) {
            JS_FreeValue(l->jsctx, l->handle_obj);
            JS_FreeValue(l->jsctx, l->onconnection);
        }
#if QZ_WITH_TLS
        if (l->tls_ctx) {
            tls_server_ctx_unref(l->tls_ctx);
            l->tls_ctx = NULL;
        }
#endif
        js_free(l->jsctx, l);
    }
}

#if QZ_WITH_TLS
/* ── TLS write callback: free the copied buffer ── */
static void tls_write_cb(uv_write_t *req, int status) {
    (void)status;
    free(req->data);
    free(req);
}

/* ── TLS send callback: mbedTLS writes encrypted data to the TCP socket ── */
static int tls_send_cb(void *ctx, const unsigned char *buf, size_t len) {
    qz_tcp_client_t *c = (qz_tcp_client_t *)ctx;
    char *copy = malloc(len);
    if (!copy) return MBEDTLS_ERR_NET_SEND_FAILED;
    memcpy(copy, buf, len);
    uv_write_t *req = malloc(sizeof(uv_write_t));
    if (!req) { free(copy); return MBEDTLS_ERR_NET_SEND_FAILED; }
    req->data = copy;
    uv_buf_t wbuf = uv_buf_init(copy, (unsigned int)len);
    int ret = uv_write(req, (uv_stream_t *)&c->tcp, &wbuf, 1, tls_write_cb);
    if (ret != 0) { free(copy); free(req); return MBEDTLS_ERR_NET_SEND_FAILED; }
    return (int)len;
}

/* ── TLS recv callback: mbedTLS reads from the pre-buffered data ── */
static int tls_recv_cb(void *ctx, unsigned char *buf, size_t len) {
    qz_tcp_client_t *c = (qz_tcp_client_t *)ctx;
    size_t avail = c->tls_read_buf_len - c->tls_read_consumed;
    if (avail == 0) return MBEDTLS_ERR_SSL_WANT_READ;
    size_t n = len < avail ? len : avail;
    memcpy(buf, c->tls_read_buf + c->tls_read_consumed, n);
    c->tls_read_consumed += n;
    return (int)n;
}
#endif

/* ── Accept callback: new connection arrived ── */
static void tcp_listen_on_connection(uv_stream_t *server, int status) {
    if (status < 0) return;
    qz_tcp_listener_t *l = (qz_tcp_listener_t *)server->data;
    if (!l || l->closed) return;

    qz_t *rt = l->rt;

    /* Create client for the accepted connection */
    qz_tcp_client_t *c = js_mallocz(l->jsctx, sizeof(*c));
    if (!c) return;

    c->rt = rt;
    c->jsctx = l->jsctx;
    c->ondata = JS_UNDEFINED;
    c->onerror = JS_UNDEFINED;
    c->onclose = JS_UNDEFINED;
    c->onconnect = JS_UNDEFINED;

    uv_tcp_init(&rt->loop, &c->tcp);
    c->tcp_active = 1;
    c->tcp.data = c;

    if (uv_accept(server, (uv_stream_t *)&c->tcp) != 0) {
        tcp_client_free(c);
        return;
    }

#if QZ_WITH_TLS
    if (l->tls_ctx) {
        c->use_tls = 1;
        c->tls_server_ctx = l->tls_ctx;
        l->tls_ctx->refs++;
        c->tls_handshake_done = 0;
        c->tls_read_buf = NULL;
        c->tls_read_buf_len = 0;
        c->tls_read_consumed = 0;
        mbedtls_ssl_init(&c->ssl);
        int ret = mbedtls_ssl_setup(&c->ssl, &l->tls_ctx->ssl_conf);
        if (ret != 0) {
            tcp_client_free(c);
            return;
        }
        mbedtls_ssl_set_bio(&c->ssl, c, tls_send_cb, tls_recv_cb, NULL);
    }
#endif

    /* Create JS handle object (class instance with a client wrapper). */
    JSContext *ctx = l->jsctx;
    tcp_client_handle_t *h = (tcp_client_handle_t *)js_mallocz(ctx, sizeof(*h));
    if (!h) { tcp_client_free(c); return; }
    h->client = c;
    JSValue obj = JS_NewObjectClass(ctx, rt->tcp_client_class_id);
    if (JS_IsException(obj)) { js_free(ctx, h); tcp_client_free(c); return; }
    JS_SetOpaque(obj, h);
    JSValue ptr_val = JS_NewInt64(ctx, (int64_t)(uintptr_t)c);
    JS_SetPropertyStr(ctx, obj, "_tcpClient", ptr_val);
    c->handle_obj = JS_DupValue(ctx, obj);

    /* Start reading */
    uv_read_start((uv_stream_t *)&c->tcp, tcp_alloc_cb, tcp_read_cb);

    /* Notify JS */
    if (JS_IsFunction(ctx, l->onconnection)) {
        JSValue ret = JS_Call(ctx, l->onconnection, JS_UNDEFINED, 1, (JSValueConst[]){obj});
        JS_FreeValue(ctx, ret);
    }
    /* Read callbacks that JS attached to the conn object (ondata/onerror/onclose) */
    {
        JSValue fn = JS_GetPropertyStr(ctx, obj, "ondata");
        if (JS_IsFunction(ctx, fn)) { c->ondata = fn; } else JS_FreeValue(ctx, fn);
        fn = JS_GetPropertyStr(ctx, obj, "onerror");
        if (JS_IsFunction(ctx, fn)) { c->onerror = fn; } else JS_FreeValue(ctx, fn);
        fn = JS_GetPropertyStr(ctx, obj, "onclose");
        if (JS_IsFunction(ctx, fn)) { c->onclose = fn; } else JS_FreeValue(ctx, fn);
    }
    JS_FreeValue(ctx, obj);
}

/* ── PAL: tcpListen(port, hostname, backlog, onconnection) ── */
JSValue js_pal_tcp_listen(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 4 || !JS_IsNumber(argv[0]) || !JS_IsString(argv[1]) ||
        !JS_IsNumber(argv[2]) || !JS_IsFunction(ctx, argv[3]))
        return JS_ThrowTypeError(ctx, "tcpListen(port, hostname, backlog, onconnection) required");

    uint32_t port = 0;
    JS_ToUint32(ctx, &port, argv[0]);
    if (port == 0 || port > 65535)
        return JS_ThrowTypeError(ctx, "tcpListen: invalid port");

    const char *hostname = JS_ToCString(ctx, argv[1]);
    if (!hostname) return JS_EXCEPTION;

    uint32_t backlog = 0;
    JS_ToUint32(ctx, &backlog, argv[2]);
    if (backlog == 0) backlog = 128;

    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) { JS_FreeCString(ctx, hostname); return JS_ThrowTypeError(ctx, "tcpListen: no runtime"); }

    qz_tcp_listener_t *l = js_mallocz(ctx, sizeof(*l));
    if (!l) { JS_FreeCString(ctx, hostname); return JS_ThrowTypeError(ctx, "tcpListen: OOM"); }

    l->rt = rt;
    l->jsctx = ctx;
    l->onconnection = JS_DupValue(ctx, argv[3]);
#if QZ_WITH_TLS
    /* Optional 5th arg: tls = { cert, key, sni: { host: {cert, key} } } */
    if (argc >= 5 && !JS_IsUndefined(argv[4]) && !JS_IsNull(argv[4]) && JS_IsObject(argv[4])) {
        l->tls_ctx = tls_server_ctx_new(ctx, argv[4]);
        if (!l->tls_ctx) {
            JS_FreeCString(ctx, hostname);
            JS_FreeValue(ctx, l->onconnection);
            js_free(ctx, l);
            return JS_EXCEPTION;
        }
    }
#endif

    /* Create JS handle with close method: a class instance with a wrapper so
     * a stale handle can't dereference the freed listener. */
    tcp_listener_handle_t *h = (tcp_listener_handle_t *)js_mallocz(ctx, sizeof(*h));
    if (!h) {
        JS_FreeCString(ctx, hostname);
        JS_FreeValue(ctx, l->onconnection);
#if QZ_WITH_TLS
        if (l->tls_ctx) { tls_server_ctx_unref(l->tls_ctx); l->tls_ctx = NULL; }
#endif
        js_free(ctx, l);
        return JS_ThrowOutOfMemory(ctx);
    }
    h->listener = l;
    JSValue obj = JS_NewObjectClass(ctx, rt->tcp_listener_class_id);
    if (JS_IsException(obj)) {
        js_free(ctx, h);
        JS_FreeCString(ctx, hostname);
        JS_FreeValue(ctx, l->onconnection);
#if QZ_WITH_TLS
        if (l->tls_ctx) { tls_server_ctx_unref(l->tls_ctx); l->tls_ctx = NULL; }
#endif
        js_free(ctx, l);
        return JS_EXCEPTION;
    }
    JS_SetOpaque(obj, h);
    JSValue ptr_val = JS_NewInt64(ctx, (int64_t)(uintptr_t)l);
    JS_SetPropertyStr(ctx, obj, "_tcpListener", ptr_val);
    l->handle_obj = JS_DupValue(ctx, obj);

    /* Init TCP, bind, listen */
    uv_tcp_init(&rt->loop, &l->tcp);
    l->tcp.data = l;

    struct sockaddr_in addr;
    uv_ip4_addr(hostname, port, &addr);

    uv_tcp_bind(&l->tcp, (const struct sockaddr *)&addr, 0);
    int r = uv_listen((uv_stream_t *)&l->tcp, (int)backlog, tcp_listen_on_connection);
    JS_FreeCString(ctx, hostname);

    if (r != 0) {
        uv_close((uv_handle_t *)&l->tcp, tcp_listener_close_cb);
        JS_FreeValue(ctx, obj);
        return JS_ThrowTypeError(ctx, "tcpListen: listen failed (%s)", uv_strerror(r));
    }

    return obj;
}

/* ── PAL: tcpCloseListener(handle) ── */
JSValue js_pal_tcp_close_listener(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1 || !JS_IsObject(argv[0]))
        return JS_ThrowTypeError(ctx, "tcpCloseListener(handle) required");

    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (!rt) return JS_UNDEFINED;
    tcp_listener_handle_t *h = JS_GetOpaque(argv[0], rt->tcp_listener_class_id);
    if (!h || !h->listener) return JS_UNDEFINED;
    qz_tcp_listener_t *l = h->listener;
    if (l->closed) return JS_UNDEFINED;

    l->closed = 1;
    uv_close((uv_handle_t *)&l->tcp, tcp_listener_close_cb);
    return JS_UNDEFINED;
}

/* ── Module init ── */
void qz_tcp_io_init(JSContext *ctx, JSValue pal) {
    /* Register the handle classes once per runtime (guarded by class_id == 0;
     * qz_tcp_io_init can be re-invoked per context). */
    qz_t *rt = qz_get_rt_from_ctx(ctx);
    if (rt && rt->tcp_client_class_id == 0) {
        JSRuntime *jsrt = JS_GetRuntime(ctx);
        JS_NewClassID(jsrt, &rt->tcp_client_class_id);
        JSClassDef client_class = { .class_name = "TcpClient", .finalizer = tcp_client_handle_finalizer };
        JS_NewClass(jsrt, rt->tcp_client_class_id, &client_class);
        JS_NewClassID(jsrt, &rt->tcp_listener_class_id);
        JSClassDef listener_class = { .class_name = "TcpListener", .finalizer = tcp_listener_handle_finalizer };
        JS_NewClass(jsrt, rt->tcp_listener_class_id, &listener_class);
    }
    JS_SetPropertyStr(ctx, pal, "tcpConnect", JS_NewCFunction(ctx, js_pal_tcp_connect, "tcpConnect", 4));
    JS_SetPropertyStr(ctx, pal, "tcpWrite", JS_NewCFunction(ctx, js_pal_tcp_write, "tcpWrite", 2));
    JS_SetPropertyStr(ctx, pal, "tcpClose", JS_NewCFunction(ctx, js_pal_tcp_close, "tcpClose", 1));
    JS_SetPropertyStr(ctx, pal, "tcpListen", JS_NewCFunction(ctx, js_pal_tcp_listen, "tcpListen", 4));
    JS_SetPropertyStr(ctx, pal, "tcpCloseListener", JS_NewCFunction(ctx, js_pal_tcp_close_listener, "tcpCloseListener", 1));
}
