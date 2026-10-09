/* Polyfill/worker-boot 字节码符号 + 装载接口（polyfill_load.c 的对外面）。
 * 生成文件（polyfill_default.c / worker_boot_default.c）定义这里的 extern 符号。 */
#ifndef QZ_POLYFILL_H
#define QZ_POLYFILL_H

#include "qz_types.h"

/* ── Polyfill bytecode source (mode-dependent) ──
 * The symbols a polyfill_load.c expects are decided by QZ_POLYFILL_MODE.
 * The matching definitions live in the mode's generated file
 * (src/polyfill_default.c for rodata, src/polyfill_<mode>.c otherwise). */

/* C++ 测试（gtest）直接调用 qz_polyfill_load/_unload，须保持 C 链接，
 * 否则被 name-mangling 而链接失败（下方 internal helper 段同款处理）。 */
#ifdef __cplusplus
extern "C" {
#endif
#if QZ_POLYFILL_MODE == QZ_POLYFILL_MODE_RODATA
/* rodata: const array baked into .rodata (default) */
extern const uint8_t qz_default_polyfill[];
extern const size_t qz_default_polyfill_len;
#elif QZ_POLYFILL_MODE == QZ_POLYFILL_MODE_COMPRESSED
/* compressed: lz4-block-compressed array in .rodata; decompressed to heap at
 * load (block produced by build-time tool qz_lz4_compress, same vendored
 * lz4 as the LZ4_decompress_safe decoder) */
extern const uint8_t qz_default_polyfill_compressed[];
extern const size_t qz_default_polyfill_compressed_len;
extern const size_t qz_default_polyfill_orig_len;
#elif QZ_POLYFILL_MODE == QZ_POLYFILL_MODE_EXTERNAL
/* Mode B: no embedded bytecode — loaded from external .polyfill file. The
 * expected SHA-256 of the official bytecode is generated into
 * src/polyfill_external.c by polyfill/build.js (each mode emits its own file,
 * so switching modes never leaves a stale hash behind). Strong symbol on
 * purpose: a weak reference would not pull polyfill_external.o out of the
 * static archive and would bind to address 0 at load. Missing definition →
 * link error that tells the builder to (re)run build.js with this mode. */
extern const uint8_t qz_polyfill_external_sha256[32];
#endif

/* Unified polyfill bytecode loader. Returns 0 on success and sets *out
 * (bytecode pointer), *out_len, *owner (opaque handle for unload;
 * NULL in mode C). Returns a negative qz_err_t on failure. */
int qz_polyfill_load(const uint8_t **out, size_t *out_len, void **owner);
void qz_polyfill_unload(void *owner);

/* Mode D: weak hooks the host may override. Defaults return an error /
 * no-op, so the host must provide them. */
int qz_polyfill_load_custom(const uint8_t **out, size_t *out_len, void **owner);
void qz_polyfill_unload_custom(void *owner);

/* (end polyfill decls) */
#ifdef __cplusplus
}
#endif

/* Worker boot shim bytecode (compiled in from worker_boot_default.c) */
extern const uint8_t qz_default_worker_boot[];
extern const size_t qz_default_worker_boot_len;

#endif /* QZ_POLYFILL_H */
