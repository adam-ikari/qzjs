---
id: aot-generic-compiler-target
title: "AOT TS→wasm 是通用编译目标：import 面由 TS 源码决定，不绑定 qzjs"
category: decision
status: active
tags: [decision, aot, wasm, architecture, generic]
created: "2026-10-14T06:39:19"
updated: "2026-10-15T13:03:40"
---

<!-- compiled_truth -->
## 结论

**AOT 的 TS→wasm 是通用编译目标，不绑定 qzjs。**

wasm 模块的 **import 面由「内联 / 外部」判据决定**（用户裁决 2026-10-15 明确措辞）：

- 代码里**能内联**的部分（数值运算、对象/类实例分配、字符串字面量与原地拼接、控制流）→ 在 wasm 内自足，**零 import**。纯数值程序产出的 wasm 完全自洽（仅导出函数，无任何 import）。
- 需要**外部能力**的部分（动态值语义回退：句柄比较、任意值真值判定、字符串方法、闭包/方法动态派发、数组长度调整、`console.log` 输出等）→ 只 import **那部分**符号——需求驱动的**最小契约面**，不按全集注册。

因此：**任何带 wasm 引擎、且能提供所需 import 符号的运行时，都能跑 TS 编译出的 wasm**。qzjs 只是"能提供这些符号的运行时之一"，不是唯一宿主（已实证：裸 node `WebAssembly` + 数十行 stub 即可运行产物）。

## 实现（2026-10-15 落地）

`compileTS` **两趟发射**：① `Module({collectImports:true})` 采集模式——`call()`/`importFn()` 只记录触及的 `qz.*` 名，不登记、不产字节（该 module 丢弃）；② 按采集到的子集 `registerQz(m, contract)` 后真发。

**必须两趟的理由**：import 索引要在 `declareFunc` 之前定妥（`funcidx = codeIdx + imports.length`），无法边发射边补登记。

实测收缩（同一份源码，修前/修后 import 数）：纯数值 `fib` 0/0（零 import 自洽）；`{a:1}+console.log` 30/**1**（只 `log`）；`mix.ts` 30/**10**；`strwork.ts` 30/**4**；`cls.ts` 30/**8**。

## 多文件 / 模块内联（2026-10-15 落地，全形态）

`compileTS` 用 tsc `createProgram`（现成模块解析器，不自研模块图遍历）取 `program.getSourceFiles()` 全部 `.ts`；**各模块顶层函数/类编进同一 wasm 模块**（跨文件调用 = 同模块内 `call`，零额外 import）。支持：

- `import { x as y }` 具名 + 别名（`Emitter._fnName` 折回目标导出名）。
- `import d from './m'` 默认导入（折回目标的**命名**默认导出；匿名默认导出显式报错）。
- `import * as M from './m'` 命名空间导入：`M.member(...)` 折回目标顶层函数（`checker.getExportsOfModule` 穿透 re-export，含 `M.default`）。
- `import { C } from './m'` 导入类 + `new C()`（`classAlias` → `_className`，`_computeStaticVars`/`_emitNewCall` 接入）。
- re-export 链穿透；外部模块（import 来自非源码文件）→ **显式报错**，不静默丢绑定。

**与 import 面的关系**：多文件内联是**编译期**折叠（跨文件调用变同模块 `call`），不改变上面「内联/外部」判据 —— 多模块本身不引入 import；只有语言级动态语义需求才引入。

## 判定与验证

- 回归门 `src/qzvm/aot/test_aot.js`（node WebAssembly 直跑，无需 wamrc）：`runMultiFile`（默认/混合/命名空间/default 成员/外部报错/匿名报错/导入类）+ `runInterp`（interp 跨文件重写与执行）。

## 推论（对设计的约束）

1. `qz.*`（AOT 值原语：`qz.add`/`qz.str_len`… f64 NaN-box）是**需求驱动的最小契约**，不是 qzjs 私有 ABI。命名/签名应视为**可复用的 wasm-host 接口面**。
2. in-module 的 `qz_host.*`（宿主能力 import）与 AOT 的 `qz.*`（值原语 import）是**两套独立 import**，各由需求决定；即使都含 `qz` 前缀也仅命名分区，语义不冲突（不同 import module 名）。
3. 通用工具定位 → 设计时**不假设** qzjs 专有特性；wasm 产物应能在裸 wasm 引擎 + 符号提供者上运行。

## 影响

- AOT 文档/README 若暗示"qzjs 专属编译器"，须更正为"通用 TS→wasm 编译器 + qzjs 为符号提供者之一"。
- `IN_MODULE_DESIGN.md` §10.6 应强调：`qz.*` 面是通用契约，未来可被第三方 wasm 宿主实现。


## Timeline

- time: 2026-10-14T06:39:19
  kind: decision
  summary: "Created this page: AOT TS→wasm 是通用编译目标：import 面由 TS 源码决定，不绑定 qzjs"
  source: "用户裁定 2026-10-14"
  affects: [aot-generic-compiler-target]

- time: 2026-10-14T06:39:19
  kind: decision
  summary: "TS→wasm 通用工具：import 面由 TS import 决定，零 OS 需求则零 import；任何能供符号的 wasm 运行时皆可运行"
  source: "用户裁定 2026-10-14"
  affects: [aot-generic-compiler-target]

- time: 2026-10-15T04:32:07
  kind: decision
  summary: "按需 import 落地（两趟发射采集契约面）+ 明确判据为「内联/外部」而非 TS import 语句：纯数值 0 import 自洽；tagx 30→1、mix 30→10、strwork 30→4、cls 30→8。标注未做项：编译器仍不解析 TS import/export（无多模块）。"
  source: "用户裁决 2026-10-15（内联/外部判据）+ emitter.js/wasm-encoder.js 实现"
  affects: [aot-generic-compiler-target]

- time: 2026-10-15T05:36:28
  kind: decision
  summary: "多文件内联落地：compileTS 用 tsc createProgram（现成模块解析器，不自研模块图遍历）取 program.getSourceFiles() 全部 .ts，各模块顶层函数/类编进同一 wasm 模块（跨文件调用=同模块内 call）。import { x as y } 别名折回目标导出名（Emitter._fnName，两处 call 解析接入）；顶层同名冲突显式报错不静默覆盖。实测 mathx.ts+mainx.ts(别名 inc as bump) → run(40)=42、0 import；同名 dup → 报冲突。守门 test_aot.js runMultiFile。未做：默认导入/命名空间导入/重导出（显式报错）。"
  source: "用户指示 2026-10-15：TS 内联工具不必自己实现（用 tsc 现成解析）+ 实现"
  affects: [aot-generic-compiler-target]

- time: 2026-10-15T13:02:58
  kind: decision
  summary: "多文件 import 全形态落地：① 默认导入 import d from './m'（折回目标命名默认导出；匿名默认导出显式报错）；② 命名空间导入 import * as M → M.member(...) 折回目标顶层名（经 checker.getExportsOfModule 穿透 re-export，含 M.default）；③ 导入类 new C（classAlias，Emitter._className，_computeStaticVars/_emitNewCall 接入）；④ re-export 链穿透。修两处既有 bug：(a) collectClasses 每文件调用却遍历整个 _classList 重复 declareFunc → 编码崩（多文件含类即触发），改为仅声明本文件新增类；(b) interp TS→JS 重写：同名导入换新节点（否则 tsc 模块 transform 残留 (0, mod_1.x)）+ 剥 export default 赋值语句。外部模块 ns 导入原静默空表（后续误报未定义捕获变量）→ 改显式报错。守门 test_aot.js runMultiFile + runInterp（默认/混合/命名空间/default 成员/外部报错/匿名报错/导入类/interp 多文件执行）。"
  source: "会话 2026-10-15：按用户意图补齐多文件 import 全形态"
  affects: [aot-generic-compiler-target]

- time: 2026-10-15T13:03:40
  kind: decision
  summary: "compileTS 多文件：默认/命名空间/导入类/re-export 全形态；多文件为编译期折叠，不改变内联/外部 import 判据"
  source: "会话 2026-10-15 落地多文件 import 全形态"
  affects: [aot-generic-compiler-target]
