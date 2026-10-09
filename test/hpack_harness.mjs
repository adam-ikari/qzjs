/**
 * HPACK unit harness (verification only — not part of the runtime bundle).
 *
 * Runs polyfill/src/hpack.js (RFC 7541) standalone against the RFC's own
 * Appendix C vectors plus roundtrip, dynamic-table and error-path checks.
 * No transport, no shims — the codec in isolation.
 *
 * Usage: node test/hpack_harness.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { buildSync } = require(path.resolve(__dirname, '..', 'src', 'polyfill', 'node_modules', 'esbuild'));
const SRC = path.resolve(__dirname, '..', 'src', 'polyfill', 'src');

const bundlePath = '/tmp/hpack.bundle.mjs';
buildSync({
  entryPoints: [path.join(SRC, 'hpack.js')],
  bundle: true, format: 'esm', outfile: bundlePath, write: true, logLevel: 'silent',
});
const { HPACK_HUFFMAN, HPACK_STATIC_TABLE, HPACKDecoder, hpackEncode, huffmanDecode, decodeInt, encodeInt } = await import(bundlePath);

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}
function hex(u8) { return Buffer.from(u8).toString('hex'); }
function fromHex(h) { return new Uint8Array(Buffer.from(h, 'hex')); }
function eqBytes(u8, h, msg) { ok(hex(u8) === h, msg + ' [' + hex(u8) + ' vs ' + h + ']'); }
function eqHdrs(got, want, msg) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(g === w, msg + ' [' + g + ' vs ' + w + ']');
}
function throws(fn, re, msg) {
  try { fn(); ok(false, msg + ' (no throw)'); }
  catch (e) { ok(re.test(e.message), msg + ' [' + e.message + ']'); }
}
// Pack a '0'/'1' bit string into octets (for Huffman codec checks).
function fromBits(bits) {
  while (bits.length % 8) bits += '1';   // RFC 7541 §5.2: padding = EOS MSBs, all ones
  var out = new Uint8Array(bits.length / 8);
  for (var i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}
// Encode text with the module's own Appendix B table.
function huffEncode(s) {
  var bits = '';
  for (var i = 0; i < s.length; i++) {
    var e = HPACK_HUFFMAN[s.charCodeAt(i)];
    bits += e[0].toString(2).padStart(e[1], '0');
  }
  return fromBits(bits);
}

// ── 1. table sanity ──
console.log('tables');
ok(HPACK_STATIC_TABLE.length === 61, 'static table has 61 entries');
ok(HPACK_STATIC_TABLE[0][0] === ':authority' && HPACK_STATIC_TABLE[60][0] === 'www-authenticate',
  'static table endpoints (:authority .. www-authenticate)');
ok(HPACK_HUFFMAN.length === 257, 'huffman table has 257 symbols (incl. EOS)');
ok(HPACK_HUFFMAN.every(function (e) { return e[1] >= 5 && e[1] <= 30; }), 'huffman code lengths in [5,30]');
ok(new Set(HPACK_HUFFMAN.map(function (e) { return e[0] * 64 + e[1]; })).size === 257, 'huffman (code,len) pairs unique');

// ── 2. integer codec (RFC 7541 §5.1 / C.1) ──
console.log('integer codec');
ok(decodeInt(fromHex('0a'), 0, 5)[0] === 10, 'decodeInt 0x0a prefix5 = 10 (C.1)');
ok(decodeInt(fromHex('1f9a0a'), 0, 5)[0] === 1337, 'decodeInt 1f9a0a prefix5 = 1337 (C.1)');
ok(decodeInt(fromHex('1f9a0a'), 0, 5)[1] === 3, 'decodeInt 1337 consumes 3 octets');
var enc = [];
encodeInt(enc, 10, 5, 0); eqBytes(Uint8Array.from(enc), '0a', 'encodeInt 10 prefix5');
enc = [];
encodeInt(enc, 1337, 5, 0x1f); eqBytes(Uint8Array.from(enc), '1f9a0a', 'encodeInt 1337 prefix5 (C.1)');
enc = [];
encodeInt(enc, 127, 7, 0); eqBytes(Uint8Array.from(enc), '7f00', 'encodeInt 127 prefix7 = 7f00 (mask boundary uses continuation)');
enc = [];
encodeInt(enc, 128, 7, 0); eqBytes(Uint8Array.from(enc), '7f01', 'encodeInt 128 prefix7 = 7f01');
throws(function () { decodeInt(fromHex('1f'), 0, 5); }, /underflow/, 'truncated continuation -> integer underflow');
throws(function () { decodeInt(fromHex('1fffffffffffffffff'), 0, 5); }, /too large/, 'overflowing varint -> integer too large');
for (var v of [0, 1, 126, 127, 128, 16383, 16384, 1000000]) {
  var arr = [];
  encodeInt(arr, v, 5, 0);
  var r = decodeInt(Uint8Array.from(arr), 0, 5);
  ok(r[0] === v && r[1] === arr.length, 'int roundtrip ' + v + ' prefix5');
}

// ── 3. huffman (RFC 7541 C.4/C.6 + padding rules) ──
console.log('huffman');
eqBytes(huffmanDecode(fromHex('f1e3c2e5f23a6ba0ab90f4ff')), hex(Buffer.from('www.example.com')), 'huffman www.example.com (C.4.1)');
eqBytes(huffmanDecode(fromHex('6402')), hex(Buffer.from('302')), 'huffman 302 (C.6.1)');
eqBytes(huffmanDecode(huffEncode('a')), hex(Buffer.from('a')), "'a' + all-ones padding is legal");
throws(function () { huffmanDecode(fromBits('00011' + '11111111')); }, /bad Huffman padding/, '>= 8 padding bits rejected');
throws(function () { huffmanDecode(fromBits('00011' + '000')); }, /bad Huffman padding/, 'zero padding bits rejected');
// NB: the Appendix B code is complete, so "invalid Huffman code" (dead-end)
// is unreachable for any input; padding/EOS checks cover the malformed space.
throws(function () { huffmanDecode(fromBits('1'.repeat(30))); }, /EOS in Huffman data/, 'EOS symbol rejected');

// ── 4. decoder: RFC 7541 C.2 / C.3 vectors ──
console.log('decoder (Appendix C)');
var d = new HPACKDecoder();
eqHdrs(d.decode(fromHex('440c2f73616d706c652d70617468')), [[':path', '/sample-path']],
  'C.2.1 literal incremental, indexed name');
eqHdrs(d.decode(fromHex('be')), [[':path', '/sample-path']], 'C.2.1 entry cached at dynamic index 62');

d = new HPACKDecoder();
eqHdrs(d.decode(fromHex('400a637573746f6d2d6b65790c637573746f6d2d76616c7565')),
  [['custom-key', 'custom-value']], 'C.2.2 literal incremental, new name');
eqHdrs(d.decode(fromHex('be')), [['custom-key', 'custom-value']], 'C.2.2 new-name entry cached at 62');

d = new HPACKDecoder();
eqHdrs(d.decode(fromHex('040c2f73616d706c652d70617468')), [[':path', '/sample-path']],
  'C.2.3 literal without indexing, indexed name');
throws(function () { d.decode(fromHex('be')); }, /bad table index/, 'C.2.3 without-indexing left no dynamic entry');

d = new HPACKDecoder();
eqHdrs(d.decode(fromHex('100a637573746f6d2d6b65790c637573746f6d2d76616c7565')),
  [['custom-key', 'custom-value']], 'C.2.4 literal never indexed decodes');
throws(function () { d.decode(fromHex('be')); }, /bad table index/, 'C.2.4 never-indexed left no dynamic entry');

d = new HPACKDecoder();
eqHdrs(d.decode(fromHex('828684410f7777772e6578616d706c652e636f6d')),
  [[':method', 'GET'], [':scheme', 'http'], [':path', '/'], [':authority', 'www.example.com']],
  'C.3.1 request sequence (dynamic :authority added)');
eqHdrs(d.decode(fromHex('828685be000a637573746f6d2d6b65790c637573746f6d2d76616c7565')),
  [[':method', 'GET'], [':scheme', 'http'], [':path', '/index.html'],
   [':authority', 'www.example.com'], ['custom-key', 'custom-value']],
  'C.3.2 reuses dynamic index 62, new-name literal not indexed');

d = new HPACKDecoder();
eqHdrs(d.decode(fromHex('48826402')), [[':status', '302']], 'C.6.1 literal inc with Huffman value');

// ── 5. dynamic table: size update, eviction, octet accounting ──
console.log('dynamic table');
d = new HPACKDecoder();
eqHdrs(d.decode(fromHex('3f09')), [], 'table size update emits no header (max=40)');
eqHdrs(d.decode(fromHex('40026162026364')), [['ab', 'cd']], 'entry ab:cd (36 octets) fits, added to table');
eqHdrs(d.decode(fromHex('be')), [['ab', 'cd']], 'entry reachable at dynamic index 62');
d.decode(fromHex('3f03'));
throws(function () { d.decode(fromHex('be')); }, /bad table index/, 'shrink to 3 evicted 36-octet entry');

d = new HPACKDecoder();
d.decode(fromHex('3f09'));                             // max 40
d.decode(fromHex('40026162026364'));                   // ab:cd, 36
eqHdrs(d.decode(fromHex('40026566026768')), [['ef', 'gh']], 'second entry added (72 > 40 evicts first)');
eqHdrs(d.decode(fromHex('be')), [['ef', 'gh']], 'newest entry is index 62');
throws(function () { d.decode(fromHex('bf')); }, /bad table index/, 'older entry evicted (63 invalid)');

d = new HPACKDecoder();
d.decode(fromHex('3f03'));                             // max 34
eqHdrs(d.decode(fromHex('4002c3a90178')), [['é', 'x']], 'UTF-8 name decodes');
throws(function () { d.decode(fromHex('be')); }, /bad table index/,
  'table size counts UTF-8 octets: 32+2+1=35 > 34 evicts (JS .length would say 34 and keep it)');

// ── 6. encoder (minimal per design §2.1) ──
console.log('encoder');
eqBytes(hpackEncode([[':method', 'GET']]), '82', 'exact static match -> indexed');
eqBytes(hpackEncode([[':scheme', 'https']]), '87', 'exact static https -> 87');
eqBytes(hpackEncode([[':method', 'POST']]), '83', 'exact static POST -> 83');
eqBytes(hpackEncode([[':path', '/foo']]), '14042f666f6f', 'static name, new value -> literal w/o indexing');
eqBytes(hpackEncode([['content-length', '0']]), '1f0d0130', 'static name 28 exceeds 4-bit prefix -> 1f0d continuation');
eqBytes(hpackEncode([['x-a', 'b']]), '1003782d610162', 'new name -> literal w/o indexing, raw string');
eqBytes(hpackEncode([['x', '1']]), '1001780131', 'stateless: plain literal');
eqBytes(hpackEncode([['x', '1']]), '1001780131', 'stateless: repeat emits identical bytes');
var big = 'z'.repeat(200);
var encBig = hpackEncode([['h', big]]);
eqBytes(encBig.slice(0, 5), '1001687f49', 'string length 200 > 126 uses 7f continuation octets');
ok(encBig.length === 5 + 200, 'raw value bytes appended verbatim');

for (var entry of HPACK_STATIC_TABLE) {
  var bytes = hpackEncode([entry]);
  var back = new HPACKDecoder().decode(bytes);
  ok(back.length === 1 && back[0][0] === entry[0] && back[0][1] === entry[1],
    'encoder roundtrip static [' + entry[0] + ', ' + entry[1] + ']');
}

// ── 7. roundtrips + error paths ──
console.log('roundtrips & errors');
var cases = [
  [[':method', 'GET'], [':path', '/index.html'], ['custom', 'value']],
  [['x-multi', 'héllo wörld ☃'], ['é', '']],
  [['empty', ''], ['', '']],
  [['big', 'v'.repeat(500)], ['k'.repeat(200), 'x']],
];
for (var hdrs of cases) {
  var back2 = new HPACKDecoder().decode(hpackEncode(hdrs));
  ok(JSON.stringify(back2) === JSON.stringify(hdrs), 'roundtrip ' + JSON.stringify(hdrs).slice(0, 60));
}

d = new HPACKDecoder();
throws(function () { d.decode(fromHex('be')); }, /bad table index/, 'indexed ref to empty dynamic table');
throws(function () { d.decode(fromHex('bf')); }, /bad table index/, 'dynamic index 63 with empty table');
throws(function () { d.decode(fromHex('40ff6375')); }, /string underflow/, 'truncated literal string');
throws(function () { d.decode(fromHex('400a6375000a637573746f6d2d6b65790d637573746f6d2d76616c7565')); },
  /string underflow/, 'truncated name string');
throws(function () { d.decode(fromHex('1081 00'.replace(' ', ''))); }, /bad Huffman padding/,
  'huffman error propagates through decodeStr');

console.log(pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
