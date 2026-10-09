/**
 * qzjs polyfill: HPACK (RFC 7541) — HTTP/2 header compression.
 *
 * Decoder is FULL (RFC 7541): indexed / literal-incremental / literal-without-
 * indexing / literal-never-indexed, dynamic table with size accounting + table
 * size updates, and Huffman decoding (Appendix B, 257 symbols).
 *
 * Encoder is deliberately minimal (design §2.1): exact static-table matches are
 * emitted as indexed fields; everything else as literal-without-indexing with a
 * non-Huffman (raw) string. The encoder keeps NO dynamic table, so the peer's
 * receiving table stays empty for our direction — consistent and stateless.
 *
 * Pure JS, no dependencies, no `pal`. UTF-8 is hand-rolled (QuickJS-safe).
 */

// ── RFC 7541 Appendix B Huffman code table: [code, bitLength] for symbols
//    0..256 (256 = EOS). Source-verified against the canonical table.
export const HPACK_HUFFMAN = [
  [8184,13],
  [8388568,23],
  [268435426,28],
  [268435427,28],
  [268435428,28],
  [268435429,28],
  [268435430,28],
  [268435431,28],
  [268435432,28],
  [16777194,24],
  [1073741820,30],
  [268435433,28],
  [268435434,28],
  [1073741821,30],
  [268435435,28],
  [268435436,28],
  [268435437,28],
  [268435438,28],
  [268435439,28],
  [268435440,28],
  [268435441,28],
  [268435442,28],
  [1073741822,30],
  [268435443,28],
  [268435444,28],
  [268435445,28],
  [268435446,28],
  [268435447,28],
  [268435448,28],
  [268435449,28],
  [268435450,28],
  [268435451,28],
  [20,6],
  [1016,10],
  [1017,10],
  [4090,12],
  [8185,13],
  [21,6],
  [248,8],
  [2042,11],
  [1018,10],
  [1019,10],
  [249,8],
  [2043,11],
  [250,8],
  [22,6],
  [23,6],
  [24,6],
  [0,5],
  [1,5],
  [2,5],
  [25,6],
  [26,6],
  [27,6],
  [28,6],
  [29,6],
  [30,6],
  [31,6],
  [92,7],
  [251,8],
  [32764,15],
  [32,6],
  [4091,12],
  [1020,10],
  [8186,13],
  [33,6],
  [93,7],
  [94,7],
  [95,7],
  [96,7],
  [97,7],
  [98,7],
  [99,7],
  [100,7],
  [101,7],
  [102,7],
  [103,7],
  [104,7],
  [105,7],
  [106,7],
  [107,7],
  [108,7],
  [109,7],
  [110,7],
  [111,7],
  [112,7],
  [113,7],
  [114,7],
  [252,8],
  [115,7],
  [253,8],
  [8187,13],
  [524272,19],
  [8188,13],
  [16380,14],
  [34,6],
  [32765,15],
  [3,5],
  [35,6],
  [4,5],
  [36,6],
  [5,5],
  [37,6],
  [38,6],
  [39,6],
  [6,5],
  [116,7],
  [117,7],
  [40,6],
  [41,6],
  [42,6],
  [7,5],
  [43,6],
  [118,7],
  [44,6],
  [8,5],
  [9,5],
  [45,6],
  [119,7],
  [120,7],
  [121,7],
  [122,7],
  [123,7],
  [32766,15],
  [2044,11],
  [16381,14],
  [8189,13],
  [268435452,28],
  [1048550,20],
  [4194258,22],
  [1048551,20],
  [1048552,20],
  [4194259,22],
  [4194260,22],
  [4194261,22],
  [8388569,23],
  [4194262,22],
  [8388570,23],
  [8388571,23],
  [8388572,23],
  [8388573,23],
  [8388574,23],
  [16777195,24],
  [8388575,23],
  [16777196,24],
  [16777197,24],
  [4194263,22],
  [8388576,23],
  [16777198,24],
  [8388577,23],
  [8388578,23],
  [8388579,23],
  [8388580,23],
  [2097116,21],
  [4194264,22],
  [8388581,23],
  [4194265,22],
  [8388582,23],
  [8388583,23],
  [16777199,24],
  [4194266,22],
  [2097117,21],
  [1048553,20],
  [4194267,22],
  [4194268,22],
  [8388584,23],
  [8388585,23],
  [2097118,21],
  [8388586,23],
  [4194269,22],
  [4194270,22],
  [16777200,24],
  [2097119,21],
  [4194271,22],
  [8388587,23],
  [8388588,23],
  [2097120,21],
  [2097121,21],
  [4194272,22],
  [2097122,21],
  [8388589,23],
  [4194273,22],
  [8388590,23],
  [8388591,23],
  [1048554,20],
  [4194274,22],
  [4194275,22],
  [4194276,22],
  [8388592,23],
  [4194277,22],
  [4194278,22],
  [8388593,23],
  [67108832,26],
  [67108833,26],
  [1048555,20],
  [524273,19],
  [4194279,22],
  [8388594,23],
  [4194280,22],
  [33554412,25],
  [67108834,26],
  [67108835,26],
  [67108836,26],
  [134217694,27],
  [134217695,27],
  [67108837,26],
  [16777201,24],
  [33554413,25],
  [524274,19],
  [2097123,21],
  [67108838,26],
  [134217696,27],
  [134217697,27],
  [67108839,26],
  [134217698,27],
  [16777202,24],
  [2097124,21],
  [2097125,21],
  [67108840,26],
  [67108841,26],
  [268435453,28],
  [134217699,27],
  [134217700,27],
  [134217701,27],
  [1048556,20],
  [16777203,24],
  [1048557,20],
  [2097126,21],
  [4194281,22],
  [2097127,21],
  [2097128,21],
  [8388595,23],
  [4194282,22],
  [4194283,22],
  [33554414,25],
  [33554415,25],
  [16777204,24],
  [16777205,24],
  [67108842,26],
  [8388596,23],
  [67108843,26],
  [134217702,27],
  [67108844,26],
  [67108845,26],
  [134217703,27],
  [134217704,27],
  [134217705,27],
  [134217706,27],
  [134217707,27],
  [268435454,28],
  [134217708,27],
  [134217709,27],
  [134217710,27],
  [134217711,27],
  [134217712,27],
  [67108846,26],
  [1073741823,30],
];

// ── RFC 7541 Appendix A static table (61 entries, 1-indexed at runtime).
export const HPACK_STATIC_TABLE = [
  [":authority", ""],
  [":method", "GET"],
  [":method", "POST"],
  [":path", "/"],
  [":path", "/index.html"],
  [":scheme", "http"],
  [":scheme", "https"],
  [":status", "200"],
  [":status", "204"],
  [":status", "206"],
  [":status", "304"],
  [":status", "400"],
  [":status", "404"],
  [":status", "500"],
  ["accept-charset", ""],
  ["accept-encoding", "gzip, deflate"],
  ["accept-language", ""],
  ["accept-ranges", ""],
  ["accept", ""],
  ["access-control-allow-origin", ""],
  ["age", ""],
  ["allow", ""],
  ["authorization", ""],
  ["cache-control", ""],
  ["content-disposition", ""],
  ["content-encoding", ""],
  ["content-language", ""],
  ["content-length", ""],
  ["content-location", ""],
  ["content-range", ""],
  ["content-type", ""],
  ["cookie", ""],
  ["date", ""],
  ["etag", ""],
  ["expect", ""],
  ["expires", ""],
  ["from", ""],
  ["host", ""],
  ["if-match", ""],
  ["if-modified-since", ""],
  ["if-none-match", ""],
  ["if-range", ""],
  ["if-unmodified-since", ""],
  ["last-modified", ""],
  ["link", ""],
  ["location", ""],
  ["max-forwards", ""],
  ["proxy-authenticate", ""],
  ["proxy-authorization", ""],
  ["range", ""],
  ["referer", ""],
  ["refresh", ""],
  ["retry-after", ""],
  ["server", ""],
  ["set-cookie", ""],
  ["strict-transport-security", ""],
  ["transfer-encoding", ""],
  ["user-agent", ""],
  ["vary", ""],
  ["via", ""],
  ["www-authenticate", ""]
];

class HpackError extends Error {
  constructor(msg) { super('HPACK: ' + msg); this.name = 'HpackError'; }
}

// ── UTF-8 (manual, dependency-free) ──
function utf8Encode(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
    else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
      var c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
        var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00); i++;
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else out.push(0xEF, 0xBF, 0xBD);
    } else if (c >= 0xD800 && c <= 0xDFFF) out.push(0xEF, 0xBF, 0xBD);
    else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
  }
  return Uint8Array.from(out);
}
function utf8Decode(bytes) {
  var s = '', i = 0, n = bytes.length;
  while (i < n) {
    var b = bytes[i++];
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b < 0xE0) s += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i++] & 0x3F));
    else if (b < 0xF0) s += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F));
    else {
      var cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
      cp -= 0x10000;
      s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
    }
  }
  return s;
}

// ── Huffman decoding trie (built once at load) ──
var HUFF_TREE = (function () {
  var root = {};
  for (var sym = 0; sym < HPACK_HUFFMAN.length; sym++) {
    var code = HPACK_HUFFMAN[sym][0], len = HPACK_HUFFMAN[sym][1];
    var node = root;
    for (var i = len - 1; i >= 0; i--) {
      var bit = (code >>> i) & 1;
      node = node[bit] || (node[bit] = {});
    }
    node.sym = sym;
  }
  return root;
})();

function huffmanDecode(bytes) {
  var out = [], node = HUFF_TREE, runBits = 0, runAllOne = true;
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    for (var j = 7; j >= 0; j--) {
      var bit = (b >>> j) & 1;
      node = node[bit];
      if (!node) throw new HpackError('invalid Huffman code');
      runBits++; if (bit === 0) runAllOne = false;
      if (node.sym !== undefined) {
        if (node.sym === 256) throw new HpackError('EOS in Huffman data');
        out.push(node.sym);
        node = HUFF_TREE; runBits = 0; runAllOne = true;
      }
    }
  }
  if (node !== HUFF_TREE && (runBits >= 8 || !runAllOne))
    throw new HpackError('bad Huffman padding');
  return Uint8Array.from(out);
}

// ── Integer codec (RFC 7541 §5.1) ──
function decodeInt(buf, pos, prefixBits) {
  var mask = (1 << prefixBits) - 1;
  var b = buf[pos];
  if (b === undefined) throw new HpackError('integer underflow');
  pos++;
  var value = b & mask;
  if (value < mask) return [value, pos];
  var m = 0;
  do {
    b = buf[pos];
    if (b === undefined) throw new HpackError('integer underflow');
    pos++;
    value += (b & 0x7F) * Math.pow(2, m);
    m += 7;
    if (m > 49) throw new HpackError('integer too large');
  } while (b & 0x80);
  return [value, pos];
}
function encodeInt(arr, value, prefixBits, firstByte) {
  var mask = (1 << prefixBits) - 1;
  if (value < mask) { arr.push(firstByte | value); return; }
  arr.push(firstByte | mask);
  value -= mask;
  while (value >= 128) { arr.push((value % 128) + 128); value = Math.floor(value / 128); }
  arr.push(value);
}

// ── String codec (RFC 7541 §5.2) ──
function decodeStr(buf, pos) {
  var b = buf[pos];
  if (b === undefined) throw new HpackError('string underflow');
  var huff = (b & 0x80) !== 0;
  var r = decodeInt(buf, pos, 7);
  var len = r[0], p = r[1];
  if (p + len > buf.length) throw new HpackError('string underflow');
  var raw = buf.subarray(p, p + len);
  var bytes = huff ? huffmanDecode(raw) : raw;
  return [utf8Decode(bytes), p + len];
}
function encodeStr(arr, s) {
  var bytes = utf8Encode(s);
  encodeInt(arr, bytes.length, 7, 0x00); // H bit = 0 (raw)
  for (var i = 0; i < bytes.length; i++) arr.push(bytes[i]);
}

// Octet (UTF-8) length of a JS string — HPACK table size counts octets, not
// UTF-16 code units (RFC 7541 §1.1.1). Avoids allocating.
function octetLen(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length &&
             s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// ── Decoder ──
export class HPACKDecoder {
  constructor(maxSize) {
    this._maxSize = (maxSize === undefined) ? 4096 : maxSize;
    this._table = [];   // dynamic entries, newest first: {name,value,size}
    this._size = 0;
  }
  _evict() {
    while (this._size > this._maxSize && this._table.length) {
      var e = this._table.pop();
      this._size -= e.size;
    }
  }
  setMaxSize(n) { this._maxSize = n; this._evict(); }
  _add(name, value) {
    var size = 32 + octetLen(name) + octetLen(value);
    this._table.unshift({ name: name, value: value, size: size });
    this._size += size;
    this._evict();
  }
  _get(index) {
    if (index >= 1 && index <= 61) return HPACK_STATIC_TABLE[index - 1];
    var di = index - 62;
    if (di >= 0 && di < this._table.length) {
      var e = this._table[di];
      return [e.name, e.value];
    }
    throw new HpackError('bad table index ' + index);
  }
  decode(bytes) {
    var headers = [], pos = 0;
    while (pos < bytes.length) {
      var b = bytes[pos];
      if (b & 0x80) {                       // 1xxxxxxx indexed
        var r = decodeInt(bytes, pos, 7); pos = r[1];
        var e = this._get(r[0]);
        headers.push([e[0], e[1]]);
      } else if (b & 0x40) {                // 01xxxxxx literal incremental
        var r2 = decodeInt(bytes, pos, 6); pos = r2[1];
        var name2;
        if (r2[0] === 0) { var s2 = decodeStr(bytes, pos); name2 = s2[0]; pos = s2[1]; }
        else name2 = this._get(r2[0])[0];
        var v2 = decodeStr(bytes, pos); pos = v2[1];
        this._add(name2, v2[0]);
        headers.push([name2, v2[0]]);
      } else if (b & 0x20) {                // 001xxxxx dynamic table size update
        var r3 = decodeInt(bytes, pos, 5); pos = r3[1];
        this.setMaxSize(r3[0]);
      } else {                              // 000xxxxx literal (without/never)
        var r4 = decodeInt(bytes, pos, 4); pos = r4[1];
        var name4;
        if (r4[0] === 0) { var s4 = decodeStr(bytes, pos); name4 = s4[0]; pos = s4[1]; }
        else name4 = this._get(r4[0])[0];
        var v4 = decodeStr(bytes, pos); pos = v4[1];
        headers.push([name4, v4[0]]);
      }
    }
    return headers;
  }
}

// ── Encoder (minimal, stateless) ──
function staticExact(name, value) {
  for (var i = 0; i < HPACK_STATIC_TABLE.length; i++) {
    var e = HPACK_STATIC_TABLE[i];
    if (e[0] === name && e[1] === value) return i + 1;
  }
  return 0;
}
function staticName(name) {
  for (var i = 0; i < HPACK_STATIC_TABLE.length; i++)
    if (HPACK_STATIC_TABLE[i][0] === name) return i + 1;
  return 0;
}
export function hpackEncode(headers) {
  var out = [];
  for (var i = 0; i < headers.length; i++) {
    var name = headers[i][0], value = headers[i][1];
    var exact = staticExact(name, value);
    if (exact) { encodeInt(out, exact, 7, 0x80); continue; }
    var nameIdx = staticName(name);
    if (nameIdx) { encodeInt(out, nameIdx, 4, 0x10); }   // 0001xxxx name ref
    else { encodeInt(out, 0, 4, 0x10); encodeStr(out, name); }
    encodeStr(out, value);
  }
  return Uint8Array.from(out);
}

export { huffmanDecode, decodeInt, encodeInt };
