# Extension example

把自定义 C 扩展编译进 qzjs，向 JS 暴露原生全局函数 `greet(name)`。

## 构建（扩展必须编译进 qzjs 库，不是独立可执行）

在仓库根执行：

```bash
cmake -B build_ext \
  -DCMAKE_BUILD_TYPE=Release \
  -DQZ_EXTRA_SOURCES="$(pwd)/examples/extension/extension.c" \
  -DQZ_EXTRA_HEADERS="$(pwd)/examples/extension/greet_ext.h" \
  -DQZ_EXTENSIONS='QZ_DEFAULT_EXTENSIONS &greet_ext'
cmake --build build_ext --parallel
```

- `QZ_EXTRA_SOURCES`：把 `extension.c` 加进 `qzjs` 库的编译
- `QZ_EXTRA_HEADERS`：把 `greet_ext.h` 预包含进 qzjs 库编译——`context.c`
  展开 `QZ_EXTENSIONS` 表时需要看到 `extern qz_ext_t greet_ext` 声明
- `QZ_EXTENSIONS`：把 `greet_ext`（`qz_ext_t`）加进编译期扩展表

## 运行

```bash
./build_ext/qzjs -e 'console.log(greet("qzjs")); console.log(greet(42))'
# Hello, qzjs!
# Hello, 42!
```

`-e` 求值后丢弃表达式的值，所以要看到输出必须自己 `console.log`。

## 要点

- `qz_ext_t` 的 `init` 钩子在上下文创建时（`qz_create` 内）运行，此时
  `qz_get_active_jsctx(rt)` 返回活动的 `JSContext*`（内部辅助，声明于
  `src/base/qz_rt.h`，仅编译进 qzjs 的扩展可用）。
- 用 QuickJS API（`JS_NewCFunction`/`JS_SetPropertyStr`）注册全局。
- 扩展随 qzjs 库一起编译，`init`/`destroy`/`suspend`/`resume` 钩子对应
  上下文生命周期（见 [Extensions 指南](/guide/extensions)）。
