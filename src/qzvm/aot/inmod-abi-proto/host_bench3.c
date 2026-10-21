/* in-module 跨界税 bench：空 import / 带负载 import / 纯 wasm / C 直调基线 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include "wasm_export.h"

static int32_t host_noop(wasm_exec_env_t e, int32_t x) { (void)e; return x + 1; }

/* 带负载：读 wasm 内存 32B（模拟 pal.log 的 ptr+len 形态） */
static volatile int32_t g_sink;
static int32_t host_sink(wasm_exec_env_t e, int32_t ptr, int32_t len)
{
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(e);
    const char *p = wasm_runtime_addr_app_to_native(inst, (uint64_t)ptr);
    int32_t acc = 0;
    for (int i = 0; i < len; i++) acc += p[i];
    g_sink = acc;
    return acc;
}

/* C 直调基线：同形态普通函数 */
static int32_t c_noop(int32_t x) { return x + 1; }
static int32_t c_sink(const char *p, int32_t len) {
    int32_t acc = 0; for (int i = 0; i < len; i++) acc += p[i]; return acc;
}

static NativeSymbol qz_host_natives[] = {
    { "noop", (void *)host_noop, "(i)i", NULL },
    { "sink", (void *)host_sink, "(ii)i", NULL },
};

static double now_ns(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return (double)t.tv_sec*1e9 + (double)t.tv_nsec;
}

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    const char *path = (argc > 1) ? argv[1] : "bench3.wasm";
    int32_t n = (argc > 2) ? atoi(argv[2]) : 2000000;
    char err[256];

    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "open %s: %m\n", path); return 1; }
    fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *buf = malloc((size_t)sz);
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) return 1;
    fclose(f);

    RuntimeInitArgs init; memset(&init, 0, sizeof(init));
    init.mem_alloc_type = Alloc_With_System_Allocator;
    wasm_runtime_full_init(&init);
    wasm_runtime_register_natives("qz_host", qz_host_natives, 2);

    wasm_module_t mod = wasm_runtime_load(buf, (uint32_t)sz, err, sizeof(err));
    if (!mod) { fprintf(stderr, "load: %s\n", err); return 1; }
    wasm_module_inst_t inst = wasm_runtime_instantiate(mod, 1<<16, 1<<16, err, sizeof(err));
    if (!inst) { fprintf(stderr, "inst: %s\n", err); return 1; }
    wasm_exec_env_t env = wasm_runtime_create_exec_env(inst, 1<<16);

    wasm_function_inst_t tc = wasm_runtime_lookup_function(inst, "bench_cross");
    wasm_function_inst_t tp = wasm_runtime_lookup_function(inst, "bench_payload");
    wasm_function_inst_t tn = wasm_runtime_lookup_function(inst, "bench_native");
    if (!tc || !tp || !tn) { fprintf(stderr, "lookup fail\n"); return 1; }

    uint32_t a[2] = { (uint32_t)n, 0 };

    /* warmup */
    wasm_runtime_call_wasm(env, tc, 1, a);
    wasm_runtime_call_wasm(env, tp, 1, a);
    wasm_runtime_call_wasm(env, tn, 1, a);

    #define ROUNDS 5
    double bc = 1e30, bp = 1e30, bn = 1e30, bcd = 1e30, bpd = 1e30;
    char payload[32]; memcpy(payload, "0123456789abcdef0123456789abcdef", 32);
    for (int r = 0; r < ROUNDS; r++) {
        double t;
        t = now_ns(); wasm_runtime_call_wasm(env, tc, 1, a); double d = now_ns()-t; if (d<bc) bc=d;
        t = now_ns(); wasm_runtime_call_wasm(env, tp, 1, a);       d = now_ns()-t; if (d<bp) bp=d;
        t = now_ns(); wasm_runtime_call_wasm(env, tn, 1, a);       d = now_ns()-t; if (d<bn) bn=d;
        /* C 直调基线 */
        t = now_ns(); { volatile int32_t s=0; for (int i=0;i<n;i++) s=c_noop(i); g_sink=s; } d=now_ns()-t; if(d<bcd) bcd=d;
        t = now_ns(); { volatile int32_t s=0; for (int i=0;i<n;i++) s=c_sink(payload,32); g_sink=s; } d=now_ns()-t; if(d<bpd) bpd=d;
    }

    printf("N = %d\n", n);
    printf("  %-28s %9.3f ms → %7.2f ns/次\n", "wasm 空 import (noop)",   bc/1e6, bc/n);
    printf("  %-28s %9.3f ms → %7.2f ns/次\n", "wasm 带负载 import (sink)", bp/1e6, bp/n);
    printf("  %-28s %9.3f ms → %7.2f ns/次\n", "wasm 纯循环 (native)",      bn/1e6, bn/n);
    printf("  %-28s %9.3f ms → %7.2f ns/次  ← C 直调基线\n", "C 空调用 (noop)", bcd/1e6, bcd/n);
    printf("  %-28s %9.3f ms → %7.2f ns/次  ← C 直调基线\n", "C 带负载 (sink)", bpd/1e6, bpd/n);
    printf("  ── 空跨界税 = %.2f ns（vs C 直调 %.2f ns，×%.1f）\n", bc/n, bcd/n, (bc/n)/(bcd/n));

    wasm_runtime_destroy_exec_env(env);
    wasm_runtime_deinstantiate(inst);
    wasm_runtime_unload(mod);
    wasm_runtime_destroy();
    free(buf);
    return 0;
}
