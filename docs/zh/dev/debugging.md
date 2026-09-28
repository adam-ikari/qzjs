---
title: 调试
description: 使用 DAP 调试器调试 qzjs — 断点、步进、变量检查以及 VS Code 集成。
---

# 使用 VS Code 调试 qzjs 程序

qzjs 内置了一个 **DAP（调试适配器协议）** 步进调试器，直接编译在库本身中——无需单独的调试器二进制文件。启用后，任何嵌入 qzjs 的程序都可以在 VS Code 中进行步进调试（断点、逐过程/步入/步出、调用栈、局部变量、求值）。

## 工作原理

调试器是一种**库能力**，而非独立进程。它位于 `src/debugger.c`（调试核心）和 `src/debugger_dap.c`（DAP 协议层）中，当 `QZ_BUILD_DEBUGGER=ON` 时编译进 `libqzjs.a`。对 QuickJS-ng 引擎的一个小补丁（`deps/quickjs-ng-debugger.patch`）添加了调试核心使用的断点/步进内省原语。

激活方式为**通过配置或环境变量自动**——你的宿主代码无需更改。`qz_create` 检查调试设置，如果启用，则附加 DAP 层（通过 stdin/stdout 进行 DAP 通信）并在入口处暂停。VS Code 随后附加。

### 双层禁用（关闭时零开销）

- `QZ_BUILD_DEBUGGER=OFF`（默认）：**不**应用引擎补丁，**不**编译 `src/debugger.c`/`src/debugger_dap.c`，`qz_create` 中没有调试代码路径。调试功能不存在；`libqzjs.a` 保持不变。
- `QZ_BUILD_DEBUGGER=ON`：应用补丁并编译源文件，但引擎的每个操作码的 `DEBUGGER_CHECK` 是无操作的（一个永不执行的分支），**除非运行时附加了调试器**。非调试运行几乎没有性能开销。

## 构建

```bash
cmake -B build -DQZ_BUILD_DEBUGGER=ON -DQZ_BUILD_TESTS=ON
cmake --build build -j$(nproc)
```

这会在配置时将 `deps/quickjs-ng-debugger.patch` 应用到 QuickJS-ng 子模块的工作树（子模块在 git 中保持干净——补丁是事实来源）。`cmake -DQZ_BUILD_DEBUGGER=OFF` 恢复原始状态。

## 在你的程序中启用调试

**方案 A — 无需代码更改（环境变量）：** 使用 `QZ_DEBUG=1` 运行你的程序：

```bash
QZ_DEBUG=1 ./myapp app.js
```

**方案 B — 配置位：** 设置 `qz_config_t.debug` 的位 1（位 0 是现有的详细日志标志）：

```c
qz_config_t cfg = {};
cfg.debug = 0x2;            /* 位 1 = 启用调试（或直接以 QZ_DEBUG=1 运行） */
cfg.initial_script = src;   /* 在入口处暂停，然后在断点处暂停 */
qz_t *rt = qz_create(&cfg);
```

注意：经 `cfg.initial_script` eval 的代码会被引擎记为源名 `<initial>`
（见「限制」），因此文件断点只有在宿主自己用真实文件名 eval 源码时才会
命中——入口暂停与 `debugger;` 在任何情况下都有效。

就这样——`qz_create` 自动附加 DAP，发送 `initialized`，并在 DAP 配置阶段（initialize / setBreakpoints / configurationDone）阻塞后返回。`stop_on_entry` 在程序的第一条语句处暂停。

## 从 VS Code 调试

调试器通过 **stdio 上的标准 DAP** 通信：运行时（启用调试的 `qz_create`）
是 stdin/stdout 上的 DAP 服务端，任何会讲 DAP 的客户端都能连。两个组成部分：

- **`vscode/qzjs-debug`** —— 注册 `qzjs` 调试类型的 VS Code 扩展。它是一个
  *内联*适配器：用 `QZ_DEBUG=1` 拉起你的二进制，并在 VS Code 与子进程
  stdio 之间转发 DAP 帧。
- **qzjs 内置的 DAP 服务端** —— 即库本身，也由 `test/test_dap_gtest.cpp`
  直接端到端驱动。

在开发宿主中运行扩展：在 `vscode/qzjs-debug` 里执行 `npm run compile`，
打开该文件夹后按 F5（Run Extension），或以
`code --extensionDevelopmentPath=<repo>/vscode/qzjs-debug` 启动 VS Code。

不使用扩展时，仍有两种方式驱动同一个 DAP 服务端：

**方案 1 —— 通用调试适配器。** 用一个 stdio DAP 适配器（如 Mock Debug
适配器，或自己写的）配一个 launch：`program` 指向在 `QZ_DEBUG=1` 下
运行你二进制的命令。适配器在 VS Code 与子进程 stdio 之间转发 DAP。
任何「DAP 服务端在 stdio、客户端侧」的适配器都能工作；qzjs 侧无需
扩展，因为它从不注册 VS Code 类型。

**方案 2 —— 直接驱动 DAP 协议。** 在 `QZ_DEBUG=1` 下运行你的程序，
自行往 stdin/stdout 发 DAP——可以是 REPL、脚本或一次性客户端。
`test/test_dap_gtest.cpp` 是可用的参考客户端：它在 `QZ_DEBUG=1` 下
fork 子进程，然后发 initialize → setBreakpoints → configurationDone，
期待断点处的 `stopped` 事件，再单步并检查变量。

DAP 层实现了：initialize、attach、setBreakpoints、configurationDone、
threads、stackTrace、scopes、variables、continue、next、stepIn、stepOut、
evaluate、disconnect。

<details>
<summary>参考 <code>launch.json</code>（使用仓库自带的扩展 <code>vscode/qzjs-debug</code>）</summary>

```json
{
  "version": "0.2.0",
  "configurations": [{
    "type": "qzjs",
    "request": "launch",
    "name": "qzjs: debug",
    "program": "${workspaceFolder}/app.js",
    "runtimeExecutable": "${workspaceFolder}/build/qzjs"
  }]
}
```

`program` 是 JS 入口文件，`runtimeExecutable` 是嵌入 qzjs 的二进制。
适配器自己会给子进程加 `QZ_DEBUG=1`（无需 `env`），把 `program` 追加为
最后一个参数，并把相对的 `program` 按工作区文件夹解析成绝对路径——VS Code
发送的断点是文档自身的绝对路径，两者必须是字节相同的字符串，引擎的断点
精确匹配才认得。若传 `runtimeArgs`，它位于 program 路径**之前**——别把
program 再写一遍。

</details>

有了扩展，你就能附加到入口处暂停的程序，继续以命中断点、
检查 Locals、单步、求值监视表达式。

## 当前可用功能（MVP）

- 按（源文件，行号）设置断点 — 在启动前从 VS Code 设置。
- 断点在**所有语句种类**上都会命中：`return`、`break`/`continue`、
  `case`/`default:`、`try`/`catch`/`finally`/`else` 头、`do {`、空语句、
  多声明的 `var` 每一行。编译器在每个语句入口（以及 switch 子句 /
  `else` / `catch` / `finally` 位置）都记录 pc→行号条目，而不只是普通的
  赋值与调用。
- `setBreakpoints` 按源文件作用域生效：每个请求只替换所指名文件的断点，
  其他文件的断点不受影响（DAP 每次只对一个文件发请求）。
- 条件断点：断点的 `condition` 以 JS 求值（帧局部变量同样暴露在 `locals`
  下，与 `evaluate` 同一约定）；非零则停，零则跳过，表达式抛错则停下来让
  你看到错误。
- 命中次数（条件）断点：断点的 `hitCondition` 在设点时一次性解析（VS Code
  「命中次数」菜单的写法：`N`/`==N` 恰在第 N 次访问停、`%N` 每第 N 次、另有
  `>N` `>=N` `<N` `<=N` `!=N`）。命中按「访问」计数：到达该行一次计一次——
  同一条语句的多个 opcode、以及调用进入 callee 都属于同一次访问，从 callee
  返回不会重复计数。运行时解析不了的 hitCondition 回报 `verified: false`
  并附消息（VS Code 灰色未安装 glyph），而不是变成一个永不命中的哑断点。
  断点被重新登记（任何替换它的 setBreakpoints）时计数清零。
- 日志点（logpoint）：带 `logMessage` 的断点不暂停，而是把内容写到 Debug
  Console——`{表达式}` 洞在栈顶帧求值（同样是 `locals.` 约定），打印后自动
  继续。每次命中都会触发（循环行每次迭代都记录），渲染失败则退化为普通停
  断点——fail-open，绝不悄悄丢一次停顿。
- 异常断点（过滤器 **All exceptions** = `all`）：每次 `throw` 都暂停，
  `reason: exception`、`text` 为错误消息、停在抛出点帧——被 catch 捕获与否
  都一样，一次抛出恰好停一次。目前只提供这一个过滤器（见限制）。
- `verified` 反映文件系统：文件不存在或行号超出文件末尾回报 `verified:
  false`（VS Code 中显示灰色）；当响应与请求无法 1:1 核对时，保留引擎的
  回答。
- 源码中的 `debugger;` 语句 —— 即使一个断点都没设也会暂停，`reason` 为
  `breakpoint`；且与引擎为该代码记录的文件名无关。
- 入口暂停（`stop_on_entry`）。
- 逐过程 / 步入 / 步出、继续。
- 调用栈，包含每个帧的文件/行号/函数。
- 局部变量作用域（参数 + 局部变量）及其值。
- 变量展开：Locals 里的对象/数组——`evaluate` 结果同样（hover/监视以相同
  方式下钻）——可逐层打开自己的可枚举属性 / 数组下标，每层点击一次，每个值
  带有界预览字符串。引用只在本次停顿内有效：下一个停顿即失效（查询失效引用
  只会得到空列表）。
- `evaluate`（REPL/监视）。全局变量和纯表达式直接求值；帧的局部变量在求值期间暴露在 `locals` 对象上，因此 `locals.x` 读取局部变量。（裸写 `x` 不会绑定——真正的帧内求值需要 QuickJS 未暴露的引擎支持。）对象结果携带可展开引用，Debug Console 里的 `locals.o` 可以打开。
- **暂停时世界冻结**：`fetch`/`setTimeout`/PAL 回调在暂停期间**不会**推进——暂停循环只服务调试协议请求（符合标准调试器「中断即冻结」语义）。

## 限制（MVP）

- **`evaluate` 裸局部变量绑定**：引用局部变量的监视表达式必须使用 `locals.` 前缀（`locals.x`，而非 `x`）。真正的帧内求值（直接绑定局部变量）需要 QuickJS 未暴露的引擎支持。
- **文件名匹配是精确字符串比较，且以入口脚本为中心**：断点用帧记录的源名做字节精确匹配。CLI 脚本模式记录的是真实路径（适配器保证绝对路径字符串一致），但：
  - `-e` / REPL 的代码记录为 `<input>`；
  - 嵌入宿主若 eval `cfg.initial_script`，记录为 `<initial>`（`qz_eval_internal`
    写死），此时对真实文件设置的断点永远不会命中——入口暂停与 `debugger;`
    仍然有效。
- **`verified: true` 表示「已登记且行号在范围内」而非「会命中」**：适配器
  会对照磁盘上的文件核对行号（文件缺失或行号超出文件末尾回报 `verified:
  false`），但文件名匹配仍是字节精确比较（见上一条），因此该文件必须以
  完全相同的路径被求值断点才会触发。
- **右花括号行不可断点**：只有语句入口才有 pc→行号条目；某行没有语句
  字节码——例如单独一个 `}` 收尾块——就没有条目，在那里设的断点会回报
  `verified` 但永远不会命中。
- **`finally` 续段可能再次触发 catch 体所在行**：从 `finally` 里继续执行
  时，`gosub` 返回到的簿记字节码物理上位于前一条语句的行区域内，因此那
  条已经执行过的行上的断点可能再触发一次。若把这段代码改挂到未来的行
  号上，会破坏单步语义，故保留按行入口记录的行为。
- **无 CDP / Chrome DevTools**：仅 DAP。Chrome DevTools 协议（通过 WebSocket 的 CDP）已推迟。
- **异常断点只有 `all`**——没有 *Uncaught* 过滤器（需要在展开路径上检测
  catch），也没有单独的 Promise 处理：异步拒绝就是一次 throw，一样会停。
  客户端若发送未知过滤器，回 `verified: false`。
- **命中计数按登记生效，不跨登记**——setBreakpoints 重新登记某文件的断点时
  其计数清零。`%N` 计的是「访问」，对循环行而言即每次迭代——`finally` 续段
  重触发（见上）是新的一次访问，照计。
- **日志点的洞只在栈顶帧求值**——`{expr}` 与 `evaluate` 同样只看到
  `locals.` 视图，没有更深层作用域；洞表达式抛错则退化为在该日志点正常停
  断点（停顿不会丢）。
- **变量展开只列自身可枚举属性**——不含原型链成员、不含 `Map`/`Set` 内部
  条目（打开为空）、函数是叶子（不可打开）、跳过 symbol 键，每层最多列 100
  个子项（其余折叠为一行 `<...>`）。仍在暂时性死区（TDZ）的局部变量显示为
  `[uninitialized]`（叶子）——断点停在语句入口，此时该语句的初始化式尚未
  执行。
- **无 source map**，无编辑并继续，无多隔离。

## 暂停期间的异步

暂停时世界**按设计冻结**：暂停的 DAP 循环只服务调试协议请求（50ms stdin
轮询），不驱动 PAL 事件循环——暂停期间排队的 `fetch` 响应与 `setTimeout`
回调要等你 continue 之后才会触发。这符合标准调试器「中断即冻结」语义，
也避免 PAL 驱动的 JS 重入已停止的运行时（`debugger.c` 另有重入保护作
第二道防线）。

## 测试

```bash
cmake -B build -DQZ_BUILD_DEBUGGER=ON -DQZ_BUILD_TESTS=ON && cmake --build build -j$(nproc)
ctest --test-dir build -L dap --output-on-failure
```

`test/test_dap_gtest.cpp` 是一个进程内嵌入宿主，它 fork 一个子进程，在 `QZ_DEBUG=1` 下运行一个小型 JS 程序，然后通过管道充当 VS Code 客户端：initialize → setBreakpoints → configurationDone → 期望在断点处 `stopped` → stackTrace/scopes/variables/evaluate → step → continue → terminate。它验证了整个技术栈：引擎补丁 + 调试核心 + DAP 层 + `qz_create` 中的自动附加路径。此外还覆盖按文件作用域的断点、运行中暂停、stdio 单实例约束、异常断点过滤器（武装：一次抛出停一次；解除：不停车），以及变量展开（嵌套对象/数组、evaluate 引用、下一停顿使旧引用失效）。

扩展自带端到端测试，直接以内联适配器驱动调试构建的二进制
（默认 `build_dbg/qzjs`，可用 `QZJS_RUNTIME` 覆盖）：

```bash
cmake -B build_dbg -DQZ_BUILD_DEBUGGER=ON -DQZ_BUILD_TESTS=ON && cmake --build build_dbg -j$(nproc)
cd vscode/qzjs-debug && npm run compile && npm test
```

CI 两个门都跑：`debugger` job 执行 `ctest -L dap` 与这些 e2e 测试
（`QZJS_RUNTIME` 指向该 job 的 `build/qzjs`）。

- `test/smoke.mjs` —— 打在**真实源路径**上的断点会命中：入口暂停 →
  continue → `reason: breakpoint` 的 `stopped`，栈顶帧的路径/行号等于
  VS Code 打断点的那个文件，随后 `terminated`。
- `test/debugger-stmt.mjs` —— 一个断点都没设时，`debugger;` 也会暂停
  （`reason: breakpoint`），且栈顶帧报出该语句自己的文件与行号。
- `test/line-coverage.mjs` —— 覆盖所有语句种类的 17 个断点
  （if/return、do-while、switch `case`/`default:`、try/catch/finally、
  break/continue），并断言精确的停顿序列——任何语句行悄悄丢失 pc→行号
  条目都会让该测试失败。
- `test/breakpoint-scope.mjs` —— 两个真实源（入口脚本 + 经
  `__native__.nativeEvalScript` 命名的辅助文件）外加对第三个文件的
  set/clear 请求：两个文件的断点都要命中，且第三个文件的请求不得清掉
  它们。
- `test/verified.mjs` —— `verified:false` 语义：超出文件末尾的行、缺失的
  文件，以及响应与请求长度不一致的情形（此时保留引擎的回答）。
- `test/logpoints.mjs` —— 循环行上的日志点三次迭代全部记录且不停顿，相邻
  行的真实断点仍正常停两次；程序输出（`done`）能到达 Debug Console。
- `test/exception-bp.mjs` —— 武装过滤器 `all`：**被 catch 捕获**的
  throw 也停，`reason: exception`、`text` 带错误消息、栈顶帧在抛出点，
  整个会话恰好两次停顿（一次抛出 = 一次停顿，不会重复触发）；解除
  （`filters: []`）：同一个 throw 照常跑完不停。
- `test/variables-expand.mjs` —— 嵌套对象/数组局部变量从 Locals 作用域
  下钻三层（`o` → `nested` → `b` → 元素），`evaluate` 结果同样可展开，  下一个停顿使上一停顿的引用失效（子项为空），程序 stdout（`r 5`）仍到达
  Debug Console。
- `test/hit-condition.mjs` —— 循环行 6 次到达、`hitCondition "%2"` 恰在第
  2/4/6 次停（每次 continue 后的同语句 resume dispatch 不得虚增计数）；另一
  个无法解析的 hitCondition 断点回 `verified: false` 附消息，且不被行号
  on-disk 检查复活；程序 stdout（`s 15`）断言循环跑完。

## 故障排查

**断点不命中 / 无 `stopped` 事件 / 测试 30 秒超时**

引擎的逐 opcode 断点检查由编译期宏门控。若 CMake 传给引擎的宏与
`deps/quickjs-ng-debugger.patch` 里的宏不一致，`DEBUGGER_CHECK` 会编译成
空操作——调试静默失效：不报错，断点就是不生效。

1. 核对两处宏名一致：

   ```bash
   grep -n DEBUG_SUPPORT deps/quickjs-ng-debugger.patch | head -4
   grep -n "QZ_DEBUG_SUPPORT_DEFINE" CMakeLists.txt
   ```

   两处必须同名（当前为 `QZ_DEBUG_SUPPORT`）。项目改名若漏改 patch，
   正是这种静默失效。

2. 确认引擎代码确实编入（未被编译剔除）：

   ```bash
   grep -c "js_debugger_check" deps/quickjs-ng/quickjs.c
   ```

3. 确认 DAP 层已链接（仅 `QZ_BUILD_DEBUGGER=ON` 时编入 `libqzjs`）：

   ```bash
   nm build/libqzjs.a 2>/dev/null | grep -c qz_dap_attach   # or build_dbg/libqzjs.a for the debugger build
   ```

4. 跑端到端客户端——通过则整栈没问题，问题在你的客户端协议交互：

   ```bash
   ctest --test-dir build -L dap --output-on-failure
   ```

**设置了 `QZ_DEBUG=1` 但程序不在入口暂停**

- THREAD 后端嵌入式宿主：auto-attach 发生在 qzjs 线程的 `qz_create`
  期间并阻塞等待 DAP 配置交换——客户端必须发送 `initialize` +
  `setBreakpoints` + `configurationDone`，否则 `qz_create` 永不返回。
- worker 运行时从不 auto-attach（每进程只有一份 stdio；worker 会与
  父 runtime 竞争 stdin）。断点只作用于被 attach 的那个 runtime。
- `config.debug = 1` **不是**调试位——用 `0x2`（位 1）。
