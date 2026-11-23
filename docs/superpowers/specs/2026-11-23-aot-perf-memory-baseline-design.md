# AOT 性能与内存基线设计

## 意图

在 CI runner 上建立唯一权威的 AOT 性能/内存基线，替代散落在 brain 与 README 的本地测量。基线必须能从仓库源码和固定工具版本重建，用于后续 PR 回归对比。

## 目标

- 一个 CI job 构建 Release qzjs、固定 wamrc 2.4.5、固定 zod 4.6.5。
- 一个脚本产出统一 JSON：构建耗时、产物字节、运行时 p50/p95、峰值 RSS、机器/工具元数据。
- 覆盖产品负载 `aotp`（compute/json/validation）、真实库入口 `zodbench.bench(100)`、诊断微基准 `mix`/`str`。
- 结果作为 artifact 上传；首次 CI 产出的 JSON 固化为 `test/perf_baselines/aot.json`，后续 CI 用 `test/compare_perf.py` 对比。
- 基线值与本地机器数值分离，禁止把本地测量写进基线文件。

## 非目标

- 不把 CI runner 当作跨平台绝对性能基准；只固定 ubuntu-latest，后续换 runner 需重建基线。
- 不新增性能门槛；`compare_perf.py` 仅报告 Δ%。
- 不改动 AOT 编译器实现或现有 bench 的语义。

## 约束

- 本地已有未归属改动；实现放隔离 worktree `perf/aot-baseline`，不碰主检出。
- CI 必须固定 wamrc release URL、zod 版本、Node 版本；输出记录 commit SHA。
- 内存用 `wait4` 的 `ru_maxrss`，与 `bench_mem.js` 口径一致。
- 计时用 `performance.now()`，每个负载预热后 5 次取 p50/p95。

## 方案

1. 扩展现有三个脚本各自产 JSON，再在 CI 合并。（格式不一致，需改三处，且 `run.js` 无 RSS。）
2. 新增单一 `bench/aot-product/baseline_ci.mjs`，直接构建 AOT 产物、生成 harness、采集全部指标，输出一行 JSON。（选定：单点口径，易复现。）
3. 用 Python 重写全套基准。（重复 AOT 构建逻辑，成本高。）

选定方案 2。CI job 增加 `workflow_dispatch` 以便手动重建基线，普通 PR 跑对比。

## 待实现

- 固定 zod 的 `package.json`/lock 与 wamrc 下载。
- 实现 baseline 脚本并在本地做 dry-run（不写入基线值）。
- 加 CI job，推送分支后用 CI 产出基线 JSON，再回填并提交。
