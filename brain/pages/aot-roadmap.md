---
id: aot-roadmap
title: "AOT 主线路线：emitter.js 唯一主线 + 待办优先级"
category: reference
status: active
tags: [aot, roadmap, emitter, reference]
created: "2026-10-18T06:06:51"
updated: "2026-11-10T11:11:44"
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

- time: 2026-10-20T12:59:50
  kind: evidence
  summary: "P3 验收达成（降级路径）：ad0f2d69 已把 qzs_ckmem 的 unreachable trap 改为先调 qz.oom 抛 RangeError（unreachable 仅作宿主未抛时的兜底）。实测：2M 次字符串拼接撑爆 16MiB arena → 宿主捕获 RangeError('qz arena exhausted: bump heap overflowed literal segment')，同实例随后调用 small() 返回 7，实例存活。已知限制：wasm 内 try/catch 捕不到宿主 throw（跨边界异常穿帧变 trap），故降级到宿主层；真正 GC（分代/引用计数）仍是 P2 级工程，不在本阶段。"
  source: "/tmp 探针: big() 抛 RangeError + small() 返回 7; emitter.js:2366-2373"
  affects: [aot-roadmap]

- time: 2026-11-04T10:27:49
  kind: note
  summary: "内建类宿主承载（Map/Set/Date/RegExp/Error 族）C 档 + JS 档对齐完成（c44 56/56 两档一致，test_aot ALL PASS，m6b 13 PASS，两档交叉 25 项 PASS）。剩余语义欠账：sort 稳定性自实现（两档）、类方法内 arguments provider、const K = class 别名捕获外层局部、内建子类承载（class M extends Map，静态路径不经宿主原语 → 需 classMeta builtinParent strId + 实例宿主承载）。"
  source: "c44 内建宿主承载批次"
  affects: [aot-roadmap]

- time: 2026-11-06T00:23:58
  kind: decision
  summary: "语义欠账清一项：sort/toSorted 两档自实现确定性稳定归并结案（见 [[aot-sort-deterministic-merge]]），并新增第三种门禁类别 impldiff（规范未定行为钉本实现值）。剩余欠账：类方法内 arguments provider、const K = class 别名捕获外层局部、内建子类承载（class M extends Map 静态路径）。"
  source: "src/qzvm/aot/{qzvm.js,guest_entry.c,sortwork.ts,audit_diff.js,glue_audit.js,audit_corpus22.js,audit_corpus29.js} + test/m6b-poc/e2e_cross_tier.mjs"
  affects: [aot-roadmap, aot-sort-deterministic-merge]

- time: 2026-11-06T01:12:37
  kind: decision
  summary: "语义欠账再清一项：类方法内 arguments provider 结案（静态直调点在产物 wasm 里写 __args，两档由构造一致，见 [[aot-class-method-arguments-provider]]）。剩余欠账：const K = class 别名捕获外层局部、内建子类承载（class M extends Map 静态路径）、顶层函数 arguments 双求值、C 档闭包 arguments。"
  source: "类方法 arguments provider 批次"
  affects: [aot-roadmap, aot-class-method-arguments-provider]

- time: 2026-11-07T19:18:19
  kind: decision
  summary: "语义欠账清一项：非模块顶层 const K = class 别名捕获外层局部结案（8514ae05）。别名场景合成类名错开为 __clsExpr_N 且不进 classAlias，K 退化为持有类值的普通局部，声明点求值并复用 class_expr_value 每次克隆 + class env 路径；.name 与静态表键分离（classMeta jsName / __qzStaticsName）；in-module 档实例 .constructor 回类值。剩余欠账：内建子类承载（class M extends Map 静态路径）、顶层函数 arguments 消费即清/哨兵、C 档闭包 arguments。"
  source: "src/qzvm/aot/emit/{compile-ts.js,emitter.js}, src/qzvm/aot/qzvm.js, src/qzvm/guest_entry.c, audit_corpus43/44, dynwork.ts, test/m6b-poc/e2e_cross_tier.mjs"
  affects: [aot-roadmap]

- time: 2026-11-08T09:43:17
  kind: decision
  summary: "语义欠账清一项：顶层函数 arguments 的展开实参 provider + 入口消费即清/0 哨兵结案（见 [[aot-class-method-arguments-provider]]）。展开调用点把全量数组直接写 __args（rest/非 rest 两分支）；非 rest 展开改按形参表拆包直调——qz.call_named 在 in-module 档查 guest 的 globalThis，产物函数不在那里 → 静默 0（fnArgsSpread 独立档 212 / C 档 0）；静态方法展开同改直调并去掉 self 的 undefined 占位；callee 入口读后清 0、读到 0 trap。funcMode 把 arguments 函数及其调用者统一降级 tagged（import 别名展开成目标名）。验证：audit_diff 46 批 1071 例 0 diff、glue_audit c46 16/16、跨档 83 项、m6b 12 组 + guest e2e PASS。剩余欠账：内建子类承载（class M extends Map 静态路径）、C 档闭包 arguments、静态字段持函数的展开调用（loud，非本批引入）。"
  source: "src/qzvm/aot/emit/{compile-ts.js,emitter.js,layout.js}, audit_corpus46.js, argswork.ts, test/m6b-poc/e2e_cross_tier.mjs"
  affects: [aot-roadmap, aot-class-method-arguments-provider]

- time: 2026-11-09T00:18:24
  kind: decision
  summary: "num 函数作值修两崩：funcMode 加 knownFns 白名单（非静态直调目标→函数值调用→退 tagged，否则 num 路径 call 未定义编译崩）；fn_value 加第 4 参 isNum 选 f64 ABI（否则 f64 导出收 tagged 位型 BigInt 转换错）。test_aot runTagged 尾 fn值.* 三项钉住。新页 aot-fn-value-f64-abi。"
  source: emitter.js _emitFnValue / layout.js funcMode / qzvm.js fn_value
  affects: [aot-fn-value-f64-abi]

- time: 2026-11-09T08:18:22
  kind: decision
  summary: "语义欠账清一项（JS 档）：内建子类承载结案——class extends Map/Set/Date/RegExp/Error（合成 ctor + 无自有实例字段）→ 宿主真内建实例 + 类 prototype（new_builtin_sub 用 Reflect.construct 第三参 newTarget=classObjImpl(clsId)）；method_call 宿主对象加类方法派发（原型链查 __qzClsId → classMeta 方法链）。instanceof 双路、继承方法原生、自有方法走 wasm 全通。test_aot 三项钉住。剩余欠账：① C 档内建子类（clsmeta 定长二进制不传 hostBacked，需序列化扩展 + new_builtin_sub/method_call 宿主派发/buildInstance 平行）② Array 子类（ret 转 wasm 数组句柄丢类 identity）③ 内建子类的自有实例字段/自定义构造器（仍 bump 近似，loud 于方法调用）④ C 档闭包 arguments。"
  source: "src/qzvm/aot/{emitter.js,compile-ts.js,consts.js,emit/tagged.js,qzvm.js}"
  affects: [aot-host-builtin-carrier]

- time: 2026-11-09T14:00:43
  kind: decision
  summary: "语义欠账清一项（JS 档）：Array 子类承载结案——去 hostBacked 的 Array 排除；new_builtin_sub/buildInstance 数组结果用 tagHandle（0x7FFD）保真 Array+类 prototype，不 ret（避免 arrWriteback 扁平 0x7FFB 丢 identity）。instanceof 双路、继承方法原生、自有方法走 wasm、索引/length/for-of 全通。test_aot 内建子类.Array 钉住。剩余欠账：① C 档内建子类（clsmeta 定长二进制不传 hostBacked，需序列化扩展 + new_builtin_sub/method_call 宿主派发/buildInstance 平行；Array 子类现也依赖 new_builtin_sub，C 档未实现）② 内建子类的自有实例字段/自定义构造器（仍 bump 近似）③ C 档闭包 arguments。"
  source: "src/qzvm/aot/{emitter.js,qzvm.js,test_aot.js}"
  affects: [aot-host-builtin-carrier]

- time: 2026-11-09T14:44:38
  kind: decision
  summary: "语义欠账清一项（JS 档）：内建子类自有实例字段结案——hostBacked 放宽为 !!bpName && !ctor；带字段时基类由 Reflect.construct(new_builtin_sub) 构造、合成 ctor 只补本类字段默认值（hostBacked 跳过 super；字段默认值走 qz.object_set 写宿主属性，不直写 wasm 内存）；this.x 读写运行期派发；class_env_get 补 HOST_HI 使字段初值捕获外层变量可用。test_aot 六项钉住；46 corpus 全 0 diff；glue 5/5。corpus44 两处陈旧 unsupported 标记清理。剩余欠账：① C 档内建子类（含带字段；clsmeta 定长二进制不传 hostBacked，需序列化扩展 + new_builtin_sub/method_call 宿主派发/buildInstance 平行；libqzvm.wasm 可增量构建，m6b e2e 用 node WASI 跑）② 内建子类自定义 ctor（含计算 super 参数，仍需 bump 近似/loud）③ C 档闭包 arguments。"
  source: "src/qzvm/aot/{emit/emitter.js,emit/tagged.js,qzvm.js,test_aot.js,audit_corpus44.js}"
  affects: [aot-host-builtin-carrier]

- time: 2026-11-09T15:17:48
  kind: decision
  summary: "语义欠账清一项（C 档 / in-module）：内建子类承载结案——免改 clsmeta 定长二进制（new_builtin_sub 实参含 clsId/parentNameId；字段初值走 emitter 后续 ctor 调用 + qz.object_set）。guest_entry.c 增 qz_guest_new_builtin_sub（JS_CallConstructor + __qzClsId 标记 + 0x7FFD 句柄）+ method_call/instanceof_op/instanceof_dyn/prop_get 的宿主（0x7FFD）__qzClsId 分支。e2e_bsub.mjs 4 项（Map/Array/Error 继承+自有+字段+instanceof+.constructor）PASS；m6b e2e 全绿。剩余欠账：① 内建子类自定义 ctor（含计算 super 参数，两档仍 bump 近似/loud）② C 档闭包 arguments ③ 类表达式静态字段逐次求值初始化（JS 档 unsupported 族）。"
  source: "src/qzvm/guest_entry.c, test/m6b-poc/e2e_bsub.mjs"
  affects: [aot-host-builtin-carrier]

- time: 2026-11-09T18:14:19
  kind: decision
  summary: "内建子类承载系列全部结案（JS+C 两档）：① 合成 ctor 内建子类宿主承载 ② Array 子类（tagHandle 保真数组+类 prototype）③ 自有实例字段（object_set 写宿主属性，hostBacked 跳过 super）④ C 档 new_builtin_sub + method_call/instanceof/prop_get 的 __qzClsId 派发 ⑤ super.method() 内建父方法（protoCls WeakMap 跳过用户类原型避免覆盖递归）。验证：test_aot 全绿（内建子类 8 项）+ 全 46 corpus 0 diff + 全 m6b e2e 绿 + glue 5/5。剩余欠账（均为 loud、非静默错值）：① 类表达式/函数内 class 静态字段逐次求值初始化（静态表按类名共享；需按 clsId 克隆 + 创建点静态初始化）② 内建子类显式 ctor + 用户子类继承宿主承载类（bump 调 host ctor 基类缺失；需 hostBacked 沿用户子类传播）③ arguments at 动态派发/构造器/访问器（无静态 provider）④ super.m 作值引用。"
  source: "src/qzvm/aot/{emit/*,qzvm.js}, guest_entry.c, test/m6b-poc/e2e_bsub.mjs, audit_corpus*"
  affects: [aot-host-builtin-carrier]

- time: 2026-11-09T21:06:20
  kind: decision
  summary: "语义欠账清一项（JS 档）：类表达式静态成员结案——工厂/对象属性/函数内别名形式的 class 表达式（每次求值克隆独立 clsId）现支持静态字段/静态块。机制：collectClasses 为这类类合成 __qz_sei 静态方法（this.x = <init> 语句，含 static 块原语句，TS factory 节点用 ts.setTextRange 补源位置否则 getStart 崩）；创建点在 qz.class_expr_value 返回 clone 后立即 call __qz_sei(clone)，写 clone 自有静态桶。宿主侧：class_expr_value 标 isClone、classObjImpl 给克隆 __qzStaticsName 加 \\u0000+clsId 后缀隔离静态桶、prop_get 的 HOST_HI 分支对类对象(name 未命中)回退查 statics 表（修动态 (C as any).x 读 undefined）。派发/读：this.x 于静态方法走 static_get_dyn/static_set_dyn（按运行时 clsId 查 clone 桶）。范围：仅独立档（JS 宿主）；in-module 档动态类值的静态访问端未接 → 仍 loud 拒绝；私有静态字段(#C#x 键空间不同)、动态父(class extends 形参，class_value_dyn 幂等不克隆)、函数/块内 class 声明(嵌套 decl 走提升路径)、静态初始化捕获工厂局部(env 创建点不可见) 均仍 loud。验证：audit_corpus45 23/23（5 例由 unsupported 转正）、test_aot「工厂类表达式.静态字段隔离+块+方法this」=7:5:9:7、全 46 批 0 diff、glue 5/5、m6b 13 组 PASS；stash 失败前复现 5 例 DIFF。剩余欠账：嵌套 class 声明静态、显式 ctor 内建子类、arguments 动态/ctor/accessor、ret 扁平化子类 identity、super.m 作值。"
  source: "src/qzvm/aot/emit/{emitter.js,tagged.js}, qzvm.js, audit_corpus45.js, test_aot.js"
  affects: [aot-roadmap]

- time: 2026-11-10T00:09:26
  kind: decision
  summary: "动态父类（工厂形参/mixin）下 super.<prop> 读/写已支持（JS 档）：新增 qz.super_prop_get_dyn(recv,homeId,mid)→i64 与 qz.super_prop_set_dyn(recv,homeId,mid,value)→void。读沿运行时父链（chainNext）查 getter 调之/普通方法 loud/否则 undefined（数据字段不在原型上）；写查 setter 调之/否则 JS [[Set]] 在接收者实例上建自有字段（host 直写 mem 槽，与 prop_set INST_HI 一致）。emitter 用 _inModuleLink 保持 C 档 loud 拒绝（C 侧未实现该原语）。corpus44 dynamic-parent-super-read/assign 由 unsupported 转 supported（78/78,0 diff）。"
  source: "session: aot dynamic-parent super.prop"
  affects: [aot-roadmap, aot-host-builtin-carrier]

- time: 2026-11-10T02:01:53
  kind: decision
  summary: "类方法 arguments 与 rest/>4 形参混用已支持（两档）：移除 _mEnter 中 rest+arguments / >4形参+arguments 的编译期 throw。arguments 读自 __args 全量实参数组（调用点写入），与形式参槽/ 独立——class 体 strict 无 arguments↔形参别名，故 rest/overflow 不影响 arguments 正确性。_emitMethodArgsForProvider 重写：从全量数组 slice 出 rest 槽（slice(restIdx)）与 >4 的  槽（slice(3)，约定 ovf[0] 哑元），避免参数副作用重求值；4 调用点传 astParams。corpus44 class-args-rest-formal/many-formals 由 unsupported 转 supported（78/78,0 diff）。dyn-dispatch/extracted-value/spread/void/getter/ctor 仍由 _assertNoArgsProviderTarget 或各自守卫 loud。"
  source: "session: aot arguments rest/overflow"
  affects: [aot-roadmap]

- time: 2026-11-10T03:01:50
  kind: decision
  summary: "动态派发/void 方法下类方法 arguments 已支持：动态 method_call 路径（_emitDynMethod 尾部）在「同名类方法有用 arguments 者」时，调用点先构建全量实参数组并写 __args（qz 全局），再走 method_call——method_call 宿主 ABI 不携实参个数，无法自建 __args，故由调用点提供。ovf 槽从全量数组 slice(3) 取（避免重求值）。原 _assertNoArgsProviderTarget 抛错从该路径移除（提取值路径 1330 仍保留 loud）。corpus44 class-args-dyn-dispatch/class-args-void-method 转 supported（78/78,0 diff）。仍 loud：extracted-value、spread-call、getter、ctor 的 arguments。"
  source: "session: aot dyn-method arguments"
  affects: [aot-roadmap]

- time: 2026-11-10T03:19:45
  kind: decision
  summary: "构造器内 arguments 已支持：_emitCtorBody 传 needsArgs=_methUsesArgs(ctor)；_emitNewCall 普通 ctor 直调路径在 ctor 体用 arguments 时，把全量实参一次求值成数组写 __args（全局），4 个实参槽从数组回读（免重求值，新增嵌套 _expEnter 槽）。arguments guard（tagged.js:506）因 needsArgs 已设 varMap['arguments'] 而正确绕过。corpus44 class-args-ctor 转 supported（78/78,0 diff）。仍 loud：getter/setter、extracted-value、spread-call 的 arguments（host 派发无 provider）。"
  source: "session: aot ctor arguments"
  affects: [aot-roadmap]

- time: 2026-11-10T03:35:09
  kind: decision
  summary: "提取方法作值再调用下 arguments 已支持（JS 档）：classMeta 方法项加 usesArgs 标志；prop_get 的绑定函数（c.m 作值）在被调方法 usesArgs 时先 exportsRef.qzs_setargs(arrWriteback(args)) 写 __args 全量实参（含 undefined→TAG）再调导出。tagged.js:930『成员取值为值』loud 降为仅 C 档（_inModuleLink）——C 档无绑定函数宿主 provider，保持编译期拒绝。corpus44 class-args-extracted-value 转 supported（78/78,0 diff）。仍 loud：spread-call、getter/setter 的 arguments。"
  source: "session: aot extracted-value arguments"
  affects: [aot-roadmap]

- time: 2026-11-10T03:48:39
  kind: decision
  summary: "展开实参调用下类方法 arguments 已支持（JS 档）：method_spread 宿主调 method_call 前写 __args=arr（arr 即全量实参数组句柄；非 arguments 方法不读，无副作用）。emitter 展开调用点的 _assertNoArgsProviderTarget 降为仅 C 档（_inModuleLink）——C 档 method_spread 宿主写不了 __args，保持编译期拒绝。corpus44 class-args-spread-call 转 supported（78/78,0 diff）。仍 loud：getter/setter 的 arguments。"
  source: "session: aot spread arguments"
  affects: [aot-roadmap]

- time: 2026-11-10T03:59:57
  kind: decision
  summary: "getter/setter 内 arguments 已支持（JS 档）：_emitMethodBody accessor 在 _methUsesArgs 时按 needsArgs 编译（仅 JS 档，!mth.accessor||!_inModuleLink）；classMeta getter/setter 项加 usesArgs；prop_get getter 派发写 __args=arrWriteback([])（getter 恒 0 实参）、prop_set/super_prop_set_dyn setter 派发写 __args=[v]（setter 恒 1 实参）。C 档访问器宿主派发写不了 __args → 保持 loud（guard 保留）。至此 corpus44 的 class-args-* 全族（dyn-dispatch/extracted/spread/void/getter/ctor/rest/many）均 supported。"
  source: "session: aot getter/setter arguments"
  affects: [aot-roadmap]

- time: 2026-11-10T04:15:23
  kind: decision
  summary: "类表达式静态字段初值捕获工厂局部已支持（JS 档）：把 clsExprSupported 判定提前到 lostStatic 校验前；类表达式静态**字段**初值的引用并入 capSetC（sei 在创建点执行，env 可见 → 每 clone 各持初值）。静态**块**引用拆到独立 staticBlockRefsC，类表达式仍按块引用 loud（块执行点/TDZ 不可控，如 static { C2.x = n } 引用待赋值 const，AOT 侧不复制 TDZ）。corpus43 factory-static-init-captures-outer 转 supported；factory-static-block-captures-outer 保持 unsupported（loud）。20/20,0 diff。"
  source: "session: aot factory static field capture"
  affects: [aot-roadmap]

- time: 2026-11-10T04:25:23
  kind: decision
  summary: "super.<method> 作值已支持（JS 档）：新增 qz.method_value(ownerClsId, mid) → 该类实例方法的可调用值（未绑定 this；调用时按 call-time this 分派，支持 >4 实参/ 与 usesArgs→写 __args）。emitter 的 super.prop 读分支在父链找到非访问器方法时不再 throw，改为 emit method_value(cl.id, strId)；C 档保持 loud（in-module 无此原语）。corpus44 super-method-as-value 转 supported（78/78,0 diff；typeof g='function'，g() 调通）。"
  source: "session: aot super.m as value"
  affects: [aot-roadmap]

- time: 2026-11-10T04:39:05
  kind: decision
  summary: "num 展开调用缺参已支持为 NaN：emitSpreadCall 中对 num 被调，越界读（undefined）不再 unreachable trap，改填 f64 NaN（undefined 参与算术的 JS 结果，如 f(...[1]) 的 b 位 → a*10+NaN=NaN）。非展开路径仍编译期拒绝（能在编译期知实参<形参）。corpus46 fn-spread-num-missing 转 supported（18/18,0 diff）。"
  source: "session: aot num spread missing"
  affects: [aot-roadmap]

- time: 2026-11-10T05:23:06
  kind: decision
  summary: "嵌套 class 声明现每求值物化为动态 clone（JS 档），补齐 5 个 loud 边界：A) _collectLocals 把函数内 class 声明名并入局部；B) _classOfExpr/_isClassName 对局部/捕获类名返回动态（_isDynClsBinding）；C) class 声明语句发 class_expr_value(clone)+env+sei 静态初始化，存入局部；E) clsExprSupported 纳入 _isNestedDecl、放宽其 lostDecl/静态 loud、块引用并入 capSetC（嵌套类在函数体内执行无工厂 TDZ）；F) _emitNewCall 对被遮蔽类名走 new_dynamic（读局部 clone 值），并在 ctor 用 arguments 时于动态路径写 __args（编译期知实参个数）。C 档（in-module）全部 guard 保持旧行为（提升静态、捕获 loud）。corpus30/43/45 共 5 个 case 转 supported（全 0 diff）。"
  source: "session: aot nested-class dynamic clone"
  affects: [aot-roadmap]

- time: 2026-11-10T05:42:07
  kind: decision
  summary: "类计算属性名方法（运行期字符串名）已支持（JS 档）：collectClasses 对非 Symbol 的计算方法名分配合成名（$c<n>）并记录 {synth, expr}；ClassExpression/class 声明创建点在 clone 后发 qz.class_add_method_dyn(cloneVal, 运行期名, 合成名strId) —— host 深拷贝 meta.methods/staticMethods（_ownDyn）后注册 name→synth 条目，多 clone 各持不串味。C 档（in-module）保持 loud（collectClasses 内 throw）。corpus44 class-expr-computed-method-capture 转 supported（78/78,0 diff）。仍 loud：factory/closure static-block（TDZ 耦合）、fn-args-host-direct（embedder ABI）。"
  source: "session: aot computed method name"
  affects: [aot-roadmap]

- time: 2026-11-10T05:49:33
  kind: decision
  summary: "0 参导出函数由宿主直调时的 arguments 已支持：emitFunc 的 needsArgs 入口，__args 未设（=0）时——0 参函数缺省 qz.empty_array（arguments=[]），>0 参仍 unreachable（宿主 padding 使实参个数不可辨 → loud，绝不静默）。避免把 0 参导出函数的宿主调用 trap。corpus46 fn-args-host-direct 转 supported（18/18,0 diff）。仅剩 factory/closure static-block（TDZ 耦合）2 个 loud。"
  source: "session: aot host-direct arguments"
  affects: [aot-roadmap]

- time: 2026-11-10T06:04:58
  kind: decision
  summary: "类表达式/嵌套声明的静态块捕获工厂局部：新增『写模块级外部绑定』检测——静态块若有赋值目标基名为 declaredNames 中但**非捕获名**（如 TDZ 的 C2.x = n，C2 是待赋值 const）→ 该块不并入捕获 env、保持 loud；否则（纯 lambda/局部声明块如 const f=()=>n）并入 capSetC，sei 在创建点执行 env 可见 → 支持。_mergeBlk = clsExprSupported && !_blkWriteOuter。C 档（clsExprSupported=false）仍 loud。corpus44 closure-in-static-block-loud 转 supported（78/78,0 diff），factory-static-block-captures-outer 仍 loud（检测命中）。至此仅剩 1 个 unsupported。"
  source: "session: aot static-block safe capture"
  affects: [aot-roadmap]

- time: 2026-11-10T08:56:19
  kind: decision
  summary: "顶层类 static 块/字段初值改为**定义点 eager 执行**（JS 语义），修复惰性静默错值：此前 statics 仅在新静态访问点惰性初始化，故 static 块若有副作用（写模块级 var/调用函数）而未被静态访问/仅被 new 触发 → 副作用永不发生（实测 AOT counter=0 vs JS=5）。做法：compile-ts.js 把顶层类声明纳入 modStmts（仅用于定义点发射），tagged.js class-decl 分支对非 dyn 顶层类调 _emitStaticsChainGuard（statics_ready 幂等，内部静态访问仍带惰性守卫——前向引用读 B.y 会按需初始化 B）；touched 对类声明只扫静态块/静态字段初值（方法体是独立 wasm 函数，另经 fns 检查，避免误判 interp 冲突）；emitFunc 对 __module_init 的直接顶层类声明名从 locals 剔除（已提升、非局部，避免误走 dyn clone 分支；嵌套在其它语句里的类声明仍 clone）。按源码序交错执行（类后模块语句能读到块副作用）。test_aot 加 eager + 交错顺序回归。全批 0 diff、glue 5/5、e2e PASS。C 档同一守卫（qz.statics_* 原语）亦生效。"
  source: "probe: let counter=0; class C{static{counter=5}}; new C(); → AOT 0 vs JS 5"
  affects: [aot-roadmap]

- time: 2026-11-10T09:07:26
  kind: decision
  summary: "顶层别名类表达式  的 static 初始化也在**定义点** eager 执行：此前该形式只把 C 当类名别名（_emitBindingDecl 存 undefined、类值不物化），静态初始化仍惰性 → 有副作用的 static 块永不跑（实测 AOT c=0 vs JS c=4）。修：_emitBindingDecl 的顶层别名类表达式分支在存 undefined 后调 _emitStaticsChainGuard(synthName)。赋值形式  本就走类表达式求值路径、已正确（实测 6）。加 test_aot 回归。全批 0 diff、glue 5/5、e2e PASS。"
  source: "probe: const C=class{static{c=4}}; run(){return c} → AOT 0 vs JS 4"
  affects: [aot-roadmap]

- time: 2026-11-10T09:07:46
  kind: evidence
  summary: "补正上一条别名类表达式 summary 中被 shell 吞掉的两处：被修复形式为 const C = class { static {…} }（顶层别名类表达式）；已正确形式为 let C; C = class {…}（赋值，走类表达式求值路径）。"
  source: correction for f3586659 brain entry
  affects: [aot-roadmap]

- time: 2026-11-10T09:21:53
  kind: decision
  summary: "构造器 rest 形参修复：_emitNewCall 的静态 ctor 路径此前按槽逐个传单个实参，rest 槽收到标量 → xs.length 得 undefined（AOT undefined vs JS 3）。修：检测尾形参 dotDotDotToken（sRest），两分支（ctorNeedsArgs 用 arguments / 普通）在该槽分别用 args.slice(i) 数组字面量 或 ta.v.slice(i)（qz.method_call \"slice\"）打包。覆盖 constructor(...xs)、constructor(a,...xs)、ctor 同时用 arguments+rest。>4 实参仍按既有 loud 拒绝。test_aot 加两回归（9902、6）。全批 0 diff、glue 5/5、e2e PASS。"
  source: "probe: class C{constructor(...xs:number[]){this.v=xs.length}} new C(1,2,3).v → AOT undefined vs JS 3"
  affects: [aot-roadmap]

- time: 2026-11-10T09:44:54
  kind: decision
  summary: "构造器展开实参 + rest 修复：new C(...a) 时 _emitNewCall 的 rest 段此前从空 args（=[]）构建数组 → rest 得空数组（AOT 0 vs JS 5）。修：new-spread 路径把运行期实参数组 t.y 作为第三参 spreadArr 传给 _emitNewCall，rest 槽改用 spreadArr.slice(i)（qz.method_call \"slice\"）；且当 argSrc 且 ctor 用 arguments 时令 __args=spreadArr（spreadArr 即全量实参数组，此前 ctor 读 __args 得残留 → unreachable trap）。另：rest 形参在槽 0..3 时 >4 实参合法（多余全进 rest 数组），放宽 new 最多 4 参 限制。test_aot 加 new C(...a) rest=5、spread+arguments=6 回归。全批 0 diff、glue 5/5、e2e PASS。"
  source: "probe: class C{constructor(...xs){this.s=xs.length}} new C(...[1,2,3,4,5]).s → AOT 0 vs JS 5"
  affects: [aot-roadmap]

- time: 2026-11-10T10:08:26
  kind: decision
  summary: "两处 rest 转发修复：(1) super(...arr) 展开调用此前 loud 拒绝（SpreadElement）；_emitSuperCall 增分支：求值运行期数组按父 ctor 形参表拆到槽（rest 槽 slice），父 ctor 用 arguments 时令 __args=数组。(2) 提取方法 + rest 形参静默错值：JS 宿主 bound function（qzvm.js prop_get 原型方法绑定 line ~1527 与 method_value line ~2582）把单个实参传给 rest 槽 → xs.length=undefined；按 classMeta 的 n(总形参数)/rest，令 a[restIdx]=arrWriteback(args.slice(restIdx))（restIdx=n-1<4）。覆盖 o.m 提取、super.m 提取、.call/.apply/.bind。test_aot 加 super(...arr) 混合+arguments、提取 rest/固定+rest/super 提取 rest 回归。全批 0 diff、glue 5/5、e2e PASS。"
  source: "probe: super(...ys) → 不支持的表达式 SpreadElement; g=o.m; g(1,2,3) rest 方法 → undefined"
  affects: [aot-roadmap]

- time: 2026-11-10T10:28:51
  kind: decision
  summary: "funcMode 选择修正：形参全 number 形状但**带默认值/rest/解构**的函数此前仍判为 num 模式（allNum 只看 type.kind===NumberKeyword），随后 _emitParamPrologue 在 num 模式 loud 拒绝（f64 ABI 无 undefined/数组）。修：allNum 额外要求 ts.isIdentifier(p.name) && !p.initializer && !p.dotDotDotToken → 这类函数退 tagged（默认值/rest 正常求值）。解构形参本因类型非 number 已退 tagged（无变化）。test_aot 加 num 形状默认参数=9、rest=7 回归。方法/箭头/构造器默认参数一并覆盖。全批 0 diff、glue 5/5、e2e PASS。"
  source: "probe: function nd(a:number,b:number=a*2):number{return a+b} nd(3) → 编译期 [num] 形参默认值不支持"
  affects: [aot-roadmap]

- time: 2026-11-10T11:11:44
  kind: decision
  summary: "C 档（in-module）实例方法作值改为 loud：此前 const g = o.m 静默返回 undefined（JS 是函数值），且后续调用得 0。根因——实例为**所有全局字段**分配槽（emitter _instSize 按全局 fieldMap），方法名也有一槽（恒未赋值 undefined），C 宿主 prop_get 0x7FFE 字段分支读到该槽（界内）即返回 undefined，永不到方法判断。修：界内字段槽若为 undefined 哨兵（0x7FF9<<48）且该名在 classMeta 方法链 → qz_set_throw（C 侧无法把 wasm 蹦床物化成可调用闭包）；真实字段/普通未赋值字段原样返回。实测 typeof o.m / const g=o.m;g(...) 现 loud，o.v 字段、o.m(3,4) 正常调用、o.zzz 普通属性仍正确。e2e 全 PASS（无负载依赖提取方法）、全批 0 diff、glue 5/5。JS 档提取方法已支持（bound function 打包 rest + method_value），C 档按 loud-over-silent 原则拒绝。"
  source: "probe: const g=o.m; g(1,2,3) in-module → 0 vs JS 3；typeof o.m → undefined vs function"
  affects: [aot-roadmap]
