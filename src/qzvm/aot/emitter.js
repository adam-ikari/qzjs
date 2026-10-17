#!/usr/bin/env node
/* emitter.js — tsc AST → wasm 发射器。
 * 值模型（双模式）：
 *   num 快路径（参数全 number 注解）：值 = 裸 f64 local，算术走原生 wasm 指令（零跨界）。
 *   tagged 动态路径（含 unknown/对象/字符串）：值 = i64，经 qz.* import。
 *     f64 NaN-box：数值=原始 f64 位型，句柄=高16位0x7FF9|低32 offset；字段 8 字节。
 *     与宿主字长无关（wasm f64 恒 double），32/64 位设备共用，见 PORTABILITY_32BIT.md。
 *
 * 控制流用 wasm 栈式惯用法：
 *   if:      <cond> if(t) <then> else <else> end
 *   while:   block loop <cond> i32.eqz br_if(1) <body> br(0) end end
 *   for:     <init> block loop <cond> i32.eqz br_if(1) <body> <update> br(0) end end
 *   break → br(block 深度)；continue → br(loop 深度)
 */
"use strict";
const ts = require("typescript");
const fs = require("fs");
const path = require("path");
const { Module } = require("./wasm-encoder.js");

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
  object_rest: { params: ["i64", "i32", "i32", "i32", "i32"], results: ["i64"] },  // {...rest}
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
  class_value: { params: ["i32"], results: ["i64"] },                  // 类名作值：clsId → 宿主构造器对象句柄
  new_dynamic: { params: ["i64", "i64", "i64", "i64", "i64"], results: ["i64"] },   // 运行时类值构造：类对象 + a0..a3 → 实例句柄
  class_value_dyn: { params: ["i32", "i64"], results: ["i64"] },             // 动态父类值：clsId + 父类对象 → 类对象（记录运行时父链）
  super_ctor: { params: ["i32", "i64", "i64", "i64", "i64", "i64"], results: [] },   // 动态父构造转发：clsId + self + a0..a3
  instanceof_dyn: { params: ["i64", "i64"], results: ["i64"] },                 // 运行时类值/内建值 instanceof：值 + 右值 → tagged bool
  in_op: { params: ["i64", "i64"], results: ["i64"] },   // k in o → tagged bool
  statics_ready: { params: ["i32"], results: ["i32"] },        // 类静态字段：是否已初始化
  statics_has: { params: ["i32", "i32"], results: ["i32"] },     // 该类是否有该静态（运行时父链查找）
  statics_mark: { params: ["i32"], results: [] },
  static_get: { params: ["i32", "i32"], results: ["i64"] },    // (classId, fieldId) → tagged
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
  fn_value: { params: ["i32", "i32"], results: ["i64"] },   // 顶层函数作值：包装为宿主函数句柄（arity = 形参数，缺省补 TAG）
  builtin_spread: { params: ["i32", "i64"], results: ["i64"] },        // 内建函数 + 展开实参
  spread_into: { params: ["i64", "i64"], results: ["i64"] },    // [...x]：按迭代协议并入数组
  call_value: { params: ["i64", "i64", "i64", "i64", "i64", "i64", "i64"], results: ["i64"] },   // v, a0..a3, 溢出实参数组, recv   // 值调用（闭包/宿主函数）
  call_named_rest: { params: ["i32", "i64", "i32"], results: ["i64"] },             // 展开实参 + rest 收尾被调函数
  env_get: { params: ["i32", "i32"], results: ["i64"] }, // (envIdx, nameId) → tagged（沿 __parent 链）
  env_set: { params: ["i32", "i32", "i64"], results: [] },
  object_delete: { params: ["i64", "i32"], results: [] },  // delete 宿主对象字段
  // 对象展开 {..o}：n(i32) + pieces(i64×4) → Object.assign({}, ...) → 宿主对象句柄
  obj_assign: { params: ["i32", "i64", "i64", "i64", "i64"], results: ["i64"] },
};

// JS 内建全局（未实现；命中时给明确错误而非误导性「未定义捕获变量/函数」）。
const BUILTIN_GLOBALS = new Set(["Math", "JSON", "Array", "Object", "String", "Number", "Boolean", "Date",
    "RegExp", "Map", "Set", "WeakMap", "WeakSet", "Promise", "Symbol", "BigInt", "Error", "TypeError",
    "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "Reflect", "Proxy",
    "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
    "encodeURI", "decodeURI", "structuredClone", "globalThis", "Intl", "Atomics", "SharedArrayBuffer"]);
// 可作为 `new X(...)` 目标的内建类（宿主构造；与 qzvm BUILTIN_CTORS 一致）。
const EMITTER_BUILTIN_CTORS = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
    "EvalError", "URIError", "Map", "Set", "WeakMap", "WeakSet", "Date", "Array", "Object", "RegExp"]);
// 注册 qz.* import。only = 采集到的「实际用到」集合（Set<"qz.<name>">）；缺省/undefined
// 则全量注册（向后兼容）。按需注册是 brain [[aot-generic-compiler-target]] 的要求：
// import 面 = 需求驱动的最小契约面，不是 qzjs 私有 ABI 的全集。
function registerQz(m, only) { for (const k of Object.keys(QZ)) { if (only && !only.has("qz." + k)) continue; m.importFn("qz", k, QZ[k].params, QZ[k].results); } return m; }

// 类方法/构造器在函数名中的编码（内部前缀，避免与用户函数名冲突）。
const MTH_PREFIX = "__m_";
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
class Emitter {
    constructor(mod) { this.m = mod; this.varMap = new Map(); this.depth = 0; this.labels = []; this._labelStack = []; this._tryStack = []; this.strings = []; this._litOff = new Map(); this._strVars = new Set();
        this.capMap = new Map();      // 捕获变量名 → blk 内偏移（i64 槽序号），闭包体内有效
        this.capList = [];            // 当前闭包的捕获名列表（顺序 = 槽序）
        this.blkLocal = null;         // 当前闭包体的 blk 指针 local（i32）
        this.fnNames = new Set();     // 顶层函数名（闭包捕获分析排除）
        this.lambdas = [];            // 全部 lambda（箭头/函数表达式）：{id,node,captures}
        this._lamById = new Map();    // lambda node → {id,fname,caps}
        this.classes = new Map();     // class name → {id, parent, fields:Map, methods:Map(name→meta)}
        this._classList = [];         // 按声明序的类（发射顺序稳定）
        // 字段名 → 字节偏移。槽 0 保留给类实例的 `__cls` 标记（类 id），用户字段从 8 起。
        this.fieldMap = new Map([["__cls", 0]]);
        this._curClass = null;        // 当前正在发射的方法所属类（this 字段读写用）
        this._curClassObj = null;     // 当前类元数据
        this._staticVars = new Map(); // 变量名 → 类名：静态精确接收者（当前函数/方法体有效）
        this._leafClasses = new Set();// 无子类的类：其方法/构造器内 `this` 静态精确
        this._pendingLambdas = [];    // 已登记待发射的 lambda 体
        this.sf = null;               // 当前 SourceFile（行号查询；compileTS 设置）
        this.importAlias = null;      // { 本地导入名 → 目标顶层函数名 }；compileTS 多文件时设置
        this.nsAlias = null;          // { 命名空间本地名 → Map(成员名 → 目标顶层名) }（`import * as ns`）
        this.classAlias = null;       // { 本地类名 → 目标类名 }（默认/命名导入的类）
    }
    // 源码行号（1-based）。DWARF 行标记用；无 sf 时返回 0（该 mark 被忽略）。
    _line(node) { return (this.sf && node && node.pos !== undefined) ? this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf)).line + 1 : 0; }
    /* 跨文件内联：把 `import { x as y }` 的本地别名 y 折回目标模块的导出名 x。
     * 非导入名原样返回（本模块顶层函数 / 闭包变量）。 */
    _fnName(name) { return (this.importAlias && this.importAlias.get(name)) || name; }
    // 导入的类本地名 → 目标类名（默认/具名导入的类）；非导入类原样返回。
    _className(name) { return (this.classAlias && this.classAlias.get(name)) || name; }
    // 静态成员键：私有名需类名限定（与收集期一致：#类名#名；PrivateIdentifier.text 自带 #）
    _staticKey(cn, nameNode) { return ts.isPrivateIdentifier(nameNode) ? "#" + cn + "#" + nameNode.text : nameNode.text; }
    // 命名空间成员访问 `ns.member` → 目标顶层名；非命名空间访问返回 undefined。
    _nsMember(nsName, member) {
        if (!this.nsAlias) return undefined;
        const m = this.nsAlias.get(nsName);
        return m ? m.get(member) : undefined;
    }
    /* 跨模式调用 ABI：num 值 = f64，tagged 值 = i64（数值侧 = 原始 f64 位型，见文件尾注释）。
     * 故跨模式边界只要按位重解释（精确无损），无需装箱。fnMode: {名 → {mode, void}}。 */
    _calleeInfo(fn) { return this.fnMode ? this.fnMode.get(this._fnName(fn)) : undefined; }
    // 实参发射后调用：把值从本函数模式转到被调函数模式（相等则空操作）。
    _argToCallee(fn) {
        const ci = this._calleeInfo(fn);
        if (!ci || ci.mode === this.mode) return;
        if (ci.mode === "num") this.m.f64ReinterpretI64();   // tagged(i64) → num(f64)
        else this.m.i64ReinterpretF64();                      // num(f64) → tagged(i64)
    }
    // call 之后调用：把返回值从被调函数模式转回本函数模式（void / 相等则空操作）。
    _retFromCallee(fn) {
        const ci = this._calleeInfo(fn);
        if (!ci || ci.void || ci.mode === this.mode) return;
        if (ci.mode === "num") this.m.i64ReinterpretF64();   // num(f64) → tagged(i64)
        else this.m.f64ReinterpretI64();                      // tagged(i64) → num(f64)
    }
    _local(name) { return this.varMap.get(name); }
    // 取出并消费栈顶 label：一个 label 只修饰其直接子循环。嵌套循环 push 时各取各的。
    _curLabel() { return this._labelStack.length ? this._labelStack.pop() : null; }

    // 收集函数体里的 let/const（分配 local 索引）；支持解构绑定（数组/对象，含嵌套）。
    _collectLocals(node) {
        const skip = this._inModInit ? this._modInitNames : null;   // 模块初始化函数：模块级名归全局，不建局部
        const names = [];
        const bindName = (bn) => {
            if (ts.isIdentifier(bn)) { names.push(bn.text); return; }
            if (ts.isArrayBindingPattern(bn) || ts.isObjectBindingPattern(bn)) {
                for (const el of bn.elements) {
                    if (ts.isOmittedExpression(el)) continue;
                    if (ts.isBindingElement(el)) bindName(el.name);
                }
            }
        };
        const walk = (n) => {
            if (ts.isVariableDeclaration(n)) bindName(n.name);
            else if (ts.isFunctionDeclaration(n) && n.name && !(this.hoistedFns && this.hoistedFns.has(n))) { names.push(n.name.text); return; }   // 嵌套函数名是本层局部，但其体属另一作用域
            else if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;   // 不深入嵌套函数体
            ts.forEachChild(n, walk);
        };
        walk(node);
        if (skip) { for (let i = names.length - 1; i >= 0; i--) if (skip.has(names[i])) names.splice(i, 1); }   // 模块初始化函数：模块级名归全局
        for (let i = 0; i < 32; i++) names.push("$sh" + i);            // 块级遮蔽保存槽（i64 值局部区，索引可经 _local 取得）
        // 精确检测：嵌套块里声明的名字若已在外层可见 → 记为「遮蔽块」（进入该块前后保存/恢复外层同名局部）
        if (node && node.statements) {
            this._shadowBlocks = this._shadowBlocks || new WeakMap();
            const base = new Set(names);
            const scan = (n, visible) => {
                if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
                if (ts.isBlock(n)) {
                    const inner = new Set(visible);
                    for (const st of n.statements) {
                        if (!ts.isVariableStatement(st)) continue;
                        for (const d of st.declarationList.declarations) {
                            const dn = [];
                            const bn = (x) => { if (ts.isIdentifier(x)) dn.push(x.text); else if (ts.isArrayBindingPattern(x) || ts.isObjectBindingPattern(x)) for (const el of x.elements) if (ts.isBindingElement(el)) bn(el.name); };
                            bn(d.name);
                            for (const nm of dn) { if (visible.has(nm)) this._shadowBlocks.set(n, nm); inner.add(nm); }
                        }
                    }
                    for (const st of n.statements) scan(st, inner);
                    return;
                }
                ts.forEachChild(n, (c) => scan(c, visible));
            };
            for (const st of node.statements) scan(st, base);
        }
        return names;
    }

    // 变量声明（含解构）：`const a = e` / `const [a,b] = e` / `const {x,y} = e`（含嵌套）。
    // 解构基值求值一次存 scratch；数组元素 = base[i]，对象属性 = base.field（wasm POJO，零跨界）。
    _emitBindingDecl(d) {
        const M = this.m;
        const name = d.name;
        if (ts.isIdentifier(name)) {
            if (d.initializer) {
                if (ts.isClassExpression(d.initializer) && this.clsExprMap && this.clsExprMap.has(d.initializer)) {
                    this._emitUndefined(); this._emitVarStore(name.text, this.scratchB); this.m.drop(); return;   // const C = class {…}：C 仅作 new/instanceof 的类名
                }
                if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
                    this._fnVars = this._fnVars || new Set(); this._fnVars.add(name.text);
                    this._fnNodes = this._fnNodes || new Map(); this._fnNodes.set(name.text, d.initializer);
                }
                this.emitTaggedExpr(d.initializer); this._emitVarStore(name.text, this.scratchB); this.m.drop();
                if (this._inModInit && this.usesKeyOrder && this._modObjKeys && this._modObjKeys.has(name.text)) {
                    for (const k2 of this._modObjKeys.get(name.text)) {   // 模块级对象键序（start 段 mem 未绑定 → 用 order_note）
                        this._emitVarGet(name.text); this.m.i32Const(this._strId(k2)); this.m.call("qz.order_note");
                    }
                }
            }
            return;
        }
        if (!d.initializer) return;
        this.emitTaggedExpr(d.initializer); M.localSet(this.scratch);
        if (ts.isArrayBindingPattern(name)) {
            // 非 wasm 数组/字符串的可迭代（Set/Map/自定义 @@iterator/类实例）→ 迭代协议收集为数组
            // （JS 数组解构走 Iterator；此前直接按索引读 → 静默 undefined）
            { const Mt = this.m;
              Mt.localGet(this.scratch); Mt.i64Const(48n); Mt.i64ShrU(); Mt.i64Const(0x7ffbn); Mt.i64Eq();
              Mt.localGet(this.scratch); Mt.i64Const(48n); Mt.i64ShrU(); Mt.i64Const(0x7ffan); Mt.i64Eq();
              Mt.i32Or(); Mt.i32Eqz();
              Mt.ifBlock("void");
              Mt.localGet(this.scratch); Mt.call("qz.iter_array"); Mt.localSet(this.scratch);
              Mt.end(); }
            let i = 0;
            for (const el of name.elements) {
                if (ts.isOmittedExpression(el)) { i++; continue; }
                if (ts.isBindingElement(el) && el.dotDotDotToken) {     // [...rest] → 宿主 arr.slice(i)
                    M.localGet(this.scratch); M.i32Const(this._strId("slice"));
                    M.i64ConstBits(...f64Bits(i));
                    this._emitUndefined(); this._emitUndefined(); this._emitUndefined();
                    this._emitUndefined();   // ovf（实参 4..；当前恒 undefined，>4 形参支持后由调用点传入）
                    M.call("qz.method_call");
                    this._emitBindingTarget(el.name);
                    i++;
                    continue;
                }
                this._emitElemOf(this.scratch, ts.factory.createNumericLiteral(i));
                if (ts.isBindingElement(el) && el.initializer) this._emitDefaultIfUndef(el.initializer);
                this._emitBindingTarget(el.name);
                i++;
            }
        } else {   // ObjectBindingPattern
            // {...rest} 需排除「其余解构键」→ 先汇总（最多 4 个，超出报错）
            const restExcl = [];
            for (const el of name.elements) {
                if (!ts.isBindingElement(el) || el.dotDotDotToken) continue;
                const k = el.propertyName ? (ts.isIdentifier(el.propertyName) ? el.propertyName.text : null)
                                          : (ts.isIdentifier(el.name) ? el.name.text : null);
                if (k === null) throw new Error("[tagged] 暂不支持计算属性名的解构");
                restExcl.push(k);
            }
            for (const el of name.elements) {
                if (!ts.isBindingElement(el)) continue;
                const key = el.propertyName ? (ts.isIdentifier(el.propertyName) ? el.propertyName.text : null)
                                            : (ts.isIdentifier(el.name) ? el.name.text : null);
                if (key === null) throw new Error("[tagged] 暂不支持计算属性名的解构");
                if (el.dotDotDotToken) {                               // {...rest} → 宿主 object_rest
                    if (restExcl.length > 4) throw new Error("[tagged] 对象 rest 解构最多排除 4 个键");
                    M.localGet(this.scratch);
                    for (let i = 0; i < 4; i++) M.i32Const(i < restExcl.length ? this._strId(restExcl[i]) : -1);
                    M.call("qz.object_rest");
                    this._emitBindingTarget(el.name);
                    continue;
                }
                this._emitPropReadFromLocal(this.scratch, key);        // 越界 → undefined（不再裸读内存）
                if (el.initializer) this._emitDefaultIfUndef(el.initializer);
                this._emitBindingTarget(el.name);
            }
        }
    }
    // 栈顶值 → 绑定目标。仅支持 Identifier（单层解构）；嵌套 pattern 明确报错（避免静默错值）。
    _emitBindingTarget(name) {
        if (!ts.isIdentifier(name)) {                    // 嵌套模式（[[a],[b]] / {a:{b}}）：值入槽后递归析构
            const t = this._expEnter();
            this.m.localSet(t.v);
            this._emitDestructurePattern(name, t.v);
            this._expLeave();
            return;
        }
        if (ts.isIdentifier(name)) { this.m.localSet(this._local(name.text)); return; }
        throw new Error("[tagged] 嵌套解构未实现（`const [[a],[b]] = …` / `const {a:{b}} = …`）；请用中间变量展开");
    }

    // 收集函数体内所有箭头函数/函数表达式（含嵌套），按源序。返回节点列表。
    _collectLambdas(node, out = []) {
        const walk = (n) => {
            if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) out.push(n);
            else if (ts.isFunctionDeclaration(n) && n.name && !(this.hoistedFns && this.hoistedFns.has(n))) out.push(n);
            else if ((ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n))
                     && ts.isObjectLiteralExpression(n.parent)) out.push(this._memberLambda(n));
            ts.forEachChild(n, walk);
        };
        walk(node);
        return out;
    }
    // 闭包捕获分析：找 lambda 体内的自由标识符（非其参数/局部、非字符串/数字/对象属性名）。
    // 捕获的变量来自创建处（外层函数局部）。返回有序捕获名列表。
    _capturesOf(lam) {
        const lambdaIsArrow = ts.isArrowFunction(lam);   // 箭头继承 this；function 表达式有自己的 this
        const local = new Set();
        for (const p of lam.parameters) for (const n of this._patternNames(p.name)) local.add(n);
        this._collectLocals(lam.body).forEach(n => local.add(n));
        const out = [];
        const seen = new Set();
        const walk = (n) => {
            if (ts.isThis(n)) {   // 箭头函数继承 this → 视作捕获 "this"
                // 合成的访问器/方法闭包把 self 作为名为 "this" 的**形参** → 不作捕获
                if (!local.has("this") && (lambdaIsArrow && !seen.has("this"))) { seen.add("this"); out.push("this"); }
                ts.forEachChild(n, walk); return;
            }
            if (ts.isIdentifier(n)) {
                // 跳过成员表达式右侧（obj.prop 的 prop 不是变量）
                if (n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) return;
                if (n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name === n) return;
                const name = n.text;
                if (!local.has(name) && !seen.has(name) && !this.fnNames.has(name)
                    && !(this.classes.has(this._className(name) || name))   // 类名不是自由变量（闭包内须走类对象路径）
                    && !(this.moduleGlobals && this.moduleGlobals.has(name))   // 模块级全局：闭包内改为调用时读全局（否则按创建时值捕获 → 自递归箭头 const 拿到 undefined）
                    && !/^(undefined|null|NaN|Infinity)$/.test(name)) { seen.add(name); out.push(name); }
                return;
            }
            ts.forEachChild(n, walk);
        };
        walk(lam.body);
        return out;
    }
    // 静态接收者分析：返回 Map(变量名 → 类名)，仅收录静态类精确可判的变量——
    // `let/const x = new C(...)` 且 x 在全函数体内从未被写、也未被任何嵌套闭包引用（保守）。
    // 依据：new C 只会产出类 C 的实例（本编译器无跨类原型改写），故 x 的动态类恒为 C。
    _computeStaticVars(body, paramNames) {
        const declaredClass = new Map();   // 名字 → 类名（仅直接 new C 初始化）
        // 作用域安全：同名被多处绑定（内层遮蔽/重复声明/与参数重名）→ 名字整体不可判。
        const bound = new Set(paramNames || []), dup = new Set();
        const addBind = (nm) => { if (bound.has(nm)) dup.add(nm); else bound.add(nm); };
        const collectBinding = (bn) => {
            if (ts.isIdentifier(bn)) addBind(bn.text);
            else if (ts.isObjectBindingPattern(bn) || ts.isArrayBindingPattern(bn))
                for (const el of bn.elements) if (ts.isBindingElement(el)) collectBinding(el.name);
        };
        const isNewIdent = (n) => ts.isNewExpression(n) && ts.isIdentifier(n.expression);
        const walkDecl = (n) => {
            if (ts.isVariableDeclaration(n)) {
                collectBinding(n.name);
                if (ts.isIdentifier(n.name) && n.initializer && isNewIdent(n.initializer)) {
                    const cls = this._className(n.initializer.expression.text);
                    if (this.classes.has(cls)) {
                        const name = n.name.text;
                        if (declaredClass.has(name) && declaredClass.get(name) !== cls) declaredClass.set(name, null);
                        else declaredClass.set(name, cls);
                    }
                }
            }
            ts.forEachChild(n, walkDecl);
        };
        walkDecl(body);
        if (!declaredClass.size) return new Map();
        // 有潜在写/捕获的名字 → 取消追踪。注意：compileTS 的 TS transformer 会重建节点，
        // 不能依赖 child.parent 回链，故在遍历到写节点（赋值/自增/for-of）时主动取其目标。
        const mutated = new Set();
        const markNamesIn = (t) => {   // 收集子树内所有与追踪同名的标识符（含解构目标；多标不误）
            if (ts.isIdentifier(t)) { if (declaredClass.has(t.text)) mutated.add(t.text); return; }
            ts.forEachChild(t, markNamesIn);
        };
        const ASSIGN_LO = ts.SyntaxKind.FirstAssignment, ASSIGN_HI = ts.SyntaxKind.LastAssignment;
        const walkUse = (n, nest) => {
            const deeper = nest || ts.isArrowFunction(n) || ts.isFunctionExpression(n);
            if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ASSIGN_LO && n.operatorToken.kind <= ASSIGN_HI) {
                markNamesIn(n.left);
            } else if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
                markNamesIn(n.operand);
            } else if ((ts.isForOfStatement(n) || ts.isForInStatement(n))) {
                markNamesIn(n.initializer);
            } else if (ts.isIdentifier(n) && deeper && declaredClass.has(n.text)) {
                mutated.add(n.text);   // 出现在嵌套闭包内 → 保守作废
            }
            ts.forEachChild(n, (c) => walkUse(c, deeper));
        };
        walkUse(body, false);
        const out = new Map();
        for (const [name, cls] of declaredClass) if (cls && !mutated.has(name) && !dup.has(name)) out.set(name, cls);
        return out;
    }
    // 沿继承链解析方法所属类：从 cname 起向上找第一个声明了 method 的类；无则 null。
    _methodOwner(cname, method) {
        let cur = cname;
        while (cur) {
            const c = this.classes.get(cur);
            if (!c) return null;
            for (const m of c.methods) if (m.name === method) return cur;
            if (this._dynParentExpr(c)) return null;      // 动态父（mixin）：运行时父链不可静态解析 → 退回动态派发
            cur = c.parent && this.classes.has(c.parent) ? c.parent : null;
        }
        return null;
    }
    // 接收者静态类：标识符 → _staticVars；叶类方法体/构造器内的 `this` → _curClass。否则 null。
    // 静态方法/getter/setter 内 `this` 在本实现中按**定义类**解析。仅当调用类到定义类之间某层**自有**静态成员
    // 命中体内 `this.<name>` 访问集时才可能偏差（JS 的 this = 调用类）→ 此时 loud（避免静默错值）。
    _checkStaticThis(owner, callCls, sm, label) {
        if (!sm || !sm.thisNames || !sm.thisNames.size || owner === callCls) return;
        let x = callCls, hop = 0;
        while (x && x !== owner && hop++ < 100) {
            const c = this.classes.get(x);
            if (!c) break;
            const own = (arr2, nm) => (arr2 || []).some(k => k.name === nm);
            for (const nm of sm.thisNames) {
                if (own(c.staticFields, nm) || own(c.staticMethods, nm)) {
                    throw new Error(`[tagged] 静态成员 ${owner}.${label} 体内 \`this.${nm}\` 经派生类 ${callCls} 调用：this 应为派生类对象，未实现`);
                }
            }
            x = c.parent;
        }
    }
    _staticRecvClass(rx) {
        if (ts.isIdentifier(rx) && this._staticVars && this._staticVars.has(rx.text)) return this._staticVars.get(rx.text);
        if (rx.kind === ts.SyntaxKind.ThisKeyword && this._curClass && this._leafClasses.has(this._curClass)) return this._curClass;
        return null;
    }
    // owner 类声明的 method 元数据（含 accessor）；无则 null。
    _classMethodMeta(cname, method) {
        const c = this.classes.get(cname);
        if (!c) return null;
        for (const m of c.methods) if (m.name === method) return m;
        return null;
    }
    // 给定自由名，是否本函数可见（在 varMap / capMap 中）——决定闭包创建时是否真的捕获。
    _isCapturable(name) { return this.varMap.has(name) || this.capMap.has(name); }
    // 闭包体内的捕获读：name 在 capMap → [blk + slot*8]；否则本函数局部（经 varMap）。
    _emitCapturedRead(name) {
        const M = this.m;
        if (this.capMap.has(name)) { M.localGet(this.capMap.get(name)); M.i32Const(this._strId(name)); M.call("qz.env_get"); return; }
        const idx = this._local(name);
        if (idx === undefined) {
            const g = this.moduleGlobals && this.moduleGlobals.get(name);
            if (g !== undefined) { M.globalGet(g); return; }   // 模块级变量
            if (this.fnNames && this.fnNames.has(name) && this.m._funcIdx[this._fnName(name)] !== undefined) {
                // 顶层函数作值（回调/别名/属性宿主）→ 包装为宿主函数句柄（此前 loud：未定义捕获变量）
                M.i32Const(this._strId(this._fnName(name))); M.i32Const((this._fnParams && this._fnParams.get(this._fnName(name))) || 0); M.call("qz.fn_value");
                return;
            }
            if (BUILTIN_GLOBALS.has(name)) { M.i32Const(this._strId(name)); M.call("qz.builtin_member"); return; }   // 内建全局作值（Symbol/Math/JSON…）
            throw new Error("未定义捕获变量: " + name);
        }
        M.localGet(idx);
    }

    // 变量读（含闭包捕获）：栈 += 值。
    _emitVarGet(name) {
        if (this.capMap.has(name)) { this.m.localGet(this.capMap.get(name)); this.m.i32Const(this._strId(name)); this.m.call("qz.env_get"); return; }
        const idx = this._local(name);
        if (idx === undefined) {
            const g = this.moduleGlobals && this.moduleGlobals.get(name);
            if (g !== undefined) { this.m.globalGet(g); return; }   // 模块级变量
            if (this.fnNames && this.fnNames.has(name) && this.m._funcIdx[this._fnName(name)] !== undefined) {
                this.m.i32Const(this._strId(this._fnName(name))); this.m.i32Const((this._fnParams && this._fnParams.get(this._fnName(name))) || 0); this.m.call("qz.fn_value");
                return;
            }
            if (BUILTIN_GLOBALS.has(name)) { this.m.i32Const(this._strId(name)); this.m.call("qz.builtin_member"); return; }
            throw new Error("未定义变量: " + name);
        }
        this.m.localGet(idx);
    }
    // 变量写（含闭包捕获）：栈顶值 → 变量，并保留该值（赋值表达式结果）。
    // tmp 为捕获路径的暂存 local（默认 scratch）；调用点须保证其空闲。
    _emitVarStore(name, tmp) {
        const M = this.m;
        if (this.capMap.has(name)) {
            const t = tmp === undefined ? this.scratch : tmp;
            M.localSet(t);
            M.localGet(this.capMap.get(name)); M.i32Const(this._strId(name)); M.localGet(t); M.call("qz.env_set");
            M.localGet(t);
            return;
        }
        const idx = this._local(name);
        if (idx === undefined) {
            const g = this.moduleGlobals && this.moduleGlobals.get(name);
            if (g !== undefined) {                 // 模块级变量：写全局并保留值（赋值表达式结果，无需临时槽）
                M.globalSet(g); M.globalGet(g);
                return;
            }
            throw new Error("未定义变量: " + name);
        }
        M.localTee(idx);
    }
    // .length 计算（base 句柄在 local `base`）：字符串(0x7FFA) → qzs_utf16len（UTF-16 码元数）；
    // 数组(0x7FFB) → 结构首 i32（元素数）；其余 → qz.str_len（跨界）。
    _emitLengthOf(base) {
        const M = this.m;
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffan); M.i64Eq();
        M.ifBlock("i64");
        M.localGet(base); M.i32WrapI64(); M.call("qzs_utf16len"); M.f64ConvertI32U(); M.i64ReinterpretF64();
        M.else_();
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
        M.ifBlock("i64");
        M.localGet(base); M.i32WrapI64(); M.i32Load(2, 0); M.f64ConvertI32U(); M.i64ReinterpretF64();
        M.else_();
        M.localGet(base); M.call("qz.length_of");    // 宿主数组/宿主字符串句柄/POJO（物化 → JS .length）
        M.end(); M.end();
    }
    // 下标读 base[i]（base 句柄在 local `base`）：字符串键或非 wasm 数组 → 宿主 qz.get_index；
    // wasm 数组(0x7FFB) + 数值键 → 内存 dataOff + i*8（快路径）。
    _emitElemOf(base, idxExpr) {
        const M = this.m, t = this._expEnter();
        this.emitTaggedExpr(idxExpr); M.localSet(t.w);              // 键
        M.localGet(t.w); this._emitIsStr();
        M.ifBlock("i64");
        M.localGet(base); M.localGet(t.w); M.call("qz.get_index");  // 字符串键 → 宿主
        M.else_();
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
        M.ifBlock("i64");                                           // wasm 数组 + 数值键
        this._emitInt32Safe(t.w);
        M.ifBlock("i64");
        M.localGet(t.w); M.f64ReinterpretI64(); M.i32TruncF64S(); M.localSet(t.a);
        M.localGet(t.a); M.localGet(base); M.i32WrapI64(); M.i32Load(2, 0); M.i32LtU();   // idx <u len（负数→巨大→假）
        M.ifBlock("i64");
        M.localGet(base); M.i32WrapI64(); M.i32Load(2, 8);
        M.localGet(t.a); M.i32Const(8); M.i32Mul(); M.i32Add(); M.i64Load(3, 0);
        { const th = this._expEnter(); M.localSet(th.v);                 // 洞 → undefined
          M.localGet(th.v); M.i64ConstBits(2, 0x7ff90000); M.i64Eq();
          M.ifBlock("i64"); this._emitUndefined(); M.else_(); M.localGet(th.v); M.end();
          this._expLeave(); }
        M.else_();
        this._emitUndefined();                                      // 越界 → undefined（JS 语义）
        M.end();
        M.else_();
        M.localGet(base); M.localGet(t.w); M.call("qz.get_index");   // NaN/超范围索引 → 宿主
        M.end();
        M.else_();
        M.localGet(base); M.localGet(t.w); M.call("qz.get_index");   // 非 wasm 数组（宿主数组/字符串/POJO/实例）
        M.end();
        M.end();
        this._expLeave();
    }
    // 属性读 base.a（接收者已求值于 local `base`）：宿主对象(0x7FFD) → object_get；
    // POJO(0x7FF9|off≥8)/类实例(0x7FFE|off) → 内存 load 且**越界（无此字段）→ undefined**；
    // 其余（数组/字符串/数字上的普通属性）→ undefined。
    _emitPropReadFromLocal(base, name) {
        const M = this.m;
        if (name === "stack") { M.localGet(base); M.call("qz.err_stack"); return; }   // Error 族 .stack → 宿主合成
        if (name === "constructor") {                    // 实例 .constructor → 类对象（JS 语义）；非实例退回宿主 prop_get
            M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffen); M.i64Eq();
            M.ifBlock("i64");
            M.localGet(base); M.i32WrapI64(); M.i32Load(2, 0); M.call("qz.class_value");   // 实例内存[0] = __cls
            M.else_();
            M.localGet(base); M.i32Const(this._strId(name)); M.call("qz.prop_get");
            M.end();
            return;
        }
        if (this._hasAccessor(name, "get") || this._hasMethodName(name)
            || /^(hasOwnProperty|isPrototypeOf|propertyIsEnumerable|toLocaleString|valueOf)$/.test(name)) {   // 含 Object.prototype 方法

            M.localGet(base); M.i32Const(this._strId(name)); M.call("qz.prop_get");
            this._emitErrCheck();        // getter 抛错 → 转入本函数 catch
            return;
        }
        const foff = this._fieldIndex(name);
        // 字符串/数组/纯数值：属性读 → 宿主（方法名返回绑定函数：truthy + 可调用；(1).toLocaleString 亦是函数）
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffan); M.i64Eq();
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
        M.i32Or();
        this._emitIsHandle(base); M.i32Eqz();
        M.i32Or();
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7fffn); M.i64Eq();   // 闭包值（函数）→ 自身属性 length/name/toString/call…
        M.i32Or();
        M.ifBlock("i64");
        M.localGet(base); M.i32Const(this._strId(name)); M.call("qz.prop_get");
        M.else_();
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffdn); M.i64Eq();
        M.ifBlock("i64");
        M.localGet(base); M.i32Const(this._strId(name)); M.call("qz.object_get");
        M.else_();
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ff9n); M.i64Eq();
        M.localGet(base); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffEn); M.i64Eq();
        M.i32Or();
        M.ifBlock("i64");
        const t = this._expEnter();
        M.localGet(base); M.i32WrapI64(); M.localSet(t.a);
        M.localGet(t.a); M.i32Const(8); M.i32GeU();
        M.localGet(t.a); M.i32Load(2, 4); M.i32Const(foff + 8); M.i32GeU();
        M.i32And();
        M.ifBlock("i64");
        if (this.usesDynAcc) { M.localGet(base); M.i32Const(this._strId(name)); M.call("qz.prop_get"); }   // 访问器表（运行时 defineProperty）
        else { M.localGet(t.a); M.i64Load(3, foff); }
        M.else_();
        // 未赋值/越界/undefined|null：交宿主（POJO 未赋值 → undefined；undefined/null → TypeError）
        M.localGet(base); M.i32Const(this._strId(name)); M.call("qz.prop_get");
        M.end();
        this._expLeave();
        M.else_();
        this._emitUndefined();
        M.end();
        M.end();
        M.end();   // 关「str/arr 方法读取」外层 if
    }
    _countForOf(node) {
        let n = 0;
        const walk = (x) => { if (ts.isForOfStatement(x) || ts.isForInStatement(x)) n++; ts.forEachChild(x, walk); };
        walk(node);
        return n;
    }

    // ++obj.a / obj.a-- / this.#v++：接收者求值一次 → 属性读 ±1 → 属性写回（宿主/POJO/访问器统一分派）。
    // prefix：表达式结果 = 新值；postfix：结果 = 旧值。
    _emitIncDecProp(operand, inc, kind) {
        const M = this.m, t = this._expEnter();
        const pname = ts.isPrivateIdentifier(operand.name) && this._curClass
            ? "#" + this._curClass + "#" + operand.name.text : operand.name.text;
        this.emitTaggedExpr(operand.expression); M.localSet(t.v);              // 接收者（一次求值）
        M.localGet(t.v); this._emitPropReadFromLocal(t.v, pname); M.localSet(t.w);   // 旧值
        M.localGet(t.w); M.i64ConstBits(...f64Bits(1));
        this.emitGuardedOp(inc ? "qz.add" : "qz.sub", inc ? M.f64Add : M.f64Sub);
        M.localSet(t.x);                                                       // 新值
        M.localGet(t.x);                                                       // 供存储
        this._emitStorePropValue(operand, t.v);                                // 写回（消费值、留新值）
        M.drop();
        if (kind === "prefix") M.localGet(t.x); else M.localGet(t.w);           // 结果
        this._expLeave();
        return true;
    }
    // 值在栈顶 → 写到 left.expression（接收者已在 local recvLocal）
    _emitStorePropValue(left, recvLocal) {
        const M = this.m, t = this._expEnter();
        M.localSet(t.w);                                    // 值
        const pname = ts.isPrivateIdentifier(left.name) && this._curClass
            ? "#" + this._curClass + "#" + left.name.text : left.name.text;
        M.localGet(recvLocal); M.localSet(t.v);             // 接收者
        M.localGet(t.v); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffdn); M.i64Eq();
        M.ifBlock("void");
        M.localGet(t.v); M.i32Const(this._strId(pname)); M.localGet(t.w); M.call("qz.object_set");
        M.else_();
        M.localGet(t.v); this._emitStrLitHandle(pname); M.localGet(t.w); M.call("qz.set_index");
        this._emitErrCheck(false);   // 冻结/不可扩展对象写入 → 抛 TypeError（转入 catch）
        M.end();
        M.localGet(t.w);
        this._expLeave();
    }
    // 调用点错误检查（try 内）：栈顶是调用结果 → 存入临时槽，__err≠0 则跳到最近的 $err；否则恢复结果。
    // 跨函数 throw 的落地点：被调函数设 __err 并正常返回，调用方在此转成异常路径。
    _emitErrCheck(keepValue = true) {
        const M = this.m, t = this._expEnter();
        if (keepValue) M.localSet(t.v);
        M.globalGet(1); M.i64Eqz(); M.i32Eqz();                  // __err != 0 ?
        M.ifBlock("void");
        if (this._tryStack.length) {
            M.br((this.depth + 1) - this._tryStack[this._tryStack.length - 1].errBrk);   // +1：本 if 自身多一层 block
        } else {
            this._emitPendingFinally(true, false);                // 无 try → 跑完 finally 后立即向上返回
            if (!this._fnVoid) this._emitUndefined();
            M.return_();
        }
        M.end();
        if (keepValue) M.localGet(t.v);
        this._expLeave();
    }
    // 值调用：被调值求值到可重入槽 → 参数压栈 → qz.call_value（闭包 → closure_call；宿主函数 → 调用）
    // 第 6 参 = 溢出实参数组（args[3..]）：闭包形参 >4 时宿主按 meta.n 展开（本 ABI 仅 4 个实参槽）
    // o[Symbol.<wellknown>] ≡ o["@@<name>"]：类/对象字面量的 [Symbol.x] 成员在 this.classes 里登记为 @@<x>（物化时挂真 Symbol）。
    _symKeyName(expr) {
        if (!expr || !ts.isPropertyAccessExpression(expr) || !ts.isIdentifier(expr.expression) || expr.expression.text !== "Symbol") return null;
        const n = expr.name.text;
        return /^(iterator|asyncIterator|toPrimitive|toStringTag|hasInstance|isConcatSpreadable|species|match|replace|search|split|matchAll)$/.test(n) ? "@@" + n : null;
    };
    _emitValueCall(calleeExpr, args, recvExpr) {
        const M = this.m, t = this._expEnter();
        this.emitTaggedExpr(calleeExpr); M.localSet(t.v);
        M.localGet(t.v);
        for (let i = 0; i < 4; i++) {
            if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
        }
        if (args.length > 4) {
            const ovfNodes = args.slice(3);
            if (ovfNodes.some(a2 => ts.isSpreadElement(a2))) throw new Error("[tagged] 值调用的溢出实参与展开混用暂不支持");
            const litV = ts.factory.createArrayLiteralExpression(ovfNodes);
            litV.pos = args[0].pos; litV.end = args[args.length - 1].end;
            this.emitTaggedExpr(litV);
        } else this._emitUndefined();
        if (recvExpr) this.emitTaggedExpr(recvExpr); else this._emitUndefined();   // recv（普通调用 = undefined；字段/访问器取值调用 = receiver）
        M.call("qz.call_value");
        this._emitErrCheck();
        this._expLeave();
    }

    // 展开实参调用：实参合成一个数组（复用数组字面量展开路径），宿主按 callee 动态调用。
    _emitSpreadCall(e) {
        const M = this.m, t = this._expEnter();
        // 实参数组：createArrayLiteralExpression(e.arguments)（含 SpreadElement → 走 concat 折叠）
        const isStaticSpread = ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression) && this._isClassName(e.expression.expression);
        // 静态方法 ABI 为 (self, a0..a3)：实参数组前置 undefined 占位 self
        const elems = isStaticSpread ? [ts.factory.createIdentifier("undefined"), ...e.arguments] : e.arguments;
        const lit = ts.factory.createArrayLiteralExpression(elems);
        lit.pos = e.pos; lit.end = e.end;
        this.emitTaggedExpr(lit); M.localSet(t.v);
        const cx = e.expression;
        if (ts.isPropertyAccessExpression(cx) && ts.isIdentifier(cx.expression) && this._isClassName(cx.expression)) {
            // C.m(...args)：静态方法直调（导出名静态可知）
            let owner = this._className(cx.expression.text);
            const method = ts.isPrivateIdentifier(cx.name) ? "#" + this._className(cx.expression.text) + "#" + cx.name.text : cx.name.text;
            while (owner && !(this.classes.get(owner).staticMethods || []).some(s2 => s2.name === method)) owner = this.classes.get(owner).parent;
            if (!owner) throw new Error(`[tagged] 静态方法 ${cx.expression.text}.${method}() 未定义`);
            this._emitStaticsGuard(cx.expression.text);
            M.i32Const(this._strId(staticMethName(owner, method))); M.localGet(t.v); M.i32Const(0);
            M.call("qz.call_named");
            this._expLeave();
            return;
        }
        if (ts.isPropertyAccessExpression(cx) && ts.isIdentifier(cx.expression) && BUILTIN_GLOBALS.has(cx.expression.text)) {
            M.i32Const(this._strId(cx.expression.text + "." + cx.name.text)); M.localGet(t.v);
            M.call("qz.builtin_spread");
            this._expLeave();
            return;
        }
        if (!ts.isIdentifier(cx)) throw new Error("[tagged] 展开实参仅支持顶层函数/闭包/静态方法/内建调用");
        const name = this._fnName(cx.text);
        if (this.m._funcIdx[name] !== undefined || this.fnNames.has(name)) {
            const isNum = !!(this._calleeInfo(cx.text) && this._calleeInfo(cx.text).mode === "num");
            const cp2 = this._calleeParams(cx.text) || this._calleeParams(name);
            const hasRest2 = !!(cp2 && cp2.length > 0 && cp2[cp2.length - 1].dotDotDotToken);
            if (hasRest2) {
                // rest 收尾：按形参表拆包（固定形参取元素、rest 取 slice）→ 直调（元数天然匹配）
                const nFix = cp2.length - 1;
                for (let i = 0; i < nFix; i++) this._emitElemOf(t.v, ts.factory.createNumericLiteral(i));
                M.localGet(t.v); M.i32Const(this._strId("slice"));
                M.i64ConstBits(...f64Bits(nFix)); this._emitUndefined(); this._emitUndefined(); this._emitUndefined();
                this._emitUndefined();   // ovf（实参 4..；当前恒 undefined，>4 形参支持后由调用点传入）
                M.call("qz.method_call");
                M.call(this._fnName(name));
                this._retFromCallee(cx.text);
                this._expLeave();
                return;
            }
            M.i32Const(this._strId(name)); M.localGet(t.v); M.i32Const(isNum ? 1 : 0);
            M.call("qz.call_named");
            this._expLeave();
            return;
        }
        // 闭包：句柄（局部或 env_get）→ closure_call_spread
        if (this.capMap.has(cx.text)) { M.localGet(this.capMap.get(cx.text)); M.i32Const(this._strId(cx.text)); M.call("qz.env_get"); M.localSet(t.w); }
        else if (this.moduleGlobals && this.moduleGlobals.get(cx.text) !== undefined) {
            M.globalGet(this.moduleGlobals.get(cx.text)); M.localSet(t.w);   // 模块级 const 持有闭包（展开调用此前漏查 → 未定义函数）
        }
        else {
            const hIdx = this._local(cx.text);
            if (hIdx === undefined) throw new Error("未定义函数: " + cx.text);
            M.localGet(hIdx); M.localSet(t.w);
        }
        // rest 收尾的闭包：实参数组即其唯一形参（其余槽 undefined）
        const cp3 = this._calleeParams(cx.text);
        const hasRest3 = !!(cp3 && cp3.length > 0 && cp3[cp3.length - 1].dotDotDotToken);
        M.localGet(t.w);
        if (hasRest3) {
            const nFix3 = cp3.length - 1;
            for (let i = 0; i < nFix3; i++) this._emitElemOf(t.v, ts.factory.createNumericLiteral(i));
            M.localGet(t.v); M.i32Const(this._strId("slice"));
            M.i64ConstBits(...f64Bits(nFix3)); this._emitUndefined(); this._emitUndefined(); this._emitUndefined();
            this._emitUndefined();   // ovf（实参 4..；当前恒 undefined，>4 形参支持后由调用点传入）
            M.call("qz.method_call");
            for (let i = cp3.length; i < 4; i++) this._emitUndefined();
            this._emitUndefined();                                    // recv（展开/可变调用：普通调用 = undefined）
            M.call("qz.closure_call");
        }
        else { M.localGet(t.v); M.call("qz.closure_call_spread"); }
        this._expLeave();
    }
    // 被调函数（已解析到 AST）是否以 rest 形参收尾 → 返回其形参数组，否则 null。
    _calleeParams(name) {
        const node = (this._fnNodes && this._fnNodes.get(name)) || null;
        return node ? node.parameters : null;
    }
    // 落栈实参：rest 收尾 → 固定参 + 打包数组；否则按元数补 undefined / 截断。
    _emitCallArgs(params, args, fnName, allowOverflow) {
        const M = this.m;
        const nPar = params.length;
        const hasRest = nPar > 0 && !!params[nPar - 1].dotDotDotToken;
        if (allowOverflow && !hasRest && nPar > 4) {
            for (let i = 0; i < 3; i++) {
                if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
            }
            const ovfA = args.slice(3);
            if (ovfA.some(a2 => ts.isSpreadElement(a2))) throw new Error(`[tagged] ${fnName} 的溢出实参与展开混用暂不支持`);
            const litA = ts.factory.createArrayLiteralExpression(ovfA);
            litA.pos = args.length ? args[0].pos : 0; litA.end = args.length ? args[args.length - 1].end : 0;
            this.emitTaggedExpr(litA);
            return;
        }
        if (!hasRest) {
            for (let i = 0; i < nPar; i++) {
                if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
            }
            return;
        }
        const nFix = nPar - 1;
        for (let i = 0; i < nFix; i++) {
            if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
        }
        const rest = args.slice(nFix);
        if (rest.some(a2 => ts.isSpreadElement(a2))) throw new Error(`[tagged] ${fnName} 的 rest 实参与展开混用暂不支持`);
        const lit = ts.factory.createArrayLiteralExpression(rest);
        lit.pos = args.length ? args[0].pos : 0; lit.end = args.length ? args[args.length - 1].end : 0;
        this.emitTaggedExpr(lit);
    }

    // 闭包调用：closure_call(handle, a0..a3)。句柄先入可重入槽（参数求值可能嵌套闭包调用），
    // 再按「句柄在前、4 参压栈」顺序调用（参数求值用栈深度隔离，无需逐参临时）。
    _emitClosureCall(fn, args) {
        const M = this.m, t = this._expEnter();
        if (this.capMap.has(fn)) { M.localGet(this.capMap.get(fn)); M.i32Const(this._strId(fn)); M.call("qz.env_get"); M.localSet(t.v); }
        else {
            const hIdx = this._local(fn);
            const gIdx = this.moduleGlobals && this.moduleGlobals.get(fn);
            if (hIdx === undefined && gIdx === undefined) throw new Error(BUILTIN_GLOBALS.has(fn)
                ? `[tagged] 内建 ${fn}() 未实现（AOT 仅编译用户代码 + qz.* 契约面）`
                : "未定义函数: " + fn);
            if (hIdx !== undefined) M.localGet(hIdx); else M.globalGet(gIdx);   // 模块级变量持闭包值
            M.localSet(t.v);
        }
        M.localGet(t.v);
        const cp0raw = this._calleeParams(fn);
        // 带 `this` 形参的被调：receiver 由宿主按 `synthThis` 约定前置（本处不占实参槽）
        const cp = (cp0raw && cp0raw.length && ts.isIdentifier(cp0raw[0].name) && cp0raw[0].name.text === "this") ? cp0raw.slice(1) : cp0raw;
        const needOvf = (cp === null && args.length > 3) || (cp !== null && cp.length > 4);   // >4 形参（含 rest）恒用溢出约定
        if (needOvf) {
            // 形参未知（变量/参数持闭包）或 >4 形参：a0..a3 = 实参 0..3，第 6 参 = 实参 3.. 数组（宿主按 meta.n 还原）
            for (let i = 0; i < 4; i++) {
                if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
            }
            const ovfN = args.slice(3);
            if (ovfN.some(a2 => ts.isSpreadElement(a2))) throw new Error("[tagged] 闭包调用的溢出实参与展开混用暂不支持");
            const litK = ts.factory.createArrayLiteralExpression(ovfN);
            litK.pos = args.length ? args[0].pos : 0; litK.end = args.length ? args[args.length - 1].end : 0;
            this.emitTaggedExpr(litK);
            this._emitUndefined();                                    // recv（普通调用 = undefined）
            M.call("qz.call_value");
            this._emitErrCheck();
            this._expLeave();
            return;
        }
        if (cp) {
            this._emitMethodArgs(cp, args);        // 已知形参表：4 槽（含 rest 打包；>4 的 ovf 分支在上方 call_value 路径已处理）
        } else {
            for (let i = 0; i < 4; i++) {
                if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
            }
        }
        this._emitUndefined();                                        // recv（普通调用 = undefined）
        M.call("qz.closure_call");
        this._emitErrCheck();
        this._expLeave();
    }
    // JS `let`/`const` 循环绑定：闭包捕获循环变量时**每次迭代**一个新绑定。
    // 机制：迭代体开头 envRef = env_new(旧 env)，把（被捕获的）循环头变量按当前值 env_def 进新层；
    // 体内的 let/const 捕获名先 env_def 为 undefined（使声明写入本层而非上层）。
    _emitPerIterEnv(headerNames, bodyNames) {
        const M = this.m;
        if (this.envLocal === undefined) return;                 // 本函数无 env（未捕获）
        const t = this._expEnter();                                // t.a/t.b 为 i32（env 索引），t.v.. 为 i64
        M.localGet(this.envLocal); M.localSet(t.a);                // oldEnv 索引（保留，供读取旧值）
        M.localGet(t.a); M.call("qz.env_new"); M.i32WrapI64(); M.localSet(this.envLocal);   // 新一层（parent = oldEnv）
        for (const n of headerNames) {
            M.localGet(this.envLocal); M.i32Const(this._strId(n));
            M.localGet(t.a); M.i32Const(this._strId(n)); M.call("qz.env_get");
            M.call("qz.env_def");
        }
        for (const n of bodyNames) {
            M.localGet(this.envLocal); M.i32Const(this._strId(n)); this._emitUndefined(); M.call("qz.env_def");
        }
        this._expLeave();
    }
    // 循环体（含嵌套 lambda）捕获的、属于该循环作用域的变量名 → 需要每迭代新绑定。
    _loopCaptured(headerNames, body) {
        if (this.envLocal === undefined) return null;
        const lams = this._collectLambdas(body);
        if (!lams.length) return null;
        const bodyNames = this._collectLocals(body);
        const headerSet = new Set(headerNames), bodySet = new Set(bodyNames);
        const outH = [], outB = [];
        for (const lam of lams) for (const c of this._capturesOf(lam)) {
            if (headerSet.has(c) && !outH.includes(c)) outH.push(c);
            else if (bodySet.has(c) && !outB.includes(c)) outB.push(c);
        }
        if (!outH.length && !outB.length) return null;
        return { headerNames: outH, bodyNames: outB };
    }
    // 循环头声明的 let/const 名（for / for-of / for-in）；var 不参与每迭代绑定。
    _headerNames(node) {
        const out = [];
        const add = (l) => {
            if (!ts.isVariableDeclarationList(l)) return;
            if (l.flags & ts.NodeFlags.Let || l.flags & ts.NodeFlags.Const) {
                for (const d of l.declarations) for (const n of this._patternNames(d.name)) out.push(n);
            }
        };
        if (ts.isForStatement(node)) add(node.initializer);
        else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) add(node.initializer);
        return out;
    }

    // 绑定模式（含嵌套）里绑定的所有名字。
    _patternNames(pat, out = []) {
        if (ts.isIdentifier(pat)) { out.push(pat.text); return out; }
        if (ts.isArrayBindingPattern(pat) || ts.isObjectBindingPattern(pat)) {
            for (const el of pat.elements) {
                if (ts.isOmittedExpression(el)) continue;
                if (ts.isBindingElement(el)) this._patternNames(el.name, out);
            }
        }
        return out;
    }
    // 把 local `valLocal`(i64) 按绑定模式 pat 析构到各目标变量（含 rest / 默认值）。
    _emitDestructurePattern(pat, valLocal) {
        const M = this.m;
        if (ts.isArrayBindingPattern(pat)) {
            // 非 wasm 数组/字符串的可迭代（Set/Map/自定义 @@iterator/类实例）→ 迭代协议收集为数组
            // （JS 数组解构走 Iterator；此前直接按索引读 → 静默 undefined）
            M.localGet(valLocal); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
            M.localGet(valLocal); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffan); M.i64Eq();
            M.i32Or(); M.i32Eqz();
            M.ifBlock("void");
            M.localGet(valLocal); M.call("qz.iter_array"); M.localSet(valLocal);
            M.end();
            let i = 0;
            for (const el of pat.elements) {
                if (ts.isOmittedExpression(el)) { i++; continue; }
                if (!ts.isBindingElement(el)) continue;
                if (el.dotDotDotToken) {
                    M.localGet(valLocal); M.i32Const(this._strId("slice"));
                    M.i64ConstBits(...f64Bits(i)); this._emitUndefined(); this._emitUndefined(); this._emitUndefined();
                    this._emitUndefined();   // ovf（实参 4..；当前恒 undefined，>4 形参支持后由调用点传入）
                    M.call("qz.method_call");
                    this._emitBindingTarget(el.name);
                    i++; continue;
                }
                this._emitElemOf(valLocal, ts.factory.createNumericLiteral(i));
                if (el.initializer) this._emitDefaultIfUndef(el.initializer);
                this._emitBindingTarget(el.name);
                i++;
            }
            return;
        }
        if (ts.isObjectBindingPattern(pat)) {
            const restExcl = [];
            for (const el of pat.elements) {
                if (!ts.isBindingElement(el) || el.dotDotDotToken) continue;
                const k = el.propertyName ? el.propertyName.text : (ts.isIdentifier(el.name) ? el.name.text : null);
                if (k === null) throw new Error("[tagged] 暂不支持计算属性名的解构");
                restExcl.push(k);
            }
            for (const el of pat.elements) {
                if (!ts.isBindingElement(el)) continue;
                if (el.dotDotDotToken) {
                    if (restExcl.length > 4) throw new Error("[tagged] 对象 rest 解构最多排除 4 个键");
                    M.localGet(valLocal);
                    for (let i = 0; i < 4; i++) M.i32Const(i < restExcl.length ? this._strId(restExcl[i]) : -1);
                    M.call("qz.object_rest");
                    this._emitBindingTarget(el.name);
                    continue;
                }
                const key = el.propertyName ? el.propertyName.text : (ts.isIdentifier(el.name) ? el.name.text : null);
                if (key === null) throw new Error("[tagged] 暂不支持计算属性名的解构");
                this._emitPropReadFromLocal(valLocal, key);
                if (el.initializer) this._emitDefaultIfUndef(el.initializer);
                this._emitBindingTarget(el.name);
            }
            return;
        }
        throw new Error("[tagged] 不支持的绑定模式");
    }
    // 形参序言：默认值（仅 undefined 触发，左→右）+ 解构形参。params[i] 原值在 local (base+i)。
    // 必须在「被捕获参数写 env」之前执行，使 env 见到最终值。
    _emitParamPrologue(params, base) {
        const M = this.m;
        for (let i = 0; i < params.length; i++) {
            const p = params[i];
            const idx = base + i;
            if (p.dotDotDotToken) {                       // rest 形参：调用方打包实参数组（未传 → 空数组）
                if (this.mode !== "tagged") throw new Error("[num] rest 形参不支持");
                M.localGet(idx); M.call("qz.is_undef");
                M.ifBlock("void");
                M.call("qz.empty_array"); M.localSet(idx);
                M.end();
            }
            if (p.initializer) {
                if (this.mode !== "tagged") throw new Error("[num] 形参默认值不支持（f64 ABI 无 undefined）");
                M.localGet(idx); M.call("qz.is_undef");
                M.ifBlock("void");
                this.emitTaggedExpr(p.initializer); M.localSet(idx);
                M.end();
            }
            if (!ts.isIdentifier(p.name)) {
                const t = this._expEnter();
                M.localGet(idx); M.localSet(t.v);
                this._emitDestructurePattern(p.name, t.v);
                this._expLeave();
            }
        }
    }

    // 由访问器/方法声明合成箭头函数节点（其体即闭包体 → 得到闭包句柄，供宿主 defineProperty 回调）。
    // 对象字面量 方法/访问器 → 合成箭头（缓存：捕获分析与发射必须用同一节点实例）
    _memberLambda(member) {
        this._synthLambdas = this._synthLambdas || new WeakMap();
        let f = this._synthLambdas.get(member);
        if (f) return f;
        const nm = member.name && member.name.text;
        if (ts.isMethodDeclaration(member)) {
            f = this._synthArrow(["this"].concat(member.parameters.map(q => q.name.text)).slice(0, 4), member.body);
            // 合成的形参表只有名字（丢 rest 标记）→ 显式标出，供 lamMeta.rest 与 ABI 打包使用
            const lp = member.parameters[member.parameters.length - 1];
            if (lp && lp.dotDotDotToken) f._qzRest = true;
        }
        else if (ts.isGetAccessorDeclaration(member)) f = this._synthArrow(["this"], member.body);
        else f = this._synthArrow(["this", member.parameters[0] ? member.parameters[0].name.text : "v"], member.body);
        this._synthLambdas.set(member, f);
        return f;
    }
    _synthArrow(paramNames, body) {
        const ps = paramNames.map(n => ts.factory.createParameterDeclaration(undefined, undefined, ts.factory.createIdentifier(n), undefined, undefined, undefined));
        const ar = ts.factory.createArrowFunction(undefined, undefined, ps, undefined,
            ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), body);
        ar.pos = body.pos; ar.end = body.end;
        ar._qzSynthThis = paramNames.length > 0 && paramNames[0] === "this";   // 合成 self 形参（真实槽位）
        return ar;
    }

    // 解构默认值：栈顶值 === undefined 则替换为 init（JS 语义：仅 undefined 触发，null 不触发）。
    _emitDefaultIfUndef(init) {
        const M = this.m, t = this._expEnter();
        M.localSet(t.v);
        M.localGet(t.v); M.call("qz.is_undef");
        M.ifBlock("i64");
        this.emitTaggedExpr(init);
        M.else_();
        M.localGet(t.v);
        M.end();
        this._expLeave();
    }
    // 函数体内的**嵌套函数声明**（未提升）在该函数入口先建闭包存入其变量（JS 函数声明提升语义：
    // 声明前可调用、可相互递归）。返回闭包句柄逐个写入变量（含经 env 的捕获写）。
    // 本作用域（含块/if/for/try 内，JS 提升到函数作用域）的函数声明；不深入嵌套函数体。
    _collectScopeFnDecls(body, out = []) {
        const walk = (n) => {
            if (ts.isFunctionDeclaration(n)) { if (n.name && !(this.hoistedFns && this.hoistedFns.has(n))) out.push(n); return; }
            if (ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isClassDeclaration(n)) return;
            ts.forEachChild(n, walk);
        };
        walk(body);
        return out;
    }
    _emitFnDeclClosures(body) {
        const M = this.m;
        this._fnVars = this._fnVars || new Set();
        for (const lam of this._collectScopeFnDecls(body)) {
            if (!lam.name) continue;
            this._fnVars.add(lam.name.text);
            this._fnNodes = this._fnNodes || new Map();
            this._fnNodes.set(lam.name.text, lam);
            this._emitLambdaNew(lam);                       // 栈：闭包句柄
            this._emitVarStore(lam.name.text, this.scratchB);
            M.drop();
        }
    }
    // 本函数体（含嵌套）所有 lambda 捕获的、属于本函数参数/局部的变量名（去重，稳定序）。
    _probeCaptured(body, paramNames, localNames) {
        const roots = Array.isArray(body) ? body : [body];
        const lams = [];
        for (const r2 of roots) if (r2) for (const l of this._collectLambdas(r2)) if (lams.indexOf(l) < 0) lams.push(l);
        if (!lams.length) return [];
        const own = new Set([...paramNames, ...localNames, "this"]);   // 方法的 this 亦可被箭头闭包捕获
        const out = [], seen = new Set();
        for (const lam of lams) for (const c of this._capturesOf(lam)) if (own.has(c) && !seen.has(c)) { seen.add(c); out.push(c); }
        return out;
    }
    emitFunc(f) {
        // 多文件编译：em.sf 由 compileTS 按「本函数所属源文件」设置（行号/DWARF 用）。
        const savedCurClass = this._curClass, savedCapActive = this.capListActive, savedStatic = this._staticVars;
        const savedFnVars = this._fnVars; this._fnVars = new Set();   // 本函数的「持有闭包的变量」集合
        const savedFnNodes = this._fnNodes; this._fnNodes = new Map(savedFnNodes || []);
        const savedBody = this._curBody; this._curBody = f.body;
        const savedVoid = this._fnVoid;
        this._curClass = undefined; this.capListActive = false;
        if (f.modifiers && f.modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword))
            throw new Error("[tagged] async 函数未实现（需 Promise 运行时）");
        const isVoid = !!f.type && f.type.kind === ts.SyntaxKind.VoidKeyword;
        this._fnVoid = isVoid;
        this._inModInit = f.name !== undefined && f.name.text === "__module_init";
        this.mode = this._inModInit ? "tagged" : funcMode(f);   // 模块初始化：值恒 tagged（模块级名字是 i64 全局）
        // num 值 = f64；tagged 值 = i64（NaN-box，32/64 位统一）
        const vt = this.mode === "num" ? "f64" : "i64";
        const locals = this._collectLocals(f.body);
        for (const p of f.parameters) {                                  // 解构形参的绑定名也要有 local
            if (ts.isIdentifier(p.name)) continue;
            for (const n of this._patternNames(p.name)) if (!locals.includes(n)) locals.push(n);
        }
        this._inStaticMethod = false;
        this._lamThisParam = f.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === "this");   // 顶层函数：`this` 形参是 TS 注解（不占实参槽）
        const nLoc = f.parameters.length + locals.length;
        this.scratch = nLoc;                                 // scratch（后缀 ++/--）
        this.scratchA = nLoc + 1;                            // 暂存 a
        this.scratchB = nLoc + 2;                            // 暂存 b
        // tagged guard 快路径需 f64 浮点临时（值 local 是 i64）；num 模式 scratchA/B 本就是 f64
        const extra = this.mode === "tagged" ? ["f64", "f64"] : [];
        this.scratchFA = nLoc + 3; this.scratchFB = nLoc + 4;
        // 字符串逻辑临时（仅 tagged）：sT0..sT7 共 8 个 i32
        const sT = this.mode === "tagged" ? Array.from({ length: 40 }, () => "i32") : [];
        this.sT = this.mode === "tagged" ? Array.from({ length: 40 }, (_, i) => nLoc + 5 + i) : null;
        // 嵌套对象字面量的句柄临时槽（i64）：每层独立，避免内层覆盖外层句柄。
        const objPool = this.mode === "tagged" ? Array.from({ length: 48 }, () => "i64") : [];
        this.objBase = nLoc + 3 + extra.length + sT.length;
        this._objDepth = 0;
        // 尾部追加：sT(8×i32，tagged) + swIdx(i32) + forOf 对×(vt,i32)（每嵌套层独立）。
        this.swIdx = this.objBase + objPool.length;
        const nForOf = this._countForOf(f.body);
        this.forOfBase = this.swIdx + 1;
        this.forOfCount = 0;
        const forOfLocals = [];
        for (let i = 0; i < nForOf; i++) forOfLocals.push(vt, "i32", "i32");
        // 闭包保留槽（仅 tagged）：cloHandle(i64 存闭包句柄) + cloOff/cloBlk/cloFn(3×i32)。
        const cloSlots = this.mode === "tagged" ? ["i64", "i32", "i32", "i32", "i64", "i64", "i64", "i64"] : [];
        this.cloHandle = nLoc + 3 + extra.length + sT.length + objPool.length + 1 + nForOf * 3;
        this.cloOff = this.cloHandle + 1; this.cloBlk = this.cloHandle + 2; this.cloFn = this.cloHandle + 3;
        this.cloArgs = [this.cloHandle + 4, this.cloHandle + 5, this.cloHandle + 6, this.cloHandle + 7];
        this.scratchObj = this.cloArgs[3] + 1;                 // ++/-- 成员接收者句柄临时（i64）
        this.cloSlotsLen = cloSlots.length;
        // debug：局部名数组（参数在前、局部在后，与 wasm local 序号一致）；仅命名可见变量，合成槽留空。
        const localNames = this.m.debug
            ? f.parameters.map(p => p.name.text).concat(locals)   // locals 是名字数组
            : null;
        // 闭包共享环境：本函数被（直接/嵌套）lambda 捕获的局部/参数 → 统一住宿主对象（env），闭包与本体共享。
        const capNames = this.mode === "tagged"
            ? this._probeCaptured(f.body, f.parameters.map(p => p.name.text), locals) : [];
        const envDecls = capNames.length ? ["i32"] : [];
        const decls = locals.map(() => vt).concat([vt, vt, vt]).concat(extra).concat(sT).concat(objPool)
            .concat(["i32"]).concat(forOfLocals).concat(cloSlots).concat(["i64"]).concat(envDecls);
        this.m.startBody(f.name.text, decls, localNames, this._line(f));
        this.envLocal = capNames.length ? f.parameters.length + decls.length - 1 : undefined;   // 参数在 local 0..n-1 之后
        this.capMap = new Map(capNames.map(n => [n, this.envLocal]));   // 捕获名 → 所在 env 的 i32 local
        this.envRef = this.envLocal;
        if (capNames.length) {
            const M = this.m;
            M.i32Const(-1); M.call("qz.env_new"); M.i32WrapI64(); M.localSet(this.envLocal);   // 根环境（parentIdx=-1）
        }
        // 参数 → local 0..n-1；局部 → n..
        f.parameters.forEach((p, i) => this.varMap.set(p.name.text, i));
        locals.forEach((n, i) => this.varMap.set(n, f.parameters.length + i));
        if (this.mode === "tagged") { this.m.i64Const(0n); this.m.globalSet(1); }   // 入口清 __err（跨函数 throw 标志）
        this._emitParamPrologue(f.parameters, 0);                        // 默认值 / 解构形参（先于写 env）
        if (capNames.length) {
            // 被捕获的参数初值写入 env（局部由声明语句经 _emitVarStore 写入）
            for (const pn of capNames) {                        // 仅形参（含解构形参绑定名）：局部由声明语句写
                const idx = this._local(pn);
                if (idx !== undefined && idx < f.parameters.length) {
                    this.m.localGet(this.envLocal); this.m.i32Const(this._strId(pn)); this.m.localGet(idx); this.m.call("qz.env_set");
                }
            }
        }
        this.depth = 0; this.labels = [];
        this._staticVars = this.mode === "tagged" ? this._computeStaticVars(f.body, f.parameters.map(p => p.name.text)) : new Map();
        if (this.mode === "tagged") { this._emitFnDeclClosures(f.body); this.emitTaggedBlock(f.body); }
        else this.emitBlock(f.body);
        // 末尾非 return 且函数有返回值 → fallthrough 路径缺值（穷尽 switch/if-else 全 return）。
        // 合法代码不会到达；补 unreachable 满足 wasm 验证。
        // tagged：落空函数体 → return undefined（JS 语义；此前补 unreachable，合法代码 function f(){} 直接 trap）。
        const fLast = f.body.statements[f.body.statements.length - 1];
        if (this.mode === "tagged") { this._emitUndefined(); this.m.return_(); }
        else if (!isVoid && !(fLast && ts.isReturnStatement(fLast))) this.m.unreachable();
        this.m.endBody();
        this.m.exportFn(f.name.text, f.name.text);
        this.varMap.clear();
        this._curClass = savedCurClass; this.capListActive = savedCapActive; this._staticVars = savedStatic;
        this._fnVars = savedFnVars; this._fnNodes = savedFnNodes; this._curBody = savedBody; this._fnVoid = savedVoid;
    }


    // ---------- 闭包（lambda 提升 + 捕获 cell）----------
    // 每个箭头/函数表达式提升为一个 wasm 函数 __lam_N。签名 = (blk:i32, 参数…i64) -> i64。
    // 捕获变量存在堆 cell 块（blk 指向 [i64 × captures]，对象布局），读经 capMap、写回 store。
    emitLambda(lam, id) {
        const fname = "__lam_" + id;
        // 带 `this` 形参的用户函数表达式：`this` 走**真实槽位**（local 1，紧接 blk），receiver 由调用方
        // 按 `synthThis` 约定传入（普通调用 = undefined，与 JS 一致）。
        const hasThisParam0 = lam.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === "this");
        const thisSlot = !!lam._qzSynthThis || hasThisParam0;
        const skipThis = !thisSlot;
        const astParams = lam.parameters.filter(p => !(skipThis && ts.isIdentifier(p.name) && p.name.text === "this"));
        const params = astParams.map(p => p.name.text);
        // 捕获名先分析并记录（emitLambdaBody 内 identifier 读写用 capMap 路由）
        const caps = this._capturesOf(lam);
        this._lamById.set(lam, { id, fname, caps, n: params.length, rest: !!(lam._qzRest || (astParams.length && astParams[astParams.length - 1].dotDotDotToken)), synthThis: thisSlot });
        this.m.declareFunc(fname, ["i32"].concat(params.map(() => "i64")), ["i64"]);
        this._pendingLambdas.push({ lam, fname, params, caps, astParams });
        return { fname, caps };
    }

    // 静态检测：lambda 写捕获变量且外层也访问 → 未实现共享环境会静默错值 → 编译期报错（loud）。
    // 外层「访问」= f.body 中非 lambda 内对 cap 名的读/写标识符；lambda「写」= body 内赋值/自增/复合/||=/??= 的左值为 cap。
    _closureWriteConflict(f, lams) {
        if (!lams.length) return null;
        const paramSet = new Set(f.parameters.map(p => p.name.text));
        const locSet = new Set(this._collectLocals(f.body));
        const isOuterVar = (n) => paramSet.has(n) || locSet.has(n);
        const capSet = new Set();
        for (const lam of lams) for (const c of this._capturesOf(lam)) if (isOuterVar(c)) capSet.add(c);
        if (!capSet.size) return null;
        const outerRefs = new Set();
        const walkOuter = (n, inLambda) => {
            if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) { ts.forEachChild(n, (c) => walkOuter(c, true)); return; }
            if (!inLambda && ts.isIdentifier(n)) {
                if (n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) return;
                if (n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name === n) return;
                if (n.parent && ts.isVariableDeclaration(n.parent) && n.parent.name === n) return;   // 声明绑定非「访问」
                if (n.parent && ts.isParameter(n.parent) && n.parent.name === n) return;
                if (capSet.has(n.text)) outerRefs.add(n.text);
                return;
            }
            ts.forEachChild(n, (c) => walkOuter(c, inLambda));
        };
        walkOuter(f.body, false);
        const lamWrites = new Set();
        const WRITE_OPS = [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
            ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
            ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
            ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
            ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken];
        for (const lam of lams) {
            const w = (n) => {
                if (ts.isBinaryExpression(n) && ts.isIdentifier(n.left) && WRITE_OPS.indexOf(n.operatorToken.kind) >= 0
                    && capSet.has(n.left.text)) lamWrites.add(n.left.text);
                if ((ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) && ts.isIdentifier(n.operand)
                    && capSet.has(n.operand.text)) lamWrites.add(n.operand.text);
                ts.forEachChild(n, w);
            };
            w(lam.body);
        }
        for (const name of lamWrites) if (outerRefs.has(name)) return name;
        return null;
    }
    // 发射已登记的 lambda 体（阶段2，在所有顶层函数之后；签名已登记）
    emitLambdaBodies() {
        for (const p of this._pendingLambdas) this._emitLambdaBody(p);
        this._pendingLambdas = [];
    }
    _emitLambdaBody({ lam, fname, params, caps, astParams }) {
        const M = this.m;
        const savedMap = this.varMap, savedCap = this.capMap, savedBlk = this.blkLocal;
        const savedMode = this.mode, savedDepth = this.depth, savedStatic = this._staticVars;
        const savedEnvRef = this.envRef;
        const savedFnVars2 = this._fnVars; this._fnVars = new Set();
        this.mode = "tagged";
        this._fnVoid = false;                                  // lambda 恒返回 i64
        // locals：用户局部（i64）+ scratch 系列同 emitFunc tagged 布局
        this._inStaticMethod = false;
        const thisSlotB = lam.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === "this");
        this._lamThisParam = !(lam._qzSynthThis || thisSlotB) && thisSlotB;   // 用**原始**形参表（astParams 已剔除 this 注解）   // 仅**用户**写的 this 注解形参 → 运行时 this = undefined
        const locals = this._collectLocals(lam.body);
        for (const p of lam.parameters) if (!ts.isIdentifier(p.name)) for (const n of this._patternNames(p.name)) if (!locals.includes(n)) locals.push(n);
        const nParams = 1 + params.length;                 // blk + 参数
        const nLoc = nParams + locals.length;
        this.varMap = new Map();
        (astParams || lam.parameters).forEach((p, i) => { if (ts.isIdentifier(p.name)) this.varMap.set(p.name.text, 1 + i); });   // 已剔除 TS `this` 注解形参
        locals.forEach((n, i) => this.varMap.set(n, nParams + i));
        this.capMap = new Map();
        for (const n of caps) this.capMap.set(n, 0);        // 外层捕获名 → 创建方 env 索引（= blk 参数 local 0）
        this.blkLocal = 0;                                 // local 0 = env 索引（创建方环境）
        this.scratch = nLoc;
        this.scratchA = nLoc + 1;
        this.scratchB = nLoc + 2;
        const extra = ["f64", "f64"];
        this.scratchFA = nLoc + 3; this.scratchFB = nLoc + 4;
        const sT = Array.from({ length: 40 }, () => "i32");
        this.sT = Array.from({ length: 40 }, (_, i) => nLoc + 5 + i);
        const objPool = Array.from({ length: 48 }, () => "i64");
        this.objBase = nLoc + 3 + extra.length + sT.length;
        this._objDepth = 0;
        this.swIdx = this.objBase + objPool.length;
        const nForOf = this._countForOf(lam.body);
        this.forOfBase = this.swIdx + 1;
        this.forOfCount = 0;
        const forOfLocals = [];
        for (let i = 0; i < nForOf; i++) forOfLocals.push("i64", "i32", "i32");
        const cloSlots = ["i64", "i32", "i32", "i32", "i64", "i64", "i64", "i64"];
        this.cloHandle = nLoc + 3 + extra.length + sT.length + objPool.length + 1 + nForOf * 3;
        this.cloOff = this.cloHandle + 1; this.cloBlk = this.cloHandle + 2; this.cloFn = this.cloHandle + 3;
        this.cloArgs = [this.cloHandle + 4, this.cloHandle + 5, this.cloHandle + 6, this.cloHandle + 7];
        this.scratchObj = this.cloArgs[3] + 1;
        this.cloSlotsLen = cloSlots.length;
        // 本 lambda 的局部若被（嵌套）lambda 捕获 → 建自身 env（__parent 链到 blk）
        const ownCap = this._probeCaptured(lam.body, params, locals);
        const envDecls = ownCap.length ? ["i32"] : [];
        const bodyLocals = locals.map(() => "i64").concat(["i64", "i64", "i64"]).concat(extra).concat(sT).concat(objPool)
            .concat(["i32"]).concat(forOfLocals).concat(cloSlots).concat(["i64"]).concat(envDecls);
        const localNames = this.m.debug ? ["blk"].concat(params).concat(locals) : null;
        M.startBody(fname, bodyLocals, localNames);
        this.envLocal = ownCap.length ? (1 + params.length) + bodyLocals.length - 1 : undefined;   // blk+参数之后
        this.envRef = ownCap.length ? this.envLocal : this.blkLocal;   // 嵌套 lambda 的 env：自身 env（链到 blk）或直接 blk
        M.i64Const(0n); M.globalSet(1);                     // 入口清 __err
        this._emitParamPrologue(astParams || lam.parameters, 1);   // 默认值 / 解构形参（先于写 env；已剔除 TS `this` 注解形参）
        if (ownCap.length) {
            M.localGet(0); M.call("qz.env_new"); M.i32WrapI64(); M.localSet(this.envLocal);   // parent = blk(0)
            for (const n of ownCap) this.capMap.set(n, this.envLocal);
            for (const n of ownCap) {                            // 仅形参（解构形参绑定名由序言析构后再写）
                const idx = this._local(n);
                if (idx !== undefined && idx < 1 + params.length) { M.localGet(this.envLocal); M.i32Const(this._strId(n)); M.localGet(idx); M.call("qz.env_set"); }
            }
        }
        this.depth = 0; this.labels = []; this._tryStack = []; this._labelStack = [];
        this._staticVars = this._computeStaticVars(lam.body, params);
        // 箭头表达式体：表达式即返回值；块体：语句
        if (ts.isExpression(lam.body)) { this.emitTaggedExpr(lam.body); M.return_(); }
        else { this._emitFnDeclClosures(lam.body); this.emitTaggedBlock(lam.body); }
        const last = ts.isBlock(lam.body) ? lam.body.statements[lam.body.statements.length - 1] : null;
        this._fnVars = savedFnVars2;
        if (!(last && ts.isReturnStatement(last))) this._emitUndefined();   // 无显式 return → undefined（JS 语义；不是 unreachable）
        M.endBody();
        this.varMap = savedMap; this.capMap = savedCap; this.blkLocal = savedBlk;
        this.envLocal = undefined; this.envRef = savedEnvRef;
        this.mode = savedMode; this.depth = savedDepth; this._staticVars = savedStatic;
    }
    // ---------- 语句 ----------
    // ---------- 类（method lifting）----------
    // 类方法/构造器提升为独立 wasm 函数 __m_<C>$<m>(self:i64, a0..a3:i64) → i64。
    // self = 实例句柄（i64 tagged）；实例字段驻 wasm 内存（与 POJO 同 _fieldIndex 布局），
    // `this` 映射 local 0（self），`this.x` 复用 POJO 字段 load/store（零跨界）。
    // 静态分派：receiver 静态类型已知 → 沿父链直调导出 __m_<C>$<m>；动态 → qz.method_call。
    collectClasses(clsNodes) {   // clsNodes: 已收集的 ClassDeclaration 列表（含嵌套，见 collectDecls）
        const firstNew = this._classList.length;
        for (const st of clsNodes) {
            if (!ts.isClassDeclaration(st)) continue;
            if (!st.name) throw new Error("[tagged] 匿名类不支持");
            const cname = st.name.text;
            const parent = st.heritageClauses && st.heritageClauses.length
                ? st.heritageClauses[0].types[0] : null;
            const parentName = parent ? parent.expression.text : null;
            const fields = [], methods = [], staticMethods = [], staticFields = [], staticBlocks = [], staticInits = [];
            let ctor = null;
            const isStatic = (mem) => !!mem.modifiers && mem.modifiers.some(m => m.kind === ts.SyntaxKind.StaticKeyword);
            for (const mem of st.members) {
                if (ts.isPropertyDeclaration(mem) && ts.isIdentifier(mem.name)) {
                    if (isStatic(mem)) { staticFields.push({ name: mem.name.text, init: mem.initializer || null }); staticInits.push({ kind: "field", name: mem.name.text, init: mem.initializer || null }); }
                    else fields.push({ name: mem.name.text, init: mem.initializer || null });
                } else if (ts.isClassStaticBlockDeclaration(mem)) {
                    staticBlocks.push(mem); staticInits.push({ kind: "block", blk: mem });   // static { … }：首次访问静态时执行（保持源码序）
                } else if (ts.isConstructorDeclaration(mem)) {
                    ctor = mem;
                } else if (ts.isPropertyDeclaration(mem) && ts.isComputedPropertyName(mem.name)) {
                    // ["d"+"yn"] / [KEY+"2"]：常量折叠为静态字段名（无法折叠 → loud，避免静默错名）
                    const nm = this._foldPropName(mem.name.expression);
                    if (nm === null) throw new Error("[tagged] 计算属性类字段名无法编译期求值（需字面量、字面量拼接或模块级字面量 const）");
                    if (isStatic(mem)) { staticFields.push({ name: nm, init: mem.initializer || null }); staticInits.push({ kind: "field", name: nm, init: mem.initializer || null }); }
                    else fields.push({ name: nm, init: mem.initializer || null });
                } else if (ts.isPropertyDeclaration(mem) && ts.isPrivateIdentifier(mem.name)) {
                    if (isStatic(mem)) {   // 私有静态字段：#类名#名（与访问点一致）
                        const pn = "#" + cname + "#" + mem.name.text;
                        staticFields.push({ name: pn, init: mem.initializer || null });
                        staticInits.push({ kind: "field", name: pn, init: mem.initializer || null });
                    } else fields.push({ name: "#" + cname + "#" + mem.name.text, init: mem.initializer || null });   // 私有字段：类名限定
                } else if (ts.isMethodDeclaration(mem) && ts.isPrivateIdentifier(mem.name)) {
                    (isStatic(mem) ? staticMethods : methods).push({ name: "#" + cname + "#" + mem.name.text, node: mem });   // 私有方法/私有静态方法
                } else if (ts.isMethodDeclaration(mem) && ts.isIdentifier(mem.name)) {
                    (isStatic(mem) ? staticMethods : methods).push({ name: mem.name.text, node: mem });
                } else if (ts.isMethodDeclaration(mem) && ts.isComputedPropertyName(mem.name)) {
                    // [Symbol.iterator] / [Symbol.toPrimitive] …：编译为 @@<symbol 名> 方法；物化时挂到真 Symbol 上
                    const sx = symbolNameOf(mem.name.expression);
                    if (!sx) throw new Error("[tagged] 类计算属性名方法仅支持 Symbol.<well-known>（如 [Symbol.iterator]）");
                    (isStatic(mem) ? staticMethods : methods).push({ name: "@@" + sx, node: mem });
                } else if ((ts.isGetAccessorDeclaration(mem) || ts.isSetAccessorDeclaration(mem)) && ts.isIdentifier(mem.name)) {
                    if (isStatic(mem)) { staticMethods.push({ name: mem.name.text, node: mem, accessor: ts.isSetAccessorDeclaration(mem) ? "set" : "get" }); }
                    else
                    methods.push({ name: mem.name.text, node: mem, accessor: ts.isSetAccessorDeclaration(mem) ? "set" : "get" });
                } else {
                    throw new Error("[tagged] 不支持的类成员: " + ts.SyntaxKind[mem.kind]);
                }
            }
            if (ctor) {   // TS 参数属性 constructor(public x: any) → 隐式字段「this.x = x」（初值 = 形参局部读）
                const props = [];
                for (const p of ctor.parameters) {
                    if (!ts.isIdentifier(p.name)) continue;
                    const isProp = (p.modifiers || []).some(mm => mm.kind === ts.SyntaxKind.PublicKeyword || mm.kind === ts.SyntaxKind.PrivateKeyword
                        || mm.kind === ts.SyntaxKind.ProtectedKeyword || mm.kind === ts.SyntaxKind.ReadonlyKeyword);
                    if (!isProp) continue;
                    const pnm = ts.isPrivateIdentifier(p.name) ? "#" + cname + "#" + p.name.text : p.name.text;
                    if (fields.some(f2 => f2.name === pnm)) continue;
                    props.push({ name: pnm, init: p.name });
                }
                fields.unshift.apply(fields, props);             // TS：参数属性先于字段初值赋值
            }
            {   // 静态方法/getter/setter 体内是否出现 `this`（≡ 类）：派生类经类名调用时 `this` 应为**派生类**对象，
                // 本实现按定义类解析 → 静默偏差；此处标记以便调用点 loud。
                const usesThis = (node) => {
                    let hit = false;
                    const walk = (n2) => {
                        if (hit) return;
                        if (ts.isThis(n2)) { hit = true; return; }
                        if (n2 !== node && (ts.isFunctionDeclaration(n2) || ts.isFunctionExpression(n2) || ts.isArrowFunction(n2))) return;   // 内层函数的 this 另算
                        ts.forEachChild(n2, walk);
                    };
                    if (node) walk(node);
                    return hit;
                };
                const thisNames = (node) => {
                    const names = new Set();
                    const walk = (n2) => {
                        if (ts.isPropertyAccessExpression(n2) && ts.isThis(n2.expression)) {
                            if (ts.isIdentifier(n2.name)) names.add(n2.name.text);   // 私有名不参与（私有静态不继承）
                        } else if (ts.isElementAccessExpression(n2) && ts.isThis(n2.expression)
                            && (ts.isStringLiteral(n2.argumentExpression) || ts.isNumericLiteral(n2.argumentExpression))) {
                            names.add(n2.argumentExpression.text);
                        }
                        if (n2 !== node && (ts.isFunctionDeclaration(n2) || ts.isFunctionExpression(n2) || ts.isArrowFunction(n2))) return;
                        ts.forEachChild(n2, walk);
                    };
                    if (node) walk(node);
                    for (let x = this.classes.get(cname) && this.classes.get(cname).parent; x; x = this.classes.get(x) && this.classes.get(x).parent) {
                        const cl2 = this.classes.get(x);   // 基类链上的静态名 → 若派生类覆写才可能偏差（扫描时统一记入，调用点再判）
                        if (!cl2) break;
                    }
                    return names;
                };
                for (const sm of staticMethods) { sm.usesThis = usesThis(sm.node && sm.node.body); sm.thisNames = thisNames(sm.node && sm.node.body); }
            }
            const capSetC = new Set();                      // 类方法外围自由变量（**单一来源**，两处共用）
            for (const mth of methods.concat(staticMethods)) {
                if (!mth || !mth.node || !mth.node.body) continue;
                const nestedParams = new Set();             // 嵌套函数（含箭头）的形参：不是外层自由变量（_collectLocals 不下探）
                { const walkN = (n2) => {
                    if (ts.isArrowFunction(n2) || ts.isFunctionExpression(n2) || ts.isFunctionDeclaration(n2)
                        || ts.isMethodDeclaration(n2) || ts.isGetAccessorDeclaration(n2) || ts.isSetAccessorDeclaration(n2))
                      for (const p2 of n2.parameters) for (const np2 of this._patternNames(p2.name)) nestedParams.add(np2);
                    ts.forEachChild(n2, walkN); };
                  if (mth.node.body) for (const st2 of (mth.node.body.statements || [])) walkN(st2); }
                for (const nm2 of this._capturesOf(mth.node)) {
                    if (nestedParams.has(nm2)) continue;
                    if (BUILTIN_GLOBALS.has(nm2)) continue;
                    if (/^(undefined|null|NaN|Infinity)$/.test(nm2)) continue;
                    if (this.classes.has(this._className(nm2))) continue;
                    if (this.fnNames && this.fnNames.has(nm2)) continue;
                    capSetC.add(nm2);
                }
            }
            this.classes.set(cname, { id: this._classList.length, name: cname, parent: parentName, captured: [...capSetC], dynParentNode: parent ? parent.expression : null, fields, methods, staticMethods, staticFields, staticBlocks, staticInits, ctor });
            this._classList.push(cname);
        }
        // 预登记所有类字段到 fieldMap（发射阶段任意时刻 _instSize 都要覆盖全部类字段）；
        // POJO 字面量字段在其自身发射时登记，可能后于类字段 → 仅使实例 size 偏大，无害。
        for (const cname of this._classList) {
            const c = this.classes.get(cname);
            for (const f of c.fields) this._fieldIndex(f.name);
        }
        // 叶类 = 无子类的类。其方法/构造器内 `this` 静态类精确（new C 永不产 C 之外的实例）。
        this._leafClasses = new Set(this._classList);
        for (const cname of this._classList) {
            const c = this.classes.get(cname);
            if (c.parent && this.classes.has(c.parent)) this._leafClasses.delete(c.parent);
        }
        // 仅为本文件新增类登记签名——collectClasses 每文件调用一次；若遍历整个 _classList
        // 会重复 declareFunc 早前文件的类（codes 占位未填 → 编码时崩）。
        for (let i = firstNew; i < this._classList.length; i++) {
            const cname = this._classList[i];
            const c = this.classes.get(cname);
            for (const mth of c.methods) {
                const voidRet = !!mth.node.type && mth.node.type.kind === ts.SyntaxKind.VoidKeyword;
                this.m.declareFunc(methName(cname, mth.accessor === "set" ? mth.name + "$set" : mth.name),
                                   ["i64", "i64", "i64", "i64", "i64"].concat(mth.node.parameters.length > 4 ? ["i64"] : []),   // >4 形参 → 第 6 槽 = 实参 4.. 数组
                                   mth.accessor === "set" || voidRet ? [] : ["i64"]);
            }
            this.m.declareFunc(ctorName(cname), ["i64", "i64", "i64", "i64", "i64"], []);
            for (const sm of c.staticMethods) {
                const voidRet = !!sm.node.type && sm.node.type.kind === ts.SyntaxKind.VoidKeyword;
                this.m.declareFunc(staticMethName(cname, sm.name + (sm.accessor === "set" ? "$set" : "")),
                                   ["i64", "i64", "i64", "i64", "i64"].concat(sm.node.parameters.length > 4 ? ["i64"] : []),   // >4 形参 → 第 6 槽 voidRet ? [] : ["i64"]);
                                   voidRet ? [] : ["i64"]);
            }
        }
    }
    emitClassBodies() {
        for (const cname of this._classList) {
            const c = this.classes.get(cname);
            if (!c.ctor && c.fields.some(f => !f.init)) throw new Error(`[tagged] 类 ${cname} 字段需初值或显式 constructor`);
            this._emitCtorBody(c, c.ctor);
            for (const mth of c.methods) this._emitMethodBody(cname, mth);
            for (const sm of c.staticMethods) this._emitStaticMethodBody(cname, sm);
        }
    }
    // 静态方法 __sm_<C>$<m>(self占位:i64, a0..a3:i64)：无 this（local0 占位 undefined）。
    _emitStaticMethodBody(cname, sm) {
        const M = this.m;
        const isVoid = !!sm.node.type && sm.node.type.kind === ts.SyntaxKind.VoidKeyword;
        const realParams = sm.node.parameters.map(p => p.name.text);
        const params = realParams.slice(0, 4).concat(["$p1", "$p2", "$p3", "$p4"].slice(0, Math.max(0, 4 - realParams.length)))
            .concat(realParams.length > 4 ? ["$ovf"] : []);
        this._mEnter(staticMethName(cname, sm.name + (sm.accessor === "set" ? "$set" : "")), cname, params, sm.node.body, isVoid, sm.node.parameters);
        this._inStaticMethod = true;                       // 静态方法体内 this ≡ 类（_classOfExpr）
        this._emitParamPrologue(sm.node.parameters, 1);    // 静态方法形参同上
        this._emitOvfParamUnpack(sm.node.parameters, params);
        this._curClassObj = this.classes.get(cname);
        this._emitFnDeclClosures(sm.node.body);
        this.emitTaggedBlock(sm.node.body);
        { const stmts = sm.node.body.statements; const last = stmts[stmts.length - 1];   // tagged：落空 → undefined
          if (!(last && ts.isReturnStatement(last))) { this._emitUndefined(); M.return_(); } }
        M.endBody();
        this._mExit();
    }
    // 构造器 __m_<C>$ctor(self:i64, a0..a3:i64) → 无返回：self 由调用方 _emitNewCall 内联 bump 分配后传入
    // 方法/静态方法 >4 形参：从第 6 槽（$ovf 数组）解包实参 4.. 到各自 local（含默认值/解构/rest 语义）。
    _emitOvfParamUnpack(astParams, params) {
        if (!astParams || astParams.length <= 4) return;
        const M = this.m;
        const ovfLocal = 1 + params.length - 1;                  // $ovf 槽（最后一个 wasm 形参）
        for (let i = 4; i < astParams.length; i++) {
            const p = astParams[i];
            const dst = 1 + params.length + (i - 4);             // 与 _mEnter 的 varMap 一致（params.length 含 $ovf）
            this._emitElemOf(ovfLocal, ts.factory.createNumericLiteral(i - 3)); M.localSet(dst);   // ovf[0] = 实参 3（已在 a3）
            if (p.dotDotDotToken) {                              // rest：调用方已打包为数组（未传 → 空数组）
                M.localGet(dst); M.call("qz.is_undef");
                M.ifBlock("void"); M.call("qz.empty_array"); M.localSet(dst); M.end();
            }
            if (p.initializer) {
                M.localGet(dst); M.call("qz.is_undef");
                M.ifBlock("void"); this.emitTaggedExpr(p.initializer); M.localSet(dst); M.end();
            }
            if (!ts.isIdentifier(p.name)) {
                const t = this._expEnter();
                M.localGet(dst); M.localSet(t.v);
                this._emitDestructurePattern(p.name, t.v);
                this._expLeave();
            }
        }
    }
    _emitCtorBody(c, ctor) {
        const M = this.m;
        const realParams = ctor ? ctor.parameters.map(p => p.name.text) : [];
        const params = realParams.concat(["$p1", "$p2", "$p3", "$p4"].slice(0, Math.max(0, 4 - realParams.length)));
        const body = ctor ? ctor.body : { statements: [] };
        this._mEnter(ctorName(c.name), c.name, params, body, true, ctor ? ctor.parameters : [],
            c.fields.filter(f2 => f2.init).map(f2 => f2.init));   // 字段初值在 ctor 内联发射 → 其闭包（如 = () => this.x）须捕获 this
        this._inStaticMethod = false;
        this._curClassObj = c;
        // 派生类：字段默认值须在 super(...) 之后写（同名遮蔽字段父写后子覆写）；
        // super 语句处 _emitSuperCall 负责调用父 ctor 后回写本类默认值。基类：此处直接写。
        if (!c.parent) this._emitFieldDefaults(c);
        if (ctor) { this._emitFnDeclClosures(ctor.body); this.emitTaggedBlock(ctor.body); }
        else if (c.parent || this._dynParentExpr(c)) this._emitSuperCallForward(c);   // 合成 ctor：constructor(...a){ super(...a) }（动态父同样须转发，否则父类字段默认值不执行）
        this._curClassObj = null;
        M.endBody();
        this._mExit();
    }
    // 写本类字段默认初值（now: 当前 self=local0 在栈/无；用局部 self 直接存）。
    // 若 ctor 首句为 `super(...)`，则字段默认值改在 super 调用点写（子类字段不得覆写父类构造设置的字段）。
    _emitFieldDefaults(c) {
        const M = this.m;
        if (this.usesKeyOrder && c.fields.length) {   // 实例字段插入序 = 类字段声明序（派生类在 super 之后登记）
            M.localGet(0); M.i32Const(this._strId(c.fields.map(f2 => f2.name).join("\u0000"))); M.call("qz.field_order_lit");
        }
        for (const f of c.fields) {
            M.localGet(0); M.i32WrapI64();
            if (f.init) this.emitTaggedExpr(f.init);
            else this._emitUndefined();
            M.i64Store(3, this._fieldIndex(f.name));
        }
    }
    _emitMethodBody(cname, mth) {
        const M = this.m;
        const isVoid = !!mth.node.type && mth.node.type.kind === ts.SyntaxKind.VoidKeyword;
        const realParams = mth.node.parameters.map(p => p.name.text);
        const params = realParams.slice(0, 4).concat(["$p1", "$p2", "$p3", "$p4"].slice(0, Math.max(0, 4 - realParams.length)))
            .concat(realParams.length > 4 ? ["$ovf"] : []);            // 前 4 槽 + 可选 $ovf（实参 4.. 数组）
        this._mEnter(methName(cname, mth.accessor === "set" ? mth.name + "$set" : mth.name), cname, params, mth.node.body, isVoid, mth.node.parameters);
        this._inStaticMethod = false;
        this._emitParamPrologue(mth.node.parameters, 1);   // 方法形参：默认值/解构
        this._emitOvfParamUnpack(mth.node.parameters, params);   // >4 形参：从 $ovf 数组解包到各自 local
        this._emitFnDeclClosures(mth.node.body);
        this.emitTaggedBlock(mth.node.body);
        { const stmts = mth.node.body.statements; const last = stmts[stmts.length - 1];   // tagged：落空 → undefined
          if (!(last && ts.isReturnStatement(last))) { this._emitUndefined(); M.return_(); } }
        M.endBody();
        this._mExit();
    }
    // 方法/构造器发射作用域：this=local0，参数 1..，完整 scratch/sT/obj/forOf/clo 槽布局。
    // 与 emitFunc(tagged) 同构；额外 _curClass 供静态方法分派解析继承链。
    _mEnter(fname, cname, params, body, isVoid, astParams, extraNodes) {
        this._mSaved = {
            mode: this.mode, varMap: this.varMap, capMap: this.capMap, capList: this.capList, capListActive: this.capListActive,
            blkLocal: this.blkLocal, depth: this.depth, labels: this.labels, labelStack: this._labelStack, curClass: this._curClass, curClassObj: this._curClassObj, staticVars: this._staticVars, envLocal: this.envLocal, envRef: this.envRef, fnVars: this._fnVars,
        };
        this.mode = "tagged";
        this._fnVoid = !!isVoid;
        const nParams = 1 + params.length;
        const locals = this._collectLocals(body);
        for (const p of (astParams || [])) if (!ts.isIdentifier(p.name)) for (const n of this._patternNames(p.name)) if (!locals.includes(n)) locals.push(n);
        for (let i2 = 4; i2 < (astParams ? astParams.length : 0); i2++) locals.unshift("$ovfArg" + (i2 - 4));   // 实参 4.. 的 local（由 _emitOvfParamUnpack 写入）
        const nLoc = nParams + locals.length;
        this._lamThisParam = false;                       // 类方法/构造器：this 走 local 0（不受上一个 lambda 标记影响）
        this.varMap = new Map();
        this.varMap.set("this", 0);
        // 实参 0..3 → local 1..4；实参 4.. → local 1+params.length+(i-4)（= $ovf 槽之后的预留槽）
        if (astParams) astParams.forEach((p, i) => { if (ts.isIdentifier(p.name)) this.varMap.set(p.name.text, i < 4 ? 1 + i : 1 + params.length + (i - 4)); });
        else params.forEach((p, i) => this.varMap.set(p, 1 + i));
        locals.forEach((n, i) => this.varMap.set(n, nParams + i));
        this.capMap = new Map(); this.blkLocal = null;
        this.scratch = nLoc; this.scratchA = nLoc + 1; this.scratchB = nLoc + 2;
        const extra = ["f64", "f64"];
        this.scratchFA = nLoc + 3; this.scratchFB = nLoc + 4;
        const sT = Array.from({ length: 40 }, () => "i32");
        this.sT = Array.from({ length: 40 }, (_, i) => nLoc + 5 + i);
        const objPool = Array.from({ length: 48 }, () => "i64");
        this.objBase = nLoc + 3 + extra.length + sT.length;
        this._objDepth = 0;
        this.swIdx = this.objBase + objPool.length;
        const nForOf = this._countForOf(body);
        this.forOfBase = this.swIdx + 1;
        this.forOfCount = 0;
        const forOfLocals = [];
        for (let i = 0; i < nForOf; i++) forOfLocals.push("i64", "i32", "i32");
        const cloSlots = ["i64", "i32", "i32", "i32", "i64", "i64", "i64", "i64"];
        this.cloHandle = nLoc + 3 + extra.length + sT.length + objPool.length + 1 + nForOf * 3;
        this.cloOff = this.cloHandle + 1; this.cloBlk = this.cloHandle + 2; this.cloFn = this.cloHandle + 3;
        this.cloArgs = [this.cloHandle + 4, this.cloHandle + 5, this.cloHandle + 6, this.cloHandle + 7];
        this.scratchObj = this.cloArgs[3] + 1;
        this.cloSlotsLen = cloSlots.length;
        // 方法体内被（嵌套）lambda 捕获的 this/参数/局部 → 共享环境（同 emitFunc）
        const capNames = this._probeCaptured(extraNodes ? [body].concat(extraNodes) : body, params, locals);
        const probeLenC = capNames.length;
        { const ciC = this.classes.get(cname);
          if (probeLenC === 0 && ciC && ciC.captured) for (const n0 of ciC.captured) if (!capNames.includes(n0)) capNames.push(n0); }
        const envDecls = capNames.length ? ["i32"] : [];
        const bodyLocals = locals.map(() => "i64").concat(["i64", "i64", "i64"]).concat(extra)
            .concat(sT).concat(objPool).concat(["i32"]).concat(forOfLocals).concat(cloSlots).concat(["i64"]).concat(envDecls);
        const localNames = this.m.debug ? ["this"].concat(params).concat(locals) : null;
        this.m.startBody(fname, bodyLocals, localNames);
        this.m.i64Const(0n); this.m.globalSet(1);           // 入口清 __err
        this._emitParamPrologue(astParams || [], 1);        // 默认值 / 解构形参（先于写 env）
        this.envLocal = capNames.length ? (1 + params.length) + bodyLocals.length - 1 : undefined;
        this.capMap = new Map(capNames.map(n => [n, this.envLocal]));
        this.envRef = this.envLocal;
        if (capNames.length) {
            const M = this.m;
            { const ciE = this.classes.get(cname);
              if (probeLenC === 0 && ciE && ciE.captured && ciE.captured.length) {   // 纯类捕获 → envLocal 直接指向类 env（statics @@qzEnv）
                M.i32Const(this._strId(ciE.name)); M.i32Const(this._strId("@@qzEnv")); M.call("qz.static_get"); M.i32WrapI64(); M.localSet(this.envLocal);
              } else { M.i32Const(-1); M.call("qz.env_new"); M.i32WrapI64(); M.localSet(this.envLocal); } }
            for (const n of capNames) {
                if (n === "this") { M.localGet(this.envLocal); M.i32Const(this._strId("this")); M.localGet(0); M.call("qz.env_set"); }
                else { const li = this._local(n); if (li !== undefined && li < 1 + params.length) { M.localGet(this.envLocal); M.i32Const(this._strId(n)); M.localGet(li); M.call("qz.env_set"); } }
            }
        }
        this.depth = 0; this.labels = []; this._tryStack = []; this._labelStack = [];
        this._curClass = cname;
        this._curClassObj = this.classes.get(cname) || null;   // super.m()/静态分派需类元数据（继承链编译期已知）
        this._staticVars = this._computeStaticVars(body, params);
    }
    _mExit() {
        const s = this._mSaved;
        this.mode = s.mode; this.varMap = s.varMap; this.capMap = s.capMap; this.capList = s.capList; this.capListActive = s.capListActive;
        this.blkLocal = s.blkLocal; this.depth = s.depth; this.labels = s.labels;
        this._labelStack = s.labelStack; this._curClass = s.curClass; this._curClassObj = s.curClassObj;
        this._staticVars = s.staticVars; this.envLocal = s.envLocal; this.envRef = s.envRef;
        this._fnVars = new Set();   // 方法体自身作用域（内层 lambda 各自再包一层）
    }
    emitBlock(node) { for (const s of node.statements) this.emitStmt(s); }

    emitStmt(s) {
        this.m.markLine(this._line(s));
        if (ts.isVariableStatement(s)) {
            for (const d of s.declarationList.declarations) {
                if (d.initializer) { this.emitExpr(d.initializer); this.m.localSet(this._local(d.name.text)); }
            }
            return;
        }
        if (ts.isReturnStatement(s)) {
            if (s.expression) this.emitExpr(s.expression);
            this.m.return_();
            return;
        }
        if (ts.isIfStatement(s)) {
            this.emitExpr(s.expression !== undefined ? s.expression : s.condition); this.emitCond();
            this.m.ifBlock();          // 语句 if 无返回值
            this.depth++;
            this.emitStmt(s.thenStatement);
            if (s.elseStatement) { this.m.else_(); this.emitStmt(s.elseStatement); }
            this.depth--;
            this.m.end();
            return;
        }
        if (ts.isBreakStatement(s)) { this._jumpOut(s.label && s.label.text, true); return; }
        if (ts.isDoStatement(s)) { this.emitDoWhile(s, false); return; }
        if (ts.isContinueStatement(s)) { this._jumpOut(s.label && s.label.text, false); return; }
        if (ts.isWhileStatement(s)) { this.emitWhile(s); return; }
        if (ts.isForStatement(s)) { this.emitFor(s); return; }
        if (ts.isSwitchStatement(s)) { this.emitSwitch(s, false); return; }
        if (ts.isLabeledStatement(s)) { if (ts.isIterationStatement(s.statement, false)) this._labelStack.push(s.label.text); this.emitStmt(s.statement); return; }
        if (ts.isBlock(s)) { this.emitBlock(s); return; }
        if (ts.isExpressionStatement(s)) { this.emitExpr(s.expression); this.m.drop(); return; }
        if (ts.isEmptyStatement(s)) return;
        if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isModuleDeclaration(s)
            || s.kind === ts.SyntaxKind.ImportDeclaration) return;      // TS 类型层/导入：擦除（无运行期语义）
        throw new Error("不支持的语句: " + ts.SyntaxKind[s.kind]);
    }

    // break → 最近可 break 的 label（循环或 switch；带 label 名则精确匹配）；continue → 最近的循环 label。
    // break/continue 跨 try-finally：被退出循环内层的 finally 必须先执行（JS 语义）。
    _jumpOut(label, isBreak) {
        const st = this._finallyStack;
        if (st && st.length && this.labels.length) {
            let idx = -1;
            for (let i = this.labels.length - 1; i >= 0; i--) {
                const ok2 = label ? (this.labels[i].label === label && (isBreak ? this.labels[i].brk != null : this.labels[i].cont != null))
                                  : (isBreak ? this.labels[i].brk != null : this.labels[i].cont != null);
                if (ok2) { idx = i; break; }
            }
            for (let i = st.length - 1; i >= 0; i--) {
                if (st[i].labelsLen <= idx) break;                           // 该 finally 在目标循环之外
                const keep = this._finallyStack;
                this._finallyStack = st.slice(0, i);
                this.emitTaggedBlock(st[i].node);
                this._finallyStack = keep;
            }
        }
        this.m.br(isBreak ? this._breakRel(label) : this._contRel(label));
    }
    _breakRel(label) {
        for (let i = this.labels.length - 1; i >= 0; i--)
            if (label ? (this.labels[i].label === label && this.labels[i].brk != null) : this.labels[i].brk != null)
                return this.depth - this.labels[i].brk;
        throw new Error("break 不在循环/switch 内");
    }
    _contRel(label) {
        for (let i = this.labels.length - 1; i >= 0; i--)
            if (label ? (this.labels[i].label === label && this.labels[i].cont != null) : this.labels[i].cont != null)
                return this.depth - this.labels[i].cont;
        throw new Error("continue 不在循环内");
    }

    emitWhile(s) {
        this.m.block(); this.depth++;
        this.m.loop(); this.depth++;
        this.labels.push({ brk: this.depth - 1, cont: this.depth, label: this._curLabel() });
        this.emitExpr(s.expression !== undefined ? s.expression : s.condition);
        this.emitCond();
        this.m.i32Eqz();
        this.m.brIf(1);                     // 退出外层 block（条件为假）
        this.emitStmt(s.statement);
        this.m.br(0);                        // 继续 loop
        this.labels.pop();
        this.depth--; this.m.end();           // loop end
        this.depth--; this.m.end();           // block end
    }

    emitFor(s) {
        if (s.initializer) {
            if (ts.isVariableDeclarationList(s.initializer)) { for (const d of s.initializer.declarations) { if (d.initializer) { this.emitExpr(d.initializer); this.m.localSet(this._local(d.name.text)); } } }
            else { this.emitExpr(s.initializer); this.m.drop(); }
        }
        // 结构：block(brk) loop block(cont) body end; incrementor; br 0 end end
        // continue 跳到 incrementor 前（cont block 末尾），否则会跳过 incrementor → 死循环。
        this.m.block(); this.depth++;
        this.m.loop(); this.depth++;
        if (s.condition) { this.emitExpr(s.condition); this.emitCond(); this.m.i32Eqz(); this.m.brIf(1); }
        this.m.block(); this.depth++;
        this.labels.push({ brk: this.depth - 2, cont: this.depth, label: this._curLabel() });
        if (s.statement) this.emitStmt(s.statement);
        this.labels.pop();
        this.depth--; this.m.end();                       // end cont block
        if (s.incrementor) { this.emitExpr(s.incrementor); this.m.drop(); }
        this.m.br(0);
        this.depth--; this.m.end();                       // end loop
        this.depth--; this.m.end();                       // end brk block
    }

    // do { body } while (cond)：continue 跳条件判断（不跳 body 顶）。
    // 结构：block(brk) loop block(cont) body end; cond ? br 0 : 落 end end
    emitDoWhile(s, tagged) {
        const M = this.m;
        M.block(); this.depth++;
        M.loop(); this.depth++;
        M.block(); this.depth++;
        this.labels.push({ brk: this.depth - 2, cont: this.depth, label: this._curLabel() });
        if (tagged) this.emitTaggedStmt(s.statement); else this.emitStmt(s.statement);
        this.labels.pop();
        this.depth--; M.end();                             // end cont block
        if (tagged) this.emitCondI32(s.expression !== undefined ? s.expression : s.condition);
        else { this.emitExpr(s.expression !== undefined ? s.expression : s.condition); this.emitCond(); }
        M.brIf(0);                                         // 条件真 → 回 loop 顶
        this.depth--; M.end();                             // end loop
        this.depth--; M.end();                             // end brk block
    }

    // ---------- 表达式（number 域） ----------
    emitExpr(e) {
        if (ts.isNumericLiteral(e)) { this.m.f64Const(Number(e.text)); return; }
        if (ts.isIdentifier(e)) {
            const idx = this._local(e.text);
            if (idx === undefined) throw new Error("未定义变量: " + e.text);
            this.m.localGet(idx); return;
        }
        if (ts.isParenthesizedExpression(e)) { this.emitExpr(e.expression); return; }
        // 纯类型层构造（运行时恒等，TS 会在 emit 前擦除）→ 直接透传表达式：
        // `as T` / `x!` / `e satisfies T` / 尖括号断言 `<T>e`（≡ as）。
        if (ts.isAsExpression(e) || ts.isNonNullExpression(e)
            || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) { this.emitExpr(e.expression); return; }
        if (ts.isPrefixUnaryExpression(e)) {
            // ++/-- 需先判是否自增自减
            if (ts.isIdentifier(e.operand) && (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken)) {
                const idx = this._local(e.operand.text);
                if (idx === undefined) throw new Error("未定义变量: " + e.operand.text);
                const dec = e.operator === ts.SyntaxKind.MinusMinusToken;
                this.m.localGet(idx); this.m.f64Const(1); dec ? this.m.f64Sub() : this.m.f64Add(); this.m.localTee(idx);
                return;
            }
            this.emitExpr(e.operand);
            if (e.operator === ts.SyntaxKind.MinusToken) { this.m.f64Neg(); }
            else if (e.operator === ts.SyntaxKind.PlusToken) { /* noop: +number 恒等 */ }
            else if (e.operator === ts.SyntaxKind.ExclamationToken) { this.emitCond(); this.m.i32Eqz(); this.m.f64ConvertI32S(); }   // !x = !ToBoolean(x)：NaN/0/-0 为假（emitCond 已排除 NaN）
            else if (e.operator === ts.SyntaxKind.TildeToken) { this.m.i32TruncF64S(); this.m.i32Const(-1); this.m.i32Xor(); this.m.f64ConvertI32S(); }   // ~x = ~ToInt32(x)，32 位语义
            else throw new Error("不支持的一元运算符: " + ts.SyntaxKind[e.operator]);
            return;
        }
        if (ts.isPostfixUnaryExpression(e)) {
            const idx = this._local(e.operand.text);
            if (idx === undefined) throw new Error("未定义变量: " + e.operand.text);
            const dec = e.operator === ts.SyntaxKind.MinusMinusToken;
            // x++：栈留旧值（localTee scratch），x 更新
            this.m.localGet(idx); this.m.localTee(this.scratch);
            this.m.localGet(idx); this.m.f64Const(1); dec ? this.m.f64Sub() : this.m.f64Add(); this.m.localSet(idx);
            return;
        }
        if (ts.isBinaryExpression(e)) { this.emitBinary(e); return; }
        if (ts.isConditionalExpression(e)) {
            this.emitExpr(e.condition); this.emitCond();
            this.m.ifBlock("f64"); this.depth++;
            this.emitExpr(e.whenTrue);
            this.m.else_(); this.emitExpr(e.whenFalse);
            this.m.end(); this.depth--;
            return;
        }
        if (ts.isCallExpression(e)) {
            let fn;
            if (ts.isIdentifier(e.expression)) fn = e.expression.text;
            else if (ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)) {
                const resolved = this._nsMember(e.expression.expression.text, e.expression.name.text);
                if (resolved === undefined) throw new Error("不支持的调用目标");
                fn = resolved;
            } else throw new Error("不支持的调用目标");
            if (fn === "Math_floor") { this.emitExpr(e.arguments[0]); this.m.f64Floor(); return; }
            const ciNum = this._calleeInfo(fn);
            const xNum = ciNum && ciNum.mode !== this.mode;
            for (const a of e.arguments) { this.emitExpr(a); if (xNum) this._argToCallee(fn); }
            this.m.call(this._fnName(fn));
            this._retFromCallee(fn);
            return;
        }
        throw new Error("不支持的表达式: " + ts.SyntaxKind[e.kind]);
    }

    emitBinary(e) {
        const op = e.operatorToken.kind;
        // 赋值：x = rhs → localTee（保留值供表达式上下文）；x op= rhs → 读-算-写
        const assignOps = { [ts.SyntaxKind.EqualsToken]: null, [ts.SyntaxKind.AsteriskAsteriskEqualsToken]: ts.SyntaxKind.AsteriskAsteriskToken, [ts.SyntaxKind.PlusEqualsToken]: ts.SyntaxKind.PlusToken, [ts.SyntaxKind.MinusEqualsToken]: ts.SyntaxKind.MinusToken, [ts.SyntaxKind.AsteriskEqualsToken]: ts.SyntaxKind.AsteriskToken, [ts.SyntaxKind.SlashEqualsToken]: ts.SyntaxKind.SlashToken, [ts.SyntaxKind.PercentEqualsToken]: ts.SyntaxKind.PercentToken, [ts.SyntaxKind.LessThanLessThanEqualsToken]: ts.SyntaxKind.LessThanLessThanToken, [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanToken, [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, [ts.SyntaxKind.AmpersandEqualsToken]: ts.SyntaxKind.AmpersandToken, [ts.SyntaxKind.BarEqualsToken]: ts.SyntaxKind.BarToken, [ts.SyntaxKind.CaretEqualsToken]: ts.SyntaxKind.CaretToken };
        if (Object.prototype.hasOwnProperty.call(assignOps, op)) {
            if (!ts.isIdentifier(e.left)) throw new Error("赋值左值必须是标识符");
            const idx = this._local(e.left.text);
            if (idx === undefined) throw new Error("未定义变量: " + e.left.text);
            const binop = assignOps[op];
            if (binop !== null) {
                this.m.localGet(idx);
                this.emitExpr(e.right);
                this.emitBinaryOp(binop);
            } else {
                this.emitExpr(e.right);
            }
            this.m.localTee(idx);
            return;
        }
        // ?? / ??=：num 模式值恒为 f64（永非 null/undefined）→ a ?? b = a、a ??= b 不变。
        // 右操作数不求值（JS：a 非空则 b 不求值）——短路语义精确。
        if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
            this.emitExpr(e.left);
            return;
        }
        // / truthy(a) ? b : a（&&）。左侧仅求值一次（左值恒为标识符，cache local 即可）。
        if (op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
            if (!ts.isIdentifier(e.left)) throw new Error("赋值左值必须是标识符");
            const idx = this._local(e.left.text);
            if (idx === undefined) throw new Error("未定义变量: " + e.left.text);
            const isAnd = op === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
            this.m.block("f64");                              // block(result f64)
            this.m.localGet(idx);                             // [a]
            this.m.localTee(this.scratch);                    // scratch=a；栈 [a]（短路时作块结果）
            this.m.localGet(this.scratch); this.emitCond();   // [a, truthy(a)]
            if (isAnd) this.m.i32Eqz();                       // && : falsy(a) → 跳出（返回 a）
            this.m.brIf(0);                                   // 条件真（|| 的 a 真 / && 的 a 假）→ 返回 a
            this.m.drop();                                    // 落下路径丢弃 a
            this.emitBinaryOperandValue(e.right);             // 仅此路径求值 b
            this.m.localSet(idx);                             // 副作用：a = b
            this.m.localGet(idx);                             // 块结果 = b
            this.m.end(); this.m.localTee(idx);               // 写回 a，栈留结果值
            return;
        }

        // 短路逻辑（**真短路 + 值语义**，JS 精确）：
        //  a && b ≡ truthy(a) ? b : a   a || b ≡ truthy(a) ? a : b
        // 关键：b 只在短路决策需要时才求值（副作用语义）；结果保留操作数原值而非 0/1。
        if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
            const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
            this.m.block("f64");                              // block(result f64)
            this.emitBinaryOperandValue(e.left);              // [a]
            this.m.localTee(this.scratch);                    // scratch=a；栈 [a]（短路时作块结果）
            this.m.localGet(this.scratch); this.emitCond();   // [a, truthy(a)]
            if (isAnd) this.m.i32Eqz();                       // && : falsy(a) → 跳出（返回 a）
            this.m.brIf(0);                                   // 短路条件真 → 返回 a
            this.m.drop();                                    // 落下路径丢弃 a
            this.emitBinaryOperandValue(e.right);             // 仅此路径求值 b
            this.m.end();                                     // 块结果 = b
            return;
        }
        this.emitBinaryOperandValue(e.left);
        this.emitBinaryOperandValue(e.right);
        this.emitBinaryOp(op);
    }
    // 条件求值：栈顶 f64 → i32（truthy）。JS ToBoolean(number): false iff 0/-0/NaN。
    // (x != 0) 排除 0/-0（IEEE: -0==0）；(x == x) 排除 NaN（IEEE: NaN≠NaN → eq=false）。AND = truthy。
    // 此前仅 `x != 0` → NaN 误判 truthy（NaN≠0 为 true）→ `NaN ? 1 : 7` 得 1 而非 7。
    emitCond() {
        this.m.localSet(this.scratchA);
        this.m.localGet(this.scratchA); this.m.f64Const(0); this.m.f64Ne();        // x != 0
        this.m.localGet(this.scratchA); this.m.localGet(this.scratchA); this.m.f64Eq();  // x == x
        this.m.i32And();
    }
    emitBinaryOperandValue(e) { if (ts.isBinaryExpression(e)) this.emitBinary(e); else this.emitExpr(e); }
    emitBinaryOp(op) {
        switch (op) {
            case ts.SyntaxKind.PlusToken: this.m.f64Add(); break;
            case ts.SyntaxKind.MinusToken: this.m.f64Sub(); break;
            case ts.SyntaxKind.AsteriskToken: this.m.f64Mul(); break;
            case ts.SyntaxKind.SlashToken: this.m.f64Div(); break;
            case ts.SyntaxKind.PercentToken: this.emitRem(); break;
            case ts.SyntaxKind.LessThanToken: this.m.f64Lt(); this.m.f64ConvertI32S(); break;
            case ts.SyntaxKind.GreaterThanToken: this.m.f64Gt(); this.m.f64ConvertI32S(); break;
            case ts.SyntaxKind.LessThanEqualsToken: this.m.f64Le(); this.m.f64ConvertI32S(); break;
            case ts.SyntaxKind.GreaterThanEqualsToken: this.m.f64Ge(); this.m.f64ConvertI32S(); break;
            case ts.SyntaxKind.EqualsEqualsToken: case ts.SyntaxKind.EqualsEqualsEqualsToken: this.m.f64Eq(); this.m.f64ConvertI32S(); break;
            case ts.SyntaxKind.ExclamationEqualsToken: case ts.SyntaxKind.ExclamationEqualsEqualsToken: this.m.f64Ne(); this.m.f64ConvertI32S(); break;
            // 位运算：JS 语义 32 位整数 → i32 截断、运算、回 f64（>>> 无符号）
            case ts.SyntaxKind.AmpersandToken: this.emitBitI32(() => this.m.i32And(), false); break;
            case ts.SyntaxKind.BarToken: this.emitBitI32(() => this.m.i32Or(), false); break;
            case ts.SyntaxKind.CaretToken: this.emitBitI32(() => this.m.i32Xor(), false); break;
            case ts.SyntaxKind.LessThanLessThanToken: this.emitBitI32(() => this.m.i32Shl(), false); break;
            case ts.SyntaxKind.GreaterThanGreaterThanToken: this.emitBitI32(() => this.m.i32ShrS(), false); break;
            case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: this.emitBitI32(() => this.m.i32ShrU(), true); break;
            // **：wasm 无原生 f64.pow → 宿主 import（Math.pow 语义含 NaN/0 幂特例）
            case ts.SyntaxKind.AsteriskAsteriskToken: this.m.call("qz.math_pow"); break;
            default: throw new Error("不支持的二元运算符: " + ts.SyntaxKind[op]);
        }
    }
    // 栈: a b（f64 f64）→ i32 op → f64。unsigned: >>> 结果按无符号回 f64。
    emitBitI32(opFn, unsigned) {
        // 栈: a b（f64 f64）→ 存 b、a（各自 trunc 到 i32 再存）→ 取 a、b → op → f64
        this.m.i32TruncF64S(); this.m.f64ConvertI32S(); this.m.localSet(this.scratchB);
        this.m.i32TruncF64S(); this.m.f64ConvertI32S(); this.m.localSet(this.scratchA);
        this.m.localGet(this.scratchA); this.m.i32TruncF64S();
        this.m.localGet(this.scratchB); this.m.i32TruncF64S();
        opFn();
        unsigned ? this.m.f64ConvertI32U() : this.m.f64ConvertI32S();
    }

    // f64 取模：JS Number::remainder 语义（wasm 无 f64.rem）。路径：
    //   |b|==Inf → a（JS: x % ±Inf = x）
    //   q=a/b 非有限（NaN/±Inf：0 除、差溢出如 1e308%1e-308、NaN 输入）→ 宿主 qz.math_rem
    //     （唯一全精度途径：fmod 处理差溢出、subnormal 余数）
    //   否则 r = a - b*trunc(q)；r==0 时符号随 a（JS -2%2=-0、2%2=+0）→ a*0（copysign）
    //   a 压缩底保号：先压 a 后 b*trunc 再 sub —— 不经 f64Neg（它会把 +0 翻成 -0）。
    emitRem() {
        const M = this.m;
        // 弹入 local（栈不残留）：入口 [a b] → []（A=a, B=b）
        M.localSet(this.scratchB);             // 弹 b
        M.localSet(this.scratchA);             // 弹 a
        M.localGet(this.scratchB); M.f64Neg(); M.localGet(this.scratchB); M.f64Max();   // |b|
        M.f64Const(Infinity); M.f64Eq();
        M.ifBlock("f64");
        M.localGet(this.scratchA);             // |b|==Inf → a
        M.else_();
        M.localGet(this.scratchA); M.localGet(this.scratchB); M.f64Div();
        M.localSet(this.scratch);              // T=q
        // q 非有限 → 宿主（除零、NaN、差溢出）
        M.localGet(this.scratch); M.localGet(this.scratch); M.f64Ne();                  // qNaN
        M.localGet(this.scratch); M.f64Neg(); M.localGet(this.scratch); M.f64Max();
        M.f64Const(Infinity); M.f64Eq();       // |q|==Inf
        M.i32Or();
        M.ifBlock("f64");
        M.localGet(this.scratchA); M.localGet(this.scratchB); M.call("qz.math_rem");
        M.else_();
        M.localGet(this.scratchA);             // [a]（保底给最终 sub）
        M.localGet(this.scratchB);             // [a b]
        M.localGet(this.scratch); M.f64Trunc();// [a b trunc(q)]
        M.f64Mul();                            // [a b*trunc]
        M.f64Sub();                            // [a - b*trunc] = r
        // 零余数符号随被除数：r==0 → a*0
        M.localSet(this.scratch);              // T=r
        M.localGet(this.scratchA); M.f64Const(0); M.f64Mul();   // [a*0]
        M.localGet(this.scratch);              // [a*0 r]
        M.localGet(this.scratch); M.f64Const(0); M.f64Eq();     // [a*0 r r==0]
        M.select();                            // r==0 ? a*0 : r
        M.end();
        M.end();
    }
}

// ---------- 主流程 ----------
// ---------- 字符串（wasm 内表示，零跨界）----------
// 句柄 = i64 高16位 0x7FFA | 低32位 = 字符串结构偏移（结构 [len:i32][utf8 bytes]）。
// 字面量驻留 data 段（STR_BASE 起）；动态拼接走 bump 堆（global0 从 STR_BUMP 起）。
// 数字→字符串用固定 scratch 区（SCRATCH 起）。
const STR_TAG_HI = 0x7ffa;                       // 字符串句柄高 16 位标记
const ARR_TAG_HI = 0x7ffb;                       // 数组句柄高 16 位标记（布局 [len:i32][pad:i32][elem:i64×N]，元素 +8 起）。
                                                 // 不可用 0x7FF8：那是 canonical quiet NaN（宿主 box(NaN) 恰产此位型），
                                                 // 与 f64 算术结果相撞 → 任何 NaN 会被误判为数组句柄。
const SCRATCH = 16;                              // numstr 临时区（48 字节，够 20 位 + 负号 + len）
const STR_BASE = 16 << 20;                       // 字面量 data 段基址（16 MiB）：bump 堆 arena 上限，越过即 trap
                                                 // （字符串拼接不再原地追加 → 内存需求约翻倍，故 arena 加倍）
const STR_BUMP = 128;                            // bump 堆起始（跳过 scratch）

// 字符串 helper 函数（每模块一份，emitter call 调用）

// 推进 bump 堆：emitDelta 把增量(i32)压栈；新值经 qzs_ckmem 守卫（越界 trap）后写回 global0。
function emitBumpGrow(m, emitDelta) {
    m.globalGet(0); emitDelta(); m.i32Add(); m.call("qzs_ckmem"); m.globalSet(0);
}
// 分配 emitTotal 字节：bump 经守卫增长后回退，栈顶留 offset(i32)（= 增长前的 bump）。
function emitBumpAlloc(m, emitTotal) {
    emitBumpGrow(m, emitTotal);
    m.globalGet(0); emitTotal(); m.i32Sub();
}
// 直接落定 bump 新值：emitNewVal 压栈得 newBump(i32)，经 qzs_ckmem 守卫后写回 global0。
function emitBumpSet(m, emitNewVal) {
    emitNewVal(); m.call("qzs_ckmem"); m.globalSet(0);
}
function emitStringHelpers(m) {
    // qzs_ckmem(newBump:i32) -> i32：bump 越界守卫。arena = [SCRATCH, STR_BASE)，越过基址
    // 即 trap（unreachable），杜绝静默覆盖字面量段（STR_BASE 起）或 OOB 崩溃。
    m.declareFunc("qzs_ckmem", ["i32"], ["i32"]);
    m.startBody("qzs_ckmem", [], []);
    m.localGet(0); m.i32Const(STR_BASE); m.i32GtU();
    m.ifBlock("void"); m.unreachable(); m.end();
    m.localGet(0);
    m.endBody();
    // qzs_memcpy(dest, src, n)：先 8 字节块（i64.load/store，wasm 允许非对齐），尾字节。
    // 逐字节版对每次 append 的小 n 太慢（真实上下文 ~178ns/byte）。
    m.declareFunc("qzs_memcpy", ["i32", "i32", "i32"], []);
    m.startBody("qzs_memcpy", ["i32", "i32", "i32"]);
    m.localGet(0); m.localSet(5);                        // dest → 5
    m.localGet(1); m.localSet(4);                        // src → 4
    m.localGet(2); m.localSet(3);                        // n → 3
    // 8 字节块
    m.block("void"); m.loop("void");
    m.localGet(3); m.i32Const(8); m.i32LtU(); m.brIf(1);
    m.localGet(5); m.localGet(4); m.i64Load(0, 0); m.i64Store(0, 0);
    m.localGet(5); m.i32Const(8); m.i32Add(); m.localSet(5);
    m.localGet(4); m.i32Const(8); m.i32Add(); m.localSet(4);
    m.localGet(3); m.i32Const(8); m.i32Sub(); m.localSet(3);
    m.br(0); m.end(); m.end();
    // 尾字节
    m.block("void"); m.loop("void");
    m.localGet(3); m.i32Eqz(); m.brIf(1);
    m.localGet(5); m.localGet(4); m.i32Load8U(0, 0); m.i32Store8(0, 0);
    m.localGet(5); m.i32Const(1); m.i32Add(); m.localSet(5);
    m.localGet(4); m.i32Const(1); m.i32Add(); m.localSet(4);
    m.localGet(3); m.i32Const(1); m.i32Sub(); m.localSet(3);
    m.br(0); m.end(); m.end();
    m.endBody();

    // qzs_numstr(dest:i32, n:i64) -> i32（写 [dest]=len:i32, digits@dest+4；返回 dest）
    // locals: 2=pos(i32), 3=count(i32), 4=neg(i32), 5=mag32(i32), 6=nn64(i64)
    // 小值(≤0xFFFFFFFF)走 i32 除法（硬件），大值回退 i64（软件 libcall，慢）。
    m.declareFunc("qzs_numstr", ["i32", "i64"], ["i32"]);
    m.startBody("qzs_numstr", ["i32", "i32", "i32", "i32", "i64"]);
    // 符号：neg=0；若 n<0 则 neg=1、n=-n
    m.i32Const(0); m.localSet(4);
    m.localGet(1); m.i64Const(0n); m.i64LtS();
    m.ifBlock("void");
      m.i32Const(1); m.localSet(4);
      m.i64Const(0n); m.localGet(1); m.i64Sub(); m.localSet(1);
    m.end();
    m.localGet(1); m.i64Const(0xffff_ffffn); m.i64LeU();
    m.ifBlock("void");
      // ---- i32 路径（硬件 div/rem）----
      m.localGet(1); m.i32WrapI64(); m.localSet(5);          // mag32
      m.i32Const(0); m.localSet(3);                          // count=0
      m.block("void"); m.loop("void");
        m.localGet(3); m.i32Const(1); m.i32Add(); m.localSet(3);
        m.localGet(5); m.i32Const(10); m.i32DivU(); m.localSet(5);
        m.localGet(5); m.i32Eqz(); m.brIf(1);
        m.br(0); m.end(); m.end();
      m.localGet(4); m.ifBlock("void");
        m.localGet(3); m.i32Const(1); m.i32Add(); m.localSet(3);   // 负号占 1 位
      m.end();
      m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(3); m.i32Add(); m.localSet(2);  // pos
      m.localGet(1); m.i32WrapI64(); m.localSet(5);          // refill mag32
      m.block("void"); m.loop("void");
        m.localGet(2); m.i32Const(1); m.i32Sub(); m.localSet(2);
        m.localGet(2); m.localGet(5); m.i32Const(10); m.i32RemU(); m.i32Const(0x30); m.i32Add(); m.i32Store8(0, 0);
        m.localGet(5); m.i32Const(10); m.i32DivU(); m.localSet(5);
        m.localGet(5); m.i32Eqz(); m.brIf(1);
        m.br(0); m.end(); m.end();
    m.else_();
      // ---- i64 路径 ----
      m.localGet(1); m.localSet(6);                          // nn64 = |n|
      m.i32Const(0); m.localSet(3);
      m.block("void"); m.loop("void");
        m.localGet(3); m.i32Const(1); m.i32Add(); m.localSet(3);
        m.localGet(6); m.i64Const(10n); m.i64DivU(); m.localSet(6);
        m.localGet(6); m.i64Eqz(); m.brIf(1);
        m.br(0); m.end(); m.end();
      m.localGet(4); m.ifBlock("void");
        m.localGet(3); m.i32Const(1); m.i32Add(); m.localSet(3);
      m.end();
      m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(3); m.i32Add(); m.localSet(2);
      m.localGet(1); m.localSet(6);
      m.block("void"); m.loop("void");
        m.localGet(2); m.i32Const(1); m.i32Sub(); m.localSet(2);
        m.localGet(2); m.localGet(6); m.i64Const(10n); m.i64RemU(); m.i32WrapI64(); m.i32Const(0x30); m.i32Add(); m.i32Store8(0, 0);
        m.localGet(6); m.i64Const(10n); m.i64DivU(); m.localSet(6);
        m.localGet(6); m.i64Eqz(); m.brIf(1);
        m.br(0); m.end(); m.end();
    m.end();
    // 负号
    m.localGet(4); m.ifBlock("void");
      m.localGet(2); m.i32Const(1); m.i32Sub(); m.localSet(2);
      m.localGet(2); m.i32Const(0x2d); m.i32Store8(0, 0);
    m.end();
    m.localGet(0); m.localGet(3); m.i32Store(0, 0);       // [dest]=len
    m.localGet(0);
    m.endBody();

    // qzs_append(buf, src, addLen) -> i32（top-of-bump 原地追加，否则新建拷贝）
    m.declareFunc("qzs_append", ["i32", "i32", "i32"], ["i32"]);
    m.startBody("qzs_append", ["i32", "i32", "i32", "i32", "i32"]);
    m.localGet(0); m.i32Load(2, 0); m.localSet(3);       // oldLen
    m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(3); m.i32Add();
    m.globalGet(0); m.i32Eq();                            // top?
    m.ifBlock("i32");
    emitBumpGrow(m, () => m.localGet(2));                 // bump+=addLen（越界 trap）
    m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(3); m.i32Add();  // dest
    m.localGet(1); m.localGet(2); m.call("qzs_memcpy");
    m.localGet(0); m.localGet(3); m.localGet(2); m.i32Add(); m.i32Store(2, 0);
    m.localGet(0);
    m.else_();
    m.globalGet(0); m.localSet(4);                        // newBuf
    emitBumpGrow(m, () => { m.i32Const(4); m.localGet(3); m.i32Add(); m.localGet(2); m.i32Add(); });   // bump+=4+oldLen+addLen
    m.localGet(4); m.localGet(3); m.localGet(2); m.i32Add(); m.i32Store(2, 0);
    m.localGet(4); m.i32Const(4); m.i32Add(); m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(3); m.call("qzs_memcpy");
    m.localGet(4); m.i32Const(4); m.i32Add(); m.localGet(3); m.i32Add(); m.localGet(1); m.localGet(2); m.call("qzs_memcpy");
    m.localGet(4);
    m.end();
    m.endBody();

    // qzs_utf16len(off) -> i32：UTF-8 字符串（[byteLen:i32][utf8]）→ UTF-16 码元数。
    // JS String.length 是 UTF-16 code units：ASCII/2字节/3字节首字节各 +1，4字节首字节额外 +1（代理对 2 码元），
    // 续字节(0x80-0xBF) +0。此前 .length 直接返回 UTF-8 字节数 → "你好".length=6（应 2）、"😀".length=4（应 2）。
    m.declareFunc("qzs_utf16len", ["i32"], ["i32"]);
    m.startBody("qzs_utf16len", ["i32", "i32", "i32", "i32", "i32"]);   // locals: 1=len 2=i 3=cnt 4=b
    m.localGet(0); m.i32Load(2, 0); m.localSet(1);               // byteLen
    m.i32Const(0); m.localSet(2);                                // i = 0
    m.i32Const(0); m.localSet(3);                                // cnt = 0
    m.block("void"); m.loop("void");
    m.localGet(2); m.localGet(1); m.i32GeU(); m.brIf(1);         // i >= len → 结束
    m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(2); m.i32Add(); m.i32Load8U(0, 0); m.localSet(4);   // b
    m.localGet(4); m.i32Const(0x80); m.i32LtU();                 // b < 0x80
    m.localGet(4); m.i32Const(0xc0); m.i32GeU();                 // b >= 0xC0（首字节）
    m.i32Or();
    m.localGet(4); m.i32Const(0xf0); m.i32GeU();                 // 4 字节首 → +1（代理对第二码元）
    m.i32Add();
    m.localGet(3); m.i32Add(); m.localSet(3);                    // cnt += inc
    m.localGet(2); m.i32Const(1); m.i32Add(); m.localSet(2);     // i++
    m.br(0);
    m.end(); m.end();
    m.localGet(3);
    m.endBody();
}

/* 函数编译模式：参数全 number、返回 number/void、且函数体**只含 num 安全表达式**
 * → "num"（f64 快路径）。任一不安全表达式 → "tagged"。
 * num emitExpr 只支持：Identifier / NumericLiteral / BinaryExpression(算术/逻辑/比较) /
 * CallExpression(到 num 函数) / PrefixUnaryExpression(++/--/!) / PostfixUnaryExpression /
 * ConditionalExpression(三元) / ParenthesizedExpression / 赋值表达式。
 * 其余（对象/数组/字符串字面量、属性/元素访问、模板、new、箭头、类型断言…）num 路径
 * emitExpr 会直接抛 `不支持的表达式` —— 必须在 funcMode 阶段就检出并退到 tagged。
 * 这不是「性能换语义」——是编译器**崩溃预防**：不降级的后果是硬错误而非运行时慢。 */
function funcMode(f) {
    const rt = f.type;
    const rtOk = !rt || rt.kind === ts.SyntaxKind.NumberKeyword || rt.kind === ts.SyntaxKind.VoidKeyword;
    const allNum = f.parameters.every(p => p.type && p.type.kind === ts.SyntaxKind.NumberKeyword);
    // 非安全表达式：只要函数体含任一即退 tagged
    let unsafe = false;
    const walk = (n) => {
        if (n === f) { ts.forEachChild(n, walk); return; }
        if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isNewExpression(n)
            || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)
            || ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n)
            || ts.isTemplateExpression(n)
            || ts.isSpreadElement(n) || ts.isTaggedTemplateExpression(n)
            || ts.isClassExpression(n) || ts.isAwaitExpression(n) || ts.isYieldExpression(n)
            || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
            || ts.isTypeOfExpression(n) || ts.isVoidExpression(n) || ts.isDeleteExpression(n)
            || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword))
            unsafe = true;   // 注：as / x! / satisfies 为纯类型层构造（emit 恒等擦除），不列入
        ts.forEachChild(n, walk);
    };
    if (f.body) walk(f);
    return (allNum && rtOk && !unsafe && (f.parameters.length > 0 || (rt && rt.kind === ts.SyntaxKind.NumberKeyword))) ? "num" : "tagged";
}

function compileTS(input, outWasm, opts = {}) {
    // tsc 的 createProgram **自带模块解析**（import 链）：它把被 import 的 .ts 文件全部
    // 纳入 program.getSourceFiles()。这是现成的 TS 内联工具——不自己实现模块图遍历。
    // 每个源文件（非声明文件）的顶层函数/类都编进**同一个** wasm 模块（内联）；跨文件
    // 引用经 tsc 解析后是同模块内的普通 call（名字域 = wasm 函数索引）。
    // module: None —— interp 回退要直接 emit 出可内联的 JS（见下方 interpJs），不希望 tsc 生成
    // require/exports 包装；wasm 路径只用 AST，不受影响。
    const program = ts.createProgram([input], { strict: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None, moduleResolution: ts.ModuleResolutionKind.NodeJs });
    const sfs = program.getSourceFiles().filter(f => !f.isDeclarationFile && f.fileName.endsWith(".ts"));
    const sf = program.getSourceFile(input);   // 入口文件（默认 em.sf；逐函数按源文件覆盖）
    // 收集顶层函数/类，并记录各自源文件（`ts.getSourceFileOfNode` 需要 parent 指针，
    // 而未绑定的 program 里 parent 为空；收集时就近记录，避免额外触发类型绑定）。
    const fns = [];
    const fnSf = new Map();          // 函数节点 → 源文件（逐函数设 em.sf，供行号/DWARF）
    const clsStmts = [];
    const clsExprMap = new Map();     // ClassExpression 节点 → 合成类名
    const clsExprSeqRef = { n: 0 };
    let clsExprSeq = 0;
    const enumStmts = [];         // TS enum（值语义，非纯类型 → 编译期求值）
    // 递归收集：函数/类声明**任意深度**均提升到模块级（函数内定义的 class/function 亦可编译）。
    // 提升后不再深入其体（避免重复收集其内部声明）。
    // 顶层函数声明 → 模块级 wasm 函数；**嵌套**函数声明 → 闭包（lambda+env，见 _emitFnDeclClosures），
    // 否则其对外层局部的捕获会丢失（此前整树提升 → 编译期「未定义变量」）。
    const hoistedFns = new Set();
    // enum 初值常量折叠（数字/字符串字面量、一元 +/-/~、四则、位运算、括号）
    const enumConstValue = (node, self) => {
        if (!node) return null;
        if (ts.isParenthesizedExpression(node)) return enumConstValue(node.expression, self);
        if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ""));
        if (ts.isStringLiteral(node)) return node.text;
        if (ts.isPrefixUnaryExpression(node)) {
            const v = enumConstValue(node.operand, self);
            if (typeof v !== "number") return null;
            switch (node.operator) { case ts.SyntaxKind.MinusToken: return -v; case ts.SyntaxKind.PlusToken: return v; case ts.SyntaxKind.TildeToken: return ~v; default: return null; }
        }
        if (ts.isBinaryExpression(node)) {
            const l = enumConstValue(node.left, self), r2 = enumConstValue(node.right, self);
            if (typeof l !== "number" || typeof r2 !== "number") return null;
            switch (node.operatorToken.kind) {
                case ts.SyntaxKind.PlusToken: return l + r2; case ts.SyntaxKind.MinusToken: return l - r2;
                case ts.SyntaxKind.AsteriskToken: return l * r2; case ts.SyntaxKind.SlashToken: return l / r2;
                case ts.SyntaxKind.PercentToken: return l % r2; case ts.SyntaxKind.LessThanLessThanToken: return l << r2;
                case ts.SyntaxKind.GreaterThanGreaterThanToken: return l >> r2;
                case ts.SyntaxKind.AmpersandToken: return l & r2; case ts.SyntaxKind.BarToken: return l | r2;
                case ts.SyntaxKind.CaretToken: return l ^ r2; default: return null;
            }
        }
        return null;
    };
    const modConstLit = new Map();   // 模块级字面量 const（名字 → 字符串/数值），供计算属性名折叠
    const modVars = [];          // 模块级变量声明（含初值）
    const modStmts = [];         // 模块级变量语句（合成 __module_init 的函数体）
    const collectDecls = (f) => {
        const walkCls = (n) => {          // class 仍整树提升（含函数内 class）
            if (ts.isClassDeclaration(n)) clsStmts.push(n);
            if (ts.isEnumDeclaration(n)) enumStmts.push(n);
            if (ts.isClassExpression(n) && !clsExprMap.has(n)) {   // 类表达式：合成类名（用于 new / instanceof）
                const synth = n.name ? n.name.text : "__clsExpr_" + (++clsExprSeq);
                clsExprMap.set(n, synth);
                const decl = ts.factory.createClassDeclaration(n.modifiers, ts.factory.createIdentifier(synth), n.typeParameters, n.heritageClauses, n.members);
                decl.pos = n.pos; decl.end = n.end;
                clsStmts.push(decl);
            }
            ts.forEachChild(n, walkCls);
        };
        for (const st of f.statements) {
            if (ts.isFunctionDeclaration(st) && st.name) { fns.push(st); fnSf.set(st, f); hoistedFns.add(st); }
            if (ts.isVariableStatement(st)) {                       // 模块级 const/let → wasm 全局（模块初始化时赋值一次）
                for (const d of st.declarationList.declarations) {
                    if (!ts.isIdentifier(d.name) || !d.initializer) continue;
                    modVars.push(d);
                    if (ts.isStringLiteral(d.initializer)) modConstLit.set(d.name.text, d.initializer.text);   // 字面量 const → 计算属性名可折叠
                    else if (ts.isNumericLiteral(d.initializer)) modConstLit.set(d.name.text, Number(d.initializer.text.replace(/_/g, "")));
                }
                modStmts.push(st);
            } else if (!ts.isFunctionDeclaration(st) && !ts.isClassDeclaration(st) && !ts.isInterfaceDeclaration(st)
                && !ts.isEnumDeclaration(st) && !ts.isEnumMember(st)
                && !ts.isTypeAliasDeclaration(st) && !ts.isModuleDeclaration(st)
                && st.kind !== ts.SyntaxKind.ImportDeclaration && st.kind !== ts.SyntaxKind.ExportDeclaration
                && st.kind !== ts.SyntaxKind.ExportAssignment) {
                modStmts.push(st);   // 模块级其它语句（表达式副作用、if/for/try 等）→ 纳入 __module_init（此前被**静默丢弃**）
            }
            walkCls(st);
        }
    };
    for (const f of sfs) collectDecls(f);
    // 模块级 const 的**静态键序**（对象字面量 + 对已知 const 的展开；未知则整条跳过 = 保持既有行为）
    const modObjKeys = new Map();
    {
        const keysOfNode = (node, depth) => {
            if (!node || depth > 8 || !ts.isObjectLiteralExpression(node)) return null;
            const out = [];
            for (const prop of node.properties) {
                if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
                    if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name) && !ts.isNumericLiteral(prop.name)) return null;
                    const nm = prop.name.text;
                    if (out.indexOf(nm) < 0) out.push(nm);
                } else if (ts.isSpreadAssignment(prop)) {
                    const sub = ts.isIdentifier(prop.expression) ? modObjKeys.get(prop.expression.text) : keysOfNode(prop.expression, depth + 1);
                    if (!sub) return null;
                    for (const nm2 of sub) if (out.indexOf(nm2) < 0) out.push(nm2);
                } else return null;   // 方法/访问器/计算键 → 无法静态定序
            }
            return out;
        };
        for (const d of modVars) if (ts.isIdentifier(d.name) && d.initializer) {
            const ks = keysOfNode(d.initializer, 0);
            if (ks) modObjKeys.set(d.name.text, ks);
        }
    }
    if (modStmts.length) {
        // 合成模块初始化函数：体 = 模块级变量语句（按源序），返回值 void；实例化时由 start 段自动执行。
        const initFn = ts.factory.createFunctionDeclaration(undefined, undefined, "__module_init", undefined, [],
            ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword), ts.factory.createBlock(modStmts, true));
        const anchor = modStmts[0];                 // 合成节点需真实位置（DWARF/行号），借用首条语句范围
        initFn.pos = anchor.pos; initFn.end = anchor.end; initFn.parent = sf;
        initFn.body.pos = anchor.pos; initFn.body.end = anchor.end; initFn.body.parent = initFn;
        fns.push(initFn); fnSf.set(initFn, sf); hoistedFns.add(initFn);
    }
    // 预登记所有属性名（POJO/实例容量统一；否则「运行期新增字段」会越界写、静态读会错位）。
    const preNames = [];
    let usesFreeze = false;
    let usesDynAcc = false;            // 程序内出现 Object.defineProperty → POJO/实例属性读改写走宿主（可能定义了访问器）
    let usesKeyOrder = false;          // 程序是否观察对象键序（Object.keys/for-in/JSON/spread）→ 需要插入序跟踪                  // 程序内是否出现 freeze/seal/preventExtensions（写保护检查只在需要时发射）
    {
        const seenN = new Set(), push = (t) => { if (t !== undefined && t !== null && !seenN.has(t)) { seenN.add(t); preNames.push(t); } };
        const walkNames = (n) => {
            if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
                && /^(Object|JSON)$/.test(n.expression.expression.text)
                && /^(keys|values|entries|assign|fromEntries|getOwnPropertyNames|stringify)$/.test(n.expression.name.text)) usesKeyOrder = true;
            if (ts.isForInStatement(n) || ts.isSpreadAssignment(n)) usesKeyOrder = true;
            if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
                && n.expression.expression.text === "Object" && /^(defineProperty|defineProperties)$/.test(n.expression.name.text)) usesDynAcc = true;
            if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
                && n.expression.expression.text === "Object" && /^(freeze|seal|preventExtensions)$/.test(n.expression.name.text)) usesFreeze = true;
            if (ts.isPropertyAccessExpression(n)) push(n.name.text);
            else if (ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) push(n.name.text);
            else if (ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) push(n.name.text);
            else if (ts.isBindingElement(n)) { if (n.propertyName) push(n.propertyName.text); if (ts.isIdentifier(n.name)) push(n.name.text); }
            else if (ts.isElementAccessExpression(n) && (ts.isStringLiteral(n.argumentExpression) || ts.isNumericLiteral(n.argumentExpression))) push(n.argumentExpression.text);
            ts.forEachChild(n, walkNames);
        };
        for (const f of sfs) walkNames(f);
    }
    const hasClasses = clsStmts.length > 0;
    // TS enum 编译期求值：{ 名字 → {fwd: 成员→值, rev: 值→成员名} }。字符串枚举无反向映射（与 TS 一致）。
    const enums = new Map();
    for (const st of enumStmts) {
        if (!st.name) throw new Error("[tagged] 匿名 enum 不支持");
        const fwd = new Map(), rev = new Map();
        let nextIdx = 0, isStr = false;
        for (const mem of st.members) {
            if (!ts.isIdentifier(mem.name)) throw new Error("[tagged] enum 成员名须为标识符");
            let val = nextIdx;
            if (mem.initializer) {
                const iv = enumConstValue(mem.initializer);
                if (iv === null) throw new Error("[tagged] enum 初值仅支持数字/字符串字面量与简单算术：" + st.name.text + "." + mem.name.text);
                val = iv;
            }
            fwd.set(mem.name.text, val);
            if (typeof val === "string") isStr = true; else { rev.set(String(val), mem.name.text); nextIdx = (typeof val === "number" ? val : 0) + 1; }
        }
        enums.set(st.name.text, { fwd, rev, isStr });
    }
    // import 绑定：{ 本地名 → 目标顶层函数名 }。模块图由 tsc 解析（createProgram），
    // 用 checker 穿透 re-export 链解析到最终目标——AST 级 `sp.propertyName` 只
    // 处理 `import { x as y }` 自身别名，穿不过 `export { x as y } from` 链。
    // 同时检测外部模块 re-export（不可内联 → 显式报错，不静默丢绑定）。
    const checker = program.getTypeChecker();
    const sfNames = new Set(sfs.map(f => f.fileName));
    const importAlias = new Map();
    const nsAlias = new Map();       // 命名空间本地名 → Map(成员名 → 目标顶层名)
    const classAlias = new Map();    // 导入的类本地名 → 目标类名（默认/具名导入类）+ 类表达式绑定
    {
        const walkCE = (n) => {
            if ((ts.isVariableDeclaration(n) || ts.isBindingElement(n) || ts.isPropertyAssignment(n)) && n.initializer && ts.isClassExpression(n.initializer)
                && clsExprMap.has(n.initializer)) {
                const nm = (n.name && ts.isIdentifier(n.name)) ? n.name.text : null;
                if (nm) classAlias.set(nm, clsExprMap.get(n.initializer));
            }
            ts.forEachChild(n, walkCE);
        };
        for (const f of sfs) walkCE(f);
    }
    for (const f of sfs) {
        for (const st of f.statements) {
            if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
                if (st.exportClause && ts.isNamedExports(st.exportClause)) {
                    for (const el of st.exportClause.elements) {
                        const sym = checker.getSymbolAtLocation(el.name);
                        if (!sym || !(sym.flags & ts.SymbolFlags.Alias))
                            throw new Error(`[inline] 外部模块 re-export 不支持内联: "${el.name.text}" from "${st.moduleSpecifier.text}"（${path.basename(f.fileName)}）`);
                        const tgt = checker.getAliasedSymbol(sym);
                        const decl = tgt.valueDeclaration || (tgt.declarations && tgt.declarations[0]);
                        const declFile = decl && ts.getSourceFileOfNode(decl);
                        if (!declFile || !sfNames.has(declFile.fileName))
                            throw new Error(`[inline] 外部模块 re-export 不支持内联: "${el.name.text}" from "${st.moduleSpecifier.text}"（${path.basename(f.fileName)}）`);
                    }
                } else {
                    throw new Error(`[inline] 不支持 export * re-export（${path.basename(f.fileName)}）`);
                }
                continue;
            }
            if (!ts.isImportDeclaration(st) || !st.importClause) continue;
            const ic = st.importClause;
            // 默认导入：`import d from './m'`。目标须为源码内声明的函数/类；折回目标顶层名，
            // 与具名导入同机制。
            if (ic.name) {
                const sym = checker.getSymbolAtLocation(ic.name);
                const tgt = (sym && (sym.flags & ts.SymbolFlags.Alias)) ? checker.getAliasedSymbol(sym) : null;
                const decl = tgt && (tgt.valueDeclaration || (tgt.declarations && tgt.declarations[0]));
                const declFile = decl && ts.getSourceFileOfNode(decl);
                if (!declFile || !sfNames.has(declFile.fileName))
                    throw new Error(`[inline] 默认导入来自外部模块，不支持内联: "${ic.name.text}" from "${st.moduleSpecifier.text}"（${path.basename(f.fileName)}）`);
                if (!decl.name)   // `export default function(){}` 匿名默认导出：无稳定顶层名
                    throw new Error(`[inline] 匿名默认导出不支持内联（请给函数/类命名）（${path.basename(declFile.fileName)}）`);
                importAlias.set(ic.name.text, decl.name.text);
                if (ts.isClassDeclaration(decl)) classAlias.set(ic.name.text, decl.name.text);
            }
            if (!ic.namedBindings) continue;
            // 命名空间导入：`import * as ns from './m'` → 记录 ns → { 成员名 ↦ 目标顶层名 }。
            // 用 checker 模块导出表（穿透 re-export 链）；外部模块成员不在源码内 → 显式报错。
            if (ts.isNamespaceImport(ic.namedBindings)) {
                const modSym = checker.getSymbolAtLocation(st.moduleSpecifier);
                if (!modSym)
                    throw new Error(`[inline] 命名空间导入来自外部模块，不支持内联: "${ic.namedBindings.name.text}" from "${st.moduleSpecifier.text}"（${path.basename(f.fileName)}）`);
                const members = new Map();
                for (const e of checker.getExportsOfModule(modSym)) {
                    const t = (e.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(e) : e;
                    if (!t || !t.name) continue;
                    const d = t.valueDeclaration || (t.declarations && t.declarations[0]);
                    const df = d && ts.getSourceFileOfNode(d);
                    if (!df || !sfNames.has(df.fileName))
                        throw new Error(`[inline] 命名空间导入含外部模块成员，不支持内联: "${e.name}" from "${st.moduleSpecifier.text}"（${path.basename(f.fileName)}）`);
                    members.set(e.name, t.name);
                }
                importAlias.set(ic.namedBindings.name.text, ic.namedBindings.name.text);
                nsAlias.set(ic.namedBindings.name.text, members);
                continue;
            }
            if (!ts.isNamedImports(ic.namedBindings)) continue;
            for (const sp of ic.namedBindings.elements) {
                const sym = checker.getSymbolAtLocation(sp.name);
                if (sym && (sym.flags & ts.SymbolFlags.Alias)) {
                    const tgt = checker.getAliasedSymbol(sym);
                    if (tgt && tgt.name) {
                        const decl = tgt.valueDeclaration || (tgt.declarations && tgt.declarations[0]);
                        const declFile = decl && ts.getSourceFileOfNode(decl);
                        if (declFile && sfNames.has(declFile.fileName)) {
                            importAlias.set(sp.name.text, tgt.name);
                            if (ts.isClassDeclaration(decl)) classAlias.set(sp.name.text, tgt.name);
                            continue;
                        }
                        throw new Error(`[inline] 外部模块导入不支持内联: "${sp.name.text}" from "${st.moduleSpecifier.text}"（${path.basename(f.fileName)}）`);
                    }
                }
                importAlias.set(sp.name.text, sp.propertyName ? sp.propertyName.text : sp.name.text);
            }
        }
    }
    // 内联到同一 wasm 模块 ⇒ 顶层函数名必须全局唯一。冲突宁可显式报错，
    // 不静默覆盖（覆盖 = 调错函数，属语义错误）。
    {
        const seenFn = new Map();
        for (const f of fns) {
            const n = f.name.text;
            const fs2 = fnSf.get(f);
            const where = fs2 ? fs2.fileName : "(unknown)";
            if (seenFn.has(n))
                throw new Error(`[inline] 顶层函数名冲突: "${n}" 同时出现在 ${path.basename(seenFn.get(n))} 与 ${path.basename(where)}`);
            seenFn.set(n, where);
        }
    }
    // ── interp 回退：opts.interp 列出的函数不编 wasm，退到 JS 跑在宿主解释器里。
    // 理由：字符串操作在 wasm 里每轮循环都跨 qz.add 调宿主 → 跨界开销吃掉 AOT 收益。
    // 传递闭包：wasm 函数调 interp 函数 = 该函数也须 interp（wasm 内无该函数索引）。
    const allFnNames = new Set(fns.map(f => f.name.text));
    const interpSet = new Set(opts.interp || []);
    if (interpSet.size > 0) {
        // 调用图：顶层函数 → 它调用的顶层函数集
        const calls = new Map();
        for (const f of fns) {
            const callees = new Set();
            const walk = (n) => {
                if (ts.isCallExpression(n) && n.expression && ts.isIdentifier(n.expression)) {
                    const resolved = importAlias.get(n.expression.text) || n.expression.text;
                    if (allFnNames.has(resolved)) callees.add(resolved);
                }
                ts.forEachChild(n, walk);
            };
            if (f.body) walk(f.body);
            calls.set(f.name.text, callees);
        }
        // 传递闭包
        let changed = true;
        while (changed) {
            changed = false;
            for (const [fn, callees] of calls) {
                if (interpSet.has(fn)) continue;
                for (const callee of callees) {
                    if (interpSet.has(callee)) { interpSet.add(fn); changed = true; break; }
                }
            }
        }
    }
    // TS→JS（去类型）供 glue 内联 interp 函数。
    // 内联后是**单一作用域**（模块边界已由 inlining 消除），故须剥掉模块语法：
    //  ① 删 import/export 声明；
    //  ② `import { pad as fill }` 的**引用点**重写成目标顶层函数名（fill → pad）——tsc 的模块
    //     transform 本来会把引用改写成 `str2_1.pad`（依赖 require），内联后没有它，必须自己重写；
    //  ③ 剥 export/default 修饰符（否则 emit 出 `exports.X = X`，glue 里没有 exports）。
    // 用 checker（上方已创建）精确定位 import 绑定（而非按名字猜），program.emit 复用同一 AST。
    let interpJs = "";
    if (interpSet.size > 0) {
        const stripModuleSyntax = (ctx) => (sf2) => {
            const visit = (n) => {
                if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return undefined;
                // `export default <名>;` → 顶层声明已在；非纯标识符则退成表达式语句（去 export default）。
                if (ts.isExportAssignment(n)) {
                    return ts.isIdentifier(n.expression) ? undefined
                        : ts.factory.createExpressionStatement(ts.visitNode(n.expression, visit));
                }
                if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
                    const nsMap = nsAlias.get(n.expression.text);
                    const resolved = nsMap && nsMap.get(n.name.text);
                    if (resolved !== undefined) return ts.factory.createIdentifier(resolved);
                    return ts.visitEachChild(n, visit, ctx);
                }
                if (ts.isIdentifier(n)) {
                    const sym = checker.getSymbolAtLocation(n);          // import 绑定 = alias symbol
                    if (sym && (sym.flags & ts.SymbolFlags.Alias) && sym.declarations) {
                        const d0 = sym.declarations[0];
                        if (ts.isImportSpecifier(d0) || ts.isImportClause(d0)) {   // 具名 / 默认导入
                            const target = checker.getAliasedSymbol(sym);
                            // 无条件换新节点：即便同名，也须脱离 tsc 的模块绑定，否则 after 阶段
                            // 的模块 transform 会把它改写成 `(0, mod_1.x)`（内联后无 require）。
                            if (target && target.name) return ts.factory.createIdentifier(target.name);
                        }
                    }
                    return n;
                }
                if (ts.canHaveModifiers(n)) {
                    const mods = ts.getModifiers(n);
                    const EXP = ts.SyntaxKind.ExportKeyword, DEF = ts.SyntaxKind.DefaultKeyword;
                    if (mods && mods.some(m => m.kind === EXP || m.kind === DEF))
                        n = ts.factory.replaceModifiers(n, mods.filter(m => m.kind !== EXP && m.kind !== DEF));
                }
                return ts.visitEachChild(n, visit, ctx);
            };
            const out = ts.visitNode(sf2, visit);
            if (out) {   // 清掉「这是模块」的标记 → emit 不再生成 __esModule 包装
                out.externalModuleIndicator = undefined;
                if (typeof out.transformFlags === "number") out.transformFlags &= ~ts.TransformFlags.ContainsES2015Module;
            }
            return out;
        };
        const emitted = new Map();
        program.emit(undefined, (fname, text) => { emitted.set(fname, text); }, undefined, false, { before: [stripModuleSyntax] });
        for (const sf2 of sfs) {
            const text = emitted.get(sf2.fileName.replace(/\.ts$/, ".js"));
            if (text) interpJs += text + "\n";
        }
    }
    // interp 函数不占 wasm，故不参与「是否需要 tagged 运行时」的判定。
    const anyTagged = fns.some(f => !interpSet.has(f.name.text) && funcMode(f) === "tagged") || hasClasses;
    // 顶层函数名 → {mode, void}：跨模式调用点据此插入 f64↔i64 按位重解释。
    // interp 函数不进 wasm（其调用者经传递闭包一并退），故不在表内 —— 表内即 wasm 内可直调者。
    const fnMode = new Map();
    for (const st of fns) {
        if (interpSet.has(st.name.text)) continue;
        fnMode.set(st.name.text, {
            mode: funcMode(st),
            void: !!st.type && st.type.kind === ts.SyntaxKind.VoidKeyword,
        });
    }


    /* 单趟发射：对给定 module 走完「注册 → 声明 → 发射 body → 导出」。
     * 调两趟：① collect 模式**采出实际用到**的 qz.* 契约面（产物丢弃）；
     *         ② 按该子集注册后真发。
     * 为什么必须两趟：import 索引要在 declareFunc 之前定妥（funcidx = codeIdx +
     * imports.length），无法边发射边补登记。见 brain [[aot-generic-compiler-target]]：
     * import 面 = 需求驱动的最小契约面，不是 qzjs 私有 ABI 全集。 */
    const emitAll = (m, contract) => {
        const em = new Emitter(m);
        em.sf = sf;
        em.hoistedFns = hoistedFns;   // 顶层函数声明（其余函数声明按闭包处理）
        em.fieldMap = new Map([["__cls", 0], ...preNames.map((n, i) => [n, i + 1])]);   // 预登记字段表（与产物一起冻结）
        em.importAlias = importAlias;    // 跨文件 import 别名 → 目标顶层函数名
        em.nsAlias = nsAlias;            // 命名空间导入解析表
        em.classAlias = classAlias;      // 导入类本地名 → 目标类名
        em.fnMode = fnMode;              // 顶层函数名 → {mode, void}（跨模式调用 ABI 转换用）
        em.usesFreeze = usesFreeze;
        em.clsExprMap = clsExprMap;      // 类表达式节点 → 合成类名（声明处跳过初值求值）
        em.usesKeyOrder = usesKeyOrder;
        em.usesDynAcc = usesDynAcc;
        em.enums = enums;                // TS enum：编译期求值表（名字 → {fwd, rev}）
        em.modConstLit = modConstLit;    // 模块级字面量 const（计算属性名折叠用）
        em.protNameId = (n) => em._strId(n);

        em._fnParams = new Map();        // 顶层函数名 → 形参数量（调用点按 JS 元数语义补 undefined/截断）
        em._fnNodes = new Map();         // 顶层函数名 → 声明节点（rest 形参打包用）
        for (const st of fns) em._fnNodes.set(st.name.text, st);
        for (const st of fns) { em.fnNames.add(st.name.text); em._fnParams.set(st.name.text, st.parameters.length); }
        for (const local of importAlias.keys()) em.fnNames.add(local);   // 导入名也是「顶层函数」（排除闭包捕获误判）
        em.moduleGlobals = em.moduleGlobals || new Map();
        em._modObjKeys = modObjKeys;    // 模块级 const 的静态键序（对象字面量 + 已知 const 展开）
        em._inModInit = false;
        if (!m.collect) {
            if (opts.needMathFloor) m.importFn("qz", "math_floor", ["i32"], ["i32"]);
            if (contract) registerQz(m, contract);
        }
        if (anyTagged) {
            m.addMemory(640);                                // 40 MiB：bump arena [0,STR_BASE=16MiB) + 字面量段 [16MiB,40MiB)
            m.addGlobal("i32", STR_BUMP);                    // global0 = bump 堆（字符串/对象）
            m.addGlobal("i64", 0);                           // global1 = __err（异常值；0 = 无错）
            em.moduleGlobals = new Map();                    // 模块级变量名 → wasm 全局索引（i64 tagged，索引 2 起）
            em._modInitNames = new Set(modVars.map(v => v.name.text));
            for (const v of modVars) em.moduleGlobals.set(v.name.text, m.addGlobal("i64", 0));
            emitStringHelpers(m);
        }
        for (const st of fns) {
            if (interpSet.has(st.name.text)) continue;   // interp 函数不进 wasm
            const isVoid = !!st.type && st.type.kind === ts.SyntaxKind.VoidKeyword;
            const isNum = funcMode(st) === "num";
            const vt = isNum ? "f64" : "i64";   // num=f64；tagged=i64（NaN-box）
            m.declareFunc(st.name.text, st.parameters.map(() => vt), isVoid ? [] : [vt]);
        }
        // 阶段1.5：收集类（登记方法/构造器签名）——须在发射体前
        if (hasClasses) em.collectClasses(clsStmts);
        // 阶段1.5b：扫描 lambda（顶层函数体 + 类方法/构造器体 + 字段初值），登记 __lam_N 签名
        let lamSeq = 0;
        for (const st of fns) {
            if (interpSet.has(st.name.text)) continue;
            for (const lam of em._collectLambdas(st.body)) em.emitLambda(lam, lamSeq++);
        }
        for (const cname of em._classList) {
            const c = em.classes.get(cname);
            if (c.ctor) for (const lam of em._collectLambdas(c.ctor.body)) em.emitLambda(lam, lamSeq++);
            for (const mth of c.methods) for (const lam of em._collectLambdas(mth.node.body)) em.emitLambda(lam, lamSeq++);
            // 字段初值内的闭包（如 `getV = () => this.v`）**不**在此预登记：它们需要在构造器上下文里登记，
            // 才能把 `this`（ctor 的 local 0）纳入捕获集；否则 this 在闭包内为 undefined（运行时错）。
        }
        // 阶段2：逐个发射 body（顶层函数 + lambda + 类方法/构造器）
        for (const st of fns) { if (interpSet.has(st.name.text)) continue; em.sf = fnSf.get(st) || sf; em.emitFunc(st); }
        em.emitLambdaBodies();
        if (hasClasses) em.emitClassBodies();
        em.emitLambdaBodies();   // 类体发射期间惰性登记的闭包（对象字面量访问器/方法）
        for (const cname of em._classList) {
            const c = em.classes.get(cname);
            for (const mth of c.methods) { const en = methName(cname, mth.accessor === "set" ? mth.name + "$set" : mth.name); m.exportFn(en, en); }
            for (const sm of c.staticMethods) { const en = staticMethName(cname, sm.name + (sm.accessor === "set" ? "$set" : "")); m.exportFn(en, en); }
            m.exportFn(ctorName(cname), ctorName(cname));
        }
        if (m.memory !== null) m.exportMemory();
        if (anyTagged) {
            m.exportGlobal("__bump", m.globalIdx());
            m.exportGlobal("__err", 1);                       // 跨函数 throw 出口：glue 调用后检查，非 0 则向宿主抛出
            m.declareFunc("__set_err", ["i64"], []);          // 宿主侧抛出（如 reduce 空数组）：设 __err，调用点检查后转异常
            m.startBody("__set_err", []);
            m.localGet(0); m.globalSet(1);
            m.endBody();
            m.exportFn("__set_err", "__set_err");
            // __bump_reset()：把 bump 堆指针重置到起点。glue 在每次宿主 __call 前调用，
            // 使一次调用的 arena 占用与调用时长解耦（否则长循环累加耗尽 arena）。
            m.declareFunc("__bump_reset", [], []);
            m.startBody("__bump_reset", [], []);
            m.i32Const(STR_BUMP); m.globalSet(0);
            m.endBody();
            m.exportFn("__bump_reset", "__bump_reset");
        }
        em.emitLambdaBodies();                                // __module_init 体内惰性登记的闭包
        for (const meta of em._lamById.values()) m.exportFn(meta.fname, meta.fname);
        // 模块初始化**不再**放入 start 段：start 段执行时宿主 mem/导出/类元尚未绑定，
        // 任何模块级闭包调用（如 `const y = f(2)`）都会因 closure_call 读闭包头而崩。
        // 保持 __module_init 为普通导出，由宿主在各 bind 完成后调用（qzvm.js: tryRunModuleInit）。
        return em;
    };

    // 第一趟：采集实际用到的 qz.* 符号。总跑（非仅 tagged）——num 模式也可能
    // 调 qz.math_pow（** 运算）；不跑则 contract=null → registerQz 不执行 → import 未注册。
    const mc = new Module({ collectImports: true });
    emitAll(mc, null);
    let contract = mc.collected;
    // 第二趟：按采集到的子集注册契约面，真发产物。
    const m = new Module({ debug: !!opts.debug, debugLine: !!opts.debug || !!opts.debugLine, srcFile: input });
    const em = emitAll(m, contract);
    fs.writeFileSync(outWasm, m.build());
    // funcMeta: 每导出函数 {name, mode(num/tagged), params}
    const funcMeta = fns.map(f => ({
        name: f.name.text,
        mode: interpSet.has(f.name.text) ? "interp" : funcMode(f),   // interp = 不编 wasm，glue 走宿主 JS
        params: f.parameters.length,
    }));
    const lamMeta = {};
    for (const meta of em._lamById.values()) lamMeta[m._funcIdx[meta.fname]] = { name: meta.fname, n: meta.n, rest: !!meta.rest, synthThis: !!meta.synthThis };
    // classMeta[clsId] = { id, parent(parent的clsId), methods: {name: {name(导出名), n(参数量)}} }
    const classMeta = em._classList.map(cname => {
        const c = em.classes.get(cname);
        const methods = {}, getters = {}, setters = {}, staticMethods = {};
        for (const mth of c.methods) {
            if (mth.accessor === "set") setters[mth.name] = { name: methName(cname, mth.name + "$set"), n: mth.node.parameters.length };
            else if (mth.accessor === "get") getters[mth.name] = { name: methName(cname, mth.name), n: 0 };
            else methods[mth.name] = { name: methName(cname, mth.name), n: mth.node.parameters.length,
                                       rest: !!(mth.node.parameters.length && mth.node.parameters[mth.node.parameters.length - 1].dotDotDotToken) };
        }
        for (const smth of (c.staticMethods || [])) {
            if (smth.accessor) continue;   // 静态 getter/setter 走独立路径
            staticMethods[smth.name] = { name: staticMethName(cname, smth.name), n: smth.node.parameters.length };
        }
        const p = c.parent ? em.classes.get(c.parent) : null;

        return { id: c.id, name: cname, parent: p ? p.id : null, builtinParent: (c.parent && !p) ? c.parent : null, methods, getters, setters, staticMethods,
                 ctor: ctorName(cname), size: ((em.fieldMap ? em.fieldMap.size : 0) + 1) * 8 };   // 与 _instSize 一致（__cls + 字段）
    });
    return { module: m, strings: em.strings || [], fields: em.fieldMap ? [...em.fieldMap.keys()] : [], funcMeta, lamMeta, classMeta, interpJs };
}


// ================= tagged 模式发射（动态值：对象/字符串/unknown） =================
// 值恒 i64：数值 = 原始 f64 位型（NaN-box 的数值侧），句柄 = 高16位0x7FF9|低32 offset；
// 字段 8 字节。与宿主字长无关，32/64 位设备共用。
const _fbuf = Buffer.alloc(8);
function f64Bits(v) { _fbuf.writeDoubleLE(v); return [_fbuf.readUInt32LE(0), _fbuf.readUInt32LE(4)]; }   // [lo, hi]
// 计算属性名（类字段）编译期折叠：字面量 / 字面量拼接 / 模块级字面量 const / 括号 / as 断言。
// 无法求值 → null（调用点 loud，避免静默错名）。
Emitter.prototype._foldPropName = function (n) {
    const self = this;
    const fold = (x) => {
        if (x === undefined || x === null) return null;
        if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text;
        if (ts.isNumericLiteral(x)) return String(Number(x.text.replace(/_/g, "")));
        if (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isTypeAssertionExpression(x) || ts.isSatisfiesExpression(x)) return fold(x.expression);
        if (ts.isIdentifier(x)) { const v = self.modConstLit && self.modConstLit.get(x.text); return v === undefined ? null : String(v); }
        if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            const l = fold(x.left), r = fold(x.right);
            return (l === null || r === null) ? null : l + r;
        }
        return null;
    };
    return fold(n);
};
Emitter.prototype._fieldIndex = function (name) {
    if (!this.fieldMap) this.fieldMap = new Map();
    let i = this.fieldMap.get(name);
    if (i === undefined) { i = this.fieldMap.size; this.fieldMap.set(name, i); }
    return (i + 1) * 8;   // 字节偏移；偏移 0 保留给实例 __cls 头（类实例），字段从 8 起
};
// 程序内是否存在名为 name 的属性访问器（getter/setter）——决定属性读/写是否走宿主访问器分派。
// 名字是否为程序内某类的方法名（属性读命中时走宿主：实例原型方法 → 绑定函数；字段仍优先）
Emitter.prototype._hasMethodName = function (name) {
    if (!this._methodNames) {
        this._methodNames = new Set();
        for (const cname of this._classList) {
            const c = this.classes.get(cname);
            if (!c || !c.methods) continue;
            for (const m of c.methods) this._methodNames.add(m.name);
        }
    }
    return this._methodNames.has(name);
};
Emitter.prototype._hasAccessor = function (name, kind) {
    if (!this._accessorNames) {          // 惰性：首次使用时由已收集类汇总（编译期一次）
        this._accessorNames = { get: new Set(), set: new Set() };
        for (const cname of this._classList) {
            const c = this.classes.get(cname);
            if (!c || !c.methods) continue;
            for (const mth of c.methods) {
                if (mth.accessor === "get") this._accessorNames.get.add(mth.name);
                else if (mth.accessor === "set") this._accessorNames.set.add(mth.name);
            }
        }
    }
    return this._accessorNames[kind].has(name);
};
Emitter.prototype._strId = function (text) {
    let i = this.strings.indexOf(text);
    if (i < 0) { i = this.strings.length; this.strings.push(text); }
    return i;
};
// 可重入表达式临时槽：v/w（i64 受保护值）+ a/b/c（i32）+ x/y（i64 附加），按嵌套深度分层，
// 避免内层表达式（含 .length / 下标 / 拼接）覆盖外层正在使用的接收者/值。
Emitter.prototype._expEnter = function () {
    const d = this._expDepth || 0; this._expDepth = d + 1;
    if (!this.sT) return { v: 0, w: 0, x: 0, y: 0, z: 0, a: 0, b: 0, c: 0, d: 0 };
    return { v: this.objBase + 8 + d, w: this.objBase + 16 + d, x: this.objBase + 24 + d, y: this.objBase + 32 + d, z: this.objBase + 40 + d,   // 各 8 层（objPool 48 槽）
             a: this.sT[8 + 4 * d], b: this.sT[9 + 4 * d], c: this.sT[10 + 4 * d], d: this.sT[11 + 4 * d] };   // 各 8 层（sT 共 40 槽）
};
Emitter.prototype._expLeave = function () { this._expDepth--; };
// 类静态字段：C.x 前确保静态已初始化（lazy 内联初始值 → 宿主表 qz.static_set / statics_mark）。
Emitter.prototype._emitStaticsGuard = function (cname) {
    const c = this.classes.get(cname);
    const needsDynLink = !!(c && this._dynParentExpr(c));   // 动态父（mixin）即便无静态成员也须发链接
    if (!c || (!needsDynLink && !(c.staticFields || []).length && !(c.staticBlocks || []).length)) return;
    if (this._inStaticsGuard) return;                     // 守卫体内再访问同类静态 → 不再嵌套（避免无限展开）
    this._inStaticsGuard = true;
    try { this._emitStaticsGuardBody(c); } finally { this._inStaticsGuard = false; }
};
Emitter.prototype._emitStaticsGuardBody = function (c) {
    const cname = c.name;
    const M = this.m;
    const savedCCO = this._curClassObj, savedSM2 = this._inStaticMethod;
    this._curClassObj = c; this._inStaticMethod = true;   // static{} 内 this ≡ 定义类（_classOfExpr/_isClassName）
    { const dynN = this._dynParentExpr(c);              // 动态父（声明式类）：先链接运行时父链（宿主缓存，幂等）
      if (dynN) { this._emitClassValue(c); M.drop(); } }
    M.i32Const(this._strId(cname)); M.call("qz.statics_ready");
    M.i32Eqz();
    M.ifBlock("void");
    // 静态初始化按**源码序**（字段与 static 块交错；JS 语义：类定义时按序求值一次）
    for (const it of (c.staticInits || c.staticFields.map(f2 => ({ kind: "field", ...f2 })))) {
        if (it.kind === "field") {
            M.i32Const(this._strId(cname)); M.i32Const(this._strId(it.name));
            if (it.init) this.emitTaggedExpr(it.init); else this._emitUndefined();
            M.call("qz.static_set");
        } else {
            const savedSM = this._inStaticMethod; this._inStaticMethod = true;   // static {} 内 this ≡ 定义类（JS 语义）
            for (const st of it.blk.body.statements) this.emitTaggedStmt(st);
            this._inStaticMethod = savedSM;
        }
    }
    M.i32Const(this._strId(cname)); M.call("qz.statics_mark");
    M.end();
    this._curClassObj = savedCCO; this._inStaticMethod = savedSM2;
};
// 类名（标识符）是否为已收集的类
// 沿继承链找静态访问器（kind: "get"|"set"）→ { cname, acc }（静态属性读/写分派）
Emitter.prototype._findStaticAccessor = function (cn, name, kind) {
    let c = this.classes.get(cn);
    while (c) {
        const acc = (c.staticMethods || []).find(sm => sm.accessor === kind && sm.name === name);
        if (acc) return { cname: c.name, acc };
        c = c.parent ? this.classes.get(c.parent) : null;
    }
    return null;
};
// 类名判定：跳过括号 / as / 非空断言 / satisfies（(C as any).st ≡ C.st）；类名**作值**仍 loud
// 类名（含继承别名）解析：跳过括号/as/非空断言/satisfies；非类名 → null
Emitter.prototype._classOfExpr = function (node) {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
        || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
    if (node && ts.isThis(node) && this._inStaticMethod && this._curClassObj) return this._curClassObj.name;   // 静态方法内 this ≡ 类
    if (!node || !ts.isIdentifier(node)) return null;
    const cn = this._className(node.text);            // 类表达式别名（const C = class {…}）：typeof/静态访问要按别名解析
    return this.classes.has(cn) ? cn : null;
};
Emitter.prototype._isClassName = function (node) {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
        || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
    if (node && ts.isThis(node) && this._inStaticMethod && this._curClassObj) return true;   // 静态方法内 this ≡ 类
    return !!node && ts.isIdentifier(node) && this.classes.has(node.text);
};
// 字符串句柄 tag 测试：栈顶 i64 → i32（是字符串?）
Emitter.prototype._emitIsStr = function () {
    this.m.i64Const(48n); this.m.i64ShrU(); this.m.i64Const(0x7ffan); this.m.i64Eq();
};
// 字面量 → data 段 [len:i32][utf8]，返回偏移（句柄低32位）
Emitter.prototype._litOffset = function (text) {
    let off = this._litOff.get(text);
    if (off !== undefined) return off;
    off = (this._litCursor === undefined) ? STR_BASE : this._litCursor;
    const bytes = Buffer.from(text, "utf8");
    const head = Buffer.alloc(4); head.writeInt32LE(bytes.length, 0);
    this.m.addData(off, Buffer.concat([head, bytes]));
    this._litCursor = off + 4 + bytes.length;
    this._litOff.set(text, off);
    return off;
};
// 字面量句柄：0x7FFA<<48 | offset
Emitter.prototype._emitStrLitHandle = function (text) {
    this.m.i64ConstBits(this._litOffset(text), 0x7ffa0000);
};
// 字符串拼接：栈顶 [a, b]（i64）→ 结果句柄。
// a 字符串 → qzs_append(a, bytesOf(b))（b 数→numstr 到 SCRATCH；b 串→其字节）——热路径原地追加。
// a 数 + b 串 → qz.string_concat 回退（少见）；双数 → 原生 f64 add。
// 字符串累加器判定：x 的每次出现都只可能是 自身赋值目标 / 自身拼接左侧 / 只读属性访问（x.length、x.m()…）／
// 被追加的源（"a" + x）；此时其缓冲不会被别名引用 ⇒ 允许原地追加（累加循环 O(n)）。否则强制拷贝。
// 被闭包捕获的名字一律不算（可能别名）。
Emitter.prototype._strAccSetOf = function (body) {
    if (!body) return new Set();
    this._strAccCache = this._strAccCache || new WeakMap();
    if (this._strAccCache.has(body)) return this._strAccCache.get(body);
    const cand = new Set(), unsafe = new Set();
    const assignTarget = (n) => {                       // 该标识符所在（最近的）赋值语句的目标名
        let p = n;
        while (p) {
            if (ts.isBinaryExpression(p)) {
                const op = p.operatorToken.kind;
                if (op === ts.SyntaxKind.EqualsToken
                    || (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment)) {
                    return p.left && ts.isIdentifier(p.left) ? p.left.text : null;
                }
            }
            if (ts.isVariableDeclaration(p)) return ts.isIdentifier(p.name) ? p.name.text : null;
            if (ts.isStatement(p) || ts.isFunctionLike(p)) return null;
            p = p.parent;
        }
        return null;
    };
    const walk = (n) => {
        if (ts.isIdentifier(n)) {
            const nm = n.text, p = n.parent;
            if (p && ts.isBinaryExpression(p) && p.left === n) {
                const op = p.operatorToken.kind;
                if (op === ts.SyntaxKind.EqualsToken
                    || (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment)) {
                    cand.add(nm);                                   // x = … / x += …
                    return ts.forEachChild(n, walk);
                }
            }
            if (p && (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n) {
                /* 只读访问：x.length / x.charAt() → 安全 */
            } else if (p && ts.isVariableDeclaration(p) && p.name === n) {
                /* 声明 → 安全 */
            } else if (assignTarget(n) === nm) {
                /* 出现在「赋值给 x 的右侧」→ 安全（x = x + y 的累加模式） */
            } else {
                unsafe.add(nm);
            }
        }
        ts.forEachChild(n, walk);
    };
    walk(body);
    const out = new Set();
    for (const nm of cand) if (!unsafe.has(nm)) out.add(nm);
    this._strAccCache.set(body, out);
    return out;
};
// 拼接左操作数是否可原地追加
Emitter.prototype._concatSafe = function (leftNode) {
    if (!leftNode || !ts.isIdentifier(leftNode)) return true;              // 临时量（字面量/调用/嵌套拼接）→ 无别名
    const nm = leftNode.text;
    if (this.capMap && this.capMap.has(nm)) return false;                  // 闭包捕获 → 可能别名
    if (this._local(nm) === undefined) return true;                        // 非本层局部（如类静态表）→ 保守给 true? 否：未知来源按不安全处理
    const body = this._curBody;
    return body ? this._strAccSetOf(body).has(nm) : false;
};
Emitter.prototype._emitConcat = function (inPlace) {
    const saved = this._concatInPlace;
    if (inPlace !== undefined) this._concatInPlace = !!inPlace;   // GUARD 调用（无参）→ 沿用调用点已设的标志
    const M = this.m;
    M.localSet(this.scratchA); M.localSet(this.scratchB);   // a=scratchB, b=scratchA
    // 测试 pureNum：b 纯数 → numstr；否则宿主
    M.localGet(this.scratchB); this._emitIsStr();
    M.ifBlock("i64");
      M.localGet(this.scratchA); this._emitIsStr();
      M.ifBlock("i64");
        M.localGet(this.scratchA); this._emitStrParts();
        // 左操作数可能被别名引用（非私有累加器）→ 先复制一份再原地追加（JS 字符串不可变）
        M.localGet(this.scratchB); if (!this._concatInPlace) M.call("qz.str_dup"); M.i32WrapI64();
        M.localGet(this.sT[2]); M.localGet(this.sT[0]); M.call("qzs_append");
        this._strTag();
      M.else_();
        this._emitIsPureNum(this.scratchA);
        M.ifBlock("i64");
          // 整数（x==trunc(x)）且 |x|<2^53 → wasm qzs_numstr 快路径；
          // 否则（小数 0.5 / NaN / Infinity / 大数）→ 宿主 String 精确（numstr 仅整数，会截断 0.5→"0"）
          M.localGet(this.scratchA); M.f64ReinterpretI64(); M.localSet(this.scratchFA);
          M.localGet(this.scratchFA); M.f64Trunc(); M.localGet(this.scratchFA); M.f64Eq();
          M.localGet(this.scratchFA); M.f64Neg(); M.localGet(this.scratchFA); M.f64Max();
          M.f64Const(9007199254740992); M.f64Lt();
          M.i32And();
          M.ifBlock("i64");
            M.i32Const(SCRATCH); M.localGet(this.scratchA); M.f64ReinterpretI64(); M.i64TruncF64S(); M.call("qzs_numstr");
            M.drop();
            M.i32Const(SCRATCH); M.i32Load(2, 0); M.localSet(this.sT[0]);
            M.i32Const(SCRATCH + 4); M.localSet(this.sT[2]);
            M.localGet(this.scratchB); if (!this._concatInPlace) M.call("qz.str_dup"); M.i32WrapI64();   // 左操作数可能被别名引用 → 先私有副本（此前缺失 → 静默改到他处）
            M.localGet(this.sT[2]); M.localGet(this.sT[0]); M.call("qzs_append");
            this._strTag();
          M.else_();
            M.localGet(this.scratchB); M.localGet(this.scratchA); M.call("qz.string_concat");
          M.end();
        M.else_();
          M.localGet(this.scratchB); M.localGet(this.scratchA); M.call("qz.string_concat");
        M.end();
      M.end();
    M.else_();
      M.localGet(this.scratchA); this._emitIsStr();
      M.ifBlock("i64");
        M.localGet(this.scratchB); M.localGet(this.scratchA); M.call("qz.string_concat");
      M.else_();
        M.localGet(this.scratchB); M.localGet(this.scratchA); M.call("qz.add");
      M.end();
    M.end();
    this._concatInPlace = saved;
};
// 栈顶 i32 结构偏移 → i64 字符串句柄
Emitter.prototype._strTag = function () {
    this.m.i64ExtendI32U(); this.m.i64ConstBits(0, 0x7ffa0000); this.m.i64Or();
};
// 栈顶 i64（字符串句柄）→ 拆 sT0=len, sT1=off, sT2=bytesPtr
Emitter.prototype._emitStrParts = function () {
    this.m.i32WrapI64(); this.m.localSet(this.sT[1]);
    this.m.localGet(this.sT[1]); this.m.i32Load(2, 0); this.m.localSet(this.sT[0]);
    this.m.localGet(this.sT[1]); this.m.i32Const(4); this.m.i32Add(); this.m.localSet(this.sT[2]);
};
Emitter.prototype.emitTaggedBlock = function (node) { for (const st of node.statements) this.emitTaggedStmt(st); };
Emitter.prototype.emitTaggedStmt = function (s) {
    this.m.markLine(this._line(s));
    if (ts.isClassDeclaration(s) || ts.isFunctionDeclaration(s)) return;   // 已提升为模块级（见 collectDecls）
    if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) this._emitBindingDecl(d);
        return;
    }
    if (ts.isReturnStatement(s)) {   // 无值 return; → undefined（tagged 函数返回 i64，不能裸 return）
        if (this._finallyStack && this._finallyStack.length) {
            const t = this._expEnter();
            if (s.expression) this.emitTaggedExpr(s.expression); else this._emitUndefined();
            this.m.localSet(t.v);                    // 先求返回值（JS：先算表达式，再跑 finally）
            this._emitPendingFinally(true, false);
            this.m.localGet(t.v);
            this._expLeave();
        } else {
            if (s.expression) this.emitTaggedExpr(s.expression); else this._emitUndefined();
        }
        this.m.return_(); return; }
    if (ts.isBreakStatement(s)) { this._jumpOut(s.label && s.label.text, true); return; }
    if (ts.isContinueStatement(s)) { this._jumpOut(s.label && s.label.text, false); return; }
    if (ts.isDoStatement(s)) { this.emitDoWhile(s, true); return; }
    if (ts.isSwitchStatement(s)) { this.emitSwitch(s, true); return; }
    if (ts.isThrowStatement(s)) {
        if (this.mode !== "tagged") throw new Error("[num] throw 不支持（仅 tagged）");
        this.emitTaggedExpr(s.expression); this.m.globalSet(1);   // __err = 值
        if (!this._tryStack.length) {
            // 跨函数传播：本函数无 try → 跑完待执行 finally（异常离开函数）后 return undefined；
            // 调用方（try 内的调用点）检查 __err 并跳到其 catch。
            this._emitPendingFinally(true, false);
            if (!this._fnVoid) this._emitUndefined();
            this.m.return_();
            return;
        }
        this._emitPendingFinally(true, true);                     // 同函数内：穿出的 finally
        this.m.br(this.depth - this._tryStack[this._tryStack.length - 1].errBrk);
        return;
    }
    if (ts.isTryStatement(s)) { this.emitTry(s, true); return; }
    if (ts.isIfStatement(s)) {
        this.emitCondI32(s.expression !== undefined ? s.expression : s.condition);
        this.m.ifBlock(); this.depth++;          // 条件已归约为裸 i32 布尔
        this.emitTaggedStmt(s.thenStatement);
        if (s.elseStatement) { this.m.else_(); this.emitTaggedStmt(s.elseStatement); }
        this.depth--; this.m.end(); return;
    }
    if (ts.isWhileStatement(s)) {
        this.m.block(); this.depth++; this.m.loop(); this.depth++;
        this.labels.push({ brk: this.depth - 1, cont: this.depth, label: this._curLabel() });
        this.emitCondI32(s.expression !== undefined ? s.expression : s.condition);
        this.m.i32Eqz(); this.m.brIf(1);
        { const cap = this._loopCaptured([], s.statement || s);                                 // let/const 每迭代绑定
          if (cap) this._emitPerIterEnv(cap.headerNames, cap.bodyNames); }
        this.emitTaggedStmt(s.statement);
        this.m.br(0);
        this.labels.pop(); this.depth--; this.m.end(); this.depth--; this.m.end(); return;
    }
    if (ts.isForStatement(s)) {
        if (s.initializer) {
            if (ts.isVariableDeclarationList(s.initializer)) {
                for (const d of s.initializer.declarations) if (d.initializer) { this.emitTaggedExpr(d.initializer); this._emitVarStore(d.name.text, this.scratchB); this.m.drop(); }
            } else { this.emitTaggedExpr(s.initializer); this.m.drop(); }
        }
        // block(brk) loop block(cont) body end; incr; br 0 end end（continue 跳 incr 前）
        this.m.block(); this.depth++; this.m.loop(); this.depth++;
        if (s.condition) { this.emitCondI32(s.condition); this.m.i32Eqz(); this.m.brIf(1); }
        this.m.block(); this.depth++;
        this.labels.push({ brk: this.depth - 2, cont: this.depth, label: this._curLabel() });
        if (s.statement) this.emitTaggedStmt(s.statement);
        this.labels.pop();
        this.depth--; this.m.end();                       // end cont block
        { const neg = this._loopCaptured(this._headerNames(s), s.statement || s);               // for(let i…) 闭包捕获 → 增量前换新绑定
          if (neg) this._emitPerIterEnv(neg.headerNames, neg.bodyNames); }
        if (s.incrementor) { this.emitTaggedExpr(s.incrementor); this.m.drop(); }
        this.m.br(0);
        this.depth--; this.m.end();                       // end loop
        this.depth--; this.m.end(); return;               // end brk block
    }
    if (ts.isForInStatement(s)) {
        // for (k in o) → for (k of Object.keys(o))（复用 for-of 机制；键为字符串）
        const withPos = (n, p) => { n.pos = p.pos; n.end = p.end; return n; };
        const obj = withPos(ts.factory.createIdentifier("Object"), s.expression);
        const keysProp = withPos(ts.factory.createPropertyAccessExpression(obj, "keysIn"), s.expression);   // keysIn：自有+继承可枚举键（JS for-in 语义）
        const keysCall = withPos(ts.factory.createCallExpression(keysProp, undefined, [s.expression]), s.expression);
        const forOf = withPos(ts.factory.createForOfStatement(undefined, s.initializer, keysCall, s.statement), s);
        this.emitTaggedStmt(forOf);
        return;
    }
    if (ts.isForOfStatement(s)) {
        // for (let x of arr) body：惰性迭代（JS 语义）——wasm 数组按索引直读（长度每轮重读，
        // 迭代期间 push/delete 可见）；字符串经 str_chars 转码点数组；其它可迭代（Set/Map/
        // 自定义迭代器/迭代器对象）走 iter_new/iter_pull/iter_val（逐个 next()）；正常完成与
        // break 时对宿主迭代器调用 iter_close（JS 迭代协议要求关闭）。
        // 结构：block(brk) loop [cond→done flag; brIf(brk→close)] block(cont) body end cont br(0→loop)
        //        end loop [close-on-completion] end brk。
        const M = this.m;
        if (!ts.isVariableDeclarationList(s.initializer) || s.initializer.declarations.length !== 1)
            throw new Error("[tagged] for-of 仅支持 let x of arr / let [a,b] of arr");
        const bindName = s.initializer.declarations[0].name;
        if (ts.isIdentifier(bindName) && this._local(bindName.text) === undefined) throw new Error("未定义 for-of 变量");
        const arrL = this.forOfBase + this.forOfCount * 3;       // 本层迭代目标 local（i64）
        const idxL = arrL + 1;                                   // 本层索引 local（仅数组模式用）
        const lenL = arrL + 2;                                   // 占位（保留以不破坏 forOfBase 步长）
        void lenL;
        this.forOfCount++;
        this.emitTaggedExpr(s.expression); M.localSet(arrL);     // 迭代目标（i64）
        // 字符串 → 码点字符数组（for…of 按码点迭代："😀".length=2 但迭代 1 次）
        M.localGet(arrL); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffan); M.i64Eq();
        M.ifBlock("void");
        M.localGet(arrL); M.call("qz.str_chars"); M.localSet(arrL);              // 字符串 → 码点数组
        M.end();
        // 非 wasm 数组（宿主可迭代）→ 建立宿主迭代器（惰性逐次 next()）
        M.localGet(arrL); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
        M.i32Eqz();
        M.ifBlock("void");
        M.localGet(arrL); M.call("qz.iter_new"); M.localSet(arrL);
        M.end();
        M.i32Const(0); M.localSet(idxL);                         // i = 0（数组模式）
        M.block(); this.depth++; M.loop(); this.depth++;
        // 条件：数组模式 = idx >= 本轮长度（live）；宿主模式 = iter_pull 返回 done（!=0）
        //   两分支统一为 i32 done-flag；if/else 结束后单一 brIf(1)（br 1 = brk → 经 close 退出）
        M.localGet(arrL); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
        M.ifBlock("i32");
        M.localGet(idxL);
        this._emitLengthOf(arrL); M.f64ReinterpretI64(); M.i32TruncF64S();
        M.i32GeS();                                             // idx >= len → 1（done）
        M.else_();
        M.localGet(arrL); M.call("qz.iter_pull"); M.i64Const(0n); M.i64Ne();    // done flag = (pull != 0)
        M.end();
        M.brIf(1);                                              // done → 退出循环（→ close）
        M.block(); this.depth++;
        this.labels.push({ brk: this.depth - 2, cont: this.depth, label: this._curLabel() });
        // 元素：wasm 数组(0x7FFB) → 内存 dataOff + idx*8（并 idx++）；宿主迭代器 → iter_val
        { const cap = this._loopCaptured(this._headerNames(s), s.statement || s);              // let/const 每迭代绑定
          if (cap) this._emitPerIterEnv(cap.headerNames, cap.bodyNames); }
        M.localGet(arrL); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
        M.ifBlock("i64");
        M.localGet(arrL); M.i32WrapI64(); M.i32Load(2, 8);       // dataOff
        M.localGet(idxL); M.i32Const(8); M.i32Mul(); M.i32Add(); // dataOff + idx*8
        M.i64Load(3, 0);                                         // 元素（i64）
        M.localGet(idxL); M.i32Const(1); M.i32Add(); M.localSet(idxL);   // i++（下一轮）
        M.else_();
        M.localGet(arrL); M.call("qz.iter_val");                // 宿主迭代器当前值（i64）
        M.end();
        if (ts.isIdentifier(bindName)) {
            this._emitVarStore(bindName.text, this.scratchB); this.m.drop();     // x = arr[i]（被捕获则写 env）
        } else {
            const tb = this._expEnter();
            M.localSet(tb.v);
            this._emitDestructurePattern(bindName, tb.v);                       // let [k,v] of …
            this._expLeave();
        }
        if (s.statement) this.emitTaggedStmt(s.statement);
        this.labels.pop();
        this.depth--; M.end();                                  // end cont
        M.br(0);                                                // 下一轮（→ loop 头 → 条件）
        this.depth--; M.end();                                  // end loop
        // 正常完成 / break：宿主迭代器 → iter_close（JS 迭代协议）；数组模式（0x7FFB）无操作
        M.localGet(arrL); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
        M.ifBlock("void");
        M.else_();
        M.localGet(arrL); M.call("qz.iter_close");
        M.end();
        this.depth--; M.end();                                  // end brk
        this.forOfCount--;
        return;
    }
    if (ts.isLabeledStatement(s)) {
        if (ts.isIterationStatement(s.statement, false)) { this._labelStack.push(s.label.text); this.emitTaggedStmt(s.statement); return; }
        this.m.block("void"); this.depth++;                       // 非循环标签块：break label → 跳到块尾
        this.labels.push({ brk: this.depth, cont: null, label: s.label.text });
        this.emitTaggedStmt(s.statement);
        this.labels.pop();
        this.depth--; this.m.end();
        return;
    }
    if (ts.isBlock(s)) {
        if (this._shadowBlocks && this._shadowBlocks.has(s)) {
            const M0 = this.m, saved = [];
            let n0 = 0;
            for (const st of s.statements) {
                if (!ts.isVariableStatement(st)) continue;
                for (const d of st.declarationList.declarations) {
                    const nm = ts.isIdentifier(d.name) ? d.name.text : null;
                    if (!nm) continue;
                    const li = this._local(nm);                       // 外层同名局部
                    const slot = this._local("$sh" + n0);              // 保存槽（本函数 i64 值局部）
                    if (li === undefined || slot === undefined) continue;
                    n0++;
                    M0.localGet(li); M0.localSet(slot);
                    saved.push([li, slot]);
                }
            }
            this.emitTaggedBlock(s);
            for (let i = saved.length - 1; i >= 0; i--) { M0.localGet(saved[i][1]); M0.localSet(saved[i][0]); }   // 恢复外层绑定（块级 let/const 遮蔽）
            return;
        }
        this.emitTaggedBlock(s); return;
    }
    if (ts.isExpressionStatement(s)) {
        // console.log(x) → qz.log（边界输出）
        const ex = s.expression;
        if (ts.isCallExpression(ex) && ts.isPropertyAccessExpression(ex.expression) && ex.expression.expression.text === "console") {
            for (const a of ex.arguments) { this.emitTaggedExpr(a); this.m.call("qz.log"); }
            return;
        }
        if (ts.isCallExpression(ex) && ts.isSuperKeyword(ex.expression)) { this.emitTaggedExpr(ex); return; }
        this.emitTaggedExpr(ex); this.m.drop(); return;
    }
    if (ts.isEmptyStatement(s)) return;
    if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isModuleDeclaration(s)
        || s.kind === ts.SyntaxKind.ImportDeclaration || s.kind === ts.SyntaxKind.ExportDeclaration) return;   // TS 类型层/导入导出：擦除
    throw new Error("[tagged] 不支持的语句: " + ts.SyntaxKind[s.kind]);
};
// try/catch/finally：__err(global1) + 结构化 br。
//   block $done → block $err → <try> → br $done | end $err → <catch> → end $done → <finally>
// throw 跳 $err 后（catch）；正常跳 $done 后（跳过 catch）。finally 两路都会执行。
Emitter.prototype.emitTry = function (s, tagged) {
    const M = this.m;
    const fin = s.finallyBlock;
    const finTok = fin ? {} : null;                // 该 try 的身份令牌（throw 时判断此 finally 是否已被「自然流」负责）
    if (fin) { this._finallyStack = this._finallyStack || []; this._finallyStack.push({ node: fin, tok: finTok, labelsLen: (this.labels || []).length, tryDepth: (this._tryStack || []).length }); }
    M.block(); this.depth++;                       // $done
    M.block(); this.depth++;                       // $err
    this._tryStack.push({ errBrk: this.depth, tok: finTok });   // 记录 $err 相对深度（throw 用）
    M.i64Const(0n); M.globalSet(1);                              // 进入 try：清 __err
    if (tagged) this.emitTaggedBlock(s.tryBlock); else this.emitBlock(s.tryBlock);
    M.br(this.depth - (this.depth - 1));           // 正常 → 跳 $done 后（跳过 catch）
    this._tryStack.pop();
    this.depth--; M.end();                         // end $err → catch 入口
    const c = s.catchClause;
    if (c) {
        const cv = c.variableDeclaration && c.variableDeclaration.name;
        if (cv && ts.isIdentifier(cv)) {
            const idx = this._local(cv.text);
            if (idx !== undefined) { M.globalGet(1); M.localSet(idx); }   // catch 变量 = __err
        } else if (cv) {
            // catch 解构（{a, b} / [x, y]）：从 __err 读出各分量并绑定（此前静默不绑定 → 全 0）
            const t = this._expEnter();
            M.globalGet(1); M.localSet(t.x);
            if (ts.isObjectBindingPattern(cv)) {
                for (const el of cv.elements) {
                    if (!ts.isIdentifier(el.name)) throw new Error("[tagged] catch 对象解构仅支持标识符（含改名）");
                    if (el.dotDotDotToken) throw new Error("[tagged] catch 解构暂不支持 rest");
                    if (el.initializer) throw new Error("[tagged] catch 解构暂不支持默认值");
                    const key = ts.isIdentifier(el.propertyName || el.name) ? (el.propertyName || el.name).text : null;
                    if (key === null) throw new Error("[tagged] catch 解构键必须为标识符");
                    this._emitPropReadFromLocal(t.x, key);
                    const idx = this._local(el.name.text);
                    if (idx !== undefined) M.localSet(idx); else M.drop();
                }
            } else if (ts.isArrayBindingPattern(cv)) {
                let i = 0;
                for (const el of cv.elements) {
                    if (ts.isOmittedExpression(el)) { i++; continue; }
                    if (!ts.isIdentifier(el.name)) throw new Error("[tagged] catch 数组解构仅支持标识符");
                    if (el.initializer) throw new Error("[tagged] catch 解构暂不支持默认值");
                    this._emitElemOf(t.x, ts.factory.createNumericLiteral(i));
                    const idx = this._local(el.name.text);
                    if (idx !== undefined) M.localSet(idx); else M.drop();
                    i++;
                }
            } else {
                throw new Error("[tagged] 不支持的 catch 绑定模式");
            }
            this._expLeave();
        }
        M.i64Const(0n); M.globalSet(1);                          // catch 入口即清 __err（否则 catch 体内调用点的 err 检查会重复触发）
        if (tagged) this.emitTaggedBlock(c.block); else this.emitBlock(c.block);
        M.i64Const(0n); M.globalSet(1);                          // catch 处理完：清 __err
    }
    this.depth--; M.end();                         // end $done
    if (fin) {
        this._finallyStack.pop();
        if (tagged) this.emitTaggedBlock(fin); else this.emitBlock(fin);
        if (!c) this._emitErrCheck(false);         // try-finally（无 catch）：finally 后必须重新抛出
    }
};
// 运行待执行 finally 块（return/throw 鳚出 try 时由 JS 语义要求；最内层先跑）
Emitter.prototype._emitPendingFinally = function (tagged, forThrow) {
    const st = this._finallyStack;
    if (!st || !st.length) return;
    // throw：目标 catch = 最内层仍在 tryStack 的 try。只运行**位于其内部**的 finally
    // （入栈深度 >= 当前 tryStack 长度）；目标 try 自己的 finally 由其 catch 之后的正常路径负责。
    const curDepth = (this._tryStack || []).length;
    for (let i = st.length - 1; i >= 0; i--) {
        const e = st[i];
        if (forThrow && ((e.tryDepth === undefined ? -1 : e.tryDepth) < curDepth)) continue;   // 目标及其外层：不在此跑
        this._finallyStack = st.slice(0, i);        // 防重入：finally 体内的 return/throw 不再重复跑本层
        if (tagged) this.emitTaggedBlock(e.node); else this.emitBlock(e.node);
    }
    this._finallyStack = st;
};

// switch：entry-index 方案。先算入口 clause 序号（无匹配→default，无 default→len），
// 再按源码序遍历，swIdx<=i 激活（fallthrough 天然正确，default 位置无关）。break → 外层 block。
Emitter.prototype.emitSwitch = function (s, tagged) {
    const M = this.m;
    const clauses = s.caseBlock.clauses;
    let defaultIdx = clauses.findIndex(c => ts.isDefaultClause(c));
    if (defaultIdx < 0) defaultIdx = clauses.length;
    M.block(); this.depth++;
    this.labels.push({ brk: this.depth, cont: null, label: this._curLabel() });
    if (tagged) this.emitTaggedExpr(s.expression); else this.emitExpr(s.expression);
    M.localSet(this.scratch);
    M.i32Const(defaultIdx); M.localSet(this.swIdx);
    // scan：首个 disc===caseVal → entry=i 并跳出（br 1 出 scan block）；全不匹配保持 defaultIdx。
    M.block(); this.depth++;
    for (let i = 0; i < clauses.length; i++) {
        const c = clauses[i];
        if (ts.isDefaultClause(c)) continue;
        M.localGet(this.scratch);
        if (tagged) { this.emitTaggedExpr(c.expression); M.call("qz.seq"); M.call("qz.truthy"); }
        else { this.emitExpr(c.expression); M.f64Eq(); }
        M.ifBlock(); this.depth++;
        M.i32Const(i); M.localSet(this.swIdx);
        M.br(1);
        M.end(); this.depth--;
    }
    this.depth--; M.end();                                  // end scan
    for (let i = 0; i < clauses.length; i++) {                          // 源码序执行（fallthrough）
        M.localGet(this.swIdx); M.i32Const(i); M.i32LeS();
        M.ifBlock(); this.depth++;
        for (const st of clauses[i].statements) { if (tagged) this.emitTaggedStmt(st); else this.emitStmt(st); }
        M.end(); this.depth--;
    }
    this.labels.pop();
    this.depth--; M.end();
};
Emitter.prototype.emitTaggedExpr = function (e) {
    if (ts.isNumericLiteral(e)) {
        this.m.i64ConstBits(...f64Bits(Number(e.text)));   // 数值 = 原始 f64 位型
        return;
    }
    if (ts.isStringLiteral(e)) { this._emitStrLitHandle(e.text); return; }
    if (ts.isNoSubstitutionTemplateLiteral(e)) { this._emitStrLitHandle(e.text); return; }
    if (e.kind === ts.SyntaxKind.TrueKeyword) { this.m.i64ConstBits(1, 0x7ffc0000); return; }   // tagged bool 0x7FFC|1（非 f64 1.0：bool 与 number 须区分）
    if (e.kind === ts.SyntaxKind.FalseKeyword) { this.m.i64ConstBits(0, 0x7ffc0000); return; }  // 0x7FFC|0
    if (e.kind === ts.SyntaxKind.NullKeyword) { this._emitNull(); return; }              // 0x7FF9|1（固定 null 槽；区别于 undefined 的 |0）
    if (ts.isIdentifier(e) && e.text === "undefined") { this._emitUndefined(); return; } // 0x7FF9|0
    if (ts.isTemplateExpression(e)) {
        // `head${e1}lit1${e2}lit2…`：逐段 _emitConcat（栈 [a,b]→句柄）。空段字面量为空串。
        this._emitStrLitHandle(e.head.text);
        for (const span of e.templateSpans) {
            this.emitTaggedExpr(span.expression);
            this.m.call("qz.to_string");     // 模板内插值 = ToString（string hint），不是 ToPrimitive(default)
            this._emitConcat();
            this._emitStrLitHandle(span.literal ? span.literal.text : "");
            this._emitConcat();
        }
        return;
    }
    if (ts.isThis(e)) {
        if (this.capMap.has("this")) { this._emitCapturedRead("this"); return; }   // 方法内闭包捕获 this → 经 env
        if (this._lamThisParam) { this._emitUndefined(); return; }   // 该函数声明了 this 形参（TS 注解）→ 运行时 this = undefined
        if (this._inStaticMethod && this._curClassObj) {          // 静态方法/static{} 内 this ≡ 定义类（JS 语义）
            this.m.i32Const(this._curClassObj.id); this.m.call("qz.class_value"); return;
        }
        const idx = this._local("this");
        if (idx === undefined) throw new Error("[tagged] this 仅在类方法/构造器内可用");
        this.m.localGet(idx); return;
    }
    if (ts.isTaggedTemplateExpression(e)) {
        // tag`a${1}b`：构造字面量数组 [a, b]（含 raw 省略）+ 值 1 → closure_call(tag, arr, a0, a1, a2)
        const M = this.m, t = this._expEnter();
        // rawOf：从模板字面量节点取源码原文（去定界符）——String.raw 与用户标签共用
        const rawOf = (lit) => {
            let txt = lit.getText();
            if (txt.startsWith("`") || txt.startsWith("}")) txt = txt.slice(1);
            if (txt.endsWith("${")) txt = txt.slice(0, -2);
            else if (txt.endsWith("`")) txt = txt.slice(0, -1);
            return txt;
        };
        // String.raw`…`：raw 文本 = 各段源码原文（去定界符）→ 直接按 ToString 拼接（无需 strings.raw 表）
        if (ts.isPropertyAccessExpression(e.tag) && ts.isIdentifier(e.tag.expression) && e.tag.expression.text === "String" && e.tag.name.text === "raw") {
            const noSub = ts.isNoSubstitutionTemplateLiteral(e.template);
            const spans = noSub ? [] : e.template.templateSpans;
            this._emitStrLitHandle(noSub ? rawOf(e.template) : rawOf(e.template.head));   // 首段 raw
            for (const sp of spans) {
                this.emitTaggedExpr(sp.expression);
                M.call("qz.to_string");                                  // ToString（string hint）
                this._emitConcat();
                this._emitStrLitHandle(rawOf(sp.literal));
                this._emitConcat();
            }
            this._expLeave();
            return;
        }
        const noSub0 = ts.isNoSubstitutionTemplateLiteral(e.template);
        // 标签为**已知形参**的函数（本作用域函数声明/闭包）→ 按形参表落栈（rest 打包 / 元数补齐；否则 rest 形参会拿到非数组）
        const tagName0 = ts.isIdentifier(e.tag) ? e.tag.text : null;
        const cp0 = tagName0 ? (this._calleeParams(tagName0) || null) : null;
        if (cp0 && cp0.length) {
            const parts0 = [ts.factory.createStringLiteral(noSub0 ? e.template.text : e.template.head.text)]
                .concat((noSub0 ? [] : e.template.templateSpans).map(sp => ts.factory.createStringLiteral(sp.literal.text)));
            const lit0 = ts.factory.createArrayLiteralExpression(parts0);
            lit0.pos = e.pos; lit0.end = e.end;
            const argNodes = [lit0].concat((noSub0 ? [] : e.template.templateSpans).map(sp => sp.expression));
            // raw strings 数组 → tagged_strings(cooked, raw) → 带 .raw 的 strings 对象
            const rawParts0 = [ts.factory.createStringLiteral(noSub0 ? rawOf(e.template) : rawOf(e.template.head))]
                .concat((noSub0 ? [] : e.template.templateSpans).map(sp => ts.factory.createStringLiteral(rawOf(sp.literal))));
            const rawLit0 = ts.factory.createArrayLiteralExpression(rawParts0);
            rawLit0.pos = e.pos; rawLit0.end = e.end;
            const tStrings = this._expEnter();
            this.emitTaggedExpr(lit0); this.emitTaggedExpr(rawLit0); M.call("qz.tagged_strings"); M.localSet(tStrings.v);
            this._expLeave();
            // 顶层函数标签：无闭包句柄 → 直接 wasm 调用（否则会误走「未定义捕获变量」）
            if (tagName0 && this.fnNames && this.fnNames.has(tagName0) && this._local(tagName0) === undefined
                && !(this.capMap && this.capMap.has(tagName0))
                && !(this.moduleGlobals && this.moduleGlobals.get(tagName0) !== undefined)) {
                M.localGet(tStrings.v);
                this._emitCallArgs(cp0.slice(1), argNodes.slice(1), tagName0, false);   // 其余按形参表（rest 打包；直接调用无 ovf）
                M.call(tagName0);
                this._emitErrCheck();
                this._expLeave();
                return;
            }
            this.emitTaggedExpr(e.tag); M.localSet(t.v);
            M.localGet(t.v);
            M.localGet(tStrings.v);                                   // 第 1 参：strings 对象（含 .raw）
            this._emitCallArgs(cp0.slice(1), argNodes.slice(1), tagName0, true);   // 其余按形参表（rest 打包/元数补齐）
            const pushed = 1 + (cp0.length > 4 ? 3 : cp0.length - 1);
            for (let i = pushed; i < 4; i++) this._emitUndefined();
            if (cp0.length > 4) {                                    // 第 6 参：溢出实参数组
                const ovfT = ts.factory.createArrayLiteralExpression(argNodes.slice(3));
                ovfT.pos = e.pos; ovfT.end = e.end;
                this.emitTaggedExpr(ovfT);
            } else this._emitUndefined();
            this._emitUndefined();                    // recv（普通调用 = undefined）
            M.call("qz.call_value");
            this._emitErrCheck();
            this._expLeave();
            return;
        }
        this.emitTaggedExpr(e.tag); M.localSet(t.v);                       // 标签（闭包句柄）
        const noSub = ts.isNoSubstitutionTemplateLiteral(e.template);
        const spans = noSub ? [] : e.template.templateSpans;
        const parts = [ts.factory.createStringLiteral(noSub ? e.template.text : e.template.head.text)]
            .concat(spans.map(sp => ts.factory.createStringLiteral(sp.literal.text)));
        const lit = ts.factory.createArrayLiteralExpression(parts);
        lit.pos = e.pos; lit.end = e.end;
        const rawParts = [ts.factory.createStringLiteral(noSub ? rawOf(e.template) : rawOf(e.template.head))]
            .concat(spans.map(sp => ts.factory.createStringLiteral(rawOf(sp.literal))));
        const rawLit = ts.factory.createArrayLiteralExpression(rawParts);
        rawLit.pos = e.pos; rawLit.end = e.end;
        this.emitTaggedExpr(lit); this.emitTaggedExpr(rawLit); M.call("qz.tagged_strings"); M.localSet(t.w);   // strings = {cooked..., raw}
        M.localGet(t.v); M.localGet(t.w);
        for (let i = 0; i < 3; i++) {
            if (i < spans.length) this.emitTaggedExpr(spans[i].expression);
            else this._emitUndefined();
        }
        this._emitUndefined();   // 第 6 参（ovf）
        this._emitUndefined();   // 第 7 参（recv；普通调用 = undefined）
        M.call("qz.call_value");
        this._emitErrCheck();
        this._expLeave();
        return;
    }
    if (ts.isRegularExpressionLiteral(e)) {
        this.m.i32Const(this._strId(e.text));        // 含定界符与 flags 的原文（宿主解析）
        this.m.call("qz.regex");
        return;
    }
    if (ts.isIdentifier(e)) {
        if (e.text === "arguments") throw new Error("[tagged] `arguments` 对象未实现（建议 rest 形参）；闭包/方法/顶层函数内的 `arguments` 均需 ABI 透传实参，属已知 loud——见 ASSESSMENT");
        if (this.capMap.has(e.text)) { this._emitCapturedRead(e.text); return; }   // 捕获名优先走 env（与本体共享）
        const idx = this._local(e.text);
        if (idx !== undefined) { this.m.localGet(idx); return; }
        // 数值全局常量（无需 import）：NaN/Infinity
        if (e.text === "NaN") { this.m.i64ConstBits(...f64Bits(NaN)); return; }
        if (e.text === "Infinity") { this.m.i64ConstBits(...f64Bits(Infinity)); return; }
        {   // 类名作值 → 宿主构造器对象句柄（prototype 链/静态方法）；new C(...) 仍走专用路径
            const cnV = this._className(e.text) || (this.classes.has(e.text) ? e.text : undefined);   // 闭包内 _className 可能失配 → 兜底按原名查类
            const cV = cnV && this.classes.get(cnV);
            if (cV) { this._emitClassValue(cV); return; }
        }
        this._emitCapturedRead(e.text); return;
    }
    if (ts.isClassExpression(e)) {                       // 类表达式作值 → 宿主构造器对象句柄（class_value）
        const synth = this.clsExprMap && this.clsExprMap.get(e);
        const cnC = synth && this.classes.get(synth);
        if (cnC) { this._emitClassValue(cnC); return; }
        throw new Error("[tagged] 类表达式作值未实现");
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) { this._emitLambdaNew(e); return; }
    if (ts.isParenthesizedExpression(e)) { this.emitTaggedExpr(e.expression); return; }
    // 纯类型层构造（运行时恒等，TS 会在 emit 前擦除）→ 直接透传：
    // `as T` / `x!` / `e satisfies T` / 尖括号断言 `<T>e`。
    if (ts.isAsExpression(e) || ts.isNonNullExpression(e)
        || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) { this.emitTaggedExpr(e.expression); return; }
    if (ts.isTypeOfExpression(e)) {
        // 内联分类：0x7FFA→"string"；0x7FFB→"object"；
        //   0x7FF9|0→"undefined"（_emitUndefined 的 null/undefined 统一句柄）；0x7FF9|≠0→"object"；
        //   0x7FFC→"boolean"；其余→"number"。
        //   注：0x7FF9 低 32 位对「宿主 handles 索引」与「POJO 内存 offset」同空间，
        //   function 值落此分支也得 "object"（JS 应为 "function"）——已知限制（函数作值少见）。
        const M = this.m;
        if (ts.isIdentifier(e.expression)
            && (this.fnNames.has(e.expression.text) || (this._fnVars && this._fnVars.has(e.expression.text)))) {
            this._emitStrLitHandle("function");   // 函数值（顶层函数名 / 持有闭包的变量）
            return;
        }
        if (this._classOfExpr(e.expression) !== null || ts.isClassExpression(e.expression)) {
            this._emitStrLitHandle("function");   // typeof <类名>/<类表达式> → "function"（class 是函数对象）
            return;
        }
        // 内建全局：typeof Math/JSON → "object"；typeof Symbol/parseInt/… → "function"（JS 语义，免宿主调用）
        if (ts.isIdentifier(e.expression) && BUILTIN_GLOBALS.has(e.expression.text)) {
            const isObj = /^(Math|JSON|Reflect)$/.test(e.expression.text);
            this._emitStrLitHandle(isObj ? "object" : "function");
            return;
        }
        this.emitTaggedExpr(e.expression); M.localSet(this.scratch);
        M.block("i64");
        // 宿主值（0x7FFD）：可能是 JS 函数（对象字面量方法 / 宿主回调）→ 由宿主判定
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffdn); M.i64Eq();
        M.ifBlock("i64");
        M.localGet(this.scratch); M.call("qz.typeof_host");
        M.ifBlock("i64");
        this._emitStrLitHandle("function");
        M.else_();
        M.localGet(this.scratch); M.call("qz.is_symbol_host");
        M.ifBlock("i64");
        this._emitStrLitHandle("symbol");
        M.else_();
        this._emitStrLitHandle("object");
        M.end();
        M.end();
        M.else_();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7fffn); M.i64Eq();
        M.ifBlock("i64");
        this._emitStrLitHandle("function");   // 闭包值（函数）
        M.else_();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffan); M.i64Eq();
        M.ifBlock("i64");
        this._emitStrLitHandle("string");
        M.else_();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ff9n); M.i64Eq();
        M.i32Or();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffen); M.i64Eq();   // 类实例 → "object"
        M.i32Or();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffdn); M.i64Eq();   // 宿主对象 → "object"
        M.i32Or();
        M.ifBlock("i64");
        // 0x7FF9|0 → "undefined"（null 亦映射 0x7FF9|0；JS typeof null="object" —— null 字面量
        // 由 emitTaggedExpr 直接产 0x7FF9|0，与 undefined 同表示，故 null 也报 "undefined"。
        // 已知限制：null/undefined 句柄不区分（表示层统一），typeof 优先报 "undefined"。）
        M.localGet(this.scratch); M.i64Const(0xffff_ffffn); M.i64And(); M.i64Eqz();
        M.ifBlock("i64");
        this._emitStrLitHandle("undefined");
        M.else_();
        this._emitStrLitHandle("object");
        M.end();
        M.else_();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffcn); M.i64Eq();
        M.ifBlock("i64");
        this._emitStrLitHandle("boolean");
        M.else_();
        this._emitStrLitHandle("number");
        M.end(); M.end(); M.end();   // 关 ifBool / ifObj / ifStr
        M.end();                     // 关 ifClo
        M.end();                     // 关 ifHost 外层
        M.end();                     // 关 block(i64)
        return;
    }
    if (ts.isObjectLiteralExpression(e)
        && e.properties.some(p => ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p))) {
        // 含方法/访问器的对象字面量也支持展开：按源码序用 qz.obj_merge 就地并入（宿主对象目标）
        // 宿主对象(0x7FFD)：方法 → 闭包包装值；访问器 → defineProperty(get/set 回调 wasm 闭包)。
        const M = this.m, t = this._expEnter();
        M.call("qz.obj_new"); M.localSet(t.v);
        const doneA = new Set();
        for (const p of e.properties) {
            const nm = p.name && p.name.text;
            if (ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name)) {   // 计算键：运行期键 → qz.set_index
                M.localGet(t.v);
                this.emitTaggedExpr(p.name.expression);
                this.emitTaggedExpr(p.initializer);
                M.call("qz.set_index");
            } else if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
                M.localGet(t.v); M.i32Const(this._strId(nm));
                this.emitTaggedExpr(ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer);
                M.call("qz.object_set");
            } else if (ts.isSpreadAssignment(p)) {
                M.localGet(t.v);
                this.emitTaggedExpr(p.expression);
                M.call("qz.obj_merge");
            } else if (ts.isMethodDeclaration(p)) {
                if (nm !== undefined) {                                   // 字符串名
                    M.localGet(t.v); M.i32Const(this._strId(nm));
                    this.emitTaggedExpr(this._memberLambda(p));
                    M.call("qz.object_set_method");
                } else if (p.name && ts.isComputedPropertyName(p.name)) { // 计算键名（Symbol.iterator 等）
                    M.localGet(t.v); this.emitTaggedExpr(p.name.expression);
                    this.emitTaggedExpr(this._memberLambda(p));
                    M.call("qz.object_set_method_key");
                } else throw new Error("[tagged] 对象字面量方法名不支持");
            } else if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
                if (doneA.has(nm)) continue;
                doneA.add(nm);
                const g = e.properties.find(q => ts.isGetAccessorDeclaration(q) && q.name.text === nm);
                const st = e.properties.find(q => ts.isSetAccessorDeclaration(q) && q.name.text === nm);
                M.localGet(t.v); M.i32Const(this._strId(nm));
                if (g) this.emitTaggedExpr(this._memberLambda(g)); else this._emitUndefined();
                if (st) this.emitTaggedExpr(this._memberLambda(st)); else this._emitUndefined();
                M.call("qz.obj_accessor");
            } else throw new Error("[tagged] 对象字面量属性形式不支持");
        }
        M.localGet(t.v);
        this._expLeave();
        return;
    }
    if (ts.isObjectLiteralExpression(e)) {
        // POJO：字段驻留 wasm 线性内存（零跨界读写）。句柄 = box(高16位0x7FF9 | offset)。字段宽 8 字节（i64）。
        if (e.properties.some(p => ts.isSpreadAssignment(p))) {
            // {..a, k: v}：分配统一容量的新 POJO → 展开段做**内存级浅拷贝**（嵌套句柄原样复制 = JS 别名语义）+
            // 宿主对象/非 POJO 源走 qz.obj_merge（物化后逐键写）；显式属性直接写各自字段槽。
            const Ma = this.m, ta = this._expEnter();
            const cap = this._instSize();
            emitBumpAlloc(Ma, () => Ma.i32Const(cap));            // → off(i32)
            Ma.localSet(ta.a);
            Ma.localGet(ta.a); Ma.i64ExtendI32U(); Ma.i64ConstBits(0, 0x7ff90000); Ma.i64Or(); Ma.localSet(ta.v);
            Ma.localGet(ta.a); Ma.i32Const(0); Ma.i32Store(2, 0);                  // [0]=clsId（POJO=0）
            Ma.localGet(ta.a); Ma.i32Const(cap); Ma.i32Store(2, 4);                // [4]=size
            Ma.localGet(ta.a); this._emitFillUndef(cap);                           // 未赋值槽 = undefined
            for (const p of e.properties) {
                if (ts.isSpreadAssignment(p)) {
                    this.emitTaggedExpr(p.expression); Ma.localSet(ta.w);
                    Ma.localGet(ta.w); Ma.i64Const(48n); Ma.i64ShrU(); Ma.i64Const(0x7ff9n); Ma.i64Eq();
                    Ma.localGet(ta.w); Ma.i64Const(48n); Ma.i64ShrU(); Ma.i64Const(0x7ffen); Ma.i64Eq();
                    Ma.i32Or();
                    Ma.ifBlock("void");
                    // 槽级合并：仅当源槽≠undefined 才写入（JS：后展开段只覆盖其自有键；undefined 槽不覆盖）
                    Ma.localGet(ta.a); Ma.i32Const(8); Ma.i32Add(); Ma.localSet(ta.b);        // dst 游标（a 保留 = 新对象）
                    Ma.localGet(ta.w); Ma.i32WrapI64(); Ma.i32Const(8); Ma.i32Add(); Ma.localSet(ta.c);   // src 游标
                    Ma.localGet(ta.a); Ma.i32Const(cap); Ma.i32Add(); Ma.localSet(ta.d);      // dst 末尾
                    Ma.block("void"); Ma.loop("void");
                    Ma.localGet(ta.b); Ma.localGet(ta.d); Ma.i32GeU(); Ma.brIf(1);            // 到尾 → 退出
                    Ma.localGet(ta.c); Ma.i64Load(3, 0);
                    Ma.i64ConstBits(0, 0x7ff90000); Ma.i64Eq(); Ma.i32Eqz();
                    Ma.ifBlock("void");
                    Ma.localGet(ta.b); Ma.localGet(ta.c); Ma.i64Load(3, 0); Ma.i64Store(3, 0);
                    Ma.end();
                    Ma.localGet(ta.b); Ma.i32Const(8); Ma.i32Add(); Ma.localSet(ta.b);
                    Ma.localGet(ta.c); Ma.i32Const(8); Ma.i32Add(); Ma.localSet(ta.c);
                    Ma.br(0);
                    Ma.end(); Ma.end();
                    if (this.usesKeyOrder) { Ma.localGet(ta.v); Ma.localGet(ta.w); Ma.call("qz.spread_order"); }   // 键序补登记（否则合并后键序退化为槽序）
                    Ma.else_();
                    Ma.localGet(ta.v); Ma.localGet(ta.w); Ma.call("qz.obj_merge");      // 宿主对象等 → 物化合并
                    if (this.usesKeyOrder) { Ma.localGet(ta.v); Ma.localGet(ta.w); Ma.call("qz.spread_order"); }
                    Ma.end();
                } else if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
                    Ma.localGet(ta.v); Ma.i32WrapI64();
                    this.emitTaggedExpr(ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer);
                    Ma.i64Store(3, this._fieldIndex(p.name.text));
                    if (this.usesKeyOrder) { Ma.localGet(ta.v); this._emitStrLitHandle(p.name.text); Ma.call("qz.field_order"); }   // 显式属性也登记键序
                } else throw new Error("[tagged] 对象展开仅支持 属性/展开 混合（方法/访问器不支持）");
            }
            Ma.localGet(ta.v);
            this._expLeave();
            return;
        }
        if (e.properties.some(p => !ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p))) {
            throw new Error("[tagged] 对象字面量只支持 { x: v } / { x } 形式（方法/访问器/计算属性名不支持）");
        }
        const hasComputedKey = e.properties.some(p => ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name));
        const NF = e.properties.length;
        // 字段偏移用全局 fieldMap（名→固定偏移，POJO 隐式形状）：与读取端 _fieldIndex 一致。
        // 分配 size = 最大字段字节偏移 + 8（偏移 0 保留给 __cls 头，POJO 留 0 亦无害）。
        for (const p of e.properties) this._fieldIndex(p.name.text);   // 字段已在预登记表中
        const size = this._instSize();   // 统一容量：所有字段名皆可写（支持运行期新增字段），未赋值槽 = undefined
        emitBumpAlloc(this.m, () => this.m.i32Const(size));   // → offset(i32)（越界 trap）
        this.m.i64ExtendI32U(); this.m.i64ConstBits(0, 0x7ff90000); this.m.i64Or();   // 句柄 = 高16位0x7FF9 | offset(低32)
        const slot = this.objBase + this._objDepth;   // 本层句柄槽（嵌套各占一层，避免内层覆盖）
        this._objDepth++;
        this.m.localSet(slot);                        // 句柄 → slot（i64）
        // 头：[0]=clsId(0=非实例)、[4]=size；槽 [8,size) 全写 undefined 句柄（未赋值字段 = undefined）
        this.m.localGet(slot); this.m.i32WrapI64(); this.m.i32Const(0); this.m.i32Store(2, 0);
        this.m.localGet(slot); this.m.i32WrapI64(); this.m.i32Const(size); this.m.i32Store(2, 4);
        this.m.localGet(slot); this.m.i32WrapI64(); this._emitFillUndef(size);
        for (let i = 0; i < NF; i++) {
            const p = e.properties[i];
            if (ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name)) {
                // {[k]: v}：运行期键 → 宿主按名写入（预登记槽命中走内存，未命中进 extras）
                if (this.usesKeyOrder) { this.m.localGet(slot); this.emitTaggedExpr(p.name.expression); this.m.call("qz.field_order"); }
                this.m.localGet(slot);
                this.emitTaggedExpr(p.name.expression);
                this.emitTaggedExpr(p.initializer);
                this.m.call("qz.set_index");
                continue;
            }
            this.m.localGet(slot);                    // [h]
            this.m.i32WrapI64();                      // 低32位=offset
            this.emitTaggedExpr(ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer);   // 简写 {x} ≡ {x: x}
            this.m.i64Store(3, this._fieldIndex(p.name.text));   // memory[off + 字段字节偏移] = val
            if (this.usesKeyOrder && hasComputedKey) {   // 含计算键时逐属性按**源码序**登记（否则计算键会被批量登记挤到最前）
                this.m.localGet(slot); this._emitStrLitHandle(p.name.text); this.m.call("qz.field_order");
            }
        }
        if (this.usesKeyOrder && !hasComputedKey) {    // 插入序：字面量名序（编译期常量，一次登记；含计算键时已逐属性登记）
            const nmList = e.properties.map(p => (p.name && p.name.text ? p.name.text : "")).filter(x => x !== "");
            if (nmList.length) { this.m.localGet(slot); this.m.i32Const(this._strId(nmList.join("\u0000"))); this.m.call("qz.field_order_lit"); }
        }
        this.m.localGet(slot);
        this._objDepth--;
        return;
    }
    if (ts.isArrayLiteralExpression(e)) {
        const Mt = this.m, t = this._expEnter();   // headerOff 须存活于元素（可含嵌套字面量）求值
        if (e.elements.some(el => ts.isSpreadElement(el))) {
            // [..a, x] → ([] concat a) concat [x]；concat 由宿主 doArrMethod 处理（返回新数组句柄）
            this.emitTaggedExpr(ts.factory.createArrayLiteralExpression([])); Mt.localSet(t.v);
            for (const el of e.elements) {
                if (ts.isSpreadElement(el)) {                         // [...x]：迭代协议（数组/字符串/迭代器/Map/Set）
                    Mt.localGet(t.v); this.emitTaggedExpr(el.expression); Mt.call("qz.spread_into"); Mt.localSet(t.v);
                    continue;
                }
                Mt.localGet(t.v);                                     // [..a, x]：把单元素数组 concat 进去
                Mt.i32Const(this._strId("concat"));
                this.emitTaggedExpr(ts.factory.createArrayLiteralExpression([el]));
                this._emitUndefined(); this._emitUndefined(); this._emitUndefined();
                this._emitUndefined();   // ovf（实参 4..；当前恒 undefined，>4 形参支持后由调用点传入）
                Mt.call("qz.method_call");
                Mt.localSet(t.v);
            }
            Mt.localGet(t.v);
            this._expLeave();
            return;
        }
        // 数组：稳定句柄布局 header(16B: len,cap,dataOff,pad) + data 块(elem i64×N)。
        // 句柄 = 0x7FFB|headerOff；push 增长只换 data 块、句柄不变（支持别名/传参/属性）。
        const N = e.elements.length;
        const total = 16 + N * 8;
        emitBumpAlloc(this.m, () => this.m.i32Const(total));   // → headerOff(i32)（越界 trap）
        Mt.localSet(t.a);
        Mt.localGet(t.a); Mt.i32Const(N); Mt.i32Store(2, 0);    // len
        Mt.localGet(t.a); Mt.i32Const(N); Mt.i32Store(2, 4);    // cap
        Mt.localGet(t.a); Mt.localGet(t.a); Mt.i32Const(16); Mt.i32Add(); Mt.i32Store(2, 8);   // dataOff = off+16
        for (let i = 0; i < N; i++) {
            Mt.localGet(t.a); Mt.i32Load(2, 8);            // dataOff
            if (ts.isOmittedExpression(e.elements[i])) Mt.i64ConstBits(2, 0x7ff90000);   // [1,,3] → 洞
            else this.emitTaggedExpr(e.elements[i]);
            Mt.i64Store(3, i * 8);
        }
        Mt.localGet(t.a); Mt.i64ExtendI32U();
        Mt.i64ConstBits(0, 0x7ffb0000); Mt.i64Or();               // 句柄
        this._expLeave();
        return;
    }
    // 可选链 `o?.x` / `o?.[i]` / `o?.length`：base 求值一次 → 若 null/undefined 则结果 undefined（短路，不求 index），否则按普通访问。
    if ((ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) && e.questionDotToken) {
        const M = this.m;
        this.emitTaggedExpr(e.expression); M.localSet(this.scratchObj);
        M.localGet(this.scratchObj); M.call("qz.is_nullish");
        M.ifBlock("i64");
        this._emitUndefined();
        M.else_();
        if (ts.isPropertyAccessExpression(e)) {
            if (e.name.text === "length") this._emitLengthOf(this.scratchObj);
            else this._emitPropReadFromLocal(this.scratchObj, e.name.text);
        } else {
            this._emitElemOf(this.scratchObj, e.argumentExpression);
        }
        M.end();
        return;
    }
    // 内建全局成员读（非调用）：Math.PI / Number.MAX_SAFE_INTEGER / … → qz.builtin（常量表）
    // TS enum：Color.Red → 编译期值；Color[0] → 反向成员名（字符串枚举无反向映射 → undefined）
    if (this.enums && ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && this.enums.has(e.expression.text)) {
        const en = this.enums.get(e.expression.text);
        if (!en.fwd.has(e.name.text)) throw new Error(`[tagged] enum ${e.expression.text} 无成员 ${e.name.text}`);
        const v = en.fwd.get(e.name.text);
        if (typeof v === "string") this._emitStrLitHandle(v); else this.m.i64ConstBits(...f64Bits(v));
        return;
    }
    if (this.enums && ts.isElementAccessExpression(e) && ts.isIdentifier(e.expression) && this.enums.has(e.expression.text)
        && (ts.isNumericLiteral(e.argumentExpression) || ts.isStringLiteral(e.argumentExpression))) {
        const en = this.enums.get(e.expression.text);
        const k = e.argumentExpression.text;
        const nm = en.rev.get(k);
        if (nm === undefined) this._emitUndefined(); else this._emitStrLitHandle(nm);
        return;
    }
    if (ts.isPropertyAccessExpression(e) && !e.questionDotToken && ts.isIdentifier(e.expression)
        && BUILTIN_GLOBALS.has(e.expression.text)) {
        // 常量（Math.PI）→ 值；函数（Math.expm1 / JSON.stringify）→ 宿主函数句柄（truthy、typeof function）
        this.m.i32Const(this._strId(e.expression.text + "." + e.name.text));
        this.m.call("qz.builtin_member");
        return;
    }
    if (ts.isElementAccessExpression(e)) {
        const sk0 = this._symKeyName(e.argumentExpression);
        if (sk0) {                                            // o[Symbol.iterator] ≡ o["@@iterator"]
            const ts2 = this._expEnter();
            this.emitTaggedExpr(e.expression); ts2 && this.m.localSet(ts2.v);
            this._emitPropReadFromLocal(ts2.v, sk0);
            this._expLeave();
            return;
        }
        // o[k]：字符串键（动态）→ 宿主 qz.get_index（POJO 按字段名表 / 宿主对象按索引）；
        //       数值键 → wasm 内存快路径（数组 dataOff + i*8）。
        const Mi = this.m, t = this._expEnter();
        this.emitTaggedExpr(e.expression); Mi.localSet(t.v);
        this._emitElemOf(t.v, e.argumentExpression);
        this._expLeave();
        return;
    }
    // 类静态字段 C.x（C 为已收集类名）→ 确保静态已初始化 + 宿主 static_get
    // 私有成员访问 this.#v / obj.#m()：名字按「当前类」限定（JS 私有名仅同类可访问）
    if (ts.isPropertyAccessExpression(e) && ts.isPrivateIdentifier(e.name) && this._curClass && !this._isClassName(e.expression)) {   // 类名接收者（P.#s）→ 走静态路径
        const pn = "#" + this._curClass + "#" + e.name.text;
        const c = this.classes.get(this._curClass);
        if (c && (c.methods || []).some(m => m.name === pn)) {   // 私有方法：同名按类名限定
            this._emitDynMethod(e.expression, pn, []);
            return;
        }
        const tp = this._expEnter();                              // 私有字段：类名限定名读字段槽
        this.emitTaggedExpr(e.expression); this.m.localSet(tp.v);
        this._emitPropReadFromLocal(tp.v, pn);
        this._expLeave();
        return;
    }
    if (ts.isPropertyAccessExpression(e) && !e.questionDotToken && this._isClassName(e.expression)) {
        const cn = this._classOfExpr(e.expression);
        const got = this._findStaticAccessor(cn, e.name.text, "get");
        if (got && got.acc) this._checkStaticThis(got.cname, cn, got.acc, e.name.text);
        if (got) {                                            // 静态 getter（含继承）→ 直调 __sm_<owner>$<name>
            this._emitStaticsGuard(got.cname);
            this._emitUndefined();
            for (let i = 0; i < 4; i++) this._emitUndefined();
            this.m.call(staticMethName(got.cname, got.acc.name));
            return;
        }
        if (e.name.text === "prototype") {                     // C.prototype → 类对象上的 prototype（JS 语义）
            this.m.i32Const(this.classes.get(cn).id); this.m.call("qz.class_value");
            this.m.i32Const(this._strId("prototype")); this.m.call("qz.prop_get");
            return;
        }
        // 静态字段可继承/可被派生类遮蔽：先初始化父链各层，再**运行时**从当前类向上找持有者
        const chain = [];
        for (let x = cn; x; x = this.classes.get(x).parent) chain.push(x);
        for (const x of chain.slice().reverse()) this._emitStaticsGuard(x);
        const M3 = this.m, ts2 = this._expEnter();
        this._emitUndefined(); M3.localSet(ts2.v);
        for (const x of chain.slice().reverse()) {          // 父 → 子：越派生越后写（遮蔽父类同名字段）
            M3.i32Const(this._strId(x)); M3.i32Const(this._strId(this._staticKey(x, e.name))); M3.call("qz.statics_has");   // 私有静态字段需类名限定
            M3.ifBlock("void");
            M3.i32Const(this._strId(x)); M3.i32Const(this._strId(this._staticKey(x, e.name))); M3.call("qz.static_get");
            M3.localSet(ts2.v);
            M3.end();
        }
        M3.localGet(ts2.v);
        this._expLeave();
        return;
    }
    if (ts.isPropertyAccessExpression(e) && ts.isSuperKeyword(e.expression)) {
        // super.v：父类 getter → 调之；否则按字段偏移直读（父类字段与子类共用同一 fieldMap 偏移）
        const parent = this._curClassObj && this._curClassObj.parent;
        if (!parent) throw new Error("[tagged] super.<prop> 仅在派生类方法内可用");
        // 实例访问器：沿父链找 get
        let owner = parent, acc = null;
        while (owner && !acc) {
            const cl = this.classes.get(owner);
            acc = (cl.methods || []).find(m => m.accessor === "get" && m.name === e.name.text) || null;
            if (!acc) owner = cl.parent;
        }
        if (acc) { this.m.localGet(0); for (let i = 0; i < 4; i++) this._emitUndefined(); this.m.call(methName(owner, acc.name)); return; }
        this.m.localGet(0); this.m.i32WrapI64(); this.m.i64Load(3, this._fieldIndex(e.name.text));
        return;
    }
    if (ts.isPropertyAccessExpression(e) && e.name.text === "length") {
        // .length：字符串(0x7FFA) → qzs_utf16len（UTF-16 码元数，非 UTF-8 字节数："你好".length=2）；
        //   数组(0x7FFB) → 结构首 i32（元素数）；其余 → qz.str_len（跨界，罕见）。
        this.emitTaggedExpr(e.expression);
        this.m.localSet(this.scratch);
        this.m.localGet(this.scratch); this.m.i64Const(48n); this.m.i64ShrU();
        this.m.i64Const(0x7ffan); this.m.i64Eq();
        this.m.ifBlock("i64");
        this.m.localGet(this.scratch); this.m.i32WrapI64(); this.m.call("qzs_utf16len");
        this.m.f64ConvertI32U(); this.m.i64ReinterpretF64();
        this.m.else_();
        this.m.localGet(this.scratch); this.m.i64Const(48n); this.m.i64ShrU();
        this.m.i64Const(0x7ffbn); this.m.i64Eq();
        this.m.ifBlock("i64");
        this.m.localGet(this.scratch); this.m.i32WrapI64(); this.m.i32Load(2, 0);
        this.m.f64ConvertI32U(); this.m.i64ReinterpretF64();
        this.m.else_();
        // 其余（POJO/实例/宿主对象/闭包值）：走宿主属性读取（此前一律 qz.str_len → 读内存当字符串长度，静默错值）
        this.m.localGet(this.scratch); this.m.i32Const(this._strId("length")); this.m.call("qz.prop_get");
        this.m.end(); this.m.end();
        return;
    }
    if (ts.isPropertyAccessExpression(e)) {
        // obj.a：宿主对象(0x7FFD) → qz.object_get；POJO(0x7FF9|off≥8)/类实例(0x7FFE|off)
        //   → wasm 内存 load，**越界（该对象无此字段）→ undefined**（此前会读到对象外内存/对象头 → 静默错值）；
        //   其余（数组/字符串/数字上的普通属性）→ undefined。
        const M = this.m, t = this._expEnter();
        this.emitTaggedExpr(e.expression); M.localSet(t.v);
        this._emitPropReadFromLocal(t.v, e.name.text);
        this._emitErrCheck();          // undefined/null 读属性 → TypeError（转入本函数 catch）
        this._expLeave();
        return;
    }
    if (ts.isNewExpression(e) && e.arguments.some(a => ts.isSpreadElement(a))) {
        const M = this.m, t = this._expEnter();
        const lit = ts.factory.createArrayLiteralExpression(e.arguments);
        lit.pos = e.pos; lit.end = e.end;
        this.emitTaggedExpr(lit); M.localSet(t.y);                       // 实参数组（受保护）
        this._emitNewCall({ expression: e.expression, arguments: [] }, (i) => this._emitElemOf(t.y, ts.factory.createNumericLiteral(i)));
        this._expLeave();
        return;
    }
    if (ts.isNewExpression(e)) { this._emitNewCall(e); return; }
    if (ts.isCallExpression(e) && e.questionDotToken) {
        const M = this.m, t = this._expEnter();
        this.emitTaggedExpr(e.expression); M.localSet(t.v);        // 被调值（只求值一次）
        M.localGet(t.v); M.call("qz.is_nullish");
        M.ifBlock("i64");
        this._emitUndefined();
        M.else_();
        M.localGet(t.v);
        for (let i = 0; i < 4; i++) { if (i < e.arguments.length) this.emitTaggedExpr(e.arguments[i]); else this._emitUndefined(); }
        this._emitUndefined();                                    // 第 6 参（溢出实参）：可选调用不打包
        this._emitUndefined();                                    // 第 7 参（recv）
        M.call("qz.call_value");
        this._emitErrCheck();
        M.end();
        this._expLeave();
        return;
    }
    if (ts.isCallExpression(e) && ts.isSuperKeyword(e.expression)) {
        if (!this._curClassObj) throw new Error("[tagged] super() 仅在构造器内可用");
        const par = this._curClassObj.parent;
        if (par && !this.classes.has(par)) {                  // 父类为内建（Error 族…）→ 写 message/name 字段
            const M2 = this.m;
            M2.localGet(0); M2.i32WrapI64();
            if (e.arguments && e.arguments.length) this.emitTaggedExpr(e.arguments[0]); else this._emitUndefined();
            M2.i64Store(3, this._fieldIndex("message"));
            M2.localGet(0); M2.i32WrapI64(); this._emitStrLitHandle(par);
            M2.i64Store(3, this._fieldIndex("name"));
            this._emitFieldDefaults(this._curClassObj);
            return;
        }
        this._emitSuperCall(this._curClassObj, e.arguments || []); return;
    }
    // super.m(args)：父类方法**静态**直调（继承链编译期已知 → 无虚派发，与 JS super 语义一致）
    if (ts.isPropertyAccessExpression(e) && ts.isSuperKeyword(e.expression)) {
        // super.v：父类 getter → 调之；否则按字段偏移直读（父类字段与子类共用同一 fieldMap 偏移）
        const parent = this._curClassObj && this._curClassObj.parent;
        if (!parent) throw new Error("[tagged] super.<prop> 仅在派生类方法内可用");
        // 实例访问器：沿父链找 get
        let owner = parent, acc = null;
        while (owner && !acc) {
            const cl = this.classes.get(owner);
            acc = (cl.methods || []).find(m => m.accessor === "get" && m.name === e.name.text) || null;
            if (!acc) owner = cl.parent;
        }
        if (acc) { this.m.localGet(0); for (let i = 0; i < 4; i++) this._emitUndefined(); this.m.call(methName(owner, acc.name)); return; }
        this.m.localGet(0); this.m.i32WrapI64(); this.m.i64Load(3, this._fieldIndex(e.name.text));
        return;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)
        && ts.isSuperKeyword(e.expression.expression)) {
        const owner = this._curClassObj && this._curClassObj.parent;
        const method = e.expression.name.text;
        let c = owner, isStaticM = false;
        while (c) {                                          // 父链上查实例方法，其次静态方法（static super.m()）
            const cl = this.classes.get(c);
            if ((cl.methods || []).some(m => m.name === method)) { isStaticM = false; break; }
            if ((cl.staticMethods || []).some(m => m.name === method)) { isStaticM = true; break; }
            c = cl.parent;
        }
        if (!c) throw new Error(`[tagged] super.${method}() 在父类链上未定义`);
        if (isStaticM) {                                     // 静态父方法：self 占位（静态方法不使用 this）
            this._emitStaticsGuard(c);
            this._emitUndefined();
            for (let i = 0; i < 4; i++) {
                if (i < e.arguments.length) this.emitTaggedExpr(e.arguments[i]); else this._emitUndefined();
            }
            this.m.call(staticMethName(c, method));
            return;
        }
        this.m.localGet(0);                                  // self = this
        for (let i = 0; i < 4; i++) {
            if (i < e.arguments.length) this.emitTaggedExpr(e.arguments[i]); else this._emitUndefined();
        }
        this.m.call(methName(c, method));
        return;
    }
    // 调用实参含展开 f(...a, x)：wasm 静态元数无法承载 → 实参先构造成数组，宿主按名/闭包动态派发
    if (ts.isCallExpression(e) && e.arguments.some(a => ts.isSpreadElement(a))) {
        this._emitSpreadCall(e);
        return;
    }
    if (ts.isCallExpression(e)) {
        if (ts.isPropertyAccessExpression(e.expression)) {
            // 内建全局成员调用 Math.floor(x) / JSON.stringify(x) / Object.keys(o) → qz.builtin
            if (ts.isIdentifier(e.expression.expression) && BUILTIN_GLOBALS.has(e.expression.expression.text)) {
                this._emitBuiltinCall(e.expression.expression.text + "." + e.expression.name.text, e.arguments); return;
            }
            const rx = e.expression.expression, method = e.expression.name.text;
            // 命名空间成员 `ns.foo(...)`：解析为目标顶层函数直调（非动态方法派发）。
            if (ts.isIdentifier(rx)) {
                const resolved = this._nsMember(rx.text, method);
                if (resolved !== undefined) {
                    const cn = this._calleeInfo(resolved);
                    const xn = cn && cn.mode !== this.mode;
                    for (const a of e.arguments) { this.emitTaggedExpr(a); if (xn) this._argToCallee(resolved); }
                    this.m.call(this._fnName(resolved));
                    this._retFromCallee(resolved); return;
                }
            }
            // 类静态方法优先：C.push/C.pop 等与数组方法同名，不能走数组快路径
            if (this._isClassName(rx)) { this._emitDynMethod(rx, method, e.arguments); return; }
            // 多参变参数组方法（push/unshift/splice/concat 超 4 参）：实参合成数组 → 宿主 arr_apply
            if (["push", "unshift", "splice"].includes(method) && e.arguments.length > 1) {   // concat 双份（字符串/数组）→ 仍走宿主 method_call
                const M = this.m, t = this._expEnter();
                this.emitTaggedExpr(rx); M.localSet(t.v);
                const lit = ts.factory.createArrayLiteralExpression(e.arguments);
                lit.pos = e.pos; lit.end = e.end;
                this.emitTaggedExpr(lit); M.localSet(t.w);
                M.localGet(t.v); M.i32Const(this._strId(method)); M.localGet(t.w); M.call("qz.arr_apply");
                this._expLeave();
                return;
            }
            // push/pop 快路径：运行时守卫——仅接收者为 wasm 数组(0x7FFB)时走内存直写；
            // 否则退回通用方法派发（对象字面量/类实例的同名 push/pop 方法此前被误判 → 静默错值）。
            if ((method === "push" && e.arguments.length === 1) || (method === "pop" && e.arguments.length === 0)) {
                const Mg = this.m, tg = this._expEnter();
                this.emitTaggedExpr(rx); Mg.localSet(tg.v);                 // 接收者只求值一次
                Mg.localGet(tg.v); Mg.i64Const(48n); Mg.i64ShrU(); Mg.i64Const(0x7ffbn); Mg.i64Eq();
                Mg.ifBlock("i64");
                this.depth++;                       // 守卫的 if 块也要计入 br 深度（分支内含 errCheck/短路等 br）
                if (method === "push") this._emitArrayPush(rx, e.arguments[0], tg.v); else this._emitArrayPop(rx, tg.v);
                Mg.else_();
                this._emitDynMethod(rx, method, e.arguments);
                Mg.end();
                this.depth--;
                this._expLeave();
                return;
            }
            this._emitDynMethod(rx, method, e.arguments); return;
        }
        // IIFE（(() => 42)() / 函数表达式立即调用）：先求值为闭包句柄 → closure_call
        if (ts.isParenthesizedExpression(e.expression)
            && (ts.isArrowFunction(e.expression.expression) || ts.isFunctionExpression(e.expression.expression))) {
            const M2 = this.m, t2 = this._expEnter();
            const inner = e.expression.expression;
            this.emitTaggedExpr(e.expression); M2.localSet(t2.v);
            M2.localGet(t2.v);
            for (let i = 0; i < 4; i++) {
                if (i < e.arguments.length) this.emitTaggedExpr(e.arguments[i]); else this._emitUndefined();
            }
            if (inner.parameters.length > 4 || e.arguments.length > 4) {   // 溢出实参 → 第 6 参（call_value）
                const ovfI = e.arguments.slice(3);
                const litI = ts.factory.createArrayLiteralExpression(ovfI);
                litI.pos = e.pos; litI.end = e.end;
                this.emitTaggedExpr(litI);
                this._emitUndefined();                                    // 第 7 参（recv）
                M2.call("qz.call_value");
            } else { this._emitUndefined(); M2.call("qz.closure_call"); }   // recv（普通调用 = undefined）
            this._emitErrCheck();
            this._expLeave();
            return;
        }
        if (ts.isElementAccessExpression(e.expression)) {
            const sk1 = this._symKeyName(e.expression.argumentExpression);
            if (sk1) { this._emitDynMethod(e.expression.expression, sk1, e.arguments); return; }   // o[Symbol.x](…) ≡ o["@@x"](…)
        }
        if (!ts.isIdentifier(e.expression)) {
            this._emitValueCall(e.expression, e.arguments);   // 值调用：宿主按句柄类型分派（闭包/宿主函数）
            return;
        }
        const fn = e.expression.text;
        // 内建全局函数调用 String(x) / parseInt(s) / isNaN(x) / JSON… → qz.builtin
        if (BUILTIN_GLOBALS.has(fn)) { this._emitBuiltinCall(fn, e.arguments); return; }
        // JS 作用域：局部/捕获名遮蔽同名顶层函数（如参数 g 遮蔽顶层 g）→ 优先按闭包处理
        if (this.capMap.has(fn) || this._local(fn) !== undefined) {
            this._emitClosureCall(fn, e.arguments);
            return;
        }
        if (this.m._funcIdx[this._fnName(fn)] === undefined && !this.fnNames.has(this._fnName(fn))) {
            // 非顶层函数 → 变量持有闭包：closure_call(handle, a0..a3)。
            // 句柄来源：本层局部变量，或**捕获**（嵌套函数声明/上层局部闭包 → env_get）。
            this._emitClosureCall(fn, e.arguments);
            return;
        }
        const ct = this._calleeInfo(fn);
        const xt = ct && ct.mode !== this.mode;
        // JS 元数语义：实参多于形参 → 被调函数只见前 nPar 个；少于 → 余下为 undefined。
        // num 模式被调函数（f64 ABI）无法表示 undefined → 少传直接报错（loud），不静默补 0。
        const nPar = (this._fnParams && this._fnParams.get(this._fnName(fn))) ?? e.arguments.length;
        const calleeNum = !!ct && ct.mode === "num";
        if (calleeNum && e.arguments.length < nPar) {
            throw new Error(`[tagged] num 函数 ${fn} 需 ${nPar} 个实参（JS 少传 → undefined 无法在 f64 ABI 表示）`);
        }
        const calleeParams = !calleeNum ? (this._calleeParams(fn) || this._calleeParams(this._fnName(fn))) : null;
        if (calleeParams && calleeParams.length === nPar && calleeParams.some(p => p.dotDotDotToken && p === calleeParams[nPar - 1])) {
            this._emitCallArgs(calleeParams, e.arguments, fn);       // rest 收尾：打包余下实参
        } else {
            const nPass = calleeNum ? e.arguments.length : nPar;
            for (let i = 0; i < nPass; i++) {
                if (i < e.arguments.length) { this.emitTaggedExpr(e.arguments[i]); if (xt) this._argToCallee(fn); }
                else this._emitUndefined();
            }
        }
        this.m.call(this._fnName(fn));
        this._retFromCallee(fn);
        this._emitErrCheck();                                     // 被调函数可能跨函数抛出
        return;
    }
    if (ts.isConditionalExpression(e)) {                                                     // a ? b : c
        this.emitCondI32(e.condition);
        this.m.ifBlock("i64");
        this.emitTaggedExpr(e.whenTrue);
        this.m.else_();
        this.emitTaggedExpr(e.whenFalse);
        this.m.end();
        return;
    }
    if (ts.isVoidExpression(e)) { this.emitTaggedExpr(e.expression); this.m.drop(); this._emitUndefined(); return; }   // void x → undefined（求值副作用，丢弃值）
    if (ts.isDeleteExpression(e)) {
        // delete obj.k：宿主对象(0x7FFD) → qz.object_delete；POJO → 槽写 undefined sentinel（等价删除）。返回 true。
        const M = this.m;
        const op = e.expression;
        const t = this._expEnter();
        this.emitTaggedExpr(op.expression); M.localSet(t.v);
        if (ts.isElementAccessExpression(op)) {          // delete o[k] / delete a[i] → 宿主按 tag 删除
            this.emitTaggedExpr(op.argumentExpression); M.localSet(t.w);
            M.localGet(t.v); M.localGet(t.w); M.call("qz.delete_index");
            M.drop();
        } else if (ts.isPropertyAccessExpression(op)) {
            // delete obj.k：宿主对象真删（原型可透出）；POJO/实例槽置 undefined（等价删除）——统一由 prop_delete 处理
            M.localGet(t.v); M.i32Const(this._strId(op.name.text)); M.call("qz.prop_delete");
            if (this.usesKeyOrder) { M.localGet(t.v); this._emitStrLitHandle(op.name.text); M.call("qz.field_order_del"); }   // 插入序名单同步移除
            this._emitErrCheck(false);
        } else throw new Error("[tagged] delete 仅支持属性/下标（delete obj.k / delete a[i]）");
        this._expLeave();
        M.i64ConstBits(1, 0x7ffc0000);   // true（tagged bool）
        return;
    }
    if (ts.isPrefixUnaryExpression(e)) {
        if (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken) {
            const inc = e.operator === ts.SyntaxKind.PlusPlusToken;
            if (ts.isPropertyAccessExpression(e.operand)) {
                // ++C.n / --C.n（类静态字段）：guard → static_get ± 1 → static_set；结果=新值
                if (this._isClassName(e.operand.expression)) {
                    const cn = e.operand.expression.text, Mc = this.m;
                    this._emitStaticsGuard(cn);
                    Mc.i32Const(this._strId(cn)); Mc.i32Const(this._strId(this._staticKey(cn, e.operand.name))); Mc.call("qz.static_get");
                    Mc.i64ConstBits(...f64Bits(1));
                    this.emitGuardedOp(inc ? "qz.add" : "qz.sub", inc ? Mc.f64Add : Mc.f64Sub);
                    Mc.localSet(this.scratch);
                    Mc.i32Const(this._strId(cn)); Mc.i32Const(this._strId(this._staticKey(cn, e.operand.name))); Mc.localGet(this.scratch); Mc.call("qz.static_set");
                    Mc.localGet(this.scratch);
                    return;
                }
                // ++obj.a / --obj.a：接收者求值一次 → 读字段 ± 1 → 写回；结果=新值
                const off = this._fieldIndex(ts.isPrivateIdentifier(e.operand.name) && this._curClass ? "#" + this._curClass + "#" + e.operand.name.text : e.operand.name.text);
                this.emitTaggedExpr(e.operand.expression);
                this.m.localSet(this.scratchObj);
                this.m.localGet(this.scratchObj); this.m.i32Const(this._strId(ts.isPrivateIdentifier(e.operand.name) && this._curClass ? "#" + this._curClass + "#" + e.operand.name.text : e.operand.name.text)); this.m.call("qz.prop_get");
                this.m.i64ConstBits(...f64Bits(1));
                this.emitGuardedOp(inc ? "qz.add" : "qz.sub", inc ? this.m.f64Add : this.m.f64Sub);
                this.m.localSet(this.scratch);
                {   // 宿主对象(0x7FFD) → qz.prop_set（对象字面量方法里的 this.x++）；否则写内存字段
                    const M2 = this.m, t2 = this._expEnter();
                    M2.localGet(this.scratchObj); M2.localSet(t2.v);
                    M2.localGet(t2.v); M2.i64Const(48n); M2.i64ShrU(); M2.i64Const(0x7ffdn); M2.i64Eq();
                    M2.ifBlock("void");
                    M2.localGet(t2.v); M2.i32Const(this._strId(e.operand.name.text)); M2.localGet(this.scratch); M2.call("qz.prop_set");
                    this._emitErrCheck(false);   // 冻结/不可扩展对象写入 → 抛 TypeError（转入 catch）
                    M2.else_();
                    M2.localGet(t2.v); M2.i32WrapI64(); M2.localGet(this.scratch); M2.i64Store(3, off);
                    M2.end();
                    this._expLeave();
                }
                this.m.localGet(this.scratch);   // 表达式结果=新值
                return;
            }
            // ++x / --x：x = x ± 1，返回新值（含闭包捕获变量）
            this._emitVarGet(e.operand.text);
            this.m.i64ConstBits(...f64Bits(1));
            this.emitGuardedOp(e.operator === ts.SyntaxKind.PlusPlusToken ? "qz.add" : "qz.sub",
                               e.operator === ts.SyntaxKind.PlusPlusToken ? this.m.f64Add : this.m.f64Sub);
            this._emitVarStore(e.operand.text, this.scratchB);   // 写回 + 新值留栈（表达式结果）
            return;
        }
        this.emitTaggedExpr(e.operand);
        if (e.operator === ts.SyntaxKind.ExclamationToken) {
            this.m.call("qz.truthy"); this.m.i32Eqz(); this.emitBoxBool();
        } else if (e.operator === ts.SyntaxKind.TildeToken) {
            this.m.call("qz.bnot");          // ~a = ~(ToInt32(ToNumber(a)))，宿主解引用（含字符串/句柄）
        } else if (e.operator === ts.SyntaxKind.PlusToken) {
            this.m.call("qz.to_num");        // +a = ToNumber(a)
        } else if (e.operator === ts.SyntaxKind.MinusToken) {
            this._emitUnaryNum("qz.neg", this.m.f64Neg);   // JS：-a = -ToNumber(a)（对象走 valueOf，此前裸取反 → 静默 NaN）
        }
        return;
    }
    if (ts.isPostfixUnaryExpression(e)) {                                                    // x++ / x--（guard 命中走原生 f64）
        const inc = e.operator === ts.SyntaxKind.PlusPlusToken;
        if (ts.isPropertyAccessExpression(e.operand)) {
            // C.n++ / C.n--（类静态字段）：结果=旧值，静态槽写回 ±1
            if (this._isClassName(e.operand.expression)) {
                const cn = e.operand.expression.text, Mc = this.m;
                this._emitStaticsGuard(cn);
                Mc.i32Const(this._strId(cn)); Mc.i32Const(this._strId(this._staticKey(cn, e.operand.name))); Mc.call("qz.static_get");
                Mc.localSet(this.scratch);            // scratch=旧值（表达式结果）
                Mc.localGet(this.scratch); Mc.i64ConstBits(...f64Bits(1));
                this.emitGuardedOp(inc ? "qz.add" : "qz.sub", inc ? Mc.f64Add : Mc.f64Sub);
                Mc.localSet(this.scratchB);
                Mc.i32Const(this._strId(cn)); Mc.i32Const(this._strId(this._staticKey(cn, e.operand.name))); Mc.localGet(this.scratchB); Mc.call("qz.static_set");
                Mc.localGet(this.scratch);
                return;
            }
            // this.n++ / obj.a--：接收者求值一次 → 旧值留栈为结果，字段写回 ±1
            const off = this._fieldIndex(ts.isPrivateIdentifier(e.operand.name) && this._curClass ? "#" + this._curClass + "#" + e.operand.name.text : e.operand.name.text);
            this.emitTaggedExpr(e.operand.expression);
            this.m.localSet(this.scratchObj);
            this.m.localGet(this.scratchObj); this.m.i32Const(this._strId(ts.isPrivateIdentifier(e.operand.name) && this._curClass ? "#" + this._curClass + "#" + e.operand.name.text : e.operand.name.text)); this.m.call("qz.prop_get");
            this.m.localSet(this.scratch);          // scratch=旧值（表达式结果）
            this.m.localGet(this.scratch);
            this.m.i64ConstBits(...f64Bits(1));
            this.emitGuardedOp(inc ? "qz.add" : "qz.sub", inc ? this.m.f64Add : this.m.f64Sub);
            this.m.localSet(this.scratchB);         // scratchB=新值
            {   // 宿主对象 → qz.prop_set；否则写内存字段
                const M2 = this.m, t2 = this._expEnter();
                M2.localGet(this.scratchObj); M2.localSet(t2.v);
                M2.localGet(t2.v); M2.i64Const(48n); M2.i64ShrU(); M2.i64Const(0x7ffdn); M2.i64Eq();
                M2.ifBlock("void");
                M2.localGet(t2.v); M2.i32Const(this._strId(e.operand.name.text)); M2.localGet(this.scratchB); M2.call("qz.prop_set");
                this._emitErrCheck(false);   // 冻结/不可扩展对象写入 → 抛 TypeError（转入 catch）
                M2.else_();
                M2.localGet(t2.v); M2.i32WrapI64(); M2.localGet(this.scratchB); M2.i64Store(3, off);
                M2.end();
                this._expLeave();
            }
            this.m.localGet(this.scratch);          // 留旧值
            return;
        }
        this._emitVarGet(e.operand.text); this.m.localSet(this.scratch);   // scratch=旧值（表达式结果）
        this._emitVarGet(e.operand.text);
        this.m.i64ConstBits(...f64Bits(1));
        this.emitGuardedOp(inc ? "qz.add" : "qz.sub", inc ? this.m.f64Add : this.m.f64Sub);
        this._emitVarStore(e.operand.text, this.scratchB);   // 写回（栈留新值）
        this.m.drop();
        this.m.localGet(this.scratch);                          // 留旧值
        return;
    }
    if (ts.isBinaryExpression(e)) { this.emitTaggedBinary(e); return; }
    throw new Error("[tagged] 不支持的表达式: " + ts.SyntaxKind[e.kind]);
};
// 栈顶裸 i32 布尔 → tagged 值（i64）：f64 位型的 0.0/1.0。
// 裸 i32(0/1) → tagged bool（0x7FFC|低32=0/1）。
// 注意：不是 f64 0.0/1.0 —— bool 与 number 在 JS 中须区分（"s"+true="strue" ≠ "s1"），
// 宿主 toJS/truthy 按 0x7FFC tag 还原真布尔。与整数 0/1 i64 亦不同。
Emitter.prototype.emitBoxBool = function () {
    this.m.i64ExtendI32U(); this.m.i64ConstBits(0, 0x7ffc0000); this.m.i64Or();
};
// tagged 值 → 裸 i32 布尔（条件用）。比较二元表达式走 guard 特化：命中 number
// 走原生 f64 谓词（零跨界）；回退才调 qz.<op>。其余表达式经 qz.truthy。
const CMP_GUARD = {
    [ts.SyntaxKind.LessThanToken]: ["qz.lt", "f64Lt"],
    [ts.SyntaxKind.GreaterThanToken]: ["qz.gt", "f64Gt"],
    [ts.SyntaxKind.LessThanEqualsToken]: ["qz.le", "f64Le"],
    [ts.SyntaxKind.GreaterThanEqualsToken]: ["qz.ge", "f64Ge"],
    [ts.SyntaxKind.EqualsEqualsToken]: ["qz.eq", "f64Eq"],
    [ts.SyntaxKind.EqualsEqualsEqualsToken]: ["qz.seq", "f64Eq"],
    [ts.SyntaxKind.ExclamationEqualsToken]: ["qz.ne", "f64Ne"],
    [ts.SyntaxKind.ExclamationEqualsEqualsToken]: ["qz.sne", "f64Ne"],
};
// 栈顶 i64 句柄判定 → 在栈上留 i32：高16位 == 0x7FF9（对象）或 0x7FFA（字符串）。
// 仅靠 0x7FF9 会漏字符串句柄，导致字符串比较回落 f64（两 NaN eq → 恒 false）。
Emitter.prototype._emitIsHandle = function (scratch) {
    const M = this.m;
    // 非「纯 f64 数值」判定 = 句柄(0x7FF9) | 字符串(0x7FFA) | 布尔(0x7FFC) | 类实例(0x7FFE)。
    // 均须回退宿主（f64ReinterpretI64 对它们是 NaN 位型 → 原生 f64 运算全错）。
    M.localGet(scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ff9n); M.i64Eq();
    M.localGet(scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffan); M.i64Eq();
    M.i32Or();
    M.localGet(scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();   // wasm 数组（===/== 需引用同一性）
    M.i32Or();
    M.localGet(scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffcn); M.i64Eq();
    M.i32Or();
    M.localGet(scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffen); M.i64Eq();
    M.i32Or();
    M.localGet(scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7fffn); M.i64Eq();   // 闭包值（函数）
    M.i32Or();
    M.localGet(scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffdn); M.i64Eq();   // 宿主对象(JSON.parse 结果/函数等)
    M.i32Or();
};
// 纯数字判定 = 非句柄(0x7FF9)/字符串(0x7FFA)/数组(0x7FFB)/布尔(0x7FFC)/实例(0x7FFE)。
// 用于 _emitConcat 区分「数值」与「须走宿主 ToPrimitive/ToNumber 的值」。
Emitter.prototype._emitIsPureNum = function (scratch) {
    const M = this.m;
    M.localGet(scratch); M.i64Const(48n); M.i64ShrU(); M.i32WrapI64(); M.localSet(this.sT[0]);   // hi16
    M.localGet(this.sT[0]); M.i32Const(0x7ff9); M.i32Eq();
    M.localGet(this.sT[0]); M.i32Const(0x7ffa); M.i32Eq(); M.i32Or();
    M.localGet(this.sT[0]); M.i32Const(0x7ffb); M.i32Eq(); M.i32Or();
    M.localGet(this.sT[0]); M.i32Const(0x7ffc); M.i32Eq(); M.i32Or();
    M.localGet(this.sT[0]); M.i32Const(0x7ffe); M.i32Eq(); M.i32Or();
    M.localGet(this.sT[0]); M.i32Const(0x7ffd); M.i32Eq(); M.i32Or();
    M.localGet(this.sT[0]); M.i32Const(0x7fff); M.i32Eq(); M.i32Or();   // 闭包值
    M.i32Eqz();
};
Emitter.prototype.emitCmpI32 = function (qzName, f64cmp) {
    const M = this.m;
    M.localSet(this.scratchB); M.localSet(this.scratchA);
    this._emitIsHandle(this.scratchA); this._emitIsHandle(this.scratchB);
    M.i32Or();
    M.ifBlock("i32");
    // 含句柄：回退 qz.<op>，返回 tagged bool（0x7FFC|低32=0/1）→ i32WrapI64 取低32 转 i32
    M.localGet(this.scratchA); M.localGet(this.scratchB); M.call(qzName);
    M.i32WrapI64();
    M.else_();
    M.localGet(this.scratchA); M.f64ReinterpretI64();
    M.localGet(this.scratchB); M.f64ReinterpretI64();
    M[f64cmp]();
    M.end();
};
Emitter.prototype.emitCondI32 = function (expr) {
    if (ts.isBinaryExpression(expr) && CMP_GUARD[expr.operatorToken.kind]) {
        const [qz, f64] = CMP_GUARD[expr.operatorToken.kind];
        this.emitTaggedExpr(expr.left); this.emitTaggedExpr(expr.right);
        this.emitCmpI32(qz, f64);
        return;
    }
    this.emitTaggedExpr(expr); this.m.call("qz.truthy");
};
// guarded 数值特化：栈 [a b] → 都是 tagged number 走原生指令，否则回退 qz.* 跨界。
// 数值=原始 f64 位型，句柄=高16位 0x7FF9（对象）/0x7FFA（字符串）→ reinterpret 后原生 f64 运算（零跨界）。
// cmp=true 时 fastEmit 产出 i32 谓词（f64.lt 等），需 extend 回 i64。
// 一元数值运算 guard：句柄（对象/字符串）→ 宿主 qz.<op>；纯数值 → 内联 f64。
Emitter.prototype._emitUnaryNum = function (qzName, fastEmit) {
    const M = this.m;
    M.localSet(this.scratchB);
    this._emitIsHandle(this.scratchB);
    M.ifBlock("i64");
    M.localGet(this.scratchB); M.call(qzName);
    M.else_();
    M.localGet(this.scratchB); M.f64ReinterpretI64();
    fastEmit.call(M);
    M.i64ReinterpretF64();
    M.end();
};
Emitter.prototype.emitGuardedOp = function (qzName, fastEmit, cmp) {
    this.m.localSet(this.scratchB);
    this.m.localSet(this.scratchA);
    // guard: 任一操作数是句柄即回退 qz.*（覆盖对象 + 字符串两种句柄）
    this._emitIsHandle(this.scratchA);
    this._emitIsHandle(this.scratchB);
    this.m.i32Or();
    this.m.ifBlock("i64");
    this.m.localGet(this.scratchA); this.m.localGet(this.scratchB); this.m.call(qzName);
    this.m.else_();
    this.m.localGet(this.scratchA); this.m.f64ReinterpretI64();
    this.m.localGet(this.scratchB); this.m.f64ReinterpretI64();
    fastEmit.call(this.m);
    // cmp: 谓词产裸 i32 → tagged bool（0x7FFC|低32=0/1）；与宿主 bool() 对齐（先前 f64 0.0/1.0 与数字混淆）
    if (cmp) this.emitBoxBool(); else this.m.i64ReinterpretF64();
    this.m.end();
};

// 位运算 guard：命中双 number → f64→i32 截断 → 原生 i32 运算 → f64（JS 32 位语义）；
// 任一为句柄 → 回退 qz.<op>（宿主 JS 位运算）。unsigned（>>>）结果按无符号回 f64。
// 压入 i32：该 f64 local 是否在 i32TruncF64S 安全域（非 NaN、|x| < 2^31）。
// JS 位运算用 ToInt32/ToUint32（mod 2^32 环绕、NaN→0）；wasm i32.trunc_f64_s 会 trap，
// 故只对安全域走内联快路径，越界/NaN 交宿主（qz.bor 等已按 JS 语义 toJS|0）。
Emitter.prototype._emitInt32Safe = function (local) {
    const M = this.m;
    M.localGet(local); M.f64ReinterpretI64(); M.f64Const(2147483648); M.f64Lt();   // x < 2^31
    M.localGet(local); M.f64ReinterpretI64(); M.f64Const(-2147483648); M.f64Gt();  // x > -2^31
    M.i32And();
    M.localGet(local); M.f64ReinterpretI64(); M.localGet(local); M.f64ReinterpretI64(); M.f64Eq();   // 非 NaN
    M.i32And();
};
Emitter.prototype.emitGuardedBit = function (qzName, i32op, unsigned) {
    const M = this.m;
    M.localSet(this.scratchB); M.localSet(this.scratchA);
    this._emitIsHandle(this.scratchA); this._emitIsHandle(this.scratchB); M.i32Or();   // 1 个条件值
    this._emitInt32Safe(this.scratchA); M.i32Or();     // 累进合并（此前少一次合并 → 栈上多留 i32）
    this._emitInt32Safe(this.scratchB); M.i32Or();
    M.ifBlock("i64");
    M.localGet(this.scratchA); M.localGet(this.scratchB); M.call(qzName);
    M.else_();
    M.localGet(this.scratchA); M.f64ReinterpretI64(); M.i32TruncF64S();
    M.localSet(this.sT[0]);
    M.localGet(this.scratchB); M.f64ReinterpretI64(); M.i32TruncF64S();
    M.localSet(this.sT[1]);
    M.localGet(this.sT[0]); M.localGet(this.sT[1]); i32op.call(M);
    unsigned ? M.f64ConvertI32U() : M.f64ConvertI32S();
    M.i64ReinterpretF64();
    M.end();
};

// % 专用 guard：命中 number 走 wasm 内 a - trunc(a/b)*b（= JS 余数语义，含负数/除零 NaN），
// 否则回退 qz.rem。f64 无原生 rem，故不复用 emitGuardedOp 的 fastEmit 模型。
Emitter.prototype.emitTaggedRem = function () {
    const M = this.m;
    M.localSet(this.scratchB); M.localSet(this.scratchA);
    this._emitIsHandle(this.scratchA); this._emitIsHandle(this.scratchB); M.i32Or();
    M.ifBlock("i64");
    M.localGet(this.scratchA); M.localGet(this.scratchB); M.call("qz.rem");
    M.else_();
    M.localGet(this.scratchA); M.f64ReinterpretI64(); M.localSet(this.scratchFA);
    M.localGet(this.scratchB); M.f64ReinterpretI64(); M.localSet(this.scratchFB);
    // |b|==Inf → qz.rem（宿主：x % ±Inf = x，含 NaN）
    M.localGet(this.scratchFB); M.f64Neg(); M.localGet(this.scratchFB); M.f64Max();
    M.f64Const(Infinity); M.f64Eq();
    M.ifBlock("i64");
    M.localGet(this.scratchA); M.localGet(this.scratchB); M.call("qz.rem");
    M.else_();
    // q = a/b；q 非有限 → qz.rem（除零、NaN、差溢出）
    M.localGet(this.scratchFA); M.localGet(this.scratchFB); M.f64Div();
    M.i64ReinterpretF64(); M.localSet(this.scratch);    // q → i64 暂存
    M.localGet(this.scratch); M.f64ReinterpretI64();
    M.localGet(this.scratch); M.f64ReinterpretI64(); M.f64Ne();     // qNaN
    M.localGet(this.scratch); M.f64ReinterpretI64(); M.f64Neg();
    M.localGet(this.scratch); M.f64ReinterpretI64(); M.f64Max();    // |q|
    M.f64Const(Infinity); M.f64Eq();                    // |q|==Inf
    M.i32Or();
    M.ifBlock("i64");
    M.localGet(this.scratchA); M.localGet(this.scratchB); M.call("qz.rem");
    M.else_();
    // r = a - b*trunc(q)
    M.localGet(this.scratchFA);
    M.localGet(this.scratchFB);
    M.localGet(this.scratch); M.f64ReinterpretI64(); M.f64Trunc();
    M.f64Mul(); M.f64Sub();
    // 零余数 → qz.rem（宿主保号 -0/+0）
    M.i64ReinterpretF64(); M.localSet(this.scratch);
    M.localGet(this.scratch); M.f64ReinterpretI64(); M.f64Const(0); M.f64Eq();
    M.ifBlock("i64");
    M.localGet(this.scratchA); M.localGet(this.scratchB); M.call("qz.rem");
    M.else_();
    M.localGet(this.scratch);
    M.end();
    M.end();
    M.end();
    M.end();
};
// 属性/索引赋值：值已在栈（i64）。注意会重新求值 receiver（读+写各一次；无副作用表达式安全）。
Emitter.prototype._emitStoreProp = function (left) {
    const M = this.m, t = this._expEnter();       // 值/接收者须存活于嵌套求值
    if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && this.fnNames && this.fnNames.has(left.expression.text)
        && !this.capMap.has(left.expression.text) && this._local(left.expression.text) === undefined
        && !(this.moduleGlobals && this.moduleGlobals.get(left.expression.text) !== undefined)) {
        // 顶层函数作值（宿主函数句柄）：属性写走宿主 qz.prop_set（内存快路径会写到句柄低 32 位 → 静默错/越界）
        M.localSet(t.w);                                  // 值入槽（本分支前未被保存）
        this.emitTaggedExpr(left.expression); M.i32Const(this._strId(left.name.text)); M.localGet(t.w); M.call("qz.prop_set");
        M.localGet(t.w);
        this._expLeave();
        return;
    }
    if (ts.isPropertyAccessExpression(left) && ts.isSuperKeyword(left.expression)) {   // super.v = x：父类 setter 优先，否则按父类字段槽直写
        const parent = this._curClassObj && this._curClassObj.parent;
        if (!parent) throw new Error("[tagged] super.<prop> 仅在派生类方法内可用");
        M.localSet(t.w);
        let owner = parent, acc = null;
        while (owner && !acc) {
            const cl = this.classes.get(owner);
            acc = (cl.methods || []).find(m => m.accessor === "set" && m.name === left.name.text) || null;
            if (!acc) owner = cl.parent;
        }
        if (acc) { this.m.localGet(0); this.m.localGet(t.w); for (let i = 0; i < 3; i++) this._emitUndefined(); this.m.call(methName(owner, acc.name + "$set")); }
        else { this.m.localGet(0); this.m.i32WrapI64(); this.m.localGet(t.w); this.m.i64Store(3, this._fieldIndex(left.name.text)); }
        this.m.localGet(t.w);
        this._expLeave();
        return;
    }
    if (ts.isPropertyAccessExpression(left) && ts.isPrivateIdentifier(left.name) && this._isClassName(left.expression)) {
        // 静态私有字段写 C.#n = v（类名接收者）→ 宿主 static_set（键 = #类名#名，与读路径 _staticKey 一致）
        const cn = this._classOfExpr(left.expression);
        M.localSet(t.w);
        this._emitStaticsGuard(cn);
        M.i32Const(this._strId(cn)); M.i32Const(this._strId(this._staticKey(cn, left.name))); M.localGet(t.w); M.call("qz.static_set");
        M.localGet(t.w);
        this._expLeave();
        return;
    }
    const privName = ts.isPrivateIdentifier(left.name) && this._curClass ? "#" + this._curClass + "#" + left.name.text : null;
    if (privName) {                               // 私有字段写：类名限定名（普通字段槽）
        M.localSet(t.w);
        M.localGet(t.w);                          // 占位顺序修正（值已存）
        this.emitTaggedExpr(left.expression); M.localSet(t.v);
        M.localGet(t.v); M.i32WrapI64(); M.localGet(t.w); M.i64Store(3, this._fieldIndex(privName));
        M.localGet(t.w);
        this._expLeave();
        return;
    }
    // 类静态字段写 C.x = v → 宿主 qz.static_set
    if (this._isClassName(left.expression)) {
        const cn = this._classOfExpr(left.expression);
        const got = this._findStaticAccessor(cn, left.name.text, "set");
        if (got && got.acc) this._checkStaticThis(got.cname, cn, got.acc, left.name.text);
        M.localSet(t.w);                           // 值（i64）
        this._emitStaticsGuard(cn);
        if (got) {                                 // 静态 setter（含继承）→ 直调 __sm_<owner>$<name>$set
            this._emitUndefined();
            M.localGet(t.w);
            for (let i = 0; i < 3; i++) this._emitUndefined();
            M.call(staticMethName(got.cname, got.acc.name + "$set"));
            M.localGet(t.w);
            this._expLeave();
            return;
        }
        this._emitStaticsGuard(cn);               // 写总是落在接收者类（JS：派生的静态属性是自有属性）
        M.i32Const(this._strId(cn)); M.i32Const(this._strId(this._staticKey(cn, left.name))); M.localGet(t.w); M.call("qz.static_set");
        M.localGet(t.w);                           // 赋值表达式返回所赋之值
        this._expLeave();
        return;
    }
    M.localSet(t.w);                              // 值（i64）
    if (this._hasAccessor(left.name.text, "set")) {   // 程序内有该名 setter → 宿主分派（实例经继承链）
        this.emitTaggedExpr(left.expression); M.localSet(t.v);
        M.localGet(t.v); M.i32Const(this._strId(left.name.text)); M.localGet(t.w); M.call("qz.prop_set");
        this._emitErrCheck(false);   // 冻结/不可扩展对象写入 → 抛 TypeError（转入 catch）
        M.localGet(t.w);
        this._expLeave();
        return;
    }
    this.emitTaggedExpr(left.expression);         // obj 句柄
    M.localSet(t.v);
    if (this.usesKeyOrder) {                      // 插入序登记（Object.keys/for-in/JSON 依赖）
        M.localGet(t.v); this._emitStrLitHandle(left.name.text); M.call("qz.field_order");
    }
    if (this.usesFreeze) {                        // freeze/seal/preventExtensions 出现在程序内 → 写前查写保护（strict：抛 TypeError）
        M.localGet(t.v); M.i32Const(this._strId(left.name.text)); M.call("qz.prot_check");
        this._emitErrCheck(false);
    }
    // undefined/null 接收者写属性 → 走 prop_set（host 抛 TypeError，JS 语义）
    M.localGet(t.v); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ff9n); M.i64Eq();
    M.localGet(t.v); M.i32WrapI64(); M.i32Const(8); M.i32LtU(); M.i32And();
    M.ifBlock("void");
    M.localGet(t.v); M.i32Const(this._strId(left.name.text)); M.localGet(t.w); M.call("qz.prop_set");   // undefined/null → host 抛 TypeError
    M.else_();
    // 宿主对象(0x7FFD) → qz.object_set（写 handles[idx][name]）；POJO → wasm 内存 store
    M.localGet(t.v); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffdn); M.i64Eq();
    M.ifBlock("void");
    M.localGet(t.v); M.i32Const(this._strId(left.name.text)); M.localGet(t.w); M.call("qz.object_set");
    M.else_();
    if (this.usesDynAcc) { M.localGet(t.v); M.i32Const(this._strId(left.name.text)); M.localGet(t.w); M.call("qz.prop_set"); }   // 访问器表
    else { M.localGet(t.v); M.i32WrapI64(); M.localGet(t.w); M.i64Store(3, this._fieldIndex(left.name.text)); }
    M.end();
    M.end();
    this._emitErrCheck(false);                    // undefined/null 写属性 → TypeError（转入本函数 catch；链外检查避免嵌套深度问题）
    M.localGet(t.w);                              // 赋值表达式返回所赋之值
    this._expLeave();
};
// `.length=` 赋值：数组(0x7FFB) → qz.arr_set_len（宿主截断/扩容）；其余 → 普通字段存储
// （POJO 恰有 length 字段）。返回所赋之值（JS 语义）。scratch=值, scratchA=接收者（皆 i64）。
Emitter.prototype._emitStoreLength = function (left) {
    const M = this.m;
    M.localSet(this.scratch);                       // 值 → scratch（i64）
    this.emitTaggedExpr(left.expression);           // 接收者
    M.localSet(this.scratchA);
    M.localGet(this.scratchA); M.i64Const(48n); M.i64ShrU();
    M.i64Const(0x7ffbn); M.i64Eq();
    M.ifBlock("void");
    M.localGet(this.scratchA); M.localGet(this.scratch); M.call("qz.arr_set_len"); M.drop();   // 数组：宿主处理
    M.else_();
    M.localGet(this.scratchA); M.i32WrapI64();
    M.localGet(this.scratch); M.i64Store(3, this._fieldIndex("length"));             // 非数组：字段
    M.end();
    M.localGet(this.scratch);                       // 赋值表达式返回所赋之值
};
Emitter.prototype._hasSideEffects = function (n) {
    if (n === undefined || n === null) return false;
    if (ts.isIdentifier(n) || ts.isLiteralExpression(n)) return false;
    if (n.kind === ts.SyntaxKind.SuperKeyword) return false;   // super 是静态引用（无副作用）
    if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword || n.kind === ts.SyntaxKind.NullKeyword) return false;
    if (ts.isPropertyAccessExpression(n)) return this._hasSideEffects(n.expression);
    if (ts.isElementAccessExpression(n)) return this._hasSideEffects(n.expression) || this._hasSideEffects(n.argumentExpression);
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) return this._hasSideEffects(n.expression);
    if (ts.isPrefixUnaryExpression(n) && (n.operator === ts.SyntaxKind.PlusToken || n.operator === ts.SyntaxKind.MinusToken)) return this._hasSideEffects(n.operand);
    return true;
};
Emitter.prototype._emitStoreElem = function (left, preObj, preKey) {
    const M = this.m, t = this._expEnter();       // 值/键/接收者须存活于嵌套求值
    M.localSet(t.w);                              // 值（i64）
    if (preKey !== undefined) { M.localGet(preKey); M.localSet(t.v); } else { this.emitTaggedExpr(left.argumentExpression); M.localSet(t.v); }   // 键
    M.localGet(t.v); this._emitIsStr();
    M.ifBlock("void");
    if (preObj !== undefined) { M.localGet(preObj); M.localSet(t.x); } else { this.emitTaggedExpr(left.expression); M.localSet(t.x); }
    if (this.usesKeyOrder) { M.localGet(t.x); M.localGet(t.v); M.call("qz.field_order"); }   // 插入序登记
    M.localGet(t.x); M.localGet(t.v); M.localGet(t.w); M.call("qz.set_index");   // 字符串键 → 宿主
    this._emitErrCheck(false);   // 冻结/不可扩展对象写入 → 抛 TypeError（转入 catch）
    M.else_();
    if (preObj !== undefined) { M.localGet(preObj); M.localSet(t.x); } else { this.emitTaggedExpr(left.expression); M.localSet(t.x); }
    M.localGet(t.x); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
    M.ifBlock("void");                                             // wasm 数组 + 数值键
    this._emitInt32Safe(t.v);
    M.ifBlock("void");
    M.localGet(t.v); M.f64ReinterpretI64(); M.i32TruncF64S(); M.localSet(t.a);
    M.localGet(t.a); M.localGet(t.x); M.i32WrapI64(); M.i32Load(2, 0); M.i32LtU();
    M.ifBlock("void");
    M.localGet(t.x); M.i32WrapI64(); M.i32Load(2, 8);
    M.localGet(t.a); M.i32Const(8); M.i32Mul(); M.i32Add();
    M.localGet(t.w); M.i64Store(3, 0);
    M.else_();
    M.localGet(t.x); M.localGet(t.v); M.localGet(t.w); M.call("qz.arr_set_index"); M.drop();   // 越界 → 扩容（JS 语义）
    M.end();
    M.else_();
    M.localGet(t.x); M.localGet(t.v); M.localGet(t.w); M.call("qz.arr_set_index"); M.drop();
    M.end();
    M.else_();
    M.localGet(t.x); M.localGet(t.v); M.localGet(t.w); M.call("qz.set_index");       // 其它接收者 → 宿主
    this._emitErrCheck(false);   // 冻结/不可扩展对象写入 → 抛 TypeError（转入 catch）
    M.end();
    M.end();
    M.localGet(t.w);                              // 返回所赋之值
    this._expLeave();
};
// undefined = 句柄 0x7FF9|0（qzvm handles[0]=undefined）
Emitter.prototype._emitUndefined = function () { this.m.i64ConstBits(0, 0x7ff90000); };
// null = 句柄 0x7FF9|1（qzvm handles[1]=null 固定槽）。与 undefined 区分：typeof/宽松 == 语义不同。
Emitter.prototype._emitNull = function () { this.m.i64ConstBits(1, 0x7ff90000); };
Emitter.prototype._emitArrayPush = function (rx, arg, hv) {
    const M = this.m;
    const t = this._expEnter();                               // 接收者/值用可重入槽（arg 求值可能覆盖 scratch）
    if (hv !== undefined) M.localGet(hv); else this.emitTaggedExpr(rx); M.localSet(t.v);   // 数组句柄（hv = 调用点已求值）
    void rx;
    this.emitTaggedExpr(arg); M.localSet(t.w);                // 待压值
    M.localGet(t.v); M.i32WrapI64(); M.localSet(t.a);         // h
    M.localGet(t.a); M.i32Load(2,0);                          // len
    M.localGet(t.a); M.i32Load(2,4);                          // cap
    M.i32GeS();
    M.ifBlock();
      M.localGet(t.a); M.i32Load(2,4); M.i32Eqz();            // cap==0
      M.ifBlock("i32"); M.i32Const(4); M.else_();
        M.localGet(t.a); M.i32Load(2,4); M.i32Const(2); M.i32Mul();
      M.end();
      M.localSet(t.b);                                        // newCap
      M.globalGet(0); M.localSet(t.c);                        // newData = bump
      emitBumpSet(M, () => { M.globalGet(0); M.localGet(t.b); M.i32Const(8); M.i32Mul(); M.i32Add(); });   // bump += newCap*8
      M.localGet(t.c);                                        // dest
      M.localGet(t.a); M.i32Load(2,8);                        // src = oldData
      M.localGet(t.a); M.i32Load(2,0); M.i32Const(8); M.i32Mul();   // n = len*8
      M.call("qzs_memcpy");
      M.localGet(t.a); M.localGet(t.c); M.i32Store(2,8);      // header.dataOff = newData
      M.localGet(t.a); M.localGet(t.b); M.i32Store(2,4);      // header.cap = newCap
    M.end();
    M.localGet(t.a); M.i32Load(2,8);                          // dataOff
    M.localGet(t.a); M.i32Load(2,0); M.i32Const(8); M.i32Mul(); M.i32Add();
    M.localGet(t.w); M.i64Store(3,0);                         // data[len] = val
    M.localGet(t.a);
    M.localGet(t.a); M.i32Load(2,0); M.i32Const(1); M.i32Add(); M.i32Store(2,0);   // len++
    M.localGet(t.a); M.i32Load(2,0);
    M.f64ConvertI32U(); M.i64ReinterpretF64();                // 返回新长度（number）
    this._expLeave();
};
// a.pop()：空 → undefined；否则取末元素 + len--。
Emitter.prototype._emitArrayPop = function (rx, hv) {
    const M = this.m;
    const t = this._expEnter();
    if (hv !== undefined) M.localGet(hv); else this.emitTaggedExpr(rx); M.localSet(t.v);
    void rx;
    M.localGet(t.v); M.i32WrapI64(); M.localSet(t.a);         // h
    M.localGet(t.a); M.i32Load(2,0); M.i32Eqz();
    M.ifBlock("i64");
      this._emitUndefined();
    M.else_();
      M.localGet(t.a); M.i32Load(2,0); M.i32Const(1); M.i32Sub(); M.localSet(t.b);   // i = len-1
      M.localGet(t.a); M.localGet(t.b); M.i32Store(2,0);
      M.localGet(t.a); M.i32Load(2,8);                        // dataOff
      M.localGet(t.b); M.i32Const(8); M.i32Mul(); M.i32Add();
      M.i64Load(3,0);
    M.end();
    this._expLeave();
};
// x.method(...)：字符串/通用方法经 qz.str_method(recv, nameId, a0, a1) 回退（正确处理 UTF-8）。
// 结果 = 句柄（字符串 toJS 还原；数值方法如 charCodeAt/indexOf 结果亦 join handles 表 → toJS 为 number）。
// 箭头/函数表达式求值：bump 分配 [funcidx:i32][nCaps:i32][cell×N]，
// 捕获变量逐个求值存入 cell，返回句柄 0x7FF9|off。
Emitter.prototype._emitLambdaNew = function (lam) {
    const M = this.m;
    let meta = this._lamById.get(lam);
    if (!meta) {                                   // 惰性登记（合成箭头/访问器闭包，不在预扫描列表内）
        this._lamAuto = (this._lamAuto || 0) + 1;
        this.emitLambda(lam, "x" + this._lamAuto);
        meta = this._lamById.get(lam);
    }
    const fidx = this.m._funcIdx[meta.fname];
    // 闭包值 = [funcidx:i32][envIdx:i32][arity:i32][nameStrId:i32]（envIdx=0 表示无捕获）；捕获值不再拷贝（共享环境）。
    emitBumpAlloc(M, () => M.i32Const(16));           // → off(i32)（越界 trap）
    M.localSet(this.cloOff);
    M.localGet(this.cloOff); M.i32Const(fidx); M.i32Store(2, 0);
    M.localGet(this.cloOff); (this.envRef !== undefined ? M.localGet(this.envRef) : M.i32Const(0)); M.i32Store(2, 4);
    M.localGet(this.cloOff); M.i32Const(lam.parameters ? lam.parameters.length : 0); M.i32Store(2, 8);
    M.localGet(this.cloOff); M.i32Const(lam.name && ts.isIdentifier(lam.name) ? this._strId(lam.name.text) : -1); M.i32Store(2, 12);
    M.localGet(this.cloOff); M.i64ExtendI32U();
    M.i64ConstBits(0, 0x7fff0000); M.i64Or();
};
// 类实例分配：size 覆盖全局字段表最大偏移（+8 头），clsId 写 [0]；返回 self 句柄。
// 把 [base+8, base+size) 的槽逐个写为 undefined 句柄（POJO/实例字段「未赋值」表示；循环避免展开膨胀）。
Emitter.prototype._emitFillUndef = function (size) {
    const M = this.m, t = this._expEnter();
    M.localSet(t.a);                                                     // base(i32) ← 栈顶
    M.localGet(t.a); M.i32Const(8); M.i32Add(); M.localSet(t.c);         // p = base + 8
    M.localGet(t.a); M.i32Const(size); M.i32Add(); M.localSet(t.b);      // end = base + size
    M.block("void"); M.loop("void");
    M.localGet(t.c); M.localGet(t.b); M.i32GeU(); M.brIf(1);             // p >= end → 出循环
    M.localGet(t.c); M.i64ConstBits(0, 0x7ff90000); M.i64Store(3, 0);
    M.localGet(t.c); M.i32Const(8); M.i32Add(); M.localSet(t.c);
    M.br(0);
    M.end(); M.end();
    this._expLeave();
};
Emitter.prototype._instSize = function () {
    return ((this.fieldMap ? this.fieldMap.size : 0) + 1) * 8;
};
Emitter.prototype._emitNewCall = function (e, argSrc) {
    const M = this.m;
    let tgt = e.expression;                                  // new (C as any)(…) / new (C)() 亦按类名解析
    while (tgt && (ts.isParenthesizedExpression(tgt) || ts.isAsExpression(tgt) || ts.isNonNullExpression(tgt)
        || ts.isTypeAssertionExpression(tgt) || ts.isSatisfiesExpression(tgt))) tgt = tgt.expression;
    if (!ts.isIdentifier(tgt)) throw new Error("[tagged] new 目标必须是标识符");
    const cname = this._className(tgt.text);   // 导入类本地名 → 目标类名
    // 内建类（Error/Map/Set/Date/Array/RegExp/…）→ 宿主 qz.builtin（构造语义）；未登记者报错
    if (!this.classes.has(cname)) {
        if (EMITTER_BUILTIN_CTORS.has(tgt.text)) { this._emitBuiltinCall(tgt.text, e.arguments); return; }
        {   // 动态类值（类表达式工厂 / 变量持有类）：运行时取类对象 → 宿主按 __qzClsId 建实例
            const resolvable = this._local(tgt.text) !== undefined || this.capMap.has(tgt.text)
                || (this.moduleGlobals && this.moduleGlobals.has(tgt.text))
                || (ts.isPropertyAccessExpression(e.expression));
            if (resolvable) {
                const M2 = this.m, tg2 = this._expEnter();
                this.emitTaggedExpr(tgt); M2.localSet(tg2.w);        // 类对象 → 槽（先求值，避免嵌套副作用）
                M2.localGet(tg2.w);                                  // 参数序：obj, a0..a3
                for (let i = 0; i < 4; i++) {
                    if (i < e.arguments.length) this.emitTaggedExpr(e.arguments[i]); else this._emitUndefined();
                }
                M2.call("qz.new_dynamic");
                this._expLeave();
                return;
            }
        }
        throw new Error(BUILTIN_GLOBALS.has(tgt.text)
            ? `[tagged] 内建类 ${tgt.text} 未实现（支持 Error 族/Map/Set/Date/Array/RegExp）`
            : "[tagged] new 未知类: " + tgt.text);
    }
    const c = this.classes.get(cname);
    if (this._dynParentExpr(c)) this._emitStaticsGuard(cname);   // 动态父：构造前先建立运行时父链（statics guard 内）
    const args = e.arguments;
    if (args.length > 4) throw new Error("[tagged] new 最多 4 参");
    const te = this._expEnter();                            // 实例 off / ctor 实参用可重入槽（嵌套 new 不覆盖）
    { const argSlots = [te.w, te.x, te.y, te.z];   // self 占 te.v，实参用 w/x/y/z
      for (let i = 0; i < 4; i++) {
        if (argSrc) argSrc(i);                                    // 实参来自运行期数组（new C(...args)）
        else if (i < args.length) this.emitTaggedExpr(args[i]);
        else this._emitUndefined();
        M.localSet(argSlots[i]);
      } }
    // 内联 bump 分配（与 POJO/数组同款）：避免 qz.newobj 跨界 + BigInt 装箱（构造热路径）。
    // 布局：offset 8 对齐，[off]=clsId(i32)，字段槽由 ctor 写。
    M.globalGet(0); M.i32Const(7); M.i32Add(); M.i32Const(-8); M.i32And();   // off=(bump+7)&~7
    M.localSet(te.a);
    emitBumpSet(M, () => { M.localGet(te.a); M.i32Const(this._instSize()); M.i32Add(); });   // bump = off+size（越界 trap）
    M.localGet(te.a);
    M.i32Const(c.id); M.i32Store(2, 0);                     // [0]=clsId
    M.localGet(te.a); M.i32Const(this._instSize()); M.i32Store(2, 4);   // [4]=size（供宿主物化）
    M.localGet(te.a); this._emitFillUndef(this._instSize());   // 槽 = undefined（未赋值字段）
    M.localGet(te.a); M.i64ExtendI32U(); M.i64ConstBits(0, 0x7ffe0000); M.i64Or();   // 实例句柄 = 0x7FFE|offset（专用 tag，与 POJO 0x7FF9 区分，供 instanceof）
    M.localSet(te.v);                                       // self 句柄（受保护）
    M.localGet(te.v);
    for (let i = 0; i < 4; i++) M.localGet([te.w, te.x, te.y, te.z][i]);
    M.call(ctorName(cname));                                // 写 __cls、字段、执行体
    this._emitErrCheck(false);                              // 构造器 void：检查 __err 但不留值
    M.localGet(te.v);                                       // 表达式值 = 实例
    this._expLeave();
};
// super(...)：在构造器内，self=local0。调父 ctor 后回写本类字段默认值（JS 派生字段初始化序）。
Emitter.prototype._emitSuperCall = function (c, args) {
    const M = this.m;
    if (!c.parent) throw new Error("[tagged] " + c.name + " 无父类，super() 非法");
    if (args.length > 4) throw new Error("[tagged] super 最多 4 参");
    for (let i = 0; i < 4; i++) {
        if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
        M.localSet(this.cloArgs[i]);
    }
    M.localGet(0);
    for (let i = 0; i < 4; i++) M.localGet(this.cloArgs[i]);
    M.call(ctorName(c.parent));
    this._emitFieldDefaults(c);                             // 子类字段默认值在 super 之后
};
// 合成派生 ctor：local1..4 = 补齐后的参数槽，原样转发给父 ctor。
Emitter.prototype._emitClassValue = function (c) {        // 类对象句柄：动态父 → class_value_dyn(id, 父表达式)；否则 class_value(id)
    const M = this.m;
    if (c.captured && c.captured.length) {                 // 类方法捕获：创建点(外围作用域活动)复制其值到类 env，存 statics @@qzEnv（总是存 → 方法侧索引一定合法）
        const envT = this._expEnter();
        M.i32Const(-1); M.call("qz.env_new"); M.localSet(envT.v);
        for (const n0 of c.captured) {
            if (!(this._isCapturable(n0) || (this.moduleGlobals && this.moduleGlobals.get(n0) !== undefined))) continue;
            const idNode = ts.factory.createIdentifier(n0);
            idNode.pos = c.id; idNode.end = c.id;
            M.localGet(envT.v); M.i32WrapI64(); M.i32Const(this._strId(n0));   // env_def 首参 = handles 索引(i32)
            this.emitTaggedExpr(idNode);
            M.call("qz.env_def");
        }
        M.i32Const(this._strId(c.name)); M.i32Const(this._strId("@@qzEnv")); M.localGet(envT.v); M.call("qz.static_set");
        this._expLeave();
    }
    M.i32Const(c.id);
    const dynN = this._dynParentExpr(c);
    if (dynN) { this.emitTaggedExpr(dynN); M.call("qz.class_value_dyn"); return; }
    M.call("qz.class_value");
};
Emitter.prototype._dynParentExpr = function (c) {          // 动态父：extends 非「已知类名/内建」→ 返回父表达式（否则 null）
    if (!c || !c.dynParentNode) return null;
    const n = c.dynParentNode;
    if (ts.isIdentifier(n) && (this.classes.has(this._className(n.text)) || BUILTIN_GLOBALS.has(n.text) || EMITTER_BUILTIN_CTORS.has(n.text))) return null;
    return n;
};
Emitter.prototype._emitSuperCallForward = function (c) {
    const M = this.m;
    if (this._dynParentExpr(c)) {                           // 动态父（mixin）：宿主按运行时父链转发 ctor
        M.i32Const(c.id);
        for (let i = 0; i <= 4; i++) M.localGet(i);
        M.call("qz.super_ctor");
        this._emitFieldDefaults(c);
        return;
    }
    M.localGet(0);
    for (let i = 1; i <= 4; i++) M.localGet(i);
    M.call(ctorName(c.parent));
    this._emitFieldDefaults(c);
};
// 内建全局调用/常量：nameId + n(实际参数个数) + a0..a3（缺省 undefined）→ qz.builtin → i64。
Emitter.prototype._emitBuiltinCall = function (name, args) {
    const M = this.m;
    M.i32Const(this._strId(name));
    M.i32Const(args.length);
    for (let i = 0; i < 4; i++) {
        if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
    }
    {   // ovf：实参 3..（>4 实参的内建，如 Math.max(a,b,c,d,e)）；未超出时为空数组（宿主按 arity 截断）
        const ovfA = args.length > 3 ? args.slice(3) : [];
        if (ovfA.some(a2 => ts.isSpreadElement(a2))) throw new Error("[tagged] " + name + " 的溢出实参与展开混用暂不支持");
        const lit = ts.factory.createArrayLiteralExpression(ovfA);
        lit.pos = args.length ? args[0].pos : 0; lit.end = args.length ? args[args.length - 1].end : 0;
        this.emitTaggedExpr(lit);
    }
    M.call("qz.builtin");
    this._emitErrCheck();          // 内建可能抛（JSON 循环引用/解析失败/类型错）→ 转入本函数 catch（try 内）
};
// 动态方法分派：method_call(recv, mid, a0..a3) → i64（qz 侧按 recv 类型派发：字符串→str_method；
// 类实例（内存[0]=__cls）→ classMeta 沿继承链调 wasm 导出方法）。未知类型/无方法 → 宿主抛错。
// 方法直调实参：self + 前 4 槽（不足补 undefined）；形参 >4 → 追加 ovf 数组（含实参 3，与闭包 ABI 同款）；
// rest 收尾形参（索引 <4）→ 尾部实参打包为数组落在该槽。
Emitter.prototype._emitMethodArgs = function (params, args) {
    const M = this.m;
    const n = params ? params.length : 0;
    const restIdx = (n && params[n - 1] && params[n - 1].dotDotDotToken) ? n - 1 : -1;
    if (restIdx >= 4) throw new Error("[tagged] rest 形参在索引 ≥4 的方法未支持");
    for (let i = 0; i < 4; i++) {
        if (i === restIdx) {
            const tail = args.slice(i);
            if (tail.some(a2 => ts.isSpreadElement(a2))) throw new Error("[tagged] rest 与展开实参混用暂不支持");
            const lit0 = ts.factory.createArrayLiteralExpression(tail);
            lit0.pos = args.length ? args[0].pos : 0; lit0.end = args.length ? args[args.length - 1].end : 0;
            this.emitTaggedExpr(lit0);
        } else if (i < args.length) this.emitTaggedExpr(args[i]);
        else this._emitUndefined();
    }
    if (n > 4) {
        const ovfA = args.slice(3);
        if (ovfA.some(a2 => ts.isSpreadElement(a2))) throw new Error("[tagged] 方法调用的溢出实参与展开混用暂不支持");
        const lit = ts.factory.createArrayLiteralExpression(ovfA);
        lit.pos = args.length ? args[0].pos : 0; lit.end = args.length ? args[args.length - 1].end : 0;
        this.emitTaggedExpr(lit);
    }
};
Emitter.prototype._emitDynMethod = function (rx, method, args) {
    const M = this.m;
    if (/^#[^#]+$/.test(method)) {                      // 私有方法：类名限定（PrivateIdentifier.text 自带 #）
        const cnP = ts.isIdentifier(rx) ? this._className(rx.text) : this._curClass;
        if (cnP) method = "#" + cnP + "#" + method;
    }
    // 静态方法 C.m(...)：类名不是变量 → 沿继承链找 static 方法 owner，直调 __sm_<Owner>$<m>
    // （self 传 undefined 占位；静态方法体不用 this）。
    if (this._isClassName(rx)) {                                  // 显式类名（含 as/括号/静态方法内 this）→ 静态方法直调
        const cnS = this._classOfExpr(rx);
        let owner = cnS;
        while (owner && !(this.classes.get(owner).staticMethods || []).some(s => s.name === method)) owner = this.classes.get(owner).parent;
        if (!owner) throw new Error(`[tagged] 静态方法 ${cnS}.${method}() 未定义`);
        this._checkStaticThis(owner, cnS, (this.classes.get(owner).staticMethods || []).find(s => s.name === method), method);
        this._emitStaticsGuard(cnS);
        this._emitUndefined();
        this._emitMethodArgs(((this.classes.get(owner).staticMethods || []).find(s => s.name === method) || {}).node ? (this.classes.get(owner).staticMethods || []).find(s => s.name === method).node.parameters : null, args);
        M.call(staticMethName(owner, method));
        return;
    }
    const cls = this._staticRecvClass(rx);
    if (cls) {
        const owner = this._methodOwner(cls, method);
        const meta = owner && this._classMethodMeta(owner, method);
        // 仅直调有返回值、非 setter 的普通方法；void/setter 语义与动态路径不同（动态返回 i64），退回。
        const voidRet = meta && !!meta.node.type && meta.node.type.kind === ts.SyntaxKind.VoidKeyword;
        if (owner && meta && !meta.accessor && !voidRet) {   // getter/setter 走动态路径（getter 需先取值再调用）
            // 纯值栈：self + 4 参按形参序压栈（实参可为嵌套调用，天然按深度隔离，无需暂存槽）。
            this.emitTaggedExpr(rx);                                // self
            this._emitMethodArgs(meta.node.parameters, args);
            M.call(methName(owner, method));
            return;
        }
    }
    {   // 类 getter 作被调目标：x.p() ≡ (取值 x.p)()（如 get m(){ return () => … }）
        if (this._hasAccessor(method, "get")) {   // 全局 getter 名集合（rx 静态可判时更精确，见 _classOfExpr）
            const pacc = ts.factory.createPropertyAccessExpression(rx, ts.factory.createIdentifier(method));
            pacc.pos = rx.pos; pacc.end = rx.end;
            this._emitValueCall(pacc, args, rx);
            return;
        }
    }
    // 动态：压 recv + mid + 4 参入值栈（实参可为嵌套调用，无暂存槽覆盖问题）。
    this.emitTaggedExpr(rx);
    M.i32Const(this._strId(method));
    for (let i = 0; i < 4; i++) {
        if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
    }
    {   // ovf：实参 4..（被调形参 >4 时由宿主按其 arity 解包；否则忽略）
        const ovfA = args.slice(3);   // 与闭包 ABI 同款：ex[0] = 实参 3（已在 a3）
        if (ovfA.some(a2 => ts.isSpreadElement(a2))) throw new Error("[tagged] 方法调用的溢出实参与展开混用暂不支持");
        const lit = ts.factory.createArrayLiteralExpression(ovfA);
        lit.pos = args.length ? args[0].pos : 0; lit.end = args.length ? args[args.length - 1].end : 0;
        this.emitTaggedExpr(lit);
    }
    M.call("qz.method_call");
    this._emitErrCheck();          // 宿主方法可能抛出（如空数组 reduce）→ 转入本函数 catch
};
Emitter.prototype.emitTaggedBinary = function (e) {
    const op = e.operatorToken.kind;
    // 未实现的二元运算符：先于操作数求值报错（否则右操作数如类名 A 会先崩「未定义捕获变量: A」）
    if (op === ts.SyntaxKind.InstanceOfKeyword) {
        // a instanceof C：C 须为用户类（内建类不支持）→ qz.instanceof_op(a, clsId) → tagged bool
        const right = e.right;
        if (ts.isIdentifier(right) && /^(Array|Object|String|Number|Boolean|Function|Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|RegExp|Date|Map|Set|Promise|WeakMap|WeakSet)$/.test(right.text)
            && !this.classes.has(this._className(right.text))) {
            // 内建类：宿主按 tag/物化判定（Array/Object/String/Number/Boolean/Function…）
            this.emitTaggedExpr(e.left);
            this.m.i32Const(this._strId(right.text));
            this.m.call("qz.instanceof_builtin");
            this.emitBoxBool();
            return;
        }
        {   // 动态右值（类表达式变量 / mixin 结果 / 内建值）：运行时宿主判定（用户类 → 运行时父链；内建 → 按名回退）
            const dynR = !this.classes.has(this._className(right.text))   // 已知类名 → 静态路径（模块级类亦会登记为 moduleGlobals，勿误判）
                && (ts.isPropertyAccessExpression(right)
                    || ts.isCallExpression(right)
                    || (ts.isIdentifier(right) && (this._local(right.text) !== undefined || this.capMap.has(right.text)
                        || (this.moduleGlobals && this.moduleGlobals.get(right.text) !== undefined))));
            if (dynR) {
                const M2 = this.m, t2 = this._expEnter();
                this.emitTaggedExpr(e.left); M2.localSet(t2.v);
                this.emitTaggedExpr(right); M2.localSet(t2.w);
                M2.localGet(t2.v); M2.localGet(t2.w);
                M2.call("qz.instanceof_dyn");
                this._expLeave();
                return;
            }
        }
        if (!ts.isIdentifier(right) || !this.classes.has(this._className(right.text))) {
            throw new Error(right && BUILTIN_GLOBALS.has(right.text)
                ? `[tagged] 内建类 ${right.text} 的 instanceof 未实现`
                : "[tagged] instanceof 右操作数须为用户类");
        }
        this.emitTaggedExpr(e.left);
        this.m.i32Const(this.classes.get(this._className(right.text)).id);
        this.m.call("qz.instanceof_op");
        return;
    }
    if (op === ts.SyntaxKind.InKeyword) {
        // k in o → qz.in_op（宿主语义；POJO/实例由 toJS 物化）
        this.emitTaggedExpr(e.left); this.emitTaggedExpr(e.right); this.m.call("qz.in_op"); return;
    }
    if (op === ts.SyntaxKind.CommaToken) { this.emitTaggedExpr(e.left); this.m.drop(); this.emitTaggedExpr(e.right); return; }
    if (op === ts.SyntaxKind.FirstAssignment) {
        // 解构赋值 [a,b] = rhs / ({x} = rhs)：RHS 求值一次 → 逐目标读取 + 写入（结果 = RHS）
        if (ts.isArrayLiteralExpression(e.left) || ts.isObjectLiteralExpression(e.left)) {
            const M = this.m, t = this._expEnter();
            this.emitTaggedExpr(e.right); M.localSet(t.x);
            if (ts.isArrayLiteralExpression(e.left)) {
                let i = 0;
                for (const el of e.left.elements) {
                    if (ts.isOmittedExpression(el)) { i++; continue; }
                    if (!ts.isIdentifier(el)) throw new Error("[tagged] 解构赋值目标仅支持标识符");
                    this._emitElemOf(t.x, ts.factory.createNumericLiteral(i));
                    this._emitVarStore(el.text, this.scratchB); M.drop();
                    i++;
                }
            } else {
                for (const p of e.left.properties) {
                    if (!ts.isPropertyAssignment(p)) throw new Error("[tagged] 解构赋值仅支持 {key: target} 形式");
                    const key = ts.isIdentifier(p.name) ? p.name.text : (ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : null);
                    const target = ts.isIdentifier(p.initializer) ? p.initializer.text : null;
                    if (key === null || target === null) throw new Error("[tagged] 解构赋值仅支持标识符目标");
                    this._emitPropReadFromLocal(t.x, key);
                    this._emitVarStore(target, this.scratchB); M.drop();
                }
            }
            M.localGet(t.x);                      // 赋值表达式结果 = RHS
            this._expLeave();
            return;
        }
        if (ts.isPropertyAccessExpression(e.left)) {
            if (e.left.name.text === "length") { this.emitTaggedExpr(e.right); this._emitStoreLength(e.left); return; }
            if (!ts.isSuperKeyword(e.left.expression) && this._hasSideEffects(e.left.expression) && this._hasSideEffects(e.right))
                throw new Error("[tagged] 属性赋值 o.f = v 中 o 带副作用且 RHS 亦带副作用：求值顺序未实现（JS 先 obj 后 v）");   // RHS 无副作用时可安全按现有顺序
            this.emitTaggedExpr(e.right); this._emitStoreProp(e.left); return;
        }
        if (ts.isElementAccessExpression(e.left)) {
            const M = this.m;
            if (this._hasSideEffects(e.left.expression) || this._hasSideEffects(e.left.argumentExpression)) {
                const t1 = this._expEnter(), t2 = this._expEnter();          // 分层槽：与 _emitStoreElem 内部的临时槽互不重叠
                this.emitTaggedExpr(e.left.expression); M.localSet(t1.x);     // JS 顺序：obj → key → v
                this.emitTaggedExpr(e.left.argumentExpression); M.localSet(t2.x);
                this.emitTaggedExpr(e.right);
                this._emitStoreElem(e.left, t1.x, t2.x);
                this._expLeave(); this._expLeave();
                return;
            }
            this.emitTaggedExpr(e.right); this._emitStoreElem(e.left); return;
        }
        this.emitTaggedExpr(e.right);
        this._emitVarStore(e.left.text, this.scratchB); return;   // 含闭包捕获
    }
    const COMPOUND = {
        [ts.SyntaxKind.PlusEqualsToken]: ts.SyntaxKind.PlusToken,
        [ts.SyntaxKind.MinusEqualsToken]: ts.SyntaxKind.MinusToken,
        [ts.SyntaxKind.AsteriskEqualsToken]: ts.SyntaxKind.AsteriskToken,
        [ts.SyntaxKind.SlashEqualsToken]: ts.SyntaxKind.SlashToken,
        [ts.SyntaxKind.PercentEqualsToken]: ts.SyntaxKind.PercentToken,
        [ts.SyntaxKind.LessThanLessThanEqualsToken]: ts.SyntaxKind.LessThanLessThanToken,
        [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanToken,
        [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
        [ts.SyntaxKind.AmpersandEqualsToken]: ts.SyntaxKind.AmpersandToken,
        [ts.SyntaxKind.BarEqualsToken]: ts.SyntaxKind.BarToken,
        [ts.SyntaxKind.CaretEqualsToken]: ts.SyntaxKind.CaretToken,
        [ts.SyntaxKind.AsteriskAsteriskEqualsToken]: ts.SyntaxKind.AsteriskAsteriskToken,
    };
    if (COMPOUND[op] !== undefined) {
        if (ts.isPropertyAccessExpression(e.left)) {
            this.emitTaggedExpr(e.left); this.emitTaggedExpr(e.right); this._emitBinOp(COMPOUND[op]);
            this._emitStoreProp(e.left); return;
        }
        if (ts.isElementAccessExpression(e.left)) {
            this.emitTaggedExpr(e.left); this.emitTaggedExpr(e.right); this._emitBinOp(COMPOUND[op]);
            if (this._hasSideEffects(e.left.expression) || this._hasSideEffects(e.left.argumentExpression))
                throw new Error("[tagged] 元素复合赋值 o[带副作用] op= v 的求值顺序未实现");
            this._emitStoreElem(e.left); return;
        }
        if (COMPOUND[op] === ts.SyntaxKind.PlusToken) this._concatInPlace = this._concatSafe(e.left);
        this._emitVarGet(e.left.text); this.emitTaggedExpr(e.right);
        this._emitBinOp(COMPOUND[op]);
        this._emitVarStore(e.left.text, this.scratchB); return;
    }
    if (op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
        // a ||= b → a = a || b（值语义短路，与 emitShortCircuit 一致）；a &&= b → a = a && b
        // 支持字段/索引目标（与 ??= 同款：接收者读+写各求值一次，无副作用表达式安全）
        const isAnd2 = op === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
        if (ts.isPropertyAccessExpression(e.left)) {
            if (e.left.name.text === "length") { this.emitShortCircuit(isAnd2, e.left, e.right); this._emitStoreLength(e.left); return; }
            if (this._hasSideEffects(e.left.expression))
                throw new Error("[tagged] 属性逻辑赋值 o.f ||=/&&= v 中 o 带副作用：求值顺序未实现");
            this.emitShortCircuit(isAnd2, e.left, e.right); this._emitStoreProp(e.left); return;
        }
        if (ts.isElementAccessExpression(e.left)) {
            if (this._hasSideEffects(e.left.expression) || this._hasSideEffects(e.left.argumentExpression))
                throw new Error("[tagged] 元素逻辑赋值 o[带副作用] ||=/&&= v 的求值顺序未实现");
            this.emitShortCircuit(isAnd2, e.left, e.right); this._emitStoreElem(e.left); return;
        }
        this.emitShortCircuit(isAnd2, e.left, e.right);
        this._emitVarStore(e.left.text, this.scratchB); return;
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        this.emitShortCircuit(op === ts.SyntaxKind.AmpersandAmpersandToken, e.left, e.right);
        return;
    }
    // ?? / ??=：真短路 + 值语义（JS 精确）。a ?? b = nullish(a) ? b : a。
    if (op === ts.SyntaxKind.QuestionQuestionToken) {
        this.emitNullish(e.left, e.right);
        return;
    }
    if (op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
        // a ??= b ≡ a = a ?? b（同样支持字段/索引；接收者读+写各求值一次，无副作用表达式安全）
        if (ts.isPropertyAccessExpression(e.left)) {
            if (e.left.name.text === "length") { this.emitNullish(e.left, e.right); this._emitStoreLength(e.left); return; }
            this.emitNullish(e.left, e.right); this._emitStoreProp(e.left); return;
        }
        if (ts.isElementAccessExpression(e.left)) {
            if (this._hasSideEffects(e.left.expression) || this._hasSideEffects(e.left.argumentExpression))
                throw new Error("[tagged] 元素空值合并赋值 o[带副作用] ??= v 的求值顺序未实现");
            this.emitNullish(e.left, e.right); this._emitStoreElem(e.left); return;
        }
        this.emitNullish(e.left, e.right);
        this._emitVarStore(e.left.text, this.scratchB); return;
    }
    // 拼接左操作数来历 → 是否允许原地追加（_emitConcat 内部读 _concatInPlace）
    if (op === ts.SyntaxKind.PlusToken) this._concatInPlace = this._concatSafe(e.left);
    this.emitTaggedExpr(e.left); this.emitTaggedExpr(e.right);
    this._emitBinOp(op);
};
// 短路逻辑（值语义，真短路）：结果留 tagged i64。
//  && : truthy(a) ? b : a；|| : truthy(a) ? a : b
Emitter.prototype.emitShortCircuit = function (isAnd, left, right) {
    const M = this.m;
    M.block("i64");                                  // block (result i64)
    this.emitTaggedExpr(left);                       // [a]
    M.localSet(this.scratch);                        // []
    M.localGet(this.scratch);                        // [a]（跳转时作块结果）
    M.localGet(this.scratch); M.call("qz.truthy");   // [a, i32 ]
    if (isAnd) M.i32Eqz();                           // && : falsy(a) → 1
    M.brIf(0);                                       // 条件真 → 跳出块，[a] 为结果
    M.drop();                                        // 落下路径丢弃 a → []
    this.emitTaggedExpr(right);                      // 真短路：仅此路径求值 right
    M.end();
};
// 空值合并（??，真短路 + 值语义）：a ?? b = nullish(a) ? b : a。
// nullish 判定走宿主 qz.is_nullish（a == null || a == undefined）：null 在宿主侧是独立
// handles[idx] 句柄（bitsOf 不归一），wasm 内无法仅按 TAG|0 比对 —— 宿主 toJS 精确判。
Emitter.prototype.emitNullish = function (left, right) {
    const M = this.m;
    M.block("i64");                                  // block (result i64)
    this.emitTaggedExpr(left);                       // [a]
    M.localSet(this.scratch);                        // []
    M.localGet(this.scratch);                        // [a]（非空时作块结果）
    M.localGet(this.scratch); M.call("qz.is_nullish");  // [a, isNullish(i32)]
    M.i32Eqz();                                      // [a, !isNullish]
    M.brIf(0);                                       // 非 nullish → 跳出，[a] 为结果
    M.drop();                                        // nullish → 丢弃 a
    this.emitTaggedExpr(right);                      // 真短路：仅此路径求值 right
    M.end();
};
// 操作数已在栈上 [a, b]；按 op 发射运算
Emitter.prototype._emitBinOp = function (op) {
    const G = (qz, f64op, cmp) => () => this.emitGuardedOp(qz, f64op, cmp);
    const GUARD = {
        [ts.SyntaxKind.PlusToken]: () => this._emitConcat(),   // 任一操作数 0x7FFA → wasm 内拼接，否则数值（inPlace 由调用点设置）
        [ts.SyntaxKind.MinusToken]: G("qz.sub", this.m.f64Sub),
        [ts.SyntaxKind.AsteriskToken]: G("qz.mul", this.m.f64Mul),
        [ts.SyntaxKind.SlashToken]: G("qz.div", this.m.f64Div),
        [ts.SyntaxKind.PercentToken]: () => this.emitTaggedRem(),   // f64 无原生 rem → a - trunc(a/b)*b
        [ts.SyntaxKind.LessThanToken]: G("qz.lt", this.m.f64Lt, true),
        [ts.SyntaxKind.GreaterThanToken]: G("qz.gt", this.m.f64Gt, true),
        [ts.SyntaxKind.LessThanEqualsToken]: G("qz.le", this.m.f64Le, true),
        [ts.SyntaxKind.GreaterThanEqualsToken]: G("qz.ge", this.m.f64Ge, true),
        [ts.SyntaxKind.EqualsEqualsToken]: G("qz.eq", this.m.f64Eq, true),
        [ts.SyntaxKind.EqualsEqualsEqualsToken]: G("qz.seq", this.m.f64Eq, true),
        [ts.SyntaxKind.ExclamationEqualsToken]: G("qz.ne", this.m.f64Ne, true),
        [ts.SyntaxKind.ExclamationEqualsEqualsToken]: G("qz.sne", this.m.f64Ne, true),
        [ts.SyntaxKind.AmpersandToken]: () => this.emitGuardedBit("qz.band", this.m.i32And, false),
        [ts.SyntaxKind.BarToken]: () => this.emitGuardedBit("qz.bor", this.m.i32Or, false),
        [ts.SyntaxKind.CaretToken]: () => this.emitGuardedBit("qz.bxor", this.m.i32Xor, false),
        [ts.SyntaxKind.LessThanLessThanToken]: () => this.emitGuardedBit("qz.shl", this.m.i32Shl, false),
        [ts.SyntaxKind.GreaterThanGreaterThanToken]: () => this.emitGuardedBit("qz.shr", this.m.i32ShrS, false),
        [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken]: () => this.emitGuardedBit("qz.ushr", this.m.i32ShrU, true),
    };
    if (GUARD[op]) { GUARD[op](); return; }
    const map = {
        [ts.SyntaxKind.PlusToken]: "qz.add", [ts.SyntaxKind.MinusToken]: "qz.sub",
        [ts.SyntaxKind.AsteriskToken]: "qz.mul", [ts.SyntaxKind.SlashToken]: "qz.div",
        [ts.SyntaxKind.PercentToken]: "qz.rem",
        [ts.SyntaxKind.AsteriskAsteriskToken]: "qz.pow",   // ** 无原生 f64.pow → 总走宿主
    };
    if (map[op]) { this.m.call(map[op]); return; }
    throw new Error("[tagged] 不支持的运算符: " + ts.SyntaxKind[op]);
};
Emitter.prototype._taggedOpFor = function (binKind) {
    const m = { Add: "qz.add", Subtract: "qz.sub", Asterisk: "qz.mul", Slash: "qz.div", Percent: "qz.rem" };
    return m[binKind] || "qz.add";
};

module.exports = { compileTS, Emitter };

if (require.main === module) {
    const input = process.argv[2];
    const out = process.argv[3] || "/tmp/out.wasm";
    const opts = { needMathFloor: true };
    const r = compileTS(input, out, opts);
    console.log("wrote", out, fs.statSync(out).size, "bytes; imports:", r.module.imports.length, "funcs:", r.module.funcs.length, "strings:", r.strings.length);
}