#!/usr/bin/env node
/* build.js — AOT 编译流水线（JS 技术栈主入口）。
 * 子命令:
 *   build.js build <src.ts> [prefix]   # 一键：TS → wasm → wamrc AOT → glue.js
 *   build.js compile <src.ts> <prefix> # 仅编译：TS → <prefix>.wasm + .strings.json + .meta.json
 *   build.js glue <prefix>                            # 仅 glue：生成 <prefix>.glue.js（外部形态）
 *
 * 产物形态（分离，不内嵌 base64 防源码膨胀）：
 *   <prefix>.glue.js  +  <prefix>.wasm + <prefix>.aot
 * glue.js 运行时经 globalThis.qzjs.fs.readFileBinary 异步读同目录 .wasm/.aot。
 * qzjs 直接 `qzjs <prefix>.glue.js` 运行。__call(name, args) 按 funcMeta 自动转换
 * num(裸 f64) vs tagged(qz._fromJS/qz._toJS)。wamrc 是唯一外部编译后端（LLVM AOT，
 * 无法 JS 化），经 child_process 调用；路径可用 WAMRC 环境变量覆盖。
 */
"use strict";
const { compileTS } = require("./emitter.js");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
// wamrc 查找顺序：WAMRC 环境变量 > PATH 上的 wamrc > 旧 demo 内的固定路径
function resolveWamrc() {
    if (process.env.WAMRC) return process.env.WAMRC;
    const onPath = (() => { try { return execSync("command -v wamrc", { encoding: "utf8" }).trim(); } catch { return ""; } })();
    if (onPath) return onPath;
    const legacy = "/home/gem/project/perry_wasm_demo/.deps/wamr/wamr-compiler/build/wamrc";
    if (fs.existsSync(legacy)) return legacy;
    return "wamrc";
}

// 中间产物统一到工程 build/aot/（与 CMake build/ 一致），AOT_OUT_DIR 可覆盖
function outDir() {
    return process.env.AOT_OUT_DIR || path.join(__dirname, "..", "..", "..", "build", "aot");
}

function extractMakeQzvm() {
    const src = fs.readFileSync(path.join(__dirname, "qzvm.js"), "utf8");
    const end = src.indexOf("\nmodule.exports");
    // 从 "use strict"; 起切，含 makeQzvm 依赖的模块级常量（TAG/buf）
    const start = src.indexOf('"use strict";');
    if (start < 0 || end < 0) throw new Error("qzvm.js: 找不到 makeQzvm");
    return src.slice(start, end);
}

// --mem <MiB>：线性内存上限（默认 40）。影响 memory 页数、bump arena 上界与字面量段起点。
function memOpt() {
    const i = process.argv.indexOf("--mem");
    const v = i >= 0 ? Number(process.argv[i + 1]) : 0;
    if (i >= 0 && !(v > 0)) { console.error("--mem 需要正数 MiB"); process.exit(2); }
    return v ? { memMiB: v } : {};
}

// 解析 --main "fn(a, b); fn2(c)" → [{name, args}]
function parseMain(spec) {
    const calls = [];
    const re = /([A-Za-z_$][\w$]*)\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(spec))) {
        const args = m[2].split(",").filter(s => s.trim() !== "").map(s => Number(s.trim()));
        calls.push({ name: m[1], args });
    }
    return calls;
}


// 从 .wasm 反汇编出可读 .wat 中间产物（审计/调试用；wasm2wat 缺失则跳过）。
// 注意：这是 wamrc AOT 前的 wasm 文本，非 wamrc 的 AOT 产物。
function emitWat(prefix) {
    try {
        execSync(`wasm2wat --enable-all "${prefix}.wasm" -o "${prefix}.wat"`, { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

function genGlue(prefix, mainCalls, wasmOnly) {
    const strings = JSON.parse(fs.readFileSync(prefix + ".strings.json", "utf8"));
    const metaObj = JSON.parse(fs.readFileSync(prefix + ".meta.json", "utf8"));
    const meta = metaObj.funcs;
    const lams = metaObj.lams || {};
    const classes = metaObj.classes || [];
    // interp 回退：列在 funcMeta.mode === "interp" 的函数不编 wasm，跑 transpile 出的 JS。
    const interpNames = meta.filter(m => m.mode === "interp").map(m => m.name);
    const interpFile = prefix + ".interp.js";
    const interpJs = (interpNames.length && fs.existsSync(interpFile)) ? fs.readFileSync(interpFile, "utf8") : "";
    const makeQzvm = extractMakeQzvm();
    const basename = path.basename(prefix);   // glue 读同目录外部文件（不内嵌）
    // 主逻辑体：--main 生成逐调用行；否则 __main 钩子（用户追加）
    const mainBody = (mainCalls && mainCalls.length)
        ? mainCalls.map(c => `console.log("${c.name}(${c.args.join(",")}) =", __call("${c.name}", [${c.args.join(",")}]));`).join("\n")
        : `if (typeof globalThis.__main === "function") globalThis.__main(__call, __ex);`;
    // wasmOnly（--no-aot）：WAMR debug-interp 直接拒绝 AOT 实例，调试运行须纯 bytecode 加载。
    const note = wasmOnly ? `本文件 + ${basename}.wasm（wasm-only）` : `本文件 + ${basename}.wasm + ${basename}.aot`;
    const load = wasmOnly
        ? `__fs.readFileBinary("${basename}.wasm").then(bytes =>
  WebAssembly.instantiate(bytes, { qz }).then(({ instance }) => {`
        : `Promise.all([
  __fs.readFileBinary("${basename}.wasm"),
  __fs.readFileBinary("${basename}.aot"),
]).then(([bytes, aot]) =>
  WebAssembly.instantiate(bytes, { qz }, { aot }).then(({ instance }) => {`;
    let glue = `${makeQzvm}
// ── 生成产物：${basename}（分离形态：${note}，同目录）──
const qz = makeQzvm(${JSON.stringify(strings)}, ${JSON.stringify({ ...(metaObj.arena ? { arenaEnd: metaObj.arena } : {}), ...(metaObj.fields && metaObj.fields.length ? { fields: metaObj.fields } : {}) })});
const __meta = ${JSON.stringify(meta)};
const __lams = ${JSON.stringify(lams)};
const __classes = ${JSON.stringify(classes)};
const __fs = globalThis.qzjs && globalThis.qzjs.fs;
// interp 回退函数：transpile 出的 JS（去类型）在闭包里求值，按名取出。
// 与 wasm 路径语义等价（同一份 TS 源码），只是跑在宿主解释器而非 AOT 机器码。
const __interp = (function () {
${interpJs}
return { ${interpNames.map(n => `${n}: typeof ${n} === "function" ? ${n} : undefined`).join(", ")} };
})();
${load}
    const __ex = instance.exports;
    if (__ex.memory) qz.bindMem(__ex.memory);   // 全 interp 产物无内存（空 wasm 模块）
    if (__ex.__bump) qz.bindBump(__ex.__bump);
    qz.bindClosures(__ex, __lams);
    qz.bindClasses(__ex, __classes);
    // __call(name, args)：按 funcMeta 自动转换 num(裸) vs tagged(_fromJS/_toJS)
    // 每次调用前重置 bump arena（静态编译无 GC：调用内分配随调用结束失效，与调用时长解耦）。
    const __call = (name, args) => {
      const m = __meta.find(f => f.name === name);
      if (!m) throw new Error("未知导出: " + name);
      // interp 模式：函数体跑宿主解释器（transpile 的 JS），参数/返回都是裸 JS 值，不经 qz 转换。
      if (m.mode === "interp") {
        const fn = __interp[name];
        if (typeof fn !== "function") throw new Error("interp 函数缺失: " + name);
        return fn(...args);
      }
      if (__ex.__bump_reset) __ex.__bump_reset();
      const conv = m.mode === "num" ? args : args.map(a => qz._fromJS(a));
      const r = __ex[name](...conv);
      return m.mode === "num" ? r : qz._toJS(r);
    };
    // ── 主逻辑（--main）──
    ${mainBody}
  })
).catch(e => { console.error("AOT load failed:", (e && e.message) || String(e)); });
`;
    fs.writeFileSync(prefix + ".glue.js", glue);
    console.log(`glue ok: ${prefix}.glue.js（${note}${wasmOnly ? "" : " 由 fs.readFileBinary 读取"}）`);
}

const cmd = process.argv[2];
if (cmd === "build") {
    const src = process.argv[3];
    if (!src) { console.error("usage: build.js build <src.ts> [prefix]"); process.exit(2); }
    const nameArg = process.argv[4];
    const name = (nameArg && !nameArg.startsWith("--")) ? nameArg : path.basename(src).replace(/\.ts$/, "");
    const prefix = path.join(outDir(), name);
    const wamrc = resolveWamrc();
    fs.mkdirSync(outDir(), { recursive: true });
    // --interp <fn1,fn2>：这些函数不编 wasm，退到宿主 JS 解释器跑。
    const interpIdx = process.argv.indexOf("--interp");
    const interp = interpIdx >= 0 ? process.argv[interpIdx + 1].split(",").filter(Boolean) : [];
    const r = compileTS(src, prefix + ".wasm", { debug: process.argv.includes("--debug"), interp, ...memOpt() });
    fs.writeFileSync(prefix + ".strings.json", JSON.stringify(r.strings));
    fs.writeFileSync(prefix + ".meta.json", JSON.stringify({ funcs: r.funcMeta, lams: r.lamMeta || {}, classes: r.classMeta || [], arena: r.arenaEnd, fields: r.fields || [] }));
    if (r.interpJs) fs.writeFileSync(prefix + ".interp.js", r.interpJs);
    const nInterp = r.funcMeta.filter(m => m.mode === "interp").length;
    console.log(`compile ok: ${prefix}.wasm (${fs.statSync(prefix + ".wasm").size} B) strings=${r.strings.length} funcs=${r.funcMeta.length}${nInterp ? ` interp=${nInterp}` : ""}`);
    if (emitWat(prefix)) console.log(`  wat: ${prefix}.wat`);
    // --target <arch> [--target-abi <abi>]：交叉编译 .aot 到 32 位设备（armv7/riscv32/i386 等）
    const tIdx = process.argv.indexOf("--target");
    const abiIdx = process.argv.indexOf("--target-abi");
    const targetFlag = tIdx >= 0 ? ` --target=${process.argv[tIdx + 1]}` : "";
    const abiFlag = abiIdx >= 0 ? ` --target-abi=${process.argv[abiIdx + 1]}` : "";
    execSync(`"${wamrc}"${targetFlag}${abiFlag} -o "${prefix}.aot" "${prefix}.wasm"`, { stdio: "inherit" });
    console.log(`✓ wamrc AOT${tIdx >= 0 ? " --target=" + process.argv[tIdx + 1] : ""}${abiIdx >= 0 ? " --target-abi=" + process.argv[abiIdx + 1] : ""}`);
    const mainIdx = process.argv.indexOf("--main");
    const mainCalls = mainIdx >= 0 ? parseMain(process.argv[mainIdx + 1]) : [];
    const wasmOnly = process.argv.includes("--no-aot");
    genGlue(prefix, mainCalls, wasmOnly);
    console.log(`== done: ${prefix}.glue.js（运行: qzjs ${prefix}.glue.js）`);
} else if (cmd === "compile") {
    const src = process.argv[3];
    const nameArg = process.argv[4];
    const name = (nameArg && !nameArg.startsWith("--")) ? nameArg : path.basename(src).replace(/\.ts$/, "");
    const prefix = path.join(outDir(), name);
    fs.mkdirSync(outDir(), { recursive: true });
    const interpIdx2 = process.argv.indexOf("--interp");
    const interp2 = interpIdx2 >= 0 ? process.argv[interpIdx2 + 1].split(",").filter(Boolean) : [];
    const r = compileTS(src, prefix + ".wasm", { debug: process.argv.includes("--debug"), interp: interp2, ...memOpt() });
    fs.writeFileSync(prefix + ".strings.json", JSON.stringify(r.strings));
    fs.writeFileSync(prefix + ".meta.json", JSON.stringify({ funcs: r.funcMeta, lams: r.lamMeta || {}, classes: r.classMeta || [], arena: r.arenaEnd, fields: r.fields || [] }));
    if (r.interpJs) fs.writeFileSync(prefix + ".interp.js", r.interpJs);
    const nInterp2 = r.funcMeta.filter(m => m.mode === "interp").length;
    console.log(`compile ok: ${prefix}.wasm (${fs.statSync(prefix + ".wasm").size} B) strings=${r.strings.length} funcs=${r.funcMeta.length}${nInterp2 ? ` interp=${nInterp2}` : ""}`);
    if (emitWat(prefix)) console.log(`  wat: ${prefix}.wat`);
} else if (cmd === "glue") {
    const mainIdx = process.argv.indexOf("--main");
    const mainCalls = mainIdx >= 0 ? parseMain(process.argv[mainIdx + 1]) : [];
    const wasmOnly = process.argv.includes("--no-aot");
    genGlue(process.argv[3], mainCalls, wasmOnly);
} else {
    console.error("usage: build.js build|compile|glue ...");
    console.error("  build  <src.ts> [prefix] [--main \"fn(a);fn2(b)\"] [--target <arch> --target-abi <abi>] [--debug]");
    console.error("  compile <src.ts> [prefix] [--debug]   # 产出 .wasm/.wat/.strings.json/.meta.json（不经 wamrc）");
    console.error("  --mem <MiB>: 线性内存上限（默认 40；in-module 形态由 libqzvm --initial-memory 决定）");
    console.error("  --debug: 生成 name 段（函数名）+ DWARF 调试段（.debug_*），wat/wasm 反汇编/lldb 源码调试用（不影响执行）");
    console.error("  --no-aot: glue 只加载 .wasm（纯 bytecode）——WAMR debug-interp 拒绝 AOT 实例，调试运行须此模式");
    console.error("  glue <prefix> [--main \"fn(a)\"] [--no-aot]");
    process.exit(2);
}
