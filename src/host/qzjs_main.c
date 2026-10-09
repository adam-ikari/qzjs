/*
 * qzjs 单入口 —— qz_cli（CLI 交互/脚本）与 qz_rt（多进程 worker/主RT server）
 * 合并为一个 ELF，按 argv 分发：
 *   --qzjs-worker / --qzjs-rt-server  → rt_main_entry（M-P1/M-P2 进程模式）
 *   其他                               → cli_main（脚本/REPL/-e）
 *
 * 合并原因：两个入口产生两个 ELF（qzjs + qzjs-rt），宿主连接逻辑分散；统一单
 * 二进制，argv 决定运行形态。rt_main 需要 real-libuv pipe（仅非 test 构建）。
 */

#include <string.h>

int cli_main(int argc, char **argv);

#ifdef QZ_WITH_RT_MAIN
int rt_main_entry(int argc, char **argv);
#endif

int main(int argc, char **argv)
{
#ifdef QZ_WITH_RT_MAIN
    /* RT 进程模式（父进程 spawn 的子进程）：--qzjs-worker / --qzjs-rt-server */
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--qzjs-worker") == 0 ||
            strcmp(argv[i], "--qzjs-rt-server") == 0) {
            return rt_main_entry(argc, argv);
        }
    }
#endif
    /* 默认：CLI 交互/脚本/-e/REPL */
    return cli_main(argc, argv);
}
