/* in-module 跨界 ABI 原型宿主驱动（对应 IN_MODULE_DESIGN.md §10）
 *
 * 用 vendored WAMR (libiwasm.a) 加载 guest.wasm，注册 qz_host.* natives，
 * 验证：
 *   (1) guest 经 import 调宿主（greet → qz_host.log）
 *   (2) 回流形态：pull_now → qz_host.now → 写回内存 → host 侧读回
 *
 * §10.4 的"import 拉"模型：host 不持 JSValue，只搬字节。此原型无 JS。
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include "wasm_export.h"

/* ---- 宿主能力实现（§10.3 原语） ---- */

/* qz_host.log(level, ptr, len) —— 从 wasm 内存读字节，不碰 JSValue */
static void host_log(wasm_exec_env_t exec_env, int32_t level, int32_t ptr, int32_t len)
{
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
    const char *src = (const char *)wasm_runtime_addr_app_to_native(inst, (uint64_t)ptr);
    if (!src || len < 0) return;
    FILE *out = (level >= 1) ? stderr : stdout;
    fprintf(out, "[qz_host.log] ");
    fwrite(src, 1, (size_t)len, out);
    fflush(out);
}

/* qz_host.now() -> i64 —— 宿主时钟（模拟 uv_now / uv_hrtime） */
static int64_t host_now(wasm_exec_env_t exec_env)
{
    (void)exec_env;
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* 注册表：逻辑名 → 实现 + WAMR 签名串 */
static NativeSymbol qz_host_natives[] = {
    { "log", (void *)host_log, "(iii)", NULL },
    { "now", (void *)host_now, "()I",   NULL },  /* I = i64 */
};

int main(int argc, char **argv)
{
    const char *wasm_path = (argc > 1) ? argv[1] : "guest.wasm";
    char err[256];

    /* 读 wasm 文件 */
    FILE *f = fopen(wasm_path, "rb");
    if (!f) { fprintf(stderr, "open %s: %m\n", wasm_path); return 1; }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *buf = malloc((size_t)n);
    if (fread(buf, 1, (size_t)n, f) != (size_t)n) { fprintf(stderr, "read failed\n"); return 1; }
    fclose(f);

    /* 初始化 WAMR + 注册 natives（§10.3：import module 名 "qz_host"） */
    RuntimeInitArgs init;
    memset(&init, 0, sizeof(init));
    init.mem_alloc_type = Alloc_With_System_Allocator;
    if (!wasm_runtime_full_init(&init)) {
        fprintf(stderr, "wasm_runtime_full_init failed\n");
        return 1;
    }
    if (!wasm_runtime_register_natives("qz_host", qz_host_natives,
                                       sizeof(qz_host_natives) / sizeof(qz_host_natives[0]))) {
        fprintf(stderr, "register_natives qz_host failed: %s\n", err);
        return 1;
    }

    /* 加载 + 实例化 */
    wasm_module_t module = wasm_runtime_load(buf, (uint32_t)n, err, sizeof(err));
    if (!module) { fprintf(stderr, "load failed: %s\n", err); return 1; }
    wasm_module_inst_t inst = wasm_runtime_instantiate(module, 8192, 8192, err, sizeof(err));
    if (!inst) { fprintf(stderr, "instantiate failed: %s\n", err); return 1; }
    wasm_exec_env_t env = wasm_runtime_create_exec_env(inst, 8192);
    if (!env) { fprintf(stderr, "create_exec_env failed\n"); return 1; }

    /* ---- 验证 1：同步跨界调宿主 log ---- */
    printf("=== 验证 1: guest → qz_host.log ===\n");
    wasm_function_inst_t greet = wasm_runtime_lookup_function(inst, "greet");
    if (!greet) { fprintf(stderr, "lookup greet failed\n"); return 1; }
    if (!wasm_runtime_call_wasm(env, greet, 0, NULL)) {
        fprintf(stderr, "call greet failed: %s\n", wasm_runtime_get_exception(inst));
        return 1;
    }
    printf("  → greet 调用成功（上方 stderr 应见 'hello from wasm guest'）\n");

    /* ---- 验证 2：回流形态（host 值 → wasm 内存 → host 读回） ---- */
    printf("=== 验证 2: guest 调 qz_host.now 并写回内存 ===\n");
    wasm_function_inst_t pull = wasm_runtime_lookup_function(inst, "pull_now");
    if (!pull) { fprintf(stderr, "lookup pull_now failed\n"); return 1; }
    uint32_t results[1] = {0};
    if (!wasm_runtime_call_wasm(env, pull, 0, results)) {
        fprintf(stderr, "call pull_now failed: %s\n", wasm_runtime_get_exception(inst));
        return 1;
    }
    int32_t buf_ptr = (int32_t)results[0];
    int64_t *t = (int64_t *)wasm_runtime_addr_app_to_native(inst, (uint64_t)buf_ptr);
    printf("  → pull_now 返回 buf_ptr=%d, 读回 i64 now=%lld\n", buf_ptr, (long long)*t);
    printf("  → host 侧从 wasm 内存读到值（无 JSValue，纯字节）\n");

    printf("\nOK: 跨界 ABI 原型两条路径均通\n");

    wasm_runtime_destroy_exec_env(env);
    wasm_runtime_deinstantiate(inst);
    wasm_runtime_unload(module);
    wasm_runtime_destroy();
    free(buf);
    return 0;
}
