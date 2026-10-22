# AOT 生产级就绪度评估

> **2026-10-22 更新**：第一节列的 6 类阻塞中，匿名默认导出（131 例）与
> `export *` re-export（145 例）已修复并归零。当前头号阻塞为**同名函数跨目录冲突**。
> 下面的原始测量数据保留以存证，不代表当前状态；缺陷清单见第四节。

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

## 二、静默语义错误（**已修复**，见下）

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

### 修复（2026-10-21）

**真实根因不是 Map，而是 build.js 两处丢弃 `compileTS` 返回的 `fields`（字段偏移表）**：
写 `.meta.json` 时未带 `fields`；`makeQzvm(strings,{arenaEnd})` 未传 `fields`。
→ glue 里 `fieldEntries` 恒空 → `toJS` 判据 `(mem && fieldEntries.length)` 为假
→ POJO 句柄走 `handles[idx]`（undefined）而非 `materialize()`。

影响面是**全局性**的，不止 Map：任何跨宿主边界的对象字面量都会退化。

**为什么 889 例 corpus 全绿仍漏检**：`audit_diff.js` 直调 `compileTS` 后手动
`makeQzvm(r.strings, { fields: r.fields })`，自己补了字段表，绕开 `build.js` 的
glue 装配路径。测试路径与产物路径不一致 → 缺陷在测试中不可见。

**新增验证**：
- `audit_corpus41.js`：5 例宿主容器对象值（compileTS 直调路径）
- `glue_audit.js`：走真实 `build.js build` → glue → qzjs，与 V8 对比。
  唯一能捕获装配层缺陷的测试。

验证：`glue_audit` 修复前 1/5 → 修复后 5/5；`audit_diff` 全量 corpus1..41 零 diff。

## 三、已成立的部分（可信）

- 数值计算：`numWork` AOT 348ms vs 解释器 9885ms = **28.3× 快**，vs V8 2.07× 快
- 差分对拍：`audit_diff` 47/47、`stress_aot` 870 例 0 diff
- 二进制生成：`wasm-validate` + WAMR AOT 双重校验通过
- 内存：单实例固定开销 13.9→5.8 MiB（app heap 修复后）
- 跨档一致性：`cross_tier` 25 项

## 四、差距清单（按修复顺序）

| # | 项 | 类型 | 影响 | 工作量 |
|---|---|---|---|---|
| ~~1~~ | ~~`Map`/`Set` 对象值身份断裂~~ | ~~静默错误~~ | ~~致命~~ | **已修复**（build.js 丢弃 fields） |
| ~~2~~ | ~~emitter `reading 'kind'` 崩溃~~ | ~~崩溃~~ | ~~阻断~~ | **已修复**（collectClasses 跳过无 body 成员） |
| ~~3~~ | ~~匿名默认导出~~ | ~~覆盖~~ | ~~阻断 104/125~~ | **已修复**（合成名 `__default_N`） |
| ~~3b~~ | ~~TS 重载签名~~ | ~~崩溃~~ | ~~阻断 115/332~~ | **已修复**（跳过无 body 声明） |
| ~~3c~~ | ~~跨文件同名私有函数~~ | ~~崩溃~~ | ~~阻断 107/332~~ | **已修复**（按文件前缀改名 `__m_<stem>_<name>`） |
| ~~4~~ | ~~`export *` re-export~~ | ~~覆盖~~ | ~~阻断 12/125~~ | **已修复**（无绑定可发，仅校验目标在源内） |
| ~~5~~ | ~~`new A.B()` 属性访问式构造~~ | ~~崩溃~~ | ~~阻断 86/332~~ | **已修复**（运行时求值 → `qz.new_dynamic`） |
| ~~8~~ | ~~类成员 `PropertyDeclaration` 崩溃~~ | ~~崩溃~~ | ~~阻断 8/332~~ | **已修复**（字面量成员名） |
| ~~9~~ | ~~对象 rest 解构键数上限 4~~ | ~~覆盖~~ | ~~阻断 5/332~~ | **已修复**（扩到 8 键） |
| 5b | 命名空间导入捕获 | 覆盖 | 部分已修 | 中 |
| 6 | generator / async | 功能缺失 | 阻断 12/332 | 大（状态机） |
| 6b | 内建类 `Proxy` | 功能缺失 | 阻断 75/332 | 中（宿主 trap 分发） |
| 6c | 模块级变量跨文件导出 | 覆盖 | 阻断 7/332 | 中 |
| 7 | corpus 需补对象值 + 与 V8 对拍 | 验证 | 防回归 | 中 |

## 五、就绪度判断

- **数值/计算密集场景**：可用。已在真实负载验证，性能优势明确。
- **通用 TS 应用场景**：仍不可用。当前头号阻塞是 `[tagged] 内建类 Proxy 未实现`
  （75/332，需宿主 trap 分发：get/set/has/deleteProperty/ownKeys/gOPD）。
  2026-10-22 五轮修复后，332 文件实测失败类别从 584 例降到 75 例。
- 第 1、2 项已修复。但**教训比缺陷本身更重要**：测试路径与产物路径不一致时，
  全绿的测试套件会给出虚假信心。新增 `glue_audit.js` 专门守装配层。

### 第 3、4 项修复详情（2026-10-22）

**#3 匿名默认导出**：`export default function(){}` / `export default class{}` 在 TS
符号表里 `valueDeclaration.name` 为空 → 无稳定顶层名可折回，此前整条 import 链失败。
`collectDecls` 遇带 `DefaultKeyword` 的匿名函数/类声明时**就地补合成名** `__default_N`
（节点身份不变，checker 仍指向它），后续 emit 与 import 解析走原有 `st.name.text` 路径。
interp 回退（`stripModuleSyntax`）另修一处：`target.name` 对匿名默认导出是 `"default"`，
改为从 `valueDeclaration.name` 取真名。

**#4 `export *` re-export**：该语法**不产生新绑定**——内联后模块边界已消失，目标文件的
顶层声明本就在同一 wasm 模块里，故无需发射任何代码，只需校验目标在源码集合内。
消费方 `import { x } from './relay'` 经 checker 的 `getAliasedSymbol` 自动穿透 star 链
解析到真实声明，与具名 re-export 同一路径。指向外部模块时仍显式报错。

**实测（zod 4.6.7，332 个 .ts）**：修复前头号两类阻塞为匿名默认导出 131 例、
`export *` 145 例；修复后**两类归零**。总成功数未变（10），因为剩余文件被下层阻塞
（同名冲突，见上）连带失败——功能缺口仍沿 import 图传播，与首节结论一致。

### 第 2 项修复详情（2026-10-21）

**根因**：`collectClasses` 收集类方法时不过滤 `mem.body`，TS 重载签名
（`write(fn: F): void;`）只是类型信息、无实现体，却被当成方法入列，
`emitAll` 取 `mth.node.body` 得 `undefined` → `ts.isArrowFunction` 崩。

复现源：zod `src/v4/core/doc.ts`（`Doc` 类 `write` 三个签名 + 一个实现）。

**修复**：成员循环开头跳过 `!mem.body` 的 `MethodDeclaration`；构造器仅在
`mem.body` 存在时赋值（重载签名在前、实现在后）；无 body 访问器跳过。

**附带**：`qzvm.js` 两处 `process.env.QZDBG` 调试残留（`object_get` /
`prop_set`），qzjs 无 `process` 全局，命中即 `process is not defined`。已删。

**新增验证**：`glue_corpus_overload.js`（4 例），走 `glue_audit.js` 链路。
修复前 1/4 → 修复后 4/4。

### 新发现（未修）

`audit_diff` 的 pure-wasm 路径（`instantiate` 两参、无 AOT）在「类字段为
数组字面量」时崩 `Cannot convert undefined to a BigInt`，而**同一份 wasm
经 AOT 执行正确**：

```ts
class C { content: string[] = []; add(s: string) { this.content.push(s); } }
export function f() { const c = new C(); c.add("a"); return c.content.join("|"); }
```

这是 WAMR AOT 与 wasm 解释器的语义差异，独立于本次修复（修复前即存在）。
影响面：仅 `audit_diff` 这条测试路径；产物走 AOT 不受影响。
