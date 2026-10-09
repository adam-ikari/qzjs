/**
 * qzjs polyfill: Streams API
 *
 * 三大流类全套（ReadableStream / WritableStream / TransformStream 及其
 * 控制器、Reader / Writer、两个 QueuingStrategy）委托
 * web-streams-polyfill@4.3.0（https://github.com/MattiasBuelens/web-streams-polyfill，
 * MIT，零依赖）。走 ponyfill 入口（主入口导出即纯工厂、无 globalThis 副作用），
 * 保住 qzjs 的 lazy 加载语义。
 *
 * 保留自研（wsp 不含）：
 *   - CompressionStream / DecompressionStream：委托 pal.nativeCompress /
 *     pal.nativeDecompress（C 扩展 miniz）
 *   - TextEncoderStream / TextDecoderStream：Encoding 规范，非 streams 规范
 *
 * 依赖：EventTarget（AbortSignal）——背压、pipeTo({signal}) 中止、tee、BYOB
 * 全按 WHATWG 规范由 wsp 提供（自研为简化实现，含已知排队/背压边界缺口）。
 *
 * 行为差异（自研 → wsp）：
 *   - 排队/背压、BYOB、tee、cancel/abort 语义补全为规范行为
 *   - 控制器经 start(c) 捕获供 shim 使用（不再直取流内部字段）
 *   - 体积（minified）：18.2KB → 62.1KB（+43.9KB）
 */

import {
  ReadableStream,
  ReadableStreamDefaultController,
  ReadableStreamDefaultReader,
  ReadableByteStreamController,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
  WritableStream,
  WritableStreamDefaultController,
  WritableStreamDefaultWriter,
  TransformStream,
  TransformStreamDefaultController,
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
} from 'web-streams-polyfill';

export function setupStreams(pal) {

  // ================================================================
  // CompressionStream / DecompressionStream
  //
  // Native compression/decompression via pal.nativeCompress /
  // pal.nativeDecompress (registered by the compress extension).
  // If the extension is not loaded, these classes throw.
  //
  // 两 class 共享同一骨架（DRY）：write 攒 chunk，close 一次 native 调用，
  // 结果 enqueue 进 readable 后关闭。控制器经 start(c) 捕获，不依赖流内部字段。
  // ================================================================

  function makeNativeStream(name, nativeFn, missingMsg) {
    class NativeStream {
      constructor(format) {
        format = format || 'gzip';
        if (format !== 'gzip' && format !== 'deflate' && format !== 'deflate-raw') {
          throw new Error(name + ': unsupported format: ' + format);
        }
        this._format = format;

        var chunks = [];
        var readableController;
        var self = this;

        self._readable = new ReadableStream({
          start: function (c) { readableController = c; }
        });

        self._writable = new WritableStream({
          write: function (chunk) {
            chunks.push(chunk);
            return Promise.resolve();
          },
          close: function () {
            // Concatenate all chunks
            var totalLen = 0;
            for (var i = 0; i < chunks.length; i++) {
              totalLen += chunks[i].length || chunks[i].byteLength || 0;
            }
            var combined = new Uint8Array(totalLen);
            var offset = 0;
            for (var i = 0; i < chunks.length; i++) {
              var c = chunks[i] instanceof Uint8Array ? chunks[i] : new Uint8Array(chunks[i]);
              combined.set(c, offset);
              offset += c.length;
            }

            if (typeof nativeFn !== 'function') {
              readableController.error(new TypeError(missingMsg));
              return Promise.resolve();
            }

            try {
              readableController.enqueue(nativeFn(combined, self._format));
              readableController.close();
            } catch (e) {
              readableController.error(e);
            }
            return Promise.resolve();
          }
        });
      }

      get readable() { return this._readable; }
      get writable() { return this._writable; }
    }
    return NativeStream;
  }

  const CompressionStream = makeNativeStream(
    'CompressionStream', pal.nativeCompress,
    'Native compression extension not available');
  const DecompressionStream = makeNativeStream(
    'DecompressionStream', pal.nativeDecompress,
    'Native decompression extension not available');

  // ================================================================
  // TextEncoderStream / TextDecoderStream
  //
  // 基于自有 TextEncoder/TextDecoder（text-encoding.js），读写侧用 wsp 流。
  // ================================================================

  class TextEncoderStream {
    constructor() {
      this.encoding = 'utf-8';

      var self = this;
      var readableController;
      self._readable = new ReadableStream({
        start: function (c) { readableController = c; }
      });

      self._writable = new WritableStream({
        write: function (chunk) {
          if (typeof chunk === 'string') {
            readableController.enqueue(new TextEncoder().encode(chunk));
          } else {
            readableController.enqueue(chunk);
          }
          return Promise.resolve();
        },
        close: function () {
          readableController.close();
          return Promise.resolve();
        }
      });
    }

    get readable() { return this._readable; }
    get writable() { return this._writable; }
  }

  class TextDecoderStream {
    constructor(label, options) {
      label = label || 'utf-8';
      options = options || {};
      this.encoding = label.toLowerCase();
      this.fatal = options.fatal || false;
      this.ignoreBOM = options.ignoreBOM || false;

      var decoder = new TextDecoder(label, { fatal: this.fatal, ignoreBOM: this.ignoreBOM });
      var self = this;
      var readableController;
      self._readable = new ReadableStream({
        start: function (c) { readableController = c; }
      });

      self._writable = new WritableStream({
        write: function (chunk) {
          var decoded;
          try {
            decoded = decoder.decode(chunk, { stream: true });
          } catch (e) {
            /* fatal 解码错误：error readable（规范 TextDecoderStream） */
            try { readableController.error(e); } catch (x) {}
            throw e;
          }
          if (decoded) {
            readableController.enqueue(decoded);
          }
          return Promise.resolve();
        },
        close: function () {
          var decoded;
          try {
            decoded = decoder.decode();
          } catch (e) {
            try { readableController.error(e); } catch (x) {}
            throw e;
          }
          if (decoded) {
            readableController.enqueue(decoded);
          }
          readableController.close();
          return Promise.resolve();
        }
      });
    }

    get readable() { return this._readable; }
    get writable() { return this._writable; }
  }

  // ================================================================
  // Global registration
  // ================================================================

  globalThis.ReadableStream = ReadableStream;
  globalThis.ReadableStreamDefaultController = ReadableStreamDefaultController;
  globalThis.ReadableStreamDefaultReader = ReadableStreamDefaultReader;
  globalThis.ReadableByteStreamController = ReadableByteStreamController;
  globalThis.ReadableStreamBYOBReader = ReadableStreamBYOBReader;
  globalThis.ReadableStreamBYOBRequest = ReadableStreamBYOBRequest;
  globalThis.WritableStream = WritableStream;
  globalThis.WritableStreamDefaultController = WritableStreamDefaultController;
  globalThis.WritableStreamDefaultWriter = WritableStreamDefaultWriter;
  globalThis.TransformStream = TransformStream;
  globalThis.TransformStreamDefaultController = TransformStreamDefaultController;
  globalThis.ByteLengthQueuingStrategy = ByteLengthQueuingStrategy;
  globalThis.CountQueuingStrategy = CountQueuingStrategy;
  globalThis.CompressionStream = CompressionStream;
  globalThis.DecompressionStream = DecompressionStream;
  globalThis.TextEncoderStream = TextEncoderStream;
  globalThis.TextDecoderStream = TextDecoderStream;
}