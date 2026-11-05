---
id: aot-sort-deterministic-merge
title: "AOT sort 自实现：两档同一确定性归并 + impldiff 钉值登记"
category: decision
status: active
tags: [aot, sort, audit]
created: "2026-11-06T00:18:38"
updated: "2026-11-06T00:18:55"
---

<!-- compiled_truth -->
## 结论

`Array.prototype.sort` / `toSorted` 在两档（独立档 `qzvm.js`、in-module 档 `guest_entry.c`）**各自实现同一个自底向上稳定归并**，不委托宿主引擎。理由不是性能而是可判定性：委托引擎时，矛盾 comparator（非严格弱序）下的**结果与比较次数都由引擎实现决定**（V8 TimSort ≠ quickjs-ng，两档之间也不保证一致），「跨档逐位一致」这条硬约束便无从检验。

## 硬约束

- **归并必须同形**：趟数、区间划分、平手取左（`cmp <= 0` 取左）三处固定 ⇒ 比较调用序列只由元素个数唯一确定 ⇒ 两档 bit-for-bit 一致，即使 comparator 自相矛盾或带状态。改一边必须同步另一边：`qzvm.js` 的 `sortRunsInto`/`sortCmp` ↔ `guest_entry.c` 的 `qz_arr_sort_op`/`qz_sort_cmp`。
- **尾部写 present-undefined（TAG），不写洞（HOLE）**：规范 `SortIndexedProperties` 把 undefined/洞计到尾部后，用 CreateDataProperty 逐个赋 undefined ⇒ `length` 不变、`k in a` 为 true、`Object.keys` 含尾部索引。`toSorted` 的副本同样保持长度 n（不是紧凑后的 m）。写 HOLE 会让尾部索引消失——两档都错且与 V8 不符。
- **无 comparator → ToString 后按 UTF-16 码元序**（不是 UTF-8 字节序，也不是 localeCompare）；C 档经 `JS_ToCStringLenUTF16`。Symbol 元素 → TypeError。
- **comparator 结果 ToNumber，NaN 视作 +0**；比较器以 `this = undefined` 调用。
- **comparefn 非 undefined 且不可调 → 真 TypeError 对象**（文案对齐 oracle(V8)：`The comparison function must be either a function or undefined: X`），且可调用性检查必须**先于任何重排**。C 档不得交回内建路径：`method_call` 的通用分支吞掉 `JS_Call` 异常 → 返回 0（静默错值）。
- **元素全程搬 tagged 位**（不经 JS 物化）⇒ POJO / 实例句柄的别名身份不变。
- C 档读写数组经统一视图 `qz_av_get`/`qz_av_set`（0x7FFB 内存块直读槽；宿主 JS 数组句柄走属性读写——本档 map/filter/slice 的结果就是 JS 数组）。分配失败等「做不动」的情形返回 `QZ_NO_CALLBACK_OP` 交回内建（loud），绝不静默错值。

## 登记机制：第三种门禁类别 `impldiff`

- `unsupported`：未实现 → 构建或运行必须 loud。
- `envdiff`（仅 glue_audit）：已裁决的**宿主引擎**差异（V8 oracle vs qzjs/quickjs-ng），只要求「两侧都出值且可不同 / 产物按容量抛而 oracle 出值」。
- **`impldiff` + `want`**：规范**未定**的行为——矛盾 comparator 下的排序结果、比较调用次数。钉住**本实现自己的**确定值，跨宿主必须相等。比 envdiff 更严：将来换算法而静默改序会被这条抓住，而 envdiff 的「只要不同就算过」会掩盖回归。规范**已定**的 sort 行为（默认排序、稳定性、undefined 尾部、TypeError 文案）一律不登记，直接与 V8 oracle 比。

## 验证面

`src/qzvm/aot/sortwork.ts` 的 13 例经 `test/m6b-poc/e2e_cross_tier.mjs`（跨档对比）；`audit_corpus22.js` / `audit_corpus29.js` 的 sort 例同时过 `audit_diff`（V8 oracle）与 `glue_audit`（qzjs + WAMRC AOT 装配）。相关：[[aot-cross-tier-semantics]]。


## Timeline

- time: 2026-11-06T00:18:38
  kind: decision
  summary: "Created this page: AOT sort 自实现：两档同一确定性归并 + impldiff 钉值登记"
  source: "sort 稳定性自实现批次（两档）"
  affects: [aot-sort-deterministic-merge]

- time: 2026-11-06T00:18:55
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: "sort 稳定性自实现批次（qzvm.js sortArrBits / guest_entry.c qz_arr_sort_op / audit_diff.js impldiff）"
  affects: [aot-sort-deterministic-merge]
