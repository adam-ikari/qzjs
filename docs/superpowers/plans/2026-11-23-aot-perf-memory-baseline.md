# AOT 性能与内存基线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native, selected here) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 CI runner 上用固定工具链产出可复现的 AOT 性能/内存基线 JSON，并让后续 CI 对比该基线。

**Architecture:** 单一 Node 脚本负责生成 zodbench 源、构建三套 AOT 产物、执行产品/真实库/诊断负载并汇总 JSON；GitHub Actions job 负责固定 runner、qzjs Release 构建、wamrc/zod 版本和产物上传。首次 CI 产出的 JSON 回填为仓库基线。

**Tech Stack:** Node 22、CMake/Ninja、WAMR wamrc 2.4.5、zod 4.6.5、Python `wait4`（RSS）、现有 `test/compare_perf.py`。

**Spec:** `docs/superpowers/specs/2026-11-23-aot-perf-memory-baseline-design.md`

## Global Constraints

- 基线只能来自 CI runner；本地运行脚本只作验证，不得写入基线文件。
- 固定 `wamrc 2.4.5`、`zod 4.6.5`、`Node 22`、`ubuntu-latest`。
- 输出必须包含 commit SHA、runner/CPU、工具版本、构建耗时、产物字节、p50/p95、峰值 RSS。
- 不改 AOT 编译器语义；性能门槛不设，只报告 Δ%。
- 隔离 worktree 中实施；不改主检出的未归属改动。

## Review Focus

- CI 下载固定 wamrc 后路径/可执行位正确 → job 中显式 `chmod +x` 并 `--version` 验证。
- zod 源导入在 CI 工作目录可解析 → 脚本按安装位置生成绝对导入 TS。
- AOT/.aot 与 wasm-only 口径不混淆 → 产品与 zod 用真 AOT；微基准沿用既有 glue 产物并显式标注。
- 峰值 RSS 不受计时 harness 干扰 → 独立进程 + `wait4`。
- 基线文件缺失或格式变化 → `compare_perf.py` 继续只报告，不失败。

---

### Task 1: 基线采集脚本

**Files:**
- Create: `bench/aot-product/baseline_ci.mjs`
- Create: `bench/aot-product/package.json`, `bench/aot-product/package-lock.json`

**Interfaces:**
- Produces: `node bench/aot-product/baseline_ci.mjs --out <path>` 输出最后一行 JSON 对象，并写同名文件。

- [ ] **Step 1: 实现脚本骨架与元数据**

采集 `git rev-parse HEAD`、`uname -a`、`/proc/cpuinfo` 首条 model name、`free -b` 总内存、Node/Python/qzjs/wamrc 版本；CLI 支持 `--out`、`--qzjs`、`--wamrc`、`--reps`。

- [ ] **Step 2: 实现构建与产物统计**

调用 `node src/qzvm/aot/build.js build` 生成 `aotp`、`zodbench`、`mix`、`str`；计时并记录 `.wasm/.aot/.glue.js/.interp.js` 字节数。zodbench 源按 `node_modules/zod/src/v4/classic/index.ts` 绝对路径生成。

- [ ] **Step 3: 实现计时与 RSS**

每个负载预热后运行 5 次，用 `performance.now()` 得 p50/p95；独立 qzjs 进程用 Python `wait4` 记录峰值 RSS；输出 `RESULT` JSON 行供解析。

- [ ] **Step 4: 本地 dry-run**

运行 `node bench/aot-product/baseline_ci.mjs --out /tmp/aot-baseline-local.json --reps 1`，确认 JSON 可解析且不写仓库基线。

- [ ] **Step 5: 提交脚本**

使用 `commit.draft()` 仅提交本任务文件。

### Task 2: CI job 与首次基线

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `test/perf_baselines/aot.json`（由 CI artifact 回填）

**Interfaces:**
- Consumes: Task 1 的 `baseline_ci.mjs`。
- Produces: job `aot-perf-baseline`，artifact `aot-perf-baseline-<sha>`。

- [ ] **Step 1: 添加 workflow_dispatch 与 job**

Release qzjs + WAMR 构建；Node 22；`npm ci` 三处；下载解压 wamrc 2.4.5 Ubuntu tar；运行脚本；上传 JSON artifact；若基线存在则调用 `compare_perf.py --section aot`。

- [ ] **Step 2: 本地校验 workflow YAML**

用 Python `yaml.safe_load` 解析 `.github/workflows/ci.yml`。

- [ ] **Step 3: 推送分支触发 CI**

使用 `commit.draft()` 提交，push `perf/aot-baseline`，等待该分支 CI 完成。

- [ ] **Step 4: 回填 CI 基线**

下载 artifact 中 JSON，写 `test/perf_baselines/aot.json`；提交 push；确认新 CI run 完成且对比不报错。

### Task 3: 文档收尾

**Files:**
- Modify: `bench/aot-product/README.md`
- Modify: brain `aot-roadness`/新建 `aot-perf-memory-baseline` 页

- [ ] **Step 1: 写使用说明**：记录命令、CI 权威口径、artifact 与基线文件位置。
- [ ] **Step 2: brain 记录决策与首次 CI 基线 SHA/数值摘要**。
- [ ] **Step 3: 最终提交 push**。

## Self-Review

Spec 的 CI-only、固定版本、指标、覆盖负载、artifact、基线回填、对比报告均有任务；无门槛要求已纳入。类型/接口一致（`--out`、最后一行 JSON、`--section aot`）。未覆盖风险见 Review Focus，已绑定步骤。
