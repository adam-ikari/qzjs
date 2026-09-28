---
id: dap-variables-expansion
title: "DAP 变量展开层级：variablesReference 槽位表（Locals/hover/evaluate 下钻）"
category: decision
status: active
tags: [dap, vscode, debugger, variables]
created: "2026-09-28T03:48:47"
updated: "2026-09-28T03:48:47"
---

<!-- compiled_truth -->
## 现状（已实现，gtest 7/7 + e2e 8/8 绿）

### 槽位表与 id 编码（src/debugger.c）
- `qz_debug_t.var_slots`（JSValue DupValue 数组 + var_slot_count）；空槽 = JS_UNDEFINED（门控保证只存 JS_TAG_OBJECT 且非函数，undefined 永不入槽，可安全当空位用）。
- 引用 id = `(frame_generation << 16) | (0x1000 + slot)`，slot ∈ [0,4096)：
  - **低半区 0x1000 偏移**：帧索引恒 < 4096（调用栈深度），永不落入 [0x1000,0x2000) → `frame_id_to_index` 天然拒槽位 id，`var_slot_get` 天然拒帧 id，**同一32 位空间双向不误判**（无需新位段，规避 frame_generation 占满高位的问题）。
  - **代际半区**：帧 id 同构，停顿即 `frame_generation++` → 上一停顿的引用自然失效（`{"variables":[]}`）。
- 失效点三处与帧快照同生共死：on_dispatch 停顿、on_throw、detach —— `var_slots_free`（JS_FreeValue 每槽）紧邻 `frame_generation++`，**不跨停顿持有 JSValue**（防保留本应可回收的大对象）。前置声明解决使用点先于定义点。
- 槽满（4096）→ var_slot_add 返0（叶子），不报错。

### 双路分派（qz_debug_get_variables）
- 先 `frame_id_to_index`（帧/作用域路径，填真 variables_reference + 真类型 + 有界预览）；miss 再 `var_slot_get`（槽位路径 → collect_children）；双 miss → -1 → DAP `{"variables":[]}`。
- `collect_children`：`JS_GetOwnPropertyNames(STRING_MASK|ENUM_ONLY)`——数组得按下标序的自身可枚举下标（length 非枚举自动排除）、对象得自身可枚举 string 键；每层 ≤100 项 + `<...>` 折叠行（"N more"）；getter/Proxy 抛错 → 清异常、该项值 `<error>`，GPN 抛错 → 整体回空列表。
- 函数 = 叶子（var_slot_add 拒）；symbol 键天然被 STRING_MASK 排除；无原型链（GPN 只给自身）。

### 值预览与类型
- `debug_var_preview`（200 字节，UTF-8 安全截断 + "…"）：字符串走 JSONStringify（转义+引号，兼容旧行为）；对象先 stringify（循环/toJSON 抛错或函数→undefined → 回退受保护 ToString）；其余 ToString（Symbol 抛错 → 清异常 → NULL → DAP 显示 "undefined"）。
- 旧行为对比：无界 JSON.stringify、循环引用 → NULL → 显示 "undefined" 且不可展开；类型恒 "object"。
- `debug_var_type`：真 typeof（array/function/…）；**TDZ（JS_IsUninitialized）归 "undefined"**，值显示引擎字面 `[uninitialized]`。

### evaluate 可下钻
- `qz_debug_evaluate` 新增第6 出参 `out_variables_reference`（对象结果入槽）；DAP 层 evaluate body 的 variablesReference 从硬编码 0 改真值 → Debug Console hover/watch 可下钻 `locals.o`。
- `qz_debug_var.variables_reference` / `indexed_variables` 字段头文件本就预留，本轮首次填充（indexed_variables 仍未用——DAP 分页未做）。

### 关键坑（测试设计）
- **断点停在语句入口 = 初始化式尚未执行**：`const`/`let` 局部变量在自己声明行的断点处是 TDZ（显示 `[uninitialized]` 叶子），`var` 是 undefined。**断点行必须放在被测局部变量初始化之后**（gtest 曾因此首轮全 fail：断点在声明行 → o/arr 全 undefined）。
- e2e `r 5` 断言：sum = o.a + arr[0] = 1+4（曾误写 r 7 = 把 nested.b[0] 当 arr[0]）。

### 语义边界（docs Limitations）
仅自身可枚举属性、Map/Set 内部条目不暴露（打开为空）、函数叶子、symbol 键跳过、每层 ≤100、引用随下一停顿失效、TDZ 显示 [uninitialized]。

### 测试
- gtest `DapDebugger.VariableExpansion`：断点 4/5 行（初始化后）→ 两停顿；嵌套链 o→nested→b[0,1]、evaluate `locals.o` 可展开、第二停顿后旧引用回 `{"variables":[]}`。
- e2e `test/variables-expand.mjs`：同链路经真适配器 + stdout 中继回归（`r 5`）。
- 纯 C 层（src/debugger.c、src/debugger_dap.c、include/qzjs/qz_debug.h）——引擎公开 API 够用，**deps/quickjs-ng 补丁未动**（本轮无补丁镜像环节）。


## Timeline

- time: 2026-09-28T03:48:47
  kind: decision
  summary: "Created this page: DAP 变量展开层级：variablesReference 槽位表（Locals/hover/evaluate 下钻）"
  source: created via brain create-page
  affects: [dap-variables-expansion]

- time: 2026-09-28T03:48:47
  kind: decision
  summary: "变量展开已实现（纯 C 层，未动引擎补丁）：槽位 id 编码 (gen<<16)|(0x1000+slot) + 代际失效 + 有界预览 + own-props 枚举"
  source: brain update-truth
  affects: [dap-variables-expansion]

- time: 2026-09-28T03:48:47
  kind: decision
  summary: "变量展开落地：槽位 id (gen<<16)|(0x1000+slot) 编码 + 三失效点同生共死 + own-props ≤100 枚举 + 200B 有界预览 + evaluate 出参 ref；gtest 7/7、e2e 8/8、ctest 26/26、tsc、非调试构建全绿；docs en+zh/CHANGELOG/ROADMAP A4 同步；未动引擎补丁"
  source: brain append-timeline
  affects: [dap-variables-expansion]
