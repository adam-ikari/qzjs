/**
 * qzjs Polyfill - Crypto interface
 *
 * Provides crypto.getRandomValues() and crypto.randomUUID().
 * Uses pal.randomBytes() for cryptographically secure random generation.
 *
 * Exposes the Crypto interface per ECMA-429 (WEBCRYPTO): the `Crypto`
 * constructor is available as globalThis.Crypto and the instance as
 * globalThis.crypto (crypto.subtle is filled in by crypto-subtle.js).
 */

export function setupCrypto(pal) {
  class Crypto {
    constructor() {
      this.subtle = undefined;  /* filled by setupCryptoSubtle */
    }

    getRandomValues(typedArray) {
      if (!(typedArray instanceof Uint8Array) &&
          !(typedArray instanceof Uint16Array) &&
          !(typedArray instanceof Uint32Array) &&
          !(typedArray instanceof Int8Array) &&
          !(typedArray instanceof Int16Array) &&
          !(typedArray instanceof Int32Array)) {
        throw new TypeError('Argument must be a TypedArray');
      }

      var totalBytes = typedArray.length * typedArray.BYTES_PER_ELEMENT;
      /* Web Crypto spec caps getRandomValues at 65536 bytes — enforced here
       * in JS, not in the C bridge (the bridge does only data conversion). */
      if (totalBytes > 65536) {
        throw new DOMException('getRandomValues: requested length exceeds 65536 bytes', 'QuotaExceededError');
      }
      var ab = pal.randomBytes(totalBytes);
      var src = new Uint8Array(ab);

      // Copy bytes into the typed array
      var dst = new Uint8Array(typedArray.buffer, typedArray.byteOffset, totalBytes);
      dst.set(src);

      return typedArray;
    }

    randomUUID() {
      // Version 4 UUID using getRandomValues
      var bytes = new Uint8Array(16);
      this.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0F) | 0x40;  // version 4
      bytes[8] = (bytes[8] & 0x3F) | 0x80;  // variant 1
      var hex = Array.from(bytes, function(b) { return b.toString(16).padStart(2, '0'); }).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    }
  }

  globalThis.crypto = new Crypto();
  globalThis.Crypto = Crypto;
}
