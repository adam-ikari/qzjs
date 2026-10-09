// IPC Envelope codec unit tests (M-P0, design doc §4 / §11).
//
// Covers: canonical byte layout freeze, encode/decode roundtrips, fb-default
// decoding of vtables with absent fields/short vtables, malformed-input
// rejection, and size contract. Cross-language wire compatibility
// (C <-> Python flatbuffers) lives in ipc_envelope_fbcheck.py (drives the
// ipc_envelope_cli helper); this file is the pure-C deterministic gate.

#include "ipc/ipc_envelope.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

// ---------------------------------------------------------------------------
// Canonical layout freeze: 4 + 2*6 bytes of header/table skeleton, fields at
// the documented offsets. If this ever changes, it is a wire-format change.
// ---------------------------------------------------------------------------
TEST(IpcEnvelope, CanonicalLayoutFrozen)
{
    const uint8_t payload[] = {0xAA, 0xBB};
    std::vector<uint8_t> buf(IPC_ENVELOPE_ENCODED_SIZE(2));
    size_t n = ipc_envelope_encode(buf.data(), buf.size(),
                                   1, 2, IPC_ENV_KIND_MESSAGE, 0 /* corr */,
                                   payload, 2);
    ASSERT_EQ(n, IPC_ENVELOPE_ENCODED_SIZE(2));
    ASSERT_EQ(n, 50u);

    // root uoffset -> table at +20
    EXPECT_EQ(buf[0], 20);
    // vtable: len=14, table_len=24, slots 4/8/12/16/20
    const uint8_t vt[] = {14, 0, 24, 0, 4, 0, 8, 0, 12, 0, 16, 0, 20, 0};
    EXPECT_EQ(std::memcmp(buf.data() + 4, vt, sizeof vt), 0) << "vtable";
    // soffset = 16 (vtable before table)
    EXPECT_EQ(buf[20], 16);
    // source=1 @+24, target=2 @+28, kind=0 @+32
    EXPECT_EQ(buf[24], 1);
    EXPECT_EQ(buf[28], 2);
    EXPECT_EQ(buf[32], 0);
    // payload uoffset=8 @+36 (vector at +44), corr=0 @+40, vlen=2 @+44
    EXPECT_EQ(buf[36], 8);
    EXPECT_EQ(buf[40], 0);
    EXPECT_EQ(buf[44], 2);
    // payload data @+48
    EXPECT_EQ(buf[48], 0xAA);
    EXPECT_EQ(buf[49], 0xBB);
}

// ---------------------------------------------------------------------------
// Roundtrip: all fields populated, multiple payload sizes (0 .. >64KiB).
// ---------------------------------------------------------------------------
TEST(IpcEnvelope, RoundtripAllFields)
{
    /* kind 是路由判别位（§4.1/§4.3）：MESSAGE/PORT_TRANSFER/CONTROL/STORAGE
     * 全枚举都要字节级往返（M-P4 新增 STORAGE=4）。corr 也往返：请求方分配
     * 单调 id，owner 回复原样回显，中继节点按它配对。 */
    const int32_t corr = 12345;
    for (int8_t kind : {IPC_ENV_KIND_MESSAGE, IPC_ENV_KIND_PORT_TRANSFER,
                        IPC_ENV_KIND_CONTROL, IPC_ENV_KIND_STORAGE}) {
        for (uint32_t plen : {0u, 1u, 3u, 40u, 1024u, 70000u}) {
            std::vector<uint8_t> payload(plen);
            for (uint32_t i = 0; i < plen; i++)
                payload[i] = (uint8_t)(i * 31 + 7);

            std::vector<uint8_t> buf(IPC_ENVELOPE_ENCODED_SIZE(plen));
            size_t n = ipc_envelope_encode(buf.data(), buf.size(),
                                           -5, 77, kind, corr,
                                           plen ? payload.data() : nullptr, plen);
            ASSERT_EQ(n, buf.size()) << "plen=" << plen;

            ipc_envelope_view_t v;
            ASSERT_EQ(ipc_envelope_decode(buf.data(), n, &v), 0) << "plen=" << plen;
            EXPECT_EQ(v.source, -5);
            EXPECT_EQ(v.target, 77);
            EXPECT_EQ(v.kind, kind) << "kind=" << (int)kind;
            EXPECT_EQ(v.corr, corr) << "plen=" << plen;
            ASSERT_EQ(v.payload_len, plen);
            if (plen) {
                EXPECT_EQ(std::memcmp(v.payload, payload.data(), plen), 0);
                // Zero-copy: view points into the encoded buffer, not a copy.
                EXPECT_EQ(v.payload, buf.data() + 48);
            } else {
                EXPECT_NE(v.payload, nullptr);  // empty vector header still present
            }
        }
    }
}

TEST(IpcEnvelope, EncodeRejectsSmallCap)
{
    uint8_t tiny[8];
    const uint8_t p[1] = {0};
    EXPECT_EQ(ipc_envelope_encode(tiny, sizeof tiny, 1, 2, 0, 0, p, 1), 0u);
    EXPECT_EQ(ipc_envelope_encode(nullptr, 1024, 1, 2, 0, 0, p, 1), 0u);
}

TEST(IpcEnvelope, DecodeRejectsBadArgs)
{
    ipc_envelope_view_t v;
    uint8_t buf[64];
    size_t n = ipc_envelope_encode(buf, sizeof buf, 1, 2, 0, 0, nullptr, 0);
    ASSERT_EQ(n, IPC_ENVELOPE_ENCODED_SIZE(0));
    EXPECT_EQ(ipc_envelope_decode(nullptr, n, &v), -1);
    EXPECT_EQ(ipc_envelope_decode(buf, n, nullptr), -1);
    // Truncated below the minimum (root + soffset header).
    EXPECT_EQ(ipc_envelope_decode(buf, 7, &v), -1);
}

// ---------------------------------------------------------------------------
// Malformed / hostile buffers must be rejected, never read out of bounds.
// Mutate every byte of a valid envelope across a range of values; the decoder
// either succeeds (mutation landed in a don't-care byte) or fails cleanly.
// ---------------------------------------------------------------------------
TEST(IpcEnvelope, MutationFuzz)
{
    const uint8_t payload[] = "hello";
    const size_t plen = sizeof payload - 1;  // without the NUL
    std::vector<uint8_t> good(IPC_ENVELOPE_ENCODED_SIZE(plen));
    size_t n = ipc_envelope_encode(good.data(), good.size(), 1, 2,
                                   IPC_ENV_KIND_MESSAGE, 0, payload, plen);
    ASSERT_EQ(n, good.size());

    for (size_t i = 0; i < n; i++) {
        for (uint8_t bad : {0x01u, 0x7Fu, 0xFFu}) {
            std::vector<uint8_t> m(good);
            m[i] = bad;
            ipc_envelope_view_t v;
            // No crash, no OOB (would trip ASan in the test build) is the
            // contract; clean success is legal for padding/don't-care bytes.
            (void)ipc_envelope_decode(m.data(), m.size(), &v);
        }
    }
}

// Truncations at every prefix length.
TEST(IpcEnvelope, TruncatedPrefixes)
{
    const uint8_t payload[] = {1, 2, 3, 4};
    std::vector<uint8_t> buf(IPC_ENVELOPE_ENCODED_SIZE(4));
    size_t n = ipc_envelope_encode(buf.data(), buf.size(), 3, 4,
                                   IPC_ENV_KIND_CONTROL, 0, payload, 4);
    ASSERT_EQ(n, buf.size());
    for (size_t cut = 0; cut < n; cut++) {
        ipc_envelope_view_t v;
        if (cut < 8)
            EXPECT_EQ(ipc_envelope_decode(buf.data(), cut, &v), -1) << cut;
        else
            (void)ipc_envelope_decode(buf.data(), cut, &v);  // no crash
    }
}


// ---------------------------------------------------------------------------
// fb-semantics: absent fields decode to defaults. Hand-build a buffer with
// the official layout but only the source field in a short vtable.
// ---------------------------------------------------------------------------
TEST(IpcEnvelope, ShortVtableDefaults)
{
    // root uoffset(4) | vtable: len=6, table_len=8, slot0=4 (7 bytes -> pad)
    // table @16: soffset=12, source=42
    const uint8_t b[] = {
        16, 0, 0, 0,
        6, 0, 8, 0, 4, 0,          // vtable: 2 hdr + 1 slot (idx 4..9)
        0, 0, 0, 0, 0, 0,          // pad (idx 10..15)
        12, 0, 0, 0,               // soffset (table @16)
        42, 0, 0, 0,               // source (table+4 = 20)
    };
    ipc_envelope_view_t v;
    ASSERT_EQ(ipc_envelope_decode(b, sizeof b, &v), 0);
    EXPECT_EQ(v.source, 42);
    EXPECT_EQ(v.target, 0);        // absent -> default 0
    EXPECT_EQ(v.kind, 0);
    EXPECT_EQ(v.payload, nullptr); // absent -> NULL
    EXPECT_EQ(v.payload_len, 0u);
}

// Absent payload slot (vtable entry 0) with source/target present.
TEST(IpcEnvelope, AbsentPayloadSlot)
{
    // Same skeleton as canonical but slot3 = 0 (payload omitted).
    std::vector<uint8_t> b = {
        16, 0, 0, 0,
        10, 0, 16, 0, 4, 0, 8, 0, 12, 0, 0, 0,
        12, 0, 0, 0,
        7, 0, 0, 0,
        9, 0, 0, 0,
        3,
        0, 0, 0,
    };
    ipc_envelope_view_t v;
    ASSERT_EQ(ipc_envelope_decode(b.data(), b.size(), &v), 0);
    EXPECT_EQ(v.source, 7);
    EXPECT_EQ(v.target, 9);
    EXPECT_EQ(v.kind, 3);
    EXPECT_EQ(v.payload, nullptr);
    EXPECT_EQ(v.payload_len, 0u);
}

}  // namespace
