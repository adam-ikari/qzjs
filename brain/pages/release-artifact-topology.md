---
id: release-artifact-topology
title: "发行产物拓扑：字节码永不独立发行，唯一稳定 API = WinterTC"
category: decision
status: active
tags: [bytecode, release, artifact, wasm, wintertc, abi]
created: "2026-10-07T15:07:14"
updated: "2026-10-07T15:41:31"
---

<!-- compiled_truth -->
# 发行产物拓扑（2026-10-07 用户拍板）

## 核心约束

1. **字节码永远与引擎实现绑定**：**JS 字节码必须与 JS 引擎绑定**，不存在跨引擎、
   跨版本的稳定字节码格式。字节码是引擎内部表示，随引擎实现一起演进，
   不构成 ABI；升级 = 引擎 + 字节码整体替换。

2. **永不保证二进制 ABI 兼容性**：引擎二进制接口（字节码格式、内部对象布局、
   C/FFI 符号面等）不承诺任何跨版本二进制兼容。**稳定 API 仅限于 qzjs 对外公开
   的 API**——WinterTC（ECMA-429 核心，见 standard-source-policy）是其核心组成，
   但稳定面不限于 WinterTC，以 qzjs 对外公开 API 集合为准；未公开内部面依赖
   = 自负风险。

3. **永不独立发行字节码**：没有「只发字节码、不带引擎」的发行版本。
   字节码总是与其生成它的引擎实现一起打包发行（字节码-引擎配对锁死）。

4. **wasm 独立可执行文件形态的对外保证 = 仅 WASI API**：wasm 产物向宿主/外部
   暴露的稳定接口只有 WASI（wasi_snapshot_preview1 等）；引擎内部接口、字节码
   格式、导入函数面均不构成对外承诺，不保证跨版本兼容。

## 真正 AOT 的定义（2026-10-07 用户澄清）

**qzjs 实现真正 AOT 的方式 = 编译 TS 代码为 JS + wasm/so**（链路 A）。
- 输入是 **TS 源码**（编译期语言），不是 JS 字节码。
- 产物 = JS（胶水代码 + 动态类型代码）+ wasm 模块，或 so（原生共享库）。
- 胶水/动态类型部分调用 qzjs 对外公开 API（WinterTC 等）。
- **与字节码无关**：AOT 链路不经 JS 引擎字节码、不经解释器字节码翻译。

**推翻**（本页历史表述）：此前「AOT 归入链路 B ELF 形态（字节码→C99→gcc）」作废。
字节码→C99 翻译不是 AOT 方式；链路 B（JS→字节码→解释/AOT 翻译）中
「AOT 翻译」一词不再用于描述 qzjs 的 AOT——qzjs 的 AOT 唯一指 TS→JS+wasm/so。

推论：qzvm-aot 归档页的 Perry 路线（字节码→C→gcc→.so + .jso）不仅被
release-artifact-topology 取代，而且**不属于 AOT 范畴**——那是字节码 native 翻译，
不是 TS 编译产物。

## 两条链路正交（2026-10-07 澄清）

### 链路 A：TS → JS + WASM / so（= 真正 AOT 链路）
- TS 源码编译为 **wasm 模块 + JS 胶水代码**（或 so），胶水调用 qzjs 对外公开 API。
- 产物**不含 JS 字节码**，与引擎内部字节码格式无关。
- 对应发行形态：JS + Wasm 组合产物、so 形态。

### 链路 B：JS → 字节码 → 解释（引擎执行链路）
- 引擎把 **JS（运行时源码/eval）编译成内部字节码**（quickjs 字节码），由解释器执行。
- **JS 字节码必须与 JS 引擎绑定**（约束 1）。
- 本链路**无 AOT**（见上）；AOT 不在此链路上实现。
- 此链路的发行形态（ELF 含引擎+字节码、wasm 引擎模块）为「引擎 + 字节码」一体打包。

**关键**：链路 A 的 wasm（TS 编译产物）≠ 链路 B 的 wasm（引擎+字节码打包）。
前者是 TS 语言输出（AOT 产物），后者是引擎发行形态。两者仅命名同形。

## 三种发行产物形态（均含「引擎 + 字节码」，无独立字节码产物）

| 形态 | 产出链路 | 内容 | 对外稳定面 |
|------|----------|------|-----------|
| **独立可运行 ELF** | … → 中间 C99 源码 → 可配置 gcc → ELF | 引擎 + 字节码（单文件原生可执行） | qzjs 对外公开 API（JS 层，含 WinterTC） |
| **Wasm 文件** | 字节码 + 引擎打包成 wasm 模块 | 引擎 + 字节码（wasm 模块内含引擎） | **仅 WASI API** |
| **JS + Wasm 组合** | 链路 A：TS→wasm+JS | JS（胶水代码 + 动态类型代码）+ Wasm（TS 编译产物，**不含字节码**） | qzjs 对外公开 API（JS 层，含 WinterTC） |

## ELF 形态专属约束

- **必须经过中间 C99 层**：ELF 不能由其它路径直接产出，链路必含一个 C99
  中间源码阶段（引擎 + 字节码被 lowering 为 C99 源码），再编译为 ELF。
  禁止跳过 C99 的「直连 ELF」产物路径。（此为发行打包路径，**非 AOT**。）
- **gcc 编译器可配置**：C99 → ELF 阶段使用的 gcc（及 flags）必须是可配置项，
  调用方可指定 gcc 路径/版本/参数，不硬编码单一工具链。

## 关系与推论

- 此决策**不推翻** bytecode-build-artifact（字节码是构建产物、非可复现产物不进版本库）：
  那条讲版本库策略，本条讲发行形态。二者正交。
- 与 standard-source-policy 一致但更宽：WinterTC 是 qzjs 对外公开 API 的核心组成，
  不是稳定面的全部。
- AOT = 链路 A（TS→JS+wasm/so），链路 B 无 AOT（推翻历史表述）。
- 推论（一律拒绝）：把字节码当稳定分发格式；跨引擎/跨版本复用旧字节码；
  引擎升级但复用上版本字节码；ELF 跳过 C99 直连产出；依赖引擎二进制 ABI
  兼容（含 wasm 产物内部面）或任何未公开内部面的调用方诉求；
  把链路 A 的 TS→wasm 产物当作含字节码的引擎发行形态；
  把字节码→C99 翻译当作 qzjs 的 AOT。

## 不变量（六个月仍需成立的判据）

- 不存在「standalone bytecode artifact」发行物。
- 外部消费者只能依赖 qzjs 对外公开 API（JS 形态，含 WinterTC）或 WASI（wasm 形态）；
  依赖其它/未公开内部面 = 自负风险。
- 三种产物形态各自为最小完整运行单元（含引擎）——除 JS+Wasm 组合形态中
  wasm 是 TS 编译产物（链路 A，不含字节码）。
- ELF 形态链路必含 C99 中间源码阶段，且 gcc 可配置。
- 引擎/字节码任何二进制接口均无跨版本兼容承诺。
- 链路 A（TS→JS+WASM/so，AOT）与链路 B（JS→字节码）不相交，不可互相代入；
  AOT 仅指链路 A。

## 术语澄清

- 「稳定 API」= qzjs 对外公开的 API 集合（以公开文档/公开头/公开导出符号为准），
  WinterTC 是其核心组成但非全部；**不是**「只有 WinterTC」。
- 「公开」判据 = qzjs 自身声明对外暴露且承诺维护的面；引擎内部 C 结构、字节码
  格式、私有符号、FFI 内部约定一律视为非公开。
- 「字节码」= 链路 B 的 JS 引擎内部字节码（quickjs 字节码）；链路 A 的 TS→wasm
  产物不叫字节码、不含字节码。
- 「AOT」= 仅指链路 A（TS→JS+wasm/so）；字节码 native 翻译（Perry 路线、
  qzvm-aot）**不叫 AOT**。


## Timeline

- time: 2026-10-07T15:07:14
  kind: decision
  summary: "Created this page: 发行产物拓扑：字节码永不独立发行，唯一稳定 API = WinterTC"
  source: "2026-10-07 用户拍板"
  affects: [release-artifact-topology]

- time: 2026-10-07T15:07:28
  kind: decision
  summary: "发行产物拓扑：字节码永不独立发行，唯一稳定 API = WinterTC；三种产物形态（ELF/Wasm/JS+Wasm）"
  source: "2026-10-07 用户拍板"
  affects: [release-artifact-topology]

- time: 2026-10-07T15:08:46
  kind: decision
  summary: "ELF 产物必须经中间 C99 层、且 gcc 编译器可配置（细化产物拓扑）"
  source: "2026-10-07 用户拍板"
  affects: [release-artifact-topology]

- time: 2026-10-07T15:10:32
  kind: reversal
  summary: "AOT 改用本路线实现：归档 qzvm-aot（Perry 路线 AOT + .jso 格式，与新拓扑『永不独立发行字节码/唯一稳定 API=WinterTC』冲突）与 wasm-ts-runtime（Perry 式 wasm 化路线，TS→wasm 部分已被本拓扑吸收）。AOT 现归入本页 ELF 形态（→C99 中间层 + 可配置 gcc）。"
  source: "2026-10-07 用户拍板"
  affects: [qzvm-aot, wasm-ts-runtime, release-artifact-topology]

- time: 2026-10-07T15:12:35
  kind: decision
  summary: "补充：永不保证二进制 ABI 兼容（JS 稳定 API 仅 WinterTC）；wasm 独立可执行文件仅保证 WASI API；JS 字节码必须与 JS 引擎绑定"
  source: "2026-10-07 用户拍板"
  affects: [release-artifact-topology]

- time: 2026-10-07T15:17:58
  kind: decision
  summary: "修正稳定面定义：稳定 API 不只 WinterTC，= qzjs 对外公开的 API（WinterTC 为其核心组成）"
  source: "2026-10-07 用户纠正"
  affects: [release-artifact-topology]

- time: 2026-10-07T15:37:51
  kind: decision
  summary: "澄清：TS→JS+WASM 链路与 JS 字节码正交，不相交；AOT 针对字节码链路"
  source: "2026-10-07 用户纠正"
  affects: [release-artifact-topology]

- time: 2026-10-07T15:41:31
  kind: decision
  summary: "AOT 定义修正：真正 AOT = 编译 TS 代码为 JS+wasm/so（链路 A）；推翻『AOT=字节码→C99』表述"
  source: "2026-10-07 用户澄清"
  affects: [release-artifact-topology]
