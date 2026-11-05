// 动态类值（工厂返回的类表达式）在 in-module 档的派发面：实例方法/字段/访问器、
// 静态方法/静态访问器/静态字段写读。两档跑同一份产物，期望值即 V8 值。
function mkCls(n: number) {
    let held = 1;
    return class {
        base: number = n;
        v(): number { return n * 2; }
        get double(): number { return n * 2; }
        static stat(): number { return n + 1; }
        static get gs(): number { return n + 2; }
        static get ss(): number { return held + n; }
        static set ss(val: number) { held = val; }
    };
}
export function dynInstMethod2(): number { const C: any = mkCls(4); return new C().v(); }                 // 8
export function dynInstField(): number { const C: any = mkCls(4); const o = new C(0); return o.base; }     // 4
export function dynInstGetter(): number { const C: any = mkCls(4); return new C().double; }               // 8
export function dynStaticCall(): number { const C: any = mkCls(4); return C.stat(); }                      // 5
export function dynStaticGetter(): number { const C: any = mkCls(4); return C.gs; }                        // 6
export function dynStaticSetter(): number { const C: any = mkCls(4); C.ss = 5; return C.ss; }              // 9
export function dynStaticField(): number { const C: any = mkCls(4); C.tag = 9; return C.tag; }             // 9
export function dynStaticFieldDelete(): number { const C: any = mkCls(4); C.tag = 9; delete C.tag; C.tag2 = 7; return C.tag2 + C.stat(); }  // 12（删静态字段后表仍自洽）
// 非模块顶层的 `const K = class {…}` 别名形式：类值在定义点物化（合成类名错开、K 是普通类值局部），
// 捕获走同一份类 env。与上面 mkCls（直接 return 类表达式）是两条不同的编译路径。
function mkAlias(n: number) {
    const K = class {
        base: number = n;
        v(): number { return n * 2; }
        get double(): number { return n * 3; }
        static stat(): number { return n + 1; }
        static get gs(): number { return n + 2; }
    };
    return K;
}
export function aliasInstMethod(): number { const C: any = mkAlias(4); return new C().v(); }        // 8
export function aliasInstField(): number { const C: any = mkAlias(4); return new C().base; }        // 4
export function aliasInstGetter(): number { const C: any = mkAlias(4); return new C().double; }     // 12
export function aliasStaticCall(): number { const C: any = mkAlias(4); return C.stat(); }           // 5
export function aliasStaticGetter(): number { const C: any = mkAlias(4); return C.gs; }             // 6
export function aliasMethodDirect(): number { const K: any = mkAlias(4); return new K().v(); }       // 8（别名就在工厂内使用，不经外层变量）
export function aliasEnvPerCall(): number { const a: any = mkAlias(4); const b: any = mkAlias(5); return new a().v() + new b().v(); }  // 18（两次求值各建 env，不串味）
export function aliasInstanceOf(): number { const a: any = mkAlias(4), b: any = mkAlias(5); return (new a() instanceof a ? 1 : 0) + (new a() instanceof b ? 1 : 0) * 10; }  // 1（每次求值独立类：自身 true、跨求值 false）
export function aliasCtorIdentity(): number { const a: any = mkAlias(4); const o = new a(); return (o.constructor === a ? 1 : 0) + (o.constructor === mkAlias(4) ? 10 : 0); }  // 1（构造器身份按求值点，不共享）
export function dynNewCount(): number { const C: any = mkCls(4); const a = new C(); return C.stat() + a.v(); }  // 13
