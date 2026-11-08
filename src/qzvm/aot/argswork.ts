// 类方法体内 `arguments`：实参个数只有**静态直调点**能提供（两档宿主都写不了产物的 `__args` 全局，
// 动态派发也传不进逐槽值）。本负载每个形状都走直调，档间必须逐位相同——
// 调用点在 wasm 里建「全量实参数组」写 `__args`，被调方法读入局部、清全局、读到哨兵 0 则 unreachable。
// 类体恒严格 ⇒ `arguments` 是非映射对象 ⇒ 与实参数组等价（length / 下标 / 遍历；默认值与解构形参不进数组）。

class Args {
    two(a: number, b: number): number { return arguments.length * 100 + a * 10 + b; }
    extra(a: number): number { return arguments[0] + arguments[1] * 10 + arguments[2] * 100; }
    // >4 实参：槽位只到 a0..a3，溢出实参仍在全量数组里
    many(a: number, b: number): number { return arguments.length * 1000 + arguments[3] * 100 + arguments[5]; }
    // 缺省实参读 undefined（数组按实参个数，不按 4 个槽补 undefined）
    hole(a: number): number { return arguments.length * 10 + (arguments[2] === undefined ? 1 : 0); }
    sum(): number { let s = 0; for (const x of arguments) s += x; return s; }
    dest({ a, b }: any): number { return arguments.length * 100 + a * 10 + b; }
    probe(h: any): number { return arguments.length * 1000 + h; }
}
class Sub extends Args {
    own(): number { return this.two(1, 1); }
}
class Sil {                          // 叶子类 ⇒ `this.m()` 接收者静态可判
    inner(a: number, b: number, c: number): number { return arguments.length * 100 + a + b + c; }
    outer(): number { return this.inner(1, 2, 3); }
}
class Dflt {
    d(a: number = 7): number { return arguments.length * 100 + a; }
}
class Statics {
    static make(a: number, b: number): number { return arguments.length * 100 + a + b; }
}
class Arrowed {                      // arguments 经箭头函数捕获（env 播种）
    m(a: number): number { const f = () => arguments.length; return f() * 10 + a; }
}

function bump(h: any): number { h[0] = h[0] + 1; return 7; }

function argsTwo(): number { return new Args().two(1, 2); }               // 212
function argsExtra(): number { return new Args().extra(1, 2, 3); }        // 321
function argsMany(): number { return new Args().many(1, 2, 3, 4, 5, 6); } // 6406
function argsHole(): number { return new Args().hole(1, 2); }             // 21
function argsSum(): number { return new Args().sum(2, 3, 40); }           // 45
function argsDest(): number { return new Args().dest({ a: 1, b: 2 }); }   // 112
function argsInherited(): number { return new Sub().extra(1, 2, 3); }     // 321
function argsViaThis(): number { return new Sil().outer(); }              // 306
function argsDefaultNone(): number { return new Dflt().d(); }             // 7
function argsDefaultGiven(): number { return new Dflt().d(9); }           // 109
function argsStatic(): number { return Statics.make(3, 4); }              // 207
function argsArrow(): number { return new Arrowed().m(5); }               // 15
// 实参只求值一次（顶层函数 arguments 路径曾重复求值）
function argsEvalOnce(): number {
    const hits = [0];
    const v = new Args().probe(bump(hits));                    // 1*1000 + 7
    return hits[0] * 10000 + v;                                // 11007
}

// ── 顶层函数体内 arguments：同一条 __args 通道，实参同样只求值一次 ────────────
function fpair(a: number, b: number): number { return arguments.length * 10 + a + b; }
function frest(a: number, ...r: number[]): number { return arguments.length * 1000 + a * 100 + r.length * 10 + r[0]; }
function fident(a: number, ...r: number[]): number { return (arguments === (r as any)) ? 1 : 0; }

function fnArgsOnce(): number {                                // 129
    const hits = [0];
    const v = fpair(bump(hits), 2);                            // 2*10 + 7 + 2 = 29
    return hits[0] * 100 + v;
}
function fnArgsRest(): number {                                // 13726
    const hits = [0];
    const v = frest(bump(hits), 6, 7);                         // 3*1000 + 7*100 + 2*10 + 6
    return hits[0] * 10000 + v;
}
function fnArgsRestDistinct(): number { return fident(1, 2); } // 0：rest 数组与 arguments 是两个对象

// 展开实参：全量数组本来就在手上，调用点直接写 __args。此前该形态没有 provider，
// 被调读到上一个 callee 的残留数组（fnArgsSpreadStale 的直调先行会把 9 留下）。
function fspread(a: number): number { return arguments.length * 100 + a * 10 + (arguments[1] === undefined ? 0 : (arguments[1] as number)); }
function fsrest(a: number, ...r: number[]): number { return arguments.length * 1000 + a * 100 + r.length * 10 + r[0]; }

function fnArgsSpread(): number { return fspread(...[1, 2]); }              // 212
function fnArgsSpreadStale(): number {
    const second = fspread(9);            // 1*100 + 9*10 = 190
    const first = fspread(...[1, 2]);     // 212（修前读残留 → 1*100+10 = 110 的形态）
    return first * 1000 + second;         // 212190
}
function fnArgsSpreadRest(): number { return fsrest(...[1, 5, 6]); }        // 3125

// 静态方法展开：self 单独发射，槽位从同一数组回读直调（rest 段是 slice 出的新数组）。
class SpreadStatic {
    static sm(a: number, b: number): number { return a * 100 + b; }
    static sr(a: number, ...rest: number[]): number { return a * 1000 + rest.length * 10 + rest[0]; }
}
function fnum(a: number, b: number): number { return a * 10 + b; }            // num（f64 ABI）
function fnSpreadNum(): number { return fnum(...[1, 2]); }                    // 12
function fnSpreadStatic(): number { return SpreadStatic.sm(...[3, 4]); }      // 304
function fnSpreadStaticRest(): number { return SpreadStatic.sr(...[3, 4, 5]); } // 3024

