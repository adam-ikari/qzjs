// 差分审计语料（第四十七批）：**同名局部变量遮蔽**顶层类/函数/内建/模块全局时的闭包捕获。
// 修复两类静默错值（旧实现按**文本名**判定"不是自由变量"，忽略遮蔽）：
//   1) `_computeStaticVars` 把 `const C = mk(); const c = new C(); c.m()` 按类名 C 静态判成
//      类 C 实例 → 直调 __m_C$m（静默 7 而非工厂类方法的 6）。改查符号身份（_isClassValueIdent）。
//   2) `_capturesOf` / 类 env 捕获按名丢弃 `class/fnNames/BUILTIN_GLOBALS/moduleGlobals` 命中项，
//      同名局部被遮蔽后闭包读到类对象/顶层函数/内建/模块全局（静默错值）。改为按 checker 符号判定：
//      只有引用**确为**该类值/顶层函数/内建/模块顶层绑定时才丢弃，局部遮蔽一律捕获。
// 覆盖：箭头/块/形参/循环局部、类方法/字段/静态字段/方法内嵌套箭头、模块级类方法、顶层 const 箭头。
module.exports = [
  { name: "shadow-class-arrow", fn: "f", args: [], ts: `class C { static v = 9; }
export function f(): any { const C = 5; const g = () => C + 1; return g(); }` },
  { name: "shadow-class-block-arrow", fn: "f", args: [], ts: `class C { m() { return 9; } }
export function f(): any { let r = ""; { const C = 5; const g = () => C + 1; r = String(g()); } return r; }` },
  { name: "shadow-class-param-arrow", fn: "f", args: [], ts: `class C { static v = 9; }
export function f(): any { function h(C: any) { const g = () => C + 1; return g(); } return h(5); }` },
  { name: "shadow-class-let-loop", fn: "f", args: [], ts: `class C { static v = 9; }
export function f(): any { let s = 0; for (let i = 0; i < 1; i++) { const C = 5; const g = () => C + i; s = g(); } return s; }` },
  { name: "shadow-class-method-capture", fn: "f", args: [], ts: `class C { m() { return 9; } }
export function f(): any { const C = 5; class K { m() { return C + 1; } } return new K().m(); }` },
  { name: "shadow-class-field-capture", fn: "f", args: [], ts: `class C { m() { return 9; } }
export function f(): any { const C = 5; class K { v = C + 1; } return new K().v; }` },
  { name: "shadow-class-static-field-capture", fn: "f", args: [], ts: `class C { m() { return 9; } }
export function f(): any { const C = 5; class K { static v = C + 1; } return (K as any).v; }` },
  { name: "shadow-class-method-arrow-capture", fn: "f", args: [], ts: `class C { m() { return 9; } }
export function f(): any { const C = 5; class K { m() { const g = () => C + 1; return g(); } } return new K().m(); }` },
  { name: "module-class-method-capture", fn: "f", args: [], ts: `class C { m() { return 9; } }
const D = 5;
class K { m() { return D + 1; } }
export function f(): any { return new K().m(); }` },
  { name: "shadow-fn-arrow", fn: "f", args: [], ts: `function h(): number { return 9; }
export function f(): any { const h = 5; const g = () => h + 1; return g(); }` },
  { name: "shadow-fn-class-method", fn: "f", args: [], ts: `function h(): number { return 9; }
export function f(): any { const h = 5; class K { m() { return h + 1; } } return new K().m(); }` },
  { name: "shadow-builtin-arrow", fn: "f", args: [], ts: `export function f(): any { const Map = 5; const g = () => Map + 1; return g(); }` },
  { name: "shadow-builtin-arrow-deep", fn: "f", args: [], ts: `export function f(): any { const JSON = 5; const g = () => () => JSON + 1; return g()(); }` },
  { name: "shadow-builtin-class-method", fn: "f", args: [], ts: `export function f(): any { const Map = 5; class K { m() { return Map + 1; } } return new K().m(); }` },
  { name: "shadow-toplevel-const-arrow", fn: "f", args: [], ts: `const h = () => 9;
export function f(): any { const h = 5; const g = () => h + 1; return g(); }` },
  { name: "shadow-module-const-arrow", fn: "f", args: [], ts: `const D = 5;
export function f(): any { const D = 7; const g = () => D + 1; return g(); }` },
  { name: "shadow-module-const-class", fn: "f", args: [], ts: `const D = 5;
export function f(): any { const D = 7; class K { m() { return D + 1; } } return new K().m(); }` },
  { name: "shadow-module-let-block", fn: "f", args: [], ts: `let D = 5;
export function f(): any { let r = 0; { let D = 7; const g = () => D + 1; r = g(); } return r; }` },
  { name: "local-class-arrow", fn: "f", args: [], ts: `export function f(): any { class K { m() { return 5; } } const g = () => new K().m(); return g(); }` },
  { name: "local-class-block-arrow", fn: "f", args: [], ts: `export function f(): any { let r = 0; { class K { m() { return 5; } } const g = () => new K().m(); r = g(); } return r; }` },
];
