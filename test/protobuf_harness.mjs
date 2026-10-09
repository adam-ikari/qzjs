/**
 * protobuf.js unit harness (verification only — not part of the runtime bundle).
 *
 * Bundles polyfill/src/protobuf.js to ESM and exercises the .proto parser and
 * the proto3 wire codec: exact known-vector bytes, roundtrips, varint/zigzag
 * boundaries, nested, repeated (packed + unpacked), map, oneof, optional
 * presence, enum, bytes/UTF-8, and 64-bit BigInt/string modes.
 *
 * Usage: node test/protobuf_harness.mjs
 * Exits 0 on all-pass, 1 on any failure.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { buildSync } = require(path.resolve(__dirname, '..', 'src', 'polyfill', 'node_modules', 'esbuild'));
const SRC = path.resolve(__dirname, '..', 'src', 'polyfill', 'src');

const bundlePath = '/tmp/protobuf.bundle.mjs';
buildSync({
  entryPoints: [path.join(SRC, 'protobuf.js')],
  bundle: true, format: 'esm', outfile: bundlePath, write: true, logLevel: 'silent',
});
const { parseProto } = await import(bundlePath);

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}
function hex(u8) { return Buffer.from(u8).toString('hex'); }
function fromHex(h) { return new Uint8Array(Buffer.from(h, 'hex')); }
function eqBytes(u8, h, msg) { ok(hex(u8) === h, msg + ' [' + hex(u8) + ' vs ' + h + ']'); }

// ── 1. parser basics ──
const HW = `
syntax = "proto3";
package helloworld;

// a comment
message HelloRequest {
  string name = 1;
  repeated int32 ids = 2;
}
message HelloReply { string message = 1; }

enum Kind { UNKNOWN = 0; A = 1; B = 7; }

message Outer {
  message Inner { int32 v = 1; }
  Inner inner = 1;
  repeated Inner inners = 2;
  Kind kind = 3;
  map<string, int32> counts = 4;
  optional string nick = 5;
  oneof payload {
    int32 a = 6;
    string b = 7;
  }
  bytes blob = 8;
}

service Greeter {
  rpc SayHello(HelloRequest) returns (HelloReply);
  rpc StreamHello(HelloRequest) returns (stream HelloReply);
}
`;
let reg;
try { reg = parseProto(HW); ok(true, 'parseProto succeeds on mixed schema'); }
catch (e) { ok(false, 'parseProto throws: ' + e.message); }

ok(!!reg && !!reg.messages['helloworld.HelloRequest'], 'message registered under package-qualified name');
ok(reg && reg.HelloRequest === reg.messages['helloworld.HelloRequest'], 'unique short name exposed as direct key');
ok(reg && !!reg.services['helloworld.Greeter'], 'service registered');
ok(reg && reg.services['helloworld.Greeter'].methods.SayHello.path === '/helloworld.Greeter/SayHello', 'rpc path derived');
ok(reg && reg.services['helloworld.Greeter'].methods.SayHello.requestType === reg.messages['helloworld.HelloRequest'], 'rpc request type resolved');
ok(reg && reg.services['helloworld.Greeter'].methods.StreamHello.serverStreaming === true, 'server streaming flag parsed');
ok(reg && reg.messages['helloworld.Outer.Inner'] !== undefined, 'nested message registered');

// ── 2. exact wire vectors (from the protobuf encoding spec) ──
const Req = reg.messages['helloworld.HelloRequest'];
eqBytes(Req.encode({ name: 'test' }), '0a0474657374', 'string field 1 encodes to 0a 04 test');
eqBytes(Req.encode({ name: 'test', ids: [150] }), '0a047465737412029601', 'repeated int32 packed by default');
eqBytes(Req.encode({}), '', 'proto3 omits default-valued fields');
eqBytes(Req.encode({ name: '' }), '', 'empty string is default → omitted');
eqBytes(Req.encode({ ids: [1, 300, 5] }), '120401ac0205', 'packed repeated int32 [1,300,5]');

// int32 negative → 10-byte sign-extended varint
const Neg = parseProto('syntax="proto3"; message M { int32 n = 1; }').messages.M;
eqBytes(Neg.encode({ n: -1 }), '08ffffffffffffffffff01', 'negative int32 sign-extends to 64-bit varint');
const N64 = parseProto('syntax="proto3"; message M { int64 n = 1; }').messages.M;
eqBytes(N64.encode({ n: -1n }), '08ffffffffffffffffff01', 'int64 -1n encodes as 10-byte varint');
eqBytes(N64.encode({ n: 9223372036854775807n }), '08ffffffffffffffff7f', 'int64 max = 9-byte varint');
ok(N64.decode(fromHex('08ffffffffffffffff7f')).n === 9223372036854775807n, 'int64 max roundtrips as BigInt');
ok(N64.decode(fromHex('08ffffffffffffffffff01')).n === -1n, 'int64 -1 roundtrips as BigInt');

// uint32 boundary
const U32 = parseProto('syntax="proto3"; message M { uint32 n = 1; }').messages.M;
eqBytes(U32.encode({ n: 4294967295 }), '08ffffffff0f', 'uint32 max = 5-byte varint');
ok(U32.decode(fromHex('08ffffffff0f')).n === 4294967295, 'uint32 max roundtrip');

// zigzag
const SZ = parseProto('syntax="proto3"; message M { sint32 a = 1; sint64 b = 2; }').messages.M;
eqBytes(SZ.encode({ a: -1 }), '0801', 'sint32 -1 zigzags to 1');
eqBytes(SZ.encode({ a: 1 }), '0802', 'sint32 1 zigzags to 2');
eqBytes(SZ.encode({ b: -1n }), '1001', 'sint64 -1n zigzags to 1');
ok(SZ.decode(fromHex('08011001')).a === -1, 'sint32 -1 roundtrip');
ok(SZ.decode(fromHex('08011001')).b === -1n, 'sint64 -1n roundtrip');
eqBytes(SZ.encode({ b: -9223372036854775808n }), '10ffffffffffffffffff01', 'sint64 min zigzag');
ok(SZ.decode(fromHex('10ffffffffffffffffff01')).b === -9223372036854775808n, 'sint64 min roundtrip');

// fixed / float
const FX = parseProto('syntax="proto3"; message M { fixed32 f32 = 1; sfixed32 s32 = 2; fixed64 f64 = 3; double d = 4; float fl = 5; }').messages.M;
eqBytes(FX.encode({ f32: 1 }), '0d01000000', 'fixed32 little-endian');
eqBytes(FX.encode({ s32: -1 }), '15ffffffff', 'sfixed32 -1');
eqBytes(FX.encode({ f64: 1n }), '190100000000000000', 'fixed64 little-endian');
eqBytes(FX.encode({ d: 1.5 }), '21000000000000f83f', 'double 1.5');
eqBytes(FX.encode({ fl: 1.5 }), '2d0000c03f', 'float 1.5');
var fxd = FX.decode(FX.encode({ f32: 4294967295, s32: -2, f64: 18446744073709551615n, d: -3.25, fl: 2.5 }));
ok(fxd.f32 === 4294967295 && fxd.s32 === -2 && fxd.f64 === 18446744073709551615n && fxd.d === -3.25 && Math.abs(fxd.fl - 2.5) < 1e-9, 'fixed/float roundtrip');

// ── 3. nested / enum / bytes / UTF-8 ──
const Outer = reg.messages['helloworld.Outer'];
var enc = Outer.encode({ inner: { v: 7 } });
eqBytes(enc, '0a020807', 'nested message length-delimited');
ok(Outer.decode(enc).inner.v === 7, 'nested message roundtrip');
ok(Outer.decode(enc).inner !== undefined, 'nested present');
ok(Outer.decode(new Uint8Array(0)).inner === undefined, 'absent message field → undefined');
ok(Outer.decode(enc).kind === 0, 'absent enum → default 0');

eqBytes(Outer.encode({ kind: 'B' }), '1807', 'enum accepts name, encodes number');
eqBytes(Outer.encode({ kind: 7 }), '1807', 'enum accepts number');
ok(Outer.decode(fromHex('1807')).kind === 7, 'enum decodes to number');

eqBytes(Outer.encode({ blob: new Uint8Array([0, 1, 2, 255]) }), '4204000102ff', 'bytes field');
ok(hex(Outer.decode(fromHex('4204000102ff')).blob) === '000102ff', 'bytes roundtrip');

const Uni = parseProto('syntax="proto3"; message M { string s = 1; }').messages.M;
eqBytes(Uni.encode({ s: 'héllo✓😀' }), '0a0d68c3a96c6c6fe29c93f09f9880', 'UTF-8 multibyte + astral');
ok(Uni.decode(Uni.encode({ s: 'héllo✓😀' })).s === 'héllo✓😀', 'UTF-8 string roundtrip');

// ── 4. map ──
var m = Outer.encode({ counts: { a: 1, bb: 22 } });
var md = Outer.decode(m);
ok(md.counts.a === 1 && md.counts.bb === 22, 'map<string,int32> roundtrip');
var mInt = parseProto('syntax="proto3"; message M { map<int32, string> m = 1; }').messages.M;
ok(JSON.stringify(mInt.decode(mInt.encode({ m: { 7: 'x', 9: 'y' } })).m) === '{"7":"x","9":"y"}', 'map<int32,string> roundtrip');
var mMsg = parseProto('syntax="proto3"; message V { int32 v = 1; } message M { map<string, V> m = 1; }').messages.M;
var mmd = mMsg.decode(mMsg.encode({ m: { k: { v: 5 } } }));
ok(mmd.m.k && mmd.m.k.v === 5, 'map<string,message> roundtrip');

// ── 5. oneof + optional presence ──
var o1 = Outer.decode(Outer.encode({ a: 3 }));
ok(o1.a === 3 && o1.b === undefined, 'oneof: only set member present');
ok(o1.payload === 'a', 'oneof case name exposed');
var o2 = Outer.decode(Outer.encode({ b: 'z' }));
ok(o2.b === 'z' && o2.a === undefined && o2.payload === 'b', 'oneof string member');
var o3 = Outer.decode(Outer.encode({ nick: '' }));
ok(o3.nick === '', 'explicit optional: empty string is preserved (presence)');
ok(Outer.decode(Outer.encode({})).nick === undefined, 'explicit optional absent → undefined');
eqBytes(Outer.encode({ nick: '' }), '2a00', 'explicit optional default value IS encoded');

// ── 6. unpacked repeated accepted on decode ──
const Unp = parseProto('syntax="proto3"; message M { repeated int32 v = 1 [packed=false]; }').messages.M;
eqBytes(Unp.encode({ v: [1, 2, 3] }), '080108020803', 'packed=false emits unpacked');
ok(JSON.stringify(Unp.decode(fromHex('080108020803')).v) === '[1,2,3]', 'unpacked decodes');
ok(JSON.stringify(Unp.decode(fromHex('0a03010203')).v) === '[1,2,3]', 'packed bytes still decode into unpacked field');
ok(JSON.stringify(Req.decode(fromHex('120401ac0205')).ids) === '[1,300,5]', 'packed decodes into default field');

// ── 7. unknown fields skipped ──
const Small = parseProto('syntax="proto3"; message M { int32 known = 1; }').messages.M;
var sk = Small.decode(fromHex('082a' + '15' + '00000000' + '1a03aabbcc' + '21' + '00'.repeat(8)));
ok(sk.known === 42 && sk.unknown === undefined, 'unknown fields of every wire type skipped');

// ── 8. int64AsString ──
const regS = parseProto('syntax="proto3"; message M { int64 a = 1; uint64 b = 2; }', { int64AsString: true });
var sd = regS.messages.M.decode(fromHex('08ffffffffffffffffff01'));
ok(sd.a === '-1', 'int64AsString returns decimal string');
ok(regS.messages.M.encode({ a: '9223372036854775807' }) && hex(regS.messages.M.encode({ a: '12' })) === '080c', 'encode accepts integer string');

// ── 9. well-known types ──
const WKT = parseProto(`
syntax = "proto3";
import "google/protobuf/empty.proto";
import "google/protobuf/timestamp.proto";
message Ping { google.protobuf.Empty e = 1; google.protobuf.Timestamp t = 2; }
`);
ok(!!WKT.messages.Ping, 'import of well-known types resolves');
var wd = WKT.messages.Ping.decode(WKT.messages.Ping.encode({ t: { seconds: 123n, nanos: 4 } }));
ok(wd.t.seconds === 123n && wd.t.nanos === 4, 'Timestamp encodes/decodes');
eqBytes(WKT.messages.Ping.encode({ e: {} }), '0a00', 'Empty encodes as zero-length');

// ── 10. error cases ──
function throws(text, msg) {
  try { parseProto(text); ok(false, msg + ' (no throw)'); }
  catch (e) { ok(true, msg + ' → ' + e.message); }
}
throws('syntax="proto3"; message M { UnknownType x = 1; }', 'unknown type rejected');
throws('syntax="proto3"; message M { int32 a = 1; int32 b = 1; }', 'duplicate field number rejected');
throws('syntax="proto3"; message M { int32 a; }', 'missing field number rejected');
throws('syntax="proto3"; message M { int32 a = 0; }', 'field number 0 rejected');
throws('syntax="proto3"; message M {', 'unterminated message rejected');
throws('syntax="proto3"; message M { map<bytes, int32> m = 1; }', 'illegal map key rejected');

// ── 11. big roundtrip stress ──
const Big = parseProto(`
syntax="proto3";
message B {
  repeated string s = 1;
  repeated int64 n = 2;
  repeated fixed32 f = 3;
  repeated bytes blob = 4;
  map<string, int64> m = 5;
}
`).messages.B;
var big = {
  s: Array.from({ length: 500 }, (_, i) => 'str-' + i + '-✓'),
  n: Array.from({ length: 500 }, (_, i) => BigInt(i) * 1000000007n - 5n),
  f: Array.from({ length: 500 }, (_, i) => (i * 2654435761) >>> 0),
  blob: Array.from({ length: 50 }, (_, i) => new Uint8Array(64).fill(i & 0xff)),
  m: Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['k' + i, BigInt(i) - 50n])),
};
var bd = Big.decode(Big.encode(big));
ok(bd.s.length === 500 && bd.s[499] === 'str-499-✓', 'large repeated string roundtrip');
ok(bd.n.length === 500 && bd.n[0] === -5n && bd.n[499] === 499n * 1000000007n - 5n, 'large repeated int64 roundtrip');
ok(bd.f.length === 500 && bd.f[1] === 2654435761, 'large repeated fixed32 roundtrip');
ok(bd.blob.length === 50 && bd.blob[7].length === 64 && bd.blob[7][0] === 7, 'large repeated bytes roundtrip');
ok(Object.keys(bd.m).length === 100 && bd.m.k0 === -50n, 'large map roundtrip');

console.log('\nprotobuf: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
