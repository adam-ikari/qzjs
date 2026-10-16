#!/usr/bin/env node
/* test_aot.js — AOT 最小 e2e 回归门（编译 TS→wasm→node WebAssembly 运行→比对期望）。
 *
 * 不依赖 wamrc/AOT（无需 LLVM 宿主）：node 的 WebAssembly 直接跑 emitter 产出的 .wasm。
 * 覆盖：num 快路径（f64 语义：除法/取模/大数）与 tagged 路径（f64 NaN-box，32/64 位统一）。
 *
 * 运行： node src/qzvm/aot/test_aot.js   （需能 require("typescript")，见同目录 package.json）
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { compileTS } = require("./emitter.js");
const { makeQzvm } = require("./qzvm.js");

let failures = 0;
function check(name, got, exp) {
    const ok = Object.is(got, exp) || (typeof got === "number" && typeof exp === "number" && Math.abs(got - exp) < 1e-9);
    console.log(`${ok ? "ok  " : "FAIL"} ${name} = ${got} (expect ${exp})`);
    if (!ok) failures++;
}

// num 快路径：f64 语义（原 i32 模型在 /、%、大数上静默出错——本门守此回归）
const NUM_SRC = `
function big(n: number): number { let s = 0; for (let i = 0; i < n; i++) s = s + 1000000000; return s; }
function div(a: number, b: number): number { return a / b; }
function mod(a: number, b: number): number { return a % b; }
function nested(a: number, b: number, c: number): number { return a % (b % c); }
function neg(a: number): number { return -a; }
function cmp(a: number, b: number): number { if (a < b) return 1; return 0; }
function cmp2(a: number, b: number): number { if (a > b && b > 0) return 1; return 0; }
function nott(a: number): number { if (!a) return 7; return 1; }
function inc(n: number): number { let x = n; x++; return x; }
function postfix_ret(n: number): number { let x = n; let y = x++; return x * 10 + y; }
function wsum(n: number): number { let s = 0; let i = 0; while (i < n) { s += i; i++; } return s; }
function flo(a: number): number { return Math_floor(a); }
// 逻辑运算**值语义**（守 2026-10-15 修复：曾结果强制 0/1，且 ||= 曾非真短路）
function and_val(a: number, b: number): number { const r: any = a && b; return r; }
function or_val(a: number, b: number): number { const r: any = a || b; return r; }
function or_assign(a: number, b: number): number { let x = a; x ||= b; return x; }
function and_assign(a: number, b: number): number { let x = a; x &&= b; return x; }
// 纯类型层构造（运行时恒等）：as / 非空断言 / satisfies / 尖括号断言 —— 必须被擦除为操作数本身。
function asNum(x: number): number { return (x as number) + 1; }
function angleNum(x: number): number { return (<number>x) + 1; }
function nonNullNum(x: number): number { return x! + 1; }
function satNum(x: number): number { return ((x as any) satisfies number) + 1; }
// NaN truthy：JS Boolean(NaN)=false（此前 emitCond 仅 x!=0 → NaN 误判 truthy）。
function nanTruthy(a: number, b: number): number { const x = a / b; return x ? 1 : 7; }
function nanAnd(a: number, b: number): number { const x = a / b; return x && 3; }
// ** 指数：wasm 无原生 f64.pow → 宿主 import（Math.pow 语义）；右结合嵌套由 TS AST 保证。
function pow2(a: number, b: number): number { return a ** b; }
function powRight(a: number): number { return 2 ** 3 ** a; }   // 右结合：2^(3^a)
function powNaN0(a: number): number { return a ** 0; }          // NaN^0=1、0^0=1
function pow0neg(a: number): number { return 0 ** a; }          // 0^-1=Infinity
// ?? nullish：num 模式值恒为 f64（永非 null/undefined）→ 结果恒 = 左操作数
function nnNum(a: number, b: number): number { return a ?? b; }
function nanOr(a: number, b: number): number { const x = a / b; return x || 9; }
`;

async function runNum() {
    const tmp = path.join(os.tmpdir(), "qz_aot_num.ts");
    fs.writeFileSync(tmp, NUM_SRC);
    const wasm = path.join(os.tmpdir(), "qz_aot_num.wasm");
    compileTS(tmp, wasm, {});
    const bytes = fs.readFileSync(wasm);
    const stub = new Proxy({}, { get: (_, k) => k === "math_pow" ? Math.pow : (..._a) => 0 });
    const { instance } = await WebAssembly.instantiate(bytes, { qz: stub, env: stub });
    const e = instance.exports;
    check("big(5)", e.big(5), 5e9);
    check("div(7,2)", e.div(7, 2), 3.5);
    check("mod(7,3)", e.mod(7, 3), 1);
    check("mod(-7,3)", e.mod(-7, 3), -1);
    check("mod(7.5,2)", e.mod(7.5, 2), 1.5);
    check("nested(100,7,3)", e.nested(100, 7, 3), 0);   // 100 % (7%3) = 100 % 1 = 0
    check("neg(5)", e.neg(5), -5);
    check("cmp(2,3)", e.cmp(2, 3), 1);
    check("cmp2(5,-1)", e.cmp2(5, -1), 0);
    check("nott(0)", e.nott(0), 7);
    check("inc(10)", e.inc(10), 11);
    check("postfix_ret(10)", e.postfix_ret(10), 120);
    check("wsum(5)", e.wsum(5), 10);
    check("flo(3.7)", e.flo(3.7), 3);
    // 逻辑值语义（JS 精确：返回操作数本身，不是 0/1）
    check("and_val(5,3)", e.and_val(5, 3), 3);
    check("and_val(0,3)", e.and_val(0, 3), 0);
    check("or_val(0,7)", e.or_val(0, 7), 7);
    check("or_val(5,7)", e.or_val(5, 7), 5);
    // 逻辑复合赋值（a ||= b / a &&= b）
    check("or_assign(5,9)", e.or_assign(5, 9), 5);
    check("or_assign(0,9)", e.or_assign(0, 9), 9);
    check("and_assign(5,9)", e.and_assign(5, 9), 9);
    check("and_assign(0,9)", e.and_assign(0, 9), 0);
    // 纯类型层构造擦除（运行时恒等）：此前 emitExpr/emitTaggedExpr 无 AsExpression 分支 → 编译崩。
    check("asNum(5)", e.asNum(5), 6);
    check("angleNum(5)", e.angleNum(5), 6);
    check("satNum(5)", e.satNum(5), 6);
    check("nonNullNum(5)", e.nonNullNum(5), 6);
    // ** 指数：wasm 无原生 f64.pow → 宿主 Math.pow import（Math.pow 语义：0^0=1、0^-1=Infinity）
    check("pow2(2,10)", e.pow2(2, 10), 1024);
    check("powRight(2)", e.powRight(2), 512);        // 2^(3^2)=2^9：右结合
    check("powNaN0(0)", e.powNaN0(0), 1);            // 0^0=1
    check("pow0neg(-1)", isFinite(e.pow0neg(-1)), false);   // 0^-1=Infinity
    // NaN truthy（JS Boolean(NaN)=false）：此前 emitCond 仅 x!=0 → NaN 误判 truthy 得 1。
    check("nanTruthy(0,0)", e.nanTruthy(0, 0), 7);   // NaN ? 1 : 7 → 7
    check("nanAnd(0,0)", isNaN(e.nanAnd(0, 0)), true);  // NaN && 3 → NaN
    check("nanOr(0,0)", e.nanOr(0, 0), 9);              // NaN || 9 → 9
    // ??（num）：f64 永非 null/undefined → 结果恒 = 左操作数（0/NaN 亦非空）
    check("nnNum(0,9)", e.nnNum(0, 9), 0);
    check("nnNum(5,9)", e.nnNum(5, 9), 5);
    check("nnNum(0/0,9)", isNaN(e.nnNum(0 / 0, 9)), true);
}

async function runTagged() {
    // tagged 路径：f64 NaN-box（值=i64；数值=原始 f64 位型，句柄=高16位0x7FF9）
    const src = path.join(__dirname, "mix.ts");
    const wasm = path.join(os.tmpdir(), "qz_aot_mix.wasm");
    const r = compileTS(src, wasm, {});
    const qz = makeQzvm(r.strings, { fields: r.fields });
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
    qz.bindMem(instance.exports.memory);
    if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
    const e = instance.exports;
    qz.bindClosures(instance.exports, r.lamMeta);
    const call = (n, a) => {
        const m = r.funcMeta.find(f => f.name === n);
        if (e.__bump_reset) e.__bump_reset();
        const conv = m.mode === "num" ? a : a.map(x => qz._fromJS(x));
        const res = e[n](...conv);
        return m.mode === "num" ? res : qz._toJS(res);
    };
    check("mix.fib(20)", call("fib", [20]), 6765);
    check("mix.numWork(3000)", call("numWork", [3000]), 66268200);
    check("mix.objWork(5)", call("objWork", [5]), 40);
    check("mix.bigAcc(3000)", call("bigAcc", [3000]), 3000000000000);   // 3e12 超 32 位：NaN-box 53 位精确
    check("mix.arrWork(3)", call("arrWork", [3]), 6);   // [1,2]+push0,1,2 → [1,2,0,1,2]; pop=2; s=4 → 6
    // 数组方法（宿主派发）：split/map/filter/reduce 经 closure_call；句柄别名保活
    check("mix.arrMethods()", call("arrMethods", []), 25);
    check("mix.arrAlias()", call("arrAlias", []), 303);
    check("mix.splitIndex()", call("splitIndex", []), "z3");
    check("mix.literals()", call("literals", []), 5);       // null/undefined/true/false 字面量
    check("mix.arrLengthSet()", call("arrLengthSet", []), 112);  // a.length= 截断/扩容
    check("mix.negNumStr()", call("negNumStr", []), "-42|-7|5000000000");  // numstr 负数/大数
    check("mix.utf8Str()", call("utf8Str", []), "héllo 世界😀");       // wasm→JS UTF-8 解码
    check("mix.bigAscii()", call("bigAscii", []), 700001);            // >65535B → _utf8 分块路径
    check("除法(7/2)", qz._toJS(qz.div(qz._fromJS(7), qz._fromJS(2))), 3.5);
    check("mix.tryWork()", call("tryWork", []), 1007);   // 0+1+2 +4(throw"stop".length) +1000
    // 字符串：wasm 内表示（0x7FFA 句柄 + data 段字面量 + 原地 append）
    const strs = path.join(os.tmpdir(), "qz_aot_str.wasm");
    const rs = compileTS(path.join(__dirname, "strwork.ts"), strs, {});
    const qzs = makeQzvm(rs.strings, { fields: rs.fields });
    const { instance: instS } = await WebAssembly.instantiate(fs.readFileSync(strs), { qz: qzs });
    qzs.bindMem(instS.exports.memory);
    if (instS.exports.__bump) qzs.bindBump(instS.exports.__bump);
    const callS = (n, a) => { if (instS.exports.__bump_reset) instS.exports.__bump_reset(); return qzs._toJS(instS.exports[n](...a.map(x => qzs._fromJS(x)))); };
    check("strWork(5)", callS("strWork", [5]), "001234");
    check("strWork(0)", callS("strWork", [0]), "0");
    { let ref = "0"; for (let i = 0; i < 2000; i++) ref += i; check("strWork(2000)", callS("strWork", [2000]), ref); }
    check("strWorkEq(5)", callS("strWorkEq", [5]), "001234");
    check("strMethods()", callS("strMethods", []), "Hello|HELLO, WORLD|7|e|Hello, qz|ababab");
    // 闭包：箭头提升为 __lam_N，捕获 cell 块 + qz.closure_call 派发
    const closSrc = `
function adder(n: number): number { const f = (x: number) => x + n; return f(10); }
function apply(fn: any, v: number): number { return fn(v); }
function closure(): number { const base = 100; const g = (x: any) => x + base; return apply(g, 5); }
`;
    const ct = path.join(os.tmpdir(), "qz_aot_clos.ts");
    const cw = path.join(os.tmpdir(), "qz_aot_clos.wasm");
    fs.writeFileSync(ct, closSrc);
    const rcl = compileTS(ct, cw, {});
    const qzc = makeQzvm(rcl.strings, { fields: rcl.fields });
    const { instance: instCl } = await WebAssembly.instantiate(fs.readFileSync(cw), { qz: qzc });
    qzc.bindMem(instCl.exports.memory);
    if (instCl.exports.__bump) qzc.bindBump(instCl.exports.__bump);
    qzc.bindClosures(instCl.exports, rcl.lamMeta);
    const callC = (n, a) => { const m = rcl.funcMeta.find(f => f.name === n); if (instCl.exports.__bump_reset) instCl.exports.__bump_reset(); const r = instCl.exports[n](...a.map(x => qzc._fromJS(x))); return m.mode === "num" ? r : qzc._toJS(r); };
    check("闭包.adder(5)", callC("adder", [5]), 15);
    check("闭包.closure()", callC("closure", []), 105);
    // 闭包写捕获变量：外层不访问 → 语义正确（blk 内读写一致）；外层也访问 → 编译期报错（防静默错值）
    const cwT = path.join(os.tmpdir(), "qz_aot_closwrite.ts");
    fs.writeFileSync(cwT, "export function c1(): any { let c = 0; const f = function(): number { c++; return c; }; f(); f(); return f(); }\nexport function c2(): any { let n = 10; const f = () => { n += 5; return n; }; f(); return f(); }\n");
    const rw = compileTS(cwT, path.join(os.tmpdir(), "qz_aot_closwrite.wasm"), {});
    const qzw = makeQzvm(rw.strings, { fields: rw.fields });
    const { instance: instW } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_closwrite.wasm")), { qz: qzw });
    qzw.bindMem(instW.exports.memory); if (instW.exports.__bump) qzw.bindBump(instW.exports.__bump);
    qzw.bindClosures(instW.exports, rw.lamMeta);
    check("闭包写c++ (外层不访问)", qzw._toJS(instW.exports.c1()), 3);
    check("闭包写+= (外层不访问)", qzw._toJS(instW.exports.c2()), 20);
    // 闭包共享环境：外层与闭包共享同一 env → 写回对外层可见（不再是值快照）
    fs.writeFileSync(cwT, "export function d2(): any { let z = 5; const f = () => z--; f(); return z; }\n"
      + "export function d3(): any { let x = 1; const f = () => { x = 2; }; f(); return x; }\n"
      + "export function two(): any { let c = 0; const inc = () => ++c; const get = () => c; inc(); inc(); return get(); }\n"
      + "export function nest(): any { let a = 1; const f = () => { let b = 2; const g = () => { a += b; return a; }; g(); return a; }; f(); return a; }\n"
      + "export function par(): any { const f = (n: number) => () => ++n; const g = f(7); g(); g(); return g(); }\n");
    const rSh = compileTS(cwT, path.join(os.tmpdir(), "qz_aot_share.wasm"), {});
    const qzSh = makeQzvm(rSh.strings, { fields: rSh.fields });
    const { instance: instSh } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_share.wasm")), { qz: qzSh });
    qzSh.bindMem(instSh.exports.memory); if (instSh.exports.__bump) qzSh.bindBump(instSh.exports.__bump);
    qzSh.bindClosures(instSh.exports, rSh.lamMeta);
    const callSh = (n) => { if (instSh.exports.__bump_reset) instSh.exports.__bump_reset(); return qzSh._toJS(instSh.exports[n]()); };
    check("闭包写回对外层可见 (z--)", callSh("d2"), 4);
    check("闭包赋值对外层可见 (x=2)", callSh("d3"), 2);
    check("两闭包共享同一变量", callSh("two"), 2);
    check("嵌套闭包链 (a+=b)", callSh("nest"), 3);
    check("参数被闭包捕获 (++n)", callSh("par"), 10);
    // 字符串参数（_fromJS 须 strWriteback 成 0x7FFA 句柄；此前仅 tagHandle → .length/concat 静默 0）。
    const stT = path.join(os.tmpdir(), "qz_aot_strparam.ts");
    fs.writeFileSync(stT, "export function strLen(s: any): any { return s.length; }\nexport function strType(s: any): any { return typeof s; }\nexport function strCat(n: number, s: any): any { return s + n; }\nexport function nanRet(a: number, b: number): any { const x = a / b; return x; }\nexport function tagPow(a: any, b: any): any { return a ** b; }\nexport function tagNN(a: any, b: any): any { return a ?? b; }\nexport function tagNNA(a: any): any { let x = a; x ??= 42; return x; }\nexport function semAdd(a: any, b: any): any { return a + b; }\nexport function semTypeof(a: any): any { return typeof a; }\nexport function semEq(a: any, b: any): any { return a == b; }\nexport function semSeq(a: any, b: any): any { return a === b; }\nexport function semNull(): any { return null; }\nexport function semUndef(): any { return undefined; }\nexport function semNot(a: any): any { return !a; }\nexport function semTnot(a: any): any { return ~a; }\nexport function semOpt(): any { const o: any = { x: 1 }; return o?.x; }\nexport function semOptN(): any { const o: any = null; return o?.x ?? 99; }\nexport function semJoin(a: any): any { return a.join(); }\nexport function semSort(a: any): any { return a.sort(); }\nexport function semSplice(a: any, i: any): any { return a.splice(i); }\n");
    const rst2 = compileTS(stT, path.join(os.tmpdir(), "qz_aot_strparam.wasm"), {});
    const qzsp = makeQzvm(rst2.strings, { fields: rst2.fields });
    const { instance: instSp } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_strparam.wasm")), { qz: qzsp });
    qzsp.bindMem(instSp.exports.memory); if (instSp.exports.__bump) qzsp.bindBump(instSp.exports.__bump);
    const callSp = (n, a) => { if (instSp.exports.__bump_reset) instSp.exports.__bump_reset(); return qzsp._toJS(instSp.exports[n](...a.map(x => qzsp._fromJS(x)))); };
    check("strParam.len(\"abc\")", callSp("strLen", ["abc"]), 3);
    check("strParam.typeof", callSp("strType", ["abc"]), "string");
    check("strParam.cat(\"a\",5)", callSp("strCat", [5, "a"]), "a5");
    // NaN 返回值不得被误判为数组（数组标签原 0x7FF8 = canonical NaN → box(NaN) 相撞）
    const nanVal = callSp("nanRet", [0, 0]);
    check("strParam.nanRet(0,0) is NaN", typeof nanVal === "number" && isNaN(nanVal), true);
    // tagged ** ：qz.pow 经 toJS 解引用 → Math.pow；含 ToNumber 强转（"3"**2=9）
    check("strParam.pow(2,10)", callSp("tagPow", [2, 10]), 1024);
    check("strParam.pow(3,0.5)", callSp("tagPow", [3, 0.5]), Math.sqrt(3));
    // ?? nullish 合并：null/undefined（TAG|0）→ 右值；0/""/false 非空 → 左值
    check("strParam.nn(null,5)", callSp("tagNN", [null, 5]), 5);
    check("strParam.nn(undef,5)", callSp("tagNN", [undefined, 5]), 5);
    check("strParam.nn(0,5)", callSp("tagNN", [0, 5]), 0);
    check("strParam.nn(3,5)", callSp("tagNN", [3, 5]), 3);
    check("strParam.nn(\"\",5)", callSp("tagNN", ["", 5]), "");
    check("strParam.nna(null)", callSp("tagNNA", [null]), 42);
    check("strParam.nna(99)", callSp("tagNNA", [99]), 99);
    // 语义精确（2026-10-15 审计）：+ 的 ToPrimitive/ToNumber、typeof、宽松 ==、null/undefined 区分、单目 ~/!
    check("strParam.add(1,2)", callSp("semAdd", [1, 2]), 3);
    check("strParam.add(\"s\",true)", callSp("semAdd", ["s", true]), "strue");
    check("strParam.add(null,1)", callSp("semAdd", [null, 1]), 1);          // null ToNumber=0
    check("strParam.add(null,null)", callSp("semAdd", [null, null]), 0);
    check("strParam.add(undef,5) is NaN", isNaN(callSp("semAdd", [undefined, 5])), true);  // undefined ToNumber=NaN
    check("strParam.typeof(null)", callSp("semTypeof", [null]), "object");
    check("strParam.typeof(undef)", callSp("semTypeof", [undefined]), "undefined");
    check("strParam.typeof(true)", callSp("semTypeof", [true]), "boolean");
    check("strParam.typeof(1)", callSp("semTypeof", [1]), "number");
    check("strParam.eq(1,\"1\")", callSp("semEq", [1, "1"]), true);         // 宽松 ==
    check("strParam.eq(null,undef)", callSp("semEq", [null, undefined]), true);
    check("strParam.seq(1,true)", callSp("semSeq", [1, true]), false);      // 严格 ===
    check("strParam.null is null", callSp("semNull", []), null);
    check("strParam.undef is undefined", callSp("semUndef", []), undefined);
    check("strParam.not(true)", callSp("semNot", [true]), false);
    check("strParam.not(null)", callSp("semNot", [null]), true);
    check("strParam.tnot(5)", callSp("semTnot", [5]), -6);                  // ~5
    check("strParam.tnot(true)", callSp("semTnot", [true]), -2);            // ~1
    // .length 是 UTF-16 码元数（非 UTF-8 字节数）：非 ASCII 修正
    check("strParam.len(cjk)", callSp("strLen", ["你好"]), 2);
    check("strParam.len(emoji)", callSp("strLen", ["😀"]), 2);
    check("strParam.len(utf8)", callSp("strLen", ["héllo"]), 5);
    // 可选链 `?.`（base nullish → undefined，短路不求 index）
    check("strParam.opt().x", callSp("semOpt", []), 1);
    check("strParam.optN() null?.x??99", callSp("semOptN", []), 99);
    // 数组方法默认参数（a0/a1 是 tagged 句柄，非 JS undefined）
    check("strParam.join() 默认逗号", callSp("semJoin", [[1, 2, 3]]), "1,2,3");
    check("strParam.sort() 默认字典序", JSON.stringify(callSp("semSort", [[3, 1, 2, 10]])), JSON.stringify([1, 10, 2, 3]));
    check("strParam.splice(1)", JSON.stringify(callSp("semSplice", [[1, 2, 3, 4], 1])), JSON.stringify([2, 3, 4]));
    // 内建全局（2026-10-15）：Math/String/Number/JSON/Object/Array… 经 qz.builtin 宿主分派
    fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_builtin.ts"),
        "export function fl(a: any): any { return Math.floor(a); }\n"
      + "export function ma(a: any, b: any): any { return Math.max(a, b); }\n"
      + "export function mm(a: any, b: any, c: any): any { return Math.max(a, b, c); }\n"
      + "export function st(a: any): any { return String(a); }\n"
      + "export function nm(a: any): any { return Number(a); }\n"
      + "export function pi(): any { return Math.PI; }\n"
      + "export function isN(a: any): any { return isNaN(a); }\n"
      + "export function js(a: any): any { return JSON.stringify(a); }\n"
      + "export function ok(a: any): any { return Object.keys(a); }\n"
      + "export function isArr(a: any): any { return Array.isArray(a); }\n"
      + "export function isInt(a: any): any { return Number.isInteger(a); }\n"
      + "export function sfcc(a: any, b: any): any { return String.fromCharCode(a, b); }\n");
    const rbi = compileTS(path.join(os.tmpdir(), "qz_aot_builtin.ts"), path.join(os.tmpdir(), "qz_aot_builtin.wasm"), {});
    const qzb = makeQzvm(rbi.strings, { fields: rbi.fields });
    const { instance: instBi } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_builtin.wasm")), { qz: qzb });
    qzb.bindMem(instBi.exports.memory); if (instBi.exports.__bump) qzb.bindBump(instBi.exports.__bump);
    const callB = (n, a) => { if (instBi.exports.__bump_reset) instBi.exports.__bump_reset(); return qzb._toJS(instBi.exports[n](...a.map(x => qzb._fromJS(x)))); };
    check("Math.floor(3.7)", callB("fl", [3.7]), 3);
    check("Math.max(2,5)", callB("ma", [2, 5]), 5);
    check("Math.max(1,2,3)", callB("mm", [1, 2, 3]), 3);   // 变参：n=3 不传 undefined 占位
    check("String(5)", callB("st", [5]), "5");
    check("String(true)", callB("st", [true]), "true");
    check("String(null)", callB("st", [null]), "null");
    check("Number(\"7\")", callB("nm", ["7"]), 7);
    check("Math.PI", callB("pi", []), Math.PI);
    check("isNaN(\"x\")", callB("isN", ["x"]), true);
    check("isNaN(0)", callB("isN", [0]), false);
    check("JSON.stringify(5)", callB("js", [5]), "5");
    check("JSON.stringify(null)", callB("js", [null]), "null");
    check("Object.keys", JSON.stringify(callB("ok", [{ a: 1, b: 2 }])), JSON.stringify(["a", "b"]));
    check("Array.isArray([1])", callB("isArr", [[1]]), true);
    check("Array.isArray(\"x\")", callB("isArr", ["x"]), false);
    check("Number.isInteger(3)", callB("isInt", [3]), true);
    check("Number.isInteger(3.5)", callB("isInt", [3.5]), false);
    check("String.fromCharCode(65,66)", callB("sfcc", [65, 66]), "AB");
    // 解构声明（单层数组/对象；嵌套明确报错）
    fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_destr.ts"),
        "export function dArr(): any { const [x, y] = [10, 20]; return x + y; }\n"
      + "export function dSkip(): any { const [, b] = [1, 2]; return b; }\n"
      + "export function dObj(): any { const { a, b } = { a: 3, b: 4 }; return a + b; }\n"
      + "export function dRen(): any { const { a: z } = { a: 5 }; return z; }\n"
      + "export function dVar(): any { const s = [7, 8]; const [p, q] = s; return p + q; }\n");
    const rDe = compileTS(path.join(os.tmpdir(), "qz_aot_destr.ts"), path.join(os.tmpdir(), "qz_aot_destr.wasm"), {});
    const qzDe = makeQzvm(rDe.strings, { fields: rDe.fields });
    const { instance: instDe } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_destr.wasm")), { qz: qzDe });
    qzDe.bindMem(instDe.exports.memory); if (instDe.exports.__bump) qzDe.bindBump(instDe.exports.__bump);
    const callDe = (n) => { if (instDe.exports.__bump_reset) instDe.exports.__bump_reset(); return qzDe._toJS(instDe.exports[n]()); };
    check("解构 [x,y]", callDe("dArr"), 30);
    check("解构 [,b]", callDe("dSkip"), 2);
    check("解构 {a,b}", callDe("dObj"), 7);
    check("解构 {a:z}", callDe("dRen"), 5);
    check("解构 from var", callDe("dVar"), 15);
    let nestThrew = false;
    fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_destr.ts"), "export function f(): any { const [[p]] = [[7]]; return p; }\n");
    try { compileTS(path.join(os.tmpdir(), "qz_aot_destr.ts"), path.join(os.tmpdir(), "qz_aot_destr.wasm"), {}); }
    catch (e) { nestThrew = /嵌套解构未实现/.test(e.message); }
    // 嵌套解构（[[a],[b]] / {a:{b}}）已实现（2026-10-16）：见 runSemantics 的 destructure-nested 检查
    // 静态方法（含继承）
    fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_static.ts"),
        "class U { static sq(n: number): number { return n * n; } static tag(): any { return \"u\"; } }\n"
      + "class V extends U {}\n"
      + "export function sq(): any { return U.sq(5); }\n"
      + "export function tag(): any { return U.tag(); }\n"
      + "export function inh(): any { return V.sq(3); }\n");
    const rSt = compileTS(path.join(os.tmpdir(), "qz_aot_static.ts"), path.join(os.tmpdir(), "qz_aot_static.wasm"), {});
    const qzSt = makeQzvm(rSt.strings, { fields: rSt.fields });
    const { instance: instSt } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_static.wasm")), { qz: qzSt });
    qzSt.bindMem(instSt.exports.memory); if (instSt.exports.__bump) qzSt.bindBump(instSt.exports.__bump);
    const callSt = (n) => { if (instSt.exports.__bump_reset) instSt.exports.__bump_reset(); return qzSt._toJS(instSt.exports[n]()); };
    check("static U.sq(5)", callSt("sq"), 25);
    check("static U.tag()", callSt("tag"), "u");
    check("static 继承 V.sq(3)", callSt("inh"), 9);
    // instanceof（实例专用 tag 0x7FFE + 内存 [0]=clsId + classMeta 父链）
    fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_instof.ts"),
        "class IA { v: number = 1; }\n"
      + "class IB extends IA {}\n"
      + "class IC {}\n"
      + "export function i1(): any { return new IB() instanceof IB; }\n"
      + "export function i2(): any { return new IB() instanceof IA; }\n"
      + "export function i3(): any { return new IB() instanceof IC; }\n"
      + "export function i4(): any { return new IA() instanceof IB; }\n"
      + "export function i5(): any { return (5 as any) instanceof IA; }\n"
      + "export function i6(): any { return (null as any) instanceof IA; }\n"
      + "export function i7(): any { const o: any = { x: 1 }; return o instanceof IA; }\n"
      + "export function i8(): any { const a: any[] = [1]; return a instanceof IA; }\n"
      + "export function i9(): any { const b = new IB(); return b === b && b.v; }\n");
    const rIo = compileTS(path.join(os.tmpdir(), "qz_aot_instof.ts"), path.join(os.tmpdir(), "qz_aot_instof.wasm"), {});
    const qzIo = makeQzvm(rIo.strings, { fields: rIo.fields });
    const { instance: instIo } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_instof.wasm")), { qz: qzIo });
    qzIo.bindMem(instIo.exports.memory); if (instIo.exports.__bump) qzIo.bindBump(instIo.exports.__bump);
    qzIo.bindClasses(instIo.exports, rIo.classMeta);
    const callIo = (n) => { if (instIo.exports.__bump_reset) instIo.exports.__bump_reset(); return qzIo._toJS(instIo.exports[n]()); };
    check("instanceof 自身", callIo("i1"), true);
    check("instanceof 父类", callIo("i2"), true);
    check("instanceof 无关类", callIo("i3"), false);
    check("父实例 instanceof 子类", callIo("i4"), false);
    check("5 instanceof 类", callIo("i5"), false);
    check("null instanceof 类", callIo("i6"), false);
    check("POJO instanceof 类", callIo("i7"), false);
    check("数组 instanceof 类", callIo("i8"), false);
    check("实例 === 自身 && 字段", callIo("i9"), 1);
    // 内建类（宿主构造 0x7FFD）：Error 族 / Map / Set / Date / Array / RegExp
    fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_bicls.ts"),
        "export function err(): any { try { throw new Error(\"boom\"); } catch(e) { return e.message; } }\n"
      + "export function errs(): any { try { throw new TypeError(\"bad\"); } catch(e) { return String(e); } }\n"
      + "export function map(): any { const m = new Map(); m.set(\"a\", 1); m.set(\"b\", 2); return m.get(\"a\") + m.get(\"b\"); }\n"
      + "export function setsz(): any { const s = new Set(); s.add(1); s.add(2); s.add(1); return s.size; }\n"
      + "export function date(): any { return new Date(0).getTime(); }\n"
      + "export function arrn(): any { return new Array(3).length; }\n"
      + "export function re(): any { return new RegExp(\"a+\").test(\"aaa\"); }\n"
      + "export function jp(): any { const o: any = JSON.parse(\"{\\\"a\\\":1,\\\"s\\\":\\\"hi\\\"}\"); return o.a + o.s; }\n"
      + "export function jpw(): any { const o: any = JSON.parse(\"{\\\"a\\\":1}\"); o.a = 9; return o.a; }\n");
    const rBc = compileTS(path.join(os.tmpdir(), "qz_aot_bicls.ts"), path.join(os.tmpdir(), "qz_aot_bicls.wasm"), {});
    const qzBc = makeQzvm(rBc.strings, { fields: rBc.fields });
    const { instance: instBc } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_bicls.wasm")), { qz: qzBc });
    qzBc.bindMem(instBc.exports.memory); if (instBc.exports.__bump) qzBc.bindBump(instBc.exports.__bump);
    const callBc = (n) => { if (instBc.exports.__bump_reset) instBc.exports.__bump_reset(); return qzBc._toJS(instBc.exports[n]()); };
    check("Error + .message", callBc("err"), "boom");
    check("TypeError + String()", callBc("errs"), "TypeError: bad");
    check("Map set/get", callBc("map"), 3);
    check("Set.size", callBc("setsz"), 2);
    check("Date.getTime", callBc("date"), 0);
    check("new Array(3).length", callBc("arrn"), 3);
    check("RegExp.test", callBc("re"), true);
    check("JSON.parse 字段读", callBc("jp"), "1hi");
    check("JSON.parse 字段写", callBc("jpw"), 9);
    // void / **= / 字段 ??= / 展开 / POJO↔宿主物化（POJO 句柄标签修正 + host 物化）
    fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_misc.ts"),
        "export function vd(): any { let n = 0; void (n = 5); return n; }\n"
      + "export function pwe(): any { let x = 2; x **= 3; return x; }\n"
      + "export function nneF(): any { const o: any = { a: 0 }; o.a ??= 9; return o.a; }\n"
      + "export function nneF2(): any { const o: any = { a: 3 }; o.a ??= 9; return o.a; }\n"
      + "export function sp(): any { const a: any = [1,2]; const b: any = [...a, 3]; return b.length + b[2]; }\n"
      + "export function sp2(): any { const a: any = [1]; const b: any = [0, ...a, 9]; return b.join(\",\"); }\n"
      + "export function spo(): any { const o: any = { a: 1 }; const p: any = { ...o, b: 2 }; return p.a + p.b; }\n"
      + "export function spo2(): any { const o: any = { a: 1 }; const p: any = { ...o, ...o }; return p.a; }\n"
      + "export function js(): any { const o: any = { a: 1, b: \"x\" }; return JSON.stringify(o); }\n"
      + "export function okeys(): any { const o: any = { a: 1, b: 2 }; return Object.keys(o).join(\",\"); }\n"
      + "export function ovals(): any { const o: any = { a: 7 }; return Object.values(o)[0]; }\n"
      + "export function tpo(): any { const o: any = { a: 1 }; return typeof o; }\n"
      + "export function ideq(): any { const o: any = { a: 1 }; return o === o; }\n"
      + "export function mkeq(): any { return ({ a: 1 } as any) === ({ a: 1 } as any); }\n"
      + "export function inClass(): any { class L { v: number = 5; get(): number { return this.v; } } return new L().get(); }\n"
      + "export function inFn(): any { function h(n: number): number { return n * 3; } return h(4); }\n");
    const rMs = compileTS(path.join(os.tmpdir(), "qz_aot_misc.ts"), path.join(os.tmpdir(), "qz_aot_misc.wasm"), {});
    const qzMs = makeQzvm(rMs.strings, { fields: rMs.fields });
    const { instance: instMs } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_misc.wasm")), { qz: qzMs });
    qzMs.bindMem(instMs.exports.memory); if (instMs.exports.__bump) qzMs.bindBump(instMs.exports.__bump);
    qzMs.bindClosures(instMs.exports, rMs.lamMeta); qzMs.bindClasses(instMs.exports, rMs.classMeta);
    const callMs = (n) => { if (instMs.exports.__bump_reset) instMs.exports.__bump_reset(); return qzMs._toJS(instMs.exports[n]()); };
    check("void (n=5) 副作用保留", callMs("vd"), 5);
    check("x **= 3", callMs("pwe"), 8);
    check("o.a ??= 9 (0 非空)", callMs("nneF"), 0);
    check("o.a ??= 9 (3 非空)", callMs("nneF2"), 3);
    check("数组展开 [...a,3]", callMs("sp"), 6);
    check("数组展开 [0,...a,9]", callMs("sp2"), "0,1,9");
    check("对象展开 {...o,b:2}", callMs("spo"), 3);
    check("对象展开 {...o,...o}", callMs("spo2"), 1);
    check("JSON.stringify(POJO)", callMs("js"), "{\"a\":1,\"b\":\"x\"}");
    check("Object.keys(POJO)", callMs("okeys"), "a,b");
    check("Object.values(POJO)", callMs("ovals"), 7);
    check("typeof POJO", callMs("tpo"), "object");
    check("POJO === 自身", callMs("ideq"), true);
    check("不同 POJO !==", callMs("mkeq"), false);
    check("函数内 class 声明", callMs("inClass"), 5);
    check("函数内 function 声明", callMs("inFn"), 12);
    // 类静态字段（lazy 初始化 + 宿主表）与静态方法
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_static.ts"),
            "class C { static n: number = 1; static log: string = \"\"; static inc(): number { return ++C.n; }\n"
          + "  static mul(k: number): number { return C.n * k; }\n"
          + "  static push(s: string): string { C.log = C.log + s; return C.log; } }\n"
          + "class D extends C { static bump(): number { return ++C.n; } }\n"
          + "export function seq(): string { let out = \"\"; out = out + C.n + \",\"; out = out + (++C.n) + \",\";\n"
          + "  out = out + (C.n++) + \",\"; out = out + C.n + \",\"; out = out + (C.n += 5) + \",\"; C.n = 100;\n"
          + "  out = out + C.mul(2) + \",\"; out = out + C.inc() + \",\"; out = out + D.bump() + \",\";\n"
          + "  out = out + C.push(\"a\") + C.push(\"b\"); return out; }\n");
        const rSt = compileTS(path.join(os.tmpdir(), "qz_aot_static.ts"), path.join(os.tmpdir(), "qz_aot_static.wasm"), {});
        const qzSt = makeQzvm(rSt.strings, { fields: rSt.fields });
        const { instance: instSt } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_static.wasm")), { qz: qzSt });
        qzSt.bindMem(instSt.exports.memory); if (instSt.exports.__bump) qzSt.bindBump(instSt.exports.__bump);
        qzSt.bindClosures(instSt.exports, rSt.lamMeta); qzSt.bindClasses(instSt.exports, rSt.classMeta);
        check("静态字段/方法序列", qzSt._toJS(instSt.exports.seq()), "1,2,2,3,8,200,101,102,aab");
    }
    // for-in（改写为 for (k of Object.keys(o))）+ 动态字符串键 o[k]
    fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_forin.ts"),
        "export function fi(): any { const o: any = { a: 1, b: 2, c: 3 }; let s = \"\"; for (const k in o) s = s + k; return s; }\n"
      + "export function fisum(): any { const o: any = { a: 1, b: 2, c: 3 }; let t = 0; for (const k in o) t = t + o[k]; return t; }\n"
      + "export function fihost(): any { const o: any = JSON.parse(\"{\\\"x\\\":1,\\\"y\\\":2}\"); let s = \"\"; for (const k in o) s = s + k; return s; }\n"
      + "export function fiarr(): any { const a: any = [10, 20]; let s = 0; for (const i in a) s = s + a[i]; return s; }\n"
      + "export function fow(): any { const a: any = [1,2,3]; let s = 0; for (const v of a) s = s + v; return s; }\n"
      + "export function fostr(): any { const a: any = [\"x\",\"y\"]; let out = \"\"; for (const k of a) out = out + \"<\" + k + \">\"; return out; }\n");
    const rFi = compileTS(path.join(os.tmpdir(), "qz_aot_forin.ts"), path.join(os.tmpdir(), "qz_aot_forin.wasm"), {});
    const qzFi = makeQzvm(rFi.strings, { fields: rFi.fields });
    const { instance: instFi } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_forin.wasm")), { qz: qzFi });
    qzFi.bindMem(instFi.exports.memory); if (instFi.exports.__bump) qzFi.bindBump(instFi.exports.__bump);
    qzFi.bindClosures(instFi.exports, rFi.lamMeta); qzFi.bindClasses(instFi.exports, rFi.classMeta);
    const callFi = (n) => { if (instFi.exports.__bump_reset) instFi.exports.__bump_reset(); return qzFi._toJS(instFi.exports[n]()); };
    check("for-in 键", callFi("fi"), "abc");
    check("for-in 动态键取值", callFi("fisum"), 6);
    check("for-in 宿主对象", callFi("fihost"), "xy");
    check("for-in 数组", callFi("fiarr"), 30);
    check("for-of 求和", callFi("fow"), 6);
    check("for-of 字符串拼接", callFi("fostr"), "<x><y>");
    // in / delete
    fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_indel.ts"),
        "export function iin(): any { const o: any = { a: 1 }; return (\"a\" in o) + \":\" + (\"b\" in o); }\n"
      + "export function iinHost(): any { const o: any = JSON.parse(\"{\\\"a\\\":1}\"); return (\"a\" in o); }\n"
      + "export function iinArr(): any { const a: any = [1,2]; return (0 in a) + \":\" + (5 in a); }\n"
      + "export function del(): any { const o: any = { a: 1, b: 2 }; const r = delete o.a; return r + \":\" + (o.a === undefined) + \":\" + o.b; }\n"
      + "export function delHost(): any { const o: any = JSON.parse(\"{\\\"a\\\":1,\\\"b\\\":2}\"); const r = delete o.a; return r + \":\" + (o.a === undefined) + \":\" + o.b; }\n");
    const rId = compileTS(path.join(os.tmpdir(), "qz_aot_indel.ts"), path.join(os.tmpdir(), "qz_aot_indel.wasm"), {});
    const qzId = makeQzvm(rId.strings, { fields: rId.fields });
    const { instance: instId } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_indel.wasm")), { qz: qzId });
    qzId.bindMem(instId.exports.memory); if (instId.exports.__bump) qzId.bindBump(instId.exports.__bump);
    const callId = (n) => { if (instId.exports.__bump_reset) instId.exports.__bump_reset(); return qzId._toJS(instId.exports[n]()); };
    check("in (POJO)", callId("iin"), "true:false");
    check("in (宿主对象)", callId("iinHost"), true);
    check("in (数组)", callId("iinArr"), "true:false");
    check("delete (POJO)", callId("del"), "true:true:2");
    check("delete (宿主对象)", callId("delHost"), "true:true:2");
}

async function runClasses() {
    const wasm = path.join(os.tmpdir(), "qz_aot_cls.wasm");
    const r = compileTS(path.join(__dirname, "cls.ts"), wasm, {});
    const qz = makeQzvm(r.strings, { fields: r.fields });
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
    qz.bindMem(instance.exports.memory);
    if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
    qz.bindClasses(instance.exports, r.classMeta);
    const call = (n) => { const m = r.funcMeta.find(f => f.name === n); const res = instance.exports[n](); return m.mode === "num" ? res : qz._toJS(res); };
    check("类.继承+super", call("dogRun"), "hi woof/woof!");
    check("类.字段默认值+遮蔽", call("fieldRun"), 43);
    check("类.方法多参", call("argRun"), 7);
    check("类.合成ctor转发参", call("fwdRun"), "bit/3");
    check("类.实例真值", call("truthyRun"), 5);           // 类实例句柄 tag 同 JS 句柄表：truthy 须按 tag 判，勿经 toJS
    check("类.逻辑赋值动态化", call("andAssignRun"), 300);  // x &&= d 使 x 动态化 → 静态直调须作废（Dog 300 ≠ Animal 400）
    check("类.嵌套实参", call("nestedArgRun"), 3520);      // 实参含方法调用：须走值栈，勿用固定暂存槽（self 被覆盖）
    check("类.前置自增字段", call("preFieldInc"), 4043);   // ++d.legs：结果=新值，字段更新
    check("类.后置自增字段", call("postFieldInc"), 3004);  // d.legs++：结果=旧值，字段更新
    check("类.前置自减字段", call("preFieldDec"), 202);
    check("类.后置自减字段", call("postFieldDec"), 302);
    check("类.字段自增循环", call("fieldIncLoop"), 2508);
}


// DWARF 调试段：编译 --debug 须产 .debug_line/_info/_abbrev/_str 且行表可映射。
// 静默失败风险高（段序/LEB/终止符），故守：段存在 + 行表含预期源码行 + low_pc 基址约定。
async function runDwarf() {
    const src = path.join(os.tmpdir(), "qz_aot_dwarf.ts");
    const wasm = path.join(os.tmpdir(), "qz_aot_dwarf.wasm");
    fs.writeFileSync(src, `function add(a: number, b: number): number { const c = a + b; return c; }\n`);
    const r = compileTS(src, wasm, { debug: true });
    const buf = fs.readFileSync(wasm);
    // 扫自定义段名（记录各段 payload 起点）
    const names = {}; let li = -1;
    for (let i = 8; i < buf.length;) { const sid = buf[i++]; let ln = 0, s = 0, b; do { b = buf[i++]; ln |= (b & 0x7f) << s; s += 7; } while (b & 0x80); const pstart = i; if (sid === 0) { let l = 0, s2 = 0, b2; do { b2 = buf[i++]; l |= (b2 & 0x7f) << s2; s2 += 7; } while (b2 & 0x80); const nm = buf.slice(i, i + l).toString(); names[nm] = i + l; if (nm === ".debug_line") li = i + l; } i = pstart + ln; }
    check("dwarf.段含debug_line", ".debug_line" in names, true);
    check("dwarf.段含debug_info", ".debug_info" in names, true);
    check("dwarf.段含debug_abbrev", ".debug_abbrev" in names, true);
    check("dwarf.段含debug_str", ".debug_str" in names, true);
    // 行表：程序起点 = 单位头(10) + prologue_length；首 op 应 set_address(0x00 扩展, len=5, 0x02) → u32 地址
    const prog = li + 10 + buf.readUInt32LE(li + 6);
    const addr = buf.readUInt32LE(prog + 3);
    check("dwarf.首地址在文件内(段内相对约定)", addr > 0 && addr < buf.length, true);
    // wasm 仍可运行
    const qz = makeQzvm(r.strings, { fields: r.fields });
    const { instance } = await WebAssembly.instantiate(buf, { qz });
    check("dwarf.带段仍可执行", instance.exports.add(2, 3), 5);
}

/* 多文件内联（tsc createProgram 解析模块图）+ import 别名 + 冲突检测。
 * 守「不同 .ts 模块编进同一 wasm」：跨文件调用、`import { x as y }` 别名折回、
 * 顶层同名显式报错（不静默覆盖）。 */
async function runMultiFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qz_aot_multi_"));
    fs.writeFileSync(path.join(dir, "mathx.ts"), "export function inc(x: number): number { return x + 1; }\n");
    // 别名 + 两层调用：bump(bump(x)) → x+2；且 main 自己不定义 inc
    fs.writeFileSync(path.join(dir, "mainx.ts"),
        "import { inc as bump } from './mathx';\n" +
        "export function run(x: number): number { return bump(bump(x)); }\n");
    const wasm = path.join(dir, "out.wasm");
    const r = compileTS(path.join(dir, "mainx.ts"), wasm, {});
    check("多文件.funcs=2(inc+run)", r.funcMeta.length, 2);
    check("多文件.导出名含目标模块函数", r.funcMeta.some(f => f.name === "inc"), true);

    const buf = fs.readFileSync(wasm);
    const { instance } = await WebAssembly.instantiate(buf, {});
    check("多文件.别名跨文件调用 run(40)", instance.exports.run(40), 42);
    // 无 tagged ⇒ 契约面应为空（内联后全自洽）
    check("多文件.import 面为空", WebAssembly.Module.imports(await WebAssembly.compile(buf)).length, 0);

    // 同名冲突：两模块都导出 dup → 必须显式报错，不静默覆盖
    fs.writeFileSync(path.join(dir, "a.ts"), "export function dup(x: number): number { return x + 1; }\n");
    fs.writeFileSync(path.join(dir, "b.ts"), "export function dup(x: number): number { return x + 100; }\n");
    fs.writeFileSync(path.join(dir, "m.ts"),
        "import { dup as dupA } from './a';\nimport { dup as dupB } from './b';\n" +
        "export function m(): number { return dupA(1); }\n");
    let threw = "";
    try { compileTS(path.join(dir, "m.ts"), path.join(dir, "m.wasm"), {}); }
    catch (e) { threw = e.message; }
    check("多文件.同名冲突显式报错", threw.includes("顶层函数名冲突"), true);

    // re-export 链：export { foo as bar } from "./bar" + import { bar } from "./a"
    // checker 须穿透 re-export 链解析 bar → foo（否则 _fnName 找不到函数）
    fs.writeFileSync(path.join(dir, "orig.ts"), "export function foo(x: number): number { return x * 10; }\n");
    fs.writeFileSync(path.join(dir, "relay.ts"), "export { foo as bar } from './orig';\n");
    fs.writeFileSync(path.join(dir, "use.rs.ts"),
        "import { bar } from './relay';\nexport function runRs(x: number): number { return bar(x); }\n");
    const wasmRs = path.join(dir, "rs.wasm");
    compileTS(path.join(dir, "use.rs.ts"), wasmRs, {});
    const bufRs = fs.readFileSync(wasmRs);
    const { instance: instRs } = await WebAssembly.instantiate(bufRs, {});
    check("re-export.别名穿透 runRs(5)", instRs.exports.runRs(5), 50);

    // 同名 re-export（无别名）：export { foo } from "./orig" → import { foo } from "./relay"
    fs.writeFileSync(path.join(dir, "relay2.ts"), "export { foo } from './orig';\n");
    fs.writeFileSync(path.join(dir, "use2.ts"),
        "import { foo } from './relay2';\nexport function runRs2(x: number): number { return foo(x); }\n");
    const wasmRs2 = path.join(dir, "rs2.wasm");
    compileTS(path.join(dir, "use2.ts"), wasmRs2, {});
    const bufRs2 = fs.readFileSync(wasmRs2);
    const { instance: instRs2 } = await WebAssembly.instantiate(bufRs2, {});
    check("re-export.同名穿透 runRs2(7)", instRs2.exports.runRs2(7), 70);

    // 外部模块 re-export → 显式报错（不静默丢绑定）
    fs.writeFileSync(path.join(dir, "ext.ts"),
        "export { pi } from 'mathlib';\nexport function runExt(): number { return pi; }\n");
    let extErr = "";
    try { compileTS(path.join(dir, "ext.ts"), path.join(dir, "ext.wasm"), {}); }
    catch (e) { extErr = e.message; }
    check("re-export.外部模块显式报错", extErr.includes("外部模块"), true);

    // 默认导入：`import d from './m'`（d 为目标模块命名默认导出）
    fs.writeFileSync(path.join(dir, "dm.ts"), "function df(n: number): number { return n + 100; }\nexport default df;\n");
    fs.writeFileSync(path.join(dir, "usedef.ts"),
        "import df from './dm';\nexport function runDef(x: number): number { return df(x); }\n");
    const wasmDef = path.join(dir, "def.wasm");
    compileTS(path.join(dir, "usedef.ts"), wasmDef, {});
    const { instance: instDef } = await WebAssembly.instantiate(fs.readFileSync(wasmDef), {});
    check("默认导入.runDef(5)", instDef.exports.runDef(5), 105);

    // 默认 + 具名混合导入
    fs.writeFileSync(path.join(dir, "dm2.ts"),
        "function d2(n: number): number { return n + 10; }\nexport default d2;\nexport function inc(n: number): number { return n + 1; }\n");
    fs.writeFileSync(path.join(dir, "usemix.ts"),
        "import d2, { inc } from './dm2';\nexport function runMix(x: number): number { return d2(inc(x)); }\n");
    const wasmMix = path.join(dir, "mix.wasm");
    compileTS(path.join(dir, "usemix.ts"), wasmMix, {});
    const { instance: instMix } = await WebAssembly.instantiate(fs.readFileSync(wasmMix), {});
    check("混合导入.runMix(5)", instMix.exports.runMix(5), 16);

    // 命名空间导入：`import * as M from './m'` → M.foo(...) 解析为目标顶层函数
    fs.writeFileSync(path.join(dir, "nsm.ts"),
        "export function f(x: number): number { const s = 'ab'; return x * 3 + s.length - 2; }\n" +
        "export function g(x: number): number { const s = 'ab'; return x + 1 + s.length - 2; }\n");
    fs.writeFileSync(path.join(dir, "usens.ts"),
        "import * as M from './nsm';\nexport function runNs(x: number): number { return M.f(M.g(x)); }\n");
    const wasmNs = path.join(dir, "ns.wasm");
    const rNs = compileTS(path.join(dir, "usens.ts"), wasmNs, {});
    const qzNs = makeQzvm(rNs.strings, { fields: rNs.fields });
    const { instance: instNs } = await WebAssembly.instantiate(fs.readFileSync(wasmNs), { qz: qzNs });
    qzNs.bindMem(instNs.exports.memory);
    if (instNs.exports.__bump) qzNs.bindBump(instNs.exports.__bump);
    check("命名空间导入.runNs(5)", qzNs._toJS(instNs.exports.runNs(qzNs._fromJS(5))), 18);

    // 命名空间导入 default 成员：`M.default(...)`
    fs.writeFileSync(path.join(dir, "nsd2.ts"),
        "function nd(n: number): number { const s = 'ab'; return n + 7 + s.length - 2; }\nexport default nd;\n");
    fs.writeFileSync(path.join(dir, "usensd.ts"),
        "import * as D from './nsd2';\nexport function runNsd(x: number): number { return D.default(x); }\n");
    const wasmNsd = path.join(dir, "nsd.wasm");
    const rNsd = compileTS(path.join(dir, "usensd.ts"), wasmNsd, {});
    const qzNsd = makeQzvm(rNsd.strings, { fields: rNsd.fields });
    const { instance: instNsd } = await WebAssembly.instantiate(fs.readFileSync(wasmNsd), { qz: qzNsd });
    qzNsd.bindMem(instNsd.exports.memory);
    if (instNsd.exports.__bump) qzNsd.bindBump(instNsd.exports.__bump);
    check("命名空间.default.runNsd(5)", qzNsd._toJS(instNsd.exports.runNsd(qzNsd._fromJS(5))), 12);

    // 外部模块命名空间导入 → 显式报错
    fs.writeFileSync(path.join(dir, "useEXT.ts"),
        "import * as E from 'mathlib';\nexport function runE(): number { return E.pi; }\n");
    let nsErr = "";
    try { compileTS(path.join(dir, "useEXT.ts"), path.join(dir, "ext2.wasm"), {}); }
    catch (e) { nsErr = e.message; }
    check("命名空间.外部模块显式报错", nsErr.includes("外部模块"), true);

    // 匿名默认导出 → 无法折回顶层名，显式报错
    fs.writeFileSync(path.join(dir, "anon.ts"), "export default function (n: number): number { return n; }\n");
    fs.writeFileSync(path.join(dir, "useanon.ts"),
        "import a from './anon';\nexport function runA(x: number): number { return a(x); }\n");
    let anonErr = "";
    try { compileTS(path.join(dir, "useanon.ts"), path.join(dir, "anon.wasm"), {}); }
    catch (e) { anonErr = e.message; }
    check("匿名默认导出.显式报错", anonErr.includes("匿名默认导出"), true);

    // 导入类：`import { C } from './m'` + new C —— 多文件类签名只声明一次（不重复 declareFunc）
    fs.writeFileSync(path.join(dir, "cmod.ts"),
        "export class Pt { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } sum(): number { return this.x + this.y; } }\n");
    fs.writeFileSync(path.join(dir, "usec.ts"),
        "import { Pt } from './cmod';\nexport function runC(x: number): number { const p = new Pt(x, 4); return p.sum(); }\n");
    const wasmC = path.join(dir, "c.wasm");
    const rc = compileTS(path.join(dir, "usec.ts"), wasmC, {});
    const qzc = makeQzvm(rc.strings, { fields: rc.fields });
    const { instance: instC } = await WebAssembly.instantiate(fs.readFileSync(wasmC), { qz: qzc });
    qzc.bindMem(instC.exports.memory);
    if (instC.exports.__bump) qzc.bindBump(instC.exports.__bump);
    qzc.bindClasses(instC.exports, rc.classMeta);
    const resC = instC.exports.runC(qzc._fromJS(5));
    check("导入类.runC(5)", qzc._toJS(resC), 9);

    // 跨模式调用 ABI：tagged 调用者 ↔ num 被调（同一 wasm 模块内）。
    // num 值 = f64，tagged 值 = i64 NaN-box（数值侧 = 原始 f64 位型）→ 边界按位重解释（精确无损）。
    // 回归守：此前 tagged→num / num→tagged 直调均产非法 wasm（call 参数类型不符），实例化即崩。
    // (1) tagged 调 num（含字符串使 caller 走 tagged）
    fs.writeFileSync(path.join(dir, "xnum.ts"),
        "function pure(a: number, b: number): number { return a + b; }\n" +
        "export function callNumTagged(x: number): number { const s = 'x'; return pure(x, 1) + s.length - 1; }\n");
    const wasmXT = path.join(dir, "xt.wasm");
    const rXT = compileTS(path.join(dir, "xnum.ts"), wasmXT, {});
    const qzXT = makeQzvm(rXT.strings, { fields: rXT.fields });
    const { instance: iXT } = await WebAssembly.instantiate(fs.readFileSync(wasmXT), { qz: qzXT });
    qzXT.bindMem(iXT.exports.memory);
    if (iXT.exports.__bump) qzXT.bindBump(iXT.exports.__bump);
    if (iXT.exports.__bump_reset) iXT.exports.__bump_reset();
    check("跨模式.tagged调num(5)", qzXT._toJS(iXT.exports.callNumTagged(qzXT._fromJS(5))), 6);

    // (2) num 调 tagged
    fs.writeFileSync(path.join(dir, "xtag.ts"),
        "function th(a: number, b: number): number { const s = 'y'; return a + b + s.length - 1; }\n" +
        "export function callTaggedNum(x: number): number { return th(x, 1); }\n");
    const wasmTN = path.join(dir, "tn.wasm");
    const rTN = compileTS(path.join(dir, "xtag.ts"), wasmTN, {});
    const qzTN = makeQzvm(rTN.strings, { fields: rTN.fields });
    const { instance: iTN } = await WebAssembly.instantiate(fs.readFileSync(wasmTN), { qz: qzTN });
    check("跨模式.num调tagged(5)", iTN.exports.callTaggedNum(5), 6);
}

/* interp 回退（opts.interp）：列出的函数不进 wasm，改由 glue 内联的 JS 跑。
 * 守「wasm 里无该函数 + 调用者被传递闭包带下来 + 可执行」。 */
async function runInterp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qz_aot_interp_"));
    const src = path.join(dir, "i.ts");
    fs.writeFileSync(src,
        "function heavy(n: number): number { let s = 0; for (let i = 0; i < n; i++) s = s + i; return s; }\n" +
        "export function caller(n: number): number { return heavy(n); }\n" +
        "export function pureNum(x: number): number { return x * 3; }\n");
    const wasm = path.join(dir, "i.wasm");
    const r = compileTS(src, wasm, { interp: ["heavy"] });
    const mode = (n) => (r.funcMeta.find(f => f.name === n) || {}).mode;
    check("interp.heavy 标记为 interp", mode("heavy"), "interp");
    check("interp.调用者传递闭包 → interp", mode("caller"), "interp");
    check("interp.无关函数仍 num", mode("pureNum"), "num");
    // 产物里不该有 interp 函数（wasm 导出表）
    const exp = WebAssembly.Module.exports(await WebAssembly.compile(fs.readFileSync(wasm))).map(e => e.name);
    check("interp.wasm 不含 heavy", exp.includes("heavy"), false);
    check("interp.wasm 含 pureNum", exp.includes("pureNum"), true);
    // interp JS 已产出且去掉了模块语法（无 exports/require/import 残留）
    check("interp.产出去模块语法", /exports|require\(/.test(r.interpJs), false);
    check("interp.JS 含目标函数", /function heavy\s*\(/.test(r.interpJs), true);

    // interp 跨文件：默认/命名导入引用点须折回顶层名（无 mod_1.x / require / export default 残留），
    // 且产出 JS 可直接执行得正确值。同名具名导入也须折回（否则 tsc 模块 transform 残留 (0, mod_1.x)）。
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "qz_aot_interp2_"));
    fs.writeFileSync(path.join(dir2, "lib.ts"),
        "export function add(a: number, b: number): number { const s = 'x'; return a + b + s.length - 1; }\n" +
        "function base(n: number): number { const s = 'y'; return n + 100 + s.length - 1; }\n" +
        "export default base;\n");
    const ie = path.join(dir2, "ie.ts");
    fs.writeFileSync(ie,
        "import base, { add } from './lib';\n" +
        "export function run(x: number): number { return base(add(x, 1)); }\n" +
        "export function r2(x: number): number { return add(x, 2); }\n");
    const ri = compileTS(ie, path.join(dir2, "ie.wasm"), { interp: ["run", "r2"] });
    check("interp.多文件去模块语法", /exports|require\(|export default|= require/.test(ri.interpJs), false);
    check("interp.多文件无模块对象残留", /lib_1\.|modd_1\./.test(ri.interpJs), false);
    const fnRun = new Function(ri.interpJs + "\nreturn run;")();
    check("interp.多文件执行 run(5)", fnRun(5), 106);
    const fnR2 = new Function(ri.interpJs + "\nreturn r2;")();
    check("interp.多文件同名导入执行 r2(5)", fnR2(5), 7);
}


// 语义回归（差分审计扫出的静默错值/非法产物 → 固化为快速门）：
// try/finally 穿透、对象字面量访问器/方法、展开别名、for-of 字符串、解构赋值、位运算守卫栈平衡、new 实参槽。
async function runSemantics() {
    const src = path.join(os.tmpdir(), "qz_aot_sem.ts");
    fs.writeFileSync(src,
        "export function finRet(): any { const o: any = []; function g(x: any) { try { if (x) return \"ret\"; o.push(\"no\"); return \"end\"; } finally { o.push(\"F\"); } } o.push(g(1)); o.push(g(0)); return o.join(\"|\"); }\n"
      + "export function finThrow(): any { const o: any = []; try { try { throw \"s1\"; } catch (e: any) { o.push(\"in:\" + e); throw \"s2\"; } finally { o.push(\"f1\"); } } catch (e: any) { o.push(\"out:\" + e); } return o.join(\"|\"); }\n"
      + "export function litAccessor(): any { const o: any = { n: 5, get v() { return this.n * 2; }, set v(x: any) { this.n = x + 1; }, inc() { this.n = this.n + 1; return this.n; } }; const out: any = []; out.push(o.v); o.v = 10; out.push(o.n); out.push(o.v); out.push(o.inc()); out.push(typeof o.inc); return out.join(\"|\"); }\n"
      + "export function spreadAlias(): any { const a: any = { y: { z: 2 }, x: 1 }; const b: any = { ...a, w: 3 }; b.y.z = 9; return a.y.z + \"|\" + b.w + \"|\" + b.x; }\n"
      + "export function forOfStr(): any { let s = \"\"; for (const ch of \"abc\") s += ch + \".\"; return s; }\n"
      + "export function destrAssign(): any { let a = 1, b = 2; [a, b] = [b, a]; let x = 0, y = 0; ({ m: x, n: y } = { m: 7, n: 8 }); return a + \"|\" + b + \"|\" + x + \"|\" + y; }\n"
      + "export function bitMixed(): any { const out: any = []; out.push((3.9 | 0) + (2.1 & 3)); out.push(NaN | 0); out.push(1e9 * 1e9 | 0); out.push(\"12\" | 0); return out.join(\"|\"); }\n"
      + "export function nestedNew(): any { class P { name: any = \"a\"; } class Q { tag(p: any) { return \"q:\" + p.name; } } const q = new Q(); return q.tag(new P()); }\n"
      + "class KBase { v: any = 1; }\n"
      + "class KDer extends KBase { w: any = 2; }\n"
      + "export function instOf(): any { const d = new KDer(); const out: any = []; out.push(d instanceof KDer ? 1 : 0); out.push(d instanceof KBase ? 1 : 0); out.push(d instanceof Object ? 1 : 0); out.push(d instanceof Array ? 1 : 0); out.push(\"s\" instanceof String ? 1 : 0); out.push([1] instanceof Array ? 1 : 0); out.push(1 instanceof Number ? 1 : 0); return out.join(\"|\"); }\n"
      + "export function arrOOB(): any { const a: any = [1,2]; const out: any = []; out.push(a[5] === undefined ? 1 : 0); a[4] = 9; out.push(a.length); out.push(a[4]); return out.join(\"|\"); }\n");
    const wasm = path.join(os.tmpdir(), "qz_aot_sem.wasm");
    const r = compileTS(src, wasm, {});
    const qz = makeQzvm(r.strings, { fields: r.fields });
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
    qz.bindMem(instance.exports.memory); if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
    qz.bindClosures(instance.exports, r.lamMeta); qz.bindClasses(instance.exports, r.classMeta);
    const call = (n) => { if (instance.exports.__bump_reset) instance.exports.__bump_reset(); return qz._toJS(instance.exports[n]()); };
    check("finally.return 穿透", call("finRet"), "F|ret|no|F|end");
    check("finally.throw 穿透", call("finThrow"), "in:s1|f1|out:s2");
    check("字面量.访问器+方法", call("litAccessor"), "10|11|22|12|function");
    check("展开.别名共享", call("spreadAlias"), "9|3|1");
    check("for-of.字符串", call("forOfStr"), "a.b.c.");
    check("解构.赋值", call("destrAssign"), "2|1|7|8");
    check("位运算.混合表达式", call("bitMixed"), "5|0|-1486618624|12");
    check("new.嵌套实参槽", call("nestedNew"), "q:a");
    check("数组.越界读/写扩容", call("arrOOB"), "1|5|9");
    check("instanceof.实例tag+内建", call("instOf"), "1|1|1|0|0|1|0");   // 原始值 instanceof String/Number = false
}

(async () => {
    await runNum();
    await runTagged();
    await runClasses();
    await runMultiFile();
    await runInterp();
    await runSemantics();
    await runDwarf();
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
