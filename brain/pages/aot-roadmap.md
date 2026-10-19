---
id: aot-roadmap
title: "AOT 主线路线：emitter.js 唯一主线 + 待办优先级"
category: reference
status: active
tags: [aot, roadmap, emitter, reference]
created: "2026-10-18T06:06:51"
updated: "2026-10-19T17:54:41"
---

<!-- compiled_truth -->
# AOT 主线路线（emitter.js 唯一主线）

> 2026-10-18 固化：自研 `src/qzvm/aot/emitter.js`（TS→wasm）+ wamrc AOT（.aot）为唯一 AOT 主线。
> AS/ts2c/wasm2c/Perry 全否决（见 `release-artifact-topology` reversal）。本页列主线待办优先级 + 缺口 + 验收。

## 现状基线（2026-10-18 实测）

| 项 | 值 | 出处 |
|---|---|---|
| objWork(30000) | **2.88ms**（双纯数 guard fix 后，原 213ms，74x）| 计数器：跨界 60006→6 |
| noop AOT 跨界（qzjs ext_wamr） | **133.8 ns/次**（V8 wasm 17.7ns）| noop 微基准 |
| glue 路径 qz.add | 3.55µs/次 = 蹦床 133.8ns + JS shim ~3.4µs（BigInt 解 tag）| 计数器+noop |
| raw native C 宿主派发 | noop 43.01ns / 32B 60.73ns（仅 C 宿主 bench3，无 JS 工作）| inmod-abi-proto/host_bench3 |
| POJO 字面量/属性读 | bump 内联 alloc + 内联 i32Load（均零跨界）| 计数器 |
| tagged `+` num+num | 双纯数 guard → f64Add 内联（emitter.js:3257-3266，零跨界）| 14 ToPrimitive + test_aot ALL PASS |
| ext_wamr raw native 蹦床 | **已生效**（noop 133.8ns 证明）| ext_wamr.c:893-907,950,1195 |
| bump arena | STR_BUMP 起，越 STR_BASE(16MiB) 经 qzs_ckmem `unreachable` trap | emitter.js:2252,2271-2278 |
| in-module guest | M1-M5 已实现（libqzvm.wasm 导出 qz_create/eval/tick/destroy+memory）；M6 宿主去 JS 化进行中 | IN_MODULE_DESIGN |
| WASI | qzjs 内置 WAMR `WAMR_BUILD_LIBC_WASI 0`，不解 WASI | aot-performance-model |

**关键修正（2026-10-18 noop 基准）**：旧推断"glue 路径 qz.add=3.55µs 因不走 raw native"**错**。noop 133.8ns 证明 ext_wamr raw-native 蹦床已生效；qz.add 3.55µs 是 **JS shim 工作**（BigInt 解 tag + add 逻辑），非派发税。

## 待办优先级

### P1 — ~~glue 接 raw native~~ ✅ 关闭（2026-10-18 验证）
noop AOT 133.8ns 证明 ext_wamr raw-native 蹦床已生效。qz.add 3.55µs = 蹦床 + JS shim 工作，瓶颈非派发。原 P1 无工作。可压的是 JS shim（BigInt）或 M4 让对象不跨界，并入 P2。

### P2 — M4 单模块合并（性能天花板 / 无 ABI 层，阻塞工具链）
> **核心设计（line 234/366）**：合并成单 wasm 后是**单一产物的内部实现，无 ABI 承诺**——18 个 qz.* imports 变模块内部函数调用；对象表示统一（共享 linear memory + tagged 句柄 0x7FFA/0x7FF9，**无 JSValue 跨界**）。**无 ABI 适配工程**。
- **前提满足**：M5 已实现（guest 跑通真 JS），合并前提（同 isolate 同内存）已就绪。
- **真阻塞（非 ABI）**：
  - **工具链**：wasm-merge（WABT 合并已编 wasm）当前 wabt 1.0.27 未含（需 ≥1.0.37）；wasm-ld 链接 relocatable .o 不适合已编 final wasm。
  - **函数绑定**：libqzvm.wasm 当前只 export qz_create/eval/tick/destroy+memory/malloc/free，**不 export** mix.wasm imports 的 18 个 qz.*。合并需这些函数在单模块内可绑定（internalize 或加 export_name）。
- **价值量化**：qz.add 3.55µs（蹦床 133.8ns + JS shim BigInt ~3.4µs）→ 合并后 wasm 内函数调用（~ns 级，无 BigInt/无蹦床）。跨界密集负载数量级提升。objWork 双纯数 fix 后跨界已 60006→6（税 0.7%），M4 对 objWork 当前基准边际小；价值在消除 JS shim BigInt 开销 + 覆盖未来对象/字符串/BigInt 密集负载。
- **验收**：in-module objWork 跨界趋零、qz.add 降到 wasm 内函数级；选型落地 + 工具链通。
- **状态**：无 ABI 层（设计核心）；阻塞=工具链 + 函数绑定，非 ABI 适配。

### P3 — bump arena 可回收（嵌入式长跑风险 / 降级点已定位，GC 大工程）
- **缺口**：AOT 静态 bump arena（STR_BUMP 起）无 GC，越 STR_BASE(16MiB) 经 `qzs_ckmem`（emitter.js:2271-2278）`unreachable` trap。长循环累积对象撑爆。
- **降级点（2026-10-18 定位）**：`qzs_ckmem` if 块内 `m.unreachable()`（行 2277）。最小可行降级 = 改抛 JS 异常（调 qz.throw RangeError）让宿主 catch，而非整个 wasm trap。设计决策待定（trap vs throw 语义 + qz.throw 是否存在需验）。
- **真正解**：分代/GC（大工程，qzvm 解释器侧已有 GC 可参考）。非本阶段。
- **验收**：长循环累积不 trap；或上限文档化 + 降级优雅（throw 而非 unreachable）。
- **状态**：降级点定位 done；GC 实现非本阶段。

### P4 — TS 覆盖 + 差分审计持续（固件级稳健 / 持续过程）
- emitter.js 自研 TS→wasm 子集，test_aot.js ~205 check 非 test262 级。2026-10-16 一批精度修复刚稳定。
- **验收**：差分审计持续绿；TS 子集声明 + 未支持项显式报错全；固件级 soak 周期。
- **状态**：持续过程，非一次性交付。

### P5 — 双二进制口径统一 ✅ 已修（2026-10-18）
`bench_mix.js:25` 默认恢复 `build/dbg/qzjs`（真 I/O）+ `path.resolve` 防相对路径 ENOENT。原 `build/qzjs`（mock-libuv）默认已纠正。

## 明确不在 AOT 路线（排除项）
- 硬件抽象层（GPIO/BLE/serial）——宿主/平台层职责（见 qzjs-positioning）。
- 专属应用运行时（manifest/权限/应用包格式）——引擎只给机制。
- Node 服务端替代——非定位。
- AssemblyScript / ts2c / wasm2c / Perry——已否决删除（release-artifact-topology reversal）。

## 路线关系
- 性能数据见 `aot-performance-model`（含 noop 133.8ns 修正 timeline）。
- 发行产物拓扑/ABI/WASI 约束见 `release-artifact-topology`。
- in-module 设计见 `IN_MODULE_DESIGN.md`（M1-M5 已实现，M6 进行中）。
- 标准面来源见 `standard-source-policy`。


## Timeline

- time: 2026-10-18T06:06:51
  kind: decision
  summary: "Created this page: AOT 主线路线：emitter.js 唯一主线 + 待办优先级"
  source: "2026-10-18 本会话实测 + release-artifact-topology reversal + aot-performance-model"
  affects: [aot-roadmap]

- time: 2026-10-18T06:07:03
  kind: decision
  summary: "创建 AOT 主线路线脑页（emitter.js 唯一主线）。固化 release-artifact-topology reversal 后的路线：5 项待办按 qzjs 路线（IoT 连接性中枢+通用引擎+WinterTC+AOT加速，护城河=小内存/快启动/确定性）排优先级——P1 glue 接 raw native(最小diff/直接收益/无依赖, qz.add 3.55µs→~50ns+JS工作)、P2 M4 单模块合并(性能天花板/wasm-merge-wasm-ld 选型待决)、P3 bump arena 可回收(嵌入式长跑风险)、P4 TS 覆盖+差分审计持续(固件级稳健)、P5 双二进制口径统一。现状基线全部本会话实测：objWork fix 后 2.88ms/跨界60006→6、glue qz.add=3.55µs不走raw native、raw native C宿主43-66ns、POJO字面量+属性读均内联零跨界、双纯数guard fix。排除项：硬件抽象/专属应用运行时/Node替代/AS-ts2c-wasm2c-Perry。"
  source: "本会话实测 + release-artifact-topology reversal + aot-performance-model + qzjs-positioning"
  affects: [aot-roadmap, release-artifact-topology, aot-performance-model]

- time: 2026-10-18T09:03:04
  kind: decision
  summary: "2026-10-18 修正：P1 关闭。noop AOT 跨界 133.8ns(V8 17.7ns)证明 ext_wamr raw-native 蹦床已生效，qz.add 3.55µs 是 JS shim 工作非派发税。原 P1'glue 接 raw native'无工作可做。P5 已修(bench_mix 恢复 build-dbg+path.resolve)。P2(M4 合并)/P3(bump arena GC)/P4(TS 覆盖) 待办。"
  source: "noop AOT 微基准: qzjs ext_wamr 133.8ns vs V8 17.7ns; ext_wamr.c:893-907/950/1195 蹦床机制; bench_mix.js:25 修复"
  affects: [aot-roadmap]

- time: 2026-10-18T09:03:12
  kind: evidence
  summary: "noop AOT 跨界微基准(qzjs ext_wamr): 133.8ns/次 vs V8 17.7ns/次。证明 ext_wamr raw-native 蹦床已生效(Module load 注册 per-import native, Instance 建 importObject map, 派发查 map 调 JS)。qz.add 3.55µs = 蹦床 133.8ns + JS shim ~3.4µs(BigInt 解 tag+add 逻辑)。修正旧推断'glue 不走 raw native'。P1(glue 接 raw native)关闭——原定义无工作。可压的是 JS shim 工作或 M4 让对象不跨界。P5 已修 bench_mix.js:25 恢复 build/dbg/qzjs+path.resolve。"
  source: "noop_imp.wat(wat2wasm)+wamrc AOT+qzjs/V8 对照基准"
  affects: [aot-roadmap, aot-performance-model]

- time: 2026-10-18T09:06:31
  kind: decision
  summary: "2026-10-18 最终：P1✅关闭(noop 133.8ns 蹦床已生效)、P5✅修(bench_mix build-dbg+path.resolve)、P2 选型调查完成(M5 已实现前提满足; wasm-merge 缺 wabt<1.0.37, wasm-ld 不适合已编 wasm; 阻塞工具链工程)、P3 降级点定位(qzs_ckmem emitter.js:2271-2278 unreachable, 最小可行改 throw; GC 大工程非本阶段)、P4 持续。bump arena STR_BUMP 起 越 STR_BASE(16MiB) trap。"
  source: "noop 微基准+IN_MODULE_DESIGN M5 状态+wabt 1.0.27 无 wasm-merge+emitter.js:2271-2278 qzs_ckmem"
  affects: [aot-roadmap]

- time: 2026-10-18T09:06:31
  kind: evidence
  summary: "P2/P3 调查完成。P2: M5 已实现(guest 跑通真 JS, IN_MODULE_DESIGN 状态行)→合并前提满足; 选型——wasm-merge(WABT 合并已编 wasm)当前 wabt 1.0.27 未含需≥1.0.37, wasm-ld(/usr/bin/wasm-ld 已装)链接 relocatable .o 不适合已编 final wasm 需 emitter 改输出 relocatable; 阻塞工具链工程。P3: bump arena 越界经 qzs_ckmem(emitter.js:2271-2278) if 块内 m.unreachable()(行2277) trap; 降级点定位——最小可行改抛 JS 异常(qz.throw RangeError)而非整个 wasm trap, 设计决策待定; GC 大工程非本阶段(qzvm 解释器侧已有 GC 可参考)。"
  source: "IN_MODULE_DESIGN.md 状态行+§6; wabt 1.0.27 dpkg; emitter.js:2271-2278"
  affects: [aot-roadmap, IN_MODULE_DESIGN]

- time: 2026-10-18T10:07:05
  kind: evidence
  summary: "M4 真状态修正(2026-10-18 深查): 合并阻塞非'仅工具链'——libqzvm.wasm 只导出 qz_create/eval/tick/destroy+memory/malloc/free, 不导出 emitter mix.wasm imports 的 18 个 qz.*(object_get/add/string_concat等, 现由宿主 JS shim 提供)。M4 真工程=18 个 qz.* 的 wasm 内 ABI 适配(emitter tagged i64 ↔ qzvm 内部 JSValue 表示统一/适配层), 架构级。inmod-abi-proto 是 pal 面(qz_host.* 平台服务: log/now/fs_read/drain)原型, 非 qz.* 对象桥。另: objWork 双纯数 fix 后跨界 60006→6(税 0.7%≈21µs/2.88ms), M4 对 objWork 边际收益已小; 真正受益者是字符串/BigInt/对象方法密集负载(strWork 全跨界但走 --interp 退路)。M4 价值=覆盖未来 BigInt/对象密集负载, 非当前基准。"
  source: "wasm2wat build/aot/mix.wasm imports 18 qz.*; wasm2wat build-inmod/src/qzvm/libqzvm.wasm exports(无 qz.*); inmod-abi-proto README(pal 面原型); objWork 计数器 60006→6"
  affects: [aot-roadmap, IN_MODULE_DESIGN]

- time: 2026-10-18T10:12:27
  kind: reversal
  summary: "认知修正（用户纠正'无 abi 是核心设计'）：撤销前条 evidence'M4 真工程=18 qz.* 的 ABI 适配(tagged i64↔JSValue)'——错误。IN_MODULE_DESIGN line 234:'单一 wasm 产物的内部实现,此接口无 ABI 承诺(guest 形态是模块内部调用)';line 366:内存按 ptr+len 传字节不放 JSValue,0x7FFA/0x7FF9 句柄复用为 guest 内表示。合并成单 wasm 后 18 个 qz.* imports 变模块内部函数调用,对象表示本就统一(共享 linear memory + tagged 句柄,无 JSValue 跨界),无 ABI 适配工程。M4 工程回到:链接两 wasm 成单模块(工具链 wasm-merge 缺) + 确保 qz.* 函数在合并模块内可绑定(libqzvm.wasm 当前只 export qz_create/eval/tick/destroy, qz.* 或需 export 或 internalize)。M4 真价值量化修正:qz.add 3.55µs(蹦床133.8ns+JS shim BigInt 3.4µs) → 合并后 wasm 内函数调用(~ns级,无 BigInt/无蹦床),跨界密集负载数量级提升,非'边际小'。"
  source: "IN_MODULE_DESIGN.md line 234(无 ABI 承诺)+line 366(无 JSValue,句柄复用);用户纠正"
  affects: [aot-roadmap, IN_MODULE_DESIGN, aot-performance-model]

- time: 2026-10-18T10:12:46
  kind: decision
  summary: "2026-10-18 修正：P2 M4 合并无 ABI 层(设计核心 line 234/366, 单一 wasm 内部调用无 ABI 承诺, 对象表示统一无 JSValue)。撤销前推断'ABI 适配工程'。真阻塞=工具链(wasm-merge 缺)+函数绑定(libqzvm 不 export 18 qz.*)。价值=qz.add 3.55µs→wasm 内函数~ns。P1✅P5✅不变。"
  source: "IN_MODULE_DESIGN line 234/366; 用户纠正'无 abi 核心设计'"
  affects: [aot-roadmap]

- time: 2026-10-18T10:20:07
  kind: note
  summary: "无 ABI 设计可行性评估(2026-10-18): '无 ABI'=无跨 wasm 边界 marshalling 税(无 i64↔BigInt/无 JS 中间层/无 import-export 编解码),非'无接口/无工程'。三层面论证: (1)kernel 接口(§5.3 line234 无 ABI 承诺)✅M5 已验; (2)pal 面(§10.1-2 uv_io_* 穿边界 ptr+len 无 JSValue)✅inmod-abi-proto 已验 45-66ns; (3)AOT qz.* 面(§10.6 line428 通用契约面非私有 ABI)⚠️设计成立但实现缺口大。核心缺口: libqzvm.wasm 无 18 个 qz.* C 符号(实测 wasm2wat 确认), 需新写 wrapper; 对象表示双轨(emitter bump arena tagged handle vs QuickJS JSValue 堆), line366'0x7FFA 复用'是统一前提但未落地(改 QuickJS 字符串层大工程); AOT 面缺三层重排论证(pal 面有 §10.2, AOT 面仅 §10.6 一句); §9 line305'AOT 变体未验'诚实标注。结论: 设计原则成立, AOT 面实现缺口+论证缺口大; 建议补 AOT 三层重排论证+最小验证(1-2 qz.* wrapper 合并跑)+裁决表示统一程度。"
  source: "IN_MODULE_DESIGN §5.3/§10.1-2/§10.6 line234/366/428; wasm2wat libqzvm 无 qz.* 符号(1043 func 含 QuickJS); mix.wasm 18 qz.* import"
  affects: [aot-roadmap, IN_MODULE_DESIGN, aot-performance-model]

- time: 2026-10-18T10:23:55
  kind: reversal
  summary: "无 ABI 认知二次修正(用户深化): '无 ABI'=qzjs 只承诺公开 JS API 稳定, wasm 模块内与 qzvm 交互是内联调用绑定字节码引擎(QuickJS)和 wasm 原生代码(emitter 产物)。撤销前评估'18 qz.* wrapper 是核心缺口'框架——18 qz.* import 是跨界形态(宿主 JS shim)产物, M6 内联绑定形态不走它(不发 qz.* import, 直接内联绑定 QuickJS 内部操作)。IN_MODULE_DESIGN line428 佐证: 'TS import 内容若内联, 产物 wasm 零 import 自包含'; line4/278/422: M6=in-module 真正落地(内联绑定), M1-M5 先 guest 自包含。真缺口(M6 未实现): (1)emitter 侧内联绑定机制(如何生成对 QuickJS 内部操作的内联调用, 非 qz.* import 桥); (2)合并链接工具链(wasm-merge 缺); (3)表示统一决策(emitter tagged/bump vs QuickJS JSValue, line366 暗示 QuickJS 侧复用 0x7FFA, 内联绑定下表示统一是绑定实现细节非接口适配层); (4)零实测(§9 line305 AOT 变体未验=M6 未做)。承诺边界设计原则成立, M6 是未实现的纸面设计。"
  source: "用户深化'无 ABI=公开 JS API 稳定+内联绑定'; IN_MODULE_DESIGN line428(内联则零import)/line4,278,422(M6=in-module 落地)"
  affects: [aot-roadmap, IN_MODULE_DESIGN]

- time: 2026-10-18T10:29:20
  kind: decision
  summary: "无 ABI 设计文档落地(src/qzvm/aot/NO_ABI_DESIGN.md): 承诺边界=qzjs 只承诺公开 JS API 稳定; 三层交互模型——模块内部内联调用绑定(emitter 产物↔QuickJS 字节码引擎, 合并单模块直接互调, 无 qz.* import 契约面/无 marshalling); 对外零 import(无 OS 调用自包含)或标准 wasm import(依赖 qzjs JS API 时 import JS 函数服务号, 遵守 WebAssembly 标准)。18 qz.* import 是跨界形态(宿主 JS shim)产物, M6 内联绑定不走它。偏差评估 6 条: (1)关键 M6 目标错位——IN_MODULE_DESIGN M6=去 JS 化(host JS_ 调用), 无 ABI M6 核心=emitter 内联绑定, 去JS化是手段/前提非目的, 建议拆 M6a(去JS化)+M6b(emitter 内联绑定); (2)§6 把 M4 合并当工具链问题(wasm-merge), 无 ABI 关键是 emitter 编译期内联非链接工具; (3)§10.6 line426 保留 qz.* 契约面表述与内联绑定零 import 张力; (4)缺承诺边界陈述; (5)缺标准合规陈述(标准 wasm import 服务号); (6)§9 line305 AOT 变体未验=M6b 未做, 状态行'M6 进行中'过于乐观。"
  source: "NO_ABI_DESIGN.md(新建); 用户澄清'无 ABI=公开 JS API 稳定+内联绑定+标准 wasm import'; IN_MODULE_DESIGN line234/278/306/422/428"
  affects: [aot-roadmap, IN_MODULE_DESIGN, release-artifact-topology]

- time: 2026-10-18T10:40:38
  kind: reversal
  summary: "emitter 通用化重点修正(用户纠正'通用ts编译wasm工具是重点,不要绑定qzjs运行时'): 撤销 NO_ABI_DESIGN.md + IN_MODULE_DESIGN.md 中'M6b=emitter 内联绑定 QuickJS'错误框架(那会绑定 qzjs 运行时)。修正为: emitter 是通用 TS→wasm 工具, 产物只声明标准 wasm import(零 import 或 JS 函数服务号), 不假设 qzjs 专有特性(§10.6 line 428 qzjs 只是符号提供者之一); in-module 的内联绑定是 qzjs 运行时侧行为(合并 emitter 产物+libqzvm.wasm 成单模块, 标准 import 变模块内调用, 字节码引擎↔wasm 原生代码)。修正 8 处: IN_MODULE_DESIGN 状态行/§6 合并裁决/§7 M6b 行+总结/§9 M6b 风险; NO_ABI_DESIGN §2.1/偏差1/偏差2/偏差3/偏差6/§5。M6b 重新定义=qzjs 运行时合并(emitter 通用化为前提)。emitter 通用化是无 ABI 前提+产品重点, 不是 emitter 侧内联绑定工程。"
  source: "用户纠正'通用ts编译wasm工具是重点,不绑定qzjs运行时'; §10.6 line 428(qzjs 符号提供者之一)"
  affects: [aot-roadmap, IN_MODULE_DESIGN]

- time: 2026-10-18T13:42:35
  kind: reversal
  summary: "术语归属二次反转(用户澄清 qzvm vs qzjs): 撤销前 reversal 'in-module 内联绑定是 qzjs 运行时侧行为'的错误归属。修正为: qzvm=JS引擎(libqzvm.wasm, 含 QuickJS 字节码引擎+qz.* 原语+realm 生命周期); qzjs=完整运行时(qzvm+宿主+pal+libuv+公开 JS API), qzjs ⊃ qzvm。in-module 合并(emitter 产物+libqzvm.wasm 成单模块, 标准 import 变模块内调用, 字节码引擎↔wasm 原生代码内联绑定)是 qzvm 引擎层模块构建行为, 非 qzjs 运行时侧行为; 内联绑定对象=qzvm。M6b 重定义=qzvm 模块合并(emitter 通用化为前提)。emitter 保持通用不绑定 qzjs/qzvm。对外边界仍用 qzjs 运行时(import 由宿主提供, 正确)。新建 aot-glossary 术语库页。修正 14 处: IN_MODULE_DESIGN 状态行/§6 合并裁决/§7 M6b 行+总结/§9 M6b 风险/§10.5 引擎归属; NO_ABI_DESIGN §2 标题/§2.1 归属+列表+18 qz.* 行/偏差1 标题+M6 目标+关系+修正/偏差2 两点+修正/偏差3 消亡+修正/偏差6 重复行删除。"
  source: "用户澄清: qzvm=JS引擎, qzjs=完整运行时, 内联绑定归 qzvm 引擎层非 qzjs 运行时侧"
  affects: [aot-roadmap, aot-glossary, IN_MODULE_DESIGN, NO_ABI_DESIGN]

- time: 2026-10-19T04:16:23
  kind: evidence
  summary: "M6b multi-module PoC 阶段1机制验通: WAMR multi-module + memory import 跑通 emitter 产物↔libqzvm 链接。test_add.wasm (import qz.memory + qz.qz_add) → reader 加载 libqzvm_dummy.wasm → 链接 → test_add(3,4)=7。验证三点: (1)memory import 共享 linear memory 可行(reactor 默认 export memory); (2)函数 import 经 reader 链接 submodule export; (3)NaN-box 句柄跨模块有效(共享 memory)。关键改造: CMake QZ_WAMR_MULTI_MODULE option + WASM_ENABLE_MULTI_MODULE 下发 ext_wamr(qzjs target); ext_wamr wamr_ensure_runtime 注册 wasm_runtime_set_module_reader; wamr_register_module_imports + wamr_build_instance_imports 跳过 qz import(multi-module 接管, 否则 native registration/JS importObject 拦截); reader 按 module_name=qz 返回 libqzvm.wasm buffer(QZ_LIBQZVM_WASM env)。障碍清解: wasm-ld-14 无 --export-memory(reactor 默认 export); --export-all 与 quickjs 冲突(回显式); uint8/uint32 typedef 在 platform_common.h(用 uint8_t + cast); debug-interp 阻塞(Release build-m6b 无 debug-interp)。阶段2语义验障碍: 真 libqzvm 有 qz_host/wasi import(submodule 加载时无 native registration, 待解)。"
  source: "M6b PoC 实现: CMakeLists QZ_WAMR_MULTI_MODULE + ext_wamr reader + 跳过 qz import + libqzvm_dummy.wat + test_add.wat 验证"
  affects: [aot-roadmap, ext_wamr, CMakeLists, guest_entry]

- time: 2026-10-19T04:20:45
  kind: evidence
  summary: "M6b PoC 真libqzvm作submodule加载成功: 真 libqzvm.wasm(含 qz_host/wasi import + qz_add dummy export) 经 reader 加载作 multi-module submodule, test_add(3,4)=7。qz_host stub natives(drain返回0/fs_read返回-1)经 wasm_runtime_register_natives 全局注册(host_bench3.c:56 先例, per module name), submodule 加载时 qz_host import 自动解析。wasi import(clock_time_get/fd_write等)链接失败为warning不阻塞(libqzvm加载成功, 但真跑完整JS需wasir注册)。验证: multi-module 可加载真 libqzvm(带依赖)作 submodule + 函数链接。下一步阶段2: qz_guest_add 包装 QuickJS(当前 dummy 返回 a+b, 需接 JSContext + NaN-box↔JSValue 转换)。"
  source: "M6b PoC: ext_wamr qz_host stub natives + 真 libqzvm.wasm submodule 测试"
  affects: [aot-roadmap, ext_wamr]

- time: 2026-10-19T04:28:33
  kind: decision
  summary: "M6b 裁决: multi-module 可作 M6b 终态, 免编译期合并。量税实测: dummy libqzvm 31.9ns/call, 真libqzvm 53.6ns/call, 对比 JS shim 3.55µs/call = 66-111x 加速。multi-module 跨模块调用税(wasm→wasm import 间接)接近模块内调用税(ns级), 远低于 JS shim 边界税(3.55µs 含 BigInt dispatch)。裁决: multi-module(C 路径编译期合并)非必需——加载期链接税已足够低。剩余 M6b 完整落地: (1)113 原语 C 实现(包装 QuickJS internal, JS_Add 非公开 API 需 eval 或 internal js_operator); (2)emitter.js 改 import qz.memory+qz.*(addMemory→import); (3)wasi/qz_host 真接线(当前 stub); (4)表示统一(emitter NaN-box vs QuickJS JSValue, 当前 C 侧 round-trip JS_NewFloat64/JS_ToFloat64, 句柄 handle table 待移植 qzvm.js)。bench: bench_add.wat 循环 N=1e6 调 qz_add, performance.now 量时。"
  source: "M6b PoC bench_add.wat + bench_add.js: N=1e6 循环调 qz_add, dummy 31.9ns / 真 libqzvm 53.6ns"
  affects: [aot-roadmap, IN_MODULE_DESIGN, NO_ABI_DESIGN]

- time: 2026-10-19T04:38:44
  kind: evidence
  summary: "M6b emitter.js 改造: importMemory 路径就位。emitter compileTS 加 opts.inModuleLink 条件, anyTagged 模式下 m.importMemory(qz, memory, 640, 640) 替代 m.addMemory(640)。验证: concat.ts (string 操作触发 anyTagged) 编译 → concat_inmod.wasm imports 含 qz.memory + qz.string_concat/qz.add/qz.str_dup/qz.bigint_binop。emitter 产物自动 import libqzvm memory + qz.* 函数（M6b 合并形态）。剩余: (1)STR_BUMP=128 偏移协调(emitter bump arena 避 libqzvm heap, 需 libzvm memory 增大 + 预留 emitter arena); (2)libqzvm 需 export string_concat/str_dup/bigint_binop 等 113 原语(当前只 qz_add dummy); (3)布局协调 + 113 原语 C 实现是完整落地。ModuleBuilder importMemory 方法已存在(wasm-encoder.js:91, 注释 WAMR AOT 要求内存来自宿主)。"
  source: "emitter.js opts.inModuleLink + concat.ts 编译验证"
  affects: [aot-roadmap, emitter.js]

- time: 2026-10-19T04:48:04
  kind: evidence
  summary: "M6b str_dup C PoC: handle table 原语 C 实现模式验证。qz_guest_str_dup export 'str_dup' 实现 strRead(0x7FFA|off → 共享 memory[off..off+4]=len + UTF-8 → JS_NewStringLen) + strWriteback(JS_ToCStringLen → malloc buffer [len][utf8] → 返回 0x7FFA|new_off)。malloc 用 wasi-libc heap(共享 memory 区域, emitter 产物经共享 memory 可访问)。编译通过(build-inmod qzvm-guest)。PoC 简化: malloc 不 free(泄漏接受); 完整测试需 g_current_rt 有效(qz_create+qz_eval+JS 调 emitter 产物完整流程, 当前 test_add.wasm 直接调 fallback)。剩余: (1)完整 in-module 流程测试(qz_create+qz_eval+JS 调 emitter); (2)memory 布局协调(emitter STR_BUMP vs wasi-libc heap); (3)112 原语 C 实现(toJS/ret NaN-box 编解码 + handle table 移植 qzvm.js ~300 行 JS → C); (4)bump arena 管理(替代 malloc 泄漏); (5)wasi/qz_host 真接线; (6)表示统一。"
  source: "guest_entry.c qz_guest_str_dup + build-inmod 编译验证"
  affects: [aot-roadmap, guest_entry]

- time: 2026-10-19T10:04:57
  kind: evidence
  summary: "M6b wasi 真接线: multi-module 开时 WAMR_BUILD_LIBC_WASI=1, libqzvm wasi import(fd_write/clock_time_get 等)解析到 WAMR WASI 实现。验证: test_add.js 跑通 test_add(3,4)=7, 无 wasi 链接 warning(之前 failed to link clock_time_get/fd_write)。libqzvm 完整加载(wasi+qz_host stub 都解析)。剩余: qz_host 真接线(当前 stub drain返回0/fs_read返回-1); 完整 in-module 流程测试; 112 原语 C; memory 布局协调。"
  source: "CMakeLists WAMR_BUILD_LIBC_WASI=1 (multi-module 开时)"
  affects: [aot-roadmap, CMakeLists]

- time: 2026-10-19T10:07:40
  kind: evidence
  summary: "M6b toJS/ret C 最小版: 112 原语基础——统一 NaN-box 编解码。qz_tojs(i64→JSValue): 数值(f64位型)→JS_NewFloat64, 字符串句柄(0x7FFA|off)→JS_NewStringLen(从共享memory读)。qz_ret(JSValue→i64): 数值→f64位型, 字符串→malloc buffer[len][utf8]→0x7FFA|off。str_dup 改用 qz_tojs+qz_ret(替代手写 strRead/strWriteback, 统一编解码)。编译通过(build-inmod)。其他 tag(0x7FF9句柄/0x7FFB数组/0x7FFC布尔等)+handle table 后续。参考 qzvm.js toJS/ret(~300行JS) C 移植, M6b 完整落地工程。"
  source: "guest_entry.c qz_tojs/qz_ret + str_dup 改用统一编解码"
  affects: [aot-roadmap, guest_entry]

- time: 2026-10-19T10:09:22
  kind: evidence
  summary: "M6b string_concat C: 第3个原语 C 实现(qz_add/str_dup/string_concat = 3/112)。JS_ConcatString 非公开 → 用 JS_ToCString+memcpy+JS_NewStringLen 拼接。qz_tojs 解 a,b(字符串句柄→JSValue), qz_ret 装回(JSValue→0x7FFA|off)。编译通过。当前 libqzvm export 3 原语 + toJS/ret C 基础(数值+字符串 tag)。剩余 109 原语 C + toJS/ret 扩展(0x7FF9句柄/0x7FFB数组/0x7FFC布尔等 + handle table) + 完整流程测试 + memory 协调 + bump 管理 + qz_host 真接线 + 表示统一。"
  source: guest_entry.c qz_guest_string_concat
  affects: [aot-roadmap, guest_entry]

- time: 2026-10-19T10:12:15
  kind: evidence
  summary: "M6b 原语批量 C 实现 6/112: qz_add/str_dup/string_concat/lt/gt/str_len。toJS/ret 加布尔 tag(0x7FFC, JS_NewBool/JS_VALUE_GET_BOOL)。lt/gt 用 C 比较(JS_ToFloat64<比较) + JS_NewBool + qz_ret。str_len 用 JS_ToCStringLen。libqzvm exports 验证(wasm-objdump): free/gt/lt/malloc/memory/qz_add/qz_create/.../str_dup/string_concat/str_len。剩余 106 原语(sub/mul/div/le/ge/seq/sne/object_*/arr_*/iter_*/call_*/builtin_*/env_*/instanceof_*) + toJS/ret 扩展(0x7FF9句柄/0x7FFB数组 + handle table) + 完整流程测试 + memory 协调 + bump 管理 + qz_host 真接线 + 表示统一。~2000 行 C 大工程。"
  source: "guest_entry.c lt/gt/str_len + 布尔 tag"
  affects: [aot-roadmap, guest_entry]

- time: 2026-10-19T10:14:57
  kind: evidence
  summary: "M6b 原语批量 C 实现 14/112: add/sub/mul/div/rem/lt/gt/le/ge/seq/sne/str_dup/string_concat/str_len。算术(sub/mul/div/rem 用 JS_ToFloat64+C运算+JS_NewFloat64+qz_ret, rem 用 fmod), 比较(le/ge/seq/sne 用 C比较+JS_NewBool+布尔 tag)。libqzvm exports 验证: 14 原语 + qz_create/eval/tick/destroy/result_*/malloc/free/memory。toJS/ret C 支持 3 tag(数值f64/字符串0x7FFA/布尔0x7FFC)。剩余 98 原语(object_*/arr_*/iter_*/call_*/builtin_*/env_*/instanceof_*/to_string/string_new/neg/band/bor/bxor/bnot/truthy/alloc 等) + toJS/ret 扩展(0x7FF9句柄/0x7FFB数组/0x7FFD宿主/0x7FFE实例/0x7FFF闭包/0x7FF8 BigInt + handle table) + 完整流程测试 + memory 协调 + bump 管理 + qz_host 真接线 + 表示统一。"
  source: "guest_entry.c sub/mul/div/rem/le/ge/seq/sne + math.h"
  affects: [aot-roadmap, guest_entry]

- time: 2026-10-19T10:16:48
  kind: evidence
  summary: "M6b 原语 C 实现 20/112: add/sub/mul/div/rem/lt/gt/le/ge/seq/sne/str_dup/string_concat/str_len/neg/bnot/band/bor/bxor/truthy。简单原语(算术+比较+位+布尔+字符串)基本完成。剩余 92 原语(复杂: object_get/object_set/object_new/object_rest/arr_apply/arr_set_index/iter_new/iter_pull/iter_val/call_named/call_value/method_call/builtin/builtin_fn/builtin_member/env_get/env_set/env_new/env_def/instanceof_op/instanceof_dyn/to_string/string_new/alloc/fn_value 等)需 handle table(0x7FF9句柄) + JS API(JS_GetProperty/JS_SetProperty/JS_Call/JS_NewObject/JS_NewArray/JS_GetGlobalObject 等) + toJS/ret 扩展(0x7FF9/0x7FFB/0x7FFD/0x7FFE/0x7FFF/0x7FF8 tag)。~1500 行 C 大工程。+ 完整流程测试 + memory 协调 + bump 管理 + qz_host 真接线 + 表示统一。"
  source: guest_entry.c neg/bnot/band/bor/bxor/truthy
  affects: [aot-roadmap, guest_entry]

- time: 2026-10-19T10:20:50
  kind: evidence
  summary: "M6b handle table + object_get/set + qz_add export name 修复: 22/112 原语。toJS/ret 加 0x7FF9 handle table(static array 65536 + JS_DupValue, 不释放泄漏接受)。object_get(JS_GetPropertyStr)/object_set(JS_SetPropertyStr) 复杂原语示范(handle table + JS API)。qz_add export_name 从 qz_add 改 add(匹配 emitter QZ 表 key), test_add.wasm import qz.add 链接成功 test_add(3,4)=7。toJS/ret 现支持 4 tag(数值f64/字符串0x7FFA/布尔0x7FFC/handle 0x7FF9)。剩余 90 原语 + toJS/ret 扩展(0x7FFB数组/0x7FFD宿主/0x7FFE实例/0x7FFF闭包/0x7FF8 BigInt + handle 生命周期) + 完整流程测试 + memory 协调 + bump 管理 + qz_host 真接线 + 表示统一。"
  source: "guest_entry.c handle table + object_get/set + add export name"
  affects: [aot-roadmap, guest_entry]

- time: 2026-10-19T10:22:07
  kind: evidence
  summary: "M6b 原语 25/112: +to_string(JS_ToCStringLen+JS_NewStringLen)/string_new(JS_NewStringLen 从 memory)/object_new(JS_NewObject)。剩余 87 原语(arr_apply/arr_set_index/arr_set_len/arr_delete_index/iter_new/iter_pull/iter_val/iter_close/iter_array/call_named/call_value/closure_call/method_call/method_spread/builtin/builtin_fn/builtin_member/builtin_value/builtin_spread/env_get/env_set/env_new/env_def/instanceof_op/instanceof_dyn/instanceof_builtin/object_rest/alloc/fn_value/object_delete/prop_get/prop_set 等) + toJS/ret 扩展(0x7FFB数组/0x7FFD宿主/0x7FFE实例/0x7FFF闭包/0x7FF8 BigInt + handle 生命周期) + 完整流程测试 + memory 协调 + bump 管理 + qz_host 真接线 + 表示统一。~1300 行 C 大工程。"
  source: guest_entry.c to_string/string_new/object_new
  affects: [aot-roadmap, guest_entry]

- time: 2026-10-19T10:57:02
  kind: evidence
  summary: "M6b 原语 27/112: +alloc(malloc)/object_delete(JS_DeleteProperty+JS_NewAtomLen, JS_DeletePropertyStr 不存在故用 JS_DeleteProperty)。libqzvm exports 27 原语。剩余 85 原语(arr_apply/arr_set_index/arr_set_len/arr_delete_index/iter_new/iter_pull/iter_val/iter_close/iter_array/call_named/call_value/closure_call/method_call/method_spread/builtin/builtin_fn/builtin_member/builtin_value/builtin_spread/env_get/env_set/env_new/env_def/instanceof_op/instanceof_dyn/instanceof_builtin/object_rest/fn_value/prop_get/prop_set/has_prop/get_global/set_global/typeof_*/throw_*/try_* 等) + toJS/ret 扩展 + 完整流程测试 + memory 协调 + bump 管理 + qz_host 真接线 + 表示统一。~1250 行 C。"
  source: guest_entry.c alloc/object_delete
  affects: [aot-roadmap, guest_entry]

- time: 2026-10-19T11:14:41
  kind: decision
  summary: "M6b 真 e2e 跑通：emitter 产物 concat_inmod.wasm + 真 libqzvm.wasm multi-module 链接 → greet(\"x\")=\"x!\"（经 C 原语 string_concat/str_dup）。修 4 处真 bug：(1) wasm-encoder funcidx 用 imports.length 计数→memory import 混入致所有函数索引 off-by-one，改 _importFuncCount() 只数函数 import（importFn/declareFunc/addFunc）；(2) in-module memory import 编码 shared+max(0x02 0x03)→非 shared min-only(0x02 0x00)，WAMR 拒 shared；(3) libqzvm --initial-memory=41943040（640页/40MiB），emitter 产物需字面量段 STR_BASE=16MiB + bump；(4) guest_entry qz_create 设 g_current_rt、qz_destroy 清、qz_eval 保留(prev 恢复)——原仅 qz_eval 设且退出清，致宿主驱动原语调全走 fallback。验证：test_aot 205 PASS + M5 inmodule e2e PASS + 新 test/m6b-poc/e2e_concat.mjs PASS。句柄编码 tag 在高 16 位(0x7FFA<<48)。"
  source: "本会话实测"
  affects: [aot-roadmap]

- time: 2026-10-19T11:56:35
  kind: evidence
  summary: "M6b ABI 收口: guest_entry 6 处签名对齐 emitter QZ 表(truthy→i32; object_set/delete→void+keyId:i32; alloc→i32; string_new(off:i32) 单参, off 指向 [len][utf8])。新增 strId 字符串表 __set_strtab(base:i32)+qz_strval(id): 宿主把 emitter.strings 序列化为 [count][off,len]×count+字节块入共享内存, 无表时回退 id 即 [len][utf8] 偏移。新增 prop_get(recv:i64,keyId:i32) 通用属性读。关键 bug 修复: (1) object_set 双重释放——JS_SetPropertyStr 接管 value 所有权后不得再 JS_FreeValue; (2) undefined/null 编解码缺失——qz_ret 原把 undefined 注册进 handle 表得 0x7FF9|0, null 无编码, 与 emitter 固定槽(0x7FF9|0=undefined / 0x7FF9|1=null)冲突, 现两侧对称编码且 handle 表从 idx 2 起。验证: test/m6b-poc/e2e_prop_get.mjs 全链路(object_new→object_set→prop_get), 命中读回 hello, 漏读返回 undefined 固定槽; test_inmodule_guest_e2e.sh 与 e2e_concat.mjs 均 PASS。剩余: emitter bump(128 起) 与 libqzvm 堆/静态数据(1024 起, 已用 105KB) 重叠需按模式分治布局; 112 原语 C 仍缺 84。"
  source: "guest_entry.c 对齐 + e2e_prop_get.mjs 验证"
  affects: [aot-roadmap]

- time: 2026-10-19T17:54:41
  kind: note
  summary: "已知结构性缺口（均 loud 报错，非静默）：>4 参数跨 ABI、generator/async 无 Promise 运行时、类方法/getter 捕获外层变量（类蹦床签名无 env 槽）"
  affects: [aot-roadmap]
