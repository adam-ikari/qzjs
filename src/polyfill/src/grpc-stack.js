/**
 * qzjs polyfill: the gRPC/HTTP2 stack, as one swappable wiring unit.
 *
 * `index.js` imports this through the virtual specifier `@qzjs/grpc-stack`,
 * which polyfill/build.js aliases here when QZ_WITH_GRPC=1 and to
 * grpc-stack-stub.js when it is 0. Aliasing (rather than a runtime `if`) is
 * what actually keeps http2/hpack/protobuf/grpc out of the default
 * bundle: esbuild does not delete `if (false)` bodies unless it minifies, so a
 * guarded call would still ship ~3.5k lines.
 *
 * Serialization policy: protobuf is the only codec, so a qzjs client talks to
 * any standard gRPC peer (grpc-go, grpc-js, grpcurl, Envoy). Flatbuffers was
 * retired from the JS layer (see grpc.js header / ROADMAP H5).
 */

import { pal } from './pal.js';
import { lazyUnit } from './lazy.js';
import { setupHttp2 } from './http2.js';
import { setupHttp2Server } from './http2-server.js';
import { setupProtobuf } from './protobuf.js';
import { setupGrpc } from './grpc.js';
import { setupGrpcServer } from './grpc-server.js';

/**
 * G 单元（lazy 注册式，设计 §3.4）：把 setupGrpcStack 职责从"执行"改为
 * "注册惰性组"。grpc / protobuf / qzjs.http2 三个挂载面共享一次 setup——
 * 首次访问其中任一触发 5 个子 setup（保持既有顺序）。
 *
 * QZ_WITH_GRPC=OFF 时 index.js 引的是 grpc-stack-stub.js（空函数）→ 本
 * 模块整体不进 bundle → 无任何 getter 注册 → grpc.xxx 直接 ReferenceError，
 * 与现状一致（OFF 零字节承诺不破）。
 */
export function setupGrpcStack() {
  lazyUnit(
    ['grpc', 'protobuf'],
    [[globalThis.qzjs, 'http2']],
    function () {
      setupHttp2(pal);
      setupHttp2Server(pal);
      setupProtobuf(pal);
      setupGrpc(pal);
      setupGrpcServer(pal);
    });
}

