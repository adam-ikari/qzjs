# AOT 路线评估汇总（2026-10-08，实验数据消化）


### 批 36 三项残余的机理（2026-10-17 记录，待修）

1. **已修复（见 CHANGELOG「`finally` 重复执行」）**：`_emitPendingFinally` 发射时同步切 `_tryStack`。
2. **已修复（见 CHANGELOG「对象展开与运行时访问器」）**：`usesDynAcc` 程序下展开段一律走 `obj_merge`（此前槽级拷贝静默丢访问器键）。
3. **已修复（见 CHANGELOG「嵌套闭包内的私有名限定」）**：`_emitLambdaBody` 现同时设置 `_curClass`（源自 `lam._qzSupCtx`）。

### `arguments`：已实现（2026-10-17，第五次尝试成功）

见 CHANGELOG「`arguments` 对象」。要点：全局 `__args` scratch 通道 + 末尾 i64 本地 + `lamMeta.needsArgs`；**写入点必须挂在宿主 API `closure_call` 层**（内部 `closureCall` 在该调用形态下未被进入——这是前四次尝试的卡点）。

**类方法内 `arguments`（2026-11-05 补，见 CHANGELOG 同名条目）**：同一条 `__args` 通道，但写入点只能是**产物内的静态直调点**——`method_call` 的 4 槽 ABI 分不清「补占位」与「显式 undefined」，而 C 档宿主因循环导入既不能给方法加参数也不能写产物全局。故其余派发形态按方法名编译期拒绝，绝不静默错值。
