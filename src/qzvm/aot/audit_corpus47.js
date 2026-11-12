// Differential audit corpus (batch 47): closure capture when a same-named local shadows a top-level
// class / function / builtin / module global.
// Two silent-wrong-value bugs fixed (the old code decided "not a free variable" by *text name*):
//   1) `_computeStaticVars` treated `const C = mk(); const c = new C(); c.m()` as an instance of class C
//      and directly dispatched __m_C$m (silently 7 instead of the factory method's 6). Now symbol-based
//      via _isClassValueIdent.
//   2) `_capturesOf` / class-env capture dropped names hitting `class/fnNames/BUILTIN_GLOBALS/moduleGlobals`
//      so a shadowing local read the class object / top-level function / builtin / module global instead.
//      Now every exclusion is symbol-based: only a reference that really denotes that top-level binding is
//      dropped; a local shadow is always captured.
// Coverage: arrow/block/param/loop locals, class method/field/static-field/arrow-in-method, module class
// method, top-level const arrow.
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
  { name: "shadow-inline-new-method", fn: "f", args: [], ts: `class C { v = 9; m() { return 9; } }
function mk() { return class { v = 5; m() { return 5; } }; }
export function f(): any { const C = mk(); return new C().m(); }` },
  { name: "shadow-inline-new-field", fn: "f", args: [], ts: `class C { v = 9; }
function mk() { return class { v = 5; }; }
export function f(): any { const C = mk(); return new C().v; }` },
  { name: "shadow-dyn-parent", fn: "f", args: [], ts: `class Base { m() { return 9; } }
function mk() { return class { m() { return 5; } }; }
export function f(): any { const Base = mk(); class K extends Base {} return new K().m(); }` },
  { name: "shadow-dyn-parent-instanceof", fn: "f", args: [], ts: `class Base { m() { return 9; } }
function mk() { return class { m() { return 5; } }; }
export function f(): any { const Base = mk(); class K extends Base {} return new K() instanceof Base; }` },
  { name: "typeof-shadow-builtin", fn: "f", args: [], ts: `export function f(): any { const Math = 5; return typeof Math; }` },
  { name: "typeof-shadow-topfn", fn: "f", args: [], ts: `function topfn(x: number) { return x + 1; } export function f(): any { const topfn = 5; return typeof topfn; }` },
  { name: "typeof-builtin-unchanged", fn: "f", args: [], ts: `export function f(): any { return typeof Math; }` },
  { name: "typeof-topfn-unchanged", fn: "f", args: [], ts: `function topfn(x: number) { return x + 1; } export function f(): any { return typeof topfn; }` },
  { name: "shadow-builtin-spread-call", fn: "f", args: [], ts: `export function f(): any { const Math = { max: (...xs: any[]) => 5 }; const xs = [1, 2]; return Math.max(...xs); }` },
  { name: "shadow-builtin-member-spread", fn: "f", args: [], ts: `export function f(): any { const JSON = { stringify: (...a: any[]) => "x" }; return JSON.stringify(1, null, 2, 3, 4, 5); }` },
  { name: "shadow-error-new", fn: "f", args: [], ts: `function mk() { return class { v = 5; message = "m"; name = "n"; }; } export function f(): any { const Error = mk(); const e = new Error(); return e.v; }` },
  { name: "shadow-error-extends", fn: "f", args: [], ts: `function mk() { return class { m() { return 5; } }; } export function f(): any { const Error = mk(); class E extends Error { } return new E().m(); }` },
  { name: "shadow-string-call", fn: "f", args: [], ts: `export function f(): any { const String = (x: any) => x + 5; return String(1); }` },
  { name: "shadow-parseint-call", fn: "f", args: [], ts: `export function f(): any { const parseInt = (x: any) => x + 5; return parseInt(1); }` },
  { name: "shadow-date-new", fn: "f", args: [], ts: `function mk() { return class { v = 5; }; } export function f(): any { const Date = mk(); return new Date().v; }` },
  { name: "builtin-unchanged-new", fn: "f", args: [], ts: `export function f(): any { return new Map([["a", 1]]).get("a"); }` },
  { name: "builtin-unchanged-call", fn: "f", args: [], ts: `export function f(): any { return Math.floor(1.9); }` },
  { name: "builtin-unchanged-string", fn: "f", args: [], ts: `export function f(): any { return String(5); }` },
  { name: "shadow-topfn-spread-call", fn: "f", args: [], ts: `function topfn(x: number) { return x + 1; } export function f(): any { const topfn = (x: number) => x + 10; const a = [1]; return topfn(...a); }` },
  { name: "shadow-builtin-paren-new", fn: "f", args: [], ts: `function mk() { return class { v = 5; }; } export function f(): any { const Map = mk(); return new (Map)().v; }` },
  { name: "shadow-builtin-optional-member", fn: "f", args: [], ts: `export function f(): any { const Math = { floor: () => 5 }; return Math?.floor(1.9); }` },
  { name: "shadow-builtin-arrow-body", fn: "f", args: [], ts: `export function f(): any { const JSON = { stringify: () => "s" }; const g = () => JSON.stringify(1); return g(); }` },
  { name: "shadow-topfn-arrow-body", fn: "f", args: [], ts: `function topfn(x: number) { return x + 1; } export function f(): any { const topfn = (x: number) => x + 10; const g = () => topfn(1); return g(); }` },
  { name: "shadow-class-method-value", fn: "f", args: [], ts: `class TopC { m() { return 9; } } export function f(): any { const TopC = { m: () => 5 }; const g = TopC.m; return g(); }` },
  { name: "shadow-builtin-obj-in-array", fn: "f", args: [], ts: `export function f(): any { const Math = 5; return [Math][0]; }` },
  { name: "shadow-builtin-typeof-block", fn: "f", args: [], ts: `export function f(): any { let r = ""; { const Math = "x"; r += typeof Math; } r += typeof Math; return r; }` },
];
