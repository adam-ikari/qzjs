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
  { name: "shadow-static-getter", fn: "f", args: [], ts: `class S { static get g() { return 9; } } export function f(): any { const S = { g: 5 }; return S.g; }` },
  { name: "static-getter-control", fn: "f", args: [], ts: `class S { static get g() { return 9; } } export function f(): any { return S.g; }` },
  { name: "shadow-static-setter", fn: "f", args: [], ts: `let seen = 0; class S { static set s(v: any) { seen = v; } } export function f(): any { const S = { s: 0 }; S.s = 5; return S.s; }` },
  { name: "static-setter-control", fn: "f", args: [], ts: `let seen = 0; class S { static set s(v: any) { seen = v; } } export function f(): any { S.s = 5; return 1; }` },
  { name: "shadow-static-field", fn: "f", args: [], ts: `class S { static v = 9; } export function f(): any { const S = { v: 5 }; return S.v; }` },
  { name: "static-field-control", fn: "f", args: [], ts: `class S { static v = 9; } export function f(): any { return S.v; }` },
  { name: "shadow-param-new", fn: "f", args: [], ts: `class TopC { m() { return 9; } } function mk() { return class { m() { return 5; } }; } export function f(): any { const g = (TopC: any) => new TopC().m(); return g(mk()); }` },
  { name: "shadow-destructure-builtin", fn: "f", args: [], ts: `export function f(): any { const Math = { floor: () => 5 }; const { floor } = Math; return floor(); }` },
  { name: "shadow-static-field-method", fn: "f", args: [], ts: `class S { static v = 9; } export function f(): any { const S = { v: () => 5 }; return S.v(); }` },
  { name: "shadow-class-prototype", fn: "f", args: [], ts: `class TopC { m() { return 9; } } export function f(): any { const TopC = mk(); return typeof TopC.prototype.m; }` },
  { name: "shadow-class-static-block", fn: "f", args: [], ts: `class C { static v = 9; static { } } function mk() { return class { v = 5; }; } export function f(): any { const C = mk(); return new C().v; }` },
  { name: "shadow-class-method-read", fn: "f", args: [], ts: `class C { m() { return 9; } } function mk() { return class { m() { return 5; } }; } export function f(): any { const C = mk(); const c = new C(); return c.m(); }` },
  { name: "shadow-class-arrow-this", fn: "f", args: [], ts: `class C { v = 9; m() { return () => this.v; } } function mk() { return class { v = 5; m() { return () => this.v; } }; } export function f(): any { const C = mk(); const c = new C(); return c.m()(); }` },
  { name: "shadow-class-in-array", fn: "f", args: [], ts: `class C { m() { return 9; } } function mk() { return class { m() { return 5; } }; } export function f(): any { const C = mk(); const a = [new C()]; return a[0].m(); }` },
  { name: "shadow-class-for-of", fn: "f", args: [], ts: `class C { m() { return 9; } } function mk() { return class { m() { return 5; } }; } export function f(): any { const C = mk(); let r = 0; for (const c of [new C()]) r += c.m(); return r; }` },
  { name: "shadow-class-json", fn: "f", args: [], ts: `class C { v = 9; } function mk() { return class { v = 5; }; } export function f(): any { const C = mk(); return JSON.stringify(new C()); }` },
  { name: "shadow-class-in-operator", fn: "f", args: [], ts: `class C { v = 9; } function mk() { return class { v = 5; }; } export function f(): any { const C = mk(); return "v" in new C(); }` },
  { name: "shadow-class-ternary-new", fn: "f", args: [], ts: `class C { m() { return 9; } } function mk() { return class { m() { return 5; } }; } export function f(b: any): any { const C = mk(); return (b ? new C() : new C()).m(); }` },
  { name: "shadow-class-callback-map", fn: "f", args: [], ts: `class C { v = 9; } function mk() { return class { v = 5; }; } export function f(): any { const C = mk(); return [1].map(() => new C().v)[0]; }` },
  { name: "shadow-class-nested-method", fn: "f", args: [], ts: `class C { m() { return 9; } } function mk() { return class { m() { return 5; } }; } export function f(): any { const C = mk(); class Inner { g() { return new C().m(); } } return new Inner().g(); }` },
  { name: "shadow-class-super-chain", fn: "f", args: [], ts: `class C { m() { return 9; } } function mk() { return class { m() { return 5; } }; } export function f(): any { const C = mk(); class Inner extends C { } return new Inner().m(); }` },
  { name: "shadow-class-getter", fn: "f", args: [], ts: `class C { get v() { return 9; } } function mk() { return class { get v() { return 5; } }; } export function f(): any { const C = mk(); return new C().v; }` },
  { name: "shadow-builtin-elem-call", fn: "f", args: [], ts: `export function f(): any { const Math = { floor: () => 5 }; return (Math as any)["floor"](1.9); }` },
  { name: "shadow-builtin-elem-read", fn: "f", args: [], ts: `export function f(): any { const S = { PI: 5 }; return (S as any)["PI"]; }` },
  { name: "shadow-builtin-string-key-in", fn: "f", args: [], ts: `export function f(): any { const Math = { floor: 5 }; return "floor" in Math; }` },
  { name: "shadow-builtin-call-apply", fn: "f", args: [], ts: `export function f(): any { const Math = { m: (x: any) => x + 5 }; return (Math.m as any).call(Math, 1); }` },
  { name: "shadow-builtin-symbol-iterator", fn: "f", args: [], ts: `export function f(): any { const Symbol = { iterator: "@@i" }; return [...[1]][0]; }` },
  { name: "shadow-builtin-array-from", fn: "f", args: [], ts: `export function f(): any { const Array = { from: () => [5] }; return Array.from([1])[0]; }` },
  { name: "shadow-builtin-object-keys", fn: "f", args: [], ts: `export function f(): any { const Object = { keys: () => ["a"] }; return Object.keys({})[0]; }` },
  { name: "shadow-builtin-json-parse", fn: "f", args: [], ts: `export function f(): any { const JSON = { parse: () => 5 }; return JSON.parse("{}"); }` },
  { name: "shadow-builtin-number-isnan", fn: "f", args: [], ts: `export function f(): any { const Number = { isNaN: () => 5 }; return Number.isNaN(1); }` },
  { name: "shadow-builtin-math-spread", fn: "f", args: [], ts: `export function f(): any { const Math = { max: (...x: any[]) => 5 }; const a = [1, 2]; return Math.max(...a); }` },
  { name: "shadow-topfn-void-spread", fn: "f", args: [], ts: `function topfn(x: number): void { } export function f(): any { const topfn = (x: number) => x + 5; const a = [1]; return topfn(...a); }` },
  { name: "shadow-topfn-rest-arity", fn: "f", args: [], ts: `function topfn(x: number) { return x + 1; } export function f(): any { const topfn = (...xs: any[]) => xs.length + 10; const a = [1, 2, 3]; return topfn(...a); }` },
  { name: "shadow-topfn-arity-shrink", fn: "f", args: [], ts: `function topfn(a: number, b: number, c: number) { return a + b + c; } export function f(): any { const topfn = (x: number) => x + 10; const a = [1, 2, 3]; return topfn(...a); }` },
  { name: "shadow-topfn-arguments-body", fn: "f", args: [], ts: `function topfn() { return 1; } export function f(): any { const topfn = (...xs: any[]) => xs[0] + 10; const a = [1]; return topfn(...a); }` },

  { name: "shadow-topfn-as-value", fn: "f", args: [], ts: `function topfn(): number { return 1; } export function f(): any { const topfn = (): number => 7; const g = topfn; return g(); }` },
  { name: "shadow-topfn-as-value-param", fn: "f", args: [], ts: `function topfn(): number { return 1; } export function f(cb: any): any { return cb(); }` },
  { name: "shadow-topfn-object-shorthand", fn: "f", args: [], ts: `function topfn(): number { return 1; } export function f(): any { const topfn = (): number => 7; const o: any = { topfn }; return o.topfn(); }` },
  { name: "shadow-topfn-array-elem", fn: "f", args: [], ts: `function topfn(): number { return 1; } export function f(): any { const topfn = (): number => 7; const a: any = [topfn]; return a[0](); }` },
  { name: "shadow-topfn-typeof", fn: "f", args: [], ts: `function topfn(): number { return 1; } export function f(): any { const topfn = 7; return typeof topfn; }` },
  { name: "shadow-topfn-bind", fn: "f", args: [], ts: `function topfn(a: number): number { return a + 1; } export function f(): any { const topfn = (a: number) => a + 10; const g = topfn.bind(null); return g(1); }` },
  { name: "shadow-topfn-callback-arg", fn: "f", args: [], ts: `function topfn(x: number): number { return x + 1; } export function f(): any { const topfn = (x: number) => x + 100; const a: any = [1, 2]; return a.map(topfn).join(","); }` },
  { name: "shadow-topfn-ternary-value", fn: "f", args: [], ts: `function topfn(): number { return 1; } export function f(c: boolean): any { const topfn = (): number => 7; const g = c ? topfn : topfn; return g(); }` },
  { name: "shadow-topfn-return-value", fn: "f", args: [], ts: `function topfn(): number { return 1; } export function f(): any { const topfn = (): number => 7; const g = (() => topfn)(); return g(); }` },
  { name: "shadow-topfn-call-method", fn: "f", args: [], ts: `function topfn(): number { return 1; } export function f(): any { const topfn = (): number => 7; return topfn.call(null); }` },
  { name: "shadow-topfn-apply", fn: "f", args: [], ts: `function topfn(): number { return 1; } export function f(): any { const topfn = (): number => 7; return topfn.apply(null, []); }` },
  { name: "shadow-topfn-wrapped-deep", fn: "f", args: [], ts: `function topfn(): number { return 1; } export function f(): any { { { const topfn = (): number => 7; return topfn(); } } }` },


  { name: "shadow-static-get-local", fn: "f", args: [], ts: `class C { static get v(): any { return 1; } static m(): any { return 2; } } export function f(): any { const C = { v: 9, m: () => 8 }; return C.v + C.m(); }` },
  { name: "shadow-static-set-local", fn: "f", args: [], ts: `class C { static v: any = 1; } export function f(): any { const C: any = { v: 0 }; C.v = 5; return C.v; }` },
  { name: "shadow-static-field-compound", fn: "f", args: [], ts: `class C { static n: number = 1; } export function f(): any { const C: any = { n: 10 }; C.n += 5; return C.n; }` },
  { name: "shadow-static-elem-read", fn: "f", args: [], ts: `class C { static v: any = 1; } export function f(): any { const C: any = { v: 7 }; return C["v"]; }` },
  { name: "shadow-static-typeof-member", fn: "f", args: [], ts: `class C { static m(): any { return 1; } } export function f(): any { const C: any = { m: 3 }; return typeof C.m; }` },
  { name: "shadow-static-optional", fn: "f", args: [], ts: `class C { static v: any = 1; } export function f(): any { const C: any = null; return C?.v; }` },
  { name: "shadow-static-in-method", fn: "f", args: [], ts: `class C { static v: any = 1; m(): any { const C = { v: 5 }; return C.v; } } export function f(): any { return new C().m(); }` },
  { name: "shadow-static-ctor-arg", fn: "f", args: [], ts: `class C { static v: any = 1; } export function f(C: any): any { return C.v; }` },
  { name: "shadow-static-callback", fn: "f", args: [], ts: `class C { static v: any = 1; } export function f(): any { const arr: any = [0]; return arr.map(() => { const C = { v: 6 }; return C.v; })[0]; }` },
  { name: "shadow-class-alias-value", fn: "f", args: [], ts: `class C { static v(): any { return 1; } } export function f(): any { const A: any = C; return A.v(); }` },
  { name: "shadow-class-nested-named", fn: "f", args: [], ts: `class C { static v(): any { return 1; } } export function f(): any { { const C: any = { v: () => 2 }; return C.v(); } }` },
  { name: "shadow-class-delete-static", fn: "f", args: [], ts: `class C { static v: any = 1; } export function f(): any { const C: any = { v: 1 }; delete C.v; return C.v; }` },


  { name: "shadow-subclass-static-inherit", fn: "f", args: [], ts: `class B { static v(): any { return 1; } static get g(): any { return 2; } } class D extends B { } export function f(): any { const D2: any = D; return D2.v() + D2.g; }` },
  { name: "shadow-super-method", fn: "f", args: [], ts: `class B { m(): any { return 1; } } class D extends B { m(): any { return 2; } n(): any { return super.m() + 1; } } export function f(): any { const B2: any = D; return new B2().n(); }` },
  { name: "shadow-static-block-outer", fn: "f", args: [], ts: `let n: number = 1; class C { static v: any; static { C.v = n + 1; } } export function f(): any { const C2: any = C; return C2.v; }` },
  { name: "shadow-private-static", fn: "f", args: [], ts: `class C { static #n: number = 3; static get v(): any { return C.#n; } } export function f(): any { const C2: any = C; return C2.v; }` },
  { name: "shadow-getter-super", fn: "f", args: [], ts: `class B { get v(): any { return 1; } } class D extends B { get v(): any { return super.v + 1; } } export function f(): any { const D2: any = D; return new D2().v; }` },
  { name: "shadow-mixin-alias-call", fn: "f", args: [], ts: `class B { hello(): any { return "b"; } } const Mix = (P: any) => class extends P { w(): any { return "m"; } }; export function f(): any { const M: any = Mix(B); const x: any = new M(); return x.hello() + x.w(); }` },
  { name: "shadow-class-param-ctor", fn: "f", args: [], ts: `class C { v: any = 1; } export function f(C: any): any { return new C().v; }` },
  { name: "shadow-class-obj-prop-cb", fn: "f", args: [], ts: `class C { static v(): any { return 1; } } export function f(): any { const o: any = { cb: (C: any) => C.v() }; return o.cb({ v: () => 5 }); }` },
  { name: "shadow-class-in-json", fn: "f", args: [], ts: `class C { static v(): any { return 1; } } export function f(): any { const o: any = { k: (C: any) => C.v() }; return JSON.stringify(o.k({ v: () => 3 })); }` },


  { name: "shadow-builtin-keys-local", fn: "f", args: [], ts: `export function f(): any { const Object = { keys: (o: any) => ["x"] }; return Object.keys({ a: 1 }).join(","); }` },
  { name: "shadow-builtin-stringify-local", fn: "f", args: [], ts: `export function f(): any { const JSON = { stringify: (o: any) => "Z" }; return JSON.stringify({ a: 1 }); }` },
  { name: "shadow-builtin-max-local", fn: "f", args: [], ts: `export function f(): any { const Math = { max: () => 42 }; return Math.max(1, 2); }` },
  { name: "shadow-builtin-from-local", fn: "f", args: [], ts: `export function f(): any { const Array = { from: (x: any) => [9] }; return Array.from("ab").join(","); }` },
  { name: "shadow-builtin-raw-local", fn: "f", args: [], ts: `export function f(): any { const String = { raw: (x: any) => "R" }; return String.raw\`abc\`; }` },
  { name: "shadow-builtin-symbol-local", fn: "f", args: [], ts: `export function f(): any { const Symbol = { iterator: "it" }; return Symbol.iterator; }` },
  { name: "shadow-builtin-promise-local", fn: "f", args: [], ts: `export function f(): any { const Promise = { resolve: (v: any) => v + 1 }; return Promise.resolve(1); }` },
  { name: "shadow-builtin-weakmap-local", fn: "f", args: [], ts: `export function f(): any { const WeakMap = class { get(): any { return 5; } }; return new WeakMap().get(); }` },
  { name: "shadow-builtin-parseint-local", fn: "f", args: [], ts: `export function f(): any { const parseInt = (s: any) => 99; return parseInt("1"); }` },
  { name: "shadow-builtin-eval-local", fn: "f", args: [], ts: `export function f(): any { const isNaN = (x: any) => false; return isNaN(1); }` },
  { name: "shadow-builtin-map-ctor-local", fn: "f", args: [], ts: `export function f(): any { const Map = class { size: any = 7; }; return new Map().size; }` },
  { name: "shadow-builtin-regexp-local", fn: "f", args: [], ts: `export function f(): any { const RegExp = class { test(): any { return true; } }; return new RegExp().test("x"); }` },


  { name: "shadow-instanceof-nonobj-proto-num", fn: "f", args: [], ts: `function F() { return 1; } export function f(): any { (F as any).prototype = 3; try { return ({} as any) instanceof (F as any); } catch (e: any) { return "T:" + (e as any).message; } }` },
  { name: "shadow-instanceof-nonobj-proto-undef", fn: "f", args: [], ts: `function F() { return 1; } export function f(): any { (F as any).prototype = undefined; try { return ({} as any) instanceof (F as any); } catch (e: any) { return "T:" + (e as any).message; } }` },

];
