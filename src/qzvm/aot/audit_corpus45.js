// 差分审计语料（第四十五批）：类静态字段的「类键」与静态方法内 this 的接收者语义。
// 本轮修复的静默错值：
//   1) in-module（C 档）静态字段表以 clsId 为类键，静态初始化写入却用类名 strId →
//      `this.x`（static_get_dyn 按 clsId 查）在 strId(类名)≠clsId 时静默读 0。
//      现两档统一经 _staticClassKey（C 档 clsId / 独立档类名 strId）。
//   2) 静态方法/访问器内 this.x 的接收者是运行时代（B 继承 A.m 时 this = B）：
//      写 this.x 曾落到定义类 A（A/B 双错）→ 新增 static_set_dyn 写接收者自有静态；
//      C 档 static_get_dyn 曾不沿父链查 → 派生类读父类静态字段静默 0。
//   3) 静态 getter/setter 直调路径 self 曾传 undefined（setter 内 this.x 写无效）；
//      且只初始化接收者自身的静态 → 父链字段未初始化（undefined）。现 self = 接收者类、
//      守卫覆盖整条父链（_emitStaticsChainGuard）。
//   4) this.#n（静态方法内私有静态）曾按实例字段槽读 → 静默 undefined；现走
//      static_get_dyn(#定义类#名)。
// 类表达式的静态字段/静态块：静态表按类名共享且只初始化一次，但类表达式每次求值、
// 嵌套 class 每次进入定义点都应有独立静态状态 → 此前静默串味/读不到初值；
// 现仅支持模块顶层 `const/let C = class {…}`（求值一次、类名稳定），其余编译期 loud。
module.exports = [
  { name: "static-plain-this-after-preceding-class", fn: "run", ts: `
class B { static y = 1; }
class A { static x = 5; static getX() { return this.x; } }
export function run() { return A.getX() + B.y; }`, args: [] },
  { name: "static-getter-plain-this", fn: "run", ts: `
class A { static x = 5; static get g() { return this.x + 1; } }
export function run() { return A.g; }`, args: [] },
  { name: "static-plain-this-write-read", fn: "run", ts: `
class A { static x = 5; static setX(v: number) { this.x = v; } static getX() { return this.x; } }
export function run() { A.setX(9); return A.getX() + ":" + A.x; }`, args: [] },
  { name: "static-inherited-field-via-this", fn: "run", ts: `
class A { static x = 5; static getX() { return this.x; } }
class B extends A {}
export function run() { return B.getX(); }`, args: [] },
  { name: "static-this-write-derived-own", fn: "run", ts: `
class A { static x = 1; static setX(v: number) { this.x = v; } }
class B extends A {}
export function run() { B.setX(9); return A.x + ":" + B.x; }`, args: [] },
  { name: "static-this-compound-derived", fn: "run", ts: `
class A { static x = 2; static add(v: number) { this.x += v; } }
class B extends A {}
export function run() { B.add(5); return A.x + ":" + B.x; }`, args: [] },
  { name: "static-this-inc-derived", fn: "run", ts: `
class A { static x = 2; static bump() { this.x++; ++this.x; return this.x; } }
class B extends A {}
export function run() { const r = B.bump(); return A.x + ":" + B.x + ":" + r; }`, args: [] },
  { name: "static-inherited-getter", fn: "run", ts: `
class A { static x = 5; static get g() { return this.x + 1; } }
class B extends A {}
export function run() { return B.g; }`, args: [] },
  { name: "static-inherited-setter-this-write", fn: "run", ts: `
class A { static x = 0; static set g(v: number) { this.x = v + 1; } static get g() { return this.x; } }
class B extends A {}
export function run() { (B as any).g = 4; return A.x + ":" + B.x + ":" + (B as any).g; }`, args: [] },
  { name: "private-static-class-read", fn: "run", ts: `
class A { static #n = 5; static sum() { return A.#n; } }
export function run() { return A.sum(); }`, args: [] },
  { name: "private-static-this-read", fn: "run", ts: `
class A { static #n = 5; static get() { return this.#n; } }
export function run() { return A.get(); }`, args: [] },
  { name: "private-static-this-write-read", fn: "run", ts: `
class A { static #n = 5; static set(v: number) { this.#n = v; } static get() { return this.#n; } }
export function run() { A.set(9); return A.get(); }`, args: [] },
  { name: "private-static-second-class", fn: "run", ts: `
class B { static y = 1; }
class A { static #n = 5; static sum() { return A.#n + B.y; } }
export function run() { return A.sum(); }`, args: [] },
  { name: "static-inc-dec-fields", fn: "run", ts: `
class A { static x = 1; static y = 10; }
export function run() { A.x++; ++A.y; A.x--; return A.x + ":" + A.y; }`, args: [] },
  { name: "top-alias-class-expr-static", fn: "run", ts: `
const C = class { static x = 5; static m() { return this.x + 1; } static get g() { return this.x + 2; } };
export const D = class { static x = 6; };
let E = class { static x = 7; };
export function run() { C.x = 10; E.x += 1; return C.m() + ":" + C.g + ":" + D.x + ":" + E.x; }`, args: [] },
  { name: "top-named-class-expr-static", fn: "run", ts: `
const C = class Inner { static x = 5; static m() { return this.x; } };
export function run() { return C.x + ":" + C.m(); }`, args: [] },
  { name: "factory-class-static-field-loud", fn: "run", ts: `
function mk() { return class { static x = 5; }; }
const C = mk();
export function run() { return (C as any).x; }`, args: [], unsupported: "类表达式静态字段（动态访问读不到初值）" },
  { name: "factory-class-static-block-loud", fn: "run", ts: `
function mk() { return class { static y: any; static { this.y = 9; } }; }
const C = mk();
export function run() { return (C as any).y; }`, args: [], unsupported: "类表达式静态块（动态访问读不到初值）" },
  { name: "factory-class-static-method-this-loud", fn: "run", ts: `
function mk() { return class { static x = 5; static m() { return this.x; } }; }
const C = mk();
export function run() { return (C as any).m(); }`, args: [], unsupported: "类表达式静态字段 + 静态方法 this（守卫不触发）" },
  { name: "alias-in-fn-static-loud", fn: "run", ts: `
function mk() { const K = class { static x = 5; }; return K.x; }
export function run() { return mk(); }`, args: [], unsupported: "函数内 const K = class 的静态字段（多次求值共享静态）" },
  { name: "nested-class-static-field-loud", fn: "run", ts: `
function mk() { class K { static x = 5; } return new K() && K.x; }
export function run() { return mk(); }`, args: [], unsupported: "嵌套 class 声明的静态字段（每次进入定义点应重新初始化）" },
  { name: "nested-class-static-block-loud", fn: "run", ts: `
function mk() { class K { static x: any; static { this.x = 5; } } return K.x; }
export function run() { return mk(); }`, args: [], unsupported: "嵌套 class 声明的静态块（每次进入定义点应重新初始化）" },
  { name: "object-prop-class-static-loud", fn: "run", ts: `
const o: any = { C: class { static x = 5; } };
export function run() { return o.C.x; }`, args: [], unsupported: "对象属性位置的类表达式静态字段（动态访问读不到初值）" },
];
