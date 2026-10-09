/**
 * qzjs Polyfill Bundle - Main Entry Point
 *
 * This is the entry point for the esbuild bundler.
 * All modules are imported and their setup functions called with the `pal`
 * parameter, which is the IIFE closure parameter injected by the C bridge
 * layer via `__native_inject__`.
 *
 * The build script wraps the bundled output in:
 *   (function(pal){ ... })(__native_inject__);
 *
 * PAL Primitives Available:
 *   pal.timeNow() -> number (ms timestamp)
 *   pal.log(level, msg) -> void (0=debug, 1=info, 2=warn, 3=error)
 *   pal.timerStart(delay_ms, repeat) -> {handle: number, promise: Promise}
 *   pal.timerStop(handle) -> void
 *   pal.httpRequest(url, method, headers_json, body) -> Promise<string>
 *   pal.fsRead(path) -> Promise<string>
 *   pal.fsWrite(path, data) -> Promise<void>
 *   pal.fsReadSync(path) -> string (sync, throws if missing)
 *   pal.fsWriteSync(path, data) -> void (sync, atomic temp+rename)
 *   pal.localStoragePath() -> string (QZ_LOCALSTORAGE_FILE or ~/.qzjs/localstorage.json)
 *   pal.fsExists(path) -> Promise<boolean>
 *   pal.fsRemove(path) -> Promise<void>
 *   pal.fsList(path) -> Promise<string> (JSON array)
 *   pal.storageGet(key) -> Promise<string|null>
 *   pal.storageSet(key, value) -> Promise<void>
 *   pal.storageDel(key) -> Promise<void>
 *
 * Lazy 化（设计文档 2026-09-09-polyfill-lazy-init.md）：
 *   14 eager + 17 lazy = 31 个 setup 调用。核心/薄模块 eager（直接 setup
 *   调用，行为与历史一致）；重量级/场景专属模块 lazy——经 lazy.js 的 lazyUnit
 *   注册成"首次访问才 setup"的 getter。所有 lazy 注册必须在 setupContext
 *   （_pristine 快照）之前完成（§3.6），且对 JS 消费者与 eager 逐位等价
 *   （§2.5 消费者无感契约，test/test_polyfill_lazy_gtest.cpp 钉住）。
 *
 * 级联（§2.3）：F→S→B；W→M；SW→W→M；WS→CS；serve→G（serve() 首次执行读
 * qzjs.http2 触发）。eager 主线保证 lazy 全部前提就绪。
 */

import { pal } from './pal.js';
import { lazyUnit } from './lazy.js';
import { setupConsole } from './console.js';
import { setupPerformance } from './performance.js';
import { setupTimers } from './timers.js';
import { setupEventTarget } from './event-target.js';
import { setupAbort } from './abort.js';
import { setupURL } from './url.js';
import { setupEncoding } from './encoding.js';
import { setupFetch } from './fetch.js';
import { setupFS } from './fs.js';
import { setupStorage } from './storage.js';
import { setupLocalStorage } from './local-storage.js';
import { setupTextEncoding } from './text-encoding.js';
import { setupCrypto } from './crypto.js';
import { setupErrorEvents } from './error-events.js';
import { setupMessageChannel } from './message-channel.js';
import { setupBroadcastChannel } from './broadcast-channel.js';
import { setupCacheStorage } from './cache-storage.js';
import { setupEventSource } from './event-source.js';
import { setupWebSocket } from './websocket.js';
import { setupHttpServer } from './http-server.js';
import { setupHostMessaging } from './host-messaging.js';
import { setupStreams } from './streams.js';
import { setupBlobFileFormData } from './blob-file-formdata.js';
import { setupURLPattern } from './url-pattern.js';
import { setupNavigatorReportError } from './navigator.js';
import { setupCryptoSubtle } from './crypto-subtle.js';
import { setupStructuredClone } from './structured-clone.js';
import { setupServiceWorker } from './service-worker.js';
import { setupWorker } from './worker.js';
import { setupContext } from './context.js';
// Virtual module: build.js aliases this to the real gRPC/HTTP2 stack when
// QZ_WITH_GRPC=1, or to an empty stub when it is 0 — which is what keeps
// http2/hpack/protobuf/grpc out of the default bundle.
import { setupGrpcStack } from '@qzjs/grpc-stack';

// ================================================================
// 宿主对象 eager 空壳（设计 §3.2）：globalThis.qzjs 全局对象替代原
// fs.js/storage.js/http2.js/grpc.js 各自的 `if (!globalThis.qzjs)` 就地创建。
// qzjs.fs / qzjs.storage / qzjs.http2 子属性均为 lazy getter（见下）。
// ================================================================

globalThis.qzjs = {};

// ================================================================
// Eager（14 单元，启动即 setup）——设计 §2.2
// 注意顺序约束：navigator/crypto 必须先于其 lazy 子属性 getter 注册
// （navigator.serviceWorker / crypto.subtle）；context 必须最后（快照）。
// ================================================================

setupConsole(pal);
setupEventTarget();
setupAbort();
setupErrorEvents();
setupPerformance(pal);
setupTimers(pal);
setupURL();
setupEncoding(pal);
setupTextEncoding(pal);
setupNavigatorReportError();
setupCrypto(pal);
setupHostMessaging(pal);
setupStructuredClone();

// ================================================================
// Lazy（17 单元，首次访问触发）——设计 §2.3
// 全部注册必须在 setupContext 之前完成（§3.6：_pristine 快照把 lazy 名
// 全部收录，挂起捕获天然跳过）。ensure 互相级联（F→S/B、W→M、SW→W、
// WS→CS、serve→G）。
// ================================================================

/* M — message-channel（MessageEvent 被 host-messaging dispatch 触发） */
var ensureM = lazyUnit(
  ['MessageChannel', 'MessagePort', 'MessageEvent',
   '__qz_lookup_port__', '__qz_port_from_ref__',
   '__qz_port_frame_op__', '__qz_route_port_message__',
   '__qz_port_xfer_frame__', '__qz_port_frame_body__',
   '__qz_endpoint_dead__'],
  [],
  function () { setupMessageChannel(pal); });

/* S — streams（17 个流 API，一次 setup） */
var ensureS = lazyUnit(
  ['ReadableStream', 'ReadableStreamDefaultController', 'ReadableStreamDefaultReader',
   'ReadableByteStreamController', 'ReadableStreamBYOBReader', 'ReadableStreamBYOBRequest',
   'WritableStream', 'WritableStreamDefaultController', 'WritableStreamDefaultWriter',
   'TransformStream', 'TransformStreamDefaultController',
   'ByteLengthQueuingStrategy', 'CountQueuingStrategy',
   'CompressionStream', 'DecompressionStream', 'TextEncoderStream', 'TextDecoderStream'],
  [],
  function () { setupStreams(pal); });

/* B — blob / file / formdata */
var ensureB = lazyUnit(
  ['Blob', 'File', 'FormData'],
  [],
  function () { setupBlobFileFormData(); });

/* F — fetch（级联 S → B） */
lazyUnit(
  ['fetch', 'Headers', 'Request', 'Response'],
  [],
  function () { ensureS(); ensureB(); setupFetch(pal); });

/* W — worker（级联 M） */
var ensureW = lazyUnit(
  ['Worker', '__qz_worker_post__'],
  [],
  function () { ensureM(); setupWorker(pal); });

/* SW — service-worker（子属性 getter，级联 W → M） */
lazyUnit(
  [],
  [[globalThis.navigator, 'serviceWorker']],
  function () { ensureW(); setupServiceWorker(pal); });

/* G — grpc-stack（grpc/protobuf 全局 + qzjs.http2 子属性，注册式）：
 * QZ_WITH_GRPC=OFF 时 grpc-stack-stub.js 的 setupGrpcStack 为空函数 →
 * 无任何 getter、API 不存在（与现状一致）。 */
setupGrpcStack();

/* C — cache-storage（Cache/CacheStorage/caches 共享一次 setup） */
lazyUnit(
  ['Cache', 'CacheStorage', 'caches'],
  [],
  function () { setupCacheStorage(); });

/* CS — crypto.subtle 子属性 + CryptoKey/SubtleCrypto 全局（共享一次 setup）
 * 惰性钩子对齐：setupCryptoSubtle 只注册 pal.__installCryptoSubtle__，
 * 实际安装由 crypto 扩展（QZ_WITH_CRYPTO_EXT）的 init 钩子调用。lazy 下
 * 扩展 init 跑在 polyfill 注入之后、本 ensure 之前——native 钩子已就位但
 * installer 未注册，故此处先 setupCryptoSubtle 再自行补调 installer（仅当
 * 扩展存在，以 pal.nativeDigest 判定）；扩展缺席时恢复 eager 语义
 * （crypto.subtle 保持 undefined 数据属性）。 */
var ensureCS = lazyUnit(
  ['CryptoKey', 'SubtleCrypto'],
  [[globalThis.crypto, 'subtle']],
  function () {
    setupCryptoSubtle(pal);
    if (typeof pal.nativeDigest === 'function' &&
        typeof pal.__installCryptoSubtle__ === 'function') {
      pal.__installCryptoSubtle__();
    } else if (!('subtle' in globalThis.crypto)) {
      globalThis.crypto.subtle = undefined;   /* 扩展缺席：恢复 eager own-prop */
    }
  });

/* WS — websocket（级联 CS，握手 SHA-1 用 crypto.subtle） */
lazyUnit(
  ['WebSocket', 'CloseEvent'],
  [],
  function () { ensureCS(); setupWebSocket(pal); });

/* ES — event-source */
lazyUnit(
  ['EventSource'],
  [],
  function () { setupEventSource(pal); });

/* BC — broadcast-channel */
lazyUnit(
  ['BroadcastChannel'],
  [],
  function () { setupBroadcastChannel(); });

/* UP — url-pattern */
lazyUnit(
  ['URLPattern'],
  [],
  function () { setupURLPattern(); });

/* serve — HTTP/1 server（首次执行读 qzjs.http2 触发 G 级联） */
lazyUnit(
  ['serve'],
  [],
  function () { setupHttpServer(pal); });

/* FS — qzjs.fs 子属性 */
lazyUnit(
  [],
  [[globalThis.qzjs, 'fs']],
  function () { setupFS(pal); });

/* ST — qzjs.storage 子属性 */
lazyUnit(
  [],
  [[globalThis.qzjs, 'storage']],
  function () { setupStorage(pal); });

/* LS — local-storage / session-storage（同一 setup 物化两域） */
lazyUnit(
  ['localStorage', 'sessionStorage'],
  [],
  function () { setupLocalStorage(pal); });

// ================================================================
// Multi-context + soft suspend/resume（必须最后：_pristine 快照收录全部
// lazy getter 名——挂起捕获只抓快照之后新增的键）
// ================================================================

setupContext(pal);
