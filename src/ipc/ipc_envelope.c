/*
 * IPC Envelope codec — see ipc_envelope.h for schema + canonical layout.
 */
#include "ipc_envelope.h"
#include "base/le_bytes.h"


#include <string.h>


size_t ipc_envelope_encode(uint8_t *out, size_t cap,
                           int32_t source, int32_t target, int8_t kind,
                           int32_t corr,
                           const uint8_t *payload, uint32_t payload_len)
{
    size_t need = IPC_ENVELOPE_ENCODED_SIZE(payload_len);
    if (!out || need > cap) return 0;
    qz_wr32(out + 0, 20);            /* root uoffset -> table at +20       */
    qz_wr16(out + 4, 14);            /* vtable_len: 2 hdr u16 + 5 slots u16 */
    qz_wr16(out + 6, 24);            /* table_len                          */
    qz_wr16(out + 8, 4);             /* vtable slot 0 (source)             */
    qz_wr16(out + 10, 8);            /* vtable slot 1 (target)             */
    qz_wr16(out + 12, 12);           /* vtable slot 2 (kind)               */
    qz_wr16(out + 14, 16);           /* vtable slot 3 (payload)            */
    qz_wr16(out + 16, 20);           /* vtable slot 4 (corr)               */
    qz_wr32(out + 20, 16);           /* soffset: vtable(+4) = table(+20)-16 */
    qz_wr32(out + 24, (uint32_t)source);
    qz_wr32(out + 28, (uint32_t)target);
    out[32] = (uint8_t)kind;           /* +33..35 pad                        */
    qz_wr32(out + 36, 8);            /* payload uoffset -> vector at +44   */
    qz_wr32(out + 40, (uint32_t)corr);
    qz_wr32(out + 44, payload_len);
    if (payload_len) memcpy(out + 48, payload, payload_len);
    return need;
}

/* Bounds-checked field read: vtable voff != 0 and the `size`-byte field at
 * table+voff must lie inside the buffer. NULL = absent -> fb default. */
static const uint8_t *field_at(const uint8_t *buf, size_t len,
                               size_t table, uint16_t voff, size_t size)
{
    if (voff == 0) return NULL;
    size_t pos = table + (size_t)voff;
    if (pos < table || pos > len - size) return NULL;
    return buf + pos;
}

/* Field id -> vtable entry. Vtables may be shorter than the schema (builder
 * writes only up to the highest field actually stored): missing slot reads
 * as absent. Slot i lives at vt + 4 + 2*i and needs vt_len >= 6 + 2*i. */
static uint16_t slot_voff(const uint8_t *vt, uint16_t vt_len, unsigned id)
{
    uint16_t need = (uint16_t)(6u + 2u * id);
    if (vt_len < need) return 0;
    return qz_rd16(vt + 4 + 2u * id);
}

int ipc_envelope_decode(const uint8_t *buf, size_t len,
                        ipc_envelope_view_t *view)
{
    if (view) {
        view->source = 0;
        view->target = 0;
        view->kind = 0;
        view->corr = 0;
        view->payload = NULL;
        view->payload_len = 0;
    }
    if (!buf || !view || len < 8) return -1;

    uint32_t root = qz_rd32(buf);                    /* root uoffset at 0  */
    if (root < 4 || root > len - 4) return -1;         /* soffset must fit */

    int32_t soffset = (int32_t)qz_rd32(buf + root);
    if (soffset < 0 || (size_t)soffset > root) return -1;
    const uint8_t *vt = buf + root - (size_t)soffset;  /* vtable = table-soffset */
    if ((size_t)(vt - buf) > len - 4) return -1;       /* vtable hdr must fit */
    uint16_t vt_len = qz_rd16(vt);
    if ((size_t)(vt - buf) + vt_len > len) return -1;  /* vt_len untrusted */

    const uint8_t *psrc = field_at(buf, len, root, slot_voff(vt, vt_len, 0), 4);
    const uint8_t *ptgt = field_at(buf, len, root, slot_voff(vt, vt_len, 1), 4);
    const uint8_t *pknd = field_at(buf, len, root, slot_voff(vt, vt_len, 2), 1);
    const uint8_t *pcor = field_at(buf, len, root, slot_voff(vt, vt_len, 4), 4);

    view->source = psrc ? (int32_t)qz_rd32(psrc) : 0;
    view->target = ptgt ? (int32_t)qz_rd32(ptgt) : 0;
    view->kind = pknd ? (int8_t)pknd[0] : 0;
    view->corr = pcor ? (int32_t)qz_rd32(pcor) : 0;

    const uint8_t *ppl = field_at(buf, len, root, slot_voff(vt, vt_len, 3), 4);
    if (ppl) {
        /* Vector uoffset is relative to its own position. */
        size_t self = (size_t)(ppl - buf);
        uint32_t uoff = qz_rd32(ppl);
        if (uoff == 0 || uoff > len - 4 - self) return -1;
        size_t hdr = self + uoff;                      /* vector len field  */
        uint32_t vlen = qz_rd32(buf + hdr);
        if (vlen > len - 4 - hdr) return -1;           /* data must fit     */
        view->payload = buf + hdr + 4;
        view->payload_len = vlen;
    }
    return 0;
}
