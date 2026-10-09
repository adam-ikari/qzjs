/**
 * qzjs polyfill: structuredClone (enhanced)
 *
 * 深拷贝委托 @ungap/structured-clone（StructuredSerialize/Deserialize 算法），
 * qzjs 扩展语义保留自研分支：
 *   - MessagePort：仅可 transfer（列表内 → __qz_port_from_ref__ 重建纠缠端口）
 *   - ArrayBuffer：transfer → 立即 detach；非 transfer → 复制内容
 *   - DataView：保留 byteOffset/byteLength（@ungap 委托会丢失两者）
 *   - Blob / File：qzjs 自定义类型（@ungap 无感知）
 *   - DOMException：qzjs 构造签名 (message, name)，与 @ungap ERROR 分支
 *     (name, message) 参数序错位
 *   - function / symbol → DataCloneError（@ungap 抛 TypeError）
 *   - 自定义原型对象 → DataCloneError（@ungap 会降级为普通对象）
 *
 * 纯数据子树（Object/Array/Map/Set/Date/RegExp/Error/TypedArray/ArrayBuffer/
 * 原语）整体委托 @ungap——其引用表保持循环引用与共享引用一致。
 * 一致性契约：委托发生在整棵子树上，外部 seen 只记录子树根映射；子树内部的
 * 共享/循环由 @ungap 引用表保持，跨委托子树的共享由外部 seen 保持。
 *
 * 字节序列化（__qz_serialize__ / __qz_deserialize__）为 worker 跨线程
 * 传输与挂起恢复共用的自有 ABI，原样保留，不在替换范围。
 */

import { serialize, deserialize } from '@ungap/structured-clone';

export function setupStructuredClone() {

  /**
   * structuredClone(value, options)
   *
   * Clones a value using the structured clone algorithm.
   * Handles circular references and special JS types.
   */
  globalThis.structuredClone = function structuredClone(value, options) {
    /* transfer 列表校验（v1 只支持 ArrayBuffer / MessagePort） */
    var transferSet = null;
    if (options && options.transfer !== undefined && options.transfer !== null) {
      if (!Array.isArray(options.transfer))
        throw new DOMException('transfer must be a sequence', 'DataCloneError');
      transferSet = new Set();
      for (var i = 0; i < options.transfer.length; i++) {
        var t = options.transfer[i];
        if (transferSet.has(t))
          throw new DOMException('duplicate transferable', 'DataCloneError');
        /* transferable: ArrayBuffer, 或 MessagePort（v1 只这两种） */
        var isPort = typeof globalThis.MessagePort === 'function' &&
                     t instanceof globalThis.MessagePort;
        if (!(t instanceof ArrayBuffer) && !isPort)
          throw new DOMException('object is not transferable', 'DataCloneError');
        if (t instanceof ArrayBuffer && t.detached)
          throw new DOMException('ArrayBuffer has already been detached', 'DataCloneError');
        transferSet.add(t);
      }
    }
    /* 把 transferSet 挂到私有字段，随 clone 递归自动传递（不改用户对象） */
    if (options && typeof options === 'object') {
      options = { transfer: options.transfer, _qzTransfer: transferSet };
    } else {
      options = { _qzTransfer: transferSet };
    }
    var seen = new Map();
    var result = clone(value, seen, options);
    /* 未被消息引用的 transfer 对象也要 detach（ArrayBuffer: transfer()；
     * MessagePort: 标记 detached——同线程转移返回原引用，仅表达不可再用） */
    if (transferSet) {
      transferSet.forEach(function (t) {
        if (t instanceof ArrayBuffer) {
          if (!t.detached) t.transfer();
        } else if (typeof t._detached === 'boolean') {
          t._detached = true;
        }
      });
    }
    return result;
  };

  /* ================================================================
   * 深拷贝：委托 @ungap/structured-clone
   *
   * 委托判定：子树不含 qzjs 扩展（见文件头清单）→ 整树委托 @ungap。
   * 含扩展 → 逐键递归（容器：Object/Array/Map/Set）。
   * ================================================================ */

  /* 子树是否含 qzjs 扩展（不可整体委托给 @ungap） */
  function containsExtended(value, scan) {
    if (value === null) return false;
    var type = typeof value;
    if (type === 'function' || type === 'symbol') return true;
    if (type !== 'object') return false;
    if (scan.has(value)) return false;
    scan.add(value);
    if (typeof globalThis.MessagePort === 'function' && value instanceof globalThis.MessagePort) return true;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
    if (typeof File !== 'undefined' && value instanceof File) return true;
    if (typeof DOMException === 'function' && value instanceof DOMException) return true;
    if (value instanceof DataView) return true;
    if (value instanceof Date || value instanceof RegExp || value instanceof Error) return false;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false;
    var proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null &&
        !(value instanceof Map) && !(value instanceof Set) && !Array.isArray(value)) return true;
    if (value instanceof Map) {
      var ext = false;
      value.forEach(function (v, k) {
        if (!ext) ext = containsExtended(k, scan) || containsExtended(v, scan);
      });
      return ext;
    }
    if (value instanceof Set) {
      var ext2 = false;
      value.forEach(function (v) {
        if (!ext2) ext2 = containsExtended(v, scan);
      });
      return ext2;
    }
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      if (containsExtended(value[keys[i]], scan)) return true;
    }
    return false;
  }

  function clone(value, seen, options) {
    // Primitives: return as-is (handles null, undefined, boolean, number, string, bigint, symbol)
    if (value === null || value === undefined) return value;
    var type = typeof value;
    if (type === 'boolean' || type === 'number' || type === 'string' || type === 'bigint') {
      return value;
    }
    if (type === 'symbol') {
      throw new DOMException('Symbols cannot be cloned', 'DataCloneError');
    }

    // Check for circular reference
    if (typeof value === 'object' || typeof value === 'function') {
      if (seen.has(value)) {
        return seen.get(value);
      }
    }

    // Handle functions — cannot be cloned
    if (typeof value === 'function') {
      throw new DOMException('Functions cannot be cloned', 'DataCloneError');
    }

    // MessagePort：只可转移（transfer 列表），不可克隆。
    if (typeof globalThis.MessagePort === 'function' &&
        value instanceof globalThis.MessagePort) {
      var ts = options && options._qzTransfer;
      if (ts && ts.has(value)) {
        ts.delete(value);
        /* 转移：原 port detached；返回一个新的可用代理（同线程下与原
         * 对端纠缠）。复用 message-channel 的 __qz_port_from_ref__。 */
        if (globalThis.__qz_port_from_ref__) {
          var peer = value._entangledPort;
          value._detached = true;
          var pr = globalThis.__qz_port_from_ref__(
            { id: value._id, peerId: value._peerId, owner: value._owner,
              peerThread: 'local' });
          if (peer && pr) pr._entangledPort = peer;
          seen.set(value, pr);
          return pr;
        }
        seen.set(value, value);
        return value;
      }
      throw new DOMException('MessagePort cannot be cloned (use transfer)', 'DataCloneError');
    }

    // ArrayBuffer：transfer → 内容转移到新 buffer，原 buffer detached；否则复制
    if (value instanceof ArrayBuffer) {
      var ts2 = options && options._qzTransfer;
      var result;
      if (ts2 && ts2.has(value)) {
        ts2.delete(value);
        result = value.transfer();
      } else {
        result = value.slice(0);
      }
      seen.set(value, result);
      return result;
    }

    // DataView：保留 byteOffset / byteLength（@ungap 委托会丢失）
    if (value instanceof DataView) {
      var buf = clone(value.buffer, seen, options);
      return new DataView(buf, value.byteOffset, value.byteLength);
    }

    // Blob / File：qzjs 自定义类型，@ungap 无感知
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      if (typeof File !== 'undefined' && value instanceof File) {
        return new File([value], value.name, { type: value.type, lastModified: value.lastModified });
      }
      return new Blob([value], { type: value.type });
    }

    // DOMException：(message, name) 构造序，与 @ungap ERROR 分支 (name, message) 错位
    if (typeof DOMException === 'function' && value instanceof DOMException) {
      return new DOMException(value.message, value.name);
    }

    // 自定义 class 实例 / 非普通原型对象：结构化克隆不支持 → DataCloneError
    var proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null &&
        !(value instanceof Date) && !(value instanceof RegExp) &&
        !(value instanceof Map) && !(value instanceof Set) &&
        !(value instanceof Error) &&
        !(value instanceof ArrayBuffer) && !(ArrayBuffer.isView(value))) {
      throw new DOMException('Object with custom prototype cannot be cloned', 'DataCloneError');
    }

    // 纯数据子树 → 整体委托 @ungap（循环/共享引用由库引用表保持）
    if (!containsExtended(value, new Set())) {
      var delegated = deserialize(serialize(value));
      seen.set(value, delegated);
      return delegated;
    }

    // 子树含扩展 → 逐键递归
    if (Array.isArray(value)) {
      var arr = [];
      seen.set(value, arr);
      for (var i = 0; i < value.length; i++) {
        arr[i] = clone(value[i], seen, options);
      }
      return arr;
    }
    if (value instanceof Map) {
      var map = new Map();
      seen.set(value, map);
      value.forEach(function (v, k) {
        map.set(clone(k, seen, options), clone(v, seen, options));
      });
      return map;
    }
    if (value instanceof Set) {
      var set = new Set();
      seen.set(value, set);
      value.forEach(function (v) {
        set.add(clone(v, seen, options));
      });
      return set;
    }
    var obj = {};
    seen.set(value, obj);
    var keys = Object.keys(value);
    for (var j = 0; j < keys.length; j++) {
      /* F4 安全审计：'__proto__' 键必须落为 own 数据属性，不得触发原型 setter */
      Object.defineProperty(obj, keys[j], { value: clone(value[keys[j]], seen, options),
        writable: true, enumerable: true, configurable: true });
    }
    return obj;
  }

  /* ================================================================
   * 字节序列化（worker 跨线程传输 / 挂起恢复共用）
   *
   * serializeToBytes(value) -> ArrayBuffer，deserializeFromBytes(buf) -> value。
   * 自定 tag 流（LE 字节序），支持循环引用与 TypedArray/ArrayBuffer/Blob 等；
   * 函数/符号 → DataCloneError。v1 无 transferables。
   * 挂为 globalThis.__qz_serialize__ / __qz_deserialize__。
   * ================================================================ */

  var TA_CTORS = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
                  Int32Array, Uint32Array, Float32Array, Float64Array];
  if (typeof BigInt64Array !== 'undefined') TA_CTORS.push(BigInt64Array, BigUint64Array);

  function utf8Encode(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c < 0xd800 || c >= 0xe000) {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      } else {
        var c2 = s.charCodeAt(++i);
        var cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      }
    }
    return out;
  }

  function utf8Decode(u8, start, len) {
    var R = 0xFFFD;   /* U+FFFD REPLACEMENT CHARACTER */
    var out = '';
    var i = start, end = start + len;
    while (i < end) {
      var b = u8[i];
      var cp, n;
      if (b < 0x80) { cp = b; n = 1; }
      else if (b >= 0xc2 && b <= 0xdf) { cp = b & 0x1f; n = 2; }
      else if (b >= 0xe0 && b <= 0xef) { cp = b & 0x0f; n = 3; }
      else if (b >= 0xf0 && b <= 0xf4) { cp = b & 0x07; n = 4; }
      else { out += String.fromCharCode(R); i += 1; continue; }
      /* 校验 continuation 字节（0x80-0xBF）且不越界 */
      var ok = (i + n <= end);
      for (var j = 1; ok && j < n; j++) {
        var cb = u8[i + j];
        if (cb < 0x80 || cb > 0xbf) ok = false;
        else cp = (cp << 6) | (cb & 0x3f);
      }
      /* 过长编码 / 代理区码点 / 越界码点 → U+FFFD */
      if (ok && n === 3 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) ok = false;
      if (ok && n === 4 && (cp < 0x10000 || cp > 0x10ffff)) ok = false;
      if (!ok) {
        out += String.fromCharCode(R);
        i += 1;
        continue;
      }
      if (cp < 0x10000) {
        out += String.fromCharCode(cp);
      } else {
        var u = cp - 0x10000;
        out += String.fromCharCode(0xd800 + (u >> 10)) + String.fromCharCode(0xdc00 + (u & 0x3ff));
      }
      i += n;
    }
    return out;
  }

  function ByteWriter() {
    var bytes = [];
    return {
      u8: function (b) { bytes.push(b & 0xff); },
      u32: function (v) {
        bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
      },
      f64: function (v) {
        var ab = new ArrayBuffer(8), f = new Float64Array(ab), u = new Uint8Array(ab);
        f[0] = v;
        for (var i = 0; i < 8; i++) bytes.push(u[i]);
      },
      raw: function (u8) {
        for (var i = 0; i < u8.length; i++) bytes.push(u8[i]);
      },
      done: function () { return new Uint8Array(bytes).buffer; },
    };
  }


  /* §8.2 path 链与端点标签的字节编码（MessagePort ref 用）。owner 旧格式是
   * u32，新格式是 u8 长度 + u16 元素链；peerThread 旧格式是字符串，新格式是
   * u8 标签（0='local' 1=path 2='parent'）。编解码两侧同仓同步演进（跨进程
   * 两端同一 polyfill 版本）。 */
  function writePath(bytes, p) {
    p = (p === undefined || p === null) ? [] : (Array.isArray(p) ? p : [p | 0]);
    bytes.u8(p.length & 0xff);
    for (var i = 0; i < p.length; i++) {
      bytes.u8(p[i] & 0xff); bytes.u8((p[i] >> 8) & 0xff);
    }
  }
  function readPath(r) {
    var n = r.u8(), a = [];
    for (var i = 0; i < n; i++) a.push(r.u8() | (r.u8() << 8));
    return a;
  }
  function writePeerThread(bytes, pt) {
    if (pt === 'local' || pt === undefined || pt === null) { bytes.u8(0); return; }
    if (pt === 'parent') { bytes.u8(2); return; }
    bytes.u8(1); writePath(bytes, pt);
  }
  function readPeerThread(r) {
    var tag = r.u8();
    if (tag === 0) return 'local';
    if (tag === 2) return 'parent';
    return readPath(r);
  }
  function encodeString(bytes, s) {
    var u = utf8Encode(String(s));
    bytes.u32(u.length);
    for (var i = 0; i < u.length; i++) bytes.u8(u[i]);
  }

  function serializeToBytes(value, transfer) {
    /* transfer 列表校验：v1 只支持 ArrayBuffer；重复/不可转移 → DataCloneError */
    var transferSet = null;
    if (transfer !== undefined && transfer !== null) {
      if (!Array.isArray(transfer))
        throw new DOMException('transfer must be a sequence', 'DataCloneError');
      transferSet = new Set();
      for (var i = 0; i < transfer.length; i++) {
        var t = transfer[i];
        if (transferSet.has(t))
          throw new DOMException('duplicate transferable', 'DataCloneError');
        var isPort = typeof globalThis.MessagePort === 'function' &&
                     t instanceof globalThis.MessagePort;
        if (!(t instanceof ArrayBuffer) && !isPort)
          throw new DOMException('object is not transferable', 'DataCloneError');
        if (t instanceof ArrayBuffer && t.detached)
          throw new DOMException('ArrayBuffer has already been detached', 'DataCloneError');
        transferSet.add(t);
      }
    }
    var refs = new Map();     /* object -> 索引（首次出现分配） */
    var next = 0;
    var bytes = ByteWriter();

    function w(v) {
      if (v === null) { bytes.u8(0x01); return; }
      if (v === undefined) { bytes.u8(0x02); return; }
      var t = typeof v;
      if (t === 'boolean') { bytes.u8(v ? 0x03 : 0x04); return; }
      if (t === 'number') {
        if (Number.isInteger(v) && !Object.is(v, -0) &&
            v >= -2147483648 && v <= 2147483647) {
          bytes.u8(0x05); bytes.u32(v >>> 0);
        } else {
          bytes.u8(0x06); bytes.f64(v);
        }
        return;
      }
      if (t === 'string') { bytes.u8(0x07); encodeString(bytes, v); return; }
      if (t === 'bigint') { bytes.u8(0x1F); encodeString(bytes, v.toString()); return; }
      if (t === 'symbol') throw new DOMException('Symbols cannot be cloned', 'DataCloneError');
      if (t === 'function') throw new DOMException('Functions cannot be cloned', 'DataCloneError');

      if (refs.has(v)) { bytes.u8(0x1E); bytes.u32(refs.get(v)); return; }

      if (v instanceof Date) { refs.set(v, next++); bytes.u8(0x08); bytes.f64(v.getTime()); return; }
      if (v instanceof RegExp) {
        refs.set(v, next++); bytes.u8(0x09);
        encodeString(bytes, v.source); encodeString(bytes, v.flags);
        return;
      }
      if (v instanceof Error) {
        refs.set(v, next++); bytes.u8(0x0A);
        encodeString(bytes, v.name || 'Error'); encodeString(bytes, v.message || '');
        return;
      }
      if (typeof File !== 'undefined' && v instanceof File) {
        refs.set(v, next++); bytes.u8(0x1B);
        encodeString(bytes, v.name); encodeString(bytes, v.type || '');
        bytes.f64(v.lastModified);
        var fbytes = (typeof v._getBytes === 'function') ? v._getBytes() : null;
        if (!fbytes) throw new DOMException('File cannot be cloned', 'DataCloneError');
        bytes.u32(fbytes.length); bytes.raw(fbytes);
        return;
      }
      if (typeof Blob !== 'undefined' && v instanceof Blob) {
        refs.set(v, next++); bytes.u8(0x1A);
        encodeString(bytes, v.type || '');
        var bbytes = (typeof v._getBytes === 'function') ? v._getBytes() : null;
        if (!bbytes) throw new DOMException('Blob cannot be cloned', 'DataCloneError');
        bytes.u32(bbytes.length); bytes.raw(bbytes);
        return;
      }
      if (v instanceof Map) {
        refs.set(v, next++); bytes.u8(0x0B);
        bytes.u32(v.size);
        v.forEach(function (val, key) { w(key); w(val); });
        return;
      }
      if (v instanceof Set) {
        refs.set(v, next++); bytes.u8(0x0C);
        bytes.u32(v.size);
        v.forEach(function (val) { w(val); });
        return;
      }
      /* MessagePort：transfer 列表中的 → 编码为 __qz_port_ref；否则不可克隆 */
      if (typeof globalThis.MessagePort === 'function' &&
          v instanceof globalThis.MessagePort) {
        if (!transferSet || !transferSet.has(v))
          throw new DOMException('MessagePort cannot be cloned (use transfer)', 'DataCloneError');
        transferSet.delete(v);
        v._detached = true;
        refs.set(v, next++); bytes.u8(0x20);
        bytes.u32(v._id || 0);
        bytes.u32(v._peerId || 0);
        writePath(bytes, v._owner);          /* §8.2: (owner path,id) 身份消歧 */
        writePeerThread(bytes, v._peerThread);
        return;
      }
      if (v instanceof ArrayBuffer) {
        refs.set(v, next++); bytes.u8(0x0D);
        var au8 = new Uint8Array(v);
        bytes.u32(au8.length); bytes.raw(au8);
        if (transferSet && transferSet.has(v)) {
          transferSet.delete(v);
          v.transfer();   /* detach 原 buffer（返回的新 buffer 丢弃） */
        }
        return;
      }
      if (v instanceof DataView) {
        refs.set(v, next++); bytes.u8(0x0E);
        w(v.buffer);                        /* 嵌套写入（占新 ref 索引） */
        bytes.u32(v.byteOffset); bytes.u32(v.byteLength);
        return;
      }
      for (var i = 0; i < TA_CTORS.length; i++) {
        if (v instanceof TA_CTORS[i]) {
          refs.set(v, next++); bytes.u8(0x0F + i);
          var tu8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
          bytes.u32(tu8.length); bytes.raw(tu8);
          return;
        }
      }
      if (Array.isArray(v)) {
        refs.set(v, next++); bytes.u8(0x1C);
        bytes.u32(v.length);
        for (var i = 0; i < v.length; i++) w(v[i]);
        return;
      }
      /* 普通对象（原型为 Object.prototype/null）才可克隆；自定义 class 实例
       * 抛 DataCloneError（structured clone 语义）。 */
      var vproto = Object.getPrototypeOf(v);
      if (vproto !== Object.prototype && vproto !== null) {
        throw new DOMException('Object with custom prototype cannot be cloned', 'DataCloneError');
      }
      refs.set(v, next++); bytes.u8(0x1D);
      var keys;
      try { keys = Object.keys(v); } catch (e) { keys = []; }
      bytes.u32(keys.length);
      for (var i = 0; i < keys.length; i++) { encodeString(bytes, keys[i]); w(v[keys[i]]); }
    }

    w(value);
    /* 序列化完成后，detach 未被消息引用的 transfer 对象 */
    if (transferSet) {
      transferSet.forEach(function (ab) {
        if (!ab.detached) ab.transfer();
      });
    }
    return bytes.done();
  }

  function ByteReader(u8) {
    var i = 0;
    return {
      u8: function () { return u8[i++]; },
      u32: function () {
        var v = u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24);
        i += 4;
        return v >>> 0;
      },
      f64: function () {
        var ab = new ArrayBuffer(8), f = new Float64Array(ab), u = new Uint8Array(ab);
        for (var j = 0; j < 8; j++) u[j] = u8[i + j];
        i += 8;
        return f[0];
      },
      /* F4 安全审计：长度来自不可信字节流，必须先校验剩余字节，否则
       * str/bytes 会越界读 u8、或按 0xFFFFFFFF 巨量分配 Uint8Array。 */
      str: function () {
        var n = this.u32();
        if (n > u8.length - i) throw new DOMException('Bad serialized data', 'DataCloneError');
        var s = utf8Decode(u8, i, n);
        i += n;
        return s;
      },
      bytes: function (n) {
        if (n > u8.length - i) throw new DOMException('Bad serialized data', 'DataCloneError');
        var out = new Uint8Array(n);
        for (var j = 0; j < n; j++) out[j] = u8[i + j];
        i += n;
        return out.buffer;
      },
    };
  }

  function deserializeFromBytes(buf) {
    var r = ByteReader(new Uint8Array(buf));
    var refs = [];            /* 解码时的对象表（与编码 refs 索引一一对应） */

    function rd() {
      var tag = r.u8();
      switch (tag) {
        case 0x01: return null;
        case 0x02: return undefined;
        case 0x03: return true;
        case 0x04: return false;
        case 0x05: return r.u32() | 0;
        case 0x06: return r.f64();
        case 0x07: return r.str();
        case 0x08: return new Date(r.f64());
        case 0x09: return new RegExp(r.str(), r.str());
        case 0x0A: {
          var nm = r.str(), ms = r.str();
          var e = new Error(ms);
          e.name = nm;
          refs.push(e);
          return e;
        }
        case 0x0B: {
          var n = r.u32(); var m = new Map(); refs.push(m);
          for (var i = 0; i < n; i++) m.set(rd(), rd());
          return m;
        }
        case 0x0C: {
          var n = r.u32(); var s = new Set(); refs.push(s);
          for (var i = 0; i < n; i++) s.add(rd());
          return s;
        }
        case 0x0D: {
          var n = r.u32(); var ab = r.bytes(n); refs.push(ab);
          return ab;
        }
        case 0x0E: {
          var idx = refs.length; refs.push(null);   /* 占位，保持索引对齐 */
          var b = rd();
          var off = r.u32(), len = r.u32();
          /* 越界（off+len 超 buffer）→ DataCloneError 而非 RangeError */
          if (off + len > b.byteLength) {
            throw new DOMException('Bad serialized data', 'DataCloneError');
          }
          var dv = new DataView(b, off, len);
          refs[idx] = dv;
          return dv;
        }
        default: {
          if (tag >= 0x0F && tag <= 0x19) {
            var Ctor = TA_CTORS[tag - 0x0F];
            var n = r.u32();
            if (n % Ctor.BYTES_PER_ELEMENT !== 0) {
              throw new DOMException('Bad serialized data', 'DataCloneError');
            }
            var ta = new Ctor(r.bytes(n));
            refs.push(ta);
            return ta;
          }
          if (tag === 0x1A) {
            var type = r.str(), n = r.u32();
            var bl = new Blob([r.bytes(n)], { type: type });
            refs.push(bl);
            return bl;
          }
          if (tag === 0x1B) {
            var nm = r.str(), type = r.str(), lm = r.f64(), n = r.u32();
            var fl = new File([r.bytes(n)], nm, { type: type, lastModified: lm });
            refs.push(fl);
            return fl;
          }
          if (tag === 0x1C) {
            var n = r.u32(); var a = []; refs.push(a);
            for (var i = 0; i < n; i++) a[i] = rd();
            return a;
          }
          if (tag === 0x1D) {
            var n = r.u32(); var o = {}; refs.push(o);
            /* F4 安全审计：键来自不可信字节流。直接 o[k] 赋值时 k === '__proto__'
             * 会触发 setter 改写原型（原型链污染），因此走 defineProperty 固定为
             * 普通 own 数据属性。 */
            for (var i = 0; i < n; i++) {
              var k = r.str();
              Object.defineProperty(o, k, { value: rd(), writable: true,
                enumerable: true, configurable: true });
            }
            return o;
          }
          if (tag === 0x1E) {
            var ridx = r.u32();
            if (ridx >= refs.length) throw new DOMException('Bad serialized data', 'DataCloneError');
            return refs[ridx];
          }
          if (tag === 0x1F) {
            var bigStr = r.str();
            try { return BigInt(bigStr); }
            catch (e) { throw new DOMException('Bad serialized data', 'DataCloneError'); }
          }
          if (tag === 0x20) {
            /* MessagePort 引用：__qz_port_from_ref__ 创建/复用本地代理 */
            var pid = r.u32(), ppeer = r.u32(), powner = readPath(r), pth = readPeerThread(r);
            var portRef;
            if (globalThis.__qz_port_from_ref__) {
              portRef = globalThis.__qz_port_from_ref__(
                { id: pid, peerId: ppeer, owner: powner, peerThread: pth });
            } else {
              throw new DOMException('MessagePort reference requires message-channel', 'DataCloneError');
            }
            refs.push(portRef);
            return portRef;
          }
          throw new DOMException('Bad serialized data', 'DataCloneError');
        }
      }
    }

    return rd();
  }

  globalThis.__qz_serialize__ = serializeToBytes;
  globalThis.__qz_deserialize__ = deserializeFromBytes;
}
