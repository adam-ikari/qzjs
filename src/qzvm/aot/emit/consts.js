/* consts.js — qz.* 契约面 + 名字编码 + 内建全局集 + 源码文本工具（叶子模块，无内部依赖）
 * emitter.js 拆分件；模块图见 ../emitter.js 顶部注释。 */
"use strict";
const ts = require("typescript");

// ---------- qz.* import 注册（tagged 模式运行时） ----------
// 值恒 i64：数值=原始 f64 位型（NaN-box），句柄=高16位0x7FF9|低32 offset。
// 该表示与宿主字长无关（wasm f64 恒 IEEE-754 double；32 位宿主由 wamrc 降到软/硬浮点），
// 故 32/64 位设备共用，无需按目标位宽换表示。
// alloc 偏移 / 字段名 id 仍 i32；truthy 返回裸 i32（0/1）供 wasm 条件直接用。
const QZ = {
  alloc:  { params: ["i32"],  results: ["i32"] },
  object_new:   { params: [],             results: ["i64"] },
  object_set:   { params: ["i64", "i32", "i64"], results: [] },
  object_get:   { params: ["i64", "i32"], results: ["i64"] },
  string_new:   { params: ["i32"],        results: ["i64"] },
  string_concat:{ params: ["i64", "i64"], results: ["i64"] },
  to_string:{ params: ["i64"], results: ["i64"] },                 // ToString（string hint）
  add:  { params: ["i64", "i64"], results: ["i64"] },
  sub:  { params: ["i64", "i64"], results: ["i64"] },
  mul:  { params: ["i64", "i64"], results: ["i64"] },
  div:  { params: ["i64", "i64"], results: ["i64"] },
  rem:  { params: ["i64", "i64"], results: ["i64"] },
  lt:   { params: ["i64", "i64"], results: ["i64"] },
  gt:   { params: ["i64", "i64"], results: ["i64"] },
  le:   { params: ["i64", "i64"], results: ["i64"] },
  ge:   { params: ["i64", "i64"], results: ["i64"] },
  seq:  { params: ["i64", "i64"], results: ["i64"] },
  sne:  { params: ["i64", "i64"], results: ["i64"] },
  truthy: { params: ["i64"], results: ["i32"] },
  str_len: { params: ["i64"], results: ["i64"] },
  length_of: { params: ["i64"], results: ["i64"] },   // .length 宿主回退（宿主数组/POJO 物化）
  prop_get: { params: ["i64", "i32"], results: ["i64"] },      // 实例属性读（经 getter 链）
  prop_set: { params: ["i64", "i32", "i64"], results: [] },    // 实例属性写（经 setter 链）
  object_rest: { params: ["i64", "i32", "i32", "i32", "i32", "i32", "i32", "i32", "i32"], results: ["i64"] },  // {...rest}（排除键最多 8）
  is_undef: { params: ["i64"], results: ["i32"] },           // v === undefined
  instanceof_builtin: { params: ["i64", "i32"], results: ["i32"] },   // x instanceof 内建类 → 0/1
  call_named: { params: ["i32", "i64", "i32"], results: ["i64"] },      // 展开实参：按名动态调用（isNum=1 → f64 ABI）
  closure_call_spread: { params: ["i64", "i64"], results: ["i64"] },    // 展开实参：闭包动态调用



  log:  { params: ["i64"], results: [] },
  band: { params: ["i64", "i64"], results: ["i64"] },
  bor:  { params: ["i64", "i64"], results: ["i64"] },
  bxor: { params: ["i64", "i64"], results: ["i64"] },
  shl:  { params: ["i64", "i64"], results: ["i64"] },
  shr:  { params: ["i64", "i64"], results: ["i64"] },
  ushr: { params: ["i64", "i64"], results: ["i64"] },
  pow:  { params: ["i64", "i64"], results: ["i64"] },
  // 字符串方法：recv + 方法名 id + 2 参（缺省 = undefined 句柄）→ 结果字符串句柄（0x7FF9）。
  // 走 JS 回退（正确处理 UTF-8/UTF-16 语义）；结果 join handles 表，toJS 还原为 JS string。
  str_method: { params: ["i64", "i32", "i64", "i64"], results: ["i64"] },
  // 闭包调用：closure_call(句柄, a0, a1, a2, a3) → i64。JS 侧按句柄内 funcidx
  // 跳 __lam_N（wasm 导出），最多 4 参（缺省 undefined 句柄）。返回 tagged 值。
  closure_call: { params: ["i64", "i64", "i64", "i64", "i64", "i64"], results: ["i64"] },   // handle, a0..a3, recv
  // 通用方法调用回退：method_call(recv, mid, a0, a1, a2, a3) → i64。
  // qz 侧按 recv 类型派发：字符串 → str_method 逻辑；类实例（内存 [0]=__cls≠0）→
  // 按 classMeta[clsId].methods[mid]（含继承链）调 wasm 导出 __m_<C>$<m>(recv, a0..a3)。
  // 最多 4 参（缺省 undefined 句柄）。wasm 侧仅在静态可判定 owner 时直调，否则走此回退。
  // 类实例分配在 wasm 内联（bump，见 _emitNewCall）——不经宿主，故无对应 import。
  method_call: { params: ["i64", "i32", "i64", "i64", "i64", "i64", "i64"], results: ["i64"] },   // recv, mid, a0..a3, ovf(实参 4..)
  arr_set_len: { params: ["i64", "i64"], results: ["i64"] },
  arr_set_index: { params: ["i64", "i64", "i64"], results: ["i64"] },   // a[i]=v（越界扩容）
  arr_delete_index: { params: ["i64", "i64"], results: ["i64"] },       // delete a[i]
  delete_index: { params: ["i64", "i64"], results: ["i64"] },           // delete o[k] / a[i]
  spread_order: { params: ["i64", "i64"], results: [] },   // {..src}：把 src 的键序补登记到 dst
  obj_merge: { params: ["i64", "i64"], results: [] },           // {...hostObj} 物化合并
  obj_new: { params: [], results: ["i64"] },                    // 新宿主对象（含方法/访问器的字面量）
  obj_accessor: { params: ["i64", "i32", "i64", "i64"], results: [] },   // defineProperty(get/set 闭包回调)
  object_set_method: { params: ["i64", "i32", "i64"], results: [] },     // 对象方法（闭包 + self 转发）
  object_set_method_key: { params: ["i64", "i64", "i64"], results: [] }, // 计算键名方法（Symbol.iterator 等）
  typeof_host: { params: ["i64"], results: ["i32"] },                    // 宿主值是否 JS 函数 → 0/1
  is_symbol_host: { params: ["i64"], results: ["i32"] },                  // 宿主值是否 JS symbol → 0/1
  err_stack: { params: ["i64"], results: ["i64"] },                      // Error 族实例的 .stack（合成）
  tagged_strings: { params: ["i64", "i64"], results: ["i64"] },          // 用户标签模板：cooked+raw → 带 .raw 的 strings 对象
  field_order: { params: ["i64", "i64"], results: [] },                  // 属性写入登记插入序（键为字符串句柄，需内存）
  order_note: { params: ["i64", "i32"], results: [] },                  // 同上，键取 strings[strId]：**不触内存** → start 段（模块初始化）可用
  field_order_lit: { params: ["i64", "i32"], results: [] },
  field_order_del: { params: ["i64", "i64"], results: [] },              // 删除属性时同步插入序名单              // 批量登记（\u0000 分隔的名单，编译期常量）
  prot_check: { params: ["i64", "i32"], results: [] },                       // 写保护检查（freeze/seal）
  prop_delete: { params: ["i64", "i32"], results: [] },                       // delete o.k（宿主真删 / POJO 槽置 undefined）
  elem_get_guard: { params: ["i64", "i64"], results: ["i64"] },         // 保留
  // 数组 .length= 赋值特判：set_len(句柄, n_i64) → 新长度 i64。宿主处理截断/扩容（扩容补 undefined）。
  // wasm 侧仅用于 0x7FFB 数组；字符串/其它不适用。
  // num 模式 ** ：wasm 无原生 f64.pow → 宿主 Math.pow（f64×2 → f64）。
  math_pow: { params: ["f64", "f64"], results: ["f64"] },
  // num % 宿主回退：除法溢出/除零/NaN 输入时唯一全精度途径（fmod 语义）
  math_rem: { params: ["f64", "f64"], results: ["f64"] },
  // 单目 ~ / +（tagged）：~a = ~(ToInt32(ToNumber(a)))；+a = ToNumber(a)。宿主 toJS 解引用。
  bnot: { params: ["i64"], results: ["i64"] },
  to_num:{ params: ["i64"], results: ["i64"] },
  neg:  { params: ["i64"], results: ["i64"] },   // 一元 -：ToNumber（对象 valueOf / 字符串 parse）后取反
  // ?? 判定：a == null || a == undefined（含宿主侧 null 独立句柄）→ i32(0/1)
  is_nullish: { params: ["i64"], results: ["i32"] },
  // 宽松相等 == / 不等 !=：JS 强制转换（ToPrimitive/ToNumber；1=="1"=true、null==undefined=true）
  eq:  { params: ["i64", "i64"], results: ["i64"] },
  ne:  { params: ["i64", "i64"], results: ["i64"] },
  // typeof 走 wasm 内联分类（见 emitTaggedExpr）：无法区分「宿主侧 handles 索引」与
  // 「POJO 内存 offset」（二者共用 0x7FF9 低 32 位空间），故不设宿主回退。
  // 内建全局：nameId(i32) + n(实际参数个数,i32) + a0..a3(i64) → i64（宿主按名分派）
  builtin: { params: ["i32", "i32", "i64", "i64", "i64", "i64", "i64"], results: ["i64"] },   // nameId, n, a0..a3, ovf（实参 3..）
  // a instanceof C：a 须为类实例（专用 tag 0x7FFE）→ clsId(i32) → tagged bool
  instanceof_op: { params: ["i64", "i32"], results: ["i64"] },
  class_value: { params: ["i32"], results: ["i64"] },
  class_expr_value: { params: ["i32", "i64", "i32"], results: ["i64"] },   // 类表达式作值：克隆 clsId + 该类专属 env（0=无捕获）+ "@@qzEnv" 键
  class_env_get: { params: ["i64", "i32"], results: ["i64"] },   // (self tagged, "@@qzEnv" strId) → 该类 env 索引；按实例**运行时 clsId** 查，克隆类各持一份
  class_env_get_static: { params: ["i64", "i32"], results: ["i64"] },   // 同上，但 self 是**类值**（静态方法）：宿主档函数句柄 / in-module 0x7FFE|clsId
  class_env_set: { params: ["i32", "i32", "i64"], results: [] },   // (clsId, "@@qzEnv" strId, env) → statics[clsId|envKey]=env（与 class_env_get 键一致）
  class_env_get_by_id: { params: ["i32", "i32"], results: ["i64"] },   // (clsId, "@@qzEnv" strId) → statics[clsId|envKey]（按 clsId 直查，不经 self；供子类 env 链父类 env）
  class_env_parent_get: { params: ["i32", "i32"], results: ["i64"] },   // (clsId, "@@qzEnv" strId) → 沿继承链查父类 env（动态父 classRuntimeParent/classMeta.parent 改写后）；0=无
  builtin_value: { params: ["i32"], results: ["i64"] },
  brand_check: { params: ["i64", "i32"], results: ["i64"] },   // 私有名 in o（品牌检查）：非对象 → TypeError（JS 语义）
  method_spread: { params: ["i64", "i32", "i64"], results: ["i64"] },   // obj.m(...args)：实参数组 → method_call 分派
  super_method: { params: ["i64", "i32", "i64", "i64", "i64", "i64", "i64"], results: ["i64"] },   // 对象字面量 super.m()：按 receiver 原型链解析               // 内建全局作值（String/Number/Array/… → 宿主句柄，缓存保证 ===）                  // 类名作值：clsId → 宿主构造器对象句柄
  super_method_dyn: { params: ["i64", "i32", "i32", "i64", "i64", "i64", "i64"], results: ["i64"] },   // 动态父 super.m()：self + homeClsId + mid + a0..a3 → 按 home 的运行时父链查实例方法
  new_dynamic: { params: ["i64", "i64", "i64", "i64", "i64"], results: ["i64"] },   // 运行时类值构造：类对象 + a0..a3 → 实例句柄
  class_value_dyn: { params: ["i32", "i64"], results: ["i64"] },             // 动态父类值：clsId + 父类对象 → 类对象（记录运行时父链）
  super_ctor: { params: ["i32", "i64", "i64", "i64", "i64", "i64"], results: [] },   // 动态父构造转发：clsId + self + a0..a3
  instanceof_dyn: { params: ["i64", "i64"], results: ["i64"] },                 // 运行时类值/内建值 instanceof：值 + 右值 → tagged bool
  in_op: { params: ["i64", "i64"], results: ["i64"] },   // k in o → tagged bool
  statics_ready: { params: ["i32"], results: ["i32"] },        // 类静态字段：是否已初始化
  statics_has: { params: ["i32", "i32"], results: ["i32"] },     // 该类是否有该静态（运行时父链查找）
  statics_mark: { params: ["i32"], results: [] },
  static_get: { params: ["i32", "i32"], results: ["i64"] },    // (classId, fieldId) → tagged
  static_get_dyn: { params: ["i64", "i32"], results: ["i64"] },   // this.x 于静态方法内（运行时代）：(self句柄, fieldId) → tagged    // (classId, fieldId) → tagged
  static_set: { params: ["i32", "i32", "i64"], results: [] },
  get_index: { params: ["i64", "i64"], results: ["i64"] },   // o[k]（动态键）：宿主按名/索引取值
  set_index: { params: ["i64", "i64", "i64"], results: [] }, // o[k] = v
  env_new: { params: ["i32"], results: ["i64"] },        // 闭包环境：parentIdx(-1=根) → 环境句柄
  env_def: { params: ["i32", "i32", "i64"], results: [] },   // 直接写入该环境层（每迭代绑定种子）
  arr_apply: { params: ["i64", "i32", "i64"], results: ["i64"] },     // 变参数组方法（实参数组）
  empty_array: { params: [], results: ["i64"] },                 // rest 形参缺省 → 空数组
  str_chars: { params: ["i64"], results: ["i64"] },                   // 字符串 → 码点字符数组
  builtin_fn: { params: ["i32"], results: ["i64"] },                  // 内建函数值（作为值读取）
  builtin_member: { params: ["i32"], results: ["i64"] },              // 内建成员当作值读
  regex: { params: ["i32"], results: ["i64"] },                        // 正则字面量 → 宿主 RegExp
  str_dup: { params: ["i64"], results: ["i64"] },                     // 字符串私有副本（不可变语义）
  iter_array: { params: ["i64"], results: ["i64"] },                 // 非数组可迭代 → wasm 数组（for-of 已改走 iter_new/iter_pull，保留供旧路径）
  iter_new: { params: ["i64"], results: ["i64"] },               // for-of: 目标 → 迭代器状态句柄
  iter_pull: { params: ["i64"], results: ["i64"] },               // for-of: 推进一次；返回 1=done / 0=continue（BigInt）
  iter_val: { params: ["i64"], results: ["i64"] },                // for-of: 取当前迭代值（已 pull）
  iter_close: { params: ["i64"], results: [] },                   // for-of: 提前终止调用（break/return）→ iterator.return?.()
  bigint_lit: { params: ["i32"], results: ["i64"] },              // BigInt 字面量（字符串 id）→ BIG_HI 句柄
  bigint_binop: { params: ["i32", "i64", "i64"], results: ["i64"] },   // BigInt 二元运算（op, a, b）；op: 0+ 1- 2* 3/ 4% 5=== 6!== 7< 8<= 9> 10>=
  fn_value: { params: ["i32", "i32", "i32"], results: ["i64"] },   // 顶层函数作值：包装为宿主函数句柄（arity = 形参数，缺省补 TAG）
  builtin_spread: { params: ["i32", "i64"], results: ["i64"] },        // 内建函数 + 展开实参
  spread_into: { params: ["i64", "i64"], results: ["i64"] },    // [...x]：按迭代协议并入数组
  call_value: { params: ["i64", "i64", "i64", "i64", "i64", "i64", "i64"], results: ["i64"] },   // v, a0..a3, 溢出实参数组, recv   // 值调用（闭包/宿主函数）
  call_named_rest: { params: ["i32", "i64", "i32"], results: ["i64"] },             // 展开实参 + rest 收尾被调函数
  env_get: { params: ["i32", "i32"], results: ["i64"] }, // (envIdx, nameId) → tagged（沿 __parent 链）
  env_set: { params: ["i32", "i32", "i64"], results: [] },
  object_delete: { params: ["i64", "i32"], results: [] },  // delete 宿主对象字段
  // 对象展开 {..o}：n(i32) + pieces(i64×4) → Object.assign({}, ...) → 宿主对象句柄
  obj_assign: { params: ["i32", "i64", "i64", "i64", "i64"], results: ["i64"] },
  oom: { params: [], results: [] },   // bump arena 越界：宿主抛 RangeError（替代 unreachable trap，让宿主可 catch）
  take_err: { params: [], results: ["i64"] },   // 取 C 侧 pending throw（reduce 空数组/冻结写入）→ 写 __err，errcheck 转 catch
};

// JS 内建全局（未实现；命中时给明确错误而非误导性「未定义捕获变量/函数」）。
const BUILTIN_GLOBALS = new Set(["Math", "JSON", "Array", "Object", "String", "Number", "Boolean", "Date",
    "Function", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "Promise", "Symbol", "BigInt", "Error", "TypeError",
    "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "Reflect", "Proxy",
    "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
    "encodeURI", "decodeURI", "structuredClone", "globalThis", "Intl", "Atomics", "SharedArrayBuffer",
    "atob", "btoa"]);
// 可作为 `new X(...)` 目标的内建类（宿主构造；与 qzvm BUILTIN_CTORS 一致）。
const EMITTER_BUILTIN_CTORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
    "EvalError", "URIError", "Map", "Set", "WeakMap", "WeakSet", "Date", "Array", "Object", "RegExp", "Proxy",
    "Uint8Array", "Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "ArrayBuffer", "DataView", "URL", "URLSearchParams", "File", "Blob"]);
// 注册 qz.* import。only = 采集到的「实际用到」集合（Set<"qz.<name>">）；缺省/undefined
// 则全量注册（向后兼容）。按需注册是 brain [[aot-generic-compiler-target]] 的要求：
// import 面 = 需求驱动的最小契约面，不是 qzjs 私有 ABI 的全集。
function registerQz(m, only) { for (const k of Object.keys(QZ)) { if (only && !only.has("qz." + k)) continue; m.importFn("qz", k, QZ[k].params, QZ[k].results); } return m; }

// 类方法/构造器在函数名中的编码（内部前缀，避免与用户函数名冲突）。
const MTH_PREFIX = "__m_";
// 函数源码文本（Function.prototype.toString 语义）：按 AST 剥离 TS 类型注解（参数/返回类型/类型断言），
// 与 tsc 转译后的 JS 文本一致（oracle 即 tsc 转译后运行）。
function stripTsTypes(node, sf) {
    const removals = [];
    const walk = (n) => {
        if (n.type && (ts.isParameter(n) || ts.isFunctionLike(n) || ts.isPropertyDeclaration(n)
            || ts.isVariableDeclaration(n) || ts.isPropertySignature(n))) {
            let s1 = n.type.pos;                       // 类型节点 pos 不含前导冒号 → 一并剥掉（含空白）
            const ft = sf.text;
            while (s1 > 0 && (ft[s1 - 1] === ":" || ft[s1 - 1] === " " || ft[s1 - 1] === "\t")) s1--;
            removals.push([s1, n.type.end]);
        }
        if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) && n.type) removals.push([n.expression.end, n.type.end]);
        ts.forEachChild(n, walk);
    };
    walk(node);
    const base = node.getStart(sf);
    let txt = node.getText(sf);
    for (const [s0, e0] of removals.sort((a, b) => b[0] - a[0])) {
        const a1 = s0 - base, b1 = e0 - base;
        if (a1 >= 0 && b1 <= txt.length && a1 < b1) txt = txt.slice(0, a1) + txt.slice(b1);
    }
    return txt;
}
// 函数体是否引用 arguments（箭头继承外层；嵌套 function/method 有自己的绑定 → 不下探）
function usesArguments(node) {
    let hit = false;
    const walk = (n, isRoot) => {
        if (hit) return;
        if (!isRoot && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)
            || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n))) return;
        if (ts.isIdentifier(n) && n.text === "arguments") { hit = true; return; }
        ts.forEachChild(n, (c) => walk(c, false));
    };
    if (node) walk(node, true);
    return hit;
}
function ctorName(cls) { return MTH_PREFIX + cls + "$ctor"; }
// [Symbol.<name>] 计算属性名 → "@@name"；非 well-known Symbol → null（暂不支持）
function symbolNameOf(expr) {
    if (!expr) return null;
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Symbol") {
        const n = expr.name.text;
        if (/^(iterator|asyncIterator|toPrimitive|toStringTag|hasInstance|isConcatSpreadable|species|unscopables|match|matchAll|replace|search|split)$/.test(n)) return n;
    }
    return null;
}
function methName(cls, m) { return MTH_PREFIX + cls + "$" + m; }
function staticMethName(cls, m) { return "__sm_" + cls + "$" + m; }

module.exports = { QZ, registerQz, BUILTIN_GLOBALS, EMITTER_BUILTIN_CTORS, MTH_PREFIX, stripTsTypes, usesArguments, ctorName, symbolNameOf, methName, staticMethName };
