/* in-module 异步回流原型宿主（§10.4 import 拉模型）
 *
 * fs_read：起线程延迟读文件，完成后入队（模拟 uv_io 异步完成）
 * drain  ：guest 拉队列 → 写 wasm 内存
 *
 * 关键：host 侧无 JSValue；事件是字节。resolve 由 guest 内完成（此原型
 * 用整型 op_id + 内存回传替代，真实版是 guest 持的 JSValue）。
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <pthread.h>
#include <unistd.h>
#include <time.h>
#include "wasm_export.h"

#define MAXQ 8
typedef struct { int32_t op_id; char data[64]; int32_t len; } ev_t;
static ev_t g_q[MAXQ];
static int g_head = 0, g_tail = 0;
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static int32_t g_next_op = 1;
static wasm_module_inst_t g_inst = NULL;   /* 供线程读内存（this proto: 只需文件 I/O） */

typedef struct { int32_t op_id; char path[128]; } job_t;

static void *worker(void *arg)
{
    job_t *j = (job_t *)arg;
    /* 模拟异步延迟 */
    struct timespec ts = { 0, 5 * 1000 * 1000 };  /* 5ms */
    nanosleep(&ts, NULL);

    char buf[64] = {0};
    int n = 0;
    FILE *f = fopen(j->path, "rb");
    if (f) { n = (int)fread(buf, 1, sizeof(buf), f); fclose(f); }
    if (n < 0) n = 0;

    pthread_mutex_lock(&g_lock);
    ev_t *e = &g_q[g_tail % MAXQ];
    e->op_id = j->op_id;
    e->len = n;
    memcpy(e->data, buf, (size_t)n);
    g_tail++;
    pthread_mutex_unlock(&g_lock);

    free(j);
    return NULL;
}

/* qz_host.fs_read(ptr, len) -> op_id */
static int32_t host_fs_read(wasm_exec_env_t exec_env, int32_t ptr, int32_t len)
{
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
    const char *path = (const char *)wasm_runtime_addr_app_to_native(inst, (uint64_t)ptr);
    job_t *j = calloc(1, sizeof(*j));
    if (!j || !path || len <= 0 || len >= (int32_t)sizeof(j->path)) { free(j); return -1; }
    memcpy(j->path, path, (size_t)len);
    j->path[len] = 0;

    pthread_mutex_lock(&g_lock);
    j->op_id = g_next_op++;
    pthread_mutex_unlock(&g_lock);

    pthread_t t;
    pthread_create(&t, NULL, worker, j);
    pthread_detach(t);
    return j->op_id;
}

static int64_t host_now(wasm_exec_env_t exec_env)
{
    (void)exec_env;
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* qz_host.drain(ptr, max) -> nbytes（写 [ptr,ptr+max)，0=无事件） */
static int32_t host_drain(wasm_exec_env_t exec_env, int32_t ptr, int32_t max)
{
    wasm_module_inst_t inst = wasm_runtime_get_module_inst(exec_env);
    char *dst = (char *)wasm_runtime_addr_app_to_native(inst, (uint64_t)ptr);
    if (!dst || max <= 8) return 0;

    pthread_mutex_lock(&g_lock);
    if (g_head == g_tail) { pthread_mutex_unlock(&g_lock); return 0; }
    ev_t e = g_q[g_head % MAXQ];
    g_head++;
    pthread_mutex_unlock(&g_lock);

    /* 序列化：[op_id:i32][len:i32][bytes] */
    int32_t copy = e.len;
    if (8 + copy > max) copy = max - 8;
    memcpy(dst, &e.op_id, 4);
    memcpy(dst + 4, &e.len, 4);
    memcpy(dst + 8, e.data, (size_t)copy);
    return 8 + copy;
}

static NativeSymbol qz_host_natives[] = {
    { "fs_read", (void *)host_fs_read, "(ii)i", NULL },
    { "drain",   (void *)host_drain,   "(ii)i", NULL },
    { "now",     (void *)host_now,     "()I",   NULL },

};
int main(int argc, char **argv)
{
    const char *wasm_path = (argc > 1) ? argv[1] : "guest_async.wasm";
    char err[256];

    FILE *f = fopen(wasm_path, "rb");
    if (!f) { fprintf(stderr, "open %s: %m\n", wasm_path); return 1; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *buf = malloc((size_t)n);
    if (fread(buf, 1, (size_t)n, f) != (size_t)n) { fprintf(stderr, "read fail\n"); return 1; }
    fclose(f);

    RuntimeInitArgs init; memset(&init, 0, sizeof(init));
    init.mem_alloc_type = Alloc_With_System_Allocator;
    if (!wasm_runtime_full_init(&init)) { fprintf(stderr, "init fail\n"); return 1; }
    if (!wasm_runtime_register_natives("qz_host", qz_host_natives,
            sizeof(qz_host_natives)/sizeof(qz_host_natives[0]))) {
        fprintf(stderr, "register fail: %s\n", err); return 1;
    }

    wasm_module_t module = wasm_runtime_load(buf, (uint32_t)n, err, sizeof(err));
    if (!module) { fprintf(stderr, "load: %s\n", err); return 1; }
    wasm_module_inst_t inst = wasm_runtime_instantiate(module, 8192, 8192, err, sizeof(err));
    if (!inst) { fprintf(stderr, "inst: %s\n", err); return 1; }
    g_inst = inst;
    wasm_exec_env_t env = wasm_runtime_create_exec_env(inst, 8192);

    printf("=== 异步回流：fs_read → drain（import 拉模型）===\n");
    wasm_function_inst_t run = wasm_runtime_lookup_function(inst, "run_async");
    if (!run) { fprintf(stderr, "lookup run_async fail\n"); return 1; }
    uint32_t r[1] = {0};
    if (!wasm_runtime_call_wasm(env, run, 0, r)) {
        fprintf(stderr, "call run_async: %s\n", wasm_runtime_get_exception(inst));
        return 1;
    }
    int32_t *st = (int32_t *)wasm_runtime_addr_app_to_native(inst, 0);
    printf("  → op_id=%d, drain 轮数=%d, 收到字节数=%d\n", st[0], st[1], st[2]);
    int32_t evlen; memcpy(&evlen, (char *)wasm_runtime_addr_app_to_native(inst, 128) + 4, 4);
    char *evdata = (char *)wasm_runtime_addr_app_to_native(inst, 128) + 8;
    printf("  → 事件负载 len=%d: \"%.*s\"\n", evlen, evlen, evdata);

    int ok = (st[0] > 0 && st[2] > 0);
    printf("\n%s: 异步回流 %s（guest 发起 → 宿主线程完成 → guest drain 取回）\n",
           ok ? "OK" : "FAIL", ok ? "通" : "断");

    wasm_runtime_destroy_exec_env(env);
    wasm_runtime_deinstantiate(inst);
    wasm_runtime_unload(module);
    wasm_runtime_destroy();
    free(buf);
    return ok ? 0 : 1;
}
