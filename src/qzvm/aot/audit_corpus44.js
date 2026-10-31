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
// in-module 档动态类值的成员访问整体未实现（低 32 位是 clsId 不是实例 offset），
// 已改为 loud（qz_dyncls_loud），见 static-getter-factory-capture 在 C 侧的行为说明。
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
export function run() { return new C().m(3); }`, args: [], unsupported: "类方法内的 arguments（方法体无 arguments provider）" },
  { name: "static-getter-factory-capture-alias", fn: "run", ts: `
function mk(n: number) { const K = class { static get g() { return n; } }; return K; }
const C = mk(9);
export function run() { return C.g; }`, args: [], unsupported: "const K = class 别名形式（类值不物化），捕获工厂局部 → 编译期 loud" },
];
