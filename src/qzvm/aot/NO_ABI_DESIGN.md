# 无 ABI 设计（no-ABI design）

**状态**：设计定稿（承诺边界 + 机制方向），M6 落地未实现
**范围**：界定 qzjs 对 wasm 模块**内部交互**与**对外能力边界**的 ABI 承诺范围；澄清 in-module 形态下 emitter 产物与 qzvm 字节码引擎的绑定机制。是 `IN_MODULE_DESIGN.md` M6 的设计前置——回答「M6 该做什么」。
**方法**：承诺边界最小化（只保公开 JS API）+ 内部交互内联化（无契约面）+ 对外走 WebAssembly 标准。

> **术语**：本文「emitter 产物」= `emitter.js` 编译 TS→wasm 的原生代码；「字节码引擎」= qzvm 内的 QuickJS（跑 JS 字节码）；「qz.* import」= 当前跨界形态下 emitter 产物 import 的 18 个值原语（`qz.add`/`qz.object_get`/…），由宿主 JS shim 提供。

---

## 1. 无 ABI 的定义

**无 ABI = qzjs 只承诺公开 JS API 稳定**。

- **承诺范围**：JS 语言语义 + 公开运行时 API（用户 JS 代码面对的面）。
- **不承诺**：wasm 模块内部与 qzvm 的交互方式——绑定机制、内部表示、调用约定、函数服务号编排，全是**实现细节**，可随时改，零外部成本。

正因为不承诺，可把内部交互**设计紧**（内联绑定、表示统一）而不背负兼容包袱。

## 2. 三层交互模型

| 层 | 交互对象 | 机制 | import 面 |
| --- | --- | --- | --- |
| **模块内部** | emitter 产物 ↔ 字节码引擎（QuickJS） | **内联调用绑定**：合并成单一 wasm 后直接互调 | 无（无 import/export 契约面、无 marshalling 层） |
| **对外能力边界（无 OS）** | wasm ↔ （无） | TS 源码 import 的内容若内联（无外部 OS API 需求）→ 产物**零 import、自包含** | 零 import |
| **对外能力边界（依赖 qzjs JS API）** | wasm ↔ qzjs JS 运行时 | **标准 WebAssembly import**：导入 JS 函数服务号，遵守 wasm 标准 | 标准 import |

### 2.1 模块内部：内联绑定（qzvm 引擎层）

emitter 是**通用 TS→wasm 工具**，产物只声明标准 wasm import，**不绑定 qzjs/qzvm**（§10.6 line 428：qzjs 只是符号提供者之一）。in-module 形态下，**qzvm 引擎层模块合并**把 emitter 产物 + `libqzvm.wasm`（含字节码引擎 QuickJS）合并成单一 wasm 模块——合并后 emitter 产物的标准 import 变**模块内部调用**（字节码引擎↔wasm 原生代码内联绑定），不是 wasm import/export（无跨模块边界）。

- emitter 侧：通用，只发标准 import（零 import 或 JS 函数服务号），**绝不内联绑定 qzjs 专有特性**。
- qzvm 引擎层：合并成单模块后，import 变模块内函数调用 → 无 marshalling 税（无 i64↔BigInt、无 JS 中间层、无 import 编解码）。
- 无 ABI 承诺 → 引擎层绑定方式、内部表示可随时改。
- **18 个 `qz.*` import 是跨界形态（宿主 JS shim）的产物**；in-module 合并形态（M6b）下，qzvm 模块合并使 `qz.*` 标准变模块内调用，`qz.*` 契约面在合并后**消亡为模块内绑定**。emitter 产物本身仍通用（带标准 import 声明，未合并时任何 wasm 引擎可跑）。

### 2.2 对外：零 import 或标准 import

- **无 OS 调用**（纯计算/算法 TS）：TS 源码不 import 外部 OS API → emitter 产物**零 import、自包含**。任何带 wasm 引擎的运行时都能跑（`IN_MODULE_DESIGN.md` §10.6 line 428：通用编译目标）。
- **依赖 qzjs JS API**（TS 调用 qzjs 运行时能力）：emitter 产物 import **JS 函数服务号**，**遵守 WebAssembly 标准**（`import "qzjs" "service_N" (func …)`）。这不是私有 ABI——是标准 wasm import 机制，服务号编排是 qzjs 内部细节（无 ABI 承诺），但**走标准协议**（任何 wasm 引擎都能解析）。

## 3. 与 IN_MODULE_DESIGN 的关系

| IN_MODULE_DESIGN 条目 | 与无 ABI 设计的关系 |
| --- | --- |
| M1–M3（qz_t 切分 / context 拆 / tick 上移）| 纯重构，与无 ABI 无冲突 |
| M4（wasm32 工具链 + guest target）| 产出 `libqzvm.wasm`（guest 自包含）——内联绑定的**前提之一**（guest 独立可编） |
| M5（guest 跑通真 JS + 异步）| pal 跨界（`qz_host.*`）已验——是对外能力边界（标准 import）的验证 |
| §5.3 line 234（kernel 接口无 ABI 承诺）| ✅ 与无 ABI 一致（模块内 C 调，无承诺）|
| §10.1–10.2（pal 面 uv_io_* 穿边界，无 JSValue 跨界）| ✅ 与无 ABI 一致（标准 import，ptr+len 原语）|
| §10.6 line 428（TS import 内联则零 import 自包含）| ✅ 无 ABI 对外边界的直接陈述 |
| M6（in-module 真正落地）| ⚠️ **无 ABI 机制核心未落地**——见 §4 偏差 |

## 4. 当前实现计划偏差评估

对照 `IN_MODULE_DESIGN.md` 的 M1–M6 实现计划，与无 ABI 设计存在以下偏差：

### 偏差 1（关键）：M6 目标错位——「去 JS 化」vs「qzvm 模块合并」

`IN_MODULE_DESIGN.md` 的 M6 定义为**宿主去 JS 化**（line 306：`bridge.c` 463 / `tcp_io.c` 229 / `control.c` 72 处 `JS_` 调用需处置，「先判定'移 guest vs 去 JS 化'再动」）。

无 ABI 设计的 M6 核心目标是 **qzvm 模块合并**（emitter 产物 + `libqzvm.wasm` 合并成单模块，标准 import 变模块内调用）；前提是 **emitter 通用化**（不绑定 qzjs/qzvm）。

两者关系：去 JS 化是**手段/前提**（把 JSValue 操作全移入 guest 后，模块合并才能让 emitter 产物的标准 import 干净变模块内调用）；模块合并是**目的**。但 IN_MODULE_DESIGN **只写了手段（去 JS 化），没写目的（qzvm 模块合并）+ 前提（emitter 通用化）**——M6 落地后若只完成去 JS 化而未做模块合并，in-module 仍未真正实现无 ABI 机制。

**修正建议**：M6 拆为 M6a（去 JS 化：host 侧 JS_ 调用移 guest）+ M6b（qzvm 模块合并：emitter 产物 + `libqzvm.wasm` 合并，标准 import 变模块内调用；前提 emitter 通用化不绑定 qzjs/qzvm）。M6b 才是无 ABI 机制核心。

### 偏差 2：§6 把 M4 合并当工具链问题

`IN_MODULE_DESIGN.md` §6 line 248 把合并描述为「wasm-merge / wasm-ld 链接」延后到 M5 后。这把 in-module 落地的关键当成**链接工具**问题。

无 ABI 设计下，关键是两点：**(1) emitter 通用化**（产物只声明标准 wasm import，不绑定 qzjs/qzvm，§10.6 line 428）+ **(2) qzvm 模块合并**（emitter 产物 + `libqzvm.wasm` 合并成单模块，标准 import 变模块内调用）。关键不是链接工具，是模块合并 + emitter 通用化。合并工具链（wasm-merge 缺）是次要的。

**修正建议**：§6 合并论述改为「emitter 通用化 + qzvm 模块合并」，弱化 wasm-merge 工具定位。

### 偏差 3：§10.6 line 426 保留 `qz.*` 契约面表述

`IN_MODULE_DESIGN.md` §10.6 line 426：「`qz.*` = AOT 值原语（guest 内 AOT 代码用）」。这暗示合并后 `qz.*` 仍存在（模块内调用）。

无 ABI 设计下，`qz.*` 是**跨界形态产物**（emitter 通用产物声明标准 import，宿主 JS shim 提供）。in-module 合并形态（M6b）下，qzvm 模块合并使 `qz.*` 标准变模块内调用，`qz.*` 契约面在合并后**消亡**。emitter 产物本身仍带标准 import 声明（通用，未合并时任何引擎可跑）。两表述有张力：line 426 让人以为 `qz.*` 是稳定的内部契约面，但无 ABI 说它**可消亡**（无承诺）。

**修正建议**：§10.6 澄清 `qz.*` 是跨界形态产物，M6b qzvm 模块合并后消亡为模块内 QuickJS 绑定；line 428 的「内联则零 import」是无 ABI 的对外边界陈述。

### 偏差 4：缺承诺边界陈述

无 ABI 的「无」需要明确的**承诺范围**（只保公开 JS API）。`IN_MODULE_DESIGN.md` 全文无此承诺陈述（也没有 `qzjs-positioning` 脑页里）。

**修正建议**：在 IN_MODULE_DESIGN 头部或本文档明确「qzjs 承诺公开 JS API 稳定；wasm 内部交互无 ABI 承诺」。

### 偏差 5：缺标准合规陈述

无 ABI 对外边界走**标准 WebAssembly import**（依赖 qzjs JS API 时 import JS 函数服务号）。`IN_MODULE_DESIGN.md` §10.6 line 428 说「任何带 wasm 引擎、能提供所需 import 符号的运行时都能跑」，但没明说「依赖 qzjs JS API 时走标准 wasm import 服务号」。

**修正建议**：§10.6 补「依赖 qzjs JS API → 标准 wasm import（JS 函数服务号），遵守 WebAssembly 标准；无 OS 调用 → 零 import 自包含」。

### 偏差 6：核心设计未验的落差
§9 line 305 诚实标注「AOT 变体未验」= M6b（qzvm 模块合并）未做。但无 ABI 是 in-module 的**核心设计**——核心设计未验，意味着 in-module 当前只完成了 guest 自包含（M1–M5），无 ABI 机制（emitter 通用化 + qzvm 模块合并）是纸面设计。

**修正建议**：状态行（line 3）应反映「M1–M5 已实现（guest 自包含）；M6（qzvm 模块合并，无 ABI 机制核心）未实现」——当前「M6 进行中」过于乐观（去 JS 化都没做完，qzvm 模块合并更未开始）。

## 5. 待决（M6 落地前）
1. **emitter 通用化**（重点）：emitter 是通用 TS→wasm 工具，产物只声明标准 wasm import（零 import 或 JS 函数服务号），**不假设 qzjs/qzvm 专有特性**（§10.6 line 428 通用编译目标）。这是无 ABI 的前提——emitter 不绑定 qzjs（完整运行时）/qzvm。
2. **qzvm 模块合并机制**（M6b 核心）：如何把 emitter 产物 + `libqzvm.wasm`（qzvm）合并成单模块，使标准 import 变 qzvm 模块内调用（内联绑定字节码引擎↔wasm 原生代码）——合并发生在编译期还是加载期、链接机制。
3. **表示统一方向**：emitter tagged/bump（0x7FF9 POJO / 0x7FFA str / bump arena）vs QuickJS JSValue。qzvm 模块合并后表示统一是合并实现的一部分（非接口适配层）。`IN_MODULE_DESIGN.md` line 366 暗示 QuickJS 侧复用 0x7FFA——需裁决谁适配谁。
4. **M6a/M6b 拆分**：去 JS 化（host JS_ 移 guest）与 qzvm 模块合并（emitter 产物 + `libqzvm.wasm` 合并）是两个独立工程，需分别排期。
5. **最小验证**：选 1 个 emitter 操作（如对象属性读）做 qzvm 模块合并原型，验「模块内无 marshalling 税」成立（对标 pal 面 45–66ns 量级，非跨界 3.55µs）。

## 6. 参考

- `IN_MODULE_DESIGN.md`：in-module 档设计（M1–M6、§10 跨界 ABI、§10.6 AOT 关系）
- `docs/architecture/qzvm-qzjs-layering.md`：qzvm/qzjs 分层 SSOT
- 脑页 `aot-roadmap`：P2 M4 合并状态（含无 ABI 评估 timeline）
- 脑页 `aot-performance-model`：跨界税实测（noop 133.8ns、qz.add 3.55µs）
- `WebAssembly 标准`：import/export 机制（`import "mod" "name" (func …)`）
