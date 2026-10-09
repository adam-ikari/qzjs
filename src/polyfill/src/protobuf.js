/**
 * qzjs polyfill: dynamic proto3 subset — .proto text parser + wire codec.
 *
 * Scope (gRPC/HTTP2 Phase 2, design §3): parse `.proto` source at runtime into
 * a message/enum/service registry, and encode/decode the proto3 wire format.
 * No protoc, no external library, no `pal` — pure JS, QuickJS-safe ES2020.
 *
 * Covered: message (incl. nested), enum, scalar types (double/float/int32/
 * int64/uint32/uint64/sint32/sint64/fixed32/fixed64/sfixed32/sfixed64/bool/
 * string/bytes), repeated (packed + unpacked), map, oneof, explicit `optional`,
 * package, import (recorded, resolved against builtins), comments, service/rpc
 * declarations (for the gRPC layer's method signatures).
 *
 * 64-bit integers are BigInt by default; `{int64AsString: true}` returns
 * decimal strings instead (protobuf JSON mapping). Encoding accepts
 * number | BigInt | string for every integer kind.
 *
 * Well-known types built in: google.protobuf.Empty, Timestamp, Duration and
 * the scalar wrapper types, so `import "google/protobuf/*.proto"` resolves.
 *
 * API:
 *   parseProto(text, opts?) -> Registry
 *     Registry.messages  {fullName: MessageType}   (also short names if unique)
 *     Registry.enums     {fullName: EnumType}
 *     Registry.services  {fullName: ServiceType}
 *     Registry.lookup(name) -> MessageType|EnumType|undefined
 *     (message names are also direct keys on the Registry object)
 *   MessageType.encode(obj) -> Uint8Array
 *   MessageType.decode(bytes) -> obj
 */

// ── UTF-8 (hand-rolled; module runs before setupTextEncoding in the bundle) ──

function utf8Encode(s) {
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      var c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i++;
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else out.push(0xef, 0xbf, 0xbd);
    } else if (c >= 0xd800 && c <= 0xdfff) out.push(0xef, 0xbf, 0xbd);
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

function utf8Decode(b) {
  var s = '';
  for (var i = 0; i < b.length;) {
    var c = b[i++];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c >= 0xc0 && c < 0xe0 && i < b.length) {
      s += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f));
    } else if (c >= 0xe0 && c < 0xf0 && i + 1 < b.length) {
      s += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f));
    } else if (c >= 0xf0 && i + 2 < b.length) {
      var cp = ((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
      cp -= 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else s += '\ufffd';
  }
  return s;
}

function toBytes(d) {
  if (d == null) return new Uint8Array(0);
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return utf8Encode(String(d));
}

// ── scalar type table: wire type + kind ──

var WIRE_VARINT = 0, WIRE_FIXED64 = 1, WIRE_LEN = 2, WIRE_FIXED32 = 5;

var SCALARS = {
  double: { wire: WIRE_FIXED64, kind: 'double', pack: true },
  float: { wire: WIRE_FIXED32, kind: 'float', pack: true },
  int64: { wire: WIRE_VARINT, kind: 'int64', pack: true },
  uint64: { wire: WIRE_VARINT, kind: 'uint64', pack: true },
  int32: { wire: WIRE_VARINT, kind: 'int32', pack: true },
  fixed64: { wire: WIRE_FIXED64, kind: 'fixed64', pack: true },
  fixed32: { wire: WIRE_FIXED32, kind: 'fixed32', pack: true },
  bool: { wire: WIRE_VARINT, kind: 'bool', pack: true },
  string: { wire: WIRE_LEN, kind: 'string', pack: false },
  bytes: { wire: WIRE_LEN, kind: 'bytes', pack: false },
  uint32: { wire: WIRE_VARINT, kind: 'uint32', pack: true },
  sfixed32: { wire: WIRE_FIXED32, kind: 'sfixed32', pack: true },
  sfixed64: { wire: WIRE_FIXED64, kind: 'sfixed64', pack: true },
  sint32: { wire: WIRE_VARINT, kind: 'sint32', pack: true },
  sint64: { wire: WIRE_VARINT, kind: 'sint64', pack: true },
};

var INT64_KINDS = { int64: 1, uint64: 1, sint64: 1, fixed64: 1, sfixed64: 1 };

// ── writer ──

function Writer() {
  this.buf = new Uint8Array(256);
  this.len = 0;
  this._dv = null;
}
Writer.prototype._need = function (n) {
  if (this.len + n <= this.buf.length) return;
  var cap = this.buf.length;
  while (cap < this.len + n) cap *= 2;
  var b = new Uint8Array(cap);
  b.set(this.buf.subarray(0, this.len));
  this.buf = b;
  this._dv = null;
};
Writer.prototype._view = function () {
  this._need(8);
  if (!this._dv) this._dv = new DataView(this.buf.buffer);
  return this._dv;
};
Writer.prototype.bytes = function () { return this.buf.slice(0, this.len); };
Writer.prototype.u8 = function (v) { this._need(1); this.buf[this.len++] = v & 0xff; };
Writer.prototype.raw = function (u8) {
  this._need(u8.length);
  this.buf.set(u8, this.len);
  this.len += u8.length;
};
Writer.prototype.varintNum = function (v) {
  // unsigned 32-bit fast path
  v = v >>> 0;
  while (v > 0x7f) { this.u8((v & 0x7f) | 0x80); v = v >>> 7; }
  this.u8(v);
};
Writer.prototype.varintBig = function (v) {
  v = BigInt.asUintN(64, v);
  while (v > 0x7fn) { this.u8(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  this.u8(Number(v));
};
Writer.prototype.tag = function (num, wire) { this.varintNum(((num << 3) | wire) >>> 0); };
Writer.prototype.fixed32 = function (v) {
  var dv = this._view(); dv.setUint32(this.len, v >>> 0, true); this.len += 4;
};
Writer.prototype.sfixed32 = function (v) {
  var dv = this._view(); dv.setInt32(this.len, v | 0, true); this.len += 4;
};
Writer.prototype.float = function (v) {
  var dv = this._view(); dv.setFloat32(this.len, v, true); this.len += 4;
};
Writer.prototype.fixed64 = function (v) {
  var dv = this._view(); dv.setBigUint64(this.len, BigInt.asUintN(64, v), true); this.len += 8;
};
Writer.prototype.sfixed64 = function (v) {
  var dv = this._view(); dv.setBigInt64(this.len, BigInt.asIntN(64, v), true); this.len += 8;
};
Writer.prototype.double = function (v) {
  var dv = this._view(); dv.setFloat64(this.len, v, true); this.len += 8;
};
Writer.prototype.lenBytes = function (u8) {
  this.varintNum(u8.length);
  this.raw(u8);
};

// ── reader ──

function Reader(buf) {
  this.buf = buf instanceof Uint8Array ? buf : toBytes(buf);
  this.pos = 0;
  this.len = this.buf.length;
  this._dv = null;
}
Reader.prototype.view = function (n) {
  if (!this._dv || this._dv.buffer !== this.buf.buffer) this._dv = new DataView(this.buf.buffer);
  if (this.pos + n > this.len) throw new Error('protobuf: truncated');
  return this._dv;
};
Reader.prototype.varintNum = function () {
  var r = 0, shift = 0, b;
  do {
    if (this.pos >= this.len) throw new Error('protobuf: varint underflow');
    b = this.buf[this.pos++];
    r += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (b & 0x80);
  return r >>> 0;
};
Reader.prototype.varintBig = function () {
  var r = 0n, shift = 0n, b;
  do {
    if (this.pos >= this.len) throw new Error('protobuf: varint underflow');
    b = this.buf[this.pos++];
    r |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while (b & 0x80);
  return r;
};
Reader.prototype.u32 = function () { var dv = this.view(4), v = dv.getUint32(this.pos, true); this.pos += 4; return v; };
Reader.prototype.i32 = function () { var dv = this.view(4), v = dv.getInt32(this.pos, true); this.pos += 4; return v; };
Reader.prototype.f32 = function () { var dv = this.view(4), v = dv.getFloat32(this.pos, true); this.pos += 4; return v; };
Reader.prototype.u64 = function () { var dv = this.view(8), v = dv.getBigUint64(this.pos, true); this.pos += 8; return v; };
Reader.prototype.i64 = function () { var dv = this.view(8), v = dv.getBigInt64(this.pos, true); this.pos += 8; return v; };
Reader.prototype.f64 = function () { var dv = this.view(8), v = dv.getFloat64(this.pos, true); this.pos += 8; return v; };
Reader.prototype.bytes = function () {
  var n = this.varintNum();
  if (this.pos + n > this.len) throw new Error('protobuf: length underflow');
  var out = this.buf.slice(this.pos, this.pos + n);
  this.pos += n;
  return out;
};
Reader.prototype.skip = function (wire) {
  switch (wire) {
    case WIRE_VARINT: this.varintBig(); return;
    case WIRE_FIXED64: this.pos += 8; return;
    case WIRE_FIXED32: this.pos += 4; return;
    case WIRE_LEN: this.bytes(); return;
    default: throw new Error('protobuf: bad wire type ' + wire);
  }
};

// ── value coercion ──

function asBigInt(v, what) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('protobuf: non-finite ' + what);
    return BigInt(Math.trunc(v));
  }
  if (typeof v === 'string') {
    if (!/^[+-]?\d+$/.test(v)) throw new Error('protobuf: bad integer string for ' + what);
    return BigInt(v);
  }
  throw new Error('protobuf: expected integer for ' + what + ', got ' + typeof v);
}

function int64Out(bi, opts) {
  return opts && opts.int64AsString ? bi.toString() : bi;
}

// ── EnumType ──

function EnumType(name, values) {
  this.name = name;
  this.kind = 'enum';
  this.values = values;            // {NAME: number}
  this.byNumber = {};
  for (var k in values) this.byNumber[values[k]] = k;
}
EnumType.prototype.number = function (v) {
  if (typeof v === 'number') return v | 0;
  if (typeof v === 'string') {
    if (!(v in this.values)) throw new Error('protobuf: unknown enum value ' + v + ' for ' + this.name);
    return this.values[v];
  }
  throw new Error('protobuf: bad enum value for ' + this.name);
};

// ── MessageType ──

function MessageType(name, fields, opts) {
  this.name = name;
  this.kind = 'message';
  this.fields = fields;            // resolved field descriptors
  this.byNumber = {};
  this.byName = {};
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (this.byNumber[f.number]) throw new Error('protobuf: duplicate field number ' + f.number + ' in ' + name);
    this.byNumber[f.number] = f;
    this.byName[f.name] = f;
  }
  this._opts = opts || {};
}

MessageType.prototype._default = function (f) {
  if (f.rule === 'repeated') return [];
  if (f.rule === 'map') return {};
  if (f.type === 'message') return undefined;
  if (f.type === 'enum') return 0;
  var k = f.scalar;
  if (k === 'string') return '';
  if (k === 'bytes') return new Uint8Array(0);
  if (k === 'bool') return false;
  if (INT64_KINDS[k]) return this._opts.int64AsString ? '0' : 0n;
  return 0;
};

function isDefaultScalar(kind, v) {
  if (kind === 'string') return v === '';
  if (kind === 'bytes') return !v || v.length === 0;
  if (kind === 'bool') return !v;
  if (INT64_KINDS[kind]) {
    if (typeof v === 'bigint') return v === 0n;
    if (typeof v === 'string') return v === '0' || v === '';
    return Number(v) === 0;
  }
  return v === 0;
}

/* Encode one scalar/enum/message value (no tag) into w. */
MessageType.prototype._writeValue = function (w, f, v) {
  if (f.type === 'message') {
    var sub = f.messageType.encode(v);
    w.lenBytes(sub);
    return;
  }
  if (f.type === 'enum') { w.varintBig(BigInt.asUintN(64, BigInt(f.enumType.number(v)))); return; }
  switch (f.scalar) {
    case 'int32': case 'int64': case 'uint32': case 'uint64':
      w.varintBig(BigInt.asUintN(64, asBigInt(v, f.name))); break;

    case 'sint32': {
      var n = Number(asBigInt(v, f.name)) | 0;
      w.varintNum(((n << 1) ^ (n >> 31)) >>> 0);
      break;
    }
    case 'sint64': {
      var b = BigInt.asIntN(64, asBigInt(v, f.name));
      w.varintBig(BigInt.asUintN(64, (b << 1n) ^ (b >> 63n)));
      break;
    }
    case 'fixed32': w.fixed32(Number(asBigInt(v, f.name))); break;
    case 'sfixed32': w.sfixed32(Number(asBigInt(v, f.name))); break;
    case 'fixed64': w.fixed64(asBigInt(v, f.name)); break;
    case 'sfixed64': w.sfixed64(asBigInt(v, f.name)); break;
    case 'bool': w.u8(v ? 1 : 0); break;
    case 'string': w.lenBytes(utf8Encode(typeof v === 'string' ? v : String(v))); break;
    case 'bytes': w.lenBytes(toBytes(v)); break;
    case 'float': w.float(Number(v)); break;
    case 'double': w.double(Number(v)); break;
    default: throw new Error('protobuf: unhandled scalar ' + f.scalar);
  }
};

MessageType.prototype._wireOf = function (f) {
  if (f.type === 'message' || f.type === 'map') return WIRE_LEN;
  if (f.type === 'enum') return WIRE_VARINT;
  return SCALARS[f.scalar].wire;
};

MessageType.prototype._packable = function (f) {
  if (f.type === 'enum') return true;
  return f.type === 'scalar' && SCALARS[f.scalar].pack;
};

/* Element wire type inside a packed repeated field. */
MessageType.prototype._elemWire = function (f) {
  return f.type === 'enum' ? WIRE_VARINT : SCALARS[f.scalar].wire;
};

/* Encode a plain object → Uint8Array (proto3: default-valued singular
 * non-optional fields are omitted). */
MessageType.prototype.encode = function (obj) {
  var w = new Writer();
  if (obj == null) obj = {};
  if (typeof obj !== 'object') throw new Error('protobuf: encode expects object for ' + this.name);
  for (var i = 0; i < this.fields.length; i++) {
    var f = this.fields[i];
    var v = obj[f.name];
    if (v === undefined || v === null) continue;

    if (f.rule === 'map') {
      var keys = Object.keys(v);
      for (var m = 0; m < keys.length; m++) {
        if (v[keys[m]] === undefined) continue;
        w.tag(f.number, WIRE_LEN);
        w.lenBytes(this._encodeMapEntry(f, keys[m], v[keys[m]]));
      }
      continue;
    }

    if (f.rule === 'repeated') {
      if (!Array.isArray(v)) throw new Error('protobuf: repeated field ' + f.name + ' expects array');
      if (!v.length) continue;
      if (f.packed && this._packable(f)) {
        var pw = new Writer();
        for (var p = 0; p < v.length; p++) this._writeValue(pw, f, v[p]);
        w.tag(f.number, WIRE_LEN);
        w.lenBytes(pw.bytes());
      } else {
        for (var q = 0; q < v.length; q++) { w.tag(f.number, this._wireOf(f)); this._writeValue(w, f, v[q]); }
      }
      continue;
    }

    // singular
    if (!f.presence) {
      if (f.type === 'scalar' && isDefaultScalar(f.scalar, v)) continue;
      if (f.type === 'enum' && (typeof v === 'number' ? v === 0 : this._enumNum(f, v) === 0)) continue;
    }
    w.tag(f.number, this._wireOf(f));
    this._writeValue(w, f, v);
  }
  return w.bytes();
};

MessageType.prototype._enumNum = function (f, v) { return f.enumType.number(v); };

MessageType.prototype._encodeMapEntry = function (f, k, v) {
  var w = new Writer();
  w.tag(1, f.keyWire);
  this._writeScalarLike(w, f.keyField, k);
  if (v !== undefined && v !== null) {
    w.tag(2, f.valWire);
    if (f.valueType === 'message') w.lenBytes(f.messageType.encode(v));
    else if (f.valueType === 'enum') w.varintBig(BigInt.asUintN(64, BigInt(f.enumType.number(v))));
    else this._writeScalarLike(w, f.valField, v);
  }
  return w.bytes();
};

/* Write a scalar value with no tag, reusing the message writer path. */
MessageType.prototype._writeScalarLike = function (w, pseudo, v) {
  this._writeValue(w, pseudo, v);
};

/* Decode Uint8Array|ArrayBuffer → plain object. */
MessageType.prototype.decode = function (bytes) {
  var r = new Reader(bytes);
  var obj = {};
  var i;
  for (i = 0; i < this.fields.length; i++) {
    var f = this.fields[i];
    if (f.rule === 'repeated') obj[f.name] = [];
    else if (f.rule === 'map') obj[f.name] = {};
    else if (!f.presence) obj[f.name] = this._default(f);
  }
  while (r.pos < r.len) {
    var tag = r.varintNum();
    var num = tag >>> 3, wire = tag & 7;
    var fld = this.byNumber[num];
    if (!fld) { r.skip(wire); continue; }

    if (fld.rule === 'map') {
      if (wire !== WIRE_LEN) { r.skip(wire); continue; }
      var eb = r.bytes();
      var e = new Reader(eb), mk = undefined, mv = undefined;
      while (e.pos < e.len) {
        var et = e.varintNum(), en = et >>> 3, ew = et & 7;
        if (en === 1) mk = this._readScalar(e, fld.keyField, ew);
        else if (en === 2) mv = this._readValue(e, fld.valField, ew);
        else e.skip(ew);
      }
      if (mk !== undefined) obj[fld.name][mk === undefined ? '' : mk] = mv === undefined ? this._mapValDefault(fld) : mv;
      continue;
    }

    if (fld.rule === 'repeated' && wire === WIRE_LEN && this._packable(fld)) {
      var pb = r.bytes(), pr = new Reader(pb), ew2 = this._elemWire(fld);
      while (pr.pos < pr.len) obj[fld.name].push(this._readValue(pr, fld, ew2));
      continue;
    }

    var val = this._readValue(r, fld, wire);
    if (fld.rule === 'repeated') obj[fld.name].push(val);
    else {
      obj[fld.name] = val;
      if (fld.oneof) obj[fld.oneof] = fld.name;   // track active oneof member
    }
  }
  return obj;
};

MessageType.prototype._mapValDefault = function (f) {
  if (f.valueType === 'message') return undefined;
  if (f.valueType === 'enum') return 0;
  return this._default(f.valField);
};

MessageType.prototype._readValue = function (r, f, wire) {
  if (f.type === 'message') {
    if (wire !== WIRE_LEN) { r.skip(wire); return undefined; }
    return f.messageType.decode(r.bytes());
  }
  if (f.type === 'enum') {
    if (wire !== WIRE_VARINT) { r.skip(wire); return 0; }
    return Number(BigInt.asIntN(32, r.varintBig()));
  }
  return this._readScalar(r, f, wire);
};

MessageType.prototype._readScalar = function (r, f, wire) {
  var k = f.scalar;
  if (SCALARS[k].wire !== wire) { r.skip(wire); return this._default(f); }
  switch (k) {
    case 'int32': return Number(BigInt.asIntN(32, r.varintBig()));
    case 'int64': return int64Out(BigInt.asIntN(64, r.varintBig()), this._opts);
    case 'uint32': return Number(BigInt.asUintN(32, r.varintBig()));
    case 'uint64': return int64Out(BigInt.asUintN(64, r.varintBig()), this._opts);
    case 'sint32': { var n = r.varintNum(); return (n >>> 1) ^ -(n & 1); }
    case 'sint64': { var b = r.varintBig(); return int64Out(BigInt.asIntN(64, (b >> 1n) ^ -(b & 1n)), this._opts); }
    case 'fixed32': return r.u32();
    case 'sfixed32': return r.i32();
    case 'fixed64': return int64Out(BigInt.asUintN(64, r.u64()), this._opts);
    case 'sfixed64': return int64Out(BigInt.asIntN(64, r.i64()), this._opts);
    case 'bool': return r.varintBig() !== 0n;
    case 'string': return utf8Decode(r.bytes());
    case 'bytes': return r.bytes();
    case 'float': return r.f32();
    case 'double': return r.f64();
    default: throw new Error('protobuf: unhandled scalar ' + k);
  }
};

/* ── .proto tokenizer ── */

function tokenize(src) {
  var toks = [], i = 0, n = src.length;
  while (i < n) {
    var c = src.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) { i++; continue; }
    // line comment
    if (c === 0x2f && i + 1 < n && src.charCodeAt(i + 1) === 0x2f) {
      while (i < n && src.charCodeAt(i) !== 0x0a) i++;
      continue;
    }
    // block comment
    if (c === 0x2f && i + 1 < n && src.charCodeAt(i + 1) === 0x2a) {
      i += 2;
      while (i + 1 < n && !(src.charCodeAt(i) === 0x2a && src.charCodeAt(i + 1) === 0x2f)) i++;
      i += 2;
      continue;
    }
    // string literal
    if (c === 0x22 || c === 0x27) {
      var q = c, s = '';
      i++;
      while (i < n && src.charCodeAt(i) !== q) {
        if (src.charCodeAt(i) === 0x5c && i + 1 < n) {
          var e = src[i + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          i += 2;
        } else s += src[i++];
      }
      i++;
      toks.push({ t: 'str', v: s });
      continue;
    }
    // number
    if ((c >= 0x30 && c <= 0x39) || (c === 0x2d && i + 1 < n && src.charCodeAt(i + 1) >= 0x30 && src.charCodeAt(i + 1) <= 0x39)) {
      var st = i;
      if (src.charCodeAt(i) === 0x2d) i++;
      if (src.charCodeAt(i) === 0x30 && (src.charCodeAt(i + 1) === 0x78 || src.charCodeAt(i + 1) === 0x58)) {
        i += 2; while (i < n && /[0-9a-fA-F]/.test(src[i])) i++;
      } else {
        while (i < n && src.charCodeAt(i) >= 0x30 && src.charCodeAt(i) <= 0x39) i++;
        if (i < n && src.charCodeAt(i) === 0x2e) { i++; while (i < n && src.charCodeAt(i) >= 0x30 && src.charCodeAt(i) <= 0x39) i++; }
        if (i < n && (src.charCodeAt(i) === 0x65 || src.charCodeAt(i) === 0x45)) {
          i++;
          if (i < n && (src.charCodeAt(i) === 0x2b || src.charCodeAt(i) === 0x2d)) i++;
          while (i < n && src.charCodeAt(i) >= 0x30 && src.charCodeAt(i) <= 0x39) i++;
        }
      }
      var txt = src.slice(st, i);
      toks.push({ t: 'num', v: txt.indexOf('.') >= 0 || txt.indexOf('e') >= 0 || txt.indexOf('E') >= 0 ? parseFloat(txt) : parseInt(txt, 10) });
      continue;
    }
    // identifier
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f) {
      var j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    // punctuation
    toks.push({ t: 'punc', v: src[i] });
    i++;
  }
  return toks;
}

/* ── .proto parser (recursive descent) ── */

function Parser(text) {
  this.toks = tokenize(text);
  this.i = 0;
}
Parser.prototype._peek = function (k) { return this.toks[this.i + (k || 0)]; };
Parser.prototype._isId = function (v) { var t = this._peek(); return t && t.t === 'id' && (v == null || t.v === v); };
Parser.prototype._isPunc = function (v) { var t = this._peek(); return t && t.t === 'punc' && t.v === v; };
Parser.prototype._eatId = function (v) {
  if (!this._isId(v)) throw new Error('protobuf: expected ' + (v || 'identifier') + ' at token ' + this.i +
    ' (got ' + (this._peek() ? JSON.stringify(this._peek().v) : 'EOF') + ')');
  return this.toks[this.i++].v;
};
Parser.prototype._eatPunc = function (v) {
  if (!this._isPunc(v)) throw new Error('protobuf: expected "' + v + '" at token ' + this.i +
    ' (got ' + (this._peek() ? JSON.stringify(this._peek().v) : 'EOF') + ')');
  return this.toks[this.i++].v;
};
Parser.prototype._tryPunc = function (v) { if (this._isPunc(v)) { this.i++; return true; } return false; };
Parser.prototype._tryId = function (v) { if (this._isId(v)) { this.i++; return true; } return false; };
Parser.prototype._eof = function () { return this.i >= this.toks.length; };

/* qualified name: ident ('.' ident)* — returns dotted string */
Parser.prototype._qname = function () {
  var s = this._eatId();
  while (this._isPunc('.')) { this.i++; s += '.' + this._eatId(); }
  return s;
};

/* skip a field/enum-option block: '[' ... ']' (nested brackets counted) */
Parser.prototype._skipOptionList = function () {
  if (!this._tryPunc('[')) return;
  var depth = 1;
  while (depth > 0) {
    if (this._eof()) throw new Error('protobuf: unterminated option list');
    if (this._isPunc('[')) depth++;
    else if (this._isPunc(']')) depth--;
    this.i++;
  }
};

/* skip an `option ...;` statement (already consumed the `option` keyword) */
Parser.prototype._skipOption = function () {
  while (!this._eof() && !this._isPunc(';')) {
    // option blocks may contain braces (e.g. custom options)
    if (this._isPunc('{')) { var d = 1; this.i++; while (d > 0 && !this._eof()) { if (this._isPunc('{')) d++; else if (this._isPunc('}')) d--; this.i++; } continue; }
    this.i++;
  }
  this._eatPunc(';');
};

Parser.prototype.parseFile = function () {
  var file = { package: '', imports: [], messages: [], enums: [], services: [] };
  while (!this._eof()) {
    if (this._isId('syntax')) { this.i++; this._eatPunc('='); this._eatId2('str'); this._eatPunc(';'); continue; }
    if (this._isId('package')) { this.i++; file.package = this._qname(); this._eatPunc(';'); continue; }
    if (this._isId('import')) {
      this.i++;
      if (this._isId('public') || this._isId('weak')) this.i++;
      file.imports.push(this._eatId2('str').v);
      this._eatPunc(';');
      continue;
    }
    if (this._isId('option')) { this.i++; this._skipOption(); continue; }
    if (this._isId('message')) { file.messages.push(this.parseMessage([])); continue; }
    if (this._isId('enum')) { file.enums.push(this.parseEnum([])); continue; }
    if (this._isId('service')) { file.services.push(this.parseService()); continue; }
    throw new Error('protobuf: unexpected token ' + JSON.stringify(this._peek().v) + ' at top level (token ' + this.i + ')');
  }
  return file;
};

Parser.prototype._eatId2 = function (t) {
  var tok = this._peek();
  if (!tok || tok.t !== t) throw new Error('protobuf: expected ' + t + ' at token ' + this.i);
  return this.toks[this.i++];
};

Parser.prototype.parseMessage = function (scope) {
  this._eatId('message');
  var name = this._eatId();
  var full = scope.concat(name);
  this._eatPunc('{');
  var msg = { name: name, full: full, fields: [], nested: [], nestedEnums: [], oneofs: [] };
  while (!this._isPunc('}')) {
    if (this._eof()) throw new Error('protobuf: unterminated message ' + name);
    if (this._isId('message')) { msg.nested.push(this.parseMessage(full)); continue; }
    if (this._isId('enum')) { msg.nestedEnums.push(this.parseEnum(full)); continue; }
    if (this._isId('option')) { this.i++; this._skipOption(); continue; }
    if (this._isId('reserved') || this._isId('extensions')) { this.i++; while (!this._isPunc(';')) this.i++; this._eatPunc(';'); continue; }
    if (this._isId('oneof')) {
      this.i++;
      var oname = this._eatId();
      this._eatPunc('{');
      var ofields = [];
      while (!this._isPunc('}')) ofields.push(this.parseField(full, oname));
      this._eatPunc('}');
      msg.oneofs.push(oname);
      for (var oi = 0; oi < ofields.length; oi++) msg.fields.push(ofields[oi]);
      continue;
    }
    if (this._isId('map')) { msg.fields.push(this.parseMapField(full)); continue; }
    msg.fields.push(this.parseField(full, null));
  }
  this._eatPunc('}');
  return msg;
};

Parser.prototype.parseField = function (scope, oneof) {
  var label = null;
  if (this._isId('repeated') || this._isId('optional') || this._isId('required')) {
    label = this.toks[this.i++].v;
  }
  var type = this._fieldType();
  var name = this._eatId();
  this._eatPunc('=');
  var numTok = this._eatId2('num');
  var number = numTok.v;
  var packed = null;
  if (this._isPunc('[')) {
    // parse [packed=true, ...] minimally
    this.i++;
    while (!this._isPunc(']')) {
      var k = this._eatId();
      this._eatPunc('=');
      var vtok = this._peek();
      this.i++;
      if (k === 'packed') packed = !(vtok.t === 'id' && vtok.v === 'false');
      if (this._tryPunc(',')) continue;
    }
    this._eatPunc(']');
  }
  this._eatPunc(';');
  if (typeof number !== 'number' || number < 1) throw new Error('protobuf: bad field number for ' + name);
  return { label: label, type: type, name: name, number: number, packed: packed, oneof: oneof, scope: scope, isMap: false };
};

Parser.prototype.parseMapField = function (scope) {
  this._eatId('map');
  this._eatPunc('<');
  var kt = this._fieldType();
  this._eatPunc(',');
  var vt = this._fieldType();
  this._eatPunc('>');
  var name = this._eatId();
  this._eatPunc('=');
  var number = this._eatId2('num').v;
  if (this._isPunc('[')) this._skipOptionList();
  this._eatPunc(';');
  return { label: 'repeated', type: kt, name: name, number: number, isMap: true, mapKey: kt, mapValue: vt, scope: scope, packed: null, oneof: null };
};

/* field type token: qualified name, possibly with leading '.' */
Parser.prototype._fieldType = function () {
  var s = '';
  if (this._tryPunc('.')) s = '.';
  s += this._eatId();
  while (this._isPunc('.')) { this.i++; s += '.' + this._eatId(); }
  return s;
};

Parser.prototype.parseEnum = function (scope) {
  this._eatId('enum');
  var name = this._eatId();
  var full = scope.concat(name);
  this._eatPunc('{');
  var values = {};
  while (!this._isPunc('}')) {
    if (this._eof()) throw new Error('protobuf: unterminated enum ' + name);
    if (this._isId('option')) { this.i++; this._skipOption(); continue; }
    if (this._isId('reserved')) { this.i++; while (!this._isPunc(';')) this.i++; this._eatPunc(';'); continue; }
    var vn = this._eatId();
    this._eatPunc('=');
    var neg = this._tryPunc('-');
    var num = this._eatId2('num').v;
    if (typeof num !== 'number') throw new Error('protobuf: bad enum value for ' + vn);
    values[vn] = neg ? -num : num;
    if (this._isPunc('[')) this._skipOptionList();
    this._eatPunc(';');
  }
  this._eatPunc('}');
  return { name: name, full: full, values: values };
};

Parser.prototype.parseService = function () {
  this._eatId('service');
  var name = this._eatId();
  this._eatPunc('{');
  var methods = [];
  while (!this._isPunc('}')) {
    if (this._eof()) throw new Error('protobuf: unterminated service ' + name);
    if (this._isId('option')) { this.i++; this._skipOption(); continue; }
    this._eatId('rpc');
    var mn = this._eatId();
    this._eatPunc('(');
    var cs = this._tryId('stream');
    var inp = this._fieldType();
    this._eatPunc(')');
    this._eatId('returns');
    this._eatPunc('(');
    var ss = this._tryId('stream');
    var out = this._fieldType();
    this._eatPunc(')');
    if (this._isPunc('{')) { while (!this._isPunc('}')) this.i++; this._eatPunc('}'); }
    else this._eatPunc(';');
    methods.push({ name: mn, input: inp, output: out, clientStreaming: cs, serverStreaming: ss });
  }
  this._eatPunc('}');
  return { name: name, methods: methods };
};

/* ── registry + resolution ── */

function Registry(pkg) {
  this.package = pkg || '';
  this.messages = {};
  this.enums = {};
  this.services = {};
  this.imports = [];
}
Registry.prototype.lookup = function (name) {
  return this.messages[name] || this.enums[name];
};
/* Design-doc API: reg.service('pkg.Svc').method('Rpc') -> bound method object. */
Registry.prototype.service = function (name) {
  var svc = this.services[name] || this.services[(this.package ? this.package + '.' : '') + name] || this[name.split('.').pop()];
  if (!svc) return undefined;
  if (!svc.method) {
    svc.method = function (m) {
      var md = svc.methods[m];
      if (!md) throw new Error('protobuf: no method ' + m + ' in service ' + svc.fullName);
      return md;
    };
  }
  return svc;
};

function shortNames(reg) {
  // expose unique short names as direct keys on the registry object
  var counts = {}, all = [];
  var k;
  for (k in reg.messages) { counts[k] = (counts[k] || 0); all.push([k, reg.messages[k]]); }
  var seen = {};
  for (var i = 0; i < all.length; i++) {
    var full = all[i][0], short = full.split('.').pop();
    seen[short] = (seen[short] || 0) + 1;
  }
  for (var j = 0; j < all.length; j++) {
    var fn = all[j][0], sn = fn.split('.').pop();
    if (!Object.prototype.hasOwnProperty.call(reg, fn)) reg[fn] = all[j][1];
    if (seen[sn] === 1 && !Object.prototype.hasOwnProperty.call(reg, sn)) reg[sn] = all[j][1];
  }
}

function resolveName(reg, typeStr, scopeNames) {
  if (typeStr.charAt(0) === '.') {
    var abs = typeStr.slice(1);
    return reg.messages[abs] || reg.enums[abs];
  }
  var chain = (reg.package ? reg.package.split('.') : []).concat(scopeNames);
  var parts = typeStr.split('.');
  for (var k = chain.length; k >= 0; k--) {
    var cand = chain.slice(0, k).concat(parts).join('.');
    var hit = reg.messages[cand] || reg.enums[cand];
    if (hit) return hit;
  }
  return undefined;
}

function buildField(reg, raw) {
  var f = { name: raw.name, number: raw.number, oneof: raw.oneof || null };

  if (raw.isMap) {
    f.rule = 'map';
    f.type = 'map';
    f.presence = false;
    f.packed = false;
    var kres = resolveName(reg, raw.mapKey, []);
    if (!SCALARS[raw.mapKey] || raw.mapKey === 'float' || raw.mapKey === 'double' || raw.mapKey === 'bytes') {
      if (kres) throw new Error('protobuf: illegal map key type ' + raw.mapKey);
      throw new Error('protobuf: unknown map key type ' + raw.mapKey);
    }
    f.keyField = { name: raw.name + '_key', number: 1, type: 'scalar', scalar: raw.mapKey, rule: 'singular', presence: false, packed: false, oneof: null };
    f.keyWire = SCALARS[raw.mapKey].wire;
    var vres = resolveName(reg, raw.mapValue, raw.scope);
    if (!vres) {
      if (!SCALARS[raw.mapValue]) throw new Error('protobuf: unknown map value type ' + raw.mapValue + ' for ' + raw.name);
      f.valueType = 'scalar';
      f.valField = { name: raw.name + '_val', number: 2, type: 'scalar', scalar: raw.mapValue, rule: 'singular', presence: false, packed: false, oneof: null };
      f.valWire = SCALARS[raw.mapValue].wire;
    } else if (vres.kind === 'message') {
      f.valueType = 'message'; f.messageType = vres; f.valWire = WIRE_LEN;
      f.valField = { name: raw.name + '_val', number: 2, type: 'message', messageType: vres };
    } else {
      f.valueType = 'enum'; f.enumType = vres; f.valWire = WIRE_VARINT;
      f.valField = { name: raw.name + '_val', number: 2, type: 'enum', enumType: vres };
    }
    return f;
  }

  var resolved = resolveName(reg, raw.type, raw.scope);
  if (resolved && resolved.kind === 'message') {
    f.type = 'message'; f.messageType = resolved; f.presence = true;
  } else if (resolved && resolved.kind === 'enum') {
    f.type = 'enum'; f.enumType = resolved; f.presence = raw.label === 'optional' || !!raw.oneof;
  } else if (SCALARS[raw.type]) {
    f.type = 'scalar'; f.scalar = raw.type; f.presence = raw.label === 'optional' || !!raw.oneof;
  } else {
    throw new Error('protobuf: unknown type "' + raw.type + '" for field ' + raw.name);
  }

  f.rule = raw.label === 'repeated' ? 'repeated' : 'singular';
  if (f.rule === 'repeated') {
    f.packed = raw.packed == null ? (f.type === 'scalar' ? SCALARS[f.scalar].pack : f.type === 'enum') : !!raw.packed;
    f.presence = false;
  } else {
    f.packed = false;
  }
  return f;
}

/* ── well-known types ── */

function registerBuiltins(reg) {
  var empty = new MessageType('google.protobuf.Empty', [], reg._opts);
  reg.messages['google.protobuf.Empty'] = empty;
  var ts = new MessageType('google.protobuf.Timestamp', [
    { name: 'seconds', number: 1, type: 'scalar', scalar: 'int64', rule: 'singular', presence: false, packed: false, oneof: null },
    { name: 'nanos', number: 2, type: 'scalar', scalar: 'int32', rule: 'singular', presence: false, packed: false, oneof: null },
  ], reg._opts);
  reg.messages['google.protobuf.Timestamp'] = ts;
  var du = new MessageType('google.protobuf.Duration', [
    { name: 'seconds', number: 1, type: 'scalar', scalar: 'int64', rule: 'singular', presence: false, packed: false, oneof: null },
    { name: 'nanos', number: 2, type: 'scalar', scalar: 'int32', rule: 'singular', presence: false, packed: false, oneof: null },
  ], reg._opts);
  reg.messages['google.protobuf.Duration'] = du;
  var wrappers = {
    DoubleValue: ['double'], FloatValue: ['float'], Int64Value: ['int64'], UInt64Value: ['uint64'],
    Int32Value: ['int32'], UInt32Value: ['uint32'], BoolValue: ['bool'], StringValue: ['string'], BytesValue: ['bytes'],
  };
  for (var w in wrappers) {
    reg.messages['google.protobuf.' + w] = new MessageType('google.protobuf.' + w, [
      { name: 'value', number: 1, type: 'scalar', scalar: wrappers[w][0], rule: 'singular', presence: false, packed: false, oneof: null },
    ], reg._opts);
  }
}

/* ── public entry ── */

function parseProto(text, opts) {
  opts = opts || {};
  var file = new Parser(String(text)).parseFile();
  var reg = new Registry(file.package);
  reg._opts = opts;
  reg.imports = file.imports;
  registerBuiltins(reg);

  // Fully-qualified name for a scope path (package-prefixed).
  function fq(full) { return (reg.package ? reg.package + '.' : '') + full.join('.'); }

  // 1. enums (messages may reference them)
  function addEnums(list) {
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var full = fq(e.full);
      reg.enums[full] = new EnumType(full, e.values);
    }
  }
  function walkEnums(msg) {
    addEnums(msg.nestedEnums);
    for (var i = 0; i < msg.nested.length; i++) walkEnums(msg.nested[i]);
  }
  addEnums(file.enums);
  for (var fi = 0; fi < file.messages.length; fi++) walkEnums(file.messages[fi]);

  // 2. message shells (so forward references resolve)
  function addMsgShells(msg) {
    var full = fq(msg.full);
    reg.messages[full] = new MessageType(full, [], opts);
    for (var i = 0; i < msg.nested.length; i++) addMsgShells(msg.nested[i]);
  }
  for (var mi = 0; mi < file.messages.length; mi++) addMsgShells(file.messages[mi]);

  // 3. fill fields (resolution may hit any shell/enum)
  function fillMsg(msg) {
    var full = fq(msg.full);
    var mt = reg.messages[full];
    var fields = [];
    for (var i = 0; i < msg.fields.length; i++) fields.push(buildField(reg, msg.fields[i]));
    mt.fields = fields;
    mt.byNumber = {}; mt.byName = {};
    for (var j = 0; j < fields.length; j++) {
      var f = fields[j];
      if (mt.byNumber[f.number]) throw new Error('protobuf: duplicate field number ' + f.number + ' in ' + full);
      mt.byNumber[f.number] = f; mt.byName[f.name] = f;
    }
    mt.oneofs = msg.oneofs;
    for (var k = 0; k < msg.nested.length; k++) fillMsg(msg.nested[k]);
  }
  for (var fj = 0; fj < file.messages.length; fj++) fillMsg(file.messages[fj]);

  // 4. services
  for (var si = 0; si < file.services.length; si++) {
    var sd = file.services[si];
    var sfull = (reg.package ? reg.package + '.' : '') + sd.name;
    var svc = { name: sd.name, fullName: sfull, methods: {} };
    for (var mj = 0; mj < sd.methods.length; mj++) {
      var md = sd.methods[mj];
      var inScope = [];
      var rt = resolveName(reg, md.input, inScope) || resolveName(reg, md.input, [sd.name]);
      var ot = resolveName(reg, md.output, inScope) || resolveName(reg, md.output, [sd.name]);
      if (!rt || rt.kind !== 'message') throw new Error('protobuf: unknown request type ' + md.input + ' for ' + sd.name + '.' + md.name);
      if (!ot || ot.kind !== 'message') throw new Error('protobuf: unknown response type ' + md.output + ' for ' + sd.name + '.' + md.name);
      svc.methods[md.name] = {
        name: md.name,
        service: sfull,
        path: '/' + sfull + '/' + md.name,
        requestType: rt,
        responseType: ot,
        clientStreaming: !!md.clientStreaming,
        serverStreaming: !!md.serverStreaming,
      };
    }
    reg.services[sfull] = svc;
    var sn = sd.name;
    if (!Object.prototype.hasOwnProperty.call(reg, sn)) reg[sn] = svc;
  }

  shortNames(reg);
  return reg;
}

// ── global mount ──

export { parseProto, MessageType, EnumType, Registry, utf8Encode, utf8Decode };

export function setupProtobuf(pal) {
  globalThis.protobuf = {
    parseProto: parseProto,
    MessageType: MessageType,
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
  };
}
