/**
 * qzjs polyfill: no-op stand-in for the gRPC/HTTP2 stack.
 *
 * build.js aliases `@qzjs/grpc-stack` here whenever QZ_WITH_GRPC is off, so
 * none of grpc.js / http2.js / hpack.js / protobuf.js enters
 * the module graph. Keep this file dependency-free — importing anything from
 * the stack would defeat its purpose.
 */

export function setupGrpcStack() {}
