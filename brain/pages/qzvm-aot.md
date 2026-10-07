---
id: qzvm-aot
title: "qzvm AOT 实验：perry 路线 + .jso 格式"
category: decision
status: archived
tags: [aot, qzvm, perry]
created: "2026-10-07T04:19:20"
updated: "2026-10-07T15:10:24"
---

<!-- compiled_truth -->
## 决策：先做性能验证，再做生成器（2026-10-07）

路线 A 的**可行性**已验证（253/253 提取 + OP_add 拼装 8/8 正确）。但那只证明
"能拼"，没证明"拼出来够快"。

**决定先做性能验证**，理由：自动拼装可能引入手写理想版没有的损失——
生成代码的形状（是否 inline、`sp` 是否真被优化成寄存器、跨 body 的 label
布局）都可能拖累性能。若自动拼装拿不到接近手写 v2（0.55x 原生 / 72x 解释器）
的数量级，生成器的设计就要改，先做会白做。

性能验证需要最小生成器：读 fib 字节码 → 用提取体拼出完整函数。这本身就是
生成器的雏形，所以不浪费。

**验收标准**：自动拼装的 fib ≥ 手写 v2 的显著比例（目标同数量级，≥1/3）。
达不到就要在生成器设计里找原因（label 布局 / sp 表示 / 函数边界）。

## 依赖：字节码 dumper 必须在引擎内

读 `JSFunctionBytecode`（私有类型）需在引擎编译单元内，形态与 patch 模型同构
——追加到 quickjs.c 或作为引擎构建的一环。这同时验证了 `.elf` 形态的落地路径。


## Timeline

- time: 2026-10-07T04:19:20
  kind: decision
  summary: "Created this page: qzvm AOT 实验：perry 路线 + .jso 格式"
  source: "2026-10-07 用户指示：新建 qzvm aot 分支实验 AOT，借鉴 perry 方案"
  affects: [qzvm-aot]

- time: 2026-10-07T04:19:42
  kind: decision
  summary: "记录 AOT 实验决策：perry 路线（字节码→C→gcc→.so，动态部分仍走 quickjs 解释器）+ .jso 文件格式 + spike 起手方案"
  source: "2026-10-07 用户逐条拍板"
  affects: [qzvm-aot]

- time: 2026-10-07T06:11:35
  kind: decision
  summary: "spike 结论：三个风险全部解除，方案可行。关键发现——(1)符号解析需编译期修复(BUILDING_QJS_SHARED + -fvisibility=default + 链接期 -rdynamic)；(2)native 函数无需触碰解释器 sp/var_refs，签名 JSValue f(JSContext*, JSValue* args, int argc) 即可，args 已求值、局部变量就是普通 C 变量、JSValue 是公开 struct 跨界无需封送；(3)constructor 注册 + dlsym 查找可行。"
  source: "2026-10-07 spike 实测（qzvm aot 分支 commit 938f69a）"
  affects: [qzvm-aot]

- time: 2026-10-07T06:37:22
  kind: decision
  summary: "路线细化（用户逐条拍板）"
  source: 2026-10-07
  affects: [qzvm-aot]

- time: 2026-10-07T07:16:10
  kind: decision
  summary: "性能测试完成：手写 C99 翻译版 fib 稳定 4.3-5.0x 于解释器（同进程同 runtime）。两条硬约束：js_add_slow 是 static 需导出或标记不可翻译；AOT 代码只需 quickjs.h 无需新增引擎 ABI。真实翻译器能否达上限尚未验证。"
  source: "2026-10-07 bench 实测（qzvm aot f351fbb）"
  affects: [qzvm-aot]

- time: 2026-10-07T08:00:06
  kind: decision
  summary: "三方对比定界：解释器比原生慢43x，AOT压到9x（消除~79%）。剩余9x是JS语义固有成本（装箱/GC），非翻译质量。翻译器收益范围4.8-5.2x，正确落点距原生~9x。fib对AOT偏理想，真实负载收益更低，需校准。"
  source: "2026-10-07 bench 三方版"
  affects: [qzvm-aot]

- time: 2026-10-07T08:03:37
  kind: decision
  summary: "推翻先前'9x是JS语义固有成本'的结论：那是我v1翻译的质量缺陷（每层装箱+JS_ToInt32 extern调用），非语义。v2递归全程int32后，AOT达原生0.54-0.62x（快1.7倍）、解释器72-87x。翻译器核心是类型特化+免装箱，不是opcode直译。真实上限远高于先前判定的4.8-5.2x。"
  source: "2026-10-07 v2 实测推翻"
  affects: [qzvm-aot]

- time: 2026-10-07T08:58:31
  kind: decision
  summary: "AOT 四形态交付矩阵（用户拍板）：WASM×2（引擎加载/qzjs加载）+ 机械码×2（qzjs加载dlopen .so / standalone exe）。路线A提取体需引擎内部符号，故形态④可静态链入直接用，形态③有硬缺口——需导出有限内部ABI或改走'只依赖公开API'的第二条生成路径。两条生成路径并存。"
  source: "2026-10-07 用户明确交付形态"
  affects: [qzvm-aot]

- time: 2026-10-07T09:01:25
  kind: decision
  summary: "AOT 四形态定名：.jso(native+bc,qzjs加载)、.jsw(wasm+bc,qzjs加载)、bin(standalone可执行)、.wasm(wasm引擎加载)。前两者是合并容器(机械码+字节码单文件)，后两者纯产物。路线A提取体需引擎内部符号：bin/.wasm可用，.jso有硬缺口需导出有限内部ABI或走第二条'公开API生成'路径。"
  source: "2026-10-07 用户定名四种文件格式"
  affects: [qzvm-aot]

- time: 2026-10-07T09:02:28
  kind: decision
  summary: "四形态定名修正为 .jso / .jsw / elf / wasm（elf=standalone 可执行，非 bin）"
  source: "2026-10-07 用户更正命名"
  affects: [qzvm-aot]

- time: 2026-10-07T09:05:55
  kind: decision
  summary: "修正：.jso 是qzjs加载期AOT，与qzjs同构建，-rdynamic导出全部内部符号，无外部消费者→无需稳定ABI。四形态共用一条提取体生成路径，'两条路径并存'结论作废。"
  source: "2026-10-07 用户更正"
  affects: [qzvm-aot]

- time: 2026-10-07T09:15:14
  kind: decision
  summary: "路线A验证通过：提取器253/253 opcode(41056行C)，OP_add拼装8/8正确（int/float/双向溢出）。提取器无语义知识，纯机械。四形态共用此路径。剩余：字节码→函数生成器、四形态落地、与手写v2性能对比。途中两个harness bug（stdout缓冲吞输出、sp槽位）已记。"
  source: "2026-10-07 路线A实测完成(qzvm 295f9f0)"
  affects: [qzvm-aot]

- time: 2026-10-07T09:17:54
  kind: decision
  summary: "决策：先性能验证再做生成器。自动拼装可能引入手写理想版没有的损失（代码形状/sp寄存器化/label布局），若拿不到接近手写v2（0.55x原生/72x解释器）的数量级则生成器设计要改。性能验证需最小生成器（读fib字节码→拼完整函数），本身即生成器雏形。依赖：字节码dumper必须在引擎内（私有类型），同patch模型。"
  source: "2026-10-07 用户决策"
  affects: [qzvm-aot]

- time: 2026-10-07T15:10:24
  kind: reversal
  summary: "被 release-artifact-topology 取代：AOT 改用新发行拓扑路线实现（TS→wasm+JS胶水调用WinterTC API；ELF 形态经 C99 中间层 + 可配置 gcc）。本页 Perry 路线（字节码→C→gcc→.so + .jso 格式）与『永不独立发行字节码』『唯一稳定 API=WinterTC』冲突，作废。spike/perf 实验数据保留于本页历史 timeline 供参考。"
  source: brain archive-page
  affects: [qzvm-aot]
