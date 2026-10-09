#!/usr/bin/env node
/* build.js — AOT 编译流水线（JS 技术栈主入口）。
 * 子命令:
 *   build.js build <src.ts> [prefix]    # 一键：TS → wasm → wamrc AOT → 分离 glue.js
 *   build.js compile <src.ts> <prefix>  # 仅编译：TS → <prefix>.wasm + .strings.json + .meta.json
 *   build.js glue <prefix>              # 仅 glue：生成 <prefix>.glue.js（外部分离形态）
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

const DEFAULT_WAMRC = "/home/gem/project/perry_wasm_demo/.deps/wamr/wamr-compiler/build/wamrc";
// 中间产物统一到工程 build/aot/（与 CMake build/ 一致），AOT_OUT_DIR 可覆盖
function outDir() {
    return process.env.AOT_OUT_DIR || path.join(__dirname, "..", "..", "..", "build", "aot");
}

function extractMakeQzvm() {
    const src = fs.readFileSync(path.join(__dirname, "qzvm.js"), "utf8");
    const start = src.indexOf("function makeQzvm(strings) {");
    const end = src.indexOf("\nmodule.exports");
    if (start < 0 || end < 0) throw new Error("qzvm.js: 找不到 makeQzvm");
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

function genGlue(prefix, mainCalls) {
    const strings = JSON.parse(fs.readFileSync(prefix + ".strings.json", "utf8"));
    const meta = JSON.parse(fs.readFileSync(prefix + ".meta.json", "utf8"));
    const makeQzvm = extractMakeQzvm();
    const basename = path.basename(prefix);   // glue 读同目录外部文件（不内嵌）
    // 主逻辑体：--main 生成逐调用行；否则 __main 钩子（用户追加）
    const mainBody = (mainCalls && mainCalls.length)
        ? mainCalls.map(c => `console.log("${c.name}(${c.args.join(",")}) =", __call("${c.name}", [${c.args.join(",")}]));`).join("\n")
        : `if (typeof globalThis.__main === "function") globalThis.__main(__call, __ex);`;
    let glue = `${makeQzvm}
// ── 生成产物：${basename}（分离形态：本文件 + ${basename}.wasm + ${basename}.aot，同目录）──
const qz = makeQzvm(${JSON.stringify(strings)});
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
    const wamrc = process.env.WAMRC || DEFAULT_WAMRC;
    fs.mkdirSync(outDir(), { recursive: true });
    const r = compileTS(src, prefix + ".wasm", {});
    fs.writeFileSync(prefix + ".strings.json", JSON.stringify(r.strings));
    fs.writeFileSync(prefix + ".meta.json", JSON.stringify(r.funcMeta));
    console.log(`compile ok: ${prefix}.wasm (${fs.statSync(prefix + ".wasm").size} B) strings=${r.strings.length} funcs=${r.funcMeta.length}`);
    execSync(`"${wamrc}" -o "${prefix}.aot" "${prefix}.wasm"`, { stdio: "inherit" });
    console.log("✓ wamrc AOT");
    const mainIdx = process.argv.indexOf("--main");
    const mainCalls = mainIdx >= 0 ? parseMain(process.argv[mainIdx + 1]) : [];
    genGlue(prefix, mainCalls);
    console.log(`== done: ${prefix}.glue.js（运行: qzjs ${prefix}.glue.js）`);
} else if (cmd === "compile") {
    const src = process.argv[3];
    const nameArg = process.argv[4];
    const name = (nameArg && !nameArg.startsWith("--")) ? nameArg : path.basename(src).replace(/\.ts$/, "");
    const prefix = path.join(outDir(), name);
    fs.mkdirSync(outDir(), { recursive: true });
    const r = compileTS(src, prefix + ".wasm", {});
    fs.writeFileSync(prefix + ".strings.json", JSON.stringify(r.strings));
    fs.writeFileSync(prefix + ".meta.json", JSON.stringify(r.funcMeta));
    console.log(`compile ok: ${prefix}.wasm (${fs.statSync(prefix + ".wasm").size} B) strings=${r.strings.length} funcs=${r.funcMeta.length}`);
} else if (cmd === "glue") {
    const mainIdx = process.argv.indexOf("--main");
    const mainCalls = mainIdx >= 0 ? parseMain(process.argv[mainIdx + 1]) : [];
    genGlue(process.argv[3], mainCalls);
} else {
    console.error("usage: build.js build|compile|glue ...");
    process.exit(2);
}
