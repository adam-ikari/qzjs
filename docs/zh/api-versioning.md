# API 与 ABI 版本策略

qzjs 遵循[语义化版本](https://semver.org/)。项目处于 `0.x` 阶段时，ABI 另有显式版本号，
并在编译期与运行期双重门控——一个用旧版头文件编译的宿主，撞上新版库时会**显式失败**，
而不是越界读结构体尾部。

## 两个版本号

qzjs 有两个互相独立的版本号。它们回答不同的问题，混淆它们是主要的困惑来源。

| 版本号 | 位置 | 含义 |
|--------|------|------|
| **发布版本**（`0.3.0`） | Git tag、CMake 的 `project(... VERSION ...)`、`qzjs --version` | 整个项目的版本：JS 层 API、行为、功能 |
| **ABI 版本**（`QZ_ABI_VERSION`，当前为 `2`） | `include/qzjs/qzjs.h` | C 边界的二进制布局：结构体字段、函数签名 |

发布版本可以提升而不动 `QZ_ABI_VERSION`——新增一个 JS 层特性并不改变 C 结构体在内存里的排布。

## ABI 版本覆盖哪些变更

以下情形需要提升 `QZ_ABI_VERSION`：

- 公共结构体（`qz_config_t`）的字段被**删除**、**重排**或**追加**
- 字段的**类型**或大小改变
- 公共函数的**签名**改变（参数、返回类型、调用约定）
- 函数被删除或改名
- 既有字段或返回值的**含义**改变到"写法正确的宿主必须改变行为"的程度

以下情形**不**提升：

- 在既有函数**旁边新增**函数
- JS 层行为变化：新增 Web API、新 polyfill 特性、引擎升级

## 门控如何工作

### 编译期

`qz_config_t` 的开头有两个字段专为此设：

```c
#define QZ_ABI_VERSION 2

typedef struct qz_config_s {
    uint32_t struct_size;   /* qz_config_init 填入 sizeof(qz_config_t) */
    uint32_t abi_version;   /* 必须等于 QZ_ABI_VERSION */
    /* ... 真正的配置字段 ... */
} qz_config_t;
```

始终通过 `qz_config_init` 初始化：

```c
qz_config_t cfg;
qz_config_init(&cfg);        /* struct_size 与 abi_version 由它代填 */
cfg.initial_script = "...";
qz_t *rt = qz_create(&cfg);
```

用 `= {0}` 零初始化会让两个字段都是 `0`，`qz_create` 会拒绝。这是有意的：静默的
默认值会让半填的配置蒙混过关。

### 运行期

`qz_config_t` **按值**跨库边界传递并被整块拷贝。用旧头文件编译的宿主传的是**更短**的
结构体，用新头文件编译的宿主传的是**更长**的。两种情况下库都会读过调用方栈帧的末尾——
静默的内存不安全。

`qz_create` 在拷贝任何内容之前校验两个字段：

```c
#include <qzjs/qzjs.h>
#include <stdio.h>

/* qz_create 拷贝任何内容前跑的就是这个检查（src/host/qzjs.c） */
static int abi_mismatch(const qz_config_t *config)
{
    return config->abi_version != QZ_ABI_VERSION ||
           config->struct_size != (uint32_t)sizeof(qz_config_t);
}

static qz_t *create_guarded(const qz_config_t *cfg)
{
    if (abi_mismatch(cfg)) {
        fprintf(stderr, "qzjs: ABI mismatch —— 请重新编译宿主\n");
        return NULL;
    }
    return qz_create(cfg);
}
```

诊断写往 `stderr`，因为 `qz_create` 失败时没有别的途径报告原因——见[运行时生命周期文档](/zh/c-api/runtime)。

### 与不同版本的库链接

动态链接时，即使 `qz_create` 最终能拦住，编译期头文件与实际加载的库仍可能不一致。
提前核对：

```c
#include <qzjs/qzjs.h>
#include <stdio.h>

int main(void) {
    if (qz_abi_version() != QZ_ABI_VERSION) {
        fprintf(stderr, "qzjs: 头文件 ABI %u，库 ABI %u —— 请重新编译宿主\n",
                (unsigned)QZ_ABI_VERSION, (unsigned)qz_abi_version());
        return 1;
    }
    /* ... */
}
```

## 给公共结构体加字段

把新字段**追加到末尾**，并在**同一个提交里提升 `QZ_ABI_VERSION`**，同时在
`CHANGELOG.md` 里说明迁移方式。

追加也是布局变更，门控就是这么对待它的：`qz_create` 要求 `config->struct_size`
**精确等于** `sizeof(qz_config_t)`（`src/host/qzjs.c`），因此任何用**别的版本**头文件
编出来的 `qz_config_t`——无论是更旧还是更新——都会被直接拒绝。不存在"只读一部分字段"
或"静默取默认值"。

提升这个号的作用是让拒绝对宿主**可读**：只做 `qz_abi_version() != QZ_ABI_VERSION`
这一道运行时检查的宿主，若没有提升就会先过掉自己那道检查，然后在 `qz_create` 内部的
`struct_size` 比较上失败——症状离真因很远。

> 反过来让追加**向后兼容**（接受 `struct_size <= sizeof(qz_config_t)`、只拷贝
> `struct_size` 字节）是一次**有意的设计变更**，不是文档修订——它还会让库自身的越界读
> 行为取决于宿主给的尺寸。

## 随构建变化的枚举

`qz_worker_backend_t` 是唯一一个**取值**随编译期配置（ISOLATED 与 THREAD 进程模型）
变化的枚举，其含义在该枚举的声明处（`qzjs.h`）有文档说明。这是进程模型的已知后果，
不是 ABI 破坏：枚举的大小与布局不变，只是哪些取值有意义变了。宿主不应跨构建持久化这些取值。

## 字节码与版本绑定

`qz_compile`（或 `qjsc -b`）产出的字节码 blob **不可跨** qzjs 或引擎版本移植。
读取器会校验流并在不匹配时以校验和或版本错误拒绝，但保证只到"本构建产的字节码能在本构建跑"。

部署时请让字节码与运行时同批发布、同批重建。

## 宿主作者该做什么

1. 调 `qz_config_init`——永远不要 `= {0}`。
2. 动态链接时，启动即比对 `qz_abi_version()` 与 `QZ_ABI_VERSION`。
3. 跨版本升级时读 `CHANGELOG.md` 里对应版本的段落。在 `0.x` 线上破坏性变更确实会发生；
   ABI 门控保护的是内存安全，不是源码兼容性。
4. 升级库时重建宿主。成本是一次编译，消除整类问题。

## 相关文档

- [C API 概览](/zh/c-api/) — 这些规则适用的接口面
- [运行时生命周期](/zh/c-api/runtime) — `qz_create` / `qz_destroy` 语义
- [扩展](/zh/c-api/extensions) — 扩展 ABI（`qz_ext_t`）