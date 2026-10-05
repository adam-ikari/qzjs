# Contributing to qzjs

## AI Assistant Guidance

For Claude Code (claude.ai/code) or other AI assistants working with this codebase, see **[brain/docs/claude-guidance.md](brain/docs/claude-guidance.md)** for detailed guidance on:

- Project architecture and libuv-native execution model
- Build & test workflows
- Code conventions and patterns
- Extension development and polyfill integration

## Development Setup

```bash
git clone --recursive https://github.com/adam-ikari/qzjs.git
cd qzjs
cmake -B build -DCMAKE_BUILD_TYPE=Debug -DQZ_BUILD_TESTS=ON
cmake --build build -j$(nproc)
cd build && ctest -L offline --output-on-failure
```

## Code Style

- **C99**: `set(CMAKE_C_STANDARD 99)` — no C11 features in qzjs core
- **Indentation**: 4 spaces (no tabs)
- **Naming**: `snake_case` for functions/variables, `SHOUTING_CASE` for macros
- **Headers**: `#pragma once` not used; use `#ifndef QZ_..._H` guards
- **Comments**: `/* ... */` style (not `//`) for C source

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(qzjs): add timer handle leak protection on HTTP abort
fix(uv_io): fix chunked response decode boundary case
docs: update libuv-native execution model documentation
test: add escape_for_js property-based tests
refactor: unify WASM engine initialization
```


## Branch Management

### 分支命名

每个分支必须归类到以下前缀之一，格式 `类型/简短描述`（小写、连字符分隔）：

| 前缀 | 用途 |
|------|------|
| `feat/` | 新功能（如 `feat/http3-client`） |
| `fix/` | 缺陷修复（如 `fix/https-fetch-tls`） |
| `build/` | 构建/工具链改动（如 `build/qzjs-host-for-crossbuild`） |
| `docs/` | 文档与仓库元数据（如 `docs/branch-policy`） |
| `refactor/` | 重构，无行为变化（如 `refactor/unify-wasm-init`） |
| `perf/` | 性能优化（如 `perf/stream-read-batching`） |
| `test/` | 测试新增或修复（如 `test/fuzz-corpus-alignment`） |

禁止裸名分支（`cross-build-qjsc` 这类历史遗留要迁到 `build/` 前缀下）和
语义不明的名字（`prod-merge`）。分支名一旦推送远端即视为不可变——需要改名时
新建分支推送、删除旧分支，而不是 force-push 重写。

### 生命周期

1. 从 `master` 检出功能分支（`git checkout -b fix/<desc> master`）
2. 按 [Conventional Commits](#commit-messages) 提交，随时推送远端（远端分支 =
   备份，不是 PR 的唯一存在）
3. 完成后开 PR 合并回 `master`
4. PR 合并后（`delete_branch_on_merge` 开启）远端分支自动删除；本地分支
   `git branch -d` 清理

### 合并方式

统一 **Squash merge**：PR 的全部 commit 压成一条进 `master`。master 历史线性，
每条 commit 对应一个可追溯的 PR。合并时的 squash message 默认取 PR 标题，
并在正文附 PR 号。

### master 保护

`master` 已开启 branch protection，禁止直接 push、禁止 force-push、禁止删除。
改动必须经 PR 以 **squash merge** 合并，且满足：

- **CI 通过** —— 19 个必需 job 全绿：
  - *编译/测试矩阵（13）*：all-features-off / feature matrix 四档 / wamr /
    wasm3 / polyfill-external / polyfill-compressed / nonutf /
    profile=minimal / asan 两档
  - *质量门禁（6）*：ubsan（gcc + clang）/ e2e（真实 libuv + JS harness）/
    test262（ES 一致性）/ clang-tidy / fuzz-smoke（libFuzzer 字节码读取器）
  - strict 模式：分支落后于 master 时必须先同步

  perf 套件（httpserver / h2-client / runtime / cross-runtime / js-api /
  tls-ws-grpc）是 record-only，不进门槛；coverage / grpc-e2e / debugger /
  release build 暂未纳入。
- **线性历史** —— `required_linear_history`，PR 不能引入 merge commit
- **review 数 0** —— 单人项目，不设 approve 门槛。审查责任落在 CI 与 PR 描述上

force-push 与 delete 均被禁止，因此分支名一旦推送远端即不可变（见上）。

合并后本地同步：`git checkout master && git pull --ff-only origin master`。

### 新增必需 job 时

往 `.github/workflows/ci.yml` 加 job 后，同步更新 master 的 required status
checks，否则新 job 不会被纳入合并门槛：

```bash
gh api repos/adam-ikari/qzjs/branches/master/protection --jq \
  '.required_status_checks.contexts'
```

### 清理规范

- 已合并 PR 的分支由 `delete_branch_on_merge` 自动删除，无需手动
- 超过 30 天无活动、且无对应 open PR 的远端分支视为陈旧，删除前在
  PR 里公告 7 天
- 遗留裸名分支（`cross-build-qjsc`、`prod-merge` 等）按上一条迁移或删除

## Adding a New Extension

1. Create `src/ext_<name>.c` and `include/qzjs/ext_<name>.h`
2. Implement `qz_ext_t` (at minimum: `init` + `destroy`)
3. Register JS functions via `JS_SetPropertyStr` in `init`
4. Add CMake option `QZ_WITH_<NAME>`
5. Add to the default extensions list in `qz_create`

## Adding a New Polyfill Module

1. Create `polyfill/src/<module>.js`
2. Export globals via `globalThis.<name> = ...`
3. Add to `polyfill/src/index.js` imports
4. Run `cd polyfill && npm run build` to bundle (esbuild) → compile to bytecode (qjsc) → regenerate the generated C file for the active `QZ_POLYFILL_MODE`: `src/polyfill_default.c` in the default `rodata` mode, `src/polyfill_<mode>.c` in the other modes (those per-mode files are untracked)
5. Test via the host harness: `host_value(h, "typeof <global> !== 'undefined'", &out)` (see `test/test_host.h`)

## Third-Party Library Policy

**Default to self-made.** Introducing or replacing an open-source library is an
exceptional move and requires ALL of the following, with evidence for each:

1. **Proven positive payoff** — the self-made code is itself a risk source
   (identified correctness gaps, duplicated implementations, maintenance debt),
   not merely long or "less standard". Payoff must be deletable debt and
   fixable defects, not abstract spec-compliance.
2. **In-place replaceability** — the swap must not violate the architecture
   rule (C provides pal primitives only; protocol policy lives in JS) nor break
   cross-layer interfaces (PAL surface, bridge byte protocol, polyfill-internal
   coupling). Candidates that force rewriting consumers or cross-layer
   interfaces are rejected.
3. **Controllable vendor cost** — C libraries: C99-compatible, zero or near-zero
   transitive deps, vendored via the existing `deps/` mechanism (snapshot
   submodule + repo-committed patch files). JS libraries: bundled via esbuild
   into the polyfill; the first npm dependency opens a supply chain (license
   audit, version pinning, transitive deps) and carries a higher bar.
   Licenses must be MIT-compatible.

The current baseline and per-module verdicts live in
`brain/pages/oss-library-policy.md`; new verdicts are recorded there.

## Pull Request Checklist

- [ ] Code compiles without warnings (`-Wall -Wextra`)
- [ ] All existing tests pass (`ctest -L offline --output-on-failure`)
- [ ] New features have tests
- [ ] New library dependencies (C or JS) follow the Third-Party Library Policy above
- [ ] No tabs in source files (spaces only)
- [ ] No trailing whitespace
- [ ] Commit messages follow Conventional Commits
- [ ] Branch name uses an allowed prefix (`feat/`, `fix/`, `build/`, `docs/`, `refactor/`, `perf/`, `test/`)
- [ ] PR targets `master`（合并由维护者以 squash 方式执行，见「合并方式」）
- [ ] No references to upper-layer applications — qzjs is standalone

## Release Process

1. Update version in `CMakeLists.txt` (`project(qzjs VERSION x.y.z)`)
2. Update `CHANGELOG.md`
3. Tag: `git tag v0.y.z`
4. Push tag: `git push origin v0.y.z`

## License

By contributing, you agree that your contributions will be licensed under the
MIT License.
