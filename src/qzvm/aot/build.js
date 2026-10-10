#!/usr/bin/env node
/* build.js — AOT 编译流水线（JS 技术栈主入口）。
 * 子命令:
 *   build.js build <src.ts> [prefix] [--tagged i32]   # 一键：TS → wasm → wamrc AOT → glue.js
 *   build.js compile <src.ts> <prefix> [--tagged i32] # 仅编译：TS → <prefix>.wasm + .strings.json + .meta.json
 *   build.js glue <prefix>                            # 仅 glue：生成 <prefix>.glue.js（外部形态）
 *
 * 产物形态（分离，不内嵌 base64 防源码膨胀）：
 *   <prefix>.glue.js  +  <prefix>.wasm + <prefix>.aot
 * glue.js 运行时经 globalThis.qzjs.fs.readFileBinary 异步读同目录 .wasm/.aot。
 * qzjs 直接 `qzjs <prefix>.glue.js` 运行。__call(name, args) 按 funcMeta 自动转换
 * num(裸 i32) vs tagged(qz._fromJS/qz._toJS)。wamrc 是唯一外部编译后端（LLVM AOT，
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

function extractMakeQzvm(rep) {
    const file = rep === "i32" ? "qzvm.js" : "qzvm-f64.js";
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    const fname = rep === "i32" ? "makeQzvm" : "makeQzvmF64";
    const fnIdx = src.indexOf(`function ${fname}(strings) {`);
    const end = src.indexOf("\nmodule.exports");
    // 从 "use strict"; 起切，含 makeQzvm 依赖的模块级常量（如 qzvm-f64 的 TAG/buf）
    const start = src.indexOf('"use strict";');
    if (fnIdx < 0 || start < 0 || end < 0) throw new Error(file + ": 找不到 " + fname);
    return src.slice(start, end);
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
// --tagged i32 选回 32 位宿主位模型；默认 f64 NaN-box
function parseRep() {
    const i = process.argv.indexOf("--tagged");
    return i >= 0 && process.argv[i + 1] === "i32" ? "i32" : "f64";
}


function genGlue(prefix, mainCalls, rep) {
    const strings = JSON.parse(fs.readFileSync(prefix + ".strings.json", "utf8"));
    const metaRaw = JSON.parse(fs.readFileSync(prefix + ".meta.json", "utf8"));
    const meta = metaRaw.funcs;
    rep = rep || metaRaw.rep || "f64";
    const makeQzvm = extractMakeQzvm(rep);
    const ctor = rep === "i32" ? "makeQzvm" : "makeQzvmF64";
    const basename = path.basename(prefix);   // glue 读同目录外部文件（不内嵌）
    // 主逻辑体：--main 生成逐调用行；否则 __main 钩子（用户追加）
    const mainBody = (mainCalls && mainCalls.length)
        ? mainCalls.map(c => `console.log("${c.name}(${c.args.join(",")}) =", __call("${c.name}", [${c.args.join(",")}]));`).join("\n")
        : `if (typeof globalThis.__main === "function") globalThis.__main(__call, __ex);`;
    let glue = `${makeQzvm}
// ── 生成产物：${basename}（分离形态：本文件 + ${basename}.wasm + ${basename}.aot，同目录）──
const qz = ${ctor}(${JSON.stringify(strings)});
const __meta = ${JSON.stringify(meta)};
const __fs = globalThis.qzjs && globalThis.qzjs.fs;
Promise.all([
  __fs.readFileBinary("${basename}.wasm"),
  __fs.readFileBinary("${basename}.aot"),
]).then(([bytes, aot]) =>
  WebAssembly.instantiate(bytes, { qz }, { aot }).then(({ instance }) => {
    const __ex = instance.exports;
    // __call(name, args)：按 funcMeta 自动转换 num(裸) vs tagged(_fromJS/_toJS)
    const __call = (name, args) => {
      const m = __meta.find(f => f.name === name);
      if (!m) throw new Error("未知导出: " + name);
      const conv = m.mode === "num" ? args : args.map(a => qz._fromJS(a));
      const r = __ex[name](...conv);
      return m.mode === "num" ? r : qz._toJS(r);
    };
    // ── 主逻辑（--main）──
    ${mainBody}
  })
).catch(e => { console.error("AOT load failed:", e); });
`;
    fs.writeFileSync(prefix + ".glue.js", glue);
    console.log(`glue ok: ${prefix}.glue.js（分离形态: ${basename}.wasm + ${basename}.aot 由 fs.readFileBinary 读取）`);
}

const cmd = process.argv[2];
if (cmd === "build") {
    const src = process.argv[3];
    if (!src) { console.error("usage: build.js build <src.ts> [prefix]"); process.exit(2); }
    const nameArg = process.argv[4];
    const name = (nameArg && !nameArg.startsWith("--")) ? nameArg : path.basename(src).replace(/\.ts$/, "");
    const prefix = path.join(outDir(), name);
    const rep = parseRep();
    const wamrc = resolveWamrc();
    fs.mkdirSync(outDir(), { recursive: true });
    const r = compileTS(src, prefix + ".wasm", { tagged: rep });
    fs.writeFileSync(prefix + ".strings.json", JSON.stringify(r.strings));
    fs.writeFileSync(prefix + ".meta.json", JSON.stringify({ rep: r.rep, funcs: r.funcMeta }));
    console.log(`compile ok: ${prefix}.wasm (${fs.statSync(prefix + ".wasm").size} B) strings=${r.strings.length} funcs=${r.funcMeta.length}`);
    execSync(`"${wamrc}" -o "${prefix}.aot" "${prefix}.wasm"`, { stdio: "inherit" });
    console.log("✓ wamrc AOT");
    const mainIdx = process.argv.indexOf("--main");
    const mainCalls = mainIdx >= 0 ? parseMain(process.argv[mainIdx + 1]) : [];
    genGlue(prefix, mainCalls, r.rep);
    console.log(`== done: ${prefix}.glue.js（运行: qzjs ${prefix}.glue.js）`);
} else if (cmd === "compile") {
    const src = process.argv[3];
    const nameArg = process.argv[4];
    const name = (nameArg && !nameArg.startsWith("--")) ? nameArg : path.basename(src).replace(/\.ts$/, "");
    const prefix = path.join(outDir(), name);
    fs.mkdirSync(outDir(), { recursive: true });
    const r = compileTS(src, prefix + ".wasm", { tagged: parseRep() });
    fs.writeFileSync(prefix + ".strings.json", JSON.stringify(r.strings));
    fs.writeFileSync(prefix + ".meta.json", JSON.stringify({ rep: r.rep, funcs: r.funcMeta }));
    console.log(`compile ok: ${prefix}.wasm (${fs.statSync(prefix + ".wasm").size} B) strings=${r.strings.length} funcs=${r.funcMeta.length}`);
} else if (cmd === "glue") {
    const mainIdx = process.argv.indexOf("--main");
    const mainCalls = mainIdx >= 0 ? parseMain(process.argv[mainIdx + 1]) : [];
    genGlue(process.argv[3], mainCalls);
} else {
    console.error("usage: build.js build|compile|glue ...");
    process.exit(2);
}
