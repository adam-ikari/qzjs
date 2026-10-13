/* in-module 跨界税 bench 宿主（§10 性能）
 * 测：guest→host import 往返 vs 纯 wasm 循环。多轮取 min 抗噪。
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include "wasm_export.h"

static int32_t host_noop(wasm_exec_env_t e, int32_t x) { (void)e; return x + 1; }
static int64_t host_now(wasm_exec_env_t e) {
    (void)e; struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t);
    return (int64_t)t.tv_sec*1000000000 + t.tv_nsec;
}
static NativeSymbol qz_host_natives[] = {
    { "noop", (void *)host_noop, "(i)i", NULL },
    { "now",  (void *)host_now,  "()I",  NULL },
};
static double now_ns(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return (double)t.tv_sec*1e9 + (double)t.tv_nsec;
}

int main(int argc, char **argv)
{
    const char *path = (argc > 1) ? argv[1] : "bench.wasm";
    int32_t n = (argc > 2) ? atoi(argv[2]) : 100000;
    char err[256];

    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "open %s: %m\n", path); return 1; }
    fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *buf = malloc((size_t)sz);
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) return 1;
    setvbuf(stdout, NULL, _IONBF, 0);
    fprintf(stderr, "[diag] start\n");
    fclose(f);

    fprintf(stderr, "[diag] init\n");
    RuntimeInitArgs init; memset(&init, 0, sizeof(init));
    init.mem_alloc_type = Alloc_With_System_Allocator;
    wasm_runtime_full_init(&init);
    fprintf(stderr, "[diag] register\n");
    wasm_runtime_register_natives("qz_host", qz_host_natives, 2);

    fprintf(stderr, "[diag] load\n");
    wasm_module_t mod = wasm_runtime_load(buf, (uint32_t)sz, err, sizeof(err));
    if (!mod) { fprintf(stderr, "load: %s\n", err); return 1; }
    fprintf(stderr, "[diag] instantiate\n");
    wasm_module_inst_t inst = wasm_runtime_instantiate(mod, 1<<16, 1<<16, err, sizeof(err));
    if (!inst) { fprintf(stderr, "inst: %s\n", err); return 1; }
    fprintf(stderr, "[diag] exec_env\n");
    wasm_exec_env_t env = wasm_runtime_create_exec_env(inst, 1<<16);
    fprintf(stderr, "[diag] lookup\n");
    wasm_function_inst_t tcross = wasm_runtime_lookup_function(inst, "bench_cross");
    wasm_function_inst_t tnat   = wasm_runtime_lookup_function(inst, "bench_native");
    if (!tcross || !tnat) { fprintf(stderr, "lookup fail\n"); return 1; }
    fprintf(stderr, "[diag] warmup cross\n");

    /* i64 返回值占 2 个 32-bit slot → argv 必须 ≥2 */
    uint32_t cargs[2] = { (uint32_t)n, 0 };
    uint32_t nargs[2] = { (uint32_t)(n / 100 + 1), 0 };   /* native 小 N 抗负载抖动 */

    wasm_runtime_call_wasm(env, tcross, 1, cargs);     /* warmup */
    wasm_runtime_call_wasm(env, tnat,   1, nargs);

    #define ROUNDS 5
    double best_cross = 1e30, best_nat = 1e30;
    for (int r = 0; r < ROUNDS; r++) {
        double a = now_ns();
        if (!wasm_runtime_call_wasm(env, tcross, 1, cargs)) { fprintf(stderr,"cross: %s\n", wasm_runtime_get_exception(inst)); return 1; }
        double b = now_ns();
        if (b - a < best_cross) best_cross = b - a;

        double c = now_ns();
        if (!wasm_runtime_call_wasm(env, tnat, 1, nargs)) { fprintf(stderr,"nat: %s\n", wasm_runtime_get_exception(inst)); return 1; }
        double d = now_ns();
        if (d - c < best_nat) best_nat = d - c;
    }

    double cross_ns = best_cross, native_ns = best_nat;
    long natn = (long)nargs[0];
    printf("N_cross = %d, N_native = %ld\n", n, natn);
    printf("  cross  : %8.3f ms → %8.2f ns/次跨界\n", cross_ns/1e6, cross_ns/n);
    printf("  native : %8.3f ms → %8.2f ns/次循环迭代\n", native_ns/1e6, native_ns/natn);

    wasm_runtime_destroy_exec_env(env);
    wasm_runtime_deinstantiate(inst);
    wasm_runtime_unload(mod);
    wasm_runtime_destroy();
    free(buf);
    return 0;
}
