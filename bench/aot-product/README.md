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
