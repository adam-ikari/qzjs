// 差分审计语料（第四十四批）：P4 语义角落收敛——try/finally 控制流、arguments 继承、
// 方法形参默认值、super 数据属性语义、工厂类静态成员的捕获与动态访问。
// 本轮修复的静默错值：
//   1) 嵌套箭头读 `arguments` 曾报 undefined —— 现由内层函数把全量实参数组种进 env
//      （函数表达式有自有 arguments；箭头继承外层函数的）。
//   2) 对象字面量方法/访问器/函数表达式合成闭包时只保留形参名 → 默认值/解构/rest 丢失；
//      现沿用原始 ParameterDeclaration 节点。
//   3) `super.v`（父类数据字段）曾读到字段值 —— JS 语义里数据属性只在实例上，原型链读为
//      undefined；父方法作值无法物化 → loud。
//   4) 静态方法/getter/setter 捕获工厂局部：self 是类值，env 取法改用 class_env_get_static
//      （宿主动态类值经 ctor.__qzClsId；C 档类值低 32 位即 clsId）。宿主档同时把静态访问器
//      装到类对象上，支持 `const C = mk(); C.g` 的动态读取。
// in-module 档动态类值的静态成员已实现（按 clsId 查 classMeta + g_statics：静态方法/
// 静态 getter/setter/静态字段读写/字段删除）；其余「把接收者当普通对象」的原语
// （下标键、k in C、String(C)、Object.* 反射）物化类值会拿 clsId 当内存基址读垃圾
// → 一律 loud（qz_dyncls_loud / qz_clsval_loud），见 cross_tier 探针 dynwork.ts。
module.exports = [
  { name: "finally-break-loop", fn: "run", ts: `
export function run() { let log = ""; for (let i = 0; i < 5; i++) { try { if (i === 2) break; log += i; } finally { log += "f" + i; } } return log; }`, args: [] },
  { name: "finally-continue-loop", fn: "run", ts: `
export function run() { let log = ""; for (let i = 0; i < 4; i++) { try { if (i % 2 === 0) continue; log += "b" + i; } finally { log += "f" + i; } } return log; }`, args: [] },
  { name: "finally-labeled-break", fn: "run", ts: `
export function run() { let log = ""; outer: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { try { if (i === 1 && j === 1) break outer; log += i + "" + j; } finally { log += "x"; } } } return log; }`, args: [] },
  { name: "finally-labeled-continue", fn: "run", ts: `
export function run() { let log = ""; outer: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { try { if (j === 1) continue outer; log += i + "" + j; } finally { log += "y"; } } } return log; }`, args: [] },
  { name: "finally-labeled-continue-single", fn: "run", ts: `
export function run() { let log = ""; outer: for (let i = 0; i < 3; i++) { try { if (i === 1) continue outer; log += "a"; } finally { log += "f"; } } return log; }`, args: [] },
  { name: "finally-continue-while", fn: "run", ts: `
export function run() { let i = 0, log = ""; while (i < 4) { i++; try { if (i === 2) continue; log += i; } finally { log += "w"; } } return log; }`, args: [] },
  { name: "finally-return-override-log", fn: "run", ts: `
export function run() { let log = ""; function f() { try { return "r"; } finally { log += "fin"; } } const v = f(); return v + log; }`, args: [] },
  { name: "finally-return-then-throw", fn: "run", ts: `
export function run() { function f() { try { return 1; } finally { throw "x"; } } try { f(); return "no"; } catch (e) { return "caught:" + e; } }`, args: [] },
  { name: "arguments-in-closure", fn: "run", ts: `
export function run() { function f(a: number, b: number) { const g = () => arguments[0] + arguments[1]; return g(); } return f(2, 3); }`, args: [] },
  { name: "arguments-nested-arrow", fn: "run", ts: `
export function run() { function f(a: number, b: number) { const g = () => () => arguments[0] * arguments[1]; return g()(); } return f(2, 3); }`, args: [] },
  { name: "arguments-arrow-in-fn-expr", fn: "run", ts: `
export function run() { const f = function (a: number, b: number) { const g = () => arguments.length; return g(); }; return f(4, 5, 6); }`, args: [] },
  { name: "method-param-default-this", fn: "run", ts: `
class C { v: number = 5; m(x: number = this.v) { return x; } }
export function run() { const c: any = new C(); return c.m() + c.m(2); }`, args: [] },
  { name: "object-method-param-default-this", fn: "run", ts: `
export function run() { const o: any = { v: 3, m(x: number = this.v) { return x; } }; return o.m(); }`, args: [] },
  { name: "object-method-default-destructure", fn: "run", ts: `
export function run() { const o: any = { v: 3, m({ a, b = this.v }: any) { return a + b; } }; return o.m({ a: 1 }); }`, args: [] },
  { name: "object-method-rest-param", fn: "run", ts: `
export function run() { const o: any = { m(a: number, ...rest: number[]) { return a + rest.length + rest[0]; } }; return o.m(1, 2, 3); }`, args: [] },
  { name: "fn-expr-default-param-capture", fn: "run", ts: `
export function run() { const base = 9; const f = function (x: number = base) { return x; }; return f(); }`, args: [] },
  { name: "class-expr-method-default-capture", fn: "run", ts: `
function mk(n: number) { return class { m(x: number = n) { return x; } }; }
const C = mk(6);
export function run() { const c: any = new C(); return c.m(); }`, args: [] },
  { name: "super-prop-field-init", fn: "run", ts: `
class A { v: number = 7; }
class B extends A { w: number = super.v; }
export function run() { const b: any = new B(); return b.w; }`, args: [] },
  { name: "super-prop-data-in-method", fn: "run", ts: `
class A { v: number = 7; }
class B extends A { m() { return super.v === undefined ? "u" : "d"; } }
export function run() { const b: any = new B(); return b.m(); }`, args: [] },
  { name: "super-prop-unset-in-method", fn: "run", ts: `
class A { }
class B extends A { m() { return String(super.nope); } }
export function run() { const b: any = new B(); return b.m(); }`, args: [] },
  { name: "super-getter-in-method", fn: "run", ts: `
class A { get g() { return 4; } }
class B extends A { m() { return super.g + 1; } }
export function run() { const b: any = new B(); return b.m(); }`, args: [] },
  { name: "class-expr-extends-captured-base", fn: "run", ts: `
function mk(B: any, extra: number) { return class extends B { m() { return super.m() + extra; } }; }
class A { m() { return 10; } }
const C = mk(A, 5);
export function run() { const c: any = new C(); return c.m(); }`, args: [] },
  { name: "static-method-factory-capture", fn: "run", ts: `
function mk(n: number) { return class { static sm() { return n + 1; } }; }
const C = mk(7);
export function run() { return C.sm(); }`, args: [] },
  { name: "static-getter-factory-capture", fn: "run", ts: `
function mk(n: number) { return class { static get g() { return n; } }; }
const C = mk(9);
export function run() { return C.g; }`, args: [] },
  { name: "static-setter-factory-capture", fn: "run", ts: `
function mk(n: number) { return class { static get g() { return stash; } static set g(v: number) { stash = v + n; } }; }
let stash = 0;
const C = mk(100);
export function run() { (C as any).g = 5; return (C as any).g; }`, args: [] },
  { name: "static-method-this-factory", fn: "run", ts: `
function mk(n: number) { return class { static f() { return n + 1; } static g() { return (this as any).f() + 1; } }; }
const C = mk(7);
export function run() { return (C as any).g(); }`, args: [] },
  { name: "class-expr-instanceof-clones", fn: "run", ts: `
function mk() { return class {}; }
const A = mk(); const B = mk();
export function run() { const a: any = new A(); return (a instanceof A) + ":" + (a instanceof B); }`, args: [] },
  { name: "class-expr-getset-shared-cell", fn: "run", ts: `
function mk() { let v = 0; return class { get x() { return v; } set x(n: number) { v = n; } }; }
const C = mk();
export function run() { const c: any = new C(); const d: any = new C(); c.x = 5; d.x = 9; return c.x + ":" + d.x; }`, args: [] },
  { name: "class-expr-from-method-capture", fn: "run", ts: `
class Outer { v: number = 2; make(n: number) { return class { m() { return n; } }; } }
export function run() { const o: any = new Outer(); const C = o.make(8); return new C().m(); }`, args: [] },
  { name: "defineproperty-accessor-capture", fn: "run", ts: `
export function run() { const base = 10; const o: any = {}; Object.defineProperty(o, "v", { get: () => base }); return o.v; }`, args: [] },
  { name: "object-getter-shared-cell", fn: "run", ts: `
function mk() { let v = 1; return { get x() { return v; }, set x(n: number) { v = n; } }; }
const o: any = mk();
export function run() { o.x = 4; return o.x; }`, args: [] },
  { name: "destructure-sibling-default", fn: "run", ts: `
export function run() { const o: any = { a: 2 }; const { a, b = a * 3 } = o; return a + b; }`, args: [] },
  { name: "builtin-subclass-array", fn: "run", ts: `
class L extends Array<number> { sum() { let s = 0; for (let i = 0; i < this.length; i++) s += this[i]; return s; } }
export function run() { const l: any = new L(); l.push(1); l.push(2); return l.sum() + ":" + l.length + ":" + (l instanceof L); }`, args: [], unsupported: "内建子类 Array 的元素/方法访问（实例不是真数组，push/length 走不通）" },
  { name: "builtin-subclass-map", fn: "run", ts: `
class M extends Map<string, number> { get2(k: string) { return this.get(k); } }
export function run() { const m: any = new M(); m.set("a", 1); return m.get2("a") + ":" + (m instanceof Map); }`, args: [], unsupported: "内建子类 Map 的内建方法调用" },
  { name: "class-expr-computed-method-capture", fn: "run", ts: `
function mk(name: string, n: number) { return class { [name]() { return n; } }; }
const C = mk("go", 4);
export function run() { const c: any = new C(); return c.go(); }`, args: [], unsupported: "类计算属性名方法（非 Symbol.<well-known>）" },
  { name: "closure-in-static-block-loud", fn: "run", ts: `
function mk(n: number) { return class { static { const f = () => n; } }; }
const C = mk(3);
export function run() { new C(); return 1; }`, args: [], unsupported: "静态块间接捕获工厂局部（经 lambda）" },
  { name: "super-method-as-value", fn: "run", ts: `
class A { m() { return 1; } }
class B extends A { f() { const g = super.m; return typeof g; } }
export function run() { const b: any = new B(); return b.f(); }`, args: [], unsupported: "super.<method> 作值引用（父方法无法物化为可调用值）" },
  { name: "dynamic-parent-super-read", fn: "run", ts: `
function mk(B: any) { return class extends B { m() { return super.v; } }; }
class A { v: number = 7; }
const C = mk(A);
export function run() { const c: any = new C(); return c.m(); }`, args: [], unsupported: "动态父类下 super.<prop> 读取（父类运行期才解析）" },
  { name: "dynamic-parent-super-assign", fn: "run", ts: `
function mk(B: any) { return class extends B { m() { super.v = 2; return 1; } }; }
class A { v: number = 7; }
const C = mk(A);
export function run() { const c: any = new C(); return c.m(); }`, args: [], unsupported: "动态父类下 super.<prop> 赋值" },
  { name: "class-method-arguments", fn: "run", ts: `
class C { m(a: number) { return arguments[0]; } }
export function run() { return new C().m(3); }`, args: [] },
  // ── 类方法/静态方法内的 arguments（本轮实现）───────────────────────────────
  // 通道：调用点把「全量实参」构造成数组一次求值后写 __args，callee 入口读入本地并消费即清；
  // 值槽从数组回读（越界 → undefined）。类体恒严格模式 → arguments 非映射，数组承载即等价。
  { name: "class-args-length", fn: "run", ts: `
class C { m(a: number, b?: number) { return arguments.length; } }
export function run() { const c = new C(); return c.m(1, 2) + "/" + c.m(1) + "/" + c.m(); }`, args: [] },
  { name: "class-args-beyond-formals", fn: "run", ts: `
class C { m(a: number) { return String(arguments[1]) + "/" + arguments.length; } }
export function run() { return new C().m(7, 8, 9); }`, args: [] },
  { name: "class-args-more-than-four", fn: "run", ts: `
class C { m(a: number) { return arguments.length + ":" + String(arguments[4]); } }
export function run() { return new C().m(1, 2, 3, 4, 5); }`, args: [] },
  { name: "class-args-forof", fn: "run", ts: `
class C { m() { let s = ""; for (const x of arguments) s += String(x); return s; } }
export function run() { return new C().m("a", "b", "c"); }`, args: [] },
  { name: "class-args-eval-once", fn: "run", ts: `
let n = 0;
function bump() { n++; return 5; }
class C { m(x: number) { return arguments[0] + ":" + arguments.length; } }
export function run() { const v = new C().m(bump()); return v + "/n=" + n; }`, args: [] },
  { name: "class-args-default-excluded", fn: "run", ts: `
class C { m(a: number = 1) { return arguments.length + ":" + a; } }
export function run() { const c = new C(); return c.m() + "/" + c.m(4); }`, args: [] },
  { name: "class-args-destructure-formal", fn: "run", ts: `
class C { m({ p }: { p: number }) { return arguments.length + ":" + p + ":" + String((arguments[0] as any).p); } }
export function run() { return new C().m({ p: 6 }); }`, args: [] },
  { name: "static-method-arguments", fn: "run", ts: `
class C { static m(a: number) { return arguments.length + ":" + String(arguments[1]); } }
export function run() { return C.m(1, 2); }`, args: [] },
  { name: "class-args-inherited-owner", fn: "run", ts: `
class A { m(a: number) { return arguments.length + ":" + arguments[0]; } }
class B extends A { }
export function run() { const b = new B(); return b.m(9); }`, args: [] },
  { name: "class-args-via-this-direct", fn: "run", ts: `
class A { m(a: number): number { return this.n(a); } n(x: number): number { return arguments.length + x; } }
export function run() { return new A().m(2); }`, args: [] },
  { name: "class-args-arrow-capture", fn: "run", ts: `
class C { m(a: number) { const f = () => String(arguments[0]) + "/" + arguments.length; return f(); } }
export function run() { return new C().m(3, 4); }`, args: [] },
  // 已知窄面（编译期 loud）：被调类方法拿不到实参个数的派发形态 + 构造器/访问器无 provider。
  { name: "class-args-dyn-dispatch", fn: "run", ts: `
class C { m(a: number) { return arguments[0]; } }
function h(o: any) { return o.m(3); }
export function run() { return h(new C()); }`, args: [], unsupported: "宿主动态派发下的类方法 arguments（接收者静态不可判）" },
  { name: "class-args-extracted-value", fn: "run", ts: `
class C { m(a: number) { return arguments[0]; } }
export function run() { const c: any = new C(); const g = c.m; return g(3); }`, args: [], unsupported: "方法取成值再调用（经 closure_call/call_value，无实参个数）" },
  { name: "class-args-spread-call", fn: "run", ts: `
class C { m(a: number) { return arguments[0]; } }
export function run() { const c = new C(); const r = [3]; return c.m(...r); }`, args: [], unsupported: "展开实参调用（实参数组在宿主侧，两档宿主写不了产物 __args）" },
  { name: "class-args-void-method", fn: "run", ts: `
class C { k = 0; m(a: number): void { this.k = arguments.length; } }
export function run() { const c = new C(); c.m(1); return c.k; }`, args: [], unsupported: ": void 方法退回宿主动态派发 → 无 arguments provider" },
  { name: "class-args-rest-formal", fn: "run", ts: `
class C { m(a: number, ...r: number[]) { return arguments.length; } }
export function run() { return new C().m(1, 2); }`, args: [], unsupported: "arguments 与 rest 形参混用（尾部实参被打包进槽，逐槽值不可得）" },
  { name: "class-args-many-formals", fn: "run", ts: `
class C { m(a: number, b: number, c: number, d: number, e: number) { return arguments.length; } }
export function run() { return new C().m(1, 2, 3, 4, 5); }`, args: [], unsupported: "arguments 与 >4 形参混用（溢出实参经 $ovf，无逐槽值可读）" },
  { name: "class-args-ctor", fn: "run", ts: `
class C { k: number; constructor(a: number) { this.k = arguments.length; } }
export function run() { return new C(1).k; }`, args: [], unsupported: "构造器内的 arguments（无 provider）" },
  { name: "class-args-getter", fn: "run", ts: `
class C { get p() { return arguments.length; } }
export function run() { const c = new C(); return (c as any).p; }`, args: [], unsupported: "访问器内的 arguments（无 provider）" },
  { name: "static-getter-factory-capture-alias", fn: "run", ts: `
function mk(n: number) { const K = class { static get g() { return n; } }; return K; }
const C = mk(9);
export function run() { return C.g; }`, args: [], unsupported: "const K = class 别名形式（类值不物化），捕获工厂局部 → 编译期 loud" },
  { name: "cls-expr-method-capture-modlocal", fn: "f", ts: `export function f(): any { let lab = "L"; const K: any = class { m(): any { return lab; } }; return new K().m(); }`, args: [], unsupported: "const K = class 别名形式（类值不物化），方法体捕获模块顶层局部 → 编译期 loud" },
  { name: "cls-expr-getter-capture-modlocal", fn: "g", ts: `export function g(): any { let lab = "G"; const K: any = class { get label(): any { return lab; } }; return new K().label; }`, args: [], unsupported: "const K = class 别名形式（类值不物化），访问器捕获模块顶层局部 → 编译期 loud" },
  // 内建宿主承载（两档一致）：构造器名连普通调用也构造；实例为宿主对象；
  // instanceof 走 Symbol.hasInstance + 原型链（旧 C 实现把 symbol 当函数调 → 恒 false）。
  { name: "host-map-ops", fn: "run", ts: `
export function run(): any { const m = new Map(); m.set("a", 1); m.set("b", 2); return m.get("a") + ":" + m.size + ":" + (m instanceof Map); }`, args: [] },
  { name: "host-set-iter", fn: "run", ts: `
export function run(): any { const s = new Set([1, 2, 2]); let n = 0; for (const x of s) n += x; return n + ":" + s.has(3); }`, args: [] },
  { name: "host-date", fn: "run", ts: `
export function run(): any { const d = new Date(0); d.setUTCFullYear(2000); return d.getUTCFullYear() + ":" + (d instanceof Date); }`, args: [] },
  { name: "host-regexp", fn: "run", ts: `
export function run(): any { const r = new RegExp("a+"); return r.test("baaa") + ":" + r.source; }`, args: [] },
  { name: "host-ctor-plain-call", fn: "run", ts: `
export function run(): any { const m: any = Map(); return m.size + ":" + (m instanceof Map); }`, args: [] },
  { name: "host-error-catch-instanceof", fn: "run", ts: `
export function run(): any { try { JSON.parse("{"); return "no-throw"; } catch (e) { return "caught:" + (e instanceof SyntaxError) + ":" + (e instanceof Error) + ":" + e.name; } }`, args: [] },
  // require-object-constructor：Map/Set/WeakMap/WeakSet/Proxy 无 [[Call]] → 普通调用一律
  // 可捕获 TypeError；new 形态经 builtin_fn + new_dynamic（construct 与 call 在 ABI 上可分）。
  { name: "host-ctor-plain-call-args", fn: "run", ts: `
export function run(): any { const m: any = Map([["a", 1]]); return m.size; }`, args: [] },
  { name: "host-ctor-plain-caught", fn: "run", ts: `
export function run(): any { try { const s: any = Set(); return "no-throw:" + s; } catch (e: any) { return "caught:" + (e instanceof TypeError) + ":" + e.message; } }`, args: [] },
  { name: "host-ctor-alias-plain", fn: "run", ts: `
export function run(): any { const C: any = Map; return C(); }`, args: [] },
  // 未用实参槽是 undefined 句柄，必须视为「未提供」：new Date() ≠ new Date(undefined)。
  { name: "host-date-noarg", fn: "run", ts: `
export function run(): any { const d: any = new Date(); return Number.isNaN(d.getTime()) + ":" + (d instanceof Date); }`, args: [] },
  { name: "host-array-noarg", fn: "run", ts: `
export function run(): any { const a: any = new Array(); return a.length + ":" + Array.isArray(a); }`, args: [] },
  // 已知偏差（两档一致）：显式 undefined 实参与缺省实参在 4 槽 ABI 上不可分，
  // 故 new Array(undefined) 得 length 0（真 JS 为 1）。登记以免两档再度分叉。
  { name: "host-array-undef-slot", fn: "run", ts: `
export function run(): any { const a: any = new Array(undefined); return a.length; }`, args: [] },
  { name: "host-new-spread-empty", fn: "run", ts: `
export function run(): any { const xs: any = []; const d: any = new Date(...xs); return Number.isNaN(d.getTime()) + ":" + (d instanceof Date); }`, args: [] },
  // 普通调用按各内建自己的 [[Call]]：Date(x) 产字符串（规范），Error/RegExp 的 [[Call]] 等价 construct。
  { name: "host-date-plain-call", fn: "run", ts: `
export function run(): any { const s: any = Date(0); return typeof s + ":" + (s instanceof Date); }`, args: [] },
  { name: "host-error-plain-call", fn: "run", ts: `
export function run(): any { const e: any = Error("m"); return typeof e.message + ":" + (e instanceof Error) + ":" + String(e).slice(0, 8); }`, args: [] },
  { name: "host-regexp-plain-call", fn: "run", ts: `
export function run(): any { const r: any = RegExp("a+"); return r.test("baaa") + ":" + (r instanceof RegExp) + ":" + r.source; }`, args: [] },
];
