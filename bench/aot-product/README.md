# bench/aot-product — AOT product-level acceptance bench

验收口径见 brain `aot-roadmap`（G1–G5）。本测试台只回答一个产品问题：**AOT 让一个真实 JS 应用跑得更快/更稳/更小了吗？**（不是覆盖率。）

## 负载（三组真实形状）

| 负载 | 覆盖 | 说明 |
|---|---|---|
| `computeWork` | 纯计算循环（num 快路径） | 有界 i32 幅度（避免 i32 溢出 trap）；代表热点计算 |
| `jsonWork` | JSON→对象映射 | `JSON.parse` + 对象构造 + 属性读 + 数组索引 |
| `validationWork` | schema 校验（zod 类） | required/type/range/字符串检查 |

工作负载定义在 `workloads/aotp.ts`；解释器基线是同语义纯 JS（内嵌于 `run.js`，勿偏离）。

## 变体与口径（host 与真机同一口径）

- **wasm**：`build.js compile aotp.ts` + `glue --no-aot`（WAMR 跑 wasm 字节码）。
  真机 AOT（原生 `.aot`）需 wamrc，用 `QZJS=<真机 qzjs>` 跑同一 `run.js` 即可，口径不变。
- **interp**：同语义纯 JS，由 qzjs 解释器直接跑（interp-only 基线）。
- **计时**：每负载预热 1 次，5 次计时取 **p50 / p95**（`performance.now()` 浮点毫秒）。
- **载荷**：wasm 变体 = `wasm + interpJs` 字节数；interp-only 基线 = 负载 JS 源码字节数。

## 用法

```sh
node bench/aot-product/run.js --rebuild   # 编译并测量
node bench/aot-product/run.js             # 用已有 build/aot/aotp.* 测量
QZJS=/path/to/qzjs node bench/aot-product/run.js   # 真机二进制
```

## 准入判定（G2/G3）

- **G2**：某模块翻转须带该模块代表性负载前后 p50，≥ **1.5×** 才保留，否则回退。
- **G3**：应用总 JS 载荷（wasm+interpJs）相对 interp-only ≤ **+10%**。

## 2026-11-14 host 首次结果（无 wamrc → wasm 为 WAMR 字节码解释，非原生 AOT）

- `computeWork` 0.6×、`jsonWork` 0.04×、`validationWork` 0.01×（wasm 全部慢于 interp）。
  原因：tagged 路径每次对象/宿主内建操作跨 JS↔wasm 边界（BigInt 解 tag ~µs）。
- 载荷 wasm+interpJs ≫ interp-only 源码（微负载下 +1900%）。
- 纯 num 幅度超 i32 时 wasm `integer overflow` trap（G4 隐患）。

结论：**parse.ts 翻转未达 1.5×（wasm 侧 finalizeIssue 崩溃 + tagged 整体慢）→ 已回退（回 interp）。** AOT 提升必须靠 P2（M4 单模块合并）消除跨界，而非翻更多模块。

## M6b 合并模块路径（`run_inmod.mjs`）

`run_inmod.mjs` 把同一负载编成 `{inModuleLink:true}` 产品 wasm，与 `libqzvm.wasm`（C 侧 qzvm guest）共享 memory + funcref 表链接，`qz.*` 变模块内 `call_indirect`（非 JS shim）。host 跑在 node WebAssembly（V8 JIT ≈ 原生 wasm）。

2026-11-14 host 终值：

| 负载 | N | inmod p50(ms) | qzjs-interp p50(ms) | 比值 | 闸门 |
|---|---|---|---|---|---|
| computeWork | 200000 | 2.73 | 16.68 | **6.11×** | G1 ✓ |
| validationWork | 5000 | 1.28 | 1.54 | 1.20× | G2 ✗ |
| jsonWork | — | — | — | — | 受阻：JSON.parse 返回 host 对象，wasm 读属性 NaN（需 wasm 侧 JSON 解析器） |
| tagLoop（POJO alloc+read） | 1M | 20.4 ns/op | — | — | 边界税 ✓（非内联 qz.* call PoC ~54ns ≤ 100ns） |

载荷字节（产品 wasm）：22531 B。

**洞见（实证原则 #2）**：qzjs 本就是 tagged-value 解释器，tagged 操作它已很快；wasm tagged 每 op 走 `call_indirect` ~54ns，持平/略慢于 qzjs interp。**只有纯 num（f64 内联 vs qzjs num 装箱）大赢（6×）**。结论：AOT = 计算热点专用；tagged/alloc/suspension 代码留 interp。alloc-bearing 负载还受 no-GC bump arena 天花板（16MiB，无 per-call 复位）限制——需 GC（brain `aot-gc-rc-allocator`）才能放开。

用法：
```sh
node bench/aot-product/run_inmod.mjs --merge       # 终态：wasm-merge 静态合并单模块（qz.* 内化，验收口径）
node bench/aot-product/run_inmod.mjs               # 中间态：multi-module 动态链接（量税用途，非交付）
node bench/aot-product/run_inmod.mjs --merge --libqzvm <path>
QZJS=<真机 qzjs> node bench/aot-product/run_inmod.mjs --merge   # 真机同口径
```
**终态 = 静态单模块**（`--merge`）：`wasm-merge`（Binaryen）把 emitter 产物 + libqzvm 编译期合并成一个 wasm，qz.* 变模块内调用（合并后 import 仅剩 `qz_host.*` + WASI，无 qz.*）。multi-module（无 `--merge`）只作量税中间里程碑。

`--merge` 终态 host 结果（2026-11-14）：computeWork **6.19×（G1 ✓）**、validationWork 1.44×（G2 ✗，比 multi-module 1.2× 好——内化消 import 编解码）、tagLoop 15.1 ns/op、合并单 wasm 1.26 MiB。

依赖：`cmake -B build-inmod -DQZ_IN_MODULE=ON -DCMAKE_TOOLCHAIN_FILE=cmake/wasm32.cmake && cmake --build build-inmod --target qzvm-guest`；`wasm-merge`（Binaryen，`WASM_MERGE=<path>` 覆盖）。
