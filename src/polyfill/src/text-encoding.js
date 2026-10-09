/**
 * qzjs Polyfill - TextEncoder + TextDecoder
 *
 * Pure JS implementation of the Web Encoding API with native acceleration.
 * Handles UTF-8 encoding/decoding including surrogate pairs.
 *
 * When pal.nativeEncodeUtf8 is available (textcodec extension),
 * uses native C for significantly faster encode/decode on large strings.
 */

export function setupTextEncoding(pal) {
  function TextEncoder() {
    this.encoding = 'utf-8';
  }

  TextEncoder.prototype.encode = function encode(input) {
    var str = input === undefined ? '' : String(input);
    if (typeof pal.nativeEncodeUtf8 === 'function') {
      return pal.nativeEncodeUtf8(str);
    }
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
      } else if (code >= 0xD800 && code <= 0xDBFF) {
        var hi = code;
        var lo = str.charCodeAt(++i);
        var codePoint = ((hi - 0xD800) << 10) + (lo - 0xDC00) + 0x10000;
        bytes.push(
          0xF0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3F),
          0x80 | ((codePoint >> 6) & 0x3F),
          0x80 | (codePoint & 0x3F)
        );
      } else {
        bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
      }
    }
    return new Uint8Array(bytes);
  };

  TextEncoder.prototype.encodeInto = function encodeInto(src, dst) {
    // Per spec: input is a DOMString, convert to string first so
    // primitive coercion (e.g. undefined → 'undefined') is applied.
    src = String(src);
    // dst must be a Uint8Array; other typed array views, DataView,
    // and ArrayBuffer throw TypeError. Write only bytes that fit; never
    // partially write a multi-byte character (read stops before it).
    if (!(dst instanceof Uint8Array)) {
      throw new TypeError('encodeInto: destination must be a Uint8Array');
    }
    var srcLen = src.length;
    var dstLen = dst.length;
    var read = 0;
    var written = 0;
    var i = 0;  /* src UTF-16 code unit index */
    var o = 0;  /* dst byte index */
    while (i < srcLen && o < dstLen) {
      var code = src.charCodeAt(i);
      if (code < 0x80) {
        /* 1 byte */
        if (o + 1 > dstLen) break;
        dst[o] = code;
        o += 1; i += 1; written += 1; read += 1;
      } else if (code >= 0xD800 && code <= 0xDBFF) {
        /* High surrogate: valid pair → 4 bytes, lone → U+FFFD (3 bytes) */
        if (i + 1 < srcLen) {
          var lo = src.charCodeAt(i + 1);
          if (lo >= 0xDC00 && lo <= 0xDFFF) {
            if (o + 4 > dstLen) break;
            var cp = ((code - 0xD800) << 10) + (lo - 0xDC00) + 0x10000;
            dst[o] = 0xF0 | (cp >> 18);
            dst[o+1] = 0x80 | ((cp >> 12) & 0x3F);
            dst[o+2] = 0x80 | ((cp >> 6) & 0x3F);
            dst[o+3] = 0x80 | (cp & 0x3F);
            o += 4; i += 2; written += 4; read += 2;
            continue;
          }
        }
        if (o + 3 > dstLen) break;
        dst[o] = 0xEF; dst[o+1] = 0xBF; dst[o+2] = 0xBD;  /* U+FFFD */
        o += 3; i += 1; written += 3; read += 1;
      } else if (code >= 0xDC00 && code <= 0xDFFF) {
        /* Lone low surrogate → U+FFFD (3 bytes) */
        if (o + 3 > dstLen) break;
        dst[o] = 0xEF; dst[o+1] = 0xBF; dst[o+2] = 0xBD;
        o += 3; i += 1; written += 3; read += 1;
      } else if (code < 0x800) {
        /* 2 bytes */
        if (o + 2 > dstLen) break;
        dst[o] = 0xC0 | (code >> 6);
        dst[o+1] = 0x80 | (code & 0x3F);
        o += 2; i += 1; written += 2; read += 1;
      } else {
        /* 3 bytes */
        if (o + 3 > dstLen) break;
        dst[o] = 0xE0 | (code >> 12);
        dst[o+1] = 0x80 | ((code >> 6) & 0x3F);
        dst[o+2] = 0x80 | (code & 0x3F);
        o += 3; i += 1; written += 3; read += 1;
      }
    }
    return { read: read, written: written };
  };

  function TextDecoder(encoding, options) {
    var label = (encoding || 'utf-8').toLowerCase();
    this.fatal = (options && options.fatal) || false;
    this.ignoreBOM = (options && options.ignoreBOM) || false;
    this._buffer = null;  /* accumulated incomplete multibyte bytes for stream:true */
    this._BOMSeen = false;  /* BOM handling: strip EF BB BF from first output only */

    /* Resolve encoding label to canonical name per WHATWG Encoding Standard.
     * Only UTF-8 is always supported; Latin-1 and replacement require the
     * compile-time QZ_WITH_NONUTF_ENCODINGS option. */
    if (label === 'unicode-1-1-utf-8' || label === 'utf-8' || label === 'utf8') {
      this.encoding = 'utf-8';
      this._decoder = 'utf8';
    } else if (label === 'replacement') {
        /* 'replacement' is a fatal-only encoding per WHATWG spec */
        throw new RangeError('The "replacement" label is not a valid encoding label');
      } else if (QZ_WITH_NONUTF_ENCODINGS) {
      if (label === 'iso-8859-1' || label === 'iso_8859-1' || label === 'latin1' ||
          label === 'l1' || label === 'ibm819' || label === 'cp819' ||
          label === 'csisolatin1' || label === 'iso-ir-100' || label === 'windows-28591') {
        this.encoding = 'windows-1252';
        this._decoder = 'latin1';
      } else if (this.fatal) {
        throw new RangeError('Encoding "' + encoding + '" not supported');
      } else {
        /* Non-fatal: fall back to UTF-8 for unknown labels */
        this.encoding = 'utf-8';
        this._decoder = 'utf8';
      }
    } else {
      /* Non-UTF encodings not compiled in */
      if (this.fatal) {
        throw new RangeError('Encoding "' + encoding + '" not supported');
      }
      this.encoding = 'utf-8';
      this._decoder = 'utf8';
    }
  }

  /* Return the number of continuation bytes needed (0-3) for a lead byte, or
   * -1 if the lead byte is invalid. */
  function utf8LeadLen(byte) {
    if (byte < 0x80) return 0;
    if (byte < 0xC0) return -1;    /* continuation byte at wrong position */
    if (byte < 0xE0) return 2;     /* 2-byte sequence */
    if (byte < 0xF0) return 3;     /* 3-byte sequence */
    if (byte < 0xF8) return 4;     /* 4-byte sequence */
    return -1;
  }

  TextDecoder.prototype.decode = function decode(input, options) {
    var streamMode = options && options.stream;
    var bytes = (input instanceof Uint8Array) ? input : new Uint8Array(input || new Uint8Array(0));

    /* Non-UTF-8 decoders */
    if (this._decoder === 'latin1') {
      var str = '';
      for (var i = 0; i < bytes.length; i++) {
        str += String.fromCharCode(bytes[i] & 0xFF);
      }
      return str;
    }
    /* UTF-8 decode 恒走 JS 路径：本实现完整支持流式（stream:true）、fatal
     * 与 U+FFFD 替换语义。 */

    /* Prepend any buffered incomplete bytes from a previous stream:true call */
    var allBytes;
    if (this._buffer && this._buffer.length > 0) {
      allBytes = new Uint8Array(this._buffer.length + bytes.length);
      allBytes.set(new Uint8Array(this._buffer), 0);
      allBytes.set(bytes, this._buffer.length);
      this._buffer = null;
    } else {
      allBytes = bytes;
    }

    /* UTF-8 BOM stripping (WHATWG Encoding): only before the first non-BOM
     * output, and only when ignoreBOM is false. */
    if (this._decoder === 'utf8' && !this._BOMSeen && !this.ignoreBOM &&
        allBytes.length >= 3 &&
        allBytes[0] === 0xEF && allBytes[1] === 0xBB && allBytes[2] === 0xBF) {
      allBytes = allBytes.subarray(3);
    }
    if (!this._BOMSeen && allBytes.length > 0) {
      this._BOMSeen = true;
    }

    var str = '';
    var i = 0;
    var lastComplete = 0;
    while (i < allBytes.length) {
      var lead = allBytes[i];
      var want = utf8LeadLen(lead);
      if (want < 0) {
        if (this.fatal) throw new TypeError('TextDecoder: invalid UTF-8 sequence');
        str += '�';
        i++;
        continue;
      }
      if (want === 0) {
        str += String.fromCharCode(lead);
        i++;
        continue;
      }
      /* Lead-specific continuation range check (RFC 3629 / WHATWG Encoding).
       * Overlong sequences and out-of-range continuations are caught here.
       * Must run BEFORE the truncated check so overlong sequences produce
       * per-byte U+FFFD (not just one for the lead). */
      var ok = true;
      if (want >= 2 && i + 1 < allBytes.length) {
        var b1 = allBytes[i + 1];
        if ((lead === 0xE0 && b1 < 0xA0) ||
            (lead === 0xED && b1 > 0x9F) ||
            (lead === 0xF0 && b1 < 0x90) ||
            (lead === 0xF4 && b1 > 0x8F)) {
          ok = false;
        }
      }
      if (!ok) {
        if (this.fatal) throw new TypeError('TextDecoder: invalid UTF-8 sequence');
        str += '�';
        i++;  /* skip lead; continuation bytes caught by want<0 */
        continue;
      }
      /* Multi-byte: need want bytes total (lead + want-1 continuations). */
      if (i + want > allBytes.length) {
        /* Incomplete at end of input */
        if (streamMode) {
          /* Buffer the lead + any available continuation bytes (up to
           * want total). Remaining bytes (e.g. 'A' after [0xF0,0x9F])
           * must continue to be processed. */
          var bufWant = Math.min(want, allBytes.length - i);
          this._buffer = [];
          for (var k = i; k < i + bufWant; k++) this._buffer.push(allBytes[k]);
          i += bufWant;
          if (i >= allBytes.length) break;
          continue;
        }
        /* Not stream mode: emit one U+FFFD for the lead. If the
         * available bytes after this are all valid continuation bytes,
         * skip them (they belong to this failed lead). Otherwise each
         * gets its own U+FFFD (overlong/invalid case). */
        if (this.fatal) throw new TypeError('TextDecoder: incomplete UTF-8 sequence');
        str += '�';
        i++;  /* skip lead */
        var availCont = 0;
        while (i + availCont < allBytes.length &&
               (allBytes[i + availCont] & 0xC0) === 0x80) {
          availCont++;
        }
        if (availCont > 0 && availCont <= want - 1) {
          i += availCont;  /* skip all valid continuation bytes */
        }
        continue;
      }
      /* Verify generic continuation byte format */
      var ok = true;
      for (var j = 1; j < want && i + j < allBytes.length; j++) {
        if ((allBytes[i + j] & 0xC0) !== 0x80) { ok = false; break; }
      }
      if (!ok) {
        if (this.fatal) throw new TypeError('TextDecoder: invalid UTF-8 sequence');
        str += '�';
        i++;  /* skip lead; continuation bytes caught by want<0 */
        continue;
      }
      /* Decode */
      if (want === 2) {
        str += String.fromCharCode(((lead & 0x1F) << 6) | (allBytes[i+1] & 0x3F));
      } else if (want === 3) {
        str += String.fromCharCode(
          ((lead & 0x0F) << 12) | ((allBytes[i+1] & 0x3F) << 6) | (allBytes[i+2] & 0x3F)
        );
      } else {
        var codepoint = ((lead & 0x07) << 18) | ((allBytes[i+1] & 0x3F) << 12) |
          ((allBytes[i+2] & 0x3F) << 6) | (allBytes[i+3] & 0x3F);
        str += String.fromCodePoint(codepoint);
      }
      i += want;
    }

    return str;
  };

  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}