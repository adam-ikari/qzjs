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
// 常量除数取模的语义边界：负数/小数/NaN/Inf/-0/溢出/除零（守 math_rem 宿主慢路径）
function modConst(a: number): number { return a % 3; }
function modConstTiny(a: number): number { return a % 1e-308; }
function modConstZero(a: number): number { return a % 0; }
function nested(a: number, b: number, c: number): number { return a % (b % c); }
function neg(a: number): number { return -a; }
function cmp(a: number, b: number): number { if (a < b) return 1; return 0; }
function cmp2(a: number, b: number): number { if (a > b && b > 0) return 1; return 0; }
function nott(a: number): number { if (!a) return 7; return 1; }
function inc(n: number): number { let x = n; x++; return x; }
function postfix_ret(n: number): number { let x = n; let y = x++; return x * 10 + y; }
function wsum(n: number): number { let s = 0; let i = 0; while (i < n) { s += i; i++; } return s; }
function flo(a: number): number { return Math.floor(a); }
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
    const stub = new Proxy({}, { get: (_, k) => k === "math_pow" ? Math.pow : k === "math_rem" ? ((a, b) => a % b) : (..._a) => 0 });
    const { instance } = await WebAssembly.instantiate(bytes, { qz: stub, env: stub });
    const e = instance.exports;
    check("big(5)", e.big(5), 5e9);
    check("div(7,2)", e.div(7, 2), 3.5);
    check("mod(7,3)", e.mod(7, 3), 1);
    check("mod(-7,3)", e.mod(-7, 3), -1);
    check("mod(7.5,2)", e.mod(7.5, 2), 1.5);
    // 取模语义边界须与 JS 逐点一致；变量除数 Infinity 走 |b|==Inf 分支，常量除数走通用路径
    check("mod(7,Inf)", e.mod(7, Infinity), 7);
    check("mod(7,-Inf)", e.mod(7, -Infinity), 7);
    check("modConst(7,3)", e.modConst(7), 1);
    check("modConst(-7,3)", e.modConst(-7), -1);
    check("modConst(7.5,3)", e.modConst(7.5), 1.5);
    check("modConst(-0,3) = -0", Object.is(e.modConst(-0), -0), true);
    check("modConst(NaN,3) = NaN", isNaN(e.modConst(NaN)), true);
    check("modConst(Inf,3) = NaN", isNaN(e.modConst(Infinity)), true);
    check("modConstTiny(1e308) 相对误差", e.modConstTiny(1e308) / (1e308 % 1e-308), 1);
    check("modConstZero(5) = NaN", isNaN(e.modConstZero(5)), true);
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
      + "export function tmv(): any { class C { m(): number { return 7; } } const o: any = new C(); return typeof o.m; }\n"
      + "export function ideq(): any { const o: any = { a: 1 }; return o === o; }\n"
      + "export function mkeq(): any { return ({ a: 1 } as any) === ({ a: 1 } as any); }\n"
      + "export function inClass(): any { class L { v: number = 5; get(): number { return this.v; } } return new L().get(); }\n"
      + "export function inFn(): any { function h(n: number): number { return n * 3; } return h(4); }\n"
      + "export function clsFactory(): any { function mk(n: number) { return class { x: any = n; m() { let n = 5; n = n + 1; return n; } o() { return this.x + n; } }; } const C = mk(7); const c: any = new C(); return String(c.m()) + \",\" + String(c.o()); }\n"
      + "export function objMethodScope(): any { function mk(n: number) { const o = { m() { let n = 5; return n; } }; return o.m() + n; } return mk(7); }\n"
      + "export function typeAnnClosure(): any { interface Sh { a: number; } const f = (x: number): number => { const p: Sh = { a: x }; return p.a; }; return f(9); }\n");
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
    check("typeof 提取方法值", callMs("tmv"), "function");
    check("函数内 class 声明", callMs("inClass"), 5);
    check("函数内 function 声明", callMs("inFn"), 12);
    check("工厂类捕获（字段/方法/同名 let 遮蔽）", callMs("clsFactory"), "6,14");
    check("对象方法内 let 不顶外层参数槽", callMs("objMethodScope"), 12);
    check("类型注解名不作闭包捕获", callMs("typeAnnClosure"), 9);
    {   // 函数内 class 声明：每求值物化为独立 clone（可捕获外层局部）
        const p = path.join(os.tmpdir(), "qz_aot_nestedcap.ts");
        fs.writeFileSync(p, "function mk(n: number) { class K { m() { return n; } } return new K().m(); }\nexport function run() { return mk(7); }\n");
        const rNC = compileTS(p, path.join(os.tmpdir(), "qz_aot_nestedcap.wasm"), {});
        const qzNC = makeQzvm(rNC.strings, { fields: rNC.fields });
        const { instance: iNC } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_nestedcap.wasm")), { qz: qzNC });
        qzNC.bindMem(iNC.exports.memory); if (iNC.exports.__bump) qzNC.bindBump(iNC.exports.__bump);
        qzNC.bindClosures(iNC.exports, rNC.lamMeta); qzNC.bindClasses(iNC.exports, rNC.classMeta);
        check("函数内 class 捕获外层局部(每求值 clone)", qzNC._toJS(iNC.exports.run()), 7);
    }
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
    // 类表达式（工厂）静态成员：每次求值克隆独立静态桶（创建点按 clone 跑初始化）
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_facstatic.ts"),
            "function mk() { return class { static x = 5; static y: any; static { this.y = 9; }\n"
          + "  static m(): any { return this.x; } static bump(): any { this.x++; return this.x; } }; }\n"
          + "export function fac(): any { const A = mk(); const B = mk(); (A as any).bump(); (A as any).bump();\n"
          + "  return (A as any).x + \":\" + (B as any).x + \":\" + (A as any).y + \":\" + (A as any).m(); }\n");
        const rF = compileTS(path.join(os.tmpdir(), "qz_aot_facstatic.ts"), path.join(os.tmpdir(), "qz_aot_facstatic.wasm"), {});
        const qzF = makeQzvm(rF.strings, { fields: rF.fields });
        const { instance: iF } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_facstatic.wasm")), { qz: qzF });
        qzF.bindMem(iF.exports.memory); if (iF.exports.__bump) qzF.bindBump(iF.exports.__bump);
        qzF.bindClosures(iF.exports, rF.lamMeta); qzF.bindClasses(iF.exports, rF.classMeta);
        check("工厂类表达式.静态字段隔离+块+方法this", qzF._toJS(iF.exports.fac()), "7:5:9:7");
    }
    // 动态父类（工厂形参）下 super.<prop> 读/写：读→数据字段不在原型上=undefined；写→JS [[Set]] 在接收者上建自有字段
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_dynp.ts"),
            "function mk(B: any) { return class extends B { m(): any { return super.v; } w(): any { super.v = 2; } }; }\n"
          + "class A { v: number = 7; }\n"
          + "const C = mk(A); export function dpr(): any { const c: any = new C(); return c.m() + \":\" + (c as any).v; }\n"
          + "export function dps(): any { const c: any = new C(); c.w(); return (c as any).v; }\n");
        const rD = compileTS(path.join(os.tmpdir(), "qz_aot_dynp.ts"), path.join(os.tmpdir(), "qz_aot_dynp.wasm"), {});
        const qzD = makeQzvm(rD.strings, { fields: rD.fields });
        const { instance: iD } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_dynp.wasm")), { qz: qzD });
        qzD.bindMem(iD.exports.memory); if (iD.exports.__bump) qzD.bindBump(iD.exports.__bump);
        qzD.bindClosures(iD.exports, rD.lamMeta); qzD.bindClasses(iD.exports, rD.classMeta);
        check("动态父 super.v 读(数据字段不在原型上=undefined)+实例字段仍 7", qzD._toJS(iD.exports.dpr()), "undefined:7");
        check("动态父 super.v 写(JS [[Set]] → 实例自有字段=2)", qzD._toJS(iD.exports.dps()), 2);
    }
    // 类方法 arguments 与 rest/>4 形参混用：__args 全量实参数组独立于形式参槽（strict 无别名）
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_margs.ts"),
            "class C { m(a: number, ...r: number[]): number { return arguments.length + (r.length === 1 ? 100 : 0); }\n"
          + "  n(a: number, b: number, c: number, d: number, e: number): number { return arguments.length + arguments[4]; } }\n"
          + "export function ar1(): any { return new C().m(1, 2); }\n"
          + "export function ar2(): any { return new C().n(1, 2, 3, 4, 5); }\n");
        const rA = compileTS(path.join(os.tmpdir(), "qz_aot_margs.ts"), path.join(os.tmpdir(), "qz_aot_margs.wasm"), {});
        const qzA = makeQzvm(rA.strings, { fields: rA.fields });
        const { instance: iA } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_margs.wasm")), { qz: qzA });
        qzA.bindMem(iA.exports.memory); if (iA.exports.__bump) qzA.bindBump(iA.exports.__bump);
        qzA.bindClosures(iA.exports, rA.lamMeta); qzA.bindClasses(iA.exports, rA.classMeta);
        check("类方法 arguments+rest(arguments.length=2,rest=[2])", qzA._toJS(iA.exports.ar1()), 102);
        check("类方法 arguments+>4形参(length=5,[4]=5)", qzA._toJS(iA.exports.ar2()), 10);
    }
    // 动态派发/void 方法下类方法 arguments：调用点写 __args（method_call 宿主不知实参个数）
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_dynargs.ts"),
            "class C { k: number = 0; m(a: number): void { this.k = arguments.length; } }\n"
          + "function h(o: any): any { return o.m(3); }\n"
          + "export function dv(): any { const c = new C(); c.m(1); return c.k; }\n"
          + "export function dd(): any { class D { m(a: number): any { return arguments[0]; } } return h(new D()); }\n"
          + "export function dc(): any { class E { k: number; constructor(a: number) { this.k = arguments.length; } } return new E(1).k; }\n"
          + "class F { m(a: number): any { return arguments[0]; } }\n"
          + "export function de(): any { const f: any = new F(); const g = f.m; return g(3); }\n"
          + "export function ds(): any { const r = [3]; return new F().m(...r); }\n"
          + "class G { get p(): number { return arguments.length; } }\n"
          + "export function dg(): any { return new G().p; }\n");
        const rG = compileTS(path.join(os.tmpdir(), "qz_aot_dynargs.ts"), path.join(os.tmpdir(), "qz_aot_dynargs.wasm"), {});
        const qzG = makeQzvm(rG.strings, { fields: rG.fields });
        const { instance: iG } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_dynargs.wasm")), { qz: qzG });
        qzG.bindMem(iG.exports.memory); if (iG.exports.__bump) qzG.bindBump(iG.exports.__bump);
        qzG.bindClosures(iG.exports, rG.lamMeta); qzG.bindClasses(iG.exports, rG.classMeta);
        check("void 方法 arguments.length(动态派发)", qzG._toJS(iG.exports.dv()), 1);
        check("动态派发 arguments[0]", qzG._toJS(iG.exports.dd()), 3);
        check("ctor arguments.length", qzG._toJS(iG.exports.dc()), 1);
        check("提取方法作值 arguments[0]", qzG._toJS(iG.exports.de()), 3);
        check("展开实参调用 arguments[0]", qzG._toJS(iG.exports.ds()), 3);
        check("getter arguments.length(=0)", qzG._toJS(iG.exports.dg()), 0);
    }
    // 类表达式静态字段初值捕获工厂局部：sei 在创建点跑（env 可见）→ 每 clone 各持初值
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_facap.ts"),
            "function mk(n: number) { return class { static x = n; static y = n * 2; }; }\n"
          + "export function fcap(): any { const A = mk(5); const B = mk(9); return (A as any).x + \":\" + (A as any).y + \":\" + (B as any).x; }\n");
        const rH = compileTS(path.join(os.tmpdir(), "qz_aot_facap.ts"), path.join(os.tmpdir(), "qz_aot_facap.wasm"), {});
        const qzH = makeQzvm(rH.strings, { fields: rH.fields });
        const { instance: iH } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_facap.wasm")), { qz: qzH });
        qzH.bindMem(iH.exports.memory); if (iH.exports.__bump) qzH.bindBump(iH.exports.__bump);
        qzH.bindClosures(iH.exports, rH.lamMeta); qzH.bindClasses(iH.exports, rH.classMeta);
        check("工厂类静态字段捕获局部(每 clone 独立)", qzH._toJS(iH.exports.fcap()), "5:10:9");
    }
    // super.m 作值：父方法物化为可调用值（未绑定 this；typeof 'function'）
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_superm.ts"),
            "class A { m(): number { return 1; } }\n"
          + "class B extends A { f(): any { const g: any = super.m; return typeof g + \":\" + g(); } }\n"
          + "export function smv(): any { return new B().f(); }\n");
        const rS = compileTS(path.join(os.tmpdir(), "qz_aot_superm.ts"), path.join(os.tmpdir(), "qz_aot_superm.wasm"), {});
        const qzS = makeQzvm(rS.strings, { fields: rS.fields });
        const { instance: iS } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_superm.wasm")), { qz: qzS });
        qzS.bindMem(iS.exports.memory); if (iS.exports.__bump) qzS.bindBump(iS.exports.__bump);
        qzS.bindClosures(iS.exports, rS.lamMeta); qzS.bindClasses(iS.exports, rS.classMeta);
        check("super.m 作值(typeof function + 调用)", qzS._toJS(iS.exports.smv()), "function:1");
    }
    // num 展开缺参：f64 ABI 无 undefined → 缺参填 NaN（undefined 参与算术的 JS 结果）
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_numsp.ts"),
            "function f(a: number, b: number): number { return a * 10 + b; }\n"
          + "export function nsm(): any { return f(...[1]); }\n");
        const rN = compileTS(path.join(os.tmpdir(), "qz_aot_numsp.ts"), path.join(os.tmpdir(), "qz_aot_numsp.wasm"), {});
        const qzN = makeQzvm(rN.strings, { fields: rN.fields });
        const { instance: iN } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_numsp.wasm")), { qz: qzN });
        qzN.bindMem(iN.exports.memory); if (iN.exports.__bump) qzN.bindBump(iN.exports.__bump);
        qzN.bindClosures(iN.exports, rN.lamMeta); qzN.bindClasses(iN.exports, rN.classMeta);
        check("num 展开缺参=NaN", qzN._toJS(iN.exports.nsm()), NaN);
    }
    // 类计算属性名方法：运行期名创建点注册到 clone 自有 methods（多 clone 各持）
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_cm.ts"),
            "function mk(name: string, n: number) { return class { [name](): any { return n; } }; }\n"
          + "const A = mk(\"go\", 4); const B = mk(\"run\", 9);\n"
          + "export function cm(): any { return new (A as any)().go() + \":\" + new (B as any)().run(); }\n");
        const rC = compileTS(path.join(os.tmpdir(), "qz_aot_cm.ts"), path.join(os.tmpdir(), "qz_aot_cm.wasm"), {});
        const qzC = makeQzvm(rC.strings, { fields: rC.fields });
        const { instance: iC } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_cm.wasm")), { qz: qzC });
        qzC.bindMem(iC.exports.memory); if (iC.exports.__bump) qzC.bindBump(iC.exports.__bump);
        qzC.bindClosures(iC.exports, rC.lamMeta); qzC.bindClasses(iC.exports, rC.classMeta);
        check("类计算属性名方法(多 clone 各异)", qzC._toJS(iC.exports.cm()), "4:9");
    }
    // 0 参导出函数由宿主直调：__args 未设 → arguments=[]（非 trap）
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_hostargs.ts"), "export function ha(): any { return arguments.length; }\n");
        const rH = compileTS(path.join(os.tmpdir(), "qz_aot_hostargs.ts"), path.join(os.tmpdir(), "qz_aot_hostargs.wasm"), {});
        const qzH = makeQzvm(rH.strings, { fields: rH.fields });
        const { instance: iH } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_hostargs.wasm")), { qz: qzH });
        qzH.bindMem(iH.exports.memory); if (iH.exports.__bump) qzH.bindBump(iH.exports.__bump);
        qzH.bindClosures(iH.exports, rH.lamMeta); qzH.bindClasses(iH.exports, rH.classMeta);
        check("0 参导出函数 arguments.length(=0)", qzH._toJS(iH.exports.ha()), 0);
    }
    // 类表达式静态块：纯 lambda 捕获工厂局部（创建点 sei env 可见）→ 支持；写外部 const（TDZ）→ loud
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_sblk.ts"),
            "function mk(n: number) { return class { static { const f = () => n; } m(): any { return n; } }; }\n"
          + "export function sblk(): any { const C = mk(7); return new (C as any)().m(); }\n");
        const rB = compileTS(path.join(os.tmpdir(), "qz_aot_sblk.ts"), path.join(os.tmpdir(), "qz_aot_sblk.wasm"), {});
        const qzB = makeQzvm(rB.strings, { fields: rB.fields });
        const { instance: iB } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_sblk.wasm")), { qz: qzB });
        qzB.bindMem(iB.exports.memory); if (iB.exports.__bump) qzB.bindBump(iB.exports.__bump);
        qzB.bindClosures(iB.exports, rB.lamMeta); qzB.bindClasses(iB.exports, rB.classMeta);
        check("静态块 lambda 捕获工厂局部", qzB._toJS(iB.exports.sblk()), 7);
        let msg = null;
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_sbw.ts"), "function mk(n: number) { return class { static x: number; static { C2.x = n; } }; }\nconst C2 = mk(7);\nexport function run() { return C2.x; }\n");
        try { compileTS(path.join(os.tmpdir(), "qz_aot_sbw.ts"), path.join(os.tmpdir(), "qz_aot_sbw.wasm"), {}); } catch (e) { msg = String(e.message || e); }
        check("静态块写外部 const loud(TDZ)", !!(msg && msg.indexOf("静态初始化捕获") >= 0), true);
    }
    // 顶层类 static 块/字段初值在**定义点** eager 执行（JS 语义）：new/静态访问都不需要，副作用即生效；
    // 且按源码序交错（类定义之后的模块级语句能读到块写入的值）。
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_eager.ts"),
            "let counter: number = 0;\n"
          + "class C { static { counter = 5; } }\n"
          + "export function eager(): any { return counter; }\n"           // 无 new/静态访问 → 5（定义点已跑）
          + "let seq: number = 0;\n"
          + "class D { static { seq = 1; } }\n"
          + "export const afterD: number = seq + 10;\n"                    // D 定义后读 → 11（交错顺序）
          + "export function seqv(): any { return afterD; }\n");
        const rE = compileTS(path.join(os.tmpdir(), "qz_aot_eager.ts"), path.join(os.tmpdir(), "qz_aot_eager.wasm"), {});
        const qzE = makeQzvm(rE.strings, { fields: rE.fields });
        const { instance: iE } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_eager.wasm")), { qz: qzE });
        qzE.bindMem(iE.exports.memory); if (iE.exports.__bump) qzE.bindBump(iE.exports.__bump);
        qzE.bindClosures(iE.exports, rE.lamMeta); qzE.bindClasses(iE.exports, rE.classMeta);
        check("静态块定义点 eager 执行(无 new/静态访问)", qzE._toJS(iE.exports.eager()), 5);
        check("静态块副作用按源码序交错生效", qzE._toJS(iE.exports.seqv()), 11);
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_eager2.ts"),
            "let c2: number = 0;\n"
          + "const A = class { static { c2 = 4; } };\n"                     // 顶层别名类表达式：定义点跑 static 块
          + "export function aliasEager(): any { return c2; }\n");
        const rE2 = compileTS(path.join(os.tmpdir(), "qz_aot_eager2.ts"), path.join(os.tmpdir(), "qz_aot_eager2.wasm"), {});
        const qzE2 = makeQzvm(rE2.strings, { fields: rE2.fields });
        const { instance: iE2 } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_eager2.wasm")), { qz: qzE2 });
        qzE2.bindMem(iE2.exports.memory); if (iE2.exports.__bump) qzE2.bindBump(iE2.exports.__bump);
        qzE2.bindClosures(iE2.exports, rE2.lamMeta); qzE2.bindClasses(iE2.exports, rE2.classMeta);
        check("顶层别名类表达式 static 块定义点执行", qzE2._toJS(iE2.exports.aliasEager()), 4);
    }
    // 构造器 rest 形参（constructor(...xs)）：rest 槽须收到 args 打包数组（此前收单个标量 → xs.length=undefined）。
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_ctorrest.ts"),
            "class CR { v: number; w: number; constructor(a: number, ...xs: number[]) { this.v = a; this.w = xs.length; } }\n"
          + "class CS { v: number; constructor(...xs: number[]) { this.v = xs.length + arguments.length; } }\n"
          + "export function ctorRest(): any { const c: any = new CR(99, 1, 2); return c.v * 100 + c.w; }\n"           // 9902
          + "export function ctorRestArgs(): any { return new (CS as any)(1, 2, 3).v; }\n"                          // 3+3=6
          + "class CT { v: number; constructor(...xs: number[]) { this.v = xs.length; } }\n"
          + "export function ctorRest5(): any { return new (CS as any)(1, 2, 3, 4, 5).v; }\n"                      // 5+5=10（rest 槽承载全部 >4 实参）
          + "export function ctorRestSpread(): any { const a = [1, 2, 3, 4, 5]; return new (CT as any)(...a).v; }\n" // 5（new C(...a) rest 从运行期数组 slice）
          + "class CU { v: number; constructor(...xs: number[]) { this.v = xs.length + arguments.length; } }\n"
          + "export function ctorSpreadArgs(): any { const a = [1, 2, 3]; return new (CU as any)(...a).v; }\n");  // 3+3=6（spreadArr 即 __args）
        const rR = compileTS(path.join(os.tmpdir(), "qz_aot_ctorrest.ts"), path.join(os.tmpdir(), "qz_aot_ctorrest.wasm"), {});
        const qzR = makeQzvm(rR.strings, { fields: rR.fields });
        const { instance: iR } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_ctorrest.wasm")), { qz: qzR });
        qzR.bindMem(iR.exports.memory); if (iR.exports.__bump) qzR.bindBump(iR.exports.__bump);
        qzR.bindClosures(iR.exports, rR.lamMeta); qzR.bindClasses(iR.exports, rR.classMeta);
        check("构造器 rest 形参(固定+rest)", qzR._toJS(iR.exports.ctorRest()), 9902);
        check("构造器 rest + arguments", qzR._toJS(iR.exports.ctorRestArgs()), 6);
        check("构造器 rest 承载 >4 实参", qzR._toJS(iR.exports.ctorRest5()), 10);
        check("构造器 rest 展开实参 new C(...a)", qzR._toJS(iR.exports.ctorRestSpread()), 5);
        check("构造器 spread + arguments", qzR._toJS(iR.exports.ctorSpreadArgs()), 6);
    }
    // 构造器 super(...arr)：运行期数组按父形参表拆到槽（rest 槽 slice，父用 arguments 时 __args=数组）。
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_superspread.ts"),
            "class SA { s: number; constructor(a: number, ...xs: number[]) { this.s = a + xs.length; } }\n"
          + "class SB extends SA { constructor(...ys: number[]) { super(...ys); } }\n"
          + "class SC { v: number; constructor(...xs: number[]) { this.v = arguments.length; } }\n"
          + "class SD extends SC { constructor(...ys: number[]) { super(...ys); } }\n"
          + "export function superSpreadMixed(): any { return new (SB as any)(10, 1, 2).s; }\n"   // 10+2=12
          + "export function superSpreadArgs(): any { return new (SD as any)(1, 2, 3).v; }\n"); // 3（父用 arguments）
        const rS = compileTS(path.join(os.tmpdir(), "qz_aot_superspread.ts"), path.join(os.tmpdir(), "qz_aot_superspread.wasm"), {});
        const qzS = makeQzvm(rS.strings, { fields: rS.fields });
        const { instance: iS } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_superspread.wasm")), { qz: qzS });
        qzS.bindMem(iS.exports.memory); if (iS.exports.__bump) qzS.bindBump(iS.exports.__bump);
        qzS.bindClosures(iS.exports, rS.lamMeta); qzS.bindClasses(iS.exports, rS.classMeta);
        check("super(...arr) 混合固定+rest", qzS._toJS(iS.exports.superSpreadMixed()), 12);
        check("super(...arr) 父用 arguments", qzS._toJS(iS.exports.superSpreadArgs()), 3);
    }
    // 提取方法 + rest 形参：bound function 须把 args[restIdx..] 打包进 rest 槽（此前收单个标量 → xs.length=undefined）。
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_extrest.ts"),
            "class EA { m(...xs: number[]): number { return xs.length; } n(a: number, ...xs: number[]): number { return a + xs.length; } }\n"
          + "class EB extends EA { f(): number { const g: any = super.m; return g(1, 2, 3); } }\n"
          + "export function extractedRest(): any { const o: any = new (EA as any)(); const g: any = o.m; return g(1, 2, 3); }\n"      // 3
          + "export function extractedFixedRest(): any { const o: any = new (EA as any)(); const g: any = o.n; return g(10, 1, 2); }\n"  // 12
          + "export function superExtractedRest(): any { return new (EB as any)().f(); }\n");                                          // 3
        const rX = compileTS(path.join(os.tmpdir(), "qz_aot_extrest.ts"), path.join(os.tmpdir(), "qz_aot_extrest.wasm"), {});
        const qzX = makeQzvm(rX.strings, { fields: rX.fields });
        const { instance: iX } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_extrest.wasm")), { qz: qzX });
        qzX.bindMem(iX.exports.memory); if (iX.exports.__bump) qzX.bindBump(iX.exports.__bump);
        qzX.bindClosures(iX.exports, rX.lamMeta); qzX.bindClasses(iX.exports, rX.classMeta);
        check("提取方法 rest 打包", qzX._toJS(iX.exports.extractedRest()), 3);
        check("提取方法 固定+rest", qzX._toJS(iX.exports.extractedFixedRest()), 12);
        check("super.m 提取 rest", qzX._toJS(iX.exports.superExtractedRest()), 3);
    }
    // 全 number 形状但带默认值的函数：须退 tagged（num f64 ABI 无 undefined），此前误选 num → 编译期 loud 拒绝。
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_numdflt.ts"),
            "function nd(a: number, b: number = a * 2): number { return a + b; }\n"
          + "function nr(a: number, ...xs: number[]): number { return a + xs.length; }\n"
          + "export function numDefault(): any { return nd(3); }\n"        // 9
          + "export function numRest(): any { return nr(5, 1, 2); }\n");   // 7
        const rN = compileTS(path.join(os.tmpdir(), "qz_aot_numdflt.ts"), path.join(os.tmpdir(), "qz_aot_numdflt.wasm"), {});
        const qzN = makeQzvm(rN.strings, { fields: rN.fields });
        const { instance: iN } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_numdflt.wasm")), { qz: qzN });
        qzN.bindMem(iN.exports.memory); if (iN.exports.__bump) qzN.bindBump(iN.exports.__bump);
        qzN.bindClosures(iN.exports, rN.lamMeta); qzN.bindClasses(iN.exports, rN.classMeta);
        check("num 形状默认参数退 tagged", qzN._toJS(iN.exports.numDefault()), 9);
        check("num 形状 rest 参数退 tagged", qzN._toJS(iN.exports.numRest()), 7);
    }
    // 全 number 形状但含 try/catch/finally：num 模式的 emitBlock 不支持 → 须退 tagged（此前误选 num → loud 拒绝合法代码）。
    {
        fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_numtry.ts"),
            "function nt(): number { let s = 0; try { s = 1; throw 0; } catch { s = s + 10; } finally { s = s + 100; } return s; }\n"
          + "export function numTry(): any { return nt(); }\n");   // 111
        const rT = compileTS(path.join(os.tmpdir(), "qz_aot_numtry.ts"), path.join(os.tmpdir(), "qz_aot_numtry.wasm"), {});
        const qzT = makeQzvm(rT.strings, { fields: rT.fields });
        const { instance: iT } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_numtry.wasm")), { qz: qzT });
        qzT.bindMem(iT.exports.memory); if (iT.exports.__bump) qzT.bindBump(iT.exports.__bump);
        qzT.bindClosures(iT.exports, rT.lamMeta); qzT.bindClasses(iT.exports, rT.classMeta);
        check("num 形状 try/catch 退 tagged", qzT._toJS(iT.exports.numTry()), 111);
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
    // num 函数作值（fn_value 第 4 参 = f64 ABI）：别名调用 + 作回调 + tagged 函数内引用 num 函数。
    // 守此前两崩：funcMode 不查 knownFns → num 路径按名发 `call h` 编译期「未定义变量」；
    // fn_value 不分模式 → f64 导出收到 tagged 位型「Cannot convert a BigInt to number」。
    fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_fnval.ts"),
        "export function inc(x: number): number { return x + 1; }\n"
      + "export function dbl(x: number): number { return x * 2; }\n"
      + "export function aliasCall(n: number): number { const h = inc; return h(n) + h(n + 10); }\n"
      + "export function viaCallback(arr: number[]): number { const r: any = arr.map(dbl); let s = 0; for (let i = 0; i < (r as any).length; i++) s = s + (r as any)[i]; return s; }\n"
      + "export function mixedTagged(n: number): any { const h = inc; return h(n); }\n");
    const rFv = compileTS(path.join(os.tmpdir(), "qz_aot_fnval.ts"), path.join(os.tmpdir(), "qz_aot_fnval.wasm"), {});
    const qzFv = makeQzvm(rFv.strings, { fields: rFv.fields });
    const { instance: instFv } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_fnval.wasm")), { qz: qzFv });
    qzFv.bindMem(instFv.exports.memory); if (instFv.exports.__bump) qzFv.bindBump(instFv.exports.__bump);
    qzFv.bindClosures(instFv.exports, rFv.lamMeta);
    const callFv = (n, a) => { if (instFv.exports.__bump_reset) instFv.exports.__bump_reset(); const m = rFv.funcMeta.find(f => f.name === n); const conv = m.mode === "num" ? a : a.map(x => qzFv._fromJS(x)); const res = instFv.exports[n](...conv); return m.mode === "num" ? res : qzFv._toJS(res); };
    check("fn值.别名调用(num)", callFv("aliasCall", [5]), 22);            // inc(5)+inc(15)=6+16
    check("fn值.作回调(num)", callFv("viaCallback", [[1, 2, 3]]), 12);    // map(dbl)=[2,4,6] sum
    check("fn值.tagged内引用num", callFv("mixedTagged", [9]), 10);       // inc(9)=10
    // 内建子类承载（class extends 内建）：宿主真内建实例 + 类 prototype；继承方法原生、自有方法走 wasm、instanceof 双路。
    // 守此前 `m.set` 报「类 N 无方法 set」（实例是 POJO 式 wasm 内存，非宿主 Map）。
    fs.writeFileSync(path.join(os.tmpdir(), "qz_aot_bsub.ts"),
        "export class M extends Map { tag(): string { return \"M\"; } has2(k: any): boolean { return this.has(k); } }\n"
      + "export function useM(): any { const m = new M(); m.set(\"a\", 1); m.set(\"b\", 2); return m.get(\"a\") + \":\" + m.size + \":\" + m.has2(\"b\") + \":\" + (m instanceof M) + \":\" + (m instanceof Map) + \":\" + m.tag(); }\n"
      + "export class S extends Set { tag(): string { return \"S\"; } }\n"
      + "export function useS(): any { const s = new S(); s.add(1); s.add(2); return s.size + \":\" + s.has(2) + \":\" + (s instanceof S) + \":\" + (s instanceof Set) + \":\" + s.tag(); }\n"
      + "export class D extends Date { label(): string { return \"D:\" + (this as any).getFullYear(); } }\n"
      + "export function useD(): any { const d = new D(2026, 0, 9); return d.getFullYear() + \":\" + (d instanceof D) + \":\" + (d instanceof Date) + \":\" + d.label(); }\n"
      + "export class A extends Array { tag(): string { return \"A\"; } first(): any { return this[0]; } }\n"
      + "export function useA(): any { const a = new A(); a.push(10); a.push(20); let s = 0; for (const v of a) s = s + (v as number); return a.length + \":\" + a[0] + \":\" + a.first() + \":\" + s + \":\" + (a instanceof A) + \":\" + (a instanceof Array) + \":\" + a.tag(); }\n"
      + "export class MF extends Map { x: number = 1; y: number = this.x + 1; }\n"
      + "export function useMF(): any { const m = new MF(); m.set(\"a\", 7); m.x = 100; return m.get(\"a\") + \":\" + m.x + \":\" + m.y + \":\" + m.size + \":\" + (m instanceof MF) + \":\" + (m instanceof Map); }\n"
      + "const K = 5;\n"
      + "export class AF extends Array { x: number = K * 2; sum(): number { let s = 0; for (let i = 0; i < this.length; i++) s += this[i]; return s; } }\n"
      + "export function useAF(): any { const a = new AF(); a.push(1); a.push(2); return a.sum() + \":\" + a.length + \":\" + a.x + \":\" + (a instanceof AF) + \":\" + (a instanceof Array); }\n"
      + "export class MS extends Map { addS(k: any, v: any): any { super.set(k, v); return super.get(k); } }\n"
      + "export function useMS(): any { const m = new MS(); return m.addS(\"a\", 5) + \":\" + m.size; }\n"
      + "export class OS extends Map { set(k: any, v: any): any { return super.set(k, (v as number) * 10); } }\n"
      + "export function useOS(): any { const o = new OS(); o.set(\"k\", 3); return o.get(\"k\") + \":\" + o.size; }\n"
      + "export class SM extends Map { static n = 0; bump(): number { (SM as any).n++; return (SM as any).n; } total(): number { let s = 0; for (const [, v] of this as any) s += v; return s; } }\n"
      + "export function useSM(): any { const a = new SM(); (a as any).set(\"x\", 1); a.bump(); a.bump(); return (SM as any).n + \":\" + a.size + \":\" + a.total(); }\n"
      + "export class AM extends Array { twice(): any { return (this as any).map((x: number) => x * 2); } }\n"
      + "export function useAM(): any { const a = new AM(); a.push(1); a.push(2); const t = a.twice(); return t.length + \":\" + t[0] + \":\" + t[1] + \":\" + (t instanceof Array) + \":\" + (t as any).join(\",\"); }\n");
    const rBs = compileTS(path.join(os.tmpdir(), "qz_aot_bsub.ts"), path.join(os.tmpdir(), "qz_aot_bsub.wasm"), {});
    const qzBs = makeQzvm(rBs.strings, { fields: rBs.fields });
    const { instance: instBs } = await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_bsub.wasm")), { qz: qzBs });
    qzBs.bindMem(instBs.exports.memory); if (instBs.exports.__bump) qzBs.bindBump(instBs.exports.__bump);
    qzBs.bindClosures(instBs.exports, rBs.lamMeta); qzBs.bindClasses(instBs.exports, rBs.classMeta);
    const callBs = (n) => { if (instBs.exports.__bump_reset) instBs.exports.__bump_reset(); return qzBs._toJS(instBs.exports[n]()); };
    check("内建子类.Map 继承+自有+instanceof", callBs("useM"), "1:2:true:true:true:M");
    check("内建子类.Set 继承+自有+instanceof", callBs("useS"), "2:true:true:true:S");
    check("内建子类.Date 继承+自有+instanceof", callBs("useD"), "2026:true:true:D:2026");
    check("内建子类.Array 继承+自有+for-of+instanceof", callBs("useA"), "2:10:10:30:true:true:A");   // Array 子类保留真数组 + 类 prototype（tagHandle 0x7FFD，不扁平为 0x7FFB）
    check("内建子类.Map 自有字段(this引用+写)", callBs("useMF"), "7:100:2:1:true:true");   // 字段存宿主属性（非 wasm 内存），基类构造由 new_builtin_sub 完成
    check("内建子类.Array 自有字段(捕获+自有方法)", callBs("useAF"), "3:2:10:true:true");
    check("内建子类.super.set/get（内建父方法）", callBs("useMS"), "5:1");
    check("内建子类.super.set（覆盖后越过覆写）", callBs("useOS"), "30:1");
    check("内建子类.静态字段+for-of 条目", callBs("useSM"), "2:1:1");   // 静态字段链遍历须在内建父类处停（此前 classes.get("Map").parent 崩）
    check("内建子类.Array map（species 结果可用）", callBs("useAM"), "2:2:4:true:2,4");   // classObjImpl.ctor 对宿主句柄返回真对象，引擎 species new A(len) 才得真数组
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

    // 同名导出：内联后共享一个 wasm 名字域，但两个文件的 `dup` 是不同函数
    // （zod 自身即如此：util.`nullish(any): boolean` 与 classic/schemas.`nullish(T): ZodOptional`）。
    // 契约：非入口文件的重名函数按文件前缀改名，各自调用解析到自己那份。
    fs.writeFileSync(path.join(dir, "a.ts"), "export function dup(x: number): number { return x + 1; }\n");
    fs.writeFileSync(path.join(dir, "b.ts"), "export function dup(x: number): number { return x + 100; }\n");
    fs.writeFileSync(path.join(dir, "m.ts"),
        "import { dup as dupA } from './a';\nimport { dup as dupB } from './b';\n" +
        "export function m(): number { return dupA(1); }\nexport function m2(): number { return dupB(1); }\n");
    const wasmDup = path.join(dir, "m.wasm");
    compileTS(path.join(dir, "m.ts"), wasmDup, {});
    const { instance: instDup } = await WebAssembly.instantiate(fs.readFileSync(wasmDup), {});
    check("多文件.同名导出各自解析 m()", instDup.exports.m(), 2);
    check("多文件.同名导出各自解析 m2()", instDup.exports.m2(), 101);

    // 同名私有函数：两模块各有一份非导出 helper → 自动按文件前缀改名，互不干扰。
    fs.writeFileSync(path.join(dir, "pa.ts"), "function helper(x: number): number { return x * 2; }\nexport function pa(y: number): number { return helper(y); }\n");
    fs.writeFileSync(path.join(dir, "pb.ts"), "function helper(x: number): number { return x + 100; }\nexport function pb(y: number): number { return helper(y); }\n");
    fs.writeFileSync(path.join(dir, "pm.ts"), "import { pa } from './pa';\nimport { pb } from './pb';\nexport function runPm(x: number): number { return pa(x) + pb(x); }\n");
    const wasmPm = path.join(dir, "pm.wasm");
    compileTS(path.join(dir, "pm.ts"), wasmPm, {});
    const { instance: instPm } = await WebAssembly.instantiate(fs.readFileSync(wasmPm), {});
    check("多文件.同名私有自动消解 runPm(3)", instPm.exports.runPm(3), 109);

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

    // `export * from './m'`：不产生绑定，内联后无代码可发；消费方经 checker 穿透 star 链解析。
    fs.writeFileSync(path.join(dir, "starbase.ts"),
        "export function sb(x: number): number { return x * 3; }\n");
    fs.writeFileSync(path.join(dir, "starmid.ts"), "export * from './starbase';\n");
    fs.writeFileSync(path.join(dir, "usestar.ts"),
        "import { sb } from './starmid';\nexport function runStar(x: number): number { return sb(x); }\n");
    const wasmStar = path.join(dir, "star.wasm");
    compileTS(path.join(dir, "usestar.ts"), wasmStar, {});
    const { instance: instStar } = await WebAssembly.instantiate(fs.readFileSync(wasmStar), {});
    check("export*.穿透 runStar(5)", instStar.exports.runStar(5), 15);

    // `export *` 指向外部模块 → 显式报错
    fs.writeFileSync(path.join(dir, "extstar.ts"), "export * from 'mathlib';\n");
    let extStarErr = "";
    try { compileTS(path.join(dir, "extstar.ts"), path.join(dir, "extstar.wasm"), {}); }
    catch (e) { extStarErr = e.message; }
    check("export*.外部模块显式报错", extStarErr.includes("外部模块"), true);

    // TS 重载签名（无实现体）不应与实现体同名冲突：只有带 body 的声明进 fns。
    fs.writeFileSync(path.join(dir, "ovl.ts"),
        "export function pick(a: string): string;\n" +
        "export function pick(a: number): number;\n" +
        "export function pick(a: any): any { return typeof a === 'string' ? a + '!' : a * 2; }\n" +
        "export function runOvl(x: number): any { return pick(x); }\n");
    const wasmOvl = path.join(dir, "ovl.wasm");
    const rOvl = compileTS(path.join(dir, "ovl.ts"), wasmOvl, {});
    const qzOvl = makeQzvm(rOvl.strings, { fields: rOvl.fields });
    const { instance: instOvl } = await WebAssembly.instantiate(fs.readFileSync(wasmOvl), { qz: qzOvl });
    qzOvl.bindMem(instOvl.exports.memory);
    if (instOvl.exports.__bump) qzOvl.bindBump(instOvl.exports.__bump);
    check("重载签名.不冲突 runOvl(21)", qzOvl._toJS(instOvl.exports.runOvl(qzOvl._fromJS(21))), 42);

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

    // `new ns.C(...)`：命名空间成员的类 → 构造（zod v4 大量 new checks.$ZodCheckXxx）
    fs.writeFileSync(path.join(dir, "nscls.ts"),
        "export class Box { v: number; constructor(n: number) { this.v = n * 2; } }\n");
    fs.writeFileSync(path.join(dir, "usenscls.ts"),
        "import * as K from './nscls';\nexport function runNc(n: number): number { const b = new K.Box(n); return b.v; }\n");
    const wasmNc = path.join(dir, "nscls.wasm");
    const rNc = compileTS(path.join(dir, "usenscls.ts"), wasmNc, {});
    const qzNc = makeQzvm(rNc.strings, { fields: rNc.fields });
    const { instance: instNc } = await WebAssembly.instantiate(fs.readFileSync(wasmNc), { qz: qzNc });
    qzNc.bindMem(instNc.exports.memory);
    if (instNc.exports.__bump) qzNc.bindBump(instNc.exports.__bump);
    check("new 命名空间类.runNc(5)", qzNc._toJS(instNc.exports.runNc(qzNc._fromJS(5))), 10);

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

    // 匿名默认导出：`export default function(){}` / `export default class{}` 无顶层名，
    // 由 compileTS 合成 `__default_N` 后正常内联（此前整条 import 链报错失败）。
    fs.writeFileSync(path.join(dir, "anon.ts"), "export default function (n: number): any { const s = 'ab'; return n * 2 + s.length - 2; }\n");
    fs.writeFileSync(path.join(dir, "useanon.ts"),
        "import a from './anon';\nexport function runA(x: number): any { return a(x); }\n");
    const wasmAnon = path.join(dir, "anon.wasm");
    const rAnon = compileTS(path.join(dir, "useanon.ts"), wasmAnon, {});
    const qzAnon = makeQzvm(rAnon.strings, { fields: rAnon.fields });
    const { instance: instAnon } = await WebAssembly.instantiate(fs.readFileSync(wasmAnon), { qz: qzAnon });
    qzAnon.bindMem(instAnon.exports.memory);
    if (instAnon.exports.__bump) qzAnon.bindBump(instAnon.exports.__bump);
    check("匿名默认导出.函数内联", qzAnon._toJS(instAnon.exports.runA(qzAnon._fromJS(21))), 42);

    // 匿名默认导出类：`export default class { ... }`
    fs.writeFileSync(path.join(dir, "anoncls.ts"),
        "export default class { x: number; tag: string; constructor(x: number) { this.x = x; this.tag = 'p'; } twice(): any { return this.x * 2 + this.tag.length - 1; } }\n");
    fs.writeFileSync(path.join(dir, "useanoncls.ts"),
        "import C from './anoncls';\nexport function runAC(): any { const c = new C(7); return c.twice(); }\n");
    const wasmAnonC = path.join(dir, "anoncls.wasm");
    const rAnonC = compileTS(path.join(dir, "useanoncls.ts"), wasmAnonC, {});
    const qzAnonC = makeQzvm(rAnonC.strings, { fields: rAnonC.fields });
    const { instance: instAnonC } = await WebAssembly.instantiate(fs.readFileSync(wasmAnonC), { qz: qzAnonC });
    qzAnonC.bindMem(instAnonC.exports.memory);
    if (instAnonC.exports.__bump) qzAnonC.bindBump(instAnonC.exports.__bump);
    check("匿名默认导出.类内联", qzAnonC._toJS(instAnonC.exports.runAC()), 14);

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
 * 调用者不再经传递闭包退 interp：wasm 直调点走 interp_fn_value + call_value（宿主通道），
 * 调用者留在 wasm。 */
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
    check("interp.调用者留在 wasm（tagged 直调通道）", mode("caller"), "tagged");
    check("interp.无关函数仍 num", mode("pureNum"), "num");
    // 产物里不该有 interp 函数（wasm 导出表）
    const exp = WebAssembly.Module.exports(await WebAssembly.compile(fs.readFileSync(wasm))).map(e => e.name);
    check("interp.wasm 不含 heavy", exp.includes("heavy"), false);
    check("interp.wasm 含 pureNum", exp.includes("pureNum"), true);
    // interp JS 已产出且去掉了模块语法（无 exports/require/import 残留）
    check("interp.产出去模块语法", /exports|require\(/.test(r.interpJs), false);
    check("interp.JS 含目标函数", /function heavy\s*\(/.test(r.interpJs), true);
    {   // 直调通道运行时：wasm caller → call_value(heavy 句柄) → JS 副本，结果 10
        const qzI = makeQzvm(r.strings, { fields: r.fields });
        const instI = (await WebAssembly.instantiate(fs.readFileSync(wasm), { qz: qzI })).instance;
        if (instI.exports.memory) qzI.bindMem(instI.exports.memory);
        if (instI.exports.__bump) qzI.bindBump(instI.exports.__bump);
        qzI.bindClosures(instI.exports, r.lamMeta);
        const iNamesI = (r.funcMeta || []).filter(m => m.mode === "interp").map(m => m.name);
        const imapI = new Function(r.interpJs + "\nreturn { " + iNamesI.join(", ") + " };")();
        if (r.interpJs) qzI.bindInterp(imapI);
        qzI.bindClasses(instI.exports, r.classMeta);
        check("interp.wasm→interp 直调 caller(5)", qzI._toJS(instI.exports.caller(qzI._fromJS(5))), 10);
    }

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
    // 多文件 interp 拼接（zod compile.ts 的真实形态）：被 inline 的文件也可能含 interp 函数，
    // interpJs 必须把它们**全部**拼进来（tsc 把 node_modules 下的源文件当外部库 → emit 跳过）。
    // 同时：各文件私有的同名顶层声明须按文件改名，且拼接顺序满足依赖在前（否则 const 初值 TDZ）。
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "qz_aot_interp3_"));
    fs.writeFileSync(path.join(dir3, "dep.ts"),
        "export const BASE: number = 100;\n" +
        "export function baseAdd(n: number): number { return n + BASE; }\n");
    fs.writeFileSync(path.join(dir3, "dup1.ts"),
        "const error = (): string => { return 'e1'; };\n" +
        "export function d1(): string { return error(); }\n");
    fs.writeFileSync(path.join(dir3, "dup2.ts"),
        "const error = (): string => { return 'e2'; };\n" +
        "export function d2(): string { return error(); }\n");
    const i3 = path.join(dir3, "i3.ts");
    fs.writeFileSync(i3,
        "import { baseAdd } from './dep';\nimport { d1 } from './dup1';\nimport { d2 } from './dup2';\n" +
        "export async function slow(n: number): Promise<number> { return baseAdd(n); }\n" +
        "export function runI3(): string { return d1() + d2(); }\n");
    const r3 = compileTS(i3, path.join(dir3, "i3.wasm"), { interp: ["slow", "runI3"] });
    check("interp.多文件跨文件函数进 interpJs", /function baseAdd\s*\(/.test(r3.interpJs), true);
    check("interp.多文件私有重名不撞车", new Function(r3.interpJs + "\nreturn runI3;")()(), "e1e2");
    // 类方法/构造器调用**已被拉进 interp** 的顶层函数 → 整模块退 interp（classMeta 为空），
    // 且产出 JS 仍可执行。此前该形态下 interpJs 缺这些文件 → 运行期「未定义函数」。
    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), "qz_aot_interp4_"));
    fs.writeFileSync(path.join(dir4, "u.ts"),
        "export async function asyncDep(): Promise<number> { return 1; }\n" +
        "export function helper(x: number): number { void asyncDep(); return x + 1; }\n");
    const i4 = path.join(dir4, "i4.ts");
    fs.writeFileSync(i4,
        "import { helper } from './u';\n" +
        "class Box { n: number; constructor() { this.n = helper(1); } }\n" +
        "export function runBox(): number { return new Box().n; }\n");
    const r4 = compileTS(i4, path.join(dir4, "i4.wasm"), {});
    // 类方法调 interp 侧函数不再整模块回退：wasm 类保留，直调走 interp_fn_value + call_value。
    check("interp.类方法调 interp 依赖不再回退整模块", r4.classMeta.length, 1);
    {
        const qzB = makeQzvm(r4.strings, { fields: r4.fields });
        const instB = (await WebAssembly.instantiate(fs.readFileSync(path.join(dir4, "i4.wasm")), { qz: qzB })).instance;
        if (instB.exports.memory) qzB.bindMem(instB.exports.memory);
        if (instB.exports.__bump) qzB.bindBump(instB.exports.__bump);
        qzB.bindClosures(instB.exports, r4.lamMeta);
        const bNames = (r4.funcMeta || []).filter(m => m.mode === "interp").map(m => m.name);
        if (bNames.length) qzB.bindInterp(new Function(r4.interpJs + "\nreturn { " + bNames.join(", ") + " };")());
        qzB.bindClasses(instB.exports, r4.classMeta);
        check("interp.类构造器经直调通道取 interp 值", qzB._toJS(instB.exports.runBox()), 2);
    }
    // `import type` 的模块在运行时被完全擦除：其实现（尤其 async）不得被内联。
    // 此前 tsc 的 program 把类型依赖也纳入发射集 → 无关文件里的 async 污染 interp 判定，
    // 整模块被迫退 interp（zod util.ts 实测：83 个 program 文件里运行时只依赖 2 个）。
    const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), "qz_aot_interp5_"));
    fs.writeFileSync(path.join(dir5, "typedep.ts"),
        "export async function asyncDep(): Promise<number> { return 1; }\nexport type T = number;\n");
    const i5 = path.join(dir5, "i5.ts");
    fs.writeFileSync(i5,
        "import type { T } from './typedep';\n" +
        "export function pick(n: number): number { const x: T = n; return x + 1; }\n");
    const r5 = compileTS(i5, path.join(dir5, "i5.wasm"), {});
    check("type-only.类型依赖不进发射集", /asyncDep/.test(r5.interpJs), false);
    check("type-only.入口函数全进 wasm", r5.funcMeta.every(m => m.mode !== "interp"), true);
    const { instance: inst5 } = await WebAssembly.instantiate(fs.readFileSync(path.join(dir5, "i5.wasm")), {});
    check("type-only.可执行", inst5.exports.pick(41), 42);
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
      + "export function computedKeySpread(): any { const k: any = \"dyn\"; const base: any = { a: 1 }; const o: any = { ...base, [k]: 9 }; return o.a + \"|\" + o.dyn; }\n"
      + "export function restMany(): any { const o: any = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, keep: 8 }; const { a, b, c, d, e, f, g, ...rest } = o; return rest.keep + \"|\" + Object.keys(rest).length; }\n"
      + "export function strLitMember(): any { class S { \"~standard\" = 42; } const s: any = new S(); return s[\"~standard\"]; }\n"
      + "export function forOfStr(): any { let s = \"\"; for (const ch of \"abc\") s += ch + \".\"; return s; }\n"
      + "export function destrAssign(): any { let a = 1, b = 2; [a, b] = [b, a]; let x = 0, y = 0; ({ m: x, n: y } = { m: 7, n: 8 }); return a + \"|\" + b + \"|\" + x + \"|\" + y; }\n"
      + "export function bitMixed(): any { const out: any = []; out.push((3.9 | 0) + (2.1 & 3)); out.push(NaN | 0); out.push(1e9 * 1e9 | 0); out.push(\"12\" | 0); return out.join(\"|\"); }\n"
      + "export function nestedNew(): any { class P { name: any = \"a\"; } class Q { tag(p: any) { return \"q:\" + p.name; } } const q = new Q(); return q.tag(new P()); }\n"
      + "class KBase { v: any = 1; }\n"
      + "class KDer extends KBase { w: any = 2; }\n"
      + "export function instOf(): any { const d = new KDer(); const out: any = []; out.push(d instanceof KDer ? 1 : 0); out.push(d instanceof KBase ? 1 : 0); out.push(d instanceof Object ? 1 : 0); out.push(d instanceof Array ? 1 : 0); out.push(\"s\" instanceof String ? 1 : 0); out.push([1] instanceof Array ? 1 : 0); out.push(1 instanceof Number ? 1 : 0); return out.join(\"|\"); }\n"
      + "export function arrOOB(): any { const a: any = [1,2]; const out: any = []; out.push(a[5] === undefined ? 1 : 0); a[4] = 9; out.push(a.length); out.push(a[4]); return out.join(\"|\"); }\n"
      + "export namespace util { export function join2(a: any, b: any): any { return a + sep + b; } export const sep: any = \"-\"; }\n"
      + "export function nsFlat(): any { return util.join2(\"a\", \"b\") + \"|\" + util.sep; }\n"
      + "export function implOnly(): any { interface Iface { b: number; } class Impl implements Iface { b = 2; } const i: any = new Impl(); return i.b; }\n"
      + "class SArrow { static make = (x: any): any => ({ v: x }); }\n"
      + "export function staticArrowField(): any { return SArrow.make(7).v; }\n"
      + "class Base2 { v: number; constructor(x: number) { this.v = x; } }\n"
      + "class Sub2 extends Base2 { w: number = 2; }\n"
      + "export function synthSuper(): any { const s: any = new Sub2(7); return s.v + \",\" + s.w; }\n"
      + "class MyErr extends Error { code: number = 3; }\n"
      + "export function builtinSuper(): any { const e: any = new MyErr(\"boom\"); return e.message + e.code; }\n"
      + "export function proxyTrap(): any { let t: any; return new Proxy({}, { get(_: any, p: any) { t = t || { a: 5 }; const g: any = Reflect.get; return g(t, p); } }); }\n"
      + "export function proxyUse(): any { const p: any = proxyTrap(); return p.a; }\n"
      + "export async function asG(x: number): Promise<any> { const a = await Promise.resolve(2); return a + x; }\n");
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
    check("展开.计算键", call("computedKeySpread"), "1|9");
    check("for-of.字符串", call("forOfStr"), "a.b.c.");
    check("解构.赋值", call("destrAssign"), "2|1|7|8");
    check("位运算.混合表达式", call("bitMixed"), "5|0|-1486618624|12");
    check("new.嵌套实参槽", call("nestedNew"), "q:a");
    check("数组.越界读/写扩容", call("arrOOB"), "1|5|9");
    check("instanceof.实例tag+内建", call("instOf"), "1|1|1|0|0|1|0");   // 原始值 instanceof String/Number = false
    check("解构.rest 8 键排除", call("restMany"), "8|1");
    check("类.字面量名成员", call("strLitMember"), 42);
    check("命名空间.展平", call("nsFlat"), "a-b|-");
    check("类.implements 不算父类", call("implOnly"), 2);
    check("类.静态箭头字段作方法", call("staticArrowField"), 7);
    // 无显式 ctor 的派生类：合成 ctor 须转发父 ctor；内建父（Error）无 wasm ctor，
    // 走与显式 super() 相同的 message/name 字段路径（曾 call 未定义: __m_Error$ctor）。
    check("类.合成 ctor 转发用户父类", call("synthSuper"), "7,2");
    check("类.合成 ctor 内建父(Error)", call("builtinSuper"), "boom3");
    check("Proxy.内建构造+trap 派发", call("proxyUse"), 5);
    // async 函数不能编 wasm（await 需挂起/恢复）→ 自动走 interp，产物保留原生 async/await。
    // 曾 strip 成同步 + await 作 identity：`await p` 返回 Promise 句柄（静默错值）。
    const asFn = r.funcMeta.find(m => m.name === "asG");
    check("async.自动走 interp", asFn && asFn.mode, "interp");
    check("async.await 解包", await new Function(r.interpJs + "; return asG;")()(5), 7);
    // 嵌套 async（函数体内的 async 闭包）无 wasm 通道 → 整个顶层函数退 interp，闭包作为
    // 原生 JS async 箭头存活，await 后拿到真值。双域安全由下方用例保证。
    const nestedSrc = path.join(os.tmpdir(), "qz_aot_nested_async.ts");
    fs.writeFileSync(nestedSrc, "export function nestedAsync(): any { const g = async () => 41; return g; }\n");
    const nestedR = compileTS(nestedSrc, path.join(os.tmpdir(), "qz_aot_nested_async.wasm"), {});
    check("async.嵌套闭包走 interp", nestedR.funcMeta.find(m => m.name === "nestedAsync").mode, "interp");
    check("async.嵌套闭包 await 解包", await new Function(nestedR.interpJs + "; return nestedAsync;")()()(), 41);
    // interp 与 wasm 双侧触碰同一可变模块级变量：曾各存一份 → 静默错值（wasm 加到 5，interp 读 0）。
    // 现在自动整模块退 interp（单域），跨侧读到同一个值。
    const dualSrc = path.join(os.tmpdir(), "qz_aot_dual_domain.ts");
    fs.writeFileSync(dualSrc, "let total: any = 0;\nexport function addWasm(): any { total = total + 5; return total; }\nexport async function readAsync(): Promise<any> { return total; }\n");
    const dualR = compileTS(dualSrc, path.join(os.tmpdir(), "qz_aot_dual_domain.wasm"), {});
    check("interp/wasm.双域退整模块 interp", dualR.funcMeta.every(m => m.mode === "interp"), true);
    const dualF = new Function(dualR.interpJs + "; return { addWasm, readAsync };")();
    check("interp/wasm.双域状态共享", dualF.addWasm(), 5);
    check("interp/wasm.双域跨侧读到同值", await dualF.readAsync(), 5);
    // generator 与 async 同属挂起/恢复语义：走 interp，由宿主原生生成器承载。
    // 旧实现只把「平坦 yield」降级成返回数组——`.next()` 逐步消费时语义错。
    const genSrc = path.join(os.tmpdir(), "qz_aot_gen.ts");
    fs.writeFileSync(genSrc,
        "export function* gen(): any { yield 1; yield 2; return 3; }\n" +
        "export function stepGen(): string { const g: any = gen(); const a: any = g.next(); const b: any = g.next(); const c: any = g.next(); return a.value + ',' + b.value + ',' + c.value + ',' + c.done; }\n");
    const genR = compileTS(genSrc, path.join(os.tmpdir(), "qz_aot_gen.wasm"), {});
    check("generator.自动走 interp", genR.funcMeta.find(m => m.name === "gen").mode, "interp");
    check("generator.调用者留在 wasm（tagged 直调通道）", genR.funcMeta.find(m => m.name === "stepGen").mode, "tagged");
    {   // wasm stepGen → call_value(gen 句柄) → 宿主生成器；.next() 逐步消费
        const qzG = makeQzvm(genR.strings, { fields: genR.fields });
        const instG = (await WebAssembly.instantiate(fs.readFileSync(path.join(os.tmpdir(), "qz_aot_gen.wasm")), { qz: qzG })).instance;
        if (instG.exports.memory) qzG.bindMem(instG.exports.memory);
        if (instG.exports.__bump) qzG.bindBump(instG.exports.__bump);
        qzG.bindClosures(instG.exports, genR.lamMeta);
        const gNames = (genR.funcMeta || []).filter(m => m.mode === "interp").map(m => m.name);
        qzG.bindInterp(new Function(genR.interpJs + "\nreturn { " + gNames.join(", ") + " };")());
        qzG.bindClasses(instG.exports, genR.classMeta);
        check("generator.wasm→interp 直调 stepGen", qzG._toJS(instG.exports.stepGen()), "1,2,3,true");
    }
    // 类里的 generator 方法无函数级通道 → 整模块退 interp（与 async 方法同判据）。
    const genClsSrc = path.join(os.tmpdir(), "qz_aot_gencls.ts");
    fs.writeFileSync(genClsSrc,
        "class Bag { *items(): any { yield 1; yield 2; } }\n" +
        "export function useBag(): string { const b = new Bag(); return [...b.items()].join('-'); }\n");
    const genClsR = compileTS(genClsSrc, path.join(os.tmpdir(), "qz_aot_gencls.wasm"), {});
    check("generator.类方法 → 整模块退 interp", genClsR.classMeta.length, 0);
    check("generator.类方法可执行", new Function(genClsR.interpJs + "; return useBag;")()(), "1-2");
}

// AST 自动纯度：纯函数的循环不变调用外提（无人工标注） → 循环体变纯 f64 → M7 抽 num 片段
async function runLicm() {
    const src = path.join(os.tmpdir(), "qz_aot_licm.ts");
    fs.writeFileSync(src, `
function grade(v: any): number {
  if (v === null || typeof v !== "object") return -1;
  let e = 0;
  if (typeof v.name !== "string") e = e + 1;
  else if (v.name.length < 2) e = e + 1;
  if (typeof v.age !== "number") e = e + 1;
  else if (v.age > 150) e = e + 1;
  return e;
}
function work(n: number): number {
  const good = { name: "Alice", age: 30 };
  const bad = { name: "", age: 200 };
  let t = 0;
  for (let i = 0; i < n; i++) {
    if ((i % 2) === 0) t = t + grade(good);
    else t = t + grade(bad);
  }
  return t;
}
// 反例 1：循环内写参数属性 → 不得外提（求值次数变化会静默错值）
function readX(o: any): number { return o.x; }
function mutating(n: number): number {
  const o = { x: 1 };
  let t = 0;
  for (let i = 0; i < n; i++) { t = t + readX(o); o.x = i; }
  return t;
}
// 反例 2：写参数属性 → AST 纯度判定须拒绝外提
function bump(o: any): number { o.x = o.x + 1; return o.x; }
function impureCallee(n: number): number {
  const o = { x: 0 };
  let t = 0;
  for (let i = 0; i < n; i++) t = t + bump(o);
  return t;
}
// 反例 3：写模块级变量 → AST 纯度判定须拒绝外提
let counter = 0;
function badGlobal(o: any): number { counter = counter + 1; return o.x; }
function globalWrite(n: number): number {
  const o = { x: 1 };
  let t = 0;
  for (let i = 0; i < n; i++) t = t + badGlobal(o);
  return t + counter;
}
// 反例 4：只读模块可变状态也不算纯——逐轮变化的 gstate 外提会错值
let gstate = 0;
function readState(o: any): number { return gstate + o.x; }
function stateRead(n: number): number {
  const o = { x: 1 };
  let t = 0;
  for (let i = 0; i < n; i++) { gstate = i; t = t + readState(o); }
  return t;
}
// 传递纯：pureChain 调 pureInc（模块内函数），后者已证明纯 → 两者都可外提
function pureInc(v: any): number { return Math.floor(v.x) + 1; }
function pureChain(v: any): number { return pureInc(v) * 2; }
function chainWork(n: number): number {
  const good = { x: 3 };
  let t = 0;
  for (let i = 0; i < n; i++) t = t + pureChain(good);
  return t;
}
`);
    const wasm = path.join(os.tmpdir(), "qz_aot_licm.wasm");
    const r = compileTS(src, wasm, {});
    const frags = WebAssembly.Module.exports(new WebAssembly.Module(fs.readFileSync(wasm)))
        .filter(x => x.name.startsWith("__aot_frag"));
    check("LICM: work 循环被 M7 抽成 num 片段", frags.length > 0, true);
    const qz = makeQzvm(r.strings, { fields: r.fields });
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
    qz.bindMem(instance.exports.memory);
    if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
    qz.bindClosures(instance.exports, r.lamMeta);
    for (const n of [1, 2, 5, 10]) {
        if (instance.exports.__bump_reset) instance.exports.__bump_reset();
        const got = qz._toJS(instance.exports.work(qz._fromJS(n)));
        check("LICM: work(" + n + ")", got, n % 2 === 0 ? n / 2 * 2 : Math.floor(n / 2) * 2);
    }
    // 反例：循环内写 o.x → readX(o) 不得外提；n=3 应得 1+0+1=2（外提会错成 3）
    if (instance.exports.__bump_reset) instance.exports.__bump_reset();
    check("LICM: 属性写阻止外提", qz._toJS(instance.exports.mutating(qz._fromJS(3))), 2);
    // 反例：写参数属性 → 自动判定拒绝，调用保留在循环内；n=3 应得 1+2+3=6
    if (instance.exports.__bump_reset) instance.exports.__bump_reset();
    check("LICM: 写参数属性被拒", qz._toJS(instance.exports.impureCallee(qz._fromJS(3))), 6);
    // 反例：写模块级 counter 的函数不得外提；n=3 应得 3+3=6（外提会错成 3+1=4）
    if (instance.exports.__bump_reset) instance.exports.__bump_reset();
    check("LICM: 模块状态写被拒", qz._toJS(instance.exports.globalWrite(qz._fromJS(3))), 6);
    // 反例：只读模块可变 gstate 的函数不得外提；n=3 应得 1+2+3=6（外提会错成 3）
    if (instance.exports.__bump_reset) instance.exports.__bump_reset();
    check("LICM: 读模块可变状态被拒", qz._toJS(instance.exports.stateRead(qz._fromJS(3))), 6);
    // 传递纯调用链：pureInc 已证明纯 → pureChain 也可外提；n=3 应得 8*3=24
    if (instance.exports.__bump_reset) instance.exports.__bump_reset();
    check("LICM: 传递纯调用链", qz._toJS(instance.exports.chainWork(qz._fromJS(3))), 24);
}

// typeof/literal 与两字面量比较内联（省 qz.seq/qz.sne 跨界）的语义边界
async function runTypeofLit() {
    const src = path.join(os.tmpdir(), "qz_aot_typeoflit.ts");
    fs.writeFileSync(src, `
function tsS(x: any): number { return typeof x === "string" ? 1 : 0; }
function tsN(x: any): number { return typeof x !== "number" ? 1 : 0; }
function tsBad(x: any): number { return typeof x === "foo" ? 1 : 0; }
function litEq(): number { return "abc" === "abc" ? 1 : 0; }
function litNe(): number { return "abc" !== "abd" ? 1 : 0; }
function tsVar(x: any, y: string): number { return typeof x === y ? 1 : 0; }
// 短路左侧为比较（tagged bool）→ 内联 truthy；非比较左侧仍走 qz.truthy
function orCmp(a: any): number { return (a === null || typeof a === "string") ? 1 : 0; }
function andCmp(a: any): number { return (a !== null && a !== undefined) ? 1 : 0; }
function orNum(a: any): number { const r = a || 7; return typeof r === "number" ? r : -1; }
`);
    const wasm = path.join(os.tmpdir(), "qz_aot_typeoflit.wasm");
    compileTS(src, wasm, {});
    const qz = makeQzvm([], {});
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
    if (instance.exports.memory) qz.bindMem(instance.exports.memory);
    if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
    const e = instance.exports;
    const j = (v) => qz._fromJS(v), r = (v) => qz._toJS(v);
    check("typeof lit: string", r(e.tsS(j("hi"))), 1);
    check("typeof lit: number", r(e.tsS(j(5))), 0);
    check("typeof lit: !== number on number", r(e.tsN(j(5))), 0);
    check("typeof lit: !== number on string", r(e.tsN(j("x"))), 1);
    check("typeof lit: impossible literal", r(e.tsBad(j("x"))), 0);
    check("literal === same", r(e.litEq()), 1);
    check("literal !== other", r(e.litNe()), 1);
    check("typeof vs variable (generic path)", r(e.tsVar(j("x"), j("string"))), 1);
    check("orCmp: left true short-circuits", r(e.orCmp(j(null))), 1);
    check("orCmp: left false → right", r(e.orCmp(j("x"))), 1);
    check("orCmp: both false", r(e.orCmp(j(5))), 0);
    check("andCmp: left false", r(e.andCmp(j(null))), 0);
    check("andCmp: both true", r(e.andCmp(j("x"))), 1);
    check("orNum: non-comparison → qz.truthy", r(e.orNum(j(0))), 7);
    check("orNum: truthy number", r(e.orNum(j(5))), 5);
    // 宿主对象方法 typeof → "function" 是既有已知限制（tagged.js TypeOfExpression 注释），非本优化范围
}

(async () => {
    await runNum();
    await runLicm();
    await runTypeofLit();
    await runTagged();
    await runClasses();
    await runMultiFile();
    await runInterp();
    await runSemantics();
    await runDwarf();
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
