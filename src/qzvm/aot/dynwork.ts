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
export function dynNewCount(): number { const C: any = mkCls(4); const a = new C(); return C.stat() + a.v(); }  // 13
