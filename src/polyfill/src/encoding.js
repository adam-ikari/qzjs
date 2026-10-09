/**
 * qzjs polyfill: atob / btoa
 *
 * Encoding/decoding fully delegated to the native textcodec primitives
 * (nativeBtoa/nativeAtob); only validation stays in JS.
 *
 * Implements the standard atob() and btoa() functions as defined in
 * the HTML Living Standard.
 */

export function setupEncoding(pal) {

  globalThis.btoa = function(binaryString) {
    if (binaryString === null || binaryString === undefined) {
      throw new TypeError('btoa requires a string argument');
    }

    binaryString = String(binaryString);

    /* Latin1 范围校验（>0xFF 抛 InvalidCharacterError，规范语义）。
     * 编码全委托 C 原语 nativeBtoa（textcodec 扩展，注册晚于 polyfill 注入，
     * 须每次探测），实现即 WHATWG btoa 语义：逐 UTF-16 码元取低 8 位为
     * 字节做 Base64。JS 查表平行实现已删，扩展被 QZ_WITH_TEXTCODEC=OFF
     * 关掉时直接抛 TypeError（无 JS 回退）。 */
    for (let i = 0; i < binaryString.length; i++) {
      if (binaryString.charCodeAt(i) > 255) {
        if (typeof DOMException === 'function') {
          throw new DOMException(
            "Failed to execute 'btoa': The string to be encoded contains characters outside of the Latin1 range.",
            'InvalidCharacterError');
        }
        throw new Error(
          "Failed to execute 'btoa': The string to be encoded contains characters outside of the Latin1 range."
        );
      }
    }

    if (typeof pal.nativeBtoa !== 'function') {
      throw new TypeError('btoa unavailable: rebuild with QZ_WITH_TEXTCODEC=ON');
    }
    return pal.nativeBtoa(binaryString);
  };

  globalThis.atob = function(base64String) {
    if (base64String === null || base64String === undefined) {
      throw new TypeError('atob requires a string argument');
    }

    base64String = String(base64String);
    base64String = base64String.replace(/\s/g, '');

    if (base64String.length % 4 !== 0) {
      throw new Error(
        "Failed to execute 'atob': The string to be decoded is not correctly encoded."
      );
    }

    /* '=' 只能作为尾部 padding（最多两个、位置正确）；非法 base64 → 抛错。
     * 前置校验在委托前执行：C 版 nativeAtob 只做宽松校验（非法 padding
     * 组合如 "=A==" 不报错），严格语义以 JS 为准。 */
    const validChars = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    if (!validChars.test(base64String)) {
      if (typeof DOMException === 'function') {
        throw new DOMException(
          "Failed to execute 'atob': The string to be decoded is not correctly encoded.",
          'InvalidCharacterError');
      }
      throw new Error(
        "Failed to execute 'atob': The string to be decoded is not correctly encoded."
      );
    }

    /* 解码全委托 C 原语 nativeAtob（同 btoa，须每次探测）。
     * QZ_WITH_TEXTCODEC=OFF 时无 JS 回退，直接抛 TypeError。 */
    if (typeof pal.nativeAtob !== 'function') {
      throw new TypeError('atob unavailable: rebuild with QZ_WITH_TEXTCODEC=ON');
    }
    return pal.nativeAtob(base64String);
  };
}
