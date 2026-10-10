#!/usr/bin/env node
/* test_aot.js — AOT 最小 e2e 回归门（编译 TS→wasm→node WebAssembly 运行→比对期望）。
 *
 * 不依赖 wamrc/AOT（无需 LLVM 宿主）：node 的 WebAssembly 直接跑 emitter 产出的 .wasm。
 * 覆盖：num 快路径（f64 语义：除法/取模/大数）与 tagged 路径两 rep（f64 NaN-box 默认 + i32 回退）。
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
    // i32 rep（32 位宿主回退路径）：opts.tagged="i32" 选回旧 31 位位模型
    const src = path.join(__dirname, "mix.ts");
    const wasm = path.join(os.tmpdir(), "qz_aot_mix.wasm");
    const r = compileTS(src, wasm, { tagged: "i32" });
    const qz = makeQzvm(r.strings);
    const bytes = fs.readFileSync(wasm);
    const { instance } = await WebAssembly.instantiate(bytes, { qz });
    const e = instance.exports;
    const call = (n, a) => {
        const m = r.funcMeta.find(f => f.name === n);
        const conv = m.mode === "num" ? a : a.map(x => qz._fromJS(x));
        const res = e[n](...conv);
        return m.mode === "num" ? res : qz._toJS(res);
    };
    check("mix.fib(20)", call("fib", [20]), 6765);
    check("mix.numWork(3000)", call("numWork", [3000]), 66268200);
    check("mix.objWork(5)", call("objWork", [5]), 40);
}

// f64 NaN-box rep（64 位宿主默认）：值 = i64，数值精确、句柄高16位 0x7FF9
async function runTaggedF64() {
    const { makeQzvmF64 } = require("./qzvm-f64.js");
    const src = path.join(__dirname, "mix.ts");
    const wasm = path.join(os.tmpdir(), "qz_aot_mix_f64.wasm");
    const r = compileTS(src, wasm, {});
    const qz = makeQzvmF64(r.strings);
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasm), { qz });
    const e = instance.exports;
    const meta = (n) => r.funcMeta.find(f => f.name === n);
    const call = (n, a) => {
        const m = meta(n);
        const conv = m.mode === "num" ? a : a.map(x => qz._fromJS(x));
        const res = e[n](...conv);
        return m.mode === "num" ? res : qz._toJS(res);
    };
    check("f64 mix.fib(20)", call("fib", [20]), 6765);
    check("f64 mix.numWork(3000)", call("numWork", [3000]), 66268200);
    check("f64 mix.objWork(5)", call("objWork", [5]), 40);
    check("f64 mix.bigAcc(3000)", call("bigAcc", [3000]), 3000000000000);   // 3e12 超 32 位，i32 rep 会溢出
    check("f64 除法(7/2)", qz._toJS(qz.div(qz._fromJS(7), qz._fromJS(2))), 3.5);
}

(async () => {
    await runNum();
    await runTagged();
    await runTaggedF64();
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
