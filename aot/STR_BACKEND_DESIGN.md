# 字符串后端优化设计（独立实现计划）

## 目标
消除 tagged 路径字符串拼接的逐轮跨界（当前 `s = s + i` 每轮调 `qz.add` → JS 拼接 → 新 handle，慢 14x，strwork(8000) 14ms vs 解释器 1ms = 0.07x）。

## 根因
`qz.add`（字符串拼接）guard 回退跨界——每轮 1 次 wasm↔JS 边界。跨界税 > 解释器直接执行。

## 设计

### 1. 字符串表示
tagged handle → wasm 内存 `[len:i32][utf8 bytes]`（handle = offset<<1|1）。
- **字面量** → wasm data 段（编译期写入，零跨界）
- **动态缓冲** → bump 分配区（复用对象 bump global0）

### 2. 数字转字符串（wasm 内）
`div_u`/`rem_u` 循环逐位取余 + 反转。emitter 生成指令序列：
```
n(untag) → 特例 0 → 逐位 %10 写临时区 + /10 → 反转写入缓冲
```
需 encoder 支持：`i32.div_u / i32.rem_u / i32.store8 / i32.load8_u` + 循环控制流（已有）。

### 3. 拼接策略
`strvar + v` 两种：
- **append-only 累积缓冲**（`s = s + i`，旧 s 值丢弃）→ 原地追加（写 `[offset+4+len]` + 更新 `[offset]` len），零分配零跨界。语义等价：每轮旧值不重复引用。
- **新建**（s 被复用/比较/嵌套拼接）→ bump 分配 `len(s)+digits+4` + 复制 + 返回新 handle。

emitter 需**变量类型跟踪**（StringLiteral initializer → var=string），区分数值加法 vs 字符串拼接（`number+number` 走 guard 原生算术，含 string 走拼接）。

### 4. materialize
仅函数返回 / console.log / 传给 qz.* 时跨界一次（glue 读 wasm 内存 len+bytes → JS 字符串）。

## 目标
`strwork(8000)` 从 14ms（0.07x）→ 接近 68x 量级。

## 边界/风险
- UTF-8 编码（wasm 字节 → JS 字符串，glue 用 TextDecoder）
- `s + "a"`（字符串字面量拼接）、嵌套 `(a+b)+c`、`"a"+n+"b"`
- 字符串比较（`s === "x"`）→ 需 wasm 内 memcmp 或跨界
- 内存布局：data 段字面量区 vs bump 动态区共存（偏移冲突）

## 工作量
~150-200 行 encoder/emitter 扩展。独立实现，配本设计 + 测试（strwork/mix 回归 + 正确性全规模）。
