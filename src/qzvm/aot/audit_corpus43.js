// 差分审计语料（第四十三批）：类/对象字面量方法的**作用域边界**与类捕获 env。
// 修复两处静默错值：
//   1) `_collectLocals` 曾下探类体与对象字面量方法体 —— 方法内同名 `let n` 被当成外层
//      函数的局部，varMap 后写覆盖参数槽（工厂类 `m(){ let n = 5 } o2(){ return n }`
//      里 `o2` 读到 0 而非工厂参数 7；对象字面量方法/访问器同病）。
//   2) `_capturesOf` 曾把类型注解里的 interface/类型参数名当运行期自由变量捕获。
// 同批把「类被提升后读不到定义点外层局部」的形状从静默 undefined 改为 loud（见 unsupported）。
module.exports = [
  { name: "factory-method-capture", fn: "run", ts: `function mk(n: number) { return class { m() { return n; } }; }
const C = mk(7);
export function run() { return new C().m(); }`, args: [] },
  { name: "factory-instances-independent", fn: "run", ts: `function mk(n: number) { return class { m() { return n; } }; }
const A = mk(1); const B = mk(2);
export function run() { return new A().m() * 10 + new B().m(); }`, args: [] },
  { name: "factory-field-capture", fn: "run", ts: `function mk(n: number) { return class { x: any = n; }; }
const C = mk(7);
export function run() { return new C().x; }`, args: [] },
  { name: "factory-field-plus-closure", fn: "run", ts: `function mk(n: number) { return class { x: any = n; m(p: number) { const f = () => p; return this.x + f(); } }; }
const C = mk(10);
export function run() { return new C().m(3); }`, args: [] },
  { name: "factory-mixed-closure-and-outer", fn: "run", ts: `function mk(n: number) { return class { m(p: number) { const f = () => p; return n + f(); } }; }
const C = mk(10);
export function run() { return new C().m(3); }`, args: [] },
  { name: "factory-shadow-local-read-outer", fn: "run", ts: `function mk(n: number) { return class { m() { let n = 5; n = n + 1; return n; } get o() { return n; } }; }
const C = mk(7);
export function run() { const c = new C(); return String(c.m() * 100 + c.o); }`, args: [] },
  { name: "factory-shadow-param-read-outer", fn: "run", ts: `function mk(n: number) { return class { m(n: number) { return n + 1; } get o() { return n; } }; }
const C = mk(7);
export function run() { const c = new C(); return String(c.m(1) * 100 + c.o); }`, args: [] },
  { name: "factory-shadow-local-simple", fn: "run", ts: `function mk(n: number) { return class { m() { let n = 5; n = n + 1; return n; } o2() { return n; } }; }
const C = mk(7);
export function run() { const c = new C(); return String(c.m()) + "," + String(c.o2()); }`, args: [] },
  { name: "object-method-local-shadows-param", fn: "run", ts: `function mk(n: number) { const o = { m() { let n = 5; return n; } }; return o.m() + n; }
export function run() { return mk(7); }`, args: [] },
  { name: "object-getter-local-shadows-param", fn: "run", ts: `function mk(n: number) { const o = { get v() { let n = 2; return n; } }; return o.v + n; }
export function run() { return mk(7); }`, args: [] },
  { name: "type-annotation-in-lambda", fn: "run", ts: `interface Shape { a: number; }
export function run() { const mk = (x: number): number => { const p: Shape = { a: x }; return p.a; }; return mk(9); }`, args: [] },
  { name: "class-type-params", fn: "run", ts: `class Box<T> { v: T; constructor(v: T) { this.v = v; } get(): T { return this.v; } }
export function run() { const b: any = new Box(10); return b.get(); }`, args: [] },
  { name: "nested-class-reads-module-const", fn: "run", ts: `const base = 3;
function mk() { class K { m() { return base; } } return new K().m(); }
export function run() { return mk(); }`, args: [] },
  { name: "alias-class-reads-module-const", fn: "run", ts: `const base = 5;
function mk() { const C = class { m() { return base; } }; return new C().m(); }
export function run() { return mk(); }`, args: [] },
  { name: "nested-class-no-capture", fn: "run", ts: `function mk() { class K { m() { return 8; } } return new K().m(); }
export function run() { return mk(); }`, args: [] },
  { name: "nested-class-captures-outer-local", fn: "run", ts: `function mk(n: number) { class K { m() { return n; } } return new K().m(); }
export function run() { return mk(7); }`, args: [], unsupported: "函数内 class 声明捕获外层局部（提升后无 env 槽）" },
  { name: "nested-class-field-captures-outer-local", fn: "run", ts: `function mk(n: number) { class K { x: any = n; } return new K().x; }
export function run() { return mk(7); }`, args: [], unsupported: "函数内 class 字段初值捕获外层局部（提升后无 env 槽）" },
  { name: "alias-class-captures-outer-local", fn: "run", ts: `function mk(n: number) { const C = class { m() { return n; } }; return new C().m(); }
export function run() { return mk(7); }`, args: [], unsupported: "const C = class 只作物化别名，类值不携带创建点 env" },
  { name: "factory-static-init-captures-outer", fn: "run", ts: `function mk(n: number) { return class { static x = n; }; }
const C = mk(7);
export function run() { return C.x; }`, args: [], unsupported: "类表达式静态初始化引用工厂局部（静态按类名共享，创建点 env 不可见）" },
  { name: "factory-static-block-captures-outer", fn: "run", ts: `function mk(n: number) { return class { static x: number; static { C2.x = n; } }; }
const C2 = mk(7);
export function run() { return C2.x; }`, args: [], unsupported: "类表达式静态块引用工厂局部（静态按类名共享，创建点 env 不可见）" },
];
