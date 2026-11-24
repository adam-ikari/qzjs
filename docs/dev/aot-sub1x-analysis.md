# AOT 低于 1× 负载根因分析（2026-11-23）

## 范围与口径

CI 基线 run `45139911795`（commit `23d621f5`）中低于 1× 的负载共四个：

| 负载 | AOT p50 | interp p50 | speedup |
|---|---:|---:|---:|
| `jsonWork(30000)` | 652.184 ms | 38.138 ms | 0.058× |
| `validationWork(200000)` | 3626.740 ms | 44.637 ms | 0.012× |
| `objWork(30000)` | 37.249 ms | 4.113 ms | 0.110× |
| `zodbench.bench(100)` | 114.232 ms | 0.508 ms | 0.004× |

诊断方法：在生成的 glue 实例化 WASM **之前**包装全部 `qz.*` import，分别清零后统计单次调用的
函数名、次数和累计时间；再单独追踪 `method_call` 的方法名与接收者 tag。次数是精确计数；
包装器自身会增加开销，故诊断里的绝对毫秒只用于同一进程内的相对归因，生产数值以 CI 基线为准。

## 总根因

四个负载都不是算法回退，而是 **tagged 值的宿主跨界税**：WASM 静态指令只能直接处理裸 `f64`
和线性内存里的 POJO 槽；只要值来自宿主内建、宿主对象/类实例，或操作需要 JS 动态语义，
emitter 就必须发 `qz.*` import。每次 import 经过 WAMR→JS shim，伴随 BigInt 解 tag、
`toJS`/`ret` 转换和句柄表维护。历史锚点（`brain aot-performance-model`）：glue 路径 `qz.add`
约 3.55 µs/次，其中原生蹦床约 133.8 ns，瓶颈是 JS shim 工作。

## `jsonWork`：12 次跨界/迭代

`JSON.parse(src)` 是宿主内建，返回 `HOST_HI(0x7FFD)` 宿主对象，而不是 wasm 线性内存里的 POJO。
后续读取宿主对象字段/数组下标不能内联，必须重新跨界。

| API | 次数/30000 iter | 诊断累计 ms | 触发源 |
|---|---:|---:|---|
| `qz.builtin` | 30000（1/iter） | 493 ms | `JSON.parse` |
| `qz.prop_get` | 180000（6/iter） | 515 ms | `o.id/o.name/o.vals` 与结果对象字段 |
| `qz.get_index` | 120000（4/iter） | 404 ms | `o.vals[0..3]` |
| `qz.restore_handles` | 30000（1/iter） | 55 ms | 循环内宿主句柄水位恢复 |

结论：每轮 12 次 `qz.*`，约 360006 次调用。数值计算内联，但所有“解析结果读取”都在宿主侧。
优化方向：让 `JSON.parse` 结果在 wasm 侧落地为 POJO，或为固定 schema 的输入提供宿主批量解析
接口；不能假定 JSON 文本恒定而缓存对象（会改变对象身份/可变语义）。

## `validationWork`：8.5 次跨界/迭代

源里的动态 `typeof` 比较、分支真值判断、字符串 `indexOf` 和 `%`/严格相等都落在 tagged 路径。
即使对象字面量字段读是内联的，类型守卫与分支条件仍逐项跨界。

| API | 次数/200000 iter | 诊断累计 ms | 触发源 |
|---|---:|---:|---|
| `qz.sne` | 800000（4/iter） | 4683 ms | 四处 `typeof ... !== "..."` 严格比较 |
| `qz.method_call` | 200000（1/iter） | 1651 ms | `v.email.indexOf("@")`（receiver 为字符串句柄） |
| `qz.rem` | 100000（0.5/iter） | 385 ms | 取模的 tagged 回退 |
| `qz.truthy` | 400000（2/iter） | 340 ms | `if` 条件 |
| `qz.seq` | 200000（1/iter） | 283 ms | 严格相等回退（类型守卫 / 分支条件） |

结论：每轮约 8.5 次 `qz.*`，共 1700005 次。`sne` 和 `method_call` 占诊断时间约 77%。
优化方向：对已知 tag/shape 做静态类型收窄，把 `typeof x !== "literal"` 和字符串原生方法
在可证明安全时内联；必须保留未知类型的宿主语义回退。

## `objWork`：2 次跨界/迭代，但不是属性读

历史记录中 POJO 字面量分配和字段读已经内联；本次计数确认没有 `prop_get`/`get_index`。
剩余两次来自对象插入序簿记和循环句柄水位：

| API | 次数/30000 iter | 诊断累计 ms | 触发源 |
|---|---:|---:|---|
| `qz.field_order_lit` | 30000（1/iter） | 70.7 ms | 对象字面量把字段名表登记到宿主 `orderMap` |
| `qz.restore_handles` | 30000（1/iter） | 19.8 ms | 循环级句柄水位恢复 |

结论：2 次/iter，共 60006 次。旧锚点 `objWork=2.88 ms` 对应早期 `qz.add`×60006；
当前 37 ms 的成本已转为 `field_order_lit` + `restore_handles`。优化方向：按字段表常量缓存
插入序，直接在 wasm 内存维护顺序元数据；并让“只产生 POJO、无宿主句柄”的循环跳过
`save_handles`/`restore_handles`。

## `zodbench.bench`：真实工作全部留在宿主

产物有 559 个函数，其中 558 个 tagged、1 个 interp；但 `schema` 是宿主承载的类实例。
`method_call` 追踪显示 100 次全部是：

- 方法：`safeParse`
- method id：251
- 接收者 tag：`0x7FFD`（HOST_HI）

计数与诊断时间：

| API | 次数/100 iter | 诊断累计 ms | 触发源 |
|---|---:|---:|---|
| `qz.method_call` | 100（1/iter） | 196.3 ms | `schema.safeParse(...)` 直接 `fn.apply(obj, as)` 到宿主 JS |
| `qz.field_order_lit` | 100（1/iter） | 0.50 ms | 入参对象字面量 |
| `qz.prop_get` | 100（1/iter） | 0.33 ms | `r.success` |
| `qz.truthy` | 100（1/iter） | 0.13 ms | `if (r.success)` |

`method_call` 占诊断时间 99% 以上；生产口径 AOT 114.2 ms / 100 次 ≈ 1.14 ms/次，
interp 0.508 ms / 100 次 ≈ 5 µs/次。也就是说 zod 的解析逻辑在两条路径里都跑在 QuickJS
宿主解释器，AOT 路径额外支付 wasm 包装、参数转换、结果转换和三次属性/分支跨界。
全 interp 对照产物为 559/559 interp、8 B wasm，没有这层往返，所以快 200 倍以上。

这是此前 host-backed `$constructor` 修复的代价：类值必须由宿主承载以保证 zod 语义正确，
不能为性能撤销。优化方向：批量把多个 `safeParse` 调用一次性交给宿主，减少每次包装；
或在不触碰共享状态/async 的前提下把同步热函数真正翻入 wasm。后者受
`aot-zod-hotspot-measurement` 记录的 schemas/checks 共享状态与挂起语义限制。

## 已实施优化后的同口径 A/B（2026-11-24，本地）

同一 `qzjs` 二进制、同一 `bench/aot-product/run.js --rebuild`、5 次 p50；基线源码
`c6797e04` 与本轮起点 `a259d07b` 的 AOT 运行时源码完全一致。CI 基线文件未改写。

| 负载 | 基线 wasm p50 | 优化后 wasm p50 | 比值 | 说明 |
|---|---:|---:|---:|---|
| `computeWork` | 34.238 ms | 32.535 ms | 1.05× | 噪声范围内，未改数值路径 |
| `jsonWork` | 1690.643 ms | 1632.605 ms | 1.04× | `field_order_lit` 缓存实验已回退；该差异属噪声 |
| `validationWork` | 8633.842 ms | 3042.792 ms | **2.84×** | 原 1.7M 跨界降至约 300k（严格比较/null/typeof/短路内联） |

载荷从 23514 B 降至 22986 B（-2.2%）；三负载 check 均一致。`validationWork` 仍慢于
interp（0.03× vs 0.01×），但跨界热点已大幅收敛。剩余的 `qz.method_call`（200k，字符串
`indexOf`）和 `qz.rem`（100k）未优化；一次 `rem` 零余数快路径实验因破坏 `-0`/宿主回退语义
已完整回退。

`field_order_lit` 静态字段名缓存已于 2026-11-24 回退：专项 A/B 仅约 0.6ms/30k 次，远低于
本机运行间波动，不值得增加状态。回退后同口径重测：`computeWork` 28.836ms、`jsonWork`
1342.846ms、`validationWork` 2367.801ms，check 全部一致、`test_aot.js ALL PASS`；跨轮
绝对时间波动较大，因此只把跨界计数减少视为可靠收益指标。

## 优先级

1. 减少每次跨界的 JS shim 成本（最高杠杆，覆盖四个负载）。
2. 宿主内建结果（尤其 `JSON.parse`）在 wasm 侧落地，或提供批量接口。
3. 静态类型收窄消除 `sne`/`truthy`/`seq`/`rem` 的已知类型回退。
4. 缓存 `field_order_lit` 并跳过纯 POJO 循环的句柄水位维护。
5. zod 采用批量宿主调用；不要回退 host-backed 类语义。

## 复现

诊断器为一次性工具，不提交；方法是在 glue 的 `const qz = makeQzvm(...)` 后、
`WebAssembly.instantiate` 前包装 `qz.*`，记录调用次数/时间，并在 harness 中先预热再清零。
CI 基线命令见 `bench/aot-product/README.md`。
