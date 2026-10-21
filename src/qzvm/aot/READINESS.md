# AOT 生产级就绪度评估（2026-10-21 实证）

结论：**距生产级有明显差距**，且障碍分三类，性质完全不同。以下全部为实测数据，非估计。

## 一、功能覆盖（真实代码库实测）

样本：zod 4.6.7 的 125 个非测试/非基准 .ts 源文件（332 个含测试）。

方法：逐文件跑 `emitter.compileTS()`，统计成功/失败类别。
脚本：`src/qzvm/aot/coverage_real.js`（可复现）。

**结果：成功 8/125 = 6.4%**

失败按阻塞点排序（注意：一个阻塞点会连带其整个传递依赖树失败，故计数不代表独立缺陷数）：

| 计数 | 阻塞点 | 性质 |
|---|---|---|
| 104 | `export default function () {}` 匿名默认导出 | 工程缺口，可修 |
| 7 | `export * from` re-export | 工程缺口，可修 |
| 3 | 同上（index 入口） | 同上 |
| 1 | `未定义捕获变量: util`（命名空间导入捕获） | 工程缺口 |
| 1 | `Cannot read properties of undefined (reading 'kind')`（emitter 内部崩溃） | **缺陷** |
| 1 | 匿名默认导出（uk.ts） | 同首项 |

关键结构性事实：`util.ts` 自身无匿名导出，但因 import 链传递到 `km.ts` 而失败。
**功能缺口沿 import 图传播**——这是覆盖率对真实代码库偏低的主因。

## 二、静默语义错误（最严重，优先级最高）

**`Map` 的读写身份断裂**：`Map.set(k, obj)` 后 `Map.get(k)` 取不到 obj。

最小复现（`/tmp/s7.ts`）：
```ts
function run(): string {
  const obj = { name: "a" };
  const m = new Map();
  m.set(1, obj);
  const g = m.get(1);
  return "gname=" + g.name + " objname=" + obj.name + " eq=" + (g === obj);
}
```

| 实现 | 输出 |
|---|---|
| V8 | `gname=a objname=a eq=true` |
| AOT | `gname=undefined objname=a eq=undefined` |

`m.size` 正确为 1，`m.has(1)` 正确为 true，但取出的值不是存入的句柄。
**现象**：不抛异常、不报错、编译成功、可运行，结果错误。

这是生产级不可接受的一类缺陷——比编译失败严重得多，因为编译失败在构建期暴露，
静默错误进入运行时才可能被用户发现。现有 889 例 corpus 差分对拍未覆盖此路径
（说明 corpus 的 Map 用例不走对象值，或未与 V8 对拍对象身份）。

## 三、已成立的部分（可信）

- 数值计算：`numWork` AOT 348ms vs 解释器 9885ms = **28.3× 快**，vs V8 2.07× 快
- 差分对拍：`audit_diff` 47/47、`stress_aot` 870 例 0 diff
- 二进制生成：`wasm-validate` + WAMR AOT 双重校验通过
- 内存：单实例固定开销 13.9→5.8 MiB（app heap 修复后）
- 跨档一致性：`cross_tier` 25 项

## 四、差距清单（按修复顺序）

| # | 项 | 类型 | 影响 | 工作量 |
|---|---|---|---|---|
| 1 | `Map`/`Set` 对象值身份断裂 | 静默错误 | 致命 | 待查（root cause 在 set/get 句柄装箱路径） |
| 2 | emitter `reading 'kind'` 崩溃 | 崩溃 | 阻断 | 小（加防御） |
| 3 | 匿名默认导出 | 覆盖 | 阻断 104/125 | 中（合成名，已有 `__clsExpr_N` 先例） |
| 4 | `export *` re-export | 覆盖 | 阻断 12/125 | 中 |
| 5 | 命名空间导入捕获 | 覆盖 | 阻断 | 中 |
| 6 | generator / async | 功能缺失 | 已登记未实现 | 大（状态机） |
| 7 | corpus 需补对象值 + 与 V8 对拍 | 验证 | 防回归 | 中 |

## 五、就绪度判断

- **数值/计算密集场景**：可用。已在真实负载验证，性能优势明确。
- **通用 TS 应用场景**：不可用。6.4% 真实库覆盖 + Map 静默错误两项独立致命。
- **关键是第 1 项必须先修**：静默错误存在时，任何覆盖率数字都不可信——通过编译不代表语义正确。
