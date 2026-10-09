/**
 * qzjs polyfill: crypto.subtle
 *
 * TC55/ECMA-429 requires crypto.subtle with at minimum:
 *   - digest (SHA-1, SHA-256, SHA-384, SHA-512)
 *   - importKey / sign / verify (HMAC)
 *   - importKey (for PBKDF2)
 *
 * Supported beyond the minimum:
 *   - HMAC generateKey (with algorithm.length in bits)
 *   - AES-CBC / AES-GCM / AES-CTR encrypt/decrypt/generateKey
 *   - AES-KW wrap/unwrap (RFC 3394)
 *   - PBKDF2 deriveBits/deriveKey
 *   - HKDF deriveBits/deriveKey (SHA-1..SHA-512)
 *   - ECDSA P-256/P-384/P-521 generateKey/importKey/exportKey(jwk)/sign/verify
 *   - ECDH deriveBits/deriveKey (P-256/P-384/P-521)
 *   - RSA-OAEP generateKey/importKey(spki/pkcs8)/exportKey/encrypt/decrypt
 *     (modulusLength 2048/3072/4096, MGF1 = hash, label supported)
 *   - RSASSA-PKCS1-v1_5 generateKey/importKey(spki/pkcs8)/exportKey/sign/verify
 *     (SHA-1/256/384/512)
 *
 * All operations delegate to native C functions via pal.nativeDigest,
 * pal.nativeHmac, pal.nativeAesEncrypt, pal.nativeAesDecrypt,
 * pal.nativePbkdf2, pal.nativeHkdf, pal.nativeAesKwWrap/Unwrap,
 * pal.nativeEcGenerate, pal.nativeEcdh, pal.nativeEcdsaSign/Verify,
 * pal.nativeRsaGenerateKey, pal.nativeRsaOaepEncrypt/Decrypt,
 * pal.nativeRsaSign/Verify. These are registered by the crypto extension
 * (ext_crypto.c, gated by QZ_WITH_CRYPTO_EXT).
 */

export function setupCryptoSubtle(pal) {
  /* Expose the installer on the pal object. The crypto extension's init hook
   * (ext_crypto.c) calls pal.__installCryptoSubtle__() after registering its
   * native hooks. If the extension is absent, the installer is never called
   * and crypto.subtle stays undefined. */
  pal.__installCryptoSubtle__ = function() {
    installCryptoSubtle(pal);
  };
}

/* Build and attach the SubtleCrypto + CryptoKey to globalThis.crypto. Called
 * lazily by the extension's init hook (via pal.__installCryptoSubtle__) so it
 * only runs when the native crypto hooks are present. */
function installCryptoSubtle(pal) {

  // ================================================================
  // Helper functions
  // ================================================================

  function toUint8Array(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError('Expected ArrayBuffer or TypedArray');
  }

  function toArrayBuffer(u8) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }
  /* Constant-time byte-array equality for secret-derived data (HMAC tags,
   * future verify sites). Accumulates XOR over every byte so the comparison
   * cost does not reveal the position of the first difference. Length is not
   * secret, so a length mismatch returns false immediately. */
  function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }
    return diff === 0;
  }

  /* 各算法允许的 key usages（WebCrypto 规范） */
  var USAGE_MAP = {
    'HMAC': ['sign', 'verify'],
    'AES-CBC': ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    'AES-GCM': ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    'AES-CTR': ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    'AES-KW': ['wrapKey', 'unwrapKey'],
    'PBKDF2': ['deriveBits', 'deriveKey'],
    'HKDF': ['deriveBits', 'deriveKey'],
    'ECDSA': ['sign', 'verify'],
    'ECDH': ['deriveBits', 'deriveKey'],
    'RSA-OAEP': ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    'RSASSA-PKCS1-v1_5': ['sign', 'verify'],
  };

  /* importKey 校验 keyUsages 与算法兼容性 */
  function validateUsages(algoName, usages) {
    if (!Array.isArray(usages)) return;
    var allowed = USAGE_MAP[algoName];
    if (!allowed) return;
    for (var i = 0; i < usages.length; i++) {
      if (allowed.indexOf(usages[i]) < 0) {
        throw new SyntaxError('Invalid keyUsages for ' + algoName + ': ' + usages[i]);
      }
    }
  }

  /* 运行时校验 key 的 usages 是否含所需操作 */
  function checkUsage(key, usage) {
    if (!key || !Array.isArray(key._usages)) return;
    if (key._usages.indexOf(usage) < 0) {
      throw new DOMException('Key does not support ' + usage, 'InvalidAccessError');
    }
  }

  /* AES-GCM tagLength 范围校验（bits）：返回字节数 */
  function validateGcmTagLength(tagLength) {
    var tl = tagLength !== undefined ? Number(tagLength) : 128;
    if (tl !== 32 && tl !== 64 && tl !== 96 && tl !== 104 &&
        tl !== 112 && tl !== 120 && tl !== 128) {
      throw new DOMException('Invalid tagLength', 'OperationError');
    }
    return tl / 8;
  }

  var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function base64UrlEncode(bytes) {
    var str = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      str += B64_CHARS[b0 >> 2];
      str += B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
      str += i + 1 < bytes.length ? B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
      str += i + 2 < bytes.length ? B64_CHARS[b2 & 63] : '=';
    }
    return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var bytes = [];
    for (var i = 0; i < str.length; i += 4) {
      var c0 = chars.indexOf(str[i]), c1 = chars.indexOf(str[i+1]);
      var c2 = chars.indexOf(str[i+2]), c3 = chars.indexOf(str[i+3]);
      bytes.push((c0 << 2) | (c1 >> 4));
      if (c2 !== -1 && str[i+2] !== '=') bytes.push(((c1 & 15) << 4) | (c2 >> 2));
      if (c3 !== -1 && str[i+3] !== '=') bytes.push(((c2 & 3) << 6) | c3);
    }
    return new Uint8Array(bytes);
  }

  // ================================================================
  // CryptoKey
  // ================================================================

  class CryptoKey {
    constructor(type, algorithm, extractable, usages, data) {
      this._type = type;
      this._algorithm = algorithm;
      this._extractable = extractable;
      this._usages = usages;
      this._data = data;
    }

    get type() { return this._type; }
    get algorithm() { return this._algorithm; }
    get extractable() { return this._extractable; }
    get usages() { return this._usages; }
  }

  // ================================================================
  // SubtleCrypto
  // ================================================================

  class SubtleCrypto {
    constructor() {}

    digest(algorithm, data) {
      return new Promise(function(resolve, reject) {
        var name = typeof algorithm === 'string' ? algorithm : algorithm.name;

        if (typeof pal.nativeDigest !== 'function') {
          reject(new DOMException('Crypto extension not available', 'NotSupportedError'));
          return;
        }

        try {
          var result = pal.nativeDigest(name, toUint8Array(data));
          resolve(toArrayBuffer(result));
        } catch (e) {
          reject(e);
        }
      });
    }
    importKey(format, keyData, algorithm, extractable, keyUsages) {
      return new Promise(function(resolve, reject) {
        var algoName = typeof algorithm === 'string' ? algorithm : algorithm.name;
        validateUsages(algoName, keyUsages);
        var data;

        if (algoName === 'ECDSA' || algoName === 'ECDH') {
          var curve = typeof algorithm === 'object' && algorithm ? algorithm.namedCurve : undefined;
          if (!curve) { reject(new TypeError('namedCurve required')); return; }
          var coordLen = curve === 'P-256' ? 32 : (curve === 'P-384' ? 48 : 66);

          if (format === 'raw') {
            /* public key: uncompressed point 0x04 || x || y */
            var raw = toUint8Array(keyData);
            if (raw.length !== coordLen * 2 + 1 || raw[0] !== 4) {
              reject(new DOMException('Invalid EC public key', 'DataError'));
              return;
            }
            resolve(new CryptoKey('public', { name: algoName, namedCurve: curve }, extractable, keyUsages, raw));
            return;
          }

          if (format === 'jwk') {
            if (!keyData || keyData.crv !== curve) {
              reject(new DOMException('Invalid JWK key data', 'DataError'));
              return;
            }
            if (keyData.d) {
              /* private key: d, zero-padded to coordLen */
              var d = base64UrlDecode(keyData.d);
              var dd = new Uint8Array(coordLen);
              dd.set(d.length > coordLen ? d.subarray(0, coordLen) : d, coordLen - d.length);
              resolve(new CryptoKey('private', { name: algoName, namedCurve: curve }, extractable, keyUsages, dd));
              return;
            }
            if (keyData.x && keyData.y) {
              var x = base64UrlDecode(keyData.x);
              var y = base64UrlDecode(keyData.y);
              var pub = new Uint8Array(coordLen * 2 + 1);
              pub[0] = 4;
              pub.set(x.length > coordLen ? x.subarray(0, coordLen) : x, 1 + coordLen - x.length);
              pub.set(y.length > coordLen ? y.subarray(0, coordLen) : y, 1 + 2 * coordLen - y.length);
              resolve(new CryptoKey('public', { name: algoName, namedCurve: curve }, extractable, keyUsages, pub));
              return;
            }
            reject(new DOMException('Invalid JWK EC key', 'DataError'));
            return;
          }

          reject(new DOMException('Unsupported key format: ' + format, 'NotSupportedError'));
          return;
        }

        if (algoName === 'RSA-OAEP' || algoName === 'RSASSA-PKCS1-v1_5') {
          var hashName = algorithm && algorithm.hash
            ? (typeof algorithm.hash === 'string' ? algorithm.hash : algorithm.hash.name)
            : 'SHA-256';
          if (format === 'spki' || format === 'pkcs8') {
            var der = toUint8Array(keyData);
            var ktype = format === 'spki' ? 'public' : 'private';
            resolve(new CryptoKey(ktype, { name: algoName, hash: hashName }, extractable, keyUsages, der));
            return;
          }
          reject(new DOMException('RSA importKey supports spki/pkcs8 only (jwk not implemented)', 'NotSupportedError'));
          return;
        }

        if (format === 'raw') {
          if (keyData instanceof ArrayBuffer) {
            data = new Uint8Array(keyData);
          } else if (ArrayBuffer.isView(keyData)) {
            data = new Uint8Array(keyData.buffer, keyData.byteOffset, keyData.byteLength);
          } else {
            reject(new TypeError('Invalid keyData'));
            return;
          }
        } else if (format === 'jwk') {
          if (!keyData || !keyData.k) {
            reject(new TypeError('Invalid JWK key data'));
            return;
          }
          data = base64UrlDecode(keyData.k);
        } else {
          reject(new DOMException('Unsupported key format: ' + format, 'NotSupportedError'));
          return;
        }

        resolve(new CryptoKey(
          'secret',
          { name: algoName },
          extractable,
          keyUsages,
          data
        ));
      });
    }
    sign(algorithm, key, data) {
      return new Promise(function(resolve, reject) {
        var algoName = typeof algorithm === 'string' ? algorithm : algorithm.name;
        checkUsage(key, 'sign');

        if (algoName === 'ECDSA') {
          var hashAlgo = algorithm.hash ? (typeof algorithm.hash === 'string' ? algorithm.hash : algorithm.hash.name) : undefined;
          if (!hashAlgo) { reject(new TypeError('hash required for ECDSA sign')); return; }
          if (key.type !== 'private' || typeof pal.nativeEcdsaSign !== 'function') {
            reject(new DOMException('Crypto extension not available or wrong key type', 'NotSupportedError'));
            return;
          }
          try {
            var sig = pal.nativeEcdsaSign(hashAlgo, key.algorithm.namedCurve, key._data, toUint8Array(data));
            resolve(toArrayBuffer(sig));
          } catch (e) { reject(e); }
          return;
        }

        if (algoName === 'HMAC') {
          var hashAlgo = algorithm.hash ? (typeof algorithm.hash === 'string' ? algorithm.hash : algorithm.hash.name) : 'SHA-256';

          if (typeof pal.nativeHmac !== 'function') {
            reject(new DOMException('Crypto extension not available', 'NotSupportedError'));
            return;
          }

          try {
            var result = pal.nativeHmac(hashAlgo, key._data, toUint8Array(data));
            resolve(toArrayBuffer(result));
          } catch (e) {
            reject(e);
          }
          return;
        }

        if (algoName === 'RSASSA-PKCS1-v1_5') {
          var hashAlgo = algorithm.hash ? (typeof algorithm.hash === 'string' ? algorithm.hash : algorithm.hash.name) : (key.algorithm.hash || 'SHA-256');
          if (key.type !== 'private' || typeof pal.nativeRsaSign !== 'function') {
            reject(new DOMException('Crypto extension not available or wrong key type', 'NotSupportedError'));
            return;
          }
          try {
            var sig = pal.nativeRsaSign(key._data, hashAlgo, toUint8Array(data));
            resolve(toArrayBuffer(sig));
          } catch (e) { reject(e); }
          return;
        }

        reject(new DOMException('Unsupported algorithm: ' + algoName, 'NotSupportedError'));
      });
    }

    verify(algorithm, key, signature, data) {
      return new Promise(function(resolve, reject) {
        var algoName = typeof algorithm === 'string' ? algorithm : algorithm.name;
        checkUsage(key, 'verify');

        if (algoName === 'ECDSA') {
          var hashAlgo = algorithm.hash ? (typeof algorithm.hash === 'string' ? algorithm.hash : algorithm.hash.name) : undefined;
          if (!hashAlgo) { reject(new TypeError('hash required for ECDSA verify')); return; }
          if (key.type !== 'public' || typeof pal.nativeEcdsaVerify !== 'function') {
            reject(new DOMException('Crypto extension not available or wrong key type', 'NotSupportedError'));
            return;
          }
          try {
            resolve(pal.nativeEcdsaVerify(hashAlgo, key.algorithm.namedCurve, key._data,
                                          toUint8Array(signature), toUint8Array(data)));
          } catch (e) { reject(e); }
          return;
        }

        if (algoName === 'HMAC') {
          this.sign(algorithm, key, data).then(function(computed) {
            var sig = toUint8Array(signature);
            var comp = new Uint8Array(computed);
            resolve(timingSafeEqual(sig, comp));
          }, reject);
          return;
        }

        if (algoName === 'RSASSA-PKCS1-v1_5') {
          var hashAlgo = algorithm.hash ? (typeof algorithm.hash === 'string' ? algorithm.hash : algorithm.hash.name) : (key.algorithm.hash || 'SHA-256');
          if (key.type !== 'public' || typeof pal.nativeRsaVerify !== 'function') {
            reject(new DOMException('Crypto extension not available or wrong key type', 'NotSupportedError'));
            return;
          }
          try {
            resolve(pal.nativeRsaVerify(key._data, hashAlgo, toUint8Array(data), toUint8Array(signature)));
          } catch (e) { reject(e); }
          return;
        }

        reject(new DOMException('Unsupported algorithm: ' + algoName, 'NotSupportedError'));
      }.bind(this));
    }

    encrypt(algorithm, key, data) {
      return new Promise(function(resolve, reject) {
        var algoName = typeof algorithm === 'string' ? algorithm : algorithm.name;
        var plaintext = toUint8Array(data);
        checkUsage(key, 'encrypt');

        if (algoName === 'RSA-OAEP') {
          var hashAlgo = algorithm.hash ? (typeof algorithm.hash === 'string' ? algorithm.hash : algorithm.hash.name) : (key.algorithm.hash || 'SHA-256');
          if (key.type !== 'public') {
            reject(new DOMException('RSA-OAEP encrypt requires a public key', 'InvalidAccessError'));
            return;
          }
          if (typeof pal.nativeRsaOaepEncrypt !== 'function') {
            reject(new DOMException('Crypto extension not available', 'NotSupportedError'));
            return;
          }
          try {
            var label = algorithm.label ? toUint8Array(algorithm.label) : undefined;
            var result = pal.nativeRsaOaepEncrypt(key._data, plaintext, label, hashAlgo);
            resolve(toArrayBuffer(result));
          } catch (e) { reject(e); }
          return;
        }

        if (typeof pal.nativeAesEncrypt !== 'function') {
          reject(new DOMException('Crypto extension not available', 'NotSupportedError'));
          return;
        }

        try {
          if (algoName === 'AES-CBC') {
            var iv = toUint8Array(algorithm.iv);
            var result = pal.nativeAesEncrypt(plaintext, key._data, iv, 'AES-CBC');
            resolve(toArrayBuffer(result));
            return;
          }
          if (algoName === 'AES-GCM') {
            var iv = toUint8Array(algorithm.iv);
            var aad = algorithm.additionalData ? toUint8Array(algorithm.additionalData) : undefined;
            var tagLen = validateGcmTagLength(algorithm.tagLength);
            var result = pal.nativeAesEncrypt(plaintext, key._data, iv, 'AES-GCM', aad, tagLen);
            resolve(toArrayBuffer(result));
            return;
          }
          if (algoName === 'AES-CTR') {
            var counter = toUint8Array(algorithm.counter);
            var result = pal.nativeAesEncrypt(plaintext, key._data, counter, 'AES-CTR');
            resolve(toArrayBuffer(result));
            return;
          }
        } catch (e) {
          reject(e);
          return;
        }

        reject(new DOMException('Unsupported algorithm: ' + algoName, 'NotSupportedError'));
      });
    }

    decrypt(algorithm, key, data) {
      return new Promise(function(resolve, reject) {
        var algoName = typeof algorithm === 'string' ? algorithm : algorithm.name;
        var ciphertext = toUint8Array(data);
        checkUsage(key, 'decrypt');

        if (algoName === 'RSA-OAEP') {
          var hashAlgo = algorithm.hash ? (typeof algorithm.hash === 'string' ? algorithm.hash : algorithm.hash.name) : (key.algorithm.hash || 'SHA-256');
          if (key.type !== 'private') {
            reject(new DOMException('RSA-OAEP decrypt requires a private key', 'InvalidAccessError'));
            return;
          }
          if (typeof pal.nativeRsaOaepDecrypt !== 'function') {
            reject(new DOMException('Crypto extension not available', 'NotSupportedError'));
            return;
          }
          try {
            var label = algorithm.label ? toUint8Array(algorithm.label) : undefined;
            var result = pal.nativeRsaOaepDecrypt(key._data, ciphertext, label, hashAlgo);
            resolve(toArrayBuffer(result));
          } catch (e) { reject(e); }
          return;
        }

        if (typeof pal.nativeAesDecrypt !== 'function') {
          reject(new DOMException('Crypto extension not available', 'NotSupportedError'));
          return;
        }

        try {
          if (algoName === 'AES-CBC') {
            var iv = toUint8Array(algorithm.iv);
            var result = pal.nativeAesDecrypt(ciphertext, key._data, iv, 'AES-CBC');
            resolve(toArrayBuffer(result));
            return;
          }
          if (algoName === 'AES-GCM') {
            var iv = toUint8Array(algorithm.iv);
            var aad = algorithm.additionalData ? toUint8Array(algorithm.additionalData) : undefined;
            var tagLen = validateGcmTagLength(algorithm.tagLength);
            var result = pal.nativeAesDecrypt(ciphertext, key._data, iv, 'AES-GCM', aad, tagLen);
            resolve(toArrayBuffer(result));
            return;
          }
          if (algoName === 'AES-CTR') {
            var counter = toUint8Array(algorithm.counter);
            var result = pal.nativeAesDecrypt(ciphertext, key._data, counter, 'AES-CTR');
            resolve(toArrayBuffer(result));
            return;
          }
        } catch (e) {
          reject(e);
          return;
        }

        reject(new DOMException('Unsupported algorithm: ' + algoName, 'NotSupportedError'));
      });
    }

    generateKey(algorithm, extractable, keyUsages) {
      return new Promise(function(resolve, reject) {
        var algoName = typeof algorithm === 'string' ? algorithm : algorithm.name;

        if (algoName === 'HMAC') {
          var hashAlgo = algorithm.hash ? (typeof algorithm.hash === 'string' ? algorithm.hash : algorithm.hash.name) : 'SHA-256';
          /* WebCrypto: algorithm.length is in BITS (HMAC key length). Default to
           * the hash output length in bytes when omitted (32 for SHA-256). Divide
           * by 8 to get bytes; clamp to >=1. */
          var lengthBits = algorithm.length !== undefined ? algorithm.length : 0;
          var lengthBytes;
          if (lengthBits > 0) {
            lengthBytes = Math.ceil(lengthBits / 8);
          } else {
            lengthBytes = hashAlgo === 'SHA-1' ? 20 : (hashAlgo === 'SHA-512' ? 64 : 32);
          }
          var keyBytes = new Uint8Array(lengthBytes);
          crypto.getRandomValues(keyBytes);
          resolve(new CryptoKey('secret', { name: 'HMAC', hash: hashAlgo }, extractable, keyUsages, keyBytes));
          return;
        }

        if (algoName === 'ECDSA' || algoName === 'ECDH') {
          var curve = algorithm.namedCurve;
          if (curve !== 'P-256' && curve !== 'P-384' && curve !== 'P-521') {
            reject(new DOMException('Unsupported namedCurve', 'NotSupportedError'));
            return;
          }
          if (typeof pal.nativeEcGenerate !== 'function') {
            reject(new DOMException('Crypto extension not available', 'NotSupportedError'));
            return;
          }
          try {
            var packed = new Uint8Array(pal.nativeEcGenerate(curve));
            var privLen = (packed[0] << 24) | (packed[1] << 16) | (packed[2] << 8) | packed[3];
            var priv = packed.slice(4, 4 + privLen);
            var pub = packed.slice(4 + privLen);
            var usages = keyUsages.filter(function(u) {
              return algoName === 'ECDSA' ? (u === 'sign' || u === 'verify') : (u === 'deriveKey' || u === 'deriveBits');
            });
            var pubKey = new CryptoKey('public', { name: algoName, namedCurve: curve }, extractable, usages.filter(function(u){ return u === 'verify' || u === 'deriveKey' || u === 'deriveBits'; }), pub);
            var privKey = new CryptoKey('private', { name: algoName, namedCurve: curve }, extractable, usages.filter(function(u){ return u !== 'verify'; }), priv);
            privKey._pub = pub;
            resolve({ publicKey: pubKey, privateKey: privKey });
          } catch (e) { reject(e); }
          return;
        }

        if (algoName === 'RSA-OAEP' || algoName === 'RSASSA-PKCS1-v1_5') {
          var hashAlgo = algorithm.hash ? (typeof algorithm.hash === 'string' ? algorithm.hash : algorithm.hash.name) : 'SHA-256';
          var modulusLength = algorithm.modulusLength || 2048;
          if (modulusLength !== 2048 && modulusLength !== 3072 && modulusLength !== 4096) {
            reject(new DOMException('Unsupported modulusLength (must be 2048/3072/4096)', 'NotSupportedError'));
            return;
          }
          var pubExp = algorithm.publicExponent || new Uint8Array([1, 0, 1]);
          if (typeof pal.nativeRsaGenerateKey !== 'function') {
            reject(new DOMException('Crypto extension not available', 'NotSupportedError'));
            return;
          }
          try {
            var kp = pal.nativeRsaGenerateKey(modulusLength, pubExp);
            var rsaUsages = keyUsages.filter(function(u) {
              return algoName === 'RSA-OAEP'
                ? (u === 'encrypt' || u === 'decrypt' || u === 'wrapKey' || u === 'unwrapKey')
                : (u === 'sign' || u === 'verify');
            });
            var rsaPub = new CryptoKey('public', { name: algoName, hash: hashAlgo }, extractable,
              rsaUsages.filter(function(u) { return u === 'encrypt' || u === 'wrapKey' || u === 'verify'; }),
              toUint8Array(kp.publicKeyDer));
            var rsaPriv = new CryptoKey('private', { name: algoName, hash: hashAlgo }, extractable,
              rsaUsages.filter(function(u) { return u === 'decrypt' || u === 'unwrapKey' || u === 'sign'; }),
              toUint8Array(kp.privateKeyDer));
            resolve({ publicKey: rsaPub, privateKey: rsaPriv });
          } catch (e) { reject(e); }
          return;
        }

        if (algoName === 'AES-CBC' || algoName === 'AES-GCM' || algoName === 'AES-CTR' || algoName === 'AES-KW') {
          var length = algorithm.length || 128;
          if (length !== 128 && length !== 192 && length !== 256) {
            reject(new DOMException('Invalid AES key length', 'OperationError'));
            return;
          }
          var keyBytes = new Uint8Array(length / 8);
          crypto.getRandomValues(keyBytes);
          resolve(new CryptoKey('secret', { name: algoName, length: length }, extractable, keyUsages, keyBytes));
          return;
        }

        reject(new DOMException('Unsupported algorithm: ' + algoName, 'NotSupportedError'));
      });
    }

    exportKey(format, key) {
      return new Promise(function(resolve, reject) {
        if (!key.extractable) {
          reject(new DOMException('Key is not extractable', 'InvalidAccessError'));
          return;
        }

        var algoName = key.algorithm.name;

        if (algoName === 'ECDSA' || algoName === 'ECDH') {
          var curve = key.algorithm.namedCurve;
          var coordLen = curve === 'P-256' ? 32 : (curve === 'P-384' ? 48 : 66);
          if (format === 'raw') {
            if (key.type !== 'public') {
              reject(new DOMException('raw export requires a public key', 'NotSupportedError'));
              return;
            }
            resolve(toArrayBuffer(key._data));
            return;
          }
          if (format === 'jwk') {
            var jwk = { kty: 'EC', crv: curve, ext: true, key_ops: key.usages };
            if (key.type === 'private') {
              jwk.d = base64UrlEncode(key._data);
              var pub = key._pub || new Uint8Array(0);
              if (pub.length === coordLen * 2 + 1) {
                jwk.x = base64UrlEncode(pub.subarray(1, 1 + coordLen));
                jwk.y = base64UrlEncode(pub.subarray(1 + coordLen));
              }
            } else {
              if (key._data.length !== coordLen * 2 + 1) {
                reject(new DOMException('Invalid public key', 'DataError'));
                return;
              }
              jwk.x = base64UrlEncode(key._data.subarray(1, 1 + coordLen));
              jwk.y = base64UrlEncode(key._data.subarray(1 + coordLen));
            }
            resolve(jwk);
            return;
          }
          reject(new DOMException('Unsupported export format: ' + format, 'NotSupportedError'));
          return;
        }

        if (algoName === 'RSA-OAEP' || algoName === 'RSASSA-PKCS1-v1_5') {
          if (format === 'spki') {
            if (key.type !== 'public') {
              reject(new DOMException('spki export requires a public key', 'NotSupportedError'));
              return;
            }
            resolve(toArrayBuffer(key._data));
            return;
          }
          if (format === 'pkcs8') {
            if (key.type !== 'private') {
              reject(new DOMException('pkcs8 export requires a private key', 'NotSupportedError'));
              return;
            }
            resolve(toArrayBuffer(key._data));
            return;
          }
          reject(new DOMException('RSA exportKey supports spki/pkcs8 only (jwk not implemented)', 'NotSupportedError'));
          return;
        }

        if (format === 'raw') {
          resolve(toArrayBuffer(key._data));
          return;
        }

        if (format === 'jwk') {
          var jwk = {
            kty: 'oct',
            k: base64UrlEncode(key._data),
            alg: algoName === 'HMAC' ? 'HS' + (key.algorithm.hash ? key.algorithm.hash.replace('SHA-', '') : '256') : algoName,
            ext: true,
            key_ops: key.usages,
          };
          resolve(jwk);
          return;
        }

        reject(new DOMException('Unsupported export format: ' + format, 'NotSupportedError'));
      });
    }


    wrapKey(format, key, wrappingKey, wrapAlgorithm) {
      return new Promise(function(resolve, reject) {
        var wrapName = typeof wrapAlgorithm === 'string' ? wrapAlgorithm : wrapAlgorithm.name;
        /* 被包装 key 必须可导出 */
        if (!key || !key.extractable) {
          reject(new DOMException('Key is not extractable', 'InvalidAccessError'));
          return;
        }
        checkUsage(wrappingKey, 'wrapKey');

        if (wrapName === 'AES-KW') {
          if (format !== 'raw') {
            reject(new DOMException('AES-KW supports raw format only', 'NotSupportedError'));
            return;
          }
          if (typeof pal.nativeAesKwWrap !== 'function') {
            reject(new DOMException('Crypto extension not available', 'NotSupportedError'));
            return;
          }
          try {
            resolve(toArrayBuffer(pal.nativeAesKwWrap(wrappingKey._data, toUint8Array(key._data))));
          } catch (e) { reject(e); }
          return;
        }

        if (wrapName !== 'AES-GCM' && wrapName !== 'AES-CBC') {
          reject(new DOMException('Unsupported wrap algorithm: ' + wrapName, 'NotSupportedError'));
          return;
        }
        if (typeof pal.nativeAesEncrypt !== 'function') {
          reject(new DOMException('Crypto extension not available', 'NotSupportedError'));
          return;
        }

        var plaintext;
        try {
          if (format === 'raw') {
            plaintext = toUint8Array(key._data);
          } else if (format === 'jwk') {
            var jwk = {
              kty: 'oct',
              k: base64UrlEncode(key._data),
              alg: key.algorithm.name === 'HMAC' ? 'HS' + (key.algorithm.hash ? key.algorithm.hash.replace('SHA-', '') : '256') : key.algorithm.name,
              ext: key.extractable,
              key_ops: key.usages,
            };
            plaintext = new TextEncoder().encode(JSON.stringify(jwk));
          } else {
            reject(new DOMException('Unsupported wrap format: ' + format, 'NotSupportedError'));
            return;
          }
        } catch (e) {
          reject(e);
          return;
        }

        try {
          if (wrapName === 'AES-GCM') {
            var iv = toUint8Array(wrapAlgorithm.iv);
            var aad = wrapAlgorithm.additionalData ? toUint8Array(wrapAlgorithm.additionalData) : undefined;
            var tagLen = validateGcmTagLength(wrapAlgorithm.tagLength);
            resolve(toArrayBuffer(pal.nativeAesEncrypt(plaintext, wrappingKey._data, iv, 'AES-GCM', aad, tagLen)));
            return;
          }
          if (wrapName === 'AES-CBC') {
            var iv = toUint8Array(wrapAlgorithm.iv);
            resolve(toArrayBuffer(pal.nativeAesEncrypt(plaintext, wrappingKey._data, iv, 'AES-CBC')));
            return;
          }
        } catch (e) {
          reject(e);
          return;
        }
      });
    }

    unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgorithm, unwrappedKeyAlgorithm, extractable, keyUsages) {
      return new Promise(function(resolve, reject) {
        var unwrapName = typeof unwrapAlgorithm === 'string' ? unwrapAlgorithm : unwrapAlgorithm.name;
        checkUsage(unwrappingKey, 'unwrapKey');

        if (unwrapName === 'AES-KW') {
          if (format !== 'raw') {
            reject(new DOMException('AES-KW supports raw format only', 'NotSupportedError'));
            return;
          }
          if (typeof pal.nativeAesKwUnwrap !== 'function') {
            reject(new DOMException('Crypto extension not available', 'NotSupportedError'));
            return;
          }
          try {
            var keyBytes = new Uint8Array(pal.nativeAesKwUnwrap(unwrappingKey._data, toUint8Array(wrappedKey)));
            resolve(new CryptoKey('secret', unwrappedKeyAlgorithm, extractable, keyUsages, keyBytes));
          } catch (e) { reject(e); }
          return;
        }

        if (unwrapName !== 'AES-GCM' && unwrapName !== 'AES-CBC') {
          reject(new DOMException('Unsupported unwrap algorithm: ' + unwrapName, 'NotSupportedError'));
          return;
        }
        if (typeof pal.nativeAesDecrypt !== 'function') {
          reject(new DOMException('Crypto extension not available', 'NotSupportedError'));
          return;
        }

        var plaintext;
        try {
          if (unwrapName === 'AES-GCM') {
            var iv = toUint8Array(unwrapAlgorithm.iv);
            var aad = unwrapAlgorithm.additionalData ? toUint8Array(unwrapAlgorithm.additionalData) : undefined;
            var tagLen = validateGcmTagLength(unwrapAlgorithm.tagLength);
            plaintext = pal.nativeAesDecrypt(toUint8Array(wrappedKey), unwrappingKey._data, iv, 'AES-GCM', aad, tagLen);
          } else {
            var iv = toUint8Array(unwrapAlgorithm.iv);
            plaintext = pal.nativeAesDecrypt(toUint8Array(wrappedKey), unwrappingKey._data, iv, 'AES-CBC');
          }
        } catch (e) {
          reject(e);
          return;
        }

        try {
          if (format === 'raw') {
            resolve(new CryptoKey('secret', unwrappedKeyAlgorithm, extractable, keyUsages, new Uint8Array(plaintext)));
            return;
          }
          if (format === 'jwk') {
            var json = JSON.parse(new TextDecoder().decode(plaintext));
            if (!json || !json.k) {
              reject(new DOMException('Invalid JWK', 'DataError'));
              return;
            }
            resolve(new CryptoKey('secret', unwrappedKeyAlgorithm, extractable, keyUsages, base64UrlDecode(json.k)));
            return;
          }
        } catch (e) {
          reject(e);
          return;
        }

        reject(new DOMException('Unsupported unwrap format: ' + format, 'NotSupportedError'));
      });
    }

    deriveBits(algorithm, key, length, skipUsage) {
      return new Promise(function(resolve, reject) {
        var algoName = typeof algorithm === 'string' ? algorithm : algorithm.name;
        /* length 必须是 8 的倍数且非负 */
        if (typeof length !== 'number' || length < 0 || length % 8 !== 0) {
          reject(new DOMException('Invalid deriveBits length', 'OperationError'));
          return;
        }
        if (!skipUsage) checkUsage(key, 'deriveBits');

        if (algoName === 'PBKDF2') {
          var salt = toUint8Array(algorithm.salt);
          var iterations = algorithm.iterations;
          /* PBKDF2 hash 必需（不再默认 SHA-1）；iterations 正整数 */
          var hashAlgo = algorithm.hash ? (typeof algorithm.hash === 'string' ? algorithm.hash : algorithm.hash.name) : undefined;
          if (!hashAlgo) { reject(new TypeError('hash required for PBKDF2')); return; }
          if (!Number.isInteger(iterations) || iterations < 1) {
            reject(new DOMException('Invalid iterations value', 'OperationError'));
            return;
          }

          if (typeof pal.nativePbkdf2 !== 'function') {
            reject(new DOMException('Crypto extension not available', 'NotSupportedError'));
            return;
          }

          try {
            var dkLen = Math.ceil(length / 8);
            var result = pal.nativePbkdf2(key._data, salt, iterations, hashAlgo, dkLen);
            resolve(toArrayBuffer(result));
          } catch (e) {
            reject(e);
          }
          return;
        }
        if (algoName === 'HKDF') {
          var salt = algorithm.salt ? toUint8Array(algorithm.salt) : new Uint8Array(0);
          var info = algorithm.info ? toUint8Array(algorithm.info) : new Uint8Array(0);
          var hashAlgo = algorithm.hash ? (typeof algorithm.hash === 'string' ? algorithm.hash : algorithm.hash.name) : undefined;
          if (!hashAlgo) { reject(new TypeError('hash required for HKDF')); return; }

          if (typeof pal.nativeHkdf !== 'function') {
            reject(new DOMException('Crypto extension not available', 'NotSupportedError'));
            return;
          }

          try {
            var dkLen = Math.ceil(length / 8);
            var result = pal.nativeHkdf(hashAlgo, key._data, salt, info, dkLen);
            resolve(toArrayBuffer(result));
          } catch (e) {
            reject(e);
          }
          return;
        }

        if (algoName === 'ECDH') {
          if (key.type !== 'private') {
            reject(new DOMException('ECDH requires a private key', 'InvalidAccessError'));
            return;
          }
          var pub = algorithm.public;
          if (!pub || pub.type !== 'public') {
            reject(new TypeError('public key required for ECDH'));
            return;
          }
          if (typeof pal.nativeEcdh !== 'function') {
            reject(new DOMException('Crypto extension not available', 'NotSupportedError'));
            return;
          }

          try {
            var secret = pal.nativeEcdh(key.algorithm.namedCurve, key._data, pub._data);
            resolve(toArrayBuffer(secret));
          } catch (e) {
            reject(e);
          }
          return;
        }

        reject(new DOMException('Unsupported algorithm: ' + algoName, 'NotSupportedError'));
      });
    }

    deriveKey(algorithm, key, derivedKeyType, extractable, keyUsages) {
      var self = this;
      return new Promise(function(resolve, reject) {
        checkUsage(key, 'deriveKey');
        var bitsLength = (typeof derivedKeyType === 'string' ? 256 : (derivedKeyType.length || 256));
        self.deriveBits(algorithm, key, bitsLength, true).then(function(bits) {
          var data = new Uint8Array(bits);
          var algoName = typeof derivedKeyType === 'string' ? derivedKeyType : derivedKeyType.name;
          resolve(new CryptoKey('secret', { name: algoName }, extractable, keyUsages, data));
        }, reject);
      });
    }
  }

  // ================================================================
  // Wire up crypto.subtle
  // ================================================================

  if (!globalThis.crypto) {
    globalThis.crypto = {};
  }

  globalThis.crypto.subtle = new SubtleCrypto();
  globalThis.CryptoKey = CryptoKey;
  globalThis.SubtleCrypto = SubtleCrypto;
}
