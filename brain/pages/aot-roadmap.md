---
id: aot-roadmap
title: "AOT 主线路线：emitter.js 唯一主线 + 待办优先级"
category: reference
status: active
tags: [aot, roadmap, emitter, reference]
created: "2026-10-18T06:06:51"
updated: "2026-10-18T10:40:38"
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
