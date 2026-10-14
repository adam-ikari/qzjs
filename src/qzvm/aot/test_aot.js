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
`;

async function runNum() {
    const tmp = path.join(os.tmpdir(), "qz_aot_num.ts");
    fs.writeFileSync(tmp, NUM_SRC);
    const wasm = path.join(os.tmpdir(), "qz_aot_num.wasm");
    compileTS(tmp, wasm, {});
    const bytes = fs.readFileSync(wasm);
    const stub = new Proxy({}, { get: () => (..._a) => 0 });
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
}

async function runTagged() {
    // tagged 路径：f64 NaN-box（值=i64；数值=原始 f64 位型，句柄=高16位0x7FF9）
    const src = path.join(__dirname, "mix.ts");
    const wasm = path.join(os.tmpdir(), "qz_aot_mix.wasm");
    const r = compileTS(src, wasm, {});
    const qz = makeQzvm(r.strings);
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
    qz.bindMem(instance.exports.memory);
    if (instance.exports.__bump) qz.bindBump(instance.exports.__bump);
    const e = instance.exports;
    qz.bindClosures(instance.exports, r.lamMeta);
    const call = (n, a) => {
        const m = r.funcMeta.find(f => f.name === n);
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
    const qzs = makeQzvm(rs.strings);
    const { instance: instS } = await WebAssembly.instantiate(fs.readFileSync(strs), { qz: qzs });
    qzs.bindMem(instS.exports.memory);
    if (instS.exports.__bump) qzs.bindBump(instS.exports.__bump);
    const callS = (n, a) => qzs._toJS(instS.exports[n](...a.map(x => qzs._fromJS(x))));
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
    const qzc = makeQzvm(rcl.strings);
    const { instance: instCl } = await WebAssembly.instantiate(fs.readFileSync(cw), { qz: qzc });
    qzc.bindMem(instCl.exports.memory);
    if (instCl.exports.__bump) qzc.bindBump(instCl.exports.__bump);
    qzc.bindClosures(instCl.exports, rcl.lamMeta);
    const callC = (n, a) => { const m = rcl.funcMeta.find(f => f.name === n); const r = instCl.exports[n](...a.map(x => qzc._fromJS(x))); return m.mode === "num" ? r : qzc._toJS(r); };
    check("闭包.adder(5)", callC("adder", [5]), 15);
    check("闭包.closure()", callC("closure", []), 105);
}

async function runClasses() {
    const wasm = path.join(os.tmpdir(), "qz_aot_cls.wasm");
    const r = compileTS(path.join(__dirname, "cls.ts"), wasm, {});
    const qz = makeQzvm(r.strings);
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
    const qz = makeQzvm(r.strings);
    const { instance } = await WebAssembly.instantiate(buf, { qz });
    check("dwarf.带段仍可执行", instance.exports.add(2, 3), 5);
}

(async () => {
    await runNum();
    await runTagged();
    await runClasses();
    await runDwarf();
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
